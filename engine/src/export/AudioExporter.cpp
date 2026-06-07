#include "export/AudioExporter.h"

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "SampleBank.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "render/RenderScope.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
#include <libavutil/frame.h>
}

#include <algorithm>
#include <cstring>
#include <iostream>
#include <vector>

// ─── Helpers ─────────────────────────────────────────────────────────────────

namespace {

AVSampleFormat pickEncoderFormat(const AVCodec* codec, AVSampleFormat preferred)
{
    if (!codec || !codec->sample_fmts)
        return preferred;
    for (int i = 0; codec->sample_fmts[i] != AV_SAMPLE_FMT_NONE; ++i)
        if (codec->sample_fmts[i] == preferred)
            return preferred;
    // Preferred not supported — return first supported format
    return codec->sample_fmts[0];
}

// Pick a codec + sample format for the given export config.
struct CodecPick {
    AVCodecID        codecId;
    AVSampleFormat   preferredFmt;
    const char*      muxerName;
};

CodecPick pickCodec(const AudioExporter::Config& cfg)
{
    using Fmt = AudioExporter::Format;
    switch (cfg.format) {
        case Fmt::WAV: {
            if (cfg.bitDepth == 16)      return { AV_CODEC_ID_PCM_S16LE, AV_SAMPLE_FMT_S16, "wav" };
            else if (cfg.bitDepth == 24) return { AV_CODEC_ID_PCM_S24LE, AV_SAMPLE_FMT_S32, "wav" };
            else                         return { AV_CODEC_ID_PCM_F32LE, AV_SAMPLE_FMT_FLT, "wav" };
        }
        case Fmt::MP3:  return { AV_CODEC_ID_MP3,  AV_SAMPLE_FMT_FLTP, "mp3"  };
        case Fmt::FLAC: return { AV_CODEC_ID_FLAC, AV_SAMPLE_FMT_S16,  "flac" };
    }
    return { AV_CODEC_ID_PCM_S16LE, AV_SAMPLE_FMT_S16, "wav" };
}

} // namespace

AudioExporter::PrerollPlan AudioExporter::computePrerollPlan(
    int64_t startSample,
    int maxAudibleTrackLatencySamples,
    int masterInsertLatencySamples)
{
    // Legacy latency-only pre-roll: warm-up begins at the capture start.
    return computePrerollPlan(startSample, startSample,
                              maxAudibleTrackLatencySamples,
                              masterInsertLatencySamples);
}

AudioExporter::PrerollPlan AudioExporter::computePrerollPlan(
    int64_t warmUpStartSample,
    int64_t captureStartSample,
    int maxAudibleTrackLatencySamples,
    int masterInsertLatencySamples)
{
    // Shared warm-up + latency math (render/RenderScope.h). For a scoped
    // absolute render warmUpStartSample is 0, so renderStartSample becomes 0 and
    // the engine warms up from tick 0 — in-flight content survives.
    const auto shared = xleth::computeRenderPrerollPlan(
        warmUpStartSample, captureStartSample,
        maxAudibleTrackLatencySamples, masterInsertLatencySamples);

    PrerollPlan plan;
    plan.maxAudibleTrackLatencySamples = std::max(0, maxAudibleTrackLatencySamples);
    plan.masterInsertLatencySamples = std::max(0, masterInsertLatencySamples);
    plan.totalPrerollSamples     = shared.totalPrerollSamples;
    plan.renderStartSample       = shared.renderStartSample;
    plan.availablePrerollSamples = shared.availablePrerollSamples;
    plan.discardSamples          = shared.discardSamples;
    return plan;
}

AudioExporter::PrerollPlan AudioExporter::computePrerollPlan(
    MixEngine& mixer,
    int64_t startSample)
{
    return computePrerollPlan(mixer, startSample, startSample);
}

AudioExporter::PrerollPlan AudioExporter::computePrerollPlan(
    MixEngine& mixer,
    int64_t warmUpStartSample,
    int64_t captureStartSample)
{
    const auto latencySnapshot = mixer.getLatencyCompensationSnapshot();
    return computePrerollPlan(warmUpStartSample, captureStartSample,
                              latencySnapshot.maxAudibleTrackLatencySamples,
                              latencySnapshot.masterInsertLatencySamples);
}

// ─── Offline render pass ─────────────────────────────────────────────────────

bool AudioExporter::renderOffline(const Timeline& timeline,
                                   MixEngine& mixer,
                                   int64_t startSample,
                                   int64_t warmUpStartSample,
                                   int totalSamples,
                                   int sampleRate,
                                   const xleth::TailRenderPlan& tail,
                                   juce::AudioBuffer<float>& output,
                                   int& outRenderedSamples,
                                   std::function<void(float)> progressCallback,
                                   std::atomic<bool>& cancelFlag)
{
    // Phase 3B: wrap (seamless tail fold) is a distinct render path that produces
    // an output of EXACTLY the region length. Branch out before sizing the buffer
    // so the Phase 3A hardCut/tailClamp path below is byte-for-byte unchanged.
    if (tail.mode == xleth::TailRenderMode::Wrap) {
        return renderOfflineWrap(timeline, mixer, startSample, warmUpStartSample,
                                 totalSamples, sampleRate, tail, output,
                                 outRenderedSamples, progressCallback, cancelFlag);
    }

    const int64_t maxTail = (tail.mode == xleth::TailRenderMode::TailClamp)
                          ? std::max<int64_t>(0, tail.maxTailSamples) : 0;
    const int outputCapacity = totalSamples + static_cast<int>(maxTail);
    output.setSize(2, outputCapacity, false, true, false);
    output.clear();
    outRenderedSamples = 0;

    constexpr int kBlockSize = 4096;

    const auto prerollPlan = computePrerollPlan(mixer, warmUpStartSample, startSample);
    const int64_t renderStartSample = prerollPlan.renderStartSample;
    const int64_t samplesToDiscard = prerollPlan.discardSamples;
    const int64_t renderEndSample =
        renderStartSample + samplesToDiscard + static_cast<int64_t>(totalSamples);

    // tailClamp: no NEW notes/clips trigger at/after capture end (absolute
    // sample). Sustaining voices + insert effect tails are unaffected.
    const int64_t captureEndSample = startSample + static_cast<int64_t>(totalSamples);
    mixer.setNoteTriggerCeilingSample(captureEndSample);

    Transport transport;
    transport.setSampleRate(static_cast<double>(sampleRate));
    transport.setBPM(timeline.getBPM());
    transport.seekToSample(renderStartSample);
    transport.play();

    juce::AudioBuffer<float> block(2, kBlockSize);

    int64_t currentSample = renderStartSample;
    int64_t samplesRemainingToDiscard = samplesToDiscard;
    int pos = 0;
    int lastPct = -1;
    bool cancelled = false;
    while (currentSample < renderEndSample && pos < totalSamples) {
        if (cancelFlag.load(std::memory_order_relaxed)) { cancelled = true; break; }

        const int n = static_cast<int>(
            std::min<int64_t>(kBlockSize, renderEndSample - currentSample));
        if (block.getNumSamples() != n)
            block.setSize(2, n, false, false, true);
        block.clear();

        mixer.processBlock(block, n, transport);

        const int discardThisBlock = static_cast<int>(
            std::min<int64_t>(samplesRemainingToDiscard, n));
        samplesRemainingToDiscard -= discardThisBlock;

        const int keepOffset = discardThisBlock;
        int keepSamples = n - discardThisBlock;
        if (keepSamples > 0)
            keepSamples = std::min(keepSamples, totalSamples - pos);

        if (keepSamples > 0) {
            for (int ch = 0; ch < 2; ++ch)
                output.copyFrom(ch, pos, block, ch, keepOffset, keepSamples);
            pos += keepSamples;
        }

        transport.advance(n);
        currentSample += n;

        if (progressCallback) {
            const float p = (static_cast<float>(pos) / static_cast<float>(totalSamples)) * 0.7f;
            const int pct = static_cast<int>(p * 1000.0f); // ~0.1% resolution
            if (pct != lastPct) {
                progressCallback(p);
                lastPct = pct;
            }
        }
    }
    outRenderedSamples = pos;

    // ── Effect-tail capture (tailClamp) ──────────────────────────────────────
    // Continue past captureEnd with the trigger ceiling engaged: no new notes,
    // but the wet effect tail rings out. The control thread (here) reads the
    // master-bus peak — a thread-safe atomic written inside processBlock — so the
    // audio thread stays allocation/lock/log-free.
    xleth::TailDetectorState tailState;
    if (!cancelled && maxTail > 0) {
        int64_t tailPos = 0;
        while (!tailState.done && tailPos < maxTail) {
            if (cancelFlag.load(std::memory_order_relaxed)) { cancelled = true; break; }

            const int n = static_cast<int>(std::min<int64_t>(kBlockSize, maxTail - tailPos));
            if (block.getNumSamples() != n)
                block.setSize(2, n, false, false, true);
            block.clear();

            mixer.processBlock(block, n, transport);

            const double blockPeak = std::max(mixer.getMasterPeakL(),
                                              mixer.getMasterPeakR());

            for (int ch = 0; ch < 2; ++ch)
                output.copyFrom(ch, totalSamples + static_cast<int>(tailPos), block, ch, 0, n);

            tailPos += n;
            transport.advance(n);
            xleth::tailDetectorFeed(tailState, tail, blockPeak, n);
        }
        outRenderedSamples = totalSamples + static_cast<int>(tailPos);

#ifdef XLETH_DEBUG
        std::fprintf(stderr,
            "[RenderScope] audioTail mode=tailClamp threshLin=%.6f capSamples=%lld "
            "holdSamples=%lld detectedTailSamples=%lld endedBy=%s\n",
            tail.thresholdLinear, (long long)maxTail, (long long)tail.holdSamples,
            (long long)tailState.tailSamples,
            tailState.endedByCap ? "cap" : "threshold");
#endif
    }

    transport.pause();
    mixer.clearNoteTriggerCeiling();
    return !cancelled;
}

// ─── Wrap (seamless loop tail fold) render pass — Phase 3B ────────────────────
//
// SEMANTICS NOTE (LTI fold exactness): this follows the spec's structure exactly
// — Phase 2 warm-up, one DISCARDED region pre-roll that PRESERVES effect state to
// prime the loop seam, capture, then fold the post-end tail onto the head. Be
// aware that, for a purely linear time-invariant tail, priming the capture AND
// folding the outgoing tail both contribute the seam's overlap energy, so the
// folded region can over-emphasise the seam (≈2× in the overlap window) relative
// to a mathematically-exact circular convolution. A cold-effect capture (no
// priming) + fold would be LTI-exact, but the spec mandates the priming pre-roll
// and forbids resetting effect state across it. The UI copy already flags the
// fold as approximate; nonlinear effects (comp/limiter/distortion) diverge
// further. See the Phase 3B report for the full derivation.
bool AudioExporter::renderOfflineWrap(const Timeline& timeline,
                                       MixEngine& mixer,
                                       int64_t startSample,
                                       int64_t warmUpStartSample,
                                       int totalSamples,
                                       int sampleRate,
                                       const xleth::TailRenderPlan& tail,
                                       juce::AudioBuffer<float>& output,
                                       int& outRenderedSamples,
                                       std::function<void(float)> progressCallback,
                                       std::atomic<bool>& cancelFlag)
{
    // Final wrap output is EXACTLY the region length — the tail folds into the
    // head and never extends the file.
    const int regionLen = totalSamples;
    output.setSize(2, regionLen, false, true, false);
    output.clear();
    outRenderedSamples = 0;
    if (regionLen <= 0) return true;

    const int64_t endSample = startSample + static_cast<int64_t>(regionLen);
    const int64_t maxTail   = std::max<int64_t>(0, tail.maxTailSamples);

    constexpr int kBlockSize = 4096;
    juce::AudioBuffer<float> block(2, kBlockSize);

    Transport transport;
    transport.setSampleRate(static_cast<double>(sampleRate));
    transport.setBPM(timeline.getBPM());

    mixer.clearNoteTriggerCeiling();   // region pre-roll + capture trigger normally

    // ── PHASE A+B: absolute warm-up + one discarded region pre-roll ──────────
    // Process [warmUpRenderStart, endSample) CONTIGUOUSLY, discarding all output.
    // [warmUpRenderStart, startSample) is the Phase 2 absolute warm-up (recreates
    // in-flight content arriving at the region start). [startSample, endSample)
    // is the wrap pre-roll: a full region iteration whose sole purpose is to drive
    // delay/reverb (LTI) effect state into the condition it has AT THE LOOP SEAM,
    // so the captured region inherits a ringing tail instead of cold silence.
    // This pre-roll is separate from, and runs AFTER, the Phase 2 warm-up — no
    // seek occurs between them, so effect state accumulates across both.
    const auto warmPlan = computePrerollPlan(mixer, warmUpStartSample, startSample);
    const int64_t warmRenderStart = warmPlan.renderStartSample;
#ifdef XLETH_DEBUG
    std::fprintf(stderr,
        "[TailFold] warmUpStart=%lld preRollRegion=[%lld,%lld) preRollLen=%d "
        "regionLen=%d\n",
        (long long)warmRenderStart, (long long)startSample, (long long)endSample,
        regionLen, regionLen);
#endif
    transport.seekToSample(warmRenderStart);
    transport.play();

    int64_t cur = warmRenderStart;
    bool cancelled = false;
    while (cur < endSample) {
        if (cancelFlag.load(std::memory_order_relaxed)) { cancelled = true; break; }
        const int n = static_cast<int>(std::min<int64_t>(kBlockSize, endSample - cur));
        if (block.getNumSamples() != n) block.setSize(2, n, false, false, true);
        block.clear();
        mixer.processBlock(block, n, transport);   // output discarded (priming)
        transport.advance(n);
        cur += n;
    }

    // ── PHASE C (capture): seamless backward seek to the region start ────────
    // Latency-only pre-roll for the capture so PDC delay lines re-flush and the
    // first kept sample aligns with the audio AT startSample. The seamless seek
    // preserves the primed effect-processor (reverb/delay) state across the jump
    // while releasing held notes (the region re-triggers cleanly).
    if (!cancelled) {
        const auto capPlan = computePrerollPlan(mixer, startSample, startSample);
        const int64_t capRenderStart = capPlan.renderStartSample;
        int64_t capDiscard = capPlan.discardSamples;

        mixer.armSeamlessSeek();
        transport.seekToSample(capRenderStart);

        int pos = 0;
        int64_t curCap = capRenderStart;
        int lastPct = -1;
        while (curCap < endSample && pos < regionLen) {
            if (cancelFlag.load(std::memory_order_relaxed)) { cancelled = true; break; }
            const int n = static_cast<int>(std::min<int64_t>(kBlockSize, endSample - curCap));
            if (block.getNumSamples() != n) block.setSize(2, n, false, false, true);
            block.clear();
            mixer.processBlock(block, n, transport);

            const int discardThisBlock = static_cast<int>(std::min<int64_t>(capDiscard, n));
            capDiscard -= discardThisBlock;
            int keep = n - discardThisBlock;
            if (keep > 0) keep = std::min(keep, regionLen - pos);
            if (keep > 0) {
                for (int ch = 0; ch < 2; ++ch)
                    output.copyFrom(ch, pos, block, ch, discardThisBlock, keep);
                pos += keep;
            }
            transport.advance(n);
            curCap += n;

            if (progressCallback) {
                const float p = (static_cast<float>(pos) / static_cast<float>(regionLen)) * 0.6f;
                const int pct = static_cast<int>(p * 1000.0f);
                if (pct != lastPct) { progressCallback(p); lastPct = pct; }
            }
        }
        outRenderedSamples = pos;
    }

    // ── PHASE C (tail) + D (fold): render post-end tail, fold onto the head ──
    // No new notes/clips trigger past endSample (ceiling). The wet effect tail
    // rings out; we capture it into a working buffer until the master bus stays
    // below threshold for ~50 ms, or the cap is hit. The master-bus peak is read
    // here on the control thread — never the audio thread.
    xleth::TailDetectorState tailState;
    int64_t tailLen = 0;
    if (!cancelled && maxTail > 0) {
        juce::AudioBuffer<float> tailBuf(2, static_cast<int>(maxTail));
        tailBuf.clear();

        mixer.setNoteTriggerCeilingSample(endSample);   // gate new triggers in tail

        int64_t tailPos = 0;
        while (!tailState.done && tailPos < maxTail) {
            if (cancelFlag.load(std::memory_order_relaxed)) { cancelled = true; break; }
            const int n = static_cast<int>(std::min<int64_t>(kBlockSize, maxTail - tailPos));
            if (block.getNumSamples() != n) block.setSize(2, n, false, false, true);
            block.clear();
            mixer.processBlock(block, n, transport);

            const double blockPeak = std::max(mixer.getMasterPeakL(),
                                              mixer.getMasterPeakR());
            for (int ch = 0; ch < 2; ++ch)
                tailBuf.copyFrom(ch, static_cast<int>(tailPos), block, ch, 0, n);

            tailPos += n;
            transport.advance(n);
            xleth::tailDetectorFeed(tailState, tail, blockPeak, n);
        }
        tailLen = tailState.tailSamples;

        mixer.clearNoteTriggerCeiling();

        // ── D. Fold the tail onto the region head (output[i % regionLen]) ────
        const int foldLen = static_cast<int>(std::min<int64_t>(tailLen, maxTail));
        for (int ch = 0; ch < 2; ++ch)
            xleth::foldTailIntoRegion(output.getWritePointer(ch), regionLen,
                                      tailBuf.getReadPointer(ch), foldLen);

#ifdef XLETH_DEBUG
        std::fprintf(stderr,
            "[TailFold] capture=[%lld,%lld) regionLen=%d threshLin=%.6f capSamples=%lld "
            "detectedTail=%lld endedBy=%s foldedSamples=%d finalLen=%d videoExtended=no\n",
            (long long)startSample, (long long)endSample, regionLen,
            tail.thresholdLinear, (long long)maxTail, (long long)tailLen,
            tailState.endedByCap ? "cap" : "threshold", foldLen, regionLen);
#endif
    }

    if (progressCallback) progressCallback(0.7f);

    transport.pause();
    mixer.clearNoteTriggerCeiling();
    // Final wrap output is exactly the region length regardless of tail length.
    outRenderedSamples = regionLen;
    return !cancelled;
}

// ─── FFmpeg encoder ──────────────────────────────────────────────────────────

bool AudioExporter::encodeWithFFmpeg(const juce::AudioBuffer<float>& buf,
                                      const Config& cfg,
                                      std::function<void(float)> progressCallback,
                                      std::atomic<bool>& cancelFlag)
{
    AVFormatContext* fmtCtx        = nullptr;
    AVCodecContext*  codecCtx      = nullptr;
    AVStream*        stream        = nullptr;
    SwrContext*      swr           = nullptr;
    AVFrame*         frame         = nullptr;
    AVPacket*        pkt           = nullptr;
    bool             fileOpened    = false;
    bool             headerWritten = false;
    bool             trailerWritten = false;

    auto cleanup = [&]() {
        if (fmtCtx && headerWritten && !trailerWritten) {
            av_write_trailer(fmtCtx);
            trailerWritten = true;
        }
        if (frame)    av_frame_free(&frame);
        if (pkt)      av_packet_free(&pkt);
        if (swr)      swr_free(&swr);
        if (codecCtx) avcodec_free_context(&codecCtx);
        if (fmtCtx) {
            if (fileOpened && fmtCtx->pb)
                avio_closep(&fmtCtx->pb);
            avformat_free_context(fmtCtx);
        }
    };

    const CodecPick pick = pickCodec(cfg);

    // 1. Allocate output format context with explicit muxer
    if (avformat_alloc_output_context2(&fmtCtx, nullptr, pick.muxerName,
                                       cfg.outputPath.c_str()) < 0 || !fmtCtx) {
        std::cout << "[AudioExporter] avformat_alloc_output_context2 failed\n" << std::flush;
        cleanup();
        return false;
    }

    // 2. Find encoder
    const AVCodec* codec = avcodec_find_encoder(pick.codecId);
    if (!codec) {
        std::cout << "[AudioExporter] encoder not found for codec id "
                  << static_cast<int>(pick.codecId) << "\n" << std::flush;
        cleanup();
        return false;
    }

    // 3. New stream + codec context
    stream = avformat_new_stream(fmtCtx, codec);
    if (!stream) { cleanup(); return false; }

    codecCtx = avcodec_alloc_context3(codec);
    if (!codecCtx) { cleanup(); return false; }

    codecCtx->sample_fmt  = pickEncoderFormat(codec, pick.preferredFmt);
    codecCtx->sample_rate = cfg.sampleRate;
    av_channel_layout_default(&codecCtx->ch_layout, 2);

    if (cfg.format == Format::MP3) {
        codecCtx->bit_rate = static_cast<int64_t>(cfg.mp3Bitrate > 0 ? cfg.mp3Bitrate : 320) * 1000;
    } else if (cfg.format == Format::FLAC) {
        const int lvl = std::clamp(cfg.flacLevel, 0, 8);
        codecCtx->compression_level = lvl;
    }

    if (fmtCtx->oformat->flags & AVFMT_GLOBALHEADER)
        codecCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    stream->time_base = AVRational{ 1, codecCtx->sample_rate };

    // 4. Open codec
    if (avcodec_open2(codecCtx, codec, nullptr) < 0) {
        std::cout << "[AudioExporter] avcodec_open2 failed\n" << std::flush;
        cleanup();
        return false;
    }

    if (avcodec_parameters_from_context(stream->codecpar, codecCtx) < 0) {
        cleanup();
        return false;
    }

    // 5. Open file + write header
    if (!(fmtCtx->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&fmtCtx->pb, cfg.outputPath.c_str(), AVIO_FLAG_WRITE) < 0) {
            std::cout << "[AudioExporter] avio_open failed: "
                      << cfg.outputPath << "\n" << std::flush;
            cleanup();
            return false;
        }
        fileOpened = true;
    }
    if (avformat_write_header(fmtCtx, nullptr) < 0) {
        std::cout << "[AudioExporter] avformat_write_header failed\n" << std::flush;
        cleanup();
        return false;
    }
    headerWritten = true;

    // 6. Resampler: interleaved FLT stereo → codec's required sample format
    AVChannelLayout inLayout;
    av_channel_layout_default(&inLayout, 2);
    int swrRet = swr_alloc_set_opts2(&swr,
        &codecCtx->ch_layout, codecCtx->sample_fmt, codecCtx->sample_rate,
        &inLayout,            AV_SAMPLE_FMT_FLT,    cfg.sampleRate,
        0, nullptr);
    if (swrRet < 0 || swr_init(swr) < 0) {
        std::cout << "[AudioExporter] swr init failed\n" << std::flush;
        cleanup();
        return false;
    }

    // 7. Allocate encoding frame. PCM codecs set frame_size=0 — use a fixed
    // block size in that case.
    frame = av_frame_alloc();
    pkt   = av_packet_alloc();
    if (!frame || !pkt) { cleanup(); return false; }

    const int frameSize = codecCtx->frame_size > 0 ? codecCtx->frame_size : 4096;
    frame->nb_samples = frameSize;
    frame->format     = codecCtx->sample_fmt;
    av_channel_layout_copy(&frame->ch_layout, &codecCtx->ch_layout);
    frame->sample_rate = codecCtx->sample_rate;
    if (av_frame_get_buffer(frame, 0) < 0) {
        std::cout << "[AudioExporter] av_frame_get_buffer failed\n" << std::flush;
        cleanup();
        return false;
    }

    // 8. Feed samples in frameSize chunks.
    const int totalSamples = buf.getNumSamples();
    const float* chL = buf.getReadPointer(0);
    const float* chR = buf.getReadPointer(1);
    std::vector<float> interleaved(static_cast<size_t>(frameSize) * 2, 0.0f);

    int64_t pts      = 0;
    int     samplePos = 0;
    int     lastPct   = -1;

    auto drainPackets = [&]() -> bool {
        while (true) {
            int r = avcodec_receive_packet(codecCtx, pkt);
            if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return true;
            if (r < 0) return false;
            pkt->stream_index = stream->index;
            av_packet_rescale_ts(pkt, codecCtx->time_base, stream->time_base);
            if (av_interleaved_write_frame(fmtCtx, pkt) < 0) {
                av_packet_unref(pkt);
                return false;
            }
            av_packet_unref(pkt);
        }
    };

    while (samplePos < totalSamples) {
        if (cancelFlag.load(std::memory_order_relaxed)) { cleanup(); return false; }

        const int n = std::min(frameSize, totalSamples - samplePos);
        const int samplesInFrame = codecCtx->frame_size > 0 ? frameSize : n;
        for (int i = 0; i < samplesInFrame; ++i) {
            const bool hasInputSample = i < n;
            interleaved[i * 2] = hasInputSample ? chL[samplePos + i] : 0.0f;
            interleaved[i * 2 + 1] = hasInputSample ? chR[samplePos + i] : 0.0f;
        }

        if (av_frame_make_writable(frame) < 0) { cleanup(); return false; }
        frame->nb_samples = samplesInFrame;

        const uint8_t* inBuf[1] = { reinterpret_cast<const uint8_t*>(interleaved.data()) };
        if (swr_convert(swr, frame->data, samplesInFrame, inBuf, samplesInFrame) < 0) {
            cleanup();
            return false;
        }

        frame->pts = pts;
        pts += samplesInFrame;

        if (avcodec_send_frame(codecCtx, frame) < 0) { cleanup(); return false; }
        if (!drainPackets())                          { cleanup(); return false; }

        samplePos += n;

        if (progressCallback) {
            const float p = 0.7f + (static_cast<float>(samplePos) / static_cast<float>(totalSamples)) * 0.3f;
            const int pct = static_cast<int>(p * 1000.0f);
            if (pct != lastPct) {
                progressCallback(p);
                lastPct = pct;
            }
        }
    }

    // 9. Flush encoder
    if (avcodec_send_frame(codecCtx, nullptr) < 0) { cleanup(); return false; }
    if (!drainPackets())                            { cleanup(); return false; }

    if (av_write_trailer(fmtCtx) < 0) { cleanup(); return false; }
    trailerWritten = true;

    if (progressCallback) progressCallback(1.0f);

    cleanup();
    return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

bool AudioExporter::exportAudio(const Timeline& timeline,
                                 const SampleBank& /*bank*/,
                                 MixEngine& mixer,
                                 const Config& config,
                                 std::function<void(float)> progressCallback,
                                 std::atomic<bool>& cancelFlag)
{
    // 1. Compute beat range
    double startBeat = std::max(0.0, config.startBeat);
    double endBeat   = config.endBeat;
    if (endBeat <= startBeat) {
        // Auto: max clip end
        double maxEnd = 0.0;
        for (const Clip* c : timeline.getAllClips()) {
            if (!c) continue;
            const double e = (c->position + c->duration).toBeats();
            if (e > maxEnd) maxEnd = e;
        }
        endBeat = std::max(maxEnd, startBeat + 1.0);
    }

    const double bpm = timeline.getBPM();
    const int    sr  = config.sampleRate > 0 ? config.sampleRate : 44100;
    const double samplesPerBeat = static_cast<double>(sr) * 60.0 / bpm;
    const int64_t startSample = static_cast<int64_t>(startBeat * samplesPerBeat);
    const int64_t endSample   = static_cast<int64_t>(endBeat   * samplesPerBeat);
    const int totalSamples = static_cast<int>(endSample - startSample);

    if (totalSamples <= 0) {
        std::cout << "[AudioExporter] empty render range\n" << std::flush;
        return false;
    }

    // Phase 2 warm-up: warmUpStartBeat < 0 keeps the legacy latency-only
    // pre-roll (warm up at startSample); >= 0 (typically 0 for a scoped absolute
    // window) warms up from that earlier beat so in-flight content survives.
    int64_t warmUpStartSample = startSample;
    if (config.warmUpStartBeat >= 0.0) {
        warmUpStartSample = static_cast<int64_t>(config.warmUpStartBeat * samplesPerBeat);
        if (warmUpStartSample < 0)          warmUpStartSample = 0;
        if (warmUpStartSample > startSample) warmUpStartSample = startSample;
    }

    // 2. Offline render (+ effect-tail capture for tailClamp). The bridge built
    //    config.tail at this export sample rate, so its sample counts are valid.
    juce::AudioBuffer<float> rendered;
    int renderedSamples = 0;
    if (!renderOffline(timeline, mixer, startSample, warmUpStartSample, totalSamples, sr,
                       config.tail, rendered, renderedSamples,
                       progressCallback, cancelFlag)) {
        return false;
    }

    // Trim to the samples actually written (capture + detected tail) so the
    // encoder doesn't see the unused tail capacity as trailing silence.
    if (renderedSamples < rendered.getNumSamples())
        rendered.setSize(2, renderedSamples, /*keepExisting*/ true, false, true);

    // 3. Encode
    return encodeWithFFmpeg(rendered, config, progressCallback, cancelFlag);
}

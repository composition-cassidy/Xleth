#include "export/AudioExporter.h"

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "SampleBank.h"
#include "Transport.h"
#include "audio/MixEngine.h"

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
    PrerollPlan plan;
    plan.maxAudibleTrackLatencySamples = std::max(0, maxAudibleTrackLatencySamples);
    plan.masterInsertLatencySamples = std::max(0, masterInsertLatencySamples);
    plan.totalPrerollSamples =
        static_cast<int64_t>(plan.maxAudibleTrackLatencySamples)
        + static_cast<int64_t>(plan.masterInsertLatencySamples);
    plan.renderStartSample =
        std::max<int64_t>(0, startSample - plan.totalPrerollSamples);
    plan.availablePrerollSamples = startSample - plan.renderStartSample;
    plan.discardSamples =
        plan.availablePrerollSamples + plan.totalPrerollSamples;
    return plan;
}

AudioExporter::PrerollPlan AudioExporter::computePrerollPlan(
    MixEngine& mixer,
    int64_t startSample)
{
    const auto latencySnapshot = mixer.getLatencyCompensationSnapshot();
    return computePrerollPlan(startSample,
                              latencySnapshot.maxAudibleTrackLatencySamples,
                              latencySnapshot.masterInsertLatencySamples);
}

// ─── Offline render pass ─────────────────────────────────────────────────────

bool AudioExporter::renderOffline(const Timeline& timeline,
                                   MixEngine& mixer,
                                   int64_t startSample,
                                   int totalSamples,
                                   int sampleRate,
                                   juce::AudioBuffer<float>& output,
                                   std::function<void(float)> progressCallback,
                                   std::atomic<bool>& cancelFlag)
{
    output.setSize(2, totalSamples, false, true, false);
    output.clear();

    constexpr int kBlockSize = 4096;

    const auto prerollPlan = computePrerollPlan(mixer, startSample);
    const int64_t renderStartSample = prerollPlan.renderStartSample;
    const int64_t samplesToDiscard = prerollPlan.discardSamples;
    const int64_t renderEndSample =
        renderStartSample + samplesToDiscard + static_cast<int64_t>(totalSamples);

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
    while (currentSample < renderEndSample && pos < totalSamples) {
        if (cancelFlag.load(std::memory_order_relaxed))
            return false;

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
    transport.pause();
    return true;
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

    // 2. Offline render
    juce::AudioBuffer<float> rendered(2, totalSamples);
    if (!renderOffline(timeline, mixer, startSample, totalSamples, sr,
                       rendered, progressCallback, cancelFlag)) {
        return false;
    }

    // 3. Encode
    return encodeWithFFmpeg(rendered, config, progressCallback, cancelFlag);
}

#include "audio/SourcePlayer.h"

#include <chrono>
#include <cmath>
#include <iostream>
#include <thread>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
}

// ─────────────────────────────────────────────────────────────────────────────
SourcePlayer::SourcePlayer()  = default;

SourcePlayer::~SourcePlayer()
{
    unloadSource();
    // Whatever is left is still pinned after the bounded wait: a callback that
    // is stuck, or one that outlived this object. Leak it rather than free
    // memory a thread may be reading; "never freed while pinned" has no
    // exception, not even here.
    for (auto& stillPinned : retired_)
        (void) stillPinned.release();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN THREAD — blocks until decoding is complete
bool SourcePlayer::loadSource(const std::string& filePath, double engineSampleRate)
{
    if (isCurrentSource(filePath, engineSampleRate))
        return true;

    unloadSource();
    sampleRate_ = engineSampleRate;

    // ── 1. Open container ────────────────────────────────────────────────────
    AVFormatContext* fmtCtx = nullptr;
    if (avformat_open_input(&fmtCtx, filePath.c_str(), nullptr, nullptr) < 0)
    {
        std::cerr << "[SourcePlayer] Could not open: " << filePath << "\n";
        return false;
    }

    if (avformat_find_stream_info(fmtCtx, nullptr) < 0)
    {
        std::cerr << "[SourcePlayer] No stream info: " << filePath << "\n";
        avformat_close_input(&fmtCtx);
        return false;
    }

    // ── 2. Find best audio stream ────────────────────────────────────────────
    const AVCodec* codec = nullptr;
    int streamIdx = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO,
                                        -1, -1, &codec, 0);
    if (streamIdx < 0 || codec == nullptr)
    {
        std::cerr << "[SourcePlayer] No audio stream in: " << filePath << "\n";
        avformat_close_input(&fmtCtx);
        return false;
    }

    AVStream* stream = fmtCtx->streams[streamIdx];

    // ── 3. Decoder context ───────────────────────────────────────────────────
    AVCodecContext* decCtx = avcodec_alloc_context3(codec);
    if (!decCtx)
    {
        avformat_close_input(&fmtCtx);
        return false;
    }

    avcodec_parameters_to_context(decCtx, stream->codecpar);
    if (avcodec_open2(decCtx, codec, nullptr) < 0)
    {
        std::cerr << "[SourcePlayer] Could not open codec: " << codec->name << "\n";
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // ── 4. Resampler: source format → stereo float @ engineSampleRate ────────
    SwrContext* swr = nullptr;
    AVChannelLayout outLayout;
    av_channel_layout_default(&outLayout, 2);  // stereo

    int ret = swr_alloc_set_opts2(&swr,
        &outLayout,              AV_SAMPLE_FMT_FLT,  static_cast<int>(engineSampleRate),
        &decCtx->ch_layout,      decCtx->sample_fmt,  decCtx->sample_rate,
        0, nullptr);

    if (ret < 0 || swr_init(swr) < 0)
    {
        std::cerr << "[SourcePlayer] Could not init resampler\n";
        if (swr) swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // ── 5. Decode all audio frames ───────────────────────────────────────────
    // Estimate total samples for pre-allocation (may grow if estimate is off)
    double durationSec = 0.0;
    if (fmtCtx->duration != AV_NOPTS_VALUE)
        durationSec = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE;
    else if (stream->duration != AV_NOPTS_VALUE)
        durationSec = static_cast<double>(stream->duration) * av_q2d(stream->time_base);

    int64_t estSamples = static_cast<int64_t>(durationSec * engineSampleRate) + 8192;
    if (estSamples < 8192) estSamples = 8192;

    // Accumulate into std::vector first, then copy to juce::AudioBuffer
    std::vector<float> chL, chR;
    chL.reserve(static_cast<size_t>(estSamples));
    chR.reserve(static_cast<size_t>(estSamples));

    AVPacket* pkt   = av_packet_alloc();
    AVFrame*  frame = av_frame_alloc();

    while (av_read_frame(fmtCtx, pkt) >= 0)
    {
        if (pkt->stream_index == streamIdx)
        {
            ret = avcodec_send_packet(decCtx, pkt);
            while (ret >= 0)
            {
                ret = avcodec_receive_frame(decCtx, frame);
                if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
                if (ret < 0) break;

                // Resample this frame
                int outSamples = swr_get_out_samples(swr, frame->nb_samples);
                if (outSamples <= 0) continue;

                // Interleaved float buffer: [L0 R0 L1 R1 ...]
                // But we use planar output for easier separation.
                // Actually swr outputs in the format we asked: FLT = interleaved float.
                // Let's use planar float instead for easier channel separation.
                // Re-check: AV_SAMPLE_FMT_FLT is interleaved, FLTP is planar.
                // We asked for FLT (interleaved) above. Let's switch to FLTP.

                // Allocate temp buffer for resampled output
                uint8_t* outBuf[2] = { nullptr, nullptr };
                // For interleaved FLT, we only need outBuf[0]
                int outBufSize = av_samples_get_buffer_size(nullptr, 2, outSamples,
                                                            AV_SAMPLE_FMT_FLT, 0);
                outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));

                int converted = swr_convert(swr,
                    outBuf, outSamples,
                    const_cast<const uint8_t**>(frame->extended_data), frame->nb_samples);

                if (converted > 0)
                {
                    // Interleaved stereo float: [L0 R0 L1 R1 ...]
                    const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);
                    for (int i = 0; i < converted; ++i)
                    {
                        chL.push_back(interleaved[i * 2]);
                        chR.push_back(interleaved[i * 2 + 1]);
                    }
                }

                av_freep(&outBuf[0]);
            }
        }
        av_packet_unref(pkt);
    }

    // Flush decoder
    avcodec_send_packet(decCtx, nullptr);
    while (true)
    {
        ret = avcodec_receive_frame(decCtx, frame);
        if (ret == AVERROR_EOF || ret < 0) break;

        int outSamples = swr_get_out_samples(swr, frame->nb_samples);
        if (outSamples <= 0) continue;

        uint8_t* outBuf[2] = { nullptr, nullptr };
        int outBufSize = av_samples_get_buffer_size(nullptr, 2, outSamples,
                                                    AV_SAMPLE_FMT_FLT, 0);
        outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));

        int converted = swr_convert(swr,
            outBuf, outSamples,
            const_cast<const uint8_t**>(frame->extended_data), frame->nb_samples);

        if (converted > 0)
        {
            const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);
            for (int i = 0; i < converted; ++i)
            {
                chL.push_back(interleaved[i * 2]);
                chR.push_back(interleaved[i * 2 + 1]);
            }
        }

        av_freep(&outBuf[0]);
    }

    // Flush resampler (may have buffered samples)
    {
        int outSamples = swr_get_out_samples(swr, 0);
        if (outSamples > 0)
        {
            uint8_t* outBuf[2] = { nullptr, nullptr };
            int outBufSize = av_samples_get_buffer_size(nullptr, 2, outSamples,
                                                        AV_SAMPLE_FMT_FLT, 0);
            outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));

            int converted = swr_convert(swr, outBuf, outSamples, nullptr, 0);
            if (converted > 0)
            {
                const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);
                for (int i = 0; i < converted; ++i)
                {
                    chL.push_back(interleaved[i * 2]);
                    chR.push_back(interleaved[i * 2 + 1]);
                }
            }

            av_freep(&outBuf[0]);
        }
    }

    // ── 6. Clean up FFmpeg ───────────────────────────────────────────────────
    av_frame_free(&frame);
    av_packet_free(&pkt);
    swr_free(&swr);
    avcodec_free_context(&decCtx);
    avformat_close_input(&fmtCtx);

    if (chL.empty())
    {
        std::cerr << "[SourcePlayer] Decoded zero samples from: " << filePath << "\n";
        return false;
    }

    // ── 7. Copy to juce::AudioBuffer ─────────────────────────────────────────
    // Fill a fresh buffer off to the side; the callback only sees it once published.
    const int numSamples = static_cast<int>(chL.size());
    auto decoded = std::make_unique<Buffer>(2, numSamples);
    std::memcpy(decoded->getWritePointer(0), chL.data(),
                static_cast<size_t>(numSamples) * sizeof(float));
    std::memcpy(decoded->getWritePointer(1), chR.data(),
                static_cast<size_t>(numSamples) * sizeof(float));

    totalSamples_ = numSamples;
    duration_     = static_cast<double>(numSamples) / engineSampleRate;
    loadedFilePath_ = filePath;
    playPosition_.store(0, std::memory_order_relaxed);
    previewEndSample_.store(-1, std::memory_order_relaxed);
    playing_.store(false, std::memory_order_relaxed);
    decodedAudio_ = std::move(decoded);   // unloadSource() above already took the previous one
    // release is enough to PUBLISH: a callback that misses this store just
    // starts playing one block later. Only unpublishing needs seq_cst.
    current_.store(decodedAudio_.get(), std::memory_order_release);
    loaded_.store(true, std::memory_order_release);

    double sizeMB = (2.0 * numSamples * sizeof(float)) / (1024.0 * 1024.0);
    std::cout << "[SourcePlayer] Loaded: " << filePath
              << " " << duration_ << "s"
              << ", 2ch"
              << ", " << engineSampleRate << "Hz"
              << ", " << std::round(sizeMB * 10.0) / 10.0 << "MB"
              << "\n" << std::flush;

    return true;
}

bool SourcePlayer::isCurrentSource(const std::string& filePath, double engineSampleRate) const
{
    return loaded_.load(std::memory_order_acquire)
        && loadedFilePath_ == filePath
        && std::abs(sampleRate_ - engineSampleRate) < 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN THREAD — lightweight probe, no decoding.
bool SourcePlayer::probeAudio(const std::string& filePath, double& outDurationSec)
{
    outDurationSec = 0.0;

    AVFormatContext* fmtCtx = nullptr;
    if (avformat_open_input(&fmtCtx, filePath.c_str(), nullptr, nullptr) < 0)
        return false;

    if (avformat_find_stream_info(fmtCtx, nullptr) < 0)
    {
        avformat_close_input(&fmtCtx);
        return false;
    }

    const AVCodec* codec = nullptr;
    int streamIdx = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO,
                                        -1, -1, &codec, 0);
    if (streamIdx < 0)
    {
        avformat_close_input(&fmtCtx);
        return false;
    }

    if (fmtCtx->duration != AV_NOPTS_VALUE)
    {
        outDurationSec = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE;
    }
    else
    {
        AVStream* stream = fmtCtx->streams[streamIdx];
        if (stream->duration != AV_NOPTS_VALUE)
            outDurationSec = static_cast<double>(stream->duration) * av_q2d(stream->time_base);
    }

    avformat_close_input(&fmtCtx);
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SourcePlayer::reclaimRetired()
{
    // seq_cst, like every read of the pin from this side: see processBlock.
    const Buffer* const pinned = inUse_.load(std::memory_order_seq_cst);
    std::erase_if(retired_, [pinned](const std::unique_ptr<Buffer>& b) { return b.get() != pinned; });
    return retired_.empty();
}

void SourcePlayer::unloadSource()
{
    // Waiting on the callback from the callback would only ever time out, and
    // anything freed here would be freed on the audio thread.
    jassert(juce::Thread::getCurrentThreadId() != audioThreadId_.load(std::memory_order_relaxed));

    playing_.store(false, std::memory_order_release);
    loaded_.store(false, std::memory_order_release);

    // Unpublish, then retire the buffer instead of freeing it. From here no
    // block can pin it afresh (see processBlock for why), so the pin can only
    // move OFF it, and once it has, the buffer is safe to free for good.
    current_.store(nullptr, std::memory_order_seq_cst);
    Buffer* const mine = decodedAudio_.get();
    if (decodedAudio_)
        retired_.push_back(std::move(decodedAudio_));

    // The normal case: the callback lets go within the block it is mixing, in
    // microseconds, so yield first and only then sleep. Buffers a previous
    // unload had to park are swept up too, but only THIS call's buffer is
    // waited for, so a buffer that stays stuck costs one wait and one log line,
    // not one per call.
    if (mine != nullptr)
    {
        const auto start    = std::chrono::steady_clock::now();
        const auto deadline = start + std::chrono::milliseconds(kUnloadWaitMs);
        while (inUse_.load(std::memory_order_seq_cst) == mine)
        {
            const auto now = std::chrono::steady_clock::now();
            if (now >= deadline)
            {
                // Still pinned: the device stalled mid-block. Do NOT free it;
                // it stays on retired_ until a later load / unload finds the
                // pin gone. Logged here, on the calling thread, once.
                ++deferredFrees_;
                std::cerr << "[SourcePlayer] unload: the audio callback still holds the buffer after "
                          << kUnloadWaitMs << " ms; freeing it later\n";
                break;
            }
            if (now - start < std::chrono::milliseconds(2)) std::this_thread::yield();
            else std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
    reclaimRetired();

    playPosition_.store(0, std::memory_order_relaxed);
    previewEndSample_.store(-1, std::memory_order_relaxed);
    totalSamples_ = 0;
    duration_     = 0.0;
    loadedFilePath_.clear();
}

// ── Transport ────────────────────────────────────────────────────────────────

void SourcePlayer::play(double startTimeSeconds)
{
    if (!loaded_.load(std::memory_order_acquire)) return;
    int64_t pos = static_cast<int64_t>(startTimeSeconds * sampleRate_);
    pos = std::max<int64_t>(0, std::min(pos, totalSamples_));
    playPosition_.store(pos, std::memory_order_release);
    previewEndSample_.store(-1, std::memory_order_release);
    playing_.store(true, std::memory_order_release);
}

uint64_t SourcePlayer::playRegionPreview(double startTimeSeconds, double endTimeSeconds)
{
    if (!loaded_.load(std::memory_order_acquire)) return 0;

    int64_t start = static_cast<int64_t>(startTimeSeconds * sampleRate_);
    int64_t end   = static_cast<int64_t>(std::ceil(endTimeSeconds * sampleRate_));
    start = std::max<int64_t>(0, std::min(start, totalSamples_));
    end   = std::max<int64_t>(0, std::min(end, totalSamples_));
    if (end <= start) {
        playing_.store(false, std::memory_order_release);
        previewEndSample_.store(-1, std::memory_order_release);
        playPosition_.store(start, std::memory_order_release);
        return 0;
    }

    const uint64_t seq = previewSeq_.fetch_add(1, std::memory_order_acq_rel) + 1;
    playPosition_.store(start, std::memory_order_release);
    previewEndSample_.store(end, std::memory_order_release);
    playing_.store(true, std::memory_order_release);
    return seq;
}

void SourcePlayer::pause()
{
    playing_.store(false, std::memory_order_release);
}

void SourcePlayer::resume()
{
    if (!loaded_.load(std::memory_order_acquire)) return;
    playing_.store(true, std::memory_order_release);
}

void SourcePlayer::seek(double timeSeconds)
{
    if (!loaded_.load(std::memory_order_acquire)) return;
    int64_t pos = static_cast<int64_t>(timeSeconds * sampleRate_);
    pos = std::max<int64_t>(0, std::min(pos, totalSamples_));
    playPosition_.store(pos, std::memory_order_release);
    previewEndSample_.store(-1, std::memory_order_release);
}

void SourcePlayer::stop()
{
    playing_.store(false, std::memory_order_release);
    playPosition_.store(0, std::memory_order_relaxed);
    previewEndSample_.store(-1, std::memory_order_release);
}

// ── Queries ──────────────────────────────────────────────────────────────────

double SourcePlayer::getPosition() const
{
    if (sampleRate_ <= 0.0) return 0.0;
    return static_cast<double>(playPosition_.load(std::memory_order_acquire)) / sampleRate_;
}

double SourcePlayer::getDuration() const
{
    return duration_;
}

// ── Audio thread ─────────────────────────────────────────────────────────────
// No alloc, no lock, no I/O.

void SourcePlayer::processBlock(juce::AudioBuffer<float>& outputBuffer, int numSamples)
{
   #if JUCE_DEBUG
    audioThreadId_.store(juce::Thread::getCurrentThreadId(), std::memory_order_relaxed);
   #endif

    if (!playing_.load(std::memory_order_acquire))  return;

    // Pin the published buffer, then re-check it is still published: either
    // unloadSource sees the pin and waits, or we see its swap and retry.
    //
    // ORDERING. This is store-then-load on both sides (here: store the pin,
    // load current_; in unloadSource: store current_ = null, load the pin),
    // the one pattern acquire/release cannot make safe. With them, each store
    // may still be sitting in its core's store buffer when the other side's
    // load runs, so we could read the old current_ while unloadSource reads the
    // old (empty) pin, and it would free the buffer we are about to mix. That
    // reordering is real on x86 too. seq_cst on all four operations puts them
    // in one total order, in which at least one side sees the other's store:
    // either we see current_ changed and retry, or unloadSource sees the pin.
    // Keep the pin store and the re-check load seq_cst.
    Buffer* src = current_.load(std::memory_order_seq_cst);
    for (;;)
    {
        inUse_.store(src, std::memory_order_seq_cst);
        Buffer* const again = current_.load(std::memory_order_seq_cst);
        if (again == src) break;
        src = again;
    }
    if (src != nullptr)
        mixBlock(*src, outputBuffer, numSamples);
    // Clearing the pin only ever lets a waiter proceed, and being seen late is
    // harmless, so release is enough here.
    inUse_.store(nullptr, std::memory_order_release);
}

void SourcePlayer::mixBlock(const Buffer& src, juce::AudioBuffer<float>& outputBuffer, int numSamples)
{
    const int64_t totalSamples = src.getNumSamples();
    int64_t pos = playPosition_.load(std::memory_order_acquire);
    if (pos >= totalSamples)
    {
        playing_.store(false, std::memory_order_release);
        return;
    }

    const int64_t previewEnd = previewEndSample_.load(std::memory_order_acquire);
    const bool boundedPreview = previewEnd >= 0;
    const int64_t effectiveEnd = boundedPreview
        ? std::min<int64_t>(previewEnd, totalSamples)
        : totalSamples;
    if (pos >= effectiveEnd)
    {
        playPosition_.store(effectiveEnd, std::memory_order_release);
        previewEndSample_.store(-1, std::memory_order_release);
        playing_.store(false, std::memory_order_release);
        return;
    }

    const int outChannels = outputBuffer.getNumChannels();
    const int srcChannels = src.getNumChannels();  // always 2
    const int available   = static_cast<int>(std::min<int64_t>(numSamples,
                                                                effectiveEnd - pos));

    // Additive mix into the output buffer (other sources may already be mixed in)
    for (int ch = 0; ch < std::min(outChannels, srcChannels); ++ch)
    {
        const float* in  = src.getReadPointer(ch) + pos;
        float*       dst = outputBuffer.getWritePointer(ch);

        for (int i = 0; i < available; ++i)
            dst[i] += in[i];
    }

    // If source is stereo but output is mono, skip the extra channel (already mixed ch 0).
    // If output has more channels than source, the extra channels get silence (no add).

    int64_t newPos = pos + available;
    playPosition_.store(newPos, std::memory_order_release);

    // Stop at the bounded preview end or source end without overshooting.
    if (newPos >= effectiveEnd)
    {
        playPosition_.store(effectiveEnd, std::memory_order_release);
        previewEndSample_.store(-1, std::memory_order_release);
        playing_.store(false, std::memory_order_release);
    }
}

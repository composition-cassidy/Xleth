#include "SampleBank.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>
#include <iostream>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
}

// ─────────────────────────────────────────────────────────────────────────────
void SampleBank::ensureFormatsRegistered()
{
    if (!formatsRegistered_)
    {
        formatManager_.registerBasicFormats(); // WAV + AIFF
        formatsRegistered_ = true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::loadSample(const juce::File& file, double engineSampleRate)
{
    ensureFormatsRegistered();

    if (!file.existsAsFile())
    {
        std::cout << "[SampleBank] WARNING: file not found: "
                  << file.getFullPathName().toStdString() << "\n" << std::flush;
        return -1;
    }

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager_.createReaderFor(file));
    if (reader == nullptr)
    {
        std::cout << "[SampleBank] WARNING: unsupported format: "
                  << file.getFileName().toStdString() << "\n" << std::flush;
        return -1;
    }

    const int    srcChannels  = static_cast<int>(reader->numChannels);
    const int    srcSamples   = static_cast<int>(reader->lengthInSamples);
    const double srcRate      = reader->sampleRate;

    // ── Read raw data ─────────────────────────────────────────────────────────
    juce::AudioBuffer<float> rawBuf(srcChannels, srcSamples);
    reader->read(&rawBuf, 0, srcSamples, 0, true, true);
    reader.reset(); // close file handle immediately

    // ── Resample if needed ────────────────────────────────────────────────────
    juce::AudioBuffer<float> finalBuf;

    if (std::abs(srcRate - engineSampleRate) > 0.5)
    {
        const double speedRatio    = srcRate / engineSampleRate;
        const int    outSamples    = static_cast<int>(
            std::ceil(static_cast<double>(srcSamples) / speedRatio));

        finalBuf.setSize(srcChannels, outSamples, false, true, false);

        for (int ch = 0; ch < srcChannels; ++ch)
        {
            juce::LagrangeInterpolator interp;
            interp.reset();

            interp.process(speedRatio,
                           rawBuf.getReadPointer(ch),
                           finalBuf.getWritePointer(ch),
                           outSamples,
                           srcSamples,
                           0);
        }
    }
    else
    {
        finalBuf = std::move(rawBuf);
    }

    // ── 2ms fades to prevent clicks at sample boundaries ─────────────────────
    applyFades(finalBuf, engineSampleRate);

    // ── Store ─────────────────────────────────────────────────────────────────
    const double durationMs = (finalBuf.getNumSamples() / engineSampleRate) * 1000.0;

    SampleInfo info;
    info.name               = file.getFileNameWithoutExtension();
    info.numChannels        = finalBuf.getNumChannels();
    info.numSamples         = finalBuf.getNumSamples();
    info.originalSampleRate = srcRate;

    std::cout << "[SampleBank] Loaded  : " << info.name.toStdString()
              << "  ch="       << info.numChannels
              << "  dur="      << std::round(durationMs) << "ms"
              << "  srcRate="  << srcRate << "Hz";
    if (std::abs(srcRate - engineSampleRate) > 0.5)
        std::cout << " -> resampled to " << engineSampleRate << "Hz";
    std::cout << "\n" << std::flush;

    const int id = static_cast<int>(samples_.size());
    auto entry   = std::make_unique<LoadedSample>();
    entry->buffer = std::move(finalBuf);
    entry->info   = std::move(info);
    samples_.push_back(std::move(entry));
    return id;
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::loadSampleFromSource(const std::string& filePath,
                                     double startTimeSec,
                                     double endTimeSec,
                                     double engineSampleRate)
{
    if (startTimeSec >= endTimeSec || endTimeSec - startTimeSec < 0.001)
    {
        std::cout << "[SampleBank] WARNING: invalid time range "
                  << startTimeSec << "–" << endTimeSec << "s\n" << std::flush;
        return -1;
    }

    // ── 1. Open container ────────────────────────────────────────────────────
    AVFormatContext* fmtCtx = nullptr;
    if (avformat_open_input(&fmtCtx, filePath.c_str(), nullptr, nullptr) < 0)
    {
        std::cout << "[SampleBank] WARNING: could not open: " << filePath << "\n" << std::flush;
        return -1;
    }

    if (avformat_find_stream_info(fmtCtx, nullptr) < 0)
    {
        std::cout << "[SampleBank] WARNING: no stream info: " << filePath << "\n" << std::flush;
        avformat_close_input(&fmtCtx);
        return -1;
    }

    // ── 2. Find best audio stream ────────────────────────────────────────────
    const AVCodec* codec = nullptr;
    int streamIdx = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, &codec, 0);
    if (streamIdx < 0 || codec == nullptr)
    {
        std::cout << "[SampleBank] WARNING: no audio stream in: " << filePath << "\n" << std::flush;
        avformat_close_input(&fmtCtx);
        return -1;
    }

    AVStream* stream = fmtCtx->streams[streamIdx];

    // ── 3. Decoder context ───────────────────────────────────────────────────
    AVCodecContext* decCtx = avcodec_alloc_context3(codec);
    if (!decCtx)
    {
        avformat_close_input(&fmtCtx);
        return -1;
    }

    avcodec_parameters_to_context(decCtx, stream->codecpar);
    if (avcodec_open2(decCtx, codec, nullptr) < 0)
    {
        std::cout << "[SampleBank] WARNING: could not open codec\n" << std::flush;
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return -1;
    }

    // ── 4. Resampler: source format → stereo float @ engineSampleRate ────────
    SwrContext* swr = nullptr;
    AVChannelLayout outLayout;
    av_channel_layout_default(&outLayout, 2);

    int ret = swr_alloc_set_opts2(&swr,
        &outLayout,              AV_SAMPLE_FMT_FLT,  static_cast<int>(engineSampleRate),
        &decCtx->ch_layout,      decCtx->sample_fmt,  decCtx->sample_rate,
        0, nullptr);

    if (ret < 0 || swr_init(swr) < 0)
    {
        std::cout << "[SampleBank] WARNING: could not init resampler\n" << std::flush;
        if (swr) swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return -1;
    }

    // ── 5. Seek to start time ────────────────────────────────────────────────
    int64_t seekTarget = static_cast<int64_t>(startTimeSec * AV_TIME_BASE);
    av_seek_frame(fmtCtx, -1, seekTarget, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(decCtx);

    // ── 6. Decode audio in [startTimeSec, endTimeSec) ────────────────────────
    const double srcRate = static_cast<double>(decCtx->sample_rate);
    const double timeBase = av_q2d(stream->time_base);
    const int64_t startSampleOut = static_cast<int64_t>(startTimeSec * engineSampleRate);
    const int64_t endSampleOut   = static_cast<int64_t>(endTimeSec   * engineSampleRate);
    const int64_t expectedSamples = endSampleOut - startSampleOut;

    std::vector<float> chL, chR;
    chL.reserve(static_cast<size_t>(expectedSamples + 4096));
    chR.reserve(static_cast<size_t>(expectedSamples + 4096));

    AVPacket* pkt   = av_packet_alloc();
    AVFrame*  frame = av_frame_alloc();

    auto processFrame = [&](AVFrame* f) {
        // Compute frame time in seconds from pts
        double frameTimeSec = 0.0;
        if (f->pts != AV_NOPTS_VALUE)
            frameTimeSec = static_cast<double>(f->pts) * timeBase;

        // Skip frames before our start region (accounting for seek imprecision)
        double frameEndSec = frameTimeSec + static_cast<double>(f->nb_samples) / srcRate;
        if (frameEndSec < startTimeSec)
            return true;  // keep reading

        // Stop if we're past end time
        if (frameTimeSec >= endTimeSec)
            return false; // done

        int outSamples = swr_get_out_samples(swr, f->nb_samples);
        if (outSamples <= 0) return true;

        uint8_t* outBuf[2] = { nullptr, nullptr };
        int outBufSize = av_samples_get_buffer_size(nullptr, 2, outSamples, AV_SAMPLE_FMT_FLT, 0);
        outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));

        int converted = swr_convert(swr, outBuf, outSamples,
            const_cast<const uint8_t**>(f->extended_data), f->nb_samples);

        if (converted > 0)
        {
            const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);

            // Trim: only keep samples within [startTimeSec, endTimeSec)
            // For the first frame, we may need to skip leading samples
            int skipLeading = 0;
            if (frameTimeSec < startTimeSec)
            {
                double skipSec = startTimeSec - frameTimeSec;
                skipLeading = static_cast<int>(skipSec * engineSampleRate);
                if (skipLeading > converted) skipLeading = converted;
            }

            for (int i = skipLeading; i < converted; ++i)
            {
                if (static_cast<int64_t>(chL.size()) >= expectedSamples + 4096)
                    break;
                chL.push_back(interleaved[i * 2]);
                chR.push_back(interleaved[i * 2 + 1]);
            }
        }

        av_freep(&outBuf[0]);

        // Stop if we've collected enough samples
        return static_cast<int64_t>(chL.size()) < expectedSamples + 4096;
    };

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

                if (!processFrame(frame))
                    goto decode_done;
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
        if (!processFrame(frame))
            break;
    }

decode_done:
    // Flush resampler
    {
        int outSamples = swr_get_out_samples(swr, 0);
        if (outSamples > 0 && static_cast<int64_t>(chL.size()) < expectedSamples + 4096)
        {
            uint8_t* outBuf[2] = { nullptr, nullptr };
            int outBufSize = av_samples_get_buffer_size(nullptr, 2, outSamples, AV_SAMPLE_FMT_FLT, 0);
            outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));
            int converted = swr_convert(swr, outBuf, outSamples, nullptr, 0);
            if (converted > 0)
            {
                const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);
                for (int i = 0; i < converted && static_cast<int64_t>(chL.size()) < expectedSamples + 4096; ++i)
                {
                    chL.push_back(interleaved[i * 2]);
                    chR.push_back(interleaved[i * 2 + 1]);
                }
            }
            av_freep(&outBuf[0]);
        }
    }

    // ── 7. Clean up FFmpeg ───────────────────────────────────────────────────
    av_frame_free(&frame);
    av_packet_free(&pkt);
    swr_free(&swr);
    avcodec_free_context(&decCtx);
    avformat_close_input(&fmtCtx);

    if (chL.empty())
    {
        std::cout << "[SampleBank] WARNING: decoded zero samples from "
                  << filePath << " [" << startTimeSec << "–" << endTimeSec << "s]\n" << std::flush;
        return -1;
    }

    // Trim to expected length (don't keep more than the region duration)
    int numSamples = static_cast<int>(std::min(static_cast<int64_t>(chL.size()), expectedSamples));

    // ── 8. Copy to juce::AudioBuffer ─────────────────────────────────────────
    juce::AudioBuffer<float> finalBuf(2, numSamples);
    std::memcpy(finalBuf.getWritePointer(0), chL.data(),
                static_cast<size_t>(numSamples) * sizeof(float));
    std::memcpy(finalBuf.getWritePointer(1), chR.data(),
                static_cast<size_t>(numSamples) * sizeof(float));

    // ── 9. Apply 2ms fades ───────────────────────────────────────────────────
    applyFades(finalBuf, engineSampleRate);

    // ── 10. Store ────────────────────────────────────────────────────────────
    const double durationMs = (numSamples / engineSampleRate) * 1000.0;

    // Extract filename from path
    juce::String name = juce::File(juce::String(filePath)).getFileNameWithoutExtension();

    SampleInfo info;
    info.name               = name;
    info.numChannels        = 2;
    info.numSamples         = numSamples;
    info.originalSampleRate = engineSampleRate;  // already resampled

    std::cout << "[SampleBank] Loaded region: " << name.toStdString()
              << " [" << startTimeSec << "–" << endTimeSec << "s]"
              << "  dur=" << std::round(durationMs) << "ms"
              << "  samples=" << numSamples
              << "\n" << std::flush;

    const int id = static_cast<int>(samples_.size());
    auto entry   = std::make_unique<LoadedSample>();
    entry->buffer = std::move(finalBuf);
    entry->info   = std::move(info);
    samples_.push_back(std::move(entry));
    return id;
}

// ─────────────────────────────────────────────────────────────────────────────
const juce::AudioBuffer<float>* SampleBank::getSample(int sampleId) const
{
    if (sampleId < 0 || sampleId >= static_cast<int>(samples_.size()))
        return nullptr;
    if (samples_[sampleId] == nullptr)
        return nullptr;
    return &samples_[sampleId]->buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::getNumSamples() const
{
    return static_cast<int>(samples_.size());
}

// ─────────────────────────────────────────────────────────────────────────────
SampleBank::SampleInfo SampleBank::getSampleInfo(int sampleId) const
{
    if (sampleId < 0 || sampleId >= static_cast<int>(samples_.size()))
        return {};
    if (samples_[sampleId] == nullptr)
        return {};
    return samples_[sampleId]->info;
}

// ─────────────────────────────────────────────────────────────────────────────
int64_t SampleBank::getLeadingSilenceSamples(int sampleId, float thresholdDb) const
{
    if (sampleId < 0 || sampleId >= static_cast<int>(samples_.size()))
        return -1;
    if (samples_[sampleId] == nullptr)
        return -1;

    const juce::AudioBuffer<float>& buf = samples_[sampleId]->buffer;
    const int numSamples  = buf.getNumSamples();
    const int numChannels = buf.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0) return 0;

    // dB → linear. thresholdDb is expected to be negative (e.g., -54).
    const float threshold = std::pow(10.0f, thresholdDb / 20.0f);

    // Collect read pointers once to keep the inner loop tight.
    std::vector<const float*> chans(static_cast<size_t>(numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        chans[static_cast<size_t>(ch)] = buf.getReadPointer(ch);

    for (int i = 0; i < numSamples; ++i)
    {
        float peak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            const float v = std::abs(chans[static_cast<size_t>(ch)][i]);
            if (v > peak) peak = v;
        }
        if (peak >= threshold) return static_cast<int64_t>(i);
    }
    return static_cast<int64_t>(numSamples);
}

// ─────────────────────────────────────────────────────────────────────────────
void SampleBank::unloadSample(int id)
{
    if (id < 0 || id >= static_cast<int>(samples_.size()))
    {
#ifdef XLETH_DEBUG
        std::cout << "[SampleBank] unloadSample(id=" << id
                  << ") — out of range, no-op (size="
                  << samples_.size() << ")\n" << std::flush;
#endif
        return;
    }

    if (samples_[id] == nullptr)
    {
#ifdef XLETH_DEBUG
        std::cout << "[SampleBank] unloadSample(id=" << id
                  << ") — already tombstoned, no-op\n" << std::flush;
#endif
        return;
    }

    samples_[id].reset();

#ifdef XLETH_DEBUG
    std::cout << "[SampleBank] unloadSample(id=" << id
              << ") — buffer freed, slot tombstoned\n" << std::flush;
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
void SampleBank::applyFades(juce::AudioBuffer<float>& buf, double sampleRate)
{
    const int totalSamples = buf.getNumSamples();
    const int fadeSamples  = std::min(static_cast<int>(sampleRate * 0.002), // 2ms
                                      totalSamples / 2);
    if (fadeSamples <= 0) return;

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        float* data = buf.getWritePointer(ch);

        // Fade in: 0 → 1 over first fadeSamples
        for (int i = 0; i < fadeSamples; ++i)
            data[i] *= static_cast<float>(i) / static_cast<float>(fadeSamples);

        // Fade out: 1 → 0 over last fadeSamples
        for (int i = 0; i < fadeSamples; ++i)
            data[totalSamples - 1 - i] *= static_cast<float>(i) / static_cast<float>(fadeSamples);
    }
}

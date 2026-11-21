#include "SampleBank.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <exception>
#include <iostream>
#include <sstream>
#include <string>
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
    info.originalSampleRate = srcRate;          // source file rate
    info.bufferSampleRate   = engineSampleRate; // bake rate (samples resampled to this)

    std::cout << "[SampleBank] Loaded  : " << info.name.toStdString()
              << "  ch="       << info.numChannels
              << "  dur="      << std::round(durationMs) << "ms"
              << "  srcRate="  << srcRate << "Hz";
    if (std::abs(srcRate - engineSampleRate) > 0.5)
        std::cout << " -> resampled to " << engineSampleRate << "Hz";
    std::cout << "\n" << std::flush;

    auto entry   = std::make_unique<LoadedSample>();
    entry->buffer = std::move(finalBuf);
    entry->info   = std::move(info);
    return commitSample(std::move(entry));
}

// ─────────────────────────────────────────────────────────────────────────────
// The whole decode, and nothing else: reads no SampleBank state, so any number of
// these can run at once on different threads (each has its own FFmpeg contexts).
// What the sequential path would have printed is appended to `logOut` instead, so
// a batch can print it in request order rather than in whatever order threads finish.
std::unique_ptr<SampleBank::LoadedSample>
SampleBank::decodeFromSource(const std::string& filePath,
                             double startTimeSec,
                             double endTimeSec,
                             double engineSampleRate,
                             std::string& logOut,
                             bool toContainerEnd)
{
    std::ostringstream log;
    // Every exit hands its messages back; RAII so the many early returns cannot forget.
    struct LogFlush {
        std::ostringstream& src; std::string& dst;
        ~LogFlush() { dst += src.str(); }
    } logFlush { log, logOut };

    // With toContainerEnd the end is not known until the file is open; the
    // range is validated there instead.
    if (!toContainerEnd && (startTimeSec >= endTimeSec || endTimeSec - startTimeSec < 0.001))
    {
        log << "[SampleBank] WARNING: invalid time range "
                  << startTimeSec << "–" << endTimeSec << "s\n";
        return nullptr;
    }

    // ── 1. Open container ────────────────────────────────────────────────────
    AVFormatContext* fmtCtx = nullptr;
    if (avformat_open_input(&fmtCtx, filePath.c_str(), nullptr, nullptr) < 0)
    {
        log << "[SampleBank] WARNING: could not open: " << filePath << "\n";
        return nullptr;
    }

    if (avformat_find_stream_info(fmtCtx, nullptr) < 0)
    {
        log << "[SampleBank] WARNING: no stream info: " << filePath << "\n";
        avformat_close_input(&fmtCtx);
        return nullptr;
    }

    if (toContainerEnd)
    {
        // The container's own duration, or an hour when it reports none — the
        // exact end a caller gets from probing the file first and passing
        // `duration > 0 ? duration : 3600`.
        double containerSec = 0.0;
        if (fmtCtx->duration != AV_NOPTS_VALUE)
            containerSec = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE;
        endTimeSec = containerSec > 0.0 ? containerSec : 3600.0;
        if (startTimeSec >= endTimeSec || endTimeSec - startTimeSec < 0.001)
        {
            log << "[SampleBank] WARNING: invalid time range "
                << startTimeSec << "–" << endTimeSec << "s\n";
            avformat_close_input(&fmtCtx);
            return nullptr;
        }
    }

    // ── 2. Find best audio stream ────────────────────────────────────────────
    const AVCodec* codec = nullptr;
    int streamIdx = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, &codec, 0);
    if (streamIdx < 0 || codec == nullptr)
    {
        log << "[SampleBank] WARNING: no audio stream in: " << filePath << "\n";
        avformat_close_input(&fmtCtx);
        return nullptr;
    }

    AVStream* stream = fmtCtx->streams[streamIdx];

    // ── 3. Decoder context ───────────────────────────────────────────────────
    AVCodecContext* decCtx = avcodec_alloc_context3(codec);
    if (!decCtx)
    {
        avformat_close_input(&fmtCtx);
        return nullptr;
    }

    avcodec_parameters_to_context(decCtx, stream->codecpar);
    if (avcodec_open2(decCtx, codec, nullptr) < 0)
    {
        log << "[SampleBank] WARNING: could not open codec\n";
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return nullptr;
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
        log << "[SampleBank] WARNING: could not init resampler\n";
        if (swr) swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return nullptr;
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

    // Reserve what the file can actually deliver, not what was asked for. Swapped
    // audio is requested as [0, 3600 s) ("whole file, stop at EOF"); reserving that
    // literally is 1.2 GB of commit charge per decode, and several decodes now run
    // at once. Only the reservation changes: the vectors still grow as needed, and
    // every limit below is still expectedSamples.
    int64_t reserveSamples = expectedSamples + 4096;
    {
        int64_t deliverable = static_cast<int64_t>(60.0 * engineSampleRate);   // unknown length: start small
        if (fmtCtx->duration != AV_NOPTS_VALUE && fmtCtx->duration > 0)
        {
            const double remainSec = static_cast<double>(fmtCtx->duration) / AV_TIME_BASE - startTimeSec;
            deliverable = static_cast<int64_t>(std::max(remainSec, 0.0) * engineSampleRate) + 8192;
        }
        reserveSamples = std::max<int64_t>(4096, std::min(reserveSamples, deliverable));
    }
    std::vector<float> chL, chR;
    chL.reserve(static_cast<size_t>(reserveSamples));
    chR.reserve(static_cast<size_t>(reserveSamples));

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
        log << "[SampleBank] WARNING: decoded zero samples from "
                  << filePath << " [" << startTimeSec << "–" << endTimeSec << "s]\n";
        return nullptr;
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
    info.originalSampleRate = engineSampleRate;  // decoded/resampled to engine rate
    info.bufferSampleRate   = engineSampleRate;  // bake rate == stored-sample rate

    log << "[SampleBank] Loaded region: " << name.toStdString()
              << " [" << startTimeSec << "–" << endTimeSec << "s]"
              << "  dur=" << std::round(durationMs) << "ms"
              << "  samples=" << numSamples
              << "\n";

    auto entry   = std::make_unique<LoadedSample>();
    entry->buffer = std::move(finalBuf);
    entry->info   = std::move(info);
    return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::commitSample(std::unique_ptr<LoadedSample> entry)
{
    Table next = *table_.load();
    const int id = nextId_++;
    next.slots.push_back({ id, std::move(entry) });   // ids only grow: stays sorted
    publish(std::move(next));
    return id;
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::loadSampleFromSource(const std::string& filePath,
                                     double startTimeSec,
                                     double endTimeSec,
                                     double engineSampleRate)
{
    std::string log;
    auto entry = decodeFromSource(filePath, startTimeSec, endTimeSec, engineSampleRate, log);
    if (!log.empty()) std::cout << log << std::flush;
    if (!entry) return -1;
    return commitSample(std::move(entry));
}

// ─────────────────────────────────────────────────────────────────────────────
// Project load used to decode one region after another on the message thread: a
// 76-region project spent 1.8 s here, each region re-opening the same source
// file. The decodes are independent, so they run on a small pool; only the
// commit (the id assignment) stays ordered and on the calling thread.
std::vector<int> SampleBank::loadSamplesFromSources(const std::vector<SourceRequest>& requests,
                                                    double engineSampleRate,
                                                    bool logEachSuccess,
                                                    int maxThreads)
{
    const int n = static_cast<int>(requests.size());
    std::vector<int> ids(static_cast<size_t>(n), -1);
    if (n == 0) return ids;

    std::vector<std::unique_ptr<LoadedSample>> decoded(static_cast<size_t>(n));
    std::vector<std::string> logs(static_cast<size_t>(n));

    auto decodeOne = [&](int i)
    {
        const auto& r = requests[static_cast<size_t>(i)];
        try
        {
            decoded[static_cast<size_t>(i)] = decodeFromSource(
                r.filePath, r.startTimeSec, r.endTimeSec,
                r.sampleRate > 0.0 ? r.sampleRate : engineSampleRate,
                logs[static_cast<size_t>(i)], r.toContainerEnd);
        }
        catch (const std::exception& e)
        {
            // A worker thread must not let this escape (std::terminate). The
            // request fails like any other undecodable file.
            decoded[static_cast<size_t>(i)].reset();
            logs[static_cast<size_t>(i)] += std::string("[SampleBank] WARNING: decode of ") + r.filePath
                                          + " failed: " + e.what() + "\n";
        }
    };

    int threads = maxThreads;
    if (threads <= 0)
    {
        // Leave a core for the audio callback, which is already running.
        const int hw = static_cast<int>(std::thread::hardware_concurrency());
        threads = std::clamp(hw - 1, 1, 12);
    }
    threads = std::min(threads, n);

    if (threads <= 1)
    {
        for (int i = 0; i < n; ++i) decodeOne(i);
    }
    else
    {
        std::atomic<int> next { 0 };
        auto worker = [&] { for (int i; (i = next.fetch_add(1, std::memory_order_relaxed)) < n; ) decodeOne(i); };
        std::vector<std::thread> pool;
        pool.reserve(static_cast<size_t>(threads - 1));
        for (int t = 1; t < threads; ++t) pool.emplace_back(worker);
        worker();   // the calling thread works too
        for (auto& th : pool) th.join();
    }

    // Commit in request order: ids come out exactly as if loadSampleFromSource
    // had been called for each request in turn (a failed request takes no id).
    // One publish for the whole batch.
    std::string out;
    Table next = *table_.load();
    for (int i = 0; i < n; ++i)
    {
        auto& entry = decoded[static_cast<size_t>(i)];
        if (!entry || logEachSuccess) out += logs[static_cast<size_t>(i)];
        if (!entry) continue;
        ids[static_cast<size_t>(i)] = nextId_;
        next.slots.push_back({ nextId_++, std::move(entry) });
    }
    publish(std::move(next));
    if (!out.empty()) std::cout << out << std::flush;
    return ids;
}


// ─────────────────────────────────────────────────────────────────────────────
const SampleBank::Table::Slot* SampleBank::Table::find(int id) const noexcept
{
    const auto it = std::lower_bound(slots.begin(), slots.end(), id,
                                     [](const Slot& s, int v) { return s.id < v; });
    return (it != slots.end() && it->id == id) ? &*it : nullptr;
}

const juce::AudioBuffer<float>* SampleBank::Table::getSample(int id) const noexcept
{
    const Slot* s = find(id);
    return s != nullptr ? &s->sample->buffer : nullptr;
}

double SampleBank::Table::getSampleBufferRate(int id) const noexcept
{
    const Slot* s = find(id);
    return s != nullptr ? s->sample->info.bufferSampleRate : 0.0;
}

// The pointer outlives the temporary pin: the published table still owns it,
// and only this (the main) thread can publish one without it.
const SampleBank::LoadedSample* SampleBank::current(int id) const
{
    const Table::Slot* s = table_.load()->find(id);
    return s != nullptr ? s->sample.get() : nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
const juce::AudioBuffer<float>* SampleBank::getSample(int sampleId) const
{
    const LoadedSample* s = current(sampleId);
    return s != nullptr ? &s->buffer : nullptr;
}

std::shared_ptr<const juce::AudioBuffer<float>> SampleBank::getSampleShared(int sampleId) const
{
    const Table::Slot* s = table_.load()->find(sampleId);
    if (s == nullptr) return nullptr;
    return { s->sample, &s->sample->buffer };   // aliasing: owns the whole sample
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::getNumSamples() const
{
    return static_cast<int>(table_.load()->slots.size());
}

std::vector<int> SampleBank::liveIds() const
{
    const Pin table = table_.load();
    std::vector<int> ids;
    ids.reserve(table->slots.size());
    for (const auto& s : table->slots) ids.push_back(s.id);
    return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
SampleBank::SampleInfo SampleBank::getSampleInfo(int sampleId) const
{
    const LoadedSample* s = current(sampleId);
    return s != nullptr ? s->info : SampleInfo{};
}

// ─────────────────────────────────────────────────────────────────────────────
double SampleBank::getSampleBufferRate(int sampleId) const noexcept
{
    return table_.load()->getSampleBufferRate(sampleId);
}

// ─────────────────────────────────────────────────────────────────────────────
int64_t SampleBank::countEdgeSilence(int sampleId, float thresholdDb,
                                     int64_t startSample, int64_t length, bool fromEnd) const
{
    const LoadedSample* s = current(sampleId);
    if (s == nullptr)
        return -1;

    const juce::AudioBuffer<float>& buf = s->buffer;
    const int64_t numSamples  = buf.getNumSamples();
    const int     numChannels = buf.getNumChannels();
    if (numSamples <= 0 || numChannels <= 0) return 0;

    // Clamp the window to the buffer.
    const int64_t first = std::clamp<int64_t>(startSample, 0, numSamples);
    const int64_t last  = (length >= numSamples - first) ? numSamples
                                                         : std::max<int64_t>(first, first + length);
    if (last <= first) return 0;

    // dB → linear. thresholdDb is expected to be negative (e.g., -54).
    const float threshold = std::pow(10.0f, thresholdDb / 20.0f);

    // Collect read pointers once to keep the inner loop tight.
    std::vector<const float*> chans(static_cast<size_t>(numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        chans[static_cast<size_t>(ch)] = buf.getReadPointer(ch);

    auto loud = [&](int64_t i) {
        for (int ch = 0; ch < numChannels; ++ch)
            if (std::abs(chans[static_cast<size_t>(ch)][i]) >= threshold) return true;
        return false;
    };

    if (fromEnd) {
        for (int64_t i = last - 1; i >= first; --i)
            if (loud(i)) return (last - 1) - i;
    } else {
        for (int64_t i = first; i < last; ++i)
            if (loud(i)) return i - first;
    }
    return last - first;
}

// ─────────────────────────────────────────────────────────────────────────────
void SampleBank::unloadSample(int id)
{
    unloadSamples({ id });
}

void SampleBank::unloadSamples(const std::vector<int>& ids)
{
    std::vector<int> drop = ids;
    std::sort(drop.begin(), drop.end());

    const Pin cur = table_.load();
    Table next;
    next.slots.reserve(cur->slots.size());
    for (const auto& s : cur->slots)
        if (!std::binary_search(drop.begin(), drop.end(), s.id)) next.slots.push_back(s);
    const size_t dropped = cur->slots.size() - next.slots.size();
    // Nothing to drop (never handed out, or already unloaded): no publish.
    if (dropped > 0) publish(std::move(next));

#ifdef XLETH_DEBUG
    std::cout << "[SampleBank] unloadSamples: " << dropped
              << " of " << ids.size() << " id(s) unloaded\n" << std::flush;
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
juce::String SampleBank::uniqueSampleName(const juce::String& baseName) const
{
    const juce::String base = baseName.isNotEmpty() ? baseName : "Baked Sample";

    const Pin table = table_.load();
    auto nameTaken = [&table](const juce::String& candidate)
    {
        for (const auto& s : table->slots)
            if (s.sample->info.name == candidate) return true;
        return false;
    };

    if (!nameTaken(base)) return base;
    for (int n = 2; n < 100000; ++n)
    {
        const juce::String candidate = base + " (" + juce::String(n) + ")";
        if (!nameTaken(candidate)) return candidate;
    }
    // Astronomically unreachable in practice — fall back to something unique.
    return base + " (" + juce::String(nextId_) + ")";
}

// ─────────────────────────────────────────────────────────────────────────────
int SampleBank::addSampleFromBuffer(const juce::AudioBuffer<float>& buffer,
                                    double sampleRate,
                                    const juce::String& baseName)
{
    if (buffer.getNumChannels() <= 0 || buffer.getNumSamples() <= 0 || sampleRate <= 0.0)
        return -1;

    SampleInfo info;
    info.name               = uniqueSampleName(baseName);
    info.numChannels        = buffer.getNumChannels();
    info.numSamples         = buffer.getNumSamples();
    info.originalSampleRate = sampleRate;
    info.bufferSampleRate   = sampleRate;

    auto entry    = std::make_unique<LoadedSample>();
    entry->buffer = buffer;   // copy — caller's buffer is untouched
    entry->info   = std::move(info);

    std::cout << "[SampleBank] Registered baked asset: " << entry->info.name.toStdString()
              << "  ch=" << entry->info.numChannels
              << "  samples=" << entry->info.numSamples
              << "  rate=" << sampleRate << "Hz\n" << std::flush;

    return commitSample(std::move(entry));
}

// ─────────────────────────────────────────────────────────────────────────────
bool SampleBank::restoreSample(int id, const juce::AudioBuffer<float>& buffer, const SampleInfo& info)
{
    if (id < 0 || id >= nextId_) return false;
    Table next = *table_.load();
    const auto at = std::lower_bound(next.slots.begin(), next.slots.end(), id,
                                     [](const Table::Slot& s, int v) { return s.id < v; });
    if (at != next.slots.end() && at->id == id) return false;   // still live — not a replace primitive

    auto entry    = std::make_unique<LoadedSample>();
    entry->buffer = buffer;
    entry->info   = info;
    next.slots.insert(at, { id, std::move(entry) });
    publish(std::move(next));
    return true;
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

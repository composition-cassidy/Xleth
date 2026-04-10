#include "WaveformMipmap.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <thread>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
}

// ── Debug logging (gated behind XLETH_DEBUG) ─────────────────────────────────
#ifdef XLETH_DEBUG
#include <chrono>
namespace {
void wfmLog(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[WaveformMipmap] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
    fflush(stderr);
}
} // anon
#define WFM_LOG(...) wfmLog(__VA_ARGS__)
#else
#define WFM_LOG(...) ((void)0)
#endif

// ── FNV-1a 64-bit hash helpers ──────────────────────────────────────────────
namespace {

constexpr uint64_t kFnvOffset = 14695981039346656037ULL;
constexpr uint64_t kFnvPrime  = 1099511628211ULL;

uint64_t fnv1a(const uint8_t* data, size_t len, uint64_t h = kFnvOffset)
{
    for (size_t i = 0; i < len; ++i) {
        h ^= data[i];
        h *= kFnvPrime;
    }
    return h;
}

uint64_t fnv1aMixU64(uint64_t value, uint64_t h)
{
    uint8_t bytes[8];
    std::memcpy(bytes, &value, 8);
    return fnv1a(bytes, 8, h);
}

} // anon


// ── FFmpeg fallback: decode audio from video containers ─────────────────────
// Used when JUCE AudioFormatManager can't read the file (MP4, MKV, MOV, etc.).
// Preserves source sample rate and channel count — only converts sample format
// to float.  Pattern follows SampleBank::loadSampleFromSource() (SampleBank.cpp).
namespace {

bool decodeAudioWithFFmpeg(const std::string& filePath,
                           juce::AudioBuffer<float>& outBuffer,
                           int& outSampleRate,
                           int& outNumChannels)
{
    // ── 1. Open container ───────────────────────────────────────────────────
    AVFormatContext* fmtCtx = nullptr;
    if (avformat_open_input(&fmtCtx, filePath.c_str(), nullptr, nullptr) < 0) {
        WFM_LOG("FFmpeg: cannot open %s", filePath.c_str());
        return false;
    }

    if (avformat_find_stream_info(fmtCtx, nullptr) < 0) {
        WFM_LOG("FFmpeg: no stream info in %s", filePath.c_str());
        avformat_close_input(&fmtCtx);
        return false;
    }

    // ── 2. Find best audio stream ───────────────────────────────────────────
    const AVCodec* codec = nullptr;
    int streamIdx = av_find_best_stream(fmtCtx, AVMEDIA_TYPE_AUDIO, -1, -1, &codec, 0);
    if (streamIdx < 0 || codec == nullptr) {
        WFM_LOG("FFmpeg: no audio stream in %s", filePath.c_str());
        avformat_close_input(&fmtCtx);
        return false;
    }

    AVStream* stream = fmtCtx->streams[streamIdx];

    // ── 3. Decoder context ──────────────────────────────────────────────────
    AVCodecContext* decCtx = avcodec_alloc_context3(codec);
    if (!decCtx) {
        avformat_close_input(&fmtCtx);
        return false;
    }

    avcodec_parameters_to_context(decCtx, stream->codecpar);
    if (avcodec_open2(decCtx, codec, nullptr) < 0) {
        WFM_LOG("FFmpeg: cannot open codec for %s", filePath.c_str());
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    const int numCh = decCtx->ch_layout.nb_channels;
    const int srcRate = decCtx->sample_rate;
    if (numCh <= 0 || srcRate <= 0) {
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // ── 4. Resampler: source format → float, preserve rate & channels ───────
    SwrContext* swr = nullptr;
    AVChannelLayout outLayout;
    av_channel_layout_copy(&outLayout, &decCtx->ch_layout);

    int ret = swr_alloc_set_opts2(&swr,
        &outLayout,              AV_SAMPLE_FMT_FLT,  srcRate,   // output
        &decCtx->ch_layout,      decCtx->sample_fmt,  srcRate,   // input
        0, nullptr);

    if (ret < 0 || swr_init(swr) < 0) {
        WFM_LOG("FFmpeg: resampler init failed for %s", filePath.c_str());
        if (swr) swr_free(&swr);
        av_channel_layout_uninit(&outLayout);
        avcodec_free_context(&decCtx);
        avformat_close_input(&fmtCtx);
        return false;
    }

    // ── 5. Decode entire file ───────────────────────────────────────────────
    // Estimate total samples for reservation
    int64_t estSamples = 0;
    if (fmtCtx->duration > 0)
        estSamples = static_cast<int64_t>(
            (static_cast<double>(fmtCtx->duration) / AV_TIME_BASE) * srcRate);

    std::vector<std::vector<float>> channels(static_cast<size_t>(numCh));
    for (auto& ch : channels)
        ch.reserve(estSamples > 0 ? static_cast<size_t>(estSamples + 4096) : 1048576);

    AVPacket* pkt   = av_packet_alloc();
    AVFrame*  frame = av_frame_alloc();

    auto processFrame = [&](AVFrame* f) {
        int outSamples = swr_get_out_samples(swr, f->nb_samples);
        if (outSamples <= 0) return;

        uint8_t* outBuf[1] = { nullptr };
        int outBufSize = av_samples_get_buffer_size(
            nullptr, numCh, outSamples, AV_SAMPLE_FMT_FLT, 0);
        outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));

        int converted = swr_convert(swr, outBuf, outSamples,
            const_cast<const uint8_t**>(f->extended_data), f->nb_samples);

        if (converted > 0) {
            const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);
            for (int i = 0; i < converted; ++i) {
                for (int c = 0; c < numCh; ++c) {
                    channels[static_cast<size_t>(c)].push_back(
                        interleaved[i * numCh + c]);
                }
            }
        }

        av_freep(&outBuf[0]);
    };

    while (av_read_frame(fmtCtx, pkt) >= 0) {
        if (pkt->stream_index == streamIdx) {
            ret = avcodec_send_packet(decCtx, pkt);
            while (ret >= 0) {
                ret = avcodec_receive_frame(decCtx, frame);
                if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
                if (ret < 0) break;
                processFrame(frame);
            }
        }
        av_packet_unref(pkt);
    }

    // Flush decoder
    avcodec_send_packet(decCtx, nullptr);
    while (true) {
        ret = avcodec_receive_frame(decCtx, frame);
        if (ret == AVERROR_EOF || ret < 0) break;
        processFrame(frame);
    }

    // Flush resampler
    {
        int outSamples = swr_get_out_samples(swr, 0);
        if (outSamples > 0) {
            uint8_t* outBuf[1] = { nullptr };
            int outBufSize = av_samples_get_buffer_size(
                nullptr, numCh, outSamples, AV_SAMPLE_FMT_FLT, 0);
            outBuf[0] = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(outBufSize)));
            int converted = swr_convert(swr, outBuf, outSamples, nullptr, 0);
            if (converted > 0) {
                const float* interleaved = reinterpret_cast<const float*>(outBuf[0]);
                for (int i = 0; i < converted; ++i) {
                    for (int c = 0; c < numCh; ++c) {
                        channels[static_cast<size_t>(c)].push_back(
                            interleaved[i * numCh + c]);
                    }
                }
            }
            av_freep(&outBuf[0]);
        }
    }

    // ── 6. Clean up FFmpeg ──────────────────────────────────────────────────
    av_frame_free(&frame);
    av_packet_free(&pkt);
    swr_free(&swr);
    av_channel_layout_uninit(&outLayout);
    avcodec_free_context(&decCtx);
    avformat_close_input(&fmtCtx);

    // ── 7. Copy to juce::AudioBuffer ────────────────────────────────────────
    if (channels[0].empty()) {
        WFM_LOG("FFmpeg: decoded zero samples from %s", filePath.c_str());
        return false;
    }

    const int numSamples = static_cast<int>(channels[0].size());
    outBuffer.setSize(numCh, numSamples);
    for (int c = 0; c < numCh; ++c) {
        std::memcpy(outBuffer.getWritePointer(c),
                    channels[static_cast<size_t>(c)].data(),
                    static_cast<size_t>(numSamples) * sizeof(float));
    }
    outSampleRate  = srcRate;
    outNumChannels = numCh;

    WFM_LOG("FFmpeg decoded: %d ch, %d samples, %d Hz from %s",
            numCh, numSamples, srcRate, filePath.c_str());
    return true;
}

} // anon


// ══════════════════════════════════════════════════════════════════════════════
//  WaveformMipmap
// ══════════════════════════════════════════════════════════════════════════════

// ── computeSourceHash ───────────────────────────────────────────────────────
uint64_t WaveformMipmap::computeSourceHash(const juce::File& sourceFile)
{
    if (!sourceFile.existsAsFile()) return 0;

    juce::FileInputStream stream(sourceFile);
    if (!stream.openedOk()) return 0;

    // Hash first 64 KB of the file
    uint8_t buf[65536];
    int bytesRead = stream.read(buf, static_cast<int>(sizeof(buf)));
    uint64_t h = fnv1a(buf, static_cast<size_t>(std::max(0, bytesRead)));

    // Mix in file size
    h = fnv1aMixU64(static_cast<uint64_t>(sourceFile.getSize()), h);

    // Mix in last-modified time (milliseconds since epoch)
    h = fnv1aMixU64(
        static_cast<uint64_t>(sourceFile.getLastModificationTime().toMilliseconds()), h);

    return h;
}

// ── computeLevel ────────────────────────────────────────────────────────────
void WaveformMipmap::computeLevel(const juce::AudioBuffer<float>& buffer, int levelIdx)
{
    auto& lv = levels_[levelIdx];
    lv.samplesPerPoint = kReductionFactors[levelIdx];
    lv.numPoints = static_cast<int>(
        (totalSamples_ + lv.samplesPerPoint - 1) / lv.samplesPerPoint);

    const size_t dataSize =
        static_cast<size_t>(numChannels_) * lv.numPoints * kValuesPerPoint;
    lv.data.resize(dataSize, 0.0f);

    for (int ch = 0; ch < numChannels_; ++ch) {
        const float* raw = buffer.getReadPointer(ch);
        const int chOff = ch * lv.numPoints * kValuesPerPoint;

        for (int p = 0; p < lv.numPoints; ++p) {
            const int64_t wStart = static_cast<int64_t>(p) * lv.samplesPerPoint;
            const int64_t wEnd   = std::min(wStart + lv.samplesPerPoint, totalSamples_);
            const int wSize = static_cast<int>(wEnd - wStart);
            if (wSize <= 0) continue;

            float mn = raw[wStart];
            float mx = raw[wStart];
            double sq = 0.0;

            for (int64_t s = wStart; s < wEnd; ++s) {
                const float v = raw[s];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
                sq += static_cast<double>(v) * v;
            }

            const int idx = chOff + p * kValuesPerPoint;
            lv.data[idx]     = mn;
            lv.data[idx + 1] = mx;
            lv.data[idx + 2] = static_cast<float>(std::sqrt(sq / wSize));
        }
    }
}

// ── selectLevel ─────────────────────────────────────────────────────────────
int WaveformMipmap::selectLevel(double samplesPerPixel) const
{
    // Pick the finest level whose samplesPerPoint ≤ samplesPerPixel.
    // Levels are sorted ascending [4, 16, 64, 256, 1024, 4096].
    int best = 0;
    for (int i = 0; i < kNumLevels; ++i) {
        if (static_cast<double>(kReductionFactors[i]) <= samplesPerPixel)
            best = i;
        else
            break;
    }
    return best;
}

// ── generate (mode 1: in-memory buffer) ─────────────────────────────────────
bool WaveformMipmap::generate(const juce::AudioBuffer<float>& buffer, int sampleRate)
{
    const int ns = buffer.getNumSamples();
    const int nc = buffer.getNumChannels();
    if (ns == 0 || nc == 0) return false;

#ifdef XLETH_DEBUG
    auto t0 = std::chrono::steady_clock::now();
    WFM_LOG("generate start: %d ch, %d samples, %d Hz", nc, ns, sampleRate);
#endif

    numChannels_  = nc;
    sampleRate_   = sampleRate;
    totalSamples_ = ns;
    sourceBuffer_ = &buffer;

    for (int i = 0; i < kNumLevels; ++i)
        computeLevel(buffer, i);

    ready_.store(true, std::memory_order_release);

#ifdef XLETH_DEBUG
    auto t1 = std::chrono::steady_clock::now();
    WFM_LOG("generate complete: %.1f ms",
            std::chrono::duration<double, std::milli>(t1 - t0).count());
#endif
    return true;
}

// ── generateFromFile (mode 2: audio file on disk) ───────────────────────────
bool WaveformMipmap::generateFromFile(const juce::File& audioFile)
{
    generationFailed_.store(false, std::memory_order_release);

    if (!audioFile.existsAsFile()) {
        generationFailed_.store(true, std::memory_order_release);
        return false;
    }

#ifdef XLETH_DEBUG
    WFM_LOG("generateFromFile start: %s", audioFile.getFileName().toRawUTF8());
    auto t0 = std::chrono::steady_clock::now();
#endif

    juce::AudioBuffer<float> buf;
    int sr = 0;

    // ── Try JUCE AudioFormatManager first (WAV/AIFF/FLAC/OGG/MP3) ────────
    juce::AudioFormatManager fmtMgr;
    fmtMgr.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(fmtMgr.createReaderFor(audioFile));
    if (reader) {
        const int nc = static_cast<int>(reader->numChannels);
        const int ns = static_cast<int>(reader->lengthInSamples);
        sr = static_cast<int>(reader->sampleRate);
        if (ns == 0 || nc == 0) {
            generationFailed_.store(true, std::memory_order_release);
            return false;
        }
        buf.setSize(nc, ns);
        reader->read(&buf, 0, ns, 0, true, true);
        reader.reset(); // close file handle
    } else {
        // ── FFmpeg fallback (MP4/MKV/MOV/WebM/AVI etc.) ──────────────────
        WFM_LOG("generateFromFile: JUCE unsupported, trying FFmpeg: %s",
                audioFile.getFileName().toRawUTF8());

        int nc = 0;
        if (!decodeAudioWithFFmpeg(audioFile.getFullPathName().toStdString(),
                                   buf, sr, nc)) {
            WFM_LOG("generateFromFile: FFmpeg also failed: %s",
                    audioFile.getFileName().toRawUTF8());
            generationFailed_.store(true, std::memory_order_release);
            return false;
        }
    }

    // ── Delegate to generate() — single codepath for mipmap computation ──
    if (!generate(buf, sr)) {
        generationFailed_.store(true, std::memory_order_release);
        return false;
    }

    // generate() sets sourceBuffer_ = &buf, but buf is stack-local and will
    // be destroyed — null the pointer to prevent dangling access.
    sourceBuffer_ = nullptr;
    sourceHash_   = computeSourceHash(audioFile);

#ifdef XLETH_DEBUG
    auto t1 = std::chrono::steady_clock::now();
    WFM_LOG("generateFromFile complete: %s — %.1f ms",
            audioFile.getFileName().toRawUTF8(),
            std::chrono::duration<double, std::milli>(t1 - t0).count());
#endif
    return true;
}


// ══════════════════════════════════════════════════════════════════════════════
//  .xlpeak file I/O
//
//  Binary, little-endian (native on Windows x64).
//
//  Header (40 bytes):
//    magic        4   "XLPK"
//    version      2   uint16  (1)
//    numChannels  2   uint16
//    sampleRate   4   uint32
//    totalSamples 8   uint64
//    sourceHash   8   uint64
//    numLevels    2   uint16
//    reserved    10   zeros
//
//  Per-level descriptor (12 bytes × numLevels):
//    samplesPerPoint  4  uint32
//    numPoints        4  uint32
//    dataOffset       4  uint32  (byte offset from file start)
//
//  Level data: float32 arrays (min,max,rms triples × numPoints × numChannels)
// ══════════════════════════════════════════════════════════════════════════════

static constexpr int kHeaderSize = 40;
static constexpr int kLevelDescSize = 12;

bool WaveformMipmap::saveToFile(const juce::File& peakFile) const
{
    if (!ready_.load(std::memory_order_acquire)) return false;

    peakFile.deleteFile();
    juce::FileOutputStream out(peakFile);
    if (!out.openedOk()) {
        WFM_LOG("saveToFile: cannot open %s", peakFile.getFullPathName().toRawUTF8());
        return false;
    }
    out.setPosition(0);
    out.truncate();

    // ── Header (40 bytes) ────────────────────────────────────────────────
    out.write("XLPK", 4);

    uint16_t version = 1;
    out.write(&version, 2);

    uint16_t nc = static_cast<uint16_t>(numChannels_);
    out.write(&nc, 2);

    uint32_t sr = static_cast<uint32_t>(sampleRate_);
    out.write(&sr, 4);

    uint64_t ts = static_cast<uint64_t>(totalSamples_);
    out.write(&ts, 8);

    out.write(&sourceHash_, 8);

    uint16_t nl = static_cast<uint16_t>(kNumLevels);
    out.write(&nl, 2);

    uint8_t reserved[10] = {};
    out.write(reserved, 10);

    // ── Level descriptors (12 bytes each) ─────────────────────────────────
    uint32_t dataOff = static_cast<uint32_t>(kHeaderSize + kNumLevels * kLevelDescSize);
    for (int i = 0; i < kNumLevels; ++i) {
        uint32_t spp = static_cast<uint32_t>(levels_[i].samplesPerPoint);
        uint32_t np  = static_cast<uint32_t>(levels_[i].numPoints);
        out.write(&spp, 4);
        out.write(&np, 4);
        out.write(&dataOff, 4);
        dataOff += static_cast<uint32_t>(levels_[i].data.size() * sizeof(float));
    }

    // ── Level data ───────────────────────────────────────────────────────
    for (int i = 0; i < kNumLevels; ++i) {
        if (!levels_[i].data.empty()) {
            out.write(levels_[i].data.data(),
                      levels_[i].data.size() * sizeof(float));
        }
    }

    bool ok = out.getStatus().wasOk();
    WFM_LOG("saveToFile: %s — %s (%lld bytes)",
            peakFile.getFileName().toRawUTF8(),
            ok ? "OK" : "FAILED",
            (long long)peakFile.getSize());
    return ok;
}

bool WaveformMipmap::loadFromFile(const juce::File& peakFile, uint64_t expectedHash)
{
    juce::FileInputStream in(peakFile);
    if (!in.openedOk()) return false;

    // ── Header ───────────────────────────────────────────────────────────
    char magic[4];
    if (in.read(magic, 4) != 4 || std::memcmp(magic, "XLPK", 4) != 0) return false;

    uint16_t version;
    if (in.read(&version, 2) != 2 || version != 1) return false;

    uint16_t nc;  in.read(&nc, 2);
    uint32_t sr;  in.read(&sr, 4);
    uint64_t ts;  in.read(&ts, 8);
    uint64_t hash; in.read(&hash, 8);

    if (hash != expectedHash) {
        WFM_LOG("loadFromFile: hash mismatch — regenerating");
        return false;
    }

    uint16_t nl;  in.read(&nl, 2);
    if (nl != kNumLevels) return false;

    // Skip reserved
    in.setPosition(kHeaderSize);

    if (nc == 0 || ts == 0) return false;

    numChannels_  = nc;
    sampleRate_   = static_cast<int>(sr);
    totalSamples_ = static_cast<int64_t>(ts);
    sourceHash_   = hash;

    // ── Level descriptors ────────────────────────────────────────────────
    struct Desc { uint32_t spp, np, off; };
    Desc descs[kNumLevels];
    for (int i = 0; i < kNumLevels; ++i) {
        in.read(&descs[i].spp, 4);
        in.read(&descs[i].np, 4);
        in.read(&descs[i].off, 4);
    }

    // ── Level data ───────────────────────────────────────────────────────
    const int64_t fileSize = peakFile.getSize();

    for (int i = 0; i < kNumLevels; ++i) {
        levels_[i].samplesPerPoint = static_cast<int>(descs[i].spp);
        levels_[i].numPoints       = static_cast<int>(descs[i].np);

        const size_t count =
            static_cast<size_t>(numChannels_) * levels_[i].numPoints * kValuesPerPoint;
        const size_t byteCount = count * sizeof(float);

        // Basic bounds check to reject corrupt files
        if (static_cast<int64_t>(descs[i].off + byteCount) > fileSize) {
            WFM_LOG("loadFromFile: data overflow at level %d — corrupt file", i);
            return false;
        }

        levels_[i].data.resize(count);
        in.setPosition(static_cast<int64_t>(descs[i].off));
        in.read(levels_[i].data.data(), static_cast<int>(byteCount));
    }

    ready_.store(true, std::memory_order_release);

    WFM_LOG("loadFromFile: %s — %d ch, %lld samples",
            peakFile.getFileName().toRawUTF8(), numChannels_, (long long)totalSamples_);
    return true;
}


// ══════════════════════════════════════════════════════════════════════════════
//  Queries
// ══════════════════════════════════════════════════════════════════════════════

int WaveformMipmap::getPeaks(int channel, int64_t startSample, int64_t endSample,
                              int targetPixels, float* outBuffer, int outBufferSize,
                              bool& needsRawSamples) const
{
    needsRawSamples = false;
    if (!ready_.load(std::memory_order_acquire)) return 0;
    if (channel < 0 || channel >= numChannels_) return 0;
    if (startSample >= endSample || targetPixels <= 0) return 0;

    startSample = std::max(startSample, int64_t(0));
    endSample   = std::min(endSample, totalSamples_);
    if (startSample >= endSample) return 0;

    const double spp = static_cast<double>(endSample - startSample) / targetPixels;

    if (spp < static_cast<double>(kReductionFactors[0]))
        needsRawSamples = true;

    const int li = selectLevel(spp);
    const auto& lv = levels_[li];
    const int maxCols = outBufferSize / kValuesPerPoint;
    const int numCols = std::min(targetPixels, maxCols);
    const int chOff = channel * lv.numPoints * kValuesPerPoint;

    for (int col = 0; col < numCols; ++col) {
        const double colStartD = startSample + col * spp;
        const double colEndD   = startSample + (col + 1) * spp;

        int ptStart = static_cast<int>(colStartD / lv.samplesPerPoint);
        int ptEnd   = static_cast<int>(std::ceil(colEndD / lv.samplesPerPoint));
        ptStart = std::max(0, std::min(ptStart, lv.numPoints));
        ptEnd   = std::max(ptStart, std::min(ptEnd, lv.numPoints));

        if (ptStart >= ptEnd) {
            outBuffer[col * 3]     = 0.0f;
            outBuffer[col * 3 + 1] = 0.0f;
            outBuffer[col * 3 + 2] = 0.0f;
            continue;
        }

        const int i0 = chOff + ptStart * kValuesPerPoint;
        float cMin = lv.data[i0];
        float cMax = lv.data[i0 + 1];
        double wRmsSq = 0.0;
        int64_t wTotal = 0;

        for (int pt = ptStart; pt < ptEnd; ++pt) {
            const int idx = chOff + pt * kValuesPerPoint;
            if (lv.data[idx]     < cMin) cMin = lv.data[idx];
            if (lv.data[idx + 1] > cMax) cMax = lv.data[idx + 1];

            // Weight RMS by actual sample count in this point
            const int64_t pStart = static_cast<int64_t>(pt) * lv.samplesPerPoint;
            const int64_t pEnd   = std::min(pStart + lv.samplesPerPoint, totalSamples_);
            const int w = static_cast<int>(pEnd - pStart);
            wRmsSq += static_cast<double>(lv.data[idx + 2]) * lv.data[idx + 2] * w;
            wTotal += w;
        }

        outBuffer[col * 3]     = cMin;
        outBuffer[col * 3 + 1] = cMax;
        outBuffer[col * 3 + 2] = wTotal > 0
            ? static_cast<float>(std::sqrt(wRmsSq / wTotal))
            : 0.0f;
    }

    return numCols;
}

int WaveformMipmap::getRawSamples(int channel, int64_t startSample, int64_t endSample,
                                   float* outBuffer, int outBufferSize) const
{
    if (!sourceBuffer_ || !ready_.load(std::memory_order_acquire)) return 0;
    if (channel < 0 || channel >= numChannels_) return 0;

    startSample = std::max(startSample, int64_t(0));
    endSample   = std::min(endSample, totalSamples_);
    if (startSample >= endSample) return 0;

    const int count = std::min(static_cast<int>(endSample - startSample), outBufferSize);
    const float* src = sourceBuffer_->getReadPointer(channel);
    std::memcpy(outBuffer, src + startSample,
                static_cast<size_t>(count) * sizeof(float));
    return count;
}


// ══════════════════════════════════════════════════════════════════════════════
//  WaveformMipmapCache
// ══════════════════════════════════════════════════════════════════════════════

WaveformMipmap* WaveformMipmapCache::get(const std::string& key) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = cache_.find(key);
    if (it == cache_.end()) return nullptr;
    if (!it->second->isReady()) return nullptr;
    return it->second.get();
}

void WaveformMipmapCache::generateFromBuffer(
    const std::string& key,
    const juce::AudioBuffer<float>* buffer,
    int sampleRate,
    const juce::File& sourceFile,
    bool saveXlpeak)
{
    if (!buffer || buffer->getNumSamples() == 0) return;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (cache_.count(key)) return; // already exists or being generated
        cache_[key] = std::make_unique<WaveformMipmap>();
    }

    WaveformMipmap* mm;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        mm = cache_[key].get();
    }

    // Capture by value for the background thread.
    // `buffer` is a raw pointer to a stable SampleBank allocation.
    juce::File srcCopy = sourceFile;

    std::thread([mm, buffer, sampleRate, srcCopy, saveXlpeak]() {
        // Try loading existing .xlpeak first (skip for time-slice loads)
        if (saveXlpeak && srcCopy.existsAsFile()) {
            juce::File pf(srcCopy.getFullPathName() + ".xlpeak");
            uint64_t h = WaveformMipmap::computeSourceHash(srcCopy);
            if (pf.existsAsFile() && mm->loadFromFile(pf, h)) {
                mm->setSourceBuffer(buffer);
                WFM_LOG("loaded from cache: %s", pf.getFileName().toRawUTF8());
                return;
            }
        }

        // Generate from the in-memory buffer
        mm->generate(*buffer, sampleRate);

        // Persist to .xlpeak for next time
        if (saveXlpeak && srcCopy.existsAsFile()) {
            uint64_t h = WaveformMipmap::computeSourceHash(srcCopy);
            mm->setSourceHash(h);
            juce::File pf(srcCopy.getFullPathName() + ".xlpeak");
            mm->saveToFile(pf);
        }
    }).detach();
}

void WaveformMipmapCache::generateFromFile(
    const std::string& key,
    const juce::File& audioFile)
{
    if (!audioFile.existsAsFile()) return;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (cache_.count(key)) return;
        cache_[key] = std::make_unique<WaveformMipmap>();
    }

    WaveformMipmap* mm;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        mm = cache_[key].get();
    }

    juce::File fileCopy = audioFile;

    std::thread([mm, fileCopy]() {
        juce::File pf(fileCopy.getFullPathName() + ".xlpeak");
        uint64_t h = WaveformMipmap::computeSourceHash(fileCopy);

        // Try loading existing .xlpeak first
        if (pf.existsAsFile() && mm->loadFromFile(pf, h)) {
            WFM_LOG("loaded from cache: %s", pf.getFileName().toRawUTF8());
            return;
        }

        if (mm->generateFromFile(fileCopy)) {
            mm->saveToFile(pf);
        }
    }).detach();
}

void WaveformMipmapCache::remove(const std::string& key)
{
    std::lock_guard<std::mutex> lock(mutex_);
    cache_.erase(key);
}

void WaveformMipmapCache::clear()
{
    std::lock_guard<std::mutex> lock(mutex_);
    cache_.clear();
}

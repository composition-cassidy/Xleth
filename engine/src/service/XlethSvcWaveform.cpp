// XlethSvcWaveform.cpp — Waveform mipmap domain handlers (S2 Stage 4).
//
// Verbatim move of the four waveform_* handlers (+ wfbLog/WFB_LOG debug
// logging + applyPeakTransforms helper) out of XlethEngineService.cpp (was
// lines 7601–8167 at branch base a1dd848). No behavior change — see
// docs/S2_SPLIT_PLAN.md §4 Stage 4. dispatch() (still in
// XlethEngineService.cpp) resolves these via XlethSvcWaveform.h.

#include "service/XlethSvcGlobals.h"
using namespace xleth::svc;
#include "service/XlethSvcShared.h"
#include "service/XlethSvcWaveform.h"

#include "audio/WaveformMipmap.h"
#include "model/TimelineTypes.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// Waveform mipmap bindings — multi-resolution peak data from WaveformMipmap.
// (Pipeline B retired — all callers now use Waveform_GetRegionPeaks instead.)
// ─────────────────────────────────────────────────────────────────────────────

#ifdef XLETH_DEBUG
namespace {
void wfbLog(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[WaveformBridge] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
    fflush(stderr);
}
}
#define WFB_LOG(...) wfbLog(__VA_ARGS__)
#else
#define WFB_LOG(...) ((void)0)
#endif

// Helper: apply SampleProcessor display transforms to peak output in-place.
// Only polarity-invert and reverse can be applied to cached peak data.
// DC removal and normalize require the actual buffer data and cannot be
// applied to pre-computed peaks — see TODO comments below.
static void applyPeakTransforms(float* peaks, int numCols,
                                 const SampleRegion* region)
{
    if (!region) return;

    // TODO: DC removal shifts all samples by a constant, but the offset is
    // computed dynamically from the full buffer (mean of all samples).  The
    // mipmap doesn't store the DC value, so we can't adjust peaks here.
    // The visual difference is negligible for most content.

    // TODO: Normalize scales all samples by (1.0 / peakMagnitude), but the
    // gain factor is computed dynamically.  Applying it here would require
    // scanning the mipmap to find the global peak — possible but deferred
    // to avoid per-query overhead.  Peaks will appear un-normalized.

    // Polarity invert: negate min/max and swap them.  RMS is unaffected.
    if (region->polarityReversed) {
        for (int i = 0; i < numCols; ++i) {
            const int idx = i * 3;
            const float oldMin = peaks[idx];
            const float oldMax = peaks[idx + 1];
            peaks[idx]     = -oldMax;
            peaks[idx + 1] = -oldMin;
            // peaks[idx + 2] (rms) unchanged
        }
    }

    // Reverse: reverse the order of [min,max,rms] triples.
    if (region->reversed) {
        for (int i = 0; i < numCols / 2; ++i) {
            const int a = i * 3;
            const int b = (numCols - 1 - i) * 3;
            std::swap(peaks[a],     peaks[b]);
            std::swap(peaks[a + 1], peaks[b + 1]);
            std::swap(peaks[a + 2], peaks[b + 2]);
        }
    }
}

// waveform_getRegionPeaks(regionId, startTime, endTime, targetPixels, channel)
// Returns { peaks: Float32Array, needsRawSamples, ready, sampleRate, totalSamples }
JsonApi::Value Waveform_GetRegionPeaks(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    // ── Build empty/not-ready result ─────────────────────────────────────
    auto makeResult = [&](bool ready, int sr = 0, int64_t total = 0) {
        auto obj = JsonApi::Object::New(env);
        auto ab = JsonApi::ArrayBuffer::New(env, 0);
        obj.Set("peaks",          JsonApi::Float32Array::New(env, 0, ab, 0));
        obj.Set("needsRawSamples", JsonApi::Boolean::New(env, false));
        obj.Set("ready",          JsonApi::Boolean::New(env, ready));
        obj.Set("sampleRate",     JsonApi::Number::New(env, sr));
        obj.Set("totalSamples",   JsonApi::Number::New(env, static_cast<double>(total)));
        return obj;
    };

    if (!g_timeline || !audioEngine || !sampleBank || !g_mipmapCache) {
        WFB_LOG("getRegionPeaks: engine/timeline not initialised");
        return makeResult(false);
    }
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        JsonApi::TypeError::New(env,
            "waveform_getRegionPeaks(regionId, startTime, endTime, targetPixels, channel)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const int    regionId     = info[0].As<JsonApi::Number>().Int32Value();
    const double startTime    = info[1].As<JsonApi::Number>().DoubleValue();
    const double endTime      = info[2].As<JsonApi::Number>().DoubleValue();
    const int    targetPixels = std::max(1, std::min(info[3].As<JsonApi::Number>().Int32Value(), 16000));
    const int    channel      = info[4].As<JsonApi::Number>().Int32Value();

    WFB_LOG("getRegionPeaks: region=%d t=%.3f–%.3f px=%d ch=%d",
            regionId, startTime, endTime, targetPixels, channel);

    // ── Look up mipmap ───────────────────────────────────────────────────
    const int sampleBankId =
        audioEngine->getMixEngine().getSampleIdForRegion(regionId);
    if (sampleBankId < 0) {
        WFB_LOG("getRegionPeaks: region %d -> sampleBankId=-1 (not mapped)", regionId);
        return makeResult(false);
    }

    auto* mm = g_mipmapCache->get(std::to_string(sampleBankId));
    if (!mm) {
        WFB_LOG("getRegionPeaks: region %d -> sampleBankId=%d, mipmap not ready", regionId, sampleBankId);
        return makeResult(false);
    }

    const int sr = mm->getSampleRate();
    const int64_t totalSamples = mm->getTotalSamples();
    const int numChannels = mm->getNumChannels();

    // ── Convert time to sample positions ─────────────────────────────────
    // endTime < 0 means "to end of sample" (same convention as getFilePeaks)
    double effectiveEnd = endTime;
    if (effectiveEnd < 0.0 && sr > 0)
        effectiveEnd = static_cast<double>(totalSamples) / sr;

    int64_t startSample = static_cast<int64_t>(startTime * sr);
    int64_t endSample   = static_cast<int64_t>(effectiveEnd * sr);
    startSample = std::max(int64_t(0), std::min(startSample, totalSamples));
    endSample   = std::max(startSample, std::min(endSample, totalSamples));

    if (startSample >= endSample) {
        WFB_LOG("getRegionPeaks: region %d empty range after clamping (start=%lld end=%lld)",
                regionId, (long long)startSample, (long long)endSample);
        return makeResult(true, sr, totalSamples);
    }

    // ── Allocate output ──────────────────────────────────────────────────
    const size_t floatCount = static_cast<size_t>(targetPixels) * 3;
    auto ab = JsonApi::ArrayBuffer::New(env, floatCount * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    std::memset(outBuf, 0, floatCount * sizeof(float));

    bool needsRaw = false;
    int cols = 0;

    if (channel >= 0 && channel < numChannels) {
        // ── Single channel ───────────────────────────────────────────────
        cols = mm->getPeaks(channel, startSample, endSample,
                            targetPixels, outBuf, static_cast<int>(floatCount),
                            needsRaw);
    } else {
        // ── Merge all channels (channel == -1) ───────────────────────────
        // Query ch0 into outBuf, then merge remaining channels
        cols = mm->getPeaks(0, startSample, endSample,
                            targetPixels, outBuf, static_cast<int>(floatCount),
                            needsRaw);

        if (numChannels > 1 && cols > 0) {
            std::vector<float> chBuf(static_cast<size_t>(cols) * 3);
            for (int ch = 1; ch < numChannels; ++ch) {
                bool nr = false;
                mm->getPeaks(ch, startSample, endSample,
                             targetPixels, chBuf.data(),
                             static_cast<int>(chBuf.size()), nr);
                if (nr) needsRaw = true;
                for (int c = 0; c < cols; ++c) {
                    const int idx = c * 3;
                    if (chBuf[idx]     < outBuf[idx])     outBuf[idx]     = chBuf[idx];     // min
                    if (chBuf[idx + 1] > outBuf[idx + 1]) outBuf[idx + 1] = chBuf[idx + 1]; // max
                    // RMS: sqrt(mean of per-channel rms^2)
                    const float r0 = outBuf[idx + 2];
                    const float r1 = chBuf[idx + 2];
                    outBuf[idx + 2] = std::sqrt((r0 * r0 + r1 * r1) / 2.0f);
                }
            }
        }
    }

    // ── Apply SampleProcessor display transforms ─────────────────────────
    const SampleRegion* region = g_timeline->getRegion(regionId);
    applyPeakTransforms(outBuf, cols, region);

    // ── Return result ────────────────────────────────────────────────────
    auto result = JsonApi::Object::New(env);
    result.Set("peaks",          JsonApi::Float32Array::New(env, floatCount, ab, 0));
    result.Set("needsRawSamples", JsonApi::Boolean::New(env, needsRaw));
    result.Set("ready",          JsonApi::Boolean::New(env, true));
    result.Set("sampleRate",     JsonApi::Number::New(env, sr));
    result.Set("totalSamples",   JsonApi::Number::New(env, static_cast<double>(totalSamples)));
    return result;
}

// waveform_getRawSamples(regionId, startSample, endSample, channel)
// Returns { samples: Float32Array, sampleRate: number }
JsonApi::Value Waveform_GetRawSamples(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    auto makeEmpty = [&]() {
        auto obj = JsonApi::Object::New(env);
        auto ab = JsonApi::ArrayBuffer::New(env, 0);
        obj.Set("samples",    JsonApi::Float32Array::New(env, 0, ab, 0));
        obj.Set("sampleRate", JsonApi::Number::New(env, 0));
        return obj;
    };

    if (!g_timeline || !audioEngine || !sampleBank || !g_mipmapCache) return makeEmpty();
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        JsonApi::TypeError::New(env,
            "waveform_getRawSamples(regionId, startSample, endSample, channel)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const int     regionId    = info[0].As<JsonApi::Number>().Int32Value();
    const int64_t startSample = static_cast<int64_t>(info[1].As<JsonApi::Number>().DoubleValue());
    const int64_t endSample   = static_cast<int64_t>(info[2].As<JsonApi::Number>().DoubleValue());
    const int     channel     = info[3].As<JsonApi::Number>().Int32Value();

    const int sampleBankId =
        audioEngine->getMixEngine().getSampleIdForRegion(regionId);
    if (sampleBankId < 0) return makeEmpty();

    auto* mm = g_mipmapCache->get(std::to_string(sampleBankId));
    if (!mm) return makeEmpty();

    const int sr = mm->getSampleRate();
    const int numChannels = mm->getNumChannels();
    const int count = static_cast<int>(std::max(int64_t(0), endSample - startSample));
    if (count == 0) return makeEmpty();

    auto ab = JsonApi::ArrayBuffer::New(env, static_cast<size_t>(count) * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    int written = 0;

    if (channel >= 0 && channel < numChannels) {
        written = mm->getRawSamples(channel, startSample, endSample,
                                     outBuf, count);
    } else if (numChannels > 0) {
        // Merge: average all channels sample-by-sample
        written = mm->getRawSamples(0, startSample, endSample, outBuf, count);
        if (numChannels > 1 && written > 0) {
            std::vector<float> chBuf(static_cast<size_t>(written));
            for (int ch = 1; ch < numChannels; ++ch) {
                mm->getRawSamples(ch, startSample, endSample,
                                   chBuf.data(), written);
                for (int i = 0; i < written; ++i)
                    outBuf[i] += chBuf[i];
            }
            const float invCh = 1.0f / static_cast<float>(numChannels);
            for (int i = 0; i < written; ++i)
                outBuf[i] *= invCh;
        }
    }

    // Apply polarity/reverse transforms
    const SampleRegion* region = g_timeline->getRegion(regionId);
    if (region) {
        if (region->polarityReversed) {
            for (int i = 0; i < written; ++i)
                outBuf[i] = -outBuf[i];
        }
        if (region->reversed) {
            std::reverse(outBuf, outBuf + written);
        }
    }

    auto result = JsonApi::Object::New(env);
    result.Set("samples",    JsonApi::Float32Array::New(env, static_cast<size_t>(count), ab, 0));
    result.Set("sampleRate", JsonApi::Number::New(env, sr));
    return result;
}

// waveform_getClipPeaks(clipId, startSec, endSec, numPeaks)
// Returns peaks from the ClipRenderCache processed buffer (stretch/pitch/reverse output).
// Returns { peaks: Float32Array, ready: bool, sampleRate: number, totalSamples: number }
// ready=false means the cache is a miss (buffer still building) — JS should fall back to
// the raw region waveform and retry after a short delay.
// Channels are merged (same as channel==-1 in getRegionPeaks).
// Peak format: [min, max, rms, min, max, rms, ...] — 3 floats per column.
JsonApi::Value Waveform_GetClipPeaks(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    auto makeResult = [&](bool ready, int sr = 0, int64_t total = 0) {
        auto obj = JsonApi::Object::New(env);
        auto ab  = JsonApi::ArrayBuffer::New(env, 0);
        obj.Set("peaks",        JsonApi::Float32Array::New(env, 0, ab, 0));
        obj.Set("ready",        JsonApi::Boolean::New(env, ready));
        obj.Set("sampleRate",   JsonApi::Number::New(env, sr));
        obj.Set("totalSamples", JsonApi::Number::New(env, static_cast<double>(total)));
        return obj;
    };

    if (!g_timeline || !audioEngine) {
        return makeResult(false);
    }
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber()) {
        JsonApi::TypeError::New(env,
            "waveform_getClipPeaks(clipId, startSec, endSec, numPeaks)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const int    clipId   = info[0].As<JsonApi::Number>().Int32Value();
    const double startSec = info[1].As<JsonApi::Number>().DoubleValue();
    const double endSec   = info[2].As<JsonApi::Number>().DoubleValue();
    const int    numPeaks = std::max(1, std::min(info[3].As<JsonApi::Number>().Int32Value(), 16000));

    const auto& mix = audioEngine->getMixEngine();
    const juce::AudioBuffer<float>* buf = mix.getClipProcessedBuffer(clipId);
    if (!buf) {
        // Cache miss (buffer building) or clip has identity params — signal not-ready.
        return makeResult(false);
    }

    const double sr         = mix.getPreparedSampleRate();
    const int    numCh      = buf->getNumChannels();
    const int    numSamples = buf->getNumSamples();

    // Map time window to sample range.  endSec <= 0 means "full buffer".
    const double effEnd = (endSec > 0.0) ? endSec
                                          : (sr > 0.0 ? static_cast<double>(numSamples) / sr : 0.0);
    int64_t startSamp = static_cast<int64_t>(startSec * sr);
    int64_t endSamp   = static_cast<int64_t>(effEnd   * sr);
    startSamp = std::max(int64_t(0), std::min(startSamp, static_cast<int64_t>(numSamples)));
    endSamp   = std::max(startSamp,  std::min(endSamp,   static_cast<int64_t>(numSamples)));

    if (startSamp >= endSamp || numCh == 0) {
        return makeResult(true, static_cast<int>(sr), numSamples);
    }

    const size_t floatCount = static_cast<size_t>(numPeaks) * 3;
    auto   ab     = JsonApi::ArrayBuffer::New(env, floatCount * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    std::memset(outBuf, 0, floatCount * sizeof(float));

    const int64_t rangeLen    = endSamp - startSamp;
    const double  sampPerCol  = static_cast<double>(rangeLen) / numPeaks;

    for (int col = 0; col < numPeaks; ++col) {
        const int64_t cs = startSamp + static_cast<int64_t>(col       * sampPerCol);
        const int64_t ce = startSamp + static_cast<int64_t>((col + 1) * sampPerCol);
        const int64_t csClamped = std::max(int64_t(0), std::min(cs, static_cast<int64_t>(numSamples)));
        const int64_t ceClamped = std::max(csClamped,  std::min(ce, static_cast<int64_t>(numSamples)));

        float mn = 0.0f, mx = 0.0f, rmsAcc = 0.0f;
        int   count = 0;
        bool  firstSamp = true;

        for (int ch = 0; ch < numCh; ++ch) {
            const float* data = buf->getReadPointer(ch);
            for (int64_t s = csClamped; s < ceClamped; ++s) {
                const float v = data[s];
                if (firstSamp) { mn = mx = v; firstSamp = false; }
                else { if (v < mn) mn = v; if (v > mx) mx = v; }
                rmsAcc += v * v;
                ++count;
            }
        }

        const int idx   = col * 3;
        outBuf[idx]     = mn;
        outBuf[idx + 1] = mx;
        outBuf[idx + 2] = count > 0 ? std::sqrt(rmsAcc / static_cast<float>(count)) : 0.0f;
    }

    auto result = JsonApi::Object::New(env);
    result.Set("peaks",        JsonApi::Float32Array::New(env, floatCount, ab, 0));
    result.Set("ready",        JsonApi::Boolean::New(env, true));
    result.Set("sampleRate",   JsonApi::Number::New(env, static_cast<int>(sr)));
    result.Set("totalSamples", JsonApi::Number::New(env, static_cast<double>(numSamples)));
    return result;
}

// waveform_getFilePeaks(filePath, startTime, endTime, targetPixels, channel)
// For files not yet imported (SamplePicker, SyllableSplitter browsing).
// Returns same shape as waveform_getRegionPeaks.
JsonApi::Value Waveform_GetFilePeaks(const JsonApi::CallbackInfo& info)
{
    JsonApi::Env env = info.Env();

    auto makeResult = [&](bool ready, int sr = 0, int64_t total = 0, bool error = false) {
        auto obj = JsonApi::Object::New(env);
        auto ab = JsonApi::ArrayBuffer::New(env, 0);
        obj.Set("peaks",          JsonApi::Float32Array::New(env, 0, ab, 0));
        obj.Set("needsRawSamples", JsonApi::Boolean::New(env, false));
        obj.Set("ready",          JsonApi::Boolean::New(env, ready));
        obj.Set("error",          JsonApi::Boolean::New(env, error));
        obj.Set("sampleRate",     JsonApi::Number::New(env, sr));
        obj.Set("totalSamples",   JsonApi::Number::New(env, static_cast<double>(total)));
        obj.Set("duration",       JsonApi::Number::New(env, sr > 0 ? static_cast<double>(total) / sr : 0.0));
        return obj;
    };

    if (!g_mipmapCache) return makeResult(false);
    if (info.Length() < 5 || !info[0].IsString() || !info[1].IsNumber() ||
        !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
        JsonApi::TypeError::New(env,
            "waveform_getFilePeaks(filePath, startTime, endTime, targetPixels, channel)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string filePath     = info[0].As<JsonApi::String>().Utf8Value();
    const double      startTime    = info[1].As<JsonApi::Number>().DoubleValue();
    double            endTime      = info[2].As<JsonApi::Number>().DoubleValue();
    const int         targetPixels = std::max(1, std::min(info[3].As<JsonApi::Number>().Int32Value(), 16000));
    const int         channel      = info[4].As<JsonApi::Number>().Int32Value();

    WFB_LOG("getFilePeaks: %s t=%.3f–%.3f px=%d ch=%d",
            filePath.c_str(), startTime, endTime, targetPixels, channel);

    auto audioFile = juce::File(juce::String(filePath));
    if (!audioFile.existsAsFile()) return makeResult(true);

    // ── Get or generate mipmap (synchronous for SamplePicker) ────────────
    const std::string key = "file:" + filePath;
    auto* mm = g_mipmapCache->get(key);
    if (!mm) {
        // Generate synchronously — SamplePicker expects blocking call
        auto mipmap = std::make_unique<WaveformMipmap>();
        if (!mipmap->generateFromFile(audioFile)) {
            WFB_LOG("getFilePeaks: generation failed for %s", filePath.c_str());
            return makeResult(true, 0, 0, true);
        }
        // Insert into cache (move ownership)
        // We need a raw pointer before moving
        WaveformMipmap* rawPtr = mipmap.get();
        {
            // Direct cache insertion — we already generated synchronously
            // so we bypass generateFromFile's async path.
            g_mipmapCache->remove(key);  // ensure clean slate
        }
        // Use generateFromFile on cache which will try .xlpeak first
        g_mipmapCache->generateFromFile(key, audioFile);
        // But that's async... We need synchronous insertion.
        // Instead, directly check the cache after triggering, OR
        // just generate inline and query the mipmap directly.
        // Since we already have the mipmap, query it directly.
        const int sr = rawPtr->getSampleRate();
        const int64_t totalSamples = rawPtr->getTotalSamples();
        const int numChannels = rawPtr->getNumChannels();

        if (endTime < 0.0) endTime = static_cast<double>(totalSamples) / sr;

        int64_t startSmp = static_cast<int64_t>(startTime * sr);
        int64_t endSmp   = static_cast<int64_t>(endTime * sr);
        startSmp = std::max(int64_t(0), std::min(startSmp, totalSamples));
        endSmp   = std::max(startSmp, std::min(endSmp, totalSamples));
        if (startSmp >= endSmp) {
            return makeResult(true, sr, totalSamples);
        }

        const size_t floatCount = static_cast<size_t>(targetPixels) * 3;
        auto ab = JsonApi::ArrayBuffer::New(env, floatCount * sizeof(float));
        float* outBuf = static_cast<float*>(ab.Data());
        std::memset(outBuf, 0, floatCount * sizeof(float));
        bool needsRaw = false;

        if (channel >= 0 && channel < numChannels) {
            rawPtr->getPeaks(channel, startSmp, endSmp,
                             targetPixels, outBuf, static_cast<int>(floatCount),
                             needsRaw);
        } else {
            rawPtr->getPeaks(0, startSmp, endSmp,
                             targetPixels, outBuf, static_cast<int>(floatCount),
                             needsRaw);
            if (numChannels > 1) {
                std::vector<float> chBuf(floatCount);
                for (int ch = 1; ch < numChannels; ++ch) {
                    bool nr = false;
                    rawPtr->getPeaks(ch, startSmp, endSmp,
                                     targetPixels, chBuf.data(),
                                     static_cast<int>(chBuf.size()), nr);
                    for (int c = 0; c < targetPixels; ++c) {
                        const int idx = c * 3;
                        if (chBuf[idx]     < outBuf[idx])     outBuf[idx]     = chBuf[idx];
                        if (chBuf[idx + 1] > outBuf[idx + 1]) outBuf[idx + 1] = chBuf[idx + 1];
                        const float r0 = outBuf[idx + 2], r1 = chBuf[idx + 2];
                        outBuf[idx + 2] = std::sqrt((r0 * r0 + r1 * r1) / 2.0f);
                    }
                }
            }
        }

        // Save .xlpeak for next time (async in background)
        rawPtr->saveToFile(juce::File(audioFile.getFullPathName() + ".xlpeak"));

        auto result = JsonApi::Object::New(env);
        result.Set("peaks",          JsonApi::Float32Array::New(env, floatCount, ab, 0));
        result.Set("needsRawSamples", JsonApi::Boolean::New(env, needsRaw));
        result.Set("ready",          JsonApi::Boolean::New(env, true));
        result.Set("error",          JsonApi::Boolean::New(env, false));
        result.Set("sampleRate",     JsonApi::Number::New(env, sr));
        result.Set("totalSamples",   JsonApi::Number::New(env, static_cast<double>(totalSamples)));
        result.Set("duration",       JsonApi::Number::New(env, static_cast<double>(totalSamples) / sr));

        // Now cache for future calls (move the unique_ptr)
        // We can't easily insert into WaveformMipmapCache from outside since
        // it only exposes generateFromFile/generateFromBuffer.
        // The next call to getFilePeaks will trigger cache's async generation
        // and the .xlpeak file we just saved will be loaded instantly.
        // For THIS call, we already have the result above. Done.
        return result;
    }

    // ── Mipmap is cached and ready ───────────────────────────────────────
    const int sr = mm->getSampleRate();
    const int64_t totalSamples = mm->getTotalSamples();
    const int numChannels = mm->getNumChannels();

    if (endTime < 0.0) endTime = static_cast<double>(totalSamples) / sr;

    int64_t startSmp = static_cast<int64_t>(startTime * sr);
    int64_t endSmp   = static_cast<int64_t>(endTime * sr);
    startSmp = std::max(int64_t(0), std::min(startSmp, totalSamples));
    endSmp   = std::max(startSmp, std::min(endSmp, totalSamples));
    if (startSmp >= endSmp) return makeResult(true, sr, totalSamples);

    const size_t floatCount = static_cast<size_t>(targetPixels) * 3;
    auto ab = JsonApi::ArrayBuffer::New(env, floatCount * sizeof(float));
    float* outBuf = static_cast<float*>(ab.Data());
    std::memset(outBuf, 0, floatCount * sizeof(float));
    bool needsRaw = false;

    if (channel >= 0 && channel < numChannels) {
        mm->getPeaks(channel, startSmp, endSmp,
                     targetPixels, outBuf, static_cast<int>(floatCount),
                     needsRaw);
    } else {
        mm->getPeaks(0, startSmp, endSmp,
                     targetPixels, outBuf, static_cast<int>(floatCount),
                     needsRaw);
        if (numChannels > 1) {
            std::vector<float> chBuf(floatCount);
            for (int ch = 1; ch < numChannels; ++ch) {
                bool nr = false;
                mm->getPeaks(ch, startSmp, endSmp,
                             targetPixels, chBuf.data(),
                             static_cast<int>(chBuf.size()), nr);
                for (int c = 0; c < targetPixels; ++c) {
                    const int idx = c * 3;
                    if (chBuf[idx]     < outBuf[idx])     outBuf[idx]     = chBuf[idx];
                    if (chBuf[idx + 1] > outBuf[idx + 1]) outBuf[idx + 1] = chBuf[idx + 1];
                    const float r0 = outBuf[idx + 2], r1 = chBuf[idx + 2];
                    outBuf[idx + 2] = std::sqrt((r0 * r0 + r1 * r1) / 2.0f);
                }
            }
        }
    }

    auto result = JsonApi::Object::New(env);
    result.Set("peaks",          JsonApi::Float32Array::New(env, floatCount, ab, 0));
    result.Set("needsRawSamples", JsonApi::Boolean::New(env, needsRaw));
    result.Set("ready",          JsonApi::Boolean::New(env, true));
    result.Set("error",          JsonApi::Boolean::New(env, false));
    result.Set("sampleRate",     JsonApi::Number::New(env, sr));
    result.Set("totalSamples",   JsonApi::Number::New(env, static_cast<double>(totalSamples)));
    result.Set("duration",       JsonApi::Number::New(env, static_cast<double>(totalSamples) / sr));
    return result;
}

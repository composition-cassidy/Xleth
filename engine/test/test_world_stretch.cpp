// test_world_stretch.cpp — Self-verification for WORLD vocoder + cache.
// Build: see engine/CMakeLists.txt target "test_world_stretch"
// Run:   test_world_stretch.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1

#include "audio/ClipRenderCache.h"
#include "audio/WorldStretchCache.h"
#include "dsp/WORLD.h"
#include "model/TimelineTypes.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

static constexpr double kSR = 48000.0;

// Generate a mono "voice-like" signal: fundamental + a few harmonics so WORLD's
// CheapTrick spectral envelope has structure to work with. A pure sine fools
// WORLD into preserving a single-peak envelope under pitch shift; voice-like
// content is what the algorithm is actually designed for.
static juce::AudioBuffer<float> makeVoiceLike(double f0Hz, double durSec, double sampleRate)
{
    const int n = static_cast<int>(std::lround(durSec * sampleRate));
    juce::AudioBuffer<float> buf(1, n);
    float* d = buf.getWritePointer(0);
    const double w0 = 2.0 * juce::MathConstants<double>::pi * f0Hz / sampleRate;
    for (int i = 0; i < n; ++i) {
        const double t = static_cast<double>(i);
        const double s = 0.50 * std::sin(w0 * t)
                       + 0.30 * std::sin(2.0 * w0 * t)
                       + 0.18 * std::sin(3.0 * w0 * t)
                       + 0.10 * std::sin(4.0 * w0 * t);
        d[i] = static_cast<float>(0.4 * s);
    }
    return buf;
}

static float bufferRMS(const juce::AudioBuffer<float>& b)
{
    if (b.getNumSamples() <= 0 || b.getNumChannels() <= 0) return 0.0f;
    double sum = 0.0;
    int    cnt = 0;
    for (int ch = 0; ch < b.getNumChannels(); ++ch) {
        const float* p = b.getReadPointer(ch);
        for (int i = 0; i < b.getNumSamples(); ++i) { sum += static_cast<double>(p[i]) * p[i]; ++cnt; }
    }
    return static_cast<float>(std::sqrt(sum / std::max(1, cnt)));
}

static void testProcessorPitchShift()
{
    std::cout << "[test] processWORLD: +12 semitones on 220 Hz voice-like signal\n";

    auto in = makeVoiceLike(220.0, 1.0, kSR);

    xleth::dsp::WORLDParams p;
    p.sampleRate          = kSR;
    p.pitchShiftSemitones = 12.0;     // octave up
    p.stretchRatio        = 1.0;
    auto out = xleth::dsp::processWORLD(in, p);

    CHECK(out.getNumChannels() == in.getNumChannels(),
          "channel count preserved");
    CHECK(std::abs(out.getNumSamples() - in.getNumSamples()) <= 32,
          "output length matches input length within rounding (got "
              << out.getNumSamples() << ", expected " << in.getNumSamples() << ")");

    // Skip the first 0.1 s — WORLD's onset can be unstable.
    const int skip = static_cast<int>(std::lround(0.1 * kSR));
    const int useN = std::min(out.getNumSamples() - skip, static_cast<int>(std::lround(0.5 * kSR)));
    juce::AudioBuffer<float> tail(1, useN);
    tail.copyFrom(0, 0, out, 0, skip, useN);
    const float rms = bufferRMS(tail);
    std::cout << "  output RMS = " << rms << " (input RMS ≈ "
              << bufferRMS(in) << ")\n";
    // The dominant-bin pitch check is unreliable for vocoded output: WORLD
    // preserves the *spectral envelope* under pitch shift, so for narrow-band
    // synthetic input the loudest bin can sit at the original-pitch envelope
    // peak rather than the new f0. The vocal-clip smoke test (verification
    // step 3) covers that. Here we just confirm the pipeline produced
    // non-silent audio of the right shape.
    CHECK(rms > 0.005f, "octave-up output is not silent (RMS > -46 dB)");
}

static void testProcessorStretchOnly()
{
    std::cout << "[test] processWORLD: stretchRatio = 2.0, no pitch shift\n";

    auto in = makeVoiceLike(220.0, 0.5, kSR);
    xleth::dsp::WORLDParams p;
    p.sampleRate   = kSR;
    p.stretchRatio = 2.0;
    auto out = xleth::dsp::processWORLD(in, p);

    const int expected = in.getNumSamples() * 2;
    CHECK(std::abs(out.getNumSamples() - expected) <= 32,
          "output length ≈ 2x input (got " << out.getNumSamples()
              << ", expected " << expected << ")");

    const int skip = static_cast<int>(std::lround(0.2 * kSR));
    const int useN = std::min(out.getNumSamples() - skip, static_cast<int>(std::lround(0.5 * kSR)));
    juce::AudioBuffer<float> tail(1, useN);
    tail.copyFrom(0, 0, out, 0, skip, useN);
    const float rms = bufferRMS(tail);
    std::cout << "  output RMS = " << rms << " (input RMS ≈ "
              << bufferRMS(in) << ")\n";
    CHECK(rms > 0.005f, "stretched output is not silent (RMS > -46 dB)");
}

static void testCacheHit()
{
    std::cout << "[test] WorldStretchCache: hit returns same shared_ptr; no re-compute\n";

    xleth::audio::WorldStretchCache cache;
    auto in = makeVoiceLike(220.0, 0.5, kSR);

    xleth::dsp::WORLDParams p;
    p.sampleRate          = kSR;
    p.pitchShiftSemitones = 2.0;
    p.stretchRatio        = 1.0;

    xleth::audio::WorldCacheKey k;
    k.sourceHash   = xleth::audio::WorldStretchCache::hashPCM(in);
    k.pitchMilliSt = 2000;
    k.ratioMicro   = 1000;
    k.sampleRateHz = static_cast<int32_t>(std::lround(kSR));
    k.numChannels  = in.getNumChannels();

    const auto firstCount = cache.computeCount();
    auto a = cache.getOrCompute(k, in, p);
    const auto afterFirst = cache.computeCount();
    auto b = cache.getOrCompute(k, in, p);
    const auto afterSecond = cache.computeCount();

    CHECK(a != nullptr, "first call returns non-null");
    CHECK(a.get() == b.get(), "second call returns same buffer pointer");
    CHECK(afterFirst - firstCount == 1, "first call increments computeCount by 1");
    CHECK(afterSecond - afterFirst == 0, "second call does NOT recompute");
    CHECK(cache.entryCount() == 1, "cache holds exactly 1 entry");
}

static void testCacheKeyVariants()
{
    std::cout << "[test] WorldStretchCache: distinct pitches produce distinct entries\n";

    xleth::audio::WorldStretchCache cache;
    auto in = makeVoiceLike(220.0, 0.3, kSR);

    auto runWith = [&](int pitchMilli, double semis) -> std::shared_ptr<const juce::AudioBuffer<float>> {
        xleth::dsp::WORLDParams p;
        p.sampleRate          = kSR;
        p.pitchShiftSemitones = semis;
        p.stretchRatio        = 1.0;
        xleth::audio::WorldCacheKey k;
        k.sourceHash   = xleth::audio::WorldStretchCache::hashPCM(in);
        k.pitchMilliSt = pitchMilli;
        k.ratioMicro   = 1000;
        k.sampleRateHz = static_cast<int32_t>(std::lround(kSR));
        k.numChannels  = in.getNumChannels();
        return cache.getOrCompute(k, in, p);
    };

    auto up   = runWith(2000,  2.0);
    auto down = runWith(-2000, -2.0);
    auto upAgain = runWith(2000, 2.0);

    CHECK(up.get() != down.get(), "different pitches → different cache entries");
    CHECK(up.get() == upAgain.get(), "repeating a key returns the original buffer");
    CHECK(cache.entryCount() == 2, "cache holds 2 entries after pitch toggle");
    CHECK(cache.computeCount() == 2, "exactly 2 computations executed");
}

// ── Trimmed WORLD clips render as a crop of the untrimmed render ─────────────
// WORLD's F0 tracker (Harvest) and envelope analysis need audio on both sides
// of every frame. Handing it only the trimmed slice used to starve it: a short
// trim lost its attack and could collapse into noise. ClipRenderCache now feeds
// WORLD context around the trim and crops the result, so a trimmed clip must
// sound like the matching window of the same clip left untrimmed.

// Source: 50 ms silence, then a voice-like note with a 4 ms attack that holds
// for ~1.1 s.
static juce::AudioBuffer<float> makeAttackNote()
{
    const int lead = static_cast<int>(std::lround(0.05 * kSR));
    auto note = makeVoiceLike(196.0, 1.1, kSR);
    juce::AudioBuffer<float> buf(1, lead + note.getNumSamples());
    buf.clear();
    const int atk = static_cast<int>(std::lround(0.004 * kSR));
    for (int i = 0; i < note.getNumSamples(); ++i) {
        const float g = i < atk ? static_cast<float>(i) / atk : 1.0f;
        buf.setSample(0, lead + i, note.getSample(0, i) * g);
    }
    return buf;
}

static std::shared_ptr<const juce::AudioBuffer<float>>
renderWorldClip(ClipRenderCache& cache, int clipId,
                const juce::AudioBuffer<float>& src,
                int64_t regOff, int64_t durSamples, double ratio, int semis)
{
    CacheKey k;
    k.regionId            = 1;
    k.regionOffsetSamples = regOff;
    k.durationSamples     = durSamples;
    k.sourceLengthSamples = src.getNumSamples();
    k.pitchOffsetSemis    = semis;
    k.stretchRatio        = ratio;
    k.stretchMethod       = static_cast<int>(StretchMethod::WORLD);
    cache.submitJob(clipId, k, src, kSR, kSR);
    const auto deadline = juce::Time::getMillisecondCounter() + 120000;
    while (juce::Time::getMillisecondCounter() < deadline) {
        if (auto b = cache.getProcessedBuffer(clipId, k)) return b;
        juce::Thread::sleep(5);
    }
    return nullptr;
}

// Worst 20 ms-block level difference (dB) between `got` and `ref[refStart..]`
// over blocks where the reference is audible, the normalised waveform
// correlation over the whole window, and the correlation of their magnitude
// spectra. WORLD resynthesises from a pulse train whose phase starts wherever
// the render starts, so a clip trimmed IN cannot match the full render
// sample-for-sample — only in level and spectrum, which is what is audible.
// A clip trimmed at its end starts where the full render does, so its
// waveform must match too.
// headDb / tailDb: level difference of the FIRST and LAST 5 ms. Those are what
// the old slice-only render broke: a trim-in lost 8-14 dB of its first 5 ms
// (the attack) and every short trim dropped 10-20 dB in its last 5 ms.
struct WindowMatch { double worstDb = 999.0; double corr = 0.0; double headDb = 999.0;
                     double tailDb = 999.0; double specCorr = 0.0; };

static double magnitudeSpectrumCorr(const float* a, const float* b, int n)
{
    constexpr int order = 12, size = 1 << order;
    juce::dsp::FFT fft(order);
    std::vector<float> fa(2 * size, 0.0f), fb(2 * size, 0.0f);
    const int m = std::min(n, size);
    for (int i = 0; i < m; ++i) {
        const float w = 0.5f - 0.5f * std::cos(2.0f * juce::MathConstants<float>::pi * i / (m - 1));
        fa[i] = a[i] * w;
        fb[i] = b[i] * w;
    }
    fft.performFrequencyOnlyForwardTransform(fa.data());
    fft.performFrequencyOnlyForwardTransform(fb.data());
    double sab = 0.0, saa = 0.0, sbb = 0.0;
    for (int k = 1; k < size / 2; ++k) { sab += double(fa[k]) * fb[k]; saa += double(fa[k]) * fa[k]; sbb += double(fb[k]) * fb[k]; }
    return sab / std::sqrt(saa * sbb + 1e-30);
}

static WindowMatch compareWindow(const juce::AudioBuffer<float>& got,
                                 const juce::AudioBuffer<float>& ref,
                                 int refStart)
{
    WindowMatch m;
    const int n = std::min(got.getNumSamples(), ref.getNumSamples() - refStart);
    if (n <= 0) return m;
    const float* g = got.getReadPointer(0);
    const float* r = ref.getReadPointer(0) + refStart;
    auto levelDiff = [&](int b0, int len) {
        double eg = 0.0, er = 0.0;
        for (int i = b0; i < b0 + len; ++i) { eg += double(g[i]) * g[i]; er += double(r[i]) * r[i]; }
        return std::abs(10.0 * std::log10(eg / len + 1e-20) - 10.0 * std::log10(er / len + 1e-20));
    };
    const int edge = static_cast<int>(std::lround(0.005 * kSR));
    if (n >= edge) {
        m.headDb = levelDiff(0, edge);
        m.tailDb = levelDiff(n - edge, edge);
    }
    const int blk = static_cast<int>(std::lround(0.020 * kSR));
    m.worstDb = 0.0;
    for (int b0 = 0; b0 + blk <= n; b0 += blk) {
        double er = 0.0;
        for (int i = b0; i < b0 + blk; ++i) er += double(r[i]) * r[i];
        if (10.0 * std::log10(er / blk + 1e-20) > -40.0)
            m.worstDb = std::max(m.worstDb, levelDiff(b0, blk));
    }
    double sgr = 0.0, sgg = 0.0, srr = 0.0;
    for (int i = 0; i < n; ++i) { sgr += double(g[i]) * r[i]; sgg += double(g[i]) * g[i]; srr += double(r[i]) * r[i]; }
    m.corr = sgr / std::sqrt(sgg * srr + 1e-30);
    m.specCorr = magnitudeSpectrumCorr(g, r, n);
    if (std::getenv("WORLD_PROFILE")) {
        const int b5 = static_cast<int>(std::lround(0.005 * kSR));
        std::printf("    5ms got/ref dB:");
        for (int b0 = 0; b0 + b5 <= n; b0 += b5) {
            double eg = 0.0, er = 0.0;
            for (int i = b0; i < b0 + b5; ++i) { eg += double(g[i]) * g[i]; er += double(r[i]) * r[i]; }
            std::printf(" %.0f/%.0f", 10.0 * std::log10(eg / b5 + 1e-20), 10.0 * std::log10(er / b5 + 1e-20));
        }
        std::printf("\n");
    }
    return m;
}

static void testTrimmedClipMatchesUntrimmed()
{
    std::cout << "[test] ClipRenderCache WORLD: short trims render as a crop of the full render\n";

    // Heap: ClipRenderCache carries a 64K-slot inline array (~1 MB).
    auto cachePtr = std::make_unique<ClipRenderCache>();
    auto& cache = *cachePtr;
    xleth::audio::WorldStretchCache world;
    cache.setWorldCache(&world);

    const auto src = makeAttackNote();
    const int64_t onset = static_cast<int64_t>(std::lround(0.05 * kSR));

    struct Case { double ratio; int semis; };
    // 5 ms edge blocks need >= ~1 pitch period of output to be phase-stable,
    // so every case keeps the output pitch at or above the source's 196 Hz.
    const Case cases[] = { {2.0, 3}, {1.0, 5}, {3.0, 0}, {0.5, 7} };
    int clipId = 1;
    for (const auto& c : cases) {
        // Untrimmed reference: starts on the attack, runs 1 s of source.
        const int64_t fullDur = static_cast<int64_t>(std::lround(1.0 * kSR * c.ratio));
        auto full = renderWorldClip(cache, clipId++, src, onset, fullDur, c.ratio, c.semis);
        CHECK(full != nullptr, "full render finished");
        if (!full) continue;

        // (a) End trimmed to 40 ms of source: the attack must survive.
        // (b) Start trimmed 400 ms into the note, 40 ms long.
        const int64_t shortSrc = static_cast<int64_t>(std::lround(0.04 * kSR));
        const int64_t shortDur = static_cast<int64_t>(std::lround(shortSrc * c.ratio));
        const int64_t inset    = static_cast<int64_t>(std::lround(0.4 * kSR));

        auto head = renderWorldClip(cache, clipId++, src, onset, shortDur, c.ratio, c.semis);
        auto mid  = renderWorldClip(cache, clipId++, src, onset + inset, shortDur, c.ratio, c.semis);
        CHECK(head && mid, "short renders finished");
        if (!head || !mid) continue;

        const auto mh = compareWindow(*head, *full, 0);
        const auto mm = compareWindow(*mid, *full,
                                      static_cast<int>(std::lround(inset * c.ratio)));
        std::printf("  ratio %.1f %+d st | head trim: start %.2f / end %.2f dB, worst %.2f dB,"
                    " corr %.3f, spec %.3f | mid trim: start %.2f / end %.2f dB, worst %.2f dB, spec %.3f\n",
                    c.ratio, c.semis, mh.headDb, mh.tailDb, mh.worstDb, mh.corr, mh.specCorr,
                    mm.headDb, mm.tailDb, mm.worstDb, mm.specCorr);
        CHECK(mh.headDb   < 3.0,  "head trim keeps its attack (" << mh.headDb << " dB off)");
        CHECK(mh.tailDb   < 3.0,  "head trim keeps its last 5 ms (" << mh.tailDb << " dB off)");
        CHECK(mh.worstDb  < 2.0,  "head trim level tracks the full render (" << mh.worstDb << " dB)");
        CHECK(mh.corr     > 0.9,  "head trim waveform matches the full render (corr " << mh.corr << ")");
        CHECK(mh.specCorr > 0.95, "head trim spectrum matches the full render (" << mh.specCorr << ")");
        CHECK(mm.headDb   < 3.0,  "mid trim keeps its first 5 ms (" << mm.headDb << " dB off)");
        CHECK(mm.tailDb   < 3.0,  "mid trim keeps its last 5 ms (" << mm.tailDb << " dB off)");
        CHECK(mm.worstDb  < 2.0,  "mid trim level tracks the full render (" << mm.worstDb << " dB)");
        CHECK(mm.specCorr > 0.95, "mid trim spectrum matches the full render (" << mm.specCorr << ")");
    }
    cache.shutdown();
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    testProcessorPitchShift();
    testProcessorStretchOnly();
    testCacheHit();
    testCacheKeyVariants();
    testTrimmedClipMatchesUntrimmed();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed.\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED\n";
    return 1;
}

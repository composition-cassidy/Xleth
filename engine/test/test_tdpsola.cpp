// test_tdpsola.cpp — Regression guard for TDPSOLA time-stretch / pitch-shift.
// Build: see engine/CMakeLists.txt target "test_tdpsola"
// Run:   test_tdpsola.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Purpose: TDPSOLA had no direct test coverage. This pins its output against a
// baseline captured before the LoopAnalysis.h extraction, so that refactor (and
// later ones) can be proven behaviour-preserving rather than assumed to be.
//
// Setting XLETH_TDPSOLA_DUMP=<path> writes the raw float samples of the stretch
// case to that path, for byte-level before/after diffing outside the assertions.

#include "dsp/TDPSOLA.h"
#include "dsp/StretchInputFloor.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
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

// Tolerance for baseline comparison. The refactor moves code between
// translation units without changing the math, so results should be bit-exact;
// this leaves headroom only for compiler codegen differences (e.g. x87 vs SSE
// intermediate rounding) rather than for genuine behaviour drift.
static constexpr float kTol = 1.0e-5f;

// Deterministic voice-like signal: fundamental + harmonics, so NSDF pitch
// detection has a real periodic structure to lock onto. A pure sine would
// exercise far less of the pitch-mark path.
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

static void maybeDump(const juce::AudioBuffer<float>& b)
{
    const char* path = std::getenv("XLETH_TDPSOLA_DUMP");
    if (path == nullptr) return;
    std::FILE* f = std::fopen(path, "wb");
    if (f == nullptr) { std::cerr << "  WARN: cannot open dump path " << path << "\n"; return; }
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        std::fwrite(b.getReadPointer(ch), sizeof(float), (size_t)b.getNumSamples(), f);
    std::fclose(f);
    std::cout << "  dumped " << b.getNumSamples() << " samples to " << path << "\n";
}

// Probe offsets spread across the output, avoiding the very edges where
// overlap-add ramps in and out.
static constexpr int kProbes[] = { 5000, 12000, 24000, 36000, 48000, 60000 };

// ── Baseline: captured from TDPSOLA.cpp at HEAD, BEFORE the LoopAnalysis
//    extraction. Do not regenerate these casually — if a change moves them,
//    that change altered TDPSOLA's output and needs justifying, not re-baselining.
static constexpr int   kBaselineStretchLen = 72000;          // 48000 in * 1.5
static constexpr float kBaselineStretchRMS = 0.174979955f;
static constexpr float kBaselineProbes[]   = {
    -0.269070357f, 0.218123183f, 0.32163775f,
     0.295525879f, 0.207372472f, 0.139820069f
};

static void testStretchAgainstBaseline()
{
    std::cout << "[test] processTDPSOLA: 1.5x stretch of 220 Hz voice-like signal\n";

    auto in = makeVoiceLike(220.0, 1.0, kSR);

    xleth::dsp::PSOLAParams p;
    p.sampleRate       = kSR;
    p.stretchRatio     = 1.5;
    p.pitchOffsetSemis = 0;
    p.pitchOffsetCents = 0;
    p.formantPreserve  = false;

    auto out = xleth::dsp::processTDPSOLA(in, p);
    maybeDump(out);

    std::printf("  len=%d rms=%.9g\n", out.getNumSamples(), bufferRMS(out));
    for (int i = 0; i < (int)(sizeof(kProbes) / sizeof(kProbes[0])); ++i) {
        if (kProbes[i] < out.getNumSamples())
            std::printf("  probe[%d] @%d = %.9g\n", i, kProbes[i], out.getReadPointer(0)[kProbes[i]]);
    }

    CHECK(out.getNumChannels() == 1, "stretch preserves channel count");
    CHECK(out.getNumSamples() == kBaselineStretchLen,
          "stretch length matches baseline (got " << out.getNumSamples()
          << ", want " << kBaselineStretchLen << ")");
    CHECK(std::abs(bufferRMS(out) - kBaselineStretchRMS) < kTol,
          "stretch RMS matches baseline (got " << bufferRMS(out)
          << ", want " << kBaselineStretchRMS << ")");

    if (out.getNumSamples() >= kProbes[5]) {
        const float* d = out.getReadPointer(0);
        for (int i = 0; i < (int)(sizeof(kProbes) / sizeof(kProbes[0])); ++i)
            CHECK(std::abs(d[kProbes[i]] - kBaselineProbes[i]) < kTol,
                  "probe " << i << " @" << kProbes[i] << " matches baseline (got "
                  << d[kProbes[i]] << ", want " << kBaselineProbes[i] << ")");
    }
}

// ── Short-input floor (StretchInputFloor.h) ──────────────────────────────────
// TDPSOLA varispeeds any input shorter than kMinDurSec instead of stretching it,
// which transposes it DOWN by the stretch ratio. ClipRenderCache avoids that by
// reading at least minStretchInputSamples() of source. These checks pin the
// documented floor to the implementation's real behaviour, so the two can't
// drift: below the floor the pitch MUST fall, at the floor it must not.
//
// Fundamental estimated by counting positive-going zero crossings over the
// steady middle of the output — crude, but the two cases here differ by a factor
// of the stretch ratio, so precision is not the issue.
static double estimateF0(const juce::AudioBuffer<float>& b, double sampleRate)
{
    const int n = b.getNumSamples();
    if (n < 16) return 0.0;
    const int lo = n / 4, hi = n - n / 4;   // skip OLA ramp-in/out
    const float* d = b.getReadPointer(0);
    int crossings = 0;
    for (int i = lo + 1; i < hi; ++i)
        if (d[i - 1] <= 0.0f && d[i] > 0.0f) ++crossings;
    const double spanSec = static_cast<double>(hi - lo) / sampleRate;
    return spanSec > 0.0 ? crossings / spanSec : 0.0;
}

static void testShortInputFloor()
{
    std::cout << "[test] StretchInputFloor: PSOLA floor is where varispeed stops\n";

    const int floorN = xleth::dsp::minStretchInputSamples(/*PSOLA*/1, kSR);
    CHECK(floorN == (int)std::lround(kSR * xleth::dsp::kPsolaMinInputSec),
          "floor matches kPsolaMinInputSec at this rate (got " << floorN << ")");

    const double f0     = 220.0;
    const double sratio = 4.0;

    xleth::dsp::PSOLAParams p;
    p.sampleRate       = kSR;
    p.stretchRatio     = sratio;
    p.pitchOffsetSemis = 0;
    p.pitchOffsetCents = 0;
    p.formantPreserve  = false;

    // One sample under the floor: the varispeed fallback fires and the output
    // sounds a factor of `sratio` lower. This is the bug the guard exists for.
    {
        auto in  = makeVoiceLike(f0, (floorN - 1) / kSR, kSR);
        auto out = xleth::dsp::processTDPSOLA(in, p);
        const double got = estimateF0(out, kSR);
        std::printf("  under floor (%d samples): f0 ~ %.1f Hz (expect ~%.1f)\n",
                    in.getNumSamples(), got, f0 / sratio);
        CHECK(got > 0.0 && got < f0 * 0.6,
              "below the floor PSOLA varispeeds (transposes down) — got " << got << " Hz");
    }

    // At the floor: the real PSOLA path runs and pitch is preserved. Feeding the
    // engine at least this much input is exactly what ClipRenderCache now does.
    {
        auto in  = makeVoiceLike(f0, floorN / kSR, kSR);
        auto out = xleth::dsp::processTDPSOLA(in, p);
        const double got = estimateF0(out, kSR);
        std::printf("  at floor (%d samples): f0 ~ %.1f Hz (expect ~%.1f)\n",
                    in.getNumSamples(), got, f0);
        CHECK(std::abs(got - f0) < f0 * 0.25,
              "at the floor PSOLA preserves pitch — got " << got << " Hz, want ~" << f0);
        CHECK(out.getNumSamples() == (int)std::lround(floorN * sratio),
              "at the floor output length is still input * ratio (got "
              << out.getNumSamples() << ")");
    }

    // The other engines' floors, so a renamed/retuned constant is caught here
    // rather than by ear months later.
    CHECK(xleth::dsp::minStretchInputSamples(/*RubberBand*/2, kSR) == 0,
          "RubberBand has no varispeed fallback -> floor 0");
    CHECK(xleth::dsp::minStretchInputSamples(/*WSOLA*/3, kSR) == xleth::dsp::kWsolaMinInputSamples,
          "WSOLA floor is one OLA window at unity pitch");
    CHECK(xleth::dsp::minStretchInputSamples(/*WSOLA*/3, kSR, 12.0)
              == 2 * xleth::dsp::kWsolaMinInputSamples,
          "WSOLA floor doubles an octave up (it resamples before windowing)");
    CHECK(xleth::dsp::minStretchInputSamples(/*PhaseVocoder*/4, kSR)
              == xleth::dsp::kPhaseVocoderMinInputSamples,
          "PhaseVocoder floor is one STFT frame");
    CHECK(xleth::dsp::minStretchInputSamples(/*WORLD*/5, kSR) == 0,
          "WORLD has no varispeed fallback -> floor 0");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_tdpsola ===\n";
    testStretchAgainstBaseline();
    testShortInputFloor();

    std::cout << "\npassed=" << g_passed << " failed=" << g_failed << "\n";
    if (g_failed > 0) { std::cout << "FAILED\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}

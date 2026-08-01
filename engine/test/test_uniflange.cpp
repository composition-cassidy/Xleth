// test_uniflange.cpp — UniFlangeEffect structural DSP tests
// Build: see engine/CMakeLists.txt target "test_uniflange"
// Run:   build\engine\Release\test_uniflange.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// These are the five unit-level tests from uniflange/UNIFLANGE_HANDOFF.md §10:
//   1. Cross-matrix exactness
//   2. Interpolator identity (LEGACY mode)
//   3. No-feedback flatness in time
//   4. Pan invariance (vs DEPTH/SPEED)
//   5. Delay-line bounds fuzz
//
// Per spec §10/§9.7: the UNKNOWN parameter maps (depth/speed/delay curves)
// are unfitted placeholders. These tests verify STRUCTURAL correctness of
// the topology (cross matrix, interpolation, no feedback, pan law shape,
// bounds safety) — NOT a null test against real Fruity Flangus renders.
// Do not add one here; §10 says explicitly not to chase a deep null yet.

#include "audio/UniFlangeEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <random>
#include <string>

// ─── Test harness ─────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << (msg) << "\n";      \
            ++g_failed;                                                        \
        }                                                                       \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), msg)

// ─── Buffer utilities ──────────────────────────────────────────────────────────

// Fills buf with a sine at freqHz, continuing phase across calls.
static void fillSine(juce::AudioBuffer<float>& buf, double freqHz, double amplitude,
                     double sampleRate, double& phase)
{
    const int ns = buf.getNumSamples();
    for (int s = 0; s < ns; ++s)
    {
        const float v = static_cast<float>(amplitude * std::sin(
            2.0 * juce::MathConstants<double>::pi * phase));
        buf.setSample(0, s, v);
        if (buf.getNumChannels() > 1)
            buf.setSample(1, s, v);
        phase += freqHz / sampleRate;
        if (phase >= 1.0) phase -= 1.0;
    }
}

static bool allFinite(const juce::AudioBuffer<float>& buf)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            if (!std::isfinite(p[s])) return false;
    }
    return true;
}

// ─── 1. Cross-matrix exactness ────────────────────────────────────────────────
// order=1/spread=100 gives voice0 panned exactly hard-left (gL=1, gR=0) and
// voice1 exactly hard-right, at very different delays (~0.65ms vs ~1.35ms at
// 44.1kHz -- see UniFlangeEffect::voiceLayout). Firing an impulse and reading
// a window after voice0 arrives but before voice1 does isolates a single
// hard-panned tap: wet_R in that window is 0 direct  ontribution, so
// out_L = wet_L, out_R = c*wet_L exactly, regardless of the (placeholder)
// voice gain/envelope scale -- spec §10.1.
static void testCrossMatrixExactness()
{
    std::cout << "  [cross-matrix exactness]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    UniFlangeEffect fx;
    fx.setParameterValue("order",  1.0f);
    fx.setParameterValue("depth",  0.0f);
    fx.setParameterValue("speed",  50.0f);
    fx.setParameterValue("delay",  0.0f);
    fx.setParameterValue("spread", 100.0f);
    fx.setParameterValue("cross",  -25.0f);
    fx.setParameterValue("dry",    0.0f);
    fx.setParameterValue("wet",    100.0f);
    fx.setParameterValue("mode",   0.0f); // LEGACY
    fx.prepareToPlay(kSR, kBS);

    juce::MidiBuffer midi;
    juce::AudioBuffer<float> buf(2, kBS);
    buf.clear();
    buf.setSample(0, 0, 1.0f);
    buf.setSample(1, 0, 1.0f);
    fx.processBlock(buf, midi);

    // voice0 arrives ~28.7 samples in; voice1 (hard-right, no L contribution
    // ever) arrives ~59.5 samples in. Window [20,40) sees only voice0.
    double sumL = 0.0, sumR = 0.0;
    for (int s = 20; s < 40; ++s)
    {
        sumL += buf.getSample(0, s);
        sumR += buf.getSample(1, s);
    }

    CHECK(std::abs(sumL) > 1.0e-6, "expected a nonzero left-tap arrival in the isolation window");
    const double ratio = sumR / sumL;
    CHECK_NEAR(ratio, -0.25, 1.0e-6, "out_R/out_L should equal CROSS/100 exactly (unnormalised cross)");
}

// ─── 2. Interpolator identity (LEGACY mode) ──────────────────────────────────
// With DEPTH=0 the LFO contributes nothing (multiplied by zero excursion),
// so voice0's tap sits at an exactly static fractional delay f. With
// spread=100 voice0 is hard-panned left (gL=1,gR=0) and cross=0, so channel L
// alone is voice0's isolated transfer function: gBase(order1) * |(1-f) +
// f*e^{-jw}|. Measuring RMS ratio over an EXACT integer number of cycles
// (freq and window length chosen so freq*windowSeconds is an integer) makes
// the RMS-of-a-sinusoid identity exact, so the only remaining error is
// float32 rounding -- hence 1e-4 rather than the spec's literal 1e-6, which
// assumes a float64 reference model (uniflange_ref.py), not this engine's
// float32 audio path.
static void testInterpolatorIdentityLegacy()
{
    std::cout << "  [interpolator identity, LEGACY mode]\n";
    constexpr double kSR      = 44100.0;
    constexpr int    kBS      = 512;
    constexpr double kFreqHz  = 1000.0;   // exact integer -> integer cycles per second
    constexpr double kAmp     = 0.2;

    UniFlangeEffect fx;
    fx.setParameterValue("order",  1.0f);
    fx.setParameterValue("depth",  0.0f);   // frozen -- no LFO excursion
    fx.setParameterValue("speed",  50.0f);  // irrelevant since depth=0
    fx.setParameterValue("delay",  0.0f);
    fx.setParameterValue("spread", 100.0f); // voice0 hard-left
    fx.setParameterValue("cross",  0.0f);
    fx.setParameterValue("dry",    0.0f);
    fx.setParameterValue("wet",    100.0f);
    fx.setParameterValue("mode",   0.0f);   // LEGACY
    fx.prepareToPlay(kSR, kBS);

    juce::MidiBuffer midi;
    double phase = 0.0;

    // Settle: presence envelope (~20ms one-pole) needs several time constants
    // to converge so it doesn't contaminate the amplitude measurement.
    {
        juce::AudioBuffer<float> lead(2, kBS);
        int remaining = static_cast<int>(kSR); // 1 second
        while (remaining > 0)
        {
            const int n = std::min(kBS, remaining);
            juce::AudioBuffer<float> block(2, n);
            fillSine(block, kFreqHz, kAmp, kSR, phase);
            fx.processBlock(block, midi);
            remaining -= n;
        }
    }

    // Measurement window: exactly kSR samples (1 second) -> an integer
    // number of cycles at any integer kFreqHz, so RMS = amplitude/sqrt(2)
    // exactly for an ideal sinusoid (no boundary-term bias).
    const int measureSamples = static_cast<int>(kSR);
    juce::AudioBuffer<float> measured(2, measureSamples);
    {
        int pos = 0;
        while (pos < measureSamples)
        {
            const int n = std::min(kBS, measureSamples - pos);
            juce::AudioBuffer<float> block(2, n);
            fillSine(block, kFreqHz, kAmp, kSR, phase);
            fx.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch)
                measured.copyFrom(ch, pos, block, ch, 0, n);
            pos += n;
        }
    }

    double sumSq = 0.0;
    const float* p = measured.getReadPointer(0);
    for (int i = 0; i < measureSamples; ++i)
        sumSq += static_cast<double>(p[i]) * static_cast<double>(p[i]);
    const double rmsOut = std::sqrt(sumSq / measureSamples);
    const double rmsIn  = kAmp / std::sqrt(2.0);
    const double measuredH = rmsOut / rmsIn;

    // Expected: voice0's frac = 0 (first slot, spacing term zeroed), so its
    // delay is exactly kVoiceBaseDelayMs regardless of the DELAY parameter.
    const double delaySamples = static_cast<double>(UniFlangeEffect::kVoiceBaseDelayMs) * 0.001 * kSR;
    const double f = delaySamples - std::floor(delaySamples);
    const double omega = 2.0 * juce::MathConstants<double>::pi * kFreqHz / kSR;
    const double reH = (1.0 - f) + f * std::cos(omega);
    const double imH = f * std::sin(omega);
    const double interp = std::sqrt(reH * reH + imH * imH);
    const double gBase = static_cast<double>(UniFlangeEffect::voiceGain(2));
    const double expectedH = gBase * interp;

    CHECK_NEAR(measuredH, expectedH, 1.0e-4,
        "LEGACY-mode tap transfer should equal gBase * |(1-f) + f*e^{-jw}|");
}

// ─── 3. No-feedback flatness in time ─────────────────────────────────────────
// With DEPTH=0 (frozen) and a steady sine, the whole signal path is a fixed
// LTI system. If a feedback path had crept in, |H| would drift with the
// growing/decaying comb as energy recirculates. Measuring RMS in two windows
// separated by several seconds and requiring them to match (after letting
// the ~20ms presence envelope fully settle first) catches that directly.
static void testNoFeedbackFlatness()
{
    std::cout << "  [no-feedback flatness in time]\n";
    constexpr double kSR     = 44100.0;
    constexpr int    kBS     = 512;
    constexpr double kFreqHz = 500.0;
    constexpr double kAmp    = 0.2;

    UniFlangeEffect fx;
    fx.setParameterValue("order",  2.0f);
    fx.setParameterValue("depth",  0.0f);   // frozen -- static delay per voice
    fx.setParameterValue("speed",  75.0f);  // irrelevant since depth=0
    fx.setParameterValue("delay",  50.0f);
    fx.setParameterValue("spread", 100.0f);
    fx.setParameterValue("cross",  -25.0f);
    fx.setParameterValue("dry",    0.0f);
    fx.setParameterValue("wet",    100.0f);
    fx.setParameterValue("mode",   0.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::MidiBuffer midi;
    double phase = 0.0;
    const int oneSecond = static_cast<int>(kSR);

    auto runSeconds = [&](int seconds)
    {
        int remaining = seconds * oneSecond;
        while (remaining > 0)
        {
            const int n = std::min(kBS, remaining);
            juce::AudioBuffer<float> block(2, n);
            fillSine(block, kFreqHz, kAmp, kSR, phase);
            fx.processBlock(block, midi);
            remaining -= n;
        }
    };

    auto measureOneSecond = [&]() -> double
    {
        juce::AudioBuffer<float> buf(2, oneSecond);
        int pos = 0;
        while (pos < oneSecond)
        {
            const int n = std::min(kBS, oneSecond - pos);
            juce::AudioBuffer<float> block(2, n);
            fillSine(block, kFreqHz, kAmp, kSR, phase);
            fx.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch)
                buf.copyFrom(ch, pos, block, ch, 0, n);
            pos += n;
        }
        double sumSq = 0.0;
        const float* p = buf.getReadPointer(0);
        for (int i = 0; i < oneSecond; ++i)
            sumSq += static_cast<double>(p[i]) * static_cast<double>(p[i]);
        return std::sqrt(sumSq / oneSecond);
    };

    runSeconds(1); // let the presence envelope fully settle (~50 time constants)
    const double rmsEarly = measureOneSecond();
    runSeconds(3); // idle gap, unmeasured
    const double rmsLate  = measureOneSecond();

    CHECK(rmsEarly > 1.0e-6, "expected nonzero wet output for the flatness probe");
    CHECK_NEAR(rmsEarly, rmsLate, 1.0e-5 * rmsEarly,
        "|H(f)| must stay flat over time -- any drift means a recirculating path crept in");
}

// ─── 4. Pan invariance ────────────────────────────────────────────────────────
// §4.5: pan is a function of voice index and SPREAD only. voiceLayout()'s
// signature doesn't even take a speed argument, so pan cannot depend on it
// structurally; this test additionally locks that DEPTH doesn't move it
// either, both via the pure layout function and end-to-end through the
// actual effect (an isolated-tap pan-ratio measurement, cross=0).
static void testPanInvariance()
{
    std::cout << "  [pan invariance vs DEPTH/SPEED]\n";

    // (a) Pure function: pans[] must be bit-identical across two different
    // DEPTH values at the same order/spread/delay.
    float centres1[8], depths1[8], phases1[8], pans1[8];
    float centres2[8], depths2[8], phases2[8], pans2[8];
    UniFlangeEffect::voiceLayout(8, 60.0f, 40.0f, 10.0f, centres1, depths1, phases1, pans1);
    UniFlangeEffect::voiceLayout(8, 60.0f, 40.0f, 90.0f, centres2, depths2, phases2, pans2);
    for (int i = 0; i < 8; ++i)
        CHECK_NEAR(pans1[i], pans2[i], 1.0e-6, "pan must not change when only DEPTH differs");

    // (b) End-to-end: render an isolated tap (order=1, partial spread so the
    // pan isn't hard-left/right, cross=0) at two different DEPTH/SPEED pairs
    // and compare the measured L/R ratio in the pre-second-tap window.
    auto measurePanRatio = [](float depthPct, float speedPct) -> double
    {
        constexpr double kSR = 44100.0;
        constexpr int    kBS = 256;

        UniFlangeEffect fx;
        fx.setParameterValue("order",  1.0f);
        fx.setParameterValue("depth",  depthPct);
        fx.setParameterValue("speed",  speedPct);
        fx.setParameterValue("delay",  30.0f);
        fx.setParameterValue("spread", 60.0f); // partial -- nontrivial pan ratio
        fx.setParameterValue("cross",  0.0f);
        fx.setParameterValue("dry",    0.0f);
        fx.setParameterValue("wet",    100.0f);
        fx.setParameterValue("mode",   0.0f);
        fx.prepareToPlay(kSR, kBS);

        juce::MidiBuffer midi;
        juce::AudioBuffer<float> buf(2, kBS);
        buf.clear();
        buf.setSample(0, 0, 1.0f);
        buf.setSample(1, 0, 1.0f);
        fx.processBlock(buf, midi);

        double sumL = 0.0, sumR = 0.0;
        for (int s = 0; s < 60; ++s) // well before voice1's arrival
        {
            sumL += buf.getSample(0, s);
            sumR += buf.getSample(1, s);
        }
        return sumR / sumL;
    };

    const double ratioA = measurePanRatio(0.0f, 10.0f);
    const double ratioB = measurePanRatio(100.0f, 90.0f);
    CHECK_NEAR(ratioA, ratioB, 1.0e-4,
        "measured pan ratio of an isolated tap must not change with DEPTH/SPEED");
}

// ─── 5. Delay-line bounds fuzz ───────────────────────────────────────────────
// DELAY/DEPTH/SPREAD at their extremes, ORDER at max (most voices active,
// most read-index arithmetic per sample), across several sample rates,
// CROSS/DRY/WET at their extremes too, in both LEGACY and HQ mode. The only
// assertion is that output stays finite -- an escaped read index would
// eventually pull from uninitialised/stale memory and produce NaN/Inf.
static void testBoundsFuzz()
{
    std::cout << "  [delay-line bounds fuzz]\n";
    const double sampleRates[] = { 44100.0, 48000.0, 88200.0, 96000.0, 192000.0 };
    const float  extremes[]    = { 0.0f, 100.0f };
    const float  modes[]       = { 0.0f, 1.0f };
    constexpr int kBS = 512;

    for (double sr : sampleRates)
    {
        for (float delay : extremes)
        for (float depth : extremes)
        for (float spread : extremes)
        for (float mode : modes)
        {
            UniFlangeEffect fx;
            fx.setParameterValue("order",  8.0f);   // max voices
            fx.setParameterValue("depth",  depth);
            fx.setParameterValue("speed",  100.0f);
            fx.setParameterValue("delay",  delay);
            fx.setParameterValue("spread", spread);
            fx.setParameterValue("cross",  100.0f);
            fx.setParameterValue("dry",    -100.0f);
            fx.setParameterValue("wet",    100.0f);
            fx.setParameterValue("mode",   mode);
            fx.prepareToPlay(sr, kBS);

            juce::MidiBuffer midi;
            std::mt19937 rng(12345);
            std::uniform_real_distribution<float> dist(-1.0f, 1.0f);

            bool ok = true;
            for (int block = 0; block < 50 && ok; ++block)
            {
                juce::AudioBuffer<float> buf(2, kBS);
                for (int ch = 0; ch < 2; ++ch)
                    for (int s = 0; s < kBS; ++s)
                        buf.setSample(ch, s, dist(rng));
                fx.processBlock(buf, midi);
                if (!allFinite(buf)) ok = false;
            }

            CHECK(ok, "uniflange output must stay finite at sr=" + std::to_string(sr)
                + " delay=" + std::to_string(delay) + " depth=" + std::to_string(depth)
                + " spread=" + std::to_string(spread) + " mode=" + std::to_string(mode));
        }
    }
}

// ─── 6. Dry/Wet zero -> silence (regression probe) ───────────────────────────
// Reported bug: dry=0/wet=0 still passes the dry signal at full level. Drive a
// nonzero, non-impulse signal (a sine, so every sample in the measured window
// is nonzero) through the effect at dry=0/wet=0 and require digital silence;
// then at dry=100/wet=0 require bit-transparent passthrough.
static void testDryWetZeroSilence()
{
    std::cout << "  [dry/wet zero -> silence]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    {
        UniFlangeEffect fx;
        fx.setParameterValue("order",  4.0f);
        fx.setParameterValue("depth",  50.0f);
        fx.setParameterValue("speed",  50.0f);
        fx.setParameterValue("delay",  0.0f);
        fx.setParameterValue("spread", 100.0f);
        fx.setParameterValue("cross",  0.0f);
        fx.setParameterValue("dry",    0.0f);
        fx.setParameterValue("wet",    0.0f);
        fx.setParameterValue("mode",   0.0f);
        fx.prepareToPlay(kSR, kBS);

        juce::MidiBuffer midi;
        double phase = 0.0;
        float maxAbs = 0.0f;
        // Several blocks so the presence envelope and smoothers are well past
        // their initial ramp -- a leaking dry signal must show up here.
        for (int block = 0; block < 20; ++block)
        {
            juce::AudioBuffer<float> buf(2, kBS);
            fillSine(buf, 500.0, 0.5, kSR, phase);
            fx.processBlock(buf, midi);
            for (int ch = 0; ch < 2; ++ch)
            {
                const float* p = buf.getReadPointer(ch);
                for (int s = 0; s < kBS; ++s)
                    maxAbs = std::max(maxAbs, std::abs(p[s]));
            }
        }
        CHECK(maxAbs < 1.0e-6f, "dry=0/wet=0 must produce digital silence, got peak " + std::to_string(maxAbs));
    }

    {
        UniFlangeEffect fx;
        fx.setParameterValue("order",  4.0f);
        fx.setParameterValue("depth",  50.0f);
        fx.setParameterValue("speed",  50.0f);
        fx.setParameterValue("delay",  0.0f);
        fx.setParameterValue("spread", 100.0f);
        fx.setParameterValue("cross",  0.0f);
        fx.setParameterValue("dry",    100.0f);
        fx.setParameterValue("wet",    0.0f);
        fx.setParameterValue("mode",   0.0f);
        fx.prepareToPlay(kSR, kBS);

        juce::MidiBuffer midi;
        double phase = 0.0;
        double maxDiff = 0.0;
        for (int block = 0; block < 20; ++block)
        {
            juce::AudioBuffer<float> input(2, kBS);
            fillSine(input, 500.0, 0.5, kSR, phase);
            juce::AudioBuffer<float> buf;
            buf.makeCopyOf(input);
            fx.processBlock(buf, midi);
            for (int ch = 0; ch < 2; ++ch)
            {
                const float* in  = input.getReadPointer(ch);
                const float* out = buf.getReadPointer(ch);
                for (int s = 0; s < kBS; ++s)
                    maxDiff = std::max(maxDiff, static_cast<double>(std::abs(out[s] - in[s])));
            }
        }
        CHECK(maxDiff < 1.0e-5, "dry=100/wet=0 must be bit-transparent passthrough, max diff " + std::to_string(maxDiff));
    }
}

// ─── Bonus: parameter layout sanity ──────────────────────────────────────────
// Not one of the five spec'd tests, but a cheap regression guard matching the
// convention in test_reverb.cpp's testReverbLayout().
static void testParameterLayout()
{
    std::cout << "  [parameter layout]\n";
    UniFlangeEffect fx;

    CHECK(fx.setParameterValue("order",  4.0f),   "order param should exist");
    CHECK(fx.setParameterValue("depth",  50.0f),  "depth param should exist");
    CHECK(fx.setParameterValue("speed",  50.0f),  "speed param should exist");
    CHECK(fx.setParameterValue("delay",  0.0f),   "delay param should exist");
    CHECK(fx.setParameterValue("spread", 100.0f), "spread param should exist");
    CHECK(fx.setParameterValue("cross",  -25.0f), "cross param should exist");
    CHECK(fx.setParameterValue("dry",    0.0f),   "dry param should exist");
    CHECK(fx.setParameterValue("wet",    100.0f), "wet param should exist");
    CHECK(fx.setParameterValue("mode",   1.0f),   "mode param should exist");
}

// ─── main ─────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_uniflange ===\n";

    testParameterLayout();
    testCrossMatrixExactness();
    testInterpolatorIdentityLegacy();
    testNoFeedbackFlatness();
    testPanInvariance();
    testBoundsFuzz();
    testDryWetZeroSilence();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}

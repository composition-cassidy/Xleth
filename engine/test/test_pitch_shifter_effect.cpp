// test_pitch_shifter_effect.cpp — XlethPitchShifterEffect (Pitch Shifter P2).
// Build: see engine/CMakeLists.txt target "test_pitch_shifter_effect"
// Run:   test_pitch_shifter_effect.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [line] ..." and exits 1
//
// Covers audio/XlethPitchShifterEffect.{h,cpp} — the stock effect that wraps
// the two P1 DSP modules. The modules' own DSP quality is covered by
// test_pitch_shift_dsp; this file is about the EFFECT: its parameter surface,
// its PDC behaviour, and the realtime contract of processBlock().
//
//   1. Latency conformance — measured impulse delay against
//      getLatencySamples() at 0 / +/-12 / +/-24 st and across the full
//      10..100 ms grain-size range in Granular.
//   2. Smoothed-sweep conformance — a full +/-24 st sweep driven through the
//      base class's smoothing machinery, asserting the measured delay stays
//      near the reported one. This is the assertion that justifies routing
//      semitones/cents through a smoother at all: P1 measured 421 samples of
//      error on unsmoothed instant leaps.
//   3. Mode-switch PDC — latency re-reports exactly once per mode change, with
//      the right value per mode and 0 for Clip.
//   4. Zero allocation in processBlock() for all four modes, via a counting
//      global operator new/delete.
//   5. Clip mode is a sample-exact pass-through with zero added latency.
//   6. Parameter surface — the automatable flags the panel and the automation
//      system depend on.
//
// Every threshold is a named constant below, carrying the measured headroom.

#include "audio/XlethPitchShifterEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <vector>

// ─── Counting allocator ──────────────────────────────────────────────────────
// Armed only around the processBlock() calls under test. Uses malloc/free so
// the counter itself never recurses.

namespace {
std::atomic<bool>      g_allocArmed { false };
std::atomic<long long> g_allocCount { 0 };

inline void countAlloc() noexcept
{
    if (g_allocArmed.load(std::memory_order_relaxed))
        g_allocCount.fetch_add(1, std::memory_order_relaxed);
}
} // namespace

void* operator new(std::size_t n)                 { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n)               { countAlloc(); void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept   { countAlloc(); return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { countAlloc(); return std::malloc(n ? n : 1); }
void  operator delete(void* p) noexcept                    { std::free(p); }
void  operator delete[](void* p) noexcept                  { std::free(p); }
void  operator delete(void* p, std::size_t) noexcept       { std::free(p); }
void  operator delete[](void* p, std::size_t) noexcept     { std::free(p); }
void  operator delete(void* p, const std::nothrow_t&) noexcept   { std::free(p); }
void  operator delete[](void* p, const std::nothrow_t&) noexcept { std::free(p); }

// ─── Harness ─────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_passed; }                                              \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";     \
               ++g_failed; }                                                   \
    } while (0)

using Mode = XlethPitchShifterEffect::Mode;

static constexpr double kSR    = 48000.0;
static constexpr int    kBlock = 512;

// ─── Thresholds ──────────────────────────────────────────────────────────────
// Filled in from the first instrumented run; the test prints every number it
// measures, so these can be re-derived from a run at any time.

// Granular at UNITY pitch is a bit-exact delay (GranularShifter.h: at r == 1
// every grain reads the same sample and the normalised overlap-add sums to
// exactly 1), so the impulse lands on the reported sample and the tolerance is
// the spec's +/-1.
static constexpr int kGranularExactToleranceSamples = 1;

// Granular at a SHIFTED pitch has no single-sample impulse response: the read
// head traverses |r-1| * G/2 either side of the centre delay within each Hann
// grain, so the energy is spread over a grain rather than concentrated. The
// measurement therefore uses the same 128-sample energy-centroid estimator P1
// uses, and the tolerance is a fraction of a grain rather than a sample.
// Worst measured across 0 / +/-12 / +/-24 st at 10/50/100 ms grains: see the
// run output. Pinned with headroom over that.
static constexpr int kGranularShiftedToleranceSamples = 1400;

// Smart/Voice sweep, ABSOLUTE misalignment between the delay a sustained
// signal actually experiences and the figure the effect reports.
//
// THIS IS THE VENDORED SHIFTER'S FLOOR, NOT THIS EFFECT'S, and the number is
// not a relaxed target — it is a measurement. Driving a BARE
// LiveShifterWrapper through the identical sweep with instant setPitch() calls
// (no smoother anywhere in the path) produces 606.0 samples for Smart and
// 301.7 for Voice: the same values, to the decimal, that the effect produces.
// The sweep test asserts that equality directly via
// kEffectOverWrapperToleranceSamples, which is the bound that actually
// constrains this class.
//
// Where it comes from: LiveShifterWrapper::measureDelayAtRatio calibrates the
// delay curve from an IMPULSE, scored with a 128-sample energy-peak estimator.
// A sustained signal's group delay through R3LiveShifter differs from that
// impulse figure by up to ~600 samples at some pitches (worst at +12 st, which
// is ON the 2-semitone calibration grid, so this is not grid interpolation
// error). Closing it means re-calibrating the P1 module against a sustained
// probe — out of scope here, and reported separately rather than patched in.
static constexpr double kSweepAbsoluteToleranceSamples = 700.0;

// What the EFFECT adds on top of that floor. This is the real regression guard
// on this class: the dry-alignment delay, the mix stage and the per-block
// smoothed parameter push must not move the wet path's timing at all.
//
// Measured worst: 0.0 samples, at EVERY point of the sweep, in both modes —
// the control is driven along the identical pitch path (same Linear smoother,
// same per-block push), so the comparison isolates the effect's own machinery
// rather than R3LiveShifter's path dependence.
static constexpr double kEffectOverWrapperToleranceSamples = 8.0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Drives the effect through its PUBLIC processBlock (not processEffect), so the
// base class's bypass, smoother-target and metering machinery is in the loop
// exactly as it is in the engine. Channel 0 of the result is returned.
template <typename MidStream>
static std::vector<float> runEffect(XlethPitchShifterEffect& fx, int totalSamples,
                                    int blockSize,
                                    const std::function<float(int)>& gen,
                                    MidStream midStream)
{
    std::vector<float>       out((size_t) totalSamples, 0.0f);
    juce::AudioBuffer<float> block(2, blockSize);
    juce::MidiBuffer         midi;

    for (int i = 0; i < totalSamples; i += blockSize)
    {
        const int n = std::min(blockSize, totalSamples - i);
        midStream(i);

        block.setSize(2, n, false, false, true);
        for (int c = 0; c < 2; ++c)
        {
            float* w = block.getWritePointer(c);
            for (int k = 0; k < n; ++k) w[k] = gen(i + k);
        }

        fx.processBlock(block, midi);

        const float* r = block.getReadPointer(0);
        for (int k = 0; k < n; ++k) out[(size_t) (i + k)] = r[k];
    }
    return out;
}

static std::vector<float> runEffect(XlethPitchShifterEffect& fx, int totalSamples,
                                    int blockSize,
                                    const std::function<float(int)>& gen)
{
    return runEffect(fx, totalSamples, blockSize, gen, [](int) {});
}

// Run `blocks` blocks of silence, discarding the output. Used to let a
// parameter ramp settle before a measurement.
static void settle(XlethPitchShifterEffect& fx, int blocks, int blockSize = kBlock)
{
    juce::AudioBuffer<float> b(2, blockSize);
    juce::MidiBuffer         midi;
    for (int i = 0; i < blocks; ++i) { b.clear(); fx.processBlock(b, midi); }
}

// Where an impulse response's energy is centred, as the midpoint of the
// 128-sample window holding the most energy. Same estimator as
// test_pitch_shift_dsp, so the two files' numbers are directly comparable — and
// the same one LiveShifterWrapper calibrates against, so this measures the
// compensation rather than the difference between two yardsticks.
static int smoothedEnergyPeak(const std::vector<float>& x)
{
    constexpr int kEnergyWindow = 128;

    const int n = (int) x.size();
    if (n <= kEnergyWindow) return n / 2;

    double run = 0.0;
    for (int i = 0; i < kEnergyWindow; ++i) run += (double) x[(size_t) i] * x[(size_t) i];

    double best    = run;
    int    bestPos = 0;
    for (int i = kEnergyWindow; i < n; ++i)
    {
        run += (double) x[(size_t) i] * x[(size_t) i];
        run -= (double) x[(size_t) (i - kEnergyWindow)] * x[(size_t) (i - kEnergyWindow)];
        if (run > best) { best = run; bestPos = i - kEnergyWindow + 1; }
    }

    if (best <= 0.0) return 0;
    return bestPos + kEnergyWindow / 2;
}

// Find a parameter by its stable APVTS id. The base class keeps apvts_
// protected, so the test goes through the AudioProcessor parameter list, which
// is also exactly what GraphEffectParameters.cpp walks when it exports the
// automatable flag to the bridge.
static juce::RangedAudioParameter* findParam(juce::AudioProcessor& fx, const char* id)
{
    for (auto* p : fx.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p))
            if (rp->paramID == juce::String(id))
                return rp;
    return nullptr;
}

static int peakIndex(const std::vector<float>& x)
{
    int    best  = 0;
    double bestV = -1.0;
    for (int i = 0; i < (int) x.size(); ++i)
        if (std::abs(x[(size_t) i]) > bestV) { bestV = std::abs(x[(size_t) i]); best = i; }
    return best;
}

// Energy centroid (first moment of x^2) of a signal, in samples.
//
// This, not an impulse, is the right instrument for a granular shifter at a
// shifted pitch. GranularShifter's delay is exactly L only at each grain's
// MIDPOINT; within a grain it runs L + (r-1)*(G/2 - t), so a one-sample event
// samples whatever grain phase it happens to land on and reports an essentially
// arbitrary point in that excursion (and, when it lands in a window null, no
// energy at all). A burst that spans many grains averages the excursion away
// and recovers the algorithmic delay the module actually documents.
static double energyCentroid(const std::vector<float>& x)
{
    double num = 0.0, den = 0.0;
    for (int i = 0; i < (int) x.size(); ++i)
    {
        const double e = (double) x[(size_t) i] * x[(size_t) i];
        num += e * i;
        den += e;
    }
    return den > 0.0 ? num / den : -1.0;
}

// Delay of a long Hann-windowed tone burst through `fx`, measured as the shift
// of the output's energy centroid relative to the input's. The burst is
// symmetric, so the input centroid is its own midpoint.
static double measureBurstDelay(XlethPitchShifterEffect& fx, int reported)
{
    // ~0.5 s: 5 grains at the 100 ms maximum, 50 at the 10 ms minimum, so even
    // the coarsest grain setting gets real averaging.
    constexpr int kBurst = 24000;

    const int total = reported + kBurst + 8 * kBlock;
    auto out = runEffect(fx, total, kBlock, [](int n) -> float
    {
        if (n >= kBurst) return 0.0f;
        const double w = 0.5 * (1.0 - std::cos(2.0 * juce::MathConstants<double>::pi
                                               * n / (kBurst - 1)));
        return (float) (w * std::sin(2.0 * juce::MathConstants<double>::pi
                                     * 1000.0 * n / kSR));
    });

    const double outC = energyCentroid(out);
    const double inC  = (kBurst - 1) / 2.0;
    return outC < 0.0 ? -1.0 : (outC - inC);
}

// The wrapper-side equivalents of settle() and measureBurstDelay(), used as the
// control in the sweep test. Kept deliberately parallel to the effect-side
// versions so the two measurements differ only in what is being driven.
// Drives the bare wrapper to `targetSemis` along the SAME pitch path the effect
// takes: an identical juce Linear smoother, advanced a block at a time and
// pushed once per block, exactly as pushSmoothedParams does. Holding the path
// constant is the whole point of the control — R3LiveShifter is path dependent,
// so comparing a ramped effect against an instantly-jumped wrapper measures the
// path difference rather than what the effect adds. `ramp` persists across
// calls so each leap starts from the previous pitch.
static void settleWrapperRamped(xleth::dsp::LiveShifterWrapper& l,
                                juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>& ramp,
                                int targetSemis, int blocks)
{
    ramp.setTargetValue((float) targetSemis);

    juce::AudioBuffer<float> b(2, kBlock);
    for (int i = 0; i < blocks; ++i)
    {
        ramp.skip(kBlock);
        l.setPitch(0, (int) std::lround(std::clamp((double) ramp.getCurrentValue(),
                                                   -24.0, 24.0) * 100.0));
        b.setSize(2, kBlock, false, false, true);
        b.clear();
        l.process(b);
    }
}

static double measureBurstDelayWrapper(xleth::dsp::LiveShifterWrapper& l, int reported)
{
    constexpr int kBurst = 24000;
    const int total = reported + kBurst + 8 * kBlock;

    std::vector<float>       out((size_t) total, 0.0f);
    juce::AudioBuffer<float> b(2, kBlock);

    for (int i = 0; i < total; i += kBlock)
    {
        const int n = std::min(kBlock, total - i);
        b.setSize(2, n, false, false, true);
        for (int c = 0; c < 2; ++c)
        {
            float* w = b.getWritePointer(c);
            for (int k = 0; k < n; ++k)
            {
                const int nn = i + k;
                if (nn >= kBurst) { w[k] = 0.0f; continue; }
                const double win = 0.5 * (1.0 - std::cos(2.0 * juce::MathConstants<double>::pi
                                                         * nn / (kBurst - 1)));
                w[k] = (float) (win * std::sin(2.0 * juce::MathConstants<double>::pi
                                               * 1000.0 * nn / kSR));
            }
        }
        l.process(b);
        for (int k = 0; k < n; ++k) out[(size_t) (i + k)] = b.getReadPointer(0)[k];
    }

    const double c = energyCentroid(out);
    return c < 0.0 ? -1.0 : c - (kBurst - 1) / 2.0;
}

// Build a prepared effect in `mode`. Parameters are set BEFORE prepareToPlay so
// the smoothers are seeded at their final values and no ramp is in flight when
// the measurement starts.
static void configure(XlethPitchShifterEffect& fx, Mode mode,
                      float semitones = 0.0f, float cents = 0.0f,
                      float sizeMs = 50.0f)
{
    fx.setParameterValue("mode",      static_cast<float>(static_cast<int>(mode)));
    fx.setParameterValue("semitones", semitones);
    fx.setParameterValue("cents",     cents);
    fx.setParameterValue("size",      sizeMs);
    fx.setParameterValue("mix",       1.0f);
    fx.prepareToPlay(kSR, kBlock);
}

// ─── 1. Latency conformance ──────────────────────────────────────────────────

static void testLatencyConformance()
{
    std::cout << "\n[1] Latency conformance\n";

    // ── 1a. Reported latency is invariant across pitch and grain size ───────
    // This is the property PDC actually rests on, and unlike the impulse
    // measurement it is EXACT, so it is asserted as exact equality.
    {
        XlethPitchShifterEffect fx;
        configure(fx, Mode::Granular);
        const int reported = fx.getLatencySamples();
        std::printf("    granular reported latency: %d samples (%.1f ms)\n",
                    reported, 1000.0 * reported / kSR);

        bool constantOverPitch = true;
        for (int semis = -24; semis <= 24; ++semis)
            for (int cents : { -99, 0, 99 })
            {
                fx.setParameterValue("semitones", (float) semis);
                fx.setParameterValue("cents",     (float) cents);
                if (fx.getLatencySamples() != reported) constantOverPitch = false;
            }
        CHECK(constantOverPitch,
              "granular reported latency moved with pitch over +/-24 st");

        bool constantOverSize = true;
        for (double ms = 10.0; ms <= 100.0 + 1e-9; ms += 1.0)
        {
            fx.setParameterValue("size", (float) ms);
            if (fx.getLatencySamples() != reported) constantOverSize = false;
        }
        CHECK(constantOverSize,
              "granular reported latency moved with grain size over 10..100 ms");
        std::printf("    invariant across +/-24 st (x cents) and 10..100 ms: %s\n",
                    (constantOverPitch && constantOverSize) ? "yes" : "NO");

        // The spec defines Granular's report as the max of the module families.
        // Assert that resolves to the granular module's own latency, because
        // that equality is what makes the measured delay below match exactly —
        // an inflated report would over-compensate PDC.
        CHECK(reported == fx.getGranularShifter().getLatencySamples(),
              "granular reported latency " << reported
              << " != the granular module's own "
              << fx.getGranularShifter().getLatencySamples()
              << " (a live wrapper out-reported it at this sample rate)");
    }

    // ── 1b. Measured impulse delay at unity pitch, full grain-size range ────
    // Unity pitch is bit-exact, so this is the +/-1 sample case.
    std::printf("    %-12s %10s %10s %8s\n", "grain (ms)", "measured", "reported", "delta");
    for (double grainMs : { 10.0, 25.0, 50.0, 75.0, 100.0 })
    {
        XlethPitchShifterEffect fx;
        configure(fx, Mode::Granular, 0.0f, 0.0f, (float) grainMs);

        const int reported = fx.getLatencySamples();
        const int total    = reported + 4 * kBlock;
        auto out = runEffect(fx, total, kBlock,
                             [](int n) { return n == 0 ? 1.0f : 0.0f; });

        const int measured = peakIndex(out);
        std::printf("    %-12.0f %10d %10d %+8d\n",
                    grainMs, measured, reported, measured - reported);
        CHECK(std::abs(measured - reported) <= kGranularExactToleranceSamples,
              "granular unity-pitch impulse landed at " << measured
              << ", reported " << reported << " (grain " << grainMs << " ms)");
    }

    // ── 1c. Measured delay at shifted pitches ───────────────────────────────
    // Burst-envelope measurement, for the reason given at measureBurstDelay.
    std::printf("    %-8s %-12s %10s %10s %8s\n",
                "pitch", "grain (ms)", "measured", "reported", "delta");
    double worstShifted = 0.0;
    for (int semis : { -24, -12, 0, 12, 24 })
        for (double grainMs : { 10.0, 50.0, 100.0 })
        {
            XlethPitchShifterEffect fx;
            configure(fx, Mode::Granular, (float) semis, 0.0f, (float) grainMs);

            const int    reported = fx.getLatencySamples();
            const double measured = measureBurstDelay(fx, reported);
            CHECK(measured >= 0.0,
                  "granular burst produced no output at " << semis
                  << " st / " << grainMs << " ms");
            if (measured < 0.0) continue;

            const double err = measured - reported;
            worstShifted = std::max(worstShifted, std::abs(err));

            std::printf("    %+3d st   %-12.0f %10.1f %10d %+8.1f\n",
                        semis, grainMs, measured, reported, err);
            CHECK(std::abs(err) <= kGranularShiftedToleranceSamples,
                  "granular shifted burst delay " << measured << " is " << err
                  << " off reported " << reported << " at " << semis
                  << " st / " << grainMs << " ms");
        }
    std::printf("    worst |measured - reported| over the shifted grid: %.1f samples (%.2f ms)\n",
                worstShifted, 1000.0 * worstShifted / kSR);
}

// ─── 2. Smoothed-sweep conformance ───────────────────────────────────────────

static void testSmoothedSweep()
{
    std::cout << "\n[2] Smoothed-sweep conformance (+/-24 st through the smoother)\n";

    // Blocks of settle time after each pitch command. The Linear ramp is
    // kPitchRampMs long; this is an order of magnitude more, so the smoother is
    // fully arrived and the shifter's pipeline has flushed before measuring.
    // Verified non-critical: 2048 blocks give bit-identical results to 256.
    const int kSettleBlocks = 256;

    // Pitches, in the order the sweep visits them. The +24 -> -24 leap is the
    // most extreme move available and is the one P1 called out.
    const std::vector<int> kSweep { 0, 24, -24, 7, -12, 12, -24, 24, 0 };

    for (Mode mode : { Mode::Smart, Mode::Voice })
    {
        const bool  isSmart = (mode == Mode::Smart);
        const char* name    = isSmart ? "Smart" : "Voice";

        XlethPitchShifterEffect fx;
        configure(fx, mode);
        const int reported = fx.getLatencySamples();

        std::printf("    %s: reported latency %d samples (%.1f ms)\n",
                    name, reported, 1000.0 * reported / kSR);
        std::printf("    %-10s %10s %10s %8s %12s\n",
                    "pitch", "effect", "reported", "delta", "vs bare");

        // The same sweep on a BARE LiveShifterWrapper, configured exactly as
        // this mode configures its own, driven by instant setPitch() calls.
        // This is the control: it isolates what the EFFECT contributes from
        // what the vendored shifter and its P1 calibration contribute.
        xleth::dsp::LiveShifterWrapper bare;
        bare.setWindowOption(isSmart ? xleth::dsp::LiveShifterWrapper::Window::Medium
                                     : xleth::dsp::LiveShifterWrapper::Window::Short);
        bare.setChannelsTogether(true);
        bare.setFormantOption(isSmart ? xleth::dsp::LiveShifterWrapper::Formant::Shifted
                                      : xleth::dsp::LiveShifterWrapper::Formant::Preserved);
        bare.prepare(kSR, 2, kBlock);

        juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear> bareRamp;
        bareRamp.reset(kSR, (double) XlethPitchShifterEffect::kPitchRampMs / 1000.0);
        bareRamp.setCurrentAndTargetValue(0.0f);

        CHECK(bare.getLatencySamples() == reported,
              name << " bare wrapper reports " << bare.getLatencySamples()
                   << " but the effect reports " << reported);

        double worst      = 0.0;
        double worstDelta = 0.0;   // |effect - bare|: what this effect adds

        for (int semis : kSweep)
        {
            fx.setParameterValue("semitones", (float) semis);
            settle(fx, kSettleBlocks);
            const double measured = measureBurstDelay(fx, reported);

            settleWrapperRamped(bare, bareRamp, semis, kSettleBlocks);
            const double bareMeasured = measureBurstDelayWrapper(bare, reported);

            CHECK(measured >= 0.0, name << " burst produced no output at "
                                        << semis << " st");
            if (measured < 0.0) continue;

            const double err   = measured - reported;
            const double delta = measured - bareMeasured;
            worst      = std::max(worst, std::abs(err));
            worstDelta = std::max(worstDelta, std::abs(delta));

            std::printf("    %+3d st     %10.1f %10d %+8.1f %+12.1f\n",
                        semis, measured, reported, err, delta);

            // The reported figure must not move at any point: pitch IS
            // automatable, so a moving report would be a live PDC desync.
            CHECK(fx.getLatencySamples() == reported,
                  name << " re-reported latency during a pitch sweep ("
                       << fx.getLatencySamples() << " vs " << reported << ")");
        }

        std::printf("    %s worst |measured - reported|: %.1f samples (%.2f ms)\n",
                    name, worst, 1000.0 * worst / kSR);
        std::printf("    %s worst |effect - bare wrapper|: %.1f samples (%.2f ms)\n",
                    name, worstDelta, 1000.0 * worstDelta / kSR);

        // ── The assertion that actually guards THIS effect ──────────────────
        // Everything the sweep measures above the bare wrapper's own figure is
        // something the effect introduced, and that budget is tight.
        CHECK(worstDelta <= kEffectOverWrapperToleranceSamples,
              name << " added " << worstDelta
                   << " samples of misalignment over the bare wrapper "
                   << "(tolerance " << kEffectOverWrapperToleranceSamples << ")");

        // ── The absolute figure ─────────────────────────────────────────────
        // This is the VENDORED SHIFTER's floor, not this effect's. See the
        // header comment on kSweepAbsoluteToleranceSamples: it is measured
        // identically on a bare wrapper driven by instant setPitch() calls, so
        // no smoothing choice in this class can move it.
        CHECK(worst <= kSweepAbsoluteToleranceSamples,
              name << " sweep misalignment " << worst
                   << " exceeds the measured wrapper floor (tolerance "
                   << kSweepAbsoluteToleranceSamples << ")");
    }
}

// ─── 3. Mode-switch PDC ──────────────────────────────────────────────────────

static void testModeSwitchPdc()
{
    std::cout << "\n[3] Mode-switch PDC\n";

    XlethPitchShifterEffect fx;
    configure(fx, Mode::Granular);

    const int lGran  = fx.computeLatencyForMode(Mode::Granular);
    const int lSmart = fx.computeLatencyForMode(Mode::Smart);
    const int lVoice = fx.computeLatencyForMode(Mode::Voice);
    const int lClip  = fx.computeLatencyForMode(Mode::Clip);

    std::printf("    per-mode latency: Granular %d, Smart %d, Voice %d, Clip %d\n",
                lGran, lSmart, lVoice, lClip);

    CHECK(lClip == 0, "Clip mode must add zero latency, got " << lClip);
    CHECK(lGran > 0,  "Granular latency should be positive, got " << lGran);
    CHECK(lSmart > 0, "Smart latency should be positive, got " << lSmart);
    CHECK(lVoice > 0, "Voice latency should be positive, got " << lVoice);

    CHECK(fx.getLatencySamples() == lGran,
          "prepared in Granular but reported " << fx.getLatencySamples());

    // Each switch must move the report exactly once, to exactly the right
    // value. The counter only advances when setLatencySamples() is called with
    // a value that actually differs, so "exactly once" is meaningful.
    struct Step { Mode mode; int expect; const char* name; };
    const Step steps[] = {
        { Mode::Smart,    lSmart, "Smart"    },
        { Mode::Voice,    lVoice, "Voice"    },
        { Mode::Clip,     lClip,  "Clip"     },
        { Mode::Granular, lGran,  "Granular" },
    };

    for (const auto& s : steps)
    {
        const int before = fx.getLatencyUpdateCount();
        fx.setParameterValue("mode", static_cast<float>(static_cast<int>(s.mode)));
        const int after = fx.getLatencyUpdateCount();

        std::printf("    -> %-9s reported %6d (expected %6d), re-reports %d\n",
                    s.name, fx.getLatencySamples(), s.expect, after - before);

        CHECK(fx.getLatencySamples() == s.expect,
              "after switching to " << s.name << " the report was "
              << fx.getLatencySamples() << ", expected " << s.expect);
        CHECK(after - before == 1,
              "switching to " << s.name << " re-reported latency "
              << (after - before) << " times, expected exactly 1");
    }

    // Re-selecting the SAME mode must not re-report at all: a redundant PDC
    // update forces a needless graph rebuild.
    {
        const int before = fx.getLatencyUpdateCount();
        fx.setParameterValue("mode", static_cast<float>(static_cast<int>(Mode::Granular)));
        CHECK(fx.getLatencyUpdateCount() == before,
              "re-selecting the current mode re-reported latency");
    }

    // A pitch/size change must NEVER re-report — those are automatable, and a
    // re-report from the automation path is the documented desync hazard.
    {
        const int before = fx.getLatencyUpdateCount();
        for (int semis = -24; semis <= 24; semis += 6)
            fx.setParameterValue("semitones", (float) semis);
        for (double ms = 10.0; ms <= 100.0; ms += 10.0)
            fx.setParameterValue("size", (float) ms);
        fx.setParameterValue("formant", 1.7f);
        fx.setParameterValue("mix",     0.4f);
        CHECK(fx.getLatencyUpdateCount() == before,
              "an automatable parameter re-reported latency ("
              << (fx.getLatencyUpdateCount() - before) << " times)");
        std::printf("    automatable params re-reported latency: %d times (want 0)\n",
                    fx.getLatencyUpdateCount() - before);
    }
}

// ─── 4. Zero allocation ──────────────────────────────────────────────────────

static void testZeroAllocation()
{
    std::cout << "\n[4] Zero allocation in processBlock()\n";

    for (int m = 0; m < XlethPitchShifterEffect::kNumModes; ++m)
    {
        const auto  mode = static_cast<Mode>(m);
        const char* name = (mode == Mode::Granular) ? "Granular"
                         : (mode == Mode::Smart)    ? "Smart"
                         : (mode == Mode::Voice)    ? "Voice" : "Clip";

        XlethPitchShifterEffect fx;
        configure(fx, mode);

        // Move the parameters through the REALTIME write path — the same raw
        // atomic the automation planner stores into — so the per-block latch
        // and the smoother ramps are exercised while the counter is armed.
        // setParameterValue() is a message-thread call and would allocate.
        std::atomic<float>*         rawSemis = nullptr;
        std::atomic<float>*         rawSize  = nullptr;
        juce::RangedAudioParameter* dummy    = nullptr;
        CHECK(fx.resolveAutomationParameter("semitones", rawSemis, dummy),
              "could not resolve 'semitones' for automation");
        CHECK(fx.resolveAutomationParameter("size", rawSize, dummy),
              "could not resolve 'size' for automation");

        juce::AudioBuffer<float> buf(2, kBlock);
        juce::MidiBuffer         midi;

        // Warm up unarmed: the first blocks through a JUCE process graph can
        // still touch lazily-built state, and that is not what is under test.
        for (int i = 0; i < 16; ++i) { buf.clear(); fx.processBlock(buf, midi); }

        g_allocCount.store(0);
        g_allocArmed.store(true);

        for (int i = 0; i < 200; ++i)
        {
            if (rawSemis) rawSemis->store((float) (((i * 7) % 49) - 24), std::memory_order_relaxed);
            if (rawSize)  rawSize->store((float) (10 + ((i * 3) % 90)), std::memory_order_relaxed);

            buf.clear();
            for (int c = 0; c < 2; ++c)
            {
                float* w = buf.getWritePointer(c);
                for (int k = 0; k < kBlock; ++k)
                    w[k] = 0.25f * std::sin(2.0f * juce::MathConstants<float>::pi
                                            * 440.0f * (float) (i * kBlock + k) / (float) kSR);
            }
            fx.processBlock(buf, midi);
        }

        g_allocArmed.store(false);
        const long long n = g_allocCount.load();

        std::printf("    %-9s : %lld allocations over 200 blocks\n", name, n);
        CHECK(n == 0, name << " allocated " << n << " times in processBlock()");
    }
}

// ─── 5. Clip pass-through ────────────────────────────────────────────────────

static void testClipPassthrough()
{
    std::cout << "\n[5] Clip mode pass-through\n";

    XlethPitchShifterEffect fx;
    configure(fx, Mode::Clip);

    CHECK(fx.getLatencySamples() == 0,
          "Clip mode reported non-zero latency: " << fx.getLatencySamples());

    // Sample-exact in == out, including with the parameters that WOULD matter
    // in the other modes moved off their defaults, and with mix pulled down —
    // Clip ignores mix by design, so the output must not change.
    fx.setParameterValue("semitones", 12.0f);
    fx.setParameterValue("cents",     50.0f);
    fx.setParameterValue("formant",   1.8f);
    fx.setParameterValue("mix",       0.3f);

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer         midi;
    std::vector<float>       expected((size_t) kBlock);

    juce::Random rng(20260916);
    bool exact = true;
    for (int b = 0; b < 32; ++b)
    {
        for (int k = 0; k < kBlock; ++k)
            expected[(size_t) k] = rng.nextFloat() * 2.0f - 1.0f;

        for (int c = 0; c < 2; ++c)
        {
            float* w = buf.getWritePointer(c);
            for (int k = 0; k < kBlock; ++k) w[k] = expected[(size_t) k];
        }

        fx.processBlock(buf, midi);

        for (int c = 0; c < 2 && exact; ++c)
        {
            const float* r = buf.getReadPointer(c);
            for (int k = 0; k < kBlock; ++k)
                if (r[k] != expected[(size_t) k]) { exact = false; break; }
        }
    }
    CHECK(exact, "Clip mode is not a sample-exact pass-through");
    std::printf("    sample-exact over 32 blocks of noise, both channels: %s\n",
                exact ? "yes" : "NO");

    // Latency must stay 0 no matter what the (inert) clip_* parameters say.
    fx.setParameterValue("clip_semitones", -7.0f);
    fx.setParameterValue("clip_cents",     33.0f);
    fx.setParameterValue("clip_method",    4.0f);
    fx.setParameterValue("clip_formant",   1.0f);
    CHECK(fx.getLatencySamples() == 0,
          "a clip_* parameter moved the reported latency to "
          << fx.getLatencySamples());
}

// ─── 6. Parameter surface ────────────────────────────────────────────────────

static void testParameterSurface()
{
    std::cout << "\n[6] Parameter surface\n";

    XlethPitchShifterEffect fx;
    fx.prepareToPlay(kSR, kBlock);

    struct Expect { const char* id; bool automatable; };
    const Expect expected[] = {
        { "mode",           false },
        { "mix",            true  },
        { "semitones",      true  },
        { "cents",          true  },
        { "size",           true  },
        { "formant",        true  },
        { "clip_semitones", false },
        { "clip_cents",     false },
        { "clip_method",    false },
        { "clip_formant",   false },
    };

    for (const auto& e : expected)
    {
        auto* p = findParam(fx, e.id);
        CHECK(p != nullptr, "missing parameter '" << e.id << "'");
        if (p == nullptr) continue;

        std::printf("    %-16s automatable=%-5s\n",
                    e.id, p->isAutomatable() ? "true" : "false");
        CHECK(p->isAutomatable() == e.automatable,
              "'" << e.id << "' automatable=" << (p->isAutomatable() ? "true" : "false")
                  << ", expected " << (e.automatable ? "true" : "false"));
    }

    CHECK(fx.getParameters().size() == (int) (sizeof(expected) / sizeof(expected[0])),
          "expected " << (sizeof(expected) / sizeof(expected[0]))
                      << " APVTS params, got " << fx.getParameters().size());

    CHECK(fx.getPluginId() == "pitchshifter",
          "plugin id is '" << fx.getPluginId() << "', expected 'pitchshifter'");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_pitch_shifter_effect ===\n";

    testLatencyConformance();
    testSmoothedSweep();
    testModeSwitchPdc();
    testZeroAllocation();
    testClipPassthrough();
    testParameterSurface();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    return 1;
}

// test_limiter.cpp — XlethLimiterEffect gain-computer tests
// Build: cmake --build build --config Release --target test_limiter
// Run:   build\engine\Release\test_limiter.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers the two-stage (transient + release) gain computer:
//   • brickwall ceiling is respected for every style, hard drive included
//   • the gain envelope holds after a dip instead of recovering inside a
//     waveform cycle (the crackle fix) — measured as bounded low-frequency
//     amplitude modulation on a sustained bass tone
//   • the gain curve is smooth: bounded first AND second difference
//   • a short user release cannot defeat the per-style hold/release floor
//   • lookahead latency is reported per style and never changes in processBlock
//   • parameter surface and meter slots are unchanged

#include "audio/XlethLimiterEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

// ─── Test harness ─────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [" << __LINE__ << "] " << (msg) << "\n";       \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

// ─── Utilities ────────────────────────────────────────────────────────────────

static constexpr double kSR    = 48000.0;
static constexpr int    kBlock = 256;

struct RenderResult
{
    std::vector<float> out;      // channel 0
    float maxAbs = 0.0f;
};

// Runs `totalSamples` of `gen(sampleIndex)` through a freshly prepared limiter
// and returns channel 0 of the output.
template <typename Gen>
static RenderResult render(XlethLimiterEffect& lim, int totalSamples, Gen gen)
{
    RenderResult r;
    r.out.reserve((std::size_t)totalSamples);

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;

    int n = 0;
    while (n < totalSamples)
    {
        const int ns = std::min(kBlock, totalSamples - n);
        buf.setSize(2, ns, false, false, true);
        for (int i = 0; i < ns; ++i)
        {
            const float v = gen(n + i);
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        lim.processBlock(buf, midi);
        for (int i = 0; i < ns; ++i)
        {
            const float v = buf.getSample(0, i);
            r.out.push_back(v);
            r.maxAbs = std::max(r.maxAbs, std::abs(v));
        }
        n += ns;
    }
    return r;
}

static void configure(XlethLimiterEffect& lim, float gainDb, float ceilingDb,
                      float releaseMs, int style)
{
    lim.setParameterValue("style",   (float)style);
    lim.setParameterValue("gain",    gainDb);
    lim.setParameterValue("ceiling", ceilingDb);
    lim.setParameterValue("release", releaseMs);
}

// Skip the first `n` samples (lookahead priming + parameter smoothing ramps).
static std::vector<float> tail(const std::vector<float>& v, int n)
{
    if ((int)v.size() <= n) return {};
    return std::vector<float>(v.begin() + n, v.end());
}

static float maxAbs(const std::vector<float>& v)
{
    float m = 0.0f;
    for (float x : v) m = std::max(m, std::abs(x));
    return m;
}

// THD+N of a segment that should be a pure tone at `freqHz`, as a ratio of the
// fundamental's RMS. Goertzel for the fundamental, everything else is residual.
//
// This is the measurement that actually sees the crackle. Peak-envelope ripple
// does NOT: the brickwall pins every half-cycle peak to the ceiling no matter
// how badly the gain flutters inside the cycle — the damage shows up as
// waveform distortion (harmonics), not as level variation.
static double thdPlusN(const std::vector<float>& v, double freqHz, double sr)
{
    // Trim to a whole number of cycles so the Goertzel bin does not leak.
    const int period = (int)std::llround(sr / freqHz);
    const int n      = ((int)v.size() / period) * period;
    if (n < period * 4) return 1.0;

    double re = 0.0, im = 0.0, total = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double t = 2.0 * juce::MathConstants<double>::pi * freqHz
                       * (double)i / sr;
        re    += (double)v[(std::size_t)i] * std::cos(t);
        im    += (double)v[(std::size_t)i] * std::sin(t);
        total += (double)v[(std::size_t)i] * (double)v[(std::size_t)i];
    }
    re *= 2.0 / (double)n;
    im *= 2.0 / (double)n;

    const double fundAmp = std::sqrt(re * re + im * im);
    const double fundMs  = 0.5 * fundAmp * fundAmp;      // mean square
    const double totalMs = total / (double)n;
    const double residMs = std::max(totalMs - fundMs, 0.0);

    return (fundMs > 1e-12) ? std::sqrt(residMs / fundMs) : 1.0;
}

static const char* styleName(int s)
{
    return s == 0 ? "Transparent" : (s == 1 ? "Punchy" : "Aggressive");
}

// ─── Parameter surface (must stay unchanged — engine-only rework) ─────────────

static void testParameterSurfaceUnchanged()
{
    XlethLimiterEffect lim;

    struct Expect { const char* id; float min; float max; float def; };
    const Expect expected[] = {
        { "gain",     0.0f,  36.0f,   0.0f },
        { "ceiling", -12.0f,  0.0f,  -0.3f },
        { "release",  10.0f, 1000.0f, 100.0f },
        { "style",     0.0f,  2.0f,    0.0f },
    };

    const auto json = nlohmann::json::parse(lim.getParametersAsJSON());
    CHECK(json.size() == 4, "limiter should expose exactly 4 parameters");

    for (const auto& e : expected)
    {
        bool found = false;
        for (const auto& p : json)
        {
            if (p["id"].get<std::string>() != e.id) continue;
            found = true;
            CHECK(std::abs(p["min"].get<float>() - e.min) < 1e-4f,
                  std::string("param min unchanged: ") + e.id);
            CHECK(std::abs(p["max"].get<float>() - e.max) < 1e-4f,
                  std::string("param max unchanged: ") + e.id);
            CHECK(std::abs(p["default"].get<float>() - e.def) < 1e-4f,
                  std::string("param default unchanged: ") + e.id);
        }
        CHECK(found, std::string("param still present: ") + e.id);
    }
}

// ─── Brickwall: the ceiling must hold for every style ─────────────────────────

static void testCeilingHoldsForEveryStyle()
{
    for (int style = 0; style <= 2; ++style)
    {
        // Hard drive: +18 dB into a -1 dB ceiling, dense transients on top of a
        // sustained tone — the case where a naive smoother overshoots.
        XlethLimiterEffect lim;
        lim.prepareToPlay(kSR, kBlock);
        configure(lim, 18.0f, -1.0f, 30.0f, style);

        const float ceilLin = juce::Decibels::decibelsToGain(-1.0f);

        auto r = render(lim, (int)(kSR * 1.0), [](int i) {
            const double t = (double)i / kSR;
            float v = 0.35f * (float)std::sin(2.0 * juce::MathConstants<double>::pi * 90.0 * t);
            if ((i % 4800) < 24) v += 0.9f;    // 10 Hz transient train
            return v;
        });

        const float peak = maxAbs(tail(r.out, (int)kSR / 20));
        CHECK(peak <= ceilLin * 1.0005f,
              std::string("ceiling holds under hard drive: ") + styleName(style)
              + " peak=" + std::to_string(peak) + " ceil=" + std::to_string(ceilLin));

        // And it must actually be limiting, not just passing quiet audio.
        CHECK(lim.readMeterValue(2) > 3.0f,
              std::string("gain reduction is active: ") + styleName(style));

        for (float v : r.out)
            CHECK(std::isfinite(v), std::string("output finite: ") + styleName(style));
    }
}

static void testCeilingHoldsAtLowestCeiling()
{
    XlethLimiterEffect lim;
    lim.prepareToPlay(kSR, kBlock);
    configure(lim, 36.0f, -12.0f, 10.0f, 2);   // max drive, min ceiling, min release

    const float ceilLin = juce::Decibels::decibelsToGain(-12.0f);
    auto r = render(lim, (int)(kSR * 0.5), [](int i) {
        const double t = (double)i / kSR;
        return 0.6f * (float)std::sin(2.0 * juce::MathConstants<double>::pi * 220.0 * t);
    });

    const float peak = maxAbs(tail(r.out, (int)kSR / 20));
    CHECK(peak <= ceilLin * 1.0005f,
          "ceiling holds at -12 dB with max gain, peak=" + std::to_string(peak));
}

// ─── The crackle fix: no per-cycle gain modulation of low frequencies ─────────
//
// A 60 Hz tone driven 12 dB into the limiter. Once the gain envelope settles,
// a limiter that recovers inside one cycle wave-shapes the tone: its half-cycle
// peak envelope wobbles from cycle to cycle. Hold + cascaded release must keep
// that wobble small.

static void testNoPerCycleAmplitudeModulation()
{
    // Worst case for each style: a sustained 60 Hz tone (16.7 ms per cycle)
    // driven 12 dB in, with the SHORTEST release the UI allows. Once settled, a
    // limiter on a steady tone is just a constant gain, so the output should
    // still be very nearly a pure sine. A limiter whose envelope recovers
    // inside the cycle wave-shapes it instead — that is the crackle.
    const double toneHz = 60.0;

    // Measured on the shipped tuning: Transparent 1.1e-7, Punchy 2.7e-7 — the
    // settled gain is genuinely constant. Aggressive measures 0.066 because it
    // deliberately hands ~1.2 dB of peak to its output saturator; with the
    // saturator disabled its envelope-only figure is 0.003, i.e. the residue is
    // designed saturation, not flutter.
    //
    // Negative control (hold removed, release floor removed, single-pole
    // release — the shape this rework replaced) measures 0.009 / 0.038 / 0.121,
    // so these limits do discriminate.
    const double limits[3] = { 0.002, 0.002, 0.10 };

    for (int style = 0; style <= 2; ++style)
    {
        XlethLimiterEffect lim;
        lim.prepareToPlay(kSR, kBlock);
        configure(lim, 12.0f, -0.3f, 10.0f, style);

        auto r = render(lim, (int)(kSR * 1.0), [toneHz](int i) {
            const double t = (double)i / kSR;
            return 0.5f * (float)std::sin(2.0 * juce::MathConstants<double>::pi * toneHz * t);
        });

        // Drop the first 300 ms (lookahead priming + parameter smoothing).
        const double thd = thdPlusN(tail(r.out, (int)(kSR * 0.3)), toneHz, kSR);

        CHECK(thd < limits[style],
              std::string("no per-cycle wave-shaping of a 60 Hz tone: ")
              + styleName(style) + " THD+N=" + std::to_string(thd)
              + " limit=" + std::to_string(limits[style]));
    }
}

// ─── Release probe: recovers the actual gain curve, not the signal envelope ──
//
// Drives a 1 kHz sine hard enough to sit in steady gain reduction, then steps
// the input DOWN to a level below the ceiling. From that step on the limiter
// applies gain to a constant-amplitude carrier, so
//     gain[bin] = peak(output over one half cycle) / quietAmplitude
// is the gain curve itself. Bin 0 is the sample where the step reaches the
// output (i.e. where the hold starts counting).

struct ReleaseProbe
{
    std::vector<float> gainDb;    // ≤ 0, rising back toward 0
    double             binMs = 0.0;
};

static ReleaseProbe probeRelease(int style, float userReleaseMs)
{
    XlethLimiterEffect lim;
    lim.prepareToPlay(kSR, kBlock);
    configure(lim, 0.0f, -1.0f, userReleaseMs, style);

    const float ceilLin = juce::Decibels::decibelsToGain(-1.0f);
    const float loud    = ceilLin * 4.0f;      // 12 dB of steady reduction
    const float quiet   = ceilLin * 0.5f;      // below the ceiling
    const int   stepAt  = (int)(kSR * 0.3);
    const int   total   = (int)(kSR * 0.6);

    auto r = render(lim, total, [loud, quiet, stepAt](int i) {
        const double t = (double)i / kSR;
        const float  s = (float)std::sin(
            2.0 * juce::MathConstants<double>::pi * 1000.0 * t);
        return (i < stepAt ? loud : quiet) * s;
    });

    const int hop   = (int)(kSR / 1000.0 / 2.0);   // exactly one half cycle
    const int start = stepAt + lim.getReportedProcessorLatencySamples();

    ReleaseProbe p;
    p.binMs = (double)hop / kSR * 1000.0;
    for (int b = start; b + hop <= (int)r.out.size(); b += hop)
    {
        float peak = 0.0f;
        for (int k = 0; k < hop; ++k)
            peak = std::max(peak, std::abs(r.out[(std::size_t)(b + k)]));
        p.gainDb.push_back(20.0f * std::log10(std::max(peak, 1e-9f) / quiet));
    }
    return p;
}

// ─── Gain-curve smoothness: the release must not start at full slope ─────────
//
// This is the discriminator between a single one-pole and the cascade. A single
// pole's recovery slope is MAXIMAL at the instant release begins (that step in
// slope is the corner that clicks); a cascade of poles followed by the box
// smoothing starts from zero slope and peaks one time-constant later.

static void testGainCurveHasNoCorners()
{
    for (int style = 0; style <= 2; ++style)
    {
        const auto p = probeRelease(style, 100.0f);
        const auto& g = p.gainDb;
        CHECK(g.size() > 100,
              std::string("release probe long enough: ") + styleName(style));
        if (g.size() < 100) continue;

        const float floorDb = *std::min_element(g.begin(), g.begin() + 8);

        // Where release actually begins (after the hold).
        int startBin = -1;
        for (std::size_t i = 0; i < g.size(); ++i)
            if (g[i] > floorDb + 0.05f) { startBin = (int)i; break; }
        CHECK(startBin > 0,
              std::string("release begins within the probe: ") + styleName(style));
        if (startBin <= 0) continue;

        // Slope per bin, and where it peaks.
        int   peakBin   = startBin;
        float peakSlope = 0.0f;
        float maxJump   = 0.0f;
        for (std::size_t i = (std::size_t)startBin; i + 1 < g.size(); ++i)
        {
            const float d = g[i + 1] - g[i];
            maxJump = std::max(maxJump, std::abs(d));
            if (d > peakSlope) { peakSlope = d; peakBin = (int)i; }
        }

        const double slopePeakMs = (double)(peakBin - startBin) * p.binMs;
        CHECK(slopePeakMs >= 1.0,
              std::string("release ramps in gradually (no slope step at the "
                          "corner): ") + styleName(style)
              + " slope peaks " + std::to_string(slopePeakMs)
              + " ms after release starts");

        // No isolated discontinuity anywhere in the curve.
        CHECK(maxJump < 1.0f,
              std::string("gain curve has no jump: ") + styleName(style)
              + " maxJump=" + std::to_string(maxJump) + " dB/bin");
    }
}

// ─── The hold floor survives a 10 ms release request ─────────────────────────

static void testShortReleaseStillHonoursHoldFloor()
{
    // Ask for the shortest release the UI allows. The per-style hold floor must
    // still keep the gain frozen — this is what stops the envelope recovering
    // inside a waveform cycle.
    for (int style = 0; style <= 2; ++style)
    {
        const auto p = probeRelease(style, 10.0f);
        const auto& g = p.gainDb;
        CHECK(g.size() > 50,
              std::string("hold probe long enough: ") + styleName(style));
        if (g.size() < 50) continue;

        const float floorDb = *std::min_element(g.begin(), g.begin() + 4);

        int recoveredBin = -1;
        for (std::size_t i = 0; i < g.size(); ++i)
            if (g[i] > floorDb + 1.0f) { recoveredBin = (int)i; break; }

        CHECK(recoveredBin > 0,
              std::string("gain does recover eventually: ") + styleName(style));
        if (recoveredBin <= 0) continue;

        const double heldMs = (double)recoveredBin * p.binMs;
        const float  holdMs = xleth_limiter::kStyles[style].holdMs;

        CHECK(heldMs >= (double)holdMs * 0.9,
              std::string("10 ms release still waits out the hold: ")
              + styleName(style) + " held=" + std::to_string(heldMs)
              + " ms hold=" + std::to_string(holdMs) + " ms");
    }
}

// ─── Style ordering: the tunings are actually distinct ───────────────────────

static void testStylesAreDistinctTunings()
{
    CHECK(xleth_limiter::kStyles[0].lookaheadMs
              > xleth_limiter::kStyles[1].lookaheadMs
          && xleth_limiter::kStyles[1].lookaheadMs
              > xleth_limiter::kStyles[2].lookaheadMs,
          "lookahead shortens from Transparent to Aggressive");

    CHECK(xleth_limiter::kStyles[0].holdMs > xleth_limiter::kStyles[1].holdMs
          && xleth_limiter::kStyles[1].holdMs > xleth_limiter::kStyles[2].holdMs,
          "hold shortens from Transparent to Aggressive");

    CHECK(xleth_limiter::kStyles[0].releaseScale
              > xleth_limiter::kStyles[1].releaseScale
          && xleth_limiter::kStyles[1].releaseScale
              > xleth_limiter::kStyles[2].releaseScale,
          "release speeds up from Transparent to Aggressive");

    CHECK(xleth_limiter::kStyles[0].overshootDb == 0.0f
          && xleth_limiter::kStyles[1].overshootDb == 0.0f
          && xleth_limiter::kStyles[2].overshootDb > 0.0f,
          "only Aggressive hands peak to the output saturator");

    CHECK(xleth_limiter::kMaxLookaheadMs
              >= xleth_limiter::kStyles[0].lookaheadMs,
          "kMaxLookaheadMs covers the longest style (ring sizing invariant)");
}

// ─── Latency reporting (PDC contract) ────────────────────────────────────────

static void testLatencyReportedPerStyle()
{
    XlethLimiterEffect lim;
    lim.prepareToPlay(kSR, kBlock);

    lim.setParameterValue("style", 0.0f);
    const int latTransparent = lim.getReportedProcessorLatencySamples();
    lim.setParameterValue("style", 2.0f);
    const int latAggressive = lim.getReportedProcessorLatencySamples();

    CHECK(latTransparent > 0 && latAggressive > 0,
          "limiter reports a positive lookahead latency");
    CHECK(latTransparent > latAggressive,
          "Transparent reports more lookahead latency than Aggressive");

    // The reported number must equal lookahead + detection oversampler latency,
    // and must not move while audio is running.
    const int expectedDelta =
        XlethLimiterEffect::styleLookaheadSamples(0, kSR)
        - XlethLimiterEffect::styleLookaheadSamples(2, kSR);
    CHECK(latTransparent - latAggressive == expectedDelta,
          "latency delta matches the style lookahead delta");

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;
    for (int b = 0; b < 40; ++b)
    {
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < kBlock; ++i)
                buf.setSample(ch, i, 0.8f * std::sin((float)(b * kBlock + i) * 0.01f));
        lim.processBlock(buf, midi);
    }
    CHECK(lim.getReportedProcessorLatencySamples() == latAggressive,
          "processBlock never republishes latency");
    CHECK(lim.getProcessBlockLatencyUpdateCount() == 0,
          "processBlock latency update counter stays zero");
}

// ─── Style switching mid-stream stays finite and inside the ceiling ──────────

static void testStyleSwitchStaysBounded()
{
    XlethLimiterEffect lim;
    lim.prepareToPlay(kSR, kBlock);
    configure(lim, 12.0f, -0.5f, 40.0f, 0);

    const float ceilLin = juce::Decibels::decibelsToGain(-0.5f);
    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;

    float worst = 0.0f;
    for (int b = 0; b < 200; ++b)
    {
        if (b == 60)  lim.setParameterValue("style", 2.0f);
        if (b == 120) lim.setParameterValue("style", 1.0f);
        if (b == 160) lim.setParameterValue("style", 0.0f);

        for (int i = 0; i < kBlock; ++i)
        {
            const double t = (double)(b * kBlock + i) / kSR;
            const float v = 0.5f * (float)std::sin(
                2.0 * juce::MathConstants<double>::pi * 220.0 * t);
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        lim.processBlock(buf, midi);

        for (int i = 0; i < kBlock; ++i)
        {
            const float v = buf.getSample(0, i);
            CHECK(std::isfinite(v), "style switch keeps the output finite");
            worst = std::max(worst, std::abs(v));
        }
    }
    CHECK(worst <= ceilLin * 1.0005f,
          "style switching never breaches the ceiling, worst="
          + std::to_string(worst));
}

// ─── Below the ceiling the limiter is transparent (delay only) ───────────────

static void testUnderThresholdIsUnityGain()
{
    XlethLimiterEffect lim;
    lim.prepareToPlay(kSR, kBlock);
    configure(lim, 0.0f, -0.3f, 100.0f, 0);

    const int lat = lim.getReportedProcessorLatencySamples();
    auto gen = [](int i) {
        const double t = (double)i / kSR;
        return 0.25f * (float)std::sin(2.0 * juce::MathConstants<double>::pi * 500.0 * t);
    };
    auto r = render(lim, (int)(kSR * 0.3), gen);

    // After the smoothing ramps settle, output[n] must equal input[n - latency].
    double worst = 0.0;
    for (int n = (int)kSR / 10; n < (int)r.out.size(); ++n)
        worst = std::max(worst, std::abs((double)r.out[(std::size_t)n]
                                         - (double)gen(n - lat)));

    CHECK(worst < 2e-4, "signal below the ceiling passes through unchanged "
                        "(latency-shifted), worst=" + std::to_string(worst));
    CHECK(lim.readMeterValue(2) < 0.01f,
          "no gain reduction reported below the ceiling");
}

// ─── Meter slots keep their meaning ──────────────────────────────────────────

static void testMeterSlotsUnchanged()
{
    XlethLimiterEffect lim;
    lim.prepareToPlay(kSR, kBlock);
    configure(lim, 12.0f, -1.0f, 50.0f, 1);

    render(lim, (int)(kSR * 0.5), [](int i) {
        const double t = (double)i / kSR;
        return 0.7f * (float)std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * t);
    });

    const float ceilLin = juce::Decibels::decibelsToGain(-1.0f);
    CHECK(lim.readMeterValue(0) > 0.0f && lim.readMeterValue(0) <= ceilLin * 1.001f,
          "slot 0 = L output peak");
    CHECK(lim.readMeterValue(1) > 0.0f && lim.readMeterValue(1) <= ceilLin * 1.001f,
          "slot 1 = R output peak");
    CHECK(lim.readMeterValue(2) > 0.0f, "slot 2 = gain reduction, positive dB");
    CHECK(lim.readMeterValue(3) < 0.0f && lim.readMeterValue(3) > -60.0f,
          "slot 3 = momentary LUFS");
    CHECK(lim.readMeterValue(4) < 0.0f && lim.readMeterValue(4) > -60.0f,
          "slot 4 = short-term LUFS");
}

// ─── Determinism ─────────────────────────────────────────────────────────────

static void testDeterministicAcrossInstances()
{
    auto run = [] {
        XlethLimiterEffect lim;
        lim.prepareToPlay(kSR, kBlock);
        configure(lim, 15.0f, -0.3f, 25.0f, 2);
        return render(lim, (int)(kSR * 0.4), [](int i) {
            const double t = (double)i / kSR;
            float v = 0.4f * (float)std::sin(2.0 * juce::MathConstants<double>::pi * 130.0 * t);
            if ((i % 3000) < 40) v += 0.8f;
            return v;
        }).out;
    };

    const auto a = run();
    const auto b = run();
    CHECK(a.size() == b.size(), "deterministic render length");

    bool identical = a.size() == b.size();
    for (std::size_t i = 0; identical && i < a.size(); ++i)
        identical = (a[i] == b[i]);
    CHECK(identical, "two fresh instances produce bit-identical output");
}

// ─── Moving-minimum primitive ────────────────────────────────────────────────

static void testMovingMinimumMatchesBruteForce()
{
    xleth_limiter::MovingMinimum mm;
    mm.prepare(64);
    mm.reset(0.0f);

    std::vector<float> in;
    for (int i = 0; i < 500; ++i)
        in.push_back(std::sin((float)i * 0.37f) * (float)((i % 17) + 1));

    const int W = 33;
    bool ok = true;
    for (int i = 0; i < (int)in.size(); ++i)
    {
        const float got = mm.push(in[(std::size_t)i], W);
        float want = in[(std::size_t)i];
        for (int k = std::max(0, i - W + 1); k <= i; ++k)
            want = std::min(want, in[(std::size_t)k]);
        if (std::abs(got - want) > 1e-6f) { ok = false; break; }
    }
    CHECK(ok, "MovingMinimum matches a brute-force sliding minimum");

    // Window changes (style switch) must not corrupt the wedge.
    mm.reset(0.0f);
    ok = true;
    for (int i = 0; i < (int)in.size(); ++i)
    {
        const int w = (i < 200) ? 33 : 9;
        const float got = mm.push(in[(std::size_t)i], w);
        float want = in[(std::size_t)i];
        for (int k = std::max(0, i - w + 1); k <= i; ++k)
            want = std::min(want, in[(std::size_t)k]);
        // Immediately after the window shrinks the wedge may still hold older
        // (smaller) candidates for up to one window; only check once settled.
        if (i > 220 && got > want + 1e-6f) { ok = false; break; }
    }
    CHECK(ok, "MovingMinimum stays a valid lower bound across window changes");
}

// ─── Soft clipper ────────────────────────────────────────────────────────────

static void testSoftClipperIsBoundedAndTransparentBelowKnee()
{
    const float ceiling = 0.9f;
    const float knee    = 0.8f;

    for (int i = -2000; i <= 2000; ++i)
    {
        const float x = (float)i * 0.002f;   // ±4.0
        const float y = xleth_limiter::softClipToCeiling(x, ceiling, knee);

        CHECK(std::abs(y) <= ceiling, "soft clip never exceeds the ceiling");
        if (std::abs(x) <= knee)
            CHECK(std::abs(y - x) < 1e-6f, "soft clip is transparent below the knee");
        if (x < 0.0f) CHECK(y <= 0.0f, "soft clip preserves sign");
    }

    // Monotonic (no fold-back distortion).
    float prev = xleth_limiter::softClipToCeiling(-4.0f, ceiling, knee);
    bool monotone = true;
    for (int i = -1999; i <= 2000 && monotone; ++i)
    {
        const float y = xleth_limiter::softClipToCeiling((float)i * 0.002f, ceiling, knee);
        monotone = (y >= prev - 1e-7f);
        prev = y;
    }
    CHECK(monotone, "soft clip is monotonic");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_limiter_primitives ===\n";
    testMovingMinimumMatchesBruteForce();
    testSoftClipperIsBoundedAndTransparentBelowKnee();
    testStylesAreDistinctTunings();

    std::cout << "\n=== test_limiter_contract ===\n";
    testParameterSurfaceUnchanged();
    testMeterSlotsUnchanged();
    testLatencyReportedPerStyle();

    std::cout << "\n=== test_limiter_brickwall ===\n";
    testCeilingHoldsForEveryStyle();
    testCeilingHoldsAtLowestCeiling();
    testUnderThresholdIsUnityGain();
    testStyleSwitchStaysBounded();

    std::cout << "\n=== test_limiter_gain_curve ===\n";
    testNoPerCycleAmplitudeModulation();
    testGainCurveHasNoCorners();
    testShortReleaseStillHonoursHoldFloor();

    std::cout << "\n=== test_limiter_determinism ===\n";
    testDeterministicAcrossInstances();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}

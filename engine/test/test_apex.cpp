// test_apex.cpp — XlethApexEffect (APEX multiband maximizer) DSP smoke tests
//
// Build: cmake --build build --config Release --target test_apex
// Run:   ctest --test-dir build -C Release -R "^test_apex$" -V
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// The five contract tests required by the APEX DSP-core brief:
//
//   (a) band-split reconstruction is magnitude-flat within +/-0.5 dB with every
//       band at COMP OFF and BAND MIX at 100 %, for all four LR2/LR4 slope
//       combinations
//   (b) LOOKAHEAD at 10 ms introduces exactly the reported latency — proven
//       twice: as a literal impulse position on the BAND MIX dry leg, and as a
//       bit-exact shift of the band leg
//   (c) the dry leg of BAND MIX is sample-aligned with the band leg — proven as
//       a null test between the 50 % render and the arithmetic mean of the
//       0 % and 100 % renders (tolerance documented at the test)
//   (d) saturation at +/-100 % on a 0 dBFS 5 kHz sine through the HIGH band
//       produces no aliasing product above -60 dBFS in 20 Hz .. 20 kHz
//   (e) a MUTED band contributes digital silence; an OFF band is bit-transparent
//
// plus the primitives those rest on (half-band oversampler round trip, curve
// LUT compilation) and the engine-integration contract (parameter surface,
// latency publication, state round-trip including curve nodes).

#include "audio/ApexDsp.h"
#include "audio/XlethApexEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iostream>
#include <string>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

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

static void report(const char* name, bool ok, const std::string& detail)
{
    std::cout << (ok ? "  PASS  " : "  FAIL  ") << name;
    if (!detail.empty()) std::cout << "  (" << detail << ")";
    std::cout << "\n";
}

// ─── Constants / helpers ─────────────────────────────────────────────────────

static constexpr double kSR    = 48000.0;
static constexpr int    kBlock = 256;

using Configure = std::function<void(XlethApexEffect&)>;

struct Stereo
{
    std::vector<float> l, r;
};

// White noise derived purely from the sample INDEX.  Several tests render the
// same signal through differently-configured instances and compare the results
// sample by sample, so the generator must be a pure function of i — a stateful
// PRNG would hand the second render a different sequence and every null test
// would fail for reasons that have nothing to do with the DSP.
static float indexNoise(int i)
{
    std::uint32_t x = static_cast<std::uint32_t>(i) * 2654435761u + 0x9E3779B9u;
    x ^= x >> 15; x *= 0x2C1B3C6Du;
    x ^= x >> 12; x *= 0x297A2D39u;
    x ^= x >> 15;
    return (static_cast<float>(x) / 2147483648.0f) - 1.0f;
}

// Runs `total` samples of `gen` through a freshly prepared APEX instance.
// `cfg` runs BEFORE prepareToPlay so that latency-affecting parameters are
// already in place when the effect snaps its delay lines (no glide).
template <typename Gen>
static Stereo render(int total, const Configure& cfg, Gen gen)
{
    XlethApexEffect apex;
    if (cfg) cfg(apex);
    apex.prepareToPlay(kSR, kBlock);

    Stereo out;
    out.l.reserve(static_cast<std::size_t>(total));
    out.r.reserve(static_cast<std::size_t>(total));

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;

    int n = 0;
    while (n < total)
    {
        const int count = std::min(kBlock, total - n);
        buf.clear();
        for (int s = 0; s < count; ++s)
        {
            float l = 0.0f, r = 0.0f;
            gen(n + s, l, r);
            buf.setSample(0, s, l);
            buf.setSample(1, s, r);
        }
        apex.processBlock(buf, midi);
        for (int s = 0; s < count; ++s)
        {
            out.l.push_back(buf.getSample(0, s));
            out.r.push_back(buf.getSample(1, s));
        }
        n += count;
    }
    return out;
}

static Stereo renderImpulse(int total, const Configure& cfg)
{
    return render(total, cfg, [](int i, float& l, float& r)
    {
        l = r = (i == 0) ? 1.0f : 0.0f;
    });
}

// A composite of every tone the brief calls for: 60 Hz sub sine, a kick-like
// decaying burst every 0.25 s, a 5 kHz sine, and white noise.
static void compositeTone(int i, float& l, float& r)
{
    const double t = static_cast<double>(i) / kSR;

    const float sub  = 0.35f * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * 60.0 * t));
    const float hi   = 0.20f * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * 5000.0 * t));

    const int   period = static_cast<int>(kSR * 0.25);
    const int   phase  = i % period;
    const float decay  = std::exp(-static_cast<float>(phase) / (0.03f * static_cast<float>(kSR)));
    const float kick   = 0.6f * decay
                       * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * 55.0
                                                     * (static_cast<double>(phase) / kSR)));

    const float n = 0.05f * indexNoise(i);

    l = sub + hi + kick + n;
    r = sub + hi + kick - n;   // decorrelated noise so M/S tests have side energy
}

static void setStateAll(XlethApexEffect& a, float state)
{
    for (int b = 0; b < XlethApexEffect::kNumBands; ++b)
        a.setParameterValue(XlethApexEffect::bandParamId(b, "state"), state);
}

// Magnitude spectrum in dB of a real signal (rectangular window — every test
// frequency is chosen to land on an exact bin, so there is no leakage).
static std::vector<float> magnitudeDb(const std::vector<float>& x, int fftOrder)
{
    const int n = 1 << fftOrder;
    juce::dsp::FFT fft(fftOrder);
    std::vector<float> work(static_cast<std::size_t>(2 * n), 0.0f);
    const int copy = std::min<int>(n, static_cast<int>(x.size()));
    std::copy(x.end() - copy, x.end(), work.begin());

    fft.performFrequencyOnlyForwardTransform(work.data());

    std::vector<float> db(static_cast<std::size_t>(n / 2));
    for (int k = 0; k < n / 2; ++k)
        db[static_cast<std::size_t>(k)] =
            20.0f * std::log10(std::max(2.0f * work[static_cast<std::size_t>(k)]
                                        / static_cast<float>(n), 1.0e-12f));
    return db;
}

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

// The 2x polyphase half-band oversampler is the one piece whose polyphase index
// arithmetic was derived by hand, so it is verified directly: with a
// pass-through shaper it must be a unity-gain filter with EXACTLY
// kOsLatencySamples of delay — the integer the effect adds to its reported
// latency and that FixedDelay reproduces for non-saturating lanes.
static void testOversamplerRoundTrip()
{
    xleth_apex::SatConfig identity;
    identity.set(0.0f, 0.0f);              // amount 0, ceiling 0 dB -> f(x) = x

    // -- impulse: peak position == kOsLatencySamples, DC gain == 1 -----------
    {
        xleth_apex::Saturator2x os;
        const int n = 512;
        std::vector<float> a(static_cast<std::size_t>(n), 0.0f);
        std::vector<float> b(static_cast<std::size_t>(n), 0.0f);
        a[0] = 1.0f;
        float* chans[2] = { a.data(), b.data() };
        os.processBlock(chans, 2, n, identity);

        int   peakIdx = 0;
        float peak = 0.0f, sum = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            sum += a[static_cast<std::size_t>(i)];
            if (std::abs(a[static_cast<std::size_t>(i)]) > peak)
            {
                peak = std::abs(a[static_cast<std::size_t>(i)]);
                peakIdx = i;
            }
        }
        const bool okIdx = (peakIdx == xleth_apex::kOsLatencySamples);
        const bool okDc  = std::abs(sum - 1.0f) < 1.0e-4f;
        CHECK(okIdx, "oversampler impulse peak is not at kOsLatencySamples");
        CHECK(okDc,  "oversampler DC gain is not unity");
        report("oversampler impulse latency + DC gain", okIdx && okDc,
               "peak@" + std::to_string(peakIdx) + " expected "
               + std::to_string(xleth_apex::kOsLatencySamples)
               + ", DC=" + std::to_string(sum));
    }

    // -- sines: unity magnitude through the audio band -----------------------
    {
        bool  ok = true;
        float worstDb = 0.0f;
        for (double f : { 100.0, 1000.0, 5000.0, 10000.0, 15000.0 })
        {
            xleth_apex::Saturator2x os;
            const int n = 8192;
            std::vector<float> a(static_cast<std::size_t>(n)), b(static_cast<std::size_t>(n));
            for (int i = 0; i < n; ++i)
            {
                a[static_cast<std::size_t>(i)] = static_cast<float>(
                    std::sin(2.0 * juce::MathConstants<double>::pi * f * i / kSR));
                b[static_cast<std::size_t>(i)] = a[static_cast<std::size_t>(i)];
            }
            float* chans[2] = { a.data(), b.data() };
            os.processBlock(chans, 2, n, identity);

            float peak = 0.0f;
            for (int i = 2000; i < n; ++i)   // skip the filter's start-up
                peak = std::max(peak, std::abs(a[static_cast<std::size_t>(i)]));
            const float errDb = 20.0f * std::log10(std::max(peak, 1.0e-6f));
            worstDb = std::max(worstDb, std::abs(errDb));
            ok = ok && std::abs(errDb) < 0.3f;
        }
        CHECK(ok, "oversampler round trip is not unity gain across the audio band");
        report("oversampler passband flatness", ok,
               "worst " + std::to_string(worstDb) + " dB (limit 0.30)");
    }

    // -- FixedDelay reproduces the same integer delay ------------------------
    {
        xleth_apex::FixedDelay d;
        d.prepare(xleth_apex::kOsLatencySamples);
        d.setDelay(xleth_apex::kOsLatencySamples);
        const int n = 256;
        std::vector<float> a(static_cast<std::size_t>(n), 0.0f);
        std::vector<float> b(static_cast<std::size_t>(n), 0.0f);
        a[0] = 1.0f;
        float* chans[2] = { a.data(), b.data() };
        d.processBlock(chans, 2, n);
        const bool ok = a[static_cast<std::size_t>(xleth_apex::kOsLatencySamples)] == 1.0f;
        CHECK(ok, "FixedDelay does not match the oversampler latency");
        report("FixedDelay matches oversampler latency", ok, "");
    }
}

// The curve compiler is the only thing standing between the editor's nodes and
// the audio thread, so its invariants are checked directly.
static void testCurveLutCompilation()
{
    using xleth_apex::CurveNode;

    // Unity curve -> unity gain everywhere.
    {
        std::vector<CurveNode> nodes;
        std::vector<float>     tens;
        xleth_apex::makeUnityCurve(nodes, tens);
        xleth_apex::CurveLut lut;
        xleth_apex::buildCurveLut(nodes.data(), 2, tens.data(), 1, lut);

        bool ok = true;
        for (float db = -40.0f; db <= 20.0f; db += 0.5f)
            ok = ok && std::abs(lut.lookup(db) - 1.0f) < 1.0e-4f;
        CHECK(ok, "unity curve does not compile to unity gain");
        report("curve: unity compiles to unity gain", ok, "");
    }

    // A limiting curve: flat output above -12 dB in.
    {
        std::vector<CurveNode> nodes = {
            { -24.0f, -24.0f }, { -12.0f, -12.0f }, { 12.0f, -12.0f }
        };
        std::vector<float> tens = { 0.0f, 0.0f };
        xleth_apex::CurveLut lut;
        xleth_apex::buildCurveLut(nodes.data(), 3, tens.data(), 2, lut);

        const float gAtMinus18 = lut.lookup(-18.0f);
        const float gAtZero    = lut.lookup(0.0f);
        const float gAtPlus6   = lut.lookup(6.0f);

        const bool unityBelow = std::abs(gAtMinus18 - 1.0f) < 1.0e-3f;
        // At 0 dB in the curve asks for -12 dB out -> -12 dB of gain.
        const bool limitAt0   = std::abs(xleth_apex::gainToDb(gAtZero) + 12.0f) < 0.2f;
        const bool limitAt6   = std::abs(xleth_apex::gainToDb(gAtPlus6) + 18.0f) < 0.2f;
        // Above the last node the GAIN is held, not the output.  The last node
        // is (+12 in, -12 out) so the held gain is -24 dB.  Holding the OUTPUT
        // instead would be wrong: it would turn the DEFAULT unity curve into a
        // brickwall limiter for anything hotter than +12 dBFS.
        const bool holdsGain  = std::abs(xleth_apex::gainToDb(lut.lookup(30.0f)) + 24.0f) < 0.2f;

        CHECK(unityBelow, "limiting curve is not unity below the knee");
        CHECK(limitAt0,   "limiting curve does not deliver -12 dB at 0 dB in");
        CHECK(limitAt6,   "limiting curve does not keep limiting above the knee");
        CHECK(holdsGain,  "curve does not hold the endpoint GAIN above the last node");
        report("curve: node limiting shape", unityBelow && limitAt0 && limitAt6 && holdsGain,
               "g(0dB)=" + std::to_string(xleth_apex::gainToDb(gAtZero)) + " dB");
    }

    // Tension must stay monotone and pinned at both segment ends.
    {
        bool ok = true;
        for (float tension : { -1.0f, -0.5f, 0.0f, 0.5f, 1.0f })
        {
            ok = ok && std::abs(xleth_apex::tensionWarp(0.0f, tension) - 0.0f) < 1.0e-5f;
            ok = ok && std::abs(xleth_apex::tensionWarp(1.0f, tension) - 1.0f) < 1.0e-5f;
            float prev = -1.0f;
            for (float t = 0.0f; t <= 1.0f; t += 0.01f)
            {
                const float w = xleth_apex::tensionWarp(t, tension);
                ok = ok && w >= prev - 1.0e-6f;
                prev = w;
            }
        }
        // A non-zero tension must actually bend the curve.
        const bool bends = std::abs(xleth_apex::tensionWarp(0.5f, 1.0f)
                                    - xleth_apex::tensionWarp(0.5f, 0.0f)) > 0.1f;
        CHECK(ok,    "tension warp is not monotone / pinned");
        CHECK(bends, "tension has no effect on the segment shape");
        report("curve: per-segment tension", ok && bends, "");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Engine integration contract
// ═════════════════════════════════════════════════════════════════════════════

static void testParameterSurface()
{
    XlethApexEffect apex;
    apex.prepareToPlay(kSR, kBlock);

    auto has = [&apex](const std::string& id)
    {
        return apex.setParameterValue(id, apex.getParameterValue(id));
    };

    bool ok = true;
    for (const char* id : { "lowcut", "split_lo", "split_hi", "slope_lo",
                            "slope_hi", "lookahead", "bandmix" })
        ok = ok && has(id);

    for (int b = 0; b < XlethApexEffect::kNumBands; ++b)
        for (const char* s : { "state", "pre", "post", "att", "rel", "sus",
                               "det", "satth", "satcl", "sep" })
            ok = ok && has(XlethApexEffect::bandParamId(b, s));

    // SOLO exists on L/M/H only (spec 4.2).
    bool soloOk = true;
    for (int b = 0; b < 3; ++b)
        soloOk = soloOk && has(XlethApexEffect::bandParamId(b, "solo"));
    soloOk = soloOk && !has(XlethApexEffect::bandParamId(3, "solo"));

    // Documented defaults.
    const bool defaults =
        std::abs(apex.getParameterValue("split_lo")  -  200.0f) < 1.0f
     && std::abs(apex.getParameterValue("split_hi")  - 2000.0f) < 5.0f
     && std::abs(apex.getParameterValue("bandmix")   -  100.0f) < 0.01f
     && std::abs(apex.getParameterValue("lookahead") -    0.0f) < 0.01f
     && std::abs(apex.getParameterValue("lowcut")    -    0.0f) < 0.01f
     && apex.getParameterValue("slope_lo") > 0.5f
     && apex.getParameterValue("slope_hi") > 0.5f;

    CHECK(ok,       "a documented APEX parameter is missing");
    CHECK(soloOk,   "SOLO is not L/M/H-only");
    CHECK(defaults, "APEX defaults do not match the specification");
    report("parameter surface + defaults", ok && soloOk && defaults, "");
}

static void testLatencyPublication()
{
    const int la10ms = static_cast<int>(std::lround(0.010 * kSR));   // 480
    const int os     = xleth_apex::kOsLatencySamples;                // 47

    XlethApexEffect apex;
    apex.prepareToPlay(kSR, kBlock);
    const bool zeroDefault = apex.getReportedLatencySamples() == 0;

    apex.setParameterValue("lookahead", 10.0f);
    const bool lookaheadOnly = apex.getReportedLatencySamples() == la10ms;

    apex.setParameterValue(XlethApexEffect::bandParamId(2, "satth"), 60.0f);
    const bool plusBandSat = apex.getReportedLatencySamples() == la10ms + os;

    // A second saturating BAND must not add a second oversampler's latency —
    // the whole band stage shares one.
    apex.setParameterValue(XlethApexEffect::bandParamId(0, "satth"), -40.0f);
    const bool sharedBandStage = apex.getReportedLatencySamples() == la10ms + os;

    apex.setParameterValue(XlethApexEffect::bandParamId(3, "satth"), -30.0f);
    const bool plusMasterSat = apex.getReportedLatencySamples() == la10ms + 2 * os;

    // Band STATE / SOLO are deliberately latency-neutral: no graph re-plan for
    // an ordinary mixing gesture.
    const auto before = apex.getLatencyPublishCount();
    setStateAll(apex, 2.0f);
    apex.setParameterValue(XlethApexEffect::bandParamId(1, "solo"), 1.0f);
    const bool stateNeutral = apex.getLatencyPublishCount() == before
                           && apex.getReportedLatencySamples() == la10ms + 2 * os;

    CHECK(zeroDefault,     "APEX reports non-zero latency at defaults");
    CHECK(lookaheadOnly,   "LOOKAHEAD is not reported as latency");
    CHECK(plusBandSat,     "band saturation does not add the oversampler latency");
    CHECK(sharedBandStage, "a second saturating band double-counts the oversampler");
    CHECK(plusMasterSat,   "MASTER saturation does not add its oversampler latency");
    CHECK(stateNeutral,    "band state / solo changed the reported latency");
    report("latency publication", zeroDefault && lookaheadOnly && plusBandSat
                                  && sharedBandStage && plusMasterSat && stateNeutral,
           "0 / " + std::to_string(la10ms) + " / " + std::to_string(la10ms + os)
           + " / " + std::to_string(la10ms + 2 * os));
}

static void testStateRoundTrip()
{
    XlethApexEffect a;
    a.prepareToPlay(kSR, kBlock);

    a.setParameterValue("lookahead", 7.5f);
    a.setParameterValue("bandmix",   62.0f);
    a.setParameterValue("lowcut",    35.0f);
    a.setParameterValue("slope_lo",   0.0f);
    a.setParameterValue(XlethApexEffect::bandParamId(1, "pre"),   -6.0f);
    a.setParameterValue(XlethApexEffect::bandParamId(2, "satth"), 45.0f);
    a.setParameterValue(XlethApexEffect::bandParamId(3, "sep"),  -70.0f);

    std::vector<XlethApexEffect::CurveNode> nodes = {
        { -24.0f, -24.0f }, { -10.0f, -14.0f }, { 0.0f, -9.0f }, { 12.0f, -6.0f }
    };
    std::vector<float> tens = { 0.4f, -0.6f, 0.0f };
    const bool setOk = a.setBandCurve(0, nodes, tens);

    juce::MemoryBlock state;
    a.getStateInformation(state);

    XlethApexEffect b;
    b.prepareToPlay(kSR, kBlock);
    b.setStateInformation(state.getData(), static_cast<int>(state.getSize()));

    const bool params =
        std::abs(b.getParameterValue("lookahead") - 7.5f)  < 0.01f
     && std::abs(b.getParameterValue("bandmix")   - 62.0f) < 0.05f
     && std::abs(b.getParameterValue("lowcut")    - 35.0f) < 0.05f
     && b.getParameterValue("slope_lo") < 0.5f
     && std::abs(b.getParameterValue(XlethApexEffect::bandParamId(1, "pre"))   + 6.0f)  < 0.05f
     && std::abs(b.getParameterValue(XlethApexEffect::bandParamId(2, "satth")) - 45.0f) < 0.05f
     && std::abs(b.getParameterValue(XlethApexEffect::bandParamId(3, "sep"))   + 70.0f) < 0.05f;

    const bool curves  = a.getBandCurveJSON(0) == b.getBandCurveJSON(0);
    // Latency must be restored too, or PDC would be planned against stale data.
    const bool latency = a.getReportedLatencySamples() == b.getReportedLatencySamples();

    // JSON form of the curve API round-trips as well.
    XlethApexEffect c;
    c.prepareToPlay(kSR, kBlock);
    const bool json = c.setBandCurveJSON(0, a.getBandCurveJSON(0))
                   && c.getBandCurveJSON(0) == a.getBandCurveJSON(0);

    CHECK(setOk,   "setBandCurve rejected a valid curve");
    CHECK(params,  "parameters did not survive the state round trip");
    CHECK(curves,  "curve nodes did not survive the state round trip");
    CHECK(latency, "reported latency was not restored from state");
    CHECK(json,    "curve JSON round trip failed");
    report("state round trip (params + curves + latency)",
           setOk && params && curves && latency && json, "");
}

// ═════════════════════════════════════════════════════════════════════════════
// Visualization payload contract
// ═════════════════════════════════════════════════════════════════════════════
//
// The bridge test (bridge/test_apex_bridge.js) proves the payload TRANSPORTS —
// that a drain returns the right type tag, bucket size and cadence. It cannot
// prove the payload is CORRECT, because a headless engine has no signal to
// measure. This test does that half: it pushes a known tone through a known
// configuration and reads the emitted buckets directly.
//
// The four things worth being wrong here, and how each is pinned:
//   • the FFT reads the INPUT, not the lookahead-delayed dry leg — checked by
//     running with a large LOOKAHEAD, which would shift the spectrum's source
//     if the tap were on the wrong side of the ring;
//   • the magnitude normalisation is calibrated — a 0 dBFS sine must read 0 dB,
//     not N/4 (a plain unscaled FFT would read +54 dB here);
//   • the peak lands in the bin the tone actually occupies;
//   • gain reduction is reported POSITIVE, matching every other bucket type.
static void testVisualizationPayload()
{
    XlethApexEffect a;

    // A hard downward curve on the MASTER band so there is real gain reduction
    // to report, plus a non-zero LOOKAHEAD so a spectrum tapped on the wrong
    // side of the delay ring would be visibly different.
    a.setParameterValue("lookahead", 15.0f);
    a.setBandCurve(3,
                   { { -24.0f, -24.0f }, { -12.0f, -18.0f }, { 12.0f, -12.0f } },
                   { 0.0f, 0.0f });
    a.prepareToPlay(kSR, kBlock);

    // Disabled by default: a drain before any enable must be empty, and the
    // audio path must not have touched a collector that does not exist.
    std::vector<std::uint8_t> scratch(sizeof(xleth::viz::ApexBucket) * 8);
    const bool emptyBeforeEnable =
        a.drainVizFrames(scratch.data(), scratch.size()) == 0;

    a.setVisualizationEnabled(true);

    // 1 kHz at 0 dBFS. At kSR = 48000 with a 2048-point FFT the bin width is
    // 23.4375 Hz, so 1 kHz lands exactly on bin 42 (42 * 23.4375 == 984.375 is
    // the nearest bin centre; the Hann main lobe is 4 bins wide, so the peak
    // is required to be within 2 bins rather than exactly on one).
    constexpr double kToneHz = 1000.0;
    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;

    // ~0.4 s — comfortably more than the 1024-sample bucket period, so many
    // buckets are produced and the FFT history is fully primed with the tone.
    const int totalSamples = static_cast<int>(kSR * 0.4);
    for (int n = 0; n < totalSamples; n += kBlock)
    {
        for (int s = 0; s < kBlock; ++s)
        {
            const double t = static_cast<double>(n + s) / kSR;
            const float  v = static_cast<float>(
                std::sin(2.0 * juce::MathConstants<double>::pi * kToneHz * t));
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }
        a.processBlock(buf, midi);
    }

    // Drain everything the ring holds. The ring is only kApexVizRingDepth deep
    // by design, so this keeps the newest buckets and silently drops older
    // ones — which is exactly the intended overflow behaviour.
    std::vector<std::uint8_t> raw(sizeof(xleth::viz::ApexBucket)
                                  * xleth::viz::kApexVizRingDepth);
    const std::size_t bytes = a.drainVizFrames(raw.data(), raw.size());
    const std::size_t count = bytes / sizeof(xleth::viz::ApexBucket);

    const bool gotBuckets    = count > 0;
    const bool wholeBuckets  = (bytes % sizeof(xleth::viz::ApexBucket)) == 0;
    const bool typeTag       = a.getVisualizationType() == xleth::viz::kVizTypeApex;
    const bool bucketIs4176  = sizeof(xleth::viz::ApexBucket) == 4176;

    bool  peakBinOk    = false;
    bool  peakLevelOk  = false;
    bool  grPositive   = false;
    bool  latencyOk    = false;
    bool  binCountOk   = false;
    bool  bandLevelsOk = false;
    float peakDb       = -999.0f;
    int   peakBin      = -1;

    if (gotBuckets)
    {
        // Use the LAST bucket: by then the 2048-sample FFT history is entirely
        // tone, with no start-up silence left in the window.
        const auto* b = reinterpret_cast<const xleth::viz::ApexBucket*>(
            raw.data() + (count - 1) * sizeof(xleth::viz::ApexBucket));

        binCountOk = std::abs(b->spectrumBins
                              - static_cast<float>(xleth::viz::kApexVizSpectrumBins)) < 0.5f;

        for (int k = 0; k < static_cast<int>(xleth::viz::kApexVizSpectrumBins); ++k)
        {
            if (b->spectrum[k] > peakDb) { peakDb = b->spectrum[k]; peakBin = k; }
        }

        const int expectedBin = static_cast<int>(std::lround(
            kToneHz * static_cast<double>(xleth::viz::kApexVizFftSize) / kSR));
        peakBinOk = std::abs(peakBin - expectedBin) <= 2;

        // A full-scale sine must read 0 dB. 1.5 dB of slack covers the tone
        // falling between bins (scalloping loss) — an uncalibrated FFT would
        // be out by 20*log10(2048/4) = +54 dB, nowhere near this window.
        peakLevelOk = std::abs(peakDb) < 1.5f;

        // MASTER's curve maps everything to at most -12 dB out, so it is
        // certainly reducing; the sign convention is what is under test.
        grPositive = b->bandGrDb[3] > 1.0f;

        latencyOk = std::abs(b->lookaheadSamples
                             - static_cast<float>(a.getLookaheadSamples())) < 0.5f
                 && std::abs(b->latencySamples
                             - static_cast<float>(a.getReportedLatencySamples())) < 0.5f;

        // Every band reports a finite level, and the summed input is loud.
        bandLevelsOk = b->inputPeakDb > -3.0f && b->inputPeakDb < 1.0f;
        for (int i = 0; i < 4; ++i)
            bandLevelsOk = bandLevelsOk && std::isfinite(b->bandOutDb[i])
                                        && std::isfinite(b->bandGrDb[i]);
    }

    // Disabling must stop the stream without disturbing audio.
    a.setVisualizationEnabled(false);
    for (int n = 0; n < 4 * kBlock; n += kBlock)
    {
        buf.clear();
        a.processBlock(buf, midi);
    }
    const bool emptyAfterDisable =
        a.drainVizFrames(scratch.data(), scratch.size()) == 0;

    CHECK(bucketIs4176,      "ApexBucket is not 4176 bytes");
    CHECK(typeTag,           "getVisualizationType() did not report kVizTypeApex");
    CHECK(emptyBeforeEnable, "buckets were produced before visualization was enabled");
    CHECK(gotBuckets,        "no viz buckets were produced while enabled");
    CHECK(wholeBuckets,      "drainVizFrames returned a partial bucket");
    CHECK(binCountOk,        "bucket did not declare kApexVizSpectrumBins bins");
    CHECK(peakBinOk,         "spectrum peak is not at the tone's bin");
    CHECK(peakLevelOk,       "0 dBFS sine did not read ~0 dB (normalisation is wrong)");
    CHECK(grPositive,        "MASTER gain reduction was not reported as positive dB");
    CHECK(latencyOk,         "bucket latency fields disagree with the effect");
    CHECK(bandLevelsOk,      "per-band levels were not finite / input level wrong");
    CHECK(emptyAfterDisable, "buckets were still produced after disable");

    report("visualization payload (spectrum + GR + levels)",
           bucketIs4176 && typeTag && emptyBeforeEnable && gotBuckets && wholeBuckets
           && binCountOk && peakBinOk && peakLevelOk && grPositive && latencyOk
           && bandLevelsOk && emptyAfterDisable,
           "peakBin=" + std::to_string(peakBin)
           + " peakDb=" + std::to_string(peakDb)
           + " buckets=" + std::to_string(count));
}

// The all-bands curve getter must agree, band for band, with the per-band
// getter — otherwise an editor that loads via one and undoes via the other
// would silently desync.
static void testAllCurvesJSON()
{
    XlethApexEffect a;
    a.prepareToPlay(kSR, kBlock);

    a.setBandCurve(0, { { -24.0f, -24.0f }, { 0.0f, -6.0f }, { 12.0f, -3.0f } },
                      { 0.5f, -0.25f });
    a.setBandCurve(2, { { -24.0f, -20.0f }, { 12.0f, 12.0f } }, { 0.9f });

    const std::string all = a.getAllCurvesJSON();
    nlohmann::json j = nlohmann::json::parse(all, nullptr, false);

    bool ok = !j.is_discarded() && j.contains("bands") && j["bands"].is_array()
           && j["bands"].size() == static_cast<std::size_t>(XlethApexEffect::kNumBands);

    if (ok)
    {
        for (int b = 0; b < XlethApexEffect::kNumBands; ++b)
        {
            nlohmann::json per = nlohmann::json::parse(a.getBandCurveJSON(b), nullptr, false);
            const auto& fromAll = j["bands"][static_cast<std::size_t>(b)];
            ok = ok && !per.is_discarded()
                    && fromAll["band"]     == b
                    && fromAll["nodes"]    == per["nodes"]
                    && fromAll["tensions"] == per["tensions"];
        }
    }

    CHECK(ok, "getAllCurvesJSON disagrees with getBandCurveJSON");
    report("all-bands curve JSON matches per-band JSON", ok, "");
}

// ═════════════════════════════════════════════════════════════════════════════
// (a) Band-split reconstruction
// ═════════════════════════════════════════════════════════════════════════════

static void testReconstructionFlat()
{
    constexpr int order = 15;                 // 32768 samples ~= 0.68 s
    constexpr int n     = 1 << order;

    struct Case { float slopeLo, slopeHi, splitLo, splitHi; const char* name; };
    const Case cases[] = {
        { 1.0f, 1.0f,  200.0f,  2000.0f, "LR4/LR4 200 Hz / 2 kHz" },
        { 0.0f, 0.0f,  200.0f,  2000.0f, "LR2/LR2 200 Hz / 2 kHz" },
        { 0.0f, 1.0f,  200.0f,  2000.0f, "LR2/LR4 200 Hz / 2 kHz" },
        { 1.0f, 0.0f,  200.0f,  2000.0f, "LR4/LR2 200 Hz / 2 kHz" },
        { 1.0f, 1.0f,   40.0f, 18000.0f, "LR4/LR4 40 Hz / 18 kHz"  },
        { 0.0f, 0.0f, 1000.0f,  1000.0f, "LR2/LR2 coincident 1 kHz" },
    };

    for (const auto& c : cases)
    {
        auto ir = renderImpulse(n, [&c](XlethApexEffect& a)
        {
            setStateAll(a, 1.0f);                       // COMP OFF on every band
            a.setParameterValue("bandmix",  100.0f);
            a.setParameterValue("slope_lo", c.slopeLo);
            a.setParameterValue("slope_hi", c.slopeHi);
            a.setParameterValue("split_lo", c.splitLo);
            a.setParameterValue("split_hi", c.splitHi);
        });

        const auto db = magnitudeDb(ir.l, order);

        // Bin width 1.465 Hz: 20 Hz .. 20 kHz.
        const int lo = static_cast<int>(std::ceil(20.0    * n / kSR));
        const int hi = static_cast<int>(std::floor(20000.0 * n / kSR));

        // magnitudeDb() normalises for a SINE (factor 2/N).  A unit impulse has
        // |X[k]| = 1 at every bin, so a perfectly flat response reads
        // 20*log10(2/N) dB, not 0 dB — that constant is the reference here.
        const float refDb = 20.0f * std::log10(2.0f / static_cast<float>(n));

        float worst = 0.0f;
        for (int k = lo; k <= hi; ++k)
            worst = std::max(worst, std::abs(db[static_cast<std::size_t>(k)] - refDb));

        const bool ok = worst <= 0.5f;
        CHECK(ok, std::string("band-split reconstruction is not flat: ") + c.name);
        report((std::string("(a) reconstruction flat +/-0.5 dB — ") + c.name).c_str(),
               ok, "worst deviation " + std::to_string(worst) + " dB");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// (b) LOOKAHEAD latency
// ═════════════════════════════════════════════════════════════════════════════

static void testLookaheadLatency()
{
    const int expected = static_cast<int>(std::lround(0.010 * kSR));   // 480

    // -- dry leg: a literal impulse, so the delay is directly readable --------
    {
        XlethApexEffect probe;
        probe.setParameterValue("lookahead", 10.0f);
        probe.prepareToPlay(kSR, kBlock);
        const int reported = probe.getReportedLatencySamples();

        auto ir = renderImpulse(4096, [](XlethApexEffect& a)
        {
            a.setParameterValue("lookahead", 10.0f);
            a.setParameterValue("bandmix",    0.0f);    // pure dry leg
            setStateAll(a, 3.0f);                       // every band OFF
        });

        int   peakIdx = -1;
        float peak = 0.0f, energyElsewhere = 0.0f;
        for (std::size_t i = 0; i < ir.l.size(); ++i)
            if (std::abs(ir.l[i]) > peak) { peak = std::abs(ir.l[i]); peakIdx = static_cast<int>(i); }
        for (std::size_t i = 0; i < ir.l.size(); ++i)
            if (static_cast<int>(i) != peakIdx) energyElsewhere += std::abs(ir.l[i]);

        const bool okReported = reported == expected;
        const bool okPos      = peakIdx == expected;
        const bool okClean    = std::abs(peak - 1.0f) < 1.0e-6f && energyElsewhere < 1.0e-6f;

        CHECK(okReported, "10 ms LOOKAHEAD is not reported as 480 samples at 48 kHz");
        CHECK(okPos,      "dry leg impulse does not arrive at the reported latency");
        CHECK(okClean,    "dry leg is not a clean unit impulse");
        report("(b) LOOKAHEAD 10 ms == reported latency (dry-leg impulse)",
               okReported && okPos && okClean,
               "reported " + std::to_string(reported) + ", impulse at "
               + std::to_string(peakIdx));
    }

    // -- band leg: the whole band path must shift by exactly the same amount --
    {
        auto base = render(8192, [](XlethApexEffect& a)
        {
            setStateAll(a, 1.0f);
            a.setParameterValue("lookahead", 0.0f);
        }, compositeTone);

        auto shifted = render(8192, [](XlethApexEffect& a)
        {
            setStateAll(a, 1.0f);
            a.setParameterValue("lookahead", 10.0f);
        }, compositeTone);

        bool  leadingSilent = true;
        for (int i = 0; i < expected; ++i)
            leadingSilent = leadingSilent && shifted.l[static_cast<std::size_t>(i)] == 0.0f;

        bool  bitExact = true;
        float worst = 0.0f;
        for (int i = expected; i < 8192; ++i)
        {
            const float d = std::abs(shifted.l[static_cast<std::size_t>(i)]
                                   - base.l[static_cast<std::size_t>(i - expected)]);
            worst = std::max(worst, d);
            bitExact = bitExact && d == 0.0f;
        }

        CHECK(leadingSilent, "band leg is not silent before the reported latency");
        CHECK(bitExact,      "band leg is not a bit-exact shift by the reported latency");
        report("(b) LOOKAHEAD shifts the band leg bit-exactly",
               leadingSilent && bitExact,
               "worst sample delta " + std::to_string(worst));
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// (c) BAND MIX dry / band alignment
// ═════════════════════════════════════════════════════════════════════════════
//
// If the dry leg and the band leg were not sample-aligned, the 50 % render
// could not equal the arithmetic mean of the 0 % and 100 % renders: any delay
// mismatch shows up immediately as a large residual on transient material.
//
// Tolerance: 1e-6 absolute on a signal peaking near 1.0 (about -120 dBFS).
// This is float rounding only — the 50 % path evaluates dry + m*(band - dry)
// while the reference evaluates 0.5*dry + 0.5*band, which differ by at most a
// couple of ULP.  A one-sample misalignment on this material produces a
// residual of order 1e-1, five orders of magnitude above the threshold.
static void testBandMixAlignment()
{
    struct Case { float lookahead; float highSat; const char* name; };
    const Case cases[] = {
        { 0.0f,   0.0f, "lookahead 0 ms, no saturation" },
        { 10.0f,  0.0f, "lookahead 10 ms, no saturation" },
        { 10.0f, 100.0f, "lookahead 10 ms + HIGH saturation (oversampler engaged)" },
    };

    for (const auto& c : cases)
    {
        auto make = [&c](float mix)
        {
            return [&c, mix](XlethApexEffect& a)
            {
                a.setParameterValue("lookahead", c.lookahead);
                a.setParameterValue("bandmix",   mix);
                a.setParameterValue(XlethApexEffect::bandParamId(2, "satth"), c.highSat);
                setStateAll(a, 1.0f);   // COMP OFF: gains/sat/sep still active
            };
        };

        const int n = 16384;
        auto dry  = render(n, make(0.0f),   compositeTone);
        auto wet  = render(n, make(100.0f), compositeTone);
        auto half = render(n, make(50.0f),  compositeTone);

        float worst = 0.0f, peak = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            const auto j = static_cast<std::size_t>(i);
            const float ref = 0.5f * (dry.l[j] + wet.l[j]);
            worst = std::max(worst, std::abs(half.l[j] - ref));
            peak  = std::max(peak, std::abs(wet.l[j]));
        }

        const bool ok = worst <= 1.0e-6f;
        CHECK(ok, std::string("BAND MIX legs are not sample-aligned: ") + c.name);
        report((std::string("(c) BAND MIX dry/band alignment — ") + c.name).c_str(), ok,
               "residual " + std::to_string(worst) + " (limit 1e-6, peak "
               + std::to_string(peak) + ")");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// (d) Saturation aliasing
// ═════════════════════════════════════════════════════════════════════════════
//
// Analysis frequency is chosen to land on an exact FFT bin (bin 853 of 8192 at
// 48 kHz = 4998.05 Hz, "5 kHz") so a rectangular window leaks nothing.  Genuine
// harmonics then land exactly on multiples of bin 853 and are excluded;
// everything else in 20 Hz .. 20 kHz is an aliasing product and must sit below
// -60 dBFS.
//
// Documented limit of the analysis band: 2x oversampling cannot protect the
// last ~1/8th of the spectrum, because the decimator's transition band straddles
// base-Nyquist by construction.  The 5th harmonic (24.99 kHz) folds to 23 kHz —
// above the 20 kHz audio band and outside the checked range.  Anything below
// 20 kHz is fully covered by the >= 80 dB stopband.
static void testSaturationAliasing()
{
    constexpr int order   = 13;             // 8192
    constexpr int n       = 1 << order;
    constexpr int binK    = 853;
    const double  freq    = kSR * binK / n; // 4998.05 Hz

    for (float thresh : { 100.0f, -100.0f })
    {
        auto out = render(3 * n, [thresh](XlethApexEffect& a)
        {
            a.setParameterValue("split_hi", 2000.0f);
            a.setParameterValue("bandmix", 100.0f);
            // Isolate the HIGH band: LOW and MID muted, MASTER bypassed.
            a.setParameterValue(XlethApexEffect::bandParamId(0, "state"), 2.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(1, "state"), 2.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(2, "state"), 1.0f);  // COMP OFF
            a.setParameterValue(XlethApexEffect::bandParamId(3, "state"), 3.0f);  // OFF
            a.setParameterValue(XlethApexEffect::bandParamId(2, "satth"), thresh);
            a.setParameterValue(XlethApexEffect::bandParamId(2, "satcl"), 0.0f);
        }, [freq](int i, float& l, float& r)
        {
            l = r = static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi
                                                * freq * i / kSR));
        });

        const auto db = magnitudeDb(out.l, order);

        const int loBin = static_cast<int>(std::ceil(20.0    * n / kSR));   // ~4
        const int hiBin = static_cast<int>(std::floor(20000.0 * n / kSR));  // ~3413

        float worst = -200.0f;
        int   worstBin = -1;
        for (int k = loBin; k <= hiBin; ++k)
        {
            // Skip genuine harmonics (multiples of the fundamental's bin) and
            // their two neighbouring bins.
            const int m = k % binK;
            if (m <= 2 || m >= binK - 2) continue;
            if (db[static_cast<std::size_t>(k)] > worst)
            {
                worst = db[static_cast<std::size_t>(k)];
                worstBin = k;
            }
        }

        // Sanity: the fundamental must actually be there, and the shaper must
        // actually have produced harmonic distortion (otherwise "no aliasing"
        // would be trivially true because nothing happened).
        const float fundamental = db[static_cast<std::size_t>(binK)];
        const float third       = db[static_cast<std::size_t>(3 * binK)];
        const bool  didSomething = fundamental > -6.0f && third > -40.0f;

        const bool ok = worst < -60.0f && didSomething;
        CHECK(worst < -60.0f, "saturation produced aliasing above -60 dBFS below 20 kHz");
        CHECK(didSomething,   "saturation produced no harmonic distortion at +/-100 %");
        report((std::string("(d) SAT ") + (thresh > 0 ? "+100 % (mode B)" : "-100 % (mode A)")
                + " aliasing < -60 dBFS").c_str(), ok,
               "worst " + std::to_string(worst) + " dBFS @ bin " + std::to_string(worstBin)
               + " (" + std::to_string(worstBin * kSR / n) + " Hz), 3rd harmonic "
               + std::to_string(third) + " dBFS");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// (e) Band states
// ═════════════════════════════════════════════════════════════════════════════

static void testBandStates()
{
    constexpr int n = 8192;

    // -- MUTED contributes digital silence ------------------------------------
    {
        auto out = render(n, [](XlethApexEffect& a)
        {
            a.setParameterValue("bandmix", 100.0f);
            for (int b = 0; b < 3; ++b)
                a.setParameterValue(XlethApexEffect::bandParamId(b, "state"), 2.0f);  // MUTED
            a.setParameterValue(XlethApexEffect::bandParamId(3, "state"), 1.0f);      // COMP OFF
        }, compositeTone);

        bool silent = true;
        for (int i = 0; i < n; ++i)
            silent = silent && out.l[static_cast<std::size_t>(i)] == 0.0f
                            && out.r[static_cast<std::size_t>(i)] == 0.0f;

        CHECK(silent, "MUTED bands do not produce digital silence");
        report("(e) MUTED bands == digital silence", silent, "");
    }

    // -- MUTED is instantaneous even with the oversampler engaged -------------
    {
        auto out = render(n, [](XlethApexEffect& a)
        {
            a.setParameterValue("bandmix", 100.0f);
            for (int b = 0; b < 3; ++b)
                a.setParameterValue(XlethApexEffect::bandParamId(b, "state"), 2.0f);
            // A saturating (but muted) band still engages the shared band-stage
            // delay — the mute must not leak its 47-sample tail.
            a.setParameterValue(XlethApexEffect::bandParamId(2, "satth"), 80.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(3, "state"), 3.0f);
        }, compositeTone);

        bool silent = true;
        for (int i = 0; i < n; ++i)
            silent = silent && out.l[static_cast<std::size_t>(i)] == 0.0f;

        CHECK(silent, "MUTED band leaks audio through the saturation-stage delay");
        report("(e) MUTED stays silent with the oversampler engaged", silent, "");
    }

    // -- OFF is bit-transparent ----------------------------------------------
    // With every knob at its default, COMP OFF applies no gain, no saturation
    // and no separation, so it must be bit-for-bit identical to OFF (which skips
    // the DSP entirely).  Any stage that ran unconditionally — even a multiply
    // by 1.0 in the M/S matrix, which is NOT exact in float — breaks this.
    {
        auto offRender = render(n, [](XlethApexEffect& a)
        {
            a.setParameterValue("bandmix", 100.0f);
            setStateAll(a, 3.0f);                        // every band OFF
        }, compositeTone);

        auto compOffRender = render(n, [](XlethApexEffect& a)
        {
            a.setParameterValue("bandmix", 100.0f);
            setStateAll(a, 1.0f);                        // every band COMP OFF
        }, compositeTone);

        bool  identical = true;
        float worst = 0.0f, peak = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            const auto j = static_cast<std::size_t>(i);
            worst = std::max(worst, std::abs(offRender.l[j] - compOffRender.l[j]));
            peak  = std::max(peak, std::abs(offRender.l[j]));
            identical = identical && offRender.l[j] == compOffRender.l[j]
                                  && offRender.r[j] == compOffRender.r[j];
        }

        const bool nonTrivial = peak > 0.1f;
        CHECK(identical,   "OFF is not bit-transparent (differs from a unity COMP OFF band)");
        CHECK(nonTrivial,  "OFF bit-transparency test ran on a silent signal");
        report("(e) OFF band is bit-transparent dry", identical && nonTrivial,
               "worst delta " + std::to_string(worst) + ", peak "
               + std::to_string(peak));
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Feature spot-checks
// ═════════════════════════════════════════════════════════════════════════════

static void testDynamicsCurveActuallyCompresses()
{
    // MASTER only: bands OFF, BAND MIX 100 %, MASTER ON with a hard limiting
    // curve (flat output above -12 dB in).  A 0 dBFS sine must come out at
    // about -12 dBFS.
    auto out = render(24000, [](XlethApexEffect& a)
    {
        a.setParameterValue("bandmix", 100.0f);
        for (int b = 0; b < 3; ++b)
            a.setParameterValue(XlethApexEffect::bandParamId(b, "state"), 3.0f);
        a.setParameterValue(XlethApexEffect::bandParamId(3, "state"), 0.0f);   // ON
        a.setParameterValue(XlethApexEffect::bandParamId(3, "att"),   1.0f);
        a.setParameterValue(XlethApexEffect::bandParamId(3, "rel"),  50.0f);
        a.setBandCurve(3,
            { { -24.0f, -24.0f }, { -12.0f, -12.0f }, { 12.0f, -12.0f } },
            { 0.0f, 0.0f });
    }, [](int i, float& l, float& r)
    {
        l = r = static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi
                                            * 500.0 * i / kSR));
    });

    float peak = 0.0f;
    for (std::size_t i = 12000; i < out.l.size(); ++i)   // settled region
        peak = std::max(peak, std::abs(out.l[i]));
    const float db = xleth_apex::gainToDb(peak);

    const bool ok = std::abs(db + 12.0f) < 1.5f;
    CHECK(ok, "dynamics curve does not limit a 0 dBFS sine to about -12 dBFS");
    report("curve LUT is wired into the audio path", ok,
           std::to_string(db) + " dBFS (expected -12 +/-1.5)");
}

static void testStereoSeparation()
{
    auto sideEnergy = [](float sep)
    {
        auto out = render(8192, [sep](XlethApexEffect& a)
        {
            a.setParameterValue("bandmix", 100.0f);
            setStateAll(a, 1.0f);
            for (int b = 0; b < 3; ++b)
                a.setParameterValue(XlethApexEffect::bandParamId(b, "sep"), sep);
        }, compositeTone);

        double e = 0.0;
        for (std::size_t i = 1000; i < out.l.size(); ++i)
        {
            const double s = 0.5 * (out.l[i] - out.r[i]);
            e += s * s;
        }
        return e;
    };

    const double mono   = sideEnergy(-100.0f);
    const double unity  = sideEnergy(0.0f);
    const double widen  = sideEnergy(100.0f);

    const bool monoOk  = mono < unity * 1.0e-6;
    const bool wideOk  = widen > unity * 3.0 && widen < unity * 5.0;   // ~4x energy

    CHECK(monoOk, "STEREO SEP at -100 % does not collapse to mono");
    CHECK(wideOk, "STEREO SEP at +100 % does not double the side signal");
    report("STEREO SEP -100 % mono / +100 % double side", monoOk && wideOk,
           "side energy " + std::to_string(mono) + " / " + std::to_string(unity)
           + " / " + std::to_string(widen));
}

static void testSoloAndLowCut()
{
    // SOLO on HIGH must remove the 60 Hz sub content.
    auto soloed = render(16384, [](XlethApexEffect& a)
    {
        a.setParameterValue("bandmix", 100.0f);
        setStateAll(a, 1.0f);
        a.setParameterValue(XlethApexEffect::bandParamId(2, "solo"), 1.0f);
    }, compositeTone);

    auto plain = render(16384, [](XlethApexEffect& a)
    {
        a.setParameterValue("bandmix", 100.0f);
        setStateAll(a, 1.0f);
    }, compositeTone);

    double eSolo = 0.0, ePlain = 0.0;
    for (std::size_t i = 2000; i < plain.l.size(); ++i)
    {
        eSolo  += static_cast<double>(soloed.l[i]) * soloed.l[i];
        ePlain += static_cast<double>(plain.l[i])  * plain.l[i];
    }
    const bool soloOk = eSolo < ePlain * 0.2;

    // LOW CUT at 100 Hz must strongly attenuate a 40 Hz tone.
    auto lowCutOn = render(16384, [](XlethApexEffect& a)
    {
        a.setParameterValue("bandmix", 100.0f);
        a.setParameterValue("lowcut", 100.0f);
        setStateAll(a, 1.0f);
    }, [](int i, float& l, float& r)
    {
        l = r = static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi
                                            * 40.0 * i / kSR));
    });

    float peak = 0.0f;
    for (std::size_t i = 8000; i < lowCutOn.l.size(); ++i)
        peak = std::max(peak, std::abs(lowCutOn.l[i]));
    // 24 dB/oct, 1.32 octaves below the corner -> about -31 dB.
    const bool lowCutOk = xleth_apex::gainToDb(peak) < -20.0f;

    CHECK(soloOk,   "SOLO on HIGH does not remove low-band energy");
    CHECK(lowCutOk, "LOW CUT at 100 Hz does not attenuate 40 Hz");
    report("SOLO (L/M/H) and LOW CUT", soloOk && lowCutOk,
           "solo energy ratio " + std::to_string(eSolo / std::max(ePlain, 1e-30))
           + ", 40 Hz through 100 Hz HPF " + std::to_string(xleth_apex::gainToDb(peak))
           + " dB");
}

static void testOutputIsFiniteUnderStress()
{
    auto out = render(48000, [](XlethApexEffect& a)
    {
        a.setParameterValue("lookahead", 20.0f);
        a.setParameterValue("bandmix",   73.0f);
        a.setParameterValue("lowcut",    50.0f);
        a.setParameterValue("slope_lo",   0.0f);
        for (int b = 0; b < XlethApexEffect::kNumBands; ++b)
        {
            a.setParameterValue(XlethApexEffect::bandParamId(b, "pre"),   12.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(b, "post"),  -6.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(b, "satth"), b % 2 ? 90.0f : -90.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(b, "satcl"), -12.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(b, "sep"),   40.0f);
            a.setParameterValue(XlethApexEffect::bandParamId(b, "det"),    1.0f);   // RMS
            a.setParameterValue(XlethApexEffect::bandParamId(b, "sus"),   80.0f);
            a.setBandCurve(b,
                { { -24.0f, -18.0f }, { -12.0f, -8.0f }, { 0.0f, -4.0f }, { 12.0f, -2.0f } },
                { 0.7f, -0.7f, 0.3f });
        }
    }, compositeTone);

    bool  finite = true;
    float peak = 0.0f;
    for (std::size_t i = 0; i < out.l.size(); ++i)
    {
        finite = finite && std::isfinite(out.l[i]) && std::isfinite(out.r[i]);
        peak = std::max(peak, std::max(std::abs(out.l[i]), std::abs(out.r[i])));
    }
    const bool bounded = peak < 8.0f;

    CHECK(finite,  "APEX produced a non-finite sample with every stage engaged");
    CHECK(bounded, "APEX output ran away with every stage engaged");
    report("all stages engaged: finite and bounded", finite && bounded,
           "peak " + std::to_string(peak));
}

// ═════════════════════════════════════════════════════════════════════════════

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_apex_primitives ===\n";
    testOversamplerRoundTrip();
    testCurveLutCompilation();

    std::cout << "\n=== test_apex_integration ===\n";
    testParameterSurface();
    testLatencyPublication();
    testStateRoundTrip();
    testAllCurvesJSON();
    testVisualizationPayload();

    std::cout << "\n=== test_apex_contract (a) band-split reconstruction ===\n";
    testReconstructionFlat();

    std::cout << "\n=== test_apex_contract (b) lookahead latency ===\n";
    testLookaheadLatency();

    std::cout << "\n=== test_apex_contract (c) BAND MIX alignment ===\n";
    testBandMixAlignment();

    std::cout << "\n=== test_apex_contract (d) saturation aliasing ===\n";
    testSaturationAliasing();

    std::cout << "\n=== test_apex_contract (e) band states ===\n";
    testBandStates();

    std::cout << "\n=== test_apex_features ===\n";
    testDynamicsCurveActuallyCompresses();
    testStereoSeparation();
    testSoloAndLowCut();
    testOutputIsFiniteUnderStress();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}

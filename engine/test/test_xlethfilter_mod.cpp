// test_xlethfilter_mod.cpp — XlethFilterEffect modulation layer
// Build: cmake --build build --config Release --target test_xlethfilter_mod
// Run:   build\engine\Release\test_xlethfilter_mod.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers the Prompt-2 modulation contract:
//   (a) the in-effect dynamics follower tracks the slot's own input and the
//       resulting cutoff never leaves [cut_min, cut_max]
//   (b) the octave-space sum is what gets clamped: a 10 kHz base cutoff with
//       cut_max = 3 kHz is pulled DOWN to 3 kHz
//   (c) dyn_depth = 0 is provably inert — bit-identical output even when the
//       cut_min/cut_max range would savage the cutoff if the follower ran
//   (d) the 303 accent lag accumulates across rapid transients: the third
//       sweep peaks higher than the first, then decays (design doc §4.3)
//   (e) every s{i}_* param is reachable as an FX-graph parameter target, and
//       driving s0_cutoff through the real lfomod -> envmod mapping produces a
//       measurable periodic sweep bounded by base..base+depth
//   (f) fastest ballistics into a Q = 20 SVF stays finite and bounded
//   (g) negative depth ducks — loud input CLOSES the filter
//
// Nothing here reaches into engine internals: the follower is observed through
// the public dynamics telemetry (getSlotEffectiveCutoff / getSlotEffectiveQ /
// getSlotAccentCharge) AND, independently, through what the audio actually
// does to a high-frequency probe tone.  A telemetry value that disagreed with
// the audio would fail one assertion or the other.

#include "audio/EffectChainManager.h"
#include "audio/XlethFilterEffect.h"
#include "model/EnvelopeParameterModulation.h"
#include "model/LfoParameterModulation.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";        \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

static constexpr double kSR = 44100.0;
static constexpr double kPi = juce::MathConstants<double>::pi;

// ─── Utilities ───────────────────────────────────────────────────────────────

// Single-bin DFT magnitude (amplitude, not power) of `freq` over `n` samples.
// Far more selective than a broadband RMS, so a probe tone's fate through the
// filter can be measured while a much louder driver tone is also present.
static double toneMagnitude(const std::vector<float>& x, int from, int n,
                            double freq, double sr)
{
    if (n <= 0 || from < 0 || from + n > static_cast<int>(x.size())) return 0.0;
    double re = 0.0, im = 0.0;
    const double w = 2.0 * kPi * freq / sr;
    for (int i = 0; i < n; ++i)
    {
        const double ph = w * i;
        re += x[static_cast<size_t>(from + i)] * std::cos(ph);
        im -= x[static_cast<size_t>(from + i)] * std::sin(ph);
    }
    return 2.0 * std::sqrt(re * re + im * im) / n;
}

static bool allFinite(const std::vector<float>& x)
{
    for (float v : x) if (!std::isfinite(v)) return false;
    return true;
}

static float maxAbs(const std::vector<float>& x)
{
    float m = 0.0f;
    for (float v : x) m = std::max(m, std::abs(v));
    return m;
}

// One filter slot, fully specified including the dynamics params.
struct SlotSetup
{
    int   type    = 0;        // LP12
    float cutoff  = 1000.0f;
    float q       = 0.7071f;
    int   slope   = 1;        // 12 dB
    float cutMin  = 20.0f;
    float cutMax  = 20000.0f;
    float depth   = 0.0f;
    float attack  = 10.0f;
    float release = 100.0f;
};

static int makeSlot(XlethFilterEffect& fx, const SlotSetup& s)
{
    const int i = fx.addSlot();
    fx.setSlotParam(i, "type",        static_cast<float>(s.type));
    fx.setSlotParam(i, "cutoff",      s.cutoff);
    fx.setSlotParam(i, "q",           s.q);
    fx.setSlotParam(i, "slope",       static_cast<float>(s.slope));
    fx.setSlotParam(i, "mix",         1.0f);
    fx.setSlotParam(i, "enabled",     1.0f);
    fx.setSlotParam(i, "cut_min",     s.cutMin);
    fx.setSlotParam(i, "cut_max",     s.cutMax);
    fx.setSlotParam(i, "dyn_depth",   s.depth);
    fx.setSlotParam(i, "dyn_attack",  s.attack);
    fx.setSlotParam(i, "dyn_release", s.release);
    return i;
}

// What the dynamics telemetry did while a stretch of audio was processed.
struct DynTrace
{
    float minCutoff = 1.0e9f;
    float maxCutoff = 0.0f;
    float minQ      = 1.0e9f;
    float maxQ      = 0.0f;
    float maxAccent = 0.0f;

    void sample(const XlethFilterEffect& fx, int slot)
    {
        const float c = fx.getSlotEffectiveCutoff(slot);
        const float q = fx.getSlotEffectiveQ(slot);
        minCutoff = std::min(minCutoff, c);
        maxCutoff = std::max(maxCutoff, c);
        minQ      = std::min(minQ, q);
        maxQ      = std::max(maxQ, q);
        maxAccent = std::max(maxAccent, fx.getSlotAccentCharge(slot));
    }
};

// Drive `numSamples` of (driver sine at `driverHz`, amplitude `driverAmp`) plus
// a constant small probe tone at `probeHz`, appending the filter output to
// `out` and sampling the telemetry once per block.
struct ToneRunner
{
    XlethFilterEffect& fx;
    int    slot   = 0;
    int    block  = 256;
    double drvPh  = 0.0;
    double prbPh  = 0.0;

    void run(int numSamples, double driverHz, float driverAmp,
             double probeHz, float probeAmp,
             std::vector<float>& out, DynTrace* trace)
    {
        juce::AudioBuffer<float> buf(2, block);
        juce::MidiBuffer midi;
        const double dInc = 2.0 * kPi * driverHz / kSR;
        const double pInc = 2.0 * kPi * probeHz / kSR;

        for (int done = 0; done < numSamples; done += block)
        {
            const int n = std::min(block, numSamples - done);
            buf.setSize(2, n, false, false, true);
            for (int i = 0; i < n; ++i)
            {
                const float v = driverAmp * static_cast<float>(std::sin(drvPh))
                              + probeAmp  * static_cast<float>(std::sin(prbPh));
                drvPh += dInc; if (drvPh >= 2.0 * kPi) drvPh -= 2.0 * kPi;
                prbPh += pInc; if (prbPh >= 2.0 * kPi) prbPh -= 2.0 * kPi;
                buf.setSample(0, i, v);
                buf.setSample(1, i, v);
            }
            fx.processBlock(buf, midi);
            const float* p = buf.getReadPointer(0);
            for (int i = 0; i < n; ++i) out.push_back(p[i]);
            if (trace) trace->sample(fx, slot);
        }
    }

    // Run silence until the 20 ms parameter smoothers have arrived.  cut_min /
    // cut_max are smoothed like every other continuous param, so immediately
    // after a slot is configured the CLAMP WINDOW is still gliding from the
    // construction defaults (20 Hz .. 20 kHz) toward the requested range — the
    // steady-state bound assertions below are only meaningful after that.
    void settle(std::vector<float>& out)
    {
        run(static_cast<int>(0.1 * kSR), 200.0, 0.0f, 200.0, 0.0f, out, nullptr);
    }
};

static juce::RangedAudioParameter* findParam(XlethFilterEffect& fx, const char* id)
{
    for (auto* p : fx.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p))
            if (rp->paramID == id) return rp;
    return nullptr;
}

// ─── (a) Dynamics follower tracks the input ──────────────────────────────────

static void testFollowerTracksInput()
{
    std::cout << "  [a: follower tracks a loud/quiet burst train]\n";

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);

    SlotSetup s;
    s.type = 0; s.cutoff = 300.0f; s.q = 0.7071f; s.slope = 1;
    s.cutMin = 300.0f; s.cutMax = 3000.0f; s.depth = 1.0f;
    s.attack = 5.0f;  s.release = 60.0f;
    const int slot = makeSlot(fx, s);

    ToneRunner run{ fx, slot, 256 };
    DynTrace trace;

    // Eight alternating 186 ms sections of a 200 Hz driver, loud then quiet,
    // with a constant 5 kHz probe riding along so the cutoff's travel is
    // audible rather than merely reported.
    constexpr int kSection = 8192;
    constexpr int kSections = 8;
    std::vector<float> settleOut, out;
    out.reserve(kSection * kSections);
    run.settle(settleOut);

    for (int sec = 0; sec < kSections; ++sec)
    {
        const bool loud = (sec % 2) == 0;
        run.run(kSection, 200.0, loud ? 0.9f : 0.0f, 5000.0, 0.02f, out, &trace);
    }

    // Measure the probe over the LAST half of the last loud and last quiet
    // section, by which point the 60 ms release has long settled.
    const int loudFrom  = 6 * kSection + kSection / 2;
    const int quietFrom = 7 * kSection + kSection / 2;
    const double probeLoud  = toneMagnitude(out, loudFrom,  kSection / 2, 5000.0, kSR);
    const double probeQuiet = toneMagnitude(out, quietFrom, kSection / 2, 5000.0, kSR);

    std::cout << "      cutoff " << trace.minCutoff << " .. " << trace.maxCutoff
              << " Hz;  5 kHz probe loud=" << probeLoud
              << "  quiet=" << probeQuiet << "\n";

    CHECK(allFinite(out), "burst train produces no NaN/inf");
    CHECK(probeLoud > probeQuiet * 4.0,
          "high frequencies pass during loud bursts and are attenuated during "
          "quiet sections (loud " << probeLoud << " vs quiet " << probeQuiet << ")");
    CHECK(trace.maxCutoff > 2000.0f,
          "the follower actually opens the filter, peak cutoff "
              << trace.maxCutoff << " Hz");
    CHECK(trace.minCutoff < 400.0f,
          "the follower actually closes the filter, min cutoff "
              << trace.minCutoff << " Hz");
    CHECK(trace.minCutoff >= 300.0f * 0.999f && trace.maxCutoff <= 3000.0f * 1.001f,
          "cutoff never leaves [300, 3000] Hz (saw " << trace.minCutoff
              << " .. " << trace.maxCutoff << ")");

    // The shallow Q route rides the same envelope (the 303 behaviour).
    CHECK(trace.maxQ > trace.minQ * 1.05f,
          "dyn_depth also opens Q by the fixed shallow ratio (" << trace.minQ
              << " -> " << trace.maxQ << ")");
    CHECK(trace.maxQ <= 30.0f + 1e-3f && trace.minQ >= 0.5f - 1e-3f,
          "modulated Q stays inside the [0.5, 30] guard rails");
}

// ─── (b) The SUM is what gets clamped ────────────────────────────────────────

static void testBoundedSum()
{
    std::cout << "  [b: clamp the sum, not the sources]\n";

    // Base cutoff parked at 10 kHz, but the user range tops out at 3 kHz.  The
    // composed result must be pulled DOWN to 3 kHz — clamping the sources
    // independently (or clamping only to the [10 Hz, 0.45 fs] hard rails) would
    // leave the filter wide open at 10 kHz.
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);

    SlotSetup s;
    s.cutoff = 10000.0f; s.cutMin = 300.0f; s.cutMax = 3000.0f;
    s.depth = 1.0f; s.attack = 5.0f; s.release = 60.0f;
    const int slot = makeSlot(fx, s);

    ToneRunner run{ fx, slot, 256 };
    DynTrace trace;
    std::vector<float> settleOut, out;
    run.settle(settleOut);
    run.run(44100, 200.0, 0.9f, 8000.0, 0.05f, out, &trace);

    // Reference: the identical filter with the follower off, cutoff at 10 kHz.
    XlethFilterEffect ref;
    ref.prepareToPlay(kSR, 256);
    SlotSetup r = s;
    r.depth = 0.0f;
    const int refSlot = makeSlot(ref, r);
    ToneRunner runRef{ ref, refSlot, 256 };
    std::vector<float> refSettle, refOut;
    runRef.settle(refSettle);
    runRef.run(44100, 200.0, 0.9f, 8000.0, 0.05f, refOut, nullptr);

    const int from = 22050;
    const double probe    = toneMagnitude(out,    from, 22050, 8000.0, kSR);
    const double probeRef = toneMagnitude(refOut, from, 22050, 8000.0, kSR);

    std::cout << "      cutoff " << trace.minCutoff << " .. " << trace.maxCutoff
              << " Hz;  8 kHz probe clamped=" << probe << "  ref=" << probeRef << "\n";

    CHECK(trace.maxCutoff <= 3000.0f * 1.001f,
          "cutoff never exceeds cut_max even with a 10 kHz base, peak "
              << trace.maxCutoff << " Hz");
    CHECK(trace.minCutoff >= 300.0f * 0.999f,
          "cutoff never drops below cut_min, min " << trace.minCutoff << " Hz");
    CHECK(probe < probeRef * 0.2,
          "an 8 kHz probe is >= 14 dB more attenuated once the sum is clamped "
          "to cut_max (" << probe << " vs unclamped " << probeRef << ")");
}

// ─── (c) dyn_depth = 0 is exactly inert ──────────────────────────────────────

static void testZeroDepthIsInert()
{
    std::cout << "  [c: dyn_depth = 0 is bit-identical]\n";

    // Same filter twice.  `armed` carries a cut_min/cut_max window that would
    // pin the cutoff into [500, 600] Hz if the follower path ran at all; `plain`
    // leaves the range at its defaults.  Both have dyn_depth = 0, so their
    // outputs must be identical to the last bit.
    SlotSetup armed;
    armed.cutoff = 4000.0f; armed.cutMin = 500.0f; armed.cutMax = 600.0f;
    armed.depth = 0.0f; armed.attack = 0.1f; armed.release = 1.0f;

    SlotSetup plain = armed;
    plain.cutMin = 20.0f; plain.cutMax = 20000.0f;
    plain.attack = 50.0f; plain.release = 500.0f;

    XlethFilterEffect a, b;
    a.prepareToPlay(kSR, 256);
    b.prepareToPlay(kSR, 256);
    const int sa = makeSlot(a, armed);
    const int sb = makeSlot(b, plain);

    ToneRunner runA{ a, sa, 256 };
    ToneRunner runB{ b, sb, 256 };
    std::vector<float> outA, outB;
    runA.run(22050, 200.0, 0.9f, 6000.0, 0.1f, outA, nullptr);
    runB.run(22050, 200.0, 0.9f, 6000.0, 0.1f, outB, nullptr);

    bool identical = (outA.size() == outB.size());
    size_t firstDiff = 0;
    for (size_t i = 0; identical && i < outA.size(); ++i)
        if (outA[i] != outB[i]) { identical = false; firstDiff = i; }

    CHECK(identical,
          "dyn_depth = 0 leaves the signal bit-identical regardless of the "
          "cut_min/cut_max window (first difference at sample " << firstDiff << ")");

    // And the telemetry agrees the follower never ran.
    CHECK(a.getSlotDynamicEnvelope(sa) == 0.0f,
          "an inert follower reports a zero envelope");
    CHECK(a.getSlotAccentCharge(sa) == 0.0f,
          "an inert follower reports a zero accent charge");
    CHECK(std::abs(a.getSlotEffectiveCutoff(sa) - 4000.0f) < 20.0f,
          "an inert slot's effective cutoff is just its parameter, got "
              << a.getSlotEffectiveCutoff(sa) << " Hz");
}

// ─── (d) 303 accent memory (design doc §4.3 acceptance patch) ────────────────

static void testAccentMemory()
{
    std::cout << "  [d: 303 accent lag accumulates across rapid transients]\n";

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 32);

    // The acid patch: cutoff parked low, resonant, follower depth substantial
    // over a wide sweep range, fast attack and a short decay.
    SlotSetup s;
    s.type = 0; s.cutoff = 300.0f; s.q = 8.0f; s.slope = 1;
    s.cutMin = 200.0f; s.cutMax = 12000.0f; s.depth = 0.35f;
    s.attack = 1.0f; s.release = 15.0f;
    const int slot = makeSlot(fx, s);

    // 32-sample blocks so the telemetry is read once per control block — a
    // 30 ms transient is only ~1300 samples wide.
    ToneRunner run{ fx, slot, 32 };
    std::vector<float> out;

    const int burst = static_cast<int>(0.030 * kSR);   // 30 ms note
    const int gap   = static_cast<int>(0.080 * kSR);   // 80 ms silence

    // Let the smoothers settle before the first transient.
    DynTrace warm;
    run.run(4096, 200.0, 0.0f, 200.0, 0.0f, out, &warm);

    float peak[3] = { 0.0f, 0.0f, 0.0f };
    float accentAt[3] = { 0.0f, 0.0f, 0.0f };

    for (int k = 0; k < 3; ++k)
    {
        DynTrace burstTrace;
        run.run(burst, 200.0, 0.9f, 200.0, 0.0f, out, &burstTrace);
        peak[k]     = burstTrace.maxCutoff;
        accentAt[k] = burstTrace.maxAccent;

        DynTrace gapTrace;
        run.run(gap, 200.0, 0.0f, 200.0, 0.0f, out, &gapTrace);
    }

    // Long silence: the lag must leak away rather than latch.
    DynTrace tail;
    run.run(static_cast<int>(0.8 * kSR), 200.0, 0.0f, 200.0, 0.0f, out, &tail);

    std::cout << "      accent sweep peaks: " << peak[0] << " -> " << peak[1]
              << " -> " << peak[2] << " Hz  (charge " << accentAt[0] << " / "
              << accentAt[1] << " / " << accentAt[2] << ")\n";
    std::cout << "      after decay: cutoff " << fx.getSlotEffectiveCutoff(slot)
              << " Hz, accent " << fx.getSlotAccentCharge(slot) << "\n";

    CHECK(allFinite(out), "the accent run produces no NaN/inf");
    CHECK(peak[0] > 1000.0f,
          "the first transient sweeps the filter open, peak " << peak[0] << " Hz");
    CHECK(peak[1] >= peak[0],
          "the second sweep is at least as high as the first (" << peak[0]
              << " -> " << peak[1] << ")");
    CHECK(peak[2] > peak[0] * 1.02f,
          "the THIRD sweep reaches a measurably higher cutoff than the first — "
          "the accent lag did not reset between transients (" << peak[0]
              << " -> " << peak[2] << " Hz)");
    CHECK(accentAt[2] > accentAt[0],
          "accent charge accumulates across transients (" << accentAt[0]
              << " -> " << accentAt[2] << ")");
    CHECK(fx.getSlotAccentCharge(slot) < accentAt[2] * 0.1f,
          "the accent lag leaks away after the run rather than latching (charge "
              << fx.getSlotAccentCharge(slot) << ")");
    CHECK(fx.getSlotEffectiveCutoff(slot) < 400.0f,
          "the cutoff settles back to its parked value, got "
              << fx.getSlotEffectiveCutoff(slot) << " Hz");
}

// ─── (e) FX-graph exposure + the real lfomod drive path ──────────────────────

static void testGraphParameterExposure()
{
    std::cout << "  [e1: every s{i}_* param is an FX-graph parameter target]\n";

    EffectChainManager chain;
    chain.init(kSR, 256);
    const int nodeId = chain.addGraphNode("inst-filter", "xlethfilter");
    CHECK(nodeId >= 0, "xlethfilter can be added as a graph node");

    const nlohmann::json out = chain.getGraphEffectParameters("inst-filter");
    CHECK(out.value("ok", false), "getGraphEffectParameters succeeds for xlethfilter");
    CHECK(out.value("effectKind", std::string()) == "stock", "xlethfilter is a stock effect");

    const auto& params = out["parameters"];
    CHECK(static_cast<int>(params.size()) == XlethFilterEffect::kMaxSlots * 14,
          "all 14 params of all 8 slots are exposed, got " << params.size());

    // Index by id so every slot suffix can be checked, including the five the
    // dynamics follower owns.
    std::vector<std::string> ids;
    bool allStable = true, allNormalized = true;
    for (const auto& p : params)
    {
        const std::string id = p.value("parameterId", std::string());
        ids.push_back(id);
        if (p.value("parameterIdIsFallback", true)) allStable = false;
        const double nv = p.value("normalizedValue", -1.0);
        if (!(nv >= 0.0 && nv <= 1.0)) allNormalized = false;
    }
    CHECK(allStable, "every xlethfilter parameter exposes a stable (non-fallback) id");
    CHECK(allNormalized, "every exposed normalizedValue is within [0, 1]");

    auto has = [&ids](const std::string& id) {
        return std::find(ids.begin(), ids.end(), id) != ids.end();
    };
    bool everySlot = true;
    for (int i = 0; i < XlethFilterEffect::kMaxSlots; ++i)
        for (const char* suffix : { "enabled", "type", "cutoff", "q", "gain",
                                    "morph", "slope", "drive", "mix",
                                    "cut_min", "cut_max", "dyn_depth",
                                    "dyn_attack", "dyn_release" })
            if (!has("s" + std::to_string(i) + "_" + suffix)) everySlot = false;
    CHECK(everySlot,
          "every slot exposes all nine DSP params plus the five dynamics params");

    // A graph edge addresses the target as {kind:"graph-parameter",
    // effectInstanceId, parameterId} and writes NORMALISED — exactly this call.
    const nlohmann::json set =
        chain.setGraphEffectParameterNormalized("inst-filter", "s0_dyn_depth", 1.0f);
    CHECK(set.value("ok", false), "a graph edge can write s0_dyn_depth");
    const nlohmann::json readBack =
        chain.getGraphEffectParameterValue("inst-filter", "s0_dyn_depth");
    CHECK(std::abs(readBack.value("normalizedValue", -1.0) - 1.0) < 0.01,
          "the normalised write round-trips");

    const nlohmann::json setCut =
        chain.setGraphEffectParameterNormalized("inst-filter", "s7_cut_max", 0.25f);
    CHECK(setCut.value("ok", false), "a graph edge can write the last slot's s7_cut_max");
}

static void testLfoDrivesCutoff()
{
    std::cout << "  [e2: lfomod -> envmod mapping sweeps s0_cutoff]\n";

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);

    SlotSetup s;
    s.cutoff = 1000.0f; s.q = 0.7071f; s.depth = 0.0f;   // graph path only
    const int slot = makeSlot(fx, s);

    auto* cutoffParam = findParam(fx, "s0_cutoff");
    CHECK(cutoffParam != nullptr, "s0_cutoff resolves as a RangedAudioParameter");
    if (!cutoffParam) return;

    // The mapping a graph edge carries: base + signed depth, both in the
    // parameter's NORMALISED domain — which for the log-skewed cutoff range is
    // approximately-octave space, for free.
    const float baseHz = 300.0f, topHz = 6000.0f;
    xleth::envmod::ModulationMapping mapping;
    mapping.enabled   = true;
    mapping.base      = cutoffParam->convertTo0to1(baseHz);
    mapping.depth     = cutoffParam->convertTo0to1(topHz) - mapping.base;
    mapping.sourceMin = 0.0;
    mapping.sourceMax = 1.0;
    mapping.curve     = xleth::envmod::MappingCurve::Linear;

    // A rest-state source value maps to EXACTLY base — the property that makes
    // an idle modulator inert.
    const double atRest = xleth::envmod::evaluateModulationMapping(mapping, mapping.sourceMin);
    CHECK(atRest == mapping.base,
          "evaluateModulationMapping at the source floor returns base exactly ("
              << atRest << " vs " << mapping.base << ")");

    // 2 Hz free-running LFO, empty waveform = the sine fallback.
    xleth::lfomod::LfoShape shape;
    shape.rateMode = xleth::lfomod::RateMode::Free;
    shape.rateMs   = 500.0;      // 1000/500 = 2 Hz
    CHECK(std::abs(xleth::lfomod::lfoCycleHz(shape, 120.0) - 2.0) < 1e-9,
          "free-mode LFO rate is 2 Hz");

    juce::AudioBuffer<float> buf(2, 256);
    juce::MidiBuffer midi;
    double phase = 0.0;
    const double inc = 2.0 * kPi * 6000.0 / kSR;   // 6 kHz probe

    std::vector<float> cutoffTrace;
    std::vector<float> out;
    int64_t pos = 0;
    const int blocks = static_cast<int>(2.0 * kSR / 256);   // 2 s = 4 LFO cycles

    for (int b = 0; b < blocks; ++b)
    {
        // Exactly what MixEngine's applier does, minus the mailbox hop: evaluate
        // the stateless LFO at the absolute transport position, rescale bipolar
        // -> unipolar, run the edge's mapping, write the normalised result.
        const double bipolar  = xleth::lfomod::evaluateLfoAtPosition(shape, pos, 120.0, kSR);
        const double unipolar = (bipolar + 1.0) * 0.5;
        const double value    = xleth::envmod::evaluateModulationMapping(mapping, unipolar);
        cutoffParam->setValueNotifyingHost(static_cast<float>(value));

        for (int i = 0; i < 256; ++i)
        {
            const float v = 0.2f * static_cast<float>(std::sin(phase));
            phase += inc; if (phase >= 2.0 * kPi) phase -= 2.0 * kPi;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        fx.processBlock(buf, midi);

        const float* p = buf.getReadPointer(0);
        for (int i = 0; i < 256; ++i) out.push_back(p[i]);
        cutoffTrace.push_back(fx.getSlotEffectiveCutoff(slot));
        pos += 256;
    }

    float lo = 1.0e9f, hi = 0.0f;
    for (float c : cutoffTrace) { lo = std::min(lo, c); hi = std::max(hi, c); }

    // Count upward crossings of the geometric midpoint: one per LFO cycle.
    const float mid = std::sqrt(lo * hi);
    int crossings = 0;
    for (size_t i = 1; i < cutoffTrace.size(); ++i)
        if (cutoffTrace[i - 1] <= mid && cutoffTrace[i] > mid) ++crossings;

    std::cout << "      graph-driven cutoff " << lo << " .. " << hi
              << " Hz over " << crossings << " cycles in 2 s\n";

    CHECK(allFinite(out), "the graph-driven sweep produces no NaN/inf");
    CHECK(hi > 4000.0f && lo < 500.0f,
          "the LFO produces a real sweep (" << lo << " .. " << hi << " Hz)");
    CHECK(lo >= baseHz * 0.9f && hi <= topHz * 1.1f,
          "the sweep stays within the mapping's base..base+depth bounds ("
              << lo << " .. " << hi << " Hz)");
    CHECK(crossings >= 3 && crossings <= 5,
          "the sweep is periodic at ~2 Hz, counted " << crossings
              << " cycles over 2 s");

    // env = 0 (source floor) settles the parameter at exactly base.
    cutoffParam->setValueNotifyingHost(static_cast<float>(mapping.base));
    for (int b = 0; b < 40; ++b)
    {
        buf.clear();
        fx.processBlock(buf, midi);
    }
    CHECK(std::abs(fx.getSlotEffectiveCutoff(slot) - baseHz) < baseHz * 0.02f,
          "writing the mapping's base settles the cutoff at " << baseHz
              << " Hz, got " << fx.getSlotEffectiveCutoff(slot));
}

// ─── (f) Fastest ballistics into a resonant SVF ──────────────────────────────

static void testFastBallisticsStability()
{
    std::cout << "  [f: fastest attack/release sweeping a Q = 20 SVF]\n";

    for (float depth : { 1.0f, -1.0f })
    {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, 64);

        SlotSetup s;
        s.cutoff = 1000.0f; s.q = 20.0f;
        s.cutMin = 100.0f;  s.cutMax = 15000.0f;
        s.depth = depth;
        s.attack = 0.1f;    s.release = 1.0f;    // the extremes of both ranges
        const int slot = makeSlot(fx, s);

        ToneRunner run{ fx, slot, 64 };
        DynTrace trace;
        std::vector<float> settleOut, out;
        run.settle(settleOut);

        // Alternate full-scale and silence every single block so the follower
        // slams between its rails inside one control block, repeatedly.
        for (int rep = 0; rep < 400; ++rep)
            run.run(64, 220.0, (rep % 2 == 0) ? 1.0f : 0.0f, 3000.0, 0.3f, out, &trace);

        CHECK(allFinite(out),
              "depth " << depth << ": fastest ballistics at Q=20 produce no NaN/inf");
        CHECK(maxAbs(out) < 2.0f,
              "depth " << depth << ": output stays bounded, peak " << maxAbs(out));
        CHECK(trace.minCutoff >= 100.0f * 0.999f && trace.maxCutoff <= 15000.0f * 1.001f,
              "depth " << depth << ": cutoff stays inside the user range ("
                  << trace.minCutoff << " .. " << trace.maxCutoff << ")");
        CHECK(trace.maxQ <= 30.0f + 1e-3f && trace.minQ >= 0.5f - 1e-3f,
              "depth " << depth << ": Q stays inside the guard rails ("
                  << trace.minQ << " .. " << trace.maxQ << ")");
    }
}

// ─── (g) Negative depth ducks ────────────────────────────────────────────────

static void testNegativeDepthDucks()
{
    std::cout << "  [g: negative depth closes the filter on loud input]\n";

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);

    // Base parked at the TOP of the range so a downward sweep has room.
    SlotSetup s;
    s.cutoff = 3000.0f; s.cutMin = 300.0f; s.cutMax = 3000.0f;
    s.depth = -1.0f; s.attack = 5.0f; s.release = 60.0f;
    const int slot = makeSlot(fx, s);

    ToneRunner run{ fx, slot, 256 };
    std::vector<float> settleOut, out;
    run.settle(settleOut);

    // Quiet first, then loud.
    DynTrace quiet;
    run.run(22050, 200.0, 0.0f, 2000.0, 0.05f, out, &quiet);
    const int loudFrom = static_cast<int>(out.size());
    DynTrace loud;
    run.run(44100, 200.0, 0.9f, 2000.0, 0.05f, out, &loud);

    const double probeQuiet = toneMagnitude(out, 11025, 11025, 2000.0, kSR);
    const double probeLoud  = toneMagnitude(out, loudFrom + 22050, 22050, 2000.0, kSR);

    std::cout << "      quiet cutoff ~" << quiet.maxCutoff
              << " Hz, loud cutoff min " << loud.minCutoff
              << " Hz;  2 kHz probe quiet=" << probeQuiet
              << " loud=" << probeLoud << "\n";

    CHECK(quiet.maxCutoff > 2500.0f,
          "a quiet input leaves the filter open at the base cutoff, got "
              << quiet.maxCutoff << " Hz");
    CHECK(loud.minCutoff < 600.0f,
          "a loud input CLOSES the filter with negative depth, min cutoff "
              << loud.minCutoff << " Hz");
    CHECK(probeLoud < probeQuiet * 0.35,
          "the 2 kHz probe is ducked by the loud input (" << probeLoud
              << " vs " << probeQuiet << ")");
    CHECK(loud.minCutoff >= 300.0f * 0.999f,
          "the ducking sweep still respects cut_min, got " << loud.minCutoff << " Hz");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);

    std::cout << "=== test_xlethfilter_mod_follower ===\n";
    testFollowerTracksInput();
    testBoundedSum();
    testZeroDepthIsInert();
    testNegativeDepthDucks();

    std::cout << "\n=== test_xlethfilter_mod_accent ===\n";
    testAccentMemory();

    std::cout << "\n=== test_xlethfilter_mod_graph ===\n";
    testGraphParameterExposure();
    testLfoDrivesCutoff();

    std::cout << "\n=== test_xlethfilter_mod_stability ===\n";
    testFastBallisticsStability();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}

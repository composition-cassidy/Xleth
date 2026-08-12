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

// The dynamics follower lives on modulator lane 0 throughout this file, so every
// pre-lanes follower assertion below is really asserting that ONE lane of kind
// Dyn behaves exactly like the fixed follower it replaced.
static constexpr int kDynLane = 0;

static int makeSlot(XlethFilterEffect& fx, const SlotSetup& s)
{
    const int i = fx.addSlot();
    fx.setSlotParam(i, "type",        static_cast<float>(s.type));
    fx.setSlotParam(i, "cutoff",      s.cutoff);
    fx.setSlotParam(i, "q",           s.q);
    fx.setSlotParam(i, "slope",       static_cast<float>(s.slope));
    fx.setSlotParam(i, "mix",         1.0f);
    fx.setSlotParam(i, "enabled",     1.0f);
    // Kind first: it resets the rest of the lane to that kind's defaults.
    fx.setSlotParam(i, "m0_kind",        static_cast<float>(xleth_filter::ModKind::Dyn));
    fx.setSlotParam(i, "m0_dest",        static_cast<float>(xleth_filter::ModDest::Cutoff));
    fx.setSlotParam(i, "m0_cut_min",     s.cutMin);
    fx.setSlotParam(i, "m0_cut_max",     s.cutMax);
    fx.setSlotParam(i, "m0_depth",       s.depth);
    fx.setSlotParam(i, "m0_dyn_attack",  s.attack);
    fx.setSlotParam(i, "m0_dyn_release", s.release);
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
    CHECK(static_cast<int>(params.size())
              == XlethFilterEffect::kMaxSlots * XlethFilterEffect::kNumSlotParams,
          "all " << XlethFilterEffect::kNumSlotParams
              << " params of all 8 slots are exposed, got " << params.size());

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
                                    "dyn_attack", "dyn_release",
                                    "lfo_on", "lfo_dest", "lfo_depth", "lfo_shape",
                                    "lfo_rate_mode", "lfo_rate_ms", "lfo_sync", "lfo_phase",
                                    "env_on", "env_dest", "env_depth", "env_attack",
                                    "env_hold", "env_decay", "env_sustain",
                                    "env_release", "env_slides" })
            if (!has("s" + std::to_string(i) + "_" + suffix)) everySlot = false;
    CHECK(everySlot,
          "every slot exposes the DSP + legacy dynamics/LFO/Envelope params");

    // ...and every modulator lane of every slot is a graph target too, so an
    // FX-graph edge can drive e.g. the depth of the third LFO on slot 5.
    bool everyLane = true;
    for (int i = 0; i < XlethFilterEffect::kMaxSlots; ++i)
        for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            for (const char* suffix : { "kind", "dest", "depth",
                                        "shape", "rate_mode", "rate_ms", "sync", "phase",
                                        "attack", "hold", "decay", "sustain", "release",
                                        "slides", "dyn_attack", "dyn_release",
                                        "cut_min", "cut_max" })
                if (!has("s" + std::to_string(i) + "_m" + std::to_string(j) + "_" + suffix))
                    everyLane = false;
    CHECK(everyLane, "every modulator lane of every slot is an FX-graph target");

    // A graph edge addresses the target as {kind:"graph-parameter",
    // effectInstanceId, parameterId} and writes NORMALISED — exactly this call.
    const nlohmann::json set =
        chain.setGraphEffectParameterNormalized("inst-filter", "s0_m0_depth", 1.0f);
    CHECK(set.value("ok", false), "a graph edge can write s0_m0_depth");
    const nlohmann::json readBack =
        chain.getGraphEffectParameterValue("inst-filter", "s0_m0_depth");
    CHECK(std::abs(readBack.value("normalizedValue", -1.0) - 1.0) < 0.01,
          "the normalised write round-trips");

    const nlohmann::json setCut = chain.setGraphEffectParameterNormalized(
        "inst-filter", "s7_m5_cut_max", 0.25f);
    CHECK(setCut.value("ok", false),
          "a graph edge can write the last slot's last lane, s7_m5_cut_max");
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

// ─── (h) In-effect LFO composes around the base cutoff ───────────────────────

static void testInEffectLfoSweep()
{
    std::cout << "  [h: in-effect LFO sweeps cutoff at its free rate]\n";

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);

    SlotSetup s;
    s.cutoff = 1000.0f; s.q = 0.7071f; s.depth = 0.0f;   // follower off
    const int slot = makeSlot(fx, s);

    // LFO on lane 1 (lane 0 is the follower makeSlot installs, left at depth 0).
    fx.setSlotParam(slot, "m1_kind",      static_cast<float>(xleth_filter::ModKind::Lfo));
    fx.setSlotParam(slot, "m1_dest",      0.0f);   // Cutoff
    fx.setSlotParam(slot, "m1_depth",     1.0f);
    fx.setSlotParam(slot, "m1_shape",     0.0f);   // Sine
    fx.setSlotParam(slot, "m1_rate_mode", 0.0f);   // Free
    fx.setSlotParam(slot, "m1_rate_ms",   500.0f); // 2 Hz
    XlethEffectBase::setGlobalBPM(120.0);

    juce::AudioBuffer<float> buf(2, 256);
    juce::MidiBuffer midi;
    int64_t pos = 0;

    // Settle the depth/activation ramps first (transport still advancing).
    for (int b = 0; b < 12; ++b)
    {
        XlethEffectBase::setGlobalTransportPositionSamples(pos);
        buf.clear(); fx.processBlock(buf, midi); pos += 256;
    }

    std::vector<float> trace;
    const int blocks = static_cast<int>(2.0 * kSR / 256);   // 2 s = 4 cycles
    std::vector<float> out;
    for (int b = 0; b < blocks; ++b)
    {
        XlethEffectBase::setGlobalTransportPositionSamples(pos);
        for (int i = 0; i < 256; ++i) { buf.setSample(0, i, 0.1f); buf.setSample(1, i, 0.1f); }
        fx.processBlock(buf, midi);
        const float* p = buf.getReadPointer(0);
        for (int i = 0; i < 256; ++i) out.push_back(p[i]);
        trace.push_back(fx.getSlotEffectiveCutoff(slot));
        pos += 256;
    }

    float lo = 1.0e9f, hi = 0.0f;
    for (float c : trace) { lo = std::min(lo, c); hi = std::max(hi, c); }
    const float mid = std::sqrt(lo * hi);
    int crossings = 0;
    for (size_t i = 1; i < trace.size(); ++i)
        if (trace[i - 1] <= mid && trace[i] > mid) ++crossings;

    std::cout << "      in-effect LFO cutoff " << lo << " .. " << hi
              << " Hz over " << crossings << " cycles in 2 s\n";

    CHECK(allFinite(out), "the in-effect LFO produces no NaN/inf");
    CHECK(hi > lo * 4.0f, "the LFO sweeps the cutoff (" << lo << " .. " << hi << " Hz)");
    CHECK(crossings >= 3 && crossings <= 5,
          "the in-effect sweep is periodic at ~2 Hz, counted " << crossings);
}

// ─── (i) In-effect LFO/Envelope OFF is provably inert ────────────────────────

static void testModulatorsOffAreInert()
{
    std::cout << "  [i: LFO/Env off is bit-identical regardless of their config]\n";

    // `armed` has both modulators fully configured but toggled OFF; `plain` has
    // them at defaults (also off). Both must be bit-identical.
    XlethFilterEffect a, b;
    a.prepareToPlay(kSR, 256);
    b.prepareToPlay(kSR, 256);

    SlotSetup s; s.cutoff = 1200.0f; s.depth = 0.0f;
    const int sa = makeSlot(a, s);
    const int sb = makeSlot(b, s);

    // Configure a's lanes aggressively but leave every one of them at kind Off.
    // Writing a lane's parameters without ever setting its kind must stay inert.
    a.setSlotParam(sa, "m1_depth", 1.0f); a.setSlotParam(sa, "m1_dest", 0.0f);
    a.setSlotParam(sa, "m1_rate_ms", 50.0f);
    a.setSlotParam(sa, "m2_depth", 1.0f); a.setSlotParam(sa, "m2_dest", 0.0f);
    a.setSlotParam(sa, "m2_attack", 1.0f); a.setSlotParam(sa, "m2_decay", 20.0f);
    a.setSlotParam(sa, "m3_depth", 1.0f); a.setSlotParam(sa, "m3_dest", 1.0f);
    XlethEffectBase::setGlobalBPM(120.0);
    XlethEffectBase::setGlobalTransportPositionSamples(0);

    ToneRunner runA{ a, sa, 256 };
    ToneRunner runB{ b, sb, 256 };
    std::vector<float> outA, outB;
    // A carries a gate too — must still be ignored while env is off.
    a.applyModulationGate(true, 0, 44100 * 10);
    runA.run(22050, 200.0, 0.9f, 6000.0, 0.1f, outA, nullptr);
    runB.run(22050, 200.0, 0.9f, 6000.0, 0.1f, outB, nullptr);

    bool identical = (outA.size() == outB.size());
    size_t firstDiff = 0;
    for (size_t i = 0; identical && i < outA.size(); ++i)
        if (outA[i] != outB[i]) { identical = false; firstDiff = i; }

    CHECK(identical,
          "LFO/Env toggled off leave the signal bit-identical even with a live "
          "gate and full depth configured (first diff at " << firstDiff << ")");
}

// ─── (j) In-effect Envelope opens the filter on a gate ───────────────────────

static void testInEffectEnvelopeGate()
{
    std::cout << "  [j: in-effect Envelope opens the cutoff while gated]\n";

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);

    SlotSetup s; s.cutoff = 500.0f; s.q = 0.7071f; s.depth = 0.0f;
    const int slot = makeSlot(fx, s);

    // Envelope on lane 1.
    fx.setSlotParam(slot, "m1_kind",    static_cast<float>(xleth_filter::ModKind::Env));
    fx.setSlotParam(slot, "m1_dest",    0.0f);   // Cutoff
    fx.setSlotParam(slot, "m1_depth",   1.0f);
    fx.setSlotParam(slot, "m1_attack",  1.0f);
    fx.setSlotParam(slot, "m1_hold",    0.0f);
    fx.setSlotParam(slot, "m1_decay",   30.0f);
    fx.setSlotParam(slot, "m1_sustain", 1.0f);
    fx.setSlotParam(slot, "m1_release", 30.0f);
    XlethEffectBase::setGlobalBPM(120.0);

    juce::AudioBuffer<float> buf(2, 256);
    juce::MidiBuffer midi;
    int64_t pos = 0;

    // No gate: cutoff parked at base.
    for (int b = 0; b < 12; ++b)
    {
        XlethEffectBase::setGlobalTransportPositionSamples(pos);
        fx.applyModulationGate(false, 0, 0);
        buf.clear(); fx.processBlock(buf, midi); pos += 256;
    }
    const float baseC = fx.getSlotEffectiveCutoff(slot);

    // Gate open from here for a long time: the envelope rises to sustain and
    // holds the cutoff wide open.
    const int64_t gateStart = pos;
    float peak = 0.0f;
    for (int b = 0; b < 24; ++b)
    {
        XlethEffectBase::setGlobalTransportPositionSamples(pos);
        fx.applyModulationGate(true, gateStart, gateStart + static_cast<int64_t>(kSR) * 10);
        buf.clear(); fx.processBlock(buf, midi);
        peak = std::max(peak, fx.getSlotEffectiveCutoff(slot));
        pos += 256;
    }

    std::cout << "      base cutoff " << baseC << " Hz, gated peak " << peak << " Hz\n";

    CHECK(std::abs(baseC - 500.0f) < 60.0f,
          "no gate: the Envelope is at rest and the cutoff sits at its base ("
              << baseC << " Hz)");
    CHECK(peak > baseC * 4.0f,
          "a note gate drives the Envelope and opens the cutoff (peak "
              << peak << " Hz)");
}

// ─── (k) Several lanes at once ───────────────────────────────────────────────

// Drive a slot for `seconds` of silence-free tone and report the min/max of the
// two effective-parameter telemetry channels. Used to prove which knob a given
// lane actually moved.
struct LaneSweep { float cutLo = 1e9f, cutHi = 0.0f, qLo = 1e9f, qHi = 0.0f; };

static LaneSweep runAndTrack(XlethFilterEffect& fx, int slot, double seconds)
{
    juce::AudioBuffer<float> buf(2, 256);
    juce::MidiBuffer midi;
    LaneSweep sw;
    int64_t pos = 0;

    // Let the activation + depth ramps arrive before measuring.
    for (int b = 0; b < 24; ++b)
    {
        XlethEffectBase::setGlobalTransportPositionSamples(pos);
        buf.clear(); fx.processBlock(buf, midi); pos += 256;
    }
    const int blocks = static_cast<int>(seconds * kSR / 256);
    for (int b = 0; b < blocks; ++b)
    {
        XlethEffectBase::setGlobalTransportPositionSamples(pos);
        for (int i = 0; i < 256; ++i) { buf.setSample(0, i, 0.1f); buf.setSample(1, i, 0.1f); }
        fx.processBlock(buf, midi);
        const float c = fx.getSlotEffectiveCutoff(slot);
        const float q = fx.getSlotEffectiveQ(slot);
        sw.cutLo = std::min(sw.cutLo, c); sw.cutHi = std::max(sw.cutHi, c);
        sw.qLo   = std::min(sw.qLo,   q); sw.qHi   = std::max(sw.qHi,   q);
        pos += 256;
    }
    return sw;
}

// Configure lane `j` as a free-running sine LFO on `dest`.
static void makeLfoLane(XlethFilterEffect& fx, int slot, int j,
                        xleth_filter::ModDest dest, float depth, float rateMs)
{
    fx.setSlotParam(slot, "m" + std::to_string(j) + "_kind",
                    static_cast<float>(xleth_filter::ModKind::Lfo));
    fx.setSlotParam(slot, "m" + std::to_string(j) + "_dest",      static_cast<float>(dest));
    fx.setSlotParam(slot, "m" + std::to_string(j) + "_depth",     depth);
    fx.setSlotParam(slot, "m" + std::to_string(j) + "_shape",     0.0f);   // Sine
    fx.setSlotParam(slot, "m" + std::to_string(j) + "_rate_mode", 0.0f);   // Free
    fx.setSlotParam(slot, "m" + std::to_string(j) + "_rate_ms",   rateMs);
}

// Two LFOs on DIFFERENT destinations each move only their own knob — the whole
// point of the feature: an LFO on Q and something else on cutoff.
static void testTwoLanesDifferentDests()
{
    std::cout << "  [k1: two LFO lanes on different destinations are independent]\n";

    XlethEffectBase::setGlobalBPM(120.0);

    // Reference: an LFO on cutoff only. Q must sit perfectly still.
    XlethFilterEffect cutOnly;
    cutOnly.prepareToPlay(kSR, 256);
    SlotSetup s; s.cutoff = 1000.0f; s.q = 2.0f; s.depth = 0.0f;
    const int scut = makeSlot(cutOnly, s);
    makeLfoLane(cutOnly, scut, 1, xleth_filter::ModDest::Cutoff, 1.0f, 500.0f);
    const LaneSweep a = runAndTrack(cutOnly, scut, 2.0);

    // Reference: an LFO on Q only. Cutoff must sit perfectly still.
    XlethFilterEffect qOnly;
    qOnly.prepareToPlay(kSR, 256);
    const int sq = makeSlot(qOnly, s);
    makeLfoLane(qOnly, sq, 1, xleth_filter::ModDest::Q, 1.0f, 300.0f);
    const LaneSweep b = runAndTrack(qOnly, sq, 2.0);

    // Both at once, on separate lanes of one slot.
    XlethFilterEffect both;
    both.prepareToPlay(kSR, 256);
    const int sb = makeSlot(both, s);
    makeLfoLane(both, sb, 1, xleth_filter::ModDest::Cutoff, 1.0f, 500.0f);
    makeLfoLane(both, sb, 2, xleth_filter::ModDest::Q,      1.0f, 300.0f);
    const LaneSweep c = runAndTrack(both, sb, 2.0);

    std::cout << "      cutoff-only: cut " << a.cutLo << ".." << a.cutHi
              << "  q " << a.qLo << ".." << a.qHi << "\n"
              << "      q-only:      cut " << b.cutLo << ".." << b.cutHi
              << "  q " << b.qLo << ".." << b.qHi << "\n"
              << "      both lanes:  cut " << c.cutLo << ".." << c.cutHi
              << "  q " << c.qLo << ".." << c.qHi << "\n";

    CHECK(a.cutHi > a.cutLo * 4.0f, "a lone cutoff LFO sweeps the cutoff");
    CHECK(a.qHi - a.qLo < 1.0e-3f,  "a lone cutoff LFO leaves Q untouched");
    CHECK(b.qHi > b.qLo * 1.5f,     "a lone Q LFO sweeps Q");
    CHECK(b.cutHi - b.cutLo < 1.0f, "a lone Q LFO leaves the cutoff untouched");

    // Running both changes neither one's range: the lanes do not interfere.
    CHECK(std::abs(c.cutHi - a.cutHi) < a.cutHi * 0.02f
       && std::abs(c.cutLo - a.cutLo) < a.cutHi * 0.02f,
          "adding a Q lane does not disturb the cutoff lane's sweep ("
              << c.cutLo << ".." << c.cutHi << " vs " << a.cutLo << ".." << a.cutHi << ")");
    CHECK(std::abs(c.qHi - b.qHi) < 0.05f && std::abs(c.qLo - b.qLo) < 0.05f,
          "adding a cutoff lane does not disturb the Q lane's sweep ("
              << c.qLo << ".." << c.qHi << " vs " << b.qLo << ".." << b.qHi << ")");
}

// Two lanes aimed at the SAME destination compose rather than one winning.
static void testTwoLanesSameDest()
{
    std::cout << "  [k2: two LFO lanes on one destination compose]\n";

    XlethEffectBase::setGlobalBPM(120.0);
    SlotSetup s; s.cutoff = 1000.0f; s.q = 0.7071f; s.depth = 0.0f;

    XlethFilterEffect one;
    one.prepareToPlay(kSR, 256);
    const int s1 = makeSlot(one, s);
    makeLfoLane(one, s1, 1, xleth_filter::ModDest::Cutoff, 0.4f, 500.0f);
    const LaneSweep a = runAndTrack(one, s1, 2.0);

    // A second identical lane, same phase and rate, must double the sweep in
    // OCTAVE space — the domain applyModToDest folds cutoff contributions in.
    XlethFilterEffect two;
    two.prepareToPlay(kSR, 256);
    const int s2 = makeSlot(two, s);
    makeLfoLane(two, s2, 1, xleth_filter::ModDest::Cutoff, 0.4f, 500.0f);
    makeLfoLane(two, s2, 2, xleth_filter::ModDest::Cutoff, 0.4f, 500.0f);
    const LaneSweep b = runAndTrack(two, s2, 2.0);

    const double octA = std::log2(a.cutHi / a.cutLo);
    const double octB = std::log2(b.cutHi / b.cutLo);
    std::cout << "      one lane " << a.cutLo << ".." << a.cutHi << " (" << octA
              << " oct), two lanes " << b.cutLo << ".." << b.cutHi
              << " (" << octB << " oct)\n";

    CHECK(octA > 0.5, "one lane sweeps a measurable span");
    CHECK(std::abs(octB - 2.0 * octA) < 0.15 * octA,
          "two identical lanes on one destination sweep twice the octave span ("
              << octB << " vs 2 x " << octA << ")");
}

// A lane can be removed and re-added, and removing one leaves the others alone.
static void testLaneRemovalKeepsOthers()
{
    std::cout << "  [k3: removing one lane leaves the other lanes running]\n";

    XlethEffectBase::setGlobalBPM(120.0);
    SlotSetup s; s.cutoff = 1000.0f; s.q = 2.0f; s.depth = 0.0f;

    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, 256);
    const int slot = makeSlot(fx, s);
    makeLfoLane(fx, slot, 1, xleth_filter::ModDest::Cutoff, 1.0f, 500.0f);
    makeLfoLane(fx, slot, 2, xleth_filter::ModDest::Q,      1.0f, 300.0f);
    const LaneSweep before = runAndTrack(fx, slot, 2.0);
    CHECK(before.cutHi > before.cutLo * 4.0f && before.qHi > before.qLo * 1.5f,
          "both lanes are running before the removal");

    // Remove the Q lane — a single write of its kind.
    fx.setSlotParam(slot, "m2_kind", static_cast<float>(xleth_filter::ModKind::Off));
    const LaneSweep after = runAndTrack(fx, slot, 2.0);
    std::cout << "      after removing the Q lane: cut " << after.cutLo << ".."
              << after.cutHi << "  q " << after.qLo << ".." << after.qHi << "\n";

    CHECK(after.qHi - after.qLo < 1.0e-3f, "the removed Q lane stopped modulating");
    CHECK(after.cutHi > after.cutLo * 4.0f,
          "the surviving cutoff lane still sweeps after its neighbour was removed");

    // Re-adding it brings it back with that kind's defaults, not the old depth.
    fx.setSlotParam(slot, "m2_kind", static_cast<float>(xleth_filter::ModKind::Lfo));
    const nlohmann::json readd = nlohmann::json::parse(fx.getSlotsAsJSON());
    CHECK(!readd.empty()
       && std::abs(readd[slot]["mods"][2]["depth"].get<float>() - 0.5f) < 1.0e-4f,
          "re-adding a lane resets it to its kind's default depth");
}

// Every lane Off is bit-identical to a filter that never had lanes configured.
static void testAllLanesOffAreInert()
{
    std::cout << "  [k4: every lane Off is bit-identical to no modulation]\n";

    SlotSetup s; s.cutoff = 1500.0f; s.q = 1.5f; s.depth = 0.0f;

    XlethFilterEffect plain, armed;
    plain.prepareToPlay(kSR, 256);
    armed.prepareToPlay(kSR, 256);
    const int sp = makeSlot(plain, s);
    const int sa = makeSlot(armed, s);

    // `armed` gets every lane fully configured and then switched back Off.
    for (int j = 1; j < xleth_filter::kMaxModsPerSlot; ++j)
    {
        makeLfoLane(armed, sa, j, static_cast<xleth_filter::ModDest>(j % 6), 1.0f, 60.0f);
        armed.setSlotParam(sa, "m" + std::to_string(j) + "_kind",
                           static_cast<float>(xleth_filter::ModKind::Off));
    }
    armed.applyModulationGate(true, 0, 44100 * 10);
    XlethEffectBase::setGlobalBPM(120.0);
    XlethEffectBase::setGlobalTransportPositionSamples(0);

    // Long enough that any activation gate has fully faded before comparing.
    ToneRunner runP{ plain, sp, 256 };
    ToneRunner runA{ armed, sa, 256 };
    std::vector<float> outP, outA;
    runP.settle(outP); runA.settle(outA);
    outP.clear(); outA.clear();
    runP.run(22050, 200.0, 0.9f, 6000.0, 0.1f, outP, nullptr);
    runA.run(22050, 200.0, 0.9f, 6000.0, 0.1f, outA, nullptr);

    bool identical = (outP.size() == outA.size());
    size_t firstDiff = 0;
    for (size_t i = 0; identical && i < outP.size(); ++i)
        if (outP[i] != outA[i]) { identical = false; firstDiff = i; }

    CHECK(identical,
          "a slot whose lanes were all configured then switched Off is "
          "bit-identical to one that never had any (first diff at " << firstDiff << ")");
}

// ─── (l) A pre-lanes project migrates into lanes ─────────────────────────────

static void testLegacyStateMigration()
{
    std::cout << "  [l: a pre-lanes saved project folds into lanes]\n";

    // Build a state block the way a build BEFORE modulator lanes would have
    // saved it: the legacy fixed params set, and NO modSchema attribute.
    XlethFilterEffect src;
    src.prepareToPlay(kSR, 256);
    const int i = src.addSlot();
    src.setSlotParam(i, "cutoff", 800.0f);
    src.setSlotParam(i, "cut_min", 300.0f);
    src.setSlotParam(i, "cut_max", 6000.0f);
    src.setSlotParam(i, "dyn_depth", 0.8f);
    src.setSlotParam(i, "dyn_attack", 4.0f);
    src.setSlotParam(i, "dyn_release", 90.0f);
    src.setSlotParam(i, "lfo_on", 1.0f);
    src.setSlotParam(i, "lfo_dest", static_cast<float>(xleth_filter::ModDest::Q));
    src.setSlotParam(i, "lfo_depth", 0.75f);
    src.setSlotParam(i, "lfo_rate_ms", 250.0f);
    src.setSlotParam(i, "env_on", 1.0f);
    src.setSlotParam(i, "env_dest", static_cast<float>(xleth_filter::ModDest::Drive));
    src.setSlotParam(i, "env_depth", -0.4f);
    src.setSlotParam(i, "env_decay", 45.0f);
    src.setSlotParam(i, "env_slides", 1.0f);

    juce::MemoryBlock blob;
    src.getStateInformation(blob);

    // Strip modSchema so this looks like a genuinely old project.
    auto xml = juce::AudioProcessor::getXmlFromBinary(blob.getData(),
                                                      static_cast<int>(blob.getSize()));
    CHECK(xml != nullptr, "the saved state parses back as XML");
    if (!xml) return;
    xml->removeAttribute("modSchema");
    juce::MemoryBlock legacy;
    juce::AudioProcessor::copyXmlToBinary(*xml, legacy);

    XlethFilterEffect dst;
    dst.prepareToPlay(kSR, 256);
    dst.setStateInformation(legacy.getData(), static_cast<int>(legacy.getSize()));

    CHECK(dst.getSlotCount() == 1, "the migrated project still has its slot");

    const nlohmann::json slots = nlohmann::json::parse(dst.getSlotsAsJSON());
    CHECK(slots.size() == 1, "the migrated slot serializes back out");
    if (slots.empty()) return;
    const auto& mods = slots[0]["mods"];

    // Lane order mirrors the old panel: follower, LFO, envelope.
    CHECK(mods[0]["kind"] == static_cast<int>(xleth_filter::ModKind::Dyn),
          "the legacy follower became lane 0");
    CHECK(std::abs(mods[0]["depth"].get<float>() - 0.8f) < 1e-3f,
          "the follower's depth carried over");
    CHECK(std::abs(mods[0]["cut_min"].get<float>() - 300.0f) < 1.0f
       && std::abs(mods[0]["cut_max"].get<float>() - 6000.0f) < 10.0f,
          "the follower's sweep window carried over");
    CHECK(std::abs(mods[0]["dyn_attack"].get<float>() - 4.0f) < 0.1f,
          "the follower's ballistics carried over");

    CHECK(mods[1]["kind"] == static_cast<int>(xleth_filter::ModKind::Lfo),
          "the legacy LFO became lane 1");
    CHECK(mods[1]["dest"] == static_cast<int>(xleth_filter::ModDest::Q),
          "the LFO kept its destination");
    CHECK(std::abs(mods[1]["depth"].get<float>() - 0.75f) < 1e-3f,
          "the LFO kept its depth");
    CHECK(std::abs(mods[1]["rate_ms"].get<float>() - 250.0f) < 1.0f,
          "the LFO kept its rate");

    CHECK(mods[2]["kind"] == static_cast<int>(xleth_filter::ModKind::Env),
          "the legacy envelope became lane 2");
    CHECK(mods[2]["dest"] == static_cast<int>(xleth_filter::ModDest::Drive),
          "the envelope kept its destination");
    CHECK(std::abs(mods[2]["depth"].get<float>() + 0.4f) < 1e-3f,
          "the envelope kept its (negative) depth");
    CHECK(mods[2]["slides"].get<bool>(), "the envelope kept its slide-note opt-in");

    // The union query MixEngine uses must see the migrated envelope.
    CHECK(dst.hasActiveEnvelopeModulator(),
          "the migrated envelope is visible to the gate-timeline query");
    CHECK(dst.envelopeWantsSlideNotes(),
          "the migrated envelope's slide opt-in is visible too");

    // Re-saving stamps the new schema, so it never migrates twice.
    juce::MemoryBlock again;
    dst.getStateInformation(again);
    auto xml2 = juce::AudioProcessor::getXmlFromBinary(again.getData(),
                                                       static_cast<int>(again.getSize()));
    CHECK(xml2 && xml2->getIntAttribute("modSchema", 0) >= 1,
          "a re-save stamps modSchema so migration cannot run twice");

    XlethFilterEffect third;
    third.prepareToPlay(kSR, 256);
    third.setStateInformation(again.getData(), static_cast<int>(again.getSize()));
    const nlohmann::json slots2 = nlohmann::json::parse(third.getSlotsAsJSON());
    CHECK(!slots2.empty()
       && slots2[0]["mods"][0]["kind"] == static_cast<int>(xleth_filter::ModKind::Dyn)
       && slots2[0]["mods"][3]["kind"] == static_cast<int>(xleth_filter::ModKind::Off),
          "reloading the migrated project is stable — three lanes, no duplicates");
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

    std::cout << "\n=== test_xlethfilter_inmod (per-slot LFO + Envelope) ===\n";
    testInEffectLfoSweep();
    testModulatorsOffAreInert();
    testInEffectEnvelopeGate();

    std::cout << "\n=== test_xlethfilter_lanes (many modulators per slot) ===\n";
    testTwoLanesDifferentDests();
    testTwoLanesSameDest();
    testLaneRemovalKeepsOthers();
    testAllLanesOffAreInert();

    std::cout << "\n=== test_xlethfilter_migration ===\n";
    testLegacyStateMigration();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}

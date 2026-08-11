#pragma once

#include "audio/ApexDsp.h"
#include "audio/XlethEffectBase.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <complex>
#include <memory>
#include <string>
#include <vector>

// ─── XlethFilterEffect ──────────────────────────────────────────────────────
// Multi-slot serial filter built on ONE Zavalishin-TPT / Cytomic-Simper
// state-variable filter core.  Up to kMaxSlots = 8 slots run in series; each
// slot is an independent filter with its own type, cutoff, Q, slope, drive and
// dry/wet mix.
//
// Why the TPT SVF and not a direct-form biquad:
//   The TPT (topology-preserving transform) SVF keeps all cutoff/resonance
//   history in its two integrator states, so per-sample coefficient changes are
//   unconditionally stable for 0 < fc < fs/2 at any Q.  Direct-form biquads
//   blow up under fast sweeps at high resonance — the exact TB-303 use case
//   this effect exists for.  Every 2-pole response is then a mix of the input
//   and the two states,  out = m0*v0 + m1*v1 + m2*v2,  which makes mode
//   morphing a 3-float lerp instead of a crossfade between two divergent
//   filter states.
//
// Core equations (Simper, "SvfLinearTrapOptimised2", public Cytomic paper;
// all mix-coefficient sets cross-checked against Matthijs Hollemans' public
// C++ port of that paper — implemented here from the published math, no code
// copied.  Surge XT / sst-filters (GPLv3) was NOT consulted for code):
//
//   coefficient update (double, once per 32-sample control block):
//     g  = tan(pi * fc / fs)          // prewarped integrator gain
//     k  = 1 / Q                      // damping
//     a1 = 1 / (1 + g*(g + k));  a2 = g * a1;  a3 = g * a2
//
//   per sample (float):
//     v3 = v0 - ic2eq
//     v1 = a1*ic1eq + a2*v3           // bandpass
//     v2 = ic2eq + a2*ic1eq + a3*v3   // lowpass
//     ic1eq = 2*v1 - ic1eq
//     ic2eq = 2*v2 - ic2eq
//     out   = m0*v0 + m1*v1 + m2*v2
//
// Mix coefficients per slot type (k = 1/Q, A = 10^(gainDb/40)):
//   lp12       (0, 0, 1)
//   bp         (0, k, 0)             — normalised, unity peak gain
//   hp12       (1, -k, -1)
//   notch      (1, -k, 0)
//   allpass    (1, -2k, 0)
//   peak       k := 1/(Q*A);  (1, k*(A*A - 1), 0)
//   lowshelf   g := g/sqrt(A); (1, k*(A - 1), A*A - 1)
//   highshelf  g := g*sqrt(A); (A*A, k*(1 - A)*A, 1 - A*A)
//   morph      piecewise lerp  lp -> notch -> hp  over morph in [0,1]
//
// Slopes (per-slot discrete param):
//   6 dB  — one TPT one-pole section (lp12 / hp12 only; every other type
//           falls back to a single SVF, since a first-order section has no
//           bandpass/notch/shelf form)
//   12 dB — one SVF section
//   24 dB — two SVF sections at the same fc
//   48 dB — four SVF sections at the same fc
//   Section Qs come from the Butterworth table  Q_i = 1/(2 sin((2i+1)pi/4S))
//   for S sections, scaled by (Q_user / 0.7071).  At Q_user = 0.7071 that is
//   exactly maximally-flat Butterworth (24 dB -> 0.5412 / 1.3065); raising Q
//   above 0.7071 scales every section together, so resonance grows CONTINUOUSLY
//   with no discrete "resonant mode" switch to click across.
//   Cascading is applied to lp12 / hp12 / bp / notch / morph only.  peak and
//   the two shelves always use one section — cascading them would multiply
//   their gain, which is not what a slope control means.
//
// Drive & self-oscillation:
//   drive  — pre-filter tanh on v0, outside the integrator loop:
//            v0 = tanh(d*v0) / d, so small-signal gain stays exactly unity for
//            every d while hot signals saturate before they hit the resonance.
//            tanh is not the identity at d = 1, so the nonlinearity is faded in
//            from the dry signal across the first dB: 0 dB is exactly
//            transparent and there is no step at the bottom of the range.
//   selfosc — engaged when Q is pushed to its maximum.  k drops to
//            kSelfOscDamping (0.02, never raw 0) and the resonance feedback
//            integrator is soft-clipped with tanh, which bounds the
//            oscillation amplitude the analog way instead of letting a
//            linear k=0 pole ride the unit circle.
//
// Guard rails:
//   fc clamped to [10 Hz, 0.45*fs] and Q to [0.5, 30] after every modulation
//   source has been summed and immediately before the coefficient math; the
//   per-section Butterworth-scaled Q is clamped to the same window.  All
//   coefficient math is double at 32-sample control-block rate with per-sample
//   linear interpolation of a1/a2/a3 and m0/m1/m2 across the block.  States are
//   flushed below 1e-20, juce::ScopedNoDenormals covers the callback, and every
//   nonlinearity is a fixed-cost closed form — no convergence loops.
//
// Per-slot output: out = dry*(1 - mix) + wet*mix, then a soft clip that is
// linear below full scale and asymptotes at +/-1.95 — the safety net against
// cumulative resonance gain across a series of resonant slots.  A 2 Hz
// first-order DC blocker runs on each slot's wet path (required by self-osc
// mode; left always-on so engaging self-osc cannot click).
//
// Slot management is main-thread only (addSlot / removeSlot / setSlotParam),
// swap-with-last on remove, slot count serialized as an XML attribute next to
// the APVTS state — the XlethParametricEQ band pattern.
//
// ─── Modulation ─────────────────────────────────────────────────────────────
//
// TWO independent modulation sources reach every slot, and they compose:
//
//   1. The FX-graph envelope / LFO engine (xleth::envmod / xleth::lfomod).
//      NOTHING is implemented here for it and nothing needs to be: every APVTS
//      parameter of every stock effect is already a graph-parameter target
//      (AudioGraph::getGraphEffectParameterDescriptors enumerates
//      getParameters() with no per-plugin allowlist, and the UI's exposure
//      registry — ui/src/fxgraph/graphParameterTarget.js +
//      graphState.js normalizeExposedParameterPorts — is descriptor-driven, not
//      plugin-keyed).  A graph edge writes the NORMALISED value, which for the
//      log-skewed cutoff range means graph modulation already sweeps in
//      approximately-octave space for free.  The engine writes those values off
//      the audio thread into the APVTS; the per-parameter smoothers above turn
//      them into per-sample ramps.  test_xlethfilter_mod.cpp proves the whole
//      path end to end.
//
//   2. This file's own per-slot DYNAMICS FOLLOWER — the auto-wah / TB-303 path,
//      which exists only because the graph engine structurally cannot see the
//      audio stream.
//
// Dynamics follower, per slot (all of it inert unless s{i}_dyn_depth != 0):
//
//   Detector — the slot's OWN input (self-input; no sidechain in this version),
//   stereo-linked PEAK.  Each channel first passes a fixed 30 Hz one-pole high
//   pass so sub-bass cannot pin the envelope; the detector level is then
//   max(|hpL|, |hpR|).  That feeds xleth_apex::EnvelopeFollower (ApexDsp.h) —
//   branching attack/release with a 5 ms sustain-hold stage.  The follower runs
//   PER SAMPLE (3 mul + a branch); its attack/release coefficients come from
//   xleth_apex::onePoleCoeff at CONTROL-BLOCK rate and are cached against the
//   raw ms values, so no std::exp ever runs per sample.
//
//   Mapping — the follower output e in [0,1] is turned into an octave-space
//   offset and ADDED to the smoothed base cutoff's octaves (i.e. composed
//   multiplicatively in Hz), then the SUM is clamped:
//
//       rangeOct = log2(maxHz / minHz)              (from s{i}_cut_min/_max)
//       modOct   = depth * rangeOct * (e + 0.35 * accent)
//       hz       = clamp(baseHz * 2^modOct,  [minHz, maxHz] ∩ [10, 0.45*fs])
//
//   The design doc writes this mapping in its absolute form,
//   hz = minHz * (maxHz/minHz)^e.  That is exactly the special case of the
//   formula above with baseHz == minHz and depth == +1 — the offset form is the
//   one that can also honour a base cutoff parked anywhere else, which is what
//   "compose multiplicatively with the base cutoff" requires.  cut_min/cut_max
//   are therefore BOTH the sweep span and a hard clamp on the modulated result:
//   a base cutoff of 10 kHz with cut_max = 3 kHz is pulled down to 3 kHz, never
//   the other way round.  Only the SUM is clamped; the individual sources never
//   are.  Negative depth inverts the sweep (loud input CLOSES the filter).
//
//   Q route — the same depth also drives Q by a fixed shallow ratio (0.25 of
//   the full normalised/log Q span), the 303's env-mod-onto-resonance
//   behaviour.  It is applied in log-Q space and clamped to the [0.5, 30] guard
//   rails, and it deliberately does NOT feed the self-oscillation decision:
//   self-osc stays a function of the user's own Q, so a loud transient can
//   never trip the filter into oscillating.
//
//   303 accent lag — a leaky integrator (100 ms one-pole, inside the 47-150 ms
//   RC window the 303's accent circuit sits in) that charges on each detected
//   transient (follower output crossing 0.15 upward, re-armed below 0.06) and
//   leaks continuously.  Crucially it does NOT reset between transients, so
//   successive accents push the sweep progressively higher — the rising
//   "distressed cry" of an acid run — and then decay away.  Its output is added
//   into the octave-space mod sum BEFORE the clamp, scaled by the same depth,
//   so depth = 0 leaves it inert too.
//
//   Update rate — the follower is per sample; ballistics coefficients, the
//   octave/Q composition and the resulting SVF coefficients are per 32-sample
//   control block, linearly interpolated per sample exactly like the base
//   cutoff.  The composition ramps from the PREVIOUS block's mod value to this
//   block's, so the modulation is continuous across block boundaries at the
//   cost of one control block (0.7 ms at 44.1 kHz) of detector latency.
//
//   Everything is preallocated with the slot array in prepareEffect: no
//   allocation, no locks, no logging and no per-sample transcendental on the
//   audio path.
//
// pluginId: "xlethfilter"

namespace xleth_filter
{

// 7th-order Pade approximation of tanh — monotone, ~1e-6 over the clamped
// domain, and free of the per-sample transcendental call std::tanh would cost.
inline float fastTanh(float x) noexcept
{
    const float xc = std::clamp(x, -5.0f, 5.0f);
    const float x2 = xc * xc;
    const float n  = xc * (135135.0f + x2 * (17325.0f + x2 * (378.0f + x2)));
    const float d  = 135135.0f + x2 * (62370.0f + x2 * (3150.0f + x2 * 28.0f));
    return std::clamp(n / d, -1.0f, 1.0f);
}

// Flush denormal-range state to zero (belt-and-braces alongside ScopedNoDenormals).
inline float flushDenormal(float x) noexcept
{
    return (std::abs(x) < 1.0e-20f) ? 0.0f : x;
}

// Transparent below full scale, asymptotes at +/-(1 + 0.95).  Only bites when a
// series of resonant slots has already pushed the signal past 0 dBFS.
inline float safetyClip(float x) noexcept
{
    constexpr float kLin  = 1.0f;
    constexpr float kSpan = 0.95f;
    if (x >  kLin) return  kLin + kSpan * fastTanh((x - kLin) / kSpan);
    if (x < -kLin) return -kLin - kSpan * fastTanh((-x - kLin) / kSpan);
    return x;
}

} // namespace xleth_filter

class XlethFilterEffect : public XlethEffectBase
{
public:
    // ── Constants ───────────────────────────────────────────────────────────
    static constexpr int kMaxSlots     = 8;
    static constexpr int kMaxStages    = 4;    // 48 dB = four SVF sections
    static constexpr int kResponseSize = 512;
    static constexpr int kControlBlock = 32;   // coefficient recompute cadence

    static constexpr double kMinCutoffHz   = 10.0;
    static constexpr double kNyquistFactor = 0.45;
    static constexpr double kMinQ          = 0.5;
    static constexpr double kMaxQ          = 30.0;
    static constexpr double kNeutralQ      = 0.70710678118654752; // Butterworth
    static constexpr double kSelfOscQ      = 29.99;               // >= this = self-osc
    static constexpr double kSelfOscDamping = 0.02;               // k, never 0
    static constexpr double kDcBlockHz     = 2.0;
    static constexpr double kActivationMs  = 10.0;  // slot fade-in / fade-out

    // ── Dynamics follower (see the modulation notes at the top of the file) ──
    static constexpr double kDetectorHpHz    = 30.0;  // keeps sub-bass off the detector
    static constexpr double kDetectorHoldMs  = 5.0;   // follower sustain-hold stage
    static constexpr double kAccentLagMs     = 100.0; // 303 accent RC (47-150 ms band)
    static constexpr float  kAccentOnLevel   = 0.15f; // transient trigger threshold
    static constexpr float  kAccentOffLevel  = 0.06f; // re-arm threshold (hysteresis)
    static constexpr float  kAccentCharge    = 0.5f;  // per-transient charge fraction
    static constexpr double kAccentOctScale  = 0.35;  // full charge = 0.35 of the range
    static constexpr double kQRouteRatio     = 0.25;  // depth -> Q, normalised span

    enum class SlotType : int {
        LP12 = 0, HP12 = 1, BP = 2, Notch = 3, Allpass = 4,
        Peak = 5, LowShelf = 6, HighShelf = 7, Morph = 8
    };
    static constexpr int kNumSlotTypes = 9;

    // slope param: 0 = 6 dB, 1 = 12 dB, 2 = 24 dB, 3 = 48 dB
    static constexpr int kNumSlopes = 4;

    // ── Construction ────────────────────────────────────────────────────────
    XlethFilterEffect() : XlethEffectBase("xlethfilter", createLayout())
    {
        for (int i = 0; i < kMaxSlots; ++i)
        {
            registerSmoothedParam(paramId(i, "cutoff").toStdString(),
                                  SmoothType::Multiplicative, 20.0f);
            registerSmoothedParam(paramId(i, "q").toStdString(),
                                  SmoothType::Multiplicative, 20.0f);
            registerSmoothedParam(paramId(i, "gain").toStdString(),
                                  SmoothType::Linear, 20.0f);
            registerSmoothedParam(paramId(i, "morph").toStdString(),
                                  SmoothType::Linear, 20.0f);
            registerSmoothedParam(paramId(i, "drive").toStdString(),
                                  SmoothType::Linear, 20.0f);
            registerSmoothedParam(paramId(i, "mix").toStdString(),
                                  SmoothType::Linear, 20.0f);

            // Dynamics range + depth are smoothed for the same reason the base
            // cutoff is: dragging them while audio runs must glide, not step.
            // Depth is BIPOLAR, so it must be Linear — the Multiplicative
            // smoother clamps its target to >= 1e-6 and cannot represent a
            // negative (ducking) depth at all.
            registerSmoothedParam(paramId(i, "cut_min").toStdString(),
                                  SmoothType::Multiplicative, 20.0f);
            registerSmoothedParam(paramId(i, "cut_max").toStdString(),
                                  SmoothType::Multiplicative, 20.0f);
            registerSmoothedParam(paramId(i, "dyn_depth").toStdString(),
                                  SmoothType::Linear, 20.0f);
        }
    }

    // ── Serialization (extends base to include slotCount_) ──────────────────

    void getStateInformation(juce::MemoryBlock& dest) override
    {
        auto xml = apvts_.copyState().createXml();
        if (xml)
        {
            xml->setAttribute("slotCount", slotCount_.load(std::memory_order_relaxed));
            copyXmlToBinary(*xml, dest);
        }
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        auto xml = getXmlFromBinary(data, sizeInBytes);
        if (xml && xml->hasTagName(apvts_.state.getType()))
        {
            const int count = xml->getIntAttribute("slotCount", 0);
            apvts_.replaceState(juce::ValueTree::fromXml(*xml));
            slotCount_.store(std::clamp(count, 0, kMaxSlots), std::memory_order_relaxed);
            for (auto& sl : slots_)
                sl.clearState();
        }
    }

    // ── Slot management (main thread only) ──────────────────────────────────

    // Add a slot with default params.  Returns the slot index, or -1 if full.
    int addSlot()
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        if (count >= kMaxSlots) return -1;

        setParamDirect(count, "enabled",     1.0f);
        setParamDirect(count, "type",        0.0f);      // LP12
        setParamDirect(count, "cutoff",      1000.0f);
        setParamDirect(count, "q",           0.7071f);
        setParamDirect(count, "gain",        0.0f);
        setParamDirect(count, "morph",       0.0f);
        setParamDirect(count, "slope",       1.0f);      // 12 dB
        setParamDirect(count, "drive",       0.0f);
        setParamDirect(count, "mix",         1.0f);
        setParamDirect(count, "cut_min",     20.0f);
        setParamDirect(count, "cut_max",     20000.0f);
        setParamDirect(count, "dyn_depth",   0.0f);
        setParamDirect(count, "dyn_attack",  10.0f);
        setParamDirect(count, "dyn_release", 100.0f);

        // No clearState() here: the audio thread owns DSP state and has already
        // cleared this slot on the block its gate reached zero (prepareEffect
        // covers the never-processed case).  The slot fades in from gate = 0.
        slotCount_.store(count + 1, std::memory_order_relaxed);
        return count;
    }

    // Remove the slot at `index`.  Swaps the last slot into its place.
    bool removeSlot(int index)
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        if (index < 0 || index >= count) return false;

        const int last = count - 1;
        if (index != last)
            copySlotParams(last, index);
        // The vacated slot keeps running until its activation gate has faded to
        // zero, at which point the audio thread clears it — dropping it here
        // would cut its tail mid-sample.
        slotCount_.store(last, std::memory_order_relaxed);
        return true;
    }

    // Set one slot parameter by short name ("cutoff", "q", "type", ...).
    bool setSlotParam(int slotIndex, const std::string& paramName, float value)
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        if (slotIndex < 0 || slotIndex >= count) return false;
        return setParamDirect(slotIndex, paramName, value);
    }

    int getSlotCount() const { return slotCount_.load(std::memory_order_relaxed); }

    double getSampleRate() const { return sampleRate_.load(std::memory_order_relaxed); }

    // ── Dynamics telemetry (audio thread writes once per control block, any
    //    other thread reads) ───────────────────────────────────────────────────
    // The EFFECTIVE cutoff / Q after the dynamics follower has been composed in
    // and the sum clamped — i.e. what the SVF is actually running at, not what
    // the parameter says.  Read-only; nothing in the DSP path consumes them.

    float getSlotEffectiveCutoff(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        return slots_[slotIndex].effCutoffHz.load(std::memory_order_relaxed);
    }

    float getSlotEffectiveQ(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        return slots_[slotIndex].effQ.load(std::memory_order_relaxed);
    }

    // Follower output in [0,1] (0 whenever the follower is inert).
    float getSlotDynamicEnvelope(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        return slots_[slotIndex].dynEnv.load(std::memory_order_relaxed);
    }

    // 303 accent-lag charge in [0,1] (0 whenever the follower is inert).
    float getSlotAccentCharge(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        return slots_[slotIndex].dynAccent.load(std::memory_order_relaxed);
    }

    // ── Slot info query (main thread, for N-API JSON) ────────────────────────
    std::string getSlotsAsJSON() const
    {
        nlohmann::json arr = nlohmann::json::array();
        const int count = slotCount_.load(std::memory_order_relaxed);
        for (int i = 0; i < count; ++i)
        {
            nlohmann::json s;
            s["index"]       = i;
            s["enabled"]     = readParam(i, "enabled") > 0.5f;
            s["type"]        = static_cast<int>(std::lround(readParam(i, "type")));
            s["cutoff"]      = readParam(i, "cutoff");
            s["q"]           = readParam(i, "q");
            s["gain"]        = readParam(i, "gain");
            s["morph"]       = readParam(i, "morph");
            s["slope"]       = static_cast<int>(std::lround(readParam(i, "slope")));
            s["drive"]       = readParam(i, "drive");
            s["mix"]         = readParam(i, "mix");
            s["cut_min"]     = readParam(i, "cut_min");
            s["cut_max"]     = readParam(i, "cut_max");
            s["dyn_depth"]   = readParam(i, "dyn_depth");
            s["dyn_attack"]  = readParam(i, "dyn_attack");
            s["dyn_release"] = readParam(i, "dyn_release");
            // Read-only dynamics telemetry (see getSlotEffectiveCutoff).
            s["eff_cutoff"]  = slots_[i].effCutoffHz.load(std::memory_order_relaxed);
            s["eff_q"]       = slots_[i].effQ.load(std::memory_order_relaxed);
            s["dyn_env"]     = slots_[i].dynEnv.load(std::memory_order_relaxed);
            s["dyn_accent"]  = slots_[i].dynAccent.load(std::memory_order_relaxed);
            arr.push_back(std::move(s));
        }
        return arr.dump();
    }

    // ── Response curve (main thread) ─────────────────────────────────────────
    // Writes `outSize` (max kResponseSize) magnitudes in dB at log-spaced
    // frequencies from 20 Hz to 20 kHz.  Coefficients are derived on the fly
    // from the current APVTS values, so the curve is correct even with no audio
    // flowing.  Drive is a nonlinearity and is (necessarily) not modelled.
    void getResponseCurve(float* outBuf, int outSize) const
    {
        const int    n     = std::min(outSize, kResponseSize);
        const int    count = slotCount_.load(std::memory_order_relaxed);
        const double sr    = sampleRate_.load(std::memory_order_relaxed);
        const double pi    = juce::MathConstants<double>::pi;

        if (n <= 0) return;

        // Snapshot every enabled slot's linear design once.
        struct LocalSlot
        {
            bool     enabled  = false;
            bool     onePole  = false;
            bool     highPass = false;   // one-pole variant
            int      stages   = 1;
            double   mix      = 1.0;
            double   g[kMaxStages]{};
            double   k[kMaxStages]{};
            double   m0[kMaxStages]{}, m1[kMaxStages]{}, m2[kMaxStages]{};
        };
        LocalSlot ls[kMaxSlots]{};

        for (int i = 0; i < count; ++i)
        {
            auto& L = ls[i];
            L.enabled = readParam(i, "enabled") > 0.5f;
            if (!L.enabled) continue;

            const auto type  = clampType(static_cast<int>(std::lround(readParam(i, "type"))));
            const int  slope = std::clamp(
                static_cast<int>(std::lround(readParam(i, "slope"))), 0, kNumSlopes - 1);
            const double cut   = readParam(i, "cutoff");
            const double q     = readParam(i, "q");
            const double gain  = readParam(i, "gain");
            const double morph = readParam(i, "morph");
            L.mix = std::clamp(static_cast<double>(readParam(i, "mix")), 0.0, 1.0);

            L.onePole  = usesOnePole(type, slope);
            L.highPass = (type == SlotType::HP12);
            L.stages   = L.onePole ? 1 : stageCountFor(type, slope);

            const double fc      = clampCutoff(cut, sr);
            const bool   selfOsc = (q >= kSelfOscQ);

            if (L.onePole)
            {
                L.g[0] = std::tan(pi * fc / sr);
            }
            else
            {
                for (int st = 0; st < L.stages; ++st)
                {
                    StageDesign d;
                    designStage(d, type, fc, stageQ(q, L.stages, st), gain, morph, sr, selfOsc);
                    L.g[st]  = d.g;   L.k[st]  = d.k;
                    L.m0[st] = d.m0;  L.m1[st] = d.m1;  L.m2[st] = d.m2;
                }
            }
        }

        const double logMin = std::log(20.0);
        const double logMax = std::log(20000.0);

        for (int i = 0; i < n; ++i)
        {
            const double t    = (n > 1) ? static_cast<double>(i) / (n - 1) : 0.0;
            const double freq = std::exp(logMin + t * (logMax - logMin));
            const double w    = 2.0 * pi * freq / sr;

            const std::complex<double> zInv(std::cos(-w), std::sin(-w));
            const std::complex<double> A = 1.0 - zInv;   // (1 - z^-1)
            const std::complex<double> B = 1.0 + zInv;   // (1 + z^-1)

            std::complex<double> H(1.0, 0.0);

            for (int s = 0; s < count; ++s)
            {
                const auto& L = ls[s];
                if (!L.enabled) continue;

                std::complex<double> Hs(1.0, 0.0);

                if (L.onePole)
                {
                    // TPT one-pole: LP = gB / (A + gB), HP = A / (A + gB)
                    const std::complex<double> den = A + L.g[0] * B;
                    Hs = L.highPass ? (A / den) : ((L.g[0] * B) / den);
                }
                else
                {
                    for (int st = 0; st < L.stages; ++st)
                    {
                        // Bilinear image of  H(s) = (m0*(s^2+ks+1) + m1*s + m2) / (s^2+ks+1)
                        // with s = (1/g)*(1-z^-1)/(1+z^-1), cleared of denominators.
                        const double g = L.g[st], k = L.k[st];
                        const std::complex<double> AA  = A * A;
                        const std::complex<double> AB  = A * B;
                        const std::complex<double> BB  = B * B;
                        const std::complex<double> den = AA + (k * g) * AB + (g * g) * BB;
                        const std::complex<double> num =
                            L.m0[st] * den + (L.m1[st] * g) * AB + (L.m2[st] * g * g) * BB;
                        Hs *= (std::abs(den) > 1e-30) ? (num / den) : std::complex<double>(1.0, 0.0);
                    }
                }

                // Per-slot dry/wet crossfade is linear, so it belongs in H.
                H *= (1.0 - L.mix) + L.mix * Hs;
            }

            const double mag = std::abs(H);
            outBuf[i] = static_cast<float>(20.0 * std::log10(std::max(mag, 1e-12)));
        }
    }

    // ── Tail ────────────────────────────────────────────────────────────────
    // Resonant slots are stateful; let them decay across clip chops instead of
    // freezing state from clip A and injecting it into clip B.
    double getTailLengthSeconds() const override { return 0.2; }

    // ── XlethEffectBase overrides ───────────────────────────────────────────

    void prepareEffect(double sampleRate, int /*maxBlockSize*/) override
    {
        sampleRate_.store(sampleRate, std::memory_order_relaxed);

        const double pi = juce::MathConstants<double>::pi;

        // 2 Hz first-order DC blocker pole.
        const float dcR = static_cast<float>(1.0 - (2.0 * pi * kDcBlockHz / sampleRate));
        // 30 Hz first-order high pass on the DETECTOR path (same topology).
        const float hpR = static_cast<float>(
            std::clamp(1.0 - (2.0 * pi * kDetectorHpHz / sampleRate), 0.0, 0.999999));

        for (int i = 0; i < kMaxSlots; ++i)
        {
            auto& sl = slots_[i];
            sl.dcR = dcR;
            sl.enabledPtr = apvts_.getRawParameterValue(paramId(i, "enabled"));
            sl.typePtr    = apvts_.getRawParameterValue(paramId(i, "type"));
            sl.slopePtr   = apvts_.getRawParameterValue(paramId(i, "slope"));
            sl.attackPtr  = apvts_.getRawParameterValue(paramId(i, "dyn_attack"));
            sl.releasePtr = apvts_.getRawParameterValue(paramId(i, "dyn_release"));

            // The dynamics follower and its accent lag are plain value members
            // of the slot array — allocated here with everything else, never on
            // the audio thread.
            sl.dyn.hpR          = hpR;
            sl.dyn.holdSamples  = std::max(1, static_cast<int>(
                                      kDetectorHoldMs * 0.001 * sampleRate));
            sl.dyn.leakCoef     = xleth_apex::onePoleCoeff(
                                      static_cast<float>(kAccentLagMs), sampleRate);
            // Force a coefficient recompute on the first block.
            sl.dyn.lastAtkMs = sl.dyn.lastRelMs = -1.0f;

            // Handles resolved once here — never a string lookup on the audio path.
            sl.hCutoff = resolveSmoothed(paramId(i, "cutoff").toStdString());
            sl.hQ      = resolveSmoothed(paramId(i, "q").toStdString());
            sl.hGain   = resolveSmoothed(paramId(i, "gain").toStdString());
            sl.hMorph  = resolveSmoothed(paramId(i, "morph").toStdString());
            sl.hDrive  = resolveSmoothed(paramId(i, "drive").toStdString());
            sl.hMix    = resolveSmoothed(paramId(i, "mix").toStdString());
            sl.hCutMin = resolveSmoothed(paramId(i, "cut_min").toStdString());
            sl.hCutMax = resolveSmoothed(paramId(i, "cut_max").toStdString());
            sl.hDepth  = resolveSmoothed(paramId(i, "dyn_depth").toStdString());

            sl.clearState();
        }
    }

    void releaseEffect() override { resetEffect(); }

    void resetEffect() override
    {
        for (auto& sl : slots_)
            sl.clearState();
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        juce::ScopedNoDenormals noDenormals;

        const int    numSamples = buffer.getNumSamples();
        const int    numCh      = std::min(buffer.getNumChannels(), 2);
        const int    count      = std::min(slotCount_.load(std::memory_order_relaxed), kMaxSlots);
        const double sr         = sampleRate_.load(std::memory_order_relaxed);

        if (numSamples <= 0 || numCh <= 0) return;

        // A slot removed (or disabled) this block is still fading out, so keep
        // processing past `count` until its gate has reached zero.
        int proc = count;
        for (int i = kMaxSlots - 1; i >= count; --i)
            if (slots_[i].gate > 1.0e-5f) { proc = i + 1; break; }

        if (proc <= 0)
        {
            // No slots: still advance the smoothers so ramps stay correct.
            for (int i = 0; i < kMaxSlots; ++i)
                slots_[i].skipSmoothers(numSamples);
            writeMeterValue(0, buffer.getMagnitude(0, 0, numSamples));
            writeMeterValue(1, numCh > 1 ? buffer.getMagnitude(1, 0, numSamples)
                                         : buffer.getMagnitude(0, 0, numSamples));
            return;
        }

        // Slots past the fade-out window still need their smoothers advanced.
        for (int i = proc; i < kMaxSlots; ++i)
            slots_[i].skipSmoothers(numSamples);

        float* chL = buffer.getWritePointer(0);
        float* chR = (numCh > 1) ? buffer.getWritePointer(1) : nullptr;

        float peakL = 0.0f, peakR = 0.0f;

        for (int pos = 0; pos < numSamples; pos += kControlBlock)
        {
            const int n = std::min(kControlBlock, numSamples - pos);

            // ── Control-block coefficient update (double math, block rate) ──
            for (int s = 0; s < proc; ++s)
                updateSlotBlock(slots_[s], n, sr, s < count);

            // ── Per-sample inner loop (float, no transcendentals except the
            //    Pade tanh used by drive / self-osc) ─────────────────────────
            for (int i = 0; i < n; ++i)
            {
                float l = chL[pos + i];
                float r = chR ? chR[pos + i] : 0.0f;

                for (int s = 0; s < proc; ++s)
                {
                    auto& sl = slots_[s];
                    if (!sl.enabled) continue;

                    // Detector sees this slot's INPUT, before the slot filters
                    // it — self-input only (a sidechain source needs
                    // withSidechainInput on the base ctor and is a deliberate
                    // later increment).
                    if (sl.dynActive)
                        updateDetector(sl, l, r, chR != nullptr);

                    const float wet = sl.mix * sl.gate;
                    const float dry = 1.0f - wet;

                    const float wl = processSlotSample(sl, 0, l);
                    l = xleth_filter::safetyClip(l * dry + wl * wet);

                    if (chR)
                    {
                        const float wr = processSlotSample(sl, 1, r);
                        r = xleth_filter::safetyClip(r * dry + wr * wet);
                    }
                }

                chL[pos + i] = l;
                if (chR) chR[pos + i] = r;

                peakL = std::max(peakL, std::abs(l));
                peakR = std::max(peakR, std::abs(r));

                // Advance every per-sample coefficient ramp exactly once.
                for (int s = 0; s < proc; ++s)
                    slots_[s].advanceCoeffs();
            }
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, chR ? peakR : peakL);
    }

private:
    // ── Stage design (double, control-block rate) ───────────────────────────
    struct StageDesign
    {
        double g = 0.0, k = 1.0;
        double a1 = 0.0, a2 = 0.0, a3 = 0.0;
        double m0 = 0.0, m1 = 0.0, m2 = 1.0;
    };

    static SlotType clampType(int raw)
    {
        return static_cast<SlotType>(std::clamp(raw, 0, kNumSlotTypes - 1));
    }

    static double clampCutoff(double fc, double sr)
    {
        return std::clamp(fc, kMinCutoffHz, sr * kNyquistFactor);
    }

    // Butterworth section Qs, ascending, for a cascade of S sections
    // (filter order 2S):  Q_i = 1 / (2 * sin((2i+1)*pi / (4S))).
    // S=1 -> 0.7071;  S=2 -> 0.5412, 1.3065;  S=4 -> 0.5098 .. 2.5629.
    static double butterworthQ(int stageCount, int stageIndex)
    {
        static constexpr double kTable[kMaxStages][kMaxStages] = {
            { 0.70710678118654752, 0.0, 0.0, 0.0 },
            { 0.54119610014619698, 1.30656296487637652, 0.0, 0.0 },
            { 0.0, 0.0, 0.0, 0.0 },   // 3 sections (36 dB) unused
            { 0.50979557910415918, 0.60134488693504527,
              0.89997622313641557, 2.56291544774150011 },
        };
        const int sIdx = std::clamp(stageCount - 1, 0, kMaxStages - 1);
        const int iIdx = std::clamp(stageIndex, 0, kMaxStages - 1);
        const double q = kTable[sIdx][iIdx];
        return (q > 0.0) ? q : kNeutralQ;
    }

    // The dynamics sweep span: s{i}_cut_min / s{i}_cut_max clamped to the hard
    // rails, with min < max forced.  A collapsed or inverted user range would
    // otherwise make log2(hi/lo) zero or negative and quietly invert the sweep.
    static void resolveDynRange(double mn, double mx, double sr,
                                double& lo, double& hi)
    {
        const double nyq = sr * kNyquistFactor;
        lo = clampCutoff(std::min(mn, mx), sr);
        hi = clampCutoff(std::max(mn, mx), sr);
        if (!(hi > lo))
        {
            hi = std::min(lo * 1.001, nyq);
            lo = std::min(lo, hi / 1.001);
        }
    }

    // The 303's shallow env-mod-onto-resonance route.  `dNorm` is an offset in
    // NORMALISED (log) Q space, so the same depth means the same perceptual
    // amount of resonance wherever the user has parked Q; the result is clamped
    // to the same [kMinQ, kMaxQ] guard rails everything else uses.
    static double applyQOffset(double q, double dNorm)
    {
        if (dNorm == 0.0) return q;
        const double span = std::log(kMaxQ / kMinQ);
        const double t    = std::log(std::clamp(q, kMinQ, kMaxQ) / kMinQ) / span;
        return kMinQ * std::exp(std::clamp(t + dNorm, 0.0, 1.0) * span);
    }

    // Per-section Q: the Butterworth staging scaled by the user's Q relative to
    // the neutral (maximally flat) 0.7071, clamped to the guard-rail window.
    static double stageQ(double userQ, int stageCount, int stageIndex)
    {
        const double base = std::clamp(userQ, kMinQ, kMaxQ);
        const double q    = base * (butterworthQ(stageCount, stageIndex) / kNeutralQ);
        return std::clamp(q, kMinQ, kMaxQ);
    }

    // 6 dB is a genuine first-order section, which only exists for lp/hp.
    static bool usesOnePole(SlotType type, int slope)
    {
        return slope == 0 && (type == SlotType::LP12 || type == SlotType::HP12);
    }

    // Cascading a bell or a shelf would multiply its gain, so those types
    // always use a single section regardless of the slope param.
    static bool slopeApplies(SlotType type)
    {
        switch (type)
        {
            case SlotType::LP12:
            case SlotType::HP12:
            case SlotType::BP:
            case SlotType::Notch:
            case SlotType::Morph:
                return true;
            default:
                return false;
        }
    }

    static int stageCountFor(SlotType type, int slope)
    {
        if (!slopeApplies(type)) return 1;
        switch (slope)
        {
            case 0:  return 1;   // 6 dB fallback for non-lp/hp types
            case 2:  return 2;   // 24 dB
            case 3:  return 4;   // 48 dB
            default: return 1;   // 12 dB
        }
    }

    // The whole coefficient bank for one SVF section.
    static void designStage(StageDesign& d, SlotType type, double fc, double q,
                            double gainDb, double morph, double sr, bool selfOsc)
    {
        const double pi = juce::MathConstants<double>::pi;

        fc = clampCutoff(fc, sr);
        q  = std::clamp(q, kMinQ, kMaxQ);

        double g = std::tan(pi * fc / sr);
        double k = selfOsc ? kSelfOscDamping : (1.0 / q);
        double m0 = 0.0, m1 = 0.0, m2 = 1.0;

        switch (type)
        {
            case SlotType::LP12:
                m0 = 0.0; m1 = 0.0; m2 = 1.0;
                break;

            case SlotType::HP12:
                m0 = 1.0; m1 = -k; m2 = -1.0;
                break;

            case SlotType::BP:
                m0 = 0.0; m1 = k; m2 = 0.0;
                break;

            case SlotType::Notch:
                m0 = 1.0; m1 = -k; m2 = 0.0;
                break;

            case SlotType::Allpass:
                m0 = 1.0; m1 = -2.0 * k; m2 = 0.0;
                break;

            case SlotType::Peak:
            {
                const double A = std::pow(10.0, gainDb / 40.0);
                k  = selfOsc ? kSelfOscDamping : (1.0 / (q * A));
                m0 = 1.0; m1 = k * (A * A - 1.0); m2 = 0.0;
                break;
            }

            case SlotType::LowShelf:
            {
                const double A = std::pow(10.0, gainDb / 40.0);
                g  = g / std::sqrt(A);
                m0 = 1.0; m1 = k * (A - 1.0); m2 = A * A - 1.0;
                break;
            }

            case SlotType::HighShelf:
            {
                const double A = std::pow(10.0, gainDb / 40.0);
                g  = g * std::sqrt(A);
                m0 = A * A; m1 = k * (1.0 - A) * A; m2 = 1.0 - A * A;
                break;
            }

            case SlotType::Morph:
            {
                // lp (0,0,1) -> notch (1,-k,0) -> hp (1,-k,-1)
                const double t = std::clamp(morph, 0.0, 1.0);
                if (t <= 0.5)
                {
                    const double u = t * 2.0;
                    m0 = u;             // 0 -> 1
                    m1 = u * (-k);      // 0 -> -k
                    m2 = 1.0 - u;       // 1 -> 0
                }
                else
                {
                    const double u = (t - 0.5) * 2.0;
                    m0 = 1.0;
                    m1 = -k;
                    m2 = -u;            // 0 -> -1
                }
                break;
            }
        }

        d.g  = g;
        d.k  = k;
        d.a1 = 1.0 / (1.0 + g * (g + k));
        d.a2 = g * d.a1;
        d.a3 = g * d.a2;
        d.m0 = m0; d.m1 = m1; d.m2 = m2;
    }

    // ── Per-slot runtime state ──────────────────────────────────────────────
    struct StageRT
    {
        // Lerped coefficients + per-sample increments.
        float a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
        float m0 = 0.0f, m1 = 0.0f, m2 = 1.0f;
        float da1 = 0.0f, da2 = 0.0f, da3 = 0.0f;
        float dm0 = 0.0f, dm1 = 0.0f, dm2 = 0.0f;

        // Integrator state, per channel.
        float ic1eq[2]{}, ic2eq[2]{};
        // TPT one-pole state, per channel (6 dB slope).
        float z[2]{};

        void clear()
        {
            ic1eq[0] = ic1eq[1] = 0.0f;
            ic2eq[0] = ic2eq[1] = 0.0f;
            z[0] = z[1] = 0.0f;
        }
    };

    // ── Per-slot dynamics follower (the auto-wah / 303 path) ────────────────
    // Everything here is a plain value member of SlotState, so it is allocated
    // once with the slot array.  Nothing in it allocates, locks or logs.
    struct DynState
    {
        xleth_apex::EnvelopeFollower follower;  // ApexDsp.h:518 — reused, not rebuilt

        // Ballistics, recomputed at control-block rate ONLY (onePoleCoeff calls
        // std::exp; XlethCompressorEffect.h:339-342 doing it per sample is the
        // anti-example this cache exists to avoid).
        float aCoef       = 0.0f;
        float rCoef       = 0.0f;
        float lastAtkMs   = -1.0f;
        float lastRelMs   = -1.0f;
        int   holdSamples = 1;

        // 30 Hz detector high pass, per channel (y = x - x1 + R*y1).
        float hpR = 0.9957f;
        float hpX1[2]{}, hpY1[2]{};

        // Follower output for the next control block's composition.
        float env = 0.0f;

        // 303 accent lag: charges on a rising transient, leaks continuously,
        // and is NOT reset between transients.
        float accent   = 0.0f;
        float leakCoef = 0.0f;
        bool  armed    = true;

        // Previous block's composed values, so the ramp is continuous across
        // block boundaries instead of stepping at every control block.
        double modOctPrev  = 0.0;
        double qOffsetPrev = 0.0;

        void clear() noexcept
        {
            follower.reset();
            hpX1[0] = hpX1[1] = 0.0f;
            hpY1[0] = hpY1[1] = 0.0f;
            env         = 0.0f;
            accent      = 0.0f;
            armed       = true;
            modOctPrev  = 0.0;
            qOffsetPrev = 0.0;
        }
    };

    struct SlotState
    {
        std::atomic<float>* enabledPtr = nullptr;
        std::atomic<float>* typePtr    = nullptr;
        std::atomic<float>* slopePtr   = nullptr;
        std::atomic<float>* attackPtr  = nullptr;
        std::atomic<float>* releasePtr = nullptr;

        SmoothedHandle hCutoff, hQ, hGain, hMorph, hDrive, hMix;
        SmoothedHandle hCutMin, hCutMax, hDepth;

        DynState dyn;
        // False whenever s{i}_dyn_depth is exactly 0 at BOTH ends of the block:
        // the whole follower path — detector, ballistics, accent lag, octave
        // composition and Q route — is then skipped, so the slot is provably
        // bit-identical to the same slot with no follower at all.
        bool dynActive = false;

        // Telemetry (audio thread stores, any thread loads).
        std::atomic<float> effCutoffHz{0.0f};
        std::atomic<float> effQ{0.0f};
        std::atomic<float> dynEnv{0.0f};
        std::atomic<float> dynAccent{0.0f};

        StageRT stages[kMaxStages];

        int  stageCount = 1;
        bool enabled    = false;
        bool onePole    = false;
        bool highPass   = false;   // one-pole variant selector
        bool selfOsc    = false;
        bool driveOn    = false;

        // One-pole TPT gain G = g/(1+g), lerped.
        float g1 = 0.0f, dg1 = 0.0f;
        // Drive gain, its reciprocal, and the dry->saturated blend, all lerped.
        float drive = 1.0f, dDrive = 0.0f;
        float invDrive = 1.0f, dInvDrive = 0.0f;
        float driveBlend = 0.0f, dDriveBlend = 0.0f;
        // Dry/wet crossfade, lerped.
        float mix = 1.0f, dMix = 0.0f;
        // Activation gate: 0 while the slot is not live, 1 while it is, ramped
        // over kActivationMs so addSlot / removeSlot / the enabled toggle fade
        // instead of stepping.  The wet leg is scaled by mix * gate.
        float gate = 0.0f, dGate = 0.0f;
        bool  cleared = true;

        // First-order DC blocker, per channel (pole set in prepareEffect).
        float dcR = 0.9997f;
        float dcX1[2]{}, dcY1[2]{};

        void clearState()
        {
            for (auto& st : stages) st.clear();
            dcX1[0] = dcX1[1] = 0.0f;
            dcY1[0] = dcY1[1] = 0.0f;
            gate = 0.0f;
            dGate = 0.0f;
            dyn.clear();
            dynEnv.store(0.0f, std::memory_order_relaxed);
            dynAccent.store(0.0f, std::memory_order_relaxed);
        }

        void skipSmoothers(int n)
        {
            hCutoff.skip(n); hQ.skip(n); hGain.skip(n);
            hMorph.skip(n);  hDrive.skip(n); hMix.skip(n);
            hCutMin.skip(n); hCutMax.skip(n); hDepth.skip(n);
        }

        void advanceCoeffs()
        {
            for (int st = 0; st < stageCount; ++st)
            {
                auto& S = stages[st];
                S.a1 += S.da1; S.a2 += S.da2; S.a3 += S.da3;
                S.m0 += S.dm0; S.m1 += S.dm1; S.m2 += S.dm2;
            }
            g1         += dg1;
            drive      += dDrive;
            invDrive   += dInvDrive;
            driveBlend += dDriveBlend;
            mix        += dMix;
            gate       += dGate;
        }
    };

    // Recompute one slot's coefficient ramp for the next `n` samples.
    // `withinCount` is false for a slot that is fading out after removeSlot().
    void updateSlotBlock(SlotState& sl, int n, double sr, bool withinCount)
    {
        const float invN = 1.0f / static_cast<float>(n);

        const bool paramEnabled = sl.enabledPtr
            ? (sl.enabledPtr->load(std::memory_order_relaxed) > 0.5f) : true;
        const bool wantActive = withinCount && paramEnabled;

        // Activation ramp. A slot that is fully faded out and no longer live
        // gets its DSP state cleared here — on the audio thread, exactly once —
        // so the next addSlot() always starts from silence without the main
        // thread ever writing filter state underneath the callback.
        {
            const float step   = static_cast<float>(1.0 / std::max(1.0, kActivationMs * 0.001 * sr));
            const float target = wantActive ? 1.0f : 0.0f;
            const float end    = (target > sl.gate)
                ? std::min(target, sl.gate + step * n)
                : std::max(target, sl.gate - step * n);
            sl.dGate = (end - sl.gate) * invN;

            if (wantActive)
            {
                sl.cleared = false;
            }
            else if (sl.gate <= 0.0f && end <= 0.0f && !sl.cleared)
            {
                sl.clearState();
                sl.cleared = true;
            }
        }

        sl.enabled = wantActive || sl.gate > 0.0f;

        const SlotType type = clampType(sl.typePtr
            ? static_cast<int>(std::lround(sl.typePtr->load(std::memory_order_relaxed))) : 0);
        const int slope = std::clamp(sl.slopePtr
            ? static_cast<int>(std::lround(sl.slopePtr->load(std::memory_order_relaxed))) : 1,
            0, kNumSlopes - 1);

        // Block endpoints of every smoothed param (peekAfter does not advance).
        const double cut0 = sl.hCutoff.current(), cut1 = sl.hCutoff.peekAfter(n);
        const double q0   = sl.hQ.current(),      q1   = sl.hQ.peekAfter(n);
        const double gn0  = sl.hGain.current(),   gn1  = sl.hGain.peekAfter(n);
        const double mp0  = sl.hMorph.current(),  mp1  = sl.hMorph.peekAfter(n);
        const double dr0  = sl.hDrive.current(),  dr1  = sl.hDrive.peekAfter(n);
        const double mx0  = sl.hMix.current(),    mx1  = sl.hMix.peekAfter(n);
        const double dp0  = sl.hDepth.current(),  dp1  = sl.hDepth.peekAfter(n);
        const double cmn  = sl.hCutMin.peekAfter(n);
        const double cmx  = sl.hCutMax.peekAfter(n);
        sl.skipSmoothers(n);

        const int newStageCount = usesOnePole(type, slope) ? 1 : stageCountFor(type, slope);
        if (newStageCount != sl.stageCount)
        {
            // Topology change: clear the sections that were not previously live
            // so stale state cannot ring into the new cascade.
            for (int st = sl.stageCount; st < newStageCount; ++st)
                sl.stages[st].clear();
            sl.stageCount = newStageCount;
        }

        sl.onePole  = usesOnePole(type, slope);
        sl.highPass = (type == SlotType::HP12);
        // Self-osc is decided from the USER's Q only.  Routing the dynamics
        // follower into this decision would let a loud transient trip the
        // filter into oscillating, which is not what a resonance sweep means.
        sl.selfOsc  = (std::max(q0, q1) >= kSelfOscQ);

        // ── Dynamics follower composition (block rate) ───────────────────────
        // The endpoints the coefficient math below actually uses.  When the
        // follower is inert these stay EXACTLY the smoothed parameter values,
        // so a depth-0 slot is bit-identical to one with no follower compiled
        // in at all.
        double cutA = cut0, cutB = cut1;
        double qA   = q0,   qB   = q1;

        sl.dynActive = (dp0 != 0.0 || dp1 != 0.0);

        if (sl.dynActive)
        {
            auto& D = sl.dyn;

            // Ballistics: onePoleCoeff calls std::exp, so it runs only when the
            // ms value actually moved — never per sample.
            const float atkMs = sl.attackPtr
                ? sl.attackPtr->load(std::memory_order_relaxed) : 10.0f;
            const float relMs = sl.releasePtr
                ? sl.releasePtr->load(std::memory_order_relaxed) : 100.0f;
            if (atkMs != D.lastAtkMs)
            {
                D.lastAtkMs = atkMs;
                D.aCoef     = xleth_apex::onePoleCoeff(atkMs, sr);
            }
            if (relMs != D.lastRelMs)
            {
                D.lastRelMs = relMs;
                D.rCoef     = xleth_apex::onePoleCoeff(relMs, sr);
            }

            double lo = kMinCutoffHz, hi = sr * kNyquistFactor;
            resolveDynRange(cmn, cmx, sr, lo, hi);
            const double rangeOct = std::log2(hi / lo);

            const double depth  = std::clamp(dp1, -1.0, 1.0);
            const double e      = std::clamp(static_cast<double>(D.env),    0.0, 1.0);
            const double accent = std::clamp(static_cast<double>(D.accent), 0.0, 1.0);

            // Octave-space offset, accent lag folded in BEFORE any clamping.
            const double modOct = depth * rangeOct * (e + kAccentOctScale * accent);
            const double qOff   = depth * e * kQRouteRatio;

            // Ramp from the PREVIOUS block's composed value to this one so the
            // modulation is continuous across control blocks.
            cutA = std::clamp(cutA * std::exp2(D.modOctPrev), lo, hi);
            cutB = std::clamp(cutB * std::exp2(modOct),       lo, hi);
            qA   = applyQOffset(qA, D.qOffsetPrev);
            qB   = applyQOffset(qB, qOff);

            D.modOctPrev  = modOct;
            D.qOffsetPrev = qOff;

            sl.dynEnv.store(static_cast<float>(e), std::memory_order_relaxed);
            sl.dynAccent.store(static_cast<float>(accent), std::memory_order_relaxed);
        }
        else
        {
            // Inert: the follower keeps no memory across a depth-0 stretch, so
            // dialling depth back in always starts from silence rather than
            // from a stale envelope.
            sl.dyn.clear();
            sl.dynEnv.store(0.0f, std::memory_order_relaxed);
            sl.dynAccent.store(0.0f, std::memory_order_relaxed);
        }

        sl.effCutoffHz.store(static_cast<float>(clampCutoff(cutB, sr)),
                             std::memory_order_relaxed);
        sl.effQ.store(static_cast<float>(std::clamp(qB, kMinQ, kMaxQ)),
                      std::memory_order_relaxed);

        if (sl.onePole)
        {
            const double pi = juce::MathConstants<double>::pi;
            const double ga = std::tan(pi * clampCutoff(cutA, sr) / sr);
            const double gb = std::tan(pi * clampCutoff(cutB, sr) / sr);
            const float  G0 = static_cast<float>(ga / (1.0 + ga));
            const float  G1 = static_cast<float>(gb / (1.0 + gb));
            sl.g1  = G0;
            sl.dg1 = (G1 - G0) * invN;

            // Keep the SVF ramps inert while the one-pole path is live.
            for (auto& S : sl.stages)
            {
                S.da1 = S.da2 = S.da3 = 0.0f;
                S.dm0 = S.dm1 = S.dm2 = 0.0f;
            }
        }
        else
        {
            sl.g1 = 0.0f; sl.dg1 = 0.0f;
            for (int st = 0; st < sl.stageCount; ++st)
            {
                StageDesign d0, d1;
                designStage(d0, type, cutA, stageQ(qA, sl.stageCount, st),
                            gn0, mp0, sr, sl.selfOsc);
                designStage(d1, type, cutB, stageQ(qB, sl.stageCount, st),
                            gn1, mp1, sr, sl.selfOsc);

                auto& S = sl.stages[st];
                S.a1 = static_cast<float>(d0.a1);
                S.a2 = static_cast<float>(d0.a2);
                S.a3 = static_cast<float>(d0.a3);
                S.m0 = static_cast<float>(d0.m0);
                S.m1 = static_cast<float>(d0.m1);
                S.m2 = static_cast<float>(d0.m2);
                S.da1 = static_cast<float>(d1.a1 - d0.a1) * invN;
                S.da2 = static_cast<float>(d1.a2 - d0.a2) * invN;
                S.da3 = static_cast<float>(d1.a3 - d0.a3) * invN;
                S.dm0 = static_cast<float>(d1.m0 - d0.m0) * invN;
                S.dm1 = static_cast<float>(d1.m1 - d0.m1) * invN;
                S.dm2 = static_cast<float>(d1.m2 - d0.m2) * invN;
            }
        }

        // Drive: tanh(d*x)/d, which keeps SMALL-signal gain at exactly unity for
        // every d and progressively saturates whatever is already hot — the
        // point of putting it in front of a resonant filter.  Pure tanh is not
        // the identity at d = 1, so the nonlinearity is faded in from the dry
        // signal over the first dB of drive: 0 dB is therefore exactly
        // transparent with no step at the bottom of the range.  Both legs are
        // memoryless, so the fade cannot comb.
        sl.driveOn = (std::max(dr0, dr1) > 1.0e-4);
        if (sl.driveOn)
        {
            const float d0 = static_cast<float>(std::pow(10.0, std::max(dr0, 0.0) / 20.0));
            const float d1 = static_cast<float>(std::pow(10.0, std::max(dr1, 0.0) / 20.0));
            const float b0 = static_cast<float>(std::clamp(dr0, 0.0, 1.0));
            const float b1 = static_cast<float>(std::clamp(dr1, 0.0, 1.0));
            sl.drive       = d0;
            sl.dDrive      = (d1 - d0) * invN;
            sl.invDrive    = 1.0f / d0;
            sl.dInvDrive   = (1.0f / d1 - 1.0f / d0) * invN;
            sl.driveBlend  = b0;
            sl.dDriveBlend = (b1 - b0) * invN;
        }
        else
        {
            sl.drive = sl.invDrive = 1.0f;
            sl.dDrive = sl.dInvDrive = 0.0f;
            sl.driveBlend = sl.dDriveBlend = 0.0f;
        }

        const float m0 = std::clamp(static_cast<float>(mx0), 0.0f, 1.0f);
        const float m1 = std::clamp(static_cast<float>(mx1), 0.0f, 1.0f);
        sl.mix  = m0;
        sl.dMix = (m1 - m0) * invN;
    }

    // One sample of the dynamics detector, fed the slot's OWN input (whatever
    // the slots before it produced).  Everything here is mul/add/branch — no
    // transcendental, no allocation, no branchy data structure.
    static void updateDetector(SlotState& sl, float l, float r, bool stereo)
    {
        auto& D = sl.dyn;

        // 30 Hz one-pole high pass per channel, so a kick's fundamental cannot
        // sit on the envelope and pin the sweep wide open.
        const float hl = l - D.hpX1[0] + D.hpR * D.hpY1[0];
        D.hpX1[0] = l;
        D.hpY1[0] = xleth_filter::flushDenormal(hl);

        float det = std::abs(hl);
        if (stereo)
        {
            const float hr = r - D.hpX1[1] + D.hpR * D.hpY1[1];
            D.hpX1[1] = r;
            D.hpY1[1] = xleth_filter::flushDenormal(hr);
            det = std::max(det, std::abs(hr));   // stereo-LINKED peak
        }

        const float env = D.follower.process(det, D.aCoef, D.rCoef, D.holdSamples);
        D.env = env;

        // 303 accent lag.  It leaks every sample and charges a fixed fraction of
        // its remaining headroom on each rising transient, so a run of accents
        // stacks (each one starts from what the last one left behind) instead of
        // retriggering from zero — that accumulation IS the rising acid cry.
        D.accent -= D.leakCoef * D.accent;
        if (D.armed)
        {
            if (env > kAccentOnLevel)
            {
                D.accent += kAccentCharge * (1.0f - D.accent);
                D.armed   = false;
            }
        }
        else if (env < kAccentOffLevel)
        {
            D.armed = true;
        }
        D.accent = xleth_filter::flushDenormal(D.accent);
    }

    // One sample through one slot's wet path (drive -> cascade -> DC block).
    static float processSlotSample(SlotState& sl, int ch, float x)
    {
        float v0 = x;

        if (sl.driveOn)
        {
            const float sat = xleth_filter::fastTanh(v0 * sl.drive) * sl.invDrive;
            v0 += sl.driveBlend * (sat - v0);
        }

        if (sl.onePole)
        {
            auto& S = sl.stages[0];
            const float v  = (v0 - S.z[ch]) * sl.g1;
            const float lp = v + S.z[ch];
            S.z[ch] = xleth_filter::flushDenormal(lp + v);
            v0 = sl.highPass ? (v0 - lp) : lp;
        }
        else
        {
            for (int st = 0; st < sl.stageCount; ++st)
            {
                auto& S = sl.stages[st];
                const float v3 = v0 - S.ic2eq[ch];
                const float v1 = S.a1 * S.ic1eq[ch] + S.a2 * v3;
                const float v2 = S.ic2eq[ch] + S.a2 * S.ic1eq[ch] + S.a3 * v3;

                float n1 = 2.0f * v1 - S.ic1eq[ch];
                // Self-osc: the ONLY thing standing between k ~ 0 and an
                // unbounded pole is this soft clip in the resonance path.
                if (sl.selfOsc) n1 = xleth_filter::fastTanh(n1);
                S.ic1eq[ch] = xleth_filter::flushDenormal(n1);
                S.ic2eq[ch] = xleth_filter::flushDenormal(2.0f * v2 - S.ic2eq[ch]);

                v0 = S.m0 * v0 + S.m1 * v1 + S.m2 * v2;
            }
        }

        // DC blocker (required by self-osc; always on so engaging it can't click).
        const float y = v0 - sl.dcX1[ch] + sl.dcR * sl.dcY1[ch];
        sl.dcX1[ch] = v0;
        sl.dcY1[ch] = xleth_filter::flushDenormal(y);
        return y;
    }

    // ── APVTS helpers ───────────────────────────────────────────────────────

    static juce::String paramId(int slotIndex, const char* suffix)
    {
        return "s" + juce::String(slotIndex) + "_" + suffix;
    }

    bool setParamDirect(int slotIndex, const std::string& name, float value)
    {
        const juce::String pid = paramId(slotIndex, name.c_str());
        auto* param = apvts_.getParameter(pid);
        if (!param) return false;
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(param);
        if (!rp) return false;
        param->setValueNotifyingHost(rp->convertTo0to1(value));
        return true;
    }

    float readParam(int slotIndex, const char* suffix) const
    {
        auto* raw = apvts_.getRawParameterValue(paramId(slotIndex, suffix));
        return raw ? raw->load(std::memory_order_relaxed) : 0.0f;
    }

    static const char* const* slotParamNames(int& countOut)
    {
        static const char* names[] = {
            "enabled", "type", "cutoff", "q", "gain", "morph", "slope",
            "drive", "mix", "cut_min", "cut_max",
            "dyn_depth", "dyn_attack", "dyn_release"
        };
        countOut = static_cast<int>(sizeof(names) / sizeof(names[0]));
        return names;
    }

    void copySlotParams(int srcSlot, int dstSlot)
    {
        int n = 0;
        const char* const* names = slotParamNames(n);
        for (int i = 0; i < n; ++i)
            setParamDirect(dstSlot, names[i], readParam(srcSlot, names[i]));
    }

    // ── APVTS parameter layout factory ──────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Nar = juce::NormalisableRange<float>;

        std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
        params.reserve(kMaxSlots * 14);

        // Same skews as the EQ: slider midpoint lands on ~1 kHz / ~1.1 Q.
        constexpr float kFreqSkew = 0.23f;
        constexpr float kQSkew    = 0.18f;

        for (int i = 0; i < kMaxSlots; ++i)
        {
            const juce::String prefix = "s" + juce::String(i) + "_";
            const juce::String label  = "S" + juce::String(i) + " ";

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "enabled", 1 }, label + "Enabled",
                Nar(0.0f, 1.0f, 1.0f), 1.0f));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "type", 1 }, label + "Type",
                Nar(0.0f, static_cast<float>(kNumSlotTypes - 1), 1.0f), 0.0f));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "cutoff", 1 }, label + "Cutoff",
                Nar(20.0f, 20000.0f, 0.0f, kFreqSkew), 1000.0f,
                juce::AudioParameterFloatAttributes().withLabel("Hz")));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "q", 1 }, label + "Q",
                Nar(static_cast<float>(kMinQ), static_cast<float>(kMaxQ), 0.0f, kQSkew),
                0.7071f));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "gain", 1 }, label + "Gain",
                Nar(-24.0f, 24.0f), 0.0f,
                juce::AudioParameterFloatAttributes().withLabel("dB")));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "morph", 1 }, label + "Morph",
                Nar(0.0f, 1.0f), 0.0f));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "slope", 1 }, label + "Slope",
                Nar(0.0f, static_cast<float>(kNumSlopes - 1), 1.0f), 1.0f));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "drive", 1 }, label + "Drive",
                Nar(0.0f, 24.0f), 0.0f,
                juce::AudioParameterFloatAttributes().withLabel("dB")));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "mix", 1 }, label + "Mix",
                Nar(0.0f, 1.0f), 1.0f));

            // ── Reserved for the modulation prompt (declared now so the
            //    parameter layout — and therefore every saved project — does
            //    not change when the dynamics follower lands). ──────────────

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "cut_min", 1 }, label + "Cut Min",
                Nar(20.0f, 20000.0f, 0.0f, kFreqSkew), 20.0f,
                juce::AudioParameterFloatAttributes().withLabel("Hz")));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "cut_max", 1 }, label + "Cut Max",
                Nar(20.0f, 20000.0f, 0.0f, kFreqSkew), 20000.0f,
                juce::AudioParameterFloatAttributes().withLabel("Hz")));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "dyn_depth", 1 }, label + "Dyn Depth",
                Nar(-1.0f, 1.0f), 0.0f));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "dyn_attack", 1 }, label + "Dyn Attack",
                Nar(0.1f, 100.0f), 10.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));

            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "dyn_release", 1 }, label + "Dyn Release",
                Nar(1.0f, 2000.0f), 100.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
        }

        return { std::make_move_iterator(params.begin()),
                 std::make_move_iterator(params.end()) };
    }

    // ── Data members ────────────────────────────────────────────────────────
    SlotState           slots_[kMaxSlots];
    std::atomic<int>    slotCount_{0};
    std::atomic<double> sampleRate_{44100.0};
};

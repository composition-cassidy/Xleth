#pragma once

#include "audio/ApexDsp.h"
#include "audio/XlethEffectBase.h"
#include "model/EnvelopeParameterModulation.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
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
// ─── Analog-modelled & character slot types ─────────────────────────────────
//
// Seven further cores sit alongside the SVF.  They are ADDITIVE: the SVF path
// above is untouched, every new type appends to the end of the SlotType choice
// list (never reorders it, so saved projects keep their meaning), and every one
// of them obeys the same pipeline — coefficients in double at 32-sample control
// block rate, per-sample lerp, fc/Q clamped AFTER modulation summing, states
// flushed, ScopedNoDenormals, per-slot output soft clip.  All of them therefore
// compose with the dynamics follower and the per-slot LFO/Envelope for free:
// those write into cutA/cutB/qA/qB before the clamp, and every core below reads
// the SAME clamped endpoints the SVF reads.
//
//   moog24    4-pole TPT transistor ladder.  Four TPT one-pole sections with
//             global feedback k; the linear loop is solved in CLOSED FORM
//             (y4 = (G^4*u + S) / (1 + k*G^4)) and the transistor nonlinearity
//             is then resolved with exactly ONE fixed-point iteration — a fixed,
//             deterministic cost, never a convergence loop.  k is hard-clamped
//             to 4 and the states to +/-10; the tanh in the feedback path is
//             what bounds self-oscillation at k = 4.
//
//   acid303   TB-303 diode ladder — the flagship.  Same 4-pole TPT skeleton,
//             but with the three things that make a 303 a 303: a HIGH PASS in
//             the resonance feedback path (the coupling capacitor, 150 Hz —
//             this is why a 303 keeps its bottom end at high resonance instead
//             of going thin), an asymmetric cubic diode shaper instead of tanh,
//             and an exponential (V/oct) cutoff CV response, which it gets for
//             free from the octave-space modulation pipeline shared with every
//             other slot type.
//
//   sk12/24   Sallen-Key, 2-pole, built from the same TPT one-pole primitive.
//             Cheapest topology here (~2-3x a biquad).  Linear resonance for a
//             clean ARP-style Q; with drive up, the feedback path gets an
//             ASYMMETRIC diode limiter instead, which is the MS-20 scream.
//
//   steiner*  Steiner-Parker input-injection modes.  NOT a new struct — the
//             same SVF core with the input injected at a different node (see
//             processSteinerSample), plus an optional tanh on the HP node.
//
//   combFF/FB Dedicated structure: a preallocated power-of-two circular delay
//             line per channel with first-order allpass (Dattorro) fractional
//             interpolation, because the delay time is modulatable and linear
//             interpolation thumps under modulation.
//
//   formant   Parallel bank of three constant-peak-gain SVF bandpasses per
//             channel on the Peterson & Barney (1952) adult-male vowel table,
//             morphed by sliding the band FREQUENCIES in the log domain — not
//             by crossfading two filter outputs, which would null in the middle.
//
//   tilt      Twin shelves at a shared pivot from the SVF's existing shelf mix
//             coefficients.  No new filter math at all.
//
// CPU: the two ladders cost roughly 10-15x a biquad because of the per-sample
// nonlinearity.  Each slot carries an internal `nonlinear` quality flag
// (setSlotNonlinear) that drops a ladder / SK / Steiner slot to its pure linear
// closed-form core, which is the escape hatch if 8 nonlinear slots ever stop
// fitting the budget.  It defaults to TRUE (nonlinear) at 1x sample rate.
// There is deliberately NO oversampling in this pass; the place it would hook
// in is processSlotSample's per-sample body — an inner 2x loop around the
// ladder/SK cores with a half-band filter either side, which is the only part
// of the chain whose aliasing is audible.
//
// ─── Sources & licenses (every external source used, and how) ───────────────
//
//   Cytomic / Andrew Simper, "Solving the continuous SVF equations using
//     trapezoidal integration and equivalent currents" (public paper).
//     PUBLIC PAPER — implemented from the published math.  The SVF core.
//
//   Vadim Zavalishin, "The Art of VA Filter Design" (free, Native Instruments).
//     PUBLIC BOOK — implemented from the published math.  ch. 3-4 TPT one-pole,
//     ch. 5-6 the transistor ladder and its closed-form linear solve, ch. 7 the
//     Sallen-Key / Korg-35 topology (the SK derivation in processSkSample is
//     carried out from the analog circuit in the comments there).
//
//   Robin Schmidt, Open303 — engine core is MIT licensed
//     (github.com/RobinSchmidt/Open303).  The acid303 core here reproduces the
//     Open303 TeeBeeFilter TOPOLOGY and its documented constants: four one-pole
//     stages, a one-pole high pass at 150 Hz in the resonance feedback path,
//     and a cubic soft shaper.  It is written from that published structure and
//     from the VA-filter math above — NO Open303 source was copied into this
//     file, so nothing here is a derivative work carrying the MIT terms; the
//     attribution is given because the design is Schmidt's.  If Open303 source
//     is ever pasted in verbatim, its MIT header must come with it.
//
//   Tim Stinchcombe, "Analysis of the Moog Transistor Ladder and Derivative
//     Filters" / TB-303 diode-ladder analysis (timstinchcombe.co.uk).
//     PUBLISHED ANALYSIS — used only as a response-shape sanity reference.  The
//     full six-extra-pole diode-ladder circuit model is deliberately NOT
//     implemented at runtime; it buys accuracy nobody can hear for a cost
//     nobody can afford.
//
//   Jon Dattorro, "Effect Design Part 2" (JAES 1997) — first-order allpass
//     fractional delay interpolation.  PUBLISHED PAPER — implemented from the
//     published math.  The comb's fractional delay.
//
//   Peterson & Barney, "Control Methods Used in a Study of the Vowels"
//     (JASA 1952) — the formant frequency table.  PUBLISHED DATA (a table of
//     measurements, not code).  Coefficients are computed from it at runtime;
//     the pre-baked truncated-float vowel coefficient sets that circulate on
//     musicdsp are the classic instability trap and are NOT used.
//
//   Huovilainen & Valimaki — nonlinear digital Moog ladder models.
//     PUBLISHED PAPERS — the per-stage-nonlinearity idea.
//
//   juce::dsp::LadderFilter — used ONLY as a response oracle in the tests.  It
//     is not called from this file.
//
//   NOT USED, not even looked at for code: Surge XT / sst-filters, Vital,
//   Odin2 (all GPLv3 — incompatible), and the JC303 wrapper (GPL; only the
//   Open303 ENGINE is MIT, and even that is not copied here).
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

// ─── Nonlinearities used by the analog-modelled cores ───────────────────────

// The cheap rational tanh approximation  x*(27 + x^2) / (27 + 9x^2).  It is a
// good tanh only near the origin: it crosses 1.0 at exactly x = 3 and then
// keeps GROWING (~x/9), so the argument MUST be clamped to +/-3, at which point
// it becomes a hard-limited saturator with a tanh-shaped knee.  That clamp is
// the whole reason the ladder's feedback path cannot run away.
inline float ladderTanh(float x) noexcept
{
    const float xc = std::clamp(x, -3.0f, 3.0f);
    const float x2 = xc * xc;
    return xc * (27.0f + x2) / (27.0f + 9.0f * x2);
}

// The TB-303's diode shaper: a cubic soft clip, x - x^3/6, hard-limited at the
// point where its derivative reaches zero (|x| = sqrt(2), value +/-2*sqrt(2)/3)
// so it stays monotone.  Normalised to unity asymptote.  Cubic rather than tanh
// because the 303's diodes produce a gentler, more even-harmonic knee than a
// transistor pair — this is the same shaper Open303 uses.
inline float diodeShape(float x) noexcept
{
    constexpr float kLim  = 1.41421356f;   // sqrt(2): where d/dx (x - x^3/6) hits 0
    constexpr float kPeak = 0.94280904f;   // the shaper's value there, 2*sqrt(2)/3
    if (x >=  kLim) return  kPeak;
    if (x <= -kLim) return -kPeak;
    return x - x * x * x * (1.0f / 6.0f);  // unity small-signal gain
}

// Asymmetric diode limiter for the Sallen-Key feedback path — a shunt diode
// pair with unequal forward drops.  Small-signal gain is exactly unity for both
// halves (the /d), so it only bites once the feedback is already hot; the
// asymmetry is what produces the even harmonics of an MS-20 scream.  The DC
// offset it introduces is removed by the slot's always-on DC blocker.
inline float diodeLimit(float x, float d) noexcept
{
    constexpr float kAsym = 0.7f;    // the negative half clips ~3 dB later
    const float dd = (x >= 0.0f) ? d : d * kAsym;
    return fastTanh(x * dd) / dd;
}

// ─── Formant / vowel table — Peterson & Barney (1952), adult male ───────────
//
// F1/F2/F3 centre frequencies in Hz, per-formant bandwidths inside the
// published 60-100 Hz (F1) / 90-200 Hz (F2, F3) windows, and relative
// amplitudes.  The amplitudes are a musical choice, NOT from the paper: P&B's
// own relative levels drop F2/F3 so far that the vowel stops reading as a
// filter effect.  Coefficients are always computed from these numbers at
// runtime — never pre-baked, which is where the musicdsp vowel filter goes
// unstable.  Order is the wire contract with filterStore.js.
enum class Vowel : int { Ee = 0, Ah = 1, Oh = 2, Oo = 3 };
static constexpr int kNumVowels  = 4;
static constexpr int kNumFormants = 3;

struct VowelFormants
{
    double f[kNumFormants];    // centre frequency, Hz
    double bw[kNumFormants];   // bandwidth, Hz
    double amp[kNumFormants];  // linear amplitude
};

inline const VowelFormants& vowelTable(int index) noexcept
{
    static constexpr VowelFormants kTable[kNumVowels] = {
        //  F1     F2      F3        bandwidths        amplitudes
        { { 270.0, 2290.0, 3010.0 }, { 80.0, 120.0, 160.0 }, { 1.0, 0.60, 0.35 } }, // ee /i/
        { { 730.0, 1090.0, 2440.0 }, { 80.0, 120.0, 160.0 }, { 1.0, 0.60, 0.35 } }, // ah /a/
        { { 570.0,  840.0, 2410.0 }, { 80.0, 120.0, 160.0 }, { 1.0, 0.60, 0.35 } }, // oh /o/
        { { 300.0,  870.0, 2240.0 }, { 80.0, 120.0, 160.0 }, { 1.0, 0.60, 0.35 } }, // oo /u/
    };
    return kTable[std::clamp(index, 0, kNumVowels - 1)];
}

// ─── Per-slot LFO / Envelope modulators (in-panel, in-effect) ───────────────
//
// Both compose their signal into a chosen destination parameter the SAME way the
// dynamics follower composes its own — around the smoothed base, at control-block
// rate, ramped per sample, provably inert when off/at depth 0.  The heavy,
// timeline-aware pieces reuse existing pure functions: the Envelope's ADSR is
// xleth::envmod::evaluateEnvelopeAdsr against a gate the MixEngine pushes in; the
// LFO free-runs from XlethEffectBase's global transport position, so neither
// needs the FX-graph snapshot/mailbox/applier path.

// A modulator's destination — the six continuous per-slot params it makes sense
// to sweep (type/slope are discrete; the follower's own cut_min/max/attack/etc.
// are not sound params).  Order is the wire contract with filterStore.js.
enum class ModDest : int {
    Cutoff = 0, Q = 1, Gain = 2, Morph = 3, Drive = 4, Mix = 5
};
static constexpr int kNumModDests = 6;

// LFO waveform — a fixed shape set (scalar param) rather than the FX-graph's
// arbitrary breakpoint editor: keeps every modulator setting a plain APVTS
// scalar (free serialization, no message↔audio handoff buffer) and is more
// approachable than drawing a curve.  Order is the wire contract with the panel.
enum class LfoWave : int {
    Sine = 0, Triangle = 1, SawUp = 2, SawDown = 3, Square = 4, SampleHold = 5
};
static constexpr int kNumLfoWaves = 6;

// ─── Modulator lanes ────────────────────────────────────────────────────────
//
// A slot no longer owns one LFO + one Envelope + one dynamics follower.  It owns
// kMaxModsPerSlot generic LANES, each of which picks its own kind and its own
// destination, so "two LFOs on different knobs" or "an envelope on cutoff and
// another on drive" are all just lane configurations.  Every lane composes into
// the destination through the SAME applyModToDest fold, so several lanes aimed at
// one knob add up in that knob's own domain for free.
//
// A lane declares the UNION of all three kinds' parameters (18 of them); the
// parameters outside the lane's active kind are simply never read, exactly like
// vowel_a / vowel_b on a non-formant slot type.  Off is 0 so a lane that has
// never been touched is inert, which is what makes the whole array free.
enum class ModKind : int { Off = 0, Lfo = 1, Env = 2, Dyn = 3 };
static constexpr int kNumModKinds    = 4;
static constexpr int kMaxModsPerSlot = 6;

// Deterministic per-cycle pseudo-random in [-1,1] for sample & hold.  A pure
// function of the integer cycle index, so the LFO stays position-pure (correct
// across seek / loop-wrap) exactly like the graph LFO.
inline float sampleHoldValue(int64_t cycleIndex) noexcept
{
    uint64_t x = static_cast<uint64_t>(cycleIndex) * 0x9E3779B97F4A7C15ull + 0xD1B54A32D192ED03ull;
    x ^= x >> 30; x *= 0xBF58476D1CE4E5B9ull;
    x ^= x >> 27; x *= 0x94D049BB133111EBull;
    x ^= x >> 31;
    return static_cast<float>(static_cast<double>(x >> 40) / static_cast<double>(1ull << 24)) * 2.0f - 1.0f;
}

// Bipolar [-1,1] LFO sample from an absolute cycle position (integer part =
// which cycle, fractional part = phase within it).
inline float evalLfoShape(LfoWave wave, double cyclePos) noexcept
{
    const double phase = cyclePos - std::floor(cyclePos);
    switch (wave)
    {
        case LfoWave::Sine:     return std::sin(static_cast<float>(phase) * 6.2831853071795864769f);
        case LfoWave::Triangle: return 1.0f - 4.0f * std::abs(static_cast<float>(phase) - 0.5f);
        case LfoWave::SawUp:    return 2.0f * static_cast<float>(phase) - 1.0f;
        case LfoWave::SawDown:  return 1.0f - 2.0f * static_cast<float>(phase);
        case LfoWave::Square:   return phase < 0.5 ? 1.0f : -1.0f;
        case LfoWave::SampleHold:
            return sampleHoldValue(static_cast<int64_t>(std::floor(cyclePos)));
    }
    return 0.0f;
}

// Full-scale sweep amounts at |depth * signal| == 1, per destination domain.
// Octaves for the log-domain params, natural units for the linear ones.
static constexpr double kModCutoffOctaves = 4.0;  // ± this many octaves on cutoff
static constexpr double kModGainDb        = 24.0; // ± dB on gain
static constexpr double kModDriveDb       = 24.0; // ± dB on drive

// Modulator activation fade (enable / disable), same idea as the slot gate:
// ramps the whole contribution in/out so toggling a modulator never clicks.
static constexpr double kModActivationMs = 10.0;

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

    // ── Analog / character core guard rails ──────────────────────────────────
    static constexpr double kLadderMaxK      = 4.0;    // global ladder feedback ceiling
    static constexpr float  kLadderStateMax  = 10.0f;  // hard clamp on ladder states
    static constexpr double kDiodeFbHpHz     = 150.0;  // 303 coupling-cap high pass
    static constexpr double kSkMaxK          = 2.99;   // Sallen-Key K, 3 = self-osc
    static constexpr double kCombMaxMs       = 50.0;   // longest comb delay
    static constexpr double kCombMinDelay    = 2.0;    // samples; keeps the loop causal
    static constexpr double kCombMaxG        = 0.99;   // |feedforward / feedback| ceiling
    static constexpr double kCombMinT60      = 0.02;   // seconds, at Q = kMinQ
    static constexpr double kCombMaxT60      = 5.0;    // seconds, at Q = kMaxQ
    static constexpr double kTiltMaxDb       = 12.0;   // tilt is +/- this, not +/- 24
    static constexpr double kTiltPivotMinHz  = 200.0;
    static constexpr double kTiltPivotMaxHz  = 1000.0;
    static constexpr double kFormantHeadMax  = 12.0;   // head-size shift, semitones

    // Slot types.  APPEND ONLY — the index IS the serialized value, so reordering
    // any existing entry silently rewrites every saved project's filter.
    enum class SlotType : int {
        LP12 = 0, HP12 = 1, BP = 2, Notch = 3, Allpass = 4,
        Peak = 5, LowShelf = 6, HighShelf = 7, Morph = 8,
        // ── Analog-modelled & character types ──
        Moog24    = 9,    // 4-pole transistor ladder
        Acid303   = 10,   // TB-303 diode ladder
        SK12      = 11,   // Sallen-Key 2-pole
        SK24      = 12,   // Sallen-Key x2
        SteinerLP = 13,   // input injected at the HP node
        SteinerBP = 14,   // input injected at the 2nd integrator
        SteinerHP = 15,   // input injected after both integrators
        CombFF    = 16,   // feedforward comb
        CombFB    = 17,   // feedback comb / resonator
        Formant   = 18,   // parallel 3-band vowel bank
        Tilt      = 19    // twin shelves at a shared pivot
    };
    static constexpr int kNumSlotTypes = 20;

    // Which DSP structure a slot type runs on.  Everything that is not listed
    // explicitly runs the untouched SVF (or its one-pole 6 dB variant).
    enum class SlotCore : int {
        Svf = 0, Ladder = 1, SallenKey = 2, Steiner = 3, Comb = 4, Formant = 5
    };

    // slope param: 0 = 6 dB, 1 = 12 dB, 2 = 24 dB, 3 = 48 dB
    static constexpr int kNumSlopes = 4;

    // How many APVTS parameters each slot declares (see createLayout /
    // slotParamNames — the two must agree, and test_xlethfilter checks it).
    //
    // kNumBaseSlotParams covers the 12 live filter params PLUS the 22 LEGACY
    // fixed-modulator params (lfo_*, env_*, dyn_*, cut_min/cut_max).  Those are
    // still declared, with their original IDs, ranges and defaults, purely so a
    // project saved before modulator lanes existed still deserializes — see
    // migrateLegacyMods().  Nothing on the audio path reads them any more.
    static constexpr int kNumBaseSlotParams = 34;
    // Parameters one modulator lane declares (the union of all three kinds).
    static constexpr int kNumModParams      = 18;
    static constexpr int kNumSlotParams =
        kNumBaseSlotParams + xleth_filter::kMaxModsPerSlot * kNumModParams;

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

            // Formant head-size shift — smoothed so dragging it slides the whole
            // bank instead of stepping it (bipolar, hence Linear).
            registerSmoothedParam(paramId(i, "head").toStdString(),
                                  SmoothType::Linear, 20.0f);

            // Per-lane smoothed params.  Depth is BIPOLAR, so it must be Linear —
            // the Multiplicative smoother clamps its target to >= 1e-6 and cannot
            // represent a negative (ducking) depth at all.  A dynamics lane's
            // sweep range is smoothed for the same reason the base cutoff is:
            // dragging it while audio runs must glide, not step.
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            {
                registerSmoothedParam(laneParamId(i, j, "depth").toStdString(),
                                      SmoothType::Linear, 20.0f);
                registerSmoothedParam(laneParamId(i, j, "cut_min").toStdString(),
                                      SmoothType::Multiplicative, 20.0f);
                registerSmoothedParam(laneParamId(i, j, "cut_max").toStdString(),
                                      SmoothType::Multiplicative, 20.0f);
            }
            // The legacy cut_min / cut_max / dyn_depth / lfo_depth / env_depth
            // params are deliberately NOT smoothed any more: nothing on the audio
            // path reads them, they exist only as migration source.
        }
    }

    // ── Serialization (extends base to include slotCount_) ──────────────────

    // Bumped when the modulator layout changes shape.  Absent (0) means the
    // project predates modulator lanes and its fixed lfo_/env_/dyn_ params must
    // be folded into lanes — see migrateLegacyMods.
    static constexpr int kModSchemaVersion = 1;

    void getStateInformation(juce::MemoryBlock& dest) override
    {
        auto xml = apvts_.copyState().createXml();
        if (xml)
        {
            xml->setAttribute("slotCount", slotCount_.load(std::memory_order_relaxed));
            xml->setAttribute("modSchema", kModSchemaVersion);
            copyXmlToBinary(*xml, dest);
        }
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        auto xml = getXmlFromBinary(data, sizeInBytes);
        if (xml && xml->hasTagName(apvts_.state.getType()))
        {
            const int count  = xml->getIntAttribute("slotCount", 0);
            const int schema = xml->getIntAttribute("modSchema", 0);
            apvts_.replaceState(juce::ValueTree::fromXml(*xml));
            slotCount_.store(std::clamp(count, 0, kMaxSlots), std::memory_order_relaxed);
            if (schema < 1)
                migrateLegacyMods();
            for (auto& sl : slots_)
                sl.clearState();
        }
    }

    // Fold a pre-lanes project's fixed modulator trio into lanes (main thread,
    // during setStateInformation only).  The legacy params are still declared
    // with their original IDs and defaults, so the state above restored them
    // faithfully; this reads them out, writes the equivalent lanes, and then
    // switches the legacy ones off so a re-save cannot migrate twice.
    //
    // Lane order matches the old panel's deck order — follower, LFO, envelope —
    // so a migrated slot reads the way it used to look.
    void migrateLegacyMods()
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        for (int i = 0; i < count; ++i)
        {
            int lane = 0;
            const auto nextLane = [&]() -> int {
                return (lane < xleth_filter::kMaxModsPerSlot) ? lane++ : -1;
            };

            // Dynamics follower — depth-gated, so a depth of exactly 0 means it
            // was doing nothing and does not deserve a lane.
            const float dynDepth = readParam(i, "dyn_depth");
            if (dynDepth != 0.0f)
            {
                const int j = nextLane();
                if (j >= 0)
                {
                    setLaneParam(i, j, "kind",  static_cast<float>(xleth_filter::ModKind::Dyn));
                    // The legacy follower had no dest of its own: it always swept
                    // cutoff (with its companion Q route).
                    setLaneParam(i, j, "dest",  static_cast<float>(xleth_filter::ModDest::Cutoff));
                    setLaneParam(i, j, "depth", dynDepth);
                    setLaneParam(i, j, "dyn_attack",  readParam(i, "dyn_attack"));
                    setLaneParam(i, j, "dyn_release", readParam(i, "dyn_release"));
                    setLaneParam(i, j, "cut_min",     readParam(i, "cut_min"));
                    setLaneParam(i, j, "cut_max",     readParam(i, "cut_max"));
                }
                setParamDirect(i, "dyn_depth", 0.0f);
            }

            // LFO — toggle-gated.
            if (readParam(i, "lfo_on") > 0.5f)
            {
                const int j = nextLane();
                if (j >= 0)
                {
                    setLaneParam(i, j, "kind",      static_cast<float>(xleth_filter::ModKind::Lfo));
                    setLaneParam(i, j, "dest",      readParam(i, "lfo_dest"));
                    setLaneParam(i, j, "depth",     readParam(i, "lfo_depth"));
                    setLaneParam(i, j, "shape",     readParam(i, "lfo_shape"));
                    setLaneParam(i, j, "rate_mode", readParam(i, "lfo_rate_mode"));
                    setLaneParam(i, j, "rate_ms",   readParam(i, "lfo_rate_ms"));
                    setLaneParam(i, j, "sync",      readParam(i, "lfo_sync"));
                    setLaneParam(i, j, "phase",     readParam(i, "lfo_phase"));
                }
                setParamDirect(i, "lfo_on", 0.0f);
            }

            // Envelope — toggle-gated.
            if (readParam(i, "env_on") > 0.5f)
            {
                const int j = nextLane();
                if (j >= 0)
                {
                    setLaneParam(i, j, "kind",    static_cast<float>(xleth_filter::ModKind::Env));
                    setLaneParam(i, j, "dest",    readParam(i, "env_dest"));
                    setLaneParam(i, j, "depth",   readParam(i, "env_depth"));
                    setLaneParam(i, j, "attack",  readParam(i, "env_attack"));
                    setLaneParam(i, j, "hold",    readParam(i, "env_hold"));
                    setLaneParam(i, j, "decay",   readParam(i, "env_decay"));
                    setLaneParam(i, j, "sustain", readParam(i, "env_sustain"));
                    setLaneParam(i, j, "release", readParam(i, "env_release"));
                    setLaneParam(i, j, "slides",  readParam(i, "env_slides"));
                }
                setParamDirect(i, "env_on", 0.0f);
            }
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

        // Formant bank (inert for every other type).
        setParamDirect(count, "vowel_a",     static_cast<float>(xleth_filter::Vowel::Ah));
        setParamDirect(count, "vowel_b",     static_cast<float>(xleth_filter::Vowel::Ee));
        setParamDirect(count, "head",        0.0f);

        // Per-slot LFO — OFF by default so a freshly added slot never boots up
        // already modulating (the follower is depth-gated; these two are toggle-
        // gated, so all three are silent on a new slot).
        setParamDirect(count, "lfo_on",        0.0f);
        setParamDirect(count, "lfo_dest",      static_cast<float>(xleth_filter::ModDest::Cutoff));
        setParamDirect(count, "lfo_depth",     0.5f);
        setParamDirect(count, "lfo_shape",     static_cast<float>(xleth_filter::LfoWave::Sine));
        setParamDirect(count, "lfo_rate_mode", 1.0f);      // 1 = sync
        setParamDirect(count, "lfo_rate_ms",   500.0f);
        setParamDirect(count, "lfo_sync",      4.0f);      // one cycle per beat
        setParamDirect(count, "lfo_phase",     0.0f);
        // Per-slot Envelope — OFF by default (same reason).
        setParamDirect(count, "env_on",        0.0f);
        setParamDirect(count, "env_dest",      static_cast<float>(xleth_filter::ModDest::Cutoff));
        setParamDirect(count, "env_depth",     0.5f);
        setParamDirect(count, "env_attack",    5.0f);
        setParamDirect(count, "env_hold",      0.0f);
        setParamDirect(count, "env_decay",     120.0f);
        setParamDirect(count, "env_sustain",   0.7f);
        setParamDirect(count, "env_release",   200.0f);
        setParamDirect(count, "env_slides",    0.0f);

        // Modulator lanes — all Off, so a freshly added slot never boots up
        // already modulating, and a slot index being REUSED after removeSlot
        // cannot inherit the previous occupant's lanes.  Each lane's other
        // parameters are reset to its kind defaults too, so the first
        // "Add Modulator" always starts from a known shape.
        for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            resetLane(count, j);

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

    // Set one slot parameter by short name ("cutoff", "q", "type", "m2_depth"...).
    bool setSlotParam(int slotIndex, const std::string& paramName, float value)
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        if (slotIndex < 0 || slotIndex >= count) return false;

        // Adding a modulator is a single write of "m{j}_kind".  A lane coming
        // OUT of Off gets its remaining parameters reset to that kind's defaults
        // first, so the defaults live here rather than being duplicated in the
        // renderer, and a lane that was removed and re-added never comes back
        // carrying the previous modulator's settings.
        const int lane = laneIndexOfKindParam(paramName);
        if (lane >= 0)
        {
            const int wasKind = static_cast<int>(std::lround(readLaneParam(slotIndex, lane, "kind")));
            const int nowKind = std::clamp(static_cast<int>(std::lround(value)),
                                           0, xleth_filter::kNumModKinds - 1);
            if (wasKind == static_cast<int>(xleth_filter::ModKind::Off)
                && nowKind != static_cast<int>(xleth_filter::ModKind::Off))
                resetLane(slotIndex, lane, static_cast<xleth_filter::ModKind>(nowKind));
        }

        return setParamDirect(slotIndex, paramName, value);
    }

    // -1 unless `name` is exactly the kind parameter of a valid lane.
    static int laneIndexOfKindParam(const std::string& name)
    {
        for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            if (name == modParamName(j, "kind")) return j;
        return -1;
    }

    // Put one lane back to the defaults for `kind`, which is what a freshly added
    // modulator of that kind starts from.  Everything but the starting depth is
    // kind-independent, so this is one table.
    //
    // Depth is the exception: an LFO or an envelope wants a usable amount the
    // moment you add it, but a follower is DEPTH-GATED — depth 0 is how it stays
    // provably inert — so it starts at 0 and the user dials it in, exactly as the
    // fixed follower always did.
    void resetLane(int slotIndex, int lane,
                   xleth_filter::ModKind kind = xleth_filter::ModKind::Off)
    {
        const bool bipolarStart = (kind == xleth_filter::ModKind::Lfo
                                || kind == xleth_filter::ModKind::Env);
        setLaneParam(slotIndex, lane, "kind",  static_cast<float>(xleth_filter::ModKind::Off));
        setLaneParam(slotIndex, lane, "dest",  static_cast<float>(xleth_filter::ModDest::Cutoff));
        setLaneParam(slotIndex, lane, "depth", bipolarStart ? 0.5f : 0.0f);
        // LFO
        setLaneParam(slotIndex, lane, "shape",     static_cast<float>(xleth_filter::LfoWave::Sine));
        setLaneParam(slotIndex, lane, "rate_mode", 1.0f);    // tempo sync
        setLaneParam(slotIndex, lane, "rate_ms",   500.0f);
        setLaneParam(slotIndex, lane, "sync",      4.0f);    // one cycle per beat
        setLaneParam(slotIndex, lane, "phase",     0.0f);
        // Envelope
        setLaneParam(slotIndex, lane, "attack",  5.0f);
        setLaneParam(slotIndex, lane, "hold",    0.0f);
        setLaneParam(slotIndex, lane, "decay",   120.0f);
        setLaneParam(slotIndex, lane, "sustain", 0.7f);
        setLaneParam(slotIndex, lane, "release", 200.0f);
        setLaneParam(slotIndex, lane, "slides",  0.0f);
        // Dynamics follower
        setLaneParam(slotIndex, lane, "dyn_attack",  10.0f);
        setLaneParam(slotIndex, lane, "dyn_release", 100.0f);
        setLaneParam(slotIndex, lane, "cut_min",     20.0f);
        setLaneParam(slotIndex, lane, "cut_max",     20000.0f);
    }

    int getSlotCount() const { return slotCount_.load(std::memory_order_relaxed); }

    // ── Per-slot quality (internal, NOT an APVTS param, NOT serialized) ──────
    // False drops moog24 / acid303 / sk / steiner to their pure linear closed
    // form: same poles, same cutoff, no per-sample saturation — roughly a third
    // of the cost.  Defaults to TRUE (nonlinear) at 1x sample rate; this exists
    // as the escape hatch if eight nonlinear slots ever stop fitting the budget,
    // and as the way the CPU tests isolate the cost of the nonlinearity.
    // Plain bool store; the audio thread only ever reads it.
    void setSlotNonlinear(int slotIndex, bool nonlinear)
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return;
        slots_[slotIndex].nonlinear = nonlinear;
    }

    bool getSlotNonlinear(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return true;
        return slots_[slotIndex].nonlinear;
    }

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

    // One lane's modulator output in [0,1] — the follower's envelope for a Dyn
    // lane, the ADSR value for an Env lane, 0 for anything inert.
    float getLaneEnvelope(int slotIndex, int lane) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        if (lane < 0 || lane >= xleth_filter::kMaxModsPerSlot) return 0.0f;
        return slots_[slotIndex].lanes[lane].envOut.load(std::memory_order_relaxed);
    }

    // One lane's 303 accent-lag charge in [0,1] (0 unless it is a live follower).
    float getLaneAccentCharge(int slotIndex, int lane) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        if (lane < 0 || lane >= xleth_filter::kMaxModsPerSlot) return 0.0f;
        return slots_[slotIndex].lanes[lane].accentOut.load(std::memory_order_relaxed);
    }

    // Strongest follower envelope / accent across the slot's lanes.  The panel's
    // per-slot activity dot wants one number for the whole slot, and "the lane
    // pushing hardest" is the honest summary of several followers at once.
    float getSlotDynamicEnvelope(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        float m = 0.0f;
        for (const auto& ln : slots_[slotIndex].lanes)
            if (ln.dynActive)
                m = std::max(m, ln.envOut.load(std::memory_order_relaxed));
        return m;
    }

    float getSlotAccentCharge(int slotIndex) const
    {
        if (slotIndex < 0 || slotIndex >= kMaxSlots) return 0.0f;
        float m = 0.0f;
        for (const auto& ln : slots_[slotIndex].lanes)
            if (ln.dynActive)
                m = std::max(m, ln.accentOut.load(std::memory_order_relaxed));
        return m;
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
            // Formant bank.
            s["vowel_a"]     = static_cast<int>(std::lround(readParam(i, "vowel_a")));
            s["vowel_b"]     = static_cast<int>(std::lround(readParam(i, "vowel_b")));
            s["head"]        = readParam(i, "head");

            // ── Modulator lanes ─────────────────────────────────────────────
            // Every lane is reported, Off ones included, so the panel can index
            // by lane number and knows which slots are free.  Each entry carries
            // the union of the three kinds' settings plus its live telemetry.
            nlohmann::json mods = nlohmann::json::array();
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            {
                const auto& ln = slots_[i].lanes[j];
                nlohmann::json m;
                m["index"]       = j;
                m["kind"]        = static_cast<int>(std::lround(readLaneParam(i, j, "kind")));
                m["dest"]        = static_cast<int>(std::lround(readLaneParam(i, j, "dest")));
                m["depth"]       = readLaneParam(i, j, "depth");
                // LFO
                m["shape"]       = static_cast<int>(std::lround(readLaneParam(i, j, "shape")));
                m["rate_mode"]   = static_cast<int>(std::lround(readLaneParam(i, j, "rate_mode")));
                m["rate_ms"]     = readLaneParam(i, j, "rate_ms");
                m["sync"]        = readLaneParam(i, j, "sync");
                m["phase"]       = readLaneParam(i, j, "phase");
                // Envelope
                m["attack"]      = readLaneParam(i, j, "attack");
                m["hold"]        = readLaneParam(i, j, "hold");
                m["decay"]       = readLaneParam(i, j, "decay");
                m["sustain"]     = readLaneParam(i, j, "sustain");
                m["release"]     = readLaneParam(i, j, "release");
                m["slides"]      = readLaneParam(i, j, "slides") > 0.5f;
                // Dynamics follower
                m["dyn_attack"]  = readLaneParam(i, j, "dyn_attack");
                m["dyn_release"] = readLaneParam(i, j, "dyn_release");
                m["cut_min"]     = readLaneParam(i, j, "cut_min");
                m["cut_max"]     = readLaneParam(i, j, "cut_max");
                // Read-only telemetry.
                m["env"]         = ln.envOut.load(std::memory_order_relaxed);
                m["accent"]      = ln.accentOut.load(std::memory_order_relaxed);
                mods.push_back(std::move(m));
            }
            s["mods"] = std::move(mods);

            // Read-only slot telemetry (see getSlotEffectiveCutoff).
            s["eff_cutoff"]  = slots_[i].effCutoffHz.load(std::memory_order_relaxed);
            s["eff_q"]       = slots_[i].effQ.load(std::memory_order_relaxed);
            s["dyn_env"]     = getSlotDynamicEnvelope(i);
            s["dyn_accent"]  = getSlotAccentCharge(i);
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
            bool     parallel = false;   // formant: sum the sections
            int      stages   = 1;
            double   mix      = 1.0;
            double   g[kMaxStages]{};
            double   k[kMaxStages]{};
            double   m0[kMaxStages]{}, m1[kMaxStages]{}, m2[kMaxStages]{};

            // Character cores that are not a cascade of SVF sections.
            SlotCore core   = SlotCore::Svf;
            double   ladG   = 0.0, ladK = 0.0, ladIn = 1.0, ladHpG = 0.0;
            bool     diode  = false;
            double   combD  = 2.0, combG = 0.0, combDamp = 1.0;
            bool     combFb = false;
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

            L.core     = coreFor(type);
            L.onePole  = usesOnePole(type, slope);
            L.highPass = (type == SlotType::HP12);
            L.parallel = (L.core == SlotCore::Formant);
            L.stages   = L.onePole ? 1 : stageCountFor(type, slope);

            const double fc      = resolveTypeCutoff(type, cut, sr);
            const bool   selfOsc = (q >= kSelfOscQ);

            if (L.core == SlotCore::Ladder)
            {
                // Digital ladder: L(z)^4 / (1 + k*L(z)^4), with the 303's
                // feedback high pass folded into the loop when it is present.
                LadderDesign d;
                designLadder(d, cut, q, sr, selfOsc);
                L.ladG   = std::tan(pi * clampCutoff(cut, sr) / sr);
                L.ladK   = d.k;
                L.ladIn  = d.inGain;
                L.diode  = (type == SlotType::Acid303);
                L.ladHpG = std::tan(pi * kDiodeFbHpHz / sr);
            }
            else if (L.core == SlotCore::Comb)
            {
                CombDesign d;
                designComb(d, type, cut, q, morph, sr,
                           std::max(4, static_cast<int>(kCombMaxMs * 0.001 * sr)));
                L.combD    = d.delay;
                L.combG    = d.g;
                L.combDamp = d.damp;
                L.combFb   = (type == SlotType::CombFB);
            }
            else if (L.core == SlotCore::Formant)
            {
                FormantPlan fp;
                planFormant(fp,
                            static_cast<int>(std::lround(readParam(i, "vowel_a"))),
                            static_cast<int>(std::lround(readParam(i, "vowel_b"))),
                            morph, readParam(i, "head"), cut, q, sr);
                for (int st = 0; st < L.stages; ++st)
                {
                    StageDesign d;
                    designStage(d, type, fp.f[st], fp.q[st], 0.0, 0.0, sr, false,
                                st, fp.amp[st]);
                    L.g[st]  = d.g;   L.k[st]  = d.k;
                    L.m0[st] = d.m0;  L.m1[st] = d.m1;  L.m2[st] = d.m2;
                }
            }
            else if (L.onePole)
            {
                L.g[0] = std::tan(pi * fc / sr);
            }
            else
            {
                // Sallen-Key, Steiner and tilt all resolve to ordinary SVF mix
                // sets here — their transfers are algebraically identical to one
                // (see designStage); only their nonlinearities differ, and drive
                // is a nonlinearity, which a magnitude curve cannot show anyway.
                for (int st = 0; st < L.stages; ++st)
                {
                    StageDesign d;
                    designStage(d, type, fc, stageQ(q, L.stages, st), gain, morph,
                                sr, selfOsc, st);
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

                if (L.core == SlotCore::Ladder)
                {
                    // Four TPT one-poles with global feedback k.  The 303 puts a
                    // one-pole high pass in that feedback path, which is exactly
                    // why its low end survives high resonance.
                    const std::complex<double> lp = (L.ladG * B) / (A + L.ladG * B);
                    const std::complex<double> l4 = lp * lp * lp * lp;
                    std::complex<double> loop = L.ladK * l4;
                    if (L.diode)
                        loop *= A / (A + L.ladHpG * B);
                    Hs = (L.ladIn * l4) / (1.0 + loop);
                }
                else if (L.core == SlotCore::Comb)
                {
                    // z^-D at this frequency; D is fractional, which the closed
                    // form handles exactly (the allpass interpolator approximates
                    // precisely this).
                    const double wd = w * L.combD;
                    const std::complex<double> zD(std::cos(-wd), std::sin(-wd));
                    if (L.combFb)
                    {
                        const std::complex<double> damp =
                            L.combDamp / (1.0 - (1.0 - L.combDamp) * zInv);
                        Hs = 1.0 / (1.0 - L.combG * damp * zD);
                    }
                    else
                    {
                        Hs = 1.0 + L.combG * zD;
                    }
                }
                else if (L.onePole)
                {
                    // TPT one-pole: LP = gB / (A + gB), HP = A / (A + gB)
                    const std::complex<double> den = A + L.g[0] * B;
                    Hs = L.highPass ? (A / den) : ((L.g[0] * B) / den);
                }
                else if (L.parallel)
                {
                    // Formant bank: the three sections are in PARALLEL, so their
                    // responses SUM rather than multiply.
                    Hs = std::complex<double>(0.0, 0.0);
                    for (int st = 0; st < L.stages; ++st)
                    {
                        const double g = L.g[st], k = L.k[st];
                        const std::complex<double> AA  = A * A;
                        const std::complex<double> AB  = A * B;
                        const std::complex<double> BB  = B * B;
                        const std::complex<double> den = AA + (k * g) * AB + (g * g) * BB;
                        const std::complex<double> num =
                            L.m0[st] * den + (L.m1[st] * g) * AB + (L.m2[st] * g * g) * BB;
                        if (std::abs(den) > 1e-30) Hs += num / den;
                    }
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
        // 150 Hz one-pole high pass sitting in the 303's resonance feedback path
        // — the coupling capacitor.  Same first-order topology as the two above.
        const float fbR = static_cast<float>(
            std::clamp(1.0 - (2.0 * pi * kDiodeFbHpHz / sampleRate), 0.0, 0.999999));

        // Comb delay lines: the longest delay we ever need, rounded up to a power
        // of two so the read wrap is a bitmask.  Sized HERE and nowhere else.
        int combLen = 4;
        {
            const int need = static_cast<int>(
                std::ceil(kCombMaxMs * 0.001 * sampleRate)) + 8;
            while (combLen < need) combLen <<= 1;
        }

        for (int i = 0; i < kMaxSlots; ++i)
        {
            auto& sl = slots_[i];
            sl.dcR = dcR;
            sl.enabledPtr = apvts_.getRawParameterValue(paramId(i, "enabled"));
            sl.typePtr    = apvts_.getRawParameterValue(paramId(i, "type"));
            sl.slopePtr   = apvts_.getRawParameterValue(paramId(i, "slope"));
            sl.vowelAPtr  = apvts_.getRawParameterValue(paramId(i, "vowel_a"));
            sl.vowelBPtr  = apvts_.getRawParameterValue(paramId(i, "vowel_b"));

            sl.ladder.fbHpR = fbR;
            for (auto& b : sl.comb.buf) b.assign(static_cast<size_t>(combLen), 0.0f);
            sl.comb.mask = combLen - 1;

            // Handles resolved once here — never a string lookup on the audio path.
            sl.hCutoff = resolveSmoothed(paramId(i, "cutoff").toStdString());
            sl.hQ      = resolveSmoothed(paramId(i, "q").toStdString());
            sl.hGain   = resolveSmoothed(paramId(i, "gain").toStdString());
            sl.hMorph  = resolveSmoothed(paramId(i, "morph").toStdString());
            sl.hDrive  = resolveSmoothed(paramId(i, "drive").toStdString());
            sl.hMix    = resolveSmoothed(paramId(i, "mix").toStdString());
            sl.hHead   = resolveSmoothed(paramId(i, "head").toStdString());

            // Modulator lanes.  Every lane of every slot is wired up here, live
            // or not, so switching a lane on mid-stream never touches the APVTS
            // by name on the audio thread.
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            {
                auto& ln = sl.lanes[j];
                ln.kindPtr   = apvts_.getRawParameterValue(laneParamId(i, j, "kind"));
                ln.destPtr   = apvts_.getRawParameterValue(laneParamId(i, j, "dest"));
                ln.shapePtr  = apvts_.getRawParameterValue(laneParamId(i, j, "shape"));
                ln.modePtr   = apvts_.getRawParameterValue(laneParamId(i, j, "rate_mode"));
                ln.rateMsPtr = apvts_.getRawParameterValue(laneParamId(i, j, "rate_ms"));
                ln.syncPtr   = apvts_.getRawParameterValue(laneParamId(i, j, "sync"));
                ln.phasePtr  = apvts_.getRawParameterValue(laneParamId(i, j, "phase"));
                ln.atkPtr    = apvts_.getRawParameterValue(laneParamId(i, j, "attack"));
                ln.holdPtr   = apvts_.getRawParameterValue(laneParamId(i, j, "hold"));
                ln.decPtr    = apvts_.getRawParameterValue(laneParamId(i, j, "decay"));
                ln.susPtr    = apvts_.getRawParameterValue(laneParamId(i, j, "sustain"));
                ln.relPtr    = apvts_.getRawParameterValue(laneParamId(i, j, "release"));
                ln.dynAtkPtr = apvts_.getRawParameterValue(laneParamId(i, j, "dyn_attack"));
                ln.dynRelPtr = apvts_.getRawParameterValue(laneParamId(i, j, "dyn_release"));

                ln.hDepth  = resolveSmoothed(laneParamId(i, j, "depth").toStdString());
                ln.hCutMin = resolveSmoothed(laneParamId(i, j, "cut_min").toStdString());
                ln.hCutMax = resolveSmoothed(laneParamId(i, j, "cut_max").toStdString());

                // The follower and its accent lag are plain value members of the
                // lane array — allocated here with everything else, never on the
                // audio thread.
                ln.dyn.hpR         = hpR;
                ln.dyn.holdSamples = std::max(1, static_cast<int>(
                                         kDetectorHoldMs * 0.001 * sampleRate));
                ln.dyn.leakCoef    = xleth_apex::onePoleCoeff(
                                         static_cast<float>(kAccentLagMs), sampleRate);
                // Force a coefficient recompute on the first block.
                ln.dyn.lastAtkMs = ln.dyn.lastRelMs = -1.0f;
            }

            sl.clearState();
        }
    }

    void releaseEffect() override { resetEffect(); }

    void resetEffect() override
    {
        for (auto& sl : slots_)
            sl.clearState();
        // Drop any held modulation gate so a transport seek/stop cannot leave an
        // envelope frozen mid-sustain (MixEngine also resets chains on seek).
        modGateValid_ = false;
        modGateStart_ = 0;
        modGateEnd_   = 0;
    }

    // Per-track note/clip gate for the per-slot Envelope, pushed by MixEngine's
    // per-track loop immediately before this effect's processBlock (same audio
    // thread, same block — plain members, no atomics needed). Shared by every
    // slot on this instance; each enabled Envelope evaluates its own ADSR against
    // it. Invalid ⇒ the envelope is at rest (env 0 ⇒ exactly the base value).
    void applyModulationGate(bool valid, int64_t gateStartSample,
                             int64_t gateEndSample) override
    {
        modGateValid_ = valid;
        modGateStart_ = gateStartSample;
        modGateEnd_   = gateEndSample;
    }

    // Main thread: true iff any slot currently has its Envelope modulator
    // enabled. MixEngine uses this to decide which tracks need a gate timeline
    // built (so it never derives gates for a track no filter envelope reads).
    bool hasActiveEnvelopeModulator() const
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        for (int i = 0; i < count; ++i)
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
                if (laneKind(i, j) == xleth_filter::ModKind::Env) return true;
        return false;
    }

    // Main thread: true iff any slot with an enabled Envelope also opts its gate
    // in to slide notes. The gate is per-track (shared by all slots), so this is
    // the union used to build that track's gate timeline.
    bool envelopeWantsSlideNotes() const
    {
        const int count = slotCount_.load(std::memory_order_relaxed);
        for (int i = 0; i < count; ++i)
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
                if (laneKind(i, j) == xleth_filter::ModKind::Env
                    && readLaneParam(i, j, "slides") > 0.5f)
                    return true;
        return false;
    }

    // Main-thread read of a lane's kind.
    xleth_filter::ModKind laneKind(int slotIndex, int lane) const
    {
        return static_cast<xleth_filter::ModKind>(std::clamp(
            static_cast<int>(std::lround(readLaneParam(slotIndex, lane, "kind"))),
            0, xleth_filter::kNumModKinds - 1));
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

        // Absolute transport position at this buffer's start (for the free-running
        // LFO) and the per-track gate for the Envelope (both shared by all slots).
        const int64_t globalPos = XlethEffectBase::getGlobalTransportPositionSamples();
        xleth::envmod::ResolvedGate modGate;
        modGate.valid           = modGateValid_;
        modGate.gateStartSample = modGateStart_;
        modGate.gateEndSample   = modGateEnd_;

        for (int pos = 0; pos < numSamples; pos += kControlBlock)
        {
            const int n = std::min(kControlBlock, numSamples - pos);

            // ── Control-block coefficient update (double math, block rate) ──
            for (int s = 0; s < proc; ++s)
                updateSlotBlock(slots_[s], n, sr, s < count, globalPos + pos, modGate);

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

                    // Detectors see this slot's INPUT, before the slot filters
                    // it — self-input only (a sidechain source needs
                    // withSidechainInput on the base ctor and is a deliberate
                    // later increment).  One pass per LIVE follower lane; the
                    // whole loop is skipped when the slot has none.
                    if (sl.anyDynActive)
                        for (auto& ln : sl.lanes)
                            if (ln.dynActive)
                                updateDetector(ln, l, r, chR != nullptr);

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
        // Sallen-Key section (filled only for SK12 / SK24; see designStage).
        double skG = 0.0, skA = 0.0, skD = 1.0;
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

    // LFO cycle rate: free mode is a period in ms; sync mode is a note-division
    // denominator with the SAME formula as the FX-graph LFO (division/4 — see
    // LfoParameterModulation.h; the Sampler's 4/division is confirmed backwards).
    static double lfoCycleHz(int mode, double rateMs, double sync, double bpm)
    {
        if (mode == 0)  // free
            return 1000.0 / std::max(rateMs, 1.0e-3);
        const double div = std::max(sync, 1.0 / 128.0);
        return (bpm > 0.0 ? bpm : 140.0) / 60.0 * (div / 4.0);
    }

    // Fold a modulator's endpoint contributions (c0/c1 in signal*depth*gate
    // units, nominally [-1,1]) into the chosen destination's block endpoints,
    // each in its own domain. cutoff/Q are log-domain (octaves / log-Q, matching
    // the follower); gain/drive are additive dB; morph/mix are additive 0..1.
    static void applyModToDest(xleth_filter::ModDest dest, double c0, double c1, double sr,
                               double& cutA, double& cutB, double& qA, double& qB,
                               double& gn0, double& gn1, double& mp0, double& mp1,
                               double& dr0, double& dr1, double& mx0, double& mx1)
    {
        using xleth_filter::ModDest;
        switch (dest)
        {
            case ModDest::Cutoff:
            {
                const double lo = kMinCutoffHz, hi = sr * kNyquistFactor;
                cutA = std::clamp(cutA * std::exp2(c0 * xleth_filter::kModCutoffOctaves), lo, hi);
                cutB = std::clamp(cutB * std::exp2(c1 * xleth_filter::kModCutoffOctaves), lo, hi);
                break;
            }
            case ModDest::Q:
                qA = applyQOffset(qA, c0);
                qB = applyQOffset(qB, c1);
                break;
            case ModDest::Gain:
                gn0 = std::clamp(gn0 + c0 * xleth_filter::kModGainDb, -24.0, 24.0);
                gn1 = std::clamp(gn1 + c1 * xleth_filter::kModGainDb, -24.0, 24.0);
                break;
            case ModDest::Morph:
                mp0 = std::clamp(mp0 + c0, 0.0, 1.0);
                mp1 = std::clamp(mp1 + c1, 0.0, 1.0);
                break;
            case ModDest::Drive:
                dr0 = std::clamp(dr0 + c0 * xleth_filter::kModDriveDb, 0.0, 24.0);
                dr1 = std::clamp(dr1 + c1 * xleth_filter::kModDriveDb, 0.0, 24.0);
                break;
            case ModDest::Mix:
                mx0 = std::clamp(mx0 + c0, 0.0, 1.0);
                mx1 = std::clamp(mx1 + c1, 0.0, 1.0);
                break;
        }
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

    // Which DSP structure a type runs on.  Everything not listed is the SVF.
    static SlotCore coreFor(SlotType type)
    {
        switch (type)
        {
            case SlotType::Moog24:
            case SlotType::Acid303:   return SlotCore::Ladder;
            case SlotType::SK12:
            case SlotType::SK24:      return SlotCore::SallenKey;
            case SlotType::SteinerLP:
            case SlotType::SteinerBP:
            case SlotType::SteinerHP: return SlotCore::Steiner;
            case SlotType::CombFF:
            case SlotType::CombFB:    return SlotCore::Comb;
            case SlotType::Formant:   return SlotCore::Formant;
            default:                  return SlotCore::Svf;
        }
    }

    // Types whose `drive` param drives an IN-LOOP nonlinearity instead of the
    // shared pre-filter saturator.  Running both would saturate twice, and the
    // in-loop one is the whole character of these topologies (the Sallen-Key's
    // feedback diode limiter, the Steiner's HP-node grit).
    static bool usesInLoopDrive(SlotType type)
    {
        const SlotCore c = coreFor(type);
        return c == SlotCore::SallenKey || c == SlotCore::Steiner;
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
        // The character types have a topology-fixed section count that the
        // slope param does not get a vote on.
        switch (type)
        {
            case SlotType::SK24:    return 2;   // two Sallen-Key sections
            case SlotType::Tilt:    return 2;   // low shelf + high shelf
            case SlotType::Formant: return xleth_filter::kNumFormants;  // parallel
            default: break;
        }
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
    //
    // `stageIndex` only matters for the types whose sections are NOT identical:
    // tilt (section 0 is the low shelf, section 1 the high shelf).  `bandAmp`
    // only matters for the formant bank, where the caller has already resolved
    // this band's centre frequency into `fc` and its bandwidth into `q`.
    static void designStage(StageDesign& d, SlotType type, double fc, double q,
                            double gainDb, double morph, double sr, bool selfOsc,
                            int stageIndex = 0, double bandAmp = 1.0)
    {
        const double pi = juce::MathConstants<double>::pi;

        fc = clampCutoff(fc, sr);
        q  = std::clamp(q, kMinQ, kMaxQ);

        double g = std::tan(pi * fc / sr);
        double k = selfOsc ? kSelfOscDamping : (1.0 / q);
        double m0 = 0.0, m1 = 0.0, m2 = 1.0;

        switch (type)
        {
            // ── Sallen-Key ────────────────────────────────────────────────────
            // The SK's LINEAR transfer is 1/(sigma^2 + (3-K)*sigma + 1), i.e.
            // byte-for-byte a 2-pole lowpass with k = 3 - K = 1/Q.  So the SVF
            // mix set below is exactly right for the response curve, and the
            // audio path picks up the three SK-specific coefficients instead
            // (see processSkSample for the derivation from the analog circuit).
            case SlotType::SK12:
            case SlotType::SK24:
            {
                const double K  = std::min(3.0 - k, kSkMaxK);   // resonance gain
                const double G  = g / (1.0 + g);                // TPT one-pole gain
                const double a  = K - 1.0;
                // 1 - a*G*(1-G) >= 1 - 2*0.25 = 0.5 for every K <= 3, so this
                // denominator can never reach zero: the section is unconditionally
                // solvable at any cutoff and any resonance inside the clamp.
                d.skG = G;
                d.skA = a;
                d.skD = 1.0 / (1.0 - a * G * (1.0 - G));
                m0 = 0.0; m1 = 0.0; m2 = 1.0;   // lowpass, for the response curve
                break;
            }

            // ── Steiner-Parker injection modes ────────────────────────────────
            // The audio path injects the input at a different node of this very
            // core (processSteinerSample); these mix sets are the algebraically
            // equivalent LINEAR transfers, used by the response curve:
            //   HP-node injection  -> lp out = w^2/den            = (0, 0, 1)
            //   BP-node injection  -> lp out = s*w/den            = (0, 1, 0)
            //   LP-node injection  -> lp out = s(s+k*w)/den = v0-v2 = (1, 0, -1)
            case SlotType::SteinerLP: m0 = 0.0; m1 = 0.0; m2 =  1.0; break;
            case SlotType::SteinerBP: m0 = 0.0; m1 = 1.0; m2 =  0.0; break;
            case SlotType::SteinerHP: m0 = 1.0; m1 = 0.0; m2 = -1.0; break;

            // ── Formant band ─────────────────────────────────────────────────
            // Constant-peak-gain bandpass (m1 = k gives unity peak), scaled by
            // this band's relative amplitude.  fc / q were resolved by the caller
            // from the Peterson & Barney table.
            case SlotType::Formant:
                m0 = 0.0; m1 = k * bandAmp; m2 = 0.0;
                break;

            // ── Tilt ─────────────────────────────────────────────────────────
            // Two shelves at ONE pivot: low shelf at -G, high shelf at +G.  Each
            // shelf is +/-G/2 dB at its own corner, so they cancel exactly at the
            // pivot and the tilt is a pure rotation about it.  No new filter math.
            case SlotType::Tilt:
            {
                const double tilt = std::clamp(gainDb, -kTiltMaxDb, kTiltMaxDb);
                const double A    = std::pow(10.0, (stageIndex == 0 ? -tilt : tilt) / 40.0);
                if (stageIndex == 0)   // low shelf, -tilt
                {
                    g  = g / std::sqrt(A);
                    m0 = 1.0; m1 = k * (A - 1.0); m2 = A * A - 1.0;
                }
                else                   // high shelf, +tilt
                {
                    g  = g * std::sqrt(A);
                    m0 = A * A; m1 = k * (1.0 - A) * A; m2 = 1.0 - A * A;
                }
                break;
            }

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

            // Ladder and comb slots never reach designStage — their coefficients
            // are built by updateLadderBlock / updateCombBlock.  Listed so the
            // switch stays exhaustive under -Wswitch.
            case SlotType::Moog24:
            case SlotType::Acid303:
            case SlotType::CombFF:
            case SlotType::CombFB:
                break;
        }

        d.g  = g;
        d.k  = k;
        d.a1 = 1.0 / (1.0 + g * (g + k));
        d.a2 = g * d.a1;
        d.a3 = g * d.a2;
        d.m0 = m0; d.m1 = m1; d.m2 = m2;
    }

    // A few types read the slot cutoff as something other than a corner
    // frequency and have their own sensible window for it.  Applied AFTER every
    // modulation source has been summed, exactly like the shared clamp.
    static double resolveTypeCutoff(SlotType type, double fc, double sr)
    {
        if (type == SlotType::Tilt)
            return std::clamp(fc, kTiltPivotMinHz,
                              std::min(kTiltPivotMaxHz, sr * kNyquistFactor));
        return clampCutoff(fc, sr);
    }

    // Normalised position of Q inside the guard-rail window, in LOG space —
    // the same 0..1 the Q modulation route uses, so "resonance" means the same
    // perceptual thing whichever core a slot is running.
    static double qNorm(double q)
    {
        return std::log(std::clamp(q, kMinQ, kMaxQ) / kMinQ) / std::log(kMaxQ / kMinQ);
    }

    // ── 4-pole ladder design (moog24 / acid303) ─────────────────────────────
    struct LadderDesign { double G = 0.0, k = 0.0, invDen = 1.0, inGain = 1.0; };

    static void designLadder(LadderDesign& d, double fc, double q, double sr,
                             bool selfOsc)
    {
        const double pi = juce::MathConstants<double>::pi;
        const double g  = std::tan(pi * clampCutoff(fc, sr) / sr);
        const double G  = g / (1.0 + g);            // TPT one-pole gain
        const double G4 = G * G * G * G;

        // k = 4 is the classic ladder self-oscillation point.  Mapping Q through
        // the shared log window puts k = 4 exactly at Q = kMaxQ, which is where
        // every other slot type engages self-osc too.  Hard-clamped regardless.
        const double k = std::clamp(selfOsc ? kLadderMaxK : kLadderMaxK * qNorm(q),
                                    0.0, kLadderMaxK);

        d.G      = G;
        d.k      = k;
        d.invDen = 1.0 / (1.0 + k * G4);
        // A ladder loses its bottom end as feedback comes up (the feedback is
        // subtracted from the input, and at DC the ladder passes everything).
        // Scaling the input by (1 + k/2) puts it back.
        d.inGain = 1.0 + 0.5 * k;
    }

    // ── Comb design (combFF / combFB) ───────────────────────────────────────
    struct CombDesign { double delay = 2.0, g = 0.0, damp = 1.0; };

    static void designComb(CombDesign& d, SlotType type, double fc, double q,
                           double damp01, double sr, int maxDelay)
    {
        // Comb frequency IS the cutoff: the first notch/peak sits at fs/M.  A
        // cutoff below fs/maxDelay (about 20 Hz at 44.1 kHz for a 50 ms line)
        // simply parks on the longest delay the preallocated line can hold.
        const double M = std::clamp(sr / std::max(clampCutoff(fc, sr), 1.0e-6),
                                    kCombMinDelay, static_cast<double>(maxDelay));
        const double t = qNorm(q);

        double g;
        if (type == SlotType::CombFB)
        {
            // Resonator: Q sets the T60 (log-spaced), and the per-round-trip
            // gain follows from it — g^(T60*fs/M) = 10^-3 by construction.
            const double t60 = kCombMinT60 * std::pow(kCombMaxT60 / kCombMinT60, t);
            g = std::pow(10.0, -3.0 * M / (t60 * sr));
        }
        else
        {
            g = t;   // feedforward: Q is just the depth of the comb
        }

        d.delay = M;
        d.g     = std::clamp(g, -kCombMaxG, kCombMaxG);
        // Damping reuses `morph`: 0 = no lowpass in the loop, 1 = very dark.
        // 1.0 is the one-pole coefficient for "pass through unchanged".
        d.damp  = std::clamp(1.0 - 0.995 * std::clamp(damp01, 0.0, 1.0), 0.005, 1.0);
    }

    // ── Formant bank plan (one endpoint of one control block) ───────────────
    struct FormantPlan
    {
        double f[xleth_filter::kNumFormants]{};
        double q[xleth_filter::kNumFormants]{};
        double amp[xleth_filter::kNumFormants]{};
    };

    // Resolve the three band centre frequencies / bandwidths for one endpoint.
    //
    // The morph slides the FREQUENCIES in the log domain (a real vowel glide)
    // rather than crossfading two filter outputs, which would collapse to a
    // hollow double-vowel in the middle and click on the way through.
    static void planFormant(FormantPlan& p, int vowelA, int vowelB, double morph,
                            double headSemis, double cutoffHz, double q, double sr)
    {
        const auto& A = xleth_filter::vowelTable(vowelA);
        const auto& B = xleth_filter::vowelTable(vowelB);
        const double m = std::clamp(morph, 0.0, 1.0);

        // Global shift: head size in semitones, times the slot's own cutoff read
        // against its 1 kHz default.  Routing the cutoff in is what lets the
        // dynamics follower / LFO / Envelope sweep a vowel bank exactly the way
        // they sweep every other slot type.
        constexpr double kFormantRefHz = 1000.0;
        const double shift = std::clamp(
            std::exp2(std::clamp(headSemis, -kFormantHeadMax, kFormantHeadMax) / 12.0)
                * (clampCutoff(cutoffHz, sr) / kFormantRefHz),
            0.125, 8.0);

        // Higher Q = narrower formants.  kNeutralQ leaves the published
        // bandwidths exactly as measured.
        const double bwScale = kNeutralQ / std::clamp(q, kMinQ, kMaxQ);

        for (int b = 0; b < xleth_filter::kNumFormants; ++b)
        {
            const double f = std::exp(std::log(A.f[b]) * (1.0 - m) + std::log(B.f[b]) * m)
                             * shift;
            const double bw = std::max((A.bw[b] * (1.0 - m) + B.bw[b] * m) * bwScale, 1.0);
            p.f[b]   = clampCutoff(f, sr);
            p.q[b]   = std::clamp(p.f[b] / bw, kMinQ, kMaxQ);
            p.amp[b] = A.amp[b] * (1.0 - m) + B.amp[b] * m;
        }
    }

    // ── Per-slot runtime state ──────────────────────────────────────────────
    struct StageRT
    {
        // Lerped coefficients + per-sample increments.
        float a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
        float m0 = 0.0f, m1 = 0.0f, m2 = 1.0f;
        float da1 = 0.0f, da2 = 0.0f, da3 = 0.0f;
        float dm0 = 0.0f, dm1 = 0.0f, dm2 = 0.0f;

        // Damping k, lerped.  The SVF folds k into a1/a2/a3 and the mix set, but
        // the Steiner injection path needs it explicitly to form the HP node.
        float kq = 1.0f, dkq = 0.0f;

        // Sallen-Key section: one-pole gain G, feedback amount a = K-1, and the
        // resolved-loop reciprocal 1/(1 - a*G*(1-G)).  Lerped like everything else.
        float skG = 0.0f, skA = 0.0f, skD = 1.0f;
        float dSkG = 0.0f, dSkA = 0.0f, dSkD = 0.0f;

        // Integrator state, per channel.  The Sallen-Key reuses these two as its
        // pair of TPT one-pole states, so it costs no extra memory.
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

    // ── 4-pole ladder runtime (moog24 + acid303) ────────────────────────────
    // POD, preallocated with the slot.  Both ladders share the skeleton; the
    // 303 additionally runs the feedback high pass and swaps tanh for the cubic
    // diode shaper.
    struct LadderRT
    {
        float s[4][2]{};                  // four TPT one-pole states, per channel
        float fbHpX1[2]{}, fbHpY1[2]{};   // 150 Hz feedback high pass (303 only)
        float fbHpR = 0.98f;              // its pole, set in prepareEffect

        // Lerped block coefficients.
        float G = 0.0f, dG = 0.0f;            // one-pole TPT gain g/(1+g)
        float k = 0.0f, dK = 0.0f;            // global feedback, <= kLadderMaxK
        float invDen = 1.0f, dInvDen = 0.0f;  // 1/(1 + k*G^4)
        float inGain = 1.0f, dInGain = 0.0f;  // (1 + 0.5k) bass-drop compensation

        void clear() noexcept
        {
            for (auto& row : s) { row[0] = row[1] = 0.0f; }
            fbHpX1[0] = fbHpX1[1] = 0.0f;
            fbHpY1[0] = fbHpY1[1] = 0.0f;
        }

        void advance() noexcept
        {
            G += dG; k += dK; invDen += dInvDen; inGain += dInGain;
        }
    };

    // ── Comb runtime ────────────────────────────────────────────────────────
    // The delay lines are the ONLY heap allocation in the whole effect and they
    // are sized exactly once, in prepareEffect.  Power-of-two length + bitmask
    // so the wrap is an AND, never a modulo or a branch.
    struct CombRT
    {
        std::vector<float> buf[2];
        int   mask = 0;
        int   w    = 0;
        float apZin[2]{}, apZout[2]{};   // first-order allpass interpolator state
        float dampZ[2]{};                // one-pole damping state, in the loop

        // Lerped block coefficients.  The DELAY is lerped as a float and split
        // into integer + fraction per sample: stepping the integer read index at
        // block rate instead would click on every modulated block boundary.
        float delay = 2.0f, dDelay = 0.0f;
        float g     = 0.0f, dG     = 0.0f;   // feedforward / feedback amount
        float damp  = 1.0f, dDamp  = 0.0f;   // 1 = no damping, ->0 = dark

        void clear() noexcept
        {
            for (auto& b : buf) std::fill(b.begin(), b.end(), 0.0f);
            w = 0;
            apZin[0] = apZin[1] = 0.0f;
            apZout[0] = apZout[1] = 0.0f;
            dampZ[0] = dampZ[1] = 0.0f;
        }

        // Called once per SAMPLE (not once per channel) from advanceCoeffs, after
        // both channels have written this sample into the line.
        void advance() noexcept
        {
            delay += dDelay; g += dG; damp += dDamp;
            w = (w + 1) & mask;
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
        // modOct / qOffset are the cutoff route's; contrib is the plain
        // envelope used when a follower targets anything other than cutoff.
        double modOctPrev  = 0.0;
        double qOffsetPrev = 0.0;
        double contribPrev = 0.0;

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
            contribPrev = 0.0;
        }
    };

    // ── One modulator lane ──────────────────────────────────────────────────
    // Holds the union of what an LFO, an Envelope or a dynamics follower needs.
    // A lane at kind = Off reads none of it, and once its activation gate has
    // faded to zero it contributes nothing at all — so a slot whose lanes are
    // all Off is bit-identical to a slot with no modulation compiled in.
    struct ModLane
    {
        // Raw params, resolved once in prepareEffect (never a string lookup on
        // the audio path).
        std::atomic<float>* kindPtr   = nullptr;
        std::atomic<float>* destPtr   = nullptr;
        // LFO
        std::atomic<float>* shapePtr  = nullptr;
        std::atomic<float>* modePtr   = nullptr;
        std::atomic<float>* rateMsPtr = nullptr;
        std::atomic<float>* syncPtr   = nullptr;
        std::atomic<float>* phasePtr  = nullptr;
        // Envelope
        std::atomic<float>* atkPtr    = nullptr;
        std::atomic<float>* holdPtr   = nullptr;
        std::atomic<float>* decPtr    = nullptr;
        std::atomic<float>* susPtr    = nullptr;
        std::atomic<float>* relPtr    = nullptr;
        // Dynamics follower ballistics
        std::atomic<float>* dynAtkPtr = nullptr;
        std::atomic<float>* dynRelPtr = nullptr;

        SmoothedHandle hDepth, hCutMin, hCutMax;

        // Activation level (0..1), carried across blocks so adding or removing a
        // modulator fades its whole contribution in/out click-free.
        float gate = 0.0f;

        // The last kind this lane actually ran.  Removing a modulator only writes
        // kind = Off — every other parameter of the lane survives — so the fade-out
        // keeps composing THIS kind until the gate reaches zero.  Without it a
        // removal would drop the contribution in one block and click.
        xleth_filter::ModKind lastKind = xleth_filter::ModKind::Off;

        // Follower state.  Present on every lane rather than only the Dyn ones so
        // the lane array stays a plain value array; it is only touched while
        // dynActive, and cleared the moment the lane stops being a live follower.
        DynState dyn;
        // True only while this lane is a Dyn lane with a non-zero depth at one or
        // both ends of the block.  Gates the whole follower path — detector,
        // ballistics, accent lag, octave composition and Q route.
        bool dynActive = false;

        // Per-lane telemetry (audio thread stores, any thread loads).
        std::atomic<float> envOut{0.0f};
        std::atomic<float> accentOut{0.0f};

        void clear() noexcept
        {
            gate      = 0.0f;
            dynActive = false;
            lastKind  = xleth_filter::ModKind::Off;
            dyn.clear();
            envOut.store(0.0f, std::memory_order_relaxed);
            accentOut.store(0.0f, std::memory_order_relaxed);
        }

        void skipSmoothers(int n)
        {
            hDepth.skip(n); hCutMin.skip(n); hCutMax.skip(n);
        }
    };

    struct SlotState
    {
        std::atomic<float>* enabledPtr = nullptr;
        std::atomic<float>* typePtr    = nullptr;
        std::atomic<float>* slopePtr   = nullptr;
        std::atomic<float>* vowelAPtr  = nullptr;
        std::atomic<float>* vowelBPtr  = nullptr;

        SmoothedHandle hCutoff, hQ, hGain, hMorph, hDrive, hMix;
        SmoothedHandle hHead;

        // The slot's modulators.  Any mix of kinds, any mix of destinations;
        // several lanes aimed at one destination compose in that destination's
        // own domain (see applyModToDest).
        ModLane lanes[xleth_filter::kMaxModsPerSlot];
        // True if ANY lane is a live follower this block — the per-sample
        // detector loop is skipped entirely when it is false.
        bool anyDynActive = false;

        // Telemetry (audio thread stores, any thread loads).
        std::atomic<float> effCutoffHz{0.0f};
        std::atomic<float> effQ{0.0f};

        StageRT  stages[kMaxStages];
        LadderRT ladder;   // moog24 / acid303
        CombRT   comb;     // combFF / combFB

        int      stageCount = 1;
        bool     enabled    = false;
        bool     onePole    = false;
        bool     highPass   = false;   // one-pole variant selector
        bool     selfOsc    = false;
        bool     driveOn    = false;

        // Which structure this slot is running this block, and — for the types
        // that have more than one flavour of the same structure — which one.
        SlotCore core       = SlotCore::Svf;
        bool     diodeMode  = false;   // ladder: acid303 rather than moog24
        int      inject     = 0;       // steiner: 0 = HP node, 1 = BP, 2 = LP
        bool     combFb     = false;   // comb: resonator rather than feedforward
        // Drive routed to the core's in-loop nonlinearity instead of the shared
        // pre-filter saturator (Sallen-Key diode limiter / Steiner HP grit).
        bool     inLoopDrive = false;
        // Internal quality flag: false drops the nonlinear cores to their pure
        // linear closed form.  Defaults to nonlinear; see setSlotNonlinear.
        bool     nonlinear   = true;

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
            // Ladder and comb state must go too, or a bypassed comb re-arms with
            // 50 ms of stale energy still circulating in its delay line.
            ladder.clear();
            comb.clear();
            dcX1[0] = dcX1[1] = 0.0f;
            dcY1[0] = dcY1[1] = 0.0f;
            gate = 0.0f;
            dGate = 0.0f;
            for (auto& ln : lanes) ln.clear();
            anyDynActive = false;
        }

        void skipSmoothers(int n)
        {
            hCutoff.skip(n); hQ.skip(n); hGain.skip(n);
            hMorph.skip(n);  hDrive.skip(n); hMix.skip(n);
            hHead.skip(n);
            // Every lane's smoothers advance every block regardless of kind, or a
            // lane switched on mid-stream would jump from a stale start value.
            for (auto& ln : lanes) ln.skipSmoothers(n);
        }

        void advanceCoeffs()
        {
            for (int st = 0; st < stageCount; ++st)
            {
                auto& S = stages[st];
                S.a1 += S.da1; S.a2 += S.da2; S.a3 += S.da3;
                S.m0 += S.dm0; S.m1 += S.dm1; S.m2 += S.dm2;
                S.kq += S.dkq;
                S.skG += S.dSkG; S.skA += S.dSkA; S.skD += S.dSkD;
            }
            if (core == SlotCore::Ladder) ladder.advance();
            if (core == SlotCore::Comb)   comb.advance();
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
    // `blockStartSample` is the absolute transport position of this control
    // block's first sample (for the free-running LFO); `gate` is the per-track
    // note/clip gate governing this buffer (for the Envelope).
    void updateSlotBlock(SlotState& sl, int n, double sr, bool withinCount,
                         int64_t blockStartSample, const xleth::envmod::ResolvedGate& gate)
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
        // gn/mp/dr/mx are NON-const: a modulator targeting one of them folds its
        // contribution into these endpoints below, before the coefficient math.
        const double cut0 = sl.hCutoff.current(), cut1 = sl.hCutoff.peekAfter(n);
        const double q0   = sl.hQ.current(),      q1   = sl.hQ.peekAfter(n);
        double       gn0  = sl.hGain.current(),   gn1  = sl.hGain.peekAfter(n);
        double       mp0  = sl.hMorph.current(),  mp1  = sl.hMorph.peekAfter(n);
        double       dr0  = sl.hDrive.current(),  dr1  = sl.hDrive.peekAfter(n);
        double       mx0  = sl.hMix.current(),    mx1  = sl.hMix.peekAfter(n);
        const double hd0    = sl.hHead.current(),     hd1    = sl.hHead.peekAfter(n);
        // Lane depths / sweep ranges, read BEFORE skipSmoothers advances them —
        // same discipline as everything above.
        double laneDp0[xleth_filter::kMaxModsPerSlot]{}, laneDp1[xleth_filter::kMaxModsPerSlot]{};
        double laneCmn[xleth_filter::kMaxModsPerSlot]{}, laneCmx[xleth_filter::kMaxModsPerSlot]{};
        for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
        {
            laneDp0[j] = sl.lanes[j].hDepth.current();
            laneDp1[j] = sl.lanes[j].hDepth.peekAfter(n);
            laneCmn[j] = sl.lanes[j].hCutMin.peekAfter(n);
            laneCmx[j] = sl.lanes[j].hCutMax.peekAfter(n);
        }
        sl.skipSmoothers(n);

        // ── Which structure this slot runs, and which flavour of it ──────────
        // Set BEFORE the coefficient math so advanceCoeffs() and the per-sample
        // dispatch agree with what was just designed.
        const SlotCore prevCore = sl.core;
        sl.core        = coreFor(type);
        sl.diodeMode   = (type == SlotType::Acid303);
        sl.inject      = (type == SlotType::SteinerBP) ? 1
                       : (type == SlotType::SteinerHP) ? 2 : 0;
        sl.combFb      = (type == SlotType::CombFB);
        sl.inLoopDrive = usesInLoopDrive(type);
        if (sl.core != prevCore)
        {
            // Switching topology mid-stream: whatever the old core left in its
            // state is meaningless to the new one (and, for the comb, is 50 ms
            // of audio that would leak straight back out).
            for (auto& st : sl.stages) st.clear();
            sl.ladder.clear();
            sl.comb.clear();
        }

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

        // ── Modulator lane composition (block rate) ──────────────────────────
        // The endpoints the coefficient math below actually uses.  Every lane
        // folds its own (c0, c1) contribution into them in the DESTINATION's own
        // domain, so several lanes aimed at one knob compose without knowing
        // about each other.  A lane at kind = Off whose activation gate has
        // finished fading touches nothing, so these stay EXACTLY the smoothed
        // parameter values and a slot with no modulators is bit-identical to one
        // with no modulation compiled in at all.
        double cutA = cut0, cutB = cut1;
        double qA   = q0,   qB   = q1;

        const float actStep = static_cast<float>(
            1.0 / std::max(1.0, xleth_filter::kModActivationMs * 0.001 * sr));
        const double bpm = getGlobalBPM();

        sl.anyDynActive = false;

        for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
        {
            auto& ln = sl.lanes[j];

            const auto rawKind = static_cast<xleth_filter::ModKind>(std::clamp(
                ln.kindPtr ? static_cast<int>(std::lround(
                    ln.kindPtr->load(std::memory_order_relaxed))) : 0,
                0, xleth_filter::kNumModKinds - 1));
            const bool present = (rawKind != xleth_filter::ModKind::Off);
            if (present) ln.lastKind = rawKind;
            // While a just-removed lane fades out, keep composing the kind it was
            // running — every parameter but `kind` is still there.
            const auto kind = present ? rawKind : ln.lastKind;

            // A follower is additionally DEPTH-gated: at depth exactly 0 at both
            // ends of the block its detector, ballistics, accent lag and octave
            // composition are all skipped, exactly as the old fixed follower was.
            const double d0 = std::clamp(laneDp0[j], -1.0, 1.0);
            const double d1 = std::clamp(laneDp1[j], -1.0, 1.0);
            const bool   dynInert = (kind == xleth_filter::ModKind::Dyn)
                                 && d0 == 0.0 && d1 == 0.0;
            const bool   live     = present && !dynInert;

            // Activation ramp: adding or removing a modulator fades its whole
            // contribution in/out over kModActivationMs instead of stepping.
            const float target = live ? 1.0f : 0.0f;
            const float g0 = ln.gate;
            const float g1 = (target > g0)
                ? std::min(target, g0 + actStep * n)
                : std::max(target, g0 - actStep * n);
            ln.gate = g1;

            ln.dynActive = false;

            // Nothing left to compose: either fully faded out, or a follower sat
            // at depth 0. Either way the lane keeps NO memory across the dead
            // stretch, so dialling it back in always starts from silence rather
            // than from a stale envelope.
            if (dynInert || (!live && g1 <= 0.0f))
            {
                if (ln.lastKind != xleth_filter::ModKind::Off || ln.gate != 0.0f)
                {
                    const auto keep = ln.lastKind;
                    ln.clear();
                    // A depth-0 follower is still PRESENT — it just is not doing
                    // anything — so it must not forget what kind it is.
                    if (dynInert && present) ln.lastKind = keep;
                }
                continue;
            }

            const auto dest = static_cast<xleth_filter::ModDest>(std::clamp(
                ln.destPtr ? static_cast<int>(std::lround(
                    ln.destPtr->load(std::memory_order_relaxed))) : 0,
                0, xleth_filter::kNumModDests - 1));

            switch (kind)
            {
                // ── LFO — free-running from the absolute transport position ───
                case xleth_filter::ModKind::Lfo:
                {
                    const auto wave = static_cast<xleth_filter::LfoWave>(std::clamp(
                        ln.shapePtr ? static_cast<int>(std::lround(
                            ln.shapePtr->load(std::memory_order_relaxed))) : 0,
                        0, xleth_filter::kNumLfoWaves - 1));
                    const int mode = ln.modePtr
                        ? static_cast<int>(std::lround(ln.modePtr->load(std::memory_order_relaxed))) : 1;
                    const double rateMs = ln.rateMsPtr
                        ? ln.rateMsPtr->load(std::memory_order_relaxed) : 500.0;
                    const double sync = ln.syncPtr
                        ? ln.syncPtr->load(std::memory_order_relaxed) : 4.0;
                    const double phaseOff = ln.phasePtr
                        ? std::clamp(static_cast<double>(
                              ln.phasePtr->load(std::memory_order_relaxed)), 0.0, 1.0) : 0.0;
                    const double hz = lfoCycleHz(mode, rateMs, sync, bpm);

                    const double cp0 = static_cast<double>(blockStartSample)     / sr * hz + phaseOff;
                    const double cp1 = static_cast<double>(blockStartSample + n) / sr * hz + phaseOff;

                    const double c0 = d0 * g0 * xleth_filter::evalLfoShape(wave, cp0);
                    const double c1 = d1 * g1 * xleth_filter::evalLfoShape(wave, cp1);
                    applyModToDest(dest, c0, c1, sr, cutA, cutB, qA, qB,
                                   gn0, gn1, mp0, mp1, dr0, dr1, mx0, mx1);
                    break;
                }

                // ── Envelope — note/clip triggered via the pushed gate ────────
                // Reuses the exact FX-graph ADSR, so an in-panel envelope and a
                // graph envelope with the same shape produce the same curve.
                case xleth_filter::ModKind::Env:
                {
                    xleth::envmod::EnvelopeShape esh;
                    esh.attackMs  = ln.atkPtr  ? ln.atkPtr->load(std::memory_order_relaxed)  : 5.0;
                    esh.holdMs    = ln.holdPtr ? ln.holdPtr->load(std::memory_order_relaxed) : 0.0;
                    esh.decayMs   = ln.decPtr  ? ln.decPtr->load(std::memory_order_relaxed)  : 120.0;
                    esh.sustain   = ln.susPtr  ? ln.susPtr->load(std::memory_order_relaxed)  : 0.7;
                    esh.releaseMs = ln.relPtr  ? ln.relPtr->load(std::memory_order_relaxed)  : 200.0;
                    const auto eshS = xleth::envmod::envelopeShapeToSamples(esh, sr);

                    const double e0 = gate.valid
                        ? xleth::envmod::evaluateEnvelopeAdsr(eshS, gate, blockStartSample)     : 0.0;
                    const double e1 = gate.valid
                        ? xleth::envmod::evaluateEnvelopeAdsr(eshS, gate, blockStartSample + n) : 0.0;

                    ln.envOut.store(static_cast<float>(e1), std::memory_order_relaxed);

                    applyModToDest(dest, d0 * g0 * e0, d1 * g1 * e1, sr,
                                   cutA, cutB, qA, qB,
                                   gn0, gn1, mp0, mp1, dr0, dr1, mx0, mx1);
                    break;
                }

                // ── Dynamics follower — the auto-wah / 303 path ───────────────
                case xleth_filter::ModKind::Dyn:
                {
                    auto& D = ln.dyn;
                    ln.dynActive    = true;
                    sl.anyDynActive = true;

                    // Ballistics: onePoleCoeff calls std::exp, so it runs only
                    // when the ms value actually moved — never per sample.
                    const float atkMs = ln.dynAtkPtr
                        ? ln.dynAtkPtr->load(std::memory_order_relaxed) : 10.0f;
                    const float relMs = ln.dynRelPtr
                        ? ln.dynRelPtr->load(std::memory_order_relaxed) : 100.0f;
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

                    const double e      = std::clamp(static_cast<double>(D.env),    0.0, 1.0);
                    const double accent = std::clamp(static_cast<double>(D.accent), 0.0, 1.0);
                    ln.envOut.store(static_cast<float>(e), std::memory_order_relaxed);
                    ln.accentOut.store(static_cast<float>(accent), std::memory_order_relaxed);

                    if (dest == xleth_filter::ModDest::Cutoff)
                    {
                        // The follower's signature route: sweep between this
                        // lane's OWN cut_min / cut_max, which act as both the
                        // span and the hard rails, with the 303's accent lag and
                        // its shallow companion route onto resonance.
                        double lo = kMinCutoffHz, hi = sr * kNyquistFactor;
                        resolveDynRange(laneCmn[j], laneCmx[j], sr, lo, hi);
                        const double rangeOct = std::log2(hi / lo);

                        // Octave-space offset, accent lag folded in BEFORE any
                        // clamping.
                        const double modOct = d1 * rangeOct * (e + kAccentOctScale * accent);
                        const double qOff   = d1 * e * kQRouteRatio;

                        // Ramp from the PREVIOUS block's composed value to this
                        // one so the modulation is continuous across blocks.
                        cutA = std::clamp(cutA * std::exp2(D.modOctPrev * g0), lo, hi);
                        cutB = std::clamp(cutB * std::exp2(modOct       * g1), lo, hi);
                        qA   = applyQOffset(qA, D.qOffsetPrev * g0);
                        qB   = applyQOffset(qB, qOff          * g1);

                        D.modOctPrev  = modOct;
                        D.qOffsetPrev = qOff;
                    }
                    else
                    {
                        // Any other destination gets the plain envelope through
                        // the shared fold — no range window, no Q companion.
                        // Same previous-block ramp so it stays continuous.
                        const double contrib = d1 * e;
                        applyModToDest(dest, D.contribPrev * g0, contrib * g1, sr,
                                       cutA, cutB, qA, qB,
                                       gn0, gn1, mp0, mp1, dr0, dr1, mx0, mx1);
                        D.contribPrev = contrib;
                    }
                    break;
                }

                case xleth_filter::ModKind::Off:
                default:
                    // Only reachable while an just-removed lane's gate fades out;
                    // there is nothing left to compose, the gate ramp above is
                    // the whole job.
                    break;
            }
        }

        sl.effCutoffHz.store(static_cast<float>(clampCutoff(cutB, sr)),
                             std::memory_order_relaxed);
        sl.effQ.store(static_cast<float>(std::clamp(qB, kMinQ, kMaxQ)),
                      std::memory_order_relaxed);

        if (sl.core == SlotCore::Ladder)
        {
            sl.g1 = 0.0f; sl.dg1 = 0.0f;
            LadderDesign l0, l1;
            designLadder(l0, cutA, qA, sr, sl.selfOsc);
            designLadder(l1, cutB, qB, sr, sl.selfOsc);

            auto& L = sl.ladder;
            L.G       = static_cast<float>(l0.G);
            L.k       = static_cast<float>(l0.k);
            L.invDen  = static_cast<float>(l0.invDen);
            L.inGain  = static_cast<float>(l0.inGain);
            L.dG      = static_cast<float>(l1.G      - l0.G)      * invN;
            L.dK      = static_cast<float>(l1.k      - l0.k)      * invN;
            L.dInvDen = static_cast<float>(l1.invDen - l0.invDen) * invN;
            L.dInGain = static_cast<float>(l1.inGain - l0.inGain) * invN;
        }
        else if (sl.core == SlotCore::Comb)
        {
            sl.g1 = 0.0f; sl.dg1 = 0.0f;
            const int maxDelay = std::max(4, sl.comb.mask - 2);
            CombDesign c0, c1;
            designComb(c0, type, cutA, qA, mp0, sr, maxDelay);
            designComb(c1, type, cutB, qB, mp1, sr, maxDelay);

            auto& C = sl.comb;
            C.delay  = static_cast<float>(c0.delay);
            C.g      = static_cast<float>(c0.g);
            C.damp   = static_cast<float>(c0.damp);
            C.dDelay = static_cast<float>(c1.delay - c0.delay) * invN;
            C.dG     = static_cast<float>(c1.g     - c0.g)     * invN;
            C.dDamp  = static_cast<float>(c1.damp  - c0.damp)  * invN;
        }
        else if (sl.onePole)
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
                S.dkq = S.dSkG = S.dSkA = S.dSkD = 0.0f;
            }
        }
        else
        {
            sl.g1 = 0.0f; sl.dg1 = 0.0f;

            // The formant bank resolves each section's own centre frequency and
            // bandwidth from the vowel table before designing it; every other
            // type designs all sections from the slot's single cutoff.
            FormantPlan fp0, fp1;
            if (sl.core == SlotCore::Formant)
            {
                const int va = sl.vowelAPtr ? static_cast<int>(std::lround(
                    sl.vowelAPtr->load(std::memory_order_relaxed))) : 0;
                const int vb = sl.vowelBPtr ? static_cast<int>(std::lround(
                    sl.vowelBPtr->load(std::memory_order_relaxed))) : 0;
                planFormant(fp0, va, vb, mp0, hd0, cutA, qA, sr);
                planFormant(fp1, va, vb, mp1, hd1, cutB, qB, sr);
            }

            for (int st = 0; st < sl.stageCount; ++st)
            {
                StageDesign d0, d1;
                if (sl.core == SlotCore::Formant)
                {
                    designStage(d0, type, fp0.f[st], fp0.q[st], 0.0, 0.0, sr, false,
                                st, fp0.amp[st]);
                    designStage(d1, type, fp1.f[st], fp1.q[st], 0.0, 0.0, sr, false,
                                st, fp1.amp[st]);
                }
                else
                {
                    designStage(d0, type, resolveTypeCutoff(type, cutA, sr),
                                stageQ(qA, sl.stageCount, st), gn0, mp0, sr,
                                sl.selfOsc, st);
                    designStage(d1, type, resolveTypeCutoff(type, cutB, sr),
                                stageQ(qB, sl.stageCount, st), gn1, mp1, sr,
                                sl.selfOsc, st);
                }

                auto& S = sl.stages[st];
                S.a1 = static_cast<float>(d0.a1);
                S.a2 = static_cast<float>(d0.a2);
                S.a3 = static_cast<float>(d0.a3);
                S.m0 = static_cast<float>(d0.m0);
                S.m1 = static_cast<float>(d0.m1);
                S.m2 = static_cast<float>(d0.m2);
                S.kq = static_cast<float>(d0.k);
                S.skG = static_cast<float>(d0.skG);
                S.skA = static_cast<float>(d0.skA);
                S.skD = static_cast<float>(d0.skD);
                S.da1 = static_cast<float>(d1.a1 - d0.a1) * invN;
                S.da2 = static_cast<float>(d1.a2 - d0.a2) * invN;
                S.da3 = static_cast<float>(d1.a3 - d0.a3) * invN;
                S.dm0 = static_cast<float>(d1.m0 - d0.m0) * invN;
                S.dm1 = static_cast<float>(d1.m1 - d0.m1) * invN;
                S.dm2 = static_cast<float>(d1.m2 - d0.m2) * invN;
                S.dkq = static_cast<float>(d1.k   - d0.k)   * invN;
                S.dSkG = static_cast<float>(d1.skG - d0.skG) * invN;
                S.dSkA = static_cast<float>(d1.skA - d0.skA) * invN;
                S.dSkD = static_cast<float>(d1.skD - d0.skD) * invN;
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

    // One sample of one follower lane's detector, fed the SLOT's own input
    // (whatever the slots before it produced).  Lanes on the same slot all see
    // the same input but keep their own ballistics, so two followers can track
    // the same signal at different speeds.  Everything here is mul/add/branch —
    // no transcendental, no allocation, no branchy data structure.
    static void updateDetector(ModLane& ln, float l, float r, bool stereo)
    {
        auto& D = ln.dyn;

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

    // ── 4-pole ladder: moog24 (transistor) and acid303 (diode) ──────────────
    //
    // Zavalishin's closed-form ladder solve.  Four TPT one-pole sections, each
    //     y_i = G*in_i + (1-G)*s_i,   s_i <- 2*y_i - s_i
    // and a global feedback k around all four, so
    //     y4 = G^4*u + S,  u = x - k*y4   =>   y4 = (G^4*x + S) / (1 + k*G^4)
    // with S the accumulated state contribution.  That solve is the LINEAR
    // predictor; the nonlinearity is then resolved with exactly ONE forward pass
    // (a single fixed-point iteration), so the cost is fixed and known — there
    // is no convergence loop anywhere near the audio thread.
    //
    // What makes the 303 a 303 rather than a small Moog:
    //   • the resonance feedback goes through a 150 Hz HIGH PASS (the coupling
    //     capacitor).  Without it the filter goes thin as resonance comes up;
    //     with it the bottom end survives, which is the entire acid sound.
    //   • the shaper is a cubic diode knee, not a transistor-pair tanh — gentler,
    //     with more even-order content.
    // Exponential (V/oct) cutoff response is not modelled here because it does
    // not need to be: every modulation source upstream already composes in
    // octave space, so the cutoff arriving in `fc` is already exponential in the
    // control value.
    static float processLadderSample(SlotState& sl, int ch, float x)
    {
        auto& L = sl.ladder;

        const float G  = L.G;
        const float om = 1.0f - G;
        const float G2 = G * G;
        const float G4 = G2 * G2;

        const float s1 = L.s[0][ch], s2 = L.s[1][ch];
        const float s3 = L.s[2][ch], s4 = L.s[3][ch];

        const float S = ((G2 * G) * s1 + G2 * s2 + G * s3 + s4) * om;
        const float xin = x * L.inGain;

        // Pass 1 — the linear predictor.
        float y4 = (G4 * xin + S) * L.invDen;

        // Pass 2 — the single nonlinear iteration.  `u` is the resolved ladder
        // input; each section then saturates its own input on the way through.
        float fb;
        if (sl.nonlinear && sl.diodeMode)
        {
            // 150 Hz one-pole high pass in the feedback path (y = x - x1 + R*y1).
            const float fin = L.k * y4;
            const float fhp = fin - L.fbHpX1[ch] + L.fbHpR * L.fbHpY1[ch];
            L.fbHpX1[ch] = fin;
            L.fbHpY1[ch] = xleth_filter::flushDenormal(fhp);
            fb = xleth_filter::diodeShape(fhp);
        }
        else
        {
            // Transistor pair.  This clamp is what bounds self-oscillation at
            // k = 4 instead of letting the loop gain run away.
            fb = L.k * xleth_filter::ladderTanh(y4);
        }

        const float u = xin - fb;

        float in = u;
        for (int i = 0; i < 4; ++i)
        {
            if (sl.nonlinear)
                in = sl.diodeMode ? xleth_filter::diodeShape(in)
                                  : xleth_filter::ladderTanh(in);

            const float si = L.s[i][ch];
            const float y  = G * in + om * si;
            L.s[i][ch] = std::clamp(xleth_filter::flushDenormal(2.0f * y - si),
                                    -kLadderStateMax, kLadderStateMax);
            in = y;
        }
        return in;
    }

    // ── Sallen-Key (Zavalishin ch. 7), built from the TPT one-pole ──────────
    //
    // From the analog circuit (equal R, C; non-inverting gain K; sigma = s/w):
    //     Vin = V2 * (sigma^2 + (3-K)*sigma + 1)
    // and the signal flow that produces it is
    //     V1 = LP(Vin - (K-1)*V2) + (K-1)*V2,   V2 = LP(V1)
    // i.e. two TPT one-poles with the SECOND one's output fed back around the
    // first.  Substituting the TPT one-pole y = G*x + (1-G)*s resolves the
    // zero-delay loop in closed form:
    //     V2 = [G^2*Vin + G(1-G)s1 + (1-G)s2] / (1 - (K-1)*G*(1-G))
    // The denominator is >= 0.5 for every K <= 3 because G(1-G) <= 1/4, so the
    // section is solvable at any cutoff and any resonance — no special cases.
    // Output is V2 (unity DC gain), NOT K*V2: taking the amplifier output would
    // make the level jump with the resonance knob.
    static float processSkSample(SlotState& sl, int ch, float x)
    {
        float v = x;
        for (int st = 0; st < sl.stageCount; ++st)
        {
            auto& S = sl.stages[st];
            const float G  = S.skG;
            const float om = 1.0f - G;
            const float a  = S.skA;
            float s1 = S.ic1eq[ch], s2 = S.ic2eq[ch];

            // Linear closed-form solve.
            float v2 = (G * G * v + G * om * s1 + om * s2) * S.skD;

            // Feedback amount, optionally through the asymmetric diode limiter.
            // With the limiter off this is exactly a*v2, and the forward pass
            // below then reproduces the closed-form solution bit for bit — the
            // two branches meet at the fixed point, so engaging drive cannot step.
            float fb = a * v2;
            if (sl.nonlinear && sl.driveOn)
            {
                const float lim = xleth_filter::diodeLimit(fb, sl.drive);
                fb += sl.driveBlend * (lim - fb);
            }

            const float u  = v - fb;
            const float o1 = G * u + om * s1;      // LP1 output
            const float v1 = o1 + fb;              // node between the two poles
            v2 = G * v1 + om * s2;                 // LP2 output

            S.ic1eq[ch] = xleth_filter::flushDenormal(2.0f * o1 - s1);
            S.ic2eq[ch] = xleth_filter::flushDenormal(2.0f * v2 - s2);
            v = v2;
        }
        return v;
    }

    // ── Steiner-Parker input injection ──────────────────────────────────────
    //
    // The SAME SVF core, with the input patched into a different node.  Writing
    // the three injections as uh (HP node), ub (2nd integrator) and ul (after
    // both integrators), the trapezoidal algebra collapses to something very
    // small: with P = ic1eq + ub and Q = ic2eq + ul, the standard Cytomic
    // equations hold VERBATIM, and the only change is that the state update
    // subtracts the injected term back out once:
    //     ic1eq <- 2*bp - P - ub      ic2eq <- 2*lp - Q - ul
    // Output is always the LP node, which makes the three injections read as
    // lowpass (uh), bandpass (ub) and highpass (ul).
    static float processSteinerSample(SlotState& sl, int ch, float x)
    {
        auto& S = sl.stages[0];

        const float uh = (sl.inject == 0) ? x : 0.0f;
        const float ub = (sl.inject == 1) ? x : 0.0f;
        const float ul = (sl.inject == 2) ? x : 0.0f;

        const float P = S.ic1eq[ch] + ub;
        const float Q = S.ic2eq[ch] + ul;

        float v3 = uh - Q;
        float v1 = S.a1 * P + S.a2 * v3;
        float v2 = Q + S.a2 * P + S.a3 * v3;

        if (sl.nonlinear && sl.driveOn)
        {
            // Grit at the HP node — the point the Steiner's input network sits
            // on.  Saturate it and feed the correction back as one fixed-point
            // iteration; deterministic cost, no loop.
            const float hp  = uh - S.kq * v1 - v2;
            const float sat = xleth_filter::fastTanh(hp * sl.drive) * sl.invDrive;
            const float d   = sl.driveBlend * (sat - hp);
            v3 = (uh + d) - Q;
            v1 = S.a1 * P + S.a2 * v3;
            v2 = Q + S.a2 * P + S.a3 * v3;
        }

        S.ic1eq[ch] = xleth_filter::flushDenormal(2.0f * v1 - P - ub);
        S.ic2eq[ch] = xleth_filter::flushDenormal(2.0f * v2 - Q - ul);
        return v2;
    }

    // ── Comb (feedforward / feedback resonator) ─────────────────────────────
    //
    // Fractional delay by first-order allpass interpolation (Dattorro).  Linear
    // interpolation is not an option here: the delay time is a modulation
    // destination, and linear interp thumps and loses top end as it slides.  The
    // integer/fraction split is done PER SAMPLE from the lerped delay, biased so
    // the allpass fraction stays in [0.5, 1.5) — outside that window the
    // interpolator's pole gets close enough to the unit circle to ring.
    static float processCombSample(SlotState& sl, int ch, float x)
    {
        auto& C = sl.comb;
        if (C.mask <= 0 || C.buf[ch].empty()) return x;   // never prepared

        int   M = static_cast<int>(C.delay);
        float f = C.delay - static_cast<float>(M);
        if (f < 0.5f) { M -= 1; f += 1.0f; }
        if (M < 1)    { M = 1;  f = 0.5f; }
        const float a = (1.0f - f) / (1.0f + f);

        const int   rd = (C.w - M) & C.mask;
        const float v  = C.buf[ch][static_cast<size_t>(rd)];

        // y[n] = a*v[n] + v[n-1] - a*y[n-1]  — DC delay of exactly f samples.
        const float y = a * v + C.apZin[ch] - a * C.apZout[ch];
        C.apZin[ch]  = v;
        C.apZout[ch] = xleth_filter::flushDenormal(y);

        // One-pole damping inside the loop (damp == 1 is a pass-through).
        const float dmp = C.dampZ[ch] + C.damp * (y - C.dampZ[ch]);
        C.dampZ[ch] = xleth_filter::flushDenormal(dmp);

        const float out = x + C.g * dmp;
        // Feedback mode recirculates the output through the soft clip; the
        // feedforward mode writes the dry input, so it has no loop at all.
        C.buf[ch][static_cast<size_t>(C.w)] =
            sl.combFb ? xleth_filter::safetyClip(out) : x;
        return out;
    }

    // ── Formant bank ────────────────────────────────────────────────────────
    // Three constant-peak-gain bandpasses in PARALLEL on the same input, summed.
    // Each section's m set is (0, k*amp, 0) and its centre frequency came from
    // the log-domain vowel morph, so the peaks SLIDE between vowels.
    static float processFormantSample(SlotState& sl, int ch, float x)
    {
        float sum = 0.0f;
        for (int st = 0; st < sl.stageCount; ++st)
        {
            auto& S = sl.stages[st];
            const float v3 = x - S.ic2eq[ch];
            const float v1 = S.a1 * S.ic1eq[ch] + S.a2 * v3;
            const float v2 = S.ic2eq[ch] + S.a2 * S.ic1eq[ch] + S.a3 * v3;
            S.ic1eq[ch] = xleth_filter::flushDenormal(2.0f * v1 - S.ic1eq[ch]);
            S.ic2eq[ch] = xleth_filter::flushDenormal(2.0f * v2 - S.ic2eq[ch]);
            sum += S.m0 * x + S.m1 * v1 + S.m2 * v2;
        }
        return sum;
    }

    // One sample through one slot's wet path (drive -> core -> DC block).
    static float processSlotSample(SlotState& sl, int ch, float x)
    {
        float v0 = x;

        // Shared pre-filter drive.  Skipped for the cores that spend their drive
        // on an in-loop nonlinearity instead (Sallen-Key, Steiner) — running both
        // would saturate the same signal twice.
        if (sl.driveOn && !sl.inLoopDrive)
        {
            const float sat = xleth_filter::fastTanh(v0 * sl.drive) * sl.invDrive;
            v0 += sl.driveBlend * (sat - v0);
        }

        switch (sl.core)
        {
            case SlotCore::Ladder:    v0 = processLadderSample(sl, ch, v0);  break;
            case SlotCore::SallenKey: v0 = processSkSample(sl, ch, v0);      break;
            case SlotCore::Steiner:   v0 = processSteinerSample(sl, ch, v0); break;
            case SlotCore::Comb:      v0 = processCombSample(sl, ch, v0);    break;
            case SlotCore::Formant:   v0 = processFormantSample(sl, ch, v0); break;

            case SlotCore::Svf:
            default:
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
                break;
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

    // Full APVTS id of a lane parameter: "s{slot}_m{lane}_{suffix}".
    static juce::String laneParamId(int slotIndex, int lane, const char* suffix)
    {
        return "s" + juce::String(slotIndex) + "_m" + juce::String(lane) + "_" + suffix;
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

    // Same two, addressed by (slot, lane) instead of slot.
    bool setLaneParam(int slotIndex, int lane, const char* suffix, float value)
    {
        return setParamDirect(slotIndex, modParamName(lane, suffix), value);
    }

    float readLaneParam(int slotIndex, int lane, const char* suffix) const
    {
        return readParam(slotIndex, modParamName(lane, suffix).c_str());
    }

    // The 18 parameters one modulator lane declares, in layout order.
    static const char* const* modParamSuffixes(int& countOut)
    {
        static const char* names[] = {
            "kind", "dest", "depth",
            "shape", "rate_mode", "rate_ms", "sync", "phase",
            "attack", "hold", "decay", "sustain", "release", "slides",
            "dyn_attack", "dyn_release", "cut_min", "cut_max"
        };
        countOut = static_cast<int>(sizeof(names) / sizeof(names[0]));
        return names;
    }

    // Slot-relative name of a lane parameter: "m{lane}_{suffix}".  This is the
    // name setSlotParam takes, so the UI adds a modulator by writing "m2_kind" —
    // the whole feature needed no new RPC surface.
    static std::string modParamName(int lane, const char* suffix)
    {
        return "m" + std::to_string(lane) + "_" + suffix;
    }

    // Every slot-relative parameter name, base block then all lanes.  Built once
    // on first use; copySlotParams walks it so removeSlot's compaction carries a
    // slot's modulator lanes along with its filter settings.
    static const std::vector<std::string>& slotParamNames()
    {
        static const std::vector<std::string> names = [] {
            std::vector<std::string> v = {
                "enabled", "type", "cutoff", "q", "gain", "morph", "slope",
                "drive", "mix", "cut_min", "cut_max",
                "dyn_depth", "dyn_attack", "dyn_release",
                "vowel_a", "vowel_b", "head",
                "lfo_on", "lfo_dest", "lfo_depth", "lfo_shape",
                "lfo_rate_mode", "lfo_rate_ms", "lfo_sync", "lfo_phase",
                "env_on", "env_dest", "env_depth", "env_attack", "env_hold",
                "env_decay", "env_sustain", "env_release", "env_slides"
            };
            int n = 0;
            const char* const* suffixes = modParamSuffixes(n);
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
                for (int k = 0; k < n; ++k)
                    v.push_back(modParamName(j, suffixes[k]));
            return v;
        }();
        return names;
    }

    void copySlotParams(int srcSlot, int dstSlot)
    {
        for (const auto& name : slotParamNames())
            setParamDirect(dstSlot, name, readParam(srcSlot, name.c_str()));
    }

    // ── APVTS parameter layout factory ──────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Nar = juce::NormalisableRange<float>;

        std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
        params.reserve(kMaxSlots * kNumSlotParams);

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

            // ── Formant bank (inert for every other slot type) ──────────────
            // The morph itself reuses s{i}_morph, and the bandwidth scale reuses
            // s{i}_q (higher Q = narrower formants), so both are already smoothed
            // and already modulation destinations.  Only these three are new.
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "vowel_a", 1 }, label + "Vowel A",
                Nar(0.0f, static_cast<float>(xleth_filter::kNumVowels - 1), 1.0f),
                static_cast<float>(xleth_filter::Vowel::Ah)));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "vowel_b", 1 }, label + "Vowel B",
                Nar(0.0f, static_cast<float>(xleth_filter::kNumVowels - 1), 1.0f),
                static_cast<float>(xleth_filter::Vowel::Ee)));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "head", 1 }, label + "Head Size",
                Nar(static_cast<float>(-kFormantHeadMax),
                    static_cast<float>(kFormantHeadMax)), 0.0f,
                juce::AudioParameterFloatAttributes().withLabel("st")));

            // ── Per-slot LFO modulator ──────────────────────────────────────
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_on", 1 }, label + "LFO On",
                Nar(0.0f, 1.0f, 1.0f), 0.0f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_dest", 1 }, label + "LFO Dest",
                Nar(0.0f, static_cast<float>(xleth_filter::kNumModDests - 1), 1.0f), 0.0f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_depth", 1 }, label + "LFO Depth",
                Nar(-1.0f, 1.0f), 0.5f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_shape", 1 }, label + "LFO Shape",
                Nar(0.0f, static_cast<float>(xleth_filter::kNumLfoWaves - 1), 1.0f), 0.0f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_rate_mode", 1 }, label + "LFO Rate Mode",
                Nar(0.0f, 1.0f, 1.0f), 1.0f));   // 0 = free (ms), 1 = tempo sync
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_rate_ms", 1 }, label + "LFO Rate",
                Nar(1.0f, 5000.0f, 0.0f, 0.35f), 500.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_sync", 1 }, label + "LFO Sync",
                Nar(0.125f, 64.0f, 0.0f, 0.3f), 4.0f));  // note-division denominator
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "lfo_phase", 1 }, label + "LFO Phase",
                Nar(0.0f, 1.0f), 0.0f));

            // ── Per-slot Envelope modulator ─────────────────────────────────
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_on", 1 }, label + "Env On",
                Nar(0.0f, 1.0f, 1.0f), 0.0f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_dest", 1 }, label + "Env Dest",
                Nar(0.0f, static_cast<float>(xleth_filter::kNumModDests - 1), 1.0f), 0.0f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_depth", 1 }, label + "Env Depth",
                Nar(-1.0f, 1.0f), 0.5f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_attack", 1 }, label + "Env Attack",
                Nar(0.0f, 2000.0f, 0.0f, 0.4f), 5.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_hold", 1 }, label + "Env Hold",
                Nar(0.0f, 2000.0f, 0.0f, 0.4f), 0.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_decay", 1 }, label + "Env Decay",
                Nar(0.0f, 2000.0f, 0.0f, 0.4f), 120.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_sustain", 1 }, label + "Env Sustain",
                Nar(0.0f, 1.0f), 0.7f));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_release", 1 }, label + "Env Release",
                Nar(0.0f, 5000.0f, 0.0f, 0.4f), 200.0f,
                juce::AudioParameterFloatAttributes().withLabel("ms")));
            params.push_back(std::make_unique<Apf>(
                juce::ParameterID{ prefix + "env_slides", 1 }, label + "Env Slides",
                Nar(0.0f, 1.0f, 1.0f), 0.0f));

            // ── Modulator lanes ─────────────────────────────────────────────
            // kMaxModsPerSlot identical blocks, each the UNION of the three
            // kinds' parameters.  Ranges / skews / defaults are copied verbatim
            // from the legacy blocks above, so one lane of a given kind behaves
            // exactly like the fixed modulator it replaces.  A lane at kind =
            // Off reads none of them and costs nothing.
            for (int j = 0; j < xleth_filter::kMaxModsPerSlot; ++j)
            {
                const juce::String mp = prefix + "m" + juce::String(j) + "_";
                const juce::String ml = label + "M" + juce::String(j) + " ";

                // Common to every kind.
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "kind", 1 }, ml + "Kind",
                    Nar(0.0f, static_cast<float>(xleth_filter::kNumModKinds - 1), 1.0f), 0.0f));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "dest", 1 }, ml + "Dest",
                    Nar(0.0f, static_cast<float>(xleth_filter::kNumModDests - 1), 1.0f), 0.0f));
                // Depth DEFAULTS TO 0, not to the 0.5 an LFO gets when you add
                // one.  An untouched lane must be inert at the smoother too, or
                // switching it on would first hear the depth glide DOWN from a
                // non-zero default through the 20 ms smoothing ramp.  resetLane
                // installs the per-kind starting depth when a lane is added.
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "depth", 1 }, ml + "Depth",
                    Nar(-1.0f, 1.0f), 0.0f));

                // LFO kind.
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "shape", 1 }, ml + "Shape",
                    Nar(0.0f, static_cast<float>(xleth_filter::kNumLfoWaves - 1), 1.0f), 0.0f));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "rate_mode", 1 }, ml + "Rate Mode",
                    Nar(0.0f, 1.0f, 1.0f), 1.0f));   // 0 = free (ms), 1 = tempo sync
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "rate_ms", 1 }, ml + "Rate",
                    Nar(1.0f, 5000.0f, 0.0f, 0.35f), 500.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "sync", 1 }, ml + "Sync",
                    Nar(0.125f, 64.0f, 0.0f, 0.3f), 4.0f));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "phase", 1 }, ml + "Phase",
                    Nar(0.0f, 1.0f), 0.0f));

                // Envelope kind.
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "attack", 1 }, ml + "Attack",
                    Nar(0.0f, 2000.0f, 0.0f, 0.4f), 5.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "hold", 1 }, ml + "Hold",
                    Nar(0.0f, 2000.0f, 0.0f, 0.4f), 0.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "decay", 1 }, ml + "Decay",
                    Nar(0.0f, 2000.0f, 0.0f, 0.4f), 120.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "sustain", 1 }, ml + "Sustain",
                    Nar(0.0f, 1.0f), 0.7f));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "release", 1 }, ml + "Release",
                    Nar(0.0f, 5000.0f, 0.0f, 0.4f), 200.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "slides", 1 }, ml + "Slides",
                    Nar(0.0f, 1.0f, 1.0f), 0.0f));

                // Dynamics-follower kind.  cut_min / cut_max are PER LANE: they
                // are that follower's sweep window, so two followers on one slot
                // can sweep different ranges.
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "dyn_attack", 1 }, ml + "Dyn Attack",
                    Nar(0.1f, 100.0f), 10.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "dyn_release", 1 }, ml + "Dyn Release",
                    Nar(1.0f, 2000.0f), 100.0f,
                    juce::AudioParameterFloatAttributes().withLabel("ms")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "cut_min", 1 }, ml + "Cut Min",
                    Nar(20.0f, 20000.0f, 0.0f, kFreqSkew), 20.0f,
                    juce::AudioParameterFloatAttributes().withLabel("Hz")));
                params.push_back(std::make_unique<Apf>(
                    juce::ParameterID{ mp + "cut_max", 1 }, ml + "Cut Max",
                    Nar(20.0f, 20000.0f, 0.0f, kFreqSkew), 20000.0f,
                    juce::AudioParameterFloatAttributes().withLabel("Hz")));
            }
        }

        return { std::make_move_iterator(params.begin()),
                 std::make_move_iterator(params.end()) };
    }

    // ── Data members ────────────────────────────────────────────────────────
    SlotState           slots_[kMaxSlots];
    std::atomic<int>    slotCount_{0};
    std::atomic<double> sampleRate_{44100.0};

    // Per-track modulation gate (set by applyModulationGate, read by the Envelope
    // composition). Audio thread only; see applyModulationGate.
    bool    modGateValid_ = false;
    int64_t modGateStart_ = 0;
    int64_t modGateEnd_   = 0;
};

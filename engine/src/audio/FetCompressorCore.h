#pragma once

// ─── FetCompressorCore — the 1176-lineage FET policies for CompressorCore ────
// docs/Compressor_Archetypes_Deep_Dive.md §4 (the FET archetype) and the
// FetComp line of §9:
//
//   CompressorCore<RcRectifier, FetRatioPresetGC, RcBallistics,
//                  FetShuntDivider, ClassAColor>
//
// Unlike the Glue (clean VCA) and the Opto (character in the cell's timing),
// the FET's character lives IN the gain element: a JFET shunting the signal
// node to ground, linearised by feeding a fraction k of V_DS back to its gate,
// with the residual ε = 2k − 1 of that linearisation as the even-order
// distortion source (§4.3). Around it:
//
//   RcRectifier       the sidechain rectifier: full-wave, instantaneous, in dB,
//                     linked max(L, R). Its RC networks are RcBallistics — the
//                     core smooths after the gain computer, and the ratio
//                     network is memoryless, so the two commute.
//   FetRatioPresetGC  the ratio buttons. Each button is a PRESET that sets the
//                     slope, the threshold, the knee (§4.2/§4.5); the static
//                     law is the Giannoulis curve in its feedback (inverse) form
//                     so the closed loop settles on it. Its ρ is the FET's
//                     CHANNEL CONDUCTANCE a = R_s / r_DS, not dB — see below.
//   RcBallistics      rectifier → attack RC → release RC (§4.5): the one timing
//                     capacitor on the gate, charged through the attack pot and
//                     drained through the release pot, integrated trapezoidally
//                     (TPT).
//   FetShuntDivider   the §4.3 closed-form square-law divider, no iteration.
//   ClassAColor       asymmetric class-A soft clipper + output transformer (§8.4).
//
// Topology: feedback (§2.1). The 1176 senses the sidechain after the gain
// reduction; the core's tracked loop, solved implicitly per sample, is exactly
// that (the loop sees L − B, B = the element's small-signal GR).
//
// ── Why ρ is conductance ────────────────────────────────────────────────────
// A JFET in its ohmic region is a resistor whose conductance is LINEAR in the
// gate overdrive: 1/r_DS = 2β(V_ctl − V_P). The sidechain's RC networks charge
// and discharge the gate, so they smooth a' = R_s/r_DS = 2βR_s(V_ctl − V_P),
// not decibels, and GR = 20·log10(1 + a'). Consequences, all measured by
// test_fet_compressor [4]:
//   • at modest GR the release in dB is the RC's (63 % in ≈ τ from 3 dB);
//   • from deep GR it is slower: a' decays exponentially, which is a LINEAR
//     ramp in dB at 8.7 dB per τ until the log flattens (63 % in ≈ 1.9 τ from
//     20 dB). §1.3 warns about exactly this as an artefact of a linear-domain
//     detector; here it is the device law, so it is kept — a light touch lets
//     go quickly, a crushed signal recovers in a slow ramp.
//   • the attack in dB is faster the bigger the transient (the log compresses
//     the top of the exponential charge).
// The UREI 1176LN manual quotes release as "for 63 % recovery" and the attack
// as a tone-burst time; both ranges are taken as the RC τ (DspPrimitives.h's one
// time-constant definition), and the closed loop is faster still (§2.1: τ over
// the loop gain above the knee).
//
// ── Fit ─────────────────────────────────────────────────────────────────────
// Sources: UREI 1176LN owner's manual (specs + calibration), UA's 1176 manual,
// and the ARP-journal "All Buttons In" analysis of the UREI transfer curves.
//   ratio / threshold  UREI table: output at threshold +7 / +8 / +9 / +10 dBm
//                      for 4 / 8 / 12 / 20:1 (input at minimum threshold
//                      −26 / −25 / −24 dB for 8 / 12 / 20:1): the threshold
//                      rises 1 dB per button. Knees: "soft knee at 4:1", "at
//                      20:1 tracking linear ±1 dB over 10 dB of GR", ARP:
//                      harder knee at higher ratio — the widths 10/7/5/3 dB
//                      are ours, in that order.
//   attack slowdown    UA: "varies slightly with the ratio, lower ratios keep
//                      the fastest attack" — ×1.00 / 1.08 / 1.16 / 1.30, ours.
//   All buttons in     its own preset (§4.2 — not a blend of the four): ARP
//                      puts the ratio "between 12:1 and 20:1", a "plateau",
//                      and a "lag time on initial transients". Modelled as
//                      16:1 with a 1.5 dB knee, the threshold 3 dB BELOW the
//                      4:1's (all four ratio resistors in parallel feed the
//                      sidechain more signal), attack ×4 (the lag), release
//                      ×0.5 (the pumping), and the bias network pulled off its
//                      null — gate drive amplified, ε growing with it
//                      instead of saturating (FetShuntDivider). No
//                      public measurement gives numbers for this mode; these
//                      are listening-tuning knobs, and the over-compression
//                      some units show (output FALLING past the knee) is not
//                      modelled — the feedback form needs a monotone curve.
//   THD vs GR          UREI: "< 0.5 % THD 50 Hz–15 kHz with limiting, at 1.1 s
//                      release"; calibration "< 0.5 % during 5 dB limiting",
//                      and < 0.3 % with the FET in but not limiting — the FET
//                      adds nothing until it conducts. ε is fitted so the
//                      element alone gives ≈0.13 % at 5 dB, 0.4 % at 10 dB,
//                      1.4 % at 20 dB and 2.1 % at 30 dB of GR at 4:1 (1 kHz,
//                      slowest release), rising monotonically through the
//                      working range; see FetShuntDivider for the law and
//                      test_fet_compressor [3] for the fit and its ε = 0
//                      negative control.
//
// All time constants run at the rate the core runs — the OVERSAMPLED rate. The
// 20 µs attack is 0.9 samples at 44.1 kHz (§2.3); at 4× it is 3.5.

#include "audio/CompressorCore.h"
#include "dsp/DspPrimitives.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <cmath>

namespace xleth::comp
{

// ─── The ratio buttons ──────────────────────────────────────────────────────
struct FetPreset
{
    const char* name;
    float ratio;
    float kneeDb;
    float thresholdOffsetDb;   // relative to the 4:1 threshold
    float attackScale;         // × the knob's attack τ
    float releaseScale;        // × the knob's release τ
    bool  allButtonsIn;        // the element's bias network (FetShuntDivider)
};

struct Fet1176
{
    // In-core level (after Input) where the 4:1 threshold sits. There is no
    // threshold control: Input drives the signal into the curve.
    static constexpr float kThresholdDb = -18.0f;

    static constexpr int kAllButtonsIn = 4;
    static constexpr std::array<FetPreset, 5> kPresets {{
        { "4:1",  4.0f,  10.0f,  0.0f, 1.00f, 1.0f, false },
        { "8:1",  8.0f,   7.0f,  1.0f, 1.08f, 1.0f, false },
        { "12:1", 12.0f,  5.0f,  2.0f, 1.16f, 1.0f, false },
        { "20:1", 20.0f,  3.0f,  3.0f, 1.30f, 1.0f, false },
        { "All",  16.0f,  1.5f, -3.0f, 4.00f, 0.5f, true  },
    }};

    // The knobs keep the hardware's numbering: 1..7, FASTER clockwise (7 is
    // 20 µs / 50 ms, 1 is 800 µs / 1.1 s). The pots are taken as log-taper, so
    // τ is geometric in the knob position.
    static constexpr double kAttackFastS  = 20.0e-6, kAttackSlowS  = 800.0e-6;
    static constexpr double kReleaseFastS = 0.050,   kReleaseSlowS = 1.100;

    static double knobSeconds(float knob, double slowS, double fastS) noexcept
    {
        const double t = (std::clamp(static_cast<double>(knob), 1.0, 7.0) - 1.0) / 6.0;
        return slowS * std::pow(fastS / slowS, t);
    }
    static double attackSeconds(float knob) noexcept  { return knobSeconds(knob, kAttackSlowS, kAttackFastS); }
    static double releaseSeconds(float knob) noexcept { return knobSeconds(knob, kReleaseSlowS, kReleaseFastS); }
};

// ─── Detector: the sidechain rectifier ──────────────────────────────────────
// Full-wave, linked (max(L, R) or the mean), in dB floored at −120 — and it
// reads the CONTINUOUS peak, as the analog rectifier does.
//
// A sampled |x| reads a tone's peak low by up to 1 − cos(π·f/fs), and for a
// tone not commensurate with fs that error beats slowly with the sampling
// phase. A 20:1 loop with a 20 µs attack follows the beat, which puts
// inharmonic sidebands on the tone: −40 dBc at 16 kHz at 4×, still −52 dBc at
// 8× (test_fet_compressor [5]; the same numbers with the fix: −66 and −83).
// So at every strict local maximum of |x| the rectifier fits a parabola
// through the three samples around it and takes its vertex — the peak between
// the samples, never below the sampled maximum — as the level. It is known one (oversampled) sample late, 5 µs at
// 4 × 48 kHz, which the feedback loop does not notice; off the peaks the level
// is |x| itself.
struct RcRectifier
{
    void prepare(double) noexcept {}
    void reset() noexcept { p0_ = p1_ = 0.0f; }

    float levelDb(float l, float r, StereoLink link) noexcept
    {
        const float al = std::abs(l), ar = std::abs(r);
        const float v = (link == StereoLink::Sum) ? 0.5f * (al + ar) : std::max(al, ar);
        float level = v;
        // A STRICT maximum only: a plateau edge (a step onto, or off, a steady
        // level — a square wave's) has no peak between its samples.
        if (p1_ > p0_ && p1_ > v)
        {
            const float d = p0_ - v;
            level = p1_ - 0.125f * d * d / (p0_ - 2.0f * p1_ + v);   // denominator < 0
        }
        p0_ = p1_;
        p1_ = v;
        return dsp::gainToDb(level);
    }

private:
    float p0_ = 0.0f, p1_ = 0.0f;   // the two previous rectified samples
};

// ─── Gain element: the JFET shunt divider (§4.3) ────────────────────────────
//
//   Audio in ──[R_s]──┬── v ──► preamp
//                     │
//                  D  │
//        V_ctl + k·v ─G  JFET        I_D = β·[ 2(V_ctl − V_P)·v + ε·v² ]
//                  S  │                                      ε = 2k − 1
//                    GND
//
// KCL at the node, normalised by G_s = 1/R_s (a = 2βR_s(V_ctl − V_P), b' = βR_s·ε):
//   b'·v² + (1 + a)·v − x = 0   ⇒   v = 2x / [ (1 + a) + √((1 + a)² + 4b'x) ]
// — the doc's fetShuntDivider, in its cancellation-free form. Small-signal gain
// 1/(1 + a), so GR = 20·log10(1 + a) and gainFor() maps the core's GR (dB)
// straight to a. The preamp behind the node calibrates the pinched-off
// insertion loss out: a = 0 is exactly unity (bit-exact: ε(0) = 0).
//
// Device: I_DSS 10 mA, V_P −4 V (a 2N3819-class part: β = I_DSS/V_P² =
// 0.625 mA/V²) behind R_s = 60 kΩ, so βR_s = 37.5 /V and the channel fully on
// (V_GS = 0) is a = 2βR_s|V_P| = 300: the element cannot reduce more than
// 49.6 dB, and the GC stops asking there. The audio reaches the node at
// 0.2 V per full scale — the node itself is held near the threshold level by
// the loop (≈ 25 mV peak at −18 dBFS), "a small fraction of a volt".
// V_DS/(V_ctl − V_P) there falls below 1 from ≈ 12 dB of GR; below that the
// square law is stretched, but the channel then carries under 75 % of the node
// current and the ε term is small, so the error reaching the output is too
// (test_fet_compressor [1] prints both).
//
// ── ε: DEVIATION from the doc's constant eps ────────────────────────────────
// The doc's snippet takes `eps` as a constant fit parameter. With ε constant,
// the divider's own 2nd harmonic is, to first order,
//     H2/H1 = βR_s·ε·v̂ / (2·(1 + a))          (v̂ = node amplitude)
// — at a held output it FALLS as the gain reduction rises (the channel is driven
// further into conduction, so V_DS/(V_ctl − V_P) shrinks). The doc (and the
// hardware) say distortion RISES with gain reduction, so ε cannot be constant:
// it must grow faster than (1 + a). Physically: Shockley's 3/2-power law puts
// the channel's quadratic coefficient at ∝ 1/√(φ − V_GS), which grows as the
// gate opens, while the unit's R16 trim ("adjust for minimum distortion") nulls
// the k-network at ONE operating point only. Fitted law (test_fet_compressor [3]):
//     e = ε_s·a^1.5                (ε_s = 6e-3)
//     ε = e / (1 + e/ε_max)        (ε_max = 0.8: |2k − 1| ≤ 1 for a divider k)
// Past ≈ 30 dB of GR at 4:1 (≈ 25 dB at 20:1, whose node is held lowest) ε
// saturates and the 1/(1 + a) wins: the element cleans up again. That is where
// §4.4's audio-rate gain modulation carries the grit.
//
// All buttons in shifts the bias network. With the four ratio resistors in
// parallel the gate is driven from the sidechain amplifier's output, so the
// audio reaching it is AMPLIFIED: k is no longer a passive divider's fraction
// and ε is no longer bounded by |2k − 1| ≤ 1. Modelled as ε_s ×4 plus a term
// that grows with the gate drive itself (0.08·a), with a ceiling of 6 instead
// of 0.8 — so, unlike the four buttons, the element does not clean up at deep
// reduction: 2.4–6.6× the 20:1's THD from 3 to 45 dB of GR (fitted with the
// Python prototype; test_fet_compressor [6] checks it at 10 and 30 dB).
// The switch is ramped over 30 ms (setAllButtonsIn), the same as the core's
// lane crossfade.
//
// The square law has no real root when 4b'x < −(1 + a)² (the device would
// leave the ohmic region); the quadratic share r = 4b'x/(1 + a)² is soft-
// limited to |r| < 0.9 by a 4th-order limiter, r / (1 + (r/0.9)⁴)^¼. Through
// 30 dB of GR at threshold-level signals |r| stays under 0.25, where the
// limiter changes r by < 0.3 %; it only engages on a transient that outruns
// the attack while ε is already large.
struct FetShuntDivider
{
    static constexpr float kBetaRs         = 37.5f;     // β·R_s, 1/V
    static constexpr float kPinchOffV      = 4.0f;      // |V_P|
    static constexpr float kMaxConductance = 2.0f * kBetaRs * kPinchOffV;   // 300
    static constexpr float kMaxGrDb        = 49.5713299f;                    // 20·log10(301)
    static constexpr float kVoltsPerFs     = 0.2f;

    static constexpr float kEpsScale      = 6.0e-3f;
    static constexpr float kEpsMax        = 0.8f;
    static constexpr float kAllInEpsScale = 4.0f;
    static constexpr float kAllInEpsDrive = 0.08f;
    static constexpr float kAllInEpsMax   = 6.0f;
    static constexpr double kBiasSlewSeconds = 0.030;

    // ε for channel conductance a; allIn is the bias network's 0..1 weight.
    static float residual(float a, float allIn, float scale = 1.0f) noexcept
    {
        const float e = scale * (kEpsScale * (1.0f + allIn * (kAllInEpsScale - 1.0f)) * a * std::sqrt(a)
                                 + allIn * kAllInEpsDrive * a);
        const float cap = kEpsMax + allIn * (kAllInEpsMax - kEpsMax);
        return e / (1.0f + e / cap);
    }

    // The closed form in volts (tests; the per-sample path below is the same
    // expression in full-scale units).
    static float divide(float xVolts, float a, float eps) noexcept
    {
        const float s = 1.0f + a;
        const float r = 4.0f * kBetaRs * eps * xVolts / (s * s);
        return 2.0f * xVolts / (s * (1.0f + std::sqrt(1.0f + limitShare(r))));
    }

    static constexpr float kShareLimit = 0.9f;
    static float limitShare(float r) noexcept
    {
        const float q = r * (1.0f / kShareLimit);
        const float q2 = q * q;
        return r / std::sqrt(std::sqrt(1.0f + q2 * q2));
    }

    // GR (dB) ⇄ channel conductance.
    static float conductanceFor(float grDb) noexcept
    {
        return std::clamp(std::expm1(grDb * dsp::kNeperPerDb), 0.0f, kMaxConductance);
    }

    void prepare(double fs) noexcept
    {
        bias_.prepare(fs, kBiasSlewSeconds);
        reset();
    }

    void reset() noexcept
    {
        bias_.snap(allIn_ ? 1.0f : 0.0f);
        invS_ = 1.0f;
        rPerX_ = 0.0f;
    }

    void setAllButtonsIn(bool on) noexcept
    {
        allIn_ = on;
        bias_.setTarget(on ? 1.0f : 0.0f);
    }
    bool allButtonsIn() const noexcept { return allIn_; }

    // Test hook: scales ε (0 = a perfectly trimmed k = ½, the negative control).
    void setResidualScale(float s) noexcept { residualScale_ = s; }

    // Once per sample: the channel conductance for this GR, and the ε term the
    // two apply() calls share.
    float gainFor(float grDb) noexcept
    {
        const float a = conductanceFor(grDb);
        const float eps = residual(a, bias_.next(), residualScale_);
        invS_ = 1.0f / (1.0f + a);
        rPerX_ = 4.0f * kBetaRs * kVoltsPerFs * eps * invS_ * invS_;
        return a;
    }

    float apply(float x, float /*a*/, int) const noexcept
    {
        return 2.0f * x * invS_ / (1.0f + std::sqrt(1.0f + limitShare(rPerX_ * x)));
    }

private:
    dsp::LinearRamp bias_ {};
    bool  allIn_ = false;
    float residualScale_ = 1.0f;
    float invS_  = 1.0f;
    float rPerX_ = 0.0f;
};

// ─── GC: the ratio buttons ──────────────────────────────────────────────────
// The Giannoulis soft knee at the preset's ratio, knee and threshold, in its
// FEEDBACK (inverse) form so the closed loop settles on the textbook curve
// (CompressorCore.h / DspPrimitives.h), mapped from dB to the channel
// conductance the gate must reach: a = 10^(GR/20) − 1, capped where the FET is
// fully on. ρ spans 0..300, so the loop's Newton stop is relative.
struct FetRatioPresetGC
{
    static constexpr float kLoopRelTolerance = 1.0e-5f;

    struct Params
    {
        float ratio             = 4.0f;
        float kneeDb            = 10.0f;
        float thresholdOffsetDb = 0.0f;
        bool operator==(const Params& o) const noexcept
        {
            return ratio == o.ratio && kneeDb == o.kneeDb && thresholdOffsetDb == o.thresholdOffsetDb;
        }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    static Params forPreset(const FetPreset& p) noexcept { return { p.ratio, p.kneeDb, p.thresholdOffsetDb }; }

    static dsp::SoftKneeGC::Params knee(const Params& p) noexcept { return { p.ratio, p.kneeDb }; }

    // dB reduction (and its slope) → conductance (and its slope).
    static float toConductance(float grDb, float slopeDb, float& slope) noexcept
    {
        const float a = std::expm1(grDb * dsp::kNeperPerDb);
        if (a >= FetShuntDivider::kMaxConductance) { slope = 0.0f; return FetShuntDivider::kMaxConductance; }
        slope = (1.0f + a) * dsp::kNeperPerDb * slopeDb;
        return a;
    }

    static float reductionFB(float v, float T, const Params& p, float& slope) noexcept
    {
        float s;
        const float r = dsp::SoftKneeGC::reductionFB(v, T + p.thresholdOffsetDb, knee(p), s);
        return toConductance(r, s, slope);
    }

    static float reductionFF(float x, float T, const Params& p, float& slope) noexcept
    {
        float s;
        const float r = dsp::SoftKneeGC::reductionFF(x, T + p.thresholdOffsetDb, knee(p), s);
        return toConductance(r, s, slope);
    }

    // The static curve the loop settles on (the FET's ceiling included).
    static float outputDb(float x, float T, const Params& p) noexcept
    {
        const float y = dsp::SoftKneeGC::outputDb(x, T + p.thresholdOffsetDb, knee(p));
        return x - std::min(x - y, FetShuntDivider::kMaxGrDb);
    }
};

// ─── Ballistics: rectifier → attack RC → release RC (§4.5) ──────────────────
// The 1176's timing network is ONE capacitor on the gate drive:
//
//   rectifier ──►|── R_attack ──┬── gate buffer ──► V_ctl
//                               C
//                               ├── R_release ── GND
//
// charged through the attack pot while the rectified drive exceeds it (the
// diode conducts), discharged through the release pot always:
//   dv/dt = [ρ > v]·(ρ − v)/τ_a − v/τ_r         τ_a = R_a·C, τ_r = R_r·C
// v is the gate drive in conductance units, so a = v and GR = 20·log10(1 + v).
// While charging the cap settles at ρ·τ_r/(τ_a + τ_r) — the network's own
// divider, 0.04 % (20 µs / 50 ms) to 1.6 % (800 µs / 50 ms) below the drive;
// the loop gain absorbs it (test_fet_compressor [2] measures the worst case).
//
// DEVIATION from a first reading of §4.5's "rectifier → attack RC → release
// RC": two cascaded networks — a symmetric attack RC feeding a diode-held
// release cap — were tried first and rejected. The symmetric attack stage
// drains to zero at every zero crossing and must re-climb the stiff 20:1 loop
// at every peak, which locked the GR into a relaxation cycle unrelated to the
// signal (a 0.2 dB sawtooth, −47 dBc of inharmonic sidebands on a 3 kHz tone
// at 4×). The single diode-gated capacitor is both the real circuit and
// periodic (test_fet_compressor [5]).
//
// Integration: trapezoidal (TPT) — the capacitor is one integrator,
//   v_n = v_{n−1} + ½·(f_n + f_{n−1}),
// solved in closed form for the regime (charging or not) the END of the sample
// is in. It is left unprewarped: the two regimes share one state and must meet
// continuously at the diode's switch point (ρ = the released value), which
// keeps predict() continuous and nondecreasing in ρ for the loop's Newton
// solve; at the 4× rate the unwarped pole is within 0.6 % of exact for the
// 20 µs attack. The step is half a sample late by construction (the trapezoid
// sees a sampled step as a ramp across its first sample), which the RC timing
// test accounts for.
//
// State is physical (v, last ρ), so a coefficient change (knob, ratio button)
// needs no re-encoding: f_{n−1} is rebuilt from it with the current τs.
struct RcBallistics
{
    struct Params
    {
        float attackS  = 250.0e-6f;
        float releaseS = 0.140f;
        bool operator==(const Params& o) const noexcept { return attackS == o.attackS && releaseS == o.releaseS; }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    struct Coeffs
    {
        // Per-sample rates 1/(τ·fs) and the trapezoid's closed-form factors.
        float wA = 1.0f, wR = 0.0f;
        float halfWA = 0.5f;          // ½·w_a
        float invCharge = 1.0f;       // 1 / (1 + ½(w_a + w_r))
        float invRelease = 1.0f;      // 1 / (1 + ½·w_r)
        float dCharge = 0.0f;         // dv/dρ while charging: ½·w_a / (1 + ½(w_a + w_r))
    };

    struct State
    {
        float v   = 0.0f;   // capacitor = gate drive = channel conductance a
        float rho = 0.0f;   // last drive (for f_{n−1})
        float gr  = 0.0f;   // 20·log10(1 + v)

        // Memo of the last predict() from THIS state: the core's solve ends on
        // predict(ρ*) and then commits ρ*, so commit reuses its log1p (as the
        // Opto's ballistics do). Invalidated by commit.
        mutable float memoTarget = -1.0f;
        mutable float memoV = 0.0f, memoGr = 0.0f;
    };

    static Coeffs makeCoeffs(const Params& p, double fs) noexcept
    {
        Coeffs c;
        c.wA = static_cast<float>(1.0 / std::max(1.0e-9, p.attackS * fs));
        c.wR = static_cast<float>(1.0 / std::max(1.0e-9, p.releaseS * fs));
        c.halfWA = 0.5f * c.wA;
        c.invCharge = 1.0f / (1.0f + 0.5f * (c.wA + c.wR));
        c.invRelease = 1.0f / (1.0f + 0.5f * c.wR);
        c.dCharge = c.halfWA * c.invCharge;
        return c;
    }

    static float value(const State& s) noexcept { return s.gr; }

    static float grFor(float a) noexcept { return dsp::kDbPerNeper * std::log1p(a); }

    // One trapezoidal step for drive ρ: the new cap voltage and dv/dρ.
    // Written as an INCREMENT on v (Δ = ½(f₀ + f₁), solved for f₁ implicitly),
    // never as a pole multiplying v: at a 1.1 s release a per-sample pole sits
    // 3e-6 below 1 and its float rounding alone would shift τ by percents —
    // the same trap DspPrimitives.h's onePoleStep avoids.
    static float step(const State& s, const Coeffs& c, float rho, float& dv) noexcept
    {
        const float f0 = (s.rho > s.v ? c.wA * (s.rho - s.v) : 0.0f) - c.wR * s.v;
        const float dRel = 0.5f * (f0 - c.wR * s.v) * c.invRelease;
        const float released = std::max(0.0f, s.v + dRel);
        if (rho > released)
        {
            dv = c.dCharge;
            return s.v + 0.5f * (f0 + c.wA * (rho - s.v) - c.wR * s.v) * c.invCharge;
        }
        dv = 0.0f;
        return released;
    }

    static float predict(const State& s, const Coeffs& c, float target, float& d) noexcept
    {
        float dv;
        const float v = step(s, c, target, dv);
        d = dsp::kDbPerNeper / (1.0f + v) * dv;
        s.memoTarget = target;
        s.memoV = v;
        s.memoGr = grFor(v);
        return s.memoGr;
    }

    static void commit(State& s, const Coeffs& c, float target) noexcept
    {
        float v, gr;
        if (target == s.memoTarget) { v = s.memoV; gr = s.memoGr; }
        else { float dv; v = step(s, c, target, dv); gr = grFor(v); }
        s.memoTarget = -1.0f;
        // Flush the tails — they never decay into denormals. a = 1e-9 is
        // 9e-9 dB of reduction.
        s.v   = v > kFlush ? v : 0.0f;
        s.rho = target > kFlush ? target : 0.0f;
        s.gr  = s.v > 0.0f ? gr : 0.0f;
    }

    // Both lanes of a fade start from one copied state; its memo was computed
    // with the other lane's coefficients.
    static void adopt(State& s, const Coeffs&) noexcept { s.memoTarget = -1.0f; }

    static constexpr float kFlush = 1.0e-9f;
};

// ─── Colour: class-A output amplifier + transformer (§8.4) ──────────────────
// Always in (the unit has no colour switch). Runs at the oversampled rate.
//
//   class A     the single-ended transistor line amp: an exponential transfer,
//               so a QUADRATIC term leads at low level (2nd harmonic ∝ level:
//               ≈0.1 % at 0 dBFS, 0.01 % at −20), then an asymmetric soft
//               clip — the cutoff side (negative) runs out of headroom first
//               (knee +1.6 dBFS, ceiling +6.8) and the saturation side later
//               (knee +4.1 dBFS, ceiling +8.9). Both knees are C2 (Padé on the
//               excess), and 0 dBFS output stays clean, as the UREI spec's
//               "< 0.3 % THD 1 dB below clipping" asks. Output (makeup) sits in
//               front of it, as on the unit, so pushing Output drives it.
//   transformer the 1176LN's "low phase shift, flat response" output
//               transformer: 8 Hz coupling (also the DC blocker for the
//               quadratic term and the FET's), gentle LF saturation below
//               80 Hz, mild HF resonance at 50 kHz (the unit is −3 dB near
//               55 kHz).
struct ClassAColor
{
    static constexpr float kQuad      = 2.0e-3f;
    static constexpr float kQuadSat   = 0.25f;     // 1/x_s²: the quadratic saturates past ~2 FS
    static constexpr float kPosKnee   = 1.6f, kPosCeil = 2.8f;
    static constexpr float kNegKnee   = 1.2f, kNegCeil = 2.2f;

    static float clipSide(float e, float knee, float ceil) noexcept
    {
        if (e <= knee) return e;
        const float span = ceil - knee;
        return knee + span * dsp::softClipPade((e - knee) / span);
    }

    // The memoryless class-A curve (tests).
    static float amp(float x) noexcept
    {
        const float x2 = x * x;
        const float e = x + kQuad * x2 / (1.0f + kQuadSat * x2);
        return e >= 0.0f ? clipSide(e, kPosKnee, kPosCeil) : -clipSide(-e, kNegKnee, kNegCeil);
    }

    void prepare(double fs) noexcept
    {
        xfmr_.prepare(fs, { 8.0f, 80.0f, 0.25f, 50000.0f, 0.8f });
    }

    void reset() noexcept { xfmr_.reset(); }

    float process(float x, int ch) noexcept { return xfmr_.process(amp(x), ch); }

private:
    dsp::OutputTransformer xfmr_ {};
};

using FetCompressorCore =
    CompressorCore<RcRectifier, FetRatioPresetGC, RcBallistics, FetShuntDivider, ClassAColor>;

// Stepped settings for a ratio button and the two knobs (knob units 1..7).
inline FetCompressorCore::Settings fetSettings(int preset, float attackKnob, float releaseKnob) noexcept
{
    const FetPreset& p = Fet1176::kPresets[static_cast<size_t>(std::clamp(preset, 0, 4))];
    FetCompressorCore::Settings s;
    s.gc = FetRatioPresetGC::forPreset(p);
    s.bal.attackS  = static_cast<float>(Fet1176::attackSeconds(attackKnob) * p.attackScale);
    s.bal.releaseS = static_cast<float>(Fet1176::releaseSeconds(releaseKnob) * p.releaseScale);
    s.topology = Topology::TrackedFeedback;
    return s;
}

} // namespace xleth::comp

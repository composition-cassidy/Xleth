#pragma once

// ─── VariMuCompressorCore — the Fairchild 660/670-lineage policies ──────────
// docs/Compressor_Archetypes_Deep_Dive.md §5 (the vari-mu archetype) and the
// VariMuComp line of §9:
//
//   CompressorCore<RcRectifierT<PeakFit::Cosine>, IdentityGC, MultiRcBallistics,
//                  PushPullVariMu, TubeTransformerColor>
//
// There is no gain computer curve and no ratio: the "ratio" is the remote-
// cutoff tube's transconductance curve inside the gain element (§5.2/§5.3).
//
//   RcRectifierT<Cosine> the FET's sidechain rectifier (FetCompressorCore.h):
//                        full-wave, continuous peak, in dB — with the peak fitted
//                        by a cosine, not a parabola: at 2× a 67 µs attack loop
//                        followed the parabola's sampling-phase error into
//                        −43 dBc of sidebands at 16 kHz (−76 with the cosine).
//                        Linked max(L, R), or one per channel in Mid/Side.
//   IdentityGC           passes the rectified voltage straight through — dB back
//                        to volts, minus the rectifier's DC threshold bias, with
//                        the diode's soft turn-on. No curve, no ratio. Its ρ is
//                        VOLTS (in units of that threshold bias), not dB.
//   MultiRcBallistics    the grid-bias timing network: up to three capacitors,
//                        each with its own charge path (diode + series R) and
//                        drain path, the bias being the highest of them. Time
//                        Constant 1–4 use one; 5 and 6 are the automatic
//                        program-dependent networks (§5.2, §5.4 item 4).
//   PushPullVariMu       the 6386 push-pull stage (§5.4 items 1–3): each half a
//                        bias-dependent waveshaper whose slope IS the fitted
//                        g_m(CV) curve, combined as ½·(upper(x) − lower(−x)).
//   TubeTransformerColor tube line amp + output transformer (OptoCompressorCore.h).
//
// Topology: feedback-style (§2.1, §7): the sidechain is derived from the gain-
// reduced signal — the core's tracked loop, solved implicitly per sample. The
// loop sees the stage's output: L − B (B = its small-signal reduction) through
// 24 dB of GR, the actual large-signal output crest beyond (PushPullVariMu).
//
// ── Why the ratio rises with level (§5.3 point 1) ──────────────────────────
// With a LINEAR rectifier in a feedback loop, the local slope of the static
// curve is  R − 1 = (ln10/20)·u·dGR/dc,  where u is the total rectified voltage
// (the threshold bias plus the control voltage c) and dGR/dc is the stage's dB
// per volt. u grows with the output only slowly (it is held near the threshold
// by the loop), so the ratio rises with level because dGR/dc does: the tube's
// gain falls faster and faster with bias as it approaches cutoff. That is also
// why a vari-mu has the widest knee of the four: no knee is drawn anywhere —
// the slope just keeps turning.
//
// DEVIATION from the doc's "roughly log-linear" g_m curve (§5.4 item 1), made
// because the §5.2 ratio contract demands it: with g_m exactly log-linear
// (constant dGR/dc = s) the formula above gives R = R₀ + 0.115·GR — at best
// ≈5:1 at 25 dB of reduction, never "2:1 to 30:1". So the fitted curve is the
// remote-cutoff shape in full (VariMuTube): flat at the quiescent point
// (cathode degeneration), log-linear through the working range (the variable-
// pitch grid's exponential law), steepening into the last section's 3/2-power
// final cutoff, and flattening at the plate-feedthrough floor. Measured static
// curve (test_varimu [2]): 1.5:1 at 1 dB of GR, 2.3:1 at 3 dB, 4.4:1 at 10 dB,
// 8.7:1 at 20 dB, 14:1 at 25 dB, 31:1 at 30 dB; the slope falls from 0.9 to
// 0.25 over 16.8 dB of input (the FET's widest, 4:1, knee is 10 dB). The same
// rectifier and loop with an exactly log-linear g_m reach 5.2:1 at 30 dB.
//
// ── Time constants and the §1.3 normalisation ──────────────────────────────
// The position table (Fairchild670::kPositions) carries the ORIGINAL manual's
// figures (0.2/0.4 ms attack; 0.3, 0.8, 2, 5 s; auto 2/10 s and 0.3/10/25 s),
// not the reissue or plugin spec sheets and their known transcription errors
// (§5.2: "3 sec"/".2 sec", Waves' 0.8 s / 4 ms, NI's 0.8 ms / 25 s). Those
// figures are times to near-complete recovery, ≈3× the RC products that set the
// network (§1.3, the GroupDIY RC analysis): every figure is DIVIDED BY 3
// (kManualToTau) before it becomes a one-pole τ. Measured, with the division,
// in the closed loop from 10 dB of GR (test_varimu [4]): recovery to 0.2 dB in
// 0.32 / 0.84 / 2.1 / 5.3 s for positions 1–4 — the manual's numbers. Without
// it every release is ≈3× too long, which the negative control asserts.
//
// ── What "automatic" means here (positions 5 and 6) ────────────────────────
// Per the GroupDIY trace (§5.2): a small capacitor (2 µF) handles individual
// peaks; an 8 µF one behind series resistors — and in position 6 a 20 µF one —
// charges only under sustained program. Modelled as parallel branches, each a
// dsp::DiodeRcCap with its own charge and drain path, OR'd onto the bias line
// (the grid sees the highest branch). The branch drains carry the manual's
// three figures (÷3); the slow branches' charge paths are not in the manual and
// are fitted (τ_c = 0.3 s for the 8 µF, 1.0 s for the 20 µF) so that, from
// 10 dB of GR: a single 20 ms peak recovers in 2.1 s (pos 5) / 0.3 s (pos 6), a
// 4 s train of such peaks in 6.2 s / 10 s, and 12 s of sustained program in
// 9.5 s / 23 s — "2 s individual, 10 s multiple" and "0.3 s individual, 10 s
// multiple, 25 s consistently high" (test_varimu [3]).
//
// All time constants run at the rate the core runs — the OVERSAMPLED rate.

#include "audio/CompressorCore.h"
#include "audio/FetCompressorCore.h"     // RcRectifierT
#include "audio/OptoCompressorCore.h"    // TubeTransformerColor
#include "dsp/DspPrimitives.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <cmath>

namespace xleth::comp
{

// ─── The 6386 push-pull stage's gain-vs-bias curve ──────────────────────────
// Every voltage is in units of the sidechain rectifier's DC threshold bias
// (V_th = 1), so the curve, the rectifier and the grid drive share one scale.
// b is the grid bias BEYOND the quiescent point (b > 0 more negative, toward
// cutoff; b < 0 toward grid conduction); the control voltage c is b ≥ 0.
//
//   tube     g_m(b)  = e^(−b/V_s) · √(1 − b/b_N)      remote cutoff: the variable-
//                                                      pitch grid's exponential law,
//                                                      the last section's 3/2-power
//                                                      final cutoff at b_N
//   stage    A(b)    = m/(1 + m) + A_f,  m = m₀·g_m(b) cathode degeneration flattens
//                                                      the top (m₀ = g_m·R_k at rest);
//                                                      A_f is the plate feedthrough
//   GR(c)            = 20·log10( A(0) / A(c) )         0 at rest, 51.5 dB at cutoff
//
// A(b) is the stage's small-signal gain; the waveshaper each half applies is its
// integral (PushPullVariMu). Past the grid-conduction point (b < −V_q) the grid
// clamps and A rolls off to zero. Fitted (see the header) so the closed loop
// gives the §5.2 ratio from ≈2:1 toward ≈30:1.
struct VariMuTube
{
    static constexpr double kM0             = 3.0;     // m₀
    static constexpr double kVs             = 0.7;     // V_s
    static constexpr double kCutoff         = 2.2;     // b_N
    static constexpr double kFloor          = 2.0e-3;  // A_f
    static constexpr double kGridConduction = 1.0;     // V_q: the quiescent bias
    static constexpr double kGridSoftness   = 0.1;     // how fast the grid clamps
    static constexpr double kRestGain       = kM0 / (1.0 + kM0) + kFloor;   // A(0)

    // Deepest reduction the stage can give (the tube cut off, feedthrough only).
    static constexpr float kMaxGrDb = 51.5037569f;     // 20·log10(A(0)/A_f)

    // Stage small-signal gain at bias b, normalised to 1 at rest. Not RT-hot:
    // table building and tests.
    static double stageGain(double b) noexcept
    {
        double a = kFloor;
        if (b < kCutoff)
        {
            const double m = kM0 * std::exp(-b / kVs) * std::sqrt(1.0 - b / kCutoff);
            a += m / (1.0 + m);
        }
        if (b < -kGridConduction)
        {
            const double over = (-kGridConduction - b) / kGridSoftness;
            a *= std::exp(-over * over);
        }
        return a / kRestGain;
    }

    // GR (dB) for control voltage c ≥ 0 and its slope dGR/dc. The per-sample
    // form (the loop evaluates it inside its Newton solve).
    static float grDb(float c, float& slope) noexcept
    {
        constexpr float kLnRest = -0.285018955f;  // ln(A(0)) = ln(0.752)
        static_assert(kM0 == 3.0 && kFloor == 2.0e-3, "kLnRest is ln(0.75 + 0.002)");
        if (c <= 0.0f)
        {
            // dGR/dc at rest: m₀(1/V_s + 1/(2b_N)) / ((1 + m₀)²·A(0)) in dB.
            slope = kRestSlope;
            return 0.0f;
        }
        const float x = 1.0f - c * static_cast<float>(1.0 / kCutoff);
        if (x <= 0.0f) { slope = 0.0f; return kMaxGrDb; }
        const float r = std::sqrt(x);
        const float m = static_cast<float>(kM0) * std::exp(-c * static_cast<float>(1.0 / kVs)) * r;
        const float inv = 1.0f / (1.0f + m);
        const float a = m * inv + static_cast<float>(kFloor);
        // −dA/dc = m·(1/V_s + 1/(2(b_N − c)))/(1 + m)²,  b_N − c = b_N·x
        const float dm = m * (static_cast<float>(1.0 / kVs) + static_cast<float>(0.5 / kCutoff) / x);
        slope = dsp::kDbPerNeper * dm * inv * inv / a;
        return dsp::kDbPerNeper * (kLnRest - std::log(a));
    }

    static constexpr float kRestSlope =
        static_cast<float>(8.68588963806503655 * kM0 * (1.0 / kVs + 0.5 / kCutoff)
                           / ((1.0 + kM0) * (1.0 + kM0) * kRestGain));
};

// ─── GC: the rectifier, passed straight through ─────────────────────────────
// The sidechain amplifier and full-wave rectifier are linear: the voltage they
// deliver is proportional to the (reduced) output amplitude,
//   u = 10^((v − T)/20)                       v = sidechain level (dB), T = the
//                                             in-core level where u = V_th
// and the timing network only charges once u overcomes the DC threshold bias
// V_th. ρ = the voltage over that bias, through the diode's soft turn-on:
//   ρ = 0                    s < −w
//       (s + w)² / (4w)      |s| ≤ w          s = u − 1  (V_th = 1)
//       s                    s > w
// w = 0.4 V_th: a C1 knee instead of a slope step at the onset (the stage's own
// knee is already the widest of the four; this only rounds its first corner).
// No curve, no ratio (§9: "IdentityGC passes the control signal straight
// through"). Params is empty — the vari-mu has no stepped GC control.
struct IdentityGC
{
    static constexpr float kDiodeKnee = 0.4f;   // w

    struct Params
    {
        bool operator==(const Params&) const noexcept { return true; }
        bool operator!=(const Params&) const noexcept { return false; }
    };

    // ρ for a sidechain level (dB) against T, and dρ/d(level dB).
    static float rectify(float levelDb, float T, float& slope) noexcept
    {
        const float d = levelDb - T;
        // Below the diode's turn-on (u < 1 − w ⇔ d < 20·log10(0.6)) nothing
        // conducts — and no exp is spent.
        if (d <= kTurnOnDb) { slope = 0.0f; return 0.0f; }
        const float u = dsp::dbToGain(d);
        const float s = u - 1.0f;
        const float du = u * dsp::kNeperPerDb;
        if (s >= kDiodeKnee) { slope = du; return s; }
        const float q = s + kDiodeKnee;
        slope = q * (0.5f / kDiodeKnee) * du;
        return q * q * (0.25f / kDiodeKnee);
    }

    static float reductionFB(float v, float T, const Params&, float& slope) noexcept { return rectify(v, T, slope); }
    static float reductionFF(float x, float T, const Params&, float& slope) noexcept { return rectify(x, T, slope); }

    // Static (equilibrium) output level for a steady input level x: the output
    // y whose rectified voltage biases the stage to exactly x − y of reduction,
    //   y = x − GR( ρ(y) ).
    // The timing network's own charge divider (≤ 0.2 %) is ignored. Not RT
    // (bisection).
    static float outputDb(float x, float T, const Params&) noexcept
    {
        float lo = x - VariMuTube::kMaxGrDb - 1.0f, hi = x;
        for (int i = 0; i < 60; ++i)
        {
            const float y = 0.5f * (lo + hi);
            float s1, s2;
            const float gr = VariMuTube::grDb(rectify(y, T, s1), s2);
            (y - (x - gr) > 0.0f ? hi : lo) = y;
        }
        return 0.5f * (lo + hi);
    }

    static constexpr float kTurnOnDb = -4.43697499f;   // 20·log10(1 − w)
    static_assert(kDiodeKnee == 0.4f, "kTurnOnDb = 20*log10(1 - kDiodeKnee)");
};

// ─── The Time Constant switch ───────────────────────────────────────────────
struct Fairchild670
{
    // The original manual's figures (doc §5.2 table, via the GroupDIY analysis):
    // attack, and the recovery times — individual peaks, multiple peaks,
    // consistently high program (0 = that branch is not switched in).
    struct Position
    {
        float attackMs;
        float recoveryS[3];
    };

    static constexpr std::array<Position, 6> kPositions {{
        { 0.2f, { 0.3f,  0.0f,  0.0f } },
        { 0.2f, { 0.8f,  0.0f,  0.0f } },
        { 0.4f, { 2.0f,  0.0f,  0.0f } },
        { 0.4f, { 5.0f,  0.0f,  0.0f } },
        { 0.4f, { 2.0f, 10.0f,  0.0f } },   // auto
        { 0.2f, { 0.3f, 10.0f, 25.0f } },   // auto
    }};

    // §1.3: the manual's figures are ≈2.5–3× the RC products (time to near-
    // complete recovery, not the 63 % τ). Divide by 3 before any coefficient.
    static constexpr double kManualToTau = 1.0 / 3.0;

    // Charge paths of the program-dependent branches (8 µF and 20 µF behind
    // their series resistors) — not in the manual; fitted, see the header.
    static constexpr double kSlowChargeS[3] = { 0.0, 0.3, 1.0 };
};

// ─── Ballistics: the multi-RC grid-bias network ─────────────────────────────
//
//   rectifier ρ ─┬─►|── R_a ────┬── v₀ ──►|──┐
//                │              C₀ (2 µF)    │
//                │              ├── R_d0     │
//                ├─►|── R_c1 ───┬── v₁ ──►|──┼──► grid bias c = max(v₀, v₁, v₂)
//                │              C₁ (8 µF)    │
//                │              ├── R_d1     │
//                └─►|── R_c2 ───┬── v₂ ──►|──┘
//                               C₂ (20 µF)
//                               └── R_d2
//
// Branch 0 charges through the attack path and drains through the position's
// "individual peaks" release; branches 1 and 2 (positions 5/6 only) charge
// slowly — only sustained program fills them — and drain slowly, holding the
// bias up after peak trains and loud passages. Each branch is a
// dsp::DiodeRcCap: τ_c = R_c·C, τ_d = R_d·C, TPT, predict() continuous and
// nondecreasing in ρ (a max of such branches is too), which the core's
// implicit loop solve needs. value() is the stage's GR for the bias.
//
// State is physical (the capacitor voltages and the last drive), so a Time
// Constant change needs no re-encoding: leaving an automatic position folds
// the slow branches into branch 0 (the bias does not move); entering one starts
// its slow branches empty.
struct MultiRcBallistics
{
    static constexpr int kMaxBranches = 3;

    // Below every branch's charge threshold predict() does not depend on the
    // drive (the diodes are off): the core's loop solve then takes the
    // sidechain's demand as the exact root without iterating.
    static constexpr bool kDiodeGated = true;

    struct Params
    {
        float attackS = 0.2e-3f / 3.0f;
        float drainS[kMaxBranches]  { 0.1f, 0.0f, 0.0f };
        float chargeS[kMaxBranches] { 0.0f, 0.0f, 0.0f };   // [0] unused (attack)
        int   branches = 1;

        bool operator==(const Params& o) const noexcept
        {
            if (attackS != o.attackS || branches != o.branches) return false;
            for (int i = 0; i < kMaxBranches; ++i)
                if (drainS[i] != o.drainS[i] || chargeS[i] != o.chargeS[i]) return false;
            return true;
        }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    struct Coeffs
    {
        dsp::DiodeRcCap::Coeffs cap[kMaxBranches] {};
        int branches = 1;
    };

    struct State
    {
        float v[kMaxBranches] {};   // branch capacitor voltages (V_th units)
        float rho = 0.0f;           // last drive (for the trapezoid's f_{n−1})
        float c   = 0.0f;           // the bias: max of the branches
        float gr  = 0.0f;           // GR(c), dB

        // Memo of the last predict() from THIS state: the core's solve ends on
        // predict(ρ*) and then commits ρ*, so commit reuses it (as the Opto and
        // FET ballistics do). Invalidated by commit and adopt.
        mutable float memoTarget = -1.0f;
        mutable float memoV[kMaxBranches] {};
        mutable float memoC = 0.0f, memoGr = 0.0f;

        // The stage curve at the last bias predict() evaluated: below the
        // charge threshold every target gives the same bias, so the loop's
        // second predict() reuses it.
        mutable float curveC = -1.0f, curveGr = 0.0f, curveSlope = 0.0f;
    };

    static Coeffs makeCoeffs(const Params& p, double fs) noexcept
    {
        Coeffs c;
        c.branches = std::clamp(p.branches, 1, kMaxBranches);
        c.cap[0] = dsp::DiodeRcCap::make(p.attackS, p.drainS[0], fs);
        for (int i = 1; i < c.branches; ++i)
            c.cap[i] = dsp::DiodeRcCap::make(p.chargeS[i], p.drainS[i], fs);
        return c;
    }

    static float value(const State& s) noexcept { return s.gr; }

    static float predict(const State& s, const Coeffs& c, float target, float& d) noexcept
    {
        float bias = 0.0f, dBias = 0.0f;
        for (int i = 0; i < c.branches; ++i)
        {
            float dv;
            const float v = dsp::DiodeRcCap::step(s.v[i], s.rho, target, c.cap[i], dv);
            s.memoV[i] = v;
            if (v > bias || i == 0) { bias = v; dBias = dv; }
        }
        if (bias != s.curveC)
        {
            s.curveGr = VariMuTube::grDb(bias, s.curveSlope);
            s.curveC = bias;
        }
        const float gr = s.curveGr;
        d = s.curveSlope * dBias;
        s.memoTarget = target;
        s.memoC = bias;
        s.memoGr = gr;
        return gr;
    }

    static void commit(State& s, const Coeffs& c, float target) noexcept
    {
        if (target != s.memoTarget)
        {
            float d;
            predict(s, c, target, d);
        }
        s.memoTarget = -1.0f;
        // Flush the tails — they never decay into denormals. 1e-9 V_th of bias
        // is ≈1e-10 dB of reduction.
        for (int i = 0; i < c.branches; ++i)
            s.v[i] = s.memoV[i] > kFlush ? s.memoV[i] : 0.0f;
        s.rho = target > kFlush ? target : 0.0f;
        s.c   = s.memoC > kFlush ? s.memoC : 0.0f;
        s.gr  = s.c > 0.0f ? s.memoGr : 0.0f;
    }

    // A Time Constant change: branches the new position does not switch in are
    // folded into branch 0 (the bias — and so the GR — does not move); branches
    // it newly switches in start empty (they have seen no program yet).
    static void adopt(State& s, const Coeffs& c) noexcept
    {
        for (int i = c.branches; i < kMaxBranches; ++i)
        {
            s.v[0] = std::max(s.v[0], s.v[i]);
            s.v[i] = 0.0f;
        }
        s.memoTarget = -1.0f;
    }

    static constexpr float kFlush = 1.0e-9f;
};

// ─── Gain element: the 6386 push-pull stage (§5.4 items 1–3) ────────────────
//
//   input ─┬─ +½ ─► upper half: F( +x·V_in·(1 + δ/2) − c ) ─┐
//          │                                                ├─ ½(upper − lower) ─► out
//          └─ −½ ─► lower half: F( −x·V_in·(1 − δ/2) − c ) ─┘
//                    ▲ the control voltage c enters BOTH grids (common mode)
//
// Each half is a bias-dependent waveshaper: its transfer F(v) is the stage's
// plate current against grid drive, F' = the stage gain A (VariMuTube), so its
// slope at the operating point −c IS the fitted g_m(CV) curve and the gain
// reduction is the waveshaper's own. The grid signal is the FULL input (a vari-
// mu reduces gain by moving the bias, not by shrinking the grid swing), so the
// deeper the reduction the harder the curved part of F is swept: distortion
// rises with GR. The push-pull difference cancels:
//   • the control voltage — common mode, it moves both plate currents together
//     and they subtract at the output transformer: no thump (exactly: with
//     x = 0 both halves read F(−c) and the output is 0 for every c);
//   • the even-order terms of F — up to the mismatch.
// Mismatch: the two halves' transconductances differ by δ = 5 % (a matched
// pair's tolerance); modelled on the signal drive, with the DC balance trimmed
// (the unit's thump-balance adjustment), so it leaves an even-harmonic residue
// (H2 ≈ δ/4·(A'/A)·ê) but never a DC step.
//
// Scale: V_in = the grid swing per full-scale unit in V_th units. The swing at
// the threshold level is 2.5e-4 V_th: the sidechain amplifier's gain makes the
// rectifier's threshold bias thousands of times the grid signal, as in the unit
// (tens of volts of control range for millivolts of grid audio). The element
// alone (1 kHz, test_varimu [5]) gives 0.02 % THD at 10 dB of GR, 0.05 % at 20,
// 0.11 % at 25, 0.38 % at 30 and ≈2 % at 35 dB — clean through the working
// range (where the ballistics' own ripple and the line amp dominate), dirty
// once the swing reaches the final cutoff. The even residue is the mismatch
// (a matched pair leaves 1e-15 %); single-ended, H2 is 20× higher.
//
// Large signal: the stage's gain for the full swing departs from its small-
// signal GR as the swing nears the cutoff (0.001 dB at 25 dB of GR, 0.7 dB at
// 35). The rectifier sees the real output, so loopOutputDb() hands the core's
// loop the actual output crest there; a loop regulating L − B instead let the
// output FALL 0.4 dB between 29 and 32 dB of GR — an over-compression a
// feedback unit cannot do. (A smaller swing only moves that point ~2 dB per
// halving: any swing meets the cutoff within the reachable ≈36 dB of GR.)
//
// F is tabulated at prepare() (4190 intervals over the bias range, cubic
// Hermite with the exact slope A at the knots) and evaluated in double: the
// halves' outputs are O(1) V_th while their difference can be 1e-9, and in
// float the cancellation would put a −100 dBFS noise floor under the audio.
// gainFor() maps the core's GR (dB) back to the control voltage c through an
// inverse table of VariMuTube::grDb (Hermite, slope 1/GR').
struct PushPullVariMu
{
    static constexpr double kGridSwingAtThreshold = 2.5e-4;  // V_th per threshold-level peak
    static constexpr double kMismatch             = 0.05;    // δ

    // F's knots: the rest point v = 0 is a knot (so the rest gain is exactly the
    // table's slope there, 1), 2560 intervals down to the cutoff and on up past
    // the grid clamp (V_q + 4 softness widths).
    static constexpr int    kKnotsBelowRest = 2560;
    static constexpr double kTableH    = VariMuTube::kCutoff / kKnotsBelowRest;
    static constexpr int    kTableN    = kKnotsBelowRest + 1630;   // 1630·h ≥ V_q + 0.4
    static constexpr double kTableLo   = -VariMuTube::kCutoff;
    static constexpr double kTableHi   = kTableLo + kTableN * kTableH;
    static_assert((kTableN - kKnotsBelowRest) * kTableH >= VariMuTube::kGridConduction + 4.0 * VariMuTube::kGridSoftness,
                  "the table must reach past the grid clamp");
    static constexpr int    kInverseN  = 1024;
    static constexpr float  kLargeSignalFromDb = 24.0f;   // below: the loop sees L − B

    // Grid swing per full-scale unit, for the host effect's in-core threshold.
    void setThresholdDb(float thresholdDb) noexcept
    {
        vin_ = kGridSwingAtThreshold / std::pow(10.0, thresholdDb / 20.0);
        invVin_ = 1.0 / vin_;
        smallSignalBelowDb_ = thresholdDb + IdentityGC::kTurnOnDb - 3.0f;
    }

    // Test hook: scales the mismatch δ (0 = a perfectly matched pair).
    void setMismatchScale(float s) noexcept
    {
        upper_ = 1.0 + 0.5 * kMismatch * s;
        lower_ = 1.0 - 0.5 * kMismatch * s;
    }

    // Test hook: drops the lower half (single-ended) — the push-pull negative
    // control for thump and even-order cancellation.
    void setSingleEndedForTest(bool on) noexcept { singleEnded_ = on; }

    void prepare(double) noexcept
    {
        if (!built_) build();
    }

    void reset() noexcept {}

    // Control voltage for a GR (dB).
    float gainFor(float grDb) const noexcept
    {
        if (grDb <= 0.0f) return 0.0f;
        if (grDb >= VariMuTube::kMaxGrDb) return static_cast<float>(VariMuTube::kCutoff);
        const double t = grDb * invStep_;
        int k = static_cast<int>(t);
        k = std::min(k, kInverseN - 1);
        const double u = t - k;
        return static_cast<float>(hermite(invC_[k], invC_[k + 1], invD_[k] * invStepDb_, invD_[k + 1] * invStepDb_, u));
    }

    float apply(float x, float c, int) const noexcept
    {
        const double e = static_cast<double>(x) * vin_;
        const double up = F(upper_ * e - c);
        if (singleEnded_) return static_cast<float>(up * invVin_);   // its plate current's full change
        const double lo = F(-lower_ * e - c);
        return static_cast<float>(0.5 * (up - lo) * invVin_);
    }

    // What the sidechain rectifier really sees (the core's loop hook): the
    // stage's output peak for an input peak at level L (dB) with the bias of B dB
    // of small-signal reduction, and d(output dB)/dB. The same as L − B while
    // the grid swing is small; toward cutoff the swing's large-signal gain falls
    // below the small-signal one, and a loop regulating L − B would let the
    // output FALL as the input rises (−0.4 dB by 32 dB of GR). Below the
    // rectifier's turn-on nothing depends on it: L − B.
    float loopOutputDb(float L, float B, float& dOutdB) const noexcept
    {
        // Small swings: the two agree to 0.001 dB through 24 dB of GR (test_varimu
        // [2]) — skip the tables there.
        if (L - B < smallSignalBelowDb_ || B < kLargeSignalFromDb) { dOutdB = -1.0f; return L - B; }
        double c = 0.0, dcdB = 0.0;
        biasFor(B, c, dcdB);
        const double e = dsp::dbToGain(L) * vin_;
        // The positive crest: the mismatch makes the two polarities' crests
        // differ (the even-order residue) and the full-wave rectifier charges on
        // the larger — which is always this one, since F is convex below grid
        // conduction (F'' = A' > 0) and the upper half is driven harder.
        double au, al;
        const double y = 0.5 * (Fd(upper_ * e - c, au) - Fd(-lower_ * e - c, al)) * invVin_;
        if (y <= 1.0e-9) { dOutdB = 0.0f; return dsp::kDbFloor; }
        // dy/dc = ½(A(c + l·e) − A(c − u·e)) ≤ 0: the upper half sits nearer rest.
        const double dydc = 0.5 * (al - au) * invVin_;
        dOutdB = static_cast<float>(dsp::kDbPerNeper * dydc / y * dcdB);
        return static_cast<float>(dsp::kDbPerNeper * std::log(y));
    }

    // The large-signal static curve: the output y (dB) for a steady input at x
    // whose own rectified peak biases the stage (tests; not RT — bisection).
    float staticOutputDb(float x, float T) const noexcept
    {
        float lo = x - VariMuTube::kMaxGrDb - 20.0f, hi = x + 3.0f;
        for (int i = 0; i < 60; ++i)
        {
            const float y = 0.5f * (lo + hi);
            float s1, s2;
            const float B = VariMuTube::grDb(IdentityGC::rectify(y, T, s1), s2);
            float d;
            (loopOutputDb(x, B, d) > y ? lo : hi) = y;
        }
        return 0.5f * (lo + hi);
    }

    // The half's transfer F(v) (tests).
    double F(double v) const noexcept
    {
        double a;
        return Fd(v, a);
    }

private:
    // F(v) and its slope F'(v) = A.
    double Fd(double v, double& slope) const noexcept
    {
        if (v <= kTableLo)   // tube cut off: the feedthrough, linear
        {
            slope = floorGain_;
            return f_[0] + (v - kTableLo) * floorGain_;
        }
        if (v >= kTableHi) { slope = 0.0; return f_[kTableN]; }
        const double t = (v - kTableLo) * invH_;
        int k = static_cast<int>(t);
        k = std::min(k, kTableN - 1);
        const double u = t - k;
        const double p0 = f_[k], p1 = f_[k + 1], m0 = a_[k] * h_, m1 = a_[k + 1] * h_;
        const double u2 = u * u;
        slope = ((6.0 * u2 - 6.0 * u) * (p0 - p1) + (3.0 * u2 - 4.0 * u + 1.0) * m0 + (3.0 * u2 - 2.0 * u) * m1) * invH_;
        return hermite(p0, p1, m0, m1, u);
    }

    // Control voltage for a GR (dB) and dc/dGR (the inverse table).
    void biasFor(float grDb, double& c, double& dcdGr) const noexcept
    {
        if (grDb <= 0.0f) { c = 0.0; dcdGr = invD_[0]; return; }
        if (grDb >= VariMuTube::kMaxGrDb) { c = VariMuTube::kCutoff; dcdGr = 0.0; return; }
        const double t = grDb * invStep_;
        int k = static_cast<int>(t);
        k = std::min(k, kInverseN - 1);
        const double u = t - k;
        const double p0 = invC_[k], p1 = invC_[k + 1], m0 = invD_[k] * invStepDb_, m1 = invD_[k + 1] * invStepDb_;
        const double u2 = u * u;
        dcdGr = ((6.0 * u2 - 6.0 * u) * (p0 - p1) + (3.0 * u2 - 4.0 * u + 1.0) * m0 + (3.0 * u2 - 2.0 * u) * m1) * invStep_;
        c = hermite(p0, p1, m0, m1, u);
    }

    static double hermite(double p0, double p1, double m0, double m1, double u) noexcept
    {
        const double u2 = u * u, u3 = u2 * u;
        return (2.0 * u3 - 3.0 * u2 + 1.0) * p0 + (u3 - 2.0 * u2 + u) * m0
             + (-2.0 * u3 + 3.0 * u2) * p1 + (u3 - u2) * m1;
    }

    // Tables: F by integrating A (Simpson per interval, so F is exact to the
    // integrator, not to the interpolant), and the GR → c inverse by bisection.
    // Allocation-free (fixed arrays); runs once per instance, off the audio thread.
    void build() noexcept
    {
        h_ = kTableH;
        invH_ = 1.0 / h_;
        // v = −b: the stage gain at grid drive v is A(−v).
        auto gain = [](double v) { return VariMuTube::stageGain(-v); };
        constexpr int k0 = kKnotsBelowRest;   // the knot at v = 0
        double acc = 0.0;
        f_[0] = 0.0;
        a_[0] = gain(kTableLo);
        for (int k = 0; k < kTableN; ++k)
        {
            const double v0 = kTableLo + k * h_, v1 = v0 + h_;
            // Simpson on 8 sub-intervals: A has a √ corner only at the table's
            // low end (the cutoff), where the error still stays < 1e-12.
            constexpr int S = 8;
            const double hs = h_ / S;
            double sum = gain(v0) + gain(v1);
            for (int j = 1; j < S; ++j) sum += gain(v0 + j * hs) * (j % 2 ? 4.0 : 2.0);
            acc += sum * hs / 3.0;
            f_[k + 1] = acc;
            a_[k + 1] = gain(v1);
        }
        // Rest at F(0) = 0: the quiescent current is calibrated out.
        const double f0 = f_[k0];
        for (auto& f : f_) f -= f0;
        floorGain_ = VariMuTube::kFloor / VariMuTube::kRestGain;

        // GR → c: uniform in GR, Hermite with dc/dGR = 1/GR'(c).
        invStep_ = kInverseN / static_cast<double>(VariMuTube::kMaxGrDb);
        invStepDb_ = VariMuTube::kMaxGrDb / static_cast<double>(kInverseN);
        for (int j = 0; j <= kInverseN; ++j)
        {
            const double g = j * invStepDb_;
            double lo = 0.0, hi = VariMuTube::kCutoff;
            for (int it = 0; it < 60; ++it)
            {
                const double mid = 0.5 * (lo + hi);
                (grDbExact(mid) < g ? lo : hi) = mid;
            }
            const double c = 0.5 * (lo + hi);
            invC_[j] = c;
            const double slope = grSlopeExact(c);
            invD_[j] = slope > 1.0e-12 ? 1.0 / slope : 0.0;
        }
        invC_[0] = 0.0;
        invC_[kInverseN] = VariMuTube::kCutoff;
        invD_[kInverseN] = 0.0;
        built_ = true;
    }

    static double grDbExact(double c) noexcept { return -20.0 * std::log10(VariMuTube::stageGain(c)); }
    static double grSlopeExact(double c) noexcept
    {
        if (c >= VariMuTube::kCutoff) return 0.0;
        const double e = 1.0e-7;
        const double a = std::max(0.0, c - e), b = std::min(VariMuTube::kCutoff, c + e);
        return (grDbExact(b) - grDbExact(a)) / (b - a);
    }

    std::array<double, kTableN + 1>   f_ {};
    std::array<double, kTableN + 1>   a_ {};
    std::array<double, kInverseN + 1> invC_ {};
    std::array<double, kInverseN + 1> invD_ {};
    double h_ = 1.0, invH_ = 1.0, floorGain_ = 0.0;
    double invStep_ = 1.0, invStepDb_ = 1.0;
    double vin_ = kGridSwingAtThreshold, invVin_ = 1.0 / kGridSwingAtThreshold;
    float  smallSignalBelowDb_ = IdentityGC::kTurnOnDb - 3.0f;
    double upper_ = 1.0 + 0.5 * kMismatch, lower_ = 1.0 - 0.5 * kMismatch;
    bool   singleEnded_ = false;
    bool   built_ = false;
};

using VariMuCompressorCore =
    CompressorCore<RcRectifierT<PeakFit::Cosine>, IdentityGC, MultiRcBallistics, PushPullVariMu, TubeTransformerColor>;

// The line amp's headroom over the Opto's operating level: the 670's output
// stage is a mastering line amp run far below clipping, so its tube colour at
// nominal level is a few tenths of a percent, not the LA-2A's percent.
constexpr float kVariMuLineAmpHeadroomDb = 12.0f;

// The core's construction-time config: the unit's sidechain is flat (no HPF
// filter runs at all).
inline VariMuCompressorCore::Config variMuConfig() noexcept
{
    VariMuCompressorCore::Config c;
    c.sidechainHpf = false;
    return c;
}

// The unit's fixed wiring on a core (before prepare()): the in-core level of
// the rectifier's threshold bias (it sets the grid swing's scale), the line
// amp's headroom on both colour paths, and no colour switch. A template so a
// test can wire a variant core (another rectifier) the same way.
template <class CoreT = VariMuCompressorCore>
inline void wireVariMu(CoreT& core, float thresholdDb) noexcept
{
    core.gainElement().setThresholdDb(thresholdDb);
    core.colorStage(0).setHeadroomDb(kVariMuLineAmpHeadroomDb);
    core.colorStage(1).setHeadroomDb(kVariMuLineAmpHeadroomDb);
    core.setColorEnabled(true);
}

// Stepped settings for a Time Constant position (1..6). manualToTau is the §1.3
// normalisation; tests pass 1.0 for the un-normalised negative control.
inline VariMuCompressorCore::Settings variMuSettings(int position,
                                                     double manualToTau = Fairchild670::kManualToTau) noexcept
{
    const auto& p = Fairchild670::kPositions[static_cast<size_t>(std::clamp(position, 1, 6) - 1)];
    VariMuCompressorCore::Settings s;
    s.bal.attackS = static_cast<float>(p.attackMs * 0.001 * manualToTau);
    s.bal.branches = 0;
    for (int i = 0; i < MultiRcBallistics::kMaxBranches; ++i)
    {
        if (p.recoveryS[i] <= 0.0f) continue;
        s.bal.drainS[i] = static_cast<float>(p.recoveryS[i] * manualToTau);
        s.bal.chargeS[i] = static_cast<float>(Fairchild670::kSlowChargeS[i]);
        s.bal.branches = i + 1;
    }
    s.topology = Topology::TrackedFeedback;
    return s;
}

} // namespace xleth::comp

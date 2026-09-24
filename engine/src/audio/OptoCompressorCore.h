#pragma once

// ─── OptoCompressorCore — the LA-2A-lineage opto policies for CompressorCore ─
// docs/Compressor_Archetypes_Deep_Dive.md §3 (the opto archetype) and the
// OptoComp line of §9:
//
//   CompressorCore<OptoCellDetector, ProgramDependentGC, OptoMemoryBallistics,
//                  CdsDivider, TubeTransformerColor>
//
// A PHENOMENOLOGICAL state-space model of the T4 cell (§3.4), fit to the
// published behaviour of the unit, not to a schematic:
//
//   Stage A  EL panel     light target  L_t = k·max(0, u − 1)^p, u = drive/onset,
//                         with a soft threshold (p → 3 at the onset, see
//                         ProgramDependentGC), then a one-pole with τ_EL = 9 ms.
//                         The panel sets the attack.
//   Stage B  CdS cell     conductance target G_t = L^γ, split into a fast part
//                         (charges/discharges in tens of ms) and a slow part
//                         whose release τ_slow is stretched from 0.5 s to 15 s
//                         by h, a leaky integrator of light exposure. The cell
//                         sets the release and carries the memory.
//                         G = G_dark + G_fast + G_slow; the gain element is the
//                         divider R_CdS / (R_series + R_CdS) = 1 / (1 + G).
//   Stage C  feedback     the panel is driven from the GAIN-REDUCED signal: the
//                         core's tracked loop, solved implicitly per sample.
//   Stage D  colour       tube line stage + transformer (§8.4).
//
// Where each stage lives in the core's five slots:
//   Detector    OptoCellDetector      — the sidechain tap: full-wave, linked,
//                                       in dB (the EL panel lights on both
//                                       half-cycles, so there is no other
//                                       rectifier in the unit).
//   GC          ProgramDependentGC    — Stage A's static law + the sidechain
//                                       source (Compress/Limit), i.e. the light
//                                       the panel is being asked for. Its ρ is
//                                       LIGHT, not dB.
//   Ballistics  OptoMemoryBallistics  — Stage A's τ_EL and all of Stage B: the
//                                       state is (light, G_fast, G_slow, h);
//                                       its value() is the divider's GR in dB.
//   Element     CdsDivider            — the divider law (conductance ⇄ dB).
//   Color       TubeTransformerColor  — Stage D.
//
// There is no threshold and no ratio. Peak Reduction is sidechain GAIN: the
// core's per-sample "threshold" input carries −PeakReduction (dB), so the drive
// the panel sees is  level + PeakReduction  and compression begins where that
// crosses the EL onset (0 dBFS drive ⇒ at PR = 20 dB the knee starts at
// −20 dBFS). The static curve is NOT a textbook knee — it emerges from the
// panel's offset power law and the divider, and it is program dependent:
//   • a ~4 dB soft knee, then ~3:1 easing to ~2.7:1 at deep reduction in
//     Compress (2.9:1 averaged over 3–15 dB GR — UA's "≈3:1 average"); in
//     Limit ~3.4:1 at 4 dB of GR climbing past 7:1 at 18 dB;
//   • the panel integrates |x| over τ_EL, so the same peak level compresses a
//     dense (square-ish) signal harder than a peaky one (≈1.4 dB at −6 dBFS);
//   • the slow part of the cell only charges under sustained program, so a
//     short burst sees less reduction than the same level held.
//
// Fitting (Python prototype, then these constants — measured by
// test_opto_compressor at Peak Reduction 20 dB), against §3.3:
//   attack           4–9 ms to 63 % of the fast plateau, faster for bigger
//                    transients (UA: "about 10 ms on average");
//   release, first   50 % of the GR gone in 57–80 ms (UA: ~60 ms);
//   release, rest    to 1 dB: 0.2 s after a 100 ms burst, 1.6 s after 1 s,
//                    4.1 s after 10 s at ~8 dB GR — longer the heavier the
//                    reduction (UA: "1 to 15 seconds", program dependent);
//   Compress/Limit   2.9:1 vs 4.5:1 averaged over 3–15 dB GR.
// The §3.4 fitting procedure (100 ms / 1 s / 10 s bursts: longer bursts MUST
// give longer tails) is test_opto_compressor [3].
//
// Time constants are one-pole τ (63.2 %), the single definition in
// DspPrimitives.h, at the rate the core runs (the OVERSAMPLED rate).

#include "audio/CompressorCore.h"
#include "dsp/DspPrimitives.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>

namespace xleth::comp
{

// ─── T4 cell constants shared by the static curve and the ballistics ────────
struct T4Cell
{
    // CdS conductance vs illumination, G ∝ light^γ. Photoconductors sit at
    // γ ≈ 0.7–1 (R ∝ lux^−γ); 0.8 with the EL law below fits the ratio.
    static constexpr float kGamma = 0.8f;
    // Dark conductance, normalised to the series resistor: R_dark ≈ 1000·R_series,
    // so the unlit divider is transparent to 0.01 dB (and the rest level is
    // calibrated out: GR is exactly 0 dB in the dark).
    static constexpr float kDarkG = 1.0e-3f;
    // Floor on light for the γ power (keeps d(L^γ)/dL finite at L = 0).
    static constexpr float kLightFloor = 1.0e-9f;
};

// ─── Detector: the sidechain tap ────────────────────────────────────────────
// Full-wave, instantaneous, in dB (floored at −120). All smoothing is in the
// panel and the cell. Linked: one sidechain for both channels (a stereo LA-2A
// pair strapped for stereo, one T4 driving both gain elements' worth of light).
struct OptoCellDetector
{
    void prepare(double) noexcept {}
    void reset() noexcept {}

    float levelDb(float l, float r, StereoLink link) const noexcept
    {
        const float al = std::abs(l), ar = std::abs(r);
        const float v = (link == StereoLink::Sum) ? 0.5f * (al + ar) : std::max(al, ar);
        return dsp::gainToDb(v);
    }
};

// ─── Gain element: the CdS / series-resistor divider ────────────────────────
//   gain = R_CdS / (R_series + R_CdS) = 1 / (1 + G),  G = R_series / R_CdS
// GR is referred to the dark cell (the tube stage's fixed gain calibrates the
// unlit insertion loss out), so the dark divider reads exactly 0 dB.
struct CdsDivider
{
    // ln(1 + kDarkG) — a literal, not a function-local static (whose first-use
    // guard is a lock, and the first use may be on the audio thread).
    static constexpr float kDarkLog = 9.9950033308353e-4f;
    static_assert(T4Cell::kDarkG == 1.0e-3f, "kDarkLog is ln(1 + kDarkG)");

    static float grDb(float G) noexcept
    {
        return dsp::kDbPerNeper * (std::log1p(std::max(G, 0.0f)) - kDarkLog);
    }

    void prepare(double) noexcept {}
    void reset() noexcept {}
    float gainFor(float grDb) const noexcept { return dsp::dbToGain(-grDb); }
    float apply(float x, float g, int) const noexcept { return x * g; }
};

// ─── GC: Stage A's static law + the Compress/Limit sidechain source ─────────
// Returns the LIGHT the EL panel is driven toward (ρ ≥ 0, arbitrary units:
// light 1 ≈ 6 dB of reduction at equilibrium, ~300 ≈ 40 dB).
//
//   drive (dB)  = sidechain level + PeakReduction          (T = −PeakReduction)
//   u           = 10^((drive − onset)/20),  e = max(0, u − 1)
//   L_target    = k · e^p₀ / (1 + e/e_s)^(p₀ − p)     p₀ = 3, p = 1.25,
//                                                      e_s = 1, k = 5
//
// That is §3.4's k·max(0, v − v_on)^p with p = 1.25 above e_s, but with a
// SOFT THRESHOLD: the exponent rises to p₀ = 3 as the drive approaches the
// onset. DEVIATION from the doc's single p ≈ 1–2, made because the fit demanded
// it: with one exponent the closed loop has a corner at the onset (GR rises
// linearly out of it when p·γ = 1 — a hard knee, measured 0.8 slope change in
// a quarter dB), because the loop gain that makes ≈3:1 also pulls the output
// onto the onset. A real EL phosphor lights with exactly this kind of soft
// threshold (luminance ∝ exp(−b/√V), Alfrey–Taylor: a steep local exponent at
// low voltage that flattens as the drive rises), and it is what makes the
// knee ~4 dB wide (slope 0.95 → 0.45 over 3.75 dB of input, no step > 0.07
// per quarter dB).
//
// Compress: the sidechain is the output, pure feedback (§3.4 Stage C).
// Limit:    the switch opens and a resistor mixes the INPUT into the sidechain
//           — "a simple linear combination" of output and input (GroupDIY,
//           "Student looking for help understanding how the LA-2A works").
//           Both taps are the same polarity, so in dB
//             drive = L + PR + 20·log10( m + (1 − m)·10^(−B/20) )
//           which the core sees through reductionLoop(L, B). More light for
//           the same output ⇒ more reduction and a higher ratio. The resistor
//           ratio on the unit is 1/25, but the two taps sit at different levels
//           (the output tap is after tube gain); the EFFECTIVE mix m = 0.1 is
//           fitted to "limiting higher" (~4.5:1 over 3–15 dB GR vs ~2.9:1,
//           approaching flat at deep reduction).
//
// The constants are fitted TOGETHER with T4Cell::kGamma. The asymptotic
// open-loop GR slope is p·γ = 1 dB per dB of drive, which is what keeps the
// Limit mix monotone: any FF share with p·γ > 1 over-compresses (the output
// FALLS as the input rises) once the input tap dominates at deep reduction
// (m = 0.15 already does, at Peak Reduction 40). The feedback loop holds the
// drive just above onset, where the panel is steep, and that is where the
// ~3:1 comes from.
struct ProgramDependentGC
{
    static constexpr float kOnsetDb   = 0.0f;
    static constexpr float kP0        = 3.0f;    // exponent at the onset (soft threshold)
    static constexpr float kP         = 1.25f;   // exponent at high drive
    static constexpr float kKneeE     = 1.0f;    // e_s: where one hands over to the other
    static constexpr float kK         = 5.0f;
    static constexpr float kLimitMix  = 0.1f;

    // ρ is light, spanning decades — the core's Newton stops on a relative error.
    static constexpr float kLoopRelTolerance = 1.0e-5f;

    struct Params
    {
        float inputMix = 0.0f;   // 0 = Compress, kLimitMix = Limit
        bool operator==(const Params& o) const noexcept { return inputMix == o.inputMix; }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    // Panel light for a drive level (dB), and d(light)/d(drive dB).
    static float lightFor(float driveDb, float& dLight) noexcept
    {
        if (driveDb <= kOnsetDb) { dLight = 0.0f; return 0.0f; }   // unlit: no exp
        const float u = dsp::dbToGain(driveDb - kOnsetDb);
        const float e = u - 1.0f;
        if (e <= 0.0f) { dLight = 0.0f; return 0.0f; }
        static_assert(kP0 == 3.0f, "e^p0 is written as e*e*e");
        const float soft = std::pow(1.0f + e * (1.0f / kKneeE), kP - kP0);   // (1 + e/e_s)^(p − p₀)
        const float e2 = e * e;
        // dL/de = L·(p₀/e − (p₀ − p)/(e_s + e)), written without dividing by e.
        dLight = kK * e2 * soft * (kP0 - (kP0 - kP) * e / (kKneeE + e)) * u * dsp::kNeperPerDb;
        return kK * e2 * e * soft;
    }

    // Loop form (Compress and Limit): input level L, loop reduction B.
    static float reductionLoop(float L, float B, float T, const Params& p, float& slopeB) noexcept
    {
        const float m = p.inputMix;
        if (m <= 0.0f)
        {
            float d;
            const float t = lightFor(L - T - B, d);
            slopeB = d;             // ∂drive/∂B = −1
            return t;
        }
        const float g   = dsp::dbToGain(-B);
        const float mix = m + (1.0f - m) * g;
        float d;
        const float t = lightFor(L - T + dsp::gainToDb(mix), d);
        slopeB = d * (1.0f - m) * g / mix;   // −∂drive/∂B ∈ [0, 1)
        return t;
    }

    // Feedback form (reduced level only) — the Compress sidechain.
    static float reductionFB(float v, float T, const Params&, float& slope) noexcept
    {
        return lightFor(v - T, slope);
    }

    // Feedforward form: the panel driven by the raw input (not the unit —
    // present for the core's FF topology and as a test reference).
    static float reductionFF(float x, float T, const Params&, float& slope) noexcept
    {
        return lightFor(x - T, slope);
    }

    // Static (equilibrium) output level for a steady input level x: the GR
    // that the settled cell produces from the light its own output asks for,
    //   GR = divider( G_dark + light(x, GR)^γ ).
    // At rest both halves of the cell hold their share of G_t (they sum to 1),
    // so the ballistics' split does not move the equilibrium. Not RT (bisection).
    static float outputDb(float x, float T, const Params& p) noexcept
    {
        auto f = [&](float gr) {
            float s;
            const float light = reductionLoop(x, gr, T, p, s);
            const float G = T4Cell::kDarkG + std::pow(std::max(light, T4Cell::kLightFloor), T4Cell::kGamma);
            return gr - CdsDivider::grDb(G);
        };
        float lo = 0.0f, hi = 200.0f;
        if (f(lo) >= 0.0f) return x;
        for (int i = 0; i < 60; ++i)
        {
            const float mid = 0.5f * (lo + hi);
            (f(mid) < 0.0f ? lo : hi) = mid;
        }
        return x - 0.5f * (lo + hi);
    }
};

// ─── Ballistics: EL panel dynamics + the CdS cell's two-speed memory ────────
//
//   light   L  += (ρ − L)·b(τ_EL)                                   Stage A
//   G_t     = L^γ
//   G_fast  += (w_f·G_t − G_fast)·b(rising ? τ_fast_att : τ_fast_rel)
//   h       += (L − h)·b(τ_hist)            light exposure history
//   τ_slow  = lerp(τ_slow_min, τ_slow_max, clamp(h / h_ref, 0, 1))
//   G_slow  += (w_s·G_t − G_slow)·b(rising ? τ_slow_att : τ_slow)
//   GR      = divider(G_dark + G_fast + G_slow)
//
// The fast/slow split IS the defining behaviour (UA: ~60 ms for the first
// 50 % of the release, then 1–15 s for the rest, longer after longer / heavier
// program) — do not collapse it into one τ; test_opto_compressor [3] shows a
// single-τ model failing the burst test.
//
// predict() is side-effect free and nondecreasing in ρ (every stage is a
// convex combination whose branch switch is continuous), which is what the
// core's implicit loop solve needs. h is updated from the COMMITTED light, and
// τ_slow uses the pre-sample h, so it does not depend on ρ.
struct OptoMemoryBallistics
{
    struct Params
    {
        float elMs          = 9.0f;     // Stage A: EL panel
        float fastAttackMs  = 12.0f;    // CdS fast part
        float fastReleaseMs = 40.0f;
        float slowAttackMs  = 300.0f;   // CdS slow part (charges only under sustained light)
        float slowReleaseMinS = 0.5f;   // τ_slow at no light history …
        float slowReleaseMaxS = 15.0f;  // … and at full history
        float historyS      = 5.0f;     // τ_hist of the exposure integrator h
        float historyRef    = 4.0f;     // h_ref, light units (≈ 12 dB of GR held)
        float fastShare     = 0.75f;    // w_f; w_s = 1 − w_f

        bool operator==(const Params& o) const noexcept
        {
            return elMs == o.elMs && fastAttackMs == o.fastAttackMs && fastReleaseMs == o.fastReleaseMs
                && slowAttackMs == o.slowAttackMs && slowReleaseMinS == o.slowReleaseMinS
                && slowReleaseMaxS == o.slowReleaseMaxS && historyS == o.historyS
                && historyRef == o.historyRef && fastShare == o.fastShare;
        }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    struct Coeffs
    {
        // Per-sample steps b = 1 − pole (dsp::onePoleStep), not poles.
        float bEl = 1.0f, bFastAtt = 1.0f, bFastRel = 1.0f, bSlowAtt = 1.0f, bHist = 1.0f;
        float slowMinSamples = 1.0f, slowSpanSamples = 0.0f;   // τ_slow · fs
        float invHistRef = 1.0f;
        float wFast = 0.75f, wSlow = 0.25f;
    };

    // One sample of the cell for a given light target (what predict/commit share).
    struct Step { float light = 0.0f, gFast = 0.0f, gSlow = 0.0f, gr = 0.0f, d = 0.0f; };

    struct State
    {
        float light = 0.0f;   // EL panel output
        float gFast = 0.0f;   // CdS fast conductance
        float gSlow = 0.0f;   // CdS slow conductance
        float hist  = 0.0f;   // light exposure history h

        // Memo of the last step() evaluated from THIS state: the core's solve
        // ends on predict(ρ*) and then commits ρ*, so commit reuses it instead
        // of recomputing the cell (a pow and a log1p per sample). Invalidated
        // whenever the state or the coefficients change (commit, adopt).
        mutable float memoTarget = -1.0f;
        mutable Step  memo {};
    };

    static Coeffs makeCoeffs(const Params& p, double fs) noexcept
    {
        Coeffs c;
        c.bEl      = dsp::onePoleStep(p.elMs * 0.001, fs);
        c.bFastAtt = dsp::onePoleStep(p.fastAttackMs * 0.001, fs);
        c.bFastRel = dsp::onePoleStep(p.fastReleaseMs * 0.001, fs);
        c.bSlowAtt = dsp::onePoleStep(p.slowAttackMs * 0.001, fs);
        c.bHist    = dsp::onePoleStep(p.historyS, fs);
        c.slowMinSamples  = static_cast<float>(std::max(1.0, p.slowReleaseMinS * fs));
        c.slowSpanSamples = static_cast<float>(std::max(0.0, (p.slowReleaseMaxS - p.slowReleaseMinS) * fs));
        c.invHistRef = p.historyRef > 0.0f ? 1.0f / p.historyRef : 0.0f;
        c.wFast = std::clamp(p.fastShare, 0.0f, 1.0f);
        c.wSlow = 1.0f - c.wFast;
        return c;
    }

    // τ_slow in samples for a history h (tests and the release step).
    static float slowReleaseSamples(float h, const Coeffs& c) noexcept
    {
        return c.slowMinSamples + c.slowSpanSamples * std::clamp(h * c.invHistRef, 0.0f, 1.0f);
    }

    // b = −expm1(−1/n) by its series — n ≥ 0.5 s · fs ≫ 1, so x = 1/n < 1e-4 and
    // the x⁴/24 remainder is < 1e-17. A division per sample instead of an exp:
    // τ_slow moves every sample with h.
    static float slowReleaseStep(float h, const Coeffs& c) noexcept
    {
        const float n = slowReleaseSamples(h, c);
        if (n < 64.0f) return static_cast<float>(-std::expm1(-1.0 / n));
        const float x = 1.0f / n;
        return x * (1.0f - x * (0.5f - x * (1.0f / 6.0f)));
    }

    static float value(const State& s) noexcept
    {
        return CdsDivider::grDb(T4Cell::kDarkG + s.gFast + s.gSlow);
    }

    static Step step(const State& s, const Coeffs& c, float target) noexcept
    {
        Step o;
        if (target <= 0.0f && s.light == 0.0f && s.gFast == 0.0f && s.gSlow == 0.0f)
        {
            // Dark, fully released cell, no light asked for: nothing moves.
            // d is the slope out of the dark (γ·floor^(γ−1) at L = floor).
            o.light = o.gFast = o.gSlow = o.gr = 0.0f;
            o.d = dsp::kDbPerNeper / (1.0f + T4Cell::kDarkG) * (c.bFastAtt * c.wFast + c.bSlowAtt * c.wSlow)
                * T4Cell::kGamma * kDarkSlope * c.bEl;
            return o;
        }
        o.light = s.light + c.bEl * (std::max(target, 0.0f) - s.light);
        const float lq = std::max(o.light, T4Cell::kLightFloor);
        const float gt = std::pow(lq, T4Cell::kGamma);

        const float tf = c.wFast * gt;
        const float bf = tf > s.gFast ? c.bFastAtt : c.bFastRel;
        o.gFast = s.gFast + bf * (tf - s.gFast);

        const float ts = c.wSlow * gt;
        const float bs = ts > s.gSlow ? c.bSlowAtt : slowReleaseStep(s.hist, c);
        o.gSlow = s.gSlow + bs * (ts - s.gSlow);

        const float G = T4Cell::kDarkG + o.gFast + o.gSlow;
        o.gr = CdsDivider::grDb(G);
        // dGR/dρ = dGR/dG · (b_f·w_f + b_s·w_s) · γ·L^(γ−1) · b_EL
        o.d = dsp::kDbPerNeper / (1.0f + G) * (bf * c.wFast + bs * c.wSlow)
            * T4Cell::kGamma * (gt / lq) * c.bEl;
        return o;
    }

    static const Step& memoStep(const State& s, const Coeffs& c, float target) noexcept
    {
        if (target != s.memoTarget)
        {
            s.memo = step(s, c, target);
            s.memoTarget = target;
        }
        return s.memo;
    }

    static float predict(const State& s, const Coeffs& c, float target, float& d) noexcept
    {
        const Step& o = memoStep(s, c, target);
        d = o.d;
        return o.gr;
    }

    static void commit(State& s, const Coeffs& c, float target) noexcept
    {
        const Step o = memoStep(s, c, target);
        s.memoTarget = -1.0f;
        // Flush the release tails: they never decay into denormals, and a
        // released cell reaches the exact dark state (and step()'s fast path).
        // Thresholds are far below audibility: G 1e-7 ≈ 1e-6 dB of reduction,
        // light 1e-8 lights G ≈ 4e-7.
        s.light = o.light > kFlushLight ? o.light : 0.0f;
        s.gFast = o.gFast > kFlushG ? o.gFast : 0.0f;
        s.gSlow = o.gSlow > kFlushG ? o.gSlow : 0.0f;
        s.hist += c.bHist * (s.light - s.hist);
        if (s.hist < kFlushLight) s.hist = 0.0f;
    }

    static constexpr float kFlushLight = 1.0e-8f;
    static constexpr float kFlushG     = 1.0e-7f;
    // floor^(γ−1), the L^(γ−1) factor of d at the light floor: (1e-9)^(−0.2) = 10^1.8.
    static constexpr float kDarkSlope  = 63.0957344f;
    static_assert(T4Cell::kLightFloor == 1.0e-9f && T4Cell::kGamma == 0.8f, "kDarkSlope = kLightFloor^(kGamma-1)");

    // Both lanes of a Compress/Limit fade share one cell: nothing to fold. The
    // copied state's memo was computed with the other lane's coefficients.
    static void adopt(State& s, const Coeffs&) noexcept { s.memoTarget = -1.0f; }
};

// ─── Colour: tube line stage + output transformer (§8.4) ────────────────────
// Always in (the unit has no colour switch). Runs at the core's oversampled
// rate — the biased waveshaper's harmonics would alias at 1× (§5.4/§11).
//
//   tube        biased Padé-tanh, normalised to unity small-signal gain: an
//               asymmetric curve, so the 2nd harmonic leads (a 12AX7/12BH7/6AQ5
//               line amp), rising with level — and with Gain, which sits
//               before it like the unit's gain pot sits before the output stage.
//   transformer coupling high-pass (12 Hz, also the DC blocker for the biased
//               stage), level-dependent LF saturation (a soft clip of the band
//               below ~90 Hz only: core saturation is a low-frequency effect),
//               and a mild HF resonance (2nd-order low-pass, Q 0.85, at 26 kHz
//               or 0.45·fs: +0.4 dB at 15 kHz, the "30 Hz–15 kHz" unit's air).
struct TubeTransformerColor
{
    static constexpr float kTubeDrive = 0.5f;
    static constexpr float kTubeBias  = 0.2f;
    static constexpr float kCouplingHz = 12.0f;
    static constexpr float kLfSplitHz  = 90.0f;
    static constexpr float kLfDrive    = 0.35f;
    static constexpr float kHfHz       = 26000.0f;
    static constexpr float kHfQ        = 0.85f;

    void prepare(double fs) noexcept
    {
        const float z = kTubeDrive * kTubeBias;
        biasOut_ = dsp::softClipPade(z);
        // d/dx of Padé-tanh at the bias point: unity small-signal gain.
        const float n = z * (27.0f + z * z), dn = 27.0f + 3.0f * z * z;
        const float m = 27.0f + 9.0f * z * z, dm = 18.0f * z;
        const float slope = (dn * m - n * dm) / (m * m);
        invTubeGain_ = 1.0f / (kTubeDrive * slope);

        xfmr_.prepare(fs, { kCouplingHz, kLfSplitHz, kLfDrive, kHfHz, kHfQ });
    }

    void reset() noexcept { xfmr_.reset(); }

    // Channel-basis change (the core's Linked ⇄ MidSide switch): the tube stage
    // is memoryless, so only the transformer's states move.
    void remix(float m00, float m01, float m10, float m11) noexcept { xfmr_.remix(m00, m01, m10, m11); }

    // Operating level: the stage runs `db` below the signal and is made up
    // after the transformer — a line amp with that much more headroom at the
    // same nominal level. 0 dB (the default, the Opto) is bit-exact the plain
    // stage. Survives prepare()/reset().
    void setHeadroomDb(float db) noexcept
    {
        inScale_  = dsp::dbToGain(-db);
        outScale_ = 1.0f / inScale_;
    }

    float process(float x, int ch) noexcept
    {
        const float t = (dsp::softClipPade(kTubeDrive * (x * inScale_ + kTubeBias)) - biasOut_) * invTubeGain_;
        return xfmr_.process(t, ch) * outScale_;
    }

private:
    float biasOut_ = 0.0f;
    float invTubeGain_ = 1.0f;
    float inScale_ = 1.0f, outScale_ = 1.0f;
    dsp::OutputTransformer xfmr_ {};
};

using OptoCompressorCore =
    CompressorCore<OptoCellDetector, ProgramDependentGC, OptoMemoryBallistics, CdsDivider, TubeTransformerColor>;

} // namespace xleth::comp

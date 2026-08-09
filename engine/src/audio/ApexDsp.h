#pragma once

// ─── ApexDsp.h ───────────────────────────────────────────────────────────────
// Reusable DSP primitives for the APEX multiband maximizer (XlethApexEffect).
//
// Everything here is allocation-free and lock-free on the audio path; the only
// methods that may allocate are the explicitly-named prepare()/configure()
// helpers, which are main-thread only.
//
// Contents
//   Biquad / BiquadCoeffs   — TDF-II biquad + RBJ LP/HP designers
//   LrSplit                 — Linkwitz-Riley crossover, LR2 (12 dB/oct) or LR4
//                             (24 dB/oct), selectable per split.  Guarantees
//                             lo + hi == allpass(in) for BOTH orders.
//   HighPass24              — 24 dB/oct Butterworth HPF (the LOW CUT stage)
//   CurveNode / CurveLut    — node+tension dynamics curve and its compiled
//                             1024-entry dB -> linear-gain lookup table
//   EnvelopeFollower        — branching attack/release with SUSTAIN hold,
//                             PEAK or RMS detection
//   Saturator2x             — 2x oversampled waveshaper (polyphase half-band
//                             FIR up/down) with bipolar mode A / mode B
//   FixedDelay              — integer stereo delay used to keep non-saturating
//                             lanes aligned with saturating ones
//   LookaheadRing           — shared, pre-allocated, fractional multi-lane
//                             delay used by LOW/MID/HIGH and the BAND MIX dry
//                             path so both legs are always sample-aligned
//   BlockRamp               — per-block linear parameter ramp (no zipper, no
//                             transcendental per sample)

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace xleth_apex {

// ─── Constants ───────────────────────────────────────────────────────────────

// Dynamics curve: node axes and compiled LUT resolution.
inline constexpr int   kMaxCurveNodes = 32;
inline constexpr int   kLutSize       = 1024;
inline constexpr float kCurveMinDb    = -24.0f;
inline constexpr float kCurveMaxDb    =  12.0f;

// Half-band FIR used by the 2x oversampled waveshaper.
//
// Length is chosen as 4k+3 (95 = 4*23+3) so that the *round trip*
// (interpolate -> shape -> decimate) has a latency of exactly
// (kHalfBandLen - 1) / 2 = 47 samples at the BASE rate — an integer, which is
// what makes the effect's reported latency exact.  A polyphase IIR half-band
// would be cheaper but its group delay is fractional and frequency-dependent,
// which would make the LOOKAHEAD latency contract unprovable.
inline constexpr int kHalfBandLen      = 95;
inline constexpr int kOsLatencySamples = (kHalfBandLen - 1) / 2;   // 47
inline constexpr int kHalfBandEvenTaps = (kHalfBandLen + 1) / 2;   // 48

// Band indices.
enum BandIndex { kLow = 0, kMid = 1, kHigh = 2, kMaster = 3, kNumBands = 4 };

// 4-state band switch (see design spec section 3).
enum class BandState
{
    On      = 0,   // full chain
    CompOff = 1,   // dynamics bypassed; gains / saturation / separation active
    Muted   = 2,   // band silenced
    Off     = 3,   // band bypassed dry, its DSP skipped entirely
};

inline BandState bandStateFromFloat(float v) noexcept
{
    const int i = static_cast<int>(std::lround(v));
    return static_cast<BandState>(std::clamp(i, 0, 3));
}

inline float dbToGain(float db) noexcept { return std::pow(10.0f, db * 0.05f); }

inline float gainToDb(float g) noexcept
{
    return 20.0f * std::log10(std::max(g, 1.0e-9f));
}

// ─── Biquad ──────────────────────────────────────────────────────────────────

struct BiquadCoeffs
{
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
};

// Transposed Direct Form II.  Two state words, one multiply-add chain.
struct BiquadState
{
    float z1 = 0.0f, z2 = 0.0f;

    void reset() noexcept { z1 = z2 = 0.0f; }

    inline float process(float x, const BiquadCoeffs& c) noexcept
    {
        const float y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        return y;
    }
};

// RBJ cookbook low-pass.  Q = 0.5 gives a critically-damped (LR2) section;
// Q = 1/sqrt(2) gives a 2nd-order Butterworth (one half of an LR4).
inline BiquadCoeffs designLowpass(double freqHz, double sampleRate, double q) noexcept
{
    const double f  = std::clamp(freqHz, 10.0, sampleRate * 0.45);
    const double w0 = 2.0 * 3.14159265358979323846 * f / sampleRate;
    const double cw = std::cos(w0);
    const double sw = std::sin(w0);
    const double al = sw / (2.0 * q);
    const double a0 = 1.0 + al;

    BiquadCoeffs c;
    c.b0 = static_cast<float>(((1.0 - cw) * 0.5) / a0);
    c.b1 = static_cast<float>((1.0 - cw) / a0);
    c.b2 = c.b0;
    c.a1 = static_cast<float>((-2.0 * cw) / a0);
    c.a2 = static_cast<float>((1.0 - al) / a0);
    return c;
}

inline BiquadCoeffs designHighpass(double freqHz, double sampleRate, double q) noexcept
{
    const double f  = std::clamp(freqHz, 10.0, sampleRate * 0.45);
    const double w0 = 2.0 * 3.14159265358979323846 * f / sampleRate;
    const double cw = std::cos(w0);
    const double sw = std::sin(w0);
    const double al = sw / (2.0 * q);
    const double a0 = 1.0 + al;

    BiquadCoeffs c;
    c.b0 = static_cast<float>(((1.0 + cw) * 0.5) / a0);
    c.b1 = static_cast<float>((-(1.0 + cw)) / a0);
    c.b2 = c.b0;
    c.a1 = static_cast<float>((-2.0 * cw) / a0);
    c.a2 = static_cast<float>((1.0 - al) / a0);
    return c;
}

// ─── LrSplit — Linkwitz-Riley crossover ──────────────────────────────────────
//
// Magnitude-flat reconstruction is a hard requirement of the design, so this
// class is written so that
//
//     lo + hi  ==  allpass(in)                                (exactly)
//
// holds for BOTH supported orders, and the caller never has to remember a
// polarity rule:
//
//   LR2 (12 dB/oct) = squared 1st-order Butterworth.  In the analogue
//       prototype LP(s) = 1/(s+1)^2, HP(s) = s^2/(s+1)^2, and
//           LP - HP = (1-s)/(1+s)  -> 1st-order allpass.
//       LP + HP has a NULL at the crossover, so this class returns the HIGH
//       output already inverted.  Summing then works without a sign rule.
//
//   LR4 (24 dB/oct) = two cascaded 2nd-order Butterworth.
//           LP + HP = (s^2 - sqrt2 s + 1)/(s^2 + sqrt2 s + 1) -> 2nd-order
//       allpass.  No inversion needed.
//
// For a 3-band tree the LOW band must additionally be passed through the
// allpass of the SECOND split.  Rather than deriving those allpass coefficients
// separately (and risking a mismatch with the split actually in use), the
// caller runs a second LrSplit instance configured identically to split 2 over
// the low band and sums its two outputs — the allpass is then correct by
// construction for either order.  See XlethApexEffect::splitBands().
class LrSplit
{
public:
    // Main thread (or block-rate on the audio thread — no allocation).
    void configure(double freqHz, double sampleRate, int order) noexcept
    {
        if (order >= 4)
        {
            stages_ = 2;
            sign_   = 1.0f;
            const double q = 0.70710678118654752440;   // Butterworth
            lpC_[0] = lpC_[1] = designLowpass (freqHz, sampleRate, q);
            hpC_[0] = hpC_[1] = designHighpass(freqHz, sampleRate, q);
        }
        else
        {
            stages_ = 1;
            sign_   = -1.0f;                            // LP - HP is the allpass
            lpC_[0] = designLowpass (freqHz, sampleRate, 0.5);
            hpC_[0] = designHighpass(freqHz, sampleRate, 0.5);
        }
    }

    void reset() noexcept
    {
        for (auto& stage : lpS_) for (auto& ch : stage) ch.reset();
        for (auto& stage : hpS_) for (auto& ch : stage) ch.reset();
    }

    inline void process(int ch, float x, float& lo, float& hi) noexcept
    {
        float l = x;
        float h = x;
        for (int s = 0; s < stages_; ++s)
        {
            l = lpS_[s][ch].process(l, lpC_[s]);
            h = hpS_[s][ch].process(h, hpC_[s]);
        }
        lo = l;
        hi = sign_ * h;
    }

private:
    BiquadCoeffs lpC_[2] {}, hpC_[2] {};
    BiquadState  lpS_[2][2] {}, hpS_[2][2] {};   // [stage][channel]
    int   stages_ = 2;
    float sign_   = 1.0f;
};

// ─── HighPass24 — the LOW CUT stage ──────────────────────────────────────────
// 24 dB/oct Butterworth high-pass (two cascaded 2nd-order Q=1/sqrt(2) sections).
// Bypassed exactly (bit-transparent) when the cutoff is at or below 0 Hz.
class HighPass24
{
public:
    void configure(double freqHz, double sampleRate) noexcept
    {
        active_ = freqHz > 0.5;
        if (!active_) return;
        const double q = 0.70710678118654752440;
        c_[0] = c_[1] = designHighpass(freqHz, sampleRate, q);
    }

    void reset() noexcept
    {
        for (auto& stage : s_) for (auto& ch : stage) ch.reset();
    }

    bool isActive() const noexcept { return active_; }

    inline float process(int ch, float x) noexcept
    {
        if (!active_) return x;
        float y = x;
        for (int s = 0; s < 2; ++s)
            y = s_[s][ch].process(y, c_[s]);
        return y;
    }

private:
    BiquadCoeffs c_[2] {};
    BiquadState  s_[2][2] {};
    bool active_ = false;
};

// ─── Dynamics curve ──────────────────────────────────────────────────────────

// One editor node.  Both axes are dB in [kCurveMinDb, kCurveMaxDb].
struct CurveNode
{
    float inDb  = 0.0f;
    float outDb = 0.0f;
};

// The compiled curve: 1024 entries of LINEAR gain, indexed by input level in dB
// over [kCurveMinDb, kCurveMaxDb].  Storing linear gain (not gain in dB) is what
// keeps the audio callback free of pow() — it only ever interpolates two floats.
struct CurveLut
{
    std::array<float, kLutSize> gainLin {};

    // Audio thread.  `db` is the detected level in dB; values outside the
    // authored domain hold the endpoint GAIN (not the endpoint output level),
    // so silence is never amplified and hot signal never gains extra makeup.
    inline float lookup(float db) const noexcept
    {
        constexpr float scale = static_cast<float>(kLutSize - 1)
                              / (kCurveMaxDb - kCurveMinDb);
        float pos = (db - kCurveMinDb) * scale;
        if (pos <= 0.0f)                  return gainLin[0];
        if (pos >= float(kLutSize - 1))   return gainLin[kLutSize - 1];
        const int   i0 = static_cast<int>(pos);
        const float f  = pos - static_cast<float>(i0);
        return gainLin[i0] + f * (gainLin[i0 + 1] - gainLin[i0]);
    }
};

// Per-segment tension warp.  t is the normalised position inside the segment
// (0..1); tension -1..+1 with 0 == linear.  The warp is monotone and pinned at
// both ends, so the compiled curve is always continuous and single-valued.
//
//   tension  0  -> w(t) = t          (straight segment)
//   tension +1  -> w(t) = t^0.25     (bulges up: fast rise then flat — soft knee)
//   tension -1  -> w(t) = t^4        (bulges down: flat then fast rise — hard knee)
inline float tensionWarp(float t, float tension) noexcept
{
    if (tension > -1.0e-4f && tension < 1.0e-4f) return t;
    const float p = std::pow(4.0f, -std::clamp(tension, -1.0f, 1.0f));
    return std::pow(std::clamp(t, 0.0f, 1.0f), p);
}

// Compile nodes + per-segment tensions into a gain LUT.
//
// MAIN THREAD ONLY — uses pow() heavily.  The caller publishes the finished
// table to the audio thread by atomic pointer swap; the audio thread never
// touches this function.
//
// `tensions` has (count - 1) entries (one per segment); a null pointer or a
// short array is treated as all-zero (linear).
inline void buildCurveLut(const CurveNode* nodes,
                          int              count,
                          const float*     tensions,
                          int              tensionCount,
                          CurveLut&        out) noexcept
{
    // Degenerate input -> unity curve.
    if (nodes == nullptr || count < 2)
    {
        out.gainLin.fill(1.0f);
        return;
    }

    count = std::min(count, kMaxCurveNodes);

    constexpr float span = kCurveMaxDb - kCurveMinDb;
    constexpr float step = span / static_cast<float>(kLutSize - 1);

    int seg = 0;
    for (int i = 0; i < kLutSize; ++i)
    {
        const float inDb = kCurveMinDb + step * static_cast<float>(i);

        // Advance to the segment containing inDb (nodes are pre-sorted by IN).
        while (seg < count - 2 && inDb > nodes[seg + 1].inDb)
            ++seg;

        float outDb;
        if (inDb <= nodes[0].inDb)
        {
            // Below the first node: hold the first node's GAIN.
            outDb = inDb + (nodes[0].outDb - nodes[0].inDb);
        }
        else if (inDb >= nodes[count - 1].inDb)
        {
            // Above the last node: hold the last node's GAIN (unity slope).
            outDb = inDb + (nodes[count - 1].outDb - nodes[count - 1].inDb);
        }
        else
        {
            const CurveNode& a = nodes[seg];
            const CurveNode& b = nodes[seg + 1];
            const float      w = b.inDb - a.inDb;
            const float      t = (w > 1.0e-6f) ? (inDb - a.inDb) / w : 0.0f;
            const float tension = (tensions != nullptr && seg < tensionCount)
                                ? tensions[seg] : 0.0f;
            outDb = a.outDb + (b.outDb - a.outDb) * tensionWarp(t, tension);
        }

        // Store LINEAR gain = 10^((out - in)/20).
        out.gainLin[static_cast<std::size_t>(i)] = dbToGain(outDb - inDb);
    }
}

// The default (unity / flat) curve: two nodes pinning the ends, no tension.
inline void makeUnityCurve(std::vector<CurveNode>& nodes, std::vector<float>& tensions)
{
    nodes.clear();
    nodes.push_back({ kCurveMinDb, kCurveMinDb });
    nodes.push_back({ kCurveMaxDb, kCurveMaxDb });
    tensions.assign(1, 0.0f);
}

// ─── EnvelopeFollower ────────────────────────────────────────────────────────
// Branching attack/release smoother with a SUSTAIN hold stage.
//
//   rising  -> attack coefficient, hold counter re-armed
//   falling -> hold counter is spent first (envelope frozen), then release
//
// RMS mode runs a fixed 10 ms mean-square pre-stage so PEAK and RMS are
// genuinely different detectors rather than the same detector with different
// ballistics.
struct EnvelopeFollower
{
    float env    = 0.0f;   // linear envelope
    float meanSq = 0.0f;   // RMS pre-stage state
    int   hold   = 0;

    void reset() noexcept { env = 0.0f; meanSq = 0.0f; hold = 0; }

    // `x` is the instantaneous stereo-linked level:
    //   PEAK mode -> max(|L|, |R|)
    //   RMS  mode -> caller passes rms(l, r) computed via rmsLevel() below.
    inline float process(float x, float aCoef, float rCoef, int holdSamples) noexcept
    {
        if (x > env)
        {
            env += aCoef * (x - env);
            hold = holdSamples;
        }
        else if (hold > 0)
        {
            --hold;                       // SUSTAIN: freeze before releasing
        }
        else
        {
            env += rCoef * (x - env);
        }
        return env;
    }

    // Fixed-window mean-square pre-stage for RMS detection.
    inline float rmsLevel(float l, float r, float msCoef) noexcept
    {
        const float sq = 0.5f * (l * l + r * r);
        meanSq += msCoef * (sq - meanSq);
        return std::sqrt(std::max(meanSq, 0.0f));
    }
};

// One-pole coefficient for a time constant in milliseconds.
inline float onePoleCoeff(float ms, double sampleRate) noexcept
{
    const float tau = std::max(ms, 0.001f) * 0.001f * static_cast<float>(sampleRate);
    return 1.0f - std::exp(-1.0f / std::max(tau, 1.0e-6f));
}

// ─── Saturation shapers ──────────────────────────────────────────────────────
//
// Both shapers have unity slope at the origin and saturate at +/-1, so the CEIL
// knob alone decides the onset level and the THRESH knob alone decides how much
// shaping is applied.  Only the KNEE differs:
//
//   mode A (THRESH < 0) — tanh: gentle, mostly 3rd/5th harmonic
//   mode B (THRESH > 0) — u / (1 + u^4)^(1/4): stays linear longer then turns
//                         much harder, producing markedly richer high-order
//                         harmonics.  Still C-infinity, so 2x oversampling is
//                         enough to keep the aliasing products buried.

// 7th-order Pade approximation of tanh.  Monotone and accurate to ~1e-6 over
// the clamped domain; the final clamp keeps the output inside +/-1 exactly.
inline float fastTanh(float x) noexcept
{
    const float xc = std::clamp(x, -5.0f, 5.0f);
    const float x2 = xc * xc;
    const float n  = xc * (135135.0f + x2 * (17325.0f + x2 * (378.0f + x2)));
    const float d  = 135135.0f + x2 * (62370.0f + x2 * (3150.0f + x2 * 28.0f));
    return std::clamp(n / d, -1.0f, 1.0f);
}

inline float shapeHard(float u) noexcept
{
    const float u2 = u * u;
    const float u4 = u2 * u2;
    return u / std::sqrt(std::sqrt(1.0f + u4));
}

// Pre-computed per block; the audio thread only reads it.
struct SatConfig
{
    float ceilLin = 1.0f;
    float invCeil = 1.0f;
    float amount  = 0.0f;   // 0..1, |THRESH| / 100
    bool  modeB   = false;  // THRESH > 0

    void set(float threshPercent, float ceilDb) noexcept
    {
        ceilLin = dbToGain(std::clamp(ceilDb, -60.0f, 0.0f));
        invCeil = 1.0f / std::max(ceilLin, 1.0e-6f);
        amount  = std::clamp(std::abs(threshPercent) * 0.01f, 0.0f, 1.0f);
        modeB   = threshPercent > 0.0f;
    }

    inline float shape(float x) const noexcept
    {
        const float u = x * invCeil;
        const float s = modeB ? shapeHard(u) : fastTanh(u);
        return ceilLin * (u + amount * (s - u));
    }
};

// ─── Half-band FIR taps ──────────────────────────────────────────────────────
//
// Kaiser-windowed half-band low-pass, length kHalfBandLen, cutoff at fs/4 of the
// oversampled rate.  Only the EVEN-index taps are stored (index j holds h[2j]);
// the centre tap is exactly 0.5 and every remaining tap is zero, which is what
// makes the polyphase decomposition below almost free.
//
// beta = 7.86 targets ~-80 dB stopband, giving a flat passband to roughly
// 0.89 x base-Nyquist and >= 80 dB rejection of everything that could fold.
inline const std::array<float, kHalfBandEvenTaps>& halfBandTaps()
{
    static const std::array<float, kHalfBandEvenTaps> taps = []
    {
        constexpr double pi   = 3.14159265358979323846;
        constexpr double beta = 7.86;
        constexpr int    M    = kOsLatencySamples;   // 47 — half the FIR span

        auto besselI0 = [](double x)
        {
            double sum = 1.0, term = 1.0;
            for (int k = 1; k < 40; ++k)
            {
                term *= (x * 0.5) * (x * 0.5) / (double(k) * double(k));
                sum  += term;
                if (term < 1e-18 * sum) break;
            }
            return sum;
        };

        const double i0beta = besselI0(beta);

        std::array<double, kHalfBandEvenTaps> h {};
        double sum = 0.0;
        for (int j = 0; j < kHalfBandEvenTaps; ++j)
        {
            const int n = 2 * j - M;            // odd offset from the centre tap
            const double ideal  = std::sin(pi * n * 0.5) / (pi * double(n));
            const double ratio  = double(n) / double(M);
            const double window = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - ratio * ratio)))
                                / i0beta;
            h[static_cast<std::size_t>(j)] = ideal * window;
            sum += h[static_cast<std::size_t>(j)];
        }

        // Normalise so the even taps sum to exactly 0.5.  Together with the 0.5
        // centre tap this gives the filter unity DC gain, hence an exactly
        // unity-gain round trip through the oversampler.
        const double norm = 0.5 / sum;

        std::array<float, kHalfBandEvenTaps> out {};
        for (int j = 0; j < kHalfBandEvenTaps; ++j)
            out[static_cast<std::size_t>(j)] =
                static_cast<float>(h[static_cast<std::size_t>(j)] * norm);
        return out;
    }();
    return taps;
}

// ─── Saturator2x ─────────────────────────────────────────────────────────────
//
// 2x oversampled waveshaper.  ONLY the waveshaper is oversampled — everything
// else in the band chain runs at the base rate, exactly as the spec requires.
//
// Polyphase structure (h = half-band FIR, g[j] = h[2j], centre tap = 0.5):
//
//   interpolate   even output : y0[n] = 2 * SUM g[j] x[n-j]
//                 odd  output : y1[n] = x[n-23]          (pure delay!)
//   shape         s0 = f(y0),  s1 = f(y1)
//   decimate      z[n] = SUM g[j] s0[n-j] + 0.5 * s1[n-24]
//
// Both paths carry exactly kHalfBandLen-1 = 94 oversampled samples of delay,
// i.e. exactly kOsLatencySamples = 47 base-rate samples.  That integer is what
// the effect adds to its reported latency, and FixedDelay below reproduces it
// bit-for-bit for lanes that are not being saturated, so no band can ever drift
// out of alignment with another.
class Saturator2x
{
public:
    void reset() noexcept
    {
        for (auto& ch : ch_) ch.reset();
    }

    // Audio thread, in place.  `cfg` is snapshotted per block.
    void processBlock(float* const* channels, int numChannels, int numSamples,
                      const SatConfig& cfg) noexcept
    {
        const auto& g = halfBandTaps();
        const int   n = std::min(numChannels, 2);

        for (int c = 0; c < n; ++c)
        {
            State& st = ch_[static_cast<std::size_t>(c)];
            float* data = channels[c];

            for (int s = 0; s < numSamples; ++s)
            {
                st.x[st.xPos] = data[s];

                // --- interpolate ------------------------------------------------
                float acc = 0.0f;
                for (int j = 0; j < kHalfBandEvenTaps / 2; ++j)
                {
                    const float a = st.x[(st.xPos - j) & kXMask];
                    const float b = st.x[(st.xPos - (kHalfBandEvenTaps - 1 - j)) & kXMask];
                    acc += g[static_cast<std::size_t>(j)] * (a + b);
                }
                const float up0 = 2.0f * acc;
                const float up1 = st.x[(st.xPos - (kHalfBandEvenTaps / 2 - 1)) & kXMask];

                // --- shape ------------------------------------------------------
                st.e[st.ePos] = cfg.shape(up0);
                st.o[st.oPos] = cfg.shape(up1);

                // --- decimate ---------------------------------------------------
                float acc2 = 0.0f;
                for (int j = 0; j < kHalfBandEvenTaps / 2; ++j)
                {
                    const float a = st.e[(st.ePos - j) & kEMask];
                    const float b = st.e[(st.ePos - (kHalfBandEvenTaps - 1 - j)) & kEMask];
                    acc2 += g[static_cast<std::size_t>(j)] * (a + b);
                }
                data[s] = acc2 + 0.5f * st.o[(st.oPos - kHalfBandEvenTaps / 2) & kOMask];

                st.xPos = (st.xPos + 1) & kXMask;
                st.ePos = (st.ePos + 1) & kEMask;
                st.oPos = (st.oPos + 1) & kOMask;
            }
        }
    }

private:
    static constexpr int kXMask = 63;   // >= kHalfBandEvenTaps (48)
    static constexpr int kEMask = 63;
    static constexpr int kOMask = 31;   // >= kHalfBandEvenTaps/2 + 1 (25)

    struct State
    {
        std::array<float, kXMask + 1> x {};
        std::array<float, kEMask + 1> e {};
        std::array<float, kOMask + 1> o {};
        int xPos = 0, ePos = 0, oPos = 0;

        void reset() noexcept
        {
            x.fill(0.0f); e.fill(0.0f); o.fill(0.0f);
            xPos = ePos = oPos = 0;
        }
    };

    std::array<State, 2> ch_ {};
};

// ─── FixedDelay ──────────────────────────────────────────────────────────────
// Integer stereo delay.  Used to give lanes that are NOT being saturated the
// exact same latency as lanes that are, so the band sum and the BAND MIX dry
// path stay sample-aligned regardless of which bands have saturation engaged.
//
// A delay of 0 is a true bypass (bit-transparent, no read/write at all), which
// is what lets an OFF band be bit-identical to its raw crossover output.
class FixedDelay
{
public:
    // Main thread.  Allocates.
    void prepare(int maxDelaySamples)
    {
        size_ = 1;
        while (size_ < maxDelaySamples + 2) size_ <<= 1;
        mask_ = size_ - 1;
        for (auto& ch : buf_) ch.assign(static_cast<std::size_t>(size_), 0.0f);
        pos_ = 0;
    }

    void reset() noexcept
    {
        for (auto& ch : buf_) std::fill(ch.begin(), ch.end(), 0.0f);
        pos_ = 0;
    }

    void setDelay(int samples) noexcept { delay_ = std::max(0, samples); }

    void processBlock(float* const* channels, int numChannels, int numSamples) noexcept
    {
        if (delay_ <= 0 || size_ == 0) return;

        const int n = std::min(numChannels, 2);
        int startPos = pos_;
        for (int c = 0; c < n; ++c)
        {
            auto& ring = buf_[static_cast<std::size_t>(c)];
            float* data = channels[c];
            int p = startPos;
            for (int s = 0; s < numSamples; ++s)
            {
                ring[static_cast<std::size_t>(p)] = data[s];
                data[s] = ring[static_cast<std::size_t>((p - delay_) & mask_)];
                p = (p + 1) & mask_;
            }
        }
        pos_ = (startPos + numSamples) & mask_;
    }

private:
    std::array<std::vector<float>, 2> buf_ {};
    int size_ = 0, mask_ = 0, pos_ = 0, delay_ = 0;
};

// ─── LookaheadRing ───────────────────────────────────────────────────────────
//
// One pre-allocated multi-lane delay shared by LOW / MID / HIGH and the BAND MIX
// dry path.  All lanes share a single write position and a single (smoothed)
// delay value, which is precisely what guarantees the dry leg of BAND MIX is
// sample-aligned with the band legs at every instant — including while the
// LOOKAHEAD knob is moving.
//
// Delay changes are ramped (default 100 ms full-scale) with fractional
// interpolation, so there is no zipper noise and no reallocation.  When the
// ramp has settled on an integer target the fractional part is exactly zero and
// the read is bit-transparent.
class LookaheadRing
{
public:
    static constexpr int kMaxLanes = 4;   // low, mid, high, dry

    // Main thread.  Allocates.
    void prepare(int maxDelaySamples, double sampleRate)
    {
        size_ = 1;
        while (size_ < maxDelaySamples + 8) size_ <<= 1;
        mask_ = size_ - 1;
        for (auto& lane : buf_)
            for (auto& ch : lane)
                ch.assign(static_cast<std::size_t>(size_), 0.0f);
        pos_ = 0;
        // Full-scale (0 -> max) delay change takes ~100 ms.
        rampPerSample_ = static_cast<float>(maxDelaySamples)
                       / std::max(1.0f, static_cast<float>(sampleRate * 0.1));
        cur_ = target_ = 0.0f;
    }

    void reset() noexcept
    {
        for (auto& lane : buf_)
            for (auto& ch : lane)
                std::fill(ch.begin(), ch.end(), 0.0f);
        pos_ = 0;
        cur_ = target_;
    }

    void setTargetDelay(float samples) noexcept
    {
        target_ = std::max(0.0f, samples);
    }

    // Snap without ramping (prepare / transport reset).
    void snapDelay(float samples) noexcept
    {
        target_ = cur_ = std::max(0.0f, samples);
    }

    float currentDelay() const noexcept { return cur_; }

    // Audio thread.  `laneChannels` is a FLAT, lane-major array of
    // numLanes * numChannels writable pointers: laneChannels[l * numChannels + c].
    // Every lane is delayed in place by the same shared, ramped amount — that
    // shared value is what makes the dry leg of BAND MIX provably aligned with
    // the band legs.
    void processBlock(float* const* laneChannels, int numLanes, int numChannels,
                      int numSamples) noexcept
    {
        if (size_ == 0) return;

        const int nl = std::min(numLanes, kMaxLanes);
        const int nc = std::min(numChannels, 2);

        int p = pos_;
        float d = cur_;

        for (int s = 0; s < numSamples; ++s)
        {
            // Ramp the shared delay one step toward the target.
            if (d < target_)      d = std::min(d + rampPerSample_, target_);
            else if (d > target_) d = std::max(d - rampPerSample_, target_);
            if (std::abs(d - target_) < 1.0e-4f) d = target_;   // snap: exact reads

            const int   di   = static_cast<int>(d);
            const float frac = d - static_cast<float>(di);
            const int   i0   = (p - di) & mask_;
            const int   i1   = (i0 - 1) & mask_;

            for (int l = 0; l < nl; ++l)
            {
                for (int c = 0; c < nc; ++c)
                {
                    auto& ring = buf_[static_cast<std::size_t>(l)][static_cast<std::size_t>(c)];
                    float* data = laneChannels[l * numChannels + c];
                    ring[static_cast<std::size_t>(p)] = data[s];
                    const float a = ring[static_cast<std::size_t>(i0)];
                    const float b = ring[static_cast<std::size_t>(i1)];
                    data[s] = (frac == 0.0f) ? a : (a + frac * (b - a));
                }
            }

            p = (p + 1) & mask_;
        }

        pos_ = p;
        cur_ = d;
    }

private:
    std::array<std::array<std::vector<float>, 2>, kMaxLanes> buf_ {};
    int   size_ = 0, mask_ = 0, pos_ = 0;
    float cur_ = 0.0f, target_ = 0.0f, rampPerSample_ = 1.0f;
};

// ─── BlockRamp ───────────────────────────────────────────────────────────────
// Linear parameter ramp that reaches its target at the end of the current
// block.  APEX has ~50 continuous parameters; running them all through the base
// class's per-sample SmoothedValue machinery would mean a transcendental
// (dB -> linear) per parameter per sample.  Instead the expensive conversion
// happens once per block and only the RESULT is interpolated — the same trick
// XlethOTTEffect uses for its input/output gain, generalised.
struct BlockRamp
{
    float cur = 1.0f, step = 0.0f, target = 1.0f;

    void snap(float v) noexcept { cur = target = v; step = 0.0f; }

    void setTarget(float t, int numSamples) noexcept
    {
        target = t;
        step   = (numSamples > 0) ? (t - cur) / static_cast<float>(numSamples) : 0.0f;
    }

    inline float next() noexcept { cur += step; return cur; }

    // Kill accumulated float drift at the end of the block.
    void finish() noexcept { cur = target; step = 0.0f; }

    // True when the ramp is parked exactly on a value (lets callers take a
    // bit-transparent fast path).
    bool isStatic(float v) const noexcept { return cur == v && target == v; }
};

} // namespace xleth_apex

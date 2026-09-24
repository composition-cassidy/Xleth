#pragma once

// ─── DspPrimitives.h — shared realtime DSP building blocks ──────────────────
// The promoted, shared home for small per-sample primitives that more than one
// effect needs (docs/Compressor_Archetypes_Deep_Dive.md §9, "Shared DSP
// primitives"). Everything here is header-only, allocation-free after
// prepare(), lock-free and log-free, so any of it may run on the audio thread.
//
// What lives here, and the ONE convention each follows:
//
//   Level conversion   gainToDb() clamps at kDbFloor (-120 dB) so silence never
//                      produces -inf (§11 "log(0)").
//   OnePole            y += b(x-y), b = 1 - exp(-1/(tau*fs)). tau is the 63.2 %
//                      (1 - 1/e) step-response time — THE time-constant
//                      definition every dynamics model in XLETH uses (§1.3).
//                      Hardware figures quoted with another definition must be
//                      converted before they reach this code, never here.
//                      b is stored instead of a = 1 - b: for long tau, a sits a
//                      few float ULPs below 1 and its rounding alone moved a
//                      1.2 s release by 0.1 % (53 samples at 48 kHz).
//   SoftKneeGC         Giannoulis/Massberg/Reiss soft-knee static curve (JAES
//                      2012) in its feedforward form AND its exact inverse, which
//                      is what a feedback / tracked sidechain needs so that the
//                      CLOSED-LOOP static curve is still the textbook one.
//   BranchingEnvelope  Log-domain smoothed branching peak detector on gain
//                      reduction (§1.3), with a side-effect-free predict() so a
//                      zero-delay feedback solver can evaluate it implicitly.
//   DiodeRcCap         A timing capacitor charged through a diode + resistor and
//                      drained through another resistor, integrated
//                      trapezoidally (TPT) in closed form — the FET's gate
//                      network and each branch of the vari-mu's multi-RC bias.
//   TptSvf             Zavalishin topology-preserving state-variable filter;
//                      stable under per-block coefficient modulation.
//   softClipPade       Padé tanh approximant, C1 at its +/-3 clamp.
//   OutputTransformer  §8.4 transformer colour: coupling HPF, LF saturation,
//                      mild HF resonance (shared by the compressor models).
//                      Its (linear) filter states can be remixed between channel
//                      bases (L/R ⇄ M/S) so a stereo-mode switch stays seamless.
//   LinearRamp         Sample-accurate 0..1 crossfade weight that snaps exactly
//                      onto its endpoints (so a finished fade is bit-exact).
//   IntegerDelay       Preallocated multichannel integer-sample delay (the
//                      latency-aligned dry path behind an oversampler).
//   Oversampler        juce::dsp::Oversampling wrapper that measures and owns
//                      its integer latency and the matching aligned-dry delay,
//                      so a model reports truthful PDC with one call.
//
// Namespaced xleth::dsp. Older effects (ApexDsp.h, XlethAmpEffect.h, the reverb)
// still carry private copies of some of these; new code includes this header.

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

namespace xleth::dsp
{

// ─── Level conversion ───────────────────────────────────────────────────────

constexpr float kDbFloor      = -120.0f;
constexpr float kGainFloor    = 1.0e-6f;              // == dbToGain(kDbFloor)
constexpr float kDbPerNeper   = 8.68588963806503655f; // 20 / ln(10)
constexpr float kNeperPerDb   = 0.11512925464970229f; // ln(10) / 20

inline float gainToDb(float g) noexcept
{
    return kDbPerNeper * std::log(std::max(g, kGainFloor));
}

inline float dbToGain(float db) noexcept
{
    return std::exp(db * kNeperPerDb);
}

// ─── One-pole smoother ──────────────────────────────────────────────────────

// a = exp(-1 / (tau * fs)), the pole. tau <= 0 means "instant" (a = 0).
inline float onePoleCoeff(double tauSeconds, double sampleRate) noexcept
{
    const double n = tauSeconds * sampleRate;
    if (n <= 0.0) return 0.0f;
    return static_cast<float>(std::exp(-1.0 / n));
}

// b = 1 - a, the per-sample step, computed without cancellation. Prefer this
// with y += b * (x - y). tau <= 0 means "instant" (b = 1).
inline float onePoleStep(double tauSeconds, double sampleRate) noexcept
{
    const double n = tauSeconds * sampleRate;
    if (n <= 0.0) return 1.0f;
    return static_cast<float>(-std::expm1(-1.0 / n));
}

struct OnePole
{
    float b = 1.0f;
    float y = 0.0f;

    void setTau(double tauSeconds, double sampleRate) noexcept { b = onePoleStep(tauSeconds, sampleRate); }
    float process(float x) noexcept { y += b * (x - y); return y; }
    void reset(float v = 0.0f) noexcept { y = v; }
};

// ─── Soft-knee gain computer (Giannoulis et al. 2012) ───────────────────────
//
//            ⎧ x                                   2(x−T) < −W
//   y(x) =   ⎨ x + (1/R − 1)(x − T + W/2)² / (2W)   2|x−T| ≤ W
//            ⎩ T + (x − T)/R                       2(x−T) > W
//
// All levels in dB. "Reduction" is x − y ≥ 0 (a downward compressor).
//
// FEEDBACK FORM. A feedback / tracked sidechain does not see the input x; it
// sees the already-reduced level v = x − r. Its static equilibrium is
// r = c(v). Choosing c = the INVERSE curve — "how much reduction produced
// output level v" — makes that equilibrium land exactly on y(x): the closed
// loop has the textbook curve, knee included, and the loop only changes the
// dynamics (§2.1). Above the knee c(v) = (R−1)(v − T), i.e. the doc's slope
// S = R − 1 with R_eff = 1 + S.
struct SoftKneeGC
{
    struct Params
    {
        float ratio  = 4.0f;   // >= 1
        float kneeDb = 0.0f;   // >= 0; 0 = hard knee
        bool operator==(const Params& o) const noexcept { return ratio == o.ratio && kneeDb == o.kneeDb; }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    static float outputDb(float x, float T, const Params& p) noexcept
    {
        const float R = std::max(p.ratio, 1.0f);
        const float W = std::max(p.kneeDb, 0.0f);
        const float o = x - T;
        if (2.0f * o < -W) return x;
        if (2.0f * o > W)  return T + o / R;
        const float u = o + 0.5f * W;
        return x + (1.0f / R - 1.0f) * u * u / (2.0f * W);
    }

    // Feedforward reduction r(x) = x − y(x) and its slope dr/dx.
    static float reductionFF(float x, float T, const Params& p, float& slope) noexcept
    {
        const float R = std::max(p.ratio, 1.0f);
        const float W = std::max(p.kneeDb, 0.0f);
        const float o = x - T;
        const float S = 1.0f - 1.0f / R;
        if (2.0f * o < -W) { slope = 0.0f; return 0.0f; }
        if (2.0f * o > W)  { slope = S;    return S * o; }
        const float u = o + 0.5f * W;
        slope = S * u / W;
        return 0.5f * S * u * u / W;
    }

    // Feedback reduction c(v) = x(v) − v for an observed (post-gain) level v,
    // and its slope dc/dv (in [0, R−1]).
    static float reductionFB(float v, float T, const Params& p, float& slope) noexcept
    {
        const float R = std::max(p.ratio, 1.0f);
        const float W = std::max(p.kneeDb, 0.0f);
        // s = v − T + W/2 measures the output against the knee's lower corner.
        const float s = v - T + 0.5f * W;
        if (s <= 0.0f) { slope = 0.0f; return 0.0f; }
        const float sTop = 0.5f * W * (1.0f + 1.0f / R); // output level at the upper corner
        if (s >= sTop)
        {
            slope = R - 1.0f;
            return (R - 1.0f) * (v - T);
        }
        // Inside the knee: y − T + W/2 = u + k·u², k = (1/R − 1)/(2W) < 0,
        // solved for u = x − T + W/2 in the cancellation-free form.
        const float k = (1.0f / R - 1.0f) / (2.0f * W);
        const float u = 2.0f * s / (1.0f + std::sqrt(std::max(0.0f, 1.0f + 4.0f * k * s)));
        slope = 1.0f / (1.0f + 2.0f * k * u) - 1.0f;
        return u - s;
    }
};

// ─── Branching envelope (log-domain smoothed peak, on gain reduction) ───────
//
// y += (target > y ? bAttack : bRelease) · (target − y)      (b = onePoleStep)
//
// predict() evaluates that step without committing it and returns d(y)/d(target)
// — a continuous, monotone, piecewise-linear map — so an implicit (zero-delay)
// feedback solver can root-find through it.
struct BranchingEnvelope
{
    float bAttack  = 1.0f;
    float bRelease = 1.0f;
    float y        = 0.0f;

    float predict(float target, float& dOut) const noexcept
    {
        const float b = target > y ? bAttack : bRelease;
        dOut = b;
        return y + b * (target - y);
    }

    float commit(float target) noexcept
    {
        float d;
        y = predict(target, d);
        if (y < 1.0e-9f) y = 0.0f; // flush the release tail — never decays into denormals
        return y;
    }
};

// ─── Diode-charged RC timing capacitor ──────────────────────────────────────
//
//   drive ρ ──►|── R_charge ──┬── v
//                             C
//                             ├── R_drain ── GND
//
//   dv/dt = [ρ > v]·(ρ − v)/τ_c − v/τ_d          τ_c = R_charge·C, τ_d = R_drain·C
//
// Trapezoidal (TPT) — the capacitor is one integrator,
//   v_n = v_{n−1} + ½·(f_n + f_{n−1}),
// solved in closed form for the regime (charging or not) the END of the sample
// is in. Unprewarped on purpose: the two regimes share one state and meet
// continuously at the diode's switch point (ρ = the released value), which keeps
// step() continuous and nondecreasing in ρ — what an implicit (zero-delay)
// feedback solve through it needs. Written as an INCREMENT on v, never as a pole
// multiplying v: a pole 3e-6 below 1 (a 1.1 s τ) would drift τ by percents in
// float rounding alone. While charging the cap settles at ρ·τ_d/(τ_c + τ_d),
// the network's own divider.
struct DiodeRcCap
{
    struct Coeffs
    {
        // Per-sample rates 1/(τ·fs) and the trapezoid's closed-form factors.
        float wA = 1.0f, wR = 0.0f;
        float invCharge = 1.0f;       // 1 / (1 + ½(w_c + w_d))
        float invRelease = 1.0f;      // 1 / (1 + ½·w_d)
        float dCharge = 0.0f;         // dv/dρ while charging: ½·w_c / (1 + ½(w_c + w_d))
    };

    // τ ≤ 0 (or absurdly small) means instant; a very large τ_c never charges.
    static Coeffs make(double chargeS, double drainS, double fs) noexcept
    {
        Coeffs c;
        c.wA = static_cast<float>(1.0 / std::max(1.0e-9, chargeS * fs));
        c.wR = static_cast<float>(1.0 / std::max(1.0e-9, drainS * fs));
        c.invCharge = 1.0f / (1.0f + 0.5f * (c.wA + c.wR));
        c.invRelease = 1.0f / (1.0f + 0.5f * c.wR);
        c.dCharge = 0.5f * c.wA * c.invCharge;
        return c;
    }

    // One step from cap voltage v (previous drive rhoPrev) for drive rho: the
    // new cap voltage and dv/dρ.
    static float step(float v, float rhoPrev, float rho, const Coeffs& c, float& dv) noexcept
    {
        const float f0 = (rhoPrev > v ? c.wA * (rhoPrev - v) : 0.0f) - c.wR * v;
        const float dRel = 0.5f * (f0 - c.wR * v) * c.invRelease;
        const float released = std::max(0.0f, v + dRel);
        if (rho > released)
        {
            dv = c.dCharge;
            return v + 0.5f * (f0 + c.wA * (rho - v) - c.wR * v) * c.invCharge;
        }
        dv = 0.0f;
        return released;
    }
};

// ─── TPT state-variable filter (Zavalishin) ─────────────────────────────────
// Per-channel state; coefficients shared. setCutoff() is cheap enough to call
// once per block, and the structure stays stable under that modulation.
template <int MaxChannels>
struct TptSvf
{
    float g = 0.0f, k = 1.41421356f, a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
    float ic1[MaxChannels] {};
    float ic2[MaxChannels] {};

    // Re-express the two channels' states in another basis: new0 = m00·s0 +
    // m01·s1, new1 = m10·s0 + m11·s1. The filter is linear and identical per
    // channel, so if its inputs change basis by the same matrix (L/R ⇄ M/S) the
    // remixed states continue exactly as if the filter had always run there.
    void remix(float m00, float m01, float m10, float m11) noexcept
    {
        static_assert(MaxChannels >= 2, "remix needs two channels");
        const float a = ic1[0], b = ic1[1], c = ic2[0], d = ic2[1];
        ic1[0] = m00 * a + m01 * b;  ic1[1] = m10 * a + m11 * b;
        ic2[0] = m00 * c + m01 * d;  ic2[1] = m10 * c + m11 * d;
    }

    void setCutoff(float hz, double sampleRate, float q = 0.70710678f) noexcept
    {
        const float nyq = static_cast<float>(sampleRate) * 0.49f;
        const float f   = std::clamp(hz, 1.0f, nyq);
        g  = std::tan(juce::MathConstants<float>::pi * f / static_cast<float>(sampleRate));
        k  = 1.0f / std::max(q, 0.05f);
        a1 = 1.0f / (1.0f + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
    }

    void reset() noexcept
    {
        std::fill(std::begin(ic1), std::end(ic1), 0.0f);
        std::fill(std::begin(ic2), std::end(ic2), 0.0f);
    }

    // Returns the high-pass output (12 dB/oct).
    float processHighPass(float x, int ch) noexcept
    {
        const float v3 = x - ic2[ch];
        const float v1 = a1 * ic1[ch] + a2 * v3;
        const float v2 = ic2[ch] + a2 * ic1[ch] + a3 * v3;
        ic1[ch] = 2.0f * v1 - ic1[ch];
        ic2[ch] = 2.0f * v2 - ic2[ch];
        return x - k * v1 - v2;
    }

    // Returns the low-pass output (12 dB/oct; q > 0.707 peaks at the cutoff).
    float processLowPass(float x, int ch) noexcept
    {
        const float v3 = x - ic2[ch];
        const float v1 = a1 * ic1[ch] + a2 * v3;
        const float v2 = ic2[ch] + a2 * ic1[ch] + a3 * v3;
        ic1[ch] = 2.0f * v1 - ic1[ch];
        ic2[ch] = 2.0f * v2 - ic2[ch];
        return v2;
    }
};

// ─── Soft clipper ───────────────────────────────────────────────────────────
// Padé tanh approximant; reaches exactly ±1 with zero slope at |x| = 3, so the
// clamp there is C1 and adds no corner.
inline float softClipPade(float x) noexcept
{
    x = std::clamp(x, -3.0f, 3.0f);
    const float x2 = x * x;
    return x * (27.0f + x2) / (27.0f + 9.0f * x2);
}

// ─── Output transformer (§8.4) ──────────────────────────────────────────────
// The coloration building block the compressor models share: a coupling
// high-pass (also the DC blocker for any biased stage in front of it), a
// level-dependent LF saturation (a soft clip of the band below lfSplitHz only:
// core saturation is a low-frequency effect), and a mild HF resonance (2nd-order
// low-pass, capped at 0.45·fs). Per-channel state, up to 2 channels.
struct OutputTransformer
{
    struct Config
    {
        float couplingHz = 12.0f;
        float lfSplitHz  = 90.0f;
        float lfDrive    = 0.35f;
        float hfHz       = 26000.0f;
        float hfQ        = 0.85f;
    };

    void prepare(double fs, const Config& cfg) noexcept
    {
        lfDrive_    = cfg.lfDrive;
        invLfDrive_ = 1.0f / cfg.lfDrive;
        coupling_.setCutoff(cfg.couplingHz, fs);
        hf_.setCutoff(std::min(cfg.hfHz, static_cast<float>(0.45 * fs)), fs, cfg.hfQ);
        bLf_ = onePoleStep(1.0 / (2.0 * juce::MathConstants<double>::pi * cfg.lfSplitHz), fs);
        reset();
    }

    void reset() noexcept
    {
        coupling_.reset();
        hf_.reset();
        lf_[0] = lf_[1] = 0.0f;
    }

    // Channel-basis change of every state (see TptSvf::remix). All three stages
    // hold LINEAR state — the LF saturation is memoryless on top of a linear
    // one-pole — so only the memoryless nonlinearities differ across the change.
    void remix(float m00, float m01, float m10, float m11) noexcept
    {
        coupling_.remix(m00, m01, m10, m11);
        hf_.remix(m00, m01, m10, m11);
        const float a = lf_[0], b = lf_[1];
        lf_[0] = m00 * a + m01 * b;
        lf_[1] = m10 * a + m11 * b;
    }

    float process(float x, int ch) noexcept
    {
        const float h = coupling_.processHighPass(x, ch);
        const float lo = (lf_[ch] += bLf_ * (h - lf_[ch]));
        const float s = h + (softClipPade(lfDrive_ * lo) * invLfDrive_ - lo);
        return hf_.processLowPass(s, ch);
    }

private:
    float lfDrive_ = 0.35f, invLfDrive_ = 1.0f / 0.35f;
    float bLf_ = 0.0f;
    float lf_[2] {};
    TptSvf<2> coupling_ {};
    TptSvf<2> hf_ {};
};

// ─── Linear crossfade weight ────────────────────────────────────────────────
// Moves toward its target by a fixed step per sample and lands EXACTLY on 0 or
// 1, so a completed fade leaves the "off" branch contributing exactly nothing.
struct LinearRamp
{
    float value  = 0.0f;
    float target = 0.0f;
    float step   = 1.0f;

    void prepare(double sampleRate, double rampSeconds) noexcept
    {
        const double n = std::max(1.0, rampSeconds * sampleRate);
        step = static_cast<float>(1.0 / n);
    }
    void setTarget(float t) noexcept { target = t; }
    void snap(float t) noexcept { value = target = t; }
    bool isMoving() const noexcept { return value != target; }

    float next() noexcept
    {
        if (value < target)      value = std::min(value + step, target);
        else if (value > target) value = std::max(value - step, target);
        return value;
    }
};

// ─── Integer-sample delay ───────────────────────────────────────────────────
class IntegerDelay
{
public:
    // Allocates. Message thread / prepare only.
    void prepare(int numChannels, int delaySamples)
    {
        delay_ = std::max(0, delaySamples);
        size_  = delay_ + 1;
        buf_.assign(static_cast<size_t>(numChannels), std::vector<float>(static_cast<size_t>(size_), 0.0f));
        pos_ = 0;
    }

    void reset() noexcept
    {
        for (auto& c : buf_) std::fill(c.begin(), c.end(), 0.0f);
        pos_ = 0;
    }

    int getDelay() const noexcept { return delay_; }

    // Delays `n` samples of every channel in place. Realtime safe.
    void process(float* const* channels, int numChannels, int n) noexcept
    {
        if (delay_ == 0 || buf_.empty()) return;
        const int chs = std::min(numChannels, static_cast<int>(buf_.size()));
        int pos = pos_;
        for (int c = 0; c < chs; ++c)
        {
            float* d = channels[c];
            float* r = buf_[static_cast<size_t>(c)].data();
            pos = pos_;
            for (int i = 0; i < n; ++i)
            {
                r[pos] = d[i];
                int rd = pos - delay_;
                if (rd < 0) rd += size_;
                d[i] = r[rd];
                if (++pos == size_) pos = 0;
            }
        }
        pos_ = pos;
    }

private:
    std::vector<std::vector<float>> buf_;
    int delay_ = 0;
    int size_  = 1;
    int pos_   = 0;
};

// ─── Oversampler ────────────────────────────────────────────────────────────
// Linear-phase FIR half-band polyphase oversampling with INTEGER latency, the
// same design the other nonlinear stock effects use (see XlethAmpEffect.h for
// why FIR over IIR: a linear-phase path lets the aligned dry — bypass
// crossfade, parallel mix — null exactly against an integer delay).
//
// order 0 = no oversampling (factor 1, latency 0, the wrapper is a pass-through).
class Oversampler
{
public:
    Oversampler(int numChannels, int order)
        : numChannels_(numChannels), order_(std::max(0, order))
    {
        if (order_ > 0)
            os_ = std::make_unique<juce::dsp::Oversampling<float>>(
                static_cast<size_t>(numChannels_), static_cast<size_t>(order_),
                juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
                /*maxQuality*/ true, /*useIntegerLatency*/ true);
    }

    // Allocates. Message thread / prepare only.
    void prepare(int maxBlockSize)
    {
        maxBlock_ = std::max(1, maxBlockSize);
        if (os_)
        {
            os_->initProcessing(static_cast<size_t>(maxBlock_));
            os_->reset();
            // Measured, never assumed. Integer by construction (useIntegerLatency).
            latency_ = static_cast<int>(std::lround(os_->getLatencyInSamples()));
        }
        else
        {
            latency_ = 0;
        }
        dryDelay_.prepare(numChannels_, latency_);
    }

    void reset() noexcept
    {
        if (os_) os_->reset();
        dryDelay_.reset();
    }

    int getFactor() const noexcept { return 1 << order_; }
    int getOrder() const noexcept { return order_; }
    int getLatencySamples() const noexcept { return latency_; }
    int getMaxBlockSize() const noexcept { return maxBlock_; }

    // Up → returns the oversampled block (valid until processDown). n <= maxBlock.
    juce::dsp::AudioBlock<float> processUp(juce::dsp::AudioBlock<float>& hostBlock) noexcept
    {
        if (!os_) return hostBlock;
        return os_->processSamplesUp(hostBlock);
    }

    void processDown(juce::dsp::AudioBlock<float>& hostBlock) noexcept
    {
        if (os_) os_->processSamplesDown(hostBlock);
    }

    // Delays a copy of the dry host-rate signal by exactly getLatencySamples().
    void alignDry(float* const* channels, int numChannels, int n) noexcept
    {
        dryDelay_.process(channels, numChannels, n);
    }

private:
    int numChannels_ = 2;
    int order_       = 0;
    int maxBlock_    = 1;
    int latency_     = 0;
    std::unique_ptr<juce::dsp::Oversampling<float>> os_;
    IntegerDelay dryDelay_;
};

} // namespace xleth::dsp

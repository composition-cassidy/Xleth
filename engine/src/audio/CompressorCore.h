#pragma once

// ─── CompressorCore — one dynamics core, pluggable characters ───────────────
// docs/Compressor_Archetypes_Deep_Dive.md §9: every XLETH compressor (Glue VCA
// now; opto, FET and vari-mu later) is this ONE core instantiated with
// different compile-time stages:
//
//   CompressorCore<Detector, GainComputer, Ballistics, GainElement, Color>
//
// Policies are resolved at compile time — there is no virtual call anywhere in
// the per-sample path. The core itself owns what all four archetypes share:
//
//   • Topology      FeedForward | TrackedFeedback (SSL-style, §2.2). The
//                   tracked loop is solved IMPLICITLY each sample (zero-delay
//                   feedback, §2.3), so it is unconditionally stable — the naive
//                   one-sample-late loop goes unstable at 10:1 with a 0.1 ms
//                   attack at 44.1 kHz (loop pole 1 − (1−a)R < −1).
//   • Sidechain     pre-tracking high-pass hook (the SSL "S/C HPF"), with its
//                   in/out switch crossfaded.
//   • Stereo link   Max | Sum — one detector for both channels and one gain for
//                   both channels, so linked gain is identical by construction.
//                   (Unlinked / M/S need per-channel loop state; they arrive
//                   with the vari-mu, the first model that needs them.)
//   • Stepped-control crossfade: every stepped control (ratio, time-constant
//                   switches, topology) lives in a Settings value. A change
//                   copies the running lane — state included — into a second
//                   lane with the new coefficient set, runs both, and crossfades
//                   their gain reduction (in dB) over ~30 ms. Both lanes start
//                   from the same state, so the fade is continuous by
//                   construction and there is no zipper noise. Changes that
//                   arrive mid-fade are coalesced and start once it finishes.
//   • Makeup gain   applied AFTER the loop (§2.2/§11: inside a feedback loop it
//                   would act as a threshold control), then Color.
//
// Signal flow per sample (all at the rate passed to prepare() — the
// OVERSAMPLED rate when the host effect oversamples, so every coefficient is
// computed at the rate it runs at, §11):
//
//   x ──┬───────────────────────────► GainElement(× g) ─► makeup ─► Color ─► y
//       └► S/C HPF ─► Detector(dB) ─► [loop: GC ─► Ballistics] ─► GR dB ─┘
//
// Continuous controls (threshold, makeup) arrive as per-sample arrays already
// smoothed by the host effect (juce::SmoothedValue via XlethEffectBase).
//
// Realtime contract: process() never allocates, locks or logs, and runs under
// juce::ScopedNoDenormals. prepare() is the only allocating call (it doesn't,
// today, but it is where any future buffer would go).
//
// Policy interfaces (see the Glue policies at the bottom for a reference):
//   Detector:   prepare(fs) · reset() · float levelDb(l, r, StereoLink)
//   GC:         struct Params (==) · reductionFF(x,T,p,&slope) ·
//               reductionFB(v,T,p,&slope) · outputDb(x,T,p)
//   Ballistics: struct Params (==) · struct Coeffs · struct State ·
//               makeCoeffs(p, fs) · value(st) · predict(st,c,target,&d) ·
//               commit(st,c,target) · adopt(st,c)
//   GainElem:   prepare(fs) · reset() · float gainFor(grDb) ·
//               float apply(x, gain, ch)
//   Color:      prepare(fs) · reset() · float process(x, ch)

#include "dsp/DspPrimitives.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>

namespace xleth::comp
{

enum class Topology : int
{
    TrackedFeedback = 0,   // SSL: FF tap → sidechain VCA tracking the main gain (§2.2)
    FeedForward     = 1,   // sidechain VCA control cut: the detector sees the input
};

enum class StereoLink : int
{
    Max = 0,   // max(|L|, |R|)
    Sum = 1,   // (|L| + |R|) / 2
};

template <class Det, class GC, class Bal, class Elem, class Col>
class CompressorCore
{
public:
    // Every stepped control. Compared by value to detect a change.
    struct Settings
    {
        typename GC::Params  gc  {};
        typename Bal::Params bal {};
        Topology topology = Topology::TrackedFeedback;

        bool operator==(const Settings& o) const noexcept
        {
            return gc == o.gc && bal == o.bal && topology == o.topology;
        }
        bool operator!=(const Settings& o) const noexcept { return !(*this == o); }
    };

    struct Config
    {
        StereoLink link             = StereoLink::Max;
        double     crossfadeSeconds = 0.030;   // stepped-control coefficient-set fade
        double     toggleSeconds    = 0.020;   // S/C HPF in/out and Color in/out
    };

    CompressorCore() = default;
    explicit CompressorCore(const Config& cfg) : cfg_(cfg) {}

    // processRate is the rate process() runs at (oversampled rate if any).
    void prepare(double processRate, const Settings& initial)
    {
        rate_ = processRate;
        det_.prepare(rate_);
        elem_.prepare(rate_);
        col_.prepare(rate_);
        fade_.prepare(rate_, cfg_.crossfadeSeconds);
        hpfW_.prepare(rate_, cfg_.toggleSeconds);
        colW_.prepare(rate_, cfg_.toggleSeconds);
        hpf_.setCutoff(hpfHz_, rate_);

        pending_ = initial;
        lanes_[0].s = initial;
        lanes_[0].c = Bal::makeCoeffs(initial.bal, rate_);
        lanes_[1]   = lanes_[0];
        hpfW_.snap(hpfOn_ ? 1.0f : 0.0f);
        colW_.snap(colOn_ ? 1.0f : 0.0f);
        reset();
    }

    void reset() noexcept
    {
        // A pending stepped change is applied outright — nothing to fade from.
        lanes_[cur_].s = pending_;
        lanes_[cur_].c = Bal::makeCoeffs(pending_.bal, rate_);
        lanes_[cur_].st = typename Bal::State{};
        fading_ = false;
        fade_.snap(0.0f);
        det_.reset();
        elem_.reset();
        col_.reset();
        hpf_.reset();
        hpfW_.snap(hpfOn_ ? 1.0f : 0.0f);
        colW_.snap(colOn_ ? 1.0f : 0.0f);
        grDb_ = 0.0f;
        grMax_ = 0.0f;
    }

    // ── Control (audio thread, typically once per block) ────────────────────
    void setSettings(const Settings& s) noexcept { pending_ = s; }

    void setSidechainHighPass(bool on, float hz) noexcept
    {
        hpfOn_ = on;
        hpfW_.setTarget(on ? 1.0f : 0.0f);
        if (hz != hpfHz_)
        {
            hpfHz_ = hz;
            if (rate_ > 0.0) hpf_.setCutoff(hpfHz_, rate_);
        }
    }

    void setColorEnabled(bool on) noexcept
    {
        colOn_ = on;
        colW_.setTarget(on ? 1.0f : 0.0f);
    }

    // ── Processing ──────────────────────────────────────────────────────────
    // L/R processed in place (R may equal L for mono). thresholdDb/makeupDb
    // hold one value per `stride` samples of L/R — stride = the oversampling
    // factor when the host-rate smoothers drive an oversampled core.
    void process(float* L, float* R, int n,
                 const float* thresholdDb, const float* makeupDb, int stride) noexcept
    {
        juce::ScopedNoDenormals noDenormals;
        if (n <= 0) return;
        stride = std::max(1, stride);

        if (!fading_ && pending_ != lanes_[cur_].s)
            beginFade();

        const bool mono = (L == R);
        int   hostIdx     = -1;
        float T           = 0.0f;
        float makeupGain  = 1.0f;

        for (int i = 0; i < n; ++i)
        {
            const int hi = i / stride;
            if (hi != hostIdx)
            {
                hostIdx    = hi;
                T          = thresholdDb[hi];
                makeupGain = dsp::dbToGain(makeupDb[hi]);
            }

            const float xl = L[i];
            const float xr = mono ? xl : R[i];

            // Sidechain tap → pre-tracking HPF hook (crossfaded in/out).
            const float wh = hpfW_.next();
            float sl = xl, sr = xr;
            {
                const float hl = hpf_.processHighPass(xl, 0);
                const float hr = mono ? hl : hpf_.processHighPass(xr, 1);
                sl = xl + wh * (hl - xl);
                sr = xr + wh * (hr - xr);
            }

            // Linked detector → one control signal for both channels.
            const float levelDb = det_.levelDb(sl, sr, cfg_.link);

            float gr = runLane(lanes_[cur_], levelDb, T);
            if (fading_)
            {
                const float grNext = runLane(lanes_[1 - cur_], levelDb, T);
                const float w = fade_.next();
                gr += w * (grNext - gr);
                if (w >= 1.0f)
                {
                    cur_ = 1 - cur_;
                    fading_ = false;
                }
            }
            grDb_ = gr;
            grMax_ = std::max(grMax_, gr);

            // Gain element (identical gain on both channels), makeup, color.
            const float g  = elem_.gainFor(gr);
            const float wc = colW_.next();
            float yl = elem_.apply(xl, g, 0) * makeupGain;
            yl += wc * (col_.process(yl, 0) - yl);
            L[i] = yl;
            if (!mono)
            {
                float yr = elem_.apply(xr, g, 1) * makeupGain;
                yr += wc * (col_.process(yr, 1) - yr);
                R[i] = yr;
            }
        }
    }

    // ── Introspection ───────────────────────────────────────────────────────
    float getGainReductionDb() const noexcept { return grDb_; }

    // Max GR since the previous call (meters). Audio thread.
    float takeMaxGainReductionDb() noexcept
    {
        const float m = grMax_;
        grMax_ = 0.0f;
        return m;
    }

    // The textbook static curve the loop is built to settle on (tests / UI).
    float staticOutputDb(float xDb, float thresholdDb) const noexcept
    {
        return GC::outputDb(xDb, thresholdDb, lanes_[cur_].s.gc);
    }

    const Settings& getActiveSettings() const noexcept { return lanes_[cur_].s; }
    bool   isCrossfading() const noexcept { return fading_; }
    double getProcessRate() const noexcept { return rate_; }

private:
    struct Lane
    {
        Settings                s  {};
        typename Bal::Coeffs    c  {};
        typename Bal::State     st {};
    };

    void beginFade() noexcept
    {
        const int nxt = 1 - cur_;
        lanes_[nxt]    = lanes_[cur_];      // same state → continuous start
        lanes_[nxt].s  = pending_;
        lanes_[nxt].c  = Bal::makeCoeffs(pending_.bal, rate_);
        Bal::adopt(lanes_[nxt].st, lanes_[nxt].c);
        fade_.snap(0.0f);
        fade_.setTarget(1.0f);
        fading_ = true;
    }

    // One lane's gain reduction for this sample (dB, >= 0), state committed.
    static float runLane(Lane& ln, float levelDb, float T) noexcept
    {
        float rho;
        if (ln.s.topology == Topology::FeedForward)
        {
            float slope;
            rho = GC::reductionFF(levelDb, T, ln.s.gc, slope);
        }
        else
        {
            rho = solveTracked(ln, levelDb, T);
        }
        Bal::commit(ln.st, ln.c, rho);
        return Bal::value(ln.st);
    }

    // Zero-delay solve of the tracked loop:  ρ = c( L − B(ρ) )
    //   c = GC feedback (inverse-curve) reduction, nondecreasing in its argument
    //   B = this sample's ballistics output for target ρ, nondecreasing in ρ
    // so g(ρ) = ρ − c(L − B(ρ)) is strictly increasing with a unique root in
    // [0, c(L − B(0))]. Safeguarded Newton; every map is piecewise linear or a
    // smooth quadratic inverse, so it converges in 1–3 steps.
    static float solveTracked(const Lane& ln, float L, float T) noexcept
    {
        float dB = 0.0f, dC = 0.0f;
        const float b0 = Bal::predict(ln.st, ln.c, 0.0f, dB);
        float hi = GC::reductionFB(L - b0, T, ln.s.gc, dC);
        if (hi <= 0.0f) return 0.0f;
        float lo = 0.0f;

        float rho = std::clamp(GC::reductionFB(L - Bal::value(ln.st), T, ln.s.gc, dC), lo, hi);
        for (int it = 0; it < 12; ++it)
        {
            const float B = Bal::predict(ln.st, ln.c, rho, dB);
            const float c = GC::reductionFB(L - B, T, ln.s.gc, dC);
            const float g = rho - c;
            if (std::abs(g) < 1.0e-5f) break;
            if (g < 0.0f) lo = rho; else hi = rho;
            float next = rho - g / (1.0f + dC * dB);
            if (!(next > lo && next < hi)) next = 0.5f * (lo + hi);
            rho = next;
        }
        return rho;
    }

    Config   cfg_ {};
    double   rate_ = 48000.0;

    Det  det_  {};
    Elem elem_ {};
    Col  col_  {};

    Lane     lanes_[2] {};
    int      cur_    = 0;
    bool     fading_ = false;
    Settings pending_ {};
    dsp::LinearRamp fade_ {};

    dsp::TptSvf<2>  hpf_ {};
    dsp::LinearRamp hpfW_ {};
    float hpfHz_ = 100.0f;
    bool  hpfOn_ = false;

    dsp::LinearRamp colW_ {};
    bool  colOn_ = false;

    float grDb_  = 0.0f;
    float grMax_ = 0.0f;
};

// ═══ Glue VCA policies ═══════════════════════════════════════════════════════

// Detector in the log domain (Giannoulis' recommended structure, §1.3):
// instantaneous full-wave rectifier → dB (floored at −120), with ALL smoothing
// done afterwards on gain reduction by the Ballistics stage. Linked by
// construction: one level for both channels.
//
// §9's type sketch names an RmsDetector for the glue model; the log-domain peak
// is used instead because it keeps the 0.1 ms attack meaningful (an RMS window
// of a few ms would floor every attack setting at the window length) and it is
// the design Giannoulis et al. recommend. An RMS detector is a drop-in policy.
struct LogPeakDetector
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

// Attack/release on gain reduction in dB, fixed or program-dependent Auto.
//
// Time constants are one-pole τ (63.2 %) in the dB domain — the single
// definition in DspPrimitives.h — applied to the SIDECHAIN. In the tracked
// (feedback) topology the closed loop responds faster by the local loop gain:
// above the knee the effective τ is τ/R (§2.1 point 3). That is intrinsic to
// feedback, not a calibration error, and test_glue_compressor measures both.
//
// Auto = the §6.5 dual-envelope method:
//   fast envelope: user attack, 100 ms release — catches short transients and
//                  lets go quickly;
//   slow envelope: charges with τ = 1 s, releases with τ = 12 s — builds only
//                  under sustained program and then holds;
//   GR = max(fast, slow).
// The 100 ms / 12 s pair is SSL's own figure for the Bus Compressor AUTO
// setting ("two-stage release (100 ms short, 12 seconds long)", THE BUS+ User
// Guide v1.1 p.10), taken as τ under the definition above. The slow CHARGE time
// is not published; 1 s is chosen so a lone transient (≲100 ms) moves the slow
// envelope by < 10 % while a couple of seconds of dense program fills it.
struct AutoReleaseBallistics
{
    static constexpr double kAutoFastReleaseS = 0.100;
    static constexpr double kAutoSlowReleaseS = 12.0;
    static constexpr double kAutoSlowAttackS  = 1.0;

    struct Params
    {
        float attackMs    = 10.0f;
        float releaseMs   = 100.0f;  // ignored when autoRelease
        bool  autoRelease = false;
        bool operator==(const Params& o) const noexcept
        {
            return attackMs == o.attackMs && releaseMs == o.releaseMs && autoRelease == o.autoRelease;
        }
        bool operator!=(const Params& o) const noexcept { return !(*this == o); }
    };

    struct Coeffs
    {
        // Per-sample steps b = 1 − pole (dsp::onePoleStep), not poles.
        float bAtt = 1.0f, bRel = 1.0f, bSlowAtt = 1.0f, bSlowRel = 1.0f;
        bool  autoRelease = false;
    };

    struct State
    {
        float fast = 0.0f;
        float slow = 0.0f;
    };

    static Coeffs makeCoeffs(const Params& p, double fs) noexcept
    {
        Coeffs c;
        c.autoRelease = p.autoRelease;
        c.bAtt = dsp::onePoleStep(p.attackMs * 0.001, fs);
        c.bRel = dsp::onePoleStep(p.autoRelease ? kAutoFastReleaseS : p.releaseMs * 0.001, fs);
        c.bSlowAtt = dsp::onePoleStep(kAutoSlowAttackS, fs);
        c.bSlowRel = dsp::onePoleStep(kAutoSlowReleaseS, fs);
        return c;
    }

    static float value(const State& s) noexcept { return std::max(s.fast, s.slow); }

    static float predict(const State& s, const Coeffs& c, float target, float& d) noexcept
    {
        const float bf = target > s.fast ? c.bAtt : c.bRel;
        const float f  = s.fast + bf * (target - s.fast);
        if (!c.autoRelease) { d = bf; return f; }
        const float bs = target > s.slow ? c.bSlowAtt : c.bSlowRel;
        const float sl = s.slow + bs * (target - s.slow);
        if (f >= sl) { d = bf; return f; }
        d = bs;
        return sl;
    }

    static void commit(State& s, const Coeffs& c, float target) noexcept
    {
        const float bf = target > s.fast ? c.bAtt : c.bRel;
        s.fast += bf * (target - s.fast);
        if (s.fast < 1.0e-9f) s.fast = 0.0f;
        if (c.autoRelease)
        {
            const float bs = target > s.slow ? c.bSlowAtt : c.bSlowRel;
            s.slow += bs * (target - s.slow);
            if (s.slow < 1.0e-9f) s.slow = 0.0f;
        }
    }

    // Normalise state after a coefficient change without moving value():
    // leaving Auto folds the slow stage into the single envelope; entering it
    // starts the slow stage empty (it has not seen any program yet).
    static void adopt(State& s, const Coeffs& c) noexcept
    {
        if (!c.autoRelease)
        {
            s.fast = std::max(s.fast, s.slow);
            s.slow = 0.0f;
        }
    }
};

// Blackmer VCA: exponential control law, linear in dB, ≤ 0.01 % THD (§6.1–6.2).
// Modelled as the ideal multiplier it is to within that spec.
struct IdealVca
{
    void prepare(double) noexcept {}
    void reset() noexcept {}
    float gainFor(float grDb) const noexcept { return dsp::dbToGain(-grDb); }
    float apply(float x, float g, int) const noexcept { return x * g; }
};

// One subtle console-style output stage (§6.5 "only a subtle console-style
// saturation stage, with a bypass"): a lightly driven, very slightly biased
// Padé-tanh, DC-blocked like a coupling cap. Unity small-signal gain; roughly
// 0.5 % THD for a 0 dBFS sine (mostly 3rd, a trace of 2nd), under 0.01 % at
// −20 dBFS — colour you feel on a hot bus, not hear on a quiet one.
struct SubtleConsoleColor
{
    static constexpr float kDrive = 0.25f;
    static constexpr float kBias  = 0.04f;
    static constexpr float kDcHz  = 5.0f;

    void prepare(double fs) noexcept
    {
        biasOut_ = dsp::softClipPade(kDrive * kBias);
        dcR_ = static_cast<float>(std::exp(-2.0 * juce::MathConstants<double>::pi * kDcHz / fs));
        reset();
    }

    void reset() noexcept
    {
        x1_[0] = x1_[1] = 0.0f;
        y1_[0] = y1_[1] = 0.0f;
    }

    float process(float x, int ch) noexcept
    {
        const float s = (dsp::softClipPade(kDrive * (x + kBias)) - biasOut_) * (1.0f / kDrive);
        const float y = s - x1_[ch] + dcR_ * y1_[ch];
        x1_[ch] = s;
        y1_[ch] = y;
        return y;
    }

private:
    float biasOut_ = 0.0f;
    float dcR_     = 0.9997f;
    float x1_[2] {};
    float y1_[2] {};
};

using GlueCompressorCore =
    CompressorCore<LogPeakDetector, dsp::SoftKneeGC, AutoReleaseBallistics, IdealVca, SubtleConsoleColor>;

} // namespace xleth::comp

#pragma once

// ─── CompressorCore — one dynamics core, pluggable characters ───────────────
// docs/Compressor_Archetypes_Deep_Dive.md §9: every XLETH compressor (Glue VCA,
// Opto, FET, Vari-Mu) is this ONE core instantiated with different
// compile-time stages:
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
//   • Channels      Linked (default) — one detector for both channels (Max |
//                   Sum link) and one gain for both, so linked gain is identical
//                   by construction. MidSide — the input is matrixed to
//                   M = (L+R)/2, S = (L−R)/2 and each runs its OWN detector,
//                   loop, gain element and colour, then is matrixed back
//                   (the vari-mu's §5.2 sum/difference mode). Each independent
//                   control signal is a "unit" with its own loop state.
//                   Switching mode crossfades the two complete paths over the
//                   stepped-control fade: the new path starts from the old one's
//                   loop state and from its colour filter states re-expressed
//                   in the new basis (Col::remix, when the colour has one), so
//                   both paths are continuous and the fade only covers the
//                   gain difference between them.
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
// Signal flow per sample and unit (all at the rate passed to prepare() — the
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
//               optional: reductionLoop(L,B,T,p,&slopeB) — a sidechain that
//               sees the input level L as well as the loop's reduction B
//               (replaces reductionFB(L − B) in the loop); kLoopRelTolerance —
//               relative Newton tolerance for a ρ that is not in dB.
//               (Opto policies: OptoCompressorCore.h.)
//   Ballistics: struct Params (==) · struct Coeffs · struct State ·
//               makeCoeffs(p, fs) · value(st) · predict(st,c,target,&d) ·
//               commit(st,c,target) · adopt(st,c)
//               optional: kDiodeGated — predict() is exactly independent of a
//               target below its charge threshold (lets the loop skip Newton).
//   GainElem:   prepare(fs) · reset() · float gainFor(grDb) ·
//               float apply(x, gain, ch)
//               gainFor() runs once per sample per unit, immediately before
//               that unit's apply() calls, so an element may hold per-sample
//               state there (the FET does).
//               `gain` is whatever the element's own apply() needs — the FET
//               passes its channel conductance, the vari-mu its grid bias.
//   Color:      prepare(fs) · reset() · float process(x, ch) · copyable
//               optional: remix(m00, m01, m10, m11) — re-express the two
//               channels' filter states in another basis (DspPrimitives.h).

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

enum class ChannelMode : int
{
    Linked  = 0,   // one control signal for L and R (StereoLink picks the level)
    MidSide = 1,   // independent control signals for M and S
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
        bool       sidechainHpf     = true;    // false: a model with a flat sidechain
                                               // skips the (always-running) HPF filter
    };

    CompressorCore() = default;
    explicit CompressorCore(const Config& cfg) : cfg_(cfg) {}

    // processRate is the rate process() runs at (oversampled rate if any).
    void prepare(double processRate, const Settings& initial)
    {
        rate_ = processRate;
        for (auto& u : units_)
        {
            u.det.prepare(rate_);
            u.fade.prepare(rate_, cfg_.crossfadeSeconds);
        }
        elem_.prepare(rate_);
        for (auto& c : col_) c.prepare(rate_);
        modeFade_.prepare(rate_, cfg_.crossfadeSeconds);
        hpfW_.prepare(rate_, cfg_.toggleSeconds);
        colW_.prepare(rate_, cfg_.toggleSeconds);
        for (auto& h : hpf_) h.setCutoff(hpfHz_, rate_);

        pending_ = initial;
        for (auto& u : units_)
        {
            u.lanes[0].s = initial;
            u.lanes[0].c = Bal::makeCoeffs(initial.bal, rate_);
            u.lanes[1]   = u.lanes[0];
        }
        hpfW_.snap(hpfOn_ ? 1.0f : 0.0f);
        colW_.snap(colOn_ ? 1.0f : 0.0f);
        reset();
    }

    void reset() noexcept
    {
        // A pending stepped change — and a pending channel mode — is applied
        // outright: nothing to fade from.
        for (auto& u : units_)
        {
            u.lanes[u.cur].s = pending_;
            u.lanes[u.cur].c = Bal::makeCoeffs(pending_.bal, rate_);
            u.lanes[u.cur].st = typename Bal::State{};
            u.fading = false;
            u.fade.snap(0.0f);
            u.det.reset();
            u.grDb = 0.0f;
        }
        mode_ = modeTarget_;
        modeFading_ = false;
        modeFade_.snap(0.0f);
        elem_.reset();
        for (auto& c : col_) c.reset();
        for (auto& h : hpf_) h.reset();
        hpfW_.snap(hpfOn_ ? 1.0f : 0.0f);
        colW_.snap(colOn_ ? 1.0f : 0.0f);
        grDb_ = 0.0f;
        grMax_[0] = grMax_[1] = 0.0f;
    }

    // ── Control (audio thread, typically once per block) ────────────────────
    void setSettings(const Settings& s) noexcept { pending_ = s; }

    // Linked ⇄ MidSide. Takes effect at the next process() call with a stereo
    // (L ≠ R) buffer and crossfades over the stepped-control fade. Mono input
    // is always processed linked.
    void setChannelMode(ChannelMode m) noexcept { modeTarget_ = m; }

    void setSidechainHighPass(bool on, float hz) noexcept
    {
        hpfOn_ = on;
        hpfW_.setTarget(on ? 1.0f : 0.0f);
        if (hz != hpfHz_)
        {
            hpfHz_ = hz;
            if (rate_ > 0.0)
                for (auto& h : hpf_) h.setCutoff(hpfHz_, rate_);
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

        const bool mono = (L == R);
        if (!mono && !modeFading_ && modeTarget_ != mode_)
            beginModeFade();

        const bool linkedActive = mono || modeFading_ || mode_ == ChannelMode::Linked;
        const bool msActive     = !mono && (modeFading_ || mode_ == ChannelMode::MidSide);
        if (linkedActive) maybeBeginFade(units_[kLinked]);
        if (msActive)     { maybeBeginFade(units_[kMid]); maybeBeginFade(units_[kSide]); }

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
            const float wh = hpfW_.next();
            const float wc = colW_.next();

            float yl, yr;
            if (mono)
            {
                linkedSample(xl, xr, true, T, makeupGain, wh, wc, yl, yr);
            }
            else if (!modeFading_)
            {
                if (mode_ == ChannelMode::Linked) linkedSample(xl, xr, false, T, makeupGain, wh, wc, yl, yr);
                else                              midSideSample(xl, xr, T, makeupGain, wh, wc, yl, yr);
            }
            else
            {
                // Both complete paths, the outgoing one's output faded into
                // the incoming one's.
                float ll, lr, ml, mr;
                linkedSample(xl, xr, false, T, makeupGain, wh, wc, ll, lr);
                midSideSample(xl, xr, T, makeupGain, wh, wc, ml, mr);
                const bool toMs = modeTarget_ == ChannelMode::MidSide;
                const float w = modeFade_.next();
                const float al = toMs ? ll : ml, ar = toMs ? lr : mr;
                const float bl = toMs ? ml : ll, br = toMs ? mr : lr;
                yl = al + w * (bl - al);
                yr = ar + w * (br - ar);
                if (w >= 1.0f)
                {
                    mode_ = modeTarget_;
                    modeFading_ = false;
                }
            }

            // The reported GR: the linked unit, or the deeper of mid and side.
            grDb_ = (mono || currentPathIsLinked()) ? units_[kLinked].grDb
                                                    : std::max(units_[kMid].grDb, units_[kSide].grDb);
            L[i] = yl;
            if (!mono) R[i] = yr;
        }
    }

    // ── Introspection ───────────────────────────────────────────────────────
    float getGainReductionDb() const noexcept { return grDb_; }

    // Per-channel GR of the current path: linked → the one control signal on
    // both; MidSide → 0 = mid, 1 = side.
    float getChannelGainReductionDb(int ch) const noexcept
    {
        if (currentPathIsLinked()) return units_[kLinked].grDb;
        return units_[ch == 0 ? kMid : kSide].grDb;
    }

    // Max GR since the previous call (meters), over both channels. Audio thread.
    float takeMaxGainReductionDb() noexcept
    {
        const float m = std::max(grMax_[0], grMax_[1]);
        grMax_[0] = grMax_[1] = 0.0f;
        return m;
    }

    // Max GR since the previous call on one channel slot (0 = linked/mid,
    // 1 = linked/side). Audio thread.
    float takeMaxGainReductionDb(int ch) noexcept
    {
        const int k = ch == 0 ? 0 : 1;
        const float m = grMax_[k];
        grMax_[k] = 0.0f;
        return m;
    }

    // The textbook static curve the loop is built to settle on (tests / UI).
    float staticOutputDb(float xDb, float thresholdDb) const noexcept
    {
        return GC::outputDb(xDb, thresholdDb, primary().lanes[primary().cur].s.gc);
    }

    const Settings& getActiveSettings() const noexcept { return primary().lanes[primary().cur].s; }
    bool isCrossfading() const noexcept
    {
        if (modeFading_) return true;
        if (currentPathIsLinked()) return units_[kLinked].fading;
        return units_[kMid].fading || units_[kSide].fading;
    }
    double getProcessRate() const noexcept { return rate_; }
    ChannelMode getChannelMode() const noexcept { return mode_; }
    bool isChannelModeFading() const noexcept { return modeFading_; }

    // The gain element itself, for a model whose element carries state of its
    // own outside the stepped lanes (the FET's bias network, FetCompressorCore.h).
    // Audio thread, like the other controls.
    Elem&       gainElement() noexcept       { return elem_; }
    const Elem& gainElement() const noexcept { return elem_; }

    // The colour stages (0 = the L/R path's, 1 = the M/S path's), for a model
    // that configures its colour (the vari-mu's line-amp headroom).
    Col& colorStage(int basis) noexcept { return col_[basis == 0 ? 0 : 1]; }

private:
    struct Lane
    {
        Settings                s  {};
        typename Bal::Coeffs    c  {};
        typename Bal::State     st {};
    };

    // One independent control signal: its detector, its two stepped lanes and
    // their fade.
    struct Unit
    {
        Det             det {};
        Lane            lanes[2] {};
        int             cur    = 0;
        bool            fading = false;
        dsp::LinearRamp fade {};
        float           grDb   = 0.0f;
    };

    static constexpr int kLinked = 0, kMid = 1, kSide = 2;

    bool currentPathIsLinked() const noexcept { return mode_ == ChannelMode::Linked; }
    const Unit& primary() const noexcept { return units_[currentPathIsLinked() ? kLinked : kMid]; }

    void maybeBeginFade(Unit& u) noexcept
    {
        if (!u.fading && pending_ != u.lanes[u.cur].s)
            beginFade(u);
    }

    void beginFade(Unit& u) noexcept
    {
        const int nxt = 1 - u.cur;
        u.lanes[nxt]    = u.lanes[u.cur];   // same state → continuous start
        u.lanes[nxt].s  = pending_;
        u.lanes[nxt].c  = Bal::makeCoeffs(pending_.bal, rate_);
        Bal::adopt(u.lanes[nxt].st, u.lanes[nxt].c);
        u.fade.snap(0.0f);
        u.fade.setTarget(1.0f);
        u.fading = true;
    }

    // Start the Linked ⇄ MidSide crossfade: the incoming path's units take the
    // outgoing path's loop state (so its gain starts where the old one is) and
    // its colour and sidechain filters take the outgoing ones' states in the
    // new basis.
    void beginModeFade() noexcept
    {
        if (modeTarget_ == ChannelMode::MidSide)
        {
            units_[kMid] = units_[kLinked];
            units_[kSide] = units_[kLinked];
            units_[kMid].det.reset();
            units_[kSide].det.reset();
            carryFilters(col_[0], col_[1], hpf_[0], hpf_[1], 0.5f, 0.5f, 0.5f, -0.5f);
        }
        else
        {
            units_[kLinked] = units_[kMid].grDb >= units_[kSide].grDb ? units_[kMid] : units_[kSide];
            units_[kLinked].det.reset();
            carryFilters(col_[1], col_[0], hpf_[1], hpf_[0], 1.0f, 1.0f, 1.0f, -1.0f);
        }
        modeFade_.snap(0.0f);
        modeFade_.setTarget(1.0f);
        modeFading_ = true;
    }

    static void carryFilters(const Col& colFrom, Col& colTo, const dsp::TptSvf<2>& hpfFrom, dsp::TptSvf<2>& hpfTo,
                             float m00, float m01, float m10, float m11) noexcept
    {
        colTo = colFrom;
        if constexpr (requires(Col& c) { c.remix(m00, m01, m10, m11); })
            colTo.remix(m00, m01, m10, m11);
        hpfTo = hpfFrom;
        hpfTo.remix(m00, m01, m10, m11);
    }

    // The linked path for one sample: one detector, one gain for both channels.
    void linkedSample(float xl, float xr, bool mono, float T, float makeupGain, float wh, float wc,
                      float& yl, float& yr) noexcept
    {
        // Sidechain tap → pre-tracking HPF hook (crossfaded in/out).
        float sl = xl, sr = xr;
        if (cfg_.sidechainHpf)
        {
            const float hl = hpf_[0].processHighPass(xl, 0);
            const float hr = mono ? hl : hpf_[0].processHighPass(xr, 1);
            sl = xl + wh * (hl - xl);
            sr = xr + wh * (hr - xr);
        }

        // Linked detector → one control signal for both channels.
        Unit& u = units_[kLinked];
        const float levelDb = u.det.levelDb(sl, sr, cfg_.link);
        const float gr = runUnit(u, levelDb, T);
        grMax_[0] = std::max(grMax_[0], gr);
        grMax_[1] = std::max(grMax_[1], gr);

        // Gain element (identical gain on both channels), makeup, color.
        const float g = elem_.gainFor(gr);
        yl = elem_.apply(xl, g, 0) * makeupGain;
        yl += wc * (col_[0].process(yl, 0) - yl);
        if (!mono)
        {
            yr = elem_.apply(xr, g, 1) * makeupGain;
            yr += wc * (col_[0].process(yr, 1) - yr);
        }
        else
        {
            yr = yl;
        }
    }

    // The mid/side path for one sample: two independent units, matrixed back.
    void midSideSample(float xl, float xr, float T, float makeupGain, float wh, float wc,
                       float& yl, float& yr) noexcept
    {
        const float m = 0.5f * (xl + xr);
        const float s = 0.5f * (xl - xr);
        float sm = m, ss = s;
        if (cfg_.sidechainHpf)
        {
            const float hm = hpf_[1].processHighPass(m, 0);
            const float hs = hpf_[1].processHighPass(s, 1);
            sm = m + wh * (hm - m);
            ss = s + wh * (hs - s);
        }

        const float grM = runUnit(units_[kMid], units_[kMid].det.levelDb(sm, sm, StereoLink::Max), T);
        const float grS = runUnit(units_[kSide], units_[kSide].det.levelDb(ss, ss, StereoLink::Max), T);
        grMax_[0] = std::max(grMax_[0], grM);
        grMax_[1] = std::max(grMax_[1], grS);

        const float gm = elem_.gainFor(grM);
        float ym = elem_.apply(m, gm, 0) * makeupGain;
        ym += wc * (col_[1].process(ym, 0) - ym);
        const float gs = elem_.gainFor(grS);
        float ys = elem_.apply(s, gs, 1) * makeupGain;
        ys += wc * (col_[1].process(ys, 1) - ys);

        yl = ym + ys;
        yr = ym - ys;
    }

    // One unit's gain reduction for this sample (dB, >= 0), lanes faded.
    float runUnit(Unit& u, float levelDb, float T) noexcept
    {
        float gr = runLane(u.lanes[u.cur], levelDb, T);
        if (u.fading)
        {
            const float grNext = runLane(u.lanes[1 - u.cur], levelDb, T);
            const float w = u.fade.next();
            gr += w * (grNext - gr);
            if (w >= 1.0f)
            {
                u.cur = 1 - u.cur;
                u.fading = false;
            }
        }
        u.grDb = gr;
        return gr;
    }

    // One lane's gain reduction for this sample (dB, >= 0), state committed.
    float runLane(Lane& ln, float levelDb, float T) const noexcept
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

    // The loop's sidechain law c(L, B): what the GC asks for when the input
    // level is L and the loop currently applies B dB of reduction. Returns c and
    // slopeB = −∂c/∂B ≥ 0.
    //
    // By default the sidechain sees only the reduced level, c = GC::reductionFB
    // (L − B), so −∂c/∂B = dc/dv. A GC whose sidechain ALSO taps the input (the
    // opto's Limit position mixes input into the output-derived sidechain) says
    // so by providing reductionLoop(L, B, T, p, slopeB) itself.
    //
    // An element whose large-signal gain departs from its small-signal GR (the
    // vari-mu's tube swinging toward cutoff) provides loopOutputDb(L, B, dOut):
    // the ACTUAL output level for input level L at B dB of small-signal
    // reduction, and d(output)/dB ≤ 0. The sidechain then sees that — what the
    // unit's rectifier really sees — so the loop regulates the real output.
    float loopReduction(float L, float B, float T, const typename GC::Params& p,
                        float& slopeB) const noexcept
    {
        if constexpr (requires { GC::reductionLoop(L, B, T, p, slopeB); })
            return GC::reductionLoop(L, B, T, p, slopeB);
        else if constexpr (requires(const Elem& e, float d) { e.loopOutputDb(L, B, d); })
        {
            float dOut, slope;
            const float c = GC::reductionFB(elem_.loopOutputDb(L, B, dOut), T, p, slope);
            slopeB = -slope * dOut;
            return c;
        }
        else
            return GC::reductionFB(L - B, T, p, slopeB);
    }

    // Newton stopping rule on |ρ − c|. Absolute 1e-5 for GCs whose ρ is dB;
    // a GC whose ρ spans decades (the opto's EL light) sets a relative one.
    static float loopTolerance(float rho) noexcept
    {
        if constexpr (requires { GC::kLoopRelTolerance; })
            return 1.0e-5f + GC::kLoopRelTolerance * rho;
        else
            return 1.0e-5f;
    }

    // Zero-delay solve of the tracked loop:  ρ = c( L, B(ρ) )
    //   c = GC sidechain law, nonincreasing in B (default: the feedback
    //       inverse-curve reduction of the reduced level L − B)
    //   B = this sample's ballistics output for target ρ, nondecreasing in ρ
    // so g(ρ) = ρ − c(L, B(ρ)) is strictly increasing with a unique root in
    // [0, c(L, B(0))]. Safeguarded Newton; every map is piecewise linear or a
    // smooth quadratic inverse, so it converges in 1–3 steps.
    float solveTracked(const Lane& ln, float L, float T) const noexcept
    {
        float dB = 0.0f, dC = 0.0f;
        const float b0 = Bal::predict(ln.st, ln.c, 0.0f, dB);
        float hi = loopReduction(L, b0, T, ln.s.gc, dC);
        if (hi <= 0.0f) return 0.0f;
        if constexpr (requires { Bal::kDiodeGated; })
        {
            // A diode-gated network ignores any drive below its charge
            // threshold: if what the sidechain asks for at the released state
            // opens no diode, B(hi) = B(0) and hi is the exact root. On a
            // waveform that is most samples (the caps charge only near peaks).
            float dHi;
            if (Bal::predict(ln.st, ln.c, hi, dHi) == b0) return hi;
        }
        float lo = 0.0f;

        float rho = std::clamp(loopReduction(L, Bal::value(ln.st), T, ln.s.gc, dC), lo, hi);
        for (int it = 0; it < 12; ++it)
        {
            const float B = Bal::predict(ln.st, ln.c, rho, dB);
            const float c = loopReduction(L, B, T, ln.s.gc, dC);
            const float g = rho - c;
            if (std::abs(g) < loopTolerance(rho)) break;
            if (g < 0.0f) lo = rho; else hi = rho;
            float next = rho - g / (1.0f + dC * dB);
            if (!(next > lo && next < hi)) next = 0.5f * (lo + hi);
            rho = next;
        }
        return rho;
    }

    Config   cfg_ {};
    double   rate_ = 48000.0;

    Unit units_[3] {};           // kLinked, kMid, kSide
    Elem elem_ {};
    Col  col_[2] {};             // [0] L/R basis, [1] M/S basis

    Settings pending_ {};

    ChannelMode     mode_       = ChannelMode::Linked;
    ChannelMode     modeTarget_ = ChannelMode::Linked;
    bool            modeFading_ = false;
    dsp::LinearRamp modeFade_ {};

    dsp::TptSvf<2>  hpf_[2] {};  // [0] L/R basis, [1] M/S basis
    dsp::LinearRamp hpfW_ {};
    float hpfHz_ = 100.0f;
    bool  hpfOn_ = false;

    dsp::LinearRamp colW_ {};
    bool  colOn_ = false;

    float grDb_  = 0.0f;
    float grMax_[2] {};
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

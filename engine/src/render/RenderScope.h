#pragma once

/**
 * RenderScope — Phase 2 render/export scoping contract (pure, header-only).
 *
 * Derives WHAT slice of the timeline an export captures, and HOW far back the
 * engine must warm up before the first captured sample. Pure functions only:
 * no JUCE, no FFmpeg, no GL, no Timeline dependency — only LoopRegion from
 * model/TimelineTypes.h — so the policy is unit-testable in isolation.
 *
 * THE FOUR CONCEPTS (kept deliberately separate — see spec §5):
 *   1. warmUpStartTick   — where the engine begins simulating (silent pre-roll).
 *   2. captureStartTick  — first timeline tick written to the output file.
 *   3. captureEndTick    — one-past-last timeline tick written.
 *   4. output timestamp  — ALWAYS starts at 0 (the file begins at the region
 *                          start; there is never leading silence/black from
 *                          tick 0 → captureStartTick). This is implicit: the
 *                          renderer discards [warmUp, captureStart) output.
 *
 * POLICY (the single coupling point): renderScoped == loopEnabled. A future
 * "audition the loop but render the full timeline" override is a one-line change
 * here, NOT scattered through the exporters.
 *
 * ABSOLUTE WINDOW (Phase 2 default + only supported mode): a scoped render is a
 * WINDOW into the timeline, not a cold-started clip. The engine warms up from
 * tick 0 to captureStartTick, discarding that output, so notes/clips/effect
 * tails already in flight at captureStartTick are present in the first captured
 * sample. renderOrigin == Normalized is reserved for a later phase; it falls
 * back to absolute behaviour here (warmUp == captureStart) so it can never
 * silently cold-start.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include "model/TimelineTypes.h"   // LoopRegion

namespace xleth {

// ─── Debug-only bounds override ────────────────────────────────────────────────
// Repointed target for the legacy dev "start bar / end bar" export inputs. When
// active it replaces the LoopRegion bounds for THIS render only; the LoopRegion
// itself (the user-facing source of truth) is never mutated. Only ever populated
// behind a debug-only guard on the caller side — see bridge Video/Audio export.
struct RenderScopeOverride {
    bool    active    = false;
    int64_t startTick = 0;
    int64_t endTick   = 0;
};

// ─── Resolved render scope (tick domain) ───────────────────────────────────────
struct RenderScope {
    bool    scoped          = false;  // == loopEnabled (derived, never stored)
    int64_t warmUpStartTick = 0;      // engine warms up from here (output discarded)
    int64_t captureStartTick = 0;     // first tick in the output file
    int64_t captureEndTick   = 0;     // one-past-last tick in the output file
};

// Derive the render scope. `fullTimelineEndTick` is the end of the last
// meaningful event (last clip / last pattern event), supplied by the caller so
// this stays Timeline-free and pure.
inline RenderScope computeRenderScope(const LoopRegion&          loopRegion,
                                      int64_t                    fullTimelineEndTick,
                                      const RenderScopeOverride& dbgOverride = {})
{
    RenderScope rs;

    // Debug repoint: the dev manual bars override the region bounds, scoping the
    // render to an arbitrary [startTick, endTick] window with absolute warm-up.
    if (dbgOverride.active && dbgOverride.endTick > dbgOverride.startTick) {
        rs.scoped           = true;
        rs.captureStartTick = dbgOverride.startTick < 0 ? 0 : dbgOverride.startTick;
        rs.captureEndTick   = dbgOverride.endTick;
        rs.warmUpStartTick  = 0;            // absolute window
        return rs;
    }

    // Normal path — the single policy coupling: render scope IS the loop flag.
    rs.scoped = loopRegion.loopEnabled;

    if (rs.scoped) {
        rs.captureStartTick = loopRegion.startTick < 0 ? 0 : loopRegion.startTick;
        rs.captureEndTick   = loopRegion.endTick;
        // Absolute window warms up from tick 0; Normalized (Phase 3+) falls back
        // to absolute so it can never silently cold-start.
        rs.warmUpStartTick =
            (loopRegion.renderOrigin == LoopRegion::RenderOrigin::Normalized)
                ? rs.captureStartTick
                : 0;
    } else {
        // Full timeline: tick 0 → end of last meaningful event.
        rs.captureStartTick = 0;
        rs.captureEndTick   = fullTimelineEndTick;
        rs.warmUpStartTick  = 0;
    }
    return rs;
}

// ─── Pre-roll plan (sample domain) ─────────────────────────────────────────────
// Generalised warm-up + latency-compensation math shared by AudioExporter and
// OfflineRenderer. Reduces to the legacy latency-only behaviour when
// warmUpStartSample == captureStartSample.
//
//   renderStartSample = max(0, warmUpStartSample - totalPreroll)   // process from
//   discardSamples    = (captureStartSample - renderStartSample) + totalPreroll
//
// The first KEPT output sample then corresponds to the intended audio at
// captureStartSample with plugin/insert latency flushed — and, for a scoped
// absolute render (warmUpStartSample == 0), the engine has run from tick 0 so
// in-flight content survives.
struct RenderPrerollPlan {
    int64_t totalPrerollSamples     = 0;  // track + master insert latency
    int64_t renderStartSample       = 0;  // transport seek / first processed sample
    int64_t availablePrerollSamples = 0;  // samples processed before capture starts
    int64_t discardSamples          = 0;  // output samples discarded before capture
};

inline RenderPrerollPlan computeRenderPrerollPlan(int64_t warmUpStartSample,
                                                  int64_t captureStartSample,
                                                  int64_t trackLatencySamples,
                                                  int64_t masterLatencySamples)
{
    RenderPrerollPlan p;
    const int64_t track  = trackLatencySamples  < 0 ? 0 : trackLatencySamples;
    const int64_t master = masterLatencySamples < 0 ? 0 : masterLatencySamples;
    p.totalPrerollSamples = track + master;

    p.renderStartSample = warmUpStartSample - p.totalPrerollSamples;
    if (p.renderStartSample < 0) p.renderStartSample = 0;

    p.availablePrerollSamples = captureStartSample - p.renderStartSample;
    p.discardSamples          = p.availablePrerollSamples + p.totalPrerollSamples;
    return p;
}

// ─── Tail render policy (Phase 3A) ──────────────────────────────────────────────
// Pure derivation of the effect-tail rendering plan from the LoopRegion tail
// fields. Shared by AudioExporter and OfflineRenderer so audio-only and A/V
// exports agree on tail length and stop conditions.
//
//   HardCut   — no tail at all. Audio + video stop exactly at captureEnd. May
//               click/pop; the UI warns about this. (maxTailSamples == 0.)
//   TailClamp — no NEW notes/clips trigger past endTick (enforced by the engine
//               note-trigger ceiling), but existing effect wet tails ring out.
//               Audio renders past captureEnd until the output bus stays below
//               thresholdLinear for holdSamples, OR maxTailSamples is reached.
//               Video freezes the last captured frame for the tail duration so
//               the container's A/V lengths stay equal.
//
// Wrap (seamless loop) — Phase 3B / corrected in 3B-r1. A real tail-fold render:
// the post-end effect tail is captured into a working buffer and folded back onto
// the region head (output[i % regionLen] += tail[i]) so an exported loop joins
// into itself with no click at the seam. The final audio duration is EXACTLY the
// region length — the tail is internal working audio, never appended. Video is NOT
// folded or frozen for wrap (the region's frames render straight; loop
// seamlessness of the picture is the user's compositional responsibility).
//
// 3B-r1 CORRECTION: the Phase-2 absolute warm-up (tick 0 → startTick, discarded)
// is RETAINED — it supplies in-flight timeline context (notes/clips/effect tails
// already sounding at the region start). But the extra DISCARDED looped-region
// pre-roll ([startTick,endTick) rendered once to "prime the loop seam") is
// PROHIBITED: the fold itself supplies the loop-seam energy, so priming + folding
// double-counts it (~2× at the seam). The corrected render is strictly sequential
// — warm-up → capture → tail → fold — with no looped pre-roll and no backward
// seek. See renderWrapCore below and spec §7.3 (r1).
//
// Wrap requires a scoped loop region. Mapping a NON-scoped (full-timeline) render
// to Wrap is meaningless — there is no head to fold onto — so the scope-aware
// resolver (resolveTailPlanForScope) fails closed to TailClamp in that case.
// computeTailRenderPlan itself performs the pure enum mapping (Wrap → Wrap) and
// is the unit-tested contract; it MUST never silently degrade Wrap to HardCut or
// TailClamp.
enum class TailRenderMode { HardCut, TailClamp, Wrap };

// Stable lowercase label for logs/diagnostics (matches the model JSON strings).
inline const char* tailRenderModeName(TailRenderMode m) {
    switch (m) {
        case TailRenderMode::HardCut:   return "hardCut";
        case TailRenderMode::TailClamp: return "tailClamp";
        case TailRenderMode::Wrap:      return "wrap";
        default:                        return "hardCut";
    }
}

struct TailRenderPlan {
    TailRenderMode mode            = TailRenderMode::TailClamp;
    int64_t        maxTailSamples  = 0;       // hard cap = tailMaxSeconds * sampleRate
                                              //  (Wrap: cap on the internal fold
                                              //   tail; does NOT extend output)
    int64_t        holdSamples     = 0;       // sub-threshold hold (~50 ms)
    double         thresholdLinear = 0.001;   // 10^(tailThresholdDb/20)
    bool           freezeVideo     = false;   // freeze last frame for tail (TailClamp
                                              //  only; always false for Wrap)
};

// ~50 ms hold below threshold ends the tail early. Spec §3A.
inline int64_t tailHoldSamples(double sampleRate) {
    if (!(sampleRate > 0.0)) return 0;
    return static_cast<int64_t>(0.050 * sampleRate + 0.5);
}

inline double tailDbToLinear(double db) {
    return std::pow(10.0, db / 20.0);
}

// Derive the tail plan from the (already-persisted) LoopRegion. sampleRate must
// be the render sample rate. Inputs are re-sanitized here so a stale/garbage
// model value can never produce a non-finite cap or threshold.
inline TailRenderPlan computeTailRenderPlan(const LoopRegion& lr, double sampleRate)
{
    TailRenderPlan plan;
    const double sr = sampleRate > 0.0 ? sampleRate : 48000.0;

    const double thresholdDb  = sanitizeTailThresholdDb(lr.tailThresholdDb);
    const double maxSeconds   = sanitizeTailMaxSeconds(lr.tailMaxSeconds);
    plan.thresholdLinear = tailDbToLinear(thresholdDb);
    plan.holdSamples     = tailHoldSamples(sr);

    switch (lr.tailMode) {
        case LoopRegion::TailMode::HardCut:
            plan.mode           = TailRenderMode::HardCut;
            plan.maxTailSamples = 0;
            plan.freezeVideo    = false;
            break;
        case LoopRegion::TailMode::TailClamp:
            plan.mode           = TailRenderMode::TailClamp;
            plan.maxTailSamples = static_cast<int64_t>(maxSeconds * sr + 0.5);
            plan.freezeVideo    = true;
            break;
        case LoopRegion::TailMode::Wrap:
            // Phase 3B: real seamless-loop tail fold. The cap bounds the internal
            // fold tail (working audio); the final output duration stays exactly
            // the region length. Video is never frozen/extended for wrap.
            plan.mode           = TailRenderMode::Wrap;
            plan.maxTailSamples = static_cast<int64_t>(maxSeconds * sr + 0.5);
            plan.freezeVideo    = false;
            break;
        default:
            // Unknown/garbage enum — degrade to a hard cut, NEVER tailClamp.
            plan.mode           = TailRenderMode::HardCut;
            plan.maxTailSamples = 0;
            plan.freezeVideo    = false;
            break;
    }
    return plan;
}

// Scope-aware tail plan. Wrap only has meaning for a SCOPED loop-region render —
// folding the post-end tail back onto the region head requires a head to fold
// onto. For a non-scoped (full-timeline, loopEnabled == false) render there is no
// region to wrap, so wrap fails CLOSED to TailClamp (effects ring out + last
// frame frozen) rather than producing nonsense or a silent hard cut. The bridge
// calls this at the export boundary where `scoped` (== loopEnabled) is known;
// the pure computeTailRenderPlan above keeps the unmodified enum mapping for unit
// tests and for callers that have already guaranteed a scoped render.
inline TailRenderPlan resolveTailPlanForScope(const LoopRegion& lr,
                                              double sampleRate,
                                              bool scoped)
{
    TailRenderPlan plan = computeTailRenderPlan(lr, sampleRate);
    if (plan.mode == TailRenderMode::Wrap && !scoped) {
        // Full-timeline wrap is undefined — fall back to the documented safe
        // behaviour (tailClamp). This is the single policy point; never silent.
        plan.mode        = TailRenderMode::TailClamp;
        plan.freezeVideo = true;
    }
    return plan;
}

// ─── Tail fold (Wrap, sample domain, pure) ──────────────────────────────────────
// Folds `tailLen` post-end tail samples back onto the region head in place:
//
//     region[i % regionLen] += tail[i]   for i in [0, tailLen)
//
// Operates on one channel of plain float samples so it is unit-testable with no
// JUCE/audio dependency, and is only ever called on the control (render) thread —
// never the audio thread. `regionLen` must be > 0; a zero/negative region or tail
// is a no-op. The output buffer is NOT extended: a tail longer than the region
// wraps around and keeps accumulating onto the head (a genuinely seamless loop).
inline void foldTailIntoRegion(float* region, int regionLen,
                               const float* tail, int tailLen)
{
    if (region == nullptr || tail == nullptr || regionLen <= 0 || tailLen <= 0)
        return;
    int idx = 0;
    for (int i = 0; i < tailLen; ++i) {
        region[idx] += tail[i];
        if (++idx >= regionLen) idx = 0;
    }
}

// ─── Tail detector (sample domain, pure state machine) ──────────────────────────
// Fed one rendered block's peak (linear magnitude, 0..) plus the block length.
// The renderer reads the master-bus peak (a thread-safe atomic) on the control
// thread after each processBlock — NEVER on the audio thread. This keeps the
// audio thread allocation/lock/log-free while the stop decision stays here, pure.
struct TailDetectorState {
    int64_t tailSamples = 0;      // samples rendered into the tail so far
    int64_t belowRun    = 0;      // consecutive sub-threshold samples
    bool    done        = false;
    bool    endedByCap  = false;  // true: cap hit; false: threshold-hold ended it
};

inline void tailDetectorFeed(TailDetectorState& st, const TailRenderPlan& plan,
                             double blockPeakLinear, int64_t blockSamples)
{
    if (st.done || blockSamples <= 0) return;
    st.tailSamples += blockSamples;

    if (blockPeakLinear < plan.thresholdLinear) st.belowRun += blockSamples;
    else                                        st.belowRun  = 0;

    // Threshold-hold has priority so a genuinely-silent tail stops promptly even
    // when the cap is large.
    if (plan.holdSamples > 0 && st.belowRun >= plan.holdSamples) {
        st.done = true; st.endedByCap = false; return;
    }
    if (st.tailSamples >= plan.maxTailSamples) {
        st.done = true; st.endedByCap = true;
    }
}

// ─── Wrap render core (Phase 3B-r1, sample domain, engine-agnostic) ──────────────
// THE corrected seamless-loop tail-fold render sequence, shared by the audio-only
// exporter (AudioExporter::renderOfflineWrap) and the A/V renderer
// (OfflineRenderer::renderImplWrap) so they cannot diverge. Templated on the engine
// adapter callables (no JUCE/FFmpeg/Transport dependency here) so it is unit-tested
// directly with a deterministic delay engine — proving the 1× (not 2×) fold.
//
// The engine is driven STRICTLY SEQUENTIALLY — no looped-region pre-roll, no
// backward seek:
//
//   [renderStart ............... startTick) [startTick ...... endTick) [endTick ...
//    └─ discardSamples (DISCARDED) ─┘        └─ capture (regionLen) ─┘  └─ tail ─┘
//
//   • discardSamples = Phase-2 absolute warm-up (tick 0 → startTick) + PDC latency
//     flush. RETAINED — it recreates in-flight timeline context. NOT loop priming.
//   • capture flows straight out of the warm-up (no discontinuity / no seek).
//   • the post-end tail (no NEW triggers past endTick — setCeiling) is folded onto
//     the region head for its ENTIRE length: out[i % regionLen] += tail[i], wrapping
//     as many times as the tail is long. The output is NEVER extended.
//
// A looped-region pre-roll is intentionally absent: the fold supplies the loop-seam
// energy, so priming + folding would double-count it. The fold is LTI-exact;
// nonlinear effects (comp/limiter/distortion/modulation) are approximate.
//
// Engine adapter callables (duck-typed; all run on the control/render thread):
//   renderBlock(float* L, float* R, int n) — render the NEXT n samples sequentially
//                                            into L/R, advancing the transport. The
//                                            core NEVER requests a seek.
//   masterPeakLinear() -> double           — peak |sample| of the last block.
//   setCeiling(int64_t absSample)          — note-trigger ceiling (INT64_MAX = off).
//   shouldCancel() -> bool                 — abort if true.
//   onProgress(float p01)                  — capture progress 0..1 (may be a no-op).
//
// `scratchL/R` is block-sized throwaway space for the warm-up discard. `tailL/R`
// is the post-end tail working buffer (length >= effective cap). All buffers are
// caller-owned. Returns what happened (captured/tail/folded sample counts).
struct WrapRenderResult {
    int     capturedSamples = 0;   // == regionLen on success (< on cancel)
    int64_t tailSamples     = 0;   // detected post-end tail length
    int     foldedSamples   = 0;   // tail samples folded onto the head
    bool    cancelled       = false;
    bool    endedByCap      = false;
};

template <class RenderBlockFn, class PeakFn, class CeilingFn,
          class CancelFn, class ProgressFn>
inline WrapRenderResult renderWrapCore(
    float* outL, float* outR, int regionLen,
    int64_t discardSamples, int64_t captureEndSample,
    const TailRenderPlan& plan, int blockSize,
    float* scratchL, float* scratchR,
    float* tailL, float* tailR, int64_t tailCap,
    RenderBlockFn renderBlock, PeakFn masterPeakLinear,
    CeilingFn setCeiling, CancelFn shouldCancel, ProgressFn onProgress)
{
    WrapRenderResult r;
    if (outL == nullptr || outR == nullptr || regionLen <= 0) return r;
    if (blockSize <= 0) blockSize = 4096;

    // ── A. Absolute warm-up + latency flush — render & DISCARD discardSamples. ──
    // This is the ONLY warm-up. There is deliberately NO second (looped-region)
    // pre-roll: the fold below supplies the loop-seam energy.
    int64_t toDiscard = discardSamples < 0 ? 0 : discardSamples;
    while (toDiscard > 0) {
        if (shouldCancel()) { r.cancelled = true; return r; }
        const int n = static_cast<int>(std::min<int64_t>(blockSize, toDiscard));
        renderBlock(scratchL, scratchR, n);
        toDiscard -= n;
    }

    // ── B. Capture EXACTLY regionLen into the output (flows out of the warm-up). ──
    int pos = 0;
    while (pos < regionLen) {
        if (shouldCancel()) { r.cancelled = true; r.capturedSamples = pos; return r; }
        const int n = static_cast<int>(
            std::min<int64_t>(blockSize, static_cast<int64_t>(regionLen - pos)));
        renderBlock(outL + pos, outR + pos, n);
        pos += n;
        onProgress(static_cast<float>(pos) / static_cast<float>(regionLen));
    }
    r.capturedSamples = pos;

    // ── C. Post-end wet tail (no NEW triggers) + D. fold onto the region head. ──
    const int64_t cap = std::min<int64_t>(std::max<int64_t>(0, tailCap),
                                          std::max<int64_t>(0, plan.maxTailSamples));
    if (cap > 0 && tailL != nullptr && tailR != nullptr) {
        setCeiling(captureEndSample);
        TailDetectorState st;
        int64_t tpos = 0;
        while (!st.done && tpos < cap) {
            if (shouldCancel()) { r.cancelled = true; break; }
            const int n = static_cast<int>(std::min<int64_t>(blockSize, cap - tpos));
            renderBlock(tailL + tpos, tailR + tpos, n);
            const double peak = masterPeakLinear();
            tpos += n;
            tailDetectorFeed(st, plan, peak, n);
        }
        r.tailSamples = st.tailSamples;
        r.endedByCap  = st.endedByCap;
        setCeiling((std::numeric_limits<int64_t>::max)());

        // Fold the ENTIRE detected tail onto the head — multiple wraps included.
        const int foldLen = static_cast<int>(std::min<int64_t>(st.tailSamples, cap));
        foldTailIntoRegion(outL, regionLen, tailL, foldLen);
        foldTailIntoRegion(outR, regionLen, tailR, foldLen);
        r.foldedSamples = foldLen;
    }
    return r;
}

} // namespace xleth

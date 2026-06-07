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
// Wrap (seamless loop) — Phase 3B. A real tail-fold render: the post-end effect
// tail is captured into a working buffer and folded back onto the region head
// (output[i % regionLen] += tail[i]) so an exported loop crossfades into itself
// with no click at the seam. The final audio duration is EXACTLY the region
// length — the tail is internal working audio, never appended. Video is NOT
// folded or frozen for wrap (the region's frames render straight; loop
// seamlessness of the picture is the user's compositional responsibility).
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

} // namespace xleth

#include "render/SnapshotTransitionRenderer.h"

#include "render/FrameCollector.h"
#include "render/GridCompositor.h"
#include "render/RenderClock.h"
#include "render/SnapshotTransitionTiming.h"
#include "model/TimelineTypes.h"   // GridLayout, SnapshotTransition

#include <cmath>

namespace xleth {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Collect → dedup → resolve → decode → composite ONE snapshot's whole frame into
// a specific render target. This is the exact preview/export per-frame sequence,
// pointed at `rtv` instead of the compositor's member target, and forced onto a
// specific `layout` via collectRequests' layoutOverride.
//
// Latent-bug fix (Edge: Geometry): the per-snapshot columns/rows/gapScale come from
// THIS layout, not a separately-fetched active snapshot — so a cue that switches to
// a snapshot of different dimensions places its cells correctly.
void compositeSnapshotToTarget(const GridLayout&                  layout,
                               ID3D11RenderTargetView*            rtv,
                               int64_t                            collectFrameIndex,
                               int64_t                            collectProjectStartSample,
                               const Timeline&                    timeline,
                               const std::vector<VideoEvent>&     events,
                               GridCompositor&                    compositor,
                               FrameCollector&                    collector,
                               RenderFrameCache&                  cache,
                               const SnapshotTransitionFrameCtx&  ctx,
                               const DecodeMissesFn&              decodeMisses)
{
    auto requests = collector.collectRequests(
        collectFrameIndex, timeline, ctx.sampleRate, ctx.fps, events,
        ctx.allowProxy, collectProjectStartSample, ctx.posterMode,
        ctx.renderProxyBySource, &layout);

    auto deduplicated = FrameCollector::deduplicateRequests(requests);
    auto misses       = FrameCollector::resolveFrames(deduplicated, cache);
    if (decodeMisses) decodeMisses(misses);

    // Shader `time` is derived from THIS composite's absolute project sample so
    // preview and export animate identically (Edge: Determinism — no wall-clock).
    const int64_t sampleForFrame = collectProjectStartSample
        + RenderClock::videoFrameToSample(collectFrameIndex, ctx.sampleRate, ctx.fps);
    const float currentTime = static_cast<float>(
        RenderClock::sampleToSeconds(sampleForFrame, ctx.sampleRate));

    compositor.compositeFrame(requests, cache,
                              layout.columns, layout.rows,
                              currentTime, layout.gapScale, rtv);
}

} // namespace

bool renderSnapshotTransition(const Timeline::ResolvedTransition& rt,
                              const Timeline&                     timeline,
                              const std::vector<VideoEvent>&      events,
                              GridCompositor&                     compositor,
                              FrameCollector&                     collector,
                              RenderFrameCache&                   cache,
                              const SnapshotTransitionFrameCtx&   ctx,
                              const DecodeMissesFn&               decodeMisses,
                              TransitionFreezeState&              freeze)
{
    // [Edge: Perf floor] Everything below is gated on an active window. Outside a
    // window this returns immediately and the caller keeps its single-composite
    // path, so non-transition frames are byte-identical to today at zero overhead.
    if (!rt.active) { freeze.invalidate(); return false; }
    if (!compositor.isInitialized()) return false;

    // [Edge: Determinism] pin/start/end ticks → samples via RenderClock only, and
    // `t` from progressForSample over those samples. No wall-clock reaches `t` or
    // the frozen-A tick, which is what makes preview==export frame for frame.
    const int64_t pinSample   = RenderClock::ppqToSample(rt.pinTick.ticks,   ctx.sampleRate, ctx.bpm);
    const int64_t startSample = RenderClock::ppqToSample(rt.startTick.ticks, ctx.sampleRate, ctx.bpm);
    const int64_t endSample   = RenderClock::ppqToSample(rt.endTick.ticks,   ctx.sampleRate, ctx.bpm);
    const int64_t S = ctx.projectStartSample
        + RenderClock::videoFrameToSample(ctx.outputFrameIndex, ctx.sampleRate, ctx.fps);
    const float t = static_cast<float>(
        progressForSample(S, startSample, pinSample, endSample));

    // Reserved slot-4 pair: RT_A = texA/rtvA/srvA, RT_B = texB/rtvB/srvB. One cached
    // acquire per output size (Edge: Perf floor — no per-frame allocation).
    RTPool::RTPair& pair = compositor.acquireTransitionTargets();
    if (!pair.rtvA || !pair.rtvB || !pair.srvA || !pair.srvB) return false;

    // ── Incoming snapshot B — composited EVERY frame at this frame's live tick ──
    compositeSnapshotToTarget(rt.layoutB, pair.rtvB.Get(),
                              ctx.outputFrameIndex, ctx.projectStartSample,
                              timeline, events, compositor, collector, cache,
                              ctx, decodeMisses);

    // ── Outgoing snapshot A ─────────────────────────────────────────────────────
    // [Edge: Freeze cache] freezeOutgoing composites A ONCE at the FIXED pin tick
    // and holds it in RT_A across the window (only B advances). The cache is keyed
    // on pinSample AND the RT identity, so a re-pinned cue, a resolution change
    // (new slot-4 texture), or a seek-out (rt.active==false → invalidate above) all
    // force a fresh A composite. The frozen tick is the PIN — derived from
    // RenderClock, never "whatever frame preview was on" — or preview!=export.
    bool needComposeA = true;
    if (rt.freezeOutgoing && freeze.valid
        && freeze.pinSample == pinSample
        && freeze.texA == pair.texA.Get()) {
        needComposeA = false;   // RT_A already holds frozen A for this pin
    }
    if (needComposeA) {
        // Frozen A: sample at the pin (collect frame 0 with projectStart = pinSample).
        // Live A: sample at this frame, exactly like B.
        const int64_t aFrameIndex   = rt.freezeOutgoing ? 0         : ctx.outputFrameIndex;
        const int64_t aProjectStart = rt.freezeOutgoing ? pinSample : ctx.projectStartSample;
        compositeSnapshotToTarget(rt.layoutA, pair.rtvA.Get(),
                                  aFrameIndex, aProjectStart,
                                  timeline, events, compositor, collector, cache,
                                  ctx, decodeMisses);
        if (rt.freezeOutgoing) {
            freeze.valid     = true;
            freeze.pinSample = pinSample;
            freeze.texA      = pair.texA.Get();
        } else {
            freeze.invalidate();   // live A holds no reusable cache
        }
    }

    // ── Blend ───────────────────────────────────────────────────────────────────
    // Type → shader mode. Crossfade=0, LineSweep=1; every other type falls back to
    // Crossfade for now (Slice 3b ships crossfade + one directional sweep). This
    // pass is NOT bypassable (Edge: effectsBypass_ divergence) — preview's fast
    // path never skips it, so preview and export apply it identically.
    const int mode = (rt.type == SnapshotTransition::Type::LineSweep) ? 1 : 0;
    const float angleRad = static_cast<float>(rt.geomAngleDeg * kPi / 180.0);
    compositor.transitionPass(pair.srvA.Get(), pair.srvB.Get(), mode, t, angleRad);
    return true;
}

} // namespace xleth

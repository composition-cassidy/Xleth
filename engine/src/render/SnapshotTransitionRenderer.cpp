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

int shaderModeForTransition(SnapshotTransition::Type type)
{
    switch (type) {
        case SnapshotTransition::Type::Crossfade: return 0;
        case SnapshotTransition::Type::LineSweep: return 1;
        case SnapshotTransition::Type::Push:      return 2;
        case SnapshotTransition::Type::Slide:     return 3;
        case SnapshotTransition::Type::Zoom:      return 4;
        case SnapshotTransition::Type::Dissolve:  return 5;
        case SnapshotTransition::Type::OutThenIn: return 6;
        case SnapshotTransition::Type::RadialReveal: return 7;
        case SnapshotTransition::Type::Pixelate:     return 8;
        case SnapshotTransition::Type::Glitch:       return 9;
        case SnapshotTransition::Type::BlurThrough:  return 10;
        case SnapshotTransition::Type::Displacement: return 11;
    }
    return 0;
}

float shaderAngleRad(const Timeline::ResolvedTransition& rt)
{
    double angleDeg = rt.geomAngleDeg;
    if (rt.type == SnapshotTransition::Type::Push
        || rt.type == SnapshotTransition::Type::Slide) {
        angleDeg = std::fmod(std::round(angleDeg / 90.0) * 90.0 + 360.0, 360.0);
    }
    return static_cast<float>(angleDeg * kPi / 180.0);
}

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
                              const DecodeMissesFn&               decodeMisses)
{
    // [Edge: Perf floor] Everything below is gated on an active window. Outside a
    // window this returns immediately and the caller keeps its single-composite
    // path, so non-transition frames are byte-identical to today at zero overhead.
    if (!rt.active) return false;
    if (!compositor.isInitialized()) return false;

    // [Edge: Determinism] pin/start/end ticks → samples via RenderClock only, and
    // `t` from progressForSample + the cue's two easing curves over those samples.
    // No wall-clock reaches `t` or either snapshot's frame selection, which makes
    // preview==export frame for frame.
    const int64_t pinSample   = RenderClock::ppqToSample(rt.pinTick.ticks,   ctx.sampleRate, ctx.bpm);
    const int64_t startSample = RenderClock::ppqToSample(rt.startTick.ticks, ctx.sampleRate, ctx.bpm);
    const int64_t endSample   = RenderClock::ppqToSample(rt.endTick.ticks,   ctx.sampleRate, ctx.bpm);
    const int64_t S = ctx.projectStartSample
        + RenderClock::videoFrameToSample(ctx.outputFrameIndex, ctx.sampleRate, ctx.fps);
    const double linearProgress = progressForSample(
        S, startSample, pinSample, endSample);
    const float t = static_cast<float>(applySnapshotTransitionEasing(
        linearProgress, rt.startToPinEasing, rt.pinToEndEasing));

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
    // Outgoing snapshot A is also composited every frame at this frame's live tick.
    // A receives the exact same live frame context as B. It remains temporally
    // aligned throughout the active window and is naturally abandoned when the
    // caller returns to its single-layout path after the transition.
    compositeSnapshotToTarget(rt.layoutA, pair.rtvA.Get(),
                              ctx.outputFrameIndex, ctx.projectStartSample,
                              timeline, events, compositor, collector, cache,
                              ctx, decodeMisses);

    // ── Blend ───────────────────────────────────────────────────────────────────
    // The pass is NOT bypassable (Edge: effectsBypass_ divergence): preview and
    // export map the authored type and parameters through this exact call.
    compositor.transitionPass(pair.srvA.Get(), pair.srvB.Get(),
                              shaderModeForTransition(rt.type), t, shaderAngleRad(rt),
                              rt.edgeSoftness, rt.zoomAmount, rt.dissolveGrainPx,
                              rt.radialOriginX, rt.radialOriginY,
                              rt.pixelateMaxBlockPx,
                              rt.glitchIntensity, rt.glitchBlockPx,
                              rt.blurRadiusPx,
                              rt.displacementAmount, rt.displacementScale,
                              rt.effectSeed);
    return true;
}

} // namespace xleth

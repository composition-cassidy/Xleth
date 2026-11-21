#include "render/LandingRenderer.h"

#include "render/GridCompositor.h"
#include "render/LandingMath.h"
#include "render/RenderClock.h"
#include "model/TimelineTypes.h"   // GridLayout, GridSlot

#include <algorithm>
#include <climits>

namespace xleth {

namespace {

// Matches FrameCollector's own cull: a request that provably cannot appear is
// dropped before dedup / decode / draw.
constexpr float kCarryOpacityCullEpsilon = 1e-4f;

bool isLandingTrack(const Timeline::ResolvedLandings& landings, int trackId)
{
    for (int i = 0; i < landings.count; ++i)
        if (landings.items[i].trackId == trackId) return true;
    return false;
}

int64_t frameSample(const SnapshotTransitionFrameCtx& ctx)
{
    return ctx.projectStartSample
        + RenderClock::videoFrameToSample(ctx.outputFrameIndex, ctx.sampleRate, ctx.fps);
}

} // namespace

void LandingRenderer::beginFrame(const Timeline::ResolvedLandings& landings,
                                 FrameCollector&                   collector)
{
    if (landings.count <= 0) {
        // Perf floor: a frame without landings pays this compare and nothing
        // else. The clear only runs on the first frame after a landing window.
        if (collector.holdKeepTrackCount() != 0)
            collector.setHoldKeepTracks(nullptr, 0);
        return;
    }
    int ids[TrackLanding::kMaxLandingsPerCue];
    const int count = std::min(landings.count, TrackLanding::kMaxLandingsPerCue);
    for (int i = 0; i < count; ++i) ids[i] = landings.items[i].trackId;
    collector.setHoldKeepTracks(ids, count);
}

void LandingRenderer::stripLandingTracks(const Timeline::ResolvedLandings& landings,
                                         GridLayout&                       layout)
{
    if (landings.count <= 0) return;
    layout.slots.erase(
        std::remove_if(layout.slots.begin(), layout.slots.end(),
            [&](const GridSlot& s) { return isLandingTrack(landings, s.trackId); }),
        layout.slots.end());
    layout.fullscreenLayers.erase(
        std::remove_if(layout.fullscreenLayers.begin(), layout.fullscreenLayers.end(),
            [&](const FullscreenLayer& fl) { return isLandingTrack(landings, fl.trackId); }),
        layout.fullscreenLayers.end());
}

void LandingRenderer::collectCarry(const Timeline::ResolvedLandings&  landings,
                                   const Timeline&                    timeline,
                                   const std::vector<VideoEvent>&     events,
                                   FrameCollector&                    collector,
                                   const SnapshotTransitionFrameCtx&  ctx,
                                   bool                               applyPreviewEffectMute,
                                   int                                zOrderBase)
{
    carryRequests_.clear();
    if (landings.count <= 0) return;

    // The carry layout: snapshot B's geometry, and nothing but the landing
    // tracks' B slots (copied out of the resolved set, so no GridLayout is
    // copied here). The collector reads the arrangement fields only.
    carry_.columns  = landings.columns;
    carry_.rows     = landings.rows;
    carry_.gapScale = landings.gapScale;
    carry_.fullscreenLayers.clear();
    carry_.slots.resize(static_cast<size_t>(landings.count));
    for (int i = 0; i < landings.count; ++i) {
        const Timeline::ResolvedLanding& l = landings.items[i];
        GridSlot& s = carry_.slots[static_cast<size_t>(i)];
        s.trackId = l.trackId;
        s.gridX   = l.slotGridX;
        s.gridY   = l.slotGridY;
        s.spanX   = l.slotSpanX;
        s.spanY   = l.slotSpanY;
        s.opacity = l.slotOpacity;
        s.zOrder  = l.slotZOrder;
        s.eventActions.clear();
    }

    // This layout places ONLY the landing tracks. Left on, the hold GC would
    // take it to mean every other track has left the grid and forget their
    // held frames (audit D2).
    collector.setHoldGcEnabled(false);
    std::vector<CellFrameRequest>& collected = collector.collectRequests(
        ctx.outputFrameIndex, timeline, ctx.sampleRate, ctx.fps, events,
        ctx.allowProxy, ctx.projectStartSample, ctx.posterMode,
        ctx.renderProxyBySource, &carry_, applyPreviewEffectMute);
    collector.setHoldGcEnabled(true);

    // Progress is a pure function of the frame's absolute project sample; the
    // tick -> sample conversions are the transition path's.
    const int64_t S    = frameSample(ctx);
    const int64_t pinS = RenderClock::ppqToSample(landings.pinTick.ticks, ctx.sampleRate, ctx.bpm);

    // Landing-list order is draw order among the carried tracks. The collector
    // returned them sorted by slot zOrder, so re-walk by landing. Moving the
    // elements out is fine: `collected` is rebuilt by the next collect.
    int nextZOrder = zOrderBase;
    for (int i = 0; i < landings.count; ++i) {
        const Timeline::ResolvedLanding& l = landings.items[i];
        const int64_t startS =
            RenderClock::ppqToSample(l.startTick.ticks, ctx.sampleRate, ctx.bpm);
        const landing::Pose pose = landing::evaluateLanding(l, S, startS, pinS);

        for (CellFrameRequest& req : collected) {
            if (req.trackId != l.trackId || req.layerKind != CellLayerKind::Grid) continue;
            req.hasCanvasRect     = true;
            req.canvasRect[0]     = pose.x;
            req.canvasRect[1]     = pose.y;
            req.canvasRect[2]     = pose.w;
            req.canvasRect[3]     = pose.h;
            req.canvasRoamUnit[0] = pose.unitW;
            req.canvasRoamUnit[1] = pose.unitH;
            req.opacity          *= pose.opacity;
            req.zOrder            = nextZOrder;
            if (nextZOrder < INT_MAX) ++nextZOrder;
            if (req.opacity <= kCarryOpacityCullEpsilon) continue;   // fully faded: not drawn
            carryRequests_.push_back(std::move(req));
        }
    }
}

std::vector<CellFrameRequest>& LandingRenderer::collectFrame(
    const Timeline::ResolvedLandings&  landings,
    const GridLayout&                  frameLayout,
    const Timeline&                    timeline,
    const std::vector<VideoEvent>&     events,
    FrameCollector&                    collector,
    const SnapshotTransitionFrameCtx&  ctx,
    bool                               applyPreviewEffectMute)
{
    // 1. The frame's own layout without the landing tracks.
    stripped_ = frameLayout;
    stripLandingTracks(landings, stripped_);

    std::vector<CellFrameRequest>& base = collector.collectRequests(
        ctx.outputFrameIndex, timeline, ctx.sampleRate, ctx.fps, events,
        ctx.allowProxy, ctx.projectStartSample, ctx.posterMode,
        ctx.renderProxyBySource, &stripped_, applyPreviewEffectMute);

    // The collector's buffer is overwritten by the carry collect below, so
    // take its contents. A swap, not a copy: each side keeps a buffer with
    // capacity and no request (nor its effect chain) is duplicated.
    frameRequests_.clear();
    frameRequests_.swap(base);

    // 2. The carried tracks, above every other request.
    int zOrderBase = 0;
    for (const CellFrameRequest& r : frameRequests_)
        zOrderBase = std::max(zOrderBase, r.zOrder);
    if (zOrderBase < INT_MAX) ++zOrderBase;

    collectCarry(landings, timeline, events, collector, ctx, applyPreviewEffectMute, zOrderBase);
    // Moved, not copied: carryRequests_ is rebuilt by the next call anyway.
    for (CellFrameRequest& r : carryRequests_)
        frameRequests_.push_back(std::move(r));
    carryRequests_.clear();
    return frameRequests_;
}

void LandingRenderer::renderCarryOverlay(const Timeline::ResolvedLandings&  landings,
                                         const Timeline&                    timeline,
                                         const std::vector<VideoEvent>&     events,
                                         GridCompositor&                    compositor,
                                         FrameCollector&                    collector,
                                         RenderFrameCache&                  cache,
                                         const SnapshotTransitionFrameCtx&  ctx,
                                         const DecodeMissesFn&              decodeMisses)
{
    if (landings.count <= 0) return;
    if (!compositor.isInitialized()) return;

    // Same collect flags as the transition's own two collects: the transition
    // renderer never applies the preview-only effect mute.
    collectCarry(landings, timeline, events, collector, ctx,
                 /*applyPreviewEffectMute=*/false, /*zOrderBase=*/0);
    if (carryRequests_.empty()) return;

    auto deduplicated = FrameCollector::deduplicateRequests(carryRequests_);
    auto misses       = FrameCollector::resolveFrames(deduplicated, cache);
    if (decodeMisses) decodeMisses(misses);

    // Shader time from this frame's absolute project sample, exactly as the
    // transition's composites derive it.
    const float currentTime = static_cast<float>(
        RenderClock::sampleToSeconds(frameSample(ctx), ctx.sampleRate));

    // Onto the readback target the transition pass just wrote, without
    // clearing it. Grid size and gap are passed for completeness; a carried
    // request names its own rect and ignores them.
    compositor.compositeOverlay(carryRequests_, cache,
                                landings.columns, landings.rows,
                                currentTime, landings.gapScale, nullptr);
}

} // namespace xleth

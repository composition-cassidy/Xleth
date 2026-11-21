#pragma once

// ---------------------------------------------------------------------------
// LandingRenderer — the ONE code path that carries landing tracks
// (docs/XLETH_LANDING_SPEC.md §6.3). The live preview seam
// (XlethEngineService.cpp) and the offline export seam (OfflineRenderer.cpp)
// both call it, so a landing renders identically in preview and export.
//
// A Landing is one track flying into its slot in a cue's incoming snapshot (B),
// ending on the cue pin. From the start of the lead-in to the end of the cue's
// transition window the track is CARRIED: removed from every composite that
// would otherwise draw it and drawn once, on top, at its in-flight rect.
//
// Per frame, with L = timeline.landingsAt(frameTick):
//
//   L.count == 0            nothing here runs. The caller keeps today's code,
//                           byte-identical (spec ruling 9). Call beginFrame
//                           all the same: it is what releases the collector's
//                           hold guard after the last landing frame.
//
//   no transition active    requests = collectFrame(...). The frame's layout
//                           is collected WITHOUT the landing tracks, then a
//                           carry layout (B's geometry, only the landing
//                           tracks' B slots) is collected and its requests are
//                           appended, posed, above everything. The caller
//                           dedups / decodes / composites that list exactly as
//                           it does an ordinary frame's.
//
//   transition active       stripLandingTracks(rt.layoutA / rt.layoutB), then
//                           renderSnapshotTransition as before, then
//                           renderCarryOverlay(...) draws the carried tracks
//                           onto the blended readback target without clearing
//                           it. Without this a Push would split a landing
//                           track across A and B and a crossfade would dim it.
//
// Determinism (ruling 8): the pose comes from landing::evaluateLanding over
// RenderClock sample positions only. No wall clock.
//
// Thread-safety: like renderSnapshotTransition, every collect here reads the
// Timeline, so the caller holds its model lock (preview: syncEventsMutex)
// across collectFrame, and across the whole transition frame as it already
// does. `landings` is plain data taken under that lock.
//
// Allocation: the two layouts and the two request lists are members that keep
// their capacity, so a steady run of landing frames does not allocate here.
// ---------------------------------------------------------------------------

#include <vector>

#include "model/Timeline.h"                    // Timeline::ResolvedLandings
#include "render/FrameCollector.h"             // CellFrameRequest
#include "render/SnapshotTransitionRenderer.h" // SnapshotTransitionFrameCtx, DecodeMissesFn

class GridCompositor;
struct VideoEvent;

namespace xleth {

class LandingRenderer
{
public:
    // Once per output frame, BEFORE the frame's first collectRequests, whether
    // or not anything lands. Tells the collector which tracks' held frames
    // must survive this frame's extra collects (audit D2); with no landings it
    // clears that, at the cost of one integer compare.
    static void beginFrame(const Timeline::ResolvedLandings& landings,
                           FrameCollector&                   collector);

    // Frame WITHOUT an active transition. Returns the frame's complete request
    // list: `frameLayout` minus the landing tracks, in the collector's order,
    // then the carried requests in landing-list order. Valid until the next
    // call on this instance. Requires landings.count > 0.
    //
    // `frameLayout` is the layout the caller would have collected with
    // (gridLayoutAt(frameTick)). `applyPreviewEffectMute` mirrors the caller's
    // own collect (the live preview passes true, export false).
    std::vector<CellFrameRequest>& collectFrame(
        const Timeline::ResolvedLandings&  landings,
        const GridLayout&                  frameLayout,
        const Timeline&                    timeline,
        const std::vector<VideoEvent>&     events,
        FrameCollector&                    collector,
        const SnapshotTransitionFrameCtx&  ctx,
        bool                               applyPreviewEffectMute = false);

    // Transition frame, step 1: remove every slot and fullscreen layer of a
    // landing track from one of the transition's layouts (they are by value).
    static void stripLandingTracks(const Timeline::ResolvedLandings& landings,
                                   GridLayout&                       layout);

    // Transition frame, step 2, after renderSnapshotTransition returned true:
    // collect the carry layout, decode what it needs through `decodeMisses`,
    // and draw it over the blended frame in the readback target. The caller
    // then calls compositor.readback() as usual.
    void renderCarryOverlay(const Timeline::ResolvedLandings&  landings,
                            const Timeline&                    timeline,
                            const std::vector<VideoEvent>&     events,
                            GridCompositor&                    compositor,
                            FrameCollector&                    collector,
                            RenderFrameCache&                  cache,
                            const SnapshotTransitionFrameCtx&  ctx,
                            const DecodeMissesFn&              decodeMisses);

    // The carried requests the last renderCarryOverlay drew, posed and in draw
    // order. For tests and diagnostics. (collectFrame hands its carried
    // requests to the list it returns instead: look for hasCanvasRect there.)
    const std::vector<CellFrameRequest>& lastOverlayRequests() const { return carryRequests_; }

private:
    // Collect the carry layout and leave its requests in carryRequests_: only
    // the landing tracks, each with its in-flight rect, Roam unit and opacity,
    // in landing-list order. `zOrderBase` is the first zOrder to hand out.
    void collectCarry(const Timeline::ResolvedLandings&  landings,
                      const Timeline&                    timeline,
                      const std::vector<VideoEvent>&     events,
                      FrameCollector&                    collector,
                      const SnapshotTransitionFrameCtx&  ctx,
                      bool                               applyPreviewEffectMute,
                      int                                zOrderBase);

    GridLayout                    stripped_;       // frame layout minus the landing tracks
    GridLayout                    carry_;          // B's geometry, only the landing tracks' slots
    std::vector<CellFrameRequest> frameRequests_;  // collectFrame's result
    std::vector<CellFrameRequest> carryRequests_;  // the carried requests, posed
};

} // namespace xleth

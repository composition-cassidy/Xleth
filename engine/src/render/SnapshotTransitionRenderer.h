#pragma once

// ---------------------------------------------------------------------------
// SnapshotTransitionRenderer — the ONE code path that drives a snapshot
// transition (Slice 3b). Both the live preview seam (XlethEngineService.cpp)
// and the offline export seam (OfflineRenderer.cpp) call renderSnapshotTransition
// so that a transition renders IDENTICALLY in preview and export, frame for frame.
//
// A transition blends the fully-composited OUTGOING snapshot (layoutA) and the
// fully-composited INCOMING snapshot (layoutB) across a cue's window:
//
//   collect+composite B   -> RT_B   (every frame, at this frame's live tick)
//   collect+composite A   -> RT_A   (every frame, at the same live tick)
//   transitionPass(A, B)  -> the compositor readback target
//
// The caller then calls compositor.readback() exactly as it does for a normal
// single-composite frame — the readback surface is unchanged.
//
// Determinism (Edge: Determinism): progress `t` and both snapshots' live frames
// derive ONLY from RenderClock sample positions passed in via
// SnapshotTransitionFrameCtx; there is no wall-clock anywhere in this path.
// Because preview and export both feed the same absolute project sample for a
// given output frame, they compute the same t, composite the same snapshots, and
// read back identical pixels.
//
// Thread-safety (Edge: Thread-safety): the caller resolves Timeline::transitionAt
// under its own lock (syncEventsMutex in preview) and passes the result BY VALUE.
// ResolvedTransition owns layoutA/layoutB by value, so nothing here aliases a live
// GridCue / GridSnapshot / GridLayout across the two composite calls.
// ---------------------------------------------------------------------------

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" {
#include <libavutil/rational.h>
}

#include "model/Timeline.h"      // Timeline, Timeline::ResolvedTransition
#include "render/FrameCache.h"   // FrameCacheKey, RenderFrameCache

class FrameCollector;
class GridCompositor;
struct VideoEvent;

namespace xleth {

// Timing + collection parameters for ONE output frame, shared by preview/export.
// The incoming snapshot B and outgoing snapshot A are both collected with
// (outputFrameIndex, projectStartSample); the frame's absolute project sample is
// S = projectStartSample + RenderClock::videoFrameToSample(outputFrameIndex).
struct SnapshotTransitionFrameCtx {
    int        sampleRate            = 48000;
    double     bpm                   = 140.0;
    AVRational fps                   = { 30, 1 };
    int64_t    outputFrameIndex      = 0;      // frame index handed to collectRequests
    int64_t    projectStartSample    = 0;      // absolute-sample origin of frame 0
    bool       allowProxy            = true;   // mirrors the caller's normal collect
    bool       posterMode            = false;  // mirrors the caller's normal collect
    const std::unordered_map<int, std::string>* renderProxyBySource = nullptr;
};

// Callback the caller supplies to decode cache misses for one snapshot's requests.
// (Preview wraps g_previewRenderDecoder; export wraps its local RenderVideoDecoder;
// the determinism test synthesizes solid textures — the helper stays decoder-
// agnostic so it can run in a GPU test without a real video file.)
using DecodeMissesFn = std::function<void(const std::vector<FrameCacheKey>&)>;

// Render the active transition window into the compositor's readback target.
//
// Returns true when a transition was rendered — the caller then calls
// compositor.readback() as usual and MUST skip its own single-composite call.
// Returns false when `rt` is inactive or prerequisites are missing; the caller
// keeps its normal single-composite path (Edge: Perf floor — the whole two-RT
// path is gated on the active window, so outside a window there is zero overhead
// and byte-identical output to today).
bool renderSnapshotTransition(const Timeline::ResolvedTransition& rt,
                              const Timeline&                     timeline,
                              const std::vector<VideoEvent>&      events,
                              GridCompositor&                     compositor,
                              FrameCollector&                     collector,
                              RenderFrameCache&                   cache,
                              const SnapshotTransitionFrameCtx&   ctx,
                              const DecodeMissesFn&               decodeMisses);

} // namespace xleth

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
//   collect+composite A   -> RT_A   (freeze: once at the pin tick; else per frame)
//   transitionPass(A, B)  -> the compositor readback target
//
// The caller then calls compositor.readback() exactly as it does for a normal
// single-composite frame — the readback surface is unchanged.
//
// Determinism (Edge: Determinism): progress `t` and the frozen-A tick derive ONLY
// from RenderClock sample positions passed in via SnapshotTransitionFrameCtx; there
// is no wall-clock anywhere in this path. Because preview and export both feed the
// same absolute project sample for a given output frame, they compute the same t,
// composite the same snapshots, and read back identical pixels.
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

// Forward-declare the only D3D type this header names (a pointer). Pulling in
// <d3d11.h> here would drag <windows.h> — and its min/max macros — into every
// consumer, breaking std::min/std::max in model headers. The .cpp includes the
// real D3D headers (via GridCompositor.h, which defines NOMINMAX first).
struct ID3D11Texture2D;

class FrameCollector;
class GridCompositor;
struct VideoEvent;

namespace xleth {

// Timing + collection parameters for ONE output frame, shared by preview/export.
// The incoming snapshot B (and a non-frozen outgoing A) are collected with
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

// Per-caller state that lets the outgoing snapshot A be composited ONCE and held
// across the window when freezeOutgoing is set (Edge: Freeze cache). Keyed on the
// pin sample and the RT identity, so a re-pinned cue, a resolution change, or a
// seek-out all force a fresh A composite. Declare one per render loop; the preview
// seam keeps a file-scope instance, each export keeps a local one.
struct TransitionFreezeState {
    bool             valid     = false;
    int64_t          pinSample = 0;
    ID3D11Texture2D* texA      = nullptr;   // identity of the RT the frozen A lives in
    void invalidate() { valid = false; texA = nullptr; }
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
                              const DecodeMissesFn&               decodeMisses,
                              TransitionFreezeState&              freeze);

} // namespace xleth

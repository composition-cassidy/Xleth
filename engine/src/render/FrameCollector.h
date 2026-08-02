#pragma once

/**
 * FrameCollector — Source-level deduplication for the render pipeline.
 *
 * A 4x4 grid with 16 active cells is NOT 16 independent videos.  It is 16
 * views into the SAME sources at different timestamps.  If 12 cells show
 * source frame 4200, we decode that frame ONCE, not 12 times.
 *
 * Pipeline:
 *   1. collectRequests()        — scan grid + timeline → CellFrameRequest list
 *   2. deduplicateRequests()    — group by (sourcePath, frameIndex) → unique keys
 *   3. resolveFrames()          — for each unique key: cache hit or decode
 *
 * Stateful: the chorus layer holds its last decoded frame across gaps
 * so the background never goes black between chorus clips.
 * Runs on the render thread only.
 */

#include <cstdint>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "FrameCache.h"          // FrameCacheKey
#include "RenderClock.h"         // sampleToVideoFrame, videoFrameToSample
#include "model/ClipCompanionFxSnapshot.h" // ClipCompanionFxSnapshot (shared with preview)

// Forward declarations — avoid pulling heavy headers into every consumer
class Timeline;
struct GridLayout;
struct GridSlot;
struct PingPongSettings;
struct TrackInfo;
struct VideoEvent;
struct VisualEffect;

class AnimationManager;

// ---------------------------------------------------------------------------
// CellLayerKind — distinguishes which compositor pass a request belongs to.
// Replaces the previous (isChorus, isCrash) bool pair.
// ---------------------------------------------------------------------------
enum class CellLayerKind : uint8_t {
    Grid              = 0,  // normal grid cell (Pass 2)
    FullscreenBehind  = 1,  // fullscreen layer drawn before grid (Pass 1)
    FullscreenInFront = 2,  // fullscreen layer drawn after grid (Pass 3)
};

// ClipCompanionFxSnapshot moved to model/ClipCompanionFxSnapshot.h so the
// realtime preview path (SyncManager → VideoCompositor) and the export path
// (this file → GridCompositor) share one definition. Included above.

// ---------------------------------------------------------------------------
// CellFrameRequest — what one grid cell needs for this output frame
// ---------------------------------------------------------------------------
struct CellFrameRequest {
    int         cellRow          = 0;   // fine-grid Y (kGridSubUnitsPerRow per row)
    int         cellCol          = 0;   // fine-grid X (kGridSubUnitsPerColumn per col)
    int         spanX            = 8;   // fine-grid units wide (default = full column)
    int         spanY            = 8;   // fine-grid units tall (default = full row)
    std::string sourcePath;             // source file path
    int         sourceId         = -1;  // SourceMedia ID (for decoder lookup)
    int64_t     sourceFrameIndex = 0;   // frame number in source file
    float       opacity          = 1.0f;// slot.opacity * event.opacity
    // ── Flip v2 (sent to the GPU as `orientation` in CellConstants) ───────
    // Populated from VideoEvent.stateIndex / VideoEvent.orientation, which
    // VideoFlipApplier wrote during the build pass.
    int         stateIndex       = 0;   // resolved state machine index (analytics; not on GPU)
    int         orientation      = 0;   // Orientation enum as int — drives the shader UV transform
    int         trackId          = -1;  // originating track
    CellLayerKind layerKind      = CellLayerKind::Grid;
    int         zOrder           = 0;   // from GridSlot
    float       gapScaleOverride = -1.0f; // -1 = use global, >=0 = per-track override

    // Animation state snapshot (set by FrameCollector from AnimationManager)
    float cornerRadius    = 0.0f;
    float currentZoom     = 1.0f;   // MUST default to 1.0 (0 = black frame)
    float currentPanX     = 0.0f;
    float currentPanY     = 0.0f;
    float currentRotDeg   = 0.0f;
    float bounceOffsetX   = 0.0f;
    float bounceOffsetY   = 0.0f;
    float bounceScaleX    = 1.0f;   // MUST default to 1.0
    float bounceScaleY    = 1.0f;   // MUST default to 1.0

    // Slide-triggered TV ramp snapshot. tvRampIntensity is the per-frame
    // animated value; the other 6 fields define the character of the slide TV
    // effect for the duration of the ramp. GridCompositor reads all 7 to drive
    // the slide TV pass that runs independently after the visual chain.
    float tvRampIntensity = 0.0f;
    float tvRampRollSpeed  = 1.0f;
    float tvRampScanlines  = 0.3f;
    float tvRampChroma     = 0.003f;
    float tvRampNoise      = 0.0f;
    float tvRampJitter     = 2.0f;
    float tvRampColorBleed = 0.0f;

    // Ping-pong crossfade: secondary frame to blend with primary (-1 = no blend)
    int64_t pingPongSecondaryFrame = -1;
    float   pingPongBlendFactor    = 0.0f;  // 0.0 = full primary, 1.0 = full secondary

    // Value snapshot of the track's visual effect chain, taken at collect
    // time. Bug 1 fix: this used to be `const std::vector<VisualEffect>*`
    // aliasing TrackInfo::visualEffectChain directly. GridCompositor
    // dereferences/iterates it during GPU compositing later in the same
    // tick; the bridge-thread add/remove/reorder/param-write handlers
    // (Timeline_*VisualEffect* in XlethEngineService.cpp) mutate that same
    // vector (push_back/erase/insert — all potentially reallocating) and
    // did not synchronize against the video thread at all. A copy taken
    // under syncEventsMutex (the same lock those handlers now acquire, see
    // XlethEngineService.cpp) removes the aliasing entirely — the compositor
    // never again touches live, mutable Track state. Bounded cost: capped at
    // 16 entries. Matches the no-pointers-to-mutable-state discipline
    // already used by companionFx below.
    std::vector<VisualEffect> visualChain;

    // Clip-local automatic visual FX snapshot. This intentionally contains
    // only plain values; never store pointers to mutable Clip objects here.
    ClipCompanionFxSnapshot companionFx;
};

// ---------------------------------------------------------------------------
// FrameCollector — stateless utility, all methods work per output frame
// ---------------------------------------------------------------------------
class FrameCollector
{
public:
    FrameCollector() = default;

    void setAnimationManager(AnimationManager* mgr) { animationMgr_ = mgr; }
    void setCompanionFxEnabled(bool enabled) { companionFxEnabled_ = enabled; }
    bool companionFxEnabled() const { return companionFxEnabled_; }

    // ── Step 1: Collect ─────────────────────────────────────────────────────

    /**
     * Scan the grid layout and timeline to build a list of CellFrameRequests
     * for one output video frame.
     *
     * @param outputFrameIndex  0-based output frame number
     * @param timeline          project data (grid, tracks, clips, patterns, sources)
     * @param sampleRate        audio sample rate (e.g. 48000)
     * @param fps               output video fps (e.g. {30,1} or {30000,1001})
     * @param events            pre-built VideoEvent list (from rebuildVideoEventsFromClips)
     * @param allowProxy        when true (default), a ready DNxHR LB proxy may be
     *                          substituted for the source path — preview-only
     *                          optimization. Final exports MUST pass false so the
     *                          encoder receives original-source pixels.
     * @param projectStartSample absolute project sample where output frame 0 maps.
     *                           Keep this at 0 for full-timeline / preview-style
     *                           collection, or pass the export range start sample
     *                           so source sampling follows absolute project time
     *                           while encoded frame indices still start at 0.
     * @param posterMode         PREVIEW-ONLY fast path. When true, each GRID cell
     *                           binds the source's cached poster frame
     *                           (SourceMedia.posterPath, frame 0) instead of
     *                           live-decoding the timeline frame — no per-frame
     *                           decode for grid cells. Flip + opacity are still
     *                           applied by the compositor exactly as for live
     *                           frames. Fullscreen layers ignore this and stay
     *                           live. The render/export path MUST leave this
     *                           false (default) — poster pixels never reach an
     *                           encoder.
     * @return  vector of requests — one per active cell (gaps excluded)
     * @param renderProxyBySource  RENDER-PATH ONLY. When non-null, it is the
     *                          authoritative resolution-aware proxy plan: a map
     *                          sourceId → chosen file path. A non-empty path is a
     *                          footprint-sized whole-source proxy to decode from
     *                          (frame index maps 1:1); a missing entry or empty
     *                          path means decode the ORIGINAL source. When present
     *                          it fully replaces the preview region/legacy/preview-
     *                          proxy/poster substitution below, so the render path
     *                          reads exactly what the plan dictates. Still gated by
     *                          allowProxy: when allowProxy=false (full-quality
     *                          override) the plan is ignored and originals are used,
     *                          guaranteeing bit-exact source pixels to the encoder.
     * @param layoutOverride    SNAPSHOT-TRANSITION ONLY. When non-null, this exact
     *                          GridLayout is used as the frame's arrangement instead
     *                          of the tick-resolved layout (timeline.gridLayoutAt).
     *                          Event timing (beatPos, source frame indices) is still
     *                          driven by the frame's absolute project tick — only the
     *                          grid/fullscreen ARRANGEMENT is forced. This lets the
     *                          transition path composite a SPECIFIC snapshot (the
     *                          outgoing A or incoming B) at a given frame. The caller
     *                          owns the layout by value; the pointer is not retained
     *                          past this call. Default (nullptr) is unchanged.
     * @param applyPreviewEffectMute  PREVIEW-ONLY. When true, a track with an
     *                          active Timeline::setVisualEffectChainPreviewMuted
     *                          flag gets an empty CellFrameRequest::visualChain
     *                          for this call, as if it had no chain at all (used
     *                          by the chroma-key eyedropper so it samples raw,
     *                          unprocessed pixels without an undoable per-effect
     *                          bypass). Defaults to false — the render/export
     *                          path and the snapshot-transition renderer MUST
     *                          leave this false so an in-flight preview mute can
     *                          never affect an export; only the live preview
     *                          tick opts in.
     */
    std::vector<CellFrameRequest> collectRequests(
        int64_t                        outputFrameIndex,
        const Timeline&                timeline,
        int                            sampleRate,
        AVRational                     fps,
        const std::vector<VideoEvent>& events,
        bool                           allowProxy = true,
        int64_t                        projectStartSample = 0,
        bool                           posterMode = false,
        const std::unordered_map<int, std::string>* renderProxyBySource = nullptr,
        const GridLayout*              layoutOverride = nullptr,
        bool                           applyPreviewEffectMute = false);

    // ── Step 2: Deduplicate ─────────────────────────────────────────────────

    /**
     * Group requests by (sourcePath, sourceFrameIndex).
     * Returns a map: unique frame key → list of pointers into the requests vector.
     * The decoder iterates this map — decode each key once.
     */
    static std::map<FrameCacheKey, std::vector<CellFrameRequest*>>
    deduplicateRequests(std::vector<CellFrameRequest>& requests);

    // ── Step 3: Resolve (cache lookup + decode dispatch) ────────────────────

    /**
     * For each unique key, check the cache.  Returns the set of keys that
     * need decoding (cache misses).  The caller is responsible for actually
     * decoding — this class does not own a VideoDecoder.
     *
     * @param deduplicated  output of deduplicateRequests()
     * @param cache         the render frame cache
     * @return  keys that were NOT in the cache (need decoding)
     */
    static std::vector<FrameCacheKey> resolveFrames(
        const std::map<FrameCacheKey, std::vector<CellFrameRequest*>>& deduplicated,
        RenderFrameCache& cache);

private:
    // Find the active VideoEvent on a given track at a given beat position.
    // Returns nullptr if no event is active (gap) or track is muted.
    static const VideoEvent* findActiveEvent(
        const std::vector<VideoEvent>& events,
        const Timeline&                timeline,
        int                            trackId,
        double                         beatPos);

    // Compute the source frame index for an event at a given beat position.
    static int64_t computeSourceFrame(
        const VideoEvent& ev,
        double            beatPos,
        double            bpm,
        int               sampleRate,
        AVRational        sourceRate);

    static double computeSourceTime(
        const VideoEvent& ev,
        double            beatPos,
        double            bpm,
        int               sampleRate,
        double            sourceFps);

    // Compute source frame index from an absolute source time (seconds).
    // Used for hold-last-frame clamping when the note sustains past trim end.
    //
    // Takes the source's EXACT rational rate â€” not a double â€” because
    // RenderVideoDecoder converts the resulting frame index back to a PTS with
    // that same rational, and the two directions must agree bit for bit.
    // Uses FLOOR semantics to match the UI's Chromium <video> region picker.
    // See engine/src/render/FrameRateMath.h.
    static int64_t computeSourceFrameFromTime(double sourceTimeSec, AVRational sourceRate);

    // Compute ping-pong frame index (and optional secondary crossfade frame).
    // Returns primary frame; sets outSecondaryFrame / outBlendFactor if crossfading.
    static int64_t computePingPongFrame(
        const VideoEvent&       ev,
        double                  beatPos,
        double                  bpm,
        int                     sampleRate,
        AVRational              sourceRate,
        const PingPongSettings& pp,
        int64_t&                outSecondaryFrame,
        float&                  outBlendFactor);

    // Per-track hold-frame state for fullscreen BehindGrid layers: when a
    // BehindGrid clip has a gap (and that track has videoHoldLastFrame on),
    // we redraw the last known frame so the backdrop never goes black.
    // GC'd each frame against the live BehindGrid trackId set so the map is
    // bounded by the current layer count, not by all tracks ever assigned.
    struct FullscreenHoldState {
        int64_t     lastFrame       = -1;
        std::string lastPath;
        int         lastOrientation = 0;
        // End position (in beats) of the clip that produced lastFrame. The
        // hold-expiry threshold is measured from here, NOT from when the gap
        // was first noticed, so the cut lands at the same musical position
        // whatever the frame rate or seek history — preview, export and
        // snapshot transitions all agree.
        double      lastClipEndBeat = 0.0;
    };
    std::unordered_map<int, FullscreenHoldState> fullscreenHoldByTrack_;

    AnimationManager* animationMgr_ = nullptr;

    // Companion modulation FX are export-only in Phase E.2. Preview uses the
    // same collector/compositor stack for E.1 timing follow, so keep this off
    // by default and let OfflineRenderer opt in explicitly.
    bool companionFxEnabled_ = false;
};

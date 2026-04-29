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
#include <vector>

#include "FrameCache.h"          // FrameCacheKey
#include "RenderClock.h"         // sampleToVideoFrame, videoFrameToSample

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
    int         globalNoteIndex  = 0;   // for flip mode cycling
    int         flipMode         = 0;   // VideoFlipMode as int (0=None, 1=HorizEven, 2=CW, 3=CCW)
    int         trackId          = -1;  // originating track
    bool        isChorus         = false;
    bool        isCrash          = false;
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
    float tvRampIntensity = 0.0f;

    // Ping-pong crossfade: secondary frame to blend with primary (-1 = no blend)
    int64_t pingPongSecondaryFrame = -1;
    float   pingPongBlendFactor    = 0.0f;  // 0.0 = full primary, 1.0 = full secondary

    // Pointer to track's visual effect chain (owned by TrackInfo, valid for frame lifetime)
    const std::vector<VisualEffect>* visualChain = nullptr;
};

// ---------------------------------------------------------------------------
// FrameCollector — stateless utility, all methods work per output frame
// ---------------------------------------------------------------------------
class FrameCollector
{
public:
    FrameCollector() = default;

    void setAnimationManager(AnimationManager* mgr) { animationMgr_ = mgr; }

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
     * @return  vector of requests — one per active cell (gaps excluded)
     */
    std::vector<CellFrameRequest> collectRequests(
        int64_t                        outputFrameIndex,
        const Timeline&                timeline,
        int                            sampleRate,
        AVRational                     fps,
        const std::vector<VideoEvent>& events);

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
        double            sourceFps);

    // Compute source frame index from an absolute source time (seconds).
    // Used for hold-last-frame clamping when the note sustains past trim end.
    static int64_t computeSourceFrameFromTime(double sourceTimeSec, double sourceFps);

    // Compute ping-pong frame index (and optional secondary crossfade frame).
    // Returns primary frame; sets outSecondaryFrame / outBlendFactor if crossfading.
    static int64_t computePingPongFrame(
        const VideoEvent&       ev,
        double                  beatPos,
        double                  bpm,
        double                  sourceFps,
        const PingPongSettings& pp,
        int64_t&                outSecondaryFrame,
        float&                  outBlendFactor);

    // Chorus hold-frame state: when the chorus clip has a gap, we redraw
    // the last known chorus frame so the background never goes black.
    int64_t     lastChorusSourceFrame_ = -1;
    std::string lastChorusSourcePath_;
    int         lastChorusFlipMode_    = 0;
    int         lastChorusNoteIndex_   = 0;

    AnimationManager* animationMgr_ = nullptr;
};

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

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "FrameCache.h"          // FrameCacheKey
#include "VisualEchoTypes.h"     // xleth::echo::EchoSettings / IDelaySnapshotResolver
#include "RenderClock.h"         // sampleToVideoFrame, videoFrameToSample
#include "model/ClipCompanionFxSnapshot.h" // ClipCompanionFxSnapshot (shared with preview)
#include "model/LensRoam.h"   // LensParams / RoamParams / LensRoamSnapshot
#include "model/ColorGrade.h" // BakedGrade / ColorGradeSnapshot
#include "MotionBlur.h"       // motionblur::kDenseSamples / ZprPose

// Forward declarations — avoid pulling heavy headers into every consumer
class Timeline;
struct GridLayout;
struct GridSlot;
struct PingPongSettings;
struct TrackInfo;
struct VideoEvent;
struct VisualEffect;

class AnimationManager;
struct CellAnimation;

// ---------------------------------------------------------------------------
// CellLayerKind — distinguishes which compositor pass a request belongs to.
// Replaces the previous (isChorus, isCrash) bool pair.
// ---------------------------------------------------------------------------
enum class CellLayerKind : uint8_t {
    Grid              = 0,  // normal grid cell (Pass 2)
    FullscreenBehind  = 1,  // fullscreen layer drawn before grid (Pass 1)
    FullscreenInFront = 2,  // fullscreen layer drawn after grid (Pass 3)
};

// ClipCompanionFxSnapshot lives in model/ClipCompanionFxSnapshot.h so the data
// contract stays independent of this file and of GridCompositor. Included above.

// ---------------------------------------------------------------------------
// Motion view: Parent (docs/XLETH_MOTION_VIEW_DESIGN.md R7, 3.4)
//
// A parent passes on its ROAM (offset, scale, rotation) as a similarity about
// its HOME centre. The compositor needs, per ancestor, where its home is and
// its Roam at the frame tick; it builds the similarity in output pixels itself
// (canvas fit and output size are its business). Plain values, resolved by the
// collector from the FULL layout at the frame tick (never a transition A/B or
// Landing carry override) and the published LensRoamSnapshot, so a request
// never points at another request (the parent's request may be culled, in a
// gap, or in another collect).
// ---------------------------------------------------------------------------
struct ParentAncestor {
    int        trackId          = -1;
    bool       placed           = false;  // false: not placed at this tick -> identity
    bool       fullscreen       = false;  // a fullscreen layer: home = unit = the canvas
    int        cellCol          = 0;      // grid placement, fine sub-units (first slot)
    int        cellRow          = 0;
    int        spanX            = 0;
    int        spanY            = 0;
    float      gapScaleOverride = -1.0f;  // the ancestor track's own gap override
    RoamParams roam;                      // at the frame tick (keys applied)
};

struct ParentChain {
    // Ancestors in use, NEAREST FIRST (0 = no parent: today's path, untouched).
    int depth = 0;
    // The full layout's grid geometry at the frame tick, which every
    // ancestor's home is computed on (it can differ from the geometry the
    // compositor was handed during a snapshot transition).
    int   gridCols = 0;
    int   gridRows = 0;
    float gapScale = 0.0f;
    std::array<ParentAncestor, motionschema::kMaxParentDepth> ancestors{};
    // Motion blur: every ancestor's Roam at the SAME dense sub-frame ticks as
    // the child's roamMotion, taken when ANY placed ancestor moves inside the
    // shutter (count kDenseSamples), else 0 (frame-time poses throughout).
    int motionCount = 0;
    std::array<std::array<RoamParams, motionschema::kMaxParentDepth>,
               motionblur::kDenseSamples> motion{};
};

// ---------------------------------------------------------------------------
// CellFrameRequest — what one grid cell needs for this output frame
// ---------------------------------------------------------------------------
struct CellFrameRequest {
    int         cellRow          = 0;   // fine-grid Y (kGridSubUnitsPerRow per row)
    int         cellCol          = 0;   // fine-grid X (kGridSubUnitsPerColumn per col)
    int         spanX            = 8;   // fine-grid units wide (default = full column)
    int         spanY            = 8;   // fine-grid units tall (default = full row)
    InternedPath sourcePath;            // resolved source path, interned (see FrameCache.h)
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

    // Visual Echo configuration for THIS output frame, already resolved against
    // the bound Delay FX's published repeat interval. Inactive (and therefore
    // free) unless the track's chain holds a non-bypassed VisualEcho whose
    // binding resolves. Plain values, same discipline as companionFx — the
    // compositor never looks at the audio graph itself.
    xleth::echo::EchoSettings echo;

    // Lens + Roam, RESOLVED for this cell and frame: the base with its keys
    // evaluated at the frame's tick (P7, LensRoamSnapshot::lensForEventAt /
    // roamAt). Fixed-size values copied out of the published LensRoamSnapshot,
    // so the compositor reads plain data and never the model. Identity when no
    // snapshot is installed. GridCompositor applies both (P2) through
    // render/LensRoamMath.h; the collector's draw-order sort reads roam.layer.
    LensParams lens;   // clip lens (+ its keys), or source lens + hit curve
    RoamParams roam;   // the track's roam (+ its keys)

    // The source's own pixel size (SourceMedia width/height; 0 = unknown).
    // Lens Cover/Contain fit against it rather than the decoded texture, so a
    // preview proxy (aspect-preserved, size rounded) frames exactly like the
    // export's full-size source. See lensroam::fitSourceSize.
    int sourcePixelW = 0;
    int sourcePixelH = 0;

    // ── Color Grade (model/ColorGrade.h) ───────────────────────────────────
    // The three per-cell levels, RESOLVED for this cell: the source's grade,
    // the clip's (Clip Track) or region's (Pattern Track), and the track's.
    // nullptr = no grade at that level. Each is an immutable baked grade the
    // request co-owns, so the compositor never reads a grade the message
    // thread can still change, and an edit landing mid-frame cannot free one
    // under it. GridCompositor applies them in this order, in one pass, before
    // the visual effect chain. (The Master grade is not per cell: see
    // FrameCollector::masterGrade.)
    std::shared_ptr<const xleth::grade::BakedGrade> gradeSource;
    std::shared_ptr<const xleth::grade::BakedGrade> gradeClip;
    std::shared_ptr<const xleth::grade::BakedGrade> gradeLayer;

    // ── Landing override (docs/XLETH_LANDING_SPEC.md §6.2) ─────────────────
    // true => draw at canvasRect and ignore cellCol / cellRow / span, the grid
    // size and the gap: the rect IS this cell's home rect for the frame. Set
    // only by LandingRenderer, on the requests of a track that is in flight.
    // Everything after the home rect is unchanged: bounce, Roam (and its
    // Bounds Clip scissor, which clips to this rect), Lens, the visual chain
    // and flip all apply as for any grid cell.
    bool  hasCanvasRect = false;
    float canvasRect[4] = { 0.0f, 0.0f, 0.0f, 0.0f };   // x, y, w, h — canvas-normalized
    // The size a Roam offset is measured in. A slot's is its placement BEFORE
    // the gap, which a drawn rect alone cannot give back, so it travels with
    // the rect (audit D3). Lerped like the rect; equals the slot's own unit at
    // the end of the move.
    float canvasRoamUnit[2] = { 0.0f, 0.0f };           // w, h
    // ── Motion blur (render/MotionBlur.h) ─────────────────────────────────
    // Dense sub-frame samples across the shutter, taken by the collector
    // ONLY when the value actually changes inside it; count 0 = no blur for
    // that stage (today's single-sample path). Sample i sits at
    // motionblur::sampleOffset(i, kDenseSamples) of the shutter interval from
    // the frame time. Plain values, like lens/roam above.
    //   lensMotion  the Lens (+ Sweep) at each instant  -> Lens framing pass
    //   roamMotion  the Roam at each instant            -> the final draws
    //   (both under the PROJECT's motion blur setting)
    //   zprMotion   the composed ZPR pose at each instant -> the ZPR pass
    //   (under the TRACK's Zoom/pan/rot motion blur, independent of the above)
    int lensMotionCount = 0;
    int roamMotionCount = 0;
    int zprMotionCount  = 0;
    std::array<LensParams,          motionblur::kDenseSamples> lensMotion{};
    std::array<RoamParams,          motionblur::kDenseSamples> roamMotion{};
    std::array<motionblur::ZprPose, motionblur::kDenseSamples> zprMotion{};

    // ── Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 3.4) ─────────────────
    // The track's masks at the frame tick (LensRoamSnapshot::masksAt; count 0
    // = none) and its Parent chain (depth 0 = none). Fixed-size values, so a
    // request stays self-contained and the collector allocates nothing for
    // them. A request with neither takes today's compositor path, bit for bit.
    MaskFrame   masks{};
    ParentChain parent{};
};

// ---------------------------------------------------------------------------
// FrameCollector — stateless utility, all methods work per output frame
// ---------------------------------------------------------------------------
class FrameCollector
{
public:
    FrameCollector() = default;

    void setAnimationManager(AnimationManager* mgr) { animationMgr_ = mgr; }

    /** Install the Visual Echo delay-binding resolver (not owned; must outlive
     *  this collector). Both the live preview tick and OfflineRenderer install
     *  one backed by the SAME MixEngine, which is what makes export echo output
     *  identical to preview. Leave unset (the default) and every VisualEcho in
     *  every chain resolves inactive, so the render path is byte-identical to
     *  the pre-echo behaviour — which is exactly what the existing unit tests
     *  and SnapshotTransitionRenderer want. */
    void setEchoDelayResolver(const xleth::echo::IDelaySnapshotResolver* r) { echoResolver_ = r; }
    void setCompanionFxEnabled(bool enabled) { companionFxEnabled_ = enabled; }

    /** Install the resolved Lens/Roam values every request copies from.
     *  Call from the message/setup thread, under the same lock the caller
     *  holds around collectRequests (the preview: syncEventsMutex), so the
     *  render thread never swaps or frees a snapshot itself. The collector
     *  keeps it alive; nullptr (the default) = identity everywhere, today's
     *  rendering. */
    void setLensRoamSnapshot(std::shared_ptr<const LensRoamSnapshot> snapshot) {
        lensRoam_ = std::move(snapshot);
    }
    const LensRoamSnapshot* lensRoamSnapshot() const { return lensRoam_.get(); }

    /** Install the resolved Color Grades every request copies from. Same
     *  contract as setLensRoamSnapshot: call under the lock the caller holds
     *  around collectRequests. nullptr (the default) = no grade anywhere,
     *  which renders exactly as before the feature. */
    void setColorGradeSnapshot(std::shared_ptr<const xleth::grade::ColorGradeSnapshot> snapshot) {
        grades_ = std::move(snapshot);
    }
    const xleth::grade::ColorGradeSnapshot* colorGradeSnapshot() const { return grades_.get(); }

    /** PREVIEW-ONLY: hold-to-compare. While true every request is built with
     *  no grade at any level and masterGrade() is null, so the picture is the
     *  ungraded one. The export collector never sets it. */
    void setColorGradeCompareBypass(bool bypass) { gradeCompareBypass_ = bypass; }
    bool colorGradeCompareBypass() const { return gradeCompareBypass_; }

    /** The Master grade for the frame being drawn, or nullptr. The caller
     *  hands it to GridCompositor::setMasterGrade before readback, so it is
     *  applied to the finished frame: after every cell, snapshot transition
     *  and landing overlay. Co-owned for the same reason the request grades
     *  are. Read under the same lock as collectRequests. */
    std::shared_ptr<const xleth::grade::BakedGrade> masterGrade() const {
        if (!grades_ || gradeCompareBypass_) return nullptr;
        return grades_->master;
    }
    bool companionFxEnabled() const { return companionFxEnabled_; }

    // ── Hold-frame GC guards (Landing; docs/XLETH_LANDING_AUDIT.md D2) ──────
    // collectRequests forgets the held frame of every track that is not placed
    // in the layout it was just given. A landing frame collects more than one
    // layout — the frame's layout WITHOUT the landing tracks, then a carry
    // layout holding ONLY them — so without these two guards each collect
    // would erase the other's held frames, and a landing track with Hold Last
    // Frame would lose its picture in every gap for the length of the move.
    //
    // Both are inert by default: with no kept tracks and the GC enabled, the
    // GC is exactly what it was. LandingRenderer is the only caller.

    /** Tracks the hold GC must keep even when the layout does not place them.
     *  Copied (at most TrackLanding::kMaxLandingsPerCue ids); count 0 clears. */
    void setHoldKeepTracks(const int* trackIds, int count) {
        holdKeepCount_ = 0;
        for (int i = 0; i < count && holdKeepCount_ < kMaxHoldKeepTracks; ++i)
            holdKeepTracks_[holdKeepCount_++] = trackIds[i];
    }
    int holdKeepTrackCount() const { return holdKeepCount_; }

    /** false suspends the hold GC for the following collectRequests calls
     *  (the carry collect, whose layout places only the landing tracks).
     *  Re-enable it straight after. */
    void setHoldGcEnabled(bool enabled) { holdGcEnabled_ = enabled; }
    bool holdGcEnabled() const { return holdGcEnabled_; }

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
     * @return  reference to an internal buffer, valid until the next call to
     *          collectRequests() on THIS instance. Every caller uses it (via
     *          dedup/resolve/decode/composite) synchronously within the same
     *          frame before collecting again, so this is safe and avoids a
     *          fresh heap allocation on every frame — capture by value (a
     *          test doing `auto requests = collector.collectRequests(...)`)
     *          if a copy that outlives the next call is genuinely needed.
     */
    std::vector<CellFrameRequest>& collectRequests(
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
    static std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash>
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
        const std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash>& deduplicated,
        RenderFrameCache& cache);

private:
    // Find the active VideoEvent on a given track at a given beat position.
    // Returns nullptr if no event is active (gap) or track is muted.
    // Reference semantics for resolveActiveEvents below (one scan per call);
    // kept for callers that want a single track without the batch.
    static const VideoEvent* findActiveEvent(
        const std::vector<VideoEvent>& events,
        const Timeline&                timeline,
        int                            trackId,
        double                         beatPos);

    // Batch form of findActiveEvent: fills activeByTrack_ with, for every
    // track, the event findActiveEvent would return at beatPos (same window
    // test, same tie-break, same first-wins on an exact tie). Muting is
    // applied at lookup (activeEventFor), exactly where findActiveEvent did.
    void resolveActiveEvents(const std::vector<VideoEvent>& events, double beatPos);
    const VideoEvent* activeEventFor(const Timeline& timeline, int trackId) const;

    // The gap a track sits in at beatPos, for Smart hold and Keep playing.
    // prev = the event that ended last before the gap (nullptr: before the
    // track's first event). nextStart = +inf after the last event.
    // smartThreshold = model/SmartHold.h's threshold for this track's gaps.
    struct GapInfo {
        const VideoEvent* prev = nullptr;
        double prevEnd        = 0.0;
        double nextStart      = 0.0;
        double smartThreshold = 0.0;
    };
    GapInfo gapFor(const std::vector<VideoEvent>& events, int trackId, double beatPos);

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
    // Takes the source's EXACT rational rate — not a double — because
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

    // Per-track hold-frame state, shared by every placement that can hold: a
    // fullscreen BehindGrid layer and a grid cell. When such a placement has a
    // gap (and its track has videoHoldLastFrame on), we redraw the last known
    // frame so it never goes black. Keyed by track, not by cell: every cell a
    // track occupies shows the same event, hence the same held frame; only the
    // cell geometry differs and that comes from the placement at draw time.
    // GC'd each frame against the trackIds still placed as a BehindGrid layer
    // or a grid slot, so the map is bounded by the live layout, not by all
    // tracks ever assigned. FullscreenInFront is transient and never holds.
    struct HoldState {
        int64_t      lastFrame       = -1;
        InternedPath lastPath;
        int          lastOrientation = 0;
        bool        suppressAfterFadeOut = false;
        // End position (in beats) of the clip that produced lastFrame. The
        // hold-expiry threshold is measured from here, NOT from when the gap
        // was first noticed, so the cut lands at the same musical position
        // whatever the frame rate or seek history — preview, export and
        // snapshot transitions all agree.
        double      lastClipEndBeat = 0.0;
        // Lens of the event that produced lastFrame: a held frame is the same
        // picture, so it keeps the same framing. Stored WITHOUT the track's
        // Sweep (P11): that layer is timeline-absolute and keeps running.
        LensParams  lastLens;
        int         lastSourcePixelW = 0;
        int         lastSourcePixelH = 0;
        // Who the held picture belongs to, so a held frame keeps its Source
        // and Clip grades. Ids, not the grades themselves: a grade edited
        // while the frame is held must show at once.
        int         lastSourceId = -1;
        int         lastClipId   = -1;
        int         lastRegionId = -1;
    };
    std::unordered_map<int, HoldState> holdByTrack_;

    // Tracks currently holding a note past its trim end, for edge-triggered
    // clamp logging (XLETH_RENDER_LOG): a held note logs once on entry, not
    // every frame of its sustain. Erased once the track stops clamping (note
    // ends or drops out of the held range), so the next hold logs again.
    // Bounded by live track count, not note count.
    std::unordered_set<int> clampLoggedTracks_;

    // Reused across calls to collectRequests() so a steady per-frame cell
    // count settles into a stable capacity instead of reallocating every
    // frame (Finding 11, RENDER_PERF_AUDIT.txt). Cleared, not deallocated,
    // at the start of each call.
    std::vector<CellFrameRequest> requestBuffer_;

    // The active event of every track that has one at this frame's beat,
    // resolved in ONE pass over the event list at the top of collectRequests
    // (see resolveActiveEvents). Each placement then looks its track up here.
    // Before, every placement ran findActiveEvent's full scan on its own: with
    // a 4x4 grid plus a backdrop over a 3133-event project that was ~53k
    // event visits per frame — each one touching a sizeable struct — for a
    // handful of hits. Cleared, not deallocated, per call.
    std::unordered_map<int, const VideoEvent*> activeByTrack_;

    // Per-track gap index for gapFor(), built lazily the first time a track
    // with Smart hold / Keep playing hits a gap, and thrown away whenever the
    // event list changes (eventsFingerprint_, accumulated in the same single
    // scan resolveActiveEvents already does). Holds INDICES into the events
    // vector, not pointers: the fingerprint is order-sensitive, so an
    // unchanged fingerprint means the same events in the same order, even if
    // the caller rebuilt the vector at a new address.
    struct TrackGapIndex {
        std::vector<double> start, end;   // merged busy intervals, sorted, disjoint
        std::vector<size_t> lastEvent;    // per interval: the event that ends it
        double smartThreshold = 0.0;
    };
    std::unordered_map<int, TrackGapIndex> gapIndexByTrack_;
    uint64_t eventsFingerprint_      = 0;
    uint64_t gapIndexFingerprint_    = 0;

    // Clones (model/Clone.h): a Trail clone replays its source at
    // (frame - delay), so it needs the source's active event at ANOTHER beat
    // than the one resolveActiveEvents resolved. Per source track, its events
    // sorted by start (indices, like the gap index), built lazily the first
    // time a Trail asks and dropped whenever the event list changes. Only
    // tracks with Trail clones ever get an entry.
    struct TrackEventIndex {
        std::vector<size_t> byStart;      // ascending startBeat, ties in list order
        double              maxDuration = 0.0;
    };
    std::unordered_map<int, TrackEventIndex> eventIndexByTrack_;
    uint64_t eventIndexFingerprint_ = 0;
    // The event findActiveEvent would pick on `trackId` at `beatPos`, IGNORING
    // the track's mute (a muted source keeps its Clones; spec "What every Clone
    // is"). Binary search plus a short backward walk.
    const VideoEvent* activeEventAt(const std::vector<VideoEvent>& events,
                                    int trackId, double beatPos);

    AnimationManager* animationMgr_ = nullptr;

    // Resolved Lens/Roam values (see setLensRoamSnapshot). nullptr = identity.
    std::shared_ptr<const LensRoamSnapshot> lensRoam_;

    // Resolved Color Grades (see setColorGradeSnapshot). nullptr = none.
    std::shared_ptr<const xleth::grade::ColorGradeSnapshot> grades_;
    bool gradeCompareBypass_ = false;
    // Fill a request's three grade levels from the snapshot. clipId >= 0 is a
    // Clip Track event (its clip's grade); otherwise the region's.
    void resolveGrades(CellFrameRequest& req, int sourceId, int clipId,
                       int regionId, int trackId) const;

    // ZPR motion blur: the one scratch copy of a track's CellAnimation that
    // sub-frame instants are advanced on (the live state is never touched).
    // Copy-assigned per use, which reuses its vectors' capacity, so it stops
    // allocating after the first few frames. shared_ptr only because
    // CellAnimation is incomplete here; created lazily by the .cpp.
    std::shared_ptr<CellAnimation> zprMotionScratch_;
    void sampleZprMotion(CellFrameRequest& req, const CellAnimation& anim,
                         const TrackInfo& trk, double fps);

    // Visual Echo delay-binding resolver. Not owned; nullptr = feature off.
    const xleth::echo::IDelaySnapshotResolver* echoResolver_ = nullptr;

    // Companion modulation FX are export-only in Phase E.2. Preview uses the
    // same collector/compositor stack for E.1 timing follow, so keep this off
    // by default and let OfflineRenderer opt in explicitly.
    bool companionFxEnabled_ = false;

    // Hold-frame GC guards (see setHoldKeepTracks / setHoldGcEnabled).
    static constexpr int kMaxHoldKeepTracks = 16;   // == TrackLanding::kMaxLandingsPerCue
    int  holdKeepTracks_[kMaxHoldKeepTracks] = {};
    int  holdKeepCount_ = 0;
    bool holdGcEnabled_ = true;
};

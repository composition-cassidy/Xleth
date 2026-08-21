#pragma once
#include "TimelineTypes.h"
#include "SampleRegion.h"
#include "Track.h"
#include "Clip.h"
#include "Pattern.h"
#include "PatternBlock.h"
#include "audio/TrackRouting.h"
#include <functional>
#include <map>
#include <unordered_set>
#include <vector>
#include <nlohmann/json.hpp>

// ─── Timeline ─────────────────────────────────────────────────────────────────
// Central container for all project data: sources, regions, tracks, and clips.
// All collections are keyed by auto-incremented integer IDs.
// This is the single source of truth for a Sparta Remix project.

class Timeline {
public:
    explicit Timeline(double bpm       = 140.0,
                      double sampleRate = 44100.0,
                      int    timeSigNum = 4,
                      int    timeSigDen = 4);

    // ── Sources ───────────────────────────────────────────────────────────────
    int                          addSource(SourceMedia media);
    const SourceMedia*           getSource(int id) const;
    SourceMedia*                 getSourceMutable(int id);
    std::vector<const SourceMedia*> getAllSources() const;
    bool                         removeSource(int id);

    // ── Regions ───────────────────────────────────────────────────────────────
    int                            addRegion(SampleRegion region);
    const SampleRegion*            getRegion(int id) const;
    SampleRegion*                  getRegionMutable(int id);
    std::vector<const SampleRegion*> getAllRegions() const;
    std::vector<SampleRegion*>     getAllRegionsMutable();
    bool                           removeRegion(int id);
    std::vector<const SampleRegion*> getRegionsByLabel(SampleLabel label) const;

    // ── Tracks ────────────────────────────────────────────────────────────────
    int                          addTrack(TrackInfo track);
    const TrackInfo*             getTrack(int id) const;
    TrackInfo*                   getTrackMutable(int id);
    std::vector<const TrackInfo*> getAllTracks() const;
    bool                         setTrackOrder(const std::vector<int>& trackIdsInOrder);
    bool                         removeTrack(int id);
    TrackLayout                  getTrackLayout() const;
    bool                         setTrackLayout(const TrackLayout& layout);
    // Command/project restoration path: accepts a structurally valid snapshot
    // whose folder set differs from the current state (for create/delete undo).
    bool                         restoreTrackLayout(const TrackLayout& layout);
    bool                         isTrackLayoutValid(const TrackLayout& layout) const {
        return validateTrackLayout(layout);
    }
    int                          createTrackFolder(std::string name,
                                                   const std::vector<int>& trackIds,
                                                   int rootIndex);
    bool                         setTrackFolderName(int folderId, const std::string& name);
    bool                         setTrackFolderCollapsed(int folderId, bool collapsed);
    bool                         removeTrackFolder(int folderId);

    // ── Clips ─────────────────────────────────────────────────────────────────
    int                        addClip(Clip clip);
    const Clip*                getClip(int id) const;
    Clip*                      getClipMutable(int id);
    std::vector<const Clip*>   getAllClips() const;
    bool                       removeClip(int id);
    std::vector<const Clip*>   getClipsOnTrack(int trackId) const;
    // Returns clips whose position falls in [start, end)
    std::vector<const Clip*>   getClipsInRange(TickTime start, TickTime end) const;
    bool                       moveClip(int clipId, int newTrackId, TickTime newPosition);
    bool                       resizeClip(int clipId, TickTime newDuration);
    bool                       resizeClipLeft(int clipId, TickTime newPosition, TickTime newDuration, TickTime newRegionOffset);

    // ── Transport ─────────────────────────────────────────────────────────────
    void   setBPM(double bpm);
    double getBPM()         const { return m_bpm; }
    void   setTempoLocked(bool v) { m_tempoLocked = v; }
    bool   getTempoLocked() const { return m_tempoLocked; }
    void   setSampleRate(double sr);
    double getSampleRate()  const { return m_sampleRate; }
    void   setTimeSignature(int numerator, int denominator);
    int    getTimeSigNum()  const { return m_timeSigNum; }
    int    getTimeSigDen()  const { return m_timeSigDen; }
    void   setDeclickMs(double ms);
    double getDeclickMs()   const { return m_declickMs; }
    void   setGlobalStretchMethod(int method);
    int    getGlobalStretchMethod() const { return m_globalStretchMethod; }

    // ── Loop / render region ──────────────────────────────────────────────────
    // Single global project loop region. setLoopRegion enforces the length
    // invariants in the mutation layer (zero/negative length is unreachable):
    // minLengthTicks is supplied by the caller (1 snap unit when snap is on,
    // 1 tick when snap is off). All UI create/update/toggle/settings mutations
    // route through a SetLoopRegionCommand, which calls this.
    const LoopRegion& getLoopRegion() const { return m_loopRegion; }
    void   setLoopRegion(const LoopRegion& region, int64_t minLengthTicks = 1);
    // Derived, never stored: render scoping is exactly the loop-enabled flag.
    bool   isRenderScoped() const { return m_loopRegion.loopEnabled; }

    // ── Grid Layout ───────────────────────────────────────────────────────────
    // m_gridLayout is the materialized view of the ACTIVE snapshot (arrangement +
    // geometry) fused with the global canvas/previewFps fields. Every runtime
    // consumer — render path, bridge IPC, undo commands — reads/writes it exactly
    // as before the snapshot model existed. m_gridSnapshots is authoritative;
    // every arrangement mutation writes the active cache back to that vector.
    const GridLayout& getGridLayout() const { return m_gridLayout; }
    void   setGridLayout(const GridLayout& layout);
    // Id/name of the active entry in the live snapshot vector.
    const std::string& getActiveSnapshotId()   const { return m_activeSnapshotId; }
    const std::string& getActiveSnapshotName() const { return m_activeSnapshotName; }
    std::string createGridSnapshot(bool cloneActive, const std::string& name);
    bool renameGridSnapshot(const std::string& id, const std::string& name);
    bool deleteGridSnapshot(const std::string& id);
    bool setActiveGridSnapshot(const std::string& id);
    const std::vector<GridSnapshot>& getGridSnapshots() const { return m_gridSnapshots; }
    // Id of the project's default ("Base") snapshot — the arrangement used by the
    // render path before the first cue and when no cue at/before a tick resolves.
    // Persisted; resolved on load, falling back to the first snapshot if absent.
    const std::string& getDefaultSnapshotId() const { return m_defaultSnapshotId; }

    // ── Time-based snapshot resolution (RENDER path only) ─────────────────────
    // Resolve the grid arrangement in effect at absolute project tick `t` and
    // return a SELF-CONTAINED GridLayout by value (never an alias into the
    // editor's active-snapshot cache). The global canvas/previewFps fields are
    // taken from the container and are identical regardless of tick; only the
    // arrangement (columns/rows/gapScale/slots/fullscreenLayers) is time-resolved:
    //   • no cues, or t before the first cue → the default ("Base") snapshot;
    //   • otherwise → the snapshot of the LAST cue whose tick <= t, skipping any
    //     cue whose snapshotId no longer resolves (treated as absent).
    // const + allocates its own layout + reads only stable snapshot/cue data, so
    // it is safe to call from the render thread while edits run on the main
    // thread. The editing path keeps reading getGridLayout() (the active snapshot).
    GridLayout gridLayoutAt(TickTime t) const;

    // ── Grid cues (CRUD; sorted-by-tick invariant maintained internally) ──────
    // addGridCue inserts keeping ascending tick order; if a cue already exists at
    // the exact tick its snapshotId is replaced. moveGridCue relocates the cue at
    // oldTick to newTick (false if none at oldTick). removeGridCue deletes the cue
    // at that exact tick (false if none). snapshotId is NOT validated here —
    // dangling refs are tolerated by the resolver and pruned on snapshot delete.
    void addGridCue(TickTime tick, const std::string& snapshotId);
    bool moveGridCue(TickTime oldTick, TickTime newTick);
    bool removeGridCue(TickTime tick);
    const std::vector<GridCue>& getGridCues() const { return m_gridCues; }

    // Set (replace) the transition on the cue at `cueTick`. No-op if there is no
    // cue at that exact tick. Follows the same by-value / under-lock discipline as
    // the other cue mutators — the bridge writer holds syncEventsMutex.
    void setCueTransition(TickTime cueTick, const SnapshotTransition& tr);

    // ── Time-based transition resolution (RENDER path only) ───────────────────
    // A fully self-contained snapshot of the transition (if any) active at tick
    // `t`. Like gridLayoutAt, everything is copied BY VALUE — the render thread
    // owns the result outright and never aliases a live GridCue/GridSnapshot. The
    // two layouts each carry their own columns/rows/gapScale so Slice 3 can place
    // each snapshot's cells with its OWN geometry (fixing the latent cue-switch
    // geometry bug); this slice does not touch the compositor.
    struct ResolvedTransition {
        bool     active = false;              // false = no active transition window at t (hard cut)
        TickTime pinTick{};                   // the cue tick (transition pin, 50% point)
        TickTime startTick{};                 // pinTick - transition.startOffsetTicks
        TickTime endTick{};                   // pinTick + transition.endOffsetTicks
        SnapshotTransition::Type type = SnapshotTransition::Type::Crossfade;
        float    geomAngleDeg = 0.0f;
        float    edgeSoftness = SnapshotTransition::kDefaultEdgeSoftness;
        float    zoomAmount = SnapshotTransition::kDefaultZoomAmount;
        int      dissolveGrainPx = SnapshotTransition::kDefaultDissolveGrainPx;
        float    radialOriginX = SnapshotTransition::kDefaultRadialOriginX;
        float    radialOriginY = SnapshotTransition::kDefaultRadialOriginY;
        int      pixelateMaxBlockPx = SnapshotTransition::kDefaultPixelateMaxBlockPx;
        float    glitchIntensity = SnapshotTransition::kDefaultGlitchIntensity;
        int      glitchBlockPx = SnapshotTransition::kDefaultGlitchBlockPx;
        float    blurRadiusPx = SnapshotTransition::kDefaultBlurRadiusPx;
        float    displacementAmount = SnapshotTransition::kDefaultDisplacementAmount;
        float    displacementScale = SnapshotTransition::kDefaultDisplacementScale;
        int      effectSeed = SnapshotTransition::kDefaultEffectSeed;
        SnapshotTransitionEasingCurve startToPinEasing{};
        SnapshotTransitionEasingCurve pinToEndEasing{};
        GridLayout layoutA;                   // outgoing snapshot = gridLayoutAt(pinTick - 1)
        GridLayout layoutB;                   // incoming snapshot = gridLayoutAt(pinTick)
    };

    // Resolve the transition whose window [pin - startOffset, pin + endOffset]
    // contains `t` and whose transition.enabled is set (pin = cue.tick). When more
    // than one enabled window overlaps t, the latest-pinned one wins (consistent
    // with gridLayoutAt's "last cue wins"). If none is active, returns
    // { active = false }. const + self-allocating: safe on the render thread.
    ResolvedTransition transitionAt(TickTime t) const;
    void   assignTrackToGrid(int trackId, int gridX, int gridY, int spanX, int spanY);
    // Same as assignTrackToGrid but stores the supplied zOrder on the slot
    // instead of resetting to 0. Used by the grid editor's drag-to-place flow
    // so that a fresh placement landing on top is a single atomic command.
    void   assignTrackToGridWithZOrder(int trackId, int gridX, int gridY,
                                       int spanX, int spanY, int zOrder);
    void   removeTrackFromGrid(int trackId);

    // Which kind of video placement a track currently holds. A track is either
    // grid-slotted OR fullscreen (never both, by construction), or has no video
    // placement at all.
    enum class PlacementKind { None, Grid, Fullscreen };
    // Set the single, globally-comparable compositing zOrder for a track's video
    // placement (see GridSlot::zOrder / FullscreenLayer::zOrder). Updates the
    // track's grid slot if it is grid-placed; otherwise every fullscreen layer
    // that references the track. Returns which placement was affected (None if
    // the track has no video placement). Undo-tracked via SetPlacementZOrderCommand.
    PlacementKind setPlacementZOrder(int trackId, int zOrder);
    // Bulk-replace the fullscreen layer stack. Auto-enables videoHoldLastFrame
    // on every BehindGrid layer's track (preserves chorus continuity semantic).
    void   setFullscreenLayers(std::vector<FullscreenLayer> layers);
    // Strip every layer pointing at the supplied trackId. Used by
    // RemoveTrackCommand cascade.
    void   removeFullscreenLayersForTrack(int trackId);
    // Re-insert a layer at the supplied index. Used by RemoveTrackCommand undo.
    // index is clamped to [0, fullscreenLayers.size()].
    void   restoreFullscreenLayer(size_t index, const FullscreenLayer& layer);
    const std::vector<FullscreenLayer>& getFullscreenLayers() const {
        return m_gridLayout.fullscreenLayers;
    }
    void   setPreviewFps(int fps);

    // ── Patterns ──────────────────────────────────────────────────────────────
    int                           addPattern(Pattern pattern);
    const Pattern*                getPattern(int id) const;
    Pattern*                      getPatternMutable(int id);
    const std::map<int, Pattern>& getAllPatterns() const { return m_patterns; }
    bool                          removePattern(int id);

    // ── PatternBlocks ─────────────────────────────────────────────────────────
    int                                  addPatternBlock(PatternBlock block);
    const PatternBlock*                  getPatternBlock(int id) const;
    PatternBlock*                        getPatternBlockMutable(int id);
    std::vector<const PatternBlock*>     getAllPatternBlocks() const;
    std::vector<const PatternBlock*>     getPatternBlocksOnTrack(int trackId) const;
    std::vector<const PatternBlock*>     getPatternBlocksInRange(TickTime start, TickTime end) const;
    bool                                 removePatternBlock(int id);
    bool                                 movePatternBlock(int id, int newTrackId, TickTime newPosition);
    bool                                 resizePatternBlock(int id, TickTime newDuration);
    bool                                 resizePatternBlockLeft(int id, TickTime newPosition, TickTime newDuration, TickTime newOffset);
    bool                                 setPatternBlockLoopEnabled(int id, bool enabled);

    // ── Pattern notes ─────────────────────────────────────────────────────────
    int  addNoteToPattern(int patternId, PatternNote note);
    bool addNotesToPatternBulk(int patternId, std::vector<PatternNote>& notes);
    bool removeNoteFromPattern(int patternId, int noteId);
    bool moveNote(int patternId, int noteId, TickTime newPosition, int newPitch);
    bool resizeNote(int patternId, int noteId, TickTime newDuration);
    bool setNoteVelocity(int patternId, int noteId, float velocity);

    // ── Track type / sampler ──────────────────────────────────────────────────
    // Pattern tracks are sample-agnostic containers for PatternBlocks. Any
    // pattern (regardless of its regionId) can be placed on any pattern track.
    bool convertToPatternTrack(int trackId);
    bool convertToClipTrack(int trackId);
    bool setTrackVideoFlipConfig(int trackId, const VideoFlipConfig& config);
    bool setTrackVideoHoldLastFrame(int trackId, bool hold);
    // thresholdBeats < 0 is normalized to kHoldLastFrameThresholdUnlimited.
    bool setTrackVideoHoldLastFrameThresholdBeats(int trackId, double thresholdBeats);
    bool setTrackFxMode(int trackId, TrackFxMode mode);
    bool setTrackGraphState(int trackId, const nlohmann::json& graphState);
    bool setTrackCornerRadius(int trackId, float radius);
    bool setTrackGapScaleOverride(int trackId, float gapScale);
    bool setTrackSubdivisionFactor(int trackId, int factor);
    // Pass 6D + 6F: assign track color metadata. mode is sanitized to Auto on
    // unknown values. When mode == PaletteSlot, slot must be 1..16; when
    // mode == Custom, customColor must be a valid #RRGGBB hex (case-insensitive,
    // normalized to uppercase). Any invalid combination falls back to Auto with
    // slot=0 and trackColorCustom="". Returns false if trackId is unknown.
    bool setTrackColor(int trackId,
                       TrackColorMode mode,
                       int slot,
                       const std::string& customColor = "");
    bool setTrackBounceSettings(int trackId, const BounceSettings& settings);
    bool setTrackZoomPanRotSettings(int trackId, const ZoomPanRotSettings& settings);
    // Direct keyframe authoring seam: replaces the track's ZPR curves wholesale,
    // bypassing the scalar rebuild-vs-preserve logic in
    // setTrackZoomPanRotSettings (that function can never be used to AUTHOR
    // curves, only to preserve or rebuild them from scalars). Trusts
    // tracks.authored as given rather than forcing it — undo/redo replay a
    // prior snapshot through this same setter and need to be able to restore
    // a non-authored one. The RPC entry point (zprTracksFromJson) is what
    // stamps authored=true for a genuine new user edit.
    bool setTrackZprTracks(int trackId, const ZprTracks& tracks);
    bool setTrackPingPongSettings(int trackId, const PingPongSettings& settings);
    bool setTrackSlideNoteEffectSettings(int trackId, const SlideNoteEffectSettings& settings);
    bool setNoteSlide(int patternId, int noteId, bool isSlide, float curveCx, float curveCy);

    // ── Mixer output routing (Prompt 2A) ──────────────────────────────────────
    // Validates then commits. Returns ok on success; caller should check before
    // pushing to undo stack. Does NOT push to undo; use SetTrackOutputRouteCommand.
    xleth::RoutingValidationResult setTrackOutputRoute(int sourceTrackId, int targetTrackId);
    TrackOutputRoute               getTrackOutputRoute(int sourceTrackId) const;

    // ── Sidechain routes (Prompt 4B) ──────────────────────────────────────────
    // Silent key/detector routes owned by the source track. These validate then
    // commit directly (no undo); the bridge wraps them in the *Command variants
    // so route mutations are undoable. `route.routeId` must be pre-generated by
    // the caller (bridge/test) and is preserved verbatim. `resolver` answers
    // whether targetEffectInstanceId resolves on the target track (Prompt 4A
    // lookup); pass an empty std::function to skip that check (model-only).
    // `capabilityResolver` (VST-SC.3, optional) rejects a resolvable-but-incapable
    // target with sidechain_unsupported; empty leaves the legacy behavior.
    xleth::RoutingValidationResult addSidechainRoute(
        int sourceTrackId, const SidechainRoute& route,
        const xleth::SidechainEffectResolver& resolver,
        const xleth::SidechainCapabilityResolver& capabilityResolver = {});
    xleth::RoutingValidationResult removeSidechainRoute(
        int sourceTrackId, const std::string& routeId);
    xleth::RoutingValidationResult setSidechainRouteParams(
        int sourceTrackId, const std::string& routeId,
        const xleth::SidechainRouteParams& params);
    std::vector<SidechainRoute>    getSidechainRoutes(int sourceTrackId) const;

    // ── Visual Effect Chain ───────────────────────────────────────────────────
    int  addVisualEffect(int trackId, VisualEffect::Type type);          // returns index, -1 on fail
    bool removeVisualEffect(int trackId, int effectIndex);
    bool reorderVisualEffect(int trackId, int fromIndex, int toIndex);
    bool setVisualEffectParam(int trackId, int effectIndex, int paramIndex, float value);
    bool setVisualEffectBypassed(int trackId, int effectIndex, bool bypassed);
    bool insertVisualEffectAt(int trackId, int index, const VisualEffect& fx); // for undo
    bool setTrackVisualEffectChainOrder(int trackId, const std::vector<int>& newOrder);
    const std::vector<VisualEffect>* getVisualEffectChain(int trackId) const;

    // Preview-only whole-chain mute for the chroma-key eyedropper. Deliberately
    // NOT a chain member (see m_previewMutedChainTrackIds below): it must never
    // enter TrackInfo's serialized fields, so Track.cpp's hand-maintained
    // to_json/from_json cannot pick it up even by accident, and project save/
    // load can never observe it. FrameCollector only consults it when a caller
    // opts in via collectRequests' applyPreviewEffectMute (the live preview
    // tick does; export and the snapshot-transition renderer do not), so an
    // active mute cannot leak into a render.
    bool setVisualEffectChainPreviewMuted(int trackId, bool muted);
    bool isVisualEffectChainPreviewMuted(int trackId) const;

    // ── Restore (undo/redo) ───────────────────────────────────────────────────
    // Insert with the original ID, skipping auto-increment. Used by commands to
    // re-insert previously removed entities during undo/redo without ID drift.
    bool restoreClip(const Clip& clip);
    bool restoreTrack(const TrackInfo& track);
    bool restoreRegion(const SampleRegion& region);
    bool restorePattern(const Pattern& pattern);
    bool restorePatternBlock(const PatternBlock& block);
    bool restoreNoteInPattern(int patternId, const PatternNote& note);

    // ── Bulk-edit guard ───────────────────────────────────────────────────────
    // Per-entity mutations log one line each to stdout/stderr, which the
    // Electron main process drains over a pipe. At a few hundred clips that
    // logging — not the edit itself — dominated the operation: a 200-clip
    // insert spent ~1ms per clip writing two log lines. Batch commands hold a
    // ScopedBulkEdit for the duration and print a single summary instead.
    // ERROR lines are never suppressed.
    struct ScopedBulkEdit {
        explicit ScopedBulkEdit(Timeline& t) : t_(t) { ++t_.m_bulkDepth; }
        ~ScopedBulkEdit() { --t_.m_bulkDepth; }
        ScopedBulkEdit(const ScopedBulkEdit&) = delete;
        ScopedBulkEdit& operator=(const ScopedBulkEdit&) = delete;
    private:
        Timeline& t_;
    };
    bool inBulkEdit() const { return m_bulkDepth > 0; }

    // ── Serialization ─────────────────────────────────────────────────────────
    nlohmann::json toJSON() const;
    bool           fromJSON(const nlohmann::json& j);

    // ── Cache-invalidation hook ───────────────────────────────────────────────
    // Registered by the bridge once the MixEngine is attached. Invoked from
    // addClip() and restoreClip() so any code path that inserts a clip also
    // queues its render-cache rebuild. The contract: after addClip/restoreClip
    // returns, the clip is fully stored AND (if a callback is registered) its
    // render state has been queued via MixEngine::invalidateClipCache.
    // Kept as an optional std::function to avoid a Timeline → MixEngine header
    // dependency. The callback is invoked on the caller's thread; the bridge
    // binds it to MixEngine::invalidateClipCache, which is message-thread safe
    // and short-circuits cheaply on identity clips.
    void setClipCacheInvalidator(std::function<void(int, const char*)> cb) {
        m_clipCacheInvalidator = std::move(cb);
    }

    // ── Reset ─────────────────────────────────────────────────────────────────
    // Wipes all project content (sources, regions, tracks, clips, patterns,
    // pattern blocks, grid layout) and resets metadata (BPM, time signature,
    // next-id counter) to defaults. Preserves Timeline object identity —
    // callers hold stable references to this object.
    void clear();

private:
    void syncActiveToVector();
    void materializeActive();
    // Look up a live snapshot by id (nullptr if none / empty id). Used by the
    // cue resolver and the default-snapshot fallback.
    const GridSnapshot* findSnapshot(const std::string& id) const;
    int getNextId();
    bool validateTrackLayout(const TrackLayout& layout, bool requireKnownFolders = true) const;
    void syncTrackOrdersFromLayout();
    void rebuildFlatTrackLayout();

    // Derived-state helpers: keep pattern.length in sync with its notes, and
    // cascade that length change to blocks that were in-sync (not manually trimmed).
    void recalcPatternLength(int patternId);
    void cascadeBlockDurations(int patternId, int64_t oldLength, int64_t newLength);

    double m_bpm;
    double m_sampleRate;
    int    m_timeSigNum;
    int    m_timeSigDen;
    int    m_nextId;
    bool   m_tempoLocked = true;

    std::map<int, SourceMedia>  m_sources;
    std::map<int, SampleRegion> m_regions;
    std::map<int, TrackInfo>    m_tracks;
    // Preview-only, not persisted — see setVisualEffectChainPreviewMuted above.
    std::unordered_set<int>     m_previewMutedChainTrackIds;
    std::map<int, TrackFolder>  m_trackFolders;
    std::vector<TrackLayoutItem> m_trackRootOrder;
    std::map<int, Clip>         m_clips;
    std::map<int, Pattern>      m_patterns;
    std::map<int, PatternBlock> m_patternBlocks;

    // Grid layout — snapshot container, decomposed for the runtime.
    //   m_gridLayout        : flat working view = global canvas/fps ⊕ ACTIVE
    //                         snapshot's arrangement (materialized cache served
    //                         over the unchanged flat IPC contract).
    //   m_activeSnapshotId  : id of the active snapshot (matches persisted
    //                         activeSnapshotId + snapshots[].id). Minted on
    //                         create/clear and on legacy-project migration.
    //   m_activeSnapshotName: display name of the active snapshot.
    //   m_gridSnapshots      : authoritative live arrangements (always >= 1).
    //   m_defaultSnapshotId : id of the "Base" snapshot the render path falls back
    //                         to before the first cue / when no cue resolves.
    //                         Initialized to the initial active snapshot; persisted
    //                         and re-resolved on load (falls back to the first
    //                         snapshot when absent or dangling).
    //   m_gridCues          : typed, tick-sorted snapshot automation. Consulted
    //                         ONLY by the render path (Timeline::gridLayoutAt);
    //                         the editing path never resolves by tick.
    GridLayout                  m_gridLayout;
    std::string                 m_activeSnapshotId   = generateSnapshotId();
    std::string                 m_activeSnapshotName = "Base";
    std::string                 m_defaultSnapshotId  = m_activeSnapshotId;
    std::vector<GridSnapshot>   m_gridSnapshots;
    std::vector<GridCue>        m_gridCues;
    LoopRegion                  m_loopRegion;   // single global loop/render region
    double m_declickMs = 0.5; // global clip boundary fade duration in ms (0 = disabled)
    int    m_globalStretchMethod = static_cast<int>(StretchMethod::PSOLA);

    std::function<void(int, const char*)> m_clipCacheInvalidator;

    // Nesting depth of ScopedBulkEdit — see inBulkEdit(). Message thread only.
    int m_bulkDepth = 0;
};

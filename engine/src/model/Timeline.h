#pragma once
#include "TimelineTypes.h"
#include "SampleRegion.h"
#include "Track.h"
#include "Clip.h"
#include "Pattern.h"
#include "PatternBlock.h"
#include "audio/TrackRouting.h"
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <unordered_set>
#include <vector>
#include <nlohmann/json.hpp>

// std::atomic is neither copyable nor movable, which silently deletes the
// compiler-generated copy/move constructor and assignment for any class that
// embeds one directly — Timeline needs those (ProjectManager::loadProject
// returns one by value inside std::optional<Timeline>, and
// XlethEngineService.cpp move-assigns a freshly loaded one over *g_timeline).
// A generation counter has no resource to steal on move and no identity to
// preserve on copy, so a plain load()+store() is a correct "copy": the
// counter keeps working as a lock-free, relaxed cross-thread-visible atomic
// for its normal callers, and additionally becomes copy/move-able for the
// handful of call sites that replace the whole Timeline at once.
template <typename T>
struct CopyableAtomic : std::atomic<T> {
    CopyableAtomic() noexcept = default;
    constexpr CopyableAtomic(T value) noexcept : std::atomic<T>(value) {}
    CopyableAtomic(const CopyableAtomic& other) noexcept
        : std::atomic<T>(other.load(std::memory_order_relaxed)) {}
    CopyableAtomic& operator=(const CopyableAtomic& other) noexcept {
        this->store(other.load(std::memory_order_relaxed), std::memory_order_relaxed);
        return *this;
    }
};

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
    // Bumped every time track membership or order changes (add/remove/reorder
    // — syncTrackOrdersFromLayout() is the single choke point every such
    // mutation funnels through). MixEngine polls this to know when its
    // per-block track-slot snapshot needs rebuilding, instead of rebuilding
    // it from getAllTracks() on every audio callback.
    uint64_t getTrackTopologyGeneration() const {
        return m_trackTopologyGeneration.load(std::memory_order_relaxed);
    }
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
    // Bumped on every clip add/remove/move/resize/restore/bulk-load. MixEngine
    // uses this to know when its position-sorted clip cache (and the
    // incremental active-clip scan built on top of it) must fully rebuild,
    // rather than trusting cached Clip* pointers that a removal could have
    // invalidated or a move/resize could have made stale.
    uint64_t getClipTopologyGeneration() const {
        return m_clipTopologyGeneration.load(std::memory_order_relaxed);
    }
    bool                       removeClip(int id);
    std::vector<const Clip*>   getClipsOnTrack(int trackId) const;
    // Returns clips whose position falls in [start, end)
    std::vector<const Clip*>   getClipsInRange(TickTime start, TickTime end) const;
    bool                       moveClip(int clipId, int newTrackId, TickTime newPosition);
    bool                       resizeClip(int clipId, TickTime newDuration);
    bool                       resizeClipLeft(int clipId, TickTime newPosition, TickTime newDuration, TickTime newRegionOffset);

    // ── Automation clips (Phase A) ────────────────────────────────────────────
    //
    // Three collections mirroring the Pattern / PatternBlock split:
    //   lanes      grouping rows under a track (ownerTrackId -1 = Master);
    //   envelopes  the point data plus its parameter binding;
    //   clips      placements referencing a lane and an envelope.
    //
    // Clips SHARE an envelopeId the way pattern blocks share a patternId, so
    // copying a clip copies nothing but the placement until makeAutomationClipUnique
    // splits the envelope off.
    //
    // Every mutator here is the raw model operation: it validates and commits but
    // does NOT push undo. Callers go through the *AutomationClip* commands in
    // commands/TimelineCommands.h, which is where the project's "all timeline
    // mutations through UndoManager" invariant is enforced.

    // Lanes. addAutomationLane assigns the id; index < 0 appends after the
    // owner's current last lane.
    int                                 addAutomationLane(AutomationLane lane);
    const AutomationLane*               getAutomationLane(int id) const;
    std::vector<const AutomationLane*>  getAllAutomationLanes() const;
    // Lanes of one owner (-1 = the Master group), ascending by index.
    std::vector<const AutomationLane*>  getAutomationLanesForOwner(int ownerTrackId) const;
    // Removes the lane AND every clip on it. Envelopes are left alone — another
    // lane's clip may still share one. Returns false if the lane is unknown.
    bool                                removeAutomationLane(int id);
    bool                                restoreAutomationLane(const AutomationLane& lane);
    bool                                setAutomationLaneIndex(int id, int index);

    // Envelopes.
    int                                     addAutomationEnvelope(AutomationEnvelope envelope);
    const AutomationEnvelope*               getAutomationEnvelope(int id) const;
    AutomationEnvelope*                     getAutomationEnvelopeMutable(int id);
    std::vector<const AutomationEnvelope*>  getAllAutomationEnvelopes() const;
    bool                                    removeAutomationEnvelope(int id);
    bool                                    restoreAutomationEnvelope(const AutomationEnvelope& envelope);
    // Wholesale point replacement — the seam undo commands use to restore a
    // snapshot without replaying individual point edits. Re-normalizes.
    bool                                    setAutomationEnvelopePoints(int envelopeId,
                                                                        std::vector<AutomationPoint> points);

    // Clips. addAutomationClip REJECTS (returns -1) a placement that overlaps
    // another clip on the same lane — the spec's same-lane overlap rule lives
    // here, in the mutation layer, so no command can bypass it.
    int                                 addAutomationClip(AutomationClip clip);
    const AutomationClip*               getAutomationClip(int id) const;
    std::vector<const AutomationClip*>  getAllAutomationClips() const;
    std::vector<const AutomationClip*>  getAutomationClipsOnLane(int laneId) const;
    bool                                removeAutomationClip(int id);
    bool                                restoreAutomationClip(const AutomationClip& clip);
    bool                                moveAutomationClip(int id, int newLaneId, TickTime newPosition);
    bool                                resizeAutomationClip(int id, TickTime newDuration);
    bool                                resizeAutomationClipLeft(int id, TickTime newPosition,
                                                                 TickTime newDuration, TickTime newOffset);
    // Duplicates the clip's envelope and repoints the clip at the copy, so later
    // point edits stop propagating to its siblings. Returns the NEW envelope id,
    // or -1 when the clip is unknown / its envelope is missing. Idempotent in
    // effect but not in identity: calling it twice makes two envelopes.
    int                                 makeAutomationClipUnique(int id);

    // True when [position, position + duration) intersects an existing clip on
    // `laneId`. `ignoreClipId` excludes one clip (the one being moved/resized).
    // Public so a command can pre-validate before mutating anything.
    bool automationClipOverlaps(int laneId, TickTime position, TickTime duration,
                                int ignoreClipId = -1) const;

    // Points. Index-based, mirroring paramtrack's keyframe API. All of these
    // maintain the sorted-ascending-by-tick invariant.
    bool addAutomationPoint(int envelopeId, AutomationPoint point);
    bool removeAutomationPoint(int envelopeId, int pointIndex);
    bool moveAutomationPoint(int envelopeId, int pointIndex, TickTime newTick, double newValue);
    bool setAutomationPointCurve(int envelopeId, int pointIndex,
                                 AutomationCurveType curveType, double tension);

    // Deletion contract query: every clip whose envelope binds to this effect
    // instance. This is what the UI's "these clips will be deleted" confirmation
    // dialog lists before an effect is removed. ownerTrackId -1 = Master chain.
    std::vector<const AutomationClip*> getAutomationClipsForEffectInstance(
        int ownerTrackId, const std::string& effectInstanceId) const;
    // The envelope ids behind those clips (deduplicated).
    std::vector<int> getAutomationEnvelopeIdsForEffectInstance(
        int ownerTrackId, const std::string& effectInstanceId) const;

    // ── Automation base values ────────────────────────────────────────────────
    // The manual (knob) value a bound parameter reads before any clip has ever
    // played, and the value a manual edit outside every clip writes. Stored ONCE
    // per binding, never per envelope: two lanes automating the same parameter
    // necessarily share one manual value.
    double getAutomationBaseValue(const AutomationBinding& binding, bool* found = nullptr) const;
    void   setAutomationBaseValue(const AutomationBinding& binding, double value);
    bool   clearAutomationBaseValue(const AutomationBinding& binding);
    const std::map<AutomationBinding, double>& getAllAutomationBaseValues() const {
        return m_automationBaseValues;
    }

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
    // Project-wide motion blur for Lens / Roam / Sweep (MotionBlurSettings in
    // TimelineTypes.h). A render preference like declickMs: not an undoable
    // edit. The shutter is sanitized on the way in.
    void   setMotionBlur(const MotionBlurSettings& m);
    const MotionBlurSettings& getMotionBlur() const { return m_motionBlur; }

    // ── Color Grade (model/ColorGrade.h) ──────────────────────────────────────
    // The Master grade lives here; the Source, Clip / Region and Layer grades
    // live on SourceMedia, Clip / SampleRegion and TrackInfo. One accessor pair
    // for all of them, so the undo command and the bridge do not each repeat
    // the level switch. `id` is ignored for Master. getColorGrade returns
    // nullptr and setColorGrade returns false when the owner does not exist.
    const ColorGrade* getColorGrade(xleth::grade::Level level, int id) const;
    bool              setColorGrade(xleth::grade::Level level, int id, const ColorGrade& grade);
    const ColorGrade& getMasterColorGrade() const { return m_masterColorGrade; }

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

    // gridLayoutAt's arrangement read IN PLACE (no copy, no allocation): the
    // snapshot in effect at `t`, or nullptr when the project has no snapshot
    // (getGridLayout() is then the arrangement). For the render path's Parent
    // lookups (docs/XLETH_MOTION_VIEW_DESIGN.md R7), which need the FULL
    // layout even while the collector draws a transition / Landing override.
    // Valid while the caller holds the lock that guards the timeline.
    const GridSnapshot* gridSnapshotAt(TickTime t) const { return snapshotAt(t); }

    // ── Grid cues (CRUD; sorted-by-tick invariant maintained internally) ──────
    // addGridCue inserts keeping ascending tick order; if a cue already exists at
    // the exact tick its snapshotId is replaced (its transition and landings are
    // kept). moveGridCue relocates the WHOLE cue at oldTick — snapshot, transition
    // and landings — to newTick (false if none at oldTick). removeGridCue deletes the cue
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

    // ── Landings (docs/XLETH_LANDING_SPEC.md) ─────────────────────────────────
    // Replace the landing list on the cue at `cueTick`. No-op if there is no cue
    // at that exact tick. The list is sanitized (sanitizeTrackLandings):
    // normalized, de-duplicated by trackId with the later entry winning, and
    // capped at TrackLanding::kMaxLandingsPerCue. Same by-value / under-lock
    // discipline as setCueTransition; not on the UndoManager (spec ruling 10).
    void setCueLandings(TickTime cueTick, const std::vector<TrackLanding>& landings);

    // Reflow: for every track that has a grid slot in the cue's snapshot (B) and
    // is also placed in the outgoing snapshot (A — a slot or a fullscreen layer)
    // at a DIFFERENT canvas rect, add or replace a WhereItWas landing with this
    // lead-in. Tracks in B that are not in A are left alone, and landings for
    // other tracks are kept. Returns false (and changes nothing) when there is
    // no cue at that tick or its snapshot no longer resolves.
    bool reflowCueLandings(TickTime cueTick, int64_t leadInTicks);

    // True when any cue carries a landing. The render seams test this first so
    // a project without landings pays one short scan and nothing else.
    bool hasCueLandings() const noexcept {
        for (const GridCue& cue : m_gridCues)
            if (!cue.landings.empty()) return true;
        return false;
    }

    // ── Time-based landing resolution (RENDER path only) ──────────────────────
    // One landing, resolved against the snapshots as they are NOW. Plain data:
    // the render thread owns it outright and nothing aliases the model.
    struct ResolvedLanding {
        int    trackId = -1;
        float  fromX = 0.0f, fromY = 0.0f, fromW = 0.0f, fromH = 0.0f;   // canvas-normalized
        float  toX   = 0.0f, toY   = 0.0f, toW   = 0.0f, toH   = 0.0f;   // == B's drawn rect for this track's slot
        float  fromOpacity = 1.0f;
        TickTime startTick{};                 // pin - clampedLeadIn
        SnapshotTransitionEasingCurve easing{};

        // The size a Roam offset is measured in (the placement BEFORE the gap)
        // at each end of the move. Lerped with the rect, so a track that also
        // roams does not jump when the carry ends (audit D3).
        float  fromUnitW = 0.0f, fromUnitH = 0.0f;
        float  toUnitW   = 0.0f, toUnitH   = 0.0f;

        // The track's GridSlot in B, copied out so the carry layout can be
        // built without copying a GridLayout (audit D4).
        int    slotGridX = 0, slotGridY = 0, slotSpanX = 0, slotSpanY = 0;
        float  slotOpacity = 1.0f;
        int    slotZOrder  = 0;
    };

    struct ResolvedLandings {
        int      count = 0;                   // 0 => caller takes today's path untouched
        TickTime pinTick{};
        TickTime carryEndTick{};              // pin + transition.endOffsetTicks if the
                                              // transition is enabled, else pin
        // Snapshot B's geometry, for the carry layout.
        int      columns  = 1;
        int      rows     = 1;
        float    gapScale = 0.0f;
        ResolvedLanding items[TrackLanding::kMaxLandingsPerCue];
    };

    // Resolve the landings to carry at tick `t`.
    //
    // A cue's window is [earliest resolved startTick, carryEndTick). When more
    // than one cue's window contains t the LATEST pin wins, like transitionAt.
    //   • Lead-in is clamped at resolve time: startTick = max(pin - leadIn,
    //     previous resolving cue's pin, or 0). Stored data is never rewritten.
    //   • The destination is the track's GridSlot in B, as B is now.
    //   • A landing is skipped, never fatal, when its track is gone, when the
    //     track has no grid slot in B (none, or only a fullscreen layer), or
    //     when the cue's snapshot is gone.
    // const, allocation-free, and reads the snapshots in place: call it under
    // the same lock as transitionAt (preview: syncEventsMutex).
    ResolvedLandings landingsAt(TickTime t) const;

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
    // Same blocks, same (id) order, without building a vector — for the audio
    // thread, which walks this every block and must not allocate.
    const std::map<int, PatternBlock>&   getPatternBlockMap() const { return m_patternBlocks; }
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

    // ── Whole-note-set replacement (MIDI re-import) ───────────────────────────
    // Swaps a pattern's entire note set in ONE step, then recalculates length
    // exactly once.
    //
    // Deliberately not "clear, then addNotesToPatternBulk": an intermediate
    // clear would run recalcPatternLength against an empty note list, collapse
    // the pattern to the 1-bar minimum, and cascade every in-sync block down to
    // 3840 ticks BEFORE the new notes arrive. cascadeBlockDurations identifies
    // untrimmed blocks by `duration == oldLength`, so it must observe exactly
    // one transition (real old length → real new length) or it resizes the
    // wrong set: blocks the user had deliberately trimmed to one bar would be
    // swept up, and genuinely in-sync blocks would already have been moved off
    // the old length and so be skipped.
    //
    // `notes` is taken by reference and has its ids rewritten in place, matching
    // addNotesToPatternBulk. Returns false if patternId is unknown.
    bool replacePatternNotes(int patternId, std::vector<PatternNote>& notes);

    // Verbatim note-set restore for undo. Reinstates the exact note objects
    // (ids included), the pattern's nextNoteId counter and its stored length
    // WITHOUT recalculating or cascading.
    //
    // The cascade is not invertible: replaying it backwards would resize any
    // block the user had trimmed to exactly the NEW length. Callers that need
    // block durations back must snapshot them before mutating and restore them
    // explicitly (see ImportMidiCommand::UpdatedTrackSnapshot).
    // Whole-list note edit that KEEPS ids: every note with id > 0 keeps it, a
    // note with id <= 0 gets a fresh one from the pattern's counter (written
    // back into `notes`). Then one recalcPatternLength, so the block cascade
    // sees a single length transition. Used by EditPatternNotesCommand, whose
    // undo is simply this call again with the before-list.
    bool setPatternNotesKeepIds(int patternId, std::vector<PatternNote>& notes);

    bool restorePatternNotes(int patternId,
                             const std::vector<PatternNote>& notes,
                             int nextNoteId,
                             TickTime length);

    // ── Track type / sampler ──────────────────────────────────────────────────
    // Pattern tracks are sample-agnostic containers for PatternBlocks. Any
    // pattern (regardless of its regionId) can be placed on any pattern track.
    bool convertToPatternTrack(int trackId);
    bool convertToClipTrack(int trackId);
    bool setTrackVideoFlipConfig(int trackId, const VideoFlipConfig& config);
    bool setTrackVideoHoldLastFrame(int trackId, bool hold);
    // thresholdBeats < 0 is normalized to kHoldLastFrameThresholdUnlimited.
    bool setTrackVideoHoldLastFrameThresholdBeats(int trackId, double thresholdBeats);
    // Smart gap detection + freeze/keep-playing fill (see TrackInfo).
    bool setTrackVideoHoldBehavior(int trackId, bool smart, bool keepPlaying);
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
    // Pattern-track exclusive (see NoteFadeSettings). Writing it on a Clip track
    // is accepted and persisted but has no visual effect — FrameCollector gates
    // on the track type, so the type check is not duplicated here.
    bool setTrackNoteFadeSettings(int trackId, const NoteFadeSettings& settings);
    bool setNoteSlide(int patternId, int noteId, bool isSlide, float curveCx, float curveCy);

    // ── Mixer output routing (Prompt 2A) ──────────────────────────────────────
    // Validates then commits. Returns ok on success; caller should check before
    // pushing to undo stack. Does NOT push to undo; use SetTrackOutputRouteCommand.
    xleth::RoutingValidationResult setTrackOutputRoute(int sourceTrackId, int targetTrackId);
    TrackOutputRoute               getTrackOutputRoute(int sourceTrackId) const;

    // FL multi-wiring: replace a track's whole audible destination set (primary
    // output + sends) after validateTrackRoutes. Send gains are clamped [0,2].
    xleth::RoutingValidationResult setTrackRoutes(int sourceTrackId, int targetTrackId,
                                                  const std::vector<TrackSend>& sends);
    // Live level of one existing send (a knob drag; not undo-tracked, like the
    // fader). Returns unknown_route when the source has no send to targetTrackId.
    xleth::RoutingValidationResult setTrackSendGain(int sourceTrackId, int targetTrackId,
                                                    float gain);

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
    // The snapshot in effect at tick `t`, read in place: the LAST cue at or
    // before t that still resolves, else the default snapshot, else the first.
    // nullptr only when the project has no snapshot at all. This is
    // gridLayoutAt's selection without the copy.
    const GridSnapshot* snapshotAt(TickTime t) const;
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
    CopyableAtomic<uint64_t>    m_trackTopologyGeneration{0};
    // Preview-only, not persisted — see setVisualEffectChainPreviewMuted above.
    std::unordered_set<int>     m_previewMutedChainTrackIds;
    std::map<int, TrackFolder>  m_trackFolders;
    std::vector<TrackLayoutItem> m_trackRootOrder;
    std::map<int, Clip>         m_clips;
    CopyableAtomic<uint64_t>    m_clipTopologyGeneration{0};
    std::map<int, Pattern>      m_patterns;
    std::map<int, PatternBlock> m_patternBlocks;

    // Automation clips (Phase A). Three collections drawing on the SAME
    // auto-incremented id space as every other entity, so a lane, a clip and an
    // envelope can never collide on an id and ProjectManager's max-id scan on
    // load stays correct without special-casing them.
    std::map<int, AutomationLane>     m_automationLanes;
    std::map<int, AutomationClip>     m_automationClips;
    std::map<int, AutomationEnvelope> m_automationEnvelopes;
    // Manual (knob) value per bound parameter — see getAutomationBaseValue.
    std::map<AutomationBinding, double> m_automationBaseValues;

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
    MotionBlurSettings m_motionBlur;   // project-wide Lens/Roam/Sweep motion blur (default off)
    ColorGrade         m_masterColorGrade;   // applied to the final composite (default neutral)

    std::function<void(int, const char*)> m_clipCacheInvalidator;

    // Nesting depth of ScopedBulkEdit — see inBulkEdit(). Message thread only.
    int m_bulkDepth = 0;
};

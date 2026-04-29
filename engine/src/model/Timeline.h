#pragma once
#include "TimelineTypes.h"
#include "SampleRegion.h"
#include "Track.h"
#include "Clip.h"
#include "Pattern.h"
#include "PatternBlock.h"
#include <functional>
#include <map>
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
    bool                         removeTrack(int id);

    // ── Clips ─────────────────────────────────────────────────────────────────
    int                        addClip(Clip clip);
    const Clip*                getClip(int id) const;
    Clip*                      getClipMutable(int id);
    std::vector<const Clip*>   getAllClips() const;
    bool                       removeClip(int id);
    std::vector<const Clip*>   getClipsOnTrack(int trackId) const;
    // Returns clips whose position falls in [start, end)
    std::vector<const Clip*>   getClipsInRange(TickTime start, TickTime end) const;
    bool                       moveClip(int clipId, TickTime newPosition);
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

    // ── Grid Layout ───────────────────────────────────────────────────────────
    const GridLayout& getGridLayout() const { return m_gridLayout; }
    void   setGridLayout(const GridLayout& layout);
    void   assignTrackToGrid(int trackId, int gridX, int gridY, int spanX, int spanY);
    // Same as assignTrackToGrid but stores the supplied zOrder on the slot
    // instead of resetting to 0. Used by the grid editor's drag-to-place flow
    // so that a fresh placement landing on top is a single atomic command.
    void   assignTrackToGridWithZOrder(int trackId, int gridX, int gridY,
                                       int spanX, int spanY, int zOrder);
    void   removeTrackFromGrid(int trackId);
    void   setChorusTrack(int trackId);
    void   setCrashOverlay(bool enabled, int trackId, float opacity);
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
    bool setTrackCornerRadius(int trackId, float radius);
    bool setTrackGapScaleOverride(int trackId, float gapScale);
    bool setTrackSubdivisionFactor(int trackId, int factor);
    bool setTrackBounceSettings(int trackId, const BounceSettings& settings);
    bool setTrackZoomPanRotSettings(int trackId, const ZoomPanRotSettings& settings);
    bool setTrackPingPongSettings(int trackId, const PingPongSettings& settings);
    bool setTrackSlideNoteEffectSettings(int trackId, const SlideNoteEffectSettings& settings);
    bool setNoteSlide(int patternId, int noteId, bool isSlide, float curveCx, float curveCy);

    // ── Visual Effect Chain ───────────────────────────────────────────────────
    int  addVisualEffect(int trackId, VisualEffect::Type type);          // returns index, -1 on fail
    bool removeVisualEffect(int trackId, int effectIndex);
    bool reorderVisualEffect(int trackId, int fromIndex, int toIndex);
    bool setVisualEffectParam(int trackId, int effectIndex, int paramIndex, float value);
    bool setVisualEffectBypassed(int trackId, int effectIndex, bool bypassed);
    bool insertVisualEffectAt(int trackId, int index, const VisualEffect& fx); // for undo
    bool setTrackVisualEffectChainOrder(int trackId, const std::vector<int>& newOrder);
    const std::vector<VisualEffect>* getVisualEffectChain(int trackId) const;

    // ── Restore (undo/redo) ───────────────────────────────────────────────────
    // Insert with the original ID, skipping auto-increment. Used by commands to
    // re-insert previously removed entities during undo/redo without ID drift.
    bool restoreClip(const Clip& clip);
    bool restoreTrack(const TrackInfo& track);
    bool restoreRegion(const SampleRegion& region);
    bool restorePattern(const Pattern& pattern);
    bool restorePatternBlock(const PatternBlock& block);
    bool restoreNoteInPattern(int patternId, const PatternNote& note);

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
    int getNextId();

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
    std::map<int, Clip>         m_clips;
    std::map<int, Pattern>      m_patterns;
    std::map<int, PatternBlock> m_patternBlocks;

    GridLayout                  m_gridLayout;
    double m_declickMs = 0.5; // global clip boundary fade duration in ms (0 = disabled)

    std::function<void(int, const char*)> m_clipCacheInvalidator;
};

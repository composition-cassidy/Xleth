#pragma once
#include "TimelineTypes.h"
#include "SampleRegion.h"
#include "Track.h"
#include "Clip.h"
#include "Pattern.h"
#include "PatternBlock.h"
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
    bool removeNoteFromPattern(int patternId, int noteId);
    bool moveNote(int patternId, int noteId, TickTime newPosition, int newPitch);
    bool resizeNote(int patternId, int noteId, TickTime newDuration);
    bool setNoteVelocity(int patternId, int noteId, float velocity);

    // ── Track type / sampler ──────────────────────────────────────────────────
    // Pattern tracks are sample-agnostic containers for PatternBlocks. Any
    // pattern (regardless of its regionId) can be placed on any pattern track.
    bool convertToPatternTrack(int trackId);
    bool convertToClipTrack(int trackId);
    bool setTrackFxMode(int trackId, TrackFxMode mode);
    bool setTrackVideoFlipMode(int trackId, VideoFlipMode mode);
    bool setTrackVideoHoldLastFrame(int trackId, bool hold);

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

    std::map<int, SourceMedia>  m_sources;
    std::map<int, SampleRegion> m_regions;
    std::map<int, TrackInfo>    m_tracks;
    std::map<int, Clip>         m_clips;
    std::map<int, Pattern>      m_patterns;
    std::map<int, PatternBlock> m_patternBlocks;

    GridLayout                  m_gridLayout;
    double m_declickMs = 0.5; // global clip boundary fade duration in ms (0 = disabled)
};

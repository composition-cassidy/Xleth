#pragma once

/**
 * ArpVideoExpander — Shared arp-to-video-event expansion for both
 * realtime preview and offline render paths.
 *
 * Simulates the arpeggiator in beat-space and emits one VideoEvent per
 * arp step instead of one per raw pattern note.  The state machine is a
 * line-for-line port of Arpeggiator::getNextNote() (Arpeggiator.cpp).
 *
 * Used by:
 *   - OfflineRenderer::buildVideoEvents()   (offline export)
 *   - rebuildVideoEventsFromClips()          (realtime preview, XlethAddon.cpp)
 */

#include "SyncManager.h"          // VideoEvent
#include "model/TimelineTypes.h"  // PatternNote

#include <cstdint>
#include <vector>

// ---------------------------------------------------------------------------
// Internal simulation types
// ---------------------------------------------------------------------------

struct ArpNoteEvent {
    double beatPos;
    int    pitch;
    float  velocity;
    bool   isNoteOn;   // true = noteOn, false = noteOff
};

struct ArpSimState {
    std::vector<int> heldNotes;   // sorted ascending, mirrors Arpeggiator::heldNotes_
    float storedVelocity = 1.0f;
    int   currentStep    = 0;
    int   direction;              // 0=Up, 1=Down, 2=UpDown, 3=UpDownSticky
    int   range;                  // octave range (1=base only, 2=+1 oct, etc.)
};

// ---------------------------------------------------------------------------
// ArpVideoExpander
// ---------------------------------------------------------------------------

class ArpVideoExpander
{
public:
    /**
     * Advance the arp state machine by one step and return the MIDI pitch.
     * Line-for-line port of Arpeggiator::getNextNote().
     */
    static int getNextArpNote(ArpSimState& s);

    /**
     * Generate arp-subdivided VideoEvents for all notes in a single pattern
     * block's visible window.
     *
     * @param notes             Sorted (by position) pointers into the pattern's notes
     * @param blockPosTicks     Block's timeline position in ticks
     * @param blockDurationTicks Block's duration in ticks
     * @param patternLenTicks   Pattern length in ticks
     * @param loopEnabled       Whether the block loops
     * @param firstLoopIdx      First loop iteration index visible in window
     * @param lastLoopIdx       Last loop iteration index visible in window
     * @param windowStart       Window start in pattern-relative ticks (= block offset)
     * @param windowEnd         Window end in pattern-relative ticks
     * @param arpTempoSync      Tempo-sync mode (true) or free-time (false)
     * @param arpDivision       Musical division (4=quarter, 8=eighth, 16=16th)
     * @param arpFreeTimeMs     Step time in ms when tempoSync=false
     * @param arpGate           Gate ratio 0.0-1.0
     * @param arpRange          Octave range (1=stay, 2=+1 oct, etc.)
     * @param arpDirection      0=Up, 1=Down, 2=UpDown, 3=UpDownSticky
     * @param bpm               Tempo
     * @param sourceId          Video source ID
     * @param trackId           Originating track ID
     * @param sourceStartTime   Source video start time (seconds)
     * @param sourceEndTime     Source video end time (seconds, for hold-last-frame)
     * @param counter           Per-track running globalNoteIndex (mutated)
     * @return  Vector of VideoEvents — one per arp step
     */
    static std::vector<VideoEvent> expandArpVideoEvents(
        const std::vector<const PatternNote*>& notes,
        int64_t blockPosTicks,
        int64_t blockDurationTicks,
        int64_t patternLenTicks,
        bool    loopEnabled,
        int64_t firstLoopIdx,
        int64_t lastLoopIdx,
        int64_t windowStart,
        int64_t windowEnd,
        bool    arpTempoSync,
        int     arpDivision,
        float   arpFreeTimeMs,
        float   arpGate,
        int     arpRange,
        int     arpDirection,
        double  bpm,
        int     sourceId,
        int     trackId,
        int     regionId,           // SampleRegion id (for per-region proxy routing)
        double  sourceStartTime,
        double  sourceEndTime,
        int&    counter);
};

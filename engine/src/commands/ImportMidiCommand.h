#pragma once

#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <unordered_map>
#include <vector>

class MixEngine;
class SampleBank;
class Timeline;

struct ImportMidiCommandOptions {
    std::string sourcePath;       // for describe()/diagnostic only
    bool        tempoOverride = false;
    double      sourceBPM     = 0.0;
    int         projectTPQ    = 960;

    // Create: build a brand new Pattern track + pattern + block at tick 0.
    // Update: rewrite the notes of the pattern already on `targetTrackId`,
    //         leaving the track itself (name, grid placement, sampler settings,
    //         visualOnly) and every block position alone. This is the
    //         re-import-after-editing-in-the-DAW path.
    enum class Mode { Create, Update };

    struct OutputTrackSpec {
        int                       outputTrackIndex = 0;  // index into MIDI metadata.outputTracks
        std::string               name;
        bool                      visualOnly = false;
        int                       regionId   = -1;       // existing SampleRegion id; -1 -> import as unassigned pattern
        std::vector<PatternNote>  notes;                 // pre-converted, pre-grouped by outputTrackIndex
        Mode                      mode = Mode::Create;
        // Update only. Must name an existing Pattern-type track carrying at
        // most one distinct pattern; anything else hard-fails the row (it is
        // never silently downgraded to Create).
        int                       targetTrackId = -1;
    };

    std::vector<OutputTrackSpec> outputTracks;

    // ── Placement (dialog-level, one set per import) ─────────────────────────
    // Create rows only. Update rows always preserve the target track's
    // existing block placements and never read either field.
    TickTime importPosition;          // resolved tick for the first block; caller
                                       // resolves "at playhead" itself, this
                                       // command never reads transport state.
    bool     tileToFillProject = false;
};

class ImportMidiCommand : public Command {
public:
    struct CreatedSampleSlotInfo {
        int         sampleBankId = -1;
        std::string filePath;
    };

    ImportMidiCommand(ImportMidiCommandOptions options,
                      MixEngine& mixEngine,
                      SampleBank& sampleBank,
                      double engineSampleRate);

    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    // Bridge post-pass (mipmap generation) reads created sample slots after
    // dispatch. Valid for the lifetime of the command (held in UndoManager
    // stacks). Empty until execute() has run.
    const std::vector<CreatedSampleSlotInfo>& getCreatedSampleSlots() const {
        return createdSampleSlots_;
    }

private:
    void capturePreImportState(Timeline& timeline);

    ImportMidiCommandOptions options_;
    MixEngine*               mixEngine_           = nullptr;
    SampleBank*              sampleBank_          = nullptr;
    double                   engineSampleRate_    = 44100.0;
    bool                     hasCapturedPreState_ = false;

    // ── Update-mode rollback snapshot ────────────────────────────────────────
    // Everything execute() overwrites on an updated track, captured immediately
    // before the first mutation of that track.
    struct UpdatedTrackSnapshot {
        int                      trackId   = -1;
        int                      patternId = -1;
        std::vector<PatternNote> notes;               // verbatim, ids included
        int                      nextNoteId = 1;
        TickTime                 patternLength;
        int                      regionId = -1;       // pattern binding before the update
        // blockId -> duration before the update, for EVERY block of this
        // pattern. The cascade rule (resize only untrimmed blocks) is not
        // invertible, so undo replays exact durations instead of re-cascading.
        std::vector<std::pair<int, TickTime>> blockDurations;
    };

    // Applies one update-mode row. Returns false when the row hard-fails
    // validation (the caller logs and skips it; it is never turned into a
    // create). Any entity it creates is pushed to the created* vectors so the
    // shared undo path removes it.
    bool executeUpdateRow(Timeline& timeline,
                          const ImportMidiCommandOptions::OutputTrackSpec& spec,
                          int resolvedRegionId,
                          bool bindRegion);

    // Resolve/load/map the audio for `spec.regionId`. Returns false if the row
    // cannot be bound (unresolvable region or source, or a failed load) — the
    // caller then skips the row entirely, exactly as create mode does.
    bool resolveRegionBinding(Timeline& timeline,
                              const ImportMidiCommandOptions::OutputTrackSpec& spec,
                              bool& outCreatedMapping,
                              int& outSampleBankId);

    // Pre-execute snapshot
    double                       preBpm_ = 0.0;
    std::unordered_map<int, int> preRegionToSampleMap_;
    // Max end tick (position + duration) across every block that existed
    // BEFORE this command placed anything. Tile-to-fill covers up to this
    // point, never to a point inflated by the command's own placements.
    TickTime                     preProjectEndTick_;

    // Per-execute creation log (for undo + bridge mipmap post-pass)
    std::vector<int>                    createdTrackIds_;
    std::vector<int>                    createdRegionIds_;       // empty in normal flow; defensive
    std::vector<int>                    createdPatternIds_;
    std::vector<int>                    createdPatternBlockIds_;
    std::vector<CreatedSampleSlotInfo>  createdSampleSlots_;     // only slots THIS command allocated
    std::vector<int>                    createdMappedRegionIds_; // only mappings THIS command created

    // Per-execute update log. Cleared by undo() so a redo re-captures against
    // the (now restored) pre-import state.
    std::vector<UpdatedTrackSnapshot>   updatedTracks_;
    // Drives describe(). Sticky across execute/undo: the undo stack label must
    // not change shape depending on whether the command is currently applied.
    bool                                hasUpdateRows_ = false;
};

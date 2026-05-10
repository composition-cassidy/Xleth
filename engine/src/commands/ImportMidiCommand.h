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

    struct OutputTrackSpec {
        int                       outputTrackIndex = 0;  // index into MIDI metadata.outputTracks
        std::string               name;
        bool                      visualOnly = false;
        int                       regionId   = -1;       // existing SampleRegion id; -1 -> import as unassigned pattern
        std::vector<PatternNote>  notes;                 // pre-converted, pre-grouped by outputTrackIndex
    };

    std::vector<OutputTrackSpec> outputTracks;
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

    // Pre-execute snapshot
    double                       preBpm_ = 0.0;
    std::unordered_map<int, int> preRegionToSampleMap_;

    // Per-execute creation log (for undo + bridge mipmap post-pass)
    std::vector<int>                    createdTrackIds_;
    std::vector<int>                    createdRegionIds_;       // empty in normal flow; defensive
    std::vector<int>                    createdPatternIds_;
    std::vector<int>                    createdPatternBlockIds_;
    std::vector<CreatedSampleSlotInfo>  createdSampleSlots_;     // only slots THIS command allocated
    std::vector<int>                    createdMappedRegionIds_; // only mappings THIS command created
};

#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <unordered_map>
#include <vector>

class Timeline;

// ─── AddClipCommand ───────────────────────────────────────────────────────────
// First execute() calls Timeline::addClip() and captures the assigned ID.
// Subsequent execute() calls (redo) use Timeline::restoreClip() to preserve it.

class AddClipCommand : public Command {
public:
    explicit AddClipCommand(Clip clip);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    Clip clip_;
    bool firstExecute_ = true;
};

// ─── RemoveClipCommand ────────────────────────────────────────────────────────
// Snapshots the clip at construction so undo() can restore the exact state.

class RemoveClipCommand : public Command {
public:
    RemoveClipCommand(int clipId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    Clip clip_;
};

// ─── MoveClipCommand ──────────────────────────────────────────────────────────
// Stores the old track and position so undo() can move back.

class MoveClipCommand : public Command {
public:
    MoveClipCommand(int clipId, TickTime newPosition, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    int      oldTrackId_;
    TickTime oldPosition_;
    TickTime newPosition_;
};

// ─── ResizeClipCommand ────────────────────────────────────────────────────────

class ResizeClipCommand : public Command {
public:
    ResizeClipCommand(int clipId, TickTime newDuration, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    TickTime oldDuration_;
    TickTime newDuration_;
};

// ─── ResizeClipLeftCommand ────────────────────────────────────────────────────
// Atomically updates position, duration, and regionOffset for left-edge resize.
// Clip ID is preserved. Single undo step.

class ResizeClipLeftCommand : public Command {
public:
    ResizeClipLeftCommand(int clipId, TickTime newPosition, TickTime newDuration,
                          TickTime newRegionOffset, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    TickTime oldPosition_;
    TickTime newPosition_;
    TickTime oldDuration_;
    TickTime newDuration_;
    TickTime oldRegionOffset_;
    TickTime newRegionOffset_;
};

// ─── SpliceClipsCommand ───────────────────────────────────────────────────────
// Atomically splits N clips at given tick positions in a single undo step.
// For each entry: removes the original clip, inserts left and right halves.
// Undo: removes both halves, restores original (with its original ID).
// Redo: removes original again (restored by undo), re-inserts both halves
//       using restoreClip so the same IDs are preserved.

class SpliceClipsCommand : public Command {
public:
    struct Entry {
        Clip original;  // full snapshot of clip being split
        Clip left;      // left half (id=0 before first execute; filled after)
        Clip right;     // right half (id=0 before first execute; filled after)
    };

    // outIds is filled synchronously during execute() with {leftId, rightId}
    // per entry. Caller may pass nullptr if IDs are not needed.
    SpliceClipsCommand(std::vector<Entry> entries,
                       std::vector<std::pair<int,int>>* outIds = nullptr);

    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

private:
    std::vector<Entry>              entries_;
    std::vector<std::pair<int,int>>* outIds_;
    bool                            firstExecute_ = true;
};

// ─── AutoTrimClipCommand ─────────────────────────────────────────────────────
// Shifts a clip's regionOffset forward by `addOffsetTicks` and shrinks its
// duration by `subtractDurationTicks`. The clip's timeline position is not
// touched, so audible content now begins at the clip's left edge.

class AutoTrimClipCommand : public Command {
public:
    AutoTrimClipCommand(int clipId, int64_t addOffsetTicks, int64_t subtractDurationTicks);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    int64_t  addOffsetTicks_;
    int64_t  subtractDurationTicks_;
    TickTime oldRegionOffset_{0};
    TickTime oldDuration_{0};
    bool     snapshotValid_ = false;
};

// ─── StretchClipCommand ───────────────────────────────────────────────────────
// Right-edge time-stretch: changes duration and recomputes stretchRatio so the
// source audio fills the new duration. Clip start and regionOffset are unchanged.
// newStretchRatio = clamp((newDur / oldDur) * oldStretchRatio, 0.1, 20.0)

class StretchClipCommand : public Command {
public:
    StretchClipCommand(int clipId, TickTime newDuration, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    TickTime oldDuration_;
    TickTime newDuration_;
    double   oldStretchRatio_;
    double   newStretchRatio_;
};

// ─── StretchClipLeftCommand ───────────────────────────────────────────────────
// Left-edge time-stretch: changes position + duration; recomputes stretchRatio.
// regionOffset is NOT changed (no audio content is trimmed).

class StretchClipLeftCommand : public Command {
public:
    StretchClipLeftCommand(int clipId, TickTime newPosition, TickTime newDuration,
                           const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    TickTime oldPosition_;
    TickTime newPosition_;
    TickTime oldDuration_;
    TickTime newDuration_;
    double   oldStretchRatio_;
    double   newStretchRatio_;
};

// ─── PitchShiftClipCommand ────────────────────────────────────────────────────
// Directly sets pitchOffset (semitones) and pitchOffsetCents on a clip.
// The bridge applies delta + carry logic before constructing the command.

class PitchShiftClipCommand : public Command {
public:
    PitchShiftClipCommand(int clipId, int newSemis, int newCents,
                          const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int clipId_;
    int oldSemis_, newSemis_;
    int oldCents_, newCents_;
};

// ─── ReverseClipCommand ───────────────────────────────────────────────────────
// Toggles the reversed flag on a clip. Bridge passes the desired new value.

class ReverseClipCommand : public Command {
public:
    ReverseClipCommand(int clipId, bool newReversed, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  clipId_;
    bool oldReversed_;
    bool newReversed_;
};

// ─── SetClipParamsCommand ─────────────────────────────────────────────────────
// Modifies pitch/stretch/reverse processing params on an existing clip.
// Snapshots old state at construction for single-step undo.

class SetClipParamsCommand : public Command {
public:
    struct Params {
        int           pitchOffsetSemis = 0;
        int           pitchOffsetCents = 0;
        bool          reversed         = false;
        double        stretchRatio     = 1.0;
        StretchMethod stretchMethod    = StretchMethod::Global;
        bool          formantPreserve  = false;
        float         velocity         = 1.0f;
        float         fadeInPercent    = 0.0f;
        float         fadeOutPercent   = 0.0f;
        float         fadeInX1         = 0.0f;
        float         fadeInY1         = 0.0f;
        float         fadeInX2         = 1.0f;
        float         fadeInY2         = 1.0f;
        float         fadeOutX1        = 0.0f;
        float         fadeOutY1        = 0.0f;
        float         fadeOutX2        = 1.0f;
        float         fadeOutY2        = 1.0f;
    };
    SetClipParamsCommand(int clipId, Params newParams, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int    clipId_;
    Params oldParams_;
    Params newParams_;
};

// ─── SetClipModulationCommand ─────────────────────────────────────────────────
// Replaces the per-clip ClipModulation descriptor (Vibrato + Scratch + linked
// video companion) atomically. Snapshots the previous descriptor at construction
// for single-step undo. Phase A: data-only — no DSP reads modulation yet.

class SetClipModulationCommand : public Command {
public:
    SetClipModulationCommand(int clipId, ClipModulation newMod,
                             const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int            clipId_;
    ClipModulation oldMod_;
    ClipModulation newMod_;
};

// ─── AddTrackCommand ──────────────────────────────────────────────────────────

class AddTrackCommand : public Command {
public:
    explicit AddTrackCommand(TrackInfo track);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    TrackInfo track_;
    bool firstExecute_ = true;
};

// ─── RemoveTrackCommand ───────────────────────────────────────────────────────
// Cascades: snapshots the track and ALL clips + pattern-blocks on it at
// construction. execute() removes blocks/clips then the track.
// undo() restores track then clips+blocks with their original IDs.

class RemoveTrackCommand : public Command {
public:
    RemoveTrackCommand(int trackId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    TrackInfo                 track_;
    std::vector<Clip>         clips_;         // all clips on the track
    std::vector<PatternBlock> patternBlocks_; // all pattern-blocks on the track
    // Grid cascade snapshots — restored in undo().
    bool              hadGridSlot_      = false;
    GridSlot          removedGridSlot_;
    // Every fullscreen layer that referenced the removed track, paired with
    // its index in the layer vector at construction time. Restored in original
    // order so undo() preserves the relative stacking.
    std::vector<std::pair<size_t, FullscreenLayer>> removedFullscreenLayers_;
};

// ─── AddRegionCommand ─────────────────────────────────────────────────────────

class AddRegionCommand : public Command {
public:
    explicit AddRegionCommand(SampleRegion region);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    SampleRegion region_;
    bool firstExecute_ = true;
};

// ─── ModifyRegionCommand ──────────────────────────────────────────────────────
// Snapshots old state at construction; execute() writes newState, undo() restores.

class ModifyRegionCommand : public Command {
public:
    ModifyRegionCommand(int regionId, SampleRegion newState,
                        const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    SampleRegion oldState_;
    SampleRegion newState_;
};

// ─── SetSyllablesCommand ──────────────────────────────────────────────────────
// Snapshots the region's existing syllables at construction; execute() writes
// newSyllables, undo() restores the old ones. Scoped to the syllables field so
// other concurrent region edits are not disturbed.

class SetSyllablesCommand : public Command {
public:
    SetSyllablesCommand(int regionId,
                        std::vector<SampleRegion::Syllable> newSyllables,
                        const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int                                 regionId_;
    std::vector<SampleRegion::Syllable> oldSyllables_;
    std::vector<SampleRegion::Syllable> newSyllables_;
};

// ─── RemoveRegionCommand ──────────────────────────────────────────────────────
// Snapshots the region at construction so undo() can restore the exact state.

class RemoveRegionCommand : public Command {
public:
    RemoveRegionCommand(int regionId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    SampleRegion region_;
};

// ─── SetBPMCommand ────────────────────────────────────────────────────────────

class SetBPMCommand : public Command {
public:
    SetBPMCommand(double newBpm, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    double oldBpm_;
    double newBpm_;
    // Saved stretchRatios for tempoLocked stretched clips so undo restores
    // exact values without floating-point drift from repeated BPM changes.
    std::unordered_map<int, double> savedStretchRatios_;
};

// ─── SetLoopRegionCommand ─────────────────────────────────────────────────────
// Replaces the single global LoopRegion atomically. Snapshots the previous
// region at construction for one-step undo. Covers ALL loop mutations —
// create / move / resize edges / arm-disarm toggle / inert-field settings —
// since every one routes through Timeline::setLoopRegion. minLengthTicks is the
// snap unit the UI computed (1 snap unit when snap is on, 1 tick when off) and
// is enforced in the mutation layer so zero/negative length is unreachable.

class SetLoopRegionCommand : public Command {
public:
    SetLoopRegionCommand(LoopRegion newRegion, int64_t minLengthTicks,
                         const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    LoopRegion oldRegion_;
    LoopRegion newRegion_;
    int64_t    minLengthTicks_;
};

// ─── SetTrackMutedCommand ─────────────────────────────────────────────────────

class SetTrackMutedCommand : public Command {
public:
    SetTrackMutedCommand(int trackId, bool newMuted, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  trackId_;
    bool oldMuted_;
    bool newMuted_;
};

// ─── SetTrackVisualOnlyCommand ────────────────────────────────────────────────

class SetTrackVisualOnlyCommand : public Command {
public:
    SetTrackVisualOnlyCommand(int trackId, bool newVisualOnly, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  trackId_;
    bool oldVisualOnly_;
    bool newVisualOnly_;
};

// ─── SetTrackSoloCommand ──────────────────────────────────────────────────────

class SetTrackSoloCommand : public Command {
public:
    SetTrackSoloCommand(int trackId, bool newSolo, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  trackId_;
    bool oldSolo_;
    bool newSolo_;
};

// ─── SetTrackNameCommand ──────────────────────────────────────────────────────

class SetTrackNameCommand : public Command {
public:
    SetTrackNameCommand(int trackId, std::string newName, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int         trackId_;
    std::string oldName_;
    std::string newName_;
};

// ─── SetPatternNameCommand ────────────────────────────────────────────────────

class SetPatternNameCommand : public Command {
public:
    SetPatternNameCommand(int patternId, std::string newName, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int         patternId_;
    std::string oldName_;
    std::string newName_;
};

// ─── SetPatternRegionCommand ─────────────────────────────────────────────────

class SetPatternRegionCommand : public Command {
public:
    SetPatternRegionCommand(int patternId, int newRegionId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int patternId_;
    int oldRegionId_;
    int newRegionId_;
};

// ─── SetGridLayoutCommand ─────────────────────────────────────────────────────
// Replaces the entire grid layout. Snapshots the previous layout for undo.

class SetGridLayoutCommand : public Command {
public:
    SetGridLayoutCommand(GridLayout newLayout, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    GridLayout oldLayout_;
    GridLayout newLayout_;
};

// ─── AssignTrackToGridCommand ─────────────────────────────────────────────────
// Assigns a track to a grid slot. If the track was previously assigned,
// snapshots the old slot so undo() can restore it (not just remove).

class AssignTrackToGridCommand : public Command {
public:
    AssignTrackToGridCommand(int trackId, int gridX, int gridY,
                             int spanX, int spanY, const Timeline& timeline);
    // Variant that stores an explicit zOrder on the new slot (instead of the
    // default 0). Single atomic command — used by drag-to-place so that
    // placement-on-top is one undo step.
    AssignTrackToGridCommand(int trackId, int gridX, int gridY,
                             int spanX, int spanY, int zOrder,
                             const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      trackId_, gridX_, gridY_, spanX_, spanY_;
    bool     hasZOrder_ = false;
    int      zOrder_ = 0;
    bool     hadPrevious_ = false;
    GridSlot prevSlot_;
};

// ─── RemoveTrackFromGridCommand ───────────────────────────────────────────────
// Removes a track's grid slot. Snapshots the slot for undo.

class RemoveTrackFromGridCommand : public Command {
public:
    RemoveTrackFromGridCommand(int trackId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      trackId_;
    bool     hadSlot_ = false;
    GridSlot removedSlot_;
};

// ─── SetFullscreenLayersCommand ───────────────────────────────────────────────
// Atomically replaces the entire fullscreenLayers vector. Snapshots the prior
// videoHoldLastFrame state of every track touched by a new BehindGrid layer so
// undo() can restore the flag for tracks the command auto-enabled.

class SetFullscreenLayersCommand : public Command {
public:
    SetFullscreenLayersCommand(std::vector<FullscreenLayer> newLayers,
                               const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    std::vector<FullscreenLayer>  oldLayers_;
    std::vector<FullscreenLayer>  newLayers_;
    std::unordered_map<int, bool> oldHoldByTrackId_;  // pre-execute videoHoldLastFrame, keyed by trackId
};

// ─── SetPreviewFpsCommand ─────────────────────────────────────────────────────

class SetPreviewFpsCommand : public Command {
public:
    SetPreviewFpsCommand(int fps, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int oldFps_;
    int newFps_;
};

// ─── SamplerSettings POD ──────────────────────────────────────────────────────
// Grouped sampler settings used by SetSamplerSettingsCommand.

struct SamplerSettings {
    int     rootNote         = 60;
    float   attackMs         = 0.0f;
    float   decayMs          = 0.0f;
    float   sustain          = 1.0f;
    float   releaseMs        = 50.0f;
    float   delayMs          = 0.0f;
    float   holdMs           = 0.0f;
    float   attackTension    = 0.0f;
    float   decayTension     = 0.0f;
    float   releaseTension   = 0.0f;
    bool    pitchEnvEnabled       = false;
    float   pitchEnvAmount        = 0.0f;
    float   pitchEnvDelayMs       = 0.0f;
    float   pitchEnvAttackMs      = 0.0f;
    float   pitchEnvHoldMs        = 0.0f;
    float   pitchEnvDecayMs       = 0.0f;
    float   pitchEnvSustain       = 0.0f;
    float   pitchEnvReleaseMs     = 0.0f;
    float   pitchEnvAttackTension = 0.0f;
    float   pitchEnvDecayTension  = 0.0f;
    float   pitchEnvReleaseTension = 0.0f;
    bool    loopEnabled      = false;
    int64_t loopStart        = 0;
    int64_t loopEnd          = 0;
    bool    crossfadeEnabled = false;
    int64_t smpStart         = 0;
    int64_t smpLength        = 0;
    float   declickMs        = 1.5f;
    float   fadeInMs         = 0.0f;
    float   fadeOutMs        = 0.0f;
    int64_t crossfadeSamples = 0;
    bool    dcOffsetRemoved  = false;
    bool    normalized       = false;
    bool    polarityReversed = false;
    bool    reversed         = false;
    bool    monoEnabled       = false;
    bool    portamentoEnabled = false;
    float   portamentoTimeMs  = 100.0f;
    bool    arpEnabled        = false;
    bool    arpTempoSync      = true;
    int     arpDivision       = 8;
    float   arpFreeTimeMs     = 125.0f;
    float   arpGate           = 0.8f;
    int     arpRange          = 1;
    int     arpDirection      = 0;
    // LFO — Volume
    bool  lfoVolEnabled       = false;
    float lfoVolAmount        = 0.0f;
    float lfoVolSpeedHz       = 1.0f;
    bool  lfoVolTempoSync     = false;
    int   lfoVolTempoDivision = 4;
    float lfoVolAttackMs      = 0.0f;
    float lfoVolDelayMs       = 0.0f;
    std::vector<SampleRegion::LfoBreakpoint> lfoVolWaveform;
    // LFO — Panning
    bool  lfoPanEnabled       = false;
    float lfoPanAmount        = 0.0f;
    float lfoPanSpeedHz       = 1.0f;
    bool  lfoPanTempoSync     = false;
    int   lfoPanTempoDivision = 4;
    float lfoPanAttackMs      = 0.0f;
    float lfoPanDelayMs       = 0.0f;
    std::vector<SampleRegion::LfoBreakpoint> lfoPanWaveform;
    // LFO — Pitch
    bool  lfoPitchEnabled       = false;
    float lfoPitchAmount        = 0.0f;
    float lfoPitchSpeedHz       = 1.0f;
    bool  lfoPitchTempoSync     = false;
    int   lfoPitchTempoDivision = 4;
    float lfoPitchAttackMs      = 0.0f;
    float lfoPitchDelayMs       = 0.0f;
    std::vector<SampleRegion::LfoBreakpoint> lfoPitchWaveform;
};

// ─── AddPatternCommand ────────────────────────────────────────────────────────

class AddPatternCommand : public Command {
public:
    explicit AddPatternCommand(Pattern pattern);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    Pattern pattern_;
    bool    firstExecute_ = true;
};

// ─── RemovePatternCommand ─────────────────────────────────────────────────────
// Cascades: snapshots the pattern + all blocks referencing it. execute()
// removes all, undo() restores all with original IDs.

class RemovePatternCommand : public Command {
public:
    RemovePatternCommand(int patternId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    Pattern                   pattern_;
    std::vector<PatternBlock> blocks_;
};

// ─── SetSamplerSettingsCommand ────────────────────────────────────────────────

class SetSamplerSettingsCommand : public Command {
public:
    SetSamplerSettingsCommand(int regionId, SamplerSettings newSettings,
                              const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int             regionId_;
    SamplerSettings oldSettings_;
    SamplerSettings newSettings_;
};

// ─── AddPatternBlockCommand ───────────────────────────────────────────────────

class AddPatternBlockCommand : public Command {
public:
    explicit AddPatternBlockCommand(PatternBlock block);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    PatternBlock block_;
    bool         firstExecute_ = true;
};

// ─── RemovePatternBlockCommand ────────────────────────────────────────────────

class RemovePatternBlockCommand : public Command {
public:
    RemovePatternBlockCommand(int blockId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    PatternBlock block_;
};

// ─── MovePatternBlockCommand ──────────────────────────────────────────────────

class MovePatternBlockCommand : public Command {
public:
    MovePatternBlockCommand(int blockId, int newTrackId, TickTime newPosition,
                            const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      blockId_;
    int      oldTrackId_;
    int      newTrackId_;
    TickTime oldPosition_;
    TickTime newPosition_;
};

// ─── ResizePatternBlockCommand ────────────────────────────────────────────────

class ResizePatternBlockCommand : public Command {
public:
    ResizePatternBlockCommand(int blockId, TickTime newDuration,
                              const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      blockId_;
    TickTime oldDuration_;
    TickTime newDuration_;
};

// ─── ResizePatternBlockLeftCommand ───────────────────────────────────────────

class ResizePatternBlockLeftCommand : public Command {
public:
    ResizePatternBlockLeftCommand(int blockId, TickTime newPosition, TickTime newDuration,
                                  TickTime newOffset, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      blockId_;
    TickTime oldPosition_;
    TickTime oldDuration_;
    TickTime oldOffset_;
    TickTime newPosition_;
    TickTime newDuration_;
    TickTime newOffset_;
};

// ─── SetPatternBlockLoopCommand ───────────────────────────────────────────────

class SetPatternBlockLoopCommand : public Command {
public:
    SetPatternBlockLoopCommand(int blockId, bool newLoopEnabled,
                               const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  blockId_;
    bool oldLoopEnabled_;
    bool newLoopEnabled_;
};

// ─── AddNoteCommand ───────────────────────────────────────────────────────────

class AddNoteCommand : public Command {
public:
    AddNoteCommand(int patternId, PatternNote note);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int         patternId_;
    PatternNote note_;
    bool        firstExecute_ = true;
};

// ─── RemoveNoteCommand ────────────────────────────────────────────────────────

class RemoveNoteCommand : public Command {
public:
    RemoveNoteCommand(int patternId, int noteId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int         patternId_;
    PatternNote note_;
};

// ─── MoveNoteCommand ──────────────────────────────────────────────────────────

class MoveNoteCommand : public Command {
public:
    MoveNoteCommand(int patternId, int noteId, TickTime newPosition, int newPitch,
                    const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      patternId_;
    int      noteId_;
    TickTime oldPosition_;
    TickTime newPosition_;
    int      oldPitch_;
    int      newPitch_;
};

// ─── MoveNotesBatchCommand ────────────────────────────────────────────────────
// Moves N notes in one atomic operation. Snapshots each note's old position
// and pitch at construction so undo() reverses all moves together.

class MoveNotesBatchCommand : public Command {
public:
    struct Move {
        int      noteId;
        TickTime newPosition;
        int      newPitch;
    };
    MoveNotesBatchCommand(int patternId, std::vector<Move> moves,
                          const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    struct Snapshot {
        int      noteId;
        TickTime oldPosition;
        TickTime newPosition;
        int      oldPitch;
        int      newPitch;
    };
    int                   patternId_;
    std::vector<Snapshot> snapshots_;
};

// ─── ResizeNotesBatchCommand ──────────────────────────────────────────────────
// Resizes N notes in one atomic operation (same-delta semantics).
// Each note's duration changes by the same tick delta as the anchor.

class ResizeNotesBatchCommand : public Command {
public:
    struct Resize {
        int      noteId;
        TickTime newDuration;
    };
    ResizeNotesBatchCommand(int patternId, std::vector<Resize> resizes,
                            const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    struct Snapshot {
        int      noteId;
        TickTime oldDuration;
        TickTime newDuration;
    };
    int                   patternId_;
    std::vector<Snapshot> snapshots_;
};

// ─── ResizeNoteCommand ────────────────────────────────────────────────────────

class ResizeNoteCommand : public Command {
public:
    ResizeNoteCommand(int patternId, int noteId, TickTime newDuration,
                      const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      patternId_;
    int      noteId_;
    TickTime oldDuration_;
    TickTime newDuration_;
};

// ─── SetNoteVelocityCommand ───────────────────────────────────────────────────

class SetNoteVelocityCommand : public Command {
public:
    SetNoteVelocityCommand(int patternId, int noteId, float newVelocity,
                           const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int   patternId_;
    int   noteId_;
    float oldVelocity_;
    float newVelocity_;
};

// ─── ConvertTrackTypeCommand ──────────────────────────────────────────────────
// Converts a track between Clip and Pattern types. When converting to Clip,
// cascade-deletes any pattern-blocks on the track (snapshotted for undo).

class ConvertTrackTypeCommand : public Command {
public:
    ConvertTrackTypeCommand(int trackId, TrackInfo::Type newType,
                            const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int                       trackId_;
    // Old state (full snapshot of the type-related fields).
    TrackInfo::Type           oldType_;
    VideoFlipConfig           oldVideoFlipConfig_;
    // New state.
    TrackInfo::Type           newType_;
    // Cascade snapshot (only blocks — only populated when converting Pattern→Clip).
    std::vector<PatternBlock> cascadedBlocks_;
};

// ─── SetVideoFlipConfigCommand ────────────────────────────────────────────────
// Persists a new VideoFlipConfig on a track with full undo/redo support.

class SetVideoFlipConfigCommand : public Command {
public:
    SetVideoFlipConfigCommand(int trackId, VideoFlipConfig newConfig,
                              const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int             trackId_;
    VideoFlipConfig oldConfig_;
    VideoFlipConfig newConfig_;
};

// ─── SetTrackVideoHoldLastFrameCommand ────────────────────────────────────────

class SetTrackVideoHoldLastFrameCommand : public Command {
public:
    SetTrackVideoHoldLastFrameCommand(int trackId, bool newHold, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  trackId_;
    bool oldHold_;
    bool newHold_;
};

// ─── SetTrackCornerRadiusCommand ──────────────────────────────────────────────

class SetTrackCornerRadiusCommand : public Command {
public:
    SetTrackCornerRadiusCommand(int trackId, float newRadius, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int   trackId_;
    float oldRadius_;
    float newRadius_;
};

// ─── SetTrackGapScaleOverrideCommand ─────────────────────────────────────────

class SetTrackGapScaleOverrideCommand : public Command {
public:
    SetTrackGapScaleOverrideCommand(int trackId, float newGapScale, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int   trackId_;
    float oldGapScale_;
    float newGapScale_;
};

// ─── SetTrackSubdivisionFactorCommand ────────────────────────────────────────
// Sets the per-track subdivisionFactor (1, 2, 4, or 8). Existing GridSlots are
// untouched — only future placements use the new factor. Snapshots the prior
// value so undo restores it.

class SetTrackSubdivisionFactorCommand : public Command {
public:
    SetTrackSubdivisionFactorCommand(int trackId, int newFactor, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int trackId_;
    int oldFactor_;
    int newFactor_;
};

// ─── SetTrackColorCommand (Pass 6D + 6F) ─────────────────────────────────────
// Assigns track color metadata. Snapshots the prior mode/slot/custom so undo
// restores the exact previous state. Invalid mode/slot/custom combos are
// normalized by Timeline::setTrackColor before storage.

class SetTrackColorCommand : public Command {
public:
    SetTrackColorCommand(int trackId,
                         TrackColorMode newMode,
                         int newSlot,
                         std::string newCustomColor,
                         const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int            trackId_;
    TrackColorMode oldMode_;
    int            oldSlot_;
    std::string    oldCustom_;
    TrackColorMode newMode_;
    int            newSlot_;
    std::string    newCustom_;
};

// ─── SetTrackBounceSettingsCommand ───────────────────────────────────────────

class SetTrackBounceSettingsCommand : public Command {
public:
    SetTrackBounceSettingsCommand(int trackId, const BounceSettings& newSettings, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int            trackId_;
    BounceSettings oldSettings_;
    BounceSettings newSettings_;
};

// ─── SetTrackZoomPanRotSettingsCommand ────────────────────────────────────────

class SetTrackZoomPanRotSettingsCommand : public Command {
public:
    SetTrackZoomPanRotSettingsCommand(int trackId, const ZoomPanRotSettings& newSettings,
                                      const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int                trackId_;
    ZoomPanRotSettings oldSettings_;
    ZoomPanRotSettings newSettings_;
};

// ─── SetTrackPingPongSettingsCommand ─────────────────────────────────────────

class SetTrackPingPongSettingsCommand : public Command {
public:
    SetTrackPingPongSettingsCommand(int trackId, const PingPongSettings& newSettings,
                                    const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int              trackId_;
    PingPongSettings oldSettings_;
    PingPongSettings newSettings_;
};

// ─── SetTrackSlideNoteEffectCommand ──────────────────────────────────────────

class SetTrackSlideNoteEffectCommand : public Command {
public:
    SetTrackSlideNoteEffectCommand(int trackId, const SlideNoteEffectSettings& newSettings,
                                   const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int                     trackId_;
    SlideNoteEffectSettings oldSettings_;
    SlideNoteEffectSettings newSettings_;
};

// ─── SetNoteSlideCommand ─────────────────────────────────────────────────────

class SetNoteSlideCommand : public Command {
public:
    SetNoteSlideCommand(int patternId, int noteId, bool isSlide,
                        float curveCx, float curveCy, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int   patternId_;
    int   noteId_;
    bool  newIsSlide_;
    float newCx_;
    float newCy_;
    bool  oldIsSlide_  = false;
    float oldCx_       = 0.5f;
    float oldCy_       = 0.5f;
};

// ─── AddVisualEffectCommand ───────────────────────────────────────────────────

class AddVisualEffectCommand : public Command {
public:
    AddVisualEffectCommand(int trackId, VisualEffect::Type type);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    int getAddedIndex() const { return addedIndex_; }  // valid after execute()
private:
    int                trackId_;
    VisualEffect::Type type_;
    int                addedIndex_ = -1;
};

// ─── RemoveVisualEffectCommand ────────────────────────────────────────────────

class RemoveVisualEffectCommand : public Command {
public:
    RemoveVisualEffectCommand(int trackId, int effectIndex, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int          trackId_;
    int          effectIndex_;
    VisualEffect savedEffect_;  // snapshot for undo re-insert
};

// ─── ReorderVisualEffectCommand ───────────────────────────────────────────────

class ReorderVisualEffectCommand : public Command {
public:
    ReorderVisualEffectCommand(int trackId, int fromIndex, int toIndex);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int trackId_;
    int fromIndex_;
    int toIndex_;
};

// ─── SetTrackVfxChainOrderCommand ─────────────────────────────────────────────

class SetTrackVfxChainOrderCommand : public Command {
public:
    SetTrackVfxChainOrderCommand(int trackId, const std::vector<int>& newOrder, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int trackId_;
    std::vector<int> newOrder_;
};

// ─── SetVisualEffectParamCommand ──────────────────────────────────────────────

class SetVisualEffectParamCommand : public Command {
public:
    SetVisualEffectParamCommand(int trackId, int effectIndex, int paramIndex,
                                float newValue, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int   trackId_;
    int   effectIndex_;
    int   paramIndex_;
    float oldValue_;
    float newValue_;
};

// ─── SetVisualEffectBypassedCommand ──────────────────────────────────────────

class SetVisualEffectBypassedCommand : public Command {
public:
    SetVisualEffectBypassedCommand(int trackId, int effectIndex,
                                   bool newBypassed, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  trackId_;
    int  effectIndex_;
    bool oldBypassed_;
    bool newBypassed_;
};

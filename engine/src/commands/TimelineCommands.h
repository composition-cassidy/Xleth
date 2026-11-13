#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include "audio/TrackRouting.h"
#include <memory>
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
// Stores the old track and position so undo() can move back. Supports
// cross-track moves (clip → another Clip track) as well as pure repositioning.

class MoveClipCommand : public Command {
public:
    MoveClipCommand(int clipId, int newTrackId, TickTime newPosition, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int      clipId_;
    int      newTrackId_;
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
    TrackLayout               oldTrackLayout_;
    std::vector<Clip>         clips_;         // all clips on the track
    std::vector<PatternBlock> patternBlocks_; // all pattern-blocks on the track
    // Grid cascade snapshots — restored in undo().
    bool              hadGridSlot_      = false;
    GridSlot          removedGridSlot_;
    // Every fullscreen layer that referenced the removed track, paired with
    // its index in the layer vector at construction time. Restored in original
    // order so undo() preserves the relative stacking.
    std::vector<std::pair<size_t, FullscreenLayer>> removedFullscreenLayers_;
    // Automation cascade — lanes owned by the track plus every clip on them.
    // Restored lanes-first in undo(), since a clip needs its lane to exist.
    std::vector<AutomationLane> automationLanes_;
    std::vector<AutomationClip> automationClips_;
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

// ─── SetTrackGraphStateCommand ────────────────────────────────────────────────
// The FX Graph workspace persists every structural edit (node add/remove, cable
// connect/disconnect, node move, macro/envelope edits) by writing the whole
// graphState blob for a track. That is a timeline mutation like any other and
// belongs on the undo stack: while it was untracked, the top of the global stack
// stayed stale after a graph edit, so a global Ctrl+Z silently reverted whatever
// unrelated edit came before it.
//
// The engine still treats graphState as opaque — this command only swaps blobs.
// Camera-only writes (viewport pan/zoom) pass undoable=false at the RPC boundary
// and never reach this command; they must not become undo steps.

class SetTrackGraphStateCommand : public Command {
public:
    SetTrackGraphStateCommand(int trackId, nlohmann::json newGraphState, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return record_; }
private:
    int            trackId_;
    bool           oldHasGraphState_ = false;
    nlohmann::json oldGraphState_;
    bool           newHasGraphState_ = false;
    nlohmann::json newGraphState_;
    // False for an unknown track or a write that changes nothing — the mutation
    // still runs, it just does not earn an undo step.
    bool           record_ = true;
};

// ─── SetTrackFxModeCommand ────────────────────────────────────────────────────
// FX ownership transfer (Mixer Chain <-> FX Graph). Undoable for the same reason
// as SetTrackGraphStateCommand.

class SetTrackFxModeCommand : public Command {
public:
    SetTrackFxModeCommand(int trackId, TrackFxMode newMode, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return record_; }
private:
    int         trackId_;
    TrackFxMode oldMode_ = TrackFxMode::Chain;
    TrackFxMode newMode_ = TrackFxMode::Chain;
    bool        record_  = true;
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

// ─── SetTrackOrderCommand ─────────────────────────────────────────────────────

class SetTrackOrderCommand : public Command {
public:
    SetTrackOrderCommand(std::vector<int> trackIdsInOrder, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    std::vector<int>             trackIdsInOrder_;
    TrackLayout                  oldTrackLayout_;
};

// One undo step for any atomic root-order/folder-membership drag operation.
class SetTrackLayoutCommand : public Command {
public:
    SetTrackLayoutCommand(TrackLayout newLayout, const Timeline& timeline,
                          std::string description = "Rearrange Track Folders");
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    TrackLayout oldLayout_;
    TrackLayout newLayout_;
    std::string description_;
};

class CreateTrackFolderCommand : public Command {
public:
    CreateTrackFolderCommand(std::string name, std::vector<int> trackIds,
                             int rootIndex, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    int folderId() const { return folderId_; }
private:
    std::string name_;
    std::vector<int> trackIds_;
    int rootIndex_ = 0;
    int folderId_ = -1;
    bool firstExecute_ = true;
    TrackLayout oldLayout_;
    TrackLayout createdLayout_;
};

class RenameTrackFolderCommand : public Command {
public:
    RenameTrackFolderCommand(int folderId, std::string name, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int folderId_;
    std::string oldName_;
    std::string newName_;
};

class SetTrackFolderCollapsedCommand : public Command {
public:
    SetTrackFolderCollapsedCommand(int folderId, bool collapsed, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int folderId_;
    bool oldCollapsed_;
    bool newCollapsed_;
};

class RemoveTrackFolderCommand : public Command {
public:
    RemoveTrackFolderCommand(int folderId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int folderId_;
    std::string folderName_;
    TrackLayout oldLayout_;
    TrackLayout ungroupedLayout_;
    bool firstExecute_ = true;
};

// ─── SetTrackOutputRouteCommand ───────────────────────────────────────────────
// Only created when the route is already validated (bridge validates first).
// execute/undo directly set outputRoute.targetTrackId on the mutable track.

class SetTrackOutputRouteCommand : public Command {
public:
    SetTrackOutputRouteCommand(int sourceTrackId, int newTargetTrackId,
                               const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int sourceTrackId_;
    int oldTargetTrackId_;
    int newTargetTrackId_;
};

// ─── Sidechain route commands (Prompt 4B) ─────────────────────────────────────
// All three are created only after validation succeeds (the bridge validates
// first), so they never produce a no-op undo entry. The route's stable routeId
// is captured at construction and preserved across redo.

class AddSidechainRouteCommand : public Command {
public:
    AddSidechainRouteCommand(int sourceTrackId, SidechainRoute route);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int            sourceTrackId_;
    SidechainRoute route_;   // includes routeId — identical on every redo
};

class RemoveSidechainRouteCommand : public Command {
public:
    RemoveSidechainRouteCommand(int sourceTrackId, const std::string& routeId,
                                const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int            sourceTrackId_;
    std::string    routeId_;
    SidechainRoute removedRoute_;   // captured for undo restore
    size_t         index_ = 0;      // original position, restored on undo
    bool           had_   = false;
};

class SetSidechainRouteParamsCommand : public Command {
public:
    SetSidechainRouteParamsCommand(int sourceTrackId, const std::string& routeId,
                                   const xleth::SidechainRouteParams& newParams,
                                   const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int                         sourceTrackId_;
    std::string                 routeId_;
    xleth::SidechainRouteParams oldParams_;
    xleth::SidechainRouteParams newParams_;
    bool                        had_ = false;
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

// ─── SetPlacementZOrderCommand ────────────────────────────────────────────────
// Sets the single, globally-comparable compositing zOrder for a track's video
// placement — grid slot OR fullscreen layer — through one undo-tracked command.
// This is the entry point a future Video-tab reorder UI calls to slide a
// fullscreen layer between two grid cells (or vice versa). Follows the
// AssignTrackToGridCommand pattern: the constructor snapshots the current
// placement kind + zOrder so undo() restores it exactly. NOTE: this is compositing
// order only — it is completely independent of SetTrackOrderCommand /
// TrackInfo::order, which is the audio/mixer arrangement order.

class SetPlacementZOrderCommand : public Command {
public:
    SetPlacementZOrderCommand(int trackId, int newZOrder, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int  trackId_;
    int  newZOrder_;
    bool hadPlacement_ = false;  // false → track had no video placement; execute/undo no-op
    int  oldZOrder_    = 0;
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
    // Full slot list. Carried wholesale so ONE command covers every slot
    // mutation — per-slot parameter edits, adding a layer, removing a layer —
    // and undo is a straight restore of the previous vector. Always at least
    // one entry (slot 0).
    std::vector<SampleSlot> slots { SampleSlot{} };

    // The amp/pitch envelopes and three drawable LFOs are gone — they live in
    // `modulation` below now (ENV 1 is the amp VCA; pitch env + LFOs are routes).
    bool    crossfadeEnabled = false;
    bool    monoEnabled       = false;
    bool    portamentoEnabled = false;
    float   portamentoTimeMs  = 100.0f;
    int     portamentoMode    = 0;       // 0 = Always, 1 = Scaled
    float   portamentoCurve   = 0.0f;    // -1..+1, 0 = linear
    bool    legatoEnabled     = false;
    int     voiceCount        = 32;      // simultaneous NOTES, 1..32
    bool    arpEnabled        = false;
    bool    arpTempoSync      = true;
    int     arpDivision       = 8;
    float   arpFreeTimeMs     = 125.0f;
    float   arpGate           = 0.8f;
    int     arpRange          = 1;
    int     arpDirection      = 0;

    // Modulation system. Carried wholesale like `slots` above, so ONE command
    // covers a route add, a route removal and an envelope edit alike, and undo
    // is a straight restore of the previous config. Fixed-size arrays, so the
    // copy is a memcpy with no allocation.
    xleth::sampmod::ModConfig modulation;
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

// ─── EditPatternNotesCommand ──────────────────────────────────────────────────
// Replaces a pattern's whole note list in ONE undo entry. The piano roll builds
// compound edits (cut, delete/insert space, slice, legato resize, paint, bulk
// velocity) as "the list after", so every such gesture undoes in one step.
// Ids are kept for notes that carry one; new notes (id <= 0) get fresh ids on
// the first execute, which redo then reuses.

class EditPatternNotesCommand : public Command {
public:
    EditPatternNotesCommand(int patternId, std::vector<PatternNote> after,
                            const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    const std::vector<PatternNote>& getAfter() const { return after_; }
private:
    int                      patternId_;
    std::vector<PatternNote> before_;
    std::vector<PatternNote> after_;
    bool                     valid_ = false;
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

// ─── SetTrackVideoHoldLastFrameThresholdCommand ───────────────────────────────
// Per-track cap (in beats) on how long Hold Last Frame may re-serve a held
// frame. Negative = unlimited (the legacy behavior). Undo restores the exact
// prior value, including the unlimited sentinel.

class SetTrackVideoHoldLastFrameThresholdCommand : public Command {
public:
    SetTrackVideoHoldLastFrameThresholdCommand(int trackId, double newThresholdBeats,
                                               const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int    trackId_;
    double oldThresholdBeats_;
    double newThresholdBeats_;
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

// ─── SetTrackZprTracksCommand ─────────────────────────────────────────────────
// Keyframe-authoring commit: one undo step per drag/add/delete/curve-edit
// gesture (never per pointermove — the UI previews locally and commits once).

class SetTrackZprTracksCommand : public Command {
public:
    SetTrackZprTracksCommand(int trackId, const ZprTracks& newTracks, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int       trackId_;
    ZprTracks oldTracks_;
    ZprTracks newTracks_;
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

// ─── SetTrackNoteFadeCommand ──────────────────────────────────────────────────────────────────────

class SetTrackNoteFadeCommand : public Command {
public:
    SetTrackNoteFadeCommand(int trackId, const NoteFadeSettings& newSettings,
                            const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int              trackId_;
    NoteFadeSettings oldSettings_;
    NoteFadeSettings newSettings_;
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
    bool shouldRecordInUndoHistory() const override;
private:
    int   trackId_;
    int   effectIndex_;
    int   paramIndex_;
    float oldValue_;
    float newValue_;
    bool  applied_ = true;
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

// ─── Automation clip commands (Phase A) ───────────────────────────────────────
//
// Every automation mutation the UI can perform, as an undoable Command. They
// follow the same shape as the PatternBlock family directly above:
//   • Add*  : first execute() calls the id-assigning Timeline::add*, later
//             execute()s (redo) call restore* so the id never drifts;
//   • Remove*: snapshots at construction so undo() restores the exact state;
//   • Move/Resize: snapshots the old placement, undo() writes it back.
//
// The same-lane overlap rule is NOT re-implemented here. Timeline's mutators
// reject an overlapping placement and return false; these commands observe that
// and report shouldRecordInUndoHistory() == false, so a rejected drag leaves the
// undo stack completely untouched instead of recording a no-op step.

// Adds a clip. `clip.id` is ignored on first execute and assigned by Timeline.
class AddAutomationClipCommand : public Command {
public:
    explicit AddAutomationClipCommand(AutomationClip clip);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
    // Id assigned by the first execute(), or -1 if the placement was rejected.
    int clipId() const { return clip_.id; }
private:
    AutomationClip clip_;
    bool firstExecute_ = true;
    bool accepted_     = false;
};

// Removes a clip. The envelope is deliberately left in place: a sibling copy may
// still reference it, and undo has to be able to put the clip back on the exact
// same data. Orphaned envelopes are harmless and cheap.
class RemoveAutomationClipCommand : public Command {
public:
    RemoveAutomationClipCommand(int clipId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return found_; }
private:
    AutomationClip clip_;
    bool found_ = false;
};

// Moves a clip within its lane or onto another lane. Rejected (and not
// recorded) when the destination overlaps another clip on the target lane.
class MoveAutomationClipCommand : public Command {
public:
    MoveAutomationClipCommand(int clipId, int newLaneId, TickTime newPosition,
                              const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
private:
    int      clipId_;
    int      oldLaneId_ = -1;
    int      newLaneId_;
    TickTime oldPosition_;
    TickTime newPosition_;
    bool     accepted_ = false;
};

// Right-edge trim.
class ResizeAutomationClipCommand : public Command {
public:
    ResizeAutomationClipCommand(int clipId, TickTime newDuration, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
private:
    int      clipId_;
    TickTime oldDuration_;
    TickTime newDuration_;
    bool     accepted_ = false;
};

// Left-edge trim: position, duration and offset move together so the envelope
// stays anchored to the same timeline ticks. One undo step.
class ResizeAutomationClipLeftCommand : public Command {
public:
    ResizeAutomationClipLeftCommand(int clipId, TickTime newPosition, TickTime newDuration,
                                    TickTime newOffset, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
private:
    int      clipId_;
    TickTime oldPosition_, oldDuration_, oldOffset_;
    TickTime newPosition_, newDuration_, newOffset_;
    bool     accepted_ = false;
};

// Make-unique: duplicates the clip's envelope so later point edits stop
// propagating to its siblings. ONE engine command — deliberately not the
// UI-composed RPC chain pattern make-unique uses, so undo is a single step.
class MakeAutomationClipUniqueCommand : public Command {
public:
    MakeAutomationClipUniqueCommand(int clipId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
    // Envelope id created by the first execute(), or -1.
    int newEnvelopeId() const { return newEnvelopeId_; }
private:
    int  clipId_;
    int  oldEnvelopeId_ = -1;
    int  newEnvelopeId_ = -1;
    // Snapshot of the duplicate, so redo restores the SAME envelope id rather
    // than minting a second one (which would leak an envelope per redo).
    AutomationEnvelope duplicate_;
    bool firstExecute_ = true;
    bool accepted_     = false;
};

// Creates a lane and, in the same step, the envelope its first clip will use.
// Phase C's "right-click knob -> Create automation clip" is this command
// followed by AddAutomationClipCommand.
class AddAutomationLaneCommand : public Command {
public:
    // `index` < 0 appends after the owner's current last lane.
    AddAutomationLaneCommand(int ownerTrackId, int index);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
    int laneId() const { return lane_.id; }
private:
    AutomationLane lane_;
    bool firstExecute_ = true;
    bool accepted_     = false;
};

// Removes a lane and cascades to its clips, all in one undo step.
class RemoveAutomationLaneCommand : public Command {
public:
    RemoveAutomationLaneCommand(int laneId, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return found_; }
private:
    AutomationLane              lane_;
    std::vector<AutomationClip> clips_;   // every clip that was on the lane
    bool found_ = false;
};

// Creates a standalone envelope (a binding plus an initial point list). Used to
// mint the data a first clip will play; separate from AddAutomationClipCommand
// so a copy-paste of an existing clip can reuse an envelope without creating one.
class AddAutomationEnvelopeCommand : public Command {
public:
    AddAutomationEnvelopeCommand(AutomationBinding binding, std::vector<AutomationPoint> points);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
    int envelopeId() const { return envelope_.id; }
private:
    AutomationEnvelope envelope_;
    bool firstExecute_ = true;
    bool accepted_     = false;
};

// ─── Point edits ──────────────────────────────────────────────────────────────
//
// All four snapshot the WHOLE point list rather than the single point they touch.
// A point list is a few dozen entries at most, and a whole-list snapshot makes
// undo exact regardless of how insertion re-sorted, merged a duplicate tick, or
// shifted every index after the edit — the failure mode an index-based undo has.
// This is also the seam Phase C's drag needs: local preview during the drag,
// then ONE command committed on mouseup carrying the final list.

class AutomationPointEditCommand : public Command {
public:
    enum class Kind { Add, Remove, Move, SetCurve, ReplaceAll };

    // Add a point (replacing any point already at that tick).
    static std::unique_ptr<AutomationPointEditCommand> add(
        int envelopeId, AutomationPoint point, const Timeline& timeline);
    // Remove the point at `pointIndex`.
    static std::unique_ptr<AutomationPointEditCommand> remove(
        int envelopeId, int pointIndex, const Timeline& timeline);
    // Move the point at `pointIndex` to (newTick, newValue).
    static std::unique_ptr<AutomationPointEditCommand> move(
        int envelopeId, int pointIndex, TickTime newTick, double newValue,
        const Timeline& timeline);
    // Set the curve of the segment starting at `pointIndex`.
    static std::unique_ptr<AutomationPointEditCommand> setCurve(
        int envelopeId, int pointIndex, AutomationCurveType curveType, double tension,
        const Timeline& timeline);
    // Commit a whole edited list in one step (the drag-then-mouseup path).
    static std::unique_ptr<AutomationPointEditCommand> replaceAll(
        int envelopeId, std::vector<AutomationPoint> points, const Timeline& timeline);

    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }

private:
    AutomationPointEditCommand(Kind kind, int envelopeId, const Timeline& timeline);

    Kind kind_;
    int  envelopeId_;
    bool accepted_ = false;

    std::vector<AutomationPoint> before_;   // snapshot taken at construction
    std::vector<AutomationPoint> after_;    // computed by the first execute()
    bool haveAfter_ = false;

    // Per-kind payload.
    AutomationPoint     point_;
    int                 pointIndex_ = -1;
    TickTime            newTick_;
    double              newValue_ = 0.0;
    AutomationCurveType curveType_ = AutomationCurveType::Linear;
    double              tension_   = 0.0;
    std::vector<AutomationPoint> replacement_;
};

// ─── Deletion contract ────────────────────────────────────────────────────────
//
// Removing an effect instance must take its bound automation clips with it, in
// ONE undo step, after the UI has listed them in a confirmation dialog (the list
// comes from Timeline::getAutomationClipsForEffectInstance).
//
// This command owns the AUTOMATION half of that contract: it removes every clip
// bound to the instance, plus any lane it leaves completely empty. The effect
// removal itself is a MixEngine call that is not part of the undo system today
// (audio_removeEffect), so Phase C runs this command immediately before it and
// undo restores the clips when the effect comes back.
class RemoveAutomationForEffectInstanceCommand : public Command {
public:
    RemoveAutomationForEffectInstanceCommand(int ownerTrackId,
                                             const std::string& effectInstanceId,
                                             const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return !clips_.empty(); }
    int removedClipCount() const { return static_cast<int>(clips_.size()); }
private:
    int         ownerTrackId_;
    std::string effectInstanceId_;
    std::vector<AutomationClip> clips_;
    // Lanes that only existed to hold those clips; removed with them and
    // restored by undo BEFORE the clips (a clip needs its lane to exist).
    std::vector<AutomationLane> emptiedLanes_;
};

// Sets the manual (base) value of a bound parameter — the value it reads before
// any clip has played and after a manual edit outside every clip.
class SetAutomationBaseValueCommand : public Command {
public:
    SetAutomationBaseValueCommand(AutomationBinding binding, double value,
                                  const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return accepted_; }
private:
    AutomationBinding binding_;
    double newValue_;
    double oldValue_ = 0.0;
    bool   hadOld_   = false;
    bool   accepted_ = false;
};


// ─── Lens + Roam (docs/XLETH_LENS_ROAM_SPEC.md, phase P3) ─────────────────────
// Whole-value before/after swaps of the static `base`, the SetTrackNoteFade
// shape. Keys are not touched (they are not edited before P7). The bridge
// builds these only for a real change, so a drag that ends where it started
// leaves no undo entry. Reset is the same command with a computed value.

// Clip Track event Lens: Clip::lens.base.
class SetClipLensCommand : public Command {
public:
    SetClipLensCommand(int clipId, const LensParams& newLens, const Timeline& timeline,
                       bool isReset = false);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int        clipId_;
    LensParams oldLens_;
    LensParams newLens_;
    bool       isReset_;
};

// Pattern Track source Lens: TrackInfo::trackLens[regionId].base. A source
// with no entry resolves to LensParams::newContentDefault(); undo restores
// that ABSENCE (erases the entry) rather than materialising one.
class SetTrackLensCommand : public Command {
public:
    SetTrackLensCommand(int trackId, int regionId, const LensParams& newLens,
                        const Timeline& timeline, bool isReset = false);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int        trackId_;
    int        regionId_;
    bool       hadEntry_ = false;
    LensTrack  oldEntry_;
    LensParams newLens_;
    bool       isReset_;
};

// Track Roam: TrackInfo::roam.base.
class SetTrackRoamCommand : public Command {
public:
    SetTrackRoamCommand(int trackId, const RoamParams& newRoam, const Timeline& timeline,
                        bool isReset = false);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
private:
    int        trackId_;
    RoamParams oldRoam_;
    RoamParams newRoam_;
    bool       isReset_;
};

#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <vector>

class Timeline;

// ─── AddAutomationClipsBatchCommand ───────────────────────────────────────────
// Inserts N automation clips as ONE undoable operation.
//
// Unlike clips and pattern blocks, automation placements CANNOT be resolved
// client-side in parallel: Timeline::addAutomationClip rejects same-lane overlap
// outright (no overwrite semantics), so every landing tick has to be pushed past
// whatever already sits there — INCLUDING the placements earlier in this same
// batch. That dependency is why paste/Ctrl+D used to await one addClip per
// placement, keeping a running occupancy map in the renderer.
//
// Resolving it here instead makes the whole group one round trip AND one undo
// entry: each placement is slotted against the live lane, which by then already
// contains the ones before it. Redo replays the resolved positions verbatim via
// Timeline::restoreAutomationClip rather than re-slotting, so an undo/redo cycle
// cannot drift the group.

class AddAutomationClipsBatchCommand : public Command {
public:
    struct Placement {
        int      laneId     = -1;
        int      envelopeId = -1;
        TickTime position{};      // DESIRED tick; pushed right on collision
        TickTime duration{};
        TickTime offset{};
    };

    explicit AddAutomationClipsBatchCommand(std::vector<Placement> placements);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    // Nothing landed ⇒ nothing to undo; keep the empty step out of the history.
    bool shouldRecordInUndoHistory() const override { return !assignedIds_.empty(); }

    const std::vector<int>& getAssignedIds() const { return assignedIds_; }

    // The client-side findFreePosition (mixer/automationKnobBinding.jsx), ported
    // verbatim: push right past every clip this placement overlaps, repeating
    // until a pass finds no collision. Exposed for the unit test.
    static int64_t findFreePosition(const std::vector<std::pair<int64_t, int64_t>>& occupied,
                                    int64_t positionTicks, int64_t durationTicks);

private:
    std::vector<Placement>      placements_;
    std::vector<AutomationClip> added_;      // resolved, id-stamped; replayed on redo
    std::vector<int>            assignedIds_;
    bool                        firstExecute_ = true;
};

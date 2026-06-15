#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <vector>

class Timeline;

// ─── AddClipsBatchCommand ─────────────────────────────────────────────────────
// Inserts N clips into the timeline as a single undoable operation.
// On first execute(), each clip is added via Timeline::addClip() and the
// assigned IDs are captured. Redo uses Timeline::restoreClip() to preserve
// those IDs across undo/redo cycles.

class AddClipsBatchCommand : public Command {
public:
    explicit AddClipsBatchCommand(std::vector<Clip> clips);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    const std::vector<int>& getAssignedIds() const { return assignedIds_; }

private:
    std::vector<Clip> clips_;
    std::vector<int>  assignedIds_;
    bool              firstExecute_ = true;
};

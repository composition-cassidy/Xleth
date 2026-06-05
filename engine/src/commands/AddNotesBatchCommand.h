#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <vector>

class Timeline;

// ─── AddNotesBatchCommand ─────────────────────────────────────────────────────
// Inserts N notes into an existing pattern as a single undoable operation.
// Incoming note IDs are ignored — the target pattern assigns real IDs on the
// first execute() exactly the way the single-note AddNoteCommand does (one ID
// per note from Pattern::nextNoteId, with the pattern length recalculated).
// The assigned IDs are recorded so undo() removes exactly the imported notes,
// and so the bridge can return the real IDs to the caller.
//
// Redo restores each note with its assigned ID (mirroring AddNoteCommand) so
// IDs stay stable across undo/redo cycles.

class AddNotesBatchCommand : public Command {
public:
    AddNotesBatchCommand(int patternId, std::vector<PatternNote> notes);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    // Valid after the first execute(); empty before. Used by the bridge to
    // report the real note IDs assigned by the pattern.
    const std::vector<int>& getAssignedIds() const { return assignedIds_; }

private:
    int                      patternId_;
    std::vector<PatternNote> notes_;        // ids filled in on first execute()
    std::vector<int>         assignedIds_;
    bool                     firstExecute_ = true;
};

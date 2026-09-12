#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <vector>

class Timeline;

// ─── AddPatternBlocksBatchCommand ─────────────────────────────────────────────
// Inserts N pattern blocks as ONE undoable operation.
//
// Ctrl+V / Ctrl+D used to emit an awaited addPatternBlock PER block, plus a
// second awaited setPatternBlockLoop for every looped one — a 64-block paste was
// 64+ stacked round trips and 64+ undo entries, which the renderer papered over
// with compoundUndoCountRef. loopEnabled travels ON the block here, so the loop
// flag costs nothing extra: Timeline::addPatternBlock stores the whole struct.
//
// Mirrors AddClipsBatchCommand: the first execute() assigns ids, redo replays
// them through Timeline::restorePatternBlock so later commands referring to
// those ids stay valid across undo/redo cycles.

class AddPatternBlocksBatchCommand : public Command {
public:
    explicit AddPatternBlocksBatchCommand(std::vector<PatternBlock> blocks);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    // Ids that actually landed — the caller reads the post-state back out of
    // the timeline with these, so the renderer needs no refetch.
    const std::vector<int>& getAssignedIds() const { return assignedIds_; }

private:
    std::vector<PatternBlock> blocks_;
    std::vector<int>          assignedIds_;
    bool                      firstExecute_ = true;
};

// ─── ReplacePatternBlocksBatchCommand ─────────────────────────────────────────
// The atomic form of a pattern-block paste: remove whatever the incoming group
// buries, then insert the group — as ONE undoable operation.
//
// Same reasoning as ReplaceClipsBatchCommand: remove-batch + add-batch works but
// pushes two entries, so a single Ctrl+Z lands in the half-applied state between
// them (buried blocks deleted, replacements not yet gone).

class ReplacePatternBlocksBatchCommand : public Command {
public:
    ReplacePatternBlocksBatchCommand(std::vector<int> removeBlockIds,
                                     std::vector<PatternBlock> blocksToAdd,
                                     const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    const std::vector<int>& getAssignedIds() const { return assignedIds_; }
    const std::vector<int>& getRemovedIds() const { return removedIds_; }

private:
    std::vector<PatternBlock> removed_;    // full structs, for undo
    std::vector<int>          removedIds_;
    std::vector<PatternBlock> added_;
    std::vector<int>          assignedIds_;
    bool                      firstExecute_ = true;
};

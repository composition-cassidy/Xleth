#pragma once
#include "Command.h"
#include "model/TimelineTypes.h"
#include <string>
#include <vector>

class Timeline;

// ─── MoveClipsBatchCommand ────────────────────────────────────────────────────
// Repositions N clips as ONE undoable operation.
//
// Dragging a multi-clip selection used to emit one MoveClipCommand per clip, so
// Ctrl+Z after moving 200 clips put back exactly one of them. Each entry
// captures its own pre-move track + position at construction time, so undo
// restores the selection to precisely where it started.

class MoveClipsBatchCommand : public Command {
public:
    struct Move {
        int      clipId     = -1;
        int      newTrackId = -1;
        TickTime newPosition{};
    };

    MoveClipsBatchCommand(std::vector<Move> moves, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    // Clip IDs that actually resolved to a live clip — the caller uses these to
    // drive render-cache bookkeeping without re-walking the request.
    const std::vector<int>& getMovedIds() const { return movedIds_; }

private:
    struct Entry {
        Move     move;
        int      oldTrackId = -1;
        TickTime oldPosition{};
    };
    std::vector<Entry> entries_;
    std::vector<int>   movedIds_;
};

// ─── RemoveClipsBatchCommand ──────────────────────────────────────────────────
// Deletes N clips as ONE undoable operation. The full Clip struct is captured
// before removal so undo restores every field (fades, stretch, modulation …)
// AND the original clip IDs, via Timeline::restoreClip().

class RemoveClipsBatchCommand : public Command {
public:
    RemoveClipsBatchCommand(std::vector<int> clipIds, const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    const std::vector<int>& getRemovedIds() const { return removedIds_; }

private:
    std::vector<Clip> removed_;
    std::vector<int>  removedIds_;
};

// ─── ReplaceClipsBatchCommand ─────────────────────────────────────────────────
// The atomic form of a paste: remove the clips the incoming group covers, then
// insert the group — as ONE undoable operation.
//
// Doing this as removeClipsBatch + addClipsBatch works but pushes two entries,
// so a single Ctrl+Z lands in the half-applied state between them (originals
// deleted, replacements not yet gone). Ctrl+Z / Ctrl+Y over a paste must move
// between exactly two states, which is what this command guarantees.

class ReplaceClipsBatchCommand : public Command {
public:
    ReplaceClipsBatchCommand(std::vector<int> removeClipIds,
                             std::vector<Clip> clipsToAdd,
                             const Timeline& timeline);
    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;

    const std::vector<int>& getAssignedIds() const { return assignedIds_; }
    const std::vector<int>& getRemovedIds() const { return removedIds_; }

private:
    std::vector<Clip> removed_;      // full structs, for undo
    std::vector<int>  removedIds_;
    std::vector<Clip> added_;
    std::vector<int>  assignedIds_;
    bool              firstExecute_ = true;
};

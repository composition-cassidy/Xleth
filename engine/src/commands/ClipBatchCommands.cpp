#include "commands/ClipBatchCommands.h"
#include "model/Timeline.h"
#include <iostream>

// ─── MoveClipsBatchCommand ────────────────────────────────────────────────────

MoveClipsBatchCommand::MoveClipsBatchCommand(std::vector<Move> moves,
                                             const Timeline& timeline)
{
    entries_.reserve(moves.size());
    movedIds_.reserve(moves.size());
    for (const auto& m : moves) {
        const Clip* c = timeline.getClip(m.clipId);
        if (!c) {
            std::cerr << "[Undo] WARN MoveClipsBatchCommand: clip id=" << m.clipId
                      << " not found in timeline — skipped\n";
            continue;
        }
        Entry e;
        e.move        = m;
        e.oldTrackId  = c->trackId;
        e.oldPosition = c->position;
        entries_.push_back(e);
        movedIds_.push_back(m.clipId);
    }
}

void MoveClipsBatchCommand::execute(Timeline& timeline) {
    // One summary line instead of one per clip — see Timeline::ScopedBulkEdit.
    Timeline::ScopedBulkEdit bulk(timeline);
    for (const auto& e : entries_)
        timeline.moveClip(e.move.clipId, e.move.newTrackId, e.move.newPosition);
    std::cout << "[Timeline] Moved " << entries_.size() << " clip(s) (batch)\n";
}

void MoveClipsBatchCommand::undo(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (const auto& e : entries_)
        timeline.moveClip(e.move.clipId, e.oldTrackId, e.oldPosition);
    std::cout << "[Timeline] Moved " << entries_.size() << " clip(s) back (batch undo)\n";
}

std::string MoveClipsBatchCommand::describe() const {
    return "Move " + std::to_string(entries_.size()) + " clip(s)";
}

// ─── RemoveClipsBatchCommand ──────────────────────────────────────────────────

RemoveClipsBatchCommand::RemoveClipsBatchCommand(std::vector<int> clipIds,
                                                 const Timeline& timeline)
{
    removed_.reserve(clipIds.size());
    removedIds_.reserve(clipIds.size());
    for (int id : clipIds) {
        const Clip* c = timeline.getClip(id);
        if (!c) {
            std::cerr << "[Undo] WARN RemoveClipsBatchCommand: clip id=" << id
                      << " not found in timeline — skipped\n";
            continue;
        }
        removed_.push_back(*c);
        removedIds_.push_back(id);
    }
}

void RemoveClipsBatchCommand::execute(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : removedIds_)
        timeline.removeClip(id);
    std::cout << "[Timeline] Removed " << removedIds_.size() << " clip(s) (batch)\n";
}

void RemoveClipsBatchCommand::undo(Timeline& timeline) {
    // restoreClip() preserves the original IDs, so a redo of any later command
    // that references them still resolves.
    Timeline::ScopedBulkEdit bulk(timeline);
    for (const auto& clip : removed_)
        timeline.restoreClip(clip);
    std::cout << "[Timeline] Restored " << removed_.size() << " clip(s) (batch undo)\n";
}

std::string RemoveClipsBatchCommand::describe() const {
    return "Delete " + std::to_string(removedIds_.size()) + " clip(s)";
}

// ─── ReplaceClipsBatchCommand ─────────────────────────────────────────────────

ReplaceClipsBatchCommand::ReplaceClipsBatchCommand(std::vector<int> removeClipIds,
                                                   std::vector<Clip> clipsToAdd,
                                                   const Timeline& timeline)
    : added_(std::move(clipsToAdd))
{
    removed_.reserve(removeClipIds.size());
    removedIds_.reserve(removeClipIds.size());
    for (int id : removeClipIds) {
        const Clip* c = timeline.getClip(id);
        if (!c) continue;            // already gone — nothing to restore later
        removed_.push_back(*c);
        removedIds_.push_back(id);
    }
}

void ReplaceClipsBatchCommand::execute(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : removedIds_)
        timeline.removeClip(id);

    if (firstExecute_) {
        assignedIds_.clear();
        assignedIds_.reserve(added_.size());
        for (auto& clip : added_) {
            int id = timeline.addClip(clip);
            if (id < 0) {
                std::cerr << "[Undo] ERROR ReplaceClipsBatchCommand::execute: "
                             "addClip failed (check trackId/regionId exist)\n";
                continue;
            }
            clip.id = id;            // so redo can restoreClip() the same id
            assignedIds_.push_back(id);
        }
        firstExecute_ = false;
    } else {
        for (const auto& clip : added_)
            timeline.restoreClip(clip);
    }
    std::cout << "[Timeline] Pasted " << assignedIds_.size() << " clip(s), overwrote "
              << removedIds_.size() << " (batch)\n";
}

void ReplaceClipsBatchCommand::undo(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : assignedIds_)
        timeline.removeClip(id);
    for (const auto& clip : removed_)
        timeline.restoreClip(clip);
    std::cout << "[Timeline] Undid paste: removed " << assignedIds_.size()
              << " clip(s), restored " << removed_.size() << " (batch undo)\n";
}

std::string ReplaceClipsBatchCommand::describe() const {
    return "Paste " + std::to_string(added_.size()) + " clip(s)";
}

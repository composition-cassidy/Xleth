#include "commands/PatternBlockBatchCommands.h"
#include "model/Timeline.h"
#include <iostream>

// ─── AddPatternBlocksBatchCommand ─────────────────────────────────────────────

AddPatternBlocksBatchCommand::AddPatternBlocksBatchCommand(std::vector<PatternBlock> blocks)
    : blocks_(std::move(blocks)) {}

void AddPatternBlocksBatchCommand::execute(Timeline& timeline) {
    // One summary line instead of one per block — see Timeline::ScopedBulkEdit.
    Timeline::ScopedBulkEdit bulk(timeline);
    if (firstExecute_) {
        assignedIds_.clear();
        assignedIds_.reserve(blocks_.size());
        for (auto& b : blocks_) {
            const int id = timeline.addPatternBlock(b);
            if (id < 0) {
                std::cerr << "[Undo] ERROR AddPatternBlocksBatchCommand::execute: "
                             "addPatternBlock failed (check trackId/patternId exist)\n";
                continue;
            }
            b.id = id;               // so redo can restorePatternBlock() the same id
            assignedIds_.push_back(id);
        }
        firstExecute_ = false;
    } else {
        for (const auto& b : blocks_) {
            if (b.id > 0) timeline.restorePatternBlock(b);
        }
    }
    std::cout << "[Timeline] Added " << assignedIds_.size() << " pattern block(s) (batch)\n";
}

void AddPatternBlocksBatchCommand::undo(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : assignedIds_)
        timeline.removePatternBlock(id);
    std::cout << "[Timeline] Removed " << assignedIds_.size()
              << " pattern block(s) (batch undo)\n";
}

std::string AddPatternBlocksBatchCommand::describe() const {
    return "Add " + std::to_string(blocks_.size()) + " pattern block(s)";
}

// ─── ReplacePatternBlocksBatchCommand ─────────────────────────────────────────

ReplacePatternBlocksBatchCommand::ReplacePatternBlocksBatchCommand(
        std::vector<int> removeBlockIds,
        std::vector<PatternBlock> blocksToAdd,
        const Timeline& timeline)
    : added_(std::move(blocksToAdd))
{
    removed_.reserve(removeBlockIds.size());
    removedIds_.reserve(removeBlockIds.size());
    for (int id : removeBlockIds) {
        const PatternBlock* b = timeline.getPatternBlock(id);
        if (!b) continue;            // already gone — nothing to restore later
        removed_.push_back(*b);
        removedIds_.push_back(id);
    }
}

void ReplacePatternBlocksBatchCommand::execute(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : removedIds_)
        timeline.removePatternBlock(id);

    if (firstExecute_) {
        assignedIds_.clear();
        assignedIds_.reserve(added_.size());
        for (auto& b : added_) {
            const int id = timeline.addPatternBlock(b);
            if (id < 0) {
                std::cerr << "[Undo] ERROR ReplacePatternBlocksBatchCommand::execute: "
                             "addPatternBlock failed (check trackId/patternId exist)\n";
                continue;
            }
            b.id = id;
            assignedIds_.push_back(id);
        }
        firstExecute_ = false;
    } else {
        for (const auto& b : added_) {
            if (b.id > 0) timeline.restorePatternBlock(b);
        }
    }
    std::cout << "[Timeline] Pasted " << assignedIds_.size() << " pattern block(s), overwrote "
              << removedIds_.size() << " (batch)\n";
}

void ReplacePatternBlocksBatchCommand::undo(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : assignedIds_)
        timeline.removePatternBlock(id);
    // restorePatternBlock() preserves the original ids, so a redo of any later
    // command that references them still resolves.
    for (const auto& b : removed_)
        timeline.restorePatternBlock(b);
    std::cout << "[Timeline] Undid pattern-block paste: removed " << assignedIds_.size()
              << ", restored " << removed_.size() << " (batch undo)\n";
}

std::string ReplacePatternBlocksBatchCommand::describe() const {
    return "Paste " + std::to_string(added_.size()) + " pattern block(s)";
}

#include "commands/AutomationBatchCommands.h"
#include "model/Timeline.h"
#include <algorithm>
#include <iostream>

// ─── AddAutomationClipsBatchCommand ───────────────────────────────────────────

AddAutomationClipsBatchCommand::AddAutomationClipsBatchCommand(std::vector<Placement> placements)
    : placements_(std::move(placements)) {}

int64_t AddAutomationClipsBatchCommand::findFreePosition(
        const std::vector<std::pair<int64_t, int64_t>>& occupied,
        int64_t positionTicks, int64_t durationTicks)
{
    // (position, duration) pairs, scanned in ascending position order so one
    // pass usually settles it — the loop repeats only when being pushed right
    // lands on a clip already scanned past.
    std::vector<std::pair<int64_t, int64_t>> sorted = occupied;
    std::sort(sorted.begin(), sorted.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });

    int64_t pos = positionTicks;
    bool moved = true;
    while (moved) {
        moved = false;
        for (const auto& c : sorted) {
            const int64_t cEnd = c.first + c.second;
            if (pos < cEnd && c.first < pos + durationTicks) {
                pos = cEnd;
                moved = true;
            }
        }
    }
    return pos;
}

void AddAutomationClipsBatchCommand::execute(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);

    if (firstExecute_) {
        added_.clear();
        assignedIds_.clear();
        added_.reserve(placements_.size());
        assignedIds_.reserve(placements_.size());

        for (const auto& p : placements_) {
            // Read the lane back on every iteration: the placements already
            // added by THIS batch are in it, which is exactly the dependency
            // that made a client-side Promise.all wrong.
            std::vector<std::pair<int64_t, int64_t>> occupied;
            for (const AutomationClip* c : timeline.getAutomationClipsOnLane(p.laneId))
                occupied.emplace_back(c->position.ticks, c->duration.ticks);

            AutomationClip c;
            c.laneId         = p.laneId;
            c.envelopeId     = p.envelopeId;
            c.position.ticks = findFreePosition(occupied, p.position.ticks, p.duration.ticks);
            c.duration       = p.duration;
            c.offset         = p.offset;

            const int id = timeline.addAutomationClip(c);
            if (id < 0) {
                // Unknown lane/envelope or non-positive duration — a resolved
                // position can no longer collide.
                std::cerr << "[Undo] WARN AddAutomationClipsBatchCommand::execute: "
                             "addAutomationClip rejected (lane=" << p.laneId
                          << " envelope=" << p.envelopeId << ")\n";
                continue;
            }
            c.id = id;
            added_.push_back(c);
            assignedIds_.push_back(id);
        }
        firstExecute_ = false;
    } else {
        // Redo replays the RESOLVED placements, so the group cannot drift right
        // one slot per undo/redo cycle.
        for (const auto& c : added_)
            timeline.restoreAutomationClip(c);
    }
    std::cout << "[Timeline] Added " << assignedIds_.size()
              << " automation clip(s) (batch)\n";
}

void AddAutomationClipsBatchCommand::undo(Timeline& timeline) {
    Timeline::ScopedBulkEdit bulk(timeline);
    for (int id : assignedIds_)
        timeline.removeAutomationClip(id);
    std::cout << "[Timeline] Removed " << assignedIds_.size()
              << " automation clip(s) (batch undo)\n";
}

std::string AddAutomationClipsBatchCommand::describe() const {
    return "Add " + std::to_string(placements_.size()) + " automation clip(s)";
}

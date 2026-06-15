#include "commands/AddClipsBatchCommand.h"
#include "model/Timeline.h"
#include <iostream>

AddClipsBatchCommand::AddClipsBatchCommand(std::vector<Clip> clips)
    : clips_(std::move(clips)) {}

void AddClipsBatchCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        assignedIds_.clear();
        assignedIds_.reserve(clips_.size());
        for (auto& clip : clips_) {
            int id = timeline.addClip(clip);
            if (id < 0) {
                std::cerr << "[Undo] ERROR AddClipsBatchCommand::execute: "
                             "addClip failed (check trackId/regionId exist)\n";
                continue;
            }
            clip.id = id;
            assignedIds_.push_back(id);
        }
        firstExecute_ = false;
    } else {
        for (const auto& clip : clips_) {
            timeline.restoreClip(clip);
        }
    }
}

void AddClipsBatchCommand::undo(Timeline& timeline) {
    for (int id : assignedIds_) {
        timeline.removeClip(id);
    }
}

std::string AddClipsBatchCommand::describe() const {
    return "Add clips batch";
}

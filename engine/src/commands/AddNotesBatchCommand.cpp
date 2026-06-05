#include "commands/AddNotesBatchCommand.h"
#include "model/Timeline.h"
#include <iostream>

AddNotesBatchCommand::AddNotesBatchCommand(int patternId, std::vector<PatternNote> notes)
    : patternId_(patternId), notes_(std::move(notes)) {}

void AddNotesBatchCommand::execute(Timeline& timeline) {
    if (firstExecute_) {
        // First run: let the pattern assign a real ID per note, the same way
        // AddNoteCommand does. Record each assigned ID so undo() can remove the
        // exact notes and the bridge can return them.
        assignedIds_.clear();
        assignedIds_.reserve(notes_.size());
        for (auto& note : notes_) {
            int id = timeline.addNoteToPattern(patternId_, note);
            if (id < 0) {
                std::cerr << "[Undo] ERROR AddNotesBatchCommand::execute: "
                             "addNoteToPattern failed (check patternId exists)\n";
                continue;
            }
            note.id = id;            // keep for redo (restore path)
            assignedIds_.push_back(id);
        }
        firstExecute_ = false;
    } else {
        // Redo: restore with the IDs assigned on the first execute().
        for (const auto& note : notes_) {
            timeline.restoreNoteInPattern(patternId_, note);
        }
    }
}

void AddNotesBatchCommand::undo(Timeline& timeline) {
    for (int id : assignedIds_) {
        timeline.removeNoteFromPattern(patternId_, id);
    }
}

std::string AddNotesBatchCommand::describe() const {
    return "Import notes";
}

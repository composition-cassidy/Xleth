#include "commands/UndoManager.h"
#include <iostream>

UndoManager::UndoManager(int maxHistory) : maxHistory_(maxHistory) {}

void UndoManager::execute(std::unique_ptr<Command> cmd, Timeline& timeline) {
    // Branch detection (pre-push): if the savepoint lies in the redo history
    // we're about to discard, the savepoint command is being destroyed.
    // In the pop-on-undo model, that's the case when savepointIndex_ is
    // greater than undoStack_.size() — i.e. the user undid past the save.
    if (!savepointPoisoned_ && savepointIndex_ > undoStack_.size()) {
        savepointPoisoned_ = true;
    }

    // Clear redo stack — a new edit invalidates the forward history
    if (!redoStack_.empty()) {
        std::cout << "[Undo] Redo stack cleared ("
                  << redoStack_.size() << " item(s)) by new command\n";
        redoStack_.clear();
    }

    const std::string desc = cmd->describe();
    cmd->execute(timeline);
    undoStack_.push_back(std::move(cmd));

    // Enforce history cap — drop the oldest entry if exceeded
    if ((int)undoStack_.size() > maxHistory_) {
        undoStack_.erase(undoStack_.begin());
        // Stack shifted down by one — keep savepointIndex_ pointing at the
        // same command. If the savepoint command itself was dropped, poison.
        if (savepointIndex_ == 0) {
            savepointPoisoned_ = true;
        } else {
            --savepointIndex_;
        }
        std::cout << "[Undo] Stack overflow: dropped oldest entry"
                     " (max=" << maxHistory_ << ")\n";
    }

    std::cout << "[Undo] Execute '" << desc << "'"
              << " | undo=" << undoStack_.size()
              << " redo=" << redoStack_.size() << "\n";
}

bool UndoManager::undo(Timeline& timeline) {
    if (undoStack_.empty()) {
        std::cout << "[Undo] WARNING undo(): nothing to undo\n";
        return false;
    }

    auto& cmd = undoStack_.back();
    const std::string desc = cmd->describe();
    cmd->undo(timeline);
    redoStack_.push_back(std::move(cmd));
    undoStack_.pop_back();

    std::cout << "[Undo] Undo '" << desc << "'"
              << " | undo=" << undoStack_.size()
              << " redo=" << redoStack_.size() << "\n";
    return true;
}

bool UndoManager::redo(Timeline& timeline) {
    if (redoStack_.empty()) {
        std::cout << "[Undo] WARNING redo(): nothing to redo\n";
        return false;
    }

    auto& cmd = redoStack_.back();
    const std::string desc = cmd->describe();
    cmd->execute(timeline);
    undoStack_.push_back(std::move(cmd));
    redoStack_.pop_back();

    std::cout << "[Undo] Redo '" << desc << "'"
              << " | undo=" << undoStack_.size()
              << " redo=" << redoStack_.size() << "\n";
    return true;
}

bool UndoManager::canUndo() const { return !undoStack_.empty(); }
bool UndoManager::canRedo() const { return !redoStack_.empty(); }

std::string UndoManager::getUndoDescription() const {
    return undoStack_.empty() ? "" : undoStack_.back()->describe();
}

std::string UndoManager::getRedoDescription() const {
    return redoStack_.empty() ? "" : redoStack_.back()->describe();
}

int UndoManager::getUndoCount() const { return static_cast<int>(undoStack_.size()); }
int UndoManager::getRedoCount()  const { return static_cast<int>(redoStack_.size()); }

void UndoManager::clear() {
    const int u = getUndoCount(), r = getRedoCount();
    undoStack_.clear();
    redoStack_.clear();
    savepointIndex_ = 0;
    savepointPoisoned_ = false;
    std::cout << "[Undo] Cleared history (" << u << " undo, " << r << " redo)\n";
}

void UndoManager::markSavepoint() {
    savepointIndex_ = undoStack_.size();
    savepointPoisoned_ = false;
    std::cout << "[Undo] Savepoint marked at depth " << savepointIndex_ << "\n";
}

bool UndoManager::isDirty() const {
    return savepointPoisoned_ || undoStack_.size() != savepointIndex_;
}

#include "commands/UndoManager.h"
#include <iostream>

UndoManager::UndoManager(int maxHistory) : maxHistory_(maxHistory) {}

void UndoManager::setPostMutationHook(std::function<void()> hook) {
    postMutationHook_ = std::move(hook);
}

void UndoManager::firePostMutationHook() const {
    if (postMutationHook_) postMutationHook_();
}

void UndoManager::setMutationMutex(std::recursive_mutex* mutex) {
    mutationMutex_ = mutex;
}

namespace {

// Holds the mutation mutex, if there is one, for the enclosing scope.
struct MutationLock {
    explicit MutationLock(std::recursive_mutex* m) : mutex(m) { if (mutex) mutex->lock(); }
    ~MutationLock() { if (mutex) mutex->unlock(); }
    MutationLock(const MutationLock&) = delete;
    MutationLock& operator=(const MutationLock&) = delete;
    std::recursive_mutex* mutex;
};

} // namespace

void UndoManager::execute(std::unique_ptr<Command> cmd, Timeline& timeline) {
    const std::string desc = cmd->describe();
    {
        MutationLock lock(mutationMutex_);
        cmd->execute(timeline);
    }
    // A command that opts out of undo history has still mutated the timeline, so
    // the hook must fire on this path too.
    if (!cmd->shouldRecordInUndoHistory()) {
        firePostMutationHook();
        return;
    }

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

    firePostMutationHook();
}

bool UndoManager::undo(Timeline& timeline) {
    if (undoStack_.empty()) {
        std::cout << "[Undo] WARNING undo(): nothing to undo\n";
        return false;
    }

    auto& cmd = undoStack_.back();
    const std::string desc = cmd->describe();
    {
        MutationLock lock(mutationMutex_);
        cmd->undo(timeline);
    }
    redoStack_.push_back(std::move(cmd));
    undoStack_.pop_back();

    std::cout << "[Undo] Undo '" << desc << "'"
              << " | undo=" << undoStack_.size()
              << " redo=" << redoStack_.size() << "\n";

    firePostMutationHook();
    return true;
}

bool UndoManager::redo(Timeline& timeline) {
    if (redoStack_.empty()) {
        std::cout << "[Undo] WARNING redo(): nothing to redo\n";
        return false;
    }

    auto& cmd = redoStack_.back();
    const std::string desc = cmd->describe();
    {
        MutationLock lock(mutationMutex_);
        cmd->execute(timeline);
    }
    if (!cmd->shouldRecordInUndoHistory()) {
        firePostMutationHook();
        return false;
    }
    undoStack_.push_back(std::move(cmd));
    redoStack_.pop_back();

    std::cout << "[Undo] Redo '" << desc << "'"
              << " | undo=" << undoStack_.size()
              << " redo=" << redoStack_.size() << "\n";

    firePostMutationHook();
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

std::string UndoManager::getUndoDomain() const {
    return undoStack_.empty() ? std::string{} : std::string(undoStack_.back()->domain());
}

std::string UndoManager::getRedoDomain() const {
    return redoStack_.empty() ? std::string{} : std::string(redoStack_.back()->domain());
}

namespace {
std::vector<UndoManager::HistoryEntry>
snapshotStack(const std::vector<std::unique_ptr<Command>>& stack) {
    std::vector<UndoManager::HistoryEntry> out;
    out.reserve(stack.size());
    for (const auto& c : stack)
        out.push_back({ c->describe(), std::string(c->domain()) });
    return out;
}
} // namespace

std::vector<UndoManager::HistoryEntry> UndoManager::getUndoHistory() const {
    return snapshotStack(undoStack_);
}

std::vector<UndoManager::HistoryEntry> UndoManager::getRedoHistory() const {
    return snapshotStack(redoStack_);
}

int UndoManager::countByDomain(const std::string& domain) const {
    int n = 0;
    for (const auto& c : undoStack_) if (domain == c->domain()) ++n;
    return n;
}

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

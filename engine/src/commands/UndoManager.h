#pragma once
#include "Command.h"
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

class Timeline;

// ─── UndoManager ──────────────────────────────────────────────────────────────
// Owns two LIFO stacks of Commands (undo and redo).
//
// Rules:
//   • execute() calls cmd->execute(); rejected commands are not recorded,
//     successful commands push onto undo stack and clear redo stack.
//   • undo()    pops the undo stack, calls cmd->undo(), pushes onto redo stack.
//   • redo()    pops the redo stack, calls cmd->execute(), pushes onto undo stack.
//   • If undoStack exceeds maxHistory, the oldest entry is silently dropped.
//
// NOT thread-safe — call from a single thread only. (setMutationMutex below
// does not change that: it protects the TIMELINE against a concurrent reader,
// not this class against a second writer.)

class UndoManager {
public:
    explicit UndoManager(int maxHistory = 100);

    void execute(std::unique_ptr<Command> cmd, Timeline& timeline);
    bool undo(Timeline& timeline);
    bool redo(Timeline& timeline);

    bool canUndo() const;
    bool canRedo() const;

    // Description of the next command to be undone / redone ("" if none).
    std::string getUndoDescription() const;
    std::string getRedoDescription() const;

    int getUndoCount() const;
    int getRedoCount() const;

    // ─── Per-surface history (Command::domain) ────────────────────────────────
    // There is exactly ONE undo stack for the whole app, but not one editing
    // surface: the Sample Sandbox panel has its own Undo/Redo buttons, and
    // pressing them must not quietly undo a timeline clip move that happens to
    // sit on top. These let a caller ask what the next entry actually belongs
    // to before offering to undo it.
    //
    // Domain of the next command to be undone / redone ("" if none).
    std::string getUndoDomain() const;
    std::string getRedoDomain() const;

    struct HistoryEntry {
        std::string description;
        std::string domain;
    };

    // Both are OLDEST → NEWEST, so the last element is the next one to be
    // undone (resp. redone) — the same order the stacks themselves are in.
    std::vector<HistoryEntry> getUndoHistory() const;
    std::vector<HistoryEntry> getRedoHistory() const;

    // Entries whose domain == `domain`. Cheap enough to call from a UI poll:
    // the stack is capped at maxHistory (100 by default).
    int countByDomain(const std::string& domain) const;

    void clear();

    // ─── Dirty / savepoint tracking ───────────────────────────────────────────
    // markSavepoint() records the current undo-stack depth as "saved state".
    // isDirty() returns true when the stack has diverged from that state —
    // either by count (new edits / undos past savepoint) or by branch
    // poisoning (a new edit was executed after undoing past the savepoint,
    // which destroys the redo history that contained the savepoint command).
    //
    // markSavepoint() does NOT touch the redo stack — users expect Ctrl+Y to
    // still work after saving.
    void markSavepoint();
    bool isDirty() const;

    // ─── Post-mutation hook ───────────────────────────────────────────────────
    // Invoked once after every execute / undo / redo that actually changed the
    // timeline. Exists so engine-side derived state that depends on timeline
    // CONTENT (not just on chains or routing) has a single, complete refresh
    // point instead of a call bolted onto every mutation handler.
    //
    // Every timeline mutation goes through this class by project invariant, so a
    // hook here cannot be bypassed by a new command type — which is exactly the
    // property per-handler wiring lacks.
    //
    // Main/message thread only. The hook must not throw and must not mutate the
    // timeline (it runs while the command stacks are consistent but unlocked).
    void setPostMutationHook(std::function<void()> hook);

    // ─── Mutation guard ───────────────────────────────────────────────────────
    // When set, the mutex is held for exactly the span in which a command
    // changes the timeline — Command::execute() and Command::undo() — and
    // released before stack bookkeeping and the post-mutation hook run.
    //
    // It exists for the one other thread that reads the timeline: the video
    // thread, which looks up tracks, regions and sources on every preview
    // frame. Those are std::map lookups; a command inserting or erasing a node
    // in the same map underneath one is a data race that can walk a tree
    // mid-rebalance or read a node that was just freed. Locking around each
    // mutation handler would work only until the next handler forgets — a
    // handful of them took the lock and well over a hundred did not. Every
    // timeline mutation goes through this class by project invariant, so one
    // lock here covers all of them, including command types not written yet.
    //
    // Recursive on purpose: several bridge handlers already hold this same
    // mutex around their execute() call (so that follow-up work lands in the
    // same critical section), and they must keep working unchanged.
    //
    // The pointee must outlive the UndoManager. nullptr (the default) disables
    // the guard, which is what every unit test wants.
    void setMutationMutex(std::recursive_mutex* mutex);

private:
    void firePostMutationHook() const;

    std::function<void()> postMutationHook_;
    std::recursive_mutex* mutationMutex_ = nullptr;

    std::vector<std::unique_ptr<Command>> undoStack_;
    std::vector<std::unique_ptr<Command>> redoStack_;
    int maxHistory_;

    // Undo-stack depth at which the project was last saved.
    size_t savepointIndex_ = 0;
    // Set when a divergent branch destroys the savepoint command.
    bool savepointPoisoned_ = false;
};

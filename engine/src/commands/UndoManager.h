#pragma once
#include "Command.h"
#include <functional>
#include <memory>
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
// NOT thread-safe — call from a single thread only.

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

private:
    void firePostMutationHook() const;

    std::function<void()> postMutationHook_;

    std::vector<std::unique_ptr<Command>> undoStack_;
    std::vector<std::unique_ptr<Command>> redoStack_;
    int maxHistory_;

    // Undo-stack depth at which the project was last saved.
    size_t savepointIndex_ = 0;
    // Set when a divergent branch destroys the savepoint command.
    bool savepointPoisoned_ = false;
};

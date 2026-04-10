#pragma once
#include "Command.h"
#include <memory>
#include <string>
#include <vector>

class Timeline;

// ─── UndoManager ──────────────────────────────────────────────────────────────
// Owns two LIFO stacks of Commands (undo and redo).
//
// Rules:
//   • execute() calls cmd->execute(), pushes onto undo stack, clears redo stack.
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

private:
    std::vector<std::unique_ptr<Command>> undoStack_;
    std::vector<std::unique_ptr<Command>> redoStack_;
    int maxHistory_;
};

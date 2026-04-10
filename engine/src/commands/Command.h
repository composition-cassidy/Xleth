#pragma once
#include <string>

class Timeline; // forward declaration — commands only use it by reference

// ─── Command ──────────────────────────────────────────────────────────────────
// Abstract base for all reversible timeline edits.
// Concrete commands must implement execute(), undo(), and describe().

class Command {
public:
    virtual ~Command() = default;

    // Apply the edit to the timeline.
    virtual void execute(Timeline& timeline) = 0;

    // Reverse the edit, restoring timeline to the pre-execute() state.
    virtual void undo(Timeline& timeline) = 0;

    // Human-readable description shown in undo/redo menu items.
    virtual std::string describe() const = 0;
};

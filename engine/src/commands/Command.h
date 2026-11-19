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

    // A rejected mutation must not be recorded as an undoable edit. Neither
    // must one that turned out to change nothing: an entry that undoes to the
    // same state is a keypress that visibly does nothing, and recording it
    // throws away the redo history for no reason.
    virtual bool shouldRecordInUndoHistory() const { return applied_; }

    // Which editing surface this command belongs to. The undo stack is SHARED
    // across every surface (there is exactly one UndoManager), so a UI that
    // owns a sub-surface needs to know whether the entry it is about to undo
    // is actually one of its own — the Sample Sandbox panel's Undo button must
    // not silently undo a timeline clip move.
    //
    // Stable, lowercase, no spaces: it is compared as a string by the bridge
    // and shipped to the renderer verbatim. Default "timeline" — every command
    // that predates this method edits the Timeline, so the default is correct
    // for all of them and only a genuinely different surface overrides it.
    virtual const char* domain() const { return "timeline"; }

protected:
    // Called from execute() by a command whose edit can be refused (unknown id,
    // invalid value) or can be a no-op (the value is already what was asked
    // for). `false` keeps the command out of the undo history.
    void setApplied(bool applied) { applied_ = applied; }

private:
    bool applied_ = true;
};

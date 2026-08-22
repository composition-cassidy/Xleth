#pragma once

#include "commands/Command.h"
#include "sandbox/SandboxCore.h"
#include "sandbox/SandboxOp.h"

#include <string>

// ─── Sandbox undo commands ────────────────────────────────────────────────────
//
// One command per stack mutation: add / remove / reorder / setParam /
// setBypassed, plus layer add/remove so a source can be dropped in and taken out
// undoably. Nothing else is allowed to mutate a stack — the raw SandboxCore
// mutators exist for these classes and for project load.
//
// ── Why Timeline& is ignored ─────────────────────────────────────────────────
// Command::execute takes a Timeline& because that is what every timeline edit
// needs; a sandbox stack is not in the Timeline. LoadEffectChainCommand set this
// precedent for mixer chains, which are not in the Timeline either. The
// difference is that effect chains live in MixEngine — an audio-tier object the
// model tier cannot name — so that command injects a closure. SandboxCore is
// model-tier, so these commands hold it directly: fewer moving parts, and no
// capture whose lifetime has to be reasoned about separately from the object's.
//
// LIFETIME: each command holds a raw SandboxCore& . That is safe for the same
// reason LoadEffectChainCommand's captured MixEngine is — the UndoManager is
// torn down before the objects its commands reference, and project load clears
// the undo stack before rebuilding the workspace. A SandboxCore must outlive any
// UndoManager holding commands against it.
//
// ── Rejection ────────────────────────────────────────────────────────────────
// Every command reports shouldRecordInUndoHistory() == false when its first
// execute() changed nothing (unknown layer/op, out-of-range index, a param
// written to the value it already held). A rejected mutation must not consume an
// undo step, or Ctrl+Z starts doing nothing for a while before it does anything.

namespace xleth::sandbox {

// ─── AddSandboxOpCommand ──────────────────────────────────────────────────────
// `index` < 0 appends. The id assigned by the first execute() is restored on
// every redo, so a later command that addresses this op by id stays valid across
// an undo/redo cycle.

class AddSandboxOpCommand : public Command {
public:
    AddSandboxOpCommand(SandboxCore& core, int layerId, SandboxOp op, int index = -1);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

    // Id assigned by execute(), or -1 if the add was rejected.
    int opId() const { return opId_; }

private:
    SandboxCore& core_;
    int          layerId_;
    SandboxOp    op_;
    int          index_;
    int          opId_    = -1;
    bool         accepted_ = false;
};

// ─── RemoveSandboxOpCommand ───────────────────────────────────────────────────
// Captures the op and its index on execute so undo puts it back where it was,
// with its original id.

class RemoveSandboxOpCommand : public Command {
public:
    RemoveSandboxOpCommand(SandboxCore& core, int layerId, int opId);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore& core_;
    int          layerId_;
    int          opId_;
    SandboxOp    removed_;
    int          removedIndex_ = -1;
    bool         accepted_     = false;
};

// ─── ReorderSandboxOpCommand ──────────────────────────────────────────────────
// Undo is NOT a mirrored reorder(to, from) — for a move that skips over other
// ops, sliding back from the destination lands somewhere else. It replays the
// exact op order captured before the move, which is correct for every case and
// costs one vector of ints.

class ReorderSandboxOpCommand : public Command {
public:
    ReorderSandboxOpCommand(SandboxCore& core, int layerId, int fromIndex, int toIndex);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore&     core_;
    int              layerId_;
    int              fromIndex_;
    int              toIndex_;
    std::vector<int> orderBefore_;   // op ids, pre-move
    bool             accepted_ = false;
};

// ─── SetSandboxOpParamsCommand ────────────────────────────────────────────────
// Whole-params replacement. The UI's drag pattern is: preview locally while
// dragging, push ONE of these on release — a command per mouse-move would bury
// the undo stack and re-render on every frame.

class SetSandboxOpParamsCommand : public Command {
public:
    SetSandboxOpParamsCommand(SandboxCore& core, int layerId, int opId, SandboxOpParams newParams);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore&    core_;
    int             layerId_;
    int             opId_;
    SandboxOpParams newParams_;
    SandboxOpParams oldParams_;
    bool            accepted_ = false;
};

// ─── SetSandboxOpBypassedCommand ──────────────────────────────────────────────

class SetSandboxOpBypassedCommand : public Command {
public:
    SetSandboxOpBypassedCommand(SandboxCore& core, int layerId, int opId, bool bypassed);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore& core_;
    int          layerId_;
    int          opId_;
    bool         bypassed_;
    bool         accepted_ = false;
};

// ─── AddSandboxLayerCommand ───────────────────────────────────────────────────

class AddSandboxLayerCommand : public Command {
public:
    AddSandboxLayerCommand(SandboxCore& core, std::string name,
                           int sourceBufferId, double bufferSampleRate);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

    int layerId() const { return layerId_; }

private:
    SandboxCore& core_;
    std::string  name_;
    int          sourceBufferId_;
    double       bufferSampleRate_;
    int          layerId_  = -1;
    SandboxLayer snapshot_;              // captured on undo, replayed on redo
    bool         haveSnapshot_ = false;
    bool         accepted_ = false;
};

// ─── RemoveSandboxLayerCommand ────────────────────────────────────────────────
// Removing a layer takes its whole op-stack with it, so undo restores the layer
// verbatim — id, ops, op ids and mix params — not a fresh empty one.

class RemoveSandboxLayerCommand : public Command {
public:
    RemoveSandboxLayerCommand(SandboxCore& core, int layerId);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore& core_;
    int          layerId_;
    SandboxLayer removed_;
    int          removedIndex_ = -1;
    bool         accepted_     = false;
};

} // namespace xleth::sandbox

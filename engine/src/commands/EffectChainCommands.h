#pragma once
#include "Command.h"
#include <functional>
#include <nlohmann/json.hpp>
#include <string>

class Timeline;

// ─── LoadEffectChainCommand ───────────────────────────────────────────────────
// Replaces a whole mixer effect chain (every processor, its order, its bypass
// flag and its full APVTS/VST state) in ONE undoable step.
//
// Loading a saved chain from the FX Chain Library is not a sequence of
// add/remove/move calls the user should have to Ctrl+Z through one at a time —
// it is a single edit, so it gets a single command. Both directions are a plain
// EffectChainManager::graphFromJSON of a snapshot captured by graphToJSON:
// execute() applies the incoming snapshot, undo() applies the one taken
// immediately before it.
//
// ── Why the apply function is injected ──
// Effect chains live in MixEngine, not in Timeline, and XlethEngineModel (which
// owns this file) deliberately does not link against the audio library. Rather
// than drag MixEngine into the model target, the caller hands in a closure that
// performs the swap. That also makes the command directly testable with a fake
// apply function and no audio engine at all.
//
// Timeline& is ignored — it is part of the Command interface, not of this edit.
//
// LIFETIME: the closure typically captures the MixEngine. That is safe because
// the UndoManager is torn down before the audio engine in the service shutdown
// sequence, and project load clears the undo stack before rebuilding chains.

class LoadEffectChainCommand : public Command {
public:
    // `applyFn` returns false when the engine refuses the snapshot; a failed
    // execute() is not recorded in history (see shouldRecordInUndoHistory).
    using ApplyFn = std::function<bool(const nlohmann::json&)>;

    // `alreadyApplied` is for the normal library-load path: the caller has just
    // built the chain through the ordered-preset builder and captured the result
    // as `newChain`, so the FIRST execute() must not re-apply it (that would
    // rebuild every plugin a second time, audibly, for no reason). Redo — every
    // later execute() — does apply it, which is what makes the snapshot worth
    // carrying. Pass false when the command itself should perform the edit.
    LoadEffectChainCommand(int trackId,
                           std::string label,
                           nlohmann::json oldChain,
                           nlohmann::json newChain,
                           ApplyFn applyFn,
                           bool alreadyApplied = false);

    void execute(Timeline& timeline) override;
    void undo(Timeline& timeline) override;
    std::string describe() const override;
    bool shouldRecordInUndoHistory() const override { return record_; }

    // True once execute() has run and the engine accepted the snapshot. The RPC
    // layer reports this back to the renderer so a rejected load surfaces as an
    // error instead of a silent no-op.
    bool applied() const { return applied_; }

private:
    int            trackId_;          // -1 = master chain
    std::string    label_;            // preset name, for describe(); may be empty
    nlohmann::json oldChain_;
    nlohmann::json newChain_;
    ApplyFn        applyFn_;

    // An identical snapshot is not an edit — reloading the chain a track already
    // has must not push a no-op step onto the global undo stack.
    bool record_  = true;
    bool applied_ = false;

    // Set by the alreadyApplied ctor flag; consumed by the first execute().
    bool skipFirstApply_ = false;
};

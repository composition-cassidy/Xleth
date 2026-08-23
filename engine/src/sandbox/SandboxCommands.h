#pragma once

#include "commands/Command.h"
#include "sandbox/SandboxCore.h"
#include "sandbox/SandboxOp.h"

#include <functional>
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

// ─── SandboxCommand ───────────────────────────────────────────────────────────
// Common base for every sandbox edit. Its only job is to stamp
// Command::domain() as "sandbox": the UndoManager is shared with the Timeline,
// and the Sample Sandbox panel's own Undo button has to be able to tell
// whether the entry on top of that shared stack is one of its own before
// offering to undo it. Deriving here rather than repeating the override eight
// times also means a NEW sandbox command cannot forget to be tagged.

class SandboxCommand : public Command {
public:
    const char* domain() const override { return "sandbox"; }
};

// ─── AddSandboxOpCommand ──────────────────────────────────────────────────────
// `index` < 0 appends. The id assigned by the first execute() is restored on
// every redo, so a later command that addresses this op by id stays valid across
// an undo/redo cycle.

class AddSandboxOpCommand : public SandboxCommand {
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

class RemoveSandboxOpCommand : public SandboxCommand {
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

class ReorderSandboxOpCommand : public SandboxCommand {
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

class SetSandboxOpParamsCommand : public SandboxCommand {
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

class SetSandboxOpBypassedCommand : public SandboxCommand {
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

class AddSandboxLayerCommand : public SandboxCommand {
public:
    // The trailing three arguments are the layer's DURABLE source reference
    // (SandboxLayer: path + time range). Omit them for a layer over an
    // in-memory asset — a composite bake — which has no file to reload from.
    AddSandboxLayerCommand(SandboxCore& core, std::string name,
                           int sourceBufferId, double bufferSampleRate,
                           std::string sourceFilePath = {},
                           double sourceStartTime = 0.0, double sourceEndTime = 0.0);

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
    std::string  sourceFilePath_;
    double       sourceStartTime_ = 0.0;
    double       sourceEndTime_   = 0.0;
    int          layerId_  = -1;
    SandboxLayer snapshot_;              // captured on undo, replayed on redo
    bool         haveSnapshot_ = false;
    bool         accepted_ = false;
};

// ─── RemoveSandboxLayerCommand ────────────────────────────────────────────────
// Removing a layer takes its whole op-stack with it, so undo restores the layer
// verbatim — id, ops, op ids and mix params — not a fresh empty one.

class RemoveSandboxLayerCommand : public SandboxCommand {
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

// ─── SetSandboxLayerMixCommand ────────────────────────────────────────────────
// Whole-params replacement of a layer's gain/pan/offset, same drag contract as
// SetSandboxOpParamsCommand: preview locally while dragging, push one of these
// on release. Does NOT touch the op-stack or its dirty flags — mix params are
// applied at composite time (SandboxRenderer::renderComposite), so this never
// invalidates a cached per-layer render.

class SetSandboxLayerMixCommand : public SandboxCommand {
public:
    SetSandboxLayerMixCommand(SandboxCore& core, int layerId,
                              double gainDb, double pan, int64_t offsetSamples);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore& core_;
    int          layerId_;
    double       gainDb_;
    double       pan_;
    int64_t      offsetSamples_;
    double       oldGainDb_        = 0.0;
    double       oldPan_           = 0.0;
    int64_t      oldOffsetSamples_ = 0;
    bool         accepted_         = false;
};

// ─── SetSandboxLayerMutedCommand / SetSandboxLayerSoloedCommand ──────────────
// One flag each, mirroring SetSandboxOpBypassedCommand. Neither touches the
// op-stack — see the mix-params note above.

class SetSandboxLayerMutedCommand : public SandboxCommand {
public:
    SetSandboxLayerMutedCommand(SandboxCore& core, int layerId, bool muted);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore& core_;
    int          layerId_;
    bool         muted_;
    bool         accepted_ = false;
};

class SetSandboxLayerSoloedCommand : public SandboxCommand {
public:
    SetSandboxLayerSoloedCommand(SandboxCore& core, int layerId, bool soloed);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

private:
    SandboxCore& core_;
    int          layerId_;
    bool         soloed_;
    bool         accepted_ = false;
};

// ─── BakeSandboxCompositeCommand ──────────────────────────────────────────────
// Renders the current composite (every layer's own published render, mixed by
// gain/pan/offset/mute/solo) and registers it as a brand-new SampleBank asset.
// Never mutates or removes any layer's stack — strictly additive, exactly like
// sandbox_bake is for a single layer.
//
// SandboxRenderer and SampleBank are Core-tier objects XlethEngineModel (which
// owns this file) does not link against. Following LoadEffectChainCommand's
// precedent (EffectChainCommands.h) for the identical situation, the actual
// buffer-level work is injected as closures built by the bridge, where both
// objects are nameable:
//
//   BakeFn    — computes the composite from the layer set captured at
//               construction and registers it, returning the new sample id
//               (or -1 when the composite is empty — e.g. every layer trimmed
//               to zero length). Called ONLY by the first execute().
//   UndoFn    — tombstones the asset this command created.
//   RestoreFn — re-fills the tombstoned slot with the SAME content BakeFn
//               produced. Called by every execute() AFTER the first, so a
//               redo never re-renders the composite or mints a second asset
//               for one undo step.
//
// LIFETIME: the closures typically capture the SampleBank/SandboxRenderer and
// a small bag of the rendered composite buffer for RestoreFn — same lifetime
// contract as LoadEffectChainCommand's captured MixEngine.

class BakeSandboxCompositeCommand : public SandboxCommand {
public:
    using BakeFn    = std::function<int()>;
    using UndoFn    = std::function<void(int sampleId)>;
    using RestoreFn = std::function<bool(int sampleId)>;

    BakeSandboxCompositeCommand(std::string label, BakeFn bakeFn, UndoFn undoFn, RestoreFn restoreFn);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

    // The SampleBank id baked, or -1 if the composite was empty. Valid to read
    // only when accepted_ was true at the time this command was pushed — see
    // the dangling-cmdPtr note in XlethEngineService.cpp's sandbox section for
    // why a caller that cannot guarantee acceptance in advance should capture
    // the id through its OWN closure state instead of reading this back.
    int bakedSampleId() const { return sampleId_; }

private:
    std::string label_;
    BakeFn      bakeFn_;
    UndoFn      undoFn_;
    RestoreFn   restoreFn_;
    int         sampleId_     = -1;
    bool        everExecuted_ = false;
    bool        accepted_     = false;
};

// ─── SwapSandboxSampleCommand ─────────────────────────────────────────────────
// SWAP IN (SB-6): replaces the sample bound to a project binding with the
// sandbox's rendered output.
//
// ── What "the binding" actually is ───────────────────────────────────────────
// The caller addresses a swap as {trackId, regionId} because that is how a user
// points at it ("this sample, on this track"). It is NOT, however, where the
// audio binding lives. In MixEngine:
//   • samplers_          is keyed {trackId, regionId} — the Sampler INSTANCE.
//   • regionToSampleMap_ is keyed regionId alone      — the AUDIO.
//   • slotSampleMap_     is keyed {regionId, slot}    — slots 1..7's audio.
// Slot 0 resolves through the region map, which is why MixEngine's own comment
// says it "follows swaps automatically". So the audio binding is REGION-scoped,
// and a swap necessarily updates every placed instance of that region — every
// clip on it and every {*, regionId} sampler on every track. That is not a
// compromise, it is the requirement: "ALL placed instances update". trackId
// only ever narrows which binding the caller MEANT; it cannot narrow the
// effect, and this command does not pretend otherwise.
//
// ── Why closures again ───────────────────────────────────────────────────────
// MixEngine, SampleBank and SandboxRenderer are Core/audio-tier objects that
// XlethEngineModel (which owns this file) does not link against — the same
// situation BakeSandboxCompositeCommand and LoadEffectChainCommand are in, so
// this follows their shape exactly:
//
//   SwapFn   — performs the FIRST swap: renders/collects the layer's published
//              buffer, materialises it (the bridge writes a WAV into the
//              project's swapped/ dir so the swap survives a reload), registers
//              it as a NEW SampleBank asset, and rebinds the region to it.
//              Returns the new sample id, or -1 to reject the whole command.
//              Called ONLY by the first execute().
//   RevertFn — restores the binding captured before that swap: the previous
//              SampleBank id and the previous region swapped-audio fields.
//   ApplyFn  — re-applies the swapped binding for the id SwapFn produced.
//              Called by every execute() AFTER the first, so a redo never
//              re-renders and never mints a second asset.
//
// ── Atomic handoff ───────────────────────────────────────────────────────────
// Every one of those three rebinds a region to a DIFFERENT, already-complete
// SampleBank id. None of them writes into a buffer the audio thread might be
// reading: the old asset stays live and untouched for the whole session, which
// is also what lets undo be an id swap rather than a re-decode.

class SwapSandboxSampleCommand : public SandboxCommand {
public:
    using SwapFn   = std::function<int()>;
    using RevertFn = std::function<bool()>;
    using ApplyFn  = std::function<bool(int sampleId)>;

    SwapSandboxSampleCommand(std::string label, int trackId, int regionId,
                             SwapFn swapFn, RevertFn revertFn, ApplyFn applyFn);

    void        execute(Timeline& timeline) override;
    void        undo(Timeline& timeline) override;
    std::string describe() const override;
    bool        shouldRecordInUndoHistory() const override { return accepted_; }

    int trackId()  const { return trackId_; }
    int regionId() const { return regionId_; }

    // The SampleBank id now bound to the region, or -1 if the swap was
    // rejected. Same caveat as BakeSandboxCompositeCommand::bakedSampleId():
    // a swap CAN legitimately be rejected, so a caller that cannot prove
    // acceptance in advance must read the id back through its OWN closure
    // state, not through this pointer — see the dangling-cmdPtr note in
    // XlethEngineService.cpp's sandbox section.
    int swappedSampleId() const { return sampleId_; }

private:
    std::string label_;
    int         trackId_;
    int         regionId_;
    SwapFn      swapFn_;
    RevertFn    revertFn_;
    ApplyFn     applyFn_;
    int         sampleId_     = -1;
    bool        everExecuted_ = false;
    bool        accepted_     = false;
};

} // namespace xleth::sandbox

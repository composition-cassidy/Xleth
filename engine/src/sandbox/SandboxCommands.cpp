#include "sandbox/SandboxCommands.h"

#include <algorithm>

namespace xleth::sandbox {

namespace {

// Human-readable op name for describe(). The undo menu says "Add Fade", not
// "Add op type 5".
std::string opLabel(SandboxOpType type) {
    switch (type) {
        case SandboxOpType::Trim:      return "Trim";
        case SandboxOpType::Cut:       return "Cut";
        case SandboxOpType::Paste:     return "Paste";
        case SandboxOpType::Splice:    return "Splice";
        case SandboxOpType::Reverse:   return "Reverse";
        case SandboxOpType::Fade:      return "Fade";
        case SandboxOpType::Gain:      return "Gain";
        case SandboxOpType::Crossfade: return "Crossfade";
        case SandboxOpType::Pitch:     return "Pitch";
        case SandboxOpType::Stretch:   return "Stretch";
    }
    return "Op";
}

// Current op order of a layer, as ids. Used by the reorder command's undo.
std::vector<int> captureOrder(const SandboxCore& core, int layerId) {
    std::vector<int> order;
    if (const SandboxLayer* l = core.findLayer(layerId)) {
        order.reserve(l->ops.size());
        for (const auto& op : l->ops) order.push_back(op.id);
    }
    return order;
}

// Replay a captured op order onto a layer using only reorderOp, so the dirty
// marking and the change hook fire exactly as they would for a user drag.
void applyOrder(SandboxCore& core, int layerId, const std::vector<int>& order) {
    for (size_t target = 0; target < order.size(); ++target) {
        const SandboxLayer* l = core.findLayer(layerId);
        if (l == nullptr) return;
        const int from = l->indexOfOp(order[target]);
        if (from < 0) continue;                       // op no longer present
        if (from == static_cast<int>(target)) continue;
        core.reorderOp(layerId, from, static_cast<int>(target));
    }
}

} // namespace

// ─── AddSandboxOpCommand ──────────────────────────────────────────────────────

AddSandboxOpCommand::AddSandboxOpCommand(SandboxCore& core, int layerId, SandboxOp op, int index)
    : core_(core), layerId_(layerId), op_(std::move(op)), index_(index) {}

void AddSandboxOpCommand::execute(Timeline&) {
    int assigned = -1;
    // op_ carries the id assigned by the first execute() on every later redo,
    // which is what keeps a follow-up SetParams command addressing the same op.
    if (!core_.addOp(layerId_, op_, index_, &assigned)) {
        opId_ = -1;
        accepted_ = false;
        return;
    }
    opId_    = assigned;
    op_.id   = assigned;
    accepted_ = true;
}

void AddSandboxOpCommand::undo(Timeline&) {
    if (!accepted_) return;
    core_.removeOp(layerId_, opId_);
}

std::string AddSandboxOpCommand::describe() const {
    return "Add " + opLabel(op_.type);
}

// ─── RemoveSandboxOpCommand ───────────────────────────────────────────────────

RemoveSandboxOpCommand::RemoveSandboxOpCommand(SandboxCore& core, int layerId, int opId)
    : core_(core), layerId_(layerId), opId_(opId) {}

void RemoveSandboxOpCommand::execute(Timeline&) {
    accepted_ = core_.removeOp(layerId_, opId_, &removed_, &removedIndex_);
}

void RemoveSandboxOpCommand::undo(Timeline&) {
    if (!accepted_) return;
    // removed_ still carries its original id, so addOp takes the redo branch and
    // restores it rather than minting a new one.
    core_.addOp(layerId_, removed_, removedIndex_);
}

std::string RemoveSandboxOpCommand::describe() const {
    return accepted_ ? "Remove " + opLabel(removed_.type) : "Remove Op";
}

// ─── ReorderSandboxOpCommand ──────────────────────────────────────────────────

ReorderSandboxOpCommand::ReorderSandboxOpCommand(SandboxCore& core, int layerId,
                                                 int fromIndex, int toIndex)
    : core_(core), layerId_(layerId), fromIndex_(fromIndex), toIndex_(toIndex) {}

void ReorderSandboxOpCommand::execute(Timeline&) {
    // Re-capture on every execute: a redo runs against whatever state the undo
    // stack has been wound back to, which need not be the state the first
    // execute saw.
    orderBefore_ = captureOrder(core_, layerId_);
    accepted_    = core_.reorderOp(layerId_, fromIndex_, toIndex_);
}

void ReorderSandboxOpCommand::undo(Timeline&) {
    if (!accepted_) return;
    applyOrder(core_, layerId_, orderBefore_);
}

std::string ReorderSandboxOpCommand::describe() const {
    return "Reorder Sandbox Op";
}

// ─── SetSandboxOpParamsCommand ────────────────────────────────────────────────

SetSandboxOpParamsCommand::SetSandboxOpParamsCommand(SandboxCore& core, int layerId,
                                                     int opId, SandboxOpParams newParams)
    : core_(core), layerId_(layerId), opId_(opId), newParams_(std::move(newParams)) {}

void SetSandboxOpParamsCommand::execute(Timeline&) {
    const SandboxLayer* layer = core_.findLayer(layerId_);
    if (layer == nullptr) { accepted_ = false; return; }

    const SandboxOp* op = layer->findOp(opId_);
    if (op == nullptr) { accepted_ = false; return; }

    // Capture on every execute, not just the first: the redo path must restore
    // whatever was there immediately before this step ran.
    oldParams_ = op->params;
    accepted_  = core_.setOpParams(layerId_, opId_, newParams_);
}

void SetSandboxOpParamsCommand::undo(Timeline&) {
    if (!accepted_) return;
    core_.setOpParams(layerId_, opId_, oldParams_);
}

std::string SetSandboxOpParamsCommand::describe() const {
    const SandboxLayer* layer = core_.findLayer(layerId_);
    const SandboxOp*    op    = layer ? layer->findOp(opId_) : nullptr;
    return op ? "Edit " + opLabel(op->type) : "Edit Sandbox Op";
}

// ─── SetSandboxOpBypassedCommand ──────────────────────────────────────────────

SetSandboxOpBypassedCommand::SetSandboxOpBypassedCommand(SandboxCore& core, int layerId,
                                                         int opId, bool bypassed)
    : core_(core), layerId_(layerId), opId_(opId), bypassed_(bypassed) {}

void SetSandboxOpBypassedCommand::execute(Timeline&) {
    accepted_ = core_.setOpBypassed(layerId_, opId_, bypassed_);
}

void SetSandboxOpBypassedCommand::undo(Timeline&) {
    if (!accepted_) return;
    core_.setOpBypassed(layerId_, opId_, !bypassed_);
}

std::string SetSandboxOpBypassedCommand::describe() const {
    return bypassed_ ? "Bypass Sandbox Op" : "Enable Sandbox Op";
}

// ─── AddSandboxLayerCommand ───────────────────────────────────────────────────

AddSandboxLayerCommand::AddSandboxLayerCommand(SandboxCore& core, std::string name,
                                               int sourceBufferId, double bufferSampleRate)
    : core_(core), name_(std::move(name)),
      sourceBufferId_(sourceBufferId), bufferSampleRate_(bufferSampleRate) {}

void AddSandboxLayerCommand::execute(Timeline&) {
    if (haveSnapshot_) {
        // Redo: put back the layer exactly as undo found it, including any ops
        // added on top of it before the undo. Rebuilding an empty layer here
        // would silently drop that work.
        accepted_ = core_.restoreLayer(snapshot_);
        if (accepted_) layerId_ = snapshot_.id;
        return;
    }
    layerId_  = core_.addLayer(name_, sourceBufferId_, bufferSampleRate_);
    accepted_ = layerId_ > 0;
}

void AddSandboxLayerCommand::undo(Timeline&) {
    if (!accepted_) return;
    haveSnapshot_ = core_.removeLayer(layerId_, &snapshot_);
}

std::string AddSandboxLayerCommand::describe() const {
    return name_.empty() ? "Add Sandbox Layer" : "Add Layer \"" + name_ + "\"";
}

// ─── RemoveSandboxLayerCommand ────────────────────────────────────────────────

RemoveSandboxLayerCommand::RemoveSandboxLayerCommand(SandboxCore& core, int layerId)
    : core_(core), layerId_(layerId) {}

void RemoveSandboxLayerCommand::execute(Timeline&) {
    accepted_ = core_.removeLayer(layerId_, &removed_, &removedIndex_);
}

void RemoveSandboxLayerCommand::undo(Timeline&) {
    if (!accepted_) return;
    core_.restoreLayer(removed_, removedIndex_);
}

std::string RemoveSandboxLayerCommand::describe() const {
    return accepted_ && !removed_.name.empty()
         ? "Remove Layer \"" + removed_.name + "\""
         : "Remove Sandbox Layer";
}

} // namespace xleth::sandbox

#include "EffectChainCommands.h"

#include <utility>

// ─── LoadEffectChainCommand ───────────────────────────────────────────────────

LoadEffectChainCommand::LoadEffectChainCommand(int trackId,
                                               std::string label,
                                               nlohmann::json oldChain,
                                               nlohmann::json newChain,
                                               ApplyFn applyFn,
                                               bool alreadyApplied)
    : trackId_(trackId),
      label_(std::move(label)),
      oldChain_(std::move(oldChain)),
      newChain_(std::move(newChain)),
      applyFn_(std::move(applyFn)),
      skipFirstApply_(alreadyApplied)
{
    // No apply function means the edit can never be reversed, so it must not be
    // recorded as if it could. An already-applied edit is the exception: the
    // change is real and undo still needs the restore leg, so it is only the
    // *forward* application that is skipped.
    if (!applyFn_) {
        record_ = false;
        skipFirstApply_ = false;
        return;
    }

    // Snapshots carry transient engine node uids (reassigned on every load), so
    // two structurally identical chains can differ only in those ids. Compare on
    // what the user can actually hear and see instead: which plugin sits in which
    // slot, whether it is bypassed, and its serialized state.
    const auto fingerprint = [](const nlohmann::json& chain) {
        nlohmann::json out = nlohmann::json::array();
        if (!chain.contains("nodes") || !chain["nodes"].is_array()) return out;
        for (const auto& node : chain["nodes"]) {
            if (!node.is_object()) continue;
            out.push_back({
                { "pluginId", node.value("pluginId", std::string{}) },
                { "bypassed", node.value("bypassed", false) },
                { "missing",  node.value("missing",  false) },
                { "state",    node.value("state",    std::string{}) },
            });
        }
        return out;
    };

    record_ = fingerprint(oldChain_) != fingerprint(newChain_);
}

void LoadEffectChainCommand::execute(Timeline&) {
    if (skipFirstApply_) {
        // The caller already built this chain; adopt it without rebuilding.
        skipFirstApply_ = false;
        applied_ = true;
        return;
    }
    applied_ = applyFn_ && applyFn_(newChain_);
    // A snapshot the engine rejected leaves the chain untouched, so it must not
    // become an undo step that would "restore" a state that never went away.
    if (!applied_) record_ = false;
}

void LoadEffectChainCommand::undo(Timeline&) {
    if (applyFn_) applyFn_(oldChain_);
}

std::string LoadEffectChainCommand::describe() const {
    const std::string target = (trackId_ < 0)
        ? std::string("Master")
        : ("Track " + std::to_string(trackId_));
    if (label_.empty())
        return "Load FX Chain (" + target + ")";
    return "Load FX Chain \"" + label_ + "\" (" + target + ")";
}

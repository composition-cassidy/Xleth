#include "audio/EffectChainManager.h"
#include "audio/AudioGraph.h"
#include "audio/PluginRegistry.h"

// ─── Lifecycle ──────────────────────────────────────────────────────────────

EffectChainManager::EffectChainManager()
    : graph_(std::make_unique<AudioGraph>())
{}

void EffectChainManager::setPluginRegistry(PluginRegistry* registry)
{
    graph_->setPluginRegistry(registry);
}

EffectChainManager::~EffectChainManager() { destroy(); }

void EffectChainManager::init(double sampleRate, int blockSize)
{
    graph_->init(sampleRate, blockSize);
}

void EffectChainManager::destroy()
{
    graph_->destroy();
}

bool EffectChainManager::isInitialized() const
{
    return graph_->isInitialized();
}

void EffectChainManager::reprepare(double sampleRate, int blockSize)
{
    graph_->reprepare(sampleRate, blockSize);
}

void EffectChainManager::setNonRealtime(bool nr)
{
    graph_->setNonRealtime(nr);
}

// ─── Chain mutations ────────────────────────────────────────────────────────

int EffectChainManager::addEffect(const std::string& pluginId, int position)
{
    return graph_->addEffect(pluginId, position);
}

bool EffectChainManager::removeEffect(int nodeId)
{
    return graph_->removeEffect(nodeId);
}

bool EffectChainManager::moveEffect(int nodeId, int newPosition)
{
    return graph_->moveEffect(nodeId, newPosition);
}

bool EffectChainManager::setBypass(int nodeId, bool bypassed)
{
    return graph_->setBypass(nodeId, bypassed);
}

// ─── Query ──────────────────────────────────────────────────────────────────

int EffectChainManager::getEffectCount() const
{
    return graph_->getEffectCount();
}

nlohmann::json EffectChainManager::getChainState() const
{
    return graph_->getChainState();
}

int EffectChainManager::countActiveResonanceSuppressorHighQualityInstances() const
{
    return graph_ ? graph_->countActiveResonanceSuppressorHighQualityInstances() : 0;
}

// ─── Graph-mode APIs ────────────────────────────────────────────────────────

bool EffectChainManager::addConnection(int sourceNodeId, int destNodeId)
{
    return graph_->addConnection(sourceNodeId, destNodeId);
}

bool EffectChainManager::removeConnection(int sourceNodeId, int destNodeId)
{
    return graph_->removeConnection(sourceNodeId, destNodeId);
}

bool EffectChainManager::setWireGain(int sourceNodeId, int destNodeId, float gain)
{
    return graph_->setWireGain(sourceNodeId, destNodeId, gain);
}

bool EffectChainManager::setWireMute(int sourceNodeId, int destNodeId, bool muted)
{
    return graph_->setWireMute(sourceNodeId, destNodeId, muted);
}

void EffectChainManager::setNodePosition(int nodeId, float x, float y)
{
    graph_->setNodePosition(nodeId, x, y);
}

nlohmann::json EffectChainManager::getGraphTopology() const
{
    return graph_->getGraphTopology();
}

bool EffectChainManager::isGraphLinear() const
{
    return graph_->isGraphLinear();
}

// ─── Graph-owned effect instance lifecycle (FXG.3-b) ──────────────────────────
//
// Uses the low-level AudioGraph addNode/removeNode (NOT addEffect/removeEffect)
// so graph-owned nodes never touch the linear chain ordering. Nodes are created
// disconnected; graphState edges are not synced into the engine until FXG.3-c.

int EffectChainManager::addGraphNode(const std::string& effectInstanceId,
                                     const std::string& pluginId)
{
    if (!graph_ || effectInstanceId.empty()) return -1;

    // Reject placeholder / data-only instantiation cleanly. The renderer also
    // gates this, but defend the engine boundary too. (createEffect would fail
    // for "placeholder" anyway; rejecting here avoids an empty-name registry
    // lookup and keeps the contract explicit.)
    if (pluginId.empty() || pluginId == "placeholder") return -1;

    // Idempotent: a known effectInstanceId keeps its existing engine node.
    auto existing = graphNodeIds_.find(effectInstanceId);
    if (existing != graphNodeIds_.end()) return existing->second;

    const int nodeId = graph_->addNode(pluginId);
    if (nodeId < 0) return -1;

    graphNodeIds_[effectInstanceId] = nodeId;
    return nodeId;
}

bool EffectChainManager::removeGraphNode(const std::string& effectInstanceId)
{
    if (!graph_) return false;
    auto it = graphNodeIds_.find(effectInstanceId);
    if (it == graphNodeIds_.end()) return false;

    const bool ok = graph_->removeNode(it->second);
    graphNodeIds_.erase(it);
    return ok;
}

int EffectChainManager::getGraphNodeEngineId(const std::string& effectInstanceId) const
{
    auto it = graphNodeIds_.find(effectInstanceId);
    return it == graphNodeIds_.end() ? -1 : it->second;
}

bool EffectChainManager::hasGraphNode(const std::string& effectInstanceId) const
{
    return graphNodeIds_.count(effectInstanceId) > 0;
}

// --- Graph-owned project-load hydration --------------------------------------

nlohmann::json EffectChainManager::hydrateGraphNodes(const nlohmann::json& graphEffectNodes)
{
    nlohmann::json result = {
        {"ok", true},
        {"mapping", nlohmann::json::object()},
        {"skipped", nlohmann::json::array()},
        {"failures", nlohmann::json::array()},
    };

    if (!graphEffectNodes.is_array())
    {
        result["ok"] = false;
        result["reason"] = "invalid_nodes";
        return result;
    }

    auto makeDiag = [](const nlohmann::json& node,
                       const std::string& reason,
                       const std::string& effectInstanceId = {},
                       const std::string& pluginId = {}) {
        nlohmann::json diag;
        diag["reason"] = reason;
        if (!effectInstanceId.empty())
            diag["effectInstanceId"] = effectInstanceId;
        if (!pluginId.empty())
            diag["pluginId"] = pluginId;
        if (node.is_object())
        {
            if (node.contains("graphNodeId") && node["graphNodeId"].is_string())
                diag["graphNodeId"] = node["graphNodeId"].get<std::string>();
            if (node.contains("displayName") && node["displayName"].is_string())
                diag["displayName"] = node["displayName"].get<std::string>();
        }
        return diag;
    };

    for (const auto& node : graphEffectNodes)
    {
        if (!node.is_object())
        {
            result["failures"].push_back(makeDiag(node, "invalid_node"));
            continue;
        }

        const std::string effectInstanceId =
            node.contains("effectInstanceId") && node["effectInstanceId"].is_string()
                ? node["effectInstanceId"].get<std::string>()
                : std::string{};
        const std::string pluginId =
            node.contains("pluginId") && node["pluginId"].is_string()
                ? node["pluginId"].get<std::string>()
                : std::string{};

        if (effectInstanceId.empty())
        {
            result["failures"].push_back(
                makeDiag(node, "invalid_effect_instance_id", effectInstanceId, pluginId));
            continue;
        }
        if (pluginId.empty())
        {
            result["failures"].push_back(
                makeDiag(node, "invalid_plugin_id", effectInstanceId, pluginId));
            continue;
        }
        if (pluginId == "placeholder")
        {
            result["skipped"].push_back(
                makeDiag(node, "placeholder_plugin", effectInstanceId, pluginId));
            continue;
        }

        const int nodeId = addGraphNode(effectInstanceId, pluginId);
        if (nodeId < 0)
        {
            result["failures"].push_back(
                makeDiag(node, "instantiation_failed", effectInstanceId, pluginId));
            continue;
        }

        result["mapping"][effectInstanceId] = nodeId;
    }

    return result;
}

// ─── Effect parameter / meter access ────────────────────────────────────────

std::string EffectChainManager::getEffectParameters(int nodeId) const
{
    return graph_->getEffectParameters(nodeId);
}

bool EffectChainManager::setEffectParameter(int nodeId, const std::string& paramId, float value)
{
    return graph_->setEffectParameter(nodeId, paramId, value);
}

bool EffectChainManager::setEffectProgram(int nodeId, int programIndex)
{
    return graph_->setEffectProgram(nodeId, programIndex);
}

bool EffectChainManager::setEffectStateInformation(int nodeId,
                                                   const void* data,
                                                   int sizeInBytes)
{
    return graph_->setEffectStateInformation(nodeId, data, sizeInBytes);
}

std::string EffectChainManager::getEffectMeter(int nodeId) const
{
    return graph_->getEffectMeter(nodeId);
}

bool EffectChainManager::refreshGuardedPluginLatency(int nodeId)
{
    return graph_ ? graph_->refreshGuardedPluginLatency(nodeId) : false;
}

bool EffectChainManager::refreshGuardedPluginLatency(
    int nodeId,
    std::uint64_t latencyPublishCountBefore)
{
    return graph_
        ? graph_->refreshGuardedPluginLatency(nodeId, latencyPublishCountBefore)
        : false;
}

XlethEffectBase* EffectChainManager::getEffect(int nodeId)
{
    return graph_->getEffect(nodeId);
}

juce::AudioProcessor* EffectChainManager::getProcessor(int nodeId)
{
    return graph_->getProcessor(nodeId);
}

juce::String EffectChainManager::getPluginFilePath(int nodeId) const
{
    return graph_->getPluginFilePath(nodeId);
}

// ─── Missing-plugin support ─────────────────────────────────────────────────

bool EffectChainManager::isNodeMissing(int nodeId) const
{
    return graph_->isNodeMissing(nodeId);
}

bool EffectChainManager::tryResolvePlugin(int nodeId, PluginRegistry& registry)
{
    return graph_->tryResolvePlugin(nodeId, registry);
}

bool EffectChainManager::isNodeCrashed(int nodeId) const
{
    return graph_->isNodeCrashed(nodeId);
}

bool EffectChainManager::resetCrashedPlugin(int nodeId)
{
    return graph_->resetCrashedPlugin(nodeId);
}

nlohmann::json EffectChainManager::getMissingNodesJSON() const
{
    nlohmann::json arr = nlohmann::json::array();
    const auto chainState = graph_->getChainState();
    for (const auto& node : chainState)
    {
        if (node.value("missing", false))
            arr.push_back(node);
    }
    return arr;
}

// ─── Serialization ──────────────────────────────────────────────────────────

nlohmann::json EffectChainManager::graphToJSON() const
{
    nlohmann::json out = graph_->toJSON();
    if (!out.contains("nodes") || !out["nodes"].is_array() || graphNodeIds_.empty())
        return out;

    std::unordered_map<int, std::string> engineNodeToEffectInstance;
    for (const auto& [effectInstanceId, engineNodeId] : graphNodeIds_)
        engineNodeToEffectInstance[engineNodeId] = effectInstanceId;

    for (auto& node : out["nodes"])
    {
        if (!node.is_object()) continue;
        const int engineNodeId = node.value("nodeId", -1);
        auto it = engineNodeToEffectInstance.find(engineNodeId);
        if (it != engineNodeToEffectInstance.end())
            node["effectInstanceId"] = it->second;
    }

    return out;
}

bool EffectChainManager::graphFromJSON(const nlohmann::json& j)
{
    graphNodeIds_.clear();

    std::unordered_map<int, int> oldToNewNodeIds;
    const bool ok = graph_->fromJSON(j, &oldToNewNodeIds);
    if (!ok) return false;

    if (!j.contains("nodes") || !j["nodes"].is_array())
        return true;

    for (const auto& node : j["nodes"])
    {
        if (!node.is_object()) continue;
        const std::string effectInstanceId =
            node.contains("effectInstanceId") && node["effectInstanceId"].is_string()
                ? node["effectInstanceId"].get<std::string>()
                : std::string{};
        if (effectInstanceId.empty() || graphNodeIds_.count(effectInstanceId) > 0)
            continue;

        const int oldNodeId = node.value("nodeId", -1);
        auto mapped = oldToNewNodeIds.find(oldNodeId);
        if (mapped != oldToNewNodeIds.end() && mapped->second >= 0)
            graphNodeIds_[effectInstanceId] = mapped->second;
    }

    return true;
}

// ─── Audio thread ───────────────────────────────────────────────────────────

void EffectChainManager::processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                                      juce::MidiBuffer& midi)
{
    graph_->processBlock(buffer, numSamples, midi);
}

void EffectChainManager::resetProcessors()
{
    if (graph_)
        graph_->resetProcessors();
}

double EffectChainManager::getMaxTailLengthSeconds() const
{
    return graph_ ? graph_->getMaxTailLengthSeconds() : 0.0;
}

int EffectChainManager::getOutputLatencySamples() const
{
    return graph_ ? graph_->getOutputLatencySamples() : 0;
}

std::uint64_t EffectChainManager::getLatencyEpoch() const
{
    return graph_ ? graph_->getLatencyEpoch() : 0;
}

void EffectChainManager::refreshLatencyDiagnostics()
{
    if (graph_)
        graph_->refreshLatencyDiagnostics();
}

int EffectChainManager::addProcessorForTesting(const std::string& pluginId,
                                               std::unique_ptr<juce::AudioProcessor> proc,
                                               int position)
{
    return graph_ ? graph_->addProcessorForTesting(pluginId, std::move(proc), position) : -1;
}

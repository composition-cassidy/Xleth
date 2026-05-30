#include "audio/EffectChainManager.h"
#include "audio/AudioGraph.h"
#include "audio/PluginRegistry.h"

#include <functional>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

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

nlohmann::json EffectChainManager::syncGraphTopology(const nlohmann::json& topology)
{
    struct RuntimeNode
    {
        std::string id;
        std::string type;
        std::string effectInstanceId;
        std::string pluginId;
        bool missing = false;
    };

    auto baseResult = [] {
        return nlohmann::json{
            {"ok", false},
            {"phase", "FXG.3-d"},
            {"mode", "none"},
            {"pathEffectCount", 0},
            {"appliedConnectionCount", 0},
            {"fallbackApplied", false},
        };
    };

    // Fail-closed: clear ALL connections so neither stale chain nor stale graph
    // routing can remain audible. With no connections, Track Output has no
    // inputs and the track is silent.
    auto fail = [&](const std::string& reason) {
        nlohmann::json result = baseResult();
        result["reason"] = reason;
        result["fallback"] = "silence";
        const bool fallbackApplied = graph_ ? graph_->clearConnectionsToSilence() : false;
        result["fallbackApplied"] = fallbackApplied;
        return result;
    };

    if (!graph_) return fail("engine_unavailable");
    if (!topology.is_object()) return fail("invalid_topology");
    if (!topology.contains("nodes") || !topology["nodes"].is_array())
        return fail("invalid_nodes");
    if (!topology.contains("edges") || !topology["edges"].is_array())
        return fail("invalid_edges");

    // ── Parse nodes ──────────────────────────────────────────────────────
    std::unordered_map<std::string, RuntimeNode> nodes;
    std::string trackInputId;
    std::string trackOutputId;
    int trackInputCount = 0;
    int trackOutputCount = 0;

    for (const auto& nodeJson : topology["nodes"])
    {
        if (!nodeJson.is_object()) return fail("invalid_node");

        const std::string nodeId =
            nodeJson.contains("nodeId") && nodeJson["nodeId"].is_string()
                ? nodeJson["nodeId"].get<std::string>()
                : std::string{};
        const std::string type =
            nodeJson.contains("type") && nodeJson["type"].is_string()
                ? nodeJson["type"].get<std::string>()
                : std::string{};

        if (nodeId.empty() || type.empty()) return fail("invalid_node");
        if (nodes.count(nodeId) > 0) return fail("duplicate_node_id");

        RuntimeNode node;
        node.id = nodeId;
        node.type = type;
        node.effectInstanceId =
            nodeJson.contains("effectInstanceId") && nodeJson["effectInstanceId"].is_string()
                ? nodeJson["effectInstanceId"].get<std::string>()
                : std::string{};
        node.pluginId =
            nodeJson.contains("pluginId") && nodeJson["pluginId"].is_string()
                ? nodeJson["pluginId"].get<std::string>()
                : std::string{};
        node.missing = nodeJson.value("missing", false);

        if (type == "trackInput")
        {
            ++trackInputCount;
            trackInputId = nodeId;
        }
        else if (type == "trackOutput")
        {
            ++trackOutputCount;
            trackOutputId = nodeId;
        }

        nodes.emplace(nodeId, std::move(node));
    }

    if (trackInputCount != 1 || trackOutputCount != 1)
        return fail("invalid_track_io_multiplicity");

    // ── Parse audio edges (deduped) into adjacency ───────────────────────
    std::unordered_map<std::string, std::vector<std::string>> outgoing;
    std::unordered_map<std::string, std::vector<std::string>> incoming;
    for (const auto& [nodeId, node] : nodes)
    {
        outgoing[nodeId];
        incoming[nodeId];
    }
    std::unordered_set<std::string> seenEdges;
    std::vector<std::pair<std::string, std::string>> audioEdges;

    for (const auto& edgeJson : topology["edges"])
    {
        if (!edgeJson.is_object()) return fail("invalid_edge");

        const std::string edgeType =
            edgeJson.contains("type") && edgeJson["type"].is_string()
                ? edgeJson["type"].get<std::string>()
                : std::string{};
        if (edgeType != "audio") continue;

        const std::string sourceNodeId =
            edgeJson.contains("sourceNodeId") && edgeJson["sourceNodeId"].is_string()
                ? edgeJson["sourceNodeId"].get<std::string>()
                : std::string{};
        const std::string targetNodeId =
            edgeJson.contains("targetNodeId") && edgeJson["targetNodeId"].is_string()
                ? edgeJson["targetNodeId"].get<std::string>()
                : std::string{};

        if (sourceNodeId.empty() || targetNodeId.empty()) return fail("invalid_edge");
        if (nodes.count(sourceNodeId) == 0 || nodes.count(targetNodeId) == 0)
            return fail("invalid_edge_reference");
        if (sourceNodeId == targetNodeId) return fail("cycle_detected");

        const std::string key = sourceNodeId + "\x1f" + targetNodeId;
        if (!seenEdges.insert(key).second) continue;   // dedupe repeated cables

        outgoing[sourceNodeId].push_back(targetNodeId);
        incoming[targetNodeId].push_back(sourceNodeId);
        audioEdges.emplace_back(sourceNodeId, targetNodeId);
    }

    // ── Reject cycles (DFS white/gray/black over the directed audio graph) ─
    {
        std::unordered_map<std::string, int> color;   // 0 white, 1 gray, 2 black
        std::function<bool(const std::string&)> dfs = [&](const std::string& u) -> bool {
            color[u] = 1;
            for (const auto& v : outgoing[u])
            {
                const int c = color[v];
                if (c == 1) return true;                  // back-edge → cycle
                if (c == 0 && dfs(v)) return true;
            }
            color[u] = 2;
            return false;
        };
        for (const auto& [nodeId, node] : nodes)
            if (color[nodeId] == 0 && dfs(nodeId))
                return fail("cycle_detected");
    }

    // ── Active set = nodes on a path Track Input → Track Output ───────────
    auto bfs = [](const std::string& start,
                  const std::unordered_map<std::string, std::vector<std::string>>& adj) {
        std::unordered_set<std::string> seen;
        std::vector<std::string> stack{start};
        seen.insert(start);
        while (!stack.empty())
        {
            const std::string cur = stack.back();
            stack.pop_back();
            auto it = adj.find(cur);
            if (it == adj.end()) continue;
            for (const auto& nxt : it->second)
                if (seen.insert(nxt).second) stack.push_back(nxt);
        }
        return seen;
    };
    const auto reachableFromInput = bfs(trackInputId, outgoing);
    const auto canReachOutput     = bfs(trackOutputId, incoming);

    std::unordered_set<std::string> active;
    for (const auto& [nodeId, node] : nodes)
        if (reachableFromInput.count(nodeId) && canReachOutput.count(nodeId))
            active.insert(nodeId);

    // No complete Input → Output path: intentional silence (valid graph state).
    if (active.count(trackInputId) == 0 || active.count(trackOutputId) == 0)
    {
        graph_->clearConnectionsToSilence();
        nlohmann::json result = baseResult();
        result["ok"] = true;
        result["mode"] = "disconnected";
        result["reason"] = "graph_output_disconnected";
        return result;
    }

    // ── Validate active nodes + resolve effect mappings ──────────────────
    std::unordered_map<std::string, int> graphIdToEngineId;
    graphIdToEngineId[trackInputId]  = graph_->getInputNodeId();
    graphIdToEngineId[trackOutputId] = graph_->getOutputNodeId();
    nlohmann::json activeEffectInstanceIds = nlohmann::json::array();
    int effectCount = 0;

    for (const auto& graphNodeId : active)
    {
        const auto& node = nodes.at(graphNodeId);
        if (node.type == "trackInput" || node.type == "trackOutput") continue;
        if (node.type != "effect") return fail("unsupported_node_type");

        if (node.pluginId.empty() || node.pluginId == "placeholder" || node.missing)
            return fail("effect_not_active");
        if (node.effectInstanceId.empty()) return fail("missing_effect_instance_id");

        auto mapped = graphNodeIds_.find(node.effectInstanceId);
        if (mapped == graphNodeIds_.end() || mapped->second < 0)
            return fail("missing_effect_mapping");

        graphIdToEngineId[graphNodeId] = mapped->second;
        activeEffectInstanceIds.push_back(node.effectInstanceId);
        ++effectCount;
    }

    // ── Build engine edges (active subgraph only) + detect parallelism ────
    std::vector<std::pair<int, int>> engineEdges;
    std::unordered_map<std::string, int> activeOutDeg;
    std::unordered_map<std::string, int> activeInDeg;
    for (const auto& [src, dst] : audioEdges)
    {
        if (active.count(src) == 0 || active.count(dst) == 0) continue;
        engineEdges.emplace_back(graphIdToEngineId.at(src), graphIdToEngineId.at(dst));
        ++activeOutDeg[src];
        ++activeInDeg[dst];
    }

    bool parallel = false;
    for (const auto& [id, deg] : activeOutDeg) if (deg > 1) parallel = true;
    for (const auto& [id, deg] : activeInDeg)  if (deg > 1) parallel = true;

    if (!graph_->replaceConnectionsWithGraph(engineEdges))
        return fail("apply_failed");

    // ── Ordered effect list for the linear/passthrough case ──────────────
    nlohmann::json pathEffectInstanceIds = nlohmann::json::array();
    if (!parallel)
    {
        std::string cursor = trackInputId;
        std::unordered_set<std::string> walked{cursor};
        while (cursor != trackOutputId)
        {
            const std::string* nextActive = nullptr;
            for (const auto& nxt : outgoing[cursor])
                if (active.count(nxt)) { nextActive = &nxt; break; }
            if (!nextActive) break;
            cursor = *nextActive;
            if (!walked.insert(cursor).second) break;
            const auto& node = nodes.at(cursor);
            if (node.type == "effect") pathEffectInstanceIds.push_back(node.effectInstanceId);
        }
    }

    nlohmann::json result = baseResult();
    result["ok"] = true;
    result["mode"] = (effectCount == 0) ? "passthrough" : (parallel ? "parallel" : "linear");
    result["reason"] = parallel ? "parallel_graph_routing_active" : "graph_routing_active";
    result["pathEffectCount"] = effectCount;
    result["appliedConnectionCount"] = static_cast<int>(engineEdges.size());
    result["activeEffectInstanceIds"] = activeEffectInstanceIds;
    if (!parallel) result["pathEffectInstanceIds"] = pathEffectInstanceIds;
    return result;
}

nlohmann::json EffectChainManager::syncLinearGraphTopology(const nlohmann::json& topology)
{
    return syncGraphTopology(topology);
}

nlohmann::json EffectChainManager::adoptGraphNodes(const nlohmann::json& mapping)
{
    nlohmann::json result = {
        {"ok", true},
        {"adopted", nlohmann::json::object()},
        {"skipped", nlohmann::json::array()},
    };

    if (!graph_)
    {
        result["ok"] = false;
        result["reason"] = "engine_unavailable";
        return result;
    }
    if (!mapping.is_array())
    {
        result["ok"] = false;
        result["reason"] = "invalid_mapping";
        return result;
    }

    for (const auto& entry : mapping)
    {
        if (!entry.is_object())
        {
            result["skipped"].push_back({{"reason", "invalid_entry"}});
            continue;
        }

        const std::string effectInstanceId =
            entry.contains("effectInstanceId") && entry["effectInstanceId"].is_string()
                ? entry["effectInstanceId"].get<std::string>()
                : std::string{};
        const int engineNodeId =
            entry.contains("engineNodeId") && entry["engineNodeId"].is_number_integer()
                ? entry["engineNodeId"].get<int>()
                : -1;

        if (effectInstanceId.empty() || engineNodeId < 0)
        {
            result["skipped"].push_back({{"reason", "invalid_entry"},
                                         {"effectInstanceId", effectInstanceId}});
            continue;
        }
        if (!graph_->hasNode(engineNodeId))
        {
            result["skipped"].push_back({{"reason", "unknown_engine_node"},
                                         {"effectInstanceId", effectInstanceId}});
            continue;
        }

        // Idempotent: register (or re-register) the existing processor as
        // graph-owned. Never creates or destroys a processor, so the chain
        // effect's parameter state is preserved.
        graphNodeIds_[effectInstanceId] = engineNodeId;
        result["adopted"][effectInstanceId] = engineNodeId;
    }

    return result;
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

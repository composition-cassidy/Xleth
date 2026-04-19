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

// ─── Effect parameter / meter access ────────────────────────────────────────

std::string EffectChainManager::getEffectParameters(int nodeId) const
{
    return graph_->getEffectParameters(nodeId);
}

bool EffectChainManager::setEffectParameter(int nodeId, const std::string& paramId, float value)
{
    return graph_->setEffectParameter(nodeId, paramId, value);
}

std::string EffectChainManager::getEffectMeter(int nodeId) const
{
    return graph_->getEffectMeter(nodeId);
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
    return graph_->toJSON();
}

bool EffectChainManager::graphFromJSON(const nlohmann::json& j)
{
    return graph_->fromJSON(j);
}

// ─── Audio thread ───────────────────────────────────────────────────────────

void EffectChainManager::processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                                      juce::MidiBuffer& midi)
{
    graph_->processBlock(buffer, numSamples, midi);
}

double EffectChainManager::getMaxTailLengthSeconds() const
{
    return graph_ ? graph_->getMaxTailLengthSeconds() : 0.0;
}

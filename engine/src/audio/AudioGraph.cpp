#include "audio/AudioGraph.h"
#include "audio/PluginRegistry.h"
#include "audio/XlethEffectBase.h"
#include "audio/TestGainEffect.h"
#include "audio/XlethCompressorEffect.h"
#include "audio/XlethLimiterEffect.h"
#include "audio/XlethOTTEffect.h"
#include "audio/XlethTransientProcEffect.h"
#include "audio/XlethEQEffect.h"
#include "audio/XlethFilterEffect.h"
#include "audio/DistortionEffect.h"
#include "audio/XlethDistortionEffect.h"
#include "audio/XlethWaveshaperEffect.h"
#include "audio/UniFlangeEffect.h"
#include "audio/ChorusEffect.h"
#include "audio/FlangerEffect.h"
#include "audio/XlethFlangerEffect.h"
#include "audio/PhaserEffect.h"
#include "audio/XlethPhaserEffect.h"
#include "audio/PhanjerEffect.h"
#include "audio/XlethDelayEffect.h"
#include "audio/XlethReverbEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"
#include "audio/SmartBalanceEffect.h"
#include "audio/WireGainProcessor.h"
#include "audio/DelayCompensationProcessor.h"
#include "audio/GuardedPluginWrapper.h"
#include "audio/PluginCrashGuard.h"

#include <algorithm>
#include <cstdio>
#include <queue>
#include <stack>

// ─── PassthroughProcessor ───────────────────────────────────────────────────
//
// Lightweight stand-in used when a VST3 plugin cannot be loaded at project open.
// Audio passes through unchanged (stereo in → stereo out).
// Stores the original PluginDescription and state blob so tryResolvePlugin can
// swap in the real plugin once it becomes available.

class PassthroughProcessor : public juce::AudioProcessor
{
public:
    PassthroughProcessor(const juce::String&          originalName,
                         const juce::PluginDescription& desc,
                         const juce::MemoryBlock&       storedState)
        : juce::AudioProcessor(
              BusesProperties()
                  .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
                  .withOutput("Output", juce::AudioChannelSet::stereo(), true))
        , displayName_("[Missing: " + originalName + "]")
        , storedDescription_(desc)
        , storedState_(storedState)
    {}

    const juce::String getName() const override { return displayName_; }

    void prepareToPlay(double, int) override {}
    void releaseResources() override {}

    void processBlock(juce::AudioBuffer<float>& buffer,
                      juce::MidiBuffer&) override
    {
        // Copy input channels to output channels; zero any extra outputs.
        const int nIn  = getTotalNumInputChannels();
        const int nOut = getTotalNumOutputChannels();
        const int nMin = juce::jmin(nIn, nOut);
        const int nSamples = buffer.getNumSamples();

        for (int ch = nMin; ch < nOut; ++ch)
            buffer.clear(ch, 0, nSamples);
        // channels 0..nMin-1 are already in place (input == output buffer)
        (void)nIn;
    }

    bool  isMidiEffect()             const override { return false; }
    double getTailLengthSeconds()    const override { return 0.0;   }
    bool  acceptsMidi()              const override { return false; }
    bool  producesMidi()             const override { return false; }
    bool  hasEditor()                const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    int getNumPrograms()                               override { return 1;  }
    int getCurrentProgram()                            override { return 0;  }
    void setCurrentProgram(int)                        override {}
    const juce::String getProgramName(int)             override { return {}; }
    void changeProgramName(int, const juce::String&)   override {}

    // getStateInformation returns empty — the real state is in storedState_.
    void getStateInformation(juce::MemoryBlock&)           override {}
    void setStateInformation(const void*, int)             override {}

    // ── Accessor for tryResolvePlugin ────────────────────────────────────
    const juce::PluginDescription& getStoredDescription() const { return storedDescription_; }
    const juce::MemoryBlock&       getStoredState()        const { return storedState_;       }

private:
    juce::String            displayName_;
    juce::PluginDescription storedDescription_;
    juce::MemoryBlock       storedState_;
};

// ─── Lifecycle ──────────────────────────────────────────────────────────────

AudioGraph::AudioGraph()  = default;

AudioGraph::~AudioGraph()
{
    stopTimer();
    destroy();
}

void AudioGraph::init(double sampleRate, int blockSize)
{
    if (graph_) return;

    sampleRate_ = sampleRate;
    blockSize_  = blockSize;

    graph_ = std::make_unique<juce::AudioProcessorGraph>();
    graph_->setPlayConfigDetails(2, 2, sampleRate_, blockSize_);
    graph_->prepareToPlay(sampleRate_, blockSize_);

    using IOProc = juce::AudioProcessorGraph::AudioGraphIOProcessor;

    auto* inNode  = graph_->addNode(std::make_unique<IOProc>(IOProc::audioInputNode)).get();
    auto* outNode = graph_->addNode(std::make_unique<IOProc>(IOProc::audioOutputNode)).get();

    inputNode_  = inNode->nodeID;
    outputNode_ = outNode->nodeID;

    // Direct input → output (empty graph)
    rebuildAPGConnections();
}

void AudioGraph::destroy()
{
    stopTimer();
    pendingRebuild_.store(false);
    outputLatencySamples_ = 0;
    latencyEpoch_.store(0, std::memory_order_release);
    nodes_.clear();
    connections_.clear();
    adjForward_.clear();
    adjReverse_.clear();
    linearOrder_.clear();
    vstDescriptions_.clear();
    missingNodes_.clear();
    graph_.reset();
    inputNode_  = {};
    outputNode_ = {};
}

void AudioGraph::reprepare(double sampleRate, int blockSize)
{
    if (!graph_) return;
    sampleRate_ = sampleRate;
    blockSize_  = blockSize;
    graph_->releaseResources();
    graph_->setPlayConfigDetails(2, 2, sampleRate_, blockSize_);
    graph_->prepareToPlay(sampleRate_, blockSize_);
    computePDC();
}

// ─── Node management ────────────────────────────────────────────────────────

int AudioGraph::addProcessorToGraph(const std::string& pluginId,
                                     std::unique_ptr<juce::AudioProcessor> proc)
{
    if (!graph_ || !proc) return -1;
    if (static_cast<int>(nodes_.size()) >= kMaxNodes) return -1;

    proc->setPlayConfigDetails(2, 2, sampleRate_, blockSize_);
    auto nodePtr = graph_->addNode(std::move(proc));
    if (!nodePtr) return -1;

    const int uid = static_cast<int>(nodePtr->nodeID.uid);
    if (auto* stockEffect = dynamic_cast<XlethEffectBase*>(nodePtr->getProcessor()))
        stockEffect->setHostNodeId(uid);
    if (auto* guarded = dynamic_cast<GuardedPluginWrapper*>(nodePtr->getProcessor()))
        guarded->setHostNodeId(uid);

    GraphNode gn;
    gn.apgNodeId = nodePtr->nodeID;
    gn.pluginId  = pluginId;
    nodes_[uid]  = std::move(gn);

    adjForward_[uid];
    adjReverse_[uid];
    return uid;
}

int AudioGraph::addNode(const std::string& pluginId)
{
    if (!graph_) return -1;
    if (static_cast<int>(nodes_.size()) >= kMaxNodes) return -1;

    auto effect = createEffect(pluginId);
    if (!effect) return -1;

    const int uid = addProcessorToGraph(pluginId, std::move(effect));
    if (uid < 0) return -1;

    // If this is a VST node (not a stock effect), store its PluginDescription
    // so toJSON can persist it for round-trip serialization.
    if (pluginRegistry_) {
        const auto desc = pluginRegistry_->findPluginByIdentifier(juce::String(pluginId));
        if (!desc.name.isEmpty())
            vstDescriptions_[uid] = desc;
    }

    return uid;
}

bool AudioGraph::removeNode(int nodeId)
{
    if (!graph_) return false;
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return false;

    // Remove all connections involving this node
    std::vector<WireId> toRemove;
    for (const auto& [wid, conn] : connections_)
    {
        if (wid.sourceNodeId == nodeId || wid.destNodeId == nodeId)
            toRemove.push_back(wid);
    }
    for (const auto& wid : toRemove)
    {
        // Remove any helper nodes from APG
        auto cit = connections_.find(wid);
        if (cit != connections_.end())
        {
            if (cit->second.wire.gainNodeId.uid != 0)
                graph_->removeNode(cit->second.wire.gainNodeId);
            if (cit->second.wire.delayNodeId.uid != 0)
                graph_->removeNode(cit->second.wire.delayNodeId);
        }
        removeAdj(wid.sourceNodeId, wid.destNodeId);
        connections_.erase(wid);
    }

    // Remove the node itself from APG
#ifdef XLETH_DEBUG
    {
        auto vit = vstDescriptions_.find(nodeId);
        if (vit != vstDescriptions_.end())
            std::fprintf(stderr, "[PluginHost] Unloaded: \"%s\" node %d\n",
                         vit->second.name.toRawUTF8(), nodeId);
    }
#endif
    graph_->removeNode(it->second.apgNodeId);
    nodes_.erase(it);
    adjForward_.erase(nodeId);
    adjReverse_.erase(nodeId);
    vstDescriptions_.erase(nodeId);
    missingNodes_.erase(nodeId);

    updateLinearOrder();
    return true;
}

void AudioGraph::setNodePosition(int nodeId, float x, float y)
{
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return;
    it->second.x = x;
    it->second.y = y;
}

bool AudioGraph::setBypass(int nodeId, bool bypassed)
{
    if (!graph_) return false;
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return false;

    auto* node = graph_->getNodeForId(it->second.apgNodeId);
    if (!node) return false;

    auto* effect = dynamic_cast<XlethEffectBase*>(node->getProcessor());
    if (!effect)
    {
        auto* guarded = dynamic_cast<GuardedPluginWrapper*>(node->getProcessor());
        if (guarded == nullptr)
            return false;

        const auto publishCountBefore = guarded->getLatencyChangePublishCount();
        if (!guarded->setWrappedBypass(bypassed))
            return false;
        if (guarded->refreshReportedLatency()
            || guarded->getLatencyChangePublishCount() != publishCountBefore)
            rebuildImmediate();
        return true;
    }

    const int beforeLatency = effect->getLatencySamples();
    effect->setBypassed(bypassed);
    const int afterLatency = effect->getLatencySamples();
    if (afterLatency != beforeLatency)
        rebuildImmediate();
    return true;
}

// ─── Connection management ──────────────────────────────────────────────────

bool AudioGraph::addConnection(int sourceNodeId, int destNodeId)
{
    if (!graph_) return false;

    // Validate nodes exist (I/O nodes or effect nodes)
    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);
    const bool srcValid = (sourceNodeId == inUid) || nodes_.count(sourceNodeId);
    const bool dstValid = (destNodeId == outUid)  || nodes_.count(destNodeId);
    if (!srcValid || !dstValid) return false;

    // No self-loops
    if (sourceNodeId == destNodeId) return false;

    // No duplicates
    WireId wid{sourceNodeId, destNodeId};
    if (connections_.count(wid)) return false;

    // Cycle check
    if (wouldCreateCycle(sourceNodeId, destNodeId)) return false;

    // Add to topology
    GraphConnection gc;
    gc.sourceNodeId = sourceNodeId;
    gc.destNodeId   = destNodeId;
    connections_[wid] = gc;
    addAdj(sourceNodeId, destNodeId);

    updateLinearOrder();
    markDirty();
    return true;
}

bool AudioGraph::removeConnection(int sourceNodeId, int destNodeId)
{
    WireId wid{sourceNodeId, destNodeId};
    auto it = connections_.find(wid);
    if (it == connections_.end()) return false;

    // Remove helper nodes from APG
    if (it->second.wire.gainNodeId.uid != 0)
        graph_->removeNode(it->second.wire.gainNodeId);
    if (it->second.wire.delayNodeId.uid != 0)
        graph_->removeNode(it->second.wire.delayNodeId);

    connections_.erase(it);
    removeAdj(sourceNodeId, destNodeId);

    updateLinearOrder();
    markDirty();
    return true;
}

// ─── Wire properties ────────────────────────────────────────────────────────

bool AudioGraph::setWireGain(int sourceNodeId, int destNodeId, float gain)
{
    WireId wid{sourceNodeId, destNodeId};
    auto it = connections_.find(wid);
    if (it == connections_.end()) return false;

    gain = std::clamp(gain, 0.0f, 2.0f);
    it->second.wire.gain = gain;

    // If a WireGainProcessor exists, update it directly (no rebuild needed)
    if (it->second.wire.gainNodeId.uid != 0)
    {
        auto* node = graph_->getNodeForId(it->second.wire.gainNodeId);
        if (node)
        {
            auto* proc = dynamic_cast<WireGainProcessor*>(node->getProcessor());
            if (proc)
                proc->setTargetGain(gain);
        }
        // If gain returned to unity and not muted, schedule rebuild to remove node
        if (gain == 1.0f && !it->second.wire.muted)
            markDirty();
        return true;
    }

    // No gain node exists — need one if gain != 1.0
    if (gain != 1.0f)
        markDirty();

    return true;
}

bool AudioGraph::setWireMute(int sourceNodeId, int destNodeId, bool muted)
{
    WireId wid{sourceNodeId, destNodeId};
    auto it = connections_.find(wid);
    if (it == connections_.end()) return false;

    it->second.wire.muted = muted;

    // If a WireGainProcessor exists, update it directly
    if (it->second.wire.gainNodeId.uid != 0)
    {
        auto* node = graph_->getNodeForId(it->second.wire.gainNodeId);
        if (node)
        {
            auto* proc = dynamic_cast<WireGainProcessor*>(node->getProcessor());
            if (proc)
                proc->setMuted(muted);
        }
        // If unmuted and at unity, schedule rebuild to remove node
        if (!muted && it->second.wire.gain == 1.0f)
            markDirty();
        return true;
    }

    // No gain node — need one if muting
    if (muted)
        markDirty();

    return true;
}

// ─── Chain-mode compatibility ───────────────────────────────────────────────

int AudioGraph::addEffect(const std::string& pluginId, int position)
{
    const int uid = addNode(pluginId);
    if (uid < 0) return -1;

    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    // If chain is empty, wire: input → node → output
    if (linearOrder_.empty())
    {
        GraphConnection gc1;
        gc1.sourceNodeId = inUid;
        gc1.destNodeId   = uid;
        connections_[{inUid, uid}] = gc1;
        addAdj(inUid, uid);

        GraphConnection gc2;
        gc2.sourceNodeId = uid;
        gc2.destNodeId   = outUid;
        connections_[{uid, outUid}] = gc2;
        addAdj(uid, outUid);
    }
    else
    {
        const int pos = std::clamp(position, 0, static_cast<int>(linearOrder_.size()));

        // Determine predecessor and successor in the chain
        const int pred = (pos == 0)
                       ? inUid
                       : linearOrder_[static_cast<size_t>(pos - 1)];
        const int succ = (pos == static_cast<int>(linearOrder_.size()))
                       ? outUid
                       : linearOrder_[static_cast<size_t>(pos)];

        // Remove old pred → succ connection
        WireId oldWid{pred, succ};
        auto cit = connections_.find(oldWid);
        if (cit != connections_.end())
        {
            if (cit->second.wire.gainNodeId.uid != 0)
                graph_->removeNode(cit->second.wire.gainNodeId);
            if (cit->second.wire.delayNodeId.uid != 0)
                graph_->removeNode(cit->second.wire.delayNodeId);
            connections_.erase(cit);
            removeAdj(pred, succ);
        }

        // Insert pred → uid → succ
        GraphConnection gc1;
        gc1.sourceNodeId = pred;
        gc1.destNodeId   = uid;
        connections_[{pred, uid}] = gc1;
        addAdj(pred, uid);

        GraphConnection gc2;
        gc2.sourceNodeId = uid;
        gc2.destNodeId   = succ;
        connections_[{uid, succ}] = gc2;
        addAdj(uid, succ);
    }

    updateLinearOrder();
    rebuildImmediate();
    return uid;
}

int AudioGraph::addProcessorForTesting(const std::string& pluginId,
                                       std::unique_ptr<juce::AudioProcessor> proc,
                                       int position)
{
    const int uid = addProcessorToGraph(pluginId, std::move(proc));
    if (uid < 0) return -1;

    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    if (linearOrder_.empty())
    {
        GraphConnection gc1;
        gc1.sourceNodeId = inUid;
        gc1.destNodeId   = uid;
        connections_[{inUid, uid}] = gc1;
        addAdj(inUid, uid);

        GraphConnection gc2;
        gc2.sourceNodeId = uid;
        gc2.destNodeId   = outUid;
        connections_[{uid, outUid}] = gc2;
        addAdj(uid, outUid);
    }
    else
    {
        const int pos = std::clamp(position, 0, static_cast<int>(linearOrder_.size()));
        const int pred = (pos == 0)
                       ? inUid
                       : linearOrder_[static_cast<size_t>(pos - 1)];
        const int succ = (pos == static_cast<int>(linearOrder_.size()))
                       ? outUid
                       : linearOrder_[static_cast<size_t>(pos)];

        WireId oldWid{pred, succ};
        auto cit = connections_.find(oldWid);
        if (cit != connections_.end())
        {
            if (cit->second.wire.gainNodeId.uid != 0)
                graph_->removeNode(cit->second.wire.gainNodeId);
            if (cit->second.wire.delayNodeId.uid != 0)
                graph_->removeNode(cit->second.wire.delayNodeId);
            connections_.erase(cit);
            removeAdj(pred, succ);
        }

        GraphConnection gc1;
        gc1.sourceNodeId = pred;
        gc1.destNodeId   = uid;
        connections_[{pred, uid}] = gc1;
        addAdj(pred, uid);

        GraphConnection gc2;
        gc2.sourceNodeId = uid;
        gc2.destNodeId   = succ;
        connections_[{uid, succ}] = gc2;
        addAdj(uid, succ);
    }

    updateLinearOrder();
    rebuildImmediate();
    return uid;
}

bool AudioGraph::removeEffect(int nodeId)
{
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return false;

    // Find predecessor(s) and successor(s)
    auto& preds = adjReverse_[nodeId];
    auto& succs = adjForward_[nodeId];

    // For chain-mode: reconnect pred → succ to close the gap
    if (preds.size() == 1 && succs.size() == 1)
    {
        const int pred = preds[0];
        const int succ = succs[0];

        // Remove pred→node and node→succ connections from map
        auto removeConn = [&](int src, int dst) {
            WireId wid{src, dst};
            auto cit = connections_.find(wid);
            if (cit != connections_.end())
            {
                if (cit->second.wire.gainNodeId.uid != 0)
                    graph_->removeNode(cit->second.wire.gainNodeId);
                if (cit->second.wire.delayNodeId.uid != 0)
                    graph_->removeNode(cit->second.wire.delayNodeId);
                connections_.erase(cit);
                removeAdj(src, dst);
            }
        };
        removeConn(pred, nodeId);
        removeConn(nodeId, succ);

        // Reconnect pred → succ
        GraphConnection gc;
        gc.sourceNodeId = pred;
        gc.destNodeId   = succ;
        connections_[{pred, succ}] = gc;
        addAdj(pred, succ);
    }
    else
    {
        // Graph-mode: just remove all connections involving this node
        std::vector<WireId> toRemove;
        for (const auto& [wid, conn] : connections_)
        {
            if (wid.sourceNodeId == nodeId || wid.destNodeId == nodeId)
                toRemove.push_back(wid);
        }
        for (const auto& wid : toRemove)
        {
            auto cit = connections_.find(wid);
            if (cit != connections_.end())
            {
                if (cit->second.wire.gainNodeId.uid != 0)
                    graph_->removeNode(cit->second.wire.gainNodeId);
                if (cit->second.wire.delayNodeId.uid != 0)
                    graph_->removeNode(cit->second.wire.delayNodeId);
                connections_.erase(cit);
            }
            removeAdj(wid.sourceNodeId, wid.destNodeId);
        }
    }

    // Remove the node itself
    graph_->removeNode(it->second.apgNodeId);
    nodes_.erase(it);
    adjForward_.erase(nodeId);
    adjReverse_.erase(nodeId);

    updateLinearOrder();
    rebuildImmediate();
    return true;
}

bool AudioGraph::moveEffect(int nodeId, int newPosition)
{
    if (!graph_) return false;
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return false;
    if (!isGraphLinear()) return false;  // only works in chain mode

    // Find current position in linearOrder_
    auto posIt = std::find(linearOrder_.begin(), linearOrder_.end(), nodeId);
    if (posIt == linearOrder_.end()) return false;

    const int oldPos = static_cast<int>(posIt - linearOrder_.begin());
    const int clampedNew = std::clamp(newPosition, 0, static_cast<int>(linearOrder_.size()) - 1);
    if (oldPos == clampedNew) return true;  // no-op

    // Strategy: remove effect, then re-insert at new position.
    // Save pluginId, remove, re-add at position.
    // But that would change the nodeId. Instead, manipulate connections directly.

    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    auto getChainNodeAt = [&](int idx) -> int {
        if (idx < 0) return inUid;
        if (idx >= static_cast<int>(linearOrder_.size())) return outUid;
        return linearOrder_[static_cast<size_t>(idx)];
    };

    // Remove all existing connections
    for (const auto& [wid, conn] : connections_)
    {
        if (conn.wire.gainNodeId.uid != 0)
            graph_->removeNode(conn.wire.gainNodeId);
        if (conn.wire.delayNodeId.uid != 0)
            graph_->removeNode(conn.wire.delayNodeId);
    }
    connections_.clear();
    adjForward_.clear();
    adjReverse_.clear();

    // Ensure adjacency entries for I/O nodes
    adjForward_[inUid];
    adjReverse_[inUid];
    adjForward_[outUid];
    adjReverse_[outUid];
    for (auto& [uid, gn] : nodes_)
    {
        adjForward_[uid];
        adjReverse_[uid];
    }

    // Reorder linearOrder_
    linearOrder_.erase(posIt);
    const int insertPos = std::clamp(clampedNew, 0, static_cast<int>(linearOrder_.size()));
    linearOrder_.insert(linearOrder_.begin() + insertPos, nodeId);

    // Rebuild linear connections
    int prev = inUid;
    for (int uid : linearOrder_)
    {
        GraphConnection gc;
        gc.sourceNodeId = prev;
        gc.destNodeId   = uid;
        connections_[{prev, uid}] = gc;
        addAdj(prev, uid);
        prev = uid;
    }
    // Last → output
    {
        GraphConnection gc;
        gc.sourceNodeId = prev;
        gc.destNodeId   = outUid;
        connections_[{prev, outUid}] = gc;
        addAdj(prev, outUid);
    }

    rebuildImmediate();
    return true;
}

int AudioGraph::getEffectCount() const
{
    return static_cast<int>(nodes_.size());
}

// ─── Query ──────────────────────────────────────────────────────────────────

nlohmann::json AudioGraph::getChainState() const
{
    nlohmann::json arr = nlohmann::json::array();

    // Use linearOrder_ if available (chain mode), otherwise fall back to nodes_
    const auto& order = linearOrder_.empty()
        ? allNodeUids()  // not guaranteed ordered, but best effort
        : std::vector<int>(linearOrder_.begin(), linearOrder_.end());

    for (int i = 0; i < static_cast<int>(order.size()); ++i)
    {
        const int uid = order[static_cast<size_t>(i)];
        auto it = nodes_.find(uid);
        if (it == nodes_.end()) continue;

        nlohmann::json obj;
        obj["nodeId"]   = uid;
        obj["pluginId"] = it->second.pluginId;
        obj["position"] = i;
        obj["bypassed"] = false;
        obj["missing"]  = (missingNodes_.count(uid) > 0);
        obj["crashed"]  = false;

        if (graph_)
        {
            auto* node = graph_->getNodeForId(it->second.apgNodeId);
            if (node)
            {
                auto* proc = node->getProcessor();
                if (proc)
                {
                    auto* effect = dynamic_cast<XlethEffectBase*>(proc);
                    if (effect)
                    {
                        obj["bypassed"] = effect->isBypassed();
                    }
                    else if (auto* guarded = dynamic_cast<GuardedPluginWrapper*>(proc))
                    {
                        // VST3 via GuardedPluginWrapper: bypass via inner parameter,
                        // crashed flag reflects whether SEH fired in processBlock.
                        if (auto* bp = proc->getBypassParameter())
                            obj["bypassed"] = (bp->getValue() >= 0.5f);
                        obj["crashed"] = guarded->isCrashed();
                    }
                    else if (!dynamic_cast<PassthroughProcessor*>(proc))
                    {
                        // Unwrapped VST3 (shouldn't happen post-VST-07) — fall back.
                        if (auto* bp = proc->getBypassParameter())
                            obj["bypassed"] = (bp->getValue() >= 0.5f);
                    }
                }
            }
        }

        arr.push_back(obj);
    }
    return arr;
}

nlohmann::json AudioGraph::getGraphTopology() const
{
    nlohmann::json result;

    // Nodes
    nlohmann::json nodesArr = nlohmann::json::array();

    // I/O nodes
    {
        nlohmann::json io;
        io["nodeId"]   = static_cast<int>(inputNode_.uid);
        io["pluginId"] = "__input__";
        io["x"] = 0.0f;
        io["y"] = 0.0f;
        io["level"] = 0;
        io["cumulativeLatency"] = 0;
        io["bypassed"] = false;
        nodesArr.push_back(io);
    }
    {
        nlohmann::json io;
        io["nodeId"]   = static_cast<int>(outputNode_.uid);
        io["pluginId"] = "__output__";
        io["x"] = 0.0f;
        io["y"] = 0.0f;
        io["level"] = -1;  // will be filled if topo sort ran
        io["cumulativeLatency"] = outputLatencySamples_;
        io["bypassed"] = false;
        nodesArr.push_back(io);
    }

    for (const auto& [uid, gn] : nodes_)
    {
        nlohmann::json obj;
        obj["nodeId"]   = uid;
        obj["pluginId"] = gn.pluginId;
        obj["x"] = gn.x;
        obj["y"] = gn.y;
        obj["level"] = gn.level;
        obj["cumulativeLatency"] = gn.cumulativeLatency;
        obj["bypassed"] = false;

        if (graph_)
        {
            auto* node = graph_->getNodeForId(gn.apgNodeId);
            if (node)
            {
                auto* effect = dynamic_cast<XlethEffectBase*>(node->getProcessor());
                if (effect)
                    obj["bypassed"] = effect->isBypassed();
            }
        }

        nodesArr.push_back(obj);
    }
    result["nodes"] = nodesArr;

    // Connections
    nlohmann::json connsArr = nlohmann::json::array();
    for (const auto& [wid, conn] : connections_)
    {
        nlohmann::json obj;
        obj["source"] = wid.sourceNodeId;
        obj["dest"]   = wid.destNodeId;
        obj["gain"]   = conn.wire.gain;
        obj["muted"]  = conn.wire.muted;
        connsArr.push_back(obj);
    }
    result["connections"] = connsArr;

    result["isLinear"] = isGraphLinear();

    return result;
}

int AudioGraph::countActiveResonanceSuppressorHighQualityInstances() const
{
    if (!graph_)
        return 0;

    int count = 0;
    for (const auto& [uid, nodeInfo] : nodes_)
    {
        if (nodeInfo.pluginId != "resonancesuppressor")
            continue;
        if (missingNodes_.count(uid) > 0)
            continue;

        auto* node = graph_->getNodeForId(nodeInfo.apgNodeId);
        if (node == nullptr)
            continue;
        auto* effect = dynamic_cast<XlethEffectBase*>(node->getProcessor());
        if (effect == nullptr || effect->isBypassed())
            continue;
        if (effect->getParameterValue("processing_mode") >= 0.5f)
            ++count;
    }
    return count;
}

bool AudioGraph::isGraphLinear() const
{
    return !linearOrder_.empty() || nodes_.empty();
}

// ─── Serialization ──────────────────────────────────────────────────────────

nlohmann::json AudioGraph::toJSON() const
{
    nlohmann::json result;

    // Nodes
    nlohmann::json nodesArr = nlohmann::json::array();
    for (const auto& [uid, gn] : nodes_)
    {
        nlohmann::json obj;
        obj["nodeId"]   = uid;
        obj["pluginId"] = gn.pluginId;
        obj["x"] = gn.x;
        obj["y"] = gn.y;
        obj["bypassed"] = false;

        const bool isMissing = (missingNodes_.count(uid) > 0);

        if (isMissing)
        {
            // Missing node: persist original state and description from the
            // PassthroughProcessor so the next load can try again.
            obj["bypassed"] = false;
            obj["missing"]  = true;

            if (graph_)
            {
                auto* node = graph_->getNodeForId(gn.apgNodeId);
                if (node)
                {
                    auto* passthru = dynamic_cast<PassthroughProcessor*>(node->getProcessor());
                    if (passthru)
                    {
                        const auto& storedState = passthru->getStoredState();
                        if (storedState.getSize() > 0)
                            obj["state"] = juce::Base64::toBase64(
                                storedState.getData(), storedState.getSize()).toStdString();
                    }
                }
            }
        }
        else
        {
            // Plugin state as base64 — handles both stock XlethEffectBase and VST3.
            if (graph_)
            {
                auto* node = graph_->getNodeForId(gn.apgNodeId);
                if (node)
                {
                    auto* proc = node->getProcessor();
                    if (proc)
                    {
                        // Bypass: XlethEffectBase exposes isBypassed(); VST3 plugins
                        // use the standard bypass parameter (getBypassParameter).
                        auto* effect = dynamic_cast<XlethEffectBase*>(proc);
                        if (effect)
                        {
                            obj["bypassed"] = effect->isBypassed();
                        }
                        else
                        {
                            bool bypassed = false;
                            if (auto* bp = proc->getBypassParameter())
                                bypassed = (bp->getValue() >= 0.5f);
                            obj["bypassed"] = bypassed;
                        }

                        // getStateInformation is guarded via the wrapper for
                        // VST nodes; stock effects are trusted.  If a plugin
                        // crashes while saving state, we simply persist no state
                        // (the wrapper clears the MemoryBlock on fault).
                        juce::MemoryBlock mb;
                        proc->getStateInformation(mb);
                        if (mb.getSize() > 0)
                        {
                            obj["state"] = juce::Base64::toBase64(
                                mb.getData(), mb.getSize()).toStdString();
#ifdef XLETH_DEBUG
                            if (vstDescriptions_.count(uid))
                                std::fprintf(stderr,
                                             "[PluginHost] State saved: \"%s\" (%zu bytes)\n",
                                             proc->getName().toRawUTF8(), mb.getSize());
#endif
                        }
#ifdef XLETH_DEBUG
                        else if (auto* gw = dynamic_cast<GuardedPluginWrapper*>(proc))
                        {
                            if (gw->isCrashed())
                                std::fprintf(stderr,
                                             "[PluginHost] State save failed: \"%s\" — crashed\n",
                                             proc->getName().toRawUTF8());
                        }
#endif
                    }
                }
            }
        }

        // VST nodes (including missing placeholders): persist the PluginDescription
        // XML for round-trip fidelity and future resolution.
        {
            auto vit = vstDescriptions_.find(uid);
            if (vit != vstDescriptions_.end())
            {
                if (auto xmlElem = vit->second.createXml())
                    obj["pluginDescription"] = xmlElem->toString().toStdString();
            }
        }

        nodesArr.push_back(obj);
    }
    result["nodes"] = nodesArr;

    // Connections
    nlohmann::json connsArr = nlohmann::json::array();
    for (const auto& [wid, conn] : connections_)
    {
        nlohmann::json obj;
        obj["source"] = wid.sourceNodeId;
        obj["dest"]   = wid.destNodeId;
        obj["gain"]   = conn.wire.gain;
        obj["muted"]  = conn.wire.muted;
        connsArr.push_back(obj);
    }
    result["connections"] = connsArr;

    return result;
}

bool AudioGraph::fromJSON(const nlohmann::json& j)
{
    if (!graph_) return false;

    // Clear existing graph (keep I/O nodes)
    // Remove all effect nodes and connections
    {
        std::vector<int> nodeIds;
        for (const auto& [uid, gn] : nodes_)
            nodeIds.push_back(uid);
        for (int uid : nodeIds)
            removeNode(uid);
    }

    // Re-create nodes
    std::unordered_map<int, int> oldToNew;  // old serialized uid → new actual uid

    if (j.contains("nodes") && j["nodes"].is_array())
    {
        for (const auto& nodeObj : j["nodes"])
        {
            const int oldId = nodeObj.value("nodeId", -1);
            const std::string plugId = nodeObj.value("pluginId", "");
            if (oldId < 0 || plugId.empty()) continue;

            // Decode the stored state blob once (used on both success and failure paths).
            juce::MemoryBlock storedState;
            if (nodeObj.contains("state") && nodeObj["state"].is_string())
            {
                juce::MemoryOutputStream mos;
                if (juce::Base64::convertFromBase64(mos, juce::String(nodeObj["state"].get<std::string>())))
                    storedState.append(mos.getData(), mos.getDataSize());
            }

            int newId = -1;

            // ── VST node path ──────────────────────────────────────────────
            if (nodeObj.contains("pluginDescription") && nodeObj["pluginDescription"].is_string())
            {
                const auto xmlStr = juce::String(nodeObj["pluginDescription"].get<std::string>());
                auto xmlElem = juce::XmlDocument::parse(xmlStr);

                juce::PluginDescription desc;
                const bool descOk = (xmlElem != nullptr && desc.loadFromXml(*xmlElem));

                bool instantiated = false;
                if (descOk && pluginRegistry_)
                {
                    juce::String errorMsg;
                    std::unique_ptr<juce::AudioPluginInstance> instance;
                    auto& fmtMgr = pluginRegistry_->getFormatManager();
                    const auto sr = sampleRate_;
                    const auto bs = blockSize_;
#ifdef XLETH_DEBUG
                    std::fprintf(stderr, "[PluginHost] Loading: \"%s\"\n",
                                 desc.name.toRawUTF8());
#endif
                    const bool createOk = xleth::pluginGuardCall([&]
                    {
                        instance = fmtMgr.createPluginInstance(desc, sr, bs, errorMsg);
                    });
                    if (!createOk)
                    {
#ifdef XLETH_DEBUG
                        std::fprintf(stderr,
                                     "[PluginHost] CRASH: \"%s\" during createPluginInstance (fromJSON)\n",
                                     desc.name.toRawUTF8());
#endif
                    }
                    else if (instance)
                    {
                        auto wrapped = std::make_unique<GuardedPluginWrapper>(std::move(instance));
                        newId = addProcessorToGraph(plugId, std::move(wrapped));
                        if (newId >= 0)
                        {
                            vstDescriptions_[newId] = desc;
                            // Restore state on the live plugin instance.  The wrapper's
                            // setStateInformation is self-guarded — a crash there will
                            // mark the node crashed and skip state restore.
                            if (storedState.getSize() > 0)
                            {
                                auto* apgNode = graph_->getNodeForId(nodes_[newId].apgNodeId);
                                if (apgNode)
                                {
                                    apgNode->getProcessor()->setStateInformation(
                                        storedState.getData(), static_cast<int>(storedState.getSize()));
#ifdef XLETH_DEBUG
                                    auto* gw = dynamic_cast<GuardedPluginWrapper*>(apgNode->getProcessor());
                                    if (gw && gw->isCrashed())
                                        std::fprintf(stderr,
                                                     "[PluginHost] State restore failed: \"%s\" — crashed\n",
                                                     desc.name.toRawUTF8());
                                    else
                                        std::fprintf(stderr,
                                                     "[PluginHost] State restored: \"%s\" (%zu bytes)\n",
                                                     desc.name.toRawUTF8(), storedState.getSize());
#endif
                                }
                            }
#ifdef XLETH_DEBUG
                            {
                                auto* apgNode2 = graph_->getNodeForId(nodes_[newId].apgNodeId);
                                if (apgNode2)
                                    std::fprintf(stderr,
                                                 "[PluginHost] Loaded: \"%s\" (latency: %d samples,"
                                                 " channels: 2->2)\n",
                                                 desc.name.toRawUTF8(),
                                                 apgNode2->getProcessor()->getLatencySamples());
                            }
#endif
                            instantiated = true;
                        }
                    }
                    else
                    {
#ifdef XLETH_DEBUG
                        std::fprintf(stderr, "[PluginHost] Load failed: \"%s\" — %s\n",
                                     desc.name.toRawUTF8(),
                                     errorMsg.isEmpty() ? "no instance returned"
                                                        : errorMsg.toRawUTF8());
#endif
                    }
                }

                if (!instantiated)
                {
                    // Plugin unavailable — insert a passthrough placeholder.
                    const juce::String origName = descOk ? desc.name : juce::String(plugId);
#ifdef XLETH_DEBUG
                    std::fprintf(stderr,
                                 "[PluginHost] Missing on load: \"%s\" by %s — placeholder created\n",
                                 origName.toRawUTF8(),
                                 descOk ? desc.manufacturerName.toRawUTF8() : "");
#endif
                    auto passthru = std::make_unique<PassthroughProcessor>(origName, desc, storedState);
                    newId = addProcessorToGraph(plugId, std::move(passthru));
                    if (newId >= 0)
                    {
                        if (descOk)
                            vstDescriptions_[newId] = desc;
                        missingNodes_.insert(newId);
                    }
                }
            }
            else
            {
                // ── Stock effect path ──────────────────────────────────────
                newId = addNode(plugId);
                if (newId >= 0 && storedState.getSize() > 0)
                {
                    auto* apgNode = graph_->getNodeForId(nodes_[newId].apgNodeId);
                    if (apgNode)
                        apgNode->getProcessor()->setStateInformation(
                            storedState.getData(), static_cast<int>(storedState.getSize()));
                }
            }

            if (newId < 0) continue;
            oldToNew[oldId] = newId;

            // Restore position
            if (nodeObj.contains("x") && nodeObj.contains("y"))
                setNodePosition(newId, nodeObj["x"].get<float>(), nodeObj["y"].get<float>());

            // Restore bypass (passthrough ignores it, stock + VST honour it)
            if (nodeObj.value("bypassed", false))
                setBypass(newId, true);
        }
    }

    // Re-create connections
    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    if (j.contains("connections") && j["connections"].is_array())
    {
        for (const auto& connObj : j["connections"])
        {
            int src = connObj.value("source", -1);
            int dst = connObj.value("dest", -1);
            if (src < 0 || dst < 0) continue;

            // Remap node IDs (I/O nodes keep their IDs conceptually as 0/1
            // but the actual APG UIDs may differ, so we use a convention:
            // serialized source/dest that don't appear in oldToNew are I/O nodes)
            auto mapId = [&](int id) -> int {
                auto mit = oldToNew.find(id);
                if (mit != oldToNew.end()) return mit->second;
                // Heuristic: if this id was the input or output in the saved graph,
                // map to current I/O. We check if it matches any saved node — if not,
                // we guess based on connection direction.
                return -1;  // unknown
            };

            int mappedSrc = mapId(src);
            int mappedDst = mapId(dst);

            // If source is unknown and this is a source-only node, it's the input
            if (mappedSrc < 0)
            {
                // Check if src was used as a dest anywhere — if not, it's input
                bool srcIsDest = false;
                for (const auto& c2 : j["connections"])
                {
                    if (c2.value("dest", -1) == src) { srcIsDest = true; break; }
                }
                if (!srcIsDest) mappedSrc = inUid;
            }
            // If dest is unknown and this is a dest-only node, it's the output
            if (mappedDst < 0)
            {
                bool dstIsSource = false;
                for (const auto& c2 : j["connections"])
                {
                    if (c2.value("source", -1) == dst) { dstIsSource = true; break; }
                }
                if (!dstIsSource) mappedDst = outUid;
            }

            if (mappedSrc < 0 || mappedDst < 0) continue;

            // Use the internal path (bypass debounce for bulk load)
            WireId wid{mappedSrc, mappedDst};
            if (connections_.count(wid)) continue;
            if (wouldCreateCycle(mappedSrc, mappedDst)) continue;

            GraphConnection gc;
            gc.sourceNodeId = mappedSrc;
            gc.destNodeId   = mappedDst;
            gc.wire.gain    = connObj.value("gain", 1.0f);
            gc.wire.muted   = connObj.value("muted", false);
            connections_[wid] = gc;
            addAdj(mappedSrc, mappedDst);
        }
    }

    updateLinearOrder();
    rebuildImmediate();
    return true;
}

// ─── Missing-plugin support ──────────────────────────────────────────────────

bool AudioGraph::isNodeMissing(int nodeId) const
{
    return missingNodes_.count(nodeId) > 0;
}

bool AudioGraph::tryResolvePlugin(int nodeId, PluginRegistry& registry)
{
    if (!graph_) return false;
    if (missingNodes_.count(nodeId) == 0) return false;

    auto nit = nodes_.find(nodeId);
    if (nit == nodes_.end()) return false;

    // Extract stored data from the PassthroughProcessor before removing the node.
    auto* apgNode = graph_->getNodeForId(nit->second.apgNodeId);
    if (!apgNode) return false;

    auto* passthru = dynamic_cast<PassthroughProcessor*>(apgNode->getProcessor());
    if (!passthru) return false;

    const juce::PluginDescription desc         = passthru->getStoredDescription();
    const juce::MemoryBlock       storedState  = passthru->getStoredState();
    const std::string             pluginId     = nit->second.pluginId;
    const float                   savedX       = nit->second.x;
    const float                   savedY       = nit->second.y;

    // Try to instantiate the real plugin.  createPluginInstance is guarded:
    // a faulty plugin DLL must not take down the host while the user is merely
    // attempting resolution.
    juce::String errorMsg;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    auto& fmtMgr = registry.getFormatManager();
    const auto sr = sampleRate_;
    const auto bs = blockSize_;
    const bool createOk = xleth::pluginGuardCall([&]
    {
        instance = fmtMgr.createPluginInstance(desc, sr, bs, errorMsg);
    });
    if (!createOk)
    {
        std::fprintf(stderr,
                     "[PluginHost] CRASH: \"%s\" during createPluginInstance (retry) — placeholder kept\n",
                     desc.name.toRawUTF8());
        return false;
    }
    if (!instance) return false;
    auto wrapped = std::make_unique<GuardedPluginWrapper>(std::move(instance));

    // Save connections before removing old node.
    std::vector<int> inNeighbors(adjReverse_[nodeId]);
    std::vector<int> outNeighbors(adjForward_[nodeId]);

    struct SavedWire { int src; int dst; WireProperties props; };
    std::vector<SavedWire> savedWires;
    for (int src : inNeighbors)
    {
        WireId wid{src, nodeId};
        auto wit = connections_.find(wid);
        if (wit != connections_.end())
            savedWires.push_back({src, nodeId, wit->second.wire});
    }
    for (int dst : outNeighbors)
    {
        WireId wid{nodeId, dst};
        auto wit = connections_.find(wid);
        if (wit != connections_.end())
            savedWires.push_back({nodeId, dst, wit->second.wire});
    }

    // Find position in linear chain (for chain-mode round-trip).
    int chainPos = 0;
    for (int i = 0; i < static_cast<int>(linearOrder_.size()); ++i)
        if (linearOrder_[i] == nodeId) { chainPos = i; break; }

    // Remove the placeholder.
    removeNode(nodeId);  // also erases missingNodes_[nodeId]

    // Add the real plugin (wrapped for crash containment).
    const int newId = addProcessorToGraph(pluginId, std::move(wrapped));
    if (newId < 0) return false;

    vstDescriptions_[newId] = desc;
    setNodePosition(newId, savedX, savedY);

    // Restore state.
    if (storedState.getSize() > 0)
    {
        auto* newApgNode = graph_->getNodeForId(nodes_[newId].apgNodeId);
        if (newApgNode)
            newApgNode->getProcessor()->setStateInformation(
                storedState.getData(), static_cast<int>(storedState.getSize()));
    }

    // Restore connections (remap old nodeId → newId).
    for (auto& sw : savedWires)
    {
        const int mappedSrc = (sw.src == nodeId) ? newId : sw.src;
        const int mappedDst = (sw.dst == nodeId) ? newId : sw.dst;
        WireId wid{mappedSrc, mappedDst};
        if (connections_.count(wid) || wouldCreateCycle(mappedSrc, mappedDst)) continue;
        GraphConnection gc;
        gc.sourceNodeId = mappedSrc;
        gc.destNodeId   = mappedDst;
        gc.wire         = sw.props;
        gc.wire.gainNodeId  = {};
        gc.wire.delayNodeId = {};
        connections_[wid] = gc;
        addAdj(mappedSrc, mappedDst);
    }

    updateLinearOrder();
    rebuildImmediate();
    (void)chainPos;  // position preserved via connection rebuild
    return true;
}

// ─── Crash recovery ─────────────────────────────────────────────────────────

bool AudioGraph::isNodeCrashed(int nodeId) const
{
    if (!graph_) return false;
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return false;
    auto* apgNode = graph_->getNodeForId(it->second.apgNodeId);
    if (!apgNode) return false;
    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(apgNode->getProcessor());
    return guarded && guarded->isCrashed();
}

bool AudioGraph::resetCrashedPlugin(int nodeId)
{
    if (!graph_) return false;
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return false;
    auto* apgNode = graph_->getNodeForId(it->second.apgNodeId);
    if (!apgNode) return false;
    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(apgNode->getProcessor());
    if (!guarded) return false;
    const auto publishCountBefore = guarded->getLatencyChangePublishCount();
    const bool ok = guarded->resetCrashed();
    if (ok && guarded->getLatencyChangePublishCount() != publishCountBefore)
        rebuildImmediate();
    return ok;
}

// ─── Audio thread ───────────────────────────────────────────────────────────

void AudioGraph::processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                              juce::MidiBuffer& midi)
{
    if (!graph_ || nodes_.empty()) return;

    const int nch = std::min(buffer.getNumChannels(), 2);
    if (nch == 0 || numSamples <= 0) return;

    float* channels[2] = {};
    for (int ch = 0; ch < nch; ++ch)
        channels[ch] = buffer.getWritePointer(ch);

    juce::AudioBuffer<float> view(channels, nch, numSamples);

    // Expose the MidiBuffer to effects via static pointer (bypasses APG MIDI
    // routing — no MIDI connections exist in the graph topology).
    XlethEffectBase::setCurrentMidiBuffer(&midi);
    graph_->processBlock(view, emptyMidi_);
    XlethEffectBase::setCurrentMidiBuffer(nullptr);
}

void AudioGraph::resetProcessors()
{
    if (!graph_) return;

    for (const auto& [uid, gn] : nodes_)
    {
        juce::ignoreUnused(uid);
        if (auto* node = graph_->getNodeForId(gn.apgNodeId))
            if (auto* proc = node->getProcessor())
                proc->reset();
    }

    for (const auto& [wid, conn] : connections_)
    {
        juce::ignoreUnused(wid);
        if (conn.wire.gainNodeId.uid != 0)
        {
            if (auto* node = graph_->getNodeForId(conn.wire.gainNodeId))
                if (auto* proc = node->getProcessor())
                    proc->reset();
        }

        if (conn.wire.delayNodeId.uid != 0)
        {
            if (auto* node = graph_->getNodeForId(conn.wire.delayNodeId))
                if (auto* proc = node->getProcessor())
                    proc->reset();
        }
    }
}

double AudioGraph::getMaxTailLengthSeconds() const
{
    if (!graph_) return 0.0;
    double maxTail = 0.0;
    for (const auto& [uid, gn] : nodes_)
    {
        auto* node = graph_->getNodeForId(gn.apgNodeId);
        if (!node) continue;
        auto* proc = node->getProcessor();
        if (proc)
            maxTail = std::max(maxTail, proc->getTailLengthSeconds());
    }
    return maxTail;
}

// ─── Debounce ───────────────────────────────────────────────────────────────

void AudioGraph::timerCallback()
{
    stopTimer();
    if (!pendingRebuild_.exchange(false)) return;
    rebuildAPGConnections();
    computePDC();
}

void AudioGraph::markDirty()
{
    pendingRebuild_.store(true);
    startTimer(kDebounceMs);
}

void AudioGraph::rebuildImmediate()
{
    pendingRebuild_.store(false);
    stopTimer();
    rebuildAPGConnections();
    computePDC();
}

void AudioGraph::refreshLatencyDiagnostics()
{
    computePDC();
}

// ─── Cycle detection ────────────────────────────────────────────────────────

bool AudioGraph::wouldCreateCycle(int sourceNodeId, int destNodeId) const
{
    // DFS from dest following forward edges. If we reach source, it's a cycle.
    std::unordered_set<int> visited;
    std::stack<int> stack;

    // Start from dest's successors
    auto it = adjForward_.find(destNodeId);
    if (it != adjForward_.end())
    {
        for (int succ : it->second)
            stack.push(succ);
    }

    while (!stack.empty())
    {
        const int node = stack.top();
        stack.pop();

        if (node == sourceNodeId) return true;
        if (!visited.insert(node).second) continue;

        auto fIt = adjForward_.find(node);
        if (fIt != adjForward_.end())
        {
            for (int succ : fIt->second)
                stack.push(succ);
        }
    }

    return false;
}

// ─── Topological sort ───────────────────────────────────────────────────────

std::vector<std::vector<int>> AudioGraph::topologicalSortWithLevels() const
{
    // Collect all node uids (I/O + effect nodes)
    auto allUids = allNodeUids();
    if (allUids.empty()) return {};

    // Compute in-degrees
    std::unordered_map<int, int> inDegree;
    for (int uid : allUids)
        inDegree[uid] = 0;

    for (const auto& [wid, conn] : connections_)
    {
        if (inDegree.count(wid.destNodeId))
            inDegree[wid.destNodeId]++;
    }

    // Seed queue with zero-in-degree nodes
    std::queue<int> q;
    for (const auto& [uid, deg] : inDegree)
    {
        if (deg == 0) q.push(uid);
    }

    std::vector<std::vector<int>> levels;

    while (!q.empty())
    {
        std::vector<int> currentLevel;
        const int levelSize = static_cast<int>(q.size());

        for (int i = 0; i < levelSize; ++i)
        {
            const int node = q.front();
            q.pop();
            currentLevel.push_back(node);

            auto fIt = adjForward_.find(node);
            if (fIt != adjForward_.end())
            {
                for (int succ : fIt->second)
                {
                    inDegree[succ]--;
                    if (inDegree[succ] == 0)
                        q.push(succ);
                }
            }
        }

        levels.push_back(std::move(currentLevel));
    }

    return levels;
}

// ─── PDC ────────────────────────────────────────────────────────────────────

void AudioGraph::computePDC()
{
    if (!graph_) return;

    auto levels = topologicalSortWithLevels();

    // Reset all latencies
    for (auto& [uid, gn] : nodes_)
        gn.cumulativeLatency = 0;

    const int inUid = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    // Map uid → cumulative latency (includes I/O nodes)
    std::unordered_map<int, int> cumLatency;
    cumLatency[inUid] = 0;

    for (const auto& level : levels)
    {
        for (int uid : level)
        {
            if (uid == inUid) continue;

            // Max input latency
            int maxInputLat = 0;
            auto rIt = adjReverse_.find(uid);
            if (rIt != adjReverse_.end())
            {
                for (int pred : rIt->second)
                {
                    auto cIt = cumLatency.find(pred);
                    if (cIt != cumLatency.end())
                        maxInputLat = std::max(maxInputLat, cIt->second);
                }
            }

            // Node's own latency
            int nodeLat = 0;
            auto nIt = nodes_.find(uid);
            if (nIt != nodes_.end() && graph_)
            {
                auto* node = graph_->getNodeForId(nIt->second.apgNodeId);
                if (node && node->getProcessor())
                    nodeLat = node->getProcessor()->getLatencySamples();
            }

            cumLatency[uid] = maxInputLat + nodeLat;

            if (nIt != nodes_.end())
                nIt->second.cumulativeLatency = maxInputLat + nodeLat;
        }
    }

    auto outIt = cumLatency.find(outUid);
    outputLatencySamples_ = (outIt != cumLatency.end()) ? outIt->second : 0;
    latencyEpoch_.fetch_add(1, std::memory_order_acq_rel);

    // For each connection, determine if delay compensation is needed
    for (auto& [wid, conn] : connections_)
    {
        const int destUid = wid.destNodeId;

        // Find max input latency to dest
        int maxInputLatToDest = 0;
        auto rIt = adjReverse_.find(destUid);
        if (rIt != adjReverse_.end())
        {
            for (int pred : rIt->second)
            {
                auto cIt = cumLatency.find(pred);
                if (cIt != cumLatency.end())
                    maxInputLatToDest = std::max(maxInputLatToDest, cIt->second);
            }
        }

        const int srcLat = cumLatency.count(wid.sourceNodeId)
                         ? cumLatency[wid.sourceNodeId] : 0;
        const int neededDelay = maxInputLatToDest - srcLat;

        if (neededDelay > 0)
        {
            // Need a delay node on this wire
            if (conn.wire.delayNodeId.uid != 0)
            {
                // Update existing delay
                auto* node = graph_->getNodeForId(conn.wire.delayNodeId);
                if (node)
                {
                    auto* proc = dynamic_cast<DelayCompensationProcessor*>(node->getProcessor());
                    if (proc)
                        proc->setDelaySamples(neededDelay);
                }
            }
            // else: delay node will be created in rebuildAPGConnections
            // (computePDC is called after rebuild, so we store the needed delay
            //  and the next rebuild will pick it up. Since we call computePDC
            //  from rebuildImmediate/timerCallback AFTER rebuildAPGConnections,
            //  we need to handle this: update the delay node if it exists,
            //  or mark that a rebuild is needed if it doesn't.)
            else
            {
                // No delay node yet — need rebuild to create one.
                // We can't easily rebuild from within computePDC (recursive),
                // so we just note that PDC requires a second pass.
                // For simplicity, rebuildAPGConnections creates delay nodes
                // based on a pre-computed latency map. We'll restructure:
                // computePDC only updates existing delay nodes' sample counts.
                // rebuildAPGConnections creates/removes delay nodes based on
                // the stored neededDelay_ field. Let's add that field.
                // For now, store the delay need in the connection and trigger
                // a rebuild.
            }
        }
        else
        {
            // No delay needed — remove delay node if present
            if (conn.wire.delayNodeId.uid != 0)
            {
                // Will be cleaned up in next rebuildAPGConnections
            }
        }
    }
}

void AudioGraph::refreshOutputLatencyCache()
{
    if (!graph_)
        return;

    auto levels = topologicalSortWithLevels();
    if (levels.empty())
    {
        outputLatencySamples_ = 0;
        return;
    }

    const int inUid = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    std::unordered_map<int, int> cumLatency;
    cumLatency[inUid] = 0;

    for (const auto& level : levels)
    {
        for (int uid : level)
        {
            if (uid == inUid)
                continue;

            int maxInputLat = 0;
            auto rIt = adjReverse_.find(uid);
            if (rIt != adjReverse_.end())
            {
                for (int pred : rIt->second)
                {
                    auto cIt = cumLatency.find(pred);
                    if (cIt != cumLatency.end())
                        maxInputLat = std::max(maxInputLat, cIt->second);
                }
            }

            int nodeLat = 0;
            auto nIt = nodes_.find(uid);
            if (nIt != nodes_.end())
            {
                if (auto* node = graph_->getNodeForId(nIt->second.apgNodeId))
                {
                    if (auto* proc = node->getProcessor())
                        nodeLat = proc->getLatencySamples();
                }
            }

            const int cumulativeLatency = maxInputLat + nodeLat;
            cumLatency[uid] = cumulativeLatency;

            if (nIt != nodes_.end())
                nIt->second.cumulativeLatency = cumulativeLatency;
        }
    }

    auto outIt = cumLatency.find(outUid);
    outputLatencySamples_ = (outIt != cumLatency.end()) ? outIt->second : 0;
}

// ─── APG rebuild ────────────────────────────────────────────────────────────

void AudioGraph::rebuildAPGConnections()
{
    if (!graph_) return;

    // 1. Remove all existing APG connections
    for (const auto& c : graph_->getConnections())
        graph_->removeConnection(c);

    // 2. Clean up stale helper nodes (gain/delay) that are no longer needed
    for (auto& [wid, conn] : connections_)
    {
        const bool needsGainNode = (conn.wire.gain != 1.0f || conn.wire.muted);

        // Remove gain node if no longer needed
        if (!needsGainNode && conn.wire.gainNodeId.uid != 0)
        {
            graph_->removeNode(conn.wire.gainNodeId);
            conn.wire.gainNodeId = {};
        }

        // Create gain node if needed and doesn't exist
        if (needsGainNode && conn.wire.gainNodeId.uid == 0)
        {
            auto proc = std::make_unique<WireGainProcessor>();
            proc->setTargetGain(conn.wire.gain);
            proc->setMuted(conn.wire.muted);
            proc->setPlayConfigDetails(2, 2, sampleRate_, blockSize_);
            proc->prepareToPlay(sampleRate_, blockSize_);

            auto nodePtr = graph_->addNode(std::move(proc));
            if (nodePtr)
                conn.wire.gainNodeId = nodePtr->nodeID;
        }
        else if (needsGainNode && conn.wire.gainNodeId.uid != 0)
        {
            // Update existing gain node properties
            auto* node = graph_->getNodeForId(conn.wire.gainNodeId);
            if (node)
            {
                auto* proc = dynamic_cast<WireGainProcessor*>(node->getProcessor());
                if (proc)
                {
                    proc->setTargetGain(conn.wire.gain);
                    proc->setMuted(conn.wire.muted);
                }
            }
        }
    }

    // 3. Wire connections in the APG
    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    auto getApgNodeId = [&](int uid) -> juce::AudioProcessorGraph::NodeID {
        if (uid == inUid)  return inputNode_;
        if (uid == outUid) return outputNode_;
        auto nit = nodes_.find(uid);
        if (nit != nodes_.end()) return nit->second.apgNodeId;
        return {};
    };

    for (const auto& [wid, conn] : connections_)
    {
        auto srcApg = getApgNodeId(wid.sourceNodeId);
        auto dstApg = getApgNodeId(wid.destNodeId);

        if (conn.wire.gainNodeId.uid != 0 && conn.wire.delayNodeId.uid != 0)
        {
            // source → gain → delay → dest
            for (int ch = 0; ch < 2; ++ch)
            {
                graph_->addConnection({{srcApg, ch}, {conn.wire.gainNodeId, ch}});
                graph_->addConnection({{conn.wire.gainNodeId, ch}, {conn.wire.delayNodeId, ch}});
                graph_->addConnection({{conn.wire.delayNodeId, ch}, {dstApg, ch}});
            }
        }
        else if (conn.wire.gainNodeId.uid != 0)
        {
            // source → gain → dest
            for (int ch = 0; ch < 2; ++ch)
            {
                graph_->addConnection({{srcApg, ch}, {conn.wire.gainNodeId, ch}});
                graph_->addConnection({{conn.wire.gainNodeId, ch}, {dstApg, ch}});
            }
        }
        else if (conn.wire.delayNodeId.uid != 0)
        {
            // source → delay → dest
            for (int ch = 0; ch < 2; ++ch)
            {
                graph_->addConnection({{srcApg, ch}, {conn.wire.delayNodeId, ch}});
                graph_->addConnection({{conn.wire.delayNodeId, ch}, {dstApg, ch}});
            }
        }
        else
        {
            // Direct connection (unity gain, no delay)
            for (int ch = 0; ch < 2; ++ch)
                graph_->addConnection({{srcApg, ch}, {dstApg, ch}});
        }
    }

    // 4. If graph is empty (no effect nodes, no connections), wire input → output
    if (connections_.empty())
    {
        for (int ch = 0; ch < 2; ++ch)
            graph_->addConnection({{inputNode_, ch}, {outputNode_, ch}});
    }
}

// ─── Linear order ───────────────────────────────────────────────────────────

void AudioGraph::updateLinearOrder()
{
    linearOrder_.clear();

    if (nodes_.empty()) return;

    const int inUid  = static_cast<int>(inputNode_.uid);
    const int outUid = static_cast<int>(outputNode_.uid);

    // Check degree constraints: every node must have <=1 in-edge and <=1 out-edge
    // I/O nodes are special: input has 0 in-edges, output has 0 out-edges
    for (const auto& [uid, gn] : nodes_)
    {
        auto fIt = adjForward_.find(uid);
        auto rIt = adjReverse_.find(uid);
        const int outDeg = (fIt != adjForward_.end()) ? static_cast<int>(fIt->second.size()) : 0;
        const int inDeg  = (rIt != adjReverse_.end()) ? static_cast<int>(rIt->second.size()) : 0;
        if (outDeg > 1 || inDeg > 1) return;  // non-linear
    }

    // Check I/O degrees
    {
        auto fIt = adjForward_.find(inUid);
        const int outDeg = (fIt != adjForward_.end()) ? static_cast<int>(fIt->second.size()) : 0;
        if (outDeg > 1) return;  // fan-out from input

        auto rIt = adjReverse_.find(outUid);
        const int inDeg = (rIt != adjReverse_.end()) ? static_cast<int>(rIt->second.size()) : 0;
        if (inDeg > 1) return;   // fan-in to output
    }

    // Walk the chain from input
    std::vector<int> order;
    int current = inUid;
    std::unordered_set<int> visited;
    visited.insert(current);

    while (true)
    {
        auto fIt = adjForward_.find(current);
        if (fIt == adjForward_.end() || fIt->second.empty()) break;
        const int next = fIt->second[0];
        if (!visited.insert(next).second) break;  // cycle guard

        if (next == outUid) break;  // reached output

        // next should be an effect node
        if (!nodes_.count(next)) break;
        order.push_back(next);
        current = next;
    }

    // Verify we can reach output from the last node
    if (!order.empty())
    {
        auto fIt = adjForward_.find(order.back());
        if (fIt == adjForward_.end() || fIt->second.empty()
            || fIt->second[0] != outUid)
            return;  // doesn't reach output
    }
    else
    {
        // Empty chain or input directly to output — both valid
        auto fIt = adjForward_.find(inUid);
        if (fIt != adjForward_.end() && !fIt->second.empty()
            && fIt->second[0] != outUid)
            return;  // input connects to something that isn't output
    }

    // Verify all nodes are in the order (no disconnected nodes)
    if (static_cast<int>(order.size()) != static_cast<int>(nodes_.size()))
        return;

    linearOrder_ = std::move(order);
}

// ─── Adjacency helpers ──────────────────────────────────────────────────────

void AudioGraph::addAdj(int src, int dst)
{
    adjForward_[src].push_back(dst);
    adjReverse_[dst].push_back(src);
}

void AudioGraph::removeAdj(int src, int dst)
{
    auto& fwd = adjForward_[src];
    fwd.erase(std::remove(fwd.begin(), fwd.end(), dst), fwd.end());

    auto& rev = adjReverse_[dst];
    rev.erase(std::remove(rev.begin(), rev.end(), src), rev.end());
}

std::vector<int> AudioGraph::allNodeUids() const
{
    std::vector<int> uids;
    uids.reserve(nodes_.size() + 2);
    uids.push_back(static_cast<int>(inputNode_.uid));
    uids.push_back(static_cast<int>(outputNode_.uid));
    for (const auto& [uid, gn] : nodes_)
        uids.push_back(uid);
    return uids;
}

// ─── Effect parameter / meter access ────────────────────────────────────────

XlethEffectBase* AudioGraph::getEffect(int nodeId)
{
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return nullptr;
    auto* n = graph_->getNodeForId(it->second.apgNodeId);
    return n ? dynamic_cast<XlethEffectBase*>(n->getProcessor()) : nullptr;
}

juce::AudioProcessor* AudioGraph::getProcessor(int nodeId)
{
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end() || !graph_) return nullptr;
    auto* n = graph_->getNodeForId(it->second.apgNodeId);
    return n ? n->getProcessor() : nullptr;
}

std::string AudioGraph::getEffectParameters(int nodeId) const
{
    auto* effect = const_cast<AudioGraph*>(this)->getEffect(nodeId);
    return effect ? effect->getParametersAsJSON() : "[]";
}

bool AudioGraph::setEffectParameter(int nodeId, const std::string& paramId, float value)
{
    auto* effect = getEffect(nodeId);
    if (effect)
    {
        const int beforeLatency = effect->getLatencySamples();
        const bool ok = effect->setParameterValue(paramId, value);
        if (!ok)
            return false;

        const int afterLatency = effect->getLatencySamples();
        if (afterLatency != beforeLatency)
            rebuildImmediate();
        return true;
    }

    auto* proc = getProcessor(nodeId);
    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(proc);
    if (!guarded)
        return false;

    const bool ok = guarded->setWrappedParameterValue(paramId, value);
    if (!ok)
        return false;

    if (guarded->refreshReportedLatency())
        rebuildImmediate();
    return true;
}

bool AudioGraph::setEffectProgram(int nodeId, int programIndex)
{
    auto* proc = getProcessor(nodeId);
    if (proc == nullptr)
        return false;

    if (auto* guarded = dynamic_cast<GuardedPluginWrapper*>(proc))
    {
        const auto publishCountBefore = guarded->getLatencyChangePublishCount();
        if (!guarded->setWrappedCurrentProgram(programIndex))
            return false;
        (void)refreshGuardedPluginLatency(nodeId, publishCountBefore);
        return true;
    }

    const int beforeLatency = proc->getLatencySamples();
    proc->setCurrentProgram(programIndex);
    const int afterLatency = proc->getLatencySamples();
    if (afterLatency != beforeLatency)
    {
        rebuildImmediate();
        return true;
    }
    return true;
}

bool AudioGraph::setEffectStateInformation(int nodeId,
                                           const void* data,
                                           int sizeInBytes)
{
    auto* proc = getProcessor(nodeId);
    if (proc == nullptr || data == nullptr || sizeInBytes <= 0)
        return false;

    if (auto* guarded = dynamic_cast<GuardedPluginWrapper*>(proc))
    {
        const auto publishCountBefore = guarded->getLatencyChangePublishCount();
        guarded->setStateInformation(data, sizeInBytes);
        (void)refreshGuardedPluginLatency(nodeId, publishCountBefore);
        return true;
    }

    const int beforeLatency = proc->getLatencySamples();
    proc->setStateInformation(data, sizeInBytes);
    const int afterLatency = proc->getLatencySamples();
    if (afterLatency != beforeLatency)
    {
        rebuildImmediate();
        return true;
    }
    return true;
}

bool AudioGraph::refreshGuardedPluginLatency(int nodeId)
{
    auto* proc = getProcessor(nodeId);
    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(proc);
    if (!guarded)
        return false;

    return refreshGuardedPluginLatency(nodeId, guarded->getLatencyChangePublishCount());
}

bool AudioGraph::refreshGuardedPluginLatency(
    int nodeId,
    std::uint64_t latencyPublishCountBefore)
{
    auto* proc = getProcessor(nodeId);
    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(proc);
    if (!guarded)
        return false;

    const bool refreshed = guarded->refreshReportedLatency();
    const bool alreadyPublished =
        guarded->getLatencyChangePublishCount() != latencyPublishCountBefore;
    if (!refreshed && !alreadyPublished)
        return false;

    rebuildImmediate();
    return true;
}

std::string AudioGraph::getEffectMeter(int nodeId) const
{
    auto* effect = const_cast<AudioGraph*>(this)->getEffect(nodeId);
    return effect ? effect->getMeterAsJSON() : "[0,0,0,0,0,0,0,0]";
}

juce::String AudioGraph::getPluginFilePath(int nodeId) const
{
    auto it = vstDescriptions_.find(nodeId);
    if (it == vstDescriptions_.end()) return {};
    return it->second.fileOrIdentifier;
}

// ─── Factory ────────────────────────────────────────────────────────────────

std::unique_ptr<juce::AudioProcessor> AudioGraph::createEffect(const std::string& pluginId)
{
    if (pluginId == "testgain")      return std::make_unique<TestGainEffect>();
    if (pluginId == "compressor")    return std::make_unique<XlethCompressorEffect>();
    if (pluginId == "limiter")       return std::make_unique<XlethLimiterEffect>();
    if (pluginId == "overdone")      return std::make_unique<XlethOTTEffect>();
    if (pluginId == "transientproc") return std::make_unique<XlethTransientProcEffect>();
    if (pluginId == "xletheq")       return std::make_unique<XlethEQEffect>();
    if (pluginId == "xlethfilter")   return std::make_unique<XlethFilterEffect>();
    if (pluginId == "distortion")    return std::make_unique<XlethDistortionEffect>();
    if (pluginId == "waveshaper")    return std::make_unique<XlethWaveshaperEffect>();
    if (pluginId == "uniflange")     return std::make_unique<UniFlangeEffect>();
    if (pluginId == "chorus")        return std::make_unique<ChorusEffect>();
    if (pluginId == "flanger")       return std::make_unique<XlethFlangerEffect>();
    if (pluginId == "phaser")        return std::make_unique<XlethPhaserEffect>();
    if (pluginId == "phanjer")       return std::make_unique<PhanjerEffect>();
    if (pluginId == "delay")         return std::make_unique<XlethDelayEffect>();
    if (pluginId == "reverb")        return std::make_unique<XlethReverbEffect>();
    if (pluginId == "resonancesuppressor") return std::make_unique<XlethResonanceSuppressorEffect>();
    if (pluginId == "smartbalance")  return std::make_unique<SmartBalanceEffect>();

    // VST3 fallback — look up in the plugin registry and instantiate.
    // The createPluginInstance call itself is guarded (some plugins fault on load).
    if (pluginRegistry_)
    {
        // findPluginByIdentifier returns by value — no dangling pointer risk.
        const auto desc = pluginRegistry_->findPluginByIdentifier(juce::String(pluginId));
        if (!desc.name.isEmpty())
        {
            juce::String errorMsg;
            std::unique_ptr<juce::AudioPluginInstance> instance;
            auto& fmtMgr = pluginRegistry_->getFormatManager();
            const auto sr = sampleRate_;
            const auto bs = blockSize_;
#ifdef XLETH_DEBUG
            std::fprintf(stderr,
                         "[PluginHost] Loading: pluginId='%s' desc.name='%s' desc.fileOrIdentifier='%s'\n",
                         pluginId.c_str(),
                         desc.name.toRawUTF8(),
                         desc.fileOrIdentifier.toRawUTF8());
#endif
            const bool createOk = xleth::pluginGuardCall([&]
            {
                instance = fmtMgr.createPluginInstance(desc, sr, bs, errorMsg);
            });
            if (!createOk)
            {
#ifdef XLETH_DEBUG
                std::fprintf(stderr,
                             "[PluginHost] CRASH: \"%s\" during createPluginInstance — not loaded\n",
                             desc.name.toRawUTF8());
#endif
                return nullptr;
            }
            if (instance)
            {
                // Explicitly set stereo bus layout before prepareToPlay.
                // VST3 plugins may default to a non-stereo configuration; without
                // this call the AudioProcessorGraph won't route audio correctly.
                juce::AudioProcessor::BusesLayout layout;
                layout.inputBuses.add(juce::AudioChannelSet::stereo());
                layout.outputBuses.add(juce::AudioChannelSet::stereo());
                if (!instance->setBusesLayout(layout))
                {
#ifdef XLETH_DEBUG
                    std::fprintf(stderr,
                                 "[PluginHost] setBusesLayout failed for \"%s\" — using plugin default\n",
                                 desc.name.toRawUTF8());
#endif
                }
                instance->setPlayConfigDetails(2, 2, sr, bs);
                instance->prepareToPlay(sr, bs);
#ifdef XLETH_DEBUG
                std::fprintf(stderr,
                             "[PluginHost] Loaded: \"%s\" (latency: %d samples,"
                             " in=%d out=%d at %.0fHz/%d samples)\n",
                             desc.name.toRawUTF8(),
                             instance->getLatencySamples(),
                             instance->getTotalNumInputChannels(),
                             instance->getTotalNumOutputChannels(),
                             sr, bs);
#endif
                return std::make_unique<GuardedPluginWrapper>(std::move(instance));
            }
#ifdef XLETH_DEBUG
            std::fprintf(stderr, "[PluginHost] Load failed: \"%s\" — %s\n",
                         desc.name.toRawUTF8(),
                         errorMsg.isEmpty() ? "no instance returned" : errorMsg.toRawUTF8());
#endif
        }
    }

    return nullptr;
}

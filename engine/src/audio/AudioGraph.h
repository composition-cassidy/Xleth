#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <nlohmann/json.hpp>

#include "audio/SidechainCapability.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

class XlethEffectBase;
class WireGainProcessor;
class DelayCompensationProcessor;
class SidechainSourceProcessor;
class PluginRegistry;

// ─── AudioGraph ─────────────────────────────────────────────────────────────
// Owns a juce::AudioProcessorGraph and a topology data model (nodes,
// connections, adjacency lists).  Provides:
//
//   - Arbitrary fan-in / fan-out audio wiring (stereo only, no MIDI)
//   - Cycle rejection via DFS before addConnection
//   - Kahn's BFS topological sort with level groupings
//   - Plugin Delay Compensation (PDC) with DelayCompensationProcessor nodes
//   - Per-wire gain (0-2.0, SmoothedValue 20 ms) and mute (gain→0 ramp)
//   - 50 ms debounced APG rebuild for graph-mode mutations
//   - Chain-mode compatibility (addEffect/removeEffect/moveEffect)
//
// Threading:
//   Main thread  — all public methods except processBlock
//   Audio thread — processBlock only (APG handles atomic RenderSequence swap)

class AudioGraph : private juce::Timer
{
public:
    AudioGraph();
    ~AudioGraph() override;

    // ── Plugin registry (non-owning, set before init) ───────────────────
    void setPluginRegistry(PluginRegistry* registry) noexcept { pluginRegistry_ = registry; }

    // ── Lifecycle (main thread) ─────────────────────────────────────────
    void init(double sampleRate, int blockSize);
    void destroy();
    bool isInitialized() const { return graph_ != nullptr; }
    void reprepare(double sampleRate, int blockSize);
    void setNonRealtime(bool nr) { if (graph_) graph_->setNonRealtime(nr); }

    // ── Node management (main thread) ───────────────────────────────────

    // Add a new effect node.  Returns APG NodeID uid, or -1 on failure.
    int addNode(const std::string& pluginId);

    // Remove a node and all its connections.  Returns false if not found.
    bool removeNode(int nodeId);

    // Store UI position (not used by engine, persisted for future UI).
    void setNodePosition(int nodeId, float x, float y);

    // Set bypass state on an effect node.
    bool setBypass(int nodeId, bool bypassed);

    // ── Connection management (main thread) ─────────────────────────────

    // Add a connection. Returns false if would create cycle or invalid nodes.
    // Uses 50 ms debounced rebuild.
    bool addConnection(int sourceNodeId, int destNodeId);

    // Remove a connection. Returns false if not found.
    // Uses 50 ms debounced rebuild.
    bool removeConnection(int sourceNodeId, int destNodeId);

    // Replace all runtime connections with input -> ordered nodes -> output.
    // An empty path leaves the graph in safe passthrough.
    bool replaceConnectionsWithLinearPath(const std::vector<int>& orderedNodeIds);

    // Replace all runtime connections with an arbitrary acyclic edge set
    // (fan-out / fan-in supported; JUCE APG sums multiple inputs natively).
    // Each pair is {sourceNodeId, destNodeId} in engine uid space (I/O or
    // effect uids). Clears all prior connections first, so an empty edge set
    // leaves the graph silent (no input -> output path). Returns false if any
    // endpoint is unknown or an edge would create a cycle (caller fail-closes).
    bool replaceConnectionsWithGraph(const std::vector<std::pair<int, int>>& edges);

    // Clear all runtime connections; rebuildAPGConnections wires direct
    // input -> output passthrough when no logical connections remain.
    bool clearConnectionsForPassthrough();

    // Clear all runtime connections AND suppress the empty-graph passthrough so
    // Track Output receives nothing (true silence). Used by graph mode to
    // fail-closed when there is no valid Track Input -> Track Output route, so
    // the old chain route can never leak. Any subsequent connection rebuild
    // (replaceConnectionsWith*, addEffect, addConnection) restores passthrough.
    bool clearConnectionsToSilence();

    // ── Wire properties (main thread) ───────────────────────────────────

    // Set wire gain (0.0–2.0). Returns false if connection not found.
    bool setWireGain(int sourceNodeId, int destNodeId, float gain);

    // Set wire mute. Gain ramps to 0; connection stays alive.
    bool setWireMute(int sourceNodeId, int destNodeId, bool muted);

    // ── Chain-mode compatibility (main thread, immediate rebuild) ───────

    // Add effect at position in linear chain. Returns APG NodeID uid or -1.
    int addEffect(const std::string& pluginId, int position);

    // Remove effect from chain. Returns false if not found.
    bool removeEffect(int nodeId);

    // Move effect to new position in chain. Returns false if not found.
    bool moveEffect(int nodeId, int newPosition);

    // Number of effect nodes (excludes I/O nodes).
    int getEffectCount() const;

    // ── Query (main thread) ─────────────────────────────────────────────

    // Returns the old-format chain state: [{nodeId, pluginId, position, bypassed}]
    nlohmann::json getChainState() const;

    // Returns full graph topology JSON with nodes, connections, levels, latencies.
    nlohmann::json getGraphTopology() const;

    int countActiveResonanceSuppressorHighQualityInstances() const;

    // True iff graph is a single linear path (every node has <=1 in, <=1 out).
    bool isGraphLinear() const;

    // True iff nodeId is a currently-allocated effect node (excludes I/O nodes
    // and helper gain/delay nodes). Used to validate graph-node adoption.
    bool hasNode(int nodeId) const { return nodes_.count(nodeId) > 0; }

    // ── Stable effect-instance identity (main thread) ───────────────────
    // Resolve a stable effectInstanceId to its current-session APG uid, or -1
    // if no node carries that id. The returned uid is transient (remapped on
    // load) and must never be persisted — only the effectInstanceId is stable.
    int getNodeIdForEffectInstance(const std::string& effectInstanceId) const;

    // Reverse lookup: the stable effectInstanceId for an APG uid, or "" if the
    // node is unknown.
    std::string getEffectInstanceIdForNode(int nodeId) const;

    // Session-only sidechain capability for a node, or a default (unsupported)
    // capability if the node is unknown. `supported`/`channels` come from the
    // instantiation probe; `enabled` reflects the last applySidechainTargetInstances.
    xleth::SidechainCapability getSidechainCapability(int nodeId) const;

    // True iff the effect instance resolves on this graph AND its node exposes a
    // usable sidechain input (stock compressor or a probed-capable wrapped plugin).
    // A missing instance returns false (the caller distinguishes missing from
    // unsupported via the existence resolver). Capability is never persisted.
    bool isEffectInstanceSidechainCapable(const std::string& effectInstanceId) const;

    // Overwrite a node's stable effectInstanceId. Returns false if nodeId is
    // unknown or the id is empty. Used to stamp the renderer-supplied id onto a
    // graph-owned node and to restore persisted ids on load.
    bool setNodeEffectInstanceId(int nodeId, const std::string& effectInstanceId);

    // ── Effect parameter / meter access (main-thread only) ─────────────
    // Retrieve the XlethEffectBase for a node.  Returns nullptr if the nodeId
    // is not in this graph or the node does not hold an XlethEffectBase.
    XlethEffectBase* getEffect(int nodeId);

    // Returns the raw AudioProcessor for any node (stock XlethEffectBase OR
    // VST3 AudioPluginInstance).  Returns nullptr if nodeId is not found.
    juce::AudioProcessor* getProcessor(int nodeId);

    // Returns the plugin file path (PluginDescription::fileOrIdentifier) for a
    // VST node.  Returns empty string for stock effects or missing nodeId.
    juce::String getPluginFilePath(int nodeId) const;

    // Returns JSON param descriptor array ("[]" if nodeId invalid).
    std::string getEffectParameters(int nodeId) const;

    // Set a parameter by ID (denormalised).  Returns false if invalid.
    bool setEffectParameter(int nodeId, const std::string& paramId, float value);
    bool setEffectProgram(int nodeId, int programIndex);
    bool setEffectStateInformation(int nodeId, const void* data, int sizeInBytes);

    // Non-realtime third-party latency refresh hook. Returns true if a
    // GuardedPluginWrapper published a changed latency and PDC was recomputed.
    bool refreshGuardedPluginLatency(int nodeId);
    bool refreshGuardedPluginLatency(int nodeId,
                                     std::uint64_t latencyPublishCountBefore);

    // Returns JSON meter array ("[0,0,0,0,0,0,0,0]" if nodeId invalid).
    std::string getEffectMeter(int nodeId) const;

    // ── FXG.4-a graph-owned parameter descriptors (main-thread only) ────
    // Unified normalized [0,1] parameter access for stock effects (APVTS) and
    // third-party plugins (host-facing AudioProcessorParameter objects, asked
    // of the hosted processor — never scraped from a native editor). Plugin
    // calls run behind the SEH guard. All three return a structured JSON object
    // with { ok, ... } and a `reason` on failure.
    nlohmann::json getGraphEffectParameterDescriptors(int nodeId) const;
    nlohmann::json getGraphEffectParameterValue(int nodeId, const std::string& parameterId) const;
    nlohmann::json setGraphEffectParameterNormalized(int nodeId, const std::string& parameterId,
                                                     float normalizedValue);

    // ── Missing-plugin support ──────────────────────────────────────────

    // True iff nodeId holds a PassthroughProcessor (plugin was not found at load time).
    bool isNodeMissing(int nodeId) const;

    // Attempt to replace the placeholder at nodeId with the real plugin from
    // registry.  Preserves connections and chain position.
    // Returns true on success (placeholder is gone); false if plugin still unavailable.
    bool tryResolvePlugin(int nodeId, PluginRegistry& registry);

    // ── Crash recovery ──────────────────────────────────────────────────
    // Returns true if nodeId's GuardedPluginWrapper reports crashed_ == true.
    bool isNodeCrashed(int nodeId) const;

    // Attempt to recover a crashed VST node (releaseResources → prepare → reset,
    // all inside SEH).  Returns true if recovery succeeded; false if the reset
    // itself faulted or nodeId does not hold a GuardedPluginWrapper.
    bool resetCrashedPlugin(int nodeId);

    // ── Serialization ───────────────────────────────────────────────────

    nlohmann::json toJSON() const;
    bool fromJSON(const nlohmann::json& j);
    bool fromJSON(const nlohmann::json& j,
                  std::unordered_map<int, int>* oldToNewNodeIds);

    // ── Audio thread ────────────────────────────────────────────────────
    void processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                      juce::MidiBuffer& midi);

    // Reset all processors and helper nodes. Intended for transport jumps.
    void resetProcessors();

    // Returns the maximum getTailLengthSeconds() across all effect nodes.
    // Lightweight (iterates effect nodes only, no alloc). Safe from audio thread.
    double getMaxTailLengthSeconds() const;

    // Returns the cumulative latency at the graph output in samples.
    int getOutputLatencySamples() const { return outputLatencySamples_; }
    std::uint64_t getLatencyEpoch() const
    {
        return latencyEpoch_.load(std::memory_order_acquire);
    }

    // Main-thread diagnostic refresh for latency-sensitive tests/tools.
    // This recomputes cached latency accounting without changing audio routing.
    void refreshLatencyDiagnostics();

    // Test hook for fake third-party processors. Production plugin loading
    // still goes through createEffect()/PluginRegistry.
    int addProcessorForTesting(const std::string& pluginId,
                               std::unique_ptr<juce::AudioProcessor> proc,
                               int position);

    // ── Input/output node IDs (for external wiring references) ──────────
    int getInputNodeId()  const { return static_cast<int>(inputNode_.uid); }
    int getOutputNodeId() const { return static_cast<int>(outputNode_.uid); }

    // ── Sidechain key injection (Prompt 4C+4D groundwork) ───────────────
    // A SidechainSourceProcessor infrastructure node is created lazily whenever
    // this graph contains a sidechain-capable effect node (one with an enabled
    // second input bus) and removed when none remain. Its stereo output is wired
    // to every such node's second input bus, so the key signal is delivered
    // WITHOUT ever touching the audible main path. Returns true iff a
    // sidechain-capable node is currently present.
    bool hasSidechainCapableNode() const;

    // Borrow this block's per-target key audio for the sidechain source node.
    // No-op when no sidechain source node exists. Audio-thread; MixEngine calls
    // this immediately before, and clearSidechainKey() immediately after, the
    // chain processBlock — under the chains lock, same thread, same block.
    void setSidechainKey(const float* left, const float* right, int numSamples) noexcept;
    void clearSidechainKey() noexcept;

    // Main-thread (Prompt 5A): enable the sidechain input bus on every
    // external-sidechain-capable stock effect (today only the compressor) whose
    // stable effectInstanceId appears in `enabledInstanceIds`, and disable it on
    // all others. When any bus layout changes, the graph is re-prepared and the
    // sidechain infrastructure rewired so the newly-capable node receives the
    // key. Returns true iff any layout changed. Idempotent — a no-op when the
    // desired set already matches the live bus states (no re-prepare churn).
    //
    // `includeWrappedPlugins` extends the toggle to sidechain-capable
    // GuardedPluginWrapper (third-party) nodes. VST-SC.3 turned this ON for the
    // production route-sync path (EffectChainManager::applySidechainTargetInstances
    // passes true), so an enabled Timeline SidechainRoute targeting a probed-capable
    // wrapped plugin now enables its key bus. Only nodes whose probe found a usable
    // key bus (gn.sidechain.supported) are ever enabled; unsupported wrapped plugins
    // and the stock branch are unaffected by this flag. Defaults to FALSE for the
    // few callers that want stock-only behavior; idempotent — no reprepare unless a
    // bus layout actually changes.
    bool applySidechainTargetInstances(const std::set<std::string>& enabledInstanceIds,
                                       bool includeWrappedPlugins = false);

private:
    // ── Node data ───────────────────────────────────────────────────────

    struct GraphNode
    {
        juce::AudioProcessorGraph::NodeID apgNodeId;
        std::string pluginId;
        // Stable, persistent per-instance identity (UUID string). Generated once
        // when the processor is added (addProcessorToGraph), persisted in chain
        // JSON, and restored on load. Survives the APG uid remap that happens on
        // every project load, so it is the only safe address for cross-session
        // references to "this specific effect instance" (e.g. sidechain targets).
        std::string effectInstanceId;
        float x = 0.0f;
        float y = 0.0f;
        int   level = -1;                // Kahn's BFS level (computed)
        int   cumulativeLatency = 0;     // PDC: computed

        // Session-only sidechain capability, discovered at instantiation (stock
        // effects via supportsExternalSidechain(); wrapped plugins via the
        // GuardedPluginWrapper probe). NEVER serialized — re-discovered on every
        // load, since plugins lie and change across hosts/versions. Exposed
        // additively in chain/graph-state JSON so the UI can gate sidechain
        // controls without hardcoding plugin ids.
        xleth::SidechainCapability sidechain;
    };

    // ── Wire / connection data ──────────────────────────────────────────

    struct WireId
    {
        int sourceNodeId;
        int destNodeId;
        bool operator==(const WireId& o) const noexcept
        {
            return sourceNodeId == o.sourceNodeId && destNodeId == o.destNodeId;
        }
    };

    struct WireIdHash
    {
        size_t operator()(const WireId& w) const noexcept
        {
            auto h1 = static_cast<size_t>(static_cast<uint32_t>(w.sourceNodeId));
            auto h2 = static_cast<size_t>(static_cast<uint32_t>(w.destNodeId));
            return (h1 << 16) ^ h2;
        }
    };

    struct WireProperties
    {
        float gain  = 1.0f;
        bool  muted = false;

        // Runtime APG NodeIDs for inserted processors (uid 0 = not present)
        juce::AudioProcessorGraph::NodeID gainNodeId{};
        juce::AudioProcessorGraph::NodeID delayNodeId{};
    };

    struct GraphConnection
    {
        int sourceNodeId;
        int destNodeId;
        WireProperties wire;
    };

    // ── Storage ─────────────────────────────────────────────────────────

    std::unique_ptr<juce::AudioProcessorGraph> graph_;
    juce::AudioProcessorGraph::NodeID inputNode_{};
    juce::AudioProcessorGraph::NodeID outputNode_{};

    // Sidechain key source infrastructure node (Prompt 4C+4D). Tracked OUTSIDE
    // nodes_ (like the I/O nodes) so it never participates in chain ordering,
    // PDC, topology, or serialization. uid 0 / nullptr = not present. The raw
    // pointer is owned by graph_; it is read on the audio thread (setSidechainKey)
    // and (re)assigned on the main/message thread during rebuilds, hence atomic.
    juce::AudioProcessorGraph::NodeID       sidechainSourceNode_{};
    std::atomic<SidechainSourceProcessor*>  sidechainSourceProc_{nullptr};

    // Non-owning pointer to the shared PluginRegistry (set via setPluginRegistry).
    PluginRegistry* pluginRegistry_ = nullptr;

    // For each VST node (keyed by uid), stores the PluginDescription used
    // to instantiate it so toJSON can persist it for round-trip fidelity.
    std::unordered_map<int, juce::PluginDescription> vstDescriptions_;

    // UIDs of nodes currently holding a PassthroughProcessor (plugin missing at load).
    std::unordered_set<int> missingNodes_;

    // Effect nodes keyed by uid (excludes I/O nodes, gain nodes, delay nodes)
    std::unordered_map<int, GraphNode> nodes_;

    // Connections keyed by {source, dest} uid pair
    std::unordered_map<WireId, GraphConnection, WireIdHash> connections_;

    // Adjacency lists (effect + I/O node uids only, not gain/delay helper nodes)
    std::unordered_map<int, std::vector<int>> adjForward_;   // source → [dest]
    std::unordered_map<int, std::vector<int>> adjReverse_;   // dest → [source]

    // Cached linear ordering (uids in chain order). Empty if non-linear.
    std::vector<int> linearOrder_;

    double sampleRate_ = 44100.0;
    int    blockSize_  = 512;
    juce::MidiBuffer emptyMidi_;
    int outputLatencySamples_ = 0;
    std::atomic<std::uint64_t> latencyEpoch_{0};

    // When true, rebuildAPGConnections does NOT auto-wire the empty-graph
    // input -> output passthrough; Track Output is left unconnected (silence).
    // Set only by clearConnectionsToSilence; cleared by clearAllConnections.
    bool muteOutput_ = false;

    // ── Debounce state ──────────────────────────────────────────────────

    std::atomic<bool> pendingRebuild_{false};

    void timerCallback() override;
    void markDirty();
    void rebuildImmediate();   // chain-mode: bypass debounce

    // ── Algorithms ──────────────────────────────────────────────────────

    // Returns true if adding source→dest would create a cycle.
    bool wouldCreateCycle(int sourceNodeId, int destNodeId) const;

    // Kahn's BFS. Returns levels of node uids. Empty if graph has a cycle
    // (should never happen — cycles are rejected at addConnection).
    std::vector<std::vector<int>> topologicalSortWithLevels() const;

    // Compute cumulative latencies and insert/remove delay nodes.
    void computePDC();
    void refreshOutputLatencyCache();

    // Rebuild all APG connections from topology data. Idempotent.
    void rebuildAPGConnections();

    // Sidechain groundwork: create/remove the SidechainSourceProcessor node to
    // match the presence of sidechain-capable nodes, and wire it to their second
    // input bus. Called from rebuildAPGConnections (connections are rebuilt every
    // pass, so the key wiring is re-established each time). Main/message thread.
    void rebuildSidechainInfrastructure();

    // True iff `proc` declares an enabled second input bus with ≥1 channel —
    // i.e. it can receive a sidechain key. Production stock/VST nodes are
    // single-input-bus (or have the aux bus disabled), so they never qualify in
    // this pass; only an explicitly sidechain-enabled node (e.g. a test receiver)
    // does. Static so it has no per-instance state.
    static bool isSidechainCapable(const juce::AudioProcessor* proc);

    // Recompute linearOrder_ from adjacency lists.
    void updateLinearOrder();

    // Remove every logical connection and any helper gain/delay nodes.
    void clearAllConnections();

    // ── Adjacency helpers ───────────────────────────────────────────────

    void addAdj(int src, int dst);
    void removeAdj(int src, int dst);

    // All node uids (I/O + effect nodes) for algorithm iteration.
    std::vector<int> allNodeUids() const;

    // ── Factory ─────────────────────────────────────────────────────────

    // Returns a stock XlethEffectBase or a VST3 AudioPluginInstance.
    // Falls back to VST registry when pluginId is not a known stock effect.
    std::unique_ptr<juce::AudioProcessor> createEffect(const std::string& pluginId);

    // Add a pre-created processor to the APG and node tables.
    // Does NOT store vstDescriptions_ — caller must do that if needed.
    int addProcessorToGraph(const std::string& pluginId,
                            std::unique_ptr<juce::AudioProcessor> proc);

    // Generate a fresh, globally-unique stable effect-instance id (UUID string).
    static std::string makeEffectInstanceId();

    // ── Constants ───────────────────────────────────────────────────────

    static constexpr int kMaxNodes = 256;
    static constexpr int kDebounceMs = 50;
};

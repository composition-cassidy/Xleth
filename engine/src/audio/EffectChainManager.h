#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

class AudioGraph;
class PluginRegistry;
class XlethEffectBase;

// ─── EffectChainManager ─────────────────────────────────────────────────────
// Thin wrapper around AudioGraph.  Preserves the original linear-chain API
// (addEffect/removeEffect/moveEffect) so MixEngine requires zero changes.
//
// New graph-mode methods (addConnection, setWireGain, etc.) are also
// exposed here for MixEngine to forward to.
//
// The underlying AudioGraph owns the juce::AudioProcessorGraph and handles
// topological sort, cycle rejection, PDC, wire gain/mute, and debounce.

class EffectChainManager
{
public:
    static constexpr int kMaxEffects = 100;

    EffectChainManager();
    ~EffectChainManager();

    // ── Plugin registry (non-owning, set before init) ───────────────────
    void setPluginRegistry(PluginRegistry* registry);

    // ── Lifecycle (main thread) ─────────────────────────────────────────
    void init(double sampleRate, int blockSize);
    void destroy();
    bool isInitialized() const;

    // Re-prepare with new sample rate / block size (audio device change).
    void reprepare(double sampleRate, int blockSize);

    // Propagate non-realtime mode to the underlying JUCE AudioProcessorGraph,
    // enabling its built-in spin-wait safety before the first processBlock.
    void setNonRealtime(bool nr);

    // ── Chain mutations (main thread) ───────────────────────────────────

    // Add an effect at `position` (0-based; clamped to [0, count]).
    // Returns the APG NodeID uid as int, or -1 on failure.
    int addEffect(const std::string& pluginId, int position);

    // Remove the effect node identified by its uid.  Returns false if not found.
    bool removeEffect(int nodeId);

    // Move an existing effect to a new position.  Returns false if not found.
    bool moveEffect(int nodeId, int newPosition);

    // Set bypass state on an effect node.  Returns false if not found.
    bool setBypass(int nodeId, bool bypassed);

    // ── Query ───────────────────────────────────────────────────────────
    int getEffectCount() const;

    // Returns JSON array describing the chain: [{nodeId, pluginId, position, bypassed}, ...]
    nlohmann::json getChainState() const;
    int countActiveResonanceSuppressorHighQualityInstances() const;

    // ── Graph-mode APIs (main thread) ───────────────────────────────────

    // Add / remove arbitrary connections (with cycle rejection & debounce).
    bool addConnection(int sourceNodeId, int destNodeId);
    bool removeConnection(int sourceNodeId, int destNodeId);

    // Per-wire gain (0–2.0, SmoothedValue 20 ms ramp) and mute.
    bool setWireGain(int sourceNodeId, int destNodeId, float gain);
    bool setWireMute(int sourceNodeId, int destNodeId, bool muted);

    // Store UI position for a node (persisted, not used by engine).
    void setNodePosition(int nodeId, float x, float y);

    // Full graph topology JSON (nodes with levels/latencies, connections).
    nlohmann::json getGraphTopology() const;

    // True iff graph is a single linear path (chain mode).
    bool isGraphLinear() const;

    // ── Graph-owned effect instance lifecycle (FXG.3-b, main thread) ─────
    //
    // FX Graph mode owns effect instances keyed by a stable string
    // effectInstanceId (assigned by the renderer, persisted with graphState).
    // These use the low-level AudioGraph addNode/removeNode so they NEVER
    // mutate the linear chain topology: no auto-wiring, no position reorder,
    // no moveEffect. Graph routing is not applied here — graph-owned nodes are
    // created disconnected (silent) until FXG.3-c wires graphState edges into
    // the engine.
    //
    // The effectInstanceId → engine APG uid map is session-only at runtime;
    // FXG.3-c-a rebuilds it from graphState hydration after load and also
    // serializes effectInstanceId additively on graph-owned AudioGraph nodes.

    // Instantiate a graph-owned processor for effectInstanceId. Returns the APG
    // NodeID uid, or -1 on failure (empty/placeholder pluginId, unknown plugin,
    // or graph full). Idempotent: re-adding a known effectInstanceId returns the
    // existing engine uid without creating a second processor.
    int  addGraphNode(const std::string& effectInstanceId, const std::string& pluginId);

    // Recreate graph-owned processors from renderer graphState metadata after
    // project load. Input is an array of objects containing effectInstanceId,
    // pluginId, and optional graphNodeId/displayName diagnostics. Returns:
    // { ok, mapping, skipped, failures }. Does not connect graph edges.
    nlohmann::json hydrateGraphNodes(const nlohmann::json& graphEffectNodes);

    // Destroy the graph-owned processor for effectInstanceId and drop the
    // mapping. Returns false if effectInstanceId is unknown.
    bool removeGraphNode(const std::string& effectInstanceId);

    // Resolve effectInstanceId to its current-session engine APG uid, or -1.
    int  getGraphNodeEngineId(const std::string& effectInstanceId) const;

    // True iff effectInstanceId currently maps to a graph-owned processor.
    bool hasGraphNode(const std::string& effectInstanceId) const;

    // FXG.3-c-b: validate a renderer graphState topology payload, resolve
    // active effectInstanceIds to engine node IDs, and apply only the supported
    // single linear Track Input -> effects -> Track Output path. Unsupported
    // topology falls back to safe passthrough without deleting graph-owned nodes.
    nlohmann::json syncLinearGraphTopology(const nlohmann::json& topology);

    // ── Effect parameter / meter access (main-thread only) ─────────────
    std::string getEffectParameters(int nodeId) const;
    bool        setEffectParameter (int nodeId, const std::string& paramId, float value);
    bool        setEffectProgram   (int nodeId, int programIndex);
    bool        setEffectStateInformation(int nodeId, const void* data, int sizeInBytes);
    std::string getEffectMeter     (int nodeId) const;
    bool        refreshGuardedPluginLatency(int nodeId);
    bool        refreshGuardedPluginLatency(int nodeId,
                                            std::uint64_t latencyPublishCountBefore);

    // Direct access to the effect processor (for subclass-specific APIs like EQ).
    XlethEffectBase* getEffect(int nodeId);

    // Returns the raw AudioProcessor for any node (stock or VST3).
    // Used by PluginEditorHost to obtain the processor for GUI creation.
    juce::AudioProcessor* getProcessor(int nodeId);

    // Returns the plugin file path (PluginDescription::fileOrIdentifier) for a
    // VST node.  Returns empty string for stock effects or if nodeId not found.
    juce::String getPluginFilePath(int nodeId) const;

    // ── Missing-plugin support ──────────────────────────────────────────
    bool isNodeMissing(int nodeId) const;
    bool tryResolvePlugin(int nodeId, PluginRegistry& registry);

    // ── Crash recovery (VST SEH wrapper) ────────────────────────────────
    bool isNodeCrashed(int nodeId) const;
    bool resetCrashedPlugin(int nodeId);

    // Returns JSON array: [{nodeId, pluginId, pluginName, pluginVendor, filePath}, ...]
    // for all nodes currently holding a placeholder (missing plugin).
    nlohmann::json getMissingNodesJSON() const;

    // ── Serialization ───────────────────────────────────────────────────
    nlohmann::json graphToJSON() const;
    bool graphFromJSON(const nlohmann::json& j);

    // ── Audio thread ────────────────────────────────────────────────────
    // Process `numSamples` samples in-place.
    void processBlock(juce::AudioBuffer<float>& buffer, int numSamples,
                      juce::MidiBuffer& midi);

    // Reset all processors in the chain. Intended for transport jumps.
    void resetProcessors();

    // Returns the maximum getTailLengthSeconds() across all effect nodes.
    double getMaxTailLengthSeconds() const;

    // Returns the cumulative latency at the chain output in samples.
    int getOutputLatencySamples() const;
    std::uint64_t getLatencyEpoch() const;
    void refreshLatencyDiagnostics();

    int addProcessorForTesting(const std::string& pluginId,
                               std::unique_ptr<juce::AudioProcessor> proc,
                               int position);

private:
    std::unique_ptr<AudioGraph> graph_;

    // Graph-owned effect instances: stable effectInstanceId → APG uid.
    // Session-only at runtime. Serialized additively on graph-owned nodes so a
    // loaded AudioGraph can rebuild the runtime mapping without treating
    // graphState node ids as engine ids. Never used by chain-mode APIs.
    std::unordered_map<std::string, int> graphNodeIds_;
};

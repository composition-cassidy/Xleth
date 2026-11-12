#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <memory>
#include <cstdint>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

class AudioGraph;
class PluginRegistry;
class XlethEffectBase;

// Defined in AudioGraph.h; held here only by shared_ptr, so incomplete is fine.
namespace xleth::audio { struct GraphRealtimeView; }

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

    // ── FX Chain Library (main thread) ──────────────────────────────────
    //
    // Build this chain from an ORDERED preset description:
    //   [{ pluginId, bypassed?, state? }, ...]   state = base64 getStateInformation
    //
    // graphToJSON is not usable as the library's storage format: its `nodes`
    // array comes out of an unordered_map, so slot order lives only in the
    // connection list. A saved chain has to survive being read by a human and
    // re-applied on another machine, so the library stores the ordered list
    // instead and this method turns it back into a live chain.
    //
    // `replace` true clears every existing effect first; false appends after the
    // last one. Effects whose pluginId will not instantiate here (a VST3 that is
    // not installed on this machine) are SKIPPED and named in the result rather
    // than aborting the load — a chain that is three-quarters right beats no
    // chain plus an error.
    //
    // Returns { ok, added, skipped: [pluginId, ...] }.
    nlohmann::json applyChainPreset(const nlohmann::json& effects, bool replace);

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

    // ── Stable effect-instance lookup (chain + graph, main thread) ──────
    // Resolve a stable effectInstanceId to its current-session APG uid, or -1.
    // Unified across chain-mode and graph-owned nodes: graph-owned instances
    // resolve through graphNodeIds_, chain-mode instances through the AudioGraph
    // node metadata. The returned uid is transient (remapped every load) and is
    // for runtime wiring only — never persist it. Provided so a later sidechain
    // phase can resolve a persisted (targetTrackId, effectInstanceId) address to
    // the live engine node.
    int getNodeIdForEffectInstance(const std::string& effectInstanceId) const;

    // Reverse lookup: the stable effectInstanceId for an APG uid, or "".
    std::string getEffectInstanceIdForNode(int nodeId) const;

    // FXG.3-d: validate a renderer graphState topology payload, resolve active
    // effectInstanceIds to engine node IDs, and rebuild the track's runtime
    // routing from graphState alone. Graph mode is the SOLE owner of the
    // connection space here: every call clears all prior connections (chain or
    // graph) and rebuilds only the graph-owned route. Supports linear AND
    // parallel fan-out/fan-in (JUCE APG sums multiple inputs). Fail-closed:
    //   - no complete Track Input -> Track Output path  -> silence (ok, "disconnected")
    //   - missing/placeholder/unmapped active effect    -> silence (ok=false, reason)
    //   - cycle / invalid payload                        -> silence (ok=false, reason)
    // Graph-owned processors and effectChains are never mutated.
    nlohmann::json syncGraphTopology(const nlohmann::json& topology);

    // Backward-compatible alias. Delegates to syncGraphTopology (which now also
    // handles parallel topologies). Retained so existing callers/tests compile.
    nlohmann::json syncLinearGraphTopology(const nlohmann::json& topology);

    // FXG.3-d adoption: register already-allocated chain processors as
    // graph-owned, preserving their parameter state, when a Mixer Chain is
    // converted to a graph. Input: array of { effectInstanceId, engineNodeId }.
    // Idempotent; skips entries whose engineNodeId is not a live effect node.
    // Returns { ok, adopted, skipped }. Never creates or destroys processors.
    nlohmann::json adoptGraphNodes(const nlohmann::json& mapping);

    // ── FXG.4-a graph-owned effect parameter descriptors (main thread) ──
    // Resolve a graph-owned effectInstanceId to its engine node and return a
    // unified normalized [0,1] parameter view (stock APVTS or host-discovered
    // plugin parameters). Operate ONLY on graph-owned effect instances; never
    // touch chain-slot editing. Fail safely with a `reason`:
    //   unknown_effect_instance — effectInstanceId not mapped to a live node
    //   plugin_missing          — node holds a missing-plugin placeholder
    //   processor_unavailable / plugin_unavailable / unknown_parameter / set_failed
    nlohmann::json getGraphEffectParameters(const std::string& effectInstanceId) const;
    nlohmann::json getGraphEffectParameterValue(const std::string& effectInstanceId,
                                                const std::string& parameterId) const;
    nlohmann::json setGraphEffectParameterNormalized(const std::string& effectInstanceId,
                                                     const std::string& parameterId,
                                                     float normalizedValue);

    // ── Automation parameter binding (Phase A, main thread) ─────────────
    //
    // Automation addresses a parameter the same way sidechain routing addresses
    // an effect: by the STABLE string effectInstanceId, resolved through
    // getNodeIdForEffectInstance (chain-mode AND graph-owned, unlike the
    // getGraphEffect* family, which only knows graph-owned instances). That
    // matters because automation must work on ordinary mixer inserts and on the
    // Master chain, neither of which is an FX Graph.
    //
    // resolveAutomationParameter hands back the raw APVTS atomic the effect's own
    // DSP reads each block plus its normalisable range, so the audio thread can
    // publish a value with a single relaxed store and let the effect's existing
    // per-parameter smoother do the ramping (see XlethEffectBase's own comment).
    // Stock effects only — a wrapped VST3 exposes no such pointer, and VST3
    // automation is explicitly out of scope for v1.
    struct AutomationParameterHandle
    {
        std::atomic<float>*           raw   = nullptr;  // written on the audio thread
        juce::RangedAudioParameter*   param = nullptr;  // range only (pure math)
        bool valid() const { return raw != nullptr && param != nullptr; }
    };

    // Returns an invalid handle when the instance is unknown, is a missing-plugin
    // placeholder, is not a stock effect, or has no such parameter.
    AutomationParameterHandle resolveAutomationParameter(const std::string& effectInstanceId,
                                                         const std::string& parameterId);

    // True iff (effectInstanceId, parameterId) resolves to an automatable stock
    // parameter on this chain. Backs the plan builder's dead-clip detection.
    bool canAutomate(const std::string& effectInstanceId,
                     const std::string& parameterId);

    // Current NORMALIZED [0,1] value of an automatable parameter. Returns false
    // when it does not resolve. Used to seed a base value the project has never
    // recorded (the knob's current position).
    bool getAutomationParameterNormalized(const std::string& effectInstanceId,
                                          const std::string& parameterId,
                                          double& outValue);

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

    // Audio thread: forward a per-track note/clip modulation gate to every effect
    // in this chain (a no-op for effects that don't consume it — only the Xleth
    // Filter's per-slot Envelope does). No allocation.
    void deliverModulationGate(bool valid, std::int64_t gateStartSample,
                               std::int64_t gateEndSample);

    // Main thread: true iff this chain holds an Xleth Filter with an enabled
    // per-slot Envelope modulator; `wantSlidesOut` is set to the slide-note
    // opt-in union across those filters (the gate is per-track).
    bool anyFilterHasActiveEnvelope(bool& wantSlidesOut) const;

    // Returns the raw AudioProcessor for any node (stock or VST3).
    // Used by PluginEditorHost to obtain the processor for GUI creation.
    juce::AudioProcessor* getProcessor(int nodeId);

    // Returns the plugin file path (PluginDescription::fileOrIdentifier) for a
    // VST node.  Returns empty string for stock effects or if nodeId not found.
    juce::String getPluginFilePath(int nodeId) const;
    // Full PluginDescription of a VST node (editor host INIT v2). False for stock.
    bool getPluginDescription(int nodeId, juce::PluginDescription& out) const;

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

    // ── Lock-free realtime view (Finding 9) ─────────────────────────────
    // The audio thread reads chain contents through an immutable snapshot
    // instead of the live node model, so it never has to hold MixEngine's
    // chainsMutex_. See the RealtimeView note at the top of AudioGraph.h.
    //
    // realtimeView() is the audio-thread accessor (one atomic load, never
    // null). refreshRealtimeView() is the message-thread republish, called by
    // MixEngine::publishChainSnapshotLocked() after every chain mutation.
    using RealtimeView = xleth::audio::GraphRealtimeView;
    std::shared_ptr<const RealtimeView> realtimeView() const noexcept;
    void refreshRealtimeView();

    // ── Sidechain key injection (Prompt 4C+4D groundwork) ───────────────
    // True iff this chain currently owns a sidechain-capable node (and therefore
    // a SidechainSourceProcessor wired to it). Main thread.
    bool hasSidechainCapableNode() const;

    // Message thread, allocation-free. Forwards to
    // AudioGraph::visitEffectsInChainOrder — see there for the order contract.
    // The signature matches AudioGraph::EffectVisitor (not named here because
    // this header only forward-declares AudioGraph).
    void visitEffectsInChainOrder(void* context,
                                  void (*visit)(void* context, int nodeId,
                                                XlethEffectBase* effect)) const;

    // Borrow this block's per-target key audio for the chain's sidechain source
    // node. No-op when the chain has no sidechain source. MixEngine calls these
    // around processBlock — under the chains lock, same thread, same block.
    void setSidechainKeyBuffer(const float* left, const float* right, int numSamples) noexcept;
    void clearSidechainKeyBuffer() noexcept;

    // Main-thread (Prompt 5A): enable the sidechain input bus on every capable
    // stock effect (compressor) whose effectInstanceId is in `enabledInstanceIds`
    // and disable it on all others, re-preparing the chain when anything changes.
    // Returns true iff a layout changed. Idempotent.
    bool applySidechainTargetInstances(const std::set<std::string>& enabledInstanceIds);

    // VST-SC.3: true iff `effectInstanceId` resolves on this chain AND its node is
    // sidechain-capable (stock compressor or a probed-capable wrapped plugin). Used
    // by route validation to reject incapable targets with sidechain_unsupported.
    // Session-only capability — never persisted.
    bool isEffectInstanceSidechainCapable(const std::string& effectInstanceId) const;

    // Reset all processors in the chain. Intended for transport jumps.
    void resetProcessors();

    // ── Off-thread reset handshake ──────────────────────────────────────
    // AudioProcessor::reset() is not realtime-safe in general (VST3 plugins
    // allocate; an unprimed Pitch Shifter primes its vendored shifter), so
    // live playback never runs one of THOSE from the audio callback. A
    // non-realtime worker resets them instead (a whole chain after a stop;
    // after a jump, only what resetOnAudioThread below left), and this claim
    // keeps that reset from ever overlapping the chain's own processing.
    // Dekker-style: each side publishes its flag (seq_cst), then reads the
    // other's, so at most one side proceeds.
    //
    //   Audio thread: if (beginRealtimeUse()) { ...use chain...; endRealtimeUse(); }
    //                 else the chain is mid-reset — leave it alone this block.
    //   Worker:       tryResetProcessorsOffThread() returns false when the audio
    //                 thread was inside the chain; retry. Caller holds the
    //                 owner's chains lock (no concurrent chain mutation).
    bool beginRealtimeUse() noexcept;
    void endRealtimeUse() noexcept;
    bool tryResetProcessorsOffThread();

    // ── Transport-jump reset (seek, loop wrap, play after an audition) ───
    // A jump resets the PDC compensation delay lines inline, in the jump
    // block, so the chain has to restart in that same block: reset any later
    // and a latent effect (the Pitch Shifter's ~200 ms pipeline) first plays
    // pre-jump audio out of its pipeline, then drops the post-jump audio it
    // absorbed before the reset landed - misaligned against every
    // compensated track, differently on every lap of a loop.
    //
    //   Audio thread: resetOnAudioThread() in the jump block. Claims the
    //                 chain, resets every node that can reset realtime safely
    //                 (AudioGraph::resetProcessorsOnAudioThread), and flags
    //                 the rest. Returns false when the worker has work left.
    //   Worker:       tryResetDeferredOffThread() resets only what was left
    //                 (VST3 nodes, effects that declined) - never a node the
    //                 audio thread already reset, which would re-open the
    //                 misalignment. If the audio thread could not claim the
    //                 chain at all (worker inside it), the whole chain is reset
    //                 here instead. Same claim contract and return value as
    //                 tryResetProcessorsOffThread; true when nothing is pending.
    bool resetOnAudioThread() noexcept;
    bool tryResetDeferredOffThread();

    // The expensive half of a reset, run by the worker BEFORE claiming, while
    // the audio thread keeps processing the chain: effects prime whatever
    // their reset() would otherwise build inline (the Pitch Shifter's spare
    // shifter), so the claimed reset is a swap and the chain is silent for
    // microseconds instead of the ~30 ms an inline prime took. Same caller
    // contract as tryResetProcessorsOffThread (owner's chains lock held).
    void primeDeferredReset();

    // Returns the maximum getTailLengthSeconds() across all effect nodes.
    double getMaxTailLengthSeconds() const;

    // Returns the cumulative latency at the chain output in samples.
    int getOutputLatencySamples() const;
    std::uint64_t getLatencyEpoch() const;
    void refreshLatencyDiagnostics();

    // [PDCNotify] See AudioGraph::servicePendingLatencyChange. Non-realtime;
    // caller holds the owner's chains lock.
    bool hasPendingLatencyChange() const;
    bool servicePendingLatencyChange();

    int addProcessorForTesting(const std::string& pluginId,
                               std::unique_ptr<juce::AudioProcessor> proc,
                               int position);

private:
    std::unique_ptr<AudioGraph> graph_;

    std::atomic<bool> realtimeInUse_   { false };
    std::atomic<bool> resetInProgress_ { false };
    // Set by the audio thread's jump reset for tryResetDeferredOffThread.
    std::atomic<bool> deferredResetPending_ { false };   // some nodes were left
    std::atomic<bool> fullResetPending_     { false };   // the claim failed

    // Graph-owned effect instances: stable effectInstanceId → APG uid.
    // Session-only at runtime. Serialized additively on graph-owned nodes so a
    // loaded AudioGraph can rebuild the runtime mapping without treating
    // graphState node ids as engine ids. Never used by chain-mode APIs.
    std::unordered_map<std::string, int> graphNodeIds_;
};

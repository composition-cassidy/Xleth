# Mixer Bus Routing + Sidechain — Architecture Audit

Read-only audit of XLETH's audio routing architecture, plus the source-of-truth implementation
plan for **audible bus routing** and **silent sidechain routing**. No source code was modified in
this pass. Implementation prompts 2–6 (§8) must be derivable from this document without guessing.

Reference briefs: `docs/txt/xleth_mixer_routing_feature_brief.txt`,
`docs/txt/juce_audio_graph_sidechain_reference.txt`.

## Terminology (binding for all later prompts)

These three concepts are **never** conflated, in code, schema, or UI copy:

1. **Output routing (bus routing)** — audible path *ownership*. A track's main output points at
   exactly one destination: Master (default) or another track ("bus"). When routed to a bus, the
   source does **not** also sum into Master. This is the double-monitoring guard.
2. **Parallel send** — an *additional* copy of a track's signal into another track, on top of its
   main output. Separate explicit state, reserved in the schema, deferred in implementation.
3. **Sidechain route** — a *silent* detector/key signal from a source track into a target effect's
   sidechain input (or a graph-mode track's protected Sidechain Input node). Contributes zero
   audible signal to the target's output. Never implemented as an audible send.

---

## 1. Current architecture map

### 1.1 Process/thread topology

```
Electron renderer (React/zustand)
   │  window.xleth.* (ui/preload.js, contextBridge → ipcRenderer.invoke)
Electron main (ui/main.js)
   │  ipcMain.handle('xleth:…') → callWorker(method, args)   [ui/main.js:346]
Forked Node child process (worker/addon-worker.js, child_process.fork at ui/main.js:298)
   │  N-API addon (bridge/src/XlethAddon.cpp — exports `timeline_*`, `audio_*`, `project_*`, `undo_*`)
C++ engine
   ├─ main/message thread: Timeline model, ProjectManager, UndoManager, chain mutations
   └─ audio thread: AudioEngine device callback → MixEngine::processBlock
```

### 1.2 Track audio processing (realtime)

- `engine/src/AudioEngine.h` — owns `MixEngine mixEngine_` (line 94); JUCE device callback
  `audioDeviceIOCallbackWithContext` (line 26) drives it.
- `engine/src/audio/MixEngine.{h,cpp}` — **the** multi-track mixer.
  `MixEngine::processBlock(outputBuffer, numSamples, transport)` at `MixEngine.cpp:3861`.
  Per block, in order:
  1. Track slot table built from `timeline_->getAllTracks()` in list order
     (`MixEngine.cpp:4035-4041`); `trackIdToSlot` map; slots are transient indices `0..63`
     (`kMaxTracks = 64`, `MixEngine.h:80`).
  2. Clip rendering into per-slot `trackBuffers_[slot]` (`MixEngine.cpp:4051+`), pattern/sampler
     rendering (`~4352-4375`).
  3. Per-track onset MIDI buffers `trackMidiBuffers_` populated (`4390-4469`).
  4. `chainsMutex_` acquired (try_lock realtime, blocking when `nonRealtime_`) (`4497-4513`).
  5. PDC accounting: per-track chain latency, `maxAudibleTrackLatency`, compensation =
     `max − own` cached per slot (`4530-4589`).
  6. Per-track loop (`4653-4811`):
     - mute/solo gate: `shouldPlay = anySolo ? track->solo : !track->muted`
       (`MixEngine.cpp:4682`) — **flat**, no routing awareness;
     - insert chain: `effectChains_[trackId]->processBlock(trackBuffers_[i], …)`
       (`MixEngine.cpp:4737`);
     - tail drain bookkeeping `tailEndSamples_[i]` (`4748-4758`);
     - smoothed fader (`4760-4771`), pan/spread/peaks via `TrackMixer::process`
       (`MixEngine.cpp:4779`, impl `engine/src/audio/TrackMixer.{h,cpp}`);
     - PDC alignment `trackCompensationDelays_[i].process(...)` (`4794`, class
       `StereoCompensationDelay`, `MixEngine.h:664-693`);
     - **hard-coded direct sum into Master**: `outputBuffer.addFrom(ch, 0, trackBuffers_[i], …)`
       (`MixEngine.cpp:4806-4810`). ← *This is the line bus routing replaces.*
  7. Preview/audition sampler bus mixes straight into master, bypassing track routing
     (`4813-4827`).
  8. `MasterInputSum` diagnostic tap (`4829`), master insert chain
     `masterEffectChain_->processBlock(outputBuffer, …)` (`MixEngine.cpp:4847`), master volume,
     hard clamp, `PostMasterOutput` tap.
- Diagnostic taps: `MixEngine::DiagnosticTapPoint { PrePdcTrack, PostPdcTrack, MasterInputSum,
  PostMasterOutput }` (`MixEngine.h:177-218`) — consumed by
  `ui/src/components/debug/AudioPerformanceDiagnosticsPanel.jsx` tooling and scenario runner.

### 1.3 Mixer / effect chain processing

- `engine/src/audio/EffectChainManager.{h,cpp}` — thin per-track wrapper over `AudioGraph`.
  One instance per track keyed by **trackId** in `MixEngine::effectChains_`
  (`MixEngine.h:826`), plus `masterEffectChain_` (`MixEngine.h:827`). Master is chain-only.
- `engine/src/audio/AudioGraph.{h,cpp}` — owns one `juce::AudioProcessorGraph` **per track
  chain** (not one global graph). Provides:
  - cycle rejection via DFS `wouldCreateCycle` (`AudioGraph.h:340`),
  - Kahn topological sort with levels (`AudioGraph.h:344`),
  - PDC inside the chain: `computePDC()` (`AudioGraph.h:347`) inserting
    `DelayCompensationProcessor` helper nodes (`engine/src/audio/DelayCompensationProcessor.h`),
  - per-wire gain/mute via `WireGainProcessor` (`engine/src/audio/WireGainProcessor.h`),
  - 50 ms debounced APG rebuild; chain mode (`addEffect/removeEffect/moveEffect`) and graph mode
    (`replaceConnectionsWithGraph` `AudioGraph.h:86`, fail-closed
    `clearConnectionsToSilence` `AudioGraph.h:97`).
  - **Hard stereo lock**: APG configured `setPlayConfigDetails(2, 2, …)` at `AudioGraph.cpp:123`
    (init), `:162` (reprepare); every node forced to (2,2) in `addProcessorToGraph`
    (`AudioGraph.cpp:175`). I/O nodes are `AudioGraphIOProcessor` stereo pair
    (`AudioGraph.cpp:126-132`).

### 1.4 JUCE AudioProcessorGraph usage / plugin hosting

- Stock effects: `XlethEffectBase` subclasses in `engine/src/audio/*.h`
  (e.g. `XlethCompressorEffect.h`, `XlethOTTEffect.h`, `XlethLimiterEffect.h`). All stereo
  in/stereo out. "Sidechain" in the stock compressor today means the **internal** detector path
  only — pre-delay key tap (`XlethCompressorEffect.h:249-251`) plus detector HP/LP params
  `wc_hp` / `wc_lp` (`engine/src/audio/StockParameterCatalog.cpp:154-155`). **No external
  sidechain input exists anywhere in the engine.**
- Third-party VST3: `AudioGraph::createEffect` (`AudioGraph.cpp:~2440-2564`) — stock-id map,
  then `PluginRegistry` (`engine/src/audio/PluginRegistry.{h,cpp}`,
  `AudioPluginFormatManager` + `KnownPluginList`) fallback. Instantiation **forces a
  single stereo in + stereo out layout** (`AudioGraph.cpp:2530-2541`) and wraps the instance in
  `GuardedPluginWrapper` (SEH crash guard, `engine/src/audio/GuardedPluginWrapper.h`). Sidechain
  buses are never inspected or enabled.
- Utility processors (`engine/src/audio/UtilityProcessors.h`): balance/merge/MS/frequency
  splitter graph nodes — precedent for adding small special-purpose APG nodes.

### 1.5 Track IDs vs engine node IDs (four ID spaces — never collapse)

| ID | Type | Scope | Where |
|----|------|-------|-------|
| `trackId` | int | persisted, stable | `TrackInfo.id` (`TimelineTypes.h:950`), Timeline auto-increment |
| slot index | int 0..63 | per-block transient | `MixEngine::trackIdToSlot_` (`MixEngine.h:793`) |
| engine node id (APG uid) | int | per-session transient | `AudioGraph::nodes_` key; surfaced to UI as `nodeId`; remapped on load (`AudioGraph::fromJSON(…, oldToNewNodeIds)` `AudioGraph.h:202`) |
| `effectInstanceId` | UUID string | persisted (graph mode only, today) | graphState `node.data.effectInstanceId`; runtime map `EffectChainManager::graphNodeIds_` (`EffectChainManager.h:228`) |

Project rule (already enforced for FX Graph, extended by this plan): **persisted state never
contains raw APG uids.**

### 1.6 FX Graph graphState persistence and runtime mapping

- Renderer-owned document: `TrackInfo.graphState` (opaque JSON to the engine,
  `TimelineTypes.h:1011-1012`), ownership gate `TrackInfo.fxMode` (`chain|graph`,
  `TimelineTypes.h:1007`); master always chain.
- Schema: `ui/src/fxgraph/graphState.js` — `GRAPH_STATE_SCHEMA_VERSION = 1` (line 13), node
  types `trackInput, trackOutput, effect, macro, envelope` (lines 47-53), edge types
  `audio, parameter` (line 54), `PROTECTED_NODE_TYPES = ['trackInput','trackOutput']`
  (line 1067), guard `isProtectedGraphNodeType` (line 1098), pure mutation helpers with
  `GRAPH_MUTATION_REJECTION` codes. Port conventions: `trackInput→'audio'`,
  effect `'audioIn'/'audioOut'`, `trackOutput→'audio'`.
- Store: `ui/src/stores/effectChainStore.js` — state `chains, fxModes, fxPanelViews,
  graphStates, graphStateStatuses, graphEngineNodeIds, graphRuntimeStatuses, graphHistories`
  (lines 1042-1064); graph mutations at 1516-1922; session-only graph undo/redo 1421-1515;
  chain ops 2281-2363.
- Runtime sync path: store → `window.xleth.audio.syncGraphTopology` (`ui/preload.js:383`) →
  `xleth:audio:syncGraphTopology` (`ui/main.js:1789`) → `audio_syncGraphTopology`
  (`XlethAddon.cpp:13493`) → `MixEngine::syncGraphTopology` (`MixEngine.h:537`) →
  `EffectChainManager::syncGraphTopology` (`EffectChainManager.h:136`) — validates payload,
  resolves `effectInstanceId → engine uid`, rebuilds the track APG fail-closed to silence.
  Hydration after load: `hydrateGraphEffectNodes` (`MixEngine.h:527`), adoption on chain→graph
  conversion: `adoptGraphEffectNodes` (`EffectChainManager.h:147`).
- Panels: `ui/src/windowing/panels/FxGraphPanel.tsx`,
  `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx`,
  `GraphNodeParameterInspector.tsx`. Docs: `docs/dev/fxgraph-architecture.md`,
  `docs/dev/fxgraph-runtime-architecture-audit.md`.
- **Quarantined — do not touch**: `ui/src/stores/nodeGraphStore.js`,
  `ui/src/components/mixer/NodeEditor.jsx`, `ui/src/windowing/panels/NodeEditorPanel.tsx`
  (legacy React-Flow node editor).

### 1.7 Project save/load

- `engine/src/project/ProjectManager.{h,cpp}` — project dir with `project.json`.
  `saveProject(timeline, effectChains, masterEffectChain)` (`ProjectManager.h:31`) writes the
  Timeline plus top-level `"effectChains"` (object keyed by **trackId string**) and
  `"masterEffectChain"`. `loadProject` (`ProjectManager.h:53`) stashes them in
  `loadedEffectChains_` for the bridge.
- Track fields serialize via ADL `to_json/from_json(TrackInfo)` in
  `engine/src/model/Track.cpp:214` / `:352`. Convention for additive fields:
  `j.value("field", default)` — `fxMode`/`graphState` were added this way with no version bump.
  `kProjectFileVersion = 3` (`TimelineTypes.h:1052`).
- Bridge: `Project_Save` (`XlethAddon.cpp:3426`) uses `buildEffectChainsJSON`
  (`XlethAddon.cpp:3393`, only tracks with non-empty chains). `Project_Load`
  (`XlethAddon.cpp:3626`) order: load → close plugin editors → swap Timeline → clear undo →
  rebuild region/sample maps → `rebuildAllSamplers` → restore chains via
  `loadEffectChainFromJSON` per track (`3734-3746`) → `refreshLivePresentationLatency`.

### 1.8 Mute/solo

- Model: `TrackInfo.muted` / `.solo` / `.visualOnly` (`TimelineTypes.h:955-957`); persisted.
- Engine gate: `MixEngine.cpp:4682` (see §1.2). `visualOnly` excluded from PDC "audible" set
  (`4553`).
- Undo-tracked mutations: `SetTrackMutedCommand` (`engine/src/commands/TimelineCommands.h:400`),
  `SetTrackSoloCommand` (`:428`), executed via `g_undoManager->execute(...)` in
  `Timeline_SetTrackSolo` (`XlethAddon.cpp:4504-4526`).
- UI: `ui/src/stores/mixerStore.js` (`toggleMute`/`toggleSolo`), strip buttons in
  `ui/src/components/mixer/MixerStrip.jsx`.

### 1.9 Offline export / render

- `engine/src/export/AudioExporter.{h,cpp}` — drives **the same** `MixEngine::processBlock`
  with a local Transport: `exportAudio` (`AudioExporter.h:79`), `renderOffline` (`:96`),
  wrap/tail-fold `renderOfflineWrap` (`:125`), pre-roll `computePrerollPlan` (`:60`) built from
  `maxAudibleTrackLatencySamples + masterInsertLatencySamples`. `setNonRealtime(true)` switches
  the chains lock to blocking so chains are never skipped. Video export audio uses the same
  engine path. **Consequence: implementing routing inside MixEngine::processBlock gives
  realtime/export parity for free** — but the pre-roll plan and tail policies must learn the new
  path-latency model (§4.7).

### 1.10 IPC / preload / store boundaries

- Bridge exports (selection): track mutations `timeline_setTrackMuted/Solo/FxMode/GraphState`
  (`XlethAddon.cpp:13265-13270`); chain ops `audio_addEffect/removeEffect/moveEffect/
  setEffectBypass/getEffectChain/...` (`13435+`); master variants (`13447+`); graph ops
  `audio_addConnection/.../audio_syncGraphTopology/audio_adoptGraphEffectNodes`
  (`13475-13495`); `project_save/saveAs/load` (`13232-13235`); undo bridge `undo_undo/redo/...`
  (handlers `ui/main.js:1532-1550`).
- Preload (`ui/preload.js`) groups them as `window.xleth.timeline.*` (line 146 pattern),
  `window.xleth.audio.*` (323, 383). Electron main (`ui/main.js`) is a 1:1 `callWorker` shim
  (e.g. line 720).
- Renderer stores: `mixerStore.js` (volume/pan/spread/mute/solo, peaks snapshot),
  `effectChainStore.js` (chains + graph mode), `ui/src/components/mixer/MixerPanel.jsx` +
  `MixerStrip.jsx` + `MasterStrip.jsx` + `EffectChainPanel.jsx` (strip UI).

### 1.11 Tests today

- Engine (CMake `add_executable`, plain `int main()` assert style — e.g.
  `engine/CMakeLists.txt:670` for `test_mix`): `engine/test/test_mix.cpp`,
  `test_pdc_stage1.cpp` (PDC), `test_offline_render.cpp`, `test_tail_render.cpp`,
  `test_undo.cpp`, `test_project.cpp`, `test_effects.cpp`,
  `test_graph_effect_parameters.cpp`, `test_timeline.cpp`.
- Renderer: vitest (`ui/package.json` `"test": "vitest run"`), colocated `*.test.js(x)` —
  `effectChainStore.test.js`, `fxgraph/graphState.test.js`,
  `windowing/panels/fxgraph/GraphStatePreview.test.tsx`, etc.

---

## 2. Existing capability assessment

### 2.1 Already in place that bus routing can build on

- Per-track buffers, per-track insert chains keyed by stable `trackId`, and a single explicit
  summing point (`MixEngine.cpp:4806`) — the change surface is concentrated.
- Tail-drain machinery (`tailEndSamples_`) and per-track `StereoCompensationDelay` — reusable
  for bus paths.
- Cycle rejection + topological sort already exist *within* a chain (`AudioGraph`) — the same
  algorithms (DFS + Kahn) are the template for the *track-level* routing graph.
- Offline export reuses `MixEngine::processBlock` → parity by construction.
- Undo command pattern (`Command`/`UndoManager`, `g_undoManager->execute`) ready for routing
  commands.
- Track persistence with additive-default convention (`Track.cpp from_json` + `j.value`).

### 2.2 Already in place that sidechain can build on

- JUCE APG inside each track chain supports per-channel connections — a >2-channel plugin node
  can receive its sidechain bus channels from a dedicated source node.
- `effectInstanceId` stable-ID system (graph mode) — the correct persistent address for "this
  specific effect instance" sidechain targets.
- FX Graph protected-node machinery (`PROTECTED_NODE_TYPES`, mutation guards, fail-closed
  `syncGraphTopology`) — the Sidechain Input node slots into an existing pattern.
- Stock compressor already has a detector path with key filters — external key only needs to
  replace the internal tap.

### 2.3 What must be added

- A persistent routing model on `TrackInfo` (output route, reserved sends, sidechain routes).
- Track-level routing graph in MixEngine: topo-ordered track processing, bus summing into target
  buffers, removal of the unconditional master sum.
- Solo/mute closure semantics over the routing graph.
- Hierarchical PDC (junction-based) replacing the flat "align all at master" model.
- Stable `effectInstanceId` for **chain-mode** nodes (today only graph mode has them).
- Sidechain tap collection + per-target sidechain buffers + APG injection node.
- Multi-bus support in the per-track APG (relax the 2,2 lock), sidechain bus probing/enabling
  for VST3s, sidechain buses on selected stock effects, `GuardedPluginWrapper` bus mirroring.
- FX Graph `sidechainInput` node type + `sidechainIn` effect port + runtime mapping.
- Bridge APIs, undo commands, renderer stores/UI.

### 2.4 Assumptions that break if routing is added naively

- **"Every track sums to Master"** (`MixEngine.cpp:4806`) — the core assumption; naive "also add
  to bus" creates exactly the double-monitoring bug the brief forbids.
- **Track processing order = track list order** — a bus earlier in the list than its source
  would read an empty buffer (one-block latency or silence). Topological order is mandatory.
- **Flat PDC** — `maxAudibleTrackLatency − ownLatency` (`4530-4575`) is wrong once paths nest:
  a source feeding a bus with a 1024-sample compressor would be compensated as if parallel to
  it. Comb filtering/wrong alignment results.
- **Flat solo** — soloing a Drum Bus would silence Kick/Snare (its inputs), producing silence.
- **`hasAudio`/tail gating per track** (`4695-4707`) — a bus with no clips of its own would be
  skipped entirely even while sources feed it.
- **Export pre-roll plan** (`AudioExporter::computePrerollPlan`) assumes flat track latency; bus
  chains add path latency the warm-up must cover.
- **Chain JSON has no stable per-node identity** — sidechain routes persisted against APG uids
  would silently dangle after reload (uids are remapped).
- **2-channel lock in AudioGraph** — any 4-channel sidechain-enabled plugin node violates
  `setPlayConfigDetails(2,2)` assumptions at three sites (`AudioGraph.cpp:123/162/175`).
- `GuardedPluginWrapper` constructs with its own (stereo) bus config; with a multi-bus inner
  plugin the wrapper's layout must mirror the inner or APG channel wiring misroutes.
- Preview/audition bus and `previewBuffer_` bypass routing — fine (audition is master-direct by
  design), but must be explicitly excluded from routing logic.

---

## 3. Proposed persistent data model

All routing state lives on the **source** track inside `TrackInfo`, serialized in
`engine/src/model/Track.cpp` `to_json/from_json` with additive defaults (no
`kProjectFileVersion` bump required; matches the `fxMode` precedent). **No APG uids are ever
persisted.**

### 3.1 TrackInfo additions (C++ model, `engine/src/model/TimelineTypes.h`)

```cpp
// ─── Mixer routing (audible) ────────────────────────────────────────────
struct TrackOutputRoute {
    // -1 = Master (default). Otherwise a normal track's id ("bus").
    int targetTrackId = -1;
};

// Reserved for a later phase. Parallel copy on top of the main output.
struct TrackSend {
    std::string routeId;        // UUID, generated by bridge on create
    int   targetTrackId = -1;
    float gain          = 1.0f; // 0..2
    float pan           = 0.0f; // -1..+1
    bool  preFader      = false;
    bool  enabled       = true;
};

// Silent detector/key route. NEVER audible through the target.
struct SidechainRoute {
    std::string routeId;                 // UUID, generated by bridge on create
    int         targetTrackId = -1;      // track receiving the key signal
    // Empty string = track-level sidechain bus (graph-mode Sidechain Input node).
    // Non-empty = a specific effect instance on the target track (chain or graph).
    std::string targetEffectInstanceId;
    float gain     = 1.0f;               // key gain 0..2
    bool  preFader = false;              // tap point on the SOURCE: post-fader default
    bool  enabled  = true;
};

struct TrackInfo {
    // … existing fields …
    TrackOutputRoute            outputRoute;     // default: Master
    std::vector<TrackSend>      sends;           // default: empty (reserved)
    std::vector<SidechainRoute> sidechainRoutes; // default: empty
};
```

### 3.2 project.json shape (per track object)

```jsonc
{
  "id": 3, "name": "Kick", "...": "...",
  "outputRoute": { "targetTrackId": 7 },          // omitted entirely when Master
  "sends": [],                                     // omitted when empty
  "sidechainRoutes": [
    {
      "routeId": "sc-5b1f0c0e-…",
      "targetTrackId": 9,
      "targetEffectInstanceId": "e-aa12…",         // "" → track-level SC bus (FX Graph)
      "gain": 1.0,
      "preFader": false,
      "enabled": true
    }
  ]
}
```

### 3.3 Stable chain-node identity (prerequisite for sidechain targets)

Chain-mode effect nodes gain a persistent `effectInstanceId` (UUID string):

- Assigned at `MixEngine::addEffect` time (bridge generates, or engine generates and returns it
  in `getEffectChainState`).
- Persisted additively inside the existing chain JSON (`AudioGraph::toJSON`,
  `AudioGraph.h:200`) next to each node — the graph-owned path already does exactly this
  (`EffectChainManager.h:100-103`); extend it to chain nodes.
- On `fromJSON`, missing ids are generated (old projects) — the load-time
  `oldToNewNodeIds` remap already proves uids are transient.
- New lookup: `EffectChainManager::getNodeIdForEffectInstance(const std::string&) → int`
  (unified for chain + graph nodes).

### 3.4 Validation invariants (mutation layer, pure + unit-testable)

Enforced in `Timeline` setters (pattern: `normalizeLoopRegion`, `TimelineTypes.h:1177`):

- `outputRoute.targetTrackId` ∈ {-1} ∪ {existing normal track ids}; never self; never the
  master pseudo-track; never a `visualOnly`-incapable target type (Clip and Pattern tracks are
  both valid bus targets — a "bus" is just a normal track).
- Adding/changing any route (output, send, or sidechain) must not create a cycle in the union
  graph of all three edge kinds (§4.4). Reject with reason `cycle`.
- Sidechain `targetEffectInstanceId` must resolve on the target track at apply time; if it does
  not (plugin missing, node deleted), the route persists but is reported `stale` and is not
  wired (fail-closed silent).
- Master: no `outputRoute` field is ever read for master; master cannot be a route *source*;
  master **is** a valid output target (the default).

### 3.5 Migration / defaults

- Old projects: fields absent → `outputRoute = Master`, empty `sends`/`sidechainRoutes` —
  bit-identical playback to today. Covered by `j.value(...)` defaults; add a
  `test_project.cpp` round-trip case.
- Saving with defaults omits the keys (compactness convention, see `trackColorSlot`
  serialization in `Track.cpp:249-257`).
- Forward-compat: unknown extra keys in route objects are preserved? No — the engine model is
  typed; document that route objects are engine-owned schema (unlike opaque `graphState`).

---

## 4. Engine implementation plan — audible bus routing

### 4.1 Routing snapshot (main thread → audio thread)

New `MixEngine` member rebuilt on the main thread whenever tracks or routes change
(call it from the bridge after every routing mutation, mirroring
`syncTrackSlotsFromTimeline`, `MixEngine.h:410`):

```cpp
struct RoutingSnapshot {
    // index = slot (same slot space as trackBuffers_)
    struct SlotRoute {
        int  outputTargetSlot = -1;       // -1 = master sum
        bool audible          = true;     // solo/mute closure result (§4.5)
        bool feedsSidechainOnly = false;  // processed silently for SC keys (§5)
        std::vector<SidechainTap> scTaps; // {targetSlot, gain, preFader}
    };
    std::vector<int>       topoOrder;     // slots in processing order
    std::vector<SlotRoute> slots;
    uint64_t               generation;
};
std::shared_ptr<const RoutingSnapshot> routingSnapshot_;  // atomic load in processBlock
```

Audio thread does `std::atomic_load`-style shared_ptr read once per block; never blocks on
`chainsMutex_` for routing (a missed chain lock must not collapse routing back to
"everything → master").

### 4.2 Bus summing (the core edit, `MixEngine::processBlock`)

Replace the slot loop `for (int i = 0; i < numTrackSlots; ++i)` (`MixEngine.cpp:4653`) with
iteration over `snapshot->topoOrder`. Per slot, processing stays exactly as today through PDC
(`chain → fader → pan/spread → compensation delay`), then the final sum becomes:

```cpp
const int target = snapshot->slots[i].outputTargetSlot;
if (target < 0)
    outputBuffer.addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples);   // Master
else
    trackBuffers_[target].addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples); // Bus input
```

- Clip/pattern rendering (which happens in earlier loops into `trackBuffers_`) is order-independent
  and untouched; bus tracks may have their own clips — routed input simply **adds** to them
  before the bus's chain runs (topo order guarantees the bus's slot loop iteration happens after
  all its sources).
- **No accidental Master duplication**: a routed track touches `outputBuffer` zero times — its
  only path to master is through its target's (transitive) output route. There is no
  "and also master" branch anywhere.
- Track activity: extend the `hasAudio` gate (`MixEngine.cpp:4695`) —
  `hasAudio = hasClips || hasReleasingVoices || receivedRoutedInputThisBlock`, where the flag is
  set when a source with audio/tail routes into this slot. This keeps bus chains running and
  lets `tailEndSamples_` drain bus reverbs correctly.

### 4.3 Topological ordering

- Build in `RoutingSnapshot` construction: nodes = active slots + virtual master; edges =
  output routes ∪ sends ∪ sidechain routes (sidechain creates a processing-order dependency:
  the key must be produced before the target's chain consumes it in the same block).
- Kahn's algorithm (same as `AudioGraph::topologicalSortWithLevels`, `AudioGraph.h:344`).
  Snapshot construction asserts acyclicity; cycles are rejected earlier at the mutation layer,
  so a cycle here is a programming error → fail-closed: fall back to all-to-master + log.

### 4.4 Cycle / self-route prevention and route validation

- Pure validator `xleth::validateRouting(const Timeline&, proposedEdge) → {ok, reason}` in a
  new `engine/src/audio/TrackRouting.{h,cpp}` (free functions, unit-testable like
  `RenderScope`): reasons `self_route`, `cycle`, `unknown_track`, `master_as_source`,
  `target_is_self`, `unknown_effect_instance`, `sidechain_unsupported`.
- Called by `Timeline::setTrackOutputRoute / addSidechainRoute / …` before commit; bridge
  surfaces `{ ok:false, reason }` to the renderer; engine `RoutingSnapshot` re-validates
  defensively (fail-closed to master).
- DFS reachability check identical in spirit to `AudioGraph::wouldCreateCycle`
  (`AudioGraph.h:340`); include all three edge kinds (decision: sidechain edges participate in
  cycle rejection in v1 — no Live-style feedback routing; revisit later with an explicit
  one-block-delay edge type if ever needed).

### 4.5 Mute / solo behavior (explicit policy)

Computed on the main thread into `SlotRoute.audible` (replaces the inline
`anySolo ? solo : !muted` at `MixEngine.cpp:4682`):

- **Mute**: muting a track silences its audible contribution AND its sidechain taps (predictable
  FL-style behavior; the key dies with the source). Muting a bus silences the whole subtree's
  audible path (sources still process for sidechain taps that bypass the bus, if any).
- **Solo** (closure over output-route edges): audible set =
  ⋃ over each soloed track `s` of `upstream(s)` (every track whose output path reaches `s`)
  ∪ `{s}` ∪ `downstreamPath(s)` (the output-route chain from `s` to master).
  Soloing Drum Bus therefore plays Kick/Snare/Hats through it; soloing Kick plays Kick → Drum
  Bus → Master without the other drums.
- **Sidechain under solo**: tracks that feed a sidechain tap of an audible track but are not
  themselves audible are processed with `feedsSidechainOnly = true` — rendered, chained,
  fader'd, tapped for the key, but **not** summed anywhere audible. This keeps a soloed Bass
  pumping exactly as in the full mix.
- `visualOnly` continues to mean "not audible" and also disables its taps.

### 4.6 Latency / PDC implications

Replace the flat model (`MixEngine.cpp:4530-4575`) with junction-based compensation:

- Definitions: `chainLat(t)` = insert-chain latency of `t` (existing
  `EffectChainManager::getOutputLatencySamples`). For each summing junction `j` (a bus track's
  input, or master input), each input branch `b` has
  `subtreeLat(b) = chainLat(b) + comp(b) + maxInputAlignment(b)` computed bottom-up in topo
  order.
- Compensation applied per input branch at its junction:
  `comp(b) = maxOverSiblings(subtreeLatRaw) − subtreeLatRaw(b)` — reuses the existing per-slot
  `StereoCompensationDelay` (`trackCompensationDelays_[i]`, placement at `MixEngine.cpp:4794`
  is already "immediately before summing", which is exactly the junction input point).
- Master junction inputs are: tracks routed to master + (later) sends. Master chain latency
  (`cachedMasterInsertLatencySamples_`) stays downstream and unchanged.
- Export pre-roll: `AudioExporter::computePrerollPlan` (`AudioExporter.h:60`) must consume the
  new **max path latency** (`maxPathLatencySamples = max over leaves of Σ chain latencies along
  route to master`) instead of `maxAudibleTrackLatencySamples`. Expose
  `MixEngine::getMaxPathLatencySamples()` and keep the old getter for diagnostics.
- Sidechain alignment caveat: keys tapped post-PDC at the source are aligned with the source's
  junction timeline, not necessarily with the target's input timing when the target sits on a
  different-latency path. v1 policy: tap post-compensation (best effort, document ±pathΔ skew);
  exact key alignment is listed as a risk (§10), not solved in v1.

### 4.7 Realtime playback and offline export parity

- All routing lives inside `MixEngine::processBlock` → `AudioExporter::renderOffline` /
  `renderOfflineWrap` inherit it untouched.
- Required export-side edits: pre-roll plan (above) and tail detection — wrap/tailClamp peak
  detection reads the master bus (unchanged), but the note-trigger ceiling logic
  (`setNoteTriggerCeilingSample`, `MixEngine.h:358`) is routing-agnostic (gates note starts,
  not buses) — no change.
- Parity test: render the same project realtime-sim (offline drive, nonRealtime=false
  semantics not needed — use existing `test_offline_render.cpp` harness) vs export and assert
  sample-identical output for a routed project.

### 4.8 Bridge API surface (new exports, naming follows existing convention)

| Export (`XlethAddon.cpp`) | Signature | Notes |
|---|---|---|
| `timeline_setTrackOutputRoute` | `(trackId, targetTrackId)` → `{ok, reason?}` | `-1` = Master; undo-tracked |
| `timeline_addSidechainRoute` | `(sourceTrackId, {targetTrackId, targetEffectInstanceId?, gain?, preFader?})` → `{ok, routeId?, reason?}` | undo-tracked |
| `timeline_removeSidechainRoute` | `(sourceTrackId, routeId)` → `{ok}` | undo-tracked |
| `timeline_setSidechainRouteParams` | `(sourceTrackId, routeId, {gain?, enabled?, preFader?})` → `{ok}` | undo-tracked |
| `timeline_getRouting` | `()` → per-track routing JSON | or fold into `timeline_getTracks` payload |
| `audio_getEffectSidechainCapability` | `(trackId, nodeId)` → `{supported, channels, enabled}` | probes plugin buses (§5.4) |

Each mutation handler: validate → `g_undoManager->execute(std::make_unique<…Command>(…))` →
`mix.syncRoutingFromTimeline()` → `audioEngine->refreshLivePresentationLatency()`. New commands
in `engine/src/commands/TimelineCommands.{h,cpp}`: `SetTrackOutputRouteCommand`,
`AddSidechainRouteCommand`, `RemoveSidechainRouteCommand`, `SetSidechainRouteParamsCommand`
(pattern: `SetTrackSoloCommand`, `TimelineCommands.h:428`).

IPC plumbing: `ui/main.js` `ipcMain.handle('xleth:timeline:setTrackOutputRoute', …)` etc.;
`ui/preload.js` under `window.xleth.timeline.*`.

### 4.9 Failure modes and error reporting

- Mutation rejected → `{ok:false, reason}` through bridge; renderer shows inline notice
  (pattern: `describeGraphMutationResult` in the FX Graph panel).
- Snapshot build failure (defensive cycle, slot overflow > kMaxTracks) → log via existing
  `MixDebugLog`, fall back to previous snapshot (never silence the session).
- Stale sidechain target after load (missing plugin/instance) → route kept, surfaced in
  `timeline_getRouting` as `status:"stale"`, no engine wiring (fail-closed-silent, mirrors
  missing-plugin placeholder UX, `MixEngine::getMissingPluginsJSON`, `MixEngine.h:494`).

---

## 5. Sidechain implementation plan (silent key routing)

### 5.1 Route collection and per-target buffers

- `RoutingSnapshot` carries per-source `scTaps` (§4.1). New pre-allocated
  `juce::AudioBuffer<float> sidechainBuffers_[kMaxTracks]` (stereo, sized with
  `ensureTrackBuffers`).
- In the topo loop, after the source's fader (preFader taps: before fader; postFader: after
  pan/PDC), accumulate `sidechainBuffers_[targetSlot].addFrom(src, gain)`.
- These buffers are consumed **only** by the target's chain sidechain injection (§5.2). They are
  never added to `trackBuffers_`, the master `outputBuffer`, or any send — structural silence.

### 5.2 Delivery into the target chain — `SidechainSourceProcessor`

New utility node (home: `engine/src/audio/UtilityProcessors.h` family):

- 0 audio inputs, 2 outputs; `processBlock` copies from an externally set pointer
  (`setExternalBuffer(const float* L, const float* R, int n)` written by MixEngine under the
  already-held `chainsMutex_` before calling the chain's `processBlock` — same block, same
  thread, no extra locking).
- One instance per track APG, created lazily when the track has ≥1 incoming sidechain route.
- `AudioGraph` gains channel-level wiring for it: connect SC node outputs → target effect
  node's **second input bus** channels (process-block channel indices 2/3 via
  `getChannelIndexInProcessBlockBuffer`). This requires relaxing the (2,2) lock:
  `addProcessorToGraph` (`AudioGraph.cpp:175`) must respect a node's own bus layout instead of
  forcing `setPlayConfigDetails(2,2)`; graph I/O nodes stay stereo (track in/out unchanged).
- PDC: `computePDC()` treats the SC node as a root (latency 0); key-path PDC is explicitly out
  of scope for v1 (§10).

### 5.3 Stock effect sidechain support

- Selected stock effects (first: `XlethCompressorEffect`; candidates: `XlethOTTEffect`,
  `XlethLimiterEffect`) gain a **declared sidechain input bus** via JUCE `BusesProperties`
  (`withInput("Sidechain", stereo, /*enabledByDefault*/ false)`) on `XlethEffectBase`
  construction options.
- In `processBlock`, when the SC bus is enabled and connected, the detector reads
  `getBusBuffer(buffer, true, 1)` instead of the internal tap at
  `XlethCompressorEffect.h:249-251`; existing `wc_hp`/`wc_lp` key filters apply to the external
  key. New APVTS param `sc_external` (bool) toggles internal/external detector; appears in
  `StockParameterCatalog.cpp`.
- Capability is reported per node in `getChainState` / parameter descriptor JSON:
  `"sidechain": { "supported": true, "enabled": bool }`.

### 5.4 Third-party VST3 sidechain support (JUCE bus APIs)

- Probe at instantiation in `AudioGraph::createEffect` (after `createPluginInstance`, replacing
  the unconditional stereo force at `AudioGraph.cpp:2530-2541`):
  1. `getBusCount(true) > 1` → candidate.
  2. Build layout {main stereo in, SC stereo in, stereo out}; try
     `checkBusesLayoutSupported` then `setBusesLayout`; fall back to mono SC; on failure mark
     unsupported and apply today's stereo-only layout.
  3. Record capability in node metadata (`vstDescriptions_` sibling map) →
     `audio_getEffectSidechainCapability`.
- Enable lazily: the SC bus is only enabled (and the node re-prepared) when a sidechain route
  actually targets the instance — avoids breaking plugins that misbehave with enabled-but-silent
  aux buses. Re-prepare may change `getLatencySamples` → run the existing
  `refreshGuardedPluginLatency` path (`MixEngine.h:563`) and recompute PDC.
- `GuardedPluginWrapper` must mirror the inner plugin's bus layout (constructor currently
  defaults; extend it to copy `inner_->getBusesLayout()` and forward
  `isBusesLayoutSupported`/`getBusBuffer` semantics through the SEH guard). **Verification item
  for Prompt 5 — wrapper bus pass-through is untested territory.**
- All probing/enabling behind `xleth::pluginGuardCall` (SEH), consistent with existing hosting.

### 5.5 Unsupported plugins

- No SC bus discoverable → capability `{supported:false}`; bridge rejects
  `timeline_addSidechainRoute` targeting it with reason `sidechain_unsupported`; UI shows a
  disabled state with explanation (§7). Never fake a route; never mix the key into the main bus.

### 5.6 Silence guarantee

- Structural: SC buffers only reach non-main input buses; APG render of the effect writes its
  main output bus only; bypassed/crashed effect (GuardedPluginWrapper passthrough) passes the
  **main** bus through, key is dropped.
- Verified by tests (§9): impulse on Kick routed to Bass SC with target effect (a) absent,
  (b) bypassed, (c) crashed → Bass track output bit-identical to no-route render.

---

## 6. FX Graph implementation plan — protected Sidechain Input node

### 6.1 graphState representation (`ui/src/fxgraph/graphState.js`)

- New node type `'sidechainInput'` added to `NODE_TYPES` (line 47) and to
  `PROTECTED_NODE_TYPES` (line 1067) — not deletable by `removeGraphNode` (guard at line 622 /
  1130 already keys off `isProtectedGraphNodeType`).
- Shape: `{ id, type:'sidechainInput', position, data:{} }`. Output port `'audio'` (mirrors
  `trackInput`). At most one per graph (validator rule).
- Effect nodes gain an optional input port `'sidechainIn'`, rendered only when the underlying
  effect instance reports sidechain capability (renderer queries
  `audio_getEffectSidechainCapability` via the existing parameter-descriptor fetch path).
- Edge rules (mutation helpers + `validateVersionOneGraphState`):
  - `sidechainInput.audio` may connect **only** to `effect.sidechainIn`.
  - `sidechainIn` accepts edges **only** from `sidechainInput` (not from effect `audioOut`,
    not from `trackInput`) — keeps the audible graph and key graph disjoint in v1.
  - `sidechainInput` → `trackOutput` is rejected (`GRAPH_MUTATION_REJECTION` new code
    `SIDECHAIN_NOT_AUDIBLE`) — the node can never become an audible mix path.
  - Schema stays version 1 (additive node/edge vocabulary; loaders already preserve unknown
    types as `'unknown'` fail-safe).

### 6.2 Lifecycle and deletion restrictions

- The node is **engine-truth-driven**: it exists while the track has ≥1 enabled incoming
  `SidechainRoute` with empty-or-graph `targetEffectInstanceId` resolution. The store
  (`effectChainStore`) inserts it on route creation / hydration
  (`hydrateGraphEffectInstancesForLoadedProject`, line 1096) and removes it automatically when
  the last incoming route is removed. The user never deletes it directly (protected), mirroring
  `trackInput`/`trackOutput`; its edges *are* user-deletable.
- Relationship to protected I/O nodes: identical protection mechanics; rendered with the same
  "system node" affordances in `GraphStatePreview.tsx`; positioned by the same fallback
  placement helper.

### 6.3 Runtime mapping (engine)

- `EffectChainManager::syncGraphTopology` (`EffectChainManager.h:136`) payload extended: nodes
  may include `{ type:'sidechainInput' }`; edges may carry `targetPort:'sidechainIn'`.
- Mapping: `sidechainInput` ⇒ the track's `SidechainSourceProcessor` engine node (§5.2);
  `sidechainIn` edge ⇒ APG channel connections into the target effect's bus-1 channels.
  Validation fail-closes to silence exactly like audio edges today (unknown instance, no
  capability, cycle).
- The renderer never learns the SC node's engine uid; the topology payload references it by the
  reserved node type, the engine resolves internally (same spirit as Track Input/Output
  resolution today).

### 6.4 Interaction with Macro / LFO / Envelope nodes

- None in v1. `sidechainInput` is an **audio-domain** source; Macro/Envelope are
  parameter-domain (`controlOut` → parameter edges, `graphState.js:21-34`). The edge-type rules
  in §6.1 make cross-connection structurally impossible.
- Future note (non-binding): an "Envelope Follower" graph node taking `sidechainIn`-style audio
  and emitting `controlOut` would unify key-driven parameter modulation; design deliberately
  leaves the port vocabulary compatible with that.

---

## 7. UI/UX plan

Hard rule: no hardcoded production colors — theme tokens / CSS variables only (theming Wave 0
rules).

- **Track output selector** (Prompt 3): a compact selector in `MixerStrip.jsx` (below the
  name label, above M/S/V) labeled **"Output"**, listing `Master` (default) + eligible tracks.
  Ineligible entries (self, descendants that would cycle) are disabled with a tooltip
  ("would create a feedback loop"). Same control surfaced in the timeline track header context
  menu. Store: extend `mixerStore` with `outputRoutes` + `setOutputRoute(trackId, target)`
  calling `window.xleth.timeline.setTrackOutputRoute`, with rollback on `{ok:false}`.
- **Bus route display**: strips routed to a bus show a small chip `→ <Bus name>`; bus strips
  show an input-count badge (`3 inputs`). Master strip unchanged.
- **Sidechain source/target selector** (Prompt 5 UI slice): on SC-capable effect headers
  (`EffectModule.jsx` / `EffectChainPanel.jsx`): "Sidechain: <source track ▾>" dropdown listing
  tracks (excluding the host track); creates/removes `SidechainRoute`s. In FX Graph: connect
  gesture from the protected Sidechain Input node to a `sidechainIn` port.
- **Terminology in copy**: "Output" (route), "Send" (reserved), "Sidechain" — never mixed; the
  selector for output routing must not be labeled "send".
- **Unsupported VST warning**: disabled sidechain selector with explicit text "This plugin does
  not expose a sidechain input" (driven by `audio_getEffectSidechainCapability`); stale routes
  after load get a warning badge consistent with the missing-plugin badge.
- **Defer**: parallel sends UI entirely; per-route gain/pre-fader controls for sidechain (v1
  uses defaults; params exist in schema/bridge); routing matrix overview panel; drag-routing in
  the timeline.

---

## 8. Phased implementation prompts

Phase 1 (this audit) is complete. Each prompt below is self-contained for an implementing
model.

> **Prompt 2A status (inert foundation — 2026-06-10):** Implemented the persistent output-route
> contract only. No DSP bus summing — `MixEngine::processBlock` hard-coded master sum is
> unchanged. Files added/modified: `engine/src/audio/TrackRouting.{h,cpp}`,
> `engine/src/model/TimelineTypes.h`, `engine/src/model/Track.cpp`,
> `engine/src/model/Timeline.{h,cpp}`, `engine/src/commands/TimelineCommands.{h,cpp}`,
> `bridge/src/XlethAddon.cpp`, `ui/main.js`, `ui/preload.js`, `engine/CMakeLists.txt`,
> `engine/test/test_track_routing.cpp`. Sidechain deferred to Prompt 4+. UI deferred to
> Prompt 3. Prompt 2B will replace the master summing loop with real bus routing.

> **Prompt 2B status (audible bus routing — 2026-06-10):** Output-route DSP bus summing is now
> live in `MixEngine::processBlock`. What landed:
> - **Bus summing implemented (§4.2):** the per-track summing destination is now route-aware — a
>   default route (`targetTrackId == -1`) sums to Master (`outputBuffer`); a bus route sums the
>   processed source buffer into the target track's pre-chain buffer (`trackBuffers_[targetSlot]`)
>   so routed audio runs through the bus's own chain/fader/pan. A routed source touches
>   `outputBuffer` zero times — **no direct-to-Master duplicate**. Verified by
>   `test_mixer_bus_routing` T1 (routed energy == 0.5× direct, never inflated) and T7 (muting a
>   bus silences the whole subtree — the pan-law-independent proof of no duplicate path).
> - **Topological order implemented (§4.3):** a pure `xleth::buildRoutePlan` (in
>   `TrackRouting.{h,cpp}`) Kahn-sorts active slots so every source is processed before its bus,
>   independent of timeline track order. Fail-closed: a cycle (impossible after 2A validation)
>   falls back to all-to-Master + throttled log; a missing/visual-only target is forced to Master.
> - **Route-aware mute/solo baseline implemented (§4.5):** the plan computes an `audible[]` set via
>   a mute/solo closure over output-route edges (soloed source stays audible through its downstream
>   bus path; soloed bus keeps its upstream sources audible; muted bus silences its subtree). For
>   unrouted projects this is bit-identical to the legacy `anySolo ? solo : !muted`, so existing
>   audio is unchanged (`test_mix` 272 checks still pass). Sidechain-solo is NOT implemented.
> - **Bus activity propagation implemented (§4.2):** a `receivedRoutedInput[]` flag set during
>   source summing folds into the per-slot `hasAudio` gate, so a bus with no clips of its own still
>   runs its chain and drains its tail when fed.
> - **The route plan is built once per block**, on the audio thread, from the same live
>   `getAllTracks()` slot space the buffers use (allocation-free, lock-free, fixed-size stack
>   arrays). No `syncRoutingFromTimeline()` / shared snapshot member was needed: route mutations
>   are read live on the next block, so no bridge change was required.
> - **Deferred (NOT in 2B):** junction PDC / nested-bus phase alignment and export pre-roll max
>   path latency → **Prompt 2C** (the existing flat per-track compensation is left intact;
>   latency-heavy bus chains are not yet phase-correct, and `AudioExporter::computePrerollPlan`
>   is untouched). Sidechain → Prompt 4+. Sends → later. Mixer UI → Prompt 3.
> - **Files added/modified:** `engine/src/audio/TrackRouting.{h,cpp}` (RoutePlan builder),
>   `engine/src/audio/MixEngine.cpp` (route-aware processBlock), `engine/CMakeLists.txt`
>   (`test_mixer_bus_routing` target), `engine/test/test_track_routing.cpp` (RoutePlan unit tests
>   R1-R9), `engine/test/test_mixer_bus_routing.cpp` (new DSP integration tests).

> **Prompt 2C status (junction PDC + export max path latency — 2026-06-10):** Bus routing is now
> phase-correct under insert-chain latency. What landed:
> - **Junction PDC implemented (§4.6):** a pure `xleth::buildRoutePdcPlan` (in
>   `TrackRouting.{h,cpp}`) derives, from the 2B `RoutePlan` plus per-slot chain latencies:
>   `contributesToMaster[]` (reverse-topo audible-closure reachability — muted/solo-silenced/
>   visual-only branches and dead-ended subtrees never inflate any junction),
>   `junctionInputLatencySamples[]` / `branchArrivalLatencySamples[]` (forward-topo raw arrival
>   maxima per junction), `branchCompensationSamples[]` (per-branch alignment at its OWN
>   destination junction, applied exactly once), and `maxPathLatencySamples` (aligned latency at
>   the Master input). `MixEngine::processBlock` now retargets `trackCompensationDelays_[i]` from
>   `branchCompensationSamples[i]` instead of the flat `maxAudibleTrackLatency − ownLatency`; the
>   existing `StereoCompensationDelay` position (immediately before summing into the destination)
>   was already the junction input point, so no DSP relocation was needed. Nested buses align
>   recursively (each bus's aligned input + its own chain latency is its branch arrival at the
>   next junction). For unrouted projects the plan reduces bit-exactly to the old flat model.
> - **Max path latency implemented:** `MixEngine::getMaxPathLatencySamples()` +
>   `LatencyCompensationSnapshot.maxPathLatencySamples` (route-aware; equals
>   `maxAudibleTrackLatencySamples` when unrouted; master insert latency stays a separate
>   downstream term, never double-counted). `getTrackCompensationDelaySamples()` now reports the
>   junction compensation; the legacy flat getter is kept for diagnostics/taps.
> - **Export pre-roll switched to route-aware max path latency:**
>   `AudioExporter::computePrerollPlan(MixEngine&, …)` and both `OfflineRenderer` pre-roll sites
>   (linear + wrap; a narrow audio-pre-roll-only edit) consume `maxPathLatencySamples`, so
>   latent/nested bus chains are fully flushed before capture. Unrouted pre-roll is unchanged.
> - **Known caveat (pre-existing, unchanged):** a bus's OWN clips enter its buffer at latency 0
>   and are not delayed to meet routed input (no pre-chain delay stage exists); junction PDC
>   aligns routed branches with each other, same own-content skew as the flat model.
> - **Tests:** `test_track_routing` P1-P8 (pure RoutePdcPlan: flat equivalence, latent bus,
>   sibling alignment, nested junction math, mute/solo/visual-only exclusion, route reset). New
>   `test_mixer_routing_pdc` (CMake target): impulse-coincidence renders that FAIL under the flat
>   model (latent bus vs direct sibling, siblings into one bus at the single-counted path depth,
>   nested A→Bus1→Bus2 ← B with direct C, muted-branch non-inflation, solo closure path, route
>   reset bit-identical to never-routed) plus export probes (nested pre-roll lands the impulse at
>   its exact timeline position; routed offline export == realtime render shifted by path latency
>   with maxDiff = 0; unrouted export unchanged). Regression green: `test_mixer_bus_routing` (25),
>   `test_pdc_stage1` (584), `test_mix` (272), `test_offline_render`, `test_project`, `test_undo`.
> - **Deferred (NOT in 2C):** sidechain → Prompt 4+. Parallel sends → later. Mixer UI → Prompt 3.
>   FX Graph sidechain → later. Bus own-content input alignment (pre-chain delay) → later if a
>   real-world project needs it.
> - **Files added/modified:** `engine/src/audio/TrackRouting.{h,cpp}` (RoutePdcPlan builder),
>   `engine/src/audio/MixEngine.{h,cpp}` (junction retargeting, route-aware snapshot/getters),
>   `engine/src/export/AudioExporter.{h,cpp}`, `engine/src/render/OfflineRenderer.cpp` (pre-roll
>   inputs only), `engine/CMakeLists.txt` (`test_mixer_routing_pdc` target),
>   `engine/test/test_track_routing.cpp`, `engine/test/test_mixer_routing_pdc.cpp` (new).

### Prompt 2 — Mixer bus routing core (engine + persistence + bridge)

- **Scope**: `TrackOutputRoute` model + serialization + validation (§3); `RoutingSnapshot`,
  topo-ordered processing, bus summing, master-sum replacement, solo/mute closure, hasAudio
  propagation, junction PDC (§4.1-4.7); bridge `timeline_setTrackOutputRoute` /
  `timeline_getRouting` + `SetTrackOutputRouteCommand`; `MixEngine::syncRoutingFromTimeline`;
  export pre-roll switched to max path latency. No sends, no sidechain, no UI.
- **Files likely touched**: `engine/src/model/TimelineTypes.h`, `engine/src/model/Track.cpp`,
  `engine/src/model/Timeline.{h,cpp}`, new `engine/src/audio/TrackRouting.{h,cpp}`,
  `engine/src/audio/MixEngine.{h,cpp}`, `engine/src/export/AudioExporter.{h,cpp}`,
  `engine/src/commands/TimelineCommands.{h,cpp}`, `bridge/src/XlethAddon.cpp`,
  `engine/CMakeLists.txt` (new test target), `engine/test/test_routing.cpp` (new),
  `engine/test/test_project.cpp`, `engine/test/test_pdc_stage1.cpp`,
  `engine/test/test_offline_render.cpp`, `engine/test/test_undo.cpp`.
- **Tests required**: §9 groups R1-R9, P1-P3, M1-M3, U1.
- **Success condition**: a project with Kick→DrumBus→Master plays Kick exactly once
  (impulse-sum test: master output of routed render == unrouted render with Kick's chain
  replaced by DrumBus chain equivalence case); old projects load/play bit-identical; offline
  export of a routed project == realtime-equivalent render; cycle/self/master-source mutations
  rejected with reasons; undo restores previous route.
- **Do not touch**: FX Graph code paths, `effectChains` JSON schema (other than nothing),
  renderer (beyond keeping `timeline_getTracks` compatible), quarantined NodeEditor files,
  sends/sidechain fields beyond inert schema reservation.

### Prompt 3 — Mixer routing UI

- **Scope**: Output selector + route chips + validation feedback (§7); `mixerStore` routing
  state + actions; preload/main.js plumbing for the Prompt-2 APIs; eligible-target computation
  (client-side preview of cycle rule, server-validated).
- **Files likely touched**: `ui/preload.js`, `ui/main.js`,
  `ui/src/stores/mixerStore.js`, `ui/src/components/mixer/MixerStrip.jsx`,
  `ui/src/components/mixer/MixerPanel.jsx`, `MasterStrip.jsx`, mixer CSS (token-based),
  `ui/src/stores/mixerStore` tests (new), possibly timeline track header context menu
  component.
- **Tests required**: vitest — store action success/rollback, eligible-target filter
  (self/cycle), chip rendering states; §9 group UI1-UI4.
- **Success condition**: user can route Kick→DrumBus from the mixer; selector shows Master by
  default; invalid targets disabled with tooltip; route survives save/load; engine state is the
  single source of truth (store refetches on `{ok:false}`).
- **Do not touch**: engine/bridge beyond consuming Prompt-2 APIs; FX Graph; hardcoded colors
  (tokens only); sends/sidechain UI.

### Prompt 4 — Sidechain routing core (engine + persistence + bridge)

- **Scope**: `SidechainRoute` model/serialization/validation; chain-node `effectInstanceId`
  (§3.3); SC tap collection + `sidechainBuffers_`; `SidechainSourceProcessor`; APG multi-bus
  channel wiring + removal of the (2,2) force for multi-bus nodes; solo/mute SC policy
  (`feedsSidechainOnly`); bridge add/remove/set-params/getRouting extensions + undo commands.
  Stock/VST capability probing stubs may land here but enabling real detectors is Prompt 5.
- **Files likely touched**: `engine/src/model/TimelineTypes.h`, `engine/src/model/Track.cpp`,
  `engine/src/model/Timeline.{h,cpp}`, `engine/src/audio/TrackRouting.{h,cpp}`,
  `engine/src/audio/MixEngine.{h,cpp}`, `engine/src/audio/AudioGraph.{h,cpp}`,
  `engine/src/audio/EffectChainManager.{h,cpp}`, `engine/src/audio/UtilityProcessors.h`,
  `engine/src/commands/TimelineCommands.{h,cpp}`, `bridge/src/XlethAddon.cpp`,
  `engine/test/test_sidechain.cpp` (new), `engine/test/test_routing.cpp`,
  `engine/test/test_project.cpp`, `engine/test/test_undo.cpp`, `engine/CMakeLists.txt`.
- **Tests required**: §9 groups S1-S8 (silence guarantees), P4, U2.
- **Success condition**: a sidechain route Kick→(Bass, effectInstanceId) persists, round-trips,
  participates in topo order and cycle rejection, fills the target's SC buffer, and produces
  **zero** change to any audible output while no effect consumes the key (bit-identical render
  with routes present vs absent).
- **Do not touch**: stock effect DSP behavior, VST bus enabling (only probing), FX Graph,
  renderer UI, audible summing semantics from Prompt 2.

### Prompt 5 — Stock + VST sidechain support

- **Scope**: stock SC buses + external-detector switch on `XlethCompressorEffect` (then
  OTT/limiter as stretch) (§5.3); VST probe/enable/re-prepare/latency-refresh path (§5.4);
  `GuardedPluginWrapper` bus mirroring; `audio_getEffectSidechainCapability`; capability in
  chain-state JSON; effect-header sidechain source selector UI + unsupported messaging (§7);
  stale-route reporting.
- **Files likely touched**: `engine/src/audio/XlethEffectBase.h`,
  `engine/src/audio/XlethCompressorEffect.h`, `engine/src/audio/StockParameterCatalog.cpp`,
  `engine/src/audio/AudioGraph.cpp` (createEffect probing),
  `engine/src/audio/GuardedPluginWrapper.{h,cpp}`, `engine/src/audio/MixEngine.{h,cpp}`,
  `bridge/src/XlethAddon.cpp`, `ui/preload.js`, `ui/main.js`,
  `ui/src/components/mixer/EffectModule.jsx`, `EffectChainPanel.jsx`,
  `ui/src/stores/effectChainStore.js`, `engine/test/test_sidechain.cpp`,
  `engine/test/test_effects.cpp`, store/component vitest files.
- **Tests required**: §9 groups S9-S14 (pumping behavior, fake multi-bus test processor via
  `addProcessorForTesting`, unsupported rejection, crash-guard passthrough).
- **Success condition**: Kick keys the stock compressor on Bass (audible ducking follows Kick
  onsets; key inaudible); a multi-bus test VST receives the key on bus 1 only; an SC-less
  plugin reports unsupported and the route is rejected end-to-end with correct UI message;
  latency change after SC-enable re-prepare is reflected in PDC.
- **Do not touch**: FX Graph; routing core semantics; plugins' main-bus layout handling for
  non-SC tracks (existing stereo force stays for unsupported/unused cases).

### Prompt 6 — FX Graph protected Sidechain Input node

- **Scope**: §6 in full — `sidechainInput` node type + `sidechainIn` ports + edge rules +
  protection; store lifecycle (insert/remove driven by routes, hydration); `syncGraphTopology`
  payload + engine mapping to `SidechainSourceProcessor`; GraphStatePreview rendering/connect
  gesture; rejection codes/UX.
- **Files likely touched**: `ui/src/fxgraph/graphState.js` (+ test),
  `ui/src/fxgraph/linearGraphTopology.js`, `ui/src/stores/effectChainStore.js` (+ test),
  `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx` (+ test), `FxGraphPanel.tsx`,
  `engine/src/audio/EffectChainManager.{h,cpp}`, `engine/src/audio/MixEngine.{h,cpp}`,
  `bridge/src/XlethAddon.cpp` (payload passthrough only),
  `engine/test/test_sidechain.cpp`, `docs/dev/fxgraph-architecture.md` (doc update).
- **Tests required**: §9 groups G1-G7.
- **Success condition**: routing Kick→(graph-mode Bass track) materializes a non-deletable
  Sidechain Input node; connecting it to a capable effect's `sidechainIn` port keys that
  effect; deleting the route removes the node; `sidechainInput→trackOutput` and
  `audioOut→sidechainIn` are rejected; graph undo/redo covers SC edges; fail-closed silence on
  invalid payloads preserved.
- **Do not touch**: Mixer Chain UI, chain-mode sidechain selector (Prompt 5), macro/envelope
  parameter-edge semantics, quarantined NodeEditor paths.

---

## 9. Test matrix

Engine tests are plain-`main()` executables (extend `engine/CMakeLists.txt`); renderer tests are
vitest.

**Routing core (new `engine/test/test_routing.cpp`)**
- R1: default route → output bit-identical to pre-feature build (golden impulse render).
- R2: Kick→Bus→Master: master == Bus-chain(Kick signal); Kick contributes exactly once
  (impulse count/energy check). **No double-Master output.**
- R3: bus with own clips + routed input sums both, pre-chain.
- R4: topo order independent of track list order (bus created before/after sources).
- R5 (negative): self-route rejected (`self_route`); A→B→A rejected (`cycle`);
  master-as-source rejected (`master_as_source`); unknown target rejected.
- R6: mute source / mute bus / solo source / solo bus closure semantics (§4.5) — each as an
  audibility assertion table.
- R7: tail propagation — source reverb tail keeps the bus chain processing after clips end.
- R8: route change mid-session swaps snapshot without reverting to all-to-master (generation
  check + no audible glitch beyond one block).
- R9: chain-lock miss (realtime contention sim) preserves routing topology.

**PDC (`engine/test/test_pdc_stage1.cpp` extension)**
- M1: latency on bus chain → sources aligned at bus input AND bus aligned with parallel dry
  track at master (impulse coincidence).
- M2: nested buses (src→busA→busB→master) cumulative alignment.
- M3: `getMaxPathLatencySamples` == sum along deepest path; export pre-roll covers it
  (`test_offline_render.cpp`).

**Offline/export parity (`engine/test/test_offline_render.cpp` / `test_tail_render.cpp`)**
- P1: routed project offline render == realtime-equivalent drive, sample-identical.
- P2: tailClamp/wrap renders unaffected by routing for unrouted projects (regression).
- P3: routed project under wrap fold — seam energy correct (reuses `renderWrapCore` harness).
- P4: sidechain routes present → export output identical to playback.

**Persistence (`engine/test/test_project.cpp`)**
- Save/load round-trip of outputRoute + sidechainRoutes (+ omitted-when-default).
- Pre-feature project JSON loads with Master default, no routes (migration default).
- Stale `targetEffectInstanceId` surfaces `stale`, engine stays silent-fail-closed.
- Chain-node `effectInstanceId` round-trip and generation-on-missing.

**Undo (`engine/test/test_undo.cpp`)**
- U1: SetTrackOutputRouteCommand execute/undo/redo restores model + snapshot.
- U2: Add/Remove/SetParams sidechain commands round-trip.

**Sidechain silence + behavior (new `engine/test/test_sidechain.cpp`)**
- S1: route with no consuming effect → all track outputs bit-identical to no-route render.
- S2: key never appears in master when target effect bypassed.
- S3: key never appears when target is GuardedPluginWrapper in crashed-passthrough state.
- S4: SC buffers excluded from sends/master/preview paths (structural assertions on buffers).
- S5: mute source kills key; solo-closure keeps key alive (`feedsSidechainOnly`).
- S6: SC edge participates in cycle rejection (Kick→BassSC + Bass→Kick output = cycle).
- S7: preFader/postFader tap levels.
- S8: per-route gain applied to key only.
- S9: stock compressor external key ducks main signal on key onsets; with `sc_external` off,
  behavior identical to today.
- S10: fake multi-bus test processor (via `MixEngine::addProcessorForTesting`,
  `MixEngine.h:239`) asserts key arrives on bus 1 channels only, main bus clean.
- S11: SC-less plugin: capability `{supported:false}`, route add rejected
  (`sidechain_unsupported`).
- S12: SC-bus enable triggers re-prepare + latency refresh + PDC recompute.
- S13: layout fallback stereo→mono SC.
- S14: removeIllegalConnections-equivalent: SC wiring dropped cleanly when target node removed.

**FX Graph (vitest: `graphState.test.js`, `effectChainStore.test.js`,
`GraphStatePreview.test.tsx`; engine: `test_sidechain.cpp` sync cases)**
- G1: `sidechainInput` protected — removeGraphNode rejected with `PROTECTED_NODE`.
- G2: edge rules — only `sidechainInput→sidechainIn`; `sidechainInput→trackOutput` rejected;
  `audioOut→sidechainIn` rejected.
- G3: store inserts/removes node on route add/remove + hydration after load.
- G4: schema round-trip preserves the node; pre-feature graphState loads unchanged.
- G5: syncGraphTopology payload with SC edges → engine wires SC source node; invalid payload
  fail-closes to silence.
- G6: graph undo/redo over SC edge connect/disconnect.
- G7: at most one `sidechainInput` per graph enforced.

**Renderer routing UI (vitest)**
- UI1: mixerStore setOutputRoute optimistic update + rollback on `{ok:false}`.
- UI2: eligible-target list excludes self + cycle-creators.
- UI3: route chip renders for routed strips, absent for Master default.
- UI4: sidechain selector disabled state for unsupported capability.

---

## 10. Risk list (blunt)

1. **Junction PDC is the hardest part of Prompt 2.** The flat model is deceptively simple
   today; the recursive model interacts with the existing epoch/cache arrays
   (`cachedTrackLatencyEpochs_`, retarget crossfades in `StereoCompensationDelay`). Wrong math
   = comb filtering that users will hear before any test fails. Mitigate with impulse-coincidence
   tests (M1/M2) before any UI lands.
2. **Sidechain key alignment is *not* sample-exact in v1.** Keys tapped post-PDC on the source
   path can be skewed vs the target's input timing by path-latency deltas. Acceptable for
   pumping compression; document it; revisit if users sidechain with lookahead limiters.
3. **APG (2,2) lock removal has blast radius.** Three force-sites plus implicit stereo
   assumptions in PDC helper insertion, wire gain nodes, and meters. Audit every
   `setPlayConfigDetails`/`getNumChannels` in `AudioGraph.cpp` during Prompt 4; multi-bus nodes
   only where SC is actually enabled to contain risk.
4. **GuardedPluginWrapper bus mirroring is unproven.** If the wrapper can't faithfully proxy
   bus layouts through SEH, fallback is hosting SC-enabled VSTs unwrapped (unacceptable) or
   per-bus buffer marshaling in the wrapper (extra copy). Budget investigation time in Prompt 5.
5. **VST bus-layout weirdness.** Plugins lie: SC buses that accept layout but ignore audio,
   layouts that change latency, plugins that crash on `setBusesLayout` after `prepareToPlay`.
   Everything behind `pluginGuardCall`; enable lazily; never persist "supported" — re-probe per
   session.
6. **Solo/mute closure edge cases.** Solo on a sidechain *source* only (no audible solo
   target), visualOnly buses, mute-inside-solo combinations — the audibility table in R6 must be
   written before the implementation, not after.
7. **Graph rebuild churn.** Routing mutations rebuild `RoutingSnapshot` (cheap), but SC
   enable/disable triggers APG re-prepare + PDC recompute + latency epoch bumps; batch UI
   actions (e.g., undo of multi-route change) should coalesce via the existing 50 ms debounce
   pattern, or the audio thread sees a storm of retarget crossfades.
8. **Stale `effectInstanceId` mappings.** Plugin missing at load, chain↔graph conversions,
   adoption (`adoptGraphNodes`) — every path that rewrites engine uids must keep the
   instance-id map coherent or sidechain routes silently die. Fail-closed is mandatory but
   silent failure must still surface in `timeline_getRouting` status.
9. **Project compatibility.** The schema is additive, but Prompt 2 changes *runtime* behavior
   (`hasAudio` propagation, snapshot path) for **all** projects including unrouted ones — R1
   golden-render regression is the gate.
10. **Performance.** Topo iteration and SC buffer adds are O(tracks + routes) — negligible. The
    real cost is more chains staying "active" via bus tails (a bus keeps its chain hot while any
    source tails). Watch `RealtimeDiagnosticsSnapshot` p99 in the perf scenario runner
    (`test_audio_perf_scenarios.cpp`) with a 16-source → 4-bus project.
11. **FX Graph ownership conflicts.** The SC node is engine-truth-driven while graphState is
    renderer-owned — hydration races (route exists but graphState lacks the node, or vice
    versa) must reconcile deterministically (engine routes win; store inserts/removes node to
    match). Define this in Prompt 6 before touching code.
12. **Preview/audition bus** bypasses routing by design — confirm no future prompt "fixes" it
    into the routing graph (it would steal voices into buses during auditioning).

---

## Prompt 3 Status (mixer routing UI/store - 2026-06-10)

- **Mixer Output selector implemented:** normal mixer strips have a compact `Output` selector
  for `Master` or another eligible mixer track. The UI does not call output routing a send.
- **Route visibility implemented:** source strips show `-> <target track name>` chips when
  routed away from Master, with `-> Missing track` as the stale-target fallback. Bus/target
  strips show input-count badges such as `1 input` / `3 inputs`.
- **Store/IPC integration implemented:** `mixerStore` mirrors engine/project routing state via
  track JSON and `timeline.getRouting()`, calls `timeline.setTrackOutputRoute(trackId,
  targetTrackId)`, and refreshes routing on mixer/project/track refresh paths.
- **Invalid target preview implemented:** client-side target lists omit self, visual-only
  targets, and obvious feedback-loop targets using a pure JS cycle helper. Engine validation
  remains final.
- **Rollback/refetch implemented:** rejected or thrown route mutations roll back the optimistic
  UI state, map stable bridge reason codes to concise DAW copy, and refetch engine routing when
  available.
- **Prompt 3 plumbing fix:** the initial mixer UI pass reached `ui/main.js` but the worker loaded
  a stale native addon without `timeline_setTrackOutputRoute` / `timeline_getRouting` exports.
  The worker-to-native route now resolves through the rebuilt addon, so UI route mutations reach
  engine routing instead of `notImplemented`.
- **Deferred:** sidechain UI, sends UI, FX Graph sidechain, and routing matrix.

## Prompt 4A Status (stable chain-mode effectInstanceId — 2026-06-10)

Sidechain-route targets must address a *specific effect instance* on a target track, and the only
persistable address is a stable id (APG uids are remapped every load, §1.5). Until now only FX
Graph (graph-mode) nodes had a stable `effectInstanceId`; normal Mixer Chain nodes did not. This
prompt adds that identity. No sidechain, no DSP change.

- **Chain-mode nodes now carry a stable `effectInstanceId`:** `AudioGraph::GraphNode` gained an
  `effectInstanceId` field (UUID string, `juce::Uuid().toDashedString()`), generated once in
  `addProcessorToGraph` so every node — chain or graph — is born with a unique id. The id survives
  move/reorder, bypass, parameter edits, and chain-state reads (it lives on the node metadata, not
  on the transient APG uid).
- **Persisted additively in chain JSON:** `AudioGraph::toJSON` / `getChainState` /
  `getGraphTopology` now emit `effectInstanceId` next to each node. Old projects without the field
  still load: `AudioGraph::fromJSON` restores the persisted id when present and unique, and
  otherwise keeps the freshly-generated id — so **old projects gain ids on the next save**, and
  **duplicate ids in a loaded chain are repaired deterministically** (first occurrence wins, later
  duplicates fall back to a fresh id, lookups stay unambiguous). The id is re-attached to the new
  runtime node even though the APG uid is remapped.
- **Ownership kept separate (no chain/graph collapse):** because chain-mode nodes now also serialize
  an `effectInstanceId`, presence of the field can no longer signal graph ownership. `graphToJSON`
  writes an explicit `graphOwned` flag (true only for `graphNodeIds_` members), and `graphFromJSON`
  rebuilds the graph-owned map from that flag (older saves with no flag fall back to field-presence,
  which was graph-only before this change). Chain-mode ids therefore never leak into `graphNodeIds_`.
  `EffectChainManager::addGraphNode` also stamps the renderer-supplied id onto the node metadata so
  the AudioGraph node, the persisted JSON, and `graphNodeIds_` all agree on one id per graph node.
- **Runtime lookup for the future sidechain phase:** `EffectChainManager::getNodeIdForEffectInstance`
  / `getEffectInstanceIdForNode` (unified across chain + graph nodes) and `MixEngine`
  `getEffectNodeIdForInstance(trackId, id)` / `getEffectInstanceIdForNode(trackId, nodeId)`
  (trackId == -1 = master) resolve a stable id to the live APG uid and back. These return the
  transient uid for runtime wiring only — the uid is never persisted.
- **Bridge/UI exposure is additive:** `audio_getEffectChain` / master chain-state already dump
  `getChainState()`, so `effectInstanceId` now flows to the renderer with no bridge code change and
  no required UI change (the renderer simply accepts the extra field).
- **Deferred:** `SidechainRoute` persistence/validation → Prompt 4B; sidechain buffers /
  `SidechainSourceProcessor` / APG multi-bus wiring / `feedsSidechainOnly` solo policy → Prompt 4C+;
  stock + VST sidechain detectors and capability probing → Prompt 5; FX Graph protected Sidechain
  Input node → Prompt 6. No sends.
- **Tests:** new `engine/test/test_chain_effect_identity.cpp` (CMake target
  `test_chain_effect_identity`, 51 checks): fresh-unique ids in chain state, lookup round-trip,
  move/bypass/param-edit preservation, save/load preservation across a forced APG uid remap,
  old-project id generation, duplicate-id repair, and graph-ownership isolation. Regression green:
  `test_graph_effect_parameters` (62), `test_project` (98), `test_undo` (84). (`test_effects` has 3
  pre-existing EQ-only failures unrelated to this change — APVTS param count + dynamic-EQ DSP.)
- **Files added/modified:** `engine/src/audio/AudioGraph.{h,cpp}`,
  `engine/src/audio/EffectChainManager.{h,cpp}`, `engine/src/audio/MixEngine.{h,cpp}`,
  `engine/CMakeLists.txt` (`test_chain_effect_identity` target),
  `engine/test/test_chain_effect_identity.cpp` (new), and this audit. No DSP, sidechain, sends, FX
  Graph graphState, plugin bus-layout, or mixer-UI code was changed.

## Prompt 4B Status (sidechain route model + bridge — 2026-06-11)

Sidechain routes now exist safely in the model/project/undo/bridge layer. A source track can store
a silent key route targeting a specific effect instance on another track, addressed only by the
stable Prompt-4A `effectInstanceId` (never an APG node id). **No sidechain DSP, buffers, APG wiring,
or audible behavior was added** — output is bit-identical to Prompt 4A.

- **Persisted:** `SidechainRoute` (already reserved in 2A, unchanged shape) now round-trips through
  `Track.cpp` `to_json`/`from_json`. Emitted only when non-empty; old projects load as empty. Load
  is **conservatively sanitizing** — a malformed entry is *dropped* (never mutates siblings): empty/
  duplicate `routeId`, missing/master `targetTrackId`, or empty `targetEffectInstanceId` are removed;
  `gain` is clamped to `[0,2]` (non-finite → 1.0), `preFader` defaults false, `enabled` true. A
  *structurally valid* route whose target effect is simply missing at load is **kept**, not dropped.
- **Validation (pure, `TrackRouting.{h,cpp}` `validateSidechainRoute`):** stable reason codes —
  `master_as_source`, `unknown_source_track`, `master_as_target`, `self_sidechain`,
  `unknown_target_track`, `empty_effect_instance`, `unknown_effect_instance`, `invalid_gain`,
  `duplicate_route`, `cycle`, plus `unknown_route` for remove/setParams. 4B **rejects** empty
  `targetEffectInstanceId` (track-level / FX-Graph Sidechain-Input deferred), self-sidechain, and
  master as source or target. Effect-instance resolution uses a `SidechainEffectResolver` callback
  (the bridge builds it from `MixEngine::getEffectNodeIdForInstance`; pure-model callers pass an
  empty `std::function` to skip it — keeping the model layer free of any audio-engine dependency).
- **Cycle rule:** sidechain edges participate in cycle rejection together with output-route edges
  over their union graph (§4.4). `A output→B` then `B sidechain→A` is rejected (`cycle`) — even
  though sidechain is silent later, it creates a same-block processing-order dependency. The reverse
  (`A sidechain→B` while `A output→B`) is allowed.
- **Mutation APIs (`Timeline`):** `addSidechainRoute(source, route, resolver)`,
  `removeSidechainRoute(source, routeId)`, `setSidechainRouteParams(source, routeId, params)`,
  `getSidechainRoutes(source)`. Target (track + effect instance) is immutable after creation; only
  gain/preFader/enabled are editable. `gain`/`preFader`/`enabled` are **stored only** — no runtime
  effect in 4B.
- **Undo/redo (`TimelineCommands.{h,cpp}`):** `AddSidechainRouteCommand`,
  `RemoveSidechainRouteCommand`, `SetSidechainRouteParamsCommand`. Add captures the full route
  (routeId generated once by the bridge) so **redo restores the identical routeId**; remove captures
  the route + original index for undo restore; setParams captures old params. The bridge validates
  before `execute`, so an invalid mutation never creates an undo entry.
- **Bridge:** `timeline_addSidechainRoute(sourceTrackId, routePayload)` → `{ok, routeId}` |
  `{ok:false, reason}`; `timeline_removeSidechainRoute(sourceTrackId, routeId)` and
  `timeline_setSidechainRouteParams(sourceTrackId, routeId, params)` → `{ok}` | `{ok:false, reason}`.
  `timeline_getRouting` now adds a per-track `sidechainRoutes[]` (each carrying `routeId`,
  `sourceTrackId`, `targetTrackId`, `targetEffectInstanceId`, `gain`, `preFader`, `enabled`, and a
  `status`) while keeping the existing per-track `outputRoute` shape for Prompt-3 compatibility.
  **Stale status** is reported (`stale_target_track` > `stale_effect_instance` > `invalid` > `ok`),
  never silently deleted, so future UI can warn. **No APG node id appears in any routing JSON.** IPC
  added to `ui/main.js` + `ui/preload.js` (`window.xleth.timeline.{add,remove,setSidechainRouteParams}`);
  no sidechain UI built.
- **Tests:** new `engine/test/test_sidechain_routes.cpp` (CMake target `test_sidechain_routes`,
  75 checks, model-only — links `XlethEngineModel`, fake resolver): old-project empty load, add by
  effectInstanceId, stable/non-empty routeId, full save/load round-trip, JSON-shape (no node ids,
  defaults omitted), load sanitization (drop malformed, clamp gain, first-duplicate-wins), every
  validation reason code, output+sidechain cycle rejection, remove, undo/redo add (same routeId),
  undo/redo remove, setParams + undo/redo + clamp, and stale-status reporting. Regression green:
  `test_track_routing` (129), `test_project` (98), `test_undo` (84), `test_chain_effect_identity`
  (51), `test_mixer_bus_routing` (25), `test_mixer_routing_pdc` (112).
- **Deferred:** sidechain DSP buffers / `SidechainSourceProcessor` / APG multi-bus wiring /
  `feedsSidechainOnly` solo policy → Prompt 4C; stock + VST sidechain detectors and capability
  probing → Prompt 5; FX Graph protected Sidechain Input node (and empty-`targetEffectInstanceId`
  track-level targets) → Prompt 6. No sends. No audible/DSP behavior change.
- **Files added/modified:** `engine/src/model/Track.cpp`, `engine/src/model/Timeline.{h,cpp}`,
  `engine/src/audio/TrackRouting.{h,cpp}`, `engine/src/commands/TimelineCommands.{h,cpp}`,
  `bridge/src/XlethAddon.cpp`, `ui/main.js`, `ui/preload.js`, `engine/CMakeLists.txt`
  (`test_sidechain_routes` target), `engine/test/test_sidechain_routes.cpp` (new), and this audit.
  `TimelineTypes.h` `SidechainRoute` was already correct from 2A — unchanged. No DSP, MixEngine
  `processBlock`, AudioGraph bus-layout, stock/VST sidechain, FX Graph graphState, or mixer-UI code
  was changed.

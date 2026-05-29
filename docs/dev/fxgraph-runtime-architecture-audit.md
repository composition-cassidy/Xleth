# FX Graph Runtime Architecture Audit

**Phase:** FXG.3-a  
**Branch:** repo-hygiene-cleanup  
**Baseline commit:** bb3e14b (FXG.2C-e — add graphState mutation UI)  
**Date:** 2026-05-29

This document audits the current runtime effect architecture and produces a concrete
implementation plan for FXG.3 graph-owned effect instances and engine graph execution.
No runtime behavior changes are made in this phase.

---

## 1. Current Chain Effect Ownership

### State shape

`ui/src/stores/effectChainStore.js` lines 281–291:

```js
chains:              { [key]: [{nodeId, pluginId, position, bypassed}] }
fxModes:             { [key]: "chain" | "graph" }
fxPanelViews:        { [key]: "chain" | "graphShell" }
graphStates:         { [key]: GraphStateDocument | null }
graphStateStatuses:  { [key]: loadGraphState result }
```

`key` is `"master"` or `String(trackId)`. An effect slot in `chains` contains exactly:

| Field      | Type    | Source                         |
|------------|---------|--------------------------------|
| `nodeId`   | integer | APG NodeID uid from C++ engine |
| `pluginId` | string  | Plugin identifier string       |
| `position` | integer | 0-based index in chain         |
| `bypassed` | boolean | Bypass state                   |

There is no `displayName`, `parameters`, or `effectInstanceId` in chain slots. Display
names are resolved client-side from `PLUGIN_NAMES` in `EffectModule.jsx` (line 68).
Parameters are fetched lazily per-editor via dedicated effect stores (`eqStore`,
`compressorStore`, etc.). `nodeId` doubles as the effect instance identity in chain mode.

### Chain persistence

Chain state is not written to project JSON by the renderer. It lives entirely in the
engine's `AudioGraph`. On save, `ProjectManager::saveProject` receives the current
`AudioGraph::getChainState()` JSON from `MixEngine` via the Node-API bridge. On load,
`ProjectManager::getLoadedEffectChains()` returns the deserialized chain JSON, and the
bridge calls `AudioGraph::fromJSON` on each track's graph.

### fxMode ownership gate

`resolveFxMode` (`effectChainStore.js:38`) returns `'chain'` for master and as default;
only explicit `fxModes[key] === 'graph'` returns `'graph'`. Every chain-mode action
(`addEffect`, `removeEffect`, `moveEffect`, `setBypass`) begins with:

```js
if (!isChainFxMode(state, key)) return false   // line 629
```

All four graph mutation actions (`addGraphEffectNodeForTrack` etc.) begin with
`readGraphStateForMutation` which rejects when `fxMode !== 'graph'`. The two systems
cannot both mutate the same track simultaneously.

---

## 2. Current Chain Effect Editor Opening Path

### Component

`ui/src/components/mixer/EffectModule.jsx` owns the editor opening path.

- **Stock effects:** `openStockEffectEditor(effect, storeKey)` (line 160) reads `pluginId`
  from the chain slot, looks up the opener in `EFFECT_EDITORS` (lines 23–66), and calls
  `store.open(trackId, nodeId, storeKey)`.
- **VST effects:** `runEffectModuleInlineAction` (line 135) calls
  `window.xleth.audio.openPluginEditor(trackId, nodeId)` (line 153), which maps to
  `ipcMain.handle('xleth:audio:openPluginEditor', ...)` → `callWorker('audio_openPluginEditor', [trackId, nodeId])` (`ui/main.js:1679`).

### Identity scheme

The `(trackId: number, nodeId: number)` pair identifies an effect instance for all
editor paths. `trackId` is the integer track ID (-1 for master). `nodeId` is the integer
APG uid from the engine's `AudioGraph`. `storeKey` (`"master"` or `String(trackId)`) is
used as the Zustand store key.

### Stock editor path

Each stock editor is a React panel backed by a Zustand store. The store holds a `target`
object `{ trackId, nodeId, storeKey }`. All parameter reads/writes go through
`window.xleth.audio.*` IPC calls that pass `(trackId, nodeId)` to the bridge.

### VST editor path

VST editors open a native OS window via `PluginEditorHost` in the C++ engine. The
bridge call `audio_openPluginEditor(trackId, nodeId)` locates the node by `nodeId` in
the track's `AudioGraph`, retrieves the `juce::AudioProcessor*` via
`AudioGraph::getProcessor(nodeId)`, and creates the JUCE plugin editor window.

### Critical constraint for FXG.3

Every stock editor store today holds `{ trackId, nodeId }` where `nodeId` is a
**chain-level APG uid**. This integer ID is assigned by the engine at effect creation
time and is reassigned on project reload (`onProjectLoaded` closes all open editors and
re-fetches chains). Graph-owned effects will need their own engine nodeIds once they
exist in a real `AudioGraph` instance — the same editor stores can reuse the
`(trackId, nodeId)` addressing scheme, but the graph-owned `nodeId` will come from a
different `AudioGraph` instance (or the same one if graph mode replaces the chain).

---

## 3. Current Engine Effect Lifecycle

### Effect base class

`engine/src/audio/XlethEffectBase.h:34`:
```cpp
class XlethEffectBase : public juce::AudioProcessor
```

All stock effects inherit from this. VST/native effects use `juce::AudioPluginInstance`
(third-party JUCE class). Both types share the `juce::AudioProcessor*` interface.

### AudioGraph — node management

`engine/src/audio/AudioGraph.h` is the authoritative runtime graph. Key lifecycle
methods (all main-thread):

| Method                                            | Purpose                                             |
|---------------------------------------------------|-----------------------------------------------------|
| `addNode(pluginId) → int`                         | Instantiates processor, inserts, returns APG uid    |
| `removeNode(nodeId) → bool`                       | Removes node and all its connections                |
| `setBypass(nodeId, bypassed) → bool`              | Bypass toggle                                       |
| `addConnection(src, dst) → bool`                  | Cycle-rejected arbitrary wiring                     |
| `removeConnection(src, dst) → bool`               | Removes wire                                        |
| `addEffect(pluginId, position) → int`             | Chain-mode helper: insert at position, wires linear |
| `removeEffect(nodeId) → bool`                     | Chain-mode remove + rewire                          |
| `moveEffect(nodeId, newPos) → bool`               | Chain-mode reorder + rewire                         |
| `getEffect(nodeId) → XlethEffectBase*`            | Access stock processor for type-specific API        |
| `getProcessor(nodeId) → juce::AudioProcessor*`    | Access any processor (stock or VST)                 |
| `isNodeMissing(nodeId) → bool`                    | True if placeholder (plugin not found at load)      |
| `tryResolvePlugin(nodeId, registry) → bool`       | Replace missing placeholder with real plugin        |
| `isNodeCrashed(nodeId) → bool`                    | True if VST crashed                                 |
| `resetCrashedPlugin(nodeId) → bool`               | SEH-guarded crash recovery                          |
| `toJSON() / fromJSON(j) → bool`                   | Serialization round-trip                            |

### EffectChainManager — track-to-AudioGraph bridge

`engine/src/audio/EffectChainManager.h` is a thin wrapper that `MixEngine` holds per
track (`std::unordered_map<int, std::unique_ptr<EffectChainManager>> effectChains_`,
`MixEngine.h:775`). It delegates all calls to an owned `AudioGraph`.

`EffectChainManager` also exposes graph-mode APIs:
`addConnection`, `removeConnection`, `setWireGain`, `setWireMute`, `setNodePosition`,
`getGraphTopology`, `isGraphLinear`.

### Effect factory

`AudioGraph::createEffect(pluginId)` (`AudioGraph.h:322`) creates a stock
`XlethEffectBase`-derived processor for known plugin IDs, and falls through to the
`PluginRegistry` to load a VST3 otherwise.

### Parameter synchronization

Parameters are synchronized on demand, not pushed in real time from the renderer:
- Read: `getEffectParameters(nodeId)` returns a JSON array
- Write: `setEffectParameter(nodeId, paramId, value)` updates atomically

For stock editors, polling or explicit refresh is used. For VSTs, parameter changes go
through the JUCE editor GUI directly without IPC.

### Effect destruction

`AudioGraph::removeNode` removes the `juce::AudioProcessorGraph::Node` from JUCE's APG,
which calls `releaseResources()` and destroys the processor.

---

## 4. Current Audio Execution Model

### Execution owner

`AudioGraph::processBlock(buffer, numSamples, midi)` (`AudioGraph.h:165`) is called
from `EffectChainManager::processBlock`, which is called by `MixEngine` once per audio
block per track (main audio thread only).

### Topology model

`AudioGraph` wraps `juce::AudioProcessorGraph`. JUCE's APG performs its own topological
sort internally and builds an atomic `RenderSequence` that the audio thread swaps in.
`AudioGraph` maintains a parallel topology model (`nodes_`, `connections_`, `adjForward_`,
`adjReverse_`, `linearOrder_`) for:
- Cycle detection before `addConnection`
- PDC computation
- `isGraphLinear()` check
- Chain-mode position tracking

### Is processing strictly linear today?

In **chain mode**, `AudioGraph` uses `addEffect/removeEffect/moveEffect` which maintains
a strictly linear `trackInput → effect_0 → effect_1 → ... → trackOutput` wiring.
`isGraphLinear()` returns true.

In **graph mode** (not yet activated from renderer through FXG.2C), `AudioGraph` already
supports arbitrary fan-out/fan-in via `addConnection`. JUCE's APG handles the actual
summing of multiple inputs into a node. The `AudioGraph` topology model and PDC code
already handle non-linear graphs.

**Key finding:** The engine is already capable of non-linear execution. The renderer
graph edit state (`graphState`) just has not yet been wired to the engine.

### What assumptions would break with a DAG?

1. `isGraphLinear()` returns false — callers (bridge serialization queries) must handle
   this gracefully.
2. PDC in non-linear topologies: parallel branches may have different cumulative
   latencies. `computePDC()` already inserts `DelayCompensationProcessor` nodes to align
   branches at merge points. This is implemented but not exercised by real graph routing yet.
3. `getChainState()` returns the linear chain as `[{nodeId, pluginId, position, bypassed}]`.
   In graph mode this will not represent the full topology; `getGraphTopology()` should
   be used instead.
4. `onGraphChanged` event listener in `effectChainStore.js:721` calls `fetchChain(key)`
   which reads `getChainState()`. This will be incomplete for non-linear graphs.

### Buffer allocation

`juce::AudioProcessorGraph` allocates its own internal buffers per node. The caller
(`MixEngine`) passes a stereo `juce::AudioBuffer<float>` by reference to
`EffectChainManager::processBlock`, which passes it to `AudioGraph::processBlock`, which
passes it to JUCE's APG. JUCE maps the provided buffer to the APG's I/O nodes and
manages internal per-node buffers internally.

### Available utility processors

`engine/src/audio/UtilityProcessors.h` (untracked, newly added):

| Processor                   | ID                              | Purpose                                              |
|-----------------------------|---------------------------------|------------------------------------------------------|
| `BalanceProcessor`          | `xleth.utility.balance`         | Stereo volume (dB) + balance pan; SmoothedValue gain |
| `MergeProcessor`            | `xleth.utility.merge`           | Stereo passthrough; JUCE sums multiple inputs        |
| `MidSideSplitterProcessor`  | `xleth.utility.midSideSplitter` | 1 stereo in → mid/side stereo out buses              |
| `FrequencySplitterProcessor`| `xleth.utility.frequencySplitter`| LR crossover splitter, 2/3/4 bands                  |

`MergeProcessor` is directly usable as a fan-in sum node for parallel branch execution.
`BalanceProcessor` supports wet/dry-style gain on a branch.

Bypass/tails/latency:
- `AudioGraph::getMaxTailLengthSeconds()` walks all effect nodes (safe from audio thread).
- `AudioGraph::getOutputLatencySamples()` and `getLatencyEpoch()` provide PDC info.
- Per-wire gain and mute are already implemented (`setWireGain`, `setWireMute`).
- `ScopedNoDenormals` is used in utility processor `processBlock` calls.

### Where fan-out/fan-in can safely happen

The underlying `juce::AudioProcessorGraph` already handles fan-out (one source node
connected to multiple destination nodes) and fan-in (JUCE sums multiple inputs into one
node). The `AudioGraph` wrapper already has:
- Cycle rejection (`wouldCreateCycle` using DFS)
- Kahn's BFS topological sort with level groupings (line 25 comment)
- PDC with `DelayCompensationProcessor` at merge points (line 26 comment)
- Per-wire gain smoothing (line 27 comment)

The only missing piece is the renderer → bridge → engine wiring for graph-mode routing.

---

## 5. Current Project Serialization and Load/Hydration

### effectChains serialization

`ProjectManager::saveProject` (`engine/src/project/ProjectManager.h:31`) receives:
- `effectChains`: JSON object keyed by `String(trackId)`, value is `AudioGraph::toJSON()`
- `masterEffectChain`: JSON for the master track's chain

These are written to `project.json` under `"effectChains"` and `"masterEffectChain"`.

The bridge collects chain JSON by calling `EffectChainManager::graphToJSON()` per track
before save. On load, `ProjectManager::getLoadedEffectChains()` returns the raw JSON,
and the bridge calls `EffectChainManager::graphFromJSON(j)` per track which delegates
to `AudioGraph::fromJSON(j)`.

### graphState serialization (renderer-side)

`graphState` is persisted via the bridge call
`window.xleth.timeline.setTrackGraphState(trackId, graphStateDocument)`, which maps to
`ipcMain.handle('xleth:timeline:setTrackGraphState', ...)` → `callWorker('timeline_setTrackGraphState', [trackId, graphState])` (`ui/main.js:648`).

This stores `graphState` inside the `Timeline` model (C++ side), not inside `AudioGraph`.
On load, `graphState` is returned with the track data and hydrated into `effectChainStore`
via `buildGraphStateHydrationFromTracks` (`effectChainStore.js:53`).

### What needs to be serialized for graph-owned effect instances

Today's `AudioGraph::toJSON()` already serializes the full graph topology including:
- All nodes with `{nodeId, pluginId, x, y}`
- All connections
- VST descriptions for round-trip fidelity

When graph mode owns the engine instances, the serialization path will be:
- The renderer's `graphState` remains the canonical topology reference for the UI.
- The engine-side `AudioGraph` for the track will serialize via `graphToJSON()` as today.
- `graphState` node data must include the stable `effectInstanceId` that maps renderer
  nodes to engine `nodeId`s across sessions.

### Renderer → engine hydration after load

The current post-load sequence:
1. `ProjectManager::loadProject` reads `project.json` → returns `Timeline` + effect chain JSON.
2. Bridge sets up `MixEngine` track routing.
3. Bridge calls `EffectChainManager::graphFromJSON(j)` per track → `AudioGraph::fromJSON`.
4. `onProjectLoaded` event fires in renderer → `effectChainStore` resets and re-fetches
   all chains via `fetchChain(key)`.
5. `hydrateFxModesFromTracks` and `buildGraphStateHydrationFromTracks` restore `fxModes`
   and `graphStates` from track data.

Steps 3–4 assume chain mode. Graph mode hydration will require an additional step: after
graph-owned engine instances are created, the bridge must notify the renderer of the new
engine `nodeId`s so the renderer's `graphState` nodes can be associated with real processors.

---

## 6. FXG.3 Graph-Owned Effect Instance Proposal

### Problem statement

Today, `graphState` effect nodes carry `{ effectInstanceId, pluginId, displayName, bypass,
missing, crashed }` but have no corresponding engine processor. The `effectInstanceId`
was introduced in FXG.2C-e as a forward-compatibility anchor. The question is: how should
graph-owned engine instances be tracked alongside `graphState`?

### Recommended data model

**Option A — effectInstanceId IS the stable cross-session identity; engine nodeId is
session-transient.**

Each `graphState` effect node has a stable `effectInstanceId` (UUID, generated at node
creation, persisted in project JSON with `graphState`). When the engine instantiates the
node, the engine assigns an integer APG `nodeId`. The bridge maintains a mapping
`{ [effectInstanceId]: engineNodeId }` that is valid only for the current session.

This keeps `graphState` as the single source of truth for identity and the bridge as the
transient mapping layer. It avoids embedding session-specific engine IDs in persistent
project state.

```
graphState node:
  { id, type: 'effect', data: { effectInstanceId (UUID), pluginId, displayName, ... } }

Engine (per-session):
  AudioGraph nodeId (integer APG uid)  ← assigned at instantiation

Bridge mapping (per-session):
  graphEffectNodeMap: { [trackId]: { [effectInstanceId]: engineNodeId } }
```

**On project save:** `graphState` (with `effectInstanceId`) + `AudioGraph::toJSON()` (with
`engineNodeId` + topology). The project JSON contains both; they are reconciled on load.

**On project load:**
1. Bridge loads `AudioGraph::fromJSON(j)` → produces engine `nodeId`s for each node.
2. Bridge maps `effectInstanceId` → `engineNodeId` by matching `pluginId` and position,
   or by a persisted mapping in the chain JSON (`"xlethEffectInstanceId"` extra field in
   `AudioGraph::toJSON()` node entries).
3. Bridge emits `graphEffectNodeMap` to renderer so `graphState` node UIs can show live
   status (missing, crashed, parameters).

### Where should graph-owned effect instance data live?

Inside `graphState` node `data`, exactly as today. No separate `graphEffects` map needed
in the renderer. The renderer `graphState` is already the canonical representation.
Additional live metadata (bypass state from engine, meter values, parameter values) can
be fetched on demand using `(trackId, engineNodeId)` once the bridge mapping exists.

### node.id vs effectInstanceId

Keep them **separate**:
- `node.id` is the graph topology ID (used for edge source/target references, internal
  graph operations).
- `effectInstanceId` is the cross-session effect instance identity (used to associate
  renderer nodes with engine processors across project loads).

They were intentionally separate in FXG.2C-e. Do not collapse them.

### Placeholder nodes from FXG.2C-e

Current "Add Effect Node" creates nodes with `pluginId: 'placeholder'` and a generated
`effectInstanceId`. These are topology-valid but have no real processor.

In FXG.3-b, adding a node should require specifying a real `pluginId` (from a picker or
the existing `EFFECT_EDITORS` registry). Alternatively, retain placeholder support but
clearly mark them as non-executable. The engine must not try to instantiate a
`'placeholder'` plugin.

### Disconnected graph effect nodes

Disconnected effect nodes (not on any path from `trackInput` to `trackOutput`) should
still have engine instances allocated (they are part of the graph's owned resource set)
but their audio output will be silent (no input signal reaches them). The engine already
handles this: `juce::AudioProcessorGraph` will call `processBlock` on nodes that have
no active connections, but with a zeroed input buffer.

**Risk:** Disconnected nodes waste CPU. Addressed in section 9.

### Serialization of graph-owned effect instances

`graphState` with `effectInstanceId` per node → persisted via `timeline.setTrackGraphState`.  
`AudioGraph::toJSON()` → persisted via `effectChains` in `project.json`.  
Bridge maps the two on load. No new serialization format needed in FXG.3-b.

To make the round-trip unambiguous, `AudioGraph::toJSON()` should include
`"effectInstanceId"` as an extra field in each node entry. This is a small additive
change to the engine serialization schema, non-breaking for old projects (missing field
= legacy chain node, no `effectInstanceId`). This work belongs in FXG.3-b or FXG.3-c.

### Destruction

Graph-owned effect instances are destroyed when:
- `removeGraphNodeForTrack` succeeds (renderer mutation) → bridge calls
  `EffectChainManager::removeEffect(engineNodeId)` (via new graph-mode bridge API).
- Track is deleted.
- Project is closed (`MixEngine` teardown destroys all `EffectChainManager` instances).

### Editing

Graph-owned effects are edited using the same `(trackId, engineNodeId)` pair that chain
effects use. The editor stores (`eqStore`, `compressorStore`, etc.) accept any
`(trackId, nodeId)` — they do not care whether the node is chain-owned or graph-owned.
The bridge path for stock editors and VST editors is identical once the `engineNodeId`
is known.

---

## 7. FXG.3 Edit Button Proposal

### UI component ownership

The Edit button should live on the `GraphStatePreview` effect node component
(`ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx`). This is the same component
that already owns the per-node remove button.

The button is passed down via a callback prop:
```ts
onEditNode?: (nodeId: string) => void
```

`FxGraphPanel.tsx` wires the handler:
```ts
const handleEditGraphNode = useCallback(async (nodeId: string) => {
  // look up engineNodeId from bridge mapping via xleth.audio.getGraphEffectNodeId(trackId, effectInstanceId)
  // then call openStockEffectEditor or openPluginEditor
}, [selectedTrack?.id, fxMode])
```

### Store action

No new Zustand store action is needed. The Edit button callback resolves
`(trackId, engineNodeId)` and calls the existing `EFFECT_EDITORS[pluginId]` opener
(for stock effects) or `window.xleth.audio.openPluginEditor(trackId, engineNodeId)` (for
VSTs). This is identical to the chain mode path in `EffectModule.jsx:160–168`.

### What ID is passed

The `onEditNode` callback receives `node.id` (the graph topology ID). The handler maps
this to `effectInstanceId` (from `node.data.effectInstanceId`), then asks the bridge for
the current session `engineNodeId`:

```
xleth.audio.getGraphEffectEngineNodeId(trackId, effectInstanceId) → engineNodeId | null
```

If `null` (effect not yet instantiated), the button shows a disabled state or "Not
available yet" notice.

### Abstraction to support both chain and graph mode

`openStockEffectEditor` in `EffectModule.jsx` already takes `(effect, storeKey)` where
`effect = { pluginId, nodeId }`. For graph mode, the caller constructs a compatible
object: `{ pluginId: node.data.pluginId, nodeId: engineNodeId }`.

No code change in `EffectModule.jsx` or any editor store is required. The mapping
from graph `effectInstanceId` → engine `nodeId` is the only new piece.

### Chain editor behavior unchanged

Chain effects continue to use `EffectModule.jsx` and call `openStockEffectEditor` with
chain slot data. No change to `EffectModule.jsx` or the mixer chain panel.

### Placeholder/data-only nodes with no real engine instance

If `getGraphEffectEngineNodeId` returns null (FXG.3-b pre-instantiation, or a placeholder
node):
- Edit button renders as disabled with tooltip "Effect not yet active".
- No editor store is opened.
- No IPC call is made.

---

## 8. FXG.3 Engine Execution — Phased Plan

### FXG.3-b — Graph-owned effect instances + Edit button (no graph routing)

**Goal:** Effect nodes added via the graph UI create real engine processors. Edit button
works. Chain routing in the engine is unchanged (graph mode track still routes linearly
Input → effects in order → Output; graph topology is not yet respected by audio execution).

**Renderer files likely touched:**
- `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx` — add `onEditNode` prop + Edit button UI
- `ui/src/windowing/panels/FxGraphPanel.tsx` — wire `handleEditGraphNode` callback
- `ui/src/stores/effectChainStore.js` — add `addGraphEffectNodeForTrack` overload that
  calls bridge to instantiate engine processor, store `engineNodeId` in session map

**Bridge files likely touched:**
- `ui/main.js` — add IPC handlers:
  - `xleth:audio:addGraphEffectNode(trackId, effectInstanceId, pluginId, position)` → `audio_addGraphEffectNode`
  - `xleth:audio:removeGraphEffectNode(trackId, effectInstanceId)` → `audio_removeGraphEffectNode`
  - `xleth:audio:getGraphEffectEngineNodeId(trackId, effectInstanceId)` → `audio_getGraphEffectEngineNodeId`
  - Existing `openPluginEditor` and stock editor IPCs are reused unchanged

**Engine files likely touched:**
- `engine/src/audio/EffectChainManager.h/.cpp` — add graph-mode instance lifecycle methods:
  - `addGraphNode(effectInstanceId, pluginId) → int` (returns engine nodeId)
  - `removeGraphNode(effectInstanceId) → bool`
  - `getEngineNodeId(effectInstanceId) → int`
  - Internal `effectInstanceIdMap_: unordered_map<string, int>`
- `engine/src/audio/AudioGraph.h/.cpp` — likely no change needed (already has `addNode`)
- Bridge worker (Node-API binding) — wire new IPC methods to `EffectChainManager`

**Tests needed:**
- Unit: `EffectChainManager` `addGraphNode` / `removeGraphNode` / `getEngineNodeId`
- Unit: bridge IPC handler returns correct engine nodeId
- Renderer: `addGraphEffectNodeForTrack` calls bridge and persists effectInstanceId
- Renderer: Edit button calls `getGraphEffectEngineNodeId` before opening editor

**Manual smoke tests:**
- Switch track to graph mode → add graph effect node → engine processor exists (verify
  via parameter fetch)
- Click Edit on graph node → editor panel opens and shows parameters
- Remove graph effect node → engine processor destroyed
- Project save/load → graph effect nodes survive round-trip with correct processor

**Non-goals:**
- Graph audio routing (track still routes as linear chain)
- Bypass from graph node affecting engine
- Parameter changes from editor persisting through graphState

---

### FXG.3-c — Linear graph execution parity

**Goal:** When a track is in graph mode and its `graphState` topology is a single linear
path (`isGraphLinear() === true`), the engine executes that path. Functionally equivalent
to chain mode but driven by `graphState`.

```
Track Input → effect_a → effect_b → Track Output
```

**Strategy:** After `graphState` mutations are applied, send a sanitized topology payload to a
linear-only bridge API. The engine validates the single Track Input to Track Output path, resolves
`graphState node.id -> effectInstanceId -> engineNodeId`, and rebuilds `AudioGraph` connections
with graph-owned processors. It must not call chain `addEffect`, `moveEffect`, or mutate chain
slots.

**Renderer files likely touched:**
- `ui/src/stores/effectChainStore.js` — after successful `applyGraphStateMutation`, call
  `syncLinearGraphTopology(trackId, topology)` if graph mode is active. Do not call it for
  layout-only node position or viewport changes.
- `FxGraphPanel.tsx` - surface a small runtime status without persisting it into graphState

**Bridge files likely touched:**
- `ui/main.js` - add `xleth:audio:syncLinearGraphTopology(trackId, topologyJson)` IPC handler

**Engine files likely touched:**
- `EffectChainManager` - add `syncLinearGraphTopology(topologyJson)` that:
  1. Validates incoming node/edge list and rejects nonlinear active paths.
  2. Ignores disconnected effect nodes.
  3. Resolves active effect nodes through the graph-owned `effectInstanceId -> engineNodeId` map.
  4. Replaces graph-owned runtime connections with `Track Input -> effects -> Track Output`.
  5. Applies safe passthrough on unsupported topology so stale old routing cannot remain active.

**Tests needed:**
- Engine: `syncLinearGraphTopology` produces correct linear chain in `AudioGraph`
- Engine: linear audio passes through correctly (signal integrity test)
- Renderer: `syncLinearGraphTopology` called after routing-affecting graph mutations in graph mode

**Manual smoke tests:**
- Switch to graph mode with 2 effects connected linearly → audio still processes both effects
- Reorder graph nodes (disconnect/reconnect) → audio chain order changes
- Remove a node from the linear path → audio bypasses that effect

**Non-goals:**
- Parallel branches
- PDC across parallel branches
- Wet/dry controls
- Latency compensation UI

---

### FXG.3-d — Parallel fan-out/fan-in execution

**Goal:** The engine executes parallel branches, mixing branch outputs at `trackOutput`.

```
Track Input ──→ Compressor A ──────────────────→ Track Output
             └→ Flanger ──→ Compressor B ──→ ┘
```

**Strategy:** `AudioGraph` already supports this via JUCE APG. FXG.3-d should introduce a
parallel-capable topology sync separate from the FXG.3-c-b linear-only contract. JUCE sums
multiple inputs into a node natively. PDC at the merge node is handled by
`computePDC()` inserting `DelayCompensationProcessor` nodes.

For the renderer, no additional mutation UI is needed — fan-out/fan-in is already
expressible via `connectGraphNodes` (FXG.2C-e). The Edit button and node management are
the same.

**New concerns:**
- `MergeProcessor` (`xleth.utility.merge`) should be used at the output-bus level, not
  as an explicit user-visible node. JUCE's APG handles multi-input summing directly.
  `MergeProcessor` may be needed as an explicit sum node if the `trackOutput` JUCE node
  does not support multi-input natively in the current APG setup.
- Per-branch wet/dry: `BalanceProcessor` (`xleth.utility.balance`) can be inserted on
  individual branches for gain scaling.
- PDC at merge points: already handled by `AudioGraph::computePDC()`.

**Renderer files likely touched:**
- None beyond FXG.3-c changes (fan-out/fan-in is already expressible via existing UI)

**Bridge files likely touched:**
- `ui/main.js` - expose the parallel-capable graph topology sync without implying FXG.3-c-b
  linear sync supports fan-out/fan-in.

**Engine files likely touched:**
- `EffectChainManager` - add or extend a parallel-capable sync path for multi-source,
  multi-destination edges (no chain slot mutation; `AudioGraph::addConnection` already handles
  these)
- Verify `AudioGraph::computePDC()` correctly inserts delay nodes at merge points when
  parallel branches have different cumulative latencies (existing but untested code path)

**Tests needed:**
- Engine: two-branch topology produces summed output at correct level
- Engine: PDC correctly aligns branches with differing latency
- Engine: disconnected branch node does not produce signal at output
- Signal integrity: fan-out then fan-in with identity effects = 6 dB louder (JUCE sums
  samples; may need gain normalization at merge)

**Manual smoke tests:**
- Two branches, both connected to output → both audible simultaneously
- One branch bypassed → only one branch audible
- One branch disconnected → silence from that branch, no CPU waste from disconnected node

**Non-goals:**
- Wet/dry controls exposed in UI
- Per-branch gain UI
- Latency compensation display in renderer
- Feedback/cycle detection UI (cycles already rejected by `AudioGraph`)

---

### FXG.3-e or later — Performance, polish, latency display

**Goal:** Address production-quality concerns deferred from FXG.3-d.

Items for this phase or later:
- Silence detection / suspended processing for disconnected nodes
- Per-branch gain/balance UI node in the graph workspace
- Latency display in the FX Graph panel
- Wet/dry blend control per-branch
- Undo/redo for graph mutations (with engine sync)
- Performance profiling and CPU budget per graph node
- Tail handling on track mute (honor `getMaxTailLengthSeconds()`)
- Mute/solo interaction with graph routing

---

## 9. Risk Analysis

### Accidentally mutating effectChains

**Risk:** A graph-mode code path inadvertently calls `addEffect`/`removeEffect` on the
chain, or a bridge function conflates chain and graph node IDs.

**Mitigations:**
- `isChainFxMode` gate in all chain store actions (already in place).
- `readGraphStateForMutation` gate in all graph store actions (already in place).
- New bridge APIs for graph nodes (`addGraphEffectNode`, etc.) must be separate from
  chain APIs (`addEffect`, etc.) — never share IPC channel names.
- Engine-side: `EffectChainManager::addGraphNode` should be a separate method from
  `addEffect`; the latter rewires the linear chain and must not be called in graph mode.

### Duplicating effect editor logic

**Risk:** A second code path to open editors is created for graph nodes, diverging from
the `EffectModule.jsx` chain path and causing future maintenance issues.

**Mitigation:** As proposed in section 7, the graph node Edit button resolves
`engineNodeId` and then calls the existing `openStockEffectEditor` / `openPluginEditor`
paths unchanged. No new editor store, no new IPC handler. The editor stores are
identity-agnostic (`trackId + nodeId`).

### Graph nodes with no real processor identity

**Risk:** A graph node exists in `graphState` but the engine has no corresponding
processor — Edit button hangs, parameter calls return garbage, session inconsistency.

**Mitigations:**
- `getGraphEffectEngineNodeId` returns `null` for uninstantiated nodes.
- Edit button is disabled when `engineNodeId` is null.
- Parameter calls are guarded on non-null `engineNodeId`.
- FXG.3-b ensures every non-placeholder node is instantiated when graph mode is activated.
- Placeholder nodes (`pluginId: 'placeholder'`) must not be instantiated in the engine.

### Project load producing UI graph nodes but no engine processors

**Risk:** Project loads, `graphState` hydrates correctly, but bridge fails to reinstantiate
engine processors, leaving the session in a split state.

**Mitigations:**
- On `onProjectLoaded`, after graphState/fxMode hydration, FXG.3-c-a calls the explicit
  graph-owned hydrate API for normal graph-mode tracks and rebuilds the session mapping.
- If engine instantiation fails for a node, leave graphState visible and unresolved for this
  session; the Edit action resolves to "Effect is not active yet" instead of passing a graph
  topology id to an editor store.
- The `isNodeMissing` / `tryResolvePlugin` machinery in `AudioGraph` already handles
  missing plugins at load time.

### Fan-out causing clipping

**Risk:** Splitting signal to two branches and summing at output doubles amplitude.
JUCE sums samples directly (linear), so a 0 dBFS signal through two identity branches
sums to +6 dBFS.

**Mitigations:**
- The `trackOutput` node does not auto-normalize.
- For FXG.3-d, document this clearly — branch summing is additive.
- Long-term: expose `BalanceProcessor` as a user-visible merge gain node, or apply
  a 0.5x normalization factor at the merge connection (`setWireGain(src, trackOutput, 0.5f)`).
- Do not silently add normalization in FXG.3-c or FXG.3-d without clear UI indication.

### Disconnected nodes wasting CPU

**Risk:** Graph nodes with no connection to `trackOutput` still receive `processBlock`
calls from JUCE's APG, wasting CPU on effects producing inaudible output.

**Mitigations:**
- Short-term (FXG.3-b/c): acceptable for a small number of nodes.
- Medium-term (FXG.3-e): `AudioGraph::isNodeLinear()` → check for disconnected nodes
  and either skip them or gate them with silence detection.
- JUCE APG may already optimize disconnected nodes (verify in engine tests).
- Keep `kMaxNodes = 256` limit (`AudioGraph.h:331`) as a hard cap.

### Effect latency in parallel branches (PDC)

**Risk:** Two parallel branches with different cumulative latency produce phase issues
or time-domain artifacts when summed.

**Mitigation:**
- `AudioGraph::computePDC()` already inserts `DelayCompensationProcessor` nodes at merge
  points to align branches. This code path exists but is untested in the fan-out scenario.
- FXG.3-d must include a PDC correctness test: two parallel branches with known latency
  difference → output delayed by the longer branch, shorter branch padded.
- `getLatencyEpoch()` allows the renderer to detect PDC changes and update any latency
  display.

### Cycles and feedback loops

**Risk:** Graph editor allows a connection that would create a cycle.

**Mitigation (already in place):**
- `graphState.js:hasAudioCycle` (DFS) rejects cycles at the renderer mutation layer.
- `AudioGraph::wouldCreateCycle` (DFS) rejects cycles at the engine layer.
- Both checks are independent safety layers.

### Bypass behavior in graph mode

**Risk:** Node bypass in graph mode may behave differently than in chain mode.
In chain mode, a bypassed node passes audio through (dry passthrough). In graph mode,
a bypassed node on a parallel branch should still pass audio — but what does "bypassed"
mean for a node that fans out to multiple targets?

**Mitigation:**
- `AudioGraph::setBypass(nodeId, bypassed)` calls JUCE APG's built-in bypass, which
  replaces the processor with a passthrough. This is per-node and topology-independent.
- Graph mode bypass behavior matches chain mode: bypassed node = passthrough.
- No special handling needed for fan-out topology.

### Track mute/solo interaction

**Risk:** Track mute/solo in `MixEngine` may bypass at the `EffectChainManager`
processBlock level, not at the `AudioGraph` level. This is fine for graph mode — the
entire track's audio processing is muted, which includes the graph.

**No additional risk beyond chain mode.** Verify in FXG.3-d manual tests.

### Tails / reverb / delay handling

**Risk:** When a track is muted or its graph is cleared, ongoing reverb/delay tails are
cut abruptly.

**Mitigation:**
- `AudioGraph::getMaxTailLengthSeconds()` reports the longest tail. `MixEngine` should
  honor this before zeroing the track buffer.
- This is an existing concern for chain mode and is not made worse by graph mode.
- Explicit tail handling is deferred to FXG.3-e.

### Undo/redo

**Risk:** `graphState` mutations are persisted immediately via `timeline.setTrackGraphState`.
There is no undo stack for graph mutations today. Engine state and renderer state can
diverge if the user wants to undo.

**Mitigation:**
- Undo/redo is deferred beyond FXG.3-e.
- For FXG.3-b/c/d, document that graph mutations are not undoable.
- Do not add `undo/redo` infrastructure in FXG.3 phases without a separate scoped phase.

### Crash safety if plugin/editor fails

**Risk:** A VST plugin crashes inside `AudioGraph::processBlock`. JUCE's
`GuardedPluginWrapper` catches SEH exceptions and marks `crashed_ = true`. The node is
flagged as crashed via `isNodeCrashed(nodeId)`. The bridge can surface this to the
renderer. `resetCrashedPlugin(nodeId)` attempts SEH-guarded recovery.

**Graph mode has the same crash safety as chain mode** — both use `AudioGraph` nodes
wrapped by `GuardedPluginWrapper`. The renderer graph node's `crashed: true` flag is
already part of the `graphState` node data model (set in FXG.2C-e).

On crash, the renderer should update `graphState.node.data.crashed = true` via a new
bridge event or by polling `isNodeCrashed`. A "Reset" action on the graph node Edit
button (parallel to `EffectModule.jsx:118`) can trigger `resetCrashedPlugin`. This is
a FXG.3-b deliverable.

---

## 10. Recommended Implementation Sequence

### FXG.3-b: Graph-owned effect instances + Edit button path

**Goal:** Real engine processors behind graph nodes. Edit button opens the same editor
as chain mode. No change to audio routing.

**Commit scope:**
1. Engine: `EffectChainManager` — add `addGraphNode(effectInstanceId, pluginId)`,
   `removeGraphNode(effectInstanceId)`, `getEngineNodeId(effectInstanceId)` with
   `effectInstanceIdMap_`.
2. Engine: `AudioGraph::toJSON` — include `"effectInstanceId"` in node entries.
3. Bridge: Node-API binding — expose `audio_addGraphEffectNode`,
   `audio_removeGraphEffectNode`, `audio_getGraphEffectEngineNodeId`.
4. Bridge: `ui/main.js` — add three new IPC handlers (no changes to chain handlers).
5. Renderer: `effectChainStore.js` — `addGraphEffectNodeForTrack` calls bridge to
   instantiate processor; new `graphEffectNodeMap` session cache for `effectInstanceId → engineNodeId`.
6. Renderer: `GraphStatePreview.tsx` — `onEditNode` prop + disabled-state Edit button.
7. Renderer: `FxGraphPanel.tsx` — `handleEditGraphNode` that resolves `engineNodeId`
   and calls existing editor opener.
8. Project load: bridge hydrates graph-owned processors after loading `graphState`.

**Prompt:** `FXG.3-b add graph-owned effect instances and Edit button path`

#### Implementation note (FXG.3-b, shipped)

Built largely as planned, with these concrete decisions:

1. **Engine** — `EffectChainManager::addGraphNode/removeGraphNode/getGraphNodeEngineId/hasGraphNode`
   with a private `graphNodeIds_` map (`effectInstanceId → APG uid`). Uses the low-level
   `AudioGraph::addNode/removeNode` (not `addEffect`), so graph-owned nodes never mutate the
   linear chain. `MixEngine::addGraphEffectNode/removeGraphEffectNode/getGraphEffectEngineNodeId`
   forward per-track, auto-init the per-track chain, reject the master track, and close any open
   editor before destroying a node (mirrors `removeEffect`'s ordering, lock released first).
2. **`AudioGraph::toJSON` was NOT extended with `effectInstanceId`.** Full serialization round-trip
   proved more invasive than warranted for FXG.3-b (it also needs load-time reconciliation /
   processor re-instantiation, which the audit defers). The `effectInstanceId → engineNodeId`
   mapping is therefore **session-only**: it is rebuilt each session and wiped on project load.
   **Required FXG.3-c follow-up:** persist `effectInstanceId` in `AudioGraph::toJSON` node entries
   and re-instantiate graph-owned processors on project load so they survive save/load.
3. **Bridge** — `audio_addGraphEffectNode`/`audio_removeGraphEffectNode`/`audio_getGraphEffectEngineNodeId`
   (+ `xleth:audio:*` IPC via `safeHandler`, no `graph:changed` broadcast, + `window.xleth.audio.*`).
4. **Store** — `addGraphEffectNodeForTrack` instantiates before commit (fail-fast + rollback);
   placeholder nodes stay renderer-only; `removeGraphNodeForTrack` destroys the processor before
   commit (fail-fast). Session-only `graphEngineNodeIds` cache mirrors what was instantiated.
5. **Editor opener** — extracted shared `ui/src/components/mixer/effectEditorOpeners.js`
   (`EFFECT_EDITORS`, `PLUGIN_NAMES`, `openEffectEditorByEngineNode`); `EffectModule.jsx` and
   `FxGraphPanel.tsx` both use it. Chain behavior unchanged.
6. **Edit button** lives on `GraphStatePreview` effect nodes (tokenized, disabled for
   placeholder/missing); `FxGraphPanel.handleEditGraphNode` resolves `node.id → effectInstanceId
   → engineNodeId` via the bridge and never passes `node.id` to an editor store.

---

#### Implementation note (FXG.3-c-a, shipped)

FXG.3-c-a fills the save/load hydration gap; FXG.3-c-b builds on it by syncing supported
linear graph cables after graph-owned processors are hydrated:

1. **Engine** - `EffectChainManager::hydrateGraphNodes` and
   `MixEngine::hydrateGraphEffectNodes` accept minimal renderer graphState metadata
   (`effectInstanceId`, `pluginId`, optional diagnostics) and use graph-owned `addGraphNode`
   semantics. Hydration is idempotent, rejects master tracks through `MixEngine`, skips
   placeholders, reports per-node failures, and never calls chain `addEffect` / `moveEffect`.
2. **Serialization** - `EffectChainManager::graphToJSON` additively writes
   `effectInstanceId` only for graph-owned nodes. `graphFromJSON` tolerates missing fields for
   older projects and rebuilds the runtime `effectInstanceId -> engineNodeId` map when the field
   exists.
3. **Bridge** - `audio_hydrateGraphEffectNodes` plus matching
   `xleth:audio:hydrateGraphEffectNodes` IPC and `window.xleth.audio.hydrateGraphEffectNodes`
   expose the batch hydration path separately from chain APIs.
4. **Store** - `hydrateGraphEffectInstancesForLoadedProject` runs after
   `hydrateFxModesFromTracks` in `onProjectLoaded`, only for normal graph-mode tracks. It skips
   placeholders, missing nodes, protected nodes, and nodes without `effectInstanceId`, then merges
   successful mappings into the session-only `graphEngineNodeIds` cache. Failures do not remove
   graphState nodes or mutate `effectChains`.
5. **Routing** - FXG.3-c-b calls the explicit linear topology sync after hydration and after
   routing-affecting graph mutations. The sync is linear-only and does not mutate chain slots.

---

### FXG.3-c-b: Linear graph execution parity

**Goal:** Single linear chain in graph mode routes audio correctly via graph topology.

**Commit scope:**
1. Engine: `EffectChainManager::syncLinearGraphTopology(topologyJson)` rebuilds supported
   linear `AudioGraph` connections from provided topology.
2. Bridge: `xleth:audio:syncLinearGraphTopology(trackId, topologyJson)` IPC handler.
3. Renderer: `effectChainStore.js` `applyGraphStateMutation` calls
   `syncLinearGraphTopology` after routing-affecting graph-mode edits and after hydration.
4. Tests: signal integrity test for linear graph execution.

**Prompt:** `FXG.3-c-b wire linear graph execution into engine`

#### Implementation note (FXG.3-c-b, shipped)

FXG.3-c-b enables runtime execution only for one linear audio path on graph-mode normal tracks:

1. **Topology** - exactly one Track Input and one Track Output, with a single directed active path.
   Disconnected effect nodes are ignored; active fan-out, fan-in, cycles, unknown nodes,
   placeholders, and missing active mappings are rejected.
2. **Identity** - the renderer sends graph node ids and `effectInstanceId`s; the engine resolves
   `effectInstanceId -> engineNodeId` through the graph-owned map. Renderer `node.id` values are
   never passed to AudioGraph connection APIs.
3. **Safe fallback** - unsupported nonlinear topologies return `nonlinear_deferred` and clear the
   previous graph-owned route to safe passthrough, leaving processors and graphState intact.
4. **Separation** - the sync path never calls chain `addEffect`/`moveEffect`, never mutates
   `effectChains`, and leaves chain-mode behavior unchanged.
5. **Status** - renderer runtime sync status is session-only (`graphRuntimeStatuses`) and only used
   for small UI feedback such as "Parallel routing comes in FXG.3-d. Audio is using safe
   passthrough."

---

### FXG.3-d: Parallel fan-out/fan-in execution

**Goal:** Multi-branch topologies execute correctly with PDC alignment.

**Commit scope:**
1. Engine: verify `computePDC()` correct for non-linear graphs (add targeted test).
2. Engine: verify `MergeProcessor` or direct JUCE APG multi-input handles fan-in.
3. Bridge: a future parallel-capable graph topology sync handles non-linear topologies without
   reusing the FXG.3-c-b linear-only contract.
4. Tests: two-branch PDC alignment test, amplitude sum test.
5. Documentation: note that branch summing is additive, no auto-normalization.

**Prompt:** `FXG.3-d enable parallel fan-out/fan-in graph execution`

---

### FXG.3-e or later: Polish, latency, performance

- Silence detection for disconnected nodes
- Tail handling on mute/graph clear
- Per-branch gain/balance node UI
- Latency display in graph panel
- Undo/redo infrastructure
- Mute/solo interaction audit

---

## Appendix A: Key File Reference

| File | Role |
|------|------|
| `ui/src/stores/effectChainStore.js` | Chain + graph renderer state, fxMode gate, mutation actions |
| `ui/src/fxgraph/graphState.js` | Pure graph topology mutations, cycle detection, validation |
| `ui/src/fxgraph/chainToGraphState.js` | Chain-to-graph conversion (read-only, run once) |
| `ui/src/windowing/panels/FxGraphPanel.tsx` | FX Graph workspace panel, wires all callbacks |
| `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx` | Graph node/edge canvas, per-node mutation UI |
| `ui/src/components/mixer/EffectModule.jsx` | Chain mode effect editor opener, `EFFECT_EDITORS` registry |
| `ui/src/stores/eqStore.js` (and siblings) | Stock editor stores; accept `(trackId, nodeId)` |
| `ui/main.js` | IPC handlers; chain effect at lines 1518–1546; graph state at 644–648; openPluginEditor at 1679 |
| `engine/src/audio/AudioGraph.h/.cpp` | Core engine graph; fan-out/PDC/topo-sort already present |
| `engine/src/audio/EffectChainManager.h/.cpp` | Thin wrapper; per-track; `effectChains_` in MixEngine |
| `engine/src/audio/XlethEffectBase.h` | Stock effect base class |
| `engine/src/audio/UtilityProcessors.h` | Balance, Merge, MidSide, FreqSplitter processors |
| `engine/src/audio/StockParameterCatalog.h/.cpp` | Parameter metadata per pluginId |
| `engine/src/project/ProjectManager.h` | Project save/load; effectChains under `"effectChains"` key |
| `docs/dev/fxgraph-architecture.md` | Living architecture reference for renderer-side graphState |

## Appendix B: IDs in Use

| ID | Type | Scope | Purpose |
|----|------|-------|---------|
| `node.id` | UUID string | graphState | Graph topology node identity (edge source/target) |
| `effectInstanceId` | UUID string | Cross-session | Links renderer node to engine processor across loads |
| `engineNodeId` (APG uid) | integer | Per-session | JUCE AudioProcessorGraph node ID; reassigned on reload |
| `trackId` | integer | Project | Track identity; -1 for master |
| `storeKey` | string | Renderer | `"master"` or `String(trackId)` — Zustand store key |

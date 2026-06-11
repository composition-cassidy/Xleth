# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG-VP.1.

## Data model separation

`graphState` is the renderer-side graph structure for the FX Graph workspace.
`effectChains` are separate legacy/default data for Mixer Chain mode.
These two systems are intentionally independent and must never be merged or cross-mutated.

## Ownership gate

`fxMode: "chain" | "graph"` is the persistent ownership gate, stored per normal track.
- Master track is always `"chain"` and is excluded from graph editing.
- A track is editable by exactly one mode at a time.
- `effectChains` are owned by chain mode; `graphState` is owned by graph mode.
- When `fxMode` is `"chain"`, `graphState` is dormant and must not be mutated.

## FXG-VP.1 — Viewport Zoom and Pan

Added a full viewport/camera model to the FX Graph UI (renderer-only, no engine/bridge changes).

- **Viewport state**: `graphState.viewport = { x, y, zoom }`. Zoom range: [0.1, 4]. Default: `{ x:0, y:0, zoom:1 }`.
- **Rendering transform**: A single CSS `translate(x, y) scale(zoom)` applied to the graph canvas layer (`transform-origin: 0 0`). Node positions remain in graph-space; zoom never mutates node positions.
- **Controls**: `−` / `zoom%` / `+` toolbar buttons zoom around the viewport center; clicking the % label resets to 100%; `Fit View` zoom-fits all nodes; `Reset View` returns to `{ x:0, y:0, zoom:1 }`.
- **Wheel zoom**: `Ctrl + mouse wheel` zooms around the cursor position. Plain wheel does not zoom.
- **Pan**: Middle-mouse drag, Space + left-drag, or left-drag on background.
- **Node drag**: Screen delta is divided by `viewport.zoom` to get graph-space delta: `graphDelta = screenDelta / zoom`.
- **Port hit-testing**: `document.elementFromPoint()` operates in screen space — automatically correct under any zoom.
- **Persistence**: Viewport persists via `setGraphStateViewport()` in `effectChainStore.js` without creating undo history.
- **Pure helpers**: `ui/src/fxgraph/graphViewport.js` — `clampGraphZoom`, `screenToGraphPoint`, `graphToScreenPoint`, `zoomViewportAroundScreenPoint`, `panViewport`, `fitGraphViewport`.

## graphState schema

Version: `GRAPH_STATE_SCHEMA_VERSION = 1` (see `graphState.js`).
Fields: `schemaVersion`, `trackId`, `nodes`, `edges`, `viewport`, plus any extra fields preserved for forward compatibility.

Node types: `trackInput`, `trackOutput`, `effect`, `macro`, `envelope`, `sidechainInput`, `unknown`
(load-only fallback).
Edge types: `audio`, `parameter`, `sidechain`, `unknown` (load-only fallback).

Port naming convention (mirrors `chainToGraphState.js` lines 189-191):
- `trackInput` output -> `'audio'`
- `effect` input -> `'audioIn'`, output -> `'audioOut'`
- `trackOutput` input -> `'audio'`
- `sidechainInput` output -> `'sidechainOut'`; compressor sidechain key target -> `'sidechainIn'`
  (FXG-SC.6B; see `fxgraph-sidechain-input-architecture-audit.md`)

FXG-SC.6C — graph sidechain intent now reconciles to the existing Timeline `SidechainRoute`
transport. `deriveGraphSidechainIntent(graphState)` (pure) yields the desired routes; the store action
`reconcileGraphSidechainRoutesForTrack` creates/removes those routes by stable `effectInstanceId`,
toggles the stock compressor's `sc_external` flag, and runs only after route-relevant mutations
(source change, sidechain edge connect/disconnect, sidechain-target node removal), hydration, and
undo/redo. Sidechain edges still never enter the audio topology payload, and no native/bridge code
changed (no addon rebuild). See `fxgraph-sidechain-input-architecture-audit.md` § "6C Implementation
Status".

FXG-SC.6D — polish, save/reload verification, and Electron CDP smoke test. Key additions:
- `GraphStatePreview.tsx` secondary text for `sidechainInput` nodes now shows "Keyed by: \<track name>"
  using the `sidechainSources` prop (live name resolution) instead of the raw persisted track ID.
- `FxGraphPanel.tsx` renders a `sidechainRouteNotice` banner (`.xleth-fx-graph-panel__mode-copy--sidechain-notice`)
  when any sidechain intent target is in a degraded state (`external_failed`, `route_failed`, `stale`).
- CDP smoke test verified: drag connection (split pointerdown→waitFor data-connecting→pointermove+pointerup
  so the sidechain port's `pointer-events:none→auto` transition is respected), source select, route creation,
  and route restoration after save/reload all pass. 601 JS tests. No engine changes.

## Mutation helpers (FXG.2C-d)

`graphState.js` exports pure mutation helpers:
`addGraphEffectNode`, `removeGraphNode`, `connectGraphNodes`, `disconnectGraphEdge`.

These helpers are topology guards only. They enforce graph invariants (protected nodes, cycles,
duplicate edges, endpoint rules) but do not check `fxMode`. Store actions in
`effectChainStore` are responsible for enforcing `fxMode === "graph"` before calling any mutation
helper.

Protected node types (`PROTECTED_NODE_TYPES`): `trackInput`, `trackOutput`, `sidechainInput`.
These nodes cannot be removed. Future helpers must respect `isProtectedGraphNodeType`.

## Store mutation actions (FXG.2C-e)

`effectChainStore` wraps the pure helpers in four async actions that own `fxMode` enforcement:
`addGraphEffectNodeForTrack`, `removeGraphNodeForTrack`, `connectGraphNodesForTrack`,
`disconnectGraphEdgeForTrack`.

Each action goes through `readGraphStateForMutation`, which rejects when the track is the
master track (`master_track`), is not a normal track (`no_track`), is not owned by graph mode
(`not_graph_mode`), or has no usable graphState (`missing_graph_state`). Only after that gate
passes does the action call the topology guard, then `applyGraphStateMutation` to revalidate,
commit to `graphStates`/`graphStateStatuses`, and best-effort persist via
`timeline.setTrackGraphState`. Persistence failures warn but do not roll back the renderer edit;
only a failed revalidation rejects with `invalid_graph_state`.

Every routing-affecting action returns `{ ok: true, graphState, status, runtimeSync }` or
`{ ok: false, reason }`, where `reason` is a `GRAPH_MUTATION_REJECTION` code or one of the access
codes above. The actions never touch `effectChains`. Layout-only actions (`setGraphStateNodePosition`,
`setGraphStateViewport`) persist graphState but do not sync audio routing.

The FX Graph panel (`FxGraphPanel.tsx`) wires these actions to a minimal editing UI in
`GraphStatePreview.tsx`: an Add Effect Node button, a per-effect remove button, drag-to-connect
from a node's output handle, and disconnect buttons at audio-edge midpoints. Every affordance is
gated on its callback prop, so the preview stays read-only whenever the panel is not in graph mode.
Rejected mutations surface a non-blocking inline notice via `describeGraphMutationResult`.

## Graph edit history (FXG.3-h)

FX Graph undo/redo is session-only and owned by `effectChainStore.graphHistories`, keyed by normal
track id: `{ [trackId]: { undoStack, redoStack } }`. Transactions store cloned
`beforeGraphState`/`afterGraphState` snapshots and labels for graph edits only:
`move_graph_node`, `add_graph_effect_node`, `remove_graph_node`, `connect_graph_nodes`, and
`disconnect_graph_edge`. Stacks are capped at 100 entries per track, redo is cleared by any new edit
after undo, and all histories are wiped on project load and graph-mode hydration. No history is
serialized into project data.

Undo/redo applies snapshots through graph-owned runtime reconciliation, never Mixer Chain APIs. The
store diffs current vs target effect nodes by stable `effectInstanceId`, creates target-only real
graph effects before committing, removes current-only engine-backed graph effects before committing,
rolls back newly created processors if creation fails, and leaves graphState/history unchanged on any
lifecycle failure. After a successful commit it updates the session `effectInstanceId -> engineNodeId`
cache and syncs runtime topology only when graph nodes or edges changed. Layout moves persist
graphState but do not resync runtime.

Graph history is scoped to normal tracks in `fxMode === "graph"`. Master tracks, chain-mode tracks,
`effectChains`, native undo IPC, and Mixer Chain history are intentionally separate. The FX Graph
panel exposes compact Undo/Redo controls only while graph mode is active and registers
`Ctrl+Z`/`Ctrl+Y`/`Ctrl+Shift+Z` through `KeyboardManager` with `scope: "panel:fxGraph"`.

## Graph-owned effect instances (FXG.3-b / FXG.3-c-a)

Graph effect nodes are backed by real graph-owned engine processors, separate from `effectChains`.
This is Option A / Option 2 from the runtime audit: graph mode owns its own effect-instance
lifecycle; it does not wrap or hide processors inside the linear chain.

Three distinct IDs, never collapsed:

| ID | Type | Scope | Purpose |
|----|------|-------|---------|
| `node.id` | UUID string | graphState | Graph topology identity (edge source/target) |
| `effectInstanceId` | UUID string | persisted with graphState | Stable cross-session effect identity in `node.data.effectInstanceId` |
| `engineNodeId` | integer (APG uid) | per-session | Transient JUCE node id; reused by the existing editor paths as `nodeId` |

Lifecycle:
- Engine: `EffectChainManager::addGraphNode/removeGraphNode/getGraphNodeEngineId/hasGraphNode`
  keep an `effectInstanceId -> APG uid` map and use the low-level `AudioGraph::addNode/removeNode`
  (never `addEffect/moveEffect`), so graph-owned nodes never touch the linear chain. Nodes are
  created independently from chain slots and are connected only by the FXG.3-c-b linear topology
  sync described below.
- MixEngine: `addGraphEffectNode/removeGraphEffectNode/getGraphEffectEngineNodeId` forward
  per-track and reject the master track (master stays chain-only).
- Bridge: `audio_addGraphEffectNode`, `audio_removeGraphEffectNode`,
  `audio_getGraphEffectEngineNodeId`, and `audio_hydrateGraphEffectNodes` are separate from the
  chain APIs and never call chain add/remove internally.
- Store: `addGraphEffectNodeForTrack` instantiates a graph-owned processor for a real `pluginId`
  before committing graphState (fail-fast; rolls the processor back if the commit is rejected).
  Placeholder/data-only nodes (`pluginId === "placeholder"`) stay renderer-only.
  `removeGraphNodeForTrack` destroys the engine processor before committing the removal and fails
  fast if engine removal fails. A session-only `graphEngineNodeIds`
  (`{ [key]: { [effectInstanceId]: engineNodeId } }`) cache records what we instantiated; it is
  never persisted and is wiped on project load before FXG.3-c-a hydration rebuilds it.

The Edit button on graph effect nodes resolves
`node.id -> effectInstanceId -> engineNodeId`, then opens the same stock/plugin editor path as
Mixer Chain via the shared `effectEditorOpeners.js` helper. The graphState `node.id` is never
passed to an editor store.

## Add Effect Node picker (FXG.3-e)

The Add Effect Node button opens a real effect picker (`FxGraphEffectPicker.tsx`) instead of
dropping a placeholder. The picker reuses the **same catalog source as the Mixer Chain** —
`components/mixer/effectCatalog.js` (`EFFECT_CATEGORIES` stock list + `sortRackVstPlugins` over the
shared `useVstStore` scan) — so both add flows expose identical stock and scanned VST/plugin
entries with no duplicate registry or second scanner. `EffectChainPanel.jsx` re-exports
`EFFECT_CATEGORIES`/`sortRackVstPlugins` from that module for back-compat.

The picker only chooses *what* to add. Selecting an effect calls
`addGraphEffectNodeForTrack(trackId, { pluginId, displayName })`, which keeps graph-owned storage
and runtime ownership: it requires `fxMode === "graph"`, generates the `effectInstanceId`,
instantiates the graph-owned engine processor first, then commits graphState and records the
session `effectInstanceId → engineNodeId` mapping. Chain slots, `effectChains`, and chain routing
are never involved. On engine failure the add fails fast (or rolls back the processor if the commit
is rejected) so graphState and the session mapping are never left corrupt; the panel shows a
tokenized inline notice via `describeGraphMutationResult`. Placeholder creation remains available
as an internal/dev fallback (`addGraphEffectNodeForTrack(trackId, {})`) but is no longer the
user-facing path.

## Project-load hydration (FXG.3-c-a / FXG.3-c-b)

FXG.3-c-a reconstructs graph-owned effect processors after project load from renderer-owned
`graphState`. FXG.3-c-b then reapplies the supported linear routing sync for graph-mode tracks.

Load sequence:
- `hydrateFxModesFromTracks` restores per-track `fxMode`, `graphStates`, and
  `graphStateStatuses` from timeline track data, then clears the transient `graphEngineNodeIds`
  cache.
- `hydrateGraphEffectInstancesForLoadedProject` scans only normal tracks where
  `fxMode === "graph"` and only valid `graphState` effect nodes.
- The renderer sends minimal metadata to `audio_hydrateGraphEffectNodes`: `effectInstanceId`,
  `pluginId`, and optional diagnostics (`graphNodeId`, `displayName`).
- Placeholder/data-only nodes, missing nodes, protected nodes, and effect nodes without
  `effectInstanceId` are skipped before engine hydration.
- The engine uses graph-owned `addGraphNode` semantics, so hydration is idempotent and never
  calls chain `addEffect` / `moveEffect`. Existing `effectInstanceId` mappings return the current
  `engineNodeId`; new mappings instantiate disconnected processors.
- The renderer merges the returned `effectInstanceId -> engineNodeId` mapping into
  `graphEngineNodeIds`. Failures are reported and do not remove graphState nodes or mutate
  `effectChains`.
- After hydration, graph-mode normal tracks call `audio_syncLinearGraphTopology` with a sanitized
  topology payload so the engine can rebuild the single supported linear path. Runtime sync status
  is session-only (`graphRuntimeStatuses`) and is never serialized into project data.

`EffectChainManager::graphToJSON` now additively writes `effectInstanceId` only on graph-owned
AudioGraph nodes. `graphFromJSON` tolerates older projects where the field is absent and rebuilds
the runtime mapping when the field exists. The renderer hydration path remains the reliable source
for projects whose graph-owned engine nodes were not serialized with `effectInstanceId`.

## Linear graph execution (FXG.3-c-b)

FXG.3-c-b is the first phase where `graphState` audio cables affect runtime routing, but only for
normal tracks in `fxMode === "graph"` and only for one linear audio path:

- supported: `Track Input -> Track Output`
- supported: `Track Input -> Effect -> Track Output`
- supported: `Track Input -> Effect A -> Effect B -> Track Output`

The renderer sends only the runtime topology needed by the engine: graph node ids, effect
`effectInstanceId`s/plugin ids, and audio edges. The engine resolves
`node.id -> effectInstanceId -> engineNodeId` and rebuilds AudioGraph connections with graph-owned
processors. It never passes renderer `node.id` values to AudioGraph connection APIs.

Unsupported nonlinear topologies return `{ ok: false, reason: "nonlinear_deferred" }` and apply a
safe passthrough fallback so stale previous linear routing cannot remain active while the UI shows a
parallel graph. Graph-owned processors stay alive, graphState is not rolled back, and `effectChains`
are not mutated. (Superseded by FXG.3-d below — parallel topologies now execute.)

## Graph runtime ownership repair + parallel execution (FXG.3-c-b-r1 / FXG.3-d)

### Diagnosed root cause of the stale-chain leak

FXG.3-c-b shipped with a regression: in graph mode the audio still followed the original converted
chain order even when the graph routed nothing to Track Output, and the panel showed "Graph routing
sync failed." Two layers were responsible:

1. **Stale native addon (trigger).** The dev runtime loads `xleth_native.node` from
   `bridge/build/Release` (`ui/runtimePaths.js`). That Release build predated FXG.3-c-b, so it did
   not export `audio_syncLinearGraphTopology`. The worker (`ui/addon-worker.js`) silently returns
   `{ result: null, notImplemented: true }` for unknown methods, the renderer normalized that `null`
   to `engine_sync_failed`, and **the engine was never reached** — so the chain wiring was never
   cleared and stayed audible.
2. **Fail-open ownership (latent).** Conversion (`convertChainToGraphMode`) flipped `fxMode` to
   graph but never triggered an entry sync and never backed the converted effect nodes with engine
   processors. The chain route was only ever torn down as a side effect of a *successful* mutation
   sync, so any failed/unreached sync left the old route live.

### Fail-closed ownership model

In `fxMode === "graph"`, the engine graph sync is the **sole owner** of the track's connection
space. Every graph-mode entry and routing mutation sends the full topology; the engine clears all
connections (chain + previous graph) and rebuilds **only** the graph-owned route. Outcomes:

| Topology | Behavior | Status (`reason` / `mode`) |
|----------|----------|----------------------------|
| No Track Input→Output path | silence (output left unconnected) | `graph_output_disconnected` / `disconnected`, ok |
| Track Input→Track Output | passthrough | `graph_routing_active` / `passthrough`, ok |
| Input→Effect→…→Output | processed in order | `graph_routing_active` / `linear`, ok |
| Fan-out / fan-in | branches summed additively (JUCE APG) | `parallel_graph_routing_active` / `parallel`, ok |
| Disconnected effect node | allocated, not wired to output, silent | reported on the active path only |
| Missing mapping / placeholder / cycle / invalid | fail-closed to silence | `missing_effect_mapping` etc., ok=false |

Key engine mechanic: `AudioGraph::rebuildAPGConnections` auto-wires Track Input→Track Output when no
logical connections remain (needed for an empty Mixer Chain). That is **passthrough, not silence**,
so graph-mode fail-closed and disconnected-output paths use the new
`AudioGraph::clearConnectionsToSilence()` (sets `muteOutput_`, suppressing the auto-passthrough) so
Track Output truly receives nothing. Any subsequent rebuild clears the flag. The engine sync
(`EffectChainManager::syncGraphTopology`) resolves `effectInstanceId → engineNodeId`, builds the
active subgraph (nodes on a path Input→Output), and calls
`AudioGraph::replaceConnectionsWithGraph(edges)` for the general DAG. Renderer `node.id` values are
never passed to AudioGraph.

### Conversion adoption (preserves effect settings)

`convertChainToGraphMode` now adopts the existing chain processors as graph-owned via
`audio_adoptGraphEffectNodes` (`EffectChainManager::adoptGraphNodes`): each converted effect node is
mapped `effectInstanceId → existing chain engineNodeId` (matched through `sourceChainSlotIndex`),
preserving parameter state without re-instantiation. It then triggers the entry sync so graph mode
owns routing immediately. Adoption never creates/destroys processors and never mutates `effectChains`.

### Parallel summing

Multiple branches reaching Track Output are summed additively by JUCE's `AudioProcessorGraph`. This
can raise level (two identity branches → +6 dB); there is **no** automatic normalization. PDC at
merge points is handled by `AudioGraph::computePDC()`.

### Still deferred after FXG.3-d

- Graph→chain return (no switch-back UI exists; `setFxMode` stays a renderer flip; no
  `rebuildChainRouting`), per-branch wet/dry or merge-gain UI, latency display.
- Feedback loops, modulation, buses, parameter pinning remain deferred.

## Graph effect parameter exposure (FXG.4-a / FXG.4-b)

A single graph-owned descriptor layer exposes parameter metadata and current
**normalized [0.0, 1.0]** values for any graph-owned effect node — stock or
third-party — without going through Mixer Chain slot editing.

- **One descriptor, two sources.** Stock effects enumerate from their own APVTS
  (the single source of truth for ranges/defaults — no duplicated parameter
  definitions). Third-party plugins enumerate the hosted processor's host-facing
  `juce::AudioProcessorParameter` objects. Plugin parameters are **asked of the
  processor, never scraped from a native editor UI**, and all reads/sets run
  behind the existing SEH plugin guard so a faulting plugin fails safely.
- **Stable identity preferred.** Each descriptor carries a `parameterId`
  (APVTS `paramID` for stock; `AudioPluginInstance::HostedParameter` id for
  plugins) plus a `parameterIndex`. When no stable id exists the engine emits a
  `#<index>` fallback flagged with `parameterIdIsFallback`, so later FXG.4-c
  automation can target the most stable identity available. Descriptors also
  report `automatable`, `readOnly`, `discrete`, `boolean`, `numSteps`,
  `defaultNormalizedValue`, `unit`, and `displayValue` where known.
- **Identity resolution.** Renderer-facing identity is
  `(trackId, effectInstanceId, parameterId)`. The engine resolves
  `effectInstanceId → engine node id` via the per-track graph map (FXG.3-b/3-c);
  `graphState` node ids and raw engine node ids are never used as the
  renderer-facing parameter address.
- **Engine surface.** `MixEngine` →
  `getGraphEffectParameters` / `getGraphEffectParameterValue` /
  `setGraphEffectParameterNormalized` (track-scoped, master rejected) delegate to
  `EffectChainManager` (resolves the instance, fails closed on
  `unknown_effect_instance` / `plugin_missing`) and `AudioGraph` (builds the
  descriptor via `GraphEffectParameters`). Stock writes route through the
  established `setParameterValue` (denormalized) so smoothing/latency side
  effects match chain edits; plugin writes reuse the guarded
  `setWrappedParameterValue`. Set values are clamped to `[0, 1]`.
- **Bridge / IPC / store.** Exposed as `audio_getGraphEffectParameters`,
  `audio_getGraphEffectParameterValue`, `audio_setGraphEffectParameterNormalized`
  (JSON-string results) through the addon, Electron `xleth:audio:*` handlers, and
  preload. `effectChainStore` adds `fetchGraphEffectParameters` /
  `getGraphEffectParameterValue` / `setGraphEffectParameterNormalized`, gated by
  `fxMode === 'graph'`, addressed by `effectInstanceId`. These are pure engine
  queries: they never mutate `effectChains` or `graphState`, and no parameter
  snapshot is persisted (descriptors are discovered live from the processor).
- **UI discovery (FXG.4-a).** The descriptor/read/write surface remains available
  to graph-owned nodes, but it is no longer mounted as a default full-panel
  slider rack in the FX Graph shell.
- **Port exposure (FXG.4-b).** Right-clicking a graph effect node opens a compact
  node menu with Edit, Remove, and Expose Parameter controls. The menu fetches
  live descriptors from the graph-owned processor, filters/searches them in the
  renderer, disables read-only or non-automatable descriptors, and toggles only
  persisted graph data. A toggled parameter is stored on the effect node as
  `node.data.exposedParameterPorts[]` with a compact snapshot:
  `parameterId`, optional `parameterIndex`, display-name/unit snapshots, fallback
  identity flag, and nullable `automatable` / `readOnly` flags. Normalized
  values are not persisted.
- **Stock EQ exposure curation (FXG.4-b-r1).** FXG.4-a continues exposing raw
  stock/plugin descriptors from the backend, including Xleth EQ internal dynamic,
  spectral, and analysis parameters. The normal FX Graph Expose Parameter menu
  adds a renderer-only product curation layer for stock Xleth EQ / Parametric EQ
  nodes (`pluginId: xletheq`): only Band 0, Band 1, and Band 2 `Frequency`,
  `Gain`, `Q`, `Type`, and `Enabled` are offered. The menu keeps the original
  descriptor identity when a curated parameter is exposed, existing exposed ports
  are not deleted automatically, and third-party plugin parameter enumeration is
  unchanged.
- **Port rendering.** Exposed parameters render as compact parameter-input rows
  on the graph node. They are visual/future connection targets only in FXG.4-b;
  toggling them does not call runtime topology sync, does not write parameter
  values, and does not mutate Mixer Chain `effectChains`.
- **Still deferred.** No automation lanes, modulation, LFOs, envelopes, peak
  followers, macros, buses, parameter pinning, gestures, sample-accurate
  automation, or generic plugin-editor replacement. Mixer Chain behavior is
  unchanged.

## Parameter Target Binding Contract (FXG.4-c)

FXG.4-c defines a stable identity shape — `GraphParameterTarget` — for exposed graph
parameter ports. Future macro, LFO, envelope, peak-follower, and automation clip sources
connect to exposed parameter ports through this contract, not through fragile UI labels or raw
parameter indices.

### Target shape

```ts
{
  kind: 'graph-parameter',
  graphNodeId: string,          // graphState node id (never raw engineNodeId)
  effectInstanceId: string,     // persisted cross-session effect identity
  parameterId: string,          // stable APVTS/host-parameter id (preferred)
  parameterIndexFallback: number | null,  // fallback when no stable id is available
  parameterIdIsFallback: boolean,         // true when parameterId is a '#<index>' string
  nameSnapshot: string,         // display name at expose time (fallback UI only)
  labelSnapshot: string | null, // unit label at expose time (fallback UI only)
  pluginId?: string,
  effectKind?: string,
  pluginFormat?: string,
  trackId?: string,             // optional; omit in persisted shape, supply for runtime keys
}
```

### Key rules

- `graphNodeId` + `effectInstanceId` + `parameterId` form the stable, persisted identity.
- Raw `engineNodeId` (APG uid) is **never stored in a target**. It is session-only.
- `parameterIdIsFallback: true` requires a non-null, non-negative integer `parameterIndexFallback`.
- Normalized values are not stored in the target contract.
- Full descriptor metadata is not stored; only small display snapshots needed for fallback UI.

### Persisted target key

`graph-param:{graphNodeId}:{effectInstanceId}:{parameterId}` — track-agnostic, stable across
sessions. Use `getGraphParameterTargetRuntimeKey(trackId, target)` for cross-track uniqueness
in store/runtime paths (never persisted).

### Port binding id

`gpp:{graphNodeId}:{parameterId}` — scoped compound DOM id used as `data-parameter-port-id`
on exposed port elements. Globally unique within the graph.

### Exposed port shape (FXG.4-b, renamed field in FXG.4-c)

Stored in `node.data.exposedParameterPorts[]`:

```js
{
  parameterId: string,
  parameterIndexFallback: number | null,  // renamed from parameterIndex in FXG.4-b
  parameterIdIsFallback: boolean,
  nameSnapshot: string,
  labelSnapshot: string | null,
  automatable: boolean | null,
  readOnly: boolean | null,
}
```

Old graphs saved with `parameterIndex` upgrade silently: `normalizeExposedParameterPort`
reads `raw.parameterIndexFallback ?? raw.parameterIndex`.

### Helpers (`ui/src/fxgraph/graphParameterTarget.js`)

- `createGraphParameterTarget({ trackId?, graphNode, effectInstanceId, descriptor })`
- `normalizeGraphParameterTarget(raw)` — repairs/drops malformed target data
- `isGraphParameterTarget(value)` — type guard
- `getGraphParameterTargetKey(target)` — persisted stable key
- `getGraphParameterTargetRuntimeKey(trackId, target)` — runtime key including trackId
- `buildGraphParameterPortId(graphNodeId, parameterId)` — stable port DOM id
- `doesTargetMatchExposedPort(target, exposedPort)` — match check
- `resolveGraphParameterTarget(graphState, target)` — graphState-only resolution:
  returns `ok | missing_node | missing_effect_instance | missing_exposed_port | invalid_target`

### Parameter edge contract (data-model only)

The graphState edge schema now recognizes `type: 'parameter'` edges. Audio topology helpers
(`linearGraphTopology.js`, `hasAudioCycle`) already filter by `edge.type === 'audio'`, so
parameter edges are correctly ignored by all audio routing paths. `connectGraphNodes` (the audio
connect path) still rejects any attempt to create a non-audio edge; parameter edges are created
through the dedicated `connectMacroToParameter` path added in FXG.4-e/f (see below).

No engine runtime sync treats parameter edges as audio routing. They are never passed into the
engine audio graph.

## Macro Control Nodes (FXG.4-d)

FXG.4-d adds Macro nodes as graph-owned normalized control sources. A macro node is stored only in
`graphState` with a repaired display `label` and `normalizedValue` clamped to `[0.0, 1.0]`. Macro
nodes are not protected I/O nodes, can be moved/removed like other editable graph nodes, and
participate in graph-owned undo/redo. They do not have `effectInstanceId`, plugin metadata, raw
engine ids, parameter target lists, modulation mapping, Bezier curves, or automation clip ids.

The FX Graph workspace renders Macro nodes as distinct control nodes with one visible
`controlOut` output port and compact value editing. Macro edits persist through
`timeline.setTrackGraphState` but skip audio runtime sync and never call graph effect parameter
write APIs. Macro nodes are excluded from topology payloads, rejected as audio edge endpoints, and
do not participate in graph-owned effect hydration or processor lifecycle.

FXG.4-d intentionally stops at visible graph-owned control sources. Macro-to-parameter linking,
default linear parameter driving, per-link Bezier mapping, automation clips, LFOs, envelopes, peak
followers, buses, and graph-to-chain return remain deferred. FXG.4-e/f will connect Macro outputs
to exposed parameter ports through the FXG.4-c `GraphParameterTarget` contract and add the first
parameter-driving behavior.

### Still deferred after FXG.4-d

Macro-to-parameter links, LFO nodes, envelope nodes, peak follower nodes, automation clips,
modulation execution, sample-accurate automation, smoothing, min/max depth scaling, polarity,
Bezier mapping, buses, or graph-to-chain return. Mixer Chain behavior is unchanged.
`effectChains` are not mutated.

## Macro-to-Parameter Links + Default Runtime Drive (FXG.4-e/f)

FXG.4-e/f makes the first working macro modulation path:

```
Macro normalizedValue
  -> parameter edge mapping (default linear)
  -> exposed GraphParameterTarget (FXG.4-c)
  -> setGraphEffectParameterNormalized (FXG.4-a)
  -> stock/VST parameter change
```

### Parameter edge shape

A Macro `controlOut` port links to an exposed parameter input port as a `type: 'parameter'`
edge. The edge persists the FXG.4-c `GraphParameterTarget` plus a per-link `mapping` object:

```js
{
  id, type: 'parameter',
  sourceNodeId: macroNodeId, sourcePort: 'controlOut',
  targetNodeId: effectNodeId, targetPort: 'gpp:{effectNodeId}:{parameterId}',
  targetParameter: GraphParameterTarget,   // no raw engineNodeId is ever stored
  mapping: {
    enabled: true,
    sourceMin: 0.0, sourceMax: 1.0,
    targetMin: 0.0, targetMax: 1.0,
    curve: { type: 'linear' },
  },
}
```

The mapping lives on the **edge**, not the macro, so one macro can drive many parameters with
different ranges/polarity. Every numeric field clamps to `[0,1]`. `targetMin > targetMax` is
preserved (inverted mapping). `curve.type` only accepts `linear` in this phase; anything else
repairs to `linear`. The object is shaped so FXG.4-g can add `curve.type === 'bezier'` + control
points without a schema migration. `normalizeParameterMapping` repairs malformed mappings and
`loadGraphState` attaches a default mapping to any parameter edge missing one. Audio edges never
get a mapping field.

### Linking helpers (`ui/src/fxgraph/graphState.js`)

- `canConnectMacroToParameter(graphState, { sourceNodeId, targetNodeId, parameterId })` — validates:
  source is a macro; target is an effect (Track I/O and macros rejected); the parameter is exposed,
  writable, and the target carries an `effectInstanceId`; and the link is not a self-link or
  duplicate.
- `connectMacroToParameter(...)` — builds the parameter edge with `controlOut` source, a
  `gpp:` target port, the built `GraphParameterTarget`, and a default linear mapping.
- `disconnectParameterEdge(graphState, edgeId)` / `isParameterEdge(graphState, edgeId)` — parameter-
  specific edge removal/identification (refuses to drop audio edges).
- `evaluateLinearParameterMapping(mapping, macroValue)` — `t = clamp((v - sourceMin)/(sourceMax - sourceMin), 0, 1)`,
  `value = clamp(targetMin + t*(targetMax - targetMin), 0, 1)`. A zero-width source span steps
  instead of dividing by zero. Disabled mappings return `{ enabled: false, value: null }`.
- `collectMacroParameterWrites(graphState, macroNodeId, macroValue)` — pure resolver returning the
  `{ effectInstanceId, parameterId, value }` writes the macro's enabled outgoing parameter edges
  produce. Disabled, malformed, unresolved, or read-only edges are reported under `skipped`.

### Store actions (`ui/src/stores/effectChainStore.js`)

- `connectMacroToParameterForTrack(trackId, { sourceNodeId, targetNodeId, parameterId })` — graph-mode
  gated, persists via `timeline.setTrackGraphState`, records one undo step
  (`connect_macro_to_parameter`), skips audio runtime sync, then drives the new link from the macro's
  current value.
- `updateGraphMacroValueForTrack` — after committing the macro value it calls
  `driveMacroParameterEdges`, which turns each `collectMacroParameterWrites` entry into a FXG.4-a
  `setGraphEffectParameterNormalized(trackId, effectInstanceId, parameterId, value)` call. One failed
  write never aborts the others and never rolls back the committed `graphState`.
- `disconnectGraphEdgeForTrack` — detects parameter edges and skips audio runtime sync for them
  (audio edge removal still syncs).
- Project-load hydration applies each macro's saved value to its connected parameters after
  graph-owned effect processors are instantiated (best-effort; unavailable targets fail safely).

This is **control-rate, renderer-side drive only**: no audio topology change, no `effectChains`
mutation, no Mixer Chain slot indexes, no raw engine node ids, no parallel parameter system. The
macro stays a clean `0..1` source. Audio topology (`linearGraphTopology.js`, `hasAudioCycle`) and the
engine audio graph continue to ignore parameter edges and macro nodes entirely.

### UI (`GraphStatePreview.tsx`, `FxGraphPanel.tsx`)

The Macro `controlOut` handle becomes a drag source when `onConnectMacroToParameter` is provided;
dragging it onto an exposed parameter input port (resolved via `data-parameter-id`) creates a
parameter edge. Audio drag sources still only create audio edges, and audio output cannot land on a
parameter port (parameter edges are port-level; audio edges are node-level). Parameter edges render
as warning-tinted dashed cables — distinct from solid audio cables — and reuse the existing edge
delete affordance. Tokenized status messages cover read-only / not-exposed / unavailable failures.

### Still deferred after FXG.4-e/f

Per-link Bezier curve editor (FXG.4-g), automation clips, LFO/envelope/peak-follower nodes, buses,
graph-to-chain return, audio-rate or sample-accurate modulation, smoothing, and depth scaling.
Mapping range editing in the UI is also deferred — the mapping data and runtime drive exist, but
this phase ships only the default linear mapping with no per-edge range editor.

## Parent-Attached Macro Automation Lanes (FXG.4-h)

FXG.4-h adds timeline automation for a Macro node's `normalizedValue`. The automation is
**parent-attached**: lanes are not free-floating timeline tracks — they belong to one parent track
and one macro node, and they visually behave like child lanes shown below that parent track.

### Runtime flow

```
playback tick
  -> evaluate the active automation clip on the parent track's macro lane
  -> produce Macro normalizedValue 0.0..1.0
  -> existing Macro -> Parameter edges apply per-link mapping/Bezier (FXG.4-e/f/g)
  -> setGraphEffectParameterNormalized writes the stock/VST parameter (FXG.4-a)
```

The automation clip **never** writes plugin parameters directly. It only sets the Macro value at
runtime; the existing macro→parameter edge path does the rest. This is control-rate / timeline-rate
(not sample-accurate, not on the audio thread), matching the renderer-side FXG.4-e/f macro drive.

### Data ownership and binding

Timeline clip data normally lives in the C++ engine. Because FXG.4-h is renderer-only (no native /
bridge / main / preload changes), and because the only renderer channel that round-trips with the
project is `graphState` (persisted per track via `timeline.setTrackGraphState`) — which is also where
the Macro node itself lives — macro automation lanes/clips are stored as a top-level
`graphState.macroAutomationLanes` array. This is **not** generic timeline data and never mixes with
audio/video/sample clips. The Macro node stays a clean `0..1` source; automation is a sibling field,
never stored on the node.

Lane identity (binds to):

```
{ parentTrackId: graphState.trackId, macroNodeId, target: 'normalizedValue' }
```

Clip identity (binds to):

```
{ parentTrackId, macroNodeId, laneId, clipId, startTick, lengthTicks, points, loopEnabled }
```

`parentTrackId` is always the owning `graphState.trackId` — never stored redundantly (single source
of truth), exposed via `getMacroAutomationClipBinding`. Raw engine node ids and plugin parameter
targets are never stored on automation clips.

### Lane / clip rules

- One lane per macro node; multiple macro lanes may live under one parent track.
- Clips on the **same lane** may **not** overlap (rejected in v1, `clip_overlap`); load-time
  normalization drops later overlappers (earliest wins).
- Clips on **different** macro lanes (or different tracks) may overlap freely — they drive different
  macros.
- A clip holds ≥2 points (`{ tick, value, curve }`); `tick` is clip-local, `value` is `0..1`.
  Segments are linear by default; a point's `curve: 'bezier'` shapes its outgoing segment using the
  FXG.4-g ease curve.
- **Empty space holds the last value.** After a clip ends at e.g. 80%, the macro stays at 80% until a
  later clip on the same lane takes over. With no earlier clip, the macro's saved/manual value is
  used. Clip end never snaps to 0.0 or to a default.
- **Loop is in-bounds only.** `loopEnabled` repeats the material between the first and last automation
  point, but only while playback is inside the clip's own `[startTick, startTick+lengthTicks)` region.
  Outside the clip the loop does nothing. Automation clips are not LFOs.
- **Copy/paste is lane-compatible only.** A clip may only be pasted into the same macro's lane on the
  same track. Cross-macro, cross-track, and macro↔normal-lane pastes are rejected
  (`incompatible_lane`). Automation clips never silently retarget.

### Missing target handling

If a Macro node is deleted, its lane is **preserved but flagged** `targetUnavailable: true` (orphaned)
on the next `loadGraphState` — user data is never auto-deleted. Evaluation skips orphaned lanes, so a
missing macro is never driven and never crashes. The user may explicitly remove the lane.

### Modules

- `ui/src/fxgraph/macroAutomation.js` — pure model: normalization (called from
  `loadGraphState`), lane/clip/point mutation helpers (`showMacroAutomationLane`,
  `createMacroAutomationClip`, `move/resize/delete/paste`, point editing), overlap detection, and
  evaluation (`evaluateMacroAutomationForMacro`, hold-last-value, in-bounds loop). Reuses FXG.4-g
  `evaluateBezierCurve`/`createDefaultBezierCurve` at call time.
- `ui/src/stores/effectChainStore.js` — graph-mode-gated store actions
  (`showMacroAutomationLaneForTrack`, `createMacroAutomationClipForTrack`, …) that persist via
  `timeline.setTrackGraphState`, record graph-owned undo transactions, and never sync audio runtime.
  `applyMacroAutomationAtTick(globalTick)` evaluates every graph-mode track's lanes and drives the
  macro→parameter edges through the existing FXG.4-e/f path; the session-only
  `macroAutomationLastValues` cache suppresses redundant control-rate writes (no graphState churn).
- `ui/src/fxgraph/macroAutomationPlayback.js` — subscribes to the shared transport poller, converts
  position→tick (`positionMsToTick`, PPQ 960), and calls `applyMacroAutomationAtTick` each update,
  resetting the cache on play/stop transitions. Mounted once from `TimelineView`.
- UI: right-clicking a Macro node in the FX Graph (`GraphStatePreview.tsx`/`FxGraphPanel.tsx`) opens
  an Automation menu — Show/Hide Automation Lane (checkable) and Create Automation Clip — bound to
  the exact parent track + macro node. No hardcoded colors; uses existing tokenized menu styles.

### Persistence / undo

Lanes and clips persist with the project through the existing graphState round-trip. Old projects
without the field load as `[]`. All lane/clip/point edits participate in graph-owned undo/redo via
`recordGraphEditTransaction` (snapshot-based, session-only). Runtime playback never dirties the
project or the persisted macro value.

### Real timeline child lanes (FXG.4-h-r1)

FXG.4-h-r1 replaces the temporary FXG.4-h-fix amber overlay strips with **real timeline macro
automation child lanes**: each visible lane renders in its own vertical band directly below its
parent track, with its own left-header label and its own clip area. The overlay-strip approach is
**not** the product UX and has been removed.

- **Derived flattened row model** — `ui/src/components/timeline/timelineRowLayout.js`
  (`buildTimelineRows` / `buildTrackLayout`) replaces the old `trackIndex * TRACK_HEIGHT` assumption.
  It returns ordered rows `{ rowType: 'track' | 'macroAutomation', trackId | parentTrackId,
  macroNodeId, laneId, y, height, … }`; parent track rows keep the exact `TRACK_HEIGHT` they always
  had, and each visible macro lane *inserts* `MACRO_LANE_HEIGHT` of space, pushing later tracks down.
  The layout view exposes `trackTop(idx)`, `trackIndexAtY(y)` (lane bands resolve to their parent
  track — child lanes never host normal clips), `macroRowAtY`, and `totalHeight`. A track with no
  lanes produces the original contiguous geometry, so old projects are unaffected.
- **Canvas geometry** — `timelineDrawing.js`, `clipGeometry.js`, `TimelineCanvas.jsx`, and the four
  tools (`select`/`pencil`/`split`/`delete`) consult the layout (threaded as an optional
  `trackLayout`/`trackLayoutRef`, defaulting to contiguous geometry) for every `trackIndex↔Y`
  conversion, so audio/pattern clip drawing, hit-testing, drag/resize, rubber-band, and the FX badge
  layer all stay correct once lanes shift the rows.
- **Lane layer** — `ui/src/components/timeline/MacroAutomationLanes.jsx` renders the lanes as a DOM
  layer inside `.timeline-canvas-scroll`, sized to `totalHeight` so it scrolls/zooms with the canvas
  using the same `(tick/PPQ - scrollOffset) * pixelsPerBeat` math. Each clip shows its body, bounds,
  a lane-contained curve preview (`<polyline>`), draggable automation points, a loop indicator when
  `loopEnabled`, and a safe greyed "macro unavailable" state for orphaned lanes. Interactive v1:
  select, move (same lane only), resize start/end, add/move/delete point, loop toggle, and
  copy/paste (compatible same-macro lane only) — all routed through the existing effectChainStore
  macro automation actions, so the FXG.4-h compatibility/overlap rules and the macro→parameter-edge
  runtime path are unchanged. Geometry math is isolated in
  `ui/src/components/timeline/macroLaneGeometry.js` (pure, unit-tested).
- **Left header** — `TrackHeaderList.jsx` renders a compact "<Macro> Automation" label row under each
  parent track header (indented, parent-colored left border, with a hide affordance), matching the
  canvas lane heights so the header column stays row-aligned.
- Clips remain bound to `parentTrackId` (the owning `graphState.trackId`) + `macroNodeId`; they
  cannot float to arbitrary timeline lanes. Styling uses theme tokens / CSS variables only — no
  hardcoded production colors.

### Snap and loop clip polish (FXG.4-h-r2)

FXG.4-h-r2 aligns macro automation editing with the existing timeline snap system. Horizontal clip
move, clip resize, paste placement, and automation point X edits snap to the active timeline
`snapGranularity` at PPQ 960. Existing timeline modifier behavior is reused: `Alt` bypasses snap,
`Shift` temporarily uses the 1/32 grid, and `Ctrl` temporarily uses the 1/8 grid. Automation point
Y values remain smooth continuous normalized values in `[0.0, 1.0]`; no vertical stepping is added.

Loop-enabled automation clips now render the authored curve as the primary editable curve, followed
by subordinate ghost repetitions of the first-to-last-point loop segment within the same clip
bounds. Repeat dividers and the compact loop indicator make the finite repeated region visible, but
the curve is clipped at the clip end and never continues outside the clip. This visualization is not
an infinite LFO: runtime semantics are unchanged, loop playback only applies inside the clip region,
and empty lane space continues holding the last macro value.

Still deferred: direct plugin-parameter automation clips, LFOs/envelopes/peak followers, buses,
sample-accurate automation, and graph-to-chain return. Mixer Chain behavior is unchanged and
`effectChains` are not mutated.

## Engine execution boundary

Graph cables (`graphState` edges) affect audio only through the graph sync API
(`audio_syncGraphTopology`, with `audio_syncLinearGraphTopology` retained as a delegate). The sync
never calls chain `addEffect`/`moveEffect` and never mutates `effectChains`; chain mode is unchanged.

## Quarantine boundary

`NodeEditor.jsx` is quarantined and must not be imported by any active FX Graph panel.
`nodeGraphStore.js` is unused and must not be imported by any active FX Graph panel.
Both are confirmed excluded by `windowingScaffolding.test.tsx`.

## Runtime architecture (FXG.3+)

See [`fxgraph-runtime-architecture-audit.md`](fxgraph-runtime-architecture-audit.md) for the full
FXG.3-a audit: chain effect ownership, engine effect lifecycle, audio execution model,
graph-owned effect instance proposal, Edit button path, phased engine execution plan, risk
analysis, and recommended implementation sequence.

## Envelope Controller (EVC) — corrected direction

> **⚠️ Direction correction (EVC-R0).** The original per-voice **`voiceGain`** Envelope
> path (EVC.4–EVC.6) has been **retired/superseded**. The engine-side per-voice sources and
> tests (`EnvelopeVoiceEvents`, `EnvelopeAhdsr`, `EnvelopeRuntime`, and their
> `test_envelope_*` targets) and the EVC.6 Sampler/MixEngine voice-gain hooks were
> **intentionally removed in EVC-R0**. **Do not continue the old voiceGain/per-voice runtime
> path.**
>
> **Corrected target:** the Envelope Controller is a **graph-owned parameter-modulation
> source, like Macro and LFO** — an Envelope node produces a triggered ADSR value that drives
> an **exposed effect parameter** through the existing parameter-edge/mapping system and
> `GraphParameterTarget` (the same path Macro uses), rather than owning a per-voice audio-gain
> runtime. The Envelope's distinguishing behavior is that its value is **triggered by
> parent-track clips and/or pattern notes** with ADSR/gate shaping; otherwise it behaves like
> Macro/LFO in the graph.
>
> **Roadmap:**
> - **EVC-R0** (done) — retired the incorrect per-voice engine branch; engine
>   sources/tests removed, EVC.6 Sampler/MixEngine audio changes reverted. Cleanup only — no
>   new behavior.
> - **EVC-R1** (done) — reworked the Envelope graphState schema + node UI into a
>   **parameter-modulation control source**: dropped the `voiceGain` target and per-voice
>   fields, added a `controlOut` port and Envelope→parameter edges (GraphParameterTarget,
>   reusing the Macro wiring). Still **runtime-inert** (no parameter writes yet). See the
>   "EVC-R1" section below.
> - **EVC-R2** (done) — implement the **triggered-ADSR runtime drive** for effect parameters
>   (`setGraphEffectParameterNormalized` via `GraphParameterTarget`).
> - **EVC-R3** (done) — polish the Envelope node UX into a compact modulation node:
>   collapsed-by-default layout, slider-first AHDSR controls, and editable AHDSR graph handles.
>   Runtime behavior remains EVC-R2 unchanged.
> - **EVC-R2-r1** (done) — repair Envelope **timing**: move the parameter drive off the 200 ms
>   transport poll onto `PlayheadClock` frame updates (throttled to 60 Hz) with latest-wins
>   single-in-flight write discipline and a non-reactive runtime cache. The transport
>   subscription is now lifecycle-only (play/stop detection + one stop flush to 0). See the
>   "EVC-R2-r1" section below.
> - **EVC-R2-r2** (done) — repair pattern-note **held-over reconstruction**: a pattern note is now
>   included when its gate overlaps the block window, not only when its onset falls inside it, so a
>   note held into the window (block offset, or a long note from an earlier loop iteration) is seen
>   and the ADSR is evaluated from the note's real start. See the "EVC-R2-r2" section below.
> - **EVC-R2-r3** (done) — simplify Envelope **trigger semantics** to match the real track model:
>   the Trigger Source selector and Retrigger Mode are removed; the source (notes vs clips) is
>   inferred from the parent track's content; the Envelope always restarts on a new trigger; and
>   slide notes are ignored unless a new `includeSlideNotes` opt-in (default off) is enabled. Timing,
>   parameter-edge path, and EVC-R3 compact UI are unchanged. See the "EVC-R2-r3" section below.
>
> The EVC.1 audit and the EVC.4–EVC.6 sections below are retained as historical record; the
> per-voice model they describe is **no longer the product target**.

See [`fxgraph-envelope-controller-architecture-audit.md`](fxgraph-envelope-controller-architecture-audit.md)
for the EVC.1 foundation audit (historical: it recommended the now-retired per-voice model).

### EVC-R1 — envelope as a parameter-modulation control source (renderer/schema/UI, inert)

EVC-R1 reworks the EVC.2/EVC.3 Envelope node from the retired per-voice `voiceGain` meaning into
a **triggered parameter-modulation control source** — a sibling to Macro. It is
**renderer/schema/UI/linking only and runtime-inert**: it adds no triggered ADSR runtime, writes
no plugin parameters, and makes no engine/bridge/preload/main changes. Triggered-ADSR runtime
drive is deferred to EVC-R2.

- **Schema (`ui/src/fxgraph/graphState.js`).** `normalizeEnvelopeNodeData` drops the retired
  `target: { kind: "voiceGain" }`, `voiceMode`, `maxVoices`, and `monophonic` fields and adds
  `retriggerMode` (`"restart"` default | `"legato"`). Old saved envelopes load safely — the
  per-voice fields are silently dropped; `monophonic.legato` is **not** auto-migrated to legato
  (an explicit `restart` default avoids hidden behavior). The closed schema is now
  `{ label, attackMs, holdMs, decayMs, sustain, releaseMs, attackTension, decayTension,
  releaseTension, amount, triggerSource{ kind:"parentTrack", events }, retriggerMode }`. Parent
  ownership stays `graphState.trackId` (never stored on the node).
- **Output port + parameter edges.** A new `GRAPH_ENVELOPE_OUTPUT_PORT` (`controlOut`, the same
  port name Macro uses) is the Envelope's single control output. `canConnectEnvelopeToParameter`
  / `connectEnvelopeToParameter` mirror the Macro helpers (they deliberately do **not** generalize
  the Macro path, so Macro is never disturbed): the source must be an Envelope node, the target an
  effect node with an exposed, writable, non-read-only parameter port. The persisted edge is a
  standard `parameter` edge — `{ type:"parameter", sourcePort:"controlOut",
  targetPort:"gpp:{node}:{param}", targetParameter: GraphParameterTarget, mapping }` — identical in
  shape to a Macro→parameter edge. Self-links, duplicates, audio targets, Track I/O, macro, and
  envelope targets are rejected; no raw `engineNodeId` is ever persisted. Audio topology still
  ignores Envelope nodes and parameter edges. `collectEnvelopeParameterWrites` exists for EVC-R2
  (and tests) but is never called from a renderer drive path in EVC-R1. Disconnect reuses the
  existing source-agnostic `disconnectParameterEdge` / `disconnectGraphEdgeForTrack`.
- **Store (`ui/src/stores/effectChainStore.js`).** `connectEnvelopeToParameterForTrack` is
  graph-mode gated (rejects master/missing/chain/missing graphState like the other graph actions),
  persists via `timeline.setTrackGraphState`, and records the `connect_envelope_to_parameter`
  graph-owned undo transaction. Unlike the Macro action it **does not drive** the parameter after
  linking (the Envelope has no static output value — that comes from EVC-R2 runtime), so it never
  calls `setGraphEffectParameterNormalized`, never syncs audio runtime, and never touches
  `effectChains`/Mixer Chain.
- **UI (`GraphStatePreview.tsx`, `EnvelopeEditor.tsx`, `FxGraphPanel.tsx`).** The node renders an
  **Envelope Modulator** (no longer "Per-Voice Envelope"), shows AHDSR / Trigger / Retrigger /
  Amount / `Control Out → parameter`, and exposes a `controlOut` handle (`data-connect-source-kind
  ="envelope"`, `data-control-port-id="envelope:{id}:controlOut"`) that drags to an exposed
  parameter input port to create the edge — generalizing the existing control-source drag (macro)
  to handle envelope sources too, with the same tokenized cable/handle treatment and no audio
  handles. The compact editor drops Voice Mode / Max Voices / Voice-Gain target / Legato / Glide
  and adds a Retrigger Mode select; read-only previews still expose no connection affordance. Macro
  linking, parameter-cable rendering, and edge deletion are unchanged.
- **Scope.** No triggered ADSR runtime, no `setGraphEffectParameterNormalized` from the Envelope,
  no transport-trigger evaluation, no engine/bridge/preload/main changes, no LFO work, no Macro
  regression, no `effectChains`/Mixer-Chain mutation, no graph-to-chain return, no React Flow, no
  `NodeEditor.jsx`/`nodeGraphStore.js`, no package-lock changes.

### EVC-R2 — triggered-ADSR runtime drive for Envelope→parameter edges

EVC-R2 adds the **first runtime drive** for the Envelope→parameter edges EVC-R1 created. An
Envelope node now produces a single normalized `0..1` ADSR value, triggered by its parent track's
notes/clips, and drives its connected parameter edges through the same path Macro automation uses:
the per-link mapping (FXG.4-e/f/g) shapes the value, a `GraphParameterTarget` resolves the exposed
port, and `setGraphEffectParameterNormalized` (FXG.4-a) writes the stock/VST parameter. The runtime
is **renderer-side / control-rate** — the same timing class as macro automation playback, **not**
sample-accurate or audio-rate. It uses no per-voice gain, no Sampler, no MixEngine, and none of the
retired EVC.4–EVC.6 engine files; it never mutates Mixer Chain, `effectChains`, or `graphState`.

- **Pure evaluation (`ui/src/fxgraph/envelopeModulation.js`).** `normalizeEnvelopeRuntimeSettings`
  converts the node's AHDSR milliseconds to ticks (via the transport's bpm/PPQ → `msPerTick`).
  `collectGateIntervals` filters the parent track's trigger events by `triggerSource.events`
  (`notes` / `clips` / `notesAndClips`); `resolveActiveGate` merges overlapping events into
  continuous gate regions (so overlapping notes/clips hold the gate open until the **last** one
  ends, and same-tick chords collapse to one trigger), then picks the attack origin per
  `retriggerMode` (`restart` re-attacks from the latest trigger start; `legato` keeps the region
  start). `evaluateEnvelopeAdsrAtTime` walks straight A/H/D/S/R segments; **release falls from the
  actual level at gate end**, not an assumed sustain (correct for short gates). `amount` scales the
  final value once. Evaluation is **stateless across ticks** — the active gate is reconstructed from
  the full event list each tick, so seeking into an active note/clip evaluates the correct phase
  from the gate start. **Tension is ignored at runtime** (documented), matching the node preview
  which also draws straight segments.
- **Store (`ui/src/stores/effectChainStore.js`).** `applyEnvelopeModulationAtTick(globalTick,
  { trackEvents, msPerTick, bpm })` iterates graph-mode tracks (master/chain skipped), evaluates
  each Envelope node, and calls `driveEnvelopeParameterEdges` → `collectEnvelopeParameterWrites` →
  `setGraphEffectParameterNormalized`. Disabled mappings, unresolved/read-only targets, and
  envelopes with no edges fail safely; one failed write never aborts the others. Redundant writes
  are suppressed via the session-only `envelopeAutomationLastValues` cache (reset on project load /
  hydration and by `resetEnvelopeModulationRuntime`). It never mutates `graphState`, `effectChains`,
  or syncs audio topology.
- **Playback (`ui/src/fxgraph/envelopePlayback.js`, mounted once from `TimelineView.jsx`).**
  `startEnvelopePlayback` subscribes to the **same shared transport poller** as macro automation
  (no second competing loop), reuses `positionMsToTick`, and reconstructs per-track trigger events
  from the live timeline (`buildTrackTriggerEvents`: clips → clip gates; pattern blocks + patterns →
  note gates, mirroring the timeline note-drawing math). It drives **only while playing**.
- **Stop/reset behavior (chosen).** On the play↔stop transition the controller resets the session
  cache; on **stop** it performs one flush pass with no active gates, which drives every connected
  parameter to **0**. This prevents a triggered envelope from leaving a parameter stuck open, and a
  stopped transport never keeps writing.
- **Limitations.** Control-rate only (poll-rate granularity, not sample-accurate/audio-rate); trigger
  detection depends on renderer-accessible timeline/pattern data (a clip's notes produce no triggers
  if its pattern is not loaded; clip gates are always exact); tension is not modelled at runtime.
- **Scope (unchanged constraints).** No engine/native code, no bridge/preload/main changes, no
  per-voice EVC files revived, no Sampler/MixEngine changes, no new parameter-mapping format, no LFO
  work, no Macro regression, no `effectChains`/Mixer-Chain mutation, no graph-to-chain return, no
  React Flow, no `NodeEditor.jsx`/`nodeGraphStore.js`, no package-lock changes.

### EVC-R3 — compact Envelope node UX polish

EVC-R3 is **UI/UX polish only** for the corrected Envelope Modulator. It keeps the EVC-R2 runtime
drive unchanged: one graph-owned Envelope node evaluates one triggered normalized ADSR value, then
its existing parameter edges map that value to exposed stock/VST parameters through
`GraphParameterTarget`. No runtime trigger, stop/reset, parameter-write, mapping, Mixer Chain, or
`effectChains` behavior changes were introduced.

### EVC-R2-r1 — envelope drive timing repair (PlayheadClock-driven, write-disciplined)

EVC-R2's first cut drove the envelope from the **200 ms transport poller**. That poller is
explicitly drift-correction-only (`transportStore.js`: `PlayheadClock` handles the 60 fps
interpolation); writing the envelope once per 200 ms made a short ADSR lag and stair-step like a
slow random LFO instead of a responsive envelope. EVC-R2-r1 fixes the **cadence and write
discipline** — the ADSR math, trigger reconstruction, and stop/reset semantics from EVC-R2 are
unchanged. No engine/native, bridge/preload/main, or package-lock changes; no per-voice branch
revival; Macro automation is untouched.

- **Two clocks, two responsibilities (`ui/src/fxgraph/envelopePlayback.js`).**
  `startEnvelopePlayback` now subscribes to **both** the transport poller and
  `PlayheadClock.onFrame`:
  - *Transport lifecycle (poll).* Used only for play/stop transition detection. On a transition it
    resets the runtime cache and invalidates the trigger-event cache; on **stop** it performs the
    EVC-R2 one-shot flush that drives connected parameters to **0**. It no longer drives per tick.
  - *High-rate drive (onFrame).* While playing, each frame converts the interpolated `positionMs`
    to a tick (reusing `positionMsToTick`) and drives the envelope. It reuses the existing
    `PlayheadClock` frame source TimelineView already runs for auto-scroll — **no second rAF loop
    and no second poller**. Drive is throttled to a fixed `ENVELOPE_DRIVE_INTERVAL_MS = 1000 / 60`
    (60 Hz) so high-refresh displays do not over-drive. Because onFrame supplies interpolated
    positions, a late first transport poll no longer delays the envelope.
- **Latest-wins, single-in-flight async discipline.** A drive pass is invoked synchronously but its
  IPC writes are awaited. While one pass is in flight, newer frames overwrite a single `latest`
  slot (older intermediate ticks are dropped, never replayed). When the in-flight pass resolves, the
  newest pending tick drives next (only if still playing). This guarantees no overlapping passes and
  that an older write never lands after a newer one. A stop arriving mid-flight defers the flush
  until the in-flight write resolves, so the **0 flush is always the final write on stop**; a
  trailing onFrame after stop is guarded by the playing check and never writes a stale non-zero value.
- **Non-reactive runtime cache (`ui/src/stores/effectChainStore.js`).** The envelope last-applied
  dedupe cache moved out of Zustand state into a module-level `envelopeRuntimeLastValues` Map. At
  60 Hz, updating store state every frame would notify every subscriber and churn the main thread;
  the Map updates with no `set()`. `resetEnvelopeModulationRuntime` clears the Map (no notification),
  and project hydration clears it too. Macro's cache is unchanged.
- **Memoized trigger events.** `buildTrackTriggerEvents` is now cached per controller, keyed by the
  identity of the `{ clips, patternBlocks, patterns }` references TimelineView exposes (the wrapper
  object is rebuilt each render, but those inner references are stable between edits). Unchanged data
  reuses the built event map; any edit / project load / track change swaps a reference and rebuilds.
- **Limitations (unchanged + clarified).** Still renderer-side / **control-rate**, now at 60 Hz
  rather than 5 Hz — **not** sample-accurate or audio-rate. Trigger detection still depends on
  renderer-accessible timeline/pattern data; tension is still not modelled at runtime. The
  pattern-note held-over reconstruction gap noted in the EVC.1 audit is **not** addressed here. If
  60 Hz renderer drive is ever insufficient, engine/control-block parameter modulation is the
  future path — out of scope for this repair.
- **Scope (unchanged constraints).** No engine/native code, no bridge/preload/main changes, no
  per-voice EVC files revived, no Sampler/MixEngine changes, no `GraphParameterTarget`/mapping format
  changes, no LFO work, no Macro runtime change, no `effectChains`/Mixer-Chain mutation, no
  graph-to-chain return, no React Flow, no `NodeEditor.jsx`/`nodeGraphStore.js`, no package-lock
  changes.

- **Compact node body.** Envelope nodes now default to a shorter DAW-friendly layout: label +
  `Envelope Modulator`, compact AHDSR graph, Trigger source, Retrigger mode, Amount, and outgoing
  parameter count (`0 params`, `1 param`, `N params`). Read-only previews show only the compact
  summary and graph.
- **Expanded editing.** Editable graph-mode nodes expose an inline `Edit` affordance. The expanded
  editor uses slider-first controls for Attack, Hold, Decay, Sustain, Release, and Amount, with
  compact numeric fields retained for precision. Advanced tension fields are hidden behind an
  Advanced disclosure.
- **Editable AHDSR graph.** The visual graph is still AHDSR only: handles edit the existing
  `attackMs`, `holdMs`, `decayMs`, `sustain`, and `releaseMs` fields. This is not MSEG, not
  freehand drawing, not automation lanes, and not audio-rate/sample-accurate modulation.
- **Scope.** No engine/native code, no bridge/preload/main changes, no package-lock changes, no
  retired per-voice EVC files revived, no Sampler/MixEngine changes, no Macro regression, no
  `effectChains`/Mixer-Chain mutation, no graph-to-chain return, no React Flow, no
  `NodeEditor.jsx`/`nodeGraphStore.js`.

### EVC-R2-r2 — pattern-note held-over reconstruction

EVC-R2-r1 fixed the drive *cadence*; EVC-R2-r2 fixes the remaining *trigger reconstruction* gap the
EVC.1 audit flagged. `buildPatternBlockNoteEvents` (`ui/src/fxgraph/envelopePlayback.js`) previously
emitted a pattern note only when its onset (`tape`) fell inside the block window
`[offsetTicks, offsetTicks + durationTicks)`. A note that **started before the window but was still
held inside it** — a block scrolled by `offsetTicks`, or a long note carried over from an earlier
loop iteration — was skipped, so the envelope saw no gate and read 0 / released early mid-held-note.

- **Overlap inclusion, real start/end preserved.** A note is now emitted when its gate
  `[tape, tape + durationTicks)` **overlaps** the window (half-open: `tape < windowEnd &&
  tape + dur > windowStart`), in addition to the original onset-in-window case. The note's **real**
  absolute start/end are kept — `startTick = blockPos + (tape - windowStart)` (which can be earlier
  than the block's left edge) and `endTick = startTick + dur`. ADSR elapsed therefore stays
  `queryTick - noteStartTick` and release still begins at the real note end.
- **Earlier loop iterations.** When the block loops, the first scanned iteration is extended downward
  by the longest note (`firstLoop = max(0, floor((windowStart - maxNoteDur) / patLen))`) so a note
  begun in a prior iteration and still held into the window is reconstructed. The per-note overlap
  test does the precise filtering; the extra iterations are cheap and emit no spurious events.
  Loop-disabled blocks keep their original "iteration 0 only, remainder is empty space" semantics.
- **No collapse/merge in the builder.** The builder still emits one event per note (same-tick chord
  members stay separate); same-tick chord collapse and overlapping-gate merge remain in
  `envelopeModulation` (`buildGateRegions` / `resolveActiveGate`). One Envelope node still yields one
  value — no per-voice/per-note outputs.
- **Clips unchanged.** Clip gates were already position-pure; clip event building, mid-clip
  evaluation, overlap merge, and Notes/Clips/NotesAndClips filtering are untouched.
- **Timing unchanged.** The EVC-R2-r1 `PlayheadClock.onFrame` 60 Hz drive, latest-wins
  single-in-flight guard, non-reactive runtime cache, one stop flush to 0, trailing-frame stop guard,
  and identity-keyed trigger memoization are all preserved. Runtime stays renderer-side /
  control-rate (still **not** sample-accurate/audio-rate).
- **Remaining edge.** A held-over note whose **real absolute start maps below tick 0** (a block
  within one note-length of the timeline origin combined with a positive `offsetTicks`) is still
  dropped downstream by `collectGateIntervals`' non-negative-start guard. This is a rare corner left
  as a documented limitation to keep the clip path's guard unchanged.
- **Scope.** No engine/native code, no bridge/preload/main changes, no package-lock changes, no
  retired per-voice EVC files revived, no Sampler/MixEngine changes, no Macro runtime change, no
  `GraphParameterTarget`/mapping-format change, no stop/reset-policy change, no LFO work, no
  `effectChains`/Mixer-Chain mutation, no graph-to-chain return, no React Flow, no
  `NodeEditor.jsx`/`nodeGraphStore.js`.

### EVC-R2-r3 — simplified trigger semantics (inferred source, restart-only, slide opt-in)

EVC-R2-r3 aligns the Envelope's trigger model with the **real Xleth track model**: a track is either
a **pattern/MIDI-note track** or a **clip track**, never both. The previous Trigger Source selector
(Notes / Clips / Notes + Clips) and Retrigger Mode (Restart / Legato) implied choices the product
does not actually have, so both are **removed** as active behavior.

- **Trigger source is inferred, not selected.** `inferTriggerSourceKind(triggerEvents)`
  (`ui/src/fxgraph/envelopeModulation.js`) reads the parent track's built trigger events and returns
  `'note'`, `'clip'`, or `null`. A pattern (note) track contributes note events ⇒ notes drive; a clip
  track contributes clip events ⇒ clips drive. If both kinds somehow appear (legacy/corrupt/mixed
  state) notes win deterministically; if neither exists there are no triggers. `collectGateIntervals`
  now applies this inference instead of a stored `triggerSource.events` mode, so a normal track never
  produces both note and clip gates.
- **Restart-only.** `resolveActiveGate` no longer takes a `retriggerMode`: every new valid trigger at
  or before the query tick restarts the attack from the latest start within the gate region. Legato
  (hold-from-region-start) is gone. Same-tick chord starts still collapse into one trigger
  (`buildGateRegions`), and overlapping notes/clips still hold the gate open until the last one ends.
- **Slide notes ignored by default; `includeSlideNotes` opt-in.** A pattern note marked
  `note.isSlide === true` is a slide note. Detection is centralized in `isSlidePatternNote(note)`
  (`ui/src/fxgraph/envelopePlayback.js`), which tags the built note event with `isSlide: true` (normal
  notes omit the flag). `collectGateIntervals` drops slide-note gates unless the Envelope node's
  `includeSlideNotes` is `true`. Normal notes always trigger; clip gates are never affected by the
  opt-in. Existing slide-note playback elsewhere is untouched — the Envelope only reads the flag.
- **Schema.** The persisted Envelope node data (`normalizeEnvelopeNodeData`,
  `ui/src/fxgraph/graphState.js`) dropped `triggerSource` and `retriggerMode` and added
  `includeSlideNotes` (default `false`; repairs to `false` unless exactly boolean `true`). The closed
  shape silently drops old saved `triggerSource`/`retriggerMode` and the retired per-voice
  `target:{kind:"voiceGain"}` / `voiceMode` / `maxVoices` / `monophonic` fields on load. Parent
  ownership stays `graphState.trackId`; no `parentTrackId` is stored on the node.
- **UI.** The compact node summary no longer shows a Notes/Clips source pill or a Restart/Legato pill;
  a small `Slide` pill appears only when `includeSlideNotes` is on. The expanded editor replaced the
  two selects with a single **Include slide notes** checkbox (`IncludeSlideNotesControl`,
  `EnvelopeEditor.tsx`), tokenized with the existing envelope success accent. Read-only previews (no
  `onChange`) never render the checkbox, so it is never editable outside graph-edit mode. The EVC-R3
  compact layout, AHDSR graph, sliders, Advanced tension disclosure, and the draggable `controlOut`
  handle are otherwise unchanged.
- **Preserved.** The EVC-R2-r1 `PlayheadClock.onFrame` 60 Hz drive, latest-wins single-in-flight
  guard, non-reactive last-value cache, single stop flush to 0, trailing-frame stop guard, and
  identity-keyed trigger memoization are all unchanged. The Envelope `controlOut` port, the
  Envelope→parameter edge shape, `GraphParameterTarget`, the per-link mapping format, and
  `collectEnvelopeParameterWrites` / `setGraphEffectParameterNormalized` are unchanged. Runtime stays
  renderer-side / control-rate — still **not** sample-accurate/audio-rate (the remaining limitation).
- **Scope.** No engine/native code, no bridge/preload/main changes, no package-lock changes, no
  retired per-voice EVC files revived, no Sampler/MixEngine changes, no Macro runtime change, no
  `GraphParameterTarget`/mapping-format change, no stop/reset-policy change, no LFO work, no
  `effectChains`/Mixer-Chain mutation, no graph-to-chain return, no React Flow, no
  `NodeEditor.jsx`/`nodeGraphStore.js`.

### EVC.2 — envelope node graphState schema (inert) — reworked by EVC-R1

> The EVC.2 renderer-side schema was **reworked by EVC-R1** from a per-voice `voiceGain` target
> into a parameter-modulation `controlOut` source (see the EVC-R1 section above). The per-voice
> framing below is historical.

EVC.2 adds the renderer-side data model for the Envelope Controller as a new graph node type,
`type: 'envelope'`, a sibling to the Macro control node in `ui/src/fxgraph/graphState.js`. It is an
**inert definition only** — this phase adds no UI, no runtime ADSR evaluation, no trigger-event
contract, and no engine-side parsing.

- **Per-voice by product model.** The persisted node describes a per-voice controller (see the
  audit): pattern notes and timeline clips each spawn independent envelope voices that never
  combine. The node stores this intent; it does not yet act on it.
- **Stored data (closed schema).** `data` holds AHDSR (`attackMs`, `holdMs`, `decayMs`, `sustain`,
  `releaseMs`), per-segment tension (`attackTension`, `decayTension`, `releaseTension`), `amount`,
  `voiceMode` (`"poly"` default | `"mono"`), `maxVoices` (1..32), a `triggerSource`
  (`{ kind: "parentTrack", events: "notes" | "clips" | "notesAndClips" }`), a `target`
  (`{ kind: "voiceGain" }` only), and inert `monophonic` (`{ legato, glideMs }`) knobs. Normalization
  clamps/repairs every field and forces the `triggerSource.kind`/`target.kind` enums; malformed or
  missing data repairs to defaults without throwing. Parent ownership is `graphState.trackId` — the
  parent track id is never stored redundantly on the node.
- **Not an effect node.** Envelope nodes have no `effectInstanceId`, own no plugin metadata, hydrate
  no graph-owned processor, and are excluded from the audio topology payload
  (`buildLinearGraphTopologyPayload` treats `envelope` as a control node, like `macro`). Audio edges
  touching an envelope node are dropped on load and rejected by `canConnectGraphNodes`.
- **Not a modulation endpoint.** Envelope nodes are rejected as both source and target of
  macro→parameter links; they never use `GraphParameterTarget` and never connect to an exposed
  stock/VST plugin parameter.
- **Helpers.** `normalizeEnvelopeNodeData`, `createDefaultEnvelopeNodeData`, `isEnvelopeGraphNode`,
  `addGraphEnvelopeNode`, and `updateGraphEnvelopeNodeData` are pure/immutable and preserve unrelated
  nodes/edges/graphState fields. Envelope nodes are not protected and are removable by
  `removeGraphNode`.
- **Store actions.** `addGraphEnvelopeNodeForTrack` and `updateGraphEnvelopeNodeDataForTrack` in
  `effectChainStore.js` are gated on `fxMode === 'graph'` (rejecting master/missing/chain-mode/missing
  graphState exactly like the macro actions), persist via `timeline.setTrackGraphState`, and record
  graph-owned undo/redo transactions (`add_graph_envelope_node`, `update_graph_envelope_node`). They
  perform no audio runtime sync, no graph effect hydration, never create/destroy graph-owned
  processors, never call `setGraphEffectParameterNormalized`, and never mutate `effectChains` or
  Mixer Chain state.

Runtime (per-voice ADSR evaluation, voice/trigger contract, seek reconstruction, per-voice gain
application) remains deferred to EVC.4 / EVC.5 / EVC.6.

### EVC.3 — envelope node UI (visual/editable, still inert) — reworked by EVC-R1

> The EVC.3 renderer UI (Add Envelope affordance, `GraphStatePreview.tsx` rendering,
> `EnvelopeEditor.tsx`, UI tests) was **reworked by EVC-R1** into the parameter-modulator node
> (Envelope Modulator + `controlOut` port; see the EVC-R1 section above). The `Per-Voice
> Envelope` / `Target: Voice Gain` framing below is historical.

EVC.3 makes the EVC.2 envelope node visible and editable in the active safe FX Graph UI. It is
**renderer-only and non-audible** — no runtime ADSR evaluator, no trigger-event contract, no
engine-side graphState parsing, no per-voice gain application, and no bridge/preload/main changes.

- **Add affordance.** The FX Graph workspace toolbar gains an **Add Envelope** button next to Add
  Effect / Add Macro, shown only when the panel is in `fxMode === 'graph'`. It calls the EVC.2 store
  action `addGraphEnvelopeNodeForTrack`; outside graph mode the affordance is absent, and a rejected
  add surfaces the existing non-blocking inline notice via `describeGraphMutationResult`. The add
  performs no audio runtime sync, creates no processor, and never touches `effectChains`.
- **Distinct node rendering.** Envelope nodes render in `GraphStatePreview.tsx` as graph-owned
  per-voice controller nodes, visually distinct from effect (accent) and macro (warning) nodes via
  the `--theme-success` token. Each node shows a header label, a `Per-Voice Envelope` subtitle, a
  compact AHDSR summary, the current target (`Target: Voice Gain`), the trigger source
  (Notes / Clips / Notes + Clips), the voice mode (Poly / Mono) with max voices, the amount, and a
  small **illustrative** ADSR/AHDSR preview curve. The preview is computed from `node.data` only — it
  never reads transport state, creates runtime voices, writes plugin parameters, or interacts with
  macro automation playback. Per-segment tension is intentionally not drawn yet (no runtime support).
- **Compact editor.** When graph mode is active, a compact inline editor (`EnvelopeEditor` in
  `windowing/panels/fxgraph/EnvelopeEditor.tsx`) edits `label`, `attackMs`, `holdMs`, `decayMs`,
  `sustain`, `releaseMs`, the three tensions, `amount`, `voiceMode`, `maxVoices`,
  `triggerSource.events`, and the inert `monophonic.legato` / `monophonic.glideMs`. `target.kind` is
  shown read-only (`Voice Gain`) because v1 has a single target. Inputs are uncontrolled
  (`defaultValue`, commit on blur/change) so in-progress typing is never destroyed; every edit routes
  through `updateGraphEnvelopeNodeDataForTrack`, which clamps/repairs via the EVC.2
  `normalizeEnvelopeNodeData`. No clamping is duplicated in the UI. Read-only previews (no callback)
  show only the summary + preview, with no editing affordances.
- **No ports, no edges.** Envelope nodes expose **no** audio input/output handle, **no** parameter
  input/output port, and **no** macro-style `controlOut` port, and they never participate in
  drag-to-connect. They are draggable, removable (via the existing `removeGraphNode` path), persist
  position, and participate in graph undo/redo through the EVC.2 store actions and existing graph
  history — exactly like other editable graph nodes.

No trigger contract, runtime ADSR, engine parsing, per-voice gain application, `GraphParameterTarget`
usage, plugin-parameter output, Mixer Chain mutation, or `effectChains` mutation exists after EVC.3.

### EVC.4 — engine-side trigger/voice occurrence contract (pure, non-audible) — RETIRED (superseded by EVC-R0)

> **Retired.** `engine/src/model/EnvelopeVoiceEvents.h/.cpp` and
> `engine/test/test_envelope_voice_events.cpp` were **removed in EVC-R0**. The per-voice
> occurrence contract is no longer the product target. Retained below as historical record.

EVC.4 adds a **pure engine-side** model for enumerating the parent-track clip/note voice
occurrences a per-voice Envelope node would later modulate. It is contract/model/test foundation
only: **not audible**, evaluates **no AHDSR**, applies **no per-voice gain**, and parses
**no graphState** at runtime. It prepares EVC.4b (seek/reconstruction) and EVC.5 (runtime).

- **Location & purity.** The contract lives in `engine/src/model/EnvelopeVoiceEvents.h/.cpp` and is
  compiled into the pure `XlethEngineModel` library (no JUCE, no audio thread, no transport, no
  graphState). It mirrors the `VideoFlipResolver` determinism precedent (same inputs → same output,
  always) rather than `src/audio/`, so the test (`engine/test/test_envelope_voice_events.cpp`)
  links solely against `XlethEngineModel` and runs fast. Future EVC.5 runtime application (in/next
  to `MixEngine`/`Sampler`) consumes this contract, exactly as `VideoFlipApplier` (render-side)
  consumes the pure `VideoFlipResolver`.
- **Occurrence identity.** `EnvelopeVoiceOccurrenceKey` is the stable engine-internal composite
  `(trackId, sourceKind, sourceId, onsetTick, loopIteration, patternBlockId)` (the audit §4
  candidate, extended with `patternBlockId`). It distinguishes overlapping clips, same-tick chord
  notes, and the same note across loop iterations — chords are never collapsed. The key is
  **engine-internal**: never exposed to the renderer/IPC, never serialized into graphState.
- **Voice event.** `EnvelopeVoiceEvent` carries the key plus onset/gate-end in both tick (960-PPQ,
  authoritative) and sample domains (derived via the same `TickTime::toSamples` conversion
  MixEngine uses), `loopIteration`, `pitch` (MIDI for notes, semitone offset for clips — the
  `SyncManager`/`VideoEvent` convention), `velocity`, `regionId`, `patternId`, and `patternBlockId`.
  The gate is the duration: release begins at `gateEndTick`.
- **Enumeration helpers (all pure).** `enumerateEnvelopeClipOccurrences`,
  `enumerateEnvelopePatternNoteOccurrences`, and `enumerateEnvelopeVoiceOccurrences` read only the
  supplied model data (clips / pattern blocks / patterns), a parent `trackId`, an
  `EnvelopeTriggerEvents` selector (`notes` | `clips` | `notesAndClips`, mirroring the EVC.2
  `triggerSource.events` schema), a half-open `EnvelopeQueryWindow` tick range, and tempo. They
  never read live playback history or transport state. Output is a deterministically-sorted list
  (onset → source kind → track → block → loop → pitch → source id), mirroring the `VideoFlipApplier`
  tie-break precedent.
- **Timing semantics.** Pattern-note onset/gate/loop math mirrors `MixEngine::triggerPatternNotes`
  exactly: block position, block offset, loop iteration over pattern length, note offset, note
  length, and the note-off clamp to the block end; `loopEnabled === false` plays only iteration 0;
  zero-length patterns are skipped; slide notes (silent markers) produce no occurrence. A note
  occurrence is produced when its onset tick falls inside the query window (**live-trigger
  semantics** — held-note mid-window reconstruction is deferred to EVC.4b). Clip occurrences use
  the position-pure **overlap** test from `MixEngine::findActiveClips`, so a mid-clip query still
  returns the clip (clip activity is already seek-deterministic). The contract operates in the tick
  domain for determinism (it omits the live path's ±2-sample-rounding tick widening, a realtime
  artifact) and derives sample positions for downstream use.
- **Scope.** No `Sampler`/`MixEngine` audio output change, no per-voice gain, no graphState runtime
  parsing, no `GraphParameterTarget` usage, no plugin-parameter output, no bridge/preload/main
  changes, no renderer/UI changes, no Mixer Chain or `effectChains` mutation.

### EVC.4b — AHDSR phase/value evaluation + seek reconstruction (pure, non-audible) — RETIRED (superseded by EVC-R0)

> **Retired.** `engine/src/model/EnvelopeAhdsr.h/.cpp`, the `…ForReconstruction` enumerators in
> `EnvelopeVoiceEvents.h/.cpp`, and `engine/test/test_envelope_ahdsr.cpp` were **removed in
> EVC-R0**. A future parameter-modulator ADSR evaluator (EVC-R2) will be reintroduced under the
> corrected design. Retained below as historical record.

EVC.4b adds the **pure, closed-form** half of the per-voice Envelope model: an AHDSR evaluator that
answers "what phase and normalized level is an envelope at, at an arbitrary elapsed time?" and
reconstruction helpers that, given the EVC.4 voice occurrences, compute the **active/releasing**
envelope voice states at any transport position. It is the foundation for EVC.5 (runtime) and EVC.6
(per-voice gain application). It remains **not audible**: it evaluates levels only, applies **no
per-voice gain**, drives **no Sampler voice**, parses **no graphState** at runtime, and is never
called from audio rendering.

- **Pure AHDSR model.** `engine/src/model/EnvelopeAhdsr.h/.cpp` defines `EnvelopeAhdsrSettings`
  (engine-side mirror of the normalized EVC.2 data shape: `attackMs/holdMs/decayMs/sustain/
  releaseMs` + per-segment `attack/decay/releaseTension` + `amount`, with EVC.2 defaults
  10/0/120/0.7/200/0/0/0/1). `normalized()` repairs defensively — ms finite & ≥ 0, sustain/amount
  clamped to 0..1, tension clamped to −1..+1, non-finite → default — so evaluation never divides by
  zero or returns NaN/Inf. It does **not** parse graphState JSON in this phase; callers build the
  struct directly.
- **Closed-form evaluation.** `evaluateEnvelopeAhdsr(settings, elapsedMs, gateLengthMs)` returns an
  `EnvelopeAhdsrState` (`phase`, amount-scaled `normalizedLevel`, `elapsedMs`, `gateElapsedMs`,
  `releaseElapsedMs`, `releaseStartLevel`, `active`). Phases: `Off → Attack → Hold → Decay → Sustain
  → Release → Off`. Before onset is `Off`/level 0; the gate is the duration, so **release begins at
  gate end** and falls from the **actual level reached at gate end** (short notes/clips that end
  mid-attack/hold/decay release from their real level, never an assumed sustain); release completion
  is `Off`/level 0. Zero-duration stages are safe (zero attack → immediate 1, zero release →
  immediate Off after gate end, zero decay → immediate sustain), and `amount` scales the result
  (amount 0 → level 0). The tension shaping matches `Sampler::shapeTension` exactly
  (`pow(t, pow(2, −tension·2))`), so the pure model and the existing per-voice Sampler envelope agree
  on shape. `Sampler::advanceEnvelope`/`processVoice` are **not modified** — this is an independent
  pure evaluator.
- **Live vs. reconstruction enumeration (kept distinct).** The EVC.4 enumerators are
  **live-trigger** (a note occurrence is produced only when its onset lands in the window). EVC.4b
  adds parallel `…ForReconstruction` enumerators in `EnvelopeVoiceEvents.h/.cpp`
  (`enumerateEnvelopeClipOccurrencesForReconstruction`,
  `enumerateEnvelopePatternNoteOccurrencesForReconstruction`,
  `enumerateEnvelopeVoiceOccurrencesForReconstruction`) that admit an occurrence when it is still
  **sounding or releasing** at the window — i.e. its gate, extended by the release tail, overlaps
  the window, even if its onset is in the past. The note path widens its candidate scan backward to
  cover the longest note plus the release tail, then tests overlap against the original window; the
  clip path extends each clip's gate end by the release tail. The EVC.4 live functions are
  **unchanged** — both concepts coexist and are tested to stay distinct (a mid-note window returns
  nothing from the live enumerator but the held note from the reconstruction enumerator; a released
  clip within its tail is likewise absent live but present in reconstruction).
- **Per-voice state reconstruction.** `reconstructEnvelopeVoiceStates(events, settings, queryTick,
  bpm)` evaluates each occurrence's AHDSR at the query tick (one `EnvelopeReconstructedVoice` per
  event, **including** `Off` voices); `reconstructActiveEnvelopeVoiceStates(...)` filters to active
  voices (sounding or releasing). Each reconstructed voice couples the occurrence identity/metadata
  (key, source kind/id, onset/gate-end ticks, pitch/velocity) to its `EnvelopeAhdsrState`. Voices
  are **never combined** — exactly one reconstructed state per occurrence, so chords, overlapping
  clips, and loop iterations each yield independent states. Querying before onset or after the
  release tail omits the voice from the active set.
- **Timing.** Tick domain is authoritative (960 PPQ, consistent with EVC.4). `envelopeTicksToMs`
  converts a tick delta to elapsed ms via the same `TickTime::toSeconds` math MixEngine uses;
  `envelopeReconstructionTailTicks` converts the release length back to ticks (rounded up) for the
  reconstruction window. Phase evaluation is ms-based internally, with the tick→ms conversion
  explicit and deterministic.
- **Tests.** `engine/test/test_envelope_ahdsr.cpp` (pure, model-only, links solely against
  `XlethEngineModel`) covers default normalization, every AHDSR phase, short-note release from the
  actual level, zero attack/decay/release safety, amount scaling, malformed-input normalization, and
  reconstruction edge cases (mid-clip, mid-note attack/sustain, during release, after release
  omitted, same-tick chord independence, distinct loop iterations, overlapping clips, trigger-source
  filtering, and live-vs-reconstruction distinctness for both notes and clips).
- **Scope.** No `Sampler`/`MixEngine` audio output change, no runtime ADSR voice binding, no
  per-voice gain application, no graphState runtime parsing, no `GraphParameterTarget` usage, no
  plugin-parameter output, no bridge/preload/main changes, no renderer/UI changes, no clip-fade
  change, no Mixer Chain or `effectChains` mutation.

### EVC.5 — engine-side definition parsing + per-voice runtime binding (non-audible) — RETIRED (superseded by EVC-R0)

> **Retired.** `engine/src/model/EnvelopeRuntime.h/.cpp` and
> `engine/test/test_envelope_runtime.cpp` were **removed in EVC-R0**. The corrected design parses
> Envelope nodes as graph-owned parameter-modulation sources (EVC-R1) and drives exposed
> parameters via `GraphParameterTarget` (EVC-R2), not per-voice runtime binding. Retained below
> as historical record.

EVC.5 adds the engine-side **runtime binding layer** on top of EVC.4 (occurrence enumeration) and
EVC.4b (closed-form AHDSR evaluator + reconstruction). It does two things: it **parses** Envelope
node *definitions* out of a track's opaque graphState JSON into engine-side descriptors, and it
**binds** per-voice occurrences to independent runtime voice states evaluated through the EVC.4b
evaluator. It remains **not audible**: it evaluates levels only, applies **no per-voice gain**,
drives **no Sampler voice**, touches **no clip gain**, parses graphState **read-only**, and is never
called from audio rendering. EVC.6 adds the per-voice gain target application.

- **Definition parsing.** `engine/src/model/EnvelopeRuntime.h/.cpp` adds
  `parseEnvelopeControllerDefinitions(graphState)` — pure, read-only, never-throwing — which scans
  `graphState.nodes[]` for `type === "envelope"` nodes and produces `EnvelopeControllerDefinition`
  structs (`nodeId`, `label`, `EnvelopeAhdsrSettings`, `voiceMode` poly/mono, `maxVoices`,
  `triggerEvents`, `target` = voiceGain, inert `monophonic{legato,glideMs}`). It mirrors the EVC.2
  renderer repair rules: ms finite ≥ 0, sustain/amount clamped 0..1, tension clamped −1..+1 (via
  `EnvelopeAhdsrSettings::normalized()`), `voiceMode` repairs to poly unless `"mono"`, `maxVoices`
  rounds and clamps to 1..32, `triggerSource.events` repairs to notesAndClips unless notes/clips.
  Nodes with an **unsupported `target.kind`** (anything but `voiceGain` — never a
  `GraphParameterTarget`) or an **unsupported `triggerSource.kind`** (anything but `parentTrack`)
  are **ignored**; malformed/typeless/idless nodes are skipped. The **parent track id is not stored
  on the definition** — track binding comes from the owning track context (single-source-of-truth,
  matching the renderer). The parser reads no `effectInstanceId`, no exposed parameter ports, no
  macro automation, no `effectChains`; it is never exposed to renderer/IPC.
- **Per-voice runtime binding.** `EnvelopeControllerRuntime` holds one definition + a map of live
  `EnvelopeRuntimeVoice`s keyed by `EnvelopeVoiceOccurrenceKey`. `updateForQuery(clips, blocks,
  patterns, parentTrackId, queryTick, bpm, sampleRate)` reconstructs every sounding/releasing
  occurrence at the transport tick using the EVC.4b `enumerateEnvelopeVoiceOccurrencesForReconstruction`
  + `reconstructEnvelopeVoiceStates` (the AHDSR math is **reused, never duplicated**, and the EVC.4
  live-trigger enumeration is untouched), binds each to an **independent** runtime voice
  (`currentPhase`, amount-scaled `currentLevel`, `state` Active/Releasing/Off, pitch/velocity), and
  **cleans up** finished voices (Off / no-longer-enumerated occurrences are dropped). Voices are
  **never combined** — chords, overlapping clips, and loop iterations each yield separate voices.
- **maxVoices steal policy.** When the live voice count exceeds the definition's `maxVoices`, a
  deterministic steal runs: prefer dropping already-Off voices (already excluded), then the oldest
  *releasing* voice, then the oldest *active* voice (by `onsetTick`, with the occurrence-key total
  order as a stable tie-break).
- **Per-track runtime.** `EnvelopeTrackRuntime` owns all controller runtimes for a track keyed by
  node id. `updateDefinitions(defs)` syncs the set — unchanged definitions carry their live voices
  forward, a changed definition **resets** that controller's voices, removed controllers are
  dropped. `evaluateAtPosition(...)` advances every controller at a tick. It is only meant to be fed
  for tracks whose `fxMode === graph`; a chain-mode track or the master is never given definitions,
  so it holds no controllers and produces no voices.
- **Integration boundary (deferred to EVC.6).** EVC.5 is intentionally **model-level only** — it is
  not yet wired into `MixEngine`. The future hookup point: when project/track data changes, parse
  `TrackInfo::graphState` (already `nlohmann::json`) for each `fxMode === Graph` track and feed the
  resulting definitions to a per-track `EnvelopeTrackRuntime`; during rendering, call
  `evaluateAtPosition` at the block's transport position. EVC.6 then applies each voice's
  `currentLevel` to **per-voice gain** (the first runtime target). Keeping EVC.5 model-only keeps
  the test suite pure (links solely against `XlethEngineModel`) and avoids any audio-core risk.
- **Tests.** `engine/test/test_envelope_runtime.cpp` (pure, model-only) covers parsing (valid node,
  non-envelope/malformed nodes ignored, AHDSR/voiceMode/triggerEvents/maxVoices repair, unsupported
  target/trigger kinds ignored, no `effectInstanceId` required, `GraphParameterTarget` never parsed)
  and runtime binding (one note, same-tick chord, overlapping clips, distinct loop iterations,
  notes-only/clips-only/notesAndClips filtering, mid-note and mid-clip reconstruction, query during
  release keeps the voice, query after release cleans it up, deterministic `maxVoices` cap, no voice
  combination, and definition-change reset/removal).
- **Scope.** No `Sampler`/`MixEngine` audio output change, no per-voice gain application, no clip
  gain change, no `GraphParameterTarget` usage, no plugin-parameter output, no bridge/preload/main
  changes, no renderer/UI changes, no graphState mutation, no Mixer Chain or `effectChains` mutation.

### EVC.6 — per-voice gain target (first audible Envelope phase) — RETIRED (superseded by EVC-R0)

> **Retired.** The EVC.6 per-voice gain hooks in `Sampler.h/.cpp` and `MixEngine.h/.cpp`
> (`setEnvelopeControllers`, `evcGain`, `refreshEnvelopeDefinitions`,
> `applyEnvelopeControllersToSampler`, etc.) and `engine/test/test_envelope_voice_gain.cpp` were
> **reverted/removed in EVC-R0**, restoring pre-EVC.6 audio behavior. The Envelope Controller
> will instead modulate **exposed effect parameters** (EVC-R1/EVC-R2), never per-voice audio
> gain. Retained below as historical record.

EVC.6 makes the Envelope Controller **audible for the first time**: it applies each per-voice
Envelope level as an **additional per-voice gain multiplier** on the v1 target (`voiceGain`). It
affects **only graph-mode normal tracks** (`fxMode === graph`) that have valid `type: "envelope"`
nodes targeting `voiceGain`; chain-mode tracks, the master, and tracks with no Envelope node are
byte-for-byte unchanged (the multiplier is a transparent `1.0`). Pattern notes and timeline clips
are modulated **independently per occurrence** — chords, overlapping clips, and loop iterations
each get their own envelope phase and are **never averaged/summed/combined**. Multiple Envelope
nodes targeting `voiceGain` on one track **multiply** their per-voice gains together. It still does
**not** use `GraphParameterTarget`, plugin parameters, parameter edges, macro automation, or global
aggregation, and does not mutate graphState, the Mixer Chain, or `effectChains`.

- **Application primitives (pure, model-level).** `engine/src/model/EnvelopeRuntime.h/.cpp` adds
  `envelopeTriggerAffectsSource(events, sourceKind)` (Notes→note voices, Clips→clip voices,
  NotesAndClips→both), `envelopeVoiceGainSettings(defs, sourceKind)` (the per-source filtered AHDSR
  list handed to the Sampler), and `envelopeVoiceGainMultiplier(defs, sourceKind, elapsedMs,
  gateLengthMs)` — the product of each applicable controller's amount-scaled level from the EVC.4b
  `evaluateEnvelopeAhdsr` (no AHDSR math is duplicated). The multiplier is `1.0` when no controller
  applies, each level is already `amount`-scaled (so `amount` is applied exactly once, never
  doubled), and the product stays in `0..1`.
- **Pattern-note voices (Sampler).** `Sampler::setEnvelopeControllers(settings, count)` stores up to
  `kMaxEnvelopeControllers` resolved AHDSR curves (a fixed array — no audio-thread allocation). The
  Sampler never sees graphState JSON or `EnvelopeControllerDefinition`, only resolved curves. Each
  voice carries `evcElapsedSamples`/`evcGateSamples` and, in `processVoice`, multiplies the product
  of `evaluateEnvelopeAhdsr` over those curves into its output **in lockstep with** (never replacing)
  the region AHDSR, velocity, fades, declick, and LFO stages. The gate is the note duration: it is
  captured the first sample the voice enters Release (the sample-accurate deferred noteOff), so the
  Envelope releases when the note ends and the release tail shapes the voice's own release tail.
  One voice owns one envelope automatically (chords/loops stay independent; voice steal frees both
  together).
- **Timeline-clip voices (MixEngine).** Clip activity is position-pure (`findActiveClips` overlap),
  so the per-clip envelope phase is `elapsed = playhead − clipStart` with the clip duration as the
  gate, multiplied into the existing per-clip gain (velocity × fades) in the per-sample clip read
  path. Overlapping clips each compute their own elapsed and stay independent; mid-clip playback
  starts apply the correct level deterministically (preview/export parity, since both run the same
  `processBlock`).
- **MixEngine plumbing.** `MixEngine::refreshEnvelopeDefinitions()` parses each graph-mode track's
  `TrackInfo::graphState` into `EnvelopeControllerDefinition`s (cached per track; re-parsed only when
  that track's graphState value actually changed, dropped when a track leaves graph mode or
  vanishes). It is **engine-internal and read-only** — it never mutates graphState, never adds a
  bridge/IPC path, and is not driven by the renderer (the renderer only persists definitions through
  the existing `timeline.setTrackGraphState`). `applyEnvelopeControllersToSampler` pushes the
  note-affecting curves onto each sampler before it renders.
- **Trigger-source filtering.** A node's `triggerEvents` selects which voices it shapes: `notes`
  affects only pattern-note voices, `clips` only timeline-clip voices, `notesAndClips` both. A
  clip-triggered Envelope never touches notes and vice-versa.
- **Honest limitations.**
  - **Clip release tails are not audible.** Clip audio currently stops at clip end, so the Envelope
    only shapes the clip's active region (attack/hold/decay/sustain); the release segment after the
    gate cannot sound because there is no clip audio past the gate. Pattern-note voices *do* get an
    audible release tail (the Sampler voice continues into its own release).
  - **Mid-note (held-note) audio reconstruction is unchanged.** The pattern-note path is still
    live-trigger-only (`triggerPatternNotes`): seeking into the middle of a held note does not
    re-spawn the voice, so neither the note nor its Envelope is reconstructed mid-note. The Envelope
    reconstruction model (EVC.4b/EVC.5) is ready and tested, but EVC.6 does not add pattern-note
    voice reconstruction — it does not regress the existing behavior. Clip Envelopes *are* mid-clip
    correct because clip activity is position-pure.
  - **Modulated clip reader.** Clips rendered through the vibrato/scratch/stretch modulated reader
    path do not yet apply EVC voiceGain (only the per-sample read path does); the common clip path
    is covered.
- **Tests.** `engine/test/test_envelope_voice_gain.cpp` (pure, model-only) covers the gain
  primitives: trigger-source filtering (notes/clips/both), multiple controllers multiplying,
  `amount` applied exactly once (equals the EVC.4b evaluator level), per-voice independence (no
  shared/combined state), held vs. release levels (position-pure), the per-source settings filter,
  and the full graphState → parse → multiplier path (including unsupported `target.kind` applying no
  gain). `test_envelope_runtime`, `test_envelope_ahdsr`, and `test_envelope_voice_events` still pass;
  `test_sampler` and `test_mix` (full audio engine) still pass, confirming chain-mode / no-envelope
  audio is unchanged.

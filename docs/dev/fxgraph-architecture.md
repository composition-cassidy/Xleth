# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG.4-h-r2.

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

## graphState schema

Version: `GRAPH_STATE_SCHEMA_VERSION = 1` (see `graphState.js`).
Fields: `schemaVersion`, `trackId`, `nodes`, `edges`, `viewport`, plus any extra fields preserved for forward compatibility.

Node types: `trackInput`, `trackOutput`, `effect`, `macro`, `unknown` (load-only fallback).
Edge types: `audio`, `parameter`, `unknown` (load-only fallback).

Port naming convention (mirrors `chainToGraphState.js` lines 189-191):
- `trackInput` output -> `'audio'`
- `effect` input -> `'audioIn'`, output -> `'audioOut'`
- `trackOutput` input -> `'audio'`

## Mutation helpers (FXG.2C-d)

`graphState.js` exports pure mutation helpers:
`addGraphEffectNode`, `removeGraphNode`, `connectGraphNodes`, `disconnectGraphEdge`.

These helpers are topology guards only. They enforce graph invariants (protected nodes, cycles,
duplicate edges, endpoint rules) but do not check `fxMode`. Store actions in
`effectChainStore` are responsible for enforcing `fxMode === "graph"` before calling any mutation
helper.

Protected node types (`PROTECTED_NODE_TYPES`): `trackInput`, `trackOutput`.
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

## Envelope Controller (EVC, per-voice) — audit

See [`fxgraph-envelope-controller-architecture-audit.md`](fxgraph-envelope-controller-architecture-audit.md)
for the EVC.1 foundation audit: the per-voice (not global-parameter) Envelope Controller model,
where timeline clips and pattern notes become playback voices, the existing per-voice AHDSR in
`Sampler`, seek/export reconstruction requirements, the recommended graphState node shape and
engine-side runtime, risk register, and the EVC.2–EVC.8 phase split. EVC output explicitly does
**not** reuse the macro→`GraphParameterTarget`→plugin-parameter path.

### EVC.2 — envelope node graphState schema (inert)

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

### EVC.3 — envelope node UI (visual/editable, still inert)

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

# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG.4-a.

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

Node types: `trackInput`, `trackOutput`, `effect`, `unknown` (load-only fallback).
Edge types: `audio`, `unknown` (load-only fallback).

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

## Graph effect parameter exposure (FXG.4-a)

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
- **UI.** `GraphNodeParameterInspector` is a minimal read-mostly panel: it lists
  parameters for a selected graph-owned effect node and offers a normalized
  slider for writable parameters. Read-only / non-automatable parameters show a
  value with no slider.
- **Still deferred.** No automation lanes, modulation, LFOs, envelopes, peak
  followers, macros, buses, parameter pinning, gestures, sample-accurate
  automation, or generic plugin-editor replacement. Mixer Chain behavior is
  unchanged.

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

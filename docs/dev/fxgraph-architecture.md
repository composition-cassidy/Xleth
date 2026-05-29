# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG.3-c-b.

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
are not mutated.

## Still deferred after FXG.3-c-b

- Parallel fan-out/fan-in execution, branch summing, merge gain, and parallel PDC validation remain
  deferred to FXG.3-d.
- Feedback loops, modulation, buses, graph-to-chain return, parameter pinning, and graph latency UI
  remain deferred.

## Engine execution boundary

Graph cables (`graphState` edges) added via mutation helpers, store actions, or editing UI affect
audio only through the FXG.3-c-b linear sync API. Chain mode and `effectChains` remain untouched.
`AudioGraph` connection sync for nonlinear graphs is still deferred to FXG.3-d.

## Quarantine boundary

`NodeEditor.jsx` is quarantined and must not be imported by any active FX Graph panel.
`nodeGraphStore.js` is unused and must not be imported by any active FX Graph panel.
Both are confirmed excluded by `windowingScaffolding.test.tsx`.

## Runtime architecture (FXG.3+)

See [`fxgraph-runtime-architecture-audit.md`](fxgraph-runtime-architecture-audit.md) for the full
FXG.3-a audit: chain effect ownership, engine effect lifecycle, audio execution model,
graph-owned effect instance proposal, Edit button path, phased engine execution plan, risk
analysis, and recommended implementation sequence.

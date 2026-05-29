# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG.3-b.

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

Port naming convention (mirrors `chainToGraphState.js` lines 189–191):
- `trackInput` output → `'audio'`
- `effect` input → `'audioIn'`, output → `'audioOut'`
- `trackOutput` input → `'audio'`

## Mutation helpers (FXG.2C-d)

`graphState.js` exports pure mutation helpers:
`addGraphEffectNode`, `removeGraphNode`, `connectGraphNodes`, `disconnectGraphEdge`.

These helpers are **topology guards only**. They enforce graph invariants (protected nodes, cycles, duplicate edges, endpoint rules) but do **not** check `fxMode`. Store actions in `effectChainStore` are responsible for enforcing `fxMode === 'graph'` before calling any mutation helper.

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

Every action returns `{ ok: true, graphState, status }` or `{ ok: false, reason }`, where
`reason` is a `GRAPH_MUTATION_REJECTION` code or one of the access codes above. The actions never
touch `effectChains`.

The FX Graph panel (`FxGraphPanel.tsx`) wires these actions to a minimal editing UI in
`GraphStatePreview.tsx` — an "Add Effect Node" button, a per-effect remove button, drag-to-connect
from a node's output handle, and disconnect buttons at audio-edge midpoints. Every affordance is
gated on its callback prop, so the preview stays read-only whenever the panel is not in graph mode.
Rejected mutations surface a non-blocking inline notice via `describeGraphMutationResult`.

## Graph-owned effect instances (FXG.3-b)

Graph effect nodes are now backed by real **graph-owned engine processors**, separate from
`effectChains`. This is "Option A" / "Option 2" from the runtime audit: graph mode owns its
own effect-instance lifecycle; it does not wrap or hide processors inside the linear chain.

Three distinct IDs, never collapsed:

| ID | Type | Scope | Purpose |
|----|------|-------|---------|
| `node.id` | UUID string | graphState | Graph topology identity (edge source/target) |
| `effectInstanceId` | UUID string | persisted with graphState | Stable cross-session effect identity in `node.data.effectInstanceId` |
| `engineNodeId` | integer (APG uid) | per-session | Transient JUCE node id; reused by the existing editor paths as `nodeId` |

Lifecycle:
- **Engine** — `EffectChainManager::addGraphNode/removeGraphNode/getGraphNodeEngineId/hasGraphNode`
  keep an `effectInstanceId → APG uid` map and use the low-level `AudioGraph::addNode/removeNode`
  (never `addEffect/moveEffect`), so graph-owned nodes never touch the linear chain. Nodes are
  created **disconnected** — graphState edges are not yet synced into the engine.
- **MixEngine** — `addGraphEffectNode/removeGraphEffectNode/getGraphEffectEngineNodeId`
  forward per-track and reject the master track (master stays chain-only).
- **Bridge** — `audio_addGraphEffectNode`, `audio_removeGraphEffectNode`,
  `audio_getGraphEffectEngineNodeId` (and the matching `xleth:audio:*` IPC + `window.xleth.audio.*`)
  are separate from the chain APIs and never call chain add/remove internally.
- **Store** — `addGraphEffectNodeForTrack` instantiates a graph-owned processor for a real
  `pluginId` *before* committing graphState (fail-fast; rolls the processor back if the commit
  is rejected). Placeholder/data-only nodes (`pluginId === 'placeholder'`) stay renderer-only.
  `removeGraphNodeForTrack` destroys the engine processor before committing the removal and
  fails fast if engine removal fails. A session-only `graphEngineNodeIds`
  (`{ [key]: { [effectInstanceId]: engineNodeId } }`) cache records what we instantiated; it is
  never persisted and is wiped on project load.

The Edit button on graph effect nodes resolves `node.id → effectInstanceId →
getGraphEffectEngineNodeId → engineNodeId`, then opens the **same** stock/plugin editor path as
Mixer Chain via the shared `effectEditorOpeners.js` helper. The graphState `node.id` is never
passed to an editor store. See [`fxgraph-runtime-architecture-audit.md`](fxgraph-runtime-architecture-audit.md)
section 7.

### Still deferred after FXG.3-b

- **Graph routing execution** — cables (`graphState` edges) still do not affect audio. Graph-owned
  nodes are instantiated but unrouted (silent). Linear/parallel execution is FXG.3-c / FXG.3-d.
- **Serialization round-trip of `effectInstanceId`** — the `effectInstanceId → engineNodeId`
  mapping is **session-only**. `AudioGraph::toJSON` does not yet carry `effectInstanceId`, and
  graph-owned processors are not re-instantiated on project load. This is a required FXG.3-c
  follow-up; until then, graph-owned engine processors do not survive a save/load cycle.
- Connect/disconnect remain graphState-only and never sync edges to the engine.

## Engine execution boundary

Graph cables (`graphState` edges) added via the mutation helpers, store actions, or editing UI
still do **not** affect audio routing. FXG.3-b creates real graph-owned engine processors but
leaves them unrouted; `AudioGraph` connection sync from `graphState` edges is deferred to
FXG.3-c (linear) and FXG.3-d (parallel).

## Quarantine boundary

`NodeEditor.jsx` is quarantined — it must not be imported by any active FX Graph panel.
`nodeGraphStore.js` is unused — it must not be imported by any active FX Graph panel.
Both are confirmed excluded by `windowingScaffolding.test.tsx`.

## Runtime architecture (FXG.3+)

See [`fxgraph-runtime-architecture-audit.md`](fxgraph-runtime-architecture-audit.md)
for the full FXG.3-a audit: chain effect ownership, engine effect lifecycle, audio
execution model, graph-owned effect instance proposal, Edit button path, phased engine
execution plan, risk analysis, and recommended implementation sequence.

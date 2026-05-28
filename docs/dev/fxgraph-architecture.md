# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG.2C-e.

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

## Engine execution boundary

Effect nodes added via the mutation helpers, store actions, or editing UI exist **only in
renderer-side graphState**. No audio engine execution, `AudioGraph` routing, or bridge API
involvement occurs until FXG.3. Engine graph execution is intentionally deferred.

## Quarantine boundary

`NodeEditor.jsx` is quarantined — it must not be imported by any active FX Graph panel.
`nodeGraphStore.js` is unused — it must not be imported by any active FX Graph panel.
Both are confirmed excluded by `windowingScaffolding.test.tsx`.

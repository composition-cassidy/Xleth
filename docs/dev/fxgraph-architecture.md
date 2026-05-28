# FX Graph Architecture

Internal reference for the renderer-side graphState system. Updated through FXG.2C-d.

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

## Engine execution boundary

Effect nodes added via mutation helpers exist **only in renderer-side graphState**.
No audio engine execution, `AudioGraph` routing, or bridge API involvement occurs until FXG.3.
Engine graph execution is intentionally deferred.

## Quarantine boundary

`NodeEditor.jsx` is quarantined — it must not be imported by any active FX Graph panel.
`nodeGraphStore.js` is unused — it must not be imported by any active FX Graph panel.
Both are confirmed excluded by `windowingScaffolding.test.tsx`.

# FX Graph Workspace — Functional Audit (2026-07-27)

Functionality-only pass over the per-track FX Graph mode (Track Input/Output, effect nodes,
Envelope/Macro/Sidechain modulator nodes, audio + modulation edges). **No styling, layout, or
colour findings** — a separate styling pass is planned.

Every finding below was reproduced in the **real running app** (Electron `XLETH_PLAYWRIGHT=1`,
driven over CDP) against `bridge/build/Release/xleth_native.node` built 2026-07-26, not by code
reading alone. The engine's own view was read back through `audio.getGraphTopology(trackId)`,
`audio.getEffectChain(trackId)` and `audio.getGraphEffectParameterValue(...)` after each step.

Repro scenario used throughout: track 2 "FXG Audit", Mixer Chain `Distortion → Delay`, converted
to FX Graph, then edited.

---

## What already works (verified, no action needed)

| Area | Evidence |
|---|---|
| Chain → graph conversion | `fxMode` flips to `graph`, graphState persists, chain processors are *adopted* (settings preserved, no re-instantiation), engine routing unchanged: `in→distortion→delay→out`. |
| Node add | Picker → `addGraphEffectNode` → engine allocates the processor **disconnected** (`chorus(8)` present, no connections) — matches the graph, which shows it unwired. |
| **Reorder** | Rewiring `in→delay→distortion→out` in the UI produced exactly `__input__(1)->delay(7), delay(7)->distortion(6), distortion(6)->__output__(2)` in the engine. Audio order follows the graph. |
| Node removal | Removing mid-path Delay dropped the node **and its incident edges**, destroyed the engine processor (node 7 gone), and failed closed to silence with "Graph output is disconnected." |
| Cycle rejection | `distortion → delay` when `delay → distortion` exists is rejected: "That connection would create a feedback loop." No edge created. |
| Audio into a modulation port | Dragging an audio output onto an exposed parameter port creates **no** edge. Correct. |
| Macro → parameter runtime | Macro 1.0 → `drive` normalized 1.0 (48 dB); 0.25 → 0.25 (3 dB); 0.0 → 0.0. Mapping and scaling are exact. |
| Persistence (topology) | Save + reload restores `fxMode`, all nodes, all audio **and** parameter edges, macro values, the envelope node, processor states, and re-resolves `effectInstanceId → engineNodeId` after the engine reassigns node ids (3,4,5 → 6,7,8 → 9). |
| Bridge surface | All 13 graph RPCs are present end-to-end (addon → worker → main → preload → renderer) and were each exercised live. No `notImplemented` swallowing. |
| Chain editing lock | In graph mode the Mixer Chain rack is replaced by the graph shell; there is no user path to chain-edit a graph-owned track. |

---

## Findings

### F1 — CRITICAL: any number of modulation sources can silently drive the same parameter

`canConnectMacroToParameter` and `canConnectEnvelopeToParameter`
(`ui/src/fxgraph/graphState.js`) de-duplicate only on the triple
`(sourceNodeId, targetNodeId, targetPort)`. A *different* source hitting the same port passes.

Reproduced: two Macro nodes **and** an Envelope node were all linked to
`gpp:<distortionNode>:drive`, with no rejection and no warning:

```
parameter 18bf4c->ff6ad5   (Macro 1  -> drive)
parameter 337a93->ff6ad5   (Macro 2  -> drive)
parameter 4161e0->ff6ad5   (Envelope -> drive)
```

The engine has no guard either: `buildEnvelopeModulationSnapshot`
(`engine/src/model/EnvelopeParameterModulation.cpp:780`) allocates **one mailbox per edge** with no
target de-duplication.

This is not theoretical. **It already destroys saved parameter values on reload.** With Macro 1 at
0.75 and Macro 2 at 0.0 both bound to `drive`:

```
beforeSave : drive normalized = 0.75
afterReload: drive normalized = 0     ← Macro 1's value silently lost
```

Cause: project-load hydration calls `driveAllMacroParameterEdges`
(`ui/src/stores/effectChainStore.js:1423`), which walks macros in `graphState.nodes` order and
writes each one's value to its targets. Macro 1 writes 0.75, then Macro 2 overwrites it with 0.0.
Which source wins is an artefact of node array order — invisible to the user, and the losing
macro's slider still reads 75%.

Macro and Envelope are also semantically incompatible on one target: a Macro *replaces* the value
(the knob position **is** the parameter), while an Envelope is `clamp(base + depth * env)` around
an authored `base` the Macro is continuously overwriting.

**Fix:** reject a second driver on an already-driven parameter port, in both connect validators,
with a distinct rejection reason surfaced in the panel.

---

### F2 — HIGH: graph edits bypass the global UndoManager and silently undo unrelated work

Graph mutations persist through `timeline_setTrackGraphState`, which is one of the two deliberately
**non-undo-tracked** timeline setters (`engine/src/XlethEngineService.cpp:7484`). FX Graph undo is a
separate, session-only, per-track snapshot stack in `effectChainStore.graphHistories`.

Consequence, reproduced live:

```
1. timeline.addTrack({name:'UndoProbe'})  -> track 3 created
2. FX Graph: Add Macro                    -> 3rd macro node added
3. window.xleth.undo.undo()               -> returns true
   => track 3 is GONE
   => the macro node is still there
   => canUndo() now false
```

The user's most recent action was the graph edit. Global Ctrl+Z reported success, left the graph
edit untouched, and destroyed an unrelated earlier edit instead. Any timeline work done before a
graph edit is one keystroke away from being silently rolled back.

Secondary effects of the same root cause:
- `graphHistories` is wiped by `hydrateFxModesFromTracks` and on `project-loaded`
  (`effectChainStore.js:1402`, `:2890`), so after opening a project the FX Graph toolbar's
  Undo/Redo are **both disabled** with no history — which is what "Undo/Redo appears disabled"
  looks like in practice. They enable correctly after the first edit in the session.
- `setFxMode` deletes that track's history entirely (`:1448`).
- Graph edits do not mark the project dirty through the normal path.

**Fix:** make `timeline_setTrackGraphState` (and `setTrackFxMode`) go through `UndoManager` as a
real `Command`, so graph edits take their proper place in the global stack.

---

### F3 — MEDIUM: undoing a modulation link does not restore the parameter it overwrote

`connectMacroToParameterForTrack` drives the new link from the macro's current value immediately
after linking (`effectChainStore.js:2216`). Linking a macro whose knob is at 0 therefore writes 0
over whatever the parameter was authored to.

Undo restores the **edge**, not the **value**:

```
drive before linking : 12.0 dB
after linking macro@0: 0.0 dB
after graph Undo     : 0.0 dB   ← edge removed, authored value not restored
```

The graph undo transaction snapshots `graphState` only, and normalized parameter values are
deliberately never persisted in graphState — so the pre-link value is not captured anywhere.

**Fix:** capture the target's live normalized value in the undo transaction for macro-link
connect/disconnect, and restore it when the transaction is reversed.

---

### F4 — LOW: graph-owned effects leak into the track's linear chain view

`EffectChainManager::addGraphNode` uses the low-level `AudioGraph::addNode`, but `getChainState()`
enumerates the same `nodes_` map the chain uses. For a graph-owned track:

```
audio.getEffectChain(2) -> [
  { nodeId: 6, pluginId: 'distortion', position: 2 },
  { nodeId: 8, pluginId: 'chorus',     position: 3 }   ← graph-only node, never in the chain
]
```

`position` is meaningless here (2 and 3 for a two-slot chain) because it is derived from
`linearOrder_`, which graph mode rewrites via `replaceConnectionsWithGraph`.

Not user-visible today: the Mixer Chain rack is replaced by the graph shell in graph mode, and
`fetchChain` results are only rendered in chain mode. It is a desync trap for any future code that
reads `getEffectChain` without checking `fxMode` — e.g. `AudioGraph::addEffect` splices new
connections using `linearOrder_`, which would clobber graph routing if it were ever reachable.

**No code change proposed in this pass** — the correct fix is to make `getChainState()` fxMode-aware
in the engine, which touches chain mode. Recorded so it is not rediscovered as a mystery.

---

### F5 — INFO: there is no graph → chain ownership-revert path

`setFxMode` is never called from any UI surface; the only writer of `fxMode: 'graph'` is
`convertChainToGraphMode`, and nothing writes it back to `'chain'`. Ownership is therefore
one-way per track for the lifetime of the project.

Auditing "what happens when ownership reverts" has no runtime answer today. If a revert is added
later it must, at minimum: rebuild the chain route (`AudioGraph` currently has no
`rebuildChainRouting`), release the graph-owned `graphNodeIds_` entries without destroying adopted
chain processors, and clear `graphRuntimeStatuses` — none of which exists. Flipping `fxMode` alone
would leave the engine in the graph's fail-closed connection state with the chain UI unlocked.

---

## Fix order and status

| # | Fix | Commit | Runtime verification |
|---|---|---|---|
| F1 | One modulation driver per parameter port; existing corrupt graphs repaired on load and the repair written back to the engine | `8a44e7b` | Second Macro and Envelope both refused with "That parameter is already driven."; corrupt project loads with one edge on **both** sides; `drive` survives save/reload at 0.75 where it previously came back 0. |
| F2 | `timeline_setTrackGraphState` / `setTrackFxMode` undo-tracked; `undoable` opt-out for camera and repair writes; renderer resync after a global undo | `31c0656` | Undo description becomes "Edit FX Graph (Track 2)"; trusted Ctrl+Z removes the macro on both sides (engine 9→8 nodes, panel 9→8) and leaves the unrelated track alone; Ctrl+Y restores it; Fit View / Reset View add no undo entries. |
| F2a | Canonical (key-order-insensitive) graph comparison in the resync | `573733b` | Found while verifying F3: nlohmann sorts object keys, so the resync fired on every track fetch and wiped graph history. After the fix, the panel Undo still reverts an Envelope add across three forced track fetches. |
| F3 | Modulation-link undo restores the value it overwrote; undo/redo re-drive live macro edges | `81c035f` | Authored 0.80 → link macro at 0.75 → 0.75 → Undo → 0.80 with the edge removed → Redo → 0.75 with the edge back. |

F4 and F5 are recorded, not fixed, in this pass.

Consolidated regression pass on the final build (all in the running app): reorder still drives
engine order (`in→distortion→chorus→out`), cycles still rejected, one-driver-per-port enforced with
the tokenized notice, global undo description still reflects the graph edit.

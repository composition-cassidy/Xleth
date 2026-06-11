# FX Graph Sidechain Input Architecture Audit

Read-only audit for future implementation prompts 6B, 6C, and 6D. This document does not change
runtime behavior, graphState schema, UI, native APIs, bridge APIs, or tests.

> **6B status — implemented (renderer/schema/UI contract only).** The graphState schema, store
> actions, and FX Graph UI contract below are now live. 6B added the `sidechainInput` node type,
> the distinct `sidechain` edge type, the protected-node rule, the source selector, the
> compressor-only `sidechainIn` port, and connection/disconnection handling. Audio runtime ignores
> all sidechain intent. **No native route binding, no `sc_external` write, and no runtime ducking
> exist yet — that remains 6C.** See the "6B Implementation Status" section at the end of this doc
> for the exact files, exports, and behavior delivered.

Binding rule: FX Graph Sidechain Input must reuse the existing silent sidechain route/key transport
system. Do not create a second sidechain engine.

Intended user flow:

```txt
Source track
-> silent sidechain route
-> FX Graph Sidechain Input node
-> sidechain edge
-> graph-owned compressor sidechain input
-> compressor ducks
```

The Sidechain Input is a compressor key jack. It is not an audible send, bus, Master duplicate, or
second mixer path.

## Source Files Inspected

Primary docs:

- `docs/dev/fxgraph-architecture.md`
- `docs/dev/fxgraph-runtime-architecture-audit.md`
- `docs/dev/fxgraph-envelope-controller-architecture-audit.md`
- `docs/dev/mixer-routing-sidechain-architecture-audit.md`

Renderer/graph:

- `ui/src/fxgraph/graphState.js`
- `ui/src/fxgraph/graphState.test.js`
- `ui/src/fxgraph/graphParameterTarget.js`
- `ui/src/fxgraph/linearGraphTopology.js`
- `ui/src/stores/effectChainStore.js`
- `ui/src/stores/effectChainStore.test.js`
- `ui/src/windowing/panels/FxGraphPanel.tsx`
- `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx`
- `ui/src/windowing/panels/fxgraph/GraphStatePreview.test.tsx`
- `ui/src/windowing/components/windowing.css`
- `ui/src/windowing/__tests__/windowingScaffolding.test.tsx`

Mixer/sidechain UI:

- `ui/src/stores/mixerStore.js`
- `ui/src/components/mixer/EffectModule.jsx`
- `ui/src/components/mixer/__tests__/EffectModule.sidechain.test.jsx`

Bridge/Electron:

- `ui/main.js`
- `ui/preload.js`
- `bridge/src/XlethAddon.cpp`

Engine:

- `engine/src/audio/TrackRouting.h`
- `engine/src/audio/TrackRouting.cpp`
- `engine/src/audio/MixEngine.h`
- `engine/src/audio/MixEngine.cpp`
- `engine/src/audio/AudioGraph.h`
- `engine/src/audio/AudioGraph.cpp`
- `engine/src/audio/EffectChainManager.h`
- `engine/src/audio/EffectChainManager.cpp`
- `engine/src/audio/SidechainSourceProcessor.h`
- `engine/src/audio/XlethCompressorEffect.h`
- `engine/src/AudioEngine.cpp`
- `engine/src/model/TimelineTypes.h`
- `engine/src/model/Track.cpp`
- `engine/src/model/Timeline.h`
- `engine/src/model/Timeline.cpp`
- `engine/src/commands/TimelineCommands.h`
- `engine/src/commands/TimelineCommands.cpp`

Tests:

- `engine/test/test_stock_compressor_sidechain.cpp`
- `engine/test/test_sidechain_runtime.cpp`
- `engine/test/test_sidechain_routes.cpp`
- `engine/test/test_chain_effect_identity.cpp`
- `ui/src/stores/effectChainStore.test.js`
- `ui/src/windowing/panels/fxgraph/GraphStatePreview.test.tsx`

## 1. Current FX Graph graphState Model

### Ownership

- `TrackInfo.fxMode` is the persistent ownership gate: `chain` is default, `graph` is optional.
- Master is chain-only.
- `graphState` is renderer-owned, persisted opaquely on `TrackInfo.graphState`.
- `effectChains` are separate Mixer Chain data. FX Graph code must not mutate `effectChains`.
- In `effectChainStore.js`, `readGraphStateForMutation()` rejects master, missing tracks, chain-mode
  tracks, and missing graphState before any graph mutation.

### Schema

`ui/src/fxgraph/graphState.js` defines:

- `GRAPH_STATE_SCHEMA_VERSION = 1`
- Node types in `NODE_TYPES`:
  - `trackInput`
  - `trackOutput`
  - `effect`
  - `macro`
  - `envelope`
  - unknown node types load as `type: 'unknown'` with preserved data
- Edge types in `EDGE_TYPES`:
  - `audio`
  - `parameter`
  - unknown edge types load as `type: 'unknown'` with preserved type

Persisted top-level fields:

- `schemaVersion`
- `trackId`
- `nodes`
- `edges`
- `viewport`
- `macroAutomationLanes`
- unknown extra top-level fields are preserved by the current additive model where possible

Renderer/session-only fields:

- `effectChainStore.graphEngineNodeIds`: `{ [trackId]: { [effectInstanceId]: engineNodeId } }`
- `effectChainStore.graphRuntimeStatuses`
- `effectChainStore.graphHistories`
- `effectChainStore.macroAutomationLastValues`
- module-local envelope runtime cache in `effectChainStore.js`

Runtime/session-only engine identifiers:

- JUCE/APG engine node IDs are transient and must not be persisted in graphState.
- Graph persisted identity is `node.id` plus, for effect nodes, `node.data.effectInstanceId`.

### Protected Nodes

`PROTECTED_NODE_TYPES = ['trackInput', 'trackOutput']`.

`isProtectedGraphNodeType()` and `canRemoveGraphNode()` prevent removing Track Input and Track
Output. Future Sidechain Input should either become protected when present, or be made mandatory
for graph sidechain mode and protected by the same helper.

### Audio Edges

Current audio port convention:

- `trackInput` output: `audio`
- `effect` input: `audioIn`
- `effect` output: `audioOut`
- `trackOutput` input: `audio`

`connectGraphNodes()` only creates `audio` edges. It rejects non-audio `edgeType`, missing nodes,
self connections, duplicate edges, cycles, Track Output as source, Track Input as target, unknown
nodes, and Macro/Envelope audio participation.

`normalizeEdge()` drops audio edges touching Macro or Envelope nodes. It validates edge references
and preserves unknown future edge types as unknown.

### Parameter Edges, Macro, and Envelope

`parameter` edges are separate from audio topology:

- Macro source: `GRAPH_MACRO_NODE_TYPE = 'macro'`, output port `controlOut`.
- Envelope source: `GRAPH_ENVELOPE_NODE_TYPE = 'envelope'`, output port `controlOut`.
- Parameter target: effect node exposed parameter port, represented by
  `GraphParameterTarget` from `ui/src/fxgraph/graphParameterTarget.js`.

`canConnectMacroToParameter()` and `canConnectEnvelopeToParameter()` require:

- source is the correct control node type
- target is an effect node, not protected Track I/O
- target effect has a non-empty `effectInstanceId`
- target parameter is exposed in `node.data.exposedParameterPorts`
- target parameter is writable and automatable
- no duplicate parameter edge from that source to that target port

Parameter edges never enter `buildLinearGraphTopologyPayload()` as audio topology. Macro and
Envelope runtime drive is renderer/control-rate via `setGraphEffectParameterNormalized()`, not
engine audio wiring.

### Graph-Owned Effect Node Shape

Effect node data is validated in `validateEffectNodeData()`:

```js
{
  effectInstanceId: string,
  pluginId: string,
  displayName: string,
  bypass: boolean,
  missing: boolean,
  crashed: boolean,
  sourceChainSlotIndex: number | null,
  exposedParameterPorts: [...]
}
```

`effectInstanceId` lives at `node.data.effectInstanceId`. It is stable and persisted with
graphState. `engineNodeId` lives only in session/runtime maps.

## 2. Current FX Graph Runtime Execution

### Renderer to Runtime

Current sync path:

```txt
effectChainStore.syncGraphRuntimeForTrack()
-> buildLinearGraphTopologyPayload(graphState)
-> window.xleth.audio.syncGraphTopology(trackId, payload)
-> ui/preload.js audio.syncGraphTopology
-> ui/main.js xleth:audio:syncGraphTopology
-> bridge/src/XlethAddon.cpp Audio_SyncGraphTopology
-> MixEngine::syncGraphTopology(trackId, topology)
-> EffectChainManager::syncGraphTopology(topology)
-> AudioGraph::replaceConnectionsWithGraph(...)
```

Despite the helper name `buildLinearGraphTopologyPayload`, current engine sync is FXG.3-d and
supports linear and parallel/fan-in/fan-out DAG audio paths. The payload builder:

- filters out control nodes (`macro`, `envelope`)
- sends `trackInput`, `trackOutput`, `effect`, and `unknown`
- sends only `edge.type === 'audio'`
- includes `effectInstanceId`, `pluginId`, `missing`, and display name for effect nodes

`analyzeLinearGraphTopologyPayload()` still exists for linear analysis and returns
`nonlinear_deferred` for fan-in/fan-out, but the active runtime sync in
`EffectChainManager::syncGraphTopology()` now applies general DAG connections.

### Unsupported Graphs

`EffectChainManager::syncGraphTopology()` is fail-closed:

- invalid payload, invalid references, cycles, unsupported active node types, placeholder/missing
  active effects, or missing `effectInstanceId` mapping -> `clearConnectionsToSilence()`
- no complete Track Input -> Track Output path -> ok `graph_output_disconnected` and silence
- valid Track Input -> Track Output path with no effects -> passthrough
- valid effect path -> linear or parallel graph routing

Graph-owned processors are not removed when routing fails. `graphState` is not rolled back by a
runtime sync failure.

### Graph-Owned Effect Hydration

Project load path:

- `effectChainStore.hydrateFxModesFromTracks()` loads track `fxMode` and `graphState`, then clears
  transient graph maps/history.
- `hydrateGraphEffectInstancesForLoadedProject()` scans only normal tracks in graph mode.
- `buildGraphEffectNodeHydrationPayload()` sends effect node metadata to
  `audio.hydrateGraphEffectNodes`.
- `MixEngine::hydrateGraphEffectNodes()` creates graph-owned processors with
  `EffectChainManager::hydrateGraphNodes()`.
- `EffectChainManager::addGraphNode()` maps stable `effectInstanceId` to transient APG node ID.
- Renderer merges the returned `effectInstanceId -> engineNodeId` mapping into
  `graphEngineNodeIds`.
- Then `syncGraphRuntimeForTrack()` applies graph routing.

`EffectChainManager::getNodeIdForEffectInstance()` is unified for chain and graph:

- graph-owned IDs resolve through `graphNodeIds_`
- chain-mode IDs resolve from `AudioGraph` node metadata
- returned APG IDs are transient and never persisted

### Existing Graph APIs

Bridge/main/preload graph-owned effect APIs:

- `audio_addGraphEffectNode`
- `audio_removeGraphEffectNode`
- `audio_getGraphEffectEngineNodeId`
- `audio_hydrateGraphEffectNodes`
- `audio_adoptGraphEffectNodes`
- `audio_syncGraphTopology`
- graph effect parameter APIs:
  - `getGraphEffectParameters`
  - `getGraphEffectParameterValue`
  - `setGraphEffectParameterNormalized`

Engine entry points:

- `MixEngine::addGraphEffectNode()`
- `MixEngine::removeGraphEffectNode()`
- `MixEngine::getGraphEffectEngineNodeId()`
- `MixEngine::hydrateGraphEffectNodes()`
- `MixEngine::syncGraphTopology()`
- `EffectChainManager::addGraphNode()`
- `EffectChainManager::removeGraphNode()`
- `EffectChainManager::syncGraphTopology()`

## 3. Current Sidechain Route System

### Persistent Schema

`engine/src/model/TimelineTypes.h`:

```cpp
struct SidechainRoute {
    std::string routeId;
    int         targetTrackId = -1;
    std::string targetEffectInstanceId;
    float       gain = 1.0f;
    bool        preFader = false;
    bool        enabled = true;
};
```

Routes are owned by the source track:

- persisted at `TrackInfo.sidechainRoutes`
- serialized in `Track.cpp::to_json()`
- loaded/sanitized in `Track.cpp::from_json()`

Target fields:

- `targetTrackId`: target track receiving the key
- `targetEffectInstanceId`: stable instance ID of target effect

Important current limitation: empty `targetEffectInstanceId` is rejected and dropped by load
sanitization. Track-level/graph-input targets were explicitly deferred. Therefore v1 FX Graph
Sidechain Input should not try to target the Sidechain Input node at the native route layer. It
should target the connected graph-owned compressor/effect `effectInstanceId`.

### Validation

`TrackRouting.h/cpp`:

- `validateSidechainRoute(timeline, sourceTrackId, route, resolver)`
- `SidechainEffectResolver` checks whether `(targetTrackId, targetEffectInstanceId)` resolves
- `clampSidechainGain()`

Validation rejects:

- master as source
- unknown source
- master as target
- self sidechain
- unknown target
- empty `targetEffectInstanceId`
- non-finite gain
- duplicate route ID on the source track
- unresolved target effect instance when resolver is supplied
- output-route plus sidechain-route cycles

Stale behavior:

- structurally valid routes with missing target tracks/effects survive load
- `timeline_getRouting()` reports `status`:
  - `ok`
  - `stale_target_track`
  - `stale_effect_instance`
  - `invalid`
- stale routes do not produce DSP key because `MixEngine::processBlock()` cannot resolve the
  target effect instance

### Undo, Save, Load

Undo commands:

- `AddSidechainRouteCommand`
- `RemoveSidechainRouteCommand`
- `SetSidechainRouteParamsCommand`

Timeline mutations:

- `Timeline::addSidechainRoute()`
- `Timeline::removeSidechainRoute()`
- `Timeline::setSidechainRouteParams()`
- `Timeline::getSidechainRoutes()`

Bridge route mutations are undo-tracked and call `AudioEngine::refreshLivePresentationLatency()`.
That refresh calls `MixEngine::syncSidechainTargetBuses()`, so target compressor buses are updated
after route changes.

### Bridge, Preload, Main APIs

Renderer-facing APIs already exist:

- `window.xleth.timeline.getRouting()`
- `window.xleth.timeline.addSidechainRoute(sourceTrackId, routePayload)`
- `window.xleth.timeline.removeSidechainRoute(sourceTrackId, routeId)`
- `window.xleth.timeline.setSidechainRouteParams(sourceTrackId, routeId, params)`

Main handlers:

- `xleth:timeline:getRouting`
- `xleth:timeline:addSidechainRoute`
- `xleth:timeline:removeSidechainRoute`
- `xleth:timeline:setSidechainRouteParams`

Bridge handlers:

- `Timeline_GetRouting`
- `Timeline_AddSidechainRoute`
- `Timeline_RemoveSidechainRoute`
- `Timeline_SetSidechainRouteParams`

### Runtime Silent Key Transport

Runtime path:

```txt
TrackInfo.sidechainRoutes on source tracks
-> MixEngine::processBlock()
-> buildSidechainPlan()
-> sidechainBuffers_[targetSlot]
-> EffectChainManager::setSidechainKeyBuffer()
-> AudioGraph::setSidechainKey()
-> SidechainSourceProcessor
-> target effect input bus 1
```

Important files/functions:

- `TrackRouting.h/cpp`: `SidechainPlan`, `SidechainTapInput`, `buildSidechainPlan()`
- `MixEngine.h/cpp`: `sidechainBuffers_`, per-block sidechain tap resolution, key accumulation,
  `feedsSidechainOnly`
- `EffectChainManager::setSidechainKeyBuffer()` / `clearSidechainKeyBuffer()`
- `AudioGraph::rebuildSidechainInfrastructure()`
- `AudioGraph::setSidechainKey()` / `clearSidechainKey()`
- `SidechainSourceProcessor`

The key is silent by design:

- accumulated only into `sidechainBuffers_`
- handed only to the target chain sidechain source node
- never added to `trackBuffers_`, output buses, or Master
- sidechain-only sources can be processed for key under solo without becoming audible

### Target Bus Sync and Stock Compressor Consumption

`MixEngine::syncSidechainTargetBuses()` groups enabled routes by target track and
`targetEffectInstanceId`, then calls:

```txt
EffectChainManager::applySidechainTargetInstances()
-> AudioGraph::applySidechainTargetInstances()
-> XlethEffectBase::setSidechainInputEnabled()
-> AudioGraph::rebuildImmediate()
-> AudioGraph::rebuildSidechainInfrastructure()
```

`XlethCompressorEffect`:

- is the only current stock external-sidechain-capable effect
- declares optional stereo input bus 1 named Sidechain
- default bus disabled
- `supportsExternalSidechain()` returns true
- `sc_external` parameter:
  - `0`: internal detector, legacy behavior
  - `1`: external detector
- with `sc_external=1` and no key bus/key, detector uses silence, not the main input
- main bus processing uses `getBusBuffer(buffer, true, 0)`, so key channels never become output

Already proven manually:

- chain-mode stock compressor UI can create route by `effectInstanceId`
- route reaches the live compressor bus after rebuilding `bridge/build/Release/xleth_native.node`
- Bass ducks under Kick key
- Kick does not leak into output
- disabling/removing route stops ducking
- stale native addon was the root cause of the previous false failure

Process rule: after any engine/bridge C++ change, close the app/worker and run:

```bat
cd bridge
npx cmake-js compile
```

Engine tests passing does not prove Electron is using current engine code. The app loads
`bridge/build/Release/xleth_native.node`.

## 4. Safe Design for FX Graph Sidechain Input

Recommended v1 model:

- Add protected graph node type `sidechainInput`.
- It represents the selected graph track's incoming silent sidechain key source.
- It is not an effect processor.
- It is not audible.
- It does not own an `effectInstanceId`.
- It does not appear in Mixer Chain.
- It is graphState/user-intent only; runtime key transport remains existing `SidechainRoute`.
- It has one output port for sidechain/control-key audio, e.g. `sidechainOut`.
- It connects only to sidechain-capable effect sidechain input ports, e.g. `sidechainIn`.
- It must not connect to Track Output, regular `audioIn`, Macro/Envelope/control ports, or
  parameter ports.

Recommended persisted node data:

```js
{
  label: 'Sidechain Input',
  sourceTrackId: number | null
}
```

Optional non-persisted/display-only derived state:

- source track name
- source stale/missing warning
- route sync status
- target capability warning

Do not persist raw engine node IDs. Do not persist route APG IDs. Prefer not to persist route IDs
inside graphState; derive/remove existing `SidechainRoute` records by tuple from routing snapshots:

```txt
sourceTrackId + targetTrackId + targetEffectInstanceId
```

If 6C discovers that tuple diffing is ambiguous, add an additive `SidechainRoute` owner metadata
field in the native model rather than creating a new sidechain engine. Do not do that in 6B.

## 5. Edge Model Options

### Option A: Distinct Edge Kind

Add graphState edge kind:

```js
{
  type: 'sidechain',
  sourceNodeId: sidechainInputNodeId,
  sourcePort: 'sidechainOut',
  targetNodeId: effectNodeId,
  targetPort: 'sidechainIn'
}
```

Runtime binding:

- source track comes from `sidechainInput.data.sourceTrackId`
- target track is graphState owning track
- target effect comes from target effect node `data.effectInstanceId`
- store/native sync creates/removes existing `SidechainRoute` records

Pros:

- Clear semantic separation from audible audio edges.
- Existing `buildLinearGraphTopologyPayload()` can ignore `sidechain` edges unless 6C explicitly
  adds a sidechain sync pass.
- Existing audio cycle handling remains focused on audible graph edges.
- The UI can style/validate sidechain cables differently.
- It prevents accidental Track Input -> Track Output style runtime wiring.

Cons:

- Requires adding `sidechain` to `EDGE_TYPES`.
- Requires new pure helpers for sidechain edge validation/disconnect.
- Requires preview rendering updates for a third edge kind.

### Option B: Reuse Audio Edges With Typed Ports

Keep `type: 'audio'`, but use:

```js
sourcePort: 'sidechainOut'
targetPort: 'sidechainIn'
```

Runtime distinguishes sidechain by ports.

Pros:

- Smaller schema surface.
- Reuses some existing drag/edge rendering code.

Cons:

- High risk of sidechain key entering audible topology because current audio sync collects
  `edge.type === 'audio'`.
- Existing cycle/path analysis would treat sidechain edges as audible audio graph edges unless
  every helper learns port types at the same time.
- More likely to complicate Track Output and regular effect audio port rules.
- Makes it harder to explain in tests and docs that sidechain is not audio output routing.

### Recommendation

Use Option A: a distinct `sidechain` edge kind.

Reason: this project already separates `audio` and `parameter` edges. Sidechain is neither normal
audible audio topology nor parameter modulation. A distinct edge kind keeps the existing audio graph
sync safe by default and forces 6C to opt in to route binding explicitly.

Do not implement Option A in this 6A audit.

## 6. Source-Track Selection Model

Questions answered:

- Does the source come from a sidechain route created outside the graph?
  - Recommended no. graphState should be the user-facing intent; routes are runtime/persistent
    transport records derived from that intent.
- Does the Sidechain Input node contain `sourceTrackId`?
  - Recommended yes.
- Does the graph panel provide a source selector?
  - Recommended yes, on the Sidechain Input node body.
- Does each sidechain edge create a route from that source to the target effect?
  - Recommended yes in 6C, using existing `timeline.addSidechainRoute()`.
- How are stale source tracks represented?
  - Preserve `sourceTrackId` in graphState, show missing/stale warning, do not create a route until
    the source exists and is valid.
- How should save/load behave?
  - graphState persists `sidechainInput.data.sourceTrackId` and `sidechain` edges.
  - On load, after graph effect hydration, route sync reconciles existing `SidechainRoute` records
    to graphState intent.
- How should undo work?
  - 6B renderer graph edits should use existing graph history.
  - 6C route sync must avoid leaving native undo and graph history fighting each other. Prefer a
    dedicated graph-sidechain sync action that performs graphState commit plus route reconciliation
    as one user action from the renderer perspective.

Recommended v1:

- one Sidechain Input node per graph track
- one selected source track per Sidechain Input node
- one source can feed one or more sidechain-capable graph-owned effect nodes through multiple
  `sidechain` edges
- multi-source per graph track is deferred
- Sidechain Input cannot source regular audio, parameter, Macro, or Envelope edges

Use `mixerStore.getEligibleSidechainSources(targetTrackId)` as the starting selector logic. It
already excludes self, visual-only/non-audio tracks, invalid targets, and output+sidechain cycles.
For 6B, if route state is not available, mirror this logic locally and let the backend remain final.

## 7. Runtime Binding Plan for 6C

For each graph sidechain edge:

1. Find source node:
   - `node.type === 'sidechainInput'`
   - `node.data.sourceTrackId` is a finite normal track ID
2. Find target node:
   - `node.type === 'effect'`
   - sidechain edge target port is `sidechainIn`
   - target node has non-empty `data.effectInstanceId`
3. Derive desired route:
   - source track: Sidechain Input `sourceTrackId`
   - target track: graph owning track (`graphState.trackId`)
   - target effect: target effect node `data.effectInstanceId`
   - gain: `1.0`
   - preFader: `false`
   - enabled: `true`
4. Reconcile against existing `window.xleth.timeline.getRouting()` snapshot:
   - create missing desired routes with `addSidechainRoute(sourceTrackId, payload)`
   - remove no-longer-desired graph routes with `removeSidechainRoute(sourceTrackId, routeId)`
   - leave unrelated non-graph routes alone
5. Run/trigger the existing live refresh path so `MixEngine::syncSidechainTargetBuses()` enables
   the compressor bus and `SidechainSourceProcessor` wiring.

Do not:

- create a new per-graph sidechain buffer
- directly wire arbitrary graph sidechain audio into JUCE APG
- route Sidechain Input to Track Output
- put the key in `trackBuffers_`
- use raw APG node IDs in graphState

Compressor `sc_external`:

- The route only delivers key audio; the stock compressor ducks from it only when `sc_external=1`.
- 6C should use existing graph effect parameter APIs to set
  `setGraphEffectParameterNormalized(trackId, effectInstanceId, 'sc_external', 1)` when a graph
  sidechain edge targets a stock compressor.
- On removal of the last sidechain edge targeting that compressor, 6C should decide explicitly:
  - preferred v1: if FX Graph sidechain UI owns the external-key state, set `sc_external=0`;
  - alternative: leave `sc_external` as user parameter state and rely on no route -> no key -> no
    ducking, but warn that the compressor is still in external detector mode.
- This must use the existing parameter system. No `StockParameterCatalog` work.

Route ownership/deduplication:

- Existing route IDs are generated by native bridge; graphState should not invent them.
- Existing backend duplicate validation only checks duplicate `routeId`, not duplicate target tuple.
- 6C should prevent duplicate graph sidechain routes in renderer/store tests.
- If ambiguity appears in real project data, add additive route-owner metadata later. Do not solve it
  with a second sidechain DSP path.

## 8. Capability Detection

Current available facts:

- Stock compressor `pluginId === 'compressor'` supports external sidechain.
- It has `sc_external` APVTS parameter.
- `XlethCompressorEffect::supportsExternalSidechain()` returns true engine-side.
- `AudioGraph::applySidechainTargetInstances()` only enables buses for
  `XlethEffectBase::supportsExternalSidechain()`.
- No VST sidechain bus probing/enabling exists.
- No generic renderer capability API currently exposes `supportsExternalSidechain`.

Recommended 6B capability rule:

- Show/connect `sidechainIn` only for graph effect nodes where:
  - `node.type === 'effect'`
  - `node.data.pluginId === 'compressor'`
  - `node.data.effectInstanceId` is non-empty
  - node is not missing/crashed/placeholder
- Do not show `sidechainIn` on VSTs or other stock effects.

Recommended 6C native verification:

- Existing route resolver proves the effect instance exists, not that it is sidechain-capable.
- For v1, renderer static capability plus stock compressor engine tests are enough.
- If generic capability is needed, add a read-only graph effect capability descriptor later. It must
  query existing processor capability and must not enable VST sidechain.

Unsupported connection attempts should fail cleanly with readable copy:

- "This effect has no sidechain input."
- "Select a source track first."
- "Target effect is not active yet."
- "Source track no longer exists."
- "Would create feedback loop."

## 9. UI/UX Plan

Sidechain Input node:

- Protected node style, visually related to Track Input but clearly a key input.
- Label: `Sidechain Input`
- Secondary/status text:
  - `No source`
  - `Keyed by: <track name>`
  - `Source missing`
  - `Route stale`
- Source selector inside the node body.
- One output handle/port: `sidechainOut`.
- No audio input handle.
- No parameter ports.
- No edit button.
- Remove button hidden if protected.

Effect sidechain port:

- For stock compressor graph nodes only, show a sidechain input port `sidechainIn`.
- The sidechain port should be visually distinct from normal `audioIn` and parameter ports.
- It should accept only `sidechainInput.sidechainOut`.
- It should not accept Track Input, effect audio out, Macro, Envelope, or exposed parameter links.

Connection feedback:

- Dragging from Sidechain Input highlights only valid sidechain-capable target ports.
- Dropping on invalid nodes no-ops with a clear notice.
- Existing audio drag behavior must remain unchanged.
- Existing Macro/Envelope parameter drag behavior must remain unchanged.

DAW feel:

- This should feel like plugging a compressor key input.
- It should not look or read like sends, buses, output routing, or master routing.
- Do not add production-color hardcoding. Use existing CSS tokens/classes.
- Do not revive NodeEditor, nodeGraphStore, or React Flow.

Save/load display:

- If source track is missing, keep showing the saved source ID/status rather than deleting the node.
- If target compressor is missing, keep the edge but mark the target unavailable/stale.
- Route sync should fail safely; graphState should remain intact.

## 10. Test Plan for Future Prompts

### Renderer graphState Tests

Add to `ui/src/fxgraph/graphState.test.js`:

- `sidechainInput` normalizes with default data.
- `sidechainInput.data.sourceTrackId` preserves valid track IDs and repairs malformed data.
- `sidechainInput` is protected when v1 contract requires it.
- Removing Sidechain Input is rejected when protected.
- `sidechain` edge normalizes/preserves source/target ports.
- `sidechain` edge rejects:
  - target Track Output
  - target regular `audioIn`
  - source Track Input/effect/Macro/Envelope
  - target Macro/Envelope/parameter port
  - target effect without `effectInstanceId`
  - unsupported effect plugin IDs
- Duplicate sidechain edges to the same target are rejected or intentionally deduped.
- Save/load normalization keeps stale/missing `sourceTrackId`.
- Audio topology payload ignores `sidechain` edges.
- Parameter edge helpers ignore `sidechain` edges.
- No graphState pollution of Mixer Chain/effectChains.

### Renderer Store Tests

Add to `ui/src/stores/effectChainStore.test.js`:

- add/update Sidechain Input source only in graph mode.
- connect/remove sidechain edge only in graph mode.
- master/chain-mode/missing graphState reject.
- graph undo/redo restores Sidechain Input source and sidechain edges.
- route sync intent is emitted or invoked only after valid graph sidechain mutations.
- stale source is represented without deleting graphState.
- removing graph effect node also removes sidechain edges targeting it.
- disconnecting sidechain edge does not call normal audio topology sync unless 6C intentionally
  also route-syncs.

### UI Tests

Add to `GraphStatePreview.test.tsx` and `windowingScaffolding.test.tsx`:

- Sidechain Input node renders in graph mode.
- source selector renders and is disabled/read-only outside graph mode.
- sidechain output handle exists only on Sidechain Input.
- compressor `sidechainIn` target port renders only for supported graph effect nodes.
- invalid drops do not call audio/parameter connection callbacks.
- valid sidechain drop calls the new sidechain connect callback.
- NodeEditor/nodeGraphStore/React Flow remain absent from active FX Graph shell.
- no hardcoded production colors in new sidechain CSS.

### Mixer Store Tests

If 6C reuses helpers in `mixerStore.js`, add tests for:

- eligible source filtering reused for graph track targets.
- graph sidechain route add/remove uses `targetEffectInstanceId`.
- stale route status mapping remains readable.
- graph route sync does not mutate chain-mode compressor UI state.

### Engine/Native Tests

Add/extend native tests:

- graph-owned compressor receives sidechain key through existing route path.
- source track key remains silent in Master and graph output.
- `sc_external=1` ducks graph-owned compressor.
- disabling/removing graph sidechain edge removes ducking.
- wrong `effectInstanceId` does not duck.
- stale source/target is safe and silent.
- project save/load/hydration preserves graph sidechain intent and rebinds runtime route.
- graph sidechain route uses `effectInstanceId`, never raw APG node ID.
- VST sidechain remains unsupported/no-op.
- no `StockParameterCatalog` dependency.

Likely test homes:

- new `engine/test/test_fxgraph_sidechain_input.cpp`, or
- extend `test_stock_compressor_sidechain.cpp` and `test_sidechain_runtime.cpp` with graph-owned
  `EffectChainManager::addGraphNode()` cases.

### Manual Smoke

1. Create Kick and Bass.
2. Put Bass in FX Graph mode.
3. Add stock Compressor graph node.
4. Add/use Sidechain Input node.
5. Select Kick as source.
6. Connect Sidechain Input to Compressor sidechain port.
7. Enable compressor external sidechain if 6C has not auto-enabled it.
8. Play and verify Bass ducks.
9. Confirm Kick does not become audible through the graph.
10. Remove edge/source and verify ducking stops.
11. Save/load and verify state.
12. After any engine/bridge C++ change, close app/worker and run `cd bridge && npx cmake-js compile`.

## 11. Recommended Prompt Sequence

### 6B - Renderer/schema/UI Contract Only

Model recommendation: Opus - High

Risk level: High, because graphState schema and active FX Graph UX are easy to blur with audio and
parameter edge paths.

File scope:

- `ui/src/fxgraph/graphState.js`
- `ui/src/fxgraph/graphState.test.js`
- `ui/src/fxgraph/linearGraphTopology.js`
- `ui/src/stores/effectChainStore.js`
- `ui/src/stores/effectChainStore.test.js`
- `ui/src/windowing/panels/FxGraphPanel.tsx`
- `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx`
- `ui/src/windowing/panels/fxgraph/GraphStatePreview.test.tsx`
- `ui/src/windowing/components/windowing.css`
- `ui/src/windowing/__tests__/windowingScaffolding.test.tsx`

Hard constraints:

- No native runtime ducking.
- No engine/bridge changes.
- No new sidechain DSP/buffer path.
- No Mixer Chain mutation.
- No NodeEditor/nodeGraphStore/React Flow.
- No raw engine node IDs in graphState.
- No VST sidechain.
- No `StockParameterCatalog` work.

Implementation goals:

- Add `sidechainInput` node schema.
- Add distinct `sidechain` edge kind.
- Add protected node rules.
- Add source selector data shape.
- Add sidechain port/edge validation.
- Render Sidechain Input and compressor `sidechainIn` port.
- Ensure audio topology payload ignores sidechain edges.
- Add readable rejection copy.

Tests:

- renderer graphState normalization/protection/edge validation
- store graph-mode gating/undo
- UI render/connection tests
- NodeEditor quarantine tests remain green

Manual smoke:

- UI-only: add Sidechain Input, select source, connect to compressor sidechain port, save/load
  graphState visually.
- Confirm no ducking yet if 6C is not implemented.
- Confirm Mixer Chain sidechain UI still works as before.

### 6C - Runtime Binding to Existing Sidechain Routes

Model recommendation: Opus - High, or Opus - Xhigh if native graph/runtime coupling is worse than
expected.

Risk level: High, because route reconciliation touches persisted timeline sidechain routes and live
graph-owned effect hydration.

File scope:

- `ui/src/stores/effectChainStore.js`
- `ui/src/stores/effectChainStore.test.js`
- possibly `ui/src/stores/mixerStore.js`
- `ui/preload.js`
- `ui/main.js`
- `bridge/src/XlethAddon.cpp`
- `engine/src/audio/TrackRouting.{h,cpp}`
- `engine/src/audio/MixEngine.{h,cpp}`
- `engine/src/audio/EffectChainManager.{h,cpp}`
- `engine/src/audio/AudioGraph.{h,cpp}`
- `engine/src/AudioEngine.cpp`
- engine tests named above

Hard constraints:

- Use existing `SidechainRoute`/`SidechainPlan`/`SidechainSourceProcessor`/bus-enable path.
- Do not create a second sidechain engine.
- Keep key silent.
- Target graph-owned effects by stable `effectInstanceId`.
- Do not persist raw APG IDs.
- Do not add VST sidechain.
- Do not modify `StockParameterCatalog.{cpp,h}`.
- Rebuild addon after any C++ change.

Implementation goals:

- Convert graph `sidechain` edges into existing sidechain routes.
- Source = Sidechain Input node `sourceTrackId`.
- Target track = graph owning track.
- Target effect = connected effect node `effectInstanceId`.
- Reconcile create/remove/update against `timeline.getRouting()`.
- Ensure stock compressor `sc_external` is enabled when required.
- Hydrate/save/load/runtime resync works.
- Remove route when sidechain edge/source is removed.

Tests:

- graph-owned compressor ducking through existing route path
- no audible key leakage
- stale source/target safety
- save/load/hydration rebinding
- wrong `effectInstanceId` no duck
- no VST sidechain

Manual smoke:

- Full Kick/Bass graph-mode compressor ducking smoke.
- Confirm app uses fresh `bridge/build/Release/xleth_native.node`.
- Remove edge/source and verify ducking stops.
- Save/load and verify ducking returns only when graph intent remains.

### 6D - Polish, Manual Smoke, Cleanup

Model recommendation: Codex - High

Risk level: Medium to High, mostly integration and UX polish.

File scope:

- renderer copy/CSS/tests
- docs
- targeted native test adjustments only if 6C left gaps

Hard constraints:

- No diagnostics or always-on logging.
- No VST/FX Graph overreach.
- No sends/buses/output routing/PDC rewrite.
- No new sidechain engine.
- No NodeEditor/nodeGraphStore/React Flow.
- No `StockParameterCatalog` work.

Implementation goals:

- polish error copy
- stale route/source display
- save/load smoke documentation
- final docs update
- ensure graph sidechain does not appear as Mixer Chain controls

Tests:

- focused regression suites from 6B/6C
- mixer sidechain UI tests remain green
- graph preview/windowing scaffolding tests remain green
- native sidechain tests remain green

Manual smoke:

- Repeat full Kick/Bass smoke.
- Confirm key silence with target solo.
- Confirm no graph route appears as send/bus/output routing.
- Confirm app remains clean after reload.

## 12. Risks and Non-Goals

Non-goals:

- no VST sidechain
- no sends
- no new sidechain engine
- no audible key leakage
- no Graph-to-Mixer backdoor
- no Mixer Chain replacement
- no raw engine node IDs in persisted graphState
- no NodeEditor/nodeGraphStore/React Flow revival
- no hardcoded production colors
- no output routing/PDC rewrite
- no `StockParameterCatalog` work

Risks:

- Route persistence duplication: graphState intent and source-track `SidechainRoute` records may
  both persist. 6C must define one authority for sync. Recommended: graphState is user intent;
  `SidechainRoute` records are transport reconciled from that intent.
- Existing sidechain route schema has no owner metadata. Tuple-based reconciliation is probably
  sufficient for v1 graph-owned compressor routes, but 6C must test stale/duplicate cases.
- Existing backend route validation checks effect existence, not sidechain capability. Renderer v1
  must block unsupported targets; future native capability API can be additive.
- `sc_external` is parameter state. Auto-enabling it is useful, but auto-disabling on edge removal
  must not surprise users or break saved compressor settings. 6C must make this policy explicit.
- `buildLinearGraphTopologyPayload()` name is legacy. Do not infer that runtime is still linear-only;
  inspect `EffectChainManager::syncGraphTopology()` before changing topology behavior.
- Stale native addon can make correct source code appear broken. Always rebuild the addon after C++
  changes and verify the app loads the current `xleth_native.node`.

## 13. Unknowns for 6B/6C to Re-Inspect

- Whether 6B should create Sidechain Input automatically on graph-mode conversion or only when the
  user adds it. Recommended: one node per graph track when sidechain UI is invoked; protect it once
  present.
- Whether route sync should store any graph-specific owner metadata on `SidechainRoute`. Recommended:
  avoid in 6B; in 6C add only if tuple reconciliation proves ambiguous.
- Whether auto-disable of `sc_external` on last edge removal is desired. Decide in 6C with tests.
- Whether a generic graph effect sidechain capability descriptor is worth adding. Recommended v1:
  static stock compressor capability in renderer; no VST.
- Whether graph sidechain route reconciliation should run after every graph runtime sync or only
  after sidechain-relevant graph mutations. Recommended: only after sidechain-relevant mutations and
  after graph effect hydration/project load.

## 14. Final Recommendation

Implement Sidechain Input as graphState intent plus existing sidechain route transport:

```txt
graphState sidechainInput.sourceTrackId
+ graphState sidechain edge
-> existing Timeline SidechainRoute(source track -> owning graph track, targetEffectInstanceId)
-> existing MixEngine SidechainPlan/sidechainBuffers_
-> existing AudioGraph SidechainSourceProcessor
-> existing stock compressor bus 1
```

This keeps Mixer Chain as default, keeps FX Graph optional per track, preserves graph-owned
`effectInstanceId` identity, and avoids inventing a second sidechain engine.

## 6B Implementation Status

6B landed the renderer/schema/UI contract only. No engine/bridge/preload/main code was touched and
no native addon rebuild is required.

### graphState (`ui/src/fxgraph/graphState.js`)

- New constants: `GRAPH_SIDECHAIN_INPUT_NODE_TYPE = 'sidechainInput'`,
  `GRAPH_SIDECHAIN_EDGE_TYPE = 'sidechain'`, `GRAPH_SIDECHAIN_INPUT_OUTPUT_PORT = 'sidechainOut'`,
  `GRAPH_SIDECHAIN_TARGET_PORT = 'sidechainIn'`, `GRAPH_SIDECHAIN_INPUT_LABEL = 'Sidechain Input'`,
  `SIDECHAIN_SUPPORTED_TARGET_PLUGIN_IDS = ['compressor']`.
- `sidechainInput` added to `NODE_TYPES`; `sidechain` added to `EDGE_TYPES`.
- `PROTECTED_NODE_TYPES` now includes `sidechainInput` — it cannot be removed via `removeGraphNode`
  and is rejected as a parameter-edge target like Track I/O.
- Node data normalizes to `{ label, sourceTrackId }` (additive): malformed label repairs to
  `Sidechain Input`; non-finite `sourceTrackId` repairs to `null`; a finite (even stale) source id
  is preserved. No `effectInstanceId`/engine/route/APG ids.
- `normalizeEdge` validates `sidechain` edges (source must be `sidechainInput`, target must be
  `effect`) and drops malformed ones — it never converts them to `audio` edges. `hasAudioCycle`
  ignores sidechain edges.
- New pure helpers: `normalizeSidechainInputNodeData`, `createDefaultSidechainInputNodeData`,
  `isSidechainInputGraphNode`, `isSidechainCapableEffectNode`, `addSidechainInputNode` (one per
  graph; returns `existingNodeId` on duplicate), `setSidechainInputSource` (null allowed, self
  rejected), `canConnectSidechainNodes`/`connectSidechainNodes`, `isSidechainEdge`,
  `disconnectSidechainEdge`. New rejection reasons: `sidechain_input_exists`, `select_source_first`,
  `unsupported_sidechain_target`, `invalid_sidechain_source`, `invalid_sidechain_target`,
  `duplicate_sidechain_edge`.

### Runtime topology (`ui/src/fxgraph/linearGraphTopology.js`)

- `sidechainInput` nodes are excluded from the runtime audio node payload (alongside macro/envelope);
  `sidechain` edges are excluded by the existing `edge.type === 'audio'` filter. A graph with
  Track Input → Compressor → Track Output plus Sidechain Input → Compressor.sidechainIn syncs only
  the audible path.

### Store (`ui/src/stores/effectChainStore.js`)

- New graph-mode-gated actions: `addSidechainInputNodeForTrack`, `setSidechainInputSourceForTrack`
  (accepts `options.eligibleSourceTrackIds` to reject visual-only/ineligible sources),
  `connectSidechainForTrack`, `disconnectSidechainEdgeForTrack`. All persist via
  `timeline.setTrackGraphState`, record graph undo transactions, run with `syncRuntime: false`, and
  make no native route / `sc_external` / topology calls. `graphRuntimeTopologyChanged` ignores
  sidechain nodes/edges.

### UI (`FxGraphPanel.tsx`, `GraphStatePreview.tsx`, `windowing.css`)

- "Add Sidechain Input" toolbar button (disabled once a node exists). Sidechain Input node renders
  with a source selector (`No source`, eligible track names, and a stale `Track N (missing)` option
  for a saved-but-ineligible source) and a single `sidechainOut` handle; no audio in-handle, no
  edit/remove. Stock compressor effect nodes render a distinct `sidechainIn` port; non-compressor /
  missing / crashed effects do not. Drag from `sidechainOut` to `sidechainIn` creates a sidechain
  edge (distinct success-tinted dotted cable using theme tokens); invalid drops no-op. Eligible
  sources come from `mixerStore.getEligibleSidechainSources`.

### Not in 6B (remains 6C)

- No native `SidechainRoute` creation, no `sc_external` write, no runtime ducking, no VST sidechain,
  no Mixer Chain mutation, no NodeEditor/nodeGraphStore/React Flow.

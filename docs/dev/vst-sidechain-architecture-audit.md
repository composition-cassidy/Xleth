# VST Sidechain Architecture Audit (VST-SC.1)

Read-only audit and implementation map for adding **third-party VST3 sidechain support** to XLETH,
reusing the existing silent `SidechainRoute` transport, `sidechainBuffers_`, `SidechainSourceProcessor`,
and route-validation architecture. **No second sidechain engine.** This pass changed no runtime
behavior, no C++ behavior, no bridge API, no UI, no schema, and required no native addon rebuild.

> **Status — VST-SC.1 complete (2026-06-11).** Audit only. The single concrete code finding is that
> third-party VSTs are, by construction, *never* sidechain-capable today: `GuardedPluginWrapper`
> declares a fixed stereo-in/stereo-out bus layout and mirrors none of its inner plugin's buses, so
> `AudioGraph::isSidechainCapable()` always returns false for a wrapped VST. Enabling VST sidechain is
> therefore a **wrapper bus-mirroring problem first**, a route/capability problem second. The
> implementation is split into VST-SC.2 (native capability + wrapper bus mirroring), VST-SC.3 (lazy
> route enable + runtime key delivery), and VST-SC.4 (UI + real-plugin smoke). See §11.

## Source documents (read first, verified against source)

- `docs/dev/mixer-routing-sidechain-architecture-audit.md` — the canonical routing/sidechain audit;
  §5.4 already sketched the VST plan and risk list. This document supersedes that sketch with
  verified line-level findings.
- `docs/dev/fxgraph-sidechain-input-architecture-audit.md` — the FX Graph Sidechain Input audit;
  §8/§12 explicitly mark VST sidechain as a non-goal deferred to a later prompt.
- `docs/dev/fxgraph-architecture.md` — FX Graph graphState/runtime model (capability-gated ports).

## Files inspected (verified this pass)

- `engine/src/audio/AudioGraph.h` / `AudioGraph.cpp` — plugin hosting, (2,2) lock,
  `createEffect`, `addProcessorToGraph`, `reprepare`, `rebuildSidechainInfrastructure`,
  `isSidechainCapable`, `applySidechainTargetInstances`, `vstDescriptions_`.
- `engine/src/audio/GuardedPluginWrapper.h` / `GuardedPluginWrapper.cpp` — constructor bus
  declaration, `processBlock`, lifecycle.
- `engine/src/audio/SidechainSourceProcessor.h` — key source node.
- `engine/src/audio/XlethEffectBase.h` — stock sidechain capability/enable API (the model to mirror).
- `engine/src/audio/PluginRegistry.h` — scan/instantiation surface.
- `engine/src/audio/EffectChainManager.{h}` / `MixEngine.{h}` (sidechain members, references).
- `engine/test/test_sidechain_runtime.cpp` — `SidechainReceiverProcessor` + `addProcessorForTesting`.
- `engine/test/test_stock_compressor_sidechain.cpp`, `test_sidechain_routes.cpp`,
  `test_chain_effect_identity.cpp` (test-home candidates).

---

## 1. Current plugin hosting path (third-party VST3)

### 1.1 Stock vs plugin decision — `AudioGraph::createEffect` (`AudioGraph.cpp:2675`)

`createEffect(pluginId)` is a flat dispatch:

- A hard-coded `if (pluginId == "...")` ladder (`:2677-2694`) maps known stock ids
  (`compressor`, `limiter`, `overdone`, `xletheq`, …) to `std::make_unique<Xleth*Effect>()`.
- **Else** (`:2698`): if a `pluginRegistry_` is set, look up the id via
  `PluginRegistry::findPluginByIdentifier` (`:2701`). A non-empty `desc.name` means a known VST3.
- The decision is purely by id string; there is no capability negotiation.

### 1.2 Where VST3 instances are created (`AudioGraph.cpp:2716-2718`, also fromJSON `:1230`, retry `:1473`)

```cpp
const bool createOk = xleth::pluginGuardCall([&]
{
    instance = fmtMgr.createPluginInstance(desc, sr, bs, errorMsg);   // SEH-guarded
});
```

Three instantiation sites, all guarded by `xleth::pluginGuardCall` (SEH):
`createEffect` (live add), `fromJSON` (`:1230`, project load), and a placeholder retry path (`:1473`).

### 1.3 Where stereo layout is currently forced (the (2,2) lock — **four force-sites**)

| Site | Code | When |
|---|---|---|
| `createEffect` (`:2734-2745`) | `layout.inputBuses.add(stereo); layout.outputBuses.add(stereo); instance->setBusesLayout(layout); instance->setPlayConfigDetails(2,2,…)` | once, before wrapping |
| `GuardedPluginWrapper` ctor (`GuardedPluginWrapper.cpp:26`) | `inner_->setPlayConfigDetails(2,2,…)` | once, at wrap time |
| `GuardedPluginWrapper::prepareToPlay` (`GuardedPluginWrapper.cpp:45`) | `innerPtr->setPlayConfigDetails(2,2,…)` | **every prepare/reprepare** |
| `AudioGraph::addProcessorToGraph` (`:185`) | `proc->setPlayConfigDetails(2,2,…)` on the *wrapper* unless `isSidechainCapable` | once at add |
| `AudioGraph::reprepare` (`:165`) / init (`:124`) | `graph_->setPlayConfigDetails(2,2,…)` | every rebuild — forces graph I/O to stereo |

**Critical finding:** `GuardedPluginWrapper::prepareToPlay` (`GuardedPluginWrapper.cpp:45`) re-forces
the inner plugin to `(2,2)` on **every** `reprepare()` / `rebuildImmediate()`. Even if some future
code enabled a sidechain bus on the inner plugin, the very next graph rebuild would silently clobber
it back to stereo. Any VST sidechain enable path must change this site, not just `createEffect`.

### 1.4 Where `GuardedPluginWrapper` is inserted

`createEffect` returns `std::make_unique<GuardedPluginWrapper>(std::move(instance))` (`:2757`) for
*every* VST3; stock effects are returned raw (never wrapped — by design, so stock crashes surface).
The wrapper is then added to the APG via `addProcessorToGraph` (`:172`).

### 1.5 Bus layout the wrapper exposes today (`GuardedPluginWrapper.cpp:15-19`)

```cpp
GuardedPluginWrapper::GuardedPluginWrapper(std::unique_ptr<juce::AudioProcessor> inner)
    : juce::AudioProcessor(BusesProperties()
          .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    , inner_(std::move(inner))
{ ... inner_->setPlayConfigDetails(2,2,…); ... }
```

The wrapper declares **exactly one stereo input bus and one stereo output bus, fixed at
construction.** It overrides **none** of the bus-introspection/negotiation methods:
`getBusCount`, `getBus`, `getBusesLayout`, `setBusesLayout`, `isBusesLayoutSupported`,
`getChannelIndexInProcessBlockBuffer`, `enableAllBuses`, `canAddBus`/`canRemoveBus`. They all resolve
to the base `juce::AudioProcessor` implementation operating on the wrapper's own (stereo-only)
`BusesProperties`. **The inner plugin's buses are invisible to the graph.**

### 1.6 `processBlock` channel handling (`GuardedPluginWrapper.cpp:178-205`)

```cpp
auto* innerPtr = inner_.get();
const bool ok = xleth::pluginGuardCall([&]{ innerPtr->processBlock(buffer, midi); ... });
```

The wrapper passes the *same* `buffer` it received straight to `inner_->processBlock`. The APG sizes
that buffer from the **wrapper's** bus layout (2 channels in/out). The inner plugin is forced to
`(2,2)`, so it reads/writes those 2 channels. There is **no channel marshaling** — the wrapper assumes
inner and wrapper layouts are identical (both stereo). A sidechain bus on the inner would need extra
channels in the buffer the wrapper never declares.

### 1.7 Are plugins re-prepared after creation? — **Yes, repeatedly**

`AudioGraph::reprepare` (`:159-167`) calls `graph_->releaseResources()` then
`graph_->prepareToPlay(...)`, which re-prepares every node — including each `GuardedPluginWrapper`,
whose `prepareToPlay` re-forces inner to `(2,2)` (`:45`). `reprepare` runs on every
`rebuildImmediate`, every debounced rebuild, and explicitly inside `applySidechainTargetInstances`
(`:2200`). Plugins are *not* prepared once; they are re-prepared on every structural change.

### 1.8 Plugin latency read/refresh

`GuardedPluginWrapper::refreshReportedLatency()` (called in ctor `:30`, `prepareToPlay` `:59`, program
change, crash recovery) polls inner's `getLatencySamples()` and republishes via `setLatencySamples`
only on change, returning true so owners recompute PDC. `MixEngine` drives this via
`refreshGuardedPluginLatency` (referenced `MixEngine.h:563`). A latency change after a hypothetical SC
re-prepare would flow through this existing path — **the refresh hook already exists**; VST-SC.3 reuses
it, no PDC rewrite needed.

### 1.9 Crash protection

`pluginGuardCall` (SEH, `PluginCrashGuard.h`) wraps every inner call:
`createPluginInstance`, `prepareToPlay`, `releaseResources`, `reset`, `processBlock`, program/param
changes. On fault, `crashed_` is set and `processBlock` becomes a passthrough (leaves the buffer = dry
signal, `:159-173`). Recovery via `resetCrashed()` from the main thread. **All future bus probing must
go through `pluginGuardCall`.**

---

## 2. Current sidechain delivery path into AudioGraph (the proven stock path)

This path works today for the stock compressor (chain + graph mode) and is the transport VST sidechain
must reuse verbatim.

1. **Route → resolved targets by stable id.** `SidechainRoute.targetEffectInstanceId` (UUID, never an
   APG uid) is resolved to a live APG uid by `EffectChainManager::getNodeIdForEffectInstance` /
   `MixEngine::getEffectNodeIdForInstance`. Resolution walks `AudioGraph` node metadata
   (`GraphNode.effectInstanceId`, `AudioGraph.h:291`), so it works for chain- and graph-owned nodes.
2. **MixEngine accumulates key buffers.** `buildSidechainPlan` (`TrackRouting.{h,cpp}`) produces the
   active tap set; `MixEngine::processBlock` sums each source (× gain, honoring pre/post-fader,
   mute/solo, `feedsSidechainOnly`) into a per-target-slot `sidechainBuffers_[targetSlot]`. These
   buffers are **write-only sinks** — never added to `trackBuffers_`, `outputBuffer`, bus buffers, or
   preview. Structural silence.
3. **EffectChainManager hands the key to AudioGraph.** Immediately before the target chain's
   `processBlock` (under `chainsMutex_`, same thread, same block):
   `EffectChainManager::setSidechainKeyBuffer` → `AudioGraph::setSidechainKey(L,R,n)` (`:2161`), which
   forwards to the `SidechainSourceProcessor` via `setExternalBuffer`. Cleared immediately after.
4. **AudioGraph injects via `SidechainSourceProcessor`.** A single SC source node (0 in / 2 out) is
   created lazily by `rebuildSidechainInfrastructure` (`:2100`) whenever the chain owns ≥1
   sidechain-*capable* node. Its stereo output is wired (`:2148-2158`) to each capable consumer's
   **second input bus** channels, computed via
   `proc->getChannelIndexInProcessBlockBuffer(true, 1, ch)` (`:2155`). The SC node lives **outside**
   `nodes_` (like the I/O nodes) so it never enters ordering/PDC/topology/serialization.
5. **Target bus enabling (the capability gate).** `MixEngine::syncSidechainTargetBuses()` groups
   enabled routes by `(targetTrack, targetEffectInstanceId)` and calls
   `EffectChainManager::applySidechainTargetInstances` → `AudioGraph::applySidechainTargetInstances`
   (`:2173`), which enables the SC bus on exactly the targeted capable nodes and disables it elsewhere,
   re-preparing + rewiring only on actual layout change. Driven by
   `AudioEngine::refreshLivePresentationLatency()` — the universal main-thread hook after every
   routing/chain mutation and load. **No bridge change is needed to drive bus enabling.**
6. **Key silence guarantee.** The key only reaches input bus 1; the consumer writes only its main
   output bus; a bypassed/crashed consumer passes the main bus through and drops the key. Proven
   bit-identical (`maxAbsDiff == 0`) by `test_sidechain_runtime` / `test_stock_compressor_sidechain`.

---

## 3. Current multi-bus support reality (verified, not the old plan)

| Question | Verified answer |
|---|---|
| Is AudioGraph still globally stereo-locked? | **Mostly yes.** Graph I/O nodes and every ordinary node are forced `(2,2)` (`:124/:165/:185`). The **only** relaxation: `addProcessorToGraph` (`:182-185`) skips the `(2,2)` force for a node where `isSidechainCapable(proc)` is true, letting it keep its declared layout. |
| Can a node currently expose >1 input bus? | **Yes, narrowly.** A processor constructed with a second input bus (e.g. `XlethCompressorEffect`, or the test `SidechainReceiverProcessor`) keeps it when `isSidechainCapable` is true. The graph then wires bus 1. |
| Does `SidechainSourceProcessor` already wire into bus 1? | **Yes** — `rebuildSidechainInfrastructure` (`:2148-2158`) connects the SC source's stereo output to each capable node's bus-1 process-block channels. |
| Does `applySidechainTargetInstances` support wrapped plugins? | **No.** It only acts on `dynamic_cast<XlethEffectBase*>` nodes with `supportsExternalSidechain()` (`:2186-2187`). A `GuardedPluginWrapper` fails the cast and is **silently skipped**. VSTs are never enabled. |
| Can `GuardedPluginWrapper` report/mirror inner bus counts/layouts? | **No.** It declares fixed stereo in/out and overrides no bus method (§1.5). `getBusCount(true)` returns 1; `isSidechainCapable(wrapper)` is therefore always false (`:2082`). |
| What if an inner plugin has a SC bus but the wrapper exposes only stereo main? | The SC bus is **invisible and unreachable**. The APG allocates a 2-channel buffer; the inner is forced `(2,2)`; the inner's `getBusBuffer(buffer,true,1)` would read past the buffer or get a disabled bus. No key can arrive. **This is the core blocker.** |

**Conclusion: there is zero VST sidechain capability today, and it fails *closed* (safe).** A VST can
never be `isSidechainCapable`, never gets an SC bus enabled, never receives the key. The stock path is
fully built and proven; VSTs are simply excluded at the `dynamic_cast<XlethEffectBase*>` gate and the
`getBusCount(true) < 2` gate.

---

## 4. VST sidechain capability model (minimal, safe)

Design target:

```txt
plugin effect instance
  -> probe sidechain bus capability (at instantiation, SEH-guarded)
  -> record session-only capability on the node (NOT persisted)
  -> route validation accepts only supported targets
  -> lazy-enable the sidechain bus only when an enabled route targets the instance
```

Decisions:

- **Where capability lives:** on the engine node, session-only. Add a `bool sidechainCapable` (and a
  small `SidechainBusInfo { bool supported; int keyChannels; AudioChannelSet keySet; }`) to
  `AudioGraph::GraphNode` (`AudioGraph.h:282`), set once at instantiation by the probe. Reuse the
  existing per-node `vstDescriptions_` map (`AudioGraph.h:356`) as the home if a parallel map is
  preferred, but node metadata is cleaner and already round-trips identity.
- **Session-only vs serialized:** **session-only.** Plugins lie and change across hosts/versions
  (risk #5 in the routing audit); persisting "supported" would dangle. Re-probe every instantiation.
  The route (`targetEffectInstanceId`) is the only persisted address; capability is recomputed on load.
- **Appears in `getEffectChainState`?** **Yes, additively** — emit `"sidechain": { "supported": bool,
  "channels": n }` per node, exactly as §5.3 of the routing audit specifies for stock effects. The
  renderer already tolerates extra chain-state fields (Prompt 4A precedent). This is how the UI gates
  the dropdown without hardcoding `pluginId === 'compressor'`.
- **Appears in graph-owned effect metadata?** Same field flows through `getChainState` /
  `getGraphTopology` for graph-owned nodes (they share `AudioGraph` node storage). The FX Graph
  renderer should read it instead of the current static `SIDECHAIN_SUPPORTED_TARGET_PLUGIN_IDS`
  allowlist (`graphState.js`).
- **New bridge API?** A read-only `audio_getEffectSidechainCapability(trackId, effectInstanceId)` →
  `{ supported, channels, enabled }` is the cleanest explicit query (already named in the routing
  audit §4.8). **Preferred:** fold capability into the existing `getEffectChainState` /
  graph-topology JSON so **no new bridge method is strictly required** — but a dedicated query is
  acceptable if the UI needs a targeted refresh. Either way, address by **stable
  `effectInstanceId`**, never raw node id (resolve via `getEffectNodeIdForInstance`).
- **Chain-mode and graph-mode share one path:** both resolve through
  `EffectChainManager::getNodeIdForEffectInstance` and read the same `GraphNode` capability field, so
  one probe + one capability field serves both modes (mirrors how 6C reused the stock path unchanged).

Hard rules:
- **Capability is runtime-discovered, never persisted.**
- **Renderer addresses by `effectInstanceId`.**
- **Unsupported plugins fail closed** (route rejected; never faked).
- **Stale/missing plugin target → stale route, not a crash** (existing `status` reporting).

---

## 5. VST bus probing strategy

### 5.1 Probe timing — **instantiation, not scan time**

`PluginRegistry`/`KnownPluginList` (`PluginRegistry.h`) exposes only `PluginDescription`
(`numInputChannels`/`numOutputChannels` = main bus defaults). It carries **no reliable aux/sidechain
bus information** — JUCE does not surface aux buses in `PluginDescription`. Therefore capability
**must be probed at instantiation** (after `createPluginInstance`), not at scan time. Probing at scan
time would also mean loading every plugin during scan (slow, crash-prone) — rejected.

### 5.2 The probe (inside the SEH guard, in/near `createEffect` after `:2729`)

Replace the unconditional stereo force (`:2734-2745`) with a guarded probe **on the inner instance,
before wrapping**:

1. `if (instance->getBusCount(true) < 2)` → not a candidate → keep today's stereo-only force,
   capability `{ supported:false }`. (Most plugins.)
2. Candidate: attempt, via `checkBusesLayoutSupported` then `setBusesLayout`, in order:
   - main stereo in + **stereo** sidechain in (bus 1) + stereo out;
   - fall back to main stereo in + **mono** sidechain in + stereo out;
   - on both failing → today's stereo-only layout, capability `{ supported:false }`.
3. On success, **immediately set the SC bus back to disabled** (stereo main only) and record
   capability `{ supported:true, channels: 1|2 }`. The bus is *probed* then *disabled* — never left
   enabled by default (avoids breaking plugins that misbehave with an enabled-but-silent aux bus,
   risk #5).
4. `setPlayConfigDetails`/`prepareToPlay` as today, then wrap.

All of this is inside `xleth::pluginGuardCall`. A plugin that crashes on `setBusesLayout` is caught,
marked unsupported, and falls back — never permanently broken.

### 5.3 Timing/behavior summary

| Aspect | Decision |
|---|---|
| Probe timing | At instantiation, SEH-guarded. Not scan time. |
| Lazy-enable timing | Only when an **enabled** route targets the instance (VST-SC.3), via the existing `applySidechainTargetInstances` extended to wrapped plugins. |
| Failure behavior | Fail closed: capability false, stereo-only layout, route rejected `sidechain_unsupported`. |
| Reprepare behavior | Enable changes layout → existing `reprepare()` + `rebuildImmediate()` (`:2200-2201`). Must stop the wrapper clobbering the SC bus on prepare (see §6). |
| Latency refresh | Reuse `refreshReportedLatency` / `refreshGuardedPluginLatency` → PDC recompute (already wired). |
| Probe at scan vs instantiation | **Instantiation only** — `PluginDescription` lacks aux-bus info. |

---

## 6. `GuardedPluginWrapper` bus mirroring (the danger zone)

### 6.1 Current state (verified)

- Declares fixed stereo in / stereo out (`GuardedPluginWrapper.cpp:16-18`).
- Forwards **none** of `isBusesLayoutSupported`, `setBusesLayout`, `getBusCount`, `getBus`,
  `getBusesLayout`, `getChannelIndexInProcessBlockBuffer`, `enableAllBuses`.
- `processBlock` passes the received buffer straight to `inner_->processBlock` with **no channel
  marshaling** (§1.6).
- `prepareToPlay` re-forces inner to `(2,2)` (`:45`) — would clobber any enabled SC bus.

Result: `getBusBuffer(buffer,true,busIndex)` *inside the inner plugin* cannot see sidechain channels,
because the buffer the wrapper hands it only has the wrapper's 2 declared channels and the inner is
pinned to `(2,2)`.

### 6.2 Recommended approach — simplest safe wrapper change

Make the wrapper **mirror the inner's bus layout** so the APG allocates the right channel count and
JUCE's own bus-buffer math lines up, avoiding manual marshaling:

1. **Constructor:** build `BusesProperties` from the inner's actual buses
   (`inner_->getBusesLayout()` / `getBusCount`), so a sidechain-capable inner produces a wrapper that
   declares `Input(stereo) + Sidechain(stereo, disabled-by-default) + Output(stereo)`. For
   non-sidechain plugins this reduces to today's stereo-in/out (no behavior change).
2. **Forward bus negotiation to inner:** override `isBusesLayoutSupported` (delegate to
   `inner_->checkBusesLayoutSupported`, SEH-guarded) and ensure `setBusesLayout` applies to **both**
   wrapper and inner consistently. Override `getChannelIndexInProcessBlockBuffer` to defer to the
   inner's mapping so `rebuildSidechainInfrastructure` (`:2155`) computes the correct destination
   channel for a wrapped plugin exactly as it does for a stock effect.
3. **Stop the prepare clobber:** `prepareToPlay` (`:45`) must set the inner from the *wrapper's current
   layout*, not a hardcoded `(2,2)`. Likewise the ctor force (`:26`) and the `createEffect` force
   (`:2745`) become "apply the negotiated layout," not "force stereo."
4. **`isSidechainCapable` then just works:** with the wrapper declaring an enabled bus 1 (after lazy
   enable), `AudioGraph::isSidechainCapable(wrapper)` (`:2079-2085`) returns true via the wrapper's own
   `getBusCount/getBus`, and the existing infra wires the key — no special-casing for VSTs in
   `rebuildSidechainInfrastructure`.
5. **Add wrapped plugins to `applySidechainTargetInstances`:** today it only handles
   `XlethEffectBase` (`:2186`). Add a `GuardedPluginWrapper` branch that toggles the inner SC bus
   (a `setSidechainInputEnabled`-equivalent on the wrapper) and reports layout-changed, so the existing
   reprepare/rewire path runs.
6. **Expose the key without copying:** preferred — declare the SC bus on the wrapper so JUCE's
   `getBusBuffer` inside the inner naturally sees the key channels (no extra copy). If real plugins
   reject mirrored multi-bus layouts through the wrapper, the fallback is **explicit per-bus channel
   marshaling** in `processBlock` (assemble an inner-shaped buffer, copy main + key in, copy main out
   back) — one extra copy, contained, but only if zero-copy mirroring proves impossible.

### 6.3 Bypass/crash passthrough must drop the key safely

The crashed fast-path (`:159-173`) returns leaving the buffer untouched. With a mirrored layout the
buffer's main channels are the dry signal and the key channels are ignored — the main bus passes
through, the key is dropped. **Verify** the passthrough copies/leaves only the main-bus channels and
never lets key channels leak into the output bus (test S3-equivalent below).

### 6.4 Testing wrapper bus mirroring without real plugins

Wrap the existing `SidechainReceiverProcessor` (test_sidechain_runtime.cpp:59 — already declares
`Input(stereo)+Sidechain(stereo)+Output(stereo)` and reads bus 1 via `getBusBuffer`) inside a
`GuardedPluginWrapper` and add it through `addProcessorForTesting` (`AudioGraph.h:246`). Assert the
wrapper mirrors `getBusCount/getBus`, the key arrives on bus 1 only, the main bus is clean, and a
crashed/bypassed wrapper leaks no key. This exercises the wrapper without any VST3 dependency.

### 6.5 Unacceptable shortcuts (binding)

- Hosting SC-enabled VSTs **unwrapped** (loses crash protection).
- Mixing the key into the **main** input bus.
- Forcing all plugins to a **4-channel main bus** instead of a real second bus.
- Persisting **APG node ids**.
- Assuming sidechain support because a plugin has **>2 inputs** (could be a multi-channel main bus).

---

## 7. Lazy enable / disable behavior

Reuse the proven stock mechanism (`MixEngine::syncSidechainTargetBuses` →
`applySidechainTargetInstances`), extended to wrapped plugins.

- **Enable trigger:** route creation (or load/hydration) calls
  `refreshLivePresentationLatency()` → `syncSidechainTargetBuses()`; if ≥1 **enabled** route targets a
  sidechain-capable VST instance, its SC bus is enabled.
- **Disable:** when no enabled route targets it, disable the SC bus **if it disables cleanly**. If a
  specific plugin proves unstable on disable, prefer **leaving the bus enabled but unfed** (silence
  key) over risking instability — decide per-plugin behind the guard; default is disable-when-unused
  (matches stock).
- **Multiple source routes → one plugin:** the bus is enabled if the targeted-instances set contains
  it (set membership, idempotent); MixEngine already sums multiple source keys into the one target
  buffer.
- **`enabled == false` routes:** excluded from the targeted set (already the stock behavior).
- **Project load with existing routes:** after graph-owned effect hydration, the same sync runs and
  enables buses for resolvable targets; unresolved → stale route, bus stays disabled.
- **Graph-owned VST effects after hydration:** identical path (shared node storage / resolver).
- **Avoiding reprepare storms:** `applySidechainTargetInstances` only re-prepares **on actual layout
  change** (idempotent, `:2190-2194`). Batch UI/undo actions coalesce through the existing 50 ms
  debounce; the audio thread is never mid-block during a layout change (sync runs under `chainsMutex_`).
- **Latency/PDC refresh:** after enable, the SC re-prepare may change inner latency →
  `refreshReportedLatency` publishes it → PDC recompute via `computePDC()` (already in `reprepare`).
- **Audio-thread safety:** all enable/disable/reprepare is main-thread under the chains lock;
  `setSidechainKey`/`clearSidechainKey` are the only audio-thread touches, unchanged.

Desired rule (binding): *if ≥1 enabled route targets a sidechain-capable plugin instance, enable its
sidechain bus; otherwise disable it when safe.*

---

## 8. Route validation and unsupported behavior

### 8.1 Current validation (`TrackRouting.cpp::validateSidechainRoute`)

Checks: `master_as_source`, `unknown_source_track`, `master_as_target`, `self_sidechain`,
`unknown_target_track`, `empty_effect_instance`, `unknown_effect_instance` (via
`SidechainEffectResolver`), `invalid_gain`, `duplicate_route`, `cycle`. The resolver only proves the
**effect instance exists**, *not* that it is sidechain-capable. A route to any existing effect
(including a non-SC VST) currently validates as `ok` and then silently delivers no key.

### 8.2 What to add

- A capability check in the resolver path: extend `SidechainEffectResolver` (or add a sibling
  `SidechainCapabilityResolver`) so validation can reject a structurally-valid-but-incapable target
  with the **existing** reason code `sidechain_unsupported` (already enumerated in the routing audit
  §4.4; not yet emitted). The bridge builds the resolver from `MixEngine` capability, so the model
  layer stays audio-engine-free (mirrors the 4B `std::function` resolver pattern).
- Stock compressor (chain + graph) stays supported: capability true via `supportsExternalSidechain()`.
- A **sidechain-capable VST** becomes supported once the §4 capability field is true.
- An **SC-less VST** is rejected at `addSidechainRoute` with `sidechain_unsupported`.
- **Stale routes** keep reporting `stale_target_track` / `stale_effect_instance` (unchanged); a route
  to a plugin that *no longer* exposes sidechain (re-probe changed) should report a stale/unsupported
  status, never crash, never silently pretend to work.

### 8.3 Desired user-facing behavior

- Supported VST → selectable as sidechain target.
- Unsupported VST → disabled with "This plugin does not expose a sidechain input."
- Stale/missing plugin → warning badge, no crash.
- No fake route that silently does nothing (unless the route is *intentionally* stale after a plugin
  change).

---

## 9. Test strategy (design before implementation)

Engine tests are plain-`main()` executables added to `engine/CMakeLists.txt`. The
`SidechainReceiverProcessor` + `addProcessorForTesting` pattern (test_sidechain_runtime.cpp) is the
template; for wrapper tests, wrap that fake processor in a `GuardedPluginWrapper`.

Required native tests:

| Id | Test | Home |
|---|---|---|
| V1 | Fake multi-bus plugin (wrapped) reports **supported**; capability `{supported:true, channels:2}` | new `test_vst_sidechain.cpp` |
| V2 | Fake stereo-only plugin (wrapped) reports **unsupported** | new |
| V3 | Wrapped SC plugin receives key on **bus 1 only**, main bus clean | new |
| V4 | Wrapped **mono**-SC plugin receives folded/mono key correctly (if mono fallback implemented) | new |
| V5 | Fake plugin that **rejects** the SC layout → falls back to unsupported, never broken | new |
| V6 | Latency change after SC-enable → `refreshReportedLatency` publishes it, PDC sees it | new / `test_pdc_stage1` |
| V7 | `GuardedPluginWrapper` mirrors inner `getBusCount`/`getBus`/layout | new |
| V8 | Wrapper crash/bypass passthrough leaks **no** sidechain key (bit-identical main) | new |
| V9 | `addSidechainRoute` to unsupported wrapped plugin rejected `sidechain_unsupported` | `test_sidechain_routes` |
| R1 | Stock compressor sidechain regression still passes | `test_stock_compressor_sidechain` |
| R2 | FX Graph stock sidechain regression still passes | `test_fxgraph_sidechain_input` |
| R3 | Chain-mode sidechain regression still passes | `test_sidechain_runtime` |

Insertion points: **new `engine/test/test_vst_sidechain.cpp`** (CMake target `test_vst_sidechain`) for
wrapper/capability/delivery; extend `test_sidechain_routes.cpp` for the `sidechain_unsupported`
validation case; reuse `addProcessorForTesting` (no real VST3 needed for V1-V8). Real-plugin smoke is
manual in VST-SC.4.

---

## 10. Renderer/UI future plan (document only — no UI in VST-SC.1)

- **Mixer Chain sidechain source dropdown** (`EffectModule.jsx`) should enable a VST target's
  sidechain controls **only when engine capability says supported** — read the new
  `chainState.node.sidechain.supported` field, not a hardcoded `pluginId === 'compressor'`.
- **Unsupported VST** → disabled control with "This plugin does not expose a sidechain input."
- **FX Graph effect node** (`GraphStatePreview.tsx`) should render the `sidechainIn` port for any
  capable effect — replace the static `SIDECHAIN_SUPPORTED_TARGET_PLUGIN_IDS = ['compressor']`
  allowlist (`graphState.js`) with the engine capability flag from graph-topology/chain-state JSON.
- **Capability comes from the engine**, never from hardcoded renderer plugin ids.
- **`GraphStatePreview`** keeps sidechain edges (`type:'sidechain'`) separate from audio topology
  (already true — `buildLinearGraphTopologyPayload` ignores them); no change to that separation.
- **No hardcoded colors** — theme tokens only (theming Wave 0).

---

## 11. Implementation prompt split

### VST-SC.2 — Native capability probe + `GuardedPluginWrapper` bus mirroring

- **Model:** Opus — **High**.
- **Risk:** **High.** Wrapper bus mirroring is unproven (routing-audit risk #4); the prepare-time
  `(2,2)` clobber and missing bus overrides are real blockers.
- **Scope:** add session-only capability metadata to `AudioGraph::GraphNode`; SEH-guarded
  instantiation probe (§5.2) in `createEffect` (+ `fromJSON`/retry paths); make
  `GuardedPluginWrapper` mirror inner buses, forward bus negotiation, and stop forcing `(2,2)` on
  prepare (§6.2); extend `isSidechainCapable`/`applySidechainTargetInstances` to wrapped plugins;
  expose capability additively in `getEffectChainState`/graph-topology JSON (and/or
  `audio_getEffectSidechainCapability`, documented-then-implemented as a read-only query). **No UI**
  beyond an optional hidden bridge query. No lazy-enable-by-route yet.
- **Files likely touched:** `engine/src/audio/GuardedPluginWrapper.{h,cpp}`,
  `engine/src/audio/AudioGraph.{h,cpp}`, `engine/src/audio/EffectChainManager.{h,cpp}` (capability
  passthrough), `bridge/src/XlethAddon.cpp` (read-only capability/chain-state field only),
  `engine/CMakeLists.txt`, new `engine/test/test_vst_sidechain.cpp`.
- **Tests required:** V1, V2, V5, V7, V8 (+ R1/R3 regressions). Fake processors only; no real VST3.
- **Hard constraints:** capability session-only (never persisted); no route-validation behavior
  change yet; no key into main bus; no unwrapped hosting; no APG ids persisted; rebuild addon after
  C++ change before any smoke.
- **Success condition:** a fake multi-bus plugin wrapped in `GuardedPluginWrapper` reports
  `supported`, mirrors its bus count/layout, and receives a test key on bus 1 only; a stereo-only
  wrapped plugin reports unsupported; crash/bypass leaks no key; stock + chain sidechain regressions
  green.

### VST-SC.3 — Lazy route enable + runtime key delivery into the VST bus

- **Model:** Opus — **High** (escalate to **Opus — Xhigh** if wrapper/layout coupling is worse than
  VST-SC.2 found, e.g. real plugins reject mirrored layouts and per-bus marshaling is required).
- **Risk:** **High.** Touches re-prepare/PDC and live route reconciliation.
- **Scope:** enable the SC bus on a capable VST when an enabled route targets it (extend
  `applySidechainTargetInstances` wiring from VST-SC.2 into `syncSidechainTargetBuses`); reprepare
  safely without clobbering; refresh latency/PDC; add `sidechain_unsupported` to route validation
  (reject incapable targets); prove a wrapped fake plugin receives the bus-1 key under a real route.
- **Files likely touched:** `engine/src/audio/MixEngine.{h,cpp}` (`syncSidechainTargetBuses`),
  `engine/src/audio/AudioGraph.{h,cpp}` (`applySidechainTargetInstances` wrapped branch),
  `engine/src/audio/EffectChainManager.{h,cpp}`, `engine/src/audio/TrackRouting.{h,cpp}` (capability
  in validation), `engine/src/AudioEngine.cpp` (existing sync hook), `bridge/src/XlethAddon.cpp`
  (resolver wiring), `engine/test/test_vst_sidechain.cpp`, `engine/test/test_sidechain_routes.cpp`.
- **Tests required:** V3, V4, V6, V9 (+ R1/R2/R3 regressions).
- **Hard constraints:** reuse existing `SidechainRoute`/`SidechainPlan`/`SidechainSourceProcessor`/
  bus-enable path (no second engine); key stays silent; target by `effectInstanceId`; no VST persisted
  capability; reprepare only on actual layout change (no storms); rebuild addon after C++ change.
- **Success condition:** a route to a sidechain-capable wrapped fake plugin enables its bus, delivers
  the key on bus 1 only (main clean, master bit-identical when the plugin doesn't consume), reflects a
  post-enable latency change in PDC, and an SC-less VST route is rejected `sidechain_unsupported`
  end-to-end; stock compressor and FX Graph regressions green.

### VST-SC.4 — UI integration + real-plugin smoke

- **Model:** Codex — **High**.
- **Risk:** **Medium–High** (integration + UX, plus real-plugin variability).
- **Scope:** Mixer Chain sidechain source dropdown supports VSTs gated by engine capability; FX Graph
  `sidechainIn` port shown for sidechain-capable VST graph nodes (replace the hardcoded compressor
  allowlist with the capability flag); unsupported-plugin disabled copy; stale-route warnings; manual
  smoke with ≥1 real VST3 that exposes a sidechain input; finalize docs.
- **Files likely touched:** `ui/src/components/mixer/EffectModule.jsx`,
  `ui/src/stores/mixerStore.js`, `ui/src/stores/effectChainStore.js`, `ui/src/fxgraph/graphState.js`
  (capability-from-engine instead of static allowlist),
  `ui/src/windowing/panels/fxgraph/GraphStatePreview.tsx`, vitest suites, docs.
- **Tests required:** vitest — capability-gated dropdown enable/disable, unsupported copy, stale
  status; manual real-VST3 ducking smoke; all native sidechain regressions remain green.
- **Hard constraints:** capability from engine (no hardcoded plugin ids); no hardcoded colors; no
  NodeEditor/nodeGraphStore/React Flow; no sends; no output-routing/PDC rewrite; rebuild addon before
  smoke; verify the app loads the current `xleth_native.node`.
- **Success condition:** a real sidechain-capable VST3 on a graph/chain track ducks from a Kick key
  with no audible key leakage; an SC-less VST shows the disabled message; save/load preserves the
  route; the key stays silent under target solo.

---

## 12. Summary of findings (for the report)

- **No VST sidechain capability exists today, and it fails closed (safe).** VSTs are excluded at two
  gates: the `dynamic_cast<XlethEffectBase*>` in `applySidechainTargetInstances` (`:2186`) and the
  `getBusCount(true) < 2` in `isSidechainCapable` (`:2082`) — the wrapper only ever reports one
  stereo input bus.
- **The blocker is `GuardedPluginWrapper`, not the route/transport stack.** The wrapper declares fixed
  stereo in/out, mirrors none of the inner's buses, passes the buffer through without marshaling, and
  re-forces `(2,2)` on every prepare (`GuardedPluginWrapper.cpp:45`) — which would clobber any enabled
  SC bus on every graph rebuild. Fix the wrapper first.
- **The silent key transport is complete and reusable.** `SidechainRoute` →
  `buildSidechainPlan` → `sidechainBuffers_` → `setSidechainKeyBuffer` → `setSidechainKey` →
  `SidechainSourceProcessor` → bus-1 channels already works for stock + graph, with proven silence.
  VST support adds capability + wrapper mirroring + lazy enable; it does **not** add a new key path.
- **Capability must be probed at instantiation, session-only.** `PluginDescription` has no aux-bus
  info; persisting "supported" would dangle. Re-probe per session.
- **Latency/PDC refresh and lazy-enable hooks already exist** (`refreshReportedLatency`,
  `syncSidechainTargetBuses`, `applySidechainTargetInstances`, idempotent reprepare-on-change) — no
  PDC or output-routing rewrite is needed; a tiny latency-refresh is already covered by the existing
  path.

**Risk areas (ranked):** (1) wrapper bus mirroring through SEH (unproven); (2) prepare-time `(2,2)`
clobber removal blast radius across all VSTs; (3) real plugins that lie about / crash on SC layouts;
(4) reprepare storms on multi-route undo; (5) stale capability after re-probe across sessions.

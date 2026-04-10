# Bypass Stuck on Track 820 — Diagnostic Report

**Symptom:** `audio_setEffectBypass(820, 8, false)` returns in 20µs with no error. The next `audio_getEffectChain(820)` still reports `bypassed: true` for nodeId 8 (and all other nodes on the track).

---

## Full Call Chain

### SET path — `setEffectBypass(820, 8, false)`

```
JS
 └─ audio_setEffectBypass(820, 8, false)
      │
      ▼  bridge/src/XlethAddon.cpp : 4787
      Audio_SetEffectBypass(info)
        ├─ validates arg types
        ├─ calls audioEngine->getMixEngine().setEffectBypass(820, 8, false)
        └─ ALWAYS returns env.Undefined()          ← ignores bool return
             │
             ▼  engine/src/audio/MixEngine.cpp : 453
             MixEngine::setEffectBypass(trackId=820, nodeId=8, bypassed=false)
               ├─ acquires std::lock_guard<std::mutex> chainsMutex_
               ├─ effectChains_.find(820) → it
               ├─ if it == end() OR !it->second → return false  (silent)
               └─ it->second->setBypass(8, false)
                    │
                    ▼  engine/src/audio/EffectChainManager.cpp : 54
                    EffectChainManager::setBypass(nodeId=8, false)
                      └─ graph_->setBypass(8, false)
                           │
                           ▼  engine/src/audio/AudioGraph.cpp : 160
                           AudioGraph::setBypass(nodeId=8, false)
                             ├─ if !graph_ → return false  (silent)
                             ├─ nodes_.find(8) → it
                             ├─ if it == end() → return false  (silent)
                             ├─ graph_->getNodeForId(it->second.apgNodeId) → node
                             ├─ if !node → return false  (silent)
                             ├─ dynamic_cast<XlethEffectBase*>(node->getProcessor()) → effect
                             ├─ if !effect → return false  (silent)
                             └─ effect->setBypassed(false)
                                  │
                                  ▼  engine/src/audio/XlethEffectBase.h : 54
                                  bypassed_.store(false, memory_order_relaxed)
```

### GET path — `getEffectChain(820)`

```
JS
 └─ audio_getEffectChain(820)
      │
      ▼  bridge/src/XlethAddon.cpp : 4811
      Audio_GetEffectChain(info)
        └─ audioEngine->getMixEngine().getEffectChainState(820)
             │
             ▼  engine/src/audio/MixEngine.cpp : 461
             MixEngine::getEffectChainState(trackId=820) const
               ├─ acquires std::lock_guard<std::mutex> chainsMutex_
               ├─ effectChains_.find(820) → it
               ├─ if it == end() OR !it->second → return "[]"
               └─ it->second->getChainState().dump()
                    │
                    ▼  EffectChainManager::getChainState()
                      └─ graph_->getChainState()
                           │
                           ▼  engine/src/audio/AudioGraph.cpp : 526
                           AudioGraph::getChainState() const
                             ├─ iterates linearOrder_
                             ├─ for each uid: nodes_.find(uid)
                             ├─ graph_->getNodeForId(apgNodeId)
                             ├─ dynamic_cast<XlethEffectBase*>(...)
                             └─ obj["bypassed"] = effect->isBypassed()
                                  │
                                  ▼  engine/src/audio/XlethEffectBase.h : 55
                                  bypassed_.load(memory_order_relaxed)
```

---

## Where Bypass State Is Stored vs. Where It Is Read

**One storage location. No secondary cache.**

| Path | Location |
|------|----------|
| SET writes to | `XlethEffectBase::bypassed_` (`std::atomic<bool>`, line 407 of XlethEffectBase.h) |
| GET reads from | Same `XlethEffectBase::bypassed_` via `isBypassed()` |
| `processBlock` reads from | Same atomic (line ~156) |
| `toJSON` / save reads from | Same atomic (AudioGraph.cpp : ~666) |
| `GraphNode` struct | No `bypassed` field at all (AudioGraph.h : 136–144) |

Nothing in `XlethEffectBase::setStateInformation`, `reset()`, or `processBlock` writes to `bypassed_`. The only writer is `setBypassed(bool b)`.

---

## The Root Cause: nodeId Remapping + Silent Failure

There are two interlocking problems. Together they make bypass appear to work while doing nothing.

### Problem 1: `AudioGraph::fromJSON` reassigns all nodeIds

**`engine/src/audio/AudioGraph.cpp` : 698–751**

Every time `fromJSON` is called — which happens on every project load — the entire graph is wiped and rebuilt:

```cpp
// Step 1: destroy all existing nodes
for (int uid : nodeIds)
    removeNode(uid);            // ← nodeId 8 (and 3,4,5,6…) are GONE here

// Step 2: re-add nodes with new UIDs
for (const auto& nodeObj : j["nodes"]) {
    const int oldId = nodeObj.value("nodeId", -1);  // e.g. 3
    const int newId = addNode(plugId);              // JUCE assigns uid=7 (or 9, or 12…)
    oldToNew[oldId] = newId;

    if (nodeObj.value("bypassed", false))
        setBypass(newId, true);   // ← sets bypass on NEW id only
}
```

`addNode` calls `graph_->addNode(effect)` which returns a JUCE node whose `nodeID.uid` is assigned by an ever-increasing internal JUCE counter. **This counter never resets**, so each `fromJSON` rebuild produces strictly higher UIDs than the previous one.

Concrete example:
- Session start: I/O nodes get uid=1, uid=2
- First project load: EQ=3, Compressor=4, Delay=5, Chorus=6. Saved to `effects.json` with those ids, all `bypassed: true`.
- Project closed and reopened.
- `fromJSON` destroys 3–6, then re-adds: EQ=7, Compressor=8, Delay=9, Chorus=10.
- The new chain has nodeId 8 = Compressor, not Chorus; Chorus is 10.

After load, `getEffectChain(820)` correctly returns the new nodeIds (7,8,9,10), all `bypassed: true`.

The JS `effectChainStore` reflects these new nodeIds — **provided it was refreshed after the load**. If the EffectChainPanel was open before the load completed, or if the store refresh was missed, it may still hold the old pre-load nodeIds.

### Problem 2: The bridge never reports failure to JS

**`bridge/src/XlethAddon.cpp` : 4787–4808**

```cpp
Napi::Value Audio_SetEffectBypass(const Napi::CallbackInfo& info)
{
    // ...arg checks...
    audioEngine->getMixEngine().setEffectBypass(trackId, nodeId, bypassed);
    // ↑ returns bool — COMPLETELY IGNORED
    return env.Undefined();   // ← always returns undefined, success or failure
}
```

`MixEngine::setEffectBypass` returns `false` if the track is not in `effectChains_` or if `AudioGraph::setBypass` returns `false` (nodeId not found). That `false` propagates all the way back to the bridge — and is discarded. JS receives `undefined` and has no way to distinguish "bypass changed" from "nodeId not found, nothing happened."

### How the Two Problems Combine

**Full failure scenario:**

1. `effects.json` has all 4 effects on track 820 with `bypassed: true`.
2. `project_load` calls `loadEffectChainFromJSON(820, j)` → `AudioGraph::fromJSON` rebuilds the graph with new UIDs (e.g., 7, 8, 9, 10), all `bypassed_=true`.
3. JS (or the test harness) calls `getEffectChain(820)` → gets back `[{nodeId:7, bypassed:true}, {nodeId:8, bypassed:true}, ...]`.
4. JS calls `setEffectBypass(820, 8, false)`.
5. Engine: `chainsMutex_` acquired; `effectChains_.find(820)` → found; `AudioGraph::setBypass(8, false)` → `nodes_.find(8)` → found; `effect->setBypassed(false)` → `bypassed_.store(false)`. **Returns true.**
6. Bridge: ignores `true`. Returns `undefined`.
7. JS calls `getEffectChain(820)` → `getChainState()` → `effect->isBypassed()` → **returns false**.

In this nominal path, the bypass IS correctly un-set. So why does the symptom persist?

**The stale-nodeId variant (explains the ALL-effects symptom):**

The key clue is that ALL 4 effects are stuck, not just one. If setting one specific nodeId had failed, the others would toggle normally. All of them failing simultaneously points to a structural problem:

- The JS is calling `setEffectBypass(820, X, false)` where `X` is a nodeId that **no longer exists** in `AudioGraph::nodes_` because the graph was rebuilt since the JS last queried the chain.
- `AudioGraph::setBypass(X, false)` → `nodes_.find(X)` → `end()` → returns `false`.
- Bridge discards `false`, returns `undefined`.
- All 4 set calls fail silently for all 4 stale nodeIds.
- `getEffectChain` returns the current (new) nodeIds, all still `bypassed: true`.

The `getEffectChain` response shows `bypassed: true` for nodeId 8 — but nodeId 8 in the CURRENT graph is whichever effect was assigned that uid on the last `fromJSON` rebuild. If the JS sends `setEffectBypass(820, 8, false)` and the current nodeId=8 is a different effect from what the JS thinks, the operation reaches the wrong effect or a dead nodeId.

---

## Additional Silent-Failure Map

Every `return false` in the call chain is invisible to JS:

| Location | Condition | Returns | JS sees |
|----------|-----------|---------|---------|
| `MixEngine::setEffectBypass` L453 | `effectChains_.find(820) == end()` | `false` | `undefined` |
| `MixEngine::setEffectBypass` L453 | chain pointer is null | `false` | `undefined` |
| `AudioGraph::setBypass` L160 | `!graph_` | `false` | `undefined` |
| `AudioGraph::setBypass` L160 | `nodes_.find(8) == end()` | `false` | `undefined` |
| `AudioGraph::setBypass` L160 | JUCE node not found | `false` | `undefined` |
| `AudioGraph::setBypass` L160 | dynamic_cast fails | `false` | `undefined` |

There are 6 distinct conditions under which the call silently does nothing. Only one of them (`nodes_.find(8) == end()`) needs to be true for the symptom to reproduce.

---

## What `fromJSON` Does and Does Not Do With Bypass

**`AudioGraph.cpp` : 732–734**

```cpp
if (nodeObj.value("bypassed", false))
    setBypass(newId, true);
// There is NO:  else setBypass(newId, false);
```

New nodes start with `bypassed_{false}` (the `XlethEffectBase` default). `fromJSON` only sets `bypassed=true` for nodes where the JSON explicitly has `"bypassed": true`. It never explicitly sets `false`. This is fine for new nodes, but note: **if `effects.json` was saved with all nodes bypassed, `fromJSON` will restore them all to bypassed=true, and the only way out is `setEffectBypass` with the correct new nodeIds.**

---

## Where `effects.json` Is Written and Read

**Save:** `bridge/src/XlethAddon.cpp : 1959–1978` — `writeEffectsJSON()`. Called only from `Project_Save` (line ~2012) and `Project_SaveAs` (line ~2035). Not called after bypass changes. Not debounced.

**Load:** `bridge/src/XlethAddon.cpp : 2082–2096` — inside `project_load`. Called exactly once per project open:
```cpp
mix.loadEffectChainFromJSON(std::stoi(it.key()), it.value());
```

There is no auto-save, no timer-based reload, and no graph-rebuild callback that would re-load bypass state after a manual bypass change. The only post-set-bypass callback risk is if `project_load` is called again for any reason while the user is working.

---

## Summary

**Why does SET succeed but GET still returns `true`?**

The set call reaches the audio engine and finds a node, but it may be the wrong node. `AudioGraph::fromJSON` (called on every project load) destroys all existing nodes and re-creates them with new JUCE-assigned UIDs — UIDs that JUCE's counter never resets between sessions. The JS effectChainStore holds nodeIds from the most recent `getEffectChain` query; if that query was made against the old graph and the store was not refreshed after `fromJSON` ran, every subsequent `setEffectBypass` call uses stale nodeIds that no longer exist in `nodes_`.

The call chain gives no indication that anything went wrong. `Audio_SetEffectBypass` always returns `undefined`. The 20µs return time is consistent with a fast-path `nodes_.find(staleId) == end()` exit — not evidence of success.

**All effects are affected simultaneously** because `fromJSON` reassigns all node UIDs at once. If the JS refresh missed even one project-load event, the entire track's effect set has stale nodeIds.

**Primary fix targets:**
1. `bridge/src/XlethAddon.cpp : 4787` — `Audio_SetEffectBypass` must return the `bool` result of `setEffectBypass` to JS so the caller can detect failure and re-query the chain.
2. `engine/src/audio/AudioGraph.cpp : 698` — `fromJSON` should attempt to preserve nodeIds across rebuilds (or use a stable identity beyond JUCE's auto-assigned UID), OR the JS must always re-fetch the chain after any project load event before issuing bypass/parameter mutations.

---

## Key Files for Further Investigation

- `bridge/src/XlethAddon.cpp : 4787–4808` — `Audio_SetEffectBypass` (return value discarded)
- `engine/src/audio/AudioGraph.cpp : 698–751` — `fromJSON` (nodeId remapping)
- `engine/src/audio/AudioGraph.cpp : 160–174` — `setBypass` (all silent-fail guards)
- `engine/src/audio/AudioGraph.cpp : 526–561` — `getChainState` (reads live from atomic)
- `engine/src/audio/MixEngine.cpp : 453–459` — `setEffectBypass` (chainsMutex, find)
- `engine/src/audio/MixEngine.cpp : 461–467` — `getEffectChainState` (same mutex, same find)
- `engine/src/audio/XlethEffectBase.h : 54–55, 407` — `bypassed_` atomic (single write/read point)
- `bridge/src/XlethAddon.cpp : 2064–2098` — `project_load` → `loadEffectChainFromJSON` trigger

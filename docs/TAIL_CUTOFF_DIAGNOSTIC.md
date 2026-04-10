# Effect Tail Cutoff — XLETH Diagnostic Report

## What we're trying to do

When a pattern block (or audio clip) ends on the timeline, effect chains like Delay and Reverb
should continue ringing out — their internal buffers still hold audio that needs to be drained.
The tail should audibly decay until silence, even though no new notes or clips are being played.

## What actually happens

Audio from effects (Delay repeats, Reverb decay) cuts off instantly at the pattern boundary.
The effect chain receives no further `processBlock()` calls after the last buffer where a
clip/block overlaps the playhead. Extending the pattern with empty trailing space makes the
tail audible, confirming the engine stops calling effect chains as soon as the content region ends.

---

## Primary Bug: The `hasClips` Gate

**File:** `engine/src/audio/MixEngine.cpp`  
**Function:** `MixEngine::processBlock()`  
**Lines:** 1226–1253

### The killer condition (line 1234)

```cpp
for (int i = 0; i < numTrackSlots; ++i)
{
    const auto* track = trackSlots[i].info;

    const bool shouldPlay = anySolo ? track->solo : !track->muted;

    // ▼▼▼ THIS IS THE BUG ▼▼▼
    if (!shouldPlay || !trackSlots[i].hasClips)    // line 1234
    {
        trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
        trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
        continue;   // ← skips effect chain, volume, pan, and output sum
    }

    // ... volume smoother ...

    // Effect chain — NEVER REACHED when hasClips == false
    if (chainsLocked)
    {
        auto chainIt = effectChains_.find(track->id);
        if (chainIt != effectChains_.end() && chainIt->second && chainIt->second->isInitialized())
            chainIt->second->processBlock(trackBuffers_[i], numSamples);  // line 1253
    }
    // ...
}
```

`hasClips` is set to `true` only at:
- **Line 1130**: when an audio clip is found in `activeClips_` for this track's slot
- **Line 1199**: when a pattern block is found in `activeBlocks_` for this track's slot

When the playhead moves past the last pattern/clip boundary, neither condition fires.
`hasClips` stays `false`, `continue` fires, and the effect chain **is never called**.

The JUCE `AudioProcessorGraph` inside `AudioGraph` (wrapping Delay, Reverb, etc.) still holds
audio in its internal delay lines — but it never gets a chance to drain them.

---

## Secondary Bug: Sampler Release Tails Also Cut Off

**File:** `engine/src/audio/MixEngine.cpp`  
**Function:** `MixEngine::findActivePatternBlocks()`  
**Lines:** 851–871

### Block-exit voice cutting

```cpp
// Lines 863–870 — fires on the FIRST buffer after block end
for (const auto& key : prevActiveKeys_)
{
    if (currentKeys.count(key) == 0)
    {
        auto it = samplers_.find(key);
        if (it != samplers_.end() && it->second)
            it->second->allNotesOff();   // ← triggers release phase in sampler
    }
}
prevActiveKeys_ = std::move(currentKeys);
```

At the same buffer where `allNotesOff()` fires (first buffer past block end):
- `activeBlocks_` is empty for this track, so `hasClips = false`
- The sampler's voices enter release phase but `apb.sampler->processBlock()` (line 1208)
  is inside the `for (const auto& apb : activeBlocks_)` loop — it never executes
- The sampler release tail is silenced along with the effect tail

---

## Full Per-Track Decision Chain (Buffer N where block ends)

```
findActivePatternBlocks(bufStart, bufEnd):
  blockEnd <= bufStart  →  block NOT added to activeBlocks_
  currentKeys = {}
  prevActiveKeys_ had the key → allNotesOff() fires on sampler  [BUG SITE 2]
  prevActiveKeys_ = {}

Per-track loop for track i:
  trackSlots[i].hasClips == false   (nothing was added to activeBlocks_ for this slot)
  └─ if (!shouldPlay || !trackSlots[i].hasClips)   [BUG SITE 1 — line 1234]
       continue
       ▲ SKIPS:
         - sampler processBlock()     ← sampler release tail dies here
         - effectChain->processBlock()  ← reverb/delay tail dies here
         - volume/pan/spread
         - output sum
```

---

## Transport Behavior at Pattern End

The `Transport` class (`engine/src/Transport.h`) is a simple atomic position counter with
no auto-stop logic. `transport.advance(numSamples)` is called by the audio device callback;
`transport.stop()` is only called explicitly by UI actions.

**The transport keeps running past pattern end.** The silence is not caused by the transport
stopping — it is caused entirely by `hasClips = false` gating per-track processing.

This also means: if you extend the empty space after the pattern, the playhead is still
running, `hasClips` is still `false`, and tails are still cut. The workaround (adding empty
space) only appears to work if the user also manually extends the pattern block to cover that
space, which forces `hasClips = true` for those extra buffers.

---

## `getTailLengthSeconds()` — Not Used Anywhere

**File:** `engine/src/audio/XlethEffectBase.h`, line 229:
```cpp
double getTailLengthSeconds() const override { return 0.0; }
```

All effect subclasses inherit this default. No subclass overrides it.

Grep results across all of `engine/src/`:
- `XlethEffectBase.h:229` — definition, returns 0.0
- `WireGainProcessor.h:98` — returns 0.0  
- `DelayCompensationProcessor.h:105` — returns 0.0

`getTailLengthSeconds()` is **never called** from `MixEngine`, `AudioGraph`, or any other
engine file. There is no tail-length awareness anywhere in the mixing pipeline.

---

## Recommended Fix Strategy

### Option A — Minimum-change fix (recommended for now)

Remove `!trackSlots[i].hasClips` from the early-exit guard, and instead use it only to
decide whether to run the note-triggering path. The effect chain and sampler `processBlock`
must still run on silent buffers so internal state drains naturally.

**`MixEngine.cpp` line 1234 — change:**
```cpp
// BEFORE (broken):
if (!shouldPlay || !trackSlots[i].hasClips)
{
    ...
    continue;
}

// AFTER (correct):
if (!shouldPlay)
{
    trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
    trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
    continue;
}

// Still skip effect/volume/pan if no clips AND the effect chain is absent or uninitialized
// (avoids unnecessary work for tracks that genuinely have no effects and no audio)
auto chainIt = effectChains_.find(track->id);
const bool hasEffectChain = chainsLocked
    && chainIt != effectChains_.end()
    && chainIt->second
    && chainIt->second->isInitialized();

if (!trackSlots[i].hasClips && !hasEffectChain)
{
    trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
    trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
    continue;
}
```

This keeps the optimization for tracks with no active content AND no effect chain (common
case: empty tracks), while allowing tracks with an effect chain to keep processing.

**The sampler release tail** (Bug Site 2) is also fixed by this change — because the sampler
`processBlock` call at line 1208 is inside `for (const auto& apb : activeBlocks_)` which is
already empty at that point. To also drain sampler release tails you need:

```cpp
// After the activeBlocks_ render loop, also render any sampler that had a key
// drop out this buffer (voices now in release — not in activeBlocks_ but still producing audio)
for (const auto& key : prevReleasingKeys_)  // new set: keys that just dropped out
{
    auto slotIt = trackIdToSlot.find(key.trackId);
    if (slotIt == trackIdToSlot.end()) continue;
    auto sit = samplers_.find(key);
    if (sit == samplers_.end() || !sit->second) continue;
    Sampler* s = sit->second.get();
    if (s && s->hasSample())
    {
        trackSlots[slotIt->second].hasClips = true;  // mark so effect chain runs
        s->processBlock(trackBuffers_[slotIt->second], numSamples, sampleRate);
    }
}
```

This requires a `Sampler::hasActiveVoices()` method and tracking which keys are in release.

### Option B — Proper tail-length awareness (complete fix)

1. Override `getTailLengthSeconds()` in `XlethDelayEffect` and `ReverbEffect` to return the
   actual tail length (delay feedback decay, reverb RT60 time).
2. In `MixEngine`, when a block exits `activeBlocks_`, record `{trackId, tailEndSample}` in
   a `tailingTracks_` map: `tailEndSample = currentSample + tailSeconds * sampleRate`.
3. In the per-track loop, also set `hasClips = true` if `currentSample < tailEndSample`.
4. Clear `tailingTracks_` entries when their `tailEndSample` passes.

This is more surgical than Option A and avoids processing completely silent effect chains,
but requires implementing `getTailLengthSeconds()` in each effect and plumbing the result
through `AudioGraph` → `EffectChainManager` → `MixEngine`.

### Recommendation

Ship Option A first (1–2 line change, no new methods needed, fixes both tail cutoff
and sampler release tails). Follow with Option B as a CPU optimization once effects
implement `getTailLengthSeconds()`.

---

## Key Files Summary

| File | Relevant Location | Issue |
|------|-------------------|-------|
| `engine/src/audio/MixEngine.cpp` | Line 1234 | **Primary bug**: `!hasClips` guard skips effect chain |
| `engine/src/audio/MixEngine.cpp` | Lines 863–870 | **Secondary**: `allNotesOff()` fires but sampler never processes release |
| `engine/src/audio/MixEngine.cpp` | Lines 1124–1209 | Where `hasClips` is set (clips: 1130, blocks: 1199) |
| `engine/src/audio/MixEngine.cpp` | Lines 1249–1253 | Effect chain call — unreachable when `hasClips == false` |
| `engine/src/audio/XlethEffectBase.h` | Line 229 | `getTailLengthSeconds()` returns 0.0, never overridden or called |
| `engine/src/audio/AudioGraph.cpp` | Lines 827–839 | `AudioGraph::processBlock` — just calls JUCE graph, no gating |
| `engine/src/Transport.h` | — | No auto-stop at content end; transport keeps advancing |

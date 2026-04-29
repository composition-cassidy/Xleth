# Dynamics Visualization — Diagnostic & Architecture Plan

**Status:** Diagnostic only. No code changes in this pass.
**Scope:** Stock Dynamics plugins (Compressor, Limiter, Transient Processor, Overdone) and the path that would make Fruity-Limiter-class visual feedback possible without regressing real-time audio.
**Audience:** Whoever implements Phases 2–6 next.

---

## 1. Existing architecture map

### 1.1 Plugin registry & base class

| Concern | File | Symbol |
| --- | --- | --- |
| Stock effect dispatch | [engine/src/audio/AudioGraph.cpp:1822](engine/src/audio/AudioGraph.cpp:1822) | `AudioGraph::createEffect(pluginId)` — hardcoded `if/else` over plugin id strings |
| Effect base class | [engine/src/audio/XlethEffectBase.h:30](engine/src/audio/XlethEffectBase.h:30) | `class XlethEffectBase : public juce::AudioProcessor` |
| Per-effect parameter store | [engine/src/audio/XlethEffectBase.h:48](engine/src/audio/XlethEffectBase.h:48) | `juce::AudioProcessorValueTreeState apvts_` |
| Smoothed parameter helper | [engine/src/audio/XlethEffectBase.h:70](engine/src/audio/XlethEffectBase.h:70) | `registerSmoothedParam` / `getNextSmoothedValue` |
| Atomic meter slots | [engine/src/audio/XlethEffectBase.h:79](engine/src/audio/XlethEffectBase.h:79) | `static constexpr int kNumMeterSlots = 8;` plus `meterSlots_[8]` (`std::atomic<float>`) |
| Audio-thread meter write | [engine/src/audio/XlethEffectBase.h:82](engine/src/audio/XlethEffectBase.h:82) | `writeMeterValue(slot, value)` — relaxed atomic store |
| Main-thread meter read | [engine/src/audio/XlethEffectBase.h:132](engine/src/audio/XlethEffectBase.h:132) | `getMeterAsJSON()` — returns `[s0..s7]` |
| Parameter set | [engine/src/audio/XlethEffectBase.h:121](engine/src/audio/XlethEffectBase.h:121) | `setParameterValue(paramId, denormalized)` |

There is no plugin-category metadata in C++. The "Dynamics" grouping exists only conceptually, not in any registry struct. Stock effects live as case-strings in `AudioGraph::createEffect`.

### 1.2 Bridge / IPC surface

| Concern | File | Symbol |
| --- | --- | --- |
| Add / remove / list effects | [bridge/src/XlethAddon.cpp](bridge/src/XlethAddon.cpp) | `audio_addEffect`, `audio_removeEffect`, `audio_getEffectChain`, `audio_setEffectBypass` |
| Param read | [bridge/src/XlethAddon.cpp:7249](bridge/src/XlethAddon.cpp:7249) | `audio_getEffectParameters(trackId, nodeId) → JSON` |
| Param write | [bridge/src/XlethAddon.cpp:7270](bridge/src/XlethAddon.cpp:7270) | `audio_setEffectParameter(trackId, nodeId, paramId, value)` |
| Meter snapshot | [bridge/src/XlethAddon.cpp:7299](bridge/src/XlethAddon.cpp:7299) | `audio_getEffectMeter(trackId, nodeId) → JSON 8-slot array` |
| Batched track peaks | [bridge/src/XlethAddon.cpp:6984](bridge/src/XlethAddon.cpp:6984) | `audio_getAllPeaks() → { master, tracks: { trackId: {peakL,peakR} } }` |
| Plugin-instance addressing | [bridge/src/XlethAddon.cpp:7854](bridge/src/XlethAddon.cpp:7854) | `(trackId, nodeId)` tuple — `trackId = -1` for master, `nodeId` is `juce::AudioProcessorGraph::NodeID.uid` |
| Engine routing layer | [engine/src/audio/MixEngine.cpp:1497](engine/src/audio/MixEngine.cpp:1497) | `getEffectMeter`, `setEffectParameter`, `getEffectParameters` |

The bridge is **synchronous request/response only** — no `napi_threadsafe_function`, no push channel from C++ to JS. UI polls.

### 1.3 IPC plumbing on the JS side

| Layer | File | Pattern |
| --- | --- | --- |
| Worker process owning the addon | [ui/main.js:125](ui/main.js:125) | Forked Node child process; `callWorker({method,args})` |
| `ipcMain.handle` registrations | [ui/main.js:350](ui/main.js:350) | `ipcMain.handle('xleth:audio:getEffectMeter', …)` |
| Periodic main-process tick | [ui/main.js:181](ui/main.js:181) | `setInterval(pollWorldProcessing, 100)` (10 Hz, used for stretch jobs only) |
| Renderer surface | [ui/preload.js:52](ui/preload.js:52) | `window.xleth.audio.getEffectMeter(trackId, nodeId)` |
| Frame shared memory (video) | [ui/preload.js:24](ui/preload.js:24) | Windows named file mapping (`XlethFrameBuffer`) — separate path, not used for meters |

### 1.4 React UI surface

| Plugin | Editor JSX | Store | CSS block |
| --- | --- | --- | --- |
| Compressor | [ui/src/components/mixer/CompressorPanel.jsx](ui/src/components/mixer/CompressorPanel.jsx) | [ui/src/stores/compressorStore.js](ui/src/stores/compressorStore.js) | `ui/src/styles/app.css` lines 7841–7982 |
| Limiter | [ui/src/components/mixer/LimiterPanel.jsx](ui/src/components/mixer/LimiterPanel.jsx) | [ui/src/stores/limiterStore.js](ui/src/stores/limiterStore.js) | `ui/src/styles/app.css` lines 7986–8142 |
| Transient Proc | [ui/src/components/mixer/TransientProcPanel.jsx](ui/src/components/mixer/TransientProcPanel.jsx) | [ui/src/stores/transientProcStore.js](ui/src/stores/transientProcStore.js) | `ui/src/styles/app.css` lines 9067–9207 |
| Overdone (OTT) | [ui/src/components/mixer/OTTPanel.jsx](ui/src/components/mixer/OTTPanel.jsx) | [ui/src/stores/overdoneStore.js](ui/src/stores/overdoneStore.js) | `ui/src/styles/app.css` lines 8844–8973 |
| Plugin window dispatcher | [ui/src/components/mixer/EffectModule.jsx:22](ui/src/components/mixer/EffectModule.jsx:22) | Registry mapping `pluginId → store.open(trackId,nodeId)` |
| Floating panel host | [ui/src/components/mixer/MixerPanel.jsx:114](ui/src/components/mixer/MixerPanel.jsx:114) | All four panels rendered unconditionally; visibility driven by their store's `target` |
| Knob primitive | [ui/src/components/sampler/Knob.jsx](ui/src/components/sampler/Knob.jsx) | Canvas-drawn, supports `onLiveChange` / `onCommit`, theme-aware |
| Meter slot constants | [ui/src/constants/meterSlots.js](ui/src/constants/meterSlots.js) | `PEAK_L=0, PEAK_R=1, GAIN_REDUCTION=2, LUFS_MOMENTARY=3, LUFS_SHORT_TERM=4, BAND_GR_LOW=2, BAND_GR_MID=3, BAND_GR_HIGH=4` |

### 1.5 Existing meter polling loop (shared pattern)

All four panels copy the same `requestAnimationFrame`-driven, ~30 Hz polling loop. Reference: [CompressorPanel.jsx:95-123](ui/src/components/mixer/CompressorPanel.jsx:95).

```
async poll():
  if now - lastPoll >= 33ms:
    raw = await window.xleth.audio.getEffectMeter(trackId, nodeId)
    parse JSON 8-slot array
    grBarRef.current.style.height = pct + '%'    // direct DOM, bypasses React
  rafRef = requestAnimationFrame(poll)
```

Three things to keep in mind:

1. **Already off React's render path** — DOM ref writes bypass `setState`. Good baseline for a higher-rate visualizer.
2. **Single point sample only** — each poll yields one float per slot at the moment of read. There is no rolling history on the engine side.
3. **JSON over IPC** — fine for 8 floats at 30 Hz, **not** fine if we want a rolling 256-bucket history per frame.

### 1.6 Lock-free SPSC infrastructure already present

| File | Symbol | Notes |
| --- | --- | --- |
| [engine/src/TriggerQueue.h:15](engine/src/TriggerQueue.h:15) | `class TriggerQueue` | Power-of-2 SPSC ring, `acquire/release` atomic indices, used today for sampler triggers. **Templatable pattern — reuse as `RingBuffer<VizFrame>` for per-effect frames.** |

No use of `juce::AbstractFifo` anywhere in the dynamics path. We do not need to import JUCE's helper — the in-house pattern is fine and already passes review.

---

## 2. Per-plugin diagnostic

> *Process column: "S/S" = sample-by-sample inner loop in `processEffect`. "Block" = block-level pass (oversampling, filter chain) before per-sample work.*

### 2.1 Compressor — `XlethCompressorEffect`

- **Files:** [engine/src/audio/XlethCompressorEffect.h](engine/src/audio/XlethCompressorEffect.h) (header-only)
- **Process:** S/S, stereo in-place, optional lookahead via `juce::dsp::DelayLine`.
- **Parameters:**

| ID | Range | Unit | Default |
| --- | --- | --- | --- |
| `threshold` | -60..0 | dB | -20 |
| `ratio` | 1..100 | :1 | 4 |
| `attack` | 0.01..100 | ms | 10 |
| `release` | 10..1000 | ms | 100 |
| `knee` | 0..24 | dB | 6 |
| `makeup` | 0..36 | dB | 0 |
| `mix` | 0..100 | % | 100 |
| `detect_mode` | 0..1 | discrete (Peak / RMS) | 0 |
| `lookahead` | 0..10 | ms | 0 |

- **Internal DSP state already computed (per sample):**
  - `env_` — envelope follower output (line 265)
  - `peak_` — peak detector state (line 267)
  - `envDB` — detector value in dB (line 177)
  - `grDB` — soft-knee gain reduction in dB (line 183), max-tracked per block as `maxGR`
  - `peakL`, `peakR` — output peaks per channel
- **Slots written today:** 0=peakL, 1=peakR, 2=GR(dB).
- **Audio-thread risks:** None outstanding. `DBG()` blocks are `XLETH_DEBUG`-guarded. No allocations in `processEffect`.
- **Visualization-ready signals (no DSP changes needed):**
  - input level (pre-gain absolute peak) — currently *not* tracked, but trivial to capture before envelope
  - detector envelope (`envDB`) — already computed
  - GR (dB) — already computed
  - output level (post-makeup, post-mix) — already computed as `peakL/peakR`
  - transfer curve — derivable from `threshold/ratio/knee` on the UI side; does not need engine data

### 2.2 Limiter — `XlethLimiterEffect`

- **Files:** [engine/src/audio/XlethLimiterEffect.h](engine/src/audio/XlethLimiterEffect.h) (header-only)
- **Process:** Block-level 4× oversampling for true-peak detection, then S/S gain-reduction pass with backward smoothing into a lookahead delay line.
- **Parameters:**

| ID | Range | Unit | Default |
| --- | --- | --- | --- |
| `gain` | 0..36 | dB | 0 |
| `ceiling` | -12..0 | dB | -0.3 |
| `release` | 10..1000 | ms | 100 |
| `style` | 0..2 | discrete (Transparent / Punchy / Aggressive) | 0 |

- **Internal DSP state already computed:**
  - `gainReductionBuf_[i]` — per-sample linear GR (with backward anticipatory smoothing, line 333–355)
  - `peakL`, `peakR` — output peaks
  - `momentaryBuf_` / `momentarySum_` — 400 ms K-weighted LUFS ring (line 70–72)
  - `shortTermBuf_` / `shortTermSum_` — 3 s K-weighted LUFS ring
  - `kweightState_[2]` — biquad state
- **Slots written today:** 0=peakL, 1=peakR, 2=GR(dB), 3=momentary LUFS, 4=short-term LUFS.
- **Audio-thread risks:** **One real one** — `juce::Logger::writeToLog()` at lines 182–184 inside `updateLookahead()`. It only fires on `style` parameter change, but it is unguarded and runs on the audio thread. Should be wrapped in `XLETH_DEBUG` before we add any further work here. *(Tracking this as an out-of-scope cleanup; do not bundle into the visualization PR.)*
- **Visualization-ready signals:**
  - input peak (pre-`gain`) — not tracked; would need one local capture
  - true peak (per-sample, pre-limit) — already computed (`pk` from oversampled buffer, line 318–323) but not stored beyond the immediate scope
  - GR linear/dB — already computed
  - lookahead state (`totalLookaheadSamples_`) — already tracked as discrete value
  - ceiling (dB) — already on the parameter

### 2.3 Transient Processor — `XlethTransientProcEffect`

- **Files:** [engine/src/audio/XlethTransientProcEffect.h](engine/src/audio/XlethTransientProcEffect.h) (header-only)
- **Process:** S/S, dual-mode. Envelope mode uses fast/slow envelope ratio + threshold hysteresis. MIDI mode uses note-on velocity and an attack-window countdown.
- **Parameters:**

| ID | Range | Unit | Default |
| --- | --- | --- | --- |
| `attack` | -100..100 | % | 0 |
| `sustain` | -100..100 | % | 0 |
| `attack_speed` | 0.5..20 | ms | 5 |
| `threshold` | -60..0 | dB | -60 |
| `mix` | 0..100 | % | 100 |
| `midi_detect` | 0..1 | discrete (Envelope / MIDI) | 0 |

- **Internal DSP state already computed:**
  - `fastEnvL_`, `fastEnvR_`, `slowEnvL_`, `slowEnvR_` — dual envelopes
  - `ratio` (local) — fast/slow envelope ratio (line 187)
  - `gainSmooth_` — smoothed signed gain (line 306)
  - `gainDB` (local) — signed gain in dB
  - `isActive_` — hysteresis gate (line 313)
  - `samplesInAttackWindow_`, `currentVelocity_` — MIDI mode state
- **Slots written today:** 0=peakL, 1=peakR, 2=signed gain (dB).
- **Audio-thread risks:** None — all logging is `XLETH_DEBUG`-guarded; MIDI parsing uses a stack-local `onsets[64]` array.
- **Visualization-ready signals:**
  - fast envelope, slow envelope (dB) — already computed
  - transient detection events — derivable from `isActive_` rising-edge or from `samplesInAttackWindow_` reset (MIDI mode)
  - signed gain history — already computed
  - input level — would need one extra local capture pre-process

### 2.4 Overdone — `XlethOTTEffect` (`pluginId: "overdone"`)

- **Files:** [engine/src/audio/XlethOTTEffect.h](engine/src/audio/XlethOTTEffect.h) (header-only)
- **What it actually is:** **3-band multiband compressor**, OTT-style. Linkwitz-Riley split into low/mid/high; each band is compressed both **upward and downward** against fixed preset thresholds; bands are summed phase-coherently; `depth` blends the compression intensity (it is *not* a dry/wet). Not saturation, not soft-clip.
- **Process:** S/S, three bands per sample, no oversampling.
- **Parameters:**

| ID | Range | Unit | Default |
| --- | --- | --- | --- |
| `depth` | 0..100 | % | 70 |
| `time` | 0..100 | % | 50 |
| `xover_low` | 40..400 | Hz | 88 |
| `xover_high` | 1000..8000 | Hz | 2500 |
| `gain_low` | -12..12 | dB | 0 |
| `gain_mid` | -12..12 | dB | 0 |
| `gain_high` | -12..12 | dB | 0 |

- **Internal DSP state already computed (per band, per sample):**
  - `peak_[b]`, `env_[b]` — RMS-style envelope per band
  - `envDB` (local) — band envelope in dB
  - `grDB` (local) — downward GR in dB; `maxGR[b]` tracked per block
  - per-band gains (linear)
- **Slots written today:** 0=peakL, 1=peakR, 2=low GR, 3=mid GR, 4=high GR.
- **Audio-thread risks:** None — debug blocks guarded; DSP state pre-allocated.
- **Visualization-ready signals:**
  - per-band level (envDB) — already computed
  - per-band downward GR — already computed
  - per-band **upward** GR — `computeOTTGainDB()` returns the combined value; the upward portion is not separately surfaced, but is straightforward to split
  - crossover frequencies — already on parameters

### 2.5 What's missing on the engine side

| Signal | Compressor | Limiter | Transient | Overdone |
| --- | --- | --- | --- | --- |
| Input level (pre-process) | missing | missing | missing | missing |
| Output level | ✓ slot 0/1 | ✓ slot 0/1 | ✓ slot 0/1 | ✓ slot 0/1 |
| Detector / envelope value | computed, not exposed | computed, not exposed | computed (fast+slow), not exposed | computed per-band, partially exposed |
| Gain reduction | ✓ slot 2 | ✓ slot 2 | ✓ slot 2 (signed) | ✓ slots 2/3/4 |
| LUFS | n/a | ✓ slots 3/4 | n/a | n/a |
| Transient onset event | n/a | n/a | computed, not exposed | n/a |
| Per-band upward vs downward | n/a | n/a | n/a | combined only |
| **History** (any time-series) | none | none | none | none |

The 8-slot atomic array is a **point sample** of the present moment. There is no rolling history anywhere in the engine today.

---

## 3. UI diagnosis

### 3.1 Why the editors feel barebones

- Each panel is a knob grid plus 1–3 vertical bars. Bars are `<div>` elements whose `style.height` is poked from a `requestAnimationFrame` poll. They show *now*, not *what just happened*.
- There is no waveform / envelope history. There is no transfer curve. There is no ceiling line, no threshold line, no lookahead state, no band activity timeline.
- The four panels duplicate the **same** `rAF` polling loop and the **same** DOM-write idiom (CompressorPanel/LimiterPanel/TransientProcPanel/OTTPanel — each has its own copy of essentially the same 30 lines).
- There is no shared meter/visualization component at all (`Knob.jsx` is the only shared primitive in the dynamics editors).

### 3.2 What to keep as-is

- `Knob.jsx` — Canvas-rendered, theme-tokenized, supports continuous + commit callbacks. Reusable, no changes.
- The `EffectModule` registry pattern at [EffectModule.jsx:22](ui/src/components/mixer/EffectModule.jsx:22) — the open/close indirection by `pluginId` should stay.
- Each plugin's Zustand store (`{ target: { trackId, nodeId, storeKey } | null }`) — minimal and correct.
- The floating-panel chrome (titlebar + close button + drag) per panel — fine.
- The IPC surface `window.xleth.audio.{setEffectParameter, getEffectParameters, getEffectMeter}` — keep verbatim.

### 3.3 What should become shared

A new `ui/src/components/mixer/dynamics/` folder (or similar):

- `useDynamicsVizSubscription(trackId, nodeId)` — single hook owning the rAF loop, ring drain, and ref handoff. **One** copy instead of four.
- `<DynamicsVisualizerCanvas />` — the canvas + sizing + theming wrapper. Per-plugin children plug into it.
- `<TransferCurveView />` — pure function of (threshold, ratio, knee, makeup), with a live moving dot for current input/output.
- `<GainReductionHistoryView />` — ring-buffer-driven horizontal scrolling GR strip.
- `<LevelHistoryView />` — input + output level history, ceiling/threshold lines overlaid.
- `<BandActivityView />` — for Overdone: three stacked GR strips with crossover Hz markers.

These are all Canvas 2D. None of them should re-render React on each animation frame; they read from a `useRef`-held mutable buffer (the ring drain target).

### 3.4 Theming

The four editors are ~85% on Phase 0 tokens. Meter gradients still hardcode `#2ea8a0 / #4ecdc4 / #ff8c00 / #ff4040` in OTT and Transient. New visualizer canvases must read all colors via `useTokenValue(--theme-*)` so dark/light themes flow through.

---

## 4. Visualization data model

### 4.1 Design constraints

- The audio thread already does everything we need; the channel is the missing link.
- A "frame" is a **time-bucketed downsample**, not raw audio. Audio thread accumulates into a bucket; when the bucket fills, it pushes one struct to a per-instance ring.
- All numbers are `float32`. Levels and GR are stored as **dB** (cheap to convert once per bucket; UI doesn't need to repeat it per frame).
- POD only. No `std::string`, no `std::vector` inside the frame.

### 4.2 Bucket cadence

| Quantity | Value | Why |
| --- | --- | --- |
| Bucket size | 64 samples ≈ **1.45 ms @ 44.1 kHz**, **1.33 ms @ 48 kHz** | Matches block boundaries on most hosts; one bucket per inner block at typical block sizes (128–512). |
| Buckets per second | ~700–750 | Comfortable headroom over the 60 Hz UI refresh; gives 12–13 buckets per UI frame to draw or downsample further. |
| Ring depth | 1024 buckets (~1.4 s of history) | Power-of-two for SPSC mask. On overflow, the **new** bucket is dropped (so the producer side has only one writer to `writePos_`, preserving clean SPSC semantics). Audio never blocks. |
| UI poll rate | 30 Hz default, 60 Hz when panel is foreground | Drains all buckets accumulated since last poll. |

### 4.3 Header (shared by all dynamics frames)

```cpp
// engine/src/audio/viz/DynamicsVizFrame.h  (proposed)
namespace xleth::viz {

struct alignas(8) BucketHeader {
    uint64_t sampleClock;   // audio sample index of bucket start
    uint32_t bucketSamples; // number of samples accumulated in this bucket
    uint32_t flags;         // bit 0: clip hit, bit 1: gate active, bit 2: transient onset
};

}
```

`pluginInstanceId` and `trackId` do **not** live inside the bucket — they're the key of the ring (one ring per `(trackId, nodeId)` pair).

### 4.4 Per-plugin payloads

```cpp
// All values in dB unless suffixed _lin. NaN means "not measured this bucket".

struct CompressorBucket {
    BucketHeader hdr;
    float inLevelDb;     // peak |x| over bucket, pre-process
    float outLevelDb;    // peak |y| over bucket, post-process
    float detectorDb;    // envDB at last sample of bucket
    float grDb;          // max GR over bucket (positive = more reduction)
    float ioInDb;        // input level for the moving transfer-curve dot
    float ioOutDb;       // matching output (post knee, pre makeup is fine)
};

struct LimiterBucket {
    BucketHeader hdr;
    float inLevelDb;       // post-input-gain, pre-limit
    float outLevelDb;      // post-limit, post-ceiling clamp
    float truePeakDb;      // 4× oversampled peak over the bucket
    float grDb;            // max GR over bucket
    float momentaryLufs;   // copy of slot 3 at bucket end
    float shortTermLufs;   // copy of slot 4 at bucket end
    uint16_t lookaheadSamples; // mirror of totalLookaheadSamples_
    uint16_t reserved;
};

struct TransientBucket {
    BucketHeader hdr;
    float inLevelDb;
    float outLevelDb;
    float fastEnvDb;
    float slowEnvDb;
    float gainDb;       // signed; +boost / -cut
    // hdr.flags bit 2 marks an onset detected within this bucket.
};

struct MultibandBucket {            // Overdone
    BucketHeader hdr;
    float inLevelDb;
    float outLevelDb;
    float bandLevelDb[3];           // low / mid / high envelope dB
    float bandGrDownDb[3];          // downward GR per band
    float bandGrUpDb[3];            // upward GR per band (currently combined; needs split)
};
```

### 4.5 What's already supported vs. needs new instrumentation

| Field | Status |
| --- | --- |
| `BucketHeader.sampleClock` | New: one `uint64_t` counter per effect instance, incremented in `processBlock`. Trivial. |
| `BucketHeader.flags` | New: derived from existing booleans (`isActive_` for transient, `pk > ceil` for limiter clip). |
| Compressor `detectorDb`, `grDb` | Already computed. New: capture per bucket. |
| Compressor `inLevelDb` | New: one extra `std::max(absL, absR)` at top of inner loop. |
| Compressor `ioInDb / ioOutDb` | Already computed (`envDB`, post-process sample). New: capture last value of bucket. |
| Limiter `truePeakDb` | Already computed locally inside the oversampler loop; new: track bucket-max. |
| Limiter `momentaryLufs`, `shortTermLufs` | Already computed (slots 3/4); new: snapshot per bucket. |
| Limiter `lookaheadSamples` | Already a member; new: copy to bucket. |
| Transient `fastEnvDb / slowEnvDb` | Already computed. New: dB-convert and capture. |
| Transient onset flag | New: rising-edge of `isActive_`, set on first bucket containing the edge. |
| Overdone `bandLevelDb[]`, `bandGrDownDb[]` | Already computed. New: capture per bucket. |
| Overdone `bandGrUpDb[]` | **Requires DSP split**: `computeOTTGainDB` currently returns a combined upward+downward value. Need to return both as a small struct without changing audio output. |

Everything except *Overdone upward/downward split* and *one extra input-peak capture per plugin* is purely **observation** of values the DSP already produces.

---

## 5. Engine-to-UI transport plan

### 5.1 What we are *not* doing

- Not pushing from C++ to JS via threadsafe-functions. Adds a callback path the rest of the engine doesn't have, and the existing pull pattern is plenty fast for 700 buckets/sec drained at 30 Hz.
- Not introducing shared memory for this. Buckets are tiny (40–64 bytes); a single drain at 30 Hz moves on the order of **< 2 KB**. SHM is overkill.
- Not extending `getAllPeaks()`. That is for *every track*; visualization should only be live for *currently open* dynamics editors. Wrong scope.

### 5.2 Layered design

```
[Audio RT thread]
    XlethCompressorEffect::processEffect
        ├── existing DSP (unchanged)
        └── DynamicsVizCollector::accumulate(sample, …)        ← new
                └── on bucket fill: ring.push(CompressorBucket)
                        (lock-free SPSC; full → drop bucket)

[Main thread, called by N-API]
    XlethEffectBase::drainVizFrames(maxBytes, outBuffer)        ← new virtual
        └── drains ring into a contiguous byte buffer

[Bridge]
    audio_drainEffectVizFrames(trackId, nodeId, maxBuckets)
        → ArrayBuffer of N×sizeof(Bucket) bytes
          + small JSON header describing payload type & schema version

[Main process]
    ipcMain.handle('xleth:audio:drainEffectVizFrames', …)

[Preload]
    window.xleth.audio.drainEffectVizFrames(trackId, nodeId, maxBuckets)
        → { type:'compressor'|'limiter'|'transient'|'multiband', schema:1, frames: ArrayBuffer }

[Renderer]
    useDynamicsVizSubscription(trackId, nodeId)
        rAF loop @ 30/60 Hz:
          drain → typed-array view → push tail of ring buffer → invalidate canvases
        React state holds plugin id + schema version only
```

### 5.3 Why a per-effect ring instead of an effect-base array

- The 8-slot meter array is fine for "point" data: bypass, master peak, single GR readout. It cannot hold a history without choosing a fixed bucket count for *every* effect, which inflates memory for non-dynamics effects.
- A **per-instance ring** is allocated only when the editor opens (lazy), torn down on close. Non-dynamics effects pay nothing.
- The collector lives on `XlethEffectBase` as an optional member (`std::unique_ptr<DynamicsVizCollector>`), gated by a `setVisualizationEnabled(bool)` virtual that the bridge toggles when the editor opens / closes. Audio thread checks one pointer; null = zero overhead.

### 5.4 Update rates and back-pressure

- Audio thread: writes ~700 buckets/sec while enabled.
- Main thread drain: 30 Hz default → ~23 buckets per drain. UI may bump to 60 Hz when the panel is foregrounded → ~12 per drain.
- Ring depth 1024 = ~1.4 s of headroom; if the UI stalls, **oldest buckets are dropped** by the producer (`push` returns false). Audio thread *never* blocks. This matches the spec's backpressure rule.
- Schema version is in the JSON header so older renderers don't misinterpret newer struct layouts. Bump on any field change.

### 5.5 Channel ownership question — extend meters or new channel?

**New channel.** The 8-slot meter is for cheap point telemetry and is already wired into mixer-level UI. Don't conflate.

- Keep `getEffectMeter` as-is (the mixer thumbnail meters and Phase 0 panels can still read it).
- New `audio_drainEffectVizFrames` lives next to it, only meaningful for plugins that opt in.

---

## 6. React Canvas component plan

### 6.1 File layout (proposed, not created in this pass)

```
ui/src/components/mixer/dynamics/
    useDynamicsVizSubscription.js     // owns rAF, drain, ring-of-buckets ref
    DynamicsVisualizerCanvas.jsx      // sized, themed canvas wrapper
    TransferCurveView.jsx             // compressor knee/ratio + moving dot
    GainReductionHistoryView.jsx      // scrolling GR strip
    LevelHistoryView.jsx              // input+output history, threshold/ceiling overlay
    BandActivityView.jsx              // Overdone-only: 3-band stacked
    drawing/
        scaling.js                    // dB↔px helpers, time scaling
        theme.js                      // token reads, cached per render
        compressorPainter.js
        limiterPainter.js
        transientPainter.js
        overdonePainter.js
```

### 6.2 Hook contract

```js
const { canvasRef, bufferRef, schema } =
    useDynamicsVizSubscription({ trackId, nodeId, pluginType, history: 1024 })
```

- `bufferRef.current` is a typed-array-backed ring (mutable, never set into React state).
- `canvasRef.current.invalidate()` is the painter trigger; the hook calls it once per rAF tick after draining.
- `pluginType` selects which painter to mount inside `DynamicsVisualizerCanvas`.
- `schema` is the only React-state value; it changes only on engine schema-version bump and forces a full repaint.

### 6.3 Embedding into existing panels

Each existing panel (Compressor/Limiter/TransientProc/OTT) gets a single new region:

```jsx
<div className="comp-viz-region">
  <DynamicsVisualizerCanvas
    trackId={target.trackId}
    nodeId={target.nodeId}
    pluginType="compressor"
  >
    <LevelHistoryView />
    <GainReductionHistoryView overlay />
    <TransferCurveView corner />
  </DynamicsVisualizerCanvas>
</div>
```

The knob grid is untouched. The new region slots in above or below it. Plugin window chrome, store, and IPC unchanged.

### 6.4 Render rules

- All drawing is in `requestAnimationFrame`.
- Painters read tokens once per rAF (cache for the frame).
- React state is touched only on `pluginType`, `schema`, `target`, and panel-level UI settings (e.g., a "freeze" toggle if we add one).
- The hook stops the rAF loop and calls a teardown that toggles `setVisualizationEnabled(false)` on the engine when the panel target becomes `null`.

### 6.5 What we explicitly avoid

- No Web Audio in the renderer. None of this is real-time audio.
- No audio buffers across IPC. Only bucketed POD.
- No `setState` in the rAF tick.

---

## 7. Staged implementation plan

### Phase 1 — Diagnostic + schema (no engine code)

- This document.
- Land `engine/src/audio/viz/DynamicsVizFrame.h` with the four bucket structs, `BucketHeader`, `kSchemaVersion`, and a `static_assert` on size/alignment.
- Land `ui/src/constants/dynamicsViz.js` mirroring the schema version and field offsets.
- No behavior change.

### Phase 2 — Engine instrumentation for Compressor only

- Add `DynamicsVizCollector` (lock-free SPSC ring + bucket accumulator) under `engine/src/audio/viz/`.
- Add to `XlethEffectBase`: `std::unique_ptr<DynamicsVizCollector> vizCollector_`, virtual `setVisualizationEnabled(bool)`, virtual `drainVizFrames(uint8_t* out, size_t maxBytes) → size_t`.
- In `XlethCompressorEffect::processEffect`, when `vizCollector_` is non-null, accumulate per-sample input peak / detector dB / GR / output peak. Push at bucket boundary.
- No DSP changes. `XLETH_DEBUG` build runs `static_assert` on POD-ness.

### Phase 3 — Bridge transport

- Add `audio_drainEffectVizFrames(trackId, nodeId, maxBuckets) → { type, schema, frames: ArrayBuffer }` to `bridge/src/XlethAddon.cpp`.
- Add `audio_setEffectVisualizationEnabled(trackId, nodeId, enabled)` so the UI controls when the audio thread allocates the ring.
- Wire `ipcMain.handle('xleth:audio:drainEffectVizFrames', …)` in `ui/main.js`.
- Expose `window.xleth.audio.drainEffectVizFrames` and `setEffectVisualizationEnabled` in `ui/preload.js`.

### Phase 4 — React Canvas prototype (Compressor)

- Build `useDynamicsVizSubscription` + `DynamicsVisualizerCanvas` shell.
- Build `LevelHistoryView`, `GainReductionHistoryView`, `TransferCurveView`.
- Embed in `CompressorPanel.jsx`. Toggle `setEffectVisualizationEnabled(true)` on mount, `(false)` on unmount.
- Visual parity check against FL Comp 2 / Pro-C reference behavior: scrolling cadence, transfer-curve dot tracking, GR overlay alignment with level history.

### Phase 5 — Apply to Limiter, Transient, Overdone

- Limiter: capture true-peak bucket-max, mirror LUFS slots, lookahead samples; add ceiling line + lookahead readout to `LevelHistoryView`. **Before this phase, fix the unguarded `juce::Logger::writeToLog()` call in `XlethLimiterEffect::updateLookahead` (separate PR, no functional change).**
- Transient: capture fast/slow envelopes + signed gain; new painter that draws fast-env vs slow-env as two traces and the gain trace below.
- Overdone: split `computeOTTGainDB` into upward + downward returns (DSP-equivalent, just observability); new `BandActivityView` with three stacked strips and crossover-Hz markers.

### Phase 6 — Performance validation & polish

- Verify the audio-thread cost (target: < 50 ns per sample added in instrumented effects on a single-core run; per-bucket push ≈ 1 atomic store + 1 release-store).
- Verify no DNxHR seek regression and no compositing regression (existing perf gates).
- Verify A/V drift target unchanged.
- Token-clean any remaining hardcoded colors in dynamics painters.
- Add a `freeze` toggle and a `time window` selector (1 s / 4 s / 10 s) on the visualizer.

---

## 8. Risks and performance guardrails

| Risk | Where | Mitigation |
| --- | --- | --- |
| Allocation in audio thread when ring is created | `setVisualizationEnabled(true)` | Allocation happens on **main thread** before enabling; audio thread only sees a `release`-published pointer. |
| Ring full → audio stalls | ring `push` | `push` returns false on full and **drops the new bucket**. Audio never waits. |
| JSON-string per drain | bridge | Use `ArrayBuffer` for the bucket payload; only the small header is JSON. |
| React re-renders per frame | hook | `bufferRef` is a `useRef`. React state touched only on `target`/`pluginType`/`schema`. |
| Schema drift between C++ and JS | both | `kSchemaVersion` constant in C++ and JS; bridge response carries it; UI bails on mismatch. |
| Theme drift in canvas painters | painters | All colors via `useTokenValue`; cache per rAF tick. |
| Off-screen panels still draining | hook | Drain & rAF loop only run while panel `target` is non-null *and* the window is foreground (use `IntersectionObserver` + `document.hidden`). |
| Limiter unguarded `Logger::writeToLog` | `XlethLimiterEffect.h:182` | **Pre-existing bug.** Fix in a separate, tiny PR before Phase 5. |
| Phase-0 perf floors | DNxHR seek, GPU compositing, A/V drift | Visualization runs only when an editor is open; instrumentation is opt-in per instance. Should not touch render or video paths at all. |
| Plugin-window churn (open/close storms) | bridge | `setEffectVisualizationEnabled` is idempotent. Allocator path is on main thread, not on the audio callback. |

---

## 9. Recommendation: prototype the Compressor first

**Build Phase 2 + 3 + 4 around `XlethCompressorEffect`, then generalise.**

Why:

1. **Most signals are already computed** — `env_`, `peak_`, `envDB`, `grDB` are all there; only one extra `std::max(absL, absR)` per sample is needed for the input-level trace.
2. **No oversampling, no LUFS, no crossover** — the simplest topology in the four. Lets us nail the transport, schema, and drain semantics without DSP complications.
3. **Most familiar visual language** — input/output level history, GR overlay, threshold line, knee/ratio transfer curve, moving I/O dot. This is exactly the Fruity-Limiter/Pro-C language users expect; correctness is easy to eyeball.
4. **No outstanding audio-thread risk to fix first** — Limiter has the unguarded `Logger::writeToLog`; Compressor does not. Compressor lets us start without a parallel cleanup.
5. **Reusable surface** — once Compressor is solid, Limiter is a superset (add true-peak, ceiling line, LUFS readout), Transient is a sibling (different painter, same scaffolding), Overdone is the same scaffolding × 3 bands.

---

## 10. Summary — what the next implementation prompt should change

Concrete code changes for the **Phase 2 + 3 + 4 prompt** (Compressor-only path, end-to-end skeleton):

1. **New header** `engine/src/audio/viz/DynamicsVizFrame.h`
   - Define `BucketHeader`, `CompressorBucket` (only — others can stub later), `kSchemaVersion = 1`.
   - `static_assert` POD + alignment.

2. **New files** `engine/src/audio/viz/DynamicsVizCollector.{h,cpp}`
   - Templated SPSC ring (mirrors `engine/src/TriggerQueue.h` pattern). Power-of-two capacity.
   - `accumulate(...)` advances bucket counters; on `bucketSamples == kBucketSize` it `push()`es and resets.
   - `drain(uint8_t* out, size_t maxBytes) → size_t` is main-thread-only.

3. **`engine/src/audio/XlethEffectBase.h`** edits
   - Add `std::unique_ptr<viz::DynamicsVizCollectorBase> vizCollector_` member.
   - Add `virtual void setVisualizationEnabled(bool)` (default: no-op; concrete plugins override).
   - Add `virtual std::size_t drainVizFrames(uint8_t* out, std::size_t maxBytes)` (default: returns 0).

4. **`engine/src/audio/XlethCompressorEffect.h`** edits
   - Override `setVisualizationEnabled` to lazily construct `DynamicsVizCollector<CompressorBucket>` on the **main** thread, then atomically publish.
   - Inside `processEffect`, if `vizCollector_.load(acquire) != nullptr`, capture `inLevel`, `envDB`, `grDB`, `outLevel`, `ioIn`, `ioOut` per sample; let the collector handle bucketing.
   - **No DSP changes.**

5. **`engine/src/audio/MixEngine.{h,cpp}`** edits
   - `setEffectVisualizationEnabled(trackId, nodeId, bool)` — routes to `EffectChainManager` → `AudioGraph`.
   - `drainEffectVizFrames(trackId, nodeId, maxBuckets)` — same routing, returns raw bytes plus payload type tag.

6. **`bridge/src/XlethAddon.cpp`** edits
   - Export `audio_setEffectVisualizationEnabled(trackId, nodeId, enabled)`.
   - Export `audio_drainEffectVizFrames(trackId, nodeId, maxBuckets) → { type:'compressor', schema:1, frames: ArrayBuffer }`.

7. **`ui/main.js`** edits
   - `ipcMain.handle('xleth:audio:setEffectVisualizationEnabled', …)`.
   - `ipcMain.handle('xleth:audio:drainEffectVizFrames', …)`.

8. **`ui/preload.js`** edits
   - `window.xleth.audio.setEffectVisualizationEnabled(trackId, nodeId, enabled)`.
   - `window.xleth.audio.drainEffectVizFrames(trackId, nodeId, maxBuckets)`.

9. **New JS** `ui/src/constants/dynamicsViz.js`
   - Mirror `kSchemaVersion = 1` and the byte offsets / sizeof for `CompressorBucket`.

10. **New React** `ui/src/components/mixer/dynamics/`
    - `useDynamicsVizSubscription.js` — owns rAF + drain loop + mutable ring buffer.
    - `DynamicsVisualizerCanvas.jsx` — themed canvas wrapper.
    - `LevelHistoryView.jsx`, `GainReductionHistoryView.jsx`, `TransferCurveView.jsx`.

11. **`ui/src/components/mixer/CompressorPanel.jsx`** edits
    - Mount the visualizer region.
    - Toggle `setEffectVisualizationEnabled(true)` on `target` set, `(false)` on unset / unmount.
    - Leave the existing knob grid and slot-2 vertical bar untouched (panel keeps its current behavior; the canvas is additive).

Out of scope for the next prompt (defer): Limiter / Transient / Overdone instrumentation, Overdone upward/downward GR split, Limiter `juce::Logger::writeToLog` cleanup (file separately), `BandActivityView`, freeze / window-length controls.

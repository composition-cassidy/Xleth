# Chorus Effect — Implementation Reference

This document covers every file that makes up the Chorus effect (`pluginId: "chorus"`) — DSP engine, UI panel, store, and wiring — with enough detail to debug any issue without reading all the source code first.

---

## File Map

| File | Layer | Role |
|------|-------|------|
| `engine/src/audio/ChorusEffect.h` | C++ / audio thread | All DSP: delay buffer, LFO, feedback, mix |
| `engine/src/audio/AudioGraph.cpp` | C++ / main thread | Factory registration (line 14 include, line 1354 factory) |
| `ui/src/stores/chorusStore.js` | JS / main thread | Which effect instance is open in the UI |
| `ui/src/components/mixer/ChorusPanel.jsx` | React | Floating editor panel with 7 knobs |
| `ui/src/components/mixer/EffectModule.jsx` | React | Opens the panel on double-click |
| `ui/src/components/mixer/MixerPanel.jsx` | React | Mounts `<ChorusPanel />` in the DOM |
| `ui/src/styles/app.css` (line ~5140) | CSS | `.chorus-panel*` layout rules |

---

## Parameters

| paramId | Range | Default | Step | Unit | Smoothing |
|---------|-------|---------|------|------|-----------|
| `rate` | 0.05–5 | 0.8 | — | Hz | Linear 20 ms (base-class) |
| `depth` | 0–100 | 50 | — | % | Linear 20 ms (base-class) |
| `delay` | 7–30 | 15 | — | ms | Manual one-pole 50 ms (NOT base-class) |
| `feedback` | 0–25 | 0 | — | % | Linear 20 ms (base-class) |
| `voices` | 1–4 | 2 | 1 | — | None — read raw each block |
| `width` | 0–100 | 80 | — | % | Linear 20 ms (base-class) |
| `mix` | 0–100 | 50 | — | % | Linear 20 ms (base-class) |

`delay` and `voices` are deliberately **not** registered with `registerSmoothedParam`. Both are resolved to raw `std::atomic<float>*` pointers in `prepareEffect` and read directly each block.

---

## C++ Implementation: `ChorusEffect.h`

### Class hierarchy

```
juce::AudioProcessor
  └── XlethEffectBase          (bypass crossfade, APVTS, per-block smoothers, metering)
        └── ChorusEffect
```

`XlethEffectBase` calls `prepareEffect`, `processEffect`, and `resetEffect` at the right lifecycle points. `ChorusEffect` only overrides those three.

### Constructor

```cpp
ChorusEffect() : XlethEffectBase("chorus", createLayout())
```

`createLayout()` is a static function that returns the APVTS parameter layout. It runs **before** the base constructor body, so it is safe to use. Immediately after, five smoothers are registered:

```cpp
registerSmoothedParam("rate",     SmoothType::Linear, 20.0f);
registerSmoothedParam("depth",    SmoothType::Linear, 20.0f);
registerSmoothedParam("feedback", SmoothType::Linear, 20.0f);
registerSmoothedParam("width",    SmoothType::Linear, 20.0f);
registerSmoothedParam("mix",      SmoothType::Linear, 20.0f);
```

`delay` is intentionally absent — it uses a manual one-pole updated per sample inside `processEffect`. `voices` is intentionally absent — it is a discrete integer that must not be interpolated.

### Data members

```cpp
juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>
    delayLineL_, delayLineR_;   // one per channel, both mono (1-channel spec)
int maxDelaySamples_ = 0;       // computed in prepareEffect, used as clamp bound

std::atomic<float>* delayPtr_  = nullptr;  // raw APVTS pointer set in prepareEffect
std::atomic<float>* voicesPtr_ = nullptr;

float smoothDelay_      = 15.0f;  // current one-pole state (ms)
float smoothDelayCoeff_ = 0.0f;   // α = 1 - exp(-1 / (0.05 * sr))

float voicePhases_[4] = {};  // radians, 0–2π, one per voice slot
double sampleRate_    = 44100.0;
```

`kMaxVoices = 4` is a compile-time constant. All four phase slots are always maintained — the active count (`numVoices`) just determines how many are read each sample.

### `prepareEffect`

Called by `XlethEffectBase::prepareToPlay`. Order of operations:

1. Store `sampleRate_`.
2. Compute `maxDelaySamples = int(0.035 * sr) + 8`.
   - 35 ms = 30 ms max center delay + 5 ms max mod depth.
   - `+8` gives headroom for Lagrange3rd's 3-sample kernel and floating-point edge cases.
3. `setMaximumDelayInSamples` → `prepare` → `reset` on both delay lines.
   - The `ProcessSpec` always sets `numChannels = 1` because each `DelayLine` is mono.
4. Resolve `delayPtr_` and `voicesPtr_` via `apvts_.getRawParameterValue(...)`.
5. Compute the one-pole coefficient: `α = 1 - exp(-1 / (0.05 × sr))`.
6. Seed `smoothDelay_` from the current parameter value (avoids a 50 ms ramp from 0 on first play).
7. Initialise voice phases evenly: `voicePhases_[v] = v × 2π / 4`.

**Potential issue:** If `prepareEffect` is never called (e.g. the effect is added to the graph after playback has started without re-preparing), `delayPtr_` and `voicesPtr_` remain `nullptr`. Both are null-checked in `processEffect` with fallback values (15 ms, 2 voices).

### `resetEffect`

Called on transport stop/rewind. Clears the delay buffer and resets voice phases to their initial spread. Re-seeds `smoothDelay_` from the current param value.

### `processEffect` — per-sample loop

The entire audio thread work happens here. Called once per block by `XlethEffectBase::processBlock`.

#### Step-by-step per sample

**Block-level reads (before the loop):**
```cpp
const int numVoices = clamp(int(voicesPtr_->load(relaxed)), 1, 4);
const float targetDelay = delayPtr_->load(relaxed);  // ms
```

**Inside the loop:**

**Step 1 — Advance base-class smoothers**
```cpp
float rate     = getNextSmoothedValue("rate");     // Hz
float depth    = getNextSmoothedValue("depth");    // %
float feedback = getNextSmoothedValue("feedback"); // %
float width    = getNextSmoothedValue("width");    // %
float mixPct   = getNextSmoothedValue("mix");      // %
```
Each call advances the linear smoother by one sample and returns the current value.

**Step 2 — One-pole delay smoothing**
```cpp
smoothDelay_ += smoothDelayCoeff_ * (targetDelay - smoothDelay_);
float centerDelaySamples = smoothDelay_ * 0.001f * sr;
float maxModDepthSamples = (depth / 100.0f) * 0.005f * sr;
```
`smoothDelay_` is in milliseconds. The one-pole runs at audio-rate, giving a 50 ms time constant. This avoids the zipper noise that raw parameter jumps would cause.

`maxModDepthSamples` scales `depth` to a maximum of 5 ms of LFO swing. At depth=100%, the LFO can swing ±5 ms around the center.

**Step 3 — Derived constants**
```cpp
float phaseOffsetLR = (width / 100.0f) * π;   // 0 → 0°, 100% → 180°
float fbGain = min(feedback / 100.0f, 0.25f);  // hard cap at 25%
```

The `min(..., 0.25f)` is a safety net — the APVTS parameter already limits `feedback` to 25, but the DSP enforces it independently. Feedback above ~30% with these delay times starts to sound like flanging/self-oscillation.

**Step 4 — Sum voices**
```cpp
for (int v = 0; v < numVoices; ++v) {
    float lfoL = sin(voicePhases_[v]);
    float lfoR = sin(voicePhases_[v] + phaseOffsetLR);

    float dL = clamp(centerDelaySamples + lfoL * maxModDepthSamples, 1.0f, maxDelF);
    float dR = clamp(centerDelaySamples + lfoR * maxModDepthSamples, 1.0f, maxDelF);

    wetL += delayLineL_.popSample(0, dL, false);  // false = don't advance pointer
    wetR += delayLineR_.popSample(0, dR, false);
}
wetL /= numVoices;
wetR /= numVoices;
```

`popSample(channel, delaySamples, updateReadPointer)` with `updateReadPointer=false` reads from a fractional offset behind the current write position **without** advancing the internal buffer position. This is critical: calling `popSample` multiple times in a loop with `true` (the default) would shift the buffer position on each call, causing each voice to read from the wrong position. Setting it to `false` makes each call independent.

The Lagrange3rd interpolation type gives a smooth fractional-sample read. It uses a 3-sample cubic kernel, which is why `maxDelaySamples` gets `+8` headroom.

The clamp lower bound of `1.0f` prevents requesting a delay of 0 or negative samples, which is undefined for the Lagrange interpolator.

**Step 5 — Advance LFO phases**
```cpp
float phaseInc = rate * 2π / sr;
for (int v = 0; v < numVoices; ++v) {
    voicePhases_[v] += phaseInc;
    if (voicePhases_[v] >= 2π) voicePhases_[v] -= 2π;
}
```

All voices advance at the same rate. Their phase separation is fixed at initialisation (evenly spread across one full cycle). This gives a fixed comb structure that doesn't drift.

Phase is in radians, not normalised (0–1). Wrapping via subtraction avoids fmod's overhead.

**Step 6 — Write to delay buffer**
```cpp
delayLineL_.pushSample(0, inputL + fbGain * wetL);
delayLineR_.pushSample(0, inputR + fbGain * wetR);
```

`pushSample` writes to the current write position and advances the write pointer by 1. This must happen **after** the reads (steps 4) or you would be reading the sample you just wrote.

Feedback is mixed in at the write point, not into the output mix. This creates a recirculating loop: the wet signal from this sample feeds into the buffer and will reappear at the read heads several milliseconds later.

**Step 7 — Dry/wet mix**
```cpp
float mixNorm = mixPct / 100.0f;
buffer[L] = inputL * (1 - mixNorm) + wetL * mixNorm;
buffer[R] = inputR * (1 - mixNorm) + wetR * mixNorm;
```

Standard linear mix. At mix=50% (default), dry and wet are equal.

### Voice phase distribution

At 44100 Hz, the 4 voices start at:

| Voice | Initial phase |
|-------|--------------|
| 0 | 0° (0 rad) |
| 1 | 90° (π/2 rad) |
| 2 | 180° (π rad) |
| 3 | 270° (3π/2 rad) |

With `numVoices=2`, only voices 0 and 1 are read (0° and 90°). Voices 2 and 3 still have their phases updated every sample, so switching from 2→4 voices mid-playback gives a natural continuation rather than a phase snap.

### Stereo width mechanics

At `width=0%`, `phaseOffsetLR=0`. L and R read at the exact same LFO position → mono output.
At `width=100%`, `phaseOffsetLR=π`. L reads `sin(φ)`, R reads `sin(φ+π) = -sin(φ)`. The L and R LFOs are in perfect anti-phase → maximum stereo spread.
At `width=80%` (default), `phaseOffsetLR = 0.8π ≈ 144°`. Partial phase separation — wide but not hard-inverted.

### Metering

```cpp
writeMeterValue(0, peakL);  // L wet peak (absolute, per block)
writeMeterValue(1, peakR);  // R wet peak
```

Slot 0 and 1 hold the wet signal peak (not the output mix), so the meter reflects modulation activity rather than output level. Read via `getEffectMeter(nodeId)` from JS.

### Parameter layout detail

```cpp
// NormalisableRange<float>(start, end, interval, skew)
// skew < 1 = more range at the low end (log-ish feel)

rate:     Nar{0.05f, 5.0f,   0.0f, 0.5f}  // 0.5 skew → denser at slow rates
depth:    Nar{0.0f,  100.0f, 0.0f, 1.0f}  // linear
delay:    Nar{7.0f,  30.0f,  0.0f, 1.0f}  // linear
feedback: Nar{0.0f,  25.0f,  0.0f, 1.0f}  // linear
voices:   Nar{1.0f,  4.0f,   1.0f, 1.0f}  // step=1, skew=1 (discrete)
width:    Nar{0.0f,  100.0f, 0.0f, 1.0f}  // linear
mix:      Nar{0.0f,  100.0f, 0.0f, 1.0f}  // linear
```

The `interval=1.0f` on `voices` makes the knob snap to integer values at the APVTS level. The DSP also re-clamps via `std::clamp(int(...), 1, 4)` independently.

---

## Engine Registration: `AudioGraph.cpp`

Two lines wire the effect into the runtime:

**Line 14** (include):
```cpp
#include "audio/ChorusEffect.h"
```

**Line 1354** (factory, inside `createEffect`):
```cpp
if (pluginId == "chorus") return std::make_unique<ChorusEffect>();
```

`createEffect` is called by `addNode` which is called by `addEffect`. If `pluginId == "chorus"` doesn't match, `addEffect` returns `-1` and no node is added to the graph. If the effect ever fails to appear in the chain after being added, this is the first place to check.

---

## JS Store: `ui/src/stores/chorusStore.js`

```js
// State shape
{
  target: { trackId: number, nodeId: number, storeKey: string } | null
}
```

`target` is `null` when the panel is closed. It is set by `open(trackId, nodeId, storeKey)` and cleared by `close()`.

- `trackId`: The mixer track ID. `-1` for the master bus.
- `nodeId`: The `AudioGraph` node UID returned by `addEffect`. Used for all `window.xleth.audio.*` calls.
- `storeKey`: Either `"master"` or a stringified track ID. Used by `EffectModule` to derive `trackId` consistently.

The store is consumed in two places: `ChorusPanel` (reads `target`, calls `close`) and `EffectModule` (calls `open`).

---

## UI Panel: `ChorusPanel.jsx`

### Knob definitions

```js
const KNOBS = [
  { id: 'rate',     min: 0.05, max: 5,   default: 0.8,  fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'depth',    min: 0,    max: 100, default: 50,   fmt: v => `${v.toFixed(0)} %`  },
  { id: 'delay',    min: 7,    max: 30,  default: 15,   fmt: v => `${v.toFixed(1)} ms` },
  { id: 'feedback', min: 0,    max: 25,  default: 0,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'voices',   min: 1,    max: 4,   default: 2,    fmt: v => `${Math.round(v)}`   },
  { id: 'width',    min: 0,    max: 100, default: 80,   fmt: v => `${v.toFixed(0)} %`  },
  { id: 'mix',      min: 0,    max: 100, default: 50,   fmt: v => `${v.toFixed(0)} %`  },
]
```

The `min`/`max` values here are the **UI drag bounds**, not the APVTS bounds. They must match the `NormalisableRange` start/end in `ChorusEffect.h` or the knob will look like it's at the wrong position relative to what the engine reports.

`DEFAULT_PARAMS` is built from the `default` fields and used as the initial state before the engine hydrates on panel open.

### Hydration flow

When `target` changes (panel opens for a specific node):

1. State is reset to `DEFAULT_PARAMS` immediately (shows defaults while loading).
2. `window.xleth.audio.getEffectParameters(trackId, nodeId)` is called — returns a JSON string or array of `{id, name, min, max, default, value, unit}` objects.
3. Each returned parameter whose `id` exists in `DEFAULT_PARAMS` overwrites the local state.
4. The Knob components re-render with the live engine values.

If hydration fails (e.g. the node was removed), the panel shows defaults and logs `[ChorusPanel] hydrate failed:` to the console.

### Parameter writes

```js
const setParam = (id, value) => {
  setParams(prev => ({ ...prev, [id]: value }))
  window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
}
```

Both `onLiveChange` and `onCommit` on the `Knob` call `setParam`. This means the engine receives updates on every drag tick (live change), not just on mouse-up. The base-class smoothers in the engine absorb the high-frequency parameter changes.

### Drag mechanics

`panelPos` is local state initialised to `{ x: innerWidth/2 - 210, y: 80 }`. A `mousedown` on the header sets `panelDragRef.current` with the starting offsets. Global `mousemove`/`mouseup` listeners (attached via `useEffect` once, never re-attached) update `panelPos` on drag and clear the ref on release.

The panel is absolutely positioned via `style={{ left: panelPos.x, top: panelPos.y }}` and `position: fixed` in CSS (so it floats above all other content regardless of scroll).

---

## Effect Module Wiring: `EffectModule.jsx`

```js
// Line 30–32
chorus: (trackId, nodeId, storeKey) => {
  useChorusStore.getState().open(trackId, nodeId, storeKey)
},
```

When a user clicks an effect module whose `pluginId` is `"chorus"`, `handleNameClick` looks up `EFFECT_EDITORS["chorus"]` and calls it. The opener calls `useChorusStore.getState().open(...)` which sets `target` in the store, which causes `ChorusPanel` to render (it returns `null` when `target` is null).

---

## CSS: `app.css` (~line 5140)

```
.chorus-panel        — fixed-position container, 420px wide, z-index 200
.chorus-panel-header — drag handle bar, cursor: grab
.chorus-panel-title  — "Chorus" text
.chorus-panel-close  — X button
.chorus-knob-grid    — 4-column CSS grid, 12px padding, 8px gap
.chorus-knob-cell    — flex center wrapper for each Knob
```

420px width × 4 columns gives ~96px per cell, comfortably fitting the 52px knob size.

---

## Data Flow Diagram

```
User drags a knob
       │
       ▼
ChorusPanel.setParam(id, value)
  ├─► setParams(...)              [React state — UI updates immediately]
  └─► window.xleth.audio
        .setEffectParameter(trackId, nodeId, id, value)
              │
              ▼ (N-API bridge, main thread)
        AudioGraph::setEffectParameter
              │
              ▼
        XlethEffectBase::setParameterValue
              │  param->setValueNotifyingHost(normalised)
              ▼
        APVTS parameter atomic float updated
              │
              ▼ (audio thread, next block)
        processBlock → updateSmootherTargets()
              │  reads APVTS atomic, sets smoother target
              ▼
        processEffect() → getNextSmoothedValue("rate") etc.
              │  returns per-sample interpolated value
              ▼
        DSP loop uses smoothed value
```

```
Panel opens
       │
       ▼
useChorusStore.open(trackId, nodeId, storeKey)
       │  sets target
       ▼
ChorusPanel re-renders (target != null)
       │
       ▼
useEffect [target] fires
       │
       ▼
window.xleth.audio.getEffectParameters(trackId, nodeId)
       │  returns JSON [{id, value, ...}, ...]
       ▼
setParams(merged defaults + engine values)
       │
       ▼
Knobs render with live values
```

---

## Known Constraints and Potential Issues

### 1. `popSample` pointer behaviour — `advancePtr` pattern

`juce::dsp::DelayLine` maintains **separate** `readPos` and `writePos` per channel. `pushSample` moves only `writePos`. `popSample` moves `readPos` when `updateReadPointer=true`. `interpolateSample` computes the read index as `readPos + delayInt` — relative to `readPos`, not `writePos`.

**The broken pattern (using `false` on all voices):** After N samples `writePos = totalSize - N` while `readPos = 0`. A pop with a 15 ms / 660-sample delay reads from absolute index `660` in the circular buffer, but all fresh audio is near index `totalSize - N` — a completely different region. The reads return from the zero-initialised or long-overwritten part of the buffer. The wet signal is silence (or near-silence), so at 50% mix the output sounds like a quieter dry signal with no audible modulation.

**The correct pattern (`advancePtr`):** `readPos` must advance exactly once per sample. In a multi-voice loop, pass `false` for every voice except the last, and `true` for the last. All voices read relative to the same `readPos` anchor (each specifying its own `delayInSamples` offset — correct), and the final voice's `true` bumps `readPos` by 1 *after* its read, keeping it locked to `writePos` for the next sample:

```cpp
const bool advancePtr = (v == numVoices - 1);
wetL += delayLineL_.popSample(0, dL, advancePtr);
wetR += delayLineR_.popSample(0, dR, advancePtr);
```

This is symmetric with how `XlethDelayEffect` works: it calls `popSample(0, delay)` (default `true`) then `pushSample` — one read advancement plus one write advancement per sample.

### 2. `voices` changes mid-playback

When `numVoices` increases (e.g. from 2 to 4), voices 2 and 3 immediately start contributing. Because their phases have been advancing continuously since `prepareEffect`, they will be at a natural position in the cycle. There is no click — the new voices fade in via the `depth` smoother if depth was changed at the same time, but a voices-only change will introduce the new voices at full depth instantly. This is generally inaudible at audio rates.

When `numVoices` decreases (e.g. 4→2), voices 2 and 3 stop contributing to the wet sum but their phases continue advancing. No click — voices simply stop appearing in the average.

### 3. Feedback and stability

The `min(feedback / 100.0f, 0.25f)` cap means feedback is always ≤ 0.25 gain per cycle. At 15 ms center delay and 25% feedback, the loop gain is well below 1.0 and the signal will never self-oscillate. If this cap were removed or the delay were reduced to near-zero (which the parameter range prevents), instability could occur.

The delay range is intentionally clamped to 7–30 ms to keep the effect in chorus territory. Shorter delays combined with feedback produce flanging.

### 4. Mono input

If `numCh == 1`, `inputR = inputL`. The L and R delay lines still both process — they just receive the same input. With `width > 0`, they produce different outputs (different LFO phases), so a mono input becomes stereo output. This is correct chorus behaviour.

### 5. Buffer boundary on `voices` clamp

`maxDelF = float(maxDelaySamples_ - 2)` not `- 1` because Lagrange3rd needs to read `delayInSamples + 1` positions ahead of the write pointer. Using `- 2` keeps the interpolation kernel within allocated memory. If `maxDelaySamples_` is ever 0 (e.g. `prepareEffect` was never called), `maxDelF` would be `-2` and the clamp would malfunction. The `prepareEffect` null-pointer guard prevents this scenario.

### 6. One-pole delay vs. `SmoothedValue`

The `delay` parameter intentionally does **not** use `registerSmoothedParam`. The base-class's `updateSmootherTargets` is called once per block, giving block-rate updates. The one-pole in the audio loop gives sample-rate smoothing with a 50 ms time constant. Using `SmoothedValue` would give block-rate steps with linear interpolation between them, which at e.g. 64-sample blocks would produce 689 Hz staircase artefacts on the delay time — audible as zipper noise.

### 7. CSS panel width vs. knob count

The panel is 420px wide with a 4-column grid. 7 knobs fill row 1 (4 knobs) and row 2 (3 knobs). The 4th cell in row 2 is empty — this is expected and intentional. If an 8th knob is ever added, the layout fills naturally.

---

## Debugging Checklist

**No effect (signal passes through unchanged):**
- Check `AudioGraph::createEffect` line 1354 — does `pluginId == "chorus"` match?
- Check `mix` parameter — default is 50%, but if it was somehow set to 0 the wet signal would be inaudible.
- Check bypass state: `isBypassed()` on the `XlethEffectBase`.
- Add `XLETH_DEBUG` define and look for `[Chorus] prepareToPlay` log on engine start.

**Clicking or zipper noise on delay changes:**
- Verify `smoothDelayCoeff_` is non-zero (requires `prepareEffect` to have run at correct sample rate).
- Check that `delay` is not registered with `registerSmoothedParam` (should not be).

**Chorus sounds mono:**
- Check `width` parameter value — at 0%, phaseOffsetLR = 0 → mono.
- Confirm `numCh > 1` path is reached (buffer must have 2 channels coming in from the graph).

**Silent or near-silent wet signal (effect sounds like a quieter dry signal):**
- This is the `readPos`/`writePos` divergence bug. Check that the voice loop uses `advancePtr = (v == numVoices - 1)` and passes it to both `delayLineL_.popSample` and `delayLineR_.popSample`. Using `false` on all voices freezes `readPos` at 0 while `writePos` marches to `totalSize - N` — all reads return from a stale buffer region.

**All voices sound identical / no thickening:**
- Check `voicePhases_` spread — if all phases are 0, all voices read the same position. Phases should be initialised to `v * 2π / kMaxVoices` in `prepareEffect`.

**Feedback runaway / self-oscillation:**
- Check the `min(feedback / 100.0f, 0.25f)` cap is intact.
- Check that the `delay` parameter range enforces a 7 ms minimum.

**Panel opens but shows wrong values:**
- Check `window.xleth.audio.getEffectParameters` returns data — open devtools and check the `[ChorusPanel] hydrate failed:` console warning.
- Confirm the parameter `id` strings in `KNOBS` exactly match the APVTS `paramID` strings in `createLayout()`.

**Clicking an effect module opens nothing:**
- Check `EFFECT_EDITORS["chorus"]` entry exists in `EffectModule.jsx`.
- Check `<ChorusPanel />` is rendered inside `MixerPanel.jsx`.
- Check `useChorusStore` — if `target` is null, the panel returns `null`.

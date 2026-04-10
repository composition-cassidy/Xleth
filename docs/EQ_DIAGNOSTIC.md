# Parametric EQ Implementation Pipeline -- Canonical Reference

> This document maps every layer of the Xleth Parametric EQ (pluginId: `"xletheq"`)
> from C++ DSP through N-API bridge to React UI. It serves as the **reference
> architecture** for implementing all remaining stock effects.

---

## 1. C++ AudioProcessor Subclass

### File & Class
- **File:** `engine/src/audio/XlethEQEffect.h` (single header, ~1500 lines)
- **Class:** `XlethParametricEQ` extends `XlethEffectBase`
- **pluginId:** `"xletheq"`

### Base Class: `XlethEffectBase`
- **File:** `engine/src/audio/XlethEffectBase.h` (~410 lines)
- Extends `juce::AudioProcessor` with stereo I/O buses
- **ALL effects must inherit from this class**

#### Base Constructor Pattern
```cpp
explicit XlethEffectBase(
    const std::string& pluginId,
    juce::AudioProcessorValueTreeState::ParameterLayout layout = {})
    : AudioProcessor(BusesProperties()
          .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    , pluginId_(pluginId)
    , apvts_(*this, nullptr, "State", std::move(layout))
{}
```

### APVTS Parameter Declaration

Parameters are declared in a static `createLayout()` factory that returns a `ParameterLayout`. The EQ declares 13 params per band x 16 bands + 2 globals = 210 params total.

#### Naming Convention
```
b{bandIndex}_{paramName}    -- per-band params (e.g. b0_freq, b3_gain)
{globalName}                -- global params (e.g. linphase, oversample)
```

#### Parameter Ranges, Defaults, Skew
```cpp
// Frequency: 20-20kHz, skew 0.23 (midpoint maps to ~1kHz)
juce::NormalisableRange<float>(20.0f, 20000.0f, 0.0f, kFreqSkew)  // default 1000.0f

// Gain: -30 to +30 dB, linear (no skew)
juce::NormalisableRange<float>(-30.0f, 30.0f)                      // default 0.0f

// Q: 0.1-30, skew 0.18 (midpoint maps to ~0.7)
juce::NormalisableRange<float>(0.1f, 30.0f, 0.0f, kQSkew)         // default 0.707f

// Discrete (step=1): type (0-6), enabled (0/1), mode (0-2), oversample (0-2)
juce::NormalisableRange<float>(0.0f, 6.0f, 1.0f)                  // step=1 → discrete

// Units via: juce::AudioParameterFloatAttributes().withLabel("Hz")
```

**Pattern for new effects:** Use `juce::AudioParameterFloat` for everything (even booleans/enums -- use step=1 for discrete). Use `ParameterID{ name, 1 }` (version 1). Use `.withLabel()` for units.

### Smoothing System (Base Class)

Three smoothing types available via `registerSmoothedParam()`:

```cpp
// Register in subclass constructor:
registerSmoothedParam("paramId", SmoothType::Linear, 20.0f);        // 20ms linear ramp
registerSmoothedParam("paramId", SmoothType::Multiplicative, 30.0f); // 30ms multiplicative
registerSmoothedParam("paramId", SmoothType::OnePole, 50.0f);       // 50ms IIR filter

// Read in processEffect() inner loop:
float val = getNextSmoothedValue("paramId");  // advances by 1 sample
```

The base resolves APVTS raw pointers in `prepareToPlay()`, updates targets once per block in `processBlock()`, and advances smoothers when bypassed.

**EQ DEVIATION:** The EQ does NOT use the base smoothing system. Instead, it manages its own per-band `SmoothedValue` members directly:
```cpp
// In BandState:
juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative> freqSmooth; // 30ms
juce::SmoothedValue<float, juce::ValueSmoothingTypes::Linear>         gainSmooth; // 20ms
juce::SmoothedValue<float, juce::ValueSmoothingTypes::Multiplicative> qSmooth;    // 30ms

// In processEffect() -- skip to end-of-block:
bs.freqSmooth.setTargetValue(std::max(freq, 20.0f));
float smoothFreq = bs.freqSmooth.skip(numSamples);
```

**Guidance for simpler effects:** Use the base `registerSmoothedParam()` + `getNextSmoothedValue()` system. Only manage smoothers directly if you need per-band or per-voice smoothing arrays.

### processBlock() Structure (Base Class)

```cpp
void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
{
    juce::ScopedNoDenormals noDenormals;       // 1. Denormal guard
    const bool wantBypass = bypassed_.load();   // 2. Read bypass state
    updateSmootherTargets();                    // 3. Pull APVTS values into smoothers

    // Fast paths
    if (!wantBypass && bypassMix_ <= 0.0f)      // Fully wet
    { processEffect(buffer); return; }
    if (wantBypass && bypassMix_ >= 1.0f)       // Fully dry
    { advanceSmoothers(numSamples); return; }

    // Crossfade path: save dry → process wet → blend per-sample
    dryBuffer_.copyFrom(ch, 0, buffer, ch, 0, numSamples);
    processEffect(buffer);
    // Per-sample 5ms ramp: dry * bypassMix + wet * (1 - bypassMix)
}
```

**Key:** `processEffect()` is ALWAYS called during crossfade so internal state stays consistent. The subclass never needs to handle bypass itself.

### processEffect() Structure (EQ-specific)

```cpp
void processEffect(juce::AudioBuffer<float>& buffer) override
{
    // 1. Read band modes + enabled flags from APVTS atomics
    // 2. Read global mode state (linPhase, oversample)
    // 3. Dynamic EQ sidechain analysis (if any dynamic bands)
    //    - Bandpass filter input → RMS → threshold → attack/release envelope → GR
    // 4. Update smoother targets + recompute biquad coefficients (once per block)
    // 5. Pre-EQ spectrum tap (write to SPSC ring for analysis thread)
    // 6. STFT Spectral Dynamics (if any spectral bands, !linPhase)
    // 7. Update reported latency
    // 8. Processing path (one of three):
    //    a. Linear Phase FIR convolution (linPhase=true)
    //    b. Oversampled biquad cascade (OS>0, !linPhase, !spectral)
    //    c. Standard biquad cascade (default path)
    // 9. Post-EQ spectrum tap
    // 10. Metering: writeMeterValue(0, L_peak); writeMeterValue(1, R_peak);
}
```

#### Standard Biquad DSP Loop (the pattern most effects will follow)
```cpp
for (int ch = 0; ch < numCh; ++ch)
{
    float* data = buffer.getWritePointer(ch);
    for (int s = 0; s < numSamples; ++s)
    {
        float x = data[s];
        for (int b = 0; b < count; ++b)
        {
            auto& bs = bands_[b];
            if (!bs.enabled || bs.mode == 2) continue;
            // DFII Transposed biquad
            float y  = bs.b0 * x + bs.z1[ch];
            bs.z1[ch] = bs.b1 * x - bs.a1 * y + bs.z2[ch];
            bs.z2[ch] = bs.b2 * x - bs.a2 * y;
            x = y;
        }
        data[s] = x;
    }
}
```

### prepareEffect() Pattern

```cpp
void prepareEffect(double sampleRate, int maxBlockSize) override
{
    sampleRate_.store(sampleRate);

    // 1. Resolve APVTS raw param pointers: apvts_.getRawParameterValue("paramId")
    // 2. Initialise smoothers: smoother.reset(sampleRate, rampTimeInSeconds)
    // 3. Initialise DSP state (filters, buffers, FFT instances)
    // 4. Initialise oversamplers (if applicable)
    // 5. Initialise spectrum analyzer (ring buffers, FFT, background thread)
    // 6. Set initial latency: setLatencySamples(0)
}
```

### resetEffect() Pattern
```cpp
void resetEffect() override
{
    // Clear all filter state (z1, z2 etc.) -- DO NOT reset params
    for (int i = 0; i < kMaxBands; ++i)
        bands_[i].clearState();
}
```

### Latency Reporting
```cpp
int getLatencySamples() const
{
    int lat = 0;
    if (hasSpectralBands_) lat += kSTFTHop;           // 2048 samples for STFT
    if (linPhaseActive_) lat += firLength_ / 2;       // FIR group delay
    if (currentOSFactor_ > 0) lat += os->getLatencyInSamples(); // oversampler
    return lat;
}
```
Latency is updated dynamically in `processEffect()` and the graph recomputes PDC via `AudioGraph::computePDC()`.

### Bypass Implementation
- **YES, crossfade-based** -- 5ms linear ramp (confirmed in base class)
- `bypassRampPerSample_ = 1.0f / (sampleRate * 0.005)`
- Per-sample blend: `dry * bypassMix + wet * (1.0 - bypassMix)`
- Subclass `processEffect()` is always called during transitions

### Metering
- 4 atomic float slots per effect (defined in base)
- Audio thread writes via `writeMeterValue(slot, value)` with `memory_order_relaxed`
- EQ uses slots 0,1 for L/R output peak magnitude
- Additional per-band GR metering via separate `bandGR_[16]` atomic array (EQ-specific)

### Registration

Effects are registered in `AudioGraph::createEffect()` (`engine/src/audio/AudioGraph.cpp:1326`):

```cpp
std::unique_ptr<XlethEffectBase> AudioGraph::createEffect(const std::string& pluginId)
{
    if (pluginId == "testgain")      return std::make_unique<TestGainEffect>();
    if (pluginId == "xletheq")       return std::make_unique<XlethEQEffect>();
    // ... etc
    return nullptr;
}
```

**To add a new effect:** Add one `if` line here + `#include` the header.

---

## 2. Graph Integration

### How Effects Get Added as Nodes

```
UI: EffectChainPanel "+" button
 → effectChainStore.addEffect(key, pluginId)
 → window.xleth.audio.addEffect(trackId, pluginId, position)
 → ipcRenderer.invoke → main process → native addon
 → Audio_AddEffect() in XlethAddon.cpp
 → MixEngine::addEffect(trackId, pluginId, position)
 → EffectChainManager::addEffect(pluginId, position)
 → AudioGraph::addEffect(pluginId, position)  // chain-mode wrapper
 → AudioGraph::addNode(pluginId)
   1. createEffect(pluginId)  → std::unique_ptr<XlethEffectBase>
   2. effect->setPlayConfigDetails(2, 2, sampleRate, blockSize)
   3. effect->prepareToPlay(sampleRate, blockSize)
   4. graph_->addNode(std::move(effect))  // JUCE AudioProcessorGraph
   5. Store in nodes_ map with uid
   6. rebuildChainConnections()  // wire Input→FX1→FX2→...→Output
```

### Chain-Mode Connections (Linear Chain)

`AudioGraph::addEffect()` maintains a linear order vector (`linearOrder_`). After any add/remove/move, it calls `rebuildChainConnections()` which:

1. Removes all existing APG connections
2. Wires: AudioInput → Effect[0] → Effect[1] → ... → Effect[N-1] → AudioOutput
3. Each connection is stereo (channels 0,1)
4. Inserts `WireGainProcessor` nodes if wire gain != 1.0
5. Inserts `DelayCompensationProcessor` nodes for PDC

### Bypass, Removal, Reorder Commands

All flow through the same N-API → MixEngine → EffectChainManager → AudioGraph path:

- **Bypass:** `AudioGraph::setBypass(nodeId, bool)` → calls `effect->setBypassed(b)` (atomic flag)
- **Remove:** `AudioGraph::removeEffect(nodeId)` → removes from linearOrder, rebuilds connections
- **Reorder:** `AudioGraph::moveEffect(nodeId, newPos)` → reorder linearOrder, rebuild connections

### Serialization Format

`AudioGraph::toJSON()` produces:
```json
{
  "nodes": [
    {
      "nodeId": 42,
      "pluginId": "xletheq",
      "x": 0.0, "y": 0.0,
      "bypassed": false,
      "state": "<base64 of APVTS XML>"
    }
  ],
  "connections": [
    { "source": 42, "dest": 43, "gain": 1.0, "muted": false }
  ]
}
```

**State blobs:** Each effect's state is serialized via `getStateInformation()` → APVTS XML → base64. The EQ overrides this to also store `bandCount` as an XML attribute.

**Deserialization:** `fromJSON()` clears the graph, re-creates nodes via `addNode(pluginId)`, restores state via `setStateInformation()`, then re-creates connections with gain/mute values.

---

## 3. Node-API Bridge

### File
- **File:** `bridge/src/XlethAddon.cpp` (~6400 lines, single file)
- Entry point: `NODE_API_MODULE(xleth_native, Init)` at line 6393

### Generic Effect Operations (used by ALL effects)

| N-API Function | JS Name | Signature |
|---|---|---|
| `Audio_AddEffect` | `audio_addEffect` | `(trackId, pluginId, position) → {nodeId}` |
| `Audio_RemoveEffect` | `audio_removeEffect` | `(trackId, nodeId) → void` |
| `Audio_MoveEffect` | `audio_moveEffect` | `(trackId, nodeId, newPos) → void` |
| `Audio_SetEffectBypass` | `audio_setEffectBypass` | `(trackId, nodeId, bypassed) → void` |
| `Audio_GetEffectChain` | `audio_getEffectChain` | `(trackId) → JSON string` |
| `Audio_GetEffectParameters` | `audio_getEffectParameters` | `(trackId, nodeId) → JSON string` |
| `Audio_SetEffectParameter` | `audio_setEffectParameter` | `(trackId, nodeId, paramId, value) → void` |
| `Audio_GetEffectMeter` | `audio_getEffectMeter` | `(trackId, nodeId) → JSON "[f,f,f,f]"` |

Master variants exist for all (e.g. `Audio_AddMasterEffect` with no trackId).

### EQ-Specific Operations (unique to EQ, not shared)

| N-API Function | JS Name | Purpose |
|---|---|---|
| `Audio_EQ_AddBand` | `audio_eqAddBand` | `(trackId, nodeId) → bandIndex` |
| `Audio_EQ_RemoveBand` | `audio_eqRemoveBand` | `(trackId, nodeId, bandIndex) → bool` |
| `Audio_EQ_SetBandParam` | `audio_eqSetBandParam` | `(trackId, nodeId, bandIndex, paramName, value) → bool` |
| `Audio_EQ_GetBands` | `audio_eqGetBands` | `(trackId, nodeId) → JSON array` |
| `Audio_EQ_GetResponseCurve` | `audio_eqGetResponseCurve` | `(trackId, nodeId) → Float32Array(512)` |
| `Audio_EQ_GetSpectrumData` | `audio_eqGetSpectrumData` | `(trackId, nodeId) → {post, pre?}` |
| `Audio_EQ_GetBandGR` | `audio_eqGetBandGR` | `(trackId, nodeId) → Float32Array(16)` |
| `Audio_EQ_SetGlobalParam` | `audio_eqSetGlobalParam` | `(trackId, nodeId, paramName, value) → bool` |
| `Audio_EQ_GetGlobalParams` | `audio_eqGetGlobalParams` | `(trackId, nodeId) → JSON {linphase, oversample}` |
| `Audio_EQ_SetPreSpectrum` | `audio_eqSetPreSpectrum` | `(trackId, nodeId, enabled) → bool` |
| `Audio_EQ_GetSampleRate` | `audio_eqGetSampleRate` | `(trackId, nodeId) → number` |

#### EQ Helper Pattern (dynamic_cast)
```cpp
static XlethParametricEQ* getEQ(Napi::Env env, int trackId, int nodeId)
{
    auto* base = (trackId < 0)
        ? audioEngine->getMixEngine().getMasterEffectPtr(nodeId)
        : audioEngine->getMixEngine().getEffectPtr(trackId, nodeId);
    if (!base) return nullptr;
    return dynamic_cast<XlethParametricEQ*>(base);
}
```

**Pattern for new effects with custom N-API:** Create a similar `getMyEffect()` helper that `dynamic_cast`s from `XlethEffectBase*` to your subclass. Only needed if the effect has operations beyond generic parameter/meter access.

### Parameter Flow: JS → Audio Thread

```
JavaScript: window.xleth.audio.setEffectParameter(trackId, nodeId, paramId, value)
  ↓ ipcRenderer.invoke
Electron main: ipcMain handler
  ↓ native addon call
N-API: Audio_SetEffectParameter  [main thread]
  ↓ extract args, validate
MixEngine::setEffectParameter    [main thread, mutex lock]
  ↓ chain lookup
EffectChainManager → AudioGraph::setEffectParameter
  ↓
XlethEffectBase::setParameterValue
  ↓ param->setValueNotifyingHost(rp->convertTo0to1(value))
JUCE APVTS                      [atomic update, main→audio thread safe]
  ↓
Audio thread: smoother reads atomic, ramps to new value over 20-30ms
```

### Metering Flow: Audio Thread → JS

```
Audio thread: effect->writeMeterValue(slot, value)
  ↓ meterSlots_[slot].store(value, memory_order_relaxed)  [lock-free]

JavaScript (polling at 30ms): window.xleth.audio.getEffectMeter(trackId, nodeId)
  ↓ ipcRenderer.invoke
N-API: Audio_GetEffectMeter  [main thread]
  ↓ mutex lock on chain map
XlethEffectBase::getMeterAsJSON()
  ↓ atomic load × 4 slots → JSON "[f,f,f,f]"
```

**No ring buffer, no async worker.** Metering is simple atomic reads polled by the UI.

### Thread Safety Summary

| Boundary | Mechanism |
|---|---|
| Main → Audio (params) | APVTS atomic float + SmoothedValue ramp |
| Audio → Main (meters) | `std::atomic<float>` with `memory_order_relaxed` |
| Main thread chain access | `std::mutex chainsMutex_` in MixEngine |
| Audio thread chain access | `try_lock` -- skips processing if mutex busy |
| Audio → Analysis (spectrum) | SPSC ring buffer + atomic write index (acquire/release) |
| Analysis → Main (spectrum) | Double-buffered output + atomic read index |

### N-API Error Handling Pattern

All functions follow this template:
```cpp
Napi::Value Audio_SomeFunction(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (!isInitialised()) {
        Napi::Error::New(env, "Engine not initialised.").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < N || !info[0].IsNumber() /* ... */) {
        Napi::TypeError::New(env, "function_name(arg1: type, arg2: type)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    // Extract args, call engine, return result
}
```

### N-API Registration Pattern

In the `Init()` function at the end of XlethAddon.cpp:
```cpp
exports.Set("audio_eqAddBand", Napi::Function::New(env, Audio_EQ_AddBand));
```

---

## 4. React UI

### Effect Chain Panel
- **File:** `ui/src/components/mixer/EffectChainPanel.jsx` (204 lines)
- Renders list of `EffectModule` components
- "+" button opens nested `TrackContextMenu` with effect categories:
  ```
  Dynamics:    compressor, limiter, overdone, transientproc
  EQ & Filter: xletheq, xlethfilter
  Distortion:  distortion, waveshaper
  Modulation:  uniflange, chorus, flanger, phaser, phanjer
  Time:        delay, reverb
  Utility:     smartbalance, testgain
  ```
- Supports drag-to-reorder (local state → `moveEffect()` on drop)
- Chain/Node mode toggle

### Effect Module (Collapsed Box)
- **File:** `ui/src/components/mixer/EffectModule.jsx` (103 lines)
- Shows plugin name (via `PLUGIN_NAMES` dict mapping pluginId → display name)
- Bypass toggle (Power icon)
- Right-click → Delete context menu
- Click name → opens EQ panel (currently only for `pluginId === 'xletheq'`)

### EQ Panel (Expanded Editor)
- **File:** `ui/src/components/mixer/EqPanel.jsx` (613 lines)
- Floating/draggable panel opened from EffectModule click
- SVG-based visualization (640x280px):
  - Response curve path (512-point)
  - Post-EQ spectrum analyzer
  - Pre-EQ spectrum (optional overlay)
  - Draggable band dots with frequency/gain/Q adjustment
  - Per-band gain reduction rings
- **30fps polling loop** via `requestAnimationFrame`:
  ```
  fetchResponseCurve()  → Float32Array(512) → SVG path
  fetchSpectrumData()   → { post, pre } → SVG paths
  fetchBandGR()         → Float32Array(16) → dot rings
  ```
- Interaction: drag dots for freq/gain, scroll wheel for Q, click response curve to add band

### State Stores (Zustand)

#### effectChainStore.js
- **File:** `ui/src/stores/effectChainStore.js` (108 lines)
- `chains: { [key]: [{nodeId, pluginId, position, bypassed}] }`
- Dual IPC dispatch: `ipc(key, trackFn, masterFn, ...args)`
- Optimistic updates with fallback `fetchChain()` on complete
- Subscribes to `window.xleth.onGraphChanged` for cross-window sync

#### eqStore.js
- **File:** `ui/src/stores/eqStore.js` (161 lines)
- `target: { trackId, nodeId, storeKey }` -- which EQ instance is open
- `bands: [{ index, freq, gain, q, type, enabled, mode, dyn_*, spec_* }]`
- Optimistic `setBandParam()` updates

### Bridge/Preload Layer
- **File:** `ui/preload.js` (313 lines)
- Exposes `window.xleth` object via `ipcRenderer.invoke`
- All effect and EQ methods available under `window.xleth.audio.*`

### Component Hierarchy
```
MixerPanel
  ├── MixerStrip (per track)
  │   ├── EffectChainPanel ← effect chain list
  │   │   └── EffectModule[] ← individual effect boxes
  │   ├── PeakMeter ← 60fps canvas meter from peaksSnapshot
  │   └── VolumeFader
  ├── MasterStrip
  │   └── (same as MixerStrip but routes to master variants)
  └── EqPanel ← floating, opens when EQ effect module clicked
```

---

## 5. Instance Switching Integration

**No explicit parameter snapshot system exists.** Each track has its own `EffectChainManager` instance (stored in `MixEngine::effectChains_` map keyed by trackId). Master has its own separate chain. Parameters live in each effect's APVTS and are fetched live via IPC.

**State persistence is handled by graph serialization:** `AudioGraph::toJSON()` captures each effect's APVTS XML as base64 state blobs. On project load, `fromJSON()` restores them.

---

## 6. Deviations and Missing Pieces

### Confirmed Implementations (matching spec)
- [x] Crossfade bypass: 5ms linear ramp in base class
- [x] ScopedNoDenormals: in base `processBlock()`
- [x] SmoothedValue on continuous params: freq (Mult 30ms), gain (Linear 20ms), Q (Mult 30ms)
- [x] 4-slot atomic metering system
- [x] APVTS-backed parameters with XML serialization
- [x] PDC (Plugin Delay Compensation) in AudioGraph

### EQ-Specific Smoothing (DEVIATION from base pattern)
The EQ manages its own per-band `SmoothedValue` members directly in `BandState` rather than using the base class `registerSmoothedParam()` system. This is because the base system uses a flat `std::unordered_map<string, SmoothedEntry>` which is appropriate for effects with a fixed, small number of parameters but awkward for 16 bands x 3 smoothed params = 48 smoothers.

**Recommendation for simpler effects:** Use the base `registerSmoothedParam()` system. Only manage smoothers directly if you have dynamic band/voice counts.

### EQ-Specific N-API Functions
The EQ has 11 dedicated N-API functions for band management, spectrum data, and response curves. **Simpler effects will NOT need custom N-API functions** -- the generic `getEffectParameters`, `setEffectParameter`, and `getEffectMeter` are sufficient for most effects. Only add custom N-API functions if the effect has:
- Dynamic element counts (like EQ bands)
- High-frequency bulk data output (like spectrum analyzers)
- Custom data structures beyond flat parameter lists

### UI Gaps
- Only the EQ has an expanded editor panel. Other effects show only the collapsed `EffectModule` box with bypass toggle. Each new effect will need its own editor panel.
- `EffectModule.jsx` currently hardcodes `if (pluginId === 'xletheq')` to open the EQ panel. This needs to be generalized to a dispatch/registry for new effects.

### Background Analysis Thread
The EQ runs a dedicated `std::thread` for spectrum analysis (FFT on ring buffer data). Most effects will NOT need a background thread. If an effect needs one (e.g., a spectrum-aware effect), follow the EQ's pattern:
- SPSC ring buffer (audio thread writes, analysis thread reads)
- `std::atomic<int>` write index with acquire/release semantics
- Double-buffered output with atomic read index
- Thread started in `prepareEffect()`, stopped in `releaseEffect()` and destructor

### Coefficients Recomputed Per Block (not per sample)
The EQ computes biquad coefficients once per audio block from end-of-block smoothed values (`skip(numSamples)`), not per sample. This is a performance optimization. The smoothers still ramp, but coefficient computation is block-rate. For most effects, block-rate coefficient updates are sufficient and recommended.

### Effect Chain Limit
- Max 100 effects per chain (enforced in UI)
- Max nodes in graph: `kMaxNodes` in AudioGraph.h

### XlethEQEffect.h includes XlethEffectBase.h
The EQ effect header-only file directly `#include`s the base. The compiled `XlethEQEffect` class used in `AudioGraph.cpp` is actually a typedef/include indirection:
```cpp
// In AudioGraph.cpp includes section:
#include "audio/XlethEQEffect.h"  // which includes XlethEffectBase.h
```

The `XlethEQEffect` symbol in the factory is the same as `XlethParametricEQ` (the header declares the class as `XlethParametricEQ` but `AudioGraph.cpp` instantiates `XlethEQEffect` -- check include guards for typedef).

### Graph Mode vs Chain Mode
Effects can be wired in arbitrary graph topologies (fan-in/fan-out) via the NodeEditor, not just linear chains. The graph system supports:
- Cycle rejection (DFS before `addConnection`)
- Topological sort (Kahn's BFS with level grouping)
- Per-wire gain (0-2.0, SmoothedValue 20ms) and mute
- 50ms debounced rebuild for graph-mode mutations
- Chain-mode operations (add/remove/move) trigger immediate rebuild

---

## 7. Checklist: Adding a New Stock Effect

1. **C++ Header** (`engine/src/audio/MyEffect.h`):
   - Inherit from `XlethEffectBase`
   - Constructor: call base with `pluginId` and `createLayout()` result
   - `createLayout()`: static factory returning `ParameterLayout`
   - Register smoothers in constructor: `registerSmoothedParam(...)`
   - Implement `prepareEffect()`: resolve raw param pointers, init DSP state
   - Implement `processEffect()`: read smoothed params, DSP loop, write meters
   - Implement `resetEffect()`: clear filter state
   - Override `getLatencySamples()` if effect introduces latency

2. **Register in Factory** (`engine/src/audio/AudioGraph.cpp:1326`):
   - Add `#include "audio/MyEffect.h"`
   - Add `if (pluginId == "myeffect") return std::make_unique<MyEffect>();`

3. **N-API Bridge** (`bridge/src/XlethAddon.cpp`):
   - For simple effects: NO changes needed (generic param/meter functions work)
   - For complex effects: add typed N-API functions + registration in `Init()`

4. **Preload** (`ui/preload.js`):
   - For simple effects: NO changes needed
   - For complex effects: add IPC handlers matching new N-API functions

5. **Electron Main** (`ui/main.js`):
   - For simple effects: NO changes needed
   - For complex effects: add `ipcMain.handle()` entries forwarding to native addon

6. **UI Store** (`ui/src/stores/`):
   - For simple effects: effectChainStore already handles add/remove/bypass/reorder
   - For complex effects: create `myEffectStore.js` following eqStore pattern

7. **UI Panel** (`ui/src/components/mixer/`):
   - Create `MyEffectPanel.jsx` with parameter controls
   - Add dispatch case in `EffectModule.jsx` to open the panel

8. **Effect Menu** (`ui/src/components/mixer/EffectChainPanel.jsx`):
   - Already registered if pluginId exists in `EFFECT_CATEGORIES` constant
   - Verify your pluginId is listed under the correct category

---

## 8. File Index

### C++ Engine
| File | Purpose |
|---|---|
| `engine/src/audio/XlethEffectBase.h` | Base class for all effects (APVTS, smoothing, bypass, metering) |
| `engine/src/audio/XlethEQEffect.h` | Parametric EQ implementation (1500 lines) |
| `engine/src/audio/AudioGraph.h` | Graph topology, PDC, connection management (246 lines) |
| `engine/src/audio/AudioGraph.cpp` | Graph implementation + effect factory (1346 lines) |
| `engine/src/audio/EffectChainManager.h/cpp` | Thin wrapper around AudioGraph |
| `engine/src/audio/MixEngine.h/cpp` | Multi-track mixer, per-track effect chains |
| `engine/src/audio/WireGainProcessor.h` | Per-wire gain node (SmoothedValue 20ms) |
| `engine/src/audio/DelayCompensationProcessor.h` | Ring-buffer delay for PDC |
| `engine/test/test_effects.cpp` | Unit tests for base class and EQ |

### N-API Bridge
| File | Purpose |
|---|---|
| `bridge/src/XlethAddon.cpp` | All N-API functions (~6400 lines) |

### React UI
| File | Purpose |
|---|---|
| `ui/preload.js` | window.xleth API exposure (313 lines) |
| `ui/src/components/mixer/EffectChainPanel.jsx` | Effect chain list + add menu |
| `ui/src/components/mixer/EffectModule.jsx` | Single effect collapsed box |
| `ui/src/components/mixer/EqPanel.jsx` | EQ interactive editor (613 lines) |
| `ui/src/components/mixer/NodeEditor.jsx` | Graph-mode node editor |
| `ui/src/stores/effectChainStore.js` | Effect chain Zustand store |
| `ui/src/stores/eqStore.js` | EQ-specific Zustand store |
| `ui/src/stores/nodeGraphStore.js` | Graph topology Zustand store |

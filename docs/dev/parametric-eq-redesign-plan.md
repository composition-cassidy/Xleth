# Parametric EQ Redesign Plan

Status: design / audit only. No code changes yet.
Scope: UI/painter redesign of the existing specialized EQ panel to match the approved mockup direction (large dominant graph, surgical Pro-Q-style analyzer, clean dark Xleth theme, dynamic controls only when needed).

This document is the source of truth for the EQ-A → EQ-E phases below. It is intentionally self-contained so a fresh session can pick up any phase from this file alone.

---

## 1. Current EQ architecture map

The Parametric EQ is **not** part of the stock plugin-ui Designer/runtime. It is a fully bespoke, specialized React panel backed by a dedicated Zustand store and a dedicated set of N-API bridge methods that talk to a hand-rolled JUCE effect with its own analyzer thread.

```
┌──────────────────────────────────────────────────────────────────────┐
│  RENDERER (React)                                                    │
│  ┌──────────────────┐  poll@30Hz   ┌────────────────────────────┐    │
│  │ EqPanel.jsx      │ ───────────► │ eqStore.js (Zustand)       │    │
│  │ - SVG graph      │              │ - bands[], linPhase, etc.  │    │
│  │ - SVG bands      │  IPC invoke  │ - responseCurve (Float32)  │    │
│  │ - SVG analyzer   │ ───────────► │ - spectrumData {post,pre}  │    │
│  │ - HTML band rows │              │ - bandGR[16]               │    │
│  └──────────────────┘              └─────────────┬──────────────┘    │
│                                                  │ window.xleth.*    │
└──────────────────────────────────────────────────┼───────────────────┘
                                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  MAIN PROCESS (ui/main.js)                                           │
│  ipcMain.handle('eqGetSpectrumData', …) etc. ──► XlethAddon          │
└──────────────────────────────────────────────────┬───────────────────┘
                                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  N-API BRIDGE (bridge/src/XlethAddon.cpp)                            │
│  Audio_EQ_AddBand / GetBands / GetResponseCurve / GetSpectrumData    │
│  / GetBandGR / SetBandParam / SetGlobalParam / GetSampleRate         │
└──────────────────────────────────────────────────┬───────────────────┘
                                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ENGINE (engine/src/audio/XlethEQEffect.h, header-only)              │
│  - 16 BandStates (DFII Transposed biquads, smoothed freq/gain/Q)     │
│  - getResponseCurve() → 512 log-spaced dB samples (main thread)      │
│  - Background analyzer thread:                                       │
│      4096-pt Hann FFT, 50% overlap (hop=2048), 2048 positive bins,   │
│      per-bin EMA smoothing, ~300ms release, double-buffered output   │
│  - Dynamic EQ: per-band sidechain BPF + RMS + threshold/ratio        │
│  - Spectral Dynamics: 4096-pt STFT, per-bin envelope, iSTFT          │
└──────────────────────────────────────────────────────────────────────┘
```

### Effect identity

- **Effect id (string used by bridge / plugin registry / chain menus):** `xletheq`
- **Engine class:** `XlethParametricEQ` (file: [engine/src/audio/XlethEQEffect.h](engine/src/audio/XlethEQEffect.h), 1711 lines, header-only)
- **Max bands:** `kMaxBands = 16`

### Band model (per band, in engine + store)

| Param | Range | Notes |
|---|---|---|
| `b{i}_freq` | 20 – 20000 Hz | 30ms multiplicative smoothing |
| `b{i}_gain` | −30 / +30 dB | 20ms linear smoothing |
| `b{i}_q` | 0.1 – 30 | 30ms multiplicative smoothing |
| `b{i}_type` | 0…6 | Bell, LowShelf, HighShelf, LowPass, HighPass, Notch, Tilt |
| `b{i}_enabled` | 0 / 1 | |
| `b{i}_mode` | 0 / 1 / 2 | Static / Dynamic / Spectral |
| `b{i}_dyn_thresh` | −60 … 0 dB | mode = 1 |
| `b{i}_dyn_ratio` | 1 … 20 | mode = 1 |
| `b{i}_dyn_attack` | 0.1 … 100 ms | mode = 1 |
| `b{i}_dyn_release` | 1 … 1000 ms | mode = 1 |
| `b{i}_spec_sens` | 0 … 1 | mode = 2 |
| `b{i}_spec_depth` | −30 … +30 dB | mode = 2 |
| `b{i}_spec_sel` | 1 … 20 | mode = 2 |
| `b{i}_spec_attack` | 0.1 … 100 ms | mode = 2 |
| `b{i}_spec_release` | 1 … 1000 ms | mode = 2 |

Globals: `linphase` (0/1), `oversample` (0/1/2 = off/2x/4x).

### How nodes / dynamic bands are edited

- Drag a node on the SVG graph → `BandDot` mousemove handler computes new freq/gain from cursor (log frequency mapping, response-scale gain mapping), optimistically writes via `setBandParam('freq'|'gain', …)`. Final values quantized to 0.1 Hz / 0.1 dB.
- Q ring drag (where wired) → `setBandParam('q', …)`.
- Mode switching (Static/Dynamic/Spectral) is a `<select>` in the band row; **dynamic vs spectral parameters are always present in the engine and store**, the UI just hides the inputs that aren't relevant to the current mode.

### Spectrum / analyzer data path

| Layer | Behavior |
|---|---|
| Engine audio thread | Tap input + output samples into a 16384-sample SPSC ring buffer. |
| Engine analyzer thread | Pull 4096-sample frames at hop 2048, Hann window, FFT, magnitude → dB, EMA smooth into `specPostSmoothed_[2048]` / `specPreSmoothed_[2048]`. |
| Engine analyzer thread | EMA coefficient computed at `prepareToPlay` time as `1 − exp(−1 / (0.3 · framesPerSec))` ⇒ **fixed ~300 ms release**. Hardcoded. |
| Engine main thread | Atomic double-buffer swap (`SpectrumOutput { post[2048]; pre[2048]; }`). |
| Bridge | `eqGetSpectrumData(trackId, nodeId)` returns `{ post: Float32Array(2048), pre: Float32Array(2048)|null }`. |
| Renderer | `eqStore.fetchSpectrumData()` polled at 30 Hz inside `EqPanel`. |
| Renderer (painter) | Aggregates 2048 bins into ~120 bars (1/12 octave, log-spaced), applies optional pink-noise tilt (+4.5 dB/oct, on/off toggle), computes a separate per-bar **max-hold** envelope decaying at 24 dB/sec. |

The analyzer data is **real**, not synthetic. There is no `vizCollector`-style frame queue for EQ — it goes straight from the engine analyzer thread to the bridge and is polled by the renderer.

### Files involved

| File | Role |
|---|---|
| [ui/src/components/mixer/EqPanel.jsx](ui/src/components/mixer/EqPanel.jsx) | The entire specialized EQ panel: SVG graph, axes, analyzer paths, response curve, band dots, band rows, drag/zoom interaction, max-hold state, slope toggle, pre/post toggle. ~1043 lines. |
| [ui/src/stores/eqStore.js](ui/src/stores/eqStore.js) | Zustand store. Holds bands, modes, response curve, spectrum data, bandGR, theme font. Handles all IPC fetch/dispatch. |
| [ui/src/styles/app.css](ui/src/styles/app.css) (~7008–7350) | All EQ visual tokens & classes (`--xleth-eq-*`, `.eq-grid-line`, `.eq-spectrum-fill`, `.eq-spectrum-hold`, `.eq-response-line`, `.eq-band-dot`, `.eq-band-row`, …). |
| [ui/src/components/mixer/MixerPanel.jsx](ui/src/components/mixer/MixerPanel.jsx) | Mounts `<EqPanel/>` (line ~114). Visibility driven by `eqStore.target`. |
| [ui/main.js](ui/main.js) (~1432–1463) | `ipcMain.handle` for all `eq*` channels. |
| [ui/preload.js](ui/preload.js) (~297–307) | `contextBridge` exposure of `window.xleth.eq*` invoke shims. |
| [bridge/src/XlethAddon.cpp](bridge/src/XlethAddon.cpp) (~9117–9400) | N-API `Audio_EQ_*` functions that `dynamic_cast` to `XlethParametricEQ` and call its public methods. |
| [engine/src/audio/XlethEQEffect.h](engine/src/audio/XlethEQEffect.h) | DSP, parameter layout, response curve, analyzer thread, dynamic-EQ + spectral-dynamics processing. |

The EQ is **not** in `ui/src/plugin-ui/` — it has not been migrated, and is not a candidate for the stock runtime in the near term (large interactive specialized graph, dynamic per-band controls, custom analyzer; all out of scope for the generic runtime).

---

## 2. Rendering responsibilities (current)

Everything below lives inside [EqPanel.jsx](ui/src/components/mixer/EqPanel.jsx). There is no shared painter helper module — all coordinate transforms and SVG path math are inline.

| Concern | Where | Tech |
|---|---|---|
| Frequency grid + labels | `EqGrid` memo (lines 93–129) | SVG `<line>` / `<text>` |
| Analyzer dB grid (left axis, fixed −80…0 dB FS) | `EqGrid` (106–114) | SVG |
| Response dB grid (right axis, ±dbZoom) | `EqGrid` (115–126) | SVG |
| Spectrum fill (post + optional pre overlay) | `computeSpectrumPaths` (133–227) → `<path>` (1004–1009) | SVG path, ~120 1/12-oct bars + per-bar max-hold, midpoint-smoothed |
| Spectrum max-hold trace | same function | SVG path stroke |
| Orange EQ response curve | `responseToPath` (231–243) → `<path>` (1011–1017) | SVG path, 512 log-spaced points, linear segment-to-segment |
| Band nodes (dot, Q ring, mode badge, GR ring, label) | `BandDot` (245–324) | SVG `<g>` per band |
| Bottom band rows (mode/type/freq/gain/Q/enable + dyn/spec inputs + GR bar) | `BandRow` (328–544) | HTML `<select>` / `<input>` / `<button>`, no canvas |
| Output meter | **none** | EQ panel does not currently host an output meter; `bandGR` is shown only as per-node rings + per-row mini bars |

Coordinate helpers (currently inline, candidates for extraction in EQ-A): `freqToX`, `xToFreq`, `dbToY_response`, `dbToY_analyzer`, `yToDb_response`, `evalResponseAt`, `clamp`. SVG viewBox is `640×280` with paddings `L36 / R8 / T8 / B20`.

---

## 3. Current limitations

1. **Analyzer feels over-smoothed but the data is fine.** The engine produces 2048 dB-domain bins per frame at ~95 frames/sec. The renderer collapses this to ~120 1/12-octave bars and then **inserts geometric midpoints** between every adjacent pair of bars in the path, which is the dominant source of the "artistic" / soft look. Local peaks visible in the underlying data are blunted by aggregation + midpoint blending.
2. **Engine EMA release is hardcoded** to ~300 ms (`1 − exp(−1 / (0.3 · framesPerSec))`). There is no UI control. This is fine for typical use but blocks adding a "Speed" control without an engine change.
3. **FFT size is fixed at 4096.** No Resolution control. To match Pro-Q's Low/Med/High/Max we would need engine-side support for selectable FFT sizes (1024 / 2048 / 4096 / 8192) — that's an EQ-D concern only, and is **optional**: 4096 is already comparable to Pro-Q's "High" preset.
4. **Slope is binary** (`slopeOn` toggle, fixed +4.5 dB/oct). Pro-Q exposes a continuous Tilt with multiple presets. Adding configurable tilt (0 / 3 / 4.5 / 6 dB-per-oct around 1 kHz pivot) is a renderer-only change.
5. **Range is fixed.** Analyzer y-axis is hardcoded to `−80 … +12 dB FS` (`ANA_DB_MIN`/`ANA_DB_MAX`). No user control. Adding Range presets (e.g. 60 / 90 / 120 dB) is renderer-only.
6. **Response dbZoom (±6 / ±12 / ±24 / ±48 dB) is reused as the *only* zoom control** and is cycled by a single button. Two concepts — analyzer Range and response dB-zoom — are conflated visually but actually independent.
7. **No output meter** in the EQ panel. The mockup shows one on the right side; we will need to host a small fixed-width peak meter (re-use `PeakMeter` component if available; otherwise add a thin SVG/Canvas meter pulled from the existing engine meter API).
8. **Band rows are visually heavy.** Every row displays mode/type/freq/gain/Q + dynamic OR spectral fields (5 extra inputs). The mockup wants compact rows, and the dynamic/spectral block visible only for the *selected* band.
9. **Drag/UI and DSP coupling is acceptable.** Param names map 1:1 to engine APVTS. The redesign does not need to introduce an abstraction layer; we keep `setBandParam('dyn_attack', …)` etc. as-is. Decoupling is *not* a goal of this redesign.
10. **No SVG support outside this panel** in stock plugin-ui runtime — irrelevant here, the EQ stays specialized.

**Key conclusion:** the analyzer **data** is good. The "over-smoothed" feeling is a *painter* problem (1/12-oct aggregation is too coarse, midpoint smoothing is artistic). EQ-A can fix it without touching the engine or the bridge.

---

## 4. Design target (from approved mockup)

### 4.1 Main graph

- Large graph dominates the panel (no shrinking to make room for the band rows).
- Clean dark Xleth theme using existing tokens (`--xleth-eq-*` already defined in [app.css](ui/src/styles/app.css)). No new color identity.
- Frequency grid lines at 20 / 50 / 100 / 200 / 500 / 1k / 2k / 5k / 10k / 20k Hz with subtle dashed strokes; labels under the plot.
- Two y-axes: response (right, ±dbZoom) and analyzer (left, fixed dB FS within the user-selected Range).
- Spectrum fill: clean blue/gray vertical gradient (top: `--xleth-eq-spectrum-top` ≈ subtle blue; bottom: `--xleth-eq-spectrum-bottom` ≈ neutral gray, both already token-style). Crisp, surgical, **no midpoint smoothing**.
- Optional ghost / average trace behind live spectrum (slow EMA computed in renderer, configurable via Speed control in EQ-B).
- Orange response curve **on top** of everything, stroke-width preserved (1.5–1.75 px), no fill.
- Band dots remain interactive and on top of the response curve. Selected band gets an accent ring (already implemented; keep behavior).

### 4.2 Analyzer

- Sharper local peaks: bump aggregation density to **1/24 octave** (≈240 bars across 20–20k Hz) and **drop the midpoint smoothing** in `computeSpectrumPaths`. This alone should match the surgical Pro-Q look using the existing 2048-bin data.
- Stable dB range with user-selectable Range presets (60 / 90 / 120 dB), implemented as a **renderer-only** mapping over the existing data.
- Optional Pro-Q-style controls (EQ-B):
  - **Resolution** (Low / Medium / High / Maximum) — visual only in EQ-B (changes bars-per-octave: 12 / 18 / 24 / 36). True FFT-size control is EQ-D and optional.
  - **Speed** (Slow / Medium / Fast) — controls renderer-side EMA + max-hold decay rate. (Engine-side EMA stays at its current 300 ms; we ride on top of it.)
  - **Range** (60 / 90 / 120 dB) — renderer y-axis only.
  - **Tilt** (0 / 3 / 4.5 / 6 dB-per-oct around 1 kHz) — replaces the current binary `slopeOn`.
- No FabFilter-style branding, logos, or iconography. Use existing Xleth UI primitives only.

### 4.3 Bottom controls

- Compact band rows: color dot, mode select, type select, freq, gain, Q, enable. **No** dynamic/spectral inputs in the row by default.
- A separate "Selected Band" inspector panel below or beside the rows displays:
  - When `band.mode === 'static'`: nothing extra (or just expanded description).
  - When `band.mode === 'dynamic'`: thr / ratio / attack / release + GR meter.
  - When `band.mode === 'spectral'`: sens / depth / sel / attack / release.
- Inspector visibility is driven by `eqStore.selectedBandIndex` (already exists in the store).

### 4.4 Output meter

- Right-side vertical peak meter, separated from the graph by the right axis labels.
- Re-use existing engine meter API (`getEffectMeter` 4-slot system) and the `PeakMeter` component already used by `MixerStrip` / `MasterStrip`. No new DSP.
- Width: ~16–24 px including labels. Should not eat into the graph.

### 4.5 Theme tokens

Reuse existing `--xleth-eq-*` tokens. New tokens (added in CSS only, no JS changes):

- `--xleth-eq-spectrum-top` (gradient stop, ~rgba blue, 0.45 alpha)
- `--xleth-eq-spectrum-bottom` (gradient stop, ~rgba gray, 0.15 alpha)
- `--xleth-eq-spectrum-stroke` (subtle top edge for definition, ~rgba blue 0.6)
- `--xleth-eq-spectrum-hold` (max-hold trace, neutral gray 0.7)
- `--xleth-eq-pre-spectrum-top` / `…-bottom` (muted variants for the pre-EQ overlay)

---

## 5. Implementation phases

The phases are independent enough that EQ-A can ship before EQ-B is started. EQ-D is optional and only triggered if EQ-B exposes Resolution as a real FFT-size control rather than a render-density control.

### Phase EQ-A — Painter cleanup (renderer only) **[start here]**

Touches: `EqPanel.jsx`, `app.css`. **Does not** touch store, bridge, or engine.

1. Bump `BARS_PER_OCTAVE` from 12 → 24. Recompute `FREQ_BAR_EDGES`.
2. Remove the midpoint smoothing inserts in `computeSpectrumPaths` (the `xMid / yFMid / yHMid` block). Replace with straight `L` segments per bar. The top edge becomes crisp.
3. Replace the current spectrum fill style with a vertical linear gradient using two new CSS variables (`--xleth-eq-spectrum-top`, `--xleth-eq-spectrum-bottom`). Use an `<linearGradient>` defined inside the SVG `<defs>`.
4. Add a thin top-edge stroke on the fill path (`--xleth-eq-spectrum-stroke`) so peaks read clearly without bumping alpha on the fill.
5. Keep the response curve untouched; verify it still renders on top by SVG z-order.
6. Move the inline coordinate helpers (`freqToX`, `xToFreq`, `dbToY_response`, `dbToY_analyzer`, `yToDb_response`, `evalResponseAt`, `clamp`) into a new module `ui/src/components/mixer/eqGeometry.js` so EQ-B and EQ-C can import them without copy-paste.
7. Cosmetic CSS pass on `.eq-grid-line` / `.eq-grid-line-zero` / `.eq-grid-label-x` to match the mockup's restraint (slightly lower alpha on grid, slightly higher contrast on labels).
8. Add a right-side output meter using the existing `PeakMeter` component (or its primitive), pulling from `getEffectMeter` for the EQ node. Layout: shrink `PLOT_W` by the meter's width (~22 px) only if `PAD_R` was used; otherwise expand `SVG_W` so the existing graph proportions are preserved.

No engine changes. No store changes. No new IPC.

### Phase EQ-B — Analyzer controls (renderer only)

Touches: `EqPanel.jsx`, `eqStore.js` (UI-only state), `app.css`.

1. Replace `slopeOn` boolean with `tiltDbPerOct` (0 / 3 / 4.5 / 6).
2. Add `analyzerRange` (60 / 90 / 120 dB) → drives `ANA_DB_MIN/MAX` mapping at render time. Top stays at current ceiling; bottom slides.
3. Add `analyzerSpeed` (Slow / Med / Fast) → drives renderer-side `DECAY_DB_PER_SEC` for max-hold, and a new ghost-trace EMA (rendered behind the live spectrum at lower alpha).
4. Add `analyzerResolution` (Low / Med / High / Max) → maps to `BARS_PER_OCTAVE` 12 / 18 / 24 / 36. **Renderer density only**, FFT untouched.
5. Persist all four to `localStorage` under `xleth.eq.analyzer`.
6. Small popover or compact toolbar above the graph; no separate modal.

### Phase EQ-C — Band-row redesign

Touches: `EqPanel.jsx`, `app.css`, `eqStore.js` selectors only.

1. Strip dynamic / spectral inputs out of `BandRow`. Row becomes: color dot, mode, type, freq, gain, Q, enable, overflow.
2. Add `<SelectedBandInspector />` component rendered below the rows. Driven by `selectedBandIndex`. Mode-specific field set as described in §4.3.
3. Move the per-row GR mini-bar into the inspector for dynamic mode, and a compact GR ring stays in the main graph (already implemented).
4. Keep keyboard shortcuts and Add/Reset/Delete in the overflow menu.

### Phase EQ-D — Engine/bridge analyzer improvements (optional, only if EQ-B Resolution is upgraded to true FFT-size control)

Touches: `XlethEQEffect.h`, `XlethAddon.cpp`, `main.js`, `preload.js`, `eqStore.js`.

1. Add `eq_analyzer_fft_order` global parameter (10 / 11 / 12 / 13 → 1024 / 2048 / 4096 / 8192).
2. Make the analyzer thread reallocate Hann window + FFT plan + smoothed buffers on order change. Guard with `std::atomic<int> pendingFFTOrder_` to avoid resizing under the audio thread.
3. Add `eq_analyzer_release_ms` (100 / 300 / 600 ms → matches Speed presets) replacing the hardcoded 0.3 in `prepareToPlay`.
4. Bridge methods: `eqSetAnalyzerConfig({ fftOrder, releaseMs })`, `eqGetAnalyzerConfig()`.
5. Skip this phase entirely if EQ-B Resolution-as-render-density is acceptable to the user (recommended default).

### Phase EQ-E — Tests + manual Electron verification

Touches: tests under `ui/src/components/mixer/__tests__/` (or co-located), no new test framework.

1. Unit tests for `eqGeometry.js` (coordinate transforms, `evalResponseAt` boundaries).
2. Snapshot test for `computeSpectrumPaths` given a fixed input array (catches accidental smoothing regressions).
3. Render test for `<SelectedBandInspector />` under each mode (static / dynamic / spectral).
4. Manual smoke pass in Electron:
   - Open a track, add EQ, sweep input through pink + sine; verify spectrum shows sharp local peak on the sine across the full freq range.
   - Cycle Resolution / Range / Speed / Tilt; verify visual changes match labels.
   - Add three bands (one static, one dynamic, one spectral); verify inspector swaps cleanly when selection changes.
   - Verify response curve / band dots / drag interactions are unchanged from current behavior.
   - Verify output meter tracks input loudness and matches the mixer-strip meter for the same node.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Higher bar density (24/oct) causes SVG path size to balloon → measurable render cost | Low | At 24 bars/oct we stay around 240 segments per frame; SVG handles this fine for a 640×280 panel. If profiling shows cost, fall back to Canvas in a follow-up — out of scope here. |
| Removing midpoint smoothing exposes jitter from the engine EMA at large gains | Low | Engine EMA already smooths frame-to-frame; renderer max-hold + optional ghost trace cover residual jitter. |
| New CSS gradient tokens conflict with existing theming-wave-0 work | Low | All new tokens are namespaced `--xleth-eq-spectrum-*` and live under the EQ section in `app.css`. Add only; don't repurpose existing tokens. |
| Output meter integration drifts from the mixer-strip meter visuals | Medium | Reuse `PeakMeter` component as-is; do not fork. |
| Inspector pattern (EQ-C) conflicts with existing keyboard / drag selection | Medium | Use the existing `selectedBandIndex` already in `eqStore`; do not introduce a parallel selection state. |
| EQ-D engine changes break realtime safety | High (if attempted) | Skip EQ-D unless explicitly requested; keep FFT order constant and resize only via a non-audio-thread path with atomic handoff. |
| Theming-wave-0 hard rule: no arbitrary user CSS/JS/HTML | n/a | Plan stays inside engine-controlled CSS variables and component JSX. |

---

## 7. Tests needed

### Automated (Vitest, in line with existing `ui/src/plugin-ui/**/__tests__/`)

- `eqGeometry.test.js`
  - `freqToX(20) === PAD_L`, `freqToX(20000) === PAD_L + PLOT_W`, log monotonic.
  - `dbToY_analyzer` clamps to `[ANA_DB_MIN, ANA_DB_MAX]`.
  - `evalResponseAt` linearly interpolates and matches sample values at exact log positions.
- `eqSpectrumPath.test.js`
  - Given a synthetic 2048-bin input with a single peak at bin 256, the rendered fill path's max y-coordinate occurs at the corresponding x. (Catches midpoint-smoothing regressions.)
  - Output path string contains only `M` / `L` / `Z` (no `Q` / `C`) — guards against accidental Bézier reintroduction.
- `eqAnalyzerControls.test.jsx` (EQ-B)
  - Toggling Range remaps y-axis labels.
  - Toggling Tilt changes the slope baseline of a flat-pink input.
- `eqSelectedBandInspector.test.jsx` (EQ-C)
  - Renders correct field set per mode.
  - Updates correctly when `selectedBandIndex` changes.

### Manual

- See §EQ-E above. The renderer/preview workflow (`preview_*` MCP tools) is the right level here; type-check + tests alone cannot verify analyzer feel.

---

## 8. Exact next implementation prompt — EQ-A only

Paste the block below into a fresh implementation session. It is fully self-contained.

```
Implement Parametric EQ Phase EQ-A: painter cleanup only.

Context:
- Project: Xleth. Windows-only Electron + React UI, Node-API bridge, C++ JUCE engine.
- Plan source of truth: docs/dev/parametric-eq-redesign-plan.md (read it first).
- Scope of THIS task: renderer + CSS only. Do not touch the store schema, the
  bridge, or the engine. Do not touch Compressor/Limiter/Transient/Overdone.
- The analyzer data is already correct. The "over-smoothed" feeling is a
  painter problem.

Files you will edit:
- ui/src/components/mixer/EqPanel.jsx
- ui/src/styles/app.css
- (NEW) ui/src/components/mixer/eqGeometry.js

Tasks (in order):

1. Create ui/src/components/mixer/eqGeometry.js. Move these helpers out of
   EqPanel.jsx into the new module (named exports):
     SVG_W, SVG_H, PAD_L, PAD_R, PAD_T, PAD_B, PLOT_W, PLOT_H,
     FREQ_MIN, FREQ_MAX, ANA_DB_MIN, ANA_DB_MAX, RESPONSE_SIZE,
     freqToX, xToFreq, dbToY_response, dbToY_analyzer, yToDb_response,
     evalResponseAt, clamp.
   Update EqPanel.jsx imports to use eqGeometry. Do not change behavior.

2. In EqPanel.jsx:
   - Bump BARS_PER_OCTAVE from 12 to 24. Recompute FREQ_BAR_EDGES.
   - In computeSpectrumPaths, REMOVE the midpoint smoothing inserts
     (the block that pushes xMid / yFMid / yHMid between adjacent bars
     for both fillParts and holdParts). Replace with straight 'L' segments
     per bar. The fill path should still close to (PAD_L+PLOT_W, PAD_T+PLOT_H)
     at the right edge and to (PAD_L, PAD_T+PLOT_H) at the left.

3. In EqPanel.jsx, define an SVG <defs> block once at the top of the SVG that
   declares <linearGradient id="xleth-eq-spectrum-fill" x1="0" y1="0"
   x2="0" y2="1"> with two stops referencing CSS variables via stop-color:
     - stop offset="0%"   stop-color: var(--xleth-eq-spectrum-top)
     - stop offset="100%" stop-color: var(--xleth-eq-spectrum-bottom)
   Apply fill="url(#xleth-eq-spectrum-fill)" to the post-spectrum fill path.
   Add a thin stroke using --xleth-eq-spectrum-stroke for crisp peak
   definition. Do the equivalent (with -pre- variants) for the pre-EQ
   overlay so the toggle still works visually.

4. In ui/src/styles/app.css, in the existing EQ section (search for
   --xleth-eq-grid), add the new tokens:
     --xleth-eq-spectrum-top:    rgba(80, 140, 220, 0.55)
     --xleth-eq-spectrum-bottom: rgba(110, 130, 150, 0.10)
     --xleth-eq-spectrum-stroke: rgba(120, 170, 230, 0.65)
     --xleth-eq-pre-spectrum-top:    rgba(110, 120, 130, 0.30)
     --xleth-eq-pre-spectrum-bottom: rgba(110, 120, 130, 0.05)
     --xleth-eq-pre-spectrum-stroke: rgba(140, 150, 160, 0.40)
   Update .eq-spectrum-fill / .eq-spectrum-hold / .eq-spectrum-pre-fill
   /.eq-spectrum-pre-hold so:
     - .eq-spectrum-fill uses the gradient via fill on the path itself
       (no fill in CSS), and stroke uses --xleth-eq-spectrum-stroke at
       stroke-width 1.
     - The hold trace stays a single neutral stroke at 0.7 alpha.
     - Tighten .eq-grid-line opacity by ~20% relative to current.

5. Add a right-side output meter:
   - Find the existing PeakMeter primitive used by MixerStrip / MasterStrip
     (search "PeakMeter").
   - Mount one inside EqPanel between the SVG graph and the band rows
     container, vertically aligned with the graph plot area.
   - Source: the same getEffectMeter API the mixer strip uses for an effect
     node. If a direct hook does not exist, read it from whatever store
     supplies effect-node meter values today (do NOT add a new IPC channel).
   - Width: ~22 px including labels. Do not shrink the graph; let the panel
     widen to accommodate.

6. Do NOT change anything in eqStore.js's schema. Do NOT add new IPC.
   Do NOT touch the engine. Do NOT touch any plugin-ui/* files.

Verification:
- Run the existing Vitest suite. Add ui/src/components/mixer/__tests__/
  eqGeometry.test.js with at minimum: freqToX endpoints, log monotonicity,
  dbToY_analyzer clamp, evalResponseAt at fractional indices.
- Add ui/src/components/mixer/__tests__/eqSpectrumPath.test.js asserting
  the path string contains only M / L / Z commands (no Q / C / S / T)
  for any input — this is the regression guard against re-smoothing.
- Manually launch Electron, open a track, instantiate the EQ on a node
  with audio playing. Confirm:
    a) The spectrum fill is visibly sharper (no curved tops between bars).
    b) The fill is a clean blue→gray vertical gradient.
    c) The response curve still draws on top, orange, unchanged.
    d) Band drag, Q ring, mode badges, GR ring still work as before.
    e) The right-side output meter tracks real audio level.

Constraints:
- Windows-only assumptions stay.
- No FabFilter assets/branding/colors.
- No arbitrary user CSS/JS/HTML.
- Renderer/bridge/engine boundaries respected.
- No DSP changes.
- No analyzer Resolution / Speed / Range / Tilt UI yet — that is EQ-B.
- No band-row inspector redesign — that is EQ-C.

Deliverables:
- Modified EqPanel.jsx, app.css.
- New eqGeometry.js + 2 test files.
- Brief PR-style summary of what changed and what to verify manually.
```

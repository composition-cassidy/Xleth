# Xleth Distortion + Waveshaper Redesign Plan

Status: design/audit only. No implementation, DSP, bridge, Designer feature, EQ, or dynamics-plugin changes are included in this document.

## 1. Current Distortion architecture map

Distortion is still a legacy JSX stock-effect panel, not a stock plugin UI runtime layout.

Engine and plugin identity:

- Exact plugin id: `distortion`.
- Factory: `engine/src/audio/AudioGraph.cpp` maps `pluginId == "distortion"` to `std::make_unique<XlethDistortionEffect>()`.
- Real implementation: `engine/src/audio/XlethDistortionEffect.h`.
- Older stub still exists: `engine/src/audio/DistortionEffect.h`, with the same plugin id, but the graph factory currently instantiates `XlethDistortionEffect`.

Renderer UI:

- Current panel: `ui/src/components/mixer/DistortionPanel.jsx`.
- Store: `ui/src/stores/distortionStore.js`.
- Mount point: `ui/src/components/mixer/MixerPanel.jsx` imports and renders `<DistortionPanel />`.
- Effect-chain opener: `ui/src/components/mixer/EffectModule.jsx` maps `distortion` to `useDistortionStore.getState().open(...)`.
- Add-effect menus:
  - Chain view: `ui/src/components/mixer/EffectChainPanel.jsx`, Distortion category, `id: "distortion"`.
  - Node editor: `ui/src/components/mixer/NodeEditor.jsx`, Distortion category, `id: "distortion"`.
- Debug capture selector exists: `ui/src/components/debug/DebugCapturePanel.jsx` looks for `.distortion-panel`.

Bridge/UI data path:

- Parameters use the generic stock-effect IPC path:
  - renderer: `window.xleth.audio.getEffectParameters(trackId, nodeId)`.
  - renderer: `window.xleth.audio.setEffectParameter(trackId, nodeId, paramId, value)`.
  - preload: `ui/preload.js`.
  - main: `ui/main.js`.
  - Node-API: `bridge/src/XlethAddon.cpp`.
  - engine: `MixEngine::getEffectParameters/setEffectParameter` -> `AudioGraph` -> `XlethEffectBase`.
- There are no Distortion-specific bridge functions today.

Plugin UI runtime status:

- Not registered in `ui/src/plugin-ui/manifests/index.js`.
- No `ui/src/plugin-ui/manifests/distortion.js`.
- No `ui/src/plugin-ui/layouts/distortion.json`.
- Not registered in `ui/src/plugin-ui/layouts/index.js`.
- Not present in `ui/main.js` `KNOWN_PLUGIN_IDS` or `SHIPPED_PLUGIN_UI_LAYOUT_FILES`.
- Current panel has no Designer split, no runtime renderer, and no Designer user override path.

Current UI shape:

- Fixed 380 px floating panel.
- Header with close button.
- Mode button row: Tube, Soft Clip, Hard Clip, Analog.
- Knob row: Drive, Tone, Mix.
- Filter position row: Pre/Post.
- No transfer curve, waveform, meter, or spectrum display.

## 2. Current Waveshaper architecture map

Waveshaper is also a legacy JSX panel, but unlike Distortion it already has specialized curve-editing behavior and bridge calls.

Engine and plugin identity:

- Exact plugin id: `waveshaper`.
- Factory: `engine/src/audio/AudioGraph.cpp` maps `pluginId == "waveshaper"` to `std::make_unique<XlethWaveshaperEffect>()`.
- Real implementation: `engine/src/audio/XlethWaveshaperEffect.h`.
- Older stub still exists: `engine/src/audio/WaveshaperEffect.h`, with the same plugin id, but the graph factory currently instantiates `XlethWaveshaperEffect`.

Renderer UI:

- Current panel: `ui/src/components/mixer/WaveshaperPanel.jsx`.
- Store: `ui/src/stores/waveshaperStore.js`.
- Mount point: `ui/src/components/mixer/MixerPanel.jsx` imports and renders `<WaveshaperPanel />`.
- Effect-chain opener: `ui/src/components/mixer/EffectModule.jsx` maps `waveshaper` to `useWaveshaperStore.getState().open(...)`.
- Add-effect menus:
  - Chain view: `ui/src/components/mixer/EffectChainPanel.jsx`, Distortion category, `id: "waveshaper"`.
  - Node editor: `ui/src/components/mixer/NodeEditor.jsx`, Distortion category, `id: "waveshaper"`.

Bridge/UI data path:

- Continuous/discrete APVTS parameters use the generic get/set parameter path.
- Curve/preset editing uses Waveshaper-specific bridge APIs:
  - `window.xleth.audio.wsGetCurvePoints(trackId, nodeId)`
  - `window.xleth.audio.wsSetCurvePoints(trackId, nodeId, pointsJSON)`
  - `window.xleth.audio.wsSetPreset(trackId, nodeId, presetIndex)`
- These are exposed through:
  - `ui/preload.js`
  - `ui/main.js`
  - `bridge/src/XlethAddon.cpp`
  - `XlethWaveshaperEffect::getControlPoints/setControlPoints/setPreset`

Plugin UI runtime status:

- Not registered in `ui/src/plugin-ui/manifests/index.js`.
- No `ui/src/plugin-ui/manifests/waveshaper.js`.
- No `ui/src/plugin-ui/layouts/waveshaper.json`.
- Not registered in `ui/src/plugin-ui/layouts/index.js`.
- Not present in `ui/main.js` `KNOWN_PLUGIN_IDS` or `SHIPPED_PLUGIN_UI_LAYOUT_FILES`.
- Current panel has no Designer split and no runtime renderer.
- Current panel already implements an interactive SVG curve editor, which is beyond the current generic runtime node set.

Current UI shape:

- Fixed 340 px floating panel.
- Header with close button.
- 300 x 300 SVG curve editor.
- Preset row: Soft Clip, Hard Clip, Tube, Fold, Rectify.
- Knob row: Pre Gain, Post Gain, Mix.
- Custom preset exists internally as preset `0`, but the current preset row does not render a Custom button. Editing points sets preset to `0`.

## 3. Exact plugin ids discovered

| Plugin | Exact id | Engine class currently instantiated |
| --- | --- | --- |
| Distortion | `distortion` | `XlethDistortionEffect` |
| Waveshaper | `waveshaper` | `XlethWaveshaperEffect` |

## 4. Exact params, ranges, defaults, and formats discovered

The engine source of truth is the APVTS layout in each `Xleth*Effect.h`. The current panels also define renderer display formatting.

### Distortion params

Source: `engine/src/audio/XlethDistortionEffect.h::createLayout()` and `ui/src/components/mixer/DistortionPanel.jsx`.

| Param id | Name | Kind | Range | Step/skew | Default | Unit | Current UI format / labels |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mode` | Mode | discrete float | `0..3` | interval `1`, skew `1` | `0` | none | `0=Tube`, `1=Soft Clip`, `2=Hard Clip`, `3=Analog` |
| `drive` | Drive | continuous | `0..48` | interval `0`, skew `0.5` | `12` | `dB` | `v.toFixed(1) + " dB"` |
| `tone` | Tone | continuous | `20..20000` | interval `0`, skew `0.23` | `8000` | `Hz` | `v.toFixed(0) + " Hz"` |
| `filter_pos` | Filter Position | discrete float | `0..1` | interval `1`, skew `1` | `1` | none | `0=Pre`, `1=Post` |
| `mix` | Mix | continuous | `0..100` | interval `0`, skew `1` | `100` | `%` | `v.toFixed(0) + " %"` |

Additional engine behavior, not user params:

- Fixed 4x FIR equiripple oversampling (`juce::dsp::Oversampling<float>` exponent `2`).
- DC blocker at 10 Hz.
- Tone is a 2nd-order Butterworth low-pass.
- `drive`, `tone`, and `mix` are smoothed:
  - `drive`: linear, 20 ms.
  - `tone`: multiplicative, 30 ms.
  - `mix`: linear, 20 ms.
- No discovered output/gain, bypass, bias/asymmetry, smoothing, or oversampling user parameter.

Mode transfer functions used by the engine:

- Tube: `tanh(x)`.
- Soft Clip: cubic polynomial, `x - x^3 / 3` inside `abs(x) < 1`, else `sign(x) * 2/3`, then multiplied by `1.5`.
- Hard Clip: clamp to `[-1, 1]`.
- Analog: positive side `tanh(x)`, negative side `1.2 * x / (1 + abs(1.2 * x))`.
- Here `x = input * pow(10, driveDb / 20)`.
- Mix is applied after downsampling/filter/DC blocking as dry/wet blend.

### Waveshaper params

Source: `engine/src/audio/XlethWaveshaperEffect.h::createLayout()`, curve methods in the same file, and `ui/src/components/mixer/WaveshaperPanel.jsx`.

| Param id | Name | Kind | Range | Step/skew | Default | Unit | Current UI format / labels |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pregain` | Pre Gain | continuous | `-24..48` | interval `0`, skew `1` | `0` | `dB` | `v.toFixed(1) + " dB"` |
| `postgain` | Post Gain | continuous | `-24..24` | interval `0`, skew `1` | `0` | `dB` | `v.toFixed(1) + " dB"` |
| `mix` | Mix | continuous | `0..100` | interval `0`, skew `1` | `100` | `%` | `v.toFixed(0) + " %"` |
| `preset` | Preset | discrete float | `0..5` | interval `1`, skew `1` | `0` | none | `0=Custom`, `1=Soft Clip`, `2=Hard Clip`, `3=Tube`, `4=Fold`, `5=Rectify` |

Curve data:

- Not an APVTS parameter.
- Stored as control points in `XlethWaveshaperEffect`.
- Current default points: `[[-1, -1], [0, 0], [1, 1]]`.
- Valid count in engine: `2..32` points (`kMaxControlPoints = 32`).
- The UI clamps edited point coordinates to `[-1, 1]`.
- The engine sorts by x and deduplicates x values closer than `1e-5`.
- The engine builds a double-buffered 1024-point LUT (`kLutSize = 1024`) from either preset curves or a natural cubic spline through custom points.
- Generated LUT output is clamped to `[-1, 1]`.

Preset transfer functions:

- `0 Custom`: generated from current control points.
- `1 SoftClip`: `tanh(3 * x)`.
- `2 HardClip`: clamp `2 * x` to `[-1, 1]`.
- `3 Tube`: `(2 / (1 + exp(-3 * x))) - 1`.
- `4 Fold`: `sin(x * pi)`.
- `5 Rectify`: `abs(x)`.

Additional engine behavior, not user params:

- Fixed 4x FIR equiripple oversampling.
- DC blocker at 10 Hz.
- `pregain`, `postgain`, and `mix` are smoothed linearly over 20 ms.
- No discovered bias/asymmetry, smoothing, oversampling, mode beyond `preset`, or separate curve-shape amount parameter.

## 5. Existing meter and telemetry status

### Generic meter slots

Both effects write generic effect meter slots through `XlethEffectBase::writeMeterValue`.

Distortion:

- Slot `0`: L output peak, absolute linear amplitude, max over block.
- Slot `1`: R output peak, absolute linear amplitude, max over block.
- Slots `2..7`: not written by Distortion.

Waveshaper:

- Slot `0`: L output peak, absolute linear amplitude, max over block.
- Slot `1`: R output peak, absolute linear amplitude, max over block.
- Slots `2..7`: not written by Waveshaper.

Current UI usage:

- `DistortionPanel.jsx` does not poll or display these slots.
- `WaveshaperPanel.jsx` does not poll or display these slots.
- A future runtime manifest for Distortion can expose `['PEAK_L', 'PEAK_R']` for basic output meters.
- A future runtime manifest for Waveshaper could also expose `['PEAK_L', 'PEAK_R']`, but that alone is not enough for waveform/spectrum displays.

### Visualization bucket telemetry

Existing visualization pipeline:

- API: `setEffectVisualizationEnabled` and `drainEffectVizFrames`.
- Current typed bucket payloads: compressor, limiter, transient, multiband.
- Type tags are defined in `engine/src/audio/viz/DynamicsVizFrame.h`.
- JS parser is in `ui/src/constants/dynamicsViz.js`.
- Runtime visualizer dispatch is hardcoded in `ui/src/plugin-ui/runtime/components/VisualizerNode.jsx` for compressor, limiter, transient, and overdone source keys.

Distortion and Waveshaper status:

- Neither `XlethDistortionEffect` nor `XlethWaveshaperEffect` overrides:
  - `setVisualizationEnabled`
  - `getVisualizationType`
  - `getVisualizationSchemaVersion`
  - `drainVizFrames`
- Therefore `drainEffectVizFrames` would report type `unknown`, bucket size `0`, count `0` for these plugins.
- There is no current audio-thread bucket telemetry for input waveform, output waveform, spectrum, clipped sample ratio, harmonic energy, or live input/output dots.

Important consequence:

- A static transfer curve can be drawn honestly from parameters and engine formulas.
- A live waveform/history/spectrum/harmonic display cannot be drawn honestly without new engine telemetry.
- Do not invent JS-only audio data or fake telemetry.

## 6. Recommended Distortion visual design

Distortion should be immediate, musical, and visibly nonlinear. It should not look like the compressor/limiter/transient/overdone family.

Recommended layout:

- Header: compact stock plugin header with close and, after migration, optional Designer button following the dynamics host pattern.
- Top: wide transfer display, roughly 340-380 px wide and 120-160 px high.
- Mode row: Tube, Soft Clip, Hard Clip, Analog as a segmented row near the display, not buried below knobs.
- Main controls:
  - Large Drive knob as the visual and interaction anchor.
  - Tone and Mix as secondary knobs.
  - Filter Pre/Post as a compact two-state switch.
- Optional small output meter using existing `PEAK_L/PEAK_R` slots only if useful. Do not let basic peak metering become the visual identity.

Transfer display concept:

- X axis: input amplitude `[-1, 1]`.
- Y axis: output amplitude `[-1, 1]`.
- Include a subtle diagonal reference line for clean passthrough.
- Draw the current transfer curve using the selected `mode`, `drive`, and `mix`.
- Treat `tone` and `filter_pos` as labels/markers, not as a nonlinear curve change. Tone is a low-pass filter and cannot be represented as a static amplitude transfer curve.
- The curve should visibly communicate:
  - Tube: smooth symmetric saturation.
  - Soft Clip: rounded shoulder.
  - Hard Clip: flat clipped plateaus.
  - Analog: asymmetric negative/positive behavior.
- For hard clip and analog, show clip/saturation regions as understated background zones.
- Use existing distortion theme tokens where applicable:
  - `--theme-dist-waveshape-curve`
  - `--theme-dist-waveshape-fill`
  - `--theme-dist-input-overlay`
  - `--theme-dist-drive-indicator`
  - `--theme-dist-asymmetry-indicator`
- Do not hardcode final colors in React. Canvas painters should resolve theme variables/tokens at draw time, following existing visualizer theme patterns.

Param-only visualizer feasibility:

- Feasible for a static transfer curve.
- It should not call `setEffectVisualizationEnabled` because no engine bucket stream is needed.
- The runtime visualizer system currently assumes dynamics bucket telemetry for known source keys. Distortion will need either:
  - a new param-only visualizer branch/source, for example `distortion.transferCurve`, or
  - a small custom runtime node/component dedicated to transfer curves.
- Prefer the first option if it can be added without new Designer features: a `distortionPainter.js` that consumes `ctx.params` only.

Live overlays, only if telemetry is added later:

- Input/output dot on the transfer curve from real audio samples or bucketed matched input/output.
- Waveform before/after strip from downsampled real audio telemetry.
- Spectrum/harmonic energy display only from real engine-side measured data.

## 7. Recommended Waveshaper visual design

Waveshaper should be more editable and technical than Distortion. The engine already supports an editable curve, so the main display should remain the core interaction.

Recommended layout if retaining specialized editor:

- Header: compact stock panel header.
- Main: larger transfer curve editor, preferably wider than the current square-only 300 x 300 surface.
- Curve editor features already supported and should remain:
  - visible control points.
  - add point by clicking.
  - drag point.
  - remove point by right-click.
  - spline preview.
  - preset curve recall.
- Improve the visual hierarchy:
  - diagonal reference line.
  - clearer x/y axes and zero cross.
  - stronger selected/dragging point state.
  - better distinction between preset shape and custom-edited shape.
- Controls:
  - Pre Gain, Post Gain, Mix.
  - Preset buttons: Custom, Soft Clip, Hard Clip, Tube, Fold, Rectify. Current UI omits Custom, even though preset `0` is real.
- Optional controls only if real params are added in the engine later:
  - Bias/asymmetry.
  - Smoothing.
  - Oversampling.
  - Shape amount.

Runtime vs specialized recommendation:

- Do not force Waveshaper into the current generic runtime for the next pass.
- The current runtime supports knobs, toggles, buttons, meters, labels, layout, freeform decoration, decals, and dynamics-style visualizers.
- It does not currently support an interactive, plugin-specific point-array editor with bridge-backed `wsGetCurvePoints/wsSetCurvePoints`.
- Adding a generic curve editor would be a new Designer/runtime feature, which is out of scope.
- Recommended path: keep Waveshaper as a specialized panel for now, redesigning the existing editor UI around the real curve APIs.
- A later custom runtime component is possible if Xleth wants plugin-specific runtime nodes, but that should be a separate architecture decision.

Param-only preview feasibility:

- Feasible, because the UI already has the actual control points and preset state.
- No audio telemetry is needed to draw the curve.
- Live waveform/spectrum still requires engine telemetry.

## 8. Migration strategy

### Distortion

Recommended: migrate to the stock plugin UI runtime and Designer, with a custom param-only transfer visualizer added after the basic host lands.

Reasoning:

- Distortion's control surface is simple and maps cleanly to current runtime primitives:
  - knobs for `drive`, `tone`, `mix`.
  - discrete toggles for `mode`.
  - discrete toggles for `filter_pos`.
  - optional meter nodes for `PEAK_L/PEAK_R`.
- It does not require interactive point editing.
- It benefits from Designer/user layout overrides.
- Its visual identity can be achieved with a param-derived transfer curve without touching DSP or bridge.

Migration notes:

- Add `ui/src/plugin-ui/manifests/distortion.js`.
- Add `ui/src/plugin-ui/layouts/distortion.json`.
- Register Distortion in:
  - `ui/src/plugin-ui/manifests/index.js`
  - `ui/src/plugin-ui/layouts/index.js`
  - `ui/main.js` `KNOWN_PLUGIN_IDS`
  - `ui/main.js` `SHIPPED_PLUGIN_UI_LAYOUT_FILES`
- Convert `DistortionPanel.jsx` to a runtime host like `LimiterPanel.jsx`, with the current legacy JSX body retained as an error fallback during migration.
- Distortion-A should not add DSP, bridge telemetry, or the transfer painter yet unless scoped explicitly.
- Distortion-B should add the param-only transfer visualizer.

### Waveshaper

Recommended: keep specialized for the next redesign implementation.

Reasoning:

- Real curve editing exists today and is core to the plugin identity.
- The current runtime cannot express `wsGetCurvePoints/wsSetCurvePoints` interactions as layout JSON.
- A generic curve-editor node would be a new Designer/runtime feature and is explicitly out of scope.
- The best immediate redesign is to improve the existing specialized `WaveshaperPanel.jsx` while keeping engine/bridge boundaries intact.

Possible later path:

- Create a plugin-specific runtime component system that can host a `waveshaper.curveEditor` node.
- That should be a separate project because it affects schema validation, Designer palette/inspector, persistence compatibility, and bridge action modeling.

## 9. Telemetry plan if needed

No telemetry is required for Distortion-B's static transfer curve or for Waveshaper's existing curve editor.

Telemetry is required for:

- live transfer dots based on real audio.
- before/after waveform strips.
- clipped sample ratio over time.
- spectrum or harmonic energy displays.

Rules:

- Do not fake audio data in JS.
- No allocations, locks, logging, or IPC on the audio thread.
- Follow the existing lazy SPSC collector pattern in `engine/src/audio/viz/DynamicsVizCollector.h`.
- Disabled path should be near-zero overhead: an atomic pointer/null check per block, matching the dynamics visualization approach.
- Add new type tags and bucket structs only in lockstep with JS parser constants.

Possible Distortion bucket schema:

- `BucketHeader hdr`
- `float inputPeakDb`
- `float outputPeakDb`
- `float driveDb`
- `float toneHz`
- `float mix`
- `float mode`
- `float filterPos`
- `float clippedSampleRatio`
- `float asymmetry`
- `float reserved0`

Notes:

- `clippedSampleRatio` should be measured in the engine from actual processing conditions, not inferred from params.
- `asymmetry` can be a cheap signed output/input imbalance proxy if measured, but should be omitted or reserved if not meaningful.
- A harmonic energy proxy is only acceptable if it is cheap and clearly documented as a proxy. Do not label it as true spectrum/THD unless the engine computes that measurement.

Possible Waveshaper bucket schema:

- `BucketHeader hdr`
- `float inputPeakDb`
- `float outputPeakDb`
- `float pregainDb`
- `float postgainDb`
- `float mix`
- `float preset`
- `float clippedSampleRatio`
- `float reserved0`
- `float reserved1`

Notes:

- The curve itself is already available to the UI through `wsGetCurvePoints`; do not stream curve points in audio telemetry.
- Live waveform/history still needs explicit measured samples or bucketed level history.
- If spectrum is desired, design a separate, efficient analysis path rather than overloading scalar bucket telemetry.

Bridge/runtime additions if telemetry is later added:

- Add `kVizTypeDistortion` and/or `kVizTypeWaveshaper`.
- Add C++ POD bucket structs and static asserts.
- Extend `Audio_DrainEffectVizFrames` type-tag to string mapping.
- Extend `ui/src/constants/dynamicsViz.js` or rename/generalize it if it becomes broader than dynamics.
- Add parser tests for byte size, schema, type mismatch, and zero-count payloads.
- Add visualizer painter tests with deterministic bucket fixtures.

## 10. Implementation phases

### Distortion-A: runtime manifest/layout/panel host

Goal: migrate Distortion to the stock plugin UI runtime shell without changing DSP or bridge behavior.

Scope:

- Add Distortion manifest with exact params from this audit.
- Add shipped Distortion layout using current controls.
- Register Distortion layout/manifest and shipped-layout access.
- Convert `DistortionPanel.jsx` to the runtime/Designer host pattern used by Limiter/Compressor, with the current legacy body as fallback.
- Keep visualizer out of this phase or use only static labels/decor. No fake visualization.
- Expose only existing meter slots if a meter is included: `PEAK_L`, `PEAK_R`.

### Distortion-B: param-derived transfer visualizer

Goal: add the nonlinear transfer display from params only.

Scope:

- Add a Distortion visualizer source, for example `distortion.transferCurve`.
- Add a painter, for example `ui/src/plugin-ui/runtime/visualizers/distortionPainter.js`.
- Draw from `mode`, `drive`, and `mix` using the engine formulas.
- Do not enable or drain engine visualization buckets for this static painter.
- Use theme tokens/CSS variables, not hardcoded final colors.
- Add painter tests with fake param frames only.

### Distortion-C: optional real telemetry

Goal: add live activity only if waveform/live-dot/clip-ratio display is explicitly desired.

Scope:

- Add C++ bucket struct and collector.
- Add bridge mapping and JS parser.
- Add renderer subscription/painter support.
- Keep disabled path near-zero overhead.
- No DSP behavior changes beyond measurement.

### Waveshaper-A: focused implementation audit and UI path decision

Goal: confirm exact curve-editor needs immediately before implementation.

Scope:

- Reconfirm curve point API behavior and preset sync.
- Decide whether the redesign is a specialized panel update only, or whether a narrowly scoped custom runtime component is allowed.
- Because current constraints say no new Designer features, the expected outcome is specialized panel update.

### Waveshaper-B: specialized panel redesign

Goal: redesign the current curve editor around the real engine shape model.

Scope:

- Improve curve editor presentation and controls.
- Add an explicit Custom preset state if desired.
- Keep using `wsGetCurvePoints/wsSetCurvePoints/wsSetPreset`.
- Keep engine, bridge, and DSP unchanged unless a later prompt explicitly changes scope.

### Shared verification

- Keep existing dynamics runtime tests passing.
- Keep Parametric EQ tests passing.
- Keep legacy stock panels unaffected.
- Ensure any new layout validates through the existing schema.
- Avoid asset/decal/SVG system changes.

## 11. Test plan

Distortion-A tests:

- Manifest registration test:
  - `getManifest('distortion')` returns a manifest.
  - Params include exactly `mode`, `drive`, `tone`, `filter_pos`, `mix`.
  - Meter slots include only existing slots if exposed: `PEAK_L`, `PEAK_R`.
- Layout registration test:
  - `SHIPPED_LAYOUTS.distortion` exists.
  - The shipped layout validates against the Distortion manifest.
- Main-process shipped layout test, if current test harness covers it:
  - `KNOWN_PLUGIN_IDS` and `SHIPPED_PLUGIN_UI_LAYOUT_FILES` accept `distortion`.
- Panel host smoke test:
  - Opening a Distortion target renders the runtime host.
  - Runtime failure falls back to legacy body.
  - Designer button appears only behind the existing `DESIGNER_ENABLED` flag.
- No bridge/DSP tests required because Distortion-A should not touch bridge or engine.

Distortion-B tests:

- Painter math tests:
  - Tube curve is monotonic and saturates.
  - Soft Clip has rounded shoulders and clamps/normalizes as engine formula does.
  - Hard Clip plateaus at `[-1, 1]`.
  - Analog mode is asymmetric.
  - Mix blends toward the diagonal when below 100%.
- Runtime visualizer tests:
  - `distortion.transferCurve` renders without calling `setEffectVisualizationEnabled`.
  - Unknown sources still fall back safely.
  - Theme token resolution has fallback behavior.

Distortion-C tests, only if telemetry is added:

- C++ static asserts for bucket size/alignment.
- Bridge drain returns correct type string, schema, bucket size, count.
- JS parser rejects schema/type/size mismatch.
- Disabled visualization does not allocate or push buckets.
- Enabled drain handles empty payloads.

Waveshaper tests:

- Store tests for point dedupe/sorting if a test harness exists for stores.
- Curve editor interaction smoke tests:
  - add point.
  - drag point.
  - remove point.
  - preset selection fetches updated points.
  - editing points returns preset to Custom.
- No audio telemetry tests unless real telemetry is added later.

Regression tests:

- Existing Compressor/Limiter/Transient/Overdone runtime tests keep passing.
- Existing EQ analyzer/inspector/output meter tests keep passing.
- Existing plugin UI Designer validation/freeform/appearance tests keep passing.

## 12. Exact next implementation prompt for Distortion-A only

Use this prompt for the next implementation step:

```text
Implement Distortion-A for Xleth only.

Scope:
- Migrate the existing Distortion stock panel to the reusable plugin UI runtime/Designer host.
- Do not touch DSP.
- Do not touch bridge APIs.
- Do not add audio telemetry.
- Do not add the transfer-curve painter yet.
- Do not alter Waveshaper, EQ, Compressor, Limiter, Transient, or Overdone behavior.

Required work:
1. Add `ui/src/plugin-ui/manifests/distortion.js`.
   - pluginId: `distortion`.
   - params from `engine/src/audio/XlethDistortionEffect.h::createLayout()`:
     - `mode`: discrete, 0..3, default 0, raw, label Mode.
     - `drive`: continuous, 0..48, default 12, dB1, label Drive.
     - `tone`: continuous, 20..20000, default 8000, exact existing display is integer Hz. Add/use an appropriate formatter only if needed.
     - `filter_pos`: discrete, 0..1, default 1, raw, label Filter Position.
     - `mix`: continuous, 0..100, default 100, pct0, label Mix.
   - meterSlots: expose only `PEAK_L` and `PEAK_R` if the layout uses meters; otherwise keep the manifest ready for them.
   - vizSources: empty for Distortion-A.

2. Add `ui/src/plugin-ui/layouts/distortion.json`.
   - Recreate the current functional controls in runtime JSON:
     - mode buttons/toggles for Tube, Soft Clip, Hard Clip, Analog.
     - knobs for Drive, Tone, Mix.
     - compact Pre/Post filter toggles.
   - Use theme/runtime appearance tokens only. No hardcoded final colors in React.
   - No fake waveform, spectrum, or transfer display in this phase.

3. Register the manifest/layout:
   - `ui/src/plugin-ui/manifests/index.js`
   - `ui/src/plugin-ui/layouts/index.js`
   - `ui/main.js` `KNOWN_PLUGIN_IDS`
   - `ui/main.js` `SHIPPED_PLUGIN_UI_LAYOUT_FILES`

4. Convert `ui/src/components/mixer/DistortionPanel.jsx` to the same runtime host pattern used by `LimiterPanel.jsx`.
   - Preserve the existing legacy Distortion body as an error-boundary fallback.
   - Add Designer split support behind the existing `DESIGNER_ENABLED` feature flag.
   - Keep the current store/open/close flow unchanged.

5. Add focused tests:
   - manifest registration.
   - shipped layout validation.
   - panel host smoke/fallback if the current test harness supports it.
   - Ensure existing plugin UI runtime/Designer tests still pass.

Verification:
- Run the relevant UI/plugin-ui tests available in the repo.
- Report any tests that cannot be run.
```


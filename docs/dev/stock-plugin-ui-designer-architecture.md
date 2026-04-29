# Stock Plugin UI Designer — Architecture & Schema

**Status:** Design only. No code in this pass.
**Scope:** Stock plugin UIs (Compressor, Limiter, Transient Processor, Overdone today; pattern extends to all future stock plugins). VST3 plugin editors are out of scope — they continue to open as native windows via `openPluginEditor`.
**Audience:** Whoever implements the runtime renderer, the layout schema validator, and (later) the Plugin UI Designer mode.

This document is the companion to [dynamics-visualization-diagnostic.md](dynamics-visualization-diagnostic.md). The visualization plan tells us *what data the engine emits*; this plan tells us *how a layout file binds React widgets to that data*.

---

## 1. High-level architecture

Today, each stock plugin is a hand-written React component that:

- declares its own `KNOBS` array,
- duplicates the same `requestAnimationFrame` meter polling loop,
- duplicates the same floating-panel chrome (header, drag, close),
- references meter slots by raw integer (`meters[2]` for GR, `meters[3]` for momentary LUFS, etc.),
- has no shared visualizer layer at all.

See [CompressorPanel.jsx](../../ui/src/components/mixer/CompressorPanel.jsx), [LimiterPanel.jsx](../../ui/src/components/mixer/LimiterPanel.jsx), [TransientProcPanel.jsx](../../ui/src/components/mixer/TransientProcPanel.jsx), [OTTPanel.jsx](../../ui/src/components/mixer/OTTPanel.jsx) — they are ~85 % the same scaffolding around different parameter tables.

The new design replaces *the body* of each panel with a **runtime renderer** that interprets a **declarative JSON layout document**:

```
                 ┌─────────────────────────────────────────────┐
                 │  ui/src/plugin-ui/layouts/compressor.json   │  ← shipped default
                 │  ui/src/plugin-ui/layouts/limiter.json      │     (in-repo, source-controlled)
                 │  ui/src/plugin-ui/layouts/transientproc.json│
                 │  ui/src/plugin-ui/layouts/overdone.json     │
                 └─────────────────────────────────────────────┘
                                    │  load on app start
                                    ▼
   ┌────────────────────────┐   ┌────────────────────────┐   ┌──────────────────────────┐
   │ userData/plugin-ui/    │   │  Layout registry       │   │  Schema validator        │
   │   compressor.json      │──▶│  (per pluginId, with   │◀──│  (versioned; rejects to  │
   │   limiter.json         │   │   override-on-default) │   │   safe defaults on bad   │
   │   …                    │   │                        │   │   layouts)               │
   └────────────────────────┘   └────────────┬───────────┘   └──────────────────────────┘
       user-override layouts                 │
       (Electron userData; never             │  layout doc  +  binding tables
        written into project files)          ▼
                                  ┌──────────────────────────────┐
                                  │  StockPluginRuntimeRenderer  │  ← the only React entry point
                                  │  (component registry walks   │     for stock plugins
                                  │   the layout tree and mounts │
                                  │   only allow-listed types)   │
                                  └──────────────┬───────────────┘
                                                 │  bound by id
                  ┌──────────────────────────────┼──────────────────────────────┐
                  ▼                              ▼                              ▼
           Param sources                   Meter sources                  Viz sources
       window.xleth.audio                 getEffectMeter slot           drainEffectVizFrames
       getEffectParameters /              by semantic key                (per dynamics-visualization
       setEffectParameter                 (PEAK_L, GAIN_REDUCTION,        plan; bucket ring buffer
       (param id, denormalised)           BAND_GR_MID, …)                 of compressor.gainReduction
                                                                          etc.)
```

The visual editor sits **next to** this pipeline, not on top of it. It edits the same JSON documents the runtime reads — never JSX, never CSS. When the editor saves, the runtime re-reads and re-mounts.

```
┌────────────────────┐   write   ┌────────────────────┐   read    ┌──────────────────────┐
│  Plugin UI         │──────────▶│  Layout document   │──────────▶│  Runtime renderer    │
│  Designer mode     │           │  (JSON, validated) │           │  (no eval, registry) │
└────────────────────┘           └────────────────────┘           └──────────────────────┘
```

---

## 2. Subsystem boundaries

These five layers must stay separable. A bug in any one of them must be fixable without touching the others.

### 2.1 Layout schema

- One self-describing JSON document per plugin.
- Strictly versioned (`schemaVersion`).
- Validated by a JS-side validator (no AJV runtime if avoidable; a small handwritten walker keeps the bundle thin and the error messages domain-specific).
- Schema lives in `ui/src/plugin-ui/schema/` — TypeScript types in `ui/src/types/pluginUiSchema.ts`, runtime validator in `ui/src/plugin-ui/schema/validate.js`.

### 2.2 Runtime renderer

- React component that takes `(pluginId, target = { trackId, nodeId })` and renders the bound layout.
- Walks the layout tree top-down, mounting only registered component types.
- Owns *all* meter polling and viz subscription for the panel — the React components inside the layout consume refs/buffers, never mount their own poll loops.
- Lives at `ui/src/plugin-ui/runtime/` (renderer, registry, bindings).

### 2.3 Visual editor

- Separate React surface that loads the *same* JSON, mutates it in-memory, validates on each change, and writes back.
- Cannot generate React code. Cannot generate CSS. Cannot generate scripts. All edits are tree edits on the JSON document.
- Lives at `ui/src/plugin-ui/designer/` (later phase — *not built in the first cut*).

### 2.4 Storage / import / export

- Default layouts shipped in repo (`ui/src/plugin-ui/layouts/<pluginId>.json`, bundled by Vite).
- User overrides written to `userData/plugin-ui/<pluginId>.json` (mirrors the existing user-theme pattern at [main.js:683-730](../../ui/main.js)).
- Import/export uses the file extension `.xlethui.json`. Import = "save into userData as override for this pluginId". Export = "write the current effective layout to a file the user picked".
- Project files (`.xleth` etc.) keep plugin parameter state. They do **not** embed layout JSON by default. (Optional future feature in §11.)

### 2.5 Engine visualization telemetry

- Data source for `<visualizer>` widgets. Defined by [dynamics-visualization-diagnostic.md](dynamics-visualization-diagnostic.md).
- The runtime renderer is the only thing that subscribes to viz frames. A `<visualizer>` node names a *visualization source key* (e.g. `compressor.gainReductionHistory`); the runtime resolves that key against a per-plugin `visualizationSources` registry, opens a subscription, and hands the buffer ref to the matching painter.
- The schema does **not** describe waveforms or scales — it just names a source. The painter for that source decides how to draw it. This keeps the layout file editor-trivial and prevents users from building broken or expensive custom visualizations.

---

## 3. Layout schema

### 3.1 Top-level document shape

```json
{
  "schemaVersion": 1,
  "pluginId": "compressor",
  "name": "Default Compressor Layout",
  "panel": {
    "preferredSize": { "width": 440, "height": 280 },
    "minSize":       { "width": 360, "height": 220 }
  },
  "root": {
    "id": "root",
    "type": "panel",
    "children": [ /* … */ ]
  }
}
```

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | yes | Integer. Bump on any incompatible schema change. Validator rejects unknown versions and falls back to the built-in default (§9). |
| `pluginId` | yes | Must match the panel's plugin id (e.g. `compressor`, `limiter`, `transientproc`, `overdone`). Cross-plugin layouts are not supported. |
| `name` | optional | Human-readable label, surfaced by the designer's layout picker. |
| `panel.preferredSize` / `panel.minSize` | optional | Floating-panel chrome sizing hints. The chrome (titlebar, drag, close) is **not** part of the layout — it's owned by the runtime renderer. |
| `root` | yes | Must be a `panel`-type node. The renderer mounts this and recurses. |

### 3.2 Component node shape

Every node has the same envelope:

```json
{
  "id": "stable-string-id",
  "type": "<allow-listed type>",
  "style": { /* layout hints, see §3.4 */ },
  "props": { /* type-specific properties */ },
  "children": [ /* container types only */ ]
}
```

Rules:

- `id` is **required** and must be unique within the document. The designer uses ids to track edits across saves; the runtime uses them as React keys and for accessibility (`data-pluginui-id`).
- `type` must be one of the allow-listed types (§4).
- `style` is a *limited* object (`paddingPx`, `gapPx`, `flexBasis`, `align`, `justify`, `widthPx`, `heightPx`, `growsToFill`). It is **not** a CSS pass-through. Anything not in this list is dropped by the validator.
- `props` is type-specific and validated per type. Unknown props are dropped with a console warning; required props missing → the *node* falls back to a placeholder (not the whole layout — see §9).
- `children` is only valid for container types (`panel`, `group`, `row`, `column`, `tabGroup`).

### 3.3 Example — Compressor (default)

```json
{
  "schemaVersion": 1,
  "pluginId": "compressor",
  "name": "Default Compressor Layout",
  "panel": { "preferredSize": { "width": 440, "height": 300 } },
  "root": {
    "id": "root",
    "type": "panel",
    "style": { "paddingPx": 10, "gapPx": 8 },
    "children": [
      {
        "id": "knob-grid",
        "type": "group",
        "style": { "gapPx": 6 },
        "props": { "title": null, "columns": 4 },
        "children": [
          { "id": "k-thresh",  "type": "knob", "props": { "param": "threshold", "label": "THRESH",   "size": 52, "format": "dB1" } },
          { "id": "k-ratio",   "type": "knob", "props": { "param": "ratio",     "label": "RATIO",    "size": 52, "format": "ratio" } },
          { "id": "k-attack",  "type": "knob", "props": { "param": "attack",    "label": "ATTACK",   "size": 52, "format": "ms1" } },
          { "id": "k-release", "type": "knob", "props": { "param": "release",   "label": "RELEASE",  "size": 52, "format": "ms0" } },
          { "id": "k-knee",    "type": "knob", "props": { "param": "knee",      "label": "KNEE",     "size": 52, "format": "dB1" } },
          { "id": "k-makeup",  "type": "knob", "props": { "param": "makeup",    "label": "MAKEUP",   "size": 52, "format": "dB1" } },
          { "id": "k-mix",     "type": "knob", "props": { "param": "mix",       "label": "MIX",      "size": 52, "format": "pct0" } },
          { "id": "k-look",    "type": "knob", "props": { "param": "lookahead", "label": "LOOKAHEAD","size": 52, "format": "ms1" } }
        ]
      },
      {
        "id": "right-column",
        "type": "column",
        "style": { "gapPx": 6, "widthPx": 90 },
        "children": [
          { "id": "gr-meter",  "type": "meter",
            "props": {
              "source":     { "kind": "effectMeter", "slot": "GAIN_REDUCTION" },
              "label":      "GR",
              "unit":       "dB",
              "range":      { "min": 0, "max": 40, "scale": "linear" },
              "orientation":"vertical",
              "format":     "dB1"
            }
          },
          { "id": "gr-history", "type": "visualizer",
            "props": {
              "source":  "compressor.gainReductionHistory",
              "preset":  "scrollingStrip",
              "heightPx": 120
            }
          }
        ]
      },
      {
        "id": "detect-row",
        "type": "row",
        "style": { "gapPx": 4 },
        "children": [
          { "id": "label-detect", "type": "label", "props": { "text": "Detect:" } },
          { "id": "btn-peak", "type": "toggle",
            "props": {
              "param":      "detect_mode",
              "mode":       "discreteValue",
              "valueWhenOn": 0,
              "label":      "Peak"
            }
          },
          { "id": "btn-rms", "type": "toggle",
            "props": {
              "param":      "detect_mode",
              "mode":       "discreteValue",
              "valueWhenOn": 1,
              "label":      "RMS"
            }
          }
        ]
      }
    ]
  }
}
```

This layout is bit-for-bit equivalent to today's hand-written `CompressorPanel`, plus a viz region from the dynamics-visualization plan.

### 3.4 The `style` allow-list

Layouts must not let users write arbitrary CSS — that breaks theming, breaks accessibility, and turns the JSON file into an attack surface. The allow-list is small on purpose:

| Key | Type | Notes |
| --- | --- | --- |
| `paddingPx` | number \| `[t,r,b,l]` | Inner padding. |
| `gapPx` | number | Flex/grid gap between children. |
| `widthPx` / `heightPx` | number | Fixed size for the node. Container nodes that omit this auto-size to children. |
| `growsToFill` | boolean | Sets `flex-grow: 1` so the node consumes leftover space in its row/column. |
| `align` | `"start" \| "center" \| "end" \| "stretch"` | Cross-axis alignment for flex children. |
| `justify` | `"start" \| "center" \| "end" \| "spaceBetween" \| "spaceAround"` | Main-axis alignment. |
| `flexBasis` | number | Used inside rows/columns for proportional sizing. |

Colors, fonts, borders, shadows, radii — **not** in the layout. They come from the global theme tokens. This is non-negotiable: themes must keep working across all user-edited layouts.

---

## 4. Allowed component types

The runtime renderer mounts a node only if its `type` exists in the registry. Anything else is replaced by a placeholder rectangle that says `Unknown type: <name>` (in dev builds) or is silently skipped (in production builds).

### 4.1 Container types

| Type | Purpose | Container? |
| --- | --- | --- |
| `panel` | Top-level region. Exactly one per layout (the `root`). | yes |
| `group` | Boxed sub-region with optional title. Renders a labelled fieldset-style block. | yes |
| `row` | Horizontal flex container. | yes |
| `column` | Vertical flex container. | yes |
| `tabGroup` | Renders `children` as tab pages. Each child must declare `props.tabLabel`. Only the active tab is mounted. | yes |

### 4.2 Leaf types

| Type | Purpose | Required `props` |
| --- | --- | --- |
| `knob` | Continuous parameter knob. Wraps the existing [Knob.jsx](../../ui/src/components/sampler/Knob.jsx) primitive. | `param` (string id), `label` (string), `format` (string from format registry, §6.4), `size` (number), `dragRange` (number, optional) |
| `toggle` | Boolean or discrete-value button. Two flavours selected by `mode`: `boolParam` flips `0/1`, `discreteValue` writes a fixed numeric value when on (used for radio-style param sets like `detect_mode` Peak/RMS). | `param`, `mode`, `label`. For `discreteValue`: `valueWhenOn`. |
| `button` | Stateless action. Triggers a named, registry-listed action (no arbitrary code) — e.g. `compressor.resetGRPeak`, `panel.close`. | `action` (string from action registry), `label` |
| `meter` | Single-value bar/dial readout, polled from the 8-slot meter array. | `source` (binding object, §6.2), `range`, `orientation` (`"vertical" \| "horizontal"`), `format` |
| `visualizer` | Time-series painter region. Subscribes to a *visualization source key* (§6.3). | `source` (string), `preset` (string from painter registry), `heightPx` |
| `label` | Static text. | `text` |
| `spacer` | Empty flex item that takes space. | (none) |

Any future widget — XY pad, FFT spectrum, midi-keyboard preview — gets added by registering a new leaf type *and* (where applicable) a new visualization-source key. The schema does not allow ad-hoc widgets.

### 4.3 Why no `image`, `iframe`, `html`, `script` types

Open-source contributors will share `.xlethui.json` files. Anything that lets a layout embed remote content, raw HTML, or executable code is a supply-chain hazard. The runtime renderer must be a closed allow-list.

---

## 5. Source-of-truth: layout registry & defaults

```js
// ui/src/plugin-ui/layouts/index.js
import compressorDefault   from './compressor.json'
import limiterDefault      from './limiter.json'
import transientprocDefault from './transientproc.json'
import overdoneDefault     from './overdone.json'

export const SHIPPED_LAYOUTS = {
  compressor:    compressorDefault,
  limiter:       limiterDefault,
  transientproc: transientprocDefault,
  overdone:      overdoneDefault,
}
```

Loading order at runtime:

1. Renderer asks the registry for `pluginId`'s effective layout.
2. Registry calls `window.xleth.pluginUi.loadUserLayout(pluginId)` (new IPC, see §7).
3. If a user override exists *and* validates → use that.
4. Else use `SHIPPED_LAYOUTS[pluginId]`.
5. If the shipped layout itself fails to validate (developer error) → use a hard-coded built-in placeholder layout (§9.3) so the panel still opens.

The cache invalidation hook: when the designer saves, it calls `pluginUi.notifyLayoutChanged(pluginId)`, which broadcasts on the existing IPC bus (`onGraphChanged` style) so every open editor for that plugin re-mounts.

---

## 6. Binding model

This is the part that makes the JSON useful: how leaf nodes wire up to the engine.

### 6.1 Parameter binding (`knob`, `toggle`)

- A `knob` or `toggle` declares `props.param: "<paramId>"`.
- `paramId` is the *plugin parameter id* — the same string the engine returns from [`getEffectParameters`](../../ui/preload.js) and accepts in `setEffectParameter`. **Never** the display label.
- The runtime hydrates current values once on mount via `getEffectParameters(trackId, nodeId)` (matching every existing panel's hydration path; see [CompressorPanel.jsx:74-92](../../ui/src/components/mixer/CompressorPanel.jsx)) and writes via `setEffectParameter`.
- `min`/`max`/`default` are **not** in the layout. They come from the engine's parameter descriptor (an extension to `getEffectParameters` already returning `id` and `value` — see §10.1).
- Display formatting comes from a small named formatter registry (§6.4).

Why no min/max in the layout: the engine is the source of truth. Putting numeric bounds in the JSON lets a layout drive a knob outside the engine's accepted range, which the engine then clamps silently — confusing both the user and the designer. One source.

### 6.2 Meter binding (`meter`)

- `props.source` is a *binding object*, not a magic number:

  ```json
  { "kind": "effectMeter", "slot": "GAIN_REDUCTION" }
  ```

- `kind` is `"effectMeter"` for the existing 8-slot atomic array.
- `slot` is a *semantic key* defined in [ui/src/constants/meterSlots.js](../../ui/src/constants/meterSlots.js):
  `PEAK_L`, `PEAK_R`, `GAIN_REDUCTION`, `LUFS_MOMENTARY`, `LUFS_SHORT_TERM`, `BAND_GR_LOW`, `BAND_GR_MID`, `BAND_GR_HIGH`. The runtime resolves these to slot indices.
- New semantic keys are added by extending the constants module *and* the validator's allow-list. They are never raw integers in JSON.
- The runtime owns **one** poll loop per panel that drains all `meter` nodes' bindings together, replacing today's four per-panel `rAF` polls.

### 6.3 Visualizer binding (`visualizer`)

- `props.source` is a *visualization source key* — a string from a fixed registry per plugin:

  | pluginId | Allowed source keys |
  | --- | --- |
  | `compressor` | `compressor.levelHistory`, `compressor.gainReductionHistory`, `compressor.transferCurve`, `compressor.detector` |
  | `limiter`    | `limiter.levelHistory`, `limiter.gainReductionHistory`, `limiter.truePeak`, `limiter.lufs` |
  | `transientproc` | `transient.envelopes`, `transient.gainHistory`, `transient.onsets` |
  | `overdone`   | `overdone.bandActivity`, `overdone.bandLevels` |

- `props.preset` selects the painter — e.g. `"scrollingStrip"`, `"transferCurveLive"`, `"stackedBands"`. Painters are React components in `ui/src/plugin-ui/runtime/visualizers/` and are registered by name. Layouts cannot define new painters.
- The runtime opens **one** subscription per (sourceKey, target) pair via `setEffectVisualizationEnabled` + `drainEffectVizFrames` (per dynamics-visualization-diagnostic §5). Multiple `<visualizer>` nodes that bind to the same source share the same subscription and the same ring buffer.
- The visualization frame schema version is checked at subscription time. If the renderer's expected schema doesn't match what the engine returned, the visualizer node renders a `Visualization unavailable` placeholder — but the rest of the layout still renders.

### 6.4 Format registry

```js
// ui/src/plugin-ui/runtime/formats.js
export const FORMATS = {
  raw:    v => String(Math.round(v)),
  dB1:    v => `${v.toFixed(1)} dB`,
  dB1_signed: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`,
  ms0:    v => `${v.toFixed(0)} ms`,
  ms1:    v => `${v.toFixed(1)} ms`,
  pct0:   v => `${v.toFixed(0)} %`,
  pct1:   v => `${v.toFixed(1)} %`,
  ratio:  v => `${v.toFixed(1)}:1`,
  hz_smart: v => v >= 1000 ? `${(v/1000).toFixed(1)}k Hz` : `${v.toFixed(0)} Hz`,
  lufs1:  v => `${v.toFixed(1)} LUFS`,
}
```

A `format` not in this registry → fallback to `raw` and warn in dev.

### 6.5 Action registry (for `button`)

```js
export const ACTIONS = {
  'panel.close':            (ctx) => ctx.close(),
  'compressor.resetGRPeak': (ctx) => ctx.callPlugin('resetGRPeak'),
  // …
}
```

Same closed-set principle. A `button` whose `action` is unknown renders disabled and warns in dev.

---

## 7. Storage, import, and export

### 7.1 File locations

| What | Location | Source-controlled? | Loaded how |
| --- | --- | --- | --- |
| Shipped default layouts | `ui/src/plugin-ui/layouts/<pluginId>.json` | yes | Bundled by Vite, imported into `SHIPPED_LAYOUTS` map. |
| User-override layouts | `<userData>/plugin-ui/<pluginId>.json` | no | Read on demand via new IPC (see §7.2). Mirrors the user-themes pattern at [main.js:683-730](../../ui/main.js). |
| Designer-saved import/export files | Anywhere on disk, file picker dialog | n/a | Extension `.xlethui.json`. Always validated before use. |

`<userData>` resolves via Electron's `app.getPath('userData')`, surfaced through the existing `userDataPath()` helper in `ui/runtimePaths.js`.

### 7.2 Proposed IPC surface

New surface in `ui/preload.js`, mirroring the existing `theme` namespace:

```js
window.xleth.pluginUi = {
  // Effective layout = user override if valid, else shipped default.
  getEffective:         (pluginId)            => invoke('xleth:pluginUi:getEffective', pluginId),
  // Just the shipped default — used by the designer's "reset" action.
  getShipped:           (pluginId)            => invoke('xleth:pluginUi:getShipped', pluginId),
  // Read user override (returns null if not present or invalid).
  loadUserOverride:     (pluginId)            => invoke('xleth:pluginUi:loadUserOverride', pluginId),
  // Save / clear user override. Saves call the validator; reject on fail.
  saveUserOverride:     (pluginId, layout)    => invoke('xleth:pluginUi:saveUserOverride', pluginId, layout),
  clearUserOverride:    (pluginId)            => invoke('xleth:pluginUi:clearUserOverride', pluginId),
  // Import / export to arbitrary disk path via dialog.
  importDialog:         ()                    => invoke('xleth:dialog:importPluginUi'),    // returns { pluginId, layout } or null
  exportDialog:         (pluginId, layout)    => invoke('xleth:dialog:exportPluginUi', pluginId, layout),
  // Cross-window invalidation.
  onLayoutChanged:      (cb)                  => ipcRenderer.on('xleth:pluginUi:changed', (_, pid) => cb(pid)),
}
```

Validation runs **on the main process** before writing to disk, *and* on the renderer before mounting. Defence-in-depth — the file may have been hand-edited between writes.

### 7.3 File format on disk

Identical to the in-memory document, with one wrapping field for portability:

```json
{
  "$xleth": "plugin-ui-layout",
  "schemaVersion": 1,
  "pluginId": "compressor",
  "name": "My Tweaked Compressor",
  "panel": { /* … */ },
  "root":  { /* … */ }
}
```

The `$xleth` discriminator lets the import dialog reject unrelated JSON without reading the rest of the document.

### 7.4 What is **not** in these files

- No JSX. No CSS strings. No JavaScript.
- No engine state — parameter values, meter values, viz buffers all live with the engine and the project file, not the layout.
- No theme tokens. The layout consumes whichever theme is active at render time.
- No `pluginId` cross-references. A `compressor.json` describes the Compressor's UI only.

### 7.5 Project file separation

Project files (`.xleth`) continue to store *parameter state* per effect node. They do **not** embed layouts by default. Sharing a project does not ship the author's layout customisations. This is deliberate:

- Layouts are user-environment preferences (like keybindings).
- Embedding them turns every project save into a layout-write race.
- Open-source contributors should be able to ship a layout file as a separate, reviewable artifact.

(Optional future feature in §11 covers project-pinned layouts for studios that want them.)

---

## 8. Validation rules

The validator is a pure function: `validate(layout) → { ok: true, doc } | { ok: false, errors: [...] }`. It runs on import, on save, and on mount.

Hard rejects (whole layout fails, fall back to shipped default):

- `schemaVersion` missing, non-integer, or not in the supported set.
- `pluginId` missing or not in the known stock-plugin set.
- `root` missing or not of type `panel`.
- Any node missing `id` or `type`.
- Duplicate `id` anywhere in the tree.
- Cyclic `children` (defence-in-depth — JSON.parse can't produce cycles, but a designer bug could).
- Document size > a sane cap (e.g. 256 KB) — prevents pathological payloads.

Soft rejects (node falls back to placeholder; rest of layout still renders):

- `type` not in the registry.
- Required `props` missing for the type.
- `props.param` references a parameter the engine doesn't expose for this plugin.
- `props.source.slot` references an unknown semantic meter key.
- `props.source` for a `visualizer` references an unknown source key for this plugin.
- `style` contains keys not in the allow-list (drop the key, keep the node).
- `format` not in the format registry (drop to `raw`).

Every soft reject logs a structured warning the designer can surface inline (`{ nodeId, code, message }`).

---

## 9. Safe fallback behaviour

The runtime must *always* produce a working panel — refusing to open is not acceptable for a stock plugin. The cascade:

1. **User override loads & validates** → use it.
2. **User override fails to validate** → log a structured error to the dev console; pop a toast `"Custom layout for Compressor was invalid; using default."`; use the shipped default.
3. **Shipped default fails to validate** → developer bug. Log loudly. Use a hard-coded built-in placeholder layout.
4. **Hard-coded placeholder layout** lives in `ui/src/plugin-ui/runtime/placeholderLayout.js`. It renders:
   - the panel chrome,
   - one `group` containing one `knob` per parameter the engine reports for this plugin,
   - one `meter` for slot 2 (gain reduction or equivalent first slot beyond peak L/R),
   - a small footer noting `"Default layout failed to load; showing automatic fallback."`

This means a Compressor user who corrupts their `compressor.json` and *also* somehow corrupts the shipped layout still gets a usable panel.

For viz sources: if the engine returns a schema-version mismatch when the `<visualizer>` node subscribes, that *one node* renders a `"Visualization unavailable"` placeholder — the rest of the layout (knobs, meters, toggles) keeps working. Visualization is additive; the panel must be operable without it.

---

## 10. Migration plan for Dynamics stock plugins

### 10.1 Engine-side prerequisites

The runtime needs richer parameter descriptors than today's `getEffectParameters`. Today it returns `[ { id, value } ]`. The runtime needs `[ { id, value, min, max, defaultValue, kind } ]` where `kind ∈ { "continuous", "discrete" }`. This is a small additive change to `MixEngine::getEffectParameters` and `XlethEffectBase::getParametersAsJSON`. *Out of scope for this design doc; tracked separately.*

The runtime also reads viz frames per [dynamics-visualization-diagnostic §5](dynamics-visualization-diagnostic.md). Compressor instrumentation must land before any compressor `<visualizer>` widgets are usable. Until it does, the migrated `CompressorPanel` simply omits the visualizer region (or shows the "Visualization unavailable" placeholder), which is the same situation as today.

### 10.2 Per-plugin migration steps

Same recipe for all four:

1. Author the default layout JSON (mirror today's hand-written panel exactly).
2. Add to `SHIPPED_LAYOUTS`.
3. Replace the hand-written `<XxxPanel />` body with `<StockPluginRuntimeRenderer pluginId="xxx" target={target} />`. Keep the existing Zustand store (`target = { trackId, nodeId, storeKey }`) and the panel chrome (titlebar, drag, close) — those stay outside the renderer because they are panel-host concerns, not layout concerns.
4. Delete the `KNOBS` arrays and the `rAF` poll loop from the panel — the runtime owns both.
5. Verify visual parity in a side-by-side build (compare against the previous commit's panel under all themes).

### 10.3 Order

1. **Compressor** (first; see §11).
2. **Limiter** (next; same shape, adds LUFS readouts and the `style` toggle group).
3. **Transient Processor** (third; introduces the disabled-knob-in-MIDI-mode pattern — handled via a per-panel `conditional` field on knob nodes, which we add in a later schema bump if needed; for v1 the migrated panel just disables both knobs visually rather than gating them).
4. **Overdone** (last; biggest layout, three rows of knobs and three GR meters).

Each migration is a separate PR. Each PR keeps the old hand-written panel file in place for one release as a fallback path, then deletes it once the runtime path has burned in.

---

## 11. First implementation target — Compressor only

The first implementation lands the **runtime renderer + schema + validator + storage + Compressor migration**, and nothing else. Concretely:

### 11.1 Files added

- `ui/src/plugin-ui/schema/types.ts` — TypeScript shapes for layout documents.
- `ui/src/plugin-ui/schema/validate.js` — validator (pure function, no AJV).
- `ui/src/plugin-ui/runtime/registry.js` — component-type registry.
- `ui/src/plugin-ui/runtime/formats.js` — format registry.
- `ui/src/plugin-ui/runtime/actions.js` — action registry.
- `ui/src/plugin-ui/runtime/StockPluginRuntimeRenderer.jsx` — top-level renderer.
- `ui/src/plugin-ui/runtime/components/{Panel,Group,Row,Column,TabGroup,Knob,Toggle,Button,Meter,Visualizer,Label,Spacer}.jsx` — the twelve allowed component types.
- `ui/src/plugin-ui/runtime/useEffectMeterPolling.js` — single rAF poll, drains all `meter` bindings on the panel.
- `ui/src/plugin-ui/runtime/placeholderLayout.js` — hard-coded fallback (§9.3).
- `ui/src/plugin-ui/layouts/compressor.json` — shipped default for Compressor.
- `ui/src/plugin-ui/layouts/index.js` — registry.

### 11.2 Files added on the IPC side

- `ui/main.js`: `xleth:pluginUi:*` handlers (read/write `userData/plugin-ui/<pluginId>.json` with the same slug-safety + ensure-dir pattern as themes).
- `ui/preload.js`: `window.xleth.pluginUi.*` surface (§7.2).

### 11.3 Files modified

- `ui/src/components/mixer/CompressorPanel.jsx`: panel chrome stays, body becomes one `<StockPluginRuntimeRenderer pluginId="compressor" target={target} />`. Hydration + rAF poll removed.

### 11.4 Files **not** modified in the first cut

- `LimiterPanel.jsx`, `TransientProcPanel.jsx`, `OTTPanel.jsx` — untouched; migrated in subsequent PRs (§10.3).
- All existing stores, the `EffectModule` registry, the IPC bridge, the C++ engine.
- The dynamics-visualization plumbing — the first cut ships a Compressor layout that includes one `<visualizer>` node; until the engine viz path lands, that node renders the "Visualization unavailable" placeholder and the rest of the layout works. This proves the safe-fallback contract.

### 11.5 Acceptance criteria for the first cut

- Opening the Compressor on any track produces a panel visually indistinguishable from today's hand-written one (sans the new viz region, which can be empty).
- Editing `userData/plugin-ui/compressor.json` by hand and reopening the panel reflects the change.
- Corrupting `userData/plugin-ui/compressor.json` (delete a brace) and reopening the panel falls back to the shipped default *and* shows a one-line dev console warning.
- Sending a layout with `type: "image"` (not in the allow-list) renders the rest of the layout with a placeholder where the image was.
- Knob drags still call the same `setEffectParameter` calls (verified by listening on the bridge).
- Meter polling rate matches today's ~30 Hz (verified by counting `getEffectMeter` calls per second in dev).

---

## 12. Out of scope

Explicitly **not** part of this design or its first implementation:

- The visual editor itself (Plugin UI Designer mode). Schema and storage are designed to make it possible later; the editor is its own subsequent design pass.
- Layout templating, inheritance, or composition (one document per plugin, period; no `extends`, no `include`).
- Per-track or per-project layout overrides.
- Sharing layouts via a registry/marketplace.
- Layout animations / transitions.
- Drag-resizing of nodes inside the runtime (sizes are fixed by the layout).
- Keyboard-shortcut binding inside layouts.
- MIDI-learn binding inside layouts (handled elsewhere).
- VST3 plugin editors. They continue to open as native windows; this system is for *stock* plugins only.
- Engine-side parameter-descriptor extensions (§10.1) — required prerequisite, but tracked separately.
- The dynamics visualization engine instrumentation itself — covered by [dynamics-visualization-diagnostic.md](dynamics-visualization-diagnostic.md).
- Touchscreen / multitouch ergonomics on the rendered panels.
- Layout-level theming (e.g. "this layout uses the dark variant"). Themes stay global.
- Generic widget plugins from third parties. Only the closed allow-list (§4) is supported.

---

## 13. Summary

The runtime renderer is small, the schema is closed, the storage mirrors a pattern that already works for themes, the visualizer wiring lines up with the dynamics-visualization plan, and the first cut is bounded to a single plugin. Every later expansion — more stock plugins, the visual editor, project-pinned layouts — slots into the same pieces without any of them needing to know about each other.

The single load-bearing rule for everything that follows: **the JSON document is the only contract**. The editor, the runtime, the engine, the storage layer, and the validator all see the same shape. Nothing generates JSX. Nothing generates CSS. Nothing executes user-supplied code.

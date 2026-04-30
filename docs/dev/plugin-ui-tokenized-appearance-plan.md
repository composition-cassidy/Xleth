# Plugin UI Tokenized Appearance Plan

**Status:** Design only. No code in this pass.  
**Scope:** Stock Plugin UI Designer appearance controls for **Compressor only**. Limiter, Transient Processor, Overdone, C++, bridge code, save/import/export, JSX generation, CSS generation, scripts, HTML, iframes, images, webviews, and remote content are out of scope.

This plan extends the existing stock plugin UI layout system with a closed, tokenized appearance model. It is intentionally narrower than a theme editor: users can choose presets and symbolic token slots, but they cannot author colors, CSS, JSX, or code.

The load-bearing rule:

> `.xlethui.json` remains a clean declarative layout file. Appearance is data, not code, not CSS, and not a raw color transport.

---

## 1. Problem Statement

The Compressor Designer can now edit structure, layout hints, bindings, basic props, validation state, and undo/redo. Mechanically it works, but visually the stock controls are still tied to the plain primitive rendering. In particular, Compressor knobs all look like the default sampler knob, and users have no safe way to choose a more polished studio/hardware/minimal look.

The desired feature is a tokenized appearance system for stock plugin UI nodes:

- Users choose from closed preset lists.
- Users choose symbolic theme token slots from dropdowns.
- Layout JSON stores only symbolic ids such as `accent.primary` or `surface.control`.
- Runtime maps those symbolic ids to internal CSS variables or canvas colors.
- Validator rejects raw color/CSS escape hatches.
- Designer never exposes a color picker, hex input, RGB/HSL input, CSS class input, style string, arbitrary CSS variable input, generated JSX, or generated CSS.

This is especially important because layout files can be hand-edited or shared. A Compressor layout must be reviewable as data and must not become a disguised styling/code surface.

---

## 2. Appearance Data Model

### 2.1 Location

Appearance lives on each node under:

```json
{
  "type": "knob",
  "props": {
    "param": "threshold",
    "label": "THRESH",
    "size": 52,
    "format": "dB1",
    "appearance": {
      "preset": "studio-ring",
      "cap": "soft-disk",
      "ring": "metered-arc",
      "pointer": "needle",
      "ticks": "major",
      "tickDensity": "normal",
      "valueReadout": "below",
      "labelPlacement": "bottom",
      "depth": "raised",
      "surfaceToken": "surface.controlRaised",
      "accentToken": "accent.primary",
      "textToken": "text.primary"
    }
  }
}
```

`node.props.appearance` is preferred over a top-level node field because appearance is type-specific presentation metadata. It belongs with the node's declared behavior, but remains separate from `style`, which is reserved for layout geometry hints such as `gapPx`, `widthPx`, and `align`.

### 2.2 Allowed Shape

`appearance` must be a plain object. The validator must not accept arrays, strings, numbers, `null`, or nested arbitrary objects for appearance.

Every node type has its own allow-list of appearance keys. Unknown keys are repairable soft errors and should be stripped from the sanitized document before rendering. Raw CSS/color values are not repairable and must block save.

For the first implementation, the core vocabulary is:

| Key | Purpose | Stored value type |
| --- | --- | --- |
| `preset` | Component visual preset id | closed enum |
| `sizePreset` | Optional visual scale independent of current numeric `size` | closed enum |
| `cap` | Knob cap style | closed enum |
| `ring` | Knob ring/track style | closed enum |
| `pointer` | Knob indicator style | closed enum |
| `ticks` | Knob tick rendering style | closed enum |
| `tickDensity` | Tick count density | closed enum |
| `valueReadout` | Value display placement/visibility | closed enum |
| `labelPlacement` | Label placement/visibility | closed enum |
| `depth` | Elevation/depth treatment | closed enum |
| `surfaceToken` | Symbolic surface token id | token slot id |
| `accentToken` | Symbolic accent token id | token slot id |
| `textToken` | Symbolic text token id | token slot id |
| `meterFillToken` | Symbolic meter fill token id | token slot id |
| `visualizerTheme` | Visualizer palette/frame theme id | closed enum |
| `grid` | Visualizer grid visibility | closed enum |

### 2.3 Defaults

Missing `props.appearance` means "use the component default appearance." This keeps all existing Compressor layouts valid.

Runtime defaults are component-specific:

- Knob: `preset: "xleth-default"`, token defaults from the preset.
- Toggle: `preset: "xleth-button"`.
- Meter: `preset: "smooth-bar"`.
- Visualizer: use current `props.preset` painter plus `appearance.preset: "panel-flat"` if omitted.
- Label/spacer/container: no appearance by default.

The validator should not write default appearance into every node unless the user changes it. Clean JSON is preferable.

### 2.4 Existing `props.color`

Current `KnobNode.jsx` passes `props.color` to `ui/src/components/sampler/Knob.jsx`. That is incompatible with this appearance system for plugin UI layouts because `color` can carry raw CSS colors.

Visual-A must explicitly close this path:

- Remove `color` from the plugin UI layout schema/types for plugin UI knobs, or mark it legacy-disallowed.
- Validator must emit a hard save-blocking error if a plugin UI node uses `props.color`.
- Runtime should ignore `props.color` from layout JSON even before the shared knob is refactored.
- Shared sampler `Knob.jsx` may keep `color` for non-plugin-UI callers until a separate cleanup. The plugin UI renderer must not forward user layout colors into it.

---

## 3. Component-Specific Appearance Controls

### 3.1 Knob

Knobs are the first-class target for Visual-A through Visual-C. They get the richest controls because Compressor is knob-heavy.

Allowed knob appearance keys:

| Key | Options |
| --- | --- |
| `preset` | `xleth-default`, `studio-ring`, `flat-minimal`, `encoder`, `hardware-cap`, `tiny-strip` |
| `sizePreset` | `inherit`, `compact`, `standard`, `large` |
| `cap` | `default`, `flat-disk`, `soft-disk`, `hardware-cap`, `encoder-cap` |
| `ring` | `default`, `none`, `metered-arc`, `full-track`, `split-track`, `thin-line` |
| `pointer` | `default`, `line`, `needle`, `dot`, `notch`, `none` |
| `ticks` | `none`, `major`, `minor`, `numbered` |
| `tickDensity` | `sparse`, `normal`, `dense` |
| `valueReadout` | `below`, `center`, `tooltip`, `hidden` |
| `labelPlacement` | `bottom`, `top`, `left`, `hidden` |
| `depth` | `flat`, `raised`, `sunken` |
| `surfaceToken` | token id from `surface` slots |
| `accentToken` | token id from `accent` slots |
| `textToken` | token id from `text` slots |

Preset intent:

- `xleth-default`: current visual behavior, but through token resolution.
- `studio-ring`: modern plugin knob with a clear value arc and restrained ticks.
- `flat-minimal`: no cap depth, thin line ring, quiet labels.
- `encoder`: compact encoder look with notch/dot pointer and optional dense ticks.
- `hardware-cap`: tactile cap, subtle raised depth, visible pointer.
- `tiny-strip`: space-saving strip knob for dense rows; likely uses `valueReadout: "tooltip"` or `hidden`.

Presets should define defaults for all knob appearance keys. User-selected sub-controls override preset defaults only within the same closed option sets.

### 3.2 Toggle

Toggle appearance should stay modest in the first implementation.

Allowed toggle appearance keys:

| Key | Options |
| --- | --- |
| `preset` | `xleth-button`, `pill`, `square`, `segmented` |
| `depth` | `flat`, `raised` |
| `surfaceToken` | token id from `surface` slots |
| `accentToken` | token id from `accent` slots |
| `textToken` | token id from `text` slots |

For Compressor, the `Peak`/`RMS` detect controls should probably use `segmented` once Visual-D lands. Do not overbuild toggle-specific rendering before knob appearance is proven.

### 3.3 Meter

Allowed meter appearance keys:

| Key | Options |
| --- | --- |
| `preset` | `smooth-bar`, `segmented-bar`, `led-ladder` |
| `depth` | `flat`, `inset` |
| `surfaceToken` | token id from `surface` slots |
| `meterFillToken` | token id from `meter` slots |
| `textToken` | token id from `text` slots |

Meter `orientation`, `range`, `unit`, and `format` remain existing props. Appearance does not change measurement semantics.

### 3.4 Visualizer

Allowed visualizer appearance keys:

| Key | Options |
| --- | --- |
| `preset` | `panel-flat`, `panel-framed`, `scope-inset` |
| `visualizerTheme` | `default`, `dark-grid`, `minimal`, `metered` |
| `grid` | `auto`, `visible`, `hidden` |
| `surfaceToken` | token id from `surface` slots |
| `accentToken` | token id from `accent` slots |
| `textToken` | token id from `text` slots |

This is separate from the existing visualizer `props.preset`, which selects the painter/data visualization, such as `compressorCombined`. `props.appearance.preset` selects frame treatment only.

### 3.5 Label, Spacer, Container

Do not overbuild these in the first implementation.

- Label: optional `textToken` only, later if needed.
- Spacer: no appearance.
- Panel/group/row/column: no appearance in Visual-A through Visual-D. Layout containers already have limited `style`; appearance controls for containers can wait until the control surface is solid.

---

## 4. Token Slot Allow-List Model

### 4.1 Symbolic Tokens Stored in JSON

The layout stores symbolic token ids, not CSS variable strings:

```json
{
  "surfaceToken": "surface.controlRaised",
  "accentToken": "accent.primary",
  "textToken": "text.muted"
}
```

The user never types `var(--theme-accent)`, `--theme-accent`, `#ff006a`, `rgb(...)`, or named colors. Dropdowns emit token ids only.

### 4.2 Proposed File

Create:

```text
ui/src/plugin-ui/appearance/tokenSlots.js
```

Conceptual shape:

```js
export const TOKEN_SLOTS = {
  surface: {
    'surface.panel':         { label: 'Panel Surface',   cssVar: '--theme-bg-primary' },
    'surface.control':       { label: 'Control Surface', cssVar: '--theme-bg-surface' },
    'surface.controlRaised': { label: 'Raised Control',  cssVar: '--theme-bg-elevated' },
    'surface.inset':         { label: 'Inset Surface',   cssVar: '--theme-bg-inset' },
  },
  text: {
    'text.primary': { label: 'Primary Text', cssVar: '--theme-text-primary' },
    'text.muted':   { label: 'Muted Text',   cssVar: '--theme-text-muted' },
    'text.subtle':  { label: 'Subtle Text',  cssVar: '--theme-text-subtle' },
  },
  accent: {
    'accent.primary':   { label: 'Accent Primary',   cssVar: '--accent-primary' },
    'accent.secondary': { label: 'Accent Secondary', cssVar: '--theme-accent' },
    'accent.focus':     { label: 'Focus Accent',     cssVar: '--theme-border-focus' },
  },
  meter: {
    'meter.good':   { label: 'Meter Good',   cssVar: '--theme-success' },
    'meter.warn':   { label: 'Meter Warning', cssVar: '--theme-warning' },
    'meter.danger': { label: 'Meter Danger',  cssVar: '--theme-error' },
    'meter.gr':     { label: 'Gain Reduction', cssVar: '--theme-border-focus' },
  },
  depth: {
    'depth.none':   { label: 'No Shadow', cssVar: null },
    'depth.panel':  { label: 'Panel Shadow', cssVar: '--theme-fx-plugin-shadow-top' },
    'depth.raised': { label: 'Raised Shadow', cssVar: '--theme-fx-plugin-shadow-top' },
  },
}
```

Final CSS variable mapping should be verified against `ui/src/styles/app.css` and theme definitions during Visual-A. If a desired variable does not exist, map to an existing theme token first. Adding new global theme CSS variables should be a separate, careful theme-system task.

### 4.3 Slot Compatibility

Each appearance key accepts only compatible token groups:

| Appearance key | Accepted token groups |
| --- | --- |
| `surfaceToken` | `surface.*` |
| `accentToken` | `accent.*` |
| `textToken` | `text.*` |
| `meterFillToken` | `meter.*`, optionally `accent.*` |
| `depth` | enum, not a user token id in JSON unless the registry chooses `depth.*` internally |

Unknown token ids in imported JSON are repairable soft errors:

- Validator records `UNKNOWN_APPEARANCE_TOKEN`.
- Sanitized doc replaces it with the component/preset fallback token.
- Designer shows the invalid field and lets the user repair through the dropdown.
- Runtime renders with fallback token.

Raw colors/CSS strings are not repairable:

- `#ff006a`
- `rgb(255,0,0)`
- `rgba(...)`
- `hsl(...)`
- `hsla(...)`
- `red`, `transparent`, `currentColor`, etc.
- `var(--theme-accent)`
- `--theme-accent`
- `color:red`
- `style: "color:red"`

These must block save and should not be silently converted.

---

## 5. Appearance Preset Registry Design

### 5.1 Proposed Files

Create:

```text
ui/src/plugin-ui/appearance/appearanceRegistry.js
ui/src/plugin-ui/appearance/tokenSlots.js
ui/src/plugin-ui/appearance/knobPresets.js
```

Optionally split later:

```text
ui/src/plugin-ui/appearance/togglePresets.js
ui/src/plugin-ui/appearance/meterPresets.js
ui/src/plugin-ui/appearance/visualizerPresets.js
```

### 5.2 Registry Responsibilities

The registry is the single source of truth for:

- Allowed appearance keys by node type.
- Allowed values for each key.
- Preset metadata and labels.
- Default appearance per node type.
- Which token groups each token slot key accepts.
- Runtime-safe class suffixes or rendering flags.

It must be importable by:

- `ui/src/plugin-ui/schema/validate.js`
- runtime components such as `KnobNode.jsx`
- Designer inspectors such as `KnobInspector.jsx`
- tests

There is no runtime eval, no generated CSS, and no user-provided class name. The registry may expose known class names or class suffixes such as `pluginui-knob--studio-ring`, but layout JSON stores only `preset: "studio-ring"`.

### 5.3 Conceptual Shape

```js
export const APPEARANCE_NODE_TYPES = {
  knob: {
    defaultPreset: 'xleth-default',
    allowedKeys: {
      preset: KNOB_PRESET_IDS,
      sizePreset: ['inherit', 'compact', 'standard', 'large'],
      cap: ['default', 'flat-disk', 'soft-disk', 'hardware-cap', 'encoder-cap'],
      ring: ['default', 'none', 'metered-arc', 'full-track', 'split-track', 'thin-line'],
      pointer: ['default', 'line', 'needle', 'dot', 'notch', 'none'],
      ticks: ['none', 'major', 'minor', 'numbered'],
      tickDensity: ['sparse', 'normal', 'dense'],
      valueReadout: ['below', 'center', 'tooltip', 'hidden'],
      labelPlacement: ['bottom', 'top', 'left', 'hidden'],
      depth: ['flat', 'raised', 'sunken'],
      surfaceToken: { tokenGroup: 'surface' },
      accentToken: { tokenGroup: 'accent' },
      textToken: { tokenGroup: 'text' },
    },
    fallbackAppearance: {
      preset: 'xleth-default',
      surfaceToken: 'surface.control',
      accentToken: 'accent.primary',
      textToken: 'text.primary',
    },
  },
}
```

### 5.4 Preset Data

`knobPresets.js` should store only declarative, closed values:

```js
export const KNOB_PRESETS = {
  'studio-ring': {
    label: 'Studio Ring',
    description: 'Clear arc, restrained cap, visible pointer.',
    defaults: {
      cap: 'soft-disk',
      ring: 'metered-arc',
      pointer: 'line',
      ticks: 'major',
      tickDensity: 'normal',
      valueReadout: 'below',
      labelPlacement: 'bottom',
      depth: 'raised',
      surfaceToken: 'surface.controlRaised',
      accentToken: 'accent.primary',
      textToken: 'text.primary'
    },
    className: 'pluginui-knob--studio-ring'
  }
}
```

No preset may contain:

- Raw colors.
- CSS variable strings.
- CSS snippets.
- Arbitrary class names from layout JSON.
- Functions.
- JSX.

The `className` is developer-authored in source code and validated by tests. The user layout only references the preset id.

---

## 6. Validator Changes

### 6.1 New Validation Pass

Add `validateAppearance(node, errors)` called from `validateNodeProps` after type-specific required props are checked.

Validation order:

1. If `props.appearance` is missing, pass.
2. If present but not a plain object, mark node invalid and emit `BAD_APPEARANCE`.
3. Look up appearance rules for `node.type`.
4. If no rules exist for that node type, strip `appearance` with soft error `APPEARANCE_NOT_SUPPORTED`.
5. For each key:
   - Unknown key: strip and emit soft `UNKNOWN_APPEARANCE_KEY`.
   - Enum key with unknown value: emit soft `UNKNOWN_APPEARANCE_VALUE`, replace with fallback/default when possible.
   - Token key with unknown token id: emit soft `UNKNOWN_APPEARANCE_TOKEN`, replace with fallback/default when possible.
   - Raw CSS/color/string escape: emit hard save-blocking `RAW_APPEARANCE_VALUE`.

### 6.2 Hard vs Soft

Hard save-blocking:

- Raw hex/RGB/HSL/named CSS color in any appearance field.
- CSS variable reference such as `var(--theme-accent)` or `--theme-accent`.
- CSS declaration/string such as `color:red`.
- `props.color` on plugin UI knobs.
- Any `className`, `class`, `style`, `css`, `cssText`, `sx`, `html`, `script`, `url`, `href`, `src`, or similar appearance escape key.
- Appearance value object that looks like arbitrary CSS, for example `{ color: "red" }`.

Soft repairable:

- Unknown preset id.
- Unknown enum value.
- Unknown token id.
- Unknown appearance key that is not a known escape hatch.
- Appearance provided on a node type that does not support it.

The existing `ValidationPanel` should treat soft appearance errors similarly to existing soft validation problems. Save gating should block on hard appearance errors.

### 6.3 Raw Color Detection

Implement helper checks in validator or appearance validation utility:

```js
const RAW_COLOR_PATTERNS = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(/i,
  /^hsla?\(/i,
  /^var\(/i,
  /^--[a-z0-9-_]+$/i,
]
```

Also reject a conservative set of named CSS color values when found in appearance/token slots:

```text
black, white, red, green, blue, yellow, cyan, magenta, orange, purple,
pink, gray, grey, transparent, currentColor
```

This list is intentionally conservative. The point is not to parse all CSS; it is to prevent obvious bypasses in fields that should only contain ids from closed lists.

### 6.4 Type Updates

Update `ui/src/plugin-ui/schema/types.ts` to document:

- `Appearance` type.
- Component-specific appearance type unions.
- `KnobProps.appearance?: KnobAppearance`.
- Remove or mark `KnobProps.color` as not valid for plugin UI layouts.

The runtime validator remains authoritative; TypeScript is documentation and compile-time aid only.

---

## 7. Runtime Rendering Changes

### 7.1 Shared Runtime Rules

Runtime components may read `props.appearance`, normalize it through the appearance registry, and apply only known props/classes.

Runtime must not:

- Inject raw CSS from layout JSON.
- Set arbitrary inline styles from appearance values.
- Use user-supplied class names.
- Call `tokenValue` with user-supplied CSS variable names.
- Forward `props.color` or token ids directly as colors.

Runtime may:

- Resolve a known token id to a known CSS variable from `tokenSlots.js`.
- Convert that known CSS variable to a canvas color internally.
- Add known class names from the registry.
- Pass known enum values to a component/wrapper.

### 7.2 Knob Rendering

`KnobNode.jsx` should read:

```js
const appearance = resolveAppearance('knob', props.appearance)
```

Then either:

1. Pass explicit, closed props to the shared `ui/src/components/sampler/Knob.jsx`, or
2. Wrap the shared component in a new plugin UI specific component.

Preferred first implementation:

```text
ui/src/plugin-ui/runtime/components/PluginUIKitKnob.jsx
```

Use the wrapper if changing the shared sampler knob is risky. The wrapper can preserve existing sampler knob behavior while translating plugin UI appearance into safe render props.

Possible safe props:

```js
<PluginUIKitKnob
  value={value}
  min={meta.min}
  max={meta.max}
  defaultValue={meta.defaultValue}
  label={props.label ?? meta.label}
  formatValue={formatFn}
  onLiveChange={handleLiveChange}
  onCommit={handleCommit}
  size={props.size ?? 52}
  dragRange={props.dragRange ?? 150}
  appearancePreset={appearance.preset}
  capStyle={appearance.cap}
  ringStyle={appearance.ring}
  pointerStyle={appearance.pointer}
  tickStyle={appearance.ticks}
  tickDensity={appearance.tickDensity}
  labelPlacement={appearance.labelPlacement}
  valueReadout={appearance.valueReadout}
  depth={appearance.depth}
  tokens={resolveAppearanceTokens(appearance)}
/>
```

If the shared `Knob.jsx` is modified instead, all new props must be optional so sampler/existing uses continue working. Do not break non-plugin-UI callers.

### 7.3 Token Resolution

Token ids should be resolved by helper functions:

```js
resolveTokenCssVar('accent.primary') -> '--accent-primary'
resolveTokenValue('accent.primary') -> tokenValue('--accent-primary')
```

Only known token ids resolve. Unknown ids fall back to the preset/default token.

### 7.4 Toggle, Meter, Visualizer

Visual-D expands appearance beyond knobs:

- `ToggleNode.jsx`: apply known preset/depth classes and token-resolved CSS variables through controlled component props or CSS custom properties set by source code, not user strings.
- `MeterNode.jsx`: choose smooth/segmented/LED rendering from enum and resolve `meterFillToken`.
- `VisualizerNode.jsx`: frame classes and grid enum only. Existing data painter preset remains `props.preset`.

### 7.5 CSS Strategy

No generated CSS. Add source-controlled CSS rules for known classes:

```css
.pluginui-knob--studio-ring { ... }
.pluginui-knob--flat-minimal { ... }
```

If CSS custom properties are used internally, they must be assigned from resolved registry values only, never from layout strings:

```js
style={{
  '--pluginui-accent': `var(${resolvedAccentCssVar})`,
}}
```

This is acceptable because `resolvedAccentCssVar` comes from `tokenSlots.js`, not from the layout.

---

## 8. Designer Inspector Changes

### 8.1 Shared Appearance UI

Add a reusable appearance inspector helper:

```text
ui/src/plugin-ui/designer/inspectors/AppearanceFields.jsx
```

Responsibilities:

- Render closed enum controls.
- Render token dropdowns with friendly labels.
- Patch `props.appearance`.
- Remove a key when the selected value matches the preset/default only if that keeps UX understandable.
- Never render text inputs for token ids.
- Never render color picker controls.

Token dropdown labels should be friendly:

| Token id | UI label |
| --- | --- |
| `accent.primary` | Accent Primary |
| `accent.secondary` | Accent Secondary |
| `surface.control` | Control Surface |
| `surface.controlRaised` | Raised Control |
| `text.muted` | Muted Text |
| `meter.good` | Meter Good |

Do not expose raw token ids unless an explicit advanced/debug mode is designed later.

### 8.2 KnobInspector

Add an `Appearance` group under current knob fields:

- Visual preset card/radio list for:
  - Xleth Default
  - Studio Ring
  - Flat Minimal
  - Encoder
  - Hardware Cap
  - Tiny Strip
- Cap dropdown.
- Ring dropdown.
- Pointer dropdown.
- Ticks dropdown.
- Tick density dropdown.
- Label placement dropdown.
- Value readout dropdown.
- Depth dropdown.
- Surface token dropdown.
- Accent token dropdown.
- Text token dropdown.

Preset selection should be visually scannable, not just a plain select, if simple enough. A compact card/radio list can show preset name, tiny static preview swatch, and one-line description. The preview must be built from known classes/tokens only. No generated SVG from JSON and no images.

### 8.3 ToggleInspector

Add a compact Appearance group in Visual-D:

- Button preset dropdown or segmented selector.
- Depth dropdown.
- Surface/accent/text token dropdowns.

### 8.4 MeterInspector

Add in Visual-D:

- Bar preset dropdown.
- Depth dropdown.
- Surface token dropdown.
- Meter fill token dropdown.
- Text token dropdown.

### 8.5 VisualizerInspector

Add in Visual-D:

- Panel frame preset dropdown.
- Visualizer theme dropdown.
- Grid visibility dropdown.
- Surface/accent/text token dropdowns.

### 8.6 Validation Repair UX

If a layout contains unknown token ids or unknown presets, the Designer should:

- Show the current field as invalid.
- Display a disabled `(removed) <value>` option only if it helps explain the imported value.
- Let the user choose a valid replacement from the dropdown.
- Never preserve raw invalid token strings once the user changes the field.

This mirrors the existing `BindingPicker` pattern for removed params/slots.

---

## 9. JSON Examples

### 9.1 Plain Default Knob

Minimal existing layouts remain valid:

```json
{
  "id": "k-threshold",
  "type": "knob",
  "props": {
    "param": "threshold",
    "label": "THRESH",
    "size": 52,
    "format": "dB1"
  }
}
```

Explicit default appearance is also valid, but should not be required:

```json
{
  "id": "k-threshold",
  "type": "knob",
  "props": {
    "param": "threshold",
    "label": "THRESH",
    "size": 52,
    "format": "dB1",
    "appearance": {
      "preset": "xleth-default",
      "surfaceToken": "surface.control",
      "accentToken": "accent.primary",
      "textToken": "text.primary"
    }
  }
}
```

### 9.2 Studio Ring Knob

```json
{
  "id": "k-ratio",
  "type": "knob",
  "props": {
    "param": "ratio",
    "label": "RATIO",
    "size": 56,
    "format": "ratio",
    "appearance": {
      "preset": "studio-ring",
      "ring": "metered-arc",
      "pointer": "line",
      "ticks": "major",
      "tickDensity": "normal",
      "valueReadout": "below",
      "labelPlacement": "bottom",
      "depth": "raised",
      "surfaceToken": "surface.controlRaised",
      "accentToken": "accent.primary",
      "textToken": "text.primary"
    }
  }
}
```

### 9.3 Hardware Cap Knob

```json
{
  "id": "k-attack",
  "type": "knob",
  "props": {
    "param": "attack",
    "label": "ATTACK",
    "size": 58,
    "format": "ms1",
    "appearance": {
      "preset": "hardware-cap",
      "cap": "hardware-cap",
      "ring": "full-track",
      "pointer": "needle",
      "ticks": "major",
      "tickDensity": "sparse",
      "valueReadout": "below",
      "labelPlacement": "bottom",
      "depth": "raised",
      "surfaceToken": "surface.controlRaised",
      "accentToken": "accent.focus",
      "textToken": "text.primary"
    }
  }
}
```

### 9.4 Minimal Flat Knob

```json
{
  "id": "k-mix",
  "type": "knob",
  "props": {
    "param": "mix",
    "label": "MIX",
    "size": 48,
    "format": "pct0",
    "appearance": {
      "preset": "flat-minimal",
      "cap": "flat-disk",
      "ring": "thin-line",
      "pointer": "dot",
      "ticks": "none",
      "valueReadout": "tooltip",
      "labelPlacement": "bottom",
      "depth": "flat",
      "surfaceToken": "surface.control",
      "accentToken": "accent.secondary",
      "textToken": "text.muted"
    }
  }
}
```

### 9.5 Basic Toggle Appearance

```json
{
  "id": "btn-peak",
  "type": "toggle",
  "props": {
    "param": "detect_mode",
    "mode": "discreteValue",
    "valueWhenOn": 0,
    "label": "Peak",
    "appearance": {
      "preset": "segmented",
      "surfaceToken": "surface.control",
      "accentToken": "accent.primary",
      "textToken": "text.primary"
    }
  }
}
```

### 9.6 Basic Meter Appearance

```json
{
  "id": "gr-meter",
  "type": "meter",
  "props": {
    "source": { "kind": "effectMeter", "slot": "GAIN_REDUCTION" },
    "label": "GR",
    "unit": "dB",
    "range": { "min": 0, "max": 40, "scale": "linear" },
    "orientation": "vertical",
    "format": "dB1",
    "appearance": {
      "preset": "segmented-bar",
      "surfaceToken": "surface.inset",
      "meterFillToken": "meter.gr",
      "textToken": "text.muted"
    }
  }
}
```

---

## 10. Forbidden Examples

### 10.1 Raw Hex Color

```json
{
  "appearance": {
    "accentToken": "#ff006a"
  }
}
```

Fails because token fields accept only allow-listed token ids.

### 10.2 RGB/HSL Color

```json
{
  "appearance": {
    "accentToken": "rgb(255,0,0)"
  }
}
```

Fails because raw CSS color functions are not allowed.

### 10.3 CSS Variable Typed by User

```json
{
  "appearance": {
    "accentToken": "var(--theme-accent)"
  }
}
```

Fails because layout JSON stores symbolic token ids, not CSS variables.

### 10.4 Raw Knob Color Backdoor

```json
{
  "type": "knob",
  "props": {
    "param": "threshold",
    "color": "#ff006a"
  }
}
```

Fails because plugin UI knobs must not accept `props.color`. Use `props.appearance.accentToken`.

### 10.5 User Class Name

```json
{
  "appearance": {
    "className": "my-hot-pink-knob"
  }
}
```

Fails because users cannot provide class names. Preset ids map to source-controlled classes internally.

### 10.6 Inline Style String

```json
{
  "appearance": {
    "style": "color:red"
  }
}
```

Fails because arbitrary CSS strings are forbidden.

### 10.7 CSS Object

```json
{
  "appearance": {
    "style": { "color": "red" }
  }
}
```

Fails because appearance is not a CSS object.

### 10.8 Unknown But Repairable Token

```json
{
  "appearance": {
    "accentToken": "accent.neonFuture"
  }
}
```

Soft error. Runtime falls back to `accent.primary`; Designer lets the user repair with the dropdown.

### 10.9 Unknown But Repairable Preset

```json
{
  "appearance": {
    "preset": "my-custom-knob"
  }
}
```

Soft error. Runtime falls back to `xleth-default`; Designer lets the user choose a known preset.

---

## 11. Implementation Phases

### Phase Visual-A - Registry, Token Map, Validator

Add:

- `ui/src/plugin-ui/appearance/tokenSlots.js`
- `ui/src/plugin-ui/appearance/knobPresets.js`
- `ui/src/plugin-ui/appearance/appearanceRegistry.js`

Update:

- `ui/src/plugin-ui/schema/validate.js`
- `ui/src/plugin-ui/schema/types.ts`

Acceptance:

- Validator accepts known knob appearance presets.
- Validator accepts known token ids.
- Validator soft-flags unknown preset/token ids and provides fallback-safe sanitized doc.
- Validator blocks raw colors, CSS variables, style/class escape keys, and `props.color`.
- No runtime rendering changes yet beyond tests/importability if needed.
- Compressor layout remains valid without appearance.

### Phase Visual-B - Runtime Knob Rendering

Update:

- `ui/src/plugin-ui/runtime/components/KnobNode.jsx`
- Add `PluginUIKitKnob.jsx` or safely extend `ui/src/components/sampler/Knob.jsx`.
- Add source-controlled CSS for known knob preset classes if needed.

Acceptance:

- `KnobNode` reads `props.appearance`.
- Known presets change knob visuals.
- Unknown/invalid appearance from sanitized doc falls back without crashing.
- Existing non-plugin-UI sampler knob usages still work.
- Runtime never forwards raw layout color strings.

### Phase Visual-C - Designer Knob Appearance Section

Update:

- `ui/src/plugin-ui/designer/inspectors/KnobInspector.jsx`
- Add `AppearanceFields.jsx` or equivalent helper.
- Add compact preset card/list styling to `designer.css`.

Acceptance:

- Knob Inspector shows an Appearance section.
- Preset selection patches `props.appearance.preset`.
- Token dropdowns list friendly labels.
- Token dropdowns emit token ids only.
- No color picker, no raw token text input, no CSS input.

### Phase Visual-D - Basic Toggle/Meter/Visualizer Appearance

Update relevant inspectors/runtime nodes:

- `ToggleInspector.jsx` / `ToggleNode.jsx`
- `MeterInspector.jsx` / `MeterNode.jsx`
- `VisualizerInspector.jsx` / `VisualizerNode.jsx`

Acceptance:

- Basic closed-set appearance works for non-knob controls.
- Implementation remains intentionally shallow compared with knobs.

### Phase Visual-E - Compressor Layout Appearance Pass

Update:

- `ui/src/plugin-ui/layouts/compressor.json`

Acceptance:

- Shipped Compressor layout uses better knob appearance defaults.
- Layout remains clean and reviewable.
- No Limiter/Transient/Overdone migration.

### Phase Visual-F - Tests and Manual Electron Visual Pass

Add/extend tests and run a manual Electron pass:

- Validator tests.
- Registry tests.
- Runtime tests.
- Designer tests.
- Manual visual check under the active theme(s).

Acceptance:

- Compressor opens.
- Designer can select and edit appearance.
- Save remains blocked for raw color/CSS attempts.
- Unknown imported preset/token is repairable.

---

## 12. Test Plan

### 12.1 Validator Tests

Add tests near existing schema validation tests:

- Accepts a knob with `appearance.preset: "studio-ring"`.
- Accepts known token ids for `surfaceToken`, `accentToken`, and `textToken`.
- Soft-flags unknown token id and returns fallback-safe sanitized doc.
- Soft-flags unknown preset id and returns fallback-safe sanitized doc.
- Rejects or save-blocks `#ff006a`.
- Rejects or save-blocks `rgb(255,0,0)`.
- Rejects or save-blocks `hsl(330 100% 50%)`.
- Rejects or save-blocks named CSS colors in token fields.
- Rejects or save-blocks `var(--theme-accent)` and `--theme-accent`.
- Rejects or save-blocks `props.color` on knob.
- Strips unknown harmless appearance keys as soft errors.
- Blocks escape keys such as `style`, `className`, `css`, `html`, `script`, `src`, `href`, `url`.

### 12.2 Registry Tests

- Every knob preset id is listed in the knob allowed preset set.
- Every preset default key is allowed for that node type.
- Every preset token id exists in `TOKEN_SLOTS`.
- No preset contains raw color values.
- No preset contains CSS variable strings.
- No preset contains functions or non-serializable values.
- Every token slot has a friendly label.
- Every token slot maps to an internal known CSS variable or explicit `null` for no-op slots.

### 12.3 Runtime Tests

- `KnobNode` passes normalized appearance props without crashing.
- Missing `props.appearance` renders default knob.
- Unknown sanitized appearance falls back.
- Runtime ignores `props.color`.
- Token ids resolve through `tokenSlots.js`, not from user strings.
- Existing sampler `Knob.jsx` callers still render if it is modified.

### 12.4 Designer Tests

- Appearance section lists knob presets.
- Appearance section lists token dropdown labels.
- Selecting `Studio Ring` patches `props.appearance.preset` to `studio-ring`.
- Selecting `Accent Primary` patches `props.appearance.accentToken` to `accent.primary`.
- Token dropdown never emits `#...`, `rgb(...)`, `hsl(...)`, `var(...)`, or raw CSS variable strings.
- Removed/unknown token id appears as repairable state and can be replaced by a valid dropdown option.

### 12.5 Manual Electron Visual Pass

Run with Designer enabled:

1. Open Compressor.
2. Open Designer.
3. Select `k-threshold`.
4. Change preset from Xleth Default to Studio Ring.
5. Confirm preview updates without layout shifts.
6. Change accent token between Accent Primary and Accent Secondary.
7. Confirm no raw color input is available anywhere.
8. Import or simulate a layout with `accentToken: "#ff006a"` and confirm save is blocked.
9. Import or simulate a layout with `accentToken: "accent.unknown"` and confirm fallback render plus dropdown repair.

---

## 13. Exact Next Implementation Prompt Summary for Visual-A Only

Use this prompt for the next implementation pass:

> Implement **Phase Visual-A only** from `docs/dev/plugin-ui-tokenized-appearance-plan.md` for Compressor stock plugin UI appearance. Do not implement runtime visual rendering, Designer UI, Compressor layout appearance changes, save/import/export, or any non-Compressor migration.
>
> Create:
>
> - `ui/src/plugin-ui/appearance/tokenSlots.js`
> - `ui/src/plugin-ui/appearance/knobPresets.js`
> - `ui/src/plugin-ui/appearance/appearanceRegistry.js`
>
> Update:
>
> - `ui/src/plugin-ui/schema/validate.js`
> - `ui/src/plugin-ui/schema/types.ts`
>
> Requirements:
>
> 1. Add a closed token slot allow-list with symbolic token ids such as `surface.control`, `surface.controlRaised`, `text.primary`, `text.muted`, `accent.primary`, `accent.secondary`, `meter.good`, `meter.warn`, `meter.danger`.
> 2. Map symbolic ids to internal CSS variable names in source code only. Layout JSON must store symbolic ids, not `var(...)`, not `--theme-*`.
> 3. Add a closed knob preset registry for `xleth-default`, `studio-ring`, `flat-minimal`, `encoder`, `hardware-cap`, and `tiny-strip`.
> 4. Add appearance validation for `node.props.appearance`, starting with knobs. Keep toggle/meter/visualizer registry shapes ready but do not implement rendering or inspectors yet.
> 5. Unknown appearance keys should be soft repairable errors unless they are escape hatches.
> 6. Unknown preset/token ids should be soft repairable errors with fallback-safe sanitized output.
> 7. Raw colors and CSS must block save: hex, RGB/RGBA, HSL/HSLA, named CSS colors, `var(...)`, raw `--theme-*`, style strings, CSS objects, user class names, `style`, `className`, `class`, `css`, `cssText`, `html`, `script`, `src`, `href`, `url`.
> 8. Explicitly close the current plugin UI knob `props.color` path. Validator must flag `props.color` on plugin UI knobs as a hard save-blocking error. Runtime changes can wait until Visual-B, but the schema/validator must not allow new saved layouts to use it.
> 9. Existing `ui/src/plugin-ui/layouts/compressor.json` must continue to validate unchanged.
> 10. Add focused tests for the registry and validator:
>     - accepts known knob appearance preset,
>     - accepts known token ids,
>     - soft-flags unknown token id,
>     - soft-flags unknown preset,
>     - rejects raw hex/RGB/HSL/named colors,
>     - rejects CSS variable strings,
>     - rejects `props.color`,
>     - all knob presets reference valid token slots,
>     - no preset contains raw color values.
>
> Constraints:
>
> - No color picker.
> - No raw color editing.
> - No arbitrary CSS.
> - No generated CSS.
> - No JSX generation.
> - No scripts/html/iframe/image/webview/remote content.
> - Do not touch C++.
> - Do not touch `bridge/src/XlethAddon.cpp`.
> - Do not migrate Limiter/Transient/Overdone.
> - Do not update default Compressor layout appearance yet.
>
> When finished, report changed files and test results. If a test command cannot run in the sandbox, explain why and list the unrun tests.


# Plugin UI Designer Mode — Implementation Plan (Compressor only)

**Status:** Design only. No code in this pass.
**Scope:** Visual editor for the Compressor `.xlethui.json` layout that the existing `StockPluginRuntimeRenderer` already renders. Compressor only. Limiter, Transient Processor and Overdone are explicitly out of scope.
**Audience:** Whoever implements the first cut of `ui/src/plugin-ui/designer/`.

This document is the operational companion to [stock-plugin-ui-designer-architecture.md](stock-plugin-ui-designer-architecture.md). The architecture doc tells us *what* a layout document is and *how* the runtime resolves it. This doc tells us *what the editor does to those documents*, *which knobs it does not get to turn*, and *in what order to build it*.

The single load-bearing rule, restated from the architecture doc:

> The editor edits the same JSON document the runtime renders. It never generates JSX. It never generates CSS. It never executes user-authored code. It only mutates validated JSON layout trees.

Everything below is in service of that rule.

---

## 1. Designer activation plan

### 1.1 Build flag

Designer is gated behind a Vite build-time flag:

```
VITE_XLETH_PLUGIN_UI_DESIGNER=1
```

- Read once via `import.meta.env.VITE_XLETH_PLUGIN_UI_DESIGNER`. Truthy → Designer compiled in. Falsy / undefined → the Designer entry point and its module subtree must tree-shake out (no runtime cost in production).
- Centralise the read in `ui/src/plugin-ui/designer/featureFlag.js` (`export const DESIGNER_ENABLED = ...`). All other modules consume that constant — never `import.meta.env` directly — so a single file controls compile-out.
- Set in dev shells via the existing `npm run dev` invocation (e.g. `VITE_XLETH_PLUGIN_UI_DESIGNER=1 npm run dev`). The first cut does not need a packaged "designer build" artifact.

### 1.2 Compressor panel hook

`CompressorPanel.jsx` (the chrome owner) gets one new control, conditional on `DESIGNER_ENABLED`:

- An `Edit UI` button mounted in the panel header, next to the close button. Identical visual weight to existing chrome buttons — uses theme tokens, no special styling.
- Clicking it toggles a top-level `designerOpen` flag in the Compressor store and mounts `<PluginUIDesigner />` (lazy import).

When `DESIGNER_ENABLED` is false:

- The button is not rendered.
- The Designer module is never imported, so there is no production attack surface for the JSON-edit code path.
- All `xleth:pluginUi:saveUserOverride` calls from production code paths remain unreachable from UI controls — the IPC handler still exists in `ui/main.js` (it gates on `pluginIdSafe` already), but no production button can invoke it.

### 1.3 Why not expose Designer to normal users yet

The Designer is a developer/contributor tool until:

- The schema has a real test suite under load (it's still v1 with a smallish validator).
- `getEffectParameters` exposes parameter descriptors so the manifest can be deleted (see [stock-plugin-ui-designer-architecture.md §10.1](stock-plugin-ui-designer-architecture.md)).
- We have a story for layout sharing / reset that does not require shipping a Designer panel to non-technical users.

Hiding it behind `VITE_XLETH_PLUGIN_UI_DESIGNER` lets us ship the runtime path to all users without committing to the editor UX yet.

---

## 2. UI structure and proposed file layout

### 2.1 Entry point: docked side panel

**Recommended:** the Designer mounts as a **right-edge docked side panel inside the Compressor floating panel's containing window**, not a floating modal and not a separate Electron window.

Justification:

- The existing `CompressorPanel` is itself a floating panel with drag chrome. Stacking another floating modal on top of it produces nested z-index and drag wars.
- A side panel keeps the live preview (the actual `StockPluginRuntimeRenderer`-rendered Compressor body) visible at the same time as the editor, which is the whole point of a visual editor — see → click in tree → tweak value → see result.
- A separate Electron window adds IPC overhead, focus juggling and would have to re-implement the Compressor store's `target` resolution. We do not need any of that for a Compressor-only first cut.
- Docking on the right keeps all editor state colocated with the panel; closing the Compressor floating panel automatically tears down the Designer.

**Layout sketch** (textual; widths are guidance, not contract):

```
┌── Compressor floating panel ────────────────────────────────────────────────┐
│  ┌── header (drag, title, [Edit UI], [×]) ─────────────────────────────┐    │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │  PREVIEW                       │  DESIGNER (Edit UI active)         │    │
│  │  StockPluginRuntimeRenderer    │  ┌── Layout Tree ───────────────┐  │    │
│  │  rendered against              │  │  panel                       │  │    │
│  │  workingLayout                 │  │  └ row(body)                 │  │    │
│  │                                │  │    └ group(knob-grid)        │  │    │
│  │  (~width: 480 px)              │  │      └ knob(threshold)*      │  │    │
│  │                                │  │      └ ...                   │  │    │
│  │                                │  └──────────────────────────────┘  │    │
│  │                                │  ┌── Inspector ─────────────────┐  │    │
│  │                                │  │  id: k-threshold             │  │    │
│  │                                │  │  type: knob (readonly)       │  │    │
│  │                                │  │  param: [threshold ▼]        │  │    │
│  │                                │  │  label: "THRESH"             │  │    │
│  │                                │  │  size: 52  format: dB1 ▼    │  │    │
│  │                                │  └──────────────────────────────┘  │    │
│  │                                │  ┌── Palette ───────────────────┐  │    │
│  │                                │  │ [+knob] [+toggle] [+row] ... │  │    │
│  │                                │  └──────────────────────────────┘  │    │
│  │                                │  ┌── Validation ────────────────┐  │    │
│  │                                │  │ ⚠ k-threshold: ...           │  │    │
│  │                                │  └──────────────────────────────┘  │    │
│  │                                │  [Save] [Reset] [Import] [Export]  │    │
│  └────────────────────────────────┴────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

The Compressor floating panel itself grows wider when the Designer is open (e.g. preferred width swaps from `480` to `≈900`). Closing the Designer restores the previous width and re-saves panel position.

### 2.2 Folder layout

```
ui/src/plugin-ui/designer/
├── PluginUIDesigner.jsx          # Top-level shell. Mounted by CompressorPanel when designerOpen.
├── featureFlag.js                # DESIGNER_ENABLED constant from import.meta.env.
├── usePluginUIDesignerStore.js   # Zustand store: state model from §3.
├── designerActions.js            # Thunks that dispatch mutations + run validation + push undo.
├── layoutMutations.js            # Pure functions: select / update / add / remove / move / dup / wrap / reset.
├── undoRedo.js                   # Stack helpers (push, undo, redo, coalesce).
├── idGenerator.js                # Stable id allocator (§5).
├── DesignerPreview.jsx           # Wraps StockPluginRuntimeRenderer with workingLayout + selection overlay.
├── LayoutTreePanel.jsx           # Tree view with select/expand/move handles.
├── InspectorPanel.jsx            # Per-type inspector dispatcher.
├── inspectors/
│   ├── CommonFields.jsx          # id, label, style (allow-list).
│   ├── KnobInspector.jsx
│   ├── ToggleInspector.jsx
│   ├── MeterInspector.jsx
│   ├── VisualizerInspector.jsx
│   ├── LabelInspector.jsx
│   ├── SpacerInspector.jsx
│   └── ContainerInspector.jsx    # panel/group/row/column shared form.
├── ComponentPalette.jsx          # Add-node buttons.
├── BindingPicker.jsx             # Param / meter slot / viz source picker.
├── ValidationPanel.jsx           # Renders ValidationError list.
├── ToolbarRow.jsx                # Save / Reset / Import / Export / Undo / Redo buttons.
└── styles/
    └── designer.css              # Scoped .pluginui-designer-* classes (§14).
```

Hard rules for the folder:

- Nothing in `designer/` is imported from `runtime/` or any production component. The only import edge is `CompressorPanel.jsx` → `PluginUIDesigner.jsx`, gated by `DESIGNER_ENABLED`.
- Designer never writes new files into `runtime/`. If it needs a primitive (e.g. `styleToCSS`), it imports from `runtime/` read-only.
- Designer modules may import from `schema/`, `manifests/`, `layouts/`, `runtime/registry.js`, `runtime/formats.js`, `constants/meterSlots.js`, `constants/dynamicsViz.js`. They MUST NOT import individual leaf components from `runtime/components/*` directly — preview goes through the runtime renderer, not a re-implementation.

---

## 3. Designer state model

### 3.1 Store shape

A single Zustand store, scoped per Designer instance (created on open, destroyed on close):

```js
// usePluginUIDesignerStore.js — *shape* only; no implementation.
{
  pluginId:       'compressor',           // fixed for first cut
  manifest:       <COMPRESSOR_MANIFEST>,  // resolved once on open

  workingLayout:  <PluginUILayout>,       // current in-memory document
  shippedLayout:  <PluginUILayout>,       // shipped default snapshot, used by 'Reset'
  savedOverride:  <PluginUILayout|null>,  // last on-disk override at open time, used as 'discard' baseline

  selectedNodeId: <string|null>,
  expandedNodeIds: Set<string>,           // Layout-tree expand/collapse state

  validationResult: <ValidationResult>,   // re-run after every mutation
  dirty:           false,                 // workingLayout differs from on-disk override (or shipped, if no override)

  undoStack:  [PluginUILayout, ...],      // capped at 100 entries; see §11
  redoStack:  [PluginUILayout, ...],
  pendingCoalesce: { nodeId, field, deadline } | null, // groups rapid edits

  previewMode:    'live' | 'frozen' | 'errors',
  // 'live'    → preview re-renders on every mutation (default)
  // 'frozen'  → preview locked to last validated snapshot (debug aid)
  // 'errors'  → preview shows validation overlay only
}
```

### 3.2 How state flows

```
┌──────────────────┐
│ shippedLayout    │  imported from SHIPPED_LAYOUTS['compressor'] on open
└────────┬─────────┘
         │
         ▼
┌──────────────────┐  pluginUi.loadUserOverride('compressor')
│ savedOverride    │◀──────────────────────────────── from main process
└────────┬─────────┘
         │  validate → if ok, becomes workingLayout
         ▼
┌──────────────────┐  every mutation goes through designerActions
│ workingLayout    │──── validate → validationResult ──┐
└────────┬─────────┘                                   │
         │  passed to DesignerPreview                  │
         ▼                                             ▼
┌──────────────────────────────┐         ┌────────────────────────┐
│ StockPluginRuntimeRenderer   │         │ ValidationPanel        │
│ (in <DesignerPreview>)       │         │ (read-only echo)       │
└──────────────────────────────┘         └────────────────────────┘
```

Important: the **runtime renderer remains the source of truth for actual rendering**. The Designer's `<DesignerPreview>` does not implement its own walker — it instantiates the same `StockPluginRuntimeRenderer` and feeds it the workingLayout via a small render-time prop override (see §9.1). If the renderer ever diverges from the editor's idea of the layout, the renderer wins.

### 3.3 What is NOT in the store

- Engine parameter values. Those are owned by the runtime renderer's internal `params` state, hydrated from the engine. The Designer never reads, writes, or stores them.
- Meter samples / viz buffers. Same reason — owned by the runtime.
- Theme tokens. Owned by the global theme system.
- Drag-state for the panel itself (handled by `CompressorPanel`'s existing drag refs).

---

## 4. Layout mutation model

All mutations are pure functions in `layoutMutations.js`. Each takes `(layout, args)` and returns a **new layout** (never mutates input). The store's `designerActions.js` calls one of them, runs `validate()` against the result, pushes the previous layout onto the undo stack, and updates `workingLayout` + `validationResult`.

### 4.1 Required operations

| Operation | Signature | Notes |
| --- | --- | --- |
| `selectNode` | `(layout, nodeId) → layout` (no-op on the doc; updates store only) | Just updates `selectedNodeId`. No undo entry. |
| `updateNodeProps` | `(layout, nodeId, propsPatch) → layout` | Shallow merge into `node.props`. Drops keys whose value becomes `undefined`. |
| `updateNodeStyle` | `(layout, nodeId, stylePatch) → layout` | Shallow merge into `node.style`. Validator strips disallowed keys; mutation should refuse them up front (see §6). |
| `updateNodeId` | `(layout, nodeId, newId) → layout` | Renames; collision check (§5). Updates `selectedNodeId` if it was the renamed node. |
| `addChild` | `(layout, parentId, childTemplate, atIndex?) → layout` | Inserts a freshly-id-generated node from a palette template. Refuses if `parentId` is not a container. |
| `removeNode` | `(layout, nodeId) → layout` | Refuses to remove `root`. Clears `selectedNodeId` if it was the removed node. |
| `duplicateNode` | `(layout, nodeId) → layout` | Clones subtree, regenerates ids deterministically (`-2`, `-3`, …). Inserts after the original. |
| `moveNode` | `(layout, nodeId, newParentId, newIndex) → layout` | Rejects move-into-self / move-into-descendant. |
| `reorderSibling` | `(layout, nodeId, newIndex) → layout` | Sugar over `moveNode` for same-parent reorder. |
| `wrapInContainer` | `(layout, nodeIds[], containerType) → layout` | Wraps contiguous siblings in a new `group`/`row`/`column`. Rejects non-contiguous selection or container types not in `{group,row,column}`. |
| `resetNodeToManifest` | `(layout, nodeId) → layout` | For a `knob`/`toggle`/`meter`, restores `props` to the manifest's defaults for that paramId/slot. No-op for nodes with no manifest mapping. |
| `replaceLayout` | `(layout, newLayout) → layout` | Used by Import and Reset-to-Default. Validates first; refuses on hard error. |

### 4.2 Mutation contract

Every mutation function MUST:

1. Preserve all node ids that are *not* being explicitly renamed.
2. Produce valid new ids for inserted/duplicated nodes (see §5).
3. Keep `node._invalid` / `node._vizUnavailable` fields out of saved JSON — those are validator annotations only. Mutations should pass through whatever the previous validate produced; the next `validate()` recomputes.
4. Refuse to introduce node `type` strings outside the allow-list (defence in depth on top of the validator). The palette is the only legal source of new types.
5. Refuse to write `style` keys outside the allow-list.
6. Never embed CSS strings, JSX, image data, urls, or script source anywhere. (The schema does not support these fields anyway; we enforce at mutation time too.)

### 4.3 Mutation pipeline

```
┌────────────────┐     ┌──────────────────┐     ┌────────────────┐
│ user gesture   │────▶│ designerActions  │────▶│ layoutMutations│
│ (UI event)     │     │ (build args,     │     │ (pure)         │
└────────────────┘     │  pick mutation)  │     └────────┬───────┘
                       └──────────────────┘              │
                                                         ▼
                                              ┌────────────────────┐
                                              │ validate(workingLayout, manifest) │
                                              └────────────┬───────┘
                                                           │
                                                           ▼
                              ┌────────────────────────────────────────────────┐
                              │ store.set({ workingLayout, validationResult,   │
                              │             undoStack: push(prev), redoStack:[]│
                              │             dirty: true })                     │
                              └────────────────────────────────────────────────┘
```

All edits flow through this pipe. There are no "fast paths" that bypass validation — even single-keystroke text edits validate (cheap; the validator is O(N nodes), and Compressor layouts are tiny).

---

## 5. Node id policy

### 5.1 Hard rules

- `id` is required and non-empty. The validator already enforces this; the Designer must never produce a layout where any node has `id === ''` or `id` undefined.
- `id`s are unique within the document. The validator hard-fails the whole document on duplicate ids; the Designer prevents collisions at the source.
- `id`s are stable across renames of unrelated nodes. The Designer never silently rewrites ids.

### 5.2 Generation strategy

`idGenerator.js` exposes one function:

```js
nextId(layout, base) → string
```

Where `base` is a deterministic hyphen-cased seed derived from the node template:

| Template | Seed |
| --- | --- |
| `knob({ param: "threshold" })` | `knob-threshold` |
| `knob({ param: undefined })` | `knob` |
| `toggle({ param: "detect_mode" })` | `toggle-detect-mode` |
| `meter({ source: { slot: "GAIN_REDUCTION" } })` | `meter-gain-reduction` |
| `visualizer({ source: "compressor.combined" })` | `viz-compressor-combined` |
| `row` | `row` |
| `column` | `column` |
| `group` | `group` |
| `label({ text: "Detect:" })` | `label-detect` (slugified, max 24 chars) |
| `spacer` | `spacer` |

The id is the seed if it is unique in `layout`. Otherwise append `-2`, `-3`, … until unique.

Renames go through the same uniqueness check; if the user types an id that already exists, the Inspector shows a validation error and refuses the rename (does not silently suffix).

### 5.3 What the Designer must not do

- Generate random / nanoid ids. The point of human-readable ids is git-diffable JSON files and shareable layouts.
- Rely on React keys. React's internal key handling is a runtime-only crash shield; a layout without explicit ids is invalid by §5.1 even if React happens to render it.
- Mutate ids on every save. Saves are pure transports — the document on disk has the same ids as the in-memory document.

---

## 6. Component palette rules

### 6.1 Allowed addable types (Compressor first pass)

The palette exposes exactly these:

```
group   row   column          ← containers
knob    toggle    meter       ← parameter / metering primitives
visualizer                    ← time-series viz
label   spacer                ← cosmetic helpers
```

### 6.2 Explicitly NOT exposed

- `panel` — exactly one allowed per layout (the root); palette never offers it.
- `tabGroup` — schema supports it (and the runtime mounts it), but it is intentionally not addable in the first Designer cut. Tab group authoring requires per-child `tabLabel` UX that we are deferring.
- `button` — schema supports it, but the action registry is empty for Compressor. Re-enable when an action surface for Compressor exists. Until then, palette omits `button`.
- `image`, `iframe`, `html`, `script`, `link`, `webview`, `embed`, `object`, raw CSS injection, remote URLs of any shape — these are not in the schema and must never be addable from the palette. The palette renders only what the runtime registry can mount.

### 6.3 Source of truth for the palette

The palette reads from a single allow-list module (`ui/src/plugin-ui/designer/paletteCatalog.js`), not from `runtime/registry.js` directly. The catalog is defined as the intersection of:

1. `Object.keys(COMPONENT_REGISTRY)` (defensive lower bound — palette can never offer a type the runtime can't mount).
2. A static `DESIGNER_VISIBLE_TYPES` set (`group, row, column, knob, toggle, meter, visualizer, label, spacer`).

If the runtime registry gains a type that is not yet "ready" for Designer (e.g. a future `xyPad`), the palette will not pick it up automatically — a developer must explicitly add it to `DESIGNER_VISIBLE_TYPES`.

### 6.4 Palette template shape

Each palette entry is `{ type, label, defaults }`:

```js
{
  type: 'knob',
  label: 'Knob',
  defaults: {
    style: {},
    props: { param: '<unset>', label: '', size: 52, format: 'dB1' },
  },
}
```

`<unset>` is a sentinel. Inserting a knob with `param: '<unset>'` produces a node that fails soft validation (`MISSING_PARAM` / `UNKNOWN_PARAM`) until the Inspector picks one — which is correct behaviour: the node renders as a placeholder in the preview, and the Validation panel guides the user to fix it. This is the same path as importing a hand-written file with a missing param.

---

## 7. Inspector field matrix

The Inspector is a per-type form rendered for the currently selected node. It composes a shared `CommonFields` block with a type-specific block.

### 7.1 Common fields (all node types)

| Field | Editable? | Source / control |
| --- | --- | --- |
| `id` | yes (with collision check) | Text input. On blur: validates uniqueness via `nextId(layout, value)`-style check. Empty / collision → red-bordered + validation message; rename rejected. |
| `type` | **read-only** | Plain text. Changing type is not a mutation; users delete + re-add. |
| `visibility` | **out of scope** | Schema does not currently support a `visible` flag. Mark as "out of scope — schema does not yet expose a visibility flag" in the Inspector, do not add a control. |

### 7.2 Style block (containers + leaves that meaningfully fill space)

Only the allow-list keys are exposed. Each gets a numeric input or select:

| Key | Control | Notes |
| --- | --- | --- |
| `paddingPx` | Number, or 4-tuple expand | Tuple form is `[top, right, bottom, left]`; collapse to scalar when all four equal. |
| `gapPx` | Number | Containers only (panel, group, row, column). |
| `widthPx` | Number | Optional. Empty = auto. |
| `heightPx` | Number | Optional. Empty = auto. |
| `growsToFill` | Checkbox | Sets `flex: 1`. |
| `align` | Select: `start / center / end / stretch` | Cross-axis. |
| `justify` | Select: `start / center / end / spaceBetween / spaceAround` | Main-axis. |
| `flexBasis` | Number | Optional. |

Anything else in the existing `node.style` (e.g. legacy keys from a hand-edited file) is shown as "stripped on next validate" and removed by the validator on save. The Inspector does not let users add new style keys outside the table.

### 7.3 Per-type fields

#### `knob`

| Field | Control | Source |
| --- | --- | --- |
| `param` | Binding picker (Param) | `Object.keys(COMPRESSOR_MANIFEST.params)` |
| `label` | Text | Free text; defaults to manifest `label`. |
| `size` | Number (clamp 24–96) | Default 52. |
| `format` | Select | Keys of `FORMATS` registry (`raw, dB1, dB1_signed, ms0, ms1, pct0, pct1, ratio, hz_smart, lufs1`). |
| `dragRange` | Number (clamp 50–500) | Default 150. |
| `color` | (advanced; collapsed by default) Text | Optional CSS color override; we keep this off the first-cut UI to discourage ad-hoc colors. Mark as advanced/dev. |

#### `toggle`

| Field | Control | Notes |
| --- | --- | --- |
| `param` | Binding picker (Param) | Same source as knob. |
| `mode` | Radio: `boolParam / discreteValue` | Switching mode toggles `valueWhenOn` visibility. |
| `valueWhenOn` | Number | Visible only when `mode = discreteValue`. |
| `label` | Text | Required. |

#### `meter`

| Field | Control | Source |
| --- | --- | --- |
| `source.kind` | Select: `effectMeter` (only option today) | Locked unless schema gains another kind. |
| `source.slot` | Binding picker (Meter slot) | Intersection of `meterSlots.js` semantic keys and `manifest.meterSlots`. For Compressor: `PEAK_L`, `PEAK_R`, `GAIN_REDUCTION`. |
| `label` | Text | Default `GR`/etc derived from slot. |
| `unit` | Text | e.g. `dB`. Free text. |
| `range.min`, `range.max` | Number | Required. |
| `range.scale` | Select: `linear / log` | |
| `orientation` | Radio: `vertical / horizontal` | |
| `format` | Select | Same FORMATS registry. |

#### `visualizer`

| Field | Control | Source |
| --- | --- | --- |
| `source` | Binding picker (Viz source) | `manifest.vizSources` (Compressor: 5 entries). |
| `preset` | Select | Compressor preset list — loaded from `runtime/visualizers/compressorPainter.js` exports (e.g. `compressorCombined`). The Designer reads a registry-shaped export, never hard-codes preset names. If the painter file does not yet expose a registry, add one as part of Phase F. |
| `heightPx` | Number | Default 110. |

#### `label`

| Field | Control |
| --- | --- |
| `text` | Text input (multiline up to 80 chars). |
| `variant` | Select: `default / muted / header`. |

#### `spacer`

| Field | Control |
| --- | --- |
| `widthPx` | Number, optional. |
| `heightPx` | Number, optional. |
| `growsToFill` | Checkbox. |

(Spacer's "props" are empty in the schema; sizing lives on `style`. Inspector hides the props block entirely for spacers.)

#### Containers (`panel`, `group`, `row`, `column`)

| Field | Control | Type-specific notes |
| --- | --- | --- |
| `props.title` | Text, optional | `group` only. |
| `props.columns` | Number (clamp 1–6) | `group` only. |
| `props.variant` | Select: `none / borderTop / borderBottom` | `row` only (matches existing CSS). |
| `panel.preferredSize` / `panel.minSize` | Number×2 | Only on the root `panel`, surfaced from doc-level `panel` not the node. |

### 7.4 Field validation behavior

- The Inspector validates *its own* field on blur (cheap, immediate feedback).
- Every accepted edit triggers a full `validate()` over the document, populating the Validation Panel.
- Rejected edits (e.g. duplicate id, bad number, unknown param via direct keystroke) revert the field's local value and surface a one-line message under the field.

---

## 8. Binding picker model

A single `<BindingPicker kind=... value=... onChange=... />` component handles all three binding types.

### 8.1 Param picker (`kind: 'param'`)

- Source: `Object.entries(COMPRESSOR_MANIFEST.params)`.
- Renders as a `<select>` whose options are param ids, labelled `<label> (<id>)` (e.g. `Threshold (threshold)`).
- Has no free-text mode in the first cut. The user picks from the manifest or nothing.
- Disabled options: none (all manifest params are bindable). If we ever expose param visibility per layout, we filter here.

### 8.2 Meter slot picker (`kind: 'meterSlot'`)

- Source: `manifest.meterSlots ∩ Object.keys(METER_SLOTS).filter(numeric)` (Compressor: `PEAK_L`, `PEAK_R`, `GAIN_REDUCTION`).
- Rendered as `<select>` of semantic keys. The slot integer index is **never** shown in the UI and never typeable.
- `kind = 'effectMeter'` is hard-coded; once a second kind is added (e.g. `'busMeter'`), the picker grows a leading kind selector.

### 8.3 Viz source picker (`kind: 'vizSource'`)

- Source: `manifest.vizSources` (Compressor: 5 entries from `COMPRESSOR_VIZ_SOURCES`).
- Rendered as `<select>` of the full string keys (e.g. `compressor.gainReductionHistory`).
- Preset picker (separate dropdown next to it) is only enabled once a source is chosen, and reads from the painter registry filtered for that source.

### 8.4 Hard rules (all picker kinds)

- The user CAN NEVER type an arbitrary string. There is no advanced text field in the first cut.
- The picker emits values that are guaranteed to be recognised by `validate()` against the same manifest. This is double-bookkeeping by design: one source of truth, two consumers.
- If the manifest ever loses a key (e.g. an engine refactor removes a param), existing layouts referencing it surface as `UNKNOWN_PARAM` soft errors; the picker shows the missing key as a strikethrough disabled option titled `(removed)`. Selecting another value clears the error.
- "Advanced / dev mode" with free-text bindings is explicitly out of scope for the first cut. Add later behind a separate flag if needed.

---

## 9. Live preview behavior

### 9.1 Reuse the runtime renderer

`<DesignerPreview>` mounts `<StockPluginRuntimeRenderer pluginId="compressor" target={target} />` with one twist: the renderer must be able to take the workingLayout from a prop instead of the user-override IPC.

The minimal renderer-side change is a new optional prop:

```jsx
<StockPluginRuntimeRenderer
  pluginId="compressor"
  target={target}
  layoutOverride={workingLayout}      // NEW: when present, skip user-override IPC
  layoutOverrideErrors={validationResult.errors}  // NEW: surface to placeholders
/>
```

Behaviour when `layoutOverride` is present:

- The renderer skips its `loadUserOverride` effect entirely.
- It runs `validate(layoutOverride, manifest)` itself — defence in depth — and uses the validated `doc`. Hard fail → falls back to shipped (same cascade as production).
- It does not subscribe to `onLayoutChanged`; the Designer is the canonical source while it is open.

This keeps "what the user sees in the Designer preview" identical to "what the user sees after Save", because the same code path renders both.

### 9.2 Preview update cadence

- Default: `live`. Every accepted mutation updates `workingLayout`, the renderer's `useState(activeLayout)` already takes the latest `layoutOverride` via `useEffect`, and the panel re-renders. For Compressor (≤ ~30 nodes) this is cheap and produces immediate feedback.
- Avoid full remount on every keystroke: pass workingLayout by reference; the renderer's `renderNode` walks the same structure. Knob/Toggle re-renders are confined to the leaves whose props changed because the node objects upstream have stable identity. **Stable id-based React keys** (which the renderer already uses) handle reconciliation.
- Exceptions that *do* require remount:
  - Renaming the root or restructuring `panel.preferredSize`. These are rare; accept the remount.
  - Switching previewMode (`live` ↔ `frozen` ↔ `errors`). Remount is the simplest correct behaviour.

### 9.3 Behaviour on validation errors

- **Soft errors** (e.g. `UNKNOWN_PARAM`, `MISSING_TEXT` on a label): the offending node renders as the existing `InvalidNodePlaceholder`; the rest of the layout renders normally. The Validation panel highlights which nodes failed. **Save is allowed** for soft errors that the validator marks `_invalid` on a node basis only — see §10.
- **Hard errors** (e.g. duplicate id, bad schemaVersion, missing root): the preview shows a single full-panel overlay (`Validation failed — preview disabled`), the Validation panel lists the errors, and **Save is disabled** until the layout passes the hard check. The last *valid* `workingLayout` is preserved in memory and is what undo restores.

### 9.4 No disk writes on edit

The preview never writes to `userData/plugin-ui/compressor.json`. Disk writes happen only on explicit Save / Reset / Import (§13). This means:

- A Designer crash mid-edit cannot corrupt the saved override.
- Undo across a save boundary is reasonable: the saved override is the baseline that closing without saving restores to.

---

## 10. Validation UX

### 10.1 Source of truth

`validate(workingLayout, manifest)` from `ui/src/plugin-ui/schema/validate.js`. The Designer never reimplements validation — it only formats the result.

### 10.2 Display

`ValidationPanel.jsx` renders the `validationResult.errors` array as a list with:

```
[severity] [code]   [nodeId or —]   message
```

- Severity is hard / soft, determined by the validator's contract (§10.3).
- Clicking an error with a `nodeId` selects that node in the Layout Tree and scrolls the Inspector to the offending field.
- The panel is collapsed when `errors.length === 0` and shows a green check.

### 10.3 Hard vs soft classification

The validator already separates hard from soft by return shape (`ok: false` → all hard; `ok: true, errors[]` → all soft). The Designer treats:

- Any `{ ok: false }` result → **hard**, blocks Save, blocks export, preview shows full overlay.
- Codes inside `{ ok: true, errors }`:
  - `UNKNOWN_TYPE`, `MISSING_PARAM`, `UNKNOWN_PARAM`, `BAD_TOGGLE_MODE`, `MISSING_VALUE_WHEN_ON`, `MISSING_ACTION`, `MISSING_LABEL`, `MISSING_SOURCE`, `UNKNOWN_SOURCE_KIND`, `MISSING_SLOT`, `UNKNOWN_SLOT`, `SLOT_NOT_IN_MANIFEST`, `BAD_RANGE`, `MISSING_PRESET`, `MISSING_TEXT`, `LEAF_HAS_CHILDREN`, `MISSING_ID`, `UNKNOWN_VIZ_SOURCE` → **soft, blocks Save**.
  - `UNKNOWN_STYLE_KEY`, `BAD_STYLE_ALIGN`, `BAD_STYLE_JUSTIFY` → **soft, allows Save** (the validator already strips these and the result is well-formed). Surface in the panel as informational.

(Note: `DUPLICATE_ID` is technically annotated soft and then upgraded to hard; the Designer treats any presence of `DUPLICATE_ID` as hard-equivalent regardless of the wrapper shape.)

The Save button uses this rule:

```
canSave = result.ok && result.errors.every(e => isStyleStripError(e.code))
```

### 10.4 Inspector inline validation

When the selected node has a soft error, the Inspector field that owns that error gets a red underline + tooltip with the error message. This is the primary "fix it now" path for the user.

---

## 11. Undo/redo plan

### 11.1 Stack model

- Snapshot-based, not patch-based. Each undo entry is a full `workingLayout` clone (cheap for Compressor — layouts are < 4 KB JSON).
- Stack cap: 100 entries on each side. Older entries are dropped FIFO.
- Snapshots are created BEFORE the mutation runs; redoStack is cleared on every fresh mutation.

### 11.2 Coalescing rule

Rapid edits to the same field on the same node within 400 ms group into a single undo step:

- `pendingCoalesce = { nodeId, field, deadline }` is set on the first edit.
- Subsequent edits matching `(nodeId, field)` before `deadline` mutate `workingLayout` but DON'T push a new undo entry.
- Any edit to a different node/field, or `deadline` expiry, finalises the coalesced step (re-arms `pendingCoalesce`).

This applies to scalar number/text edits in the Inspector. Structural edits (add / remove / move / rename id / wrap) are never coalesced.

### 11.3 What undo restores

`undo()` pops the previous snapshot and sets:

- `workingLayout` ← snapshot
- `validationResult` ← `validate(snapshot, manifest)`
- `selectedNodeId` ← snapshot's `selectedNodeId` if the id still exists in the layout, otherwise `null` (the snapshot stores both layout and selection).
- `dirty` ← recompute (snapshot-equals-savedOverride? false : true).

`redo()` is symmetric.

The undo history is in-memory only. Closing the Designer drops it. This is fine for a developer tool and avoids persisting a potentially-stale stack across runs.

---

## 12. Save / load / import / export UX

### 12.1 Existing IPC surface (use as-is)

```
window.xleth.pluginUi.loadUserOverride(pluginId)        ✅ exists in preload.js, main.js
window.xleth.pluginUi.saveUserOverride(pluginId, doc)   ✅
window.xleth.pluginUi.clearUserOverride(pluginId)       ✅
window.xleth.pluginUi.onLayoutChanged(cb)               ✅
```

### 12.2 IPC surface to ADD

The Designer needs three additional IPC handlers, all on the main process:

| Method | Purpose | Signature |
| --- | --- | --- |
| `getShipped` | Returns the bundled shipped default for a plugin. Used by `Reset to Default`. | `(pluginId) → Promise<PluginUILayout>` |
| `importDialog` | Opens a native open-file dialog filtered to `.xlethui.json`, reads the file, returns its parsed contents. | `() → Promise<{ pluginId, layout } \| null>` |
| `exportDialog` | Opens a native save-file dialog filtered to `.xlethui.json`, writes the doc. | `(pluginId, layout) → Promise<{ path } \| null>` |

Implementation notes for `ui/main.js`:

- `getShipped` reads from the same `SHIPPED_LAYOUTS` registry the renderer uses; on the main side this is simplest as `require('./dist/...layouts/<id>.json')` is awkward — instead the renderer can pass its in-memory copy via the import/export round-trip, or main can `require` the JSON file by absolute path. **Recommended:** main process reads `path.join(__dirname, 'src/plugin-ui/layouts/<pluginId>.json')` directly (these files are source-controlled and shipped with the app) and JSON-parses.
- `importDialog` uses Electron's `dialog.showOpenDialog`; resolves to the parsed object plus the embedded `pluginId`, lets the renderer cross-check.
- `exportDialog` uses `dialog.showSaveDialog`; main re-runs `validateLayoutStructure` (the existing main-side check) before writing. Pretty-prints with `JSON.stringify(doc, null, 2)`.
- The existing main-side `validateLayoutStructure` is the *minimum* check — defence in depth on top of renderer-side `validate()`. Both must pass.

The Designer's preload addition mirrors the existing block:

```js
window.xleth.pluginUi.getShipped     = (pluginId)    => invoke('xleth:pluginUi:getShipped', pluginId)
window.xleth.pluginUi.importDialog   = ()            => invoke('xleth:dialog:importPluginUi')
window.xleth.pluginUi.exportDialog   = (pluginId, layout) => invoke('xleth:dialog:exportPluginUi', pluginId, layout)
```

### 12.3 Save UX

- Save is enabled when `canSave` (§10.3) is true and `dirty === true`.
- Click Save:
  1. Run renderer-side `validate(workingLayout, manifest)` once more (paranoia).
  2. `await window.xleth.pluginUi.saveUserOverride('compressor', workingLayout)`.
  3. On success: update `savedOverride ← workingLayout`, set `dirty: false`, surface a transient toast `Saved.`.
  4. On failure: toast the error message, **keep workingLayout in memory**, do not clear undo stack. The user can keep editing or retry.
- Save does NOT close the Designer.
- The `xleth:pluginUi:changed` broadcast fires automatically on the main side; any other window with a Compressor panel open re-loads the layout. The Designer instance that issued the save ignores its own broadcast (compares last-saved-doc identity).

### 12.4 Reset to Default UX

- Two sub-actions, behind a small popover on the `Reset` button:
  - **Reset to shipped default**: `workingLayout ← shippedLayout` (clone). Sets `dirty: true` if `shippedLayout !== savedOverride`.
  - **Discard changes**: `workingLayout ← savedOverride ?? shippedLayout`. Sets `dirty: false`.
  - **Clear user override on disk** (destructive — confirm dialog): calls `clearUserOverride('compressor')`, then sets `savedOverride: null`, `workingLayout ← shippedLayout`, `dirty: false`.
- The destructive variant is the only path that touches disk for Reset.

### 12.5 Import / Export UX

- **Export** is enabled whenever `canSave` is true. It writes whatever is currently in `workingLayout` (after `validate`) to a user-chosen `.xlethui.json` path. Export does *not* save the working layout as the user override.
- **Import**:
  1. `pluginUi.importDialog()` returns `{ pluginId, layout }`.
  2. Reject if `pluginId !== 'compressor'` (cross-plugin layouts not supported, per architecture doc §3.1).
  3. Run `validate(layout, manifest)`.
  4. On hard error → toast `Import failed: <reason>`, do not touch `workingLayout`.
  5. On success → push current `workingLayout` to undo stack, replace with imported layout, mark `dirty: true`. (Save is a separate explicit step.)
- The renderer never touches `fs` directly. Import/export always go through the main process.

### 12.6 What lives where

| Artifact | Path | Authority |
| --- | --- | --- |
| Shipped default | `ui/src/plugin-ui/layouts/compressor.json` | Source-controlled in repo. Read-only at runtime. |
| User override | `<userData>/plugin-ui/compressor.json` | Written by `saveUserOverride`, deleted by `clearUserOverride`. Main process is sole authority. |
| Imported / exported file | User-chosen path on disk | Plain `.xlethui.json` file. No auto-import; importing always goes through the dialog. |

Project files (`.xleth`) do NOT embed plugin-ui layouts. Sharing a project does not ship layout customisations, by design.

---

## 13. Safety / fallback behavior

### 13.1 Designer crash containment

- `<PluginUIDesigner>` is wrapped in an error boundary inside `CompressorPanel.jsx`. A crash in the Designer does not unmount the Compressor panel; the boundary renders a small "Designer crashed; close it and reopen" message in the Designer column, and the preview column keeps rendering the user-override (or shipped) layout via the runtime renderer's normal cascade.
- `<DesignerPreview>` also has its own boundary. Preview crashes show "Preview unavailable" inside the preview column without taking down the Layout Tree / Inspector.

### 13.2 Bad layout protection

- `workingLayout` becoming "broken" never overwrites the saved override — disk writes are gated on `validate(...).ok` AND main-side `validateLayoutStructure`. Both must pass.
- If a save somehow succeeds with content that the runtime later rejects on reload, the runtime falls back to shipped per its existing cascade, and the layout-changed broadcast still fires — the user can reopen the Designer, re-import the file, and fix it.

### 13.3 Visualization degradation

- If the engine returns a viz schema mismatch for the `<visualizer>` node in the preview, the existing `_vizUnavailable` placeholder shows for that node only. Designer keeps working.
- If `setEffectVisualizationEnabled` itself throws (engine not ready, IPC down), the preview's visualizer node renders the placeholder; the rest of the panel is unaffected. (Same as production.)

### 13.4 IPC failure modes

| Failure | Designer behaviour |
| --- | --- |
| `loadUserOverride` rejects | Treat as "no override"; `savedOverride: null`, `workingLayout: shippedLayout`. |
| `getShipped` rejects | Fall back to `SHIPPED_LAYOUTS[pluginId]` from the bundled JSON import (the renderer already has this in memory). Designer continues. |
| `saveUserOverride` rejects | Toast error, keep working state, do NOT clear undo, do NOT close Designer. |
| `importDialog` rejects | Toast `Import failed`. No changes to working state. |
| `exportDialog` rejects | Toast `Export failed`. |

### 13.5 Unsaved-changes guard

- Closing the Compressor panel (the X chrome button) while `dirty === true` shows a confirm: `You have unsaved layout changes. Save before closing?` with `Save / Discard / Cancel`. `Cancel` aborts the close.
- Closing the Designer side panel while `dirty === true` shows the same confirm. `Discard` keeps the Compressor panel open and discards working changes.

---

## 14. Styling plan

### 14.1 Hard rules

- Raw CSS only. No Tailwind, no styled-components, no inline class generation.
- All Designer classes use the `pluginui-designer-` prefix (extends the existing `pluginui-` prefix from the runtime).
- All colors / fonts / borders / radii come from the existing theme tokens (`var(--theme-*)` / `var(--accent-*)`) — same rule as the runtime CSS in `app.css:10345`.
- Designer adds **one** new CSS file: `ui/src/plugin-ui/designer/styles/designer.css`, imported once at the top of `PluginUIDesigner.jsx`. Do NOT inline the rules into `app.css`; we want the cost to disappear when `DESIGNER_ENABLED` is false (Vite tree-shakes the import).

### 14.2 Class naming

```
.pluginui-designer-root              ← the outer column container
.pluginui-designer-section           ← Layout Tree / Inspector / Palette / Validation / Toolbar wrappers
.pluginui-designer-section-header
.pluginui-designer-tree
.pluginui-designer-tree-node
.pluginui-designer-tree-node--selected
.pluginui-designer-tree-node--invalid
.pluginui-designer-inspector
.pluginui-designer-field-row
.pluginui-designer-field-label
.pluginui-designer-field-control
.pluginui-designer-field-error
.pluginui-designer-palette
.pluginui-designer-palette-button
.pluginui-designer-validation-row
.pluginui-designer-validation-row--hard
.pluginui-designer-validation-row--soft
.pluginui-designer-toolbar
.pluginui-designer-button
.pluginui-designer-button--primary
.pluginui-designer-button--danger
.pluginui-designer-toast
```

### 14.3 First-cut visual style

- Compact: 24-px row height, 11-px font, dense form layout. The Designer is a tool, not a hero feature.
- One-pixel borders, theme tokens, no shadows / animations / gradients / icons-with-color.
- No drag-and-drop in the Layout Tree visuals for the first cut — use up/down arrow buttons next to each tree node instead. Drag-and-drop is a Phase J+ enhancement.
- Selection colour is `var(--accent-primary)` background with text-color contrast token. Invalid-node colour is `var(--theme-error)` border.

Do not spend time on aesthetics. The goal is to produce valid JSON; the artwork phase comes after the editor is correct.

---

## 15. Implementation phases

Each phase is a self-contained PR with its own acceptance criteria.

### Phase A — Designer shell

- Add `featureFlag.js`, `PluginUIDesigner.jsx` (renders just an empty pane with placeholder text), `styles/designer.css`.
- Wire CompressorPanel header `Edit UI` button gated by `DESIGNER_ENABLED`.
- Side-panel layout: panel grows wider when designer is open.
- **Done when**: with `VITE_XLETH_PLUGIN_UI_DESIGNER=1`, the Compressor panel shows an `Edit UI` button that opens an empty designer column; without the flag, no button and no module pulled in.

### Phase B — Load shipped/user layout into workingLayout

- Add `usePluginUIDesignerStore.js` with state from §3.
- On Designer open, populate `shippedLayout` (from bundled `SHIPPED_LAYOUTS`) and call `loadUserOverride`. Pick the user override if `validate.ok`, else shipped.
- Add `<DesignerPreview>` that mounts `StockPluginRuntimeRenderer` with `layoutOverride={workingLayout}` (this requires the small renderer prop addition from §9.1).
- Toolbar shell with disabled buttons.
- **Done when**: opening Designer shows the preview rendering the same Compressor as without it. Tweaking `workingLayout` from a debug button updates the preview.

### Phase C — Layout tree selection

- Build `LayoutTreePanel.jsx` rendering `workingLayout.root` recursively, with selection.
- Visual flag for invalid nodes.
- Hover preview-side highlight: when a node is selected/hovered in the tree, draw an outline overlay around its DOM in `<DesignerPreview>` (sourced via `data-pluginui-id` attribute the runtime should already emit; if not, add it as a renderer-side concern, not a Designer one).
- **Done when**: clicking any node in the tree selects it; selecting `root` highlights the whole panel; the Inspector pane shows "(node selected, inspector coming in Phase D)".

(Phases D–J listed for completeness; the next implementation prompt covers A–C.)

### Phase D — Inspector edit common/style props

- Build `InspectorPanel.jsx` + per-type inspectors + `CommonFields.jsx`.
- Style block (allow-list only).
- Designer-side mutations for `updateNodeProps`, `updateNodeStyle`, `updateNodeId`.
- Field-level + document-level validation surfacing.

### Phase E — Add/remove/reorder nodes

- `ComponentPalette.jsx` + the rest of `layoutMutations.js` (add, remove, dup, move, reorder, wrap).
- Up/down arrow controls in the tree.
- `idGenerator.js`.

### Phase F — Binding pickers

- `BindingPicker.jsx` (param / meterSlot / vizSource).
- Visualizer preset registry export from `runtime/visualizers/compressorPainter.js` (or a sibling registry file) so the picker can enumerate presets without hard-coding.

### Phase G — Validation panel

- `ValidationPanel.jsx`: list, severity, click-to-select.
- Inline field-level error rendering.
- Save-button gating per §10.3.

### Phase H — Save / Reset / Import / Export

- Add IPC handlers in `ui/main.js` (`xleth:pluginUi:getShipped`, `xleth:dialog:importPluginUi`, `xleth:dialog:exportPluginUi`).
- Mirror in `ui/preload.js`.
- Wire toolbar buttons. Implement the unsaved-changes confirm.

### Phase I — Undo / redo

- `undoRedo.js` (snapshot stack + coalesce).
- Hotkeys (`Ctrl+Z` / `Ctrl+Shift+Z`) scoped to the Designer column.

### Phase J — Smoke tests + manual test script

- Per §16.

---

## 16. Test plan

### 16.1 Unit tests (Vitest)

Place in `ui/src/plugin-ui/designer/__tests__/`.

- `layoutMutations.test.js`
  - `addChild` produces deterministic id.
  - `addChild` into a leaf type rejects.
  - `removeNode` refuses on root.
  - `removeNode` clears `selectedNodeId` if the removed node was selected.
  - `duplicateNode` regenerates ids with `-2`/`-3` suffixes; nested ids also unique.
  - `moveNode` rejects move-into-self / descendant.
  - `wrapInContainer` rejects non-contiguous selection.
  - `wrapInContainer` rejects non-container target (`knob`).
  - `resetNodeToManifest` restores knob defaults from manifest.
  - All mutations preserve unrelated node ids.
  - All mutations refuse to introduce types outside the allow-list.
  - All mutations refuse style keys outside the allow-list.
- `idGenerator.test.js`
  - Base seed for each template type.
  - Slugifies labels to ≤ 24 chars.
  - Suffix on collision; preserves seed if free.
  - Suffix increments past existing `-2`, `-3`.
- `validate-blocks-save.test.js`
  - Layout with `DUPLICATE_ID` → `canSave === false`.
  - Layout with only `UNKNOWN_STYLE_KEY` → `canSave === true`.
  - Layout with `UNKNOWN_PARAM` → `canSave === false`.

### 16.2 Component tests (Vitest + @testing-library)

- `Designer-opens.test.jsx`
  - Mounts `<CompressorPanel>` with `DESIGNER_ENABLED=true`, simulates clicking `Edit UI`, asserts the Layout Tree shows `panel > body > knob-grid > k-threshold` etc.
- `Designer-edit-knob-label.test.jsx`
  - Selects `k-threshold` in the tree, types a new label in the Inspector, asserts the tree shows the new label and the preview's knob label DOM updates.
- `Designer-rejects-invalid-binding.test.jsx`
  - Tries to set a knob's `param` to a value not in the manifest (via simulated illegal store dispatch). Assert the Inspector field surfaces `UNKNOWN_PARAM` and Save is disabled.

### 16.3 Manual Electron test script

Run with `VITE_XLETH_PLUGIN_UI_DESIGNER=1 npm run electron:dev`:

1. Open a project with at least one track.
2. Add a Compressor effect; open its panel.
3. Click `Edit UI`. Designer column appears; preview still shows working Compressor.
4. Select `k-threshold`. In the Inspector, change `label` from `THRESH` to `Threshold`. Confirm the preview knob label updates live, the tree updates, and the toolbar's Save button becomes enabled.
5. Click Save. Toast `Saved.` appears. `dirty` flag clears.
6. Close the Compressor panel. Re-open it (without restarting). Confirm the new label persists.
7. Click `Edit UI` → `Reset` → `Reset to shipped default`. Confirm preview reverts; `dirty` is true.
8. Click Save. Confirm shipped default is now the saved override.
9. `Reset` → `Clear user override on disk`. Confirm a confirm dialog appears; on accept, the userData file is deleted; preview shows shipped (same content, but `savedOverride: null`).
10. `Import` → pick a file that is not a layout (e.g. `package.json`). Confirm it is rejected with a clear error toast and no state change.
11. `Import` → pick a valid `.xlethui.json` for Limiter (wrong pluginId). Confirm rejected with `pluginId mismatch`.
12. `Export` → save to a path. Open the file in a text editor. Confirm valid JSON, `$xleth: "plugin-ui-layout"`, ids unchanged.
13. With Designer open, kill the engine worker process (or simulate by disabling viz). Confirm the visualizer node in the preview shows `Visualization unavailable`, the Layout Tree / Inspector remain usable, no crash.

---

## 17. Out-of-scope (explicit)

- Limiter, Transient Processor, Overdone — only Compressor in this design and the PRs that implement it.
- Editing the schema itself, adding new node types, adding new visualization presets.
- New engine APIs. The Designer uses only the existing `xleth:pluginUi:*` and proposed `getShipped` / `importDialog` / `exportDialog` handlers; no engine call is added.
- C++ DSP changes.
- Visualization telemetry changes.
- Removing the legacy Compressor fallback in `CompressorPanel.jsx`.
- Generating arbitrary JSX or React components from the Designer.
- Generating arbitrary CSS, inline `style` strings, or `<style>` tags from the Designer.
- User-authored scripts, HTML, iframes, images, raw URLs, remote content of any kind in the layout JSON.
- Storing parameter values in the layout JSON. Parameter state stays in the engine + project file.
- Storing layouts in `.xleth` project files by default.
- Cross-platform support. Xleth remains Windows-only; Designer is Windows-only.
- Drag-and-drop reorder, multi-select, copy-paste, keyboard navigation (beyond Save/Undo/Redo hotkeys), search, tree filter, theming presets, layout templates, project-pinned layouts, layout sharing UI, marketplace, layout snapshots, A/B preview, MIDI-learn binding, parameter automation routing, accessibility audit. All of these are post-first-cut.
- Tab group authoring (`tabGroup` is in the runtime registry but intentionally not in the palette).
- Button authoring (`button` is in the schema but Compressor has no action surface yet).
- Production user exposure. The flag stays off in shipped builds until a separate decision.

---

## Appendix — Next implementation prompt summary (Phase A → C only)

When the user runs the next prompt, hand the implementer this:

> Build the Plugin UI Designer skeleton for Compressor, **Phases A through C only**, against the design at `docs/dev/plugin-ui-designer-mode-plan.md`. Do not implement Phase D and beyond.
>
> Concretely:
>
> 1. **Phase A — Designer shell.**
>    - Create `ui/src/plugin-ui/designer/featureFlag.js` exporting `DESIGNER_ENABLED = !!import.meta.env.VITE_XLETH_PLUGIN_UI_DESIGNER`.
>    - Create `ui/src/plugin-ui/designer/PluginUIDesigner.jsx` rendering an empty right-side column with the section placeholders (Layout Tree, Inspector, Palette, Validation, Toolbar) and no behaviour.
>    - Create `ui/src/plugin-ui/designer/styles/designer.css` with the `.pluginui-designer-*` class shells per §14, using existing theme tokens. Import it from `PluginUIDesigner.jsx`.
>    - Modify `ui/src/components/mixer/CompressorPanel.jsx` to:
>      - import `DESIGNER_ENABLED` and `PluginUIDesigner` lazily,
>      - render an `Edit UI` button in the header next to the close button, only when `DESIGNER_ENABLED` is truthy,
>      - toggle a `designerOpen` local state on click,
>      - widen the panel and mount `<PluginUIDesigner pluginId="compressor" target={target} onClose={...}/>` next to the runtime renderer when open,
>      - wrap the Designer in its own React error boundary so a Designer crash does not unmount the Compressor body.
>    - With the flag off, the Designer module must not be imported (use `lazy()` + a top-level guard so production bundles do not pull it in).
>
> 2. **Phase B — Load shipped/user layout into workingLayout.**
>    - Create `ui/src/plugin-ui/designer/usePluginUIDesignerStore.js` (Zustand) with the state shape from §3.1 and basic getters/setters. Implement only `setWorkingLayout`, `setSelectedNodeId`, `setValidationResult`, `markDirty`, `loadInitial(pluginId)`. Skip undo/redo, mutations, coalescing.
>    - `loadInitial('compressor')`:
>      - `shippedLayout ← SHIPPED_LAYOUTS.compressor`,
>      - `await window.xleth.pluginUi.loadUserOverride('compressor')` → if truthy and `validate(...).ok`, use it as `savedOverride` and `workingLayout`; else `savedOverride: null`, `workingLayout: shippedLayout`,
>      - run `validate(workingLayout, COMPRESSOR_MANIFEST)` and store the result.
>    - Create `ui/src/plugin-ui/designer/DesignerPreview.jsx` that renders `<StockPluginRuntimeRenderer pluginId="compressor" target={target} layoutOverride={workingLayout} layoutOverrideErrors={validationResult.errors} />`.
>    - Modify `ui/src/plugin-ui/runtime/StockPluginRuntimeRenderer.jsx` to accept the new `layoutOverride` and `layoutOverrideErrors` props per §9.1: when `layoutOverride` is set, skip the `loadUserOverride` effect and the `onLayoutChanged` listener, run `validate(layoutOverride, manifest)`, and use the resulting `doc` (or fall back to shipped per the existing cascade if hard-fail). Keep all production behaviour unchanged when the props are absent.
>    - Wire `PluginUIDesigner.jsx` to call `loadInitial` on mount, render `<DesignerPreview>` if not already rendered as the Compressor body (decide one: easier first cut is "Designer's preview is the same instance as the Compressor body's runtime renderer; the Compressor body simply receives `layoutOverride={workingLayout}` once Designer is open"). The latter is preferred — single mount, single hydration.
>    - Toolbar buttons (`Save`, `Reset`, `Import`, `Export`, `Undo`, `Redo`) appear but are all disabled.
>
> 3. **Phase C — Layout tree selection.**
>    - Create `ui/src/plugin-ui/designer/LayoutTreePanel.jsx` rendering the workingLayout as an expandable tree with one row per node (`type` + `id` + `(label)` if known + invalid badge if `_invalid`/`_vizUnavailable`).
>    - Clicking a row sets `selectedNodeId` in the store. Selected row uses the highlight class.
>    - Add `data-pluginui-id={node.id}` to the rendered DOM in `ui/src/plugin-ui/runtime/components/*.jsx` if not already present (audit all 12 component files; add the attribute to the outermost div of each). This is a small renderer-side change required for selection-overlay use later.
>    - When a node is selected, render a 1-px outline overlay over its preview DOM (find via `[data-pluginui-id="..."]` query, compute bounding rect, render an absolutely-positioned div in the Designer overlay layer).
>    - Inspector pane is a stub showing `Selected: <id>  (inspector coming in Phase D)` when something is selected, otherwise `(no selection)`.
>
> Do **not** implement layout mutations, the Inspector form, the Palette, the Binding pickers, save/load IPC additions, undo/redo, validation rendering, or any test scenario beyond a single component test for "Designer opens with Compressor layout shown in tree". Those are Phases D–J.
>
> Constraints inherited from the design:
> - No JSX/CSS/script generation.
> - No engine API changes.
> - No C++ changes.
> - Only the IPC surface that already exists (no new main-side handlers in this PR).
> - Designer code lives entirely under `ui/src/plugin-ui/designer/`. The only edges are: the new prop on `StockPluginRuntimeRenderer`, the `data-pluginui-id` attribute on existing runtime components, and the lazy import + button in `CompressorPanel.jsx`.
>
> When done, hand-test per Manual Electron Test §16.3 steps 1–3 only. Steps 4+ are blocked on Phase D.

# Plugin UI Freeform Placement & Decoration Plan

**Status:** Design only. No code in this pass.
**Scope:** Stock Plugin UI Designer freeform placement and decoration for **Compressor only**. Limiter, Transient Processor, Overdone, C++, bridge code, JSX/CSS/HTML generation, scripts, iframes, webviews, and remote content are out of scope.

This plan extends the existing layout system (panel/group/row/column/tabGroup + leaves) with an **opt-in absolute-positioning layer** and a closed set of declarative **decoration nodes** (text, line, shape, decal). It is intentionally narrower than a vector editor: users may drag, resize, and place from a closed palette, but they cannot author CSS, paint pixels, import SVG, or reference remote URLs.

The load-bearing rules:

> 1. `.xlethui.json` remains a clean declarative layout file. Geometry is numeric data; decoration is closed-vocabulary data.
> 2. The existing flow layout (rows, columns, groups) keeps working untouched. Freeform is a sibling mode, not a replacement.
> 3. No raw colors, no raw CSS strings, no raw filesystem paths, no remote URLs, no SVG in the first pass.

---

## 1. Problem Statement

The Compressor Designer can edit structure, layout, bindings, props, validation state, undo/redo, and tokenized knob appearance. It is mechanically complete, but the UX still feels like a **tree/inspector editor** rather than a **visual faceplate designer**:

- Positioning a knob currently means selecting it in the layout tree, choosing a parent, and editing flow-layout hints (`paddingPx`, `gapPx`, `widthPx`). Composing an attractive faceplate requires guessing how flow values map to visual placement.
- There is no way to add purely decorative content. A faceplate often wants a thin divider, a small caption above a knob group, a chrome plate behind the meters, or a brand decal in a corner. None of those are first-class today.
- Layered visual content (a label sitting on top of a backplate) cannot be expressed at all.

Krasen wants:

- An easier way to **place** elements visually — drag, resize, snap.
- A way to add **decals/texts/lines/shapes** that can be positioned, sized, layered, and adjusted.
- Everything still safe, declarative, hand-editable, reviewable, and shareable. The Compressor layout must remain a clean JSON document.

The constraints that fall out:

- Existing flow layout must keep working unchanged.
- Freeform must be **opt-in per subtree**, not a global mode flip.
- Geometry must be **numeric and bounded**, not raw CSS.
- Decoration nodes must come from a **closed catalog**, not arbitrary HTML/SVG.
- All colors, fonts, and surfaces must resolve through the existing **token allow-list**.
- Decal assets must come from a **closed registry** in the first pass; user-imported images are a later phase.

---

## 2. Freeform Layer Schema

### 2.1 Three options considered

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| **A. New container type `freeformLayer`** | A new `ContainerType` whose children opt into absolute positioning. | Explicit, scoped, inspectable in the tree. Validator gate is a single type check. Mixes cleanly with rows/columns: a row can contain a freeform layer. | Adds one node type. |
| B. `panel.overlay[]` array | A separate top-level array on the panel for "overlay" decorations. | No new node type. | Couples the feature to the root panel. Cannot place an overlay over only one row/group. Two parallel trees to validate, render, and edit. |
| C. Style mode on existing containers | Add `style.layoutMode: 'freeform'` to row/column/group. | Reuses existing types. | Forks the meaning of every container. Validator must branch on every container. Designer tree representation gets ambiguous (is this row a flow row or a freeform canvas?). Migration is messy. |

### 2.2 Recommendation — Option A

Adopt **a new container type** `freeformLayer`. Reasons:

- Existing renderer/validator/Designer all dispatch on `node.type`. A new type is the smallest, most explicit hook.
- Scope is local: a freeform layer can live anywhere in the tree (e.g. inside a `group`, beside a `row`).
- Migration is trivial because no existing layout uses it. Existing Compressor JSON stays valid.
- Tree-view and palette behavior is unsurprising — it shows up as a container with a clear label.

### 2.3 Schema shape

```json
{
  "id": "ff-decor",
  "type": "freeformLayer",
  "style": { "widthPx": 640, "heightPx": 220 },
  "props": {
    "snap":       { "gridPx": 8, "enabled": true },
    "background": "transparent",
    "clip":       "panel"
  },
  "children": [
    { "id": "deco-divider", "type": "decorLine",  "props": { "frame": { "x": 16, "y": 12, "widthPx": 608, "heightPx": 1 }, "orientation": "horizontal", "thickness": "hair", "strokeToken": "text.subtle", "style": "solid" } },
    { "id": "deco-caption", "type": "decorText",  "props": { "frame": { "x": 16, "y": 18, "widthPx": 200, "heightPx": 18 }, "text": "DYNAMICS", "variant": "header", "align": "left", "letterSpacing": "wide", "textToken": "text.muted" } },
    { "id": "k-threshold-ff", "type": "knob",     "props": { "frame": { "x": 24, "y": 56, "widthPx": 64,  "heightPx": 88 }, "param": "threshold", "label": "THRESH", "size": 52, "format": "dB1" } }
  ]
}
```

### 2.4 What is and is not allowed inside

**Allowed children of `freeformLayer`:**

- All existing **leaf** types: `knob`, `toggle`, `button`, `meter`, `visualizer`, `label`, `spacer`.
- All new **decoration** types: `decorText`, `decorLine`, `decorShape`, `decal`.

**Disallowed inside `freeformLayer` in the first pass:**

- Nested containers (`panel`, `group`, `row`, `column`, `tabGroup`, `freeformLayer`). Freeform layers are flat. This avoids nested coordinate spaces, nested rotation composition, and recursive selection-overlay math.

A `freeformLayer` may itself appear **inside** any flow container (`panel`, `group`, `row`, `column`). It cannot be the root (root remains `panel`).

### 2.5 Layer-level props

| Key | Type | Notes |
| --- | --- | --- |
| `props.snap.gridPx` | enum `1 \| 2 \| 4 \| 8 \| 16` | Default `8`. |
| `props.snap.enabled` | boolean | Default `true`. Affects Designer drag/resize math only — runtime ignores. |
| `props.background` | enum `transparent \| panel \| inset` | Backplate token slot for the layer container. Default `transparent`. |
| `props.clip` | enum `panel \| visible` | Whether children are clipped to the layer bounds. Default `panel` (clip on). |

`style.widthPx` / `style.heightPx` define the layer's own coordinate space. If omitted, the layer fills its flow parent (validator soft-warns that a freeform layer with no explicit size inside a `growsToFill` parent is fine, but inside an auto-sized parent it should declare both).

---

## 3. Geometry Model

### 3.1 Two locations considered

| Option | Description |
| --- | --- |
| **A. `node.props.frame`** | A typed object on each freeform child's `props`. |
| B. `node.style` | Extend the existing `NodeStyle` with absolute-positioning fields. |

`node.style` today is the **flow layout** vocabulary (`paddingPx`, `gapPx`, `widthPx`, `heightPx`, `growsToFill`, `align`, `justify`, `flexBasis`). Putting absolute coordinates there would mean every flow consumer must learn to ignore positioning fields, and every absolute consumer must learn to ignore flow fields. Same key (`widthPx`) means two different things depending on the parent type. That is a meaning collision.

### 3.2 Recommendation — `node.props.frame`

Adopt **`props.frame`** on every freeform child. Reasons:

- `frame` is type-specific presentation metadata, like `appearance`. It belongs with the node's behavior, alongside `param`, `label`, etc.
- `style` keeps a single, narrow meaning: flow-layout hints. No collision.
- The validator can require `frame` only when the parent is `freeformLayer`, and reject it otherwise.

### 3.3 Frame schema

```ts
export interface NodeFrame {
  x:           number   // integer, panel-relative pixel offset
  y:           number   // integer
  widthPx:     number   // integer, > 0
  heightPx:    number   // integer, > 0
  rotationDeg?: number  // integer, default 0
  zIndex?:     number   // integer, default 0
  locked?:     boolean  // designer-only; runtime ignores
}
```

### 3.4 Bounds

| Field | Range | Step | Notes |
| --- | --- | --- | --- |
| `x` | `-2000` … `4000` | 1 | Generously larger than any panel; negatives allow off-canvas during drag. |
| `y` | `-2000` … `4000` | 1 | Same rationale. |
| `widthPx` | `1` … `4096` | 1 | Hard upper bound prevents pathological values. |
| `heightPx` | `1` … `4096` | 1 | Same. |
| `rotationDeg` | `-360` … `360` | 1 | Only freely rotatable types (decals, decor*) honor this; others must be `0` (validator soft-clamps). |
| `zIndex` | `0` … `999` | 1 | Per-layer; not globally meaningful. |
| `locked` | boolean | — | Designer prevents drag/resize when true. Runtime ignores. |

### 3.5 What `frame` is not

- Not a CSS string. Never `"left: 10px"`, never `"transform: ..."`.
- Not a percentage or a unit-bearing string. Pure integers, pixel-domain.
- Not a binding source. `frame` cannot be parameter-driven in the first pass.
- Not nested. No `frame.from`, no `frame.responsive`, no media-query-like keys.

### 3.6 Existing flow nodes are unaffected

A `knob` inside a `row` keeps its existing `style` keys (`widthPx`, `align`, etc.) and **must not** carry `frame`. The validator rejects `frame` on any node whose parent is not a `freeformLayer`. That keeps the two modes from cross-contaminating.

---

## 4. Decoration Node Types

All four are **leaves** with closed-vocabulary `props`. None of them accept text/style/class/script keys, raw colors, URLs, or filesystem paths.

### 4.1 `decorText`

| Prop | Type | Notes |
| --- | --- | --- |
| `frame` | `NodeFrame` | Required when inside a freeform layer. |
| `text` | string | Plain text, ≤ 80 chars, no HTML. Validator rejects `<`, `>`, `&` only if they suggest markup; otherwise allowed as literal characters via React text rendering. |
| `variant` | enum `default \| muted \| header \| caption \| value` | Maps to source-controlled CSS classes. |
| `textToken` | `TextTokenId` | From existing `tokenSlots.text.*`. |
| `align` | enum `left \| center \| right` | Default `left`. |
| `letterSpacing` | enum `tight \| normal \| wide \| wider` | Maps to known classes. No raw `em`/`px` input. |

No `font`, `fontFamily`, `fontSize`, `fontWeight`, `style`, `className`, or color-bearing fields.

### 4.2 `decorLine`

| Prop | Type | Notes |
| --- | --- | --- |
| `frame` | `NodeFrame` | Width and height define the bounding box. |
| `orientation` | enum `horizontal \| vertical` | Required. (Diagonal/bezier deferred indefinitely.) |
| `thickness` | enum `hair \| thin \| medium \| thick` | Maps to 1px / 2px / 3px / 4px in source. |
| `strokeToken` | `AccentTokenId \| TextTokenId \| MeterTokenId` | Symbolic id only. |
| `style` (prop, not NodeStyle) | enum `solid \| dashed \| dotted` | Default `solid`. |

The conflict between `props.style` (line style) and `node.style` (flow hints) is real but small: line style lives at `props.style` because it is line-domain data; the existing flow `node.style` is at the node level. To eliminate confusion, the validator and Inspector will refer to it as `lineStyle` in code/UI. The on-disk JSON stores it as `props.lineStyle` (renamed below for clarity):

```json
{ "type": "decorLine", "props": { "frame": {...}, "orientation": "horizontal", "thickness": "hair", "strokeToken": "text.subtle", "lineStyle": "solid" } }
```

### 4.3 `decorShape`

| Prop | Type | Notes |
| --- | --- | --- |
| `frame` | `NodeFrame` | Bounding box of the shape. |
| `shape` | enum `rect \| roundedRect \| circle \| pill` | Required. |
| `cornerRadius` | enum `0 \| 2 \| 4 \| 8 \| 12 \| 16` | Honored only by `roundedRect`. Closed list, not freeform numeric. |
| `fillToken` | `SurfaceTokenId \| AccentTokenId \| 'fill.none'` | `fill.none` is a sentinel meaning "no fill". |
| `strokeToken` | `AccentTokenId \| TextTokenId \| 'stroke.none'` | `stroke.none` means "no stroke". |
| `strokeWidth` | enum `0 \| 1 \| 2 \| 3 \| 4` | `0` implies no stroke regardless of `strokeToken`. |
| `opacity` | enum `25 \| 50 \| 75 \| 100` | Stored as integer percent. Closed enum keeps it discrete. |

### 4.4 `decal`

| Prop | Type | Notes |
| --- | --- | --- |
| `frame` | `NodeFrame` | Bounding box of the decal. |
| `assetId` | string | Must be from the built-in asset registry (Phase Freeform-D) or the user-imported asset registry (Phase Freeform-E). Layout JSON stores **only the symbolic id** like `"builtin.brand.xleth-mark"` or `"user.imported.<uuid>"`. |
| `fit` | enum `contain \| cover \| stretch` | Default `contain`. |
| `opacity` | enum `25 \| 50 \| 75 \| 100` | Same as shape. |
| `tintToken` | `AccentTokenId \| TextTokenId \| 'tint.none'` | Optional, honored only for monochrome assets. Phase Freeform-D may stub this until the asset registry knows which assets are tintable. |

A decal **never** accepts `src`, `href`, `url`, `path`, `filename`, `data`, base64 strings, or anything that smells like a file/URL.

### 4.5 What is not in scope

- No bezier/path drawing.
- No gradients (closed enum tokens only).
- No multi-line rich text.
- No image filters (blur, drop-shadow, hue-rotate). Tinting is a single token swap, not a filter.
- No SVG import.
- No animation/timeline.
- No data binding on decoration props (no live-meter-driven decor in first pass).

---

## 5. Decal Asset Policy

### 5.1 Two options considered

| Option | Description |
| --- | --- |
| **A. Built-in only (first pass)** | Ship a small, source-controlled registry of decal assets bundled with the app. Layout JSON stores `assetId` from the built-in registry. |
| B. User-imported PNG/WebP | Allow the user to import PNG or WebP files from disk. The renderer copies them into `userData/plugin-ui-assets/<uuid>.<ext>`. Layout JSON stores `assetId: "user.imported.<uuid>"`. |

### 5.2 Recommendation — built-in only in Freeform-A through Freeform-D

The first phases ship **built-in decals only**. Reasons:

- No new IPC surface, no asset-copy code, no MIME validation, no file-size enforcement, no userData migration.
- Asset ids in layouts reviewed by other users always resolve, because every reviewer ships the same registry.
- Smallest blast radius for a feature that is already touching schema, validator, runtime, and Designer.

User import is **deferred to Phase Freeform-E**.

### 5.3 Built-in registry shape (Phase Freeform-D)

Create:

```text
ui/src/plugin-ui/appearance/decals/index.js
ui/src/plugin-ui/appearance/decals/<assetId>.png   // or .webp
```

Conceptual data shape:

```js
export const DECAL_REGISTRY = {
  'builtin.divider.thin':       { label: 'Thin Divider',     widthPx: 256, heightPx: 2,  tintable: true,  src: dividerThin },
  'builtin.divider.thick':      { label: 'Thick Divider',    widthPx: 256, heightPx: 4,  tintable: true,  src: dividerThick },
  'builtin.brand.xleth-mark':   { label: 'XLETH Mark',       widthPx: 64,  heightPx: 64, tintable: true,  src: xlethMark },
  'builtin.plate.brushed-sm':   { label: 'Brushed Plate S',  widthPx: 128, heightPx: 64, tintable: false, src: brushedSm },
  'builtin.plate.brushed-md':   { label: 'Brushed Plate M',  widthPx: 256, heightPx: 96, tintable: false, src: brushedMd },
  'builtin.corner.bracket-tl':  { label: 'Bracket TL',       widthPx: 24,  heightPx: 24, tintable: true,  src: bracketTL },
  // ... etc
}
```

The `src` is a developer-authored, bundled image import (handled by Vite). Layout JSON only ever stores `assetId` strings. The actual image binding happens in source.

### 5.4 User-imported assets (Freeform-E, design only)

When this phase ships:

| Constraint | Value |
| --- | --- |
| Allowed MIME | `image/png`, `image/webp` only. |
| Max file size | **1 MB** per asset. |
| Max dimensions | 4096 × 4096 px. |
| Storage | `userData/plugin-ui-assets/<uuid>.<ext>` — copied through main-process IPC, never read at runtime from arbitrary user paths. |
| Asset id format | `user.imported.<uuid>` where `<uuid>` is generated in the main process. |
| Layout JSON content | Only the asset id. No path, no `file://`, no base64. |
| Renderer access | Through a sandboxed IPC handler that returns a `safe-protocol://` URL or a data URL strictly bound to the asset id. |
| SVG | **Forbidden.** First pass and second pass. SVG would require a sanitizer; not in scope. |
| Remote URLs | Forbidden in any phase. |

Asset registry persists in `userData/plugin-ui-assets/index.json` and is loaded once at app start. Removed assets become repairable soft errors, not save-blocking ones, with the Designer offering a "replace with placeholder" remediation.

### 5.5 What never happens

- The Designer has **no URL field, no file-path field, no base64 paste field**, and no drag-drop-from-web. Even in Freeform-E, asset import is a Designer button that opens an Electron file dialog from the main process.
- Layout JSON **never** contains an absolute or relative filesystem path.
- The runtime **never** reads from a path constructed out of user JSON.

---

## 6. Validator Plan

### 6.1 New container rule

`freeformLayer` is added to `ALLOWED_TYPES` and `CONTAINER_TYPES`. Two new constraints:

- A `freeformLayer` may not appear as the root node.
- A `freeformLayer` may not contain another container in the first pass (hard error, repairable by removing the offender). Allowed direct child types: `knob`, `toggle`, `button`, `meter`, `visualizer`, `label`, `spacer`, `decorText`, `decorLine`, `decorShape`, `decal`.

### 6.2 Frame validation

A new `validateFrame(node, parent, errors)` is called from `validateNodeProps`:

1. If `parent.type === 'freeformLayer'`, `props.frame` is **required**. Missing → hard `MISSING_FRAME`.
2. If `parent.type !== 'freeformLayer'`, `props.frame` is **forbidden**. Present → hard `FRAME_NOT_ALLOWED`.
3. Each numeric field must be a finite integer within its bounds (Section 3.4). Out of range → soft `FRAME_OUT_OF_BOUNDS` with clamp to nearest valid value.
4. `widthPx` and `heightPx` must be ≥ 1. Zero/negative → hard `BAD_FRAME_SIZE`.
5. Unknown keys inside `frame` → soft `UNKNOWN_FRAME_KEY`, stripped from sanitized doc.
6. `rotationDeg` non-zero on a node type that does not support rotation (`knob`, `toggle`, `button`, `meter`, `visualizer`, `label`, `spacer`) → soft `ROTATION_NOT_SUPPORTED`, clamped to `0`.

### 6.3 New node-type validation

Each new decoration type gets its own validator entry alongside existing ones:

- `decorText`: required `text` (string ≤ 80 chars), enum `variant`, enum `align`, enum `letterSpacing`, token `textToken` from `text.*` slot group.
- `decorLine`: enum `orientation`, enum `thickness`, enum `lineStyle`, token `strokeToken` from `accent.* | text.* | meter.*`.
- `decorShape`: enum `shape`, enum `cornerRadius`, token `fillToken` (`surface.* | accent.* | 'fill.none'`), token `strokeToken` (`accent.* | text.* | 'stroke.none'`), enum `strokeWidth`, enum `opacity`.
- `decal`: required `assetId` (string, must exist in registry), enum `fit`, enum `opacity`, optional `tintToken`.

### 6.4 Token validation reuse

All new token slot fields plug into the existing `validateAppearanceValue` machinery, extended where necessary:

- Add `'fill.none'` and `'stroke.none'` as pseudo-tokens in `tokenSlots.js`. They resolve to `null` at runtime (no fill / no stroke).
- Add slot-group filter `'fill'` (= `surface.* | accent.*`) and `'stroke'` (= `accent.* | text.* | meter.*`) to the registry compatibility map.

Unknown token id behavior is unchanged from Visual-A: soft `UNKNOWN_APPEARANCE_TOKEN`, fallback resolution.

### 6.5 Asset id validation

- Unknown `assetId` → soft `UNKNOWN_DECAL_ASSET`. Sanitized doc replaces it with `'builtin.placeholder.missing'` (a 1×1 transparent PNG with a faint outline drawn by source code, not by user JSON).
- Asset id that does not match the allowed prefixes (`builtin.*`, `user.imported.*`) → hard `BAD_DECAL_ASSET_ID`.
- Asset ids containing path separators (`/`, `\`), parent-traversal sequences (`..`), or non-printable characters → hard `BAD_DECAL_ASSET_ID`.

### 6.6 Hard save-blocking forbidden keys

These keys are rejected as save-blocking errors anywhere on a freeform/decoration node's `props`, `frame`, or anywhere recursively inside them:

```text
src, href, url, path, filename, file, data, base64, html, innerHTML,
dangerouslySetInnerHTML, script, onClick, onLoad, onError, on*,
style, className, class, css, cssText, sx, ref, key
```

### 6.7 Forbidden values in any string field

Hard save-block on any string prop value that matches:

- Raw color regexes (`#...`, `rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`).
- CSS variable strings (`var(...)`, `--theme-*`).
- URL prefixes (`http://`, `https://`, `file://`, `data:`, `javascript:`, `blob:`).
- HTML markup heuristics (`<script`, `<iframe`, `<img`, `<svg`, `<style`).
- Filesystem path heuristics (Windows drive letters `[A-Za-z]:\\`, leading `\\`, leading `/` for non-asset-id strings, presence of `..`).

These checks run on every string-valued field encountered while walking new decoration nodes, not just designated color fields. The intent is defensive: if a future prop is added that accepts a string, the central check still catches escape attempts.

### 6.8 Repairable summary

Soft (sanitize and continue):

- Unknown frame key.
- Frame value out of bounds.
- Rotation on unsupported type.
- Unknown enum value (replaced with default).
- Unknown token id (replaced with fallback).
- Unknown decal asset id (replaced with placeholder).

Hard (block save):

- Frame on a non-freeform child or missing on a freeform child.
- Negative or zero width/height.
- Forbidden key (`src`, `style`, `className`, etc.).
- Forbidden string value (raw color, URL, HTML, path).
- Bad asset id format.
- Container nested inside `freeformLayer`.

---

## 7. Runtime Renderer Plan

### 7.1 New runtime components

Add under `ui/src/plugin-ui/runtime/components/`:

| File | Purpose |
| --- | --- |
| `FreeformLayerNode.jsx` | Wraps children in a relative-positioned container with explicit `widthPx`/`heightPx`, optional `clip` (overflow hidden), optional `background` token resolution. Sets a CSS variable for the snap grid only when in Designer mode (via context). |
| `DecorTextNode.jsx` | Renders plain text inside an absolutely-positioned div with a known class for variant + letterSpacing and an inline color from `resolveTokenCssVar(textToken)`. Text content is rendered as React text (auto-escaped). |
| `DecorLineNode.jsx` | Renders a 1-element div with `borderTop` or `borderLeft` resolved from enum thickness + lineStyle + token. |
| `DecorShapeNode.jsx` | Renders a div with known classes for `shape`/`cornerRadius` and `background-color` / `border-color` resolved from tokens. Circles use `border-radius: 50%`; pills use `border-radius: 9999px`. No SVG. |
| `DecalNode.jsx` | Renders an `<img>` with `src` from the **registry-resolved** image URL, `object-fit` from enum `fit`, `opacity` from enum, optional CSS `filter: drop-shadow(...)` is **not** used; tinting is via `mask-image` + `background-color` only on tintable assets. |

### 7.2 Frame application

A shared helper `applyFrameStyle(frame)` produces a closed-shape style object:

```js
function applyFrameStyle(frame) {
  const { x, y, widthPx, heightPx, rotationDeg = 0, zIndex = 0 } = frame
  return {
    position: 'absolute',
    left:   `${x}px`,
    top:    `${y}px`,
    width:  `${widthPx}px`,
    height: `${heightPx}px`,
    transform: rotationDeg ? `rotate(${rotationDeg}deg)` : undefined,
    transformOrigin: rotationDeg ? '50% 50%' : undefined,
    zIndex,
  }
}
```

All values are numeric. Strings are template-built from numbers, never spliced from JSON. The function is unit-testable as a pure transform.

### 7.3 Layer application

`FreeformLayerNode.jsx` outline:

```jsx
<div
  className="pluginui-freeform"
  style={{
    position: 'relative',
    width:  layerWidth,
    height: layerHeight,
    overflow: clip === 'panel' ? 'hidden' : 'visible',
    background: backgroundCssVarOrUndefined,
  }}
>
  {children.map(renderChild)}
</div>
```

`renderChild` wraps each child component with `applyFrameStyle(node.props.frame)` on a positioning div, then renders the inner component (knob, decor*, etc.) inside that div with no frame awareness:

```jsx
<div style={applyFrameStyle(node.props.frame)} key={node.id}>
  <Component node={node} />
</div>
```

This keeps existing leaf components (e.g. `KnobNode`) unchanged. They render at `100% × 100%` of their positioning wrapper, so a knob inside a freeform layer respects its `frame.widthPx` / `frame.heightPx` automatically.

### 7.4 Token resolution

Reuse Visual-A's `resolveTokenCssVar(tokenId)` and `resolveTokenValue(tokenId)`. New pseudo-tokens (`fill.none`, `stroke.none`, `tint.none`) resolve to `null`, and the renderer omits the corresponding CSS property entirely when null.

### 7.5 Decal rendering and tinting

```jsx
<img
  src={DECAL_REGISTRY[node.props.assetId].src}
  alt=""
  style={{
    width:  '100%',
    height: '100%',
    objectFit: node.props.fit,
    opacity: node.props.opacity / 100,
    pointerEvents: 'none',
    userSelect: 'none',
    draggable: false,
  }}
/>
```

When `tintToken` is present and the asset is `tintable`, render a `<div>` with `mask-image: url(<src>)`, `background-color: var(<resolved>)`, and `mask-size: 100% 100%` instead of the plain `<img>`. Both branches receive the same numeric frame styling from the wrapper.

### 7.6 Runtime never does

- Inject any CSS string from layout JSON.
- Use `dangerouslySetInnerHTML` anywhere.
- Read filesystem paths from layout JSON.
- Concatenate user strings into URLs or class names.
- Honor `props.style`, `props.className`, or any forbidden key (validator already strips them, but runtime must not look for them).

### 7.7 Designer mode hooks

`FreeformLayerNode` reads a Designer mode flag from a context (already available for Designer preview rendering). When in Designer mode, it adds a faint grid overlay (drawn with `background-image: repeating-linear-gradient(...)` using known token colors only) and a 1-px outline. In runtime mode, neither is rendered.

---

## 8. Designer Interaction Plan

### 8.1 Selection overlay

Add `ui/src/plugin-ui/designer/SelectionOverlay.jsx`. It is rendered on top of `DesignerPreview` whenever the currently selected node is a freeform child.

Behaviors in the first pass:

- **Select**: clicking a freeform child in the preview selects it (already supported for the tree; this extends it to the visual surface).
- **Drag**: drag the body to translate. Updates `frame.x` / `frame.y` live.
- **Resize**: 4 corner handles + 4 edge handles. Drags update `frame.widthPx` / `frame.heightPx` and, for corner/edge drags from top or left, also `frame.x` / `frame.y` so the opposite corner stays fixed.
- **Lock**: when `frame.locked === true`, no drag/resize handles render; the bounding box renders dim.

Out of scope for the first pass: **multi-select**, **rotation handles**, **bezier**, **timeline animation**, **alignment guides between siblings**.

### 8.2 Drag/resize math as pure functions

Implement under `ui/src/plugin-ui/designer/freeformGeometry.js`:

```js
export function dragFrame(frame, deltaXPx, deltaYPx, opts) { ... }
export function resizeFrame(frame, handle, deltaXPx, deltaYPx, opts) { ... }
export function snapValue(value, gridPx, enabled) { ... }
export function clampFrame(frame) { ... }
```

These are all pure, deterministic, integer-domain functions. They are the unit of testing for drag/resize behavior; the React handler layer is a thin coordinate-translation wrapper around them.

### 8.3 Inspector — Frame section

Add `ui/src/plugin-ui/designer/inspectors/FrameFields.jsx`. Renders only when the selected node lives inside a `freeformLayer`:

- Numeric inputs (typed-as-number, integer, clamped) for: `x`, `y`, `widthPx`, `heightPx`, `zIndex`.
- Stepper buttons (±1, ±10) beside each.
- A `Locked` checkbox.
- A read-only "rotation" line in the first pass; rotation control deferred until the user explicitly asks. (For decoration nodes, an enum dropdown `0° / 90° / 180° / 270°` is acceptable as a stretch goal in Freeform-C if cheap.)

### 8.4 Inspector — type-specific decoration inspectors

Add inspectors mirroring the existing pattern (`KnobInspector`, etc.):

- `DecorTextInspector.jsx` — text input (length-capped), enum dropdowns for `variant`, `align`, `letterSpacing`, token dropdown for `textToken`.
- `DecorLineInspector.jsx` — enum dropdowns for `orientation`, `thickness`, `lineStyle`, token dropdown for `strokeToken`.
- `DecorShapeInspector.jsx` — enum dropdowns for `shape`, `cornerRadius`, `strokeWidth`, `opacity`, token dropdowns for `fillToken` and `strokeToken`.
- `DecalInspector.jsx` — `assetId` picker (a grid of thumbnails from `DECAL_REGISTRY`, no URL/file input), enum dropdowns for `fit`, `opacity`, optional `tintToken`.

### 8.5 Palette additions

Extend `paletteCatalog.js` with:

```js
{
  type: 'freeformLayer',
  label: 'Freeform Layer',
  template: { type: 'freeformLayer', style: { widthPx: 480, heightPx: 160 }, props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' }, children: [] }
},
{
  type: 'decorText',
  label: 'Text',
  template: { type: 'decorText', props: { frame: { x: 16, y: 16, widthPx: 120, heightPx: 18 }, text: 'Text', variant: 'default', align: 'left', letterSpacing: 'normal', textToken: 'text.primary' } }
},
{
  type: 'decorLine',
  label: 'Line',
  template: { type: 'decorLine', props: { frame: { x: 16, y: 16, widthPx: 120, heightPx: 1 }, orientation: 'horizontal', thickness: 'hair', lineStyle: 'solid', strokeToken: 'text.subtle' } }
},
{
  type: 'decorShape',
  label: 'Shape',
  template: { type: 'decorShape', props: { frame: { x: 16, y: 16, widthPx: 64, heightPx: 64 }, shape: 'roundedRect', cornerRadius: 4, fillToken: 'surface.controlRaised', strokeToken: 'stroke.none', strokeWidth: 0, opacity: 100 } }
},
{
  type: 'decal',
  label: 'Decal',
  template: { type: 'decal', props: { frame: { x: 16, y: 16, widthPx: 64, heightPx: 64 }, assetId: 'builtin.placeholder.missing', fit: 'contain', opacity: 100 } }
},
```

The palette inserts a new node either:

- Into the currently selected `freeformLayer` (if any), positioned at the layer's top-left + 16/16 offset, or
- Into a new `freeformLayer` if the user explicitly chose "Freeform Layer".

Decoration types inserted while no freeform layer is selected fall back to the same behavior as inserting any other leaf with no parent: the Designer disallows the drop and shows a hint ("Decoration nodes must live inside a Freeform Layer").

### 8.6 Tree affordance

In the layout tree panel, a `freeformLayer` shows a distinct icon to make the mode visible at a glance. Children of a freeform layer show their `frame.x`/`frame.y` in a small badge. Both are read-only in the tree; editing happens in the Inspector or via direct drag on the preview.

### 8.7 Right-click and tree buttons

Out of scope for first pass. Selection + drag + Inspector is enough. Reorder z-index can happen via the Inspector `zIndex` field initially.

---

## 9. Snapping & Nudge Behavior

### 9.1 Grid snapping

- Grid sizes: `1`, `2`, `4`, `8`, `16` px. Stored on the freeform layer at `props.snap.gridPx`. Default `8`.
- Snap is applied in **Designer drag/resize math**, not at validation time and not at render time. The runtime renders whatever frame values are saved.
- Snap is global per-layer in the first pass; not per-node. A single layer cannot mix snap sizes for different children.

### 9.2 Modifier keys

| Modifier | Behavior |
| --- | --- |
| (none) | Snap to grid if `props.snap.enabled`. |
| **Alt** held during drag/resize | Temporarily disables snapping; freehand integer movement. |
| **Shift** held during drag | Constrains drag to one axis (the axis with the larger initial delta). |
| **Shift** held during resize from corner | Preserves aspect ratio. |
| **Arrow keys** with selection | Nudge by 1 px on x or y (`frame.x`/`frame.y`). |
| **Shift + Arrow** | Nudge by 10 px. |
| **Alt + Arrow** | Nudge by `gridPx` (snap-step nudge). |

Multi-select-aware modifiers are out of scope. The handlers operate on a single selected node only.

### 9.3 Snap-to-other-nodes

Out of scope for the first pass. Listed here so that future work has a name: `snap.peers: true` would enable sibling-edge snapping with a pixel tolerance. Defer until basic placement is stable.

### 9.4 Where snapping does **not** apply

- Inspector numeric input commits exact integers regardless of snap state.
- Imported layouts are rendered exactly as saved; the Designer does not auto-snap on load.

---

## 10. Migration Strategy

### 10.1 No automatic conversion

The shipped Compressor layout (`ui/src/plugin-ui/layouts/compressor.json`) is **not** auto-migrated to a freeform layout in any phase of this plan. Existing rows/columns/groups stay in flow mode.

### 10.2 Opt-in usage

The first realistic use case is **decorative additions** alongside the existing flow controls:

- A `freeformLayer` placed inside an existing `panel` or `group` to overlay a brand decal in a corner.
- A `freeformLayer` between two `row`s containing a divider line and a section caption.
- A `freeformLayer` that contains a single decorative backplate behind a meter cluster (this requires the layer to use `clip: visible` or live above the cluster with `pointer-events: none`; see open question 13.3 below).

### 10.3 Eventual full-freeform faceplate

A later, separate phase (not in this plan) may:

- Add a "Convert group to freeform" Designer action that walks the immediate children of a `group`, computes their measured rect from a current preview render, and emits a new `freeformLayer` with frames pre-populated.
- That conversion is a one-way action with explicit user confirmation and remains out of scope here.

### 10.4 Backward compatibility

- Layouts without `freeformLayer` continue to validate and render identically.
- Layouts with `freeformLayer` declare `schemaVersion: 1` (no version bump) because the new container/leaf types are additions, not breaking changes. Older renderers on the same machine should not exist; if they did, they would soft-flag unknown types and skip them — acceptable degraded behavior, not a corruption risk.
- `props.frame` is rejected on non-freeform children, so a flow-only renderer that ignores `frame` would produce subtly wrong layouts. Validator catches this at the source, so it never reaches a renderer.

---

## 11. Implementation Phases

### Phase Freeform-A — Schema, validator, runtime passive rendering

**Add:**

- `ui/src/plugin-ui/runtime/components/FreeformLayerNode.jsx`
- `ui/src/plugin-ui/runtime/components/DecorTextNode.jsx`
- `ui/src/plugin-ui/runtime/components/DecorLineNode.jsx`
- `ui/src/plugin-ui/runtime/components/DecorShapeNode.jsx`
- `ui/src/plugin-ui/runtime/components/DecalNode.jsx` (uses placeholder asset only — no registry yet)
- `ui/src/plugin-ui/runtime/freeformGeometry.js` (pure helpers including `applyFrameStyle`)
- `ui/src/plugin-ui/appearance/decals/placeholder.js` (single placeholder asset)

**Update:**

- `ui/src/plugin-ui/schema/types.ts` (add `FreeformLayerProps`, `NodeFrame`, `DecorText/Line/Shape/Decal` props)
- `ui/src/plugin-ui/schema/validate.js` (new container handling, frame validation, decoration node validation, asset id validation, forbidden key/value scanning)
- `ui/src/plugin-ui/runtime/registry.js` (register new components)
- `ui/src/plugin-ui/appearance/tokenSlots.js` (add `fill.none`, `stroke.none`, `tint.none` pseudo-tokens; add slot-group filters)

**Acceptance:**

- A hand-authored layout containing a `freeformLayer` with each of the four decoration types renders correctly in the existing renderer.
- All forbidden keys/values are blocked at save by the validator, with focused unit tests.
- Existing Compressor layout still validates unchanged.

### Phase Freeform-B — Designer palette + Inspectors

**Add:**

- `ui/src/plugin-ui/designer/inspectors/FrameFields.jsx`
- `ui/src/plugin-ui/designer/inspectors/DecorTextInspector.jsx`
- `ui/src/plugin-ui/designer/inspectors/DecorLineInspector.jsx`
- `ui/src/plugin-ui/designer/inspectors/DecorShapeInspector.jsx`
- `ui/src/plugin-ui/designer/inspectors/DecalInspector.jsx`

**Update:**

- `ui/src/plugin-ui/designer/paletteCatalog.js` (Freeform Layer + 4 decoration entries)
- `ui/src/plugin-ui/designer/InspectorPanel.jsx` (route to the new inspectors and FrameFields)
- `ui/src/plugin-ui/designer/LayoutTreePanel.jsx` (icon and frame badge)

**Acceptance:**

- User can drag a freeform layer from the palette into the layout, then drag decoration nodes into it.
- Inspector shows frame fields and type-specific decoration controls.
- All token/asset selection is via dropdown/grid; no text input for color or asset path.

### Phase Freeform-C — Selection overlay (drag, resize, nudge, snap)

**Add:**

- `ui/src/plugin-ui/designer/SelectionOverlay.jsx`
- `ui/src/plugin-ui/designer/freeformGeometry.js` (drag/resize/snap pure helpers)

**Update:**

- `ui/src/plugin-ui/designer/DesignerPreview.jsx` (mount overlay; capture pointer events for selected freeform child)
- `ui/src/plugin-ui/designer/usePluginUIDesignerStore.js` (drag/resize commit reducers, integrated with undo/redo)

**Acceptance:**

- Drag from preview surface translates the selected node.
- Corner/edge handles resize correctly with grid snap.
- Arrow keys nudge; Shift = ±10; Alt disables snap.
- All operations integrate with existing undo/redo.

### Phase Freeform-D — Decal asset registry (built-ins)

**Add:**

- `ui/src/plugin-ui/appearance/decals/index.js` (registry)
- A small bundled set of source-controlled built-in decals (PNG/WebP).

**Update:**

- `DecalNode.jsx` (resolve real assets from the registry, including tintable assets via mask-image)
- `DecalInspector.jsx` (asset-id grid populated from registry)
- Validator (richer asset id validation now that registry exists)

**Acceptance:**

- Five-or-so built-in decals usable from the Inspector grid.
- Tintable decals respond to `tintToken`.
- Unknown asset ids fall back to the placeholder.

### Phase Freeform-E — User-imported PNG/WebP decals (deferred)

Not in this plan's first deliverable. Specified at Section 5.4. Plan deliverable for Freeform-E would be a separate document that defines the IPC surface, the userData asset index, and the safe-protocol URL strategy.

### Phase Freeform-F — Manual Electron pass + UX polish

- Manual visual pass under both light/dark themes.
- Verify clipping, z-index, rotation transform-origin, decal pixel sharpness.
- Verify keyboard nudge and snap interactions feel right.
- Verify that placing a freeform layer inside an existing flow group does not break the parent's flow.

---

## 12. Test Plan

### 12.1 Validator tests

Add in `ui/src/plugin-ui/schema/__tests__/`:

- Accepts a `freeformLayer` with each new child type and a valid `frame`.
- Rejects `freeformLayer` as the root.
- Rejects a container nested inside `freeformLayer`.
- Rejects a `frame` on a flow child (e.g., a knob inside a row).
- Rejects a freeform child with no `frame`.
- Soft-clamps `frame.x`/`frame.y` when out of bounds, sanitized doc has clamped values.
- Hard-rejects `widthPx <= 0` or `heightPx <= 0`.
- Hard-rejects `rotationDeg` on unsupported types **only as a soft clamp** (per Section 6.2 #6); rotation that would produce non-integer or out-of-range values is hard-rejected.
- Hard-rejects forbidden keys: `src`, `href`, `url`, `style`, `className`, `html`, `script`, `path`, `data`, etc.
- Hard-rejects forbidden string values: hex/RGB/HSL colors, `var(...)`, `--theme-*`, `http(s)://`, `file://`, `data:`, `javascript:`, `<script`, Windows drive letters, `..` traversal.
- Soft-rejects unknown enum values for `variant`, `align`, `letterSpacing`, `orientation`, `thickness`, `lineStyle`, `shape`, `cornerRadius`, `strokeWidth`, `opacity`, `fit`.
- Soft-rejects unknown token id and unknown `assetId`; sanitized doc has fallback values.

### 12.2 Geometry helper tests

In `ui/src/plugin-ui/runtime/__tests__/freeformGeometry.test.js`:

- `applyFrameStyle` returns expected style object for representative inputs.
- `applyFrameStyle` omits `transform` when `rotationDeg === 0`.
- `applyFrameStyle` always returns numeric pixel strings; never produces `undefined`/`NaN`/`null` in numeric fields.

### 12.3 Drag/resize math tests

In `ui/src/plugin-ui/designer/__tests__/freeformGeometry.test.js`:

- `dragFrame` translates by integer deltas.
- `dragFrame` snaps to grid when enabled and `gridPx > 1`.
- `dragFrame` does not snap when Alt is held (passed as `opts.bypassSnap`).
- `resizeFrame` from each of the 8 handles produces correct `{x, y, widthPx, heightPx}`.
- `resizeFrame` from a top/left handle keeps the opposite corner pixel-anchored.
- `resizeFrame` with Shift preserves aspect ratio when dragging from a corner.
- `resizeFrame` clamps to `widthPx >= 1` and `heightPx >= 1`.
- `snapValue(7, 8, true) === 8` and `snapValue(13, 8, true) === 16` and `snapValue(7, 8, false) === 7`.

### 12.4 Token validation tests

- New pseudo-tokens (`fill.none`, `stroke.none`, `tint.none`) accepted in the right slots and rejected in the wrong ones.
- Slot-group filters (`fill`, `stroke`) accept the right `surface.*`/`accent.*`/`text.*`/`meter.*` ids.
- Raw color in any decoration token field hard-rejects.

### 12.5 Runtime render tests

In `ui/src/plugin-ui/runtime/__tests__/`:

- Rendering a `freeformLayer` produces a relative-positioned wrapper with the declared dimensions.
- Each freeform child renders inside an absolute-positioned wrapper with the declared frame.
- A knob inside a freeform layer receives `100% × 100%` of its frame.
- A `decal` with a known `assetId` renders an `<img>`/mask wrapper with the registered asset.
- A `decal` with `'builtin.placeholder.missing'` renders the placeholder.
- A `decorShape` with `fillToken: 'fill.none'` does not set `background-color`.
- A `decorLine` with `orientation: horizontal` produces a `border-top` style; `vertical` produces `border-left`.
- A `decorText` with `letterSpacing: 'wide'` applies the `pluginui-text--ls-wide` class (or whichever class is registered) and resolves `textToken` to a CSS variable.

### 12.6 Designer mutation tests

In `ui/src/plugin-ui/designer/__tests__/`:

- Dropping a Freeform Layer palette entry creates a layer with default props.
- Dropping a decoration leaf into a freeform layer creates a child with a default frame.
- Dropping a decoration leaf with no freeform layer selected is rejected by the action and shows the expected hint.
- Frame inputs commit integer values and clamp to bounds.
- Locked frame disables drag/resize handles in the overlay.
- Undo/redo round-trips drag, resize, and Inspector edits.

### 12.7 Manual Electron pass

1. Open Compressor.
2. Open Designer.
3. Add a Freeform Layer above the existing knob group.
4. Drop a Text node into it; set `text` to "DYNAMICS"; set `variant: header`; set `letterSpacing: wide`; set `textToken: text.muted`.
5. Drop a Line node directly under the text; set `thickness: hair`; set `strokeToken: text.subtle`.
6. Drop a Shape node behind the existing meters; set `shape: roundedRect`, `cornerRadius: 4`, `fillToken: surface.inset`, `opacity: 50`. Use `zIndex: 0` and place meters above with overlapping geometry to verify layering.
7. Use arrow keys, Shift+arrow, Alt+arrow to verify nudge sizes.
8. Drag and resize with corner/edge handles. Toggle `props.snap.enabled` and re-test.
9. Toggle `Locked` on a node and confirm handles disappear.
10. Save and reload — confirm geometry round-trips bit-for-bit.
11. Hand-edit the saved layout to insert a forbidden value (`accentToken: "#ff006a"`, `src: "http://..."`, `style: "..."`) and confirm validator blocks save and Designer surfaces the error.
12. Confirm existing rows/columns/knobs above and below the freeform layer remain unchanged.

---

## 13. Open Questions / Notes Before Implementation

These are not blockers; they are decisions that should be made during Freeform-A implementation rather than re-litigated in design.

1. **`props.lineStyle` vs `props.style`** — the conflict between line-style enum and `node.style` is resolved by naming the prop `lineStyle` in JSON. Confirm during implementation that no validator path treats `props.style` as a synonym.
2. **Rotation transform-origin** — fixed at `50% 50%` for the first pass. If users want anchored rotation later, a `rotateAnchor` enum can be added without changing existing data.
3. **Pointer-events on decals/shapes that overlay controls** — by default decals/shapes set `pointer-events: none` so an overlapping knob remains interactive. A future `interactive: true` flag can opt back in if a designer needs a clickable decoration; deferred for now.
4. **z-index across siblings of a freeform layer** — `zIndex` is layer-local. A shape placed inside layer A cannot stack above content rendered by layer B's sibling row. Acceptable for the first pass; document this in the Designer help text.
5. **Default layer size when dropped** — chose 480×160 px because that fits the Compressor panel comfortably. Adjust during Freeform-B if Compressor preview is significantly different.
6. **Built-in decal naming convention** — `builtin.<group>.<name>` is the proposed shape (`builtin.divider.thin`, `builtin.brand.xleth-mark`). Lock this in Freeform-D so layouts never reference a renamed asset.
7. **Where Compressor adopts freeform** — defer until after Freeform-C. The Compressor layout should remain pure flow until the Designer interaction story is proven.

---

## 14. Exact Next Implementation Prompt — Freeform-A Only

Use this prompt verbatim for the next implementation pass:

> Implement **Phase Freeform-A only** from `docs/dev/plugin-ui-freeform-decoration-plan.md` for the Compressor stock plugin UI. Do not implement Designer palette, Inspectors, selection overlay, drag/resize, snap behavior, the built-in decal asset registry, user-imported decals, or any non-Compressor migration.
>
> **Add:**
>
> - `ui/src/plugin-ui/runtime/components/FreeformLayerNode.jsx`
> - `ui/src/plugin-ui/runtime/components/DecorTextNode.jsx`
> - `ui/src/plugin-ui/runtime/components/DecorLineNode.jsx`
> - `ui/src/plugin-ui/runtime/components/DecorShapeNode.jsx`
> - `ui/src/plugin-ui/runtime/components/DecalNode.jsx` (placeholder asset only — no registry yet)
> - `ui/src/plugin-ui/runtime/freeformGeometry.js` (pure `applyFrameStyle` helper)
> - `ui/src/plugin-ui/appearance/decals/placeholder.js` (single placeholder asset, source-controlled)
>
> **Update:**
>
> - `ui/src/plugin-ui/schema/types.ts` — add `FreeformLayerProps`, `NodeFrame`, `DecorText/Line/Shape/Decal` prop interfaces; add `freeformLayer`, `decorText`, `decorLine`, `decorShape`, `decal` to the `NodeType` union.
> - `ui/src/plugin-ui/schema/validate.js` — add `freeformLayer` container handling, `validateFrame`, decoration node validators, asset id validation, forbidden key/value scanning.
> - `ui/src/plugin-ui/runtime/registry.js` — register the five new runtime components.
> - `ui/src/plugin-ui/appearance/tokenSlots.js` — add `fill.none`, `stroke.none`, `tint.none` pseudo-tokens; add slot-group filters `fill` and `stroke`.
>
> **Requirements:**
>
> 1. `freeformLayer` is a new container type. Allowed direct children: existing leaves (`knob`, `toggle`, `button`, `meter`, `visualizer`, `label`, `spacer`) and the four new decoration leaves. No nested containers, including no nested `freeformLayer`.
> 2. `props.frame: { x, y, widthPx, heightPx, rotationDeg?, zIndex?, locked? }` is **required** on every freeform child and **forbidden** on every flow child. All numeric fields are integers within the bounds in Section 3.4.
> 3. `freeformLayer.props` accepts only `snap.gridPx` (enum `1|2|4|8|16`), `snap.enabled` (bool), `background` (enum `transparent|panel|inset`), `clip` (enum `panel|visible`).
> 4. Decoration node prop sets are exactly as specified in Sections 4.1–4.4. The line-style prop is named `props.lineStyle`, not `props.style`.
> 5. Validator rejects save on:
>    - frame on a non-freeform child or missing on a freeform child,
>    - widthPx/heightPx ≤ 0,
>    - any of these keys appearing anywhere in a freeform/decoration node's props or frame: `src`, `href`, `url`, `path`, `filename`, `file`, `data`, `base64`, `html`, `innerHTML`, `dangerouslySetInnerHTML`, `script`, `style`, `className`, `class`, `css`, `cssText`, `sx`, `ref`, `key`, any `on*` event handler key,
>    - any string value matching: hex/RGB/HSL/HSLA color, `var(...)`, `--theme-*`, `http(s)://`, `file://`, `data:`, `javascript:`, `blob:`, HTML markup heuristics (`<script`, `<iframe`, `<img`, `<svg`, `<style`), Windows drive letters, leading absolute paths, `..` traversal,
>    - `assetId` outside the allowed prefixes (`builtin.*`, `user.imported.*`) or containing path separators / non-printable characters,
>    - `freeformLayer` as the root, or a container nested inside a `freeformLayer`.
> 6. Validator soft-flags (and sanitizes) on:
>    - frame value out of bounds (clamped),
>    - rotation on a type that does not support it (clamped to 0),
>    - unknown enum values (replaced with the documented default),
>    - unknown token id (replaced with fallback),
>    - unknown `assetId` (replaced with `'builtin.placeholder.missing'`),
>    - unknown frame keys (stripped),
>    - unknown decoration props (stripped).
> 7. Runtime renderer:
>    - `FreeformLayerNode` wraps children in a relative-positioned div with explicit `widthPx`/`heightPx` and optional clipping.
>    - Each freeform child is wrapped in an absolute-positioned div produced by `applyFrameStyle(frame)`.
>    - Numeric values flow as numbers; styles are template-built from numbers, never spliced from JSON strings.
>    - No `dangerouslySetInnerHTML` anywhere.
>    - Decoration components apply known classes for enum values and resolve token ids through the existing `tokenSlots`.
>    - `DecalNode` renders only the source-controlled placeholder asset in this phase.
> 8. The shipped Compressor layout (`ui/src/plugin-ui/layouts/compressor.json`) must continue to validate unchanged.
> 9. Add focused tests:
>    - validator: required/forbidden frame, container nesting rule, all forbidden keys, all forbidden string values, all soft-clamping cases (geometry, rotation, enum, token, asset),
>    - geometry: `applyFrameStyle` correctness including no `transform` when rotation is `0`,
>    - runtime: rendering each new component with valid props produces the documented output structure (snapshot or structural assertions, not visual screenshots).
>
> **Constraints:**
>
> - No Designer palette/Inspector/overlay changes.
> - No drag/resize math.
> - No snap behavior.
> - No real decal assets beyond the placeholder.
> - No user-imported decals.
> - No raw colors, no raw CSS strings, no JSX/CSS generation.
> - No SVG, no remote URLs, no filesystem paths in JSON.
> - Do not touch C++ or `bridge/src/XlethAddon.cpp`.
> - Do not migrate Limiter/Transient/Overdone.
> - Do not modify the shipped Compressor layout.
>
> When finished, report changed files and test results. If a test command cannot run in the sandbox, explain why and list the unrun tests.

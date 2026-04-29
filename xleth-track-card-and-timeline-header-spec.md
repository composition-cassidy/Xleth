# Xleth track card + timeline header redesign spec

**Version:** 1.0
**Status:** spec approved, implementation pending
**Owner:** Krasen
**Scope:** Wave 2 of pre-beta polish. UI-only redesign of the Grid Settings track card and the Timeline track header strip. No engine, IPC, or track data model changes.
**Companion docs:** `xleth-theming-spec.md` (Wave 0, ships separately), `xleth-windowing-spec.md` (Wave 1, ships separately)
**Depends on:** none — this work is independent and can land before or after Wave 0/1.

---

## 1. Overview

Two adjacent UI surfaces are currently failing user-friendliness sniff tests:

- **Grid Settings track card.** The card mixes three top-level toggles (Bounce, Zoom/Pan/Rot, Ping-Pong Loop) with a separate Visual FX dropdown + chain list, plus Corner Radius, Custom Gap, and Slide Note Effect. The result is a tall, visually disorganized stack with no hierarchy. The Corner Radius slider is the only control exposing a value the user can't visualize without watching the grid update in real time.

- **Timeline track header strip.** Names truncate aggressively because M / S / V buttons are oversized. The "V" letter is opaque to users who haven't read the docs (it means "visual only" — audio muted, video plays). The column has no resize affordance.

This spec consolidates both into one redesign because they share patterns (the M / S / V button cluster appears in both contexts via different code paths) and aesthetics that should stay coherent across panels.

The redesign is **UI-only**. The engine, IPC bridge, and Zustand store contracts are untouched. The data model stays exactly as the diagnostic found it: Bounce / ZPR / PingPong as top-level track properties, chainable shader effects in `track.visualEffectChain`. The new Visual FX section in the card unifies these visually but routes adds and toggles to whichever data path each effect already lives on.

This work happens before the theming wave ships, so colors stay hardcoded matching the current Xleth aesthetic. The theming Phase 0 audit pass will migrate every value introduced by this spec to tokens — that's expected, not a problem.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Scope unification | One spec covers both surfaces (track card and timeline header) |
| Engine changes | None |
| IPC changes | None |
| Data model changes | None — Bounce / ZPR / PingPong stay as top-level track properties |
| UI unification | Visual FX section in the card visually combines non-chainable behaviors with chainable shader effects, separated by an unlabeled divider |
| Non-chainable group | Bounce, Zoom/Pan/Rot, Ping-Pong Loop. Single instance per track. ◇ glyph in the list. |
| Chainable group | Existing `visualEffectChain` entries (Desaturation, Tint, Brightness & Contrast, TV Simulator, ZPR-as-shader-effect). Multi-instance allowed (engine already supports duplicates). ● glyph in the list. |
| Effect row default state | Collapsed |
| Effect row expanded UI | Inline panel below header, params shown in a labeled grid |
| Effect row collapsibility | Smart — rows with no expandable params (e.g. Ping-Pong Loop has only a single toggle... wait, it has 5 sub-params per the diagnostic; revisit during implementation) show no chevron |
| Reorder grips | Present on both groups. Drag-to-reorder changes processing order in chainable group; cosmetic only in non-chainable group |
| Add-effect dropdown | Two-group dropdown with non-chainable above an unlabeled divider, chainable below. Already-added non-chainable items render greyed with checkmark and are non-clickable |
| Already-added chainable items | Stay clickable in dropdown — adding a duplicate prompts confirm (existing behavior, preserved) |
| Clear-all button | Small "clear all" link in Visual FX section header, right-aligned, only visible when section count > 0. Replaces the existing "Reset Visual FX" button |
| Mute icon | `lucide-react`'s `VolumeX`. The uploaded `audio-speaker-off-svgrepo-com.svg` file stays orphaned — not used. |
| M / S button labels | Stay as letters. M = mute everything, S = solo. Universal DAW convention. |
| Timeline button size | 22×22px |
| Timeline name behavior | Truncate with ellipsis; native `title` attribute for full-name tooltip on hover |
| Timeline column resize | Draggable border on the right edge of the track-header column. Width persists in a UI Zustand store (session-scoped for now) |
| Component extraction | `GridLayoutTab.jsx` (1044 lines) split into multiple components as part of this work |
| Slide Note Effect | Stays as its own section below Visual FX. Restyled to match new aesthetic. Not folded into the unified FX list. |
| CHORUS pill click | No interaction added in this spec. Preserved as a read-only badge. |

## 3. Background: data model reality

The diagnostic established the actual track shape. Reproduced verbatim for spec reference:

```javascript
{
  id: number,
  name: string,
  type: 'Clip' | 'Pattern',
  muted: boolean,
  solo: boolean,
  visualOnly: boolean,
  volume: number, pan: number, stereoSpread: number,
  cornerRadius: number,             // 0–0.5
  gapScaleOverride: number,         // -1 = global, 0+ = custom
  bounce:      { enabled, directionDeg, distance, durationMs, squashAmount, overshoot, repeatCount, easingType },
  zoomPanRot:  { enabled, startZoom, targetZoom, startPanX, startPanY, targetPanX, targetPanY,
                 startRotation, targetRotation, durationMs, zoomEasing, panEasing, rotEasing, overshoot },
  pingPong:    { enabled, regionStartPct, regionEndPct, crossfadeFrames, reverseSpeed, maxLoops },
  slideNoteEffect: { type, durationMode, fixedDurationMs, /* ...delta params */ },
  visualEffectChain: Array<{ type, bypassed, params: number[] }>,
  videoHoldLastFrame: boolean,
}
```

Routing rules for the new UI:

- **Picking a non-chainable effect from the dropdown** sets `track[fieldName].enabled = true` for the corresponding top-level field. It does NOT push onto `visualEffectChain`.
- **Picking a chainable effect from the dropdown** pushes a new entry onto `track.visualEffectChain` using the existing `VFX_DEFAULTS[id]` template. (Existing behavior — preserve.)
- **Toggling a non-chainable row's enable checkbox** sets `track[fieldName].enabled`. It does NOT remove the row from the section — disabled rows stay visible, just dimmed.
- **Toggling a chainable row's enable checkbox** sets `entry.bypassed`. Same dimming pattern.
- **Removing (× button) a chainable row** splices the entry out of `visualEffectChain`.
- **Removing (× button) a non-chainable row** sets `track[fieldName].enabled = false`. The row stays visible if it was added once (showing the params) — only the dropdown re-add is gated. Wait, re-think: the row should disappear if explicitly removed via ×. Otherwise the dropdown logic ("greyed if added") gets weird. Locked decision: × on non-chainable removes from view AND sets `enabled = false`. Adding it again from the dropdown re-shows the row with current saved params (params are not reset — they persist on the track regardless of whether the row is "shown"). Edge case to handle in implementation: `track.bounce` always has a value even when "removed"; the UI just tracks "is this row currently displayed in the FX section."

Implication of that last rule: the Visual FX section needs a UI-state list of which non-chainable rows are currently "shown." This is **not** the same as `enabled`. A row can be shown but disabled (enabled=false but still visible because it hasn't been × removed). The shown-list lives in component state, not the engine.

⚠ NOTE for implementer: if a track loads with `track.bounce.enabled === true` but the section's shown-list doesn't include `bounce`, the row should be auto-shown on first render. Default the shown-list to "any non-chainable field currently `.enabled`" on track load.

## 4. Track card — Grid Settings

The card sits inside the existing `GridLayoutTab` panel, one card per track. Width and parent layout are unchanged.

### 4.1 Header row

```
[track name]  [type badge]                    [unassigned label]   [CHORUS pill]
```

- Track name: 15px / weight 500. Editable via double-click (preserve current behavior — already in `TrackHeader.jsx`, replicate the pattern here).
- Type badge: 10px monospace-feeling letter-spaced uppercase. Reads `'CLIP'` or `'PATTERN'` from `track.type`. Color: `#5F5E5A`.
- Unassigned label: 12px italic, `#888780`. Shown when track has no chorus/crash/regular slot assignment.
- CHORUS pill (or CRASH pill): 10px / weight 500 / letter-spaced 0.5 / 2px×8px padding / radius 3px. Teal background at 15% alpha, teal text (`#4AE3D0`). Rendered when `track.id === layout.chorusTrackId` (or crashTrackId). Read-only — clicking does nothing in this spec.
- Bottom border: 0.5px solid `#2A2F38`, 10px below the row.

### 4.2 Corner Radius 2D drag widget

Replaces the current horizontal slider.

**Visual structure:**

- 64×64 square drag area, 0.5px border `#2A2F38`, background `#0D0F13`.
- Inside the drag area, a smaller "preview rectangle" centered with 6px inset on all sides. The preview rectangle's `border-radius` reflects the current value — 0 = sharp, max = circular. Preview rectangle background: teal at 8% alpha. Preview rectangle border: 1px solid `#4AE3D0`.
- A draggable dot positioned at distance `cornerRadius * (drag area size / 2)` from the top-left corner along the diagonal toward the center. Dot size 7×7px, background `#4AE3D0`, 1.5px outline matching the card background (so it pops off the preview rectangle).

**Interaction:**

- Mouse down on the dot starts a drag.
- Mouse move computes the projection onto the diagonal: `t = clamp((dx + dy) / (2 * size), 0, 1)`. Set `cornerRadius = t * 0.5` (the engine's max).
- Update at each `mousemove`. Engine call: existing `setTrackCornerRadius(t.id, v)` — preserved.
- Scroll wheel on hover over the drag area: ±0.01 per tick.
- Arrow keys when the drag area is focused: ±0.01 per press, Shift+arrow ±0.05.
- Double-click on the dot resets `cornerRadius` to 0.

**Adjacent controls:**

- To the right of the drag area, a vertical stack:
  - Numeric readout: `${Math.round(cornerRadius * 200)}%` (so 0.5 = 100%). 12px / weight 500 / `#E4E6EA`.
  - "apply to all" button: 10px text, transparent background, 0.5px border `#2A2F38`, 3px radius. Click sets every track's `cornerRadius` to this value (preserve current `→All` semantics).

### 4.3 Custom Gap row

- Label: "custom gap", 11px, `#888780`.
- Row: `[16px checkbox] [4px-tall slider track] [readout]`.
- Checkbox toggles `gapScaleOverride === -1` (global) vs `>= 0` (custom). When checked, slider becomes interactive.
- Slider: standard 4px track / teal fill / circular thumb.
- Below row: italic 10px hint reading "using global: 0%" when gap is from the layout, or current custom value when overridden.

Preserve existing engine call for setting the override.

### 4.4 Visual FX section

#### 4.4.1 Section header

```
VISUAL FX (4)                        clear all  [+ add effect ▾]
```

- "VISUAL FX": 12px / weight 500 / letter-spaced 0.5.
- Count: 11px, `#888780`. Format: `(${shownCount})`. Counts non-chainable rows currently shown PLUS chainable chain length. Wait — re-think. Should count "active items the user can see": non-chainable shown + chainable chain length. Yes, that's the right number for the user.
- "clear all": 11px text link, `#888780` default, `#E4E6EA` hover. Click empties `visualEffectChain` AND removes any shown non-chainable rows (sets each `.enabled = false` and clears the shown-list). Visible only when `shownCount > 0`.
- "+ add effect": 11px / 3px×9px padding / 0.5px teal border / teal text / transparent bg. Click opens the dropdown (4.4.2).

#### 4.4.2 Add-effect dropdown

Single popover anchored to the button. Two visual groups separated by a 0.5px solid divider line. No labels above either group.

**Top group (non-chainable behaviors):**
1. Bounce
2. Zoom/Pan/Rot
3. Ping-Pong Loop

Each item:
- Default state: 12px text, full opacity, hover bg `rgba(74, 227, 208, 0.15)`.
- Already-shown state (item exists in the section's shown-list): 60% opacity, no hover, non-clickable, ✓ checkmark prefix.
- Click on default-state item: adds it to the shown-list and sets `track[field].enabled = true`. Closes dropdown.

**Bottom group (chainable shader effects):**
1. Desaturation
2. Tint
3. Brightness & Contrast
4. TV Simulator
5. Zoom/Pan/Rot (the shader-pipeline version, type 4)

⚠ NOTE: Zoom/Pan/Rot appears in both lists because it exists in both data paths (top-level `track.zoomPanRot` AND `visualEffectChain` type 4). This is per the diagnostic. The non-chainable one drives track-level transform animation; the chainable one is per-cell shader. Implementer: if this is confusing in the dropdown, label the bottom one "Zoom/Pan/Rot (per-cell)" to disambiguate. Open sub-decision for review during implementation.

Each chainable item:
- Default state: identical to non-chainable default.
- Already-in-chain state: stays clickable (multi-instance allowed). Existing duplicate-add confirm prompt (`GridLayoutTab.jsx:231–241`) — preserve.
- Click: pushes to `visualEffectChain` with `VFX_DEFAULTS[id]`. Closes dropdown.

#### 4.4.3 Non-chainable group rendering

Rendered above the divider when any non-chainable row is in the shown-list. Order: insertion order. User can drag-reorder; reorder is **cosmetic only** — it doesn't affect engine processing because these aren't a chain.

#### 4.4.4 Chainable group rendering

Rendered below the divider. Iterates `track.visualEffectChain` in order. Drag-reorder updates the array order via existing engine call (preserve whatever currently handles reorder; if no reorder API exists today, this is in scope for this work — open sub-decision flagged).

#### 4.4.5 Per-row design (collapsed)

Single line, 28px tall, 5px×8px padding, 3px radius, background `#0D0F13`:

```
[◇ or ●]  [chevron ▶ or ▼ if expandable]  [enable checkbox]  effect name  [× if chainable]  [grip ⋮⋮]
```

- Glyph: ◇ for non-chainable, ● for chainable. Both teal `#4AE3D0`. 9px.
- Chevron: 8px arrow, `#888780`. Rotates ▶→▼ when expanded. Omitted entirely if the effect has no expandable params.
- Enable checkbox: 9×9px, teal-filled when on, hollow grey border when off. Clicking toggles `track.bounce.enabled` (or other non-chainable field) OR `entry.bypassed` (chainable). Note inversion: checkbox-on means enabled means bypassed=false.
- Effect name: 12px. Color `#E4E6EA` when row is enabled, `#888780` when disabled.
- × (chainable only): 11px, `#5F5E5A` default, `#E4E6EA` hover, transparent bg.
- Grip: 9px `⋮⋮` glyph, `#444441`. Cursor: grab on hover, grabbing while dragging.

#### 4.4.6 Per-row design (expanded)

Below the collapsed header, with 8px top padding:

- 30px left indent (aligns under the effect name).
- Grid: `[label, 60px] [control, flex] [optional readout, 32px right-aligned]` with 8px gap, 12px row gap.
- Label: 11px, `#888780`.
- Control: depends on param. Slider (4px track, teal fill), button group (22×20 buttons), color picker (gradient strip with marker), toggle, etc. Match existing param-control styles in current `GridLayoutTab.jsx` so we don't reinvent each one.
- Readout (if present): 10px, `#B4B2A9`, right-aligned.

Per-effect param rendering is preserved from current code where possible — this spec is not redesigning every individual effect's param UI, only the row container around it. Implementer: keep the existing if/else param branches in `GridLayoutTab.jsx:825–1023` and refactor them into a `<ChainableEffectParams effect={fx} />` component. Same for non-chainable effects' param sections.

#### 4.4.7 Collapse / expand state

- **Default state on track first render:** all rows collapsed except any single auto-expand candidate (the most-recently-added effect).
- **State storage:** session-local React state inside the `<VisualFXSection>` component. Not persisted. New session = all collapsed.
- **No global "expand all" / "collapse all"** — keep scope tight.
- **Expanded row count:** unrestricted. Multiple rows can be expanded simultaneously. (We don't need an accordion; the card scrolls inside the panel.)

#### 4.4.8 Drag-to-reorder

- Use the existing pattern from `TrackHeaderList.jsx` (HTML5 drag-and-drop with `onDragStart`/`onDragOver`/`onDrop`) rather than introducing `@dnd-kit`. SlamShaper uses `@dnd-kit` but Xleth doesn't, and we're not adding a dependency for this.
- During drag: source row at 50% opacity. Target gap shows a 2px teal line.
- On drop: reorder the in-memory list (non-chainable) or call the chain reorder API (chainable). If no chain reorder API exists, add one — `setTrackVisualEffectChainOrder(trackId, newOrder: number[])` mirroring existing IPC patterns.

Cross-group drags are not supported. Dragging from non-chainable to chainable region (or vice versa) is rejected with no visual feedback.

### 4.5 Slide Note Effect section (preserved, restyled)

Below the Visual FX section, only on Pattern tracks (`track.type === 'Pattern'`). Preserve current functionality (`GridLayoutTab.jsx:732–788`). Restyle to match new card aesthetic:

- Section header: "SLIDE NOTE EFFECT" 12px / weight 500 / letter-spaced 0.5.
- Dropdown: same styling as the Add-effect button.
- Sub-controls: same grid pattern as expanded effect rows (4.4.6).

### 4.6 Existing controls preserved without redesign

The following controls stay functional and visually consistent with the new aesthetic, but no behavioral changes:

- "H" badge for `videoHoldLastFrame` (Pattern tracks only — currently in `TrackHeader.jsx:102`, but this spec covers the Grid Settings card, where this badge does not appear — leave alone).
- Sampler button (Pattern only).
- Track delete / trash button.

## 5. Timeline track header

File: `ui/src/components/timeline/TrackHeader.jsx`. Existing component, modified in place. Props unchanged.

### 5.1 Layout

```
[3px color stripe]  [name + type stack — flex, min-width: 0]  [M] [S] [🔇]
```

- Row height: existing `TRACK_HEIGHT` constant — preserved.
- Color stripe: 3×26px, 1.5px radius, 6px left margin, 8px right margin. Color = existing label color logic — preserved.
- Name + type stack: `flex: 1; min-width: 0` (CRITICAL — without `min-width: 0` the flex item refuses to shrink below content width and ellipsis fails).
  - Name: 12px / weight 500 / line-height 1.2 / `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. `title={track.name}` for native browser tooltip.
  - Type badge: 9px / `#5F5E5A` / letter-spaced 0.4 / line-height 1. Reads `track.type.toUpperCase()`.
- Button cluster: 2px gap between buttons, 6px right padding from container edge.

### 5.2 M / S / 🔇 buttons

Each button: 22×22px, 0.5px border `#2A2F38`, 3px radius, transparent bg, padding 0.

**Inactive state:**
- M / S: 10px text, weight 500, color `#B4B2A9`. Letter centered.
- 🔇: lucide `<VolumeX size={12} />`, color `#B4B2A9`.

**Hover state:**
- Border: `#5F5E5A`. No bg change.

**Active state (button is on):**
- M when `track.muted`: bg `rgba(226, 75, 74, 0.15)` (red tint), border `#E24B4A`, text/icon `#E24B4A`.
- S when `track.solo`: bg `rgba(239, 159, 39, 0.15)` (amber tint), border `#EF9F27`, text `#EF9F27`.
- 🔇 when `track.visualOnly`: bg `rgba(74, 227, 208, 0.15)` (teal tint), border `#4AE3D0`, icon `#4AE3D0`.

**Disabled-row visual:**
- When `track.muted` is true, the name text dims to `#5F5E5A` and the row content (left of the button cluster) drops to 55% opacity. Buttons themselves stay full opacity. (Preserve existing behavior here if it already exists; if not, add it.)

**Click handlers:** unchanged. Each button calls the existing `onMute(trackId)` / `onSolo(trackId)` / `onVisualOnly(trackId)` props, which dispatch to the existing IPC channels (`setTrackMuted`, `setTrackSolo`, `setTrackVisualOnly`). No engine work needed.

### 5.3 Mute icon source

```javascript
import { VolumeX } from 'lucide-react';
// ...
<button>
  <VolumeX size={12} strokeWidth={2} />
</button>
```

The orphaned `audio-speaker-off-svgrepo-com.svg` at the project root is **not** loaded. It can be deleted as a side note — leaving it has no functional impact.

### 5.4 Truncation and tooltip

- Always render the full name in a `<div title={track.name}>` wrapper. The browser shows the OS-native tooltip on hover after ~500ms.
- No custom tooltip component. Native is enough — and free.
- Truncation is purely CSS (`text-overflow: ellipsis`). No JS measurement.

### 5.5 Resizable column

The track-header column has a draggable right edge.

- Drag handle: 4px-wide vertical zone on the right edge of the entire header column (not per-row). Cursor `col-resize` on hover.
- Drag interaction: standard mousedown → mousemove → mouseup pattern (mirror the windowing spec's `DragManager` shape, but local to this column; no shared infrastructure needed for one resize handle).
- Min width: 120px. Max width: 480px.
- Width state: stored in a new Zustand UI store `useUIStore` at key `timelineTrackHeaderWidth`. Default 200px. Session-scoped — not persisted to disk in this spec (post-beta when layout.json exists, persist there).
- Visual feedback during drag: 2px teal vertical line at the drag position; release commits the new width.

## 6. Component extraction plan

`GridLayoutTab.jsx` is currently 1044 lines. Extracting components is required scope for this work. Target structure after refactor:

```
ui/src/components/grid/
├── GridLayoutTab.jsx                  # parent — keeps layout-level state, iterates tracks
├── TrackCard.jsx                      # one card per track
├── TrackCardHeader.jsx                # name + type + assignment pill
├── CornerRadiusControl.jsx            # 2D drag widget
├── CustomGapControl.jsx               # checkbox + slider + readout
├── VisualFXSection.jsx                # the unified FX block
├── VisualFXSectionHeader.jsx          # title + count + clear all + add dropdown
├── VisualFXAddDropdown.jsx            # the popover
├── EffectRow.jsx                      # row container with collapse/expand, drag handle
├── NonChainableEffectParams.jsx       # param renderer for Bounce/ZPR/PingPong
├── ChainableEffectParams.jsx          # param renderer for visualEffectChain entries
└── SlideNoteEffectSection.jsx         # restyled existing block
```

Existing `GridLayoutTab.jsx` shrinks to the iteration shell + layout-level controls (preview FPS, chorus/crash slot config, etc.).

Component boundaries are guidance, not a contract. Implementer may consolidate or split further if tighter modules emerge. The bar is: no single component over ~250 lines.

## 7. State management

**No new stores other than `useUIStore`** (single field: `timelineTrackHeaderWidth`).

**Existing stores preserved:** `useGridEditStore`, `useMixerStore`, etc.

**Component-local state:**
- `<VisualFXSection>` owns the shown-list of non-chainable rows.
- `<EffectRow>` owns its collapse/expand boolean.
- `<TrackCardHeader>` owns the editing-name boolean (for double-click rename).

**Engine calls (all preserved):**
- `window.xleth.timeline.setTrackCornerRadius`
- `window.xleth.timeline.setTrackGapScaleOverride`
- `window.xleth.timeline.setTrackBounce` (and similar for ZPR / PingPong / SlideNote)
- `window.xleth.timeline.addVfxToTrack` / `removeVfxFromTrack` / `setVfxParam` / `setVfxBypassed`
- `window.xleth.timeline.setTrackName`
- `window.xleth.timeline.setTrackMuted` / `setTrackSolo` / `setTrackVisualOnly`

If `setTrackVisualEffectChainOrder` (chain reorder) doesn't exist today, add it. Mirror the existing pattern: renderer calls `window.xleth.timeline.setTrackVisualEffectChainOrder(trackId, newOrder)`, main process forwards via IPC, engine reorders the array. This is the only IPC addition this spec allows.

## 8. Out of scope

Explicitly NOT in this work, even though the diagnostic surfaced them:

- Theming token migration. Colors stay hardcoded in this spec. Theming Wave 0 will migrate them later as part of its audit pass — that's the right place for it.
- Windowing system integration. The cards and headers redesigned here will live inside whichever panels Wave 1 puts them in; no panel-aware code in this spec.
- CHORUS / CRASH pill click-to-reassign interaction. Pills are read-only badges in this spec.
- Reordering tracks themselves (the timeline header drag-reorder behavior currently implemented in `TrackHeaderList.jsx`). Preserve as is.
- New per-effect param controls. Only the row container is redesigned; param controls inside expanded rows reuse current implementation.
- The Slide Note Effect's interaction model. Only its visual styling is updated to match the new card aesthetic.
- Mixer panel changes (this spec is grid + timeline only).
- Adding `chainable` flag to the VFX catalog data model. The grouping is implemented in the dropdown's render logic, not as a data property.
- Adding right-click context menus on effect rows.

## 9. File structure

**Modified:**
- `ui/src/components/GridLayoutTab.jsx` — reduces to iteration shell + extractions imported
- `ui/src/components/timeline/TrackHeader.jsx` — button cluster updated, name truncation hardened, title attribute added
- `ui/src/components/timeline/TimelineView.jsx` — track-header column gets a draggable right edge

**New:**
- `ui/src/components/grid/TrackCard.jsx`
- `ui/src/components/grid/TrackCardHeader.jsx`
- `ui/src/components/grid/CornerRadiusControl.jsx`
- `ui/src/components/grid/CustomGapControl.jsx`
- `ui/src/components/grid/VisualFXSection.jsx`
- `ui/src/components/grid/VisualFXSectionHeader.jsx`
- `ui/src/components/grid/VisualFXAddDropdown.jsx`
- `ui/src/components/grid/EffectRow.jsx`
- `ui/src/components/grid/NonChainableEffectParams.jsx`
- `ui/src/components/grid/ChainableEffectParams.jsx`
- `ui/src/components/grid/SlideNoteEffectSection.jsx`
- `ui/src/stores/uiStore.js` — new Zustand store for `timelineTrackHeaderWidth`
- `ui/src/components/grid/grid.module.css` (or equivalent — match existing CSS pattern in the codebase)

**Possibly modified (engine + bridge):**
- C++ engine: add `setTrackVisualEffectChainOrder` if missing
- Node-API bridge: forward the IPC

## 10. Implementation phases

Each phase independently testable. Land in order — later phases assume earlier ones work.

**Phase 1 — Component extraction.** Refactor `GridLayoutTab.jsx` into the file structure in Section 9 with NO behavioral changes. Visual diff before/after is identical. This is pure refactor — verify by clicking through every control on every track type and confirming nothing broke.

**Phase 2 — Track card header + Corner Radius widget.** Replace the existing card header markup with the new design. Replace the Corner Radius slider with the 2D drag widget. Custom Gap row gets the new layout. Slide Note Effect section gets restyled (no behavioral changes).

**Phase 3 — Visual FX section unification.** Build `<VisualFXSection>` with header, dropdown, divider-grouped rows. Wire non-chainable adds to top-level fields, chainable adds to `visualEffectChain`. Rows render in collapsed state by default. Expand/collapse works. × removal works for both groups. Clear-all works.

**Phase 4 — Drag-to-reorder.** Implement HTML5 drag-and-drop within each group. Add `setTrackVisualEffectChainOrder` IPC if missing. Cross-group drags rejected.

**Phase 5 — Timeline track header polish.** Update `TrackHeader.jsx` button cluster (22px, lucide VolumeX). Add `title` attribute on name. Verify ellipsis works at narrow widths.

**Phase 6 — Resizable timeline column.** Add `useUIStore` with `timelineTrackHeaderWidth`. Wire the draggable right edge in `TimelineView.jsx`. Min/max width clamps. Drag visual feedback. Width applies via CSS variable or inline style on the column.

Estimated total effort: 3–5 focused days.

## 11. Acceptance criteria

A release of this work is complete when all of the following pass:

1. `GridLayoutTab.jsx` is below 250 lines. All sub-components from Section 9 exist and render without prop-drilling state more than two levels deep.
2. Every existing track-card behavior works identically: Corner Radius value persists, Custom Gap toggle persists, Bounce / ZPR / PingPong all toggle and update engine state, Visual FX add/remove/toggle/param-edit all work for every effect type, Slide Note Effect dropdown works on Pattern tracks.
3. The Corner Radius 2D drag widget responds to mouse drag, scroll wheel, and arrow keys. The preview rectangle's rounding matches the dot's diagonal projection. Apply-to-all button propagates correctly.
4. The Visual FX section shows both non-chainable behaviors and chainable shader effects in one list, separated by an unlabeled divider, with ◇ / ● glyphs respectively.
5. The Add-effect dropdown shows non-chainable above the divider and chainable below. Already-shown non-chainable items are greyed and non-clickable. Already-in-chain chainable items remain clickable and trigger the existing duplicate-add confirm.
6. Effect rows collapse/expand on chevron click. Default state is collapsed. Expansion is unrestricted (multiple rows can be open at once).
7. Drag-to-reorder works within each group, with visual feedback during drag. Chainable reorders update engine processing order. Non-chainable reorders are cosmetic but visually persist for the session.
8. Clear-all link removes all chainable entries AND hides all non-chainable rows (sets each `.enabled = false`). Confirm prompt before clearing if `shownCount > 3` (small guardrail to prevent accidental wipes).
9. Timeline track-header buttons are 22×22px with lucide `VolumeX` for the visual-only button. Letters M and S preserved. Active states render with the correct accent colors per Section 5.2.
10. Track names truncate with ellipsis at narrow widths and show full name in the OS-native tooltip on hover.
11. The track-header column right edge is draggable. Width persists across track changes within the same session (resets on app restart, by design — persistence is post-beta).
12. No visual or behavioral regressions in any other panel (mixer, sampler, piano roll, preview, sample selector). Verify by spot-check.
13. No new hardcoded colors that don't have a clear migration target in the upcoming theming Wave 0 catalog. (Implementer: if you introduce a new color, add a comment `// TODO theming wave: → --theme-...` next to it.)

## 12. Known decision debt (deferred)

- Persisting `timelineTrackHeaderWidth` to disk (waiting for layout.json from windowing/theming waves).
- CHORUS / CRASH pill click-to-reassign.
- Right-click context menus on effect rows (rename, duplicate, copy params, paste params).
- "Expand all" / "collapse all" controls on the Visual FX section.
- Per-effect-type custom collapsed-state previews (e.g. show a tiny color swatch on a collapsed Tint row).
- Cross-group drag-and-drop in the FX section (drag a chainable item up into the non-chainable group, etc. — currently rejected).
- Track name editing UX upgrade (currently double-click; could become single-click + inline edit on focus).
- Resizable Visual FX section height (currently grows naturally with content).

## 13. Open sub-decisions (lock during implementation)

- **Zoom/Pan/Rot dropdown disambiguation.** Section 4.4.2 flagged that ZPR exists in both groups. If the dropdown is confusing in user testing, label the bottom one "Zoom/Pan/Rot (per-cell)". Decide during Phase 3 review.
- **Clear-all confirm threshold.** Spec says confirm if `shownCount > 3`. May want to adjust to `> 0` (always confirm) or `> 5` (rarely confirm). Lock during Phase 3.
- **Auto-expand behavior on add.** Spec says most-recently-added effect is expanded on first render of a track. Should adding a new effect auto-expand it? Probably yes — it gives the user immediate access to params. Lock during Phase 3.
- **Per-row vs per-effect drag handle visibility.** Currently grip is always visible. Could fade in on hover for a cleaner look. Lock during Phase 4.
- **Name-edit affordance on the track card header.** Double-click to rename matches `TrackHeader.jsx`. Should the card header show a subtle edit hint (pencil icon on hover)? Lock during Phase 2.
- **Animation on collapse/expand.** Instant vs 150ms ease. Lock during Phase 3 — try instant first, add animation only if it feels jumpy.

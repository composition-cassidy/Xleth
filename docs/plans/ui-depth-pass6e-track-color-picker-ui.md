# Pass 6E — Track Color Picker UI

## Summary

Adds a compact palette popover that opens when the user clicks a track's color strip in the Timeline header. The user can pick **Auto** or one of **16 palette slots** for an individual track. Relies entirely on the `handleSetTrackColor` action and engine command plumbed in Pass 6D.

UI-only pass. No engine, bridge, IPC, schema, theme-token, or Timeline drawing changes.

---

## Files Changed

| File | Change |
|------|--------|
| `ui/src/components/TimelineView.jsx` | +`onSetTrackColor={handleSetTrackColor}` prop to `<TrackHeaderList>` |
| `ui/src/components/timeline/TrackHeaderList.jsx` | +`onSetTrackColor` prop; +`openColorPickerId`/`colorPickerAnchorRect` state; +open/close/choose callbacks; pass `onOpenColorPicker` to each `<TrackHeader>`; render `<TrackColorPopover>` |
| `ui/src/components/timeline/TrackHeader.jsx` | Replace `.track-header-color` div with `.track-header-color-btn` button; +`onOpenColorPicker` prop |
| `ui/src/components/timeline/TrackColorPopover.jsx` | NEW — portal-based popover (Auto + 16 swatches) |
| `ui/src/styles/app.css` | NEW `.track-color-popover*` classes; NEW `.track-header-color-btn` class; update pattern-track selector |
| `docs/plans/ui-depth-pass6e-track-color-picker-ui.md` | This file |

---

## UI Behavior

- Click a track's color strip → popover opens immediately below the strip
- Popover title: **Track color**
- First row: **Auto** button (full width)
- Second section: 4×4 grid of 16 palette swatches
- Current mode is visually selected:
  - Auto mode → Auto button shows pressed state
  - Palette slot N → swatch N shows double-ring highlight
- Choosing Auto → calls `setTrackColor(id, { mode: 'auto' })` → closes popover
- Choosing swatch N → calls `setTrackColor(id, { mode: 'paletteSlot', slot: N })` → closes popover
- Clicking the same strip again toggles the popover closed
- Click outside → closes
- Escape → closes
- Scroll (wheel) or window resize → closes (avoids detached fixed-position popover)
- Only one popover open at a time (state lives in TrackHeaderList)

---

## Picker Structure

```
┌─────────────────────────┐
│ TRACK COLOR             │  ← .track-color-popover-title
│ ┌─────────────────────┐ │
│ │       Auto          │ │  ← .track-color-auto-option [.is-selected]
│ └─────────────────────┘ │
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐    │
│ │  │ │  │ │  │ │  │    │
│ └──┘ └──┘ └──┘ └──┘    │  ← .track-color-swatch-grid
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐    │    16 × .track-color-swatch [.is-selected]
│ │  │ │  │ │  │ │  │    │
│ └──┘ └──┘ └──┘ └──┘    │
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐    │
│ │  │ │  │ │  │ │  │    │
│ └──┘ └──┘ └──┘ └──┘    │
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐    │
│ │  │ │  │ │  │ │  │    │
│ └──┘ └──┘ └──┘ └──┘    │
└─────────────────────────┘
```

---

## Selected-State Logic

Uses `normalizeTrackColorAssignment(track)` from `trackColorResolver.js` (exported in Pass 6D):

| Track state | Result |
|-------------|--------|
| missing `trackColorMode` | Auto selected |
| `trackColorMode: 'auto'` | Auto selected |
| `trackColorMode: 'paletteSlot'`, valid slot 1..16 | That swatch selected |
| `trackColorMode: 'paletteSlot'`, invalid slot | Auto selected (normalizer coerces) |

No duplication of validation logic in the popover.

---

## Handler / Action Path

```
Click swatch N
  → TrackColorPopover.onChooseSlot(N)
  → TrackHeaderList.handleChooseSlot(openColorPickerId, N)
  → onSetTrackColor(trackId, { mode: 'paletteSlot', slot: N })   [prop from TimelineView]
  → TimelineView.handleSetTrackColor(id, assignment)              [Pass 6D, line ~1166]
      sanitizes input
      → window.xleth.timeline.setTrackColor(id, sanitized)        [NAPI bridge]
        → SetTrackColorCommand (undo-tracked in engine)
      → fetchTracks() → React re-render
      fallback: local state mutation (engine-less harness)
```

Undo/redo: free via the existing engine command system. No new plumbing needed.

---

## Theme Palette Reuse

`TrackHeaderList` resolves `trackPalette` from `--theme-track-palette-1..16` tokens once per render and re-runs on `xleth-theme-changed`. The same array is passed as `palette` to `TrackColorPopover`. No separate token resolution in the popover. Theme switching propagates automatically.

---

## Popover Positioning

Uses `createPortal(content, document.body)` + `position: fixed`, same pattern as `ContextMenu.jsx`. Required because `.timeline-header-scroll` has `overflow-x: hidden` which clips any inline-rendered popover.

Positioned at `anchorRect.bottom + 4` / `anchorRect.left`. Viewport clamped in a `useEffect` after mount (same as `ContextMenu`).

---

## Styling Notes

- Compact DAW style, no glow, no glossy
- Popover background: `var(--theme-bg-secondary)`
- Border: `var(--theme-border-subtle)`
- Shadow: `elevation-1-top-highlight` + `elevation-2-outer-shadow`
- Auto selected: `var(--theme-depth-pressed-bg)` + `var(--theme-border-focus)` + `var(--theme-accent)` text
- Swatch selected: double-ring — `2px var(--theme-bg-secondary)` gap + `3px var(--theme-border-focus)` outer
- Swatch hover: `scale(1.12)` + faint white border
- Color strip hover: width expands 3px→5px (subtle interactivity cue)
- z-index: `9000` (matches `.context-menu`)

---

## Accessibility

- Color strip is `<button>` with `title="Change track color"` and `aria-label="Change track color"`
- Auto option: `aria-pressed={mode === 'auto'}`
- Each swatch: `aria-label="Use track color N"` (1..16), `aria-pressed={selected}`
- Escape closes; outside click closes

---

## Tests

No automated React component tests added. Vitest is configured with `environment: 'node'` and `@testing-library/react` is not installed. The 24 existing unit tests in `trackColorResolver.test.js` cover all selected-state normalization exhaustively.

### Manual smoke

1. Click a track color strip → popover opens
2. Pick **Auto** → popover closes, track uses auto-assigned color
3. Reopen → pick slot 5 → track strip, clips, and pattern blocks update to palette slot 5
4. **Save** project → reopen → slot 5 persists
5. **Undo** (Ctrl+Z) → prior assignment returns
6. **Redo** (Ctrl+Y) → slot 5 reapplies
7. **Theme switch**: open picker → switch Default ↔ Light → swatches update after reopen
8. Mute/solo still works; track rename still works; clip move/resize still works

---

## Explicit Out-of-Scope Confirmation

- No custom color picker (Pass 6F)
- No Theme Editor changes
- No schema / model / engine / bridge changes
- No IPC / preload / main changes
- No theme token changes
- No shipped theme JSON changes
- No Timeline drawing changes
- No Playwright baseline updates
- No new package dependencies
- No TrackColorMode enum changes
- No `trackColorCustom` field

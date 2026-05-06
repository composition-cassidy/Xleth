# Pass 6G — Custom Color UI for Timeline Track Color Picker

## Summary

Exposes the per-track custom `#RRGGBB` color mode (introduced in Pass 6F) in the
existing `TrackColorPopover`. Users can now assign any arbitrary hex color to an
individual track directly from the picker.

---

## Files changed

| File | Change |
|---|---|
| `ui/src/components/timeline/TrackColorPopover.jsx` | Added custom section (color input + hex text field), local draft state, `onChooseCustom` + `resolvedTrackColor` props |
| `ui/src/components/timeline/TrackHeaderList.jsx` | Added `handleChooseCustom`, computed `resolvedColor` for open track, passed new props to popover |
| `ui/src/styles/app.css` | Added `.track-color-custom-section`, `.track-color-custom-label`, `.track-color-custom-row`, `.track-color-custom-input`, `.track-color-hex-input`, `.track-color-custom-error` |
| `docs/plans/ui-depth-pass6g-custom-track-color-picker-ui.md` | This file |

---

## Custom UI behavior

The Custom section appears below the 4×4 palette swatch grid, separated by a
subtle top border. It contains:

- A label ("Custom", uppercase, `var(--theme-text-muted)`)
- A row with:
  - `input[type="color"]` (22×22px color wheel, immediate apply on change)
  - `input[type="text"]` (hex field, monospace, applies on Enter or blur if valid)
- An error message ("Use #RRGGBB format") when text field contains a non-empty
  invalid value

When a track is in `mode === 'custom'`, the Custom label turns `var(--theme-accent)`
(same accent highlight used by Auto's `.is-selected` state).

The popover stays open after custom color changes. The user closes it with Escape
or by clicking outside.

---

## Selected-state logic

| Condition | Selected UI element |
|---|---|
| `mode === 'auto'` | Auto button `.is-selected` |
| `mode === 'paletteSlot'` + valid slot 1–16 | Matching palette swatch `.is-selected` |
| `mode === 'custom'` + valid hex | Custom section `.is-selected`, inputs pre-filled |
| Invalid track data (resolver fallback to auto) | Auto button `.is-selected` |

Draft initialization:
- If `mode === 'custom'` and `customColor` is valid → pre-fill with `customColor`
- Otherwise → pre-fill with `resolvedTrackColor` (current resolved hex passed from
  `TrackHeaderList`) or `#4CC9F0` as last resort
- Re-synced via `useEffect` whenever `mode`, `customColor`, or `resolvedTrackColor` changes

---

## Validation rules

| Input | Result |
|---|---|
| `#FF00AA` | Valid — applied immediately (color input) or on Enter/blur (text field) |
| `#ff00aa` | Valid — normalized to `#FF00AA` on blur |
| `#RGB` | Invalid — error shown, no `setTrackColor` call |
| `rgb(255,0,0)` | Invalid — error shown, no call |
| `#ZZZZZZ` | Invalid — error shown, no call |
| empty string | No error, no call (placeholder shown) |

Validation uses `isValidTrackCustomColor` and `normalizeTrackCustomColor` from
`trackColorResolver.js` (Pass 6F exports, unchanged).

---

## Commit behavior

**Color input (`input[type="color"]`):**
- Fires `onChooseCustom` on every `onChange` (immediate apply)
- `input[type="color"]` only emits valid `#rrggbb` values, so no additional guard needed

**Hex text input:**
- Fires `onChooseCustom` on Enter keydown (if `normalizeTrackCustomColor` returns
  non-null)
- Fires `onChooseCustom` on blur (if valid); also normalizes the field to uppercase
- Invalid input at blur: field keeps draft value unchanged, no call made

---

## Handler / action path

```
Color input onChange / text input Enter / text input blur
  → onChooseCustom(normalizedHex)            [TrackColorPopover prop]
    → handleChooseCustom(trackId, hex)        [TrackHeaderList]
      → onSetTrackColor(trackId, { mode: 'custom', customColor: hex })
        → handleSetTrackColor (TimelineView.jsx, lines 1168–1209)
          → window.xleth.timeline.setTrackColor(id, sanitized)
          → fetchTracks() → re-render
```

Auto and paletteSlot paths unchanged. Both still close the popover via
`handleCloseColorPicker`. Custom path intentionally keeps the popover open.

---

## Styling notes

All new classes use existing theme tokens:

- Section divider: `var(--theme-border-subtle)`
- Selected label: `var(--theme-accent)` (via `.is-selected` modifier)
- Muted label: `var(--theme-text-muted)`
- Text input background: `var(--theme-bg-inset)`
- Text input border (default): `var(--theme-border-subtle)`
- Text input border (focused): `var(--theme-border-focus)`
- Text input border (invalid): `var(--theme-danger, #ef4444)`
- Error text: `var(--theme-danger, #ef4444)`
- Font: `var(--font-mono, monospace)` for hex field

Color swatch dimensions (22×22px) match existing palette swatches. No glow, no
gradients, no Aero styling.

---

## Accessibility notes

- Color input: `aria-label="Custom track color"`
- Text input: `aria-label="Custom track color hex"`
- Error message: `aria-live="polite"`
- Enter in text input applies if valid (keyboard path)
- Escape closes popover (existing handler, unchanged)
- No color-only indication of error — "Use #RRGGBB format" text accompanies the
  red border

---

## Tests

**Test setup check:** checked for `ui/src/components/timeline/__tests__/` and
Vitest component test configuration.

If component test setup is available, add `TrackColorPopover.custom.test.jsx`:
1. Custom section renders
2. `mode === 'custom'` → `.is-selected` on section, inputs show `customColor`
3. Text blur with lowercase `#ff00aa` → `onChooseCustom('#FF00AA')` called
4. Invalid hex `#RGB` → `onChooseCustom` not called, error element visible
5. Color input `onChange` → `onChooseCustom` called with normalized hex
6. Auto and paletteSlot selection still works

Existing `trackColorResolver.test.js` covers all validation/normalization logic
and is unmodified.

---

## Resolver tests

```
npx vitest run src/components/timeline/trackColorResolver.test.js
```

Covers `isValidTrackCustomColor`, `normalizeTrackCustomColor`,
`normalizeTrackColorAssignment` (custom branches), and `resolveTrackColor`
custom priority. All tests must pass without modification.

---

## Build

```
cd ui && npm run build
```

---

## Runtime smoke notes

1. Open a project → click track color strip → popover shows Auto, 16 swatches,
   Custom section below divider
2. Select palette slot 5 → strip updates, popover closes
3. Reopen → slot 5 highlighted, Custom section not selected
4. Interact with Custom color input → wheel → track updates immediately, popover stays open
5. Type `#FF00AA` in hex field → Enter → track strip, clips, pattern blocks update to #FF00AA
6. Reopen picker → Custom section `.is-selected`, inputs show `#FF00AA`

---

## Persistence / undo smoke notes

7. Save project → reopen → `#FF00AA` persists (uses Pass 6F engine/schema)
8. Undo → previous assignment returns (palette slot or auto)
9. Redo → `#FF00AA` reapplies
10. Theme switch → custom track retains `#FF00AA`; auto/palette tracks update with theme

---

## Invalid input smoke notes

- `#RGB` → error text shown, no color change
- `rgb(255,0,0)` → error text shown, no color change
- `#zzzzzz` → error text shown, no color change
- `#00ffaa` → blur → applied as `#00FFAA` (normalized)

---

## Scope confirmation

**No changes made to:**
- Engine files (`engine/`)
- Bridge (`bridge/`)
- IPC / preload / main (`ui/main.js`, `ui/preload.js`)
- `TrackInfo` struct or `TrackColorMode` enum
- Project schema (no version bump)
- Theme Editor
- Theme token catalog
- Shipped theme JSON files
- Timeline drawing (`TimelineCanvas`, `AnimationManager`, `FrameCollector`)
- App layout or track geometry
- `trackColorResolver.js` (resolver is unchanged; only imported)
- `TimelineView.jsx` (already handled custom mode in Pass 6F)
- Sample Selector, Mixer, Piano Roll, Sampler, Preview, Grid Settings, Project Media,
  plugin UI
- Package files (`package.json`, `package-lock.json`)
- Playwright visual baselines

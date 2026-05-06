# Pass 6B — Track Palette Token Foundation

## Summary

Registers a 16-slot user-editable track identity color palette in the Xleth theme token system. This is foundation-only — no renderer consumers, no schema changes, no UI changes.

---

## Why global `--theme-track-palette-N` naming

The diagnostic plan (Pass 6A) initially proposed `--theme-timeline-track-palette-N`. This pass uses the shorter global form `--theme-track-palette-N` instead because:

- Track color identity is not a Timeline-specific concept. The same palette slot that colors a Timeline clip should color the Mixer channel strip, Grid row header, and any future surface that needs to identify a track.
- Scoping to `--theme-timeline-*` would force aliases or migration in every future pass that needs track color in Mixer or Grid.
- The Labels subsystem already hosts cross-cutting identity colors (`--theme-label-kick` etc.); the track palette belongs in the same category for the same reason.

---

## Files changed

| File | Change |
|------|--------|
| `ui/src/theming/tokens/catalog.ts` | New subsystem `track-palette`; 16 explicit color tokens |
| `ui/src/theming/shipped/xleth-default.json` | 16 dark palette overrides |
| `ui/src/theming/shipped/xleth-light.json` | 16 light palette overrides |
| `ui/src/theming/tokens/__tests__/track-palette-tokens.test.ts` | Registration + resolution tests |

---

## Tokens added

`--theme-track-palette-1` through `--theme-track-palette-16`

- **Kind:** `color`
- **Capability:** `solid` (must remain solid hex — Theme Editor `ColorPicker` and canvas `hexToRgba()` helpers require valid `#RRGGBB`)
- **Subsystem:** `track-palette`
- **Category:** `Labels`
- **Derivation:** `explicit` with dark palette defaults

---

## Dark/default palette

| Slot | Token | Value |
|------|-------|-------|
| 1 | `--theme-track-palette-1` | `#4CC9F0` |
| 2 | `--theme-track-palette-2` | `#7BD88F` |
| 3 | `--theme-track-palette-3` | `#FF9F5A` |
| 4 | `--theme-track-palette-4` | `#9B7BFF` |
| 5 | `--theme-track-palette-5` | `#F472B6` |
| 6 | `--theme-track-palette-6` | `#FFD166` |
| 7 | `--theme-track-palette-7` | `#5B8DEF` |
| 8 | `--theme-track-palette-8` | `#2DD4BF` |
| 9 | `--theme-track-palette-9` | `#FF6B6B` |
| 10 | `--theme-track-palette-10` | `#A3D65C` |
| 11 | `--theme-track-palette-11` | `#C084FC` |
| 12 | `--theme-track-palette-12` | `#38BDF8` |
| 13 | `--theme-track-palette-13` | `#FBBF24` |
| 14 | `--theme-track-palette-14` | `#8EA4D2` |
| 15 | `--theme-track-palette-15` | `#6EE7B7` |
| 16 | `--theme-track-palette-16` | `#FB7185` |

---

## Light palette

| Slot | Token | Value |
|------|-------|-------|
| 1 | `--theme-track-palette-1` | `#167FA3` |
| 2 | `--theme-track-palette-2` | `#2E8B57` |
| 3 | `--theme-track-palette-3` | `#C45F20` |
| 4 | `--theme-track-palette-4` | `#6D54C7` |
| 5 | `--theme-track-palette-5` | `#B83E7F` |
| 6 | `--theme-track-palette-6` | `#B7791F` |
| 7 | `--theme-track-palette-7` | `#2F5FBA` |
| 8 | `--theme-track-palette-8` | `#147D72` |
| 9 | `--theme-track-palette-9` | `#B93D3D` |
| 10 | `--theme-track-palette-10` | `#6F8F24` |
| 11 | `--theme-track-palette-11` | `#7E4CB8` |
| 12 | `--theme-track-palette-12` | `#1878A8` |
| 13 | `--theme-track-palette-13` | `#A66500` |
| 14 | `--theme-track-palette-14` | `#566C9A` |
| 15 | `--theme-track-palette-15` | `#208A68` |
| 16 | `--theme-track-palette-16` | `#B43A52` |

---

## Cool and Warm themes

`xleth-cool.json` and `xleth-warm.json` are not modified. The `resolveTheme()` function uses the catalog `explicit` default when a theme's `tokens` object does not override a token — the same mechanism that causes label tokens (`--theme-label-kick` etc.) to resolve correctly even though they appear in no shipped theme JSON. Cool and warm inherit the dark palette from the catalog default.

---

## Confirmations

- **No renderer consumers added.** No component, canvas, or CSS file was touched.
- **No track/project schema changes.** `TrackInfo`, bridge, IPC, and engine files are unchanged.
- **No Theme Editor UI changes.** The new tokens will appear as color-editable rows in Advanced Mode because they resolve to hex values that trigger `ColorPicker` in `TokenRow`; the editor UI was not modified in this pass.

---

## Verification results

```
npm run build   →  ✓ built in 2.41s  (no errors)

npx vitest run src/theming

  ✓ colorDistance.test.ts       (6 tests)
  ✓ derivation.test.ts          (25 tests)
  ✓ depth-tokens.test.ts        (9 tests)
  ✓ timeline-lane-bg-token.test.ts (3 tests)
  ✓ track-palette-tokens.test.ts   (8 tests)  ← new
  ✓ tokenValue.test.ts          (6 tests)

  Test Files  6 passed (6)
  Tests       57 passed (57)
```

---

## Untouched files (explicit confirmation)

- `ui/src/components/timeline/timelineDrawing.js` — untouched
- `ui/src/components/timeline/TimelineCanvas.jsx` — untouched
- `ui/src/styles/app.css` — untouched
- `ui/src/windowing/components/windowing.css` — untouched
- `ui/src/theming/shipped/xleth-cool.json` — untouched
- `ui/src/theming/shipped/xleth-warm.json` — untouched
- `ui/src/theming/editor/` (all Theme Editor files) — untouched
- All engine, bridge, IPC, preload, main process, and package files — untouched
- All Playwright baselines — untouched

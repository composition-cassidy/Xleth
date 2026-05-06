# Pass 6C — Auto-only Timeline Track Color Rendering

## Summary

Wires the 16-slot theme track palette (added in Pass 6B) into all three color surfaces that represent track identity: Timeline clip bodies, pattern block bodies, and track header color strips. Auto color is based on visible track order with modulo-16 wrap. No schema changes, no persistence, no picker UI, no Theme Editor changes.

---

## Files Changed

| File | Change |
|---|---|
| `ui/src/components/timeline/trackColorResolver.js` | **Created** — shared resolver module |
| `ui/src/components/timeline/timelineDrawing.js` | Added `trackPalette` to `resolveTimelinePalette()`; added `trackColorById` param to `drawClips` and `drawPatternBlocks` |
| `ui/src/components/timeline/TimelineCanvas.jsx` | Builds `trackColorById` map once per `redrawContent()`; threads into draw calls |
| `ui/src/components/timeline/TrackHeaderList.jsx` | Resolves palette once per render; one theme-change listener; passes `trackColor` to each `TrackHeader` |
| `ui/src/components/timeline/TrackHeader.jsx` | Accepts `trackColor` prop; removes `LABEL_TOKENS` constant and `tokenValue` import |

---

## Current Color Sources Replaced

| Surface | Before | After |
|---|---|---|
| Audio clip body | `labelHexColor(region?.label)` — category/label color | `trackColorById[clip.trackId]` — track palette slot, fallback to label color |
| Pattern block body | `labelHexColor(region?.label)` — category/label color | `trackColorById[block.trackId]` — track palette slot, fallback to label color |
| Track header strip | `tokenValue(LABEL_TOKENS[index % 8])` — 8-token label cycle | `resolveAutoTrackColor(track, index, trackPalette, fallback)` — 16-slot palette |

---

## Track Palette Resolution

- `resolveTimelinePalette()` now resolves `--theme-track-palette-1` through `--theme-track-palette-16` via 16 `tokenValue()` calls, once per redraw cycle.
- Each raw value is validated with `/^#[0-9a-fA-F]{6}$/`; invalid entries fall back to `TRACK_PALETTE_FALLBACK[i]`.
- `TRACK_PALETTE_FALLBACK` is the 16-entry constant in `trackColorResolver.js` matching the dark-theme token defaults.
- The validated array is stored as `palette.trackPalette` and threaded into draw functions and `TrackHeaderList`.

---

## Track Color Map Construction

- `buildResolvedTrackColorMap(tracks, trackPalette)` is called once per `redrawContent()` in `TimelineCanvas.jsx`.
- Iterates `tracks` in visible order; calls `resolveAutoTrackColor(track, i, trackPalette, fallback)` for each.
- Returns `{ [trackId]: resolvedHexColor }`.
- Total cost: one plain object allocation + N property writes. Equivalent to the existing `mutedTrackIds` Set construction already in `redrawContent`.

---

## `resolveAutoTrackColor` Design

```js
export function resolveAutoTrackColor(track, visibleIndex, trackPalette, fallbackHex) {
  const palette = trackPalette?.length ? trackPalette : TRACK_PALETTE_FALLBACK
  return palette[visibleIndex % palette.length] || fallbackHex || TRACK_PALETTE_FALLBACK[0]
}
```

`track` is accepted as a parameter (unused now) so Pass 6D can add `track.trackColorMode === 'paletteSlot'` branching here without modifying any call site.

---

## Fallback Behavior

| Condition | Behavior |
|---|---|
| `trackColorById` is `null` (old call path) | `trackColorById?.[id]` evaluates to `undefined`; `||` falls back to `labelHexColor(region?.label)` |
| Token value is not a valid `#RRGGBB` | `normalizeTrackPalette()` substitutes `TRACK_PALETTE_FALLBACK[i]` |
| `clip.trackId` / `block.trackId` absent from map | `||` falls back to `labelHexColor(region?.label)` |
| `trackColor` prop not passed to `TrackHeader` | `|| TRACK_PALETTE_FALLBACK[index % 16]` |
| `trackPalette` is empty | `resolveAutoTrackColor` falls back to `TRACK_PALETTE_FALLBACK` |

Existing projects load without schema changes and without failures.

---

## Timeline Clip Color Integration

- `drawClips` signature gains `trackColorById = null` as last parameter (default `null` — backward-compatible with all existing callers).
- Color source at line ~671 (after `trackIdx` and `region` resolved):
  ```js
  const fallbackHex = labelHexColor(region?.label)
  const hex = trackColorById?.[clip.trackId] || fallbackHex
  ```
- Everything downstream is unchanged: `getTimelineBodyMaterial({ baseHex: hex, ... })`, body fill, border, waveform, metadata chips, fade overlays, title strip, muted multiplier, selected highlight inner ring.

---

## Pattern Block Color Integration

- `drawPatternBlocks` signature gains `trackColorById = null` as last parameter.
- Color source at line ~1076 (same pattern as clips):
  ```js
  const fallbackHex = labelHexColor(region?.label)
  const hex = trackColorById?.[block.trackId] || fallbackHex
  ```
- Dashed top border, mini-note preview, and loop glyph all continue to use the same `hex` variable — no further changes.

---

## Track Header Strip Integration

- `TrackHeaderList.jsx` is the single resolution point for all track header colors.
- One `useEffect` registers one `xleth-theme-changed` listener per mounted list, not one per header.
- `normalizeTrackPalette(rawPalette)` called once per render; `resolveAutoTrackColor` called once per track in the `tracks.map()`.
- `trackColor` passed as prop to `TrackHeader`.
- `TrackHeader.jsx` is a dumb consumer: `const color = trackColor || TRACK_PALETTE_FALLBACK[index % 16]`.
- `tokenValue` import removed from `TrackHeader`. `LABEL_TOKENS` constant removed.

---

## Dark-theme Visual Notes

- Track strips, clips, and pattern blocks now share the same 16-color curated palette designed for dark backgrounds.
- Adjacent tracks are distinct; same-track items visually group.
- Muted tracks/clips continue to dim (0.3 multiplier in `getTimelineBodyMaterial`).
- Selected state retains `--theme-border-focus` inner ring.
- Waveforms and mini-note previews remain readable against the new base hex values.

---

## Light-theme Visual Notes

- Light-theme palette values for `--theme-track-palette-1..16` are shipped from Pass 6B and will be applied automatically.
- `tokenValue()` reads from `:root` computed styles at render time, so light-theme values are picked up correctly when the theme is applied.

---

## Theme-switch Behavior

- **Canvas:** `resolveTimelinePalette()` is called inside `redrawContent()`. Timeline canvas already fires `redrawContent` on `xleth-theme-changed`. `trackPalette` and `trackColorById` are rebuilt on every redraw. No new wiring needed.
- **Track headers:** `TrackHeaderList` increments a counter on `xleth-theme-changed`, triggering a React re-render. On re-render, `tokenValue()` calls return fresh values for the new theme. Strip colors and pattern tint gradients update synchronously.

---

## Performance Notes

- 16 additional `tokenValue()` calls per redraw cycle (inside `resolveTimelinePalette()`), batched with the 17 existing token reads. Not per-clip.
- `buildResolvedTrackColorMap`: one object + N writes per `redrawContent()`. Same cost profile as the existing `mutedTrackIds` Set.
- Per-clip color lookup: `trackColorById?.[clip.trackId]` — single property read, zero `getComputedStyle` calls in loops.
- `TrackHeaderList` palette resolution: 16 `tokenValue()` calls per React render. Renders only when `tracks`, theme, or props change.
- Canvas draw operation count: unchanged.

---

## Behavior Smoke Notes

- Clip move, resize, select/deselect: no geometry or behavior changes — only `hex` source changed.
- Scroll and zoom: unchanged.
- Scrub/playhead: unchanged.
- `getTimelineBodyMaterial`, `withAlpha`, `hexToRgba` signatures unchanged.
- `trackIdToIndex` map in `TimelineCanvas` unchanged; `TrackHeader` drag/drop/reorder unchanged.

---

## Build Result

`npm run build` — **passed** in 2.49s. Pre-existing chunk-size warning (unrelated).

---

## Test Results

`npx vitest run` from `ui/`:

| Suite | Status |
|---|---|
| `src/theming/tokens/__tests__/derivation.test.ts` | 25 passed |
| `src/theming/tokens/__tests__/depth-tokens.test.ts` | 9 passed |
| `src/components/mixer/__tests__/reverbViz.test.js` | 41 passed |
| `src/components/mixer/__tests__/eqSpectrumPath.test.js` | 19 passed |
| `src/components/mixer/__tests__/eqBandInspector.test.jsx` | 30 passed |
| `src/plugin-ui/**` (other passing) | 1218 passed |
| `src/plugin-ui/runtime/__tests__/limiterViz.test.jsx` | 2 **pre-existing failures** — bucket-size-mismatch parser logic |
| `src/plugin-ui/runtime/__tests__/transientViz.test.jsx` | 3 **pre-existing failures** — bucket-size-mismatch parser logic |
| `src/plugin-ui/runtime/__tests__/multibandViz.test.jsx` | 2 **pre-existing failures** — bucket-size-mismatch parser logic |
| `src/plugin-ui/runtime/__tests__/resonanceViz.test.jsx` | 1 **pre-existing failure** — resonance layout size assertion |
| `src/plugin-ui/runtime/__tests__/visualB.test.jsx` | 2 **pre-existing failures** — knob accent token mismatch |

All 11 failing tests are in plugin-UI runtime subsystems unrelated to Timeline or theming. None touch files modified in this pass. No new failures introduced.

---

## Playwright

Not run. Not part of normal local workflow for this pass. Baselines not updated.

---

## Explicit Non-Touches Confirmation

- No `TrackInfo`, `trackColorMode`, `trackColorSlot`, project JSON schema
- No bridge, IPC, preload, main process, or engine files
- No Theme Editor UI
- No theme token files (`catalog.ts`) — only consumed here, not modified
- No theme JSON files
- No `app.css` or `windowing.css`
- No Sample Selector, Mixer, Piano Roll, Sampler, Grid Settings
- No package files (`package.json`, `package-lock.json`)
- No Playwright baselines
- `labelHexColor` function left intact — used as fallback in both draw loops

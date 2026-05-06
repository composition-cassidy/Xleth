# Pass 5B: Timeline Display Settings Plumbing — Deliverable

## Summary

Pass 5B adds the settings store, toolbar popover UI, persistence, and redraw plumbing for Timeline display modes. No clip or pattern rendering was changed. Visual output of the Timeline is identical to before this pass.

---

## Files Changed

| File | Change |
|---|---|
| `ui/src/stores/timelineDisplayStore.js` | **Created** — Zustand store with exported pure helpers, persistence, validation |
| `ui/src/components/timeline/TimelineDisplayPopover.jsx` | **Created** — Compact segmented-control popover with click-outside + Escape close |
| `ui/src/components/timeline/TimelineToolbar.jsx` | **Modified** — Layers button + popover wiring, store subscription |
| `ui/src/components/TimelineView.jsx` | **Modified** — Store import, subscription, redraw effect, `timelineDisplaySettings` prop on TimelineCanvas |
| `ui/src/components/timeline/TimelineCanvas.jsx` | **Modified** — New prop, stable ref, settings threaded into `drawClips` and `drawPatternBlocks` calls |
| `ui/src/components/timeline/timelineDrawing.js` | **Modified** — `drawClips` and `drawPatternBlocks` signatures extended with optional `timelineDisplaySettings = null` |
| `ui/src/styles/app.css` | **Modified** — `.tl-display-*` popover CSS added |
| `ui/src/stores/timelineDisplayStore.test.js` | **Created** — 15 tests for pure helper functions |

---

## Store Schema

Settings key: `timelineDisplaySettings` in `userData/xleth-settings.json`

```js
{
  schemaVersion: 1,
  timelineClipBodyMode: 'plain',           // 'minimal' | 'plain' | 'gradient' | 'solid'
  timelinePatternBodyMode: 'plain',        // 'minimal' | 'plain' | 'gradient' | 'solid'
  timelineBodyGradientDirection: 'top',    // 'top' | 'bottom'
  timelineClipContrast: 'medium',          // 'low' | 'medium' | 'high'
  timelineShowClipNames: 'auto',           // 'auto' | 'always' | 'never'
  timelineShowPitchShift: 'auto',          // 'auto' | 'always' | 'never'
  timelinePitchShiftStyle: 'chip',         // 'chip' (v1 only; not exposed in UI)
  timelineShowWaveforms: 'auto',           // 'auto' | 'always' | 'never'
  timelineShowPatternPreview: 'auto',      // 'auto' | 'always' | 'never'
}
```

Exported pure helpers (importable without store/hydration mocking):
- `TIMELINE_DISPLAY_DEFAULTS` — default values object
- `TIMELINE_DISPLAY_VALIDATORS` — per-key valid value arrays
- `sanitizeTimelineDisplaySettings(raw)` — merges raw object onto defaults, replaces invalid enum values, drops unknown keys

---

## Validation Behavior

- `setTimelineDisplaySetting(key, value)` — ignores unknown keys (warns), ignores invalid enum values (warns)
- `sanitizeTimelineDisplaySettings(null/undefined/string)` → returns `{ ...TIMELINE_DISPLAY_DEFAULTS }`
- `sanitizeTimelineDisplaySettings({})` → returns `{ ...TIMELINE_DISPLAY_DEFAULTS }`
- Invalid enum value for a known key → replaced with default for that key
- Unknown keys in a saved settings object → dropped (strict v1 schema)
- Valid partial objects → merged correctly, preserving valid values

---

## Persistence Behavior

- Read: async IIFE on module load calls `window.xleth?.settings?.get('timelineDisplaySettings')`; sanitizes result before applying to store
- Write: 300ms debounced, calls `window.xleth?.settings?.set('timelineDisplaySettings', fullSettingsObject)`
- Graceful fallback if `window.xleth` is unavailable (test/SSR environment): logs warning, uses defaults
- No changes to `ui/main.js` or `ui/preload.js` — existing generic settings API is sufficient

---

## Popover Controls

Toolbar button: `<Layers size={14} />` using `.timeline-tool-btn` with `.active` state when open.

| Section label | Setting key | Options |
|---|---|---|
| Clip body | `timelineClipBodyMode` | Min / Plain / Grad / Solid |
| Pattern body | `timelinePatternBodyMode` | Min / Plain / Grad / Solid |
| Gradient | `timelineBodyGradientDirection` | Top / Bottom — **disabled** when neither body mode is `'gradient'` |
| Contrast | `timelineClipContrast` | Low / Med / High |
| Names | `timelineShowClipNames` | Auto / Always / Never |
| Metadata | `timelineShowPitchShift` | Auto / Always / Never |
| Waveforms | `timelineShowWaveforms` | Auto / Always / Never |
| Pattern preview | `timelineShowPatternPreview` | Auto / Always / Never |

`timelinePitchShiftStyle` is not exposed (v1 only has `chip`; kept internal for forward compatibility).

**Close behavior:** click outside (checked via refs to both the button and popover to avoid immediate self-close on opening click) or press Escape.

---

## Redraw Plumbing

1. `TimelineView.jsx` subscribes: `const { timelineDisplaySettings } = useTimelineDisplayStore()`
2. `TimelineView.jsx` effect: `useEffect(() => { canvasRef.current?.redrawContent('display-settings') }, [timelineDisplaySettings])`
3. `TimelineView.jsx` passes `timelineDisplaySettings={timelineDisplaySettings}` to `<TimelineCanvas>`
4. `TimelineCanvas.jsx` stores in `timelineDisplaySettingsRef` (direct assignment on each render, consistent with `activeSampleIdRef`, `stickyNoteLengthRef` pattern)
5. `redrawContent()` passes `timelineDisplaySettingsRef.current` as the last argument to both `drawClips` and `drawPatternBlocks`

Grid is **not** redrawn when display settings change — correct, since display settings do not affect grid rendering.

---

## Drawing Function Signature Changes

```js
// Before
drawClips(ctx, w, h, scrollOffset, ppb, clips, trackIdToIndex, regions,
  selectedClipIds, waveformCache, hiResCache, clipPeakCache, bpm,
  mutedTrackIds, palette = null)

// After
drawClips(ctx, w, h, scrollOffset, ppb, clips, trackIdToIndex, regions,
  selectedClipIds, waveformCache, hiResCache, clipPeakCache, bpm,
  mutedTrackIds, palette = null, timelineDisplaySettings = null)
```

```js
// Before
drawPatternBlocks(ctx, w, h, scrollOffset, ppb, blocks, trackIdToIndex, patterns,
  regions, selectedBlockIds, mutedTrackIds, palette = null)

// After
drawPatternBlocks(ctx, w, h, scrollOffset, ppb, blocks, trackIdToIndex, patterns,
  regions, selectedBlockIds, mutedTrackIds, palette = null, timelineDisplaySettings = null)
```

**No changes to the function bodies.** The parameter is accepted but not read. Provides the correct call signature for Pass 5C.

---

## Rendering Output Confirmation

Timeline visual output is **unchanged** after this pass. No body fill formulas, text rendering, waveform rendering, pattern preview rendering, fades, loop glyphs, selection highlights, resize handles, or metadata chips were modified.

---

## Build and Test Results

### Build
```
✓ built in 2.43s (no new errors; pre-existing chunk-size warning unrelated to this pass)
```

### Store tests
```
✓ src/stores/timelineDisplayStore.test.js  15 tests  3ms
```
Note: `[TimelineDisplay] Could not load saved settings, using defaults: ReferenceError: window is not defined` warning is expected (hydration IIFE runs in Node test environment; handled gracefully via `?.` optional chaining).

### Theme tests
```
✓ src/theming/tokens/__tests__/helpers/colorDistance.test.ts  6 tests
✓ src/theming/tokens/__tests__/derivation.test.ts             25 tests
✓ src/theming/tokens/__tests__/depth-tokens.test.ts           9 tests
✓ src/theming/__tests__/tokenValue.test.ts                    6 tests
```
**Total: 61 tests passed.**

### Playwright
Result: **1 failed** (Electron closed before page attach — pre-existing infrastructure issue unrelated to this pass), **28 did not run**. No baselines updated.

---

## Scope Confirmation

The following were **not** touched:

- `engine/**` — ✓ untouched
- `bridge/**` — ✓ untouched
- `ui/main.js` — ✓ untouched
- `ui/preload.js` — ✓ untouched
- Project save/load schema — ✓ untouched
- Package files (`package.json`, `package-lock.json`, etc.) — ✓ untouched
- No new dependencies added — ✓ confirmed
- Playwright baselines — ✓ untouched
- Clip drawing behavior — ✓ unchanged
- Pattern drawing behavior — ✓ unchanged
- Waveform rendering — ✓ unchanged
- Text/name rendering — ✓ unchanged
- Metadata rendering — ✓ unchanged
- IPC APIs — ✓ unchanged

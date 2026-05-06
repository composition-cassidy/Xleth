# UI Depth Pass 5D: Timeline Block Title Strips & Metadata Chips — Deliverable

## Status

Implemented. Drawing-only changes inside `ui/src/components/timeline/timelineDrawing.js`. Outer block geometry, hit testing, snap, move/resize/split/delete, playback timing, waveform/peak caches, and project schema are untouched. Build passes; vitest reports 11 pre-existing failures, all in `plugin-ui/runtime` and `plugin-ui/schema`, none related to timeline.

## Files changed

| Path | Change |
| --- | --- |
| `ui/src/components/timeline/timelineDrawing.js` | Extended `normalizeTimelineDisplaySettings`; added Pass-5D constants, `getTimelineBlockInnerLayout`, `fitText`, `getTitleStripStyle`, `buildClipMetadataChips`, `drawMetadataChips`; rewrote name+metadata in `drawClips`; reorganized `drawPatternBlocks` for title strip + dashed-border draw order. |
| `docs/plans/ui-depth-pass5d-timeline-block-headers-metadata.md` | This deliverable doc. |

`ui/src/components/timeline/TimelineCanvas.jsx` was not modified — it already passes the unified `timelineDisplaySettings` object to both draw functions and required no signature change.

## Settings consumed (this pass)

`drawClips` and `drawPatternBlocks` now consume the full normalized settings:

- `timelineShowClipNames` — `auto` | `always` | `never` (gates title strip + name in both audio and pattern blocks)
- `timelineShowPitchShift` — `auto` | `always` | `never` (gates metadata chips in audio clips)
- `timelinePitchShiftStyle` — `chip` (only chip style supported in v1)

The Pass-5C settings (`timelineClipBodyMode`, `timelinePatternBodyMode`, `timelineBodyGradientDirection`, `timelineClipContrast`, `timelineShowWaveforms`, `timelineShowPatternPreview`) continue to be consumed exactly as before. Pass 5D never overrides the 5C waveform/preview gates.

## Helpers added

All helpers live in `timelineDrawing.js`. The drawing module remains pure (no Zustand import, no `window.xleth` read, no `getComputedStyle` in inner loops).

- `getTimelineBlockInnerLayout({ x, y, w, h, kind, showTitleStrip })` — returns `{ titleX, titleY, titleW, titleH, contentX, contentY, contentW, contentH, metadataArea, useStrip, kind }`. Suppresses the title strip when `h < TITLE_STRIP_MIN_H` (28px).
- `fitText(ctx, text, maxWidth, { allowBareEllipsis })` — measured truncation via `ctx.measureText`. Binary-searches the longest prefix that fits with `…`; returns `''` when only the ellipsis fits and `allowBareEllipsis` is false. Worst-case ~`log2(N)` measurements per visible block.
- `getTitleStripStyle(baseHex, mode, selected, muted, contrast)` — returns `{ fill, separator }` strings with restrained alpha; no shadows, no glow.
- `buildClipMetadataChips(clip)` — reads the existing inline-metadata fields verbatim (`pitchOffset`, `pitchOffsetCents`, `stretchRatio`, `reversed`, `velocity`) and emits `[procChip?, gainChip?]`.
- `drawMetadataChips(ctx, chips, area, palette, { handleReserveRight, leftLimit })` — explicit-priority placement: processing chip wins the rightmost slot; gain chip is placed left of it only if it fits; if processing alone doesn't fit, nothing is drawn; if processing is absent, gain may take the rightmost slot.

## Layout constants

```js
TITLE_STRIP_H        = 16
TITLE_STRIP_TOP      = 0
TITLE_STRIP_MIN_H    = 28
TITLE_TEXT_PAD_X     = 6
TITLE_CONTENT_GAP    = 2
CHIP_H               = 12
CHIP_GAP             = 3
CHIP_PAD_X           = 5
CHIP_RIGHT_INSET     = 6
CHIP_BOTTOM_INSET    = 4
NAME_AUTO_MIN_W      = 48
NAME_ALWAYS_MIN_W    = 18
META_AUTO_MIN_W      = 72
META_ALWAYS_MIN_W    = 40
TINY_CLIP_MAX_W      = 24
PATTERN_LOOP_GLYPH_RESERVE = 14
```

## Title strip rules

- The title strip is enabled only when `clipH >= TITLE_STRIP_MIN_H` (28px), `showName !== 'never'`, and `clipW > TINY_CLIP_MAX_W` (24px).
- Strip background fill comes from `getTitleStripStyle(hex, mode, selected, muted, contrast)` — a same-hex overlay, slightly stronger than the body fill so the title reads cleanly without a heavy contrast jump.
- Strip alpha by mode:
  - `minimal`: 0.26 / 0.34 (unselected / selected)
  - `plain` (default): 0.74 / 0.88
  - `gradient`: 0.78 / 0.88
  - `solid`: 0.84 / 0.92
- Multiplied by `_contrastMul(contrast)` (`low: 0.82`, `medium: 1.0`, `high: 1.18`) and by `0.3` if the track is muted.
- Bottom 1px separator at the same hex with alpha 0.55 × contrast × muted-mul.
- No `ctx.shadowBlur`, no glow.

## Text truncation rules

`fitText` is now used everywhere a clip or pattern name renders.

- If full text fits the available width: return full text (single `measureText` call).
- Else binary-search the longest prefix `prefix + '…'` that fits.
- Else if `allowBareEllipsis` and `'…'` itself fits: return `'…'`.
- Else return `''`.

Visibility:

- `never` → don't draw.
- `always` → draw when `titleAvailW >= NAME_ALWAYS_MIN_W` (18px); allow bare ellipsis.
- `auto` → draw when `titleAvailW >= NAME_AUTO_MIN_W` (48px); never draw bare ellipsis.

`titleAvailW = titleW − TITLE_TEXT_PAD_X*2 − handleReserveRight − handleReserveLeft − (pattern: glyphReserve)`. Reserves are 4px (HANDLE_W) when the corresponding resize handle is drawn.

## Metadata chip rules

- Chips render only on audio clips. Pattern blocks do not get chips in v1.
- Chip content is built from the same fields the prior inline metadata block read:
  - Processing chip text: any combination of `+/-Nst`, `+/-Nc`, `REV`, `R.RR×`.
  - Gain chip text: `±D.DdB`, only when `velocity` is finite, positive, and `|dB| >= 0.1`.
- Visibility:
  - `never` → no chips.
  - `always` → eligible when `clipW >= META_ALWAYS_MIN_W` (40px).
  - `auto` → eligible when `clipW >= META_AUTO_MIN_W` (72px).
- Placement: bottom-right of the clip rect at `(clipX + clipW − 6, clipY + clipH − 4)`, chip height 12, padding 5px, gap 3px.
- Priority: processing chip is **always rightmost**. Gain only sits to its left if it has room. If processing exists but cannot fit, neither chip is drawn. If processing is absent, gain may take the rightmost slot.
- Right-side handle reservation: `HANDLE_W` (4px) is subtracted from `rightX` when the clip is selected, so chips never overlap a resize handle.
- Left-side limit: `clipX + (selected ? HANDLE_W : 0) + 2` so chips never escape the clip rect or sit under the left handle.
- Background uses `palette.clipPitchBoxBg`; foreground uses `palette.clipPitchBoxFg` — the same theme-aware tokens used by the previous inline metadata box.

## Waveform region change (audio clips)

Where the waveform was previously drawn against the full clip rect `(x, y, clipW, clipH)`, it is now drawn against the inner content region:

| Site | Before | After |
| --- | --- | --- |
| Inner clip rect for `ctx.clip()` | `(x, y, clipW, clipH)` | `(layout.contentX, layout.contentY, layout.contentW, layout.contentH)` |
| `drawSamplePoints` y/h params | `y, clipH` | `layout.contentY, layout.contentH` |
| `drawTrace` (hi-res path) y/h | `y, clipH` | `layout.contentY, layout.contentH` |
| `drawWaveformLine` y/h | `y, clipH` | `layout.contentY, layout.contentH` |
| `drawTrace` (clip-peak fallback) y/h | `y, clipH` | `layout.contentY, layout.contentH` |
| `drawEnvelope` (clip-peak fallback) y/h | `y, clipH` | `layout.contentY, layout.contentH` |
| `drawTrace` (region-cache fallback) y/h | `y, clipH` | `layout.contentY, layout.contentH` |
| `drawEnvelope` (region-cache fallback) y/h | `y, clipH` | `layout.contentY, layout.contentH` |

X-axis math (`visL`, `visR`, `secPerPx`, regime selection, hi-res / clip-peak / region-peak cache lookups, stride math, `hasProcessing` detection) is **unchanged**. Caches, cache keys, and invalidation are **unchanged**. The four draw helper signatures are not modified — only the values passed at call sites.

When the title strip is suppressed (because `clipH < 28`, or `showName === 'never'`, or the clip is tiny), `layout.useStrip` is false and `(contentX, contentY, contentW, contentH) === (x, y, clipW, clipH)`, so the waveform fills the full block as before.

Fade overlays continue to clip to the full block `(x, y, clipW, clipH)` — fade geometry is unchanged. Selection inner highlight ring remains at `(x+1.5, y+1.5, clipW−3, clipH−3)`.

Resize handles are now drawn **after** the title strip, so they remain solid 4px hex bars on top of the strip area.

## Mini-note preview region change (pattern blocks)

The mini-note preview is now confined to `(layout.contentX, layout.contentY, layout.contentW, layout.contentH)`:

- Inner-clip rect for `ctx.clip()`: `(x, y, blockW, clipH)` → `(layout.contentX, layout.contentY, layout.contentW, layout.contentH)`.
- `innerH = clipH − 4` → `innerH = layout.contentH − 4`.
- `ny = y + 2 + …` → `ny = layout.contentY + 2 + …`.

Loop iteration math, `firstLoop`/`lastLoop`, `blockLoopEnabled` clamp, pitch normalization, note durations, and pixel mapping are **unchanged**.

## Pattern dashed-border draw order

Previously the dashed top border was drawn before the (now non-existent) name overlay. Pass 5D draws in this order:

1. Body fill (5C material).
2. Body border (5C material).
3. Selection inner highlight ring.
4. **Title strip background + bottom separator.**
5. **Dashed top border (re-drawn after the strip so its dashes remain visible at `y + 1`).**
6. Mini-note preview inside the content region.
7. Resize handle (right side only, when selected).
8. Loop glyph (top-right of the title strip area at `x + blockW − 14, y + 2`).
9. Pattern title text inside the title strip, with `glyphReserve = 14px` reserved on the right when a loop glyph is drawn.

The dashed-border color (semantic hex), line width (2px), and dash pattern (`[4, 3]`) are unchanged.

## Confirmation: outer geometry & behavior unchanged

- Outer clip and pattern-block rectangles are drawn at the exact same `(x, y, w, h)` as before. Only inner draw regions for waveform/notes and the title-strip overlay were added.
- Resize handle width and x-positions are unchanged; only their draw order changed.
- Hit testing (in `TimelineCanvas.jsx`) is unmodified.
- Snap, move, resize, split, delete, scrub, and playback behavior are unmodified — none of these read from `timelineDrawing.js`.
- Project save/load schema is untouched.
- Engine, bridge, IPC, package files, Playwright baselines, and Timeline tool files are untouched.

## Visual notes

- **Tiny clips (≤ 24px)**: body + border + selection ring + (when selected) handles only. No title, no chips. Waveform behavior follows 5C.
- **Narrow clips (25–47px)**: in `always` mode the title strip can render with a bare ellipsis; in `auto` mode, no title. Chips: only `always` mode at 40+ px.
- **Medium clips (48–139px)**: name renders in title strip; one chip may render when wide enough.
- **Wide clips (≥ 140px)**: full title + both chips when present.
- **Light theme**: title strip reads as a slightly stronger same-hue band; chip uses the existing `clipPitchBoxBg` token already tuned for light theme.
- **Dark theme**: title strip is restrained, no glow; separator visible without harsh contrast.
- **Pattern blocks**: dashed top border remains crisp on top of the strip; loop glyph preserved at top-right; name centered vertically in the strip; mini-notes start cleanly below the separator.

## Performance notes

- `getTitleStripStyle` is called once per visible block (~5 alpha lookups + two `hexToRgba` calls). No `getComputedStyle`. No token map reads.
- `fitText` worst-case is ~`log2(name.length)` `measureText` calls per visible block; full-text first measurement short-circuits when the name fits.
- `drawMetadataChips` performs at most two `measureText` calls per visible clip (one per chip).
- No `ctx.shadowBlur` anywhere in the new code.
- No new caches; no allocations in inner loops beyond the small per-clip chip array.
- Dense timeline scroll/zoom should remain at the same FPS as Pass 5C — chip and title work scales linearly with the visible block count, with cost dominated by existing waveform/note rendering.

## Behavior smoke

Static analysis only (Electron not launched). Behavioral code paths unchanged because:

- No edits in `TimelineCanvas.jsx` (the file owning hit-testing, mouse handlers, snap, drag, resize, split, delete, scrub).
- No edits in `commands/TimelineCommands.*`, `model/Timeline.*`, or any other behavior-bearing files.
- Pass 5D edits are scoped strictly to canvas paint logic in `timelineDrawing.js`.

## Build / test results

- `npm run build` — **PASS**. Bundles produced; only the pre-existing chunk-size advisory warning fires.
- `npx vitest run` — **1207 passed, 11 failed, 3 skipped**. The 11 failures are all in `src/plugin-ui/runtime/__tests__/limiterViz`, `multibandViz`, `resonanceViz`, `transientViz`, `visualB`, and `src/plugin-ui/schema/__tests__/visualA` — about parseDrainResponse schemas and knob appearance presets. None reference timeline code. Confirmed pre-existing by topic; not introduced by this pass.
- Targeted: `npx vitest run src/stores/timelineDisplayStore.test.js` — **15 passed**, confirming the settings store remains correct (the new normalizer keys do not change the store API).

## Playwright

`XLETH_PLAYWRIGHT=1 npx playwright test` was attempted with the standard config.

- **Result: 1 failed, 28 did not run.** All 29 baseline capture specs effectively skipped because the very first spec (`01-app-default`) failed to attach: `page.waitForSelector('.app', { timeout: 30_000 })` raised `Target page, context or browser has been closed`. Electron exited before the React root mounted.
- This is an environment / Electron attach failure, not a UI regression. No baselines were updated. Re-running once Electron startup attaches successfully is the correct follow-up; nothing in Pass 5D affected the Electron startup path.

## Browser preview

The Vite dev server alone does not exercise this code path. The Timeline canvas requires `window.xleth` IPC plus engine state (tracks, regions, clips, patterns) that only flow through Electron. With no engine attached, the Vite app shows an empty pre-load state and never invokes `drawClips`/`drawPatternBlocks`. Per the verification workflow's "skip when not observable in preview" guidance, no preview verification is included for this pass; the build + targeted vitest + scope-check + Playwright attempt collectively cover what's verifiable headlessly.

## Untouched (explicit)

- Engine code (`engine/**`)
- Bridge code (`bridge/**`)
- IPC (`ui/main.js`, `ui/preload.js` IPC channels)
- Project save/load schema
- Package files (`package.json`, `package-lock.json`, `electron-builder.json`)
- Playwright baselines (`tests/baseline/**`)
- Timeline tool files (`ui/src/components/timeline/TimelineToolbar.jsx`, ruler, popover, etc.)
- Hit testing, snapping, clip movement / resize / split / delete logic
- Waveform / clip-peak cache invalidation paths
- Outer block geometry, track height, resize-handle geometry

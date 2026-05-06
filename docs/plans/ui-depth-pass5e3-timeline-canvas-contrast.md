# UI Depth Pass 5E.3 — Timeline Canvas FL/VEGAS Contrast

Status: implemented.
Predecessors: Pass 5E.0 (diagnostic), 5E.1 (lane-bg token registration), 5E.2 (non-canvas CSS contrast).
Companion implementation plan: `~/.claude/plans/pass-5e-3-timeline-canvas-abstract-whale.md`.

## Goal

Wire the Pass 5E.1 `--theme-timeline-lane-bg` token into the Timeline arrangement canvas, then strengthen lane separators, dark-theme grid lines, plain-mode clip/pattern body alphas, and the title-strip alpha so the arrangement reads with FL/VEGAS-style contrast hierarchy: darker bed, stronger seams, clearer grid, brighter clips, readable title bands.

## Files changed

1. `ui/src/components/timeline/timelineDrawing.js`
2. `ui/src/theming/tokens/catalog.ts`
3. `docs/plans/ui-depth-pass5e3-timeline-canvas-contrast.md` (this file)

No theming test changes required — no test pinned the four grid-token values, and the existing `timeline-lane-bg-token.test.ts` continues to pass unchanged.

## Palette wiring change — `resolveTimelinePalette()`

`ui/src/components/timeline/timelineDrawing.js:31-32`

```diff
- bg:                tokenValue('--theme-bg-inset'),
- laneSeparator:     tokenValue('--theme-border-subtle'),
+ bg:                tokenValue('--theme-timeline-lane-bg'),
+ laneSeparator:     tokenValue('--theme-border-strong'),
```

`--theme-bg-inset` continues to back Piano Roll, tooltips, sample picker thumbnails, and other shared inset surfaces — its value is untouched. `--theme-border-strong` resolves dark to `rgba(232, 232, 237, 0.25)`, which against the new `#07070B` bed produces a definite seam without going to a hard 1px neon line. Palette resolution remains once per redraw and threaded down into `drawClips` / `drawPatternBlocks`; no per-item `tokenValue` calls were added.

## Token-value changes — `catalog.ts:577-583`

Dark default values for the four Timeline grid tokens were raised. All four were already authored in `catalog.ts` (no shipped-JSON duplication), so the catalog is the single source.

```diff
- explicit('--theme-timeline-bar-line',        'rgba(255, 255, 255, 0.14)', ...)
- explicit('--theme-timeline-beat-line',       'rgba(255, 255, 255, 0.06)', ...)
- explicit('--theme-timeline-subdivision-line','rgba(255, 255, 255, 0.03)', ...)
- explicit('--theme-timeline-pattern-lane-tint','rgba(106, 169, 255, 0.04)', ...)
+ explicit('--theme-timeline-bar-line',        'rgba(255, 255, 255, 0.26)', ...)
+ explicit('--theme-timeline-beat-line',       'rgba(255, 255, 255, 0.11)', ...)
+ explicit('--theme-timeline-subdivision-line','rgba(255, 255, 255, 0.05)', ...)
+ explicit('--theme-timeline-pattern-lane-tint','rgba(106, 169, 255, 0.07)', ...)
```

Light values in `xleth-light.json` (bar `0.28`, beat `0.14`, subdivision `0.07`, pattern tint `rgba(0,40,120,0.04)`) were already strong per the 5E.0 diagnostic and are intentionally untouched.

## Plain-mode body alpha changes — `getTimelineBodyMaterial()`

`ui/src/components/timeline/timelineDrawing.js:451-455`

```diff
  // 'plain' default
  if (kind === 'audio') {
-   fillAlphaA = selected ? 0.80 : 0.60
+   fillAlphaA = selected ? 0.90 : 0.80
  } else {
-   fillAlphaA = selected ? 0.75 : 0.55
+   fillAlphaA = selected ? 0.86 : 0.72
  }
```

Only the `plain` branch of the body-mode switch changed. Contrast multiplier (`_contrastMul`: low 0.82 / medium 1.0 / high 1.18), mute multiplier (`mm = muted ? 0.3 : 1.0`), `_clampAlpha`, border width (`selected ? 2 : 1`), and the minimal / gradient / solid branches are untouched. The semantic `baseHex` per-clip color is unchanged — only the alpha applied to it. Final alpha is still `_clampAlpha(fillAlphaA * cm * mm)` so muted and contrast scaling continue to compose against the new defaults.

## Title-strip alpha change — `getTitleStripStyle()`

`ui/src/components/timeline/timelineDrawing.js:556`

```diff
- else                          stripA = selected ? 0.88 : 0.74
+ else                          stripA = selected ? 0.92 : 0.80
```

Strip remains a same-hex overlay over the body. With body unselected at 0.80 and strip at 0.80, alpha-compositing two identical colors yields ~0.96 effective at the strip vs 0.80 at the body — about 16 opacity points of separation. This is less spread than the prior state (0.74-over-0.60 → ~0.90 vs 0.60, ~30 points), but the strip-separator line and strip text continue to carry the visual band. The plan flags this as the smoke-time risk: if visual review against real content shows the strip dissolving into the body, raise unselected to `0.86` and selected to `0.94` — do **not** introduce per-clip theme reads.

Minimal / gradient / solid title-strip alphas, the constant strip separator alpha (`0.55 * cm * mm`), and the strip-vs-body geometry (`TITLE_STRIP_H = 16`, `TITLE_STRIP_MIN_H = 28`, etc.) are unchanged.

## Build & test results

Run from `ui/`.

- `npm run build` → `built in 2.42s`. Vite chunk-size warning for `index-CcPUhSUY.js` (601 kB) is pre-existing, unrelated to this pass.
- `npx vitest run src/theming` → **49 / 49 passed** across 5 files (helpers, derivation, depth-tokens, timeline-lane-bg-token, tokenValue). The `--theme-timeline-lane-bg` registration test still passes (we did not change its value); `derivation.test.ts` passes (we changed the lane-separator *consumer* from `border-subtle` to `border-strong`, not the value of `border-subtle` itself).
- `npx vitest run` (full UI suite) → **1210 passed / 11 failed / 3 skipped** across 58 test files. The 11 failures are all in `src/plugin-ui/runtime/__tests__/visualB.test.jsx` and `src/plugin-ui/schema/__tests__/visualA.test.js`, asserting on `--theme-accent` vs `--theme-border-focus` defaults and `accent.primary` vs `accent.focus` plugin-UI knob appearance fallbacks. Grep against the failing test files confirms **none** of them reference `--theme-timeline-lane-bg`, `--theme-border-strong`, `--theme-border-subtle`, or any of the four grid tokens — these failures are pre-existing and unrelated to Pass 5E.3.

## Visual smoke

Limited. The Vite-only dev server (`vite --port 5174`, started via `preview_start`) does not have the Electron engine bridge attached, so adding a track via the `Add Track` button crashes `TrackHeader.jsx` (`PanelVisibilityProvider → TimelinePanel → TimelineView → TrackHeaderList → TrackHeader`). This is **pre-existing behavior of Vite-only mode**, not a regression introduced by Pass 5E.3 — the crash happens before any of the changed drawing/palette code is reached. Without a track, the Timeline canvas does not mount, so live clip/pattern/title-strip contrast cannot be sampled in this environment.

What was verified in the preview:

- All five touched tokens resolve in the live document at the new values:
  - `--theme-timeline-lane-bg` = `#07070B`
  - `--theme-bg-inset` = `#0d0d14` (unchanged — chrome reference)
  - `--theme-bg-secondary` = `#111118` (unchanged — chrome reference)
  - `--theme-bg-surface` = `#1A1A24` (unchanged — chrome reference)
  - `--theme-border-strong` = `rgba(232, 232, 237, 0.25)` (unchanged token, now consumed for lane separators)
  - `--theme-timeline-bar-line` = `rgba(255, 255, 255, 0.26)`
  - `--theme-timeline-beat-line` = `rgba(255, 255, 255, 0.11)`
  - `--theme-timeline-subdivision-line` = `rgba(255, 255, 255, 0.05)`
  - `--theme-timeline-pattern-lane-tint` = `rgba(106, 169, 255, 0.07)`
- The lane bed (`#07070B`, sRGB L\* ≈ 4) sits visibly darker than every adjacent chrome surface (`bg-inset` L\* ≈ 7, `bg-secondary` L\* ≈ 8, `bg-surface` L\* ≈ 12). The "arrangement pit" effect required by the 5E.0 diagnostic is satisfied by the value relationship.

What still needs full-app smoke (recommend running with `npm run dev` against the real engine):

- Lane-separator readability against the new `#07070B` bed.
- Bar / beat / subdivision visual hierarchy at standard zoom and at zoom-in/out extremes.
- Plain-mode audio and pattern clip pop against the bed (unselected and selected).
- Muted clips remain visibly attenuated (`mm = 0.3` unchanged).
- Selected-clip border + lifted alpha still reads without becoming neon.
- **Title-strip vs body contrast** — the spec-§7 risk. If unselected strips dissolve into the brighter body, raise `getTitleStripStyle()` plain to `0.86 / 0.94` and re-smoke.
- Light-theme behavior with `#CACAC6` bed: confirm the light bed reads as a pit against light chrome and that clip text + chip text remain readable. If light clips become over-saturated, document — do not add per-clip theme reads.
- Display popover: cycle body modes (minimal / plain / gradient / solid) × contrast (low / medium / high) and confirm `plain` is now the strongest, with other modes still distinguishable.

## Behavior, performance, and scope

- Zero behavior changes. Clip position math, width/duration math, pattern block geometry, fade geometry, loop glyph geometry, resize handles, hit testing, snapping, move/resize/split/delete, playback/playhead timing, clip cache invalidation, waveform regime selection / cache keys / lookups / invalidation, peak cache keys / lookups / invalidation, and project save/load schema are all untouched.
- Zero performance changes. Palette is still resolved once per redraw and threaded down. No new `tokenValue` lookups, no `getComputedStyle` calls, no theme-marker reads, and no new branches were added inside `drawClips` or `drawPatternBlocks` per-item loops. No `ctx.shadowBlur`, no new fill/stroke calls, no new caches. Alpha-only changes preserve the existing canvas operation count.
- No clip / pattern outer geometry changes. Title-strip height (`TITLE_STRIP_H = 16`, `TITLE_STRIP_MIN_H = 28`), title text padding, metadata chip layout, name truncation thresholds, and width thresholds for chips are unchanged from Pass 5D.

## Playwright

Not attempted in this pass. The codebase's Playwright suite consumes baseline snapshots; running it would be informational only since this pass intentionally changes pixel output (lane bed, grid lines, body alphas, strip alphas) and any visual diff would be expected. Per spec instruction, baselines were **not** updated. Recommend running `XLETH_PLAYWRIGHT=1 npx playwright test` after full-app smoke confirms the chosen final alphas, then capturing a deliberate baseline refresh in a follow-up pass.

## Untouched (explicit confirmation)

The following were verified untouched by Pass 5E.3:

- `ui/src/styles/app.css`
- `ui/src/styles/windowing.css`
- `ui/src/components/timeline/TimelineCanvas.jsx`
- All Timeline tool files (`timelineTools/*`, hit testing, snapping)
- Mixer (`MixerPanel.*`, `mixer-strip.*`, etc.)
- Sample Selector (`SamplePicker/*`, `SampleSelectorTab.jsx`)
- Project Media (`SourceCard*`, project-media surfaces)
- Grid Settings, Piano Roll (`pianoRoll/*`), Sampler (`sampler/*`), Preview (`VideoPreview.jsx`)
- Engine, bridge, IPC, project schema, package files
- `ui/tests/baseline/*` Playwright baselines
- `ui/src/theming/shipped/xleth-light.json` (light theme grid values intentionally retained)
- `--theme-bg-inset` value (still backs piano roll, tooltips, sample picker thumbnails, etc.)

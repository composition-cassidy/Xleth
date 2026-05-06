# UI Depth Pass 4B — Timeline Canvas Depth, Hierarchy, Lane & Material

## Summary

The Timeline canvas was the weakest major editor surface after Pass 4A.1
shipped Piano Roll improvements. Its draw functions hardcoded `rgba(255,255,255,…)`
whites for subdivision grid lines, used the cross-subsystem
`--theme-fx-surface-tint-medium` for bar lines, and embedded `'#000'`
labels and `'rgba(0,0,0,0.x)'` overlays — none of which had a light-theme
story. Pass 4B closes that gap by mirroring the Pass 4A.1 pattern:
single-resolution palette helper, theme-aware draws, light-theme overrides,
and a restrained selected-state inner-highlight ring.

## Files changed

- [ui/src/components/timeline/timelineDrawing.js](../../ui/src/components/timeline/timelineDrawing.js)
- [ui/src/components/timeline/TimelineCanvas.jsx](../../ui/src/components/timeline/TimelineCanvas.jsx)
- [ui/src/components/timeline/TimelineRuler.jsx](../../ui/src/components/timeline/TimelineRuler.jsx)
- [ui/src/theming/tokens/catalog.ts](../../ui/src/theming/tokens/catalog.ts)
- [ui/src/theming/shipped/xleth-light.json](../../ui/src/theming/shipped/xleth-light.json)
- this doc

**No edits to** Piano Roll, engine, bridge, IPC, package files, Playwright
baselines, or tools/*.js (only audited; existing token usage was already
correct).

## Drawing architecture (verified)

- `TimelineView.jsx` orchestrates and **already** subscribes to
  `xleth-theme-changed`, calling `redrawGrid('theme')`,
  `redrawContent('theme')`, and `rulerRef.current?.redraw()`. Reused as-is —
  no new listener, no `themeTick` state.
- `TimelineCanvas.jsx` owns three layered canvases (`bgRef`, `ctRef`,
  `ovRef`) and a DOM playhead. Imperative `redrawGrid` /
  `redrawContent` / `redrawOverlay` / `positionPlayhead` handles preserved.
- `TimelineRuler.jsx` owns its own canvas + DOM playhead.
- `timelineDrawing.js` exports pure draw functions; now also exports
  `resolveTimelinePalette()` and `withAlpha()`.
- Tools under `ui/src/components/timeline/tools/` were audited; no behavior
  edits were made.

## Hardcoded constants found and resolved

| File:line (pre-change) | Was | Now |
|---|---|---|
| timelineDrawing.js:99  | `rgba(255,255,255,${alpha})` | `withAlpha(p.gridMinor, mult)` |
| timelineDrawing.js:132 | `tokenValue('--theme-fx-surface-tint-medium')` | `p.gridBar` (FX-leak fixed) |
| timelineDrawing.js:182 | `rgba(255,255,255,${alpha})` | `withAlpha(p.rulerGridMinor, mult)` |
| timelineDrawing.js:350-351 | `'rgba(255,255,255,0.45)'` / `'rgba(255,255,255,0.10)'` waveform fallbacks | `withAlpha(p.clipWaveformFg, 0.7)` / `withAlpha(p.clipWaveformBg, 0.55)` |
| timelineDrawing.js:462 | `'rgba(0, 0, 0, 0.35)'` | `p.clipFadeOverlay` |
| timelineDrawing.js:517 | `'#000'` | `p.clipLabel` |
| timelineDrawing.js:565 | `tokenValue('--theme-timeline-fade-curve-fill')` | `p.clipPitchBoxBg` |
| timelineDrawing.js:567 | `'rgba(255,255,255,0.9)'` | `p.clipPitchBoxFg` |
| timelineDrawing.js:720 | `'rgba(0,0,0,0.8)'` | `p.patternGlyphBg` |
| timelineDrawing.js:735 | `'#000'` | `p.patternLabel` |
| timelineDrawing.js:826 | `'rgba(51,206,214,0.08/0.4)'` | `withAlpha(p.accent, 0.08/0.4)` |
| timelineDrawing.js:872 | `'rgba(255,107,107,0.10/0.4)'` | `withAlpha(p.danger, 0.10/0.4)` |
| TimelineCanvas.jsx:176-177 | per-frame `getComputedStyle(...)` for spinner accent | `palette.accent` (resolved once per `redrawContent`) |
| drawSplitLine, drawDropPreview, drawGhostPreview, drawOverlay, drawRulerOverlay | inline `tokenValue(...)` calls | `palette.{loopBrace,fgInverse,playheadLine,playheadAccent}` |

## Tokens used (existing, no rename)

`--theme-bg-inset`, `--theme-bg-secondary`, `--theme-border-subtle`,
`--theme-border-focus`, `--theme-text`, `--theme-text-placeholder`,
`--theme-fg-inverse`, `--theme-accent`, `--theme-danger`,
`--theme-timeline-pattern-lane-tint`, `--theme-timeline-subdivision-line`,
`--theme-timeline-beat-line`, `--theme-timeline-bar-line`,
`--theme-timeline-playhead-line`, `--theme-timeline-clip-title-fg`,
`--theme-timeline-fade-curve-fill`, `--theme-timeline-clip-waveform-fg`,
`--theme-timeline-clip-waveform-bg`, `--theme-timeline-loop-brace`.

## Tokens added / redefined

- **Redefined** `--theme-timeline-bar-line`: was `ref('--theme-border-subtle')`, now
  explicit `rgba(255, 255, 255, 0.14)` (dark). Necessary because the bar
  line was previously stroked with the cross-subsystem
  `--theme-fx-surface-tint-medium` (`rgba(255,255,255,0.12)`); switching
  to `--theme-border-subtle` would have made bars too weak. The new dark
  value is +0.02 alpha vs. before — a deliberate, restrained hierarchy
  bump that mirrors `--theme-pianoroll-bar-line`'s `rgba(255,255,255,0.14)`.
- **Added** `--theme-timeline-well-top-shadow` (dark default
  `rgba(0,0,0,0.22)`). One token, mirrors `--theme-pianoroll-well-top-shadow`.

## Light-theme overrides added (xleth-light.json)

Nine additions, all to existing or new timeline tokens:

```
--theme-timeline-bar-line:          rgba(0, 0, 0, 0.28)
--theme-timeline-beat-line:         rgba(0, 0, 0, 0.14)
--theme-timeline-subdivision-line:  rgba(0, 0, 0, 0.07)
--theme-timeline-clip-waveform-fg:  rgba(0, 0, 0, 0.55)
--theme-timeline-clip-waveform-bg:  rgba(0, 0, 0, 0.18)
--theme-timeline-fade-curve-fill:   rgba(0, 0, 0, 0.20)
--theme-timeline-loop-brace:        rgba(180, 140, 0, 0.8)
--theme-timeline-pattern-lane-tint: rgba(0, 40, 120, 0.04)
--theme-timeline-well-top-shadow:   rgba(0, 0, 0, 0.10)
```

## Palette resolver details

`resolveTimelinePalette()` lives at the top of `timelineDrawing.js` and
returns a plain object with named roles. It is called once per redraw —
once per `redrawGrid`, once per `redrawContent`, once per ruler `redraw`.
No `getComputedStyle` or `tokenValue` is invoked inside per-clip,
per-grid-line, per-pattern, or per-tick loops. Roles: `bg`, `laneSeparator`,
`patternLaneTint`, `gridMinor`, `gridBeat`, `gridBar`, `rulerBg`,
`rulerText`, `rulerBorder`, `rulerGridMinor`, `playheadLine`,
`playheadAccent`, `clipLabel`, `clipFadeOverlay`, `clipWaveformFg`,
`clipWaveformBg`, `clipPitchBoxBg`, `clipPitchBoxFg`, `patternLabel`,
`patternGlyphBg`, `selectionHighlight`, `loopBrace`, `accent`, `danger`,
`fgInverse`, `wellTopShadow`.

`withAlpha(color, mult)` is a small helper that returns a CSS color
string with its alpha scaled by `mult`, clamped to `[0,1]`. Supports
`rgba(r,g,b,a)`, `rgb(r,g,b)`, `#RRGGBB`, `#RGB`. Any other input
(`hsl()`, `color()`, named colors, custom theme exotica) is returned
unchanged so canvas drawing never breaks. Empty/whitespace input returns
unchanged.

## Theme-change redraw mechanism

Reused existing wiring at `TimelineView.jsx:947-955` — no new listener,
no `themeTick`. The `xleth-theme-changed` handler calls
`canvasRef.current?.redrawGrid('theme')`,
`canvasRef.current?.redrawContent('theme')`, and
`rulerRef.current?.redraw()`. Each of those resolves a fresh palette
object, so token changes propagate immediately without React state churn.

## Draw-order changes

Identical to before, with one addition and two clarifications:

- `drawGrid` now ends with a single full-width top-edge gradient (~14px,
  `wellTopShadow → transparent`). One gradient per redraw, no
  `shadowBlur`. Skipped if the token resolves to empty or `transparent`,
  giving themes a clean opt-out.
- `drawClips` adds a 1px inner-highlight ring on selected clips, drawn
  immediately after the existing colored border. One extra `strokeRect`
  per selected clip; bounded by selection size.
- `drawPatternBlocks` adds the same 1px inner ring on selected blocks.
  The dashed top border (the visual distinguisher between patterns and
  audio clips) is unchanged.

## Clip / pattern material changes

- Per-track semantic clip colors preserved: every
  `hexToRgba(hex, alpha)` call with `(selected ? 0.8 : 0.6) * mutedMul`
  for clips and `(selected ? 0.75 : 0.55) * mutedMul` for patterns is
  untouched. The clip's hex source comes from `labelHexColor(region.label)`.
- Selection contrast comes from the new inner-highlight ring using
  `--theme-border-focus`, not by mutating per-track colors.
- Waveform colors (when not selected) are now `withAlpha(...)` of the
  themed `clipWaveformFg/Bg` rather than the previous
  `'rgba(255,255,255,0.45/0.10)'` whites — works in both themes.
- Fade overlay, pitch/stretch box bg+fg, pattern loop glyph bg, and clip
  / pattern labels are all themed.

## Grid / lane hierarchy changes

- Bar > beat > subdivision hierarchy preserved with explicit per-theme
  alpha:
  - dark: bar 0.14 / beat 0.06 / subdivision base 0.03 × multiplier ladder
  - light: bar 0.28 / beat 0.14 / subdivision base 0.07 × multiplier ladder
- Subdivision multiplier ladder `[1.0, 0.83, 0.67, 0.5]` reproduces the
  historical `[0.03, 0.025, 0.02, 0.015]` proportional curve from a
  single themed base color.
- Track separators use `--theme-border-subtle` (unchanged), with the
  added top-edge well shadow giving the canvas a recessed surface feel.
- Alternating lane backgrounds were intentionally **not** added — the
  pattern-track tint already differentiates pattern vs. audio rows, and
  generic odd/even alternation would compete with the per-track
  semantic colors. Parked for a possible future per-track tint pass.

## Dark-theme visual notes

- Bar lines are slightly stronger (+0.02 alpha) than before, reflecting
  the deliberate hierarchy bump.
- Subdivisions stay at the same effective alpha as before.
- The top-edge well shadow lives below the ruler's own bottom border;
  the gradient peaks at `rgba(0,0,0,0.22)` over `--theme-bg-inset`,
  giving a subtle recessed feel. If visual review shows it doubles the
  ruler/canvas divider, the token can be set to transparent in that
  theme to opt out — drawing is conditional.
- Tool overlays (rubber-band, delete-sweep) now derive from
  `--theme-accent` and `--theme-danger`. With the dark accent at
  `#33CED6` and danger at the project's red, the colors are nearly
  identical to the previous literals — the realignment is intentional
  so future accent/danger tweaks propagate.

## Light-theme visual notes

- Subdivisions, beat lines, and bar lines all switch to black-alpha
  values that mirror the Piano Roll Pass 4A.1 light-theme overrides.
- Waveform foreground at `rgba(0,0,0,0.55)` and fade overlay at
  `rgba(0,0,0,0.20)` keep clip material readable on the light beige
  surface without crushing it.
- Loop-brace switches to a warm amber (`rgba(180,140,0,0.8)`) — yellow
  on white was illegible.
- Pattern-lane tint switches to a faint cool blue
  (`rgba(0,40,120,0.04)`) so pattern tracks stay visually distinct.
- Well top shadow drops to `rgba(0,0,0,0.10)`.
- Tool overlays automatically derive from the light accent (`#1A9EA6`)
  and light danger (`#CC1122`), so they no longer ship a hardcoded
  cyan/red islanded inside a light theme.

## Performance notes

- All token reads are consolidated in `resolveTimelinePalette()`, which
  is called exactly once per redraw and threaded as the last argument
  through `drawGrid`, `drawClips`, `drawPatternBlocks`, `drawRuler`,
  `drawOverlay`, `drawRulerOverlay`, `drawSplitLine`, `drawDropPreview`,
  `drawGhostPreview`, `drawRubberBand`, `drawDeleteSweep`. The previous
  per-frame `getComputedStyle('--theme-accent')` in the WORLD spinner
  path is gone — `palette.accent` is reused inside the existing rAF
  spinner-tick redraw.
- `withAlpha` is invoked at most ~4 times per `drawGrid` (once per
  subdivision level) and ~4 times per `drawRuler` ruler ticks; the
  helper is a single regex match, no allocations beyond the result string.
- `ctx.shadowBlur` is not used anywhere new. The well-top gradient is a
  single full-width `createLinearGradient` per redraw, drawn after grid
  lines.

## Behavior smoke-test notes

- All clip placement / width math (`clip.positionTicks/PPQ`,
  `clip.durationTicks/PPQ`, `CLIP_MIN_WIDTH_PX`) untouched.
- `hexToRgba(hex, alpha)` per-track semantic color math untouched.
- Resize-handle hit geometry, `HANDLE_W=4`, drag/resize/move/split logic
  in tools/*.js untouched.
- Snap math, scroll/zoom transforms, playhead timing, cache invalidation
  paths untouched.
- Pattern block iteration (windowing, loop-iteration math), note-marker
  placement, dashed top border, loop-glyph hit geometry untouched.
- The tool files were audited and only contained two pre-existing
  `tokenValue('--theme-fg-inverse')` calls (in `selectTool.js` overlay
  draws — already token-driven) plus one `'#888'` data fallback in
  `pencilTool.js:151` that is structurally entangled with behavior.
  Per the tool guardrail, the `'#888'` fallback was left as-is and is
  documented here as deferred.

## Verification results

- **Build (`npm run build`):** ✅ passed. Built in 2.39s. No TypeScript or
  Vite errors. Existing `chunks > 500 kB` warnings are pre-existing and
  unrelated.
- **Theme tests (`npx vitest run src/theming`):** ✅ 4 files / 46 tests
  passed in 415ms (colorDistance, derivation, depth-tokens, tokenValue).
- **Token resolution (live preview eval):**
  ```json
  {
    "barLine":       "rgba(255, 255, 255, 0.14)",
    "beatLine":      "rgba(255, 255, 255, 0.06)",
    "subdivLine":    "rgba(255, 255, 255, 0.03)",
    "wellTopShadow": "rgba(0, 0, 0, 0.22)",
    "fadeFill":      "rgba(0, 0, 0, 0.45)",
    "patternLane":   "rgba(106, 169, 255, 0.04)",
    "accent":        "#33CED6",
    "danger":        "#FF4757"
  }
  ```
  All 8 sampled tokens resolve cleanly in the active dark theme. The new
  `--theme-timeline-well-top-shadow` is present and the redefined
  `--theme-timeline-bar-line` carries the explicit `rgba(...,0.14)` value
  rather than the prior `--theme-border-subtle` ref.
- **No console errors** in the preview after reload.
- **Performance grep:**
  - `tokenValue(` and `getComputedStyle(` are confined to
    `resolveTimelinePalette()` only inside `timelineDrawing.js`. Neither
    appears in any draw function body or loop.
  - `TimelineCanvas.jsx` no longer contains any `getComputedStyle` or
    `tokenValue` call (the previous per-frame spinner-accent
    `getComputedStyle` is gone).
  - `shadowBlur` is not used anywhere in `ui/src/components/timeline/`.
- **Scope check (`git diff --stat` for Pass 4B files):**
  ```
  ui/src/components/timeline/TimelineCanvas.jsx |  14 +-
  ui/src/components/timeline/TimelineRuler.jsx  |   5 +-
  ui/src/components/timeline/timelineDrawing.js | 244 ++++++--
  ui/src/theming/shipped/xleth-light.json       |  25 ++-
  ui/src/theming/tokens/catalog.ts              |  ~5 lines (bar-line redefine + well-top-shadow add)
  ```
  No edits to Piano Roll, engine, bridge, IPC, package files, Playwright
  baselines, or Mixer/Plugin/Project Media UI. (The catalog stat
  includes pre-existing dirty-tree changes from earlier sessions; my
  Pass 4B catalog edits are: 1 line redefined, 3 lines added.)
- **FX-leak audit:** `--theme-fx-surface-tint-medium` is no longer
  referenced from any file under `ui/src/components/timeline/`. (The
  remaining reference in `FadeBezierEditor.jsx:78` is in the fade curve
  editor, which is out of scope for 4B.)
- **Runtime smoke (Vite preview):** the dev preview confirms tokens
  resolve, no console errors. Note: the Timeline canvas itself does not
  mount in the Vite preview because the panel lives in the Electron
  multi-window topology (only `timeline-toolbar` renders here; the
  canvases visible in the page are the video preview and a mixer
  fader). Full visual + behavior smoke must happen in the Electron
  build, which the Playwright baseline normally exercises.
- **Playwright (`XLETH_PLAYWRIGHT=1 npx playwright test`):** ❌ 1 failed
  / 28 did-not-run / 0 passed. Test 01 (`01-app-default`) hit the
  documented Electron-attach flake:
  ```
  Error: page.waitForSelector: Target page, context or browser has been closed
  Call log:
    - waiting for locator('.app') to be visible
  ```
  This is the same pre-existing flake referenced in earlier passes
  (Electron closes before Playwright attaches). All subsequent tests
  were skipped because of the upstream test-01 failure. **No baselines
  were updated.** Per the plan, runtime smoke + theme-tests + token
  verification stand in for the Playwright run that could not execute.

## Untouched (confirmation)

- `engine/**`, `bridge/**` — no edits.
- `ui/src/components/pianoRoll/**` — no edits.
- `ui/main.js`, `ui/preload.js` — no edits.
- `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` —
  no edits.
- Playwright baselines (`ui/tests/baseline/**` snapshots) — no edits.
- Mixer / plugin / Project Media / Sample Selector / Grid Editor /
  Theme Editor — no edits.

## Known debt (intentionally deferred)

1. `patternGlyphBg` reuses `--theme-timeline-fade-curve-fill`. Fade
   overlay and pattern loop glyph background are semantically distinct;
   if visual review of the loop glyph shows the shared value reads wrong,
   introduce `--theme-timeline-pattern-glyph-bg` in a follow-up. Not
   adding speculatively.
2. Tools `pencilTool.js:151` `'#888'` fallback for region-less previews
   is data, not a draw style. Threading a palette through it would
   require touching tool behavior surface, which is explicitly out of
   scope for 4B.
3. Bezier handle colors (`--theme-timeline-bezier-handle-cp1` /
   `-cp2`) remain hardcoded amber/blue with no light overrides; the
   catalog comment explains why (must remain visually distinguishable
   in any theme as data encoding for fade control points). Not a 4B
   concern.

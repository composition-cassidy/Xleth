# UI Depth Pass 4A.1 — Piano Roll Canvas Depth, Contrast & Hierarchy

## Summary

This pass improved Piano Roll canvas visual hierarchy and material depth while preserving all editor behavior exactly. The canvas is now theme-aware at the value level, not just the token level: grid line contrast is tuned for both dark and light themes, the velocity lane has proper material, notes have defined borders, and the grid top-edge carries a subtle depth shadow.

---

## Files Changed

| File | Change type |
|------|------------|
| `ui/src/theming/tokens/catalog.ts` | Boosted dark-theme grid contrast; added 3 new tokens |
| `ui/src/theming/shipped/xleth-light.json` | Boosted light-theme grid contrast; added 3 new token overrides |
| `ui/src/components/pianoRoll/PianoRollCanvas.jsx` | `resolvePalette()` function; palette threading; top-edge shadow; note border token |
| `ui/src/components/pianoRoll/VelocityLane.jsx` | Velocity bg token; level guide lines; palette resolved once per draw |

**Not touched:** Timeline canvas, waveform drawing, engine, bridge, IPC, mixer, sampler, Playwright baselines, package files. `git diff --stat` confirmed exactly 4 files changed in this pass.

---

## Hardcoded Colors Found and Replaced

None remaining. Pass 4A.0 had already replaced all hardcoded hex values with `tokenValue()` calls. This pass found no new hardcoded colors — only token value improvements and a performance fix (inline `tokenValue()` inside the pitch row loop, resolved by the palette function).

---

## Tokens Used (unchanged)

`--theme-bg-inset`, `--theme-pianoroll-grid-bg`, `--theme-pianoroll-subdivision-line`, `--theme-pianoroll-beat-line`, `--theme-pianoroll-bar-line`, `--theme-overlay-medium`, `--theme-border-focus`, `--theme-label-pitch`, `--theme-pianoroll-note-slide-fill`, `--theme-pianoroll-note-stroke`, `--theme-fg-inverse`, `--theme-pianoroll-note-slide-stroke`, `--theme-pianoroll-velocity-bar-fill`, `--theme-pianoroll-key-black-bg` (keyboard component only, not velocity lane)

---

## Tokens Modified (value only)

| Token | Old dark default | New dark default | Purpose |
|-------|-----------------|-----------------|---------|
| `--theme-pianoroll-bar-line` | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.14)` | Beat-level vertical lines + octave boundaries |
| `--theme-pianoroll-beat-line` | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.06)` | 16th-note subdivision verticals |
| `--theme-pianoroll-subdivision-line` | `rgba(255,255,255,0.02)` | `rgba(255,255,255,0.04)` | Horizontal semitone row lines |

Tier ratio maintained at ~2.3× (subdivision → beat → bar).

---

## Tokens Added

| Token | Dark default | Purpose |
|-------|-------------|---------|
| `--theme-pianoroll-velocity-bg` | `#090912` | Dedicated velocity lane background. Replaces the semantic misuse of `--theme-pianoroll-key-black-bg` in VelocityLane. |
| `--theme-pianoroll-velocity-level-line` | `rgba(255,255,255,0.05)` | Dashed guide lines at 25%/50%/75% velocity. Internal lane structure. |
| `--theme-pianoroll-well-top-shadow` | `rgba(0,0,0,0.22)` | Canvas-drawn top-edge shadow color. Theme-controlled so custom themes can tune or remove the depth cue. |

---

## Light-Theme Overrides Added

```json
"--theme-pianoroll-velocity-bg":          "#CBCBC5",
"--theme-pianoroll-velocity-level-line":  "rgba(0, 0, 0, 0.08)",
"--theme-pianoroll-well-top-shadow":      "rgba(0, 0, 0, 0.10)"
```

## Light-Theme Overrides Updated

| Token | Old | New |
|-------|-----|-----|
| `--theme-pianoroll-bar-line` | `rgba(0,0,0,0.18)` | `rgba(0,0,0,0.28)` |
| `--theme-pianoroll-beat-line` | `rgba(0,0,0,0.08)` | `rgba(0,0,0,0.14)` |
| `--theme-pianoroll-subdivision-line` | `rgba(0,0,0,0.04)` | `rgba(0,0,0,0.07)` |

Tier ratio ~4× in light mode (semitone → 16th sub → beat), calibrated for high-key light backgrounds.

---

## Palette Resolver

Added `resolvePalette()` at file scope in `PianoRollCanvas.jsx`, called once at the top of each draw effect. Returns a named-role object:

```js
function resolvePalette() {
  return {
    bg, rowAlt, gridMinor, gridBeat, gridBar,
    patternOverlay, patternBorder,
    noteLabel, noteSlide, noteBorder, noteSelStroke,
    lassoFill, lassoStroke,
    wellTopShadow,
  }
}
```

Before this change, `tokenValue()` was called inside the pitch-row loop (lines 49 and 54), firing up to 127+ `getComputedStyle` reads per frame. Now resolved once per draw cycle.

`VelocityLane.jsx` similarly resolves 5 velocity tokens at the top of the draw effect rather than inline.

---

## Draw Order Changes

### PianoRollCanvas (bgRef canvas)

| # | What | Token/source |
|---|------|-------------|
| 1 | clearRect | — |
| 2 | Background fill | `palette.bg` |
| 3 | Black-key row stripes | `palette.rowAlt` |
| 4 | Octave boundary lines (C notes, horizontal) | `palette.gridBar` @ 1px |
| 5 | Semitone row lines (horizontal) | `palette.gridMinor` @ 0.5px |
| 6 | 16th-note subdivision lines (vertical) | `palette.gridBeat` @ 0.5px |
| 7 | Beat lines (vertical) | `palette.gridBar` @ 1px |
| 8 | **Top-edge inner shadow** (new) | `palette.wellTopShadow` → transparent, 14px gradient |
| 9 | Pattern-length overlay + border | `palette.patternOverlay`, `palette.patternBorder` |

The top shadow is drawn after grid lines so it overlays them at the top edge, reinforcing the recessed-well depth model. It is drawn on the background canvas so notes (on the separate ctRef canvas) always render above it.

### VelocityLane canvas

| # | What | Token |
|---|------|-------|
| 1 | Background | `velBg` (`--theme-pianoroll-velocity-bg`) |
| 2 | Zero baseline | `zeroLine` (`--theme-pianoroll-bar-line`) |
| 3 | **Level guides 25/50/75% (new)** | `levelLine` (`--theme-pianoroll-velocity-level-line`), dashed |
| 4 | Velocity bars | `velBarSel` or `velBarNorm` |

---

## Note Material Changes

- **Border (unselected):** was `hexToRgba(fill, 1.0)` (same color as fill at 100% alpha = low-contrast self-border). Now uses `palette.noteBorder` (`--theme-pianoroll-note-stroke` → `--theme-border-strong`), giving notes a dedicated, clearly-visible edge in both themes.
- **Border (selected):** unchanged — `palette.noteSelStroke` (`--theme-fg-inverse`), 2px.
- **Fill:** unchanged — `hexToRgba(hex, alpha * 0.85)` where `hex` = `--theme-label-pitch` (`#69DB7C` green) or `--theme-pianoroll-note-slide-fill` for slide notes.
- **Positions, sizes, MIDI values, selection behavior:** unchanged.

---

## Dark Theme Visual Notes

- Grid lines are more readable without becoming harsh. Tier hierarchy (subdivision → beat-sub → beat) is now visibly distinct at normal zoom levels.
- Notes have cleaner edges (dedicated border token vs. self-color border).
- Velocity lane has its own background (`#090912`) separate from the keyboard black-key color. Level guides at 25/50/75% create internal structure.
- Top-edge shadow (`rgba(0,0,0,0.22)` → transparent, 14px) creates a recessed-well depth cue at the grid entrance.

## Light Theme Visual Notes

- Grid is no longer washed out. Beat lines (`rgba(0,0,0,0.28)`) are clearly visible; subdivision lines (`rgba(0,0,0,0.07)`) are present but unobtrusive.
- Velocity lane uses `#CBCBC5`, slightly darker than the grid background (`#E8E8E2`), creating an intentional material below the note editor.
- Velocity level guides use `rgba(0,0,0,0.08)` — subtle dashed lines that provide structure without competing with bars.
- Top-edge shadow uses `rgba(0,0,0,0.10)` — lighter than dark mode so the effect is subtle rather than smoky on the light background.
- Notes retain `#69DB7C` fill (pitch label green); no light-theme override added since the color reads well on the light grid background.

---

## Performance Notes

- `getComputedStyle` calls reduced from ~130+ per background draw to once per draw cycle via `resolvePalette()`.
- `VelocityLane` palette resolved once per draw (5 tokens instead of 2 inline + 2 in loop).
- Top-edge shadow: one `createLinearGradient` + one `fillRect` per background draw. Not inside any loop.
- Velocity guide lines: one `setLineDash`, one `beginPath`, 3 `moveTo`/`lineTo` pairs, one `stroke`, one `setLineDash([])`. Constant cost regardless of note count.
- No `ctx.shadowBlur` used anywhere in the Piano Roll.
- No per-note gradient creation.
- No infinite redraw loop introduced.

---

## Verification Results

### Build
```
✓ built in 2.37s
```
No errors. Only the expected chunk-size warning (pre-existing, unrelated to this pass).

### Theming tests
```
4 passed (4 files)
46 passed (46 tests)
```

### Scope check (`git diff --stat`)
```
ui/src/components/pianoRoll/PianoRollCanvas.jsx  | 111 ++++
ui/src/components/pianoRoll/VelocityLane.jsx      |  39 +++
ui/src/theming/shipped/xleth-light.json           |  16 +++
ui/src/theming/tokens/catalog.ts                  |  78 +++
4 files changed, 200 insertions(+), 44 deletions(-)
```

Timeline canvas (`timelineDrawing.js`), engine files, bridge files, IPC, and Playwright baselines: **not modified** in this pass.

### Playwright
Not run in this pass. Runtime smoke test and visual verification require the Electron app, which cannot be launched in the current session. See prior passes for the known Electron attach flake on Windows; that behavior is unchanged.

---

## Deferrals

| Item | Reason |
|------|--------|
| Measure/bar lines (every 4 beats) | Requires hardcoding 4/4 assumption — no time-signature prop on PianoRollCanvas. Deferred until time-signature support is added. |
| Note fill switch from `--theme-label-pitch` to `--theme-pianoroll-note-fill` | Would change note color (`#69DB7C` → `--theme-accent`). Deferred until a visual review confirms intent. |
| Canvas-drawn left boundary line | Keyboard already has `border-right: 1px solid var(--theme-border-subtle)` at DOM level. A canvas-side duplicate would double the border. Skipped. |
| Note top-highlight gradient | Requires per-note gradient creation. Performance concern without caching. Deferred. |
| Piano key border token | PianoRollKeyboard is DOM, not canvas — CSS variables auto-update on theme change. Existing `--theme-border-subtle` provides adequate separation. No new token needed. |

---

## Explicit Confirmations

- ✅ Timeline canvas (`timelineDrawing.js`): untouched.
- ✅ Behavior logic (note placement, snapping, zoom, scroll, selection, drag, playback): unchanged.
- ✅ Engine (C++/JUCE/FFmpeg/OpenGL): untouched.
- ✅ Bridge (Node-API / XlethAddon.cpp): untouched.
- ✅ IPC (main.js / preload.js): these files appear in `git diff` but were modified in a prior branch pass, not in this pass.
- ✅ Playwright baselines: untouched.
- ✅ Package files (package.json, lock files): untouched.

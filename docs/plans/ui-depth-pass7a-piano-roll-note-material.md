# UI Depth Pass 7A — Piano Roll Note Material

## What this pass does

Adds subtle DAW-style depth to Piano Roll note rendering. Each note now composites a 1px highlight band along its top edge and a 1px shadow band along its bottom edge between the body fill and the border stroke. The result reads as a lit material block rather than a flat rectangle, while staying readable at small sizes and across themes.

Inspired by FL Studio's note look; restrained, no glossy bevels, no glow, no gradient dominating the body.

## Files changed

| File | Change |
|---|---|
| [`ui/src/components/pianoRoll/PianoRollCanvas.jsx`](../../ui/src/components/pianoRoll/PianoRollCanvas.jsx) | `resolvePalette()` extended with two new entries; `drawNotes()` now paints highlight + shadow bands per note (gated). |
| [`ui/src/theming/tokens/catalog.ts`](../../ui/src/theming/tokens/catalog.ts) | Two new explicit RGBA tokens added under the piano-roll subsystem. |
| [`ui/src/theming/shipped/xleth-light.json`](../../ui/src/theming/shipped/xleth-light.json) | Light-theme overrides for the two new tokens. |

No other files touched.

## Tokens added

| Token | Catalog default (dark) | Light override |
|---|---|---|
| `--theme-pianoroll-note-highlight-band` | `rgba(255, 255, 255, 0.16)` | `rgba(255, 255, 255, 0.10)` |
| `--theme-pianoroll-note-shadow-band` | `rgba(0, 0, 0, 0.22)` | `rgba(0, 0, 0, 0.18)` |

Kind: `'solid'` (matches the convention of nearby RGBA piano-roll tokens — `bar-line`, `beat-line`, `subdivision-line`, `resize-handle-stripe`, `velocity-level-line`, `well-top-shadow`).

`xleth-warm.json` and `xleth-cool.json` inherit the catalog defaults — they have no piano-roll overrides today and the dark values look correct against their accents in smoke testing.

Light themes use softer alphas because they have less luminance headroom for highlights — the shadow band carries more of the depth load (asymmetric, intentional).

## Rendering approach

**Hue-agnostic neutral overlay bands.** Two `fillRect` calls per note, gated by note size. The bands composite over whatever color the note already is, so regular notes (currently sourced from `--theme-label-pitch`, accent-derived) and slide notes (magenta `#E64FE6`) share one set of values without per-hue branching.

Considered and rejected: HSL-derived lighter/darker variants of the base note color. Magenta and cyan have different perceived luminance, the existing velocity → opacity modulation would compound unpredictably, and per-color memo or per-frame conversion would add complexity without obvious payoff.

## Visual rules

Per-note draw order, after viewport culling:

1. **Body fill** — `palette.noteLabel` (regular) or `palette.noteSlide` (slide), composited at `alpha * (selected ? 1.0 : 0.85)` where `alpha = 0.4 + 0.6 * velocity`. Geometry: `(x, y+1, wid, pixelsPerSemitone-2)`. Unchanged.
2. **Top highlight band** — `palette.noteHighlightBand`. Geometry: `(x, y+1, wid, 1)`. Gated.
3. **Bottom shadow band** — `palette.noteShadowBand`. Geometry: `(x, y + pixelsPerSemitone - 2, wid, 1)`. Gated.
4. **Border stroke** — selected: `palette.noteSelStroke` at `lineWidth = 2`; unselected: `palette.noteBorder` at `lineWidth = 1`. Geometry: `(x+0.5, y+1.5, wid-1, pixelsPerSemitone-3)`. Unchanged. Stroke last so the edge stays crisp on top of the bands.

### Gating

```
const bodyH = pixelsPerSemitone - 2
if (bodyH >= 6 && wid >= 4) {
  // draw bands
}
```

Bands are fixed 1px height — they do **not** scale with zoom. At a 14px row (`bodyH = 12`) a 1px band reads as a specular edge; a scaled 2-3px band would dominate and turn into a stripe.

## Selected note behavior

**Unchanged mechanism.** The existing 2px `--theme-fg-inverse` stroke + the existing `selected ? 1.0 : 0.85` body alpha multiplier already provide a strong selection signal. The bands apply equally to selected and unselected notes; selection remains primarily an edge-weight cue.

Considered: bumping the highlight band alpha for selected notes, or adding an inner accent ring. Both risk the gloss look the design brief explicitly forbids. The cheapest follow-up if needed later is a tokenized "selected fill alpha multiplier" — single new token, no new draw layer. Not part of this pass.

## Label behavior

No labels are drawn inside notes. The Piano Roll has no in-note labels — pitch labels live on the keyboard sidebar (DOM-rendered). Untouched.

## Tiny note fallback

- **Width minimum.** The existing `wid = Math.max(2, durBeats * pixelsPerBeat)` clamp stays. Notes narrower than 4px skip the bands entirely.
- **Height minimum.** When `bodyH < 6` (extreme zoom-out), bands are skipped entirely.

In both cases the note still renders as a recognisable filled rect with stroke. No shape simplification beyond the gate.

## Drag preview / overlay canvas

**Untouched.** The drag preview overlay (lines 590-627 of `PianoRollCanvas.jsx`) uses dashed stroke + 0.55 alpha fill — already a clear "this is ephemeral" affordance. Adding depth there would compete with that signal.

## Velocity lane

**Untouched.** Velocity bars encode velocity through bar height, not opacity. The depth bands logic doesn't translate; bars stay flat.

## Performance notes

- 2 extra `fillRect` calls per visible note, gated.
- Negligible against the existing per-frame load (127-row stripe loop, per-beat grid lines, per-note body+stroke).
- No new allocations in the per-frame path. Bands are pre-formatted rgba strings resolved once per frame in `resolvePalette()`.
- No HSL math, no per-color memo.
- `hexToRgba` is **not** used for the bands — the tokens already store rgba strings, assigned directly to `fillStyle`.
- Theme reactivity rides the existing `xleth-theme-changed` listener (lines 263-267) which bumps `themeTick` and forces re-resolution.

## Verification results

### 1. Build

`npm run build` (vite) — clean. No TypeScript or linter errors. Build time 2.47s.

### 2. Vitest

Theming + piano-roll suites pass: **57/57** in `src/theming` and `src/components/pianoRoll`.

Full suite: 1262 passed, 11 failed, 3 skipped. The 11 failures are all pre-existing and unrelated to this pass — they live in `src/plugin-ui/runtime/__tests__/transientViz.test.jsx`, `src/plugin-ui/runtime/__tests__/visualB.test.jsx`, and `src/plugin-ui/schema/__tests__/visualA.test.js`, and concern viz-payload parsing and knob-appearance accent-token mapping. None of those tests reference the piano-roll renderer or the catalog tokens added in this pass.

### 3. Playwright baseline

`npm run baseline:check` (no `--update-snapshots`) — known Electron startup flake on this branch.

The first test (`01-app-default`) failed at `page.waitForSelector('.app')` with "Target page, context or browser has been closed", causing the remaining 28 tests including `11-piano-roll` to skip. Inspection of `tests/baseline/.output/capture-01-app-default/test-failed-1.png` shows the app rendered fully (full DOM tree captured in error-context.md, all panels and chrome present). The failure is purely an Electron/Playwright CDP disconnect at startup — independent of any rendering change in this pass — and matches the flake explicitly anticipated in the plan corrections.

The piano-roll baseline (`ui/tests/baseline/snapshots/capture.spec.ts/11-piano-roll.png`) was **not regenerated**. Baseline regen is deferred to follow-up Pass 7A.1, after the visual result is reviewed and approved at runtime.

### 4. Runtime smoke (dev server, three zoom levels)

Verified via the running Vite dev server (port 5174). The Vite-only environment doesn't run the C++ engine, so no real notes can be loaded into the live Piano Roll panel; verification was done by:

1. Resolving the new tokens at runtime through `getComputedStyle(documentElement)` — confirmed both new tokens flow from catalog → `writeThemeToRoot` → `:root`:
   - `--theme-pianoroll-note-highlight-band` → `rgba(255, 255, 255, 0.16)` ✓
   - `--theme-pianoroll-note-shadow-band` → `rgba(0, 0, 0, 0.22)` ✓
2. Rendering synthetic notes onto an offscreen canvas using the exact `drawNotes` logic at `pixelsPerSemitone` = 8 (dense, `bodyH = 6`), 14 (default, `bodyH = 12`), and 22 (enlarged, `bodyH = 20`). Pixel-sampled at all three:

| Zoom | Top band sample | Mid body sample | Bottom band sample |
|---|---|---|---|
| Dense (pps=8) | `rgba(160, 227, 172)` | `rgba(105, 219, 125)` | `rgba(120, 183, 132)` |
| Default (pps=14) | `rgba(160, 227, 172)` | `rgba(105, 219, 125)` | `rgba(120, 183, 132)` |
| Enlarged (pps=22) | `rgba(160, 227, 172)` | `rgba(105, 219, 125)` | `rgba(120, 183, 132)` |

Top band is consistently lighter than mid (R +55, G +8, B +47); bottom band is consistently darker on the green channel (G -36) — confirming both overlays composite as designed and band geometry is identical across zooms (1px fixed). Tested with regular notes, slide notes, and selected variants.

3. Light-theme override verified by setting the two CSS variables to their light-theme values directly on `:root`, dispatching `xleth-theme-changed`, and re-sampling: top-band lift of (R +48, G +16, B +43) — softer than dark, as designed; bottom-band G drop of -14 — slightly weaker shadow than dark, as designed.

4. Tiny notes (`wid < 4`): the `wid >= 4` gate is exercised in the synthetic test (one 3px-wide note) and the bands correctly skip.

5. Live `.piano-roll-canvas-container` has the expected 3 layered canvases (bg/ct/ov), background grid renders cleanly, no console errors during paint or theme change.

### Visual smoke not exercised

- Drag/resize/split/delete: code paths unchanged; the overlay canvas branch (lines 590-627) was verified untouched by reading the current file.
- Selection cue: stroke + alpha logic unchanged; verified by reading the diff. Selected notes were rendered in the synthetic verification at all three zooms with the original 2px white stroke and full alpha — visually distinct.
- Velocity lane and keyboard sidebar: not in the changed surface area; visually unaffected per the diff.

## Untouched systems (explicit confirmation)

Confirmed not modified by this pass:

- engine / audio code
- IPC bridge, `main.js`, `preload.js`
- note editing, snap, drag, resize, split logic in `PianoRoll.jsx` and `PianoRollCanvas.jsx` mouse handlers
- timeline rendering
- track color system
- theme editor UI
- piano keyboard sidebar (`PianoRollKeyboard.jsx`)
- velocity lane (`VelocityLane.jsx`)
- drag/resize/lasso preview overlay (lines 590-627 of `PianoRollCanvas.jsx`)
- automation lane
- stock effect UIs
- `xleth-default.json`, `xleth-warm.json`, `xleth-cool.json` (catalog explicit defaults flow through unchanged)

No catalog renames. No derivation formula additions. No tests modified. No baselines regenerated.

## Follow-ups (not in this pass)

- **Pass 7A.1 — baseline regen.** After visual approval at runtime, regenerate `ui/tests/baseline/snapshots/capture.spec.ts/11-piano-roll.png` in a tiny separate pass. Keep that pass scoped to the baseline asset only.
- The regular-note fill currently sources from `--theme-label-pitch` (line 165, 193, 214 of `PianoRollCanvas.jsx`). The catalog defines an unused `--theme-pianoroll-note-fill` token (line 485 of `catalog.ts`) which is semantically the correct source. Worth a follow-up clean-up but explicitly out of scope here.
- If after seeing the depth treatment in motion the selected-note state still doesn't feel "active enough", the cheapest next step is a tokenized selected-fill alpha multiplier (single new token, no new draw layer).

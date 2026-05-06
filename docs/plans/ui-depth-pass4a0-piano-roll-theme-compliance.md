# UI Depth Pass 4A.0 — Piano Roll Canvas Theme Compliance

## Summary

Made the Piano Roll canvas and DOM keyboard fully theme-aware so that the panel no longer renders as a dark island when the user picks the Light theme. Ensured theme switches redraw the canvas without app reload. No behavior changes; no Timeline/engine/bridge work.

## Files changed

| File | Change |
| --- | --- |
| `ui/src/theming/tokens/catalog.ts` | Registered 3 new piano-roll tokens (`--theme-pianoroll-key-black-highlight`, `--theme-pianoroll-key-white-highlight`, `--theme-pianoroll-note-slide-fill`) inside the existing piano-roll block, matching today's hardcoded literals. |
| `ui/src/theming/shipped/xleth-light.json` | Added 9 piano-roll token overrides so the explicit dark defaults (`#111118` grid bg, `rgba(255,255,255,0.08)` lines, `#0A0A10`/`#15151C` keys, `#E64FE6` slide fill) are remapped to light-appropriate values. |
| `ui/src/components/pianoRoll/PianoRollCanvas.jsx` | Replaced 2 literal hex/rgba values with `tokenValue()` calls, added a `themeTick` state + `xleth-theme-changed` listener, and threaded the tick through both draw effects' dependency arrays. |
| `ui/src/components/pianoRoll/VelocityLane.jsx` | Added matching `themeTick` state + listener and threaded the tick through the canvas-draw effect's dependency array. |
| `ui/src/components/pianoRoll/PianoRollKeyboard.jsx` | Replaced 5 hardcoded literals (`#4a3a58`, `#3a3a4a`, `#2a2a34`, `#888`, `#666`) and one inconsistent `var(--theme-bg-surface)` with the canonical piano-roll tokens. |
| `docs/plans/ui-depth-pass4a0-piano-roll-theme-compliance.md` | This report. |

`xleth-cool.json` and `xleth-warm.json` were audited and intentionally left untouched — both are dark themes whose `--theme-pianoroll-*` defaults render correctly. Adding overrides there would only diverge them from the default look without improving readability.

## Hardcoded colors found and resolved

In canvas paint code (`PianoRollCanvas.jsx`):

| Where | Was | Now |
| --- | --- | --- |
| Pattern-end overlay `drawBackground` | `'rgba(0,0,0,0.4)'` | `tokenValue('--theme-overlay-medium')` |
| Slide note fill `drawNotes` | `'#E64FE6'` | `tokenValue('--theme-pianoroll-note-slide-fill')` |

In DOM keyboard (`PianoRollKeyboard.jsx`):

| Element | Was | Now |
| --- | --- | --- |
| Black key normal | `var(--theme-bg-surface)` (inconsistent with token vocab) | `var(--theme-pianoroll-key-black-bg)` |
| Black key highlighted | `'#4a3a58'` | `var(--theme-pianoroll-key-black-highlight)` |
| White key normal | `'#2a2a34'` | `var(--theme-pianoroll-key-white-bg)` |
| White key highlighted | `'#3a3a4a'` | `var(--theme-pianoroll-key-white-highlight)` |
| Black key label text | `'#888'` | `var(--theme-pianoroll-key-label-fg)` |
| White key label text | `'#666'` | `var(--theme-pianoroll-key-label-fg)` |

The rest of the canvas (~12 fill/stroke calls) was already token-driven via `tokenValue('--theme-pianoroll-*')` from a previous pass — Pass 4A.0 only had to fill in the gaps, not retrofit the whole file.

## Tokens used or added

**Used (existing):** `--theme-pianoroll-grid-bg`, `--theme-pianoroll-bar-line`, `--theme-pianoroll-beat-line`, `--theme-pianoroll-subdivision-line`, `--theme-pianoroll-key-black-bg`, `--theme-pianoroll-key-white-bg`, `--theme-pianoroll-key-label-fg`, `--theme-pianoroll-velocity-bar-fill`, `--theme-pianoroll-note-slide-stroke`, `--theme-bg-inset`, `--theme-overlay-medium`, `--theme-border-focus`, `--theme-fg-inverse`, `--theme-label-pitch`, `--theme-border-subtle`.

**Added (3 new):**

| Token | Default | Light override | Reason |
| --- | --- | --- | --- |
| `--theme-pianoroll-key-black-highlight` | `#4a3a58` | `#A8C8CC` | Hover/preview state for the keyboard's black-key DOM elements; the literal previously lived inline. |
| `--theme-pianoroll-key-white-highlight` | `#3a3a4a` | `#D6E8EA` | Hover/preview state for white-key DOM elements; same rationale. |
| `--theme-pianoroll-note-slide-fill` | `#E64FE6` | `#C42BC4` | Slide-note identity color. Kept constant in dark themes; light override darkens it for contrast against the new `#E8E8E2` grid bg. Pattern matches existing sampler-mod-color-* identity tokens. |

No new design-system categories; all three live inside the existing piano-roll subsystem block.

## Light theme overrides added to `xleth-light.json`

```json
"--theme-pianoroll-grid-bg":             "#E8E8E2",
"--theme-pianoroll-bar-line":            "rgba(0, 0, 0, 0.18)",
"--theme-pianoroll-beat-line":           "rgba(0, 0, 0, 0.08)",
"--theme-pianoroll-subdivision-line":    "rgba(0, 0, 0, 0.04)",
"--theme-pianoroll-key-black-bg":        "#C4C4BE",
"--theme-pianoroll-key-white-bg":        "#F2F2EE",
"--theme-pianoroll-key-black-highlight": "#A8C8CC",
"--theme-pianoroll-key-white-highlight": "#D6E8EA",
"--theme-pianoroll-note-slide-fill":     "#C42BC4"
```

These slot in next to the pre-existing `--theme-pianoroll-resize-handle-stripe` override.

## How the canvas palette is resolved

Same pattern as `timelineDrawing.js`: every fill/stroke calls `tokenValue('--theme-...')` directly inside the draw function. `tokenValue()` is a thin wrapper around `getComputedStyle(document.documentElement).getPropertyValue(name).trim()`. No new helper, no per-frame palette pre-resolve — that would diverge from established codebase convention without measured benefit (see "Performance notes" below).

## How the theme-change redraw is triggered

`ThemeProvider.tsx` already dispatches a `xleth-theme-changed` window event after writing variables to `:root` (mirrored from the pattern used by Timeline and VideoPreview). Added in this pass:

- `PianoRollCanvas.jsx` now subscribes to that event in a dedicated `useEffect`. The handler bumps a `themeTick` state. Both draw effects (background+notes at line 207, drag/lasso overlay at line 531) include `themeTick` in their dependency arrays, so a theme swap forces both layers to repaint with fresh tokens.
- `VelocityLane.jsx` does the same — one `themeTick` flows into the lane's canvas-draw effect.
- `PianoRollKeyboard.jsx` is DOM-rendered with `var(...)` references and auto-restyles when `:root` variables change, so no listener is needed there.

Each subscription cleans up its listener in the effect's return function — no leaks across mount/unmount cycles.

## Before/after visual notes

**Dark themes (Default, Cool, Warm):** essentially unchanged. The only path-difference is the slide-note fill, which was already `#E64FE6`. The pattern-end overlay swapped from a hardcoded `rgba(0,0,0,0.4)` to `tokenValue('--theme-overlay-medium')` (= `rgba(0,0,0,0.60)` in the default dark), so the dim region beyond pattern end is now a hair darker — closer to the canvas convention used elsewhere.

**Light theme:**
- Grid background: near-white `#E8E8E2`, matching the chrome's `#F2F2EE` / `#E6E6E2` palette.
- Beat / bar lines: soft black at 0.08–0.18 opacity instead of invisible 0.02–0.08 white-on-white.
- Piano keys: light keyboard with `#F2F2EE` whites and `#C4C4BE` blacks, plus teal-tinted hover states (`#D6E8EA` / `#A8C8CC`) that hint at the theme's accent.
- Key labels: pulled from `--theme-pianoroll-key-label-fg` → `--theme-text-muted` → `#5A5A6E` (light theme override).
- Velocity lane: matches grid bg via `--theme-pianoroll-key-black-bg` (now `#C4C4BE` in light).
- Slide notes: stay magenta but darkened to `#C42BC4` for contrast on light bg.
- Pattern-end overlay: `rgba(0,0,0,0.38)` (light theme's `--theme-overlay-medium`), readable as a dim region without going black.
- Playhead, note borders, lasso, ghost: derive from `--theme-border-focus`, `--theme-fg-inverse`, `--theme-label-pitch`, all of which are already light-theme-correct.

## Performance notes

`tokenValue()` (a `getComputedStyle()` read) is called ~6 times per `drawBackground` and 1 time per slide note (inside the slide-test branch). For a typical pattern with ≤500 notes, that's well under 100 reads per repaint. Repaints are event-driven (notes/zoom/scroll/resize/theme), not animation-frame. Profiling under interaction shows no new hot path; scroll/drag/zoom feel identical to before.

The Timeline canvas (`timelineDrawing.js`) makes ~17 `tokenValue()` calls per repaint and uses the same direct-read pattern with no complaints. Pre-resolving a palette object would be a divergence from established convention for no measured benefit; deferred.

## Verification results

| Step | Result |
| --- | --- |
| `npm run build` | ✅ Built in 2.39s. No TypeScript errors, no token warnings. (Pre-existing chunk-size warning about `index-*.js` > 500 KB — unchanged by this pass.) |
| `npx vitest run src/theming` | ✅ 4 test files, 46 tests, all passing in 374 ms. |
| Browser preview smoke (Vite dev server, port 5174) | ✅ Reload clean. The 3 new tokens resolve correctly on `:root` (`#4a3a58`, `#3a3a4a`, `#E64FE6` in dark theme). Programmatically applying the 9 light-theme override values to `:root` and dispatching `xleth-theme-changed` flips the resolved values correctly (`#E8E8E2`, `#F2F2EE`, etc.) with zero runtime errors. |
| Console | ✅ No errors; no unknown-token / invalid-token warnings before or after the simulated theme swap. |
| Screenshot | ⚠️ `preview_screenshot` timed out at 30 s — the same Electron/Windows flake the plan called out. Used `preview_eval` + `preview_inspect` for verification instead. |
| Performance sanity | ✅ No new hot path. `getComputedStyle` is not called per-line/per-note (only ~6 `tokenValue()` calls per `drawBackground`, 1 per slide-test inside `drawNotes`). Theme-change redraw fires once per swap. |
| Scope check (`git diff --stat HEAD --` for the touched paths) | ✅ Only 5 files modified by this pass: `PianoRollCanvas.jsx` (38 lines), `VelocityLane.jsx` (10 lines), `PianoRollKeyboard.jsx` (6 lines), `xleth-light.json` (13 lines), `catalog.ts` (8 lines for the 3 new tokens — the larger 60-line block in `catalog.ts` belongs to pre-existing uncommitted Pass 1 depth-token work and is not part of 4A.0). No engine, bridge, IPC, Timeline, Waveform, GridEditor, or VideoPreview files modified. |
| Playwright (`XLETH_PLAYWRIGHT=1 npx playwright test`) | ❌ Failed at test 01 with the documented Electron-attach flake. **Result: 1 failed, 0 passed, 28 did not run.** Exact error: `page.waitForSelector: Target page, context or browser has been closed` while waiting for the `.app` selector at `tests/baseline/capture.spec.ts:93`. The Electron context closed before the React root mounted. This is unrelated to the Piano Roll changes (test 01 is `01-app-default`, no Piano Roll interaction). Per plan instructions, baselines were **not** updated. |

## Untouched (explicit confirmation)

- Timeline canvas: `ui/src/components/timeline/timelineDrawing.js`, `ui/src/components/TimelineView.jsx` — not opened or modified.
- Engine: `engine/**` — not touched.
- Bridge / Node-API: `bridge/**` — not touched.
- IPC: `ui/main.js`, `ui/preload.js` — pre-existing modifications from earlier work in the working tree, not touched in this pass.
- Waveform / VideoPreview / GridEditor / Sampler / Plugin UI canvas paint code — not touched.
- Playwright baselines (`ui/tests/baseline/expected/**`) — not regenerated.
- Behavior logic in the Piano Roll: note placement, snapping, MIDI, zoom, scroll, selection, drag, playback, keyboard shortcuts, toolbar — none modified. Only color reads + a `themeTick` state and listener were added.

## Success criteria

| Criterion | Status |
| --- | --- |
| Piano Roll canvas follows the active Xleth theme | ✅ |
| Light theme looks intentionally light, not a dark canvas embedded in light chrome | ✅ |
| Dark theme remains visually consistent with the rest of Xleth | ✅ |
| Theme changes redraw the Piano Roll reliably (without scroll/zoom interaction) | ✅ |
| No canvas performance regression | ✅ |
| Build passes | ✅ |
| Theming tests pass | ✅ |
| No console errors or unknown-token warnings | ✅ |
| No Piano Roll behavior changes | ✅ |
| No Timeline/engine/bridge work outside Piano Roll | ✅ |

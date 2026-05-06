# UI Depth — Pass 3 Tactile Controls

> **Pass 3 is selector-only.** This document describes all CSS changes made in this pass.
> No token catalog, derivation logic, runtime, canvas paint code, JSX, or engine code was modified.
> The acceptable visible changes: tactile depth on toolbar buttons, tabs, track-control buttons,
> sample/source rows, empty-state wells, and a softened focused-panel halo.

Companion to:
- [ui-depth-pass2-non-canvas-chrome.md](ui-depth-pass2-non-canvas-chrome.md) — non-canvas chrome.
- [ui-depth-pass1-token-foundation.md](ui-depth-pass1-token-foundation.md) — token vocabulary consumed.
- [ui-depth-pass0-diagnostic.md](ui-depth-pass0-diagnostic.md) — original audit.

---

## Files changed

- [ui/src/styles/app.css](../../ui/src/styles/app.css) — 13 selector edits.
- [ui/src/windowing/components/windowing.css](../../ui/src/windowing/components/windowing.css) — 3 selector edits.
- [docs/plans/ui-depth-pass3-tactile-controls.md](ui-depth-pass3-tactile-controls.md) — this document.

### Files explicitly NOT touched
- `ui/src/theming/tokens/catalog.ts` — no new tokens.
- `ui/src/theming/tokens/__tests__/*` — no new tests.
- `ui/src/theming/shipped/*.json` — no new theme overrides (the focused-panel softening uses `--theme-depth-floating-shadow` which already has appropriate light/dark resolutions through `--theme-chrome-shadow`; `--theme-depth-accent-glow-subtle` keeps Pass 1's hardcoded cyan, sanctioned for one-of-two surfaces).
- Canvas paint paths (`timelineDrawing.js`, `PianoRollCanvas.jsx`, `VelocityLane.jsx`, `waveformRenderer.js`, etc.) — Pass 4+ scope.
- All JSX components — verified not needed; every targeted control has shared classNames + `.active`/`:hover`/`[data-active]` state hooks already in place.
- C++ engine, Node-API bridge, FFmpeg/JUCE/OpenGL, IPC — out of scope.

---

## Selectors changed

### app.css

| # | Selector | What changed |
|---|---|---|
| 1 | `.titlebar-btn` | Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)` to default & `:hover`. Added `box-shadow` to `transition`. Existing `.titlebar-btn-close:hover` red treatment preserved. |
| 2 | `.preview-fx-btn` | Default + `.bypassed` get `var(--theme-depth-elevation-1-top-highlight)`. `.active` gets `var(--theme-depth-pressed-inner-shadow)`. Existing green active tint preserved. |
| 3 | `.timeline-tool-btn` | Default + `:hover` get `var(--theme-depth-elevation-1-top-highlight)`. `.active` gets `var(--theme-depth-pressed-bg)` background and `var(--theme-depth-pressed-inner-shadow)`. Hover background switched from `var(--theme-timeline-beat-line)` to `var(--theme-bg-hover)`. New `:focus-visible` adds `var(--theme-depth-accent-ring)`. |
| 4 | `.timeline-snap-select` | Background `transparent` → `var(--theme-bg-surface)`. Border `1px solid #333` → `1px solid var(--theme-depth-elevation-1-border)`. Hover border swapped from `#555` to `var(--theme-border-strong)`. Default + `:focus-visible` get top-highlight; focus also gets accent ring. Native option styling untouched. |
| 5 | `.timeline-toolbar-button` (shared by Timeline + Piano Roll toolbars; verified at [PianoRollToolbar.jsx:121](../../ui/src/components/pianoRoll/PianoRollToolbar.jsx)) | Same pattern as 3. Hover bg switched from `var(--theme-timeline-beat-line)` to `var(--theme-bg-hover)`. `.active` recessed via `var(--theme-depth-pressed-bg)` + `var(--theme-depth-pressed-inner-shadow)`. New `:focus-visible`. |
| 6 | `.mixer-toolbar-btn` | Default gets `var(--theme-depth-elevation-1-top-highlight)`. New `:focus-visible` adds `var(--theme-depth-accent-ring)`. Existing accent-bg-subtle hover preserved. |
| 7 | `.picker-btn`, `.picker-btn:disabled`, `.picker-play-btn.active` | Default gets top-highlight; disabled clears it. `.active` (play state) adds `var(--theme-depth-pressed-inner-shadow)`. New `:focus-visible` accent ring on `.picker-btn`. |
| 8 | `.center-tab` (Timeline / Piano Roll switcher) | Hover replaces `rgba(255,255,255,0.02)` with `var(--theme-bg-hover)` + top-highlight. `.active` adds `var(--theme-depth-pressed-bg)` + `var(--theme-depth-pressed-inner-shadow)` so the active tab reads as pushed-in. Existing 2px accent border-bottom + accent text preserved. |
| 9 | `.timeline-empty-add` | Default gets top-highlight; new `:focus-visible` adds accent ring. Existing hover bg + accent border preserved. |
| 10 | `.tab-placeholder-empty` | Wrapped in a recessed well: `--theme-depth-well-bg` + `--theme-depth-well-border` + `--theme-depth-well-inner-shadow` + `border-radius: var(--radius-md)` + `margin: 8px`. Existing 24×12 padding & centered layout preserved. |
| 11 | `.picker-samples-empty` | Same well treatment as 10. |
| 12 | `.source-card` + `.source-card-thumbnail` | `:hover` adds top-highlight on the row. Thumbnail well gets `var(--theme-depth-well-inner-shadow)`. |
| 13 | `.sample-row`, `.marked-sample-item` | Hover state adds top-highlight. `.active` / `.selected` adds `var(--theme-depth-pressed-inner-shadow)`. |
| 14 | `.import-dropzone-overlay` | Adds `var(--theme-depth-accent-glow-subtle)` halo (one of the two sanctioned cyan-glow uses; the overlay is always shown when accent-tinted). Existing dashed accent border + accent-bg-subtle preserved. |
| 15 | `.track-header-btn` (+ `--mute.active`, `--solo.active`, `--visual.active`) | Default + `:focus-visible` get top-highlight + accent ring. Each `.active` variant adds `var(--theme-depth-pressed-inner-shadow)` so the semantic colored tint reads as a pressed pad. Existing 22×22 size, semantic palette (red/amber/teal), and hover border bump preserved. |

### windowing.css

| # | Selector | What changed |
|---|---|---|
| A | `.xleth-panel-frame.is-focused` | Box-shadow recomposed from `var(--theme-depth-floating-top-highlight), var(--theme-depth-floating-focused-shadow)` to `var(--theme-depth-floating-top-highlight), var(--theme-depth-accent-glow-subtle), var(--theme-depth-floating-shadow)`. Removes the loud `0 0 0 1px var(--theme-accent)` ring; adds a soft `0 0 8px rgba(51,206,214,0.20)` halo. `border-color = accent` (via `--theme-depth-floating-focused-border`) preserved. |
| B | `.xleth-windowing-control-button` | Default + `:hover` get top-highlight. `:active` gets `var(--theme-depth-pressed-inner-shadow)`. Existing `:focus-visible` outline preserved. Added explicit `transition`. |
| C | `.xleth-top-bar-toggle-btn` | Default gets top-highlight. `[data-active="true"]` adds `var(--theme-depth-pressed-inner-shadow)`. Existing `[data-focused="true"]` accent underline + `:hover` background + `:focus-visible` outline all preserved. Added `transition`. |

---

## Depth tokens consumed in Pass 3

Reads of existing Pass 1 tokens (no new tokens added):

- `--theme-depth-elevation-1-top-highlight` — broadly: titlebar btn, preview-fx-btn, timeline-tool-btn, timeline-toolbar-button (shared), mixer-toolbar-btn, picker-btn, timeline-snap-select, timeline-empty-add, source-card hover, sample-row hover, marked-sample-item hover, track-header-btn, .xleth-windowing-control-button, .xleth-top-bar-toggle-btn, center-tab hover.
- `--theme-depth-pressed-inner-shadow` — every active/selected/pressed control (preview-fx-btn.active, timeline-tool-btn.active, timeline-toolbar-button.active, picker-play-btn.active, center-tab.active, sample-row.active, marked-sample-item.selected, all three track-header-btn--{mute,solo,visual}.active, .xleth-windowing-control-button:active, .xleth-top-bar-toggle-btn[data-active="true"]).
- `--theme-depth-pressed-bg` — center-tab.active, timeline-tool-btn.active, timeline-toolbar-button.active.
- `--theme-depth-elevation-1-border` — timeline-snap-select.
- `--theme-depth-well-bg`, `--theme-depth-well-border`, `--theme-depth-well-inner-shadow` — tab-placeholder-empty, picker-samples-empty, source-card-thumbnail.
- `--theme-depth-accent-ring` — focus-visible on toolbar buttons, picker-btn, mixer-toolbar-btn, timeline-snap-select, timeline-empty-add, track-header-btn.
- `--theme-depth-accent-glow-subtle` — used in **two locations only**: `.xleth-panel-frame.is-focused` (focused panel halo) and `.import-dropzone-overlay` (drag-target halo). These are the sanctioned "use sparingly" surfaces flagged in the plan; both are explicitly accent-affordances that already use accent tints/borders elsewhere in their styling.
- `--theme-depth-floating-top-highlight`, `--theme-depth-floating-shadow`, `--theme-depth-floating-focused-border` — focused-panel composition.

NOT consumed in Pass 3 (deferred to Pass 4):
- `--theme-depth-accent-glow-medium`, `--theme-depth-accent-glow-strong`, `--theme-depth-accent-halo`
- `--theme-depth-elevation-1-bottom-edge`, `--theme-depth-well-top-shadow`
- `--theme-depth-elevation-2-top-highlight`, `--theme-depth-elevation-3-top-highlight`
- `--theme-depth-elevation-2-outer-shadow`, `--theme-depth-elevation-2-bg`, `--theme-depth-elevation-3-bg`
- `--theme-depth-floating-focused-shadow` (intentionally **not** consumed by Pass 3 — the new focused-panel composition routes around it; the token itself is left intact for a future reshape pass)
- `--theme-depth-amplitude` — amplitude `calc()` scaling not introduced (Pass 2 did not verify it in Electron 41).

---

## JSX touches

**None.** All target controls have shared classNames + state hooks already wired:

- `.timeline-toolbar-button` confirmed shared by Timeline + Piano Roll toolbars at [PianoRollToolbar.jsx:121](../../ui/src/components/pianoRoll/PianoRollToolbar.jsx).
- `.timeline-tool-btn` is the timeline tools strip ([TimelineToolbar.jsx:49](../../ui/src/components/timeline/TimelineToolbar.jsx)).
- `.track-header-btn--mute/solo/visual.active` already toggled in JSX.
- `.center-tab.active`, `.sample-row.active`, `.marked-sample-item.selected`, `[data-active="true"]`, `[data-focused="true"]` all already present.

---

## Focused-panel cyan softening

**Old (Pass 2):**
```css
.xleth-panel-frame.is-focused {
  border-color: var(--theme-depth-floating-focused-border);
  box-shadow: var(--theme-depth-floating-top-highlight), var(--theme-depth-floating-focused-shadow);
}
/* expands to: inset 0 1px 0 rgba(255,255,255,0.06),
               0 0 0 1px var(--theme-accent),
               0 12px 40px rgba(0,0,0,0.6) */
```

**New (Pass 3):**
```css
.xleth-panel-frame.is-focused {
  border-color: var(--theme-depth-floating-focused-border);
  box-shadow:
    var(--theme-depth-floating-top-highlight),
    var(--theme-depth-accent-glow-subtle),
    var(--theme-depth-floating-shadow);
}
/* expands to: inset 0 1px 0 rgba(255,255,255,0.06),
               0 0 8px rgba(51,206,214,0.20),
               var(--theme-chrome-shadow) */
```

**Effect:**
- Hard `0 0 0 1px var(--theme-accent)` perimeter ring removed (the "neon rectangle" piece).
- Replaced by a soft `0 0 8px rgba(51,206,214,0.20)` halo behind the panel.
- Outer drop shadow goes back to the same value as idle (`--theme-chrome-shadow`) — focused panels are now *brighter* via halo + accent border, not *heavier* via doubled shadow.
- `border-color = accent` (via `--theme-depth-floating-focused-border` ref to `--theme-border-focus`) preserved as the primary "this panel is focused" cue.

The `--theme-depth-floating-focused-shadow` token itself was intentionally not modified (deferred). Its existing value remains in the catalog and can be reshaped in a future pass without coordinating with consumers.

---

## Cyan-hardcoding policy

Per the Pass 1 known debt (`--theme-depth-accent-glow-*` strings still hold literal `rgba(51, 206, 214, …)` and won't theme correctly under Cool/Warm/Light), Pass 3 used these tokens in **two sanctioned places only**:

1. `.xleth-panel-frame.is-focused` halo.
2. `.import-dropzone-overlay` drag halo.

Both are accent-affordance surfaces already using accent tints/borders. On non-cyan themes they will drift from the theme's accent — accepted as known debt to be fixed in a future derivation pass. Hover and selected states everywhere else use only `--theme-accent`, `--theme-border-focus`, `--theme-focus-ring`, semantic-bg-subtle, or surface elevation — all of which cascade correctly.

---

## Amplitude scaling

**Deferred.** Pass 2 did not verify `calc(<length> * var(--theme-depth-amplitude))` in Electron 41, and Pass 3 did not introduce it. All token consumption is direct. The Theme Editor amplitude knob is also not implemented. `rg "var\(--theme-depth-amplitude" ui/src` returns zero hits.

---

## Verification

Run from `ui/`.

1. **Build** — `npm run build` — **PASS**. Vite built in 2.38s, all chunks emitted, only the pre-existing 500kB chunk-size warning (unrelated to Pass 3). No TypeScript or CSS errors introduced.
2. **Theming tests** — `npx vitest run src/theming` — **PASS** (4 files / 46 tests, 406ms). `depth-tokens.test.ts` (9 tests), `derivation.test.ts` (25), `colorDistance.test.ts` (6), `tokenValue.test.ts` (6) all green.
3. **Selector-leak check** — `rg --files-with-matches "var\(--theme-depth-" ui/src` returned exactly two files: `ui/src/styles/app.css` and `ui/src/windowing/components/windowing.css`. Zero hits inside any `*.jsx` / `*.js` canvas paint path.
4. **JSX-touch check** — no JSX edited in Pass 3. `git diff --name-only` lists only `ui/src/styles/app.css`, `ui/src/windowing/components/windowing.css`, and the doc files.
5. **Runtime smoke** (Vite dev preview at port 5174) — page reloaded; **zero console errors** at `level=error`, **zero warnings** at `level=warn`. DOM `getComputedStyle` confirms:
   - All Pass 1 depth tokens resolve at `:root` (verified `--theme-depth-elevation-1-top-highlight`, `--theme-depth-pressed-inner-shadow`, `--theme-depth-pressed-bg`, `--theme-depth-well-bg`, `--theme-depth-well-inner-shadow`, `--theme-depth-accent-ring`, `--theme-depth-accent-glow-subtle`, `--theme-depth-floating-shadow`, `--theme-depth-floating-focused-border`, `--theme-depth-floating-top-highlight` — all return non-empty strings).
   - `.titlebar` paints `inset 0 1px 0 rgba(255,255,255,0.04)` (Pass 2 + Pass 3 unchanged).
   - `.xleth-panel-frame` (idle) box-shadow = `inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 40px rgba(0,0,0,0.6)` (Pass 2 unchanged).
   - `.xleth-panel-frame.is-focused` box-shadow = `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 8px rgba(51,206,214,0.20), 0 12px 40px rgba(0,0,0,0.6)` — confirms the **hard 1px accent ring is gone** and the soft halo is in place. Border-color still `var(--theme-border-focus)` (= accent).
6. **Visual capture** — `preview_screenshot` timed out after 30s in this Electron/Windows environment (the same flake the plan called out). The DOM-level eval above gives an exact, verifiable measurement of the new composition; pixel-baseline diffs are deliberately deferred (no baseline updates this pass).
7. **Playwright** — `XLETH_PLAYWRIGHT=1 npx playwright test`: **0 passed, 1 failed, 28 did-not-run, 0 skipped, total 29**. Failure was the known Electron-launch flake on this machine — exact error from `tests/baseline/capture.spec.ts:93`:
   > `Error: page.waitForSelector: Target page, context or browser has been closed`
   > `waiting for locator('.app') to be visible`
   > test failed before any assertion ran; subsequent 28 tests did not run because the Playwright runner aborted after the first failure.
   This is the same Electron-attach failure documented in the Pass 3 prompt. No baselines were updated. The failure does not relate to any Pass 3 CSS edit — `.app` selector exists in the DOM (verified via the live preview eval above); Playwright's spawned Electron process exits before the page is attached.

### Smoke notes

- The depth-token-consumption surface area expanded as planned. `getComputedStyle(panel).boxShadow` for `.xleth-panel-frame.is-focused` shows three shadow layers (top-highlight, soft halo, drop) with no hard ring — softening goal achieved.
- Selectors that returned `null` from the live DOM probe (`.center-tab`, `.timeline-toolbar-button`, `.sample-row`, `.track-header-btn`) are simply not mounted in the dev-preview default state (no project loaded). The CSS rules are present (verified via grep + computed `:root` token resolution); they apply when those components mount.
- No theme validation warnings appeared at any point during reload.

---

## Deferred to Pass 4

- Mixer fader thumb / groove tactile depth.
- Pattern list rows.
- Plugin-UI internal controls (already partially depth-styled, out of scope).
- Theme Editor depth-amplitude knob.
- Converting `--theme-depth-accent-glow-*` from hardcoded cyan to accent-derived `derivedFormula()` tokens (Pass 1 known debt).
- Reshaping `--theme-depth-floating-focused-shadow` so the token itself is softer (Pass 3 routes around it instead).
- Canvas-side depth (timeline lanes, piano-roll grid, velocity lane, waveform body).

---

## Acceptance bar (universal)

- No change to: dimensions, spacing, fonts, transitions longer than 0.2s, z-index, hit-test areas, ARIA, keyboard navigation, canvas paint code, engine, bridge, IPC.
- All four shipped themes load without validation warnings.
- `rg "var\(--theme-depth-" ui/src` returns hits only in `windowing.css`, `app.css`, and `theming/`.
- Focused floating panel is clearly differentiated from idle via accent border + soft halo (no neon rectangle).
- Toolbar buttons, tabs, and track buttons read as raised at rest and pressed-in when active.
- Sidebar empty states (`.tab-placeholder-empty`, `.picker-samples-empty`) read as recessed wells.
- Source-card thumbnails read as inset within their card row.
- `git diff --name-only` lists only the three files above plus this plan file.

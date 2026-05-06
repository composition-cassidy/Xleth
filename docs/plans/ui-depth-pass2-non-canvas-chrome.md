# UI Depth — Pass 2 Non-Canvas CSS Chrome

> **Pass 2 is selector-only.** This document describes all CSS changes made in this pass.
> No token catalog, derivation logic, runtime, canvas paint code, or engine code was modified.
> The only acceptable visible changes are: floating panel focused/idle differentiation,
> subtle toolbar top-highlights, and recessed well shadows on video canvas wrapper and waveform scrubber.

Companion to:
- [ui-depth-pass1-token-foundation.md](ui-depth-pass1-token-foundation.md) — the token vocabulary this pass consumes.
- [ui-depth-pass0-diagnostic.md](ui-depth-pass0-diagnostic.md) — the audit that motivated this work.

---

## What changed

### Files touched
- [ui/src/windowing/components/windowing.css](../../ui/src/windowing/components/windowing.css) — 4 rule edits
- [ui/src/styles/app.css](../../ui/src/styles/app.css) — 10 rule edits
- [ui/src/theming/shipped/xleth-light.json](../../ui/src/theming/shipped/xleth-light.json) — 2 token overrides
- [docs/plans/ui-depth-pass2-non-canvas-chrome.md](ui-depth-pass2-non-canvas-chrome.md) — this document

### Files explicitly NOT touched
- `ui/src/theming/tokens/catalog.ts` — Pass 1 is final; no new tokens in Pass 2
- `ui/src/theming/tokens/__tests__/*` — CSS-only; no new tests needed
- `ui/src/styles/app.css` canvas paint paths — `timelineDrawing.js`, `PianoRollCanvas.jsx`, velocity, waveform (Pass 3 scope)
- `ui/src/theming/shipped/xleth-default.json`, `xleth-cool.json`, `xleth-warm.json` — dark themes; catalog defaults are correct
- C++ engine, Node-API bridge, IPC — out of scope

---

## Changes made

### windowing.css

#### `.xleth-panel-frame` — floating panel frame idle state
- `background`: `var(--theme-bg-surface)` → `var(--theme-depth-floating-bg)`
- `border`: `1px solid var(--theme-border-subtle)` → `1px solid var(--theme-depth-floating-border)`
- `box-shadow`: `var(--theme-chrome-shadow)` → `var(--theme-depth-floating-top-highlight), var(--theme-depth-floating-shadow)`

The outer shadow value is identical to before in the default theme (both resolve through `--theme-chrome-shadow`).
The inset top-highlight is new: `inset 0 1px 0 rgba(255, 255, 255, 0.06)` — subtle glass top edge.

#### `.xleth-panel-frame.is-focused` — focused state
- `border-color`: kept equivalent (`--theme-depth-floating-focused-border` refs `--theme-border-focus`)
- `box-shadow` added: `var(--theme-depth-floating-top-highlight), var(--theme-depth-floating-focused-shadow)`

`--theme-depth-floating-focused-shadow` = `0 0 0 1px var(--theme-accent), 0 12px 40px rgba(0, 0, 0, 0.6)`.
This adds an accent-colour 1px outline and a heavier drop shadow — focused panels are now visually distinct from idle panels.

> **Sync rule**: whenever `.xleth-panel-frame`'s `box-shadow` changes, `.xleth-panel-frame.is-focused`'s
> `box-shadow` must be updated in the same commit (same top-highlight token, different shadow token).

#### `.xleth-windowing-titlebar` — panel titlebar
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`
- Inset white line at the top of every panel titlebar: `inset 0 1px 0 rgba(255, 255, 255, 0.04)`

#### `.xleth-top-bar-toggles` — app-level top toolbar strip
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`

---

### app.css

#### `.titlebar` — main app titlebar
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`
- Existing `border-bottom: 1px solid var(--theme-border-subtle)` unchanged.

#### `.titlebar-dropdown` — menu dropdown overlay
- `border`: `1px solid var(--theme-border-subtle)` → `1px solid var(--theme-depth-elevation-3-border)` (refs `--theme-border-strong`)
- `box-shadow`: `0 8px 24px rgba(0,0,0,0.5)` → `var(--theme-depth-elevation-3-outer-shadow)` (refs `--theme-chrome-shadow`)

#### `.context-menu` — context menu overlay
Same treatment as `.titlebar-dropdown` — both are elevation-3 overlays.

#### `.timeline-toolbar` — timeline toolbar strip
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`

#### `.center-tabs` — center tab strip (Timeline / Piano Roll switch)
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`

#### `.piano-roll-floating` — floating piano roll card
- `background`: `#111118` → `var(--theme-depth-floating-bg)` (refs `--theme-bg-elevated`)
- The previous hardcoded hex missed light-theme support; the token cascades correctly across all themes.

#### `.piano-roll-toolbar` — piano roll toolbar strip
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`

#### `.mixer-toolbar` — mixer toolbar strip
- Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)`

#### `.video-canvas-wrapper` — video preview canvas well
- Added `box-shadow: var(--theme-depth-well-inner-shadow)`
- `--theme-depth-well-inner-shadow` = `inset 0 2px 4px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(0, 0, 0, 0.30)`
- Background left as `var(--theme-preview-loaded-bg)` — unchanged.

#### `.waveform-scrubber` — waveform scrubber well
- Added `box-shadow: var(--theme-depth-well-inner-shadow)`

---

### xleth-light.json

Two directly-consumed shadow tokens have large dark-alpha defaults unsuitable for a light theme.
Tokens that resolve via refs (`--theme-depth-floating-shadow`, `--theme-depth-elevation-3-outer-shadow`) are
already covered by the existing `--theme-chrome-shadow` override and need no separate entry.

| Token | Light override |
|---|---|
| `--theme-depth-floating-focused-shadow` | `0 0 0 1px var(--theme-accent), 0 12px 40px rgba(0, 0, 0, 0.20)` |
| `--theme-depth-well-inner-shadow` | `inset 0 2px 4px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(0, 0, 0, 0.10)` |

`--theme-depth-elevation-1-top-highlight` (white inset at 0.04 alpha) needs no override — it is
effectively invisible on light surfaces, which is correct behavior.

---

## Known debt / future passes

1. **`xleth-cool.json` and `xleth-warm.json`** do not have depth overrides. Dark shadow alphas (0.35–0.60)
   are appropriate for these dark themes. If those themes want custom depth values in a later pass,
   add overrides following the same pattern as `xleth-light.json`.

2. **Accent glow tokens** (`--theme-depth-accent-glow-*`, `--theme-depth-accent-halo`) are registered
   but no selector consumes them in Pass 2. These are for Pass 4 (focused clip/note glow, playhead).
   The hardcoded `rgba(51, 206, 214, …)` values in those tokens should be converted to
   `derivedFormula()` entries before broad selector adoption (Pass 3 or Pass 4 gate).

3. **`--theme-depth-amplitude` knob** is registered but no selector uses `calc()` with it yet.
   Pass 3/4 authors must verify `calc(<length> * var(--theme-depth-amplitude))` works in Electron 41's
   Chromium before adopting it widely. See the Pass 1 doc for the verification gate and fallback options.

4. **`box-shadow: var(--A), var(--B)` theme override rule**: any theme that overrides a depth shadow
   token consumed in a multi-layer `box-shadow` declaration must provide a valid shadow string —
   never the bare keyword `none`. Use a zero-alpha shadow string (e.g. `0 0 0 0 rgba(0,0,0,0)`)
   to suppress a layer without breaking the declaration.

---

## Verification

Run from repo root.

1. **TypeScript / build** — `cd ui && npm run build` — CSS-only; should stay green.
2. **Vitest** — `cd ui && npx vitest run src/theming` — all 46 existing tests green; no new tests.
3. **Playwright** — `cd ui && XLETH_PLAYWRIGHT=1 npx playwright test` — report pass/fail/skip counts.
   Do NOT update baselines. Expected diffs: floating panel chrome, toolbars, video wrapper, waveform scrubber.
4. **Selector leak check** — `rg "var\(--theme-depth-" ui/src` — hits only in `windowing.css` and `app.css`.
5. **`git diff --name-only`** — only the four files listed above plus this plan file.

---

## Acceptance bar (universal)

- No change to: dimensions, spacing, fonts, transitions, z-index, hit-test areas, ARIA, keyboard navigation, canvas paint code, engine, bridge, IPC.
- All four shipped themes load without validation warnings.
- `rg "var\(--theme-depth-" ui/src` returns hits only in `windowing.css` and `app.css`.
- Floating panel idle vs focused states are visually distinct (accent ring + heavier shadow on focus).
- Toolbar strips show subtle inset top-highlight in dark themes.
- Video canvas wrapper and waveform scrubber have recessed inset well shadow.
- Light theme: shadows are soft (well shadow at 0.08/0.10 alpha, focused panel at 0.20 alpha).
- `git diff --name-only` lists only the four modified files above.

# UI Depth Pass 4D.2 — Panel Surface Hierarchy

**Date:** 2026-05-05  
**Branch:** codex-save-progress-20260424  
**Scope:** Visual-only surface hierarchy pass for Grid Settings, Sample Selector, and Project Media panels.

---

## Files Changed

| File | Type |
|---|---|
| `ui/src/styles/app.css` | CSS — all visual changes |

No JSX files, no token files, no engine/bridge/IPC/package/baseline files changed.

---

## Selectors Changed

### Grid Settings

| Selector | Change |
|---|---|
| `.grid-tab-section` | Added `background: var(--theme-bg-secondary)`, `border: 1px solid var(--theme-border-subtle)`, `border-radius: var(--radius-sm)`, `padding: 8px`, `box-shadow: var(--theme-depth-elevation-1-top-highlight)` |
| `.grid-tab-section--separated` | Replaced bare top-border separator with full section card (same treatment as above, plus `margin-top: 4px`) |
| `.grid-tab-section h3` | Added `padding-bottom: 5px`, `border-bottom: 1px solid var(--theme-border-subtle)`, `margin-bottom: 2px` |
| `.grid-tab-fslayer-placement` | Added `background: var(--theme-bg-inset)` (recessed container) |
| `.grid-tab-fslayer-placement button` | Changed base bg from `bg-secondary` to `transparent`, color from `text-muted` to `text-subtle`; changed `transition` to fast variant |
| `.grid-tab-fslayer-placement button.active` | Changed from full accent fill (`bg: --theme-accent`) to elevated-bg + accent text: `background: var(--theme-depth-elevation-1-bg)`, `color: var(--theme-accent)`, `box-shadow: var(--theme-depth-elevation-1-top-highlight)` |
| `.grid-tab-track-item` | Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)` |
| `.grid-tab-empty` | Upgraded plain italic text to recessed well: `background: var(--theme-depth-well-bg)`, `border: 1px solid var(--theme-depth-well-border)`, `box-shadow: var(--theme-depth-well-inner-shadow)`, `border-radius: var(--radius-sm)`, increased padding, removed `font-style: italic` |
| `.grid-tab-fslayer-card-controls input[type=range]` | Added `accent-color: var(--theme-accent)` |
| `.grid-tab-track-sliders input[type=range]` | Added `accent-color: var(--theme-accent)` |

### Sample Selector

| Selector | Change |
|---|---|
| `.sample-groups` | Changed `gap: 1px` → `gap: 0` (header border-bottom provides separation) |
| `.sample-group-header` | Added `background: var(--theme-bg-secondary)` as default; added `border-bottom: 1px solid var(--theme-border-subtle)`; set `border-radius: 0` (was `var(--radius-sm)`); removed `background: none` |
| `.sample-group-name` | Added `font-size: 11px`, `font-weight: 600`, `color: var(--theme-text)` |
| `.sample-group-header .tab-item-count` | New scoped rule: `background: var(--theme-bg-elevated)`, `border-radius: 8px`, `padding: 0 5px`, `font-size: 10px`, `line-height: 16px`, `color: var(--theme-text-muted)` |
| `.sample-row-duration` | `color: var(--theme-text-subtle)` → `color: var(--theme-text-muted)` |
| `.sample-row-source` | `color: var(--theme-text-subtle)` → `color: var(--theme-text-muted)` |
| `.tab-search-bar-actions` | Added `background: var(--theme-bg-inset)`, `border: 1px solid var(--theme-border-subtle)`, `border-radius: var(--radius-sm)`, `padding: 1px`, `overflow: hidden`; changed `gap: 2px` → `gap: 0`; changed `display: flex` → `display: inline-flex` |
| `.tab-view-toggle-btn` | Height adjusted to 20px (from 22px to fit inside padded container); `border-radius` to `calc(var(--radius-sm) - 1px)` |
| `.tab-view-toggle-btn.active` | Changed from `bg-elevated + text-primary` to `depth-elevation-1-bg + accent text + elevation-1-top-highlight` |

### Project Media

| Selector | Change |
|---|---|
| `.source-list` | `gap: 2px` → `gap: 3px` |
| `.source-card` | Added `background: var(--theme-bg-secondary)`, `box-shadow: var(--theme-depth-elevation-1-top-highlight)` as default raised state |
| `.source-card:hover` | Hover shadow upgraded to composite: `elevation-1-top-highlight + 0 1px 3px rgba(0,0,0,0.2)` |
| `.source-card-thumbnail` | Added `border: 1px solid var(--theme-border-subtle)` |
| `.source-card-badge` | `background: var(--theme-bg-surface)` → `background: var(--theme-bg-inset)`; added `border: 1px solid var(--theme-border-subtle)` |

---

## Tokens Used

All existing Pass 1 tokens — no new tokens added.

| Token | Usage |
|---|---|
| `--theme-bg-secondary` | Section card backgrounds, source card default bg |
| `--theme-bg-inset` | Segmented control container, view toggle container, badge bg |
| `--theme-bg-elevated` | Count badge background |
| `--theme-bg-surface` | Source card hover, group header hover |
| `--theme-border-subtle` | Section card borders, group header bottom border, thumbnail border, badge border |
| `--theme-border-strong` | Source card hover border |
| `--theme-text` | Group name foreground |
| `--theme-text-muted` | Duration/source metadata (upgraded from text-subtle) |
| `--theme-text-subtle` | Segmented control inactive button |
| `--theme-accent` | Segmented control active text, view toggle active text, slider accent-color |
| `--theme-depth-elevation-1-bg` | Segmented active bg, view toggle active bg |
| `--theme-depth-elevation-1-top-highlight` | Section cards, track items, segmented active, view toggle active, source card default |
| `--theme-depth-well-bg` | Empty state background |
| `--theme-depth-well-border` | Empty state border |
| `--theme-depth-well-inner-shadow` | Empty state shadow |

---

## Tokens Added

**None.**

---

## Light-Theme Overrides Added

**None.** All existing light-theme values in `xleth-light.json` cover the tokens used.

---

## Grid Settings Surface Hierarchy Changes

- Each settings section (`Layout`, `Preview`, `Fullscreen Layers`, `Actions`) is now a visible card with background, border, border-radius, and top-highlight. Sections read as intentional zones instead of floating rows on a flat sheet.
- Section `h3` labels gain a bottom divider, clearly separating the label from the content below.
- Fullscreen layer cards feel editable: they sit inside the section card with their own background and elevation.
- The **Behind/Front segmented control** is redesigned: recessed inset container, inactive side uses `text-subtle` on transparent, active side uses elevated background + accent text + top highlight. No more full-accent fill.
- Track cards now have the elevation-1-top-highlight shadow, giving them a raised card feel consistent with other elevated surfaces in the app.
- Empty states (`No fullscreen layers`, `No tracks yet`) are recessed wells using the `depth-well-*` tokens, matching the established pattern from Piano Roll and Sample Picker.
- All range sliders in FS layer cards and track sliders use `accent-color: var(--theme-accent)`.

---

## Sample Selector Hierarchy Changes

- Group headers now have a permanent `bg-secondary` background (not just on hover) and a bottom divider, making each group a clearly headed section.
- No sticky positioning was added — background + border provides sufficient hierarchy without scroll-area stacking risk.
- Group names upgraded to `font-weight: 600` and `color: var(--theme-text)`, giving them clear prominence over row content.
- Count badges scoped to group headers: pill shape (`bg-elevated`, rounded, padded), distinguishable from plain text.
- Duration and source metadata upgraded from `text-subtle` to `text-muted` for legibility in the light theme (was #8A8A9E → now #5A5A6E equivalent in light).
- The list/grid view toggle is now a proper pill container: `bg-inset` + border + `padding: 1px` wraps both buttons. Active toggle uses elevated-bg + accent text + top highlight instead of just a background fill.
- Groups gap set to 0 — the group header border-bottom provides clean separation between groups without extra space.

---

## Project Media Hierarchy Changes

- Source cards have a default raised state: `bg-secondary` background + elevation-1-top-highlight, so cards feel like designed items instead of borderless rows.
- Hover state adds a composite shadow (elevation highlight + subtle drop shadow) for a tactile lift.
- Thumbnail wells gain a border (`border-subtle`), creating a defined frame around the 80×45 thumbnail area.
- Metadata badges (resolution, FPS) use `bg-inset` + `border-subtle`, reading as compact defined pills rather than barely-visible text on a surface.
- Source list gap increased from 2px → 3px, giving cards a minimal breath.

---

## Dark Theme Visual Notes

- Section cards: subtle but visible — `bg-secondary` is slightly lighter than the panel `bg-primary` in dark themes, creating gentle layering without brightness jumps.
- Elevation highlight (inset 0 1px 0 rgba(255,255,255,0.04)) is subtle in dark but reads on darker backgrounds.
- Segmented control: active side reads clearly against inset container.
- No surface becomes over-bright; density remains high.

## Light Theme Visual Notes

- Section cards: `bg-secondary` in light (#EBEBE7) on `bg-primary` (#F2F2EE) creates readable but restrained card separation.
- Group headers: `bg-secondary` gives clear section anchoring — no dark islands, no washed-out boundaries.
- Duration/source metadata: `text-muted` (#5A5A6E) is clearly readable on light backgrounds (was too faint at `text-subtle` #8A8A9E).
- Segmented control: inset bg (#D4D4D0 equivalent) and accent text (`--theme-accent` = #1A9EA6 in light) contrast well.
- Badge pills: `bg-inset` (#D4D4D0 equivalent) with border reads as defined pills.
- View toggle: pill container visible against the search input background.
- No dark islands. No washed-out panel rows in targeted areas.

---

## Behavior Smoke-Test Notes

- No handlers, state, sorting, grouping, playback, import, or grid logic was touched.
- All changes are CSS property additions/modifications only.
- Segmented control Behind/Front: visual only — click behavior unchanged.
- View toggle list/grid: visual only — toggle behavior unchanged.
- Slider accent-color: cosmetic only — value/event handling unchanged.
- Empty state wells: presentational only — no interactive behavior.

---

## Verification Results

### Build
`npm run build` — **passed** (2.39s, chunk size warning is pre-existing, unrelated to this pass).

### Theme Tests
`npx vitest run src/theming` — **46/46 passed**.

### Playwright
`XLETH_PLAYWRIGHT=1 npx playwright test` — **1 failed, 28 did not run**.  
Failure: `page.waitForSelector('.app', { timeout: 30_000 })` — `Target page, context or browser has been closed`.  
This is the known Electron/Windows attach issue present since prior passes. Not caused by this change. No baselines were updated.

### Scope Check
`git diff --name-only` — only `ui/src/styles/app.css` changed in this pass. All other dirty files were pre-existing from earlier passes on this branch.

---

## Explicit Exclusion Confirmation

- Engine (C++): **untouched**
- Node-API bridge: **untouched**
- IPC: **untouched**
- FFmpeg/JUCE/OpenGL: **untouched**
- Timeline canvas drawing: **untouched**
- Piano Roll canvas drawing: **untouched**
- Sampler Knob drawing: **untouched**
- Package files: **untouched**
- Playwright baselines: **untouched**
- Token catalog (`catalog.ts`): **untouched**
- Light-theme JSON (`xleth-light.json`): **untouched**

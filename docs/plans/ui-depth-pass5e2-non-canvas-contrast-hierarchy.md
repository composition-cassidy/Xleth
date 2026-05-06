# Pass 5E.2 — Non-Canvas FL/VEGAS-Inspired Contrast Hierarchy
## Deliverable Report

---

## Files Changed

| File | Change |
|------|--------|
| `ui/src/styles/app.css` | 14 targeted CSS selector changes |
| `docs/plans/ui-depth-pass5e2-non-canvas-contrast-hierarchy.md` | This report |

**Unchanged (confirmed):**
- `timelineDrawing.js` — not touched
- `TimelineCanvas.jsx` — not touched
- `xleth-default.json` — not touched
- `xleth-light.json` — not touched
- `catalog.ts` — not touched
- `--theme-timeline-lane-bg` — not consumed
- All engine, bridge, IPC, project schema, package files — not touched
- Playwright baselines — not updated

---

## Selectors Changed — Before/After

### Mixer

| Selector | Property | Before | After |
|----------|----------|--------|-------|
| `.mixer-panel` | `background` | `var(--theme-bg-secondary)` | `var(--theme-depth-well-bg)` |
| `.mixer-strip` | `background` | *(none — inherited)* | `var(--theme-bg-secondary)` |
| `.mixer-strip` | `box-shadow` | *(none)* | `var(--theme-depth-elevation-1-top-highlight)` |
| `.mixer-strip--master` | `background` | `var(--theme-bg-surface)` | `var(--theme-bg-elevated)` |
| `.mixer-strip-label` | `color` | `var(--theme-text-muted)` | `var(--theme-text-primary)` |
| `.mixer-fader-groove` | `background` | `var(--theme-border-subtle)` | `var(--theme-depth-well-bg)` |
| `.mixer-fader-thumb` | `box-shadow` | *(none)* | `var(--theme-depth-elevation-1-top-highlight)` |
| `.mixer-fader-readout-input` | `background` | `#0a0a10` *(hardcoded)* | `var(--theme-bg-inset)` |
| `.effect-chain-full-popover` | `box-shadow` | `0 4px 16px rgba(0,0,0,0.5)` *(hardcoded)* | `var(--theme-depth-elevation-2-outer-shadow)` |

### Sample Selector

| Selector | Property | Before | After |
|----------|----------|--------|-------|
| `.sample-group-header` | `background` | `var(--theme-bg-secondary)` | `var(--theme-depth-well-bg)` |
| `.sample-group-rows` | `background` | *(none)* | `var(--theme-bg-secondary)` |
| `.sample-row:hover` | `background` | `var(--theme-bg-surface)` | `var(--theme-bg-elevated)` |

### Project Media

| Selector | Property | Before | After |
|----------|----------|--------|-------|
| `.source-card-thumbnail-placeholder` | `background` | `var(--theme-bg-surface)` | `var(--theme-bg-inset)` |

### Timeline Side Chrome

| Selector | Property | Before | After |
|----------|----------|--------|-------|
| `.timeline-header-column` | `background` | `var(--theme-bg-secondary)` | `var(--theme-bg-surface)` |

### Hardcoded CSS Cleanup

| Selector | Property | Before | After |
|----------|----------|--------|-------|
| `.mixer-fader-readout-input` | `background` | `#0a0a10` | `var(--theme-bg-inset)` |
| `.effect-chain-full-popover` | `box-shadow` | `0 4px 16px rgba(0,0,0,0.5)` | `var(--theme-depth-elevation-2-outer-shadow)` |
| `.timeline-pattern-rename-input` | `color` | `#000` | `var(--theme-text-on-accent)` |

---

## Key Design Decisions

### Sample group header: `--theme-depth-well-bg` not `--theme-bg-tertiary`

The diagnostic originally mentioned `--theme-bg-tertiary` for shelf headers. On inspection, the dark theme derives `bg-tertiary` as `bg-primary + dL=4.8` and `bg-secondary` as `bg-primary + dL=3.14`. This means **tertiary is lighter than secondary in the dark theme** — using it for headers would invert the shelf contrast (lighter header, darker row bed).

`--theme-depth-well-bg` resolves to `--theme-bg-inset` in both themes — darker than primary in dark (`#0d0d14`), darker than secondary in light (`#D4D4D0`). This creates the correct shelf direction in all themes.

### Fader thumb: additive box-shadow

`.mixer-fader-thumb` had no existing `box-shadow`. The top-highlight was added as the only shadow value, not as a replacement of an existing stack. The hover/active state rule only overrides `border-color`, so the shadow is correctly inherited there.

### `.sample-row.active` unchanged

After changing hover to `bg-elevated`, the active rule (`bg-elevated + pressed-inner-shadow`) uses the same background but a distinctly different shadow. The visual distinction between hover (top-highlight = lifted) and active (pressed-inner-shadow = pressed in) is maintained.

---

## Dark Theme Visual Notes

- **Mixer rack**: drops from `#111118` to `#0d0d14` — slightly darker recessed well
- **Mixer strips**: now `#111118` with top-edge highlight — clearly raised above the rack
- **Master strip**: `#222230` — noticeably brighter than regular strips, with accent left border intact
- **Mixer labels**: `--theme-text-primary` instead of `--theme-text-muted` — stronger contrast at 10px
- **Fader groove**: `#0d0d14` — narrow recessed channel clearly visible
- **Fader thumb**: top-edge highlight reads as a raised cap above the groove
- **Sample group headers**: `#0d0d14` — darker shelf dividers clearly below the `#111118` row beds
- **Sample rows**: defined `#111118` row bed vs. transparent before
- **Sample hover**: `#222230` — strong, clearly lifted above `#111118` bed
- **Thumbnail placeholder**: `#0d0d14` — recessed inset well visible inside the card
- **Timeline header column**: `#1A1A24` (`bg-surface`) — slightly elevated above the darker arrangement canvas

---

## Light Theme Visual Notes

- **Mixer rack**: `--theme-bg-inset` = `#D4D4D0` — darker recessed bed ✓
- **Mixer strips**: `--theme-bg-secondary` = `#EBEBE7` — lighter than rack ✓
- **Master strip**: `--theme-bg-elevated` = `#ECECE8` — slightly closer to white ✓
- **Sample group headers**: `--theme-bg-inset` = `#D4D4D0` — darker than row beds (`#EBEBE7`) ✓
- **Sample rows**: `#EBEBE7` row bed — clear contrast with `#D4D4D0` header ✓
- **Sample hover**: `#ECECE8` — lighter than row bed, visible lift ✓
- **Thumbnail placeholder**: `#D4D4D0` — clearly darker than surrounding card surface ✓
- **Timeline header column**: `#E6E6E2` (`bg-surface`) — near app chrome, no dark island ✓
- No contrast inversions observed in token ladder analysis

---

## Behavior Smoke Notes

No behavior was changed. Changes are background/color/shadow CSS properties only on static non-interactive surfaces or decoration properties on interactive elements:

- Fader drag behavior: unchanged (only `border-color` transition and `box-shadow` added, both non-functional)
- Mute/solo buttons: unchanged (no CSS changes to `.mixer-ms-btn`)
- Effect chain popover: same position, same size, same scroll behavior (only `box-shadow` changed)
- Sample group expand/collapse: unchanged (background transition preserved, only value changed)
- Sample row selection/playback: unchanged (active state preserved, only hover level raised)
- Project Media selection/import: unchanged
- Timeline pattern rename input: same behavior, `color` token swap only

---

## Build Result

```
✓ built in 2.39s
```

No errors. One pre-existing chunk size warning (index.js ~600KB) unrelated to this pass.

---

## Theme Test Result

```
Test Files  5 passed (5)
      Tests  49 passed (49)
   Duration  425ms
```

All 49 theming tests pass. No unknown-token warnings.

---

## Playwright

Not run. Runtime visual smoke is the appropriate verification method for CSS changes of this type.

---

## Scope Check

`git diff --name-only` confirms only `ui/src/styles/app.css` was modified by this pass. All other modified files are pre-existing branch changes from prior passes (5A–5E.1).

**Hard exclusion confirmations:**
- `timelineDrawing.js` — ✓ not touched
- `TimelineCanvas.jsx` — ✓ not touched
- `--theme-timeline-lane-bg` — ✓ not consumed
- Timeline clip alpha — ✓ not changed
- Timeline grid line tokens — ✓ not changed
- `--theme-bg-inset` value — ✓ not modified (only used in two new locations)
- `xleth-default.json` — ✓ not touched
- `xleth-light.json` — ✓ not touched
- `catalog.ts` — ✓ not touched
- Engine / bridge / IPC / project schema / package files — ✓ not touched
- Playwright baselines — ✓ not updated

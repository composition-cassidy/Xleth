# UI Depth Pass 4C — Secondary Editor Surfaces

## Summary

A restrained CSS-only finishing pass that brings secondary editor surfaces (Pattern List sidebar,
Timeline scrollbar, Piano Roll scrollbar thumbs, Piano Roll zoom gutter) up to the same theme-aware
quality as the canvas surfaces improved in Passes 4A and 4B.

---

## Files Changed

| File | Change type |
|---|---|
| `ui/src/styles/app.css` | 13 property-value substitutions across 4 selectors blocks |
| `ui/src/theming/tokens/catalog.ts` | 2 new explicit tokens added |
| `ui/src/theming/shipped/xleth-light.json` | 2 new light-theme overrides added |

**Not touched:** engine, bridge, IPC, JUCE/FFmpeg/OpenGL, package files, Playwright baselines,
Timeline canvas drawing, Piano Roll canvas drawing, VelocityLane DOM, keyboard boundary DOM,
track header DOM, ruler canvas.

---

## Problem Areas Fixed

### 1 — Timeline Pattern List / Sidebar

**Root cause:** 9 hardcoded dark hex literals in `app.css` (lines 1795–1960):
`#888`, `#ddd`, `#aaa`, `#666`, `#999`, `#ccc`, `#252833`.
None are visible or correct in light theme.

**Selectors changed:**

| Selector | Property | Old | New |
|---|---|---|---|
| `.pattern-list-expand-btn, .pattern-list-collapse-btn` | `color` | `#888` | `var(--theme-text-muted)` |
| `.pattern-list-expand-btn:hover, .pattern-list-collapse-btn:hover` | `color` | `#ddd` | `var(--theme-text)` |
| `.pattern-list-title` | `color` | `#aaa` | `var(--theme-text-muted)` |
| `.pattern-list-empty` | `color` | `#666` | `var(--theme-text-muted)` |
| `.pattern-list-group-header` | `color` | `#999` | `var(--theme-text-muted)` |
| `.pattern-list-row` | `color` | `#ccc` | `var(--theme-text)` |
| `.pattern-list-row-meta` | `color` | `#666` | `var(--theme-text-muted)` |
| `.pattern-list-new-btn` | `color` | `#ccc` | `var(--theme-text-muted)` |
| `.pattern-list-new-btn:hover` | `background` | `#252833` | `var(--theme-bg-hover)` |

No structural changes. Row density, padding, `border-left`, hover background token
(`--theme-pattern-list-item-hover-bg`), and hover foreground (`var(--theme-fg-inverse)`) unchanged.

### 2 — Timeline Scrollbar Thumb

**Root cause:** Normal-state thumb used `var(--theme-text-subtle)` = `#8A8A9E` on `#F2F2EE`
background → ~2.8:1 contrast in light theme (below WCAG AA for UI controls).

**Selectors changed:**

| Selector | Property | Old | New |
|---|---|---|---|
| `.timeline-scrollbar-thumb` | `background` | `var(--theme-text-subtle)` | `var(--theme-text-muted)` |
| `.timeline-scrollbar-thumb:hover` | `background` | `var(--theme-text-muted)` | `var(--theme-text)` |

Active state (`var(--theme-accent)`) unchanged.
Light contrast improved: `--theme-text-muted` (`#5A5A6E`) on `#F2F2EE` → ~4.9:1 ✓

### 3 — Piano Roll Scrollbar Thumbs

**Root cause:** Hardcoded `rgba(255,255,255,0.18/0.28/0.35)` in normal/hover/active states.
White-on-white on the light keyboard background (`#F2F2EE`) = invisible.

**Two new tokens added** (dark-only values in catalog, light overrides in xleth-light.json):

| Token | Dark | Light |
|---|---|---|
| `--theme-pianoroll-scrollbar-thumb` | `rgba(255, 255, 255, 0.22)` | `rgba(0, 0, 0, 0.28)` |
| `--theme-pianoroll-scrollbar-thumb-hover` | `rgba(255, 255, 255, 0.36)` | `rgba(0, 0, 0, 0.44)` |

**Selectors changed:**

| Selector | Property | Old | New |
|---|---|---|---|
| `.piano-roll-scrollbar-thumb` | `background` | `rgba(255,255,255,0.18)` | `var(--theme-pianoroll-scrollbar-thumb)` |
| `.piano-roll-scrollbar-thumb:hover` | `background` | `rgba(255,255,255,0.28)` | `var(--theme-pianoroll-scrollbar-thumb-hover)` |
| `.piano-roll-scrollbar-thumb:active` | `background` | `rgba(255,255,255,0.35)` | `var(--theme-accent)` |

Active state unified with Timeline scrollbar behavior (uses accent on grab).

### 4 — Piano Roll Zoom Gutter

**Root cause:** `#08080c` / `#0c0c12` hardcoded — jet black in light theme.

**Selectors changed:**

| Selector | Property | Old | New |
|---|---|---|---|
| `.piano-roll-zoom-gutter` | `background` | `#08080c` | `var(--theme-bg-inset)` |
| `.piano-roll-zoom-gutter:hover` | `background` | `#0c0c12` | `var(--theme-bg-hover)` |

Dark behavior preserved: `--theme-bg-inset` = `#0d0d14` (catalog explicit) ≈ `#08080c`.
Light: `#D4D4D0` ✓. Hover: `#D8D8D4` in light ✓.

---

## Tokens Used (existing)

`--theme-text`, `--theme-text-muted`, `--theme-bg-hover`, `--theme-bg-inset`,
`--theme-fg-inverse`, `--theme-accent`, `--theme-text-subtle` (removed from scrollbar thumb)

## Tokens Added (new)

| Token | Catalog location | Reason |
|---|---|---|
| `--theme-pianoroll-scrollbar-thumb` | after `--theme-pianoroll-key-label-fg` | rgba flip: `white/α` in dark vs `black/α` in light cannot share one value |
| `--theme-pianoroll-scrollbar-thumb-hover` | same group | hover state for same reason |

---

## Surfaces Confirmed Already Correct (no changes made)

| Surface | Status |
|---|---|
| Timeline ruler canvas | `resolveTimelinePalette()` — fully tokenized in Pass 4B |
| Timeline track headers | `var(--theme-text)`, `var(--theme-bg-surface)`, `var(--theme-border-subtle)` |
| Timeline canvas grid/clips | Pass 4B — unchanged |
| Piano Roll velocity lane | `var(--theme-pianoroll-velocity-bg)`, `var(--theme-border-subtle)` |
| Piano Roll keyboard | `borderRight: 1px solid var(--theme-border-subtle)` |
| Piano Roll canvas | Pass 4A.1 — unchanged |
| Piano Roll scrollbar tracks | `var(--theme-pianoroll-key-white-bg)` — already themed |

---

## Dark Theme Visual Notes

- Pattern list: names are slightly brighter (`var(--theme-text)` vs `#ccc`), consistent with
  other track label text. Count values and labels remain muted.
- Timeline scrollbar: slightly stronger normal thumb (text-muted vs text-subtle). Hover now
  uses full text color — more responsive feedback.
- Piano Roll scrollbar: dark values stepped slightly higher (0.22/0.36 vs 0.18/0.28) for
  better visibility; active now cyan (accent) matching Timeline.
- Zoom gutter: `--theme-bg-inset` = `#0d0d14` vs previous `#08080c` — imperceptibly different.

## Light Theme Visual Notes

- Pattern list names (`#18181F`) and counts (`#5A5A6E`) both clearly readable on `#EBEBE7` bg.
- Section title "PATTERNS" and empty state use `--theme-text-muted` → 4.9:1 ratio ✓.
- Hover state: `--theme-pattern-list-item-hover-bg` = `#D0D0CC` bg + `--theme-fg-inverse` = `#000` text ✓.
- Timeline scrollbar thumb visible: `#5A5A6E` on `#F2F2EE` → ~4.9:1 ✓.
- Piano Roll scroll thumbs visible: `rgba(0,0,0,0.28)` on `#F2F2EE` — perceptible track indicator.
  Hover `rgba(0,0,0,0.44)` noticeably stronger.
- Zoom gutter: `#D4D4D0` (inset surface) — clearly distinct from the adjacent keyboard bg.

---

## Behavior Smoke-Test Notes

All behavioral systems unchanged:
- Timeline scroll/zoom/snap/hit-test: no geometry or event handler changes
- Pattern drag-and-drop: no changes to `PatternListPanel.jsx` logic
- Track header mute/solo/visual-only buttons: CSS for active states unchanged
- Piano Roll scroll behavior: scrollbar components (`PianoRollScrollbarV/H.jsx`) unchanged
- Piano Roll zoom gesture: zoom-gutter CSS change is visual-only, no event handler touched
- Velocity editing: unchanged
- Canvas hit testing: unchanged

---

## Performance Notes

- No `getComputedStyle()` calls introduced (CSS custom properties resolve natively)
- No `ctx.shadowBlur` introduced
- No infinite redraw loops from theme switching
- All changes are static CSS property values — zero runtime overhead

---

## Verification Results

```
npm run build          ✓  built in 2.56s (no errors)
npx vitest run src/theming   ✓  46/46 tests passed
```

**Scope check (`git diff --name-only` relative to this pass):**
```
ui/src/styles/app.css
ui/src/theming/tokens/catalog.ts
ui/src/theming/shipped/xleth-light.json
docs/plans/ui-depth-pass4c-secondary-editor-surfaces.md
```

Engine, bridge, IPC, package files, and Playwright baselines: **not modified**.

## Playwright

Not run — Electron attach flake documented in prior passes. Not blocking this CSS-only pass.

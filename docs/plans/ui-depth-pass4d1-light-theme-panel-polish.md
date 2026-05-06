# Pass 4D.1 — Light-Theme Panel Polish

## Files Changed

| File | Change type |
|------|-------------|
| `ui/src/components/timeline/TimelineToolbar.jsx` | JSX: replaced inline `style={}` with `className="timeline-declick-input"` |
| `ui/src/components/SampleSelectorTab.jsx` | JSX: error banner background hardcode → token |
| `ui/src/components/SamplePicker/SamplePicker.jsx` | JSX: error banner background hardcode → token |
| `ui/src/styles/app.css` | CSS: 5 selectors added/patched |

No engine, bridge, IPC, audio backend, Timeline canvas, Piano Roll canvas, Sampler Knob,
package, or Playwright baseline files were touched.

---

## Selectors Changed

### New: `.timeline-declick-input` (app.css ~line 1751)
```css
.timeline-declick-input {
  width: 40px;
  background: var(--theme-bg-inset);
  border: 1px solid var(--theme-depth-elevation-1-border);
  color: var(--theme-text);
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 10px;
  text-align: right;
}
.timeline-declick-input:focus {
  outline: none;
  border-color: var(--theme-border-focus);
}
```

### Patched: `.grid-tab-track-item` — added `border`
```diff
+ border: 1px solid var(--theme-border-subtle);
```

### Patched: `.grid-tab-fslayer-remove:hover` — replaced hardcoded red
```diff
- color: #ff6464;
- border-color: #ff6464;
+ color: var(--theme-semantic-danger-text);
+ border-color: var(--theme-semantic-danger-text);
```

### Patched: `.grid-tab-fslayer-card` — added top-highlight shadow
```diff
+ box-shadow: var(--theme-depth-elevation-1-top-highlight);
```

### Patched: `.source-card` and `.source-card:hover` — added border hierarchy
```diff
+ border: 1px solid var(--theme-border-subtle);
  transition: ... ,
+             border-color var(--transition-fast);

.source-card:hover
+ border-color: var(--theme-border-strong);
```

---

## Tokens Used

| Token | Purpose |
|-------|---------|
| `--theme-bg-inset` | Declick input recessed background (`#D4D4D0` in light) |
| `--theme-depth-elevation-1-border` | Declick input border (alias → `--theme-border-subtle`) |
| `--theme-text` | Declick input text (confirmed base token in catalog.ts:168) |
| `--theme-border-focus` | Declick focused border |
| `--theme-border-subtle` | Track-item border, source-card default border |
| `--theme-border-strong` | Source-card hover border |
| `--theme-depth-elevation-1-top-highlight` | Fslayer card top-edge shadow |
| `--theme-semantic-danger-text` | Layer remove hover: `#ff8a8a` dark / `#CC2244` light |
| `--theme-semantic-danger-bg-subtle` | Error banner bg: `rgba(255,71,87,0.12)` dark / `rgba(204,17,34,0.10)` light |

## Tokens Added

None.

## Light-Theme Overrides Added

None. All required light-theme values were already present in `xleth-light.json`:
- `--theme-semantic-danger-bg-subtle`: `rgba(204, 17, 34, 0.10)` (line 43)
- `--theme-depth-well-inner-shadow` (pre-existing override for thumbnail wells)

---

## Declick Field Fix

**Problem:** `TimelineToolbar.jsx:151` had a `style={{ background: '#1a1a2e', border: '1px solid #333', color: '#ddd', ... }}` inline prop — hardcoded dark navy that ignored the theme entirely.

**Fix:** Removed the inline `style` prop, added `className="timeline-declick-input"`. The new CSS class uses `--theme-bg-inset` for the background (a clearly recessed well tone), `--theme-depth-elevation-1-border` for the border, and `--theme-text` for the text. All three tokens have correct light-theme values, so the field now matches the surrounding Timeline toolbar controls in both themes.

---

## Grid Settings Polish (First Cleanup Pass)

Three targeted changes; a deeper structural depth pass remains as future work if the panel still reads flat after these.

1. **Track item borders** — `.grid-tab-track-item` had `background: var(--theme-bg-secondary)` with no border. In light theme the cards blended into the panel background. Adding `border: 1px solid var(--theme-border-subtle)` gives each track assignment card a clear visual boundary. `box-sizing: border-box` is confirmed globally so no layout shift.

2. **Remove-button hover** — `.grid-tab-fslayer-remove:hover` used hardcoded `#ff6464`, a light coral that reads as muted in dark mode and too pale in some light backgrounds. Replaced with `var(--theme-semantic-danger-text)` which has the correct value for each theme.

3. **Fullscreen layer card depth** — `.grid-tab-fslayer-card` already had `background` and `border`. Added `box-shadow: var(--theme-depth-elevation-1-top-highlight)` for a subtle inset top-edge highlight in dark theme. In light theme the token (`inset 0 1px 0 rgba(255,255,255,0.04)`) is near-invisible, which is harmless — depth in light theme comes from the background/border color contrast.

---

## Sample Selector Polish

**Error banner** (`SampleSelectorTab.jsx:444`, `SamplePicker/SamplePicker.jsx:498`):
Both instances used `background: '#3a1e1e'` (hardcoded dark red block), which in light theme renders as an opaque dark slab over a light surface.

Replaced with `background: 'var(--theme-semantic-danger-bg-subtle)'`. In light theme this resolves to `rgba(204, 17, 34, 0.10)` — a transparent light-red tint that reads correctly. In dark theme it resolves to `rgba(255, 71, 87, 0.12)` — visually similar to the previous dark red.

No changes to list view rows (already theme-token-based), group headers, thumbnails, or
thumbnail overlays (dark overlays on thumbnail imagery are intentionally theme-agnostic).

---

## Project Media Polish

`.source-card` in its default state had no background and no border — only a hover state. In light theme, cards with no visual boundary blended into the panel surface.

Added `border: 1px solid var(--theme-border-subtle)` to the default state, giving each card persistent row definition. On hover the border steps up to `var(--theme-border-strong)` to reinforce the interactive state. `box-sizing: border-box` (global, app.css:26) prevents any row-height change.

---

## Dark-Theme Visual Notes

- **Declick input:** Uses `--theme-bg-inset` which in dark theme is the same deep recessed background used by piano roll gutter and similar inputs. Visually matches other toolbar inputs.
- **Track item borders:** `--theme-border-subtle` in dark theme is very low-opacity — adds just enough separation without boxing things heavily.
- **Source card borders:** Same — nearly invisible in dark mode, provides expected separation in light mode.
- **Fslayer-remove hover:** `--theme-semantic-danger-text` in dark = `#ff8a8a`, similar brightness to the previous `#ff6464`.

## Light-Theme Visual Notes

- **Declick input:** `--theme-bg-inset` = `#D4D4D0` — clearly recessed against the toolbar surface, no longer a dark island.
- **Error banners:** Transparent light-red tint instead of dark solid block.
- **Track items:** Subtle border makes assignments readable as distinct rows.
- **Source cards:** Persistent border gives each media row a clear boundary; hover strengthens it.

---

## Behavior Smoke-Test Notes

- Declick `<input type="number">` retains `min/max/step/value/onChange` — behavior unchanged.
- All Grid Settings controls (column/row/gap inputs, sliders, Behind/Front toggle, Add/Clear buttons) use unmodified CSS rules — behavior unchanged.
- Error banners retain their `role="alert"` and display logic — only background color changed.
- Source card click, hover, and drag-drop use unmodified event handlers — only transition and border added.

---

## Verification Results

### Build
```
✓ built in 2.46s
```
No errors or new warnings beyond the pre-existing 601 kB chunk size advisory.

### Theme Tests
```
Test Files  4 passed (4)
Tests       46 passed (46)
Duration    415ms
```

### Scope Check (`git diff --name-only` this pass)
- `ui/src/components/timeline/TimelineToolbar.jsx` ✓
- `ui/src/components/SampleSelectorTab.jsx` ✓
- `ui/src/components/SamplePicker/SamplePicker.jsx` ✓
- `ui/src/styles/app.css` ✓
- `docs/plans/ui-depth-pass4d1-light-theme-panel-polish.md` ✓

No engine, bridge, IPC, Timeline canvas, Piano Roll canvas, Sampler Knob, package, or
Playwright baseline files changed.

### Playwright
Not run in this pass — Electron attachment failure documented in prior passes. No baselines updated.

---

## Explicit Exclusion Confirmations

- Engine/bridge/IPC/audio backend: **untouched**
- Timeline canvas drawing (`TimelineCanvas.jsx`, `timelineDrawing.js`): **untouched**
- Piano Roll canvas drawing (`PianoRollCanvas.jsx`): **untouched**
- Sampler Knob (`Knob.jsx`): **untouched**
- Package/dependency files: **untouched**
- Playwright baselines: **untouched**

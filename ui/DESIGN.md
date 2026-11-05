# Xleth UI design contract

Read this before touching any stylesheet or component. It is the contract for the
UI rebuild. Phase 0 (this file, cascade layers, tokens, guards, render harness)
changes almost nothing visually; later phases are measured against it.

Status: **Phase 0 in progress.** Sections marked *(Step N)* describe work that lands in a
later Phase 0 commit; the decisions are final, the code is not yet.

---

## 1. Surface and stance

- **Surface: Operate.** Xleth is a tool people live in for hours. Chrome is neutral, content is
  colourful, colour has jobs. Marketing-page rules do not apply.
- **DAW Floor is non-negotiable:** text 11–13px at 100% (never below 10px), labels and values
  at least 4.5:1, control boundaries at least 3:1, every hit area at least 24×24, every drag has
  a keyboard/typed alternative, colour is never the only signal, no fabricated signal (no demo
  meters or placeholder waveforms in real views).
- **Signature move:** a track's identity colour threads through **grid cell ↔ arrangement lane
  ↔ mixer strip ↔ viewer layer list**. One colour, four places, always the same.
- **Hard offset shadow** `4px 5px 0 rgba(0,0,0,.5)` on **floating surfaces only** (menus,
  popovers, popped-out windows). Never on docked panels. No blur, no glow, no gradients on chrome.
- **Mirror test (covered-logo):** structurally close to Live (browser left, detail dock bottom,
  hint bar ≈ Info View). What separates it: a preview-centred A/V layout, the identity-colour
  thread into the video layer list, an inverted-ink toggle chip instead of a yellow activator,
  and the hard-offset shadow. The weakest point is palette (grey + cyan value + yellow solo).
  Cyan is Xleth's own user-themeable accent; the toggle chip is the real separator. Do not
  introduce yellow/orange for "on" (Ableton trade dress) or lime (FL).

## 2. Stylesheet architecture

Cascade order, lowest to highest: `@layer reset, legacy, tokens, kit;` (declared in
`ui/src/styles/layers.css`, imported first in `main.jsx`) *(Step 2)*.

- **Every existing stylesheet lives in `legacy`.** Unlayered CSS beats every layer, so a sheet
  left unlayered would silently override kit styles. Layering is checked against the *built* CSS.
- **`!important` inside `legacy` still beats kit declarations** (important declarations invert
  layer order). Later phases must **delete** the legacy rule they replace, never fight it.
- `ui/src/styles/app.css` is frozen: **do not append to it.** `npm run check:legacy-css`
  fails if its line count exceeds `ui/scripts/legacy-css-baseline.json`. The baseline only goes
  down; update it whenever lines are removed. *(Step 5)*
- New styles go in `ui/src/ui-kit/**` (`@layer kit`) or `*.module.css`. `npm run lint:css`
  rejects, in those files: hex/named/`rgb()`/`hsl()` colours (only `tokens.css` may define
  them), `px` font sizes, and `transition: all`. *(Step 5)*
- No Tailwind, no CSS-in-JS, no component library.
- `tokenValue()` must never be called at module scope (it returns `''` before `ThemeProvider`
  mounts). Canvas stays canvas; never replace draw calls with DOM overlays.
- Debug logs from the kit use the `[UIKit]` prefix.

## 3. Colour

### 3.1 Neutral ramp (dark default)

Chrome carries **no hue**: a video compositor needs a neutral surround so picture colour is
judged correctly. Contrast is WCAG 2.x, measured on the listed surface (re-asserted by the
unit test in `ui-kit/`).

| Token | Hex | Role | on g0 | on g1 | on g2 | on g3 |
|---|---|---|---|---|---|---|
| `g0` | `#141414` | wells, ground | | | | |
| `g1` | `#1B1B1B` | panel | | | | |
| `g2` | `#222222` | header | | | | |
| `g3` | `#2B2B2B` | control | | | | |
| `g4` | `#3A3A3A` | divider, **decorative only** (1.51 on g1) | | | | |
| `boundary` | `#747474` | control outlines | 3.94 | **3.69** | **3.40** | **3.03** |
| `ink` | `#E6E6E6` | primary text | 14.76 | 13.80 | 12.75 | 11.34 |
| `ink-2` | `#B4B4B4` | secondary text | 8.89 | 8.31 | 7.67 | 6.83 |
| `ink-3` | `#929292` | **dimmest text allowed anywhere** | 5.92 | 5.54 | 5.11 | 4.55 |

**Adjustment from the original brief:** `boundary` was `#6B6B6B` (3.23 on g1 but 2.99 on g2
and 2.66 on g3, below the 3:1 non-text floor on headers and control fills). `#707070` was
tried and still fails on g3 (2.86). `#747474` clears 3:1 on g0–g3 (table above); the unit test
asserts `boundary >= 3:1` on g1, g2 and g3.

Nothing dimmer than `ink-3` is permitted for text. "Disabled" is expressed with the 45% dim
plus a glyph/state, not a darker text colour.

### 3.2 Semantic colours (colour has jobs)

| Token | Value | Job | Notes |
|---|---|---|---|
| `--ui-value` | `--theme-accent` (`#33CED6` default; 8.97:1 on g1) | value fills, active displays | user-themeable |
| `--ui-on` | inverted chip: `ink` background, `g1` text | toggles that are on | deliberately not yellow/orange/lime |
| `--ui-select` | 1px `--ui-value` outline | selection | outline, never fill-only |
| `--ui-rec` | `#E5484D` | record/arm **fills and glyphs only** | 4.40:1 on g1, so **never as text** |
| `--ui-rec-text` | `#F06A6E` | record/arm **text** | 5.73 g1, 4.71 g3 |
| `--ui-solo` | `#E8B53A` | solo | 9.11:1 on g1 |
| `--ui-clip` | `--theme-danger` | clipping / error | |
| mute | content at 45% **plus** a mute glyph | never colour alone | |

State is visible at rest, never hover-only. Muted content dims, not just its button.

### 3.3 Signal-type hues

Four hues for cables, ports and meters by signal type (audio, events, parameter, video). Each
is at least 30° (OKLCH) from the accent and from every state hue, and at least 30° from each
other. OKLCH hues of the state colours: **accent 200°, rec 23°, danger 21°, solo 85°.**
(These differ from their HSL hues; all exclusion maths in this repo is OKLCH.)

| Signal | OKLCH | Hex | on g1 | on g3 |
|---|---|---|---|---|
| audio | L.72 C.12 H255 | `#6FA7EE` | 6.92 | 5.69 |
| events | L.72 C.12 H150 | `#69BA7C` | 7.31 | 6.01 |
| parameter | L.72 C.12 H295 | `#AA95E8` | 6.70 | 5.51 |
| video | L.72 C.12 H330 | `#CF88C8` | 6.57 | 5.40 |

### 3.4 Identity palette (tracks)

There is **one** identity palette: `--theme-track-palette-1..16` (catalog category *Labels*).
No parallel `--ui-id-*` set exists or may be added.

**How tracks store colour** (`components/timeline/trackColorResolver.js`): each track has a
`trackColorMode` of `auto | paletteSlot | custom`.
- `auto`: the colour is `palette[visibleIndex % 16]`: an **index** into the palette, by track order.
- `paletteSlot`: `trackColorSlot` 1..16: an **index** into the palette.
- `custom`: `trackColorCustom` `#RRGGBB`: a literal **hex**, untouched by palette changes.

Consequence: changing a palette value **recolours existing projects** for every `auto` and
`paletteSlot` track pointing at it. Therefore palette edits are minimal: only entries that
fail the rules below change, and every change is listed with before/after hex in the commit
that makes it *(Step 3)*.

**Rules** (asserted by the unit test against `xleth-default.json`):
1. OKLCH, lightness alternating about 0.68 / 0.78, chroma about 0.12 (existing hues keep their
   own L/C; only hue moves when an entry must move).
2. No hue within **20° (OKLCH)** of value (200°), rec (23°), solo (85°) or danger (21°).
3. The automatic label colour, whichever of `ink` / `g1` contrasts more, must reach 4.5:1.
   The check reuses the same WCAG luminance maths as `appearanceTheme.js`
   (`relativeLuminance`, `contrastOf`, exported with no behaviour change). Note that
   `contrastText` there is a text-versus-background solver, not a label picker.

**Audit of the current default palette** (before any change): slots **6** (`#DEB963`, 1° from
solo), **8** (`#4AB7A9`, 17° from accent), **9** (`#DF6666`, 1° from rec), **13** (`#D3AA41`,
2° from solo) and **16** (`#DB6A7B`, 11° from rec) violate rule 2. Slot **4** (`#8A6FE0`) is the
only borderline label-contrast entry (4.50 on g1, to be measured exactly in the test). These
five or six are the only entries that may change.

Where edits land: `xleth-default.json` (explicit values) and `TRACK_PALETTE_FALLBACK` in
`trackColorResolver.js`. The catalog's own defaults are **not** changed, because `xleth-warm`
and `xleth-cool` inherit them and must stay as they are. `xleth-light` overrides all 16 and is
untouched (it has the same five exclusion violations and fails the `ink`/`g1` label rule on 14
slots; fixing that is Phase 7).

The palette is generated against the *default* accent and is **not recomputed when a user
changes their accent**. Phase 7 adds a theme-editor warning for accent/identity hue clashes.

## 4. Typography

- **Face:** `--xleth-global-font-family`, unchanged:
  `"Neuzeit Grotesk", "Inter", "Noto Sans", "Segoe UI", system-ui, sans-serif`.
- **Licensing:** Neuzeit Grotesk is a commercial face and Xleth is a public repo. The `.otf`
  files are **not committed and must never be**. Public builds fall back to Inter, then the
  rest of the stack. **That fallback is intentional**, not a bug to fix. (The legacy
  `@font-face` rules point at `../../../*.otf`, which does not exist in a clean checkout.)
- **Scale (px at 100% UI scale):** `--type-10` meter ticks and units only · `--type-11` label ·
  `--type-12` default control text · `--type-13` section header · `--type-16` panel and dialog
  title. How the tokens are expressed (so the global 100–200% UI scale applies) is settled
  in `tokens.css`; kit stylesheets only ever reference the tokens.
- **Weights:** 400 / 500 / 600. **Sentence case.** No letter-spaced uppercase labels.
- **Numbers:** every value uses `font-variant-numeric: tabular-nums`. Timecode and bars|beats
  readouts use **IBM Plex Mono** 400/500 via `@fontsource/ibm-plex-mono` *(Step 3)*; the face
  is referenced today but not installed, so it currently falls back to Consolas.

## 5. Spacing, size, radius

- `--space-1..5` = **4 / 8 / 12 / 16 / 24**.
- Control heights **24 / 28 / 32**. Panel header **28**. List rows **24** for anything
  interactive, **20** only for read-only or keyboard-primary lists.
  *(Adjustment: the brief allowed 20px rows, but adjacent interactive 20px rows fail the
  24×24 hit-area floor; WCAG 2.5.8's spacing exception does not apply to stacked rows.)*
- **Hit area at least 24×24**, always. Visual controls may be smaller; the clickable cell may not.
- Radius **0 / 2 / 4**, chosen by role (0 for chrome and panels, 2 for controls, 4 for chips and
  popovers). The legacy 4/6/8 `--radius-*` tokens stay for `legacy`.
- Keep the existing z-index ladder (`--xleth-z-*`, documented at the top of `windowing.css`).

## 6. Value format *(`ui-kit/format.ts`, Step 4)*

Number, **thin space U+2009**, unit. **True minus U+2212**, never a hyphen-minus.

| Unit | Rule | Example |
|---|---|---|
| dB | 1 decimal | `−6.0 dB` |
| Hz | below 1 k: 0 decimals; from 1 k: kHz, 2 decimals | `455 Hz`, `5.49 kHz` |
| ms | below 100: 1 decimal; else 0 | `12.5 ms`, `250 ms` |
| % | 0 decimals | `70 %` |
| ratio | 1 decimal, spaced colon; infinite is `inf` | `4.0 : 1`, `inf : 1` |

Legacy inconsistencies (`db`, `dB`, `0dB`, mixed minus signs) are fixed per component as each
phase rebuilds it, through `formatValue`, never by regex.

## 7. Control gestures (identical on every control)

| Gesture | Result |
|---|---|
| Drag | change value |
| Shift + drag | fine |
| Double-click | type a value |
| Ctrl + click | reset to default |
| Wheel | step |
| Arrow keys | nudge (Shift ×10) |

The **whole cell, including its label, is draggable.** Controls expose `role="slider"` with an
`aria-valuetext` such as `"Cutoff, 455 Hz"`. Every control shows its value and unit; there is no
knob without a readout. A persistent **hint bar** names the hovered control and its modifiers;
tooltips are not documentation.

## 8. Layout contract (target for Phase 1; not built in Phase 0)

```
┌ Menus │ transport · time · BAR.BEAT · BPM │ panel toggles │ win ┐ 36
├ Browser │ Preview (16:9)            │ Inspector              ┤ ~340 @1080p
│ (full   ├───────────────────────────┴────────────────────────┤
│ height) │ Arrangement — full width, one ruler, video+audio   │ rest
├ Detail dock: Devices │ Mixer │ Piano Roll │ Sampler │ FX Graph ┤ 28 collapsed
└ Hint bar: hovered control + its modifiers                     ┘ 22
```

## 9. Known gaps (deliberately out of scope for Phase 0)

- **Settings > Appearance:** `appearanceTheme.js` builds its theme from hard-coded **hue-240**
  anchors and overrides `bg-primary`, `bg-surface`, `bg-inset` and the text tiers. **Users who
  have applied an Appearance theme will not see the neutral ramp until Phase 7.** The only edit
  Phase 0 makes to that file is exporting `relativeLuminance` and `contrastOf`.
- **Other shipped themes:** `xleth-warm`, `xleth-cool` and `xleth-light` are unchanged.
- **Neutral switch scope:** only `xleth-default.json` moves to the ramp; legacy muted text is
  repointed (`--xleth-flat-text-muted` → the `ink-3` equivalent) so it clears 4.5:1.
- **Inline styles:** about 511 `style={{…}}` objects bypass tokens. Later phases.
- **`app.css`:** 34,380 lines, six `:root` blocks, four appended override passes. It shrinks only
  by deletion, phase by phase, ratcheted by the baseline file.
- **Shots harness limits** *(Step 6)*: `npm run shots` runs without the engine
  (`window.xleth` absent) and covers chrome only. Anything needing live audio, video or the
  bridge must be checked in the real Electron app.

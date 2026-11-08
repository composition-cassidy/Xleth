# Xleth UI design contract

Read this before touching any stylesheet or component. It is the contract for the
UI rebuild. Phase 0 (this file, cascade layers, tokens, guards, render harness)
changes almost nothing visually; later phases are measured against it.

Status: **Phases 0 to 8 landed.** Phase 0 laid the layers, tokens, `format.ts`, guards and `npm run shots`;
Phases 1 to 7 built the shell and the kit; Phase 8 (section 13) removed the dead UI code and the CSS and
dialogs the rebuild superseded.

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
`ui/src/styles/layers.css`, imported first in `main.jsx`).

- **Every existing stylesheet lives in `legacy`.** Unlayered CSS beats every layer, so a sheet
  left unlayered would silently override kit styles. Vite emits the layers correctly (verified
  on the built CSS: the only top-level constructs are the `@layer` order statement, `@layer
  legacy { … }` blocks and the fontsource `@font-face` rules).
  - `app.css` is layered **without being edited**, via `styles/legacy.css`
    (`@import './app.css' layer(legacy)`), imported in `main.jsx` at the position `app.css`
    always had, so the relative order of all legacy sheets is unchanged.
  - The package stylesheet `@xyflow/react/dist/style.css` is layered the same way
    (`styles/vendor-xyflow.css`).
  - The eight component sheets (`windowing`, `fxGraph`, `fxGraphEffectPicker`, `clipControls`,
    `clipControlTuner`, `EffectModule.sidechain`, `sandbox`, `designer`) are wrapped
    in-file in `@layer legacy { … }` because components import them from JS.
  - `@fontsource/*` sheets contain only `@font-face`, which is not part of the cascade.
  - `styles/__tests__/layers.test.js` fails the suite if any stylesheet or CSS import is
    unlayered, or if `layers.css` is not the first import of `main.jsx`.
  - `welcome.html` / `splash.html` are separate pages with their own inline CSS and are outside
    the renderer bundle.
- **`!important` inside `legacy` still beats kit declarations** (important declarations invert
  layer order). Later phases must **delete** the legacy rule they replace, never fight it.
- `ui/src/styles/app.css` is frozen: **do not append to it.** `npm run check:legacy-css`
  fails if its line count exceeds `ui/scripts/legacy-css-baseline.json`. The baseline only goes
  down; after deleting rules run `npm run check:legacy-css -- --update` (it refuses to raise
  it). The unit suite enforces the same ratchet.
- New styles go in `ui/src/ui-kit/**` (`@layer kit`) or `*.module.css`. `npm run lint:css`
  rejects, in those files: hex/named/`rgb()`/`hsl()` colours (only `tokens.css` may define
  them), `px` font sizes (including in the `font` shorthand), and `transition: all`. Built-in
  stylelint rules only; no plugins. Legacy sheets are not linted.
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
that makes it (the table below).

**Rules** (asserted by the unit test against `xleth-default.json`):
1. OKLCH, lightness alternating about 0.68 / 0.78, chroma about 0.12 (existing hues keep their
   own L/C; only hue moves when an entry must move).
2. No hue within **20° (OKLCH)** of value (200°), rec (23°), solo (85°) or danger (21°).
3. The automatic label colour, whichever of `ink` / `g1` contrasts more, must reach 4.5:1.
   The check reuses the same WCAG luminance maths as `appearanceTheme.js`
   (`relativeLuminance`, `contrastOf`, exported with no behaviour change). Note that
   `contrastText` there is a text-versus-background solver, not a label picker.

**Audit and the changes made in Phase 0.** Five slots violated rule 2 and one failed rule 3
(measured exactly: `#8A6FE0` is 4.454:1 on g1, not 4.50). Only those six changed, each keeping
its lightness and chroma and moving hue to the nearest legal position with at least 8° of
clearance from every other slot (slot 4 instead gained 0.01 of lightness). Smallest movement was
chosen on purpose: existing `auto`/`paletteSlot` tracks recolour with the palette.

| Slot | Before | After | OKLCH hue | Why | Label on g1 |
|---|---|---|---|---|---|
| 4 | `#8A6FE0` | `#8D72E3` | 291.9° → 292.0° | label contrast | 4.45 → 4.63 |
| 6 | `#DEB963` | `#C7C368` | 86.5° → 106.5° | 1.5° from solo → 21.5° | 9.2 → 9.4 |
| 8 | `#4AB7A9` | `#4EB7A4` | 183.6° → 179.5° | 16.4° from value → 20.5° | 7.1 → 7.1 |
| 9 | `#DF6666` | `#DB6E3B` | 22.1° → 44.0° | 0.9° from rec → 21.0° | 5.2 → 5.2 |
| 13 | `#D3AA41` | `#E99D50` | 87.2° → 63.9° | 2.2° from solo → 21.1° | 7.9 → 7.7 |
| 16 | `#DB6A7B` | `#D76A8F` | 12.4° → 0.2° | 10.6° from rec → 22.8° | 5.2 → 5.2 |

Known trade-offs of keeping hue exclusion: the palette no longer contains a pure red (that hue
belongs to rec/clip), and slots 3, 9 and 13 are now three oranges (44°, 55°, 64°) separated
mainly by lightness and chroma, as are slots 5 and 16 (pinks, 11° apart). Sixteen hues in the 240°
that remain average 15° apart, so some crowding is inherent. All six changes are asserted by
`ui-kit/__tests__/tokens.test.ts`, which also fails if any other slot moves.

Where edits land: `xleth-default.json` (explicit values) and `TRACK_PALETTE_FALLBACK` in
`trackColorResolver.js`. The catalog's own defaults are **not** changed, so a custom theme that
inherits them keeps its colours. Phase 7 gave every shipped theme (light, high contrast, warm, cool) these same
16 explicit values (3.6); light's own darker set, which broke the exclusion rule and failed the label rule on 14
slots, is gone.

The palette is generated against the *default* accent and is **not recomputed when a user
changes their accent**. Phase 7 added the theme-editor warning for accent/identity hue clashes (3.6).

### 3.5 How legacy surfaces map onto the ramp (Default theme only)

`xleth-default.json` now sits on the ramp; the legacy `--theme-*` names are unchanged, so
nothing in `app.css` needed editing apart from one declaration.

| Legacy token | Was | Now |
|---|---|---|
| `--theme-bg-primary`, `--theme-bg-inset` | `#0A0A0F`, `#0D0D14` | `#141414` (g0) |
| `--theme-bg-surface` | `#1A1A24` | `#1B1B1B` (g1) |
| `--theme-bg-secondary` / `-tertiary` / `-hover` / `-active` / `-elevated` | tinted, derived | grey, derived: `#1C1C1C` / `#202020` / `#252525` / `#2F2F2F` / `#252525` |
| `--theme-text` | `#E8E8ED` | `#E6E6E6` (ink) |
| `--theme-text-muted` | `#8888A0` (derived) | `var(--theme-ui-ink-2)` `#B4B4B4` |
| `--theme-border-subtle` | `#2A2A38` (derived) | `var(--theme-ui-g4)` `#3A3A3A` |
| `--theme-text-on-accent` | `#0D0D14` | `#141414` |
| `--xleth-flat-text-muted` (`app.css`) | `var(--theme-text-subtle)` (2.4:1) | `var(--ui-ink-3)` (5.54:1) |

The legacy three-tier text ladder therefore reads ink (13.8) > ink-2 (8.3) > ink-3 (5.5).
`--theme-text-subtle` and `--theme-text-placeholder` stay derived (now `#595959`, 2.46:1 on g1, still below the floor):
they are the legacy "below the floor" tier and disappear as components are rebuilt; the kit
never uses them. Panel-local tinted tokens in the Default theme (for example
`--theme-timeline-lane-bg`, `--theme-syllable-splitter-bg`, `--theme-sampler-key-border`) and
hard-coded hexes inside `app.css` are **not** touched in Phase 0; each moves with its panel.

The kit tokens (`--ui-*`) follow the base tokens through `deriveTheme`. Since Phase 7 the ramp
steps and the semantic colours come from one table per theme (section 3.6), so the kit is
theme-aware: dark, light and high contrast.

### 3.6 Themes, UI scale and the workspace (Phase 7)

**One table, three themes.** `theming/tokens/neutralRamp.ts` is the single source of the
neutral ramp and the semantic and signal colours. A theme file names its `ramp` (`dark`,
`light`, `hc`); without the field (every file saved before Phase 7) the ramp is inferred from
`bg-surface` luminance (light surface = `light`, else `dark`; `hc` is never inferred). A ramp row
is a set of signed lightness steps from the theme's own base tokens (g2, g3, g4 from `bg-surface`;
ink-2, ink-3, boundary from `text`), so a custom theme that changes a base still gets a coherent
ramp, plus its `rec`, `rec-text`, `solo` and the four signal hues. A theme that omits a base takes
it from its ramp row (the old hue-240 anchors survive only in `tokens/base.ts` for the derivation
tests). Panel-local surfaces that were blue-tinted (timeline lane bed, Preview surround
`--theme-preview-loaded-bg`, piano-roll bed and keys, velocity lane, knob wells, syllable splitter,
node ports, pattern hover) are `ref`s to the ramp, so they are neutral in every theme.

| Theme | g0 | g1 | g2 | g3 | g4 | boundary | ink | ink-2 | ink-3 | accent |
|---|---|---|---|---|---|---|---|---|---|---|
| dark (Default) | `#141414` | `#1B1B1B` | `#222222` | `#2B2B2B` | `#3A3A3A` | `#747474` | `#E6E6E6` | `#B4B4B4` | `#929292` | `#33CED6` |
| light | `#DCDCDC` | `#E9E9E9` | `#F0F0F0` | `#F7F7F7` | `#C4C4C4` | `#6E6E6E` | `#1A1A1A` | `#444444` | `#5C5C5C` | `#006C71` |
| high contrast | `#000000` | `#0A0A0A` | `#141414` | `#1F1F1F` | `#595959` | `#D0D0D0` | `#FFFFFF` | `#E0E0E0` | `#C8C8C8` | `#33CED6` |

On g1: dark ink 13.8 / ink-2 8.3 / ink-3 5.5 / boundary 3.7; light 14.3 / 8.0 / 5.5 / 4.2; high
contrast 19.8 / 15.0 / 11.8 / 12.8. Light's ground (g0) is its *darkest* step and controls are raised
toward white; g4 is a decorative divider in dark and light, and a visible one (2.4:1) in high contrast.
Semantic and signal colours keep the dark ramp's OKLCH hue and chroma and only move in lightness (light:
darker; high contrast: brighter), so the hue-exclusion rules of 3.3 and 3.4 hold in every theme. High
contrast also strengthens the grid: timeline and piano-roll bar / beat / step lines are 65 / 40 / 22 %
white over g0 (7.4 / 3.7 / 1.8:1), asserted by test. In dark and light the bar line is about 2.3 and 2.0:1,
below the 3:1 Floor for bar lines: **open**, left as designed to keep the grid's quiet look.

**Floors, asserted per theme** (`ui-kit/__tests__/themes.test.ts`, all five shipped themes): ink, ink-2,
ink-3 at least 4.5:1 on g0..g3 (7:1 in high contrast); boundary at least 3:1 (7:1); `value`, `clip`
(on g0..g2; danger text uses `--theme-semantic-danger-text`), `rec-text`, `solo` and the four signals at
least 4.5:1 (7:1); `rec` at least 3:1; warning text on its own tinted background; automatic identity
labels at 4.5:1; every chrome surface an exact grey. `--theme-text-subtle` and `-placeholder` now equal
ink-3, so nothing dimmer than ink-3 remains. `color-scheme` follows the ramp.

**One identity palette across themes.** Light, high contrast, warm and cool use Default's 16 colours,
so a track keeps its colour when the theme changes. (Light used to ship its own darker 16 and failed the
label rule on 14 of them.)

**Warm and cool are accent variants.** Their JSON is Default's with the accent family changed
(`--theme-accent`, its derived fills, the volume mod tint): warm amber `#E8943A`, cool cobalt
`#6490F2` (lightened from `#5B8AF0`, which was 4.27:1 on g3). Surfaces and ink are identical to Default
(asserted). The amber hue sits within 20 degrees of three identity colours; the theme editor warns
about any accent that does (`accentIdentityClashes`).

**Custom themes keep loading.** Nothing on disk is rewritten and `schemaVersion` stays 1. A saved file
resolves to the colours it was saved with; the ramp is inferred; a file whose chrome is tinted logs a
`[Theme]` warning and shows "Tinted chrome" in the editor with a one-click Neutralize. `user-appearance`
(Settings > Appearance) used to anchor on hue 240 with saturation 100 (about a 16 % cast) as its default;
it now anchors on the neutral ramp. Its `saturation` option is the **tint amount as a percentage of the
neutral cap** (`TINT_CHROMA_CAP` = OKLCH chroma 0.012): 0 is grey and is the default, 100 is the cap, and
the slider runs to 300 so that pushing past the cap warns instead of silently refusing. Settings saved before
`appearanceModelVersion` 2 are mapped once (`migrateLegacyAppearance`: the untouched 240 / 100 default becomes
0, a deliberate cast keeps its hue and a proportional tint, contrast below the new minimum is raised). Text
contrast cannot go below 80 %, which is where ink-3 reaches 4.5:1. The ink tiers are solved against the panel,
then nudged out where a ramp surface would fall under 4.5:1, and the polarity is whichever pole has the better
worst case over g0..g3. Physical limit: near mid brightness no single colour reaches 4.5:1 on a spread of
surfaces, so there g2 and g3 are flattened toward the panel instead of leaving the text's reach.

**Accent never on chrome (load-time migration).** A saved user theme or Appearance file used to load verbatim, and
the ramp stepped ink-2 / ink-3 / boundary off a text colour that carried the accent's hue by HSL lightness, which
amplifies a faint cast into a strongly coloured outline (chroma 0.008 -> 0.10). Three layers now hold the line.
(1) `deriveTheme` never gives a `--theme-ui-*` step more OKLCH chroma than the base it steps from. (2)
`buildAppearanceTheme` holds text, boundary and dividers at the neutral cap whatever the tint slider says; only
surfaces may pass it (and warn). (3) `migrateChrome` (`runtime/chromeMigration.ts`, `chromeModel` 2) runs in
memory when a user theme loads (boot and the editor): it caps explicit surface chroma at 0.010 and ink chroma at
0.008 keeping lightness and hue, points the legacy text tiers and border-subtle at ink-2 / ink-3 / g4 like the
shipped themes, drops stale old-default cyan accent fills on a non-cyan theme, and stamps the file. It is
idempotent, never reads accent, danger or identity colours, and never writes the file: that only happens when the
user saves. `findTintedInk` (ink chroma > 0.02) logs a `[Theme]` warning. Guarded by
`theming/__tests__/chromeAccentGuard.test.ts` over the five shipped themes, three saved-theme fixtures and the
Appearance builder at its extreme tint; `npm run shots -- --theme-file <json>` photographs a saved theme through
the same path.

**Theme editor.** Simple mode is brightness, text contrast, tint and tint hue (surfaces) plus accent and
danger; the knobs are read back from any resolved theme, so they open correctly on a custom one. Live
readouts show ink, ink 3 and boundary against the panel (ratio, and Pass or Below, never colour alone).
Advanced mode shows the same readouts and warning above the token tree. It is reached from Settings >
Application > Appearance > Theme editor: "Open editor" mounts `ThemeEditorContent` (embedded) under the
Appearance sliders, "Close editor" unmounts it (so each opening starts from the active theme, and **Revert**
restores the theme that was active when it opened). **Apply** sets the active theme; **Save as New Theme** keeps
a copy. The section is absent when there is no `ThemeProvider`.

**UI scale.** The scale is the Electron window zoom factor: real zoom, so hit-testing is right; never a
CSS transform. 100 to 200 % in 10 % steps (`electron-main/ui-scale.js`), persisted as the percent `uiScale`,
restored when the workspace window loads, mirrored in the renderer by `stores/uiScaleStore.js` through
`xleth:window:zoomChanged`. The Settings > Appearance slider, Zoom In / Zoom Out / Reset Zoom and their
shortcuts all move that one value (`window.setZoom` and `window.getZoom` sit beside the old three).
Chromium reports zoom as a `devicePixelRatio` change without resizing the CSS box, so every canvas has to
re-size its backing store: `useThemeEpoch()` also bumps on a DPR change (15 canvases already keyed on it
follow), `ui-kit/dpr.ts` (`useDprEpoch`, `subscribeDpr`) is the shared signal for the rest, and
`ui-kit/__tests__/dpr.test.ts` fails for any file that reads `devicePixelRatio` without one of them or a
per-frame size check. At 200 % a 1366 px window is 683 CSS px: below 1100 CSS px the top bar is two rows
(`--shell-topbar-h` doubles) and below 800 the detail dock tabs drop their glyphs. A window narrower than
that still scrolls the panel toggles rather than shrinking them under 24 px.

**Workspace backdrop: removed.** The image, video and native-acrylic backdrop modes, Backdrop FX, their
Settings sections, `BackdropLayer`, the `xleth:backdrop:*` IPC and the transparent acrylic window are gone;
the workspace window is opaque. The docked layer already covered the backdrop everywhere (Phase 1), and the
main renderer has no start-screen surface to host one (Welcome is its own window).

## 4. Typography

- **Face:** `--xleth-global-font-family`, unchanged:
  `"Neuzeit Grotesk", "Inter", "Noto Sans", "Segoe UI", system-ui, sans-serif`.
- **Licensing:** Neuzeit Grotesk is a commercial face and Xleth is a public repo. The `.otf`
  files are **not committed and must never be**. Public builds fall back to Inter, then the
  rest of the stack. **That fallback is intentional**, not a bug to fix. (The legacy
  `@font-face` rules point at `../../../*.otf`, which does not exist in a clean checkout.)
- **Scale (px at 100% UI scale):** `--type-10` meter ticks and units only · `--type-11` label ·
  `--type-12` default control text · `--type-13` section header · `--type-16` panel and dialog
  title. The tokens are plain px. The global UI scale (DAW Floor) is the Electron window zoom
  factor (`window:zoomIn/zoomOut/setZoom`, 100 to 200 %, see 3.6), which scales px uniformly, so no
  separate scale variable exists. Kit stylesheets only ever reference the tokens.
- **Weights:** 400 / 500 / 600. **Sentence case.** No letter-spaced uppercase labels.
- **Numbers:** every value uses `font-variant-numeric: tabular-nums`. Timecode and bars|beats
  readouts use **IBM Plex Mono** 400/500 via `@fontsource/ibm-plex-mono` (imported in
  `main.jsx`; `--ui-font-mono`). Legacy `app.css` already referenced the face, so timecode
  now renders in it instead of falling back to Consolas.

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

## 6. Value format (`ui-kit/format.ts`: `formatValue`, `formatValueText`)

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

### 8.1 Sharing the centre column (round 2)

The centre column (top row, arrangement, detail dock) is split by one pure function,
`windowing/layout/shellLayout.ts` (`computeShellLayout`, driven by `useShellLayout` from the column's measured
height A). Regions render the result; the stored sizes are still what a drag commits to.

- **Detail dock, open:** `clamp(320, 40% of A, 520)` until the user resizes it. A stored value of 304 (the old
  default every earlier layout holds) means "never resized". A dragged size is kept and persisted.
- **Top row (Preview + Inspector):** minimum **200px**, never squeezed. An untouched row (stored 340) leaves the arrangement
  8 rows; a row the user resized may take space down to the arrangement's 4-row minimum.
- **Arrangement:** minimum 4 rows = 95px chrome (toolbar 38, ruler 26, cue lane 30) + 4 x 36px.
- **Not all three fit** (A - dock < 200 + 239): the top row folds to a **28px strip** with Preview and Inspector
  buttons. They open the row as a 200px **sheet** over the arrangement (hard offset shadow; Esc, a press outside, or
  the button again closes it). Folded panels stay mounted but report themselves not visible (no decoding).
  The dock yields only if the arrangement would drop under 4 rows.

| Window | A | Dock | Top row | Arrangement |
|---|---|---|---|---|
| 1920x1080 | 1022 | 409 | 230 | 383 (8 rows) |
| 1366x768 | 710 | 320 | 28 strip | 362 (7 rows) |

The Inspector scrolls inside its own region (`Inspector.module.css` `.root`).

**Dock focus mode.** Double-clicking the open dock tab (a single click still collapses the dock, after a 250 ms
double-click window), the maximize button at the right end of the tab strip, or `Ctrl+Shift+D` (`view.dockFocus`,
rebindable in Settings > Shortcuts) gives the dock the whole centre column; the same gesture restores the previous
layout. The top row and the arrangement are hidden (still mounted, reporting not visible); the top bar, transport and
hint bar stay. With the dock collapsed the command opens the last-used tab first. Collapsing the dock or opening the
sample picker ends focus mode. State lives in `layout/shellLayoutStore.ts`, not in the saved layout.

**Preview.** The picture is an absolutely positioned canvas with `object-fit: contain` on the neutral ground g0, so the
render resolution (25 % to 100 %) changes only how soft it is, never how big. The placeholder ("No frame yet") is a real
element that exists only until the first frame has been drawn. The header (`components/PreviewHeader.jsx`) is one 28px
row: timecode and frame number left; right, FPS (only while playing), state chips, **View** menu (renderer, resolution,
quality: Poster frames or Live frames), then FX, Edit grid and Import as kit controls. A chip appears only when its state
differs from the default and is neutral with an info glyph and a `data-hint`: **Poster** while Poster frames are on,
and the renderer by name when it is not WebGL. There is no "Preview = Render" badge; the Poster hint says exports are
always full-fidelity. Below 720px the chips keep only their glyph; below 600px Edit grid and Import do too.

**Top bar panel controls** (`components/TitleBarRegions.jsx`). Four region toggles (Browser, Preview, Inspector, Detail
dock) and one **Tools** menu (Sample Sandbox F10, Quick Notation, Split Syllables, then the user's own launchers from
Settings > Launchers), all kit controls with a `data-hint` that names the shortcut. The launchers that duplicated detail
dock tabs (Piano Roll, Mixer, FX Graph, Sampler) and the Timeline toggle are gone; their F-keys and menu entries are
unchanged. The dock-magnification plate and its hook were deleted with the legacy launcher CSS.

## 9. Device system (Phase 4a)

Every stock effect is a **device**: one frame, one title bar, one height. Kit:
`ui-kit/device/` (`DeviceFrame`, `DeviceSection`, `DisplayWell`, `DeviceMenu`). App wiring:
`components/devices/` (`EffectDevice`, `DeviceChain`, `deviceNames.js`, the preset and A/B hooks).

**Size.** `--device-h` **256px** for every device, docked or floating; `--device-title-h` 24px;
the body is the rest. Only the width varies with complexity. A folded device is a vertical title
strip `--device-fold-w` 28px wide. The detail dock opens at **304px** (1px border, 28px tab strip,
4px padding, the 256px device, the chain's thin horizontal scrollbar).

**Title bar, identical on every device, in this order:**
1. **Activator**: the bypass `Toggle` (power glyph), shown at rest. On = inverted ink chip.
2. **Fold**: collapses the device to the vertical strip (state per device instance).
3. **Name**: sentence case from the one map, `DEVICE_NAMES`. Also the drag handle (reorder in
   the chain, move when floating). A 2px stripe in the owning track's identity colour runs
   along the top edge: the identity thread continues from the strip to the device.
4. **Preset menu**: kit `Select` driven by `useEffectPresets` (the same presetManager /
   adapter path as the legacy preset strip). Save / delete / undo-load are in the more menu.
5. **A/B compare**: `useAbCompare`, renderer-only: each side is a preset-adapter state blob,
   switching captures the current side and applies the other through the existing setters.
   Not an undo entry (stock parameters have no undo; see below).
6. **More** (`DeviceMenu`): preset actions, copy A/B, delete.
7. **Pop-out** (docked) or **close** (floating): opens the same device in a window through
   `EffectEditorHost`. While popped out, the docked slot is a strip with a return button, so a
   device is never live twice.

Devices whose editor has not moved to the frame yet (Phase 4b) keep the same title bar
minus presets and A/B, and a body that opens their existing editor. No fake content.

**Body.** Sections left to right in **signal order**, each under a `SectionHeader` strip
(`DeviceSection`, which can fold). **One** recessed `DisplayWell` (g0) is the hero; it hosts an
existing canvas, drawn from real engine data, and switches views in place from its corner.
**At most one oversized hero control** per device (Compressor: threshold, 44px dial).

**Bypassed.** Three signals, never colour alone: the activator shows off, "Off" is printed
after the name, the body dims to `--ui-mute-opacity`. Controls stay editable.

**Shadow.** The hard offset shadow appears on a popped-out device only, never in the chain.

**Chain (Devices tab).** The selected mixer track's insert chain (`useMixerStore.selectedChainKey`,
`useEffectChainStore.chains[key]`), left to right, scrolling horizontally. No track selected =
the master chain. Ends in a plain text drop zone, "Drop effects here", which opens the existing
FX picker. Reorder = drag a device by its name: local preview while dragging, **one**
`moveEffect` on drop. A track whose FX Graph owns its effects shows that, not a chain.

**Undo.** Stock-effect parameters, bypass and chain moves have **no undo** in the engine today
(null UndoManager; the only chain command is `LoadEffectChainCommand`). The devices keep exactly
that behaviour; the one-step revert after a preset load remains. "Every edit is undoable"
(DAW Floor) is open and needs engine work.

**Debug logs** use the `[Device]` prefix.

## 10. Mixer (Phase 5)

The Mixer tab of the detail dock: identical strips scrolling between a fixed Master + loudness
dock. There is **no inspector column**: a track's detail lives in the Inspector and the Devices
tab (the inserts button opens Devices on that track). Components: `components/mixer/`
(`MixerPanel`, `MixerStrip`, `MasterStrip`, `RoutingBand`) and `components/MasterLoudnessMeter.jsx`.

**Strip** (84 px normal, 68 px compact, the setting is renderer-only UI state), top to bottom:
identity stripe (3 px top edge, the same colour as lane, device and layer) with number and name ·
inserts button · M / S / V Toggles at rest · Pan (bipolar) and Width Knobs · volume NumberBox ·
Fader + Meter (printed dB scale, peak hold, clip latch) · routing cable row · Output Select.
**Muted** dims every row but the name and the M/S/V row (`--ui-mute-opacity`) and shows a mute glyph;
**selected** is a 1px `--ui-select` outline. M/S/V are real engine state; **there is no arm**
(the engine has no record-arm) and **no sends** (`TrackInfo.sends` is reserved and always empty),
so neither is drawn.

**Meters.** The mixer's one existing 125 ms `getAllPeaks` poll writes `peaksSnapshot` and then
fans levels out through `mixerMeterBus` to the kit Meters (dB, own rAF ballistics, asleep at
rest). No timer was added and nothing is a DOM segment.

**Routing.** `RoutingBand` is one canvas over each strip's cable row, drawn from the store's own
`outputRoutes` and `sidechainRoutes` (`routingCables.js` is the pure geometry): a dot in the
track's identity colour, a run to the Master rail (arrow into the dock) or a lane to the bus it
feeds, and sidechain cables thinner, dashed and lower contrast, all in `--ui-signal-audio`.
Disabled, stale or dangling routes are not drawn. The canvas redraws on change only and takes no
pointer events; the Output Selects are the controls.

**Loudness dock.** Off, or nothing measured: every value is "—" with its unit and no bars are
drawn. Values go through `formatValue`; a true peak over the ceiling is flagged "Over" in words.
The target is a labelled Select (platform targets, `none` omitted because the meter reads it as
unset) writing the `xleth.export.loudnessTarget` key the export dialog shares.

**Gallery.** `?view=ui-kit` shows 16 strips with mixed states from `MixerGalleryFixture` (MOCK
data, gallery only; a test fails if anything else imports it).

## 11. Browser, sample picker, icons (Phase 6)

**Browser** (`components/LeftPanel.jsx` and `components/browser/`). Kit `Tabs` (Media | Samples, sentence case, each with its
glyph) and the drawer's own controls share one 28px row; below it one search field per tab (Enter remembers a search, an
empty focused field offers the last 8, per tab, `localStorage`); then the list. Rows are **24px**: a type glyph or the label's
identity colour as a 2px edge stripe, the name, then tabular numerals (a sample is `0.42 s`, a source is `3:24`). Groups have
disclosure triangles. Selected = a 1px `--ui-select` outline, never fill alone. **Preview on select** goes through
`components/samplePreview.js`, the one `<audio>` the row's play button has always used (media-server URL, seek on
`loadedmetadata`, cut at the region end); an **Auto-preview** toggle (on by default) controls whether selecting a sample, or an
audio-only source, plays it. A video source shows its still, resolution, frame rate, length and proxy state in a ruled strip under
the list, with a play button for its sound. **Empty state** is the kit `EmptyState` in the first row with an "Import media"
action, and the whole Media list region is the drop target (outline + "Drop files to import", for files from outside the app only).
**Collapsed** the drawer is a 28px rail holding an expand control and the two tab icons, so it is somewhere to go; the dock-side
control is a single button that cycles Left, Right, Top, Bottom. Debug logs use `[Browser]`.

**Sample picker as a sheet** (`windowing/components/PickerSheet.tsx`). The picker no longer replaces the shell: `XlethRoot`
keeps one `AppShell` mounted, and the sheet is absolutely positioned at the top of the centre column, as tall as the top dock
region (floor 280px) and as wide as that column, so it covers **Preview and Inspector only**. The Browser stays beside it as the
source list (double-click another source and the picker retargets, remounting so the old source unloads), and the arrangement, the
transport and the detail dock stay visible and live. It carries the one hard offset shadow, as a floating surface. Inside:
source picture, waveform + controls, marked list. **Keyboard:** opening moves focus into the sheet and closing returns it to where
it was; Esc, Space, I and O act only for events *inside* the sheet (`samplePickerGate.isSamplePickerKeyTarget`), so out in the
arrangement Space is the transport's again. The controls row, waveform canvas and marked rows inside are still their legacy styles.

**Icons** (`ui-kit/icons/`). One family: 16px grid, 1.5px stroke, square caps, mitred joins, `currentColor`, no fills; the stroke
cannot be overridden. Drawn from Xleth's own vocabulary (cells, pattern blocks, syllable cuts, patch cables), never music notes
or slider caps: the 13 panels, the four timeline tools (select, draw, slice, delete), `sourceVideo`, `sourceAudio`, `media`. Panels
get them from `panelCatalog`, so the launcher, dock tab and panel tab always agree. Lucide stays for generic actions (close,
chevrons, plus, search, undo, zoom, more, play/stop). `windowing/__tests__/panelIcons.test.tsx` fails if the identity files
import a generic music, slider or tool glyph. The Gallery shows every glyph at 16, 24 and 48px.

## 12. Known gaps (deliberately out of scope for Phase 0)

- **Settings > Appearance, other shipped themes:** resolved in Phase 7 (3.6).
- **Bar lines below 3:1** in dark and light (about 2.3 and 2.0:1); high contrast meets it. Open.
- **Mid-brightness Appearance:** semantic colours (accent, solo, signals) are the ramp's fixed values and are
  not re-solved for an arbitrary brightness; only ink, ink-2, ink-3 and boundary are guaranteed there.
- **Narrow windows at high scale:** below about 683 CSS px (a window under 1366 px at 200 %) the Preview and
  the timeline toolbar still run out of room; only the top bar, the dock tabs and the hint bar are laid out for it.
- **Inline styles:** about 511 `style={{…}}` objects bypass tokens. Later phases.
- **`app.css`:** 23,858 lines after Phase 8 (34,380 at Phase 0), two `:root` blocks, four appended override
  passes still in place (they style surfaces that are still legacy). It shrinks only by deletion, ratcheted by
  the baseline file. See 13.4 for what remains.
- **Shots harness limits:** `npm run shots` (`tests/ui-render/shots.mjs`; `--label`, `--no-build`,
  `--compare A B`) runs without the engine
  (`window.xleth` absent) and covers chrome only. Anything needing live audio, video or the
  bridge must be checked in the real Electron app.

## 13. Cleanup and final verification (Phase 8)

### 13.1 Overlays: Dialog, Menu, Toast

`ui-kit/Dialog.tsx` and `ui-kit/Menu.tsx` are the two floating-surface primitives; both carry the hard offset
shadow and nothing else (no blur, no glow, no entry animation).

- **Dialog** (`Dialog`, `DialogText`, `DialogList`, `DialogListItem`): a modal. The title is 16px and **the body is
  16px / 1.5**: dialogs are read like prose, the one DAW Floor exception (controls inside keep their 12px kit sizes).
  Focus moves to the element marked `data-autofocus` (else the first control), is trapped while open and returns
  to where it was. Escape and a press on the backdrop close it, `dismissable={false}` for a dialog that must be
  answered or is running a task; Enter runs `onEnter` unless focus is on a button, link or field. The footer holds kit
  Buttons, default action last: `variant="primary"` is the inverted ink chip, `variant="danger"` outlines in the
  error text colour. The scrim is `--ui-scrim`, a flat dim.
- **Menu** (`Menu`, `MenuItem`, `MenuSeparator`, `MenuCustom`): 24px rows, 12px text, arrows / Home / End,
  Enter or Space selects, Escape closes and focus returns. A press inside any menu surface is never "outside",
  so a submenu is just a second `Menu`. A checkable row (`checked` defined) is `menuitemcheckbox` with a check
  glyph. `components/ContextMenu.jsx` keeps its item-array API on top of it (about a dozen callers);
  `timeline/TrackContextMenu.jsx` keeps its submenus.
- **Toast** (`components/Toast.jsx`, `Toast.module.css`): the one-line status text in the top bar, with a glyph per
  level so colour is not the only signal; errors are announced as alerts.
- Migrated in Phase 8: Unsaved changes, Clean up project, Convert track, Automation delete, Missing media,
  Missing plugins, Export as ZIP, every context menu, the toast. Gallery: `?view=ui-kit`, "Menu and Dialog".
- z-order: dialogs sit at `--xleth-z-modal` (9200), menus and popovers at `--xleth-z-popover` (10000), so a Select
  or a menu inside a dialog opens above it and the file-picker modal stays above both.

### 13.2 Removed

37 files (32 source, 5 tests), 10 stale Electron snapshots and 2,557 lines of `app.css` (335 dead rules, 50 unused or duplicate custom properties): `components/sampler.bak/`, `ResizablePanel`,
the grid `TrackCard`, `FadeBezierEditor`, the sampler `MiniKeyboard`, `TopBarToggles`,
`GraphNodeParameterInspector`, `XlethKnob`, `XlethPanelHeader`, `ModulationRack`, the retired EQ popup / panel /
inspector cluster, `DebugCapturePanel`, the Loop Lab overlay (`LoopLab*`, `loopLab.css`; the pure logic
`loopLabMeta.js`, `loopLabRater.js` and `electron-main/loopLabExport.js` stay, so it can be mounted again),
three unreferenced orphans, 335 dead CSS rules and 50 unused or duplicate custom properties. 56 per-interaction
debug logs went too; error and warning logs stay, as do the once-per-event `[Shell]` and `[Theme]` logs.
Kept on purpose: `mixer/NodeEditor.jsx` (still named by the quarantined `nodeEditor` panel in `panelCatalog.ts`,
with `nodeGraphStore.js`, `vendor-xyflow.css` and `@xyflow/react`).

### 13.3 Baselines

`npm run shots` (no engine) is the render check. The Electron suite (`tests/baseline/capture.spec.ts`) was rewritten
for the docked shell and its stale Phase 0 snapshots removed. **No new Electron snapshots are committed**: they need
the engine, and `xleth_native.node` was older than the latest engine and bridge commits when this phase ran. Capture
them with `npm run baseline` on a machine with a fresh addon (see `tests/baseline/MANUAL.md`).

### 13.4 What is still legacy

`app.css` still styles about 150 live components that have not moved to the kit; the four appended passes
(`Mockup-aligned DAW shell pass`, `Flat mockup parity pass`, `Flat menus and settings parity pass`, `Flat grid
track-card polish pass`) style those surfaces and are not superseded. Largest consumers by rule lines: the plugin-ui
runtime (about 860), Settings (about 620), Amp, Filter and Phanjer panels. (The sampler panel and its modulation cards,
once the largest, moved to the kit in round 2 step 11; see section 14.) Dialogs not yet on the kit: Export (RenderDialog), MIDI import and
the Settings panel (each 650 to 1,800 lines of its own layout). `ProgressBar` and the picker sheet's controls row
are legacy too. `UpdateBanner` is a stub that renders nothing.

### 13.5 Floor status after the populated-shell audit

Measured with the fake engine (16 tracks), every detail-dock tab, dark / light / high contrast, 1366x768,
1920x1080, 2560x1440 and 1920 at 150 %: no text under 10px; no text under 4.5:1 except deliberately dimmed states
(muted or bypassed content at the 45 % mute opacity, disabled controls). Open hit-area items (under 24px, canvas or
overlay controls): the track identity stripe button (6px wide), the clip FX badge (24x14), loop-region toggle,
snapshot cue markers, Pattern-list collapse. The Theme Editor (`theming/editor/ThemeEditor.tsx`) was unmounted from Phase 6c
until the end of Phase 8; it is mounted again in Settings > Appearance (section 3.6, `SettingsThemeEditor.test.jsx`).
It is still built on legacy `theme-editor-*` CSS in `app.css`, not the kit.

## 14. Sampler (round 2, step 11)

The per-region sampler every pattern track's notes play through (`components/sampler/`, opened in the detail dock by
**Sampler settings** in the Piano Roll). Built on the kit and `Sampler.module.css`; the legacy sampler and modulation-tray
CSS (about 2,600 lines of `app.css`) is gone. Engine calls, ranges, defaults and undo paths are unchanged: every drag
previews locally and commits once through `updateSamplerSettings` (one `SetSamplerSettingsCommand`).

**Layout** (one height for every view, so switching never resizes the panel and nothing animates):

```
┌ slot tabs (identity stripe, silent glyph) + │ Patch ▾ Save Delete │ Main · Playback · Modulation ┐ 28
├ waveform well: slot header (name · rate · length · Root · M S ⋯ · Snap · Zoom to trim · Fit) ┬ 240px ┤
│ overview + ms ruler + waveform (g0, slot colour)                                            │ Pitch  │
├ Mode │ Trim │ Loop (Auto · On) │ Amp envelope (= Env 1)                                       │ Prep   │
│                                                                                             │ Process│
└ Audition: held-key mark · keys · range · Key octave · Velocity ·                 Root ▶      ┘ 28
```

At the default dock (1080p: 361px frame) the Main body is 305px and nothing scrolls. Below about 1,230px of strip width the
Amp envelope folds to its title (it is Env 1, also in Modulation); at 1366x768 the right column scrolls inside itself.
**Playback** is Voice → Glide → Arpeggiator → Per-note effects (the selected slot's Mangle chain as 24px rows) plus a
stretch-details and Preview-through row. **Modulation** replaced the pull-out tray (its handle sat at the window edge, off
screen in the docked shell): routes on the left, a source strip (Env 1-6, LFO 1-6, Velocity, Note), and one editor.

**Labels.** `crossfadeEnabled` is the region's **One-shot / Sustained** switch (engine `setCrossfadeMode`), never shown as a
crossfade toggle; in One-shot the Loop strip says "Needs Sustained" because the engine only loops when it is on. Modulation
sources and targets read in sentence case ("Env 2", "Velocity", "Slot 1 mangle 2 amount"). Sample positions read as time
(ms, seconds past one second) with the exact sample count in the hint and type-in accepting `smp`; slot volume reads in dB
while the drag and the value sent stay linear gain 0..2. An off section (loop, arpeggiator) says "Off" in its header instead of
dimming, so its controls stay readable and editable.

**Colour.** Chrome is neutral. A slot's identity colour is `--theme-track-palette-N` for slot N (derived, not saved): its tab
stripe, the waveform, the overview trim. The loop band, loop handles and crossfade use `--ui-value`; handles and the playhead
are ink. The crossfade is drawn as the engine's equal-power curves (cos out, sin in over `[loopEnd − N, loopEnd]`, the source
band at `[loopStart, loopStart + N]`, the wrap point dashed). Fades are drawn as gain ramps. Modulation is one signal type:
every ring, band, editor curve and the drag ghost use `--ui-signal-parameter`; which source drives what is said in words
(route list, hint, the count on a source tab).

**Modulation on kit controls.** `Knob` and `NumberBox` take an optional `mod` (`ui-kit/modRing.ts`): the routed range as an
inner arc in the knob's own SVG or a 2px top band on the box; drag that mark or Alt+drag anywhere = amount (180 px per unit,
Shift fine, Escape cancels, one commit on release); right-click = bipolar; `data-mod-target` makes it a drop target. Absent
`mod` = the ordinary control. `components/sampler/kitMod.jsx` (`ModKnob`, `ModNumberBox`) binds a registration to it.
Every drag has a typed alternative: route depth is a NumberBox in the target's own unit, and **Add route** (source + target
Selects) makes a route without dragging. Holding a source drag over the Main or Playback tab for 400 ms opens that view.

**Auto loop** keeps its single result: `autoLoopForSelection` returns one loop, not a ranked list (the candidate list was Loop
Lab's, removed in Phase 8). The Auto button's hint carries the result fields the engine returns (periods, spans kept of
those considered, pitch drift, crossfade); telemetry (apply, 30 s nudge) is unchanged.

**Audit.** `tests/ui-audit/phases/p41-sampler-default-dock.mjs` shoots Main (31), Playback (32) and the four modulation
sources (36-39) at the default dock height and reports any vertical scroller; p40 still shoots 30 / 35, p200 shoots 203.

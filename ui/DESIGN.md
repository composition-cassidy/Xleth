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
  - The six component sheets (`windowing`, `clipControls`,
    `clipControlTuner`, `EffectModule.sidechain`, `designer`; `sandbox` was the seventh until round 2 step 20 deleted it) are wrapped
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
| `g0` | `#0F0F0F` | wells, ground: bodies that hold content | | | | |
| `g1` | `#1A1A1A` | panel: chrome behind controls | | | | |
| `g2` | `#262626` | header, title strip | | | | |
| `g3` | `#323232` | control | | | | |
| `g4` | `#444444` | divider, **decorative only** (1.79 on g1) | | | | |
| `boundary` | `#7C7C7C` | control outlines | 4.59 | **4.17** | **3.63** | **3.07** |
| `ink` | `#E6E6E6` | primary text | 15.36 | 13.94 | 12.13 | 10.27 |
| `ink-2` | `#B4B4B4` | secondary text | 9.24 | 8.39 | 7.30 | 6.18 |
| `ink-3` | `#9A9A9A` | **dimmest text allowed anywhere** | 6.81 | 6.19 | 5.38 | 4.56 |

**Round 3 widened the row.** Until then it was `#141414 / #1B1B1B / #222222 / #2B2B2B / #3A3A3A`: 23 luminance steps
from g0 to g3, so neighbouring panels differed by about 7 and the shell read as one flat sheet (three greys covered 66 %
of a 1080p screen). The row above spans 35. Because g3 rose, everything that must clear a floor on it rose with it:
`ink-3` from `#929292` (4.12 on the new g3) and `boundary` from `#747474` (2.74), and `rec-text` (3.2). No hue was added.

**Surface roles, applied the same way everywhere.** **g0** is any body that holds content: arrangement lanes, mixer
strip bodies and the empty lane beside them, the Browser's list, the Patterns list, the Devices chain, display wells, the
Preview surround. **g1** is panel chrome behind controls: the Inspector, device frames, the Master dock, the detail dock
body. **g2** is a header or a title strip: the top bar, tab rows, strip heads, track header rows, toolbars. **g3** is a
control. A slot that sits on a g0 body (a strip's meter) is drawn one step up, g1, so it does not disappear. Regions are
told apart by fill first; a `g4` divider is the second signal, never the only one.

**Adjustment from the original brief:** `boundary` was `#6B6B6B` (3.23 on g1 but 2.99 on g2
and 2.66 on g3, below the 3:1 non-text floor on headers and control fills). `#707070` was
tried and still fails on g3 (2.86). `#747474` clears 3:1 on g0–g3 (table above); the unit test
asserts `boundary >= 3:1` on g1, g2 and g3. (Round 3: `#7C7C7C` on the wider ramp, same floor.)

Nothing dimmer than `ink-3` is permitted for text. "Disabled" is expressed with the 45% dim
plus a glyph/state, not a darker text colour.

### 3.2 Semantic colours (colour has jobs)

| Token | Value | Job | Notes |
|---|---|---|---|
| `--ui-value` | `--theme-accent` (`#33CED6` default; 9.07:1 on g1) | value fills, active displays | user-themeable |
| `--ui-on` | inverted chip: `ink` background, `g1` text | toggles that are on and that you watch: M / S / V, the active tool, loop armed, a device activator | deliberately not yellow/orange/lime |
| quiet on (`tone="quiet"`) | `g3` fill, `boundary` outline, `ink` glyph | housekeeping toggles that are on nearly all the time: the four region toggles, the tempo lock | off is the borderless ghost, so the state is outline plus fill, never colour |
| `--ui-select` | 1px `--ui-value` outline | selection | outline, never fill-only |
| `--ui-rec` | `#E5484D` | record/arm **fills and glyphs only** | 4.45:1 on g1, so **never as text** |
| `--ui-rec-text` | `#F67073` | record/arm **text** | 6.20 g1, 4.57 g3 (round 3: lightened from `#F06A6E`, 4.27 on the new g3; same OKLCH hue and chroma) |
| `--ui-solo` | `#E8B53A` | solo | 9.20:1 on g1 |
| `--ui-clip` | `--theme-danger` | clipping / error | |
| mute | content at 45% **plus** a mute glyph | never colour alone | |

State is visible at rest, never hover-only. Muted content dims, not just its button.

**Quiet on (round 3).** The inverted chip is the brightest thing in the chrome, and that is its job: it marks state you
look for. Four region toggles and the tempo lock are on almost all the time, so as chips they made housekeeping the
loudest part of the top bar. They use the kit's quiet on-state instead (`IconButton` and `Toggle` take `tone="quiet"`;
`ui-kit/Button.module.css`): a raised g3 control with its 3:1 `boundary` outline and an ink glyph. g3 on the bar's g2 is
only 1.2:1, so the outline carries the state and the fill supports it; the lock also swaps its glyph. Nothing else may
use it: a toggle whose on-state is news keeps the chip.

### 3.3 Signal-type hues

Four hues for cables, ports and meters by signal type (audio, events, parameter, video). Each
is at least 30° (OKLCH) from the accent and from every state hue, and at least 30° from each
other. OKLCH hues of the state colours: **accent 200°, rec 23°, danger 21°, solo 85°.**
(These differ from their HSL hues; all exclusion maths in this repo is OKLCH.)

| Signal | OKLCH | Hex | on g1 | on g3 |
|---|---|---|---|---|
| audio | L.72 C.12 H255 | `#6FA7EE` | 6.99 | 5.15 |
| events | L.72 C.12 H150 | `#69BA7C` | 7.39 | 5.44 |
| parameter | L.72 C.12 H295 | `#AA95E8` | 6.77 | 4.99 |
| video | L.72 C.12 H330 | `#CF88C8` | 6.64 | 4.89 |

### 3.3.1 Band palette (multiband devices)

Four fixed hues, low to high, for every multiband device (`--ui-band-1..4`, catalog subsystem *ui-band*,
`neutralRamp.ts` per ramp). The hue rises with frequency. Each is at least 30° (OKLCH) from the accent and every
state hue and from each other, and reaches 4.5:1 on g0 to g3 (7:1 in high contrast); `themes.test.ts` asserts both
in every shipped theme. A band's hue is reused on that band's own controls by setting `--ui-value` on their
container, so a knob's arc wears it. The selected segment of a band selector stays the inverted ink chip; the band
is a swatch glyph, filled while the band runs and hollow while it is muted or off.

| Token | Band | OKLCH (dark) | Dark | Light | High contrast |
|---|---|---|---|---|---|
| `--ui-band-1` | low | L.75 C.13 H54 | `#ED9659` | `#964A00` | `#F1995D` |
| `--ui-band-2` | low-mid | L.80 C.13 H118 | `#B6C963` | `#596504` | `#B6C963` |
| `--ui-band-3` | high-mid | L.72 C.11 H232 | `#53B0DE` | `#0A668A` | `#5BB8E6` |
| `--ui-band-4` | high | L.74 C.12 H312 | `#C494E2` | `#7A4D94` | `#CC9CEA` |

- **Three-band devices** (APEX, Overdone) use slots 1, 2 and 4, so "High" is always the top hue
  (`components/devices/bandPalette.js`). APEX's Master is not a band and keeps `--ui-value`.
- **Signal hues are not excluded.** The circle has no fourth slot 30° from all seven existing hues: high-mid sits
  23° from audio and high 17° from parameter. Bands appear only inside device bodies, signal hues only on cables,
  ports and the FX Graph, so the two never share a surface.
- Canvases resolve the token from their own element at draw time (`readBandColor`), never at module scope.

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
| `--theme-bg-primary`, `--theme-bg-inset` | `#0A0A0F`, `#0D0D14` | `#0F0F0F` (g0) |
| `--theme-bg-surface` | `#1A1A24` | `#1A1A1A` (g1) |
| `--theme-bg-secondary` / `-tertiary` / `-hover` / `-active` / `-elevated` | tinted, derived | grey, derived: `#171717` / `#1B1B1B` / `#242424` / `#2E2E2E` / `#242424` |
| `--theme-text` | `#E8E8ED` | `#E6E6E6` (ink) |
| `--theme-text-muted` | `#8888A0` (derived) | `var(--theme-ui-ink-2)` `#B4B4B4` |
| `--theme-border-subtle` | `#2A2A38` (derived) | `var(--theme-ui-g4)` `#444444` |
| `--theme-text-on-accent` | `#0D0D14` | `#0F0F0F` |
| `--xleth-flat-text-muted` (`app.css`) | `var(--theme-text-subtle)` (2.4:1) | `var(--ui-ink-3)` (6.19:1) |

The legacy three-tier text ladder therefore reads ink (13.9) > ink-2 (8.4) > ink-3 (6.2). (The "Now" column is the
round 3 ramp; the Phase 0 values were `#141414`, `#1B1B1B` and the derived greys that followed from them.)
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
| dark (Default) | `#0F0F0F` | `#1A1A1A` | `#262626` | `#323232` | `#444444` | `#7C7C7C` | `#E6E6E6` | `#B4B4B4` | `#9A9A9A` | `#33CED6` |
| light | `#DCDCDC` | `#E9E9E9` | `#F0F0F0` | `#F7F7F7` | `#C4C4C4` | `#6E6E6E` | `#1A1A1A` | `#444444` | `#5C5C5C` | `#006C71` |
| high contrast | `#000000` | `#0A0A0A` | `#141414` | `#1F1F1F` | `#595959` | `#D0D0D0` | `#FFFFFF` | `#E0E0E0` | `#C8C8C8` | `#33CED6` |

On g1: dark ink 13.9 / ink-2 8.4 / ink-3 6.2 / boundary 4.2; light 14.3 / 8.0 / 5.5 / 4.2; high
contrast 19.8 / 15.0 / 11.8 / 12.8. Light's ground (g0) is its *darkest* step and controls are raised
toward white; g4 is a decorative divider in dark and light, and a visible one (2.4:1) in high contrast.
Semantic and signal colours keep the dark ramp's OKLCH hue and chroma and only move in lightness (light:
darker; high contrast: brighter), so the hue-exclusion rules of 3.3 and 3.4 hold in every theme. High
contrast also strengthens the grid: timeline and piano-roll bar / beat / step lines are 65 / 40 / 22 %
white over g0 (7.4 / 3.7 / 1.8:1), asserted by test. Since round 3 the bar line clears the 3:1 Floor in dark and light
as well: 34 % white over g0 in dark (`#616161`, 3.10:1; it was 26 %, 2.3:1) and 44 % black over g0 in light (3.09:1; it
was 28 %, 2.0:1), for the timeline and the piano roll alike. Beat and step lines are unchanged, so the bar tier now
stands clear of them. `themes.test.ts` asserts bar >= 3:1 and bar > beat > step in all five themes.

**The light row was not widened in round 3.** Its 13 semantic colours are solved to sit at about 4.5:1 on its ground
(`#DCDCDC`); a darker ground puts every one of them, and ink-3, under the floor. Its only free direction is g3 toward
white, three steps. High contrast is unchanged.

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
`#6B98FA` (round 3: lightened again from `#6490F2`, 4.16:1 on the wider ramp's g3; 4.58 now). Surfaces and ink are identical to Default
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
  `main.jsx`; `--ui-font-mono`). The top bar's time and bars.beats readouts are `--type-16` (round 3):
  where you are in the song is the one readout in the bar worth reading from across the desk. It is the only
  use of 16 outside a panel or dialog title. Legacy `app.css` already referenced the face, so timecode
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
| dB of gain (a level you set: faders, volume fields, a peak readout) | 1 decimal, **explicit plus** on a positive value, never on zero | `+3.0 dB`, `0.0 dB`, `−12.9 dB` |
| Hz | below 1 k: 0 decimals; from 1 k: kHz, 2 decimals | `455 Hz`, `5.49 kHz` |
| ms | below 100: 1 decimal; else 0 | `12.5 ms`, `250 ms` |
| % | 0 decimals | `70 %` |
| ratio | 1 decimal, spaced colon; infinite is `inf` | `4.0 : 1`, `inf : 1` |

Legacy inconsistencies (`db`, `dB`, `0dB`, mixed minus signs) are fixed per component as each
phase rebuilds it, through `formatValue`, never by regex.

The plus is `formatValue`'s `signed` option, passed by the control that shows a gain (`formatOptions={{ signed: true }}`;
the mixer's is `GAIN_FORMAT` in `mixer/mixerMath.js`), not a global rule: a threshold or a ceiling is a position on a
scale, not a gain, and stays unsigned. A column of levels then reads `+7.1 dB` beside `−12.9 dB`, not `7.1 dB`.

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

## 8. Layout contract

**Compose** is the default since round 3 (`windowing/presets/xleth-compose.json`): the arrangement owns the centre column.

```
┌ Menus │ transport · time · BAR.BEAT · BPM │ panel toggles │ win ┐ 36
├ Preview 304 │ Arrangement: toolbar 32, ruler 26, cue lane 24   ┤
│ (28 + 16:9) │ then lanes, full width of the column             │ rest
├─────────────┤                                    ┌ Inspector  ┤
│ Browser     │                                    │ 280, only  │
│ (the rest)  ├────────────────────────────────────┤ when asked │
│             │ Detail dock: Devices │ Mixer │ Piano Roll │ ... │ 28 collapsed
└ Hint bar: hovered control + its modifiers                     ┘ 22
```

**Tiled (preview row)** is the round 1 and 2 layout (`xleth-arrange.json`), still in View > Layouts:

```
┌ Menus │ transport · time · BAR.BEAT · BPM │ panel toggles │ win ┐ 36
├ Browser │ Preview (16:9)            │ Inspector              ┤ ~240 @1080p
│ (full   ├───────────────────────────┴────────────────────────┤
│ height) │ Arrangement — full width, one ruler, video+audio   │ rest
├ Detail dock: Devices │ Mixer │ Piano Roll │ Sampler │ FX Graph ┤ 28 collapsed
└ Hint bar: hovered control + its modifiers                     ┘ 22
```

**Why Compose.** In Tiled the top row cost 200px or more of every window, 76 % of it letterbox beside a 304px picture,
with an Inspector that holds one sentence at rest; the arrangement showed 8 rows at 1080p. Compose puts the same
304px picture at the top of the Browser's column and gives the row to the lanes: 14 rows.

- **Presets** (`managers/PresetManager.ts`): `xleth-compose` "Compose (default)", `xleth-arrange` "Tiled (preview row)",
  `fl-compose` "Floating mixer", `vegas-arrange` "Floating preview". `DEFAULT_PRESET_ID` is what a fresh profile, a failed
  layout hydration, a pre-tiled saved layout and Reset layout land on. A layout saved in the tiled shell is merged as
  it is and never rewritten: a profile that holds the old default keeps it until its user picks Compose once.
- **The Inspector** is hidden in Compose and docked `right` (280) when its region toggle opens it; it then runs the full
  height of the work area beside the centre column.
- **Return to dock** (a popped-out panel's title bar) goes back to the region the panel was last docked in (undocking
  keeps `docked.region`), and to the catalog's `dockHome` only when it never sat on an edge. So a Compose Preview returns
  to the left column, not to a new top row.

### 8.1 Sharing the centre column (round 2)

The centre column (top row, arrangement, detail dock) is split by one pure function,
`windowing/layout/shellLayout.ts` (`computeShellLayout`, driven by `useShellLayout` from the column's measured
height A). Regions render the result; the stored sizes are still what a drag commits to.

- **Detail dock, open:** `clamp(320, 40% of A, 520)` until the user resizes it. A stored value of 304 (the old
  default every earlier layout holds) means "never resized". A dragged size is kept and persisted.
- **Top row (Preview + Inspector), when the layout has one:** minimum **200px**, never squeezed. An untouched row (stored
  340) leaves the arrangement 8 rows; a row the user resized may take space down to the arrangement's 4-row minimum.
  With nothing docked in the top region (Compose) there is no row: `topMode` is `'none'` and the arrangement is the
  column minus the dock.
- **Arrangement:** minimum 4 rows = **83px** chrome (toolbar 32, ruler 26, cue lane 24, 1px of borders) + 4 x 36px. It
  was 95 (38 / 26 / 30) until round 3: 32 is the tallest control height, 24 the hit-area floor, and the cue lane's pin
  and grips keep 24x24 hit areas inside it.
- **Not all three fit** (A - dock < 200 + 227): the top row folds to a **28px strip** with Preview and Inspector
  buttons. They open the row as a 200px **sheet** over the arrangement (hard offset shadow; Esc, a press outside, or
  the button again closes it). Folded panels stay mounted but report themselves not visible (no decoding).
  The dock yields only if the arrangement would drop under 4 rows.

| Layout | Window | A | Dock | Top row | Arrangement | Left column |
|---|---|---|---|---|---|---|
| Compose | 1920x1080 | 1022 | 409 | none | 613 (**14 rows**) | 304: Preview 199 (28 + 171), Browser 823 |
| Compose | 1366x768 | 710 | 320 | none | 390 (**8 rows**) | 304: Preview 199, Browser 511 |
| Tiled | 1920x1080 | 1022 | 409 | 242 | 371 (8 rows) | 258: Browser 1022 |
| Tiled | 1366x768 | 710 | 320 | 28 strip | 362 (7 rows) | 258: Browser 710 |

Rows are whole 36px lanes after the 83px chrome. Measured in the render harness with 16 tracks and the Mixer open:
14 and 8 lanes fully visible in Compose (7 and 6 in Tiled before round 3); the lane viewport is 511px and 288px because
the horizontal scrollbar takes 19. In a 1032px-high window (1080p with a taskbar) Compose shows 13.

**Stacked side region (Compose).** The Browser is a drawer in its own column beside the work area, not a member of the
`left` dock region, so a panel docked `left` used to open a second column next to it. Now the edge region on the
Browser's own side **lives in the Browser's column, above the drawer** (`AppShell` passes it to `SampleSelectorDrawer` as
`stackedRegion`; `DockRegion` takes `stacked`). The column is that region, then the drawer taking the rest.

- Both parts are sized by the one stored number they always shared, `dockRegionSizes.left`, so either part's resizer
  drags the same edge and no stored key changed meaning.
- A stacked region is as tall as its panels and never fills: the **Preview is its 28px header plus a 16:9 picture at
  the column's width** (304 gives 302x169 inside the 1px borders, no letterbox at 16:9; another aspect letterboxes inside
  that box). Any other panel docked there keeps its stored size. The region is capped at 60 % of the column.
- While the column holds a stacked panel, collapsing the Browser cannot collapse the column: the Browser folds to a
  **28px row** under the region (expand control and its two tab icons) instead of a 28px-wide rail.
- The stacked region sits outside the drawer's visibility scope, so a collapsed Browser never stops the Preview, and it
  is not hidden by the shell (only `top` and `center` fold), so the Preview reports visible. Hiding the Preview from its
  toggle removes the region and the column is the Browser alone again.
- Only `left` and `right` stack. A Browser docked top or bottom is a strip of cards and the side region is its own
  column, as before. Nothing else about regions, slots, splitters or presets changed.

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
always full-fidelity. Below 720px the chips keep only their glyph; below 600px Edit grid and Import do too; below 360px
(the Compose column) View keeps only its chevron and the frame number reads `f 231`, so the row fits 304px unclipped.

**Top bar panel controls** (`components/TitleBarRegions.jsx`). Four region toggles (Browser, Preview, Inspector, Detail
dock) and one **Tools** menu (Sample Sandbox F10, Quick Notation, Split Syllables, then the user's own launchers from
Settings > Launchers), all kit controls with a `data-hint` that names the shortcut. The region toggles and the tempo lock
use the quiet on-state (3.2), not the inverted chip: they are on nearly all the time. The launchers that duplicated detail
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

Every stock effect now has a device body (`DEVICE_BODIES`, 25 of 25). A chain entry that is not a stock
effect (a third-party plugin, a missing or crashed one, one still being added) shows the same frame with a short
status and, for a live plugin, an Open editor button for its own native window. No fake content.

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

The Mixer tab of the detail dock: a fixed **gutter** at the left, identical strips scrolling in the
middle, a fixed Master + loudness dock at the right. There is **no inspector column**: a track's
detail lives in the Inspector and the Devices tab (an insert row opens Devices on that device).
Components: `components/mixer/` (`MixerPanel` with `MixerGutter`, `MixerStrip`, `MasterStrip`,
`InsertList`, `RoutingBand`) and `components/MasterLoudnessMeter.jsx`.

**Round 3 rebuilt the strip around two rules: show the content, and say shared things once.** A strip used
to carry an "FX 5" button, the words Pan and Width, a 0 to −60 numeral scale and an empty clip box, on every
strip, and drew its level three times (number, fill bar, fader). Now:

**Strip** (**72 px compact, the default**; 84 px normal; renderer-only UI state, and a stored choice is
kept), one eight-row grid, top to bottom:

1. **Head** (g2): the 3 px identity stripe (the same colour as lane, device and layer), the **number on
   its own row above the name**, so a 10-character name is whole at 72 px (11 px, weight 500).
2. **Insert names** (`InsertList`): 16 px rows naming the chain's devices in signal order, through the
   device title bar's own name map (`deviceName`). **How many rows is one number for the whole mixer: the
   longest chain on any strip or the Master** (`insertRowsFor`), never less than one, never more than ten or
   than fits above a 64 px fader. So the insert area is no taller than the project needs, every fader is the
   same length, and adding a sixth effect to one track grows the list and shortens every fader together. A
   chain longer than the rows that fit keeps all but the last and ends in **"+N more"**;
   a track whose effects live in its FX Graph says "FX graph"; a bypassed insert is dimmer **and** struck
   through; rows past the end are empty slots (g1 on the strip's g0). The list is **one control**, a listbox
   far over the 24 px hit floor: the row under the pointer, or the arrow-key row, is the device it opens in
   the Devices tab (`deviceRevealStore`: the chain scrolls to it and outlines it until the next press there);
   an empty row opens the chain. Sixteen-pixel rows that were each their own button would break the Floor.
3. **M / S / V** Toggles at rest, three 24 px cells.
4. **Pan** (bipolar) and **Width** Knobs with their values printed under them and **no word above**: the
   words are in the gutter. Each keeps its accessible name, `aria-valuetext` and hint.
5. **Volume** NumberBox, signed (section 6), **without the value-fill rule**: the fader below is the slider.
6. **Fader + Meter**: the meter draws **ticks only** and its **clip latch only once latched** (its space is
   kept, so the bars never move); peak hold as before.
7. Routing cable row. 8. Output Select.

Compact is 72, not the 68 it used to be: three 24 px toggles need 72. A dock too short for three rows above
a 64 px fader shows at most three and lets the fader go down to 48 px, so a 320 px dock at 1366x768 still does
not scroll vertically. At the 409 px dock of a 1080p window the list can reach seven rows.

The kit Meter's canvas has `height: 0` and grows by flex: a canvas's natural height is its backing store (the
height it was last painted at), which would otherwise stop a fader row from shrinking again once it had been
tall.

**Muted** dims every row but the head and the M/S/V row (`--ui-mute-opacity`) and shows a mute glyph;
**selected** is a 1px `--ui-select` outline **plus the head one ramp step lighter** (g3). M/S/V are real
engine state; **there is no arm** (the engine has no record-arm) and **no sends** (`TrackInfo.sends` is
reserved and always empty), so neither is drawn.

**Gutter** (`MixerGutter`, 40 px, fixed left of the scroller): the meters' **dB numerals, printed once**
(kit `MeterScale`), the words **Pan** and **Width** beside the knob row (left and right, like the knobs),
and the strip-width switch. The gutter, every strip and the Master are equal-height columns on the same row
grid, and `MeterScale` has a meter's own box, so each numeral sits at the y of the strips' ticks at any dock
height. Which marks a height shows is one function (`visibleScaleMarks`: a mark at least 12 px under the one
before it), shared by a meter's numerals, a meter's bare ticks and the scale. The scroller's bar is always
present (`overflow-x: scroll`) and its height is **measured**, not assumed: the fixed columns leave exactly
that much at the bottom.

**Master** is the same grid: head, its own insert list, then a **peak readout** in the two rows a track
gives to M/S/V and pan + width (the highest master level since the last reset, from the same meter bus, "—"
until a level arrives, "Over" in words above 0 dB, click to reset), volume, fader and a meter **with
numerals** (the gutter is at the far left of a long mixer). Same tick set at the same y as every strip.

**Meters.** The mixer's one existing 125 ms `getAllPeaks` poll writes `peaksSnapshot` and then
fans levels out through `mixerMeterBus` to the kit Meters (dB, own rAF ballistics, asleep at
rest). No timer was added and nothing is a DOM segment. **A level meter is drawn in the audio signal hue**
(`--ui-signal-audio`, section 3.3: Meter `tone="audio"`), the same hue as the routing cables under it, so
"audio" is one colour from the meter to the cable; clipping is still `--ui-clip`. A meter that shows a value
rather than a signal's level (gain reduction in the compressors) keeps `--ui-value`. A strip's meter slot is
g1 (`well="panel"`) because the strip body is g0.

**Insert names and the chain cache.** Names are read from `useEffectChainStore.chains[key]`. Each strip fills
its own entry when it mounts (it used to be filled only for the selected track, so every other strip read
"No FX"); edits made through the store keep it current, and `MixerPanel` refetches every strip's chain when
a project loads. It is not refreshed by a chain change the renderer did not make (an undo of a chain load
while the Mixer stays mounted): open.

**Routing.** `RoutingBand` is one canvas over each strip's cable row, drawn from the store's own
`outputRoutes` and `sidechainRoutes` (`routingCables.js` is the pure geometry): a dot in the
track's identity colour, a run to the Master rail (arrow into the dock) or a lane to the bus it
feeds, and sidechain cables thinner, dashed and lower contrast, all in `--ui-signal-audio`.
Disabled, stale or dangling routes are not drawn. The canvas redraws on change only and takes no
pointer events; the Output Selects are the controls.

**Loudness dock.** While metering is off it is a **28 px rail** (the folded-device width: "Loudness",
"Off", an open control) unless the user opened it; the choice is kept (`xleth.mixer.loudnessDockOpen`,
renderer-only). While metering is on it is always open. Open and off, or nothing measured: every value is
"—" with its unit and no bars are drawn. Values go through `formatValue`; a true peak over the ceiling is flagged "Over" in words.
The target is a labelled Select (platform targets, `none` omitted because the meter reads it as
unset) writing the `xleth.export.loudnessTarget` key the export dialog shares.

**Gallery.** `?view=ui-kit` shows 16 strips with mixed states from `MixerGalleryFixture` (MOCK
data, gallery only; a test fails if anything else imports it): the gutter, named inserts (one bypassed, one
chain with "+3 more", one FX graph), the Master's inserts and peak readout, at 72 and at 84 px.

**Measured** in the render harness (fake engine, 24 tracks, 1920x1080, Compose, dock at its auto height):
20 strips fully visible beside the Master (17 before round 3, at 84 px), no clipped name among ten-character
names, the M/S/V cells 24 px wide, strip, Master and gutter meters at the same y and height.

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
- **Bar lines below 3:1:** closed in round 3 (3.6): 3.10:1 in dark, 3.09:1 in light, asserted per theme.
- **Ramp copies outside the token system.** `welcome.html` and `splash.html` carry a frozen copy of the dark ramp
  (section 23) and were not re-synced when round 3 widened it: g0 `#0F0F0F`, g1 `#1A1A1A`, g2 `#262626`, g3 `#323232`,
  g4 `#444444`, boundary `#7C7C7C`, ink-3 `#9A9A9A`, danger text `#F67073`. `main.js` (`backgroundColor`) was.
- **Canvas colour fallbacks.** About 25 canvas modules keep a literal fallback for a token read that returns nothing
  (before `ThemeProvider` mounts). They still hold the old ramp values; they are never seen once a theme is applied.
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
runtime (about 860), Settings (about 620) and the Phanjer panel (Amp and Filter moved to devices in step 15). (The sampler panel and its modulation cards,
once the largest, moved to the kit in round 2 step 11; see section 14.) Export, MIDI import, the file picker, Settings, the Sample Sandbox, Quick
Notation and Split Syllables moved to the kit in round 2 step 20 (section 23). The picker sheet's controls row is
legacy. `UpdateBanner` is a stub that renders nothing.

### 13.5 Floor status after the populated-shell audit

Measured with the fake engine (16 tracks), every detail-dock tab, dark / light / high contrast, 1366x768,
1920x1080, 2560x1440 and 1920 at 150 %: no text under 10px; no text under 4.5:1 except deliberately dimmed states
(muted or bypassed content at the 45 % mute opacity, disabled controls). Open hit-area items (under 24px, canvas or
overlay controls): the track identity stripe button (6px wide), the clip FX badge (24x14), loop-region toggle,
snapshot cue markers, Pattern-list collapse. The Theme Editor (`theming/editor/ThemeEditor.tsx`) was unmounted from Phase 6c
until the end of Phase 8; it is mounted again in Settings > Appearance (section 3.6, `SettingsThemeEditor.test.jsx`).
It moved onto the kit in round 2 step 20 (section 23).

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

**The tab never dead-ends (round 3).** Opened with no region handed to it (`openPanel('sampler')` with no props: the
dock tab clicked cold), the Sampler shows **the open pattern's sampler, else the last open pattern's, else the first
pattern's that plays a sample** (`fallbackSamplerRegionId`). A region handed over by whoever opened it (Sampler settings,
a sample's own menu) still wins. Derived from renderer state; no engine call decides it. The empty state is left for a
project where no pattern plays a sample.

**Audit.** `tests/ui-audit/phases/p41-sampler-default-dock.mjs` shoots Main (31), Playback (32) and the four modulation
sources (36-39) at the default dock height and reports any vertical scroller; p40 still shoots 30 / 35, p200 shoots 203.

## 15. Piano Roll (round 2, step 12)

FL editing grammar inside fixed regions (`components/pianoRoll/`, `PianoRoll.module.css`). Engine calls, note data and
quantize logic are unchanged; every drag previews locally and commits once on release.

**Regions.** One CSS grid: keys (56px) | grid | vertical scrollbar; rows ruler 24 | grid | horizontal scrollbar + wheel-to-zoom
strip 24 | splitter 4 | event lane (48 to 240px, default 80, persisted per machine as `xleth.pianoRoll.laneHeight`; drag,
arrows, double-click resets). Canvases are sized from the measured grid cell, never by subtracting chrome constants (that
subtraction was the old 40px dead band). Past the pattern end the grid and the ruler are flat ground with half-strength bar
lines and a 1px ink-2 end line.

**Canvas only.** Keys, ruler, grid, notes, ghosts and the lane are canvases (the keyboard used to be 120 inline-styled divs).
`pianoRollGeometry.js` holds the shared pure maths (`rowY`, `pitchAtY`, `visibleRows`, `gridTiers`, `rulerMarks`);
`pianoRollPalette.js` reads every canvas colour from tokens at draw time.

**Grid and keys.** Bars, beats and 16th steps are three line tiers; a tier is drawn only when its lines are at least 6px apart.
Black-key rows are the darker ground. With a scale set, in-scale rows are lifted toward ink (7 %), so the black-key shading
stays visible underneath. Keys are neutral (white keys ink-2, black keys g1 at 62 % width), every C and the hovered key are
labelled, and a pitch that has notes gets a value-colour tick in the 3px gutter at the key's edge.

**Notes.** Colour is the **owning track's identity colour** (the track of the pattern's first block; the value colour when
the pattern is not placed). It is not a sampler slot: every note plays every sounding slot at once (`Sampler.h`), so there is
no per-note slot to colour by. Velocity is fill opacity (0.3 to 1). Selection is a 1px `--ui-select` outline plus a brighter
fill. Labels are 10/11px, printed only when they fit, with the ink solved against the composited fill (ink or g1, falling
back to white or black near mid lightness, so always at least 4.5:1). Slide notes keep their colour and carry a ramp glyph at
the right end. **Pitch / Sample view:** Pitch prints note names; Sample prints the transposition the sampler applies to the
reference slot, `(pitch − root) + slot tuning`, as `Root`, `+7`, `−12`. The reference slot is the title's slot Select, shown
only when the region has several slots; it changes labels only.

**Ghost notes.** Notes of other patterns placed over this pattern's first block (read-only `getTracks`, `getPatternBlocks`,
`getPattern`, refetched on the timeline's change events, never during a drag): solid g4 blocks when they play the same
sample region, boundary outlines when they play another. Never hit-tested. Toggle: Ghosts.

**Event lane.** Lollipops in the identity colour: 1px stem, round head, a short tail on each head when notes share a start
tick; selected heads get a `--ui-select` ring; the dragged value is printed in 1..127. The drag reads values on the scale it
draws. The only target is Velocity (slide shape is two values and has no 1-D lane).

**Toolbar.** Pattern Select (its list holds New pattern and Rename pattern…; renaming no longer lives on a double-clicked
title), Sample region Select, reference-slot Select, Sampler settings; tools Select S, Pencil P, Split C, Delete D (kit
IconButtons, Xleth tool glyphs, hints naming the shortcut and the mouse grammar); Slide; Length; **Snap** (1/32 to Bar,
default 1/16, which is what the editor always used; Alt and Ctrl keep their meaning); Scale; Pitch / Sample; Ghosts; zoom;
Quick Notation; detach and close. Below 1240px of dock width the Length and Snap captions drop out (the Selects keep their
names and hints). The piano roll's own floating title bar is gone: the window frame's title bar returns it to the dock.

**Mouse grammar.** Unchanged except **middle-drag pans** both axes (approved at the step 12 checkpoint). Right-click deletes
one note with any tool; there is no right-drag sweep (no batch remove exists, so it would make one undo entry per note).

**No pattern.** `getPattern` is only called for a non-negative integer id still in the pattern list; otherwise the panel
shows the kit EmptyState ("Select a pattern: …", New pattern).

**The tab never dead-ends (round 3).** Shown with no pattern open, or with one that no longer exists, the Piano Roll
opens **the pattern last open in it this session, else the first** (`windowing/panels/dockTabFallback.ts`,
`PianoRollPanel`). A pattern's notes are only edited here, so the last one open is the most recently edited one. It sets
the id in the renderer store and nothing else: no `open-piano-roll` event, so no dock tab is switched and no focus
moves; and it does nothing while the panel is hidden, so closing the Piano Roll still closes it. The empty state is left
for a project with no patterns, and says so ("This project has no patterns yet").

**Audit.** `p30-pianoroll` shoots 20 to 23 and 24 (Sample view); p01 shoots 04 (no pattern open), p200 shoots 201.

## 16. Character compressors and GLOSS (round 2, step 13)

Glue comp, Opto comp, FET comp and Vari-mu comp share `CompressorCore` in the engine, so they are **one device body**:
`components/devices/CompressorFamilyDevice.jsx`, driven by a model config (`compressorFamilyModels.js`) whose ranges,
defaults and index orders mirror each effect's `createLayout()`. A test pins the config to those tables. Registered as
`glue`, `opto`, `fet`, `varimu` in `DEVICE_BODIES`; their `*CompPanel.jsx` files are thin `FloatingDevice` wrappers.

**Hero.** A gain-reduction well (`DisplayWell`, kit `Meter` with `direction="down"`, a numeric dB readout under it). The
engine feeds these four effects one meter slot (gain reduction, dB, slot 2) and no history, so **there is no trace**;
Compressor's `compressor.combined` and Limiter's `limiter.gainReductionHistory` are the only history feeds. Vari-mu in
Mid-side reads slots 4 and 5 (`VARIMU_GR_MID`, `VARIMU_GR_SIDE` in `constants/meterSlots.js`) and draws two bars with a
Mid and a Side readout.

**Sections in signal order:** Input, Character, Time, then Sidechain (Glue only) and Output. Opto has no Time section:
attack, release and ratio are properties of its cell, not controls. The model's **character switch is the hero** (Glue
ratio, Opto Compress / Limit, FET ratio, Vari-mu time constant): a large `SegmentedControl` in the widest section. Knobs
stay at normal sizes.

| Model | Input | Character | Time | Output | Width |
|---|---|---|---|---|---|
| Glue comp | Threshold | Ratio (hero), Topology, Color | Attack, Release steps | Makeup; Sidechain: high-pass, Freq | 778 |
| Opto comp | Peak reduction | Mode: Compress / Limit (hero) | none | Gain | 438 |
| FET comp | Input (no threshold) | Ratio 4 / 8 / 12 / 20 / All (hero) | Attack, Release knobs 1 to 7 | Output | 618 |
| Vari-mu comp | Input (no threshold) | Mode: Linked / Mid-side | Time constant 1 to 6 (hero) | Output | 662 |

- **Stepped values** are kit `SegmentedControl`s that commit once per click. FET's attack and release are *continuous*
  knobs numbered as on the unit (1 slow to 7 fast); the time each number means prints under the knob.
- **Durations.** `format.ts` has no µs or s unit, so captions and the Vari-mu attack / release readout go through
  `formatDuration` (µs below 0.1 ms, ms below 1 s, else s) with the same number rules as `formatValue`.
- **Writes** are the legacy panels': `useDeviceParams` previews locally with one engine write per frame and commits once on
  release. No undo exists for stock-effect parameters (section 9); the devices keep that.
- **Automation.** The legacy knobs offered right-click "Create automation clip", the automated read-only state and the
  base-value write. `AutomatableKnob` keeps all three for these bodies (the same `useKnobAutomation` hook, the same
  `paramId` + target opt-in); the kit `Knob` only gained an `onContextMenu` pass-through. The other seven devices do not
  have it yet.

**GLOSS** (`GlossDevice.jsx`): Amount (the engine's band mix, 0 to 100 %, default 0) as the one oversized knob; banks A to D
as a `SegmentedControl` that loads the factory APEX presets exactly as the legacy panel did (Amount untouched, the lit
letter sticky per instance, derived from the engine state when there is no memory). No gain-reduction readout: the legacy
panel never had one. GLOSS shares the APEX store (the target's `skin` picks the editor) and registers
`presetType: 'apex'`, so the title bar's presets and A/B use the APEX adapter and keep the curves.

**Verification.** Measured on the real devices in an isolated harness (stub `window.xleth`): every device has 2 distinct
font sizes (11 and 12px), 0 text under 10px, 0 under 4.5:1, no letter-spaced uppercase. The 2026-11-07 editors had 4 to 6
sizes. The full audit capture (shots 40-*, 44 to 47, 50) needs the engine; its phase p10 now labels these five as kit
devices.

## 17. Multiband and spectral dynamics (round 2, step 14)

**APEX** (`ApexDevice.jsx`, about 1270px). The hero is the editor's own transfer-curve editor and analysis display,
side by side in one well (curve 212px, close to square so unity is its diagonal). Their drawing, hit-testing and viz
subscription are unchanged; they take a `store` prop. **Each device owns a private APEX store**
(`createStore(apexStoreInitializer)`, the EQ precedent), so two APEX devices, docked or popped out, never share
curves, the selected band or curve undo. The global `useApexStore` only marks the popped-out instance and GLOSS's skin.

- Sections in signal order: Input (Low cut, `Off` at 0), Crossover (Low and High split, each tinted with the band
  below / above it, with a 12 / 24 dB slope switch), Band, *{Band} band* (eight knobs, two rows), Mix (Lookahead,
  Band mix, the reported latency).
- **Band selector** Low / Mid / High / Master: a `SegmentedControl` with band swatches. It swaps one fixed block of
  eight knobs retitled after the band, so the device never grows. Band also holds the state switch (On / Comp off /
  Muted / Off), Peak / RMS detection, Solo (exclusive across L / M / H; disabled on Master) and curve undo, redo and
  reset.
- **Writes** are the editor's: `previewParam` (local, at most one engine write per frame) and one `commitParam` on
  release; switches commit once. Curve edits keep the store's local undo (one entry per gesture); Ctrl+Z / Ctrl+Y act
  while focus is inside the device and stop there. All knobs keep automation through `AutomatableKnob`.
- Canvas captions moved to 10px, sentence case and true minus signs.

**Overdone** (`OverdoneDevice.jsx`, about 880px). The hero is the crossover display (`OverdoneCrossoverCanvas.jsx`, moved
from plugin-ui's `OverdoneCrossoverNode`): the three Linkwitz-Riley band curves in the band palette, crossovers
draggable on it (one octave minimum gap; a drag previews per frame and commits once on release), and each band's live
**upward and downward gain** as two bars in its region, with a `+up / −down` readout where the region is wide enough.
The engine publishes per band the input peak, output peak and downward reduction (`MultibandBucket`); upward is read
off the same bucket as `out − in − band gain + down`, floored at 0. The second view, History, is the multiband
painter's per-band level history, unchanged apart from band-palette colours, sentence-case labels and true minus signs.
Sections: Input, Bands (Low / Mid / High gain in one row, Low and High split under them, each tinted with its band),
Dynamics (Depth, the 56px hero knob, and Time), Output. Three gains fit one row, so there is no band selector.

**Transient processor** (`TransientProcDevice.jsx`, about 650px). The display data exists (`TransientBucket`: input and
output level, fast and slow envelopes, signed gain); the 2026-11-07 shot was empty because the transport was stopped.
The hero's default view is the transient painter's **input against output** (`transientEnvelope`: level grid, detector
envelopes, input and output), the second its signed gain change (`transientGainChange`). With no signal the well says
"Play to see transients"; it never stands blank and never shows a made-up shape. Sections: Detection (Envelope / MIDI,
Threshold, Speed), Shape (Attack, the 56px hero, Sustain), Output (Mix). Threshold and Sustain are disabled in MIDI mode,
as before. The manifest's `dry`, `wet` and `mix_linked` do not exist in the engine and have no control.

**Resonance suppressor** (`ResonanceSuppressorDevice.jsx`, about 1370px). The hero is the resonance painter on a
log-frequency axis (`resonanceCombined`: spectrum, the focus curve's detector weighting and the reduction; a second view
shows the reduction alone) with the focus-curve handles on top. `ResonanceCurveOverlay` moved from plugin-ui into
`components/devices` with its own module CSS: the same HP / LP and up-to-eight band handles, drag maths and keys, but it
takes params and a writer as props, the device owns its band selection, and its keys (Escape, `[` `]`, Delete) act only
while focus is inside the overlay, never on the window. Its docked band strip is replaced by the **Focus** section,
built from kit controls on the overlay's own action creators: band picker, add / remove, shape, Focus (log Hz), Sens
(dB; Protect tops out at 0) and Width (disabled for Tilt). Focus bands are detector weights, not crossover bands, so
they wear the value colour, never the band palette. Sections: Detection (Soft / Hard, Depth hero, Sharpness,
Selectivity), Time, Focus, Stereo (Stereo / Mid / Side, Link: `stereo_link` had no control before), Output (Mix, Trim,
Delta), Processing (Low latency / High quality, Fast / Normal / High, and the high-quality real-time warning, polled
only while high quality is selected). There is no "range" parameter; the engine's are the ones above.

## 18. Tone and distortion devices (round 2, step 15)

**Xleth Filter** (`FilterDevice.jsx`, about 1,500px). Up to eight slots, each with a type, cutoff, resonance, drive, mix and up
to six modulator lanes, all kept. The hero is the response on a log-frequency axis (`FilterResponseCanvas.jsx`): the engine's
aggregate curve (`filterGetResponseCurve`, authoritative) with a faint guide per slot and **one draggable node per slot**.
Sideways is cutoff; up and down is **resonance** (Q, relative to where the drag began, the full plot height being the whole
0.5 to 30 range) for the types without gain, and the **gain** itself, absolute, for peak, shelves and tilt. The wheel sets Q,
arrows nudge (Shift is coarser), `[` and `]` change slot, Escape puts a drag back. A drag previews at most once per frame and
commits once on release. Sections in signal order: **Slots** (eight 24px rows: on, type, remove, add), the **response well**,
**Filter** (type Select grouped Standard / Analog / Character, slope SegmentedControl, disabled for the types whose slope is
fixed), **Tone** (Cutoff, the 56px hero; Resonance; Gain or Morph where the type has one), **Shape** (Drive, Mix),
**Modulators** (the addable lane list with Add as a Select) and the **selected lane's editor** (LFO: shape, Sync / Free, division
or rate, phase; Envelope: five knobs, the ADSR picture, slide notes; Dynamics: attack, release, cut min and max). The live
animation loop is the editor's, in `filterLive.js`: it polls `filterGetLiveState` at about 30 Hz **only while a modulator
exists**, pushes frames into the DOM and the canvas without React state, prints the post-modulation value under each knob a lane
is aimed at, and draws the live curve with the parked one dashed. The editor clamped the slot type to 0..8, so the eleven analog
and character types read as Morph; the device uses the full 0..19. **Each device owns a private store**
(`createStore(filterStoreInitializer)`, the EQ precedent); the global `useFilterStore` only marks the popped-out instance.

**Distortion** (`DistortionDevice.jsx`, about 920px). The hero is the transfer curve, output against input
(`DistortionCurveCanvas.jsx`), drawn from the same pure math the engine's per-sample switch is ported from
(`distortionPainter.js`, which now holds only the math). It redraws on a parameter, theme or pixel-ratio change, never per
frame. Sections: **Mode** (all seven modes as one SegmentedControl, engine order, with Symmetry for Analog and Bits and
Downsample for Crush beneath, dimmed outside their mode), **Drive** (the 56px hero), **Tone** (Tone and the Pre / Post filter
position), **Output** (Mix and the real PEAK_L / PEAK_R meters). The engine has no output-level parameter, so there is none.
Writes are the runtime layout's (`useStockEffectParams`). `distortion.json`, `DistortionCurveNode` and the Designer entry point
are gone; `designer/__tests__/distortionMigration.test.jsx` pinned that layout and was deleted, as the Overdone and Transient
ones were.

**Waveshaper** (`WaveshaperDevice.jsx`, about 670px). The hero is the editable transfer curve on canvas
(`WaveshaperCurveCanvas.jsx`; the maths is the pure, tested `waveshaperCurve.js`): click empty ground adds a point (to 32), drag
moves one (local while dragging, one `wsSetCurvePoints` on release; a click that only selects writes nothing), right-click or
Delete removes one (never below two). A dragged point stays between its neighbours. For the Floor: `[` `]` select, arrows
nudge, and a **Point** section types the selected point's In and Out. Sections after the well: **Shape** (the preset Select,
"Custom" shown but not pickable, and Snap zero, Lock ends, Show input, Smooth curve as Toggles), **Point**, **Input** (Pre
gain), **Output** (Post gain, Mix). The editor's Range switch is gone (Unipolar only relabelled the axes); the engine has no
oversampling parameter. Private store per device (`waveshaperStoreInitializer`).

**Amp Stack** (`AmpDevice.jsx`, about 1,010px). **The two skins are removed**: ANALOG (screws, stripe band, jewel, hardware-cap
knobs, a painted VU needle, a luminance-picked dark and light state) and MODERN, with the chip and `skinOverride`. The engine
publishes no curve or spectrum for the amp, so there is **no display**; the hero is the Model switch (Blackface, Tweed, Plexi,
Modern, Rectifier, Precision), one click and one write, so it switches while playing. Sections: **Input** (Model, Drive as the
56px hero, Gate, Tighten), **Tone**, **Power** (Sag), **Cabinet** (the five engine strings as a Select), **Output** (Mix, Output,
the real output-peak meter). Every value goes through `formatValue`; the 0 to 10 amounts are one-decimal numbers.

**Shared.** `deviceFormat.js` holds the three formats the kit's units do not cover (a plain number, a 0..1 fraction as a
percentage, a phase in degrees), all still `formatValue`. Writes are the editors': knobs preview per frame and commit once on
release, every continuous knob keeps automation (`AutomatableKnob`). Measured on the real devices in an isolated harness (stub
`window.xleth`): 256px tall, 2 distinct font sizes (11 and 12px), 0 text under 10px, 0 under 4.5:1 apart from the silenced slot
name at the 45 % mute opacity, no letter-spaced uppercase. The 2026-11-07 shots 54 to 57 had 3 to 5 sizes, up to 32 texts under
10px and up to 24 letter-spaced caps labels. The full audit capture (p10, shots 54 to 57 and the chain) needs the engine; the
phase now labels these four as kit devices.

## 19. Modulation, pitch and utility devices, and the finished chain (round 2, step 16)

**Chorus** (`ChorusDevice.jsx`, about 740px). The hero is the orbit and LFO display (`ChorusOrbitCanvas.jsx`, moved from the mixer
folder, drawing unchanged): voices as orbs, delay as the orbit radius, width as the ellipse, depth as the wobble and the strand
height, feedback as the connectors, mix as the orb alpha. It is **drawn from the parameters, not from audio**, like the Flanger's
Sweep view. Sections: Voices (Voices in whole numbers, Delay), Modulation (Rate, Depth as the 56px hero), Feedback (0 to 25 %),
Output (Width, Mix).

**Phaser** (`PhaserDevice.jsx`, about 950px). The hero is the notch sweep on a log-frequency axis (`PhaserSweepCanvas.jsx`): L and R
notch dips, feedback-polarity markers, and the sweep band whose two edges are draggable (clamped to the engine's `freq_low` 20 to
2000 Hz and `freq_high` 200 to 16000 Hz with a 50 Hz gap; local while dragging, one write on release). Also a model drawn from rate,
depth, width, stages and feedback. The edges are **also Low and High knobs on a log taper**, so the drag has a keyboard and typed
alternative. Sections: Sweep, Modulation, Notches (Stages as a one-click 1 to 6, Feedback as the 56px bipolar hero, **Resonance** and
**Spread**), Output. Resonance (allpass Q, 0.3 to 5) and Spread (0 to 100 %) are engine parameters the old panel never showed.

**Phanjer** (`PhanjerDevice.jsx`, about 1,110px). The hero is the response canvas (`PhanjerResponseCanvas.jsx`): the flanger comb at the
sweep-centre delay, the phaser notches at the centre stage frequencies, and where the two collide within the engine's third-of-an-octave
guard band. It is analytic, from the parameters. **The two sides wear two band-palette hues, Flanger band 1 and Phaser band 3**, set as
`--ui-value` on each side so its knobs, boxes and curve share the hue; collision zones are neutral ink (the accent is only 32 degrees
from band 3). Left to right: the response, Flanger (Rate, Depth, Feedback, Mix, Delay min and max as log number boxes, tempo sync),
Global (Mode as Linked / Smart / Wild, Global mix as the 56px hero, Chaos, the five LFO shapes) and Phaser (the same four knobs, Freq
min and max, Stages, tempo sync). All 23 parameters keep their ranges, defaults and writes (the discrete ones as a float index) and the
enable rules (flanger sync turns off its Rate; Linked turns off the phaser rate and sync row; Chaos only with Random). The "How it
works" overlay is now per-control hints.

**Pitch shifter** (`PitchShifterDevice.jsx`, about 390px). The engine publishes no pitch-shifter data and the old panel read none, so
there is **no display**. The hero is Semitones (56px, bipolar, `+7.0 st`, the full 24 either way), with Cents beside it and the
four-way mode switch above. The pitch pair is bound to `semitones` / `cents` or `clip_semitones` / `clip_cents` by mode, so the hero
never moves. Character holds Grain size (Granular), Formant (Smart, Voice) or the Clip stretch method and Formant toggle. `mode`,
`clip_method` and `clip_formant` are not automatable in the engine, so they are single commits and never knobs.

**Smart balance** (`SmartBalanceDevice.jsx`, about 1,250px). A four-band auto-leveller: an LR4 tree at 150 Hz / 800 Hz / 4 kHz, each
band's RMS pulled toward its target through a 6 dB soft knee (scaled by Amount and the band's own amount, 10 dB at most, gated below its
Floor), then Preserve restores the original dynamics and Mix blends. The hero (`SmartBalanceCanvas.jsx`, geometry in
`smartBalanceGeometry.js`) is the engine's own analysis: four band columns on a log-frequency axis against level, each with its live
RMS, its draggable target line, its dashed gate floor, the gain being applied and the estimated landing, plus the overall level that
Relative targets are measured from and transient pulses. The poll is the editor's, unchanged (`getEffectMeter` slots 0 to 7 and
`smartBalanceGetDebug`, about 30 Hz). The four band tokens are band-palette hues 1 to 4. A target drag previews per frame and commits
on release (Escape cancels); with no live level to measure from, Relative mode draws and drags nothing rather than invent a place.
Views: Levels, Details (the old Debug overlay). Sections: Measure (Relative / Absolute, Response), Band (a selector over one block of
Offset or Target, Band amount, Floor), Correct (Amount as the 56px hero, Preserve), Output (Mix). The old panel sent every pointer
move; the device sends at most one write per frame and the final value on release.

**Shared.** The param-driven displays (Chorus, Phaser, Smart Balance) run their loop through `visibleLoop.js`, which pauses it while
the canvas is scrolled out of view; no data path changes. Knobs pass the engine's own NormalisableRange skew to the automation maths
(`AutomatableKnob`'s `skew`), which the old Chorus and Phaser rate knobs had left at 1; a knob's own travel stays as it was.
`deviceFormat.js` gains `suffixFormat` for st, ct and the formant ratio. Measured on the real devices in a docked chain, in an isolated
harness with a stubbed `window.xleth` (the Smart Balance meter values are a stub, there only for layout): all five are **256px tall**,
use **2 distinct font sizes (11 and 12px)**, with **0 text under 10px, 0 under 4.5:1 and no letter-spaced uppercase**. The 2026-11-07
shots 59, 61, 62, 65 and 66 had 3 to 5 sizes (8 to 11px) and 5 to 22 letter-spaced caps labels each; the full audit capture (p10, those
shots, the chain and the picker) needs the engine, and p10 now labels all five as kit devices.

**The chain is finished.** `DEVICE_BODIES` holds all 25 stock effects (the same 25 `EFFECT_EDITORS` opens; a test pins it), so the
"opens in its own window until its device arrives" body and the stock Open editor path are gone from `EffectDevice`. What was the stub
is `ExternalPluginDevice`: the same frame for a chain entry that is **not** a stock effect (a third-party plugin, whose editor is a
native window the app cannot draw, a missing or crashed one, or one still being added), with a status line and, for a live plugin,
one Open editor button. `FloatingDevice` is the only pop-out for a stock effect. The legacy runtime is not removed: 12 device files
and the two APEX canvases still import 17 files from `plugin-ui/runtime` (meter polling, the dynamics subscription, the painters,
`useStockEffectParams`). The other 28 runtime files (the renderer, the node components, `PluginUIKitKnob`) are not reachable from the
app entry and add nothing to the bundle; whether they and the Designer go is a separate decision.

## 20. Video effects as devices, and the Inspector (round 2, step 17)

**Audio | Video.** The Devices tab's chain head (`ChainHead.jsx`, shared by both views) is the track name on its identity colour
edge with two pressed-state glyph buttons, Audio and Video (`videoDeviceStore.view`, session only). Video shows the selected
track's picture as devices (`components/devices/video/`); Master has no picture and says so. The same `DeviceFrame`, the
same identity stripe, the same picker: the sound and the picture of a track read as one instrument.

**Order.** First a pinned **Per note** group (configs the engine evaluates per triggered note, with no order of their own,
so they are not reorderable): Ping-pong loop (source time), Zoom/pan/rot, Bounce (cell position, grid cells only), then on
pattern tracks Note fade and Slide note effect. Then the visual effect chain in evaluation order: drag a device by its name
(local preview, **one** `setTrackVisualEffectChainOrder` on drop) or Move left / right. Outline, Drop shadow and Visual echo
are composite-time stages that run after the chain wherever they sit; their devices say so. "Zoom/pan/rot (chain)" places
the track's own animation at that point of the chain while it animates (and frames the cell statically otherwise). Ends in
"Drop video effects here": the audio chain's `TrackContextMenu` picker, groups Per note and Chain.

**Writes.** `videoFxWrites.js` is the one module that writes visual effects: every call is the one the legacy panel made,
followed by `timeline-tracks-changed`. Chain entries have no ids; they are addressed by index, so the chain is refetched
after every write and a popped-out device never holds its own copy. Knobs and boxes preview locally and commit once; each
engine call is one undo command, as before (unlike stock audio parameters, visual effects do have undo). Colours are a swatch
over the system colour dialog that commits once, on close. Ranges, defaults, steps and commit-time snaps are the old
sliders' (`videoFxCatalog.js`).

**Displays.** Bounce: displacement against time, each repeat halved. Note fade: the opacity across a one-beat note at the
project tempo. Both are canvas, drawn from a line-for-line port of the engine's maths (`videoMotionMath.js`, from
`AnimationManager.cpp`, `NoteFade.h`, `ClipFade.h`) and redrawn on a parameter, theme or pixel-ratio change only. A slide-note
bounce follows the note's own slide curve and has no display. The chain effects have none: the engine publishes nothing to
draw.

**Zoom/pan/rot.** `ZprTimelineCard` has two layouts. In the device the well holds the framing viewport and the keyframe lanes,
then Length, Ends and At playhead. The pop-out window (the one device that is not `--device-h` tall) is the full editor: big
viewport, Lock aspect, Reset pin, Record and its tolerance, the derived window and centre, lanes, the segment curve editor.
Presets (the `xform` adapter) are in the title bar. Lanes use the band palette (pan X, pan Y, zoom, rotation); the disabled
Opacity lane is gone (no such channel).

**Inspector.** Only properties of the selection, as label / value rows. On / off is `RowToggle`: a kit Toggle with no text,
named by its row, a check when on and an empty box when off, so no row echoes its label. Track: Placement (and, when
fullscreen, Hold gaps and Opacity), Hold last frame, Cell shape (Corners commits once per gesture, Own gap), Video flip,
**Video effects (N)** (opens Devices on Video). Video flip: Flip; **Style**, four glyph segments that write exactly the cycles
the engine's `migrateVideoFlipMode` builds for the legacy None / HorizontalEven / Clockwise / CounterClockwise (Custom is
printed for any other cycle); Cycle, one cell per state (up to 12) whose menu sets the orientation, moves it, makes it the
start or removes it; Modifier; Start state; and the preview, one row of eight cells in an eight-column grid that always fits
the column. The preview resolves example pitches (there is no upcoming-events call). Clip: Reverse, Stretch, Formant;
Vibrato and Scratch as switch plus Edit (their editors already had every inline control); Swirl and Wave switches. The
companion amounts and preview moved to a Picture section in the vibrato and scratch editors (`ClipPictureSection`, through
each editor store's `commitVideo`).

**Audit.** `p75-visualfx` adds every effect through the picker; `p76-visualfx-scroll` shoots the Video view page by page as
85-NNofMM; p80 is unchanged. Measured on the real components in an isolated harness (stub `window.xleth`): devices 256px tall,
2 font sizes (11, 12px); Inspector 3 (11, 12, 13px); 0 text under 10px, 0 under 4.5:1 outside the bypassed device's mute
opacity, no letter-spaced uppercase, no native range or number input, nothing clipped at 363 or 280px. The Electron capture
needs a current engine addon.

## 21. FX Graph (round 2, step 18)

**Drawn how.** DOM nodes in a CSS-transformed canvas (pan, wheel zoom), one SVG layer of cubic Bézier cables, a
`<canvas>` minimap. A graph has a handful of nodes, so DOM nodes are right for it, and the connect logic (drop
targets found with `elementFromPoint` and a 24px snap radius, `data-*` port attributes) depends on them.
`GraphStatePreview.tsx` still holds the model and the interaction; its styling is in kit-layer CSS Modules
(`GraphCanvas`, `GraphNode`, `GraphMenus`, `ModulatorEditors`, `FxGraphPanel`, `SignalLegend`), and the legacy
`fxGraph.css` and `fxGraphEffectPicker.css` are gone. The `xleth-graph-state-preview__*` class names stay on the
elements as structural hooks only (tests and the audit select by them); they carry no styling.

**Signals and cables.** The signal-type hues (3.3), each also a stroke or a shape, so no cable or port is told apart by
colour alone: audio is a solid cable and a disc port; parameter (a macro, LFO or envelope into an exposed parameter) a
dashed cable and a diamond; sidechain key the audio hue, dotted and quieter (still above 3:1), and a ring. The header
legend lists only the three types the graph carries (events and video have no cables here). The canvas is the neutral
`g0` well with a grid in graph space (a minor cell every 24px, a major line every five, the minor lines dropping out
below 8px on screen) that follows pan and zoom through three custom properties. A cable is hoverable and pickable
through a wide invisible stroke; the hovered or selected cable alone shows its disconnect and edit-mapping buttons
(20px, 24px hit area); selection (a node or a cable, one at a time) is a 1px `--ui-select` outline. A Fit button and
the zoom, and a minimap (nodes, cables in their hues, the visible window; click or drag to move the view) that
appears once any node lies outside the view.

**Nodes.** A neutral card: a 26px title bar (the glyph from the Xleth family, the name, and on an effect the
activator), a 22px port row naming the ports (Audio in, Audio out, Parameter out, Key out), a 26px meta row, then the
body. The effect shows its device's name from `DEVICE_NAMES`; its activator is the device frame's own Toggle (on =
the inverted chip while it runs; a bypassed effect also prints Off and dims its body). Double-click or Edit opens the
effect in the same `FloatingDevice` the Devices tab pops out (the graph owns bypass, so the activator there is
disabled). Macro: a kit NumberBox in percent through `formatValue`, committed once. Sidechain input: a kit Select.
**Geometry rule:** every in and out port sits on one row 37px below the node top (`PORT_ROW_Y`), the terminals are
48px tall, and a parameter row is 18px with a 4px gap; cable ends are arithmetic over those numbers, so the CSS rows
have exact heights. Measured in the harness: every cable end lands within 0.4px of its port mark.

**One picker.** `FxGraphEffectPicker` is deleted. The add menu (canvas right-click, or the empty state's Add node) is
the Devices chain's category list built by the same `buildEffectChainMenuItems`, then a Modulators group (Macro,
Envelope, LFO, Sidechain input). Choosing a plugin calls the same `addGraphEffectNodeForTrack`, the name resolved from
`effectCatalog`. A graph with only its two terminals shows a structural empty state with an Add node action.

**Modulators.** The envelope and LFO nodes show a recessed display (the stored AHDSR curve; the stored waveform) with a
one-line summary and an Edit button. Edit opens a floating sheet beside the node (title bar, draggable, Escape
closes, the hard offset shadow): the editable graph (the SVG envelope with 22px handle targets; the LFO canvas with its
eight handles) in one display well, then NumberBoxes (times on a skewed 0 to 10 s law, Sustain in percent, the three
curve tensions bipolar; the LFO's period on a log law 1 ms to 60 s, Phase in degrees), SegmentedControls (Sine,
Triangle, Square; Free, Sync), a Select for the sync division and a Toggle for Include slide notes. Every box
previews locally and commits once on release with the patch the old slider sent. **There is no moving cursor on these
displays:** the engine publishes no running phase or level for a graph modulator, so they are drawn from the stored
definition and redraw on an edit, a theme or a pixel-ratio change only; drawing a position would be a fabricated
signal. The mapping editor (a cable's Base and Depth, or Min and Max; the curve; the three preview values) and the
node menu (Edit, Bypass or Enable, Remove, Expose parameter with its search) use the same frame and tokens.

**Header.** One 28px row: the track's name on its identity-colour left edge (resolved as the arrangement and the
Devices chain resolve it), the cable legend, and an ownership chip in sentence case (the graph owning the track is the
inverted chip; the other two are outlined and worded differently).

**Audit.** `p60-fxgraph` captures the picker as the menu (73) and the two editor sheets (74a, 74b); the node menu and
the mapping editor need a wired graph and are checked in the isolated harness. Measured on the real components in an
isolated harness (stub `window.xleth`), panel and nodes and both editor sheets and the mapping editor open: 3 font sizes
(11, 12, 13px), 0 text under 10px, 0 under 4.5:1, no letter-spaced uppercase, no native range or number input. The
2026-11-07 FX Graph shots had 6 sizes (9 to 14px), 24 text nodes at 9px and 5 letter-spaced caps labels. **Owed with
the engine:** building a sidechain route, LFO and envelope modulation still driving their targets, macro mapping,
graph and chain consistency; the Electron capture needs a current engine addon.

## 22. Timeline polish and its popovers (round 2, step 19)

The arrangement's headers, toolbar, Patterns column, cue lane, loop bar, automation lanes, the four popovers and
dialog it opens, and the two clip FX editors. UI only: every drag still previews locally and commits once, every
IPC call, timeline datum and undo path is unchanged, and the lanes' drawing is unchanged (the clip canvas, the cue and
macro lanes' DOM geometry, the curve canvases).

- **Track header** (`TrackHeader`, `TrackHeaderList`): a neutral **g2 row**. Identity is a **6px stripe** down the
  left edge (dashed on a pattern track) and an **18px colour chip** that carries the type glyph in the automatic label
  ink and is the 24x24 button that opens the colour popover. The clips already carry the full colour, so nine saturated
  slabs beside them are gone, and the colour still threads grid, lane, mixer and viewer. M / S / V are kit Toggles at
  rest (solo keeps `--ui-solo`). **A muted track dims only its stripe and chip** (to `--ui-mute-opacity`): the name, the
  track menu and the toggles stay `ink` on g2 (12.1:1), so **names and controls never drop under 4.5:1**; dimmed *clip*
  content is the only thing allowed to. **The name has the row (round 3):** the column starts at **232px**
  (`HEADER_WIDTH`, still draggable) and the row is chip, name, M / S / V, which leaves the name **124px** (it had 62:
  "Grow..."). The 24px chip and the three 24px toggles are hit-area floors, so at the old 212px the most a name could
  have had is 104px. The **track-menu button is not in the resting row**: it sits over the end of the name while the row
  is hovered or holds focus, and right-click or the menu key opens the same menu from anywhere on the row. From a 56px lane the controls stack under the name. Selection is a 1px
  `--ui-select` outline, focus a lighter row. The hover-only trash is gone (Delete Track is in the track menu). Folder
  rows use the browser's `Disclosure` triangle (`aria-expanded`), a folder glyph, the name and the **child count in
  tabular numerals**; the delete action shows on hover or focus. Macro and automation lane label rows share the column's
  module. `AUTOMATION_GROUP_HEADER_HEIGHT` is 24 (the hit floor).
- **Toolbar** (`TimelineToolbar`): one 32px row (the height `shellLayout` budgets; 38 until round 3) of kit IconButtons in a `Toolbar`.
  Tools are named "Select tool" and so on with their key (S, P, C, D) and mouse grammar in the hint bar. **Snap is a
  labelled Select**; the sample indicator reads **"Painting with: Pitch 1"** and is absent with no sample (a syllable
  template gets an outlined dot); the **zoom reads in bars visible** (`9.9 bars`, whole bars from ten up, beats under
  one bar: `zoomReadout`), which is what a zoom level means while arranging, with `33 pixels per beat` in its hint;
  Quick notation and Quantize say why they are disabled.
- **Patterns column** (`PatternListPanel`): 24px list rows in a listbox, in a g0 well: a 3px edge, the name, and a
  **mini preview of the pattern's notes** (one 40x14 canvas per row, drawn when the pattern, colour, theme or pixel ratio
  changes, never per frame). The edge and the notes are **the colour of the track the pattern's first block sits on**,
  the Piano Roll's own rule (section 15): a pattern has no colour of its own in the project, and one that is not placed
  takes the value colour. The length in **steps with the unit** (`32 steps`) and the note count are in the row's hint.
  The pattern open in the Piano Roll is the selected row (`--ui-select` outline). Enter or Space opens, F2 renames.
- **Pattern blocks** (round 3). A pattern block is the clip's shell with a different body: the **title strip in the
  track's colour** with the name in the automatic label ink, a **body at the identity colour's low lightness** (22 % over
  the lane ground), and the **mini piano roll** in the full colour. The notes are what say "pattern". The diagonal
  hatch is gone: a hatch reads as disabled or offline media and sat on every block. `--theme-timeline-pattern-lane-tint`
  was a blue wash (`rgba(106, 169, 255, 0.07)`) on every pattern lane; it is a neutral 3 % now, in every theme
  (asserted), and the header's dashed stripe is what marks a pattern track.
- **Bar groups** (round 3). Empty lane space carries the song's structure: on the grid layer, **every other group of
  bars sits on a tone one small step above the ground** (`--theme-timeline-bar-group-shade`, a ramp step from g0:
  `#131313` on dark, set per ramp in `neutralRamp.ts`). A group is 4 bars; once 4 bars are wider than 600px it is one
  bar, and zoomed far out it doubles until a group is at least 48px wide (`barGroupBars`). Painted in `drawGrid` only,
  under the lane tint and the lines, with edges on whole pixels: no extra layer, no DOM. A repaint of a 1242x576 grid
  costs about 0.35 / 0.29 / 0.18 ms at 8 / 40 / 400 px/beat with the raster forced, under 0.1 ms of it the shading
  (`window.__XLETH_TIMELINE_GRID_PERF = true` logs each repaint with a `[Timeline]` prefix).
- **Ruler** (round 3). **Every fourth bar number is the landmark: 12px in ink**; the others are 10px in ink-3 and are
  dropped wherever they would touch a neighbour (`rulerBarLabels`, `keepRulerLabels`). They were all 9px, under the Floor.
- **Snapshot cue lane, loop bar, macro lanes.** The cue editor is a floating surface of kit controls: Selects, a Toggle
  for Transition, the 14 per-type parameters as NumberBoxes (same range and step, previewing locally and writing
  **one** `setCueTransition` on release; the old slider wrote per pointer step), IconButtons, the direction compass
  and the two-curve easing editor on tokens. The pin and the transition grips have 24px hit areas around their drawn
  shapes. The loop bar is value-coloured while armed and grey when not, and its toggle is a 14px chip with a 24px hit
  area (an inverted chip, `aria-pressed`, when armed). Macro lane curves wear the parameter signal hue, a looped clip is
  dashed, selection is an outline; the curve stays an SVG polyline and the points positioned buttons.
- **Popovers and the dialog.** The track colour popover is a kit `Menu`: Auto, the 16 swatches (24px, two rows of
  eight, each **named in the hint bar and its accessible name**, "Slot 9: Orange", by `trackColorNames.js` from the
  colour's OKLCH hue) and a custom colour; the display popover is a `Menu` of eight labelled SegmentedControls in
  sentence case; the project canvas popover is Selects and width and height NumberBoxes; **Quantize** is the kit
  `Dialog` with Start edge and End edge as SegmentedControls.
- **Clip FX editors** (`ClipFxWindow`): Vibrato and Scratch are **non-modal** floating windows (not the modal
  `Dialog`: the arrangement stays live under a curve you are editing). They take focus when they open and **Escape closes
  the focused one**. Controls are kit: SegmentedControls for shape, stamp, rate mode and time mode; NumberBoxes with
  units for depth, rate, phase, smoothing and gain; Selects; a Toggle. The curves stay one canvas each, with 10px axis
  labels. The status line prints Active or Off with a filled or outlined square.

**Measured** on the real components, the audit capture at 1920x1080 and 100 %, against the 2026-11-07 run: every touched
surface has 0 text under 10px, 0 under 4.5:1, no letter-spaced uppercase and at most 3 font sizes. Header column 41
texts, 2 sizes, at rest, with a track muted and another soloed, and at an 82px lane (shot 13 had 37 low-contrast nodes
and 4 under 10px; the 17 that remain in the full-layer shot are the Inspector's disabled flip preview). Toolbar 81
texts, 3 sizes (was 6 caps labels); Quantize 18 texts, 2 sizes (was 12 caps labels); display popover 0 under 10px (was
8); cue editor 19 texts, 3 sizes; Vibrato 24 and Scratch 29 texts, 3 sizes (were 22 and 47 under 10px). 2,686 lines of
`app.css` went (legacy baseline 13191 -> 10505).

**Open.** Macro automation points are 20px hit areas (a geometry constant shared with the hit test). The macro lane was
not photographed after the restyle: in this build FX Graph's Add menu did not add a Macro node, so none could be created
in the harness. The Electron capture still lacks a current engine addon. **Owed with the engine:** header readability
with 12+ tracks; mute, solo and arm at rest; folder collapse; snapshot cues; loop region dragging; quantize; vibrato and
scratch editing; automation lane drawing.

## 23. Settings, floating tools and dialogs (round 2, step 20)

These are read-and-configure surfaces. Controls are kit controls at 12px; where a dialog reads like prose it keeps the 16px
reading exception of 13.1. Every surface below measures **0 text under 10px, 0 under 4.5:1 (one disabled label aside),
no letter-spaced uppercase and at most 4 font sizes**, audit capture at 1920x1080, 100 %, against the 2026-11-07 run.

**Kit additions.** `TextField` (single-line input, 24 / 28 / 32, `mono` for code-like text), `Checkbox` (a real input,
inverted-chip check, indeterminate), `Progress` (rail plus a printed readout; `null` is a labelled indeterminate state,
and the slide only runs when motion is allowed). `Dialog` gained `width="xl"`, `fill` (a tall panel), `flush` (a body of
controls: no padding, 12px, panes scroll themselves) and `above` (stacks over popovers: the file picker opens from other
dialogs). `formatValue` gained `Mbps`, `kbps`, `MB`, `LUFS`, `dBTP`, `dBFS` and `s` (a duration: `12.5 s`, then `2:05`).

**Settings** (`components/SettingsPanel.jsx`, `settings/`). A left **nav that lists both scope groups** (Project, Application,
each with its one-line scope note) replaces the tab strip plus sub-nav; the content column is label / description / control
rows (`settingsKit.jsx`: `SettingsSection`, `SettingsRow`, `SettingsHint`, `SettingsValue`). On / off settings are a `Toggle`
that says **On** or **Off**; sliders are `NumberBox`es (the old range inputs); the Clip FX defaults, UI scale and similar
controls **commit once on release** where the old inputs wrote per change. Appearance sliders still preview live (a theme
write, no IPC). The hue / tint track gradients are gone with the range inputs. **Plugins** is a 24px-row table (name,
vendor, format, 11px or larger) with kit Add path and Scan plugins and a `Progress` that fills with scanned / total.
**Shortcuts** is a searchable table (action, shortcut, conflicts) with one key cap per key, a "Custom" word beside a
changed binding, and a glyph plus words for a clash; capture and override logic are untouched. **Logs** is kit rows with
mono counts, times and paths. **Gap:** the log view with level filters the brief asked for is **not built**: the logs bridge
(`window.xleth.logs`) never returns lines by design, so a view needs an IPC change. **Theme editor** is a theme listbox,
Simple / Advanced `Tabs`, NumberBoxes for brightness, contrast, tint and hue, mono token names and values, IconButton
detach toggles, Apply theme / Revert / Save as new theme; the contrast readouts and neutral-ramp controls are kept. The
live preview cards read the working theme's `--theme-*` tokens on purpose (they show that theme, not the kit's `--ui-*`
tokens, which resolve from the document root). The unused standalone modal wrapper is gone.

**Sample Sandbox** (`components/sandbox/`). `sandbox.css` (1,712 lines) is deleted. Effect and View are kit `Menu`s
anchored under kit Buttons, the selection right-click menu is a kit `Menu`, tools are `Toggle`s with a brush `NumberBox`
set and a SegmentedControl for the region shape, the transport is IconButtons and a Select, op rows and their parameters
are Toggle, IconButton, NumberBox (preview locally, one commit), Select and Checkbox, the layer rail carries kit mix
controls, and the separation strip uses `Progress`, Checkbox and Select. States are a dot **and** a word. The waveform,
spectrogram, ruler, overview strip and overlays are still canvas; their stacking rules live in `SandboxCanvas.module.css`.
**Open:** the black keys of the autotune note picker are narrower than 24px (canvas-like geometry); each key has a name and
`aria-pressed`.

**Quick Notation** is a mono notation input (a highlight layer under a transparent textarea, so rests dim and length marks
take the value colour), an always-visible **symbol key** (each symbol inserts at the caret, with a sentence-case
description), a NumberBox for the 32nd offset, a Checkbox for the preview, a status line that now prints parse problems,
and a primary action that says what it inserts ("Insert 12 clips"). **Split Syllables** is a grid of syllable cards (number,
play IconButton, TextField) and Clear all / Save syllables; the marker canvas and its drag logic are unchanged.

**Dialogs.** The **file picker**, **Export** and **MIDI import** are kit `Dialog`s. Export destinations are `Tabs`; every row
is a label and a kit control (`exportKit.jsx`); progress is `Progress`; the loudness report says Pass or Over in words; the
primary action is "Export audio" or "Export video"; the **Custom** preset name is an inline field (Electron has no
`window.prompt`). MIDI import's primary action counts ("Import 3 tracks"); transpose is a NumberBox in semitones; position is
a SegmentedControl. The file picker's path field is mono. **Convert** and the Missing, Unsaved and Cleanup dialogs were
already kit (13.1).

**Welcome** (`welcome.html`) is a separate BrowserWindow that cannot import the React kit. It was restyled in a parallel
session ("startup screen and splash design cleanup"): it measures 3 font sizes, no caps, none under 10px. It carries a frozen
copy of the dark ramp, so it must be re-synced by hand if the ramp changes.

**Removed.** `ProgressBar`, `InfoTip`, `sandbox.css`, the standalone theme editor modal, the Settings CSS-pinning test.
`app.css` 10,505 -> 5,574 lines in this step (legacy baseline lowered each commit).

**Audit (2026-11-07 -> now), font sizes / letter-spaced caps / text under 10px:** Quick Notation 5 / 4 / 3 -> 3 / 0 / 0;
Sandbox 6 / 11 / 15 -> 3 / 0 / 0; Settings Plugins 6 / 24 / 48 -> 4 / 0 / 0; Theme editor 5 / 11 / 12 -> 3 / 0 / 0; every
other Settings page 4 / 0 / 0; Export tabs 7 -> 3 (Custom 4); MIDI import 7 -> 3; file picker 5 -> 3.

**Not captured or not checked.** The Convert dialog and the media, sampler-knob and sandbox-selection menus need project
state the harness does not set up (the media-row menu was taken). Split Syllables is photographed empty (no region is
selected in the harness). MIDI import 132 has one 3.8:1 node: its disabled "Override project tempo" label (the 45 % disabled
dim). Nothing was run against the engine: **owed** are a plugin scan, editing a shortcut, the full Sandbox workflow, Quick
Notation entry, Split Syllables, an export, a MIDI import and the Welcome window on cold start.

## 24. Round 2 close-out (step 21)

### 24.1 Where each round 2 rule lives

| Rule | Section |
|---|---|
| Band palette: four fixed band hues `--ui-band-1..4` (three-band devices use 1, 2, 4), checked per shipped theme | 3.3.1, 17 |
| Dock focus mode (double-click the open tab, the maximise button, `Ctrl+Shift+D`; state in `shellLayoutStore`, not in the layout) | 8.1 |
| Space allocation: dock `clamp(320, 40% of A, 520)`, top row minimum 200, arrangement minimum 4 rows, the folded strip and sheet when all three cannot fit | 8.1 |
| Edit Grid rails, not rows | 8.2 |
| Video devices: Audio / Video chain head, per-note group, evaluation-ordered chain, canvas displays ported from the engine's maths | 20 |
| Sampler, Piano Roll, compressors, multiband, tone, modulation devices | 14, 15, 16, 17, 18, 19 |
| FX Graph: one picker, modulator sheets, signal and port grammar | 21 |
| Timeline polish, popovers; Settings, floating tools and dialogs | 22, 23 |

### 24.2 Audit result (2026-11-07 baseline, 124 shots, against the 2026-11-09 recapture, 145 shots)

Text nodes 6,643 to 6,994; below 4.5:1 181 to 69; under 10px 839 to 10; letter-spaced uppercase 653 to 21 (sums over shots). 71 of 83 surfaces meet all four targets (0 below 4.5:1, 0 under 10px, no letter-spaced uppercase, at most 4 font sizes). The report with the per-surface table and the surfaces still short is `tests/ui-audit/out/COMPARE.md`; the shots and `metrics.json` ship in `ui-audit-<date>.zip` at the repo root (git-ignored).

Still short, for a follow-up (not fixed in step 21): the Inspector's flip preview (34 nodes below 4.5:1 with a clip track selected), the Glue Comp's Freq cells, the EQ ruler's letter-spaced capitals, the video devices' dimmed captions (9 nodes), the SamplePicker sheet and the Browser's sample thumbnails (legacy global classes: 9px, caps, 5 sizes), one RESET button in the View menu, and single labels in the Sandbox rail, the theme list and the MIDI import dialog.

### 24.3 Stylesheets that are left

`src/styles/app.css` is 5,494 lines (23,858 at the 2026-11-07 baseline), with one `:root` block; `scripts/legacy-css-baseline.json` holds the same number and may only go down. `scripts/prune-dead-css.mjs` lists (and with `--apply` deletes) rules whose class selectors match nothing in `src/`; run it after every migration. The other non-module sheets, all in the `legacy` layer:

| Sheet | Lines | Used by |
|---|---|---|
| `windowing/components/windowing.css` | 917 | the windowing shell (AppShell, DockRegionResizer, PanelFrame, PanelTabStrip, ResizeHandles, SampleSelectorDrawer, Titlebar) |
| `components/timeline/clipControlTuner/clipControlTuner.css` | 279 | `ClipControlTuner`, behind the dev flag `VITE_XLETH_CLIP_CONTROL_TUNER` only |
| `components/mixer/EffectModule.sidechain.css` | 102 | `EffectModule` (the sidechain row) |
| `styles/layers.css`, `styles/legacy.css`, `styles/vendor-xyflow.css`, `components/timeline/clipControls.css` | 15, 3, 3, 15 | the layer order, the `app.css` import, `NodeEditor` (xyflow) and `TimelineCanvas` |

### 24.4 The Plugin UI Designer is parked

`src/plugin-ui/designer/` (52 files, about 12,500 lines) had no entry point left: nothing in the app imported it, and its three npm scripts (`dev:designer`, `build:designer`, `start:designer`) are gone. It now lives in `ui/_parked/plugin-ui-designer/`, outside `src/` so that vite, vitest, eslint, stylelint and `check:legacy-css` never see it; `_parked/.gitignore` ignores everything but its README, so the code exists on this machine only and git history is the backup. `_parked/README.md` names the last commit that holds it and the restore commands. The plugin-ui runtime, schema, manifests, layouts and appearance stay in `src/plugin-ui/` (the devices import 17 runtime files); `schema/validationStatus.js` is the hard / soft validation classification the schema tests use. The describe blocks of four runtime tests that exercised Designer helpers went with it (`_parked/plugin-ui-designer/runtime-tests/`).

### 24.5 Running the audit

`node tests/ui-audit/copy-project.mjs <project> <tmp>`, `node tests/ui-audit/mk-missing.mjs`, then `node tests/ui-audit/capture.mjs <copy>`: one launch runs every phase in the order the chain header in `capture.mjs` explains (including the 1366x768 pass), then builds `INVENTORY.md` and `metrics.json`. `node tests/ui-audit/compare.mjs` writes `COMPARE.md` against `out/baseline-2026-11-07/metrics.json`. The original project is never opened. The stress test (2,000 notes, 32 metered tracks, scrolling while playing) and the engine-dependent checks are manual: see `out/MANUAL-SHOTS.md`.

## 26. Round 3: "FL-home" (2026-11-11)

Rounds 1 and 2 gave Xleth a skeleton that section 1 itself calls "structurally close to Live". Round 3 keeps Xleth's
own look (square, neutral, the inverted chip, the hard offset shadow) and changes the skeleton's habits to the ones an
FL Studio user expects, without lifting anything of FL's: the arrangement owns the screen, content sits in dark wells
under lighter chrome, strips and blocks show their content instead of labels, shared information is printed once, no
window opens onto nothing. The brief is `xleth-ui-reference/SPEC.md` (amendments A1 to A7); the audit of it against
the code is `ui/docs-round3/RECONCILE.md`.

### 26.1 What changed and where each rule lives

| Change | Rule lives in |
|---|---|
| A1. Dark ramp widened from a 23-step to a 35-step spread; ink-3, boundary, rec-text and the cool accent re-solved for the new g3; surface roles (g0 content, g1 chrome, g2 headers, g3 controls) | 3.1, 3.2, 3.5, 3.6 |
| A1. Bar lines clear 3:1 on the lane ground in dark and light | 3.6, 12 |
| A6. Quiet on-state for the region toggles and the tempo lock | 3.2, 8.1 |
| A2. Compose layout as the default; the stacked side region; return-to-dock; arrangement chrome 95 to 83 | 8, 8.1 |
| A3. Mixer: named inserts, one dB gutter, no repeated words, signed gain, Master on the same grid, loudness rail, audio-hue meters | 6, 10 |
| A3 follow-up. The insert area is as tall as the longest chain, one number for the whole mixer | 10 |
| A4. Track header gives the name the row; pattern blocks without a hatch; neutral lane tint; bar-group shading; ruler landmarks; Patterns rows with a note preview; zoom in bars | 22 |
| A5. Piano Roll and Sampler tabs never dead-end | 14, 15 |
| A7. Time and bars.beats at 16px mono | 4, 8.1 |

### 26.2 Measured against the brief's targets

Measured in the render harness (the real components over a fake engine: 16 to 24 tracks, 1920x1080, 100 %), not in the
running app. "Before" is the brief's own measurement of the real app.

| Thing | Before | Target | Now |
|---|---|---|---|
| Arrangement lanes, 1080px window, dock open | 8 rows | 14 | **14** (lane viewport 511px) |
| Arrangement lanes, 1032px window | 7.4 | 13 | **13** (computed: column 974, dock 390) |
| Arrangement lanes, 1366x768 | 7 | not set | **8** |
| Preview row | 200px high, 76 % letterbox | gone; Preview 304x171 over the Browser | gone; Preview slot 304x199, **picture 302x169** (2px short: the panel's borders) |
| Inspector at rest | 358x199, one sentence | hidden until asked | hidden; opens docked right at 280 |
| Chrome above the first lane | 95 | 83 | **83** (32 + 26 + 24 + 1) |
| Left region | 258 | 304 | **304** |
| Track header column / name | 211 / about 4 characters | 211 / 120px or more | **232 / 124px.** Miss on the column: 120 is not reachable at 212 with a 24px chip and three 24px toggles |
| Mixer strip pitch | 84 | 68 | **72.** Miss: three 24px toggles need 72 |
| Strips visible beside the Master | 17 | 21 | **20.** One short, from the 72 |
| Fader length, 409px dock, longest chain 3 | 171 (no insert names) | not set | 158 with the names shown |
| Loudness dock while off | 147px | 28px rail | **28px rail** |
| Surface tones g0 / g1 / g2 / g3 | 20 / 27 / 34 / 43 | 15 / 26 / 38 / 50 | **15 / 26 / 38 / 50** |
| Screen share of the three commonest colours | 66 % | "falls out" (FL: 22 %) | **61 %.** A miss as a number: the three greys are now 15 / 38 / 26 instead of 27 / 34 / 20, so they read as three surfaces, but the share barely moved. The empty Browser list and the mixer's body are most of it |
| Bar line on the lane ground | 2.3:1 | 3:1 | **3.10:1** (light 3.09:1) |
| Grid repaint, 1242x576, raster forced | not measured | not set | 0.35 / 0.29 / 0.18 ms at 8 / 40 / 400 px/beat |

### 26.3 Not done, and why

- **Master peak mini-meter in the top bar (A7).** The master level is in the `getAllPeaks` snapshot, but the one poll
  that fills it runs only while the Mixer tab is showing (`MixerPanel`, gated on `visible`), which is exactly when the
  Master strip's own meter is on screen. A top-bar meter fed by the bus would be dead whenever it could be useful. Making
  it live means moving that loop out of `MixerPanel` so it runs for the whole session: no second poll, but the existing
  call would be made all the time instead of only with the Mixer open. That is a change of load, so it is a decision,
  not a default. The Master strip has a peak readout from the same bus instead (section 10).
- **Light ramp.** Not widened: its semantic colours sit at 4.5:1 on its ground (3.6).
- **`welcome.html`, `splash.html`.** Their frozen copy of the dark ramp exists only in another session's uncommitted
  rewrite of those files, so it was not re-synced (section 12 lists the values).
- **Sampler "last sample used".** There is no record of one that outlives a session (a region id belongs to a project).
  The tab follows the open pattern, then the pattern last open, then the first pattern that plays a sample (section 14).

### 26.4 Verification

Every phase: `npm run lint` (19 errors in 12 files, none in a file round 3 touched, identical before and after),
`npm run lint:css`, `npm run check:legacy-css` (4,610 lines, unchanged), `npm test` (5,115 tests before round 3, 5,219
after), `npm run build`, `npm run shots` with `--compare` against the previous label (0 text nodes under 4.5:1 or under
10px in every run), and renders of the populated shell from the local harness.

**Not run: the full audit of section 24.5.** `xleth_native.node` was built at 14:29 on 2026-11-11; the last engine and
bridge commit is 14:56 the same day and the working tree holds further uncommitted engine and bridge edits, so the addon
is not current, and round 3 was told not to build it. **Nothing in round 3 was run against the engine.** Owed in the
real app: picture colour and video decode with the Preview docked left; splitter and region-resizer drags in Compose,
including drag-to-dock onto the left edge; meter ballistics, the clip latch and the routing cables at 72px; insert
names after undoing a chain load; the Patterns previews and bar-group shading while scrolling during playback; 2,000
notes; lane heights 36 / 56 / 80; the Piano Roll and Sampler opening cold on a real project.

**How round 3 was committed.** The working tree held about 115 uncommitted `ui/` files from other sessions, in the
same files round 3 edits. Each commit holds only round 3's hunks (files that also carried foreign work were staged as
`HEAD` plus those hunks), so the committed tree was never built on its own: the checks above ran on the working tree.
Two things in it exist only as other sessions' uncommitted work and are assumed by the text of this document:
section 25 (the block geometry rework: `blockGeometry.js`, `patternNoteIndex.js`) and section 8.2.

### 26.5 Open items

From the brief's "Later" list, not started:

- Device bodies are sparse and repeat labels (a section header "Input" over a knob labelled "Input"; five controls in
  650x255).
- A folder lane could draw a summary of its children instead of an empty row.
- An overview strip above the ruler.
- Piano roll, channel-rack-style step entry and plugin windows against FL: no FL references were captured for these.

From round 3 itself:

- The top-bar master meter (26.3), waiting on the decision about the poll.
- The chain cache is not refreshed by a chain change the renderer did not make (section 10).
- A stacked Preview sits outside the floating layer's work area; the drag-to-dock ghost for the left edge is drawn at the
  work area's edge, not over the Browser's column.
- The sample picker sheet is as tall as the top region with a 280px floor; in Compose there is no top row, so it covers
  the top of the arrangement instead of Preview and Inspector.
- Metronome and auto-scroll are still inverted chips in the top bar; auto-scroll is on by default and is a candidate for
  the quiet on-state.
- About 25 canvas modules keep literal fallbacks from the old ramp (section 12).

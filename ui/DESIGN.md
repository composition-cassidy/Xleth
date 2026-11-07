# Xleth UI design contract

Read this before touching any stylesheet or component. It is the contract for the
UI rebuild. Phase 0 (this file, cascade layers, tokens, guards, render harness)
changes almost nothing visually; later phases are measured against it.

Status: **Phase 0 landed** (layers, tokens, `format.ts`, guards, `npm run shots`). The kit
itself (components) starts in Phase 1; nothing consumes the kit tokens yet.

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
  - The nine component sheets (`windowing`, `fxGraph`, `fxGraphEffectPicker`, `clipControls`,
    `clipControlTuner`, `loopLab`, `EffectModule.sidechain`, `sandbox`, `designer`) are wrapped
    in-file in `@layer legacy { … }` because components import them from JS.
  - `@fontsource/*` sheets contain only `@font-face`, which is not part of the cascade.
  - **Known exception:** `components/debug/DebugCapturePanel.jsx` injects a `<style>` at
    runtime (unlayered, debug tool only). Do not copy that pattern.
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
`trackColorResolver.js`. The catalog's own defaults are **not** changed, because `xleth-warm`
and `xleth-cool` inherit them and must stay as they are. `xleth-light` overrides all 16 and is
untouched (it has the same five exclusion violations and fails the `ink`/`g1` label rule on 14
slots; fixing that is Phase 7).

The palette is generated against the *default* accent and is **not recomputed when a user
changes their accent**. Phase 7 adds a theme-editor warning for accent/identity hue clashes.

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

The kit tokens (`--ui-*`) follow the base tokens through `deriveTheme`, so for a tinted base
(warm, cool, an Appearance theme) they are tinted too, and for the shipped Light theme the
`ink-*` steps do not invert. **The kit is dark-only until Phase 7.**

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
  factor (`window:zoomIn/zoomOut`, 0.5 to 3.0 in `main.js`), which scales px uniformly, so no
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

## 11. Known gaps (deliberately out of scope for Phase 0)

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
- **Shots harness limits:** `npm run shots` (`tests/ui-render/shots.mjs`; `--label`, `--no-build`,
  `--compare A B`) runs without the engine
  (`window.xleth` absent) and covers chrome only. Anything needing live audio, video or the
  bridge must be checked in the real Electron app.

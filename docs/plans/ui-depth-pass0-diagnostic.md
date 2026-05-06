# UI Depth — Pass 0 Diagnostic

> Read-only audit. No source files were modified by Pass 0.
> Goal: identify exactly why Xleth's UI feels visually flat and define the
> token/elevation system the renderer needs **before** any Pass 1 styling
> work begins. FL Studio is treated as a directional reference for tactility
> only — Xleth's dark/cyan identity stays intact.

---

## 1. Executive summary

The UI is flat for these concrete reasons (each is cited in §3 / §5):

1. **Surfaces are differentiated only by background lightness.** Almost every container reads as "another dark rectangle on a slightly different dark rectangle." The token catalog has `--theme-bg-primary`, `--theme-bg-secondary`, `--theme-bg-tertiary`, `--theme-bg-surface`, `--theme-bg-elevated`, `--theme-bg-hover`, `--theme-bg-active`, `--theme-bg-inset` (8 levels), and `1px solid var(--theme-border-subtle)` is doing all the work that elevation, top-highlight, and inner-shadow should be doing.
2. **No top-highlight / sheen / bevel tokens exist anywhere.** Across 519 tokens (36 subsystems) there is no `--*-top-highlight`, `--*-bevel`, `--*-inner-shadow`, `--*-recessed`, or `--*-raised`. The only depth-tokenised primitives are 6 shadow strings ([catalog.ts:312–340](ui/src/theming/tokens/catalog.ts), [xleth-default.json:19–24](ui/src/theming/shipped/xleth-default.json)), all of them outer drop shadows in 0.5–0.6 black.
3. **The two big editor canvases (Timeline, Piano Roll) draw flat fills with no inset shading.** Lanes, clips, notes, velocity bars are all `fillRect()` of a solid colour with optional alpha modulation — no gradient, no inner shadow, no top highlight. Selection state = bump alpha 0.6→0.8 and lineWidth 1→2. See [timelineDrawing.js:305–313](ui/src/components/timeline/timelineDrawing.js) and [PianoRollCanvas.jsx:39–140](ui/src/components/pianoRoll/PianoRollCanvas.jsx).
4. **Floating panels are visually identical whether focused or not, except for a 1px border colour swap.** [windowing.css:78–98](ui/src/windowing/components/windowing.css) — `is-focused` only changes `border-color` from `--theme-border-subtle` to `--theme-border-focus`. There's no shadow strengthening, no top highlight, no opacity dimming on idle panels. Multiple floating panels read as one big flat sheet.
5. **Toolbars / titlebars / panel headers all use the same `--theme-bg-secondary` background.** [app.css:872–882, 1606–1614, 1769–1777, 5780–5787, 6001–6010, 6259–6266](ui/src/styles/app.css). The titlebar, the timeline toolbar, the piano-roll toolbar, the mixer toolbar, and the center-tabs strip are all the same flat `bg-secondary`. There is no "raised toolbar" treatment — the only thing separating them is a 1px bottom border.
6. **Buttons / tabs / track controls have only colour-shift states; nothing reads as physically depressible.** Mute/solo/visual-only buttons, picker buttons, mixer faders, snap selectors — all default to transparent / `bg-surface`, hover bumps the border colour, active swaps to a tinted background. No pressed-in inner shadow, no top edge highlight, no chromatic accent ring. See `track-header-btn` ([app.css:2047–2090](ui/src/styles/app.css)) and `mixer-toolbar-btn` ([app.css:6280–6299](ui/src/styles/app.css)).
7. **Editor canvases sit in containers with no recessed/well treatment.** The Piano Roll velocity lane gets its only depth cue from a darker `--theme-pianoroll-key-black-bg` fill plus a 1px top border ([VelocityLane.jsx:121–138](ui/src/components/pianoRoll/VelocityLane.jsx)). The timeline canvas area has no inner shadow, no inset border, no gutter. The video-canvas-wrapper ([app.css:1574–1590](ui/src/styles/app.css)) is just a flat rectangle.
8. **Active accent rarely has a "glow" — just an outline or a colour swap.** `--theme-focus-ring` resolves to `rgba(51,206,214,0.15)` ([derivation.ts:198](ui/src/theming/tokens/derivation.ts)) which is used as a background tint, not a shadow. There's no `box-shadow: 0 0 N var(--accent)` anywhere except one isolated case in the Resonance Suppressor mockup (line 12174). Selection on tracks / clips / notes never glows.

---

## 2. File / component map

The token plumbing already exists; the gap is **what tokens exist for** rather than **whether tokens are wired up**. All renderer styling lives in three places:

| File | Lines | UI area | Why it matters for depth |
|---|---|---|---|
| [ui/src/styles/app.css](ui/src/styles/app.css) | 12,427 | Single global stylesheet for the whole renderer | Every panel, control, dialog, plugin UI is styled here. There is no per-component CSS module. Pass 1 will add tokens at the top and update class blocks here. |
| [ui/src/windowing/components/windowing.css](ui/src/windowing/components/windowing.css) | 463 | Floating-panel frame, dock regions, titlebars, top-bar toggles | Owns `.xleth-panel-frame`, the only place chrome-shadow is applied to floating panels. Focused vs unfocused logic lives here. |
| [ui/src/plugin-ui/designer/styles/designer.css](ui/src/plugin-ui/designer/styles/designer.css) | n/a | Plugin Designer (out of scope for Pass 1) | Self-contained; do not touch. |
| [ui/src/theming/tokens/catalog.ts](ui/src/theming/tokens/catalog.ts) | 79kB / ~519 tokens | Token registry — declares every `--theme-*` and where it derives from | Pass 1 adds new elevation/inset/highlight tokens here. |
| [ui/src/theming/tokens/base.ts](ui/src/theming/tokens/base.ts) | 37 | The 5 user-editable base tokens | Stays untouched — depth tokens derive from these, they don't expand them. |
| [ui/src/theming/tokens/derivation.ts](ui/src/theming/tokens/derivation.ts) | 240 | `deriveTheme()` formulas | Likely site for new derived `*-elev-{0..3}-bg` and `*-inner-shadow` formulas. |
| [ui/src/theming/runtime/applyTheme.ts](ui/src/theming/runtime/applyTheme.ts) | 97 | Resolves tokens and writes `:root` style props | No changes needed — adding tokens flows through automatically. |
| [ui/src/theming/runtime/ThemeProvider.tsx](ui/src/theming/runtime/ThemeProvider.tsx) | 148 | React provider, mounted at app root in `main.jsx` | Active. New tokens land via the same pipeline. |
| [ui/src/theming/shipped/xleth-default.json](ui/src/theming/shipped/xleth-default.json) | 73 | The shipped default theme. Contains explicit shadow strings | Where new explicit shadow / inset / highlight string tokens are likely to live until they're parameterised. |

**Canvas-rendered surfaces** (CSS cannot affect their interior — depth must be drawn in JS):

| File | What it draws | Implication for depth |
|---|---|---|
| [ui/src/components/timeline/timelineDrawing.js](ui/src/components/timeline/timelineDrawing.js) | Ruler, lanes, clips, beat/bar grid, fades, playhead, drop preview | Pass 2 will need to add gradient stops / inset rectangles inside the canvas paint code. CSS has no purchase here. |
| [ui/src/components/pianoRoll/PianoRollCanvas.jsx](ui/src/components/pianoRoll/PianoRollCanvas.jsx) | Grid lines, notes (rect), selection rect, slide stroke | Same story: depth comes from extra `fillRect`/`strokeRect` calls keyed on new tokens. |
| [ui/src/components/pianoRoll/PianoRollKeyboard.jsx](ui/src/components/pianoRoll/PianoRollKeyboard.jsx) | Per-key DOM strip (left rail) | DOM-rendered, so CSS can add bevel/highlight here. |
| [ui/src/components/pianoRoll/VelocityLane.jsx](ui/src/components/pianoRoll/VelocityLane.jsx) | Bottom velocity bars | Canvas; depth = JS. |
| [ui/src/components/timeline/TimelineRuler.jsx](ui/src/components/timeline/TimelineRuler.jsx) | Ruler shell + DOM playhead element | DOM playhead can take a `box-shadow` glow without touching the canvas. |
| [ui/src/components/SamplePicker/WaveformScrubber.jsx](ui/src/components/SamplePicker/WaveformScrubber.jsx) (referenced) | Picker waveform | Canvas; depth = JS. |
| [ui/src/utils/waveformRenderer.js](ui/src/utils/waveformRenderer.js) | Waveform paint helper | Canvas; depth = JS. |

**Important non-canvas surfaces** (Pass 1 reaches all of these via CSS):

| Component | Class / file | Notes |
|---|---|---|
| App shell + titlebar | `.app`, `.titlebar`, `.titlebar-*` ([app.css:854–1019](ui/src/styles/app.css)) | Frameless Electron titlebar; very flat. Window controls have only hover background. |
| Center tabs (Timeline / Piano Roll switch) | `.center-tabs`, `.center-tab` ([app.css:5780–5856](ui/src/styles/app.css)) | Active tab is just `color: accent` + 2px border-bottom. No pressed/raised distinction. |
| Floating panel frame | `.xleth-panel-frame` ([windowing.css:78–98](ui/src/windowing/components/windowing.css)) | Has `--theme-chrome-shadow` but no top-highlight or focused-glow. |
| Top bar toggles | `.xleth-top-bar-*` ([windowing.css:340–462](ui/src/windowing/components/windowing.css)) | Buttons feel like flat icon strips — no tactile press state. |
| Mixer strips, faders | `.mixer-*` ([app.css:6259–6534](ui/src/styles/app.css)) | Faders are critical: groove + thumb both flat, no inset groove, no highlighted thumb. |
| Track headers (timeline) | `.track-header*` ([app.css:1965–2123](ui/src/styles/app.css)) | Mute/solo/visual buttons rely entirely on tinted backgrounds + 0.5px border. |
| Pattern list panel | `.pattern-list-*` ([app.css:1734–1918](ui/src/styles/app.css)) | The only "list-style" surface in the app — flat-stacked rows, no depth between rows. |
| Project Media / Sample Selector | `.video-preview`, `.source-list`, `.source-card`, `.import-drop-zone`, `.sample-row` ([app.css:1296–3300](ui/src/styles/app.css), and `ProjectMediaTab.jsx`, `SamplePicker.jsx`) | Card-like rows with no card chrome. The drop zone has dashed border + accent tint — only place that already feels designed. |
| Context menus / dropdowns | `.context-menu`, `.titlebar-dropdown` ([app.css:3047–3090, 928–974](ui/src/styles/app.css)) | Already use `--theme-bg-elevated` + a hardcoded `box-shadow: 0 8px 24px rgba(0,0,0,0.5)`. Two of the few hardcoded shadows in the file. |
| Modals / dialogs | `.confirm-dialog`, `.modal-*`, `.syllable-splitter-modal` ([app.css:6168–6248, 5647–5672, etc.](ui/src/styles/app.css)) | Use `--theme-modal-shadow` / `--theme-chrome-shadow`. No top-highlight; the modal sits on the dim overlay with no chrome distinction beyond border + outer shadow. |
| Plugin UI containers | `.fx-plugin-*`, `.eq-*`, `.dyn-*`, `.dist-*` ([app.css:7218–11393, etc.](ui/src/styles/app.css)) | These already use `--theme-fx-plugin-shadow` and a `-top` companion shadow, so they have *some* depth. The rest of the app does not match this. |

---

## 3. Current depth audit

Read alongside §1. Section-by-section observations.

### 3.1 App shell

[app.css:854–866, 31–40](ui/src/styles/app.css)

```css
html, body, #root { background: var(--theme-bg-primary); ... }
.app { background: var(--theme-bg-primary); }
.app-body { /* nothing */ }
```

`bg-primary = #0A0A0F`. The shell is one continuous black rectangle that the panel system overlays. It feels flat because it **is** flat — there's nothing to give it spatial structure other than panel borders, which are 1px subtle. There's no global "sheen" gradient like FL's titlebar gives, and the body has no boundary cue with the floating-work-area.

### 3.2 Main toolbar (titlebar + center tabs)

[app.css:872–1019, 5780–5856](ui/src/styles/app.css)

The frameless titlebar is `bg-secondary` with a 1px `border-bottom`. Logo, menus, project name, window controls. Menu triggers and window controls **only** change `background: var(--theme-bg-surface)` on hover — there is no pressed state at all (the close button gets `bg: var(--theme-danger)`).

Center tabs: active state is `color: var(--theme-accent)` plus a 2px `border-bottom-color: var(--theme-accent)`. Visually subtle; it does not look like a depressible chrome tab. No top highlight, no shading.

`xleth-top-bar-toggles` ([windowing.css:340–462](ui/src/windowing/components/windowing.css)) is the same pattern — toggle buttons have a 2px focused underline on `[data-focused="true"]` but no other depth.

### 3.3 Floating panels / windows

[windowing.css:78–98](ui/src/windowing/components/windowing.css)

```css
.xleth-panel-frame {
  background: var(--theme-bg-surface);
  border: 1px solid var(--theme-border-subtle);
  border-radius: var(--theme-chrome-border-radius);
  box-shadow: var(--theme-chrome-shadow);
}
.xleth-panel-frame.is-focused { border-color: var(--theme-border-focus); }
```

`--theme-chrome-shadow = 0 12px 40px rgba(0,0,0,0.6)` — an outer drop shadow only. **No top inner highlight**, **no glow on focus**, **no opacity dim on idle panels**. With multiple panels open the shadows overlap and disappear into the background.

The titlebar inside a floating panel ([windowing.css:117–144](ui/src/windowing/components/windowing.css)) only changes the accent-bar opacity and the `.xleth-windowing-focus-underline` opacity on focus. The titlebar itself doesn't darken/lighten.

### 3.4 Piano Roll

[app.css:5946–6094, 5859–5944](ui/src/styles/app.css), [PianoRollCanvas.jsx:39–140](ui/src/components/pianoRoll/PianoRollCanvas.jsx), [PianoRollKeyboard.jsx](ui/src/components/pianoRoll/PianoRollKeyboard.jsx), [VelocityLane.jsx:121–138](ui/src/components/pianoRoll/VelocityLane.jsx)

- Toolbar: `bg-secondary` + 1px border-bottom. Same as every other toolbar.
- Floating-card variant (`.piano-roll-floating`): hardcoded `background: #111118`, `border: 1px solid var(--theme-border-subtle)`, `box-shadow: var(--theme-chrome-shadow)`. Titlebar uses a vertical gradient `linear-gradient(to bottom, var(--theme-bg-surface), var(--theme-bg-tertiary))` ([app.css:5878](ui/src/styles/app.css)) — a rare gradient, but only here. **This is the model the rest of the app is missing.**
- Canvas: 3 stacked canvases. Background fill is `--theme-pianoroll-grid-bg = #111118`; black-key rows are `--theme-pianoroll-key-black-bg = #0A0A10`; white-key rows are `--theme-pianoroll-key-white-bg = #15151C`. Grid lines are `subdivision-line` / `beat-line` / `bar-line` painted at ~0.06 alpha. Notes are flat `fillRect` of the palette colour; selected notes get a brighter outline. **Zero shading.**
- Keyboard rail: per-key DOM divs, hardcoded `#2a2a34` for white, `var(--theme-bg-surface)` for black, `borderBottom 1px`. No bevel between keys.
- Velocity lane: dark canvas + 1px top border, gives a *very* faint recessed feel — but no inner shadow, no gradient, no separator gutter.

### 3.5 Timeline

[app.css:1596–2300](ui/src/styles/app.css), [timelineDrawing.js:305–313, 67–132, 465–497, 900–906](ui/src/components/timeline/timelineDrawing.js), [TimelineRuler.jsx](ui/src/components/timeline/TimelineRuler.jsx)

- Toolbar: `bg-secondary` + 1px border-bottom. Same as everywhere.
- Pattern list panel (left): 140px column, `bg-secondary`, 1px right border. Pattern rows have no card chrome — just text + a 6×12px swatch + a 2px `border-left: transparent` that lights up on hover.
- Track header column: same `bg-secondary`. Track headers have a 3px `track-header-color` strip on the left and a 3px `track-header-focus-bar` strip when active. Mute/solo/visual buttons are 22×22 squares with a 0.5px border that only changes colour on hover/active.
- Canvas area: 3 stacked canvases. Lanes are drawn flat. Pattern lanes get a 4% opacity tint (`--theme-timeline-pattern-lane-tint`). Regular lanes do not alternate. Bar lines are `fx-surface-tint-medium`, beat lines `rgba(255,255,255,0.06)`. Clips are `hexToRgba(hex, 0.6)` solid fills + 1px stroke; selection bumps to `0.8` and 2px stroke. No shadow, no gradient, no top-highlight.
- Playhead: 1px canvas line + a 2px DOM `<div>` of `var(--theme-border-focus)`. No glow, no caret bevel.
- Horizontal scrollbar (`.timeline-scrollbar`): 6px thumb, flat fill that brightens on hover and turns accent on active. No groove, no shadow.

The grid looks like wallpaper because nothing on the canvas has chrome — clips don't read as resting *on* the lane, they read as painted *into* the same plane.

### 3.6 Preview panel

[app.css:1437–1590](ui/src/styles/app.css), [VideoPreview.jsx:437](ui/src/components/VideoPreview.jsx)

`.video-preview` is `bg-secondary`. The header is unstyled (transparent on `bg-secondary`). `.video-canvas-wrapper` is `--theme-preview-loaded-bg` with no border, no inset, no letterbox cue. The actual `<canvas>` is `bg-primary` underneath the `object-fit: contain` video. There is **no recessed well** for the video — it sits on the same plane as the toolbar above it.

The grid editor overlay (`.grid-editor-overlay`, [app.css:3737–3930](ui/src/styles/app.css)) does add depth via dashed borders + a faint crosshair + half-line gradients, but only when the overlay is active.

### 3.7 Sample Selector / Project Media browser

[app.css:1296–1595, 3093–3300, 3327–3711](ui/src/styles/app.css), `SamplePicker.jsx`, `ProjectMediaTab.jsx`, `SourceCard.jsx`, `ImportDropZone.jsx`

The sidebar is **not** placeholder-flat; it is intentionally minimal. Highlights:

- Source list rows: thumbnails (80×45) + filename + meta. Hover shifts background to `bg-surface`. No card chrome, no shadow.
- Sample group headers: chevron + name + hover background. Flat rows.
- Sample rows: hover `bg-surface`, active `bg-elevated`. No selected-row ring or accent stripe.
- Marked samples list: clean, with label colour dots and metadata badges. Selected rows get `--theme-focus-ring` background — already a useful primitive.
- Import drop zone: dashed `2px var(--theme-accent)` border + `var(--theme-accent-bg-subtle)` background when dragging. **Already feels tactile** — this is a model worth replicating elsewhere.
- Picker controls (play / set in / set out / label): all use `picker-btn` — `bg-surface` + 1px border + `bg-elevated` on hover. The "active" play state already uses a focus-ring background plus an accent border, which is the closest thing in the app to a "depressed" look.

The browser is the most coherent surface in the app. It just doesn't look raised relative to the editors next to it.

### 3.8 Track headers and controls

[app.css:1965–2123](ui/src/styles/app.css)

Each track-header-btn is:

```css
width: 22px; height: 22px;
border: 0.5px solid var(--theme-border-subtle);
background: transparent;
```

Active states tint the background and the border colour. There is **no inner shadow, no top highlight, no pressed transform**. The buttons feel like coloured stickers, not switches. Mute (red), solo (amber), visual-only (teal) are colour-correct but not tactile.

The 3px `track-header-focus-bar` left-edge strip is the only "selected track" cue, and it competes with the 3px `track-header-color` strip already on the left.

### 3.9 Tabs / dropdowns / buttons / window controls

- Center tabs ([app.css:5780–5856](ui/src/styles/app.css)): hover = 2% white tint on background, active = accent text + 2px accent border-bottom. Flat.
- Titlebar dropdown ([app.css:930–974](ui/src/styles/app.css)): `bg-elevated` + 1px subtle border + hardcoded `box-shadow: 0 8px 24px rgba(0,0,0,0.5)`. One of three hardcoded shadow strings in the file ([line 939](ui/src/styles/app.css)).
- Context menu: same pattern as titlebar dropdown ([app.css:3047–3056](ui/src/styles/app.css)) — same hardcoded shadow.
- Mixer toolbar buttons ([app.css:6280–6299](ui/src/styles/app.css)): hover = accent border + accent text + `accent-bg-subtle` background. Same pattern repeated app-wide.
- VST browser buttons ([app.css:7133+](ui/src/styles/app.css)): `bg-surface` + 1px border + accent on hover.
- Window controls (`titlebar-btn` 46×32px): only `bg-surface` on hover.

The pattern across the app: **no button anywhere uses a real "depressed" treatment** (top inner shadow + bottom highlight). Pressed = colour swap.

---

## 4. Existing token / style inventory

Authoritative count: **519 tokens across 36 subsystems** in [catalog.ts](ui/src/theming/tokens/catalog.ts), all resolved by [applyTheme.ts](ui/src/theming/runtime/applyTheme.ts) at runtime via [ThemeProvider](ui/src/theming/runtime/ThemeProvider.tsx).

### 4.1 Surface tokens (already present)

```text
--theme-bg-primary    #0A0A0F   base
--theme-bg-secondary  derived   primary  + 3.14% L, -2.93% S  → #111118
--theme-bg-tertiary   derived   primary  + 4.8%  L
--theme-bg-surface    #1A1A24   base
--theme-bg-hover      derived   surface  + 4%   L
--theme-bg-active     derived   surface  + 8%   L
--theme-bg-elevated   derived   surface  + 3.92% L, +0.94% S  → #222230
--theme-bg-inset      #0d0d14   explicit
```

Eight levels but no semantic mapping to "raised toolbar", "floating panel surface", "recessed editor well", "pressed control well". Pass 1 needs to assign these (or new ones) by **role**, not by **L value**.

### 4.2 Border tokens (already present)

```text
--theme-border-subtle  derived  text  -72.75% L, +2.09% S  → #2A2A38
--theme-border-strong  derived  rgba(text, 0.25)
--theme-border-focus   = --theme-accent
--theme-border-default referenced in scrollbar / picker code; resolves via catalog
```

`border-subtle` does ~80% of the borders in the app. There is no "top highlight border" token (something like a `--theme-border-top-highlight` at `rgba(255,255,255,0.04)`).

### 4.3 Shadow tokens (already present, but only outer)

From [xleth-default.json:19–24, 71](ui/src/theming/shipped/xleth-default.json):

```text
--theme-chrome-shadow         0 12px 40px rgba(0, 0, 0, 0.6)
--theme-modal-shadow          0 12px 40px rgba(0, 0, 0, 0.6)
--theme-projectmedia-shadow   0 8px 32px  rgba(0, 0, 0, 0.5)
--theme-fx-plugin-shadow      0 8px 32px  rgba(0, 0, 0, 0.5)
--theme-fx-plugin-shadow-top  0 -4px 24px rgba(0, 0, 0, 0.5)
--theme-toast-shadow          0 6px 20px  rgba(0, 0, 0, 0.5)
```

Plus `--theme-contextmenu-shadow` referenced in catalog. **No inner shadow tokens, no glow tokens, no top-highlight tokens.**

### 4.4 Hardcoded values still scattered through `app.css`

Quick counts across [ui/src/styles/app.css](ui/src/styles/app.css):

- 109 hardcoded `#xxxxxx` hex literals (some intentional — band colours, label colours that are off the theme system).
- 31 `rgba(255, 255, 255, …)` literals (top highlights / tints).
- 27 `rgba(0, 0, 0, …)` literals (shadow colours / overlay tints).
- 3 hardcoded outer drop shadows: `box-shadow: 0 8px 24px rgba(0,0,0,0.5)` ([line 939](ui/src/styles/app.css), [line 3054](ui/src/styles/app.css)) and a few dialog/dock equivalents ([4467, 5447, 6688, 7695, 7980, 8240, 8347, 8492, 8811, 8950, 9552, 10085](ui/src/styles/app.css)). Most plugin UIs use `--theme-fx-plugin-shadow-top` correctly; these are stragglers.
- 1 `box-shadow: inset 0 1px 0 rgba(255,255,255,0.04)` at [line 12282](ui/src/styles/app.css) (inside the Resonance Suppressor mockup) — the **only** inner top-highlight in the entire app. This should become the model for a depth token.
- 1 `box-shadow: 0 0 26px rgba(82,229,255,0.28)` at [line 12174](ui/src/styles/app.css) — the **only** accent glow in the app. Same: model for a token.
- A handful of vertical gradients on the piano-roll floating titlebar ([5878](ui/src/styles/app.css)), GR meters, and SmartBalance bands. None are doing global "raised surface" duty.

### 4.5 Layout / timing primitives (kept, not theme tokens)

[app.css:4–21](ui/src/styles/app.css):

```css
--titlebar-h:   32px;
--transport-h:  48px;
--panel-min-w: 250px;
--panel-max-w: 400px;
--divider-w:     4px;
--mixer-h:      400px;
--radius-sm: 4px;  --radius-md: 6px;  --radius-lg: 8px;
--transition-fast: 0.1s ease;
--transition:      0.15s ease;
```

These are correct as non-theme primitives and should not move into the catalog.

### 4.6 Naming convention already in use

- Foundations: `--theme-{bg,text,border,accent}-{role}[-{state}]`
- Subsystem tokens: `--theme-{subsystem}-{element}[-{state}]` — e.g. `--theme-pianoroll-grid-bg`, `--theme-timeline-clip-waveform-fg`, `--theme-fx-plugin-shadow-top`.
- Semantic alpha tints: `--theme-accent-bg-subtle`, `--theme-accent-bg-medium`, `--theme-semantic-danger-bg-subtle`, `--theme-semantic-warning-bg-subtle`.
- Surface tints: `--theme-fx-surface-tint-{subtle,medium,strong}`.
- Overlay scrim: `--theme-overlay-{subtle,medium,heavy}`.

Pass 1's elevation tokens should **slot into this scheme**, not invent a new one. Suggested new prefixes: `--theme-elev-{0..3}-{bg,border,top-highlight,inner-shadow,outer-shadow}`, plus `--theme-well-{bg,inner-shadow}` for recessed editor surfaces.

---

## 5. Flatness root causes (ranked)

Each cause is followed by the files that prove it, in order of impact.

### Cause 1 — Surfaces are differentiated only by lightness, never by chrome.

There is no top-highlight token, no inner-shadow token, no recessed-well token. Every "elevated" surface is just a slightly lighter rectangle.

> Files: [windowing.css:78–98](ui/src/windowing/components/windowing.css), [app.css:872–882, 1606–1614, 5780–5787, 6259–6266](ui/src/styles/app.css).

### Cause 2 — Editor canvases (Timeline, Piano Roll, Velocity, Waveform, Ruler) draw flat fills.

CSS will never reach inside them. Adding depth here is a code change to canvas paint code.

> Files: [timelineDrawing.js:305–313, 89–132, 465–497](ui/src/components/timeline/timelineDrawing.js), [PianoRollCanvas.jsx:39–140, 541–596](ui/src/components/pianoRoll/PianoRollCanvas.jsx), [VelocityLane.jsx:55–138](ui/src/components/pianoRoll/VelocityLane.jsx), [waveformRenderer.js](ui/src/utils/waveformRenderer.js).

### Cause 3 — Buttons / controls have only colour-shift state changes; nothing reads as physically depressible.

No top-edge highlight, no inner shadow on press, no chromatic accent ring on focus.

> Files: [app.css:2047–2090 (track header), 6280–6299 (mixer), 1495–1567 (preview), 3456–3497 (picker)](ui/src/styles/app.css), [windowing.css:366–462](ui/src/windowing/components/windowing.css).

### Cause 4 — Floating panels rely on a single outer drop shadow with no focus differentiation.

Multiple stacked panels become one big shadow that disappears into the background. Focused panel only changes border colour by 1px.

> Files: [windowing.css:78–98, 117–158](ui/src/windowing/components/windowing.css), [xleth-default.json:19](ui/src/theming/shipped/xleth-default.json).

### Cause 5 — Toolbars and titlebars all use the same `bg-secondary` plus 1px border — no tactile separation.

Stacked toolbars (titlebar → top-bar-toggles → center-tabs → timeline-toolbar) read as one continuous bar even though they are functionally distinct.

> Files: [app.css:872–882, 1606–1614, 1769–1777, 5780–5787, 6001–6010, 6259–6266](ui/src/styles/app.css).

### Cause 6 — No accent glow / focus halo anywhere except one mockup line.

Selected clips, selected notes, focused panels, active playheads — none of them glow. Selection is always border-colour-swap.

> Files: [PianoRollCanvas.jsx:131–135, 581–595](ui/src/components/pianoRoll/PianoRollCanvas.jsx), [timelineDrawing.js:305–313](ui/src/components/timeline/timelineDrawing.js), [windowing.css:91–93, 146–158](ui/src/windowing/components/windowing.css), [TimelineRuler.jsx](ui/src/components/timeline/TimelineRuler.jsx).

### Cause 7 — Editor canvases sit in containers without recessed framing.

Timeline canvas area, video-canvas-wrapper, piano-roll canvas wrapper — none has an inner shadow or inset border to give the canvas a "well" feel. Velocity lane is the closest, and even that is just a darker fill + 1px border.

> Files: [app.css:1574–1590, 2152–2257](ui/src/styles/app.css), [VelocityLane.jsx:121–138](ui/src/components/pianoRoll/VelocityLane.jsx).

### Cause 8 — Track / clip / row colour stripes do triple duty.

The 3px left strip is used simultaneously for "track colour", "selected track", "drag-over", and "visual-only mode". When more than one applies, the user can't tell which signal is firing.

> Files: [app.css:1965–2003 (track-header-color, focus-bar, visual-only), 1996–1999](ui/src/styles/app.css).

### Cause 9 — Hardcoded inset shadow + glow already exist as a mockup, but in only one place.

[app.css:12174, 12282](ui/src/styles/app.css) — the Resonance Suppressor mockup demonstrates exactly the depth language the rest of the app should have. It hasn't been generalised.

> File: [app.css:12123–12403](ui/src/styles/app.css).

---

## 6. Recommended depth system for Pass 1 (proposal — not implemented)

### 6.1 Design intent

Three tactile primitives, each derivable from the existing 5 base tokens:

1. **Raised surface** — toolbars, titlebars, control wells, header strips, focused floating panels. Reads as resting *on top of* the base surface.
2. **Recessed editor well** — timeline canvas area, piano roll canvas, velocity lane, waveform scrubber, video canvas. Reads as cut *into* the base surface.
3. **Floating surface** — modals, dropdowns, context menus, popovers, plugin windows, tooltips. Reads as floating *above* everything.

Plus three secondary primitives:

4. **Pressed control** — buttons / tabs / track buttons in active or pressed state. Reads as depressed below their default rest level.
5. **Active accent glow** — selected clip, selected note, focused panel, hover-pressed control. Reads as lit, not just bordered.
6. **Top highlight** — a single horizontal sheen at the top edge of any raised surface. Replaces today's reliance on `bg-secondary` to communicate "this is a separate plane".

### 6.2 Proposed token additions

Tokens are listed by the role they serve, not by hex value. Suggested defaults derive from the existing base palette so themes stay editable.

#### Elevation surfaces

```text
--theme-elev-0-bg                  ≡ --theme-bg-primary           (the base plane)
--theme-elev-1-bg                  ≡ --theme-bg-secondary         (toolbars, panel bodies)
--theme-elev-2-bg                  ≡ --theme-bg-surface           (raised cards, idle floating panel)
--theme-elev-3-bg                  ≡ --theme-bg-elevated          (focused floating panel, modals)

--theme-elev-1-top-highlight       inset 0 1px 0 rgba(255,255,255,0.04)
--theme-elev-2-top-highlight       inset 0 1px 0 rgba(255,255,255,0.06)
--theme-elev-3-top-highlight       inset 0 1px 0 rgba(255,255,255,0.08)

--theme-elev-1-border              ≡ --theme-border-subtle
--theme-elev-2-border              rgba(text, 0.10)
--theme-elev-3-border              ≡ --theme-border-strong

--theme-elev-1-outer-shadow        none
--theme-elev-2-outer-shadow        0 4px 12px rgba(0,0,0,0.35)
--theme-elev-3-outer-shadow        ≡ --theme-chrome-shadow        (already exists)
```

#### Recessed wells (editor canvases)

```text
--theme-well-bg                    ≡ --theme-bg-inset             (#0d0d14)
--theme-well-inner-shadow          inset 0 2px 4px rgba(0,0,0,0.45),
                                   inset 0 0 0 1px rgba(0,0,0,0.30)
--theme-well-top-shadow            inset 0 4px 8px rgba(0,0,0,0.35)
--theme-well-border                rgba(0,0,0,0.5)
```

#### Floating surface

```text
--theme-floating-bg                ≡ --theme-bg-elevated
--theme-floating-border            ≡ --theme-border-subtle
--theme-floating-shadow            ≡ --theme-chrome-shadow
--theme-floating-top-highlight     inset 0 1px 0 rgba(255,255,255,0.06)
--theme-floating-focused-shadow    0 0 0 1px var(--theme-accent),
                                   0 12px 40px rgba(0,0,0,0.6)
--theme-floating-focused-glow      0 0 24px rgba(accent, 0.18)
--theme-floating-idle-opacity      0.92
```

#### Pressed / depressed control

```text
--theme-pressed-bg                 ≡ --theme-bg-active
--theme-pressed-inner-shadow       inset 0 1px 2px rgba(0,0,0,0.45)
--theme-pressed-border             rgba(0,0,0,0.40)
```

#### Selected / accent glow

```text
--theme-accent-glow-subtle         0 0 8px  rgba(accent, 0.20)
--theme-accent-glow-medium         0 0 16px rgba(accent, 0.28)
--theme-accent-glow-strong         0 0 26px rgba(accent, 0.35)   ≡ existing 12174 hardcode
--theme-accent-ring                0 0 0 1px var(--theme-accent)
--theme-accent-halo                0 0 0 2px rgba(accent, 0.20),
                                   0 0 0 1px var(--theme-accent)
```

These names follow the existing convention (`--theme-{role}-{element}-{state}`), do not require new base tokens, and have no impact on dimensions / spacing / typography.

### 6.3 Theme-file shape (illustrative, not implemented)

Once the catalog adds the tokens above, the shipped default in [xleth-default.json](ui/src/theming/shipped/xleth-default.json) gains a single new section:

```jsonc
{
  "tokens": {
    /* ...existing... */
    "--theme-elev-1-top-highlight":  "inset 0 1px 0 rgba(255,255,255,0.04)",
    "--theme-elev-2-top-highlight":  "inset 0 1px 0 rgba(255,255,255,0.06)",
    "--theme-elev-3-top-highlight":  "inset 0 1px 0 rgba(255,255,255,0.08)",
    "--theme-well-inner-shadow":     "inset 0 2px 4px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.30)",
    "--theme-floating-focused-glow": "0 0 24px rgba(51,206,214,0.18)",
    "--theme-accent-glow-medium":    "0 0 16px rgba(51,206,214,0.28)"
  }
}
```

---

## 7. Pass sequencing

Each pass is a single logical commit, gated on Playwright pixel-baseline approval (the existing `XLETH_PLAYWRIGHT=1` flow — see [playwright.config.ts](ui/playwright.config.ts) and the project memory for current baseline state).

### Pass 1 — **Tokenise depth primitives. Do not paint with them yet.**

**Goal**: extend the catalog with the tokens listed in §6.2. Do NOT update any `.css` selector to consume them. The shipped default theme produces visually identical output (acceptance bar: pixel-identical Playwright baselines).

**Touch**:
- [ui/src/theming/tokens/catalog.ts](ui/src/theming/tokens/catalog.ts) — add ~25 new token declarations under three new subsystems (`elevation`, `wells`, `floating`).
- [ui/src/theming/shipped/xleth-default.json](ui/src/theming/shipped/xleth-default.json) — add explicit defaults so the new tokens resolve.
- (Optional) `derivation.ts` — derive `*-top-highlight` and accent-glow strings from `--theme-text` / `--theme-accent` so non-default themes get sensible output.
- New test in [ui/src/theming/__tests__](ui/src/theming/__tests__/) — assert each new token resolves to a CSS string at `:root`.

**Avoid**:
- Do NOT modify any selector in `app.css` or `windowing.css`. Pass 1 must be a pixel-identical no-op.
- Do NOT modify base tokens or change the existing 5-base architecture.
- Do NOT touch any canvas paint code.
- Do NOT remove or rename the existing per-feature shadow tokens.

### Pass 2 — **Apply elevation tokens to the shell, panels, toolbars, modals, dropdowns.**

**Goal**: every non-canvas surface picks up the elevation system. Toolbars look raised; floating panels look *floating*; modals get a top highlight; dropdowns / context menus / tooltips share the floating-surface look. Editors stay flat (Pass 3).

**Touch**:
- [ui/src/styles/app.css](ui/src/styles/app.css) — `.titlebar`, `.timeline-toolbar`, `.piano-roll-toolbar`, `.mixer-toolbar`, `.center-tabs`, `.titlebar-dropdown`, `.context-menu`, `.confirm-dialog`, `.modal-*`, `.syllable-splitter-modal`, `.vst-browser`, `.video-preview` (header only), `.preview-pane`, `.preview-pane-label`, the small set of hardcoded `box-shadow: 0 8px 24px rgba(0,0,0,0.5)` lines.
- [ui/src/windowing/components/windowing.css](ui/src/windowing/components/windowing.css) — `.xleth-panel-frame`, `.xleth-panel-frame.is-focused`, `.xleth-windowing-titlebar`, `.xleth-top-bar-toggles`, `.xleth-windowing-control-button`.

**Avoid**:
- Editor canvas surfaces (`.timeline-canvas-area`, `.piano-roll-floating`, `.video-canvas-wrapper`, `.waveform-scrubber`).
- Any change to button / tab interaction states (Pass 4).
- Any change to layout, dimensions, or the 1px border widths.
- Any new outer drop shadow on currently shadowless panels — only convert existing shadows + add the inner top-highlight where the surface is meant to read as raised.

### Pass 3 — **Recess editor canvases. Add depth inside the canvas paint code.**

**Goal**: timeline lanes, piano-roll grid, velocity lane, waveform scrubber, and video preview all read as recessed wells. Clip/note rendering picks up a top-highlight stop and an alpha-fade bottom so they read as resting on the lane.

**Touch (CSS — for non-canvas portions)**:
- `.timeline-canvas-area`, `.piano-roll-floating`, `.video-canvas-wrapper`, `.waveform-scrubber`, `.preview-pane` — apply `--theme-well-inner-shadow` + `--theme-well-bg`.
- `.timeline-scrollbar`, `.piano-roll-scrollbar-*` — give scrollbars a recessed track.

**Touch (JS — for canvas-rendered depth)**:
- [ui/src/components/timeline/timelineDrawing.js](ui/src/components/timeline/timelineDrawing.js) — alternate lane shading via two new tokens (`--theme-timeline-lane-row-a-bg`, `--theme-timeline-lane-row-b-bg`); add a 1px top-highlight stripe on each clip; add a subtle bottom-shadow stripe; introduce `tokenValue('--theme-elev-1-top-highlight')` reads where applicable.
- [ui/src/components/pianoRoll/PianoRollCanvas.jsx](ui/src/components/pianoRoll/PianoRollCanvas.jsx) — same two-row alternation in pitch grid, top-highlight on notes; selected-note glow as a soft canvas radial gradient (cheap; one extra `fillRect` with composite mode).
- [ui/src/components/pianoRoll/VelocityLane.jsx](ui/src/components/pianoRoll/VelocityLane.jsx) — paint an inner shadow stripe at top of canvas instead of relying on `bg-color + 1px border`.
- [ui/src/utils/waveformRenderer.js](ui/src/utils/waveformRenderer.js) — gradient fill for waveform body so it reads as glass over the well.

**Avoid**:
- Do NOT change clip/note hit-test geometry — depth strokes must be drawn inside existing rect bounds.
- Do NOT introduce per-frame canvas filters / shadows — too expensive at scroll. Top-highlight is a single 1px `fillRect`, not `shadowBlur`.
- Do NOT change the playhead rendering path (TimelineRuler DOM div) in Pass 3 — that's Pass 4.

### Pass 4 — **Tactile control states + accent glow.**

**Goal**: every button, tab, fader, and selected element communicates its state via shape, not just colour. Mute/solo/visual track buttons feel like physical pads. Mixer fader thumb has a top highlight + bottom shadow. Center tabs have a pressed look in the active state. Playhead glows. Focused floating panel halos.

**Touch**:
- [ui/src/styles/app.css](ui/src/styles/app.css) — `.track-header-btn`, `.track-header-btn--mute/solo/visual`, `.mixer-ms-btn`, `.mixer-fader-thumb`, `.mixer-toolbar-btn`, `.timeline-tool-btn`, `.center-tab.active`, `.picker-btn`, `.picker-play-btn.active`, `.preview-fx-btn.active`, `.titlebar-btn`.
- [ui/src/windowing/components/windowing.css](ui/src/windowing/components/windowing.css) — `.xleth-windowing-control-button`, `.xleth-top-bar-toggle-btn[data-active]`, `.xleth-panel-frame.is-focused` (add focused glow).
- [ui/src/components/timeline/TimelineRuler.jsx](ui/src/components/timeline/TimelineRuler.jsx) — playhead `<div>` gets `box-shadow: var(--theme-accent-glow-subtle)`.
- [ui/src/components/pianoRoll/PianoRollKeyboard.jsx](ui/src/components/pianoRoll/PianoRollKeyboard.jsx) — bevel between keys via inset top highlight + bottom 1px shadow.

**Avoid**:
- Do NOT change keyboard shortcuts, ARIA roles, focus order, or hit areas.
- Do NOT add transitions longer than the existing `--transition` (0.15s ease) — slow transitions feel laggy on a DAW.
- Do NOT animate the playhead glow per-frame — single static `box-shadow` only.
- Do NOT touch plugin UIs (`.fx-plugin-*`, EQ-C, Resonance Suppressor) in Pass 4 — they already have their own depth system; integrating them is a future wave.

---

## 8. Risk list

| # | Risk | Where it bites | How Pass N prompts must guard against it |
|---|---|---|---|
| 1 | Inner shadows on canvas containers (`.timeline-canvas-area`) **don't appear inside the canvas**. CSS only paints around the canvas. | Pass 3 | Inner shadow goes on the *wrapper* div; canvas-side depth is drawn programmatically. Verify with a screenshot showing the inset visible at the canvas edge but not blurring playback. |
| 2 | Adding outer `box-shadow` to `.xleth-panel-frame` may overflow the dock-region clip and clip badly when panels are docked. | Pass 2 | Shadow only on `position: absolute` (floating) panels; check `.is-docked` selector explicitly excludes the new shadow. |
| 3 | Top-highlight insets on toolbars stack visually when two toolbars are adjacent (titlebar above timeline-toolbar). The eye sees a doubled rule. | Pass 2 | Either skip top-highlight on the bottom of two stacked bars or use `:first-child` / `:last-child` selectors to keep only the topmost one. |
| 4 | Per-frame canvas `shadowBlur` / `shadowColor` is expensive and will tank scroll FPS on the timeline. | Pass 3 | Forbid `ctx.shadowBlur`. Implement glow as a pre-multiplied gradient or extra translucent rect underneath. Verify with the existing perf regression timing in the Playwright suite. |
| 5 | The 3px `track-header-color` strip and the 3px `track-header-focus-bar` strip already overlap. Adding a focused-track glow on the right will make three signals fight. | Pass 4 | Pick *one* "selected track" cue. Suggested: replace the focus-bar with a track-row glow inside the canvas; drop the focus-bar `<div>` instead of stacking glow on top. |
| 6 | The Resonance Suppressor mockup ([app.css:12123–12403](ui/src/styles/app.css)) already uses its own depth language. If new global tokens override its hardcoded values it will lose its identity. | Pass 1, Pass 2 | Do not reach inside `.rs-*` selectors. Tokens are added globally; only selectors that already use the matching subsystem get rewritten. |
| 7 | Alpha tints on `bg-elevated` may push the text contrast under WCAG AA on the `Light` and `Cool` shipped themes (see `ui/src/theming/shipped/`). | Pass 2, Pass 4 | New token defaults are set in the *Default* dark theme; light/cool/warm themes get their own values via overrides. Pass 1 must verify each shipped theme still loads cleanly. |
| 8 | A new outer `box-shadow` on tabs / center-tabs intercepts pointer events at the bottom 2-4px and breaks the tab-close hover. | Pass 4 | Use `pointer-events: none` on the shadow pseudo (preferred) or test the close button hover after the change. |
| 9 | Mixer fader thumb (`.mixer-fader-thumb`) has `pointer-events: none` already, but its bounding box is 16×28. Adding inset shadow bumps perceived height; users can click "in" the new shadow zone. | Pass 4 | Verify groove hit area after change; the `cursor: ns-resize` is on `.mixer-fader`, not the thumb, so the shadow doesn't change behaviour, but visual alignment with the unity tick must be checked. |
| 10 | Catalog add-only constraint: the project has a strict no-mid-migration-rename rule (per memory + theming spec §3.3). New token names must be right the first time. | Pass 1 | Do a name review with a second eye before committing the catalog change. |
| 11 | The `--theme-bg-elevated` derived formula is empirically calibrated to ΔE=0 against the shipped anchor. Pass 2's use of elevated for floating panels means any future palette tweak ripples to every modal, dropdown, and panel. | Pass 1, Pass 2 | If you want floating panels independently tunable, alias them into a new explicit token in xleth-default.json instead of `ref`-ing `--theme-bg-elevated` directly. |
| 12 | Existing pixel-baseline tests (10 git-tracked baselines per memory) will diff on every Pass 2/3/4 commit. **Baselines should change deliberately, not opportunistically**. | All | Each pass updates baselines as part of the same commit, with a screenshot review note in the commit message. Never auto-update baselines to clear a CI failure. |

---

## 9. Success criteria for future implementation

### After Pass 1 — **no visual change**

- Pixel-identical screenshots vs. `main` branch.
- Playwright suite (31 tests; 19 pass / 0 fail / 10 known-skip per memory) still 19/0/10.
- New tokens appear at `:root` in DevTools (`getComputedStyle(document.documentElement).getPropertyValue('--theme-well-inner-shadow')` returns the expected string).
- `vitest` green for theming runtime.

### After Pass 2 — **shell + panels look layered**

- Titlebar + timeline-toolbar + piano-roll-toolbar each show a faint top-edge sheen — eye reads three planes, not one continuous bar.
- Floating panels (open the project media browser, the syllable splitter modal, the VST browser, the export dialog) each cast a distinct shadow against the work area.
- Focused floating panel has a visible accent ring + soft halo; idle panels are dimmer / shadow recedes.
- Modals look intentional rather than "another rectangle on top".
- Verification: open every modal in [ExportDialog.jsx](ui/src/components/ExportDialog.jsx), [SyllableSplitterModal.jsx](ui/src/components/SyllableSplitter/SyllableSplitterModal.jsx), [QuantizeDialog.jsx](ui/src/components/timeline/QuantizeDialog.jsx), [ConfirmConvertDialog.jsx](ui/src/components/timeline/ConfirmConvertDialog.jsx), [MissingPluginsDialog.jsx](ui/src/components/MissingPluginsDialog.jsx), [UnsavedChangesDialog.jsx](ui/src/components/UnsavedChangesDialog.jsx) — all read as floating.
- No layout shift: Playwright dimension assertions stay stable.

### After Pass 3 — **editors look like recessed wells**

- Timeline canvas reads as inset; clips look like they rest on lanes (top highlight, bottom shadow). Lane alternation is visible at the default zoom.
- Piano roll grid reads as inset; selected note has a soft accent glow inside the well.
- Velocity lane reads as a separate sub-well below the grid.
- Waveform scrubber and video canvas read as recessed.
- Verification: hover a clip, drag-select notes, scroll horizontally — depth must hold across viewport / DPR / theme.
- No FPS regression: time the existing scroll bench and compare before/after; budget < 5% FPS hit.

### After Pass 4 — **controls feel tactile**

- Mute / solo / visual-only track buttons look like real pads at rest, depressed when active.
- Mixer fader thumb has an upper highlight and a lower shadow — it reads as a knurled slider.
- Center tabs feel pressed in the active state.
- Playhead has a subtle accent glow.
- Focused floating panel halo (from Pass 2) integrates with the active-tab pressed state without colour clashes.
- Verification: capture screenshots of every button state matrix (default / hover / active / pressed / disabled) for the major surfaces.

### Universal acceptance bar (every pass)

- No change to: dimensions, spacing, fonts, transitions longer than 0.2s, z-index, hit-test areas, ARIA, keyboard navigation, engine code, bridge code, IPC, or rendering pipeline.
- All shipped themes (`xleth-default`, `xleth-light`, `xleth-cool`, `xleth-warm`) load without validation warnings.
- Diagnostic-only follow-up after each pass: a 5-bullet "what changed visually" note added to `docs/plans/` so the diff is auditable per pass.

---

*End of Pass 0 diagnostic.*

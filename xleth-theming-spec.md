# Xleth theming system architecture spec

**Version:** 1.1 (beta-blocking)
**Status:** spec approved, implementation pending
**Owner:** Krasen
**Scope:** Wave 0 of pre-beta polish. Infrastructure layer beneath the windowing spec — must ship before windowing Phase 1 so no hardcoded colors get retrofitted later. Covers every visible UI element in Xleth: chrome, workspace panels, all 16 stock effects, specialized editors, dialogs, and menus. No element is out of scope.
**Companion doc:** `xleth-windowing-spec.md` (depends on this)

---

## 1. Overview

Every color and chrome dimension used anywhere in Xleth becomes a theme token. Tokens resolve via CSS custom properties on `:root` and are edited through Settings → Theme, which opens a modal containing a Simple 5-knob editor, an Advanced per-token editor, a gradient editor supporting linear/radial/conic types, and a live preview pane. Themes serialize to human-readable JSON files and can be imported/exported freely, allowing Krasen and the community to publish "FL-feel" and "Vegas-feel" themes externally without Xleth taking on trademark exposure.

The theme system is foundational: it ships before the windowing system so that every panel, titlebar, accent bar, and chrome element in windowing is already token-driven from the first commit.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Scope for beta | Infrastructure + Simple editor + Advanced editor all before beta |
| Gradient types | Linear, Radial, Conic (all three) |
| Per-token gradient allowlist | Enforced — accents/borders/text stay solid; narrow chrome stays solid-or-linear; backgrounds accept any type |
| Editor location | Settings → Theme (modal-style overlay) |
| Live preview | Dedicated preview pane inside editor shows unsaved state; Apply commits globally |
| Contrast checker | None — users eyeball it |
| Shipped themes | Xleth Default (dark), Xleth Light, two unnamed inspiration themes (Warm, Cool) |
| Import/Export | JSON files, drag-drop supported, human-readable schema |
| Theme metadata | Name, author, description, version, schema version, base theme hint |
| Persistence | `userData/themes/<name>.json` files; active theme reference in `userData/settings.json` |
| Default theme | Locked (not editable). Users duplicate to customize. |

## 3. Token schema

### 3.1 Base tokens (Simple mode's 5)

These are the only tokens a Simple-mode user directly edits. Every other token in the system derives from these via the `deriveTheme()` pure function.

| Token | Role | Default value |
|---|---|---|
| `--theme-bg-primary` | Panel bodies, primary dark surface | `#0A0A0F` |
| `--theme-bg-surface` | Titlebars, toolbars, elevated surfaces | `#1A1A24` |
| `--theme-accent` | Focus indicators, active states, Xleth brand color | `#33CED6` |
| `--theme-text` | Primary text color | `#E8E8ED` |
| `--theme-danger` | Destructive actions, errors | `#FF4757` |

Values reflect Xleth's current palette (authoritative; §7.1 takes precedence over the illustrative values in earlier drafts of this document).

### 3.2 Derived tokens (auto-computed from base)

All derivations run in HSL space using a deterministic formula applied via `shift({ dL, dS, dH })`, which clamps S ∈ [0, 100] and L ∈ [0, 100]. Derivations are pure and testable.

**Calibration note:** the deltas below were empirically tuned against the Xleth Default palette (Phase 0 Track B) so every derived token resolves byte-identically to the hand-picked value in `ui/src/styles/theme.css`. Each formula is pinned to a ΔE2000 ≤ 1.0 assertion in `derivation.test.ts`. Themes that change base tokens will cascade through these formulas — the deltas are properties of the palette family, not of the specific base values.

**Background family:**
- `--theme-bg-secondary` = bg-primary shift(dL=+3.14, dS=−2.93)
- `--theme-bg-tertiary` = bg-primary shift(dL=+6)
- `--theme-bg-hover` = bg-surface shift(dL=+4)
- `--theme-bg-active` = bg-surface shift(dL=+8)
- `--theme-bg-elevated` = bg-surface shift(dL=+3.92, dS=+0.94)

**Text family** (solid L-shifts, not alpha — ensures the anchor reproduces exactly and the color is stable on every background):
- `--theme-text-muted` = text shift(dL=−33.92, dS=−0.98)
- `--theme-text-subtle` = text shift(dL=−55.29, dS=−3.10)
- `--theme-text-placeholder` = text shift(dL=−55.29, dS=−3.10)
- `--theme-text-inverse` = bg-primary (for use on bright backgrounds)

In the Xleth Default palette, `text-subtle` and `text-placeholder` resolve identically; user themes may diverge them independently by supplying explicit overrides for either.

**Border family:**
- `--theme-border-subtle` = text shift(dL=−72.75, dS=+2.09)
- `--theme-border-strong` = text at 25% alpha
- `--theme-border-focus` = accent at 100% alpha

**Semantic family:**
- `--theme-info` = accent (same as brand)

Note: `--theme-success` and `--theme-warning` are independent semantic colors and are no longer derived from accent. They ship as catalog explicit defaults; see §3.3. (Prior spec revisions had them as accent hue rotations of +100° / −120°, but those produced ΔE > 26 from the shipped anchors and were not useful.)

**Accent states:**
- `--theme-accent-hover` = accent shift(dL=−6.08, dS=−3.28) — deliberately *darker* than accent in the Xleth palette
- `--theme-accent-active` = accent shift(dL=+10)
- `--theme-focus-ring` = accent at 15% alpha

**Panel type colors** (hue-rotate from accent, 60° increments):
- `--theme-panel-mixer` = accent (hue +0°)
- `--theme-panel-timeline` = accent hue +60°
- `--theme-panel-pianoroll` = accent hue +120°
- `--theme-panel-preview` = accent hue +180°
- `--theme-panel-grid` = accent hue +240°
- `--theme-panel-node` = accent hue +300°

### 3.3 Chrome, layout, and independent semantic tokens

Tokens specific to the windowing system and panel chrome, applying across all subsystems. Also houses semantic tokens that are not derivable from the base palette and ship as catalog explicit defaults (Advanced-mode edit only — not in Simple mode's 5).

**Independent semantic colors** (explicit defaults, not accent-derived):
- `--theme-success` — default `#22C55E` (green)
- `--theme-warning` — default `#FFAA33` (orange)
- `--theme-drag-preview-default` — default `#6aa9ff` (blue). Drag-preview tint for pattern-list items and timeline drag shadows. In the semantic subsystem so any consumer can reference it.

These are deliberately chosen semantic hues. Accent-rotation formulas can't reproduce them at an acceptable ΔE for most palettes (success is ΔE=59 from a +100° rotation of the Xleth accent). Themes may override either independently via Advanced mode.

**Universal foundation additions** (base / text subsystem; kept separate from §3.1's 5-knob simple palette because they are purpose-specific):
- `--theme-fg-inverse` (base) — default `#ffffff`. Plain-white foreground for canvas strokes and text-on-dark markers regardless of accent rotation. Distinct from the deriveTheme-computed `--theme-text-inverse`, which is a tonal inverse of `--theme-text`.
- `--theme-bg-inset` (base) — default `#0d0d14`. Dark inset background for canvas panels intentionally darker than `--theme-bg-primary` (piano-roll body, mixer SmartBalance canvas).
- `--theme-text-on-accent` (text) — default `#0d0d14`. Contrast text color on accent/danger button backgrounds. Shares the raw value with `--theme-bg-inset` but carries a distinct "text on colored bg" semantic.


**Panel chrome:**
- `--theme-chrome-titlebar-bg` — gradient-capable
- `--theme-chrome-titlebar-fg`
- `--theme-chrome-titlebar-height` (default `28px`)
- `--theme-chrome-accent-bar-width` (default `3px`)
- `--theme-chrome-underline-thickness` (default `2px`)
- `--theme-chrome-border-radius` (default `4px`)
- `--theme-chrome-unfocused-opacity` (default `0.4`)
- `--theme-chrome-shadow` (default `0 12px 40px rgba(0, 0, 0, 0.6)`) — drop shadow on floating panel frames

**Top toolbar:**
- `--theme-toolbar-bg`, `-border`, `-fg`
- `--theme-toolbar-icon-open`, `-icon-hidden`, `-icon-hover-bg`, `-focus-indicator`

**Dock regions and snap:**
- `--theme-dock-divider`, `-divider-hover`, `-divider-active`
- `--theme-snap-ghost-fill` (default accent @ 18%), `-ghost-border`

### 3.4 Subsystem token catalogs

Every visible UI subsystem in Xleth has a dedicated token catalog. The spec below enumerates the categories and representative tokens per subsystem; the complete per-token enumeration lives in `src/theming/tokens/catalog.ts`, generated during Phase 0's codebase audit. Naming convention: `--theme-<subsystem>-<element>[-<state>]`.

**Total estimated tokens across all subsystems: ~250.** Most are derived from base or accent and require no user touching in Simple mode. Advanced mode exposes every one.

#### 3.4.1 Transport bar
Bar bg / border / fg. Playhead line color. Time display fg, BPM display fg, shortcut hint fg. Button states (bg, fg, hover, active, disabled) for play, stop, record, rewind, forward. Recording-state red indicator. Metronome toggle on/off. Output device selector bg/fg/hover.

#### 3.4.2 Menu bar and top toolbar
Menu bar bg. Menu item default fg, hover bg, active bg. Project title fg. Separator lines. Global action buttons (Undo, Redo, Import, Export, Save) — default/hover/active/disabled bg + fg.

#### 3.4.3 Context menus
Menu bg, border, shadow (optional). Menu item default bg, hover bg, selected bg, disabled bg. Menu item fg, muted fg, destructive fg (uses `--theme-danger`), icon fg. Separator line. Submenu indicator arrow. Checkmark/radio indicator.

#### 3.4.4 Dialogs, modals, popovers, tooltips
Backdrop semi-transparent overlay. Modal bg, border, title fg, body fg. Modal header divider line. Modal footer bg. Modal drop shadow (`--theme-modal-shadow`, default `0 12px 40px rgba(0, 0, 0, 0.6)`). Primary button (accent-colored), secondary button, destructive button — all states. Tooltip bg / fg / border / arrow. Popover bg / border.

#### 3.4.5 Generic buttons
Button bg / fg / border for default, hover, active, disabled, focused. Primary variant (accent-colored), secondary, destructive. Icon-only button styling. Toggle button on / off.

#### 3.4.6 Mixer
Channel strip bg. Channel divider. Channel name fg. Pan knob (track, fill, ring, label). Width knob (track, fill, label). Fader track, thumb, fill. Meter track, meter fill (gradient-capable — green→yellow→red by default), peak hold, clip indicator. Chain/Node toggle buttons. Effect chain slot bg, hover, drag handle, enable toggle. Add-effect button. Master channel distinct accent.

#### 3.4.7 Stock effects — shared primitives
Applies to all 16 effects (Xleth EQ, Compressor, Overdone, Limiter, Waveshaper, Distortion, Filter, Delay, Reverb, UniFlange, Chorus, Flanger, Phaser, Phanjer, Transient Processor, Smart Balance).

- Plugin window bg, border, titlebar bg, titlebar fg
- Bypass toggle off / on
- Preset selector bg / fg / hover
- Large knob (track, fill, ring, indicator, label, value display)
- Small knob (track, fill, label, value display)
- Slider (track, thumb, fill, label)
- Toggle switch (off, on, label)
- Display surface bg (for curves/visualizations)
- Display grid lines (major and minor)
- Axis labels fg
- Draggable handle default / hover / dragging / selected
- Subtle inset-panel tint (`--theme-fx-surface-tint-subtle`, default `rgba(255, 255, 255, 0.05)`). Carries `crossSubsystem: true` (§3.5.1) — used uniformly across FX UIs for inset surfaces.
- Readout text fg (value + unit suffix like "Hz" or "dB")
- Plugin window drop shadow (`--theme-fx-plugin-shadow`, default `0 8px 32px rgba(0, 0, 0, 0.5)`) — applied to all floating effect panels
- Active-drag stroke indicator (`--theme-fx-drag-indicator`, default `#FFFFFF`) — maximum-contrast stroke used when a handle is actively being dragged

#### 3.4.8 Stock effects — Xleth EQ unique tokens
Band fill colors (one per band, derived by hue-rotation from accent). Band handle default / hover / selected / dragging. Combined response curve stroke + fill. Pre-EQ spectrum (faded). Post-EQ spectrum. Octave grid lines. dB grid lines.

#### 3.4.9 Stock effects — Dynamics (Compressor, Limiter, Smart Balance, Transient Processor)
Transfer curve (input/output) stroke + fill. Threshold indicator line + label. Ceiling indicator (Limiter). Knee visualization. Gain reduction meter fg + peak line. Attack/release time indicators. Transient envelope curve (attack/sustain fills — Transient Processor). Stereo field visualization (Smart Balance): center dot, left field fill, right field fill, boundary lines.

#### 3.4.10 Stock effects — Filter unique tokens
Filter response curve stroke + fill. Cutoff frequency indicator line. Resonance peak marker. Filter type labels (LP, HP, BP, etc.).

#### 3.4.11 Stock effects — Modulation (Chorus, Flanger, Phaser, UniFlange, Phanjer)
LFO waveform visualization stroke. Phase position indicator. Depth fill. Rate indicator. Dry/wet mix indicator. Per-effect submix colors for Phanjer (chorus submix, flanger submix, phaser submix — distinct colors so users can see what's blending).

#### 3.4.12 Stock effects — Time (Delay, Reverb)
Delay tap visualization marks. Feedback loop indicator. Time division markers. Reverb impulse response waveform (primary + secondary). Damping curve. Pre-delay indicator.

#### 3.4.13 Stock effects — Distortion (Overdone, Waveshaper, Distortion)
Waveshape curve stroke + fill. Input signal overlay. Drive/amount indicator. Asymmetry indicator (Overdone).

#### 3.4.14 Piano roll
Grid bg. Bar lines, beat lines, subdivision lines (three separate tokens). Black key lane bg, white key lane bg. Key labels (C3, D3, etc.) fg. Note fill (derived from accent by default), note stroke, note selected, note hover. Note resize handles. `--theme-pianoroll-resize-handle-stripe` (default `rgba(255,255,255,0.25)`) — referenced by all four stops of the resize-handle linear-gradient. Slide note visual. Velocity bar fills + track bg. Playhead line. Loop marker region bg. Selection rectangle. Automation lane bg + grid. Automation point default / selected / hover. Automation curve stroke.

#### 3.4.15 Sampler UI
ADSR envelope bg, curve stroke, fill, drag handles. Sustain line. Tension indicator. LFO visualization bg, curve stroke. Sample waveform fg, bg, playhead. Trim handles (in/out). Loop markers + crossfade overlay. Pitch envelope curve. Portamento indicator. Arpeggiator pattern cells (active / inactive). Mono/poly toggle. Hann-window declick region overlay. Mini keyboard white key borders (`--theme-sampler-key-border`, default `#2A2A38`). Mini keyboard black key fill/border (`--theme-sampler-key-black`, default `#000000`).

Envelope fill is a ref to the shared waveform primitive: `--theme-sampler-envelope-fill` = `var(--theme-waveform-envelope-fill)` (was explicit `rgba(51, 206, 214, 0.08)` — drift; repointed to `rgba(51, 206, 214, 0.35)` via §3.4.26).

Per-tab LFO accent colors — ground truth at `LfoSection.jsx:5`. The previous catalog had `pitch` and `volume` values swapped and named the purple tab `filter` instead of the actual `pan`:
- `--theme-sampler-lfo-color-pitch` default `#E8A020` (was `#33CED6` — drift)
- `--theme-sampler-lfo-color-pan` default `#9B59B6` (was `--theme-sampler-lfo-color-filter` — rename)
- `--theme-sampler-lfo-color-volume` default `#33CED6` (was `#E8A020` — drift)
- `--theme-sampler-lfo-bg-pitch` default `#3C2E1A` (was `#1E3A3C` — drift)
- `--theme-sampler-lfo-bg-pan` default `#2A1E3A` (was `--theme-sampler-lfo-bg-filter` — rename)
- `--theme-sampler-lfo-bg-volume` default `#1E3A3C` (was `#3C2E1A` — drift)

The orphan token `--theme-sampler-lfo-fill` (`rgba(51, 206, 214, 0.08)`) was retired: `LfoWaveformCanvas.jsx` dynamically computes its envelope fill as `color + '18'` (alpha suffix), so no static rgba token maps to that callsite.

#### 3.4.16 Timeline
Ruler bg, bar-number fg, playhead marker. Track row alternating bg (optional). Track header bg + fg. Track color stripe. Mute/Solo button default + active. Clip bg (per-track color). Clip waveform fg + bg. Clip title fg. Clip volume/opacity handle. Fade in/out bezier curve fill. Fade bezier control-point handles: `--theme-timeline-bezier-handle-cp1` (default `#f59e0b`, amber) and `--theme-timeline-bezier-handle-cp2` (default `#3b82f6`, blue) — these are data-encoding colors and must remain visually distinct from each other in any theme. Empty region bg. Pattern clip bg (per-pattern color). Bar line, beat line, subdivision line. Playhead line. Loop brace. Selection rectangle. Automation lane (future). Section markers.

#### 3.4.17 Grid editor
Grid canvas bg. Cell bg (empty + occupied). Cell border, cell divider. Chorus layer overlay. Crash overlay. Grid Settings panel bg. Track card bg + border + hover. Bounce direction button states (↑↓←→ each as a separate active/inactive token). Corner radius slider (reuses generic). Custom Gap checkbox. Visual FX dropdown. Cell label text-shadow (`--theme-grid-editor-text-shadow`, default `rgba(0,0,0,0.8)`). Beat-grid crosshair line color (`--theme-grid-editor-crosshair`, default `rgba(255,255,255,0.15)`).

#### 3.4.18 Sample Selector
List bg. Item default / hover / selected bg. Category header bg + fg. Category color dots — one token per category (Kick, Snare, HiHat, Crash, Pitch, Quote, Custom, Perc — 8 tokens). Sample play button. Metadata fg (duration, source). Status chip bg + fg. Search input bg / fg / placeholder / border.

#### 3.4.19 Node Editor
Canvas bg. Grid overlay. Node bg + border + selected border. Node titlebar bg + fg. Port socket default / hover / connected. Connection line default / selected / hover. Connection colors per data type (audio, CV, event — 3+ distinct tokens). Selection rectangle. Zoom control bg + fg.

#### 3.4.20 Syllable Splitter
Modal bg. Waveform bg + fg. Marker line default / hover / dragging. Segment label bg + fg. Segment text input bg + fg + placeholder. Per-segment play button. Clear All button, Save button. Light accent variant (`--theme-syllable-accent-light`, default `#7ce9ef`) — lightened teal used for highlights; not derivable from `--theme-accent` via the standard `deriveTheme()` deltas. Canvas waveform color for inactive/dimmed regions (`--theme-syllable-splitter-wave-dim`, default `#3a3a4a`). Canvas label text fg (`--theme-syllable-splitter-label-fg`, default `#d0d0d8`) — intentionally dimmer than `--theme-text` because canvas text lacks subpixel anti-aliasing and reads brighter at the same value. Canvas background (`--theme-syllable-splitter-bg`, default `#1b1b24`) — a darker surface than `--theme-bg-primary`. Alternating section tint (`--theme-syllable-section-alt`, default `rgba(51, 206, 214, 0.06)`) — row striping in the syllable timeline.

#### 3.4.21 Lip Sync Picker
Video player bg + frame. Waveform fg + bg + playhead. In/Out marker lines. In/Out timecode display fg. Category dropdown. Sample name input. Add Sample button. Marked samples list bg + item bg + item hover. Count indicator chips. Waveform scrubber interaction states: selection region fill (`--theme-lipsync-selection-fill`, default `rgba(51, 206, 214, 0.15)`), in/out point handle color (`--theme-lipsync-handle`, defaults to `--theme-accent`). Waveform envelope fill and RMS body fill are shared primitives — see §3.4.26 (was `--theme-lipsync-playback-indicator` / `--theme-lipsync-scroll-thumb`, renamed to `--theme-waveform-envelope-fill` / `--theme-waveform-rms-body` and moved to `waveform-shared` because sampler, syllable splitter, and lip-sync picker all use identical values for the same roles).

#### 3.4.26 Waveform (shared)
Cross-subsystem primitives for waveform rendering, consumed by Sampler (§3.4.15), Syllable Splitter (§3.4.20), and Lip Sync Picker (§3.4.21). Envelope fill (`--theme-waveform-envelope-fill`, default `rgba(51, 206, 214, 0.35)`) — the filled area under the envelope curve. RMS body fill (`--theme-waveform-rms-body`, default `rgba(51, 206, 214, 0.55)`) — the brighter centerline body of waveform rendering. Both tokens carry `crossSubsystem: true` per §3.5.1 so an override of either propagates to every waveform consumer without per-subsystem re-authoring.

#### 3.4.22 Preview player
Player bg when video loaded. Player bg when empty (source-less state). FPS counter fg. Resolution readout fg. Zoom readout fg. Grid cell labels (overlaid on preview). "CHORUS" pill bg + fg. Edit Grid button, Import button, FX button — all states.

#### 3.4.23 Project Media / Sources
Panel bg + border. Tree item default / hover / selected. Folder icon, file icon, video icon, audio icon. Drag-drop highlight zone. Empty state bg + fg + CTA button. Add source button. Panel drop shadow (`--theme-projectmedia-shadow`, default `0 8px 32px rgba(0, 0, 0, 0.5)`).

#### 3.4.24 Pattern list sidebar
List bg. Pattern item default / hover / selected. Pattern color stripe (one token per pattern, 7+ by default — derived or explicit). Pattern name fg. Pattern bar count fg. Add pattern button.

#### 3.4.25 Toast notifications
Global UI subsystem. Toast notifications float above all content and must cast a visible shadow regardless of the current background theme. Single token: `--theme-toast-shadow` (default `0 6px 20px rgba(0, 0, 0, 0.5)`). Misclassification note: the audit scanner initially classified this under `dialogs-modals` due to selector proximity in `app.css`; it is a semantically distinct subsystem.

### 3.5 Gradient capability per token

Tokens fall into three capability classes, declared per-token in `src/theming/tokens/catalog.ts`:

**Any type (linear, radial, conic, or solid):** All `--theme-bg-*`, all `--theme-*-bg` tokens for large surfaces (modal, panel, canvas, preview player). `--theme-chrome-titlebar-bg`, `--theme-button-bg`, `--theme-meter-fill`, `--theme-waveform-fill`, `--theme-eq-response-fill`, `--theme-compressor-transfer-fill`.

**Linear or solid only:** Narrow-strip surfaces where radial/conic would render as near-solids. `--theme-knob-track`, `--theme-knob-fill`, `--theme-slider-track`, `--theme-slider-thumb`, `--theme-fader-fill`, `--theme-velocity-bar-fill`, `--theme-mixer-meter-fill`.

**Solid only:** All text tokens. All border tokens. All accent-bar tokens (narrow by definition). All panel-type color tokens. All dimension tokens. All curve-stroke tokens (gradients on 1–2px strokes render inconsistently across browsers).

The editor reads capability from `catalog.ts` and disables gradient-type tabs accordingly when the user clicks a token's Edit button. Attempting to load a theme JSON where a solid-only token has a gradient value triggers a validation warning and the gradient is discarded.

### 3.5.1 Cross-subsystem flag

A few subsystems — `waveform-shared` (§3.4.26), `stock-effects.shared` (§3.4.7) — exist to hold primitives that multiple other subsystems consume at identical values. Tokens in those subsystems may declare `crossSubsystem: true` in `catalog.ts`. The audit enrichment classifier's Gate 3 (subsystem scope) normally rejects a token whose subsystem differs from the match's subsystem unless that subsystem is in `UNIVERSAL_SUBSYSTEMS = {base, derived, borders, text, semantic, labels}`. The `crossSubsystem` flag is a per-token opt-in that bypasses the subsystem check for that specific token without widening `UNIVERSAL_SUBSYSTEMS`. Acceptance via the flag is recorded in the v2 enriched output as `gatesPassed: [..., 'subsystem:crossSubsystem']` so the audit trail distinguishes cross-subsystem assignments from same-subsystem ones.

### 3.6 Token value format

A token in a theme JSON file is either a solid color string or a gradient object.

Solid color:
```json
"--theme-bg-primary": "#0D0F13"
```

Color with alpha:
```json
"--theme-border-subtle": "rgba(228, 230, 234, 0.1)"
```

Linear gradient object:
```json
"--theme-chrome-titlebar-bg": {
  "type": "linear",
  "angle": 180,
  "stops": [
    { "position": 0, "color": "#1A1E26" },
    { "position": 100, "color": "#16191E" }
  ]
}
```

Radial gradient object:
```json
{
  "type": "radial",
  "shape": "circle",
  "center": { "x": 50, "y": 50 },
  "stops": [
    { "position": 0, "color": "#2A2F38" },
    { "position": 100, "color": "#0D0F13" }
  ]
}
```

Conic gradient object:
```json
{
  "type": "conic",
  "center": { "x": 50, "y": 50 },
  "startAngle": 0,
  "stops": [
    { "position": 0, "color": "#4AE3D0" },
    { "position": 50, "color": "#AFA9EC" },
    { "position": 100, "color": "#4AE3D0" }
  ]
}
```

At resolution time, gradient objects compile to CSS strings:
- Linear: `linear-gradient(180deg, #1A1E26 0%, #16191E 100%)`
- Radial: `radial-gradient(circle at 50% 50%, #2A2F38 0%, #0D0F13 100%)`
- Conic: `conic-gradient(from 0deg at 50% 50%, #4AE3D0 0%, #AFA9EC 50%, #4AE3D0 100%)`

Dimension tokens (e.g., `--theme-chrome-titlebar-height`) use plain CSS-unit strings: `"28px"`, `"0.4"`, etc. Validated at theme load time.

## 4. Theme JSON schema

```json
{
  "schemaVersion": 1,
  "name": "Xleth Default",
  "author": "Xleth",
  "description": "The stock dark theme.",
  "version": "1.0.0",
  "baseTheme": "dark",
  "locked": true,
  "tokens": {
    "--theme-bg-primary": "#0D0F13",
    "--theme-bg-surface": "#16191E",
    "--theme-accent": "#4AE3D0",
    "--theme-text": "#E4E6EA",
    "--theme-danger": "#E24B4A",
    "--theme-chrome-titlebar-bg": {
      "type": "linear",
      "angle": 180,
      "stops": [
        { "position": 0, "color": "#1A1E26" },
        { "position": 100, "color": "#16191E" }
      ]
    }
  },
  "derivationDetached": []
}
```

Fields:
- `schemaVersion`: integer, increments on breaking schema changes
- `name`: unique string identifier
- `author`: free-text
- `description`: free-text, single line
- `version`: semver for the theme itself
- `baseTheme`: `"dark"` or `"light"` — fallback hint if theme is incomplete
- `locked`: if true, theme is read-only (Xleth Default only)
- `tokens`: record of token name → value (solid or gradient object)
- `derivationDetached`: array of token names that have been manually set and should NOT be overwritten by `deriveTheme()`

Any token not present in `tokens` falls back to the result of `deriveTheme(baseTokens)`. A complete theme file lists only base tokens + detached overrides; incomplete themes are valid.

## 5. Theme editor architecture

### 5.1 Location and invocation

Settings menu → Theme section. Renders as a full-screen modal overlay over the main Xleth window. Dismissable via `Esc`, explicit Close button, or clicking the backdrop (with "Unsaved changes" confirmation if edits are pending Apply).

### 5.2 Modal layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ Theme editor                                              [× Close]   │
├────────────────┬──────────────────────────────┬─────────────────────┤
│                │                              │                      │
│  Themes        │  [ Simple ][ Advanced ]      │   Preview            │
│                │                              │                      │
│  ● Default 🔒  │  ┌────────────────────────┐  │  ┌────────────────┐ │
│    Light       │  │                        │  │  │                │ │
│    Warm        │  │   Editor content       │  │  │  Mini-Xleth    │ │
│    Cool        │  │                        │  │  │  preview       │ │
│    Custom 1    │  │                        │  │  │                │ │
│                │  │                        │  │  │                │ │
│  [+ New]       │  │                        │  │  │                │ │
│  [↓ Import]    │  │                        │  │  │                │ │
│                │  │                        │  │  └────────────────┘ │
│  [↑ Export]    │  │                        │  │                      │
│  [⎘ Duplicate] │  │                        │  │                      │
│                │  └────────────────────────┘  │                      │
├────────────────┴──────────────────────────────┴─────────────────────┤
│                                           [ Revert ]  [ Apply ]      │
└───────────────────────────────────────────────────────────────────────┘
```

Three columns: theme list (left), editor content (middle, tabbed), preview (right). Footer has Revert + Apply.

### 5.3 Simple mode content

Five stacked color inputs, each row: `[large swatch] [hex input] [open picker button]`. Clicking the swatch or picker button opens a color picker popover.

Below the 5 knobs, a dropdown:

**Panel color scheme:**
- Harmonic (default) — panel colors derive from accent via 60° hue rotation
- Monochromatic — all panel types use accent
- Custom — switches user to Advanced for panel color editing

### 5.4 Advanced mode content

Two sub-columns inside the middle column:

**Left: category tree.** Collapsible, scrollable. Top-level sections with nested subsystems:

- **Foundations**
  - Base (5)
  - Derived
  - Semantic (success/warning/danger/info)
  - Text
  - Borders
- **Window system**
  - Panel chrome
  - Top toolbar
  - Dock regions & snap
  - Panel types (6 panel-type colors)
- **Global UI**
  - Buttons
  - Dialogs, modals, tooltips
  - Context menus
  - Menu bar & toolbar
  - Transport bar
- **Workspace panels**
  - Timeline
  - Piano roll
  - Mixer
  - Sampler
  - Preview player
  - Grid editor
  - Sample selector
  - Project media / sources
  - Pattern list
  - Node editor
- **Stock effects**
  - Shared primitives (knobs, sliders, displays, handles)
  - Xleth EQ
  - Dynamics (Compressor, Limiter, Smart Balance, Transient Processor)
  - Filter
  - Modulation (Chorus, Flanger, Phaser, UniFlange, Phanjer)
  - Time (Delay, Reverb)
  - Distortion (Overdone, Waveshaper, Distortion)
- **Specialized editors**
  - Syllable Splitter
  - Lip Sync Picker

Each category shows a count badge of contained tokens. Clicking expands to show token rows.

**Right: token rows.** Selected category shows its tokens as a scrollable list. Each row:

```
┌─────────────────────────────────────────────────────┐
│  --theme-mixer-fader-thumb                          │
│  [swatch]  #4AE3D0                    [edit][detach]│
│  Derived from --theme-accent                         │
└─────────────────────────────────────────────────────┘
```

Row shows: token name, current value (color swatch + hex/gradient summary), edit button, status label (Base / Derived / Custom), and Detach or Re-derive button.

Clicking Edit opens a color picker for solid-only tokens, or a gradient editor modal for gradient-capable tokens.

**Quick-jump search.** A search input above the tree filters tokens by name or category across all sections. Typing "knob" highlights every knob token across every subsystem. Keyboard shortcut: Ctrl+F inside the editor.

**Click-on-preview navigation (optional enhancement).** Users can right-click any element in the preview pane (Section 5.6) to jump to that element's token in the Advanced tree. Deferred as post-Phase-3 nice-to-have.

### 5.5 Gradient editor

Opens as a popover or slide-out overlay when a gradient-capable token's Edit button is clicked.

```
┌────────────────────────────────────────────┐
│ Edit: --theme-chrome-titlebar-bg           │
├────────────────────────────────────────────┤
│ [ Solid ] [ Linear ] [ Radial ] [ Conic ]  │
│   (tabs; Solid is always available)        │
├────────────────────────────────────────────┤
│                                            │
│          Preview (300 × 200)               │
│                                            │
├────────────────────────────────────────────┤
│ Stops                                      │
│                                            │
│  ●────────●────────────────────●            │
│  0        35                  100           │
│                                            │
│ Click bar to add · Drag to move · Click    │
│ stop to edit color · Right-click to delete │
├────────────────────────────────────────────┤
│ Type-specific controls                     │
│                                            │
│ Linear: Angle [180°] [0][45][90][135][180] │
│                                            │
│ Radial: Shape [Circle|Ellipse]             │
│         Center click preview to set        │
│                                            │
│ Conic:  Start angle [0°]                   │
│         Center click preview to set        │
├────────────────────────────────────────────┤
│ Presets: [ warm fade ▾ ]   [Save as preset]│
└────────────────────────────────────────────┘
```

Disabled tabs render greyed-out when the target token's capability forbids that type. Tab labels include a lock icon for disabled tabs.

### 5.6 Preview pane contents

The preview pane renders a scrollable mini-Xleth canvas covering every subsystem at representative density. All surfaces read from a locally-scoped theme context (not `:root`), so editor changes preview here without leaking to the running app. Updates are instant — token changes re-trigger React re-render of the affected preview subtree within 16ms.

The pane is organized as a stacked scroll of labeled surface groups. Groups collapse and expand; the currently-selected category in the Advanced tree auto-scrolls its preview group into view.

**Preview surfaces, in order:**

1. **Window chrome** — sample panel frame (focused Mixer titlebar + unfocused Timeline titlebar), resize handle, snap ghost zone indicator.
2. **Top toolbar + menu bar** — panel-toggle icon row in mixed open/hidden states, sample File menu with hover/active item.
3. **Transport** — play/stop/record buttons, time display, BPM readout.
4. **Buttons** — Primary, Secondary, Destructive, Icon-only, Toggle on/off.
5. **Mixer** — one channel strip showing pan + width knobs, fader with level line, meter with peak hold, effect chain with 2 slots, Chain/Node toggle.
6. **Stock effect — generic** — plugin window frame, bypass toggle, preset selector, large knob + small knob + slider + toggle + value readout.
7. **Stock effect — EQ** — mini frequency response with 3 band handles + pre/post spectrum.
8. **Stock effect — Dynamics** — mini transfer curve with threshold line + GR meter.
9. **Stock effect — Filter** — mini filter response curve with cutoff indicator.
10. **Stock effect — Modulation** — mini LFO waveform with phase indicator.
11. **Stock effect — Time** — mini delay tap visualization + reverb tail.
12. **Stock effect — Distortion** — mini waveshape curve.
13. **Piano roll** — 4-key lane snippet with bar/beat/subdivision lines, 3 notes (one selected), velocity bars, playhead.
14. **Sampler** — ADSR envelope with drag handles, sample waveform with trim markers.
15. **Timeline** — ruler + 2 clip tracks (one clip, one pattern) + 1 pattern track row, playhead, gap indicator.
16. **Grid editor** — 3×2 mini cell grid with chorus overlay, track card snippet.
17. **Sample selector** — category header with color dot + 2 sample items + status chip.
18. **Node editor** — 2 connected nodes with input/output sockets + connection lines.
19. **Preview player** — small video-loaded preview + empty-state preview side by side.
20. **Syllable splitter** — waveform with 2 markers + numbered segment label.
21. **Lip sync picker** — mini video player + waveform + In/Out markers.
22. **Project media** — tree with folder + audio/video file rows.
23. **Pattern list** — 3 pattern items with color stripes.
24. **Dialogs & tooltips** — sample tooltip, sample modal dialog with primary/secondary buttons.
25. **Context menu** — 4-item context menu with divider + destructive action.

Total: 25 labeled surface groups, each ~60–120px tall. Preview pane is ~320px wide, scrolls vertically.

**Navigation from tree → preview.** Clicking a subsystem category in the Advanced tree scrolls the corresponding preview group into view and briefly highlights it with a 1px accent ring that fades over 800ms. This keeps the user oriented as they edit deep-nested tokens.

### 5.7 Apply flow

Click Apply:
1. Validate editor state against schema
2. Write current editor state JSON to `userData/themes/<theme-name>.json`
3. Update `userData/settings.json` activeTheme reference
4. Compile all tokens (gradient objects → CSS strings)
5. Write every token to `document.documentElement.style.setProperty()`
6. CSS cascade repaints entire app
7. Leave editor open (user might want to continue tweaking)

Click Revert:
1. Reload active theme's JSON from disk
2. Replace editor state with loaded state
3. Preview updates to reverted state
4. Global app is unchanged (it was already at that state)

Click Close with unsaved changes:
- Show confirmation: "Discard unsaved changes?" with Keep Editing / Discard options

## 6. Theme resolution pipeline

### 6.1 Boot sequence

1. Main process (`main.js`) reads `userData/settings.json` for `activeTheme` string
2. Main process reads `userData/themes/<activeTheme>.json`
3. If missing or invalid, fall back to shipped Default from `src/theming/shipped/xleth-default.json`
4. Pass theme JSON to renderer via `ipcRenderer` event on ready
5. Renderer's `ThemeProvider` component receives JSON, calls `compileTheme()`:
   - For each token: if value is object, compile to CSS gradient string; if string, use directly
   - If token absent from JSON, run `deriveTheme(baseTokens)` to fill
6. `ThemeProvider` writes each compiled value via `document.documentElement.style.setProperty()`
7. React mounts rest of the app; all components inherit via CSS cascade

### 6.2 In-session theme changes

Apply button, preset switch, and editor preview all trigger:
1. Compile new token set
2. `document.documentElement.style.setProperty()` for each changed token
3. Browser reflows/repaints affected elements
4. Debounced disk write (500ms) — no blocking

### 6.3 Derivation implementation

`deriveTheme(baseTokens: BaseTokens): FullTokens` is a pure function in `src/theming/tokens/derivation.ts`.

- Input: `{ bg-primary, bg-surface, accent, text, danger }`
- Output: full token record with all Section 3.2 tokens computed
- Uses `culori` library (lightweight color manipulation)
- Each derived token's formula is documented inline with a comment
- Tokens listed in the theme's `derivationDetached` array are skipped — user's manual values win
- Unit-tested: input → expected output for each formula

## 7. Shipped themes

### 7.1 Xleth Default (locked)
The existing dark teal aesthetic. Values match current Xleth hardcoded colors exactly. This is the baseline everything compares against. Marked `locked: true` — users cannot modify; must duplicate to customize.

### 7.2 Xleth Light
Palette-inverted dark→light. Near-white bg-primary, dark text, accent retains teal (darkened for contrast on light surfaces). Derived tokens re-computed for light base.

### 7.3 Xleth Warm (inspiration theme)
Brown/cream/orange palette. Uses radial gradient on bg-primary for a subtle glow effect. Feels retro-studio. Named deliberately generic — no trademark reference.

### 7.4 Xleth Cool (inspiration theme)
Slate blue / silver / grey palette. Flat gradients on titlebar for an NLE-editor feel. Named deliberately generic.

Krasen's custom "FL-feel" and "Vegas-feel" themes are authored separately and distributed as community themes outside official Xleth shipping.

## 8. Import/Export

**Import paths:**
- File menu → Import Theme → file picker → select `.json` → validate → write to `userData/themes/` → select in editor
- Drag-drop a `.json` file onto Xleth's main window → same as above
- Drag-drop onto the theme list in the editor → same as above

**Export paths:**
- Theme editor → select theme → Export button → native save dialog → writes `<theme-name>.json`
- Right-click a theme in the list → Export

**Validation:**
- Schema version check
- Required fields present (name, schemaVersion, tokens)
- Token values are valid hex / rgba / gradient objects
- Unknown tokens are ignored (forward compat)
- Invalid gradient objects fail with user-readable error

Import failure shows a modal with the validation error and does NOT modify any existing themes.

## 9. File structure

```
src/
├── theming/
│   ├── tokens/
│   │   ├── catalog.ts              # Full token list + gradient capability + categories
│   │   ├── base.ts                 # BaseTokens interface (the 5)
│   │   └── derivation.ts           # deriveTheme() + unit tests
│   ├── schema/
│   │   ├── themeSchema.ts          # JSON schema definition + validator
│   │   ├── gradientCompiler.ts     # Gradient object → CSS string
│   │   └── types.ts                # ThemeFile, GradientObject, etc.
│   ├── editor/
│   │   ├── ThemeEditor.tsx         # Modal root
│   │   ├── ThemeList.tsx           # Left column
│   │   ├── SimpleMode.tsx
│   │   ├── AdvancedMode.tsx
│   │   ├── TokenCategoryTree.tsx
│   │   ├── TokenRow.tsx
│   │   ├── ColorPicker.tsx
│   │   ├── GradientEditor.tsx
│   │   ├── PreviewPane.tsx         # Mini-Xleth renderer
│   │   └── previewSurfaces/        # One component per demo surface
│   │       ├── MiniChrome.tsx      # Titlebar + panel frame + snap ghost
│   │       ├── MiniToolbar.tsx     # Top toolbar + menu bar + panel icons
│   │       ├── MiniTransport.tsx
│   │       ├── MiniButtons.tsx
│   │       ├── MiniMixerStrip.tsx
│   │       ├── MiniEffectGeneric.tsx
│   │       ├── MiniEffectEQ.tsx
│   │       ├── MiniEffectDynamics.tsx
│   │       ├── MiniEffectFilter.tsx
│   │       ├── MiniEffectModulation.tsx
│   │       ├── MiniEffectTime.tsx
│   │       ├── MiniEffectDistortion.tsx
│   │       ├── MiniPianoRoll.tsx
│   │       ├── MiniSampler.tsx
│   │       ├── MiniTimeline.tsx
│   │       ├── MiniGridEditor.tsx
│   │       ├── MiniSampleSelector.tsx
│   │       ├── MiniNodeEditor.tsx
│   │       ├── MiniPreviewPlayer.tsx
│   │       ├── MiniSyllableSplitter.tsx
│   │       ├── MiniLipSyncPicker.tsx
│   │       ├── MiniProjectMedia.tsx
│   │       ├── MiniPatternList.tsx
│   │       ├── MiniDialog.tsx      # Modal + tooltip + popover
│   │       └── MiniContextMenu.tsx
│   ├── runtime/
│   │   ├── ThemeProvider.tsx       # :root injection, change broadcaster
│   │   ├── ThemeLoader.ts          # Boot-time load + fallback
│   │   └── ThemeWriter.ts          # Debounced disk writes
│   └── shipped/
│       ├── xleth-default.json
│       ├── xleth-light.json
│       ├── xleth-warm.json
│       └── xleth-cool.json
```

## 10. Implementation phases

**Phase 0 — Token infrastructure + codebase audit.** This phase has two parallel tracks that converge:

*Track A (audit)*: scan the entire Xleth codebase for every hardcoded color, every hex, every rgba, every gradient, every CSS color keyword. Group findings by file and by UI subsystem. Produce an inventory document listing each hardcoded value, the element it styles, and the proposed semantic token name. The inventory is the input for catalog.ts generation. Every effect component, every knob, every slider, every meter, every curve, every text label, every border is audited — nothing skipped. If an element has no obvious token category, flag it for review rather than silently assigning one.

*Track B (infrastructure)*: build `tokens/catalog.ts` from the audit inventory with every discovered token, its category, its gradient capability flag, and its derivation rule (or explicit default). Build `deriveTheme()` with unit tests covering all derivation formulas. Build `ThemeProvider`, `ThemeLoader`, `ThemeWriter`. Author `xleth-default.json` to match current hardcoded values exactly.

*Convergence*: replace every hardcoded value found in Track A with `var(--theme-<token-name>)` references. Verify the app renders pixel-identically before vs after migration (visual diff of every panel, every effect UI, every dialog). Any visual deviation means a token was misnamed or derivation is wrong, and the phase isn't done.

This is the prerequisite for windowing Phase 1 AND the acceptance bar for "the theme editor doesn't miss a single thing." If an element exists in Xleth that doesn't have a token after Phase 0, the audit missed it and we fix it before moving on.

**Phase 1 — Settings modal shell.** Build `ThemeEditor` modal root + layout skeleton. Wire up Settings menu entry. Build theme list sidebar with shipped themes. Apply button can switch between shipped themes (no editing yet). Revert works.

**Phase 2 — Simple mode editor.** Build 5-knob interface. Build `PreviewPane` with all `previewSurfaces/` components. Simple mode drives `deriveTheme()` live and renders into preview pane. Panel color scheme dropdown works.

**Phase 3 — Advanced mode + color picker.** Build `TokenCategoryTree` + `TokenRow` + `ColorPicker` (solid only). Detach/re-derive per-token works. Switching Simple ↔ Advanced is non-destructive (no data loss either direction). Gradient-capable tokens show a placeholder "gradient editor not yet available" state.

**Phase 4 — Gradient editor.** Build `GradientEditor` with Linear tab first (stops + angle). Then Radial (stops + center + shape). Then Conic (stops + center + startAngle). Build `gradientCompiler.ts` to emit correct CSS strings. Preview pane renders gradients correctly. Per-token allowlist enforced.

**Phase 5 — Shipped themes content.** Author `xleth-light.json`, `xleth-warm.json`, `xleth-cool.json` as JSON files. Test each in the running app. Iterate until they feel cohesive. This is content work, not code.

**Phase 6 — Import/Export.** File menu entries. Drag-drop handler on main window + theme list. Schema validation with friendly error messages. Test round-trip import/export of a theme.

Estimated effort: 7–9 days (up from 6–7 due to comprehensive subsystem coverage across 25 preview surfaces and expanded audit pass).

## 11. Acceptance criteria

1. Every color and chrome dimension in the running Xleth app resolves from a theme token — no hardcoded hex codes, no rgba strings, no CSS color keywords anywhere in components or stylesheets.
2. **Completeness audit passes.** Running the Phase 0 audit tool against the codebase finds zero un-tokenized color values. Every subsystem listed in Section 3.4 has a corresponding catalog entry with all enumerated elements covered.
3. Switching between the 4 shipped themes produces visually distinct, correctly-rendered UI in every panel AND every stock effect UI AND every specialized editor (Syllable Splitter, Lip Sync Picker).
4. Simple mode: changing `--theme-accent` cascades correctly to derived panel-type colors, accent hover/active, success/warning derivations, focus ring, AND subsystem-specific accent-derived tokens (note fill, waveform stroke, port socket colors, etc.).
5. Advanced mode: every token in the catalog is browseable across all 5 top-level tree sections; detach and re-derive work for any token; switching Simple↔Advanced loses no data.
6. Advanced mode tree: clicking any subsystem category auto-scrolls the preview pane to the matching surface group and highlights it.
7. Quick-jump search in Advanced mode finds tokens across all subsystems by name substring.
8. Preview pane renders all 25 surface groups correctly, each reading from the locally-scoped editor theme context. Gradient-capable surfaces render gradients during editing.
9. Gradient editor: all three types (linear, radial, conic) render correctly in the preview pane AND after Apply, across every gradient-capable token.
10. Gradient type restrictions enforced per-token: attempting to apply a radial gradient to a solid-only token (any accent bar, text token, border) is blocked at the UI level (tab is disabled with lock icon).
11. Preview pane updates in real time as the user edits — no visible lag during rapid changes. Each surface re-renders within 16ms of token change.
12. Apply flow correctly persists theme JSON to disk and updates `:root` CSS variables across the ENTIRE running app (every panel, effect UI, dialog). Revert reloads from disk and updates the preview only (global app unchanged).
13. Import round-trips a valid theme file with no data loss, including gradient objects across all three types.
14. Stock effect UIs all reflect the active theme: EQ band colors, compressor transfer curves, filter response curves, LFO waveforms, reverb tails, distortion waveshapes — every visualization is themed.
15. Users can reproduce an "FL-like" (warm, brown-chrome, gradient-titlebars, skeuomorphic feel) and "Vegas-like" (cool, flat, bluish, NLE-editor feel) look well enough that Krasen personally validates them as convincing recreations.

## 12. Known decision debt (deferred post-beta)

- In-app theme sharing hub or marketplace
- Per-project theme overrides (currently global per-user only)
- Animated theme transitions (fade/crossfade between themes)
- Font family and size customization
- Spacing / density customization (compact vs comfortable modes)
- Icon pack customization
- Community-contributed gradient preset libraries
- "Pick a vibe" theme derivation wizard
- Right-click context menus on tokens (copy/paste value, reset to default)
- Theme versioning / undo history within editor
- Contrast checker (currently explicitly deferred by user decision)
- Audio-reactive theme mode (colors shift with audio levels — stretch goal)

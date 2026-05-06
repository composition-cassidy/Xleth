# Pass 5E.0 — FL/VEGAS Contrast Hierarchy Diagnostic
## Xleth UI Depth Pass — Read-only audit, 2026-05-05

---

## Summary Verdict

**The UI feels flat because the entire dark-theme value range spans only ~12 perceptual lightness points (L* 4–16), when a strong DAW hierarchy needs 40–50 points between the darkest bed and the brightest clip body.** Every surface — app shell, panel body, arrangement canvas, mixer rack, pattern list — is collapsed into a narrow band of near-blacks and very dark blues. Clip bodies, which should feel raised and bright against a dark bed, are rendered at low alpha (~0.60) on top of a lane bed that is barely darker than the surrounding chrome. The result: nothing reads as "in front of" anything else.

Five structural root causes are identified, each with a clear fix. The fix does NOT require new architecture. It requires:
- One new token (`--theme-timeline-lane-bg`)
- Value adjustments to existing tokens
- Selector reassignments in `app.css`
- Alpha constant increases in `timelineDrawing.js`

No new tokens are needed for mixer or Sample Selector — existing token reassignments are sufficient.

---

## Files Inspected

| File | Purpose |
|---|---|
| `ui/src/theming/shipped/xleth-default.json` | Dark-theme base + explicit overrides |
| `ui/src/theming/shipped/xleth-light.json` | Light-theme base + explicit overrides |
| `ui/src/theming/tokens/catalog.ts` | Full token catalog, derivation rules, subsystem map |
| `ui/src/styles/app.css` | All non-canvas CSS (Timeline, Mixer, Sample Selector, Project Media, etc.) |
| `ui/src/windowing/components/windowing.css` | Panel frame, titlebar, dock region chrome |
| `ui/src/components/timeline/timelineDrawing.js` | Canvas drawing — grid, clips, ruler, overlay |
| `ui/src/components/timeline/TimelineCanvas.jsx` | Three-layer canvas wiring, display settings plumbing |
| `ui/src/components/mixer/MixerPanel.jsx` | Mixer panel structure |
| `ui/src/components/mixer/MixerStrip.jsx` | Track strip layout |
| `ui/src/components/mixer/EffectChainPanel.jsx` | Effect slot list |
| `ui/src/components/mixer/EffectModule.jsx` | Single effect row |
| `ui/src/components/mixer/MasterStrip.jsx` | Master channel |
| `ui/src/components/SampleSelectorTab.jsx` | Sample Selector top-level |
| `ui/src/components/grid/GridSettingsPanel.jsx` | Grid Settings panel structure |

---

## Root Cause Analysis — Why the UI Still Feels Flat

### Cause 1 — Value range is critically compressed (primary cause)

**Dark-theme computed lightness ladder (approximate L\* in CIELAB):**

| Token | Value | L* |
|---|---|---|
| `--theme-bg-primary` | `#0A0A0F` | 3.9 |
| `--theme-bg-inset` | `#0D0D14` | 5.1 |
| `--theme-bg-secondary` | derived ~`#131320` | 7.4 |
| `--theme-bg-surface` | `#1A1A24` | 10.8 |
| `--theme-bg-elevated` | derived ~`#20202C` | 13.5 |
| Clip body (plain, unselected) | label hex @ alpha 0.60 | ~25–35 (context-dependent) |

**Total range from app bed to clip body:** roughly 21–31 perceptual points.

In FL Studio dark theme, the arrangement bed sits around L* 7–9 and a strongly colored clip body reads at L* 45–65. Total range: ~55 points. That is why FL clips feel "bright" against a "dark" bed.

The Xleth total span is one-third to one-half of this, and because every intermediate surface occupies the same compressed zone (L* 4–14), nothing separates from anything else.

### Cause 2 — `bg-inset` is barely darker than `bg-primary`, not darker

The intuition of `--theme-bg-inset` is "recessed well, darker than primary" — the intent name says it. In reality:
- `bg-primary`: `#0A0A0F` (L* 3.9)
- `bg-inset`: `#0D0D14` (L* 5.1)
- Difference: **1.2 lightness points** — invisible in practice

The Timeline arrangement canvas draws its background using `tokenValue('--theme-bg-inset')` (see `timelineDrawing.js:30`). The work area container behind it uses `--theme-bg-primary`. The eye sees no step, so the canvas has no visual weight as a "pit" or "well."

FL/VEGAS establish the arrangement bed as the *darkest* region in the layout — darker than the surrounding chrome. Xleth's bed is imperceptibly lighter than chrome. This is inverted from the target.

### Cause 3 — Clip/event bodies are too translucent at default contrast

`getTimelineBodyMaterial()` (`timelineDrawing.js:430–481`) at `plain` + `medium` contrast sets:
- Audio unselected: `fillAlpha = 0.60`
- Audio selected: `fillAlpha = 0.80`
- Pattern unselected: `fillAlpha = 0.55`
- Pattern selected: `fillAlpha = 0.75`

At 0.60 alpha on a `#0D0D14` bed, even a vivid label hex (#FF6B6B for kick, #33CED6 for teal) resolves to L* ~26–30. That is only 21–25 points above the bed — still in the lower quartile of the visual field. A strong DAW clip should appear at L* 40–60+ to truly pop.

This is further compounded by the muted-track multiplier (`0.3`) which pushes muted clips to L* ~8 — essentially invisible against the L* 5 bed.

### Cause 4 — Grid lines are too faint for orientation

Token values in `xleth-default.json`:
- `--theme-timeline-bar-line`: `rgba(255, 255, 255, 0.14)` — bar line on the darkest background resolves to ~L* 15, only ~10 points above bed
- `--theme-timeline-beat-line`: `rgba(255, 255, 255, 0.06)` — L* ~6, nearly invisible  
- `--theme-timeline-subdivision-line`: `rgba(255, 255, 255, 0.03)` — L* ~3.5, below background threshold

FL/VEGAS bar lines are roughly at 22–28% white alpha on their dark beds, beat lines at 10–12%, subdivisions at 5–7%. Xleth's values need to be approximately doubled.

### Cause 5 — Mixer, Sample Selector, Pattern List all use the same `bg-secondary` surface

In `app.css`:
- `.mixer-panel` → `background: var(--theme-bg-secondary)` (line 6440)
- `.mixer-strip` → no background, inherits `bg-secondary` from parent (line 6536)
- `.pattern-list-panel` → `background: var(--theme-bg-secondary)` (line 1804)
- `.sample-group-header` → `background: var(--theme-bg-secondary)` (line 3210)
- `.timeline-header-column` → `background: var(--theme-bg-secondary)` (line 1992)
- `.timeline-toolbar` → `background: var(--theme-bg-secondary)` (line 1637)

All of these — the mixer rack, the pattern list shelf, the sample group headers, the track header column, and the toolbar — share the exact same surface value. There is no visual hierarchy between "shelf" and "item," no darker rack bed, no separation between panel chrome and panel content.

---

## Comparison to the React Contrast Direction Board

The direction board `xleth_fl_vegas_contrast_direction_board` was used as art direction. The following table maps its intent to the current codebase state.

| Direction board intent | Current state | Gap |
|---|---|---|
| Darker arrangement bed ("pit") | `bg-inset` L* 5.1 — barely darker than chrome | Large. Needs ~3 darker. Target ~L* 2–3 (`#06060A`). |
| Brighter, lifted clip blocks | Plain alpha 0.60 → L* ~26–30 | Significant. Need alpha ~0.80–0.88 for opaque lift. |
| Stronger bar lines visible over clips | 14% white alpha | Medium. Double to ~24–28%. |
| Beat lines as navigational guide | 6% white alpha | Medium. Push to ~10–12%. |
| Track separator as seam, not invisible line | `--theme-border-subtle` (very faint) | Medium. Use `--theme-border-strong` or increase value. |
| Mixer strips as module capsules | No strip background, no rack bed | Large. Need strip bg distinct from rack bg. |
| Effect slots visible as inserts | `bg-elevated` — only ~3 L* above strip bg | Medium. Need stronger tonal jump. |
| Sample group headers as shelves | Same `bg-secondary` as item area | Medium. Need shelf bg distinct from item bg. |
| Source cards with framing | Already uses border + shadow | Minor. Frame is there but too subtle. |
| Title strips distinct from clip body | 5D implementation covers this | Already done. Small tuning only. |
| Selected clips with obvious lift | `--theme-border-focus` inner ring | Adequate but could add a subtle lightness boost to body alpha on selection. |
| Playhead visibility | Accent color line, adequate | No change needed. |
| No Aero gloss | None present | ✓ Passes already. |
| Not a FL clone | Teal accent, custom icons | ✓ Unique. |

**Areas that already match target:** panel focus-underline chrome, playhead, mute/solo semantic states, piano roll (Pass 4A), title strips (Pass 5D), pattern block name display, waveform tokens (adequate individual contrast).

**Areas that need no change:** transport bar (sufficient), top toolbar (functional), modal/dialog chrome (fine), toast notifications, bezier handle colors.

---

## Token Audit

### Tokens sufficient — NO changes needed

These existing tokens can cover Pass 5E requirements by reassigning them to different CSS selectors, without altering their values or adding new tokens:

| Token | Current usage | Pass 5E reassignment |
|---|---|---|
| `--theme-border-strong` | Hover/strong borders | Apply to Timeline lane separators (currently uses `--theme-border-subtle`) |
| `--theme-depth-well-bg` (aliases `bg-inset`) | Piano roll, depth token | Apply to mixer rack bed (currently mixer uses `bg-secondary`) |
| `--theme-bg-tertiary` | Derived tertiary bg | Apply to sample group header (currently uses `bg-secondary`) |
| `--theme-depth-elevation-2-outer-shadow` | Available, unused in mixer | Apply to mixer strip outer edge shadow |
| `--theme-depth-well-inner-shadow` | Piano roll, source card thumbnail | Apply to mixer fader groove for recessed feel |

### Tokens with wrong VALUES — adjust values, not names

| Token | Current value | Proposed dark value | Proposed light value | Reason |
|---|---|---|---|---|
| `--theme-bg-inset` | `#0D0D14` | `#090910` | `#D0D0CC` | Too close to bg-primary. Darken to create genuine recession. CAUTION: affects all consumers — see risk analysis. |
| `--theme-timeline-bar-line` | `rgba(255,255,255,0.14)` | `rgba(255,255,255,0.26)` | (already at 0.28 — ✓) | Insufficient visibility against dark bed. |
| `--theme-timeline-beat-line` | `rgba(255,255,255,0.06)` | `rgba(255,255,255,0.11)` | (already at 0.14 — ✓) | Nearly invisible in dark theme. |
| `--theme-timeline-subdivision-line` | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.05)` | (already at 0.07 — ✓) | Increase slightly for zoom-in readability. |
| `--theme-timeline-pattern-lane-tint` | `rgba(106,169,255,0.04)` | `rgba(106,169,255,0.07)` | (keep current — readable) | Too faint to distinguish pattern tracks from audio tracks. |

### New tokens — minimum justified set

Only **1 new token** is justified for Pass 5E:

**`--theme-timeline-lane-bg`**  
- **Category:** Workspace panels / timeline  
- **Default dark value:** `#07070B`  
- **Default light value:** `#CACAC6`  
- **Derivation:** explicit (not formula-derivable from bg-primary — the offset is intentionally larger than any formula would produce)  
- **Justification:** `--theme-bg-inset` is shared by the piano roll background (`--theme-depth-well-bg`), the mixer SmartBalance canvas background, and other inset surfaces. If we darken bg-inset globally to get a deeper arrangement canvas, the piano roll grid (which has its own `--theme-pianoroll-grid-bg: #111118` override) is protected, but the SmartBalance canvas, the tooltip backgrounds, and other `bg-inset` consumers would be affected. A dedicated token isolates the Timeline lane bed darkening. This mirrors the pattern already established for the piano roll (`--theme-pianoroll-grid-bg` is independent of `bg-inset`).  
- **Consumer:** `resolveTimelinePalette()` `bg` key in `timelineDrawing.js:30`  
- **Catalog placement:** Below `--theme-timeline-well-top-shadow` in the `timeline` subsystem block.

**DO NOT add any other new tokens.** The remaining gaps in mixer, sample selector, and secondary surfaces are selector reassignments, not token gaps. Adding `--theme-mixer-rack-bg`, `--theme-sample-shelf-bg`, etc. would create token sprawl with no benefit — they would simply alias `--theme-depth-well-bg` or `--theme-bg-tertiary` by default, which callers can already reference directly.

---

## Hardcoded Value Audit

### app.css hardcoded colors

| Location | Value | Category | Recommendation |
|---|---|---|---|
| `app.css:6723` | `background: #0a0a10` in `.mixer-fader-readout-input` | Should become existing token | Replace with `var(--theme-bg-inset)` |
| `app.css:1752` | `background: #1a1a2e` in `.timeline-snap-select option` | Should become existing token | Replace with `var(--theme-bg-surface)` — browser native select styling, note risk below |
| `app.css:1931` | `color: #000` in `.timeline-pattern-rename-input` | Should become existing token | Replace with `var(--theme-text-on-accent)` |
| `app.css:6557` | `background: rgba(167, 139, 250, 0.05)` in `.mixer-strip--visual-only` | Harmless intentional constant | CSS cannot produce alpha from a variable without `color-mix`. Keep as-is. |
| `app.css:2062` | `background: rgba(167, 139, 250, 0.07)` in `.track-header--visual-only` | Harmless intentional constant | Same rationale. Keep as-is. |
| `app.css:1676` | `border-color: rgba(255,255,255,0.15)` in `.timeline-tool-btn.active` | Harmless intentional constant | Small pressed-state edge highlight. Keep as-is. |
| `app.css:6883` | `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5)` in `.effect-chain-full-popover` | Should become existing token | Replace with `var(--theme-depth-elevation-2-outer-shadow)` |

### windowing.css hardcoded values

| Location | Value | Category | Recommendation |
|---|---|---|---|
| `windowing.css:74` | `color-mix(in srgb, var(--theme-accent) 28%, transparent)` on dock resizer hover | Harmless intentional constant | CSS paint computation using accent var. Not a "hardcoded color" — keep as-is. |

### timelineDrawing.js hardcoded values

| Location | Value | Category | Recommendation |
|---|---|---|---|
| `timelineDrawing.js:822` | `rgba(255,255,255,${envAlpha})` — waveform envelope fallback | Canvas-only math — keep local | Computed from canvas math constants. Not a theme concern. |
| `timelineDrawing.js:823` | `rgba(255,255,255,${rmsAlpha})` — waveform RMS fallback | Canvas-only math — keep local | Same rationale. |
| `timelineDrawing.js:551–558` | Title strip alpha ladder (`0.88`, `0.74`, etc.) | Canvas design constants | These are design constants set in Pass 5D. Adjust only if the new clip alpha scale requires recalibration in Pass 5E.3. |

---

## Proposed Value / Material Ladder

### Dark theme

Ordered from darkest (lowest L*) to brightest, with approximate L* target and token mapping:

| Level | Role | Target L* | Token / mechanism |
|---|---|---|---|
| 0 — Timeline lane bed | Arrangement canvas "pit" | ~2 | `--theme-timeline-lane-bg: #07070B` (new) |
| 1 — App bed | Work area background between panels | ~4 | `--theme-bg-primary: #0A0A0F` (current ✓) |
| 2 — Inset well | Recessed UI elements, deep inputs | ~5–6 | `--theme-bg-inset: #090910` (adjust ↓) |
| 3 — Panel surface | Panel body, pattern list body | ~7–8 | `--theme-bg-secondary` (derived, current ✓) |
| 4 — Panel chrome | Toolbar, titlebar, group headers | ~9–11 | `--theme-bg-surface: #1A1A24` (current ✓) |
| 5 — Raised shelf | Pattern list header, sample group shelf, mixer rack (target) | ~11–13 | `--theme-bg-surface` or `--theme-bg-tertiary` — reassign selectors |
| 6 — Card / module | Source cards, effect slots, mixer strip capsule (target) | ~13–15 | `--theme-bg-elevated` (current ✓ for most) |
| 7 — Raised control | Fader thumb, knob body | ~15–17 | `--theme-bg-elevated` (current ✓) |
| 8 — Clip/event body (unselected) | Audio/pattern clips in arrangement | ~35–45 | Label hex @ alpha ~0.80 (increase from 0.60) |
| 9 — Clip title strip | Name strip above clip body | ~40–55 | Label hex @ alpha ~0.80 (Pass 5D, minor tune) |
| 10 — Active/selected | Selected clip, focused element | ~50–65 + accent ring | Label hex @ alpha ~0.90 + `--theme-border-focus` inner ring |
| 11 — Accent / playhead | Teal accent, playhead line | High chroma (~L* 75) | `--theme-accent: #33CED6` (current ✓) |

### Light theme guidance

The light theme has already been given explicit overrides for most timeline and piano roll tokens. The key adjustments for Pass 5E light-theme parity:

| Level | Dark target | Light target | Notes |
|---|---|---|---|
| Timeline lane bed | `#07070B` | `#CACAC6` | Must be LIGHTER than bg-primary in light theme (inverted logic: bed is lighter, clips are darker-tinted) |
| Bar line alpha | `rgba(255,255,255,0.26)` | Already at `rgba(0,0,0,0.28)` ✓ | No change needed |
| Beat line alpha | `rgba(255,255,255,0.11)` | Already at `rgba(0,0,0,0.14)` ✓ | No change needed |
| Clip body alpha | 0.80 (increase) | Decrease from 0.80 to ~0.65–0.70 to prevent label tint from dominating on white | Light-theme clips should be softer |
| Sample shelf bg | Darker shelf | Lighter shelf: use `bg-tertiary` (#E0E0DC in light) | ✓ same token works both ways |

---

## Timeline-Specific Findings

### Canvas structure review

`TimelineCanvas` draws three layers:
1. **bg canvas** (`bgRef`) — grid only, via `drawGrid()`
2. **ct canvas** (`ctRef`) — clips and pattern blocks, via `drawClips()` / `drawPatternBlocks()`
3. **ov canvas** (`ovRef`) — drop preview, tool overlays

The palette is resolved once per draw via `resolveTimelinePalette()` and threaded into draw functions. This pattern is clean and efficient.

### Specific visual improvements needed

**Arrangement bed:** `resolveTimelinePalette()` maps `bg` to `--theme-bg-inset` (`#0D0D14`). The surrounding work area uses `--theme-bg-primary` (`#0A0A0F`). Change `bg` to read `--theme-timeline-lane-bg` (new token, ~`#07070B`). The bed will now be visually darker than the chrome, matching FL/VEGAS placement.

**Lane separators:** `laneSeparator` reads `--theme-border-subtle`. In dark theme, border-subtle is a very faint computed line. Change to `--theme-border-strong` to produce FL-style visible row boundaries. This is a single selector reassignment in `resolveTimelinePalette()`.

**Bar lines:** Increase `--theme-timeline-bar-line` from 0.14 to 0.26 white alpha. At this level, bars are visible through clip bodies (they still read through the 0.80 alpha clip fill, faintly — which is correct for orientation).

**Beat lines:** Increase `--theme-timeline-beat-line` from 0.06 to 0.11. Still subordinate to bars; visible enough to orient without dominating.

**Clip body alpha:** In `getTimelineBodyMaterial()` for `plain` + `medium` contrast:
- Audio unselected: `0.60` → `0.80`
- Audio selected: `0.80` → `0.90`
- Pattern unselected: `0.55` → `0.72`
- Pattern selected: `0.75` → `0.86`

These numbers preserve the `selected > unselected` invariant and keep muted clips (multiplied by 0.30) visible against the darker bed.

**Title strip alpha:** Pass 5D set title strip at `plain` unselected `0.74`. With the darker bed and higher body alpha, re-evaluate this in 5E.3 — the title strip may need to step up to ~0.80 unselected to maintain its contrast above the body region.

**Track headers (DOM, not canvas):** `.timeline-header-column` uses `--theme-bg-secondary`. This is functionally the same value as the toolbar and pattern list. For a clearer header/canvas seam, consider applying `--theme-bg-surface` instead — one tone step up from `bg-secondary` — which would make the headers read as slightly raised "chrome" relative to the canvas pit.

**Pattern list panel:** `.pattern-list-panel` uses `--theme-bg-secondary`. `.pattern-list-header` uses `--theme-bg-tertiary`. This is already slightly differentiated — the header is a half-step darker than the list body. Keep this but double-check derived values in dark theme.

**Playhead:** Currently accent-color teal line. Adequate. No change.

**Waveform/mini-note readability:** Current tokens `rgba(255,255,255,0.65)` fg and `rgba(255,255,255,0.18)` bg are adequate for waveform contrast. At the new higher clip body alpha (0.80), the waveform will appear "inside a brighter clip" — this is correct and desirable. No token changes needed for waveform. The fallback path (`rgba(255,255,255,${envAlpha})` local constants) should also remain unchanged.

**Loop brace:** `--theme-timeline-loop-brace: rgba(255, 217, 61, 0.6)` — adequate. No change.

---

## Mixer-Specific Findings

### Structure

`.mixer-panel` (bg: `bg-secondary`) contains:
- `.mixer-toolbar` (bg: `bg-primary`) — one step darker, good separation
- `.mixer-strips-row`
  - `.mixer-tracks-scroll` — no bg, transparent over `bg-secondary`
    - `.mixer-strip` × N — no background, transparent → inherits `bg-secondary`
  - `.mixer-strip--master` (bg: `bg-surface`) — fractionally different

**Problem:** Every strip is the same background value as the rack. There is no "strip capsule" feeling. In FL Studio, each channel strip sits as a raised module with a slightly lighter or distinctly bordered surface against a darker rack floor.

### Specific improvements needed

**Rack bed:** Change `.mixer-panel` from `var(--theme-bg-secondary)` to `var(--theme-depth-well-bg)` (which already aliases `--theme-bg-inset`). If bg-inset is tightened to `#090910` (per the value audit), the mixer rack will sit as a true "pit" relative to the surrounding dock regions.

**Strip body:** Add `background: var(--theme-bg-secondary)` to `.mixer-strip`. This lifts each strip visually above the darker rack bed. The combination (darker rack + slightly lighter strips) directly produces the FL-style "modules in a rack" reading.

**Strip divider:** Currently `border-right: 1px solid var(--theme-border-subtle)`. Consider upgrading to `--theme-border-strong` for clearer module separation, or add a subtle left/right inset shadow per strip.

**Effect slots (`.effect-module`):** Currently `background: var(--theme-bg-elevated)`. This is already the "raised" token — but `bg-elevated` is only ~L* 13.5, only 2–3 points above the strip bg. If the strip bg moves to `bg-secondary` (~L* 7.4), the elevation gap widens to ~6 points. That alone should make effect slots more readable without a token change.

**Fader groove:** `.mixer-fader-groove` uses `--theme-border-subtle` — almost invisible. Replace with `var(--theme-depth-well-inner-shadow)` on the groove container, or increase the groove width from 2px to 3px and use `--theme-bg-inset`. The deeper groove should visually separate the fader range.

**Fader thumb:** `.mixer-fader-thumb` uses `--theme-bg-elevated` with border `--theme-border-subtle`. This is adequate but flat. Adding `box-shadow: var(--theme-depth-elevation-1-top-highlight)` (already registered) would add the edge highlight that makes knobs/faders look raised.

**Meter track:** `--theme-mixer-meter-track` aliases `--theme-bg-primary`. With the new darker rack bed, meter background should use `--theme-depth-well-bg` (or `--theme-bg-inset`) so the meter column looks recessed against the strip body.

**Master strip:** `.mixer-strip--master` uses `--theme-bg-surface` + `border-left: 2px solid var(--theme-accent)`. This is good — the accent stripe distinguishes master. Keep. Minor: make the master strip slightly lighter than track strips (e.g., `--theme-bg-elevated`) to emphasize its "boss channel" role.

**Text contrast:** `.mixer-strip-label` and `.mixer-channel-name-fg` token both use `text-muted`. At small sizes (10px) this may be insufficient. The mixer-specific token `--theme-mixer-channel-name-fg` already aliases `--theme-text` — but `.mixer-strip-label` in CSS uses `var(--theme-text-muted)` directly. Upgrade to `var(--theme-text)` for readability at 10px.

---

## Sample Selector / Project Media Findings

### Sample Selector structure

`.sample-selector-tab` contains:
- Search bar (bg: none — transparent over panel bg-primary)
- `.sample-group-header` × N (bg: `--theme-bg-secondary`)
  - `.sample-group-rows` (bg: none — transparent → inherits `bg-primary` from panel)
    - `.sample-row` × N (bg: none — transparent → inherits `bg-primary`)

**Problem:** Group headers use `bg-secondary` but the panel body is `bg-primary`. This means headers are LIGHTER than the item area below them — the opposite of the intended "shelf" direction. A shelf should be darker (or distinctly different) than the row content beneath it. Additionally, sample rows have no background at all — they are invisible until hovered.

**Specific improvements:**

1. **Group header shelf:** Change `.sample-group-header` background from `--theme-bg-secondary` to `--theme-bg-tertiary` (slightly darker than secondary in dark theme). This creates a darker shelf above lighter item rows — matching the FL/VEGAS browser section-header pattern.

2. **Row body:** Add `background: var(--theme-bg-secondary)` to `.sample-group-rows` (the container wrapping all rows in a group). This gives rows a slightly lighter background than the shelf headers, creating a clear group/item hierarchy.

3. **Active row:** `.sample-row.active` currently uses `--theme-bg-elevated` with `depth-pressed-inner-shadow`. This is adequate; the inner shadow adds recessed feedback. Potentially add `border-left: 2px solid var(--theme-accent)` to the active row for a stronger indicator.

4. **Hover row:** `.sample-row:hover` uses `--theme-bg-surface`. With rows sitting on `bg-secondary`, this hover tint is too subtle. Use `--theme-bg-elevated` on hover for a more obvious lift.

### Project Media structure

`.source-card` uses `--theme-bg-secondary` with border `--theme-border-subtle` and top-highlight shadow. This is functionally correct — it creates a card above the panel surface.

**Assessment:** Project Media source cards are the best-implemented surface hierarchy in the browser panel. The thumbnail uses `--theme-depth-well-inner-shadow` for framing. The hover state lifts to `--theme-bg-surface` with `--theme-border-strong`. This already approximates the target direction.

**Minor improvement:** `.source-card-thumbnail` background (used when no thumbnail exists) is `--theme-bg-secondary` — same as card background. Use `--theme-bg-inset` for the placeholder to add depth inside the card frame.

---

## Secondary Surface Findings

### Grid Settings Panel

`GridSettingsPanel.jsx` renders controls using generic button/input/select atoms. The panel itself gets its background from the windowing panel frame (`.xleth-panel-frame` → `--theme-depth-floating-bg`). No custom CSS section exists for grid settings in `app.css`.

**Assessment:** Grid Settings does not need dedicated 5E changes. It uses the correct depth tokens already. Defer any refinement to a future polish pass.

### Video Preview

`.video-preview` renders the canvas output. The panel chrome is handled by windowing. The video frame itself is black by definition (canvas rendering). The preview controls strip inherits panel chrome.

**Assessment:** No 5E changes needed. The preview panel's visual weight comes from the windowing chrome, which passes 2 has addressed.

### Piano Roll

Pass 4A applied dedicated contrast tuning. The piano roll has explicit token overrides (`--theme-pianoroll-grid-bg: #111118`) making it the darkest well in the UI (~L* 6.8). This is correct and serves as a reference for how dark the Timeline lane bed should target.

**Assessment:** No 5E changes needed. The piano roll passes as a high-contrast, readable canvas.

---

## Recommended Implementation Pass Breakdown

### Pass 5E.1 — Token/value ladder foundation

**Changes:** JSON + TypeScript only. No CSS selectors touched.

**File touch list:**
- `ui/src/theming/tokens/catalog.ts` — register `--theme-timeline-lane-bg` (explicit, dark: `#07070B`, light: `#CACAC6`)
- `ui/src/theming/shipped/xleth-default.json` — add `--theme-timeline-lane-bg: "#07070B"`, adjust `--theme-bg-inset` to `#090910`, increase `--theme-timeline-bar-line` to `rgba(255,255,255,0.26)`, increase `--theme-timeline-beat-line` to `rgba(255,255,255,0.11)`, increase `--theme-timeline-subdivision-line` to `rgba(255,255,255,0.05)`, increase `--theme-timeline-pattern-lane-tint` to `rgba(106,169,255,0.07)`
- `ui/src/theming/shipped/xleth-light.json` — add `--theme-timeline-lane-bg: "#CACAC6"` (light inversion: lighter well on lighter theme)
- `ui/src/theming/deriveTheme.ts` (if needed) — no formula changes, but if the token scaffolding requires catalog registration to propagate, update there

**Visible effect:** Minimal or zero visible change. The `--theme-timeline-lane-bg` token is registered but not yet read by any consumer (resolveTimelinePalette still reads `bg-inset`). The `bg-inset` and grid line value changes may produce barely perceptible effects on existing canvases. This is intentional — foundation pass, no drama.

**Verification:** `git diff --name-only` should only show the 3 token files.

---

### Pass 5E.2 — Non-canvas CSS contrast hierarchy

**Changes:** CSS selectors only. No canvas drawing touched.

**File touch list:**
- `ui/src/styles/app.css`:
  - `.mixer-panel` bg: `bg-secondary` → `var(--theme-depth-well-bg)`
  - `.mixer-strip` add: `background: var(--theme-bg-secondary)` (raises strips above rack)
  - `.mixer-strip--master` bg: `bg-surface` → `var(--theme-bg-elevated)` (lighter than strips)
  - `.mixer-channel-name-fg` token already correct, but fix `.mixer-strip-label` CSS: `text-muted` → `var(--theme-text)` for readability
  - `.mixer-fader-readout-input` bg: `#0a0a10` → `var(--theme-bg-inset)` (fix hardcoded)
  - `.mixer-fader-groove` bg: `--theme-border-subtle` → `var(--theme-depth-well-bg)` for recessed groove
  - `.mixer-fader-thumb` add: `box-shadow: var(--theme-depth-elevation-1-top-highlight)` for raised feel
  - `.mixer-strip--master` add: `background: var(--theme-bg-elevated)` (already present, verify)
  - `.sample-group-header` bg: `bg-secondary` → `var(--theme-bg-tertiary)` (darker shelf)
  - `.sample-group-rows` add: `background: var(--theme-bg-secondary)` (lighter item area under shelf)
  - `.sample-row:hover` bg: `bg-surface` → `var(--theme-bg-elevated)` (more visible lift)
  - `.source-card-thumbnail-placeholder` bg: `bg-surface` → `var(--theme-bg-inset)` (deeper frame)
  - `.timeline-header-column` bg: `bg-secondary` → `var(--theme-bg-surface)` (slightly raised headers)
  - `.timeline-pattern-rename-input` color: `#000` → `var(--theme-text-on-accent)` (fix hardcoded)
  - `.effect-chain-full-popover` shadow: hardcoded → `var(--theme-depth-elevation-2-outer-shadow)`

**Visible effect:** The mixer rack should noticeably darken, with strip capsules appearing to float above it. Sample Selector group headers should look like FL-style collapsible shelves rather than same-level rows. Track header column gains a slight surface lift. These are 5–8 value-point changes — clearly visible but not extreme.

**Verification:** Manual visual review of mixer, sample selector, track headers. No canvas changes to verify.

---

### Pass 5E.3 — Timeline canvas contrast pass

**Changes:** Canvas drawing code and `resolveTimelinePalette()`. No CSS selectors touched.

**File touch list:**
- `ui/src/components/timeline/timelineDrawing.js`:
  - `resolveTimelinePalette()`: change `bg: tokenValue('--theme-bg-inset')` → `bg: tokenValue('--theme-timeline-lane-bg')`
  - `resolveTimelinePalette()`: change `laneSeparator: tokenValue('--theme-border-subtle')` → `laneSeparator: tokenValue('--theme-border-strong')`
  - `getTimelineBodyMaterial()` plain-mode alphas: audio unselected `0.60` → `0.80`, audio selected `0.80` → `0.90`, pattern unselected `0.55` → `0.72`, pattern selected `0.75` → `0.86`
  - `getTitleStripStyle()` plain-mode strip alpha: unselected `0.74` → `0.80` to maintain title-strip-vs-body contrast at new alpha levels

**Visible effect:** Timeline arrangement canvas becomes visibly darker (the "pit" effect). Clips pop significantly more against the darker background. Grid lines become navigation aids rather than barely-visible artifacts. Lane separators read as clear row boundaries. This is the highest-impact single change in Pass 5E.

**Risk:** Muted tracks (alpha × 0.30) at new alphas: audio muted = 0.80 × 0.30 = 0.24 → L* ~8 against L* 2 bed — that's only 6 points. Still visible, which is correct. Selected muted: 0.90 × 0.30 = 0.27 → slightly more visible.

**Regression check:** Run `test_compositor.cpp` and `test_real_render.cpp` tests. If Playwright golden images exist for the timeline, these will diff. Those diffs are expected and should be updated as part of this pass.

---

### Pass 5E.4 — Mixer rack/strip material polish (if not fully covered in 5E.2)

If the 5E.2 changes do not fully achieve the hardware-module feel for the mixer (depends on how derived values compute on the target machine), this pass addresses:

**File touch list:**
- `ui/src/styles/app.css`:
  - Add subtle `box-shadow: var(--theme-depth-elevation-1-top-highlight), var(--theme-depth-elevation-2-outer-shadow)` to `.mixer-strip` for strip edge lighting
  - Tune `.effect-module` border to use `--theme-border-strong` on the left edge to hint at insert-slot framing
  - Apply `var(--theme-depth-well-inner-shadow)` to fader groove via a wrapper div if the groove is too flat after 5E.2

This pass is conditional — evaluate 5E.2 results first.

---

### Pass 5E.5 — Light-theme parity and final visual audit

**Changes:** Light-theme JSON token adjustments + any CSS light-theme overrides.

**File touch list:**
- `ui/src/theming/shipped/xleth-light.json` — verify `--theme-timeline-lane-bg: "#CACAC6"` reads correctly (lighter bed in light theme, not darker)
- Review all 5E.2 selector changes against light theme:
  - `bg-tertiary` in light = `#E0E0DC` — adequate for a shelf darker than `#EBEBE7` (bg-secondary light)
  - `bg-elevated` in light = `#ECECE8` — adequate for hover state
- `ui/src/components/timeline/timelineDrawing.js`: verify the new lane-bg token in light theme does not create an overly light canvas (should be slightly lighter than surrounding chrome, which is the correct light-theme inversion)
- Visual audit: compare dark + light side-by-side against the direction board

---

## Risk Analysis

### Visual regression risks
**Medium.** The clip alpha changes in 5E.3 will produce diffs against any Playwright or golden-image baseline. These diffs are correct and expected — they represent the desired improvement. Any CI that blocks on visual diffs must have its baselines updated. Do not revert clip alpha changes to make tests green; update the baselines.

### Light-theme risks
**Medium.** The light theme uses inverted logic for the timeline bed — the bed should be slightly LIGHTER than the surrounding chrome in light mode, opposite of dark mode. `--theme-timeline-lane-bg: "#CACAC6"` achieves this (bg-primary light = `#F2F2EE` at L* 93 vs `#CACAC6` at L* 80 — a 13-point step lighter background makes the canvas recede, which is correct for a light theme). Verify this reads correctly with manual review; Playwright screenshots are the only reliable check since screenshots are unreliable in this repo context.

### Token sprawl risks
**Low.** Only 1 new token is added (`--theme-timeline-lane-bg`). The audit explicitly rules out mixer, sample selector, and secondary surface tokens. Risk of future contributors adding "just one more" new token in subsequent passes — mitigate by noting in the Pass 5E.1 PR that no further timeline-subsystem tokens are planned until a Theme Editor audit.

### Canvas performance risks
**Negligible.** No additional canvas operations are introduced. The alpha constant changes in `getTimelineBodyMaterial()` affect only the numeric values, not the call count or draw calls. `resolveTimelinePalette()` changes one `tokenValue()` call from `bg-inset` to `lane-bg` — same cost.

### Over-darkening risks
**Low-medium.** Pushing `--theme-timeline-lane-bg` to `#07070B` (L* ~2) is quite dark. If the user's monitor has poor black levels (common in budget LCD panels), L* 2 may be visually indistinguishable from absolute black. The surrounding chrome at L* 4 would lose its distinguishability. Mitigate by: testing on a mid-range IPS monitor at default brightness, and providing the `--theme-depth-amplitude` lever for users who want to reduce depth effects globally. Consider `#09090E` (L* ~4) as a more conservative starting point if 5E.1 testing reveals crushing.

### Over-gloss / FL-clone risks
**Low.** The plan explicitly avoids gradient fills for surfaces, avoids brushed-metal textures, and avoids FL's specific orange/green/teal instrument color scheme. The contrast direction is "inspired by" FL/VEGAS, not "cloned from." The Xleth accent (teal) and font (Hanken Grotesk) remain unique. The module/capsule style is a universal DAW affordance.

### Screenshot / Playwright limitations
Screenshots may not be available as primary verification. Use the preview tool chain (preview_start + preview_snapshot) if available. If neither is available, the primary verification path is:
1. Manual review of the running Electron app
2. Console log output from the timeline and canvas layers
3. `git diff --name-only` to confirm only intended files changed

---

## Acceptance Criteria for Future Implementation

The following criteria define when Pass 5E is "done":

- [ ] **Timeline clips visually pop** — clip bodies are clearly brighter than the arrangement lane bed; the "instruments on a dark stage" reading is present
- [ ] **Timeline lane bed is the darkest element** — the canvas well is visibly darker than surrounding panel chrome
- [ ] **Bar lines are useful navigation cues** — visible without hovering, not drawing attention away from clips
- [ ] **Beat lines provide subdivision context** — visible at normal zoom; finer than bar lines
- [ ] **Mixer strips read as module capsules** — each strip has a distinct surface against the rack bed
- [ ] **Effect insert slots are legible** — at 3+ effects in a strip, each slot is identifiable without hover
- [ ] **Sample Selector shelves separate groups** — group headers read as collapsible sections, not peers of item rows
- [ ] **Selected/active states are obvious** — selected clip, active sample, active effect are unambiguous
- [ ] **No glossy surfaces** — no gradients on non-clip CSS surfaces; no metallic fills; no bevel/emboss
- [ ] **Not a FL clone** — teal accent, Hanken Grotesk, Xleth-specific color usage intact
- [ ] **No behavior changes** — hit-testing, snapping, move/resize/split/delete, playback, all function identically
- [ ] **No engine/bridge/IPC/project schema changes** — zero changes outside `ui/`
- [ ] **Build/tests pass** — `npm run build` clean; C++ tests pass; JS unit tests pass
- [ ] **Light theme remains readable** — sample selector, timeline, mixer all readable in light mode; no white-on-white or black-on-black failures
- [ ] **`git diff --name-only` shows only expected files** — no accidental drift to bridge, engine, or test golden files

---

## Open Questions

1. **`--theme-bg-inset` adjustment scope:** Changing `bg-inset` from `#0D0D14` to `#090910` affects all consumers. The piano roll is protected by its own `--theme-pianoroll-grid-bg`. The SmartBalance canvas (`mixer/SmartBalancePanel.jsx`) reads the bg from inline style or a prop — needs a quick check before 5E.1 to confirm it doesn't use `bg-inset` directly.

2. **Clip alpha escalation and muted-track legibility:** At new unselected alpha 0.80, a muted clip (×0.30) = 0.24 opacity. On the new darker bed (`#07070B`), does 0.24 alpha of a vivid label hex (e.g. kick red #FF6B6B) remain distinguishable from the bed? Needs a quick mental or physical test before committing the exact alpha values.

3. **Pattern lane tint at higher clip alpha:** The `--theme-timeline-pattern-lane-tint` (`rgba(106,169,255,0.07)` proposed) is meant to distinguish pattern-track rows from audio-track rows in the arrangement bed. At new higher clip alphas, this tint may be invisible behind the clip bodies. Evaluate whether this tint should be increased further or applied only to empty row areas.

4. **`--theme-timeline-lane-bg` default value vs. bg-inset reconciliation:** If `bg-inset` is adjusted to `#090910`, should `--theme-timeline-lane-bg` default be `#07070B` (even darker) or `#09090E` (same as new inset, relying on a subtle separation)? The deeper contrast direction board suggests the former, but the over-darkening risk above argues for the latter as a starting point.

5. **Effect chain scrollbar styling:** The `.effect-chain-list::-webkit-scrollbar-track` uses `--theme-bg-secondary`. After the mixer rack bed moves to `depth-well-bg`, the scrollbar track will be lighter than the background. This may look odd — verify and potentially change to `--theme-depth-well-bg` to match.

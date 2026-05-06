# UI Depth Pass 5A: Timeline Display Modes Diagnostic and Implementation Spec

## Scope

This pass is diagnostic and specification only. It does not implement Timeline display modes, settings, drawing changes, CSS changes, theme token changes, tests, or project schema changes.

The intended feature is a user-selectable set of display modes for Timeline audio clips and pattern blocks, similar in spirit to FL Studio playlist display styles:

- Minimal / Nothing
- Plain
- Gradient / Aqua-like
- Solid

The visual direction is the React mockup named `xleth_timeline_final_visual_mockup`. That mockup was not found in the local workspace during this pass, so this document translates the requested direction into Xleth's current drawing, theme, and settings architecture rather than copying mockup code.

## Files Inspected

- `ui/src/components/timeline/timelineDrawing.js`
- `ui/src/components/timeline/TimelineCanvas.jsx`
- `ui/src/components/TimelineView.jsx`
- `ui/src/components/timeline/TimelineToolbar.jsx`
- `ui/src/components/timeline/TimelineRuler.jsx`
- `ui/src/components/timeline/tools/selectTool.js`
- `ui/src/components/timeline/tools/pencilTool.js`
- `ui/src/components/timeline/tools/splitTool.js`
- `ui/src/components/timeline/tools/deleteTool.js`
- `ui/src/utils/waveformRenderer.js`
- `ui/src/styles/app.css`
- `ui/src/theming/tokens/catalog.ts`
- `ui/src/theming/shipped/xleth-default.json`
- `ui/src/theming/shipped/xleth-light.json`
- `ui/src/stores/snapStore.js`
- `ui/src/stores/sampleViewModeStore.js`
- `ui/src/stores/uiStore.js`
- `ui/src/stores/timelineFocusStore.js`
- `ui/src/stores/gridEditStore.js`
- `ui/src/hooks/useTimelineZoom.js`
- `ui/src/hooks/useTimelineScroll.js`
- `ui/src/components/settings/SettingsPanel.jsx`
- `ui/src/components/video/VideoPreview.jsx`
- `ui/main.js`
- `ui/preload.js`
- `engine/ProjectManager.cpp`
- `engine/ProjectManager.h`

Note: `ui/src/components/timeline/Timeline.jsx` does not exist in the inspected tree. The effective Timeline parent component is `ui/src/components/TimelineView.jsx`.

## Current Drawing Architecture

Timeline drawing is split into three canvases managed by `TimelineCanvas.jsx`:

- Background canvas: grid, lane tints, track separators, Timeline well top shadow.
- Content canvas: audio clips, pattern blocks, waveform previews, pattern mini-note previews, selected states, text, clip metadata, fades, resize handles, loop glyphs, WORLD spinners.
- Overlay canvas: drag previews, drop previews, rubber band selection, split line, delete sweep.

`TimelineRuler.jsx` owns a separate ruler canvas and uses the same Timeline palette resolver.

### Redraw Entry Points

`TimelineCanvas.jsx` exposes these imperative redraw methods:

- `redrawGrid(reason)`: resolves the Timeline palette, calls `drawGrid()`, and warns if the redraw takes more than 16 ms.
- `redrawContent(reason)`: resolves the Timeline palette, calls `drawClips()`, then `drawPatternBlocks()`, then `drawWorldSpinners()` if needed.
- `redrawOverlay()`: clears the overlay canvas, draws a drop preview if present, then delegates to the active tool's overlay renderer.
- `positionPlayhead()`: updates DOM playhead transforms.

Current redraw triggers include resize, zoom, scroll, theme changes, clips/regions/tracks changes, pattern block/pattern changes, selection changes, waveform invalidation, visibility changes, and WORLD spinner animation ticks.

### Audio Clip Drawing

Audio clips are drawn by `drawClips()` in `timelineDrawing.js`.

Important helpers and data sources:

- Clip geometry comes from `clip.start`, `clip.duration`, `pixelsPerBeat`, `scrollX`, and track index.
- Track geometry comes from `trackHeight`, `headerHeight`, and `trackGap`.
- Region color comes from `labelHexColor(region?.label)`.
- Waveform preview data comes from:
  - `clipPeakCache[clip.id]` for processed clip peaks.
  - `waveformCache[clip.regionId]` for raw region peaks.
  - `hiResCache` / `hiResMeta` for viewport-aware high-resolution waveform traces.
- Pitch/stretch/reverse/gain text comes from clip fields:
  - `pitchShiftSemitones`
  - `pitchShiftCents`
  - `reverse`
  - `timeStretchRatio`
  - `velocity`

Current audio clip draw order:

1. Clear the entire content canvas.
2. Compute visible clip geometry and cull clips outside the viewport.
3. Fill clip body using the region label color through `hexToRgba(hex, alpha)`.
4. Stroke semantic label-color border.
5. Draw selected inner highlight when selected.
6. Draw waveform preview if the clip is wide enough and waveform data exists.
7. Draw fade-in and fade-out overlays.
8. Draw selected resize handles.
9. Draw clip name if the clip is wide enough.
10. Draw compact bottom-right text metadata for pitch, reverse, stretch, and gain if the clip is wide enough.

Current audio clip body rendering is fixed:

- Selected fill alpha: about `0.8`.
- Unselected fill alpha: about `0.6`.
- Muted fill alpha multiplier: `0.3`.
- Border alpha: `1.0`.
- Selected border width: `2`.
- Unselected border width: `1`.

### Pattern Block Drawing

Pattern blocks are drawn by `drawPatternBlocks()` in `timelineDrawing.js`.

Important helpers and data sources:

- Pattern block geometry comes from `block.start`, `block.duration`, `pixelsPerBeat`, `scrollX`, and the Pattern track index.
- Pattern color is derived from `pattern.regionId`, then the corresponding region label color through `labelHexColor(region?.label)`.
- Mini-note previews come from `pattern.notes`.
- Pattern loop preview behavior comes from `block.loop !== false`, `pattern.length`, and `block.duration`.

Current pattern block draw order:

1. Compute visible block geometry and cull blocks outside the viewport.
2. Fill pattern body using semantic label color through `hexToRgba(hex, alpha)`.
3. Stroke semantic label-color border.
4. Draw selected inner highlight when selected.
5. Draw dashed top border.
6. Draw mini-note preview if the block is wide enough and the pattern has notes.
7. Draw selected right resize handle.
8. Draw loop glyph when the block duration exceeds the pattern length.
9. Draw pattern name if the block is wide enough.

Current pattern body rendering is fixed:

- Selected fill alpha: about `0.75`.
- Unselected fill alpha: about `0.55`.
- Muted fill alpha multiplier: `0.3`.
- Border alpha: `1.0`.
- Selected border width: `2`.
- Unselected border width: `1`.
- Pattern blocks also get a dashed semantic-color top border.

### Waveform Preview Drawing

Waveform previews are drawn inside `drawClips()` with helper functions from `ui/src/utils/waveformRenderer.js`:

- `getRegime(spp)`: chooses `envelope`, `trace`, `waveform`, or `sample` rendering based on samples per pixel with hysteresis.
- `drawSamplePoints()`: high-zoom sample point rendering.
- `drawTrace()`: trace rendering for mid-zoom waveform lines/fills.
- `drawWaveformLine()`: high-resolution waveform line rendering.
- `drawEnvelope()`: low-resolution peak/RMS envelope rendering.

The current code prefers high-resolution cached waveform data when available and falls back to cached peak arrays. The fallback `drawEnvelope()` call still uses hardcoded white RGBA values for peak and RMS colors rather than Timeline palette tokens.

Waveform visibility is currently hardcoded to `clipW > 20 && bpm && region`.

### Pattern Mini-Note Preview Drawing

Mini-note previews are drawn inside `drawPatternBlocks()`.

Current rules:

- Only draw when `pattern.notes.length > 0` and `blockW > 30`.
- Notes are clipped to the pattern block rect.
- Notes repeat across loop iterations when looping is enabled.
- Notes are drawn as small semantic label-color rectangles with high alpha.
- If looping is disabled, only the first iteration is drawn.

Pattern preview visibility is currently hardcoded to `blockW > 30`.

### Clip and Pattern Name Drawing

Audio clip names are drawn inside `drawClips()`.

Current audio clip name rules:

- Draw only when `clipW > CLIP_TEXT_PAD * 2 + 10`, currently about 22 px.
- Text is clipped to the clip rect minus horizontal padding.
- Font is `600 10px Inter, system-ui, sans-serif`.
- Baseline is `middle`.
- Name is usually `region.name`, with syllable-display fallback when `clip.syllableIndex >= 0`.
- Text color comes from `palette.clipLabel`, resolved from `--theme-timeline-clip-title-fg`.

Pattern names are drawn inside `drawPatternBlocks()`.

Current pattern name rules:

- Draw only when `blockW > CLIP_TEXT_PAD * 2 + 10`, currently about 22 px.
- Text is clipped to the block rect minus horizontal padding.
- Font is `600 10px Inter, system-ui, sans-serif`.
- Baseline is `top`.
- Name is `pattern.name` or `?`.
- Text color comes from `palette.patternLabel`, currently the same token as clip label.

Current name rendering does not truncate intelligently. It relies on canvas clipping.

### Gain, Pitch, Stretch, and Reverse Metadata Drawing

Audio metadata is drawn inside `drawClips()` after the clip name.

Current metadata rules:

- Metadata is rendered as one inline text string in a bottom-right mini box.
- Parts are joined with spaces.
- Pitch displays semitones and cents when non-zero.
- Reverse displays `REV`.
- Stretch displays a ratio like `1.25x` when not close to `1.0`.
- Gain displays dB derived from `velocity`.
- Draw only when metadata exists and `clipW > 30`.
- Background uses `palette.clipPitchBoxBg`, currently resolved from `--theme-timeline-fade-curve-fill`.
- Text uses `palette.clipPitchBoxFg`, currently resolved from `--theme-text`.

Pattern blocks currently have no gain/pitch metadata.

### Selected State Drawing

Selected state is drawn inside both `drawClips()` and `drawPatternBlocks()`.

Current selected-state treatment:

- Stronger body alpha.
- Thicker semantic-color outer border.
- Inner highlight stroke using `palette.selectionHighlight`, resolved from `--theme-border-focus`.
- Selected resize handles are shown when the clip/block is wide enough.

The selection model and hit testing live outside drawing and must not change for this feature.

### Fades and Loop Glyphs

Audio fade overlays are drawn inside `drawClips()` after waveform previews and before handles/text.

Current fade behavior:

- Fade percentages are normalized by `_normalizedClipFadePercents()`.
- Fade-in and fade-out shapes use the existing bezier-like filled polygon geometry.
- Fill uses `palette.clipFadeOverlay`, resolved from `--theme-timeline-fade-curve-fill`.
- Fade geometry must not change in display-mode passes.

Pattern loop glyphs are drawn inside `drawPatternBlocks()`.

Current loop glyph behavior:

- Shown when `block.duration > pattern.length`.
- Uses `palette.patternGlyphBg`, currently resolved from `--theme-timeline-fade-curve-fill`.
- Glyph is `loop`-style when looping and `one-shot`-style when loop is disabled.
- The current glyph placement and geometry must not change in display-mode passes.

### Overlay Drawing

Overlay previews are separate from committed clip/pattern drawing:

- `drawGhostPreview()`: pencil preview for new clips or pattern blocks.
- `drawMovePreview()`: move/resize preview from select tool.
- `drawDropPreview()`: audio drop preview.
- `drawRubberBand()`: selection rectangle.
- `drawSplitLine()`: split tool line.
- `drawDeleteSweep()`: delete tool sweep rectangle.

For v1, committed clip/pattern body modes should not alter Timeline tool hit testing or overlay behavior. Overlay visual parity can be considered later, but it is not required for Pass 5B through Pass 5D.

## Current Timeline Palette and Theme Architecture

### Palette Resolution

`resolveTimelinePalette()` in `timelineDrawing.js` is the Timeline canvas palette bridge. It reads CSS custom properties through `tokenValue()` and returns a plain object of resolved colors.

Important resolved values:

- `bg`: `--theme-bg-inset`
- `laneSeparator`: `--theme-border-subtle`
- `patternLaneTint`: `--theme-timeline-pattern-lane-tint`
- `gridMinor`: `--theme-timeline-subdivision-line`
- `gridBeat`: `--theme-timeline-beat-line`
- `gridBar`: `--theme-timeline-bar-line`
- `rulerBg`: `--theme-bg-secondary`
- `rulerText`: `--theme-text-placeholder`
- `rulerBorder`: `--theme-border-subtle`
- `rulerGridMinor`: `--theme-timeline-subdivision-line`
- `playheadLine`: `--theme-timeline-playhead-line`
- `playheadAccent`: `--theme-border-focus`
- `clipLabel`: `--theme-timeline-clip-title-fg`
- `clipFadeOverlay`: `--theme-timeline-fade-curve-fill`
- `clipWaveformFg`: `--theme-timeline-clip-waveform-fg`
- `clipWaveformBg`: `--theme-timeline-clip-waveform-bg`
- `clipPitchBoxBg`: `--theme-timeline-fade-curve-fill`
- `clipPitchBoxFg`: `--theme-text`
- `patternLabel`: `--theme-timeline-clip-title-fg`
- `patternGlyphBg`: `--theme-timeline-fade-curve-fill`
- `selectionHighlight`: `--theme-border-focus`
- `loopBrace`: `--theme-timeline-loop-brace`
- `accent`: `--theme-accent`
- `danger`: `--theme-danger`
- `fgInverse`: `--theme-fg-inverse`
- `wellTopShadow`: `--theme-timeline-well-top-shadow`

`TimelineCanvas.jsx` already resolves this palette once per grid redraw and once per content redraw, then passes it into drawing functions. `TimelineRuler.jsx` also resolves the palette once per ruler redraw.

### Semantic Per-Clip and Per-Pattern Colors

Audio clip body and border color are semantic per region label:

- `drawClips()` calls `labelHexColor(region?.label)`.
- That resolved label color becomes the base color for body fill, border, selected handles, and some preview elements.

Pattern block body and border color are semantic per linked region label:

- `drawPatternBlocks()` resolves the block's pattern.
- The pattern's `regionId` points back to a region.
- The region label color becomes the base color for the pattern body, border, dashed top border, mini-note preview, and selected handle.

Pattern lanes themselves are not semantic per region. Pattern lane tint comes from the Timeline palette value `patternLaneTint`.

### Values Still Derived Through `hexToRgba()`

The following visual surfaces are still derived directly from semantic hex colors:

- Audio clip body fills.
- Audio clip borders.
- Audio selected resize handles.
- Pattern block body fills.
- Pattern block borders.
- Pattern dashed top borders.
- Pattern mini-note previews.
- Pattern selected resize handles.
- Drop, ghost, and move previews.

The display-mode implementation should keep semantic label colors as the base color and apply mode-specific alpha/gradient formulas on top.

### Existing Theme Tokens Relevant to This Feature

The shipped themes and token catalog already include Timeline-specific tokens for:

- Clip title foreground.
- Waveform foreground and background.
- Fade curve fill.
- Loop brace.
- Pattern lane tint.
- Timeline well top shadow.
- Bar, beat, and subdivision grid lines.
- Playhead line.

The token catalog also includes generic text, border, focus, accent, danger, and inverse foreground tokens used by the Timeline palette.

### Are New Tokens Required?

No new tokens are required for v1.

The requested display modes can be expressed with:

- Semantic label colors from `labelHexColor()`.
- Existing Timeline waveform/text/fade/selection tokens.
- Existing generic text and border tokens.
- Mode-specific alpha and gradient formulas.

Possible future tokens, if visual audit proves they are needed:

- `--theme-timeline-metadata-chip-bg`
- `--theme-timeline-metadata-chip-fg`
- `--theme-timeline-clip-body-highlight`
- `--theme-timeline-clip-body-shadow`

These should be deferred. Adding them in Pass 5B or 5C would overfit the theme surface before the display modes have been evaluated in both default and light themes.

## Current Settings Architecture

### Existing User Settings

User settings are persisted by Electron in `ui/main.js`:

- Settings path: `xleth-settings.json` under Electron `userData`.
- IPC handlers:
  - `xleth:settings:get`
  - `xleth:settings:set`
- Renderer access is exposed by `ui/preload.js` as `window.xleth.settings.get()` and `window.xleth.settings.set()`.

Existing examples:

- `sampleSelectorViewMode` in `ui/src/stores/sampleViewModeStore.js`
- `snapGranularity` in `ui/src/stores/snapStore.js`
- preview performance settings in `VideoPreview.jsx`
- general app settings in `SettingsPanel.jsx`

The existing small stores hydrate asynchronously from `window.xleth.settings`, validate values, and debounce writes back to Electron settings.

### Existing Project-Local Settings

Project-local Timeline data is saved through the engine project schema, mainly in `engine/ProjectManager.cpp`:

- sources
- regions
- tracks
- clips
- patterns
- patternBlocks
- gridLayout
- declickMs
- custom labels
- effect chains
- master effect chain

The project file does not currently persist editor display modes. There is an explicit precedent that workstation-local preview performance settings stay in Electron settings rather than `project.json`.

### Existing Session-Local State

Session-local UI state includes:

- Timeline zoom state from `useTimelineZoom()`.
- Timeline scroll state from `useTimelineScroll()`.
- Focused track from `timelineFocusStore.js`.
- Track header width from `uiStore.js`.
- Grid edit state from `gridEditStore.js`.
- Sticky note length and active tool inside `TimelineView.jsx`.

These are not the best model for Timeline display modes because display mode preferences should survive app restart.

### Existing Theme Settings

Theme settings live in the theme system:

- `ui/src/theming/tokens/catalog.ts`
- shipped JSON themes
- Theme editor UI

Theme settings define colors, depth, text colors, borders, shadows, and similar presentation tokens. They should not own per-editor display mode choices such as "show clip names always" or "use gradient bodies".

## Recommended Persistence Location

Timeline display modes should be global user preferences persisted in Electron `xleth-settings.json`.

Recommended implementation:

- Add a new renderer store, likely `ui/src/stores/timelineDisplayStore.js`.
- Store one object under a single key such as `timelineDisplaySettings`.
- Validate and merge defaults on hydration.
- Debounce writes, following the style of `snapStore.js` and `sampleViewModeStore.js`.
- Keep the settings out of project save/load.
- Keep the settings out of the theme editor and shipped theme JSON.

Rationale:

- These are personal view preferences, not project content.
- They do not affect audio, video, timing, render output, or engine state.
- They should follow the user's workflow across projects.
- They are closer to Sample Selector view mode than to project clip data.
- Persisting them in `project.json` would make one collaborator's density/readability choice change another collaborator's view.
- Persisting them in theme JSON would conflate theme color/depth design with per-editor visibility preferences.

## Proposed V1 Settings Schema

Recommended settings key:

```js
timelineDisplaySettings: {
  schemaVersion: 1,

  timelineClipBodyMode: 'plain',
  timelinePatternBodyMode: 'plain',
  timelineClipGradientDirection: 'top',
  timelineClipContrast: 'medium',

  timelineShowClipNames: 'auto',
  timelineShowPitchShift: 'auto',
  timelinePitchShiftStyle: 'chip',
  timelineShowWaveforms: 'auto',
  timelineShowPatternPreview: 'auto'
}
```

### Validation Enums

`timelineClipBodyMode`:

- `minimal`
- `plain`
- `gradient`
- `solid`

Default: `plain`.

`timelinePatternBodyMode`:

- `minimal`
- `plain`
- `gradient`
- `solid`

Default: `plain`.

Recommendation: keep clip and pattern body modes as separate persisted values in v1. The renderer can share the same material helper and the toolbar can present them close together. A "match clip mode" UI toggle is not needed in v1 and should not be persisted until users prove they want it.

`timelineClipGradientDirection`:

- `top`
- `bottom`

Default: `top`.

For v1, this applies to both audio clips and pattern blocks when their body mode is `gradient`. The name is clip-oriented because it was requested that way; if a later schema rename is desired, migrate carefully rather than adding a duplicate setting.

Meaning:

- `top`: the brighter/highlight side of the vertical gradient is at the top.
- `bottom`: the brighter/highlight side of the vertical gradient is at the bottom.

`timelineClipContrast`:

- `low`
- `medium`
- `high`

Default: `medium`.

For v1, this applies to both audio clips and pattern blocks. It controls material contrast and alpha strength, not text font weight or geometry.

`timelineShowClipNames`:

- `auto`
- `always`
- `never`

Default: `auto`.

For v1, this should control both audio clip names and pattern block names. A separate `timelineShowPatternNames` setting is not worth adding yet.

`timelineShowPitchShift`:

- `auto`
- `always`
- `never`

Default: `auto`.

For v1, this should gate all bottom-right audio clip metadata chips:

- pitch shift
- reverse
- stretch ratio
- gain dB

This keeps the settings surface small. A separate gain visibility setting can be added later only if users ask for independent gain labels.

`timelinePitchShiftStyle`:

- `chip`

Default: `chip`.

Recommendation: defer `inline` in v1. The current inline-style metadata already competes with the clip name and waveform. The mockup direction favors compact chips. Keeping this field with only `chip` gives the implementation a clear internal style while avoiding a UI option that doubles the metadata layout matrix. If `inline` is later added, it should be an intentional v2 addition.

`timelineShowWaveforms`:

- `auto`
- `always`
- `never`

Default: `auto`.

`timelineShowPatternPreview`:

- `auto`
- `always`
- `never`

Default: `auto`.

### Options Deferred From V1

Do not add these in v1:

- Separate pattern-name visibility.
- Separate gain visibility.
- Separate reverse/stretch visibility.
- Separate clip and pattern contrast.
- Per-track display mode.
- Per-project display mode.
- Per-theme display mode.
- Inline pitch metadata UI.
- Body-mode-specific waveform color tokens.
- Body-mode-specific pattern preview color tokens.

The v1 matrix above is already enough to support the requested display modes and visibility behavior without turning the Timeline toolbar into a preferences panel.

## Text and Metadata Rendering Rules

The next implementation should replace the current "draw text if width is barely above 22 px, then let canvas clipping cut it off" behavior with explicit layout rules.

### Shared Constants

Recommended constants for v1:

- Horizontal padding: `6 px`.
- Name top inset: `3 px`.
- Name font: keep `600 10px Inter, system-ui, sans-serif`.
- Metadata chip font: `600 9px Inter, system-ui, sans-serif`.
- Metadata chip height: `12 px`.
- Metadata chip horizontal padding: `5 px`.
- Metadata chip gap: `3 px`.
- Minimum visible text width for auto names: `48 px`.
- Minimum visible text width for forced ellipsis: `18 px`.
- Minimum chip width: `28 px`.
- Minimum width for any auto metadata chip: `72 px`.
- Minimum width for waveform auto preview: `24 px`.
- Minimum width for pattern auto preview: `32 px`.

These values intentionally sit above the current text thresholds. The current thresholds allow text on clips too narrow to read.

### Clip Name Placement

Audio clip names should use a stable top-left label zone:

- `x = clipX + 6`
- `y = clipY + 3`
- available width starts as `clipW - 12`
- if metadata chips are visible on the same row, reserve their measured width plus gap
- draw within a clip rect so text cannot escape the body

For v1, audio names should move from vertical-middle placement to top-left placement only in Pass 5D, when the text rules are implemented. Pass 5C body modes should preserve existing text behavior.

### Pattern Name Placement

Pattern names should remain top-left:

- `x = blockX + 6`
- `y = blockY + 3`
- available width starts as `blockW - 12`
- reserve loop glyph space when a loop glyph is visible
- draw within a block rect so text cannot escape the body

### Name Visibility Rules

`timelineShowClipNames = never`:

- Do not draw audio clip names.
- Do not draw pattern names.

`timelineShowClipNames = always`:

- Draw the name when available width is at least `18 px`.
- Use truncation if the full name does not fit.
- Show a single ellipsis only if available width fits the ellipsis and no readable prefix fits.
- Draw nothing if available width is less than `18 px`.

`timelineShowClipNames = auto`:

- Draw the full or truncated name only when available width is at least `48 px`.
- Do not draw a standalone ellipsis on narrow auto clips.
- Hide the name if selected handles, loop glyphs, or metadata reservations reduce available width below `48 px`.

### Name Truncation

Use measured canvas text width, not character count.

Recommended behavior:

- If the full label fits, draw it.
- If the full label does not fit but `labelPrefix + ellipsis` fits, draw the longest fitting prefix plus ellipsis.
- If only the ellipsis fits and the mode is `always`, draw the ellipsis.
- If only the ellipsis fits and the mode is `auto`, draw nothing.
- If even the ellipsis does not fit, draw nothing.

The implementation should use a helper such as `fitText(ctx, label, maxWidth, { allowBareEllipsis })`.

### Metadata Chip Content

For v1, draw at most two metadata chips on audio clips:

- Processing chip.
- Gain chip.

Processing chip may combine:

- pitch shift semitones and cents
- reverse
- stretch ratio

Recommended labels:

- Semitone shift: `+2st`, `-1st`
- Cent-only shift: `+35c`, `-20c`
- Semitone plus cents: `+2st +35c`
- Reverse: `REV`
- Stretch: `1.25x`

Gain chip:

- Compute `20 * log10(velocity)`.
- Show only when the absolute value is at least `0.1 dB`.
- Label examples: `+3.0dB`, `-6.0dB`.

Do not show a gain chip for missing, zero, negative, or non-finite velocity.

### Metadata Chip Placement

Audio metadata chips should be placed inside the bottom-right of the clip:

- Right edge: `clipX + clipW - 6`
- Bottom edge: `clipY + clipH - 4`
- Chip height: `12 px`
- Gap between chips: `3 px`
- Layout chips from right to left.

When both processing and gain metadata exist:

- Processing chip gets priority and should be placed rightmost.
- Gain chip is placed to the left if it fits.
- If only one chip fits, show the processing chip and hide gain.
- If processing is disabled or absent, gain may use the rightmost chip slot.

Chip backgrounds should reuse `palette.clipPitchBoxBg` in v1. Chip text should reuse `palette.clipPitchBoxFg`.

### Metadata Visibility Rules

`timelineShowPitchShift = never`:

- Do not draw pitch, reverse, stretch, or gain chips.

`timelineShowPitchShift = always`:

- Attempt chips when clip width is at least `40 px`.
- Still hide chips that cannot physically fit after measuring text.
- Never let chips overlap selected resize handles or escape the clip rect.

`timelineShowPitchShift = auto`:

- Draw metadata chips only when non-neutral metadata exists and clip width is at least `72 px`.
- Hide metadata if name reservation leaves too little horizontal room.
- Hide metadata before hiding the name.

### Waveform Visibility Rules

`timelineShowWaveforms = never`:

- Do not draw waveform previews.
- Keep clip body, border, fades, selected state, handles, names, and metadata intact.

`timelineShowWaveforms = always`:

- Draw waveform previews whenever waveform data exists and the clip is at least `16 px` wide.
- Still respect cache availability and existing waveform renderer regimes.
- Do not fetch additional data solely because this setting is `always`.

`timelineShowWaveforms = auto`:

- Draw waveform previews when waveform data exists and the clip is at least `24 px` wide.
- In `minimal` body mode, waveforms should remain visible because that mode is useful for dense editing.

### Pattern Preview Visibility Rules

`timelineShowPatternPreview = never`:

- Do not draw mini-note previews.

`timelineShowPatternPreview = always`:

- Draw mini-note previews whenever notes exist and the block is at least `20 px` wide.

`timelineShowPatternPreview = auto`:

- Draw mini-note previews whenever notes exist and the block is at least `32 px` wide.

Pattern preview drawing should still respect looping, one-shot behavior, clipping, and pitch-range normalization.

### Width Priority Rules

Tiny clips or blocks, under `24 px`:

1. Draw body, border, and selected state.
2. Preserve selected handles if the existing geometry allows them.
3. Hide names, metadata, waveform previews, and pattern previews.
4. Show no standalone ellipsis in auto mode.

Narrow clips or blocks, about `24 px` to `63 px`:

1. Draw body, border, selected state, fades, and loop glyphs if they fit.
2. Draw a name only when the name setting is `always` and measured text or ellipsis fits.
3. Hide secondary metadata.
4. Draw waveform/pattern preview only if the corresponding visibility setting is `always` and it does not make the block unreadable.

Medium clips or blocks, about `64 px` to `139 px`:

1. Draw name in auto or always mode.
2. Draw waveform or pattern preview according to preview settings.
3. Draw one metadata chip only if it fits without overlapping the name or handles.
4. Prefer the processing chip over gain when only one chip fits.

Wide clips or blocks, `140 px` and above:

1. Draw name.
2. Draw waveform or pattern preview.
3. Draw metadata chips.
4. Preserve fades, loop glyphs, selection highlights, and handles above the body material.

## Clip and Pattern Body Mode Visual Spec

The implementation should use one shared material helper for audio clips and pattern blocks. The helper should accept the semantic label color, mode, selected state, muted state, contrast, gradient direction, kind, and resolved Timeline palette.

Recommended helper shape:

```js
getTimelineBodyMaterial({
  baseHex,
  mode,
  selected,
  muted,
  contrast,
  gradientDirection,
  palette,
  kind
})
```

The helper should return fill instructions, border color, selected overlay hints, preview alpha multipliers, and text treatment hints. It must not read CSS tokens itself.

### Contrast Multipliers

Recommended contrast scale:

- `low`: `0.82`
- `medium`: `1.0`
- `high`: `1.18`

Use clamping so alpha values stay between `0` and `1`.

Selected clips/blocks should keep stronger body presence than unselected ones. Muted tracks should keep the current low-emphasis behavior, using a multiplier near the existing `0.3`.

### Minimal Mode

Purpose:

- Dense timelines.
- Low visual weight.
- Keeps outlines, names, and previews readable without heavy bodies.

Fill formula:

- Body fill: semantic label color at low alpha.
- Suggested medium contrast alpha: `0.18`.
- Low contrast alpha: about `0.14`.
- High contrast alpha: about `0.24`.
- Selected body alpha: add about `0.08`.
- Muted body alpha: multiply by current muted multiplier.

Border formula:

- Semantic label-color border at high alpha.
- Keep selected border width and selected inner highlight.
- A slightly stronger top/header line may be drawn using semantic color at about `0.55` alpha, but it must not change geometry.

Preview contrast:

- Waveforms and pattern mini-notes should remain visible.
- Use slightly stronger preview alpha than plain mode because the body is lighter.

Text contrast:

- Use existing `clipLabel` / `patternLabel` token.
- Do not tint text with the semantic label color.

Light theme behavior:

- Keep alpha low so light-theme label colors do not become muddy.
- Existing light theme text token should provide readable dark text.

Dark theme behavior:

- Semantic outline carries identity.
- Waveform/pattern previews can be stronger because the body is sparse.

### Plain Mode

Purpose:

- Clean default.
- Closest to the current Timeline with less visual fuss.

Fill formula:

- Flat semantic label-color body fill.
- Suggested unselected audio alpha: about `0.52`.
- Suggested unselected pattern alpha: about `0.50`.
- Suggested selected alpha: about `0.68`.
- Apply contrast multiplier and clamp.
- Apply muted multiplier to fill.

Border formula:

- Semantic label-color border at full or near-full alpha.
- Keep selected border width and selected inner highlight.

Preview contrast:

- Use current waveform and pattern preview strength, with small mode-specific alpha adjustment if needed.

Text contrast:

- Use existing text tokens.

Light theme behavior:

- Plain mode should avoid overly saturated slabs by keeping alpha below solid mode.

Dark theme behavior:

- Plain mode should read close to today's Pass 4B body material.

### Gradient Mode

Purpose:

- Aqua-like visual richness using Xleth colors and theme tokens.
- No hardcoded FL Studio colors.

Fill formula:

- Vertical gradient using the semantic label color.
- Suggested body alpha range at medium contrast:
  - low side: about `0.38`.
  - high side: about `0.70`.
- Selected gradient alpha range:
  - low side: about `0.48`.
  - high side: about `0.82`.
- Apply contrast multiplier and clamp.
- Apply muted multiplier to both stops.

Gradient direction:

- `timelineClipGradientDirection = top`: high-alpha/highlight stop at the top, lower-alpha stop at the bottom.
- `timelineClipGradientDirection = bottom`: lower-alpha stop at the top, high-alpha/highlight stop at the bottom.

Border formula:

- Semantic label-color border at full alpha.
- Keep selected border width and selected inner highlight.
- Do not add shadow blur.

Preview contrast:

- Waveform and pattern preview alpha should be slightly reduced compared with minimal mode so previews do not fight the gradient.
- If preview lines become low contrast in light theme, adjust preview alpha through existing waveform/pattern drawing formulas, not new tokens.

Text contrast:

- Use existing text tokens.
- Consider a tiny chip/name backing only if Pass 5E proves text fails on the gradient. Do not add that in Pass 5C.

Light theme behavior:

- The gradient must remain subtle enough not to look like a hard saturated stripe.
- Use alpha, not hardcoded color mixing, to respect the theme.

Dark theme behavior:

- The gradient can be more visible because the Timeline well is darker.

### Solid Mode

Purpose:

- Maximum readability of clip/pattern identity.
- Useful when semantic colors should dominate.

Fill formula:

- Flat semantic label-color body fill with high alpha.
- Suggested unselected alpha: about `0.74`.
- Suggested selected alpha: about `0.86`.
- Apply contrast multiplier and clamp.
- Apply muted multiplier to fill.

Border formula:

- Semantic label-color border at full alpha.
- Keep selected border width and selected inner highlight.

Preview contrast:

- Waveform and pattern preview alpha may need slight reduction so previews stay visible but not noisy.
- Preserve waveform regime behavior and cache usage.

Text contrast:

- Use existing text tokens first.
- If text fails in light theme, prefer chip/name backing in a later pass over changing semantic fill formulas.

Light theme behavior:

- Solid mode is intentionally high-contrast but should not obscure text.
- High contrast setting should be tested carefully in light theme.

Dark theme behavior:

- Solid mode should feel assertive and readable without adding glow or shadow.

## Performance Risk Analysis

### Current Performance-Sensitive Areas

The Timeline can redraw content frequently:

- scroll
- zoom
- selection changes
- drag operations
- waveform invalidations
- WORLD spinner animation ticks

`redrawGrid()` currently warns above 16 ms. `redrawContent()` does not currently have an equivalent warning, and this pass should not change warning thresholds.

Waveform rendering and hi-res waveform fetching are already the most expensive parts of content drawing. Body modes must stay cheap.

### Token and Style Lookup Rules

Implementation constraints:

- No `getComputedStyle()` inside per-clip or per-pattern loops.
- No new token lookup inside per-clip or per-pattern loops.
- Resolve Timeline palette once per redraw.
- Pass plain palette/settings/material context into drawing helpers.

Current caveat:

- `labelHexColor()` is currently called per clip and per pattern block, and it likely resolves label tokens internally.

Recommendation:

- Pass 5C should not add any more per-item token reads.
- If practical, add a per-redraw label color cache keyed by label string so repeated `labelHexColor(label)` calls are avoided.
- Do not make label-color caching a behavior change; it should only reduce repeated token resolution.

### Canvas State Rules

Implementation constraints:

- Do not add `ctx.shadowBlur` inside clip or pattern loops.
- Avoid repeated expensive `ctx.save()` / `ctx.restore()` beyond the existing clipping needs.
- Keep clip and pattern clipping scopes local and balanced.
- Reset `ctx.setLineDash([])` after dashed pattern top borders as the current code does.

### Gradient Cost

Canvas gradients depend on their coordinates, so a gradient created for one `y`/height is not automatically reusable for another track row.

Initial v1 recommendation:

- Creating a gradient per visible clip/block is acceptable only in `gradient` mode because visible items are viewport-bounded and waveform drawing is already more expensive.
- Keep the gradient helper allocation-free aside from the native gradient object.
- Avoid gradient mode work entirely for `minimal`, `plain`, and `solid`.

If profiling shows gradient creation is expensive, add a per-redraw gradient cache.

Recommended cache key:

```text
kind|baseHex|selected|mutedBucket|contrast|gradientDirection|y|height
```

Notes:

- Include `y` and `height` because canvas gradient coordinates are absolute.
- Include selected and muted state because alpha stops differ.
- Keep the cache per redraw or invalidate on theme/settings/height changes.
- Do not use a global unbounded cache.

### Preview Visibility and Caches

Display settings must not trigger additional waveform cache invalidation.

Rules:

- `timelineShowWaveforms = never` should skip drawing existing waveform data, not clear caches.
- `timelineShowWaveforms = always` should not fetch additional data beyond the existing viewport-aware fetch path.
- `timelineShowPatternPreview` should only gate drawing of already-loaded `pattern.notes`.

## Behavior Risk Analysis

The display-mode implementation must not change any Timeline behavior or data semantics.

No-change requirements:

- Clip position.
- Clip width.
- Clip duration.
- Pattern block position.
- Pattern block width.
- Pattern block duration.
- Pattern loop semantics.
- Fade geometry.
- Loop glyph geometry.
- Resize handle geometry.
- Hit testing.
- Snapping.
- Move behavior.
- Resize behavior.
- Split behavior.
- Delete behavior.
- Context menus.
- Pattern rename hit zones.
- Double-click behavior.
- Playback timing.
- Playhead timing.
- Clip cache invalidation.
- Waveform cache invalidation.
- Pitch-shift data.
- Reverse data.
- Stretch data.
- Gain/velocity data.
- Project save/load schema.
- Audio render behavior.
- Video render behavior.
- Engine, bridge, IPC, JUCE, FFmpeg, OpenGL, or backend behavior.

The safest implementation shape is visual-only:

- Thread settings into drawing functions.
- Choose materials and visibility in drawing functions.
- Do not alter clip/block model data.
- Do not alter timeline tools.
- Do not alter hit-test helpers.

## UI Location for Settings

### Options Evaluated

Timeline toolbar menu button:

- Best fit.
- The controls are Timeline-specific and should be reachable where the user is editing clips.
- Existing toolbar already owns tools, snapping, declick, quantize, zoom display, and add-track actions.

Settings menu:

- Acceptable as a secondary route later.
- Too global for display controls that users may tweak while editing.

Theme editor:

- Not recommended.
- Theme editor should remain for colors, depth, typography, and tokenized visual systems.
- Display modes are user/editor preferences, not theme definitions.

View menu:

- Reasonable conceptually, but the existing title/menu area is less contextual.
- Can be considered later as a shortcut route to the same store.

Right-click Timeline context menu:

- Not recommended as the primary location.
- Current context menus are object/action focused: clip operations, pattern operations, track area operations.
- A global display setting there would be hard to discover and easy to confuse with clip-specific actions.

Dedicated Timeline Display popover:

- Recommended implementation inside the Timeline toolbar.
- Use an icon button, likely a Lucide icon such as `SlidersHorizontal` or `Eye`.
- Use compact segmented controls/selects for modes and visibility.
- Keep the popover dense and editor-like rather than a large settings panel.

### Preferred V1 UI

Add a Timeline Display button to `TimelineToolbar.jsx`.

Suggested popover controls:

- Clip body: segmented control for Minimal, Plain, Gradient, Solid.
- Pattern body: segmented control or compact select for Minimal, Plain, Gradient, Solid.
- Gradient direction: two-button segmented control, Top and Bottom; disabled unless either body mode is `gradient`.
- Contrast: segmented control for Low, Medium, High.
- Names: segmented control for Auto, Always, Never.
- Metadata: segmented control for Auto, Always, Never.
- Waveforms: segmented control for Auto, Always, Never.
- Pattern preview: segmented control for Auto, Always, Never.

Do not expose `timelinePitchShiftStyle` in v1 because only `chip` is supported.

## Exact Files Likely Needed Next

### Pass 5B

Likely files:

- `ui/src/stores/timelineDisplayStore.js`
- `ui/src/components/timeline/TimelineDisplayPopover.jsx`
- `ui/src/components/timeline/TimelineToolbar.jsx`
- `ui/src/components/TimelineView.jsx`
- `ui/src/components/timeline/TimelineCanvas.jsx`
- `ui/src/styles/app.css`

Purpose:

- Add settings schema/store/persistence.
- Add Timeline Display popover UI.
- Wire settings to Timeline redraw.
- Thread settings to Timeline canvas/drawing as optional plumbing.
- Do not alter clip or pattern body drawing yet except to accept and pass settings through.

### Pass 5C

Likely files:

- `ui/src/components/timeline/timelineDrawing.js`
- `ui/src/components/timeline/TimelineCanvas.jsx` if function signatures need final adjustment.

Purpose:

- Implement shared clip/pattern body material helper.
- Implement `minimal`, `plain`, `gradient`, and `solid` body fills.
- Apply selected-state treatment consistently.
- Apply waveform/pattern preview visibility settings.
- Preserve current text and metadata rendering rules for this pass.
- Preserve fade and loop glyph drawing.

### Pass 5D

Likely files:

- `ui/src/components/timeline/timelineDrawing.js`

Optional file if helper extraction becomes worthwhile:

- `ui/src/components/timeline/timelineTextLayout.js`

Purpose:

- Implement name visibility rules.
- Implement measured truncation.
- Move audio clip name to stable top-left label zone.
- Add pitch/reverse/stretch/gain chips.
- Apply metadata priority rules.
- Keep pattern rename and double-click hit zones unchanged.

### Pass 5E

Likely files:

- `ui/src/components/timeline/timelineDrawing.js`
- `ui/src/styles/app.css`
- `ui/src/theming/shipped/xleth-default.json` only if visual audit proves a token value needs adjustment.
- `ui/src/theming/shipped/xleth-light.json` only if visual audit proves a token value needs adjustment.
- `ui/src/theming/tokens/catalog.ts` only if a new token is truly needed.

Purpose:

- Visual audit in default and light themes.
- Performance check under dense clips and WORLD spinner redraw.
- Final cleanup and small refinements.
- Defer new theme tokens unless there is a concrete contrast failure that cannot be solved with existing tokens/formulas.

## No-Touch Zones

Do not touch these areas for Pass 5B through Pass 5D unless a separate task explicitly requires it:

- `engine/**`
- `bridge/**`
- JUCE code
- FFmpeg code
- OpenGL renderer code
- audio backend
- render backend
- project save/load schema
- package files
- Playwright baselines
- waveform cache invalidation semantics
- clip peak cache invalidation semantics
- Timeline tool hit testing
- snap behavior
- move/resize behavior
- split/delete behavior
- playback/playhead timing
- IPC bridge APIs

`ui/main.js` and `ui/preload.js` should also remain untouched for this feature because generic settings get/set APIs already exist.

## Implementation Pass Breakdown

### Pass 5B: Settings and UI Plumbing

Goals:

- Add a validated `timelineDisplaySettings` store.
- Persist settings through `window.xleth.settings`.
- Add a Timeline toolbar display popover.
- Wire settings into `TimelineView.jsx`.
- Pass settings into `TimelineCanvas.jsx`.
- Trigger content redraw when settings change.
- Thread settings to drawing functions as optional parameters.

Non-goals:

- No body mode rendering changes.
- No text layout changes.
- No metadata chip rendering.
- No waveform renderer changes.
- No project schema changes.

Acceptance checks:

- Changing a display setting persists across app restart.
- Changing a display setting causes Timeline content redraw.
- Existing Timeline visuals remain unchanged because drawing has not yet consumed the settings.

### Pass 5C: Body Modes and Preview Visibility

Goals:

- Implement shared body material helper.
- Support clip body mode and pattern body mode.
- Support gradient direction.
- Support contrast levels.
- Gate waveform previews by `timelineShowWaveforms`.
- Gate pattern previews by `timelineShowPatternPreview`.
- Preserve current name and metadata behavior.

Non-goals:

- No new metadata chip layout.
- No new name truncation.
- No new theme tokens.
- No hit-test changes.

Acceptance checks:

- Minimal, plain, gradient, and solid modes are visibly distinct.
- Clip and pattern modes can differ.
- Waveforms and pattern previews obey visibility settings.
- Selection, fades, loop glyphs, and handles remain intact.
- Dense Timeline performance remains acceptable.

### Pass 5D: Names and Metadata Chips

Goals:

- Implement name auto/always/never behavior.
- Implement measured truncation.
- Implement pitch/reverse/stretch/gain chips.
- Enforce width priority rules.
- Keep pattern names readable without breaking rename/open behavior.

Non-goals:

- No project schema changes.
- No engine behavior.
- No inline metadata style.
- No separate gain setting.

Acceptance checks:

- Tiny clips hide unreadable text.
- Narrow clips do not show clipped garbage text.
- Medium clips prioritize names and previews.
- Wide clips show names, previews, and metadata chips.
- Pitch/gain chips never overlap handles or escape clip bounds.

### Pass 5E: Visual Audit and Cleanup

Goals:

- Check default and light themes.
- Check dense timelines.
- Check selected, muted, faded, looped, and pattern-heavy cases.
- Check zoom levels across waveform renderer regimes.
- Profile gradient mode if needed.
- Add theme tokens only if a real contrast problem remains.

Non-goals:

- No broad UI redesign.
- No engine changes.
- No behavior changes outside the display feature.

## Open Questions

1. Should pattern body mode be separately controllable in the UI, or should the UI default to a linked "match clips" interaction later?

Recommendation: persist separate clip and pattern modes now, but do not add a linking preference in v1.

2. Should gain labels have independent visibility?

Recommendation: no for v1. Gain should follow the same metadata visibility as pitch/reverse/stretch chips. Add `timelineShowGain` only if users need independent gain labels.

3. Should inline pitch metadata be supported?

Recommendation: no for v1. Use chip style only. The current inline-style text is one of the readability problems this pass is meant to solve.

4. Should display settings ever be project-local?

Recommendation: no for v1. Keep these global user preferences. Revisit only if Xleth later supports named workspace layouts or project view presets.

5. Should new theme tokens be added for metadata chips?

Recommendation: no for v1. Reuse `clipPitchBoxBg` and `clipPitchBoxFg`, then audit.

6. Should overlay drag previews use the selected body mode?

Recommendation: no for v1. Keep overlays stable until committed clip/pattern rendering is finished.

## Summary Recommendation

Implement Timeline display modes as a renderer-only, globally persisted user preference. Keep project data, engine data, clip geometry, pattern geometry, hit testing, and playback untouched.

The safest path is:

1. Pass 5B wires validated settings and a Timeline toolbar popover without visual changes.
2. Pass 5C implements body modes and preview visibility in `timelineDrawing.js`.
3. Pass 5D implements smarter names and metadata chips.
4. Pass 5E performs visual/performance audit and only then considers additional tokens.

This keeps the feature useful, testable, and visually focused without overbuilding the settings matrix or disturbing Timeline behavior.

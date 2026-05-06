# UI Depth Pass 6A: Track Color Palette + Timeline Color Source Diagnostic

Date: 2026-05-05

Scope: read-only diagnostic plus this report. No source, CSS, theme, schema,
engine, bridge, IPC, package, or baseline changes were made.

## Summary verdict

The requested track-owned Timeline color model fits the codebase, but the safest
route is staged. Timeline clip and pattern bodies are currently not track-owned:
audio clips resolve their base color from the placed region label, and pattern
blocks resolve their base color from the pattern region label. Track header
strips use a separate index-based label-token cycle, so the strip is visually
related only by coincidence and is not the source of truth.

The renderer can switch visible Timeline clip and pattern colors to resolved
track colors without rewriting the canvas renderer. The existing Pass 5C body
material helper and Pass 5D title-strip helper already accept a `baseHex`; the
future change should only replace the caller-supplied `baseHex` with a resolved
track color and keep muted, selected, contrast, gradient, waveform, metadata chip,
and display-mode behavior intact.

The track data model does not currently carry arbitrary metadata. Persisted
track color overrides require explicit C++ `TrackInfo`, JSON, bridge, preload,
IPC, and undo-command work. A visual auto-color pass can land before that by
deriving colors from visible track order and a theme palette, with no project
schema change.

Theme infrastructure is ready for a fixed palette token set. The Advanced Theme
Editor will discover new solid hex tokens automatically once they are added to
the token catalog, shipped themes, and validation path. A dedicated later editor
surface is still recommended, because the current "Save as New Theme" path strips
all explicit token overrides except the five base tokens.

## Files inspected

Timeline drawing and tools:

- `ui/src/components/timeline/timelineDrawing.js`
- `ui/src/components/timeline/TimelineCanvas.jsx`
- `ui/src/components/timeline/TrackHeader.jsx`
- `ui/src/components/timeline/TrackHeaderList.jsx`
- `ui/src/components/timeline/TrackContextMenu.jsx`
- `ui/src/components/timeline/tools/selectTool.js`
- `ui/src/components/timeline/tools/pencilTool.js`
- `ui/src/components/TimelineView.jsx`
- `ui/src/components/timeline/PatternListPanel.jsx`
- `ui/src/components/SampleSelector/SampleThumbnail.jsx`
- `ui/src/constants/labels.js`

Track, clip, pattern, bridge, and project model:

- `engine/src/model/TimelineTypes.h`
- `engine/src/model/Track.cpp`
- `engine/src/model/Clip.cpp`
- `engine/src/model/Pattern.cpp`
- `engine/src/model/PatternBlock.cpp`
- `engine/src/model/Timeline.cpp`
- `engine/src/model/Timeline.h`
- `engine/src/commands/TimelineCommands.cpp`
- `engine/src/commands/TimelineCommands.h`
- `bridge/src/XlethAddon.cpp`
- `ui/main.js`
- `ui/preload.js`
- `ui/src/stores/mixerStore.js`
- `ui/src/timelineEvents.js`

Theme system and editor:

- `ui/src/theming/tokens/catalog.ts`
- `ui/src/theming/shipped/xleth-default.json`
- `ui/src/theming/shipped/xleth-light.json`
- `ui/src/theming/runtime/ThemeProvider.tsx`
- `ui/src/theming/runtime/applyTheme.ts`
- `ui/src/theming/runtime/tokenValue.ts`
- `ui/src/theming/runtime/ThemeLoader.ts`
- `ui/src/theming/runtime/ThemeWriter.ts`
- `ui/src/theming/schema/themeSchema.ts`
- `ui/src/theming/editor/ThemeEditor.tsx`
- `ui/src/theming/editor/AdvancedMode.tsx`
- `ui/src/theming/editor/SimpleMode.tsx`
- `ui/src/theming/editor/TokenRow.tsx`
- `ui/src/theming/editor/ColorPicker.tsx`
- `ui/src/theming/editor/TimelinePreview.tsx`

## Current Timeline color source map

| Surface | Current source | Finding | Future source |
| --- | --- | --- | --- |
| Audio clip body, border, selected handles, title strip | `labelHexColor(region?.label)` in `drawClips()` | Label/sample-category derived. Not track-derived. | Resolved track color by `clip.trackId`, fallback to label color. |
| Pattern block body, border, dashed top border, resize handle, title strip, mini notes | `labelHexColor(region?.label)` where `region` comes from `patterns[block.patternId].regionId` | Pattern-region/sample-category derived. Not track-derived. | Resolved track color by `block.trackId`, fallback to pattern region label color. |
| Track header color strip | `LABEL_TOKENS[index % LABEL_TOKENS.length]` in `TrackHeader.jsx` | Index-based cycle through label tokens plus focus token. Not track metadata and not the same resolver as clips. | Same resolved track color map used by canvas. |
| Pattern track header tint | `hexToRgba(color, 0.06)` using the same header color | Also index-based. | Same resolved track color, with validated hex or safe alpha helper. |
| Timeline lane beds | `--theme-timeline-lane-bg`, pattern rows get `--theme-timeline-pattern-lane-tint` | Neutral lane architecture is already separate from clip color. | Keep neutral; do not color whole lane except very subtle optional future tint. |
| Clip title text | `--theme-timeline-clip-title-fg` | Token-based foreground, not semantic color. | Keep unchanged. |
| Pattern title text | `--theme-timeline-clip-title-fg` | Token-based foreground. | Keep unchanged. |
| Metadata chips | `--theme-timeline-fade-curve-fill`, `--theme-text`, chip-local drawing | Neutral metadata, not semantic color. | Keep unchanged. |
| Waveform preview | `--theme-timeline-clip-waveform-fg` and `--theme-timeline-clip-waveform-bg`, with some fallback envelope whites | Mostly token-based for readability. | Keep waveform tokens; do not recolor waveforms unless later contrast QA says to. |
| Pattern mini-note preview | `hexToRgba(hex, 0.95)` where `hex` is the pattern region label color | Currently category-derived. | Track color is acceptable, but QA light/dark contrast. Consider waveform/text token fallback if mini notes become unclear. |
| Drop preview from Sample Selector/source/pattern | Computed in `TimelineView.handleCanvasDragOver()` from sample label, source custom label, or pattern region label | Preview is category-derived before placement. | Prefer target track color once the hovered track is known, fallback to current drag payload color. |
| Select/pencil move, resize, ghost overlays | `selectTool.js` and `pencilTool.js` use `labelHexColor(region?.label)` | Tool overlays are still category-derived. | Thread the same track color resolver into tools, or compute preview color from target track during drag. |
| WORLD processing spinner | `palette.accent` | Not related to clip identity. | Keep unchanged. |

Important helpers:

- `labelHexColor(label)` maps `Kick`, `Snare`, `HiHat`, `Crash`, `Pitch`,
  `Quote`, `Custom`, and fallback values to `--theme-label-*` tokens through
  `tokenValue()`.
- `resolveTimelinePalette()` already resolves Timeline canvas tokens once per
  redraw. It does not currently include a track color palette.
- `getTimelineBodyMaterial()` accepts `baseHex` plus display settings and can
  remain unchanged if callers pass track color as `baseHex`.
- `getTitleStripStyle()` also accepts `baseHex` and can remain unchanged.
- `hexToRgba(hex, alpha)` only handles `#RRGGBB` by slicing the string. Palette
  tokens consumed by body/title helpers must resolve to valid hex, or a future
  helper must validate/fallback before calling `hexToRgba`.
- `withAlpha()` is more tolerant and supports `rgb()`, `rgba()`, `#RRGGBB`, and
  `#RGB`, but the body helper and several clip surfaces call `hexToRgba()`.

## Track model findings

Current `TrackInfo` fields are explicit engine fields:

- Identity and ordering: `id`, `name`, `order`
- Mix state: `volume`, `pan`, `stereoSpread`, `muted`, `solo`, `visualOnly`
- Video layout: `videoX`, `videoY`, `videoW`, `videoH`, `videoOpacity`,
  `videoZOrder`
- Type: `type` as `Clip` or `Pattern`
- Video behavior: `videoFlipConfig`, `videoHoldLastFrame`
- Grid/visual settings: `gapScaleOverride`, `cornerRadius`, `subdivisionFactor`,
  `bounce`, `pingPong`, `zoomPanRot`, `slideNoteEffect`,
  `visualEffectChain`

There is no `trackColorMode`, `trackColorSlot`, raw color, metadata bag, or
arbitrary extension field. `Track.cpp` serializes and deserializes fields
manually. Unknown JSON fields are not preserved. Adding track color metadata is
a real schema/bridge change, not just a UI object patch.

Track creation:

- UI `handleAddTrack()` calls `window.xleth.timeline.addTrack({ name })`.
- Bridge `Timeline_AddTrack()` accepts `name`, optional mix/order fields, then
  applies `AddTrackCommand`.
- Engine `Timeline::addTrack()` assigns a new id and stores the track in
  `m_tracks`.

Track order and auto color:

- `TimelineCanvas` builds `trackId -> visible index` from the React `tracks`
  array.
- Engine `getAllTracks()` returns the `std::map<int, TrackInfo>` iteration
  order, which is id order. It does not sort by `TrackInfo.order`.
- UI drag reordering in `TimelineView.handleReorder()` is local-only and is not
  persisted to engine/project data.
- Auto color by visible index is deterministic and correct for the current UI,
  but after reload it follows engine-returned order unless track order
  persistence is fixed elsewhere.

Track conversion and duplication:

- Clip-to-pattern and pattern-to-clip conversion use undo-tracked bridge commands
  and mutate `TrackInfo::type`. They should leave future color metadata intact.
- No real track duplication path was found. There is clip duplication, and a
  `Duplicate` context menu item near clip menu code currently calls
  `handleAddTrack()`, so future track duplication behavior should be specified
  before relying on it.

Undo/redo:

- Existing track commands snapshot `TrackInfo` for add/remove and use dedicated
  commands for rename/mute/solo/visual-only and visual settings.
- A persisted color override should be an undoable track mutation, likely
  `SetTrackColorCommand`, rather than a local React-only edit.
- Once color fields live in `TrackInfo`, add/remove undo snapshots should carry
  them automatically. The color mutation itself still needs its own command.

Bridge/API:

- `trackToJs()` and `jsToTrack()` in `bridge/src/XlethAddon.cpp` do not expose
  or ingest color fields.
- `ui/main.js` and `ui/preload.js` expose track add/get/mute/solo/name/etc.,
  but no color setter.
- Pass 6D should add bridge/preload/main plumbing for a small, explicit API such
  as `timeline.setTrackColor(trackId, { mode, slot })`.

## Clip/pattern placement findings

Clips and pattern blocks do not store colors:

- `Clip` stores placement/playback fields such as `trackId`, `regionId`,
  `position`, `duration`, offsets, pitch, velocity, reverse/stretch, fade, and
  syllable data. No label or color is stored on the clip.
- `Pattern` stores `id`, `name`, `regionId`, `length`, notes, and sampler-ish
  pattern data. No color is stored.
- `PatternBlock` stores `trackId`, `patternId`, `position`, `duration`,
  `offset`, and `loopEnabled`. No color is stored.

Placement code assigns labels/categories to sample regions, not to Timeline
placements:

- Dragging a Sample Selector item to a clip track creates a clip with `trackId`
  and `regionId`; its color later comes from the region label at render time.
- Dragging a `Pitch` sample to a pattern track may create/find a pattern from
  the region and then create a pattern block; its color later comes from the
  pattern's region label.
- Source drops create a `Custom` region and then a clip.
- Pencil ghosts and move/resize previews use label colors for feedback, but
  they do not persist color.

This means the first renderer change can be visual-only. Saved clip and pattern
data does not need to change for clips/patterns to inherit track color. Sample
category identity should remain in Sample Selector thumbnails, drag payload
metadata, Pattern List where useful, and labels/chips if needed, but it should
not dominate placed Timeline body color.

## Theme/Theme Editor findings

Theme runtime readiness:

- `resolveTimelinePalette()` already centralizes Timeline canvas token reads once
  per draw cycle.
- `tokenValue()` reads computed CSS variables directly and has no cache. It is
  safe in redraw setup, but should not be used inside per-clip/per-block loops.
- `ThemeProvider` writes resolved tokens to `document.documentElement` and emits
  `xleth-theme-changed`.
- `TimelineView` listens for `xleth-theme-changed` and calls
  `redrawGrid('theme')`, `redrawContent('theme')`, and ruler redraw, so a new
  palette token set can repaint the Timeline without a new event channel.

Token catalog readiness:

- Current Timeline tokens include lane, grid, clip title, waveform, fade,
  pattern tint, playhead, and `--theme-timeline-track-color-stripe`, but no track
  palette.
- Current label tokens are top-level `--theme-label-*` colors and the catalog
  comment says they are used across sample selector, grid editor, Timeline track
  stripes, and pattern list. Timeline clip bodies currently use them indirectly
  through `labelHexColor()`.
- New palette tokens should be solid hex color tokens so `TokenRow` can show a
  `ColorPicker` and so `hexToRgba()` consumers remain safe.

Theme Editor readiness:

- Advanced mode iterates the token catalog by category/subsystem, so new catalog
  tokens will appear automatically.
- `TokenRow` only exposes `ColorPicker` when the resolved value is hex. Palette
  defaults should not be `var(...)`, `rgb(...)`, or `rgba(...)` if the first
  implementation expects direct editing.
- Simple mode has only five base color knobs and will not expose track palette
  controls without a new UI.
- `ThemeEditor.handleSaveNew()` currently saves only five base tokens and drops
  all other explicit overrides. This is fine for the current simple workflow but
  must be changed before marketing the palette as user-editable through the
  Theme Editor, or a user can edit palette slots in Advanced mode and lose them
  when saving as a new theme.
- `ThemeWriter` validates before persistence when used through the runtime
  writer; the editor also uses direct `window.xleth.theme.saveUser` paths, so
  validation behavior should be confirmed in the main/preload side during the
  Theme Editor pass.

## Recommended architecture

Use a fixed 16-slot theme-owned Timeline track palette and track-owned assignment
metadata:

```ts
trackColorMode: 'auto' | 'paletteSlot'
trackColorSlot?: number // 1-based, valid only when mode is paletteSlot
```

Recommended token naming for the first implementation:

```css
--theme-timeline-track-palette-1
--theme-timeline-track-palette-2
...
--theme-timeline-track-palette-16
```

The prompt-suggested `--theme-track-palette-N` model is also workable. The
Timeline-prefixed form fits the existing catalog naming convention better
because all current Timeline-specific drawing tokens are `--theme-timeline-*`.
If the Mixer or Grid Editor later needs the exact same project track identity
colors, introduce global aliases or migrate to `--theme-track-palette-N` in a
dedicated follow-up. The renderer should not care about token names after
`resolveTimelinePalette()` returns a `trackPalette` array.

Resolution rules:

1. Resolve all 16 palette tokens once per redraw.
2. Build `trackId -> resolvedTrackColorHex` once per redraw from the visible
   track list.
3. If `track.trackColorMode === 'paletteSlot'` and the slot is valid, use that
   slot.
4. Otherwise use auto slot by visible track index: `(index % palette.length)`.
5. If the palette is absent or a value is invalid for `hexToRgba()`, fallback to
   the current label/category source for clip and pattern bodies, and to the
   existing header cycle or accent for header strips.

Do not add raw custom per-track hex in the first implementation. It adds schema,
contrast, validation, and UI complexity before the theme palette workflow is
proven.

## Proposed default 16-color palette

Use theme-specific values. Dark theme slots can be moderately luminous against
`#07070B`; light theme slots should be darker to remain readable against
`#CACAC6` with Pass 5E body alpha formulas. Sixteen slots are safer than twelve
for real arrangements because auto assignment wraps later, gives more separation
between nearby rows, and aligns with common DAW color-palette scale.

| Slot | Suggested role | Dark value | Light value |
| --- | --- | --- | --- |
| 1 | Chorus/fullscreen | `#4CC9F0` | `#167FA3` |
| 2 | Pitch/melodic | `#7BD88F` | `#2E8B57` |
| 3 | Percussion/hits | `#FF9F5A` | `#C45F20` |
| 4 | Bass | `#9B7BFF` | `#6D54C7` |
| 5 | FX | `#F472B6` | `#B83E7F` |
| 6 | Vocals/dialogue | `#FFD166` | `#B7791F` |
| 7 | Lead/quote | `#5B8DEF` | `#2F5FBA` |
| 8 | Texture/ambience | `#2DD4BF` | `#147D72` |
| 9 | Impact/accent hit | `#FF6B6B` | `#B93D3D` |
| 10 | Groove/secondary perc | `#A3D65C` | `#6F8F24` |
| 11 | Harmony/pads | `#C084FC` | `#7E4CB8` |
| 12 | Sparkle/high FX | `#38BDF8` | `#1878A8` |
| 13 | Build/transition | `#FBBF24` | `#A66500` |
| 14 | Utility/guide | `#8EA4D2` | `#566C9A` |
| 15 | Doubles/backing | `#6EE7B7` | `#208A68` |
| 16 | Adlibs/alternate vocal | `#FB7185` | `#B43A52` |

The set intentionally avoids a single-hue family and avoids overly neon colors.
It still includes some semantic continuity with the existing label palette, but
Timeline color ownership becomes track-based rather than sample-label-based.

## Renderer integration plan

Answering the renderer design questions directly:

- `resolveTimelinePalette()` should include `trackPalette`, preferably an array
  of 16 resolved hex strings.
- `drawClips()` and `drawPatternBlocks()` should receive a precomputed
  `trackColorById` map, not `tracksById`, and not a resolver that reads tokens.
- Track data is available in `TimelineCanvas` as `tracksRef.current`, but
  `drawClips()` and `drawPatternBlocks()` currently receive only
  `trackIdToIndex`.
- Thread the lookup at `TimelineCanvas.redrawContent()`, next to the existing
  `mutedTrackIds`, `trackIdToIndexRef`, and `palette` setup.
- Avoid token lookups in clip loops by resolving palette once, building the map
  once, then doing only object lookup per clip/block.
- Keep `getTimelineBodyMaterial()` unchanged except the caller's `baseHex`.
- Keep `getTitleStripStyle()` unchanged except the caller's `baseHex`.
- Preserve selected/muted/body-mode behavior by passing the existing `selected`,
  `muted`, `contrast`, `mode`, and `gradientDirection` values unchanged.
- Preserve waveform readability by leaving waveform foreground/background token
  usage unchanged.
- Preserve metadata chip readability by leaving chip drawing unchanged.

Preferred code shape for Pass 6C:

```js
const palette = resolveTimelinePalette()
const trackColorById = buildResolvedTrackColorMap(tracksRef.current, palette.trackPalette)

drawClips(
  ctx, w, h,
  scrollOffsetRef.current, pixelsPerBeatRef.current,
  clipsRef.current, tidx, regionsRef.current,
  selectedRef.current, waveformCacheRef?.current, hiResCacheRef?.current,
  clipPeakCacheRef?.current, bpmRef?.current,
  mutedTrackIds, palette,
  timelineDisplaySettingsRef.current,
  trackColorById
)
```

Inside the draw loops:

```js
const fallbackHex = labelHexColor(region?.label)
const hex = trackColorById?.[clip.trackId] || fallbackHex
```

For pattern blocks:

```js
const fallbackHex = labelHexColor(region?.label)
const hex = trackColorById?.[block.trackId] || fallbackHex
```

Header strip integration should use the same shared resolver, not a duplicate
`LABEL_TOKENS` cycle. Ideally create a small UI helper module, for example
`ui/src/components/timeline/trackColorResolver.js`, that exports:

- `resolveTimelineTrackPalette(palette)`
- `buildResolvedTrackColorMap(tracks, trackPalette)`
- `resolveTrackColor(track, visibleIndex, trackPalette, fallback)`

Then `TimelineCanvas` and `TrackHeaderList` can share exact behavior.

Overlay/tool follow-up:

- Drop previews should use target track color because the target track index is
  known in `handleCanvasDragOver()`.
- Select and pencil tools should receive either `trackColorByIdRef` or a
  side-effect-free `getTrackColor(trackId)` callback in `toolDeps`.
- Until those are wired, the main clip/block body change can be correct while
  some previews still appear label-colored. Acceptance should explicitly include
  previews if Pass 6C is meant to be visually complete.

## Track metadata/persistence plan

Persisted override fields should live on `TrackInfo`:

```cpp
enum class TrackColorMode { Auto, PaletteSlot };
TrackColorMode trackColorMode = TrackColorMode::Auto;
int trackColorSlot = -1; // 1..16 when PaletteSlot, otherwise -1
```

If a string enum is preferred for JSON readability, store `"auto"` and
`"paletteSlot"` in JSON and convert internally. Either way, load defaults must
be tolerant.

Engine work:

- Add fields to `TrackInfo`.
- Add conversion helpers for mode.
- Add `to_json()` entries.
- Add `from_json()` defaults with `j.value(...)`, not `j.at(...)`.
- Sanitize invalid mode/slot to auto.
- Add `Timeline::setTrackColor(...)` or equivalent.
- Add an undoable `SetTrackColorCommand`.

Bridge/UI work:

- Add fields to `trackToJs()`.
- Accept fields in `jsToTrack()` for new-track creation only if desired; default
  should still be auto.
- Add bridge export, `ui/main.js` handler, and `ui/preload.js` API for setting
  color metadata.
- Add a `TimelineView.handleSetTrackColor()` that calls the API, refreshes
  tracks, syncs mixer state if necessary, and dispatches
  `timeline-tracks-changed`.

Schema version:

- A project version bump is not required if fields are optional, defaulted, and
  sanitized on load. The current version guidance says to bump for breaking
  schema changes requiring migration. This change can be non-breaking.
- If the team wants an explicit migration milestone for release notes, bumping
  to v4 is acceptable, but it is not technically necessary for safe old-project
  loading.

## Track color picker UI plan

Best location:

- Primary: click the color strip in `TrackHeader.jsx`.
- Secondary: add a `Track Color` item to `TrackContextMenu.jsx` for keyboard or
  right-click discoverability.

Popover behavior:

- Open a small palette popover anchored to the color strip.
- Options: `Auto`, slots 1 through 16, and possibly `Reset to Auto` as the same
  command as `Auto`.
- Show swatches using the current resolved theme palette.
- Mark the active option based on `trackColorMode` and `trackColorSlot`.
- Commit through an undoable project mutation, not through theme settings.

Reuse candidates:

- `TrackContextMenu.jsx` already supports nested submenus, but its row model is
  text-first. It can host a simple `Track Color` submenu, but a swatch grid would
  likely need a small popover component.
- `TrackFlipPropertiesPanel` uses anchored popover behavior from
  `TimelineView`; its placement pattern is a good model for a color popover.

Undo/redo and data ownership:

- Track override choice is project data.
- Palette slot values are theme data.
- Track color changes should be undoable like rename/mute/visual-only.
- Theme palette edits should not be undoable through project undo; they belong
  to theme persistence.

## Theme Editor palette editing plan

Pass 6B should only add token foundation. Pass 6F should make editing pleasant:

- Add 16 solid hex tokens to the catalog and shipped themes.
- Ensure warm/cool or other shipped themes also receive values if they exist in
  this repo beyond default/light.
- Advanced mode will expose the tokens automatically.
- Add a dedicated `Track Palette` editor section later, because hunting 16 tokens
  in Advanced mode is not a DAW-quality workflow.
- Fix `ThemeEditor.handleSaveNew()` so non-base explicit overrides, including
  track palette slots, are not silently stripped when the user saves a custom
  theme.
- Update `TimelinePreview.tsx` to demonstrate multiple track colors after the
  palette tokens exist.
- Confirm validation on every direct save path.

Canvas efficiency:

- Theme switching already emits `xleth-theme-changed` and `TimelineView` already
  redraws grid/content/ruler on that event.
- The future palette resolver should read 16 token values once per redraw, not
  once per clip.

## Migration/fallback strategy

Existing projects:

- Tracks without color metadata render with auto palette slots by visible track
  order.
- Missing or invalid `trackColorMode` becomes auto.
- Missing, zero, negative, non-integer, or out-of-range `trackColorSlot` becomes
  auto.
- If palette tokens do not exist or do not resolve to usable hex, clips and
  pattern blocks fallback to the current label-derived color path.
- Old project JSON must not fail load because new fields are missing.

Renderer fallback:

- Clip fallback: `labelHexColor(region?.label)`.
- Pattern block fallback: `labelHexColor(patternRegion?.label)`.
- Header strip fallback: existing index token cycle or `palette.accent`.
- Drop/tool preview fallback: current drag/region label color.

Bridge/engine:

- C++ owns tracks and project JSON. The Node-API bridge is required for persisted
  track color metadata and a picker UI.
- Engine audio/video behavior should not change. Track color is metadata used by
  UI rendering and project save/load only.
- Undo/redo snapshots that store full `TrackInfo` should carry the fields after
  they are added. Dedicated color mutation still needs its own undo command.

## Recommended implementation pass breakdown

Pass 6B: track palette token foundation

- Add 16 solid hex track palette tokens to the theme token catalog.
- Add shipped default and light values.
- Add values to any other shipped themes present in the repo.
- Add/adjust token tests and theme validation tests.
- Do not add renderer consumers yet.

Pass 6C: auto-only Timeline color resolver plumbing

- Add a shared Timeline track color resolver.
- Extend `resolveTimelinePalette()` to include `trackPalette`.
- Build `trackId -> resolvedTrackColorHex` once per Timeline redraw.
- Thread the map to `drawClips()` and `drawPatternBlocks()`.
- Update header strip to use the same resolver.
- Update drop preview and tool overlays if the pass is intended to be visually
  complete; otherwise document them as temporary follow-up.
- Keep project schema unchanged and render all tracks as auto.

Pass 6D: track metadata and project persistence

- Add `trackColorMode` and `trackColorSlot` to `TrackInfo`.
- Update JSON serialization/deserialization with old-project defaults.
- Add bridge/preload/main get/set plumbing.
- Add undoable track color command.
- Update track creation defaults to auto.
- Add tests for old project load, invalid slot fallback, set/undo/redo, and save
  roundtrip.

Pass 6E: track color picker UI

- Make the track header strip clickable.
- Add anchored popover with `Auto` and 16 palette swatches.
- Add optional context-menu entry.
- Commit through the new track color API.
- Refresh tracks and redraw Timeline after selection.
- Verify undo/redo and project save/load behavior.

Pass 6F: Theme Editor track palette editing

- Add a dedicated Theme Editor palette section.
- Preserve palette overrides when saving custom themes.
- Update Timeline preview to show track palette slots.
- Verify theme switch and palette edits redraw Timeline immediately.
- Add light/dark visual QA and validation tests.

## Risk analysis

- Project schema compatibility: new `TrackInfo` fields must use safe defaults and
  sanitization. Avoid `j.at()` for new fields.
- Old project load behavior: any missing field must load cleanly and render auto.
- Track duplication behavior: no true track duplication path exists today; define
  whether duplicates copy explicit slot or reset to auto before adding that UI.
- Undo/redo behavior: project data changes need a dedicated command; local React
  changes would desync save/undo.
- Theme token sprawl: 16 new tokens are justified, but should be grouped clearly.
- Light-theme contrast: dark-theme colors are too bright for light lanes; shipped
  light values should be darker.
- Visual noise: many saturated rows can become busy. The Pass 5E muted/body alpha
  formulas need QA with the whole 16-slot cycle.
- Sample category identity loss: keep label colors in Sample Selector, thumbnails,
  label dots, drag metadata, and optional chips. Only placed Timeline body color
  should become track-owned.
- Canvas performance: do not read CSS variables inside clip or block loops.
- Partial rollout surprise: if Pass 6C changes colors before picker UI exists,
  users get deterministic auto colors but no override until Pass 6E.
- Selected/muted clarity: existing muted multiplier and selection highlight must
  stay legible for every palette slot.
- Colorblind accessibility: a hue-only palette is imperfect. Consider future
  secondary cues such as strip labels, icons, or subtle patterning.
- Invalid custom theme values: `hexToRgba()` assumes `#RRGGBB`; validate or
  fallback before passing palette values into body/title helpers.
- Local-only reorder: auto colors follow visible order in the current session,
  but reload order follows engine return order until track order persistence is
  addressed.

## Acceptance criteria

- Track header strip and all audio clips on that track share the same resolved
  track color.
- Track header strip and all pattern blocks on that track share the same resolved
  track color.
- Existing projects without color metadata load safely and render auto colors.
- Auto color assignment is deterministic and never random.
- Track colors derive from a user-editable theme palette.
- Sample Selector category colors remain useful inside the Sample Selector and do
  not dominate placed Timeline clip/pattern body colors.
- Timeline display modes still work.
- Clip and pattern body modes still work.
- Muted and selected states remain readable.
- Waveform and pattern mini-note previews remain readable.
- No per-clip or per-block CSS token lookups are introduced.
- No canvas performance regression is visible on large arrangements.
- No engine audio/video behavior changes.
- Light theme remains readable.
- Build and relevant UI/bridge/theme tests pass.

## Open questions

- Should the long-term token names be Timeline-scoped
  `--theme-timeline-track-palette-N` or global `--theme-track-palette-N` for
  future Mixer/Grid reuse? Recommendation: Timeline-scoped first, global alias
  later only if another surface consumes the same pool.
- Should auto assignment follow visible UI order, persisted `TrackInfo.order`, or
  stable engine id? Recommendation: visible order for DAW behavior, plus a
  separate future fix to persist track reorder if saved order matters.
- Should a duplicated track copy an explicit palette slot or reset to auto?
  Recommendation: auto tracks stay auto; explicit tracks copy their explicit slot
  only for a real "duplicate track" command.
- Should pattern mini-note preview use track color or a neutral preview token?
  Recommendation: start with track color for consistency and QA contrast.
- Should the Theme Editor expose track palette editing in Simple mode, Advanced
  mode, or a dedicated third section? Recommendation: dedicated section in Pass
  6F, with Advanced support as the baseline.

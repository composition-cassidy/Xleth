# UI Depth — Pass 6F: Custom track color foundation

## Goal & Scope

Pass 6F adds a third track color mode — **`custom`** — at the data, persistence, command, bridge, IPC, and resolver layers. A track can now carry a free `#RRGGBB` hex color alongside the existing `auto` (Pass 6C) and `paletteSlot` (Pass 6D) modes.

This pass is foundation-only: every layer below the picker UI is wired and tested. **Pass 6G adds the actual user-facing custom-color picker control.** Until then, custom mode is reachable only via devtools or programmatic callers of `setTrackColor`.

Out of scope: TrackColorPopover changes, Theme Editor, palette token edits, theme JSONs, app.css, Timeline drawing geometry, audio/render engine.

## Files Changed

| Layer | File | Change |
|---|---|---|
| Engine model | `engine/src/model/TimelineTypes.h` | Added `Custom` to `TrackColorMode`; helpers `trackColorModeToString` / `stringToTrackColorMode` recognize `"custom"`; new inline helpers `isValidTrackCustomColor`, `normalizeTrackCustomColor`; new `std::string trackColorCustom` field on `TrackInfo` |
| Engine model | `engine/src/model/Track.cpp` | `to_json` writes `trackColorCustom` only when `mode == Custom && hex valid`; `from_json` ingests it through the same sanitize path used by setter and bridge |
| Engine model | `engine/src/model/Timeline.h` / `.cpp` | Extended `setTrackColor` signature: `(trackId, mode, slot, customColor = "")`; unified sanitization clears slot when Custom and custom when PaletteSlot; logs all three values |
| Engine commands | `engine/src/commands/TimelineCommands.h` / `.cpp` | `SetTrackColorCommand` snapshots `oldCustom_` and accepts `newCustomColor`; `describe()` now includes hex when Custom |
| Bridge (N-API) | `bridge/src/XlethAddon.cpp` | `trackToJs` emits `trackColorCustom` for Custom + valid; `jsToTrack` ingests it through the same sanitizer; `Timeline_SetTrackColor` parses `customColor` from the payload object |
| IPC / preload | `ui/main.js`, `ui/preload.js` | **No code change** — handlers are payload-shape-agnostic and forward the new `{ mode: 'custom', customColor }` shape unchanged |
| Renderer | `ui/src/components/timeline/trackColorResolver.js` | Added `TRACK_COLOR_MODE_CUSTOM`, `isValidTrackCustomColor`, `normalizeTrackCustomColor`; extended `sanitizeTrackColorMode` and `normalizeTrackColorAssignment`; `resolveTrackColor` now returns the normalized custom hex when mode is Custom and hex is valid |
| Renderer | `ui/src/components/TimelineView.jsx` | Extended `handleSetTrackColor` to accept and sanitize `{ mode: 'custom', customColor }`; engine-less local fallback updates the local track shape correctly |
| Engine tests | `engine/test/test_timeline.cpp` | Added section [16] subcases 16h–16s: defaults, validation helpers, setter normalization, mode-switch clearing, JSON round-trip, JSON sanitization, undo/redo for Custom |
| UI tests | `ui/src/components/timeline/__tests__/trackColorResolver.test.js` | Added describes: `isValidTrackCustomColor`, `normalizeTrackCustomColor`, custom branches of `sanitizeTrackColorMode`, `normalizeTrackColorAssignment`, `resolveTrackColor`, mixed-mode `buildResolvedTrackColorMap`. Updated existing `normalizeTrackColorAssignment` expectations to include `customColor: null` |
| Docs | `docs/plans/ui-depth-pass6f-custom-track-color-foundation.md` | This file |

## Data Model

```cpp
enum class TrackColorMode { Auto, PaletteSlot, Custom };

struct TrackInfo {
    // ...
    TrackColorMode trackColorMode   = TrackColorMode::Auto;
    int            trackColorSlot   = 0;   // 1..16 when PaletteSlot
    std::string    trackColorCustom = ""; // "#RRGGBB" when Custom
};
```

JS-side track object shape:
```js
{
  trackColorMode: 'auto' | 'paletteSlot' | 'custom',
  trackColorSlot?: 1..16,                 // when paletteSlot
  trackColorCustom?: '#RRGGBB',           // when custom
}
```

## Validation Rules (single source of truth — mirrored at every layer)

| Input mode | slot | customColor | Result |
|---|---|---|---|
| `auto` (or missing) | any | any | mode=auto, slot=0, custom="" |
| `paletteSlot` | integer 1..16 | any | mode=paletteSlot, slot=N, custom="" |
| `paletteSlot` | other | any | mode=auto, slot=0, custom="" |
| `custom` | any | valid `#RRGGBB` | mode=custom, slot=0, custom=normalized uppercase |
| `custom` | any | missing/invalid | mode=auto, slot=0, custom="" |
| unknown string | any | any | mode=auto, slot=0, custom="" |

**Hex format:** strict `#RRGGBB` (7 characters, leading `#`, six hex digits). Case-insensitive on input. **Always normalized to uppercase** on storage so save files diff cleanly. Both engine and resolver mirror this normalization.

**Invalid examples (all → auto):** `#RGB`, `#1234567`, `4CC9F0` (no #), `#GGGGGG`, `rgb(0,0,0)`, `rgba(...)`, `var(--theme-accent)`, `hsl(...)`, empty string, non-string.

## JSON Emission Rules

- Always emit `trackColorMode`.
- Emit `trackColorSlot` only when `mode == PaletteSlot && slot ∈ 1..16`.
- Emit `trackColorCustom` only when `mode == Custom && isValidTrackCustomColor(hex)`.
- Never write `trackColorSlot` or `trackColorCustom` for Auto tracks (compact for the common case).
- **No project schema version bump.** Both new fields are additive and optional; old projects without them load as Auto. Same convention as Pass 6D.

## API Payload Shapes

```js
window.xleth.timeline.setTrackColor(trackId, { mode: 'auto' })
window.xleth.timeline.setTrackColor(trackId, { mode: 'paletteSlot', slot: 5 })
window.xleth.timeline.setTrackColor(trackId, { mode: 'custom', customColor: '#FF00AA' })
```

The C++ binding signature is:
```cpp
timeline_setTrackColor(trackId: number, {
    mode: 'auto' | 'paletteSlot' | 'custom',
    slot?: 1..16,
    customColor?: '#RRGGBB',
})
```

## Setter & Command Behavior

`Timeline::setTrackColor(trackId, mode, slot, customColor)` is the single sanitization point on the engine side. It:
1. Normalizes `customColor` via `normalizeTrackCustomColor`.
2. Picks the highest-priority valid mode: PaletteSlot if slot ∈ 1..16, otherwise Custom if hex valid, otherwise Auto.
3. Clears the irrelevant fields (slot=0 when not PaletteSlot, custom="" when not Custom).

`SetTrackColorCommand` snapshots `oldMode_`, `oldSlot_`, `oldCustom_` at construction; `execute()` applies the new triplet and `undo()` restores the prior triplet exactly. `describe()` produces strings like `"Set Track Color (track=3) → custom[#FF00AA]"`.

## Resolver Behavior

`normalizeTrackColorAssignment(track)` now returns `{ mode, slot, customColor }`:
- Auto: `{ 'auto', null, null }`
- PaletteSlot+valid: `{ 'paletteSlot', N, null }`
- Custom+valid hex: `{ 'custom', null, '#NORMALIZED' }`
- Any invalid combo collapses to Auto.

`resolveTrackColor(track, visibleIndex, palette, fallbackHex)` priority:
1. Custom + valid hex → return that hex (ignores palette/visibleIndex).
2. PaletteSlot + valid slot → return `palette[slot - 1]`.
3. Otherwise → return `palette[visibleIndex % palette.length]` or `fallbackHex`.

`buildResolvedTrackColorMap(tracks, palette)` is unchanged at the call-site level — it delegates per-track to `resolveTrackColor`, which now naturally handles all three modes.

`normalizeTrackPalette` is untouched.

## Tests Added

**Engine — `engine/test/test_timeline.cpp` section [16] subcases 16h–16s** (12 new sub-cases; existing 16a–16g unchanged):
- 16h: defaults — empty `trackColorCustom`, JSON omits field
- 16i: validation helpers (`isValidTrackCustomColor`, `normalizeTrackCustomColor`) — covers uppercase/lowercase/mixed, `#RGB`, missing `#`, non-hex chars, too-short, too-long, `rgb(...)`
- 16j: `setTrackColor(Custom, 0, "#4cc9f0")` stores `#4CC9F0`, slot cleared
- 16k: `setTrackColor(Custom, 0, "rgb(0,0,0)")` collapses to Auto
- 16l: switching Custom → PaletteSlot clears `trackColorCustom`
- 16m: switching Custom → Auto clears `trackColorCustom`
- 16n: Custom JSON round-trip preserves normalized hex; omits slot
- 16o: load with `mode: "custom"` + invalid hex → Auto
- 16p: load with `mode: "custom"` + missing hex → Auto
- 16q: `SetTrackColorCommand` undo from Custom → Auto restores Custom hex exactly
- 16r: redo of custom assignment reapplies normalized hex
- 16s: undo from PaletteSlot → Custom restores Custom (slot cleared)

**UI — `ui/src/components/timeline/__tests__/trackColorResolver.test.js`:**
- New describes: `isValidTrackCustomColor`, `normalizeTrackCustomColor`
- `sanitizeTrackColorMode`: `'custom'` accepted
- `normalizeTrackColorAssignment`: 5 new sub-cases for custom branch (valid, invalid, missing, drop on paletteSlot, drop on auto). Existing assertions updated to include `customColor: null`.
- `resolveTrackColor`: 4 new sub-cases (custom honored, custom uppercases, invalid custom → auto, missing custom → auto)
- `buildResolvedTrackColorMap`: 1 new sub-case mixing custom + paletteSlot + auto + invalid-custom
- `normalizeTrackPalette` unchanged

## Runtime Smoke (devtools recipe)

After native rebuild + Electron restart:

```js
// Pick a real track id from window.xleth.timeline.getTracks()
await window.xleth.timeline.setTrackColor(<trackId>, { mode: 'custom', customColor: '#FF00AA' })
```

Confirm:
1. Track strip recolors to `#FF00AA`.
2. Audio clips on that track recolor.
3. Pattern blocks on that track recolor.
4. Save Project → close → reopen — color persists.
5. Edit → Undo restores prior assignment.
6. Edit → Redo reapplies custom.
7. `await window.xleth.timeline.setTrackColor(<trackId>, { mode: 'auto' })` resets to visible-index auto, clearing the custom color.

## Backward Compatibility

- **Pre-Pass-6D projects** (no `trackColorMode`/`trackColorSlot`/`trackColorCustom`): load as Auto (unchanged from 6D).
- **Pass-6D / 6E projects** (`trackColorMode: 'auto' | 'paletteSlot'`): load and behave exactly as before — `trackColorCustom` defaults to empty.
- **Future Pass-6F+ projects** with custom hexes: persist round-trip through save/reopen.
- **Forward-compatibility:** any unknown future mode collapses to Auto in pre-6F builds, since `stringToTrackColorMode` returns Auto for unknown strings (preserved invariant).
- **No `kProjectFileVersion` bump.** Both new fields are optional; the loader is tolerant.

## Temporary UI Limitation

`TrackColorPopover` still shows only `Auto` + 16 palette swatches. Pass 6F deliberately does not expose custom mode in the picker — Pass 6G adds that input.

If a track is in `custom` mode (set via devtools or a future loaded project), the popover currently shows **neither** Auto nor any swatch as "selected". This is because:
- `mode === 'auto'` is false (mode is `custom`)
- No `slot === N` matches (slot is null)

Selecting Auto or a swatch from the popover still works correctly (the existing handler clears `trackColorCustom` on those branches via the engine setter). Pass 6G will add a custom swatch / hex input that surfaces the custom color and shows it as selected.

## Explicit Non-Touches

- `ui/src/components/timeline/TrackColorPopover.jsx` — unchanged
- `ui/src/components/timeline/TrackHeader.jsx` / `TrackHeaderList.jsx` — unchanged
- `ui/src/components/timeline/TimelineCanvas.jsx`, `timelineDrawing.js` — unchanged
- `ui/src/styles/app.css`, `ui/src/styles/windowing.css` — unchanged
- `ui/src/theming/**` (catalog.ts, shipped JSONs, Theme Editor UI) — unchanged
- audio / render / sampler / mix engine — unchanged
- Sample Selector / Mixer / Piano Roll / Sampler / Preview / Grid / plugin UIs — unchanged
- `package.json` / `package-lock.json` — unchanged
- Playwright baselines — unchanged
- `kProjectFileVersion` — unchanged (additive optional fields)

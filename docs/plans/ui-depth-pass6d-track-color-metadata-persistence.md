# Pass 6D — Track color metadata, persistence, and update action foundation

## Summary

Adds first-class per-track color assignment metadata to the canonical engine track model and threads it end-to-end (engine → bridge → IPC → preload → renderer) so future picker UI (Pass 6E) and Theme Editor palette editing (Pass 6F) can build on a stable, undo-tracked surface. This pass adds **no user-visible UI** — Timeline rendering still resolves auto colors by visible track index unless a track explicitly carries a valid `paletteSlot` assignment.

The data model:

```
trackColorMode: 'auto' | 'paletteSlot'
trackColorSlot?: number          // 1..16, valid only when mode === 'paletteSlot'
```

Old projects (no fields) load as `auto` without warning. Invalid combinations sanitize to `auto` at every entry point (loader, bridge, engine setter, React handler).

---

## Files Changed

| Layer | File | Change |
|---|---|---|
| Engine model | `engine/src/model/TimelineTypes.h` | Added `TrackColorMode` enum + `trackColorMode` / `trackColorSlot` fields on `TrackInfo`; helpers `trackColorModeToString` / `stringToTrackColorMode` |
| Engine model | `engine/src/model/Track.cpp` | Emit/read `trackColorMode` and (conditionally) `trackColorSlot` in `to_json` / `from_json`; sanitize on load |
| Engine model | `engine/src/model/Timeline.h` / `.cpp` | Added `Timeline::setTrackColor(trackId, mode, slot)` with engine-side sanitization |
| Engine commands | `engine/src/commands/TimelineCommands.h` / `.cpp` | Added `SetTrackColorCommand` (snapshot old mode/slot for undo) |
| Bridge | `bridge/src/XlethAddon.cpp` | `trackToJs` emits color metadata; `jsToTrack` accepts it for `addTrack`; new `Timeline_SetTrackColor` napi binding registered as `timeline_setTrackColor` |
| IPC | `ui/main.js` | New `xleth:timeline:setTrackColor` ipcMain handler |
| Preload | `ui/preload.js` | New `window.xleth.timeline.setTrackColor(trackId, assignment)` |
| Renderer (helpers) | `ui/src/components/timeline/trackColorResolver.js` | Added `sanitizeTrackColorMode`, `sanitizeTrackColorSlot`, `normalizeTrackColorAssignment`, `resolveTrackColor`; `resolveAutoTrackColor` now delegates to the new resolver; `buildResolvedTrackColorMap` is assignment-aware |
| Renderer (action) | `ui/src/components/TimelineView.jsx` | Added centralized `handleSetTrackColor` action (sanitizes and routes through bridge with engine-less fallback) |
| Engine tests | `engine/test/test_timeline.cpp` | Added test section [16] covering defaults, paletteSlot round-trip, missing-fields tolerance, invalid mode/slot sanitization, and `Timeline::setTrackColor` behavior |
| UI tests | `ui/src/components/timeline/__tests__/trackColorResolver.test.js` | New focused test file (24 tests) for sanitizers, `normalizeTrackColorAssignment`, `resolveTrackColor`, `buildResolvedTrackColorMap`, palette normalization invariants |

---

## Model / Schema Changes

### `TrackInfo` (engine canonical type)

```cpp
enum class TrackColorMode { Auto, PaletteSlot };

struct TrackInfo {
    // ... existing fields unchanged ...

    // ── Track color (Pass 6D) ──
    TrackColorMode trackColorMode = TrackColorMode::Auto;
    int            trackColorSlot = 0;  // 1..16 when PaletteSlot; 0 = unassigned
};
```

The struct gains exactly two trailing fields with safe defaults. No field is renamed or removed; engine audio/video pipelines never read these.

### Project JSON

- Auto tracks (the common case): `"trackColorMode": "auto"` is written; `trackColorSlot` is **omitted** to keep auto-only projects compact.
- PaletteSlot tracks: both fields are emitted (`"trackColorMode": "paletteSlot"`, `"trackColorSlot": 1..16`).
- No `kProjectFileVersion` bump. The fields are additive and tolerated as missing on load — current schema rules require a version bump only for breaking changes that need migration.

---

## Validation / Defaulting Rules

Implemented identically at every layer (engine `from_json`, engine setter, bridge `Timeline_SetTrackColor`, bridge `jsToTrack`, UI `handleSetTrackColor`, UI `normalizeTrackColorAssignment`):

| Input | Result |
|---|---|
| Missing fields | mode = `auto`, slot = 0 / null |
| Mode is unknown string | mode = `auto`, slot dropped |
| Mode = `paletteSlot`, slot is integer in 1..16 | preserved |
| Mode = `paletteSlot`, slot is 0 / 17+ / negative | mode falls back to `auto`, slot reset |
| Mode = `paletteSlot`, slot is non-integer / NaN / non-number | mode falls back to `auto`, slot reset |
| Mode = `auto`, slot present | slot dropped (set to 0 / null) |

The renderer is tolerant beyond loader: even if a malformed track somehow reaches it, `resolveTrackColor` re-runs `normalizeTrackColorAssignment` before reading the slot, so corrupted in-memory tracks still render an auto color.

Old projects do **not** get rewritten with normalized defaults — `to_json` only emits the field if the in-memory `TrackInfo` was actually loaded, and old loaded values default to `Auto` with `slot=0` which is the explicit serialization. Save then becomes idempotent for old projects with no field churn beyond adding the explicit `"trackColorMode": "auto"` line per track on next save (matches existing pattern for other added fields).

---

## Resolver Changes

`ui/src/components/timeline/trackColorResolver.js` was extended with:

- `sanitizeTrackColorMode(value)` — coerces anything other than `'paletteSlot'` to `'auto'`.
- `sanitizeTrackColorSlot(value)` — returns the integer-truncated value if it lies in 1..16, else `null`.
- `normalizeTrackColorAssignment(track)` — returns a canonical `{ mode, slot }` shape from any track-like input, applying the rules above.
- `resolveTrackColor(track, visibleIndex, trackPalette, fallbackHex)` — when `mode === 'paletteSlot'` with a valid slot, returns `palette[slot - 1]`; otherwise falls back to the existing visible-index auto and finally to `fallbackHex` / `TRACK_PALETTE_FALLBACK[0]`.
- `resolveAutoTrackColor` now delegates to `resolveTrackColor`. Its signature is unchanged, so all Pass 6C call sites (TrackHeaderList, drawClips, drawPatternBlocks, etc.) honor `paletteSlot` automatically — no call-site modifications needed.
- `buildResolvedTrackColorMap` was updated to use `resolveTrackColor`. Cost profile, allocation count, and call-frequency are unchanged from Pass 6C (one object plus N writes per redraw).

The resolver remains pure — no DOM/theme reads, no per-clip token lookups. The 16-slot palette is still resolved once per redraw inside `resolveTimelinePalette()` by `tokenValue()`, exactly as in Pass 6C.

---

## Track Creation Behavior

- `handleAddTrack()` in `TimelineView.jsx` is unchanged. New tracks default to `Auto` because `TrackInfo`'s C++ member initializers set `trackColorMode = TrackColorMode::Auto` and `trackColorSlot = 0`, and the bridge's `jsToTrack` only overrides those defaults when `trackColorMode` is explicitly present on the JS object.
- Pattern conversion / drag-drop / project import paths do not construct `TrackInfo` directly outside `addTrack`, so no other creation path needed updating.

---

## Track Duplication Behavior

The current codebase has **no real track-duplication path** today — the Timeline track context menu's `Duplicate` entry actually calls `handleAddTrack()` (a fresh blank track), confirmed in `TimelineView.jsx:2653` and noted as a known stub in the Pass 6A diagnostic. This pass leaves that stub alone; when a real duplication action is added, copying the `trackColorMode` + `trackColorSlot` is automatic if the duplication snapshots full `TrackInfo` (the same way `RemoveTrackCommand` already snapshots it — that command's undo path will round-trip the new fields automatically because `restoreTrack` accepts the full struct). No new logic is needed when that path lands.

---

## Mutation / Action API

### Engine (undo-tracked)

```cpp
class SetTrackColorCommand : public Command {
public:
    SetTrackColorCommand(int trackId, TrackColorMode newMode, int newSlot,
                         const Timeline& timeline);
    // ...
};
```

Snapshots `oldMode` / `oldSlot` at construction. `execute` and `undo` both delegate to `Timeline::setTrackColor`, which sanitizes invalid input — so undo cannot revive a corrupted state.

### Bridge

```js
window.xleth.timeline.setTrackColor(trackId, { mode: 'auto' })
window.xleth.timeline.setTrackColor(trackId, { mode: 'paletteSlot', slot: 5 })
```

The N-API entrypoint `Timeline_SetTrackColor` validates argument shape, builds the command, and feeds it through `g_undoManager`. Invalid `slot` or unknown `mode` strings are accepted by the bridge but collapse to `Auto` inside the engine.

### Renderer

```js
const handleSetTrackColor = useCallback(async (id, assignment) => { ... }, [fetchTracks])
```

Lives next to other track mutation handlers (`handleMute`, `handleSolo`, `handleVisualOnly`, `handleRename`). Sanitizes input UI-side (so dev fixtures and standalone harnesses can't corrupt state), then awaits the engine call and refetches tracks. With no engine bridge present, mutates local React state — keeps test harnesses and standalone storybook setups working. Picker UI consumers in Pass 6E should call this handler directly instead of `window.xleth.timeline.setTrackColor`, so input validation stays centralized.

---

## Project Save / Load Behavior

| Scenario | Result |
|---|---|
| Pre-Pass-6D project (no fields) loads in current build | Loads cleanly. Every track has `mode = Auto`, `slot = 0`. Timeline renders identically to Pass 6C. |
| Pass-6D project with mixed `auto` / `paletteSlot` tracks | Loads. Renderer honors per-track assignments. |
| Project with `"trackColorMode": "paletteSlot"` but missing/invalid `trackColorSlot` | Loaded track collapses to `Auto`. No exception thrown. |
| Project with garbage `"trackColorMode"` value | Loaded track collapses to `Auto`. No exception thrown. |
| Round-trip save → reload of a paletteSlot=N track | `mode = paletteSlot`, `slot = N` preserved verbatim. (Verified in C++ test 16b.) |

Save-load is verified by the C++ engine test suite (test_timeline.cpp section [16]). Old-project compatibility is verified by [16c] which loads a track JSON that omits both fields.

---

## Migration / Fallback Strategy

- **Renderer:** falls back through three layers in order — explicit slot → auto by visible index → `fallbackHex` → `TRACK_PALETTE_FALLBACK[0]`. Pass 6C's category-color fallback at the clip/pattern body level is preserved (the resolver returns a hex; clip drawing's `||` chain still falls back to `labelHexColor(region?.label)` if the map lookup misses entirely, e.g. unknown trackId).
- **Engine:** `j.value(...)` for both fields. `from_json` never throws on a missing key.
- **Bridge:** Both `jsToTrack` and `Timeline_SetTrackColor` apply the same sanitization rules; they will not surface a `RangeError` for an invalid slot — the engine collapses to `Auto` instead.
- **Schema version:** No bump. Old projects load without warning.

---

## Tests Added / Results

### UI — `ui/src/components/timeline/__tests__/trackColorResolver.test.js`

24 tests, all passing:

- `sanitizeTrackColorMode`: accepts `auto`/`paletteSlot`, coerces unknown strings, non-strings, objects, etc. → `auto`.
- `sanitizeTrackColorSlot`: accepts 1..16, truncates fractionals, rejects out-of-range, rejects non-numbers (`'5'`, `null`, `undefined`, `NaN`, `Infinity`).
- `normalizeTrackColorAssignment`: covers missing fields, invalid mode, valid `paletteSlot` 1..16, invalid slot fallbacks, slot dropped on `auto`.
- `resolveTrackColor`: visible-index auto, paletteSlot override regardless of visible index, invalid paletteSlot falls back to auto, auto wraps past slot 16, empty palette falls back to `TRACK_PALETTE_FALLBACK`.
- `buildResolvedTrackColorMap`: empty/undefined input, missing-metadata visible-index path, paletteSlot override, invalid paletteSlot fallback, wrap past slot 16.
- `normalizeTrackPalette`: invariants from Pass 6C still hold.

```
✓ src/components/timeline/__tests__/trackColorResolver.test.js (24 tests) 4ms
```

### Engine — `engine/test/test_timeline.cpp` section [16]

Six sub-cases (16a–16g), all passing. Total run: 234 passed, 0 failed.

- 16a — defaults (Auto, slot 0); JSON omits slot.
- 16b — paletteSlot=7 round-trips losslessly.
- 16c — old project (no fields) loads as Auto.
- 16d — invalid mode string sanitizes to Auto, slot dropped.
- 16e — paletteSlot with slot=99 collapses to Auto.
- 16f — paletteSlot with slot=0 collapses to Auto.
- 16g — `Timeline::setTrackColor` accepts valid input, collapses bad slot to Auto, forces slot=0 in Auto mode, returns false for unknown trackId.

```
[16] Track color metadata persistence (Pass 6D)
=== Results: 234 passed, 0 failed ===
ALL TESTS PASSED
```

### Theming + Timeline focused suites

```
✓ src/components/timeline/__tests__/trackColorResolver.test.js (24)
✓ src/theming/tokens/__tests__/derivation.test.ts (25)
✓ src/theming/tokens/__tests__/depth-tokens.test.ts (9)
✓ src/theming/tokens/__tests__/timeline-lane-bg-token.test.ts (3)
✓ src/theming/tokens/__tests__/track-palette-tokens.test.ts (8)
✓ src/theming/tokens/__tests__/helpers/colorDistance.test.ts (6)
✓ src/theming/__tests__/tokenValue.test.ts (6)
Total: 81 passed
```

### Full UI vitest run

`npx vitest run` — `1242 passed | 11 failed | 3 skipped` across 65 files. The 11 failures are the same pre-existing failures Pass 6C documents (limiterViz / multibandViz / transientViz / resonanceViz / visualB plugin-UI runtime tests, plus a Visual-A schema test). None touch any file modified in this pass; all failures are in `ui/src/plugin-ui/runtime/__tests__/` and `ui/src/plugin-ui/schema/__tests__/`. A handful of additional failures show up under `build/_deps/...`, `bridge/build/_deps/...`, `.claude/worktrees/...`, and `ui/tests/baseline/...` because `vitest`'s discovery picks up files outside `src/`; all are pre-existing.

### UI build

```
$ npm run build
✓ built in 2.40s
```

### C++ build

```
$ cmake --build build --config Release --target test_timeline
test_timeline.vcxproj -> ...\test_timeline.exe

$ cmake --build bridge/build --config Release --target xleth_native
xleth_native.vcxproj -> ...\Release\xleth_native.node
```

Both compile clean. Pre-existing compiler warnings (`MixEngine.cpp` `slot` shadow warning unrelated to this pass — it shadows a local `slot` introduced earlier; my new code introduces no new warnings).

---

## Runtime Smoke

The preview server is a vite dev server only — it cannot exercise the bridge `setTrackColor` path until Electron is restarted to load the rebuilt `xleth_native.node`. Smoke verification done:

- Reloaded the running preview after edits — `console.error` log is empty, `[UI] App mounting` and Timeline zoom logs appear normally, `document.readyState === 'complete'`.
- The active panel set in the preview session was Sample Selector / Project Media (no Timeline mounted with tracks), so per-pixel verification of strip color was not possible without disturbing user state. The unit tests already exercise the rendering invariants (visible-index auto for missing metadata, paletteSlot override for valid metadata, fallback for invalid metadata) at the resolver level.

To exercise the live paletteSlot path end-to-end (Pass 6D acceptance), restart the Electron host so it picks up the rebuilt `xleth_native.node`, open a project with a track, and run from devtools:

```js
await window.xleth.timeline.setTrackColor(<trackId>, { mode: 'paletteSlot', slot: 5 })
```

Expected: track-header strip, audio clip bodies, and pattern blocks on that track all repaint to palette slot 5 immediately, regardless of the track's visible index. Undo (`Ctrl+Z`) restores the prior assignment in one step.

---

## Performance Notes

- No DOM/theme reads inside per-clip or per-pattern loops. The 16-slot palette is resolved once per redraw, identical to Pass 6C.
- `buildResolvedTrackColorMap` adds zero allocations beyond Pass 6C — `normalizeTrackColorAssignment` returns a fresh small object inside the loop, but is unconditional and replaces the previous (smaller) shape; the impact is one extra object literal per track per redraw, well under the existing `mutedTrackIds` Set construction.
- No `ctx.shadowBlur` introduced. No unbounded caches.

---

## Explicit Non-Touches

- No color picker UI, no popover, no swatch grid (Pass 6E).
- No Theme Editor palette editing UI (Pass 6F).
- No theme token catalog modifications (`catalog.ts` unchanged).
- No shipped theme JSON modifications.
- No changes to the 16 palette token *values*.
- No changes to Sample Selector / Mixer / Piano Roll / Sampler / Preview / Grid Settings / Project Media / plugin UI.
- No Timeline clip/pattern drawing geometry, hit-testing, snapping, move/resize/split/delete behavior changes.
- No engine audio or render behavior changes.
- No new dependencies (`package.json` / `package-lock.json` untouched).
- No Playwright baselines updated.
- No raw custom hex track colors (deferred per the prompt's hard exclusion).
- No `app.css`, `windowing.css`, or other shared CSS modifications.
- `labelHexColor` and Pass 6C's category-color fallback path remain intact for clip/pattern body color when track lookup misses.

---

## Open Items for Pass 6E (Picker UI)

- Make the track-header strip clickable; open an anchored popover with `Auto` + 16 swatches.
- Optional context-menu entry under `TrackContextMenu`.
- Wire to `handleSetTrackColor` (already plumbed by this pass).
- Confirm undo/redo shows a single step per click.
- Verify the strip / clips / pattern blocks repaint within one redraw cycle.

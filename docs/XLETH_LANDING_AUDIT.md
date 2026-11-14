# XLETH Landing audit (P0)

Audit for `docs/XLETH_LANDING_SPEC.md`, taken on `feature/landing` at `af40dee` (the tip of `feature/lens-roam`). Line numbers are for that commit.

Three findings contradict the spec. Each has a decision below (D1 to D3). Two more are not contradictions but change how the spec is implemented (D4, D5). One is a known open issue that Landings inherit (O1).

## 1. Where the gap inset lives, and whether `compositeFrame` clears

- `GridCompositor::gridCellToUV` (`render/GridCompositor.cpp:1901`) is the fine-grid to UV step only: `subCellW = 1 / (gridCols * 8)`, then `x = cellCol * subCellW`, `w = spanX * subCellW`, the same for y and h. It has no gap.
- The gap inset is inline in `compositeFrame` (`GridCompositor.cpp:805-811`), grid cells only:
  `effectiveGap = gapScaleOverride >= 0 ? gapScaleOverride : gapScale`, then `sx = rw * effectiveGap * 0.5f`, `rx += sx`, `rw -= sx * 2.0f`, the same for y and h. It runs only when `effectiveGap > 0`.
- The rect before the gap is kept as `roamUnitW/H` (`:798`), the unit Roam offsets are measured in. The rect after the gap and after the per-note bounce is `roamHome` (`:847`), the Bounds Clip scissor.
- `compositeFrame` **does clear** its target: `ClearRenderTargetView(activeRTV, {0,0,0,0})` at `:690`, for the member target and for a custom `targetRTV` alike. It also prunes idle RT pairs and echo rings and rebinds the whole pipeline on entry.
- `transitionPass` (`:1290`) draws the A/B blend to the member target `renderTargetRTV_` with blending off. That is the surface `readback()` reads.

Consequence: the carry draw on a transition frame needs a no-clear entry point. P3 adds `GridCompositor::compositeOverlay`, which shares one body with `compositeFrame` and skips only the clear.

## 2. What `collectRequests` mutates per call

`FrameCollector::collectRequests` (`render/FrameCollector.cpp:262`) is not stateless. Per call it touches:

| State | What happens | Safe to call twice per frame? |
|---|---|---|
| `requestBuffer_` | Cleared and refilled. The returned reference is this buffer. | Yes, but the earlier result is overwritten. The carry result must be copied (the spec already says so). |
| `activeByTrack_` | Rebuilt from the event list. | Yes. |
| `holdByTrack_` (hold last frame) | Written for every Grid and FullscreenBehind request that has an active event. Then **garbage-collected against the layout of this call** (`:847-860`): every track that has no slot and no BehindGrid layer in that layout loses its held frame. | **No. See D2.** |
| `AnimationManager` | `onSlideReturnTrigger` + `onNoteStart` fire when `ev->globalNoteIndex != anim->activeNoteId` (`:622-637`). Edge-triggered on the note id, so a second collect of the same frame is a no-op. Time is advanced by the caller (`advanceTo`, absolute project time), never by the collector. | Yes. |
| Visual Echo | The collector only resolves settings and a ring key `(track, cellCol, cellRow, layerKind)`. The ring is advanced by the compositor (`pushEchoFrame`), which skips a push when `ring.lastPushedTime == time`. | Yes. |
| Flip | Resolved per event at build time (`VideoFlipApplier`). No per-collect counter. | Yes. |
| `clampLoggedTracks_` | Log bookkeeping only. | Yes. |

How `renderSnapshotTransition` tolerates its two collects today (B, then A, plus the caller's own collect before them): animation triggers are idempotent, echo pushes are guarded by `time`, and the hold GC is simply not tolerated. A track that is in A but not in B has its held frame erased by the B collect every frame, so during a transition a hold-last-frame gap on such a track draws nothing. This is existing behaviour and is left alone (ruling 9).

## 3. Whether `moveGridCue` / `addGridCue` copy the whole cue

- `Timeline::addGridCue` (`model/Timeline.cpp:1852`): at an existing tick it assigns `snapshotId` only. The transition is kept, and landings will be kept the same way. This matches the spec.
- `Timeline::moveGridCue` (`:1861`): it moves `snapshotId` only (`std::move(pos->snapshotId)`, erase, `addGridCue(newTick, id)`). **The transition is dropped.** The spec says landings must be carried "like it carries `transition`", but it does not carry the transition. `Timeline_MoveCue` in the service and `moveCue` in `SnapshotCueLane.jsx` do not re-apply it either, so dragging a cue that has a transition loses the transition today. See D1.

## 4. Where both seams call `transitionAt`

- **Live preview:** `XlethEngineService.cpp:4381-4382`, in the video thread tick, under `syncEventsMutex` (`eLock`): `layout = gridLayoutAt(tick)` then `previewTransition = transitionAt(tick)`. The main collect is at `:4448` with `layoutOverride = &layout` and `applyPreviewEffectMute = true`. The lock is released at `:4565` unless a transition is active. `renderSnapshotTransition` is called at `:4802`, the single composite at `:4822`.
- **Export:** `render/OfflineRenderer.cpp` has two frame loops with the same shape. Tail-render loop: `gridLayoutAt` at `:865`, collect at `:907` (no layout override), `transitionAt` at `:963`, `renderSnapshotTransition` at `:982`, single composite at `:993`. Main loop: `:1562`, `:1590`, `:1629`, `:1648`, `:1656`.

Both seams compute the frame tick the same way: `sampleToPPQ(projectStartSample + videoFrameToSample(frame), sampleRate, bpm)`.

## Decisions

**D1. `moveGridCue` moves the whole cue.** It now carries `snapshotId`, `transition` and `landings`. This fixes the dropped transition as a side effect. Saved projects and rendered frames are unaffected: the change is only visible when a cue that has a transition is dragged, and the transition now survives. On a collision at the new tick (the UI never asks for one) the moved cue replaces the occupant whole, where before only its `snapshotId` did.

**D2. The hold GC is protected on landing frames.** The spec's flow collects twice per landing frame (the stripped layout, then the carry layout). With the GC as it is, the stripped collect would erase the landing tracks' held frames and the carry collect would erase everyone else's, which breaks ruling 5 (hold-last-frame applies while landing). `FrameCollector` gains two guards, both off by default so ruling 9 holds:

- `setHoldKeepTracks(ids, count)`: tracks the GC must not erase even when they are absent from the layout. The landing helper sets it to the landing tracks for the whole frame, and clears it on every frame without landings.
- `setHoldGcEnabled(false)`: the helper turns the GC off for the carry collect only.

Tracks without a landing behave exactly as today on every frame, including the existing loss described in section 2.

**D3. `ResolvedLanding` and `CellFrameRequest` carry the Roam unit.** Roam offsets are measured in the placement's size *before* the gap. A rect override alone would make the compositor measure them in the size after the gap, so a track with a Roam offset and a non-zero gap would jump at the end of the carry. `ResolvedLanding` gains `fromUnitW/H` and `toUnitW/H`, and `CellFrameRequest` gains `canvasRoamUnit[2]` next to `canvasRect[4]`. The unit is lerped with the rect, and at `e == 1` both are returned exactly (not as `from + (to - from) * 1`), so the seam is bitwise equal to B's draw.

**D4. `ResolvedLanding` also carries B's slot.** The carry layout needs each landing track's `GridSlot` in B and B's geometry. To keep `landingsAt` allocation-free and POD, each item carries `slotGridX/Y`, `slotSpanX/Y`, `slotOpacity`, `slotZOrder`, and the set carries `columns`, `rows`, `gapScale`. The helper builds the carry layout from these into a reused member, so no `GridLayout` is copied per frame.

**D5. The per-frame maths is a pure header.** `render/LandingMath.h` holds the Edge/Grow from-rect maths and `evaluateLanding(landing, S, startS, pinS)`. `Timeline::landingsAt` and `LandingRenderer` both use it, and the seam test calls it without a GPU.

**D6. The two RPCs are declared in the RPC manifest and nowhere else (found in P4).** The spec asks for the `setCueTransition` chain to be mirrored exactly (hand-written lines in `bridge/src/XlethAddon.cpp`, `ui/electron-main/grid-layout.js` and `ui/preload.js`) *and* for both RPCs to be registered in `ui/rpc-manifest.js`. Those two are alternatives, not layers: one manifest entry already generates the addon export (`XlethRpcExports.inc`), the engine dispatch line (`XlethRpcDispatch.inc`), the `ipcMain` channel and the `window.xleth` wrapper. Doing both would register each `ipcMain` channel twice, which throws at boot. `setCueTransition` is hand-wired only because it predates the manifest. Both landing RPCs are pure pass-throughs, so they use the manifest, with the channel and API names the spec gives: `xleth:timeline:setCueLandings`, `xleth:timeline:reflowCueLandings`, `window.xleth.timeline.setCueLandings`, `window.xleth.timeline.reflowCueLandings`. The handlers sit next to `Timeline_SetCueTransition` in `XlethEngineService.cpp`, as specified.

**D7. `timeline_listSnapshots` gains two additive fields (found in P5).** The Add landing menu must list the tracks that have a grid slot in the cue's snapshot, and "Where it was" must be disabled for a track the outgoing snapshot does not place. The renderer had no way to ask what a snapshot other than the active one places. Each item of `timeline_listSnapshots` now also carries `slotTrackIds` and `fullscreenTrackIds`. Existing callers read `id`, `name` and `active` and are unaffected.

## Open issue inherited, not fixed here

**O1. Content targets are sized from the in-flight rect.** The Lens pass, the effect chain, ping-pong, companion FX and the outline all size their render targets from the cell's current pixel size, and the echo ring reallocates when that size changes. A landing that changes size (`WhereItWas` between different cells, `Grow`, most `Custom`) therefore asks `RTPool` for a new pair per frame per stage on tracks that use those stages, and pairs are kept for 10 s. An echo on such a track loses its trail for the length of the move. This is the same mechanism as the HIGH issue in `docs/XLETH_LENS_ROAM_VERIFY.md` (animated Roam scale), and the spec asks for exactly this order (ruling 7, "as today"). `Edge` landings only translate, so they are not affected. P6 measures it. The fix belongs with the Lens/Roam ruling, not here.

## Other notes

- `landingsAt` reads snapshots in place through a new private `snapshotAt(tick)`, which is `gridLayoutAt`'s selection logic without the copy. `gridLayoutAt` is rewritten on top of it with identical results.
- "Previous cue" for the lead-in clamp means the previous cue whose snapshot still resolves. A dangling cue is treated as absent, as everywhere else.
- The landing window is half-open, `[start, carryEnd)`. `transitionAt`'s window is closed, `[start, end]`. At `t == carryEnd` on an enabled transition the blend is fully B and nothing is carried, which shows the same picture.
- A landing window can overlap the tail of the *previous* cue's transition (the lead-in is clamped at that cue's pin, not at the end of its transition). The helper handles it like any other transition frame: the landing tracks are stripped from both composites and drawn on top.
- Docs under `docs/` are ignored by `.gitignore` and are force-added, as the Lens + Roam docs were.

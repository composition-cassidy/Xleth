# XLETH Lens + Roam: video pipeline audit

Date: 2026-11-13. Branch `ui-rebuild/phase-0`, working tree as found (it carries other sessions' uncommitted WIP; nothing here was edited).
Spec: `docs/XLETH_LENS_ROAM_SPEC.md` (locked).
Method: five Haiku locator subagents (effort low, read-only) listed call sites. Every file:line below was opened by the auditor in this session. Line numbers are against the current working tree, not older audit docs.

## Verdicts

| | Verdict | One-line reason |
|---|---|---|
| (a) Static Lens and Roam | **BLOCKED on one spec ruling** (Roam alone: GO) | The spec's "zoom 1.0 = cover-fit to the cell's aspect" contradicts "identity reproduces today's rendering exactly": today's composite stretches the source to the cell. No code blocker. |
| (b) Per-note overrides | **GO** (with 5 conditions, see 5 and 6) | Pattern notes already carry a stable per-pattern `id` that survives move, resize, quantize, compound edits, undo/redo and save/load. Key must be `{patternId, noteId}`, not `noteId`. |
| (c) Data-race risk on this path | **GO** (with conditions) | The visual-chain race (Bug 1) is fixed by copying into the request under the model lock. Lens/Roam riding the same per-request value copy is race-free in preview. Two pre-existing gaps remain: the render thread takes a mutex and allocates, and export reads the live Timeline unlocked. |

---

## 1. Compositor

**Backend.** D3D11 only. `GridCompositor` draws a full-screen quad per cell; `GridComposite.hlsl` is the shader. The OpenGL compositor path is retired (no `VideoCompositor` in `engine/src/render`; listing of the directory shows no GL file).

**Cell rects from the grid.**
- Fine grid: `kGridSubUnitsPerColumn = 8`, `kGridSubUnitsPerRow = 8` (`engine/src/model/TimelineTypes.h:1877-1878`). Half-grid placements are just spans of 4 sub-units; legacy half-grid (v1, 2 sub-units) migrates by x4 (`TimelineTypes.h:1870-1880`).
- `GridSlot { trackId, gridX, gridY, spanX, spanY, opacity, zOrder }` (`TimelineTypes.h:1899-1906`).
- Chorus behind-layer: no longer a dedicated field. `gridLayoutVersion` v3 replaced `chorusTrackId / crash*` with `fullscreenLayers` (`TimelineTypes.h:1874`); `FullscreenLayer { trackId, placement, opacity, zOrder }` (`TimelineTypes.h:1941-1945`), `FullscreenLayerPlacement { BehindGrid, InFrontOfGrid }` (`TimelineTypes.h:1939`). The Chorus layer is a `BehindGrid` fullscreen layer.
- Layout for a frame: `timeline.gridLayoutAt(TickTime{projectFramePpq})` (`engine/src/render/FrameCollector.cpp:300-302`), or the caller's override (snapshot transitions, and the preview hands its already-resolved layout in at `engine/src/XlethEngineService.cpp:4383-4388`).

**FrameCollector / CellFrameRequest.**
- `struct CellFrameRequest` `engine/src/render/FrameCollector.h:58-129`: geometry (`cellRow/cellCol/spanX/spanY` 59-62), `opacity` 66, `orientation` 71, `layerKind` 73, `zOrder` 74, animation snapshot (`currentZoom/PanX/PanY/RotDeg`, `bounce*`) 78-86, `visualChain` value copy 117, `companionFx` 121, `echo` 128.
- `FrameCollector::collectRequests` `FrameCollector.cpp:260`. The `buildRequest` lambda `FrameCollector.cpp:317-702` fills one request; `buildHeldRequest` `FrameCollector.cpp:708-795` fills a hold-through-gap request.
- Assembly order: BehindGrid layers 829-845, grid slots 851-866, InFront layers 870-880, then ONE `std::stable_sort` by `zOrder` 889-892. Request order is draw order.

**GPU composite.**
- Per-request loop `engine/src/render/GridCompositor.cpp:700`.
- Destination rect: grid -> `gridCellToUV` (`GridCompositor.cpp:741-743`, definition 1643-1659, pure division by `cols*8` / `rows*8`); fullscreen -> literal `(0,0,1,1)` (744-746).
- Gap inset, grid only, 752-758. Bounce offset/scale, grid only, 767-778.
- Content stages, all render-to-texture at cell pixel size: visual chain 805-831; standalone ZPR animation pass (rtSlot 1) 837-868; ping-pong 873+.
- Canvas-fit mapping canvas-UV -> output-UV 1042-1045. Echo taps 1059, drop shadow 1070, final `drawCell` 1074-1075.
- `drawCell` 1194-1209 writes `CellConstants { cellRect, opacity, orientation, cornerRadius }` (`GridCompositor.h:46-52`, static_assert 32 bytes at 53).
- Shader `engine/src/render/shaders/GridComposite.hlsl`: `localUV = (uv - cellRect.xy) / cellRect.zw`, `discard` outside [0,1] (lines 86-93), orientation switch on `sampleUV` (100-106), sample, opacity, corner SDF.
- **Clipping is the pixel-shader discard against an axis-aligned `cellRect`. There is no scissor rect anywhere in the compositor.**
- **The source is STRETCHED across the cell**: `sampleUV` is `localUV` (plus orientation), no aspect correction (`GridComposite.hlsl:100-108`). The existing ZPR shader `FX_ZoomPanRotation.hlsl:23-47` works in that same stretched cell-UV space and clamps to edge.

## 2. Live vs export

**Shared:**
- Event list: one builder, `xleth::videoevents::build` (`engine/src/render/VideoEventBuilder.cpp:325-339`), called by preview (`XlethEngineService.cpp:1509`) and export (`engine/src/render/OfflineRenderer.cpp:772`).
- Flip: `videoFlipApplier::applyAll` inside that builder (`VideoEventBuilder.cpp:337`).
- Per-cell state: `FrameCollector::collectRequests` for both (preview `XlethEngineService.cpp:4383`, export `OfflineRenderer.cpp:354-359`), then `GridCompositor`.
- Opacity: one formula, `req.opacity = clamp(slotOpacity * ev->opacity * fadeGain)` (`FrameCollector.cpp:555-557`), with `ev->opacity = track->videoOpacity * note.velocity` from the builder (`VideoEventBuilder.cpp:307`).
- Animation clock: both call `AnimationManager::advanceTo(ms of the frame's project sample)` (preview `XlethEngineService.cpp:4296-4298`, export `OfflineRenderer.cpp:339`).

**How the earlier opacity parity bug was fixed.** Before `e2c2826`, preview and export each had their own event builder. Preview wrote `ev.opacity = note->velocity` (`git show e2c2826^:engine/src/XlethEngineService.cpp`, line 1750), dropping the track's `videoOpacity`. Export wrote `track->videoOpacity * note.velocity` (`git show e2c2826^:engine/src/render/OfflineRenderer.cpp`, line 571). `e2c2826` deleted both and moved them onto `VideoEventBuilder::build`, so the formula exists once (`VideoEventBuilder.cpp:307`). Lesson for Lens: never write a second evaluator.

**Divergences that remain (every one found):**
1. Proxy / poster substitution: preview passes `allowProxy=true` and may pass `posterMode` (`XlethEngineService.cpp:4383-4388`); export passes `!useSourceMedia` and a render-proxy plan (`OfflineRenderer.cpp:354-359`). Pixels differ by design; geometry does not.
2. Preview-only effect mute (`applyPreviewEffectMute=true`, `XlethEngineService.cpp:4388`; honoured at `FrameCollector.cpp:570-572`).
3. **Note-start animation is edge-triggered and stateful.** `onNoteStart` fires when `ev->globalNoteIndex` differs from the cell's `activeNoteId` (`FrameCollector.cpp:616-630`), and stamps `nowMs_`, the time of the first frame that SEES the note (`AnimationManager.cpp:902-908`), not the note's start tick. Preview and export sample at different frame rates, so the trigger lands up to one frame apart. A seek into the middle of a note restarts the animation at the seek point in preview. Preview also `resetAll()`s on seek-back/loop wrap (`XlethEngineService.cpp:4332-4343`).
4. Slide-note dispatch clocks: preview crosses beats derived from `samplePos` (`XlethEngineService.cpp:4327-4331`) while it advances animation from `frameProjectSample` (4297). Export uses `projectFrameTick` for both (`OfflineRenderer.cpp:339-345`).
5. Stale comment: `FrameCollector.h:367-370` says companion FX are export-only, but the preview enables them too (`XlethEngineService.cpp:5590`, export `OfflineRenderer.cpp:265`). Behaviour matches; only the comment is wrong.

**Consequence for Lens:** the spec's "one evaluator against transport ticks" must be a stateless function of `(frame tick - event start tick)`. It must not go through AnimationManager's trigger latch, or it inherits divergence 3.

## 3. Flip

- Baked at build time: `videoFlipApplier::applyAll(events, timeline)` (`engine/src/render/VideoFlipApplier.cpp:138`, declared `VideoFlipApplier.h:44`) writes `monoOrdinal / stateIndex / orientation` into each `VideoEvent` (`engine/src/SyncManager.h:83-92`). Called once at the end of `build` (`VideoEventBuilder.cpp:337`).
- Copied into the request: `req.orientation = ev->orientation` (`FrameCollector.cpp:561-562`); hold requests reuse the last one (`FrameCollector.cpp:754`).
- Applied ONCE, at the final `drawCell` (`GridCompositor.cpp:1074-1075` -> shader `GridComposite.hlsl:100-106`). Every intermediate pass uses orientation 0 (comments at `GridCompositor.cpp:793-795`, 815-816, 856).
- **Cleanest point for "flip AFTER Lens":** it already is after everything. The flip is the last UV op in `PSMain`. Fold Lens into the same `PSMain` sampling, between `localUV` and the orientation switch, but applied in the right composition order: `sampleUV = lensMap(orient(localUV))`, so the mirror acts on the framed picture (spec: "flip mirrors the framed result"). Lens `flip` values `None/Horizontal/Vertical` override `orientation`; `FollowTrack` passes it through.

## 4. Pattern Track video: note -> frames

- Per block, per loop iteration L, per note: `tapePos = L * patternLen + note.position`; `startTicks = blockPos + (tapePos - windowStart)`; note-off clamped to the block end (`VideoEventBuilder.cpp:258-291`).
- Each note retriggers the region from `region->startTime` (`VideoEventBuilder.cpp:299-301`). The frame is computed per output frame from `(beatPos - ev.startBeat)` through `evaluateVideoClipModulationTiming` -> `computeSourceFrameFromTime` (`FrameCollector.cpp:341-347`).
- Slide notes spawn no cell; they become `SlideAnimationEvent`s (`VideoEventBuilder.cpp:272-285`).
- Arp regions emit one event per arp step via `ArpVideoExpander` (`VideoEventBuilder.cpp:223-256`).
- **Per-note instance at render time:** yes and no. Each note occurrence becomes one `VideoEvent` value in an immutable snapshot vector, so it has a start/duration. But `VideoEvent` carries no `patternId`, no `blockId` and no `noteId` field. Only `sourceTriggerOrder`, which is the note id when `id > 0` (`VideoEventBuilder.cpp:310-312`, field `SyncManager.h:45-49`). The per-cell runtime state (`CellAnimation`) is per TRACK, not per note (`AnimationManager.cpp:902-908`).

## 5. Stable note IDs

**Yes, per pattern.** `PatternNote::id` (`TimelineTypes.h:1360-1361`); `Pattern::nextNoteId`, a per-pattern counter (`TimelineTypes.h:1386`).
- Created: `note.id = nextNoteId++` (`engine/src/model/Timeline.cpp:957`).
- Move: by id, `Timeline::moveNote` (`Timeline.cpp:1092-1096`).
- Quantize and compound edits: the piano roll maps the note list keeping `id` (`ui/src/components/pianoRoll/pianoRollEdits.js:148-152`) and commits through `timeline_editPatternNotes`. That reads `id` from JS (`XlethEngineService.cpp:14949-14950`) into `EditPatternNotesCommand`, which keeps ids and reuses fresh ids on redo (`engine/src/commands/TimelineCommands.h:1080-1100`). `setPatternNotesKeepIds` never collides (`Timeline.cpp:1024-1043`).
- Undo: `restorePatternNotes` never walks `nextNoteId` back (`Timeline.cpp:1046-1062`); `restoreNoteInPattern` keeps the id (`Timeline.cpp:2199-2208`).
- Save/load: `to_json/from_json(PatternNote)` writes and reads `id`; `Pattern` writes `nextNoteId` (`engine/src/model/Pattern.cpp:3-46`). Patterns go through `Timeline::toJSON` by ADL (`Timeline.cpp:2642-2646`).
- JS round-trip includes `id` (`patternNoteToJs`, `XlethEngineService.cpp:3065-3075`).
- Paste / duplicate: copies get NEW ids (they are new notes). That is correct; an override does not follow unless the copy carries it.

**Conditions for (b):**
1. Key overrides by `{patternId, noteId}`. IDs are only unique inside one pattern.
2. "Make Unique Copy" builds a new pattern with fresh ids via `addPattern` + `addNotesBatch` and drops the block (`ui/src/components/TimelineView.jsx:3023-3058`). It is several RPCs, not one undo step. Overrides must be copied with the notes, or they are lost.
3. No load-time repair for `id <= 0` or duplicate ids. `from_json` reads the id verbatim (`Pattern.cpp:16-17`), and the builder falls back to the index for `id <= 0` (`VideoEventBuilder.cpp:27-37`). The schema bump should assign ids to `id <= 0` notes and dedupe.
4. Storing `lensOverride` ON `PatternNote` is the safest home: it then rides every snapshot, undo and copy. But `editPatternNotes` REPLACES the list from JS (`XlethEngineService.cpp:14936-14956`) and `jsToPatternNote` copies only known fields (`XlethEngineService.cpp:3078-3094`). The new field must be added to both marshallers, or every piano-roll edit silently erases overrides.
5. `VideoEvent` needs `patternId` and `noteId` (and the un-clamped note length, if Tail should anchor to the real note-off rather than the block-clamped one) so the collector can look the override up.

## 6. Shared pattern content

Shared. `PatternBlock` holds a `patternId` reference plus `position / duration / offset / loopEnabled` (`TimelineTypes.h:1392-1400`); notes live on `Pattern` (`TimelineTypes.h:1385`). The builder reads `*pattern` per block (`VideoEventBuilder.cpp:221`) and repeats it per loop iteration (258-261). So one note id stands for every placement and every loop pass of that pattern. A Nudge/Own override therefore applies to all of them (FL "instance" semantics). The Reel lane must show that (several ghost clips light up when one is edited). If per-placement overrides are ever wanted, the key would need `blockId` and loop index; the spec does not ask for that.

## 7. Serialization

- `project.json`, key `"schema_version"`, absent means 1 (`engine/src/project/ProjectManager.h:22-23`). Current `XLETH_PROJECT_SCHEMA_VERSION = 7` (`ProjectManager.h:64`). Written at `ProjectManager.cpp:201`, read and logged at `ProjectManager.cpp:402-410`.
- Migration mechanism: no central `migrate()`. Each version migrates in the `from_json` of the type it touches, documented in the version table (`ProjectManager.h:24-63`). v6 (ZPR keyframes) is the closest precedent: `Track.cpp` reads/writes `zoomPanRot` (`engine/src/model/Track.cpp:469-478`) and migrates when the tracks block is absent (`Track.cpp:164-179`).
- Trap (from the project's own history): `ProjectManager` hand-copies a WHITELIST of top-level keys between `project.json` and the Timeline JSON; a new TOP-LEVEL key is silently dropped. Keep Lens/Roam inside existing objects (`TrackInfo` via `Track.cpp`, `Clip`, `Pattern`/`PatternNote`), and the whitelist is not involved.
- Proposed v8: `Clip.lens`, `TrackInfo.roam`, `TrackInfo.trackLens` (a map keyed by regionId, so the `{trackId, regionId}` key needs no new top-level table), `PatternNote.lensOverride`, plus the note-id repair. Missing key = identity.

## 8. UndoManager

- `Command` base: `execute / undo / describe`, optional `shouldRecordInUndoHistory`, `domain` (`engine/src/commands/Command.h:10-37`).
- `UndoManager::execute` runs the command under `MutationLock(mutationMutex_)` and fires the post-mutation hook (`engine/src/commands/UndoManager.cpp:31-41`). The service installs `syncEventsMutex` as that mutex and a hook that sets `g_videoEventsDirty` (`XlethEngineService.cpp:5526-5547`), so every undoable edit rebuilds video events on the next tick.
- **Template to copy:** `SetTrackNoteFadeCommand`, a whole-struct before/after swap on a track (`TimelineCommands.h:1351-1362`, `TimelineCommands.cpp:2476-2494`). It fits `SetTrackRoamCommand`, `SetClipLensCommand` and `SetTrackLensCommand` directly. For keyed curves, `SetTrackZprTracksCommand` (`TimelineCommands.h:1307`) is the keyframe-shaped precedent. Per-note overrides need no new command if they live on `PatternNote`: `EditPatternNotesCommand` already snapshots the whole list.

## 9. Threading

- Model lock: `std::recursive_mutex syncEventsMutex` (`XlethEngineService.cpp:360-379`). The video thread takes it for the READ phase of a tick (`XlethEngineService.cpp:4168`), which includes `collectRequests` (4383), and unlocks before decode and composite (4501).
- **Visual effect chain race (Bug 1): fixed.** Commit `0d0ef23`. The request takes a VALUE copy of the chain under the lock (`FrameCollector.cpp:572-583`, rationale `FrameCollector.h:104-117`). Every chain mutation handler takes the same lock (`XlethEngineService.cpp:16273-16283`, and locks at 16308, 16336, 16374, 16405, 16435, 16473). Undoable edits are covered by the UndoManager mutation mutex.
- Gaps against the spec's threading section (all pre-existing):
  1. The render (video) thread takes a mutex every tick, and `req.visualChain = trk->visualEffectChain` heap-allocates per cell per frame (`FrameCollector.cpp:583`, `768`). The spec says "no locks, allocation or logging on the render thread".
  2. **Export reads the live Timeline with no lock.** `OfflineRenderer` holds `const Timeline& timeline_` (`OfflineRenderer.h:197`), built from `*g_timeline` (`XlethEngineService.cpp:20899-20903`), and calls `collectRequests` on its own thread (`OfflineRenderer.cpp:354`). The only engine-side guard against editing during export found is on `project_newBlank` (`XlethEngineService.cpp:7096`). An edit during export races every field the collector reads, chain included. Lens/Roam would add fields to that same unguarded read, not a new kind of race.
- **Would Lens/Roam travel the same structure?** They can: plain values copied into `CellFrameRequest` in `buildRequest` (as `cornerRadius` is, `FrameCollector.cpp:565`) are race-free in preview under the current lock. To meet the spec, publish an immutable `shared_ptr<const LensRoamSnapshot>` on the post-mutation hook. That is the same pattern as SyncManager's event snapshot (`SyncManager.h` `setEvents/eventsSnapshot`) and MixEngine's `ChainSnapshot`, so the collector reads it with one atomic load and no allocation. Lens/Roam values in the request should be fixed-size PODs, never vectors.

## 10. UI

- Arrangement: three-layer canvas `ui/src/components/timeline/TimelineCanvas.jsx:42-43`. Clips: `drawClips` (`timelineDrawing.js:1820`, per-clip `paintClip` 1714), called at `TimelineCanvas.jsx:332`. Pattern blocks: `drawPatternBlocks` (`timelineDrawing.js:2038`, `paintPatternBlock` 1950), called at `TimelineCanvas.jsx:352`.
- **Child lanes exist.** `buildTimelineRows` (`ui/src/components/timeline/timelineRowLayout.js:110`) emits `rowType` `'track'` (143), `'macroAutomation'` children of a track (173), `'automationLane'` (95), `'automationGroupHeader'` (80), `'folder'` (204). A Reel lane is a new `rowType: 'reel'` with `parentTrackId`, the same shape as `macroAutomation`. A Roam key lane is another.
- Piano roll: `ui/src/components/pianoRoll/PianoRollCanvas.jsx`, three stacked canvases bg/content/overlay (1384-1386); edits in `pianoRollEdits.js`.
- **Viewer overlay canvas: there is none.** `VideoPreview.jsx` has one `<canvas>` (1089). The only overlay is `GridEditorOverlay`, a DOM component laid over that canvas (1095; no `<canvas>` in `GridEditorOverlay.jsx`). Roam handles and the motion path need a new sibling overlay canvas. The spec rule "never DOM overlays on canvases" also argues against extending `GridEditorOverlay`.
- Existing framing editor to mine: `ui/src/components/grid/zprTimeline/` (`ZprViewport.jsx`, `zprRectMath.js`, `ZprKeyframeCanvas.jsx`, `ZprTimelineCard.jsx`), mounted by `ui/src/components/devices/video/NoteDevice.jsx`.

## 11. Existing animation / keyframe code

- `ParamTrack` keyframe core: `Keyframe { t (0..1 normalized), value, p1x..p2y }` and `ParamTrack { keys, constantValue }` (`engine/src/model/ParamTrack.h:33-61`), `evaluate(track, normalizedTime)` (72), with easing only through `util/ParamTrackEase.h` (14, 26).
- Per-track ZPR settings + `ZprTracks` (`TimelineTypes.h:968-1096`), migrated at schema v6 (`ProjectManager.h:51-58`), animated per note by `CellAnimation` / `AnimationManager` (edge-triggered; see 2.3).
- Static ZPR as visual chain effect type `ZoomPanRotation` (`GridCompositor.cpp:838-845` avoids a double apply with the animated one).
- Bounce: per-note cell offset/scale (`GridCompositor.cpp:767-778`). That is cell geometry, the Roam domain, but per note.
- Note Fade: a stateless per-note envelope evaluated from `(beatPos - ev.startBeat)` inside `buildRequest` (`FrameCollector.cpp:555-556`). **This is the right model for the hit curve:** stateless, one call site, so preview and export agree by construction.
- `ParamTrack` keys use a NORMALIZED `t` over one window. Head/Body/Tail need three anchors in ticks; the `Keyframe` type does not express that. Lens keys need their own key type `{anchor, ticksOrFraction, value, bezier}` (or a ParamTrack per anchor band). Reuse `ParamTrackEase` for the curves.

---

## Graft points

**Roam (cell quad), in `GridCompositor::compositeFrame`.** After gap and bounce (`GridCompositor.cpp:752-778`), before the visual chain sizes its target from `rw/rh` (807-808) and before canvas-fit (1042-1045). Then outline pad, echo taps and drop shadow all follow the moved cell for free.
- Offset/scale: add/multiply on `rx, ry, rw, rh` in cell units of the home rect. Pure arithmetic, no shader change.
- Rotation: NOT expressible today. The shader clips by an axis-aligned `cellRect` discard (`GridComposite.hlsl:86-93`). Add an inverse 2x3 transform to `CellConstants` (it grows to 64 bytes; the static_assert at `GridCompositor.h:53` moves) and compute `localUV` through it. Keep the exact old `(uv - xy) / zw` path behind a flag when Roam is identity, so old projects stay bit-identical (a matrix multiply is not bit-equal to that divide).
- Bounds Clip: also discard outside the HOME rect (second rect in the cbuffer). Float: skip it.
- Layer (`GridOrder | AboveNeighbours | Top`): a secondary sort key in the single `stable_sort` (`FrameCollector.cpp:889-892`), so draw order stays decided in one place.
- Roam keys are timeline-absolute: evaluate from `projectFramePpq` (`FrameCollector.cpp:281`) in `buildRequest`, write PODs into the request.

**Lens (content UVs), in `GridComposite.hlsl` `PSMain` + `buildRequest`.**
- Evaluate in `buildRequest` next to Note Fade (`FrameCollector.cpp:555`), statelessly, from `projectFramePpq - eventStartTick`. Base + hit curve (Follow) / + note keys (Nudge) / note keys (Own) + Sweep. Produce `{centerX, centerY, zoom, rotationDeg, flipOverride}` PODs.
- Apply in the final draw: `sampleUV = lensMap(orient(localUV))` between `GridComposite.hlsl:100` and the sample at 108. This needs the source texture's pixel aspect and the cell's pixel aspect in the cbuffer (cover-fit math). Identity must branch to the old line, for bit-identity.
- With a non-empty visual chain, the chain runs on the UN-framed source at cell size (`GridCompositor.cpp:805-812`), so spatial effects (TV, swirl, smear) would be zoomed by Lens afterwards. If Lens must frame the SOURCE before effects, it becomes a first render-to-texture stage instead (cost: one pass per Lens-active cell). Decide which before Phase 1.
- Relationship to the existing ZPR stack (chain type 4, standalone animated ZPR pass at `GridCompositor.cpp:837-868`, `ZprTracks`): the spec retires the concept under the name Lens but does not say whether existing ZPR data migrates into Track Lens / clip Lens or coexists. Coexisting gives two framing transforms per cell, in different spaces (ZPR pan is a UV offset in stretched cell space). Needs a ruling.

## Spec questions raised (spec not edited)

1. **Cover-fit vs bit-identical (blocks (a) for Lens).** Today the source is stretched to the cell. With "zoom 1.0 = cover-fit to the cell's aspect", any source whose aspect differs from its cell will render cropped instead of stretched at identity Lens. That covers 4:3 sources, non-square grids such as 3x2, and half-grid spans. Options: (i) an absent `lens` loads as a legacy stretch fit, new events default to cover-fit; (ii) identity means stretch, and cover-fit is a preset; (iii) accept the visual change and drop the bit-identical requirement for that case.
2. Existing ZPR data: migrate into Lens, or keep both?
3. Lens relative to the visual chain: frame before effects (extra pass) or after (folded into the final draw)?
4. Tail anchor: real note-off, or the block-clamped note-off the audio uses (`VideoEventBuilder.cpp:288-289`)?
5. Bounce already animates the cell per note; spec lists per-note Roam as out of scope. Confirm bounce stays as is and composes before Roam.

## Rulings (2026-11-13)

Spec questions 1-4 above and the verdict (a) blocker are answered in `docs/XLETH_LENS_ROAM_SPEC.md`, section "Rulings (2026-11-13, from the P0 audit)" (Rulings 1-8).

- Verdict (a), static Lens and Roam: **RESOLVED by Ruling 1.** Lens gains a fit mode (Stretch | Cover | Contain). Old projects migrate to Stretch (today's behaviour), so identity renders bit-identically; new clips and sources default to Cover.

# Snapshot Transition — Recon Report & Phased Plan

Companion to `snapshot-transition-system-spec.md`. Findings from a no-code recon pass over the
real Xleth tree. Referenced by the Slice 2–4 build prompts.

## Executive summary

The snapshot **container + cue** system is complete end-to-end (model → bridge → cue-lane UI).
The snapshot **transition** feature is **100% greenfield**. The two-RT approach is feasible and
maps cleanly onto `RTPool`, `EffectShaderCache`, the by-value `gridLayoutAt` resolver, and
`RenderClock` integer timing. Three locked-design items need adjustment (see end).

Correction to the original brief: the "transition timeline UI already in progress" **does not
exist**. What exists is snapshot *management* + a fully-built *cue lane*. The pin/Start/End/
Animation-Type editor is net-new work for Slice 4.

## Task 1 — Locations

### 1a. Snapshot data model
`engine/src/model/TimelineTypes.h`:
- `GridSnapshot` (:1249) — `id, name, columns, rows, gapScale, slots[], fullscreenLayers[]`.
  Canvas + previewFps are NOT here — they're project-global.
- `GridSlot` (:1139) — one track's grid placement; reserved `eventActions` seam (:1155).
- `FullscreenLayer` (:1181) — reserved `eventActions` (:1191).
- `GridLayout` (:1211) — flat runtime working view = global canvas/previewFps ⊕ active snapshot's
  arrangement. Also the `getGridLayout`/`setGridLayout` IPC DTO shape.
- `GridCue` (:1272) — `{ TickTime tick; std::string snapshotId; }` — how snapshots are sequenced.
- Helpers: `makeGridSnapshot` (:1310), `applyGridSnapshot` (:1326), `generateSnapshotId` (:1295).
  On-disk container schema doc at :1277.

`engine/src/model/Timeline.{h,cpp}`:
- State: `m_gridSnapshots` (:340), `m_gridCues` (:341), `m_defaultSnapshotId` (:339),
  `m_activeSnapshotId`.
- Snapshot CRUD: `createGridSnapshot` (:100), rename/delete/setActive/get/getDefault.
- Cue CRUD: `addGridCue` (Timeline.cpp:1289) / move / remove / get.
- Persistence: `toJSON` cues at Timeline.cpp:1658-1663; `fromJSON` cues at :1838-1850. **Exact spot
  a per-cue transition serializes.**

Bridge `engine/src/XlethEngineService.cpp`: snapshots `Timeline_CreateSnapshot` (:5921) +
Duplicate/Delete/Rename/SetActive/List — all under `syncEventsMutex` (:5916, :5942, :5959, :5976).
Cues: `gridCuesToJs` (:6014), `Timeline_AddCue` (:6040), Move/Remove/List — also under the mutex.

Preload `ui/preload.js`: snapshot + cue surface at :152-165.

### 1b. Hard-cut / boundary logic
No explicit switch branch — the hard cut is **implicit** in `Timeline::gridLayoutAt(TickTime t)`
(Timeline.cpp:1254): walks cues, keeps last cue with `tick <= t` resolving to a live snapshot,
returns arrangement **by value**. Single call site turning tick→snapshot is
`FrameCollector::collectRequests` (FrameCollector.cpp:122):
`const GridLayout layout = timeline.gridLayoutAt(TickTime{ projectFramePpq });` — **the seam.**
During a window: A = `gridLayoutAt(pin − 1)`, B = `gridLayoutAt(pin)`.
Preview path: XlethEngineService.cpp:3212 (holds mutex), composite :3366, readback :3386.
Export path: OfflineRenderer.cpp:1050 + :1639; composite/readback :1081/:1086 and :1658/:1660.

> LATENT BUG (must fix for transitions): `compositeFrame(..., cols, rows, gapScale)` gets
> `cols/rows/gapScale` from a separately-fetched active-snapshot `getGridLayout()` (preview
> :3122; export OfflineRenderer.cpp:524/924/1565), NOT the tick-resolved layout. `gridCellToUV`
> (GridCompositor.cpp:1260) divides UV by `cols*8`/`rows*8`, so a cue switching to a snapshot with
> different dims mis-places cells. Masked today because snapshots share dims. The transition work
> must pass each snapshot's own cols/rows/gapScale — which also fixes this.

### 1c. Transition UI "in progress" — DOES NOT EXIST
Natural host: snapshot mgmt `ui/src/components/timeline/VideoOverviewTab.jsx` (:115); cue lane
`ui/src/components/timeline/VideoMirrorCanvas.jsx` (`CueLane` :113, `CueMarker` :24, cue-editor
popover `.vmt-cue-editor` :89, `CUE_LANE_HEIGHT=30` :16); container/IPC
`ui/src/components/timeline/VideoMirrorTimeline.jsx` (`listCues` :118, `mutateCue`,
handleAdd/Move/Remove/RepointCue :196-222, `useTimelineZoom` :46, `TimelineRuler`); styles
`.vmt-*` in `ui/src/styles/app.css`. The editor is a natural extension of the selected-cue popover
+ Start/End handles drawn around the fixed marker.

## Task 2 — Two-RT approach, confirmed
- **RTPool** (GridCompositor.h:94, impl :1281): `acquire(device,w,h,slot)` keyed
  `(slot<<48|w<<32|h)`; **each `RTPair` already holds two targets texA/texB w/ RTV+SRV** → one
  acquire at a reserved slot gives RT_A=texA, RT_B=texB. Slots 0=track,1=ZPR,2=pingpong,3=companion
  (:394) → reserve `kTransitionRtSlot=4`. Format R8G8B8A8_UNORM.
- **GridCompositor** writes one fixed `renderTargetRTV_` and `readback()` reads it (compositeFrame
  :484; binds :514, rebinds after passes :683/:719/:799). Refactor: give `compositeFrame` optional
  `ID3D11RenderTargetView* targetRTV=nullptr`; route the 4 bind sites through it. Then compositeA→
  RT_A, compositeB→RT_B, transition pass samples srvA/srvB→renderTargetRTV_, readback unchanged.
- **Transition pass runs** immediately before `readback()` (preview :3386; export :1086/:1660).
  Outside window keep single compositeFrame (zero overhead).
- **Transition shader** follows EffectShaderCache template (:117): add `transitionPS` + 32-byte
  `transitionCB` @b2; bind srvA@t0, srvB@t1; one fullscreen quad via existing drawEffectPass; see
  ping-pong block :730-805 as the working "blit two SRVs into an RT, read back" reference.
  crossfade=`lerp(a,b,smooth(t))`; line sweep = angle-parameterized step/smoothstep from geometry.
- **FrameCollector for both snapshots**: add optional layout/snapshot override to `collectRequests`
  so caller forces A or B. reqB every frame; reqA once at entry (freeze) or per-frame if
  `freezeOutgoing==false`. "Tagged" = caller keeps two vectors; no per-request tag field needed.
- **RenderClock / t** (RenderClock.h): all integer. `pinSample=ppqToSample(pinTick,sr,bpm)`;
  window `[pin−startOffset, pin+endOffset]`; frame at `S=projectStartSample+videoFrameToSample(f)`:
  `S≤start→0; start<S<pin→0.5·(S−start)/(pin−start); S=pin→0.5; pin<S<end→0.5+0.5·(S−pin)/(end−pin);
  S≥end→1`. Preview==export by construction.

## Task 3 — Risk flags
1. **Data-race pattern — satisfiable.** `gridLayoutAt` already returns by value; snapshot/cue
   mutators already take `syncEventsMutex`; preview loop holds it around `collectRequests`. New
   work: value-returning `transitionAt(tick)` copying pin/offsets/type/freeze/geom + both A/B
   `GridLayout`s under lock; transition mutators under the mutex; never stash `const GridCue*`/
   `const GridSnapshot*` across the two composite calls.
2. **Freeze-frame determinism.** Frozen A must come from a fixed tick (pin or window-start) via
   RenderClock, not "whatever frame we were on." Cache RT_A keyed on `pinSample`; invalidate on pin
   change or seek outside window (stopped-preview scrub at XlethEngineService.cpp:3343).
3. **Perf floor (~0.25ms).** freeze=true ⇒ ~2× hard cut; freeze=false ⇒ ~3×. Gate whole path on
   `tick ∈ window && transition.enabled`. Compositor emits `fprintf(stderr,…)` per cell per frame
   (:504/:590/:649) — doubling requests doubles spew; keep transition path quiet.
4. **`effectsBypass_` divergence.** Preview fast path skips effect chains (:341); export doesn't.
   Transition pass must apply identically in both — treat as NOT bypassable.
5. **Windows-only — fine.** D3D11 throughout; shaders HLSL → fxc → checked-in `*PS.h`. New shader
   follows same `.hlsl→fxc→.h` flow; confirm fxc build-step wiring.
6. **Canvas is global — a positive.** canvas dims live on `GridLayout` globals, not `GridSnapshot`,
   so RT_A/RT_B share dims + letterbox. Transition blends two same-size letterboxed frames — no
   per-snapshot canvas reconciliation.

## Task 4 — Phased plan (targets)
Slice 2 — data model + deterministic t (engine; no visual). See build prompt.
Slice 3 — engine two-RT pass + parametric shader (crossfade + one line sweep).
Slice 4 — timeline UI (Start/End handles around fixed pin + Animation Type editor).

## Locked-design items the real code makes impractical
1. **"Owned by incoming snapshot" → own it on `GridCue`.** Snapshots are reused across cues; the
   cue is the boundary. UI still presents it as the incoming snapshot's in-transition.
2. **Offsets in samples → store in TICKS.** UI is beat/tick native (`pixelToBeat`,
   `snapBeatToGrid`); convert tick→sample with `RenderClock::ppqToSample` at resolve — equally
   deterministic, musically anchored, snap-native.
3. **`compositeFrame` dims from active snapshot → pass per-resolved-snapshot dims.** Fixes the
   latent cue-switch geometry bug too.

Everything else (two-RT via RTPool, parametric PS from EffectShaderCache, t from RenderClock,
freeze-outgoing default, transition-pass-before-readback) maps directly with no blockers.

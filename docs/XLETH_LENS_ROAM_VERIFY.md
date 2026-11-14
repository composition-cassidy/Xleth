# XLETH Lens + Roam: P12 verification

Date: 2026-11-14. Branch `feature/lens-roam`, HEAD `5ee55dc` (P11).
Spec: `docs/XLETH_LENS_ROAM_SPEC.md` (locked). Audit: `docs/XLETH_LENS_ROAM_AUDIT.md`.
Scope: verification only. No feature code was changed. New: two tests and this doc.

## How this was run

- **Isolated from the working tree's uncommitted WIP.** The checkout carries another session's uncommitted engine work (146 files, including `OfflineRenderer.cpp`, `FFmpegMuxer.cpp`, `Track.cpp`, `TimelineCommands.cpp` and three video shaders). The binaries in `build/` and `bridge/build/` were compiled WITH it. Every engine and bridge result below comes from clean worktrees instead: `C:/xlv-head` at `5ee55dc` and `C:/xlv-pre` at `e684ac6` (the last commit before P1), both configured against the main tree's pre-installed vcpkg packages, no toolchain.
- **Exception:** the real-app UI frame-pacing run (item 3b) used the main tree's built app (`ui/dist` 14:38 and `bridge/build/Release/xleth_native.node` 14:38, both P11 plus the foreign WIP). The WIP does not touch any timeline drawing file.
- Machine: i7-13700KF, RTX 4080, 128 GB, 144 Hz display. This is NOT the low-end laptop; see item 6.

## Summary

| # | Check | Result |
|---|---|---|
| 1 | Old projects render bit-identically | **PASS.** 14 renders of 13 pre-P1 projects (schema v1, v5, v6, v7): every frame byte-identical, pre-P1 build vs HEAD. One edit-time gap (Issue 3). |
| 2 | Live vs export match | **PASS** (headless, real D3D11). 7 feature scenarios, 81 frame pairs each, byte-identical, seek-safe. |
| 3a | Engine cost, 8x8 / 32 tracks / 2,000 notes, all keyed | **PASS at the median, FAIL at the tail.** Collect + composite CPU 0.03 ms; GPU done 0.15-0.17 ms median. p95 GPU 0.41-0.48 ms, caused by Issue 1. |
| 3b | UI at 60 fps while scrolling during playback | **Vertical scroll PASS** at full speed (144 fps; 59 fps at 4x CPU throttle). **Horizontal scroll FAIL**: 79.6 fps average but 38 frames over 20 ms in 8 s; 18.8 fps at 4x throttle (Issue 2). |
| 4 | Every new command undoable, survives save/load | **PASS.** All 15 edit RPCs, through the addon. |
| 5 | Threading of the snapshot path | **PASS for locks, logging and races. FAIL for allocation** (Issue 1). |
| 6 | Manual checklist for the low-end laptop | Below. |
| 7 | Note animations that start on the first frame that sees the note | Separate bug report below (not fixed). |

## Issues, ranked by severity

### 1. HIGH: animated Roam scale makes the Lens pass create a new GPU render target every frame
- **Where:** `GridCompositor.cpp:892-896` sizes the Lens pass from the cell rect AFTER Roam (`rw`/`rh` are rewritten by `roamCellRect` at 846-851). `applyLensPass` (`GridCompositor.cpp:1431`) calls `rtPool_.acquire(device_, dstW, dstH, kLensRtSlot)`. RTPool keys on (slot, width, height) and keeps a pair until it is idle for 10 s (`RTPool::pruneIdle`). So every new pixel size of a Lens-active cell creates a pair of textures plus views on the render thread, and the pair is kept for 10 s.
- **Measured** (`test_lens_roam_verify` Part D, one Lens-active cell spanning a 1920x1080 canvas, Roam scale keyed 0.6 -> 1.0 over 4 bars, 210 frames = 7 s): **VRAM +1,053 MB**, 0.8 heap allocations per frame in `compositeFrame`, composite CPU median 0.098 ms (vs 0.002 ms with a constant scale), GPU done median 0.35 ms (vs 0.04 ms). With a constant scale: VRAM +5 MB, 0 allocations.
- In the 8x8 stress project (small cells) the same effect is +25 MB over 300 frames at 1080p and 49-96 allocations per 290 frames.
- **Who hits it:** any cell with a non-Stretch Lens (the default for every new clip and source is Cover) and a Roam Scale key, including the rest key Auto-key drops one bar before the first key (P10). Also the export, which uses the same compositor.
- **Why it matters:** on the low-end laptop's shared-memory GPU a 4-bar scale move on a large cell can take more than 1 GB before anything is evicted. Breaks the "no allocation on the render thread" rule.
- **Related, pre-existing:** the visual chain, standalone ZPR and ping-pong targets are sized from the same `rw`/`rh`, so per-note Bounce squash already churns them. Roam scale keys now make it a user-authored, long-running case for every cell with an effect.
- **Fix direction (not a one-liner, needs a ruling):** render the Lens pass at the pre-Roam home size (`roamHome.w/h`) and let the final draw scale it, or round target sizes to buckets, or keep one target per (slot, cell) and reallocate only on growth.

### 2. MEDIUM: horizontal scroll of the arrangement during playback drops below 60 fps
- **Measured** in the real app (stress project, 1280x800 window, Reel/Roam/Sweep lanes open on 32 Pattern tracks, playback running, Shift+wheel over the arrangement): see the table in item 3b. Unthrottled on this desktop: 79.6 fps average, p95 20.8 ms, 38 frames over 20 ms in 8 s. At 4x CPU throttle (a rough stand-in for the low-end laptop): 18.8 fps, p95 62.5 ms, 80 long tasks.
- Vertical scroll in the same conditions holds the display rate (144 fps, p95 7 ms; 59.4 fps average at 4x throttle with a p95 of 41.6 ms).
- **Attribution** (item 3b, same notes with no Lens/Roam data, with and without Reel lanes): the arrangement before this feature scrolls horizontally at 130.7 fps here and already misses 60 fps at 4x throttle (27.8 fps). Reel lanes cost 15 % of that, Sweep + Roam lanes a further 26 %, and the two together are what push frame times past 20 ms on this desktop. At 4x throttle the Sweep + Roam lanes also halve vertical-scroll frame rate (111 -> 59 fps).
- Hypothesis to profile first (not verified): the Roam and Sweep lanes draw a curve per track (32 x 2 here) on each horizontal scroll step, on top of the 2,000 Reel clips.
- Not fixed (not a one-line change).

### 3. MEDIUM: old pattern content placed on another Pattern track switches from Stretch to Cover
- `lensroam::migratePreLensProject` (`LensRoam.cpp:381-401`) writes a Stretch entry only for `{track, region}` pairs that have a pattern block ON that track at load time. A source with no entry resolves to Cover (`resolveSourceLens`, `LensRoam.cpp:375-379`).
- **Reproduced** with the isolated addon on a copy of `SR\MIDI testing` (schema v1): the loaded source reads `explicit: true, fit: Stretch`; adding a block of the same old pattern on another Pattern track reads `explicit: false, fit: Cover`. In that project 12 of 24 patterns are not placed anywhere, so placing any of them later frames it Cover.
- Loading and rendering an old project are unaffected (item 1). The change appears on the first edit that places old content somewhere new: drag a pattern block to another Pattern track, place an unplaced pattern, convert a Clip track to a Pattern track.
- Clip Track events do not have this gap: a clip with no `lens` key loads Stretch, and copy/paste/split carry the lens (P3).
- **Needs a ruling:** for example, a per-project "pre-v8 default fit = Stretch" flag that `resolveSourceLens` consults for sources with no entry.

### 4. LOW: the snapshot is rebuilt inside `syncEventsMutex` after every undoable edit
- `publishLensRoamSnapshot` (`XlethEngineService.cpp:1555-1566`) builds the whole snapshot while holding the lock the video tick takes for its read phase. Measured on the stress project: 0.13-0.32 ms median, 1.5 ms worst of 15 builds. The video tick waits that long. Drags do not hit it (one commit on mouseup).
- Only the message/RPC thread writes the timeline, so the build could run outside the lock with only the pointer swap inside. Confirm that before changing it.

### 5. LOW (info): two non-undoable mutators do not republish the snapshot
- `ClearTimeline` (`XlethEngineService.cpp:6954`, not in the RPC manifest) and `Project_RemoveSource` (7890) change the timeline without UndoManager, so the snapshot keeps entries for removed ids until the next edit. Ids are not reused, so nothing renders wrong today.

### 6. INFO: what this pass did not cover
- Live vs export was proven headlessly (the same `FrameCollector` + `GridCompositor` calls the preview and the export make, real D3D11, byte compare). The app-level preview -> H.264 export spot check from P10 was not repeated.
- No numbers from the low-end laptop. The 4x CPU throttle in item 3b approximates the CPU only, not the GPU or shared memory.

## 1. Old projects render bit-identically

Method: `test_real_render` from each isolated build, on a scratch copy of each `project.json`, 960x540, 30 fps, 3 bars, `XLETH_VISUAL_DIAG_DUMP_FRAMES=1`, sha256 of every pre-encode BGRA frame. Pre-P1 build `e684ac6` vs HEAD `5ee55dc`. HEAD loads each through `ProjectManager` (schema < 8 migration logged).

| Project | Schema | Clip lenses loaded Stretch | Pattern sources migrated | Bars | Frames | Distinct frames | Result |
|---|---|---|---|---|---|---|---|
| BFDIA 6 | v5 | 1,299 | 2 | 9-11 | 206 | 202 | identical |
| BFDIA 7 | v5 | 1,171 | 8 | 5-7 | 155 | 155 | identical |
| BFDIA 9 | v7 | 3,133 | 8 | 5-7 | 155 | 155 | identical |
| BFB 5 Stratagem | v7 | 462 | 4 | 5-7 | 155 | 155 | identical |
| peter what are you doing | v7 | 649 | 1 | 5-7 | 155 | 154 | identical |
| tiki | v7 | 1,141 | 1 | 5-7 | 155 | 95 | identical |
| BFDI E | v7 | 64 | 1 | 5-7 | 155 | 1 | identical (media missing) |
| BFDIA 8 | v7 | 3,294 | 10 | 9-11 | 155 | 1 | identical |
| VST TESTING | v7 | 16 | 2 | 3-5 | 155 | 1 | identical |
| ppg quote | v6 | 213 | 0 | 5-7 | 155 | 1 | identical (media missing) |
| EAT | v1 | 98 | 0 | 5-7 | 155 | 1 | identical |
| FAMILY GUY REDBULL | v1 | 1,301 | 5 | 5-7, 12-14 | 155 x2 | 1 | identical |
| MIDI testing | v1 | 0 | 12 | 2-4 | 155 | 1 | identical |

Six projects have real motion (95-202 distinct frames, schema v5 and v7, pattern sources included). The single-frame ones still prove the static path but carry little weight. Edit-time gap: Issue 3.

## 2. Live vs export

New test `engine/test/test_lens_roam_verify.cpp`, Part A (registered with ctest). Each scenario renders the LIVE timeline the way the preview does (30 fps, `allowProxy`, layout override, preview effect mute) and a FROZEN copy the way the export does (its own events and snapshot, 60 fps, from a 1 s subrange start). Every 30 fps frame shares its project sample with an export frame, and each pair must be byte-identical. Guards: each scenario must differ from the same timeline with no snapshot (so a scenario that renders nothing cannot pass), and a fresh collector that seeks straight to a mid-note tick must equal both the sequential preview and the export.

| Scenario | Frame pairs | Identical | Frames that differ from identity | Seek ticks checked |
|---|---|---|---|---|
| Static Lens (Cover, centre, zoom 1.4, rotation 12, flip H on a clip; Contain, zoom 0.8, rotation -20, flip V on a source) | 81 | yes | 73 | 2 |
| Roam Float (keys on all four channels, layer Top) | 81 | yes | 73 | 2 |
| Roam Clip (static move + scale + rotation, Hold key) | 81 | yes | 42 | 2 |
| Hit curve, Squash (Punch + drift + body rotation; notes 960, 180, 60, 1440, 600 ticks) | 81 | yes | 42 | 4 |
| Hit curve, Cut (same notes) | 81 | yes | 42 | 4 |
| Nudge + Own (Follow, Nudge, Own, Nudge, Own) | 81 | yes | 42 | 5 |
| Sweep (zoom bump + centre move across notes and a gap) | 81 | yes | 42 | 3 |

The existing suites also pass in the isolated build: `test_lens_roam`, `test_key_curve`, `test_export_snapshot`, `test_compositor` (Tests 17-19).

Known divergences that remain, all pre-existing and outside Lens/Roam: proxy vs source pixels (by design), hold-through-gap is stateful on a seek, and the note animations in item 7.

## 3. Performance

### 3a. Engine, `test_lens_roam_verify` Parts B-D

Stress project built in code: 8x8 grid, 32 Pattern tracks (one cell each, half of them Float with layers), 2,000 notes (60-tick to two-step lengths, overlaps), 672 Nudge and 272 Own overrides, a keyed hit curve per source (Squash on even tracks, Cut on odd), Roam keys on offset X/Y, rotation and scale, Sweep keys on zoom and centre X. 4,592 compiled keys. 22.9 cells on screen per frame on average, 32 at most. 290 measured frames after 10 warm-up frames.

| Canvas | Config | Collect median / p95 | Composite CPU median / p95 | GPU done median / p95 | Allocs per frame in composite |
|---|---|---|---|---|---|
| 960x540 | no Lens/Roam | 0.011 / 0.027 ms | 0.004 / 0.009 ms | 0.069 / 0.092 ms | 0.0 |
| 960x540 | Lens + Roam + Sweep | 0.015 / 0.038 ms | 0.018 / 0.193 ms | 0.145 / 0.406 ms | 0.2 |
| 1920x1080 | no Lens/Roam | 0.010 / 0.028 ms | 0.004 / 0.007 ms | 0.129 / 0.169 ms | 0.0 |
| 1920x1080 | Lens + Roam + Sweep | 0.017 / 0.042 ms | 0.018 / 0.214 ms | 0.171 / 0.482 ms | 0.3 |
| 960x540, 600 frames | Roam scale constant | 0.014 / 0.035 ms | 0.016 / 0.021 ms | 0.162 / 0.252 ms | 0.0 |
| 960x540, 600 frames | Roam scale animated | 0.014 / 0.033 ms | 0.016 / 0.067 ms | 0.135 / 0.236 ms | 0.1 |

- "GPU done" is wall time from the start of `compositeFrame` until a D3D11 event query signals, so it includes the CPU submit.
- **Against the ~0.25 ms budget:** the Lens/Roam share is +0.004-0.007 ms collect, +0.013-0.014 ms composite CPU and +0.04-0.08 ms GPU at the median, so the median frame is inside the budget at both sizes. The p95 is not (0.41-0.48 ms GPU done), and the spikes come from Issue 1: with a constant Roam scale the CPU p95 falls to 0.021 ms.
- Message thread: `buildLensRoamSnapshot` 0.13-0.32 ms median, 1.5 ms max (Issue 4); `videoevents::build` 0.2-0.5 ms for context.
- Allocation (Part B, asserted): Lens/Roam adds no allocation to `collectRequests` (24,067 vs 24,067 over 290 frames; the 83 per frame are the pre-existing request strings and chain copies), and none to `compositeFrame` while cell sizes are constant.

### 3b. UI, real app

Playwright drives the built app (isolated profile) on the same stress project, built through the addon (`timeline_addNotesBatch`, `setHitCurve`, `setTrackRoamKeys`, `setTrackSweepKeys`, Nudge/Own overrides on 944 notes). The arrangement shows the Reel, Sweep and Roam lanes on all 32 tracks (scroll height 6,251 px). A `requestAnimationFrame` loop records frame intervals and a `longtask` observer records long tasks; scrolling is mouse wheel over the visible arrangement every 16 ms for 8 s, playback running. "x4" is CDP CPU throttling (a calibration loop ran 4.1x slower).

Four variants of the same 32 tracks and 2,000 notes. "Full": everything keyed, Reel + Sweep + Roam lanes open (scroll height 6,251 px). "Full, Reels collapsed": the 32 Reel lanes collapsed through their header buttons, Sweep + Roam lanes still open. "Plain": no Lens/Roam data (no hit curves, overrides, Roam or Sweep keys), so only the Reel lanes are added (2,411 px). "Plain, Reels collapsed": the closest to the arrangement before this feature (1,963 px). Window 1280x800, display 144 Hz. Idle and playing without input: 144 fps, p95 7.0 ms in every variant.

| Variant | Vertical x1 | Horizontal x1 | Vertical x4 | Horizontal x4 |
|---|---|---|---|---|
| Plain, Reels collapsed | 143.9 fps, p95 7.0 | 130.7 fps, p95 13.9, 0 > 20 ms | 118.7 fps, p95 27.6 | 27.8 fps, p95 41.8, 0 long tasks |
| Plain (Reel lanes) | 144.0 fps, p95 7.0 | 107.8 fps, p95 13.9, 0 > 20 ms | 111.4 fps, p95 27.8 | 23.7 fps, p95 48.7, 1 long task |
| Full, Reels collapsed (Sweep + Roam lanes) | 144.0 fps, p95 7.0 | 91.8 fps, p95 14.0, 2 > 20 ms | 59.0 fps, p95 41.6 | 21.1 fps, p95 55.6, 17 long tasks |
| Full (Reel + Sweep + Roam lanes) | 144.0 fps, p95 7.0 | **79.6 fps, p95 20.8, 38 > 20 ms** | **59.4 fps, p95 41.6** | **18.8 fps, p95 62.5, 80 long tasks** |

The "Full" row reproduced across two separate runs (79.2 / 79.6 fps horizontal x1).

Reading:
- **Vertical scroll during playback holds the display rate** in every variant at full speed.
- **Horizontal scroll** repaints the whole arrangement each step. The arrangement as it was before this feature already misses 60 fps at 4x throttle (27.8 fps). The new lanes make it worse in steps: Reel lanes -15 % (130.7 -> 107.8 fps at x1), Sweep + Roam lanes a further -26 % (to 79.6 fps), when the frame time starts to cross 20 ms on this desktop.
- **At 4x throttle the Sweep + Roam lanes halve vertical-scroll frame rate** (111-119 -> 59 fps, p95 28 -> 42 ms), independently of the Reel lanes.
- The arrangement is the only thing scrolled. The 8x8 preview (set to 30 fps) was playing in every run; its own frame rate was not measured here.

## 4. Undo and save/load

New test `bridge/test_lens_roam_contract.js`, run against the isolated HEAD addon. For each command: the call changes the state read back through `timeline_getLensRoam` plus every note's `lensOverride` from `timeline_getAllPatterns`; `undo_undo` returns exactly the earlier state; `undo_redo` returns exactly the edited state (canonical JSON compare). Then `project_save` -> `shutdown` -> `initialize` -> `project_load` returns exactly the final state, and `project.json` says schema 8.

| RPC | Changes | Undo exact | Redo exact |
|---|---|---|---|
| setClipLens | yes | yes | yes |
| setClipLensKeys | yes | yes | yes |
| resetClipLens | yes | yes | yes |
| setTrackLens | yes | yes | yes |
| setHitCurve (keys + zones, Cut) | yes | yes | yes |
| applyHitPreset ('Punch + drift') | yes | yes | yes |
| resetTrackLens | yes | yes | yes |
| setNoteLensMode (two notes -> Own; one note -> Nudge) | yes | yes | yes |
| setNoteLensKeys | yes | yes | yes |
| setNotesLensKeys (two notes, one step) | yes | yes | yes |
| revertNotesToFollow | yes | yes | yes |
| setTrackRoam (incl. Float + layer) | yes | yes | yes |
| setTrackRoamKeys | yes | yes | yes |
| resetTrackRoam | yes | yes | yes |
| setTrackSweepKeys | yes | yes | yes |

Also checked: a call that changes nothing records no undo step; an unknown field (`zooom`) is rejected and changes nothing; the final state survives save/load. 67/67 checks. The manifest -> preload -> IPC -> worker layers are covered by `bridge/test_rpc_manifest.js` (P11: 375/375); the UI gestures that call these (one commit on mouseup) were covered in P9-P11.

## 5. Threading review of the snapshot path

Read: `XlethEngineService.cpp` (publish 1540-1580, post-mutation hook 5595-5630, preview collector setup 5670-5675, video tick 4233-4566 and the transition path 4775-4810), `FrameCollector.cpp:670-700, 795-805, 935-960`, `FrameCollector.h:165-180, 395-400`, `LensRoam.cpp` render-time lookups, `LensRoamMath.h`, `KeyCurve.h`, `GridCompositor.cpp:780-905, 976-1070, 1423-1445`, `OfflineRenderer.cpp:648, 1461`, MixEngine pattern-note reads.

- **Locks: OK.** No new lock on the render or audio thread. The snapshot is built and swapped on the RPC thread under `syncEventsMutex`; the video thread reads it through a raw pointer only inside that lock. Both preview collect sites hold it: the main collect, and the snapshot-transition path, which keeps `eLock` to the end of the tick (`XlethEngineService.cpp:4565-4566`). The export builds its own snapshot from its frozen copy at setup and never reads the live timeline.
- **Lifetime: OK.** The previous snapshot's last reference is dropped on the RPC thread (`retired.reset()`), never on the video thread.
- **Data races: none found.** `lensRoam_` (a `shared_ptr` member) is written only under the lock and read only under it. `PatternNote::lensOverride` is an immutable `shared_ptr<const>`: the audio thread iterates `pattern->notes` by const reference and never copies a note or touches the override, so no refcount traffic or free happens there. The export's frozen copy shares the immutable overrides (atomic refcount only).
- **Logging: OK.** No logging in `lensForEventAt`, `lensBeforeSweep`, `applySweep`, `roamAt`, `LensRoamMath.h` or `KeyCurve.h`. The per-frame `[Roam] composite` line is behind `XLETH_DEV_ROAM_LOG` / `XLETH_DEV_LENS_ROAM_TRACK`, read once into a static. `[Lens]`/`[Roam]` snapshot lines are on the RPC thread, only when counts change.
- **Allocation: FAIL, Issue 1.** Evaluation allocates nothing (measured, Part B). The compositor's Lens target allocates per new cell size.
- Pre-existing, not Lens/Roam (spec "Out of scope"): the video thread's per-tick `syncEventsMutex` and per-cell chain copy. Also `[AnimMgr] note trigger` (`AnimationManager.cpp:267-270`) prints on the render thread at every note start, under `XLETH_DEBUG`, which is ON in Release builds.

## 6. Manual checklist for the low-end laptop

Build first: `build.bat all`. If the app was rebuilt from a different branch, `build.bat bridge-clean` and re-copy the vcpkg DLLs. Use a scratch copy of a real project. Open Task Manager > Performance > GPU and keep "Shared GPU memory" visible.

1. **Old project, untouched.** Open a pre-P1 project (for example `SR\BFDIA 9` or `SR\tiki`). Play 8 bars. Nothing should look cropped, letterboxed or moved compared with the main branch build.
2. **Old project, place old content.** In the same project, drag an existing pattern block onto a different Pattern track (or place a pattern that is not on the timeline). Expected today: that cell switches to Cover (cropped) - Issue 3. Note whether you want Stretch there.
3. **Static Lens.** Select a clip, set Fit Cover, drag the framing box, set zoom 1.5 and rotation 15. Preview updates on mouseup only. Ctrl+Z returns the exact frame; Ctrl+Y restores it.
4. **Hit curve.** Select a Pattern block, Simple: Punch, then Zoom pulse, Strength 150 %, Short notes Cut. Play: every note punches from its own start. Seek into the middle of a long note: it lands mid-animation, not restarting.
5. **Nudge / Own.** In the Piano Roll select one note, Advanced, Nudge, add a Centre X key. Select another, Own. Reel lane shows "+" and "O". Change the hit curve preset: the Own note does not change.
6. **Roam.** Track inspector: Offset X 0.5, Bounds Float, Layer Top: the cell draws over its neighbour. Bounds Clip: it is cut at its home cell.
7. **Roam keys, Issue 1 check.** Turn on Auto-key, at bar 5 drag the cell's scale handle to about 70 %, at bar 9 back to 100 %. Play bars 4-10 three times with the GPU graph visible. Record shared GPU memory before and after, and whether the preview stutters. A climb of hundreds of MB that falls back about 10 s after stopping is Issue 1.
8. **Sweep.** Reel header > Sweep. Add a zoom key at bar 5 (1.0) and bar 7 (1.4). Two notes inside that span zoom continuously, no jump at the note boundary.
9. **Export match.** Export bars 4-10 at 1080p. Scrub the exported file at bars 5, 7 and 9 next to the paused preview at the same bars: framing, cell position and rotation match.
10. **Scrolling while playing (Issue 2).** Open your largest project with Pattern tracks (the generated stress project used in item 3b lived in a temporary folder and is not in the repo). Show the Sweep and Roam lanes on several tracks. Play, then scroll the arrangement vertically, then horizontally (Shift+wheel), for 10 s each, with Ctrl+Shift+I > Performance recording. Then collapse the Reel lanes and hide Sweep/Roam and repeat. Below 60 fps only with the lanes open is Issue 2; below 60 fps either way is the pre-existing arrangement cost.
11. **Save / reopen.** Save, close, reopen: every value from steps 3-8 is still there.

## 7. Separate bug: note animations that start on the first frame that sees the note

Not fixed in this phase (spec Ruling 5 applies to Lens only, and Lens follows it). These existing animations latch their start time to `AnimationManager::nowMs_`, the time of the first video frame whose collector pass sees the note (`FrameCollector.cpp:609-635` fires `onNoteStart` when `ev->globalNoteIndex` differs from the cell's `activeNoteId`), not to the note's start tick.

| Animation | Trigger | Latched at | File |
|---|---|---|---|
| Zoom / Pan / Rotation device (per-note, `ZprTracks`) | note start | `zprStartMs = nowMs` | `AnimationManager.cpp:209` |
| ZPR retrigger crossfade | note start while a ZPR is active | `zprCrossfadeStartMs = nowMs` | `AnimationManager.cpp:195` |
| ZPR On-end Reset return | the frame that sees the ZPR end | `zprReturnStartMs = nowMs` | `AnimationManager.cpp:498` |
| Bounce device (per-note offset/squash) | note start | `bounceStartMs = nowMs` | `AnimationManager.cpp:246` |
| Slide ZPR delta layer | slide note | `slideZprStartMs = nowMs` | `AnimationManager.cpp:318` |
| Slide Bounce | slide note | `bounceStartMs = nowMs` | `AnimationManager.cpp:350` |
| TV Simulator slide ramp | slide note | `tvRampStartMs = nowMs` | `AnimationManager.cpp:372` |
| Slide ZPR / TV return legs | slide return trigger | `slideZprReturnStartMs`, `tvReturnStartMs` | `AnimationManager.cpp:867, 874` |

Effects, observed in code and consistent with audit divergence 2.3 and 2.4:
- **Preview vs export drift:** the preview samples at its own frame rate and the export at the export rate, so the latch lands up to one output frame apart (16-33 ms at 30-60 fps). The slide events are dispatched from different clocks: the preview crosses beats from `samplePos` (`XlethEngineService.cpp` video tick) while the export uses `projectFrameTick` (`OfflineRenderer.cpp:893, 1583`).
- **Restart on seek:** seeking into the middle of a note starts these animations from their first pose at the seek point; the preview also `resetAll()`s on seek-back and loop wrap.
- Fix direction: compute each from `(frame tick - note start tick)` statelessly, as Note Fade and Lens already do. Retrigger crossfade and On-end return need the previous note's start tick and length in the event list.

Adjacent, stateful by design: Visual Echo taps (frame history) and hold-through-gap restart on a seek.

## Files added in this phase

- `engine/test/test_lens_roam_verify.cpp` + its `engine/CMakeLists.txt` entry (ctest `test_lens_roam_verify`).
- `bridge/test_lens_roam_contract.js` (picked up by `bridge/run_contract_tests.js`).
- `docs/XLETH_LENS_ROAM_VERIFY.md` (this file).

# XLETH Landing verification (P6)

Verification of `docs/XLETH_LANDING_SPEC.md` as built on `feature/landing`, 2026-11-14. The decisions made along the way are in `docs/XLETH_LANDING_AUDIT.md` (D1 to D7).

## Result

All six phases are built and committed. Every test the spec lists exists and passes. The acceptance scenario passes in the live preview and in a real export, and the two match. Nothing in the existing suites regressed.

One thing needs your eye before this ships (section 7, item 2), one existing gap now matters more (item 3), and the render-target memory problem found in P0 has been capped since (item 1).

**What "the manual acceptance" means here.** The spec's acceptance is a person watching the scenario play. Nobody watched it. It was run as a script through the real addon (preview frames and a real export, measured pixel by pixel) and the UI was driven in the real Electron app. That covers geometry, timing, the seam, and preview against export. It does not cover how the move *feels* at speed, and it used five solid-colour clips, not a real project.

## 1. Where this was built

- Branch `feature/landing`, eight commits on top of `af40dee` (the tip of `feature/lens-roam`). Not pushed, not merged.
- Built in the worktree `.claude/worktrees/landing`. The main checkout was on `feature/lens-roam` with about 165 files of another session's uncommitted work, including `Timeline.cpp`, `TimelineTypes.h`, `OfflineRenderer.cpp` and `XlethEngineService.cpp`, which this feature edits. Switching that checkout's branch would have moved the other sessions' commits onto this branch, so it was left alone. **The app you run from the main checkout does not have Landings** until this branch is merged or the worktree's build is used. Expect merge conflicts in those four files against that uncommitted work.
- Engine, addon and UI were all built in the worktree from this branch only.

| Commit | Phase |
|---|---|
| `a13e78b` | P0: spec and audit |
| `e4ab9e8` | P1: model, JSON, cue CRUD, `landingsAt` |
| `0dac6e2` | P2: compositor on `GridRectMath.h` |
| `979f1fa` | P3: carried rendering, both seams |
| `c68f538` | P4: RPCs, manifest, contract test |
| `05a8732` | P5: Landings section, Reflow, tails |
| `c927b98` | P6: acceptance test and this report |
| after P6 | the render-target cap (section 7, item 1) |

## 2. What ran

| Suite | Result | Notes |
|---|---|---|
| `test_landing` (new, CPU) | 410 checks pass | normalize, JSON, cue CRUD, windows, From rects, the seam, Reflow |
| `test_grid_rect_math` (new, CPU) | 7,402,796 checks pass | the promoted rect function against a frozen copy of the old compositor code, bit for bit |
| `test_landing_render` (new, D3D11) | 10 groups pass | carry geometry, seam, determinism, transitions, hold last frame, degenerate rects, opacity, seek, the render-target cap |
| `test_landing_floor` (new, D3D11) | passes; digest matches the pre-feature build | section 4 |
| Engine ctest, all 109 | 105 pass | the 4 failures are the known ones, section 6. Re-run after the cap: the same four, plus `test_effect_audio_thread_reset` once in a parallel run; it passes alone, three times out of three |
| `bridge/test_snapshot_landing_contract.js` (new) | 59 / 59 | RPC contract, and the live preview seam through the real addon |
| `bridge/test_snapshot_landing_acceptance.js` (new) | 75 / 75 | the acceptance scenario, preview and export |
| `bridge/test_rpc_manifest.js` | 377 / 377 | includes both new RPCs end to end |
| Bridge suite, all 53 scripts | 44 pass when not under load | section 6 |
| UI vitest, all 358 files | 5,744 pass, 2 skipped | 50 new tests across three files |
| `eslint`, `stylelint` on the new UI files, `vite build` | clean | |
| Real Electron app, driven by Playwright | 18 / 18 | section 3 |

## 3. The acceptance scenario

`bridge/test_snapshot_landing_acceptance.js` builds the spec's reference project (two halves in snapshot 1; five cells in snapshot 2; cue at bar 9; chords and bass "Where it was" over 1 beat from 70 % opacity; lead "Edge" 270 over half a beat; no landing on percussion), then checks it twice: with a hard cut, and with a Push of one beat each side. Each check runs on the stopped-preview frames and on the frames of a real export.

| Expected in the spec | Result |
|---|---|
| Chords and bass shrink from their halves into their cells before the cut | Pass, preview and export |
| The lead rises from below; percussion appears on the downbeat | Pass. The lead's top edge is at 0.79 of the frame one frame in and 0.49 the next |
| Chords, bass and lead never pop at the pin | Pass. Each covers the same share of the frame in the last frame before the pin and in the pin frame, and sits in its snapshot-2 cell in both |
| The lead never splits or dims across the Push | Pass. Five points of its cell are pure lead colour on every sampled frame from the pin to the end of the window |
| Scrubbing into the lead-in shows the mid-move frame | Pass. The frame is byte-identical whether it is reached from before or from after |
| Preview and export match | Pass. Over 17 frames (hard cut) and 18 frames (Push): worst difference of a block average 0.7 of 255, worst single block 11 of 255. Every track covers the same share of the frame in both, within 2 % |

The preview is 960x540 and the export 480x270 through H.264, so "match" is measured on a 32x18 grid of block averages, not byte for byte. Byte-for-byte preview against export is covered at the helper level by `test_landing_render` group 4, which renders each frame with preview framing and with export framing through the same `LandingRenderer` and compares hashes.

**In the real app** (the worktree's build, an isolated profile, the real engine): the app boots with the two new IPC channels registered; the cue editor shows the Landings section; Reflow adds landings for the two tracks that change place; Add landing lists exactly Lead, Perc 1, Perc 2; "Where it was" is disabled for Lead; a typed 0.5 in Lead-in stores 480 ticks; dragging a tail end one beat left stores 1,920 ticks, with nothing sent to the engine during the drag; Remove removes it in the engine.

## 4. The perf floor (ruling 9)

A project with cues and no landings must render exactly as before.

- **Across builds.** `test_landing_floor.cpp` uses only the pre-feature API, so the same file was also compiled on `af40dee` in a scratch worktree. It renders a 16-beat project (three grid sizes, half and quarter spans, three gaps, per-track gap overrides, a fullscreen layer, corner radii, a Push, a hard cut, a crossfade, a Hold Last Frame track with gaps) and hashes every frame. **All 213 frame hashes are identical in the two builds** (digest `f49595b8737e7679`).
- **Inside one build.** `test_landing_render` group 1 renders 81 frames around a cue through the seam sequence with the landing calls in it and through the same sequence without them: identical. With landings authored, every frame outside a landing window is also identical.
- **Through the addon.** In the contract test, the preview frame before the lead-in and the frame at the pin are byte-identical with and without landings.
- **Cost.** A project without landings pays one scan of the cue list per frame (`hasCueLandings`) and one integer compare (`beginFrame`). No allocation.

## 5. Negative controls

Each mechanism was broken on purpose to confirm a test notices.

| Broken | Caught by |
|---|---|
| Destination lerped at `e == 1` instead of returned as stored | `test_landing`, the bitwise seam checks |
| Hold keep-list not installed | `test_landing_render` group 6 |
| Hold GC left on for the carry collect | group 6 |
| Roam's unit taken from the post-gap rect | group 3, the Roam seam case |
| Landing tracks not stripped from the frame layout | group 2 |
| Overlay clears the target | group 6 |
| Carried opacity not applied | group 8 |
| Transient pairs never evicted | `test_landing_render` group 10 (the pool reaches 297 pairs) |
| Zero-area rect not skipped | **not caught.** A zero-size quad rasterizes nothing either way, so the skip is not observable in pixels. It stays, as the spec asks, to keep a stage from sizing a target from a zero rect |

## 6. Failures that are not from this branch

**Engine ctest, 4 of 109.** The same four, with the same messages, as before the feature: `test_flip_orientation_golden` (all six goldens mismatch), `test_xlethfilter_analog` (follower did not sweep the cutoff), `test_frame_collector` (aborts in Test 1a, `sourceFrameIndex == 90`), `test_real_render` (`test/project.json` is not in the repo). `test_frame_collector` stops at Test 1a, so none of its later tests run in ctest; the collector's new guards are covered in `test_landing_render` instead.

**Bridge suite, 9 of 53.**

- Five need media that is not tracked, so they cannot pass in a clean worktree: `test_auto_loop_smoke`, `test_fedda_bridge`, `test_filter_live_animation` (both want `docs/plans/hall_ab_renders/hall_before_chord.wav`), `test_pdc_live_presentation_refresh`, `test_sandbox_bridge`. Not run against a baseline build; each stops at its missing file.
- Four are stale tests that were already red: `test_patterns` (sampler envelope keys), `test_resonancesuppressor` (viz schema 2, got 3), `test_sampler_mod_ui_smoke` and `test_sampler_modulation_bridge` (schema 3, got 8).

In the one full-suite run, `test_chroma_key_contract` and the new acceptance test also failed. That run overlapped with the Electron run and a build. Both pass alone. The acceptance test now waits until the preview shows every clip before it measures; it was not re-run inside a loaded full suite after that change.

## 7. Open

1. **Render targets while a landing changes size: memory is capped; the allocations remain.** Content stages size their targets from the cell's current pixel size, and `RTPool` kept each size for 10 s. New clips default to Lens fit Cover, so most tracks run the Lens stage. Left alone, a 1080p export would have held, per stage and per track (computed):

   | Landing | Frames | Distinct sizes | Target pairs held, before the cap |
   |---|---|---|---|
   | Reference: half screen to a 1/16 cell, 1 beat, Land | 12 | 11 | 26 MB |
   | Same, 16 beats (the maximum), Land | 205 | 140 | 335 MB |
   | Same, 16 beats, Linear | 205 | 206 | 814 MB |

   **Capped after P6** (`RTPool::beginPass`). A pair created while a cell in flight is being drawn is marked transient and is evicted once no composite pass has touched it for four passes. A pair an ordinary cell asks for is never transient, so a frame without landings is unaffected, and the count is in passes, not wall time, so an export behaves like the preview. Measured in `test_landing_render` group 10, with two tracks shrinking over four bars through 68 distinct widths, each with Lens Cover and a track effect: the pool peaks at **13 pairs** (hard cut) and **8** (inside a crossfade), against **297** with the eviction switched off. Pixels are unchanged: the seam case after that move is still identical to snapshot B, the acceptance scenario still passes 75 / 75 with the same preview-against-export numbers, and the cross-build floor digest is unchanged.

   What is left: a new size still means creating a texture pair that frame and releasing it a few passes later, so a size-changing landing allocates on the GPU every frame it moves. That cost was not measured. A Visual Echo on such a track still loses its trail for the length of the move, because its ring is reallocated when the size changes. `Edge` only translates and has neither cost. The cap does not touch animated Roam scale, which is Issue 1 in `docs/XLETH_LENS_ROAM_VERIFY.md` and has the same cause.

2. **"Land" finishes most of a short move in two frames (your call).** The spec's default curve is `(0.22, 1, 0.36, 1)`. At 30 fps with a half-beat lead-in the lead is wholly in frame one and a half frames after it starts. It is correct to the curve and it lands cleanly; whether it reads as a move or as a pop is a taste question the tests cannot answer. Glide and Linear are one click away.

3. **Cue edits do not mark the project as changed.** `project_isDirty` stays false after `setCueLandings`, and equally after `setCueTransition` and `moveCue`. This is how cue edits already behaved; landings follow the same path, as ruling 10 says. Whether the app can therefore close without offering to save them was not checked.

4. **A tail's grab area is under the 24 px floor.** Four rows share a 24 px lane, so a tail end is grabbable within 6 px either side and by nearest row. The Lead-in field in the cue editor is the same edit without a drag. Only the selected cue's tails are grabbable.

5. **Not tried.** A real project with real footage. A landing window that overlaps the tail of the previous cue's transition (handled like any transition frame; no test). A landing on a track with a visual effect chain, ping-pong or an echo in the real app. Whether the stopped preview repaints by itself after a landing edit (the same question applies to a transition edit). Preview scrolling cost with many cues that have tails.

6. **Smaller notes.** Reflow replaces an existing landing for a track that moves with a fresh "Where it was" one, as the spec says, so a hand-set opacity or curve on that track is reset. `moveGridCue` now carries the transition (it used to drop it): dragging a cue with a transition behaves differently from before, on purpose (audit D1). Exported files have video timestamps that are not on an exact 1/30 s grid (0, 0.0547, 0.0880, ...); the muxer is untouched by this branch, and it only matters to anyone reading frames back by index.

## 8. Try it

1. Merge `feature/landing`, or run the build in `.claude/worktrees/landing`. Rebuild the addon either way.
2. Make two snapshots that place some of the same tracks differently, and add a cue to the second one.
3. Click the cue pin. Under Transition there is a **Landings** section. **Reflow** adds a landing for every track that changes place; **+** adds one for a track that is new in the snapshot.
4. Open a row to set From, Lead-in, From opacity and the curve. Or drag the left end of a tail on the lane.
5. Play across the cue, then export the same range.

## 9. `graphify update .`

Run in the worktree, where the code is. The graph in the main checkout was not touched, because the main checkout does not have this code.

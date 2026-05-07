# Phase E.4.1 Diagnostic: Video Companion FX Still Inactive

Date: 2026-05-06
Workspace: `C:\Users\Krasen\Desktop\XLETH`
Branch: `feature/clip-modulation-fx-integration`

## Executive summary

There is not one single shader-math failure. The current evidence points to two gating failures before shader visibility:

1. **The currently saved/runtime-tested project has no video companion flags enabled.** The only two clips with audio modulation enabled are compatible, but both have `modulation.video.vibratoSwirlEnabled=false` and `modulation.video.scratchWaveEnabled=false`, so `buildClipCompanionFxSnapshot()` must return inactive snapshots.
2. **Electron realtime preview is not using the E.3 OpenGL `VideoCompositor` path.** The running Electron worker loads `bridge\build\Release\xleth_native.node`, which links `XlethEngineCore` with `XLETH_CORE_ONLY`; `VideoCompositor.cpp` is compiled only into the standalone `XlethEngine.exe`. Electron preview uses the D3D11 `FrameCollector` + `GridCompositor` path, and that preview collector never calls `setCompanionFxEnabled(true)`, so companion snapshots are suppressed even if clip flags become true.

Export is structurally wired for E.2: `OfflineRenderer` enables companion FX, `FrameCollector` populates `request.companionFx`, and `GridCompositor::processCompanionFx()` runs when flags are true and `effectsBypass_` is false. For the latest saved project, export is inactive because the clip video flags are false, not because the export compositor is obviously bypassed.

## Preflight

- `Get-Location`: `C:\Users\Krasen\Desktop\XLETH`
- `git branch --show-current`: `feature/clip-modulation-fx-integration`
- `git log --oneline -8`:
  - `ccf9731 Phase C.1: deterministic vibrato source-position seeding`
  - `aabae0f Phase C: Clip Modulation FX — Audio Vibrato MVP`
  - `29cfcbd Phase B: pure deterministic ClipModulation evaluator + tests`
  - `e318139 Phase A: Clip Modulation FX data model + plumbing`
  - older checkpoint commits follow
- Working tree is dirty with E.2/E.3/E.4 source changes and untracked companion-FX files.

Plain `git grep` finds references in tracked files, but many E.2/E.3 files are still untracked. `git grep --untracked` confirms the actual builder and snapshot sources exist:

- `engine/src/model/ClipCompanionFxBuilder.cpp`
- `engine/src/model/ClipCompanionFxBuilder.h`
- `engine/src/model/ClipCompanionFxSnapshot.h`
- `engine/test/test_clip_companion_fx_builder.cpp`

## Native addon/runtime check

Latest runtime log: `C:\Users\Krasen\AppData\Roaming\xleth-ui\startup.log`

The app run at `2026-05-06T12:44:21Z` was a dev Electron run:

- `app.isPackaged=false`
- worker path: `C:\Users\Krasen\Desktop\XLETH\ui\addon-worker.js`
- bridge dir: `C:\Users\Krasen\Desktop\XLETH\bridge\build\Release`
- loaded addon path by construction: `C:\Users\Krasen\Desktop\XLETH\bridge\build\Release\xleth_native.node`

Binary timestamps:

- Dev addon: `bridge\build\Release\xleth_native.node`, size `10,734,080`, last write `2026-05-06 14:10:43`
- Packaged addon: `dist\win-unpacked\resources\bridge\xleth_native.node`, size `10,613,248`, last write `2026-05-02 12:47:41`

String checks:

| Binary | E.4 field strings | E.2 export strings | E.3 OpenGL uniform strings |
|---|---:|---:|---:|
| `bridge\build\Release\xleth_native.node` | yes: `vibratoSwirlEnabled`, `scratchWaveEnabled` | yes: `VibratoSwirl`, `ScratchWaveSmear`, `All 7 effect shaders` | no: `uSwirlEnabled`, `uWaveEnabled` |
| `dist\win-unpacked\resources\bridge\xleth_native.node` | no | no | no |
| `build\engine\XlethEngine_artefacts\Release\XlethEngine.exe` | n/a | yes | yes: `uSwirlEnabled`, `uWaveEnabled` |

Conclusion: the last Electron run was **not using the stale packaged addon**, but it also **cannot contain the E.3 OpenGL preview path** because the bridge build intentionally excludes `VideoCompositor.cpp`.

Evidence:

- `engine/CMakeLists.txt:220-226`: `XlethEngineCore` is CPU-only and excludes `VideoCompositor`.
- `engine/CMakeLists.txt:295-298`: `XLETH_CORE_ONLY` is defined for `XlethEngineCore`.
- `engine/CMakeLists.txt:382-392`: `VideoCompositor.cpp` is compiled only into the standalone `XlethEngine` executable.
- `engine/src/SyncManager.cpp:10-12`, `202-229`, `282-330`: the `layer.companionFx` preview assignments are inside `#ifndef XLETH_CORE_ONLY`.

## UI persistence check

Static UI and bridge mapping look correct:

- `ui/src/components/TimelineView.jsx:267-288`: `mergeClipModulationPatch()` preserves existing `video` fields and merges `videoPatch`.
- `ui/src/components/TimelineView.jsx:2838-2843`: `handleSetClipVideoFx()` sends merged modulation to `window.xleth.timeline.setClipModulation()`.
- `ui/src/components/TimelineView.jsx:3215-3220`: "Swirl with Vibrato" sends `{ vibratoSwirlEnabled: e.target.checked }`.
- `ui/src/components/TimelineView.jsx:3231-3278`: amount/frequency/smear/reverse fields are sent as video patches.
- `ui/src/components/TimelineView.jsx:3237-3242`: "Wave with Scratch" sends `{ scratchWaveEnabled: e.target.checked }`.
- `ui/preload.js:155` and `ui/main.js:735-736`: IPC forwards `setClipModulation`.
- `bridge/src/XlethAddon.cpp:1212-1222`: `clipModulationToJs()` returns all video fields.
- `bridge/src/XlethAddon.cpp:1328-1350`: `jsToClipModulation()` reads all video fields while preserving the base modulation.
- `engine/src/model/Clip.cpp:62-72`, `124-135`: project JSON serializes/deserializes all video fields.

Runtime evidence from the latest log does **not** show any `timeline_setClipModulation` call during the captured run. The saved project does contain `modulation.video` objects, but all visual enable flags are false.

Latest saved project checked:

`C:\Users\Krasen\Desktop\SR\MIDI testing\project.json`

Summary:

- Total clips: `383`
- Clips with audio vibrato enabled: `1`
- Clips with audio scratch enabled: `1`
- Clips with `video.vibratoSwirlEnabled=true`: `0`
- Clips with `video.scratchWaveEnabled=true`: `0`
- Compatible clips by reverse/stretch/formant gate: `324`

Relevant modulated clips:

| clip | compatible | modulation.enabled | vibrato.enabled | scratch.enabled | scratch curve points | video swirl | video wave |
|---:|---:|---:|---:|---:|---:|---:|---:|
| `113` | yes | true | true | false | 0 | false | false |
| `1062` | yes | true | false | true | 3 | false | false |

For the current saved project, the UI/model persistence layer has the fields, but the actual enabled flags are false.

## Activation and compatibility check

Expected activation gate for both preview and export is:

- `event.hasClipModulation`
- `modulation.enabled`
- `modulation.vibrato.enabled || modulation.scratch.enabled`
- `!clip.reversed`
- `clip.stretchRatio == 1.0`
- `!clip.formantPreserve`

Evidence:

- `engine/src/SyncManager.cpp:22-30`
- `engine/src/render/FrameCollector.cpp:16-24`
- `engine/src/audio/MixEngine.cpp:2213-2218`

Current modulated clips `113` and `1062` pass the clip compatibility gates:

- `reversed=false`
- `stretchRatio=1.0`
- `formantPreserve=false`

But the matching visual flags are false:

- clip `113`: vibrato audio is enabled, but `video.vibratoSwirlEnabled=false`
- clip `1062`: scratch audio is enabled with a non-empty curve, but `video.scratchWaveEnabled=false`

Therefore, current export/preview requests are expected to be visually inactive.

## Snapshot builder check

`engine/src/model/ClipCompanionFxBuilder.cpp` gates exactly as intended:

- returns default snapshot when `timing.timingActive=false`
- enables swirl only when `video.vibratoSwirlEnabled && timing.vibratoActive`
- enables wave only when `video.scratchWaveEnabled && timing.scratchActive`

The built test from the same bridge build passes:

`bridge\build\Release\test_clip_companion_fx_builder.exe`

Result:

- `Passed: 45`
- `Failed: 0`
- `ALL TESTS PASSED`

This proves the builder produces active snapshots when the flags and timing inputs are active.

## Preview path check

There are two preview paths in source, but Electron uses the D3D11 preview-unify path:

- `bridge/src/XlethAddon.cpp:2476-2496`: creates `GridCompositor`, `RenderFrameCache`, `RenderVideoDecoder`, `AnimationManager`, and `FrameCollector`.
- `bridge/src/XlethAddon.cpp:2118-2120`: preview calls `g_previewCollector->collectRequests(...)`.
- `bridge/src/XlethAddon.cpp:2141+`: preview composites those requests with `g_previewCompositor`.

The current preview collector never enables companion FX:

- `engine/src/render/FrameCollector.h:228-231`: `companionFxEnabled_` defaults to `false`.
- `bridge/src/XlethAddon.cpp:2493-2495`: preview creates the collector and only calls `setAnimationManager()`.
- No call to `g_previewCollector->setCompanionFxEnabled(true)` exists.

The test suite already captures this exact behavior:

- `engine/test/test_frame_collector.cpp:338-354`: default collector suppresses companion snapshots.
- `engine/test/test_frame_collector.cpp:354-368`: after `collector.setCompanionFxEnabled(true)`, swirl snapshots become active.
- `engine/test/test_frame_collector.cpp:371-402`: scratch wave snapshots become active.
- `engine/test/test_frame_collector.cpp:404-416`: reversed clips correctly suppress snapshots.

Built test result:

`bridge\build\Release\test_frame_collector.exe`

- `Test 4c: companion FX snapshots: PASSED`
- `ALL TESTS PASSED`

Conclusion: preview failure point is **before the shader**. Even with active clip flags, Electron preview requests will carry default inactive `companionFx` until the preview collector opts in.

## Export path check

Export path is structurally wired correctly:

- `engine/src/render/OfflineRenderer.cpp:459-462`: export creates `FrameCollector` and calls `collector.setCompanionFxEnabled(true)`.
- `engine/src/render/FrameCollector.cpp:109-123`: export evaluates video modulation timing and populates `req.companionFx` when enabled.
- `engine/src/render/GridCompositor.cpp:781-793`: grid-cell pass calls `processCompanionFx()`.
- `engine/src/render/GridCompositor.cpp:1485-1498`: `processCompanionFx()` only returns early when compositor/shader/source invalid or both snapshot flags are false.
- `engine/src/render/GridCompositor.h:328`: `effectsBypass_` defaults to `false`.

No source-level export bypass was found. The latest saved project simply has both video flags false, so `req.companionFx` is expected to remain inactive and `processCompanionFx()` is expected to return the original SRV.

## Shader visibility sanity

I did not run the extreme-value visual test because the current failure occurs earlier:

- current project has no active video companion flags
- Electron preview collector suppresses companion snapshots by default

Testing extreme shader values should be deferred until a diagnostic run confirms active snapshots reach `GridCompositor::processCompanionFx()` or the OpenGL preview uniform path.

## Answers to required questions

1. **Is Electron using the current C++ native addon containing E.2/E.3?**  
   Latest logged Electron run used current dev addon `bridge\build\Release\xleth_native.node`. It contains E.2 export companion shader strings and E.4 field strings. It does not contain E.3 OpenGL preview uniforms because Electron links the `XLETH_CORE_ONLY` core, where `VideoCompositor` is excluded.

2. **Are E.4 UI controls writing `modulation.video` fields?**  
   Static wiring says yes: the toggles and sliders send `videoPatch`, IPC forwards it, bridge reads it, and model JSON persists it. The latest runtime log does not contain a live toggle call, so I did not observe a runtime write.

3. **Do `modulation.video` fields persist after `setClipModulation` and refresh?**  
   The fields persist structurally in `project.json`. In the latest saved project all visual enable flags are false, so there is no evidence that an enabled toggle persisted in that run.

4. **Is audio Vibrato/Scratch enabled at the same time as the visual flag?**  
   No, in the latest saved project. Clip `113` has vibrato audio enabled but swirl disabled. Clip `1062` has scratch audio enabled but wave disabled.

5. **Is the test clip compatible?**  
   The two modulated clips are compatible by the current gates: not reversed, `stretchRatio=1.0`, `formantPreserve=false`.

6. **Does `buildClipCompanionFxSnapshot` output active flags when expected?**  
   Yes. The builder source gates correctly, and `test_clip_companion_fx_builder.exe` passes all 45 assertions.

7. **Does `SyncManager` send active `layer.companionFx` to `VideoCompositor`?**  
   Only in non-`XLETH_CORE_ONLY` builds. Electron's native addon compiles those blocks out. The standalone `XlethEngine.exe` contains the E.3 OpenGL uniform strings; the Electron addon does not.

8. **Does `FrameCollector` send active `companionFx` to `GridCompositor`?**  
   Yes when `setCompanionFxEnabled(true)` is called. Export does this. Electron preview does not, so preview requests remain inactive.

9. **Are shaders bypassed because flags are false, `effectsBypass_` is true, or uniform locations are invalid?**  
   Current export/project: flags are false. Preview: flags are suppressed before compositor by `FrameCollector::companionFxEnabled_=false`, and E.3 GL uniforms are not in the Electron addon. `effectsBypass_` is false in settings and defaults false; no evidence points to bypass as the export root cause.

10. **What is the minimal fix?**  
   Minimal fix plan below.

## Proposed minimal fix plan

1. **Enable companion snapshots in Electron preview's actual D3D11 path.**  
   In `bridge/src/XlethAddon.cpp`, after `g_previewCollector->setAnimationManager(g_previewAnimMgr.get())`, call:
   `g_previewCollector->setCompanionFxEnabled(true);`

2. **Mark preview dirty on video-only modulation edits.**  
   In `Timeline_SetClipModulation`, set `g_previewDirty=true` after the command executes. Audio cache invalidation can remain selective; this is only to force a visual refresh while stopped.

3. **Confirm UI/runtime persistence with one live clip.**  
   Use clip `113` for swirl and clip `1062` for wave, or create a fresh compatible clip. After toggling, verify `project.json` or returned `clip.modulation.video` has the matching flag true.

4. **Add a runtime diagnostic counter/log only if still inactive.**  
   Log one frame where `FrameCollector` outputs `companionFx.vibratoSwirlEnabled` or `companionFx.scratchWaveEnabled`, then one `GridCompositor::processCompanionFx()` entry. Remove the log after confirmation.

5. **Do not rewrite shader math yet.**  
   The builder and collector tests already prove active snapshots work before the shader; current failures are gating/path issues.

## Files changed in this diagnostic

Only this report was added:

- `docs/plans/phase-e4-1-video-fx-still-inactive-diagnostic.md`

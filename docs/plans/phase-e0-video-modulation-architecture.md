# Phase E.0 - Linked Video Modulation Architecture Diagnostic

Date: 2026-05-06
Branch inspected: `feature/clip-modulation-fx-integration`
Workspace inspected: `C:\Users\Krasen\Desktop\XLETH`

## 1. Executive summary

Linked video modulation is feasible, but the safest implementation order is:

1. Implement shared video source-time modulation first for realtime preview and export.
2. Add export companion visual FX next using the existing D3D11 effect-chain infrastructure.
3. Add OpenGL preview visual FX later, or only after the export shaders prove the parameters and look.

The timing half should be implemented before any shader work because it is the part users explicitly expect: Scratch and Vibrato should visibly speed up, slow down, reverse, and freeze the video source, not merely decorate it. Scratch can safely use `evaluateScratch(...).sourceOffsetSeconds` as the primary video source-time driver. Vibrato should use a bounded source-offset approximation derived from `computeVibratoIntegratedSourceOffsetSamples(...)`, preferably via a shared helper that returns seconds at video-frame cadence.

Realtime preview and offline export currently compute source time separately:

- Realtime preview: `SyncManager::videoTick()` computes `sourceTime = event.sourceStartTime + secsSinceStart`.
- Export: `FrameCollector::computeSourceFrame()` computes the same expression and converts it to a source frame.
- Export visual FX exist in the D3D11 `GridCompositor` effect-chain path.
- Realtime `VideoCompositor` is a simpler OpenGL compositor with YUV upload and multi-layer composite, but no chainable visual effect infrastructure.

No production code was changed in this pass. This report is the only intended file change.

## 2. Current realtime preview video timing call flow

Preflight results:

- `pwd` confirmed `C:\Users\Krasen\Desktop\XLETH`.
- `git branch --show-current` confirmed `feature/clip-modulation-fx-integration`.
- `git grep` confirmed `ClipModulation`, `ClipModulationEvaluator`, `ClipModulatedReader`, `ClipVibratoIntegrator`, `evaluateScratch`, and UI `setClipModulation` symbols exist.
- Existing dirty working-tree changes were present before this report; they were not modified by this diagnostic pass.

Realtime preview event construction:

- `bridge/src/XlethAddon.cpp::rebuildVideoEventsFromClips()` rebuilds `VideoEvent` objects before transport playback.
- Clip tracks produce one `VideoEvent` per video-backed clip.
- Pattern tracks produce one `VideoEvent` per note instance.
- For clip tracks, `VideoEvent::sourceStartTime` is `region->startTime + clip->regionOffset.toSeconds(bpm)`, with syllable clips anchored to syllable start.
- `VideoEvent` currently carries `startBeat`, `durationBeats`, `sourceId`, `trackId`, `regionId`, `sourceStartTime`, `sourceEndTime`, layout fields, flip state, and pitch.
- `VideoEvent` does not currently carry `clipId`, `ClipModulation`, `clip` compatibility flags, or a per-frame modulation snapshot.

Realtime frame selection:

- `SyncManager::videoTick()` reads `audioTimeSec`, `audioTimeBeat`, and `bpm` from transport.
- It scans active `VideoEvent`s by beat range.
- It computes:

```cpp
beatsSinceStart = audioTimeBeat - event.startBeat;
secsSinceStart = beatsSinceStart * (60.0 / bpm);
sourceTime = event.sourceStartTime + secsSinceStart;
```

- It optionally routes to a region proxy decoder when `sourceTime` is inside the proxy window.
- It converts `seekTime` to `targetFrame` through `VideoDecoder::timeToFrame(seekTime)`.
- It uses `FrameCache` keyed by `{ sourceId, targetFrame, cacheRegionId }`.
- It decodes with `seekAndDecode(seekTime, decodedFrame)` on cache miss.
- It uploads the decoded frame to `VideoCompositor::uploadFrameToSet()` and then calls `VideoCompositor::renderComposite()`.

Where modulation would enter:

- The correct realtime insertion point is the source-time computation in `SyncManager::videoTick()` before proxy selection, `timeToFrame()`, cache lookup, and decode.
- Because proxy selection depends on source time, the warped `sourceTime` must be computed before choosing the original decoder vs region proxy.
- `clipLocalSeconds` is equivalent to `secsSinceStart` for the event. `clipLocalBeats` is `beatsSinceStart`.
- `sourceStartTime` enters as the source-region base offset and should remain the additive base.

## 3. Current export video timing call flow

Export event construction:

- `OfflineRenderer::buildVideoEvents()` constructs a separate vector of `VideoEvent`s for export.
- Clip tracks use `ev.sourceStartTime = clip->regionOffset.toBeats() * (60.0 / bpm) + region->startTime`.
- Pattern tracks use `ev.sourceStartTime = region->startTime`.
- Export uses the same `VideoEvent` struct, but event construction is separate from realtime preview construction.

Export frame selection:

- `OfflineRenderer::renderThreadMain()` advances audio buffers and uses `RenderClock::frameBoundsForBuffer()` to determine output video frames.
- Per output frame, `FrameCollector::collectRequests()` converts `outputFrameIndex` to `samplePos`, `seconds`, and `beatPos`.
- `FrameCollector::findActiveEvent()` chooses the active event per track.
- `FrameCollector::computeSourceFrame()` computes:

```cpp
beatsSince = beatPos - ev.startBeat;
secsSince = beatsSince * (60.0 / bpm);
sourceTime = ev.sourceStartTime + secsSince;
sourceFrameIndex = computeSourceFrameFromTime(sourceTime, sourceFps);
```

- `FrameCollector` then optionally clamps hold-last-frame after trim end, substitutes preview-only proxies when `allowProxy` is true, deduplicates requests, decodes missing `FrameCacheKey`s, and sends requests to `GridCompositor::compositeFrame()`.
- Final exports pass `allowProxy = false`, so original source pixels are used.

Where modulation would enter:

- The correct export insertion point is a shared source-time helper called from `FrameCollector::computeSourceFrame()` and from the hold/proxy source-time recomputation sites in `collectRequests()`.
- The helper should return the warped absolute source time and a small modulation snapshot for visual FX.
- Export and realtime should not each duplicate evaluator math by hand; otherwise preview/export drift will be almost guaranteed.

## 4. Recommended Scratch video timing formula

Scratch should drive video source time using the evaluator's deterministic integral:

```cpp
clipLocalSeconds = seconds since this VideoEvent started;
scratchEval = evaluateScratch(clip.modulation.scratch, ctx, clip.modulation.enabled);
sourceTime = sourceStartTime + scratchEval.sourceOffsetSeconds;
```

For constant-rate curves, expected behavior is:

- `rateMultiplier = 1.0`: matches current frame selection.
- `rateMultiplier = 0.0`: freezes on the source frame at the current integrated offset.
- `rateMultiplier = -1.0`: source time moves backward, so video reverses.
- `rateMultiplier = 2.0`: source time advances twice as fast.

Negative rates should not need a special case in video timing. `evaluateScratch()` already integrates the signed rate curve into `sourceOffsetSeconds`; video should consume that result.

`rateMultiplier = 0.0` should freeze naturally because the integral stops changing. Frame cache behavior should improve during freeze because repeated output frames request the same source frame.

Edge-mode mapping:

- `Clamp`: clamp the final source time/frame to the valid trimmed source range.
- `Silence`: video should still use the same scratch curve, but since video cannot be "silent", the safest MVP behavior is to hold black or hold the nearest valid edge only if the team explicitly wants a visual equivalent. Recommendation: use clamp for video display while preserving `silentByEdge` only for audio. This avoids black-frame flicker during scratches that briefly leave range.
- `Wrap` and `PingPong`: audio currently defers them in `ClipModulatedReader`; video should not claim support first. Treat as Clamp until audio supports them, or gate them behind the same implementation phase.

Out-of-range behavior:

- Before first frame: clamp to first valid frame for preview/export MVP.
- After trim end: clamp to `sourceEndTime - epsilon`, matching current hold-last-frame behavior.
- Do not allow negative source frame indices. `FrameCollector::computeSourceFrameFromTime()` already clamps negative frames to 0, but the helper should clamp source time intentionally before proxy routing to avoid nonsensical proxy checks.

DNxHR proxy/cache interaction:

- Proxy selection should use warped absolute `sourceTime`.
- If the warped time lands outside the region proxy's covered window, fall back to original source.
- Modulation will increase non-sequential frame access during fast scratches/reverses, reducing cache hit rate. This is expected and should be measured, not hidden.
- Freeze and slow sections should cache well.

## 5. Recommended Vibrato video timing formula or approximation

Vibrato should subtly follow pitch-derived source motion. The audio path already has the correct concept: `computeVibratoIntegratedSourceOffsetSamples(...)` returns the source offset accumulated by continuous vibrato playback at a given clip-local sample.

Recommended helper:

```cpp
baseSamples = round(clipLocalSeconds * sampleRate);
integrated = computeVibratoIntegratedSourceOffsetSamples(params);
vibratoResidualSeconds = (integrated - baseSamples) / sampleRate;
sourceTime = sourceStartTime + clipLocalSeconds + vibratoResidualSeconds;
```

For video-only timing, this can be simplified to a bounded frame-rate approximation if exact integration is too expensive:

- Evaluate at output-frame cadence, not per audio sample.
- Cache or memoize only within a frame/event calculation if needed; do not introduce thread-global evaluator state.
- Clamp the residual to a conservative range such as a fraction of a frame or a small absolute cap derived from depth and rate. The goal is visible wobble, not sample-perfect pitch readhead parity.
- Depth 0 must produce exactly the current source-time path.

Best staged approach:

- Phase E.1 should reuse `computeVibratoIntegratedSourceOffsetSamples(...)` for deterministic export/preview agreement.
- If performance is unacceptable, replace only the helper internals with a bounded approximation while preserving the public helper contract.
- Avoid integrating from scratch per cell if many cells share the same clip/time; event-level snapshots can be deduplicated later if profiling shows cost.

How to avoid visible audio/video drift:

- Use the same BPM, sample rate, timeline sample/seconds, clip-local sample/seconds, and phase-reset semantics as audio.
- For `phaseResetOnClipStart = false`, pass `clipStartTimelineSamples` and timeline-derived context so timeline-phase vibrato does not drift between preview and export.
- Keep Scratch and Vibrato composition deterministic per frame.

## 6. Recommended Scratch + Vibrato composition rule

Recommended rule:

```cpp
scratchBaseSeconds = scratchActive
    ? scratchEval.sourceOffsetSeconds
    : clipLocalSeconds;

vibratoResidualSeconds = vibratoActive
    ? (integratedVibratoSamples - clipLocalSamples) / sampleRate
    : 0.0;

sourceTime = sourceStartTime + scratchBaseSeconds + vibratoResidualSeconds;
```

Justification:

- This matches the Phase D.1 audio philosophy: Scratch owns the readhead/time warp; Vibrato adds pitch motion on top.
- Scratch remains the large, directional transport gesture.
- Vibrato remains a subtle source-position wobble.
- If the combined behavior feels too busy, the fallback rule should be "Scratch owns timing; Vibrato drives only Swirl while Scratch is active." But the first implementation should try the audio-aligned additive residual rule because it is more faithful to the user's sync requirement.

One important caveat:

- Audio's Scratch path seeds `vibTrimD` as an accumulated residual and then updates it per sample. Video does not need to reproduce that sample-perfect state, but it should compute the equivalent residual at the current frame time deterministically.

## 7. Clip compatibility and fallback

Current audio modulation compatibility predicate in `MixEngine`:

```cpp
clipMod.enabled
&& (clipMod.vibrato.enabled || clipMod.scratch.enabled)
&& !clip.reversed
&& clip.stretchRatio == 1.0
&& !clip.formantPreserve
```

Video timing should use the same predicate for clip tracks. If audio bypasses modulation because the clip is reversed, stretched, or formant-preserve, video timing should also fall back to normal timing. Otherwise users can get a very confusing mismatch: audio plays the cached processed clip while video still scratches or wobbles.

Pattern-note video events do not currently map to a clip-local `ClipModulation`; they are region/pattern driven. Phase E should limit linked video modulation to clip-track `Clip` events unless a separate pattern modulation model is designed.

Implementation implication:

- `VideoEvent` needs enough clip metadata to decide compatibility and evaluate modulation.
- Preferred: add `clipId` and copy/snapshot `ClipModulation` plus compatibility flags into `VideoEvent` at event-build time.
- Alternative: look up the clip from `Timeline` at frame time. This is riskier for realtime thread safety and export determinism.

## 8. Preview/export parity strategy

Preview/export parity is achievable for timing in one phase if both paths call the same source-time helper.

Recommended helper shape:

```cpp
struct VideoModulationSnapshot {
    bool timingActive;
    bool scratchActive;
    bool vibratoActive;
    float vibratoLfo;
    float vibratoPhase01;
    float vibratoCents;
    float scratchRateMultiplier;
    float scratchPhase01;
    float scratchIntensity01;
    double scratchSourceOffsetSeconds;
    double vibratoResidualSeconds;
    double sourceTimeSeconds;
};

VideoModulationSnapshot evaluateVideoClipModulationSourceTime(
    const VideoEvent& event,
    double beatPos,
    double bpm,
    double sampleRate,
    double sourceStartTime,
    double sourceEndTime);
```

Place the helper somewhere engine-side and compositor-agnostic, such as a new `engine/src/model/ClipVideoModulationTiming.{h,cpp}` or near `ClipModulationEvaluator` if the team wants all deterministic modulation math colocated. Keep it independent of D3D11, OpenGL, FFmpeg, and bridge.

Staged parity:

- E.1: timing parity in preview and export via shared helper.
- E.1: no companion visual shaders yet, or export-only hidden behind explicit "experimental/export only" flag.
- E.2: D3D11 export companion visual FX.
- E.3 or later: OpenGL preview visual FX, or compositor unification.

Avoiding mismatch:

- Do not implement visual distortions in export by default before preview can at least disclose or approximate them.
- If export-only shaders ship first, UI must label them as export-only or leave UI hidden until preview support exists.

## 9. Recommended visual companion FX architecture

Existing fields are present and sufficient for MVP:

- `vibratoSwirlEnabled`
- `scratchWaveEnabled`
- `swirlAmount`
- `swirlRadius`
- `swirlCenterX`
- `swirlCenterY`
- `waveAmount`
- `waveFrequency`
- `smearAmount`
- `reverseWaveWithScratch`

Recommended architecture:

- Keep companion visual FX clip-local under `ClipModulation::VideoCompanion`.
- Do not attach companion FX to `TrackInfo::visualEffectChain`.
- Treat companion FX as a separate clip-local compositor pass, not a user-authored track chain node.
- Pass a per-frame `VideoModulationSnapshot` through `CellFrameRequest`.
- In export, `GridCompositor` can reuse the ping-pong render-target machinery from `processEffectChain()`, but companion FX should be a separate branch such as `processCompanionFx(...)` before final `drawCell()`.

Why not `TrackInfo::visualEffectChain`:

- Track chains are track-level, user-authored, and persistent.
- Companion FX are clip-local, automatic/linked, and modulation-dependent.
- Injecting companion effects into the track chain would create ordering ambiguity, incorrect persistence semantics, and accidental cross-clip leakage.

Recommended export shader path:

- Add new D3D11 shaders:
  - `engine/src/render/shaders/FX_VibratoSwirl.hlsl`
  - `engine/src/render/shaders/FX_VibratoSwirlPS.h`
  - `engine/src/render/shaders/FX_ScratchWaveSmear.hlsl`
  - `engine/src/render/shaders/FX_ScratchWaveSmearPS.h`
- Extend `EffectShaderCache` or add a sibling `CompanionFxShaderCache`.
- Add constant buffers for companion params and live modulation snapshot.

Suggested constant-buffer contents:

```cpp
struct VibratoSwirlConstants {
    float amount;
    float radius;
    float centerX;
    float centerY;
    float lfo;
    float phase01;
    float cents;
    float pad0;
};

struct ScratchWaveSmearConstants {
    float amount;
    float frequency;
    float smearAmount;
    float reverseWithScratch;
    float rateMultiplier;
    float phase01;
    float intensity01;
    float pad0;
};
```

Shader behavior:

- Vibrato Swirl/Twirl should rotate UVs around `centerX/Y`, scaled by `swirlAmount * vibrato.lfo`, and attenuated by radius.
- Scratch Wave/Smear should offset UVs along one axis using phase/rate/intensity, with direction optionally flipped by negative scratch rate.
- Smear should be conservative for MVP; if multi-sample smear is costly, implement wave first and add smear in E.2.2.

## 10. Realtime visual FX implementation path

`VideoCompositor` currently has:

- YUV texture upload.
- Legacy single-layer rendering.
- Multi-layer OpenGL compositing.
- Position, scale, opacity uniforms.
- No visual effect chain.
- No ping-pong render targets.
- No clip-local modulation snapshot input.

Smallest preview parity path:

- Implement timing warp in realtime preview in E.1.
- Defer visual distortions in realtime preview.
- If visual FX must preview early, port only two GLSL companion shaders directly into `VideoCompositor`, but this creates duplicate HLSL/GLSL shader maintenance.

Recommendation:

- E.1: realtime timing warp only.
- E.2: export visual companion FX only if UI remains hidden or clearly marks export-only.
- E.3: OpenGL preview companion FX, or a broader compositor unification/refactor.

## 11. UI recommendation and default behavior

Do not implement UI in this diagnostic pass.

Minimal future UI:

- `Video Timing Follow`: Off / Timing Only / Timing + Visual
- `Link Vibrato Swirl`
- `Swirl Amount`
- `Swirl Radius`
- `Link Scratch Wave/Smear`
- `Wave Amount`
- `Wave Frequency`
- `Smear Amount`

Recommended default behavior:

- Video timing follow should be automatic when clip modulation is enabled and compatible.
- Companion visual FX should remain opt-in because distortion is stylistic.
- A default mode of "Timing Only" best matches user expectation: the video speed follows Scratch/Vibrato without surprising users with visible warps.
- If a clip is incompatible and audio bypasses modulation, show the existing warning and make video timing bypass too.

Current UI notes:

- `TimelineView.jsx` already exposes Vibrato and Scratch controls in the clip context menu.
- It already warns that modulation is bypassed while Reverse, Stretch, or Formant Preserve is active.
- It does not currently expose `modulation.video` controls.

## 12. Phase E.1 implementation plan

Goal: linked video timing warp in realtime preview and export, no shaders.

Likely steps:

1. Extend `VideoEvent` with clip modulation metadata for clip-track events only:
   - `clipId`
   - `hasClipModulation`
   - `modulation`
   - `clipReversed`
   - `clipStretchRatio`
   - `clipFormantPreserve`
   - optionally `clipStartBeat` or enough fields to build exact modulation context
2. Populate those fields in:
   - `bridge/src/XlethAddon.cpp::rebuildVideoEventsFromClips()`
   - `engine/src/render/OfflineRenderer.cpp::buildVideoEvents()`
3. Add a shared deterministic helper for video source-time evaluation.
4. Replace realtime `sourceStartTime + secsSinceStart` in `SyncManager::videoTick()` with the helper result.
5. Replace export `FrameCollector::computeSourceFrame()` with the helper result.
6. Replace hold-last-frame and proxy-selection recomputed source-time sites in `FrameCollector::collectRequests()` with the same helper result.
7. Keep pattern-track events unmodulated for now.
8. Add unit tests for the helper and export frame selection.
9. Add a diagnostic log or debug-only trace for warped source time/frame while developing.

Important E.1 non-changes:

- Do not modify `GridCompositor` for visual FX yet.
- Do not modify `VideoCompositor` for visual FX yet.
- Do not change schema.
- Do not add bridge/API calls.
- Do not add UI controls.
- Do not change Scratch/Vibrato presets.
- Do not add FFmpeg filters.

## 13. Phase E.2 implementation plan

Goal: companion visual FX for export, with preview strategy explicitly staged.

Likely steps:

1. Add modulation snapshot fields to `CellFrameRequest`.
2. Populate snapshots in `FrameCollector::collectRequests()` using the E.1 helper.
3. Add D3D11 shader resources for `VibratoSwirl` and `ScratchWaveSmear`.
4. Add a companion-FX processing path separate from `TrackInfo::visualEffectChain`.
5. Apply companion FX before final cell draw and after source frame selection.
6. Keep `effectsBypass_` behavior clear: decide whether it bypasses companion FX in preview/export fast modes.
7. Add disabled-FX identity tests.
8. Add visual regression tests or deterministic pixel hash tests for fixed snapshots.

If preview/export mismatch is not acceptable:

- Delay user-facing companion FX UI until OpenGL preview support exists.
- Or add a UI disclosure that visual companion FX affect export only.

## 14. Test plan

Scratch timing tests:

- Constant rate `1.0` matches current source frame selection.
- Constant rate `0.0` freezes the source frame.
- Constant rate `-1.0` reverses the source frame sequence.
- Constant rate `2.0` advances twice as fast.
- Source frame selection is deterministic for seeded/export frame positions.
- Out-of-range negative source time clamps to first frame.
- Out-of-range past trim end clamps to last valid frame.

Vibrato timing tests:

- Depth `0` matches current source frame selection exactly.
- Positive depth produces bounded source-time wobble.
- Tempo-sync and free-Hz modes produce deterministic snapshots.
- `phaseResetOnClipStart = false` remains deterministic against timeline position.

Composition tests:

- Scratch owns base source time.
- Vibrato residual adds on top when enabled.
- Scratch-only, Vibrato-only, and combined modes all produce finite source times.

Compatibility tests:

- Reversed clips bypass video modulation when audio bypasses.
- Stretched clips bypass video modulation when audio bypasses.
- Formant-preserve clips bypass video modulation when audio bypasses.
- Pattern-note events remain unmodulated unless explicitly supported later.

Preview/export parity tests:

- Realtime helper and export helper produce the same source frame for the same event/time.
- Frame indices match exactly for Scratch constant-rate cases.
- Vibrato frame indices match or stay within a documented tolerance.
- Proxy selection uses the warped source time in preview.
- Final export ignores DNxHR proxy substitution.

Visual FX tests:

- Disabled companion FX produce identical output.
- Shader constant buffers receive expected modulation snapshot fields.
- Vibrato Swirl uses `lfo`, `phase01`, and configured center/radius.
- Scratch Wave/Smear uses `rateMultiplier`, `phase01`, `intensity01`, and `reverseWaveWithScratch`.
- Export-only visual FX do not mutate track visual effect chains.

## 15. Risks and non-goals

Risks:

- Preview/export divergence if timing math is duplicated.
- Expensive vibrato integration if computed naively for many cells/frames.
- Source frame cache churn from high-rate scratches, reverse motion, and large jumps.
- Negative source time and after-end source time if clamping is inconsistent.
- Audio/video mismatch if video modulation runs on clips where audio bypasses.
- Incorrect architecture if companion FX are injected into track-level visual chains.
- UI controls implying preview support before OpenGL shaders exist.
- DNxHR proxy misses when modulation jumps outside the proxy window.
- `Silence` edge mode has no perfect video equivalent; black frames may feel worse than clamped frames.

Non-goals for E.0:

- No production timing warp implementation.
- No shaders.
- No `GridCompositor` changes.
- No `VideoCompositor` changes.
- No `ClipModulatedReader` changes.
- No `MixEngine` changes.
- No schema changes.
- No bridge/API additions.
- No UI controls.
- No preset changes.
- No FFmpeg filters.
- No branch/worktree creation.

## 16. Explicit files likely to change later

Likely E.1 timing files:

- `engine/src/SyncManager.h`
- `engine/src/SyncManager.cpp`
- `engine/src/render/FrameCollector.h`
- `engine/src/render/FrameCollector.cpp`
- `engine/src/render/OfflineRenderer.cpp`
- `bridge/src/XlethAddon.cpp`
- `engine/src/model/ClipModulationEvaluator.h`
- `engine/src/model/ClipModulationEvaluator.cpp`
- New helper, likely `engine/src/model/ClipVideoModulationTiming.h`
- New helper, likely `engine/src/model/ClipVideoModulationTiming.cpp`
- `engine/CMakeLists.txt`
- Relevant engine tests under `engine/test/`

Likely E.2 export visual FX files:

- `engine/src/render/FrameCollector.h`
- `engine/src/render/FrameCollector.cpp`
- `engine/src/render/GridCompositor.h`
- `engine/src/render/GridCompositor.cpp`
- `engine/src/render/shaders/FX_VibratoSwirl.hlsl`
- `engine/src/render/shaders/FX_VibratoSwirlPS.h`
- `engine/src/render/shaders/FX_ScratchWaveSmear.hlsl`
- `engine/src/render/shaders/FX_ScratchWaveSmearPS.h`
- Shader bytecode generation/build scripts if the project uses generated `*PS.h` headers.
- `engine/CMakeLists.txt` or shader build integration files if required.

Likely later preview visual FX files:

- `engine/src/VideoCompositor.h`
- `engine/src/VideoCompositor.cpp`
- Potential new GLSL shader strings or shader asset files.

Likely UI files if/when controls are exposed:

- `ui/src/components/TimelineView.jsx`
- `ui/main.js`
- `ui/preload.js`
- `bridge/src/XlethAddon.cpp` only if new API surface is required; current partial `setClipModulation` can already carry `video` fields.

## 17. Explicit confirmation

This Phase E.0 pass changed no production code. It did not implement video timing warp, shaders, compositor changes, bridge/API calls, schema changes, UI controls, preset changes, or FFmpeg filters. The only intended deliverable is this diagnostic markdown report.

# Phase F.1 — Clip Modulation FX on Stretched / Reversed / Formant-Preserve Clips (Architecture)

## Status

**Architecture sketch only.** No code changes from this document. F.1 is the follow-up to F.0; it lifts the bypass that F.0 explicitly preserves.

## Why this is bypassed today

`xleth::clipmod::isClipModulationCompatible` (defined in `engine/src/model/ClipModulationCompatibility.h`) returns `false` when any of:

- `clipReversed == true`
- `clipStretchRatio != 1.0`
- `clipFormantPreserve == true`

`MixEngine::processBlock` falls back to the `ClipRenderCache` path; `SyncManager` and `FrameCollector` return identity `sourceTime` and an empty companion-FX snapshot. The bypass is intentional and acknowledged in `engine/src/audio/ClipModulatedReader.h:50-52`:

> Composing vibrato/scratch with reverse / time-stretch / formant-preserve is deferred to a future phase.

The reason is structural: `ClipModulatedReader` reads **raw** decoder PCM directly via `BlockParams::srcBuf`. `ClipRenderCache` is the component that (a) reverses the buffer, (b) dispatches to one of {TD-PSOLA, Rubber Band, WSOLA, PhaseVocoder, WORLD}, (c) applies pitch + formant, and emits a processed buffer. The two are mutually exclusive in the current architecture, so on a stretched clip the only options are "modulated raw" (which would lose the user's chosen stretch quality) or "stretched flat" (which loses the modulation). F.0 chose the latter alignment and added tests proving audio / preview / export bypass identically.

## Goal of F.1

Allow Vibrato / Scratch / video timing follow / video companion FX to compose with stretched / reversed / formant-preserve clips while preserving:

1. The user's chosen stretch method quality (TD-PSOLA / Rubber Band / WSOLA / Phase Vocoder / WORLD).
2. Determinism between realtime preview and export.
3. The current scratch source-time semantics on plain clips (no regression).
4. The current static-pitch + modulation behavior on plain clips (locked in by F.0 tests).

## Proposed approach: post-cache modulation

Route `ClipModulatedReader` to read from `ClipRenderCache`'s **post-processed** buffer instead of raw PCM when one or more bypass-causing flags are set on the clip.

```
                              raw PCM
                                 │
                                 ▼
                       ┌──────────────────┐
                       │  ClipRenderCache │   reverse / stretch / formant / static pitch
                       └────────┬─────────┘
                                │   processed buffer (per-clip cached)
                  ┌─────────────┴─────────────┐
                  ▼                           ▼
     plain clip path (today)         F.1: ClipModulatedReader
                                    reads cache buffer instead of raw PCM
```

### Key design questions to settle in the F.1 plan

1. **Source-time semantics for scratch on stretched clips.** Today scratch source-time integrates rate over `clipLocalSeconds`. After F.1, "source time" must mean *position in the post-stretch timeline* — i.e. the cache buffer's frame of reference. A scratch rate of 2.0 on a 1.5x stretched clip should *not* mean "play 3x the underlying file"; it should mean "advance through the stretched output 2x." Validate with a unit test asserting that scratch rate 1.0 on any stretchRatio is bit-equal to the unmodulated cache output.

2. **Determinism.** Audio and video both consume the same cache buffer. The integrator (`computeVibratoIntegratedSourceOffsetSamples`) and `evaluateScratch` already work in unit-rate terms; if both audio and video helpers receive the same `clipLocalSamples` and the cache buffer is identical between preview and export, determinism is preserved. Lock with a frame-collector + reader cross-check test.

3. **Reversed clips.** The cache already reverses. After F.1, modulation reads forward through the reversed buffer — no double-reversal. The scratch UI semantics must be defined: does "rate 1.0" play the *user-perceived forward direction* (i.e. forward through the reversed buffer) or the *underlying file's forward direction*? Recommendation: rate 1.0 = forward through the user-perceived clip (the buffer the cache hands us). This matches what the user sees on the timeline.

4. **Formant-preserve.** The cache already applies formant preservation per chosen method. Modulation reading from the post-formant buffer composes correctly without further work, because vibrato pitch modulation on top of a formant-preserved buffer simply re-pitches the formant-preserved signal — which is what users want when they enable both.

5. **Cache invalidation.** `MixEngine::invalidateClipCache` is already called from `setClipModulation` (`bridge/src/XlethAddon.cpp:4612` → `MixEngine.cpp:812`). Confirm: does *every* mutation that a modulation reader is sensitive to (e.g. changing `stretchMethod`, `reversed`, `formantPreserve`) already invalidate the cache? If yes, no additional plumbing. If no, add the missing invalidation hooks.

6. **Cache-miss handling on the audio thread.** `ClipModulatedReader::renderBlock` runs on the audio thread; the cache fill happens on a worker. When a stretched + modulated clip's cache slot isn't ready yet, what does the reader do? Options: (a) emit silence + clip-fade for that block (simplest, identical to today's stretched-clip cache-miss behavior), (b) fall back to raw PCM with no modulation (regresses F.0 behavior), (c) read raw PCM with modulation (loses stretch quality). Recommendation: (a). Document explicitly.

7. **Stretch method matrix.** Verify each method survives modulation on top:
   - **TD-PSOLA** — pitch-modulation on top of pitch-shifted PSOLA output: re-pitches via fractional readhead, fine.
   - **Rubber Band** — same.
   - **WSOLA** — same.
   - **Phase Vocoder** — same.
   - **WORLD** — same.
   None of them embed the modulation themselves; the modulation is purely a fractional readhead on the cache output. Confirm with a regression test per method.

8. **Static pitch + stretched clip.** Static pitch (semis/cents) is currently applied *inside* the stretch processor (e.g. `ClipRenderJob` passes `pitchOffsetSemis/Cents` into the chosen method). After F.1, the cache buffer already has the static pitch baked in. The modulation reader must NOT re-apply static pitch — only vibrato + scratch on top. Adjust `ClipModulatedReader::BlockParams::pitchOffsetSemis/Cents` to be zero when reading from the cache, or add a flag indicating "static pitch already applied upstream."

## Files likely to change (estimated)

- `engine/src/audio/ClipModulatedReader.h/.cpp` — add a "source mode" (raw | cacheBuffer) to `BlockParams`; static pitch ratio = 1.0 in cache mode.
- `engine/src/audio/ClipRenderCache.h/.cpp` — expose the post-processed buffer to the audio thread for read-only access (it already does this for the existing fallback path; confirm the API is reusable).
- `engine/src/audio/MixEngine.cpp` — the activation predicate becomes a *router*, not a gate: pick raw-source modulation for plain/static-pitch clips, cache-buffer modulation for stretched/reversed/formant clips.
- `engine/src/model/ClipModulationCompatibility.h` — the F.0 helper survives but its *meaning* shifts to "is plain-mode modulation compatible." Add a parallel `isCacheBufferModulationCompatible` (or just remove the bypass entirely once F.1 lands and update audio + video sites in lockstep).
- `engine/src/SyncManager.cpp` and `engine/src/render/FrameCollector.cpp` — when stretched/reversed/formant clips become compatible, ensure source-time math accounts for the cache buffer's frame of reference (see Q1 above).

## Files that will NOT change

- The shaders (`FX_VibratoSwirl.hlsl`, `FX_ScratchWaveSmear.hlsl`) — they consume the companion-FX snapshot, which doesn't change shape.
- The schema (`ClipModulation` in `TimelineTypes.h:262`) — no new fields needed; the change is internal routing.
- The bridge / Node-API surface (`bridge/src/XlethAddon.cpp`) — no new functions.
- The UI — no new controls. The compatibility warning surface (currently absent) should be added in a separate UI/bridge pass that exposes `ClipModulationBypassReason`.

## Where the precise bypass reason gets surfaced

`xleth::clipmod::ClipModulationBypassReason` lives in the F.0 helper but is currently consumed only by tests. A later UI/bridge-safe pass (post-F.1, since F.1 may eliminate most bypass cases) should:

1. Compute the reason in a non-audio thread (e.g. when building the timeline view-model in the bridge).
2. Expose it on the per-clip view-model alongside the modulation panel state.
3. Render a small warning surface (text + tooltip) in the modulation panel when the reason is non-`None`.

This is explicitly out of scope for F.0 and likely out of scope for F.1 too — only worth doing if cases remain after F.1 lands.

## Test plan (when F.1 is implemented — not now)

- Per-method regression: render a clip under each `StretchMethod` with vibrato + scratch + companion FX enabled; assert deterministic output and bounded readhead.
- Plain-clip regression: F.0 tests in `test_clip_modulated_reader.cpp` and `test_frame_collector.cpp` must still pass byte-for-byte after the F.1 routing change.
- Audio/video alignment: same scratch curve + stretchRatio 1.5 on both audio and video paths must produce a `sourceFrameIndex` consistent with the audio cache readhead.
- Cache-miss behavior: clip with stretched modulation, cache slot evicted mid-render → asserts the documented cache-miss behavior (silence + fade).
- Reversed clip: rate 1.0 plays forward through the reversed buffer; rate -1.0 plays backward through it (i.e. original-file forward).
- Formant-preserve: pitch modulation on top of formant-preserved buffer audibly re-pitches without formant artifacts.

## Out of scope for F.1

- Changing the set of supported stretch methods.
- Changing scratch / vibrato preset semantics.
- Lifting any constraint that's not the bypass list.
- UI work — defer to a separate UI/bridge pass.

# Phase E.3.1 — Clip Modulation Video Companion FX Inactive (Diagnostic)

## 1. Executive summary

Audio Vibrato and Scratch modulation work end-to-end, but the visual companion
FX (Vibrato Swirl in OpenGL preview, Scratch Wave/Smear in D3D11 export) never
visibly activate. The pipeline is structurally complete — bridge serialization,
the shared `buildClipCompanionFxSnapshot()` builder, the SyncManager preview
upload path, the FrameCollector export path, the GridCompositor
`processCompanionFx()` pass, and the VideoCompositor uniform pushes are all
wired correctly and gated only on documented conditions.

The single missing piece is in the UI: **no UI surface ever assigns
`modulation.video.vibratoSwirlEnabled` or `modulation.video.scratchWaveEnabled`
(or any of the `swirlAmount` / `waveAmount` / `waveFrequency` / `smearAmount`
parameters) on a clip.** Because `ClipModulation::VideoCompanion` defaults
both flags to `false` (engine/src/model/TimelineTypes.h:304-305), the
snapshot builder unconditionally produces an inert snapshot, the OpenGL
shader takes the no-FX fast path, and `GridCompositor::processCompanionFx()`
returns the input SRV unchanged. Both preview and export are therefore
correctly performing zero visual modulation — the backend is working as
designed; the front door is closed.

This is **not** a backend gating bug. It is a missing E.4 UI control.

## 2. Exact root cause

`ui/src/components/TimelineView.jsx` exposes Vibrato and Scratch sliders/menus
that drive `handleSetClipVibrato` and `handleSetClipScratch`. Those handlers
call `mergeClipModulationPatch(clip, { vibratoPatch | scratchPatch, … })` and
then `window.xleth.timeline.setClipModulation(clipId, merged)`.

`mergeClipModulationPatch()` (TimelineView.jsx:267-283) only writes to
`merged.vibrato`, `merged.scratch`, and `merged.enabled`. It spreads
`...existing` so any existing `modulation.video` is preserved through partial
merges — but it never sets a video field. A search across the entire `ui/`
tree confirms zero references to:

- `vibratoSwirlEnabled`
- `scratchWaveEnabled`
- `swirlAmount` / `swirlRadius` / `swirlCenterX` / `swirlCenterY`
- `waveAmount` / `waveFrequency` / `smearAmount`
- `reverseWaveWithScratch`

(grep confirmed: no hits in `ui/src` or `ui/main.js` / `ui/preload.js`.)

Therefore for every clip in the project, `modulation.video.vibratoSwirlEnabled
== false` and `modulation.video.scratchWaveEnabled == false`. In
`engine/src/model/ClipCompanionFxBuilder.cpp:15-35`:

```cpp
if (video.vibratoSwirlEnabled && timing.vibratoActive) { … }
if (video.scratchWaveEnabled  && timing.scratchActive) { … }
```

both branches are skipped, so the returned `ClipCompanionFxSnapshot` has
`vibratoSwirlEnabled == false && scratchWaveEnabled == false`. Downstream:

- Preview: `VideoCompositor.cpp:865-882` writes `uSwirlEnabled = 0` and
  `uWaveEnabled = 0` — the shader runs the identity path.
- Export: `GridCompositor.cpp:1495-1498` returns the input SRV unchanged
  when both flags are false — no FX pass executes.

## 3. Files / functions inspected

- `bridge/src/XlethAddon.cpp:1212-1223` — `clipModulationToJs()` video block
- `bridge/src/XlethAddon.cpp:1228-1354` — `jsToClipModulation()` partial merge
- `engine/src/model/ClipCompanionFxSnapshot.h` — POD definition
- `engine/src/model/ClipCompanionFxBuilder.cpp:5-38` — gating logic
- `engine/src/model/TimelineTypes.h:302-319` — `VideoCompanion` defaults
- `engine/src/SyncManager.cpp:22-30` — `isVideoModulationCompatible()`
- `engine/src/SyncManager.cpp:155-225` — preview cache-hit `companionFx`
- `engine/src/SyncManager.cpp:282-309` — preview full-build `companionFx`
- `engine/src/VideoCompositor.cpp:817-907` — `renderComposite()` uniform push
- `engine/src/VideoLayer.h:6-22` — `companionFx` field on `VideoLayer`
- `engine/src/render/FrameCollector.cpp:97-145` — `buildRequest()`
- `engine/src/render/FrameCollector.cpp:122-123` — `companionFxEnabled_` gate
- `engine/src/render/FrameCollector.h:121-122,231` — collector toggle
- `engine/src/render/OfflineRenderer.cpp:459-462` — `setCompanionFxEnabled(true)`
- `engine/src/render/GridCompositor.cpp:1485-1498` — `processCompanionFx()` early-out
- `engine/src/render/GridCompositor.cpp:566-820` — every `processCompanionFx` call site
- `engine/src/render/GridCompositor.h:262,328` — `effectsBypass_` (defaults `false`)
- `ui/src/components/TimelineView.jsx:267-283` — `mergeClipModulationPatch()`
- `ui/src/components/TimelineView.jsx:2779-2830` — `handleSetClipVibrato/Scratch`
- `ui/main.js:735-736`, `ui/preload.js:155` — `setClipModulation` IPC

## 4. UI / API state flow

```
SliderRow change
  → handleSetClipVibrato({ enabled, depthCents, rateHz, … })
      → mergeClipModulationPatch(clip, { vibratoPatch, forceEnabled })
            // spreads ...existing, writes merged.vibrato / merged.scratch / merged.enabled
            // ← never writes merged.video
      → window.xleth.timeline.setClipModulation(clipId, merged)
          → IPC 'xleth:timeline:setClipModulation'
              → worker 'timeline_setClipModulation'
                  → bridge jsToClipModulation(merged, base)
                        // base.video preserved (no o.Has("video"))
```

Result: `clip.modulation.video` keeps whatever it was (default = both flags
false; default amounts as in TimelineTypes.h:306-313). Because no UI ever
toggles the flags on, they stay `false` for every clip in every project.

`mergeClipModulationPatch` does **not** wipe `existing.video` — it spreads
`...existing` first, so the bridge's partial merge on the engine side is
not strictly needed for video preservation. Both layers preserve correctly.

## 5. Bridge serialization result

- `clipModulationToJs()` writes the full `video` sub-object including all 10
  fields (XlethAddon.cpp:1212-1223). ✅ correct.
- `jsToClipModulation()` parses every field with type guards
  (XlethAddon.cpp:1328-1351), starting from `m = base` so missing fields
  preserve existing values. ✅ correct.
- Round-trip is verified by `engine/test/test_undo.cpp:226-258,296-355`
  (round-trip sets video flags true, undo/redo, JSON serialization).
  Round-trip path is not the bug.

## 6. Snapshot builder gating result

`buildClipCompanionFxSnapshot(modulation, timing)`
(ClipCompanionFxBuilder.cpp) requires:

1. `timing.timingActive` (else returns default-constructed inert snapshot).
2. For Swirl: `modulation.video.vibratoSwirlEnabled && timing.vibratoActive`.
3. For Wave/Smear: `modulation.video.scratchWaveEnabled && timing.scratchActive`.

`timing.timingActive` and `timing.vibratoActive` / `timing.scratchActive`
themselves require `isVideoModulationCompatible(event)` to be true at the
caller — which checks `hasClipModulation && modulation.enabled && (vibrato
|| scratch).enabled && !reversed && stretch == 1.0 && !formantPreserve`
(SyncManager.cpp:22-30, FrameCollector.cpp similar). For an unstretched,
unreversed, non-formant clip with audio Vibrato or Scratch enabled,
`timing.*Active` becomes `true`.

The gate that fails in current behavior is purely the `video.*Enabled`
conjunct. There is no off-by-one or impossible-value check in the builder.

`engine/test/test_clip_companion_fx_builder.cpp` and
`engine/test/test_frame_collector.cpp:334-416` verify the builder
activates correctly when `video.vibratoSwirlEnabled` / `video.scratchWaveEnabled`
are set true in code — confirming the engine path works under test.

## 7. Preview path result

SyncManager always assigns `layer.companionFx`:

- Cache-hit / repeated-frame branch: SyncManager.cpp:213-225 (added in E.3
  precisely so FX don't freeze on repeated frames — comment on line 210).
- Full upload branch: SyncManager.cpp:294-305.

Both call `buildClipCompanionFxSnapshot(event.modulation, timing)` before
`compositor_->setLayer()`. `VideoLayer::companionFx`
(VideoLayer.h:22) carries the snapshot to `VideoCompositor::renderComposite()`
which pushes uniforms (VideoCompositor.cpp:864-882). The shader fast-path
when both `uSwirlEnabled == 0 && uWaveEnabled == 0` is intentional and
visually identical to pre-E.3 behavior.

Conclusion: preview infrastructure is functional. It receives an inert
snapshot every tick because the source flags are false.

## 8. Export path result

- `OfflineRenderer.cpp:462` calls `collector.setCompanionFxEnabled(true)`
  unconditionally for all exports. ✅
- `FrameCollector::buildRequest()` populates `req.companionFx` when the gate
  is on (FrameCollector.cpp:121-123). ✅
- `GridCompositor::processCompanionFx()` is invoked on every render path that
  touches `req.companionFx`: line 568 (full-frame), 788 (cell composite),
  820 (alt path). All three are guarded only by `!effectsBypass_`. ✅
- `effectsBypass_` defaults to `false` (GridCompositor.h:328) and there are
  zero callers of `setEffectsBypass(true)` in production code (`git grep
  setEffectsBypass` returns only the declaration). ✅
- `processCompanionFx()` early-returns the input SRV when both
  `fx.vibratoSwirlEnabled` and `fx.scratchWaveEnabled` are false
  (GridCompositor.cpp:1497-1498). This is the symptomatic exit for export.

Conclusion: export infrastructure is functional. The early-out on line 1497
fires every frame because the incoming snapshot is inert.

## 9. Answers to required questions

1. **Are video companion flags ever set by current UI?** No — zero
   references to any video-companion field in `ui/`.
2. **Are video companion fields preserved by `setClipModulation` partial
   merges?** Yes — UI side via `...existing`, bridge side via `m = base`
   plus per-field `o.Has(...)` guards. Confirmed by `test_undo.cpp`
   round-trip tests.
3. **Are video companion fields serialized to JS and back through the
   bridge?** Yes — `clipModulationToJs` writes all 10 fields,
   `jsToClipModulation` reads all 10 fields, with type guards.
4. **Is `buildClipCompanionFxSnapshot` producing active snapshots when
   flags are set?** Yes — confirmed by `test_clip_companion_fx_builder.cpp`
   and the active-snapshot assertions in `test_frame_collector.cpp:334-416`.
5. **Does preview receive active `layer.companionFx`?** Yes when the input
   modulation has `video.*Enabled = true`; today it never does, so the
   snapshot is always inert.
6. **Does export receive active `CellFrameRequest.companionFx`?** Same as
   (5) — wiring is correct, source data is inert.
7. **Are shaders being bypassed by `effectsBypass_` or disabled flags?**
   `effectsBypass_` is `false` in all production paths (no callers of
   `setEffectsBypass`). The shaders are bypassed only by the `vibratoSwirlEnabled`
   / `scratchWaveEnabled` snapshot fields, which is the documented gate.
8. **Is the issue just missing E.4 UI controls, or is there a backend
   gating bug?** Missing E.4 UI controls only. No backend gating bug.

## 10. Recommended fix plan (Phase E.4)

Phase E.4 should add UI surfaces in `TimelineView.jsx` (Clip context menu /
Modulation panel) that drive the missing video fields. Specifically:

### E.4.1 — Extend `mergeClipModulationPatch`

Add a `videoPatch` parameter so the merger can write through to
`merged.video` while still preserving other fields:

```js
function mergeClipModulationPatch(clip, {
  vibratoPatch = null, scratchPatch = null,
  videoPatch   = null,
  forceEnabled = false,
} = {}) {
  const existing       = clip?.modulation ?? {}
  const existingVibrato = existing.vibrato ?? {}
  const existingScratch = existing.scratch ?? {}
  const existingVideo   = existing.video   ?? {}
  const nextVibrato = vibratoPatch ? { ...existingVibrato, ...vibratoPatch } : existingVibrato
  const nextScratch = scratchPatch ? { ...existingScratch, ...scratchPatch } : existingScratch
  const nextVideo   = videoPatch   ? { ...existingVideo,   ...videoPatch   } : existingVideo
  …
  if (videoPatch) merged.video = nextVideo
  …
}
```

### E.4.2 — Add Vibrato Swirl controls

In the Vibrato modulation popover (sibling of `handleSetClipVibrato`), add:

- Toggle: `Vibrato Swirl (visual)` → writes `videoPatch.vibratoSwirlEnabled`.
- Slider: `Swirl amount` (-1.0..1.0, default 0.25) → `videoPatch.swirlAmount`.
- Optional advanced: `swirlRadius` (0.05..1.0, default 0.45),
  `swirlCenterX`/`swirlCenterY` (0..1, default 0.5).

Wire through a new `handleSetClipVibratoVisual(clipId, videoPatch)` that
calls `mergeClipModulationPatch(clip, { videoPatch })` and
`setClipModulation(...)`. Reuse the existing audio handler when the user
toggles vibrato itself.

### E.4.3 — Add Scratch Wave/Smear controls

In the Scratch modulation popover, add:

- Toggle: `Scratch Wave (visual)` → `videoPatch.scratchWaveEnabled`.
- Slider: `Wave amount` (-1.0..1.0, default 0.08) → `videoPatch.waveAmount`.
- Slider: `Wave frequency` (0..32, default 8) → `videoPatch.waveFrequency`.
- Slider: `Smear amount` (0..1, default 0.0) → `videoPatch.smearAmount`.
- Toggle: `Reverse wave with scratch` (default true) →
  `videoPatch.reverseWaveWithScratch`.

### E.4.4 — Surface state from clip object

Read defaults from `clip.modulation.video` in the popover so re-opens show
the saved values. Bridge already serializes/deserializes the full sub-object
so no engine work is needed.

### E.4.5 — Optional: visual-only cap when modulation is bypassed

The audio compatibility check (`isVideoModulationCompatible`) blocks the
visual path when the clip is reversed / stretched / formant-preserved. The
existing UI already shows a `showModulationBypassWarning` banner
(TimelineView.jsx:2891). E.4 should reuse it when the visual toggles are on
but compatibility is false — no engine change required.

### Verification (post-fix)

Manual dev-console smoke test:

```js
// Vibrato Swirl
window.xleth.timeline.setClipModulation(clipId, {
  enabled: true,
  vibrato: { enabled: true, depthCents: 100, rateHz: 5 },
  video:   { vibratoSwirlEnabled: true, swirlAmount: 0.75 },
})

// Scratch Wave
window.xleth.timeline.setClipModulation(clipId, {
  enabled: true,
  scratch: { enabled: true, /* baby scratch curve */ },
  video:   { scratchWaveEnabled: true, waveAmount: 0.35,
             waveFrequency: 12, smearAmount: 0.35 },
})
```

Then re-read the clip and confirm the video fields persist; preview should
render swirl/wave on the unstretched, unreversed, non-formant clip; export
should produce the same effect via the D3D11 shaders.

## 11. No production code changed

Confirmed. This investigation only created
`docs/plans/phase-e3-1-video-companion-fx-inactive-diagnostic.md`. No
source files under `bridge/`, `engine/`, or `ui/` were edited.
`git status --short` shows the same modified set as before the
investigation; no new files in source directories.

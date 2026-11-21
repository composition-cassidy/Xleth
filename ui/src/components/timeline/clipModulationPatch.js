// Shared per-clip modulation patch merge.
//
// Extracted verbatim from TimelineView.jsx so the clip dropdown and the floating
// clip-FX editors write through ONE function. Every per-clip modulation mutation
// in the app is `mergeClipModulationPatch(clip, patch)` ->
// `window.xleth.timeline.setClipModulation(clipId, merged)`; there is no second
// write path, so undo/redo behaviour is identical no matter which surface the
// edit came from.

export function mergeClipModulationPatch(
  clip,
  { vibratoPatch = null, scratchPatch = null, videoPatch = null, forceEnabled = false } = {}
) {
  const existing = clip?.modulation ?? {}
  const existingVibrato = existing.vibrato ?? {}
  const existingScratch = existing.scratch ?? {}
  const existingVideo = existing.video ?? {}
  const nextVibrato = vibratoPatch ? { ...existingVibrato, ...vibratoPatch } : existingVibrato
  const nextScratch = scratchPatch ? { ...existingScratch, ...scratchPatch } : existingScratch
  const nextVideo   = videoPatch   ? { ...existingVideo,   ...videoPatch   } : existingVideo
  const merged = {
    ...existing,
    enabled: Boolean(nextVibrato.enabled || nextScratch.enabled),
  }

  if (vibratoPatch) merged.vibrato = nextVibrato
  if (scratchPatch) merged.scratch = nextScratch
  if (videoPatch)   merged.video   = nextVideo
  if (forceEnabled) merged.enabled = true

  return merged
}

export default mergeClipModulationPatch

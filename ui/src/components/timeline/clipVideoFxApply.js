// ─── "Apply video FX defaults to project" planner ─────────────────────────────
// Pure: given the project's clips/regions/sources and the user's saved defaults
// (stores/clipVideoFxDefaultsStore.js), decide which clips need an edit and what
// that edit is. Kept out of SettingsPanel so the selection rule — which clips
// count as "a video that doesn't have it on" — is testable without a DOM.
//
// The result feeds timeline.setClipModulationBatch, so the whole sweep is ONE
// undo entry: Ctrl+Z after applying to 300 clips puts all 300 back.

import {
  isStockVideoCompanion,
  swirlDefaultsPatch,
  useClipVideoFxDefaultsStore,
  waveDefaultsPatch,
} from '../../stores/clipVideoFxDefaultsStore.js'

// Matches TimelineView's contextHasVideo: a source is video unless it says
// otherwise, because older projects predate the hasVideo flag and reported
// undefined for every source.
export function clipHasVideo(clip, regionsById, sourcesById) {
  const region = clip?.regionId != null ? regionsById?.[clip.regionId] : null
  if (!region) return false
  const source = region.sourceId != null ? sourcesById?.[region.sourceId] : null
  return !!source && source.hasVideo !== false
}

// Returns [{ clipId, modulation }] in timeline.setClipModulationBatch's shape.
// `modulation` is a partial patch — the engine merges it onto the clip's own
// descriptor, so vibrato/scratch and the swirl centre/radius fields this feature
// does not own are left exactly as they were.
//
// A clip is skipped when it has no video, or when every companion FX the
// defaults would turn on is already on. "Already on" is checked per group, so a
// clip that has Swirl but not Wave still gets Wave.
export function planClipVideoFxApply({ clips, regionsById, sourcesById, defaults }) {
  const edits = []
  if (!Array.isArray(clips)) return edits
  if (!defaults?.swirlEnabled && !defaults?.waveEnabled) return edits

  for (const clip of clips) {
    if (!clipHasVideo(clip, regionsById, sourcesById)) continue

    const video = clip?.modulation?.video ?? {}
    const patch = {}

    if (defaults.swirlEnabled && !video.vibratoSwirlEnabled) {
      Object.assign(patch, { vibratoSwirlEnabled: true }, swirlDefaultsPatch(defaults))
    }
    if (defaults.waveEnabled && !video.scratchWaveEnabled) {
      Object.assign(patch, { scratchWaveEnabled: true }, waveDefaultsPatch(defaults))
    }

    if (Object.keys(patch).length > 0) {
      edits.push({ clipId: clip.id, modulation: { video: patch } })
    }
  }
  return edits
}

// ─── Seeding one clip from the clip context menu ──────────────────────────────
// Widens a video-companion patch that turns Swirl or Wave ON so it also carries
// the user's saved default amounts, and returns every other patch untouched —
// dragging the Swirl slider must never pick up a default it did not ask for.
//
// Seeds only a clip still holding the engine's stock values (isStockVideoCompanion):
// a clip whose Swirl was dialled to 0.7 by hand keeps that 0.7 when it is switched
// off and back on. `defaults` is read from the store when not passed, so the
// caller (TimelineView's checkbox handler) needs no store subscription.
export function seedVideoFxDefaults(existingVideo, videoPatch, defaults) {
  if (!videoPatch) return videoPatch
  const turningOnSwirl = videoPatch.vibratoSwirlEnabled === true
  const turningOnWave  = videoPatch.scratchWaveEnabled  === true
  if (!turningOnSwirl && !turningOnWave) return videoPatch

  const d = defaults ?? useClipVideoFxDefaultsStore.getState().defaults
  const seeded = { ...videoPatch }
  if (turningOnSwirl && !existingVideo?.vibratoSwirlEnabled
      && isStockVideoCompanion(existingVideo, 'swirl')) {
    Object.assign(seeded, swirlDefaultsPatch(d))
  }
  if (turningOnWave && !existingVideo?.scratchWaveEnabled
      && isStockVideoCompanion(existingVideo, 'wave')) {
    Object.assign(seeded, waveDefaultsPatch(d))
  }
  // A field the caller set explicitly always wins over the default.
  return { ...seeded, ...videoPatch }
}

export default planClipVideoFxApply

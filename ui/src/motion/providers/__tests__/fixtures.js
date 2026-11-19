// Shared Motion view test data: a small project (two Pattern tracks, two Clip
// tracks) and its Lens / Roam getter answer. Numbers are chosen so the expected
// values are easy to check by hand.

import { buildMotionData, lensRoamStateFrom } from '../../useMotionData.js'
import { makeMask } from '../../maskModel.js'

export const ROAM_ID = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
export const LENS_ID = { fit: 'Stretch', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack' }
export const ZONES = { headTicks: 120, tailTicks: 240, shortNote: 'Squash' }

const key = (channel, pos, value, interp = 'Linear', anchor = 'Origin') => ({ channel, anchor, pos, value, interp })

export function fixtureTracks() {
  return [
    { id: 1, name: 'Lead', type: 'Pattern', muted: false, solo: false },
    { id: 2, name: 'Chorus', type: 'Clip', muted: false, solo: false, parentTrackId: 1 },
    { id: 3, name: 'Bass', type: 'Pattern', muted: false, solo: false },
    { id: 4, name: 'Empty', type: 'Clip', muted: false, solo: false },
  ]
}

export function fixturePatterns() {
  return {
    10: {
      id: 10, regionId: 100, lengthTicks: 3840,
      notes: [
        { id: 1, positionTicks: 0, durationTicks: 960, pitch: 60 },
        { id: 2, positionTicks: 1920, durationTicks: 960, pitch: 62, lensOverride: { mode: 'Nudge', keys: [key('zoom', 0, 1.2, 'Linear', 'Head')] } },
      ],
    },
    11: {
      id: 11, regionId: 101, lengthTicks: 1920,
      notes: [{ id: 1, positionTicks: 0, durationTicks: 480, pitch: 50 }],
    },
  }
}

export function fixtureBlocks() {
  return [
    { id: 20, trackId: 1, patternId: 10, positionTicks: 0, durationTicks: 3840, offsetTicks: 0, loopEnabled: true },
    { id: 21, trackId: 3, patternId: 10, positionTicks: 0, durationTicks: 3840, offsetTicks: 0, loopEnabled: true },
    { id: 22, trackId: 3, patternId: 11, positionTicks: 3840, durationTicks: 1920, offsetTicks: 0, loopEnabled: true },
  ]
}

export function fixtureClips() {
  return [
    { id: 30, trackId: 2, regionId: 200, positionTicks: 0, durationTicks: 3840, lens: { base: LENS_ID, keys: [] } },
    { id: 31, trackId: 2, regionId: 200, positionTicks: 3840, durationTicks: 3840, lens: { base: LENS_ID, keys: [] } },
  ]
}

export function fixtureRegions() {
  return { 100: { id: 100, name: 'Hit' }, 101: { id: 101, name: 'Snare' }, 200: { id: 200, name: 'Chorus take' } }
}

export function fixtureMask(id = 1) {
  const m = makeMask('Rectangle', id, `Mask ${id}`)
  return { ...m, keys: [{ channel: 'feather', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear' }, { channel: 'feather', anchor: 'Origin', pos: 3840, value: 0.2, interp: 'Linear' }] }
}

export function fixtureLensRoam() {
  return {
    tracks: [
      {
        trackId: 1,
        roam: { ...ROAM_ID, offsetX: 0.5 },
        keys: [key('offsetX', 0, 0), key('offsetX', 3840, 1)],
        sweep: [key('zoom', 960, 1.5)],
        parentTrackId: -1,
        masks: [fixtureMask(1)],
      },
      { trackId: 2, roam: ROAM_ID, keys: [], sweep: [], parentTrackId: 1, masks: [] },
      { trackId: 3, roam: ROAM_ID, keys: [], sweep: [], parentTrackId: -1, masks: [] },
      { trackId: 4, roam: ROAM_ID, keys: [], sweep: [], parentTrackId: -1, masks: [] },
    ],
    sources: [
      {
        trackId: 1, regionId: 100, explicit: true, lens: { ...LENS_ID, fit: 'Cover' },
        hitCurve: [key('zoom', 0, 1.35, 'EaseOut', 'Head'), key('zoom', 120, 1, 'Linear', 'Head')],
        zones: ZONES,
      },
      { trackId: 3, regionId: 100, explicit: false, lens: { ...LENS_ID, fit: 'Cover' }, hitCurve: [], zones: ZONES },
      { trackId: 3, regionId: 101, explicit: false, lens: { ...LENS_ID, fit: 'Cover' }, hitCurve: [], zones: ZONES },
    ],
    clips: [
      { clipId: 30, lens: LENS_ID, keys: [key('zoom', 0, 1), key('zoom', 1920, 2)] },
      { clipId: 31, lens: { ...LENS_ID, zoom: 1.25 }, keys: [] },
    ],
  }
}

export const fixtureLayout = () => ({ slots: [{ trackId: 1 }, { trackId: 2 }], fullscreenLayers: [{ trackId: 3, placement: 'BehindGrid' }] })

/** A built MotionData of the fixture (every part overridable). */
export function fixtureData(over = {}) {
  const lensRoam = lensRoamStateFrom({
    lensRoam: over.lensRoam ?? fixtureLensRoam(),
    layout: over.layout ?? fixtureLayout(),
    motionBlur: over.motionBlur ?? { enabled: true, shutterAngle: 180 },
    includeClips: true,
  })
  return buildMotionData({
    tracks: over.tracks ?? fixtureTracks(),
    clips: over.clips ?? fixtureClips(),
    patternBlocks: over.patternBlocks ?? fixtureBlocks(),
    patterns: over.patterns ?? fixturePatterns(),
    regions: over.regions ?? fixtureRegions(),
    lensRoam,
  })
}

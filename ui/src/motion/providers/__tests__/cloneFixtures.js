// Shared Clone test data (docs/XLETH_CLONE_SPEC.md): Lead (a Pattern source) with
// one Voice clone (5) and one Trail clone (6), plus Bass (2).
// Lead plays G (67) and E (64) together at 0, a late D (55) inside them, C (60) alone
// at 1920. With one Voice clone: G -> voice 0, E -> voice 1, D -> overflow (voice 0),
// C -> voice 0.

import { buildMotionData, lensRoamStateFrom } from '../../useMotionData.js'

export const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
export const LENS = { fit: 'Cover', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack' }
export const ZONES = { headTicks: 120, tailTicks: 240, shortNote: 'Squash' }

export const voiceClone = (id, lensMode = 'Linked', order = 1) => ({
  id, name: `Lead · Clone ${id - 4}`, type: 'Pattern', order, cloneOf: 1, muted: false, solo: false,
  clone: { cloneOf: 1, kind: 'Voice', voice: 1, lensMode, delayTicks: 0, tint: '#FFFFFF', opacity: 1, opacityKeys: [] },
})

export const trailClone = (id, extra = {}, order = 2) => ({
  id, name: `Lead · Trail ${id - 5}`, type: 'Pattern', order, cloneOf: 1, muted: false, solo: false,
  clone: { cloneOf: 1, kind: 'Trail', voice: 0, lensMode: 'Linked', delayTicks: 480, tint: '#F07A2A', opacity: 0.9, opacityKeys: [], ...extra },
})

export function cloneTracks({ lensMode = 'Linked', trailExtra = {} } = {}) {
  return [
    { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1, muted: false, solo: false },
    voiceClone(5, lensMode),
    trailClone(6, trailExtra),
    { id: 2, name: 'Bass', type: 'Pattern', order: 3, cloneOf: -1, muted: false, solo: false },
  ]
}

export const CLONE_PATTERNS = {
  12: {
    id: 12, regionId: 100, lengthTicks: 3840,
    notes: [
      { id: 1, positionTicks: 0, durationTicks: 960, pitch: 67 },
      { id: 2, positionTicks: 0, durationTicks: 960, pitch: 64 },
      { id: 3, positionTicks: 480, durationTicks: 240, pitch: 55 },
      { id: 4, positionTicks: 1920, durationTicks: 960, pitch: 60 },
    ],
  },
}

export const CLONE_BLOCKS = [{ id: 20, trackId: 1, patternId: 12, positionTicks: 0, durationTicks: 3840, offsetTicks: 0, loopEnabled: false }]

export function cloneLensRoam(tracks) {
  return {
    tracks: tracks.map((t) => ({
      trackId: t.id, roam: ROAM, keys: [], sweep: [], parentTrackId: -1, masks: [], cloneOf: t.cloneOf, ...(t.clone ? { clone: t.clone } : {}),
    })),
    sources: [
      { trackId: 1, regionId: 100, explicit: true, lens: LENS, hitCurve: [{ channel: 'zoom', anchor: 'Head', pos: 0, value: 1.3, interp: 'Linear' }], zones: ZONES },
      { trackId: 5, regionId: 100, explicit: true, lens: { ...LENS, zoom: 1.5 }, hitCurve: [], zones: ZONES },
    ],
    clips: [],
  }
}

/** A built MotionData of the Clone fixture. opts: { tracks?, lensMode?, trailExtra? } */
export function cloneData(opts = {}) {
  const tracks = opts.tracks ?? cloneTracks(opts)
  return buildMotionData({
    tracks,
    clips: [],
    patternBlocks: CLONE_BLOCKS,
    patterns: CLONE_PATTERNS,
    regions: { 100: { id: 100, name: 'Hit' } },
    lensRoam: lensRoamStateFrom({ lensRoam: cloneLensRoam(tracks), layout: { slots: [{ trackId: 1 }, { trackId: 5 }] }, motionBlur: null }),
  })
}

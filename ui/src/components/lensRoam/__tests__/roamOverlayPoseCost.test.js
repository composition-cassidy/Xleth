// The parented motion path's cost (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5): it is
// recomputed on every frame of a key-dot drag, so an ancestor's keys are compiled
// once per resolver (never once per sample) and the line never takes more than
// MAX_PATH_SAMPLES samples, however many ticks the chain moves at.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cellGeometry } from '../../../lensRoam/lensRoamModel.js'
import * as roamKeyModel from '../../../lensRoam/roamKeyModel.js'
import {
  MAX_PATH_SAMPLES, chainMotionPath, makePoseResolver, trackIndexFor,
} from '../roamOverlayPose.js'

// Count every resolveRoamAt call made through the module (parentModel's roamOf included).
vi.mock('../../../lensRoam/roamKeyModel.js', async (importOriginal) => {
  const m = await importOriginal()
  return { ...m, resolveRoamAt: vi.fn(m.resolveRoamAt) }
})

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [
    { trackId: 3, gridX: 0, gridY: 0, spanX: 8, spanY: 8 },
    { trackId: 7, gridX: 16, gridY: 8, spanX: 8, spanY: 8 },
    { trackId: 5, gridX: 8, gridY: 0, spanX: 8, spanY: 8 },
  ],
  fullscreenLayers: [],
}
const TRACKS = [
  { id: 5, name: 'Lead', parentTrackId: -1 },
  { id: 3, name: 'Bass', parentTrackId: 5 },
  { id: 7, name: 'Chorus', parentTrackId: 3 },
]

// A key on every beat of a 3-minute song, on X, Y and scale.
const busyKeys = (beats) => {
  const out = []
  for (let b = 0; b < beats; b++) {
    out.push(K('offsetX', b * 960, (b % 2) * 0.2), K('offsetY', b * 960, (b % 3) * 0.1), K('scale', b * 960, 1 + (b % 4) * 0.1))
  }
  return out
}

const setup = (ancestors) => {
  const byId = trackIndexFor(TRACKS, 7)
  return {
    poseAt: makePoseResolver({ trackId: 7, layout: LAYOUT, tracksById: byId, ancestors }),
    geo: cellGeometry(LAYOUT, byId.get(7)),
  }
}

beforeEach(() => { roamKeyModel.resolveRoamAt.mockClear() })

describe('parented motion path cost', () => {
  it('never resolves an ancestor\'s keys uncompiled at a sample (compiled once per resolver)', () => {
    const anc = new Map([
      [3, { base: ROAM, keys: busyKeys(360), parentTrackId: 5 }],
      [5, { base: ROAM, keys: [K('rotationDeg', 0, 0), K('rotationDeg', 960 * 360, 90)], parentTrackId: -1 }],
    ])
    const { poseAt, geo } = setup(anc)
    const path = chainMotionPath({ base: ROAM, keys: [K('offsetX', 0, 0), K('offsetX', 3840, 1)], geo, ancestors: anc, poseAt, parented: true })
    expect(path.line.length).toBeGreaterThan(10)
    const uncompiled = roamKeyModel.resolveRoamAt.mock.calls.filter(([, keys, , compiled]) => (keys?.length ?? 0) > 0 && !compiled)
    expect(uncompiled).toHaveLength(0)
  })

  it('the same pose as resolving each ancestor at the tick (compiling once changes nothing)', () => {
    const keys = busyKeys(8)
    const anc = new Map([[3, { base: { ...ROAM, offsetY: 0.1 }, keys, parentTrackId: 5 }]])
    const { poseAt } = setup(anc)
    const byId = trackIndexFor(TRACKS, 7)
    const plain = makePoseResolver({ trackId: 7, layout: LAYOUT, tracksById: byId, ancestors: anc })
    for (const t of [0, 480, 1500, 3000, 7000, 9999]) {
      const a = poseAt(t, ROAM)
      const parentAt = roamKeyModel.resolveRoamAt({ ...ROAM, offsetY: 0.1 }, keys, t)
      const b = makePoseResolver({
        trackId: 7, layout: LAYOUT, tracksById: byId, ancestors: new Map([[3, { base: parentAt, keys: [] }]]),
      })(t, ROAM)
      expect(a.center).toEqual(b.center)
      expect(a.corners).toEqual(b.corners)
      expect(plain(t, ROAM).center).toEqual(a.center)
    }
  })

  it('the line takes at most MAX_PATH_SAMPLES samples, however many ticks the chain moves at', () => {
    const anc = new Map([[3, { base: ROAM, keys: busyKeys(360), parentTrackId: -1 }]])
    const { poseAt, geo } = setup(anc)
    const path = chainMotionPath({ base: ROAM, keys: [], geo, ancestors: anc, poseAt, parented: true })
    expect(path.line.length).toBeLessThanOrEqual(MAX_PATH_SAMPLES)
    expect(path.line.length).toBeGreaterThan(MAX_PATH_SAMPLES / 2)
    // It still spans the whole move: the first and last samples are the first and last key ticks.
    const first = poseAt(0, ROAM).center
    const last = poseAt(359 * 960, ROAM).center
    expect(path.line[0].x).toBeCloseTo(first.x, 12)
    expect(path.line[path.line.length - 1].x).toBeCloseTo(last.x, 12)
    expect(path.line[path.line.length - 1].y).toBeCloseTo(last.y, 12)
  })

  it('a moderate key count stays within the cap too (20 segments x 24 steps + 1 used to be 481)', () => {
    const anc = new Map([[3, { base: ROAM, keys: busyKeys(21), parentTrackId: -1 }]])
    const { poseAt, geo } = setup(anc)
    const path = chainMotionPath({ base: ROAM, keys: [], geo, ancestors: anc, poseAt, parented: true })
    expect(path.line.length).toBeLessThanOrEqual(MAX_PATH_SAMPLES)
    expect(path.line.length).toBeGreaterThan(20 * 2)
  })
})

// The viewer overlay's parent-aware pose (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5, R7, R9):
// composePose through the overlay helpers, the drag maps back through the inverse
// chain, the carried motion path, and the unparented path staying today's arithmetic.
import { describe, expect, it } from 'vitest'
import { roamQuad, cellGeometry } from '../../../lensRoam/lensRoamModel.js'
import { roamMotionPath } from '../../../lensRoam/roamKeyModel.js'
import { applyChain, inversePoint } from '../../../motion/parentModel.js'
import {
  ancestorsKeyed, chainIdsOf, chainMotionPath, chainMoves, dotOffsetOnScreen, homeBoxOf, makeGeoOf,
  makePoseResolver, moveOffsetOnScreen, trackIndexFor,
} from '../roamOverlayPose.js'

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })
// 3 x 3 on 1920 x 1080: Bass (3) top-left, Chorus (7) middle-right, Keys (9) middle.
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [
    { trackId: 3, gridX: 0, gridY: 0, spanX: 8, spanY: 8 },
    { trackId: 7, gridX: 16, gridY: 8, spanX: 8, spanY: 8 },
    { trackId: 9, gridX: 8, gridY: 8, spanX: 8, spanY: 8 },
  ],
  fullscreenLayers: [],
}
const TRACKS = [
  { id: 3, name: 'Bass', parentTrackId: -1 },
  { id: 7, name: 'Chorus', parentTrackId: 3 },
  { id: 9, name: 'Keys', parentTrackId: -1 },
]
const W = 1920
const H = 1080

const setup = (ancestors, tracks = TRACKS, trackId = 7) => {
  const byId = trackIndexFor(tracks, trackId)
  const poseAt = makePoseResolver({ trackId, layout: LAYOUT, tracksById: byId, ancestors })
  const geo = cellGeometry(LAYOUT, byId.get(trackId))
  return { byId, poseAt, geo }
}

describe('pose through the chain', () => {
  it('an unparented track is roamQuad bit for bit (today\'s arithmetic)', () => {
    const { poseAt, geo } = setup(new Map(), TRACKS, 9)
    const own = { ...ROAM, offsetX: 0.37, offsetY: -0.21, scale: 1.3, rotationDeg: 17 }
    const pose = poseAt(0, own)
    const q = roamQuad(own, geo)
    expect(pose.center).toEqual(q.center)
    expect(pose.corners).toEqual(q.corners)
    expect(pose.rect).toEqual(q.rect)
    expect(pose.rotRad).toBe(q.rotRad)
    expect(chainMoves(pose)).toBe(false)
  })

  it('a parent with offset, scale 2 and 90 degrees carries the child about its home centre (R7, numbers)', () => {
    const parent = { ...ROAM, offsetX: 0.5, scale: 2, rotationDeg: 90 }
    const { poseAt } = setup(new Map([[3, { base: parent, keys: [] }]]))
    const pose = poseAt(0, ROAM)
    // Parent home centre c = (320, 180) px; moved centre cp = (320 + 0.5 * 640, 180) = (640, 180) px.
    // Child home centre (1600, 540) px. p - c = (1280, 360); Rot 90 cw: (-360, 1280); x2: (-720, 2560).
    expect(pose.center.x * W).toBeCloseTo(640 - 720, 6)
    expect(pose.center.y * H).toBeCloseTo(180 + 2560, 6)
    expect(pose.rect.w * W).toBeCloseTo(1280, 6)        // 640 px home x parent scale 2
    expect(pose.rotRad).toBeCloseTo(Math.PI / 2, 12)
    expect(chainMoves(pose)).toBe(true)
  })

  it('a dangling or self parent id is no parent; the child\'s parent can be overridden from getLensRoam', () => {
    expect(chainIdsOf(7, trackIndexFor([{ id: 7, parentTrackId: 42 }], 7))).toEqual([])
    expect(chainIdsOf(7, trackIndexFor([{ id: 7, parentTrackId: 7 }], 7))).toEqual([])
    const byId = trackIndexFor(TRACKS, 7, -1)
    expect(chainIdsOf(7, byId)).toEqual([])
    expect(chainIdsOf(7, trackIndexFor(TRACKS, 7))).toEqual([3])
    expect(chainIdsOf(null, byId)).toEqual([])
  })

  it('geoOf is memoized per track and null for a track with no cell', () => {
    const geoOf = makeGeoOf(LAYOUT, trackIndexFor([...TRACKS, { id: 11, name: 'Off grid' }], 7))
    expect(geoOf(3)).toBe(geoOf(3))
    expect(geoOf(11)).toBeNull()
  })
})

describe('drags map back through the inverse chain', () => {
  const parent = { ...ROAM, offsetX: -0.25, offsetY: 0.4, scale: 1.5, rotationDeg: 30 }
  const anc = new Map([[3, { base: parent, keys: [] }]])

  it('a move: the child\'s new own offset puts its on-screen centre exactly where the pointer took it', () => {
    const { poseAt, geo } = setup(anc)
    const start = { ...ROAM, offsetX: 0.2, offsetY: -0.1, scale: 0.8, rotationDeg: -12 }
    const pose = poseAt(0, start)
    const du = 0.05
    const dv = -0.03
    const off = moveOffsetOnScreen(pose, geo, start, du, dv)
    const after = poseAt(0, { ...start, ...off })
    expect(after.center.x).toBeCloseTo(pose.center.x + du, 12)
    expect(after.center.y).toBeCloseTo(pose.center.y + dv, 12)
    // composePose -> inverse round trip on the point itself.
    const back = inversePoint(pose, pose.center)
    expect(back.x).toBeCloseTo(pose.own.center.x, 12)
    expect(back.y).toBeCloseTo(pose.own.center.y, 12)
    const fwd = applyChain(pose, back)
    expect(fwd.x).toBeCloseTo(pose.center.x, 12)
  })

  it('the parent scale divides the child\'s own offset change: a still 2x parent halves it', () => {
    const { poseAt, geo } = setup(new Map([[3, { base: { ...ROAM, scale: 2 }, keys: [] }]]))
    const pose = poseAt(0, ROAM)
    const off = moveOffsetOnScreen(pose, geo, ROAM, 1 / 15, 0)
    expect(off.offsetX).toBeCloseTo((1 / 15 / 2) / (1 / 3), 12)    // 0.1 cells, not 0.2
    expect(off.offsetY).toBeCloseTo(0, 12)
  })

  it('a still chain takes today\'s roamMoveOffset exactly', () => {
    const { poseAt, geo } = setup(new Map(), TRACKS, 9)
    const start = { ...ROAM, offsetX: 0.3 }
    const off = moveOffsetOnScreen(poseAt(0, start), geo, start, 0.1, 0.02)
    expect(off).toEqual({ offsetX: 0.3 + 0.1 / geo.unit.w, offsetY: 0 + 0.02 / geo.unit.h })
  })

  it('a key dot under a parent keyed in rotation: the dot follows the pointer at THAT tick', () => {
    const keyedAnc = new Map([[3, { base: ROAM, keys: [K('rotationDeg', 0, 0), K('rotationDeg', 3840, 90)] }]])
    const { poseAt, geo } = setup(keyedAnc)
    const startRoam = { ...ROAM, offsetX: 0.5 }
    const atTick = poseAt(3840, startRoam)
    const off = dotOffsetOnScreen(atTick, geo, startRoam, -0.02, 0.04)
    const moved = poseAt(3840, { ...startRoam, ...off })
    expect(moved.center.x).toBeCloseTo(atTick.center.x - 0.02, 12)
    expect(moved.center.y).toBeCloseTo(atTick.center.y + 0.04, 12)
  })
})

describe('motion path and home box', () => {
  it('unparented: exactly roamMotionPath', () => {
    const { poseAt, geo } = setup(new Map(), TRACKS, 9)
    const keys = [K('offsetX', 0, 0), K('offsetX', 3840, 1), K('offsetY', 1920, 0.5)]
    const a = chainMotionPath({ base: ROAM, keys, geo, ancestors: new Map(), poseAt, parented: false })
    expect(a).toEqual(roamMotionPath(ROAM, keys, geo))
  })

  it('a still parent carries the whole path (dots and line) through its similarity', () => {
    const anc = new Map([[3, { base: { ...ROAM, offsetY: 0.5, scale: 2 }, keys: [] }]])
    const { poseAt, geo } = setup(anc)
    const keys = [K('offsetX', 0, 0), K('offsetX', 3840, -1)]
    const flat = roamMotionPath(ROAM, keys, geo)
    const path = chainMotionPath({ base: ROAM, keys, geo, ancestors: anc, poseAt, parented: true })
    const pose = poseAt(0, ROAM)
    expect(path.dots).toHaveLength(2)
    expect(path.line).toHaveLength(flat.line.length)
    flat.dots.forEach((d, i) => {
      const want = applyChain(pose, d)
      expect(path.dots[i].tick).toBe(d.tick)
      expect(path.dots[i].x).toBeCloseTo(want.x, 12)
      expect(path.dots[i].y).toBeCloseTo(want.y, 12)
    })
    expect(ancestorsKeyed(anc)).toBe(false)
  })

  it('a keyed parent: the line spans every key that moves the cell, even with no position key of its own', () => {
    const anc = new Map([[3, { base: ROAM, keys: [K('offsetX', 960, 0), K('offsetX', 4800, 1)] }]])
    const { poseAt, geo } = setup(anc)
    const path = chainMotionPath({ base: ROAM, keys: [], geo, ancestors: anc, poseAt, parented: true })
    expect(path.dots).toEqual([])
    expect(path.line.length).toBeGreaterThan(10)
    // From the parent's first key to its last: one cell of the parent (640 px) to the right.
    const first = path.line[0]
    const last = path.line[path.line.length - 1]
    expect((last.x - first.x) * W).toBeCloseTo(640, 6)
    expect(last.y).toBeCloseTo(first.y, 12)
    expect(ancestorsKeyed(anc)).toBe(true)
  })

  it('a keyed parent and own position keys: one dot per own key, carried at its own tick', () => {
    const anc = new Map([[3, { base: ROAM, keys: [K('scale', 0, 1), K('scale', 3840, 2)] }]])
    const { poseAt, geo } = setup(anc)
    const keys = [K('offsetY', 1920, 0.5)]
    const path = chainMotionPath({ base: ROAM, keys, geo, ancestors: anc, poseAt, parented: true })
    expect(path.dots).toHaveLength(1)
    const want = poseAt(1920, { ...ROAM, offsetY: 0.5 }).center
    expect(path.dots[0]).toEqual({ tick: 1920, x: want.x, y: want.y })
    // Breakpoints 0, 1920, 3840: the line has samples on both segments.
    expect(path.line.length).toBe(1 + 24 * 2)
  })

  it('the home box: the grid box unparented, the carried box under a moving parent (R9)', () => {
    const { poseAt, geo } = setup(new Map([[3, { base: { ...ROAM, rotationDeg: 45 }, keys: [] }]]))
    const pose = poseAt(0, ROAM)
    const carried = homeBoxOf(pose, geo)
    expect(carried).toBe(pose.home)
    const still = setup(new Map(), TRACKS, 9)
    const p2 = still.poseAt(0, ROAM)
    expect(homeBoxOf(p2, still.geo)).toEqual([
      { x: 1 / 3, y: 1 / 3 }, { x: 2 / 3, y: 1 / 3 }, { x: 2 / 3, y: 2 / 3 }, { x: 1 / 3, y: 2 / 3 },
    ])
  })
})

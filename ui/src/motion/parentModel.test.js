// parentModel: chain resolution (loops, dangling ids, the depth cap), the picker's
// candidates (R8), and the R7 pose composition with its inverse. 2 x 2 grid on a
// 1920 x 1080 canvas: track 1 top-left (centre 0.25, 0.25), 2 top-right
// (0.75, 0.25), 3 bottom-left (0.25, 0.75), 4 bottom-right, 5 a fullscreen layer.
import { describe, expect, it } from 'vitest'
import { ROAM_IDENTITY, cellGeometry, roamQuad } from '../lensRoam/lensRoamModel.js'
import {
  MAX_PARENT_DEPTH, applyChain, chainDepth, chainRotation, chainScale, childrenOf, classifyParents, composePose,
  eligibleParents, indexTracks, inversePoint, lookupTrack, ownOffsetForScreenCenter, ownRotationForScreenRotation,
  ownScaleForScreenScale, parentChain, parentIdOf, poseContains, subtreeHeight, wouldCycle,
} from './parentModel.js'

const layout = {
  canvasWidth: 1920, canvasHeight: 1080, columns: 2, rows: 2, gapScale: 0,
  slots: [
    { trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8 },
    { trackId: 2, gridX: 8, gridY: 0, spanX: 8, spanY: 8 },
    { trackId: 3, gridX: 0, gridY: 8, spanX: 8, spanY: 8 },
    { trackId: 4, gridX: 8, gridY: 8, spanX: 8, spanY: 8 },
  ],
  fullscreenLayers: [{ trackId: 5 }],
}
const geoOf = (id) => cellGeometry(layout, { id })

/** byTrack Map from { id: [parentTrackId, roamPatch, keys?] }. */
function world(spec) {
  const m = new Map()
  for (const [id, [parent, roam = {}, keys = []]] of Object.entries(spec)) {
    m.set(Number(id), { id: Number(id), parentTrackId: parent, base: { ...ROAM_IDENTITY, ...roam }, keys })
  }
  return m
}
const pose = (byTrack, trackId, extra = {}) => composePose({ trackId, tick: 0, byTrack, geoOf, ...extra })
const close = (p, x, y, d = 12) => { expect(p.x).toBeCloseTo(x, d); expect(p.y).toBeCloseTo(y, d) }

describe('chain resolution', () => {
  it('parentIdOf / lookupTrack / indexTracks', () => {
    expect(parentIdOf({ parentTrackId: 3 })).toBe(3)
    expect(parentIdOf({ parentTrackId: -1 })).toBe(-1)
    expect(parentIdOf({ parentTrackId: '3' })).toBe(-1)
    expect(parentIdOf({})).toBe(-1)
    expect(lookupTrack([{ id: 2 }, { trackId: 3 }], 3)).toEqual({ trackId: 3 })
    expect(lookupTrack({ 4: { id: 4 } }, 4)).toEqual({ id: 4 })
    expect(indexTracks([{ id: 1 }, { trackId: 2 }]).size).toBe(2)
  })

  it('nearest first; stops at none, a dangling id, a loop, the cap', () => {
    const w = world({ 1: [2], 2: [3], 3: [-1] })
    expect(parentChain(1, w)).toEqual([2, 3])
    expect(chainDepth(1, w)).toBe(2)
    expect(parentChain(3, w)).toEqual([])
    expect(parentChain(1, world({ 1: [99] }))).toEqual([])                  // the parent track is gone
    expect(parentChain(1, world({ 1: [2], 2: [1] }))).toEqual([2])          // a loop stops before repeating
    expect(parentChain(1, world({ 1: [1] }))).toEqual([])
    const long = world({ 1: [2], 2: [3], 3: [4], 4: [5], 5: [6], 6: [7], 7: [-1] })
    expect(parentChain(1, long)).toEqual([2, 3, 4, 5])                       // MAX_PARENT_DEPTH = 4
    expect(MAX_PARENT_DEPTH).toBe(4)
    expect(chainDepth(1, long)).toBe(6)
    expect(parentChain(42, long)).toEqual([])
  })

  it('wouldCycle: itself or any track that already follows it', () => {
    const w = world({ 1: [-1], 2: [1], 3: [2], 4: [-1] })
    expect(wouldCycle(1, 1, w)).toBe(true)
    expect(wouldCycle(1, 2, w)).toBe(true)
    expect(wouldCycle(1, 3, w)).toBe(true)
    expect(wouldCycle(1, 4, w)).toBe(false)
    expect(wouldCycle(3, 1, w)).toBe(false)
    expect(wouldCycle(1, -1, w)).toBe(false)
  })

  it('children and subtree height', () => {
    const tracks = [...world({ 1: [-1], 2: [1], 3: [2], 4: [1], 5: [-1] }).values()]
    expect(childrenOf(1, tracks).map((t) => t.id)).toEqual([2, 4])
    expect(subtreeHeight(1, tracks)).toBe(2)
    expect(subtreeHeight(3, tracks)).toBe(0)
    // A loop in the data does not hang it.
    expect(subtreeHeight(1, [...world({ 1: [2], 2: [1] }).values()])).toBe(1)
  })

  it('classifyParents / eligibleParents (R8): no self, no loop, no chain past the cap', () => {
    // 1 <- 2 <- 3 (1 has two generations below); 4 -> 5 -> 6.
    const w = world({ 1: [-1], 2: [1], 3: [2], 4: [5], 5: [6], 6: [-1] })
    const tracks = [...w.values()]
    const c = classifyParents(1, tracks, w)
    expect(c.excluded.map((e) => [e.track.id, e.reason])).toEqual([[1, 'self'], [2, 'cycle'], [3, 'cycle']])
    expect(c.tooDeep.map((t) => t.id)).toEqual([4])                         // 2 below + 1 + 2 above = 5
    expect(c.eligible.map((t) => t.id)).toEqual([5, 6])
    expect(eligibleParents(1, tracks).map((t) => t.id)).toEqual([5, 6])
    expect(eligibleParents(1, tracks, null, { maxDepth: 5 }).map((t) => t.id)).toEqual([4, 5, 6])
    // 4 and 5 already follow 6; 6 has two generations below it, so 3 (two above) would be 5 deep.
    const six = classifyParents(6, tracks)
    expect(six.eligible.map((t) => t.id)).toEqual([1, 2])
    expect(six.tooDeep.map((t) => t.id)).toEqual([3])
    expect(six.excluded.map((e) => e.reason)).toEqual(['cycle', 'cycle', 'self'])
  })
})

describe('composePose (R7)', () => {
  it('no parent: exactly roamQuad', () => {
    const roam = { offsetX: 0.3, offsetY: -0.2, scale: 1.7, rotationDeg: 33 }
    const w = world({ 1: [-1, roam] })
    const p = pose(w, 1)
    const q = roamQuad({ ...ROAM_IDENTITY, ...roam }, geoOf(1))
    expect(p.rect).toStrictEqual(q.rect)
    expect(p.corners).toStrictEqual(q.corners)
    expect(p.center).toStrictEqual(q.center)
    expect(p.rotRad).toBe(q.rotRad)
    expect(p.scale).toBe(1.7)
    expect(p.chain).toEqual([])
  })

  it('an identity parent gives the unparented pose bit for bit', () => {
    const roam = { offsetX: 0.3, offsetY: -0.2, scale: 1.7, rotationDeg: 33 }
    const unparented = pose(world({ 1: [-1, roam] }), 1)
    for (const w of [
      world({ 1: [2, roam], 2: [-1] }),                                                 // a still parent
      world({ 1: [2, roam], 2: [3], 3: [-1] }),                                         // a still chain
      world({ 1: [2, roam], 2: [-1, {}, [{ channel: 'offsetX', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear' },
        { channel: 'offsetX', anchor: 'Origin', pos: 960, value: 1, interp: 'Linear' }]] }),  // keyed, still at tick 0
    ]) {
      const p = pose(w, 1)
      expect(p.chain.length).toBeGreaterThan(0)
      expect(p.chain.every((l) => l.identity)).toBe(true)
      expect(p.rect).toStrictEqual(unparented.rect)
      expect(p.corners).toStrictEqual(unparented.corners)
      expect(p.center).toStrictEqual(unparented.center)
      expect(p.rotRad).toBe(unparented.rotRad)
    }
  })

  it('a parent offset carries the child; the child keeps its own offset inside it', () => {
    const p = pose(world({ 1: [2], 2: [-1, { offsetX: 1 }] }), 1)
    close(p.center, 0.75, 0.25)
    expect(p.rect.w).toBeCloseTo(0.5, 12)
    expect(p.parentScale).toBe(1)
    close(p.home[0], 0.5, 0)                                                 // the home rect travels too
    const q = pose(world({ 1: [2, { offsetX: 0.5 }], 2: [-1, { offsetX: 1 }] }), 1)
    close(q.center, 1.0, 0.25)
    close(q.own.center, 0.5, 0.25)
  })

  it('a parent scale scales the child about the parent home centre', () => {
    const p = pose(world({ 1: [2, { scale: 0.5 }], 2: [-1, { scale: 2 }] }), 1)
    close(p.center, -0.25, 0.25)
    expect(p.rect.w).toBeCloseTo(0.5, 12)                                    // 0.5 cell x own 0.5 x parent 2
    expect(p.scale).toBeCloseTo(1, 12)
    expect(p.ownScale).toBe(0.5)
    expect(p.parentScale).toBe(2)
  })

  it('rotation pivots about the parent home centre in pixels (clockwise, y down)', () => {
    const p = pose(world({ 1: [2], 2: [-1, { rotationDeg: 90 }] }), 1)
    // 960 px left of the parent centre turns to 960 px above it.
    close(p.center, 0.75, 0.25 - 960 / 1080)
    expect(p.rotRad).toBeCloseTo(Math.PI / 2, 12)
    // The cell is turned, not sheared: its sides keep their pixel lengths.
    const side = (a, b) => Math.hypot((b.x - a.x) * 1920, (b.y - a.y) * 1080)
    expect(side(p.corners[0], p.corners[1])).toBeCloseTo(960, 6)
    expect(side(p.corners[1], p.corners[2])).toBeCloseTo(540, 6)
    expect(chainRotation(p)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('a chain of three: nearest parent first', () => {
    const w = world({ 1: [2], 2: [3, { offsetX: 1 }], 3: [-1, { scale: 2 }] })
    const p = pose(w, 1)
    expect(p.chain.map((l) => l.trackId)).toEqual([2, 3])
    close(p.center, 1.25, -0.25)
    expect(p.scale).toBeCloseTo(2, 12)
    // The middle track's own pose agrees: its centre went through track 3 the same way.
    close(pose(w, 2).center, 2.25, -0.25)
  })

  it('a parent that is not placed adds nothing, and the chain goes on above it', () => {
    const w = world({ 1: [6], 6: [3], 3: [-1, { offsetY: 1 }] })
    const p = pose(w, 1)
    expect(p.chain.map((l) => [l.trackId, l.placed])).toEqual([[6, false], [3, true]])
    close(p.center, 0.25, 0.75)
  })

  it('a fullscreen parent pivots about the canvas centre', () => {
    const p = pose(world({ 1: [5], 5: [-1, { rotationDeg: 180 }] }), 1)
    close(p.center, 0.75, 0.75)
  })

  it('the parent is evaluated at the tick (keys), the cap holds', () => {
    const keys = [{ channel: 'offsetX', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear' },
      { channel: 'offsetX', anchor: 'Origin', pos: 960, value: 1, interp: 'Linear' }]
    const p = composePose({ trackId: 1, tick: 480, byTrack: world({ 1: [2], 2: [-1, {}, keys] }), geoOf })
    close(p.center, 0.5, 0.25)
    const long = world({ 1: [2], 2: [3], 3: [4], 4: [5], 5: [7], 7: [-1] })
    expect(pose(long, 1).chain).toHaveLength(4)
    expect(composePose({ trackId: 99, byTrack: long, geoOf })).toBeNull()
  })

  it('a draft roam replaces the stored one; getLensRoam-style entries ({ trackId, roam }) work', () => {
    const p = pose(world({ 1: [2], 2: [-1, { offsetX: 1 }] }), 1, { roam: { offsetY: 1 } })
    close(p.center, 0.75, 0.75)
    const entries = [{ trackId: 1, parentTrackId: 2, roam: { ...ROAM_IDENTITY }, keys: [] },
      { trackId: 2, parentTrackId: -1, roam: { ...ROAM_IDENTITY, offsetX: 1 }, keys: [] }]
    close(composePose({ trackId: 1, byTrack: entries, geoOf }).center, 0.75, 0.25)
  })
})

describe('inverse mapping (drags on a parented cell)', () => {
  const w = world({ 1: [2, { offsetX: 0.2, scale: 1.2, rotationDeg: 10 }], 2: [3, { offsetX: -0.4, scale: 1.5, rotationDeg: 30 }], 3: [-1, { offsetY: 0.3, scale: 0.8, rotationDeg: -75 }] })

  it('inversePoint undoes applyChain', () => {
    const p = pose(w, 1)
    for (const pt of [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }, { x: -0.3, y: 1.4 }]) {
      const back = inversePoint(p, applyChain(p, pt))
      close(back, pt.x, pt.y, 10)
      close(applyChain(p.chain, inversePoint(p.chain, pt)), pt.x, pt.y, 10)
    }
  })

  it('a dragged centre maps back to the child own offset that puts it there', () => {
    const p = pose(w, 1)
    const target = { x: 0.6, y: 0.4 }
    const off = ownOffsetForScreenCenter(p, geoOf(1), target)
    const again = pose(w, 1, { roam: { ...w.get(1).base, ...off } })
    close(again.center, target.x, target.y, 10)
  })

  it('screen scale and rotation map back through the chain', () => {
    const p = pose(world({ 1: [2], 2: [-1, { scale: 2, rotationDeg: 90 }] }), 1)
    expect(chainScale(p)).toBe(2)
    expect(ownScaleForScreenScale(p, 3)).toBe(1.5)
    expect(ownRotationForScreenRotation(p, 100)).toBeCloseTo(10, 12)
    expect(chainScale([])).toBe(1)
    expect(inversePoint([], { x: 0.3, y: 0.4 })).toEqual({ x: 0.3, y: 0.4 })
  })

  it('poseContains hit-tests the composed (rotated) cell', () => {
    const p = pose(world({ 1: [2], 2: [-1, { rotationDeg: 90 }] }), 1)
    expect(poseContains(p, geoOf(1), p.center.x, p.center.y)).toBe(true)
    expect(poseContains(p, geoOf(1), 0.25, 0.25)).toBe(false)                // where it was
    expect(poseContains(null, geoOf(1), 0, 0)).toBe(false)
  })
})

// maskModel: shapes, strict validation (mirror of timeline_setTrackMasks), wire,
// evaluation at a tick (R14), vertex insert / delete across keys, and the R12
// coverage reference the FX_Mask pass must match. Numbers are pinned.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEGMENTS_PER_EDGE, KAPPA, MASK_BASE_IDENTITY, MASK_CHANNELS, MASK_KINDS, MASK_MODES, addMaskBlocker,
  clearMaskChannelKeys, clearShapeKeys, convertToPath, coverageAt, deleteVertexAll, deleteVertexBlocker, edgePoint,
  evaluateMask, evaluateMasks, flattenShape, fromWire, fromWireList, insertVertexAll, insertVertexBlocker, isShapeAnimated,
  makeEllipse, makeMask, makeRectangle, maskScalarAt, maskVertexTotal, nearestEdge, nextMaskId, removeShapeKey,
  shapeAt, shapeBounds, shapeCoverage, splitEdge, toWire, transformShape, upsertMaskKey, upsertShapeKey,
  validateMask, validateMasks, windingNumber,
} from './maskModel.js'

const K = KAPPA * 0.4 // 0.22091389992

const square = (h) => makeRectangle({ hw: h }).vertices
const err = (r) => (r.ok ? '' : r.error)

describe('constants come from the schema', () => {
  it('kinds, modes, channels, identity', () => {
    expect(MASK_KINDS).toEqual(['Rectangle', 'Ellipse', 'Path'])
    expect(MASK_MODES).toEqual(['Add', 'Subtract', 'Intersect'])
    expect(MASK_CHANNELS).toEqual(['feather', 'expansion', 'opacity'])
    expect(MASK_BASE_IDENTITY).toEqual({ feather: 0, expansion: 0, opacity: 1, mode: 'Add', invert: false })
  })
})

describe('shapes', () => {
  it('rectangle: TL TR BR BL inset ±0.4, corner tangents', () => {
    expect(makeRectangle()).toEqual({
      closed: true,
      vertices: [[-0.4, -0.4, 0, 0, 0, 0], [0.4, -0.4, 0, 0, 0, 0], [0.4, 0.4, 0, 0, 0, 0], [-0.4, 0.4, 0, 0, 0, 0]],
    })
  })

  it('ellipse: top right bottom left with kappa handles, radii 0.4', () => {
    const e = makeEllipse()
    expect(e.vertices).toEqual([
      [0, -0.4, -K, 0, K, 0],
      [0.4, 0, 0, -K, 0, K],
      [0, 0.4, K, 0, -K, 0],
      [-0.4, 0, 0, K, 0, -K],
    ])
    // The quarter arc's midpoint sits on the circle (that is what kappa is for).
    const [x, y] = edgePoint(e.vertices, 0, 0.5)
    expect(x).toBeCloseTo(0.4 / Math.SQRT2, 9)
    expect(y).toBeCloseTo(-0.4 / Math.SQRT2, 9)
    expect(Math.hypot(x, y)).toBeCloseTo(0.4, 9)
  })

  it('makeMask: identity parameters, default name, Path from a given shape', () => {
    const m = makeMask('Ellipse', 3)
    expect(m).toMatchObject({ id: 3, name: 'Mask 3', kind: 'Ellipse', keys: [], shapeKeys: [] })
    expect(m.base).toMatchObject(MASK_BASE_IDENTITY)
    expect(m.base.shape).toEqual(makeEllipse())
    const tri = { vertices: [[0, -0.3, 0, 0, 0, 0], [0.3, 0.3, 0, 0, 0, 0], [-0.3, 0.3, 0, 0, 0, 0]] }
    const p = makeMask('Path', 4, 'Cut', { shape: tri })
    expect(p.name).toBe('Cut')
    expect(p.base.shape.vertices).toEqual(tri.vertices)
    expect(p.base.shape.vertices).not.toBe(tri.vertices)
    expect(validateMask(p).ok).toBe(true)
  })

  it('nextMaskId, totals and the add / insert / delete blockers (R15)', () => {
    expect(nextMaskId([])).toBe(1)
    expect(nextMaskId([{ id: 2 }, { id: 7 }, { id: 3 }])).toBe(8)
    const eight = Array.from({ length: 8 }, (_, i) => makeMask('Rectangle', i + 1))
    expect(maskVertexTotal(eight)).toBe(32)
    expect(addMaskBlocker(eight)).toBe('A track holds at most 8 masks')
    expect(addMaskBlocker(eight.slice(0, 7))).toBeNull()
    const big = [makeMask('Path', 1, 'a', { shape: { vertices: Array.from({ length: 32 }, (_, i) => [Math.cos(i), Math.sin(i), 0, 0, 0, 0]) } }),
      makeMask('Path', 2, 'b', { shape: { vertices: Array.from({ length: 30 }, (_, i) => [Math.cos(i), Math.sin(i), 0, 0, 0, 0]) } })]
    expect(addMaskBlocker(big)).toBe('A track holds at most 64 mask points in total')
    expect(addMaskBlocker(big, { kind: 'Path', vertexCount: 2 })).toBeNull()
    expect(insertVertexBlocker(big, 0)).toBe('A mask holds at most 32 points')
    expect(insertVertexBlocker(big, 1)).toBeNull()
    const tri = makeMask('Path', 1, 't', { shape: { vertices: square(0.4).slice(0, 3) } })
    expect(deleteVertexBlocker(tri)).toBe('A mask needs at least 3 points')
    expect(deleteVertexBlocker(makeMask('Rectangle', 1))).toBeNull()
  })
})

describe('validateMask (mirror of the strict RPC parser)', () => {
  const good = () => toWire(makeMask('Rectangle', 1))

  it('accepts what makeMask / toWire produce, and a minimal mask', () => {
    expect(validateMask(good())).toEqual({ ok: true, error: null })
    expect(validateMask({ id: 1, kind: 'Path', base: { shape: { vertices: square(0.4).slice(0, 3) } } }).ok).toBe(true)
  })

  it('rejects every malformed field with a message naming it', () => {
    const cases = [
      [(m) => { m.extra = 1 }, /unknown field 'extra'/],
      [(m) => { m.id = 0 }, /id must be a positive integer/],
      [(m) => { m.id = 1.5 }, /id must be a positive integer/],
      [(m) => { m.name = 'x'.repeat(65) }, /at most 64 characters/],
      [(m) => { m.kind = 'Star' }, /kind must be Rectangle \| Ellipse \| Path/],
      [(m) => { m.base.shape.vertices.push([0, 0, 0, 0, 0, 0]) }, /a Rectangle has exactly 4 points/],
      [(m) => { m.kind = 'Path'; m.base.shape.vertices = square(0.4).slice(0, 2) }, /must hold 3\.\.32 points/],
      [(m) => { m.kind = 'Path'; m.base.shape.vertices = Array.from({ length: 33 }, () => [0, 0, 0, 0, 0, 0]) }, /3\.\.32 points/],
      [(m) => { m.base.shape.vertices[1] = [0, NaN, 0, 0, 0, 0] }, /\[1\] must be six finite numbers/],
      [(m) => { m.base.shape.vertices[1] = [0, 0, 0, 0] }, /six finite numbers/],
      [(m) => { m.base.shape.closed = false }, /open paths are not supported/],
      [(m) => { m.base.shape.foo = 1 }, /unknown field 'foo'/],
      [(m) => { m.base.feather = 1.5 }, /feather must be in 0\.\.1/],
      [(m) => { m.base.opacity = -0.1 }, /opacity must be in 0\.\.1/],
      [(m) => { m.base.expansion = Infinity }, /expansion must be a finite number/],
      [(m) => { m.base.mode = 'Multiply' }, /mode must be Add \| Subtract \| Intersect/],
      [(m) => { m.base.invert = 'yes' }, /invert must be a boolean/],
      [(m) => { m.base = null }, /base must be an object/],
      [(m) => { m.keys = [{ channel: 'zoom', anchor: 'Origin', pos: 0, value: 0 }] }, /channel must be feather \| expansion \| opacity/],
      [(m) => { m.keys = [{ channel: 'feather', anchor: 'Head', pos: 0, value: 0 }] }, /anchor must be 'Origin'/],
      [(m) => { m.keys = [{ channel: 'feather', pos: 0, value: 0 }] }, /anchor must be 'Origin'/],
      [(m) => { m.keys = [{ channel: 'feather', anchor: 'Origin', pos: -1, value: 0 }] }, /pos must be a finite number >= 0/],
      [(m) => { m.keys = [{ channel: 'opacity', anchor: 'Origin', pos: 0, value: 2 }] }, /value must be in 0\.\.1/],
      [(m) => { m.keys = [{ channel: 'opacity', anchor: 'Origin', pos: 0, value: 1, interp: 'Cubic' }] }, /interp must be/],
      [(m) => { m.keys = [{ channel: 'opacity', anchor: 'Origin', pos: 0, value: 1, interp: 'Bezier', bez: [1, 2, 3] }] }, /bez must be/],
      [(m) => { m.keys = [{ channel: 'opacity', anchor: 'Origin', pos: 0, value: 1, extra: 1 }] }, /unknown field 'extra'/],
      [(m) => { m.shapeKeys = [{ pos: 0, vertices: square(0.4).slice(0, 3) }] }, /must hold the base's 4 points/],
      [(m) => { m.shapeKeys = [{ pos: 5, vertices: square(0.4) }, { pos: 5, vertices: square(0.3) }] }, /a second shape key at pos 5/],
      [(m) => { m.shapeKeys = [{ pos: 0, vertices: square(0.4), channel: 'x' }] }, /unknown field 'channel'/],
      [(m) => { m.shapeKeys = {} }, /shapeKeys must be an array/],
      [(m) => { m.id = 2147483648 }, /id must be a positive integer \(at most 2147483647\)/],
      [(m) => { m.kind = 'Ellipse'; m.base.shape.vertices.pop() }, /an Ellipse has exactly 4 points/],
      [(m) => { m.base.shape.vertices[0] = [10000.5, 0, 0, 0, 0, 0] }, /\[0\] must be six finite numbers .* \|v\| <= 10000/],
      [(m) => { m.base.shape.vertices[2] = [0, 0, 0, 0, -20000, 0] }, /\|v\| <= 10000/],
      [(m) => { m.shapeKeys = [{ pos: 0, vertices: [[0, 0, 1e6, 0, 0, 0], ...square(0.4).slice(1)] }] }, /shapeKeys\[0\]\.vertices\[0\].*\|v\| <= 10000/],
    ]
    for (const [mutate, re] of cases) {
      const m = good()
      mutate(m)
      const r = validateMask(m)
      expect(r.ok, String(re)).toBe(false)
      expect(err(r)).toMatch(re)
    }
  })

  it('validateMasks: list caps, unique ids, 64 points per track', () => {
    expect(validateMasks([]).ok).toBe(true)
    expect(err(validateMasks({}))).toMatch(/must be an array/)
    const nine = Array.from({ length: 9 }, (_, i) => toWire(makeMask('Rectangle', i + 1)))
    expect(err(validateMasks(nine))).toMatch(/at most 8 masks/)
    expect(err(validateMasks([toWire(makeMask('Rectangle', 1)), toWire(makeMask('Ellipse', 1))]))).toMatch(/id 1 is used twice/)
    const ring = (n) => Array.from({ length: n }, (_, i) => [0.4 * Math.cos((2 * Math.PI * i) / n), 0.4 * Math.sin((2 * Math.PI * i) / n), 0, 0, 0, 0])
    const full = [toWire(makeMask('Path', 1, 'a', { shape: { vertices: ring(32) } })), toWire(makeMask('Path', 2, 'b', { shape: { vertices: ring(32) } }))]
    expect(validateMasks(full).ok).toBe(true)
    expect(err(validateMasks([...full, toWire(makeMask('Rectangle', 3))]))).toMatch(/at most 64 mask points in total \(got 68\)/)
    expect(err(validateMasks([{ id: 1 }]))).toMatch(/masks\[0\]\.kind/)
  })
})

describe('wire', () => {
  const good = () => toWire(makeMask('Rectangle', 1))

  it('toWire: known fields only, bez only on Bezier keys, shape keys sorted', () => {
    const m = {
      ...makeMask('Rectangle', 2),
      junk: true,
      keys: [
        { channel: 'feather', anchor: 'Origin', pos: 10, value: 0.1, interp: 'Linear', bez: [0, 0, 1, 1] },
        { channel: 'opacity', anchor: 'Origin', pos: 20, value: 0.5, interp: 'Bezier' },
      ],
      shapeKeys: [{ pos: 100, interp: 'Hold', vertices: square(0.2) }, { pos: 50, vertices: square(0.3) }],
    }
    const w = toWire(m)
    expect(Object.keys(w)).toEqual(['id', 'name', 'kind', 'base', 'keys', 'shapeKeys'])
    expect(w.keys[0]).toEqual({ channel: 'feather', anchor: 'Origin', pos: 10, value: 0.1, interp: 'Linear' })
    expect(w.keys[1].bez).toEqual([0.42, 0, 0.58, 1])
    expect(w.shapeKeys.map((k) => k.pos)).toEqual([50, 100])
    expect(w.shapeKeys[0]).toEqual({ pos: 50, interp: 'Linear', vertices: square(0.3) })
    expect(validateMask(w).ok).toBe(true)
    expect(w.base.shape.vertices).not.toBe(m.base.shape.vertices)
  })

  it('fromWire is tolerant: defaults, clamps, drops unusable keys and mismatched shape keys', () => {
    const m = fromWire({
      id: 5, kind: 'Rectangle',
      base: { shape: { vertices: [...square(0.4), [0, 0.5, 0, 0, 0, 0]] }, opacity: 3, mode: 'Nope' },
      keys: [{ channel: 'feather', pos: 0, value: 0.2 }, { channel: 'zoom', pos: 0, value: 1 }, { channel: 'opacity', pos: -5, value: 1 }],
      shapeKeys: [{ pos: 0, vertices: square(0.1) }, { pos: 10, vertices: [...square(0.1), [0, 0.2]] }],
    })
    expect(m.kind).toBe('Path')                   // a 5-point rectangle cannot stay a Rectangle
    expect(m.name).toBe('Mask 5')
    expect(m.base).toMatchObject({ feather: 0, expansion: 0, opacity: 1, mode: 'Add', invert: false })
    expect(m.keys).toEqual([{ channel: 'feather', anchor: 'Origin', pos: 0, value: 0.2, interp: 'Linear' }])
    expect(m.shapeKeys).toHaveLength(1)
    expect(m.shapeKeys[0].vertices[4]).toEqual([0, 0.2, 0, 0, 0, 0])
    expect(validateMask(m).ok).toBe(true)
    expect(fromWire({ id: 0 })).toBeNull()
    expect(fromWire({ id: 1, base: { shape: { vertices: [[0, 0]] } } })).toBeNull()
    expect(fromWireList([null, { id: 1, kind: 'Ellipse', base: { shape: makeEllipse() } }, 'x'])).toHaveLength(1)
    expect(fromWireList(undefined)).toEqual([])
  })

  it('an empty name is valid and goes on the wire as "Mask <id>" (as the engine stores it)', () => {
    const m = { ...good(), name: '' }
    expect(validateMask(m).ok).toBe(true)
    expect(toWire(m).name).toBe('Mask 1')
    expect(toWire({ ...good(), name: undefined }).name).toBe('Mask 1')
    expect(fromWire({ ...good(), name: '' }).name).toBe('Mask 1')
  })

  it('ids cap at 2147483647; the coordinate bound is 10000 inclusive (validate and fromWire agree with the engine)', () => {
    expect(validateMask({ ...good(), id: 2147483647 }).ok).toBe(true)
    expect(fromWire({ ...good(), id: 2147483648 })).toBeNull()
    const edge = good()
    edge.base.shape.vertices[1] = [0.4, -0.4, 0, 0, -10000, 10000]
    expect(validateMask(edge).ok).toBe(true)
    expect(fromWire(edge).base.shape.vertices[1]).toEqual([0.4, -0.4, 0, 0, -10000, 10000])
    // Past the bound: the mask (base) or the shape key is dropped, like the engine's tolerant load.
    const far = good()
    far.base.shape.vertices[0] = [10001, 0, 0, 0, 0, 0]
    expect(fromWire(far)).toBeNull()
    const farTangent = good()
    farTangent.base.shape.vertices[3] = [0, 0, 0, -1e9, 0, 0]
    expect(fromWire(farTangent)).toBeNull()
    const farKey = { ...good(), shapeKeys: [{ pos: 0, vertices: square(0.4) }, { pos: 10, vertices: [[2e4, 0, 0, 0, 0, 0], ...square(0.4).slice(1)] }] }
    expect(fromWire(farKey).shapeKeys.map((k) => k.pos)).toEqual([0])
    // nextMaskId never goes past the cap.
    expect(nextMaskId([{ id: 2147483647 }, { id: 1 }])).toBe(2)
  })

  it('toWire(fromWire(x)) is a fixed point', () => {
    const w = toWire(makeMask('Ellipse', 9))
    expect(toWire(fromWire(w))).toEqual(w)
  })
})

describe('evaluation at a tick', () => {
  it('scalars: keyed channels follow their keys (clamped), unkeyed hold the base', () => {
    let m = makeMask('Rectangle', 1)
    m = upsertMaskKey(m, { channel: 'feather', pos: 0, value: 0 })
    m = upsertMaskKey(m, { channel: 'feather', pos: 960, value: 0.2 })
    m = { ...m, base: { ...m.base, expansion: 0.05 } }
    expect(maskScalarAt(m, 'feather', 480)).toBeCloseTo(0.1, 12)
    expect(maskScalarAt(m, 'feather', -10)).toBe(0)
    expect(maskScalarAt(m, 'feather', 5000)).toBe(0.2)
    expect(maskScalarAt(m, 'expansion', 480)).toBe(0.05)
    expect(maskScalarAt(m, 'opacity', 480)).toBe(1)
    // An overshooting Bezier never takes opacity past 1.
    let o = upsertMaskKey(makeMask('Rectangle', 1), { channel: 'opacity', pos: 0, value: 0, interp: 'Bezier', bez: [0.34, 1.56, 0.64, 1] })
    o = upsertMaskKey(o, { channel: 'opacity', pos: 1000, value: 1 })
    const peak = Math.max(...[500, 600, 700, 800, 900].map((t) => maskScalarAt(o, 'opacity', t)))
    expect(peak).toBe(1)
  })

  it('shape: base without keys; first / last outside; lerp by the leaving key', () => {
    const m0 = makeMask('Rectangle', 1)
    expect(shapeAt(m0, 123)).toEqual(m0.base.shape.vertices)
    expect(shapeAt(m0, 123)).not.toBe(m0.base.shape.vertices)
    let m = upsertShapeKey(m0, 1000, square(0.2))
    m = upsertShapeKey(m, 0, square(0.4))
    expect(m.shapeKeys.map((k) => k.pos)).toEqual([0, 1000])
    expect(isShapeAnimated(m)).toBe(true)
    expect(shapeAt(m, -5)).toEqual(square(0.4))
    expect(shapeAt(m, 2000)).toEqual(square(0.2))
    expect(shapeAt(m, 250)[0][0]).toBeCloseTo(-0.35, 12)          // linear: 0.4 -> 0.2 at 25 %
    const ease = upsertShapeKey(m, 0, square(0.4), { interp: 'EaseOut' })
    expect(shapeAt(ease, 500)[1][0]).toBeCloseTo(0.4 - 0.2 * 0.75, 12)  // 1-(1-u)^2 at u=0.5
    const hold = upsertShapeKey(m, 0, square(0.4), { interp: 'Hold' })
    expect(shapeAt(hold, 999)).toEqual(square(0.4))
    // Tangents lerp too.
    let e = upsertShapeKey(makeMask('Ellipse', 1), 0, makeEllipse({ rx: 0.4 }).vertices)
    e = upsertShapeKey(e, 100, makeEllipse({ rx: 0.2 }).vertices)
    expect(shapeAt(e, 50)[0][4]).toBeCloseTo(KAPPA * 0.3, 12)
  })

  it('evaluateMask bundles everything; mode and invert are static', () => {
    const m = { ...makeMask('Ellipse', 1), base: { ...makeMask('Ellipse', 1).base, mode: 'Subtract', invert: true } }
    const f = evaluateMask(m, 0)
    expect(f).toEqual({ vertices: makeEllipse().vertices, feather: 0, expansion: 0, opacity: 1, mode: 'Subtract', invert: true })
    expect(evaluateMasks([m, m], 0)).toHaveLength(2)
  })
})

describe('key edits', () => {
  it('upsertShapeKey replaces within half a tick and keeps interp; a wrong point count throws', () => {
    let m = upsertShapeKey(makeMask('Rectangle', 1), 100, square(0.3), { interp: 'Bezier' })
    expect(m.shapeKeys[0]).toMatchObject({ pos: 100, interp: 'Bezier', bez: [0.42, 0, 0.58, 1] })
    m = upsertShapeKey(m, 100.4, square(0.25))
    expect(m.shapeKeys).toHaveLength(1)
    expect(m.shapeKeys[0]).toMatchObject({ pos: 100, interp: 'Bezier' })
    expect(m.shapeKeys[0].vertices).toEqual(square(0.25))
    expect(() => upsertShapeKey(m, 0, square(0.25).slice(0, 3))).toThrow(/needs the base's 4 points/)
    expect(removeShapeKey(m, 100).shapeKeys).toEqual([])
    expect(removeShapeKey(m, 300)).toBe(m)
  })

  it('upsertMaskKey clamps, updates in place, refuses unknown channels', () => {
    let m = upsertMaskKey(makeMask('Rectangle', 1), { channel: 'opacity', pos: 10.2, value: 4 })
    expect(m.keys).toEqual([{ channel: 'opacity', anchor: 'Origin', pos: 10, value: 1, interp: 'Linear' }])
    m = upsertMaskKey(m, { channel: 'opacity', pos: 10, value: 0.5, interp: 'Hold' })
    expect(m.keys).toEqual([{ channel: 'opacity', anchor: 'Origin', pos: 10, value: 0.5, interp: 'Hold' }])
    expect(() => upsertMaskKey(m, { channel: 'zoom', pos: 0, value: 1 })).toThrow()
  })

  it('stopwatch OFF: keys go and the base takes the value at the playhead (R3)', () => {
    let m = upsertMaskKey(makeMask('Rectangle', 1), { channel: 'feather', pos: 0, value: 0 })
    m = upsertMaskKey(m, { channel: 'feather', pos: 100, value: 0.2 })
    const off = clearMaskChannelKeys(m, 'feather', maskScalarAt(m, 'feather', 50))
    expect(off.keys).toEqual([])
    expect(off.base.feather).toBeCloseTo(0.1, 12)
    let s = upsertShapeKey(makeMask('Rectangle', 1), 0, square(0.4))
    s = upsertShapeKey(s, 100, square(0.2))
    const flat = clearShapeKeys(s, shapeAt(s, 50))
    expect(flat.shapeKeys).toEqual([])
    expect(flat.base.shape.vertices[0][0]).toBeCloseTo(-0.3, 12)
  })
})

describe('vertex insert / delete across every shape key (R14)', () => {
  it('a straight edge gets a corner point on the line (de Casteljau parameter)', () => {
    const m = insertVertexAll(makeMask('Rectangle', 1), 0, 0.5)
    expect(m.kind).toBe('Path')
    expect(m.base.shape.vertices).toHaveLength(5)
    expect(m.base.shape.vertices[1]).toEqual([0, -0.4, 0, 0, 0, 0])
    const q = insertVertexAll(makeMask('Rectangle', 1), 0, 0.25)
    // A straight cubic with zero handles runs 3t^2 - 2t^3 along the edge: 0.15625 at t = 0.25.
    expect(q.base.shape.vertices[1][0]).toBeCloseTo(-0.4 + 0.8 * 0.15625, 12)
    expect(q.base.shape.vertices[1].slice(2)).toEqual([0, 0, 0, 0])
    expect(validateMask(q).ok).toBe(true)
  })

  it('a curved edge splits without changing the drawn path', () => {
    const e = makeEllipse()
    const split = splitEdge(e.vertices, 0, 0.5)
    expect(split).toHaveLength(5)
    expect(split[1][0]).toBeCloseTo(0.4 / Math.SQRT2, 9)
    // The first half at its own t = 0.5 is the original curve at t = 0.25, and so on.
    for (const [newEdge, tNew, tOld] of [[0, 0.5, 0.25], [1, 0.5, 0.75], [0, 0.2, 0.1], [1, 0.8, 0.9]]) {
      const a = edgePoint(split, newEdge, tNew)
      const b = edgePoint(e.vertices, 0, tOld)
      expect(a[0]).toBeCloseTo(b[0], 12)
      expect(a[1]).toBeCloseTo(b[1], 12)
    }
    // The other edges are untouched.
    expect(split[2]).toEqual([0.4, 0, 0, -K / 2, 0, K])
    expect(split[3]).toEqual(e.vertices[2])
  })

  it('inserts into the base AND every shape key; the edge index wraps', () => {
    let m = upsertShapeKey(makeMask('Rectangle', 1), 0, square(0.4))
    m = upsertShapeKey(m, 100, square(0.2))
    const n = insertVertexAll(m, 3, 0.5)            // edge BL -> TL
    expect(n.base.shape.vertices).toHaveLength(5)
    expect(n.shapeKeys.every((k) => k.vertices.length === 5)).toBe(true)
    expect(n.base.shape.vertices[4]).toEqual([-0.4, 0, 0, 0, 0, 0])
    expect(n.shapeKeys[1].vertices[4]).toEqual([-0.2, 0, 0, 0, 0, 0])
    expect(validateMask(toWire(n)).ok).toBe(true)
    const w = insertVertexAll(m, 7, 0.5)            // 7 mod 4 = edge 3
    expect(w.base.shape.vertices).toEqual(n.base.shape.vertices)
  })

  it('caps: no insert past 32 points, no delete below 3', () => {
    const ring = Array.from({ length: 32 }, (_, i) => [0.4 * Math.cos(i / 5), 0.4 * Math.sin(i / 5), 0, 0, 0, 0])
    expect(insertVertexAll(makeMask('Path', 1, 'p', { shape: { vertices: ring } }), 0, 0.5)).toBeNull()
    const tri = makeMask('Path', 1, 't', { shape: { vertices: square(0.4).slice(0, 3) } })
    expect(deleteVertexAll(tri, 0)).toBeNull()
  })

  it('deletes from the base and every key; the mask becomes a Path', () => {
    let m = upsertShapeKey(makeMask('Rectangle', 1), 0, square(0.3))
    m = deleteVertexAll(m, 1)
    expect(m.kind).toBe('Path')
    expect(m.base.shape.vertices).toEqual([square(0.4)[0], square(0.4)[2], square(0.4)[3]])
    expect(m.shapeKeys[0].vertices).toEqual([square(0.3)[0], square(0.3)[2], square(0.3)[3]])
    expect(deleteVertexAll(makeMask('Rectangle', 1), 9)).toBeNull()
  })

  it('convertToPath keeps the points', () => {
    const r = makeMask('Rectangle', 1)
    expect(convertToPath(r)).toMatchObject({ kind: 'Path', base: r.base })
    const p = convertToPath(r)
    expect(convertToPath(p)).toBe(p)
  })
})

describe('shape geometry', () => {
  it('transformShape maps handles by their end points', () => {
    const e = makeEllipse()
    const moved = transformShape(e, ([x, y]) => [x + 0.1, y])
    expect(moved.vertices[0][0]).toBeCloseTo(0.1, 12)
    expect(moved.vertices[0][4]).toBeCloseTo(K, 12)
    const doubled = transformShape(e, ([x, y]) => [2 * x, 2 * y])
    expect(doubled.vertices[1]).toEqual([0.8, 0, 0, -2 * K, 0, 2 * K])
  })

  it('bounds, flattening, nearest edge', () => {
    expect(shapeBounds(makeRectangle({ hw: 0.3, hh: 0.1 }))).toEqual({ x: -0.3, y: -0.1, w: 0.6, h: 0.2 })
    expect(flattenShape(makeRectangle())).toEqual([[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]])
    expect(flattenShape(makeEllipse())).toHaveLength(4 * DEFAULT_SEGMENTS_PER_EDGE)
    expect(flattenShape(makeEllipse(), 4)).toHaveLength(16)
    const near = nearestEdge(makeRectangle(), 0.1, -0.41)
    expect(near.edgeIndex).toBe(0)
    expect(near.distance).toBeGreaterThanOrEqual(0.01 - 1e-12)
    expect(near.distance).toBeLessThan(0.025)                       // sampled, 32 per edge
    const p = edgePoint(makeRectangle().vertices, near.edgeIndex, near.t)
    expect(p[1]).toBeCloseTo(-0.4, 12)
  })
})

describe('coverage reference (R12)', () => {
  const px = { w: 100, h: 100 }
  const frame = (over = {}, shape = makeRectangle()) => ({ ...evaluateMask(makeMask('Rectangle', 1), 0), vertices: shape.vertices, ...over })

  it('no masks = full coverage', () => {
    expect(coverageAt([], 0, 0, px)).toBe(1)
    expect(coverageAt(undefined, 0, 0, px)).toBe(1)
  })

  it('hard edge: 1 px anti-aliased, 0.5 on the edge', () => {
    expect(coverageAt([frame()], 0, 0, px)).toBe(1)
    expect(coverageAt([frame()], 0.45, 0, px)).toBe(0)
    expect(coverageAt([frame()], 0.4, 0, px)).toBe(0.5)
    expect(coverageAt([frame()], 0.4 - 0.0025, 0, px)).toBeCloseTo(0.84375, 9)    // 0.25 px inside
  })

  it('feather is centred on the edge, in units of the shorter side', () => {
    const f = frame({ feather: 0.1 })                                     // 10 px
    expect(coverageAt([f], 0.4, 0, px)).toBe(0.5)
    expect(coverageAt([f], 0.375, 0, px)).toBeCloseTo(0.84375, 9)          // 2.5 px in: t = 0.75
    expect(coverageAt([f], 0.425, 0, px)).toBeCloseTo(0.15625, 9)          // 2.5 px out
    expect(coverageAt([f], 0.46, 0, px)).toBe(0)
    // Isotropic on a non-square cell: 2.5 px out across x and down y read the same.
    const wide = { w: 200, h: 100 }
    expect(coverageAt([f], 0.4 + 2.5 / 200, 0, wide)).toBeCloseTo(0.15625, 9)
    expect(coverageAt([f], 0, 0.4 + 2.5 / 100, wide)).toBeCloseTo(0.15625, 9)
  })

  it('more feather = more coverage outside, less inside (monotonic)', () => {
    let out = -1
    let inn = 2
    for (const feather of [0, 0.02, 0.05, 0.1, 0.2, 0.4]) {
      const o = coverageAt([frame({ feather })], 0.43, 0, px)
      const i = coverageAt([frame({ feather })], 0.37, 0, px)
      expect(o).toBeGreaterThanOrEqual(out)
      expect(i).toBeLessThanOrEqual(inn)
      out = o
      inn = i
    }
  })

  it('expansion pushes the edge out (negative pulls it in)', () => {
    expect(coverageAt([frame({ expansion: 0.05 })], 0.45, 0, px)).toBe(0.5)
    expect(coverageAt([frame({ expansion: -0.05 })], 0.35, 0, px)).toBe(0.5)
    expect(coverageAt([frame({ expansion: -0.05 })], 0.38, 0, px)).toBe(0)
  })

  it('invert, opacity and the three modes combine top to bottom', () => {
    expect(coverageAt([frame({ invert: true })], 0, 0, px)).toBe(0)
    expect(coverageAt([frame({ invert: true })], 0.48, 0, px)).toBe(1)
    expect(coverageAt([frame({ opacity: 0.5 })], 0, 0, px)).toBe(0.5)
    // R12 "Opacity 0 = the mask has no effect": a sole Add mask at 0 shows the whole cell.
    expect(coverageAt([frame({ opacity: 0 })], 0, 0, px)).toBe(1)
    expect(coverageAt([frame({ opacity: 0 })], 0.48, 0, px)).toBe(1)
    // A first Subtract starts from full coverage.
    expect(coverageAt([frame({ mode: 'Subtract' })], 0, 0, px)).toBe(0)
    expect(coverageAt([frame({ mode: 'Subtract' })], 0.48, 0, px)).toBe(1)
    expect(coverageAt([frame({ mode: 'Subtract', opacity: 0 })], 0, 0, px)).toBe(1)  // opacity 0 = no effect
    // Add a big square, subtract a small one: a frame.
    const big = frame()
    const hole = frame({ mode: 'Subtract' }, makeRectangle({ hw: 0.2 }))
    expect(coverageAt([big, hole], 0, 0, px)).toBe(0)
    expect(coverageAt([big, hole], 0.3, 0, px)).toBe(1)
    expect(coverageAt([big, hole], 0.48, 0, px)).toBe(0)
    // Intersect: only where both cover.
    const right = frame({ mode: 'Intersect' }, makeRectangle({ cx: 0.3, hw: 0.2 }))
    expect(coverageAt([big, right], -0.2, 0, px)).toBe(0)
    expect(coverageAt([big, right], 0.2, 0, px)).toBe(1)
    // Add with half opacity onto a covered point: 1 + 0.5 - 0.5 = 1; onto an empty one: 0.5.
    const half = frame({ opacity: 0.5 }, makeRectangle({ cx: 0.3, hw: 0.1 }))
    expect(coverageAt([big, half], 0, 0, px)).toBe(1)
    expect(coverageAt([frame({}, makeRectangle({ hw: 0.1 })), half], 0.3, 0, px)).toBe(0.5)
  })

  it('a mask at opacity 0 is exactly as if it were absent (it does not pick the start)', () => {
    const off = frame({ opacity: 0 })
    const small = frame({}, makeRectangle({ hw: 0.2 }))
    const cut = frame({ mode: 'Subtract' }, makeRectangle({ hw: 0.2 }))
    for (const [x, y] of [[0, 0], [0.3, 0], [0.48, 0.48], [0.1, -0.1]]) {
      expect(coverageAt([off, small], x, y, px)).toBe(coverageAt([small], x, y, px))
      expect(coverageAt([off, cut], x, y, px)).toBe(coverageAt([cut], x, y, px))
      expect(coverageAt([off, off], x, y, px)).toBe(coverageAt([], x, y, px))
    }
    // An off Add first, then a live Add: only the live shape shows.
    expect(coverageAt([off, small], 0.3, 0, px)).toBe(0)
    expect(coverageAt([off, small], 0, 0, px)).toBe(1)
  })

  it('ellipses and nonzero winding (a pentagram counts its centre as inside)', () => {
    const e = frame({}, makeEllipse())
    expect(coverageAt([e], 0.25, 0.25, px)).toBe(1)     // r = 0.354
    expect(coverageAt([e], 0.3, 0.3, px)).toBe(0)       // r = 0.424
    const star = Array.from({ length: 5 }, (_, i) => {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5
      return [0.4 * Math.cos(a), 0.4 * Math.sin(a), 0, 0, 0, 0]
    })
    const poly = flattenShape({ vertices: star })
    expect(Math.abs(windingNumber(poly, 0, 0))).toBe(2)
    expect(shapeCoverage({ vertices: star, feather: 0, expansion: 0 }, 0, 0, px)).toBe(1)
  })
})

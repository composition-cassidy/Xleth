// Masks on the viewer overlay, the pure part (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5,
// R4, R11, R14, R15): cell space <-> screen, handles and their hit priority, every
// shape edit, writing an edit back (base vs shape key, Rectangle -> Path) and the pen.
import { describe, expect, it } from 'vitest'
import { roamQuad, cellGeometry } from '../../../lensRoam/lensRoamModel.js'
import { KAPPA, makeEllipse, makeMask, makeRectangle, validateMasks, toWire, toWireList } from '../../../motion/maskModel.js'
import {
  BOX_PAD_PX, MIN_BOX, committedMasks, deletePoint, hitActiveMask, hitMaskBodies, insertPoint, isSmoothPair, maskFramesAt,
  maskHandles, maskView, moveVertex, penAddPoint, penBlocker, penCanClose, penCreateMask, penDragPoint,
  penPointCap, penRelease, penStart, penUndoPoint, pullHandles, resizeByBox, sameMasks, setTangent,
  translateVertices, writeShape,
} from '../maskOverlay.js'

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }], fullscreenLayers: [],
}
const GEO = cellGeometry(LAYOUT, { id: 7 })
const PIC = { x: 0, y: 0, w: 960, h: 540 }
// The middle cell of a 960 x 540 picture: centre (480, 270), 320 x 180 px.
const view0 = () => maskView(roamQuad(ROAM, GEO), GEO, PIC)
const close = (a, b, d = 9) => {
  expect(a.x).toBeCloseTo(b.x, d)
  expect(a.y).toBeCloseTo(b.y, d)
}

describe('cell space <-> overlay pixels (R11)', () => {
  it('the cell corners land on the drawn cell, centre on its centre', () => {
    const v = view0()
    close(v.toPx([0, 0]), { x: 480, y: 270 })
    close(v.toPx([-0.5, -0.5]), { x: 320, y: 180 })
    close(v.toPx([0.5, 0.5]), { x: 640, y: 360 })
    expect(v.cellPx.w).toBeCloseTo(320, 9)
    expect(v.cellPx.h).toBeCloseTo(180, 9)
  })

  it('moves, scales and rotates with the cell: corners match roamQuad, and toCell inverts toPx', () => {
    const roam = { ...ROAM, offsetX: 0.3, offsetY: -0.2, scale: 1.4, rotationDeg: 33 }
    const q = roamQuad(roam, GEO)
    const v = maskView(q, GEO, PIC)
    const toPx = (p) => ({ x: PIC.x + p.x * PIC.w, y: PIC.y + p.y * PIC.h })
    close(v.toPx([-0.5, -0.5]), toPx(q.corners[0]))
    close(v.toPx([0.5, -0.5]), toPx(q.corners[1]))
    close(v.toPx([0.5, 0.5]), toPx(q.corners[2]))
    for (const p of [[0.1, 0.2], [-0.45, 0.33], [0.5, -0.5]]) {
      const back = v.toCell(v.toPx(p))
      expect(back[0]).toBeCloseTo(p[0], 12)
      expect(back[1]).toBeCloseTo(p[1], 12)
    }
  })
})

describe('handles and hit priority', () => {
  const rect = makeMask('Rectangle', 1, 'Mask 1')
  const ell = makeMask('Ellipse', 2, 'Mask 2')

  it('a Rectangle: 4 points, a box padded outward along the cell axes, no curve handles', () => {
    const v = view0()
    const h = maskHandles(v, rect, rect.base.shape.vertices)
    expect(h.points.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[352, 198], [608, 198], [608, 342], [352, 342]])
    expect(h.tangents).toEqual([])
    close(h.box[0], { x: 352 - BOX_PAD_PX, y: 198 - BOX_PAD_PX })
    close(h.box[2], { x: 608 + BOX_PAD_PX, y: 342 + BOX_PAD_PX })
    expect(h.boxCell).toEqual({ x: -0.4, y: -0.4, w: 0.8, h: 0.8 })
  })

  it('an Ellipse: the box is its bounds; a Path shows curve handles and no box', () => {
    const v = view0()
    const he = maskHandles(v, ell, ell.base.shape.vertices)
    expect(he.boxCell.w).toBeCloseTo(0.8, 12)
    expect(he.tangents).toEqual([])
    const path = { ...ell, kind: 'Path' }
    const hp = maskHandles(v, path, path.base.shape.vertices)
    expect(hp.box).toEqual([])
    expect(hp.tangents).toHaveLength(8)
    // The top point's out handle: KAPPA * 0.4 cell widths to its right.
    const out = hp.tangents.find((t) => t.i === 0 && t.side === 'out')
    close(out, { x: 480 + KAPPA * 0.4 * 320, y: 198 })
  })

  it('the nearest handle wins: a point over its padded box corner, the box corner when nearer', () => {
    const v = view0()
    const vs = rect.base.shape.vertices
    expect(hitActiveMask(v, rect, 0, vs, { x: 353, y: 199 })).toEqual({ kind: 'maskPoint', index: 0, i: 0 })
    expect(hitActiveMask(v, rect, 0, vs, { x: 343, y: 189 })).toEqual({ kind: 'maskBox', index: 0, corner: 0 })
    expect(hitActiveMask(v, rect, 0, vs, { x: 480, y: 270 })).toBeNull()
  })

  it('Ctrl over an edge: where a point would be added; without Ctrl the edge is not a handle', () => {
    const v = view0()
    const vs = rect.base.shape.vertices
    expect(hitActiveMask(v, rect, 0, vs, { x: 480, y: 200 })).toBeNull()
    const h = hitActiveMask(v, rect, 0, vs, { x: 480, y: 200 }, { ctrl: true })
    expect(h.kind).toBe('maskEdge')
    expect(h.edgeIndex).toBe(0)
    expect(h.t).toBeCloseTo(0.5, 9)
  })

  it('bodies: an inactive mask\'s outline selects it; inside the active mask moves it', () => {
    const v = view0()
    const small = makeMask('Rectangle', 3, 'Mask 3')
    small.base.shape = makeRectangle({ hw: 0.1 })
    const frames = maskFramesAt([rect, small], 0)
    // The small mask's top edge at y = 270 - 18 = 252.
    expect(hitMaskBodies(v, frames, 0, { x: 480, y: 252 })).toEqual({ kind: 'maskSelect', index: 1 })
    expect(hitMaskBodies(v, frames, 0, { x: 400, y: 300 })).toEqual({ kind: 'maskInside', index: 0 })
    expect(hitMaskBodies(v, frames, 0, { x: 330, y: 300 })).toBeNull()       // outside both
    expect(hitMaskBodies(v, frames, -1, { x: 400, y: 300 })).toBeNull()      // nothing active: nothing to move
  })
})

describe('shape edits', () => {
  const rect = makeRectangle()
  it('translate, move one point, pull out handles', () => {
    expect(translateVertices(rect.vertices, 0.1, -0.05)[2]).toEqual([0.5, 0.35000000000000003, 0, 0, 0, 0])
    const m = moveVertex(rect.vertices, 1, 0.1, 0.1)
    expect(m[1]).toEqual([0.5, -0.30000000000000004, 0, 0, 0, 0])
    expect(m[0]).toEqual(rect.vertices[0])
    const p = pullHandles(rect.vertices, 0, [0.2, 0])
    expect(p[0]).toEqual([-0.4, -0.4, -0.2, -0, 0.2, 0])
  })

  it('a smooth pair stays opposite (its own length kept); Alt or a broken pair moves one handle only', () => {
    const e = makeEllipse().vertices
    expect(isSmoothPair(e[0])).toBe(true)
    expect(isSmoothPair(rect.vertices[0])).toBe(false)
    const kx = KAPPA * 0.4
    const s = setTangent(e, 0, 'out', [0, 0.3], { start: e[0], smooth: true })
    expect(s[0][4]).toBe(0)
    expect(s[0][5]).toBe(0.3)
    expect(s[0][2]).toBeCloseTo(0, 12)
    expect(s[0][3]).toBeCloseTo(-kx, 12)       // turned to stay opposite, length kx kept
    const b = setTangent(e, 0, 'out', [0, 0.3], { start: e[0], smooth: true, breakPair: true })
    expect(b[0].slice(2, 4)).toEqual([-kx, 0])  // left alone
  })

  it('box resize: the opposite corner stays put; Shift keeps the aspect; never flips or collapses', () => {
    const box = { x: -0.4, y: -0.4, w: 0.8, h: 0.8 }
    const r = resizeByBox(rect.vertices, box, 2, 0.1, 0.05)
    expect(r[0][0]).toBeCloseTo(-0.4, 12)
    expect(r[0][1]).toBeCloseTo(-0.4, 12)
    expect(r[2][0]).toBeCloseTo(0.5, 12)
    expect(r[2][1]).toBeCloseTo(0.45, 12)
    const a = resizeByBox(rect.vertices, box, 2, 0.1, 0, { keepAspect: true })
    expect(a[2][0]).toBeCloseTo(0.5, 12)
    expect(a[2][1]).toBeCloseTo(0.5, 12)
    const tl = resizeByBox(rect.vertices, box, 0, 0.1, 0.1)
    expect(tl[2]).toEqual(rect.vertices[2])     // BR fixed while TL is dragged
    expect(tl[0][0]).toBeCloseTo(-0.3, 12)
    const tiny = resizeByBox(rect.vertices, box, 2, -5, -5)
    expect(tiny[2][0] - tiny[0][0]).toBeCloseTo(MIN_BOX, 12)
    // An ellipse's handles scale with it, so it stays an ellipse.
    const e = makeEllipse()
    const er = resizeByBox(e.vertices, box, 2, 0.8, 0)
    expect(er[0][4]).toBeCloseTo(KAPPA * 0.4 * 2, 12)
  })
})

describe('writing an edit back (R4, R14)', () => {
  const rect = makeMask('Rectangle', 1, 'Mask 1')
  const moved = moveVertex(rect.base.shape.vertices, 0, -0.05, 0)

  it('a still shape: the base changes; a single-point edit makes a Rectangle a Path, a box edit does not', () => {
    const a = writeShape([rect], 0, 1920, moved, { toPath: true })
    expect(a[0].kind).toBe('Path')
    expect(a[0].base.shape.vertices[0]).toEqual([-0.45, -0.4, 0, 0, 0, 0])
    expect(a[0].shapeKeys).toEqual([])
    const b = writeShape([rect], 0, 1920, moved)
    expect(b[0].kind).toBe('Rectangle')
    expect(validateMasks(toWireList(a)).ok).toBe(true)
  })

  it('an animated shape: a shape key at the playhead, the base untouched', () => {
    const anim = { ...rect, shapeKeys: [{ pos: 0, interp: 'Linear', vertices: rect.base.shape.vertices }, { pos: 3840, interp: 'Linear', vertices: rect.base.shape.vertices }] }
    const a = writeShape([anim], 0, 1920, moved, { toPath: true })
    expect(a[0].base.shape.vertices).toEqual(rect.base.shape.vertices)
    expect(a[0].shapeKeys.map((k) => k.pos)).toEqual([0, 1920, 3840])
    expect(a[0].shapeKeys[1].vertices[0]).toEqual([-0.45, -0.4, 0, 0, 0, 0])
    expect(a[0].kind).toBe('Path')
  })

  it('insert and delete a point everywhere, with the caps said in words', () => {
    const ins = insertPoint([rect], 0, 0, 0.5)
    expect(ins.i).toBe(1)
    expect(ins.masks[0].kind).toBe('Path')
    expect(ins.masks[0].base.shape.vertices[1]).toEqual([0, -0.4, 0, 0, 0, 0])
    const del = deletePoint([rect], 0, 0)
    expect(del.masks[0].base.shape.vertices).toHaveLength(3)
    const tri = del.masks[0]
    expect(deletePoint([tri], 0, 0).error).toBe('A mask needs at least 3 points')
    const big = { ...rect, kind: 'Path', base: { ...rect.base, shape: { closed: true, vertices: Array.from({ length: 32 }, (_, i) => [Math.cos(i), Math.sin(i), 0, 0, 0, 0]) } } }
    expect(insertPoint([big], 0, 0, 0.5).error).toBe('A mask holds at most 32 points')
  })

  it('sameMasks compares data', () => {
    expect(sameMasks([rect], [makeMask('Rectangle', 1, 'Mask 1')])).toBe(true)
    expect(sameMasks([rect], writeShape([rect], 0, 0, moved))).toBe(false)
  })
})

describe('the pen', () => {
  it('click = corner point, drag = smooth point, close makes a Path mask with the next id', () => {
    let pen = penStart()
    pen = penRelease(penAddPoint(pen, [-0.25, -0.2]))
    pen = penAddPoint(pen, [0.25, -0.2])
    pen = penRelease(penDragPoint(pen, [0.375, -0.1]))
    expect(penCanClose(pen)).toBe(false)
    pen = penRelease(penAddPoint(pen, [0, 0.3]))
    expect(penCanClose(pen)).toBe(true)
    expect(pen.points[0]).toEqual([-0.25, -0.2, 0, 0, 0, 0])
    expect(pen.points[1][4]).toBeCloseTo(0.125, 12)
    expect(pen.points[1][5]).toBeCloseTo(0.1, 12)
    expect(pen.points[1][2]).toBeCloseTo(-0.125, 12)
    const existing = [makeMask('Rectangle', 4, 'Mask 4')]
    const r = penCreateMask(existing, pen)
    expect(r.mask.id).toBe(5)
    expect(r.mask.kind).toBe('Path')
    expect(r.mask.name).toBe('Mask 5')
    expect(r.masks).toHaveLength(2)
    expect(r.mask.base.shape.vertices).toEqual(pen.points)
    expect(validateMasks(toWireList(r.masks)).ok).toBe(true)
    expect(penUndoPoint(pen).points).toHaveLength(2)
  })

  it('too few points, a full track, the per-track point budget', () => {
    expect(penCreateMask([], penAddPoint(penStart(), [0, 0])).error).toBe('A mask needs at least 3 points')
    const eight = Array.from({ length: 8 }, (_, i) => makeMask('Rectangle', i + 1))
    expect(penBlocker(eight)).toBe('A track holds at most 8 masks')
    // 15 rectangles' worth of points would not fit, but 8 masks x 4 = 32 leaves 32.
    expect(penPointCap(eight.slice(0, 7))).toBe(32)
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...makeMask('Path', i + 1),
      base: { ...makeMask('Path', i + 1).base, shape: { closed: true, vertices: Array.from({ length: 8 }, (_, k) => [k / 10, 0, 0, 0, 0, 0]) } },
    }))
    expect(penPointCap(many)).toBe(8)                // 64 - 56
    expect(penBlocker([])).toBeNull()
  })
})

describe('committedMasks: what a resolved mask commit leaves on the track', () => {
  it('the engine list in maskModel form for this track; null for another track or no list', () => {
    const m = makeMask('Rectangle', 1, 'Mask 1')
    const res = { trackId: 7, changed: true, masks: [toWire(m)] }
    expect(committedMasks(res, 7)).toEqual([m])
    expect(committedMasks({ ...res, masks: [] }, 7)).toEqual([])
    expect(committedMasks(res, 3)).toBeNull()
    expect(committedMasks({ changed: true, masks: [toWire(m)] }, 3)).toEqual([m])
    expect(committedMasks({ trackId: 7, changed: false }, 7)).toBeNull()
    expect(committedMasks(null, 7)).toBeNull()
  })
})

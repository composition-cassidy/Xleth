import { describe, expect, it } from 'vitest'
import {
  LENS_IDENTITY, ROAM_IDENTITY, applyUvMap, cellGeometry, cellsToDisplay, containRect, createAngleAccumulator,
  displayToCells, lensBoxContains, lensBoxCorners, lensIsNeutral, lensMoveCenter, lensUvMap, lensZoomFromDrag,
  roamContains, roamIsIdentity, roamMoveOffset, roamQuad, roamScaleFromDrag,
} from './lensRoamModel.js'

const near = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

const layout3 = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }],     // the middle cell of 3x3
  fullscreenLayers: [{ trackId: 9 }],
}

describe('Lens box (the engine map, pushed through the cell corners)', () => {
  it('Stretch at identity is the whole source', () => {
    const c = lensBoxCorners({ ...LENS_IDENTITY }, 16 / 9, 4 / 3)
    expect(c.map((p) => [p.x, p.y])).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]])
  })

  it('Cover at zoom 1 fills the cell and crops the overflow: a 4:3 source in a 16:9 cell shows a full-width band', () => {
    const c = lensBoxCorners({ ...LENS_IDENTITY, fit: 'Cover' }, 16 / 9, 4 / 3)
    near(c[0].x, 0); near(c[1].x, 1)                       // full width
    near(c[3].y - c[0].y, (4 / 3) / (16 / 9))              // 0.75 of the height
    near((c[0].y + c[3].y) / 2, 0.5)                       // centred
  })

  it('Contain at zoom 1 overshoots the source in the long axis (the letterbox)', () => {
    const c = lensBoxCorners({ ...LENS_IDENTITY, fit: 'Contain' }, 16 / 9, 4 / 3)
    near(c[0].y, 0); near(c[3].y, 1)                       // full height
    expect(c[0].x).toBeLessThan(0)
    expect(c[1].x).toBeGreaterThan(1)
  })

  it('zoom 2 halves the box about the centre', () => {
    const one = lensBoxCorners({ ...LENS_IDENTITY, fit: 'Cover' }, 16 / 9, 16 / 9)
    const two = lensBoxCorners({ ...LENS_IDENTITY, fit: 'Cover', zoom: 2 }, 16 / 9, 16 / 9)
    near(two[1].x - two[0].x, (one[1].x - one[0].x) / 2)
    near(two[3].y - two[0].y, (one[3].y - one[0].y) / 2)
  })

  it('the centre maps to the cell middle, for any rotation', () => {
    const lens = { ...LENS_IDENTITY, fit: 'Cover', centerX: 0.3, centerY: 0.7, zoom: 1.5, rotationDeg: 37 }
    const m = lensUvMap(lens, 16 / 9, 1, 4 / 3, 1)
    const p = applyUvMap(m, 0.5, 0.5)
    near(p.x, 0.3); near(p.y, 0.7)
  })

  it('positive rotation turns the picture clockwise, so the box turns counter-clockwise on the source', () => {
    // Square cell and source: the cell's +x edge direction on the source is (cos, -sin).
    const m = lensUvMap({ ...LENS_IDENTITY, fit: 'Cover', rotationDeg: 90 }, 1, 1, 1, 1)
    const a = applyUvMap(m, 0.5, 0.5)
    const b = applyUvMap(m, 1, 0.5)
    near(b.x - a.x, 0); near(b.y - a.y, -0.5)
  })

  it('hit-tests the rotated box', () => {
    const lens = { ...LENS_IDENTITY, fit: 'Cover', zoom: 4, rotationDeg: 45 }
    expect(lensBoxContains(lens, 1, 1, 0.5, 0.5)).toBe(true)
    expect(lensBoxContains(lens, 1, 1, 0.9, 0.9)).toBe(false)
  })
})

describe('Lens gestures', () => {
  it('moves the centre with the pointer and clamps to the source', () => {
    expect(lensMoveCenter({ centerX: 0.5, centerY: 0.5 }, 0.1, -0.2)).toEqual({ centerX: 0.6, centerY: 0.3 })
    expect(lensMoveCenter({ centerX: 0.9, centerY: 0.1 }, 0.5, -0.5)).toEqual({ centerX: 1, centerY: 0 })
  })

  it('pulling a corner out zooms out; in zooms in; bounded', () => {
    near(lensZoomFromDrag(1, 50, 100), 0.5)
    near(lensZoomFromDrag(1, 100, 50), 2)
    expect(lensZoomFromDrag(1, 100, 1)).toBe(16)
    expect(lensZoomFromDrag(1, 0, 10)).toBe(1)             // no usable start: unchanged
  })

  it('neutral means nothing but the fit differs', () => {
    expect(lensIsNeutral({ ...LENS_IDENTITY, fit: 'Cover' })).toBe(true)
    expect(lensIsNeutral({ ...LENS_IDENTITY, zoom: 1.1 })).toBe(false)
    expect(lensIsNeutral({ ...LENS_IDENTITY, flip: 'Horizontal' })).toBe(false)
  })
})

describe('cellGeometry', () => {
  it('a 3x3 middle cell: home, unit and aspect', () => {
    const g = cellGeometry(layout3, { id: 7 })
    near(g.home.x, 1 / 3); near(g.home.w, 1 / 3)
    near(g.unit.w, 1 / 3)
    near(g.aspect, 16 / 9)
    near(g.cellPx.w, 640); near(g.cellPx.h, 360)
  })

  it('a half-grid span is half a unit', () => {
    const g = cellGeometry({ ...layout3, slots: [{ trackId: 7, gridX: 0, gridY: 0, spanX: 4, spanY: 8 }] }, { id: 7 })
    near(g.unit.w, 1 / 6); near(g.unit.h, 1 / 3)
  })

  it('the gap insets the home rect but not the unit (grid cells only)', () => {
    const g = cellGeometry({ ...layout3, gapScale: 0.2 }, { id: 7 })
    near(g.home.w, (1 / 3) * 0.8); near(g.unit.w, 1 / 3)
    const own = cellGeometry({ ...layout3, gapScale: 0.2 }, { id: 7, gapScaleOverride: 0 })
    near(own.home.w, 1 / 3)
    const fs = cellGeometry({ ...layout3, gapScale: 0.2 }, { id: 9 })
    expect(fs.kind).toBe('layer'); near(fs.home.w, 1); near(fs.unit.w, 1)
  })

  it('a track with no cell has no geometry', () => {
    expect(cellGeometry(layout3, { id: 99 })).toBeNull()
  })

  it('stored cells stay proportional when 3x3 becomes 4x4: same offset, smaller move', () => {
    const roam = { ...ROAM_IDENTITY, offsetX: 1 }
    const g3 = cellGeometry(layout3, { id: 7 })
    const g4 = cellGeometry({ ...layout3, columns: 4, rows: 4, slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }] }, { id: 7 })
    const move = (g) => roamQuad(roam, g).center.x - (g.home.x + g.home.w / 2)
    near(move(g3), 1 / 3)
    near(move(g4), 1 / 4)                                   // one cell is now a quarter wide
    near(move(g4) / g4.home.w, move(g3) / g3.home.w)        // the same number of cells
  })
})

describe('Roam', () => {
  const geo = cellGeometry(layout3, { id: 7 })

  it('identity leaves the cell on its home rect', () => {
    const q = roamQuad(ROAM_IDENTITY, geo)
    near(q.rect.x, geo.home.x); near(q.rect.w, geo.home.w)
    expect(roamIsIdentity(ROAM_IDENTITY)).toBe(true)
    expect(roamIsIdentity({ ...ROAM_IDENTITY, bounds: 'Float' })).toBe(false)
  })

  it('offset is in cells, scale is about the centre', () => {
    const q = roamQuad({ ...ROAM_IDENTITY, offsetX: 1, offsetY: -0.5, scale: 2 }, geo)
    near(q.center.x, geo.home.x + geo.home.w / 2 + geo.unit.w)
    near(q.center.y, geo.home.y + geo.home.h / 2 - 0.5 * geo.unit.h)
    near(q.rect.w, geo.home.w * 2)
  })

  it('rotation is rigid in pixel space and clockwise', () => {
    const q = roamQuad({ ...ROAM_IDENTITY, rotationDeg: 90 }, geo)
    // Rigid: side lengths in pixels are the cell's, swapped onto the other axes.
    const px = (a, b) => Math.hypot((b.x - a.x) * geo.canvasW, (b.y - a.y) * geo.canvasH)
    near(px(q.corners[0], q.corners[1]), geo.home.w * geo.canvasW, 1e-3)
    near(px(q.corners[1], q.corners[2]), geo.home.h * geo.canvasH, 1e-3)
    // Clockwise: the top-left corner swings to the top-right of the box.
    expect(q.corners[0].x).toBeGreaterThan(q.center.x)
    expect(q.corners[0].y).toBeLessThan(q.center.y)
  })

  it('hit-tests the moved and rotated cell', () => {
    const roam = { ...ROAM_IDENTITY, offsetX: 1, rotationDeg: 30 }
    const q = roamQuad(roam, geo)
    expect(roamContains(roam, geo, q.center.x, q.center.y)).toBe(true)
    expect(roamContains(roam, geo, geo.home.x + 0.01, geo.home.y + 0.01)).toBe(false)
  })

  it('a move by du changes the offset by du / unit (so it round-trips through the quad)', () => {
    const off = roamMoveOffset(ROAM_IDENTITY, geo, geo.unit.w / 2, -geo.unit.h)
    near(off.offsetX, 0.5); near(off.offsetY, -1)
  })

  it('scale follows the ratio of distances from the centre, bounded', () => {
    near(roamScaleFromDrag(1, 40, 80), 2)
    near(roamScaleFromDrag(2, 80, 40), 1)
    expect(roamScaleFromDrag(1, 1, 1e6)).toBe(16)
  })

  it('the angle accumulator keeps counting past the seam', () => {
    const acc = createAngleAccumulator(Math.PI - 0.1, 350)
    const deg = acc.update(-Math.PI + 0.1)                  // crossed the +/-180 seam going clockwise
    near(deg, 350 + (0.2 * 180) / Math.PI, 1e-6)
  })
})

describe('units and layout helpers', () => {
  it('cells <-> pixels round-trip', () => {
    expect(cellsToDisplay(0.5, 'Cells', 640)).toBe(0.5)
    expect(cellsToDisplay(0.5, 'Pixels', 640)).toBe(320)
    expect(displayToCells(320, 'Pixels', 640)).toBe(0.5)
    expect(displayToCells(0.5, 'Cells', 640)).toBe(0.5)
  })

  it('containRect letterboxes to the aspect', () => {
    const r = containRect(400, 400, 2)
    expect(r).toEqual({ x: 0, y: 100, w: 400, h: 200 })
  })
})

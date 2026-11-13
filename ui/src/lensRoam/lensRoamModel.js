// Lens + Roam: the renderer-side geometry (docs/XLETH_LENS_ROAM_SPEC.md, P4).
//
// Pure arithmetic, no React, no IPC. This is a port of the engine's evaluator
// (engine/src/render/LensRoamMath.h and the cell-rect steps in
// GridCompositor::compositeFrame) used ONLY to draw and hit-test the editing
// handles. The engine stays the one evaluator of what is rendered; if the two
// ever disagree the picture is right and the handle is wrong, which is why the
// geometry here is derived by pushing the cell's corners through the very same
// maps instead of by closed-form shortcuts.
//
// Conventions (as the engine)
//   * Rotation is in degrees, positive = CLOCKWISE on screen (V grows down).
//   * Lens: cell-local UV -> source UV. The framing box is the cell's four
//     corners pushed through that map.
//   * Roam: a rect in canvas-UV (the authoring canvas), rotated about its
//     centre in true PIXEL space so a rotated cell is never sheared.

export const GRID_SUBUNITS = 8

export const LENS_FITS = ['Stretch', 'Cover', 'Contain']
export const LENS_FLIPS = ['FollowTrack', 'None', 'Horizontal', 'Vertical']
export const ROAM_BOUNDS = ['Clip', 'Float']
export const ROAM_LAYERS = ['GridOrder', 'AboveNeighbours', 'Top']

export const LENS_IDENTITY = Object.freeze({
  fit: 'Stretch', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack',
})
export const ROAM_IDENTITY = Object.freeze({
  offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder',
})

// The engine clamps zoom and scale to this range; the UI never offers more.
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 16
export const SCALE_MIN = 0.05
export const SCALE_MAX = 16
export const ROTATION_RANGE = 360
export const OFFSET_RANGE_CELLS = 4

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const DEG = Math.PI / 180

export const lensEquals = (a, b) => LENS_KEYS.every((k) => a?.[k] === b?.[k])
export const roamEquals = (a, b) => ROAM_KEYS.every((k) => a?.[k] === b?.[k])
const LENS_KEYS = ['fit', 'centerX', 'centerY', 'zoom', 'rotationDeg', 'flip']
const ROAM_KEYS = ['offsetX', 'offsetY', 'scale', 'rotationDeg', 'bounds', 'layer']

/** True when nothing but fit differs from neutral: the framing is untouched. */
export function lensIsNeutral(lens) {
  return !!lens && lens.centerX === 0.5 && lens.centerY === 0.5
    && lens.zoom === 1 && lens.rotationDeg === 0 && lens.flip === 'FollowTrack'
}

export function roamIsIdentity(roam) {
  return !!roam && roamEquals(roam, ROAM_IDENTITY)
}

// ── Lens ─────────────────────────────────────────────────────────────────────

/**
 * Cell-local UV -> source UV (LensRoamMath.h computeLensUvMap).
 *   sample = m00*u + m01*v + tx,  m10*u + m11*v + ty
 * Only the RATIOS of cellW:cellH and srcW:srcH matter.
 */
export function lensUvMap(lens, cellW, cellH, srcW, srcH) {
  const m = { m00: 1, m01: 0, tx: 0, m10: 0, m11: 1, ty: 0 }
  if (!(cellW > 0) || !(cellH > 0)) return m
  if (!(srcW > 0) || !(srcH > 0)) { srcW = cellW; srcH = cellH }

  let sw = cellW
  let sh = cellH
  if (lens.fit === 'Cover' || lens.fit === 'Contain') {
    const kx = cellW / srcW
    const ky = cellH / srcH
    const k = lens.fit === 'Cover' ? Math.max(kx, ky) : Math.min(kx, ky)
    sw = srcW * k
    sh = srcH * k
  }

  const z = clamp(Number.isFinite(lens.zoom) ? lens.zoom : 1, 1e-3, 1e3)
  const th = (Number.isFinite(lens.rotationDeg) ? lens.rotationDeg : 0) * DEG
  const c = Math.cos(th)
  const s = Math.sin(th)

  const a00 = (c * cellW) / (z * sw)
  const a01 = (s * cellH) / (z * sw)
  const a10 = (-s * cellW) / (z * sh)
  const a11 = (c * cellH) / (z * sh)
  const cx = Number.isFinite(lens.centerX) ? lens.centerX : 0.5
  const cy = Number.isFinite(lens.centerY) ? lens.centerY : 0.5
  m.m00 = a00
  m.m01 = a01
  m.m10 = a10
  m.m11 = a11
  m.tx = cx - 0.5 * (a00 + a01)
  m.ty = cy - 0.5 * (a10 + a11)
  return m
}

export function applyUvMap(m, u, v) {
  return { x: m.m00 * u + m.m01 * v + m.tx, y: m.m10 * u + m.m11 * v + m.ty }
}

/**
 * The framing box: where the cell's four corners (TL, TR, BR, BL) land on the
 * source, in source UV. At zoom 1 under Cover this is the part of the source
 * the cell shows; under Contain it overshoots the source (the letterbox); under
 * Stretch it is the whole source (the picture is stretched, so the box takes the
 * source's own shape, not the cell's).
 */
export function lensBoxCorners(lens, cellAspect, srcAspect) {
  const m = lensUvMap(lens, cellAspect, 1, srcAspect, 1)
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => applyUvMap(m, u, v))
}

/** Is a source-UV point inside the framing box (rotation included)? */
export function lensBoxContains(lens, cellAspect, srcAspect, x, y) {
  const m = lensUvMap(lens, cellAspect, 1, srcAspect, 1)
  const det = m.m00 * m.m11 - m.m01 * m.m10
  if (!det) return false
  // Invert sample = M * local + t.
  const dx = x - m.tx
  const dy = y - m.ty
  const u = (m.m11 * dx - m.m01 * dy) / det
  const v = (-m.m10 * dx + m.m00 * dy) / det
  return u >= 0 && u <= 1 && v >= 0 && v <= 1
}

/** A drag inside the box: the box follows the pointer, so the centre moves with it. */
export function lensMoveCenter(start, dxUv, dyUv) {
  return {
    centerX: clamp(start.centerX + dxUv, 0, 1),
    centerY: clamp(start.centerY + dyUv, 0, 1),
  }
}

/**
 * A drag on a corner handle: zoom about the box centre. The box shrinks as the
 * zoom grows, so pulling a corner OUT zooms out. Distances are in any one
 * consistent pixel space.
 */
export function lensZoomFromDrag(startZoom, startDist, nowDist) {
  if (!(startDist > 1e-6) || !(nowDist > 1e-6)) return startZoom
  return clamp(startZoom * (startDist / nowDist), ZOOM_MIN, ZOOM_MAX)
}

// ── Grid geometry (shared by the Roam inspector and the viewer overlay) ──────

/**
 * Where a track's cell sits, in canvas-UV, the way GridCompositor computes it.
 *
 *   unit   one Roam cell: the placement BEFORE the gap (a half-grid span is
 *          half a cell); a fullscreen layer's unit is the whole canvas.
 *   home   the cell after the gap, which is what Roam moves and Lens frames.
 *   aspect the home cell's pixel aspect (Lens keeps this in every fit).
 *   cellPx one Roam unit in project-canvas pixels (the "Pixels" display).
 *
 * `layout` is getGridLayout(); `track` supplies its gapScaleOverride. Returns
 * null when the track has no cell (not placed on the grid or as a layer).
 */
export function cellGeometry(layout, track) {
  if (!layout || !track) return null
  const canvasW = layout.canvasWidth > 0 ? layout.canvasWidth : 1920
  const canvasH = layout.canvasHeight > 0 ? layout.canvasHeight : 1080
  const cols = Math.max(1, layout.columns ?? 1)
  const rows = Math.max(1, layout.rows ?? 1)

  const slot = (layout.slots ?? []).find((s) => s.trackId === track.id)
  const layer = slot ? null : (layout.fullscreenLayers ?? []).find((l) => l.trackId === track.id)
  if (!slot && !layer) return null

  let x = 0, y = 0, w = 1, h = 1
  if (slot) {
    const fx = cols * GRID_SUBUNITS
    const fy = rows * GRID_SUBUNITS
    x = slot.gridX / fx
    y = slot.gridY / fy
    w = Math.max(1, slot.spanX) / fx
    h = Math.max(1, slot.spanY) / fy
  }
  const unit = { w, h }

  // The gap is the space BETWEEN grid cells; a fullscreen layer has none.
  const override = Number.isFinite(track.gapScaleOverride) ? track.gapScaleOverride : -1
  const gap = override >= 0 ? override : (layout.gapScale ?? 0)
  let home = { x, y, w, h }
  if (slot && gap > 0) {
    const sx = w * gap * 0.5
    const sy = h * gap * 0.5
    home = { x: x + sx, y: y + sy, w: w - 2 * sx, h: h - 2 * sy }
  }
  return {
    canvasW,
    canvasH,
    kind: slot ? 'grid' : 'layer',
    unit,
    home,
    aspect: (home.w * canvasW) / Math.max(1e-6, home.h * canvasH),
    cellPx: { w: unit.w * canvasW, h: unit.h * canvasH },
  }
}

// ── Roam ─────────────────────────────────────────────────────────────────────

/**
 * The moved cell (LensRoamMath.h roamCellRect): offset in cell units, then scale
 * about the cell centre, then rotation about that centre in pixel space.
 *   rect     axis-aligned rect before rotation, canvas-UV
 *   corners  TL, TR, BR, BL after rotation, canvas-UV
 *   center   canvas-UV
 *   rotRad   clockwise
 */
export function roamQuad(roam, geo) {
  const r = { ...ROAM_IDENTITY, ...roam }
  const { home, unit, canvasW, canvasH } = geo
  const ox = Number.isFinite(r.offsetX) ? r.offsetX : 0
  const oy = Number.isFinite(r.offsetY) ? r.offsetY : 0
  const sc = clamp(Number.isFinite(r.scale) ? r.scale : 1, 1e-3, 1e3)

  const cx = home.x + ox * unit.w + home.w * 0.5
  const cy = home.y + oy * unit.h + home.h * 0.5
  const w = home.w * sc
  const h = home.h * sc
  const rect = { x: cx - w / 2, y: cy - h / 2, w, h }
  const rotRad = (Number.isFinite(r.rotationDeg) ? r.rotationDeg : 0) * DEG

  const c = Math.cos(rotRad)
  const s = Math.sin(rotRad)
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const px = sx * (w / 2) * canvasW
    const py = sy * (h / 2) * canvasH
    return {
      x: cx + (c * px - s * py) / canvasW,
      y: cy + (s * px + c * py) / canvasH,
    }
  })
  return { rect, corners, center: { x: cx, y: cy }, rotRad }
}

/** The home cell as an unrotated rect's corners, TL TR BR BL, canvas-UV. */
export function homeCorners(geo) {
  const { x, y, w, h } = geo.home
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
}

/** Is a canvas-UV point inside the (possibly rotated) moved cell? */
export function roamContains(roam, geo, u, v) {
  const q = roamQuad(roam, geo)
  const dx = (u - q.center.x) * geo.canvasW
  const dy = (v - q.center.y) * geo.canvasH
  const c = Math.cos(-q.rotRad)
  const s = Math.sin(-q.rotRad)
  const lx = c * dx - s * dy
  const ly = s * dx + c * dy
  return Math.abs(lx) <= (q.rect.w * geo.canvasW) / 2 && Math.abs(ly) <= (q.rect.h * geo.canvasH) / 2
}

/** Offset after moving the cell by (du, dv) in canvas-UV from `start`. */
export function roamMoveOffset(start, geo, du, dv) {
  return {
    offsetX: start.offsetX + du / geo.unit.w,
    offsetY: start.offsetY + dv / geo.unit.h,
  }
}

/** Scale after dragging a corner: ratio of pointer distances from the cell centre. */
export function roamScaleFromDrag(startScale, startDist, nowDist) {
  if (!(startDist > 1e-6) || !(nowDist > 1e-6)) return startScale
  return clamp(startScale * (nowDist / startDist), SCALE_MIN, SCALE_MAX)
}

/**
 * Sums short-arc angle deltas so a sweep past the seam keeps counting
 * (359 -> 361) instead of wrapping. Angles are atan2(dy, dx) in screen space,
 * which grows clockwise: the same sense as Roam's rotationDeg.
 */
export function createAngleAccumulator(startRad, startDeg) {
  let prev = startRad
  let sweep = 0
  const shortest = (a, b) => {
    let d = b - a
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    return d
  }
  return {
    update(rad) {
      sweep += shortest(prev, rad)
      prev = rad
      return startDeg + sweep / DEG
    },
  }
}

// ── Units (Roam offset display only; stored in cells) ────────────────────────

export function cellsToDisplay(cells, units, cellPxSize) {
  return units === 'Pixels' ? cells * cellPxSize : cells
}

export function displayToCells(value, units, cellPxSize) {
  return units === 'Pixels' ? value / Math.max(1e-6, cellPxSize) : value
}

// ── Draw-time helpers ────────────────────────────────────────────────────────

/** Largest rect of `aspect` that fits (contain) in w x h, centred. */
export function containRect(w, h, aspect) {
  if (!(w > 0) || !(h > 0) || !(aspect > 0)) return { x: 0, y: 0, w: Math.max(0, w), h: Math.max(0, h) }
  let rw = w
  let rh = rw / aspect
  if (rh > h) { rh = h; rw = rh * aspect }
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh }
}

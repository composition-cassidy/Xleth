// Masks on the viewer overlay (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5, R4, R11, R14, R15).
//
// Pure arithmetic, no React, no IPC: where a track's masks sit on screen, what is
// under the pointer, and the new mask list each gesture produces. The overlay
// (RoamOverlayCanvas) keeps the gesture's draft locally and sends the result as
// ONE setTrackMasks on pointerup.
//
// Space (R11): a mask point is in normalized CELL space, origin at the centre of
// the DRAWN cell (home, then Roam, then the parent chain), x in [-0.5, 0.5] across
// its width, y down its height. The drawn cell is a pose { center, rect, rotRad }
// (roamQuad / parentModel.composePose), so cell -> canvas-UV scales by the cell's
// size in canvas pixels, rotates (clockwise, y down) and adds the centre; the
// overlay then maps canvas-UV to its own pixels through the picture rect. Every map
// is affine, so a bezier's control points map exactly.
//
// Gestures (the active mask is the one Motion view selected):
//   Rectangle / Ellipse  drag inside = move; a box corner = resize (Shift keeps the
//                        aspect); a single-point edit makes it a Path (R14)
//   Path                 drag a point; drag a curve handle (the opposite handle
//                        follows while the pair is smooth, Alt moves this one only);
//                        Ctrl+click an edge adds a point; Alt+click a point deletes
//                        it (not below 3); Alt+drag a point pulls out its handles
//   animated shape       every edit writes a shape key at the playhead (R4)
//   pen                  click = corner point, click-drag = smooth point, click the
//                        first point or Enter = close, Escape = cancel

import { LIMITS } from '../../motion/schema.js'
import {
  addMaskBlocker, deleteVertexAll, deleteVertexBlocker, edgePoint, evaluateMask, flattenShape, fromWireList,
  insertVertexAll, insertVertexBlocker, isShapeAnimated, makeMask, maskVertexTotal, nearestEdge,
  nextMaskId, shapeBounds, upsertShapeKey, windingNumber,
} from '../../motion/maskModel.js'

/** Pointer reach of a handle, px. */
export const MASK_HIT_PX = 8
/** How far the box handles of a Rectangle / Ellipse sit outside its points, px (so a corner point stays reachable). */
export const BOX_PAD_PX = 9
/** Movement before an Alt+press on a point becomes a handle pull instead of a delete, px. */
export const ALT_DRAG_PX = 3
/** Movement before a pen press becomes a smooth point, px. */
export const PEN_DRAG_PX = 3
/** Smallest box a resize leaves, in cell units. */
export const MIN_BOX = 0.002
/** Two handles are one smooth pair while they point apart within this angle (radians). */
const PAIR_RAD = 2 * (Math.PI / 180)

const EPS = 1e-9

// ── Cell space <-> screen ────────────────────────────────────────────────────

/**
 * The map from cell space to the overlay's pixels for one drawn cell.
 *   pose  { center, rect: { w, h }, rotRad } in canvas-UV (roamQuad / composePose)
 *   geo   { canvasW, canvasH } (cellGeometry)
 *   pic   the picture rect in overlay pixels { x, y, w, h }
 * Returns { toPx([x, y]) -> {x, y}, toCell({x, y}) -> [x, y], cellPx: {w, h} (the
 * drawn cell in overlay px before rotation), ax / ay (the cell's x / y axes on
 * screen, unit vectors), rot }.
 */
export function maskView(pose, geo, pic) {
  const W = geo.canvasW
  const H = geo.canvasH
  const cw = pose.rect.w * W          // the drawn cell, canvas px
  const ch = pose.rect.h * H
  const rot = pose.rotRad
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const sx = pic.w / W                // canvas px -> overlay px
  const sy = pic.h / H
  const toUv = ([x, y]) => {
    const px = x * cw
    const py = y * ch
    return { x: pose.center.x + (c * px - s * py) / W, y: pose.center.y + (s * px + c * py) / H }
  }
  const fromUv = (u, v) => {
    const dx = (u - pose.center.x) * W
    const dy = (v - pose.center.y) * H
    const lx = c * dx + s * dy
    const ly = -s * dx + c * dy
    return [cw > EPS ? lx / cw : 0, ch > EPS ? ly / ch : 0]
  }
  return {
    rot,
    cellPx: { w: cw * sx, h: ch * sy },
    ax: { x: c, y: s },
    ay: { x: -s, y: c },
    toUv,
    fromUv,
    toPx: (p) => {
      const uv = toUv(p)
      return { x: pic.x + uv.x * pic.w, y: pic.y + uv.y * pic.h }
    },
    toCell: (p) => fromUv((p.x - pic.x) / pic.w, (p.y - pic.y) / pic.h),
  }
}

// ── What is drawn for one mask ───────────────────────────────────────────────

/** The bezier segments of a closed shape in px: [{ a, c1, c2, b }] (one per edge). */
export function shapeSegmentsPx(view, vertices) {
  const n = vertices.length
  const out = []
  for (let i = 0; i < n; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    out.push({
      a: view.toPx([a[0], a[1]]),
      c1: view.toPx([a[0] + a[4], a[1] + a[5]]),
      c2: view.toPx([b[0] + b[2], b[1] + b[3]]),
      b: view.toPx([b[0], b[1]]),
    })
  }
  return out
}

/** Does a vertex have a usable handle on that side? */
const hasHandle = (v, side) => (side === 'in' ? Math.hypot(v[2], v[3]) : Math.hypot(v[4], v[5])) > EPS

/**
 * The handles of the ACTIVE mask, in px:
 *   points   [{ i, x, y }]
 *   tangents [{ i, side: 'in'|'out', x, y, from: {x, y} }]  (Path masks, non-zero handles)
 *   box      [{ corner: 0..3, x, y }] TL TR BR BL, padded outward (Rectangle / Ellipse)
 *   boxCell  the unpadded box in cell space { x, y, w, h } (Rectangle / Ellipse)
 */
export function maskHandles(view, mask, vertices) {
  const points = vertices.map((v, i) => ({ i, ...view.toPx([v[0], v[1]]) }))
  const tangents = []
  if (mask.kind === 'Path') {
    vertices.forEach((v, i) => {
      const from = points[i]
      if (hasHandle(v, 'in')) tangents.push({ i, side: 'in', ...view.toPx([v[0] + v[2], v[1] + v[3]]), from })
      if (hasHandle(v, 'out')) tangents.push({ i, side: 'out', ...view.toPx([v[0] + v[4], v[1] + v[5]]), from })
    })
  }
  let box = []
  let boxCell = null
  if (mask.kind !== 'Path') {
    boxCell = shapeBounds({ vertices })
    const { x, y, w, h } = boxCell
    const cells = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    const sgn = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    box = cells.map((p, corner) => {
      const q = view.toPx(p)
      const [kx, ky] = sgn[corner]
      return {
        corner,
        x: q.x + BOX_PAD_PX * (kx * view.ax.x + ky * view.ay.x),
        y: q.y + BOX_PAD_PX * (kx * view.ax.y + ky * view.ay.y),
      }
    })
  }
  return { points, tangents, box, boxCell }
}

/** The shape as a polygon in px (for inside tests). */
export function shapePolygonPx(view, vertices) {
  return flattenShape({ vertices }).map(([x, y]) => {
    const p = view.toPx([x, y])
    return [p.x, p.y]
  })
}

/** Is a px point inside the shape (nonzero winding, as the engine fills it)? */
export function insideShape(view, vertices, p) {
  return windingNumber(shapePolygonPx(view, vertices), p.x, p.y) !== 0
}

/** The nearest edge to a px point: { edgeIndex, t, distance (px) }. */
export function nearestEdgePx(view, vertices, p) {
  const [x, y] = view.toCell(p)
  // Distances are measured in screen px: the cell's size in px weights each axis
  // (rotation does not change a distance).
  return nearestEdge({ vertices }, x, y, { cellPx: view.cellPx, samples: 48 })
}

// ── Hit testing ──────────────────────────────────────────────────────────────

const near = (p, q, r) => Math.hypot(p.x - q.x, p.y - q.y) <= r

/**
 * The active mask's handle under `p` (px), nearest first: a point, a curve handle,
 * a box corner, and with Ctrl an edge (add a point). null when none is in reach.
 *   { kind: 'maskPoint', index, i } | { kind: 'maskTangent', index, i, side }
 *   | { kind: 'maskBox', index, corner } | { kind: 'maskEdge', index, edgeIndex, t }
 */
export function hitActiveMask(view, mask, index, vertices, p, { ctrl = false, reach = MASK_HIT_PX } = {}) {
  if (!mask) return null
  const h = maskHandles(view, mask, vertices)
  let best = null
  let bestD = reach
  const consider = (q, hit) => {
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d <= bestD) { bestD = d; best = hit }
  }
  for (const q of h.points) consider(q, { kind: 'maskPoint', index, i: q.i })
  for (const q of h.tangents) consider(q, { kind: 'maskTangent', index, i: q.i, side: q.side })
  for (const q of h.box) consider(q, { kind: 'maskBox', index, corner: q.corner })
  if (best) return best
  if (ctrl) {
    const e = nearestEdgePx(view, vertices, p)
    if (e.edgeIndex >= 0 && e.distance <= reach) return { kind: 'maskEdge', index, edgeIndex: e.edgeIndex, t: e.t }
  }
  return null
}

/**
 * The lower-priority mask hits (after the Roam handles): an inactive mask's edge
 * selects it; inside the active mask moves it.
 *   frames  [{ mask, vertices }] for every shown mask, top to bottom
 * Returns { kind: 'maskSelect', index } | { kind: 'maskInside', index } | null.
 */
export function hitMaskBodies(view, frames, activeIndex, p, { reach = MASK_HIT_PX } = {}) {
  for (let k = frames.length - 1; k >= 0; k--) {
    if (k === activeIndex) continue
    const e = nearestEdgePx(view, frames[k].vertices, p)
    if (e.edgeIndex >= 0 && e.distance <= reach) return { kind: 'maskSelect', index: k }
  }
  if (activeIndex >= 0 && frames[activeIndex] && insideShape(view, frames[activeIndex].vertices, p)) {
    return { kind: 'maskInside', index: activeIndex }
  }
  return null
}

// ── Shape edits (vertex lists in, vertex lists out) ─────────────────────────

const copyVs = (vs) => vs.map((v) => [v[0], v[1], v[2], v[3], v[4], v[5]])

/** Every point moved by (dx, dy) cell units (handles are relative, so they ride along). */
export function translateVertices(vertices, dx, dy) {
  return vertices.map((v) => [v[0] + dx, v[1] + dy, v[2], v[3], v[4], v[5]])
}

/** Point i moved by (dx, dy). */
export function moveVertex(vertices, i, dx, dy) {
  const out = copyVs(vertices)
  out[i][0] += dx
  out[i][1] += dy
  return out
}

/** Are a point's two handles one smooth pair (pointing apart, both non-zero)? */
export function isSmoothPair(v) {
  const a = Math.hypot(v[2], v[3])
  const b = Math.hypot(v[4], v[5])
  if (a <= EPS || b <= EPS) return false
  const cos = -(v[2] * v[4] + v[3] * v[5]) / (a * b)
  return cos >= Math.cos(PAIR_RAD)
}

/**
 * Point i's `side` handle set to `rel` (relative to the point, cell units). While
 * the pair was smooth at the gesture's start (`smooth`) and Alt is not held, the
 * opposite handle turns to stay opposite, keeping its own length; otherwise it is
 * left alone (Alt breaks the pair).
 *   start  the point as it was when the gesture began
 */
export function setTangent(vertices, i, side, rel, { start, smooth = false, breakPair = false } = {}) {
  const out = copyVs(vertices)
  const v = out[i]
  const s = start ?? vertices[i]
  if (side === 'in') { v[2] = rel[0]; v[3] = rel[1] } else { v[4] = rel[0]; v[5] = rel[1] }
  if (smooth && !breakPair) {
    const len = side === 'in' ? Math.hypot(s[4], s[5]) : Math.hypot(s[2], s[3])
    const r = Math.hypot(rel[0], rel[1])
    if (r > EPS) {
      const ox = (-rel[0] / r) * len
      const oy = (-rel[1] / r) * len
      if (side === 'in') { v[4] = ox; v[5] = oy } else { v[2] = ox; v[3] = oy }
    }
  }
  return out
}

/** Point i made smooth with out = rel and in = -rel (Alt+drag on a point, the pen's drag). */
export function pullHandles(vertices, i, rel) {
  const out = copyVs(vertices)
  out[i][2] = -rel[0]
  out[i][3] = -rel[1]
  out[i][4] = rel[0]
  out[i][5] = rel[1]
  return out
}

/**
 * Resize a Rectangle / Ellipse by its box: `corner` (0 TL, 1 TR, 2 BR, 3 BL) of
 * `box0` (cell units) is dragged by (dx, dy) while the opposite corner stays put.
 * Shift (keepAspect) scales both axes by the same factor. The box never flips or
 * collapses (MIN_BOX). Every point and handle scales about the fixed corner.
 */
export function resizeByBox(vertices, box0, corner, dx, dy, { keepAspect = false } = {}) {
  const right = corner === 1 || corner === 2
  const bottom = corner === 2 || corner === 3
  const ax = right ? box0.x : box0.x + box0.w           // the fixed corner
  const ay = bottom ? box0.y : box0.y + box0.h
  const w0 = Math.max(box0.w, MIN_BOX)
  const h0 = Math.max(box0.h, MIN_BOX)
  let fx = Math.max(MIN_BOX, w0 + (right ? dx : -dx)) / w0
  let fy = Math.max(MIN_BOX, h0 + (bottom ? dy : -dy)) / h0
  if (keepAspect) {
    // The axis pulled further wins; neither side may fall under the smallest box.
    const f = Math.max(Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy, MIN_BOX / w0, MIN_BOX / h0)
    fx = f
    fy = f
  }
  // A collapsed axis (an ellipse squashed to a line) grows from its points' spread, not from zero.
  const sx = box0.w > EPS ? fx : 1
  const sy = box0.h > EPS ? fy : 1
  return vertices.map((v) => [
    ax + (v[0] - ax) * sx, ay + (v[1] - ay) * sy, v[2] * sx, v[3] * sy, v[4] * sx, v[5] * sy,
  ])
}

// ── Writing an edit back (R4, R14) ───────────────────────────────────────────

/**
 * masks with masks[index]'s shape at `tick` set to `vertices`: an animated shape
 * gets a shape key at the playhead (upsert), a still one a new base shape.
 * `toPath` (a single-point edit) makes a Rectangle / Ellipse a Path.
 */
export function writeShape(masks, index, tick, vertices, { toPath = false } = {}) {
  const m = masks[index]
  let next = isShapeAnimated(m)
    ? upsertShapeKey(m, tick, vertices)
    : { ...m, base: { ...m.base, shape: { closed: true, vertices: copyVs(vertices) } } }
  if (toPath && next.kind !== 'Path') next = { ...next, kind: 'Path' }
  return masks.map((x, k) => (k === index ? next : x))
}

/**
 * Add a point on edge `edgeIndex` at t of masks[index], in its base and every shape
 * key (R14). { masks, i (the new point's index) } or { error } at a cap.
 */
export function insertPoint(masks, index, edgeIndex, t) {
  const blocker = insertVertexBlocker(masks, index)
  if (blocker) return { error: blocker }
  const m = insertVertexAll(masks[index], edgeIndex, t)
  if (!m) return { error: `A mask holds at most ${LIMITS.maxVerticesPerMask} points` }
  return { masks: masks.map((x, k) => (k === index ? m : x)), i: edgeIndex + 1 }
}

/** Delete point i of masks[index] everywhere (R14). { masks } or { error } below 3 points. */
export function deletePoint(masks, index, i) {
  const blocker = deleteVertexBlocker(masks[index])
  if (blocker) return { error: blocker }
  const m = deleteVertexAll(masks[index], i)
  if (!m) return { error: `A mask needs at least ${LIMITS.minVerticesPerMask} points` }
  return { masks: masks.map((x, k) => (k === index ? m : x)) }
}

/** The evaluated shape of every mask at a tick: [{ mask, vertices }]. */
export const maskFramesAt = (masks, tick) => (masks ?? []).map((mask) => ({ mask, vertices: evaluateMask(mask, tick).vertices }))

/** Two mask lists equal as data (the gesture sends nothing when they are). */
export const sameMasks = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

// ── The pen (Add mask > Path) ────────────────────────────────────────────────

/** How many points the pen may place on this track (the per-mask and per-track caps). */
export function penPointCap(masks) {
  return Math.max(0, Math.min(LIMITS.maxVerticesPerMask, LIMITS.maxMaskVerticesPerTrack - maskVertexTotal(masks)))
}

/** Why the pen cannot start a new mask on this track, or null. */
export const penBlocker = (masks) => addMaskBlocker(masks, { kind: 'Path', vertexCount: LIMITS.minVerticesPerMask })

/** A fresh pen: no points yet. */
export const penStart = () => ({ points: [], dragging: -1 })

/** A press: a new corner point at `cell` ([x, y]); it becomes smooth if the press drags. */
export function penAddPoint(pen, cell) {
  return { points: [...pen.points, [cell[0], cell[1], 0, 0, 0, 0]], dragging: pen.points.length }
}

/** The press is dragging: the point being placed gets out = drag, in = -drag (smooth). */
export function penDragPoint(pen, cell) {
  const i = pen.dragging
  if (i < 0) return pen
  const v = pen.points[i]
  return { ...pen, points: pullHandles(pen.points, i, [cell[0] - v[0], cell[1] - v[1]]) }
}

/** The press ended. */
export const penRelease = (pen) => ({ ...pen, dragging: -1 })

/** The last point taken off (Backspace). */
export const penUndoPoint = (pen) => ({ points: pen.points.slice(0, -1), dragging: -1 })

/** Can the path close (enough points)? */
export const penCanClose = (pen) => pen.points.length >= LIMITS.minVerticesPerMask

/**
 * Close the pen's path into a new Path mask at the end of the list:
 * { masks, mask } or { error } (too few points, or a cap).
 */
export function penCreateMask(masks, pen) {
  const list = masks ?? []
  const n = pen.points.length
  if (n < LIMITS.minVerticesPerMask) return { error: `A mask needs at least ${LIMITS.minVerticesPerMask} points` }
  const blocker = addMaskBlocker(list, { kind: 'Path', vertexCount: n })
  if (blocker) return { error: blocker }
  if (n > LIMITS.maxVerticesPerMask) return { error: `A mask holds at most ${LIMITS.maxVerticesPerMask} points` }
  const id = nextMaskId(list)
  const mask = makeMask('Path', id, `Mask ${id}`, { shape: { closed: true, vertices: copyVs(pen.points) } })
  return { masks: [...list, mask], mask }
}

/** The px point of the edge parameter (where a Ctrl+click would add a point). */
export function edgePointPx(view, vertices, edgeIndex, t) {
  return view.toPx(edgePoint(vertices, edgeIndex, t))
}

/**
 * The Mask list a resolved commit (setTrackMasks / runMotionPlan's result) leaves on
 * `trackId`, in maskModel form as useRoamValue adopts it; null when the answer is for
 * another track or carries no list (nothing to adopt).
 */
export function committedMasks(res, trackId) {
  if (!res || !Array.isArray(res.masks)) return null
  if (res.trackId != null && res.trackId !== trackId) return null
  return fromWireList(res.masks)
}

export { near as nearPx }

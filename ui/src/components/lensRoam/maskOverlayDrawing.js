// Masks and the pen on the viewer overlay: the canvas painter (5.5, 5.7).
//
// Imperative and allocation-light: RoamOverlayCanvas calls these from its drawNow
// (React changes, the frame clock while something is animated, and the gesture's
// rAF), never through React state. Colours come from the cached overlay palette.
//
// Reading the picture:
//   * every shown mask: its outline over a dark keyline; Add solid, Subtract
//     dashed, Intersect dotted (the mode is also named on the active mask's label)
//   * the active mask: the selection accent, its points (round), its curve handles
//     (Path) and, for a Rectangle / Ellipse, a dashed box with hollow corner squares
//   * the pen: the points placed so far, the path between them, a dashed rubber
//     band to the pointer, and a ring on the first point when a click would close

import { MASK_HIT_PX, maskHandles, shapeSegmentsPx } from './maskOverlay.js'
import { isShapeAnimated } from '../../motion/maskModel.js'
import { uiCanvasFont } from '../../styles/typography.js'

const POINT_R = 3.5
const TANGENT_R = 2.75
const BOX_HALF = 4

const DASH_OF = { Add: [], Subtract: [6, 3], Intersect: [2, 3] }

function traceSegments(ctx, segs, close = true) {
  ctx.beginPath()
  segs.forEach((s, k) => {
    if (k === 0) ctx.moveTo(s.a.x, s.a.y)
    ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.b.x, s.b.y)
  })
  if (close) ctx.closePath()
}

const sameHit = (h, kind, extra) => !!h && h.kind === kind && Object.entries(extra).every(([k, v]) => h[k] === v)

/** The words on the active mask's label chip. */
export function maskLabelText(mask) {
  const parts = [mask.name, mask.base?.mode ?? 'Add']
  if (mask.base?.invert) parts.push('inverted')
  if (isShapeAnimated(mask)) parts.push('shape keyed')
  return parts.join(' · ')
}

function drawChip(ctx, palette, text, x, y) {
  ctx.font = uiCanvasFont('10px')
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const w = Math.ceil(ctx.measureText(text).width) + 8
  ctx.fillStyle = palette.g0
  ctx.fillRect(x, y - 7, w, 14)
  ctx.fillStyle = palette.ink
  ctx.fillText(text, x + 4, y)
}

/**
 * Every shown mask of the cell, the active one with its handles.
 *   frames       [{ mask, vertices }] top to bottom (vertices at the playhead or the draft)
 *   activeIndex  the active mask's index in frames, or -1
 *   hover        the hit under the pointer (maskOverlay hit objects) or null
 */
export function drawMasks(ctx, view, frames, activeIndex, hover, palette) {
  frames.forEach(({ mask, vertices }, k) => {
    if (k === activeIndex) return
    const segs = shapeSegmentsPx(view, vertices)
    const lit = sameHit(hover, 'maskSelect', { index: k })
    ctx.setLineDash(DASH_OF[mask.base?.mode] ?? [])
    traceSegments(ctx, segs)
    ctx.lineWidth = 2.5
    ctx.strokeStyle = palette.g0
    ctx.stroke()
    traceSegments(ctx, segs)
    ctx.lineWidth = lit ? 1.5 : 1
    ctx.strokeStyle = lit ? palette.ink : palette.ink2
    ctx.stroke()
    ctx.setLineDash([])
  })

  const act = activeIndex >= 0 ? frames[activeIndex] : null
  if (!act) return
  const { mask, vertices } = act
  const segs = shapeSegmentsPx(view, vertices)
  ctx.setLineDash(DASH_OF[mask.base?.mode] ?? [])
  traceSegments(ctx, segs)
  ctx.lineWidth = 3
  ctx.strokeStyle = palette.g0
  ctx.stroke()
  traceSegments(ctx, segs)
  ctx.lineWidth = sameHit(hover, 'maskInside', { index: activeIndex }) ? 2 : 1.5
  ctx.strokeStyle = palette.select
  ctx.stroke()
  ctx.setLineDash([])

  // Ctrl over an edge: where the new point would land.
  if (hover?.kind === 'maskEdge' && hover.index === activeIndex && hover.at) {
    ctx.beginPath()
    ctx.arc(hover.at.x, hover.at.y, POINT_R, 0, Math.PI * 2)
    ctx.fillStyle = palette.ink
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.g0
    ctx.stroke()
  }

  const h = maskHandles(view, mask, vertices)

  // Rectangle / Ellipse: the box, dashed, with hollow corner squares.
  if (h.box.length === 4) {
    ctx.beginPath()
    h.box.forEach((q, k) => (k === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)))
    ctx.closePath()
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.select
    ctx.stroke()
    ctx.setLineDash([])
    for (const q of h.box) {
      const on = sameHit(hover, 'maskBox', { index: activeIndex, corner: q.corner })
      ctx.fillStyle = on ? palette.ink : palette.g0
      ctx.fillRect(q.x - BOX_HALF, q.y - BOX_HALF, BOX_HALF * 2, BOX_HALF * 2)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = palette.select
      ctx.strokeRect(q.x - BOX_HALF, q.y - BOX_HALF, BOX_HALF * 2, BOX_HALF * 2)
    }
  }

  // Path: the curve handles, a thin stem from each point.
  for (const t of h.tangents) {
    ctx.beginPath()
    ctx.moveTo(t.from.x, t.from.y)
    ctx.lineTo(t.x, t.y)
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.select
    ctx.stroke()
    const on = sameHit(hover, 'maskTangent', { index: activeIndex, i: t.i, side: t.side })
    ctx.beginPath()
    ctx.arc(t.x, t.y, on ? TANGENT_R + 1 : TANGENT_R, 0, Math.PI * 2)
    ctx.fillStyle = on ? palette.ink : palette.select
    ctx.fill()
  }

  // The points.
  for (const q of h.points) {
    const on = sameHit(hover, 'maskPoint', { index: activeIndex, i: q.i })
    ctx.beginPath()
    ctx.arc(q.x, q.y, on ? POINT_R + 1 : POINT_R, 0, Math.PI * 2)
    ctx.fillStyle = on ? palette.ink : palette.g0
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = palette.select
    ctx.stroke()
  }

  // The label: above the highest point on screen.
  let top = h.points[0]
  for (const q of h.points) if (q.y < top.y) top = q
  if (top) drawChip(ctx, palette, maskLabelText(mask), top.x + 8, top.y - 14)
}

/**
 * The pen's path in progress.
 *   points  cell-space points placed so far
 *   pointer the pointer in px (the rubber band's end), or null
 *   closing true when a click now would close the path (the first point is lit)
 */
export function drawPen(ctx, view, points, pointer, closing, palette) {
  const n = points.length
  if (n > 0) {
    const px = points.map((v) => view.toPx([v[0], v[1]]))
    if (n > 1) {
      const segs = []
      for (let i = 0; i + 1 < n; i++) {
        const a = points[i]
        const b = points[i + 1]
        segs.push({
          a: px[i],
          c1: view.toPx([a[0] + a[4], a[1] + a[5]]),
          c2: view.toPx([b[0] + b[2], b[1] + b[3]]),
          b: px[i + 1],
        })
      }
      traceSegments(ctx, segs, false)
      ctx.lineWidth = 3
      ctx.strokeStyle = palette.g0
      ctx.stroke()
      traceSegments(ctx, segs, false)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = palette.select
      ctx.stroke()
    }
    if (pointer) {
      const last = px[n - 1]
      ctx.beginPath()
      ctx.moveTo(last.x, last.y)
      ctx.lineTo(pointer.x, pointer.y)
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = palette.value
      ctx.stroke()
      ctx.setLineDash([])
    }
    // Handles of smooth points.
    points.forEach((v) => {
      if (Math.hypot(v[4], v[5]) <= 1e-9) return
      const a = view.toPx([v[0] + v[2], v[1] + v[3]])
      const b = view.toPx([v[0] + v[4], v[1] + v[5]])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineWidth = 1
      ctx.strokeStyle = palette.select
      ctx.stroke()
      for (const q of [a, b]) {
        ctx.beginPath()
        ctx.arc(q.x, q.y, TANGENT_R, 0, Math.PI * 2)
        ctx.fillStyle = palette.select
        ctx.fill()
      }
    })
    px.forEach((q, i) => {
      ctx.beginPath()
      ctx.arc(q.x, q.y, i === 0 && closing ? POINT_R + 2 : POINT_R, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 && closing ? palette.ink : palette.g0
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = palette.select
      ctx.stroke()
    })
    if (closing) {
      ctx.beginPath()
      ctx.arc(px[0].x, px[0].y, MASK_HIT_PX, 0, Math.PI * 2)
      ctx.lineWidth = 1
      ctx.strokeStyle = palette.ink
      ctx.stroke()
    }
  }
}

/** The pen's words in the picture's top-left corner (the mode is said, not only shown). */
export function drawPenBadge(ctx, palette, pic, text) {
  ctx.font = uiCanvasFont('11px')
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const lx = pic.x + 8
  const ly = pic.y + 8
  const lw = Math.ceil(ctx.measureText(text).width) + 12
  ctx.fillStyle = palette.g0
  ctx.fillRect(lx, ly, lw, 18)
  ctx.fillStyle = palette.ink
  ctx.fillText(text, lx + 6, ly + 3)
}

// Motion view graph editor: painter and hit-test of the KEYS layer in graph mode
// (docs/XLETH_MOTION_VIEW_DESIGN.md R21, 5.4). The math is motion/motionGraphModel.js.
//
// Same area, same ruler as the key rows: x is the timeline (shared zoom and scroll),
// y is each curve's own fitted value range over the whole visible height. Up to 8
// curves; colours: the first curve takes its track's identity colour, the rest
// --ui-band-1..4. The FOCUSED curve (the last clicked row) gets value-axis labels
// and grid lines. Keys are drawn by interp glyph (as in the key rows), hollow =
// the hit curve under a note (R5); a selected Bezier key shows the handles of the
// segment leaving it. A gesture's draft (moved ticks, values, handles) is read
// through view.draft, so a drag repaints with no React render and no IPC.

import { bezierHandlePoints, sanitizeBez, segmentEase } from '../../lensRoam/lensKeyModel.js'
import {
  axisValues, buildGraphCurves, formatAsLayer, graphYToValue, noteRunOrder, noteSegmentReached, plotBand, runTimeline,
  valueToGraphY,
} from '../../motion/motionGraphModel.js'
import { formatValue } from '../../motion/schema.js'
import { KEY_HIT_R, KEY_R, keyGlyph, resolveMotionPalette, tickToX, xToTick } from './motionDrawing.js'
import { withAlpha } from '../timeline/timelineDrawing.js'
import { uiCanvasFont } from '../../styles/typography.js'

export const HANDLE_R = 3.5
export const HANDLE_HIT_R = 9
export const GRAPH_EMPTY_TEXT = 'Graph: select animated property rows to see their curves'
const SAMPLE_PX = 2

// ── Curves of the current view (cached per layout, data, row selection) ──────

let cache = { layout: null, data: null, sel: null, curves: [] }

/** The plotted curves of a view: buildGraphCurves, cached until the rows, data or selection change. */
export function graphCurvesOf(view) {
  if (cache.layout === view.layout && cache.data === view.data && cache.sel === view.selectedRows) return cache.curves
  const curves = view.layout && view.data ? buildGraphCurves(view.layout, view.data, view.selectedRows) : []
  cache = { layout: view.layout, data: view.data, sel: view.selectedRows, curves }
  return curves
}

/** Drop the cache (tests). */
export function resetGraphCache() {
  cache = { layout: null, data: null, sel: null, curves: [] }
}

/** The title of a curve: 'Lead · Offset X' (the axis labels belong to it). */
export function curveTitle(curve, data) {
  const name = data?.tracksById?.get(curve.trackId)?.name
  return name ? `${name} · ${curve.prop.label}` : curve.prop.label
}

/** The focused curve: the last clicked row's, else the first. */
export function focusedCurve(curves, focusedRow) {
  return curves.find((c) => c.rowKey === focusedRow) ?? curves[0] ?? null
}

/** The colour of the i-th curve (R21). */
export function curveColor(i, curve, view, p) {
  if (i === 0) return view.colorOf?.(curve.trackId) ?? p.value
  return p.bands[(i - 1) % p.bands.length] ?? p.value
}

/** Draft-aware readers of a key instance. */
export function draftReaders(draft) {
  const ticks = draft?.keyTicks
  const values = draft?.keyValues
  const bez = draft?.bez
  const pos = draft?.keyPos
  return {
    tickOf: (k) => { const t = ticks?.get(k.id); return t === undefined ? k.tick : t },
    posOf: (k) => { const q = pos?.get(k.id); return q === undefined ? k.ref?.pos : q },
    valueOf: (k) => { const v = values?.get(k.id); return v === undefined ? k.value : v },
    easeOf: (k) => { const b = bez?.get(k.id); return b ? { interp: 'Bezier', bez: b } : k },
  }
}

/**
 * A curve's run keys in evaluation order, through a draft (sorted again only while a
 * draft moves them): tick order, or for a note run the engine's canonical order
 * (motionGraphModel.noteRunOrder), which is not drawn order under Cut.
 */
function runKeys(run, draft, rd) {
  if (!draft?.keyTicks || draft.keyTicks.size === 0) return run.keys
  if (run.note) return draft.keyPos?.size ? noteRunOrder(run, run.keys, rd.posOf) : run.keys
  return [...run.keys].sort((a, b) => rd.tickOf(a) - rd.tickOf(b))
}

/** The key that follows `k` in its run (the far end of its Bezier segment), or null. */
export function nextInRun(curve, k, draft = null) {
  const rd = draftReaders(draft)
  for (const run of curve.runs) {
    const keys = runKeys(run, draft, rd)
    const i = keys.indexOf(k)
    if (i >= 0) return i + 1 < keys.length ? keys[i + 1] : null
  }
  return null
}

// ── Painter ──────────────────────────────────────────────────────────────────

function drawRunCurve(ctx, keys, run, view, toY, rd, w) {
  const { scrollOffset, ppb } = view
  const n = keys.length
  if (n === 0) return
  const xStart = Math.max(-1, Number.isFinite(run.start) ? tickToX(run.start, scrollOffset, ppb) : -1)
  const xEnd = Math.min(w + 1, Number.isFinite(run.end) ? tickToX(run.end, scrollOffset, ppb) : w + 1)
  if (xEnd <= xStart) return
  // Timeline / clip runs: time = tick. Note runs: canonical order on CURVE time.
  const { times, at } = runTimeline(run, keys, rd)
  let i = 0
  let first = true
  ctx.beginPath()
  for (let x = xStart; ; x += SAMPLE_PX) {
    const xx = Math.min(x, xEnd)
    const t = at(xToTick(xx, scrollOffset, ppb))
    while (i < n && times[i] <= t) i++
    let v
    if (i === 0) v = rd.valueOf(keys[0])
    else if (i >= n) v = rd.valueOf(keys[n - 1])
    else {
      const a = keys[i - 1]
      const b = keys[i]
      const ta = times[i - 1]
      const tb = times[i]
      const va = rd.valueOf(a)
      const ea = rd.easeOf(a)
      v = ea.interp === 'Hold' || !(tb > ta) ? va : va + (rd.valueOf(b) - va) * segmentEase(ea, (t - ta) / (tb - ta))
    }
    const y = toY(v)
    if (first) { ctx.moveTo(xx, y); first = false } else ctx.lineTo(xx, y)
    if (xx >= xEnd) break
  }
  ctx.stroke()
}

/**
 * The keys layer in graph mode.
 *   view = MotionKeyCanvas.view(): { layout, data, w, h, scrollOffset, ppb, selectedRows,
 *          focusedRow, keySel, draft, colorOf }
 */
export function drawGraphLayer(ctx, view) {
  const p = resolveMotionPalette()
  const { w, h, scrollOffset, ppb } = view
  ctx.clearRect(0, 0, w, h)
  if (!(ppb > 0) || !(w > 0) || !(h > 0)) return
  const curves = graphCurvesOf(view)
  if (curves.length === 0) {
    ctx.fillStyle = p.ink3 || p.summary
    ctx.font = uiCanvasFont('12px')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(GRAPH_EMPTY_TEXT, w / 2, h / 2)
    ctx.textAlign = 'left'
    return
  }
  const band = plotBand(h)
  const rd = draftReaders(view.draft)
  const sel = view.keySel
  const tLo = xToTick(-KEY_R * 2, scrollOffset, ppb)
  const tHi = xToTick(w + KEY_R * 2, scrollOffset, ppb)

  // The focused curve's value axis: faint lines and labels.
  const focus = focusedCurve(curves, view.focusedRow)
  if (focus) {
    ctx.font = uiCanvasFont('11px')
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const layer = formatAsLayer(focus)
    for (const v of axisValues(focus.range)) {
      const y = Math.round(valueToGraphY(focus.range, band, v)) + 0.5
      ctx.fillStyle = withAlpha(p.guide, 0.08)
      ctx.fillRect(0, y - 0.5, w, 1)
      ctx.fillStyle = p.ink3 || p.summary
      ctx.fillText(formatValue(focus.prop, v, { short: true, layer }), 6, y - 7)
    }
    ctx.fillStyle = p.ink3 || p.summary
    ctx.textBaseline = 'top'
    ctx.textAlign = 'right'
    ctx.fillText(curveTitle(focus, view.data), w - 6, 3)
    ctx.textAlign = 'left'
  }

  curves.forEach((curve, ci) => {
    const color = curveColor(ci, curve, view, p)
    const toY = (v) => valueToGraphY(curve.range, band, v)
    const muted = view.mutedOf?.(curve.trackId)
    const alpha = (focus === curve ? 1 : 0.8) * (muted ? 0.5 : 1)
    for (const run of curve.runs) {
      if (run.end < tLo || run.start > tHi) continue
      const keys = runKeys(run, view.draft, rd)
      ctx.globalAlpha = alpha
      ctx.strokeStyle = color
      ctx.lineWidth = focus === curve ? 1.5 : 1.25
      ctx.setLineDash(run.hollow ? [3, 3] : [])
      drawRunCurve(ctx, keys, run, view, toY, rd, w)
      ctx.setLineDash([])
      // Keys.
      for (const k of keys) {
        const t = rd.tickOf(k)
        if (t < tLo || t > tHi) continue
        const x = Math.round(tickToX(t, scrollOffset, ppb)) + 0.5
        const y = Math.round(toY(rd.valueOf(k))) + 0.5
        const selected = sel?.has(k.id)
        const r = selected ? KEY_R + 1 : KEY_R
        ctx.globalAlpha = alpha * (k.outside ? 0.45 : 1)
        keyGlyph(ctx, rd.easeOf(k).interp ?? k.interp, x, y, r)
        if (k.hollow) {
          ctx.fillStyle = p.hollowFill
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = selected ? p.select : color
          ctx.stroke()
        } else {
          ctx.fillStyle = selected ? p.select : color
          ctx.fill()
          ctx.lineWidth = 1
          ctx.strokeStyle = p.keyStroke
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
    }
  })

  // Handles of the selected Bezier keys (the segment leaving each).
  for (const hnd of graphHandles(view, curves, band, rd)) {
    ctx.strokeStyle = withAlpha(p.select, 0.7)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(hnd.pts.from.x, hnd.pts.from.y); ctx.lineTo(hnd.pts.h1.x, hnd.pts.h1.y)
    ctx.moveTo(hnd.pts.to.x, hnd.pts.to.y); ctx.lineTo(hnd.pts.h2.x, hnd.pts.h2.y)
    ctx.stroke()
    ctx.fillStyle = p.select
    for (const q of [hnd.pts.h1, hnd.pts.h2]) {
      ctx.beginPath()
      ctx.arc(q.x, q.y, HANDLE_R, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/**
 * Every visible handle pair: [{ curve, a, b, pts: { from, to, h1, h2 } }] for selected
 * Bezier keys. A key pairs with the key after it in EVALUATION order (a note run's
 * canonical curve order, so under Cut the handles shape the segment the engine plays);
 * a note segment the note never plays (Cut), or one drawn backwards, shows no handles.
 */
export function graphHandles(view, curves = graphCurvesOf(view), band = plotBand(view.h), rd = draftReaders(view.draft)) {
  const out = []
  const sel = view.keySel
  if (!sel || sel.size === 0) return out
  const { scrollOffset, ppb } = view
  for (const curve of curves) {
    const toY = (v) => valueToGraphY(curve.range, band, v)
    for (const run of curve.runs) {
      const keys = runKeys(run, view.draft, rd)
      const times = run.note ? runTimeline(run, keys, rd).times : null
      for (let i = 0; i + 1 < keys.length; i++) {
        const a = keys[i]
        if (!sel.has(a.id) || rd.easeOf(a).interp !== 'Bezier') continue
        const b = keys[i + 1]
        if (times && (!noteSegmentReached(run, times[i], times[i + 1]) || !(rd.tickOf(b) > rd.tickOf(a)))) continue
        const A = { tick: rd.tickOf(a), value: rd.valueOf(a), bez: sanitizeBez(rd.easeOf(a).bez) }
        const B = { tick: rd.tickOf(b), value: rd.valueOf(b) }
        const pts = bezierHandlePoints(A, B, (k) => tickToX(k.tick, scrollOffset, ppb), toY)
        out.push({ curve, a, b, A, B, pts })
      }
    }
  }
  return out
}

// ── Hit-test ─────────────────────────────────────────────────────────────────

/** Where a key instance is drawn: { x, y } (canvas px). */
export function graphKeyPoint(view, curve, k, band = plotBand(view.h), rd = draftReaders(view.draft)) {
  return {
    x: tickToX(rd.tickOf(k), view.scrollOffset, view.ppb),
    y: valueToGraphY(curve.range, band, rd.valueOf(k)),
  }
}

/**
 * What is under (x, y) (canvas px, no scroll): a handle of a selected Bezier key,
 * else the nearest key within KEY_HIT_R (a filled key wins a tie over a hollow one),
 * else empty space.
 *   { kind: 'handle', which: 1 | 2, inst, next, curve, A, B } | { kind: 'key', inst, curve } | { kind: 'empty' } | null (no curves)
 */
export function hitTestGraph(view, x, y) {
  const curves = graphCurvesOf(view)
  if (curves.length === 0) return null
  const band = plotBand(view.h)
  const rd = draftReaders(view.draft)
  for (const hnd of graphHandles(view, curves, band, rd)) {
    for (const which of [1, 2]) {
      const q = which === 1 ? hnd.pts.h1 : hnd.pts.h2
      if (Math.hypot(q.x - x, q.y - y) <= HANDLE_HIT_R) {
        return { kind: 'handle', which, inst: hnd.a, next: hnd.b, curve: hnd.curve, A: hnd.A, B: hnd.B }
      }
    }
  }
  let best = null
  let bestD = Infinity
  for (const curve of curves) {
    for (const run of curve.runs) {
      for (const k of run.keys) {
        const pt = graphKeyPoint(view, curve, k, band, rd)
        const d = Math.hypot(pt.x - x, pt.y - y)
        if (d > KEY_HIT_R) continue
        if (d < bestD || (d === bestD && best?.inst.hollow && !k.hollow)) { best = { kind: 'key', inst: k, curve }; bestD = d }
      }
    }
  }
  return best ?? { kind: 'empty' }
}

/** The keys inside a rectangle of the graph (canvas px, no scroll). */
export function keysInGraphRect(view, rect) {
  const out = []
  const x0 = Math.min(rect.x0, rect.x1)
  const x1 = Math.max(rect.x0, rect.x1)
  const y0 = Math.min(rect.y0, rect.y1)
  const y1 = Math.max(rect.y0, rect.y1)
  const band = plotBand(view.h)
  const rd = draftReaders(null)
  for (const curve of graphCurvesOf(view)) {
    for (const run of curve.runs) {
      for (const k of run.keys) {
        const pt = graphKeyPoint(view, curve, k, band, rd)
        if (pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) out.push(k)
      }
    }
  }
  return out
}

/** The y -> value map of a curve in a view (for a value drag). */
export function curveValueAtY(view, curve, y) {
  return graphYToValue(curve.range, plotBand(view.h), y)
}

/** The value -> y map of a curve in a view. */
export function curveYOfValue(view, curve, v) {
  return valueToGraphY(curve.range, plotBand(view.h), v)
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, NumberBox, SegmentedControl } from '../../ui-kit'
import { backingSize, getDpr, useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  addPoint, editablePoints, hitTestPoint, movePoint, removePoint, sampleCurve, storedPoints,
} from '../../colorGrade/curveMath.js'
import { curveIsIdentity } from '../../colorGrade/gradeModel.js'
import styles from './colorGrade.module.css'

// The Color Grade curves editor: a master curve (overall tone) and one each for
// red, green and blue, on one square plot. In runs left to right, out runs
// bottom to top; the straight diagonal changes nothing.
//
//   click the plot     add a point there and carry on dragging it
//   drag a point       move it (it can never pass its neighbours)
//   double-click or
//   right-click        remove a point (the two ends always stay)
//   [ and ]            step through the points
//   arrow keys         nudge the selected point (Shift x10)
//   Delete             remove the selected point
//   Escape             cancel the drag
// The In / Out boxes under the plot type exact values.
//
// The line drawn is the engine's own curve (curveMath.evaluateCurve), so it
// cannot overshoot or reverse however the points are placed.
//
// A histogram of the picture sits behind the curve when there is one to show.
// It is real data or it is absent: nothing is drawn in its place.

const PAD = { l: 10, r: 10, t: 10, b: 10 }
const HIT_PX = 11
const NUDGE = 1 / 255

const CHANNELS = [
  { value: 'master', label: 'All', hint: 'The master curve: overall tone, all three colours together.' },
  { value: 'r', label: 'Red', hint: 'The red curve only.' },
  { value: 'g', label: 'Green', hint: 'The green curve only.' },
  { value: 'b', label: 'Blue', hint: 'The blue curve only.' },
]

// Channel identity is one of the jobs colour has; these are paint, not chrome.
const CHANNEL_COLOUR = { r: '#E0605A', g: '#5FB36A', b: '#5C9DF0' }
const HISTOGRAM_KEY = { master: 'luma', r: 'r', g: 'g', b: 'b' }

function readColours(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    boundary: get('--ui-boundary', '#747474'),
    ink: get('--ui-ink', '#E6E6E6'),
    ink3: get('--ui-ink-3', '#929292'),
    select: get('--ui-select', '#FFFFFF'),
  }
}

function geometry(w, h) {
  const size = Math.max(10, Math.min(w - PAD.l - PAD.r, h - PAD.t - PAD.b))
  const x0 = PAD.l + Math.max(0, (w - PAD.l - PAD.r - size) / 2)
  const y0 = PAD.t
  return {
    size, x0, y0,
    xOf: (v) => x0 + v * size,
    yOf: (v) => y0 + (1 - v) * size,
    vx: (px) => Math.min(1, Math.max(0, (px - x0) / size)),
    vy: (py) => Math.min(1, Math.max(0, 1 - (py - y0) / size)),
  }
}

const levelFormat = (v) => String(Math.round(v * 255))
const levelParse = (text) => {
  const n = Number(String(text).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n / 255 : null
}

/**
 * @param {object} props
 * @param {{master:number[][], r:number[][], g:number[][], b:number[][]}} props.curves
 * @param {(curves:object)=>void} props.onPreview   live, during a drag
 * @param {(curves:object)=>void} props.onCommit    once per gesture (the undo step)
 * @param {()=>void} props.onCancel
 * @param {{r,g,b,luma}|null} [props.histogram]     256 bins each, or null for none
 * @param {string} [props.histogramCaption]
 * @param {boolean} [props.disabled]
 */
export default function CurveEditor({
  curves, onPreview, onCommit, onCancel, histogram = null, histogramCaption = '', disabled = false,
}) {
  const [channel, setChannel] = useState('master')
  const [selected, setSelected] = useState(-1)
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()
  const drag = useRef(null)
  const live = useRef(null)
  live.current = { curves, channel, selected, histogram, disabled }

  const points = editablePoints(curves?.[channel])

  const withChannel = useCallback((pts) => ({
    ...live.current.curves,
    [live.current.channel]: storedPoints(pts),
  }), [])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW < 40 || cssH < 40) return
    const dpr = getDpr()
    const tw = backingSize(cssW, dpr)
    const th = backingSize(cssH, dpr)
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = readColours(canvas)
    const g = geometry(cssW, cssH)
    const { curves: cv, channel: ch, selected: sel, histogram: hist } = live.current

    ctx.fillStyle = c.ground
    ctx.fillRect(0, 0, cssW, cssH)

    // Histogram: where the picture's tones actually are. Square-root scaled so
    // a big flat area does not flatten everything else out of sight.
    const bins = hist?.[HISTOGRAM_KEY[ch]]
    if (bins && bins.length === 256) {
      let peak = 0
      for (let i = 1; i < 255; i++) if (bins[i] > peak) peak = bins[i]   // ends ignored: clipping spikes
      if (peak > 0) {
        ctx.beginPath()
        ctx.moveTo(g.xOf(0), g.yOf(0))
        for (let i = 0; i < 256; i++) {
          const v = Math.min(1, Math.sqrt(bins[i] / peak))
          ctx.lineTo(g.xOf(i / 255), g.yOf(v * 0.92))
        }
        ctx.lineTo(g.xOf(1), g.yOf(0))
        ctx.closePath()
        ctx.globalAlpha = 0.28
        ctx.fillStyle = ch === 'master' ? c.ink3 : CHANNEL_COLOUR[ch]
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    // Grid: quarters, and the plot's edge.
    ctx.lineWidth = 1
    ctx.strokeStyle = c.grid
    ctx.beginPath()
    for (let i = 0; i <= 4; i++) {
      const gx = Math.round(g.xOf(i / 4)) + 0.5
      const gy = Math.round(g.yOf(i / 4)) + 0.5
      ctx.moveTo(gx, g.y0); ctx.lineTo(gx, g.y0 + g.size)
      ctx.moveTo(g.x0, gy); ctx.lineTo(g.x0 + g.size, gy)
    }
    ctx.stroke()

    // The diagonal: "no change".
    ctx.save()
    ctx.setLineDash([2, 4])
    ctx.strokeStyle = c.boundary
    ctx.beginPath()
    ctx.moveTo(g.xOf(0), g.yOf(0))
    ctx.lineTo(g.xOf(1), g.yOf(1))
    ctx.stroke()
    ctx.restore()

    const drawCurve = (pts, colour, width, alpha) => {
      const samples = sampleCurve(pts, Math.max(64, Math.round(g.size)))
      ctx.beginPath()
      samples.forEach((y, i) => {
        const px = g.xOf(i / (samples.length - 1))
        const py = g.yOf(y)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.globalAlpha = alpha
      ctx.strokeStyle = colour
      ctx.lineWidth = width
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // The other curves, faint, when they do something: the four work together.
    for (const key of ['master', 'r', 'g', 'b']) {
      if (key === ch || curveIsIdentity(cv?.[key])) continue
      drawCurve(cv[key], key === 'master' ? c.ink : CHANNEL_COLOUR[key], 1, 0.4)
    }
    const pts = editablePoints(cv?.[ch])
    drawCurve(pts, ch === 'master' ? c.ink : CHANNEL_COLOUR[ch], 2, 1)

    // Points: squares, so they are a shape first and a colour second.
    pts.forEach((p, i) => {
      const px = g.xOf(p[0])
      const py = g.yOf(p[1])
      const on = i === sel
      const half = on ? 4.5 : 3.5
      ctx.fillStyle = on ? c.select : c.ground
      ctx.strokeStyle = on ? c.select : c.ink
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.rect(Math.round(px - half) + 0.5, Math.round(py - half) + 0.5, half * 2, half * 2)
      ctx.fill()
      ctx.stroke()
    })

    ctx.font = uiCanvasFont('10px')
    ctx.fillStyle = c.ink3
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'left'
    ctx.fillText('Dark', g.x0 + 4, g.y0 + g.size - 3)
    ctx.textAlign = 'right'
    ctx.fillText('Bright', g.x0 + g.size - 4, g.y0 + g.size - 3)
  }, [])

  useEffect(() => { paint() }, [paint, curves, channel, selected, histogram, themeEpoch, dprEpoch])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  // A different channel has different points.
  useEffect(() => { setSelected(-1) }, [channel])

  const local = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const g = geometry(rect.width, rect.height)
    return { g, px: e.clientX - rect.left, py: e.clientY - rect.top }
  }

  const onPointerDown = (e) => {
    if (disabled) return
    e.currentTarget.focus()
    const { g, px, py } = local(e)
    const pts = editablePoints(live.current.curves?.[live.current.channel])
    let index = hitTestPoint(pts, px, py, (x, y) => [g.xOf(x), g.yOf(y)], HIT_PX)

    if (e.button === 2) {
      if (index >= 0) {
        e.preventDefault()
        setSelected(-1)
        onCommit?.(withChannel(removePoint(pts, index)))
      }
      return
    }
    if (e.button !== 0) return

    let working = pts
    let added = false
    if (index < 0) {
      const res = addPoint(pts, g.vx(px), g.vy(py))
      if (!res) return                     // full, or on top of a neighbour
      working = res.points
      index = res.index
      added = true
      onPreview?.(withChannel(working))
    }
    setSelected(index)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, index, points: working, moved: added }
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const { g, px, py } = local(e)
    d.points = movePoint(d.points, d.index, g.vx(px), g.vy(py))
    d.moved = true
    onPreview?.(withChannel(d.points))
  }

  const endDrag = (e, commit) => {
    const d = drag.current
    if (!d || (e && d.id !== e.pointerId)) return
    drag.current = null
    if (!d.moved) return
    if (commit) onCommit?.(withChannel(d.points))
    else onCancel?.()
  }

  const onDoubleClick = (e) => {
    if (disabled) return
    const { g, px, py } = local(e)
    const pts = editablePoints(live.current.curves?.[live.current.channel])
    const index = hitTestPoint(pts, px, py, (x, y) => [g.xOf(x), g.yOf(y)], HIT_PX)
    if (index < 0) return
    setSelected(-1)
    onCommit?.(withChannel(removePoint(pts, index)))
  }

  const onKeyDown = (e) => {
    if (disabled) return
    if (e.key === 'Escape' && drag.current) {
      e.preventDefault()
      endDrag(null, false)
      return
    }
    const pts = editablePoints(live.current.curves?.[live.current.channel])
    const sel = live.current.selected
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      const n = pts.length
      setSelected(sel < 0 ? 0 : (sel + (e.key === ']' ? 1 : n - 1)) % n)
      return
    }
    if (sel < 0 || sel >= pts.length) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (pts.length <= 2) return
      setSelected(-1)
      onCommit?.(withChannel(removePoint(pts, sel)))
      return
    }
    const step = NUDGE * (e.shiftKey ? 10 : 1)
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = step
    else if (e.key === 'ArrowDown') dy = -step
    else return
    e.preventDefault()
    onCommit?.(withChannel(movePoint(pts, sel, pts[sel][0] + dx, pts[sel][1] + dy)))
  }

  const sel = selected >= 0 && selected < points.length ? points[selected] : null
  const setSelectedValue = (x, y, commit) => {
    const pts = movePoint(editablePoints(curves?.[channel]), selected, x, y)
    if (commit) onCommit?.(withChannel(pts))
    else onPreview?.(withChannel(pts))
  }
  const channelNeutral = curveIsIdentity(curves?.[channel])
  const channelName = CHANNELS.find((c) => c.value === channel)?.label ?? ''

  return (
    <>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Curve</span>
        <div className={styles.rowControl}>
          <SegmentedControl
            size="sm" label="Which curve" options={CHANNELS} value={channel} onChange={setChannel}
            hint="All is overall tone. Red, Green and Blue each bend one colour. The four work together."
          />
        </div>
      </div>
      <div className={styles.well}>
        <canvas
          ref={canvasRef}
          className={styles.curveCanvas}
          tabIndex={disabled ? -1 : 0}
          role="application"
          aria-label={`${channelName} curve, ${points.length} points`}
          data-hint="Tone curve: left is dark, right is bright. Lift a point to brighten those tones, lower it to darken them."
          data-hint-mods="Click: add · Drag: move · Double-click: remove · [ ]: select · Arrows: nudge"
          data-testid="xleth-grade-curve"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
        />
      </div>
      {histogramCaption ? <p className={styles.caption}>{histogramCaption}</p> : null}
      <div className={styles.row}>
        <span className={styles.rowLabel}>Point</span>
        <div className={styles.rowControl}>
          <NumberBox
            label="Point in" caption="In" width={72} min={0} max={1} step={1 / 255}
            disabled={disabled || !sel} value={sel ? sel[0] : 0}
            format={levelFormat} parse={levelParse}
            onChange={(x) => sel && setSelectedValue(x, sel[1], false)}
            onCommit={(x) => sel && setSelectedValue(x, sel[1], true)}
            onCancel={onCancel}
            hint="The tone this point acts on, 0 (black) to 255 (white)."
          />
          <NumberBox
            label="Point out" caption="Out" width={72} min={0} max={1} step={1 / 255}
            disabled={disabled || !sel} value={sel ? sel[1] : 0}
            format={levelFormat} parse={levelParse}
            onChange={(y) => sel && setSelectedValue(sel[0], y, false)}
            onCommit={(y) => sel && setSelectedValue(sel[0], y, true)}
            onCancel={onCancel}
            hint="What that tone becomes, 0 (black) to 255 (white)."
          />
        </div>
      </div>
      <div className={styles.actions}>
        <Button
          size="sm" disabled={disabled || channelNeutral}
          onClick={() => { setSelected(-1); onCommit?.({ ...curves, [channel]: [] }) }}
          hint={`Put the ${channelName} curve back to the straight diagonal.`}
        >
          Reset this curve
        </Button>
      </div>
    </>
  )
}

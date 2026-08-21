import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTokenValue } from '../../../theming/tokenValue.ts'
import { paramTrackEase, BEZIER_PRESETS, curveMatchesPreset } from './zprCurveMath.js'

// Inline bezier segment editor: fixed endpoints at (0,0)/(1,1), two draggable
// control handles. x is clamped to [0,1] (required for a monotonic x->t
// solve); y is allowed OUTSIDE the unit square so overshoot/anticipation
// curves are authorable — VIEW_Y_MIN/MAX below is an interactive limit for
// where the canvas viewport ends, not a value clamp (curve.js itself never
// clamps p1y/p2y).
const VIEW_Y_MIN = -1.0
const VIEW_Y_MAX = 2.0
const PAD = 20

export default function BezierSegmentEditor({ curve, onChange, onCommit }) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null) // 'p1' | 'p2' | null
  const [size, setSize] = useState({ w: 260, h: 200 })
  const [textValue, setTextValue] = useState(() => formatCurve(curve))
  const [textEditing, setTextEditing] = useState(false)

  const accent = useTokenValue('--theme-accent') || '#33CED6'
  const gridColor = useTokenValue('--xleth-flat-border') || '#2A2A38'
  const textColor = useTokenValue('--xleth-flat-text-secondary') || '#9AA0AE'
  const panelColor = useTokenValue('--xleth-flat-panel') || '#15151C'

  useEffect(() => {
    if (!textEditing) setTextValue(formatCurve(curve))
  }, [curve, textEditing])

  const activePreset = useMemo(
    () => BEZIER_PRESETS.find(p => curveMatchesPreset(curve, p.curve)),
    [curve]
  )

  // ── coordinate mapping ────────────────────────────────────────────────
  const toPx = useCallback((x, y) => {
    const plotW = size.w - PAD * 2
    const plotH = size.h - PAD * 2
    const px = PAD + x * plotW
    const py = PAD + (1 - (y - VIEW_Y_MIN) / (VIEW_Y_MAX - VIEW_Y_MIN)) * plotH
    return [px, py]
  }, [size])

  const fromPx = useCallback((px, py) => {
    const plotW = size.w - PAD * 2
    const plotH = size.h - PAD * 2
    const x = (px - PAD) / plotW
    const y = VIEW_Y_MIN + (1 - (py - PAD) / plotH) * (VIEW_Y_MAX - VIEW_Y_MIN)
    return [x, y]
  }, [size])

  // ── draw ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    ctx.fillStyle = panelColor
    ctx.fillRect(0, 0, size.w, size.h)

    // unit square
    const [ux0, uy0] = toPx(0, 0)
    const [ux1, uy1] = toPx(1, 1)
    ctx.strokeStyle = gridColor
    ctx.lineWidth = 1
    ctx.strokeRect(Math.min(ux0, ux1), Math.min(uy0, uy1), Math.abs(ux1 - ux0), Math.abs(uy1 - uy0))

    // zero line if outside unit square view
    const [zx0, zy0] = toPx(0, 0)
    ctx.beginPath()
    ctx.strokeStyle = gridColor
    ctx.moveTo(PAD, zy0)
    ctx.lineTo(size.w - PAD, zy0)
    ctx.stroke()

    // control lines
    const p1x = curve[0], p1y = curve[1], p2x = curve[2], p2y = curve[3]
    const [ox, oy] = toPx(0, 0)
    const [p1px, p1py] = toPx(p1x, p1y)
    const [p2px, p2py] = toPx(p2x, p2y)
    const [ex, ey] = toPx(1, 1)
    ctx.strokeStyle = textColor
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(ox, oy); ctx.lineTo(p1px, p1py)
    ctx.moveTo(ex, ey); ctx.lineTo(p2px, p2py)
    ctx.stroke()
    ctx.setLineDash([])

    // curve
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.beginPath()
    const STEPS = 48
    for (let i = 0; i <= STEPS; i++) {
      const x = i / STEPS
      const y = paramTrackEase(p1x, p1y, p2x, p2y, x)
      const [px, py] = toPx(x, y)
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.stroke()

    // endpoints (fixed, not draggable)
    ctx.fillStyle = textColor
    ;[[ox, oy], [ex, ey]].forEach(([px, py]) => {
      ctx.beginPath()
      ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fill()
    })

    // handles
    ctx.fillStyle = accent
    ;[[p1px, p1py], [p2px, p2py]].forEach(([px, py]) => {
      ctx.beginPath()
      ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.fill()
    })
  }, [curve, size, toPx, accent, gridColor, textColor, panelColor])

  // ── resize observer ──────────────────────────────────────────────────
  const wrapRef = useRef(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 40) setSize({ w: Math.round(r.width), h: 200 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── drag interaction ─────────────────────────────────────────────────
  const hitTestHandle = useCallback((px, py) => {
    const [p1px, p1py] = toPx(curve[0], curve[1])
    const [p2px, p2py] = toPx(curve[2], curve[3])
    const d1 = Math.hypot(px - p1px, py - p1py)
    const d2 = Math.hypot(px - p2px, py - p2py)
    const R = 10
    if (d1 <= R && d1 <= d2) return 'p1'
    if (d2 <= R) return 'p2'
    return null
  }, [curve, toPx])

  const handlePointerDown = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const which = hitTestHandle(px, py)
    if (!which) return
    dragRef.current = which
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
  }, [hitTestHandle])

  const handlePointerMove = useCallback((e) => {
    if (!dragRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    let [x, y] = fromPx(px, py)
    x = Math.max(0, Math.min(1, x))                              // x clamped
    y = Math.max(VIEW_Y_MIN, Math.min(VIEW_Y_MAX, y))             // y unclamped in math, bounded to the viewport for interaction
    const next = curve.slice()
    if (dragRef.current === 'p1') { next[0] = x; next[1] = y }
    else { next[2] = x; next[3] = y }
    onChange?.(next)
  }, [curve, fromPx, onChange])

  const handlePointerUp = useCallback((e) => {
    if (!dragRef.current) return
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) {}
    onCommit?.(curve)
  }, [curve, onCommit])

  const commitText = useCallback(() => {
    const m = textValue.match(/-?\d*\.?\d+/g)
    if (m && m.length === 4) {
      const next = m.map(Number)
      next[0] = Math.max(0, Math.min(1, next[0]))
      next[2] = Math.max(0, Math.min(1, next[2]))
      onChange?.(next)
      onCommit?.(next)
    } else {
      setTextValue(formatCurve(curve))
    }
    setTextEditing(false)
  }, [textValue, curve, onChange, onCommit])

  return (
    <div className="zpr-bezier-editor">
      <div ref={wrapRef} className="zpr-bezier-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="zpr-bezier-canvas"
          style={{ width: size.w, height: size.h }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
      <div className="zpr-bezier-readout-row">
        <span className="zpr-bezier-readout-label">cubic-bezier(</span>
        <input
          type="text"
          className="zpr-bezier-readout-input"
          value={textEditing ? textValue : formatCurve(curve)}
          onFocus={() => { setTextEditing(true); setTextValue(formatCurve(curve)) }}
          onChange={(e) => setTextValue(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
            else if (e.key === 'Escape') setTextEditing(false)
          }}
        />
        <span className="zpr-bezier-readout-label">)</span>
      </div>
      <div className="zpr-bezier-chip-row">
        {BEZIER_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className={`zpr-bezier-chip ${activePreset?.name === p.name ? 'is-active' : ''}`}
            onClick={() => { onChange?.(p.curve.slice()); onCommit?.(p.curve.slice()) }}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatCurve(curve) {
  return curve.map(v => (Math.round(v * 1000) / 1000).toString()).join(', ')
}

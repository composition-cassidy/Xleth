import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import useWaveshaperStore from '../../stores/waveshaperStore.js'
import { deduplicatePoints } from '../../stores/waveshaperStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  { id: 'pregain',  label: 'PRE GAIN',  min: -24, max: 48,  default: 0,   fmt: v => `${v.toFixed(1)} dB`, size: 52 },
  { id: 'postgain', label: 'POST GAIN', min: -24, max: 24,  default: 0,   fmt: v => `${v.toFixed(1)} dB`, size: 52 },
  { id: 'mix',      label: 'MIX',       min: 0,   max: 100, default: 100, fmt: v => `${v.toFixed(0)} %`,  size: 52 },
]

const PRESETS = [
  { value: 1, label: 'Soft Clip' },
  { value: 2, label: 'Hard Clip' },
  { value: 3, label: 'Tube'      },
  { value: 4, label: 'Fold'      },
  { value: 5, label: 'Rectify'   },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── SVG curve helpers ────────────────────────────────────────────────────────

const SVG_SIZE = 300
const SVG_PAD  = 20
const PLOT_SIZE = SVG_SIZE - SVG_PAD * 2

// Map [-1,1] → SVG pixel coordinate
function toSvgX(x) { return SVG_PAD + ((x + 1) / 2) * PLOT_SIZE }
function toSvgY(y) { return SVG_PAD + ((1 - y) / 2) * PLOT_SIZE } // Y inverted
function fromSvgX(px) { return ((px - SVG_PAD) / PLOT_SIZE) * 2 - 1 }
function fromSvgY(py) { return 1 - ((py - SVG_PAD) / PLOT_SIZE) * 2 }

// Natural cubic spline through sorted points, returning SVG path d string
function splinePath(points) {
  if (!points || points.length < 2) return ''

  const sorted = deduplicatePoints([...points].sort((a, b) => a[0] - b[0]))
  const n = sorted.length

  if (n < 2) return ''

  if (n === 2) {
    return `M${toSvgX(sorted[0][0])},${toSvgY(sorted[0][1])} L${toSvgX(sorted[1][0])},${toSvgY(sorted[1][1])}`
  }

  // Sample the spline at many points for a smooth SVG path
  const samples = 200
  const xs = sorted.map(p => p[0])
  const ys = sorted.map(p => p[1])

  // Natural cubic spline coefficients
  const h = []
  for (let i = 0; i < n - 1; i++) h.push(Math.max(1e-7, xs[i + 1] - xs[i]))

  const alpha = [0]
  for (let i = 1; i < n - 1; i++)
    alpha.push((3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]))

  const l = [1], mu = [0], z = [0]
  for (let i = 1; i < n - 1; i++) {
    l.push(2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1])
    mu.push(h[i] / l[i])
    z.push((alpha[i] - h[i - 1] * z[i - 1]) / l[i])
  }

  const c = new Array(n).fill(0)
  const b = new Array(n - 1).fill(0)
  const d = new Array(n - 1).fill(0)

  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1]
    b[j] = (ys[j + 1] - ys[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3
    d[j] = (c[j + 1] - c[j]) / (3 * h[j])
  }

  // Sample the spline
  const pathPts = []
  for (let i = 0; i <= samples; i++) {
    const x = xs[0] + (i / samples) * (xs[n - 1] - xs[0])
    let seg = 0
    for (let j = n - 2; j >= 0; j--) {
      if (x >= xs[j]) { seg = j; break }
    }
    const dx = x - xs[seg]
    const y = Math.max(-1, Math.min(1, ys[seg] + b[seg] * dx + c[seg] * dx * dx + d[seg] * dx * dx * dx))
    pathPts.push(`${i === 0 ? 'M' : 'L'}${toSvgX(x).toFixed(1)},${toSvgY(y).toFixed(1)}`)
  }
  return pathPts.join(' ')
}

// ── WaveshaperPanel ──────────────────────────────────────────────────────────

export default function WaveshaperPanel() {
  const target    = useWaveshaperStore(s => s.target)
  const close     = useWaveshaperStore(s => s.close)
  const points    = useWaveshaperStore(s => s.points)
  const preset    = useWaveshaperStore(s => s.preset)
  const addPoint  = useWaveshaperStore(s => s.addPoint)
  const removePoint = useWaveshaperStore(s => s.removePoint)
  const movePoint = useWaveshaperStore(s => s.movePoint)
  const setPreset = useWaveshaperStore(s => s.setPreset)

  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [dragIdx, setDragIdx] = useState(-1)
  const svgRef = useRef(null)
  const justDraggedRef = useRef(false)

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 200),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX, startMouseY: e.clientY,
      startPanelX: panelPos.x, startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: Math.max(-360, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0,    Math.min(window.innerHeight - 100, startPanelY + e.clientY - startMouseY)),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // Hydrate params from engine when target changes
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id === 'pregain' || p.id === 'postgain' || p.id === 'mix') next[p.id] = p.value
          if (p.id === 'preset') useWaveshaperStore.setState({ preset: Math.round(p.value) })
        }
        setParams(next)
      } catch (e) {
        console.warn('[WaveshaperPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // Set a continuous parameter
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  // ── SVG curve point interaction ────────────────────────────────────────────

  const getSvgCoords = useCallback((e) => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }, [])

  const handleSvgClick = useCallback((e) => {
    if (dragIdx >= 0 || justDraggedRef.current) return // Don't add during or just after drag
    const [px, py] = getSvgCoords(e)
    const x = Math.max(-1, Math.min(1, fromSvgX(px)))
    const y = Math.max(-1, Math.min(1, fromSvgY(py)))
    if (points.length < 32) addPoint(x, y)
  }, [dragIdx, points, addPoint, getSvgCoords])

  const handlePointMouseDown = useCallback((e, idx) => {
    e.stopPropagation()
    if (e.button === 2) {
      // Right-click to remove
      e.preventDefault()
      removePoint(idx)
      return
    }
    setDragIdx(idx)
  }, [removePoint])

  useEffect(() => {
    if (dragIdx < 0) return
    const onMove = (e) => {
      const [px, py] = getSvgCoords(e)
      const x = Math.max(-1, Math.min(1, fromSvgX(px)))
      const y = Math.max(-1, Math.min(1, fromSvgY(py)))
      // Optimistic update for responsiveness — deduplicate to prevent NaN in spline
      useWaveshaperStore.setState(s => {
        const pts = [...s.points]
        if (pts[dragIdx]) pts[dragIdx] = [x, y]
        pts.sort((a, b) => a[0] - b[0])
        return { points: deduplicatePoints(pts) }
      })
    }
    const onUp = (e) => {
      const [px, py] = getSvgCoords(e)
      const x = Math.max(-1, Math.min(1, fromSvgX(px)))
      const y = Math.max(-1, Math.min(1, fromSvgY(py)))
      movePoint(dragIdx, x, y)
      setDragIdx(-1)
      // Prevent the mouseup from triggering a click (ghost point)
      justDraggedRef.current = true
      requestAnimationFrame(() => { justDraggedRef.current = false })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [dragIdx, movePoint, getSvgCoords])

  const curvePath = useMemo(() => splinePath(points), [points])

  if (!target) return null

  return (
    <div
      className="ws-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header — drag handle */}
      <div className="ws-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="ws-panel-title">Waveshaper</span>
        <button className="ws-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* SVG curve editor */}
      <div className="ws-curve-container">
        <svg
          ref={svgRef}
          width={SVG_SIZE}
          height={SVG_SIZE}
          className="ws-curve-svg"
          onClick={handleSvgClick}
          onContextMenu={e => e.preventDefault()}
        >
          {/* Grid */}
          <rect x={SVG_PAD} y={SVG_PAD} width={PLOT_SIZE} height={PLOT_SIZE}
            fill="rgba(0,0,0,0.3)" stroke="var(--border)" strokeWidth={1} />
          {/* Center cross */}
          <line x1={toSvgX(0)} y1={SVG_PAD} x2={toSvgX(0)} y2={SVG_PAD + PLOT_SIZE}
            stroke="var(--border)" strokeWidth={0.5} strokeDasharray="4 2" />
          <line x1={SVG_PAD} y1={toSvgY(0)} x2={SVG_PAD + PLOT_SIZE} y2={toSvgY(0)}
            stroke="var(--border)" strokeWidth={0.5} strokeDasharray="4 2" />
          {/* Diagonal (linear = no effect) */}
          <line x1={toSvgX(-1)} y1={toSvgY(-1)} x2={toSvgX(1)} y2={toSvgY(1)}
            stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
          {/* Curve path */}
          <path d={curvePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
          {/* Control points */}
          {points.map(([x, y], i) => (
            <circle
              key={i}
              cx={toSvgX(x)}
              cy={toSvgY(y)}
              r={5}
              fill={dragIdx === i ? 'var(--accent)' : 'var(--bg-primary)'}
              stroke="var(--accent)"
              strokeWidth={2}
              style={{ cursor: 'pointer' }}
              onMouseDown={e => handlePointMouseDown(e, i)}
            />
          ))}
          {/* Axis labels */}
          <text x={SVG_PAD - 2} y={SVG_PAD - 4} fill="var(--text-tertiary)" fontSize={9} textAnchor="start">+1</text>
          <text x={SVG_PAD - 2} y={SVG_PAD + PLOT_SIZE + 12} fill="var(--text-tertiary)" fontSize={9} textAnchor="start">-1</text>
          <text x={SVG_PAD + PLOT_SIZE + 2} y={SVG_PAD + PLOT_SIZE + 12} fill="var(--text-tertiary)" fontSize={9} textAnchor="end">+1</text>
          <text x={SVG_SIZE / 2} y={SVG_PAD + PLOT_SIZE + 16} fill="var(--text-tertiary)" fontSize={9} textAnchor="middle">INPUT</text>
          <text x={4} y={SVG_SIZE / 2} fill="var(--text-tertiary)" fontSize={9} textAnchor="middle"
            transform={`rotate(-90, 4, ${SVG_SIZE / 2})`}>OUTPUT</text>
        </svg>
      </div>

      {/* Preset buttons */}
      <div className="ws-preset-row">
        {PRESETS.map(p => (
          <button
            key={p.value}
            className={`ws-preset-btn${preset === p.value ? ' active' : ''}`}
            onClick={() => setPreset(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Knobs row */}
      <div className="ws-knob-row">
        {KNOBS.map(k => (
          <div key={k.id} className="ws-knob-cell">
            <Knob
              value={params[k.id]}
              min={k.min}
              max={k.max}
              defaultValue={k.default}
              label={k.label}
              formatValue={k.fmt}
              onLiveChange={v => setParam(k.id, v)}
              onCommit={v => setParam(k.id, v)}
              size={k.size}
              dragRange={150}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

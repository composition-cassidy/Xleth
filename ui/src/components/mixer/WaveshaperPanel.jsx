import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X, ChevronDown } from 'lucide-react'
import useWaveshaperStore from '../../stores/waveshaperStore.js'
import { deduplicatePoints } from '../../stores/waveshaperStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  { id: 'pregain',  label: 'PRE GAIN',  min: -24, max: 48,  default: 0,   fmt: v => `${v.toFixed(1)} dB`, size: 48 },
  { id: 'postgain', label: 'POST GAIN', min: -24, max: 24,  default: 0,   fmt: v => `${v.toFixed(1)} dB`, size: 48 },
  { id: 'mix',      label: 'MIX',       min: 0,   max: 100, default: 100, fmt: v => `${v.toFixed(0)} %`,  size: 48 },
]

const SHAPE_OPTIONS = [
  { value: 1, label: 'Soft Clip' },
  { value: 2, label: 'Hard Clip' },
  { value: 3, label: 'Tube'      },
  { value: 4, label: 'Fold'      },
  { value: 5, label: 'Rectify'   },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── SVG constants ────────────────────────────────────────────────────────────

const SVG_SIZE  = 300
const SVG_PAD   = 20
const PLOT_SIZE = SVG_SIZE - SVG_PAD * 2

function toSvgX(x) { return SVG_PAD + ((x + 1) / 2) * PLOT_SIZE }
function toSvgY(y) { return SVG_PAD + ((1 - y) / 2) * PLOT_SIZE }
function fromSvgX(px) { return ((px - SVG_PAD) / PLOT_SIZE) * 2 - 1 }
function fromSvgY(py) { return 1 - ((py - SVG_PAD) / PLOT_SIZE) * 2 }

// Natural cubic spline through sorted points (unchanged from original)
function splinePath(points) {
  if (!points || points.length < 2) return ''
  const sorted = deduplicatePoints([...points].sort((a, b) => a[0] - b[0]))
  const n = sorted.length
  if (n < 2) return ''
  if (n === 2) {
    return `M${toSvgX(sorted[0][0])},${toSvgY(sorted[0][1])} L${toSvgX(sorted[1][0])},${toSvgY(sorted[1][1])}`
  }
  const samples = 200
  const xs = sorted.map(p => p[0])
  const ys = sorted.map(p => p[1])
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
  const pathPts = []
  for (let i = 0; i <= samples; i++) {
    const x = xs[0] + (i / samples) * (xs[n - 1] - xs[0])
    let seg = 0
    for (let j = n - 2; j >= 0; j--) { if (x >= xs[j]) { seg = j; break } }
    const dx = x - xs[seg]
    const y = Math.max(-1, Math.min(1, ys[seg] + b[seg] * dx + c[seg] * dx * dx + d[seg] * dx * dx * dx))
    pathPts.push(`${i === 0 ? 'M' : 'L'}${toSvgX(x).toFixed(1)},${toSvgY(y).toFixed(1)}`)
  }
  return pathPts.join(' ')
}

// Straight-segment fallback for Smooth Curve = off
function polylinePath(points) {
  if (!points || points.length < 2) return ''
  const sorted = deduplicatePoints([...points].sort((a, b) => a[0] - b[0]))
  return sorted.map(([x, y], i) =>
    `${i === 0 ? 'M' : 'L'}${toSvgX(x).toFixed(1)},${toSvgY(y).toFixed(1)}`
  ).join(' ')
}

const SNAP_THRESHOLD = 0.06

function applySnap(x, y, snapZero) {
  if (!snapZero) return [x, y]
  return [
    Math.abs(x) < SNAP_THRESHOLD ? 0 : x,
    Math.abs(y) < SNAP_THRESHOLD ? 0 : y,
  ]
}

// ── ShapeDropdown ────────────────────────────────────────────────────────────

function ShapeDropdown({ preset, onSelect }) {
  return (
    <div className="ws-toolbar-group">
      <label className="ws-toolbar-label">Shape</label>
      <select
        className="ws-select"
        value={preset === 0 ? '' : preset}
        onChange={e => onSelect(Number(e.target.value))}
        onMouseDown={e => e.stopPropagation()}
      >
        {preset === 0 && <option value="" disabled>Custom</option>}
        {SHAPE_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

// ── RangeDropdown ────────────────────────────────────────────────────────────

function RangeDropdown({ range, onChange }) {
  return (
    <div className="ws-toolbar-group">
      <label className="ws-toolbar-label">Range</label>
      <select
        className="ws-select"
        value={range}
        onChange={e => onChange(e.target.value)}
        onMouseDown={e => e.stopPropagation()}
      >
        <option value="bipolar">Bipolar</option>
        <option value="unipolar">Unipolar</option>
      </select>
    </div>
  )
}

// ── EditDropdown ─────────────────────────────────────────────────────────────

const EDIT_OPTIONS = [
  { key: 'snapZero',    label: 'Snap Zero'    },
  { key: 'lockEnds',   label: 'Lock Ends'    },
  { key: 'showInput',  label: 'Show Input'   },
  { key: 'smoothCurve',label: 'Smooth Curve' },
]

function EditDropdown({ flags, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const activeCount = EDIT_OPTIONS.filter(o => flags[o.key]).length

  return (
    <div className="ws-toolbar-group ws-edit-root" ref={rootRef}>
      <label className="ws-toolbar-label">Edit</label>
      <button
        className={`ws-select ws-edit-trigger${activeCount > 0 ? ' active' : ''}`}
        onMouseDown={e => { e.stopPropagation(); setOpen(v => !v) }}
      >
        <span>{activeCount > 0 ? `${activeCount} on` : 'None'}</span>
        <ChevronDown size={9} />
      </button>
      {open && (
        <div className="ws-edit-popover">
          {EDIT_OPTIONS.map(o => (
            <label key={o.key} className="ws-edit-item">
              <input
                type="checkbox"
                checked={flags[o.key]}
                onChange={e => onChange({ ...flags, [o.key]: e.target.checked })}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── PointInspector ───────────────────────────────────────────────────────────

function PointInspector({ points, selectedIdx }) {
  const pt = points[selectedIdx]
  return (
    <div className="ws-point-inspector">
      <div className="ws-sidebar-section-label">POINT</div>
      <div className="ws-point-row">
        <span className="ws-point-field-label">In</span>
        <span className="ws-point-field-value">{pt ? pt[0].toFixed(3) : '—'}</span>
      </div>
      <div className="ws-point-row">
        <span className="ws-point-field-label">Out</span>
        <span className="ws-point-field-value">{pt ? pt[1].toFixed(3) : '—'}</span>
      </div>
      <div className="ws-point-count">{points.length} pt{points.length !== 1 ? 's' : ''}</div>
    </div>
  )
}

// ── WaveshaperPanel ──────────────────────────────────────────────────────────

export default function WaveshaperPanel() {
  const target      = useWaveshaperStore(s => s.target)
  const close       = useWaveshaperStore(s => s.close)
  const points      = useWaveshaperStore(s => s.points)
  const preset      = useWaveshaperStore(s => s.preset)
  const addPoint    = useWaveshaperStore(s => s.addPoint)
  const removePoint = useWaveshaperStore(s => s.removePoint)
  const movePoint   = useWaveshaperStore(s => s.movePoint)
  const setPreset   = useWaveshaperStore(s => s.setPreset)

  const [params, setParams]       = useState(DEFAULT_PARAMS)
  const [dragIdx, setDragIdx]     = useState(-1)
  const [selectedIdx, setSelectedIdx] = useState(-1)

  // Frontend-only UI state — no engine parameters behind these
  const [range, setRange]     = useState('bipolar')
  const [editFlags, setEditFlags] = useState({
    snapZero: false, lockEnds: false, showInput: true, smoothCurve: true,
  })

  const svgRef         = useRef(null)
  const justDraggedRef = useRef(false)
  const panelDragRef   = useRef(null)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 240),
    y: 80,
  }))

  // Reset selected point when preset changes (points array is replaced)
  useEffect(() => { setSelectedIdx(-1) }, [preset])

  // ── Panel drag ─────────────────────────────────────────────────────────────

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button,input,select')) return
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
        x: Math.max(-460, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
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

  // ── Param hydration from engine ─────────────────────────────────────────────

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

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  // ── Lock Ends helper ────────────────────────────────────────────────────────

  const isLockedIdx = useCallback((idx) => {
    if (!editFlags.lockEnds || !points[idx]) return false
    const sorted = [...points].sort((a, b) => a[0] - b[0])
    const ptX = points[idx][0]
    return ptX === sorted[0][0] || ptX === sorted[sorted.length - 1][0]
  }, [editFlags.lockEnds, points])

  // ── Coordinate clamping ─────────────────────────────────────────────────────
  // Range is display-only in this pass: Unipolar only changes axis labels.
  // Point data always stays in [-1,+1] engine space; no clamping to [0,1].
  // Full Unipolar editing (SVG origin shift, axis remapping) needs a separate
  // mechanics pass that must not alter the engine-facing JSON point format.

  const clampToRange = useCallback((x, y) => {
    return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))]
  }, [])

  // ── SVG interaction (mechanics unchanged from original) ─────────────────────

  const getSvgCoords = useCallback((e) => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }, [])

  const handleSvgClick = useCallback((e) => {
    if (dragIdx >= 0 || justDraggedRef.current) return
    const [px, py] = getSvgCoords(e)
    let [x, y] = clampToRange(fromSvgX(px), fromSvgY(py))
    ;[x, y] = applySnap(x, y, editFlags.snapZero)
    if (points.length < 32) addPoint(x, y)
  }, [dragIdx, points, addPoint, getSvgCoords, clampToRange, editFlags.snapZero])

  const handlePointMouseDown = useCallback((e, idx) => {
    e.stopPropagation()
    setSelectedIdx(idx)
    if (e.button === 2) {
      e.preventDefault()
      if (!isLockedIdx(idx)) removePoint(idx)
      return
    }
    if (!isLockedIdx(idx)) setDragIdx(idx)
  }, [removePoint, isLockedIdx])

  useEffect(() => {
    if (dragIdx < 0) return
    const onMove = (e) => {
      const [px, py] = getSvgCoords(e)
      let [x, y] = clampToRange(fromSvgX(px), fromSvgY(py))
      ;[x, y] = applySnap(x, y, editFlags.snapZero)
      // Optimistic update for responsive drag feedback
      useWaveshaperStore.setState(s => {
        const pts = [...s.points]
        if (pts[dragIdx]) pts[dragIdx] = [x, y]
        pts.sort((a, b) => a[0] - b[0])
        return { points: deduplicatePoints(pts) }
      })
    }
    const onUp = (e) => {
      const [px, py] = getSvgCoords(e)
      let [x, y] = clampToRange(fromSvgX(px), fromSvgY(py))
      ;[x, y] = applySnap(x, y, editFlags.snapZero)
      movePoint(dragIdx, x, y)
      setDragIdx(-1)
      justDraggedRef.current = true
      requestAnimationFrame(() => { justDraggedRef.current = false })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [dragIdx, movePoint, getSvgCoords, clampToRange, editFlags.snapZero])

  const curvePath = useMemo(
    () => editFlags.smoothCurve ? splinePath(points) : polylinePath(points),
    [points, editFlags.smoothCurve]
  )

  const axisLabels = range === 'unipolar'
    ? { xMin: '0', xMax: '+1', yMin: '0', yMax: '+1' }
    : { xMin: '-1', xMax: '+1', yMin: '-1', yMax: '+1' }

  if (!target) return null

  return (
    <div className="ws-panel" style={{ left: panelPos.x, top: panelPos.y }}>

      {/* ── Drag handle header ── */}
      <div className="ws-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="ws-panel-title">Waveshaper</span>
        <button className="ws-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* ── Two-column body ── */}
      <div className="ws-panel-body">

        {/* LEFT: curve column */}
        <div className="ws-curve-col">

          {/* Toolbar: Shape / Range / Edit dropdowns */}
          <div className="ws-curve-toolbar">
            <ShapeDropdown preset={preset} onSelect={setPreset} />
            <RangeDropdown range={range} onChange={setRange} />
            <EditDropdown flags={editFlags} onChange={setEditFlags} />
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
              {/* Background */}
              <rect x={SVG_PAD} y={SVG_PAD} width={PLOT_SIZE} height={PLOT_SIZE}
                fill="rgba(0,0,0,0.3)" stroke="var(--theme-border-subtle)" strokeWidth={1} />
              {/* Center cross */}
              <line x1={toSvgX(0)} y1={SVG_PAD} x2={toSvgX(0)} y2={SVG_PAD + PLOT_SIZE}
                stroke="var(--theme-border-subtle)" strokeWidth={0.5} strokeDasharray="3 2" />
              <line x1={SVG_PAD} y1={toSvgY(0)} x2={SVG_PAD + PLOT_SIZE} y2={toSvgY(0)}
                stroke="var(--theme-border-subtle)" strokeWidth={0.5} strokeDasharray="3 2" />
              {/* Diagonal reference — shown only when Show Input is on */}
              {editFlags.showInput && (
                <line x1={toSvgX(-1)} y1={toSvgY(-1)} x2={toSvgX(1)} y2={toSvgY(1)}
                  stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
              )}
              {/* Curve */}
              <path d={curvePath} fill="none" stroke="var(--theme-accent)" strokeWidth={2} />
              {/* Control points */}
              {points.map(([x, y], i) => (
                <circle
                  key={i}
                  cx={toSvgX(x)}
                  cy={toSvgY(y)}
                  r={selectedIdx === i ? 6 : 4.5}
                  fill={dragIdx === i || selectedIdx === i
                    ? 'var(--theme-accent)'
                    : 'var(--theme-bg-primary)'}
                  stroke={isLockedIdx(i) ? 'var(--theme-text-subtle)' : 'var(--theme-accent)'}
                  strokeWidth={2}
                  style={{ cursor: isLockedIdx(i) ? 'default' : 'pointer' }}
                  onMouseDown={e => handlePointMouseDown(e, i)}
                />
              ))}
              {/* Axis labels */}
              <text x={SVG_PAD} y={SVG_PAD - 3}
                fill="var(--theme-text-subtle)" fontSize={8} textAnchor="start">{axisLabels.yMax}</text>
              <text x={SVG_PAD} y={SVG_PAD + PLOT_SIZE + 11}
                fill="var(--theme-text-subtle)" fontSize={8} textAnchor="start">{axisLabels.yMin}</text>
              <text x={SVG_PAD + PLOT_SIZE} y={SVG_PAD + PLOT_SIZE + 11}
                fill="var(--theme-text-subtle)" fontSize={8} textAnchor="end">{axisLabels.xMax}</text>
              <text x={SVG_SIZE / 2} y={SVG_PAD + PLOT_SIZE + 15}
                fill="var(--theme-text-subtle)" fontSize={7.5} textAnchor="middle">INPUT</text>
              <text x={4} y={SVG_SIZE / 2}
                fill="var(--theme-text-subtle)" fontSize={7.5} textAnchor="middle"
                transform={`rotate(-90, 4, ${SVG_SIZE / 2})`}>OUTPUT</text>
            </svg>
          </div>
        </div>

        {/* RIGHT: sidebar */}
        <div className="ws-sidebar">

          {/* Gain controls */}
          <div className="ws-sidebar-section">
            <div className="ws-sidebar-section-label">Gain</div>
            <div className="ws-knob-stack">
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
                    color="#F0A3D0"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Point inspector (read-only) */}
          <PointInspector points={points} selectedIdx={selectedIdx} />

        </div>
      </div>
    </div>
  )
}

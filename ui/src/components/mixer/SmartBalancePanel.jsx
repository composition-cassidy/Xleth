import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import { tokenValue } from '../../theming/tokenValue.ts'
import useSmartBalanceStore from '../../stores/smartBalanceStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Band definitions ────────────────────────────────────────────────────────

const BANDS = [
  { key: 'sub',   label: 'SUB',       color: '#FF6B6B' },
  { key: 'lomid', label: 'LOW-MID',   color: '#FFD93D' },
  { key: 'upmid', label: 'UPPER-MID', color: '#6BCB77' },
  { key: 'air',   label: 'AIR',       color: '#4D96FF' },
]

const CROSSOVER_FREQS = [150, 800, 4000]
const FREQ_MIN = 20
const FREQ_MAX = 20000
const DB_MIN = -60
const DB_MAX = 6
const DB_RANGE = DB_MAX - DB_MIN  // 66

// ── Parameter definitions ───────────────────────────────────────────────────

const GLOBAL_KNOBS = [
  { id: 'amount',   label: 'AMOUNT',   min: 0,  max: 100, default: 70,  fmt: v => `${v.toFixed(0)} %` },
  { id: 'preserve', label: 'PRESERVE', min: 0,  max: 100, default: 40,  fmt: v => `${v.toFixed(0)} %` },
  { id: 'response', label: 'RESPONSE', min: 10, max: 500, default: 150, fmt: v => `${v.toFixed(0)} ms` },
  { id: 'mix',      label: 'MIX',      min: 0,  max: 100, default: 100, fmt: v => `${v.toFixed(0)} %` },
]

const ALL_PARAM_IDS = [
  'amount', 'preserve', 'response', 'mix', 'mode',
  ...BANDS.flatMap(b => [`target_${b.key}`, `bandamt_${b.key}`, `floor_${b.key}`]),
]

const DEFAULT_PARAMS = Object.fromEntries([
  ['amount', 70], ['preserve', 40], ['response', 150], ['mix', 100], ['mode', 0],
  ...BANDS.flatMap(b => [
    [`target_${b.key}`, 0], [`bandamt_${b.key}`, 100], [`floor_${b.key}`, -60],
  ]),
])

const TARGET_PARAM_IDS = BANDS.map(b => `target_${b.key}`)

// ── Canvas helpers (module scope) ──────────────────────────────────────────

const logMin = Math.log10(FREQ_MIN)
const logMax = Math.log10(FREQ_MAX)
const logRange = logMax - logMin

function freqToX(freq, width) {
  return ((Math.log10(freq) - logMin) / logRange) * width
}

function dbToY(db, height) {
  // +6 dB at top (y=0), -60 dB at bottom (y=height)
  return (1 - (db - DB_MIN) / DB_RANGE) * height
}

function yToDb(y, height) {
  return DB_MIN + (1 - y / height) * DB_RANGE
}

function getBandXRanges(width) {
  const edges = [FREQ_MIN, ...CROSSOVER_FREQS, FREQ_MAX]
  return BANDS.map((band, i) => ({
    x1: freqToX(edges[i], width),
    x2: freqToX(edges[i + 1], width),
    color: band.color,
    label: band.label,
    key: band.key,
  }))
}

// ── Drawing functions (module scope) ───────────────────────────────────────

function drawBackground(ctx, w, h, bandRanges) {
  ctx.clearRect(0, 0, w, h)
  // Overall dark fill
  ctx.fillStyle = '#0d0d14'
  ctx.fillRect(0, 0, w, h)
  // Band columns
  for (const band of bandRanges) {
    ctx.fillStyle = band.color + '14'  // ~8% opacity
    ctx.fillRect(band.x1, 0, band.x2 - band.x1, h)
    // Vertical separator
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(band.x2, 0)
    ctx.lineTo(band.x2, h)
    ctx.stroke()
  }
}

function drawYAxis(ctx, w, h) {
  const gridDbs = [-60, -48, -36, -24, -12, 0, 6]
  ctx.font = '9px "JetBrains Mono", "Fira Code", monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  for (const db of gridDbs) {
    const y = dbToY(db, h)
    // Grid line
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'
    ctx.lineWidth = db === 0 ? 1 : 0.5
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    const label = db >= 0 ? `+${db}` : `${db}`
    ctx.fillText(label, 3, y)
  }
}

function drawBandMeters(ctx, w, h, bandRanges, vizData) {
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const bw = band.x2 - band.x1
    const rmsDb = vizData.rmsDb[i]
    const gainDb = vizData.gainDb[i]

    // RMS fill bar — from bottom up to RMS level
    if (rmsDb > DB_MIN) {
      const rmsY = dbToY(rmsDb, h)
      ctx.fillStyle = band.color + '66'  // 40% opacity
      ctx.fillRect(band.x1 + 1, rmsY, bw - 2, h - rmsY)
    }

    // Corrected level line (RMS + gain correction)
    const corrDb = rmsDb + gainDb
    if (corrDb > DB_MIN) {
      const corrY = dbToY(corrDb, h)
      ctx.strokeStyle = band.color
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(band.x1 + 4, corrY)
      ctx.lineTo(band.x2 - 4, corrY)
      ctx.stroke()
    }
  }
}

function drawTargetLines(ctx, w, h, bandRanges, targets, dragBandIndex) {
  ctx.lineWidth = 1
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const tDb = targets[i]
    const y = dbToY(tDb, h)
    const isDragging = dragBandIndex === i

    ctx.strokeStyle = isDragging ? tokenValue('--theme-fx-drag-indicator') : (band.color + 'aa')
    ctx.setLineDash(isDragging ? [] : [4, 3])
    ctx.lineWidth = isDragging ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(band.x1 + 2, y)
    ctx.lineTo(band.x2 - 2, y)
    ctx.stroke()

    // Small handle triangles at edges when dragging
    if (isDragging) {
      ctx.fillStyle = '#ffffff'
      // Left triangle
      ctx.beginPath()
      ctx.moveTo(band.x1 + 2, y)
      ctx.lineTo(band.x1 + 8, y - 4)
      ctx.lineTo(band.x1 + 8, y + 4)
      ctx.fill()
      // Right triangle
      ctx.beginPath()
      ctx.moveTo(band.x2 - 2, y)
      ctx.lineTo(band.x2 - 8, y - 4)
      ctx.lineTo(band.x2 - 8, y + 4)
      ctx.fill()
    }
  }
  ctx.setLineDash([])
}

function drawLabelsAndReadouts(ctx, w, h, bandRanges, vizData) {
  ctx.textAlign = 'center'

  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const cx = (band.x1 + band.x2) / 2

    // Band label at top
    ctx.font = 'bold 9px "JetBrains Mono", "Fira Code", monospace'
    ctx.fillStyle = band.color + 'cc'
    ctx.textBaseline = 'top'
    ctx.fillText(band.label, cx, 4)

    // Gain correction readout in center area
    const gainDb = vizData.gainDb[i]
    const sign = gainDb >= 0 ? '+' : ''
    ctx.font = '11px "JetBrains Mono", "Fira Code", monospace'
    ctx.fillStyle = gainDb > 0.5 ? '#6BCB77' : gainDb < -0.5 ? '#FF6B6B' : 'rgba(255,255,255,0.4)'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${sign}${gainDb.toFixed(1)}`, cx, h / 2)
  }
}

function drawDebugOverlay(ctx, w, h, bandRanges, vizData, showDebug) {
  if (!showDebug) return

  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const bw = band.x2 - band.x1
    const cx = (band.x1 + band.x2) / 2
    const dryRms = vizData.dryRms[i]

    // Dry RMS bar (dimmed, narrower, on right side of band)
    if (dryRms > DB_MIN) {
      const dryY = dbToY(dryRms, h)
      ctx.fillStyle = band.color + '22'  // very dim
      ctx.fillRect(band.x2 - bw * 0.25 - 1, dryY, bw * 0.25, h - dryY)
    }

    // Dynamics delta text
    const dynD = vizData.dynDelta[i]
    ctx.font = '8px "JetBrains Mono", "Fira Code", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillText(`\u0394${dynD >= 0 ? '+' : ''}${dynD.toFixed(1)}`, cx, h - 18)

    // Overall RMS
    ctx.fillText(`dry ${dryRms.toFixed(0)}`, cx, h - 6)

    // Transient flash — brief bright flash on the whole band column
    if (vizData.transient[i]) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(band.x1, 0, bw, h)
    }
  }

  // Overall RMS at bottom-left
  ctx.font = '9px "JetBrains Mono", "Fira Code", monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.fillText(`overall: ${vizData.overallRms.toFixed(1)} dB`, 4, h - 3)
}

// ── SmartBalancePanel ───────────────────────────────────────────────────────

export default function SmartBalancePanel() {
  const target = useSmartBalanceStore(s => s.target)
  const close  = useSmartBalanceStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [debugOpen, setDebugOpen] = useState(false)

  // Canvas refs
  const canvasRef = useRef(null)
  const canvasWrapRef = useRef(null)
  const canvasSizeRef = useRef({ w: 0, h: 0 })

  // Viz data written by rAF, read by draw — no React re-renders
  const vizDataRef = useRef({
    rmsDb: [-100, -100, -100, -100],
    gainDb: [0, 0, 0, 0],
    dryRms: [-100, -100, -100, -100],
    dynDelta: [0, 0, 0, 0],
    transient: [false, false, false, false],
    overallRms: -100,
  })

  const rafRef = useRef(null)
  const lastPollRef = useRef(0)

  // Canvas drag state for target lines
  const canvasDragRef = useRef({ active: false, bandIndex: -1, startDb: 0 })

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 260),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  // Keep a ref to current params so rAF draw can read targets without stale closure
  const paramsRef = useRef(params)
  paramsRef.current = params

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.sb-canvas-wrap')) return
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
        x: Math.max(-400, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
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
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[SmartBalance] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ResizeObserver for canvas
  useEffect(() => {
    const wrap = canvasWrapRef.current
    const cvs = canvasRef.current
    if (!wrap || !cvs) return

    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(rect.width)
      const h = Math.round(rect.height)
      cvs.width = w * dpr
      cvs.height = h * dpr
      cvs.style.width = w + 'px'
      cvs.style.height = h + 'px'
      const ctx = cvs.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      canvasSizeRef.current = { w, h }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()
    return () => ro.disconnect()
  }, [target])

  // 30fps meter polling + canvas draw via rAF
  useEffect(() => {
    if (!target) return
    let active = true
    const debugOpenRef = { value: debugOpen }

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        const vd = vizDataRef.current
        try {
          const raw = await window.xleth?.audio?.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(meters)) {
            for (let b = 0; b < 4; b++) {
              vd.rmsDb[b] = meters[b] ?? -100
              vd.gainDb[b] = meters[b + 4] ?? 0
            }
          }

          if (debugOpenRef.value) {
            try {
              const dbg = await window.xleth?.audio?.smartBalanceGetDebug(target.trackId, target.nodeId)
              if (dbg) {
                for (let b = 0; b < 4; b++) {
                  vd.dryRms[b] = dbg.dryRms[b] ?? -100
                  vd.dynDelta[b] = dbg.dynDelta[b] ?? 0
                  vd.transient[b] = !!dbg.transient[b]
                }
                vd.overallRms = dbg.overallRms ?? -100
              }
            } catch {}
          }
        } catch {}

        // Draw canvas
        const cvs = canvasRef.current
        if (cvs) {
          const ctx = cvs.getContext('2d')
          const { w, h } = canvasSizeRef.current
          if (w > 0 && h > 0) {
            const bandRanges = getBandXRanges(w)
            const p = paramsRef.current
            const targets = TARGET_PARAM_IDS.map(id => p[id])
            const dragIdx = canvasDragRef.current.active ? canvasDragRef.current.bandIndex : -1

            drawBackground(ctx, w, h, bandRanges)
            drawYAxis(ctx, w, h)
            drawBandMeters(ctx, w, h, bandRanges, vd)
            drawTargetLines(ctx, w, h, bandRanges, targets, dragIdx)
            drawLabelsAndReadouts(ctx, w, h, bandRanges, vd)
            drawDebugOverlay(ctx, w, h, bandRanges, vd, debugOpenRef.value)
          }
        }
      }
      rafRef.current = requestAnimationFrame(poll)
    }

    rafRef.current = requestAnimationFrame(poll)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [target, debugOpen])

  // Set a parameter value
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  // ── Canvas drag for target lines ─────────────────────────────────────────
  const handleCanvasMouseDown = useCallback((e) => {
    const cvs = canvasRef.current
    if (!cvs) return
    const rect = cvs.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { w, h } = canvasSizeRef.current
    if (w <= 0 || h <= 0) return

    const bandRanges = getBandXRanges(w)
    const p = paramsRef.current

    // Hit-test each band's target line
    for (let i = 0; i < 4; i++) {
      const band = bandRanges[i]
      if (mx < band.x1 || mx > band.x2) continue
      const tDb = p[TARGET_PARAM_IDS[i]]
      const tY = dbToY(tDb, h)
      if (Math.abs(my - tY) <= 8) {
        e.preventDefault()
        e.stopPropagation()
        canvasDragRef.current = { active: true, bandIndex: i, startDb: tDb }
        cvs.style.cursor = 'ns-resize'
        return
      }
    }
  }, [])

  useEffect(() => {
    const onMove = (e) => {
      const drag = canvasDragRef.current
      if (!drag.active) return
      const cvs = canvasRef.current
      if (!cvs) return
      const rect = cvs.getBoundingClientRect()
      const my = e.clientY - rect.top
      const { h } = canvasSizeRef.current
      if (h <= 0) return

      const db = Math.max(-40, Math.min(12, yToDb(my, h)))
      const paramId = TARGET_PARAM_IDS[drag.bandIndex]
      setParams(prev => ({ ...prev, [paramId]: db }))
      window.xleth?.audio?.setEffectParameter(target?.trackId, target?.nodeId, paramId, db)
    }

    const onUp = () => {
      const drag = canvasDragRef.current
      if (!drag.active) return
      const paramId = TARGET_PARAM_IDS[drag.bandIndex]
      const p = paramsRef.current
      window.xleth?.audio?.setEffectParameter(target?.trackId, target?.nodeId, paramId, p[paramId])
      canvasDragRef.current = { active: false, bandIndex: -1, startDb: 0 }
      const cvs = canvasRef.current
      if (cvs) cvs.style.cursor = ''
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [target])

  // Canvas hover — show ns-resize cursor when near a target line
  const handleCanvasMouseMove = useCallback((e) => {
    if (canvasDragRef.current.active) return  // already dragging
    const cvs = canvasRef.current
    if (!cvs) return
    const rect = cvs.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { w, h } = canvasSizeRef.current
    if (w <= 0 || h <= 0) return

    const bandRanges = getBandXRanges(w)
    const p = paramsRef.current
    let nearTarget = false
    for (let i = 0; i < 4; i++) {
      const band = bandRanges[i]
      if (mx < band.x1 || mx > band.x2) continue
      const tDb = p[TARGET_PARAM_IDS[i]]
      const tY = dbToY(tDb, h)
      if (Math.abs(my - tY) <= 8) {
        nearTarget = true
        break
      }
    }
    cvs.style.cursor = nearTarget ? 'ns-resize' : ''
  }, [])

  if (!target) return null

  const isRelative = params.mode === 0

  return (
    <div className="sb-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="sb-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="sb-panel-title">Smart Balance</span>
        <button
          className={'sb-debug-btn' + (debugOpen ? ' sb-debug-btn--active' : '')}
          onClick={() => setDebugOpen(d => !d)}
          title="Toggle debug view"
        >Debug</button>
        <button className="sb-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="sb-panel-body">
        {/* Global knobs row */}
        <div className="sb-knob-row sb-knob-row--global">
          {GLOBAL_KNOBS.map(k => (
            <div key={k.id} className="sb-knob-cell">
              <Knob
                value={params[k.id]}
                min={k.min} max={k.max}
                defaultValue={k.default}
                label={k.label}
                formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)}
                onCommit={v => setParam(k.id, v)}
                size={52} dragRange={150}
              />
            </div>
          ))}
        </div>

        {/* Mode toggle */}
        <div className="sb-mode-row">
          <button
            className={'sb-mode-btn' + (isRelative ? ' sb-mode-btn--active' : '')}
            onClick={() => setParam('mode', 0)}
          >Relative</button>
          <button
            className={'sb-mode-btn' + (!isRelative ? ' sb-mode-btn--active' : '')}
            onClick={() => setParam('mode', 1)}
          >Absolute</button>
        </div>

        {/* Canvas visualization */}
        <div className="sb-canvas-wrap" ref={canvasWrapRef}>
          <canvas
            ref={canvasRef}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
          />
        </div>

        {/* Per-band rows */}
        <div className="sb-bands">
          {BANDS.map((band, i) => (
            <div key={band.key} className="sb-band-row">
              <div className="sb-band-color" style={{ background: band.color }} />
              <span className="sb-band-label" style={{ color: band.color }}>{band.label}</span>
              <div className="sb-band-knobs">
                <Knob
                  value={params[`target_${band.key}`]}
                  min={-40} max={12}
                  defaultValue={0}
                  label={isRelative ? 'OFFSET' : 'TARGET'}
                  formatValue={v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`}
                  onLiveChange={v => setParam(`target_${band.key}`, v)}
                  onCommit={v => setParam(`target_${band.key}`, v)}
                  size={40} dragRange={150}
                />
                <Knob
                  value={params[`bandamt_${band.key}`]}
                  min={0} max={100}
                  defaultValue={100}
                  label="AMT"
                  formatValue={v => `${v.toFixed(0)}%`}
                  onLiveChange={v => setParam(`bandamt_${band.key}`, v)}
                  onCommit={v => setParam(`bandamt_${band.key}`, v)}
                  size={40} dragRange={150}
                />
                <Knob
                  value={params[`floor_${band.key}`]}
                  min={-96} max={-20}
                  defaultValue={-60}
                  label="FLOOR"
                  formatValue={v => `${v.toFixed(0)}`}
                  onLiveChange={v => setParam(`floor_${band.key}`, v)}
                  onCommit={v => setParam(`floor_${band.key}`, v)}
                  size={40} dragRange={150}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

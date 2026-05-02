import { useState, useEffect, useRef, useCallback } from 'react'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { tokenValue } from '../../theming/tokenValue.ts'
import useSmartBalanceStore from '../../stores/smartBalanceStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Band definitions ────────────────────────────────────────────────────────
// Bands match the engine's LR4 binary-tree crossover (150/800/4000 Hz).

const BANDS = [
  { key: 'sub',   label: 'SUB',       range: '20–150 Hz',     token: '--theme-smartbalance-band-sub' },
  { key: 'lomid', label: 'LOW-MID',   range: '150–800 Hz',    token: '--theme-smartbalance-band-lowmid' },
  { key: 'upmid', label: 'UPPER-MID', range: '800–4 kHz',     token: '--theme-smartbalance-band-uppermid' },
  { key: 'air',   label: 'AIR',       range: '4–20 kHz',      token: '--theme-smartbalance-band-air' },
]

const CROSSOVER_FREQS = [150, 800, 4000]
const FREQ_MIN = 20
const FREQ_MAX = 20000
// Display dB range matches the parameter range for target/floor.
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
const FLOOR_PARAM_IDS  = BANDS.map(b => `floor_${b.key}`)

// ── Canvas mapping helpers (module scope) ──────────────────────────────────

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
    x1: freqToX(edges[i],     width),
    x2: freqToX(edges[i + 1], width),
    color: tokenValue(band.token),
    cssVar: `var(${band.token})`,
    label: band.label,
    range: band.range,
    key: band.key,
  }))
}

// ── Drawing primitives (module scope, no React state) ──────────────────────

function drawBackground(ctx, w, h, bandRanges) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = tokenValue('--theme-bg-inset')
  ctx.fillRect(0, 0, w, h)

  // Each band is a clearly separated chamber so the display is read as
  // four independent meters rather than as a continuous EQ curve.
  for (let i = 0; i < bandRanges.length; i++) {
    const band = bandRanges[i]
    ctx.fillStyle = band.color + '0F'   // ~6% tinted column
    ctx.fillRect(band.x1, 0, band.x2 - band.x1, h)

    if (i < bandRanges.length - 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'  // strong divider
      ctx.fillRect(band.x2 - 1, 0, 2, h)
    }
  }
}

function drawTransientPulse(ctx, w, h, bandRanges, pulseLevels) {
  for (let i = 0; i < bandRanges.length; i++) {
    const lvl = pulseLevels[i]
    if (lvl <= 0.01) continue
    const band = bandRanges[i]
    const alpha = Math.max(0, Math.min(0.18, lvl * 0.18))
    ctx.fillStyle = band.color + Math.round(alpha * 255).toString(16).padStart(2, '0')
    ctx.fillRect(band.x1, 0, band.x2 - band.x1, h)
  }
}

function drawYAxis(ctx, w, h) {
  // Subtle reference grid; +6/0/-12/-24/-36/-48/-60 dB.
  const gridDbs = [6, 0, -12, -24, -36, -48, -60]
  ctx.font = '9px "JetBrains Mono", "Fira Code", monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  for (const db of gridDbs) {
    const y = dbToY(db, h)
    ctx.strokeStyle = db === 0
      ? 'rgba(255,255,255,0.18)'
      : 'rgba(255,255,255,0.05)'
    ctx.lineWidth = db === 0 ? 1 : 0.5
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(w, y + 0.5)
    ctx.stroke()

    ctx.fillStyle = db === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.25)'
    const label = db > 0 ? `+${db}` : `${db}`
    ctx.fillText(label, 4, y)
  }
}

function drawOverallRmsAnchor(ctx, w, h, overallRmsDb, isRelative) {
  // The Relative-mode anchor: every per-band target is interpreted as an
  // offset from this line. Drawn behind targets so targets sit on top.
  if (!isRelative) return
  if (!Number.isFinite(overallRmsDb) || overallRmsDb < DB_MIN) return

  const y = dbToY(overallRmsDb, h)
  ctx.strokeStyle = 'rgba(180,200,255,0.45)'
  ctx.lineWidth = 1
  ctx.setLineDash([1, 3])
  ctx.beginPath()
  ctx.moveTo(0, y + 0.5)
  ctx.lineTo(w, y + 0.5)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.font = '9px "JetBrains Mono", "Fira Code", monospace'
  ctx.fillStyle = 'rgba(180,200,255,0.65)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText(`overall ${overallRmsDb.toFixed(1)} dB`, w - 4, y - 7)
}

function drawBandMeters(ctx, w, h, bandRanges, vizData) {
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const bw = band.x2 - band.x1
    const rmsDb = vizData.rmsDb[i]
    const gainDb = vizData.gainDb[i]

    // Live RMS fill — solid, anchored at bottom of canvas. This is the
    // primary "level" reading; matches getEffectMeter slot 0–3.
    if (rmsDb > DB_MIN) {
      const rmsY = dbToY(rmsDb, h)
      const grad = ctx.createLinearGradient(0, rmsY, 0, h)
      grad.addColorStop(0, band.color + '70')
      grad.addColorStop(1, band.color + '20')
      ctx.fillStyle = grad
      ctx.fillRect(band.x1 + 2, rmsY, bw - 4, h - rmsY)

      // Top edge of fill — sharp line so RMS is precisely readable.
      ctx.strokeStyle = band.color + 'CC'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(band.x1 + 2, rmsY + 0.5)
      ctx.lineTo(band.x2 - 2, rmsY + 0.5)
      ctx.stroke()
    }

    // Estimated landing level (RMS + gain correction). Drawn as a short
    // hollow tick centred on the band, NOT a band-spanning line, so it
    // can never be mistaken for an EQ curve. Truth caveat: this is an
    // estimate — the actual post-output RMS also depends on Preserve.
    const corrDb = rmsDb + gainDb
    if (Math.abs(gainDb) > 0.05 && corrDb > DB_MIN && corrDb < DB_MAX + 1) {
      const corrY = dbToY(corrDb, h)
      const cx = (band.x1 + band.x2) / 2
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(cx - 10, corrY + 0.5)
      ctx.lineTo(cx + 10, corrY + 0.5)
      ctx.stroke()
      // Connector from RMS top to estimated landing
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.setLineDash([1, 2])
      ctx.beginPath()
      ctx.moveTo(cx, dbToY(rmsDb, h))
      ctx.lineTo(cx, corrY)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

function drawFloorLines(ctx, w, h, bandRanges, floors) {
  // Per-band gate floor — below this, the engine zeroes correction.
  ctx.lineWidth = 1
  ctx.setLineDash([2, 3])
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const fDb = floors[i]
    if (!Number.isFinite(fDb) || fDb < DB_MIN) continue
    const y = dbToY(fDb, h)
    ctx.strokeStyle = band.color + '55'
    ctx.beginPath()
    ctx.moveTo(band.x1 + 2, y + 0.5)
    ctx.lineTo(band.x2 - 2, y + 0.5)
    ctx.stroke()
  }
  ctx.setLineDash([])
}

function drawTargetLines(ctx, w, h, bandRanges, targets, dragBandIndex, isRelative, overallRmsDb) {
  ctx.lineWidth = 1
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const offset = targets[i]
    // In Relative mode, the visual target sits at overallRms + offset.
    // In Absolute mode it sits at the literal target dB.
    const tDb = isRelative
      ? (Number.isFinite(overallRmsDb) ? overallRmsDb + offset : offset)
      : offset
    const yClamped = Math.max(0, Math.min(h, dbToY(tDb, h)))
    const isDragging = dragBandIndex === i

    ctx.strokeStyle = isDragging
      ? tokenValue('--theme-fx-drag-indicator')
      : (band.color + 'CC')
    ctx.setLineDash(isDragging ? [] : [5, 3])
    ctx.lineWidth = isDragging ? 2 : 1.25
    ctx.beginPath()
    ctx.moveTo(band.x1 + 2, yClamped + 0.5)
    ctx.lineTo(band.x2 - 2, yClamped + 0.5)
    ctx.stroke()

    // Drag affordance — small notches at both ends.
    ctx.fillStyle = isDragging ? tokenValue('--theme-fg-inverse') : band.color
    ctx.fillRect(band.x1 + 1, yClamped - 2, 4, 4)
    ctx.fillRect(band.x2 - 5, yClamped - 2, 4, 4)
  }
  ctx.setLineDash([])
}

function drawBandLabels(ctx, w, h, bandRanges) {
  ctx.textAlign = 'center'
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const cx = (band.x1 + band.x2) / 2

    // Faint label band at top
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(band.x1, 0, band.x2 - band.x1, 22)

    ctx.font = 'bold 9px "JetBrains Mono", "Fira Code", monospace'
    ctx.fillStyle = band.color + 'EE'
    ctx.textBaseline = 'top'
    ctx.fillText(band.label, cx, 3)

    ctx.font = '8px "JetBrains Mono", "Fira Code", monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.fillText(band.range, cx, 13)
  }
}

function drawGainReadouts(ctx, w, h, bandRanges, vizData) {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const cx = (band.x1 + band.x2) / 2
    const gainDb = vizData.gainDb[i]
    const sign = gainDb >= 0 ? '+' : ''

    // Reserve a "readout pill" near the bottom so it never overlaps with
    // the live RMS fill top edge.
    const yPill = h - 22
    const pillW = 48
    const pillH = 16
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(cx - pillW / 2, yPill - pillH / 2, pillW, pillH)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.strokeRect(cx - pillW / 2 + 0.5, yPill - pillH / 2 + 0.5, pillW - 1, pillH - 1)

    ctx.font = 'bold 11px "JetBrains Mono", "Fira Code", monospace'
    ctx.fillStyle = Math.abs(gainDb) < 0.1
      ? 'rgba(255,255,255,0.45)'
      : (gainDb > 0 ? band.color : '#FFFFFF')
    ctx.fillText(`${sign}${gainDb.toFixed(1)}`, cx, yPill)
  }
}

function drawDebugOverlay(ctx, w, h, bandRanges, vizData, showDebug) {
  if (!showDebug) return

  for (let i = 0; i < 4; i++) {
    const band = bandRanges[i]
    const bw = band.x2 - band.x1
    const cx = (band.x1 + band.x2) / 2

    const dynD = vizData.dynDelta[i]
    ctx.font = '8px "JetBrains Mono", "Fira Code", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.fillText(`Δ${dynD >= 0 ? '+' : ''}${dynD.toFixed(1)}`, cx, h - 38)

    const dryRms = vizData.dryRms[i]
    ctx.fillText(`dry ${dryRms.toFixed(0)}`, cx, h - 48)
  }
}

// ── SmartBalancePanel ───────────────────────────────────────────────────────

export default function SmartBalancePanel() {
  const target = useSmartBalanceStore(s => s.target)
  const close  = useSmartBalanceStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [debugOpen, setDebugOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(true)

  const canvasRef = useRef(null)
  const canvasWrapRef = useRef(null)
  const canvasSizeRef = useRef({ w: 0, h: 0 })

  // Viz data is mutated by the rAF poll and read inside the same loop
  // (no React re-render per frame). Includes a per-band transient pulse
  // value that decays smoothly so the visual isn't a flicker.
  const vizDataRef = useRef({
    rmsDb:      [-100, -100, -100, -100],
    gainDb:     [0, 0, 0, 0],
    dryRms:     [-100, -100, -100, -100],
    dynDelta:   [0, 0, 0, 0],
    transient:  [false, false, false, false],
    pulse:      [0, 0, 0, 0],
    overallRms: -100,
  })

  const rafRef = useRef(null)
  const lastPollRef = useRef(0)
  const lastFrameRef = useRef(0)

  // Canvas drag state for target lines.
  const canvasDragRef = useRef({ active: false, bandIndex: -1, startDb: 0 })

  // Panel drag state (window position).
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 270),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  // Mirror params into a ref so the rAF loop reads the latest without
  // closing over stale state.
  const paramsRef = useRef(params)
  paramsRef.current = params

  const handlePanelMouseDown = useCallback((e) => {
    if (
      e.target.closest('button') ||
      e.target.closest('input') ||
      e.target.closest('.sb-canvas-wrap') ||
      e.target.closest('.sb-knob-cell') ||
      e.target.closest('.sb-band-row')
    ) return
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

  // Hydrate parameters from the engine when the target changes.
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

  // DPR-aware canvas sizing.
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

  // Polling + draw loop. ~30 fps for engine reads, 60 fps for canvas
  // (so transient pulse decay stays smooth between polls).
  useEffect(() => {
    if (!target) return
    let active = true

    const tick = async () => {
      if (!active) return
      const now = performance.now()
      const dt = Math.max(0, Math.min(0.1, (now - lastFrameRef.current) / 1000))
      lastFrameRef.current = now

      // Engine poll throttled to ~30 fps.
      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        const vd = vizDataRef.current
        try {
          const raw = await window.xleth?.audio?.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(meters)) {
            for (let b = 0; b < 4; b++) {
              vd.rmsDb[b]  = meters[b]     ?? -100
              vd.gainDb[b] = meters[b + 4] ?? 0
            }
          }

          // Always read debug atomics — they are cheap and feed the
          // overall-RMS anchor and the transient pulses in normal view.
          try {
            const dbg = await window.xleth?.audio?.smartBalanceGetDebug(target.trackId, target.nodeId)
            if (dbg) {
              for (let b = 0; b < 4; b++) {
                vd.dryRms[b]    = dbg.dryRms?.[b]    ?? -100
                vd.dynDelta[b]  = dbg.dynDelta?.[b]  ?? 0
                const t = !!dbg.transient?.[b]
                vd.transient[b] = t
                if (t) vd.pulse[b] = 1.0
              }
              vd.overallRms = dbg.overallRms ?? -100
            }
          } catch {}
        } catch {}
      }

      // Decay transient pulses (~250 ms half-life).
      const decay = Math.exp(-dt / 0.18)
      const vd = vizDataRef.current
      for (let b = 0; b < 4; b++) vd.pulse[b] *= decay

      const cvs = canvasRef.current
      if (cvs) {
        const ctx = cvs.getContext('2d')
        const { w, h } = canvasSizeRef.current
        if (w > 0 && h > 0) {
          const bandRanges = getBandXRanges(w)
          const p = paramsRef.current
          const targets = TARGET_PARAM_IDS.map(id => p[id])
          const floors  = FLOOR_PARAM_IDS.map(id => p[id])
          const dragIdx = canvasDragRef.current.active ? canvasDragRef.current.bandIndex : -1
          const isRelative = p.mode === 0

          drawBackground(ctx, w, h, bandRanges)
          drawTransientPulse(ctx, w, h, bandRanges, vd.pulse)
          drawYAxis(ctx, w, h)
          drawOverallRmsAnchor(ctx, w, h, vd.overallRms, isRelative)
          drawFloorLines(ctx, w, h, bandRanges, floors)
          drawBandMeters(ctx, w, h, bandRanges, vd)
          drawTargetLines(ctx, w, h, bandRanges, targets, dragIdx, isRelative, vd.overallRms)
          drawBandLabels(ctx, w, h, bandRanges)
          drawGainReadouts(ctx, w, h, bandRanges, vd)
          drawDebugOverlay(ctx, w, h, bandRanges, vd, debugOpen)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    lastFrameRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [target, debugOpen])

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  // ── Canvas drag for target lines ─────────────────────────────────────────
  // In Relative mode the user drags the visual line (overallRms + offset)
  // and we store the offset; in Absolute mode they drag the absolute level.

  const targetDbForBand = useCallback((bandIndex) => {
    const p = paramsRef.current
    const offset = p[TARGET_PARAM_IDS[bandIndex]]
    const isRelative = p.mode === 0
    const overall = vizDataRef.current.overallRms
    return isRelative && Number.isFinite(overall) ? overall + offset : offset
  }, [])

  const handleCanvasMouseDown = useCallback((e) => {
    const cvs = canvasRef.current
    if (!cvs) return
    const rect = cvs.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { w, h } = canvasSizeRef.current
    if (w <= 0 || h <= 0) return

    const bandRanges = getBandXRanges(w)
    for (let i = 0; i < 4; i++) {
      const band = bandRanges[i]
      if (mx < band.x1 || mx > band.x2) continue
      const tDb = targetDbForBand(i)
      const tY = dbToY(tDb, h)
      if (Math.abs(my - tY) <= 8) {
        e.preventDefault()
        e.stopPropagation()
        canvasDragRef.current = { active: true, bandIndex: i, startDb: tDb }
        cvs.style.cursor = 'ns-resize'
        return
      }
    }
  }, [targetDbForBand])

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

      const visualDb = yToDb(my, h)
      const p = paramsRef.current
      const isRelative = p.mode === 0
      const overall = vizDataRef.current.overallRms
      // Convert the visual position back into the parameter's coordinate
      // space (offset for Relative, absolute level for Absolute).
      const paramDb = (isRelative && Number.isFinite(overall))
        ? visualDb - overall
        : visualDb
      const clamped = Math.max(-40, Math.min(12, paramDb))
      const paramId = TARGET_PARAM_IDS[drag.bandIndex]
      setParams(prev => ({ ...prev, [paramId]: clamped }))
      window.xleth?.audio?.setEffectParameter(target?.trackId, target?.nodeId, paramId, clamped)
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

  const handleCanvasMouseMove = useCallback((e) => {
    if (canvasDragRef.current.active) return
    const cvs = canvasRef.current
    if (!cvs) return
    const rect = cvs.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { w, h } = canvasSizeRef.current
    if (w <= 0 || h <= 0) return

    const bandRanges = getBandXRanges(w)
    let nearTarget = false
    for (let i = 0; i < 4; i++) {
      const band = bandRanges[i]
      if (mx < band.x1 || mx > band.x2) continue
      const tDb = targetDbForBand(i)
      const tY = dbToY(tDb, h)
      if (Math.abs(my - tY) <= 8) {
        nearTarget = true
        break
      }
    }
    cvs.style.cursor = nearTarget ? 'ns-resize' : ''
  }, [targetDbForBand])

  if (!target) return null

  const isRelative = params.mode === 0
  const targetKnobLabel = isRelative ? 'OFFSET' : 'TARGET'
  const modeHint = isRelative
    ? 'Targets are offsets from the overall mix RMS.'
    : 'Targets are absolute RMS levels in dBFS.'

  return (
    <div className="sb-panel sb-panel--v2" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="sb-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="sb-panel-title">Smart Balance</span>
        <span className="sb-panel-subtitle">multiband target leveler</span>
        <button
          className={'sb-debug-btn' + (debugOpen ? ' sb-debug-btn--active' : '')}
          onClick={() => setDebugOpen(d => !d)}
          title="Toggle debug overlay"
        >Debug</button>
        <button className="sb-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="sb-panel-body">
        {/* ── Macro section ──────────────────────────────────────────── */}
        <section className="sb-macro">
          <div className="sb-macro-knobs">
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
                  size={k.id === 'amount' ? 56 : 48}
                  dragRange={150}
                />
              </div>
            ))}
          </div>

          <div className="sb-mode-group" title={modeHint}>
            <div className="sb-mode-label">MODE</div>
            <div className="sb-mode-pill">
              <button
                className={'sb-mode-btn' + (isRelative ? ' sb-mode-btn--active' : '')}
                onClick={() => setParam('mode', 0)}
              >Relative</button>
              <button
                className={'sb-mode-btn' + (!isRelative ? ' sb-mode-btn--active' : '')}
                onClick={() => setParam('mode', 1)}
              >Absolute</button>
            </div>
            <div className="sb-mode-hint">{modeHint}</div>
          </div>
        </section>

        {/* ── Visualization ──────────────────────────────────────────── */}
        <section className="sb-viz">
          <div className="sb-canvas-wrap" ref={canvasWrapRef}>
            <canvas
              ref={canvasRef}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
            />
          </div>
          <div className="sb-viz-legend">
            <span><i className="sb-legend-swatch sb-legend-swatch--fill" /> Live RMS</span>
            <span><i className="sb-legend-swatch sb-legend-swatch--target" /> Target {isRelative ? '(offset from overall)' : '(absolute)'}</span>
            <span><i className="sb-legend-swatch sb-legend-swatch--floor" /> Gate floor</span>
            <span><i className="sb-legend-swatch sb-legend-swatch--est" /> Estimated landing</span>
          </div>
        </section>

        {/* ── Per-band advanced ──────────────────────────────────────── */}
        <section className={'sb-advanced' + (advancedOpen ? '' : ' sb-advanced--collapsed')}>
          <button
            className="sb-advanced-header"
            onClick={() => setAdvancedOpen(o => !o)}
            title="Toggle per-band controls"
          >
            {advancedOpen
              ? <ChevronDown size={12} />
              : <ChevronRight size={12} />}
            <span>Per-band controls</span>
            <span className="sb-advanced-spacer" />
            <span className="sb-advanced-hint">Drag the canvas target lines for quick adjustment</span>
          </button>

          {advancedOpen && (
            <div className="sb-bands">
              {BANDS.map((band) => {
                const cssVar = `var(${band.token})`
                return (
                  <div key={band.key} className="sb-band-row">
                    <div className="sb-band-tag">
                      <span className="sb-band-color" style={{ background: cssVar }} />
                      <span className="sb-band-meta">
                        <span className="sb-band-label" style={{ color: cssVar }}>{band.label}</span>
                        <span className="sb-band-range">{band.range}</span>
                      </span>
                    </div>
                    <div className="sb-band-knobs">
                      <Knob
                        value={params[`target_${band.key}`]}
                        min={-40} max={12}
                        defaultValue={0}
                        label={targetKnobLabel}
                        formatValue={v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`}
                        onLiveChange={v => setParam(`target_${band.key}`, v)}
                        onCommit={v => setParam(`target_${band.key}`, v)}
                        size={38} dragRange={150}
                        color={tokenValue(band.token)}
                      />
                      <Knob
                        value={params[`bandamt_${band.key}`]}
                        min={0} max={100}
                        defaultValue={100}
                        label="AMOUNT"
                        formatValue={v => `${v.toFixed(0)} %`}
                        onLiveChange={v => setParam(`bandamt_${band.key}`, v)}
                        onCommit={v => setParam(`bandamt_${band.key}`, v)}
                        size={38} dragRange={150}
                      />
                      <Knob
                        value={params[`floor_${band.key}`]}
                        min={-96} max={-20}
                        defaultValue={-60}
                        label="FLOOR"
                        formatValue={v => `${v.toFixed(0)} dB`}
                        onLiveChange={v => setParam(`floor_${band.key}`, v)}
                        onCommit={v => setParam(`floor_${band.key}`, v)}
                        size={38} dragRange={150}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

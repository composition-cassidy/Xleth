import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import useEqStore, { BAND_TYPES, BAND_COLORS } from '../../stores/eqStore.js'
import {
  SVG_W, SVG_H, PAD_L, PAD_R, PAD_T, PAD_B, PLOT_W, PLOT_H,
  FREQ_MIN, FREQ_MAX, ANA_DB_MIN, ANA_DB_MAX, RESPONSE_SIZE,
  freqToX, xToFreq,
  dbToY_response, dbToY_analyzerWithRange, yToDb_response,
  evalResponseAt, clamp,
} from './eqGeometry.js'
import { computeSpectrumPaths, resetMaxHold } from './eqSpectrumPath.js'
import {
  TILT_OPTIONS, RANGE_OPTIONS, SPEED_OPTIONS, RESOLUTION_OPTIONS,
  SPEED_DECAY, RESOLUTION_BARS,
  loadAnalyzerSettings, saveAnalyzerSettings,
} from './eqAnalyzerSettings.js'
import EqBandPopup from './EqBandPopup.jsx'
import EqOutputMeter from './EqOutputMeter.jsx'

// ── Constants ────────────────────────────────────────────────────────────────

const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const ANA_DB_LINES = [-80, -60, -40, -20, 0]

// Coordinate helpers are imported from ./eqGeometry.js

// ── Grid (dual-scale, memoised) ──────────────────────────────────────────────

const EqGrid = memo(function EqGrid({ dbZoom, rangeDb }) {
  const respLines = [-dbZoom, -dbZoom / 2, 0, dbZoom / 2, dbZoom]
  const botDb = ANA_DB_MAX - rangeDb
  const visibleAnaLines = ANA_DB_LINES.filter(db => db >= botDb)
  return (
    <g className="eq-grid">
      {FREQ_GRID.map((f, i) => {
        const x = freqToX(f)
        return (
          <g key={`f${f}`}>
            <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + PLOT_H} className="eq-grid-line" />
            <text x={x} y={SVG_H - 3} className="eq-grid-label-x">{FREQ_LABELS[i]}</text>
          </g>
        )
      })}
      {visibleAnaLines.map(db => {
        const y = dbToY_analyzerWithRange(db, rangeDb)
        return (
          <g key={`ana${db}`}>
            <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} className="eq-grid-line-ana" />
            <text x={PAD_L - 4} y={y + 3} className="eq-grid-label-ana" textAnchor="end">{db}</text>
          </g>
        )
      })}
      {respLines.map(db => {
        const y = dbToY_response(db, dbZoom)
        return (
          <g key={`resp${db}`}>
            <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y}
              className={db === 0 ? 'eq-grid-line-zero' : 'eq-grid-line-resp'} />
            <text x={PAD_L + PLOT_W + 4} y={y + 3} className="eq-grid-label-resp" textAnchor="start">
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        )
      })}
    </g>
  )
})

// computeSpectrumPaths is imported from ./eqSpectrumPath.js

// ── Response curve path ──────────────────────────────────────────────────────

function responseToPath(data, dbZoom) {
  if (!data || data.length === 0) return ''
  const parts = []
  for (let i = 0; i < RESPONSE_SIZE; i++) {
    const t = i / (RESPONSE_SIZE - 1)
    const freq = Math.exp(Math.log(FREQ_MIN) + t * (Math.log(FREQ_MAX) - Math.log(FREQ_MIN)))
    const x = freqToX(freq)
    const db = clamp(data[i], -dbZoom, dbZoom)
    const y = dbToY_response(db, dbZoom)
    parts.push(i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  return parts.join(' ')
}

// ── Band dot — minimal glowing orb ───────────────────────────────────────────
// No Q ring, no GR ring, no mode badge, no label: a plain filled orb in the
// band's color with a soft per-band-colored glow (drop-shadow filter) that
// brightens when the band is selected. Everything else about a band (type,
// mode, Q, dynamics/spectral fields) now lives in the floating EqBandPopup.

function BandDot({ band, index, onDragStart, dbZoom, isSelected }) {
  const color = BAND_COLORS[index % BAND_COLORS.length]
  const cx = freqToX(band.freq)
  const cy = dbToY_response(band.gain, dbZoom)
  const opacity = band.enabled ? 1 : 0.3

  const handleMouseDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onDragStart(index, e)
  }

  return (
    <g className={`eq-band-dot${isSelected ? ' selected' : ''}`} opacity={opacity}>
      {/* Visible orb — glow color comes from the band's own accent color */}
      <circle
        className="eq-band-orb"
        cx={cx} cy={cy} r={6}
        fill={color}
        stroke="var(--xleth-eq-bg-plot)"
        strokeWidth={1.5}
        style={{ '--eq-orb-glow': color }}
        pointerEvents="none"
      />
      {/* Hit area */}
      <circle cx={cx} cy={cy} r={12} fill="transparent" style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown} />
    </g>
  )
}

// ── Main EQ Panel ────────────────────────────────────────────────────────────

export default function EqPanel() {
  const target = useEqStore(s => s.target)
  const bands = useEqStore(s => s.bands)
  const addBandAt = useEqStore(s => s.addBandAt)
  const setBandParam = useEqStore(s => s.setBandParam)
  const removeBand = useEqStore(s => s.removeBand)
  const duplicateBand = useEqStore(s => s.duplicateBand)
  // linPhase/oversample/preSpectrum + their setters are engine-synced global
  // params (linear-phase mode, oversampling factor, pre-EQ spectrum capture).
  // Their header toggle buttons were removed in this design pass, but the
  // state/actions stay wired so the owner can re-expose a control later
  // without re-deriving any of this. linPhase/oversample still gate the
  // Dynamic/Spectral mode options in the band popup; preSpectrum still
  // selects which spectrum trace the hover readout reads from below.
  const linPhase = useEqStore(s => s.linPhase)
  const oversample = useEqStore(s => s.oversample)
  const setLinPhase = useEqStore(s => s.setLinPhase)
  const setOversample = useEqStore(s => s.setOversample)
  const preSpectrum = useEqStore(s => s.preSpectrum)
  const setPreSpectrum = useEqStore(s => s.setPreSpectrum)
  // dbZoom (response-curve vertical zoom) — same story: cycle button removed,
  // state/action retained (see cycleDbZoom below).
  const dbZoom = useEqStore(s => s.dbZoom)
  const setDbZoom = useEqStore(s => s.setDbZoom)
  const fetchResponseCurve = useEqStore(s => s.fetchResponseCurve)
  const fetchSpectrumData = useEqStore(s => s.fetchSpectrumData)
  const fetchBandGR = useEqStore(s => s.fetchBandGR)
  const sampleRate = useEqStore(s => s.sampleRate)
  const close = useEqStore(s => s.close)
  const selectedBandIndex = useEqStore(s => s.selectedBandIndex)
  const setSelectedBand = useEqStore(s => s.setSelectedBand)
  // Font/theme popover was removed too; keep applying whatever was already
  // saved (localStorage) so existing customizations don't silently reset.
  const themeFont = useEqStore(s => s.themeFont)
  const themeFontScale = useEqStore(s => s.themeFontScale)

  const [analyzerSettings, setAnalyzerSettings] = useState(() => loadAnalyzerSettings())
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 340),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  // SVG path state (30fps polling)
  const [responsePath, setResponsePath] = useState('')
  const [spectrumPaths, setSpectrumPaths] = useState({ fill: '', maxHold: '' })
  const [preSpectrumPaths, setPreSpectrumPaths] = useState({ fill: '', maxHold: '' })
  const [bandGR, setBandGR] = useState(null)
  const rafRef = useRef(null)
  const lastPollRef = useRef(0)
  const svgRef = useRef(null)
  const meterPeaksRef = useRef({ l: 0, r: 0 })
  const responseCurveRef = useRef(null)
  const spectrumDataRef = useRef(null)   // latest spec data for hover readout

  // B6 — hover readout
  const [hoverReadout, setHoverReadout] = useState(null)
  const cursorRef = useRef({ svgX: null, inPlot: false })
  const lastReadoutRef = useRef(null)

  // Refs so polling closure sees current values without restarting the effect
  const analyzerRef = useRef(analyzerSettings)
  useEffect(() => { analyzerRef.current = analyzerSettings }, [analyzerSettings])
  const preSpectrumRef = useRef(preSpectrum)
  useEffect(() => { preSpectrumRef.current = preSpectrum }, [preSpectrum])

  // Band drag state
  const dragRef = useRef(null)

  // dB-zoom cycle
  const cycleDbZoom = useCallback(() => {
    const order = [6, 12, 24, 48]
    const idx = order.indexOf(useEqStore.getState().dbZoom)
    setDbZoom(order[(idx + 1) % order.length])
  }, [setDbZoom])

  // Analyzer setting cycle helper
  const cycleAnalyzer = useCallback((key, options) => {
    setAnalyzerSettings(s => {
      const idx  = options.indexOf(s[key])
      const next = { ...s, [key]: options[(idx + 1) % options.length] }
      saveAnalyzerSettings(next)
      return next
    })
  }, [])

  useEffect(() => {
    if (responseCurveRef.current) {
      setResponsePath(responseToPath(responseCurveRef.current, dbZoom))
    }
  }, [dbZoom])

  // Panel drag
  const handlePanelDragStart = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPanelX: panelPos.x,
      startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: clamp(startPanelX + (e.clientX - startMouseX), -540, window.innerWidth - 100),
        y: clamp(startPanelY + (e.clientY - startMouseY), 0, window.innerHeight - 100),
      })
    }
    const onMouseUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // 30fps polling loop — spectrum, response, GR, hover readout
  useEffect(() => {
    if (!target) return
    let active = true
    resetMaxHold()

    const poll = async () => {
      if (!active) return
      const now = performance.now()

      // B6 — hover readout (computed every poll frame, cheap)
      const cursor = cursorRef.current
      if (cursor.inPlot && !dragRef.current && responseCurveRef.current) {
        const freq = clamp(xToFreq(cursor.svgX), FREQ_MIN, FREQ_MAX)
        const freqStr = freq >= 1000
          ? `${(freq / 1000).toFixed(2).replace(/\.?0+$/, '')} kHz`
          : `${Math.round(freq)} Hz`
        const eqDelta = evalResponseAt(responseCurveRef.current, freq)
        const deltaStr = (eqDelta >= 0 ? '+' : '') + eqDelta.toFixed(1) + ' dB'
        const specRaw = preSpectrumRef.current
          ? spectrumDataRef.current?.pre
          : spectrumDataRef.current?.post
        let specStr = '— dBFS'
        if (specRaw && specRaw.length > 0) {
          const nyquist = sampleRate / 2
          const bin = freq * specRaw.length / nyquist
          const b0 = Math.max(0, Math.floor(bin))
          const b1 = Math.min(specRaw.length - 1, b0 + 1)
          const frac = bin - b0
          const db = specRaw[b0] * (1 - frac) + specRaw[b1] * frac
          if (isFinite(db) && db > -150) specStr = db.toFixed(1) + ' dBFS'
        }
        const text = `${freqStr} · ${specStr} · ${deltaStr}`
        if (text !== lastReadoutRef.current) {
          lastReadoutRef.current = text
          setHoverReadout(text)
        }
      } else if (lastReadoutRef.current !== null) {
        lastReadoutRef.current = null
        setHoverReadout(null)
      }

      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        const [resp, spec, gr, meterRaw] = await Promise.all([
          fetchResponseCurve(),
          fetchSpectrumData(),
          fetchBandGR(),
          window.xleth?.audio?.getEffectMeter(target.trackId, target.nodeId),
        ])
        if (!active) return
        if (resp) {
          responseCurveRef.current = resp
          setResponsePath(responseToPath(resp, useEqStore.getState().dbZoom))
        }
        if (spec) {
          spectrumDataRef.current = spec
          const { tiltDbPerOct, rangeDb, speed, resolution } = analyzerRef.current
          const specOpts = {
            barsPerOctave: RESOLUTION_BARS[resolution],
            decayDbPerSec: SPEED_DECAY[speed],
            rangeDb,
          }
          if (spec.post) setSpectrumPaths(computeSpectrumPaths(spec.post, sampleRate / 2, tiltDbPerOct, true, specOpts))
          if (spec.pre) {
            setPreSpectrumPaths(computeSpectrumPaths(spec.pre, sampleRate / 2, tiltDbPerOct, false, specOpts))
          } else {
            resetMaxHold('pre')
            setPreSpectrumPaths({ fill: '', maxHold: '' })
          }
        }
        if (gr) setBandGR(gr)
        if (meterRaw != null) {
          const meters = typeof meterRaw === 'string' ? JSON.parse(meterRaw) : meterRaw
          if (Array.isArray(meters)) {
            meterPeaksRef.current = { l: meters[0] ?? 0, r: meters[1] ?? 0 }
          }
        }
      }
      if (active) rafRef.current = requestAnimationFrame(poll)
    }

    rafRef.current = requestAnimationFrame(poll)
    return () => {
      active = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [target, fetchResponseCurve, fetchSpectrumData, fetchBandGR, sampleRate])

  // Band drag (B7.3 — track movement to distinguish click from drag)
  const handleDragStart = useCallback((bandIndex, e) => {
    const band = useEqStore.getState().bands[bandIndex]
    if (!band) return
    dragRef.current = {
      bandIndex,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startFreq: band.freq,
      startGain: band.gain,
      hasMoved: false,
    }
    document.body.style.cursor = 'grabbing'
  }, [])

  const lastDragSend = useRef(0)

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragRef.current || !svgRef.current) return
      const { bandIndex, startClientX, startClientY, startFreq, startGain } = dragRef.current
      const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY)
      if (dist > 3) dragRef.current.hasMoved = true

      const svg = svgRef.current
      const rect = svg.getBoundingClientRect()
      const scaleX = SVG_W / rect.width
      const scaleY = SVG_H / rect.height
      const dx = (e.clientX - startClientX) * scaleX
      const dy = (e.clientY - startClientY) * scaleY
      const { dbZoom: zoom } = useEqStore.getState()

      const newFreq = clamp(xToFreq(freqToX(startFreq) + dx), FREQ_MIN, FREQ_MAX)
      const newGain = clamp(yToDb_response(dbToY_response(startGain, zoom) + dy, zoom), -30, 30)

      const now = performance.now()
      if (now - lastDragSend.current >= 16) {
        lastDragSend.current = now
        setBandParam(bandIndex, 'freq', Math.round(newFreq * 10) / 10)
        setBandParam(bandIndex, 'gain', Math.round(newGain * 10) / 10)
      }
    }

    const onMouseUp = () => {
      if (!dragRef.current) return
      const { bandIndex, hasMoved } = dragRef.current
      dragRef.current = null
      document.body.style.cursor = ''
      // B7.3 — click (no movement) selects the band
      if (!hasMoved) setSelectedBand(bandIndex)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [setBandParam, setSelectedBand])

  // SVG mousedown — drag existing dot OR add band on curve click
  const handleSvgMouseDown = useCallback((e) => {
    if (dragRef.current) return
    if (e.button !== 0) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * SVG_W
    const my = ((e.clientY - rect.top) / rect.height) * SVG_H
    const { dbZoom: zoom } = useEqStore.getState()

    const currentBands = useEqStore.getState().bands
    let closest = -1
    let closestDist = 20 * 20
    for (let i = 0; i < currentBands.length; i++) {
      const bx = freqToX(currentBands[i].freq)
      const by = dbToY_response(currentBands[i].gain, zoom)
      const d = (bx - mx) ** 2 + (by - my) ** 2
      if (d < closestDist) { closestDist = d; closest = i }
    }

    if (closest >= 0) {
      e.preventDefault()
      handleDragStart(closest, e)
      return
    }

    // Empty space — deselect and check response curve
    setSelectedBand(-1)

    const curve = responseCurveRef.current
    if (!curve) return
    if (mx < PAD_L || mx > PAD_L + PLOT_W) return

    const freq = clamp(xToFreq(mx), FREQ_MIN, FREQ_MAX)
    const curveDb = evalResponseAt(curve, freq)
    const curveY = dbToY_response(clamp(curveDb, -zoom, zoom), zoom)

    if (Math.abs(my - curveY) <= 10) {
      e.preventDefault()
      const bandType =
        freq <= 200   ? BAND_TYPES.indexOf('High Pass') :
        freq >= 10000 ? BAND_TYPES.indexOf('Low Pass')  : 0
      const bandGain = bandType === 0 ? Math.round(curveDb * 10) / 10 : 0
      addBandAt(Math.round(freq * 10) / 10, bandGain, bandType)
    }
  }, [handleDragStart, addBandAt, setSelectedBand])

  // B6 — SVG cursor tracking
  const handleSvgMouseMove = useCallback((e) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_W
    const svgY = ((e.clientY - rect.top) / rect.height) * SVG_H
    cursorRef.current = {
      svgX,
      inPlot: svgX >= PAD_L && svgX <= PAD_L + PLOT_W && svgY >= PAD_T && svgY <= PAD_T + PLOT_H,
    }
  }, [])

  const handleSvgMouseLeave = useCallback(() => {
    cursorRef.current = { svgX: null, inPlot: false }
    lastReadoutRef.current = null
    setHoverReadout(null)
  }, [])

  // Scroll — Q adjustment on nearest band
  const handleWheel = useCallback((e) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const mx = PAD_L + ((e.clientX - rect.left) / rect.width) * SVG_W - PAD_L
    const my = PAD_T + ((e.clientY - rect.top) / rect.height) * SVG_H - PAD_T

    const currentBands = useEqStore.getState().bands
    if (currentBands.length === 0) return

    let closest = 0, closestDist = Infinity
    for (let i = 0; i < currentBands.length; i++) {
      const bx = freqToX(currentBands[i].freq) - PAD_L
      const by = dbToY_response(currentBands[i].gain, useEqStore.getState().dbZoom) - PAD_T
      const d = (bx - mx) ** 2 + (by - my) ** 2
      if (d < closestDist) { closestDist = d; closest = i }
    }

    const band = currentBands[closest]
    const newQ = clamp(band.q * (e.deltaY > 0 ? 0.9 : 1.1), 0.1, 30)
    setBandParam(closest, 'q', Math.round(newQ * 100) / 100)
    e.preventDefault()
  }, [setBandParam])

  if (!target) return null

  // Panel root style applies font CSS vars (font/theme popover UI is gone,
  // but whatever was already saved still applies — see hook comments above).
  const panelStyle = {
    left: panelPos.x,
    top: panelPos.y,
    '--xleth-eq-font-size-scale': themeFontScale,
    ...(themeFont && { '--xleth-eq-font-family': themeFont }),
  }

  // Floating band popup's anchor — the selected orb's live screen position,
  // derived the same way the drag/hover handlers map SVG space to the page.
  const selectedBand = selectedBandIndex >= 0 ? (bands[selectedBandIndex] ?? null) : null
  let popupAnchor = null
  if (selectedBand && svgRef.current) {
    const rect = svgRef.current.getBoundingClientRect()
    const scaleX = rect.width / SVG_W
    const scaleY = rect.height / SVG_H
    popupAnchor = {
      x: rect.left + freqToX(selectedBand.freq) * scaleX,
      y: rect.top + dbToY_response(selectedBand.gain, dbZoom) * scaleY,
    }
  }

  return (
    <div className="eq-panel" style={panelStyle}>
      {/* Header — stripped to title + close only. The removed global controls
          (dB zoom / analyzer tilt / range / speed / resolution / LinPhase /
          oversample / pre-spectrum / font popover) still exist in state
          above; only their button affordances were removed here. */}
      <div className="eq-panel-header" onMouseDown={handlePanelDragStart}>
        <span className="eq-panel-title">Parametric EQ</span>
        <button className="eq-panel-close" onClick={close} title="Close">&times;</button>
      </div>

      {/* SVG + right-side output meter */}
      <div className="eq-graph-row">
        <div className="eq-svg-wrap">
        <svg ref={svgRef} className="eq-svg" viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          preserveAspectRatio="none" onWheel={handleWheel}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={handleSvgMouseLeave}>
          {/* EQ-A: token-driven vertical gradient stops.
              All colors flow through the theme-token pipeline:
                --xleth-eq-spectrum-* → --theme-eq-spectrum-* → catalog. */}
          <defs>
            <linearGradient id="xleth-eq-spectrum-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--xleth-eq-spectrum-top)" />
              <stop offset="100%" stopColor="var(--xleth-eq-spectrum-bottom)" />
            </linearGradient>
            <linearGradient id="xleth-eq-pre-spectrum-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--xleth-eq-pre-spectrum-top)" />
              <stop offset="100%" stopColor="var(--xleth-eq-pre-spectrum-bottom)" />
            </linearGradient>
          </defs>
          <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} className="eq-plot-bg" />
          <EqGrid dbZoom={dbZoom} rangeDb={analyzerSettings.rangeDb} />

          {preSpectrumPaths.fill && (
            <path d={preSpectrumPaths.fill}
              className="eq-spectrum-pre-fill"
              fill="url(#xleth-eq-pre-spectrum-fill)"
              stroke="var(--xleth-eq-pre-spectrum-stroke)" />
          )}
          {preSpectrumPaths.maxHold && (
            <path d={preSpectrumPaths.maxHold} className="eq-spectrum-pre-hold" />
          )}
          {spectrumPaths.fill && (
            <path d={spectrumPaths.fill}
              className="eq-spectrum-fill"
              fill="url(#xleth-eq-spectrum-fill)"
              stroke="var(--xleth-eq-spectrum-stroke)" />
          )}
          {spectrumPaths.maxHold && (
            <path d={spectrumPaths.maxHold} className="eq-spectrum-hold" />
          )}

          {responsePath && (
            <>
              <path d={responsePath} className="eq-response-line" />
              <path d={responsePath} fill="none" stroke="transparent" strokeWidth={20}
                style={{ cursor: 'copy', pointerEvents: 'stroke' }} />
            </>
          )}

          {bands.map((band, i) => (
            <BandDot key={i} band={band} index={i} onDragStart={handleDragStart}
              dbZoom={dbZoom} isSelected={i === selectedBandIndex} />
          ))}
        </svg>

          {/* B6 — hover readout */}
          {hoverReadout && (
            <div className="eq-hover-readout">{hoverReadout}</div>
          )}
        </div>
        <EqOutputMeter peaksRef={meterPeaksRef} active={!!target} />
      </div>

      {/* Floating per-band popup — replaces the old bottom band table +
          selected-band footer. Portaled to document.body so it can overflow
          this panel's own bounds; anchored to the selected orb's live
          on-screen position. */}
      {selectedBand && popupAnchor && (
        <EqBandPopup
          key={selectedBandIndex}
          band={selectedBand}
          bandIndex={selectedBandIndex}
          anchor={popupAnchor}
          linPhase={linPhase}
          oversample={oversample}
          grValue={bandGR ? bandGR[selectedBandIndex] : null}
          setBandParam={setBandParam}
          removeBand={removeBand}
          duplicateBand={duplicateBand}
          onClose={() => setSelectedBand(-1)}
        />
      )}
    </div>
  )
}

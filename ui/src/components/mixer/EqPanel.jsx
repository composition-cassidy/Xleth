import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import { Power } from 'lucide-react'
import useEqStore, { BAND_TYPES, BAND_MODES, BAND_COLORS } from '../../stores/eqStore.js'
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
import SelectedBandInspector from './SelectedBandInspector.jsx'
import EqOutputMeter from './EqOutputMeter.jsx'

// ── Constants ────────────────────────────────────────────────────────────────

const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const ANA_DB_LINES = [-80, -60, -40, -20, 0]

// B8: which types show gain / Q
const TYPE_SHOW_GAIN = [true, true, true, false, false, false, true]  // LP/HP/Notch hide gain
const TYPE_SHOW_Q    = [true, true, true, true,  true,  true,  false] // Tilt hides Q
const TYPE_SHORT     = { 3: 'LP', 4: 'HP', 5: 'Notch' }

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

// ── Band dot (B7 — redesigned) ───────────────────────────────────────────────

function BandDot({ band, index, onDragStart, grValue, dbZoom, isSelected }) {
  const color = BAND_COLORS[index % BAND_COLORS.length]
  const cx = freqToX(band.freq)
  const cy = dbToY_response(band.gain, dbZoom)
  const opacity = band.enabled ? 1 : 0.3

  // B7.1 — Q ring: wider ring = lower Q = broader bandwidth
  const ringRadius = clamp(30 / Math.sqrt(Math.max(0.1, band.q)), 8, 48)

  // B7.4 — GR ring with signed semantics
  const grMagnitude = Math.abs(grValue || 0)
  const showGr = band.mode === 1 && grMagnitude > 0.3
  const grRadius = showGr ? Math.min(20, grMagnitude * 1.8) : 0
  const grColor = (grValue || 0) >= 0 ? 'var(--xleth-eq-gr-boost)' : 'var(--xleth-eq-gr-cut)'

  // Mode color for Q ring
  const modeColor = band.mode === 0
    ? 'var(--xleth-eq-mode-static)'
    : band.mode === 1 ? 'var(--xleth-eq-mode-dynamic)'
    : 'var(--xleth-eq-mode-spectral)'

  // B7.5 — Label text
  const freqStr = band.freq >= 1000
    ? `${(band.freq / 1000).toFixed(1)} kHz`
    : `${Math.round(band.freq)} Hz`
  const noGain = [3, 4, 5].includes(band.type)
  const gainStr = noGain ? '' : ` · ${band.gain >= 0 ? '+' : ''}${band.gain.toFixed(1)}`
  const modeSuffix = band.mode === 1 ? ' · dyn' : band.mode === 2 ? ' · spec' : ''
  const typeSuffix = noGain ? ` · ${TYPE_SHORT[band.type]}` : ''
  const labelText = `${freqStr}${gainStr}${typeSuffix}${modeSuffix}`

  const handleMouseDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onDragStart(index, e)
  }

  return (
    <g className={`eq-band-dot${isSelected ? ' selected' : ''}`} opacity={opacity}>
      {/* GR indicator ring (B7.4) */}
      {grRadius > 0 && (
        <circle cx={cx} cy={cy} r={6 + grRadius} fill="none"
          stroke={grColor} strokeWidth={1.5} opacity={0.65} pointerEvents="none" />
      )}
      {/* Q ring — shown on hover/selected via CSS (B7.1) */}
      <circle className="eq-q-ring" cx={cx} cy={cy} r={ringRadius} fill="none"
        stroke={modeColor} strokeDasharray="2 3" strokeWidth={0.5}
        opacity={0} pointerEvents="none" />
      {/* Selection ring (B7.3) */}
      {isSelected && (
        <circle cx={cx} cy={cy} r={9} fill="none"
          stroke="var(--xleth-eq-accent)" strokeWidth={2} opacity={0.9} pointerEvents="none" />
      )}
      {/* Visible dot */}
      <circle cx={cx} cy={cy} r={6} fill={color} stroke="var(--xleth-eq-bg-plot)" strokeWidth={1.5}
        pointerEvents="none" />
      {/* Mode badge (B7.2) — Dynamic: diamond, Spectral: rotated square */}
      {band.mode === 1 && (
        <polygon
          points={`${cx+5},${cy-9} ${cx+9},${cy-5} ${cx+5},${cy-1} ${cx+1},${cy-5}`}
          fill="var(--xleth-eq-mode-dynamic)" opacity={0.9} pointerEvents="none" />
      )}
      {band.mode === 2 && (
        <rect x={cx+2} y={cy-9} width={6} height={6}
          transform={`rotate(45,${cx+5},${cy-6})`}
          fill="var(--xleth-eq-mode-spectral)" opacity={0.9} pointerEvents="none" />
      )}
      {/* Hit area */}
      <circle cx={cx} cy={cy} r={12} fill="transparent" style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown} />
      {/* Label — below handle, muted unless selected */}
      <text x={cx} y={cy + 22} className="eq-dot-label"
        fill={isSelected ? 'var(--xleth-eq-accent)' : color}>
        {labelText}
      </text>
    </g>
  )
}

// ── Band list row (EQ-C: compact — dynamic/spectral moved to SelectedBandInspector) ──

export function BandRow({ band, index, linPhase, oversample, isSelected, onSelect }) {
  const setBandParam  = useEqStore(s => s.setBandParam)
  const removeBand    = useEqStore(s => s.removeBand)
  const duplicateBand = useEqStore(s => s.duplicateBand)
  const color = BAND_COLORS[index % BAND_COLORS.length]

  // B5 — overflow menu state
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuRef = useRef(null)
  const confirmTimerRef = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handle = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
        setConfirmDelete(false)
        clearTimeout(confirmTimerRef.current)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const handleOverflow = (e) => {
    e.stopPropagation()
    if (!menuOpen) { setConfirmDelete(false); clearTimeout(confirmTimerRef.current) }
    setMenuOpen(v => !v)
  }

  const handleDuplicate = () => { duplicateBand(index); setMenuOpen(false) }

  const handleReset = () => {
    setBandParam(index, 'freq',    1000)
    setBandParam(index, 'gain',    0)
    setBandParam(index, 'q',       0.707)
    setBandParam(index, 'type',    0)
    setBandParam(index, 'enabled', 1)
    setMenuOpen(false)
  }

  const handleDeleteRequest = () => {
    setConfirmDelete(true)
    clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 2000)
  }

  const handleDeleteConfirm = () => {
    clearTimeout(confirmTimerRef.current)
    removeBand(index)
    setMenuOpen(false)
    setConfirmDelete(false)
  }

  // B8 — field visibility
  const showGain = TYPE_SHOW_GAIN[band.type] ?? true
  const showQ    = TYPE_SHOW_Q[band.type]    ?? true

  return (
    <div
      className={`eq-band-row${isSelected ? ' eq-band-row--selected' : ''}`}
      onClick={() => onSelect?.()}
    >
      <div className="eq-band-color" style={{ background: color }} />

      <select className="eq-band-mode" value={band.mode || 0}
        onChange={e => setBandParam(index, 'mode', Number(e.target.value))}>
        {BAND_MODES.map((label, i) => (
          <option key={i} value={i}
            disabled={(i === 1 && linPhase) || (i === 2 && (linPhase || oversample > 0))}
          >{label}</option>
        ))}
      </select>

      <select className="eq-band-type" value={band.type}
        onChange={e => setBandParam(index, 'type', Number(e.target.value))}>
        {BAND_TYPES.map((label, i) => (
          <option key={i} value={i}>{label}</option>
        ))}
      </select>

      {/* Hz — always shown */}
      <label className="eq-band-field">
        <span>Hz</span>
        <input type="number" className="eq-band-input" value={Math.round(band.freq)}
          min={20} max={20000} step={1}
          onChange={e => setBandParam(index, 'freq', clamp(Number(e.target.value), 20, 20000))} />
      </label>

      {/* dB — hidden for LP / HP / Notch (B8) */}
      <label className={`eq-band-field${showGain ? '' : ' na'}`}>
        <span>dB</span>
        {showGain
          ? <input type="number" className="eq-band-input" value={band.gain.toFixed(1)}
              min={-30} max={30} step={0.1}
              onChange={e => setBandParam(index, 'gain', clamp(Number(e.target.value), -30, 30))} />
          : <input type="text" className="eq-band-input" value="—" readOnly />
        }
      </label>

      {/* Q — hidden for Tilt (B8) */}
      <label className={`eq-band-field${showQ ? '' : ' na'}`}>
        <span>Q</span>
        {showQ
          ? <input type="number" className="eq-band-input" value={band.q.toFixed(2)}
              min={0.1} max={30} step={0.01}
              onChange={e => setBandParam(index, 'q', clamp(Number(e.target.value), 0.1, 30))} />
          : <input type="text" className="eq-band-input" value="—" readOnly />
        }
      </label>

      <button className={`eq-band-enable${band.enabled ? ' active' : ''}`}
        title={band.enabled ? 'Disable' : 'Enable'}
        onClick={() => setBandParam(index, 'enabled', band.enabled ? 0 : 1)}>
        <Power size={10} />
      </button>

      {/* ⋯ overflow menu (B5) */}
      <div style={{ position: 'relative' }} ref={menuRef}>
        <button className="eq-band-overflow-btn" title="Band options" onClick={handleOverflow}>
          ···
        </button>
        {menuOpen && (
          <div className="eq-band-overflow-menu">
            {confirmDelete ? (
              <div className="eq-band-overflow-confirm">
                <span>Delete?</span>
                <button onClick={handleDeleteConfirm}>Y</button>
                <button onClick={() => { clearTimeout(confirmTimerRef.current); setConfirmDelete(false) }}>N</button>
              </div>
            ) : (
              <>
                <button onClick={handleDuplicate}>Duplicate</button>
                <button onClick={handleReset}>Reset</button>
                <button className="danger" onClick={handleDeleteRequest}>Delete</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main EQ Panel ────────────────────────────────────────────────────────────

export default function EqPanel() {
  const target = useEqStore(s => s.target)
  const bands = useEqStore(s => s.bands)
  const linPhase = useEqStore(s => s.linPhase)
  const oversample = useEqStore(s => s.oversample)
  const addBandAt = useEqStore(s => s.addBandAt)
  const setBandParam = useEqStore(s => s.setBandParam)
  const setLinPhase = useEqStore(s => s.setLinPhase)
  const setOversample = useEqStore(s => s.setOversample)
  const preSpectrum = useEqStore(s => s.preSpectrum)
  const setPreSpectrum = useEqStore(s => s.setPreSpectrum)
  const dbZoom = useEqStore(s => s.dbZoom)
  const setDbZoom = useEqStore(s => s.setDbZoom)
  const fetchResponseCurve = useEqStore(s => s.fetchResponseCurve)
  const fetchSpectrumData = useEqStore(s => s.fetchSpectrumData)
  const fetchBandGR = useEqStore(s => s.fetchBandGR)
  const sampleRate = useEqStore(s => s.sampleRate)
  const close = useEqStore(s => s.close)
  const selectedBandIndex = useEqStore(s => s.selectedBandIndex)
  const setSelectedBand = useEqStore(s => s.setSelectedBand)
  const themeFont = useEqStore(s => s.themeFont)
  const themeFontScale = useEqStore(s => s.themeFontScale)
  const setThemeFont = useEqStore(s => s.setThemeFont)
  const setThemeFontScale = useEqStore(s => s.setThemeFontScale)

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

  // B4 — theme popover
  const [themeOpen, setThemeOpen] = useState(false)
  const [fontHint, setFontHint] = useState('')
  const themePopoverRef = useRef(null)

  // Refs so polling closure sees current values without restarting the effect
  const analyzerRef = useRef(analyzerSettings)
  useEffect(() => { analyzerRef.current = analyzerSettings }, [analyzerSettings])
  const preSpectrumRef = useRef(preSpectrum)
  useEffect(() => { preSpectrumRef.current = preSpectrum }, [preSpectrum])

  // Band drag state
  const dragRef = useRef(null)

  const hasSpectralBand = bands.some(b => b.mode === 2 && b.enabled)

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

  // B4 — font availability check
  useEffect(() => {
    if (!themeFont) { setFontHint(''); return }
    const t = setTimeout(() => {
      try {
        const ok = document.fonts.check(`12px "${themeFont}"`)
        setFontHint(ok ? '' : 'Not installed — using fallback')
      } catch { setFontHint('') }
    }, 200)
    return () => clearTimeout(t)
  }, [themeFont])

  // B4 — theme popover outside-click close
  useEffect(() => {
    if (!themeOpen) return
    const handle = (e) => {
      if (themePopoverRef.current && !themePopoverRef.current.contains(e.target)) {
        setThemeOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [themeOpen])

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

  // B4 — panel root style applies font CSS vars
  const panelStyle = {
    left: panelPos.x,
    top: panelPos.y,
    '--xleth-eq-font-size-scale': themeFontScale,
    ...(themeFont && { '--xleth-eq-font-family': themeFont }),
  }

  return (
    <div className="eq-panel" style={panelStyle}>
      {/* Header */}
      <div className="eq-panel-header" onMouseDown={handlePanelDragStart}>
        <span className="eq-panel-title">Parametric EQ</span>
        <div className="eq-panel-global">
          <button className="eq-global-btn" onClick={cycleDbZoom}
            title="Response curve dB zoom — cycle 6/12/24/48">
            ±{dbZoom}
          </button>
          <button
            className={`eq-global-btn${analyzerSettings.tiltDbPerOct > 0 ? ' active' : ''}`}
            onClick={() => cycleAnalyzer('tiltDbPerOct', TILT_OPTIONS)}
            title="Pink-noise tilt — cycle 0 / +3 / +4.5 / +6 dB/oct">
            {analyzerSettings.tiltDbPerOct === 0 ? 'Tilt: 0' : `Tilt: +${analyzerSettings.tiltDbPerOct}`}
          </button>
          <button
            className="eq-global-btn"
            onClick={() => cycleAnalyzer('rangeDb', RANGE_OPTIONS)}
            title="Analyzer vertical range — 60 / 90 / 120 dB">
            {analyzerSettings.rangeDb} dB
          </button>
          <button
            className="eq-global-btn"
            onClick={() => cycleAnalyzer('speed', SPEED_OPTIONS)}
            title="Max-hold decay — Slow / Med / Fast">
            {analyzerSettings.speed === 'slow' ? 'Slow' : analyzerSettings.speed === 'fast' ? 'Fast' : 'Med'}
          </button>
          <button
            className="eq-global-btn"
            onClick={() => cycleAnalyzer('resolution', RESOLUTION_OPTIONS)}
            title="Analyzer bar density — Low=12 / Med=18 / High=24 / Max=36 bars/oct">
            {analyzerSettings.resolution === 'maximum' ? 'Max'
              : analyzerSettings.resolution === 'low' ? 'Low'
              : analyzerSettings.resolution === 'medium' ? 'Med'
              : 'High'}
          </button>
          <button className={`eq-global-btn${linPhase ? ' active' : ''}`}
            onClick={() => setLinPhase(!linPhase)}
            title="Linear Phase mode — zero-phase FIR convolution">
            LinPhase
          </button>
          <button className={`eq-global-btn${oversample > 0 ? ' active' : ''}`}
            onClick={() => setOversample((oversample + 1) % 3)}
            disabled={hasSpectralBand}
            title={hasSpectralBand ? 'Disabled: spectral band active' : 'Cycle oversampling: Off → 2x → 4x'}>
            {oversample === 0 ? 'OS: Off' : `OS: ${oversample === 1 ? '2' : '4'}x`}
          </button>
          <button className={`eq-global-btn${preSpectrum ? ' active' : ''}`}
            onClick={() => setPreSpectrum(!preSpectrum)}
            title="Show pre-EQ input spectrum">
            <Power size={8} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />Pre
          </button>
        </div>
        {/* B4 — gear button */}
        <button className="eq-theme-btn" title="Font settings"
          onClick={() => setThemeOpen(v => !v)}>
          ⚙
        </button>
        <button className="eq-panel-close" onClick={close} title="Close">&times;</button>
      </div>

      {/* B4 — font / theme popover */}
      {themeOpen && (
        <div className="eq-theme-popover" ref={themePopoverRef}>
          <div className="eq-theme-popover-row">
            <span className="eq-theme-label">Font family</span>
            <input className="eq-theme-input" type="text"
              value={themeFont}
              placeholder="Inter"
              title="Any font installed on your system. Falls back to Inter if not found."
              onChange={e => setThemeFont(e.target.value)} />
            {fontHint && <span className="eq-theme-hint">{fontHint}</span>}
          </div>
          <div className="eq-theme-popover-row">
            <span className="eq-theme-label">Font size scale</span>
            <div className="eq-theme-slider-row">
              <input className="eq-theme-slider" type="range"
                min={0.7} max={1.4} step={0.05}
                value={themeFontScale}
                onChange={e => setThemeFontScale(Number(e.target.value))} />
              <span className="eq-theme-slider-val">{themeFontScale.toFixed(2)}×</span>
            </div>
          </div>
          <button className="eq-theme-reset-btn" onClick={() => {
            setThemeFont('')
            setThemeFontScale(1)
            setFontHint('')
          }}>Reset to defaults</button>
        </div>
      )}

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
              grValue={bandGR ? bandGR[i] : 0} dbZoom={dbZoom}
              isSelected={i === selectedBandIndex} />
          ))}
        </svg>

          {/* B6 — hover readout */}
          {hoverReadout && (
            <div className="eq-hover-readout">{hoverReadout}</div>
          )}
        </div>
        <EqOutputMeter peaksRef={meterPeaksRef} active={!!target} />
      </div>

      {/* Band list */}
      <div className="eq-band-list">
        {bands.map((band, i) => (
          <BandRow key={i} band={band} index={i}
            linPhase={linPhase} oversample={oversample}
            isSelected={i === selectedBandIndex}
            onSelect={() => setSelectedBand(i)} />
        ))}
      </div>

      {/* EQ-C: mode-specific controls for the selected band */}
      <SelectedBandInspector
        band={selectedBandIndex >= 0 ? bands[selectedBandIndex] : null}
        bandIndex={selectedBandIndex}
        setBandParam={setBandParam}
        grValue={selectedBandIndex >= 0 && bandGR ? bandGR[selectedBandIndex] : null}
      />
    </div>
  )
}

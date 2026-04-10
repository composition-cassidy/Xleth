import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Plus, Trash2, Power } from 'lucide-react'
import useEqStore, { BAND_TYPES, BAND_MODES, BAND_COLORS } from '../../stores/eqStore.js'

// ── Constants ────────────────────────────────────────────────────────────────

const SVG_W = 640
const SVG_H = 280
const PAD_L = 36
const PAD_R = 8
const PAD_T = 8
const PAD_B = 20
const PLOT_W = SVG_W - PAD_L - PAD_R
const PLOT_H = SVG_H - PAD_T - PAD_B

const FREQ_MIN = 20
const FREQ_MAX = 20000
const DB_MIN = -30
const DB_MAX = 30

const RESPONSE_SIZE = 512

// Standard frequency grid lines
const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const DB_GRID = [-24, -12, -6, 0, 6, 12, 24]

// ── Coordinate helpers ───────────────────────────────────────────────────────

function freqToX(f) {
  const t = (Math.log(f) - Math.log(FREQ_MIN)) / (Math.log(FREQ_MAX) - Math.log(FREQ_MIN))
  return PAD_L + t * PLOT_W
}

function xToFreq(x) {
  const t = (x - PAD_L) / PLOT_W
  return Math.exp(Math.log(FREQ_MIN) + t * (Math.log(FREQ_MAX) - Math.log(FREQ_MIN)))
}

function dbToY(db) {
  const t = (db - DB_MAX) / (DB_MIN - DB_MAX)
  return PAD_T + t * PLOT_H
}

function yToDb(y) {
  const t = (y - PAD_T) / PLOT_H
  return DB_MAX + t * (DB_MIN - DB_MAX)
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Interpolate the 512-point response curve to get dB at a given frequency
function evalResponseAt(curveData, freq) {
  const t = (Math.log(freq) - Math.log(FREQ_MIN)) / (Math.log(FREQ_MAX) - Math.log(FREQ_MIN))
  const idx = t * (RESPONSE_SIZE - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(lo + 1, RESPONSE_SIZE - 1)
  const frac = idx - lo
  return curveData[lo] * (1 - frac) + curveData[hi] * frac
}

// ── Grid (memoised SVG elements) ─────────────────────────────────────────────

function EqGrid() {
  return (
    <g className="eq-grid">
      {/* Frequency grid */}
      {FREQ_GRID.map((f, i) => {
        const x = freqToX(f)
        return (
          <g key={`f${f}`}>
            <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + PLOT_H} className="eq-grid-line" />
            <text x={x} y={SVG_H - 3} className="eq-grid-label-x">{FREQ_LABELS[i]}</text>
          </g>
        )
      })}
      {/* dB grid */}
      {DB_GRID.map(db => {
        const y = dbToY(db)
        return (
          <g key={`db${db}`}>
            <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y}
              className={db === 0 ? 'eq-grid-line-zero' : 'eq-grid-line'} />
            <text x={PAD_L - 4} y={y + 3} className="eq-grid-label-y">{db > 0 ? `+${db}` : db}</text>
          </g>
        )
      })}
    </g>
  )
}

// ── Spectrum analyser path (FFT background) ──────────────────────────────────

function spectrumToPath(data, nyquist) {
  if (!data || data.length === 0) return ''
  const bins = data.length
  const parts = [`M ${PAD_L} ${PAD_T + PLOT_H}`]
  for (let i = 0; i < bins; i++) {
    const freq = (i / bins) * nyquist
    if (freq < FREQ_MIN || freq > FREQ_MAX) continue
    const x = freqToX(freq)
    const db = clamp(data[i], DB_MIN, DB_MAX)
    const y = dbToY(db)
    parts.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  parts.push(`L ${PAD_L + PLOT_W} ${PAD_T + PLOT_H} Z`)
  return parts.join(' ')
}

// ── Response curve path ──────────────────────────────────────────────────────

function responseToPath(data) {
  if (!data || data.length === 0) return ''
  const parts = []
  for (let i = 0; i < RESPONSE_SIZE; i++) {
    const t = i / (RESPONSE_SIZE - 1)
    const freq = Math.exp(Math.log(FREQ_MIN) + t * (Math.log(FREQ_MAX) - Math.log(FREQ_MIN)))
    const x = freqToX(freq)
    const db = clamp(data[i], DB_MIN, DB_MAX)
    const y = dbToY(db)
    parts.push(i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  return parts.join(' ')
}

// ── Band dot (draggable) ─────────────────────────────────────────────────────

function BandDot({ band, index, onDragStart, grValue }) {
  const color = BAND_COLORS[index % BAND_COLORS.length]
  const cx = freqToX(band.freq)
  const cy = dbToY(band.gain)
  const opacity = band.enabled ? 1 : 0.3

  const handleMouseDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onDragStart(index, e)
  }

  // Dynamic bands show a GR ring
  const grRadius = (band.mode === 1 && grValue < -0.5) ? Math.min(16, -grValue * 1.5) : 0

  return (
    <g className="eq-band-dot" opacity={opacity}>
      {/* GR indicator ring for Dynamic bands */}
      {grRadius > 0 && (
        <circle cx={cx} cy={cy} r={6 + grRadius} fill="none"
          stroke="#FF4444" strokeWidth={1.5} opacity={0.6} />
      )}
      {/* Visible dot (painted first = behind) */}
      <circle cx={cx} cy={cy} r={6} fill={color} stroke="#0A0A0F" strokeWidth={1.5}
        pointerEvents="none" />
      {/* Larger invisible hit area (painted last = on top) */}
      <circle cx={cx} cy={cy} r={12} fill="transparent" style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown} />
      {/* Frequency label on hover (CSS :hover on parent g) */}
      <text x={cx} y={cy - 12} className="eq-dot-label" fill={color}>
        {band.freq >= 1000 ? `${(band.freq / 1000).toFixed(1)}k` : `${Math.round(band.freq)}`}
        {' '}{band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)}dB
      </text>
    </g>
  )
}

// ── Band list row ────────────────────────────────────────────────────────────

function BandRow({ band, index, linPhase, oversample, grValue }) {
  const setBandParam = useEqStore(s => s.setBandParam)
  const removeBand = useEqStore(s => s.removeBand)
  const color = BAND_COLORS[index % BAND_COLORS.length]

  const hasSpectralBand = band.mode === 2

  return (
    <div className="eq-band-row">
      <div className="eq-band-color" style={{ background: color }} />

      {/* Mode selector */}
      <select className="eq-band-mode"
        value={band.mode || 0}
        onChange={e => setBandParam(index, 'mode', Number(e.target.value))}
      >
        {BAND_MODES.map((label, i) => (
          <option key={i} value={i}
            disabled={(i === 1 && linPhase) || (i === 2 && (linPhase || oversample > 0))}
          >{label}</option>
        ))}
      </select>

      <select className="eq-band-type"
        value={band.type}
        onChange={e => setBandParam(index, 'type', Number(e.target.value))}
      >
        {BAND_TYPES.map((label, i) => (
          <option key={i} value={i}>{label}</option>
        ))}
      </select>

      <label className="eq-band-field">
        <span>Hz</span>
        <input type="number" className="eq-band-input" value={Math.round(band.freq)}
          min={20} max={20000} step={1}
          onChange={e => setBandParam(index, 'freq', clamp(Number(e.target.value), 20, 20000))} />
      </label>

      <label className="eq-band-field">
        <span>dB</span>
        <input type="number" className="eq-band-input" value={band.gain.toFixed(1)}
          min={-30} max={30} step={0.1}
          onChange={e => setBandParam(index, 'gain', clamp(Number(e.target.value), -30, 30))} />
      </label>

      <label className="eq-band-field">
        <span>Q</span>
        <input type="number" className="eq-band-input" value={band.q.toFixed(2)}
          min={0.1} max={30} step={0.01}
          onChange={e => setBandParam(index, 'q', clamp(Number(e.target.value), 0.1, 30))} />
      </label>

      <button className={`eq-band-enable${band.enabled ? ' active' : ''}`}
        title={band.enabled ? 'Disable' : 'Enable'}
        onClick={() => setBandParam(index, 'enabled', band.enabled ? 0 : 1)}
      >
        <Power size={10} />
      </button>

      <button className="eq-band-delete" title="Remove band"
        onClick={() => removeBand(index)}
      >
        <Trash2 size={10} />
      </button>

      {/* Dynamic EQ params */}
      {band.mode === 1 && (
        <div className="eq-band-dyn-fields">
          <label className="eq-band-field">
            <span>Thr</span>
            <input type="number" className="eq-band-input" value={(band.dyn_thresh ?? -20).toFixed(0)}
              min={-60} max={0} step={1}
              onChange={e => setBandParam(index, 'dyn_thresh', clamp(Number(e.target.value), -60, 0))} />
          </label>
          <label className="eq-band-field">
            <span>Rat</span>
            <input type="number" className="eq-band-input" value={(band.dyn_ratio ?? 4).toFixed(1)}
              min={1} max={20} step={0.1}
              onChange={e => setBandParam(index, 'dyn_ratio', clamp(Number(e.target.value), 1, 20))} />
          </label>
          <label className="eq-band-field">
            <span>Atk</span>
            <input type="number" className="eq-band-input" value={(band.dyn_attack ?? 10).toFixed(1)}
              min={0.1} max={100} step={0.1}
              onChange={e => setBandParam(index, 'dyn_attack', clamp(Number(e.target.value), 0.1, 100))} />
          </label>
          <label className="eq-band-field">
            <span>Rel</span>
            <input type="number" className="eq-band-input" value={(band.dyn_release ?? 100).toFixed(0)}
              min={1} max={1000} step={1}
              onChange={e => setBandParam(index, 'dyn_release', clamp(Number(e.target.value), 1, 1000))} />
          </label>
          {grValue != null && grValue < -0.1 && (
            <div className="eq-gr-bar">
              <div className="eq-gr-fill" style={{ width: `${Math.min(100, -grValue * 3)}%` }} />
              <span>{grValue.toFixed(1)} dB</span>
            </div>
          )}
        </div>
      )}

      {/* Spectral Dynamics params */}
      {band.mode === 2 && (
        <div className="eq-band-spec-fields">
          <label className="eq-band-field">
            <span>Sens</span>
            <input type="number" className="eq-band-input" value={(band.spec_sens ?? 0.5).toFixed(2)}
              min={0} max={1} step={0.01}
              onChange={e => setBandParam(index, 'spec_sens', clamp(Number(e.target.value), 0, 1))} />
          </label>
          <label className="eq-band-field">
            <span>Dep</span>
            <input type="number" className="eq-band-input" value={(band.spec_depth ?? 0).toFixed(1)}
              min={-30} max={30} step={0.1}
              onChange={e => setBandParam(index, 'spec_depth', clamp(Number(e.target.value), -30, 30))} />
          </label>
          <label className="eq-band-field">
            <span>Sel</span>
            <input type="number" className="eq-band-input" value={(band.spec_sel ?? 5).toFixed(1)}
              min={1} max={20} step={0.1}
              onChange={e => setBandParam(index, 'spec_sel', clamp(Number(e.target.value), 1, 20))} />
          </label>
        </div>
      )}
    </div>
  )
}

// ── Main EQ Panel ────────────────────────────────────────────────────────────

export default function EqPanel() {
  const target = useEqStore(s => s.target)
  const bands = useEqStore(s => s.bands)
  const linPhase = useEqStore(s => s.linPhase)
  const oversample = useEqStore(s => s.oversample)
  const addBand = useEqStore(s => s.addBand)
  const addBandAt = useEqStore(s => s.addBandAt)
  const setBandParam = useEqStore(s => s.setBandParam)
  const setLinPhase = useEqStore(s => s.setLinPhase)
  const setOversample = useEqStore(s => s.setOversample)
  const preSpectrum = useEqStore(s => s.preSpectrum)
  const setPreSpectrum = useEqStore(s => s.setPreSpectrum)
  const fetchResponseCurve = useEqStore(s => s.fetchResponseCurve)
  const fetchSpectrumData = useEqStore(s => s.fetchSpectrumData)
  const fetchBandGR = useEqStore(s => s.fetchBandGR)
  const sampleRate = useEqStore(s => s.sampleRate)
  const close = useEqStore(s => s.close)

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 340),
    y: 80
  }))
  const panelDragRef = useRef(null)

  // SVG paths (updated by polling, stored in refs for perf)
  const [responsePath, setResponsePath] = useState('')
  const [spectrumPath, setSpectrumPath] = useState('')
  const [preSpectrumPath, setPreSpectrumPath] = useState('')
  const [bandGR, setBandGR] = useState(null)
  const rafRef = useRef(null)
  const lastPollRef = useRef(0)
  const svgRef = useRef(null)
  const responseCurveRef = useRef(null)

  // Drag state
  const dragRef = useRef(null)

  // Check if any band is spectral (for disabling OS toggle)
  const hasSpectralBand = bands.some(b => b.mode === 2 && b.enabled)

  // Panel drag handlers
  const handlePanelDragStart = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('select')) return
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
      const newX = startPanelX + (e.clientX - startMouseX)
      const newY = startPanelY + (e.clientY - startMouseY)
      setPanelPos({
        x: clamp(newX, -540, window.innerWidth - 100),
        y: clamp(newY, 0, window.innerHeight - 100),
      })
    }
    const onMouseUp = () => {
      if (!panelDragRef.current) return
      panelDragRef.current = null
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // 30fps polling loop for spectrum + response curve + band GR
  useEffect(() => {
    if (!target) return
    let active = true

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        const [resp, spec, gr] = await Promise.all([
          fetchResponseCurve(),
          fetchSpectrumData(),
          fetchBandGR(),
        ])
        if (resp) {
          responseCurveRef.current = resp
          setResponsePath(responseToPath(resp))
        }
        if (spec) {
          // Post-EQ spectrum (always present, smoothed in C++)
          if (spec.post) setSpectrumPath(spectrumToPath(spec.post, sampleRate / 2))
          // Pre-EQ spectrum (only when toggled on)
          if (spec.pre) setPreSpectrumPath(spectrumToPath(spec.pre, sampleRate / 2))
          else setPreSpectrumPath('')
        }
        if (gr) setBandGR(gr)
      }
      if (active) rafRef.current = requestAnimationFrame(poll)
    }

    rafRef.current = requestAnimationFrame(poll)
    return () => {
      active = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [target, fetchResponseCurve, fetchSpectrumData, fetchBandGR, sampleRate])

  // Drag handlers
  const handleDragStart = useCallback((bandIndex, e) => {
    const band = useEqStore.getState().bands[bandIndex]
    if (!band) return
    dragRef.current = {
      bandIndex,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startFreq: band.freq,
      startGain: band.gain,
    }
    document.body.style.cursor = 'grabbing'
  }, [])

  // SVG-level: drag existing dot OR click on response curve to add band
  const handleSvgMouseDown = useCallback((e) => {
    if (dragRef.current) return
    if (e.button !== 0) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * SVG_W
    const my = ((e.clientY - rect.top) / rect.height) * SVG_H

    // Check existing dot proximity first
    const currentBands = useEqStore.getState().bands
    let closest = -1
    let closestDist = 20 * 20
    for (let i = 0; i < currentBands.length; i++) {
      const bx = freqToX(currentBands[i].freq)
      const by = dbToY(currentBands[i].gain)
      const d = (bx - mx) ** 2 + (by - my) ** 2
      if (d < closestDist) { closestDist = d; closest = i }
    }

    if (closest >= 0) {
      e.preventDefault()
      handleDragStart(closest, e)
      return
    }

    // No dot nearby — check if click is on the response curve
    const curve = responseCurveRef.current
    if (!curve) return
    if (mx < PAD_L || mx > PAD_L + PLOT_W) return

    const freq = clamp(xToFreq(mx), FREQ_MIN, FREQ_MAX)
    const curveDb = evalResponseAt(curve, freq)
    const curveY = dbToY(clamp(curveDb, DB_MIN, DB_MAX))

    if (Math.abs(my - curveY) <= 10) {
      e.preventDefault()
      const bandType =
        freq <= 200   ? BAND_TYPES.indexOf('High Pass') :
        freq >= 10000 ? BAND_TYPES.indexOf('Low Pass')  :
                        0
      const bandGain = bandType === 0 ? Math.round(curveDb * 10) / 10 : 0
      addBandAt(Math.round(freq * 10) / 10, bandGain, bandType)
    }
  }, [handleDragStart, addBandAt])

  // Throttle ref for drag moves
  const lastDragSend = useRef(0)

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragRef.current || !svgRef.current) return
      const { bandIndex, startClientX, startClientY, startFreq, startGain } = dragRef.current
      const svg = svgRef.current
      const rect = svg.getBoundingClientRect()
      const scaleX = SVG_W / rect.width
      const scaleY = SVG_H / rect.height

      const dx = (e.clientX - startClientX) * scaleX
      const dy = (e.clientY - startClientY) * scaleY

      const newFreq = clamp(xToFreq(freqToX(startFreq) + dx), FREQ_MIN, FREQ_MAX)
      const newGain = clamp(yToDb(dbToY(startGain) + dy), DB_MIN, DB_MAX)

      // 60fps throttle for IPC
      const now = performance.now()
      if (now - lastDragSend.current >= 16) {
        lastDragSend.current = now
        setBandParam(bandIndex, 'freq', Math.round(newFreq * 10) / 10)
        setBandParam(bandIndex, 'gain', Math.round(newGain * 10) / 10)
      }
    }

    const onMouseUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [setBandParam])

  // Scroll = Q adjustment
  const handleWheel = useCallback((e) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const mx = PAD_L + ((e.clientX - rect.left) / rect.width) * SVG_W - PAD_L
    const my = PAD_T + ((e.clientY - rect.top) / rect.height) * SVG_H - PAD_T

    const currentBands = useEqStore.getState().bands
    if (currentBands.length === 0) return

    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < currentBands.length; i++) {
      const bx = freqToX(currentBands[i].freq) - PAD_L
      const by = dbToY(currentBands[i].gain) - PAD_T
      const d = (bx - mx) ** 2 + (by - my) ** 2
      if (d < closestDist) { closestDist = d; closest = i }
    }

    const band = currentBands[closest]
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    const newQ = clamp(band.q * factor, 0.1, 30)
    setBandParam(closest, 'q', Math.round(newQ * 100) / 100)
    e.preventDefault()
  }, [setBandParam])

  if (!target) return null

  return (
    <div className="eq-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="eq-panel-header" onMouseDown={handlePanelDragStart}>
        <span className="eq-panel-title">Parametric EQ</span>
        <div className="eq-panel-global">
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
            Pre
          </button>
        </div>
        <button className="eq-panel-close" onClick={close} title="Close">&times;</button>
      </div>

      {/* SVG display */}
      <svg ref={svgRef} className="eq-svg" viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="none" onWheel={handleWheel} onMouseDown={handleSvgMouseDown}>
        {/* Background */}
        <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} className="eq-plot-bg" />

        <EqGrid />

        {/* Pre-EQ spectrum (behind everything, dimmer) */}
        {preSpectrumPath && (
          <path d={preSpectrumPath} className="eq-spectrum-pre-fill" />
        )}

        {/* Post-EQ spectrum (background fill) */}
        {spectrumPath && (
          <path d={spectrumPath} className="eq-spectrum-fill" />
        )}

        {/* Response curve */}
        {responsePath && (
          <>
            <path d={responsePath} className="eq-response-line" />
            <path d={responsePath} fill="none" stroke="transparent" strokeWidth={20}
              style={{ cursor: 'copy', pointerEvents: 'stroke' }} />
          </>
        )}

        {/* Band dots */}
        {bands.map((band, i) => (
          <BandDot key={i} band={band} index={i} onDragStart={handleDragStart}
            grValue={bandGR ? bandGR[i] : 0} />
        ))}
      </svg>

      {/* Band list */}
      <div className="eq-band-list">
        {bands.map((band, i) => (
          <BandRow key={i} band={band} index={i}
            linPhase={linPhase} oversample={oversample}
            grValue={bandGR ? bandGR[i] : 0} />
        ))}
      </div>
    </div>
  )
}

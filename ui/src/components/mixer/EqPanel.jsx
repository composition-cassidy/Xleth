import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useEqStore, { BAND_TYPES, CHANNEL_META } from '../../stores/eqStore.js'
import {
  SVG_W, SVG_H, PAD_L, PAD_T, PLOT_W, PLOT_H,
  FREQ_MIN, FREQ_MAX, RESPONSE_SIZE,
  freqToX, xToFreq,
  dbToY_response, yToDb_response,
  evalResponseAt, clamp,
} from './eqGeometry.js'
import { computeSpectrumPaths, resetMaxHold } from './eqSpectrumPath.js'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import {
  SPEED_DECAY, RESOLUTION_BARS,
  loadAnalyzerSettings, saveAnalyzerSettings,
} from './eqAnalyzerSettings.js'
import EqCanvas from './EqCanvas.jsx'
import EqBandPanel from './EqBandPanel.jsx'

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

// ── Main EQ Panel ────────────────────────────────────────────────────────────

export default function EqPanel() {
  const target = useEqStore(s => s.target)
  const bands = useEqStore(s => s.bands)
  const addBandAt = useEqStore(s => s.addBandAt)
  const setBandParam = useEqStore(s => s.setBandParam)
  const setBandChannel = useEqStore(s => s.setBandChannel)
  const removeBand = useEqStore(s => s.removeBand)
  const duplicateBand = useEqStore(s => s.duplicateBand)
  // linPhase/oversample/preSpectrum + their setters are engine-synced global
  // params (linear-phase mode, oversampling factor, pre-EQ spectrum capture).
  // Their header toggle buttons were removed in an earlier design pass, but
  // the state/actions stay wired so the owner can re-expose a control later
  // without re-deriving any of this. linPhase/oversample still gate the
  // Dynamic/Spectral mode options in the band panel; preSpectrum still
  // selects which spectrum trace the hover readout reads from below.
  const linPhase = useEqStore(s => s.linPhase)
  const oversample = useEqStore(s => s.oversample)
  const preSpectrum = useEqStore(s => s.preSpectrum)
  // dbZoom (response-curve vertical zoom) — same story: cycle button removed,
  // state/action retained.
  const dbZoom = useEqStore(s => s.dbZoom)
  const fetchResponseCurve = useEqStore(s => s.fetchResponseCurve)
  const fetchSpectrumData = useEqStore(s => s.fetchSpectrumData)
  const fetchBandGR = useEqStore(s => s.fetchBandGR)
  const sampleRate = useEqStore(s => s.sampleRate)
  const close = useEqStore(s => s.close)
  const selectedBandIndex = useEqStore(s => s.selectedBandIndex)
  const setSelectedBand = useEqStore(s => s.setSelectedBand)
  const themeFont = useEqStore(s => s.themeFont)
  const themeFontScale = useEqStore(s => s.themeFontScale)

  const [analyzerSettings] = useState(() => loadAnalyzerSettings())
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
  const responseCurveRef = useRef(null)
  const spectrumDataRef = useRef(null)   // latest spec data for hover readout

  // Hover readout (cursor position on the curve)
  const [hoverReadout, setHoverReadout] = useState(null)
  const cursorRef = useRef({ svgX: null, inPlot: false })
  const lastReadoutRef = useRef(null)

  // Which node is under the pointer — drives the floating identity chip.
  const [hoveredIndex, setHoveredIndex] = useState(null)

  // Refs so polling closure sees current values without restarting the effect
  const analyzerRef = useRef(analyzerSettings)
  useEffect(() => { analyzerRef.current = analyzerSettings }, [analyzerSettings])
  const preSpectrumRef = useRef(preSpectrum)
  useEffect(() => { preSpectrumRef.current = preSpectrum }, [preSpectrum])

  // Band drag state
  const dragRef = useRef(null)

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
        const [resp, spec, gr] = await Promise.all([
          fetchResponseCurve(),
          fetchSpectrumData(),
          fetchBandGR(),
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
      }
      if (active) rafRef.current = requestAnimationFrame(poll)
    }

    rafRef.current = requestAnimationFrame(poll)
    return () => {
      active = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [target, fetchResponseCurve, fetchSpectrumData, fetchBandGR, sampleRate])

  // Band drag (track movement to distinguish click from drag)
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
      if (!hasMoved) setSelectedBand(bandIndex)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [setBandParam, setSelectedBand])

  // SVG mousedown — drag existing node OR add band on curve click
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

  // Cursor tracking (hover readout)
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

  const panelStyle = {
    left: panelPos.x,
    top: panelPos.y,
    '--xleth-eq-font-size-scale': themeFontScale,
    ...(themeFont && { '--xleth-eq-font-family': themeFont }),
  }

  const selectedBand = selectedBandIndex >= 0 ? (bands[selectedBandIndex] ?? null) : null

  const usedChannels = [...new Set(bands.map(b => b.channel || 'stereo'))]

  return (
    <div className="eq-panel" style={panelStyle}>
      <div className="eq-panel-header" onMouseDown={handlePanelDragStart}>
        <span className="eq-panel-title">PARAMETRIC EQ</span>
        <span className="eq-panel-tag">M/S · Per-Channel</span>
        <button className="eq-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="xletheq"
          target={target}
          onApplied={() => {
            useEqStore.getState().fetchBands()
            useEqStore.getState().fetchGlobalParams()
          }}
        />
      </div>

      <div className="eq-graph-row">
        <EqCanvas
          svgRef={svgRef}
          bands={bands}
          selectedBandIndex={selectedBandIndex}
          dbZoom={dbZoom}
          rangeDb={analyzerSettings.rangeDb}
          responsePath={responsePath}
          spectrumPaths={spectrumPaths}
          preSpectrumPaths={preSpectrumPaths}
          hoverReadout={hoverReadout}
          hoveredIndex={hoveredIndex}
          onHoverBand={setHoveredIndex}
          onWheel={handleWheel}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={handleSvgMouseLeave}
          onBandDragStart={handleDragStart}
        />
      </div>

      <div className="eq-panel-footer">
        <div className="eq-panel-channel-legend">
          {usedChannels.map(ch => (
            <span key={ch} className="eq-panel-channel-chip">
              <span className="eq-panel-channel-dot" style={{ background: `var(--xleth-eq-ch-${ch})` }} />
              {CHANNEL_META[ch].label}
            </span>
          ))}
        </div>
        <div className="eq-panel-status">
          <span>{Math.round(sampleRate)} Hz</span>
          <span>Zero Latency</span>
        </div>
      </div>

      {selectedBand && (
        <EqBandPanel
          key={selectedBandIndex}
          band={selectedBand}
          bandIndex={selectedBandIndex}
          bandCount={bands.length}
          svgRef={svgRef}
          dbZoom={dbZoom}
          panelPos={panelPos}
          linPhase={linPhase}
          oversample={oversample}
          grValue={bandGR ? bandGR[selectedBandIndex] : null}
          setBandParam={setBandParam}
          setBandChannel={setBandChannel}
          removeBand={removeBand}
          duplicateBand={duplicateBand}
          onClose={() => setSelectedBand(-1)}
        />
      )}
    </div>
  )
}

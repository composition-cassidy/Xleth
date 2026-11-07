import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { MoreHorizontal } from 'lucide-react'
import {
  DeviceMenu, DeviceSection, DisplayWell, Knob, SegmentedControl, Select, Toggle, formatValue, skewScale,
} from '../../ui-kit'
import {
  eqStoreInitializer, BAND_TYPES, BAND_MODES, CHANNEL_META, CHANNEL_MODES,
} from '../../stores/eqStore.js'
import {
  SVG_W, SVG_H, PAD_L, PAD_T, PLOT_W, PLOT_H, FREQ_MIN, FREQ_MAX,
  freqToX, xToFreq, dbToY_response, yToDb_response, evalResponseAt, clamp, RESPONSE_SIZE,
} from '../mixer/eqGeometry.js'
import { computeSpectrumPaths, resetMaxHold } from '../mixer/eqSpectrumPath.js'
import { SPEED_DECAY, RESOLUTION_BARS, loadAnalyzerSettings } from '../mixer/eqAnalyzerSettings.js'
import { getInspectorFields, inspectorHasGR } from '../mixer/eqInspectorConfig.js'
import EqCanvas from '../mixer/EqCanvas.jsx'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './EqDevice.module.css'

const WELL_W = 512
const FREQ_SCALE = skewScale(FREQ_MIN, FREQ_MAX, 0.23)
const Q_SCALE = skewScale(0.1, 30, 0.18)
const GAIN_MIN = -30
const GAIN_MAX = 30

// ── Response curves ────────────────────────────────────────────────────────
// (ported unchanged from the editor: one trace per routing group, a routed
// trace with no bands on it is a flat 0 dB line under the zero rule and is not
// drawn; the Stereo trace is always drawn.)
function traceToPath(data, dbZoom) {
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

const FLAT_TRACE_DB = 0.01
const isFlatTrace = (data) => {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > FLAT_TRACE_DB) return false
  return true
}
const visibleTraceChannels = (curves) => (
  curves ? CHANNEL_MODES.filter((ch) => curves[ch] && (ch === 'stereo' || !isFlatTrace(curves[ch]))) : []
)
function responseToPaths(curves, dbZoom) {
  const paths = {}
  for (const ch of visibleTraceChannels(curves)) paths[ch] = traceToPath(curves[ch], dbZoom)
  return paths
}

const channelColor = (channel) => `var(--xleth-eq-ch-${channel || 'stereo'})`

// ── The display: polling, drag, add-on-curve, wheel Q, hover readout ──────
// This is the editor's canvas controller, parameterised by a store instance
// instead of the one global store, so several EQ devices can be on screen.
function useEqCanvasController(store) {
  const target = useStore(store, (s) => s.target)
  const bands = useStore(store, (s) => s.bands)
  const dbZoom = useStore(store, (s) => s.dbZoom)
  const preSpectrum = useStore(store, (s) => s.preSpectrum)
  const sampleRate = useStore(store, (s) => s.sampleRate)
  const selectedBandIndex = useStore(store, (s) => s.selectedBandIndex)

  const [analyzerSettings] = useState(() => loadAnalyzerSettings())
  const [responsePaths, setResponsePaths] = useState({})
  const [spectrumPaths, setSpectrumPaths] = useState({ fill: '', maxHold: '' })
  const [preSpectrumPaths, setPreSpectrumPaths] = useState({ fill: '', maxHold: '' })
  const [bandGR, setBandGR] = useState(null)
  const [hoverReadout, setHoverReadout] = useState(null)
  const [hoveredIndex, setHoveredIndex] = useState(null)

  const svgRef = useRef(null)
  const rafRef = useRef(null)
  const lastPollRef = useRef(0)
  const responseCurveRef = useRef(null)
  const spectrumDataRef = useRef(null)
  const cursorRef = useRef({ svgX: null, inPlot: false })
  const lastReadoutRef = useRef(null)
  const dragRef = useRef(null)
  const lastDragSend = useRef(0)
  const analyzerRef = useRef(analyzerSettings)
  const preSpectrumRef = useRef(preSpectrum)
  useEffect(() => { preSpectrumRef.current = preSpectrum }, [preSpectrum])

  // 30 fps polling: response, spectrum, GR, hover readout. Real engine data only.
  useEffect(() => {
    if (!target) return undefined
    let active = true
    resetMaxHold()

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      const st = store.getState()

      const cursor = cursorRef.current
      if (cursor.inPlot && !dragRef.current && responseCurveRef.current?.stereo) {
        const freq = clamp(xToFreq(cursor.svgX), FREQ_MIN, FREQ_MAX)
        const curves = responseCurveRef.current
        const shown = visibleTraceChannels(curves)
        const fmtDelta = (d) => formatValue(d, 'dB', { signed: true })
        const deltaStr = shown.length === 1
          ? fmtDelta(evalResponseAt(curves.stereo, freq))
          : shown.map((ch) => `${CHANNEL_META[ch].short} ${fmtDelta(evalResponseAt(curves[ch], freq))}`).join(' · ')
        const specRaw = preSpectrumRef.current ? spectrumDataRef.current?.pre : spectrumDataRef.current?.post
        let specStr = '—'
        if (specRaw && specRaw.length > 0) {
          const bin = freq * specRaw.length / (st.sampleRate / 2)
          const b0 = Math.max(0, Math.floor(bin))
          const b1 = Math.min(specRaw.length - 1, b0 + 1)
          const db = specRaw[b0] * (1 - (bin - b0)) + specRaw[b1] * (bin - b0)
          if (Number.isFinite(db) && db > -150) specStr = formatValue(db, 'dB')
        }
        const text = `${formatValue(freq, 'Hz')} · ${specStr} · ${deltaStr}`
        if (text !== lastReadoutRef.current) { lastReadoutRef.current = text; setHoverReadout(text) }
      } else if (lastReadoutRef.current !== null) {
        lastReadoutRef.current = null
        setHoverReadout(null)
      }

      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        const [resp, spec, gr] = await Promise.all([st.fetchResponseCurve(), st.fetchSpectrumData(), st.fetchBandGR()])
        if (!active) return
        if (resp) {
          responseCurveRef.current = resp
          setResponsePaths(responseToPaths(resp, store.getState().dbZoom))
        }
        if (spec) {
          spectrumDataRef.current = spec
          const { tiltDbPerOct, rangeDb, speed, resolution } = analyzerRef.current
          const opts = { barsPerOctave: RESOLUTION_BARS[resolution], decayDbPerSec: SPEED_DECAY[speed], rangeDb }
          if (spec.post) setSpectrumPaths(computeSpectrumPaths(spec.post, st.sampleRate / 2, tiltDbPerOct, true, opts))
          if (spec.pre) {
            setPreSpectrumPaths(computeSpectrumPaths(spec.pre, st.sampleRate / 2, tiltDbPerOct, false, opts))
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
  }, [target, store, sampleRate])

  useEffect(() => {
    if (responseCurveRef.current) setResponsePaths(responseToPaths(responseCurveRef.current, dbZoom))
  }, [dbZoom])

  const handleDragStart = useCallback((bandIndex, e) => {
    const band = store.getState().bands[bandIndex]
    if (!band) return
    dragRef.current = {
      bandIndex, startClientX: e.clientX, startClientY: e.clientY,
      startFreq: band.freq, startGain: band.gain, hasMoved: false,
    }
    document.body.style.cursor = 'grabbing'
  }, [store])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragRef.current || !svgRef.current) return
      const { bandIndex, startClientX, startClientY, startFreq, startGain } = dragRef.current
      if (Math.hypot(e.clientX - startClientX, e.clientY - startClientY) > 3) dragRef.current.hasMoved = true
      const rect = svgRef.current.getBoundingClientRect()
      const dx = (e.clientX - startClientX) * (SVG_W / rect.width)
      const dy = (e.clientY - startClientY) * (SVG_H / rect.height)
      const { dbZoom: zoom } = store.getState()
      const newFreq = clamp(xToFreq(freqToX(startFreq) + dx), FREQ_MIN, FREQ_MAX)
      const newGain = clamp(yToDb_response(dbToY_response(startGain, zoom) + dy, zoom), GAIN_MIN, GAIN_MAX)
      const now = performance.now()
      if (now - lastDragSend.current >= 16) {
        lastDragSend.current = now
        store.getState().setBandParam(bandIndex, 'freq', Math.round(newFreq * 10) / 10)
        store.getState().setBandParam(bandIndex, 'gain', Math.round(newGain * 10) / 10)
      }
    }
    const onMouseUp = () => {
      if (!dragRef.current) return
      const { bandIndex, hasMoved } = dragRef.current
      dragRef.current = null
      document.body.style.cursor = ''
      if (!hasMoved) store.getState().setSelectedBand(bandIndex)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [store])

  // Mouse down: drag the nearest token, or add a band when the curve is clicked.
  const handleSvgMouseDown = useCallback((e) => {
    if (dragRef.current || e.button !== 0) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * SVG_W
    const my = ((e.clientY - rect.top) / rect.height) * SVG_H
    const st = store.getState()
    const zoom = st.dbZoom

    let closest = -1
    let closestDist = 20 * 20
    for (let i = 0; i < st.bands.length; i++) {
      const d = (freqToX(st.bands[i].freq) - mx) ** 2 + (dbToY_response(st.bands[i].gain, zoom) - my) ** 2
      if (d < closestDist) { closestDist = d; closest = i }
    }
    if (closest >= 0) {
      e.preventDefault()
      handleDragStart(closest, e)
      return
    }

    st.setSelectedBand(-1)
    // Click-to-add snaps to the standard (Stereo) curve: a new band is Stereo.
    const curve = responseCurveRef.current?.stereo
    if (!curve || mx < PAD_L || mx > PAD_L + PLOT_W) return
    const freq = clamp(xToFreq(mx), FREQ_MIN, FREQ_MAX)
    const curveDb = evalResponseAt(curve, freq)
    const curveY = dbToY_response(clamp(curveDb, -zoom, zoom), zoom)
    if (Math.abs(my - curveY) <= 10) {
      e.preventDefault()
      const bandType = freq <= 200 ? BAND_TYPES.indexOf('High Pass') : freq >= 10000 ? BAND_TYPES.indexOf('Low Pass') : 0
      const bandGain = bandType === 0 ? Math.round(curveDb * 10) / 10 : 0
      st.addBandAt(Math.round(freq * 10) / 10, bandGain, bandType)
    }
  }, [store, handleDragStart])

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

  // Wheel: Q on the nearest band.
  const handleWheel = useCallback((e) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * SVG_W
    const my = ((e.clientY - rect.top) / rect.height) * SVG_H
    const st = store.getState()
    if (st.bands.length === 0) return
    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < st.bands.length; i++) {
      const d = (freqToX(st.bands[i].freq) - mx) ** 2 + (dbToY_response(st.bands[i].gain, st.dbZoom) - my) ** 2
      if (d < closestDist) { closestDist = d; closest = i }
    }
    const newQ = clamp(st.bands[closest].q * (e.deltaY > 0 ? 0.9 : 1.1), 0.1, 30)
    st.setBandParam(closest, 'q', Math.round(newQ * 100) / 100)
    e.preventDefault()
  }, [store])

  return {
    svgRef, bands, dbZoom, selectedBandIndex, analyzerSettings, responsePaths, spectrumPaths,
    preSpectrumPaths, bandGR, hoverReadout, hoveredIndex, setHoveredIndex,
    handleDragStart, handleSvgMouseDown, handleSvgMouseMove, handleSvgMouseLeave, handleWheel,
  }
}

// ── Right-click menu on a band token: its type, then the band actions ─────
function BandTypeMenu({ menu, band, onType, onDuplicate, onDelete, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const key = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = Array.from(ref.current?.querySelectorAll('[role="menuitemradio"],[role="menuitem"]') ?? [])
      if (!items.length) return
      const at = items.indexOf(document.activeElement)
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next].focus()
      e.preventDefault()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    ref.current?.querySelector('[aria-checked="true"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  if (!band) return null
  const left = Math.min(menu.x, window.innerWidth - 168)
  const top = Math.min(menu.y, window.innerHeight - 280)
  return createPortal(
    <div ref={ref} className={styles.menu} role="menu" aria-label={`Band ${menu.index + 1} type`} style={{ left, top }}>
      {BAND_TYPES.map((label, i) => (
        <button
          key={label}
          type="button"
          role="menuitemradio"
          aria-checked={band.type === i}
          className={styles.menuItem}
          onClick={() => { onType(i); onClose() }}
        >
          {label}
        </button>
      ))}
      <div className={styles.menuSep} role="separator" />
      <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { onDuplicate(); onClose() }}>Duplicate</button>
      <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { onDelete(); onClose() }}>Delete band</button>
    </div>,
    document.body,
  )
}

const DYN_LABELS = {
  dyn_thresh: 'Threshold', dyn_ratio: 'Ratio', dyn_attack: 'Attack', dyn_release: 'Release', dyn_range: 'Range',
  spec_sens: 'Sensitivity', spec_sel: 'Selectivity', spec_attack: 'Attack', spec_release: 'Release',
}
const DYN_UNITS = {
  dyn_thresh: 'dB', dyn_ratio: 'ratio', dyn_attack: 'ms', dyn_release: 'ms', dyn_range: 'dB',
  spec_attack: 'ms', spec_release: 'ms',
}
const roundTo = (v, decimals) => Math.round(v * 10 ** decimals) / 10 ** decimals

// Signal order: display (hero) -> Band (the selected one) -> Dynamics (folded).
// No hero control: the curve is the control.
export default function EqDevice({ target, registerApplied, deviceKey }) {
  const storeRef = useRef(null)
  if (storeRef.current === null) storeRef.current = createStore(eqStoreInitializer)
  const store = storeRef.current

  // Each device owns a private store: it opens against its own target and closes
  // on unmount, so a docked device never fights the one open in a window.
  useEffect(() => {
    store.getState().open(target.trackId, target.nodeId, target.storeKey)
    return () => store.getState().close()
  }, [store, target.trackId, target.nodeId, target.storeKey])

  // Presets and A/B write the engine through their adapter; re-read what they set.
  useEffect(() => {
    registerApplied?.(() => {
      store.getState().fetchBands()
      store.getState().fetchGlobalParams()
    })
    return () => registerApplied?.(null)
  }, [registerApplied, store])

  const c = useEqCanvasController(store)
  const linPhase = useStore(store, (s) => s.linPhase)
  const oversample = useStore(store, (s) => s.oversample)
  const setBandParam = useStore(store, (s) => s.setBandParam)
  const setBandChannel = useStore(store, (s) => s.setBandChannel)
  const removeBand = useStore(store, (s) => s.removeBand)
  const duplicateBand = useStore(store, (s) => s.duplicateBand)

  const dynamicsFolded = useDeviceUiStore((s) => s.sections[`${deviceKey}:dynamics`] ?? true)
  const setSectionFolded = useDeviceUiStore((s) => s.setSectionFolded)

  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const idx = c.selectedBandIndex
  const band = idx >= 0 ? (c.bands[idx] ?? null) : null
  const color = band ? channelColor(band.channel) : undefined

  const modeOptions = useMemo(() => BAND_MODES.map((label, i) => ({
    value: i,
    label,
    // Dynamic needs per-sample detection (not linear-phase); Spectral also needs
    // the non-oversampled FFT path.
    disabled: (i === 1 && linPhase) || (i === 2 && (linPhase || oversample > 0)),
  })), [linPhase, oversample])

  const typeOptions = useMemo(() => BAND_TYPES.map((label, i) => ({ value: i, label })), [])
  const channelOptions = useMemo(() => CHANNEL_MODES.map((ch) => ({
    value: ch, label: CHANNEL_META[ch].short, ariaLabel: `${CHANNEL_META[ch].label} only`,
  })), [])

  const onBandContextMenu = useCallback((index, e) => {
    store.getState().setSelectedBand(index)
    setMenu({ index, x: e.clientX, y: e.clientY })
  }, [store])

  const fields = band ? getInspectorFields(band.mode) : []
  const gr = band && c.bandGR ? c.bandGR[idx] : null

  const bandKnobs = band ? (
    <>
      <div className={styles.knobs} style={{ '--ui-value': color }}>
        <Knob
          label="Frequency" value={band.freq} scale={FREQ_SCALE} unit="Hz" defaultValue={1000} size={44} width={64}
          onChange={(v) => setBandParam(idx, 'freq', Math.round(v * 10) / 10)}
          onCommit={(v) => setBandParam(idx, 'freq', Math.round(v * 10) / 10)}
          data-param={`b${idx}_freq`}
        />
        <Knob
          label="Gain" value={band.gain} min={GAIN_MIN} max={GAIN_MAX} unit="dB" defaultValue={0} size={44} width={64}
          bipolar formatOptions={{ signed: true }}
          onChange={(v) => setBandParam(idx, 'gain', Math.round(v * 10) / 10)}
          onCommit={(v) => setBandParam(idx, 'gain', Math.round(v * 10) / 10)}
          data-param={`b${idx}_gain`}
        />
        <Knob
          label="Q" value={band.q} scale={Q_SCALE} defaultValue={0.707} size={44} width={56}
          format={(v) => v.toFixed(2)}
          onChange={(v) => setBandParam(idx, 'q', Math.round(v * 100) / 100)}
          onCommit={(v) => setBandParam(idx, 'q', Math.round(v * 100) / 100)}
          data-param={`b${idx}_q`}
        />
      </div>
      <div className={styles.row}>
        <Select size="sm" ariaLabel="Band type" value={band.type} options={typeOptions} onChange={(v) => setBandParam(idx, 'type', v)} />
        <Select size="sm" ariaLabel="Band mode" value={band.mode || 0} options={modeOptions} onChange={(v) => setBandParam(idx, 'mode', v)} />
      </div>
      <div className={styles.row}>
        <SegmentedControl size="sm" label="Band channel" value={band.channel || 'stereo'} options={channelOptions} onChange={(ch) => setBandChannel(idx, ch)} />
        <Toggle size="sm" on={!!band.enabled} onChange={(on) => setBandParam(idx, 'enabled', on ? 1 : 0)} hint="Turn this band on or off">On</Toggle>
        <DeviceMenu
          label={`More for band ${idx + 1}`}
          items={[
            { label: 'Duplicate band', onSelect: () => duplicateBand(idx) },
            { label: 'Delete band', danger: true, onSelect: () => removeBand(idx) },
          ]}
        >
          <MoreHorizontal aria-hidden="true" />
        </DeviceMenu>
      </div>
    </>
  ) : (
    <p className={styles.empty}>
      Click the curve to add a band.
      <br />Drag a numbered token to move it.
      <br />Scroll over it for Q; right-click for its type.
    </p>
  )

  return (
    <>
      <DisplayWell label="EQ display" width={WELL_W}>
        <div className={styles.display}>
          <EqCanvas
            svgRef={c.svgRef}
            bands={c.bands}
            selectedBandIndex={idx}
            dbZoom={c.dbZoom}
            rangeDb={c.analyzerSettings.rangeDb}
            responsePaths={c.responsePaths}
            spectrumPaths={c.spectrumPaths}
            preSpectrumPaths={c.preSpectrumPaths}
            hoverReadout={c.hoverReadout}
            hoveredIndex={c.hoveredIndex}
            onHoverBand={c.setHoveredIndex}
            onWheel={c.handleWheel}
            onMouseDown={c.handleSvgMouseDown}
            onMouseMove={c.handleSvgMouseMove}
            onMouseLeave={c.handleSvgMouseLeave}
            onBandDragStart={c.handleDragStart}
            onBandContextMenu={onBandContextMenu}
          />
        </div>
      </DisplayWell>

      <DeviceSection title={band ? `Band ${idx + 1}` : 'Band'} width={236}>
        <div className={styles.band}>{bandKnobs}</div>
      </DeviceSection>

      <DeviceSection
        title="Dynamics"
        width={196}
        folded={dynamicsFolded}
        onFoldChange={(f) => setSectionFolded(deviceKey, 'dynamics', f)}
      >
        {fields.length === 0 ? (
          <p className={styles.empty}>Set the selected band&apos;s mode to Dynamic or Spectral.</p>
        ) : (
          <div className={styles.dyn}>
            {fields.map((f) => {
              const isSens = f.key === 'spec_sens'
              const unit = DYN_UNITS[f.key]
              return (
                <Knob
                  key={f.key}
                  label={DYN_LABELS[f.key]}
                  value={band[f.key] ?? f.def}
                  min={f.min}
                  max={f.max}
                  defaultValue={f.def}
                  size={28}
                  width={58}
                  unit={unit}
                  bipolar={f.key === 'dyn_range'}
                  formatOptions={f.key === 'dyn_range' ? { signed: true } : undefined}
                  format={isSens ? (v) => formatValue(v * 100, '%') : (unit ? undefined : (v) => v.toFixed(f.decimals))}
                  onChange={(v) => setBandParam(idx, f.key, roundTo(v, f.decimals))}
                  onCommit={(v) => setBandParam(idx, f.key, roundTo(v, f.decimals))}
                />
              )
            })}
            {inspectorHasGR(band.mode) ? (
              <span className={styles.readout} data-hint="Gain reduction on this band now">
                GR {formatValue(gr ?? 0, 'dB', { signed: true })}
              </span>
            ) : null}
          </div>
        )}
      </DeviceSection>

      {menu ? (
        <BandTypeMenu
          menu={menu}
          band={c.bands[menu.index]}
          onType={(i) => setBandParam(menu.index, 'type', i)}
          onDuplicate={() => duplicateBand(menu.index)}
          onDelete={() => removeBand(menu.index)}
          onClose={closeMenu}
        />
      ) : null}
    </>
  )
}

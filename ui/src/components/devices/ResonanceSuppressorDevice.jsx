import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DeviceSection, DisplayWell, IconButton, SegmentedControl, Select, Toggle, formatValue, logScale,
} from '../../ui-kit'
import DynamicsVisualizerCanvas from '../../plugin-ui/runtime/visualizers/DynamicsVisualizerCanvas.jsx'
import {
  BAND_Q_MAX, BAND_Q_MIN, BAND_TYPE, BAND_TYPE_OPTIONS, BELL_FREQ_MAX_HZ, BELL_FREQ_MIN_HZ,
  BELL_GAIN_MAX_DB, BELL_GAIN_MIN_DB, NUM_BANDS, bandParamIds,
} from '../../plugin-ui/runtime/visualizers/resonanceCurveMapping.js'
import { useEffectMeterPolling, useMeterBus } from '../../plugin-ui/runtime/useEffectMeterPolling.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import ResonanceCurveOverlay, {
  applyParamUpdates, buildBandEditorModel, createAddBandAction, createBandFreqAction, createBandGainAction,
  createBandQAction, createBandTypeAction, createRemoveBandAction, freqToEditorValue, isBandWidthEditable,
} from './ResonanceCurveOverlay.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './ResonanceSuppressorDevice.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcMinus = iconComponent('minus')
const IcPlus = iconComponent('plus')

// Resonance Suppressor as a device.
//
// Hero: the engine's ResonanceBucket stream (128 log-frequency buckets of
// spectrum, detector weighting and reduction) drawn by the resonance painter on
// a log-frequency axis, with the focus curve's handles on top (HP / LP
// boundaries and up to eight focus bands; ResonanceCurveOverlay). The second
// view is the reduction alone.
//
// Sections in signal order: Detection (Soft / Hard, Depth hero, Sharpness,
// Selectivity) -> Time (Attack, Release) -> Focus (the selected focus band:
// shape, focus, sensitivity, width; add, remove) -> Stereo (Stereo / Mid / Side,
// Link) -> Output (Mix, Trim, Delta) -> Processing (latency mode, quality, and
// the high-quality real-time warning).
//
// Writes: knobs and handle drags preview at most once per frame, knobs commit
// once on release (useDeviceParams); switches, add and remove commit once. The
// focus-band edits go through the overlay's own action creators, as the legacy
// docked band editor did. Stock parameters have no undo.

const P = {
  depth: { min: 0, max: 100, def: 50 },
  sharpness: { min: 0, max: 100, def: 50 },
  selectivity: { min: 0, max: 100, def: 50 },
  attack: { min: 1, max: 200, def: 15 },
  release: { min: 10, max: 2000, def: 200 },
  mix: { min: 0, max: 100, def: 100 },
  trim: { min: -12, max: 12, def: 0 },
  stereo_link: { min: 0, max: 100, def: 100 },
}
const SWITCH_DEFAULTS = { delta: 0, processing_mode: 0, hq_engine: 0, quality: 1, stereo_mode: 0, mode: 0, wc_hp: 80, wc_lp: 16000 }
const BAND_DEFAULTS = {
  1: { active: 1, freq: 250 }, 2: { active: 1, freq: 800 }, 3: { active: 1, freq: 2500 }, 4: { active: 1, freq: 8000 },
  5: { active: 0, freq: 500 }, 6: { active: 0, freq: 1500 }, 7: { active: 0, freq: 4000 }, 8: { active: 0, freq: 10000 },
}
const DEFAULTS = Object.freeze({
  ...Object.fromEntries(Object.entries(P).map(([id, p]) => [id, p.def])),
  ...SWITCH_DEFAULTS,
  ...Object.fromEntries(Object.entries(BAND_DEFAULTS).flatMap(([n, b]) => [
    [`wc_b${n}_active`, b.active], [`wc_b${n}_type`, 0], [`wc_b${n}_freq`, b.freq], [`wc_b${n}_gain`, 0], [`wc_b${n}_q`, 1],
  ])),
})

const VIEWS = [
  { value: 'combined', label: 'Spectrum', hint: 'Input spectrum, the focus curve\'s weighting and the reduction' },
  { value: 'reduction', label: 'Reduction', hint: 'Reduction only' },
]
const PRESET_BY_VIEW = { combined: 'resonanceCombined', reduction: 'resonanceReduction' }
const MODE_OPTIONS = [
  { value: 0, label: 'Soft', hint: 'Up to 12 dB of reduction at full depth' },
  { value: 1, label: 'Hard', hint: 'Up to 24 dB of reduction at full depth' },
]
const STEREO_OPTIONS = [
  { value: 0, label: 'Stereo' },
  { value: 1, label: 'Mid', hint: 'Process the mid signal only' },
  { value: 2, label: 'Side', hint: 'Process the side signal only' },
]
const LATENCY_OPTIONS = [
  { value: 0, label: 'Low latency' },
  { value: 1, label: 'High quality', hint: 'Finer analysis, more latency and CPU' },
]
const QUALITY_OPTIONS = [
  { value: 0, label: 'Fast' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'High' },
]
// The high-quality analysis engine (hq_engine; read only while processing_mode is
// High quality). Classic stays the default.
const ENGINE_OPTIONS = [
  { value: 0, label: 'Classic' },
  { value: 1, label: 'New' },
]
const ENGINE_HINT = 'Classic is the original analysis, New the newer engine. Presets do not sound identical across engines.'
// Sharpness and Selectivity act differently in the two engines, so their tooltips follow the engine.
const SHARPNESS_HINT = {
  classic: 'How narrow a peak must be to count as a resonance',
  new: 'Narrows the cut around each resonance',
}
const SELECTIVITY_HINT = {
  classic: 'How far a peak must stand out from its neighbours',
  new: "How far a peak must stand above the spectrum's baseline to be cut. Higher = fewer, more targeted cuts",
}
// Reduction readout: the New engine's meter slot 3 is the largest band cut in dB; Classic keeps
// slot 2 (GAIN_REDUCTION), the mean of the largest cuts as a fraction of 24 dB.
const REDUCTION_METER = {
  classic: { slot: 'GAIN_REDUCTION', scale: 24, hint: 'Average of the largest cuts' },
  new: { slot: 'MAX_BAND_CUT_DB', scale: 1, hint: 'Largest cut' },
}
// Sentence-case shape names (the engine's "Band Reject" is "Protect" in the UI).
const SHAPE_OPTIONS = BAND_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label.charAt(0) + o.label.slice(1).toLowerCase() }))
const FOCUS_SCALE = logScale(BELL_FREQ_MIN_HZ, BELL_FREQ_MAX_HZ)
const RS_HQ_RISK_POLL_MS = 750

export function shouldShowRsHqRealtimeWarning(snapshot) {
  const level = snapshot?.realtimeRsHqRiskLevel
    || snapshot?.resonanceSuppressorHighQuality?.riskLevel
  return level === 'warning' || level === 'overrunning'
}

/** The well's inner height, so the canvas draws at the size it occupies. */
function useHeight() {
  const ref = useRef(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const read = () => setHeight(Math.floor(el.clientHeight))
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, height]
}

// The high-quality mode's real-time risk, polled as the legacy panel did, but
// only while high quality is selected: the warning is about that mode.
function useHqRisk(enabled) {
  const [atRisk, setAtRisk] = useState(false)
  useEffect(() => {
    if (!enabled) { setAtRisk(false); return undefined }
    let cancelled = false
    let timer = null
    const poll = async () => {
      try {
        const snapshot = await window.xleth?.audio?.getAudioPerformanceTelemetry?.()
        if (!cancelled) setAtRisk(shouldShowRsHqRealtimeWarning(snapshot))
      } catch {
        if (!cancelled) setAtRisk(false)
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, RS_HQ_RISK_POLL_MS)
      }
    }
    poll()
    return () => { cancelled = true; if (timer != null) window.clearTimeout(timer) }
  }, [enabled])
  return atRisk
}

// The latency the engine reports for this instance (audio.getEffectLatency), read again
// whenever a setting that moves it changes. Never a table of per-quality numbers.
function useReportedLatency(target, key) {
  const [latency, setLatency] = useState(null)
  useEffect(() => {
    if (!target || typeof window.xleth?.audio?.getEffectLatency !== 'function') return undefined
    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectLatency(target.trackId, target.nodeId)
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!cancelled && obj && obj.ok) setLatency(obj)
      } catch { /* a readout only */ }
    })()
    return () => { cancelled = true }
  }, [target, key])
  return latency
}

function latencyText(latency) {
  if (!latency) return ''
  const ms = Number(latency.latencyMs)
  if (Number.isFinite(ms) && ms > 0) return `${formatValue(ms, 'ms')} latency`
  return Number(latency.latencySamples) > 0 ? `${latency.latencySamples} samples latency` : 'No latency'
}

export default function ResonanceSuppressorDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('resonancesuppressor', DEFAULTS, target)
  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'combined')
  const setView = useDeviceUiStore((s) => s.setView)
  const [wellRef, wellH] = useHeight()
  const [selected, setSelected] = useState(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const v = (id) => (Number.isFinite(params[id]) ? params[id] : DEFAULTS[id])
  const hq = Math.round(v('processing_mode')) === 1
  const atRisk = useHqRisk(hq)
  const newEngine = hq && Math.round(v('hq_engine')) === 1
  const latency = useReportedLatency(target, `${Math.round(v('processing_mode'))}/${Math.round(v('hq_engine'))}/${Math.round(v('quality'))}`)

  // Reduction readout: written straight to the DOM from the meter poll, as the other devices' meters are.
  const meterBus = useMeterBus()
  useEffectMeterPolling(target, meterBus)
  const reductionRef = useRef(null)
  const meter = newEngine ? REDUCTION_METER.new : REDUCTION_METER.classic
  useEffect(() => {
    meterBus.register('device-reduction', meter.slot, (raw) => {
      const db = Math.abs(Number(raw) || 0) * meter.scale
      if (reductionRef.current) reductionRef.current.textContent = `Reduction ${formatValue(db >= 0.05 ? -db : 0, 'dB')}`
    })
    return () => meterBus.unregister('device-reduction')
  }, [meterBus, meter])

  const model = useMemo(() => buildBandEditorModel(params, selected), [params, selected])
  const band = model.selectedBand
  useEffect(() => { if (selected != null && !band) setSelected(null) }, [selected, band])

  // A handle drag previews (one engine write per frame); its last value lands.
  const run = useCallback((action, write) => {
    if (!action) return
    applyParamUpdates(write, action.updates)
  }, [])

  const knob = (id, label, unit, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      label={label}
      value={v(id)}
      min={P[id].min}
      max={P[id].max}
      defaultValue={P[id].def}
      unit={unit}
      size={40}
      width={64}
      data-param={id}
      onChange={(x) => preview(id, x)}
      onCommit={(x) => commit(id, x)}
      {...extra}
    />
  )
  const seg = (id, label, options, extra = {}) => (
    <AutomationTarget paramId={id} target={target}>
      <SegmentedControl
        size="sm"
        label={label}
        value={Math.round(v(id))}
        options={options}
        data-param={id}
        onChange={(x) => commit(id, x)}
        {...extra}
      />
    </AutomationTarget>
  )

  // Three-plus choices or long labels do not fit a section's width as a switch,
  // so those are dropdowns (a Select never grows past its trigger).
  const sel = (id, label, options, width = 112) => (
    <AutomationTarget paramId={id} target={target}>
      <Select
        size="sm"
        width={width}
        ariaLabel={label}
        value={Math.round(v(id))}
        options={options}
        data-param={id}
        onChange={(x) => commit(id, x)}
      />
    </AutomationTarget>
  )

  // Focus band editor: the overlay's action creators, the legacy strip's calls.
  const bandType = band ? band.type : BAND_TYPE.BELL
  const gainMax = bandType === BAND_TYPE.BAND_REJECT ? 0 : BELL_GAIN_MAX_DB
  const bandOptions = model.activeBands.map((b) => ({ value: b.idx, label: `Band ${b.idx}` }))
  const ids = band ? bandParamIds(band.idx) : null
  const focusKnob = (key, label, extra) => (
    <AutomatableKnob
      key={key}
      paramId={ids ? ids[`${key}Id`] : undefined}
      target={target}
      label={label}
      size={40}
      width={60}
      disabled={!band}
      hint={band ? undefined : 'Select a focus band in the display, or add one'}
      data-param={ids ? ids[`${key}Id`] : undefined}
      {...extra}
    />
  )

  return (
    <>
      <DisplayWell
        label="Resonance display"
        width={420}
        views={VIEWS}
        view={view}
        onViewChange={(next) => setView(deviceKey, next)}
        viewsPlacement="header"
      >
        <div ref={wellRef} className={styles.display}>
          <DynamicsVisualizerCanvas
            trackId={target.trackId}
            nodeId={target.nodeId}
            sourceKey="resonance.combined"
            preset={PRESET_BY_VIEW[view] ?? 'resonanceCombined'}
            heightPx={Math.max(64, wellH || 200)}
            params={params}
          />
          <ResonanceCurveOverlay
            params={params}
            setParam={preview}
            selectedBandIdx={selected}
            onSelectBand={setSelected}
          />
        </div>
      </DisplayWell>

      <DeviceSection title="Detection" width={216}>
        {seg('mode', 'Suppression mode', MODE_OPTIONS)}
        <div className={styles.row}>
          {knob('depth', 'Depth', '%', { size: 52, width: 72, hint: 'How much each resonance is pulled down' })}
          {knob('sharpness', 'Sharpness', '%', { width: 68, hint: newEngine ? SHARPNESS_HINT.new : SHARPNESS_HINT.classic })}
          {knob('selectivity', 'Selectivity', '%', { width: 72, hint: newEngine ? SELECTIVITY_HINT.new : SELECTIVITY_HINT.classic })}
        </div>
      </DeviceSection>

      <DeviceSection title="Time" width={76}>
        {knob('attack', 'Attack', 'ms')}
        {knob('release', 'Release', 'ms')}
      </DeviceSection>

      <DeviceSection title="Focus" width={200}>
        <div className={styles.focusHead}>
          <Select
            size="sm"
            ariaLabel="Focus band"
            value={band ? band.idx : ''}
            placeholder={model.activeCount ? 'Select a band' : 'No bands'}
            options={bandOptions}
            onChange={(idx) => setSelected(idx)}
          />
          <IconButton
            size="sm"
            label="Add focus band"
            hint={model.canAddBand ? 'Add a focus band' : `All ${NUM_BANDS} focus bands are in use`}
            disabled={!model.canAddBand}
            onClick={() => {
              const action = createAddBandAction(paramsRef.current)
              if (!action) return
              run(action, commit)
              setSelected(action.idx)
            }}
          >
            <IcPlus size={14} aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            label={band ? `Remove band ${band.idx}` : 'Remove focus band'}
            disabled={!band}
            onClick={() => {
              run(createRemoveBandAction(paramsRef.current, selected), commit)
              setSelected(null)
            }}
          >
            <IcMinus size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <Select
          size="sm"
          ariaLabel="Focus band shape"
          value={bandType}
          options={SHAPE_OPTIONS}
          disabled={!band}
          onChange={(t) => run(createBandTypeAction(paramsRef.current, selected, t), commit)}
        />
        <div className={styles.row}>
          {focusKnob('freq', 'Focus', {
            value: band ? band.freq : 1000, min: BELL_FREQ_MIN_HZ, max: BELL_FREQ_MAX_HZ, scale: FOCUS_SCALE,
            defaultValue: 1000, unit: 'Hz',
            onChange: (hz) => run(createBandFreqAction(selected, freqToEditorValue(hz)), preview),
            onCommit: (hz) => run(createBandFreqAction(selected, freqToEditorValue(hz)), commit),
          })}
          {focusKnob('gain', 'Sens', {
            value: band ? Math.min(band.gain, gainMax) : 0, min: BELL_GAIN_MIN_DB, max: gainMax, defaultValue: 0,
            unit: 'dB', bipolar: true, formatOptions: { signed: true },
            onChange: (db) => run(createBandGainAction(selected, bandType, db), preview),
            onCommit: (db) => run(createBandGainAction(selected, bandType, db), commit),
          })}
          {focusKnob('q', 'Width', {
            value: band ? band.q : 1, min: BAND_Q_MIN, max: BAND_Q_MAX, defaultValue: 1,
            format: (q) => q.toFixed(2),
            disabled: !band || !isBandWidthEditable(bandType),
            onChange: (q) => run(createBandQAction(selected, q), preview),
            onCommit: (q) => run(createBandQAction(selected, q), commit),
          })}
        </div>
      </DeviceSection>

      <DeviceSection title="Stereo" width={128}>
        {sel('stereo_mode', 'Stereo mode', STEREO_OPTIONS)}
        {knob('stereo_link', 'Link', '%', { hint: 'How much the two channels share one detector' })}
      </DeviceSection>

      <DeviceSection title="Output" width={140}>
        <div className={styles.row}>
          {knob('mix', 'Mix', '%')}
          {knob('trim', 'Trim', 'dB', { bipolar: true, formatOptions: { signed: true } })}
        </div>
        <AutomationTarget paramId="delta" target={target}>
          <Toggle
            size="sm"
            on={Math.round(v('delta')) === 1}
            hint="Listen to only what is being removed"
            data-param="delta"
            onChange={(on) => commit('delta', on ? 1 : 0)}
          >
            Delta
          </Toggle>
        </AutomationTarget>
      </DeviceSection>

      <DeviceSection title="Processing" width={176}>
        <div className={styles.column}>
          {sel('processing_mode', 'Latency mode', LATENCY_OPTIONS, 140)}
          {hq ? seg('hq_engine', 'Engine', ENGINE_OPTIONS, { hint: ENGINE_HINT }) : null}
          {sel('quality', 'Quality', QUALITY_OPTIONS, 140)}
          <span ref={reductionRef} className={styles.readout} data-hint={meter.hint}>Reduction {formatValue(0, 'dB')}</span>
          {latency ? <span className={styles.readout} data-hint="Latency this instance adds, as reported by the engine">{latencyText(latency)}</span> : null}
          {atRisk ? (
            <p className={styles.warning} role="alert">Warning: high quality can overrun real-time playback at small buffers or with several high-quality instances.</p>
          ) : null}
        </div>
      </DeviceSection>
    </>
  )
}

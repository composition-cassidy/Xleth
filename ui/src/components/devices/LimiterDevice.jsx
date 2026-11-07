import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeviceSection, DisplayWell, Knob, Meter, Select, formatValue } from '../../ui-kit'
import { getManifest } from '../../plugin-ui/manifests/index.js'
import { PluginUIContext } from '../../plugin-ui/runtime/PluginUIContext.js'
import useStockEffectParams from '../../plugin-ui/runtime/useStockEffectParams.js'
import { useEffectMeterPolling, useMeterBus } from '../../plugin-ui/runtime/useEffectMeterPolling.js'
import VisualizerNode from '../../plugin-ui/runtime/components/VisualizerNode.jsx'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './deviceBody.module.css'

const PLUGIN_ID = 'limiter'
const WELL_W = 280
const GR_SCALE = [0, 6, 12, 24, 40]
const GR_MAX_DB = 40
const PEAK_SCALE = [0, -6, -12, -24, -36]
const PEAK_HOLD_MS = 1500

const VIEWS = [
  { value: 'waveform', label: 'Waveform', hint: 'Input level history with the ceiling line: what crosses it is what the limiter shaves' },
  { value: 'gr', label: 'GR', hint: 'Gain reduction history' },
]
const STYLE_OPTIONS = [
  { value: 0, label: 'Transparent' },
  { value: 1, label: 'Punchy' },
  { value: 2, label: 'Aggressive' },
]

const toDb = (linear) => (linear > 1e-6 ? 20 * Math.log10(linear) : -Infinity)

/** The well's inner height, so the existing canvas draws at the size it occupies. */
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

// The Limiter as a device. Parameter writes, meters and the visualizer stream
// are exactly the plugin-ui runtime's (the same hooks and painters the
// editor's runtime layout used), hosted in a DeviceFrame body.
//
// Signal order: display (hero) -> Gain -> Ceiling -> Character -> GR -> Output.
// Hero control: Ceiling. The engine has no true-peak parameter, so there is no
// true-peak toggle.
export default function LimiterDevice({ target, registerApplied, deviceKey }) {
  const manifest = useMemo(() => getManifest(PLUGIN_ID), [])
  const { params, setParam, syncParamsFromPreset } = useStockEffectParams(PLUGIN_ID, manifest, target)
  const meterBus = useMeterBus()
  useEffectMeterPolling(target, meterBus)

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const ctx = useMemo(() => ({
    target, manifest, params, setParam, meterBus, onClose: null, layoutErrors: [],
  }), [target, manifest, params, setParam, meterBus])

  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'waveform')
  const setView = useDeviceUiStore((s) => s.setView)
  const [wellRef, wellH] = useHeight()

  // ── GR meter: the GAIN_REDUCTION slot, dB of reduction (0 = none).
  const grReadoutRef = useRef(null)
  const subscribeGr = useCallback((push) => {
    meterBus.register('device-gr', 'GAIN_REDUCTION', (raw) => {
      const gr = Math.max(0, Number(raw) || 0)
      push(gr)
      if (grReadoutRef.current) grReadoutRef.current.textContent = formatValue(gr >= 0.05 ? -gr : 0, 'dB')
    })
    return () => meterBus.unregister('device-gr')
  }, [meterBus])

  // ── Output meter: PEAK_L / PEAK_R, the post-limiter linear block peaks.
  const peakReadoutRef = useRef(null)
  const momentaryRef = useRef(null)
  const shortTermRef = useRef(null)
  const subscribePeak = useCallback((push) => {
    let l = 0
    let r = 0
    let held = -Infinity
    let heldAt = 0
    const emit = () => {
      const dbL = toDb(l)
      const dbR = toDb(r)
      push([dbL, dbR])
      const now = performance.now()
      const top = Math.max(dbL, dbR)
      if (top >= held || now - heldAt > PEAK_HOLD_MS) { held = top; heldAt = now }
      if (peakReadoutRef.current) peakReadoutRef.current.textContent = formatValue(held, 'dB')
    }
    meterBus.register('device-peak-l', 'PEAK_L', (raw) => { l = Number(raw) || 0 })
    meterBus.register('device-peak-r', 'PEAK_R', (raw) => { r = Number(raw) || 0; emit() })
    return () => { meterBus.unregister('device-peak-l'); meterBus.unregister('device-peak-r') }
  }, [meterBus])

  useEffect(() => {
    const lufs = (ref) => (raw) => {
      const v = Number(raw)
      if (ref.current) ref.current.textContent = Number.isFinite(v) && v > -69 ? formatValue(v, 'dB', { unitless: true }) : '—'
    }
    meterBus.register('device-lufs-m', 'LUFS_MOMENTARY', lufs(momentaryRef))
    meterBus.register('device-lufs-s', 'LUFS_SHORT_TERM', lufs(shortTermRef))
    return () => { meterBus.unregister('device-lufs-m'); meterBus.unregister('device-lufs-s') }
  }, [meterBus])

  const p = (id) => params[id] ?? manifest.params[id].defaultValue
  const knob = (id, label, unit, extra = {}) => (
    <Knob
      key={id}
      label={label}
      value={p(id)}
      min={manifest.params[id].min}
      max={manifest.params[id].max}
      defaultValue={manifest.params[id].defaultValue}
      unit={unit}
      onChange={(v) => setParam(id, v)}
      onCommit={(v) => setParam(id, v)}
      data-param={id}
      {...extra}
    />
  )

  const heightPx = Math.max(64, wellH || 200)
  const node = view === 'gr'
    ? { id: 'device-gr-history', props: { source: 'limiter.gainReductionHistory', preset: 'limiterGainReduction', heightPx } }
    : { id: 'device-waveform', props: { source: 'limiter.realtime', preset: 'limiterWaveform', heightPx } }

  return (
    <PluginUIContext.Provider value={ctx}>
      <DisplayWell
        label="Limiter display"
        width={WELL_W}
        views={VIEWS}
        view={view}
        onViewChange={(v) => setView(deviceKey, v)}
      >
        <div ref={wellRef} className={styles.display} data-view={view}>
          <VisualizerNode node={node} />
        </div>
      </DisplayWell>

      <DeviceSection title="Gain" width={68}>
        {knob('gain', 'Gain', 'dB', { size: 44, width: 60, hint: 'Input gain into the limiter' })}
      </DeviceSection>

      <DeviceSection title="Ceiling" width={92}>
        {knob('ceiling', 'Ceiling', 'dB', { size: 56, width: 84, hint: 'Ceiling. Output never goes above this level.' })}
      </DeviceSection>

      <DeviceSection title="Character" width={124}>
        <div className={styles.column}>
          <Select
            size="sm"
            ariaLabel="Limiter style"
            value={Math.round(p('style'))}
            options={STYLE_OPTIONS}
            onChange={(v) => setParam('style', v)}
          />
        </div>
        {knob('release', 'Release', 'ms', { size: 44, width: 68 })}
      </DeviceSection>

      <DeviceSection title="GR" width={64} hint="Gain reduction, dB">
        <Meter
          className={styles.grow}
          label="Limiter gain reduction"
          subscribe={subscribeGr}
          direction="down"
          min={0}
          max={GR_MAX_DB}
          scaleDb={GR_SCALE}
          fallDbPerSec={240}
          holdMs={1200}
        />
        <span ref={grReadoutRef} className={styles.readout} aria-live="off" data-hint="Gain reduction now">
          {formatValue(0, 'dB')}
        </span>
      </DeviceSection>

      <DeviceSection title="Output" width={136}>
        <div className={styles.row}>
          <Meter
            className={styles.grow}
            label="Limiter output peak"
            subscribe={subscribePeak}
            channels={2}
            min={-48}
            max={3}
            scaleDb={PEAK_SCALE}
            clipDb={0.1}
            holdMs={1500}
          />
          <div className={styles.readouts}>
            <span className={styles.caption}>Peak</span>
            <span ref={peakReadoutRef} className={styles.readout} aria-live="off" data-hint="Highest output peak in the last moment">
              {formatValue(-Infinity, 'dB')}
            </span>
            <span className={styles.caption}>Momentary LUFS</span>
            <span ref={momentaryRef} className={styles.readout} data-hint="Momentary loudness (400 ms)">—</span>
            <span className={styles.caption}>Short-term LUFS</span>
            <span ref={shortTermRef} className={styles.readout} data-hint="Short-term loudness (3 s)">—</span>
          </div>
        </div>
      </DeviceSection>
    </PluginUIContext.Provider>
  )
}

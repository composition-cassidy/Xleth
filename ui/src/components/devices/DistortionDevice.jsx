import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  DeviceSection, DisplayWell, Meter, SegmentedControl, formatValue, skewScale,
} from '../../ui-kit'
import { getManifest } from '../../plugin-ui/manifests/index.js'
import useStockEffectParams from '../../plugin-ui/runtime/useStockEffectParams.js'
import { useEffectMeterPolling, useMeterBus } from '../../plugin-ui/runtime/useEffectMeterPolling.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import DistortionCurveCanvas from './DistortionCurveCanvas.jsx'
import { plainFormat } from './deviceFormat.js'
import deviceStyles from './deviceBody.module.css'
import styles from './DistortionDevice.module.css'

const PLUGIN_ID = 'distortion'
const WELL_W = 232
const PEAK_SCALE = [0, -6, -12, -24, -36]
const PEAK_HOLD_MS = 1500

// The seven engine modes, in the engine's own order (the value IS the mode id).
const MODE_OPTIONS = [
  { value: 0, label: 'Tube', hint: 'Smooth tanh saturation, even and odd harmonics' },
  { value: 1, label: 'Soft clip', hint: 'Cubic soft clipper' },
  { value: 2, label: 'Hard clip', hint: 'Flat-topped hard clipper' },
  { value: 3, label: 'Analog', hint: 'Biased tanh with a symmetry control' },
  { value: 4, label: 'Crush', hint: 'Bit-depth and sample-rate reduction' },
  { value: 5, label: 'Fuzz', hint: 'Heavy clipping into a one-pole low-pass' },
  { value: 6, label: 'Sine', hint: 'Sine wave-shaper that folds back at high drive' },
]
const FILTER_OPTIONS = [
  { value: 0, label: 'Pre', hint: 'Tone filter before the shaper' },
  { value: 1, label: 'Post', hint: 'Tone filter after the shaper' },
]

// The knob's travel is the engine's own curve where it has one (tone is skewed
// 0.23); drive has always been linear in dB on this control.
const TONE_SCALE = skewScale(20, 20000, 0.23)
const toDb = (linear) => (linear > 1e-6 ? 20 * Math.log10(linear) : -Infinity)

const times = {
  format: (v) => `×${formatValue(v, 'dB', { unitless: true, decimals: 0 })}`,
  parse: (text) => {
    const n = Number(String(text).replace(/[×x]/gi, '').trim())
    return Number.isFinite(n) ? n : null
  },
}

// The Distortion as a device. Parameter writes, the peak meters and the manifest
// are the plugin-ui runtime's: the same hook the editor's runtime layout used
// (useStockEffectParams, one setEffectParameter per change) and the same meter bus.
//
// Signal order: transfer curve (hero) -> Mode -> Drive -> Tone -> Output.
// Hero control: Drive. The engine has no output-level parameter, so Output holds
// the dry/wet Mix and the real peak meters.
export default function DistortionDevice({ target, registerApplied }) {
  const manifest = useMemo(() => getManifest(PLUGIN_ID), [])
  const { params, setParam, syncParamsFromPreset } = useStockEffectParams(PLUGIN_ID, manifest, target)
  const meterBus = useMeterBus()
  useEffectMeterPolling(target, meterBus)

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const p = (id) => params[id] ?? manifest.params[id].defaultValue
  const mode = Math.round(p('mode'))

  const knob = (id, label, extra = {}) => {
    const meta = manifest.params[id]
    return (
      <AutomatableKnob
        key={id}
        paramId={id}
        target={target}
        label={label}
        value={p(id)}
        min={meta.min}
        max={meta.max}
        defaultValue={meta.defaultValue}
        onChange={(v) => setParam(id, v)}
        onCommit={(v) => setParam(id, v)}
        data-param={id}
        {...extra}
      />
    )
  }

  // Output meter: PEAK_L / PEAK_R, the linear block peaks, with a held numeric peak.
  const peakReadoutRef = useRef(null)
  const subscribePeak = useCallback((push) => {
    let l = 0
    let r = 0
    let held = -Infinity
    let heldAt = 0
    meterBus.register('device-peak-l', 'PEAK_L', (raw) => { l = Number(raw) || 0 })
    meterBus.register('device-peak-r', 'PEAK_R', (raw) => {
      r = Number(raw) || 0
      const dbL = toDb(l)
      const dbR = toDb(r)
      push([dbL, dbR])
      const now = performance.now()
      const top = Math.max(dbL, dbR)
      if (top >= held || now - heldAt > PEAK_HOLD_MS) { held = top; heldAt = now }
      if (peakReadoutRef.current) peakReadoutRef.current.textContent = formatValue(held, 'dB')
    })
    return () => { meterBus.unregister('device-peak-l'); meterBus.unregister('device-peak-r') }
  }, [meterBus])

  const analog = mode === 3
  const crush = mode === 4

  return (
    <>
      <DisplayWell label="Distortion transfer curve" width={WELL_W}>
        <div className={styles.display}>
          <DistortionCurveCanvas mode={mode} drive={p('drive')} symmetry={p('symmetry')} bits={p('bits')} />
        </div>
      </DisplayWell>

      <DeviceSection title="Mode" width={300}>
        <div className={styles.mode}>
          <SegmentedControl
            size="sm"
            label="Distortion mode"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(v) => setParam('mode', v)}
          />
          <div className={styles.extras}>
            {knob('symmetry', 'Symmetry', {
              unit: '%', size: 40, width: 72, disabled: !analog,
              hint: analog ? 'How far the Analog shaper leans off centre' : 'Symmetry applies to the Analog mode',
            })}
            {knob('bits', 'Bits', {
              size: 40, width: 72, disabled: !crush, format: plainFormat(0), quantize: Math.round,
              hint: crush ? 'Bit depth of the Crush quantiser' : 'Bits applies to the Crush mode',
            })}
            {knob('downsample', 'Downsample', {
              size: 40, width: 72, disabled: !crush, format: times.format, parse: times.parse, quantize: Math.round,
              hint: crush ? 'Sample-and-hold factor of the Crush mode' : 'Downsample applies to the Crush mode',
            })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Drive" width={92}>
        {knob('drive', 'Drive', { unit: 'dB', skew: 0.5, size: 56, width: 84, hint: 'Input drive into the shaper' })}
      </DeviceSection>

      <DeviceSection title="Tone" width={124}>
        <div className={deviceStyles.stack}>
          {knob('tone', 'Tone', { unit: 'Hz', scale: TONE_SCALE, skew: 0.23, size: 44, width: 72 })}
          <span className={deviceStyles.caption}>Filter position</span>
          <SegmentedControl
            size="sm"
            label="Tone filter position"
            value={Math.round(p('filter_pos'))}
            options={FILTER_OPTIONS}
            onChange={(v) => setParam('filter_pos', v)}
          />
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={160}>
        <div className={deviceStyles.row}>
          <div className={deviceStyles.stack}>
            {knob('mix', 'Mix', { unit: '%', size: 44, width: 68 })}
          </div>
          <Meter
            className={deviceStyles.grow}
            label="Distortion output peak"
            subscribe={subscribePeak}
            channels={2}
            min={-48}
            max={3}
            scaleDb={PEAK_SCALE}
            clipDb={0.1}
            holdMs={PEAK_HOLD_MS}
          />
          <div className={deviceStyles.readouts}>
            <span className={deviceStyles.caption}>Peak</span>
            <span ref={peakReadoutRef} className={deviceStyles.readout} aria-live="off" data-hint="Highest output peak in the last moment">
              {formatValue(-Infinity, 'dB')}
            </span>
          </div>
        </div>
      </DeviceSection>
    </>
  )
}

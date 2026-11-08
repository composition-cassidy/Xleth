import React, { useCallback, useEffect, useRef } from 'react'
import {
  DeviceSection, Meter, SegmentedControl, Select, formatValue,
} from '../../ui-kit'
import { useEffectMeterPolling, useMeterBus } from '../../plugin-ui/runtime/useEffectMeterPolling.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import { plainFormat } from './deviceFormat.js'
import useDeviceParams from './useDeviceParams.js'
import deviceStyles from './deviceBody.module.css'
import styles from './AmpDevice.module.css'

// Every id is an existing engine parameter (XlethAmpEffect::createLayout());
// ranges mirror its NormalisableRange bounds, so the device never sends a value
// the engine would clamp. Sag and Tighten default to 5 = "this model's own
// value" (the engine encodes the per-model default that way because APVTS
// defaults are static); Gate defaults to 0 = off.
const KNOBS = {
  drive: { min: 0, max: 10, def: 5 },
  bass: { min: 0, max: 10, def: 5 },
  mid: { min: 0, max: 10, def: 5 },
  treble: { min: 0, max: 10, def: 5 },
  presence: { min: 0, max: 10, def: 5 },
  sag: { min: 0, max: 10, def: 5 },
  tighten: { min: 0, max: 10, def: 5 },
  gate: { min: 0, max: 10, def: 0 },
  mix: { min: 0, max: 100, def: 100 },
  output: { min: -24, max: 12, def: 0 },
}
const MODEL_DEFAULT = 3 // Modern Tight, the engine default
const CAB_DEFAULT = 0 // Auto
const DEFAULTS = Object.freeze({
  ...Object.fromEntries(Object.entries(KNOBS).map(([id, k]) => [id, k.def])),
  model: MODEL_DEFAULT,
  cab: CAB_DEFAULT,
})

// The engine's choice strings, in its order (the value IS the index).
const MODELS = [
  ['Blackface', 'Blackface Clean'],
  ['Tweed', 'Tweed Crunch'],
  ['Plexi', 'Plexi'],
  ['Modern', 'Modern Tight'],
  ['Rectifier', 'Rectifier'],
  ['Precision', 'Precision'],
]
const MODEL_OPTIONS = MODELS.map(([label, full], value) => ({ value, label, hint: full }))
const CAB_LABELS = ['Auto', 'Open-back 1x12', 'Alnico 2x12', 'Greenback 4x12', 'V30 4x12']
const CAB_OPTIONS = CAB_LABELS.map((label, value) => ({ value, label }))

const PEAK_SCALE = [0, -6, -12, -24, -36]
const PEAK_HOLD_MS = 1500
const amount = plainFormat(1)
const toDb = (linear) => (linear > 1e-6 ? 20 * Math.log10(linear) : -Infinity)

// The engine returns choice params as floats; round and clamp defensively.
const choiceIndex = (value, count) => {
  const idx = Math.round(Number(value))
  return Number.isFinite(idx) ? Math.max(0, Math.min(count - 1, idx)) : 0
}

// The Amp Stack as a device: one look, no skins. The model re-voices the whole
// chain, so the Model switch is the hero (as the character compressors' switch
// is), one click, and it commits while playing. Knobs preview per frame and
// commit on release; the choice parameters are single commits.
//
// Signal order: Input (Model, Drive, Gate, Tighten) -> Tone -> Power -> Cabinet ->
// Output. The engine publishes no curve or spectrum for the amp, so there is no
// display: the only live data is the output peak (PEAK_L / PEAK_R, written after
// the mix and the output gain), which is the meter in Output.
export default function AmpDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('amp', DEFAULTS, target)
  const meterBus = useMeterBus()
  useEffectMeterPolling(target, meterBus)

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const model = choiceIndex(params.model, MODELS.length)
  const cab = choiceIndex(params.cab, CAB_LABELS.length)

  const knob = (id, label, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      label={label}
      value={params[id]}
      min={KNOBS[id].min}
      max={KNOBS[id].max}
      defaultValue={KNOBS[id].def}
      size={44}
      width={64}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  // Output meter: PEAK_L / PEAK_R with a held numeric peak.
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

  return (
    <>
      <DeviceSection title="Input" width={296}>
        <div className={styles.input}>
          <SegmentedControl
            size="md"
            label="Amp model"
            value={model}
            options={MODEL_OPTIONS}
            onChange={(v) => commit('model', v)}
            hint="Amp model. It re-voices the whole chain."
          />
          <div className={styles.row}>
            {knob('drive', 'Drive', { format: amount, size: 56, width: 84, hint: 'Input drive into the preamp' })}
            {knob('gate', 'Gate', { format: amount, hint: 'Noise gate threshold. 0 is off.' })}
            {knob('tighten', 'Tighten', { format: amount, hint: 'Low-end tightening before the preamp. 5 is this model’s own setting.' })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Tone" width={268}>
        <div className={styles.row}>
          {knob('bass', 'Bass', { format: amount })}
          {knob('mid', 'Mid', { format: amount })}
          {knob('treble', 'Treble', { format: amount })}
          {knob('presence', 'Presence', { format: amount })}
        </div>
      </DeviceSection>

      <DeviceSection title="Power" width={76}>
        {knob('sag', 'Sag', { format: amount, hint: 'Power-supply sag. 5 is this model’s own setting.' })}
      </DeviceSection>

      <DeviceSection title="Cabinet" width={172}>
        <div className={deviceStyles.column}>
          <Select
            size="sm"
            ariaLabel="Cabinet"
            value={cab}
            options={CAB_OPTIONS}
            onChange={(v) => commit('cab', v)}
            hint="Cabinet impulse response. Independent of the model."
          />
          <span className={deviceStyles.caption}>
            {cab === 0 ? `Auto follows the ${MODELS[model][1]} cabinet` : 'Set by hand'}
          </span>
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={196}>
        <div className={deviceStyles.row}>
          <div className={deviceStyles.stack}>
            {knob('mix', 'Mix', { unit: '%' })}
            {knob('output', 'Output', { unit: 'dB', formatOptions: { signed: true }, bipolar: true })}
          </div>
          <Meter
            className={deviceStyles.grow}
            label="Amp output peak"
            subscribe={subscribePeak}
            channels={2}
            min={-36}
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

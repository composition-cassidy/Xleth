import React, { useEffect } from 'react'
import { DeviceSection, SegmentedControl, Select, Toggle } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import { fractionPercent, suffixFormat } from './deviceFormat.js'
import useDeviceParams from './useDeviceParams.js'
import deviceStyles from './deviceBody.module.css'
import styles from './PitchShifterDevice.module.css'

// Every id is an existing engine parameter (XlethPitchShifterEffect::createLayout());
// ranges and defaults are the engine's.
//
// Four modes use two different parameter sets:
//   Granular      mix, semitones, cents, size
//   Smart, Voice  mix, semitones, cents, formant
//   Clip          mix, clip_semitones, clip_cents, clip_method, clip_formant
// `mode`, `clip_method` and `clip_formant` are not automatable in the engine, so
// they are a switch, a select and a toggle (single commits), never knobs; `mode`
// also moves the effect's latency. The pitch pair is bound to the live or the clip
// parameters by mode, so the hero never moves.
const DEFAULTS = Object.freeze({
  mode: 0,
  mix: 1,
  semitones: 0,
  cents: 0,
  size: 50,
  formant: 1,
  clip_semitones: 0,
  clip_cents: 0,
  clip_method: 1, // Rubber, the engine's default
  clip_formant: 0,
})

const MODES = [
  { value: 0, label: 'Granular', hint: 'Granular shifter. Pitch moves with the spectral envelope.' },
  { value: 1, label: 'Smart', hint: 'Smart live shifter with formant control.' },
  { value: 2, label: 'Voice', hint: 'Voice live shifter with formant control.' },
  { value: 3, label: 'Clip', hint: 'Clip mode. An offline render for audio clips; the live controls do not apply.' },
]
const CLIP_METHODS = ['PSOLA', 'Rubber', 'WSOLA', 'PhaseVocoder', 'WORLD']
const CLIP_METHOD_OPTIONS = CLIP_METHODS.map((label, value) => ({ value, label }))

const ST = suffixFormat('st', 1, true)
const CT = suffixFormat('ct', 0, true)
const FORMANT = suffixFormat('×', 2)

const choiceIndex = (value, count) => {
  const idx = Math.round(Number(value))
  return Number.isFinite(idx) ? Math.max(0, Math.min(count - 1, idx)) : 0
}

export default function PitchShifterDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('pitchshifter', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const mode = choiceIndex(params.mode, MODES.length)
  const isGranular = mode === 0
  const isLive = mode === 1 || mode === 2
  const isClip = mode === 3
  const semitonesId = isClip ? 'clip_semitones' : 'semitones'
  const centsId = isClip ? 'clip_cents' : 'cents'

  // Clip parameters are not automatable: no paramId, so the knob is an ordinary one.
  const knob = (id, label, min, max, def, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id.startsWith('clip_') ? undefined : id}
      target={target}
      label={label}
      value={params[id]}
      min={min}
      max={max}
      defaultValue={def}
      size={44}
      width={64}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  return (
    <>
      <DeviceSection title="Pitch" width={236}>
        <div className={styles.pitch}>
          <SegmentedControl
            size="md"
            label="Mode"
            value={mode}
            options={MODES}
            onChange={(v) => commit('mode', v)}
            hint="Shifting mode. Changing it changes the effect's latency."
          />
          <div className={styles.row}>
            {knob(semitonesId, 'Semitones', -24, 24, 0, {
              size: 56, width: 96, bipolar: true, format: ST.format, parse: ST.parse,
              hint: 'Pitch shift in semitones',
            })}
            {knob(centsId, 'Cents', -100, 100, 0, {
              bipolar: true, format: CT.format, parse: CT.parse, hint: 'Fine pitch in cents',
            })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title={isClip ? 'Clip' : 'Character'} width={isClip ? 148 : 84}>
        <div className={deviceStyles.column}>
          {isGranular ? knob('size', 'Grain size', 10, 100, 50, {
            unit: 'ms', formatOptions: { decimals: 0 }, hint: 'Grain length',
          }) : null}
          {isLive ? knob('formant', 'Formant', 0.5, 2, 1, {
            format: FORMANT.format, parse: FORMANT.parse, hint: 'Formant ratio. 1 leaves the spectral envelope alone.',
          }) : null}
          {isClip ? (
            <>
              <Select
                size="sm"
                ariaLabel="Clip stretch method"
                value={choiceIndex(params.clip_method, CLIP_METHODS.length)}
                options={CLIP_METHOD_OPTIONS}
                onChange={(v) => commit('clip_method', Number(v))}
                hint="Clip stretch method. PSOLA and WORLD resynthesize, so a middle Mix can comb. Rubber, WSOLA and PhaseVocoder blend cleanly."
              />
              <Toggle
                size="sm"
                on={params.clip_formant >= 0.5}
                onChange={(on) => commit('clip_formant', on ? 1 : 0)}
                hint="Preserve the formants of the clip"
              >
                Formant
              </Toggle>
              <span className={deviceStyles.caption}>Audio clips only</span>
            </>
          ) : null}
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={72}>
        {knob('mix', 'Mix', 0, 1, 1, { format: fractionPercent.format, parse: fractionPercent.parse })}
      </DeviceSection>
    </>
  )
}

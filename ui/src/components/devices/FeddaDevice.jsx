import React, { useEffect } from 'react'
import { DeviceSection, DisplayWell, NumberBox, SegmentedControl, Toggle, Button, formatValue, logScale, parseValue } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import FeddaFieldCanvas from './FeddaFieldCanvas.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import deviceStyles from './deviceBody.module.css'
import styles from './FeddaDevice.module.css'

// Every id, range and default is XlethFeddaEffect::createLayout(). Fedda builds a synthetic side
// signal from the mid and adds it to L / subtracts it from R, so the mono sum is the input exactly.
// `variation` is excluded from DEFAULTS' meaning of "default": the engine gives every new instance
// its own seed and this only mirrors it after hydration.
const DEFAULTS = Object.freeze({
  width: 50, character: 1, size: 8, low_bypass: 150, low_slope: 0, hf_damp: 20000,
  guard: 0, variation: 0, loudness_match: 0, mono_check: 0, compare: 0,
})
const RANGES = {
  width: [0, 200],
  size: [0.5, 30],
  low_bypass: [20, 2000],
  hf_damp: [2000, 20000],
  guard: [0, 100],
  variation: [0, 999],
}
// The engine's NormalisableRange skews (automation maths only; the knobs travel on log scales).
const SKEW = { size: 0.32, low_bypass: 0.29, hf_damp: 0.485 }
const HF_OFF = 20000

const CHARACTERS = [
  { value: 0, label: 'Comb', hint: 'Delayed copy of the mid in the side. The biggest spread; each channel is comb-filtered, and pitched notes can wander in the image.' },
  { value: 1, label: 'Diffuse', hint: 'All-pass cascade. Flat, irregular colour, no note-dependent wander. Best for pitch samples.' },
  { value: 2, label: 'Velvet', hint: 'Sparse noise decorrelator. Cleanest transients, especially with Transient guard. Best for percussion.' },
]
const SLOPES = [
  { value: 0, label: '12 dB', hint: 'Low bypass slope: 12 dB per octave' },
  { value: 1, label: '24 dB', hint: 'Low bypass slope: 24 dB per octave' },
]

const WELL_W = 236

// 100 % is a detent: the output correlation reaches 0 there ("full" stereo).
const widthFormat = (v) => `${formatValue(v, '%', { decimals: 0 })}${Math.round(v) === 100 ? ' full' : ''}`
const widthParse = (text) => parseValue(String(text).replace(/full/i, ''), '%')
const widthDetent = (v) => (Math.abs(v - 100) < 1.5 ? 100 : v)
const hfFormat = (v) => (v >= HF_OFF - 0.5 ? 'Off' : formatValue(v, 'Hz'))
const hfParse = (text) => (/off/i.test(String(text)) ? HF_OFF : parseValue(text, 'Hz'))
const seedFormat = (v) => String(Math.round(v))
const seedParse = (text) => {
  const n = Number.parseInt(String(text).trim(), 10)
  return Number.isFinite(n) ? n : null
}

// Signal order: display -> Decorrelator (Character, Size) -> Lows (Low bypass) -> Width (hero) ->
// Advanced (HF damp, slope, guard, seed, loudness match; folds) -> Monitor (never rendered).
export default function FeddaDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('fedda', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const advancedFolded = useDeviceUiStore((s) => s.sections[`${deviceKey}:advanced`] ?? true)
  const setSectionFolded = useDeviceUiStore((s) => s.setSectionFolded)

  const knob = (id, label, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      skew={SKEW[id] ?? 1}
      label={label}
      value={params[id]}
      min={RANGES[id][0]}
      max={RANGES[id][1]}
      defaultValue={DEFAULTS[id]}
      size={44}
      width={64}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  const character = Math.max(0, Math.min(2, Math.round(Number(params.character))))
  const mono = Number(params.mono_check) >= 0.5
  const compare = Number(params.compare) >= 0.5

  return (
    <>
      <DisplayWell label="Fedda display" width={WELL_W}>
        <div className={deviceStyles.display}>
          <FeddaFieldCanvas target={target} params={params} />
        </div>
      </DisplayWell>

      <DeviceSection title="Decorrelator" width={176}>
        <div className={deviceStyles.column}>
          <AutomationTarget paramId="character" target={target}>
            <SegmentedControl
              size="sm"
              label="Character"
              value={character}
              options={CHARACTERS}
              onChange={(v) => commit('character', v)}
              hint="How the side signal is made. Switching crossfades."
            />
          </AutomationTarget>
          <div className={styles.centre}>
            {knob('size', 'Size', {
              scale: logScale(RANGES.size[0], RANGES.size[1]), unit: 'ms',
              hint: 'Comb: the delay. Diffuse and Velvet: the length of the decorrelator. Changes crossfade.',
            })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Lows" width={80}>
        {knob('low_bypass', 'Low bypass', {
          scale: logScale(RANGES.low_bypass[0], RANGES.low_bypass[1]), unit: 'Hz',
          hint: 'Below this the side signal is cut, so kick, bass and sub stay mono.',
        })}
      </DeviceSection>

      <DeviceSection title="Width" width={104}>
        {knob('width', 'Width', {
          size: 56, width: 96, format: widthFormat, parse: widthParse, quantize: widthDetent,
          hint: 'Side gain. 100 % is full stereo: the output L/R correlation reaches 0. Above 100 % the image goes past the speakers. The mono sum never changes.',
        })}
      </DeviceSection>

      <DeviceSection
        title="Advanced"
        width={296}
        folded={advancedFolded}
        onFoldChange={(f) => setSectionFolded(deviceKey, 'advanced', f)}
      >
        <div className={styles.advanced}>
          <div className={deviceStyles.pair}>
            {knob('hf_damp', 'HF damp', {
              scale: logScale(RANGES.hf_damp[0], RANGES.hf_damp[1]), format: hfFormat, parse: hfParse,
              hint: 'Low-pass on the side signal; tames a hissy side on bright sources. Fully right is off.',
            })}
            {knob('guard', 'Guard', {
              unit: '%',
              hint: 'Transient guard: ducks the side signal on onsets, so claps and snares stay centred and tight.',
            })}
          </div>
          <div className={styles.controls}>
            <AutomationTarget paramId="low_slope" target={target}>
              <SegmentedControl
                size="sm"
                label="Low bypass slope"
                value={Number(params.low_slope) >= 0.5 ? 1 : 0}
                options={SLOPES}
                onChange={(v) => commit('low_slope', v)}
              />
            </AutomationTarget>
            <div className={styles.seedRow}>
              <NumberBox
                label="Variation"
                caption="Seed"
                value={Math.round(Number(params.variation))}
                min={RANGES.variation[0]}
                max={RANGES.variation[1]}
                step={1}
                quantize={Math.round}
                format={seedFormat}
                parse={seedParse}
                width={64}
                onChange={(v) => preview('variation', v)}
                onCommit={(v) => commit('variation', v)}
                hint="Picks this instance's decorrelator. Every new Fedda gets its own, so a mix full of them does not phase on the bus."
                data-param="variation"
              />
              <Button
                size="sm"
                onClick={() => commit('variation', Math.floor(Math.random() * 1000))}
                hint="Draw a new seed for this instance"
              >
                New seed
              </Button>
            </div>
            <Toggle
              size="sm"
              on={Number(params.loudness_match) >= 0.5}
              onChange={(on) => commit('loudness_match', on ? 1 : 0)}
              hint="Keeps the stereo loudness constant as the width changes. The mono sum then drops (3 dB at 100 %), so this is off by default."
            >
              Loudness match
            </Toggle>
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Monitor" width={112}>
        <div className={styles.monitor}>
          <Toggle
            size="sm"
            on={mono}
            onChange={(on) => commit('mono_check', on ? 1 : 0)}
            hint="Listen to the mono sum. Monitoring only: never saved, never rendered."
          >
            Mono
          </Toggle>
          <Toggle
            size="sm"
            on={compare}
            onChange={(on) => commit('compare', on ? 1 : 0)}
            hint="Hear the dry input at the processed loudness, so wider does not win just by being louder. Monitoring only: never saved, never rendered."
          >
            Dry A/B
          </Toggle>
          <span className={deviceStyles.caption}>Not rendered</span>
        </div>
      </DeviceSection>
    </>
  )
}

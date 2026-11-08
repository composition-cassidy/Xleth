import React, { useEffect } from 'react'
import {
  DeviceSection, DisplayWell, NumberBox, SegmentedControl, Select, Toggle, logScale, skewScale,
} from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import PhanjerResponseCanvas from './PhanjerResponseCanvas.jsx'
import { bandVar } from './bandPalette.js'
import useDeviceParams from './useDeviceParams.js'
import deviceStyles from './deviceBody.module.css'
import styles from './PhanjerDevice.module.css'

// Every id, range and default is PhanjerEffect::createLayout(). All 23 parameters
// are AudioParameterFloat, so the discrete ones (mode, syncs, divisions, feels,
// shape, stages) are written as their integer index cast to a float and read back
// rounded.
const DEFAULTS = Object.freeze({
  mode: 0,
  f_mix: 75, f_rate: 0.5, f_depth: 70, f_feedback: 40,
  f_delay_min: 1.0, f_delay_max: 5.0,
  f_sync: 0, f_sync_div: 2, f_sync_feel: 0,
  p_mix: 75, p_rate: 0.35, p_depth: 80, p_feedback: 40,
  p_stages: 6, p_freq_min: 100, p_freq_max: 4000,
  p_sync: 0, p_sync_div: 2, p_sync_feel: 0,
  global_mix: 50, lfo_shape: 0, chaos: 0,
})

const MODES = [
  { value: 0, label: 'Linked', hint: 'One shared LFO drives both sides in anti-phase: the flanger comb rises as the phaser falls. The leveling guard is on, and the phaser rate and sync follow the flanger.' },
  { value: 1, label: 'Smart', hint: 'Independent LFOs per side with the lookahead leveling guard on: the combined path ducks up to 6 dB before a peak-peak or notch-notch collision.' },
  { value: 2, label: 'Wild', hint: 'Independent LFOs with the guard off. A tanh saturator glues the crossings instead of leveling them.' },
]
const SHAPE_PATHS = [
  'M1 7 C 4 0, 6 0, 10 7 C 14 14, 16 14, 19 7', // sine
  'M1 11 L 6 3 L 11 11 L 16 3 L 19 7', // triangle
  'M1 11 L 7 3 L 7 11 L 13 3 L 13 11 L 19 3', // saw
  'M1 11 L 1 3 L 6 3 L 6 11 L 12 11 L 12 3 L 18 3 L 18 11 L 19 11', // square
  'M1 8 L 4 4 L 6 11 L 9 6 L 12 12 L 15 3 L 17 9 L 19 6', // random
]
const SHAPE_NAMES = ['Sine', 'Triangle', 'Saw', 'Square', 'Random']
const SHAPE_HINTS = [
  'Sine LFO shape, shared by both sides',
  'Triangle LFO shape, shared by both sides',
  'Saw LFO shape, shared by both sides',
  'Square LFO shape, shared by both sides',
  'Random: a smooth per-cycle random walk rather than sample-and-hold steps',
]
const STAGE_OPTIONS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))
const DIV_OPTIONS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'].map((label, value) => ({ value, label }))
const FEEL_OPTIONS = ['Straight', 'Triplet', 'Dotted'].map((label, value) => ({ value, label }))

function ShapeIcon({ shape }) {
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true">
      <path d={SHAPE_PATHS[shape]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 3 L13 1.5 L13 10.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4" cy="11.5" r="2.3" fill="currentColor" />
      <circle cx="11" cy="11" r="2.3" fill="currentColor" />
    </svg>
  )
}

const SHAPE_OPTIONS = SHAPE_PATHS.map((_, value) => ({
  value, label: <ShapeIcon shape={value} />, ariaLabel: SHAPE_NAMES[value], hint: SHAPE_HINTS[value],
}))

const RATE_SCALE = skewScale(0.05, 10, 0.5)
const DELAY_SCALE = logScale(0.1, 20)
const FMIN_SCALE = logScale(20, 2000)
const FMAX_SCALE = logScale(200, 16000)

const WELL_W = 340
const FLANGER_HUE = bandVar(0, 4) // band 1
const PHASER_HUE = bandVar(2, 4) // band 3

const idx = (value, count) => {
  const i = Math.round(Number(value))
  return Number.isFinite(i) ? Math.max(0, Math.min(count - 1, i)) : 0
}

// Signal order of the layout: response (hero) -> Flanger | Global | Phaser. Each
// side is tinted with its own band-palette hue by setting `--ui-value` on its
// container, so its knobs, boxes and the response curve share it. Hero control:
// Global mix. The response is analytic, drawn from the parameters at the sweep
// centre, not from audio.
export default function PhanjerDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('phanjer', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const modeIdx = idx(params.mode, MODES.length)
  const shapeIdx = idx(params.lfo_shape, SHAPE_PATHS.length)
  const linked = modeIdx === 0
  const fSyncOn = params.f_sync >= 0.5
  const pSyncOn = params.p_sync >= 0.5
  const flangerRateDisabled = fSyncOn // a side's Rate is off while its sync is on
  const phaserRateDisabled = linked || pSyncOn // Linked shares the flanger LFO
  const phaserSyncDisabled = linked // the phaser rate / sync row is greyed in Linked
  const chaosDisabled = shapeIdx !== 4 // Chaos only bites on Random

  const knob = (id, label, extra = {}) => {
    const { skew, ...rest } = extra
    return (
      <AutomatableKnob
        key={id}
        paramId={id}
        target={target}
        skew={skew}
        label={label}
        value={params[id]}
        defaultValue={DEFAULTS[id]}
        size={40}
        width={62}
        onChange={(v) => preview(id, v)}
        onCommit={(v) => commit(id, v)}
        data-param={id}
        {...rest}
      />
    )
  }
  const pct = (id, label, extra = {}) => knob(id, label, { min: 0, max: 100, unit: '%', ...extra })
  const rate = (id, extra = {}) => knob(id, 'Rate', {
    min: 0.05, max: 10, scale: RATE_SCALE, skew: 0.5, unit: 'Hz', formatOptions: { decimals: 2 }, ...extra,
  })
  const feedback = (id) => knob(id, 'Feedback', {
    min: -95, max: 95, unit: '%', bipolar: true, formatOptions: { signed: true },
    hint: 'Feedback. Positive rings, negative swaps the comb’s peaks and notches.',
  })
  const box = (id, label, scale, min, max, unit, extra = {}) => (
    <NumberBox
      key={id}
      label={label}
      value={params[id]}
      min={min}
      max={max}
      scale={scale}
      defaultValue={DEFAULTS[id]}
      unit={unit}
      formatOptions={unit === 'ms' ? { decimals: 2 } : undefined}
      width={112}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )
  const syncRow = (side, disabled) => {
    const name = side === 'f' ? 'Flanger' : 'Phaser'
    return (
      <div className={styles.sync}>
        <Toggle
          size="sm"
          on={params[`${side}_sync`] >= 0.5}
          disabled={disabled}
          onChange={(on) => commit(`${side}_sync`, on ? 1 : 0)}
          glyph={<NoteIcon />}
          aria-label={`${name} tempo sync`}
          hint={`Lock the ${name.toLowerCase()} LFO to the tempo: one cycle per note division. Turns off its Rate.`}
        />
        <Select
          size="sm"
          ariaLabel={`${name} division`}
          value={idx(params[`${side}_sync_div`], DIV_OPTIONS.length)}
          options={DIV_OPTIONS}
          disabled={disabled}
          onChange={(v) => commit(`${side}_sync_div`, Number(v))}
        />
        <Select
          size="sm"
          ariaLabel={`${name} feel`}
          value={idx(params[`${side}_sync_feel`], FEEL_OPTIONS.length)}
          options={FEEL_OPTIONS}
          disabled={disabled}
          onChange={(v) => commit(`${side}_sync_feel`, Number(v))}
        />
      </div>
    )
  }

  return (
    <>
      <DisplayWell label="Phanjer display" width={WELL_W}>
        <div className={deviceStyles.display}>
          <PhanjerResponseCanvas params={params} />
        </div>
      </DisplayWell>

      <DeviceSection title="Flanger" width={264}>
        <div className={styles.side} style={{ '--ui-value': FLANGER_HUE }} data-side="flanger">
          <div className={styles.knobs}>
            {rate('f_rate', { disabled: flangerRateDisabled })}
            {pct('f_depth', 'Depth')}
            {feedback('f_feedback')}
            {pct('f_mix', 'Mix', { hint: 'How much of the flanger comb is in the sum' })}
          </div>
          <div className={styles.boxes}>
            {box('f_delay_min', 'Delay min', DELAY_SCALE, 0.1, 20, 'ms', { hint: 'Shortest delay of the flanger sweep' })}
            {box('f_delay_max', 'Delay max', DELAY_SCALE, 0.1, 20, 'ms', { hint: 'Longest delay of the flanger sweep' })}
          </div>
          {syncRow('f', false)}
        </div>
      </DeviceSection>

      <DeviceSection title="Global" width={236}>
        <div className={styles.global}>
          <SegmentedControl
            size="md"
            label="Mode"
            value={modeIdx}
            options={MODES}
            onChange={(v) => commit('mode', v)}
          />
          <div className={styles.heroRow}>
            {knob('global_mix', 'Global mix', {
              min: 0, max: 100, unit: '%', size: 56, width: 92,
              hint: 'Scales both comb paths against the dry signal: 0 % is fully dry. The dry signal enters the sum once, so each side’s Mix is that comb’s depth.',
            })}
            {knob('chaos', 'Chaos', {
              min: 0, max: 100, unit: '%', disabled: chaosDisabled,
              hint: 'Layers two faster random sources on top of the sweep. Only with the Random shape.',
            })}
          </div>
          <SegmentedControl
            size="sm"
            label="LFO shape"
            value={shapeIdx}
            options={SHAPE_OPTIONS}
            onChange={(v) => commit('lfo_shape', v)}
          />
        </div>
      </DeviceSection>

      <DeviceSection title="Phaser" width={264}>
        <div className={styles.side} style={{ '--ui-value': PHASER_HUE }} data-side="phaser">
          <div className={styles.knobs}>
            {rate('p_rate', { disabled: phaserRateDisabled })}
            {pct('p_depth', 'Depth')}
            {feedback('p_feedback')}
            {pct('p_mix', 'Mix', { hint: 'How much of the phaser notch set is in the sum' })}
          </div>
          <div className={styles.boxes}>
            {box('p_freq_min', 'Freq min', FMIN_SCALE, 20, 2000, 'Hz', { hint: 'Lowest frequency of the phaser sweep' })}
            {box('p_freq_max', 'Freq max', FMAX_SCALE, 200, 16000, 'Hz', { hint: 'Highest frequency of the phaser sweep' })}
          </div>
          <div className={styles.sync}>
            <SegmentedControl
              size="sm"
              label="Stages"
              value={Math.max(1, Math.min(6, Math.round(Number(params.p_stages))))}
              options={STAGE_OPTIONS}
              onChange={(v) => commit('p_stages', v)}
              hint="Allpass stages. Each stage makes one notch."
            />
          </div>
          {syncRow('p', phaserSyncDisabled)}
        </div>
      </DeviceSection>
    </>
  )
}

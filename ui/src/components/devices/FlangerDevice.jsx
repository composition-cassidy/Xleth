import React, { useEffect } from 'react'
import { DeviceSection, DisplayWell, Toggle } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import FlangerVisualizerCanvas from '../mixer/FlangerVisualizerCanvas.jsx'
import FlangerLfoCanvas from './FlangerLfoCanvas.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './deviceBody.module.css'

// Every id is an existing engine parameter (XlethFlangerEffect); ranges are the
// ones the editor has always used.
const DEFAULTS = Object.freeze({
  rate: 0.5, depth: 70, delay: 1.5, feedback: 50, width: 50, mix: 50,
})
const RANGES = {
  rate: [0.05, 10],
  depth: [0, 100],
  delay: [0.1, 5],
  feedback: [-95, 95],
  width: [0, 100],
  mix: [0, 100],
}

const WELL_W = 232
const VIEWS = [
  { value: 'sweep', label: 'Sweep', hint: 'The comb and read-heads, from delay, rate, depth, feedback, width and mix' },
  { value: 'lfo', label: 'LFO', hint: 'The LFO itself: rate as cycles, depth as height, centred on the delay time' },
]

// Signal order: display (hero) -> Modulation -> Delay -> Feedback -> Output.
// Hero control: Feedback. Its polarity is a toggle beside it (a sign flip, same
// parameter and range).
// The engine's NormalisableRange skew per parameter (only the automation maths
// needs it; a knob's own travel comes from its range or scale).
const SKEW = Object.freeze({ rate: 0.5, delay: 0.5 })

export default function FlangerDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('flanger', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'sweep')
  const setView = useDeviceUiStore((s) => s.setView)

  const knob = (id, label, unit, extra = {}) => (
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
      unit={unit}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  return (
    <>
      <DisplayWell
        label="Flanger display"
        width={WELL_W}
        views={VIEWS}
        view={view}
        onViewChange={(v) => setView(deviceKey, v)}
      >
        <div className={styles.display} data-view={view}>
          {view === 'lfo'
            ? <FlangerLfoCanvas params={params} />
            : <FlangerVisualizerCanvas params={params} />}
        </div>
      </DisplayWell>

      <DeviceSection title="Modulation" width={124}>
        <div className={styles.pair}>
          {knob('rate', 'Rate', 'Hz', { size: 44, width: 60, formatOptions: { decimals: 2 } })}
          {knob('depth', 'Depth', '%', { size: 44, width: 60 })}
        </div>
      </DeviceSection>

      <DeviceSection title="Delay" width={72}>
        {knob('delay', 'Delay', 'ms', { size: 44, width: 64, formatOptions: { decimals: 2 } })}
      </DeviceSection>

      <DeviceSection title="Feedback" width={104}>
        {knob('feedback', 'Feedback', '%', {
          size: 56, width: 88, bipolar: true, formatOptions: { signed: true },
          hint: 'Feedback. Positive rings, negative hollows the comb.',
        })}
        <Toggle
          size="sm"
          on={params.feedback < 0}
          disabled={params.feedback === 0}
          onChange={() => commit('feedback', -params.feedback)}
          hint="Flip the feedback polarity"
        >
          Invert
        </Toggle>
      </DeviceSection>

      <DeviceSection title="Output" width={68}>
        <div className={styles.stack}>
          {knob('width', 'Width', '%')}
          {knob('mix', 'Mix', '%')}
        </div>
      </DeviceSection>
    </>
  )
}

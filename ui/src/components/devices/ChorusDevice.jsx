import React, { useEffect } from 'react'
import { DeviceSection, DisplayWell } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import ChorusOrbitCanvas from './ChorusOrbitCanvas.jsx'
import { plainFormat } from './deviceFormat.js'
import useDeviceParams from './useDeviceParams.js'
import deviceStyles from './deviceBody.module.css'

// Every id is an existing engine parameter (ChorusEffect::createLayout()); ranges
// and defaults are the ones the editor has always used. The knob tapers stay
// linear, as the old knobs had no skew.
const DEFAULTS = Object.freeze({
  rate: 0.8, depth: 50, delay: 15, feedback: 0, voices: 2, width: 80, mix: 50,
})
const RANGES = {
  rate: [0.05, 5],
  depth: [0, 100],
  delay: [7, 30],
  feedback: [0, 25],
  voices: [1, 10],
  width: [0, 100],
  mix: [0, 100],
}

const WELL_W = 300
const voiceCount = plainFormat(0)

// Signal order: display (hero) -> Voices -> Modulation -> Feedback -> Output.
// Hero control: Depth. The display is drawn from the parameters, not from audio.
export default function ChorusDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('chorus', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const knob = (id, label, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
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

  return (
    <>
      <DisplayWell label="Chorus display" width={WELL_W}>
        <div className={deviceStyles.display}>
          <ChorusOrbitCanvas params={params} />
        </div>
      </DisplayWell>

      <DeviceSection title="Voices" width={136}>
        <div className={deviceStyles.pair}>
          {knob('voices', 'Voices', {
            format: voiceCount, step: 1, quantize: Math.round, hint: 'Number of chorus voices',
          })}
          {knob('delay', 'Delay', { unit: 'ms', formatOptions: { decimals: 1 }, hint: 'Base delay of the voices' })}
        </div>
      </DeviceSection>

      <DeviceSection title="Modulation" width={148}>
        <div className={deviceStyles.pair}>
          {knob('rate', 'Rate', { unit: 'Hz', formatOptions: { decimals: 2 } })}
          {knob('depth', 'Depth', { unit: '%', size: 56, width: 76, hint: 'Depth of the delay modulation' })}
        </div>
      </DeviceSection>

      <DeviceSection title="Feedback" width={80}>
        {knob('feedback', 'Feedback', { unit: '%', hint: 'Feedback, up to 25 %' })}
      </DeviceSection>

      <DeviceSection title="Output" width={68}>
        <div className={deviceStyles.stack}>
          {knob('width', 'Width', { unit: '%' })}
          {knob('mix', 'Mix', { unit: '%' })}
        </div>
      </DeviceSection>
    </>
  )
}

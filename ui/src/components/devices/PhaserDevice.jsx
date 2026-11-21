import React, { useEffect } from 'react'
import { DeviceSection, DisplayWell, SegmentedControl, logScale } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import PhaserSweepCanvas from './PhaserSweepCanvas.jsx'
import { plainFormat } from './deviceFormat.js'
import useDeviceParams from './useDeviceParams.js'
import deviceStyles from './deviceBody.module.css'

// Every id is an existing engine parameter (XlethPhaserEffect::createLayout()).
// Ranges and defaults are the engine's; the old panel only exposed rate, depth,
// feedback, width, mix, stages and the two sweep edges, so Resonance and Spread
// (both used by the DSP) are new knobs. `skew` is the engine's
// NormalisableRange skew, which only the automation maths needs: a knob's own
// travel comes from min / max (or the log scale on the sweep edges).
const DEFAULTS = Object.freeze({
  rate: 0.5, depth: 80, stages: 4, feedback: 40, resonance: 1,
  width: 50, mix: 100, freq_low: 100, freq_high: 4000, spread: 30,
})
const RANGES = {
  rate: [0.05, 5],
  depth: [0, 100],
  feedback: [-95, 95],
  resonance: [0.3, 5],
  width: [0, 100],
  mix: [0, 100],
  freq_low: [20, 2000],
  freq_high: [200, 16000],
  spread: [0, 100],
}
const SKEW = { rate: 0.5, resonance: 0.5, freq_low: 0.3, freq_high: 0.23 }

// 1..6: each stage is one second-order allpass section, which makes one notch.
const STAGE_OPTIONS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))

const WELL_W = 380
const quality = plainFormat(2)

// Signal order: display (hero) -> Sweep -> Modulation -> Notches -> Output.
// Hero control: Feedback (its sign flips which of the comb's peaks and notches
// ring). The display is drawn from the parameters, not from audio.
export default function PhaserDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('phaser', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

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

  return (
    <>
      <DisplayWell label="Phaser display" width={WELL_W}>
        <div className={deviceStyles.display}>
          <PhaserSweepCanvas params={params} onPreview={preview} onCommit={commit} />
        </div>
      </DisplayWell>

      <DeviceSection title="Sweep" width={136}>
        <div className={deviceStyles.pair}>
          {knob('freq_low', 'Low', {
            scale: logScale(RANGES.freq_low[0], RANGES.freq_low[1]), unit: 'Hz',
            hint: 'Lowest frequency of the notch sweep. Also draggable on the display.',
          })}
          {knob('freq_high', 'High', {
            scale: logScale(RANGES.freq_high[0], RANGES.freq_high[1]), unit: 'Hz',
            hint: 'Highest frequency of the notch sweep. Also draggable on the display.',
          })}
        </div>
      </DeviceSection>

      <DeviceSection title="Modulation" width={124}>
        <div className={deviceStyles.pair}>
          {knob('rate', 'Rate', { unit: 'Hz', formatOptions: { decimals: 2 } })}
          {knob('depth', 'Depth', { unit: '%' })}
        </div>
      </DeviceSection>

      <DeviceSection title="Notches" width={236}>
        <div className={deviceStyles.column}>
          <AutomationTarget paramId="stages" target={target}>
            <SegmentedControl
              size="sm"
              label="Stages"
              value={Math.max(1, Math.min(6, Math.round(Number(params.stages))))}
              options={STAGE_OPTIONS}
              onChange={(v) => commit('stages', v)}
              hint="Allpass stages. Each stage makes one notch."
            />
          </AutomationTarget>
          <div className={deviceStyles.pair}>
            {knob('feedback', 'Feedback', {
              size: 56, width: 88, unit: '%', bipolar: true, formatOptions: { signed: true },
              hint: 'Feedback. Positive rings the notches, negative hollows them.',
            })}
            {knob('resonance', 'Resonance', { format: quality, hint: 'Allpass Q. Higher is sharper notches.' })}
            {knob('spread', 'Spread', { unit: '%', hint: 'Staggers the stages apart in frequency. 0 is a classic phaser.' })}
          </div>
        </div>
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

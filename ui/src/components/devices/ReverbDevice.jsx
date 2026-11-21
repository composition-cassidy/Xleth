import React, { useEffect } from 'react'
import { DeviceSection, DisplayWell, Select, THIN_SPACE } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import ReverbDecayFieldVisualizer from '../mixer/ReverbDecayFieldVisualizer.jsx'
import ReverbFilterCurve from '../mixer/ReverbFilterCurve.jsx'
import { REVERB_STYLE_LABELS, STYLE_PLATE, styleIndexOf } from '../mixer/reverbVizMath.js'
import useDeviceParams from './useDeviceParams.js'
import styles from './deviceBody.module.css'

// Every id is an existing engine parameter (XlethReverbEffect.h); ranges mirror
// its NormalisableRange bounds exactly, so the device never sends a value the
// engine would clamp. The engine has no width parameter, so there is no Width.
const DEFAULTS = Object.freeze({
  decay: 2.0, size: 50, damping: 50, predelay: 10, er_level: 50, er_late: 50,
  smoothness: 0, mod_rate: 30, mod_depth: 20, hicut: 12000, locut: 80, mix: 30, style: 0,
})
const RANGES = {
  decay: [0.1, 30], size: [0, 100], damping: [0, 100], predelay: [0, 100],
  er_level: [0, 100], er_late: [0, 100], smoothness: [0, 100],
  mod_rate: [0, 100], mod_depth: [0, 100], mix: [0, 100],
}

const WELL_W = 264

// Decay is the one value in seconds; the kit's formatValue has no seconds unit.
const formatSeconds = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}${THIN_SPACE}s`
const parseSeconds = (text) => {
  const n = Number.parseFloat(String(text).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const STYLE_OPTIONS = REVERB_STYLE_LABELS.map((label, value) => ({
  value,
  label: label.charAt(0) + label.slice(1).toLowerCase(),
}))

// er_level / er_late keep the same ids on every style but change MEANING on
// Plate (no discrete early reflections: the input-diffusion bloom and the tank
// level). The labels say so.
const PLATE_LABELS = { er_level: 'Bloom', er_late: 'Tank level' }
const labelFor = (id, styleIdx, fallback) => (styleIdx === STYLE_PLATE ? PLATE_LABELS[id] ?? fallback : fallback)

// Signal order: decay field (hero) -> Space -> Decay -> Reflections -> Filter -> Output.
// Hero control: Decay.
// The engine's NormalisableRange skew per parameter (only the automation maths
// needs it; a knob's own travel comes from its range or scale).
const SKEW = Object.freeze({ decay: 0.3, hicut: 0.23, locut: 0.3 })

export default function ReverbDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('reverb', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  // The engine returns style as a float (AudioParameterChoice index).
  const styleIdx = styleIndexOf(params.style)

  const knob = (id, label, unit, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      skew={SKEW[id] ?? 1}
      label={label}
      value={params[id]}
      min={RANGES[id]?.[0]}
      max={RANGES[id]?.[1]}
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
      <DisplayWell label="Reverb decay field" width={WELL_W}>
        <div className={styles.display}>
          <ReverbDecayFieldVisualizer params={params} styleIndex={styleIdx} />
        </div>
      </DisplayWell>

      <DeviceSection title="Space" width={132}>
        <div className={styles.column}>
          <AutomationTarget paramId="style" target={target}>
            <Select
              size="sm"
              ariaLabel="Reverb style"
              value={styleIdx}
              options={STYLE_OPTIONS}
              onChange={(v) => commit('style', v)}
              hint="Each style is a different reverb engine, not a preset of one"
            />
          </AutomationTarget>
        </div>
        <div className={styles.pair}>
          {knob('predelay', 'Pre-delay', 'ms', { size: 36, width: 62 })}
          {knob('size', 'Size', '%', { size: 36, width: 62 })}
        </div>
      </DeviceSection>

      <DeviceSection title="Decay" width={156}>
        <div className={styles.pair}>
          {knob('decay', 'Decay', undefined, {
            size: 56, width: 84, format: formatSeconds, parse: parseSeconds,
            hint: 'Decay time. How long the tail takes to fade.',
          })}
          <div className={styles.stack}>
            {knob('damping', 'Damping', '%', { size: 32, width: 62 })}
            {knob('smoothness', 'Ring tame', '%', { size: 32, width: 62, hint: 'Anti-metal control. 0 is the raw legacy path (Generic only).' })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Reflections" width={132}>
        <div className={styles.pair}>
          {knob('er_level', labelFor('er_level', styleIdx, 'ER level'), '%', { size: 32, width: 62 })}
          {knob('er_late', labelFor('er_late', styleIdx, 'Late level'), '%', { size: 32, width: 62 })}
        </div>
        <div className={styles.pair}>
          {knob('mod_rate', 'Mod rate', '%', { size: 32, width: 62 })}
          {knob('mod_depth', 'Mod depth', '%', { size: 32, width: 62 })}
        </div>
      </DeviceSection>

      <DeviceSection title="Filter" width={156}>
        <div className={styles.column}>
          <div className={styles.curve} data-hint="Wet filter: drag the low-cut and high-cut handles">
            <ReverbFilterCurve
              loHz={params.locut}
              hiHz={params.hicut}
              onPreview={preview}
              onCommit={commit}
            />
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={68}>
        {knob('mix', 'Mix', '%', { size: 44, width: 60 })}
      </DeviceSection>
    </>
  )
}

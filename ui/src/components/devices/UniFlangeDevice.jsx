import React, { useEffect } from 'react'
import { DeviceSection, DisplayWell, Knob } from '../../ui-kit'
import UniFlangeScope from './UniFlangeScope.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './deviceBody.module.css'

// Every id is an existing engine parameter (UniFlangeEffect.h createLayout);
// ranges and defaults are the engine's APVTS ones. `mode` (LEGACY/HQ delay-tap
// interpolation) has no control here by design: the device never reads or
// writes it.
const DEFAULTS = Object.freeze({
  order: 4, depth: 50, speed: 50, delay: 0, spread: 100, cross: 0, dry: 0, wet: 100,
})
const RANGES = {
  order: [1, 8], depth: [0, 100], speed: [0, 100], delay: [0, 100],
  spread: [0, 100], cross: [-100, 100], dry: [-100, 100], wet: [-100, 100],
}

// What each knob does to the SOUND, in the hint bar (carried over verbatim from
// the editor's hover help).
const HELP = {
  order: 'Thicker and more chorus-like as you add voices; leaner and closer to a classic flange as you take them away.',
  depth: 'A dramatic, swooshy jet-plane movement at high settings; a gentle shimmer under the sound at low ones.',
  speed: 'A slow, lush, evolving wash at low settings; a fluttery, vibrato-like wobble at high ones.',
  delay: 'A tight, classic, metallic flange at low settings; a wider, hazier chorus-like texture at high ones.',
  spread: 'Huge and enveloping across the stereo field at high settings; collapsed to the centre at 0.',
  cross: 'A subtle glue that pulls an overly wide effect back together at small amounts; a resonant, metallic edge and extra loudness when aggressive.',
}

const WELL_W = 200
const VIEWS = [
  { value: 'both', label: 'Both', hint: 'Dry input over the wet ensemble' },
  { value: 'dry', label: 'Dry', hint: 'The raw input before the effect' },
  { value: 'wet', label: 'Wet', hint: 'The ensemble before the dry/wet blend' },
]

// Signal order: display (hero) -> Voices -> Modulation -> Stereo -> Output.
// The engine has no M/S EQ or compression here, so there are no section tabs
// and no hero control: eight knobs in four sections at the fixed height.
export default function UniFlangeDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('uniflange', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'both')
  const setView = useDeviceUiStore((s) => s.setView)

  const knob = (id, label, extra = {}) => (
    <Knob
      key={id}
      label={label}
      value={params[id]}
      min={RANGES[id][0]}
      max={RANGES[id][1]}
      defaultValue={DEFAULTS[id]}
      unit="%"
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      hint={HELP[id]}
      data-param={id}
      {...extra}
    />
  )

  return (
    <>
      <DisplayWell
        label="UniFlange display"
        width={WELL_W}
        views={VIEWS}
        view={view}
        onViewChange={(v) => setView(deviceKey, v)}
      >
        <div className={styles.display}>
          <UniFlangeScope target={target} view={view} />
        </div>
      </DisplayWell>

      <DeviceSection title="Voices" width={72}>
        {knob('order', 'Order', {
          unit: undefined, step: 1, quantize: (v) => Math.round(v), size: 44, width: 60,
          format: (v) => String(Math.round(v)),
        })}
      </DeviceSection>

      <DeviceSection title="Modulation" width={180}>
        <div className={styles.pair}>
          {knob('depth', 'Depth', { size: 40, width: 58 })}
          {knob('speed', 'Speed', { size: 40, width: 58 })}
          {knob('delay', 'Delay', { size: 40, width: 58 })}
        </div>
      </DeviceSection>

      <DeviceSection title="Stereo" width={124}>
        <div className={styles.pair}>
          {knob('spread', 'Spread', { size: 40, width: 58 })}
          {knob('cross', 'Cross', { size: 40, width: 58, bipolar: true, formatOptions: { signed: true } })}
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={124}>
        <div className={styles.pair}>
          {knob('dry', 'Dry', { size: 40, width: 58, bipolar: true, formatOptions: { signed: true }, hint: 'Dry level. Negative inverts the dry signal.' })}
          {knob('wet', 'Wet', { size: 40, width: 58, bipolar: true, formatOptions: { signed: true }, hint: 'Wet level. Negative inverts the ensemble.' })}
        </div>
      </DeviceSection>
    </>
  )
}

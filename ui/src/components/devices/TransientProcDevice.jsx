import React, { useEffect, useRef, useState } from 'react'
import { DeviceSection, DisplayWell, SegmentedControl } from '../../ui-kit'
import DynamicsVisualizerCanvas from '../../plugin-ui/runtime/visualizers/DynamicsVisualizerCanvas.jsx'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './deviceBody.module.css'

// Transient Processor as a device.
//
// Hero: the engine's TransientBucket stream, drawn by the transient painter the
// legacy layout used. Default view: input against processed output with the
// fast / slow envelopes and the level grid; second view: the signed gain change
// (boost above the line, cut below) with its live readout. With no signal the
// well says "Play to see transients" rather than standing empty.
//
// Sections in signal order: Detection (Envelope / MIDI, Threshold, Speed) ->
// Shape (Attack, the hero knob, and Sustain) -> Output (Mix). Threshold and
// Sustain belong to envelope mode; in MIDI mode they are disabled, as before.
//
// Params (engine XlethTransientProcEffect::createLayout): attack, sustain,
// attack_speed, threshold, mix, midi_detect. Writes preview at most once per
// frame and commit once on release (useDeviceParams); the mode is one commit.

const P = {
  attack: { min: -100, max: 100, def: 0 },
  sustain: { min: -100, max: 100, def: 0 },
  attack_speed: { min: 0.5, max: 20, def: 5 },
  threshold: { min: -60, max: 0, def: -60 },
  mix: { min: 0, max: 100, def: 100 },
}
const DEFAULTS = Object.freeze({ ...Object.fromEntries(Object.entries(P).map(([id, p]) => [id, p.def])), midi_detect: 0 })

const VIEWS = [
  { value: 'envelope', label: 'Envelope', hint: 'Input against processed output, with the detector envelopes' },
  { value: 'gain', label: 'Gain', hint: 'Gain change over time: boost above the line, cut below' },
]
const PRESET_BY_VIEW = { envelope: 'transientEnvelope', gain: 'transientGainChange' }
const MODE_OPTIONS = [
  { value: 0, label: 'Envelope', hint: 'Detect transients from the signal level' },
  { value: 1, label: 'MIDI', hint: 'Trigger the attack shaping from incoming MIDI notes' },
]

/** The well's inner height, so the canvas draws at the size it occupies. */
function useHeight() {
  const ref = useRef(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const read = () => setHeight(Math.floor(el.clientHeight))
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, height]
}

export default function TransientProcDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('transientproc', DEFAULTS, target)
  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'envelope')
  const setView = useDeviceUiStore((s) => s.setView)
  const [wellRef, wellH] = useHeight()

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const v = (id) => (Number.isFinite(params[id]) ? params[id] : DEFAULTS[id])
  const midi = Math.round(v('midi_detect')) === 1
  const envOnly = midi ? { disabled: true } : {}

  const knob = (id, label, unit, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      label={label}
      value={v(id)}
      min={P[id].min}
      max={P[id].max}
      defaultValue={P[id].def}
      unit={unit}
      size={40}
      width={64}
      data-param={id}
      onChange={(x) => preview(id, x)}
      onCommit={(x) => commit(id, x)}
      {...extra}
    />
  )
  const shape = { bipolar: true, formatOptions: { signed: true } }

  return (
    <>
      <DisplayWell
        label="Transient display"
        width={320}
        views={VIEWS}
        view={view}
        onViewChange={(next) => setView(deviceKey, next)}
      >
        <div ref={wellRef} className={styles.display}>
          <DynamicsVisualizerCanvas
            trackId={target.trackId}
            nodeId={target.nodeId}
            sourceKey="transient.shaper"
            preset={PRESET_BY_VIEW[view] ?? 'transientEnvelope'}
            heightPx={Math.max(64, wellH || 200)}
            params={params}
          />
        </div>
      </DisplayWell>

      <DeviceSection title="Detection" width={148}>
        <AutomationTarget paramId="midi_detect" target={target}>
          <SegmentedControl
            size="sm"
            label="Detection mode"
            value={midi ? 1 : 0}
            options={MODE_OPTIONS}
            data-param="midi_detect"
            onChange={(m) => commit('midi_detect', m)}
          />
        </AutomationTarget>
        <div className={styles.pair}>
          {knob('threshold', 'Threshold', 'dB', { ...envOnly, hint: midi ? 'Envelope mode only' : 'Level a transient must cross to be shaped' })}
          {knob('attack_speed', 'Speed', 'ms', { hint: 'Detector timing; the attack window in MIDI mode' })}
        </div>
      </DeviceSection>

      <DeviceSection title="Shape" width={96}>
        {knob('attack', 'Attack', '%', { ...shape, size: 56, width: 84, hint: 'Boost or cut the start of each transient' })}
        {knob('sustain', 'Sustain', '%', { ...shape, ...envOnly, hint: midi ? 'Envelope mode only' : 'Boost or cut what follows each transient' })}
      </DeviceSection>

      <DeviceSection title="Output" width={72}>
        {knob('mix', 'Mix', '%', { hint: 'Processed against dry' })}
      </DeviceSection>
    </>
  )
}

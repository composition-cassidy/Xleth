import React, { useCallback, useEffect, useState } from 'react'
import {
  DeviceSection, DisplayWell, Knob, Select, formatValue, skewScale, syncCodec,
} from '../../ui-kit'
import DelayEchoFieldVisualizer from '../mixer/DelayEchoFieldVisualizer.jsx'
import DelayFilterCurve from '../mixer/DelayFilterCurve.jsx'
import { subscribe as subscribeTransport, getTransportState } from '../../transportStore.js'
import {
  clamp, syncDivLabel, divisionToMs, stereoWidthLabel,
  STEREO_MODE_SINGLE, STEREO_MODE_DUAL, STEREO_MODE_PINGPONG,
} from '../mixer/delayVizMath.js'
import {
  TIME_MODE_FREE, TIME_MODE_OPTIONS, indexToNoteFeel, encodeTimeMode, decodeTimeMode,
} from './delaySync.js'
import useDeviceParams from './useDeviceParams.js'
import styles from './deviceBody.module.css'

// Every id is an existing engine parameter (XlethDelayEffect.h); ranges mirror
// its NormalisableRange bounds, so the device never sends a value the engine
// would clamp.
const DEFAULTS = Object.freeze({
  time_l: 500,
  time_r: 500,
  sync: 0,
  sync_div_l: 3,
  sync_div_r: 3,
  stereo_mode: STEREO_MODE_DUAL,
  feedback: 30,
  stereo_width: 50,
  mod_rate: 0.3,
  mod_depth: 15,
  duck_amount: 0,
  filter_lo: 80,
  filter_hi: 12000,
  mix: 30,
})

const WELL_W = 248
const TIME_MIN = 1
const TIME_MAX = 5000
// time_l / time_r are NormalisableRange{1, 5000, 0, 0.4}: the knob must travel
// the same curve the engine does, or half a drag is ~2500 ms instead of ~885.
const TIME_SCALE = skewScale(TIME_MIN, TIME_MAX, 0.4)
const MOD_RATE_SCALE = skewScale(0.01, 5, 0.5)
const DIV_CODEC = syncCodec(Array.from({ length: 12 }, (_, i) => syncDivLabel(i)))

const STEREO_MODE_OPTIONS = [
  { value: STEREO_MODE_SINGLE, label: 'Single' },
  { value: STEREO_MODE_DUAL, label: 'Dual' },
  { value: STEREO_MODE_PINGPONG, label: 'Ping-pong' },
]

// Signal order: echo field (hero) -> Time -> Model -> Feedback -> Output.
// The engine has no input parameter, so there is no Input section.
export default function DelayDevice({ target, registerApplied }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('delay', DEFAULTS, target)
  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 120)

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  // Live tempo for the sync readouts and the display's musical grid. Rides the
  // existing 4 Hz singleton poller; no extra IPC.
  useEffect(() => subscribeTransport((s) => {
    if (typeof s?.bpm === 'number' && Number.isFinite(s.bpm)) setBpm((prev) => (prev !== s.bpm ? s.bpm : prev))
  }), [])

  // `sync` is one engine parameter shared by both taps, so either side's mode
  // select switches both; the selects re-render to say so.
  const onModeChange = useCallback((side, optionValue) => {
    if (optionValue === TIME_MODE_FREE) { commit('sync', 0); return }
    const idx = decodeTimeMode(optionValue)
    if (idx === null) return // an unsupported combo: never send a fake value
    commit(side === 'L' ? 'sync_div_l' : 'sync_div_r', idx)
    commit('sync', 1)
  }, [commit])

  const synced = params.sync >= 0.5
  const stereoMode = params.stereo_mode ?? STEREO_MODE_DUAL
  const isSingle = stereoMode === STEREO_MODE_SINGLE
  const widthLabel = stereoWidthLabel(stereoMode) === 'SPREAD' ? 'Spread' : 'Width'

  const knob = (id, label, unit, extra = {}) => (
    <Knob
      key={id}
      label={label}
      value={params[id]}
      min={extra.min}
      max={extra.max}
      defaultValue={DEFAULTS[id]}
      unit={unit}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  const timeCell = (side) => {
    const locked = side === 'R' && isSingle
    const divIndex = locked ? params.sync_div_l : (side === 'L' ? params.sync_div_l : params.sync_div_r)
    const timeMs = locked ? params.time_l : (side === 'L' ? params.time_l : params.time_r)
    const nf = indexToNoteFeel(divIndex)
    const modeValue = synced ? encodeTimeMode(nf.note, nf.feel) : TIME_MODE_FREE
    const divParam = side === 'L' ? 'sync_div_l' : 'sync_div_r'
    const timeParam = side === 'L' ? 'time_l' : 'time_r'
    const name = locked ? 'R = L' : side
    return (
      <div className={styles.cell} key={side}>
        {locked ? <span className={styles.caption}>{name}</span> : null}
        {synced ? (
          <Knob
            label={`${side} division`}
            value={clamp(divIndex, 0, 11)}
            codec={DIV_CODEC}
            defaultValue={3}
            size={44}
            width={72}
            disabled={locked}
            onChange={(v) => preview(divParam, Math.round(v))}
            onCommit={(v) => commit(divParam, Math.round(v))}
            data-param={divParam}
            hint="Delay length as a note value, from the project tempo"
          />
        ) : (
          <Knob
            label={`${side} time`}
            value={clamp(timeMs, TIME_MIN, TIME_MAX)}
            scale={TIME_SCALE}
            unit="ms"
            defaultValue={500}
            size={44}
            width={72}
            disabled={locked}
            onChange={(v) => preview(timeParam, v)}
            onCommit={(v) => commit(timeParam, v)}
            data-param={timeParam}
            hint="Delay time. Ctrl+click resets."
          />
        )}
        {synced ? (
          <span className={styles.readout} data-hint="What this division resolves to at the project tempo">
            {`≈ ${formatValue(divisionToMs(divIndex, bpm), 'ms')}`}
          </span>
        ) : null}
        {locked ? null : (
          <Select
            size="sm"
            ariaLabel={`${side === 'L' ? 'Left' : 'Right'} tap time mode`}
            value={modeValue}
            options={TIME_MODE_OPTIONS}
            onChange={(v) => onModeChange(side, v)}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <DisplayWell label="Delay echo field" width={WELL_W}>
        <div className={styles.display}>
          <DelayEchoFieldVisualizer params={params} bpm={bpm} />
        </div>
      </DisplayWell>

      <DeviceSection title="Time" width={176}>
        <div className={styles.pair}>
          {timeCell('L')}
          {timeCell('R')}
        </div>
      </DeviceSection>

      <DeviceSection title="Model" width={124}>
        <Select
          size="sm"
          ariaLabel="Stereo mode"
          value={stereoMode}
          options={STEREO_MODE_OPTIONS}
          onChange={(v) => commit('stereo_mode', v)}
        />
        <div className={styles.pair}>
          {knob('mod_rate', 'Mod rate', 'Hz', { scale: MOD_RATE_SCALE, formatOptions: { decimals: 2 }, size: 28, width: 60 })}
          {knob('mod_depth', 'Mod depth', '%', { min: 0, max: 100, size: 28, width: 60 })}
        </div>
      </DeviceSection>

      <DeviceSection title="Feedback" width={188}>
        <div className={styles.pair}>
          {knob('feedback', 'Feedback', '%', { min: 0, max: 95, size: 56, width: 84, hint: 'Feedback. How long the echoes keep going.' })}
          {knob('duck_amount', 'Duck', '%', { min: 0, max: 100, size: 32, width: 56 })}
        </div>
        <div className={styles.curve} data-hint="Feedback filter: drag the low-cut and high-cut handles">
          <DelayFilterCurve
            loHz={params.filter_lo}
            hiHz={params.filter_hi}
            onPreview={preview}
            onCommit={commit}
          />
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={68}>
        <div className={styles.stack}>
          {knob('stereo_width', widthLabel, '%', { min: 0, max: 100 })}
          {knob('mix', 'Mix', '%', { min: 0, max: 100 })}
        </div>
      </DeviceSection>
    </>
  )
}

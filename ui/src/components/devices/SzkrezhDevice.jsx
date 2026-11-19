import React, { useEffect, useMemo, useState } from 'react'
import { DeviceSection, DisplayWell, SegmentedControl, Select, Toggle, formatValue, logScale, skewScale } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import SzkrezhStaircaseCanvas from './SzkrezhStaircaseCanvas.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import useMixerStore from '../../stores/mixerStore.js'
import { subscribe as subscribeTransport, getTransportState } from '../../transportStore.js'
import {
  PITCH_SOURCES, FB_MODES, DYN_TARGETS, KEYS, SCALES,
  centsAsSemitones, signedCents, divisionCodec, divisionMs, intervalCodec, noteCodec, dynAmountFormat, clampInt,
} from './szkrezhModel.js'
import deviceStyles from './deviceBody.module.css'
import styles from './SzkrezhDevice.module.css'

// Every id, range and default is XlethSzkrezhEffect::createLayout(). Szkrezh is a granular reverse
// pitch echo: every splice a new grain reads recent audio backwards (or forwards) at another speed,
// and Recycle feeds the result back so each repeat climbs by the pitch again. Splices are worked
// out from the transport position, so an export lands every one on the sample you heard.
const DEFAULTS = Object.freeze({
  pitch_src: 0, pitch: 1200, pitch_offset: 0, harmony: 2, key: 0, scale: 0, root: 60, midi_track: 0,
  sync: 1, splice: 500, splice_div: 10, smoothing: 20, delay: 0, delay_div: 0,
  splice_offset: 0, delay_offset: 0, reverse: 1,
  recycle: 35, fb_mode: 0, low_cut: 80, high_cut: 20000, freeze: 0,
  dyn_amount: 0, dyn_threshold: -24, dyn_attack: 5, dyn_release: 250, dyn_target: 0,
  quality: 0, input: 0, output: 0, mix: 50,
})
const RANGES = {
  pitch: [-3600, 3600],
  pitch_offset: [-2400, 2400],
  splice: [10, 2000],
  smoothing: [5, 250],
  delay: [0, 2000],
  splice_offset: [0, 50],
  delay_offset: [0, 50],
  recycle: [0, 100],
  low_cut: [20, 5000],
  high_cut: [500, 20000],
  dyn_amount: [-100, 100],
  dyn_threshold: [-60, 0],
  dyn_attack: [0.1, 200],
  dyn_release: [10, 2000],
  input: [-24, 24],
  output: [-24, 24],
  mix: [0, 100],
}
// The engine's NormalisableRange skews (automation maths; knob travel uses the matching scale).
const SKEW = { splice: 0.4, smoothing: 0.5, delay: 0.4, low_cut: 0.3, high_cut: 0.3, dyn_attack: 0.4, dyn_release: 0.4 }
const SCALE_OF = {
  splice: skewScale(10, 2000, 0.4),
  smoothing: skewScale(5, 250, 0.5),
  delay: skewScale(0, 2000, 0.4),
  low_cut: logScale(20, 5000),
  high_cut: logScale(500, 20000),
  dyn_attack: logScale(0.1, 200),
  dyn_release: logScale(10, 2000),
}

const SPLICE_DIV = divisionCodec(1)
const DELAY_DIV = divisionCodec(0)
const KEY_OPTIONS = KEYS.map((label, value) => ({ value, label }))
const SCALE_OPTIONS = SCALES.map((label, value) => ({ value, label }))
const SYNC_OPTIONS = [
  { value: 0, label: 'Free', hint: 'Splice and Delay in milliseconds, on a grid counted from the start of the timeline' },
  { value: 1, label: 'Sync', hint: 'Splice and Delay as note values. A splice never crosses a downbeat.' },
]
const DIRECTIONS = [
  { value: 0, label: 'Forward', hint: 'Grains play forward: a pitch shifter with long splices' },
  { value: 1, label: 'Reverse', hint: 'Grains play backward and swell into each attack: the crystal sound' },
]
const QUALITIES = [
  { value: 0, label: 'Vintage', hint: 'Hermite reads with a pitch-tracking low-pass: the dark, gritty bandwidth of the old hardware' },
  { value: 1, label: 'Clean', hint: 'Band-limited reads: no aliasing on pitch-up. Costs more CPU at large shifts.' },
]
const WELL_W = 220

// Signal order: display -> Pitch (where the shift comes from) -> Splice (the grains) -> Recycle
// (the loop and its tone) -> Dynamics (folds) -> Stereo (folds) -> Output.
export default function SzkrezhDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('szkrezh', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 140)
  useEffect(() => subscribeTransport((s) => {
    if (typeof s?.bpm === 'number' && Number.isFinite(s.bpm)) setBpm((prev) => (prev !== s.bpm ? s.bpm : prev))
  }), [])

  const dynFolded = useDeviceUiStore((s) => s.sections[`${deviceKey}:dynamics`] ?? true)
  const stereoFolded = useDeviceUiStore((s) => s.sections[`${deviceKey}:stereo`] ?? true)
  const setSectionFolded = useDeviceUiStore((s) => s.setSectionFolded)

  // Keys can read any other track's notes; 0 is this track.
  const tracks = useMixerStore((s) => s.tracks)
  const trackOrder = useMixerStore((s) => s.trackOrder)
  const hostTrackId = target?.trackId
  const midiTrack = clampInt(params.midi_track, 0, 1000000)
  const trackOptions = useMemo(() => {
    const opts = [{ value: 0, label: 'This track' }]
    const ids = trackOrder?.length ? trackOrder : Object.keys(tracks ?? {}).map(Number)
    for (const id of ids) {
      const t = tracks?.[id]
      if (!t || Number(id) === hostTrackId || Number(id) < 0) continue
      opts.push({ value: Number(id), label: t.name || `Track ${id}` })
    }
    if (midiTrack > 0 && !opts.some((o) => o.value === midiTrack)) opts.push({ value: midiTrack, label: 'Missing track' })
    return opts
  }, [tracks, trackOrder, hostTrackId, midiTrack])

  const knob = (id, label, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      skew={SKEW[id] ?? 1}
      label={label}
      value={params[id]}
      min={RANGES[id]?.[0]}
      max={RANGES[id]?.[1]}
      scale={SCALE_OF[id]}
      defaultValue={DEFAULTS[id]}
      size={36}
      width={60}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )
  // A stepped knob (an index or a note): integer values, a codec for its text.
  const stepKnob = (id, label, codec, extra = {}) => knob(id, label, {
    min: codec.min, max: codec.max, scale: undefined, codec, quantize: Math.round,
    onChange: (v) => preview(id, Math.round(v)),
    onCommit: (v) => commit(id, Math.round(v)),
    ...extra,
  })

  const source = clampInt(params.pitch_src, 0, 2)
  const synced = Number(params.sync) >= 0.5
  const scale = clampInt(params.scale, 0, SCALES.length - 1)
  const interval = useMemo(() => intervalCodec(scale), [scale])

  return (
    <>
      <DisplayWell label="Szkrezh display" width={WELL_W}>
        <div className={deviceStyles.display}>
          <SzkrezhStaircaseCanvas target={target} params={params} bpm={bpm} />
        </div>
      </DisplayWell>

      <DeviceSection title="Pitch" width={212}>
        <div className={deviceStyles.column}>
          <div className={styles.centred}>
            <AutomationTarget paramId="pitch_src" target={target}>
              <SegmentedControl
                size="sm"
                label="Pitch source"
                value={source}
                options={PITCH_SOURCES}
                onChange={(v) => commit('pitch_src', v)}
              />
            </AutomationTarget>
          </div>
          <div className={styles.row}>
            {source === 0 ? knob('pitch', 'Pitch', {
              size: 52, width: 84, bipolar: true, format: centsAsSemitones.format, parse: centsAsSemitones.parse,
              hint: 'Shift per pass, in semitones (type "750ct" for cents). Repeats climb by it: +12 gives +12, +24, +36.',
            }) : null}
            {source === 1 ? stepKnob('harmony', 'Interval', interval, {
              size: 44, width: 72, bipolar: true,
              hint: 'Scale steps above (or below) the note being read: +3rd, +5th, an octave.',
            }) : null}
            {source === 1 ? (
              <div className={styles.selects}>
                <AutomationTarget paramId="key" target={target}>
                  <Select size="sm" width={64} ariaLabel="Key" value={clampInt(params.key, 0, 11)} options={KEY_OPTIONS}
                    onChange={(v) => commit('key', Number(v))} hint="Key of the harmony" />
                </AutomationTarget>
                <AutomationTarget paramId="scale" target={target}>
                  <Select size="sm" width={64} ariaLabel="Scale" value={scale} options={SCALE_OPTIONS}
                    onChange={(v) => commit('scale', Number(v))} hint="Scale of the harmony. Notes outside it keep their offset from the degree below." />
                </AutomationTarget>
              </div>
            ) : null}
            {source === 2 ? (
              <div className={styles.selects}>
                <Select size="sm" width={96} ariaLabel="Keys track" value={midiTrack} options={trackOptions}
                  onChange={(v) => commit('midi_track', Number(v))}
                  hint="Track whose notes play the crystals. On another track they land on the played note over this track's melody; on this track they are measured from Root." />
              </div>
            ) : null}
            {source === 2 ? stepKnob('root', 'Root', noteCodec, {
              hint: 'The note your sample sounds at. Keys shift = played note minus Root (used when this track has no notes).',
            }) : null}
            {knob('pitch_offset', 'Offset', {
              bipolar: true, format: signedCents.format, parse: signedCents.parse,
              hint: 'Detunes left down and right up, by half each. About ±10 ct thickens; larger values split the channels.',
            })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Splice" width={236}>
        <div className={deviceStyles.column}>
          <div className={styles.switches}>
            <AutomationTarget paramId="sync" target={target}>
              <SegmentedControl size="sm" label="Splice timing" value={synced ? 1 : 0} options={SYNC_OPTIONS}
                onChange={(v) => commit('sync', v)} />
            </AutomationTarget>
            <AutomationTarget paramId="reverse" target={target}>
              <SegmentedControl size="sm" label="Direction" value={Number(params.reverse) >= 0.5 ? 1 : 0} options={DIRECTIONS}
                onChange={(v) => commit('reverse', v)} />
            </AutomationTarget>
          </div>
          <div className={styles.row}>
            <div className={deviceStyles.cell}>
              {synced
                ? stepKnob('splice_div', 'Splice', SPLICE_DIV, { hint: 'Grain length as a note value. Under 1/32 the pitch blurs into a metallic buzz.' })
                : knob('splice', 'Splice', { unit: 'ms', hint: 'Grain length. Under about 30 ms the pitch blurs into a metallic buzz.' })}
              {synced ? <span className={deviceStyles.readout}>{`≈ ${formatValue(divisionMs(params.splice_div, bpm), 'ms')}`}</span> : null}
            </div>
            {knob('smoothing', 'Smoothing', {
              unit: 'ms',
              hint: 'Crossfade between splices. Short is glitchy (the H910 sound), long is washy. Never longer than the splice.',
            })}
            <div className={deviceStyles.cell}>
              {synced
                ? stepKnob('delay_div', 'Delay', DELAY_DIV, { hint: 'Extra delay before each grain reads, as a note value' })
                : knob('delay', 'Delay', { unit: 'ms', hint: 'Extra delay before each grain reads. Spreads the repeats apart.' })}
              {synced && clampInt(params.delay_div, 0, 15) > 0
                ? <span className={deviceStyles.readout}>{`≈ ${formatValue(divisionMs(params.delay_div, bpm), 'ms')}`}</span>
                : null}
            </div>
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Recycle" width={196}>
        <div className={deviceStyles.column}>
          <div className={styles.row}>
            {knob('recycle', 'Recycle', {
              size: 52, width: 76, unit: '%',
              hint: 'Feeds the crystals back in, so each repeat is shifted again: the staircase. Capped just under runaway.',
            })}
            <div className={styles.selects}>
              <AutomationTarget paramId="fb_mode" target={target}>
                <Select size="sm" width={92} ariaLabel="Feedback mode" value={clampInt(params.fb_mode, 0, 2)} options={FB_MODES}
                  onChange={(v) => commit('fb_mode', Number(v))}
                  hint="Dual: each side feeds itself. Ping-pong: each side feeds the other. Mixed: both feed both." />
              </AutomationTarget>
              <Toggle size="sm" on={Number(params.freeze) >= 0.5} onChange={(on) => commit('freeze', on ? 1 : 0)}
                hint="Hold the tape: new input stops entering and the grains keep cycling over what is there">
                Freeze
              </Toggle>
            </div>
          </div>
          <div className={styles.row}>
            {knob('low_cut', 'Low cut', { unit: 'Hz', hint: 'High-pass in the loop: every repeat loses low end' })}
            {knob('high_cut', 'High cut', { unit: 'Hz', hint: 'Low-pass in the loop: every repeat gets darker' })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection
        title="Dynamics"
        width={232}
        folded={dynFolded}
        onFoldChange={(f) => setSectionFolded(deviceKey, 'dynamics', f)}
      >
        <div className={deviceStyles.column}>
          <div className={styles.row}>
            {knob('dyn_amount', 'Gate/Duck', {
              bipolar: true, format: dynAmountFormat.format, parse: dynAmountFormat.parse,
              hint: 'Left gates the crystals to the loud parts; right ducks them under the input so they bloom in the gaps',
            })}
            {knob('dyn_threshold', 'Threshold', { unit: 'dB', hint: 'Input level that opens the gate or ducks' })}
            {knob('dyn_attack', 'Attack', { unit: 'ms' })}
            {knob('dyn_release', 'Release', { unit: 'ms' })}
          </div>
          <div className={styles.centred}>
            <AutomationTarget paramId="dyn_target" target={target}>
              <SegmentedControl size="sm" label="Gate target" value={clampInt(params.dyn_target, 0, 2)} options={DYN_TARGETS}
                onChange={(v) => commit('dyn_target', v)} hint="What the gate or duck acts on: what you hear, what is fed back, or both" />
            </AutomationTarget>
          </div>
        </div>
      </DeviceSection>

      <DeviceSection
        title="Stereo"
        width={128}
        folded={stereoFolded}
        onFoldChange={(f) => setSectionFolded(deviceKey, 'stereo', f)}
      >
        <div className={styles.row}>
          {knob('splice_offset', 'Splice off.', { unit: '%', hint: 'Shortens the right channel\'s splice: the two sides splice at different moments, which widens the image' })}
          {knob('delay_offset', 'Delay off.', { unit: '%', hint: 'Shortens the right channel\'s delay' })}
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={140}>
        <div className={deviceStyles.column}>
          <div className={styles.row}>
            {knob('input', 'Input', { unit: 'dB', bipolar: true, hint: 'Level into the tape (wet only)' })}
            {knob('output', 'Output', { unit: 'dB', bipolar: true, hint: 'Wet level out' })}
          </div>
          <div className={styles.row}>
            {knob('mix', 'Mix', { unit: '%', hint: 'Dry / wet, equal power. Use 100 % on a send.' })}
          </div>
          <div className={styles.centred}>
            <SegmentedControl size="sm" label="Quality" value={clampInt(params.quality, 0, 1)} options={QUALITIES}
              onChange={(v) => commit('quality', v)} />
          </div>
        </div>
      </DeviceSection>
    </>
  )
}

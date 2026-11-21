import React, { useEffect, useState } from 'react'
import { DeviceSection, DisplayWell, SegmentedControl, THIN_SPACE, Toggle, formatValue } from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import SmartBalanceCanvas from './SmartBalanceCanvas.jsx'
import { bandVar } from './bandPalette.js'
import { BANDS, TARGET_MAX, TARGET_MIN, bandIds } from './smartBalanceGeometry.js'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import deviceStyles from './deviceBody.module.css'
import styles from './SmartBalanceDevice.module.css'

// Every id, range and default is SmartBalanceEffect::createLayout(). It is a gentle
// 4-band leveller (the even-it-out half of an OTT chain, without the harshness or
// the level jump): an LR4 tree splits the input at 150 Hz / 800 Hz / 4 kHz; each
// band is pulled toward a balanced tone (Relative: a reference measured on
// finished mixes, following the material's own level; Absolute: a literal dBFS
// target) and its quiet passages / bursts are evened around its own level, scaled
// by Amount and the band's own amount, never lifting a band that is not there or
// the gaps between notes. Preserve lets hits through untouched, Warmth adds a
// low-mid tilt and gentle harmonics to the lows, Loudness match keeps the output
// as loud as the input, then Output trims and Mix blends.
const DEFAULTS = (() => {
  const d = {
    amount: 60, preserve: 50, response: 150, mix: 100, mode: 0,
    warmth: 0, output: 0, loudness_match: 1,
  }
  BANDS.forEach((_, i) => {
    const ids = bandIds(i)
    d[ids.target] = 0
    d[ids.amount] = 100
    d[ids.floor] = -60
  })
  return Object.freeze(d)
})()

const MODES = [
  { value: 0, label: 'Relative', hint: 'Bands are balanced against the tone of a finished mix, at the material’s own level. Offsets move a band from there.' },
  { value: 1, label: 'Absolute', hint: 'Each band is pulled toward a fixed level in dBFS.' },
]
const VIEWS = [
  { value: 'levels', label: 'Levels', hint: 'Live band levels, targets, floors and the correction being applied' },
  { value: 'details', label: 'Details', hint: 'Adds each band’s balanced reference, whether it can be lifted, and the loudness match' },
]

const WELL_W = 560

const signedDb = (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 1, signed: true })}${THIN_SPACE}dB`

// Signal order: display (hero) -> Measure (mode, response) -> Band -> Correct
// (Amount is the hero, Preserve) -> Tone (Warmth) -> Output (Mix, Output, Loudness
// match). The display is live: it draws the engine's per-band level and gain
// meters. Controls preview at most once per animation frame and send the final
// value on release.
export default function SmartBalanceDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('smartbalance', DEFAULTS, target)
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'levels')
  const setView = useDeviceUiStore((s) => s.setView)
  const [band, setBand] = useState(0)

  const mode = Math.round(params.mode) === 0 ? 0 : 1
  const ids = bandIds(band)

  const knob = (id, label, min, max, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      label={label}
      value={params[id]}
      min={min}
      max={max}
      defaultValue={DEFAULTS[id]}
      size={44}
      width={64}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  const bandOptions = BANDS.map((b, i) => ({
    value: i,
    label: b.label,
    glyph: <span className={styles.swatch} style={{ background: bandVar(i, 4) }} aria-hidden="true" />,
    hint: `${b.label} band, ${b.range}`,
  }))

  return (
    <>
      <DisplayWell
        label="Smart Balance display"
        width={WELL_W}
        views={VIEWS}
        view={view}
        onViewChange={(v) => setView(deviceKey, v)}
      >
        <div className={deviceStyles.display}>
          <SmartBalanceCanvas
            target={target}
            params={params}
            view={view}
            selectedBand={band}
            onSelectBand={setBand}
            onPreview={preview}
            onCommit={commit}
          />
        </div>
      </DisplayWell>

      <DeviceSection title="Measure" width={156}>
        <div className={styles.column}>
          <AutomationTarget paramId="mode" target={target}>
            <SegmentedControl
              size="md"
              label="Mode"
              value={mode}
              options={MODES}
              onChange={(v) => commit('mode', v)}
            />
          </AutomationTarget>
          {knob('response', 'Response', 10, 500, {
            unit: 'ms', formatOptions: { decimals: 0 }, hint: 'How fast band levels are followed. Faster evens out more, slower is smoother',
          })}
        </div>
      </DeviceSection>

      <DeviceSection title="Band" width={300}>
        <div className={styles.column}>
          <SegmentedControl
            size="md"
            label="Band"
            value={band}
            options={bandOptions}
            onChange={setBand}
          />
          <div className={styles.knobs} style={{ '--ui-value': bandVar(band, 4) }} data-band={BANDS[band].key}>
            {knob(ids.target, mode === 0 ? 'Offset' : 'Target', TARGET_MIN, TARGET_MAX, {
              width: 72,
              bipolar: mode === 0,
              format: signedDb,
              hint: mode === 0 ? 'Where this band sits against the balanced tone: above 0 is more of it, below is less' : 'The level this band is pulled toward, in dBFS',
            })}
            {knob(ids.amount, 'Band amount', 0, 100, { width: 72, unit: '%', hint: 'How much of the correction this band gets' })}
            {knob(ids.floor, 'Floor', -96, -20, {
              width: 72, unit: 'dB', formatOptions: { decimals: 0 }, hint: 'Below this level the band is left alone',
            })}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Correct" width={156}>
        <div className={styles.knobs}>
          {knob('amount', 'Amount', 0, 100, {
            size: 56, width: 88, unit: '%', hint: 'How strongly each band is evened out and pulled toward a balanced tone',
          })}
          {knob('preserve', 'Preserve', 0, 100, {
            unit: '%', hint: 'Lets hits through untouched (up to 100 ms), so drums keep their punch and do not pump the band after them',
          })}
        </div>
      </DeviceSection>

      <DeviceSection title="Tone" width={80}>
        {knob('warmth', 'Warmth', 0, 100, {
          unit: '%', hint: 'Adds low-mid body, softens the top and gives the lows gentle tube-style harmonics. 0 % is off',
        })}
      </DeviceSection>

      <DeviceSection title="Output" width={148}>
        <div className={styles.column}>
          <div className={styles.knobs}>
            {knob('mix', 'Mix', 0, 100, { unit: '%' })}
            {knob('output', 'Output', -12, 12, {
              bipolar: true,
              format: signedDb,
              hint: 'Level after the loudness match',
            })}
          </div>
          <AutomationTarget paramId="loudness_match" target={target}>
            <Toggle
              size="sm"
              on={Number(params.loudness_match) >= 0.5}
              onChange={(on) => commit('loudness_match', on ? 1 : 0)}
              hint="Keeps the output as loud as the input (BS.1770), so you hear the balance and not a level change"
            >
              Loudness match
            </Toggle>
          </AutomationTarget>
        </div>
      </DeviceSection>
    </>
  )
}

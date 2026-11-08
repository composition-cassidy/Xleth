import React, { useEffect, useState } from 'react'
import { DeviceSection, DisplayWell, Knob, SegmentedControl, formatValue } from '../../ui-kit'
import SmartBalanceCanvas from './SmartBalanceCanvas.jsx'
import { bandVar } from './bandPalette.js'
import { BANDS, TARGET_MAX, TARGET_MIN, bandIds } from './smartBalanceGeometry.js'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import deviceStyles from './deviceBody.module.css'
import styles from './SmartBalanceDevice.module.css'

// Every id, range and default is SmartBalanceEffect::createLayout() (the editor's
// table, unchanged). It is a 4-band auto-leveller: an LR4 tree splits the input
// at 150 Hz / 800 Hz / 4 kHz, each band's RMS is pulled toward its target through
// a 6 dB soft knee (scaled by Amount and the band's own amount, +-10 dB at most,
// gated below its Floor), Preserve then restores the original dynamics, and Mix
// blends the result with the dry signal.
const DEFAULTS = (() => {
  const d = { amount: 70, preserve: 40, response: 150, mix: 100, mode: 0 }
  BANDS.forEach((_, i) => {
    const ids = bandIds(i)
    d[ids.target] = 0
    d[ids.amount] = 100
    d[ids.floor] = -60
  })
  return Object.freeze(d)
})()

const MODES = [
  { value: 0, label: 'Relative', hint: 'Targets are offsets from the overall mix level.' },
  { value: 1, label: 'Absolute', hint: 'Targets are absolute levels in dBFS.' },
]
const VIEWS = [
  { value: 'levels', label: 'Levels', hint: 'Live band levels, targets, floors and the correction being applied' },
  { value: 'details', label: 'Details', hint: 'Adds each band’s dry level and dynamics restore' },
]

const WELL_W = 560

// Signal order: display (hero) -> Measure (mode, response) -> Band -> Correct
// (Amount is the hero, Preserve) -> Output. The display is live: it draws the
// engine's per-band RMS and gain meters. Controls keep the old panel's writes
// (setEffectParameter per change, no automation), now previewed at most once per
// animation frame with the final value sent on release.
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
    <Knob
      key={id}
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
          <SegmentedControl
            size="md"
            label="Mode"
            value={mode}
            options={MODES}
            onChange={(v) => commit('mode', v)}
          />
          {knob('response', 'Response', 10, 500, {
            unit: 'ms', formatOptions: { decimals: 0 }, hint: 'How fast the band levels are measured and followed',
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
              format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 1, signed: true })} dB`,
              hint: mode === 0 ? 'Where this band should sit relative to the overall level' : 'The level this band is pulled toward, in dBFS',
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
          {knob('amount', 'Amount', 0, 100, { size: 56, width: 88, unit: '%', hint: 'Master intensity of the leveling' })}
          {knob('preserve', 'Preserve', 0, 100, { unit: '%', hint: 'How much of the original dynamics is restored after leveling' })}
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={72}>
        {knob('mix', 'Mix', 0, 100, { unit: '%' })}
      </DeviceSection>
    </>
  )
}

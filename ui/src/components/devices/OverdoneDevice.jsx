import React, { useEffect, useRef, useState } from 'react'
import { DeviceSection, DisplayWell } from '../../ui-kit'
import DynamicsVisualizerCanvas from '../../plugin-ui/runtime/visualizers/DynamicsVisualizerCanvas.jsx'
import AutomatableKnob from './AutomatableKnob.jsx'
import OverdoneCrossoverCanvas from './OverdoneCrossoverCanvas.jsx'
import useDeviceParams from './useDeviceParams.js'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './OverdoneDevice.module.css'

// Overdone (3-band upward + downward compressor) as a device.
//
// Hero: the crossover display (the three Linkwitz-Riley band curves, crossovers
// draggable on it) with each band's live upward and downward gain drawn in its
// region. The second view is the per-band level history the legacy editor drew
// under its knobs (the multiband painter, unchanged).
//
// Sections in signal order: Input -> Bands (the three band gains and the two
// crossovers, in the band palette: Low, Mid, High take slots 1, 2, 4) ->
// Dynamics (Depth, the hero knob, and Time) -> Output. Three gains fit one row,
// so there is no band selector.
//
// Params (engine XlethOTTEffect::createLayout): every write is the generic
// setEffectParameter, previewed at most once per frame during a drag and
// committed once on release (useDeviceParams). Stock parameters have no undo.

const P = {
  inputGain: { min: -24, max: 24, def: 0 },
  outputGain: { min: -24, max: 24, def: 0 },
  depth: { min: 0, max: 100, def: 70 },
  time: { min: 0, max: 100, def: 50 },
  gain_low: { min: -12, max: 12, def: 0 },
  gain_mid: { min: -12, max: 12, def: 0 },
  gain_high: { min: -12, max: 12, def: 0 },
  xover_low: { min: 40, max: 400, def: 88 },
  xover_high: { min: 1000, max: 8000, def: 2500 },
}
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(P).map(([id, p]) => [id, p.def])))

const VIEWS = [
  { value: 'crossover', label: 'Crossover', hint: 'Band curves and each band\'s live upward and downward gain; drag a crossover line to move it' },
  { value: 'history', label: 'History', hint: 'Level history per band: input, output and gain reduction' },
]

/** The well's inner height, so the history canvas draws at the size it occupies. */
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

export default function OverdoneDevice({ target, registerApplied, deviceKey }) {
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('overdone', DEFAULTS, target)
  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'crossover')
  const setView = useDeviceUiStore((s) => s.setView)
  const [historyRef, historyH] = useHeight()

  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const v = (id) => (Number.isFinite(params[id]) ? params[id] : P[id].def)
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
  const signed = { formatOptions: { signed: true }, bipolar: true }

  return (
    <>
      <DisplayWell
        label="Overdone display"
        width={420}
        views={VIEWS}
        view={view}
        onViewChange={(next) => setView(deviceKey, next)}
      >
        {view === 'history' ? (
          <div ref={historyRef} className={styles.display}>
            <DynamicsVisualizerCanvas
              trackId={target.trackId}
              nodeId={target.nodeId}
              sourceKey="overdone.bands"
              preset="overdoneBands"
              heightPx={Math.max(64, historyH || 200)}
              params={params}
            />
          </div>
        ) : (
          <OverdoneCrossoverCanvas
            className={styles.canvas}
            trackId={target.trackId}
            nodeId={target.nodeId}
            loHz={v('xover_low')}
            hiHz={v('xover_high')}
            gains={[v('gain_low'), v('gain_mid'), v('gain_high')]}
            lowRange={[P.xover_low.min, P.xover_low.max]}
            highRange={[P.xover_high.min, P.xover_high.max]}
            onPreview={preview}
            onCommit={commit}
          />
        )}
      </DisplayWell>

      <DeviceSection title="Input" width={72}>
        {knob('inputGain', 'Input', 'dB', { ...signed, hint: 'Gain into the band split' })}
      </DeviceSection>

      <DeviceSection title="Bands" width={212}>
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={styles.band} data-band={0}>{knob('gain_low', 'Low', 'dB', { ...signed, hint: 'Low band gain' })}</div>
            <div className={styles.band} data-band={1}>{knob('gain_mid', 'Mid', 'dB', { ...signed, hint: 'Mid band gain' })}</div>
            <div className={styles.band} data-band={2}>{knob('gain_high', 'High', 'dB', { ...signed, hint: 'High band gain' })}</div>
          </div>
          <div className={styles.row}>
            <div className={styles.band} data-band={0}>{knob('xover_low', 'Low split', 'Hz', { width: 76, hint: 'Low / mid crossover. Also draggable in the display.' })}</div>
            <div className={styles.band} data-band={2}>{knob('xover_high', 'High split', 'Hz', { width: 76, hint: 'Mid / high crossover. Also draggable in the display.' })}</div>
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Dynamics" width={96}>
        {knob('depth', 'Depth', '%', { size: 56, width: 84, hint: 'How much of the compressed signal is mixed in' })}
        {knob('time', 'Time', '%', { hint: 'Attack and release speed' })}
      </DeviceSection>

      <DeviceSection title="Output" width={72}>
        {knob('outputGain', 'Output', 'dB', { ...signed, hint: 'Gain after the bands are summed' })}
      </DeviceSection>
    </>
  )
}

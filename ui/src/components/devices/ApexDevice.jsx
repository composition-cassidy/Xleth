import React, { useCallback, useEffect, useRef } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { Redo2, RotateCcw, Undo2 } from 'lucide-react'
import {
  DeviceSection, DisplayWell, IconButton, SegmentedControl, Toggle, formatValue, skewScale,
} from '../../ui-kit'
import { apexStoreInitializer, BAND_PREFIX, SPLIT_BANDS } from '../../stores/apexStore.js'
import ApexCurveEditor from '../mixer/ApexCurveEditor.jsx'
import ApexAnalysis from '../mixer/ApexAnalysis.jsx'
import { BAND_KNOBS, GLOBAL_KNOBS, paramDefault } from '../mixer/apexGeometry.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import styles from './ApexDevice.module.css'

// APEX (multiband maximizer) as a device.
//
// Hero: the transfer-curve editor and the analysis display, side by side in one
// well. Both are the editor's own canvases (ApexCurveEditor, ApexAnalysis), with
// their drawing, hit-testing and viz subscription unchanged; they read this
// device's private store instead of the one global store, so several APEX
// devices (docked and popped out) never share curves, band or curve undo.
//
// Sections in signal order: Input (low cut) -> Crossover (the two splits and
// their slopes) -> Band (the selector, the selected band's state, detection,
// solo and curve undo) -> the selected band's eight knobs -> Mix (lookahead,
// band mix, the reported latency). The band selector swaps one fixed block of
// knobs, so the device never grows. Band colours are the band palette (DESIGN.md
// 3.3.1): Low / Mid / High take slots 1 / 2 / 4; Master is not a band and keeps
// the value colour.
//
// Writes are the legacy editor's: a knob previews through previewParam (local
// state, at most one engine write per frame) and commits once on release
// through commitParam; switches commit once per click. Curve edits keep the
// store's local undo / redo (one entry per gesture), on the buttons here and on
// Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) while focus is inside the device.

const BAND_OPTIONS = [
  { value: 0, label: 'Low' },
  { value: 1, label: 'Mid' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Master' },
]
const STATE_OPTIONS = [
  { value: 0, label: 'On', hint: 'Band compresses and saturates' },
  { value: 1, label: 'Comp off', hint: 'Dynamics bypassed; gains, saturation and separation still run' },
  { value: 2, label: 'Muted', hint: 'Band is silenced' },
  { value: 3, label: 'Off', hint: 'Band passes through dry, its processing skipped' },
]
const DETECT_OPTIONS = [
  { value: 0, label: 'Peak', hint: 'Peak detection' },
  { value: 1, label: 'RMS', hint: 'RMS detection' },
]
const SLOPE_OPTIONS = [
  { value: 0, label: '12 dB', ariaLabel: '12 dB per octave', hint: '12 dB per octave (LR2)' },
  { value: 1, label: '24 dB', ariaLabel: '24 dB per octave', hint: '24 dB per octave (LR4)' },
]

// Per-band knob table: the legacy BAND_KNOBS (ranges, defaults, skews) with
// sentence-case labels, kit units and the two rows they sit in.
const KNOB_META = {
  pre: { label: 'Pre gain', unit: 'dB', formatOptions: { signed: true }, hint: 'Gain into the band, before its curve' },
  att: { label: 'Attack', unit: 'ms' },
  rel: { label: 'Release', unit: 'ms' },
  sus: { label: 'Sustain', unit: 'ms', hint: 'Holds the gain reduction before release starts' },
  post: { label: 'Post gain', unit: 'dB', formatOptions: { signed: true }, hint: 'Gain out of the band' },
  satth: { label: 'Sat thresh', unit: '%', bipolar: true, formatOptions: { signed: true }, hint: 'Saturation threshold' },
  satcl: { label: 'Sat ceil', unit: 'dB', hint: 'Saturation ceiling' },
  sep: { label: 'Stereo sep', unit: '%', bipolar: true, formatOptions: { signed: true }, hint: 'Stereo separation: narrower below zero, wider above' },
}
const ROWS = [['pre', 'att', 'rel', 'sus'], ['post', 'satth', 'satcl', 'sep']]

const lowCutFormat = (v) => (v <= 0 ? 'Off' : formatValue(v, 'Hz'))

function latencyText(latency) {
  if (!latency) return '—'
  if (latency.latencyMs != null) return `${formatValue(latency.latencyMs, 'ms')} latency`
  return `${latency.latencySamples ?? 0} samples latency`
}

export default function ApexDevice({ target, registerApplied }) {
  const storeRef = useRef(null)
  if (storeRef.current === null) storeRef.current = createStore(apexStoreInitializer)
  const store = storeRef.current

  // Each device owns a private store: it opens against its own target and closes
  // on unmount, so a docked device never fights the one open in a window.
  useEffect(() => {
    store.getState().open(target.trackId, target.nodeId, target.storeKey, 'apex')
    return () => store.getState().close()
  }, [store, target.trackId, target.nodeId, target.storeKey])

  // Presets and A/B write the engine through the APEX adapter (params and
  // curves); mirror the blob they applied, as the editor's preset bar did.
  useEffect(() => {
    registerApplied?.((state) => store.getState().applyPresetState(state))
    return () => registerApplied?.(null)
  }, [registerApplied, store])

  return <ApexControls store={store} target={target} />
}

function ApexControls({ store, target }) {
  const band = useStore(store, (s) => s.selectedBand)
  const params = useStore(store, (s) => s.params)
  const latency = useStore(store, (s) => s.latency)
  const canUndo = useStore(store, (s) => s.undoStack.length > 0)
  const canRedo = useStore(store, (s) => s.redoStack.length > 0)
  const { previewParam, commitParam, setSolo, setSelectedBand, undoCurve, redoCurve, resetCurve } = store.getState()

  const p = (id) => (Number.isFinite(params[id]) ? params[id] : paramDefault(id))
  const prefix = BAND_PREFIX[band]
  const isMaster = band >= SPLIT_BANDS
  const bandState = (b) => Math.round(p(`${BAND_PREFIX[b]}state`))

  // Panel-scoped curve undo: only while focus is inside this device, and it
  // stops there so the app's timeline undo never sees it.
  const onKeyDown = useCallback((e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); store.getState().undoCurve() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); e.stopPropagation(); store.getState().redoCurve() }
  }, [store])

  const knob = (id, { label, unit, min, max, def, skew, size = 40, width = 60, ...extra }) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      skew={skew ?? 1}
      label={label}
      value={p(id)}
      min={min}
      max={max}
      scale={skew && skew !== 1 ? skewScale(min, max, skew) : undefined}
      defaultValue={def}
      unit={unit}
      size={size}
      width={width}
      data-param={id}
      onChange={(v) => previewParam(id, v)}
      onCommit={(v) => commitParam(id, v)}
      {...extra}
    />
  )
  const globalKnob = (key, extra) => {
    const g = GLOBAL_KNOBS[key]
    return knob(g.id, { min: g.min, max: g.max, def: g.default, skew: g.skew, ...extra })
  }
  const bandKnob = (suffix) => {
    const k = BAND_KNOBS.find((b) => b.suffix === suffix)
    const { label, unit, bipolar, formatOptions, hint } = KNOB_META[suffix]
    return knob(prefix + suffix, {
      label, unit, min: k.min, max: k.max, def: k.default, skew: k.skew, bipolar, formatOptions, hint,
    })
  }

  const bandOptions = BAND_OPTIONS.map((o) => {
    const silenced = bandState(o.value) >= 2
    return {
      ...o,
      glyph: <span className={`${styles.band} ${styles.swatch}`} data-band={o.value} data-silenced={silenced || undefined} aria-hidden="true" />,
      hint: `Edit the ${o.label.toLowerCase()} band${silenced ? ` (${STATE_OPTIONS[bandState(o.value)].label.toLowerCase()})` : ''}`,
    }
  })
  const soloOn = !isMaster && p(`${prefix}solo`) > 0.5

  return (
    <div className={styles.contents} onKeyDown={onKeyDown}>
      <DisplayWell label="APEX display" width={448}>
        <div className={styles.split}>
          <div className={styles.curve}>
            <ApexCurveEditor store={store} className={styles.canvas} />
          </div>
          <div className={styles.analysis}>
            <ApexAnalysis store={store} className={styles.canvas} />
          </div>
        </div>
      </DisplayWell>

      <DeviceSection title="Input" width={72}>
        {globalKnob('lowcut', {
          label: 'Low cut', unit: 'Hz', format: lowCutFormat, size: 40, width: 64,
          hint: 'High-pass before the crossover. Fully left is off.',
        })}
      </DeviceSection>

      <DeviceSection title="Crossover" width={176}>
        <div className={styles.splits}>
          <div className={styles.split1}>
            <div className={`${styles.band} ${styles.cell}`} data-band={0}>
              {globalKnob('split_lo', { label: 'Low split', unit: 'Hz', width: 76, hint: 'Low / mid crossover' })}
            </div>
            <SegmentedControl
              size="sm"
              label="Low split slope"
              value={p('slope_lo') > 0.5 ? 1 : 0}
              options={SLOPE_OPTIONS}
              data-param="slope_lo"
              onChange={(v) => commitParam('slope_lo', v)}
            />
          </div>
          <div className={styles.split1}>
            <div className={`${styles.band} ${styles.cell}`} data-band={2}>
              {globalKnob('split_hi', { label: 'High split', unit: 'Hz', width: 76, hint: 'Mid / high crossover' })}
            </div>
            <SegmentedControl
              size="sm"
              label="High split slope"
              value={p('slope_hi') > 0.5 ? 1 : 0}
              options={SLOPE_OPTIONS}
              data-param="slope_hi"
              onChange={(v) => commitParam('slope_hi', v)}
            />
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Band" width={204}>
        <div className={styles.column}>
          <SegmentedControl
            size="sm"
            label="Band"
            value={band}
            options={bandOptions}
            data-param="band"
            onChange={setSelectedBand}
          />
          <SegmentedControl
            size="sm"
            label={`${BAND_OPTIONS[band].label} state`}
            value={bandState(band)}
            options={STATE_OPTIONS}
            data-param={`${prefix}state`}
            onChange={(v) => commitParam(`${prefix}state`, v)}
          />
          <SegmentedControl
            size="sm"
            label={`${BAND_OPTIONS[band].label} detection`}
            value={p(`${prefix}det`) > 0.5 ? 1 : 0}
            options={DETECT_OPTIONS}
            data-param={`${prefix}det`}
            onChange={(v) => commitParam(`${prefix}det`, v)}
          />
          <div className={styles.tools}>
            <Toggle
              size="sm"
              on={soloOn}
              disabled={isMaster}
              hint={isMaster ? 'Master has no solo' : 'Solo this band (one band at a time)'}
              data-param={isMaster ? undefined : `${prefix}solo`}
              onChange={(on) => setSolo(band, on)}
            >
              Solo
            </Toggle>
            <span className={styles.spacer} />
            <IconButton size="sm" label="Undo curve edit" hint="Undo the last curve edit (Ctrl+Z)" disabled={!canUndo} onClick={undoCurve}>
              <Undo2 size={14} aria-hidden="true" />
            </IconButton>
            <IconButton size="sm" label="Redo curve edit" hint="Redo the curve edit (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redoCurve}>
              <Redo2 size={14} aria-hidden="true" />
            </IconButton>
            <IconButton size="sm" label={`Reset ${BAND_OPTIONS[band].label.toLowerCase()} curve`} hint="Reset this band's curve to unity" onClick={() => resetCurve(band)}>
              <RotateCcw size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title={`${BAND_OPTIONS[band].label} band`} width={264}>
        <div className={`${styles.band} ${styles.grid}`} data-band={band}>
          {ROWS.map((row) => (
            <div key={row[0]} className={styles.row}>
              {row.map((suffix) => bandKnob(suffix))}
            </div>
          ))}
        </div>
      </DeviceSection>

      <DeviceSection title="Mix" width={96}>
        {globalKnob('lookahead', { label: 'Lookahead', unit: 'ms', width: 76 })}
        {globalKnob('bandmix', { label: 'Band mix', unit: '%', width: 76, hint: 'Processed bands against the dry signal' })}
        <span className={styles.readout} data-hint="Reported latency (lookahead and oversampling)">{latencyText(latency)}</span>
      </DeviceSection>
    </div>
  )
}

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import {
  DeviceSection, DisplayWell, NumberBox, Select, Toggle,
} from '../../ui-kit'
import { waveshaperStoreInitializer } from '../../stores/waveshaperStore.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import WaveshaperCurveCanvas from './WaveshaperCurveCanvas.jsx'
import { MAX_POINTS, MIN_POINTS, clamp, clampBetweenNeighbours, isEndPoint } from './waveshaperCurve.js'
import { plainFormat } from './deviceFormat.js'
import useDeviceParams from './useDeviceParams.js'
import deviceStyles from './deviceBody.module.css'
import styles from './WaveshaperDevice.module.css'

const WELL_W = 252

// Every id is an existing engine parameter (XlethWaveshaperEffect.h); ranges mirror
// its NormalisableRange bounds. `preset` mirrors the engine's own preset index.
const DEFAULTS = Object.freeze({ pregain: 0, postgain: 0, mix: 100, preset: 0 })

// 0 is "Custom": what the curve is once a point has been edited. It is a state,
// not a choice, so it is listed for reading and cannot be picked.
const SHAPE_OPTIONS = [
  { value: 0, label: 'Custom', disabled: true },
  { value: 1, label: 'Soft clip' },
  { value: 2, label: 'Hard clip' },
  { value: 3, label: 'Tube' },
  { value: 4, label: 'Fold' },
  { value: 5, label: 'Rectify' },
]

const DEFAULT_FLAGS = Object.freeze({ snapZero: false, lockEnds: false, showInput: true, smoothCurve: true })
const EDIT_TOGGLES = [
  ['snapZero', 'Snap zero', 'Pull a point onto 0 when it is close'],
  ['lockEnds', 'Lock ends', 'Pin the first and last points'],
  ['showInput', 'Show input', 'Draw the out = in diagonal for reference'],
  ['smoothCurve', 'Smooth curve', 'Spline through the points, or straight segments'],
]

// The Waveshaper as a device. The hero is the editable transfer curve; every curve
// edit is the editor's: optimistic local points while dragging, then one
// wsSetCurvePoints on release (which makes the shape "Custom"), wsSetPreset for a
// preset. Gain, mix and preset write setEffectParameter as before.
//
// Signal order: curve (hero) -> Shape -> Point -> Input -> Output. The engine has
// no oversampling parameter, so there is no control for it. Each device owns a
// private store (createStore, the EQ precedent) so two Waveshapers never share points.
export default function WaveshaperDevice({ target, registerApplied }) {
  const storeRef = useRef(null)
  if (storeRef.current === null) storeRef.current = createStore(waveshaperStoreInitializer)
  const store = storeRef.current

  const points = useStore(store, (s) => s.points)
  const preset = useStore(store, (s) => s.preset)
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams('waveshaper', DEFAULTS, target)

  useEffect(() => {
    store.getState().open(target.trackId, target.nodeId, target.storeKey)
    return () => { store.getState().close() }
  }, [store, target.trackId, target.nodeId, target.storeKey])

  // The engine's preset index, once hydrated or after a preset load or A/B switch.
  useEffect(() => { store.setState({ preset: Math.round(params.preset) }) }, [store, params.preset])

  // A preset load or A/B switch wrote the params and the curve through its adapter.
  const onApplied = useCallback((state) => {
    syncParamsFromPreset(state)
    store.getState().fetchCurvePoints()
  }, [store, syncParamsFromPreset])
  useEffect(() => {
    registerApplied?.(onApplied)
    return () => registerApplied?.(null)
  }, [registerApplied, onApplied])

  const [flags, setFlags] = useState(DEFAULT_FLAGS)
  const [selected, setSelected] = useState(-1)
  // The points array is replaced by a preset: drop the selection with it.
  useEffect(() => { setSelected(-1) }, [preset])

  const pt = points[selected] ?? null
  const lockedPoint = pt && flags.lockEnds && isEndPoint(points, selected)

  const onPreview = useCallback((index, x, y) => {
    store.setState((s) => {
      if (!s.points[index]) return s
      const next = [...s.points]
      next[index] = [x, y]
      return { points: next }
    })
  }, [store])
  const onCommit = useCallback((index, x, y) => { store.getState().movePoint(index, x, y) }, [store])
  const onAdd = useCallback(async (x, y) => {
    await store.getState().addPoint(x, y)
    const i = store.getState().points.findIndex((p) => p[0] === x && p[1] === y)
    if (i >= 0) setSelected(i)
  }, [store])
  const onRemove = useCallback(async (index) => {
    await store.getState().removePoint(index)
    setSelected(-1)
  }, [store])

  const knob = (id, label, unit, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      label={label}
      value={params[id]}
      defaultValue={DEFAULTS[id]}
      unit={unit}
      onChange={(v) => preview(id, v)}
      onCommit={(v) => commit(id, v)}
      data-param={id}
      {...extra}
    />
  )

  const flagToggle = ([key, label, hint]) => (
    <Toggle
      key={key}
      size="sm"
      on={flags[key]}
      onChange={(on) => setFlags((f) => ({ ...f, [key]: on }))}
      hint={hint}
    >
      {label}
    </Toggle>
  )

  const noPoint = () => '—'
  const pointBox = (axis, label) => {
    const v = pt ? pt[axis] : 0
    return (
      <NumberBox
        label={label}
        value={v}
        min={-1}
        max={1}
        bipolar
        defaultValue={0}
        width={92}
        disabled={!pt || !!lockedPoint}
        format={pt ? plainFormat(3, true) : noPoint}
        onChange={(n) => {
          if (!pt) return
          const x = axis === 0 ? clampBetweenNeighbours(points, selected, n) : pt[0]
          onPreview(selected, x, axis === 1 ? clamp(n, -1, 1) : pt[1])
        }}
        onCommit={(n) => {
          if (!pt) return
          const x = axis === 0 ? clampBetweenNeighbours(points, selected, n) : pt[0]
          onCommit(selected, x, axis === 1 ? clamp(n, -1, 1) : pt[1])
        }}
        hint={axis === 0 ? 'Input level of the selected point (−1 to +1)' : 'Output level of the selected point (−1 to +1)'}
      />
    )
  }

  return (
    <>
      <DisplayWell label="Waveshaper curve" width={WELL_W}>
        <div className={styles.display}>
          <WaveshaperCurveCanvas
            points={points}
            selectedIndex={selected}
            flags={flags}
            onSelect={setSelected}
            onPreview={onPreview}
            onCommit={onCommit}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        </div>
      </DisplayWell>

      <DeviceSection title="Shape" width={140}>
        <div className={deviceStyles.column}>
          <Select
            size="sm"
            ariaLabel="Waveshaper shape"
            value={preset}
            options={SHAPE_OPTIONS}
            onChange={(v) => store.getState().setPreset(v)}
            hint="Load a shape into the curve. Editing a point makes it Custom."
          />
          <div className={styles.toggles}>{EDIT_TOGGLES.map(flagToggle)}</div>
        </div>
      </DeviceSection>

      <DeviceSection title="Point" width={116}>
        <div className={deviceStyles.column}>
          {pointBox(0, 'In')}
          {pointBox(1, 'Out')}
          <span className={deviceStyles.caption} data-hint={`The curve holds ${MIN_POINTS} to ${MAX_POINTS} points`}>
            {points.length} {points.length === 1 ? 'point' : 'points'}
          </span>
        </div>
      </DeviceSection>

      <DeviceSection title="Input" width={76}>
        {knob('pregain', 'Pre gain', 'dB', { min: -24, max: 48, size: 44, width: 68, skew: 1, hint: 'Gain into the shaper' })}
      </DeviceSection>

      <DeviceSection title="Output" width={76}>
        <div className={deviceStyles.stack}>
          {knob('postgain', 'Post gain', 'dB', { min: -24, max: 24, size: 44, width: 68, skew: 1, hint: 'Gain after the shaper' })}
          {knob('mix', 'Mix', '%', { min: 0, max: 100, size: 44, width: 68, skew: 1 })}
        </div>
      </DeviceSection>
    </>
  )
}

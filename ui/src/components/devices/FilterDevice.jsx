import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import {
  Button, DeviceSection, DisplayWell, IconButton, SegmentedControl, Select, Toggle, formatValue, skewScale,
} from '../../ui-kit'
import {
  filterStoreInitializer, SLOT_TYPES, SLOPES, MAX_SLOTS, activeMods,
  typeUsesGain, typeUsesMorph, typeUsesSlope, typeGainLabel, typeGainRange, typeMorphLabel,
} from '../../stores/filterStore.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import FilterResponseCanvas from './FilterResponseCanvas.jsx'
import { ModulatorEditor, ModulatorList } from './FilterModulation.jsx'
import { fractionPercent, plainFormat } from './deviceFormat.js'
import { useFilterLiveLoop, useLiveFrame } from './filterLive.js'
import deviceStyles from './deviceBody.module.css'
import styles from './FilterDevice.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcPlus = iconComponent('plus')
const IcX = iconComponent('x')

const WELL_W = 420
const FREQ_SKEW = 0.23
const Q_SKEW = 0.18
const CUTOFF_SCALE = skewScale(20, 20000, FREQ_SKEW)
const Q_SCALE = skewScale(0.5, 30, Q_SKEW)
const CURVE_REFRESH_MS = 100

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const sentence = (text) => text.charAt(0) + text.slice(1).toLowerCase()

// Short names for the slot rail, indexed by slot type (lockstep with SLOT_TYPES).
const TYPE_SHORT = [
  'Low pass', 'High pass', 'Band pass', 'Notch', 'All pass', 'Peak', 'Low shelf', 'High shelf', 'Morph',
  'Moog', 'TB-303', 'SK 12', 'SK 24', 'Steiner LP', 'Steiner BP', 'Steiner HP',
  'Comb FF', 'Comb res', 'Formant', 'Tilt',
]

const TYPE_OPTIONS = SLOT_TYPES.map((t) => ({
  value: t.value,
  label: t.label,
  group: t.value <= 8 ? 'Standard' : t.value <= 15 ? 'Analog' : 'Character',
}))
const SLOPE_OPTIONS = SLOPES.map((s) => ({ value: s.value, label: s.label }))

// ModDest index -> the knob it moves, in the order MOD_DESTS declares them.
const MOD_DEST_FIELDS = ['cutoff', 'q', 'gain', 'morph', 'drive', 'mix']

// How far a live value has to sit from the parked one before the device prints it,
// per destination and in that destination's own units. Below these the two numbers
// would read identically anyway and the extra line is just flicker.
const LIVE_EPSILON = { cutoff: 0.5, q: 0.005, gain: 0.05, morph: 0.002, drive: 0.05, mix: 0.002 }

const fmtHz = (v) => formatValue(v, 'Hz')
const fmtQ = plainFormat(2)
const fmtGain = (v) => formatValue(v, 'dB', { signed: true })
const fmtDrive = (v) => formatValue(v, 'dB')

/** The live, post-modulation value of one slot knob, printed under the parked one. */
function LiveValue({ bus, slotIndex, field, fmt, base }) {
  const ref = useRef(null)
  useLiveFrame(bus, (frame) => {
    const el = ref.current
    if (!el) return
    const ls = frame?.slots?.[slotIndex]
    const v = (ls && ls.valid) ? ls[field] : null
    const text = (Number.isFinite(v) && Math.abs(v - base) > (LIVE_EPSILON[field] ?? 1e-4)) ? fmt(v) : ''
    if (el.textContent !== text) el.textContent = text
  })
  return <div className={styles.live} ref={ref} data-filter-live-value="" aria-hidden="true" />
}

// The Xleth Filter as a device. Up to eight slots, each a filter with its own
// type, cutoff, resonance, drive and mix and up to six modulator lanes. Every write
// is the editor's: the private store's setSlotParam / setModParam over the
// audio_filter* RPCs, with the response refetched shortly after each edit.
//
// Signal order: Slots -> response (hero) -> Filter -> Tone -> Shape -> Modulators.
// Cutoff is the hero knob. Each device owns a private store (createStore, the EQ
// precedent), so two filters, docked or popped out, never share slots or selection.
export default function FilterDevice({ target, registerApplied }) {
  const storeRef = useRef(null)
  if (storeRef.current === null) storeRef.current = createStore(filterStoreInitializer)
  const store = storeRef.current

  const slots = useStore(store, (s) => s.slots)
  const selectedSlotIndex = useStore(store, (s) => s.selectedSlotIndex)
  const { bus, liveRef } = useFilterLiveLoop(store)

  const aggregateRef = useRef(null)
  const [curveVersion, setCurveVersion] = useState(0)
  const timerRef = useRef(null)
  const aliveRef = useRef(true)

  const refreshCurve = useCallback(async () => {
    const c = await store.getState().fetchResponseCurve()
    if (aliveRef.current && c && c.length > 1) {
      aggregateRef.current = c
      setCurveVersion((v) => v + 1)
    }
  }, [store])

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      refreshCurve()
    }, CURVE_REFRESH_MS)
  }, [refreshCurve])

  useEffect(() => {
    aliveRef.current = true
    store.getState().open(target.trackId, target.nodeId, target.storeKey)
    aggregateRef.current = null
    refreshCurve()
    return () => {
      aliveRef.current = false
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      store.getState().close()
    }
  }, [store, target.trackId, target.nodeId, target.storeKey, refreshCurve])

  // A preset load or an A/B switch wrote the engine through its adapter: re-read.
  const onApplied = useCallback(() => {
    store.getState().fetchSlots()
    refreshCurve()
  }, [store, refreshCurve])
  useEffect(() => {
    registerApplied?.(onApplied)
    return () => registerApplied?.(null)
  }, [registerApplied, onApplied])

  // A selected slot is always there when there is one (the device has no room for
  // a "select a slot" state).
  useEffect(() => {
    if (slots.length > 0 && selectedSlotIndex < 0) store.getState().setSelectedSlot(0)
  }, [store, slots.length, selectedSlotIndex])

  const slot = selectedSlotIndex >= 0 ? (slots[selectedSlotIndex] ?? null) : null
  const index = selectedSlotIndex
  const mods = useMemo(() => activeMods(slot), [slot])

  const [laneChoice, setLaneChoice] = useState(-1)
  useEffect(() => { setLaneChoice(-1) }, [index])
  const lane = mods.find((m) => Number(m.index) === laneChoice) ?? mods[0] ?? null

  const handleParam = useCallback((i, name, value) => {
    store.getState().setSlotParam(i, name, value)
    scheduleRefresh()
  }, [store, scheduleRefresh])
  const handlePatch = useCallback((i, patch) => {
    for (const [name, value] of Object.entries(patch)) store.getState().setSlotParam(i, name, value)
    scheduleRefresh()
  }, [store, scheduleRefresh])
  const handleModParam = useCallback((i, laneIndex, name, value) => {
    store.getState().setModParam(i, laneIndex, name, value)
    scheduleRefresh()
  }, [store, scheduleRefresh])
  const handleCutMin = useCallback((i, laneIndex, value) => {
    store.getState().setCutMin(i, laneIndex, value)
    scheduleRefresh()
  }, [store, scheduleRefresh])
  const handleCutMax = useCallback((i, laneIndex, value) => {
    store.getState().setCutMax(i, laneIndex, value)
    scheduleRefresh()
  }, [store, scheduleRefresh])
  // Add / remove need a full refetch: the engine seeds a new lane with its kind's
  // defaults, and those come back in the next getSlots payload.
  const handleAddMod = useCallback(async (i, kind) => {
    const added = await store.getState().addModulator(i, kind)
    if (added >= 0) setLaneChoice(added)
    refreshCurve()
  }, [store, refreshCurve])
  const handleRemoveMod = useCallback(async (i, laneIndex) => {
    await store.getState().removeModulator(i, laneIndex)
    await store.getState().fetchSlots()
    refreshCurve()
  }, [store, refreshCurve])
  const handleAddSlot = useCallback(async () => {
    await store.getState().addSlot()
    refreshCurve()
  }, [store, refreshCurve])
  const handleRemoveSlot = useCallback(async (i) => {
    await store.getState().removeSlot(i)
    refreshCurve()
  }, [store, refreshCurve])
  const handleSelect = useCallback((i) => store.getState().setSelectedSlot(i), [store])

  // Only the knobs something is actually aimed at get a live readout row. The row
  // keeps its height once a lane points at a knob, so the deck does not jog when a
  // modulator crosses back through its parked value; a knob nothing touches
  // renders exactly as it would without modulators at all.
  const aimed = useMemo(() => {
    const set = new Set()
    for (const m of mods) set.add(MOD_DEST_FIELDS[clamp(Math.round(m.dest ?? 0), 0, 5)])
    return set
  }, [mods])

  const type = clamp(Math.round(slot?.type ?? 0), 0, SLOT_TYPES.length - 1)
  const slope = clamp(Math.round(slot?.slope ?? 1), 0, 3)
  const off = !slot

  // One slot knob: the kit Knob with the editor's automation opt-in (the slot's
  // APVTS id is "s<index>_<name>") and a live row when a lane is aimed at it.
  const slotKnob = (field, label, { fmt, ...props }) => {
    const base = Number(slot?.[field] ?? props.defaultValue)
    return (
      <div className={styles.knobCell} key={field}>
        <AutomatableKnob
          paramId={slot ? `s${index}_${field}` : undefined}
          target={target}
          label={label}
          value={base}
          disabled={off}
          onChange={(v) => handleParam(index, field, v)}
          onCommit={(v) => handleParam(index, field, v)}
          data-param={field}
          {...props}
        />
        {aimed.has(field) ? <LiveValue bus={bus} slotIndex={index} field={field} fmt={fmt} base={base} /> : null}
      </div>
    )
  }

  const gainRange = typeGainRange(type)

  return (
    <>
      <DeviceSection title="Slots" width={132}>
        <div className={styles.slots}>
          {slots.map((s, i) => {
            const enabled = !!s.enabled
            const t = clamp(Math.round(s.type ?? 0), 0, SLOT_TYPES.length - 1)
            return (
              <div className={styles.slotRow} key={i} data-off={enabled ? undefined : 'true'}>
                <Toggle
                  size="sm"
                  className={styles.slotNumber}
                  on={enabled}
                  aria-label={`Slot ${i + 1} on`}
                  onChange={(on) => handleParam(i, 'enabled', on ? 1 : 0)}
                  hint={enabled ? 'Slot on. Click to silence it.' : 'Slot silenced. Click to turn it on.'}
                >
                  {i + 1}
                </Toggle>
                <button
                  type="button"
                  className={styles.slotSelect}
                  aria-pressed={i === index}
                  onClick={() => handleSelect(i)}
                  data-hint={`${SLOT_TYPES[t].label}. Select to edit this slot.`}
                >
                  {TYPE_SHORT[t]}
                </button>
                <IconButton size="sm" label={`Remove slot ${i + 1}`} onClick={() => handleRemoveSlot(i)}>
                  <IcX aria-hidden="true" />
                </IconButton>
              </div>
            )
          })}
          {slots.length < MAX_SLOTS ? (
            <Button size="sm" glyph={<IcPlus aria-hidden="true" />} onClick={handleAddSlot} hint="Add a filter slot (up to eight, in series)">
              Add slot
            </Button>
          ) : null}
        </div>
      </DeviceSection>

      <DisplayWell label="Filter response" width={WELL_W}>
        <div className={styles.display}>
          <FilterResponseCanvas
            slots={slots}
            selectedSlotIndex={selectedSlotIndex}
            aggregateRef={aggregateRef}
            version={curveVersion}
            liveBus={bus}
            liveRef={liveRef}
            onSelect={handleSelect}
            onPreview={handlePatch}
            onCommit={handlePatch}
          />
        </div>
      </DisplayWell>

      <DeviceSection title="Filter" width={148}>
        <div className={styles.column}>
          <span className={styles.caption}>Type</span>
          <Select
            size="sm"
            ariaLabel="Filter type"
            value={type}
            options={TYPE_OPTIONS}
            disabled={off}
            onChange={(v) => handleParam(index, 'type', v)}
          />
          <span className={styles.caption}>Slope, dB per octave</span>
          <SegmentedControl
            size="sm"
            label="Filter slope"
            value={slope}
            options={SLOPE_OPTIONS}
            disabled={off || !typeUsesSlope(type)}
            onChange={(v) => handleParam(index, 'slope', v)}
            hint={typeUsesSlope(type) ? 'Steepness of the filter, per octave' : 'This filter type has a fixed slope'}
          />
        </div>
      </DeviceSection>

      <DeviceSection title="Tone" width={152}>
        <div className={deviceStyles.pair}>
          {slotKnob('cutoff', 'Cutoff', {
            scale: CUTOFF_SCALE, defaultValue: 1000, unit: 'Hz', skew: FREQ_SKEW, size: 56, width: 76, fmt: fmtHz,
            min: 20, max: 20000,
            hint: 'Cutoff. Also draggable as the node in the display.',
          })}
          <div className={styles.stack}>
            {slotKnob('q', 'Resonance', {
              scale: Q_SCALE, defaultValue: 0.7071, format: fmtQ, skew: Q_SKEW, size: 40, width: 72, fmt: fmtQ,
              min: 0.5, max: 30,
              hint: 'Resonance (Q). Also the wheel over the display.',
            })}
            {typeUsesGain(type)
              ? slotKnob('gain', sentence(typeGainLabel(type)), {
                min: gainRange.min, max: gainRange.max, defaultValue: 0, unit: 'dB', formatOptions: { signed: true }, bipolar: true, size: 40, width: 72, fmt: fmtGain,
              })
              : null}
            {typeUsesMorph(type)
              ? slotKnob('morph', sentence(typeMorphLabel(type)), {
                min: 0, max: 1, defaultValue: 0, format: plainFormat(2), size: 40, width: 72, fmt: plainFormat(2),
              })
              : null}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Shape" width={84}>
        <div className={styles.stack}>
          {slotKnob('drive', 'Drive', { min: 0, max: 24, defaultValue: 0, unit: 'dB', size: 40, width: 72, fmt: fmtDrive })}
          {slotKnob('mix', 'Mix', { min: 0, max: 1, defaultValue: 1, ...fractionPercent, size: 40, width: 72, fmt: fractionPercent.format })}
        </div>
      </DeviceSection>

      <DeviceSection title="Modulators" width={216}>
        {slot ? (
          <ModulatorList
            slotIndex={index}
            mods={mods}
            selectedLane={lane ? Number(lane.index) : -1}
            onSelect={setLaneChoice}
            onAdd={handleAddMod}
            onRemove={handleRemoveMod}
            liveBus={bus}
          />
        ) : (
          <p className={styles.empty}>Add a slot to give it modulators.</p>
        )}
      </DeviceSection>

      {slot && lane ? (
        <DeviceSection title={`Modulator ${Number(lane.index) + 1}`} width={344}>
          <ModulatorEditor
            slotIndex={index}
            mod={lane}
            onModParam={handleModParam}
            onCutMin={handleCutMin}
            onCutMax={handleCutMax}
            liveBus={bus}
          />
        </DeviceSection>
      ) : null}
    </>
  )
}

import React, { useCallback, useEffect, useRef } from 'react'
import { DeviceSection, DisplayWell, Meter, SegmentedControl, Toggle, formatValue } from '../../ui-kit'
import { useEffectMeterPolling, useMeterBus } from '../../plugin-ui/runtime/useEffectMeterPolling.js'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import useDeviceParams from './useDeviceParams.js'
import { MODELS, varimuReadout } from './compressorFamilyModels.js'
import styles from './CompressorFamilyDevice.module.css'

const GR_MAX_DB = 20
const GR_SCALE = [0, 3, 6, 10, 20]
const WELL_W = 104

const grText = (gr) => formatValue(gr >= 0.05 ? -gr : 0, 'dB')

// The four character compressors on CompressorCore (Glue, Opto, FET, Vari-Mu) as
// one device. The model config (compressorFamilyModels.js) decides the sections
// and controls; this body draws them in signal order:
//
//   gain reduction (hero) -> Input -> Character -> Time -> (Sidechain) -> Output
//
// Writes are the legacy panels' exactly: a knob drag previews locally with the
// engine write coalesced to one per frame, and commits once on release; a stepped
// switch is a single commit. Nothing here adds IPC.
//
// The hero is a gain-reduction meter with a numeric readout. The engine feeds
// these four effects one meter slot (gain reduction, dB; Vari-Mu in Mid/Side
// feeds a mid and a side slot) and no history, so there is no trace.
export default function CompressorFamilyDevice({ model: modelId, target, registerApplied }) {
  const model = MODELS[modelId]
  const { params, preview, commit, syncParamsFromPreset } = useDeviceParams(modelId, model.defaults, target)
  const meterBus = useMeterBus()
  useEffectMeterPolling(target, meterBus)

  // Presets and A/B write the engine through their adapter; mirror the blob here.
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const value = (id) => params[id] ?? model.defaults[id]
  const index = (id) => Math.round(value(id))

  const midSide = modelId === 'varimu' && index('mode') === 1
  const readoutRefs = [useRef(null), useRef(null)]

  // ── Gain reduction: dB of reduction (0 = none), straight to the meter and the
  // readout text, no React render per frame.
  const subscribeGr = useCallback((push) => {
    const show = (i, gr) => {
      const el = readoutRefs[i].current
      if (el) el.textContent = grText(gr)
    }
    if (midSide) {
      let mid = 0
      meterBus.register('device-gr-mid', 'VARIMU_GR_MID', (raw) => { mid = Math.max(0, Number(raw) || 0) })
      meterBus.register('device-gr-side', 'VARIMU_GR_SIDE', (raw) => {
        const side = Math.max(0, Number(raw) || 0)
        push([mid, side])
        show(0, mid)
        show(1, side)
      })
      return () => { meterBus.unregister('device-gr-mid'); meterBus.unregister('device-gr-side') }
    }
    meterBus.register('device-gr', 'GAIN_REDUCTION', (raw) => {
      const gr = Math.max(0, Number(raw) || 0)
      push(gr)
      show(0, gr)
    })
    return () => meterBus.unregister('device-gr')
    // readoutRefs are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meterBus, midSide])

  const renderKnob = (item) => {
    const enabled = item.enabledBy ? value(item.enabledBy) >= 0.5 : true
    const v = value(item.id)
    return (
      <div key={item.id} className={styles.cell} data-off={enabled ? undefined : 'true'}>
        <AutomatableKnob
          paramId={item.id}
          target={target}
          skew={item.skew ?? 1}
          label={item.label}
          value={v}
          min={item.min}
          max={item.max}
          defaultValue={item.def}
          unit={item.unit ?? undefined}
          format={item.format}
          formatOptions={item.formatOptions}
          scale={item.scale}
          size={item.size ?? 44}
          width={item.width ?? 68}
          hint={item.hint}
          data-param={item.id}
          onChange={(nv) => preview(item.id, nv)}
          onCommit={(nv) => commit(item.id, nv)}
        />
        {item.caption ? <span className={styles.caption} data-hint={`${item.label} time`}>{item.caption(v)}</span> : null}
      </div>
    )
  }

  const renderSeg = (item) => (
    <div key={item.id} className={styles.field}>
      <span className={styles.fieldLabel}>
        {item.label}
        {item.unit ? <span className={styles.unit}> {item.unit}</span> : null}
      </span>
      <AutomationTarget paramId={item.id} target={target}>
        <SegmentedControl
          size={item.hero ? 'lg' : 'sm'}
          label={item.label}
          value={index(item.id)}
          options={item.options}
          hint={item.hint}
          data-param={item.id}
          onChange={(v) => commit(item.id, v)}
        />
      </AutomationTarget>
      {item.readout === 'varimu' ? <VariMuReadout position={index(item.id)} /> : null}
    </div>
  )

  const renderToggle = (item) => (
    <AutomationTarget paramId={item.id} target={target}>
      <Toggle
        key={item.id}
        size="sm"
        on={value(item.id) >= 0.5}
        hint={item.hint}
        data-param={item.id}
        onChange={(on) => commit(item.id, on ? 1 : 0)}
      >
        {item.label}
      </Toggle>
    </AutomationTarget>
  )

  const renderItem = (item) => (item.type === 'knob' ? renderKnob(item) : item.type === 'seg' ? renderSeg(item) : renderToggle(item))

  return (
    <>
      <DisplayWell label="Gain reduction" width={WELL_W}>
        <div className={styles.gr} data-hint="Gain reduction, dB. The bar hangs from the top and holds its peak.">
          <span className={styles.grTitle}>{model.grTitle}</span>
          <div className={styles.grBody}>
            <Meter
              className={styles.grMeter}
              label={midSide ? 'Gain reduction, mid and side' : 'Gain reduction'}
              subscribe={subscribeGr}
              channels={midSide ? 2 : 1}
              direction="down"
              min={0}
              max={GR_MAX_DB}
              scaleDb={GR_SCALE}
              fallDbPerSec={240}
              holdMs={1200}
            />
            <div className={styles.grReadouts}>
              {midSide ? (
                <>
                  <span className={styles.caption}>Mid</span>
                  <span ref={readoutRefs[0]} className={styles.readout} aria-live="off">{grText(0)}</span>
                  <span className={styles.caption}>Side</span>
                  <span ref={readoutRefs[1]} className={styles.readout} aria-live="off">{grText(0)}</span>
                </>
              ) : (
                <span ref={readoutRefs[0]} className={styles.readout} aria-live="off">{grText(0)}</span>
              )}
            </div>
          </div>
        </div>
      </DisplayWell>

      {model.sections.map((section) => (
        <DeviceSection key={section.title} title={section.title} width={section.width}>
          {section.items.map(renderItem)}
        </DeviceSection>
      ))}
    </>
  )
}

function VariMuReadout({ position }) {
  const r = varimuReadout(position)
  return (
    <div className={styles.timeReadout} data-hint="What this position means. Positions 5 and 6 are automatic.">
      <span className={styles.caption}>Attack</span>
      <span className={styles.readout}>{r.attack}</span>
      <span className={styles.caption}>Release</span>
      <span className={styles.readout}>{r.release}</span>
    </div>
  )
}

export const GlueDevice = (props) => <CompressorFamilyDevice {...props} model="glue" />
export const OptoDevice = (props) => <CompressorFamilyDevice {...props} model="opto" />
export const FetDevice = (props) => <CompressorFamilyDevice {...props} model="fet" />
export const VariMuDevice = (props) => <CompressorFamilyDevice {...props} model="varimu" />

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DeviceSection, DisplayWell, Meter, SegmentedControl, Select, Toggle, formatValue,
} from '../../ui-kit'
import AutomatableKnob from './AutomatableKnob.jsx'
import AutomationTarget from './AutomationTarget.jsx'
import { getManifest } from '../../plugin-ui/manifests/index.js'
import { PluginUIContext } from '../../plugin-ui/runtime/PluginUIContext.js'
import useStockEffectParams from '../../plugin-ui/runtime/useStockEffectParams.js'
import { useEffectMeterPolling, useMeterBus } from '../../plugin-ui/runtime/useEffectMeterPolling.js'
import VisualizerNode from '../../plugin-ui/runtime/components/VisualizerNode.jsx'
import CompressorCurveNode from '../../plugin-ui/runtime/components/CompressorCurveNode.jsx'
import {
  compressorLevelDbForY, compressorLevelToY, COMPRESSOR_DISPLAY,
} from '../../plugin-ui/runtime/visualizers/compressorPainter.js'
import { canShowSidechainControls, useEffectSidechain } from '../mixer/EffectModule.jsx'
import useDeviceUiStore from './deviceUiStore.js'
import styles from './CompressorDevice.module.css'

const PLUGIN_ID = 'compressor'
const WELL_W = 272
const GR_SCALE = [0, 3, 6, 12, 24]
const THRESHOLD_GRAB_PX = 8

const VIEWS = [
  { value: 'activity', label: 'Activity', hint: 'Input and output level, gain reduction from the top, the threshold line (drag it)' },
  { value: 'curve', label: 'Curve', hint: 'Transfer curve over the input level. Drag the threshold, knee and ratio handles.' },
]
const DETECT_OPTIONS = [
  { value: 0, label: 'Peak', hint: 'Detector follows sample peaks' },
  { value: 1, label: 'RMS', hint: 'Detector follows the average (RMS) level' },
]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** The well's inner height, so the existing canvases draw at the size they occupy. */
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

// The Compressor as a device (the Phase 4a reference). Parameter writes, meters
// and the visualizer stream are exactly the plugin-ui runtime's: the same hooks,
// the same painter, the same curve editor, hosted in a DeviceFrame body.
//
// Signal order: display (hero) → GR → Detection → Time → Output → Sidechain.
// The engine's NormalisableRange skew per parameter (only the automation maths
// needs it; a knob's own travel comes from its range or scale).
const SKEW = Object.freeze({ ratio: 0.35, attack: 0.3, release: 0.3 })

export default function CompressorDevice({ target, registerApplied, deviceKey, effect }) {
  const manifest = useMemo(() => getManifest(PLUGIN_ID), [])
  const { params, setParam, syncParamsFromPreset } = useStockEffectParams(PLUGIN_ID, manifest, target)
  const meterBus = useMeterBus()
  useEffectMeterPolling(target, meterBus)

  // Presets and A/B write the engine through their adapter; mirror the blob here.
  useEffect(() => {
    registerApplied?.(syncParamsFromPreset)
    return () => registerApplied?.(null)
  }, [registerApplied, syncParamsFromPreset])

  const ctx = useMemo(() => ({
    target, manifest, params, setParam, meterBus, onClose: null, layoutErrors: [],
  }), [target, manifest, params, setParam, meterBus])

  const view = useDeviceUiStore((s) => s.views[deviceKey] ?? 'activity')
  const setView = useDeviceUiStore((s) => s.setView)
  const sidechainFolded = useDeviceUiStore((s) => s.sections[`${deviceKey}:sidechain`] ?? true)
  const setSectionFolded = useDeviceUiStore((s) => s.setSectionFolded)

  const [wellRef, wellH] = useHeight()

  // ── GR meter: the GAIN_REDUCTION meter slot, dB of reduction (0 = none).
  const readoutRef = useRef(null)
  const subscribeGr = useCallback((push) => {
    meterBus.register('device-gr', 'GAIN_REDUCTION', (raw) => {
      const gr = Math.abs(Number(raw) || 0)
      push(gr)
      if (readoutRef.current) readoutRef.current.textContent = formatValue(gr >= 0.05 ? -gr : 0, 'dB')
    })
    return () => meterBus.unregister('device-gr')
  }, [meterBus])

  // ── Activity view: drag the threshold line.
  const dragRef = useRef(false)
  const thresholdFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return clamp(compressorLevelDbForY(e.clientY - rect.top, rect.height), manifest.params.threshold.min, manifest.params.threshold.max)
  }
  const onWellPointerDown = (e) => {
    if (view !== 'activity' || e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const lineY = compressorLevelToY(params.threshold, rect.height)
    if (Math.abs(e.clientY - rect.top - lineY) > THRESHOLD_GRAB_PX) return
    dragRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }
  const onWellPointerMove = (e) => {
    if (view !== 'activity') return
    if (dragRef.current) {
      setParam('threshold', thresholdFromEvent(e))
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const near = Math.abs(e.clientY - rect.top - compressorLevelToY(params.threshold, rect.height)) <= THRESHOLD_GRAB_PX
    e.currentTarget.style.cursor = near ? 'ns-resize' : ''
  }
  const onWellPointerUp = (e) => {
    if (!dragRef.current) return
    dragRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const p = (id) => params[id] ?? manifest.params[id].defaultValue
  const knob = (id, label, unit, extra = {}) => (
    <AutomatableKnob
      key={id}
      paramId={id}
      target={target}
      skew={SKEW[id] ?? 1}
      label={label}
      value={p(id)}
      min={manifest.params[id].min}
      max={manifest.params[id].max}
      defaultValue={manifest.params[id].defaultValue}
      unit={unit}
      onChange={(v) => setParam(id, v)}
      onCommit={(v) => setParam(id, v)}
      data-param={id}
      {...extra}
    />
  )

  const showSidechain = effect ? canShowSidechainControls(effect, target.storeKey) : false
  const heightPx = Math.max(64, wellH || 200)

  return (
    <PluginUIContext.Provider value={ctx}>
      <DisplayWell
        label="Compressor display"
        width={WELL_W}
        views={VIEWS}
        view={view}
        onViewChange={(v) => setView(deviceKey, v)}
      >
        <div
          ref={wellRef}
          className={styles.display}
          data-view={view}
          onPointerDown={onWellPointerDown}
          onPointerMove={onWellPointerMove}
          onPointerUp={onWellPointerUp}
          onPointerCancel={onWellPointerUp}
        >
          {view === 'activity' ? (
            <VisualizerNode node={{ id: 'device-activity', props: { source: 'compressor.combined', preset: 'compressorActivity', heightPx } }} />
          ) : (
            <CompressorCurveNode node={{ id: 'device-curve', props: {}, style: { heightPx } }} />
          )}
        </div>
      </DisplayWell>

      <DeviceSection title="GR" width={64} hint="Gain reduction, dB">
        <Meter
          className={styles.grMeter}
          label="Compressor gain reduction"
          subscribe={subscribeGr}
          direction="down"
          min={0}
          max={COMPRESSOR_DISPLAY.gr.maxGrDb}
          scaleDb={GR_SCALE}
          fallDbPerSec={240}
          holdMs={1200}
        />
        <span ref={readoutRef} className={styles.readout} aria-live="off" data-hint="Gain reduction now">
          {formatValue(0, 'dB')}
        </span>
      </DeviceSection>

      <DeviceSection title="Detection" width={140}>
        <div className={styles.pair}>
          {knob('threshold', 'Threshold', 'dB', { size: 44, width: 68, hint: 'Threshold. Also draggable as the line in the display.' })}
          <div className={styles.stack}>
            {knob('ratio', 'Ratio', 'ratio')}
            {knob('knee', 'Knee', 'dB')}
          </div>
        </div>
        <AutomationTarget paramId="detect_mode" target={target}>
          <SegmentedControl
            size="sm"
            label="Detector"
            value={Math.round(p('detect_mode'))}
            options={DETECT_OPTIONS}
            onChange={(v) => setParam('detect_mode', v)}
          />
        </AutomationTarget>
      </DeviceSection>

      <DeviceSection title="Time" width={124}>
        <div className={styles.pair}>
          <div className={styles.stack}>
            {knob('attack', 'Attack', 'ms')}
            {knob('release', 'Release', 'ms')}
          </div>
          <div className={styles.stack}>
            {knob('lookahead', 'Lookahead', 'ms')}
          </div>
        </div>
      </DeviceSection>

      <DeviceSection title="Output" width={68}>
        <div className={styles.stack}>
          {knob('makeup', 'Makeup', 'dB')}
          {knob('mix', 'Mix', '%')}
        </div>
      </DeviceSection>

      {showSidechain ? (
        <DeviceSection
          title="Sidechain"
          width={164}
          folded={sidechainFolded}
          onFoldChange={(f) => setSectionFolded(deviceKey, 'sidechain', f)}
        >
          <SidechainSection effect={effect} storeKey={target.storeKey} />
        </DeviceSection>
      ) : null}
    </PluginUIContext.Provider>
  )
}

function SidechainSection({ effect, storeKey }) {
  const sc = useEffectSidechain({ effect, storeKey })
  const options = useMemo(() => {
    const list = [{ value: '', label: 'None' }]
    if (sc.route && sc.sourceTrack && !sc.eligibleSources.some((s) => s.sourceTrackId === sc.route.sourceTrackId)) {
      list.push({ value: String(sc.route.sourceTrackId), label: sc.sourceTrack.name || `Track ${sc.route.sourceTrackId}` })
    }
    for (const s of sc.eligibleSources) list.push({ value: String(s.sourceTrackId), label: s.name })
    return list
  }, [sc.route, sc.sourceTrack, sc.eligibleSources])

  const warn = sc.routeError || (sc.route && sc.route.status !== 'ok')
  return (
    <div className={styles.sidechain}>
      {sc.requiresExternalParam ? (
        <Toggle
          size="sm"
          on={sc.externalEnabled}
          onChange={(on) => sc.applySidechain({ enabled: on })}
          hint="Compress from another track's signal instead of this one"
        >
          External
        </Toggle>
      ) : null}
      <span className={styles.fieldLabel} aria-hidden="true">Source</span>
      <Select
        size="sm"
        ariaLabel="Sidechain source"
        value={sc.selectedSourceValue}
        options={options}
        disabled={(sc.requiresExternalParam && !sc.externalEnabled) || !sc.hasSelectableSource}
        onChange={(v) => sc.applySidechain({ enabled: true, sourceTrackId: v })}
      />
      {warn ? <p className={styles.warning} role="status">{sc.statusText}</p> : null}
    </div>
  )
}

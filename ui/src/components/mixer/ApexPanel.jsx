import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X, Undo2, Redo2, RotateCcw } from 'lucide-react'
import useApexStore, {
  BAND_NAMES, BAND_PREFIX, SPLIT_BANDS,
} from '../../stores/apexStore.js'
import Knob from '../sampler/Knob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import ApexCurveEditor from './ApexCurveEditor.jsx'
import ApexAnalysis from './ApexAnalysis.jsx'
import {
  BAND_KNOBS, GLOBAL_KNOBS, BAND_STATES,
} from './apexGeometry.js'

// APEX editor window. Floating, viewport-anchored panel (mounted by the global
// EffectEditorHost). Assembles the canvas curve editor + analysis display on
// top, the band selector with per-band 4-state switch and SOLO, the per-band
// knob rows, and the right-hand global panel.
//
// Every scalar control follows the drag discipline: a knob previews locally
// during a drag and commits one setEffectParameter on release; discrete controls
// (tabs, switches) are single-click commits. Curve edits round-trip through the
// store's local undo/redo stack (Undo/Redo in the header, or Ctrl+Z / Ctrl+Y
// while the panel has focus). tokenValue() is never called at module scope.

const SHORT_STATE = ['ON', 'CMP', 'MUT', 'OFF']

// ── Small building blocks ─────────────────────────────────────────────────────

function ApexKnob({ id, label, min, max, def, skew, fmt, bipolar, size = 46 }) {
  const value = useApexStore(s => s.params[id])
  const previewParam = useApexStore(s => s.previewParam)
  const commitParam = useApexStore(s => s.commitParam)
  const v = Number.isFinite(value) ? value : def
  return (
    <Knob
      value={v}
      min={min}
      max={max}
      defaultValue={def}
      label={label}
      formatValue={fmt}
      skew={skew || 1}
      onLiveChange={(nv) => previewParam(id, nv)}
      onCommit={(nv) => commitParam(id, nv)}
      size={size}
      dragRange={150}
      ringStyle={bipolar ? 'split-track' : 'metered-arc'}
    />
  )
}

function SegButton({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      className={`apex-seg-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
}

// ── Band selector cell ────────────────────────────────────────────────────────

function BandCell({ band }) {
  const selected = useApexStore(s => s.selectedBand === band)
  const stateVal = useApexStore(s => s.params[BAND_PREFIX[band] + 'state'])
  const soloVal = useApexStore(s => s.params[BAND_PREFIX[band] + 'solo'])
  const setSelectedBand = useApexStore(s => s.setSelectedBand)
  const commitParam = useApexStore(s => s.commitParam)
  const setSolo = useApexStore(s => s.setSolo)

  const st = Math.round(Number.isFinite(stateVal) ? stateVal : 0)
  const isSolo = band < SPLIT_BANDS && soloVal > 0.5

  return (
    <div className={`apex-band-cell${selected ? ' selected' : ''}`}>
      <button
        type="button"
        className="apex-band-name"
        onClick={() => setSelectedBand(band)}
        title={`Select ${BAND_NAMES[band]}`}
      >
        {BAND_NAMES[band]}
      </button>
      <div className="apex-band-state" role="group" aria-label={`${BAND_NAMES[band]} state`}>
        {SHORT_STATE.map((lbl, idx) => (
          <SegButton
            key={idx}
            active={st === idx}
            onClick={() => commitParam(BAND_PREFIX[band] + 'state', idx)}
            title={BAND_STATES[idx]}
          >
            {lbl}
          </SegButton>
        ))}
      </div>
      {band < SPLIT_BANDS ? (
        <button
          type="button"
          className={`apex-solo-btn${isSolo ? ' active' : ''}`}
          onClick={() => setSolo(band, !isSolo)}
          title="Solo (exclusive across L/M/H)"
        >
          SOLO
        </button>
      ) : (
        <span className="apex-solo-spacer" />
      )}
    </div>
  )
}

// ── PEAK / RMS toggle for the selected band ───────────────────────────────────

function DetectionToggle({ band }) {
  const detVal = useApexStore(s => s.params[BAND_PREFIX[band] + 'det'])
  const commitParam = useApexStore(s => s.commitParam)
  const isRms = detVal > 0.5
  return (
    <div className="apex-det-toggle" role="group" aria-label="Detection mode">
      <SegButton active={!isRms} onClick={() => commitParam(BAND_PREFIX[band] + 'det', 0)} title="Peak detection">
        PEAK
      </SegButton>
      <SegButton active={isRms} onClick={() => commitParam(BAND_PREFIX[band] + 'det', 1)} title="RMS detection">
        RMS
      </SegButton>
    </div>
  )
}

// ── Crossover slope 12 / 24 dB switch ─────────────────────────────────────────

function SlopeSwitch({ id }) {
  const val = useApexStore(s => s.params[id])
  const commitParam = useApexStore(s => s.commitParam)
  const is24 = (Number.isFinite(val) ? val : 1) > 0.5
  return (
    <div className="apex-slope-switch" role="group" aria-label="Crossover slope">
      <SegButton active={!is24} onClick={() => commitParam(id, 0)} title="12 dB/oct (LR2)">12</SegButton>
      <SegButton active={is24} onClick={() => commitParam(id, 1)} title="24 dB/oct (LR4)">24</SegButton>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function ApexPanel() {
  const target = useApexStore(s => s.target)
  const close = useApexStore(s => s.close)
  const selectedBand = useApexStore(s => s.selectedBand)
  const undoCurve = useApexStore(s => s.undoCurve)
  const redoCurve = useApexStore(s => s.redoCurve)
  const resetCurve = useApexStore(s => s.resetCurve)
  const applyPresetState = useApexStore(s => s.applyPresetState)
  const canUndo = useApexStore(s => s.undoStack.length > 0)
  const canRedo = useApexStore(s => s.redoStack.length > 0)
  const latency = useApexStore(s => s.latency)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 360),
    y: 64,
  }))
  const panelDragRef = useRef(null)

  const handleHeaderMouseDown = useCallback((e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX, startMouseY: e.clientY,
      startPanelX: panelPos.x, startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: Math.max(-600, Math.min(window.innerWidth - 120, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0, Math.min(window.innerHeight - 80, startPanelY + e.clientY - startMouseY)),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Panel-scoped curve undo/redo — only fires when focus is inside this panel,
  // and stops propagation so the app's global timeline undo never sees it.
  const handleKeyDown = useCallback((e) => {
    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undoCurve() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); e.stopPropagation(); redoCurve() }
  }, [undoCurve, redoCurve])

  // One store, two skins: the GLOSS companion (skin:'gloss') is drawn by
  // GlossPanel. Render nothing here for a gloss-skinned target so opening GLOSS
  // never also paints the full APEX editor.
  if (!target || target.skin === 'gloss') return null

  const prefix = BAND_PREFIX[selectedBand]
  const knobById = (suffix) => BAND_KNOBS.find(k => k.suffix === suffix)
  const bandKnob = (suffix) => {
    const k = knobById(suffix)
    return (
      <ApexKnob
        key={suffix}
        id={prefix + suffix}
        label={k.label}
        min={k.min}
        max={k.max}
        def={k.default}
        skew={k.skew}
        fmt={k.fmt}
        bipolar={k.bipolar}
      />
    )
  }

  const latencyText = latency
    ? `${latency.latencyMs != null ? latency.latencyMs.toFixed(1) : (latency.latencySamples ?? 0)} ms latency`
    : '—'

  return (
    <div
      className="apex-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="apex-panel-header" onMouseDown={handleHeaderMouseDown}>
        <span className="apex-panel-title">APEX</span>
        <span className="apex-panel-sub">multiband maximizer</span>
        <div className="apex-header-actions">
          <button
            type="button"
            className="apex-icon-btn"
            onClick={undoCurve}
            disabled={!canUndo}
            title="Undo curve edit (Ctrl+Z)"
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            className="apex-icon-btn"
            onClick={redoCurve}
            disabled={!canRedo}
            title="Redo curve edit (Ctrl+Shift+Z)"
          >
            <Redo2 size={13} />
          </button>
          <button
            type="button"
            className="apex-icon-btn"
            onClick={() => resetCurve(selectedBand)}
            title={`Reset ${BAND_NAMES[selectedBand]} curve to unity`}
          >
            <RotateCcw size={13} />
          </button>
          <button type="button" className="apex-panel-close" onClick={close} title="Close">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Preset bar — named save/load of the full APEX state (params + curves) */}
      <div className="apex-preset-strip">
        <EffectPresetBar
          effectType="apex"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Top: curve editor (left) + analysis (right) */}
      <div className="apex-top-row">
        <div className="apex-curve-wrap">
          <ApexCurveEditor />
        </div>
        <div className="apex-analysis-wrap">
          <ApexAnalysis />
        </div>
      </div>

      {/* Band selector */}
      <div className="apex-band-row">
        {BAND_NAMES.map((_, band) => (
          <BandCell key={band} band={band} />
        ))}
      </div>

      {/* Body: per-band knob rows (left) + right global panel */}
      <div className="apex-body">
        <div className="apex-band-controls">
          <div className="apex-knob-row">
            {bandKnob('pre')}
            {bandKnob('post')}
          </div>
          <div className="apex-knob-row">
            {bandKnob('att')}
            {bandKnob('rel')}
            {bandKnob('sus')}
            <div className="apex-inline-toggle">
              <DetectionToggle band={selectedBand} />
              <span className="apex-inline-label">DETECT</span>
            </div>
          </div>
          <div className="apex-knob-row">
            {bandKnob('satth')}
            {bandKnob('satcl')}
            {bandKnob('sep')}
          </div>
        </div>

        <div className="apex-right-panel">
          <div className="apex-knob-row apex-knob-row--right">
            <ApexKnob id={GLOBAL_KNOBS.lookahead.id} label={GLOBAL_KNOBS.lookahead.label}
              min={GLOBAL_KNOBS.lookahead.min} max={GLOBAL_KNOBS.lookahead.max}
              def={GLOBAL_KNOBS.lookahead.default} fmt={GLOBAL_KNOBS.lookahead.fmt} />
            <ApexKnob id={GLOBAL_KNOBS.bandmix.id} label={GLOBAL_KNOBS.bandmix.label}
              min={GLOBAL_KNOBS.bandmix.min} max={GLOBAL_KNOBS.bandmix.max}
              def={GLOBAL_KNOBS.bandmix.default} fmt={GLOBAL_KNOBS.bandmix.fmt} />
          </div>
          <div className="apex-split-row">
            <ApexKnob id={GLOBAL_KNOBS.split_lo.id} label={GLOBAL_KNOBS.split_lo.label}
              min={GLOBAL_KNOBS.split_lo.min} max={GLOBAL_KNOBS.split_lo.max}
              def={GLOBAL_KNOBS.split_lo.default} skew={GLOBAL_KNOBS.split_lo.skew}
              fmt={GLOBAL_KNOBS.split_lo.fmt} size={42} />
            <SlopeSwitch id="slope_lo" />
          </div>
          <div className="apex-split-row">
            <ApexKnob id={GLOBAL_KNOBS.split_hi.id} label={GLOBAL_KNOBS.split_hi.label}
              min={GLOBAL_KNOBS.split_hi.min} max={GLOBAL_KNOBS.split_hi.max}
              def={GLOBAL_KNOBS.split_hi.default} skew={GLOBAL_KNOBS.split_hi.skew}
              fmt={GLOBAL_KNOBS.split_hi.fmt} size={42} />
            <SlopeSwitch id="slope_hi" />
          </div>
          <div className="apex-knob-row apex-knob-row--right">
            <ApexKnob id={GLOBAL_KNOBS.lowcut.id} label={GLOBAL_KNOBS.lowcut.label}
              min={GLOBAL_KNOBS.lowcut.min} max={GLOBAL_KNOBS.lowcut.max}
              def={GLOBAL_KNOBS.lowcut.default} fmt={GLOBAL_KNOBS.lowcut.fmt} size={42} />
            <div className="apex-latency-readout" title="Reported effect latency (lookahead + oversampling)">
              {latencyText}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

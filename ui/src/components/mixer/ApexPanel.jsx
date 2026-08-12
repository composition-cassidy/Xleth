import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X, Undo2, Redo2, RotateCcw } from 'lucide-react'
import useApexStore, {
  BAND_NAMES, BAND_PREFIX, SPLIT_BANDS,
} from '../../stores/apexStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import ApexCurveEditor from './ApexCurveEditor.jsx'
import ApexAnalysis from './ApexAnalysis.jsx'
import { bandColor } from './apexBandColors.js'
import {
  BAND_KNOBS, GLOBAL_KNOBS, BAND_STATES,
} from './apexGeometry.js'

// APEX editor window. Floating, viewport-anchored panel (mounted by the global
// EffectEditorHost). The control deck is laid out like FL Studio's Maximus: the
// graph area on top (transfer curve + analysis), then a left-to-right console —
// a vertical band rail (LOW/MID/HIGH/MASTER) and SOLO, a vertical ON/COMP OFF/
// MUTED/OFF state switch beside the saturation trio, then GAIN, the dynamics
// row, LMH delay/mix, and the crossover column.
//
// Knobs are the stock XLETH effect knob (PluginUIKitKnob, mixer-ring preset) —
// the same control the Reverb / Delay / Flanger panels use — tinted with the
// selected band's identity color (LOW red-orange / MID lime / HIGH aqua; MASTER
// keeps the earned theme accent; see apexBandColors.js).
//
// Every scalar control follows the drag discipline: a knob previews locally
// during a drag and commits one setEffectParameter on release; discrete controls
// (tabs, switches) are single-click commits. Curve edits round-trip through the
// store's local undo/redo stack (Undo/Redo in the header, or Ctrl+Z / Ctrl+Y
// while the panel has focus). tokenValue() is never called at module scope.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// Vertical state switch labels (spec 3 — same values BAND_STATES documents).
const STATE_LABELS = ['ON', 'COMP OFF', 'MUTED', 'OFF']

// ── Small building blocks ─────────────────────────────────────────────────────

// Stock effect knob (mixer-ring) with the value printed below — the mixer-ring
// preset hides its own readout, so the panel renders it here (matching the
// Delay / Reverb panels). `accentColor` tints the value arc with a band or
// crossover identity color; omit it to fall back to the theme accent.
function ApexKnob({ id, label, min, max, def, skew, fmt, accentColor, size = 50 }) {
  const value = useApexStore(s => s.params[id])
  const previewParam = useApexStore(s => s.previewParam)
  const commitParam = useApexStore(s => s.commitParam)
  const v = Number.isFinite(value) ? value : def
  return (
    <div className="apex-knob-cell">
      <PluginUIKitKnob
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
        appearance={MIXER_RING_APPEARANCE}
        accentColor={accentColor || undefined}
      />
      <div className="apex-knob-value">{fmt(v)}</div>
    </div>
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

// ── Band rail (vertical LOW / MID / HIGH / MASTER tabs) ───────────────────────

function BandTab({ band }) {
  const selected = useApexStore(s => s.selectedBand === band)
  const stateVal = useApexStore(s => s.params[BAND_PREFIX[band] + 'state'])
  const setSelectedBand = useApexStore(s => s.setSelectedBand)
  const st = Math.round(Number.isFinite(stateVal) ? stateVal : 0)
  const color = bandColor(band)

  return (
    <button
      type="button"
      className={`apex-band-tab${selected ? ' selected' : ''}${st >= 2 ? ' silenced' : ''}`}
      style={color ? { '--apex-band-color': color } : undefined}
      onClick={() => setSelectedBand(band)}
      title={`Select ${BAND_NAMES[band]} · ${BAND_STATES[st]}`}
    >
      <span className="apex-band-tab-dot" />
      <span className="apex-band-tab-name">{BAND_NAMES[band]}</span>
    </button>
  )
}

// One SOLO for the selected band (exclusive across L/M/H). MASTER has no solo.
function SoloButton({ band }) {
  const soloVal = useApexStore(s => s.params[BAND_PREFIX[band] + 'solo'])
  const setSolo = useApexStore(s => s.setSolo)
  const disabled = band >= SPLIT_BANDS
  const isSolo = !disabled && soloVal > 0.5
  return (
    <button
      type="button"
      className={`apex-solo-btn${isSolo ? ' active' : ''}`}
      disabled={disabled}
      onClick={() => setSolo(band, !isSolo)}
      title={disabled ? 'MASTER has no solo' : 'Solo (exclusive across L / M / H)'}
    >
      SOLO
    </button>
  )
}

// ── Vertical 4-state switch (ON / COMP OFF / MUTED / OFF) ──────────────────────

function StateSwitch({ band }) {
  const stateVal = useApexStore(s => s.params[BAND_PREFIX[band] + 'state'])
  const commitParam = useApexStore(s => s.commitParam)
  const st = Math.round(Number.isFinite(stateVal) ? stateVal : 0)
  const color = bandColor(band)
  return (
    <div
      className="apex-state-switch"
      role="group"
      aria-label={`${BAND_NAMES[band]} state`}
      style={color ? { '--apex-band-color': color } : undefined}
    >
      {STATE_LABELS.map((lbl, idx) => (
        <button
          key={idx}
          type="button"
          className={`apex-state-opt${st === idx ? ' active' : ''}`}
          onClick={() => commitParam(BAND_PREFIX[band] + 'state', idx)}
          title={lbl}
        >
          {lbl}
        </button>
      ))}
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
    x: Math.round(window.innerWidth / 2 - 450),
    y: 56,
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
        x: Math.max(-760, Math.min(window.innerWidth - 120, startPanelX + e.clientX - startMouseX)),
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
  const bandAccent = bandColor(selectedBand)
  const knobById = (suffix) => BAND_KNOBS.find(k => k.suffix === suffix)
  const bandKnob = (suffix, size) => {
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
        accentColor={bandAccent}
        size={size}
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

      {/* Top: curve editor (left) + analysis (right) — the Maximus graph area */}
      <div className="apex-top-row">
        <div className="apex-curve-wrap">
          <ApexCurveEditor />
        </div>
        <div className="apex-analysis-wrap">
          <ApexAnalysis />
        </div>
      </div>

      {/* Maximus-style control deck */}
      <div className="apex-deck">

        {/* Col 1 — band rail + SOLO */}
        <div className="apex-col apex-col-bands">
          <div className="apex-band-rail">
            {BAND_NAMES.map((_, band) => (
              <BandTab key={band} band={band} />
            ))}
          </div>
          <SoloButton band={selectedBand} />
        </div>

        {/* Col 2 — state switch + saturation trio */}
        <div className="apex-col apex-col-state">
          <StateSwitch band={selectedBand} />
          <div className="apex-knob-row apex-sat-row">
            {bandKnob('satth', 42)}
            {bandKnob('sep', 42)}
            {bandKnob('satcl', 42)}
          </div>
        </div>

        {/* Col 3 — gain */}
        <div className="apex-col apex-col-gain">
          <div className="apex-col-title">GAIN</div>
          <div className="apex-knob-row">
            {bandKnob('pre')}
            {bandKnob('post')}
          </div>
        </div>

        {/* Col 4 — dynamics + detection */}
        <div className="apex-col apex-col-dyn">
          <div className="apex-knob-row">
            {bandKnob('att')}
            {bandKnob('rel')}
            {bandKnob('sus')}
          </div>
          <div className="apex-inline-toggle">
            <DetectionToggle band={selectedBand} />
            <span className="apex-inline-label">DETECT</span>
          </div>
        </div>

        {/* Col 5 — LMH lookahead / band mix */}
        <div className="apex-col apex-col-lmh">
          <ApexKnob id={GLOBAL_KNOBS.lookahead.id} label={GLOBAL_KNOBS.lookahead.label}
            min={GLOBAL_KNOBS.lookahead.min} max={GLOBAL_KNOBS.lookahead.max}
            def={GLOBAL_KNOBS.lookahead.default} fmt={GLOBAL_KNOBS.lookahead.fmt} />
          <ApexKnob id={GLOBAL_KNOBS.bandmix.id} label={GLOBAL_KNOBS.bandmix.label}
            min={GLOBAL_KNOBS.bandmix.min} max={GLOBAL_KNOBS.bandmix.max}
            def={GLOBAL_KNOBS.bandmix.default} fmt={GLOBAL_KNOBS.bandmix.fmt} />
        </div>

        {/* Col 6 — crossover (LOW / HIGH split + slopes, LOW CUT) */}
        <div className="apex-col apex-col-xover">
          <div className="apex-split-row">
            <ApexKnob id={GLOBAL_KNOBS.split_lo.id} label={GLOBAL_KNOBS.split_lo.label}
              min={GLOBAL_KNOBS.split_lo.min} max={GLOBAL_KNOBS.split_lo.max}
              def={GLOBAL_KNOBS.split_lo.default} skew={GLOBAL_KNOBS.split_lo.skew}
              fmt={GLOBAL_KNOBS.split_lo.fmt} accentColor={bandColor(0)} size={42} />
            <SlopeSwitch id="slope_lo" />
          </div>
          <div className="apex-split-row">
            <ApexKnob id={GLOBAL_KNOBS.split_hi.id} label={GLOBAL_KNOBS.split_hi.label}
              min={GLOBAL_KNOBS.split_hi.min} max={GLOBAL_KNOBS.split_hi.max}
              def={GLOBAL_KNOBS.split_hi.default} skew={GLOBAL_KNOBS.split_hi.skew}
              fmt={GLOBAL_KNOBS.split_hi.fmt} accentColor={bandColor(2)} size={42} />
            <SlopeSwitch id="slope_hi" />
          </div>
          <div className="apex-split-row">
            <ApexKnob id={GLOBAL_KNOBS.lowcut.id} label={GLOBAL_KNOBS.lowcut.label}
              min={GLOBAL_KNOBS.lowcut.min} max={GLOBAL_KNOBS.lowcut.max}
              def={GLOBAL_KNOBS.lowcut.default} fmt={GLOBAL_KNOBS.lowcut.fmt}
              accentColor={bandColor(0)} size={42} />
            <div className="apex-latency-readout" title="Reported effect latency (lookahead + oversampling)">
              {latencyText}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

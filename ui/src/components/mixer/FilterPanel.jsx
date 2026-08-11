import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X, Plus, Info } from 'lucide-react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import useFilterStore, {
  SLOT_TYPES, SLOPES, MAX_SLOTS,
  typeUsesGain, typeUsesMorph, typeUsesSlope,
} from '../../stores/filterStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import {
  readMixerCanvasTheme, withAlpha, syncCanvasSize, MONO, MONO_SM,
} from './mixerCanvasTheme.js'
import {
  slotResponseDb, responseFrequencies, RESPONSE_SIZE, FREQ_MIN, FREQ_MAX,
} from './filterResponse.js'

// ── Constants ────────────────────────────────────────────────────────────────

// Same skews as the engine's createLayout(): the knob travel then matches each
// parameter's own NormalisableRange curve.
const FREQ_SKEW = 0.23
const Q_SKEW    = 0.18

const KNOB_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const TYPE_SHORT = ['LP', 'HP', 'BP', 'NOTCH', 'AP', 'PEAK', 'L.SHLF', 'H.SHLF', 'MORPH']

const DB_RANGE   = 24
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_LABELS = { 20: '20', 100: '100', 1000: '1k', 10000: '10k', 20000: '20k' }
const DB_LINES = [-24, -12, 0, 12, 24]

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

const fmtHz = (v) => (v >= 1000
  ? `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')} kHz`
  : `${Math.round(v)} Hz`)
const fmtQ    = (v) => v.toFixed(2)
const fmtGain = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtDrive = (v) => `${v.toFixed(1)} dB`
const fmtMix  = (v) => `${Math.round(v * 100)} %`
const fmtMorph = (v) => v.toFixed(2)
const fmtMs   = (v) => (v >= 100 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`)

// ── Slot strip ─────────────────────────────────────────────────────────────

function SlotChip({ slot, index, selected, onSelect, onToggleEnabled, onRemove }) {
  const enabled = !!slot.enabled
  const type = clamp(Math.round(slot.type ?? 0), 0, 8)
  return (
    <div
      className={`filter-slot-chip${selected ? ' selected' : ''}${enabled ? '' : ' disabled'}`}
      onClick={() => onSelect(index)}
      title={`Slot ${index + 1} — ${SLOT_TYPES[type].label}`}
    >
      <button
        className={`filter-slot-enable${enabled ? ' on' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleEnabled(index, !enabled) }}
        title={enabled ? 'Bypass slot' : 'Enable slot'}
        aria-pressed={enabled}
      />
      <span className="filter-slot-idx">S{index + 1}</span>
      <span className="filter-slot-type">{TYPE_SHORT[type]}</span>
      <button
        className="filter-slot-remove"
        onClick={(e) => { e.stopPropagation(); onRemove(index) }}
        title="Remove slot"
      >
        <X size={11} />
      </button>
    </div>
  )
}

// ── Response curve (canvas only — no DOM overlays) ────────────────────────────

function ResponseCurve({ slots, selectedSlotIndex, aggregateRef, version }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = syncCanvasSize(canvas, 560, 190)
    if (!size) return
    const { cssW, cssH, dpr } = size
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const th = readMixerCanvasTheme(canvas)

    const padL = 30
    const padR = cssW - 8
    const padT = 8
    const padB = cssH - 15
    const plotW = Math.max(10, padR - padL)
    const plotH = Math.max(10, padB - padT)

    const logMin = Math.log(FREQ_MIN)
    const logMax = Math.log(FREQ_MAX)
    const xOf = (f) => padL + ((Math.log(f) - logMin) / (logMax - logMin)) * plotW
    const yOf = (db) => padT + ((DB_RANGE - clamp(db, -DB_RANGE, DB_RANGE)) / (2 * DB_RANGE)) * plotH

    ctx.fillStyle = th.well
    ctx.fillRect(0, 0, cssW, cssH)

    // Frequency grid + sparse labels.
    ctx.strokeStyle = withAlpha(th.border, 0.9)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const f of GRID_FREQS) {
      const gx = Math.round(xOf(f)) + 0.5
      ctx.moveTo(gx, padT)
      ctx.lineTo(gx, padB)
    }
    ctx.stroke()
    ctx.font = MONO_SM
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
    for (const f of GRID_FREQS) {
      if (!GRID_LABELS[f]) continue
      ctx.fillText(GRID_LABELS[f], xOf(f), padB + 3)
    }

    // dB grid + labels (0 dB rule emphasised).
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of DB_LINES) {
      const gy = Math.round(yOf(db)) + 0.5
      ctx.strokeStyle = db === 0 ? withAlpha(th.borderStrong, 1) : withAlpha(th.border, 0.7)
      ctx.beginPath()
      ctx.moveTo(padL, gy)
      ctx.lineTo(padR, gy)
      ctx.stroke()
      ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, padL - 4, gy)
    }

    // Per-slot faint guide curves (computed client-side, sum in dB to aggregate).
    const freqs = responseFrequencies(RESPONSE_SIZE)
    slots.forEach((slot, si) => {
      const curve = slotResponseDb(slot)
      if (!curve) return
      const isSel = si === selectedSlotIndex
      ctx.beginPath()
      for (let i = 0; i < RESPONSE_SIZE; i++) {
        const x = xOf(freqs[i])
        const y = yOf(curve[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = withAlpha(th.accent, isSel ? 0.5 : 0.2)
      ctx.lineWidth = isSel ? 1.5 : 1
      ctx.stroke()
    })

    // Bold aggregate — the authoritative array from audio_filterGetResponseCurve.
    const agg = aggregateRef.current
    if (agg && agg.length > 1) {
      const n = Math.min(agg.length, RESPONSE_SIZE)
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        const f = Math.exp(logMin + t * (logMax - logMin))
        const x = xOf(f)
        const y = yOf(agg[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = th.accent
      ctx.lineWidth = 2
      ctx.stroke()
    } else if (slots.length === 0) {
      ctx.font = MONO
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.8)
      ctx.fillText('Add a slot to start filtering', (padL + padR) / 2, (padT + padB) / 2)
    }
  }, [slots, selectedSlotIndex, version, themeEpoch, aggregateRef])

  useEffect(() => { paint() }, [paint])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  return (
    <canvas
      ref={canvasRef}
      className="filter-response-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}

// ── Selected-slot controls ───────────────────────────────────────────────────

function SlotControls({ slot, index, onParam, onCutMin, onCutMax }) {
  const type = clamp(Math.round(slot.type ?? 0), 0, 8)
  const slope = clamp(Math.round(slot.slope ?? 1), 0, 3)
  const depth = Number(slot.dyn_depth ?? 0)
  const modActive = depth !== 0

  return (
    <div className="filter-slot-controls">
      {/* Type + slope row */}
      <div className="filter-control-row filter-type-row">
        <label className="filter-field">
          <span className="filter-field-label">Type</span>
          <select
            className="filter-type-select"
            value={type}
            onChange={(e) => onParam(index, 'type', Number(e.target.value))}
          >
            {SLOT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>

        {typeUsesSlope(type) && (
          <div className="filter-field">
            <span className="filter-field-label">Slope&nbsp;(dB/oct)</span>
            <div className="filter-slope-seg">
              {SLOPES.map(s => (
                <button
                  key={s.value}
                  className={`filter-slope-btn${slope === s.value ? ' active' : ''}`}
                  onClick={() => onParam(index, 'slope', s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Knob row — only the controls that affect the selected type. */}
      <div className="filter-knob-row">
        <PluginUIKitKnob
          value={Number(slot.cutoff ?? 1000)} min={20} max={20000} defaultValue={1000}
          skew={FREQ_SKEW} label="CUTOFF" formatValue={fmtHz} appearance={KNOB_APPEARANCE}
          size={54} dragRange={160}
          onLiveChange={(v) => onParam(index, 'cutoff', v)}
          onCommit={(v) => onParam(index, 'cutoff', v)}
        />
        <PluginUIKitKnob
          value={Number(slot.q ?? 0.7071)} min={0.5} max={30} defaultValue={0.7071}
          skew={Q_SKEW} label="Q" formatValue={fmtQ} appearance={KNOB_APPEARANCE}
          size={54} dragRange={160}
          onLiveChange={(v) => onParam(index, 'q', v)}
          onCommit={(v) => onParam(index, 'q', v)}
        />
        {typeUsesGain(type) && (
          <PluginUIKitKnob
            value={Number(slot.gain ?? 0)} min={-24} max={24} defaultValue={0}
            label="GAIN" formatValue={fmtGain} appearance={KNOB_APPEARANCE}
            size={54} dragRange={160}
            onLiveChange={(v) => onParam(index, 'gain', v)}
            onCommit={(v) => onParam(index, 'gain', v)}
          />
        )}
        {typeUsesMorph(type) && (
          <PluginUIKitKnob
            value={Number(slot.morph ?? 0)} min={0} max={1} defaultValue={0}
            label="MORPH" formatValue={fmtMorph} appearance={KNOB_APPEARANCE}
            size={54} dragRange={160}
            onLiveChange={(v) => onParam(index, 'morph', v)}
            onCommit={(v) => onParam(index, 'morph', v)}
          />
        )}
        <PluginUIKitKnob
          value={Number(slot.drive ?? 0)} min={0} max={24} defaultValue={0}
          label="DRIVE" formatValue={fmtDrive} appearance={KNOB_APPEARANCE}
          size={54} dragRange={160}
          onLiveChange={(v) => onParam(index, 'drive', v)}
          onCommit={(v) => onParam(index, 'drive', v)}
        />
        <PluginUIKitKnob
          value={Number(slot.mix ?? 1)} min={0} max={1} defaultValue={1}
          label="MIX" formatValue={fmtMix} appearance={KNOB_APPEARANCE}
          size={54} dragRange={160}
          onLiveChange={(v) => onParam(index, 'mix', v)}
          onCommit={(v) => onParam(index, 'mix', v)}
        />
      </div>

      {/* Modulation — dynamics follower + the FX-graph routing note. */}
      <div className={`filter-mod-section${modActive ? ' is-active' : ''}`}>
        <div className="filter-mod-header">
          <span className="filter-mod-title">Modulation</span>
          <span className="filter-mod-dot" aria-hidden />
          <span className="filter-mod-sub">dynamics follower</span>
        </div>

        <div className="filter-mod-depth">
          <span className="filter-field-label">Depth</span>
          <input
            className="filter-depth-slider"
            type="range" min={-1} max={1} step={0.01}
            value={depth}
            onChange={(e) => onParam(index, 'dyn_depth', Number(e.target.value))}
          />
          <span className="filter-depth-readout">
            {depth > 0 ? '+' : ''}{depth.toFixed(2)}
          </span>
        </div>

        <div className="filter-knob-row filter-mod-knob-row">
          <PluginUIKitKnob
            value={Number(slot.dyn_attack ?? 10)} min={0.1} max={100} defaultValue={10}
            skew={0.4} label="ATTACK" formatValue={fmtMs} appearance={KNOB_APPEARANCE}
            size={44} dragRange={150}
            onLiveChange={(v) => onParam(index, 'dyn_attack', v)}
            onCommit={(v) => onParam(index, 'dyn_attack', v)}
          />
          <PluginUIKitKnob
            value={Number(slot.dyn_release ?? 100)} min={1} max={2000} defaultValue={100}
            skew={0.4} label="RELEASE" formatValue={fmtMs} appearance={KNOB_APPEARANCE}
            size={44} dragRange={150}
            onLiveChange={(v) => onParam(index, 'dyn_release', v)}
            onCommit={(v) => onParam(index, 'dyn_release', v)}
          />
          <PluginUIKitKnob
            value={Number(slot.cut_min ?? 20)} min={20} max={20000} defaultValue={20}
            skew={FREQ_SKEW} label="CUT MIN" formatValue={fmtHz} appearance={KNOB_APPEARANCE}
            size={44} dragRange={150}
            onLiveChange={(v) => onCutMin(index, v)}
            onCommit={(v) => onCutMin(index, v)}
          />
          <PluginUIKitKnob
            value={Number(slot.cut_max ?? 20000)} min={20} max={20000} defaultValue={20000}
            skew={FREQ_SKEW} label="CUT MAX" formatValue={fmtHz} appearance={KNOB_APPEARANCE}
            size={44} dragRange={150}
            onLiveChange={(v) => onCutMax(index, v)}
            onCommit={(v) => onCutMax(index, v)}
          />
        </div>

        <div className="filter-mod-hint">
          <Info size={12} />
          <span>Envelope &amp; LFO modulation route through the FX graph — patch this slot's cutoff / Q there.</span>
        </div>
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function FilterPanel() {
  const target = useFilterStore(s => s.target)
  const slots = useFilterStore(s => s.slots)
  const selectedSlotIndex = useFilterStore(s => s.selectedSlotIndex)
  const setSelectedSlot = useFilterStore(s => s.setSelectedSlot)
  const close = useFilterStore(s => s.close)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 310),
    y: 90,
  }))
  const panelDragRef = useRef(null)

  // Bold aggregate curve (mutated by the debounced refresh, not reactive) plus a
  // version counter that bumps to trigger a repaint when it lands.
  const aggregateRef = useRef(null)
  const [curveVersion, setCurveVersion] = useState(0)
  const refreshTimerRef = useRef(null)

  const refreshCurve = useCallback(async () => {
    const c = await useFilterStore.getState().fetchResponseCurve()
    if (c && c.length > 1) {
      aggregateRef.current = c
      setCurveVersion(v => v + 1)
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refreshCurve()
    }, 100)
  }, [refreshCurve])

  // Fetch the curve once when a target opens, then whenever the slot list
  // identity changes (add/remove). Param edits schedule their own refresh.
  useEffect(() => {
    if (!target) return
    refreshCurve()
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [target, refreshCurve])

  // Param write → optimistic store update → debounced curve refresh.
  const handleParam = useCallback((i, paramName, value) => {
    useFilterStore.getState().setSlotParam(i, paramName, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleCutMin = useCallback((i, value) => {
    useFilterStore.getState().setCutMin(i, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleCutMax = useCallback((i, value) => {
    useFilterStore.getState().setCutMax(i, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleToggleEnabled = useCallback((i, enabled) => {
    useFilterStore.getState().setSlotParam(i, 'enabled', enabled ? 1 : 0)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleAddSlot = useCallback(async () => {
    await useFilterStore.getState().addSlot()
    refreshCurve()
  }, [refreshCurve])

  const handleRemoveSlot = useCallback(async (i) => {
    await useFilterStore.getState().removeSlot(i)
    refreshCurve()
  }, [refreshCurve])

  // Panel drag.
  const handlePanelDragStart = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return
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
        x: clamp(startPanelX + (e.clientX - startMouseX), -560, window.innerWidth - 100),
        y: clamp(startPanelY + (e.clientY - startMouseY), 0, window.innerHeight - 100),
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

  if (!target) return null

  const selected = selectedSlotIndex >= 0 ? (slots[selectedSlotIndex] ?? null) : null

  return (
    <div className="filter-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="filter-panel-header" onMouseDown={handlePanelDragStart}>
        <span className="filter-panel-title">XLETH FILTER</span>
        <button className="filter-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      {/* Slot strip — up to 8 slots, an add button, then disabled ghosts. */}
      <div className="filter-slot-strip">
        {Array.from({ length: MAX_SLOTS }, (_, i) => {
          if (i < slots.length) {
            return (
              <SlotChip
                key={i}
                slot={slots[i]}
                index={i}
                selected={i === selectedSlotIndex}
                onSelect={setSelectedSlot}
                onToggleEnabled={handleToggleEnabled}
                onRemove={handleRemoveSlot}
              />
            )
          }
          if (i === slots.length) {
            return (
              <button key={i} className="filter-slot-add" onClick={handleAddSlot} title="Add filter slot">
                <Plus size={14} />
              </button>
            )
          }
          return <div key={i} className="filter-slot-chip filter-slot-chip--ghost" aria-hidden />
        })}
      </div>

      {/* Response curve. */}
      <div className="filter-response-row">
        <ResponseCurve
          slots={slots}
          selectedSlotIndex={selectedSlotIndex}
          aggregateRef={aggregateRef}
          version={curveVersion}
        />
      </div>

      {/* Selected-slot controls, or an empty-state hint. */}
      {selected ? (
        <SlotControls
          slot={selected}
          index={selectedSlotIndex}
          onParam={handleParam}
          onCutMin={handleCutMin}
          onCutMax={handleCutMax}
        />
      ) : (
        <div className="filter-empty-state">
          {slots.length === 0
            ? 'No filter slots yet — press + to add one.'
            : 'Select a slot to edit its controls.'}
        </div>
      )}
    </div>
  )
}

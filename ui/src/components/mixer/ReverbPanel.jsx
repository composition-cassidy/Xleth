import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import useReverbStore from '../../stores/reverbStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import ReverbDecayFieldVisualizer from './ReverbDecayFieldVisualizer.jsx'
import ReverbFilterCurve from './ReverbFilterCurve.jsx'
import {
  clamp,
  styleIndexOf,
  backendTag,
  REVERB_STYLE_LABELS,
  STYLE_PLATE,
} from './reverbVizMath.js'

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// ── Parameter definitions ────────────────────────────────────────────────────
// Every id here is an existing engine parameter (XlethReverbEffect.h). Ranges
// mirror that file's NormalisableRange bounds exactly — the panel never sends a
// value the engine would clamp.
//
// Controls are tiered by how much they shape the sound, not by category:
//   primary    DECAY / SIZE / DAMPING — the three that define the space
//   secondary  PRE-DELAY / ER LEVEL / LATE LEVEL / RING TAME
//   tertiary   MOD RATE / MOD DEPTH, beside the filter curve
// MIX is a fader, not a knob — it is the output stage, not another shaper.

const PRIMARY_KNOBS = [
  { id: 'decay',   label: 'DECAY',   min: 0.1, max: 30,  default: 2.0, fmt: v => `${v.toFixed(1)} s` },
  { id: 'size',    label: 'SIZE',    min: 0,   max: 100, default: 50,  fmt: v => `${v.toFixed(0)} %` },
  { id: 'damping', label: 'DAMPING', min: 0,   max: 100, default: 50,  fmt: v => `${v.toFixed(0)} %` },
]

const SECONDARY_KNOBS = [
  { id: 'predelay', label: 'PRE-DELAY',  min: 0, max: 100, default: 10, fmt: v => `${v.toFixed(0)} ms` },
  { id: 'er_level', label: 'ER LEVEL',   min: 0, max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
  { id: 'er_late',  label: 'LATE LEVEL', min: 0, max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
  // Anti-metal control. APVTS id stays "smoothness" for save/load
  // compatibility; the UI surface reads "RING TAME". 0 = legacy/raw (engine
  // LegacyFdn backend, Generic only); higher values engage the enhanced FDN
  // backend's anti-metal processing and raise in-loop damping.
  { id: 'smoothness', label: 'RING TAME', min: 0, max: 100, default: 0, fmt: v => `${v.toFixed(0)} %` },
]

const TERTIARY_KNOBS = [
  { id: 'mod_rate',  label: 'MOD RATE',  min: 0, max: 100, default: 30, fmt: v => `${v.toFixed(0)} %` },
  { id: 'mod_depth', label: 'MOD DEPTH', min: 0, max: 100, default: 20, fmt: v => `${v.toFixed(0)} %` },
]

const ALL_KNOBS = [...PRIMARY_KNOBS, ...SECONDARY_KNOBS, ...TERTIARY_KNOBS]

// hicut / locut have no knobs any more — they are the two draggable handles on
// ReverbFilterCurve. Their defaults still belong here so hydration has a
// complete baseline.
const FILTER_DEFAULTS = { hicut: 12000, locut: 80 }
const MIX_DEFAULT = 30
const STYLE_DEFAULT = 0   // Generic — matches the engine APVTS default

// er_level / er_late keep the same APVTS ids on every style (no engine/bridge
// change) but change MEANING on Plate — XlethReverbEffect.h documents this
// per-style semantics table (the parameter layout, plus the mapping comment
// above processBlockPlate()). On the FDN styles (Generic/Room/Hall) these are
// literally the early-reflection tap level and the late-tail level. On Plate
// there are no discrete ER taps: er_level instead blends the 4-stage input-
// diffusion cascade against the raw pre-delay signal (front-end "bloom"), and
// er_late scales the 7-tap tank output level.
const KNOB_LABEL_OVERRIDES_BY_STYLE = {
  [STYLE_PLATE]: { er_level: 'BLOOM', er_late: 'TANK LEVEL' },
}

function knobLabelFor(knob, styleIdx) {
  return KNOB_LABEL_OVERRIDES_BY_STYLE[styleIdx]?.[knob.id] ?? knob.label
}

// ── Style selector ───────────────────────────────────────────────────────────
// Engine-side AudioParameterChoice — index 0..3. Labels are hardcoded here (the
// bridge surfaces a choice param as a plain numeric value).
//
// These are four genuinely different backends, not four presets of one
// algorithm: processEffect() dispatches Generic to processBlockLegacy or
// processBlockEnhanced (8-line FDN), Room to processBlockEnhanced on a much
// shorter delay set, Plate to processBlockPlate (a Dattorro cross-coupled
// figure-8 tank with no FDN and no ER bus at all), and Hall to
// processBlockHall (a dedicated 16-line FDN). Switching styles changes the
// sound — and the stage's geometry with it. reverbVizMath.js carries the full
// per-style table.
const STYLE_OPTIONS = REVERB_STYLE_LABELS.map((label, value) => ({ value, label }))

const DEFAULT_PARAMS = {
  ...Object.fromEntries(ALL_KNOBS.map(k => [k.id, k.default])),
  ...FILTER_DEFAULTS,
  mix: MIX_DEFAULT,
  style: STYLE_DEFAULT,
}

// ── Vertical MIX fader ───────────────────────────────────────────────────────
// A knob would put MIX on the same visual tier as the shaping controls; a fader
// reads as the output stage it is. Pointer capture keeps the drag alive when
// the pointer leaves the panel. Mirrors DelayPanel's DelayMixSlider.

function ReverbMixSlider({ value, onPreview, onCommit }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const liveRef = useRef(value)
  liveRef.current = value

  const valueFromEvent = useCallback((e) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return liveRef.current
    return clamp(100 * (1 - (e.clientY - rect.top) / rect.height), 0, 100)
  }, [])

  const onPointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
    draggingRef.current = true
    const next = valueFromEvent(e)
    liveRef.current = next
    onPreview?.('mix', next)
  }, [valueFromEvent, onPreview])

  const onPointerMove = useCallback((e) => {
    if (!draggingRef.current) return
    const next = valueFromEvent(e)
    liveRef.current = next
    onPreview?.('mix', next)
  }, [valueFromEvent, onPreview])

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit?.('mix', liveRef.current)
  }, [onCommit])

  const pct = clamp(value, 0, 100)

  return (
    <div className="reverb-mix">
      <div
        ref={trackRef}
        className="reverb-mix-track"
        role="slider"
        aria-label="Mix"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 5
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onCommit?.('mix', clamp(pct + step, 0, 100)) }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onCommit?.('mix', clamp(pct - step, 0, 100)) }
        }}
      >
        <div className="reverb-mix-fill" style={{ height: `${pct}%` }} />
        <div className="reverb-mix-thumb" style={{ bottom: `${pct}%` }} />
      </div>
      <div className="reverb-mix-value">{Math.round(pct)}<span className="reverb-unit">%</span></div>
      <div className="reverb-mix-label">MIX</div>
    </div>
  )
}

// ── ReverbPanel ──────────────────────────────────────────────────────────────

export default function ReverbPanel() {
  const target = useReverbStore(s => s.target)
  const close  = useReverbStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 320),
    y: 60,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('canvas')) return
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
        x: Math.max(-400, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0,    Math.min(window.innerHeight - 100, startPanelY + e.clientY - startMouseY)),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn('[ReverbPanel] audio.getEffectParameters is unavailable — panel will show defaults')
      return
    }
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[ReverbPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. window.xleth.audio.setEffectParameter
  // is optional-chained everywhere else in the app, which means a missing method
  // fails silently — so the presence check is explicit and warns rather than
  // dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[ReverbPanel] audio.setEffectParameter is unavailable — dropped', id, value)
      return
    }
    fn(t.trackId, t.nodeId, id, value)
  }, [])

  const flushPending = useCallback(() => {
    rafRef.current = 0
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    for (const id of Object.keys(pending)) sendParam(id, pending[id])
  }, [sendParam])

  /**
   * Drag-time write: updates local state immediately so the canvases and
   * readouts track the pointer at 60 fps, and coalesces the engine write to at
   * most one per animation frame per parameter. Without the coalescing a knob
   * sweep is a per-pointermove IPC storm on the JUCE message thread — which is
   * exactly what the previous single setParam() did.
   */
  const previewParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    pendingRef.current = { ...(pendingRef.current || {}), [id]: value }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPending)
  }, [flushPending])

  /** Release / discrete write: local state + an immediate authoritative send. */
  const commitParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    if (pendingRef.current) delete pendingRef.current[id]
    sendParam(id, value)
  }, [sendParam])

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    pendingRef.current = null
  }, [])

  // Engine returns style as a float (AudioParameterChoice index); styleIndexOf
  // rounds and clamps it defensively in case of float jitter.
  const activeStyleIdx = styleIndexOf(params.style)

  const setStyle = useCallback((idx) => { commitParam('style', idx) }, [commitParam])

  const secondaryKnobs = useMemo(
    () => SECONDARY_KNOBS.map(k => ({ ...k, label: knobLabelFor(k, activeStyleIdx) })),
    [activeStyleIdx],
  )

  // Preset load/undo: the adapter already wrote every param to the engine —
  // mirror them into local state so the knobs/visualizer reflect it immediately.
  const applyPresetState = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  if (!target) return null

  const renderKnob = (k, size) => (
    <div key={k.id} className={`reverb-knob-cell${size <= 52 ? ' reverb-knob-cell--sm' : ''}`}>
      <PluginUIKitKnob
        value={params[k.id]}
        min={k.min}
        max={k.max}
        defaultValue={k.default}
        label={k.label}
        formatValue={k.fmt}
        onLiveChange={v => previewParam(k.id, v)}
        onCommit={v => commitParam(k.id, v)}
        size={size}
        dragRange={size >= 72 ? 180 : 150}
        appearance={MIXER_RING_APPEARANCE}
      />
      {/* The mixer-ring preset hides its own readout (and would draw an accent
          dot beside it); the value is rendered here instead so every control on
          the panel is legible without a drag. */}
      <div className="reverb-knob-value">{k.fmt(params[k.id])}</div>
    </div>
  )

  return (
    <div className="reverb-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="reverb-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="reverb-panel-title">REVERB</span>
        <span className="reverb-panel-sub">
          {backendTag(activeStyleIdx, params.smoothness)}
        </span>
        <button className="reverb-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="reverb"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Style selector — segmented choice. Each index is a different engine
          backend; see the STYLE_OPTIONS comment above. */}
      <div className="reverb-style-row" role="radiogroup" aria-label="Reverb style">
        {STYLE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={activeStyleIdx === opt.value}
            className={
              'reverb-style-button' +
              (activeStyleIdx === opt.value ? ' is-active' : '')
            }
            onClick={() => setStyle(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Stage — dominant visualization */}
      <div className="reverb-stage">
        <ReverbDecayFieldVisualizer params={params} styleIndex={activeStyleIdx} />
      </div>

      {/* Strip — one flat control row, no titles */}
      <div className="reverb-strip">
        <ReverbMixSlider
          value={params.mix}
          onPreview={previewParam}
          onCommit={commitParam}
        />

        <div className="reverb-strip-right">
          <div className="reverb-strip-primary">
            {PRIMARY_KNOBS.map(k => renderKnob(k, 72))}
          </div>

          <div className="reverb-strip-secondary">
            {secondaryKnobs.map(k => renderKnob(k, 52))}
          </div>

          <div className="reverb-strip-tertiary">
            {TERTIARY_KNOBS.map(k => renderKnob(k, 44))}

            <div className="reverb-filter">
              <ReverbFilterCurve
                loHz={params.locut}
                hiHz={params.hicut}
                onPreview={previewParam}
                onCommit={commitParam}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

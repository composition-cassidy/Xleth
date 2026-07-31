import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useUniFlangeStore from '../../stores/uniFlangeStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// ── Parameter definitions ────────────────────────────────────────────────────
// Every id here is an existing engine parameter (UniFlangeEffect.h createLayout).
// Ranges and ids mirror that file's NormalisableRange bounds exactly.
//
// NOTE on defaults: createLayout() declares speed=50, cross=0, dry=0 — not the
// 75/-25/100 figures floated when this panel was speced. The engine's APVTS
// defaults are the source of truth, so this panel mirrors what
// getEffectParameters actually returns rather than the speced numbers.

const VOICE_KNOBS = [
  { id: 'order',  label: 'ORDER',  min: 1, max: 8,   default: 4,  fmt: v => `${Math.round(v)}`,      quantize: v => Math.round(clamp(v, 1, 8)) },
  { id: 'delay',  label: 'DELAY',  min: 0, max: 100, default: 0,  fmt: v => `${v.toFixed(0)} %` },
  { id: 'spread', label: 'SPREAD', min: 0, max: 100, default: 100, fmt: v => `${v.toFixed(0)} %` },
]

const MOD_KNOBS = [
  { id: 'depth', label: 'DEPTH', min: 0, max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
  { id: 'speed', label: 'SPEED', min: 0, max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
]

const IMAGE_KNOBS = [
  { id: 'cross', label: 'CROSS', min: -100, max: 100, default: 0, fmt: v => `${v.toFixed(0)} %` },
]

const MIX_KNOBS = [
  { id: 'dry', label: 'DRY', min: -100, max: 100, default: 0,   fmt: v => `${v.toFixed(0)} %` },
  { id: 'wet', label: 'WET', min: -100, max: 100, default: 100, fmt: v => `${v.toFixed(0)} %` },
]

const ALL_KNOBS = [...VOICE_KNOBS, ...MOD_KNOBS, ...IMAGE_KNOBS, ...MIX_KNOBS]

const MODE_LEGACY = 0
const MODE_HQ = 1

const DEFAULT_PARAMS = {
  ...Object.fromEntries(ALL_KNOBS.map(k => [k.id, k.default])),
  mode: MODE_LEGACY,
}

function quantizeFor(k, v) {
  return k.quantize ? k.quantize(v) : v
}

// ── Mode toggle ──────────────────────────────────────────────────────────────
// mode is a discrete {0=LEGACY, 1=HQ} engine param (delay-tap interpolation
// quality) — a two-button segmented control, not a knob or dropdown.

function UniFlangeModeToggle({ mode, onChange }) {
  return (
    <div className="uniflange-mode-toggle" role="group" aria-label="Interpolation mode">
      <button
        type="button"
        className={`uniflange-mode-toggle-btn${mode === MODE_LEGACY ? ' active' : ''}`}
        onClick={() => onChange(MODE_LEGACY)}
        aria-pressed={mode === MODE_LEGACY}
      >
        LEGACY
      </button>
      <button
        type="button"
        className={`uniflange-mode-toggle-btn${mode === MODE_HQ ? ' active' : ''}`}
        onClick={() => onChange(MODE_HQ)}
        aria-pressed={mode === MODE_HQ}
      >
        HQ
      </button>
    </div>
  )
}

// ── UniFlangePanel ───────────────────────────────────────────────────────────

export default function UniFlangePanel() {
  const target = useUniFlangeStore(s => s.target)
  const close  = useUniFlangeStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 300),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
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
      console.warn('[UniFlangePanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[UniFlangePanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. The presence check is explicit
  // and warns once per call site rather than dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[UniFlangePanel] audio.setEffectParameter is unavailable — dropped', id, value)
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
   * Drag-time write: updates local state immediately so readouts track the
   * pointer at 60 fps, and coalesces the engine write to at most one per
   * animation frame per parameter. Without the coalescing a knob sweep is a
   * per-pointermove IPC storm on the JUCE message thread.
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

  const handleModeChange = useCallback((value) => {
    commitParam('mode', value)
  }, [commitParam])

  if (!target) return null

  const renderKnobGroup = (knobs, sizeKnob) => (
    knobs.map(k => (
      <div key={k.id} className={`uniflange-knob-cell${sizeKnob < 72 ? ' uniflange-knob-cell--sm' : ''}`}>
        <PluginUIKitKnob
          value={params[k.id]}
          min={k.min}
          max={k.max}
          defaultValue={k.default}
          label={k.label}
          formatValue={k.fmt}
          onLiveChange={v => previewParam(k.id, quantizeFor(k, v))}
          onCommit={v => commitParam(k.id, quantizeFor(k, v))}
          size={sizeKnob}
          dragRange={150}
          appearance={MIXER_RING_APPEARANCE}
        />
        {/* The mixer-ring preset hides its own readout; the value is rendered
            here instead so every control is legible at rest. */}
        <div className="uniflange-knob-value">{k.fmt(params[k.id])}</div>
      </div>
    ))
  )

  return (
    <div className="uniflange-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="uniflange-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="uniflange-panel-title">UNIFLANGE</span>
        <button className="uniflange-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      {/* Strip — one flat control row, no titles */}
      <div className="uniflange-strip">
        <div className="uniflange-group uniflange-group-voice">
          {renderKnobGroup(VOICE_KNOBS, 72)}
        </div>

        <div className="uniflange-group uniflange-group-mod">
          {renderKnobGroup(MOD_KNOBS, 52)}
        </div>

        <div className="uniflange-group uniflange-group-image">
          {renderKnobGroup(IMAGE_KNOBS, 52)}
        </div>

        <div className="uniflange-group uniflange-group-mix">
          {renderKnobGroup(MIX_KNOBS, 52)}
        </div>

        <div className="uniflange-group uniflange-group-mode">
          <UniFlangeModeToggle mode={params.mode} onChange={handleModeChange} />
        </div>
      </div>
    </div>
  )
}

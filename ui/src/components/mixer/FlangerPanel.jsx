import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useFlangerStore from '../../stores/flangerStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import FlangerVisualizerCanvas from './FlangerVisualizerCanvas.jsx'

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ── Parameter definitions ────────────────────────────────────────────────────
// Every id here is an existing engine parameter (XlethFlangerEffect). RATE and
// DEPTH define the modulation character and read as primary; DELAY, FEEDBACK
// and WIDTH shape it and read as secondary. MIX is a vertical fader (see
// FlangerMixSlider below) rather than a knob — it's the output stage, not a
// modulation parameter, matching the Delay panel's standard.

const PRIMARY_KNOBS = [
  { id: 'rate',  label: 'RATE',  min: 0.05, max: 10,  default: 0.5, fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'depth', label: 'DEPTH', min: 0,    max: 100, default: 70,  fmt: v => `${v.toFixed(0)} %`  },
]

const SECONDARY_KNOBS = [
  { id: 'delay',    label: 'DELAY',    min: 0.1, max: 5,   default: 1.5, fmt: v => `${v.toFixed(2)} ms` },
  { id: 'feedback', label: 'FEEDBACK', min: -95, max: 95,  default: 50,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'width',    label: 'WIDTH',    min: 0,   max: 100, default: 50,  fmt: v => `${v.toFixed(0)} %`  },
]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(PRIMARY_KNOBS.map(k => [k.id, k.default])),
  ...Object.fromEntries(SECONDARY_KNOBS.map(k => [k.id, k.default])),
  mix: 50,
}

// ── Vertical MIX slider ──────────────────────────────────────────────────────
// Matches DelayPanel's DelayMixSlider: a fader reads as the output stage a
// knob would bury among the modulation controls. Pointer capture keeps the
// drag alive when the pointer leaves the panel.

function FlangerMixSlider({ value, onPreview, onCommit }) {
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
    <div className="flanger-mix">
      <div
        ref={trackRef}
        className="flanger-mix-track"
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
        <div className="flanger-mix-fill" style={{ height: `${pct}%` }} />
        <div className="flanger-mix-thumb" style={{ bottom: `${pct}%` }} />
      </div>
      <div className="flanger-mix-value">{Math.round(pct)}<span className="flanger-unit">%</span></div>
      <div className="flanger-mix-label">MIX</div>
    </div>
  )
}

// ── FlangerPanel ─────────────────────────────────────────────────────────────

export default function FlangerPanel() {
  const target = useFlangerStore(s => s.target)
  const close  = useFlangerStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 240),
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
      console.warn('[FlangerPanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[FlangerPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. window.xleth.audio.setEffectParameter
  // is optional-chained everywhere else in the app, which means a missing method
  // fails silently — so the presence check is explicit and warns once per call
  // site rather than dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[FlangerPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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
   * Drag-time write: updates local state immediately so the canvas and
   * readouts track the pointer at 60 fps, and coalesces the engine write to at
   * most one per animation frame per parameter. Without the coalescing a knob
   * sweep is a per-pointermove IPC storm on the JUCE message thread.
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

  // Preset load/undo: the adapter already wrote every param to the engine —
  // mirror them into local state so the knobs/visualizer reflect it immediately.
  const applyPresetState = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  if (!target) return null

  return (
    <div className="flanger-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="flanger-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="flanger-panel-title">FLANGER</span>
        <button className="flanger-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="flanger"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Stage — dominant visualization */}
      <div className="flanger-stage">
        <FlangerVisualizerCanvas params={params} />
      </div>

      {/* Strip — one flat control row, no titles */}
      <div className="flanger-strip">
        <FlangerMixSlider
          value={params.mix}
          onPreview={previewParam}
          onCommit={commitParam}
        />

        <div className="flanger-strip-primary">
          {PRIMARY_KNOBS.map(k => (
            <div key={k.id} className="flanger-knob-cell">
              <PluginUIKitKnob
                value={params[k.id]}
                min={k.min}
                max={k.max}
                defaultValue={k.default}
                label={k.label}
                formatValue={k.fmt}
                onLiveChange={v => previewParam(k.id, v)}
                onCommit={v => commitParam(k.id, v)}
                size={72}
                dragRange={150}
                appearance={MIXER_RING_APPEARANCE}
              />
              {/* The mixer-ring preset hides its own readout (and would draw an
                  accent dot beside it); the value is rendered here instead so
                  every control on the panel is legible without a drag. */}
              <div className="flanger-knob-value">{k.fmt(params[k.id])}</div>
            </div>
          ))}
        </div>

        <div className="flanger-strip-secondary">
          {SECONDARY_KNOBS.map(k => (
            <div key={k.id} className="flanger-knob-cell flanger-knob-cell--sm">
              <PluginUIKitKnob
                value={params[k.id]}
                min={k.min}
                max={k.max}
                defaultValue={k.default}
                label={k.label}
                formatValue={k.fmt}
                onLiveChange={v => previewParam(k.id, v)}
                onCommit={v => commitParam(k.id, v)}
                size={52}
                dragRange={150}
                appearance={MIXER_RING_APPEARANCE}
              />
              <div className="flanger-knob-value">{k.fmt(params[k.id])}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

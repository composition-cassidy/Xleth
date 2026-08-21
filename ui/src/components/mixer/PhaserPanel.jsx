import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import usePhaserStore from '../../stores/phaserStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import XlethSelect from '../common/XlethSelect.jsx'
import PhaserVisualizerCanvas from './PhaserVisualizerCanvas.jsx'
import { clamp } from './mixerFilterMath.js'

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// ── Parameter definitions ────────────────────────────────────────────────────
// Every id here is an existing engine parameter — ranges/defaults unchanged.

const PRIMARY_KNOBS = [
  { id: 'rate',  label: 'RATE',  min: 0.05, max: 5,   default: 0.5, fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'depth', label: 'DEPTH', min: 0,    max: 100, default: 80,  fmt: v => `${v.toFixed(0)} %`  },
]

const SECONDARY_KNOBS = [
  { id: 'feedback', label: 'FEEDBACK', min: -95, max: 95,  default: 40, fmt: v => `${v.toFixed(0)} %` },
  { id: 'width',    label: 'WIDTH',    min: 0,   max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
]

// Engine range is 1–6 (XlethPhaserEffect.h): each stage is one second-order
// allpass section, and each section produces exactly one notch.
const STAGES_OPTIONS = [1, 2, 3, 4, 5, 6].map(n => ({ value: n, label: String(n) }))

const DEFAULT_PARAMS = {
  ...Object.fromEntries([...PRIMARY_KNOBS, ...SECONDARY_KNOBS].map(k => [k.id, k.default])),
  mix: 50,
  freq_low: 100,
  freq_high: 4000,
  stages: 4,
}

// ── Vertical MIX slider ──────────────────────────────────────────────────────
// Mirrors DelayPanel's DelayMixSlider: a fader reads as the output stage it is,
// where a knob would put MIX on the same tier as the modulation controls.
// Pointer capture keeps the drag alive when the pointer leaves the panel.

function PhaserMixSlider({ value, onPreview, onCommit }) {
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
    <div className="phaser-mix">
      <div
        ref={trackRef}
        className="phaser-mix-track"
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
        <div className="phaser-mix-fill" style={{ height: `${pct}%` }} />
        <div className="phaser-mix-thumb" style={{ bottom: `${pct}%` }} />
      </div>
      <div className="phaser-mix-value">{Math.round(pct)}<span className="phaser-unit">%</span></div>
      <div className="phaser-mix-label">MIX</div>
    </div>
  )
}

// ── PhaserPanel ───────────────────────────────────────────────────────────────

export default function PhaserPanel() {
  const target = usePhaserStore(s => s.target)
  const close  = usePhaserStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 175),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return
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
      console.warn('[PhaserPanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[PhaserPanel] hydrate failed:', e?.message)
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
      console.warn('[PhaserPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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
   * or handle drag is a per-pointermove IPC storm on the JUCE message thread.
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

  const handleStagesChange = useCallback((value) => {
    commitParam('stages', Number(value))
  }, [commitParam])

  // Preset load/undo: the adapter already wrote every param to the engine —
  // mirror them into local state so the knobs/visualizer reflect it immediately.
  const applyPresetState = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  if (!target) return null

  return (
    <div className="phaser-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="phaser-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="phaser-panel-title">PHASER</span>
        <span className="phaser-panel-sub">{params.stages}-STAGE</span>
        <button className="phaser-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="phaser"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Stage — dominant visualization, doubles as the FREQ LOW/HIGH control */}
      <div className="phaser-stage">
        <PhaserVisualizerCanvas params={params} onPreview={previewParam} onCommit={commitParam} />
      </div>

      {/* Strip — one flat control row, no titles */}
      <div className="phaser-strip">
        <PhaserMixSlider
          value={params.mix}
          onPreview={previewParam}
          onCommit={commitParam}
        />

        <div className="phaser-strip-right">
          <div className="phaser-strip-primary-knobs">
            {PRIMARY_KNOBS.map(k => (
              <div key={k.id} className="phaser-knob-cell">
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
                {/* The mixer-ring preset hides its own readout; render it here
                    so every control is legible without a drag. */}
                <div className="phaser-knob-value">{k.fmt(params[k.id])}</div>
              </div>
            ))}
          </div>

          <div className="phaser-strip-secondary">
            {SECONDARY_KNOBS.map(k => (
              <div key={k.id} className="phaser-knob-cell">
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
                <div className="phaser-knob-value">{k.fmt(params[k.id])}</div>
              </div>
            ))}

            <div className="phaser-stages-cell">
              <XlethSelect
                className="phaser-stages-select"
                value={params.stages}
                options={STAGES_OPTIONS}
                ariaLabel="Stages"
                onChange={handleStagesChange}
              />
              <div className="phaser-stages-label">STAGES</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

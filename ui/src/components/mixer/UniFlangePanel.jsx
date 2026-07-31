import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useUniFlangeStore from '../../stores/uniFlangeStore.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// ── Fader definitions ────────────────────────────────────────────────────────
// Every id here is an existing engine parameter (UniFlangeEffect.h createLayout).
// Ranges and ids mirror that file's NormalisableRange bounds exactly. Labels and
// column order mirror Fruity Flangus (ORD DEPTH SPD DEL SPRD CROSS DRY WET) —
// only the presentation changed, the param ids underneath did not.
//
// NOTE on defaults: createLayout() declares speed=50, cross=0, dry=0 — not the
// 75/-25/100 figures floated when this panel was speced. The engine's APVTS
// defaults are the source of truth, so this panel mirrors what
// getEffectParameters actually returns rather than the speced numbers.
//
// `mode` (LEGACY/HQ delay-tap interpolation) has no control here by design —
// the panel never reads or writes it, so the engine stays on its LEGACY default.

const pct = v => `${v.toFixed(0)} %`

const FADERS = [
  { id: 'order',  label: 'ORD',   kind: 'stepped', min: 1,    max: 8,   default: 4,   fmt: v => `${Math.round(v)}` },
  { id: 'depth',  label: 'DEPTH', kind: 'uni',     min: 0,    max: 100, default: 50,  fmt: pct },
  { id: 'speed',  label: 'SPD',   kind: 'uni',     min: 0,    max: 100, default: 50,  fmt: pct },
  { id: 'delay',  label: 'DEL',   kind: 'uni',     min: 0,    max: 100, default: 0,   fmt: pct },
  { id: 'spread', label: 'SPRD',  kind: 'uni',     min: 0,    max: 100, default: 100, fmt: pct },
  { id: 'cross',  label: 'CROSS', kind: 'bi',      min: -100, max: 100, default: 0,   fmt: pct },
  { id: 'dry',    label: 'DRY',   kind: 'bi',      min: -100, max: 100, default: 0,   fmt: pct },
  { id: 'wet',    label: 'WET',   kind: 'bi',      min: -100, max: 100, default: 100, fmt: pct },
]

const DEFAULT_PARAMS = Object.fromEntries(FADERS.map(f => [f.id, f.default]))

const TRACK_H = 150
const THUMB_H = 10
const GROOVE_H = TRACK_H - THUMB_H

const posFromValue = (min, max, v) => {
  const span = max - min
  return span > 0 ? (clamp(v, min, max) - min) / span : 0
}
const valueFromPos = (min, max, p) => min + (max - min) * clamp(p, 0, 1)

// ── Vertical fader — DEPTH / SPD / DEL / SPRD (unipolar) and CROSS / DRY / WET
// (bipolar, center detent at 0). Pointer-captured relative drag mirrors the
// mixer-ring knob/VolumeFader interaction: grab anywhere on the track, drag up
// to increase. Shift = fine. Double-click = reset to default. Arrow keys / Home
// / End drive it from the keyboard once focused.

function UniFlangeFader({ label, min, max, defaultValue, bipolar, value, fmt, onLiveChange, onCommit }) {
  const dragRef = useRef(null)
  const liveRef = useRef(value)
  useEffect(() => { liveRef.current = value }, [value])

  const pos = posFromValue(min, max, value)
  const centerPos = bipolar ? posFromValue(min, max, 0) : 0
  const thumbTop = (1 - pos) * GROOVE_H

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    dragRef.current = { startY: e.clientY, startPos: pos, fine: e.shiftKey }
  }, [pos])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const dy = d.startY - e.clientY
    const sensitivity = (e.shiftKey || d.fine) ? 8 : 1
    const nextPos = clamp(d.startPos + (dy / GROOVE_H) / sensitivity, 0, 1)
    const next = valueFromPos(min, max, nextPos)
    liveRef.current = next
    onLiveChange(next)
  }, [min, max, onLiveChange])

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    onCommit(liveRef.current)
  }, [onCommit])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const sensitivity = e.shiftKey ? 500 : 100
    const next = valueFromPos(min, max, pos - (e.deltaY / sensitivity) / 20)
    onLiveChange(next)
    onCommit(next)
  }, [min, max, pos, onLiveChange, onCommit])

  const handleDoubleClick = useCallback(() => {
    onCommit(defaultValue)
  }, [defaultValue, onCommit])

  const handleKeyDown = useCallback((e) => {
    const span = max - min
    const step = (e.shiftKey ? 0.1 : 0.01) * span
    let next = null
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = clamp(value + step, min, max)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = clamp(value - step, min, max)
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    onCommit(next)
  }, [value, min, max, onCommit])

  const fillStyle = bipolar
    ? { bottom: `${Math.min(pos, centerPos) * 100}%`, height: `${Math.abs(pos - centerPos) * 100}%` }
    : { bottom: 0, height: `${pos * 100}%` }

  return (
    <div className="uniflange-fader-cell">
      <div
        className="uniflange-fader-track"
        style={{ height: TRACK_H }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        title={`${label} · Drag vertical · Shift = fine · Double-click = reset`}
      >
        <div className="uniflange-fader-groove" style={{ top: THUMB_H / 2, bottom: THUMB_H / 2 }}>
          <div className="uniflange-fader-fill" style={fillStyle} />
          {bipolar && <div className="uniflange-fader-center" style={{ bottom: `${centerPos * 100}%` }} />}
        </div>
        <div className="uniflange-fader-thumb" style={{ top: thumbTop + THUMB_H / 2 }} />
      </div>
      <div className="uniflange-fader-label">{label}</div>
      <div className="uniflange-fader-value">{fmt(value)}</div>
    </div>
  )
}

// ── ORD — 8-position stepped ladder ─────────────────────────────────────────
// Flangus renders ORD as discrete detents rather than a smooth fader; this
// reproduces that with 8 stacked steps (top = max, bottom = min). Click/drag a
// step to jump straight to it — there's no meaningful "relative drag" for a
// small discrete range.

function UniFlangeOrderStepper({ label, min, max, defaultValue, value, fmt, onLiveChange, onCommit }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const steps = max - min + 1

  const stepFromClientY = useCallback((clientY) => {
    const el = trackRef.current
    if (!el) return value
    const rect = el.getBoundingClientRect()
    const t = clamp((clientY - rect.top) / rect.height, 0, 1)
    return clamp(Math.round(max - t * (steps - 1)), min, max)
  }, [min, max, steps, value])

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    draggingRef.current = true
    onLiveChange(stepFromClientY(e.clientY))
  }, [stepFromClientY, onLiveChange])

  const handlePointerMove = useCallback((e) => {
    if (!draggingRef.current) return
    onLiveChange(stepFromClientY(e.clientY))
  }, [stepFromClientY, onLiveChange])

  const handlePointerUp = useCallback((e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit(stepFromClientY(e.clientY))
  }, [stepFromClientY, onCommit])

  const handleDoubleClick = useCallback(() => {
    onCommit(defaultValue)
  }, [defaultValue, onCommit])

  const handleKeyDown = useCallback((e) => {
    let next = null
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = clamp(value + 1, min, max)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = clamp(value - 1, min, max)
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    onCommit(next)
  }, [value, min, max, onCommit])

  return (
    <div className="uniflange-fader-cell">
      <div
        ref={trackRef}
        className="uniflange-order-track"
        style={{ height: TRACK_H }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        title={`${label} · Click/drag a step · Double-click = reset`}
      >
        {Array.from({ length: steps }).map((_, row) => {
          const stepValue = max - row
          return (
            <div
              key={stepValue}
              className={`uniflange-order-step${stepValue === value ? ' active' : ''}`}
            />
          )
        })}
      </div>
      <div className="uniflange-fader-label">{label}</div>
      <div className="uniflange-fader-value">{fmt(value)}</div>
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
   * animation frame per parameter. Without the coalescing a fader sweep is a
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

  if (!target) return null

  return (
    <div className="uniflange-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="uniflange-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="uniflange-panel-title">UNIFLANGE</span>
        <button className="uniflange-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      {/* Strip — one row of Flangus-order faders */}
      <div className="uniflange-fader-row">
        {FADERS.map(f => (
          f.kind === 'stepped' ? (
            <UniFlangeOrderStepper
              key={f.id}
              label={f.label}
              min={f.min}
              max={f.max}
              defaultValue={f.default}
              value={params[f.id]}
              fmt={f.fmt}
              onLiveChange={v => previewParam(f.id, v)}
              onCommit={v => commitParam(f.id, v)}
            />
          ) : (
            <UniFlangeFader
              key={f.id}
              label={f.label}
              min={f.min}
              max={f.max}
              defaultValue={f.default}
              bipolar={f.kind === 'bi'}
              value={params[f.id]}
              fmt={f.fmt}
              onLiveChange={v => previewParam(f.id, v)}
              onCommit={v => commitParam(f.id, v)}
            />
          )
        ))}
      </div>
    </div>
  )
}

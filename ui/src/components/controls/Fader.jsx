import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDragLaw } from './dragLaw.js'

// Fader — the vertical/horizontal sibling to Knob.jsx. Same drag law
// (ui/src/components/controls/dragLaw.js), same grab-relative/fine/reset/
// wheel/live-commit contract, but a linear travel groove instead of a
// rotary arc, plus pointer lock for infinite travel and optional detents.
//
// See SLIDER_FEEL_SPEC.md for the defects this replaces (the old mixer
// fader painted in TEXT tokens, no pointer lock, per-event store writes).
//
// Props:
//   value, min, max        current value + numeric bounds (required unless
//                           toNorm/fromNorm below fully own the mapping)
//   defaultValue            ctrl+click reset target (default: min)
//   skew                    JUCE NormalisableRange skew (default 1 = linear),
//                           exactly as Knob.jsx — ignored when toNorm/fromNorm
//                           are supplied
//   toNorm, fromNorm        optional custom taper overriding skew — this is
//                           how a non-power-law curve (e.g. the mixer's dB
//                           taper, see posToDB/dbToLinear/linearToPos below)
//                           plugs in. Same shape dragLaw.js itself takes.
//   orientation              'vertical' (default) | 'horizontal'
//   length                   px of travel = full min→max sweep (default 160).
//                             Also the resolveDragRange() fallback when `fill`
//                             is on and the groove hasn't been laid out yet.
//   thickness                px of the control's cross-axis footprint (default 22)
//   fill                     stretch to fill the parent flex container's
//                             cross-axis space instead of using a fixed
//                             `length` — e.g. the mixer fader, which has
//                             always tracked the strip's available height
//                             rather than a constant pixel travel.
//   fineMultiplier           shift-drag slowdown factor (default 8, per spec — 10 for knobs)
//   detents                  optional array of VALUES (not normalised) that
//                             magnetise during a drag — e.g. [1.0] for unity
//                             gain, [0] for centre pan. Suppressed while fine
//                             mode is held, and never applied to wheel steps.
//   detentMagnetism          normalised (0..1) snap radius (default 0.02)
//   formatValue, parseValue  (v)=>string / (str)=>v for the optional internal
//                             readout's double-click-to-type editor
//   onLiveChange             (v) => void — every frame during the drag/wheel;
//                             never crosses the bridge
//   onCommit                 (v) => void — once on release/wheel-step/reset;
//                             the only callback that should cross the bridge
//   readout                  'hidden' (default) | 'above' | 'below' — an
//                             external readout (like the mixer's FaderReadout)
//                             is equally valid; this is a convenience for
//                             callers that don't want to build their own.
//   label, color             text below the control; accent override (CSS color)
//
// ── dB taper — lifted as-is from the former mixer VolumeFader.jsx ──────────
// Fader position p ∈ [0,1] → dB → linear gain.
// p=0 → -inf, p≈0.05 → -96dB, p=0.75 → 0dB, p=1.0 → +12dB
export function posToDB(p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return 12
  if (p <= 0.75) {
    const t = p / 0.75                    // t ∈ [0, 1]
    return -96 * Math.pow(1 - t, 3)       // cubic: fine near 0dB, accelerates toward -96
  }
  return ((p - 0.75) / 0.25) * 12         // linear: 0dB → +12dB
}

export function dbToLinear(db) {
  if (db <= -96) return 0
  return Math.pow(10, db / 20)
}

export function linearToDB(gain) {
  if (gain <= 0) return -Infinity
  return 20 * Math.log10(gain)
}

export function linearToPos(gain) {
  const db = linearToDB(gain)
  if (db <= -96) return 0
  if (db >= 12) return 1
  if (db >= 0) return 0.75 + (db / 12) * 0.25
  return 0.75 * (1 - Math.pow(-db / 96, 1 / 3))   // inverse cubic
}

export function formatDB(gain) {
  if (gain <= 0) return '-∞'
  const db = linearToDB(gain)
  if (db <= -96) return '-∞'
  return db.toFixed(1)
}

// fromNorm for the drag law: fader position (0..1) → engine gain, through
// the dB taper above. posToDB/dbToLinear stay untouched; this just composes.
export function gainFromPos(pos) {
  const db = posToDB(pos)
  return db <= -96 ? 0 : dbToLinear(db)
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))

export default function Fader({
  value,
  min = 0,
  max = 1,
  defaultValue,
  skew = 1,
  toNorm,
  fromNorm,
  orientation = 'vertical',
  length = 160,
  thickness = 22,
  fill = false,
  fineMultiplier = 8,
  detents = null,
  detentMagnetism = 0.02,
  formatValue,
  parseValue,
  onLiveChange,
  onCommit,
  readout = 'hidden',
  label,
  color,
}) {
  const rootRef = useRef(null)
  const grooveRef = useRef(null)
  const fillRef = useRef(null)
  const thumbRef = useRef(null)

  const [hovered, setHovered] = useState(false)
  const [grabbed, setGrabbed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const isHorizontal = orientation === 'horizontal'
  const axis = isHorizontal ? 'x' : 'y'

  // ── Value <-> normalised-position mapping ─────────────────────────────
  // Mirrors Knob.jsx's normFromValue/valueFromNorm exactly when no custom
  // toNorm/fromNorm is supplied; a caller-supplied pair (e.g. the dB taper)
  // takes priority, same contract as dragLaw.js itself.
  const clamp = useCallback((v) => Math.max(min, Math.min(max, v)), [min, max])
  const span = max - min
  const effSkew = Number.isFinite(skew) && skew > 0 ? skew : 1

  const toNormBase = useCallback((v) => {
    if (toNorm) return clamp01(toNorm(v))
    if (!(span > 0)) return 0
    const p = (clamp(v) - min) / span
    return effSkew === 1 || p <= 0 ? p : Math.pow(p, effSkew)
  }, [toNorm, clamp, min, span, effSkew])

  const fromNormBase = useCallback((x) => {
    const p = clamp01(x)
    if (fromNorm) return fromNorm(p)
    return min + span * (effSkew === 1 || p <= 0 ? p : Math.pow(p, 1 / effSkew))
  }, [fromNorm, min, span, effSkew])

  // ── Detents ─────────────────────────────────────────────────────────────
  const detentNorms = useMemo(() => (
    Array.isArray(detents) && detents.length ? detents.map((d) => toNormBase(d)) : null
  ), [detents, toNormBase])

  // dragApiRef lets fromNormWithDetents (passed INTO useDragLaw below) read
  // isDragging()/isFine() from the object useDragLaw returns, without a
  // circular reference — the ref is populated after the hook call, but only
  // ever read from event handlers that fire well after that render commits.
  const dragApiRef = useRef(null)

  const fromNormWithDetents = useCallback((norm) => {
    const n = clamp01(norm)
    if (detentNorms && dragApiRef.current?.isDragging?.() && !dragApiRef.current?.isFine?.()) {
      let best = null
      let bestDist = Infinity
      for (const dn of detentNorms) {
        const dist = Math.abs(n - dn)
        if (dist < bestDist) { bestDist = dist; best = dn }
      }
      if (best != null && bestDist <= detentMagnetism) return fromNormBase(best)
    }
    return fromNormBase(n)
  }, [detentNorms, detentMagnetism, fromNormBase])

  // ── Direct DOM paint ────────────────────────────────────────────────────
  // Bypasses React during a drag so a 1000Hz mouse never trails behind the
  // thumb — see the rAF-batched pointer handling below. React only owns this
  // markup again once a fresh `value` prop arrives (post-commit).
  const paint = useCallback((v) => {
    const pct = clamp01(toNormBase(v)) * 100
    if (fillRef.current) {
      if (isHorizontal) fillRef.current.style.width = `${pct}%`
      else fillRef.current.style.height = `${pct}%`
    }
    if (thumbRef.current) {
      if (isHorizontal) thumbRef.current.style.left = `${pct}%`
      else thumbRef.current.style.top = `${100 - pct}%`
    }
  }, [toNormBase, isHorizontal])

  const resolveDragRange = useCallback(() => {
    const el = grooveRef.current
    const measured = el ? (isHorizontal ? el.clientWidth : el.clientHeight) : 0
    return measured || length || 1
  }, [isHorizontal, length])

  const handleLiveChange = useCallback((next) => {
    paint(next)
    onLiveChange?.(next)
  }, [paint, onLiveChange])

  const handleCommit = useCallback((next) => {
    setGrabbed(false)
    onCommit?.(next)
  }, [onCommit])

  const drag = useDragLaw({
    value,
    toNorm: toNormBase,
    fromNorm: fromNormWithDetents,
    dragRange: resolveDragRange,
    resetValue: defaultValue != null ? defaultValue : min,
    onLiveChange: handleLiveChange,
    onCommit: handleCommit,
    axis,
    fineMultiplier,
  })
  dragApiRef.current = drag

  // ── Pointer lock + coalesced-event accumulation ────────────────────────
  // On pointerdown we lock the pointer to this element. While locked, the OS
  // cursor never moves — movementX/movementY carry the real delta instead of
  // clientX/clientY, which is what gives the drag infinite travel (no more
  // dying at the screen edge). getCoalescedEvents() drains every raw HID
  // sample a single pointermove batched up, so a 1000Hz mouse isn't lossy.
  // A virtual position is accumulated from those deltas and fed to the SAME
  // dragLaw pipeline Knob uses, via a synthetic {clientX, clientY} — the
  // normalised-accumulation/rebase/skew math never changes, only the source
  // of positional deltas does. At most one dragLaw update is applied per
  // animation frame.
  const virtualPosRef = useRef({ x: 0, y: 0 })
  const pendingShiftRef = useRef(false)
  const rafIdRef = useRef(null)
  const dirtyRef = useRef(false)

  const flush = useCallback(() => {
    rafIdRef.current = null
    if (!dirtyRef.current) return
    dirtyRef.current = false
    drag.onPointerMove({
      clientX: virtualPosRef.current.x,
      clientY: virtualPosRef.current.y,
      shiftKey: pendingShiftRef.current,
    })
  }, [drag.onPointerMove])

  const schedule = useCallback(() => {
    if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(flush)
  }, [flush])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return
    drag.onPointerDown(e)
    if (!drag.isDragging()) return // ctrl/cmd+click reset — no drag, no lock
    setGrabbed(true)
    virtualPosRef.current = { x: e.clientX, y: e.clientY }
    dirtyRef.current = false
    try {
      const lockResult = rootRef.current?.requestPointerLock?.()
      if (lockResult && typeof lockResult.catch === 'function') {
        lockResult.catch(() => { /* denied/unavailable — clientX/Y fallback below covers it */ })
      }
    } catch (_) { /* graceful fallback to clientX/Y deltas */ }
  }, [drag])

  const handlePointerMove = useCallback((e) => {
    if (!drag.isDragging()) return
    const locked = typeof document !== 'undefined' && document.pointerLockElement === rootRef.current
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null
    const list = events && events.length ? events : [e]
    for (const sub of list) {
      if (locked) {
        virtualPosRef.current.x += sub.movementX || 0
        virtualPosRef.current.y += sub.movementY || 0
      } else {
        virtualPosRef.current.x = sub.clientX
        virtualPosRef.current.y = sub.clientY
      }
    }
    pendingShiftRef.current = e.shiftKey
    dirtyRef.current = true
    schedule()
  }, [drag, schedule])

  const endDrag = useCallback(() => {
    if (!drag.isDragging()) return
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    if (dirtyRef.current) {
      dirtyRef.current = false
      drag.onPointerMove({
        clientX: virtualPosRef.current.x,
        clientY: virtualPosRef.current.y,
        shiftKey: pendingShiftRef.current,
      })
    }
    drag.onPointerUp()
    if (typeof document !== 'undefined' && document.pointerLockElement === rootRef.current) {
      document.exitPointerLock()
    }
  }, [drag])

  const handlePointerUp = useCallback(() => endDrag(), [endDrag])
  const handlePointerCancel = useCallback(() => endDrag(), [endDrag])
  const handleWheel = drag.onWheel

  // Re-sync the DOM to the committed value whenever it changes from outside
  // an active drag (prop update, undo, project load, initial mount) — the
  // drag path already painted directly and owns the pixels until release.
  useEffect(() => {
    if (!drag.isDragging()) paint(value)
  }, [value, paint, drag])

  const pos = clamp01(toNormBase(value))
  const pct = pos * 100
  const display = formatValue ? formatValue(value) : String(Math.round(value))

  const handleDoubleClick = useCallback(() => {
    if (drag.isDragging()) return
    setEditing(true)
    setEditText(formatValue ? formatValue(value) : String(value))
  }, [drag, formatValue, value])

  const commitEdit = useCallback(() => {
    const next = parseValue ? parseValue(editText) : (() => {
      const n = Number(editText)
      return Number.isNaN(n) ? null : clamp(n)
    })()
    if (next != null && Number.isFinite(next)) {
      paint(next)
      onLiveChange?.(next)
      onCommit?.(next)
    }
    setEditing(false)
  }, [editText, parseValue, clamp, paint, onLiveChange, onCommit])

  const rootStyle = {
    '--fader-length': `${length}px`,
    '--fader-thickness': `${thickness}px`,
    ...(color ? { '--fader-fill': color } : null),
  }

  const readoutNode = readout !== 'hidden' ? (
    editing ? (
      <input
        autoFocus
        type="text"
        className="xleth-fader-readout-input"
        value={editText}
        onChange={(e) => setEditText(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitEdit()
          else if (e.key === 'Escape') setEditing(false)
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    ) : (
      <div
        className="xleth-fader-readout"
        onDoubleClick={handleDoubleClick}
        title="Double-click to edit"
      >
        {display}
      </div>
    )
  ) : null

  return (
    <div className={[
      'xleth-fader-wrap',
      `xleth-fader-wrap--${orientation}`,
      fill ? 'xleth-fader-wrap--fill' : '',
    ].filter(Boolean).join(' ')}>
      {label && <div className="xleth-fader-label">{label}</div>}
      {readout === 'above' && readoutNode}
      <div
        ref={rootRef}
        className={[
          'xleth-fader',
          `xleth-fader--${orientation}`,
          fill ? 'xleth-fader--fill' : '',
          hovered ? 'is-hovered' : '',
          grabbed ? 'is-grabbed' : '',
        ].filter(Boolean).join(' ')}
        style={rootStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => { if (!drag.isDragging()) setHovered(false) }}
        onWheel={handleWheel}
        title="Drag · Shift = fine · Ctrl+click = reset"
      >
        <div ref={grooveRef} className="xleth-fader-groove">
          <div
            ref={fillRef}
            className="xleth-fader-fill"
            style={isHorizontal ? { width: `${pct}%` } : { height: `${pct}%` }}
          />
          {detentNorms && detentNorms.map((dn, i) => (
            <div
              key={i}
              className="xleth-fader-detent"
              style={isHorizontal ? { left: `${dn * 100}%` } : { bottom: `${dn * 100}%` }}
            />
          ))}
        </div>
        <div
          ref={thumbRef}
          className="xleth-fader-thumb"
          style={isHorizontal ? { left: `${pct}%` } : { top: `${100 - pct}%` }}
        />
      </div>
      {readout === 'below' && readoutNode}
    </div>
  )
}

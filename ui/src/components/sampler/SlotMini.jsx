import { useCallback, useRef, useState } from 'react'
import { useModTarget } from './modulation/useModTarget.js'
import {
  TARGET_SLOT_VOLUME, TARGET_SLOT_PAN, TARGET_SLOT_SEM,
  TARGET_SLOT_FINE, TARGET_SLOT_COARSE,
} from './modulation/modTargets.js'

// ── SlotMini ────────────────────────────────────────────────────────────────
// One compact drag field for a slot's tuning/level. Extracted from the old
// SlotList so the slot TAB STRIP and the SLOT INSPECTOR can share it: the strip
// shows none of these, the inspector shows all six for the selected slot only.
//
// The panel rule for continuous values holds here exactly as it did before:
// a drag paints a LOCAL preview and a single commit fires on pointer-up, so
// nothing touches IPC while the pointer is down.

// Per-control drag config: [min, max, step-per-pixel, integer?]
export const DRAG_SPECS = {
  octave:   { min: -4,   max: 4,   perPx: 0.05,  int: true,  label: 'OCT'  },
  semitone: { min: -12,  max: 12,  perPx: 0.12,  int: true,  label: 'SEM'  },
  fine:     { min: -100, max: 100, perPx: 1.0,   int: false, label: 'FINE' },
  coarse:   { min: -48,  max: 48,  perPx: 0.25,  int: true,  label: 'CRS'  },
  volume:   { min: 0,    max: 2,   perPx: 0.01,  int: false, label: 'VOL'  },
  pan:      { min: -1,   max: 1,   perPx: 0.01,  int: false, label: 'PAN'  },
}

// The mockup's 2x3 grid order: tuning on the top row, level on the bottom.
export const MINI_ORDER = ['octave', 'semitone', 'fine', 'coarse', 'volume', 'pan']

// ── Modulation targets ───────────────────────────────────────────────────────
// Five of the six minis are modulation destinations. OCT is deliberately NOT:
// the engine has no octave target (pitch modulation lands on SEM / FINE / CRS),
// so it stays an ordinary control and is the in-panel proof that an
// unregistered control is untouched by any of this.
const MINI_TARGETS = {
  volume:   TARGET_SLOT_VOLUME,
  pan:      TARGET_SLOT_PAN,
  semitone: TARGET_SLOT_SEM,
  fine:     TARGET_SLOT_FINE,
  coarse:   TARGET_SLOT_COARSE,
}

export function formatMiniValue(field, v) {
  if (field === 'volume') return v.toFixed(2)
  if (field === 'pan') {
    if (Math.abs(v) < 0.005) return 'C'
    return (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)
  }
  if (field === 'fine') return (v > 0 ? '+' : '') + v.toFixed(0)
  return (v > 0 ? '+' : '') + String(v)
}

export default function SlotMini({ field, value, onPreview, onCommit, disabled, slotIndex }) {
  const spec = DRAG_SPECS[field]
  const [dragging, setDragging] = useState(false)
  const stateRef = useRef({ startY: 0, startVal: 0, latest: 0 })
  const ringRef = useRef(null)

  // A mini is a DOM control, not a canvas, so its modulation indicator is a DOM
  // bar rather than an arc — the same rule the shared Knob follows in reverse:
  // the indicator belongs to whatever the control already draws with.
  const target = MINI_TARGETS[field]
  const mod = useModTarget(
    target == null ? null : { target, index: slotIndex, stage: 0, scale: 1 },
    { value, min: spec.min, max: spec.max },
  )

  const clamp = useCallback((v) => {
    const c = Math.min(spec.max, Math.max(spec.min, v))
    return spec.int ? Math.round(c) : c
  }, [spec])

  const onPointerDown = useCallback((e) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    stateRef.current = { startY: e.clientY, startVal: value, latest: value }
    setDragging(true)
  }, [disabled, value])

  const onPointerMove = useCallback((e) => {
    if (!dragging) return
    // Up = increase. Shift = fine (1/8 speed).
    const dy = stateRef.current.startY - e.clientY
    const scale = e.shiftKey ? spec.perPx / 8 : spec.perPx
    const next = clamp(stateRef.current.startVal + dy * scale)
    stateRef.current.latest = next
    onPreview(field, next)          // LOCAL only — no IPC during drag
  }, [dragging, clamp, spec, onPreview, field])

  const endDrag = useCallback((e) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
    onCommit(field, stateRef.current.latest)   // single commit on release
  }, [dragging, onCommit, field])

  // Double-click resets to the neutral value.
  const onDoubleClick = useCallback((e) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    const neutral = field === 'volume' ? 1 : 0
    onCommit(field, neutral)
  }, [disabled, field, onCommit])

  // Ring (amount) drag on the mod bar. Local preview throughout; one commit on
  // release, exactly like the value drag above.
  const onRingDown = useCallback((e) => {
    if (!mod?.active) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const startAmount = Number(mod.amount) || 0
    ringRef.current = { startY: e.clientY, startAmount, latest: startAmount }
  }, [mod])

  const onRingMove = useCallback((e) => {
    const r = ringRef.current
    if (!r) return
    e.stopPropagation()
    const dy = r.startY - e.clientY
    const sensitivity = e.shiftKey ? 10 : 1
    const next = Math.max(-1, Math.min(1, r.startAmount + (dy / 180) / sensitivity))
    r.latest = next
    mod?.onRingPreview?.(next)
  }, [mod])

  const onRingUp = useCallback((e) => {
    const r = ringRef.current
    if (!r) return
    e.stopPropagation()
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    ringRef.current = null
    mod?.onRingCommit?.(r.latest)
  }, [mod])

  const onContextMenu = useCallback((e) => {
    if (!mod?.active) return
    e.preventDefault()
    e.stopPropagation()
    mod.onToggleBipolar?.()
  }, [mod])

  const nonNeutral = field === 'volume'
    ? Math.abs(value - 1) > 0.005
    : Math.abs(value) > (spec.int ? 0.5 : 0.005)

  // The modulated range as a fraction of the mini's own span, so the bar sits
  // under exactly the values the route can reach.
  const norm = (v) => {
    const span = spec.max - spec.min
    return span > 0 ? Math.max(0, Math.min(1, (v - spec.min) / span)) : 0
  }
  const modLo = mod?.active ? norm(mod.ringLo) : 0
  const modHi = mod?.active ? norm(mod.ringHi) : 0

  const modClasses = mod
    ? `${mod.active ? ' is-modulated' : ''}${mod.highlight ? ' is-mod-hover' : ''}`
    : ''

  return (
    <div
      {...(mod?.dropProps || null)}
      style={mod?.active ? { '--mod-color': `var(${mod.colorVar})` } : undefined}
      className={`slot-mini${dragging ? ' is-dragging' : ''}${nonNeutral ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}${modClasses}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={mod?.active && mod.tooltip
        ? `${mod.tooltip}
Drag the bar = amount · Right-click = bipolar`
        : `${spec.label} — drag to adjust, shift for fine, double-click to reset`}
      role="slider"
      aria-label={spec.label}
      aria-valuenow={value}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={disabled ? -1 : 0}
    >
      <span className="slot-mini-label">{spec.label}</span>
      <span className="slot-mini-value">{formatMiniValue(field, value)}</span>
      {mod?.active && (
        <span
          className="slot-mini-mod"
          onPointerDown={onRingDown}
          onPointerMove={onRingMove}
          onPointerUp={onRingUp}
          onPointerCancel={onRingUp}
          aria-hidden
        >
          <span
            className="slot-mini-mod-fill"
            style={{ left: `${modLo * 100}%`, width: `${Math.max(0.5, (modHi - modLo) * 100)}%` }}
          />
        </span>
      )}
    </div>
  )
}

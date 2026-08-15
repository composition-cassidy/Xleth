import { useCallback, useRef } from 'react'

// ── Canonical continuous-control drag law ───────────────────────────────────
// The grab-relative vertical drag used by every FL-style continuous control
// in the app (the sampler Knob, the mixer VolumeFader): pointerdown captures
// startY/startValue, pointermove accumulates in NORMALISED 0..1 space over a
// FIXED pixel travel (dragRange) that does not scale with the control's
// value range, shift = fine (10x slower), Ctrl/Cmd+click = reset, wheel
// nudges the same normalised space, and only the release (or wheel step)
// commits across to the caller's persistence layer.
//
// Callers supply toNorm/fromNorm so their own curve — a JUCE-style skew for
// Knob, the dB taper for VolumeFader — applies uniformly; this module only
// owns the pixels-to-normalised-fraction accumulation and its edge cases.
//
// ── The rebase rule ──────────────────────────────────────────────────────
// The fine flag for a given pointermove is `shiftKey-now OR shiftKey-at-
// pointerdown` (so a drag started with shift held stays fine even if shift
// is released mid-drag — this matches the original Knob behavior). Whenever
// that EFFECTIVE fine state flips (plain drag → shift pressed, or a
// shift-released transition), the anchor (startY/startNorm) is rebased to
// the value the OLD sensitivity had just reached, then accumulation
// continues from there at the new ratio. Without this, the whole
// accumulated delta from the ORIGINAL startY gets divided/multiplied by 10
// on the toggle, snapping the value back toward wherever the drag began.

const clamp01 = (x) => Math.max(0, Math.min(1, x))

export function useDragLaw({
  value,
  toNorm,
  fromNorm,
  dragRange = 180,
  resetValue,
  onLiveChange,
  onCommit,
  axis = 'y',
  fineMultiplier = 10,
}) {
  // Refs so the returned handlers stay referentially stable across renders
  // while always reading the latest props/callbacks.
  const stateRef = useRef(null)
  stateRef.current = { value, toNorm, fromNorm, dragRange, resetValue, onLiveChange, onCommit, axis, fineMultiplier }

  const dragRef = useRef(null) // { startPos, startNorm, initialFine, activeFine }
  const liveValueRef = useRef(value)
  liveValueRef.current = value

  const resolveDragRange = () => {
    const dr = stateRef.current.dragRange
    return (typeof dr === 'function' ? dr() : dr) || 1
  }

  // axis 'y' (the default — knobs, vertical faders) reads clientY, where a
  // drag UP increases the value. axis 'x' (horizontal faders) reads clientX,
  // where a drag RIGHT increases the value.
  const readPos = (e) => (stateRef.current.axis === 'x' ? e.clientX : e.clientY)

  // Screen space is inverted relative to value space on the y axis (up = a
  // SMALLER clientY, but a LARGER value), so `startPos - pos` gives the
  // right sign there. On the x axis the two already agree (right = a
  // LARGER clientX AND a larger value), so that same subtraction needs to
  // be flipped or "drag right" would decrease the value.
  const dirSign = () => (stateRef.current.axis === 'x' ? -1 : 1)

  const onPointerDown = useCallback((e) => {
    const s = stateRef.current
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const resetTo = typeof s.resetValue === 'function' ? s.resetValue() : s.resetValue
      liveValueRef.current = resetTo
      s.onLiveChange?.(resetTo)
      s.onCommit?.(resetTo)
      return
    }
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    const startNorm = s.toNorm(s.value)
    dragRef.current = {
      startPos: readPos(e),
      startNorm,
      initialFine: e.shiftKey,
      activeFine: e.shiftKey,
    }
    document.body.style.cursor = s.axis === 'x' ? 'ew-resize' : 'ns-resize'
  }, [])

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const s = stateRef.current
    const dragRangePx = resolveDragRange()
    const fineRatio = s.fineMultiplier
    const pos = readPos(e)

    const sign = dirSign()
    const isFineNow = e.shiftKey || d.initialFine
    if (isFineNow !== d.activeFine) {
      // Rebase: freeze the value the OLD sensitivity had reached under the
      // OLD anchor, then restart accumulation from here at the new ratio.
      const delta = (d.startPos - pos) * sign
      const oldSensitivity = d.activeFine ? fineRatio : 1
      d.startNorm = clamp01(d.startNorm + (delta / dragRangePx) / oldSensitivity)
      d.startPos = pos
      d.activeFine = isFineNow
    }

    const delta = (d.startPos - pos) * sign
    const sensitivity = d.activeFine ? fineRatio : 1
    const nextNorm = clamp01(d.startNorm + (delta / dragRangePx) / sensitivity)
    const next = s.fromNorm(nextNorm)
    liveValueRef.current = next
    s.onLiveChange?.(next)
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.style.cursor = ''
    stateRef.current.onCommit?.(liveValueRef.current)
  }, [])

  const onWheel = useCallback((e) => {
    e.preventDefault()
    const s = stateRef.current
    const sensitivity = e.shiftKey ? 500 : 100
    const nextNorm = clamp01(s.toNorm(s.value) - (e.deltaY / sensitivity) / 20)
    const next = s.fromNorm(nextNorm)
    liveValueRef.current = next
    s.onLiveChange?.(next)
    s.onCommit?.(next)
  }, [])

  return {
    dragRef,
    isDragging: () => dragRef.current != null,
    isFine: () => !!dragRef.current?.activeFine,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onWheel,
  }
}

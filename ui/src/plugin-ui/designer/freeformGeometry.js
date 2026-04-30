// Designer-side geometry helpers for freeform node drag/resize/snap/nudge.
// All functions are pure (no side effects, no store access).
// Separate from runtime/freeformGeometry.js which only contains applyFrameStyle.

// ── Bounds ─────────────────────────────────────────────────────────────────────

export function getFrameBounds() {
  return {
    x:          { min: -2000, max: 4000 },
    y:          { min: -2000, max: 4000 },
    widthPx:    { min: 1,     max: 4096 },
    heightPx:   { min: 1,     max: 4096 },
    zIndex:     { min: 0,     max: 999  },
    rotationDeg:{ min: -360,  max: 360  },
  }
}

export function isFrameLocked(frame) {
  return !!frame?.locked
}

// ── Core helpers ──────────────────────────────────────────────────────────────

export function snapValue(value, gridPx, enabled) {
  if (!enabled || !gridPx || gridPx <= 1) return value
  // `|| 0` normalises -0 to 0 (Math.round can return -0 for small negatives).
  return (Math.round(value / gridPx) * gridPx) || 0
}

export function clampFrame(frame) {
  const f = { ...frame }
  f.x       = clamp(f.x       ?? 0, -2000, 4000)
  f.y       = clamp(f.y       ?? 0, -2000, 4000)
  f.widthPx = clamp(f.widthPx ?? 1, 1,     4096)
  f.heightPx= clamp(f.heightPx?? 1, 1,     4096)
  if ('zIndex'      in f) f.zIndex      = clamp(f.zIndex,      0,    999)
  if ('rotationDeg' in f) f.rotationDeg = clamp(f.rotationDeg, -360, 360)
  return f
}

// ── Drag ──────────────────────────────────────────────────────────────────────
//
// deltaXPx / deltaYPx are the TOTAL accumulated displacement from gesture start.
// `frame` is the ORIGINAL frame captured at gesture start.
//
// opts:
//   snapEnabled  boolean  default true
//   gridPx       number   default 8
//   bypassSnap   boolean  default false (Alt key)
//   constrainAxis 'horizontal'|'vertical'|null  (Shift key: lock to one axis)

export function dragFrame(frame, deltaXPx, deltaYPx, opts = {}) {
  const { snapEnabled = true, gridPx = 8, bypassSnap = false, constrainAxis = null } = opts
  const doSnap = snapEnabled && !bypassSnap

  let dx = Math.round(deltaXPx)
  let dy = Math.round(deltaYPx)

  if (constrainAxis === 'horizontal') dy = 0
  else if (constrainAxis === 'vertical') dx = 0

  const rawX = (frame.x ?? 0) + dx
  const rawY = (frame.y ?? 0) + dy

  return clampFrame({
    ...frame,
    x: doSnap ? snapValue(rawX, gridPx, true) : rawX,
    y: doSnap ? snapValue(rawY, gridPx, true) : rawY,
  })
}

// ── Resize ────────────────────────────────────────────────────────────────────
//
// handle: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'
// deltaXPx / deltaYPx are total accumulated displacement from gesture start.
// `frame` is the ORIGINAL frame at gesture start.
//
// For each moving edge, snap is applied to the NEW absolute position of that
// edge so the opposite edge stays exactly anchored.
//
// opts:
//   snapEnabled    boolean  default true
//   gridPx         number   default 8
//   bypassSnap     boolean  default false
//   preserveAspect boolean  default false (Shift + corner)

export function resizeFrame(frame, handle, deltaXPx, deltaYPx, opts = {}) {
  const { snapEnabled = true, gridPx = 8, bypassSnap = false, preserveAspect = false } = opts
  const doSnap = snapEnabled && !bypassSnap

  const ox = frame.x       ?? 0
  const oy = frame.y       ?? 0
  const ow = frame.widthPx ?? 1
  const oh = frame.heightPx?? 1

  const hasN = handle === 'n'  || handle === 'ne' || handle === 'nw'
  const hasS = handle === 's'  || handle === 'se' || handle === 'sw'
  const hasE = handle === 'e'  || handle === 'ne' || handle === 'se'
  const hasW = handle === 'w'  || handle === 'nw' || handle === 'sw'
  const isCorner = (hasN || hasS) && (hasE || hasW)

  // Absolute positions of each edge before this gesture's delta.
  let top    = oy
  let bottom = oy + oh
  let left   = ox
  let right  = ox + ow

  const dx = Math.round(deltaXPx)
  const dy = Math.round(deltaYPx)

  // Move the edges that belong to this handle.
  if (hasN) top    = oy + dy
  if (hasS) bottom = (oy + oh) + dy
  if (hasW) left   = ox + dx
  if (hasE) right  = (ox + ow) + dx

  // Snap the moving edge(s) to the grid.
  if (doSnap) {
    if (hasN) top    = snapValue(top,    gridPx, true)
    if (hasS) bottom = snapValue(bottom, gridPx, true)
    if (hasW) left   = snapValue(left,   gridPx, true)
    if (hasE) right  = snapValue(right,  gridPx, true)
  }

  // Derive new dimensions from the (possibly snapped) edge positions.
  let newX = hasW ? left : ox
  let newY = hasN ? top  : oy
  let newW = right - left
  let newH = bottom - top

  // Aspect-ratio preservation for corner drags (Shift held).
  if (preserveAspect && isCorner) {
    const aspect = ow / oh     // original width-to-height ratio
    const wScale = Math.abs(newW / ow - 1)
    const hScale = Math.abs(newH / oh - 1)

    if (wScale >= hScale) {
      // Width change dominates → derive height from width.
      const targetH = Math.max(1, Math.round(newW / aspect))
      newH = targetH
      if (hasN) newY = (oy + oh) - newH   // bottom stays anchored
    } else {
      // Height change dominates → derive width from height.
      const targetW = Math.max(1, Math.round(newH * aspect))
      newW = targetW
      if (hasW) newX = (ox + ow) - newW   // right stays anchored
    }
  }

  return clampFrame({ ...frame, x: newX, y: newY, widthPx: newW, heightPx: newH })
}

// ── Nudge ─────────────────────────────────────────────────────────────────────
//
// direction: 'left'|'right'|'up'|'down'
// opts:
//   shiftKey boolean  → nudge by 10 px
//   altKey   boolean  → nudge by gridPx (snap-step)
//   gridPx   number   default 8

export function nudgeFrame(frame, direction, opts = {}) {
  const { shiftKey = false, altKey = false, gridPx = 8 } = opts
  const amount = altKey ? gridPx : shiftKey ? 10 : 1

  const dx = direction === 'right' ? amount : direction === 'left'  ? -amount : 0
  const dy = direction === 'down'  ? amount : direction === 'up'    ? -amount : 0

  return clampFrame({
    ...frame,
    x: (frame.x ?? 0) + dx,
    y: (frame.y ?? 0) + dy,
  })
}

// ── Private ───────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// zprRectMath — Vegas Pan/Crop rect <-> ZprTracks canonical space.
//
// ── The rect is a CAMERA WINDOW OVER THE SOURCE ──────────────────────────
// Shrinking the rect zooms IN. This is the inverse of a zoom slider and it is
// intentional (Vegas muscle memory). There is exactly one model — no toggle.
// The numeric inspector's derived "2.18x" readout serves the other mental
// model and stays live-synced.
//
// ── Where the mapping comes from ─────────────────────────────────────────
// engine/src/render/shaders/FX_ZoomPanRotation.hlsl does, per output pixel:
//
//     uv -= 0.5
//     uv  = R(rot) * uv            R = [[c, -s], [s, c]]
//     uv /= zoom
//     uv -= float2(panX, panY)
//     uv += 0.5
//
// i.e. uv_src = 0.5 - pan + R(rot) * (uv_dst - 0.5) / zoom. Reading that as a
// window over the source:
//
//     window centre (source UV) = (0.5 - panX, 0.5 - panY)
//     window side  (source UV)  = 1 / zoom          (SAME on both axes)
//     window angle              = +rot, applied by R in UV space
//
// Two consequences that the rest of this module is built around:
//
//  1. The window is always a SQUARE IN UV. There is one zoom channel, so W and
//     H are not independent — exactly as ZprTracks documents ("Width and
//     height are deliberately absent"). On screen the window therefore always
//     displays at the CELL's aspect ratio, because the compositor stretches
//     the decoded source across the cell's [0,1]^2 (GridComposite.hlsl samples
//     localUV directly — no letterbox).
//
//  2. UV is y-DOWN, and R is applied in that y-down space, so a positive
//     rotationDeg turns the window CLOCKWISE on screen. Canvas 2D is also
//     y-down, so ctx.rotate(+rad) draws it correctly with no sign flip.
//
// ── panX/panY are NOT centerX/centerY ────────────────────────────────────
// TimelineTypes.h is explicit: they are UV OFFSETS and must not be renamed.
// The viewport works in centre coordinates and converts on the boundary —
// that conversion lives here and nowhere else.
//
// ── Rotation is NEVER wrapped ────────────────────────────────────────────
// createAngleAccumulator tracks the accumulated sweep across a whole gesture.
// Nothing in this file calls fmod / % / normalize on an angle in degrees.

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const TWO_PI = Math.PI * 2

// Window side length in source-UV units. 1/64 == 64x zoom in; 16 == 1/16x out.
// Matches the numeric inspector's own 0.01..64 zoom clamp from the other end.
export const MIN_RECT_SIDE = 1 / 64
export const MAX_RECT_SIDE = 16

export const clampSide = (w) =>
  Math.min(MAX_RECT_SIDE, Math.max(MIN_RECT_SIDE, Number.isFinite(w) ? w : 1))

// ── Canonical <-> rect ────────────────────────────────────────────────────

/** ZprTracks values at some t -> camera window, in source-UV space. */
export function canonicalToRect({ panX = 0, panY = 0, zoomLog2 = 0, rotationDeg = 0 } = {}) {
  const side = clampSide(Math.pow(2, -zoomLog2))
  return {
    cx: 0.5 - panX,
    cy: 0.5 - panY,
    w: side,
    h: side,
    rotDeg: rotationDeg,   // carried through unwrapped
  }
}

/** Camera window -> ZprTracks values. rotDeg passes through untouched. */
export function rectToCanonical({ cx = 0.5, cy = 0.5, w = 1, rotDeg = 0 } = {}) {
  const side = clampSide(w)
  return {
    panX: 0.5 - cx,
    panY: 0.5 - cy,
    zoomLog2: -Math.log2(side),
    rotationDeg: rotDeg,
  }
}

/** Linear zoom the inspector shows. Shrinking the window raises it. */
export const rectToLinearZoom = (w) => 1 / clampSide(w)

// ── Vector helpers (UV space, y-down, matching the shader's R) ─────────────

export function rotateVec(x, y, rad) {
  const c = Math.cos(rad), s = Math.sin(rad)
  return [x * c - y * s, x * s + y * c]
}

/** Inverse of rotateVec — takes a world offset into the rect's local frame. */
export function unrotateVec(x, y, rad) {
  return rotateVec(x, y, -rad)
}

// ── Handles ───────────────────────────────────────────────────────────────
// Local unit offsets from the rect centre, in half-extents. Corner handles
// always scale uniformly (the window has one size channel); edge handles are
// only live when aspect lock is OFF — see resizeFromEdge.

export const HANDLES = [
  { id: 'nw', ux: -1, uy: -1, kind: 'corner' },
  { id: 'ne', ux:  1, uy: -1, kind: 'corner' },
  { id: 'se', ux:  1, uy:  1, kind: 'corner' },
  { id: 'sw', ux: -1, uy:  1, kind: 'corner' },
  { id: 'n',  ux:  0, uy: -1, kind: 'edge'   },
  { id: 'e',  ux:  1, uy:  0, kind: 'edge'   },
  { id: 's',  ux:  0, uy:  1, kind: 'edge'   },
  { id: 'w',  ux: -1, uy:  0, kind: 'edge'   },
]

/** World-space (source-UV) position of one handle. */
export function handlePoint(rect, handle) {
  const rad = rect.rotDeg * RAD
  const [dx, dy] = rotateVec(handle.ux * rect.w * 0.5, handle.uy * rect.h * 0.5, rad)
  return { x: rect.cx + dx, y: rect.cy + dy }
}

/** All four corners, NW/NE/SE/SW, for stroking the rotated quad. */
export function rectCorners(rect) {
  return HANDLES.filter(h => h.kind === 'corner').map(h => handlePoint(rect, h))
}

/**
 * Rotation grip, sitting `stemUv` above the top edge in the rect's own frame.
 * The caller derives stemUv from a pixel distance so the grip keeps a constant
 * on-screen offset however far the window is zoomed in.
 */
export function rotationHandlePoint(rect, stemUv) {
  const rad = rect.rotDeg * RAD
  const [dx, dy] = rotateVec(0, -(rect.h * 0.5 + stemUv), rad)
  return { x: rect.cx + dx, y: rect.cy + dy }
}

// ── Drags ─────────────────────────────────────────────────────────────────

/** Whole-window move: the centre follows the pointer delta 1:1. */
export function moveRect(startRect, duvX, duvY) {
  return { ...startRect, cx: startRect.cx + duvX, cy: startRect.cy + duvY }
}

/**
 * Corner drag. The opposite corner is pinned; the window stays a UV square, so
 * the source aspect is preserved by construction (this is what "aspect lock"
 * guarantees, and it holds whether or not the toggle is on — the toggle only
 * governs whether edge handles are live).
 */
export function resizeFromCorner(startRect, handle, pointerX, pointerY) {
  const rad = startRect.rotDeg * RAD
  const anchor = handlePoint(startRect, {
    ...handle, ux: -handle.ux, uy: -handle.uy,
  })

  // Pointer offset from the pinned corner, expressed in the rect's own frame.
  const [lx, ly] = unrotateVec(pointerX - anchor.x, pointerY - anchor.y, rad)

  // One size for both axes. max() keeps the window under the cursor on the
  // axis the user is pulling hardest, which is what feels right when dragging
  // diagonally; min() would make the far corner lag behind the pointer.
  const side = clampSide(Math.max(Math.abs(lx), Math.abs(ly)))

  // Grow away from the anchor, on whichever side of it the pointer is. Falling
  // back to the handle's own direction keeps a degenerate zero-offset drag from
  // collapsing the rect onto the anchor.
  const sx = Math.sign(lx) || handle.ux
  const sy = Math.sign(ly) || handle.uy
  const [ax, ay] = rotateVec(sx * side * 0.5, sy * side * 0.5, rad)
  return { ...startRect, w: side, h: side, cx: anchor.x + ax, cy: anchor.y + ay }
}

/**
 * Edge drag — only reachable with aspect lock OFF.
 *
 * A real Vegas edge drag changes one dimension independently. That is not
 * representable here: zoomLog2 is the only size channel and storing W/H as
 * separate animated channels is explicitly out of bounds. So an edge drag does
 * the one thing a single size channel can express — it pins the OPPOSITE EDGE
 * and scales uniformly, which makes the window slide as it grows. The rect
 * still tracks the dragged edge under the cursor; the two edges parallel to
 * the drag axis move with it instead of staying put.
 */
export function resizeFromEdge(startRect, handle, pointerX, pointerY) {
  const rad = startRect.rotDeg * RAD
  const anchor = handlePoint(startRect, {
    ...handle, ux: -handle.ux, uy: -handle.uy,
  })

  const [lx, ly] = unrotateVec(pointerX - anchor.x, pointerY - anchor.y, rad)
  const along = handle.ux !== 0 ? lx : ly
  const side = clampSide(Math.abs(along))

  // The anchor is the opposite edge's MIDPOINT, so the perpendicular offset is
  // zero — the window slides along the drag axis only.
  const s = Math.sign(along) || (handle.ux || handle.uy)
  const sx = handle.ux !== 0 ? s : 0
  const sy = handle.uy !== 0 ? s : 0
  const [ax, ay] = rotateVec(sx * side * 0.5, sy * side * 0.5, rad)
  return { ...startRect, w: side, h: side, cx: anchor.x + ax, cy: anchor.y + ay }
}

/**
 * Rotate the window by `deltaDeg` about an arbitrary pivot.
 *
 * The shader always rotates about the cell centre, so a movable rotation
 * centre (Vegas' X Center / Y Center) is realized as rotation-about-centre
 * PLUS a compensating pan — which panX/panY express exactly. No new channel,
 * no evaluator change.
 *
 * deltaDeg is added, never wrapped.
 */
export function rotateRectAboutPivot(startRect, pivot, deltaDeg) {
  const rad = deltaDeg * RAD
  const [dx, dy] = rotateVec(startRect.cx - pivot.x, startRect.cy - pivot.y, rad)
  return {
    ...startRect,
    cx: pivot.x + dx,
    cy: pivot.y + dy,
    rotDeg: startRect.rotDeg + deltaDeg,
  }
}

// ── Unwrapped rotation accumulation ───────────────────────────────────────
//
// atan2 alone can only ever report an angle inside one turn, so deriving the
// stored value from it would snap 361 back to 1 the moment the pointer crosses
// the seam. Instead the gesture accumulates SHORT-ARC DELTAS between successive
// pointer samples: each step is well under pi, so the running total keeps
// climbing through 360, 540, 720 and reports the true sweep on release.

/** Angle of a vector in the rect's UV space. Radians, y-down, unbounded input. */
export const pointerAngle = (dx, dy) => Math.atan2(dy, dx)

/** Shortest signed delta from a to b, in (-pi, pi]. */
export function shortestArc(a, b) {
  let d = b - a
  while (d > Math.PI) d -= TWO_PI
  while (d < -Math.PI) d += TWO_PI
  return d
}

/**
 * Tracks one rotation gesture.
 *
 *   const acc = createAngleAccumulator(rawAngleAtMouseDown, rect.rotDeg)
 *   acc.update(rawAngleNow)   // -> absolute unwrapped degrees, may exceed 360
 *
 * `startDeg` is the CURRENT stored rotation, itself already unwrapped, so a
 * window sitting at 350 that gets dragged another 15 degrees reports 365.
 */
export function createAngleAccumulator(startRawRad, startDeg) {
  let prevRaw = startRawRad
  let sweepRad = 0
  return {
    update(rawRad) {
      sweepRad += shortestArc(prevRaw, rawRad)
      prevRaw = rawRad
      return startDeg + sweepRad * DEG
    },
    get sweepDeg() { return sweepRad * DEG },
    get currentDeg() { return startDeg + sweepRad * DEG },
  }
}

// ── Context-menu operations (Vegas parity) ────────────────────────────────

/** Restore — identity framing. */
export const opRestore = () => ({ cx: 0.5, cy: 0.5, w: 1, h: 1, rotDeg: 0 })

/** Center — re-centre the window, keeping its size and angle. */
export const opCenter = (rect) => ({ ...rect, cx: 0.5, cy: 0.5 })

/**
 * Flip Horizontal / Vertical.
 *
 * Vegas flips by negating the rect's width/height — a SIGNED scale, which this
 * effect has no channel for (see resizeFromEdge). What is expressible, and what
 * these do, is mirroring the FRAMING: the window's position reflects across the
 * cell's centre line and its rotation sense reverses, so a pan that crept right
 * now creeps left. The pixels themselves are not mirrored; per-cell pixel
 * mirroring is the separate flip-v2 `orientation` system (TrackFlipSection).
 */
export const opFlipHorizontal = (rect) => ({
  ...rect, cx: 1 - rect.cx, rotDeg: -rect.rotDeg,
})
export const opFlipVertical = (rect) => ({
  ...rect, cy: 1 - rect.cy, rotDeg: -rect.rotDeg,
})

/**
 * Match Output Aspect — the window becomes the whole cell, so its displayed
 * shape is the output cell's aspect exactly.
 */
export const opMatchOutputAspect = (rect) => ({ ...rect, w: 1, h: 1, cx: 0.5, cy: 0.5 })

/**
 * Match Source Aspect — zoom so the window covers the region a correctly
 * letterboxed source would occupy inside the cell, cropping away the bars the
 * compositor's stretch-to-fill would otherwise show as distortion.
 *
 * Uniform zoom cannot UNDO a non-uniform stretch (again: one size channel), so
 * this crops to the matching band rather than rescaling the axes. When the cell
 * and source already share an aspect it collapses to Match Output Aspect,
 * which is the right answer — there is nothing to correct.
 */
export function opMatchSourceAspect(rect, cellAspect, sourceAspect) {
  const ca = Number.isFinite(cellAspect) && cellAspect > 0 ? cellAspect : 1
  const sa = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : ca
  const ratio = Math.max(ca / sa, sa / ca)
  return { ...rect, w: clampSide(1 / ratio), h: clampSide(1 / ratio), cx: 0.5, cy: 0.5 }
}

// ── Motion path ───────────────────────────────────────────────────────────

/**
 * Sample the interpolated window centre across the whole animation window.
 *
 * `evaluate` is injected so this stays pure: the caller passes
 * zprCurveMath.evaluateTrack, which mirrors ParamTrack.cpp::evaluate exactly
 * (that mirror is why it exists — see its header). The path has to redraw on
 * every pointer move during a drag, and the brief forbids IPC there, so it is
 * evaluated locally rather than round-tripped to the engine per sample.
 */
export function sampleMotionPath(tracks, evaluate, steps = 96) {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    pts.push({
      t,
      x: 0.5 - evaluate(tracks.panX, t),
      y: 0.5 - evaluate(tracks.panY, t),
    })
  }
  return pts
}

/** Window-centre positions at every keyframe t on either position channel. */
export function motionPathKeyPoints(tracks, evaluate) {
  const ts = new Set()
  for (const ch of ['panX', 'panY']) {
    for (const k of (tracks?.[ch]?.keys || [])) ts.add(k.t)
  }
  return [...ts].sort((a, b) => a - b).map(t => ({
    t,
    x: 0.5 - evaluate(tracks.panX, t),
    y: 0.5 - evaluate(tracks.panY, t),
  }))
}

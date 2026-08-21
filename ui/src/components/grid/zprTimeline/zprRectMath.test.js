import { describe, expect, it } from 'vitest'
import {
  canonicalToRect, rectToCanonical, rectToLinearZoom,
  handlePoint, rectCorners, rotateVec,
  moveRect, resizeFromCorner, resizeFromEdge, rotateRectAboutPivot,
  createAngleAccumulator, pointerAngle, shortestArc,
  opRestore, opCenter, opFlipHorizontal, opFlipVertical,
  opMatchOutputAspect, opMatchSourceAspect,
  sampleMotionPath, motionPathKeyPoints,
  HANDLES, MIN_RECT_SIDE, MAX_RECT_SIDE,
} from './zprRectMath.js'
import { evaluateTrack } from './zprCurveMath.js'

const near = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('canonical <-> rect', () => {
  it('identity canonical is the full cell', () => {
    const r = canonicalToRect({ panX: 0, panY: 0, zoomLog2: 0, rotationDeg: 0 })
    expect(r).toMatchObject({ cx: 0.5, cy: 0.5, w: 1, h: 1, rotDeg: 0 })
  })

  it('shrinking the rect zooms IN (Vegas semantics, not a zoom slider)', () => {
    // A window half as wide is 2x magnification.
    const c = rectToCanonical({ cx: 0.5, cy: 0.5, w: 0.5, rotDeg: 0 })
    near(c.zoomLog2, 1)
    near(Math.pow(2, c.zoomLog2), 2)
    near(rectToLinearZoom(0.5), 2)

    const c4 = rectToCanonical({ cx: 0.5, cy: 0.5, w: 0.25, rotDeg: 0 })
    near(Math.pow(2, c4.zoomLog2), 4)
  })

  it('window centre maps to 0.5 - pan, matching the shader', () => {
    // FX_ZoomPanRotation.hlsl: uv_src = 0.5 - pan + R*(uv_dst - 0.5)/zoom,
    // so at the output centre the source sampled is 0.5 - pan.
    const c = rectToCanonical({ cx: 0.3, cy: 0.8, w: 1, rotDeg: 0 })
    near(c.panX, 0.2)
    near(c.panY, -0.3)
    const back = canonicalToRect(c)
    near(back.cx, 0.3)
    near(back.cy, 0.8)
  })

  it('round-trips every channel', () => {
    const src = { panX: -0.37, panY: 0.11, zoomLog2: 1.7, rotationDeg: 412.5 }
    const out = rectToCanonical(canonicalToRect(src))
    near(out.panX, src.panX, 1e-12)
    near(out.panY, src.panY, 1e-12)
    near(out.zoomLog2, src.zoomLog2, 1e-12)
    near(out.rotationDeg, src.rotationDeg, 1e-12)
  })

  it('clamps the window side without ever wrapping rotation', () => {
    const tiny = rectToCanonical({ cx: 0.5, cy: 0.5, w: 1e-9, rotDeg: 3000 })
    near(Math.pow(2, -tiny.zoomLog2), MIN_RECT_SIDE)
    expect(tiny.rotationDeg).toBe(3000)

    const huge = rectToCanonical({ cx: 0.5, cy: 0.5, w: 1e9, rotDeg: -3000 })
    near(Math.pow(2, -huge.zoomLog2), MAX_RECT_SIDE)
    expect(huge.rotationDeg).toBe(-3000)
  })
})

describe('rect geometry', () => {
  it('rotation runs clockwise in UV, matching R = [[c,-s],[s,c]] in y-down space', () => {
    const [x, y] = rotateVec(1, 0, Math.PI / 2)
    near(x, 0, 1e-12)
    near(y, 1, 1e-12)   // +x turns toward +y (down) => clockwise on screen
  })

  it('an unrotated rect has axis-aligned corners', () => {
    const c = rectCorners({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, rotDeg: 0 })
    near(c[0].x, 0.3); near(c[0].y, 0.3)   // NW
    near(c[2].x, 0.7); near(c[2].y, 0.7)   // SE
  })

  it('handles sit on the rect after a 90 degree turn', () => {
    const r = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, rotDeg: 90 }
    const e = handlePoint(r, HANDLES.find(h => h.id === 'e'))
    near(e.x, 0.5, 1e-9)
    near(e.y, 0.7, 1e-9)
  })
})

describe('drags', () => {
  it('move translates the centre 1:1 and leaves size and angle alone', () => {
    const start = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, rotDeg: 33 }
    const out = moveRect(start, 0.1, -0.2)
    near(out.cx, 0.6); near(out.cy, 0.3)
    expect(out.w).toBe(0.4)
    expect(out.rotDeg).toBe(33)
  })

  it('aspect-locked corner drag pins the opposite corner and stays a UV square', () => {
    // SE handle dragged to (0.9, 0.9) with NW pinned at (0.3, 0.3).
    const start = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, rotDeg: 0 }
    const se = HANDLES.find(h => h.id === 'se')
    const out = resizeFromCorner(start, se, 0.9, 0.9)

    expect(out.w).toBe(out.h)                 // source ratio preserved
    near(out.w, 0.6)
    const corners = rectCorners(out)
    near(corners[0].x, 0.3, 1e-9)             // NW stayed put
    near(corners[0].y, 0.3, 1e-9)
  })

  it('the derived zoom readout matches the rect area change', () => {
    const start = { cx: 0.5, cy: 0.5, w: 1, h: 1, rotDeg: 0 }
    const se = HANDLES.find(h => h.id === 'se')
    // NW pinned at (0, 0); drag SE to (0.5, 0.5) => window side halves.
    const out = resizeFromCorner(start, se, 0.5, 0.5)
    near(out.w, 0.5)

    const zoom = rectToLinearZoom(out.w)
    near(zoom, 2)
    // Area shrank 4x; a uniform window means zoom = sqrt(areaRatio).
    const areaRatio = (start.w * start.h) / (out.w * out.h)
    near(zoom, Math.sqrt(areaRatio), 1e-9)
  })

  it('edge drag pins the opposite edge (the only thing one zoom channel can do)', () => {
    const start = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, rotDeg: 0 }
    const east = HANDLES.find(h => h.id === 'e')
    const out = resizeFromEdge(start, east, 0.8, 0.5)
    near(out.w, 0.5)
    expect(out.w).toBe(out.h)
    const corners = rectCorners(out)
    near(corners[0].x, 0.3, 1e-9)   // west edge held
  })
})

describe('rotation is accumulated unwrapped', () => {
  it('shortestArc never returns more than half a turn', () => {
    near(shortestArc(0.1, 0.2), 0.1, 1e-12)
    near(shortestArc(3.0, -3.0), 2 * Math.PI - 6.0, 1e-12)
    expect(Math.abs(shortestArc(0, Math.PI - 1e-9))).toBeLessThanOrEqual(Math.PI)
  })

  it('dragging a full turn past 360 continues to 361, 362 — never wraps to 1', () => {
    const pivot = { x: 0.5, y: 0.5 }
    const start = { cx: 0.5, cy: 0.3, w: 0.4, h: 0.4, rotDeg: 0 }

    // Simulate a pointer sweeping 362 degrees in 2-degree steps. atan2 alone
    // would report ~2 degrees at the end; the accumulator must report 362.
    const a0 = pointerAngle(0.4, 0)
    const acc = createAngleAccumulator(a0, start.rotDeg)
    let abs = start.rotDeg
    for (let deg = 2; deg <= 362; deg += 2) {
      const rad = (deg * Math.PI) / 180
      abs = acc.update(pointerAngle(0.4 * Math.cos(rad), 0.4 * Math.sin(rad)))
    }

    expect(abs).toBeGreaterThan(360)
    near(abs, 362, 1e-6)
    near(acc.sweepDeg, 362, 1e-6)

    const out = rotateRectAboutPivot(start, pivot, abs - start.rotDeg)
    expect(out.rotDeg).toBeGreaterThan(360)
    near(out.rotDeg, 362, 1e-6)

    // And the stored canonical value keeps that magnitude.
    expect(rectToCanonical(out).rotationDeg).toBeGreaterThan(360)
  })

  it('continues past a second turn from an already-unwrapped start', () => {
    const acc = createAngleAccumulator(0, 350)
    let abs = 350
    for (let deg = 5; deg <= 720; deg += 5) {
      abs = acc.update((deg * Math.PI) / 180)
    }
    near(abs, 1070, 1e-6)   // 350 + 720, not 350 + 0
  })

  it('rotating about an off-centre pivot moves the window centre too', () => {
    // Rotation about an arbitrary pivot = rotation about centre + a pan, which
    // is exactly why the pin needs no new channel.
    const start = { cx: 0.5, cy: 0.2, w: 0.4, h: 0.4, rotDeg: 0 }
    const out = rotateRectAboutPivot(start, { x: 0.5, y: 0.5 }, 180)
    near(out.cx, 0.5, 1e-9)
    near(out.cy, 0.8, 1e-9)
    near(out.rotDeg, 180, 1e-9)
  })
})

describe('context-menu operations', () => {
  const r = { cx: 0.3, cy: 0.7, w: 0.4, h: 0.4, rotDeg: 40 }

  it('Restore returns the identity framing', () => {
    expect(opRestore()).toMatchObject({ cx: 0.5, cy: 0.5, w: 1, h: 1, rotDeg: 0 })
  })

  it('Center keeps size and angle', () => {
    const o = opCenter(r)
    expect(o).toMatchObject({ cx: 0.5, cy: 0.5, w: 0.4, rotDeg: 40 })
  })

  it('Flip mirrors the framing and reverses the rotation sense', () => {
    const h = opFlipHorizontal(r)
    near(h.cx, 0.7); near(h.cy, 0.7); near(h.rotDeg, -40)
    const v = opFlipVertical(r)
    near(v.cx, 0.3); near(v.cy, 0.3); near(v.rotDeg, -40)
  })

  it('Match Output Aspect fills the cell', () => {
    expect(opMatchOutputAspect(r)).toMatchObject({ cx: 0.5, cy: 0.5, w: 1, h: 1 })
  })

  it('Match Source Aspect is a no-op when cell and source already agree', () => {
    const o = opMatchSourceAspect(r, 16 / 9, 16 / 9)
    near(o.w, 1, 1e-12)
  })

  it('Match Source Aspect crops to the letterboxed band otherwise', () => {
    const o = opMatchSourceAspect(r, 1, 16 / 9)          // 16:9 source in a square cell
    near(o.w, 9 / 16, 1e-12)
    expect(o.w).toBe(o.h)
  })
})

describe('motion path', () => {
  const tracks = {
    panX: { constantValue: 0, keys: [
      { t: 0, v: 0 }, { t: 0.5, v: -0.25 }, { t: 1, v: 0 },
    ] },
    panY: { constantValue: 0, keys: [] },
    zoomLog2: { constantValue: 0, keys: [] },
    rotationDeg: { constantValue: 0, keys: [] },
  }

  it('samples window centres, not raw pan offsets', () => {
    const pts = sampleMotionPath(tracks, evaluateTrack, 4)
    expect(pts).toHaveLength(5)
    near(pts[0].x, 0.5)          // pan 0    -> centre 0.5
    near(pts[2].x, 0.75)         // pan -.25 -> centre 0.75
    for (const p of pts) near(p.y, 0.5)
  })

  it('marks a point at every position keyframe', () => {
    const keys = motionPathKeyPoints(tracks, evaluateTrack)
    expect(keys.map(k => k.t)).toEqual([0, 0.5, 1])
    near(keys[1].x, 0.75)
  })
})

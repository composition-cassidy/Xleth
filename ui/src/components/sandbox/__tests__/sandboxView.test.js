import { describe, expect, it } from 'vitest'
import {
  MIN_VIEW_SAMPLES, resolveView, viewSpan, isFitted, sampleToX, xToSample,
  samplesPerPixel, zoomView, zoomViewByWheel, panView, panViewByFraction,
  zoomToRange, scrollViewToInclude,
} from '../sandboxView.js'

// The viewport is the load-bearing new piece: every px↔sample conversion in
// the panel goes through it, so a rounding or clamping mistake here is a
// mis-placed cut, not a cosmetic glitch. These are the invariants the canvas
// and the overview strip both depend on.

const N = 48000 // one second at 48k

describe('resolveView', () => {
  it('treats null as fit', () => {
    expect(resolveView(null, N)).toEqual({ startSample: 0, endSample: N })
  })

  it('clamps a view that outlived a buffer shrink', () => {
    // An op that trims the buffer leaves the stored view pointing past the
    // end. It must come back in-bounds rather than producing negative widths.
    const v = resolveView({ startSample: 40000, endSample: 90000 }, N)
    expect(v.startSample).toBeGreaterThanOrEqual(0)
    expect(v.endSample).toBeLessThanOrEqual(N)
    expect(v.endSample).toBeGreaterThan(v.startSample)
  })

  it('grows a collapsed view back to the zoom floor instead of snapping to fit', () => {
    // Zoomed in, then the buffer shrank under it — the user was looking
    // closely, and fit would throw that away.
    const v = resolveView({ startSample: 1000, endSample: 1001 }, N)
    expect(v.endSample - v.startSample).toBe(MIN_VIEW_SAMPLES)
  })

  it('shows a buffer shorter than the zoom floor whole', () => {
    expect(resolveView({ startSample: 2, endSample: 4 }, 10)).toEqual({ startSample: 0, endSample: 10 })
  })

  it('survives an empty buffer', () => {
    expect(resolveView({ startSample: 5, endSample: 9 }, 0)).toEqual({ startSample: 0, endSample: 0 })
  })
})

describe('conversions', () => {
  it('round-trips a sample through x and back', () => {
    const v = resolveView({ startSample: 12000, endSample: 24000 }, N)
    const x = sampleToX(18000, v, 600)
    expect(xToSample(x, v, 600, N)).toBe(18000)
  })

  it('maps the view edges to the canvas edges', () => {
    const v = resolveView({ startSample: 1000, endSample: 5000 }, N)
    expect(sampleToX(1000, v, 800)).toBe(0)
    expect(sampleToX(5000, v, 800)).toBe(800)
  })

  it('draws off-canvas rather than clamping, for content outside the window', () => {
    // An envelope handle or a paint dab outside the visible range must fall
    // off the edge; clamping it would draw content where there is none.
    const v = resolveView({ startSample: 1000, endSample: 2000 }, N)
    expect(sampleToX(500, v, 100)).toBeLessThan(0)
    expect(sampleToX(3000, v, 100)).toBeGreaterThan(100)
  })

  it('clamps a pointer past the canvas edge to the BUFFER, not the view', () => {
    const v = resolveView({ startSample: 0, endSample: 1000 }, N)
    expect(xToSample(-50, v, 100, N)).toBe(0)
    expect(xToSample(1e6, v, 100, N)).toBe(N)
  })

  it('reports samples per pixel', () => {
    const v = resolveView({ startSample: 0, endSample: 1000 }, N)
    expect(samplesPerPixel(v, 100)).toBe(10)
  })
})

describe('zoomView', () => {
  it('keeps the anchor sample under the same fraction of the width', () => {
    const before = resolveView({ startSample: 0, endSample: 40000 }, N)
    const anchorSample = before.startSample + viewSpan(before) * 0.25
    const after = resolveView(zoomView(before, N, 0.5, 0.25), N)
    const afterAnchor = after.startSample + viewSpan(after) * 0.25
    expect(afterAnchor).toBeCloseTo(anchorSample, 0)
  })

  it('returns null (fit) once the span covers the whole buffer', () => {
    expect(zoomView({ startSample: 0, endSample: 40000 }, N, 10)).toBeNull()
  })

  it('never zooms past the floor', () => {
    let v = { startSample: 0, endSample: 1000 }
    for (let i = 0; i < 20; i++) v = zoomView(v, N, 0.5, 0.5) ?? v
    expect(viewSpan(resolveView(v, N))).toBeGreaterThanOrEqual(MIN_VIEW_SAMPLES)
  })

  it('stays inside the buffer when the anchor is at an edge', () => {
    const v = resolveView(zoomView({ startSample: 0, endSample: 4000 }, N, 2, 0), N)
    expect(v.startSample).toBe(0)
    const w = resolveView(zoomView({ startSample: N - 4000, endSample: N }, N, 2, 1), N)
    expect(w.endSample).toBe(N)
  })

  it('zooms OUT on a positive wheel delta, matching the timeline', () => {
    const start = { startSample: 20000, endSample: 24000 }
    const out = resolveView(zoomViewByWheel(start, N, 100, 0.5), N)
    const inn = resolveView(zoomViewByWheel(start, N, -100, 0.5), N)
    expect(viewSpan(out)).toBeGreaterThan(4000)
    expect(viewSpan(inn)).toBeLessThan(4000)
  })
})

describe('panView', () => {
  it('slides without changing the span', () => {
    const v = resolveView(panView({ startSample: 1000, endSample: 5000 }, N, 500), N)
    expect(v).toEqual({ startSample: 1500, endSample: 5500 })
  })

  it('stops at the buffer edges', () => {
    expect(resolveView(panView({ startSample: 0, endSample: 4000 }, N, -9999), N).startSample).toBe(0)
    expect(resolveView(panView({ startSample: N - 4000, endSample: N }, N, 9999), N).endSample).toBe(N)
  })

  it('is a no-op on a fitted view', () => {
    expect(panView(null, N, 1000)).toBeNull()
    expect(panViewByFraction(null, N, 0.5)).toBeNull()
  })
})

describe('zoomToRange', () => {
  it('frames the range with padding either side', () => {
    const v = resolveView(zoomToRange(20000, 24000, N), N)
    expect(v.startSample).toBeLessThan(20000)
    expect(v.endSample).toBeGreaterThan(24000)
  })

  it('frames the zoom floor around a bare cursor', () => {
    // "Zoom to selection" with only a cursor must still do something — that is
    // the commonest state to press it in.
    const v = resolveView(zoomToRange(20000, 20000, N), N)
    expect(viewSpan(v)).toBeGreaterThanOrEqual(MIN_VIEW_SAMPLES)
    expect(v.startSample).toBeLessThan(20000)
    expect(v.endSample).toBeGreaterThan(20000)
  })

  it('fits when the padded range covers the buffer', () => {
    expect(zoomToRange(0, N, N)).toBeNull()
  })
})

describe('scrollViewToInclude', () => {
  it('leaves the view alone while the sample is comfortably inside', () => {
    const view = { startSample: 10000, endSample: 20000 }
    // Identity, not merely equality — the playhead loop uses `next !== cur` to
    // decide whether to write to the store, so a fresh object every frame
    // would be a store write per frame.
    expect(scrollViewToInclude(view, N, 15000)).toBe(view)
  })

  it('re-centres once the sample reaches the edge margin', () => {
    const v = resolveView(scrollViewToInclude({ startSample: 10000, endSample: 20000 }, N, 19900), N)
    expect(v.startSample).toBeGreaterThan(10000)
    expect(viewSpan(v)).toBe(10000)
  })

  it('does nothing for a fitted view', () => {
    expect(scrollViewToInclude(null, N, 100)).toBeNull()
  })
})

describe('isFitted', () => {
  it('is true for null and for a full-span view', () => {
    expect(isFitted(null, N)).toBe(true)
    expect(isFitted({ startSample: 0, endSample: N }, N)).toBe(true)
    expect(isFitted({ startSample: 100, endSample: N }, N)).toBe(false)
  })
})

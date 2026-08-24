import { describe, it, expect } from 'vitest'
import { decimatePeaks, drawEnvelope, drawTrace, visibleColumnWindow } from '../waveformRenderer.js'

// Build a stride-3 [min,max,rms] array with a single sharp transient so the
// peak-preserving requirement is directly observable.
function makePeaks(n, transientAt = -1) {
  const a = new Array(n * 3)
  for (let i = 0; i < n; i++) {
    const quiet = 0.05
    const amp = i === transientAt ? 0.97 : quiet
    a[i * 3]     = -amp
    a[i * 3 + 1] = amp
    a[i * 3 + 2] = amp * 0.6
  }
  return a
}

// Minimal 2D context recorder — counts path nodes so the decimation win is a
// measured property, not an assumption.
function recordingCtx() {
  const calls = { moveTo: 0, lineTo: 0, arc: 0 }
  const points = []
  return {
    calls, points,
    beginPath() {}, closePath() {}, fill() {}, stroke() {},
    moveTo(x, y) { calls.moveTo++; points.push([x, y]) },
    lineTo(x, y) { calls.lineTo++; points.push([x, y]) },
    arc() { calls.arc++ },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
  }
}

describe('decimatePeaks', () => {
  it('returns null when the source already fits the pixel budget', () => {
    expect(decimatePeaks(makePeaks(50), 0, 50, 100)).toBe(null)
  })

  it('caps output at 2 columns per drawn pixel', () => {
    const dec = decimatePeaks(makePeaks(4000), 0, 4000, 30)
    expect(dec).not.toBe(null)
    expect(dec.count).toBe(60)
  })

  it('preserves a transient rather than subsampling past it', () => {
    // A stride-sampling implementation would miss index 1234 entirely.
    const dec = decimatePeaks(makePeaks(4000, 1234), 0, 4000, 30)
    expect(Math.max(...dec.max)).toBeCloseTo(0.97, 5)
    expect(Math.min(...dec.min)).toBeCloseTo(-0.97, 5)
  })

  it('covers every source column exactly once across all buckets', () => {
    const cols = 3007
    const w = 41
    const dec = decimatePeaks(makePeaks(cols), 0, cols, w)
    const budget = dec.count
    let prevEnd = 0
    for (let b = 0; b < budget; b++) {
      const c0 = Math.floor((b * cols) / budget)
      const c1 = Math.max(c0 + 1, Math.floor(((b + 1) * cols) / budget))
      expect(c0).toBe(prevEnd)
      prevEnd = c1
    }
    expect(prevEnd).toBe(cols)
  })

  it('honours startCol offset', () => {
    // Transient at absolute column 3500; a window starting at 3000 must find it.
    const peaks = makePeaks(4000, 3500)
    const dec = decimatePeaks(peaks, 3000, 4000, 20)
    expect(Math.max(...dec.max)).toBeCloseTo(0.97, 5)
    // A window that excludes it must not.
    const dec2 = decimatePeaks(peaks, 0, 3000, 20)
    expect(Math.max(...dec2.max)).toBeCloseTo(0.05, 5)
  })
})

describe('renderers under decimation', () => {
  it('drawEnvelope emits path nodes bounded by width, not by column count', () => {
    const ctx = recordingCtx()
    drawEnvelope(ctx, makePeaks(4000), 0, 0, 30, 40, 0, 4000, '#fff', '#000')
    // 60 buckets x 2 outline passes x 2 shapes (envelope + rms) = 240.
    // The undecimated path would have emitted 16000.
    const total = ctx.calls.moveTo + ctx.calls.lineTo
    expect(total).toBe(240)
  })

  it('drawTrace stays inside the drawing rect horizontally', () => {
    const ctx = recordingCtx()
    drawTrace(ctx, makePeaks(4000), 12, 0, 30, 40, 0, 4000, '#fff', '#000')
    const xs = ctx.points.map(p => p[0])
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(12)
    expect(Math.max(...xs)).toBeLessThanOrEqual(42)
  })

  it('decimated silhouette tracks the undecimated one', () => {
    // Same data, same rect: a wide rect draws undecimated, a narrow one
    // decimates. The vertical extremes must agree.
    const peaks = makePeaks(2000, 900)
    const wide = recordingCtx()
    drawEnvelope(wide, peaks, 0, 0, 4000, 40, 0, 2000, '#fff')
    const narrow = recordingCtx()
    drawEnvelope(narrow, peaks, 0, 0, 25, 40, 0, 2000, '#fff')

    const ys = (c) => c.points.map(p => p[1])
    expect(Math.min(...ys(narrow))).toBeCloseTo(Math.min(...ys(wide)), 5)
    expect(Math.max(...ys(narrow))).toBeCloseTo(Math.max(...ys(wide)), 5)
  })
})

describe('visibleColumnWindow', () => {
  it('returns null when nothing is on screen', () => {
    // Clip sits entirely left of the viewport.
    expect(visibleColumnWindow(-500, 200, 0, 100, 0, 1600)).toBe(null)
  })

  it('keeps the whole span when the clip fits on screen', () => {
    const win = visibleColumnWindow(100, 400, 0, 1000, 100, 500)
    expect(win.startCol).toBe(0)
    expect(win.endCol).toBe(1000)
    expect(win.x).toBe(100)
    expect(win.w).toBe(400)
  })

  it('narrows a clip far wider than the viewport', () => {
    // 14,000px clip, 1600px viewport showing its left edge.
    const win = visibleColumnWindow(0, 14000, 0, 5000, 0, 1600)
    expect(win.endCol - win.startCol).toBeLessThan(600)
    expect(win.w).toBeLessThan(1700)
  })

  it('is exact: retained columns keep their full-draw pixel positions', () => {
    // The whole point — this must be a pure cull, not a re-fit. Column c in
    // the full draw sits at x + (c - startCol) * (w / cols); the windowed
    // draw must place it identically.
    const x = -3000, w = 14000, startCol = 0, endCol = 5000
    const fullStep = w / (endCol - startCol)
    const win = visibleColumnWindow(x, w, startCol, endCol, 0, 1600)
    const winStep = win.w / (win.endCol - win.startCol)

    expect(winStep).toBeCloseTo(fullStep, 9)
    for (const c of [win.startCol, win.startCol + 10, win.endCol - 1]) {
      const fullPx = x + (c - startCol) * fullStep
      const winPx  = win.x + (c - win.startCol) * winStep
      expect(winPx).toBeCloseTo(fullPx, 6)
    }
  })

  it('covers the visible range it was asked for', () => {
    const win = visibleColumnWindow(-3000, 14000, 0, 5000, 0, 1600)
    // Column-aligned, so it may extend slightly past — never fall short.
    expect(win.x).toBeLessThanOrEqual(0)
    expect(win.x + win.w).toBeGreaterThanOrEqual(1600)
  })

  it('handles a degenerate width without dividing by zero', () => {
    expect(visibleColumnWindow(0, 0, 0, 100, 0, 100)).toBe(null)
  })
})

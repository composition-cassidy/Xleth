import { describe, it, expect } from 'vitest'
import { hiResCoversWindow } from '../hiResCoverage.js'

describe('hiResCoversWindow', () => {
  it('accepts an exact match', () => {
    expect(hiResCoversWindow(10, 15, 10, 15)).toBe(true)
  })

  it('accepts a cache window strictly wider than the request', () => {
    expect(hiResCoversWindow(5, 20, 10, 15)).toBe(true)
  })

  it('rejects a cache window that starts too late', () => {
    expect(hiResCoversWindow(12, 20, 10, 15)).toBe(false)
  })

  it('rejects a cache window that ends too early', () => {
    expect(hiResCoversWindow(5, 13, 10, 15)).toBe(false)
  })

  it('rejects total non-overlap', () => {
    expect(hiResCoversWindow(0, 5, 10, 15)).toBe(false)
  })

  it('rejects the exact partial-overlap scenario that caused the stretch bug', () => {
    // Cache covers sec 10-15 (fetched for the pre-pan view). The view has
    // since panned to want sec 12-17. The cache still has SOME of that
    // range, but not all of it — this must be rejected, not accepted with
    // clamped columns stretched across the full 12-17 pixel span.
    expect(hiResCoversWindow(10, 15, 12, 17)).toBe(false)
  })

  it('tolerates float noise within the epsilon', () => {
    expect(hiResCoversWindow(10 - 1e-4, 15 + 1e-4, 10, 15)).toBe(true)
    expect(hiResCoversWindow(10.0000001, 15, 10, 15)).toBe(true)
  })

  it('does not tolerate a gap past the epsilon', () => {
    expect(hiResCoversWindow(10.01, 15, 10, 15)).toBe(false)
    expect(hiResCoversWindow(10, 14.99, 10, 15)).toBe(false)
  })
})

describe('regression: stretch bug reproduced against the old vs new logic', () => {
  // Same inputs the real draw path computes: a cache window [cacheStart,
  // cacheEnd] and a currently-requested visible window [visStart, visEnd]
  // that has drifted from it (mid-pan, before the 80ms refetch lands).
  function oldBehaviour(cacheStart, cacheEnd, visStart, visEnd, totalCols, viewportPxWidth) {
    const hiDur = cacheEnd - cacheStart
    const f0 = Math.max(0, (visStart - cacheStart) / hiDur)
    const f1 = Math.min(1, (visEnd - cacheStart) / hiDur)
    const startCol = Math.floor(f0 * totalCols)
    const endCol = Math.min(totalCols, Math.ceil(f1 * totalCols))
    if (endCol <= startCol) return null
    // The bug: these columns are drawn across the FULL requested viewport
    // width, regardless of how much time they actually span.
    const colsSpanSec = ((endCol - startCol) / totalCols) * hiDur
    const requestedSpanSec = visEnd - visStart
    return { colsSpanSec, requestedSpanSec, drawnPxWidth: viewportPxWidth }
  }

  it('old logic drew fewer seconds of data stretched to the full requested width', () => {
    const r = oldBehaviour(10, 15, 12, 17, 1000, 500)
    expect(r).not.toBe(null)
    // The data drawn represents only 3 of the 5 requested seconds...
    expect(r.colsSpanSec).toBeCloseTo(3, 5)
    expect(r.requestedSpanSec).toBeCloseTo(5, 5)
    // ...yet the old code stretched it across all 500px meant for 5 seconds.
    // A correct draw would use only 500 * (3/5) = 300px for that data.
    const correctPxWidth = r.drawnPxWidth * (r.colsSpanSec / r.requestedSpanSec)
    expect(correctPxWidth).toBeCloseTo(300, 5)
    expect(r.drawnPxWidth).not.toBeCloseTo(correctPxWidth, 5) // the distortion
  })

  it('new logic refuses to draw the same scenario at all (falls back to low-res instead)', () => {
    expect(hiResCoversWindow(10, 15, 12, 17)).toBe(false)
  })

  it('new logic still draws when the pan stays within the cached window', () => {
    // A small pan that the cache still fully covers must keep drawing hi-res
    // — the fix must not make the timeline flicker to low-res on every pan,
    // only on the ones that actually outrun the cache.
    expect(hiResCoversWindow(10, 20, 12, 17)).toBe(true)
  })
})

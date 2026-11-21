import { describe, it, expect } from 'vitest'
import {
  padClipWindow, prioritiseProcessedJobs, shouldRetryNotReady, pruneNotReady,
} from '../hiResProcessedPlanner.js'
import { hiResCoversWindow } from '../hiResCoverage.js'

describe('padClipWindow', () => {
  it('pads both sides by the margin', () => {
    expect(padClipWindow(2, 3, 0.5, 10)).toEqual({ start: 1.5, end: 3.5 })
  })

  it('clamps to the clip, never asking for data outside the processed buffer', () => {
    // Unlike a region window there is nothing before 0 or after clipDurSec to
    // fetch — the buffer IS the clip.
    expect(padClipWindow(0.1, 9.9, 1.0, 10)).toEqual({ start: 0, end: 10 })
  })

  it('a zero margin is a no-op (preserves the old unpadded behaviour)', () => {
    expect(padClipWindow(2, 3, 0, 10)).toEqual({ start: 2, end: 3 })
  })

  it('the padded window still covers the visible window it was derived from', () => {
    // The whole point: the draw path asks for the VISIBLE range, so a padded
    // cache entry must satisfy hiResCoversWindow for it, or padding would
    // make the entry unusable rather than longer-lived.
    const vis = { start: 2, end: 3 }
    const padded = padClipWindow(vis.start, vis.end, 0.4, 10)
    expect(hiResCoversWindow(padded.start, padded.end, vis.start, vis.end)).toBe(true)
  })

  it('survives a pan smaller than the margin — the regression this fixes', () => {
    // Clip straddling the viewport edge: pan by 0.2s and the wanted window
    // shifts. Unpadded, the cached entry no longer covers it and the clip is
    // refetched on the very next settle; padded by 0.5s, it still covers.
    const cached = padClipWindow(2, 3, 0.5, 10)
    const afterPan = { start: 2.2, end: 3.2 }
    expect(hiResCoversWindow(cached.start, cached.end, afterPan.start, afterPan.end)).toBe(true)

    const unpadded = padClipWindow(2, 3, 0, 10)
    expect(hiResCoversWindow(unpadded.start, unpadded.end, afterPan.start, afterPan.end)).toBe(false)
  })
})

describe('prioritiseProcessedJobs', () => {
  const job = (clipId, centreDistPx) => ({ clipId, centreDistPx })

  it('passes everything through when under the cap', () => {
    const jobs = [job(1, 900), job(2, 10)]
    expect(prioritiseProcessedJobs(jobs, 8)).toHaveLength(2)
  })

  it('keeps the clips nearest the viewport centre', () => {
    const jobs = [job(1, 800), job(2, 10), job(3, 400), job(4, 50)]
    expect(prioritiseProcessedJobs(jobs, 2).map((j) => j.clipId)).toEqual([2, 4])
  })

  it('breaks ties deterministically on clipId', () => {
    // Two equidistant clips must not alternate between passes, each evicting
    // the other's freshly fetched buffer.
    const a = prioritiseProcessedJobs([job(7, 100), job(3, 100), job(5, 100)], 2)
    const b = prioritiseProcessedJobs([job(5, 100), job(7, 100), job(3, 100)], 2)
    expect(a.map((j) => j.clipId)).toEqual([3, 5])
    expect(b.map((j) => j.clipId)).toEqual([3, 5])
  })

  it('does not mutate the input array', () => {
    const jobs = [job(1, 800), job(2, 10)]
    prioritiseProcessedJobs(jobs, 1)
    expect(jobs.map((j) => j.clipId)).toEqual([1, 2])
  })

  it('handles empty input and a non-positive cap', () => {
    expect(prioritiseProcessedJobs([], 10)).toEqual([])
    expect(prioritiseProcessedJobs(null, 10)).toEqual([])
    expect(prioritiseProcessedJobs([job(1, 0)], 0)).toEqual([])
  })
})

describe('shouldRetryNotReady', () => {
  it('allows a clip never seen not-ready', () => {
    expect(shouldRetryNotReady(undefined, 1000, 1500)).toBe(true)
  })

  it('blocks a retry inside the backoff window', () => {
    expect(shouldRetryNotReady(1000, 1400, 1500)).toBe(false)
  })

  it('allows a retry once the backoff has elapsed — never gives up permanently', () => {
    // A buffer that finishes rendering must still get picked up; the backoff
    // only stops the every-80ms re-ask, it is not a blacklist.
    expect(shouldRetryNotReady(1000, 2500, 1500)).toBe(true)
    expect(shouldRetryNotReady(1000, 1_000_000, 1500)).toBe(true)
  })
})

describe('pruneNotReady', () => {
  it('drops only stamps older than the max age', () => {
    const m = new Map([['c1', 1000], ['c2', 9000], ['c3', 9500]])
    pruneNotReady(m, 10_000, 5000)
    expect([...m.keys()]).toEqual(['c2', 'c3'])
  })

  it('tolerates a missing map', () => {
    expect(() => pruneNotReady(null, 0, 1)).not.toThrow()
  })
})

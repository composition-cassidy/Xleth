import { describe, it, expect } from 'vitest'
import { mergeFetchWindows, planRegionFetches } from '../hiResFetchPlanner.js'

describe('mergeFetchWindows', () => {
  it('returns nothing for an empty input', () => {
    expect(mergeFetchWindows([])).toEqual([])
  })

  it('drops zero/negative-length windows', () => {
    expect(mergeFetchWindows([{ start: 5, end: 5 }, { start: 5, end: 2 }])).toEqual([])
  })

  it('leaves non-overlapping, far-apart windows separate', () => {
    const out = mergeFetchWindows([{ start: 0, end: 1 }, { start: 100, end: 101 }])
    expect(out).toEqual([{ start: 0, end: 1 }, { start: 100, end: 101 }])
  })

  it('merges overlapping windows into one', () => {
    const out = mergeFetchWindows([{ start: 0, end: 5 }, { start: 3, end: 8 }])
    expect(out).toEqual([{ start: 0, end: 8 }])
  })

  it('merges windows within mergeGapSec of each other', () => {
    // Two adjacent syllable clips 0.3s apart at the same zoom — a real
    // scenario, not a contrived one.
    const out = mergeFetchWindows(
      [{ start: 0, end: 2 }, { start: 2.3, end: 4 }],
      { mergeGapSec: 0.5 },
    )
    expect(out).toEqual([{ start: 0, end: 4 }])
  })

  it('does not merge across a gap wider than mergeGapSec', () => {
    const out = mergeFetchWindows(
      [{ start: 0, end: 2 }, { start: 3, end: 4 }],
      { mergeGapSec: 0.5 },
    )
    expect(out).toEqual([{ start: 0, end: 2 }, { start: 3, end: 4 }])
  })

  it('sorts input before merging regardless of arrival order', () => {
    const out = mergeFetchWindows([{ start: 10, end: 12 }, { start: 0, end: 2 }])
    expect(out).toEqual([{ start: 0, end: 2 }, { start: 10, end: 12 }])
  })

  it('applies margin after merging, not before', () => {
    // If margin were applied before merge, a 0.4 margin on two windows 0.5
    // apart (mergeGapSec: 0) would inflate them into overlapping and merge —
    // the wrong order of operations. Applying it after must NOT merge here.
    const out = mergeFetchWindows(
      [{ start: 0, end: 2 }, { start: 2.5, end: 4 }],
      { marginSec: 0.4, mergeGapSec: 0 },
    )
    // start clamps at 0 (time can't go negative) — that's the OTHER clamp
    // rule, exercised on its own below; here just confirm no cross-merge.
    expect(out).toEqual([{ start: 0, end: 2.4 }, { start: 2.1, end: 4.4 }])
  })

  it('clamps margin to [0, maxSec]', () => {
    const out = mergeFetchWindows([{ start: 0, end: 2 }], { marginSec: 5, maxSec: 4 })
    expect(out).toEqual([{ start: 0, end: 4 }])
  })

  it('a fully-enclosed window collapses into its container', () => {
    const out = mergeFetchWindows([{ start: 0, end: 10 }, { start: 3, end: 5 }])
    expect(out).toEqual([{ start: 0, end: 10 }])
  })

  it('does not mutate the input array', () => {
    const input = [{ start: 5, end: 6 }, { start: 0, end: 1 }]
    const snapshot = JSON.parse(JSON.stringify(input))
    mergeFetchWindows(input)
    expect(input).toEqual(snapshot)
  })
})

describe('planRegionFetches', () => {
  it('fetches nothing when every requested window is already covered', () => {
    const requested = [{ start: 1, end: 2 }, { start: 3, end: 4 }]
    const existing = [{ startSec: 0, endSec: 5 }]
    expect(planRegionFetches(requested, existing)).toEqual([])
  })

  it('fetches only the uncovered portion when partially cached', () => {
    const requested = [{ start: 1, end: 2 }, { start: 30, end: 31 }]
    const existing = [{ startSec: 0, endSec: 5 }]
    expect(planRegionFetches(requested, existing)).toEqual([{ start: 30, end: 31 }])
  })

  it('handles no existing cache at all', () => {
    const requested = [{ start: 1, end: 2 }]
    expect(planRegionFetches(requested, [])).toEqual([{ start: 1, end: 2 }])
    expect(planRegionFetches(requested, null)).toEqual([{ start: 1, end: 2 }])
  })

  it('merges uncovered windows before returning them', () => {
    const requested = [{ start: 1, end: 2 }, { start: 2, end: 3 }]
    expect(planRegionFetches(requested, [])).toEqual([{ start: 1, end: 3 }])
  })

  it('caps the number of returned fetches', () => {
    // Five widely-scattered, non-mergeable clips visible at once — a
    // pathological but real case (many short clips spread across a long
    // region). Must not issue unbounded IPC calls.
    const requested = [0, 100, 200, 300, 400].map((s) => ({ start: s, end: s + 1 }))
    const out = planRegionFetches(requested, [], { maxFetches: 2 })
    expect(out.length).toBe(2)
  })

  it('reproduces the real bug scenario: 103 clips wanting distinct slices of one region', () => {
    // Mirrors project_timeline_viewport_perf: many clips referencing
    // distinct, mostly non-adjacent sub-ranges of a long source region.
    // Without merging this would be 103 fetches; some ARE adjacent enough
    // to merge, so the count must come down without losing coverage.
    const requested = []
    for (let i = 0; i < 103; i++) {
      const start = (i * 0.37) % 15 // scattered across a 15s region, some collisions by construction
      requested.push({ start, end: Math.min(15, start + 0.15) })
    }
    const out = planRegionFetches(requested, [], { mergeGapSec: 0.05 })
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(103)
    // Every originally requested window must fall inside some returned window.
    for (const w of requested) {
      const covered = out.some((m) => m.start <= w.start + 1e-9 && m.end >= w.end - 1e-9)
      expect(covered).toBe(true)
    }
  })
})

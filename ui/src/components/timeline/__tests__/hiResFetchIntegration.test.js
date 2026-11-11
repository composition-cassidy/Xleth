import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { planRegionFetches } from '../hiResFetchPlanner.js'
import { findCoveringEntry, insertEntry } from '../hiResRegionCache.js'

// End-to-end sanity check against the REAL ppg quote project (the one that
// motivated this whole investigation — see project_timeline_viewport_perf
// memory: region 193 alone has 103 clips). Reproduces exactly what the
// TimelineView settle-effect computes per clip (visStartSec/visEndSec via
// the same beatPos/x/secPerPx arithmetic), then runs it through the real
// planner + cache modules to prove the fetch count collapses.
// Lives in the developer's own projects folder (~/Desktop/SR), not in the repo.
const PROJECT = `${os.homedir().replace(/\\/g, '/')}/Desktop/SR/ppg quote/project.json`
const PPQ = 960

describe('ppg quote: coalesced hi-res fetch planning', () => {
  it('collapses per-clip requests on the busiest region into far fewer fetches', () => {
    const p = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
    const clips = p.clips || []
    const regions = Object.fromEntries((p.regions || []).map(r => [String(r.id), r]))
    const bpm = p.bpm || 120

    // region 193 is the busiest — 103 clips reference it (see memory doc).
    const targetRegionId = '193'
    const region = regions[targetRegionId]
    expect(region).toBeTruthy()
    const regionDurSec = (region.endTime ?? 0) - (region.startTime ?? 0)

    const ppb = 229 // matches the toolbar readout in the reported screenshots
    const w = 1600  // viewport width
    const scroll = 0

    const requested = []
    for (const clip of clips) {
      if (String(clip.regionId) !== targetRegionId) continue
      const beatPos = clip.positionTicks / PPQ
      const beatDur = clip.durationTicks / PPQ
      const x = (beatPos - scroll) * ppb
      const clipW = beatDur * ppb
      if (x + clipW < 0 || x > w) continue // off-screen — the fetch effect skips these too

      const visL = Math.max(0, x)
      const visR = Math.min(w, x + clipW)
      if (visR <= visL) continue

      const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
      const regionOffsetSec = (clip.regionOffsetTicks ?? 0) / PPQ / (bpm / 60)
      const secPerPx = clipDurSec / clipW
      const visStartSec = regionOffsetSec + (visL - x) * secPerPx
      const visEndSec   = regionOffsetSec + (visR - x) * secPerPx
      requested.push({ start: visStartSec, end: visEndSec })
    }

    // Sanity: this region really does have multiple clips visible in one
    // viewport at this zoom — otherwise the test would prove nothing.
    expect(requested.length).toBeGreaterThan(1)

    const pixelsPerSecond = ppb * (bpm / 60)
    const marginSec = 150 / pixelsPerSecond
    const mergeGapSec = 300 / pixelsPerSecond

    const planned = planRegionFetches(requested, [], {
      marginSec, mergeGapSec, maxSec: regionDurSec, maxFetches: 6,
    })

    console.log(`\n  region ${targetRegionId}: ${requested.length} visible clips -> ${planned.length} fetch(es) (old code: ${requested.length} serial IPC calls, one per clip, into a single overwritten slot)`)

    expect(planned.length).toBeGreaterThan(0)
    expect(planned.length).toBeLessThan(requested.length)
    // Never more than the hard cap, however many clips are visible.
    expect(planned.length).toBeLessThanOrEqual(6)

    // Every clip's window is still coverable — the fix must never leave a
    // visible clip permanently unable to get hi-res data.
    for (const w2 of requested) {
      const covered = planned.some((m) => m.start <= w2.start + 1e-9 && m.end >= w2.end - 1e-9)
      expect(covered).toBe(true)
    }
  })

  it('a full settle-pass simulation never overwrites one clip window with another', () => {
    // Simulates the OLD bug directly: two clips on the same region wanting
    // genuinely different windows. Old code: hiResCache[regionId] = objectB
    // clobbers objectA outright. New code: both entries coexist.
    let cache = {} // regionId -> entries[]
    const regionId = 'r1'

    const windows = [{ start: 0, end: 2 }, { start: 10, end: 12 }, { start: 20, end: 22 }]
    for (const w of windows) {
      const existing = cache[regionId] || []
      // Simulates one job's fetch resolving and writing.
      cache[regionId] = insertEntry(existing, { startSec: w.start, endSec: w.end, peaks: [w.start] }, 12)
    }

    expect(cache[regionId].length).toBe(3)
    for (const w of windows) {
      const found = findCoveringEntry(cache[regionId], w.start, w.end)
      expect(found).not.toBe(null)
      expect(found.startSec).toBe(w.start)
    }
  })
})

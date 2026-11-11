import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { planRegionFetches } from '../hiResFetchPlanner.js'
import { prioritiseProcessedJobs, padClipWindow } from '../hiResProcessedPlanner.js'

// Budget gate against the REAL `BFDIA 9` project — the case that exposed the
// uncapped processed-clip fetch path (reported 2026-09-12: "scrolling around
// the Timeline introduces stuttering for a bit, especially on lower-end
// computers", plus copy/paste going dead for a period).
//
// That project is near worst-case for this path: 3133 clips over 16 referenced
// regions, and 129 stretched clips clustered in one stretch of the timeline,
// so nearly every stretched clip in the project is on screen at once at a
// normal working zoom. The per-region coalescing cap (hiResFetchPlanner.js)
// was doing its job — 7-11 fetches across ALL regions — while the processed
// path, which had no cap at all, contributed ~95% of the traffic.
//
// Every one of those calls serialises on the engine worker's single JS thread
// (see ui/addon-worker.js), so the burst also delays whatever RPC the user
// issues next — which is the copy/paste half of the same report.
//
// Like the ppg quote test next door this reads a real project off disk, so it
// skips rather than fails where that file isn't present (CI, another machine).
const PROJECT = `${os.homedir().replace(/\\/g, '/')}/Desktop/SR/BFDIA 9/project.json`
const PPQ = 960

// Must match TimelineView.jsx's constants.
const HIRES_MARGIN_PX = 150
const HIRES_MERGE_GAP_PX = 300
const HIRES_MAX_FETCHES_PER_REGION = 6
const HIRES_MAX_PROCESSED_FETCHES = 24

const hasProject = fs.existsSync(PROJECT)

/**
 * Replicates TimelineView's settle-pass passes 1, 2 and 2b for one viewport,
 * against a cold cache (the worst case, and the state after every zoom-out to
 * envelope regime wipes it).
 */
function planSettlePass(p, { ppb, scroll, w = 1600 }) {
  const clips = p.clips || []
  const regions = Object.fromEntries((p.regions || []).map((r) => [String(r.id), r]))
  const bpm = p.bpm || 120
  const pixelsPerSecond = ppb * (bpm / 60)
  const spp = 48000 / pixelsPerSecond
  const regime = spp <= 0.5 ? 'sample' : spp <= 8 ? 'waveform' : spp <= 200 ? 'trace' : 'envelope'
  if (regime === 'envelope') return null

  const marginSec = HIRES_MARGIN_PX / pixelsPerSecond
  const mergeGapSec = HIRES_MERGE_GAP_PX / pixelsPerSecond
  const regionPeakRequests = new Map()
  const regionMaxSec = new Map()
  const processedJobs = []
  let visible = 0

  for (const clip of clips) {
    const region = regions[String(clip.regionId)]
    if (!region) continue
    const regionDurSec = (region.endTime ?? 0) - (region.startTime ?? 0)
    if (regionDurSec <= 0) continue

    const beatPos = clip.positionTicks / PPQ
    const beatDur = clip.durationTicks / PPQ
    const x = (beatPos - scroll) * ppb
    const clipW = beatDur * ppb
    if (x + clipW < 0 || x > w) continue
    const visL = Math.max(0, x)
    const visR = Math.min(w, x + clipW)
    if (visR <= visL) continue
    visible++

    const clipDurSec = beatDur / (bpm / 60)
    const regionOffsetSec = (clip.regionOffsetTicks ?? 0) / PPQ / (bpm / 60)
    const secPerPx = clipDurSec / clipW
    const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                       || (clip.pitchOffsetCents ?? 0) !== 0
                       || clip.reversed
                       || ((clip.stretchRatio ?? 1) !== 1)

    if (hasProcessing && regime !== 'sample') {
      const win = padClipWindow((visL - x) * secPerPx, (visR - x) * secPerPx, marginSec, clipDurSec)
      processedJobs.push({
        clipId: clip.id,
        centreDistPx: Math.abs((visL + visR) / 2 - w / 2),
        ...win,
      })
      continue
    }

    const list = regionPeakRequests.get(clip.regionId) || []
    list.push({ start: regionOffsetSec + (visL - x) * secPerPx, end: regionOffsetSec + (visR - x) * secPerPx })
    regionPeakRequests.set(clip.regionId, list)
    if (!regionMaxSec.has(clip.regionId)) regionMaxSec.set(clip.regionId, regionDurSec)
  }

  let peakFetches = 0
  for (const [regionId, requests] of regionPeakRequests) {
    peakFetches += planRegionFetches(requests, [], {
      marginSec, mergeGapSec,
      maxSec: regionMaxSec.get(regionId),
      maxFetches: HIRES_MAX_FETCHES_PER_REGION,
    }).length
  }
  const capped = prioritiseProcessedJobs(processedJobs, HIRES_MAX_PROCESSED_FETCHES)

  return {
    regime, visible, peakFetches,
    processedUncapped: processedJobs.length,
    processedCapped: capped.length,
    total: peakFetches + capped.length,
    kept: capped,
  }
}

/**
 * Worst viewport over a scan of scroll positions at one zoom, ranked by the
 * PRE-FIX cost (uncapped processed + region fetches).
 *
 * Ranking by the post-cap total instead would be useless: the cap saturates at
 * HIRES_MAX_PROCESSED_FETCHES across most of this project, so the maximiser
 * would be driven entirely by the region-fetch count and would never land on
 * the stretch-heavy viewport this gate exists to bound.
 */
function worstAtZoom(p, ppb) {
  const maxBeat = Math.max(...(p.clips || []).map((c) => c.positionTicks / PPQ))
  const step = (1600 / ppb) / 2
  let worst = null
  const cost = (r) => r.processedUncapped + r.peakFetches
  for (let s = 0; s < maxBeat; s += step) {
    const r = planSettlePass(p, { ppb, scroll: s })
    if (r && (!worst || cost(r) > cost(worst))) worst = { ...r, scroll: s }
  }
  return worst
}

describe.skipIf(!hasProject)('BFDIA 9: hi-res fetch budget per settle pass', () => {
  const p = hasProject ? JSON.parse(fs.readFileSync(PROJECT, 'utf8')) : null

  it('caps total IPC round-trips per settle pass at every working zoom', () => {
    const ZOOMS = [120, 160, 229, 400, 800, 2000]
    const ceiling = HIRES_MAX_PROCESSED_FETCHES + HIRES_MAX_FETCHES_PER_REGION * 16

    for (const ppb of ZOOMS) {
      const w = worstAtZoom(p, ppb)
      expect(w, `ppb=${ppb} should be past envelope regime`).toBeTruthy()
      console.log(
        `  ppb=${ppb}: ${w.visible} visible clips, ${w.peakFetches} region + `
        + `${w.processedCapped} processed = ${w.total} IPC `
        + `(uncapped processed was ${w.processedUncapped})`)

      expect(w.processedCapped).toBeLessThanOrEqual(HIRES_MAX_PROCESSED_FETCHES)
      expect(w.total).toBeLessThanOrEqual(ceiling)
    }
  })

  it('the cap actually bites at the zoom levels that stuttered', () => {
    // If this ever stops being true the project changed, and the numbers in
    // hiResProcessedPlanner.js's header no longer describe it — the budget
    // assertions above would then be passing vacuously.
    const w = worstAtZoom(p, 120)
    expect(w.processedUncapped).toBeGreaterThan(80)
    expect(w.processedCapped).toBe(HIRES_MAX_PROCESSED_FETCHES)
    // The headline: one settle pass used to cost >100 serialised round-trips.
    expect(w.processedUncapped + w.peakFetches).toBeGreaterThan(100)
    expect(w.total).toBeLessThan(40)
  })

  it('the kept clips are the ones under the user eye, not an arbitrary prefix', () => {
    const w = worstAtZoom(p, 120)
    const keptMax = Math.max(...w.kept.map((j) => j.centreDistPx))
    const dropped = w.processedUncapped - w.processedCapped
    expect(dropped).toBeGreaterThan(0)
    // Every kept clip is at least as close to the viewport centre as the
    // nearest dropped one would have been.
    expect(keptMax).toBeLessThanOrEqual(800)
  })

  it('every processed window still covers the visible range it came from', () => {
    // Padding must widen, never shift — a padded entry the draw path cannot
    // use would trade a fetch burst for a permanently low-res waveform.
    const w = worstAtZoom(p, 229)
    for (const j of w.kept) {
      expect(j.end).toBeGreaterThan(j.start)
      expect(j.start).toBeGreaterThanOrEqual(0)
    }
  })
})

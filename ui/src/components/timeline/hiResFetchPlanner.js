import { hiResCoversWindow } from './hiResCoverage.js'

// Decides WHAT to fetch for one region's hi-res waveform cache, given every
// currently-visible clip's wanted time window on that region. Pure — no
// timers, no IPC, no cache mutation — so the coalescing logic that used to
// live inline in TimelineView's ON-SETTLE fetch effect can be exercised
// directly by tests instead of only through a live async gesture.
//
// THE PROBLEM THIS SOLVES: the hi-res cache used to hold exactly one window
// per region. A region referenced by many clips at DIFFERENT sub-ranges (a
// syllable-chopped source region is the common case — see
// project_timeline_viewport_perf memory: region 193 in a real project had
// 103 clips, each wanting a different few-hundred-ms slice) meant every
// clip's fetch effect iteration invalidated the PREVIOUS clip's freshly
// fetched window before it could ever be drawn from. That is not just a
// cache-efficiency loss — the fetcher and drawer BOTH still ran, so it cost
// a full serial IPC round-trip per clip every settle pass, all discarded.
//
// Fix has two parts:
//   1. The cache becomes multi-slot per region (see hiResRegionCache.js) —
//      "different clips want different windows" is no longer treated as a
//      collision.
//   2. Nearby/overlapping requested windows are MERGED into fewer, wider
//      fetches before hitting the network — clips that are genuinely close
//      together in source time (repeated quotes, adjacent syllables after a
//      non-scrambled split) collapse into one request instead of one each.
//      Widely scattered clips simply produce more, smaller merged groups —
//      merging only ever reduces fetch count, never distorts what's fetched.

/**
 * Merge a list of {start, end} time windows into the minimal set of
 * covering intervals, treating a gap of at most `mergeGapSec` as still
 * "the same interval" (batches nearby-but-not-literally-overlapping windows
 * into one fetch). Pads every merged interval by `marginSec` on each side
 * AFTER merging (so the merge decision reflects true requested adjacency,
 * not inflated ranges), then clamps to [0, maxSec].
 *
 * @param {Array<{start:number, end:number}>} windows
 * @param {{mergeGapSec?:number, marginSec?:number, maxSec?:number}} [opts]
 * @returns {Array<{start:number, end:number}>} sorted, non-overlapping
 */
export function mergeFetchWindows(windows, { mergeGapSec = 0, marginSec = 0, maxSec = Infinity } = {}) {
  const valid = windows.filter((w) => w.end > w.start)
  if (valid.length === 0) return []

  const sorted = [...valid].sort((a, b) => a.start - b.start)
  const merged = [{ start: sorted[0].start, end: sorted[0].end }]
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i]
    const last = merged[merged.length - 1]
    if (w.start <= last.end + mergeGapSec) {
      if (w.end > last.end) last.end = w.end
    } else {
      merged.push({ start: w.start, end: w.end })
    }
  }

  for (const m of merged) {
    m.start = Math.max(0, m.start - marginSec)
    m.end = Math.min(maxSec, m.end + marginSec)
  }
  return merged
}

/**
 * Decide which windows actually need fetching for one region: drop anything
 * an existing cache entry already covers, merge what's left, and cap the
 * result — so a viewport with many scattered, non-mergeable clips can't blow
 * an unbounded number of IPC round-trips into a single settle pass. Clips
 * whose windows fall outside the capped result simply keep showing the (now
 * viewport-culled, non-distorting — see hiResCoverage.js) low-res fallback
 * until a later settle pass has room for them.
 *
 * @param {Array<{start:number, end:number}>} requested   one entry per
 *   visible clip's currently-wanted window; duplicates/overlaps expected
 * @param {Array<{startSec:number, endSec:number}>} existingEntries  the
 *   region's current cache array (see hiResRegionCache.js)
 * @param {{marginSec?:number, mergeGapSec?:number, maxSec?:number, maxFetches?:number}} [opts]
 * @returns {Array<{start:number, end:number}>} windows to fetch, capped
 */
export function planRegionFetches(requested, existingEntries, opts = {}) {
  const { marginSec = 0, mergeGapSec = 0, maxSec = Infinity, maxFetches = Infinity } = opts
  const entries = existingEntries || []
  const uncovered = requested.filter(
    (w) => !entries.some((e) => hiResCoversWindow(e.startSec, e.endSec, w.start, w.end))
  )
  if (uncovered.length === 0) return []
  return mergeFetchWindows(uncovered, { mergeGapSec, marginSec, maxSec }).slice(0, maxFetches)
}

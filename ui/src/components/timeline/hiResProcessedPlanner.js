// Planning helpers for the PROCESSED half of the hi-res waveform fetch —
// clips with stretch/pitch/reverse, whose peaks come from the engine's
// rendered per-clip buffer (waveform_getClipPeaks) rather than from the
// source region's mipmap (waveform_getRegionPeaks).
//
// WHY THIS EXISTS: the Phase 5 coalescing work (hiResFetchPlanner.js +
// hiResRegionCache.js) capped and merged fetches for UNPROCESSED clips only.
// Processed clips took a separate per-clip path with no cap, no merging and
// no margin padding, because "a processed buffer belongs to exactly one clip"
// made merging look inapplicable. Merging genuinely is inapplicable — two
// clips never share a processed buffer — but CAPPING and PADDING are not, and
// their absence is what makes a stretch-heavy project stutter:
//
//   Measured on the real `BFDIA 9` project (3133 clips, 16 referenced
//   regions, 129 stretched clips clustered in one stretch of the timeline),
//   1600px viewport, worst scroll position at each zoom:
//
//     ppb=120 → 239 visible clips → 7 region fetches + 118 processed = 125
//     ppb=160 → 180 visible clips → 7 region fetches +  91 processed =  98
//     ppb=229 → 123 visible clips → 8 region fetches +  69 processed =  77
//
//   The per-region cap was doing its job (7-11 fetches across every region);
//   the uncapped processed path contributed ~95% of the traffic. All of it
//   serialises on the engine worker's single JS thread (see addon-worker.js),
//   so every other RPC issued meanwhile — a transport poll, or a user's
//   timeline_pasteClipsBatch — waits behind the whole burst.
//
// Three independent problems, three helpers below:
//   1. No cap            → prioritiseProcessedJobs (viewport-centre-first)
//   2. No margin padding → padClipWindow (a 1px pan must not invalidate it)
//   3. ready:false never cached, so a clip whose processed buffer is not
//      resident in the engine's ClipRenderCache is re-requested on EVERY
//      settle, forever, with no backoff → shouldRetryNotReady / pruneNotReady

/**
 * Pad a clip-local [start, end] window by `marginSec` on each side, clamped
 * to the clip's own duration.
 *
 * The region path has always padded its merged windows (HIRES_MARGIN_PX), so
 * a small pan still lands inside an already-cached window. The processed path
 * did not: it cached EXACTLY the visible sub-range, so for any clip straddling
 * a viewport edge the next settle's window was never covered and refetched
 * unconditionally. Padding makes the cached window survive small pans, which
 * is what turns a repeated burst into a one-off one.
 *
 * Coordinates are clip-local seconds (0 = start of the processed buffer), so
 * 0 and clipDurSec are hard walls — unlike a region window there is no data
 * outside them to fetch.
 *
 * @param {number} start  clip-local start, seconds
 * @param {number} end    clip-local end, seconds
 * @param {number} marginSec
 * @param {number} clipDurSec  the clip's full processed duration, seconds
 * @returns {{start:number, end:number}}
 */
export function padClipWindow(start, end, marginSec, clipDurSec) {
  const max = Math.max(0, clipDurSec)
  const m = Math.max(0, marginSec)
  return {
    start: Math.max(0, Math.min(start, max) - m),
    end: Math.min(max, Math.max(start, end) + m),
  }
}

/**
 * Cap how many processed-clip fetches one settle pass may issue, keeping the
 * ones nearest the viewport centre.
 *
 * Centre-first rather than left-to-right: the clips under the user's eye get
 * their real waveform in the first pass, and whatever is cut keeps drawing
 * the (viewport-culled, non-distorting — see hiResCoverage.js) low-res
 * fallback until a later settle pass has room. Cutting by document order
 * instead would leave the middle of the screen low-res whenever the viewport
 * started inside a dense cluster.
 *
 * Ties break on `clipId` so the selection is deterministic across passes —
 * without that, two equidistant clips could alternate between passes and each
 * keep evicting the other's work.
 *
 * @param {Array<{clipId:number, centreDistPx:number}>} jobs
 * @param {number} maxJobs
 * @returns {Array} the kept jobs, nearest-centre first
 */
export function prioritiseProcessedJobs(jobs, maxJobs) {
  if (!jobs || jobs.length === 0) return []
  if (!(maxJobs > 0)) return []
  if (jobs.length <= maxJobs) return [...jobs]
  return [...jobs]
    .sort((a, b) => (a.centreDistPx - b.centreDistPx) || (a.clipId - b.clipId))
    .slice(0, maxJobs)
}

/**
 * Should a clip whose last getClipPeaks answered `ready:false` be retried?
 *
 * `ready:false` means the engine has no rendered buffer for that clip right
 * now (ClipRenderCache miss — it may still be building, or have been GC'd
 * when its last subscriber left). The renderer only ever wrote the cache on
 * `ready === true`, so a not-ready clip left NO trace: the next settle pass
 * saw an empty cache slot and asked again, every pass, indefinitely. In a
 * project where most stretched clips' buffers aren't resident, that alone
 * reproduces the full burst on every single scroll.
 *
 * A timestamp-gated retry bounds that without giving up: the clip is asked
 * again after `backoffMs`, so a buffer that finishes rendering still gets
 * picked up — just on the next eligible pass instead of every pass.
 *
 * @param {number|undefined} stamp  ms timestamp of the last not-ready answer
 * @param {number} now
 * @param {number} backoffMs
 * @returns {boolean} true when the clip may be fetched again
 */
export function shouldRetryNotReady(stamp, now, backoffMs) {
  if (stamp == null) return true
  return (now - stamp) >= backoffMs
}

/**
 * Drop not-ready timestamps older than `maxAgeMs`, in place.
 *
 * The map is keyed by clip and only ever grows as the user visits more of the
 * timeline; entries for clips that have long since become ready (or been
 * deleted) are dead weight. Pruning on the settle pass keeps it bounded
 * without needing to hook clip deletion.
 *
 * @param {Map<string, number>} map
 * @param {number} now
 * @param {number} maxAgeMs
 */
export function pruneNotReady(map, now, maxAgeMs) {
  if (!map) return
  for (const [key, stamp] of map) {
    if ((now - stamp) >= maxAgeMs) map.delete(key)
  }
}

// Whether a cached hi-res waveform window fully covers a requested visible
// time window — i.e. whether it is safe to draw peaks straight from it.
//
// This mirrors the SAME epsilon-based check TimelineView's on-settle fetch
// effect already uses to decide whether a cache entry is fresh enough to
// skip refetching (the `cached.startSec <= visStartSec + 0.001 &&
// cached.endSec >= visEndSec - 0.001` checks in TimelineView.jsx). The draw
// path failing to apply that same test was the root cause of the "waveform
// stretches while panning, then snaps correct" bug: drawClips drew from
// whatever was cached regardless of how much of the requested window it
// actually covered — clamping the resulting fraction into [0,1] and
// stretching however many columns fell in that clamped range across the
// FULL requested pixel width. Pan past a cached window (cache covers
// sec 10-15, the view now wants 12-17) and the last 60% of the cache's
// columns — representing only 3 of the 5 requested seconds — got stretched
// across all 5 seconds of pixel width. That is a real shape distortion, not
// merely stale data; it only resolved once the 80ms-debounced refetch landed.
//
// The fix is this exact completeness gate, matching the pattern the
// sample-regime draw branch already used (its own `dataOffset >= 0 &&
// dataOffset + dataCount <= hiRes.samples.length` check IS a full-coverage
// test) — the peaks/trace/waveform-line branch was simply missing it.
//
// EPSILON matches the fetch effect's own tolerance; the draw path and the
// fetch path must agree on what "covers the window" means, or a cache entry
// the fetcher considers fresh could still be judged too incomplete to draw
// (or vice versa), leaving a wobble the debounce never actually resolves.
const EPSILON = 0.001

export function hiResCoversWindow(cacheStartSec, cacheEndSec, visStartSec, visEndSec) {
  return cacheStartSec <= visStartSec + EPSILON && cacheEndSec >= visEndSec - EPSILON
}

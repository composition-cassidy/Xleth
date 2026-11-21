import { hiResCoversWindow } from './hiResCoverage.js'

// Storage operations for the hi-res waveform cache's per-region SLOT ARRAY.
//
// Each region key used to hold exactly one cache entry. That is fine when
// every clip referencing a region wants (approximately) the same window,
// but wrong whenever they want DIFFERENT windows — a syllable-chopped
// region referenced by many clips, each a different slice of the source —
// because the single slot gets overwritten by whichever clip's fetch effect
// iteration ran last, discarding every other clip's freshly-fetched data
// before drawClips ever got a frame to read it from. See
// hiResFetchPlanner.js for the matching fetch-side half of this fix.
//
// The array is capped (FIFO eviction: oldest-inserted entry drops first)
// rather than unbounded, so a pathological viewport (hundreds of distinct
// tiny windows on one region) can't grow the cache without limit. `touch`
// promotes an entry to most-recently-used on a cache HIT, so an entry that
// keeps getting reused survives eviction longer than one that was fetched
// once and never needed again — call it from the fetch effect (which runs
// at most once per ~100ms settle), never from the per-frame draw path.

/** Find an existing entry that fully covers [startSec, endSec), or null. */
export function findCoveringEntry(entries, startSec, endSec) {
  if (!entries) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (hiResCoversWindow(e.startSec, e.endSec, startSec, endSec)) return e
  }
  return null
}

/**
 * Append a new entry, evicting the oldest if over `maxEntries`. Returns a
 * NEW array (caller replaces `cache[regionId]` with the result) — entries
 * arrays are treated as immutable so a concurrently-running stale fetch job
 * (see the generation-counter cancellation in TimelineView.jsx) can't corrupt
 * an array a same-tick draw call is also holding a reference to.
 */
export function insertEntry(entries, entry, maxEntries) {
  const next = (entries || []).concat(entry)
  while (next.length > maxEntries) next.shift()
  return next
}

/** Move an entry to the most-recently-used end. Returns a NEW array. */
export function touchEntry(entries, entry) {
  if (!entries) return entries
  const idx = entries.indexOf(entry)
  if (idx === -1 || idx === entries.length - 1) return entries
  const next = entries.slice(0, idx).concat(entries.slice(idx + 1))
  next.push(entry)
  return next
}

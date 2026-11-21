// ─── samplePreviewCache.js ────────────────────────────────────────────────────
// Module-level cache of getFrameAtTime() results, shared across every
// MidiSampleRail instance in the MIDI import dialog. Without it, each rail
// keeps its own request state, so N output rows x M regions issue N*M
// identical getFrameAtTime RPCs for the very same thumbnails -- a real IPC
// storm on a multi-track import. Callers share one in-flight (and later,
// resolved) promise per unique tile instead.
//
// Staleness: sourceMedia items carry a filePath + duration that's cheap and
// already fetched (see getSources()), so that pair is folded into the key as
// a fingerprint. A source that is re-imported at the same id with different
// media (different path or duration) naturally misses the cache rather than
// serving a stale thumbnail; nothing is ever cleared on dialog open/close, so
// a re-opened dialog paints previously-seen tiles instantly.

const cache = new Map()

function buildKey(sourceId, fingerprint, previewTime, width, height) {
  return `${sourceId}|${fingerprint}|${previewTime}|${width}|${height}`
}

// A cheap, stable fingerprint for a `source` object (as returned by
// timeline.getSources()) -- folded into the cache key so a source whose
// underlying media actually changed doesn't serve a stale thumbnail.
export function getSourceFingerprint(source) {
  if (!source) return ''
  const filePath = source.filePath ?? ''
  const duration = Number.isFinite(source.duration) ? source.duration : ''
  return `${filePath}:${duration}`
}

// Returns a Promise<string|null> resolving to a data URL (or null on
// failure/no frame). Concurrent callers for the same key share the same
// promise, so getFrameAtTime is invoked at most once per unique tile.
export function getCachedPreview(getFrameAtTime, sourceId, fingerprint, previewTime, width, height) {
  const key = buildKey(sourceId, fingerprint, previewTime, width, height)
  let entry = cache.get(key)
  if (!entry) {
    entry = Promise.resolve()
      .then(() => getFrameAtTime(sourceId, previewTime, width, height))
      .catch(() => null)
    cache.set(key, entry)
  }
  return entry
}

// Test-only escape hatch -- production code never needs to clear this cache.
export function clearSamplePreviewCache() {
  cache.clear()
}

// ─── sampleStills.js ──────────────────────────────────────────────────────────
// One shared source of still frames for the Samples grid.
//
// Why this exists: every grid tile used to mount its own <video>, seek it and
// grab a frame. That is one live decoder per tile (27 samples = 27 decoders, all
// kept alive), and the grab itself — canvas.toDataURL() on a video served from
// the local media server — is a cross-origin read, so it threw and nothing was
// ever cached. Every remount (search, collapse, view toggle, relaunch) paid the
// full cost again.
//
// Now a tile asks here for a small JPEG instead:
//   memory LRU → IndexedDB (survives relaunch) → engine FrameServer (one at a time)
//
// The engine decodes with FFmpeg off the renderer, prefers the proxy when one
// exists, and hands back a frame already scaled to tile size. Requests are
// de-duplicated per key and run strictly one at a time, so a big grid never
// floods the engine's command thread — other RPCs interleave between frames.

const STILL_W = 320
const STILL_H = 180

const MEMORY_LIMIT = 600      // ~10-15 KB each
const PERSIST_LIMIT = 1500    // rows kept on disk before the oldest are pruned
const PERSIST_PRUNE_TO = 1200
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

const DB_NAME = 'xleth-sample-stills'
const DB_STORE = 'stills'

// ── Keys ─────────────────────────────────────────────────────────────────────
// Path + probed duration fingerprint the media: a source relinked to a different
// file misses instead of painting a stale frame. No source id — ids are only
// meaningful inside one project, and the same file in another project (or the
// same project next launch) should hit.
export function stillKeyFor({ filePath, duration, timeSeconds }) {
  if (!filePath || !Number.isFinite(timeSeconds)) return null
  const dur = Number.isFinite(duration) ? duration.toFixed(3) : ''
  const ms = Math.max(0, Math.round(timeSeconds * 1000))
  return `${filePath}|${dur}|${ms}|${STILL_W}x${STILL_H}`
}

// ── Memory LRU ───────────────────────────────────────────────────────────────
const memory = new Map() // key -> dataURL; iteration order = least recently used first

export function peekStill(key) {
  if (!key) return null
  const url = memory.get(key)
  if (url === undefined) return null
  memory.delete(key)
  memory.set(key, url)
  return url
}

function remember(key, url) {
  memory.delete(key)
  memory.set(key, url)
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value)
}

// ── IndexedDB (best effort — every failure degrades to "not cached") ──────────
let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(DB_STORE, { keyPath: 'key' })
        store.createIndex('usedAt', 'usedAt')
      }
      req.onsuccess = () => {
        const db = req.result
        resolve(db)
        prune(db)
      }
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function prune(db) {
  try {
    const store = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE)
    const countReq = store.count()
    countReq.onsuccess = () => {
      let excess = countReq.result - PERSIST_LIMIT
      if (excess <= 0) return
      excess = countReq.result - PERSIST_PRUNE_TO
      const cursorReq = store.index('usedAt').openCursor()
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor || excess <= 0) return
        cursor.delete()
        excess -= 1
        cursor.continue()
      }
    }
  } catch { /* pruning is opportunistic */ }
}

function persistPut(db, key, url) {
  try {
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put({ key, url, usedAt: Date.now() })
  } catch { /* disk cache is optional */ }
}

async function persistGet(key) {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key)
      req.onsuccess = () => {
        const row = req.result
        if (!row || typeof row.url !== 'string') { resolve(null); return }
        // Keep rows that are still in use at the young end of the prune order,
        // without turning every read into a write.
        if (Date.now() - (row.usedAt || 0) > REFRESH_AFTER_MS) persistPut(db, key, row.url)
        resolve(row.url)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function persistSet(key, url) {
  const db = await openDb()
  if (db) persistPut(db, key, url)
}

// ── Engine fetch ─────────────────────────────────────────────────────────────
// Keys the engine definitively had no frame for (missing file, time past the
// end). Remembered for the session so a broken source isn't retried per mount.
const noFrame = new Set()
// Sources the FrameServer refused to open, so 30 tiles of one missing file
// make one open attempt rather than 30.
const unopenable = new Set()

async function fetchFromEngine(job) {
  const video = typeof window !== 'undefined' ? window.xleth?.video : null
  if (typeof video?.getFrameAtTime !== 'function') return { url: null, definitive: false }
  try {
    let url = await video.getFrameAtTime(job.sourceId, job.timeSeconds, STILL_W, STILL_H)
    // The FrameServer only holds sources imported or relinked this session — a
    // source that came in with a loaded project has to be opened on demand.
    if (!url && typeof video.openSource === 'function' && !unopenable.has(job.sourceKey)) {
      const opened = await video.openSource(job.sourceId)
      if (opened?.success) {
        url = await video.getFrameAtTime(job.sourceId, job.timeSeconds, STILL_W, STILL_H)
      } else {
        unopenable.add(job.sourceKey)
      }
    }
    return { url: typeof url === 'string' && url ? url : null, definitive: true }
  } catch {
    // Engine still starting, or the call timed out — not a verdict on the frame.
    return { url: null, definitive: false }
  }
}

// ── Request queue ────────────────────────────────────────────────────────────
const jobs = new Map() // key -> job (in flight, or waiting for the engine)
const queue = []       // jobs waiting for the engine, oldest first
let engineBusy = false

function finish(job, url) {
  jobs.delete(job.key)
  if (url) remember(job.key, url)
  job.resolve(url || null)
}

function pump() {
  if (engineBusy) return
  let job = null
  while (queue.length > 0) {
    const next = queue.shift()
    // Every tile that wanted this frame has unmounted since — skip the decode.
    if (next.waiters > 0) { job = next; break }
    finish(next, null)
  }
  if (!job) return
  engineBusy = true
  fetchFromEngine(job).then(({ url, definitive }) => {
    if (url) persistSet(job.key, url)
    else if (definitive) noFrame.add(job.key)
    finish(job, url)
  }).finally(() => {
    engineBusy = false
    pump()
  })
}

async function start(job) {
  const persisted = await persistGet(job.key)
  if (persisted) { finish(job, persisted); return }
  queue.push(job)
  pump()
}

const SETTLED_NULL = { promise: Promise.resolve(null), cancel() {} }

/**
 * Ask for the still of `sourceId` at `timeSeconds`.
 * Returns { promise, cancel }: the promise resolves to a JPEG data URL, or null
 * when no frame could be produced. Call cancel() when the caller stops caring
 * (unmount) — a request nobody is waiting for is dropped before it reaches the
 * engine.
 */
export function requestStill({ sourceId, filePath, duration, timeSeconds }) {
  const key = stillKeyFor({ filePath, duration, timeSeconds })
  if (!key || typeof sourceId !== 'number') return SETTLED_NULL

  const hit = peekStill(key)
  if (hit) return { promise: Promise.resolve(hit), cancel() {} }
  if (noFrame.has(key)) return SETTLED_NULL

  let job = jobs.get(key)
  if (!job) {
    job = { key, sourceId, timeSeconds, sourceKey: `${sourceId}|${filePath}`, waiters: 0 }
    job.promise = new Promise((resolve) => { job.resolve = resolve })
    jobs.set(key, job)
    start(job)
  }
  job.waiters += 1
  let live = true
  return {
    promise: job.promise,
    cancel() {
      if (!live) return
      live = false
      job.waiters -= 1
    },
  }
}

// Test-only: production code never clears these.
export function __resetSampleStillsForTests() {
  memory.clear()
  noFrame.clear()
  unopenable.clear()
  jobs.clear()
  queue.length = 0
  engineBusy = false
  dbPromise = null
}

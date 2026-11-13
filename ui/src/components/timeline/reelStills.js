// Decoded still frames for Reel lane thumbnails.
//
// The picture itself comes from sampleStills.js (memory LRU -> IndexedDB -> one
// engine decode at a time), the same pipeline and the same cache keys the Samples
// grid uses, so a region already seen there costs nothing here. This module only
// turns the JPEG data URL into an HTMLImageElement the canvas can drawImage, and
// remembers it.
//
// Every note retriggers its region from the region start, so the thumbnail of a
// clip is a function of its REGION, not of the clip: one still per region, however
// many notes. Requests are therefore per region, never per clip.
//
// The draw path calls getReelStill() per visible clip per frame, so it must be
// allocation-free on a hit: one Map lookup. A miss starts (at most) one request
// and returns null; the plain block is drawn until the image arrives and the
// subscribers are told to repaint.

import { peekStill, requestStill, stillKeyFor } from '../sampleStills.js'

const IMAGE_LIMIT = 120
const RETRY_AFTER_MS = 10000

const images = new Map()   // key -> HTMLImageElement; iteration order = least recently used first
const failed = new Map()   // key -> time of the failure (the engine may still be starting)
const pending = new Set()  // keys with a request in flight
const listeners = new Set()

export function subscribeReelStills(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

function settle(key, img) {
  pending.delete(key)
  if (img) {
    images.set(key, img)
    if (images.size > IMAGE_LIMIT) images.delete(images.keys().next().value)
    failed.delete(key)
    notify()
  } else {
    failed.set(key, Date.now())
  }
}

function begin(key, desc) {
  pending.add(key)
  const cached = peekStill(key)
  const urlPromise = cached ? Promise.resolve(cached) : requestStill(desc).promise
  urlPromise.then((url) => {
    if (!url || typeof Image === 'undefined') { settle(key, null); return }
    const img = new Image()
    img.onload = () => settle(key, img)
    img.onerror = () => settle(key, null)
    img.src = url
  }, () => settle(key, null))
}

/**
 * The decoded still for `desc` ({ sourceId, filePath, duration, timeSeconds }),
 * or null while it is loading, missing, or failed. Never throws.
 */
export function getReelStill(desc) {
  if (!desc) return null
  const key = stillKeyFor(desc)
  if (!key) return null
  const hit = images.get(key)
  if (hit) {
    // Touch for the LRU only when it is not already the youngest entry cheaply:
    // delete + set is two Map ops, fine at one hit per region per frame.
    images.delete(key)
    images.set(key, hit)
    return hit
  }
  if (pending.has(key)) return null
  const failedAt = failed.get(key)
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return null
  begin(key, desc)
  return null
}

// Test-only.
export function __resetReelStillsForTests() {
  images.clear()
  failed.clear()
  pending.clear()
  listeners.clear()
}

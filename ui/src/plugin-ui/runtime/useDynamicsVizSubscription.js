// ─── useDynamicsVizSubscription.js ──────────────────────────────────────────
// React hook that subscribes a visualizer canvas to a per-effect dynamics
// viz stream. Responsibilities:
//   • Toggle setEffectVisualizationEnabled(true|false) on mount/unmount.
//   • Drive a requestAnimationFrame loop that drains buckets at ~30 Hz and
//     pushes them into a mutable ring buffer (no React state).
//   • Share a single subscription per (trackId, nodeId) across multiple
//     visualizer nodes that target the same effect (level history + GR strip
//     + transfer curve all read from the same drain).
//   • Use an in-flight guard so async drain calls cannot overlap.
//   • Ignore stale async results when target changes / unmounts.
//
// Returned handle has IDENTITY-STABLE refs (handleRef.current is the same
// object across renders for the same hook call). Painters can therefore
// pass the handle to a useEffect dep array without retriggering the rAF
// loop on unrelated re-renders (e.g. param changes from knob movement).

import { useEffect, useRef } from 'react'
import {
  parseDrainResponse,
  VIZ_TYPE,
  DYNAMICS_VIZ_SCHEMA_VERSION,
  COMPRESSOR_BUCKET,
  LIMITER_BUCKET,
  TRANSIENT_BUCKET,
  MULTIBAND_BUCKET,
  RESONANCE_BUCKET,
} from '../../constants/dynamicsViz.js'

const TARGET_HZ          = 30
const TARGET_INTERVAL_MS = 1000 / TARGET_HZ
const DRAIN_MAX_BUCKETS  = 256        // ~340 ms of buckets at 750 buckets/s
const RING_CAPACITY      = 1024       // matches engine ring depth

// ── Shared subscription registry ────────────────────────────────────────────
//
// Multiple visualizer nodes (level history, GR strip, transfer curve) on the
// same Compressor instance must NOT each call setEffectVisualizationEnabled
// or each pump a separate rAF. We keep a refcount per (trackId, nodeId).

const subscriptions = new Map() // key: "trackId:nodeId:vizType" → entry

function keyFor(trackId, nodeId, vizType) {
  return `${trackId}:${nodeId}:${vizType}`
}

function bucketLayoutFor(vizType) {
  if (vizType === VIZ_TYPE.LIMITER)   return LIMITER_BUCKET
  if (vizType === VIZ_TYPE.TRANSIENT) return TRANSIENT_BUCKET
  if (vizType === VIZ_TYPE.MULTIBAND) return MULTIBAND_BUCKET
  if (vizType === VIZ_TYPE.RESONANCE) return RESONANCE_BUCKET
  return COMPRESSOR_BUCKET
}

function makeRing(capacity) {
  return {
    buckets: new Array(capacity).fill(null),
    capacity,
    head: 0,    // next write index
    count: 0,   // number of valid items, max == capacity
    push(b) {
      this.buckets[this.head] = b
      this.head = (this.head + 1) % this.capacity
      if (this.count < this.capacity) this.count++
    },
    forEachInOrder(fn) {
      const start = (this.head - this.count + this.capacity) % this.capacity
      for (let i = 0; i < this.count; i++) {
        fn(this.buckets[(start + i) % this.capacity], i)
      }
    },
    last() {
      if (this.count === 0) return null
      const idx = (this.head - 1 + this.capacity) % this.capacity
      return this.buckets[idx]
    },
    clear() {
      this.head = 0
      this.count = 0
    },
  }
}

function acquire(trackId, nodeId, vizType) {
  const key = keyFor(trackId, nodeId, vizType)
  let entry = subscriptions.get(key)
  if (entry) {
    entry.refCount++
    return entry
  }

  entry = {
    key,
    trackId,
    nodeId,
    vizType,
    refCount: 1,
    ring: makeRing(RING_CAPACITY),
    epochObj: { value: 0 },
    schemaObj: { value: 0, type: VIZ_TYPE.UNKNOWN, ok: false, reason: 'pending' },
    rafId: 0,
    lastDrainAt: 0,
    inFlight: false,
    cancelled: false,
    enableSent: false,
    drainErrorCount: 0,
    drainErrorLogged: false,
  }
  subscriptions.set(key, entry)

  // Best-effort enable. If the API isn't available, we just stay disabled
  // and the painter renders "Visualization unavailable".
  const api = window?.xleth?.audio
  if (api && typeof api.setEffectVisualizationEnabled === 'function') {
    Promise.resolve(api.setEffectVisualizationEnabled(trackId, nodeId, true))
      .then(() => { entry.enableSent = true })
      .catch(() => { /* node may be gone; pump loop will produce no frames */ })
  } else {
    entry.schemaObj.ok     = false
    entry.schemaObj.reason = 'no-engine-api'
  }

  startPumpLoop(entry)
  return entry
}

function release(entry) {
  entry.refCount--
  if (entry.refCount > 0) return
  entry.cancelled = true
  if (entry.rafId) {
    cancelAnimationFrame(entry.rafId)
    entry.rafId = 0
  }
  subscriptions.delete(entry.key)
  const api = window?.xleth?.audio
  if (api && typeof api.setEffectVisualizationEnabled === 'function') {
    // Fire-and-forget. If the effect was already removed by the engine
    // (deletion race), this resolves false; we don't care.
    Promise.resolve(api.setEffectVisualizationEnabled(entry.trackId, entry.nodeId, false))
      .catch(() => { /* effect may already be removed; nothing to do */ })
  }
}

function startPumpLoop(entry) {
  const tick = () => {
    if (entry.cancelled) return

    const now = performance.now()
    const due = now - entry.lastDrainAt >= TARGET_INTERVAL_MS

    if (due && !entry.inFlight) {
      entry.lastDrainAt = now
      entry.inFlight    = true
      const api = window?.xleth?.audio
      if (!api || typeof api.drainEffectVizFrames !== 'function') {
        entry.inFlight = false
        entry.schemaObj.ok     = false
        entry.schemaObj.reason = 'no-engine-api'
      } else {
        Promise.resolve(api.drainEffectVizFrames(entry.trackId, entry.nodeId, DRAIN_MAX_BUCKETS))
          .then((resp) => {
            entry.inFlight = false
            if (entry.cancelled) return // stale: target changed/unmounted
            consumeDrainResponse(entry, resp)
          })
          .catch((err) => {
            entry.inFlight = false
            entry.drainErrorCount++
            // Log once per subscription so we don't spam during effect deletion.
            if (!entry.drainErrorLogged) {
              entry.drainErrorLogged = true
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[DynamicsViz] drain error (will retry quietly):', err?.message || err)
              }
            }
          })
      }
    }

    entry.rafId = requestAnimationFrame(tick)
  }
  entry.rafId = requestAnimationFrame(tick)
}

function consumeDrainResponse(entry, resp) {
  // Decode buckets according to the viz type the subscriber asked for. If the
  // engine reports a different type (e.g. effect was replaced), parser fails
  // with 'type-mismatch:...' and the canvas falls back to the placeholder.
  const parsed = parseDrainResponse(resp, entry.vizType)
  entry.schemaObj.value  = resp?.schema | 0
  entry.schemaObj.type   = resp?.type ?? VIZ_TYPE.UNKNOWN
  entry.schemaObj.ok     = parsed.ok
  entry.schemaObj.reason = parsed.ok ? null : parsed.reason

  if (!parsed.ok || parsed.count === 0) return

  for (let i = 0; i < parsed.count; i++) {
    const b = parsed.decode(i)
    if (b) entry.ring.push(b)
  }
  entry.epochObj.value = (entry.epochObj.value + 1) | 0
}

// ── React hook ──────────────────────────────────────────────────────────────
//
// trackId / nodeId can be null while the panel is mounting; the hook still
// returns the same handle, but its ringRef.current stays null until the
// useEffect resolves a real subscription.
//
// The returned handle is identity-stable across renders, and so are the refs
// it contains. This lets consumers (DynamicsVisualizerCanvas) put the handle
// in a useEffect dep array without re-running on unrelated parent re-renders
// (e.g. a knob change updating params).
//
// vizType selects the bucket schema to decode against (Compressor or Limiter).
// Defaults to Compressor for backwards compatibility with existing call sites.
export function useDynamicsVizSubscription(trackId, nodeId, vizType = VIZ_TYPE.COMPRESSOR) {
  const handleRef = useRef(null)
  if (!handleRef.current) {
    handleRef.current = {
      ringRef:       { current: null },
      epochRef:      { current: null },
      schemaRef:     { current: null },
      bucketLayout:  bucketLayoutFor(vizType),
      schemaVersion: DYNAMICS_VIZ_SCHEMA_VERSION,
      vizType,
    }
  } else {
    handle_updateVizType(handleRef.current, vizType)
  }
  const handle = handleRef.current

  useEffect(() => {
    if (trackId == null || nodeId == null) {
      handle.ringRef.current   = null
      handle.epochRef.current  = null
      handle.schemaRef.current = null
      return
    }
    const entry = acquire(trackId, nodeId, vizType)
    handle.ringRef.current   = entry.ring
    handle.epochRef.current  = entry.epochObj
    handle.schemaRef.current = entry.schemaObj
    return () => {
      release(entry)
      // Only null out our refs if they still point at THIS entry. Edge case:
      // a fast unmount→mount on the same handle could swap entries before
      // cleanup of the previous one fires.
      if (handle.ringRef.current === entry.ring)        handle.ringRef.current = null
      if (handle.epochRef.current === entry.epochObj)   handle.epochRef.current = null
      if (handle.schemaRef.current === entry.schemaObj) handle.schemaRef.current = null
    }
  }, [trackId, nodeId, vizType, handle])

  return handle
}

function handle_updateVizType(handle, vizType) {
  if (handle.vizType === vizType) return
  handle.vizType      = vizType
  handle.bucketLayout = bucketLayoutFor(vizType)
}

// Exposed for tests / dev assertions only.
export const __debug = { subscriptions, RING_CAPACITY, TARGET_HZ }

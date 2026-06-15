/**
 * Singleton transport-state poller.
 * Shared interval serves all consumers — eliminates duplicate IPC traffic.
 *
 * During playback: polls every 200ms (drift correction only — PlayheadClock
 * handles 60fps interpolation). While stopped: polls every 33ms for responsive
 * seeking and state changes.
 */

import { playheadClock } from './services/PlayheadClock.js'

let currentState = null
const listeners = new Set()
let intervalId = null

let pollMs = 33      // ~30 fps when stopped, 200ms during playback
let wasPlaying = false

function startPolling() {
  if (intervalId !== null) return
  intervalId = setInterval(async () => {
    try {
      const s = await window.xleth?.getTransportState()
      if (s) {
        currentState = s

        // Feed the arranger/edit playhead from raw musical timeline time.
        // `position*` is presentation-latency compensated for video/output
        // diagnostics; using it here makes stopped seeks visibly jump left.
        playheadClock.syncFromEngine(
          s.rawPositionMs ?? s.positionMs,
          s.bpm,
          s.isPlaying,
          s.rawPositionBeats ?? s.positionBeats,
        )

        // Adjust poll rate on play/stop transitions
        if (s.isPlaying !== wasPlaying) {
          wasPlaying = s.isPlaying
          const newRate = s.isPlaying ? 200 : 33
          if (newRate !== pollMs) {
            pollMs = newRate
            clearInterval(intervalId)
            intervalId = null
            startPolling()
          }
        }

        for (const fn of listeners) fn(s)
      }
    } catch { /* engine not ready */ }
  }, pollMs)
}

function stopPolling() {
  if (intervalId === null) return
  clearInterval(intervalId)
  intervalId = null
  wasPlaying = false
  pollMs = 33
}

/** Subscribe to transport updates. Returns an unsubscribe function. */
export function subscribe(callback) {
  listeners.add(callback)
  if (listeners.size === 1) startPolling()
  if (currentState) callback(currentState)
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0) stopPolling()
  }
}

/** Read the latest cached state synchronously (no IPC). */
export function getTransportState() {
  return currentState
}

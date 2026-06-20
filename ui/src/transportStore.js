/**
 * Singleton transport-state poller.
 * Shared interval serves all consumers — eliminates duplicate IPC traffic.
 *
 * Fixed 250ms (4 Hz). Previously dual-rate (33ms stopped / 200ms playing):
 * the 33ms stopped rate is a full IPC round-trip 30×/sec on the JUCE message
 * thread. Under complex projects with the sidecar this caused audio underruns.
 * PlayheadClock handles smooth 60fps display interpolation during playback;
 * seeking responsiveness is acceptable at 250ms (one poll = one position update).
 */

import { playheadClock } from './services/PlayheadClock.js'

let currentState = null
const listeners = new Set()
let intervalId = null

const POLL_MS = 250  // 4 Hz — pipe-friendly; PlayheadClock interpolates display

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

        for (const fn of listeners) fn(s)
      }
    } catch { /* engine not ready */ }
  }, POLL_MS)
}

function stopPolling() {
  if (intervalId === null) return
  clearInterval(intervalId)
  intervalId = null
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

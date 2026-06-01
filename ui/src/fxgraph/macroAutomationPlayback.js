// FXG.4-h — control-rate macro automation playback controller.
//
// Subscribes to the shared transport poller and, on each tick, asks the
// effectChainStore to evaluate every graph-mode track's macro automation lanes at
// the current timeline tick and drive the resulting Macro normalizedValue through
// the existing FXG.4-e/f macro→parameter edge path. This is intentionally
// control-rate / timeline-rate (NOT sample-accurate, NOT on the audio thread):
// macro drive is already a renderer-side, control-rate concern in FXG.4-e/f, so
// automation playback lives in the same place. Playback never mutates graphState
// or the persisted macro value — it only drives parameters at runtime.

import { subscribe as subscribeTransport } from '../transportStore.js'
import useEffectChainStore from '../stores/effectChainStore.js'
import { PPQ } from '../constants/timeline.js'

// Pure: convert a transport position in milliseconds to an integer timeline tick.
export function positionMsToTick(positionMs, bpm, ppq = PPQ) {
  if (!Number.isFinite(positionMs) || !Number.isFinite(bpm) || bpm <= 0) return 0
  const beats = (positionMs / 1000) * (bpm / 60)
  const tick = Math.round(beats * ppq)
  return tick < 0 ? 0 : tick
}

// Starts the controller. Dependencies are injectable for testing. Returns an
// unsubscribe function.
export function startMacroAutomationPlayback(deps = {}) {
  const subscribe = deps.subscribe ?? subscribeTransport
  const getStore = deps.getStore ?? (() => useEffectChainStore.getState())
  const options = deps.options ?? {}
  let lastIsPlaying = null

  const handleTransport = (transport) => {
    if (!transport) return
    const store = getStore()
    if (!store) return

    // On any play/stop transition, reset the last-applied cache so the next tick
    // re-drives from the current position (handles seek-while-stopped and resume).
    if (transport.isPlaying !== lastIsPlaying) {
      lastIsPlaying = transport.isPlaying
      store.resetMacroAutomationRuntime?.()
    }

    const tick = positionMsToTick(transport.positionMs, transport.bpm)
    // Fire-and-forget: the store dedupes redundant writes and never throws.
    void store.applyMacroAutomationAtTick?.(tick, options)
  }

  return subscribe(handleTransport)
}

import { useRef, useEffect } from 'react'
import * as METER_SLOTS from '../../constants/meterSlots.js'

const POLL_INTERVAL_MS = 33  // ~30 Hz

// Resolves a semantic slot name like 'GAIN_REDUCTION' → slot index (2).
function resolveSlotIndex(slotName) {
  const idx = METER_SLOTS[slotName]
  return typeof idx === 'number' ? idx : -1
}

// Returns a stable meterBus object: { register, unregister }.
// MeterNode components register a DOM-update callback on mount and unregister on unmount.
// The polling loop drives all registered callbacks at ~30 Hz using raw DOM writes,
// matching the pattern in the legacy Compressor/Limiter/OTT/TransientProc panels.
export function useMeterBus() {
  const callbacksRef = useRef(new Map())  // nodeId → { slotIndex, update: (value) => void }

  const meterBus = useRef({
    register(nodeId, slotName, updateFn) {
      const slotIndex = resolveSlotIndex(slotName)
      if (slotIndex < 0) {
        console.warn(`[PluginUI] Unknown meter slot: "${slotName}"`)
        return
      }
      callbacksRef.current.set(nodeId, { slotIndex, update: updateFn })
    },
    unregister(nodeId) {
      callbacksRef.current.delete(nodeId)
    },
    _callbacks: callbacksRef,
  }).current

  return meterBus
}

// Runs one requestAnimationFrame polling loop while target is non-null.
// Calls each registered callback with its slot value after every poll tick.
export function useEffectMeterPolling(target, meterBus) {
  const rafRef      = useRef(null)
  const lastPollRef = useRef(0)

  useEffect(() => {
    if (!target) return

    const { trackId, nodeId } = target
    let active = true

    async function poll() {
      if (!active) return

      const now = performance.now()
      if (now - lastPollRef.current >= POLL_INTERVAL_MS) {
        lastPollRef.current = now
        try {
          const raw    = await window.xleth?.audio?.getEffectMeter(trackId, nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(meters) && active) {
            for (const [, entry] of meterBus._callbacks.current) {
              const value = meters[entry.slotIndex] ?? 0
              entry.update(value)
            }
          }
        } catch {
          // Silent: meter read can fail on close; the rAF loop keeps running
        }
      }

      rafRef.current = requestAnimationFrame(poll)
    }

    rafRef.current = requestAnimationFrame(poll)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [target, meterBus])
}

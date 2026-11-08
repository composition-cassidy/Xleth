import { useEffect, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { decodeLiveState, hasAnyModulator } from '../../stores/filterStore.js'

// The Xleth Filter's live frame plumbing (the editor's, lifted out unchanged).
// The engine's live state arrives ~30 times a second. None of it goes through
// React state: the device owns one Set of subscribers, the poll loop hands each of
// them the decoded frame, and each subscriber paints straight into a canvas or a
// DOM node it already holds. A setState at frame rate would re-render every knob
// and select in the device for a number two pixels care about.

/** Subscribe `fn` to the live-frame bus for the lifetime of the component. */
export function useLiveFrame(bus, fn) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!bus) return undefined
    // The registered callback is stable for the subscriber's lifetime and reads the
    // latest closure through the ref, so a re-render never churns the Set.
    const cb = (frame) => fnRef.current(frame)
    bus.add(cb)
    return () => { bus.delete(cb) }
  }, [bus])
}

/**
 * One rAF loop, throttled to ~30 Hz, that pulls the engine's live state and hands
 * it to every subscriber. It exists only while the filter actually has a modulator
 * (a filter that is only knobs never starts it and never costs a poll) and stops
 * when the device unmounts. Returns { bus, liveRef }.
 */
export function useFilterLiveLoop(store) {
  const target = useStore(store, (s) => s.target)
  const slots = useStore(store, (s) => s.slots)
  const liveRef = useRef(null)
  const bus = useMemo(() => new Set(), [])
  const modulated = useMemo(() => hasAnyModulator(slots), [slots])

  useEffect(() => {
    if (!target || !modulated) {
      // Drop any stale frame so the display falls straight back to the parked
      // picture rather than freezing on the last modulated one.
      if (liveRef.current) {
        liveRef.current = null
        bus.forEach((cb) => cb(null))
      }
      return undefined
    }

    let active = true
    let rafId = 0
    let last = 0
    let inFlight = false

    const tick = async (now) => {
      if (!active) return
      // A hidden window still fires rAF in some Electron configurations; there is
      // nothing to look at, so there is nothing to poll for.
      if (now - last >= 33 && !inFlight && !document.hidden) {
        last = now
        inFlight = true
        try {
          const buf = await store.getState().fetchLiveState()
          const frame = decodeLiveState(buf)
          if (active && frame) {
            liveRef.current = frame
            bus.forEach((cb) => cb(frame))
          }
        } catch {
          // A chain torn down between two frames is not worth logging 30 times a second.
        } finally {
          inFlight = false
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafId)
      liveRef.current = null
    }
  }, [store, target, modulated, bus])

  return { bus, liveRef }
}

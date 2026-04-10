import { useState, useRef, useCallback } from 'react'

export default function useTimelineScroll() {
  const [scrollOffset, setScrollOffsetState] = useState(0)
  const scrollOffsetRef = useRef(0)
  const maxScrollRef = useRef(Infinity)

  const applyScroll = useCallback((beats) => {
    const clamped = Math.max(0, Math.min(maxScrollRef.current, beats))
    scrollOffsetRef.current = clamped
    setScrollOffsetState(clamped)
    return clamped
  }, [])

  const scrollBy = useCallback((deltaBeats) => {
    return applyScroll(scrollOffsetRef.current + deltaBeats)
  }, [applyScroll])

  const scrollTo = useCallback((beat) => {
    return applyScroll(beat)
  }, [applyScroll])

  // Scroll forward only — when playhead exits the right 80% edge.
  // Never pulls view backward (user stays in control of leftward scrolling).
  const ensureVisible = useCallback((beat, canvasWidth, ppb) => {
    const visibleBeats = canvasWidth / ppb
    const scroll = scrollOffsetRef.current
    if (beat > scroll + visibleBeats * 0.8) {
      applyScroll(beat - visibleBeats * 0.2)
    }
  }, [applyScroll])

  const setMaxScroll = useCallback((max) => {
    maxScrollRef.current = Math.max(0, max)
  }, [])

  return {
    scrollOffset, scrollOffsetRef, maxScrollRef,
    applyScroll, scrollBy, scrollTo, ensureVisible, setMaxScroll,
  }
}

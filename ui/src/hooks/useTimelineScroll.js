import { useState, useRef, useCallback, useEffect } from 'react'

// How long to wait after the last applyScroll() before syncing React state.
// Only affects DOM-positioned consumers (badges, scrollbar, LoopRegionBar) —
// the draw path never waits on this, see onCommit below.
const SETTLE_MS = 100

export default function useTimelineScroll(onCommit) {
  const [scrollOffset, setScrollOffsetState] = useState(0)
  const scrollOffsetRef = useRef(0)
  const maxScrollRef = useRef(Infinity)

  // Latest onCommit, refreshed every render so applyScroll (stable identity,
  // deps: []) always invokes the current callback without needing to be
  // recreated when the caller's closure changes.
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const settleTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(settleTimerRef.current), [])

  const applyScroll = useCallback((beats) => {
    const clamped = Math.max(0, Math.min(maxScrollRef.current, beats))
    scrollOffsetRef.current = clamped

    if (onCommitRef.current) {
      // Hot path: the ref is already the source of truth, so redraw now,
      // synchronously, with no React render in between.
      onCommitRef.current(clamped)
      // Trailing-edge sync: React state (and everything derived from it —
      // badges, scrollbar, LoopRegionBar) catches up ~100ms after the
      // gesture stops, instead of on every wheel/pan tick.
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = setTimeout(() => {
        setScrollOffsetState(scrollOffsetRef.current)
      }, SETTLE_MS)
    } else {
      // No onCommit supplied: preserve the original synchronous-state
      // behavior (used by callers that don't drive their own redraw path).
      setScrollOffsetState(clamped)
    }

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

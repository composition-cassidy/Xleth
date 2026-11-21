import { useCallback, useEffect, useState } from 'react'
import { timelineEvents } from '../../../timelineEvents.js'

/**
 * The timeline's tracks, refetched whenever any surface reports a change
 * ('timeline-tracks-changed', which videoFxWrites.js dispatches after every write,
 * and 'timeline-grid-changed'). Read-only: getTracks is the same call the
 * Inspector's track view makes.
 */
export default function useVideoTracks() {
  const [tracks, setTracks] = useState([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const all = await window.xleth?.timeline?.getTracks?.()
      if (Array.isArray(all)) setTracks(all)
    } catch (e) {
      console.warn('[VideoFx] getTracks failed:', e?.message)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    timelineEvents.addEventListener('timeline-tracks-changed', refresh)
    timelineEvents.addEventListener('timeline-grid-changed', refresh)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', refresh)
      timelineEvents.removeEventListener('timeline-grid-changed', refresh)
    }
  }, [refresh])

  return { tracks, loaded, refresh }
}

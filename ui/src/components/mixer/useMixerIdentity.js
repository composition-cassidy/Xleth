import { useEffect, useState } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'

/**
 * { [trackId]: '#RRGGBB' } for the mixer strips: the same identity colour the
 * arrangement lane, the device chain and the layer list use. The mixer store does
 * not carry colour fields, so the timeline's own track list is read (and kept
 * fresh on timeline-tracks-changed), as DeviceChain does.
 */
export default function useMixerIdentity() {
  const [timelineTracks, setTimelineTracks] = useState([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const t = await window.xleth?.timeline?.getTracks?.()
        if (alive && Array.isArray(t)) setTimelineTracks(t)
      } catch (e) {
        console.warn('[Mixer] getTracks (identity colours) failed:', e?.message)
      }
    }
    load()
    timelineEvents.addEventListener('timeline-tracks-changed', load)
    return () => { alive = false; timelineEvents.removeEventListener('timeline-tracks-changed', load) }
  }, [])
  return useTrackIdentityColors(timelineTracks)
}

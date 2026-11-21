import { useEffect, useState } from 'react'
import { timelineEvents } from '../../../timelineEvents.js'
import useTrackIdentityColors from '../../../components/inspector/useTrackIdentityColors.js'

// The identity colour of one track, resolved the way the arrangement and the Devices chain
// resolve it (the same palette, the same auto colour), so the FX Graph header wears the
// colour the track has everywhere else. undefined for no track or one with no colour yet.
export default function useTrackIdentityColor(trackId) {
  const [tracks, setTracks] = useState([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const list = await window.xleth?.timeline?.getTracks?.()
        if (alive && Array.isArray(list)) setTracks(list)
      } catch (error) {
        console.warn('[FXG] getTracks failed:', error?.message)
      }
    }
    load()
    timelineEvents.addEventListener('timeline-tracks-changed', load)
    return () => { alive = false; timelineEvents.removeEventListener('timeline-tracks-changed', load) }
  }, [])
  const colors = useTrackIdentityColors(tracks)
  return typeof trackId === 'number' ? colors[trackId] : undefined
}

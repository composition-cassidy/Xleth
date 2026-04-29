import { useState, useEffect, useCallback } from 'react'
import { timelineEvents } from '../timelineEvents.js'
import TrackCard from './grid/TrackCard.jsx'
import GridSettingsPanel from './grid/GridSettingsPanel.jsx'

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  chorusTrackId: -1, crashEnabled: false, crashTrackId: -1, crashOpacity: 0.7,
  previewFps: 30, gapScale: 0,
}

export default function GridLayoutTab() {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [tracks, setTracks] = useState([])

  const fetchLayout = useCallback(async () => {
    try {
      const l = await window.xleth?.timeline?.getGridLayout()
      if (l) setLayout(l)
    } catch (e) {
      console.error('[GridLayoutTab] getGridLayout failed:', e)
    }
  }, [])

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (Array.isArray(t)) setTracks(t)
    } catch (e) {
      console.error('[GridLayoutTab] getTracks failed:', e)
    }
  }, [])

  useEffect(() => {
    fetchLayout()
    fetchTracks()
    const onGrid   = () => fetchLayout()
    const onTracks = () => fetchTracks()
    timelineEvents.addEventListener('timeline-grid-changed',  onGrid)
    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    return () => {
      timelineEvents.removeEventListener('timeline-grid-changed',  onGrid)
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
    }
  }, [fetchLayout, fetchTracks])

  const applyCornerRadiusToAll = useCallback(async (value) => {
    const tl = window.xleth?.timeline
    if (!tl) return
    for (const t of tracks) await tl.setTrackCornerRadius(t.id, value)
    fetchTracks()
  }, [tracks, fetchTracks])

  const slotByTrack  = new Map(layout.slots.map(s => [s.trackId, s]))
  const chorusTrack  = tracks.find(t => t.id === layout.chorusTrackId)
  const crashTrack   = tracks.find(t => t.id === layout.crashTrackId)

  return (
    <div className="grid-tab">
      <GridSettingsPanel layout={layout} setLayout={setLayout} tracks={tracks} />

      <div className="grid-tab-section">
        <h3>Tracks</h3>
        {tracks.length === 0 ? (
          <div className="grid-tab-empty">No tracks yet</div>
        ) : (
          <div className="grid-tab-track-list">
            {tracks.map(t => {
              const slot   = slotByTrack.get(t.id)
              const badges = []
              if (chorusTrack?.id === t.id) badges.push('chorus')
              if (layout.crashEnabled && crashTrack?.id === t.id) badges.push('crash')
              return (
                <TrackCard
                  key={t.id}
                  track={t}
                  slot={slot}
                  badges={badges}
                  gapScale={layout.gapScale ?? 0}
                  fetchTracks={fetchTracks}
                  applyCornerRadiusToAll={applyCornerRadiusToAll}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

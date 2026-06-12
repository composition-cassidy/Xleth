import { useState, useEffect, useCallback } from 'react'
import { timelineEvents } from '../timelineEvents.js'
import TrackCard from './grid/TrackCard.jsx'
import GridSettingsPanel from './grid/GridSettingsPanel.jsx'
import useGridEditStore from '../stores/useGridEditStore.js'

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  fullscreenLayers: [],
  previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
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

  const gridEditMode = useGridEditStore(s => s.gridEditMode)

  const slotByTrack    = new Map(layout.slots.map(s => [s.trackId, s]))
  const fsLayers       = layout.fullscreenLayers ?? []
  const behindTrackIds = new Set(fsLayers.filter(l => l.placement === 'behind').map(l => l.trackId))
  const frontTrackIds  = new Set(fsLayers.filter(l => l.placement === 'front').map(l => l.trackId))
  const firstBehindTrack = tracks.find(t => behindTrackIds.has(t.id))
  const placedCount    = tracks.filter(t => slotByTrack.has(t.id)).length
  const unplacedCount  = tracks.length - placedCount

  return (
    <div className="grid-tab">
      <GridSettingsPanel layout={layout} setLayout={setLayout} tracks={tracks} />

      <div className="grid-tab-section grid-tab-section--separated">
        <h3>Tracks</h3>
        {tracks.length === 0 ? (
          <div className="grid-tab-empty">No tracks yet</div>
        ) : gridEditMode ? (
          <div className="grid-tab-track-summary">
            <div className="grid-tab-summary-stat">
              <span className="grid-tab-summary-val">{placedCount}</span>
              <span className="grid-tab-summary-label">placed</span>
            </div>
            <div className="grid-tab-summary-stat">
              <span className="grid-tab-summary-val">{unplacedCount}</span>
              <span className="grid-tab-summary-label">free</span>
            </div>
            <div className="grid-tab-summary-stat">
              <span className="grid-tab-summary-val">{tracks.length}</span>
              <span className="grid-tab-summary-label">total</span>
            </div>
            {fsLayers.length > 0 && (
              <div className="grid-tab-summary-backing">
                <span className="grid-tab-summary-backing-label">Fullscreen</span>
                <span className="grid-tab-summary-backing-val">
                  {fsLayers.filter(l => l.placement === 'behind').length} Behind
                  {' · '}
                  {fsLayers.filter(l => l.placement === 'front').length} Front
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="grid-tab-track-list">
            {tracks.map(t => {
              const slot   = slotByTrack.get(t.id)
              const badges = []
              if (behindTrackIds.has(t.id)) badges.push('behind')
              if (frontTrackIds.has(t.id))  badges.push('front')
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

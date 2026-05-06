import { useState, useEffect, useCallback, useMemo } from 'react'
import { timelineEvents } from '../timelineEvents.js'
import { setActiveDragTrackId } from './gridEditorDragState.js'

const VALID_SUBDIVISION_FACTORS = [1, 2, 4, 8]

export default function GridEditorDock() {
  const [tracks, setTracks] = useState([])
  const [slots, setSlots]   = useState([])
  const [dockFilter, setDockFilter] = useState('all')

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (Array.isArray(t)) setTracks(t)
    } catch (e) {
      console.error('[GridEditorDock] getTracks failed:', e)
    }
  }, [])

  const fetchLayout = useCallback(async () => {
    try {
      const l = await window.xleth?.timeline?.getGridLayout()
      if (l) setSlots(l.slots ?? [])
    } catch (e) {
      console.error('[GridEditorDock] getGridLayout failed:', e)
    }
  }, [])

  useEffect(() => {
    fetchTracks()
    fetchLayout()
    const onGrid   = () => fetchLayout()
    const onTracks = () => { fetchTracks(); fetchLayout() }
    timelineEvents.addEventListener('timeline-grid-changed',  onGrid)
    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    return () => {
      timelineEvents.removeEventListener('timeline-grid-changed',  onGrid)
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
    }
  }, [fetchTracks, fetchLayout])

  const slotsByTrackId = useMemo(() => {
    const m = new Map()
    for (const s of slots) m.set(s.trackId, s)
    return m
  }, [slots])

  const placedCount   = slotsByTrackId.size
  const unplacedCount = Math.max(0, tracks.length - placedCount)

  const dockTracks = dockFilter === 'placed'
    ? tracks.filter(t => slotsByTrackId.has(t.id))
    : dockFilter === 'unplaced'
      ? tracks.filter(t => !slotsByTrackId.has(t.id))
      : tracks

  const handleDragStart = useCallback((e, trackId) => {
    setActiveDragTrackId(trackId)
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('application/x-xleth-track', String(trackId))
  }, [])

  const handleDragEnd = useCallback(() => {
    setActiveDragTrackId(null)
  }, [])

  return (
    <div className="grid-editor-dock">
      <div className="grid-editor-dock-header">
        <span className="grid-editor-dock-title">Tracks</span>
        <div className="grid-editor-dock-filters">
          {[
            { key: 'all',      label: 'All',      count: tracks.length },
            { key: 'unplaced', label: 'Unplaced', count: unplacedCount },
            { key: 'placed',   label: 'Placed',   count: placedCount   },
          ].map(f => (
            <button
              key={f.key}
              className={`grid-editor-dock-filter${dockFilter === f.key ? ' active' : ''}`}
              onClick={() => setDockFilter(f.key)}
            >
              {f.label}
              <span className="grid-editor-dock-count">{f.count}</span>
            </button>
          ))}
        </div>
        <span className="grid-editor-dock-hint">drag onto grid</span>
      </div>
      <div className="grid-editor-dock-strip">
        {dockTracks.length === 0 ? (
          <div className="grid-editor-dock-empty">
            {dockFilter === 'placed'   ? 'No tracks placed yet' :
             dockFilter === 'unplaced' ? 'All tracks placed'    :
             'No tracks available'}
          </div>
        ) : dockTracks.map(t => {
          const placed = slotsByTrackId.has(t.id)
          const f = VALID_SUBDIVISION_FACTORS.includes(t.subdivisionFactor)
            ? t.subdivisionFactor : 1
          const typeLabel = t.type === 'Pattern' ? 'PAT'
            : t.type === 'Clip' ? 'CLIP'
            : t.type ? t.type.slice(0, 4).toUpperCase() : null
          return (
            <div
              key={t.id}
              className={`grid-editor-dock-chip${placed ? ' placed' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, t.id)}
              onDragEnd={handleDragEnd}
              title={placed
                ? `${t.name} — on grid (drag to move)`
                : `${t.name} — drag to place`}
            >
              {typeLabel && (
                <span className="grid-editor-dock-chip-type">{typeLabel}</span>
              )}
              <span className="grid-editor-dock-chip-name">{t.name}</span>
              {f > 1 && (
                <span className="grid-editor-dock-chip-factor">{f}×</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

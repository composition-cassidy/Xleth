import { useState, useEffect, useCallback, useMemo } from 'react'
import { SegmentedControl } from '../ui-kit'
import { timelineEvents } from '../timelineEvents.js'
import { setActiveDragTrackId } from './gridEditorDragState.js'
import useGridEditStore from '../stores/useGridEditStore.js'
import useTrackIdentityColors from './inspector/useTrackIdentityColors.js'
import VideoTrackList from './timeline/VideoTrackList.jsx'
import styles from './GridEditorDock.module.css'

const VALID_SUBDIVISION_FACTORS = [1, 2, 4, 8]

const VIEWS = [
  { value: 'place', label: 'Place', hint: 'Tracks to drag onto the grid' },
  { value: 'layers', label: 'Layers', hint: 'Compositing order: drag to reorder, frontmost at the top' },
]

/**
 * The strip under the picture in Edit Grid mode. "Place" lists tracks to drag
 * onto the grid; "Layers" is the compositing stack (every placed track by real
 * zOrder, drag to reorder). Both carry each track's identity colour.
 */
export default function GridEditorDock() {
  const view    = useGridEditStore((s) => s.stripView)
  const setView = useGridEditStore((s) => s.setStripView)
  const [tracks, setTracks] = useState([])
  const [layout, setLayout] = useState(null)
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
      if (l) setLayout(l)
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

  const identity = useTrackIdentityColors(tracks)
  const slots = layout?.slots ?? []
  const slotsByTrackId = useMemo(() => {
    const m = new Map()
    for (const s of slots) m.set(s.trackId, s)
    return m
  }, [slots])

  const placedCount   = slotsByTrackId.size
  const unplacedCount = Math.max(0, tracks.length - placedCount)

  const dockTracks = dockFilter === 'placed'
    ? tracks.filter((t) => slotsByTrackId.has(t.id))
    : dockFilter === 'unplaced'
      ? tracks.filter((t) => !slotsByTrackId.has(t.id))
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
    <div className={styles.dock} data-testid="grid-editor-dock">
      <div className={styles.header}>
        <SegmentedControl size="sm" label="Grid strip" value={view} onChange={setView} options={VIEWS} />
        {view === 'place' && (
          <>
            <SegmentedControl
              size="sm"
              label="Show tracks"
              value={dockFilter}
              onChange={setDockFilter}
              options={[
                { value: 'all', label: `All ${tracks.length}` },
                { value: 'unplaced', label: `Unplaced ${unplacedCount}` },
                { value: 'placed', label: `Placed ${placedCount}` },
              ]}
            />
            <span className={styles.hint}>Drag a track onto the picture</span>
          </>
        )}
      </div>

      {view === 'layers' ? (
        <div className={styles.layers}>
          <VideoTrackList tracks={tracks} layout={layout ?? { slots: [], fullscreenLayers: [] }} identity={identity} />
        </div>
      ) : (
        <div className={styles.strip}>
          {dockTracks.length === 0 ? (
            <p className={styles.empty}>
              {dockFilter === 'placed' ? 'No tracks placed yet.' :
               dockFilter === 'unplaced' ? 'Every track is placed.' :
               'No tracks. Add a track in the arrangement.'}
            </p>
          ) : dockTracks.map((t) => {
            const placed = slotsByTrackId.has(t.id)
            const f = VALID_SUBDIVISION_FACTORS.includes(t.subdivisionFactor) ? t.subdivisionFactor : 1
            return (
              <div
                key={t.id}
                className={styles.chip}
                data-placed={placed || undefined}
                style={{ '--track-color': identity[t.id] }}
                draggable
                onDragStart={(e) => handleDragStart(e, t.id)}
                onDragEnd={handleDragEnd}
                title={placed ? `${t.name}: on the grid (drag to move)` : `${t.name}: drag to place`}
              >
                <span className={styles.chipName}>{t.name}</span>
                {t.type === 'Pattern' && <span className={styles.chipMeta}>pattern</span>}
                {f > 1 && <span className={styles.chipMeta}>{f}×</span>}
                {placed && <span className={styles.chipMeta}>placed</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

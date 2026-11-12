import { useState, useEffect, useCallback, useMemo } from 'react'
import { SegmentedControl } from '../ui-kit'
import { timelineEvents } from '../timelineEvents.js'
import { setActiveDragTrackId } from './gridEditorDragState.js'
import useGridEditStore from '../stores/useGridEditStore.js'
import useInspectorStore, { revealInspector } from '../stores/useInspectorStore.js'
import useTrackIdentityColors from './inspector/useTrackIdentityColors.js'
import VideoTrackList from './timeline/VideoTrackList.jsx'
import TrackContextMenu from './timeline/TrackContextMenu.jsx'
import { assignTrackToGrid, buildPlacementMenuItems, getTrackPlacement } from './timeline/trackPlacement.js'
import styles from './GridEditorDock.module.css'
import { iconComponent } from '../ui-kit/icons'

const IcDotsSixVertical = iconComponent('dots-six-vertical')

const VIEWS = [
  { value: 'place', label: 'Place', hint: 'Tracks to drag onto the grid' },
  { value: 'layers', label: 'Layers', hint: 'Compositing order: drag to reorder, frontmost at the top' },
]

/** Where a track sits, as short as the rail allows ("2,0" is column, row). */
export function placementText(p) {
  switch (p.kind) {
    case 'grid':   return `${p.cell.col},${p.cell.row}`
    case 'behind': return 'Behind'
    case 'front':  return 'Front'
    default:       return 'Not placed'
  }
}

/**
 * The track rail beside the picture in Edit Grid mode. "Place" lists every
 * track as one 24px row (identity stripe, name, its cell) to drag onto the
 * picture; "Layers" is the compositing stack (every placed track by real
 * zOrder, drag to reorder). Every drag has a keyboard alternative: Enter on an
 * unplaced row places it in the next free cell, Enter on a placed row shows it
 * in the Inspector, and the context menu carries the placement actions.
 */
export default function GridEditorDock() {
  const view    = useGridEditStore((s) => s.stripView)
  const setView = useGridEditStore((s) => s.setStripView)
  const requestTrackSelection = useInspectorStore((s) => s.requestTrackSelection)
  const [tracks, setTracks] = useState([])
  const [layout, setLayout] = useState(null)
  const [dockFilter, setDockFilter] = useState('all')
  const [menu, setMenu] = useState(null) // { track, x, y }

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

  const activate = useCallback((track) => {
    const p = getTrackPlacement(track.id, layout)
    if (p.kind === 'unplaced') {
      assignTrackToGrid(track, layout ?? { slots: [], fullscreenLayers: [] })
    } else {
      requestTrackSelection(track.id)
      revealInspector()
    }
  }, [layout, requestTrackSelection])

  const onRowKeyDown = useCallback((e, track) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate(track)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const rows = Array.from(e.currentTarget.parentElement.querySelectorAll('[data-track-row]'))
      rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    }
  }, [activate])

  const menuItems = useMemo(
    () => (menu?.track ? buildPlacementMenuItems(menu.track, layout ?? { slots: [], fullscreenLayers: [] }) : []),
    [menu, layout],
  )

  return (
    <aside className={styles.rail} data-testid="grid-editor-dock" aria-label="Grid tracks">
      <SegmentedControl size="sm" className={styles.fill} label="Grid strip" value={view} onChange={setView} options={VIEWS} />

      {view === 'layers' ? (
        <div className={styles.layers}>
          <VideoTrackList compact tracks={tracks} layout={layout ?? { slots: [], fullscreenLayers: [] }} identity={identity} />
        </div>
      ) : (
        <>
          <SegmentedControl
            size="sm"
            className={styles.fill}
            label="Show tracks"
            value={dockFilter}
            onChange={setDockFilter}
            options={[
              { value: 'all', label: `All ${tracks.length}` },
              { value: 'unplaced', label: `Unplaced ${unplacedCount}` },
              { value: 'placed', label: `Placed ${placedCount}` },
            ]}
          />
          <div className={styles.list} role="list" aria-label="Tracks">
            {dockTracks.length === 0 ? (
              <p className={styles.empty}>
                {dockFilter === 'placed' ? 'No tracks placed yet.' :
                 dockFilter === 'unplaced' ? 'Every track is placed.' :
                 'No tracks. Add a track in the arrangement.'}
              </p>
            ) : dockTracks.map((t) => {
              const p = getTrackPlacement(t.id, layout)
              const text = placementText(p)
              return (
                <div
                  key={t.id}
                  role="listitem"
                  tabIndex={0}
                  data-track-row=""
                  className={styles.row}
                  data-placed={p.kind === 'grid' || undefined}
                  data-free={p.kind === 'unplaced' || undefined}
                  style={{ '--track-color': identity[t.id] }}
                  draggable
                  onDragStart={(e) => handleDragStart(e, t.id)}
                  onDragEnd={handleDragEnd}
                  onDoubleClick={() => activate(t)}
                  onKeyDown={(e) => onRowKeyDown(e, t)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ track: t, x: e.clientX, y: e.clientY }) }}
                  data-hint={p.kind === 'unplaced'
                    ? `${t.name}: not placed. Drag it onto the picture, or press Enter to put it in the next free cell.`
                    : p.kind === 'grid'
                      ? `${t.name}: grid cell ${text} (column, row). Drag onto the picture to move it, Enter shows it in the Inspector.`
                      : `${t.name}: fullscreen layer, ${text.toLowerCase()} the grid. Enter shows it in the Inspector.`}
                  aria-label={`${t.name}, ${p.kind === 'grid' ? `grid cell ${text}` : text.toLowerCase()}`}
                >
                  <IcDotsSixVertical className={styles.grip} size={14} aria-hidden="true" />
                  <span className={styles.name}>{t.name}</span>
                  <span className={styles.where}>{text}</span>
                </div>
              )
            })}
          </div>
          <p className={styles.helper}>Drag a track onto the picture, or select it and press Enter.</p>
        </>
      )}

      {menu && (
        <TrackContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}

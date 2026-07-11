import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, SlidersHorizontal } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import useVideoTabStore from '../../stores/useVideoTabStore.js'
import TrackContextMenu from './TrackContextMenu.jsx'
import {
  partitionAndSortTracks,
  buildPlacementMenuItems,
  placementBadgeLabel,
  commitReorder,
} from './trackPlacement.js'

const notifyTracks = () => timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))

/**
 * Flat, drag-reorderable list of EVERY track in the project, sorted by real
 * compositing zOrder. Replaces the old dropdown-driven "Fullscreen Layers"
 * manager. Rows visually echo the Audio-tab TrackHeader (color stripe + name +
 * badge). Placed tracks form the ordered stack (frontmost at the top); unplaced
 * tracks sit in a clearly-separated section below.
 *
 * Reorder is drag-buffered locally and committed once on drop via
 * setPlacementZOrder (never setTrackOrder). Right-click opens the shared
 * TrackContextMenu with the video-relevant items + the shared placement-mode
 * actions.
 *
 * Props:
 *   tracks – array of track objects (getTracks order)
 *   layout – current grid layout (slots + fullscreenLayers)
 */
export default function VideoTrackList({ tracks = [], layout }) {
  const openTrackVideoProperties = useVideoTabStore((s) => s.openTrackVideoProperties)

  const [menu, setMenu] = useState(null) // { track, x, y }

  const { placed, unplaced } = useMemo(
    () => partitionAndSortTracks(tracks, layout),
    [tracks, layout]
  )

  // ── Drag-reorder (EffectChainPanel / TrackFlipSection pattern) ─────────────
  // Pointer-driven, local preview only, single IPC commit on mouseup. Buffers
  // the intermediate order in `dragOrder`; commits fresh zOrders on drop.
  const dragRef = useRef(null)            // { id, currentIdx }
  const [dragOrder, setDragOrder] = useState(null) // ephemeral placed[] preview
  const displayPlaced = dragOrder ?? placed

  useEffect(() => {
    const onUp = () => {
      if (!dragRef.current) return
      const order = dragRef.current.order
      dragRef.current = null
      document.body.style.cursor = ''
      setDragOrder(null)
      if (!order) return
      const orderedIds = order.map(e => e.track.id)
      commitReorder(orderedIds, layout)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [layout])

  const handleDragStart = useCallback((id, idx, e) => {
    if (placed.length < 2) return
    e.preventDefault()
    const start = [...placed]
    dragRef.current = { id, currentIdx: idx, order: start }
    setDragOrder(start)
    document.body.style.cursor = 'grabbing'
  }, [placed])

  const handleDragOver = useCallback((toIdx) => {
    if (!dragRef.current) return
    if (toIdx === dragRef.current.currentIdx) return
    dragRef.current.currentIdx = toIdx
    setDragOrder(prev => {
      if (!prev) return prev
      const srcIdx = prev.findIndex(e => e.track.id === dragRef.current.id)
      if (srcIdx === -1) return prev
      const out = [...prev]
      const [moved] = out.splice(srcIdx, 1)
      out.splice(toIdx, 0, moved)
      dragRef.current.order = out
      return out
    })
  }, [])

  // ── Row context menu ───────────────────────────────────────────────────────
  const openMenu = useCallback((track, e) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ track, x: e.clientX, y: e.clientY })
  }, [])

  const handleToggleHold = useCallback(async (track) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(track.id, !track.videoHoldLastFrame)
      console.log(`[VideoTabList] track ${track.id} videoHoldLastFrame → ${!track.videoHoldLastFrame}`)
      notifyTracks()
    } catch (err) {
      console.error('[VideoTabList] setVideoHoldLastFrame failed:', err)
    }
  }, [])

  const handleDeleteTrack = useCallback(async (track) => {
    try {
      await window.xleth?.timeline?.removeTrack(track.id)
      console.log(`[VideoTabList] track ${track.id} removed`)
      notifyTracks()
    } catch (err) {
      console.error('[VideoTabList] removeTrack failed:', err)
    }
  }, [])

  const menuItems = useMemo(() => {
    if (!menu?.track) return []
    const track = menu.track
    return [
      {
        label: 'Video Properties…',
        checked: !!track.videoFlipConfig?.enabled,
        onClick: () => openTrackVideoProperties(track.id),
      },
      {
        label: 'Hold Last Frame',
        checked: !!track.videoHoldLastFrame,
        onClick: () => handleToggleHold(track),
      },
      { type: 'separator' },
      ...buildPlacementMenuItems(track, layout),
      { type: 'separator' },
      { label: 'Delete Track', danger: true, onClick: () => handleDeleteTrack(track) },
    ]
  }, [menu, layout, openTrackVideoProperties, handleToggleHold, handleDeleteTrack])

  const renderRow = (track, placement, draggable, dragIdx) => {
    return (
      <div
        key={track.id}
        className={`vtl-row${draggable ? ' vtl-row--draggable' : ''}`}
        role="listitem"
        tabIndex={0}
        onMouseEnter={draggable ? () => handleDragOver(dragIdx) : undefined}
        onDoubleClick={() => openTrackVideoProperties(track.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openTrackVideoProperties(track.id)
        }}
        onContextMenu={(e) => openMenu(track, e)}
        title="Double-click to edit video properties. Right-click for placement."
      >
        {draggable ? (
          <span
            className="vtl-row-handle"
            title="Drag to reorder compositing order"
            onMouseDown={(e) => handleDragStart(track.id, dragIdx, e)}
          >
            <GripVertical size={13} aria-hidden="true" />
          </span>
        ) : (
          <span className="vtl-row-handle vtl-row-handle--disabled" aria-hidden="true">
            <GripVertical size={13} />
          </span>
        )}
        <span className="vtl-row-name" title={track.name}>{track.name}</span>
        <button
          type="button"
          className="vtl-row-edit"
          onClick={(e) => {
            e.stopPropagation()
            openTrackVideoProperties(track.id)
          }}
          title={`Edit video properties for ${track.name}`}
          aria-label={`Edit video properties for ${track.name}`}
        >
          <SlidersHorizontal size={12} aria-hidden="true" />
          <span>Edit</span>
        </button>
        <span className={`vtl-row-badge vtl-row-badge--${placement.kind}`}>
          {placementBadgeLabel(placement)}
        </span>
      </div>
    )
  }

  return (
    <div className="grid-tab-section vtl-section">
      <div className="grid-tab-section-header">
        <span>Tracks</span>
        <span className="grid-tab-section-count">{placed.length} placed</span>
      </div>

      {/* Placed stack — frontmost at top, drag to reorder compositing order. */}
      <div className="vtl-list" role="list" aria-label="Placed video tracks">
        {displayPlaced.length === 0 && (
          <div className="grid-tab-empty">No tracks placed in the video yet</div>
        )}
        {displayPlaced.map((entry, idx) =>
          renderRow(entry.track, entry.placement, true, idx))}
      </div>

      {/* Unplaced — no zOrder, don't render. Kept visually separate. */}
      {unplaced.length > 0 && (
        <>
          <div className="grid-tab-section-header vtl-unplaced-header">
            <span>Unplaced</span>
            <span className="grid-tab-section-count">{unplaced.length}</span>
          </div>
          <div className="vtl-list vtl-list--unplaced" role="list" aria-label="Unplaced tracks">
            {unplaced.map((track) =>
              renderRow(track, { kind: 'unplaced' }, false, -1))}
          </div>
        </>
      )}

      {menu && (
        <TrackContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

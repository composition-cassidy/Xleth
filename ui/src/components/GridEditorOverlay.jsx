import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { X, Magnet } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import ContextMenu from './ContextMenu.jsx'
import { activeDragTrackId, setActiveDragTrackId } from './gridEditorDragState.js'

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  fullscreenLayers: [],
  previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
}

// Mirror of engine constants in TimelineTypes.h. Each grid column is divided
// into SUB_UNITS_PER_COLUMN equal pieces; gridX/spanX are stored on slots in
// these fine units. Per-track subdivisionFactor must divide SUB_UNITS_PER_COLUMN.
const SUB_UNITS_PER_COLUMN = 8
const SUB_UNITS_PER_ROW    = 8
const VALID_SUBDIVISION_FACTORS = [1, 2, 4, 8]

// A pointer move below this px threshold counts as a click on a slot
// (which brings it to front). Anything above starts a drag-move.
const CLICK_VS_DRAG_THRESHOLD_PX = 4

// Snap a fine-grid value to the nearest sub-step. When snap is on, step is
// (SUB_UNITS / factor) of the dragged track. When off, step is 1 fine-unit.
function snapFine(rawFine, factor, snapOn, axisFineCap) {
  const step = snapOn ? (axisFineCap / factor) : 1
  return Math.round(rawFine / step) * step
}

export default function GridEditorOverlay() {
  const [layout, setLayout]     = useState(DEFAULT_LAYOUT)
  const [tracks, setTracks]     = useState([])
  const [contextMenu, setContextMenu] = useState(null) // { x, y, slot }
  // resizeState — in-flight slot resize (drag is owned here, persisted on pointerup).
  const [resizeState, setResizeState] = useState(null)
  // moveState — in-flight slot move from a pointerdown on the slot body.
  // Doubles as a "click vs drag" detector via the moved flag.
  const [moveState, setMoveState] = useState(null)
  // dragGhost — preview rect under the cursor while dragging from the dock.
  const [dragGhost, setDragGhost] = useState(null) // { gridX, gridY, spanX, spanY }
  const [snapEnabled, setSnapEnabled] = useState(true)
  const rootRef = useRef(null)

  // ── Fetch layout + tracks ────────────────────────────────────────────────
  const fetchLayout = useCallback(async () => {
    try {
      const l = await window.xleth?.timeline?.getGridLayout()
      if (l) setLayout(l)
    } catch (e) {
      console.error('[GridEditorOverlay] getGridLayout failed:', e)
    }
  }, [])

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (Array.isArray(t)) setTracks(t)
    } catch (e) {
      console.error('[GridEditorOverlay] getTracks failed:', e)
    }
  }, [])

  useEffect(() => {
    fetchLayout()
    fetchTracks()
    const onGrid = () => fetchLayout()
    const onTracks = () => { fetchTracks(); fetchLayout() }
    timelineEvents.addEventListener('timeline-grid-changed', onGrid)
    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    return () => {
      timelineEvents.removeEventListener('timeline-grid-changed', onGrid)
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
    }
  }, [fetchLayout, fetchTracks])

  const notify = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

  // Lookup helpers
  const tracksById = useMemo(() => {
    const m = new Map()
    for (const t of tracks) m.set(t.id, t)
    return m
  }, [tracks])

  const slotsByTrackId = useMemo(() => {
    const m = new Map()
    for (const s of layout.slots) m.set(s.trackId, s)
    return m
  }, [layout.slots])

  const totalFineX = layout.columns * SUB_UNITS_PER_COLUMN
  const totalFineY = layout.rows    * SUB_UNITS_PER_ROW

  const trackFactor = useCallback((trackId) => {
    const t = tracksById.get(trackId)
    return (t && VALID_SUBDIVISION_FACTORS.includes(t.subdivisionFactor)) ? t.subdivisionFactor : 1
  }, [tracksById])

  // ── zOrder helpers ───────────────────────────────────────────────────────
  // All zOrder mutations route through setGridLayout because assignTrackToGrid
  // unconditionally resets zOrder to 0 (Timeline::assignTrackToGrid).
  const writeLayoutSlots = useCallback(async (mutator) => {
    const newSlots = mutator(layout.slots)
    if (!newSlots) return
    try {
      await window.xleth?.timeline?.setGridLayout({ ...layout, slots: newSlots })
      notify()
    } catch (e) {
      console.error('[GridEditorOverlay] setGridLayout failed:', e)
    }
  }, [layout])

  const computeMaxZ = useCallback((slots) => {
    let m = -1
    for (const s of slots) if (s.zOrder > m) m = s.zOrder
    return m
  }, [])

  const computeMinZ = useCallback((slots) => {
    let m = Infinity
    for (const s of slots) if (s.zOrder < m) m = s.zOrder
    return m === Infinity ? 0 : m
  }, [])

  const bringToFront = useCallback(async (trackId) => {
    await writeLayoutSlots(slots => {
      const m = computeMaxZ(slots)
      return slots.map(s => s.trackId === trackId ? { ...s, zOrder: m + 1 } : s)
    })
  }, [writeLayoutSlots, computeMaxZ])

  const sendToBack = useCallback(async (trackId) => {
    await writeLayoutSlots(slots => {
      const m = computeMinZ(slots)
      return slots.map(s => s.trackId === trackId ? { ...s, zOrder: m - 1 } : s)
    })
  }, [writeLayoutSlots, computeMinZ])

  // Move + bump zOrder of an existing slot. Single setGridLayout call so
  // undo restores the previous geometry AND zOrder atomically.
  const moveSlotAndBumpZ = useCallback(async (trackId, gridX, gridY, spanX, spanY) => {
    await writeLayoutSlots(slots => {
      const m = computeMaxZ(slots)
      return slots.map(s => s.trackId === trackId
        ? { ...s, gridX, gridY, spanX, spanY, zOrder: m + 1 }
        : s)
    })
  }, [writeLayoutSlots, computeMaxZ])

  // ── Mutations: add/remove/subdivision ────────────────────────────────────
  const handleRemove = useCallback(async (trackId) => {
    await window.xleth?.timeline?.removeTrackFromGrid(trackId)
    notify()
  }, [])

  const handleSetSubdivision = useCallback(async (trackId, factor) => {
    try {
      await window.xleth?.timeline?.setTrackSubdivisionFactor(trackId, factor)
      timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
    } catch (e) {
      console.error('[GridEditorOverlay] setTrackSubdivisionFactor failed:', e)
    }
  }, [])

  const handleSlotContextMenu = useCallback((e, slot) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, slot })
  }, [])

  // ── Drag-from-dock: place a new track on the canvas ─────────────────────
  // dragSourceTrackId is now stored in gridEditorDragState.js (activeDragTrackId)
  // so GridEditorDock can set it without being a React child of this component.
  // A document-level dragend listener clears the ghost when any drag ends.
  useEffect(() => {
    const onDragEnd = () => setDragGhost(null)
    document.addEventListener('dragend', onDragEnd)
    return () => document.removeEventListener('dragend', onDragEnd)
  }, [])

  const fineXYFromEvent = useCallback((clientX, clientY) => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const fineX = ((clientX - rect.left) / rect.width)  * totalFineX
    const fineY = ((clientY - rect.top)  / rect.height) * totalFineY
    return { fineX, fineY }
  }, [totalFineX, totalFineY])

  const handleCanvasDragOver = useCallback((e) => {
    if (activeDragTrackId == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const factor = trackFactor(activeDragTrackId)
    const stepFineX = SUB_UNITS_PER_COLUMN / factor
    const stepFineY = SUB_UNITS_PER_ROW    / factor
    const xy = fineXYFromEvent(e.clientX, e.clientY)
    if (!xy) return
    let nx = snapFine(xy.fineX, factor, snapEnabled, SUB_UNITS_PER_COLUMN)
    let ny = snapFine(xy.fineY, factor, snapEnabled, SUB_UNITS_PER_ROW)
    nx = Math.max(0, Math.min(totalFineX - stepFineX, nx))
    ny = Math.max(0, Math.min(totalFineY - stepFineY, ny))
    setDragGhost(prev => {
      if (prev && prev.gridX === nx && prev.gridY === ny
              && prev.spanX === stepFineX && prev.spanY === stepFineY) return prev
      return { gridX: nx, gridY: ny, spanX: stepFineX, spanY: stepFineY }
    })
  }, [trackFactor, snapEnabled, totalFineX, totalFineY, fineXYFromEvent])

  const handleCanvasDragLeave = useCallback((e) => {
    // Only clear the ghost if the drag truly left the overlay (relatedTarget
    // not inside it). Without this guard, the ghost flickers off when the
    // cursor crosses internal child boundaries.
    if (e.relatedTarget && rootRef.current?.contains(e.relatedTarget)) return
    setDragGhost(null)
  }, [])

  const handleCanvasDrop = useCallback(async (e) => {
    if (activeDragTrackId == null) return
    e.preventDefault()
    const trackId = activeDragTrackId
    setActiveDragTrackId(null)
    setDragGhost(null)
    const factor = trackFactor(trackId)
    const stepFineX = SUB_UNITS_PER_COLUMN / factor
    const stepFineY = SUB_UNITS_PER_ROW    / factor
    const xy = fineXYFromEvent(e.clientX, e.clientY)
    if (!xy) return
    let nx = snapFine(xy.fineX, factor, snapEnabled, SUB_UNITS_PER_COLUMN)
    let ny = snapFine(xy.fineY, factor, snapEnabled, SUB_UNITS_PER_ROW)
    nx = Math.max(0, Math.min(totalFineX - stepFineX, nx))
    ny = Math.max(0, Math.min(totalFineY - stepFineY, ny))

    // Compute target zOrder = max(existing) + 1 so the dropped cell lands on
    // top. Excludes any prior slot for this track since assign-with-zOrder
    // replaces it (move semantics).
    let maxZ = -1
    for (const s of layout.slots) {
      if (s.trackId !== trackId && s.zOrder > maxZ) maxZ = s.zOrder
    }
    const newZ = maxZ + 1

    // Single atomic command: creates the slot with the supplied zOrder AND
    // enqueues proxies for the track's regions. One IPC call → one undo step.
    try {
      await window.xleth?.timeline?.assignTrackToGridWithZOrder(
        trackId, nx, ny, stepFineX, stepFineY, newZ)
      notify()
    } catch (err) {
      console.error('[GridEditorOverlay] assignTrackToGridWithZOrder failed:', err)
    }
  }, [trackFactor, snapEnabled, totalFineX, totalFineY, fineXYFromEvent, layout.slots])

  // ── Slot move (pointer-based drag of an existing slot) ───────────────────
  const handleSlotPointerDown = useCallback((e, slot) => {
    if (e.button !== 0) return
    // Don't start a move when clicking on resize handles or the X button —
    // those have their own behavior.
    if (e.target.closest?.('.grid-editor-slot-resize')) return
    if (e.target.closest?.('.grid-editor-cell-remove')) return
    const overlayRect = rootRef.current?.getBoundingClientRect()
    if (!overlayRect) return
    e.preventDefault()
    e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    const fineXAtClick = ((e.clientX - overlayRect.left) / overlayRect.width)  * totalFineX
    const fineYAtClick = ((e.clientY - overlayRect.top)  / overlayRect.height) * totalFineY
    setMoveState({
      pointerId: e.pointerId,
      trackId:   slot.trackId,
      originGridX: slot.gridX,
      originGridY: slot.gridY,
      spanX:       slot.spanX,
      spanY:       slot.spanY,
      offsetFineX: fineXAtClick - slot.gridX,
      offsetFineY: fineYAtClick - slot.gridY,
      currentGridX: slot.gridX,
      currentGridY: slot.gridY,
      moved: false,
      originClientX: e.clientX,
      originClientY: e.clientY,
    })
  }, [totalFineX, totalFineY])

  const handleSlotPointerMove = useCallback((e) => {
    setMoveState(prev => {
      if (!prev || prev.pointerId !== e.pointerId) return prev
      const overlayRect = rootRef.current?.getBoundingClientRect()
      if (!overlayRect) return prev
      const fineX = ((e.clientX - overlayRect.left) / overlayRect.width)  * totalFineX
      const fineY = ((e.clientY - overlayRect.top)  / overlayRect.height) * totalFineY
      const factor = trackFactor(prev.trackId)
      let nx = snapFine(fineX - prev.offsetFineX, factor, snapEnabled, SUB_UNITS_PER_COLUMN)
      let ny = snapFine(fineY - prev.offsetFineY, factor, snapEnabled, SUB_UNITS_PER_ROW)
      nx = Math.max(0, Math.min(totalFineX - prev.spanX, nx))
      ny = Math.max(0, Math.min(totalFineY - prev.spanY, ny))
      const dx = e.clientX - prev.originClientX
      const dy = e.clientY - prev.originClientY
      const moved = prev.moved || (Math.hypot(dx, dy) > CLICK_VS_DRAG_THRESHOLD_PX)
      if (nx === prev.currentGridX && ny === prev.currentGridY && moved === prev.moved) return prev
      return { ...prev, currentGridX: nx, currentGridY: ny, moved }
    })
  }, [trackFactor, snapEnabled, totalFineX, totalFineY])

  const handleSlotPointerUp = useCallback((e) => {
    setMoveState(prev => {
      if (!prev || prev.pointerId !== e.pointerId) return prev
      try { e.currentTarget.releasePointerCapture?.(prev.pointerId) } catch {}
      if (!prev.moved) {
        // Treat as click → bring to front (only if not already top).
        bringToFront(prev.trackId)
      } else if (prev.currentGridX !== prev.originGridX
              || prev.currentGridY !== prev.originGridY) {
        moveSlotAndBumpZ(prev.trackId, prev.currentGridX, prev.currentGridY,
                         prev.spanX, prev.spanY)
      }
      return null
    })
  }, [bringToFront, moveSlotAndBumpZ])

  const handleSlotPointerCancel = useCallback((e) => {
    setMoveState(prev => {
      if (!prev || prev.pointerId !== e.pointerId) return prev
      return null
    })
  }, [])

  // ── Slot resize ──────────────────────────────────────────────────────────
  // pointerdown on a handle captures the starting geometry; pointermove
  // updates `resizeState.currentSpanX/Y` for live visual feedback (no IPC);
  // pointerup commits via setGridLayout (preserves zOrder).
  const handleResizeStart = useCallback((e, slot, edge) => {
    e.preventDefault()
    e.stopPropagation()
    const overlayRect = rootRef.current?.getBoundingClientRect()
    if (!overlayRect) return
    const factor = trackFactor(slot.trackId)
    setResizeState({
      trackId:      slot.trackId,
      edge,
      originX:      e.clientX,
      originY:      e.clientY,
      gridX:        slot.gridX,
      gridY:        slot.gridY,
      originSpanX:  slot.spanX,
      originSpanY:  slot.spanY,
      currentSpanX: slot.spanX,
      currentSpanY: slot.spanY,
      stepFineX:    SUB_UNITS_PER_COLUMN / factor,
      stepFineY:    SUB_UNITS_PER_ROW    / factor,
      overlayWidth:  overlayRect.width,
      overlayHeight: overlayRect.height,
    })
  }, [trackFactor])

  useEffect(() => {
    if (!resizeState) return

    const onMove = (e) => {
      setResizeState(prev => {
        if (!prev) return prev
        const fineDx = ((e.clientX - prev.originX) / prev.overlayWidth)  * totalFineX
        const fineDy = ((e.clientY - prev.originY) / prev.overlayHeight) * totalFineY

        // Snap + clamp to grid bounds. Untouched axes stay at the origin span.
        // Overlapping other slots is allowed (free-canvas model — z-order
        // determines paint order).
        let newSpanX = prev.originSpanX
        let newSpanY = prev.originSpanY
        if (prev.edge === 'e' || prev.edge === 'se') {
          newSpanX = Math.round((prev.originSpanX + fineDx) / prev.stepFineX) * prev.stepFineX
          newSpanX = Math.max(prev.stepFineX, Math.min(totalFineX - prev.gridX, newSpanX))
        }
        if (prev.edge === 's' || prev.edge === 'se') {
          newSpanY = Math.round((prev.originSpanY + fineDy) / prev.stepFineY) * prev.stepFineY
          newSpanY = Math.max(prev.stepFineY, Math.min(totalFineY - prev.gridY, newSpanY))
        }

        if (newSpanX === prev.currentSpanX && newSpanY === prev.currentSpanY) return prev
        return { ...prev, currentSpanX: newSpanX, currentSpanY: newSpanY }
      })
    }

    const onUp = () => {
      setResizeState(prev => {
        if (!prev) return null
        const changed = prev.currentSpanX !== prev.originSpanX
                     || prev.currentSpanY !== prev.originSpanY
        if (changed) {
          // Use setGridLayout (not assignTrackToGrid) so zOrder is preserved.
          const newSlots = layout.slots.map(s => s.trackId === prev.trackId
            ? { ...s, spanX: prev.currentSpanX, spanY: prev.currentSpanY }
            : s)
          window.xleth?.timeline?.setGridLayout({ ...layout, slots: newSlots })
            .then(() => notify())
            .catch(err => console.error('[GridEditorOverlay] resize commit failed:', err))
        }
        return null
      })
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup',   onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup',   onUp)
    }
  }, [resizeState, layout, totalFineX, totalFineY])

  const fsLayers = layout.fullscreenLayers ?? []
  const behindLayers = fsLayers
    .filter(l => l.placement === 'behind')
    .map(l => ({ ...l, track: tracksById.get(l.trackId) }))
    .filter(x => x.track)
  const frontLayers = fsLayers
    .filter(l => l.placement === 'front')
    .map(l => ({ ...l, track: tracksById.get(l.trackId) }))
    .filter(x => x.track)

  // Build context-menu items for an assigned slot (right-click).
  const buildContextItems = (slot) => {
    if (!slot) return []
    const t = tracksById.get(slot.trackId)
    const currentFactor = (t && VALID_SUBDIVISION_FACTORS.includes(t.subdivisionFactor))
      ? t.subdivisionFactor : 1
    return [
      { label: 'Bring to Front', onClick: () => bringToFront(slot.trackId) },
      { label: 'Send to Back',   onClick: () => sendToBack(slot.trackId)   },
      { type: 'separator' },
      {
        label: 'Remove from grid',
        danger: true,
        onClick: () => handleRemove(slot.trackId),
      },
      { type: 'separator' },
      ...VALID_SUBDIVISION_FACTORS.map(f => ({
        label: `${f === currentFactor ? '✓ ' : '   '}Subdivision: ${f}×`,
        onClick: () => handleSetSubdivision(slot.trackId, f),
      })),
    ]
  }

  // Sort slots ascending by zOrder for paint order in the DOM. This matches
  // the engine's compositor sort so what the editor shows mirrors the render.
  const orderedSlots = useMemo(() => {
    return [...layout.slots].sort((a, b) => a.zOrder - b.zOrder)
  }, [layout.slots])

  // Empty backdrop cells — purely visual (column×row guidelines). They no
  // longer accept clicks for placement; placement is drag-from-palette only.
  const cells = []
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.columns; col++) {
      cells.push({ col, row })
    }
  }

  return (
    <div
      ref={rootRef}
      className="grid-editor-overlay"
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
      onDragLeave={handleCanvasDragLeave}
    >
      {/* ── Empty backdrop cells (one per main column×row) ─────────────── */}
      {cells.map(cell => (
        <div
          key={`empty-${cell.col}-${cell.row}`}
          className="grid-editor-cell empty"
          style={{
            left:   `${(cell.col / layout.columns) * 100}%`,
            top:    `${(cell.row / layout.rows)    * 100}%`,
            width:  `${100 / layout.columns}%`,
            height: `${100 / layout.rows}%`,
          }}
        >
          <div className="grid-editor-half-lines" />
        </div>
      ))}

      {/* ── Assigned slots — absolutely positioned, ordered by zOrder ──── */}
      {orderedSlots.map(slot => {
        const track = tracksById.get(slot.trackId)
        const factor = (track && VALID_SUBDIVISION_FACTORS.includes(track.subdivisionFactor))
          ? track.subdivisionFactor : 1
        const isResizing = resizeState && resizeState.trackId === slot.trackId
        const isMoving   = moveState   && moveState.trackId   === slot.trackId && moveState.moved
        const renderSpanX = isResizing ? resizeState.currentSpanX : slot.spanX
        const renderSpanY = isResizing ? resizeState.currentSpanY : slot.spanY
        const renderGridX = isMoving   ? moveState.currentGridX   : slot.gridX
        const renderGridY = isMoving   ? moveState.currentGridY   : slot.gridY
        const left   = (renderGridX / totalFineX) * 100
        const top    = (renderGridY / totalFineY) * 100
        const width  = (renderSpanX / totalFineX) * 100
        const height = (renderSpanY / totalFineY) * 100
        return (
          <div
            key={`slot-${slot.trackId}`}
            className={`grid-editor-slot assigned ${isMoving ? 'moving' : ''}`}
            style={{
              left:   `${left}%`,
              top:    `${top}%`,
              width:  `${width}%`,
              height: `${height}%`,
            }}
            onContextMenu={(e) => handleSlotContextMenu(e, slot)}
            onPointerDown={(e) => handleSlotPointerDown(e, slot)}
            onPointerMove={handleSlotPointerMove}
            onPointerUp={handleSlotPointerUp}
            onPointerCancel={handleSlotPointerCancel}
          >
            {factor > 1 && (
              <div
                className="grid-editor-subgrid-lines"
                aria-hidden="true"
                style={{
                  '--xleth-subdiv-step': `${100 / factor}%`,
                }}
              />
            )}
            <span className="grid-editor-cell-label">
              {track?.name ?? `Track ${slot.trackId}`}
              {factor > 1 && (
                <span className="grid-editor-cell-factor">{factor}×</span>
              )}
            </span>
            <button
              className="grid-editor-cell-remove"
              title="Remove from grid"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); handleRemove(slot.trackId) }}
            >
              <X size={12} />
            </button>
            {/* Resize handles. Snap step = (SUB_UNITS / track.subdivisionFactor). */}
            <div
              className="grid-editor-slot-resize grid-editor-slot-resize-e"
              title="Drag to resize width"
              onPointerDown={(e) => handleResizeStart(e, slot, 'e')}
            />
            <div
              className="grid-editor-slot-resize grid-editor-slot-resize-s"
              title="Drag to resize height"
              onPointerDown={(e) => handleResizeStart(e, slot, 's')}
            />
            <div
              className="grid-editor-slot-resize grid-editor-slot-resize-se"
              title="Drag to resize"
              onPointerDown={(e) => handleResizeStart(e, slot, 'se')}
            />
          </div>
        )
      })}

      {/* ── Drag ghost preview (while dragging from the track palette) ──── */}
      {dragGhost && (
        <div
          className="grid-editor-drag-ghost"
          style={{
            left:   `${(dragGhost.gridX / totalFineX) * 100}%`,
            top:    `${(dragGhost.gridY / totalFineY) * 100}%`,
            width:  `${(dragGhost.spanX / totalFineX) * 100}%`,
            height: `${(dragGhost.spanY / totalFineY) * 100}%`,
          }}
        />
      )}

      {/* ── Fullscreen layer badges ───────────────────────────────────── */}
      {(behindLayers.length > 0 || frontLayers.length > 0) && (
        <div className="grid-editor-badges">
          <span className="grid-editor-badge grid-editor-badge-fs-summary">
            Fullscreen · {behindLayers.length} Behind · {frontLayers.length} Front
          </span>
        </div>
      )}

      {/* ── Right-click context menu on an assigned slot ──────────────── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextItems(contextMenu.slot)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* ── Toolbar (snap toggle) ──────────────────────────────────────── */}
      <div className="grid-editor-toolbar">
        <button
          className={`grid-editor-snap-btn ${snapEnabled ? 'on' : 'off'}`}
          onClick={() => setSnapEnabled(s => !s)}
          title={snapEnabled
            ? 'Snap on — placements align to each track\'s subdivision sub-step. Click to disable.'
            : 'Snap off — free 1-unit positioning. Click to enable.'}
        >
          <Magnet size={13} />
          <span>Snap: {snapEnabled ? 'on' : 'off'}</span>
        </button>
      </div>

    </div>
  )
}

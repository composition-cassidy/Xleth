import { useState, useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  chorusTrackId: -1, crashEnabled: false, crashTrackId: -1, crashOpacity: 0.7,
  previewFps: 30,
}

// Build cells array for main-cell granularity.
// A main cell at (x,y) corresponds to half-grid slot (x*2, y*2) with span (2,2).
function buildCells(layout, tracks) {
  const cells = []
  const byMainCell = new Map()

  // Index main cells (span 2x2) by their half-grid (x,y) origin
  for (const s of layout.slots) {
    if (s.spanX === 2 && s.spanY === 2 && s.gridX % 2 === 0 && s.gridY % 2 === 0) {
      byMainCell.set(`${s.gridX},${s.gridY}`, s)
    }
  }

  for (let y = 0; y < layout.rows; y++) {
    for (let x = 0; x < layout.columns; x++) {
      const hgx = x * 2, hgy = y * 2
      const slot = byMainCell.get(`${hgx},${hgy}`)
      if (slot) {
        const track = tracks.find(t => t.id === slot.trackId)
        cells.push({
          x, y, hgx, hgy,
          assigned: true,
          trackId: slot.trackId,
          trackName: track?.name ?? `Track ${slot.trackId}`,
          slot,
        })
      } else {
        cells.push({ x, y, hgx, hgy, assigned: false })
      }
    }
  }

  // Half-cells: spanX=1 OR spanY=1
  const halves = layout.slots.filter(s => s.spanX === 1 || s.spanY === 1)

  return { cells, halves }
}

export default function GridEditorOverlay() {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [tracks, setTracks] = useState([])
  const [pickerCell, setPickerCell] = useState(null) // {x, y, hgx, hgy}
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
    const onTracks = () => fetchTracks()
    timelineEvents.addEventListener('timeline-grid-changed', onGrid)
    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    return () => {
      timelineEvents.removeEventListener('timeline-grid-changed', onGrid)
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
    }
  }, [fetchLayout, fetchTracks])

  // Close picker on outside click
  useEffect(() => {
    if (!pickerCell) return
    const onClick = (e) => {
      if (rootRef.current && !e.target.closest('.grid-editor-picker')) {
        setPickerCell(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [pickerCell])

  const notify = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

  const handleAssign = useCallback(async (trackId, hgx, hgy) => {
    await window.xleth?.timeline?.assignTrackToGrid(trackId, hgx, hgy, 2, 2)
    notify()
    setPickerCell(null)
  }, [])

  const handleRemove = useCallback(async (trackId) => {
    await window.xleth?.timeline?.removeTrackFromGrid(trackId)
    notify()
  }, [])

  const { cells } = buildCells(layout, tracks)

  // Track-picker shows all tracks (allow reassignment)
  const pickerTracks = tracks

  const chorusTrack = tracks.find(t => t.id === layout.chorusTrackId)
  const crashTrack = tracks.find(t => t.id === layout.crashTrackId)

  return (
    <div
      ref={rootRef}
      className="grid-editor-overlay"
      style={{
        gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
      }}
    >
      {cells.map(cell => (
        <div
          key={`${cell.x}-${cell.y}`}
          className={`grid-editor-cell ${cell.assigned ? 'assigned' : 'empty'}`}
          onClick={(e) => {
            if (cell.assigned) return
            e.stopPropagation()
            setPickerCell({ x: cell.x, y: cell.y, hgx: cell.hgx, hgy: cell.hgy })
          }}
        >
          <div className="grid-editor-half-lines" />
          {cell.assigned ? (
            <>
              <span className="grid-editor-cell-label">{cell.trackName}</span>
              <button
                className="grid-editor-cell-remove"
                title="Remove from grid"
                onClick={(e) => { e.stopPropagation(); handleRemove(cell.trackId) }}
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <span className="grid-editor-cell-add">+</span>
          )}
          {pickerCell && pickerCell.x === cell.x && pickerCell.y === cell.y && (
            <div className="grid-editor-picker" onClick={(e) => e.stopPropagation()}>
              <div className="grid-editor-picker-header">Assign Track</div>
              {pickerTracks.length === 0 ? (
                <div className="grid-editor-picker-empty">No tracks available</div>
              ) : (
                pickerTracks.map(t => (
                  <button
                    key={t.id}
                    className="grid-editor-picker-item"
                    onClick={() => handleAssign(t.id, pickerCell.hgx, pickerCell.hgy)}
                  >
                    {t.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      ))}

      {/* ── Chorus / Crash badges ─────────────────────────── */}
      {(chorusTrack || (layout.crashEnabled && crashTrack)) && (
        <div className="grid-editor-badges">
          {chorusTrack && (
            <span className="grid-editor-badge grid-editor-badge-chorus">
              Chorus: {chorusTrack.name}
            </span>
          )}
          {layout.crashEnabled && crashTrack && (
            <span className="grid-editor-badge grid-editor-badge-crash">
              Crash: {crashTrack.name} ({layout.crashOpacity.toFixed(2)})
            </span>
          )}
        </div>
      )}
    </div>
  )
}

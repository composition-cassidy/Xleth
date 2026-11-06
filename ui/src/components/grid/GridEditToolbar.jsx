import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Eraser, Link2, Magnet, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button, IconButton, NumberBox, Select, Toggle, THIN_SPACE } from '../../ui-kit'
import { timelineEvents } from '../../timelineEvents.js'
import useGridEditStore from '../../stores/useGridEditStore.js'
import VideoCanvasSettingsPopover from '../timeline/VideoCanvasSettingsPopover.jsx'
import styles from './GridEditToolbar.module.css'

const SUB_UNITS_PER_COLUMN = 8
const SUB_UNITS_PER_ROW    = 8
const GAP_MAX = 0.5

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  fullscreenLayers: [],
  previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
}

// Placements whose span falls outside an N×M grid are preserved (recoverable),
// never silently deleted, on a grid shrink.
function slotsOutOfBounds(slots, columns, rows) {
  const maxX = columns * SUB_UNITS_PER_COLUMN
  const maxY = rows    * SUB_UNITS_PER_ROW
  return (slots ?? []).filter((s) => s.gridX + s.spanX > maxX || s.gridY + s.spanY > maxY)
}

export function confirmGridResize(slots, columns, rows) {
  const orphans = slotsOutOfBounds(slots, columns, rows)
  if (orphans.length === 0) return true
  const n = orphans.length
  return window.confirm(
    `Resizing the grid to ${columns}×${rows} leaves ${n} placement${n === 1 ? '' : 's'} ` +
    `outside the visible area.\n\nThey will be kept (not deleted) and reappear if you enlarge ` +
    `the grid again or move them back into view.\n\nContinue?`
  )
}

const notify = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))
const intFormat = (x) => String(Math.round(x))
const parseInt10 = (text) => {
  const n = parseInt(String(text), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * The Preview's Edit Grid row: the grid settings that do not fit on the
 * picture. Grid size, link, gap, snap, project canvas, the editing snapshot,
 * and Clear layout. Same IPC calls and the same timeline-grid-changed event
 * contract as the old Video tab overview; relocated, not re-implemented.
 */
export default function GridEditToolbar() {
  const snapEnabled    = useGridEditStore((s) => s.snapEnabled)
  const setSnapEnabled = useGridEditStore((s) => s.setSnapEnabled)

  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [snapshots, setSnapshots] = useState([])
  const [linked, setLinked] = useState(false)
  const [showCanvasPopover, setShowCanvasPopover] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [pending, setPending] = useState(false)
  const canvasTriggerRef = useRef(null)
  const renameInputRef = useRef(null)
  const pendingRef = useRef(false)
  const renameCancelRef = useRef(false)

  const fetchLayout = useCallback(async () => {
    try {
      const l = await window.xleth?.timeline?.getGridLayout()
      if (l) setLayout(l)
    } catch (e) {
      console.error('[Arrange] getGridLayout failed:', e)
    }
  }, [])

  const fetchSnapshots = useCallback(async () => {
    try {
      const next = await window.xleth?.timeline?.listSnapshots?.()
      if (Array.isArray(next)) setSnapshots(next)
    } catch (e) {
      console.error('[Arrange] listSnapshots failed:', e)
    }
  }, [])

  useEffect(() => {
    fetchLayout()
    fetchSnapshots()
    const onGrid = () => { fetchLayout(); fetchSnapshots() }
    timelineEvents.addEventListener('timeline-grid-changed', onGrid)
    return () => timelineEvents.removeEventListener('timeline-grid-changed', onGrid)
  }, [fetchLayout, fetchSnapshots])

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  const resize = useCallback(async (cols, rows) => {
    if (cols === layout.columns && rows === layout.rows) return
    if (!confirmGridResize(layout.slots, cols, rows)) return
    setLayout((l) => ({ ...l, columns: cols, rows }))
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, rows })
    console.log(`[Arrange] grid resized to ${cols}x${rows}`)
    notify()
  }, [layout])

  const commitColumns = (v) => {
    const cols = Math.max(1, Math.min(8, Math.round(v)))
    resize(cols, linked ? cols : layout.rows)
  }
  const commitRows = (v) => {
    const rows = Math.max(1, Math.min(8, Math.round(v)))
    resize(linked ? rows : layout.columns, rows)
  }

  const commitGap = useCallback(async (percent) => {
    const v = Math.max(0, Math.min(GAP_MAX, Math.round(percent) / 100))
    setLayout((l) => ({ ...l, gapScale: v }))
    await window.xleth?.timeline?.setGridLayout({ ...layout, gapScale: v })
    console.log(`[Arrange] grid gap → ${v}`)
    notify()
  }, [layout])

  const handleClearLayout = useCallback(async () => {
    if (!window.confirm('Clear all grid slots and fullscreen layers?')) return
    console.log('[Arrange] grid layout cleared')
    await window.xleth?.timeline?.setGridLayout({ ...layout, slots: [], fullscreenLayers: [] })
    notify()
  }, [layout])

  // ── Editing snapshot (independent of playback/transport) ──────────────────
  const activeSnapshot = snapshots.find((s) => s.active) ?? snapshots[0] ?? null

  const runSnapshotMutation = useCallback(async (label, fn) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      await fn(window.xleth?.timeline)
      await fetchSnapshots()
      notify()
    } catch (e) {
      console.error(`[Arrange] ${label} failed:`, e)
      await Promise.all([fetchSnapshots(), fetchLayout()])
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [fetchLayout, fetchSnapshots])

  const handleSetActiveSnapshot = (id) => {
    if (!id || id === activeSnapshot?.id) return
    runSnapshotMutation('setActiveSnapshot', (tl) => tl?.setActiveSnapshot?.(id))
  }
  const handleCreateSnapshot = () => runSnapshotMutation('createSnapshot', (tl) => (
    tl?.createSnapshot?.length >= 2 ? tl.createSnapshot(false, 'New Snapshot') : tl?.createSnapshot?.('New Snapshot')
  ))
  const handleDuplicateSnapshot = () => runSnapshotMutation('duplicateSnapshot', (tl) => (
    tl?.duplicateSnapshot?.length >= 1 ? tl.duplicateSnapshot('Snapshot Copy') : tl?.duplicateSnapshot?.()
  ))
  const handleDeleteSnapshot = () => {
    if (!activeSnapshot || snapshots.length <= 1) return
    if (!window.confirm(`Delete snapshot "${activeSnapshot.name}"?`)) return
    runSnapshotMutation('deleteSnapshot', (tl) => tl?.deleteSnapshot?.(activeSnapshot.id))
  }

  const startRename = () => {
    if (!activeSnapshot || pending) return
    renameCancelRef.current = false
    setRenameValue(activeSnapshot.name)
    setRenaming(activeSnapshot)
  }
  const cancelRename = () => {
    renameCancelRef.current = true
    setRenaming(null)
    setRenameValue('')
  }
  const commitRename = async () => {
    if (renameCancelRef.current) { renameCancelRef.current = false; return }
    const snapshot = renaming
    const name = renameValue.trim()
    setRenaming(null)
    if (!snapshot || !name || name === snapshot.name) return
    await runSnapshotMutation('renameSnapshot', (tl) => tl?.renameSnapshot?.(snapshot.id, name))
  }

  const canvasW = layout.canvasWidth ?? 1920
  const canvasH = layout.canvasHeight ?? 1080
  const previewFps = Number(layout.previewFps ?? 30)

  return (
    <div className={styles.row} role="group" aria-label="Edit grid settings" data-testid="grid-edit-toolbar">
      <div className={styles.cluster}>
        <span className={styles.label}>Grid</span>
        <NumberBox
          label="Grid columns" hideLabel width={40}
          value={layout.columns} min={1} max={8} step={1} defaultValue={3}
          format={intFormat} parse={parseInt10}
          onCommit={commitColumns}
          hint="Grid columns"
        />
        <span className={styles.times} aria-hidden="true">×</span>
        <NumberBox
          label="Grid rows" hideLabel width={40}
          value={layout.rows} min={1} max={8} step={1} defaultValue={3}
          format={intFormat} parse={parseInt10}
          onCommit={commitRows}
          hint="Grid rows"
        />
        <IconButton size="sm" label={linked ? 'Unlink columns and rows' : 'Link columns and rows'} pressed={linked} onClick={() => setLinked((l) => !l)}>
          <Link2 aria-hidden="true" />
        </IconButton>
      </div>

      <div className={styles.cluster}>
        <span className={styles.label}>Gap</span>
        <NumberBox
          label="Grid gap" hideLabel width={56}
          value={Math.round((layout.gapScale ?? 0) * 100)} min={0} max={GAP_MAX * 100} step={1} defaultValue={0} unit="%"
          onCommit={commitGap}
          hint="Space between grid cells"
        />
      </div>

      <Toggle
        size="sm" on={snapEnabled} onChange={setSnapEnabled}
        glyph={<Magnet aria-hidden="true" />}
        hint={snapEnabled ? 'Snap on: placements align to each track’s subdivision' : 'Snap off: free 1-unit positioning'}
      >
        Snap
      </Toggle>

      <span className={`tl-display-root ${styles.cluster}`}>
        <Button
          ref={canvasTriggerRef}
          size="sm"
          onClick={() => setShowCanvasPopover((v) => !v)}
          aria-expanded={showCanvasPopover}
          hint="Project canvas: aspect, size and frame rate"
        >
          <span className={styles.numbers}>{canvasW}×{canvasH} · {previewFps}{THIN_SPACE}fps</span>
        </Button>
        {showCanvasPopover && (
          <VideoCanvasSettingsPopover
            layout={layout}
            setLayout={setLayout}
            onClose={() => setShowCanvasPopover(false)}
            triggerRef={canvasTriggerRef}
          />
        )}
      </span>

      <div className={styles.cluster} aria-label="Editing snapshot" role="group">
        <span className={styles.label}>Snapshot</span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className={styles.rename}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
            }}
            aria-label="Snapshot name"
          />
        ) : (
          <Select
            size="sm"
            ariaLabel="Editing snapshot"
            value={activeSnapshot?.id ?? ''}
            options={snapshots.map((s) => ({ value: s.id, label: s.name }))}
            onChange={handleSetActiveSnapshot}
            disabled={pending || snapshots.length === 0}
            placeholder="No snapshots"
          />
        )}
        <IconButton size="sm" label="New snapshot" onClick={handleCreateSnapshot} disabled={pending}>
          <Plus aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" label="Duplicate snapshot" onClick={handleDuplicateSnapshot} disabled={!activeSnapshot || pending}>
          <Copy aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" label="Rename snapshot" onClick={startRename} disabled={!activeSnapshot || pending}>
          <Pencil aria-hidden="true" />
        </IconButton>
        <IconButton
          size="sm"
          label={snapshots.length <= 1 ? 'Delete snapshot (at least one is required)' : 'Delete snapshot'}
          onClick={handleDeleteSnapshot}
          disabled={!activeSnapshot || snapshots.length <= 1 || pending}
        >
          <Trash2 aria-hidden="true" />
        </IconButton>
      </div>

      <Button size="sm" glyph={<Eraser aria-hidden="true" />} onClick={handleClearLayout} hint="Remove every grid slot and fullscreen layer">
        Clear layout
      </Button>
    </div>
  )
}

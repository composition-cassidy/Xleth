import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton, NumberBox, SectionHeader, Select, Toggle, THIN_SPACE } from '../../ui-kit'
import { timelineEvents } from '../../timelineEvents.js'
import useGridEditStore from '../../stores/useGridEditStore.js'
import VideoCanvasSettingsPopover from '../timeline/VideoCanvasSettingsPopover.jsx'
import styles from './GridEditToolbar.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcBroom = iconComponent('broom')
const IcCopy = iconComponent('copy')
const IcLink = iconComponent('link')
const IcMagnet = iconComponent('magnet')
const IcPencilSimpleLine = iconComponent('pencil-simple-line')
const IcPlus = iconComponent('plus')
const IcTrash = iconComponent('trash')

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
 * The Edit Grid settings rail, right of the picture: grid size, link, gap,
 * snap, the editing snapshot, the project canvas and Clear layout. Sections in
 * the order you reach for them. Same IPC calls and the same
 * timeline-grid-changed event contract as the old Video tab overview and the
 * row this replaced; relocated, not re-implemented.
 */
export default function GridEditToolbar() {
  const snapEnabled    = useGridEditStore((s) => s.snapEnabled)
  const setSnapEnabled = useGridEditStore((s) => s.setSnapEnabled)

  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [snapshots, setSnapshots] = useState([])
  const [linked, setLinked] = useState(false)
  // { right, bottom } of the canvas button while its popover is open. The
  // popover is portalled to <body> and fixed under the button, because the rail
  // scrolls and clips: an absolutely positioned popover would be cut off.
  const [popoverAnchor, setPopoverAnchor] = useState(null)
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
    notify()
  }, [layout])

  const handleClearLayout = useCallback(async () => {
    if (!window.confirm('Clear all grid slots and fullscreen layers?')) return
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

  const fsLayers = layout.fullscreenLayers ?? []
  const fsBehind = fsLayers.filter((l) => l.placement === 'behind').length
  const fsFront = fsLayers.filter((l) => l.placement === 'front').length
  const canvasW = layout.canvasWidth ?? 1920
  const canvasH = layout.canvasHeight ?? 1080
  const previewFps = Number(layout.previewFps ?? 30)

  return (
    <aside className={styles.rail} role="group" aria-label="Edit grid settings" data-testid="grid-edit-toolbar">
      <section className={styles.section} aria-label="Grid">
        <SectionHeader>Grid</SectionHeader>
        <div className={styles.body}>
          <div className={styles.pair}>
            <NumberBox
              label="Grid columns" caption="Cols" className={styles.nb}
              value={layout.columns} min={1} max={8} step={1} defaultValue={3}
              format={intFormat} parse={parseInt10}
              onCommit={commitColumns}
              hint="Grid columns"
            />
            <IconButton size="sm" label={linked ? 'Unlink columns and rows' : 'Link columns and rows'} pressed={linked} onClick={() => setLinked((l) => !l)}>
              <IcLink aria-hidden="true" />
            </IconButton>
            <NumberBox
              label="Grid rows" caption="Rows" className={styles.nb}
              value={layout.rows} min={1} max={8} step={1} defaultValue={3}
              format={intFormat} parse={parseInt10}
              onCommit={commitRows}
              hint="Grid rows"
            />
          </div>
          <div className={styles.pair}>
            <NumberBox
              label="Grid gap" caption="Gap" className={styles.nb}
              value={Math.round((layout.gapScale ?? 0) * 100)} min={0} max={GAP_MAX * 100} step={1} defaultValue={0} unit="%"
              onCommit={commitGap}
              hint="Space between grid cells"
            />
            <Toggle
              size="sm" on={snapEnabled} onChange={setSnapEnabled}
              glyph={<IcMagnet aria-hidden="true" />}
              hint={snapEnabled ? 'Snap on: placements align to each track’s subdivision' : 'Snap off: free 1-unit positioning'}
            >
              Snap
            </Toggle>
          </div>
        </div>
      </section>

      <section className={styles.section} role="group" aria-label="Editing snapshot">
        <SectionHeader>Snapshot</SectionHeader>
        <div className={styles.body}>
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
              className={styles.snapSelect}
              ariaLabel="Editing snapshot"
              value={activeSnapshot?.id ?? ''}
              options={snapshots.map((s) => ({ value: s.id, label: s.name }))}
              onChange={handleSetActiveSnapshot}
              disabled={pending || snapshots.length === 0}
              placeholder="No snapshots"
            />
          )}
          <div className={styles.icons}>
            <IconButton size="sm" label="New snapshot" onClick={handleCreateSnapshot} disabled={pending}>
              <IcPlus aria-hidden="true" />
            </IconButton>
            <IconButton size="sm" label="Duplicate snapshot" onClick={handleDuplicateSnapshot} disabled={!activeSnapshot || pending}>
              <IcCopy aria-hidden="true" />
            </IconButton>
            <IconButton size="sm" label="Rename snapshot" onClick={startRename} disabled={!activeSnapshot || pending}>
              <IcPencilSimpleLine aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              label={snapshots.length <= 1 ? 'Delete snapshot (at least one is required)' : 'Delete snapshot'}
              onClick={handleDeleteSnapshot}
              disabled={!activeSnapshot || snapshots.length <= 1 || pending}
            >
              <IcTrash aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-label="Output">
        <SectionHeader>Output</SectionHeader>
        <div className={styles.body}>
          <Button
            ref={canvasTriggerRef}
            size="sm"
            className={styles.wide}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setPopoverAnchor((a) => (a ? null : { right: r.right, bottom: r.bottom }))
            }}
            aria-expanded={popoverAnchor != null}
            hint="Project canvas: aspect, size and frame rate"
          >
            <span className={styles.numbers}>{canvasW}×{canvasH} · {previewFps}{THIN_SPACE}fps</span>
          </Button>
          {popoverAnchor && createPortal(
            <div
              className="tl-display-root"
              style={{ position: 'fixed', left: popoverAnchor.right, top: popoverAnchor.bottom, width: 0, height: 0, zIndex: 210 }}
            >
              <VideoCanvasSettingsPopover
                layout={layout}
                setLayout={setLayout}
                onClose={() => setPopoverAnchor(null)}
                triggerRef={canvasTriggerRef}
              />
            </div>,
            document.body,
          )}
          {fsLayers.length > 0 && (
            <span className={styles.readout} data-hint="Fullscreen layers: behind and in front of the grid">
              Fullscreen <span className={styles.numbers}>{fsBehind}</span> behind · <span className={styles.numbers}>{fsFront}</span> front
            </span>
          )}
        </div>
      </section>

      <div className={styles.foot}>
        <Button size="sm" className={styles.wide} glyph={<IcBroom aria-hidden="true" />} onClick={handleClearLayout} hint="Remove every grid slot and fullscreen layer">
          Clear layout
        </Button>
      </div>
    </aside>
  )
}

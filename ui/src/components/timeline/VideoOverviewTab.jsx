import { useCallback, useEffect, useRef, useState } from 'react'
import { Grid3x3, Eraser, Link2, ChevronDown } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import useGridEditStore from '../../stores/useGridEditStore.js'
import { XlethButton, XlethIconButton } from '../common/XlethButton.jsx'
import XlethPanelHeader from '../common/XlethPanelHeader.jsx'
import VideoCanvasSettingsPopover from './VideoCanvasSettingsPopover.jsx'
import VideoTrackList from './VideoTrackList.jsx'

const SUB_UNITS_PER_COLUMN = 8
const SUB_UNITS_PER_ROW    = 8
const GAP_MAX = 0.5

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  fullscreenLayers: [],
  previewFps: 30, gapScale: 0,
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9',
}

// Placements whose span falls outside an N×M grid. Mirrors
// GridSettingsPanel.jsx — out-of-bounds placements are preserved
// (recoverable), never silently deleted, on a grid shrink.
function slotsOutOfBounds(slots, columns, rows) {
  const maxX = columns * SUB_UNITS_PER_COLUMN
  const maxY = rows    * SUB_UNITS_PER_ROW
  return (slots ?? []).filter(s => s.gridX + s.spanX > maxX || s.gridY + s.spanY > maxY)
}

function confirmGridResize(slots, columns, rows) {
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

// ── Live grid preview (mirrors GridSettingsPanel.jsx's GridPreview) ──────────
function GridPreview({ columns, rows, gapScale, canvasW = 1920, canvasH = 1080 }) {
  const W = 160
  const H = Math.max(20, Math.round(W * (canvasH / canvasW)))

  const totalGapFrac = Math.min(gapScale, 0.75)
  const gapX = (W * totalGapFrac) / (columns + 1)
  const gapY = (H * totalGapFrac) / (rows + 1)
  const cellW = Math.max(2, (W - gapX * (columns + 1)) / columns)
  const cellH = Math.max(2, (H - gapY * (rows + 1)) / rows)

  const cells = []
  const lines = []
  for (let cc = 1; cc < columns; cc++) {
    const x = cc * (W / columns)
    lines.push(
      <line
        key={`v-${cc}`}
        x1={x.toFixed(1)} y1="0"
        x2={x.toFixed(1)} y2={H}
        className="gsp-preview-grid-line"
      />
    )
  }
  for (let rr = 1; rr < rows; rr++) {
    const y = rr * (H / rows)
    lines.push(
      <line
        key={`h-${rr}`}
        x1="0" y1={y.toFixed(1)}
        x2={W} y2={y.toFixed(1)}
        className="gsp-preview-grid-line"
      />
    )
  }
  for (let rr = 0; rr < rows; rr++) {
    for (let cc = 0; cc < columns; cc++) {
      const x = gapX + cc * (cellW + gapX)
      const y = gapY + rr * (cellH + gapY)
      cells.push(
        <rect
          key={`${rr}-${cc}`}
          x={x.toFixed(1)} y={y.toFixed(1)}
          width={cellW.toFixed(1)} height={cellH.toFixed(1)}
          className="gsp-preview-cell"
        />
      )
    }
  }

  return (
    <svg className="gsp-preview-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {cells}
      {lines}
    </svg>
  )
}

// ── Video tab overview: grid size, gap, fullscreen layers, edit/clear actions.
// Canvas (aspect/resolution/FPS) lives in a popover triggered from the header —
// see VideoCanvasSettingsPopover.jsx. This is a UI relocation of a subset of
// GridSettingsPanel.jsx's controls, not a behavior change: same IPC calls
// (getGridLayout/setGridLayout/setFullscreenLayers) and the same
// timeline-grid-changed event contract.
export default function VideoOverviewTab() {
  const gridEditMode    = useGridEditStore((s) => s.gridEditMode)
  const setGridEditMode = useGridEditStore((s) => s.setGridEditMode)

  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [tracks, setTracks] = useState([])
  const [linked, setLinked] = useState(false)
  const [showCanvasPopover, setShowCanvasPopover] = useState(false)
  const canvasTriggerRef = useRef(null)

  const fetchLayout = useCallback(async () => {
    try {
      const l = await window.xleth?.timeline?.getGridLayout()
      if (l) setLayout(l)
    } catch (e) {
      console.error('[VideoTab] getGridLayout failed:', e)
    }
  }, [])

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (Array.isArray(t)) setTracks(t)
    } catch (e) {
      console.error('[VideoTab] getTracks failed:', e)
    }
  }, [])

  useEffect(() => {
    console.log('[VideoTab] mounted')
    fetchLayout()
    fetchTracks()
    const onGrid   = () => fetchLayout()
    const onTracks = () => fetchTracks()
    timelineEvents.addEventListener('timeline-grid-changed',  onGrid)
    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    return () => {
      console.log('[VideoTab] unmounted')
      timelineEvents.removeEventListener('timeline-grid-changed',  onGrid)
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
    }
  }, [fetchLayout, fetchTracks])

  const canvasW    = layout.canvasWidth  ?? 1920
  const canvasH    = layout.canvasHeight ?? 1080
  const previewFps = Number(layout.previewFps ?? 60)

  const handleColumnsChange = useCallback(async (e) => {
    const cols = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const rows = linked ? cols : layout.rows
    if (!confirmGridResize(layout.slots, cols, rows)) return
    setLayout(l => ({ ...l, columns: cols, rows }))
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, rows })
    console.log(`[VideoTab] grid resized to ${cols}x${rows}`)
    notify()
  }, [layout, linked])

  const handleRowsChange = useCallback(async (e) => {
    const rows = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const cols = linked ? rows : layout.columns
    if (!confirmGridResize(layout.slots, cols, rows)) return
    setLayout(l => ({ ...l, columns: cols, rows }))
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, rows })
    console.log(`[VideoTab] grid resized to ${cols}x${rows}`)
    notify()
  }, [layout, linked])

  const handleGapScaleChange = useCallback(async (v) => {
    await window.xleth?.timeline?.setGridLayout({ ...layout, gapScale: v })
    console.log(`[VideoTab] gap changed to ${v}`)
    notify()
  }, [layout])

  const handleClearLayout = useCallback(async () => {
    if (!window.confirm('Clear all grid slots and fullscreen layers?')) return
    console.log('[VideoTab] layout cleared')
    await window.xleth?.timeline?.setGridLayout({
      ...layout, slots: [], fullscreenLayers: [],
    })
    notify()
  }, [layout])

  return (
    <div className="grid-tab video-overview-tab">
      {/* ── Grid Layout: columns×rows + link + gap + preview ── */}
      <div className="grid-tab-section gsp-compact-section">
        <XlethPanelHeader title="Grid Layout">
          <span className="tl-display-root">
            <button
              ref={canvasTriggerRef}
              type="button"
              className={`grid-tab-btn${showCanvasPopover ? ' active' : ''}`}
              onClick={() => setShowCanvasPopover(v => !v)}
              title="Canvas settings"
            >
                    <span className="vot-canvas-label">Canvas</span>
                    <span className="vot-canvas-value">{canvasW}×{canvasH} · {previewFps}fps</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            {showCanvasPopover && (
              <VideoCanvasSettingsPopover
                layout={layout}
                setLayout={setLayout}
                onClose={() => setShowCanvasPopover(false)}
                triggerRef={canvasTriggerRef}
              />
            )}
          </span>
        </XlethPanelHeader>
        <div className="gsp-body">
          <div className="gsp-controls">
            <div className="gsp-layout-row">
              <div className="gsp-layout-controls">

                {/* Columns × Rows */}
                <div className="vot-control-group vot-control-group--dims">
                  <span className="vot-control-label">Grid</span>
                  <div className="gsp-dims-row">
                    <input
                      className="gsp-dim-input"
                      type="number" min={1} max={8}
                      value={layout.columns}
                      onChange={handleColumnsChange}
                      aria-label="Grid columns"
                    />
                    <span className="gsp-dim-sep">×</span>
                    <input
                      className="gsp-dim-input"
                      type="number" min={1} max={8}
                      value={layout.rows}
                      onChange={handleRowsChange}
                      aria-label="Grid rows"
                    />
                  </div>
                </div>

                {/* Link button */}
                <div className="vot-control-group vot-control-group--link">
                  <span className="vot-control-label">Link</span>
                  <div className="gsp-link-row">
                    <XlethIconButton
                      type="button"
                      className={`gsp-link-btn${linked ? ' active' : ''}`}
                      active={linked}
                      onClick={() => setLinked(l => !l)}
                      title={linked ? 'Unlink columns and rows' : 'Link columns and rows'}
                      aria-label={linked ? 'Unlink columns and rows' : 'Link columns and rows'}
                    >
                      <Link2 aria-hidden="true" />
                    </XlethIconButton>
                  </div>
                </div>

                {/* GAP */}
                <div className="vot-control-group vot-control-group--gap gsp-gap-wrap">
                  <div className="gsp-gap-header">
                    <span className="gsp-gap-label">Gap</span>
                    <span className="gsp-gap-value">
                      {Math.round((layout.gapScale ?? 0) * 100)}%
                    </span>
                  </div>
                  <input
                    className="gsp-gap-slider"
                    type="range"
                    min={0}
                    max={GAP_MAX}
                    step={0.01}
                    value={layout.gapScale ?? 0}
                    onChange={(e) => setLayout(l => ({ ...l, gapScale: Number(e.target.value) }))}
                    onPointerUp={(e) => handleGapScaleChange(Number(e.currentTarget.value))}
                    onKeyUp={(e) => handleGapScaleChange(Number(e.currentTarget.value))}
                    aria-label="Grid gap"
                  />
                </div>
              </div>

              {/* Right: grid preview */}
              <div className="gsp-preview-wrap">
                <div className="gsp-preview-frame" style={{ aspectRatio: `${canvasW} / ${canvasH}` }}>
                  <GridPreview
                    columns={layout.columns}
                    rows={layout.rows}
                    gapScale={layout.gapScale ?? 0}
                    canvasW={canvasW}
                    canvasH={canvasH}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Track list: every track, sorted by real compositing zOrder ── */}
      <VideoTrackList tracks={tracks} layout={layout} />

      {/* ── Actions ── */}
      <div className="grid-tab-section grid-tab-section--separated">
        <div className="grid-tab-actions">
          <XlethButton
            className={`grid-tab-btn ${gridEditMode ? 'active' : ''}`}
            active={gridEditMode}
            onClick={() => setGridEditMode(!gridEditMode)}
          >
            <Grid3x3 size={13} />
            <span>{gridEditMode ? 'Exit Edit' : 'Edit Grid'}</span>
          </XlethButton>
          <XlethButton className="grid-tab-btn grid-tab-btn-danger" onClick={handleClearLayout}>
            <Eraser size={13} />
            <span>Clear Layout</span>
          </XlethButton>
        </div>
      </div>
    </div>
  )
}

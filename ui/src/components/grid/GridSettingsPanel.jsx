import { useCallback, useMemo, useState } from 'react'
import { Grid3x3, Eraser, X, Plus, Link2 } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import useGridEditStore from '../../stores/useGridEditStore.js'
import { XlethButton, XlethIconButton } from '../common/XlethButton.jsx'
import XlethPanelHeader from '../common/XlethPanelHeader.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

const SUB_UNITS_PER_COLUMN = 8
const SUB_UNITS_PER_ROW    = 8

// ── Project canvas presets ────────────────────────────────────────────────────
// Aspect ratios offered in Grid Settings. 'custom' lets width/height define a
// free ratio. The numeric w/h are only used to compute the locked ratio.
const ASPECT_PRESETS = [
  { id: '16:9', label: '16:9', w: 16, h: 9  },
  { id: '9:16', label: '9:16', w: 9,  h: 16 },
  { id: '4:3',  label: '4:3',  w: 4,  h: 3  },
  { id: '1:1',  label: '1:1',  w: 1,  h: 1  },
  { id: '21:9', label: '21:9', w: 21, h: 9  },
  { id: 'custom', label: 'Custom', w: 0, h: 0 },
]

// Resolution presets per aspect id. Index 1 (the ~1080-class entry) is the
// snap-to default when the aspect changes.
const RESOLUTION_PRESETS = {
  '16:9': [
    { label: '720p',  width: 1280, height: 720  },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '1440p', width: 2560, height: 1440 },
    { label: '4K',    width: 3840, height: 2160 },
  ],
  '9:16': [
    { label: '720p',  width: 720,  height: 1280 },
    { label: '1080p', width: 1080, height: 1920 },
    { label: '1440p', width: 1440, height: 2560 },
    { label: '4K',    width: 2160, height: 3840 },
  ],
  '4:3': [
    { label: '480p',  width: 640,  height: 480  },
    { label: '768p',  width: 1024, height: 768  },
    { label: '1080p', width: 1440, height: 1080 },
    { label: '1536p', width: 2048, height: 1536 },
  ],
  '1:1': [
    { label: '720',   width: 720,  height: 720  },
    { label: '1080',  width: 1080, height: 1080 },
    { label: '1440',  width: 1440, height: 1440 },
    { label: '2160',  width: 2160, height: 2160 },
  ],
  '21:9': [
    { label: '1080p', width: 2560, height: 1080 },
    { label: '1440p', width: 3440, height: 1440 },
    { label: '4K',    width: 5120, height: 2160 },
  ],
}

const CANVAS_MIN = 16
const CANVAS_MAX_W = 7680
const CANVAS_MAX_H = 4320
const GAP_MAX = 0.5
const FPS_OPTIONS = [24, 30, 60, 120].map(fps => ({ value: fps, label: String(fps) }))

// Force even (encoders require it) and clamp to range.
function normCanvasDim(v, max) {
  let n = Math.round(Number(v) || 0)
  if (n < CANVAS_MIN) n = CANVAS_MIN
  if (n > max) n = max
  if (n & 1) n -= 1
  return n
}

// Numeric ratio (w/h) in effect for a given aspect + current dims. Named aspects
// use their defined ratio; 'custom' uses the live dimensions.
function aspectRatioValue(aspectId, w, h) {
  const p = ASPECT_PRESETS.find(a => a.id === aspectId)
  if (p && p.id !== 'custom' && p.w > 0 && p.h > 0) return p.w / p.h
  return (w > 0 && h > 0) ? w / h : 16 / 9
}

// Match current dims to a named resolution preset of the aspect, else 'custom'.
function resolutionIdForDims(aspectId, w, h) {
  const list = RESOLUTION_PRESETS[aspectId] || []
  const hit = list.find(r => r.width === w && r.height === h)
  return hit ? `${w}x${h}` : 'custom'
}

// Placements whose span falls outside an N×M grid. Used to WARN before a grid
// shrink — we never silently delete these. Out-of-bounds placements are
// preserved (recoverable: they reappear when the grid is enlarged again or the
// slot is moved back into view), matching the "keep user layout, clamp only
// invalid numbers" rule.
function slotsOutOfBounds(slots, columns, rows) {
  const maxX = columns * SUB_UNITS_PER_COLUMN
  const maxY = rows    * SUB_UNITS_PER_ROW
  return (slots ?? []).filter(s => s.gridX + s.spanX > maxX || s.gridY + s.spanY > maxY)
}

// Gate a columns/rows change. Returns true to proceed. When shrinking the grid
// would leave user-authored placements outside the visible area, confirm first
// so the hide is never silent. Data is preserved regardless of the answer; this
// only guards against a surprising disappearance.
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

// ── Live grid preview ─────────────────────────────────────────────────────────
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

// ── Main panel ────────────────────────────────────────────────────────────────
export default function GridSettingsPanel({ layout, setLayout, tracks }) {
  const gridEditMode    = useGridEditStore((s) => s.gridEditMode)
  const setGridEditMode = useGridEditStore((s) => s.setGridEditMode)
  const [linked, setLinked] = useState(false)

  // Canvas size editing: customSizeMode reveals the W×H inputs; dimsLocked makes
  // those inputs preserve the selected aspect ratio (unlock = free / custom ratio).
  const [customSizeMode, setCustomSizeMode] = useState(false)
  const [dimsLocked, setDimsLocked]         = useState(true)

  const canvasW      = layout.canvasWidth  ?? 1920
  const canvasH      = layout.canvasHeight ?? 1080
  const canvasAspect = layout.canvasAspectRatio ?? '16:9'
  const resList      = RESOLUTION_PRESETS[canvasAspect] || []
  const resId        = resolutionIdForDims(canvasAspect, canvasW, canvasH)
  const showSizeInputs = customSizeMode || resId === 'custom'
  const previewFps = Number(layout.previewFps ?? 60)

  // Persist a canvas patch to the real project gridLayout (single source of
  // truth). Canvas fields (aspect / resolution) are NON-geometric: grid slots
  // are stored in canvas-independent fine units, so they must survive untouched.
  // We re-read the engine's current layout as the authoritative base before
  // applying the patch, so a stale or partial React `layout` can never drop
  // slots or fullscreen layers when only canvas fields change. Falls back to the
  // prop when the bridge has no getGridLayout (e.g. unit tests).
  const persistCanvas = useCallback(async (patch) => {
    const tl = window.xleth?.timeline
    const base = (await tl?.getGridLayout?.()) || layout
    const next = { ...base, ...patch }
    setLayout(next)
    await tl?.setGridLayout(next)
    notify()
  }, [layout, setLayout])

  const handleAspectChange = useCallback((id) => {
    if (id === 'custom') {
      setCustomSizeMode(true)
      setDimsLocked(false)
      persistCanvas({ canvasAspectRatio: 'custom' })
      return
    }
    // Named aspect → snap to its ~1080-class default resolution, lock dims.
    const list = RESOLUTION_PRESETS[id] || []
    const def  = list[1] || list[0]
    setCustomSizeMode(false)
    setDimsLocked(true)
    persistCanvas({
      canvasAspectRatio: id,
      canvasWidth:  def ? def.width  : canvasW,
      canvasHeight: def ? def.height : canvasH,
    })
  }, [persistCanvas, canvasW, canvasH])

  const handleResolutionChange = useCallback((value) => {
    if (value === 'custom') { setCustomSizeMode(true); return }
    const [w, h] = String(value).split('x').map(Number)
    if (!w || !h) return
    setCustomSizeMode(false)
    persistCanvas({ canvasWidth: w, canvasHeight: h })
  }, [persistCanvas])

  const handleCanvasDimChange = useCallback((which, raw) => {
    const max = which === 'w' ? CANVAS_MAX_W : CANVAS_MAX_H
    const v   = normCanvasDim(raw, max)
    if (dimsLocked) {
      // Preserve the current ratio: derive the partner dimension.
      const ratio = aspectRatioValue(canvasAspect, canvasW, canvasH)
      if (which === 'w') {
        persistCanvas({ canvasWidth: v, canvasHeight: normCanvasDim(v / ratio, CANVAS_MAX_H) })
      } else {
        persistCanvas({ canvasWidth: normCanvasDim(v * ratio, CANVAS_MAX_W), canvasHeight: v })
      }
    } else {
      // Free edit defines a custom ratio.
      const patch = which === 'w' ? { canvasWidth: v } : { canvasHeight: v }
      persistCanvas({ ...patch, canvasAspectRatio: 'custom' })
    }
  }, [dimsLocked, persistCanvas, canvasAspect, canvasW, canvasH])

  const handleToggleLock = useCallback(() => {
    setDimsLocked((locked) => {
      const next = !locked
      if (!next) persistCanvas({ canvasAspectRatio: 'custom' })  // unlock → free ratio
      return next
    })
  }, [persistCanvas])

  const handleColumnsChange = useCallback(async (e) => {
    const cols = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const rows = linked ? cols : layout.rows
    if (!confirmGridResize(layout.slots, cols, rows)) return
    setLayout(l => ({ ...l, columns: cols, rows }))
    // Slots are preserved as-is — out-of-bounds placements stay recoverable and
    // are never silently deleted (the old filterSlotsForSize behaviour).
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, rows })
    notify()
  }, [layout, linked, setLayout])

  const handleRowsChange = useCallback(async (e) => {
    const rows = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const cols = linked ? rows : layout.columns
    if (!confirmGridResize(layout.slots, cols, rows)) return
    setLayout(l => ({ ...l, columns: cols, rows }))
    // Slots are preserved as-is — see handleColumnsChange.
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, rows })
    notify()
  }, [layout, linked, setLayout])

  const handleFpsChange = useCallback(async (fps) => {
    const clamped = Math.max(1, Math.min(120, parseInt(fps) || 30))
    await window.xleth?.timeline?.setPreviewFps(clamped)
    notify()
  }, [])

  const handleGapScaleChange = useCallback(async (v) => {
    await window.xleth?.timeline?.setGridLayout({ ...layout, gapScale: v })
    notify()
  }, [layout])

  const fsLayers = layout.fullscreenLayers ?? []
  const trackOptions = useMemo(() => [
    { value: -1, label: '-- None --' },
    ...tracks.map(t => ({ value: t.id, label: t.name })),
  ], [tracks])
  const fpsOptions = useMemo(() => (
    FPS_OPTIONS.some(option => Number(option.value) === previewFps)
      ? FPS_OPTIONS
      : [...FPS_OPTIONS, { value: previewFps, label: String(previewFps) }]
  ), [previewFps])

  const handleAddLayer = useCallback(async (placement) => {
    const next = [...fsLayers, {
      trackId:  tracks[0]?.id ?? -1,
      placement,
      opacity:  placement === 'behind' ? 1.0 : 0.7,
    }]
    await window.xleth?.timeline?.setFullscreenLayers(next)
    notify()
  }, [fsLayers, tracks])

  const handleRemoveLayer = useCallback(async (index) => {
    const next = fsLayers.filter((_, i) => i !== index)
    await window.xleth?.timeline?.setFullscreenLayers(next)
    notify()
  }, [fsLayers])

  const handleUpdateLayer = useCallback(async (index, patch) => {
    const next = fsLayers.map((fl, i) => i === index ? { ...fl, ...patch } : fl)
    await window.xleth?.timeline?.setFullscreenLayers(next)
    notify()
  }, [fsLayers])

  const handleClearLayout = useCallback(async () => {
    if (!window.confirm('Clear all grid slots and fullscreen layers?')) return
    await window.xleth?.timeline?.setGridLayout({
      ...layout, slots: [], fullscreenLayers: [],
    })
    notify()
  }, [layout])

  return (
    <>
      {/* ── Compact Layout & Quality section ── */}
      <div className="grid-tab-section gsp-compact-section">
        <XlethPanelHeader title="Layout & Quality" />
        <div className="gsp-body">

          {/* Left: controls */}
          <div className="gsp-controls">
            <div className="gsp-layout-row">
              <div className="gsp-layout-controls">

            {/* Columns × Rows */}
            <div className="gsp-dims-row">
              <input
                className="gsp-dim-input"
                type="number" min={1} max={8}
                value={layout.columns}
                onChange={handleColumnsChange}
              />
              <span className="gsp-dim-sep">×</span>
              <input
                className="gsp-dim-input"
                type="number" min={1} max={8}
                value={layout.rows}
                onChange={handleRowsChange}
              />
            </div>

            {/* Link button */}
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

            {/* GAP */}
            <div className="gsp-gap-wrap">
              <div className="gsp-gap-header">
                <span className="gsp-gap-label">Gap</span>
                <span className="gsp-gap-value">
                  {Math.round((layout.gapScale ?? 0) * 100)} px
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

            {/* Project canvas: aspect ratio, resolution, FPS */}
            <div className="gsp-canvas-controls">
              <div className="gsp-canvas-row">
                <span className="gsp-canvas-label">Aspect</span>
                <XlethSelect
                  className="gsp-canvas-select"
                  value={canvasAspect}
                  options={ASPECT_PRESETS.map(a => ({ value: a.id, label: a.label }))}
                  onChange={handleAspectChange}
                  ariaLabel="Project aspect ratio"
                />
              </div>

              <div className="gsp-canvas-row">
                <span className="gsp-canvas-label">Size</span>
                <XlethSelect
                  className="gsp-canvas-select"
                  value={showSizeInputs ? 'custom' : resId}
                  options={[
                    ...resList.map(r => ({ value: `${r.width}x${r.height}`, label: `${r.label} (${r.width}×${r.height})` })),
                    { value: 'custom', label: 'Custom…' },
                  ]}
                  onChange={handleResolutionChange}
                  ariaLabel="Project base resolution"
                />
              </div>

              {showSizeInputs && (
                <div className="gsp-canvas-row gsp-canvas-size">
                  <input
                    className="gsp-dim-input"
                    type="number" min={CANVAS_MIN} max={CANVAS_MAX_W} step={2}
                    value={canvasW}
                    onChange={(e) => handleCanvasDimChange('w', e.target.value)}
                  />
                  <XlethIconButton
                    type="button"
                    className={`gsp-link-btn${dimsLocked ? ' active' : ''}`}
                    active={dimsLocked}
                    onClick={handleToggleLock}
                    title={dimsLocked ? 'Aspect locked — width/height stay in ratio' : 'Aspect unlocked — free ratio'}
                    aria-label={dimsLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    <Link2 aria-hidden="true" />
                  </XlethIconButton>
                  <input
                    className="gsp-dim-input"
                    type="number" min={CANVAS_MIN} max={CANVAS_MAX_H} step={2}
                    value={canvasH}
                    onChange={(e) => handleCanvasDimChange('h', e.target.value)}
                  />
                </div>
              )}

              <div className="gsp-canvas-row">
                <span className="gsp-canvas-label">FPS</span>
                <XlethSelect
                  className="gsp-canvas-select"
                  value={previewFps}
                  options={fpsOptions}
                  onChange={handleFpsChange}
                  ariaLabel="Project frame rate"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Fullscreen Layers ── */}
      <div className="grid-tab-section">
        <XlethPanelHeader
          title="Fullscreen Layers"
        />
        {fsLayers.length === 0 && (
          <div className="grid-tab-empty">No fullscreen layers</div>
        )}
        {fsLayers.map((fl, idx) => (
          <div key={idx} className="grid-tab-fslayer-card">
            <div className="grid-tab-fslayer-card-header">
              <XlethSelect
                className="grid-tab-fslayer-select"
                value={fl.trackId}
                options={trackOptions}
                onChange={(trackId) => handleUpdateLayer(idx, { trackId: Number(trackId) })}
                ariaLabel="Fullscreen layer track"
              />
              <XlethIconButton
                type="button"
                className="grid-tab-fslayer-remove"
                onClick={() => handleRemoveLayer(idx)}
                title="Remove layer"
                aria-label="Remove fullscreen layer"
              >
                <X aria-hidden="true" />
              </XlethIconButton>
            </div>
            <div className="grid-tab-fslayer-card-controls">
              <div className="grid-tab-fslayer-placement">
                <XlethButton
                  type="button"
                  className={fl.placement === 'behind' ? 'active' : ''}
                  active={fl.placement === 'behind'}
                  onClick={() => handleUpdateLayer(idx, { placement: 'behind' })}
                  title="Render behind grid"
                >Behind</XlethButton>
                <XlethButton
                  type="button"
                  className={fl.placement === 'front' ? 'active' : ''}
                  active={fl.placement === 'front'}
                  onClick={() => handleUpdateLayer(idx, { placement: 'front' })}
                  title="Render in front of grid"
                >Front</XlethButton>
              </div>
              <input
                type="range" min={0} max={1} step={0.05}
                value={fl.opacity}
                onChange={(e) => handleUpdateLayer(idx, { opacity: parseFloat(e.target.value) })}
              />
              <span className="grid-tab-fslayer-opacity-val">
                {Math.round(fl.opacity * 100)}%
              </span>
            </div>
          </div>
        ))}
        <div className="grid-tab-row grid-tab-fslayer-add">
          <XlethButton type="button" className="grid-tab-btn" onClick={() => handleAddLayer('behind')}>
            <Plus size={12} /><span>Add Behind</span>
          </XlethButton>
          <XlethButton type="button" className="grid-tab-btn" onClick={() => handleAddLayer('front')}>
            <Plus size={12} /><span>Add Front</span>
          </XlethButton>
        </div>
      </div>

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
    </>
  )
}

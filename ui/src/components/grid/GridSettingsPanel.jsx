import { useCallback } from 'react'
import { Grid3x3, Eraser, X, Plus } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import useGridEditStore from '../../stores/useGridEditStore.js'

const SUB_UNITS_PER_COLUMN = 8
const SUB_UNITS_PER_ROW    = 8

function filterSlotsForSize(slots, columns, rows) {
  const maxX = columns * SUB_UNITS_PER_COLUMN
  const maxY = rows    * SUB_UNITS_PER_ROW
  return slots.filter(s => s.gridX + s.spanX <= maxX && s.gridY + s.spanY <= maxY)
}

const notify = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

export default function GridSettingsPanel({ layout, setLayout, tracks }) {
  const gridEditMode = useGridEditStore((s) => s.gridEditMode)
  const setGridEditMode = useGridEditStore((s) => s.setGridEditMode)

  const handleColumnsChange = useCallback(async (e) => {
    const cols = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const filtered = filterSlotsForSize(layout.slots, cols, layout.rows)
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, slots: filtered })
    notify()
  }, [layout])

  const handleRowsChange = useCallback(async (e) => {
    const rows = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const filtered = filterSlotsForSize(layout.slots, layout.columns, rows)
    await window.xleth?.timeline?.setGridLayout({ ...layout, rows, slots: filtered })
    notify()
  }, [layout])

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
      <div className="grid-tab-section">
        <h3>Layout</h3>
        <div className="grid-tab-row">
          <label>Columns</label>
          <input type="number" min={1} max={8} value={layout.columns} onChange={handleColumnsChange} />
          <label style={{ minWidth: 'auto' }}>× Rows</label>
          <input type="number" min={1} max={8} value={layout.rows} onChange={handleRowsChange} />
        </div>
        <div className="grid-tab-row">
          <label>Gap</label>
          <input
            type="range" min={0} max={0.5} step={0.01}
            value={layout.gapScale ?? 0}
            onChange={(e) => setLayout(l => ({ ...l, gapScale: parseFloat(e.target.value) }))}
            onPointerUp={(e) => handleGapScaleChange(parseFloat(e.target.value))}
          />
          <span style={{ minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {(layout.gapScale ?? 0).toFixed(2)}
          </span>
        </div>
      </div>

      <div className="grid-tab-section">
        <h3>Preview</h3>
        <div className="grid-tab-row">
          <label>FPS</label>
          <input type="number" min={1} max={120} value={layout.previewFps}
            onChange={(e) => handleFpsChange(e.target.value)} />
          <div className="grid-tab-fps-presets">
            {[24, 30, 48, 60].map(fps => (
              <button key={fps}
                className={`grid-tab-fps-btn ${layout.previewFps === fps ? 'active' : ''}`}
                onClick={() => handleFpsChange(fps)}
              >{fps}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-tab-section">
        <div className="grid-tab-section-header">
          <h3>Fullscreen Layers</h3>
          {fsLayers.length > 0 && (
            <span className="grid-tab-section-count">
              {fsLayers.filter(l => l.placement === 'behind').length} Behind
              {' · '}
              {fsLayers.filter(l => l.placement === 'front').length} Front
            </span>
          )}
        </div>
        {fsLayers.length === 0 && (
          <div className="grid-tab-empty">No fullscreen layers</div>
        )}
        {fsLayers.map((fl, idx) => (
          <div key={idx} className="grid-tab-fslayer-card">
            <div className="grid-tab-fslayer-card-header">
              <select
                value={fl.trackId}
                onChange={(e) => handleUpdateLayer(idx, { trackId: parseInt(e.target.value) })}
              >
                <option value={-1}>-- None --</option>
                {tracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button
                type="button"
                className="grid-tab-fslayer-remove"
                onClick={() => handleRemoveLayer(idx)}
                title="Remove layer"
              >
                <X size={12} />
              </button>
            </div>
            <div className="grid-tab-fslayer-card-controls">
              <div className="grid-tab-fslayer-placement">
                <button
                  type="button"
                  className={fl.placement === 'behind' ? 'active' : ''}
                  onClick={() => handleUpdateLayer(idx, { placement: 'behind' })}
                  title="Render behind grid"
                >Behind</button>
                <button
                  type="button"
                  className={fl.placement === 'front' ? 'active' : ''}
                  onClick={() => handleUpdateLayer(idx, { placement: 'front' })}
                  title="Render in front of grid"
                >Front</button>
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
          <button type="button" className="grid-tab-btn" onClick={() => handleAddLayer('behind')}>
            <Plus size={12} /><span>Add Behind</span>
          </button>
          <button type="button" className="grid-tab-btn" onClick={() => handleAddLayer('front')}>
            <Plus size={12} /><span>Add Front</span>
          </button>
        </div>
      </div>

      <div className="grid-tab-section grid-tab-section--separated">
        <div className="grid-tab-actions">
          <button
            className={`grid-tab-btn ${gridEditMode ? 'active' : ''}`}
            onClick={() => setGridEditMode(!gridEditMode)}
          >
            <Grid3x3 size={13} />
            <span>{gridEditMode ? 'Exit Edit' : 'Edit Grid'}</span>
          </button>
          <button className="grid-tab-btn grid-tab-btn-danger" onClick={handleClearLayout}>
            <Eraser size={13} />
            <span>Clear Layout</span>
          </button>
        </div>
      </div>
    </>
  )
}

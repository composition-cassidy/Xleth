import { useCallback } from 'react'
import { Grid3x3, Eraser } from 'lucide-react'
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

  const handleChorusChange = useCallback(async (e) => {
    await window.xleth?.timeline?.setChorusTrack(parseInt(e.target.value))
    notify()
  }, [])

  const handleCrashEnabledChange = useCallback(async (e) => {
    await window.xleth?.timeline?.setCrashOverlay(e.target.checked, layout.crashTrackId, layout.crashOpacity)
    notify()
  }, [layout])

  const handleCrashTrackChange = useCallback(async (e) => {
    await window.xleth?.timeline?.setCrashOverlay(layout.crashEnabled, parseInt(e.target.value), layout.crashOpacity)
    notify()
  }, [layout])

  const handleCrashOpacityChange = useCallback(async (e) => {
    await window.xleth?.timeline?.setCrashOverlay(layout.crashEnabled, layout.crashTrackId, parseFloat(e.target.value))
    notify()
  }, [layout])

  const handleClearLayout = useCallback(async () => {
    if (!window.confirm('Clear all grid slots and reset chorus/crash?')) return
    await window.xleth?.timeline?.setGridLayout({
      ...layout, slots: [], chorusTrackId: -1,
      crashEnabled: false, crashTrackId: -1,
    })
    notify()
  }, [layout])

  return (
    <>
      <div className="grid-tab-section">
        <h3>Grid Size</h3>
        <div className="grid-tab-row">
          <label>Columns</label>
          <input type="number" min={1} max={8} value={layout.columns} onChange={handleColumnsChange} />
          <label style={{ minWidth: 'auto' }}>× Rows</label>
          <input type="number" min={1} max={8} value={layout.rows} onChange={handleRowsChange} />
        </div>
      </div>

      <div className="grid-tab-section">
        <h3>Cell Gap</h3>
        <div className="grid-tab-row">
          <label>Global Gap</label>
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
        <h3>Preview FPS</h3>
        <div className="grid-tab-row">
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
        <h3>Chorus Layer</h3>
        <div className="grid-tab-row">
          <label>Track</label>
          <select value={layout.chorusTrackId} onChange={handleChorusChange}>
            <option value={-1}>-- None --</option>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      <div className="grid-tab-section">
        <h3>Crash Overlay</h3>
        <div className="grid-tab-row">
          <label>
            <input type="checkbox" checked={layout.crashEnabled} onChange={handleCrashEnabledChange} />
            {' '}Enabled
          </label>
        </div>
        <div className="grid-tab-row">
          <label>Track</label>
          <select value={layout.crashTrackId} onChange={handleCrashTrackChange} disabled={!layout.crashEnabled}>
            <option value={-1}>-- None --</option>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="grid-tab-row">
          <label>Opacity</label>
          <input type="range" min={0} max={1} step={0.05}
            value={layout.crashOpacity} onChange={handleCrashOpacityChange}
            disabled={!layout.crashEnabled} />
          <span style={{ minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {layout.crashOpacity.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="grid-tab-section">
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

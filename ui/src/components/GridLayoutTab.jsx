import { useState, useEffect, useCallback } from 'react'
import { Grid3x3, Eraser } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  chorusTrackId: -1, crashEnabled: false, crashTrackId: -1, crashOpacity: 0.7,
  previewFps: 30,
}

// Filter slots that still fit within the new grid dimensions (half-grid coords)
function filterSlotsForSize(slots, columns, rows) {
  const maxX = columns * 2, maxY = rows * 2
  return slots.filter(s => s.gridX + s.spanX <= maxX && s.gridY + s.spanY <= maxY)
}

export default function GridLayoutTab({ gridEditMode, setGridEditMode }) {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [tracks, setTracks] = useState([])

  // ── Fetch layout + tracks ─────────────────────────────────────────────────
  const fetchLayout = useCallback(async () => {
    try {
      const l = await window.xleth?.timeline?.getGridLayout()
      if (l) setLayout(l)
    } catch (e) {
      console.error('[GridLayoutTab] getGridLayout failed:', e)
    }
  }, [])

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (Array.isArray(t)) setTracks(t)
    } catch (e) {
      console.error('[GridLayoutTab] getTracks failed:', e)
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

  // ── Mutation wrapper ─────────────────────────────────────────────────────
  const notify = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

  // ── Grid size ─────────────────────────────────────────────────────────────
  const handleColumnsChange = useCallback(async (e) => {
    const cols = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const filtered = filterSlotsForSize(layout.slots, cols, layout.rows)
    const dropped = layout.slots.length - filtered.length
    await window.xleth?.timeline?.setGridLayout({ ...layout, columns: cols, slots: filtered })
    if (dropped > 0) console.log(`[GridLayoutTab] ${dropped} slot(s) dropped when shrinking to ${cols} cols`)
    notify()
  }, [layout])

  const handleRowsChange = useCallback(async (e) => {
    const rows = Math.max(1, Math.min(8, parseInt(e.target.value) || 1))
    const filtered = filterSlotsForSize(layout.slots, layout.columns, rows)
    const dropped = layout.slots.length - filtered.length
    await window.xleth?.timeline?.setGridLayout({ ...layout, rows, slots: filtered })
    if (dropped > 0) console.log(`[GridLayoutTab] ${dropped} slot(s) dropped when shrinking to ${rows} rows`)
    notify()
  }, [layout])

  // ── Preview FPS ───────────────────────────────────────────────────────────
  const handleFpsChange = useCallback(async (fps) => {
    const clamped = Math.max(1, Math.min(120, parseInt(fps) || 30))
    await window.xleth?.timeline?.setPreviewFps(clamped)
    notify()
  }, [])

  // ── Chorus ────────────────────────────────────────────────────────────────
  const handleChorusChange = useCallback(async (e) => {
    const trackId = parseInt(e.target.value)
    await window.xleth?.timeline?.setChorusTrack(trackId)
    notify()
  }, [])

  // ── Crash overlay ─────────────────────────────────────────────────────────
  const handleCrashEnabledChange = useCallback(async (e) => {
    const enabled = e.target.checked
    await window.xleth?.timeline?.setCrashOverlay(enabled, layout.crashTrackId, layout.crashOpacity)
    notify()
  }, [layout])

  const handleCrashTrackChange = useCallback(async (e) => {
    const trackId = parseInt(e.target.value)
    await window.xleth?.timeline?.setCrashOverlay(layout.crashEnabled, trackId, layout.crashOpacity)
    notify()
  }, [layout])

  const handleCrashOpacityChange = useCallback(async (e) => {
    const opacity = parseFloat(e.target.value)
    await window.xleth?.timeline?.setCrashOverlay(layout.crashEnabled, layout.crashTrackId, opacity)
    notify()
  }, [layout])

  // ── Clear layout ──────────────────────────────────────────────────────────
  const handleClearLayout = useCallback(async () => {
    if (!window.confirm('Clear all grid slots and reset chorus/crash?')) return
    await window.xleth?.timeline?.setGridLayout({
      ...layout, slots: [], chorusTrackId: -1,
      crashEnabled: false, crashTrackId: -1,
    })
    notify()
    console.log('[GridLayoutTab] Layout cleared')
  }, [layout])

  // ── Derived: slot-by-trackId lookup for the track list ────────────────────
  const slotByTrack = new Map(layout.slots.map(s => [s.trackId, s]))
  const chorusTrack = tracks.find(t => t.id === layout.chorusTrackId)
  const crashTrack = tracks.find(t => t.id === layout.crashTrackId)

  return (
    <div className="grid-tab">
      {/* ── Grid Size ───────────────────────────────────── */}
      <div className="grid-tab-section">
        <h3>Grid Size</h3>
        <div className="grid-tab-row">
          <label>Columns</label>
          <input
            type="number" min={1} max={8}
            value={layout.columns}
            onChange={handleColumnsChange}
          />
          <label style={{ minWidth: 'auto' }}>× Rows</label>
          <input
            type="number" min={1} max={8}
            value={layout.rows}
            onChange={handleRowsChange}
          />
        </div>
      </div>

      {/* ── Preview FPS ─────────────────────────────────── */}
      <div className="grid-tab-section">
        <h3>Preview FPS</h3>
        <div className="grid-tab-row">
          <input
            type="number" min={1} max={120}
            value={layout.previewFps}
            onChange={(e) => handleFpsChange(e.target.value)}
          />
          <div className="grid-tab-fps-presets">
            {[24, 30, 48, 60].map(fps => (
              <button
                key={fps}
                className={`grid-tab-fps-btn ${layout.previewFps === fps ? 'active' : ''}`}
                onClick={() => handleFpsChange(fps)}
              >{fps}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Chorus Layer ────────────────────────────────── */}
      <div className="grid-tab-section">
        <h3>Chorus Layer</h3>
        <div className="grid-tab-row">
          <label>Track</label>
          <select value={layout.chorusTrackId} onChange={handleChorusChange}>
            <option value={-1}>-- None --</option>
            {tracks.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Crash Overlay ───────────────────────────────── */}
      <div className="grid-tab-section">
        <h3>Crash Overlay</h3>
        <div className="grid-tab-row">
          <label>
            <input
              type="checkbox"
              checked={layout.crashEnabled}
              onChange={handleCrashEnabledChange}
            />
            {' '}Enabled
          </label>
        </div>
        <div className="grid-tab-row">
          <label>Track</label>
          <select
            value={layout.crashTrackId}
            onChange={handleCrashTrackChange}
            disabled={!layout.crashEnabled}
          >
            <option value={-1}>-- None --</option>
            {tracks.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        <div className="grid-tab-row">
          <label>Opacity</label>
          <input
            type="range" min={0} max={1} step={0.05}
            value={layout.crashOpacity}
            onChange={handleCrashOpacityChange}
            disabled={!layout.crashEnabled}
          />
          <span style={{ minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {layout.crashOpacity.toFixed(2)}
          </span>
        </div>
      </div>

      {/* ── Actions ─────────────────────────────────────── */}
      <div className="grid-tab-section">
        <div className="grid-tab-actions">
          <button
            className={`grid-tab-btn ${gridEditMode ? 'active' : ''}`}
            onClick={() => setGridEditMode(!gridEditMode)}
          >
            <Grid3x3 size={13} />
            <span>{gridEditMode ? 'Exit Edit' : 'Edit Grid'}</span>
          </button>
          <button
            className="grid-tab-btn grid-tab-btn-danger"
            onClick={handleClearLayout}
          >
            <Eraser size={13} />
            <span>Clear Layout</span>
          </button>
        </div>
      </div>

      {/* ── Track List ──────────────────────────────────── */}
      <div className="grid-tab-section">
        <h3>Tracks</h3>
        {tracks.length === 0 ? (
          <div className="grid-tab-empty">No tracks yet</div>
        ) : (
          <div className="grid-tab-track-list">
            {tracks.map(t => {
              const slot = slotByTrack.get(t.id)
              const badges = []
              if (chorusTrack?.id === t.id) badges.push('chorus')
              if (layout.crashEnabled && crashTrack?.id === t.id) badges.push('crash')
              return (
                <div key={t.id} className="grid-tab-track-item">
                  <span className="grid-tab-track-name">{t.name}</span>
                  <span className="grid-tab-track-assignment">
                    {slot
                      ? `cell (${slot.gridX / 2 | 0},${slot.gridY / 2 | 0})${slot.spanX === 1 || slot.spanY === 1 ? ' ½' : ''}`
                      : 'unassigned'}
                    {badges.length > 0 && (
                      <span className="grid-tab-track-badges">
                        {badges.map(b => <span key={b} className={`grid-tab-badge grid-tab-badge-${b}`}>{b}</span>)}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

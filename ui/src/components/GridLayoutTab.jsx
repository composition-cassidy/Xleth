import { useState, useEffect, useCallback } from 'react'
import { Grid3x3, Eraser } from 'lucide-react'
import { timelineEvents } from '../timelineEvents.js'
import { snapToZero, snapToOne } from '../utils/sliderHelpers.js'

// Maximum number of visual effects per track — must match the engine cap.
// (CellConstants effect array is sized for 16; bridge will also reject above.)
const MAX_VFX_PER_TRACK = 16

// Effect type id → display name + CSS class (used for type-coded card border).
const VFX_TYPE_INFO = [
  { id: 0, name: 'Desaturation',          cls: 'desat'   },
  { id: 1, name: 'Tint',                  cls: 'tint'    },
  { id: 2, name: 'Brightness & Contrast', cls: 'bc'      },
  { id: 3, name: 'TV Simulator',          cls: 'tv'      },
  { id: 4, name: 'Zoom/Pan/Rot',          cls: 'zpr'     },
]

// Default param values per effect type — used both for "is non-default?"
// confirmation on remove and for resetting to a clean state.
const VFX_DEFAULTS = {
  0: [1.0],                                            // Desaturation: amount
  1: [1.0, 0.85, 0.6, 0.5, 0.15, 1.0],                 // Tint
  2: [0.0, 0.0],                                       // Brightness/Contrast
  3: [0.5, 1.0, 0.3, 0.003, 0.0, 2.0, 0.0],            // TV Simulator
  4: [1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 300, 1, 1, 1, 1.70158], // ZPR
}

function isVfxNonDefault(fx) {
  const defs = VFX_DEFAULTS[fx.type] ?? []
  for (let i = 0; i < defs.length; ++i) {
    const cur = fx.params?.[i] ?? defs[i]
    if (Math.abs(cur - defs[i]) > 1e-4) return true
  }
  return false
}

const DEFAULT_LAYOUT = {
  columns: 3, rows: 3, slots: [],
  chorusTrackId: -1, crashEnabled: false, crashTrackId: -1, crashOpacity: 0.7,
  previewFps: 30, gapScale: 0,
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

  // ── Gap scale ─────────────────────────────────────────────────────────────
  const handleGapScaleChange = useCallback(async (v) => {
    await window.xleth?.timeline?.setGridLayout({ ...layout, gapScale: v })
    notify()
  }, [layout])

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

  // ── Per-track Visual FX bulk actions (Prompt 12) ──────────────────────────

  // Reset every visual compositor setting on a track back to defaults. Used
  // by the per-track "Reset Visual FX" button. Each call is a separate undo
  // entry so the user can step back through the reset if they reset by
  // accident.
  const handleResetTrackVfx = useCallback(async (trackId) => {
    if (!window.confirm('Reset all visual effect settings on this track to defaults?')) return
    const tl = window.xleth?.timeline
    if (!tl) return
    await tl.setTrackGapScaleOverride(trackId, -1)
    await tl.setTrackCornerRadius(trackId, 0)
    await tl.setTrackBounceSettings(trackId, {
      enabled: false, directionDeg: 270, distance: 0.15, durationMs: 200,
      squashAmount: 0, overshoot: 1.70158, repeatCount: 1, easingType: 0,
    })
    await tl.setTrackZoomPanRotSettings(trackId, {
      enabled: false, startZoom: 1, targetZoom: 1, startPanX: 0, startPanY: 0,
      targetPanX: 0, targetPanY: 0, startRotation: 0, targetRotation: 0,
      durationMs: 300, zoomEasing: 1, panEasing: 1, rotEasing: 1, overshoot: 1.70158,
    })
    await tl.setTrackPingPongSettings(trackId, {
      enabled: false, regionStartPct: 0.8, regionEndPct: 1.0,
      crossfadeFrames: 3, reverseSpeed: 1.0, maxLoops: 0,
    })
    await tl.setTrackSlideNoteEffect(trackId, {
      type: 0, durationMode: 0, fixedDurationMs: 300,
      slideZoomDelta: 1, slidePanXDelta: 0, slidePanYDelta: 0,
      slideRotationDelta: 0, slideBounceDistance: 0, slideBounceDirDeg: 0,
      slideTVIntensity: 0,
    })
    // Clear the visual effect chain by removing from the end (each remove
    // shifts indices, so we walk backwards). Read fresh because the chain
    // length is in `tracks` state which is stale relative to the awaits.
    const tk = (await tl.getTracks())?.find(x => x.id === trackId)
    const len = tk?.visualEffectChain?.length ?? 0
    for (let i = len - 1; i >= 0; --i) {
      await tl.removeVisualEffect(trackId, i)
    }
    fetchTracks()
  }, [fetchTracks])

  // "Apply to all tracks" — copies a single value to every track via the
  // matching setter. One-time paste, NOT a binding.
  const applyCornerRadiusToAll = useCallback(async (value) => {
    const tl = window.xleth?.timeline
    if (!tl) return
    for (const t of tracks) {
      await tl.setTrackCornerRadius(t.id, value)
    }
    fetchTracks()
  }, [tracks, fetchTracks])

  // Confirm before removing a visual effect that has been customized — this
  // protects users from losing tweaked parameters with one stray click.
  const handleRemoveVfx = useCallback(async (trackId, fxIdx, fx) => {
    if (isVfxNonDefault(fx)) {
      if (!window.confirm(`Remove this ${VFX_TYPE_INFO[fx.type]?.name ?? 'effect'}? It has customized parameters that will be lost.`)) return
    }
    await window.xleth?.timeline?.removeVisualEffect(trackId, fxIdx)
    fetchTracks()
  }, [fetchTracks])

  // Add an effect, warning if the same type is already in the chain (some
  // effects benefit from stacking, others usually don't — the user decides).
  const handleAddVfx = useCallback(async (track, typeId) => {
    const chain = track.visualEffectChain ?? []
    if (chain.length >= MAX_VFX_PER_TRACK) return
    const dup = chain.some(fx => fx.type === typeId)
    if (dup) {
      const name = VFX_TYPE_INFO[typeId]?.name ?? 'effect'
      if (!window.confirm(`This track already has a ${name}. Add another?`)) return
    }
    await window.xleth?.timeline?.addVisualEffect(track.id, typeId)
    fetchTracks()
  }, [fetchTracks])

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

      {/* ── Cell Gap ────────────────────────────────────── */}
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
                  <div className="grid-tab-track-header">
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
                  <div className="grid-tab-track-sliders">
                    <label>Corner R</label>
                    <input
                      type="range" min={0} max={0.5} step={0.01}
                      defaultValue={t.cornerRadius ?? 0}
                      onPointerUp={async (e) => {
                        const v = snapToZero(parseFloat(e.target.value))
                        await window.xleth?.timeline?.setTrackCornerRadius(t.id, v)
                        fetchTracks()
                      }}
                    />
                    <button
                      className="grid-tab-mini-btn"
                      title="Copy this corner radius to every track (one-time paste)"
                      onClick={() => applyCornerRadiusToAll(t.cornerRadius ?? 0)}
                    >→All</button>
                    <label>
                      <input
                        type="checkbox"
                        checked={(t.gapScaleOverride ?? -1) >= 0}
                        onChange={async (e) => {
                          // Custom Gap toggle: -1 = use global, 0+ = override.
                          // When enabling, seed with the current global gap so
                          // the user starts from a sensible value.
                          const v = e.target.checked ? (layout.gapScale ?? 0) : -1
                          await window.xleth?.timeline?.setTrackGapScaleOverride(t.id, v)
                          fetchTracks()
                        }}
                      />
                      {' '}Custom Gap
                    </label>
                    {(t.gapScaleOverride ?? -1) >= 0 ? (
                      <input
                        type="range" min={0} max={0.5} step={0.01}
                        defaultValue={t.gapScaleOverride ?? 0}
                        onPointerUp={async (e) => {
                          const v = snapToZero(parseFloat(e.target.value))
                          await window.xleth?.timeline?.setTrackGapScaleOverride(t.id, v)
                          fetchTracks()
                        }}
                      />
                    ) : (
                      <span className="grid-tab-using-global">
                        Using global: {Math.round((layout.gapScale ?? 0) * 100)}%
                      </span>
                    )}
                  </div>
                  <div className="grid-tab-track-bounce">
                    <label>
                      <input
                        type="checkbox"
                        checked={t.bounce?.enabled ?? false}
                        onChange={async (e) => {
                          await window.xleth?.timeline?.setTrackBounceSettings(t.id,
                            { ...(t.bounce ?? {}), enabled: e.target.checked })
                          fetchTracks()
                        }}
                      />
                      {' '}Bounce
                    </label>
                    {t.bounce?.enabled && (
                      <>
                        <div className="grid-tab-row">
                          <label>Dir</label>
                          {[['↑', 90], ['↓', 270], ['←', 180], ['→', 0]].map(([lbl, deg]) => (
                            <button
                              key={deg}
                              className={`grid-tab-dir-btn ${(t.bounce?.directionDeg ?? 270) === deg ? 'active' : ''}`}
                              onClick={async () => {
                                await window.xleth?.timeline?.setTrackBounceSettings(t.id,
                                  { ...(t.bounce ?? {}), directionDeg: deg })
                                fetchTracks()
                              }}
                            >{lbl}</button>
                          ))}
                        </div>
                        <div className="grid-tab-row">
                          <label>Dist</label>
                          <input
                            type="range" min={0} max={1} step={0.01}
                            defaultValue={t.bounce?.distance ?? 0.15}
                            onPointerUp={async (e) => {
                              await window.xleth?.timeline?.setTrackBounceSettings(t.id,
                                { ...(t.bounce ?? {}), distance: parseFloat(e.target.value) })
                              fetchTracks()
                            }}
                          />
                        </div>
                        <div className="grid-tab-row">
                          <label>Dur ms</label>
                          <input
                            type="number" min={20} max={2000} step={10}
                            defaultValue={t.bounce?.durationMs ?? 200}
                            onBlur={async (e) => {
                              await window.xleth?.timeline?.setTrackBounceSettings(t.id,
                                { ...(t.bounce ?? {}), durationMs: parseFloat(e.target.value) })
                              fetchTracks()
                            }}
                          />
                        </div>
                        <div className="grid-tab-row">
                          <label>Repeat</label>
                          <input
                            type="number" min={1} max={8} step={1}
                            defaultValue={t.bounce?.repeatCount ?? 1}
                            onBlur={async (e) => {
                              await window.xleth?.timeline?.setTrackBounceSettings(t.id,
                                { ...(t.bounce ?? {}), repeatCount: parseInt(e.target.value) || 1 })
                              fetchTracks()
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {/* ── Zoom/Pan/Rot ── */}
                  <div className="grid-tab-track-zpr">
                    <label>
                      <input
                        type="checkbox"
                        checked={t.zoomPanRot?.enabled ?? false}
                        onChange={async (e) => {
                          await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                            { ...(t.zoomPanRot ?? {}), enabled: e.target.checked })
                          fetchTracks()
                        }}
                      />
                      {' '}Zoom/Pan/Rot
                    </label>
                    {t.zoomPanRot?.enabled && (
                      <>
                        <div className="grid-tab-row">
                          <label>Target Zoom</label>
                          <input type="range" min={0.25} max={4} step={0.01}
                            defaultValue={t.zoomPanRot?.targetZoom ?? 1}
                            onPointerUp={async (e) => {
                              const v = snapToOne(parseFloat(e.target.value))
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), targetZoom: v })
                              fetchTracks()
                            }}
                          />
                          <span>{(t.zoomPanRot?.targetZoom ?? 1).toFixed(2)}×</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Dur ms</label>
                          <input type="number" min={20} max={5000} step={10}
                            defaultValue={t.zoomPanRot?.durationMs ?? 300}
                            onBlur={async (e) => {
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), durationMs: parseFloat(e.target.value) || 300 })
                              fetchTracks()
                            }}
                          />
                        </div>
                        <div className="grid-tab-row">
                          <label>Start Zoom</label>
                          <input type="range" min={0.25} max={4} step={0.01}
                            defaultValue={t.zoomPanRot?.startZoom ?? 1}
                            onPointerUp={async (e) => {
                              const v = snapToOne(parseFloat(e.target.value))
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), startZoom: v })
                              fetchTracks()
                            }}
                          />
                          <span>{(t.zoomPanRot?.startZoom ?? 1).toFixed(2)}×</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Pan X</label>
                          <input type="range" min={-1} max={1} step={0.01}
                            defaultValue={t.zoomPanRot?.targetPanX ?? 0}
                            onPointerUp={async (e) => {
                              const v = snapToZero(parseFloat(e.target.value))
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), targetPanX: v })
                              fetchTracks()
                            }}
                          />
                          <span>{(t.zoomPanRot?.targetPanX ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Pan Y</label>
                          <input type="range" min={-1} max={1} step={0.01}
                            defaultValue={t.zoomPanRot?.targetPanY ?? 0}
                            onPointerUp={async (e) => {
                              const v = snapToZero(parseFloat(e.target.value))
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), targetPanY: v })
                              fetchTracks()
                            }}
                          />
                          <span>{(t.zoomPanRot?.targetPanY ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Rotation°</label>
                          <input type="number" min={-360} max={360} step={1}
                            defaultValue={t.zoomPanRot?.targetRotation ?? 0}
                            onBlur={async (e) => {
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), targetRotation: parseFloat(e.target.value) || 0 })
                              fetchTracks()
                            }}
                          />
                        </div>
                        <div className="grid-tab-row">
                          <label>Easing</label>
                          <select
                            value={t.zoomPanRot?.zoomEasing ?? 1}
                            onChange={async (e) => {
                              const v = parseInt(e.target.value)
                              await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                { ...(t.zoomPanRot ?? {}), zoomEasing: v, panEasing: v, rotEasing: v })
                              fetchTracks()
                            }}
                          >
                            <option value={0}>Linear</option>
                            <option value={1}>Ease Out</option>
                            <option value={2}>Ease In-Out</option>
                            <option value={3}>Ease Out Back</option>
                          </select>
                        </div>
                        {(t.zoomPanRot?.zoomEasing === 3) && (
                          <div className="grid-tab-row">
                            <label>Overshoot</label>
                            <input type="range" min={0.5} max={3} step={0.01}
                              defaultValue={t.zoomPanRot?.overshoot ?? 1.70158}
                              onPointerUp={async (e) => {
                                await window.xleth?.timeline?.setTrackZoomPanRotSettings(t.id,
                                  { ...(t.zoomPanRot ?? {}), overshoot: parseFloat(e.target.value) })
                                fetchTracks()
                              }}
                            />
                            <span>{(t.zoomPanRot?.overshoot ?? 1.70158).toFixed(2)}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* ── Ping-Pong Loop ── */}
                  <div className="grid-tab-track-pingpong">
                    <label>
                      <input
                        type="checkbox"
                        checked={t.pingPong?.enabled ?? false}
                        onChange={async (e) => {
                          await window.xleth?.timeline?.setTrackPingPongSettings(t.id,
                            { ...(t.pingPong ?? {}), enabled: e.target.checked })
                          fetchTracks()
                        }}
                      />
                      {' '}Ping-Pong Loop
                    </label>
                    {t.pingPong?.enabled && (
                      <>
                        <div className="grid-tab-row">
                          <label>Region Start</label>
                          <input type="range" min={0} max={1} step={0.01}
                            defaultValue={t.pingPong?.regionStartPct ?? 0.8}
                            onPointerUp={async (e) => {
                              const v = parseFloat(e.target.value)
                              await window.xleth?.timeline?.setTrackPingPongSettings(t.id,
                                { ...(t.pingPong ?? {}), regionStartPct: v })
                              fetchTracks()
                            }}
                          />
                          <span>{((t.pingPong?.regionStartPct ?? 0.8) * 100).toFixed(0)}%</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Region End</label>
                          <input type="range" min={0} max={1} step={0.01}
                            defaultValue={t.pingPong?.regionEndPct ?? 1.0}
                            onPointerUp={async (e) => {
                              const v = parseFloat(e.target.value)
                              await window.xleth?.timeline?.setTrackPingPongSettings(t.id,
                                { ...(t.pingPong ?? {}), regionEndPct: v })
                              fetchTracks()
                            }}
                          />
                          <span>{((t.pingPong?.regionEndPct ?? 1.0) * 100).toFixed(0)}%</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Crossfade Fr</label>
                          <input type="number" min={0} max={30} step={1}
                            defaultValue={t.pingPong?.crossfadeFrames ?? 3}
                            onBlur={async (e) => {
                              await window.xleth?.timeline?.setTrackPingPongSettings(t.id,
                                { ...(t.pingPong ?? {}), crossfadeFrames: parseInt(e.target.value) || 0 })
                              fetchTracks()
                            }}
                          />
                        </div>
                        <div className="grid-tab-row">
                          <label>Reverse Speed</label>
                          <input type="range" min={0.25} max={4} step={0.01}
                            defaultValue={t.pingPong?.reverseSpeed ?? 1.0}
                            onPointerUp={async (e) => {
                              const v = snapToOne(parseFloat(e.target.value))
                              await window.xleth?.timeline?.setTrackPingPongSettings(t.id,
                                { ...(t.pingPong ?? {}), reverseSpeed: v })
                              fetchTracks()
                            }}
                          />
                          <span>{(t.pingPong?.reverseSpeed ?? 1.0).toFixed(2)}×</span>
                        </div>
                        <div className="grid-tab-row">
                          <label>Max Loops</label>
                          <input type="number" min={0} max={99} step={1}
                            defaultValue={t.pingPong?.maxLoops ?? 0}
                            onBlur={async (e) => {
                              await window.xleth?.timeline?.setTrackPingPongSettings(t.id,
                                { ...(t.pingPong ?? {}), maxLoops: parseInt(e.target.value) || 0 })
                              fetchTracks()
                            }}
                          />
                          <span style={{fontSize:'0.75em', opacity:0.6}}>(0=∞)</span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* ── Slide Note Effect (pattern tracks only) ── */}
                  {t.type === 'Pattern' && (
                  <div className="grid-tab-track-slide">
                    <div className="grid-tab-row">
                      <label>Slide Note Effect</label>
                      <select
                        value={t.slideNoteEffect?.type ?? 0}
                        onChange={async (e) => {
                          const v = parseInt(e.target.value) || 0
                          await window.xleth?.timeline?.setTrackSlideNoteEffect(t.id,
                            { ...(t.slideNoteEffect ?? {}), type: v })
                          fetchTracks()
                        }}
                      >
                        <option value="0">None</option>
                        <option value="1">Zoom/Pan/Rot</option>
                        <option value="2">Bounce</option>
                        <option value="3">TV Simulator</option>
                      </select>
                    </div>
                    {(t.slideNoteEffect?.type ?? 0) !== 0 && (
                      <>
                        <div className="grid-tab-row">
                          <label>Duration Mode</label>
                          <select
                            value={t.slideNoteEffect?.durationMode ?? 0}
                            onChange={async (e) => {
                              const v = parseInt(e.target.value) || 0
                              await window.xleth?.timeline?.setTrackSlideNoteEffect(t.id,
                                { ...(t.slideNoteEffect ?? {}), durationMode: v })
                              fetchTracks()
                            }}
                          >
                            <option value="0">Follow Slide</option>
                            <option value="1">Fixed</option>
                          </select>
                        </div>
                        {(t.slideNoteEffect?.durationMode ?? 0) === 1 && (
                          <div className="grid-tab-row">
                            <label>Fixed Duration (ms)</label>
                            <input type="number" min={10} max={5000} step={10}
                              defaultValue={t.slideNoteEffect?.fixedDurationMs ?? 300}
                              onBlur={async (e) => {
                                const v = parseFloat(e.target.value) || 300
                                await window.xleth?.timeline?.setTrackSlideNoteEffect(t.id,
                                  { ...(t.slideNoteEffect ?? {}), fixedDurationMs: v })
                                fetchTracks()
                              }}
                            />
                          </div>
                        )}
                        <div className="grid-tab-slide-info">
                          Slide notes will trigger the selected animation using the settings above.
                        </div>
                      </>
                    )}
                  </div>
                  )}

                  {/* ── Visual FX chain ── */}
                  <div className="grid-tab-track-vfx">
                    <div className="grid-tab-vfx-header">
                      <span>
                        Visual FX
                        <span className="grid-tab-vfx-count">
                          {(t.visualEffectChain ?? []).length}
                        </span>
                      </span>
                      <select
                        defaultValue=""
                        disabled={(t.visualEffectChain ?? []).length >= MAX_VFX_PER_TRACK}
                        title={(t.visualEffectChain ?? []).length >= MAX_VFX_PER_TRACK
                          ? `Maximum ${MAX_VFX_PER_TRACK} visual effects per track`
                          : 'Add a visual effect to this track'}
                        onChange={async (e) => {
                          const typeId = parseInt(e.target.value)
                          if (isNaN(typeId)) return
                          e.target.value = ''
                          await handleAddVfx(t, typeId)
                        }}
                      >
                        <option value="">+ Add effect</option>
                        <option value="0">Desaturation</option>
                        <option value="1">Tint</option>
                        <option value="2">Brightness &amp; Contrast</option>
                        <option value="3">TV Simulator</option>
                        <option value="4">Zoom/Pan/Rot</option>
                      </select>
                    </div>

                    {(t.visualEffectChain ?? []).length === 0 && (
                      <div className="grid-tab-vfx-empty">No visual effects</div>
                    )}

                    {(t.visualEffectChain ?? []).map((fx, fxIdx) => {
                      const info = VFX_TYPE_INFO[fx.type] ?? { name: `Effect ${fx.type}`, cls: '' }
                      return (
                        <div key={fxIdx}
                             className={`grid-tab-vfx-card vfx-${info.cls} ${fx.bypassed ? 'bypassed' : ''}`}>
                          <div className="grid-tab-vfx-card-header">
                            <span className="grid-tab-vfx-name">{info.name}</span>
                            <div className="grid-tab-vfx-card-actions">
                              {fxIdx > 0 && (
                                <button title="Move up" onClick={async () => {
                                  await window.xleth?.timeline?.reorderVisualEffect(t.id, fxIdx, fxIdx - 1)
                                  fetchTracks()
                                }}>↑</button>
                              )}
                              {fxIdx < (t.visualEffectChain?.length ?? 1) - 1 && (
                                <button title="Move down" onClick={async () => {
                                  await window.xleth?.timeline?.reorderVisualEffect(t.id, fxIdx, fxIdx + 1)
                                  fetchTracks()
                                }}>↓</button>
                              )}
                              <button
                                title={fx.bypassed ? 'Enable' : 'Bypass'}
                                className={fx.bypassed ? 'bypass-off' : 'bypass-on'}
                                onClick={async () => {
                                  await window.xleth?.timeline?.setVisualEffectBypassed(t.id, fxIdx, !fx.bypassed)
                                  fetchTracks()
                                }}
                              >{fx.bypassed ? '○' : '●'}</button>
                              <button title="Remove" onClick={() => handleRemoveVfx(t.id, fxIdx, fx)}>✕</button>
                            </div>
                          </div>

                          {/* Per-effect parameter controls */}
                          <div className="grid-tab-vfx-params">
                            {fx.type === 0 && ( /* Desaturation */
                              <div className="grid-tab-row">
                                <label>Amount</label>
                                <input type="range" min={0} max={1} step={0.01}
                                  defaultValue={fx.params?.[0] ?? 1}
                                  onPointerUp={async (e) => {
                                    const v = snapToZero(parseFloat(e.target.value))
                                    await window.xleth?.timeline?.setVisualEffectParam(
                                      t.id, fxIdx, 0, v)
                                    fetchTracks()
                                  }}
                                />
                                <span>{((fx.params?.[0] ?? 1) * 100).toFixed(0)}%</span>
                              </div>
                            )}
                            {fx.type === 1 && ( /* Tint */
                              <>
                                <div className="grid-tab-row">
                                  <label>Colour</label>
                                  <input
                                    type="color"
                                    defaultValue={(() => {
                                      const r = Math.round((fx.params?.[0] ?? 1) * 255).toString(16).padStart(2, '0')
                                      const g = Math.round((fx.params?.[1] ?? 0.85) * 255).toString(16).padStart(2, '0')
                                      const b = Math.round((fx.params?.[2] ?? 0.6) * 255).toString(16).padStart(2, '0')
                                      return `#${r}${g}${b}`
                                    })()}
                                    onBlur={async (e) => {
                                      const hex = e.target.value
                                      const r = parseInt(hex.slice(1,3),16)/255
                                      const g = parseInt(hex.slice(3,5),16)/255
                                      const b = parseInt(hex.slice(5,7),16)/255
                                      await window.xleth?.timeline?.setVisualEffectParam(t.id, fxIdx, 0, r)
                                      await window.xleth?.timeline?.setVisualEffectParam(t.id, fxIdx, 1, g)
                                      await window.xleth?.timeline?.setVisualEffectParam(t.id, fxIdx, 2, b)
                                      fetchTracks()
                                    }}
                                  />
                                </div>
                                <div className="grid-tab-row">
                                  <label>Strength</label>
                                  <input type="range" min={0} max={1} step={0.01}
                                    defaultValue={fx.params?.[3] ?? 0.5}
                                    onPointerUp={async (e) => {
                                      const v = snapToZero(parseFloat(e.target.value))
                                      await window.xleth?.timeline?.setVisualEffectParam(
                                        t.id, fxIdx, 3, v)
                                      fetchTracks()
                                    }}
                                  />
                                  <span>{((fx.params?.[3] ?? 0.5) * 100).toFixed(0)}%</span>
                                </div>
                                <div className="grid-tab-row">
                                  <label>Floor</label>
                                  <input type="range" min={0} max={1} step={0.01}
                                    defaultValue={fx.params?.[4] ?? 0.15}
                                    onPointerUp={async (e) => {
                                      await window.xleth?.timeline?.setVisualEffectParam(
                                        t.id, fxIdx, 4, parseFloat(e.target.value))
                                      fetchTracks()
                                    }}
                                  />
                                  <span>{((fx.params?.[4] ?? 0.15) * 100).toFixed(0)}%</span>
                                </div>
                                <div className="grid-tab-row">
                                  <label>Ceiling</label>
                                  <input type="range" min={0} max={1} step={0.01}
                                    defaultValue={fx.params?.[5] ?? 1.0}
                                    onPointerUp={async (e) => {
                                      await window.xleth?.timeline?.setVisualEffectParam(
                                        t.id, fxIdx, 5, parseFloat(e.target.value))
                                      fetchTracks()
                                    }}
                                  />
                                  <span>{((fx.params?.[5] ?? 1.0) * 100).toFixed(0)}%</span>
                                </div>
                              </>
                            )}
                            {fx.type === 2 && ( /* Brightness & Contrast */
                              <>
                                <div className="grid-tab-row">
                                  <label>Brightness</label>
                                  <input type="range" min={-1} max={1} step={0.01}
                                    defaultValue={fx.params?.[0] ?? 0}
                                    onPointerUp={async (e) => {
                                      const v = snapToZero(parseFloat(e.target.value))
                                      await window.xleth?.timeline?.setVisualEffectParam(
                                        t.id, fxIdx, 0, v)
                                      fetchTracks()
                                    }}
                                  />
                                  <span>{((fx.params?.[0] ?? 0) * 100).toFixed(0)}%</span>
                                </div>
                                <div className="grid-tab-row">
                                  <label>Contrast</label>
                                  <input type="range" min={-1} max={1} step={0.01}
                                    defaultValue={fx.params?.[1] ?? 0}
                                    onPointerUp={async (e) => {
                                      const v = snapToZero(parseFloat(e.target.value))
                                      await window.xleth?.timeline?.setVisualEffectParam(
                                        t.id, fxIdx, 1, v)
                                      fetchTracks()
                                    }}
                                  />
                                  <span>{((fx.params?.[1] ?? 0) * 100).toFixed(0)}%</span>
                                </div>
                              </>
                            )}
                            {fx.type === 3 && ( /* TV Simulator */
                              <>
                                {[
                                  { label: 'Intensity',   pi: 0, min: 0,    max: 1,    step: 0.01,   def: 0.5,   fmt: v => (v * 100).toFixed(0) + '%' },
                                  { label: 'Roll Speed',  pi: 1, min: 0,    max: 5,    step: 0.01,   def: 1.0,   fmt: v => v.toFixed(2)              },
                                  { label: 'Scanlines',   pi: 2, min: 0,    max: 1,    step: 0.01,   def: 0.3,   fmt: v => (v * 100).toFixed(0) + '%' },
                                  { label: 'Chroma',      pi: 3, min: 0,    max: 0.01, step: 0.0001, def: 0.003, fmt: v => v.toFixed(4)              },
                                  { label: 'Noise',       pi: 4, min: 0,    max: 1,    step: 0.01,   def: 0.0,   fmt: v => (v * 100).toFixed(0) + '%' },
                                  { label: 'Jitter',      pi: 5, min: 0,    max: 10,   step: 0.1,    def: 2.0,   fmt: v => v.toFixed(1)              },
                                  { label: 'Color Bleed', pi: 6, min: 0,    max: 0.02, step: 0.0001, def: 0.0,   fmt: v => v.toFixed(4)              },
                                ].map(({ label, pi, min, max, step, def, fmt }) => (
                                  <div key={pi} className="grid-tab-row">
                                    <label>{label}</label>
                                    <input type="range" min={min} max={max} step={step}
                                      defaultValue={fx.params?.[pi] ?? def}
                                      onPointerUp={async (e) => {
                                        await window.xleth?.timeline?.setVisualEffectParam(
                                          t.id, fxIdx, pi, parseFloat(e.target.value))
                                        fetchTracks()
                                      }}
                                    />
                                    <span>{fmt(fx.params?.[pi] ?? def)}</span>
                                  </div>
                                ))}
                              </>
                            )}
                            {fx.type === 4 && ( /* ZoomPanRotation — static target values (used when no animation active) */
                              <>
                                {[
                                  { label: 'Target Zoom', pi: 1, min: 0.25, max: 4,   step: 0.01, def: 1.0, fmt: v => v.toFixed(2) + '×', snap1: true  },
                                  { label: 'Pan X',       pi: 4, min: -1,   max: 1,   step: 0.01, def: 0.0, fmt: v => v.toFixed(2),        snap0: true  },
                                  { label: 'Pan Y',       pi: 5, min: -1,   max: 1,   step: 0.01, def: 0.0, fmt: v => v.toFixed(2),        snap0: true  },
                                  { label: 'Rotation°',   pi: 7, min: -360, max: 360, step: 1,    def: 0.0, fmt: v => v.toFixed(0) + '°',  snap0: true  },
                                ].map(({ label, pi, min, max, step, def, fmt, snap0, snap1 }) => (
                                  <div key={pi} className="grid-tab-row">
                                    <label>{label}</label>
                                    <input type="range" min={min} max={max} step={step}
                                      defaultValue={fx.params?.[pi] ?? def}
                                      onPointerUp={async (e) => {
                                        let v = parseFloat(e.target.value)
                                        if (snap0) v = snapToZero(v)
                                        if (snap1) v = snapToOne(v)
                                        await window.xleth?.timeline?.setVisualEffectParam(
                                          t.id, fxIdx, pi, v)
                                        fetchTracks()
                                      }}
                                    />
                                    <span>{fmt(fx.params?.[pi] ?? def)}</span>
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Reset Visual FX (track-wide) ── */}
                  <div className="grid-tab-track-reset">
                    <button
                      className="grid-tab-btn grid-tab-btn-danger-muted"
                      title="Reset every visual effect setting on this track to defaults"
                      onClick={() => handleResetTrackVfx(t.id)}
                    >
                      Reset Visual FX
                    </button>
                  </div>

                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

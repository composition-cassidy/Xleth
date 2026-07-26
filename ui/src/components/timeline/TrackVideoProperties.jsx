import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, RefreshCw, Layers } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import TrackFlipSection from './TrackFlipSection.jsx'
import CornerRadiusControl from '../grid/CornerRadiusControl.jsx'
import CustomGapControl from '../grid/CustomGapControl.jsx'
import VisualFXSection from '../grid/VisualFXSection.jsx'
import SlideNoteEffectSection from '../grid/SlideNoteEffectSection.jsx'
import { getTrackPlacement, placementBadgeLabel, setFullscreenPlacementMode } from './trackPlacement.js'
import { HOLD_THRESHOLD_UNLIMITED, formatHoldThreshold } from './holdLastFrame.js'

const notify     = () => timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
const notifyGrid = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

/**
 * Track Detail view — a single scrollable panel consolidating every per-track
 * video property that used to be scattered across the floating "Video Flip"
 * popover and the Grid Settings "Tracks" card list:
 *
 *   Flip cycle · Hold Last Frame · Corner Radius · per-track Gap · Visual FX ·
 *   Slide Note FX (Pattern tracks only)
 *
 * Reuses the exact same components / IPC calls the old surfaces used — this is
 * a container/shell rebuild, not a behaviour change. Reached via the track
 * right-click → "Video Properties…" entry (see useVideoTabStore).
 *
 * Props:
 *   trackId  – id of the track to edit
 *   onBack   – returns to the Video tab Overview (clears selectedTrackId)
 */
export default function TrackVideoProperties({ trackId, onBack }) {
  const [track, setTrack]     = useState(null)
  const [gapScale, setGapScale] = useState(0)
  const [layout, setLayout]   = useState(null)
  const [missing, setMissing] = useState(false)

  // ── Re-fetch just this track (plus the layout for gap + placement) ──
  const refresh = useCallback(async () => {
    try {
      const all = await window.xleth?.timeline?.getTracks()
      const t = Array.isArray(all) ? all.find(x => x.id === trackId) : null
      if (t) {
        setTrack(t)
        setMissing(false)
      } else {
        setMissing(true)
      }
      const gl = await window.xleth?.timeline?.getGridLayout()
      if (gl) { setGapScale(gl.gapScale ?? 0); setLayout(gl) }
    } catch (e) {
      console.error('[TrackVideoProperties] refresh failed:', e)
    }
  }, [trackId])

  useEffect(() => {
    console.log(`[TrackVideoProperties] opened track ${trackId}`)
    refresh()
    const onTracks = () => refresh()
    const onGrid   = () => refresh()
    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    timelineEvents.addEventListener('timeline-grid-changed',   onGrid)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
      timelineEvents.removeEventListener('timeline-grid-changed',   onGrid)
    }
  }, [trackId, refresh])

  // Passed to the reused list-card components. They call this after every IPC
  // commit; we re-fetch our single track AND broadcast so the Audio tab's
  // TimelineView (which mirrors these flags) stays in sync. The bare `refresh`
  // is the event listener, so this notify() does not recurse into itself.
  const fetchTracks = useCallback(() => { refresh(); notify() }, [refresh])

  // Flip commits go straight to the same atomic IPC the popover used.
  const handleCommitFlip = useCallback(async (config) => {
    try {
      await window.xleth?.timeline?.setVideoFlipConfig(trackId, config)
      console.log(`[TrackVideoProperties] flip config committed for track ${trackId}`)
      fetchTracks()
    } catch (err) {
      console.error('[TrackVideoProperties] setVideoFlipConfig failed:', err)
    }
  }, [trackId, fetchTracks])

  const handleToggleHold = useCallback(async (hold) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(trackId, hold)
      console.log(`[TrackVideoProperties] track ${trackId} videoHoldLastFrame → ${hold}`)
      fetchTracks()
    } catch (err) {
      console.error('[TrackVideoProperties] setVideoHoldLastFrame failed:', err)
    }
  }, [trackId, fetchTracks])

  // ── Hold threshold (beats) ─────────────────────────────────────────────────
  // Negative engine value = unlimited. The beats box keeps a local draft so
  // typing doesn't fire one IPC per keystroke; it commits on blur/Enter only.
  const thresholdBeats = Number(
    track?.videoHoldLastFrameThresholdBeats ?? HOLD_THRESHOLD_UNLIMITED)
  const thresholdIsUnlimited = !(thresholdBeats >= 0)

  const [thresholdDraft, setThresholdDraft] = useState('')
  useEffect(() => {
    setThresholdDraft(thresholdIsUnlimited ? '' : String(thresholdBeats))
  }, [thresholdBeats, thresholdIsUnlimited])

  const commitThreshold = useCallback(async (beats) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrameThreshold(trackId, beats)
      console.log(
        `[TrackVideoProperties] track ${trackId} videoHoldLastFrameThresholdBeats → ${
          beats < 0 ? 'unlimited' : beats}`)
      fetchTracks()
    } catch (err) {
      console.error('[TrackVideoProperties] setVideoHoldLastFrameThreshold failed:', err)
    }
  }, [trackId, fetchTracks])

  const commitThresholdDraft = useCallback(() => {
    const parsed = Number(thresholdDraft)
    // Blank or garbage reverts to the last committed value rather than
    // silently reinterpreting it as 0 (which would cut instantly).
    if (thresholdDraft.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
      setThresholdDraft(thresholdIsUnlimited ? '' : String(thresholdBeats))
      return
    }
    if (parsed !== thresholdBeats) commitThreshold(parsed)
  }, [thresholdDraft, thresholdBeats, thresholdIsUnlimited, commitThreshold])

  // ── Fullscreen opacity (relocated here from the old Fullscreen Layers list) ─
  // Shown only when the track's current placement is Fullscreen (Behind/Front).
  // Grid-slotted tracks use per-slot opacity surfaced in the grid editor, so we
  // deliberately don't duplicate it here.
  const placement = useMemo(
    () => (layout ? getTrackPlacement(trackId, layout) : { kind: 'unplaced' }),
    [layout, trackId]
  )
  const isFullscreen = placement.kind === 'behind' || placement.kind === 'front'

  const fsLayerOpacity = useMemo(() => {
    const fl = (layout?.fullscreenLayers ?? []).find(l => l.trackId === trackId)
    return fl ? (fl.opacity ?? 1) : 1
  }, [layout, trackId])

  // Local slider value for smooth dragging; committed once on pointer/key up.
  const [opacityDraft, setOpacityDraft] = useState(fsLayerOpacity)
  useEffect(() => { setOpacityDraft(fsLayerOpacity) }, [fsLayerOpacity])

  // Behind/Front hold-through-gap toggle — edits `placement` only, fully
  // independent of the track's current zOrder/drag position (see
  // setFullscreenPlacementMode in trackPlacement.js). Lives here, ongoing;
  // the context menu's "Make Fullscreen" only sets a one-time creation default.
  const handleSetPlacementMode = useCallback(async (mode) => {
    if (!track || !layout) return
    console.log(`[TrackVideoProperties] track ${trackId} placement toggle → ${mode}`)
    await setFullscreenPlacementMode(track, layout, mode)
  }, [track, layout, trackId])

  const commitFsOpacity = useCallback(async (value) => {
    if (!layout) return
    const next = (layout.fullscreenLayers ?? []).map(l =>
      l.trackId === trackId ? { ...l, opacity: value } : l)
    try {
      await window.xleth?.timeline?.setFullscreenLayers(next)
      console.log(`[TrackVideoProperties] fullscreen opacity for track ${trackId} → ${value}`)
      notifyGrid()
      refresh()
    } catch (err) {
      console.error('[TrackVideoProperties] setFullscreenLayers (opacity) failed:', err)
    }
  }, [layout, trackId, refresh])

  const applyCornerRadiusToAll = useCallback(async (value) => {
    try {
      const all = await window.xleth?.timeline?.getTracks()
      if (!Array.isArray(all)) return
      for (const t of all) await window.xleth?.timeline?.setTrackCornerRadius(t.id, value)
      console.log(`[TrackVideoProperties] corner radius ${value} applied to all tracks`)
      fetchTracks()
    } catch (err) {
      console.error('[TrackVideoProperties] applyCornerRadiusToAll failed:', err)
    }
  }, [fetchTracks])

  const breadcrumb = useMemo(() => (
    <div className="tvp-breadcrumb">
      <button
        type="button"
        className="tvp-back-btn"
        onClick={onBack}
        aria-label="Back to Video overview"
        title="Back to overview"
      >
        <ChevronLeft size={14} aria-hidden="true" />
        <span>Video</span>
      </button>
      <span className="tvp-breadcrumb-sep">/</span>
      <span className="tvp-breadcrumb-current">
        {track?.name ?? `Track ${trackId}`}
        {track && <span className="tvp-breadcrumb-type">{track.type}</span>}
      </span>
    </div>
  ), [onBack, track, trackId])

  if (missing) {
    return (
      <div className="grid-tab tvp-root">
        {breadcrumb}
        <div className="grid-tab-empty">
          Track {trackId} no longer exists.
          <button type="button" className="tvp-back-inline" onClick={onBack}>Back to overview</button>
        </div>
      </div>
    )
  }

  if (!track) {
    return (
      <div className="grid-tab tvp-root">
        {breadcrumb}
        <div className="grid-tab-empty">Loading track…</div>
      </div>
    )
  }

  const hold = track.videoHoldLastFrame || false
  const placementLabel = placementBadgeLabel(placement)
  const visualFxCount =
    (track.bounce?.enabled ? 1 : 0) +
    (track.zoomPanRot?.enabled ? 1 : 0) +
    (track.pingPong?.enabled ? 1 : 0) +
    (track.visualEffectChain?.length ?? 0)

  return (
    <div className="grid-tab tvp-root">
      {breadcrumb}

      <div className="tvp-summary-row" aria-label="Track video summary">
        <span className={`tvp-summary-chip tvp-summary-chip--${placement.kind}`}>
          <span className="tvp-summary-label">Placement</span>
          <span>{placementLabel}</span>
        </span>
        <span className={`tvp-summary-chip${track.videoFlipConfig?.enabled ? ' active' : ''}`}>
          <span className="tvp-summary-label">Flip</span>
          <span>{track.videoFlipConfig?.enabled ? 'On' : 'Off'}</span>
        </span>
        <span className={`tvp-summary-chip${hold ? ' active' : ''}`}>
          <span className="tvp-summary-label">Hold</span>
          <span>{hold ? formatHoldThreshold(thresholdBeats) : 'Off'}</span>
        </span>
        <span className={`tvp-summary-chip${visualFxCount > 0 ? ' active' : ''}`}>
          <span className="tvp-summary-label">FX</span>
          <span>{visualFxCount}</span>
        </span>
      </div>

      {/* ── Flip cycle ──────────────────────────────────────────────────── */}
      <div className="grid-tab-section tvp-section">
        <div className="tvp-section-title">
          <RefreshCw size={13} aria-hidden="true" />
          <span>Video Flip</span>
        </div>
        <TrackFlipSection track={track} onCommit={handleCommitFlip} />
      </div>

      {/* ── Hold Last Frame ─────────────────────────────────────────────── */}
      <div className="grid-tab-section tvp-section">
        <label className="tvp-checkbox-row">
          <input
            className="tvp-checkbox"
            type="checkbox"
            checked={hold}
            onChange={(e) => handleToggleHold(e.target.checked)}
          />
          <span>Hold Last Frame</span>
          <span className="tvp-hint">(freeze the final frame after the clip ends)</span>
        </label>

        {/* Threshold — only meaningful while the hold itself is on. */}
        {hold && (
          <div className="tvp-hold-threshold" role="group" aria-label="Hold Last Frame threshold">
            <label className="tvp-checkbox-row tvp-hold-threshold-unlimited">
              <input
                className="tvp-checkbox"
                type="checkbox"
                checked={thresholdIsUnlimited}
                onChange={(e) => commitThreshold(
                  e.target.checked ? HOLD_THRESHOLD_UNLIMITED : 4)}
              />
              <span>Unlimited</span>
              <span className="tvp-hint">(hold until the next clip)</span>
            </label>

            {!thresholdIsUnlimited && (
              <label className="tvp-hold-threshold-field">
                <span>Hold for</span>
                <input
                  className="tvp-hold-threshold-input"
                  type="number"
                  min="0"
                  step="0.25"
                  value={thresholdDraft}
                  aria-label="Hold Last Frame threshold in beats"
                  onChange={(e) => setThresholdDraft(e.target.value)}
                  onBlur={commitThresholdDraft}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
                <span>beats, then cut</span>
              </label>
            )}
          </div>
        )}
      </div>

      {/* ── Fullscreen opacity — fullscreen-placed tracks only ──────────── */}
      {isFullscreen && (
        <div className="grid-tab-section tvp-section">
          <div className="tvp-section-title">
            <Layers size={13} aria-hidden="true" />
            <span>Fullscreen Layer</span>
          </div>
          <div className="tvp-placement-toggle" role="group" aria-label="Fullscreen placement (hold-through-gap)">
            <button
              type="button"
              className={`tvp-placement-toggle-btn${placement.kind === 'behind' ? ' active' : ''}`}
              onClick={() => handleSetPlacementMode('behind')}
            >
              Behind
            </button>
            <button
              type="button"
              className={`tvp-placement-toggle-btn${placement.kind === 'front' ? ' active' : ''}`}
              onClick={() => handleSetPlacementMode('front')}
            >
              Front
            </button>
          </div>
          <div className="tvp-opacity-row">
            <label className="tvp-opacity-label" htmlFor="tvp-fs-opacity">Opacity</label>
            <input
              id="tvp-fs-opacity"
              type="range" min={0} max={1} step={0.01}
              value={opacityDraft}
              onChange={(e) => setOpacityDraft(Number(e.target.value))}
              onPointerUp={(e) => commitFsOpacity(Number(e.currentTarget.value))}
              onKeyUp={(e) => commitFsOpacity(Number(e.currentTarget.value))}
              aria-label="Fullscreen layer opacity"
            />
            <span className="tvp-opacity-val">{Math.round(opacityDraft * 100)}%</span>
          </div>
        </div>
      )}

      {/* ── Corner Radius + per-track Gap ───────────────────────────────── */}
      <div className="grid-tab-section tvp-section">
        <div className="tvp-section-title"><span>Layout</span></div>
        <div className="grid-tab-track-sliders">
          <CornerRadiusControl
            track={track}
            fetchTracks={fetchTracks}
            applyCornerRadiusToAll={applyCornerRadiusToAll}
          />
          <CustomGapControl
            track={track}
            gapScale={gapScale}
            fetchTracks={fetchTracks}
          />
        </div>
      </div>

      {/* ── Visual FX ───────────────────────────────────────────────────── */}
      <div className="grid-tab-section tvp-section">
        <VisualFXSection track={track} fetchTracks={fetchTracks} />
      </div>

      {/* ── Slide Note FX — Pattern tracks only ─────────────────────────── */}
      {track.type === 'Pattern' && (
        <div className="grid-tab-section tvp-section">
          <SlideNoteEffectSection track={track} fetchTracks={fetchTracks} />
        </div>
      )}
    </div>
  )
}

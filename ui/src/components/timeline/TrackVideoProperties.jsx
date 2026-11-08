import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, NumberBox, SectionHeader, THIN_SPACE, formatValue, parseValue } from '../../ui-kit'
import { timelineEvents } from '../../timelineEvents.js'
import VideoFlipSection from '../inspector/VideoFlipSection.jsx'
import RowToggle from '../inspector/RowToggle.jsx'
import { videoFxCount } from '../devices/video/videoFxCatalog.js'
import { openVideoDevicesFor } from '../devices/video/openVideoDevices.js'
import { getTrackPlacement, placementBadgeLabel, setFullscreenPlacementMode } from './trackPlacement.js'
import { HOLD_THRESHOLD_UNLIMITED } from './holdLastFrame.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import styles from '../inspector/Inspector.module.css'

const snapZero = (v) => (Math.abs(v) < 0.025 ? 0 : v)
// Corner radius is 0..0.5 of the cell, shown as 0..100 % (as the old widget did).
const CORNER_FMT = {
  format: (v) => formatValue(v * 200, '%'),
  parse: (t) => { const n = parseValue(t, '%'); return n === null ? null : n / 200 },
}
// Gap scale is 0..0.5, shown as 0..50 %.
const GAP_FMT = {
  format: (v) => formatValue(v * 100, '%'),
  parse: (t) => { const n = parseValue(t, '%'); return n === null ? null : n / 100 },
}

const notify     = () => timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
const notifyGrid = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

const parseNum = (text) => {
  const n = Number(String(text).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : null
}

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/**
 * A track in the Inspector: identity (name, colour, type), placement, hold
 * last frame, the fullscreen layer (when placed fullscreen), cell shape, video
 * flip, and the "Video effects (N)" button that opens the Devices tab on the
 * track's picture (every visual-effect parameter lives there now). Label /
 * value rows, kit controls only. Same IPC calls as the old Video-tab detail view; this is where
 * that view lives now, so the arrangement and the video settings are visible
 * together.
 *
 * Props:
 *   trackId – id of the track to show
 */
export default function TrackVideoProperties({ trackId }) {
  const [tracks, setTracks]   = useState([])
  const [gapScale, setGapScale] = useState(0)
  const [layout, setLayout]   = useState(null)
  const [loaded, setLoaded]   = useState(false)

  const refresh = useCallback(async () => {
    try {
      const all = await window.xleth?.timeline?.getTracks()
      if (Array.isArray(all)) setTracks(all)
      const gl = await window.xleth?.timeline?.getGridLayout()
      if (gl) { setGapScale(gl.gapScale ?? 0); setLayout(gl) }
    } catch (e) {
      console.error('[Arrange] inspector track refresh failed:', e)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    const onChange = () => refresh()
    timelineEvents.addEventListener('timeline-tracks-changed', onChange)
    timelineEvents.addEventListener('timeline-grid-changed',   onChange)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onChange)
      timelineEvents.removeEventListener('timeline-grid-changed',   onChange)
    }
  }, [trackId, refresh])

  const colors = useTrackIdentityColors(tracks)
  const track = tracks.find((t) => t.id === trackId) ?? null

  // Passed to the hosted sections. They call it after every IPC commit; we
  // re-fetch and broadcast so the arrangement (which mirrors these flags) follows.
  const fetchTracks = useCallback(() => { refresh(); notify() }, [refresh])

  // Cell shape: one write per gesture (the old corner widget wrote on every
  // pointer move). Same setters as before.
  const [cornerDraft, setCornerDraft] = useState(null)
  const [gapDraft, setGapDraft] = useState(null)
  const commitCorner = useCallback(async (v) => {
    try {
      await window.xleth?.timeline?.setTrackCornerRadius(trackId, v)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setTrackCornerRadius failed:', err)
    } finally {
      setCornerDraft(null)
    }
  }, [trackId, fetchTracks])
  const commitGap = useCallback(async (v) => {
    try {
      await window.xleth?.timeline?.setTrackGapScaleOverride(trackId, v)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setTrackGapScaleOverride failed:', err)
    } finally {
      setGapDraft(null)
    }
  }, [trackId, fetchTracks])

  const handleCommitFlip = useCallback(async (config) => {
    try {
      await window.xleth?.timeline?.setVideoFlipConfig(trackId, config)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setVideoFlipConfig failed:', err)
    }
  }, [trackId, fetchTracks])

  const handleToggleHold = useCallback(async (hold) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(trackId, hold)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setVideoHoldLastFrame failed:', err)
    }
  }, [trackId, fetchTracks])

  // Negative engine value = unlimited.
  const thresholdBeats = Number(track?.videoHoldLastFrameThresholdBeats ?? HOLD_THRESHOLD_UNLIMITED)
  const thresholdIsUnlimited = !(thresholdBeats >= 0)

  const commitThreshold = useCallback(async (beats) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrameThreshold(trackId, beats)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setVideoHoldLastFrameThreshold failed:', err)
    }
  }, [trackId, fetchTracks])

  // Fullscreen opacity — only while the track is placed fullscreen. Grid slots
  // carry their own opacity in the grid editor.
  const placement = useMemo(
    () => (layout ? getTrackPlacement(trackId, layout) : { kind: 'unplaced' }),
    [layout, trackId]
  )
  const isFullscreen = placement.kind === 'behind' || placement.kind === 'front'
  const fsLayerOpacity = useMemo(() => {
    const fl = (layout?.fullscreenLayers ?? []).find((l) => l.trackId === trackId)
    return fl ? (fl.opacity ?? 1) : 1
  }, [layout, trackId])

  // 'behind' = hold this layer's last frame across gaps, 'front' = don't. Edits
  // only the placement field, never zOrder (see setFullscreenPlacementMode).
  const handleSetPlacementMode = useCallback(async (mode) => {
    if (!track || !layout) return
    await setFullscreenPlacementMode(track, layout, mode)
  }, [track, layout, trackId])

  const commitFsOpacity = useCallback(async (value) => {
    if (!layout) return
    const next = (layout.fullscreenLayers ?? []).map((l) =>
      l.trackId === trackId ? { ...l, opacity: value } : l)
    try {
      await window.xleth?.timeline?.setFullscreenLayers(next)
      notifyGrid()
      refresh()
    } catch (err) {
      console.error('[Arrange] setFullscreenLayers (opacity) failed:', err)
    }
  }, [layout, trackId, refresh])

  const applyCornerRadiusToAll = useCallback(async (value) => {
    try {
      const all = await window.xleth?.timeline?.getTracks()
      if (!Array.isArray(all)) return
      for (const t of all) await window.xleth?.timeline?.setTrackCornerRadius(t.id, value)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] applyCornerRadiusToAll failed:', err)
    }
  }, [fetchTracks])

  if (!track) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>{loaded ? 'This track no longer exists.' : 'Loading track…'}</p>
      </div>
    )
  }

  const hold = track.videoHoldLastFrame || false
  const isPattern = track.type === 'Pattern'
  const visualFxCount = videoFxCount(track)

  const hasGapOverride = (track.gapScaleOverride ?? -1) >= 0
  const cornerRadius = track.cornerRadius ?? 0

  return (
    <div className={styles.root} data-testid="xleth-inspector-track">
      <header className={styles.head}>
        <span className={styles.swatch} style={{ background: colors[track.id] }} aria-hidden="true" />
        <div className={styles.headText}>
          <h2 className={styles.title} title={track.name}>{track.name}</h2>
          <span className={styles.meta}>{isPattern ? 'Pattern track' : 'Clip track'}</span>
        </div>
      </header>

      <div className={styles.body}>
        <section className={styles.section} aria-label="Placement">
          <SectionHeader>Placement</SectionHeader>
          <Row label="Placed">
            <span className={styles.rowValue}>{placementBadgeLabel(placement)}</span>
          </Row>
          {isFullscreen && (
            <>
              <Row label="Hold gaps">
                <RowToggle
                  label="Hold last frame between notes"
                  on={placement.kind === 'behind'}
                  onChange={(next) => handleSetPlacementMode(next ? 'behind' : 'front')}
                  hint="Freeze this layer's last decoded frame across gaps instead of blinking out"
                />
              </Row>
              <Row label="Opacity">
                <NumberBox
                  label="Fullscreen opacity" hideLabel
                  value={Math.round(fsLayerOpacity * 100)} min={0} max={100} step={1} defaultValue={100} unit="%"
                  onCommit={(x) => commitFsOpacity(Math.round(x) / 100)}
                />
              </Row>
            </>
          )}
        </section>

        <section className={styles.section} aria-label="Hold last frame">
          <SectionHeader>Hold last frame</SectionHeader>
          <Row label="Hold">
            <RowToggle label="Hold last frame" on={hold} onChange={handleToggleHold} hint="Freeze the final frame after the clip ends" />
          </Row>
          {hold && (
            <div className={styles.group}>
              <Row label="Until next">
                <RowToggle
                  label="Hold until the next clip"
                  on={thresholdIsUnlimited}
                  onChange={(next) => commitThreshold(next ? HOLD_THRESHOLD_UNLIMITED : 4)}
                  hint="Hold until the next clip, however long the gap"
                />
              </Row>
              {!thresholdIsUnlimited && (
                <Row label="Hold for">
                  <NumberBox
                    label="Hold last frame threshold" hideLabel
                    value={thresholdBeats} min={0} max={64} step={0.25} defaultValue={4}
                    format={(x) => `${Number(x.toFixed(2))}${THIN_SPACE}beats`} parse={parseNum}
                    onCommit={(x) => { const beats = Math.round(x * 4) / 4; if (beats !== thresholdBeats) commitThreshold(beats) }}
                    hint="Beats to hold before cutting"
                  />
                </Row>
              )}
            </div>
          )}
        </section>

        <section className={styles.section} aria-label="Cell shape">
          <SectionHeader>Cell shape</SectionHeader>
          <Row label="Corners">
            <NumberBox
              label="Corner radius" hideLabel width={72}
              value={cornerDraft ?? cornerRadius} min={0} max={0.5} step={0.005} defaultValue={0}
              quantize={(v) => Math.round(v * 200) / 200}
              format={CORNER_FMT.format} parse={CORNER_FMT.parse}
              onChange={setCornerDraft}
              onCancel={() => setCornerDraft(null)}
              onCommit={commitCorner}
              hint="Rounding of this track's cells: 100 % is a full circle on a square cell"
            />
            <Button size="sm" onClick={() => applyCornerRadiusToAll(cornerRadius)} hint="Copy this corner radius to every track">
              Apply to all
            </Button>
          </Row>
          <Row label="Own gap">
            <RowToggle
              label="Use this track's own gap"
              on={hasGapOverride}
              onChange={(next) => commitGap(next ? (gapScale ?? 0) : -1)}
              hint="Give this track its own gap between cells instead of the grid's"
            />
            {hasGapOverride ? (
              <NumberBox
                label="Track gap" hideLabel width={72}
                value={gapDraft ?? (track.gapScaleOverride ?? 0)} min={0} max={0.5} step={0.01} defaultValue={0}
                quantize={(v) => Math.round(v * 100) / 100}
                format={GAP_FMT.format} parse={GAP_FMT.parse}
                onChange={setGapDraft}
                onCancel={() => setGapDraft(null)}
                onCommit={(v) => commitGap(snapZero(v))}
              />
            ) : (
              <span className={styles.rowValue}>{`Grid gap ${formatValue((gapScale ?? 0) * 100, '%')}`}</span>
            )}
          </Row>
        </section>

        <VideoFlipSection track={track} onCommit={handleCommitFlip} />

        <section className={styles.section} aria-label="Video effects">
          <SectionHeader>Video effects</SectionHeader>
          <Row label="Effects">
            <Button
              size="sm"
              onClick={() => openVideoDevicesFor(track.id)}
              hint="Open this track's video effects in the Devices tab"
              data-testid="xleth-inspector-video-fx"
            >
              {`Video effects (${visualFxCount})`}
            </Button>
          </Row>
        </section>
      </div>
    </div>
  )
}

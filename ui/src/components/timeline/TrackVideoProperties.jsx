import { useCallback, useEffect, useMemo, useState } from 'react'
import { NumberBox, SectionHeader, Toggle, THIN_SPACE } from '../../ui-kit'
import { timelineEvents } from '../../timelineEvents.js'
import TrackFlipSection from './TrackFlipSection.jsx'
import CornerRadiusControl from '../grid/CornerRadiusControl.jsx'
import CustomGapControl from '../grid/CustomGapControl.jsx'
import VisualFXSection from '../grid/VisualFXSection.jsx'
import SlideNoteEffectSection from '../grid/SlideNoteEffectSection.jsx'
import NoteFadeSection from '../grid/NoteFadeSection.jsx'
import { getTrackPlacement, placementBadgeLabel, setFullscreenPlacementMode } from './trackPlacement.js'
import { HOLD_THRESHOLD_UNLIMITED, formatHoldThreshold } from './holdLastFrame.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import styles from '../inspector/Inspector.module.css'

// Hosted legacy sections (flip, corner radius, gap, visual FX, slide note, note
// fade) keep their app.css overrides, which are scoped under .tvp-root, until
// their own rebuild.
const HOSTED = `${styles.hosted} tvp-root`

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
 * A track in the Inspector: identity (name, colour, type) and every per-track
 * video property: flip cycle, hold last frame, fullscreen layer, corner
 * radius, per-track gap, visual FX, and for pattern tracks slide-note FX and
 * note fade. Same IPC calls as the old Video-tab detail view; this is where
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
    console.log(`[Arrange] inspector shows track ${trackId}`)
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

  const handleCommitFlip = useCallback(async (config) => {
    try {
      await window.xleth?.timeline?.setVideoFlipConfig(trackId, config)
      console.log(`[Arrange] flip config committed for track ${trackId}`)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setVideoFlipConfig failed:', err)
    }
  }, [trackId, fetchTracks])

  const handleToggleHold = useCallback(async (hold) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(trackId, hold)
      console.log(`[Arrange] track ${trackId} videoHoldLastFrame → ${hold}`)
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
      console.log(`[Arrange] track ${trackId} videoHoldLastFrameThresholdBeats → ${beats < 0 ? 'unlimited' : beats}`)
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
    console.log(`[Arrange] track ${trackId} fullscreen hold-between-notes → ${mode}`)
    await setFullscreenPlacementMode(track, layout, mode)
  }, [track, layout, trackId])

  const commitFsOpacity = useCallback(async (value) => {
    if (!layout) return
    const next = (layout.fullscreenLayers ?? []).map((l) =>
      l.trackId === trackId ? { ...l, opacity: value } : l)
    try {
      await window.xleth?.timeline?.setFullscreenLayers(next)
      console.log(`[Arrange] fullscreen opacity for track ${trackId} → ${value}`)
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
      console.log(`[Arrange] corner radius ${value} applied to all tracks`)
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
  const visualFxCount =
    (track.bounce?.enabled ? 1 : 0) +
    (track.zoomPanRot?.enabled ? 1 : 0) +
    (track.pingPong?.enabled ? 1 : 0) +
    (track.visualEffectChain?.length ?? 0)

  return (
    <div className={styles.root} data-testid="xleth-inspector-track">
      <header className={styles.head}>
        <span className={styles.swatch} style={{ background: colors[track.id] }} aria-hidden="true" />
        <div className={styles.headText}>
          <h2 className={styles.title} title={track.name}>{track.name}</h2>
          <span className={styles.meta}>{isPattern ? 'Pattern track' : 'Clip track'}</span>
        </div>
      </header>

      <dl className={styles.summary} aria-label="Track video summary">
        <div><dt>Placement</dt><dd>{placementBadgeLabel(placement)}</dd></div>
        <div><dt>Flip</dt><dd>{track.videoFlipConfig?.enabled ? 'On' : 'Off'}</dd></div>
        <div><dt>Hold</dt><dd>{hold ? formatHoldThreshold(thresholdBeats) : 'Off'}</dd></div>
        <div><dt>FX</dt><dd>{visualFxCount}</dd></div>
      </dl>

      <section className={styles.section} aria-label="Hold last frame">
        <SectionHeader>Hold last frame</SectionHeader>
        <Row label="Hold">
          <Toggle size="sm" on={hold} onChange={handleToggleHold} hint="Freeze the final frame after the clip ends">
            {hold ? 'On' : 'Off'}
          </Toggle>
        </Row>
        {hold && (
          <div className={styles.group}>
            <Row label="Duration">
              <Toggle
                size="sm"
                on={thresholdIsUnlimited}
                onChange={(next) => commitThreshold(next ? HOLD_THRESHOLD_UNLIMITED : 4)}
                hint="Hold until the next clip"
              >
                Until next clip
              </Toggle>
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

      {isFullscreen && (
        <section className={styles.section} aria-label="Fullscreen layer">
          <SectionHeader>Fullscreen layer</SectionHeader>
          <Row label="Gaps">
            <Toggle
              size="sm"
              on={placement.kind === 'behind'}
              onChange={(next) => handleSetPlacementMode(next ? 'behind' : 'front')}
              hint="Freeze this layer's last decoded frame across gaps instead of blinking out"
            >
              Hold last frame between notes
            </Toggle>
          </Row>
          <Row label="Opacity">
            <NumberBox
              label="Fullscreen opacity" hideLabel
              value={Math.round(fsLayerOpacity * 100)} min={0} max={100} step={1} defaultValue={100} unit="%"
              onCommit={(x) => commitFsOpacity(Math.round(x) / 100)}
            />
          </Row>
        </section>
      )}

      <section className={styles.section} aria-label="Video flip">
        <SectionHeader>Video flip</SectionHeader>
        <div className={HOSTED}>
          <TrackFlipSection track={track} onCommit={handleCommitFlip} />
        </div>
      </section>

      <section className={styles.section} aria-label="Cell shape">
        <SectionHeader>Cell shape</SectionHeader>
        <div className={HOSTED}>
          <div className="grid-tab-track-sliders">
            <CornerRadiusControl track={track} fetchTracks={fetchTracks} applyCornerRadiusToAll={applyCornerRadiusToAll} />
            <CustomGapControl track={track} gapScale={gapScale} fetchTracks={fetchTracks} />
          </div>
        </div>
      </section>

      <section className={styles.section} aria-label="Visual FX">
        <div className={HOSTED}>
          <VisualFXSection track={track} fetchTracks={fetchTracks} />
        </div>
      </section>

      {isPattern && (
        <section className={styles.section} aria-label="Slide note FX">
          <div className={HOSTED}>
            <SlideNoteEffectSection track={track} fetchTracks={fetchTracks} />
          </div>
        </section>
      )}

      {isPattern && (
        <section className={styles.section} aria-label="Note fade">
          <div className={HOSTED}>
            <NoteFadeSection track={track} fetchTracks={fetchTracks} />
          </div>
        </section>
      )}
    </div>
  )
}

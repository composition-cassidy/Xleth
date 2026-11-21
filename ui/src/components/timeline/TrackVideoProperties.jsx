import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, NumberBox, SegmentedControl, THIN_SPACE, formatValue, parseValue } from '../../ui-kit'
import { timelineEvents } from '../../timelineEvents.js'
import VideoFlipSection from '../inspector/VideoFlipSection.jsx'
import RowToggle from '../inspector/RowToggle.jsx'
import { videoFxCount } from '../devices/video/videoFxCatalog.js'
import { openVideoDevicesFor } from '../devices/video/openVideoDevices.js'
import { getTrackPlacement, placementBadgeLabel, setFullscreenPlacementMode } from './trackPlacement.js'
import { HOLD_THRESHOLD_UNLIMITED } from './holdLastFrame.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import RoamPanel from '../lensRoam/RoamPanel.jsx'
import GradeStack from '../colorGrade/GradeStack.jsx'
import { TrackSection, TRow, trackStyles as t } from '../inspector/TrackSection.jsx'
import CloneSection, { ClonesListSection } from '../inspector/CloneSection.jsx'
import { cloneKindLabel, isClone, isTrailClone, sourceOf } from '../../clones/cloneModel.js'

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

// Which gaps the hold fills. Smart and All/Timed are separate engine fields
// (videoHoldSmart, videoHoldLastFrameThresholdBeats); this is one choice.
const GAP_OPTIONS = [
  { value: 'smart', label: 'Smart', hint: 'Hold the short rests inside a phrase; leave the long rests between phrases, and the end, blank' },
  { value: 'all',   label: 'All',   hint: 'Hold until the next clip, however long the gap' },
  { value: 'timed', label: 'Timed', hint: 'Hold for a set number of beats, then cut' },
]
const FILL_OPTIONS = [
  { value: 'freeze', label: 'Freeze',       hint: "Show the clip's last frame, still" },
  { value: 'play',   label: 'Keep playing', hint: 'Let the video run on past the clip until the next clip or note takes over' },
]

const notify     = () => timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
const notifyGrid = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))

const parseNum = (text) => {
  const n = Number(String(text).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * A track in the Inspector. The header is identity (colour edge, name, type,
 * where it is placed) plus "Video effects (N)", which opens the Devices tab on
 * the track's picture. Then foldable sections in the order the picture is built:
 * Cell (fullscreen hold and opacity when fullscreen, corners, gap), Roam and
 * Roam keys, Hold last frame and Video flip (each switched on from its header;
 * the body only exists while on). Same IPC calls as the old Video-tab detail
 * view; UI only.
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

  const setHoldBehavior = useCallback(async (patch) => {
    try {
      await window.xleth?.timeline?.setVideoHoldBehavior(trackId, patch)
      fetchTracks()
    } catch (err) {
      console.error('[Arrange] setVideoHoldBehavior failed:', err)
    }
  }, [trackId, fetchTracks])

  const holdSmart = !!track?.videoHoldSmart
  const holdKeepPlaying = !!track?.videoHoldKeepPlaying
  const gapMode = holdSmart ? 'smart' : (thresholdIsUnlimited ? 'all' : 'timed')

  const setGapMode = useCallback(async (mode) => {
    if (mode === 'smart') { await setHoldBehavior({ smart: true }); return }
    if (holdSmart) await setHoldBehavior({ smart: false })
    if (mode === 'all' && !thresholdIsUnlimited) await commitThreshold(HOLD_THRESHOLD_UNLIMITED)
    else if (mode === 'timed' && thresholdIsUnlimited) await commitThreshold(4)
  }, [holdSmart, thresholdIsUnlimited, setHoldBehavior, commitThreshold])

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
      <div className={t.empty}>
        <p className={t.emptyText}>{loaded ? 'This track no longer exists.' : 'Loading track…'}</p>
      </div>
    )
  }

  const hold = track.videoHoldLastFrame || false
  const isPattern = track.type === 'Pattern'
  const visualFxCount = videoFxCount(track)
  // Clones (docs/XLETH_CLONE_SPEC.md): a Voice clone owns a full cell (every section
  // applies, plus its Clone section). A Trail clone has no cell of its own: it
  // replays its source's picture, so only its Clone settings and its added Roam
  // (Offset X / Y) apply; the cell, grade, hold, flip and effects sections are the
  // source's and are not shown here.
  const clone = isClone(track)
  const trail = isTrailClone(track)
  const sourceName = clone ? (sourceOf(tracks, track)?.name ?? 'its source') : null
  const kindText = clone ? `${cloneKindLabel(track)} of ${sourceName}` : (isPattern ? 'Pattern track' : 'Clip track')
  const swatch = trail ? (track.clone?.tint ?? colors[track.id]) : colors[track.id]

  const hasGapOverride = (track.gapScaleOverride ?? -1) >= 0
  const cornerRadius = track.cornerRadius ?? 0
  const gapText = hasGapOverride
    ? `Own gap ${formatValue((track.gapScaleOverride ?? 0) * 100, '%')}`
    : `Grid gap ${formatValue((gapScale ?? 0) * 100, '%')}`
  const holdSummary = [
    GAP_OPTIONS.find((o) => o.value === gapMode)?.label,
    gapMode === 'timed' ? `${Number(thresholdBeats.toFixed(2))}${THIN_SPACE}beats` : null,
    holdKeepPlaying ? 'Keep playing' : 'Freeze',
  ].filter(Boolean).join(' · ')

  if (trail) {
    return (
      <div className={t.root} data-testid="xleth-inspector-track">
        <header className={t.head}>
          <span className={t.swatch} style={{ background: swatch }} aria-hidden="true" />
          <div className={t.headText}>
            <h2 className={t.title} title={track.name}>{track.name}</h2>
            <span className={t.meta}>{`${kindText} · no cell of its own`}</span>
          </div>
        </header>
        <div className={t.body}>
          <CloneSection track={track} tracks={tracks} />
          <RoamPanel
            trackId={track.id} variant="trail" sourceName={sourceName}
            context={`${track.name} · an offset added on top of where ${sourceName} was`}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={t.root} data-testid="xleth-inspector-track">
      <header className={t.head}>
        <span className={t.swatch} style={{ background: swatch }} aria-hidden="true" />
        <div className={t.headText}>
          <h2 className={t.title} title={track.name}>{track.name}</h2>
          <span className={t.meta}>{`${kindText} · ${placementBadgeLabel(placement)}`}</span>
        </div>
        <div className={t.headActions}>
          <Button
            size="sm"
            onClick={() => openVideoDevicesFor(track.id)}
            hint="Open this track's video effects in the Devices tab"
            data-testid="xleth-inspector-video-fx"
          >
            {`Video effects (${visualFxCount})`}
          </Button>
        </div>
      </header>

      <div className={t.body}>
        {clone ? <CloneSection track={track} tracks={tracks} /> : <ClonesListSection track={track} tracks={tracks} />}
        <TrackSection
          id="cell" title="Cell"
          summary={`Corners ${CORNER_FMT.format(cornerRadius)} · ${gapText}`}
          hint="This track's cell on the picture: its corners and the gap around it"
        >
          {isFullscreen && (
            <>
              <TRow label="Hold gaps">
                <RowToggle
                  label="Hold last frame between notes"
                  on={placement.kind === 'behind'}
                  onChange={(next) => handleSetPlacementMode(next ? 'behind' : 'front')}
                  hint="Freeze this layer's last decoded frame across gaps instead of blinking out"
                />
              </TRow>
              <TRow label="Opacity">
                <NumberBox
                  label="Fullscreen opacity" hideLabel width={72}
                  value={Math.round(fsLayerOpacity * 100)} min={0} max={100} step={1} defaultValue={100} unit="%"
                  onCommit={(x) => commitFsOpacity(Math.round(x) / 100)}
                />
              </TRow>
            </>
          )}
          <TRow label="Corners">
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
          </TRow>
          <TRow label="Own gap">
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
              <span className={t.value}>{gapText}</span>
            )}
          </TRow>
        </TrackSection>

        <RoamPanel trackId={track.id} context={`${track.name} · moves this cell on the picture`} />

        <TrackSection
          id="color" title="Color"
          hint="The color grade of this track's cell, and the Master grade over the whole picture"
          testId="xleth-inspector-track-color"
        >
          <GradeStack stack={{ layer: { id: track.id, name: track.name } }} openLabel="Open" />
        </TrackSection>

        {/* A Voice clone never holds: with no note to play it draws nothing (spec "Idle"). */}
        {!clone && (
        <TrackSection
          id="hold" title="Hold last frame"
          summary={hold ? holdSummary : null}
          hint="Freeze the final frame after the clip ends"
          actions={<RowToggle label="Hold last frame" on={hold} onChange={handleToggleHold} hint="Freeze the final frame after the clip ends" />}
        >
          {hold ? (
            <>
              <TRow label="Gaps">
                <SegmentedControl
                  size="sm" label="Which gaps to hold" value={gapMode}
                  options={GAP_OPTIONS} onChange={setGapMode}
                  hint="Which gaps between clips get held"
                />
              </TRow>
              <TRow label="Fill">
                <SegmentedControl
                  size="sm" label="What fills a held gap" value={holdKeepPlaying ? 'play' : 'freeze'}
                  options={FILL_OPTIONS} onChange={(v) => setHoldBehavior({ keepPlaying: v === 'play' })}
                  hint="What a held gap shows"
                />
              </TRow>
              {gapMode === 'timed' && (
                <TRow label="Hold for">
                  <NumberBox
                    label="Hold last frame threshold" hideLabel width={88}
                    value={thresholdBeats} min={0} max={64} step={0.25} defaultValue={4}
                    format={(x) => `${Number(x.toFixed(2))}${THIN_SPACE}beats`} parse={parseNum}
                    onCommit={(x) => { const beats = Math.round(x * 4) / 4; if (beats !== thresholdBeats) commitThreshold(beats) }}
                    hint="Beats to hold before cutting"
                  />
                </TRow>
              )}
            </>
          ) : null}
        </TrackSection>
        )}

        <VideoFlipSection track={track} onCommit={handleCommitFlip} />
      </div>
    </div>
  )
}

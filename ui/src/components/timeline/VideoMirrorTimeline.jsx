import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { ChevronDown, ChevronRight, Folder, Lock, Plus } from 'lucide-react'
import XlethPanelHeader from '../common/XlethPanelHeader.jsx'
import TimelineRuler from './TimelineRuler.jsx'
import TimelineScrollbar from './TimelineScrollbar.jsx'
import VideoMirrorCanvas, { CUE_LANE_HEIGHT } from './VideoMirrorCanvas.jsx'
import { resolveTimelinePalette } from './timelineDrawing.js'
import { buildResolvedTrackColorMap } from './trackColorResolver.js'
import { buildTrackLayout } from './timelineRowLayout.js'
import { normalizeTrackLayout, visibleTracksForLayout } from './trackFolderLayout.js'
import useTimelineZoom from '../../hooks/useTimelineZoom.js'
import useTimelineScroll from '../../hooks/useTimelineScroll.js'
import useSnapStore from '../../stores/snapStore.js'
import { subscribe } from '../../transportStore.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { editCursor } from '../../services/EditCursor.js'
import { timelineEvents } from '../../timelineEvents.js'
import {
  BEATS_PER_BAR, PPQ, TRACK_HEIGHT, HEADER_WIDTH, pixelToBeat,
} from '../../constants/timeline.js'

// Height of the ruler row — matches .timeline-ruler-container in app.css so the
// left header column's top spacer keeps the track rows vertically aligned with
// the canvas rows drawn beside it.
const RULER_ROW_H = 24

/**
 * Audio-timeline mirror mounted in the Video tab. Track content is read-only;
 * the dedicated snapshot cue lane is editable.
 *
 * Shows the same tracks / clips / pattern-blocks as the Audio timeline, drawn
 * as simplified locked blocks. It shares ONE playhead and ONE tick scale with
 * the transport: the playhead comes from the shared `playheadClock`, and
 * seek/scrub drives the shared transport exactly like the audio ruler does.
 * Only cue IPC mutations are exposed; tracks, clips and patterns stay locked.
 *
 * The tick→pixel scale uses the shared `useTimelineZoom` hook (same clamps +
 * defaults as the editor). No engine/bridge/IPC changes — data is read through
 * the same `window.xleth.timeline.*` reads TimelineView uses and refetched on
 * the shared `timelineEvents` bus.
 */
export default function VideoMirrorTimeline() {
  const snapGranularity = useSnapStore((s) => s.snapGranularity)

  // ── Shared tick↔px scale + horizontal pan (own instance; same hook/clamps) ─
  const { pixelsPerBeat, pixelsPerBeatRef, zoomAtCursor } = useTimelineZoom()
  const {
    scrollOffset, scrollOffsetRef, applyScroll, scrollBy, scrollTo, setMaxScroll,
  } = useTimelineScroll()

  // ── Timeline data (read-only) ──────────────────────────────────────────────
  const [tracks, setTracks] = useState([])
  const [folderLayout, setFolderLayout] = useState(null)
  const [clips, setClips] = useState([])
  const [regions, setRegions] = useState({})
  const [patternBlocks, setPatternBlocks] = useState([])
  const [patterns, setPatterns] = useState({})
  const [cues, setCues] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [defaultSnapshotId, setDefaultSnapshotId] = useState('')
  const [canvasWidth, setCanvasWidth] = useState(800)
  const [themeRev, setThemeRev] = useState(0)

  // ── Transport mirror (never a second playhead — reads shared state) ────────
  const bpmRef = useRef(140)
  const isPlayingRef = useRef(false)
  const playheadBeatRef = useRef(0)

  const canvasRef = useRef(null)
  const rulerRef = useRef(null)
  const canvasAreaRef = useRef(null)
  const cueMutationQueueRef = useRef(Promise.resolve())

  // ── Fetchers (same IPC reads TimelineView uses) ────────────────────────────
  const fetchTracks = useCallback(async () => {
    try {
      const [t, layout] = await Promise.all([
        window.xleth?.timeline?.getTracks(),
        window.xleth?.timeline?.getTrackLayout?.(),
      ])
      if (Array.isArray(t)) setTracks(t)
      if (layout) setFolderLayout(layout)
    } catch { /* engine not ready */ }
  }, [])

  const fetchClips = useCallback(async () => {
    try {
      const c = await window.xleth?.timeline?.getClips()
      if (Array.isArray(c)) setClips(c)
    } catch { /* engine not ready */ }
  }, [])

  const fetchRegions = useCallback(async () => {
    try {
      const r = await window.xleth?.timeline?.getRegions()
      if (Array.isArray(r)) {
        const map = {}
        r.forEach((reg) => { map[reg.id] = reg })
        setRegions(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatternBlocks = useCallback(async () => {
    try {
      const b = await window.xleth?.timeline?.getPatternBlocks()
      if (Array.isArray(b)) setPatternBlocks(b)
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatterns = useCallback(async () => {
    try {
      const list = await window.xleth?.timeline?.getAllPatterns()
      if (Array.isArray(list)) {
        const map = {}
        list.forEach((p) => { map[p.id] = p })
        setPatterns(map)
      }
    } catch { /* engine not ready */ }
  }, [])
  const fetchCues = useCallback(async () => {
    try {
      const next = await window.xleth?.timeline?.listCues?.()
      if (Array.isArray(next)) setCues(next)
    } catch (e) {
      console.error('[VideoMirrorTimeline] listCues failed:', e)
    }
  }, [])

  const fetchSnapshots = useCallback(async () => {
    try {
      const timeline = window.xleth?.timeline
      const [next, defaultId] = await Promise.all([
        timeline?.listSnapshots?.(),
        timeline?.getDefaultSnapshot?.(),
      ])
      if (Array.isArray(next)) setSnapshots(next)
      if (typeof defaultId === 'string') setDefaultSnapshotId(defaultId)
    } catch (e) {
      console.error('[VideoMirrorTimeline] snapshot lookup failed:', e)
    }
  }, [])

  // ── Initial load + keep in sync with edits made on the Audio tab ───────────
  useEffect(() => {
    fetchTracks(); fetchClips(); fetchRegions(); fetchPatternBlocks(); fetchPatterns()
    fetchCues(); fetchSnapshots()

    const onTracks = () => fetchTracks()
    const onClips = () => { fetchTracks(); fetchClips() }
    const onRegions = () => { fetchRegions(); fetchClips() }
    const onPatternBlocks = () => fetchPatternBlocks()
    const onPatterns = () => fetchPatterns()
    // Safety audit: snapshot deletion broadcasts this event after the engine
    // prunes its cues, so both lists are re-read and dangling markers disappear.
    const onGrid = () => { fetchCues(); fetchSnapshots() }

    timelineEvents.addEventListener('timeline-tracks-changed', onTracks)
    timelineEvents.addEventListener('timeline-track-layout-changed', onTracks)
    timelineEvents.addEventListener('timeline-clips-changed', onClips)
    timelineEvents.addEventListener('timeline-regions-changed', onRegions)
    timelineEvents.addEventListener('timeline-pattern-blocks-changed', onPatternBlocks)
    timelineEvents.addEventListener('timeline-patterns-changed', onPatterns)
    timelineEvents.addEventListener('timeline-pattern-changed', onPatterns)
    timelineEvents.addEventListener('timeline-grid-changed', onGrid)
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(() => {
      fetchTracks(); fetchClips(); fetchRegions(); fetchPatternBlocks(); fetchPatterns()
      fetchCues(); fetchSnapshots()
    })
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracks)
      timelineEvents.removeEventListener('timeline-track-layout-changed', onTracks)
      timelineEvents.removeEventListener('timeline-clips-changed', onClips)
      timelineEvents.removeEventListener('timeline-regions-changed', onRegions)
      timelineEvents.removeEventListener('timeline-pattern-blocks-changed', onPatternBlocks)
      timelineEvents.removeEventListener('timeline-patterns-changed', onPatterns)
      timelineEvents.removeEventListener('timeline-pattern-changed', onPatterns)
      timelineEvents.removeEventListener('timeline-grid-changed', onGrid)
      offProjectLoaded?.()
    }
  }, [fetchTracks, fetchClips, fetchRegions, fetchPatternBlocks, fetchPatterns, fetchCues, fetchSnapshots])

  // Safety audit: cue writes are serialized, and every attempt finishes by
  // re-reading listCues. React state is therefore only a view of IPC truth,
  // including under rapid add/move/delete input.
  const mutateCue = useCallback((label, mutation) => {
    const run = cueMutationQueueRef.current
      .catch(() => {})
      .then(async () => {
        try {
          const timeline = window.xleth?.timeline
          if (!timeline) return false
          return await mutation(timeline)
        } catch (e) {
          console.error('[VideoMirrorTimeline] ' + label + ' failed:', e)
          return false
        } finally {
          await fetchCues()
          timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))
        }
      })
    cueMutationQueueRef.current = run.catch(() => {})
    return run
  }, [fetchCues])

  const activeSnapshotId = snapshots.find((snapshot) => snapshot.active)?.id || ''

  const handleAddCueAtPlayhead = useCallback(() => {
    if (!activeSnapshotId) return Promise.resolve(false)
    const playheadTick = Math.max(0, Math.round(playheadBeatRef.current * PPQ))
    // Safety audit: addCue deliberately handles an occupied tick; the engine
    // replaces that cue's snapshot and the subsequent listCues read shows one marker.
    return mutateCue('addCue', (timeline) => timeline.addCue(playheadTick, activeSnapshotId))
  }, [activeSnapshotId, mutateCue])

  const handleRepointCue = useCallback((tick, snapshotId) => {
    if (!snapshots.some((snapshot) => snapshot.id === snapshotId)) return Promise.resolve(false)
    // Safety audit: picker values are built only from the current listSnapshots
    // response, and this guard also rejects any stale/dangling selection.
    return mutateCue('addCue', (timeline) => timeline.addCue(tick, snapshotId))
  }, [mutateCue, snapshots])

  const handleMoveCue = useCallback((oldTick, newTick) => mutateCue('moveCue', async (timeline) => {
    if (oldTick === newTick) return true
    // Safety audit: never ask the engine to move onto an occupied tick. A failed
    // preflight or moveCue(false) leaves the colliding cue intact and tells the marker to revert.
    const latest = await timeline.listCues()
    if (!Array.isArray(latest)) return false
    if (latest.some((cue) => cue.tick === newTick && cue.tick !== oldTick)) return false
    return await timeline.moveCue(oldTick, newTick) === true
  }), [mutateCue])

  const handleRemoveCue = useCallback((tick) => (
    mutateCue('removeCue', (timeline) => timeline.removeCue(tick))
  ), [mutateCue])

  // Replace the boundary animation on the cue at `tick`. The caller (the
  // Start/End handles + popover in VideoMirrorCanvas) always passes the full
  // complete transition object because setCueTransition replaces the whole
  // transition; missing fields would revert to engine defaults. The engine
  // renders the result through the shm preview seam — the UI never animates it.
  const handleSetCueTransition = useCallback((tick, transition) => (
    mutateCue('setCueTransition', (timeline) => {
      if (typeof timeline.setCueTransition !== 'function') return false
      return timeline.setCueTransition(tick, transition)
    })
  ), [mutateCue])

  // ── Track transport bpm / play state (shared poller) ───────────────────────
  useEffect(() => subscribe((s) => {
    bpmRef.current = s.bpm
    isPlayingRef.current = s.isPlaying
    if (!s.isPlaying) {
      const stopBeat = Number.isFinite(s.rawPositionBeats)
        ? s.rawPositionBeats
        : s.positionMs * s.bpm / 60000
      playheadBeatRef.current = stopBeat
      canvasRef.current?.positionPlayhead(stopBeat)
      rulerRef.current?.redrawOverlay()
    }
  }), [])

  // ── Theme repaint for header swatches (canvas repaints itself) ─────────────
  useEffect(() => {
    const onTheme = () => setThemeRev((n) => n + 1)
    window.addEventListener('xleth-theme-changed', onTheme)
    return () => window.removeEventListener('xleth-theme-changed', onTheme)
  }, [])

  // ── Seek / scrub — the SAME action the audio ruler performs ────────────────
  // One playhead: drives the shared playheadClock + real transport. No local
  // position state that could diverge from transportStore/playheadClock.
  const handleScrub = useCallback((beat, options = {}) => {
    const phase = options.phase || 'commit'
    const clampedBeat = Math.max(0, beat)
    editCursor.setPosition(clampedBeat)
    const posMs = clampedBeat * 60000 / bpmRef.current
    playheadClock.seekLocally(posMs, bpmRef.current, isPlayingRef.current, clampedBeat)
    playheadBeatRef.current = clampedBeat
    canvasRef.current?.positionPlayhead(clampedBeat)
    rulerRef.current?.redrawOverlay()
    if (phase === 'commit') {
      window.xleth?.transport?.seek(clampedBeat)
    }
  }, [])

  // ── Wheel: Ctrl/Meta = cursor-centred zoom; Shift/horizontal = timeline pan. ──
  // Plain wheel input intentionally bubbles to the Video overview's vertical scroller.
  const handleWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const cursorBeat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      zoomAtCursor(e.deltaY, cursorBeat, scrollOffsetRef, applyScroll)
    } else if (e.shiftKey || e.deltaX !== 0) {
      e.preventDefault()
      const delta = (e.shiftKey ? e.deltaY : e.deltaX) / (pixelsPerBeatRef.current || 40) * 0.8
      scrollBy(delta)
    }
  }, [zoomAtCursor, applyScroll, scrollBy, pixelsPerBeatRef, scrollOffsetRef])

  const normalizedFolderLayout = useMemo(
    () => normalizeTrackLayout(folderLayout, tracks),
    [folderLayout, tracks],
  )
  const visibleTracks = useMemo(
    () => visibleTracksForLayout(normalizedFolderLayout, tracks),
    [normalizedFolderLayout, tracks],
  )
  const mirrorTrackLayout = useMemo(
    () => buildTrackLayout({ tracks: visibleTracks, folderLayout: normalizedFolderLayout }),
    [visibleTracks, normalizedFolderLayout],
  )

  // ── Redraw on zoom / scroll / data changes ─────────────────────────────────
  useEffect(() => {
    canvasRef.current?.redraw()
    rulerRef.current?.redraw()
    rulerRef.current?.redrawOverlay()
  }, [pixelsPerBeat, scrollOffset])

  useEffect(() => {
    canvasRef.current?.redraw()
  }, [visibleTracks, mirrorTrackLayout, clips, regions, patternBlocks, patterns, themeRev])

  // ── Song length + max horizontal scroll ────────────────────────────────────
  const totalBeats = useMemo(() => {
    const minBeats = 64 * BEATS_PER_BAR
    const padBeats = 16 * BEATS_PER_BAR
    let maxEnd = 0
    for (const c of clips) {
      const end = (c.positionTicks + c.durationTicks) / PPQ
      if (end > maxEnd) maxEnd = end
    }
    for (const b of patternBlocks) {
      const end = (b.positionTicks + b.durationTicks) / PPQ
      if (end > maxEnd) maxEnd = end
    }
    for (const cue of cues) {
      const end = cue.tick / PPQ
      if (end > maxEnd) maxEnd = end
    }
    return Math.max(minBeats, maxEnd + padBeats)
  }, [clips, patternBlocks, cues])

  useEffect(() => {
    const visibleBeats = canvasWidth / (pixelsPerBeat || 40)
    setMaxScroll(Math.max(0, totalBeats - visibleBeats))
  }, [totalBeats, canvasWidth, pixelsPerBeat, setMaxScroll])

  // ── Measure canvas area width (scrollbar sizing + max scroll) ──────────────
  useEffect(() => {
    const el = canvasAreaRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0) setCanvasWidth(w)
    })
    setCanvasWidth(el.clientWidth || 800)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ── Header swatch colours (match the canvas' resolved track colours) ───────
  const trackColorById = useMemo(() => {
    const palette = resolveTimelinePalette()
    return buildResolvedTrackColorMap(tracks, palette.trackPalette)
    // themeRev forces recompute after a theme switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, themeRev])

  return (
    <div className="grid-tab-section vmt-root">
      <XlethPanelHeader title="Timeline (Mirror)">
        <span className="vmt-readonly-badge" title="Read-only mirror of the Audio timeline">
          <Lock size={11} aria-hidden="true" />
          <span>Tracks locked</span>
        </span>
      </XlethPanelHeader>

      <div className="vmt-body">
        {/* Left: read-only track-name column, aligned with the canvas rows */}
        <div className="vmt-header-col" style={{ width: HEADER_WIDTH }}>
          <div className="vmt-ruler-spacer" style={{ height: RULER_ROW_H }} />
          <div className="vmt-cue-header" style={{ height: CUE_LANE_HEIGHT }}>
            <span>Snapshots</span>
            <button
              type="button"
              className="vmt-add-cue"
              onClick={handleAddCueAtPlayhead}
              disabled={!activeSnapshotId}
              title="Add cue at playhead"
              aria-label="Add snapshot cue at playhead"
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          </div>
          {mirrorTrackLayout.rows.length === 0 ? (
            <div className="vmt-empty-headers" style={{ height: TRACK_HEIGHT }}>
              No tracks
            </div>
          ) : (
            mirrorTrackLayout.rows.map((row) => {
              if (row.rowType === 'folder') {
                return (
                  <div key={row.id} className="vmt-folder-header" style={{ height: row.height }}>
                    {row.collapsed
                      ? <ChevronRight size={12} aria-hidden="true" />
                      : <ChevronDown size={12} aria-hidden="true" />}
                    <Folder size={13} aria-hidden="true" />
                    <span className="vmt-track-name" title={row.label}>{row.label}</span>
                    <span className="vmt-folder-count">{row.memberCount}</span>
                  </div>
                )
              }
              const track = visibleTracks[row.trackIndex]
              if (!track) return null
              return (
                <div key={row.id} className="vmt-track-header" style={{ height: row.height }}>
                  <span
                    className="vmt-track-swatch"
                    style={{ background: trackColorById[track.id] || 'var(--theme-text-muted)' }}
                  />
                  <span className="vmt-track-name" title={track.name}>{track.name}</span>
                </div>
              )
            })
          )}
        </div>

        {/* Right: ruler + scrollable canvas + horizontal scrollbar */}
        <div className="vmt-canvas-col" ref={canvasAreaRef}>
          <TimelineRuler
            ref={rulerRef}
            pixelsPerBeatRef={pixelsPerBeatRef}
            scrollOffsetRef={scrollOffsetRef}
            playheadBeatRef={playheadBeatRef}
            onSeek={handleScrub}
            snapGranularity={snapGranularity}
            onWheel={handleWheel}
          />
          <div className="vmt-canvas-viewport">
            <VideoMirrorCanvas
              ref={canvasRef}
              pixelsPerBeatRef={pixelsPerBeatRef}
              scrollOffsetRef={scrollOffsetRef}
              playheadBeatRef={playheadBeatRef}
              tracks={visibleTracks}
              trackLayout={mirrorTrackLayout}
              clips={clips}
              regions={regions}
              patternBlocks={patternBlocks}
              patterns={patterns}
              cues={cues}
              snapshots={snapshots}
              defaultSnapshotId={defaultSnapshotId}
              totalBeats={totalBeats}
              bpmRef={bpmRef}
              snapGranularity={snapGranularity}
              onScrub={handleScrub}
              onWheel={handleWheel}
              onMoveCue={handleMoveCue}
              onRemoveCue={handleRemoveCue}
              onRepointCue={handleRepointCue}
              onSetCueTransition={handleSetCueTransition}
            />
          </div>
          <TimelineScrollbar
            scrollOffsetRef={scrollOffsetRef}
            pixelsPerBeatRef={pixelsPerBeatRef}
            totalBeats={totalBeats}
            canvasWidth={canvasWidth}
            onScroll={scrollBy}
            onScrollTo={scrollTo}
            scrollOffset={scrollOffset}
            pixelsPerBeat={pixelsPerBeat}
          />
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback, useMemo } from 'react'
import { drawGrid, drawClips, drawHoldZones, drawDropPreview, drawPatternBlocks, drawAutomationClips, drawWorldSpinners, drawGhostClips, resolveTimelinePalette } from './timelineDrawing.js'
import { buildResolvedTrackColorMap } from './trackColorResolver.js'
import useWorldProcessingStore from '../../stores/worldProcessingStore.js'
import useGhostClipStore from '../../stores/ghostClipStore.js'
import { TRACK_HEIGHT, beatToPixel, beatToPlayheadPixel, tickToPixel } from '../../constants/timeline.js'
import { clipHasFxIntent } from './clipGeometry.js'
import {
  TITLE_TEXT_PAD_X,
  blockInnerLayout, blockRect, blockWantsTitleStrip,
  buildTrackIdToIndex, getClipRect, hitTestBlockAt,
  trackIndexAtY, trackTopOf as trackTopForLayout,
} from './blockGeometry.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { timelineEvents } from '../../timelineEvents.js'
import { createSelectTool } from './tools/selectTool.js'
import { createPencilTool } from './tools/pencilTool.js'
import { createSplitTool } from './tools/splitTool.js'
import { createDeleteTool } from './tools/deleteTool.js'
import { didMiddleMousePanStart } from './middleMousePan.js'
import { createCoalescedRedraw } from './coalescedRedraw.js'
import './clipControls.css'
import {
  CLIP_CONTROL_DEFAULTS,
  applyGroupFadeDrag,
  applyGroupGainDrag,
  clipControlCursor,
  formatClipControlValue,
  hitTestClipControl as hitTestClipControlGeometry,
  normalizeClipControlSpec,
  normalizeClipFades,
} from './clipControlSpec.js'

import { subscribeDpr } from '../../ui-kit/dpr'
const PLAYHEAD_LINE_WIDTH = 1

// Dev-only frame-time probe: rolling buffer of redrawContent() durations,
// read via the imperative handle's getDrawStats() to size the per-frame
// budget before adding zoom/scroll animation on top of this hot path.
const DRAW_STATS_SIZE = 120

/**
 * Three-layer canvas: background (grid), content (clips), overlay (drop preview + tool).
 * Playhead is a GPU-composited DOM element animated via CSS transform.
 */
const TimelineCanvas = forwardRef(function TimelineCanvas(
  {
    trackCount, pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef, onWheel,
    clips, regions, tracks, selectedClipIds, dropPreviewRef, waveformCacheRef, hiResCacheRef, clipPeakCacheRef, bpmRef,
    patternBlocks, patterns, selectedBlockIds, setSelectedBlockIds,
    currentPatternIdByTrack,
    onCreatePatternBlock, onMovePatternBlocks, onDuplicatePatternBlocks, onResizePatternBlock, onResizePatternBlockLeft, onDeletePatternBlock, onSplitPatternBlock,
    onOpenPianoRoll,
    // Tool system props
    activeTool, stickyNoteLength, setStickyNoteLength, activeSampleId, snapGranularity,
    onCreateClip, onDeleteClip, onMoveClips, onDuplicateClips, onResizeClip, onResizeClipLeft,
    onStretchClip, onStretchClipLeft,
    onSplitClip,
    onRequestClipContextMenu,
    onRequestPatternBlockContextMenu,
    onSetClipVelocity, onSetClipFade,
    onBeginClipControlEdit, onPreviewClipControlEdit, onCommitClipControlEdit, onCancelClipControlEdit,
    clipControlSpec = CLIP_CONTROL_DEFAULTS,
    onMiddleMousePan,
    setSelectedClipIds,
    // Focus pivot (track-of-row under pointer) — fires on mouse-down/right-click
    onFocusTrack,
    // Pencil template (middle-click quick copy)
    pencilTemplateRef, onSetPencilTemplate,
    // Legacy drag-drop (from SampleSelectorTab)
    onCanvasDragOver, onCanvasDrop, onCanvasDragLeave,
    // Display settings (Pass 5B plumbing — consumed in Pass 5C)
    timelineDisplaySettings,
    // FX badge layer (Phase G.4)
    onOpenClipFxQuickMenu,
    scrollOffset,    // state value — used for badge re-positioning on scroll
    pixelsPerBeat,   // state value — used for badge re-positioning on zoom
    trackLayout,     // FXG.4-h-r1: derived row layout (track + macro lane rows)
    // Automation clips (Phase B)
    automationClips, automationEnvelopesById, automationBindingLabelsById,
    selectedAutomationClipIds, setSelectedAutomationClipIds,
    onMoveAutomationClip, onResizeAutomationClip, onResizeAutomationClipLeft,
    onDuplicateAutomationClips,
    onRequestAutomationClipContextMenu,
    // Automation point editing (Phase C)
    selectedAutomationPoint, setSelectedAutomationPoint,
    onAddAutomationPoint, onRemoveAutomationPoint, onMoveAutomationPoint,
  },
  ref
) {
  const containerRef = useRef(null)
  const bgRef = useRef(null)   // background (grid)
  const ctRef = useRef(null)   // content (clips)
  const ovRef = useRef(null)   // overlay (drop preview + tool overlay)
  const playheadLineRef = useRef(null) // DOM playhead element
  const sizeRef = useRef({ w: 0, h: 0 })

  // ── Dev-only frame-time probe (see getDrawStats below) ────────────────────
  const drawStatsRef = useRef(import.meta.env.DEV
    ? { samples: new Float64Array(DRAW_STATS_SIZE), index: 0, count: 0 }
    : null)

  // ── Stable refs for drawing data (avoid stale closures) ──────────────────
  const clipsRef = useRef(clips)
  const regionsRef = useRef(regions)
  const tracksRef = useRef(tracks)
  const selectedRef = useRef(selectedClipIds)
  const activeSampleIdRef = useRef(activeSampleId)
  const stickyNoteLengthRef = useRef(stickyNoteLength)
  const snapGranularityRef = useRef(snapGranularity)
  const patternBlocksRef = useRef(patternBlocks)
  const patternsRef = useRef(patterns)
  const selectedBlockIdsRef = useRef(selectedBlockIds)
  const currentPatternIdByTrackRef = useRef(currentPatternIdByTrack)
  const timelineDisplaySettingsRef = useRef(timelineDisplaySettings)
  const clipControlSpecRef = useRef(normalizeClipControlSpec(clipControlSpec))
  const automationClipsRef = useRef(automationClips)
  const selectedAutomationClipIdsRef = useRef(selectedAutomationClipIds)
  const automationEnvelopesByIdRef = useRef(automationEnvelopesById)
  const automationBindingLabelsByIdRef = useRef(automationBindingLabelsById)
  const selectedAutomationPointRef = useRef(selectedAutomationPoint)
  // Live point-drag preview, written by the select tool on every drag frame and
  // read by the content draw. A ref (not state) on purpose: a drag must repaint
  // the canvas without re-rendering React, and nothing outside the canvas cares.
  const automationPointDragRef = useRef(null)

  // FXG.4-h-r1: hold the derived row layout in a ref so the canvas hot draw
  // path + tools read the current track/lane geometry without re-creating tools.
  const trackLayoutRef = useRef(trackLayout)
  trackLayoutRef.current = trackLayout
  const badgeElsRef = useRef(new Map())   // clip id -> FX badge element

  clipsRef.current = clips
  regionsRef.current = regions
  tracksRef.current = tracks
  selectedRef.current = selectedClipIds

  // ── WORLD spinner state ───────────────────────────────────────────────────
  const worldProcessingClips    = useWorldProcessingStore(s => s.worldProcessingClips)
  const worldProcessingClipsRef = useRef(worldProcessingClips)
  worldProcessingClipsRef.current = worldProcessingClips

  // ── Notation ghost clips ──────────────────────────────────────────────────
  const ghostClips    = useGhostClipStore(s => s.ghostClips)
  const ghostClipsRef = useRef(ghostClips)
  ghostClipsRef.current = ghostClips
  const ghostTrackId    = useGhostClipStore(s => s.trackId)
  const ghostTrackIdRef = useRef(ghostTrackId)
  ghostTrackIdRef.current = ghostTrackId
  const spinAngleRef       = useRef(0)
  const spinRafRef         = useRef(null)
  // Memoized track-id→index map; rebuilt only when the tracks prop changes so
  // the 60fps spinner rAF loop allocates nothing per tick.
  const trackIdToIndexRef  = useRef({})
  activeSampleIdRef.current = activeSampleId
  stickyNoteLengthRef.current = stickyNoteLength
  snapGranularityRef.current = snapGranularity
  patternBlocksRef.current = patternBlocks
  patternsRef.current = patterns
  selectedBlockIdsRef.current = selectedBlockIds
  currentPatternIdByTrackRef.current = currentPatternIdByTrack
  timelineDisplaySettingsRef.current = timelineDisplaySettings
  clipControlSpecRef.current = normalizeClipControlSpec(clipControlSpec)
  automationClipsRef.current = automationClips
  selectedAutomationClipIdsRef.current = selectedAutomationClipIds
  automationEnvelopesByIdRef.current = automationEnvelopesById
  automationBindingLabelsByIdRef.current = automationBindingLabelsById
  selectedAutomationPointRef.current = selectedAutomationPoint

  // ── Tool instance ref ────────────────────────────────────────────────────
  const toolRef = useRef(null)
  const isDraggingRef = useRef(false)
  const middleMouseGestureRef = useRef(null)
  // Container rect, cached for the life of a drag gesture so per-mousemove
  // coordinate math doesn't force a style+layout flush via
  // getBoundingClientRect() on every pointer event. Only consulted while
  // isDraggingRef is true; outside a gesture getLocalXY always reads fresh.
  // Invalidated (nulled) on scroll/resize so a mid-gesture layout shift is
  // picked up on the next move instead of reading a stale rect all the way
  // to mouseup.
  const gestureRectRef = useRef(null)
  // Mirror of isDraggingRef into React state — drives FX badge layer hide
  // during drag/resize without touching the canvas hot path.
  const [isDraggingState, setIsDraggingState] = useState(false)
  const [isMiddlePanningState, setIsMiddlePanningState] = useState(false)
  const [clipControlCursorState, setClipControlCursorState] = useState(null)
  const [clipControlTooltip, setClipControlTooltip] = useState(null)

  // ── Inline pattern-block rename overlay ──────────────────────────────────
  const [renamingBlock, setRenamingBlock] = useState(null) // { patternId, x, y, w, h, initial }

  const commitPatternRename = useCallback(async (id, raw) => {
    setRenamingBlock(null)
    const name = (raw || '').trim()
    if (!name) return
    const current = patternsRef.current?.[id]?.name
    if (name === current) return
    try { await window.xleth?.timeline?.setPatternName?.(id, name) }
    catch (e) { console.warn('[TimelineCanvas] setPatternName failed', e) }
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
  }, [])

  // ── "Copied!" tooltip (middle-click feedback) ──────────────────────────────
  const [copiedTooltip, setCopiedTooltip] = useState(null) // { x, y }
  const copiedTooltipTimer = useRef(null)
  const clipControlDraftRef = useRef(null)
  const hoveredClipControlRef = useRef(null)
  const clipControlCancelRef = useRef(null)
  const clipControlHandlersRef = useRef({ hitTest: null, beginDrag: null })

  function showCopiedTooltip(x, y) {
    if (copiedTooltipTimer.current) clearTimeout(copiedTooltipTimer.current)
    setCopiedTooltip({ x, y })
    copiedTooltipTimer.current = setTimeout(() => setCopiedTooltip(null), 800)
  }

  // ── Sizing helper ──────────────────────────────────────────────────────────

  function applySize(canvas, w, h, dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  // ── Per-redraw derived track state (memoised) ─────────────────────────────
  // Keyed by identity of (tracks array, palette object). Both change rarely —
  // a zoom/pan gesture changes neither — so this collapses two per-frame
  // allocations (a Set + a full id→hex map) into one derivation per change.
  const derivedTrackStateRef = useRef({ tracks: null, palette: null, value: null })

  function derivedTrackState(tracks, palette) {
    const cache = derivedTrackStateRef.current
    if (cache.value && cache.tracks === tracks && cache.palette === palette) return cache.value
    const value = {
      mutedTrackIds: new Set((tracks || []).filter((t) => t.muted).map((t) => t.id)),
      trackColorById: buildResolvedTrackColorMap(tracks, palette.trackPalette),
    }
    derivedTrackStateRef.current = { tracks, palette, value }
    return value
  }

  // ── Drawing wrappers ───────────────────────────────────────────────────────
  //
  // Two ways to ask for a repaint:
  //
  //   redrawGrid / redrawContent      paint NOW. For anything driven per frame
  //                                   (the view animator, a drag) or that must
  //                                   be on screen before the caller continues.
  //   requestGridRedraw /             mark the layer stale and paint it once,
  //   requestContentRedraw            in a microtask. For "the data changed"
  //                                   notifications from React effects.
  //
  // One React commit routinely fires several of those effects together (clips
  // changed AND selection changed AND the row layout changed), and each used to
  // do its own full content rebuild, all but the last immediately painted
  // over. See coalescedRedraw.js.
  //
  // The coalescers outlive a render, so they call through `paintersRef` to
  // reach the CURRENT render's paint functions rather than the ones that
  // existed when the request was made.
  const paintersRef = useRef({ grid: null, content: null })
  const coalescedRef = useRef(null)
  if (!coalescedRef.current) {
    coalescedRef.current = {
      grid: createCoalescedRedraw((reason) => paintersRef.current.grid?.(reason)),
      content: createCoalescedRedraw((reason) => paintersRef.current.content?.(reason)),
    }
  }
  paintersRef.current.grid = redrawGrid
  paintersRef.current.content = redrawContent

  function requestGridRedraw(reason) {
    coalescedRef.current.grid.request(reason)
  }

  function requestContentRedraw(reason) {
    coalescedRef.current.content.request(reason)
  }

  function redrawGrid(reason) {
    coalescedRef.current.grid.settle()
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const t0 = performance.now()
    const ctx = bgRef.current?.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const palette = resolveTimelinePalette()
    drawGrid(
      ctx, w, h,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      trackCount, tracksRef.current, palette, trackLayoutRef.current,
      snapGranularityRef.current
    )
    const dt = performance.now() - t0
    if (dt > 16) console.warn(`[Timeline] WARNING grid redraw took ${dt.toFixed(1)}ms (reason: ${reason})`)
  }

  function redrawContent() {
    coalescedRef.current.content.settle()
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const ctx = ctRef.current?.getContext('2d')
    if (!ctx) return
    const t0 = import.meta.env.DEV ? performance.now() : 0
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const tidx = trackIdToIndexRef.current
    const palette = resolveTimelinePalette()
    // Both of these are pure functions of (tracks, palette), and both used to
    // be rebuilt on every animated frame. resolveTimelinePalette() is memoised
    // per theme now, so its identity is a valid cache key: re-derive only when
    // the track array or the theme actually changed.
    const { mutedTrackIds, trackColorById } = derivedTrackState(tracksRef.current, palette)
    // One description of the viewport for every block painter this frame.
    const view = {
      ctx, w, h,
      scrollOffset: scrollOffsetRef.current,
      ppb: pixelsPerBeatRef.current,
      trackIdToIndex: tidx,
      trackLayout: trackLayoutRef.current,
      palette,
      displaySettings: timelineDisplaySettingsRef.current,
      trackColorById,
      mutedTrackIds,
    }
    drawClips(view, {
      clips: clipsRef.current,
      regions: regionsRef.current,
      selectedClipIds: selectedRef.current,
      bpm: bpmRef?.current,
      waveformCache: waveformCacheRef?.current,
      hiResCache: hiResCacheRef?.current,
      clipPeakCache: clipPeakCacheRef?.current,
      activeClipControl: clipControlDraftRef.current,
      hoveredClipControl: hoveredClipControlRef.current,
      clipControlSpec: clipControlSpecRef.current,
    })
    // Hold Last Frame zones: how far past each clip's end a held frame stays on
    // screen. Drawn only by the Video tab's mirror until Phase 3; the
    // arrangement is the one timeline now. Returns at once when no track holds.
    drawHoldZones(
      ctx, w, h,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      clipsRef.current, tidx, tracksRef.current, palette, trackLayoutRef.current
    )
    drawPatternBlocks(view, {
      blocks: patternBlocksRef.current,
      patterns: patternsRef.current,
      regions: regionsRef.current,
      selectedBlockIds: selectedBlockIdsRef.current,
    })
    if (automationClipsRef.current?.length) {
      const laneRows = trackLayoutRef.current?.getAutomationLaneRows?.() ?? []
      const laneRowsByLaneId = new Map(laneRows.map((r) => [r.laneId, r]))
      drawAutomationClips(
        ctx, w, h,
        scrollOffsetRef.current, pixelsPerBeatRef.current,
        automationClipsRef.current, laneRowsByLaneId, automationEnvelopesByIdRef.current,
        selectedAutomationClipIdsRef.current, palette, automationBindingLabelsByIdRef.current,
        selectedAutomationPointRef.current, automationPointDragRef.current
      )
    }
    if (ghostClipsRef.current?.length && ghostTrackIdRef.current != null) {
      const gIdx = tidx[ghostTrackIdRef.current]
      if (gIdx != null) {
        const so  = scrollOffsetRef.current
        const ppb = pixelsPerBeatRef.current
        const lay = trackLayoutRef.current
        const tickToPixelFn = (tick) => tickToPixel(tick, so, ppb)
        const rowTop = trackTopForLayout(gIdx, lay)
        const trackClips = clipsRef.current.filter(c => c.trackId === ghostTrackIdRef.current)
        drawGhostClips(ctx, ghostClipsRef.current, trackClips, tickToPixelFn, rowTop, palette)
      }
    }
    // WORLD spinners live on the overlay layer (see redrawOverlay). They sit on
    // clips, so when the content moves they have to move in the same frame.
    if (worldProcessingClipsRef.current?.size) redrawOverlay()
    if (import.meta.env.DEV) {
      const stats = drawStatsRef.current
      stats.samples[stats.index] = performance.now() - t0
      stats.index = (stats.index + 1) % DRAW_STATS_SIZE
      stats.count = Math.min(stats.count + 1, DRAW_STATS_SIZE)
    }
  }

  // Dev-only: p50/p95/max of the last (up to) DRAW_STATS_SIZE redrawContent()
  // calls, in milliseconds. Used to size the per-frame budget before adding
  // zoom/scroll animation on top of this hot path.
  function getDrawStats() {
    const stats = drawStatsRef.current
    if (!stats || stats.count === 0) return { p50: 0, p95: 0, max: 0, samples: 0 }
    const sorted = Array.from(stats.samples.slice(0, stats.count)).sort((a, b) => a - b)
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], samples: stats.count }
  }

  function redrawOverlay() {
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const ctx = ovRef.current?.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // Drop preview (legacy drag-drop from SampleSelectorTab)
    if (dropPreviewRef?.current) {
      drawDropPreview(ctx, w, h, scrollOffsetRef.current, pixelsPerBeatRef.current, dropPreviewRef.current)
    }
    // Tool overlay
    toolRef.current?.drawOverlay(ctx, w, h, {
      scrollOffset: scrollOffsetRef.current,
      pixelsPerBeat: pixelsPerBeatRef.current,
    })
    // WORLD processing spinners. On this layer because they animate at 60fps
    // for as long as a render job runs: repainting them from the content layer
    // meant rebuilding every clip, waveform and pattern block each frame.
    const wpc = worldProcessingClipsRef.current
    if (wpc?.size) {
      drawWorldSpinners(
        ctx, clipsRef.current, trackIdToIndexRef.current, wpc,
        scrollOffsetRef.current, pixelsPerBeatRef.current,
        spinAngleRef.current, resolveTimelinePalette().accent || '#5b8aff',
        trackLayoutRef.current, w,
      )
    }
  }

  // ── Position the DOM playhead element ─────────────────────────────────────

  function positionPlayhead(beat) {
    const el = playheadLineRef.current
    if (!el) return
    const rawPx = beatToPixel(beat, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const px = beatToPlayheadPixel(beat, scrollOffsetRef.current, pixelsPerBeatRef.current, PLAYHEAD_LINE_WIDTH)
    const w = sizeRef.current.w || 9999
    if (rawPx >= -PLAYHEAD_LINE_WIDTH && rawPx <= w + PLAYHEAD_LINE_WIDTH) {
      el.style.transform = `translateX(${px}px)`
      el.style.opacity = '1'
    } else {
      el.style.opacity = '0'
    }
  }

  // ── Reposition the DOM FX badges ──────────────────────────────────────────
  // Which badges EXIST is settled-state work (see the fxBadges memo below — it
  // needs the clip list anyway), but where they SIT is not: they are DOM on top
  // of a canvas the view animator redraws every frame, so their positions come
  // off the same live refs, once per those frames. Driving them from the
  // settled state left them hanging motionless over scrolling clips, snapping
  // into place ~100ms after the gesture ended.
  //
  // A function declaration, not a useCallback: the imperative handle below is
  // built during render and would hit the const's temporal dead zone.
  function repositionFxBadges() {
    const els = badgeElsRef.current
    if (els.size === 0) return
    const so = scrollOffsetRef.current
    const ppb = pixelsPerBeatRef.current
    const trackIdToIndex = trackIdToIndexRef.current
    for (const clip of clipsRef.current || []) {
      const el = els.get(clip.id)
      if (!el) continue
      const rect = getClipRect(clip, trackIdToIndex, so, ppb, trackLayoutRef.current)
      if (!rect) { el.style.visibility = 'hidden'; continue }
      el.style.visibility = rect.w < 56 ? 'hidden' : ''
      // transform is compositor-only (no layout/paint), unlike left/top —
      // matters here since this runs on every animator frame during scroll/zoom.
      el.style.transform = `translate(${Math.round(rect.x + rect.w - 28)}px, ${Math.round(rect.y + 3)}px)`
    }
  }

  // Expose to parent
  useImperativeHandle(ref, () => ({
    redrawGrid, redrawContent, redrawOverlay, positionPlayhead, getDrawStats,
    requestGridRedraw, requestContentRedraw,
    repositionFxBadges,
  }), [trackCount])

  // ── Tool creation ─────────────────────────────────────────────────────────

  useEffect(() => {
    const toolDeps = {
      clipsRef, tracksRef, regionsRef, selectedRef,
      pixelsPerBeatRef, scrollOffsetRef, bpmRef,
      trackIdToIndexRef,
      // The colour a track's blocks are painted in, for drag / draw previews.
      trackColorOf: (trackId) => (
        derivedTrackState(tracksRef.current, resolveTimelinePalette()).trackColorById[trackId]
      ),
      activeSampleIdRef, stickyNoteLengthRef, pencilTemplateRef,
      snapGranularityRef, trackLayoutRef,
      onCreateClip, onDeleteClip, onMoveClips, onDuplicateClips, onResizeClip, onResizeClipLeft,
      onStretchClip, onStretchClipLeft,
      onSplitClip,
      onRequestClipContextMenu,
      setSelectedClipIds, setStickyNoteLength,
      redrawOverlay,
      redrawContent,
      containerRef,
      // Pattern-block state + callbacks
      patternBlocksRef, patternsRef, selectedBlockIdsRef,
      currentPatternIdByTrackRef,
      setSelectedBlockIds,
      onCreatePatternBlock, onMovePatternBlocks, onDuplicatePatternBlocks, onResizePatternBlock, onResizePatternBlockLeft,
      onDeletePatternBlock, onSplitPatternBlock,
      onRequestPatternBlockContextMenu,
      // Automation clip deps (Phase B)
      automationClipsRef, selectedAutomationClipIdsRef, setSelectedAutomationClipIds,
      onMoveAutomationClip, onResizeAutomationClip, onResizeAutomationClipLeft,
      onDuplicateAutomationClips,
      onRequestAutomationClipContextMenu,
      // Automation point editing deps (Phase C)
      automationEnvelopesByIdRef, setSelectedAutomationPoint,
      onAddAutomationPoint, onRemoveAutomationPoint, onMoveAutomationPoint,
      automationPointDragRef,
    }

    const factories = {
      select: createSelectTool,
      pencil: createPencilTool,
      split: createSplitTool,
      delete: createDeleteTool,
    }

    // Cleanup old tool
    toolRef.current?.cleanup?.()
    toolRef.current = factories[activeTool]?.(toolDeps) || null
    console.log(`[Toolbar] Tool switched → ${activeTool}`)

    // Clear overlay when switching tools
    redrawOverlay()
  }, [activeTool])

  // ── Sizing + initial draw ───────────────────────────────────────────────────

  function sizeAndDraw(container, reason) {
    const rw = Math.floor(container.clientWidth)
    const rh = Math.floor(container.clientHeight)
    if (rw === 0 || rh === 0) return
    const dpr = window.devicePixelRatio || 1
    // The UI scale (window zoom) changes the DPR without changing the CSS box, so the
    // backing store has to be re-sized for a DPR change too.
    if (rw === sizeRef.current.w && rh === sizeRef.current.h && dpr === sizeRef.current.dpr) return
    sizeRef.current = { w: rw, h: rh, dpr }

    console.log(`[Timeline] Canvas init ${rw}×${rh} (DPR ${dpr})`)

    ;[bgRef, ctRef, ovRef].forEach((r) => {
      if (r.current) applySize(r.current, rw, rh, dpr)
    })

    redrawGrid(reason)
    redrawContent(reason)
    redrawOverlay()
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    sizeAndDraw(container, 'mount')
    const timerId = setTimeout(() => sizeAndDraw(container, 'deferred-mount'), 50)

    const observer = new ResizeObserver(() => {
      gestureRectRef.current = null
      sizeAndDraw(container, 'resize')
    })
    observer.observe(container)
    const offDpr = subscribeDpr(() => sizeAndDraw(container, 'dpr'))
    return () => { clearTimeout(timerId); observer.disconnect(); offDpr() }
  }, [trackCount])

  // Invalidate the gesture-cached container rect on any window resize or
  // ancestor scroll (capture: true catches a scrollable panel, not just the
  // window itself) — a mid-drag layout shift must not read a stale rect for
  // the rest of the gesture.
  useEffect(() => {
    const invalidate = () => { gestureRectRef.current = null }
    window.addEventListener('resize', invalidate)
    window.addEventListener('scroll', invalidate, true)
    return () => {
      window.removeEventListener('resize', invalidate)
      window.removeEventListener('scroll', invalidate, true)
    }
  }, [])

  // ── Wheel handler (non-passive) ────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el || !onWheel) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // ── Keep trackIdToIndexRef in sync with the tracks prop ──────────────────
  // Avoids allocating a new map object on every 60fps rAF tick during WORLD
  // processing — the map rebuilds only when the track list structurally changes.

  useEffect(() => {
    trackIdToIndexRef.current = buildTrackIdToIndex(tracksRef.current)
  }, [tracks])

  // ── Redraw when the row layout changes (macro lane add/remove/visibility) ──
  // The container's minHeight tracks totalHeight, but a visibility toggle that
  // leaves height unchanged still shifts track tops, so force a grid+content
  // repaint on any layout identity change.
  useEffect(() => {
    requestGridRedraw('track-layout')
    requestContentRedraw('track-layout')
  }, [trackLayout])

  useEffect(() => {
    requestGridRedraw('snap-granularity')
  }, [snapGranularity])

  useEffect(() => {
    requestContentRedraw('clip-control-spec')
  }, [clipControlSpec])

  useEffect(() => () => {
    clipControlCancelRef.current?.('unmount')
  }, [])

  // ── Redraw when notation ghost clips change ───────────────────────────────
  useEffect(() => {
    requestContentRedraw('ghost-clips')
  }, [ghostClips, ghostTrackId])

  // ── WORLD spinner rAF loop ────────────────────────────────────────────────
  // Runs at ~60fps only while at least one clip is being WORLD-processed, and
  // repaints the overlay layer only (the spinners are the one thing changing).

  useEffect(() => {
    if (worldProcessingClips.size === 0) {
      if (spinRafRef.current) {
        cancelAnimationFrame(spinRafRef.current)
        spinRafRef.current = null
      }
      redrawOverlay() // clear the last spinner frame
      return
    }
    function tick() {
      spinAngleRef.current = (spinAngleRef.current + 0.08) % (Math.PI * 2)
      redrawOverlay()
      spinRafRef.current = requestAnimationFrame(tick)
    }
    if (!spinRafRef.current) spinRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (spinRafRef.current) { cancelAnimationFrame(spinRafRef.current); spinRafRef.current = null }
    }
  }, [worldProcessingClips])

  // ── PlayheadClock 60fps playhead animation (DOM element, GPU-composited) ──

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs, bpm, positionBeats) => {
      const beat = Number.isFinite(positionBeats) ? positionBeats : posMs * bpm / 60000
      playheadBeatRef.current = beat
      positionPlayhead(beat)
    })
    return unsub
  }, [])

  // ── Event helpers: compute local coordinates ──────────────────────────────

  const getLocalXY = useCallback((e) => {
    let rect = isDraggingRef.current ? gestureRectRef.current : null
    if (!rect) {
      rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return null
      if (isDraggingRef.current) gestureRectRef.current = rect
    }
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  // FXG.4-h-r1: resolve a local Y to a track index through the row layout so
  // macro automation lane bands map to their parent track (clips never land on a
  // lane). Falls back to contiguous geometry when no layout is present.
  const trackIndexAtLocalY = useCallback(
    (localY) => trackIndexAtY(localY, trackLayoutRef.current),
    [],
  )

  // Pointer geometry for the current viewport (see blockGeometry.js).
  const currentView = useCallback(() => ({
    scrollOffset: scrollOffsetRef.current,
    ppb: pixelsPerBeatRef.current,
    trackIdToIndex: trackIdToIndexRef.current,
    trackLayout: trackLayoutRef.current,
  }), [])

  const buildPencilTemplateFromHitClip = useCallback((hitClip) => {
    if (!hitClip) return null
    const region = regionsRef.current?.[hitClip.regionId]
    return {
      regionId: hitClip.regionId,
      regionOffsetTicks: hitClip.regionOffsetTicks ?? 0,
      durationTicks: hitClip.durationTicks,
      velocity: hitClip.velocity ?? 1.0,
      pitchOffset: hitClip.pitchOffset ?? 0,
      syllableIndex: hitClip.syllableIndex ?? -1,
      displayName: region?.name || '?',
      label: region?.label,
    }
  }, [])

  // ── Mouse event handlers (dispatched to active tool) ──────────────────────

  const handleMouseDown = useCallback((e) => {
    const pos = getLocalXY(e)
    if (!pos) return

    if (e.button === 0 && activeTool !== 'pencil') {
      const handlers = clipControlHandlersRef.current
      const clipControlHit = handlers.hitTest?.(pos.localX, pos.localY)
      if (clipControlHit && handlers.beginDrag?.(clipControlHit, e)) return
    }

    // ── Focus shift on left-click anywhere in a track row ─────────────────
    // Covers empty-body click, clip click, and pattern-block click —
    // selection logic stays untouched downstream.
    if (e.button === 0 && onFocusTrack) {
      const tks = tracksRef.current
      const trackIdx = trackIndexAtLocalY(pos.localY)
      if (tks && trackIdx >= 0 && trackIdx < tks.length) {
        onFocusTrack(tks[trackIdx].id)
      }
    }

    // ── Middle-click: tap copies a clip, hold+drag pans the playlist. ─────
    if (e.button === 1) {
      e.preventDefault()
      const trackIndex = trackIndexAtLocalY(pos.localY)
      const tks = tracksRef.current || []
      const hitClip = trackIndex >= 0 && trackIndex < tks.length
        ? hitTestBlockAt(clipsRef.current, pos.localX, trackIndex, currentView())
        : null

      middleMouseGestureRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        copyTemplate: hitClip && onSetPencilTemplate ? buildPencilTemplateFromHitClip(hitClip) : null,
        tooltipX: pos.localX,
        tooltipY: pos.localY,
        panning: false,
        prevBodyCursor: document.body.style.cursor,
      }

      const onWindowMove = (me) => {
        const gesture = middleMouseGestureRef.current
        if (!gesture) return

        const totalDx = me.clientX - gesture.startClientX
        const totalDy = me.clientY - gesture.startClientY
        if (!gesture.panning) {
          if (!onMiddleMousePan || !didMiddleMousePanStart(totalDx, totalDy)) return
          gesture.panning = true
          isDraggingRef.current = true
          setIsDraggingState(true)
          setIsMiddlePanningState(true)
          document.body.style.cursor = 'grabbing'
        }

        const deltaX = me.clientX - gesture.lastClientX
        const deltaY = me.clientY - gesture.lastClientY
        gesture.lastClientX = me.clientX
        gesture.lastClientY = me.clientY
        if (deltaX !== 0 || deltaY !== 0) onMiddleMousePan(deltaX, deltaY)
      }

      const onWindowUp = () => {
        const gesture = middleMouseGestureRef.current
        middleMouseGestureRef.current = null
        window.removeEventListener('mousemove', onWindowMove)
        window.removeEventListener('mouseup', onWindowUp)
        if (!gesture) return

        if (gesture.panning) {
          isDraggingRef.current = false
          setIsDraggingState(false)
          setIsMiddlePanningState(false)
          document.body.style.cursor = gesture.prevBodyCursor
          redrawOverlay()
          return
        }

        if (gesture.copyTemplate && onSetPencilTemplate) {
          onSetPencilTemplate(gesture.copyTemplate)
          showCopiedTooltip(gesture.tooltipX, gesture.tooltipY)
        }
      }

      window.addEventListener('mousemove', onWindowMove)
      window.addEventListener('mouseup', onWindowUp)
      return
    }

    // ── Left-click / other: dispatch to active tool ───────────────────────
    toolRef.current?.onMouseDown(pos.localX, pos.localY, e)
    isDraggingRef.current = true
    setIsDraggingState(true)

    // Register window-level listeners for drag capture
    const onWindowMove = (me) => {
      const p = getLocalXY(me)
      if (p) toolRef.current?.onMouseMove(p.localX, p.localY, me)
    }
    const onWindowUp = (me) => {
      const p = getLocalXY(me)
      if (p) toolRef.current?.onMouseUp(p.localX, p.localY, me)
      isDraggingRef.current = false
      setIsDraggingState(false)
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
      window.removeEventListener('keyup', onWindowKeyUp)
      // Redraw overlay after drag ends (cursor is CSS-owned via data-tool attribute)
      redrawOverlay()
    }
    const onWindowKeyUp = (ke) => {
      toolRef.current?.onKeyUp?.(ke)
    }
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
    window.addEventListener('keyup', onWindowKeyUp)
  }, [activeTool, buildPencilTemplateFromHitClip, getLocalXY, onMiddleMousePan, onSetPencilTemplate, onFocusTrack])

  const updateHoveredClipControl = useCallback((hit) => {
    const next = hit ? { clipId: hit.clip.id, kind: hit.kind } : null
    const previous = hoveredClipControlRef.current
    if (previous?.clipId === next?.clipId && previous?.kind === next?.kind) return
    hoveredClipControlRef.current = next
    setClipControlCursorState(clipControlCursor(next?.kind))
    redrawContent('clip-control-hover')
  }, [])

  const handleMouseMove = useCallback((e) => {
    // Only handle hover (non-dragging) moves here; dragging is captured on window
    if (isDraggingRef.current) return
    const pos = getLocalXY(e)
    if (!pos) return
    const hit = activeTool !== 'pencil'
      ? clipControlHandlersRef.current.hitTest?.(pos.localX, pos.localY)
      : null
    updateHoveredClipControl(hit)
    toolRef.current?.onMouseMove(pos.localX, pos.localY, e)
  }, [activeTool, getLocalXY, updateHoveredClipControl])

  const handleMouseLeave = useCallback(() => {
    if (!isDraggingRef.current) updateHoveredClipControl(null)
  }, [updateHoveredClipControl])

  const handleDoubleClick = useCallback((e) => {
    const pos = getLocalXY(e)
    if (!pos) return
    // Automation lanes claim the double-click first (add an envelope point);
    // the tool returns true when the Y landed on an automation lane row, which
    // has no track index for the clip/pattern paths below to use anyway.
    if (toolRef.current?.onDoubleClick?.(pos.localX, pos.localY, e)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (activeTool !== 'pencil') {
      const hit = clipControlHandlersRef.current.hitTest?.(pos.localX, pos.localY)
      if (hit) {
        e.preventDefault()
        e.stopPropagation()
        const patch = hit.kind === 'volume'
          ? { velocity: 1 }
          : (hit.kind === 'fadeIn' ? { fadeInPercent: 0 } : { fadeOutPercent: 0 })
        const commitReset = async () => {
          let session = null
          try {
            session = await onBeginClipControlEdit?.(hit.clip.id)
            if (session?.sessionId && onCommitClipControlEdit) {
              await onCommitClipControlEdit(session.sessionId, patch)
            } else if (hit.kind === 'volume') {
              await onSetClipVelocity?.(hit.clip.id, 1)
            } else {
              await onSetClipFade?.(hit.clip.id, patch)
            }
          } catch (err) {
            console.warn('[TimelineCanvas] clip control reset failed', err)
            if (session?.sessionId && onCancelClipControlEdit) {
              try { await onCancelClipControlEdit(session.sessionId) } catch { /* already stale */ }
            }
          }
        }
        void commitReset()
        return
      }
    }
    const trackIndex = trackIndexAtLocalY(pos.localY)
    const tks = tracksRef.current
    if (!tks || trackIndex < 0 || trackIndex >= tks.length) return
    const view = currentView()
    const b = hitTestBlockAt(patternBlocksRef.current, pos.localX, trackIndex, view)
    if (!b) return

    // A double-click on the block's NAME renames the pattern in place; anywhere
    // else on the block opens the Piano Roll. "The name" is the title strip the
    // draw path actually painted (same layout function), so there is no rename
    // zone on a block too short or too narrow to show one.
    const rect = blockRect(b, trackIndex, view.scrollOffset, view.ppb, view.trackLayout)
    const showNames = timelineDisplaySettingsRef.current?.timelineShowClipNames
    const layout = blockInnerLayout(rect, blockWantsTitleStrip(rect, showNames))
    const labelX1 = layout.titleX + TITLE_TEXT_PAD_X
    const labelX2 = layout.titleX + layout.titleW - TITLE_TEXT_PAD_X
    const inLabel = layout.useStrip
      && pos.localX >= labelX1 && pos.localX <= labelX2
      && pos.localY >= layout.titleY && pos.localY <= layout.titleY + layout.titleH
    if (inLabel && labelX2 > labelX1 + 20) {
      setRenamingBlock({
        patternId: b.patternId,
        x: labelX1,
        y: layout.titleY,
        w: Math.max(60, labelX2 - labelX1),
        h: 18,
        initial: patternsRef.current?.[b.patternId]?.name ?? `Pattern ${b.patternId}`,
      })
      return
    }
    onOpenPianoRoll?.(b.patternId, b.id)
  }, [activeTool, currentView, getLocalXY, onBeginClipControlEdit, onCancelClipControlEdit, onCommitClipControlEdit, onOpenPianoRoll, onSetClipFade, onSetClipVelocity, trackIndexAtLocalY])

  const handleContextMenu = useCallback((e) => {
    const pos = getLocalXY(e)
    if (!pos) return
    // Focus shift before any menu opens — keeps right-click paste consistent
    if (onFocusTrack) {
      const tks = tracksRef.current
      const trackIdx = trackIndexAtLocalY(pos.localY)
      if (tks && trackIdx >= 0 && trackIdx < tks.length) {
        onFocusTrack(tks[trackIdx].id)
      }
    }
    if (toolRef.current?.onContextMenu) {
      toolRef.current.onContextMenu(pos.localX, pos.localY, e)
    }
  }, [getLocalXY, onFocusTrack])

  // ── Legacy drag-drop handlers ─────────────────────────────────────────────

  const handleDragOver = useCallback((e) => {
    if (!onCanvasDragOver) return
    const pos = getLocalXY(e)
    if (pos) onCanvasDragOver(pos.localX, pos.localY, e)
  }, [onCanvasDragOver, getLocalXY])

  const handleDrop = useCallback((e) => {
    if (!onCanvasDrop) return
    const pos = getLocalXY(e)
    if (pos) onCanvasDrop(pos.localX, pos.localY, e)
  }, [onCanvasDrop, getLocalXY])

  // ── FX badge layer (Phase G.4) ────────────────────────────────────────────
  // Compute one entry per visible clip carrying modulation intent. Re-runs on
  // scroll/zoom *state* changes so DOM badges follow the canvas.

  const fxBadges = useMemo(() => {
    if (!clips || !tracks || !onOpenClipFxQuickMenu) return []
    if (typeof scrollOffset !== 'number' || typeof pixelsPerBeat !== 'number') return []
    const trackIdToIndex = buildTrackIdToIndex(tracks)
    // getClipRect only returns null for an unknown trackId — it never culls
    // by x, so without this a project with hundreds of modulated clips mounts
    // one <button> per clip project-wide, most of them off-screen (drawClips
    // culls the canvas equivalent at its own loop; this mirrors that here).
    const viewportW = sizeRef.current.w || 0
    const out = []
    for (const clip of clips) {
      if (!clipHasFxIntent(clip)) continue
      const rect = getClipRect(clip, trackIdToIndex, scrollOffset, pixelsPerBeat, trackLayout)
      if (!rect) continue
      if (rect.w < 56) continue
      if (rect.x + rect.w < 0 || rect.x > viewportW) continue
      out.push({ id: clip.id, rect })
    }
    return out
  }, [clips, tracks, scrollOffset, pixelsPerBeat, onOpenClipFxQuickMenu, trackLayout])

  const hitTestClipControl = useCallback((localX, localY) => {
    if (!onSetClipVelocity && !onSetClipFade && !onBeginClipControlEdit) return null
    const clipList = clipsRef.current || []
    const trackList = tracksRef.current || []
    const ppb = pixelsPerBeatRef.current
    const so = scrollOffsetRef.current
    const trackIdToIndex = trackIdToIndexRef.current

    for (let i = clipList.length - 1; i >= 0; i--) {
      const clip = clipList[i]
      const trackIdx = trackIdToIndex[clip.trackId]
      const track = trackList[trackIdx]
      if (track?.type === 'Pattern') continue
      const rect = getClipRect(clip, trackIdToIndex, so, ppb, trackLayoutRef.current)
      if (!rect) continue
      const result = hitTestClipControlGeometry({
        localX,
        localY,
        clip,
        rect,
        spec: clipControlSpecRef.current,
        allowGain: Boolean(onSetClipVelocity || onBeginClipControlEdit),
        allowFade: Boolean(onSetClipFade || onBeginClipControlEdit),
      })
      if (result) return { ...result, clip, rect, fades: normalizeClipFades(clip) }
    }
    return null
  }, [onBeginClipControlEdit, onSetClipFade, onSetClipVelocity])

  const beginClipControlDrag = useCallback((hit, startEvent) => {
    if (!hit) return false
    startEvent.preventDefault()
    startEvent.stopPropagation()

    // Grabbing a control on a clip that is part of a multi-clip selection edits
    // the WHOLE selection (see applyGroupGainDrag). Grabbing anything else
    // collapses the selection onto that clip, as a single-clip drag always did.
    const selectedIds = selectedRef.current
    const isGroup = Boolean(selectedIds?.has(hit.clip.id) && selectedIds.size > 1)
    if (!isGroup) setSelectedClipIds?.(new Set([hit.clip.id]))
    onFocusTrack?.(hit.clip.trackId)
    isDraggingRef.current = true
    setIsDraggingState(true)
    setClipControlCursorState(clipControlCursor(hit.kind))
    hoveredClipControlRef.current = { clipId: hit.clip.id, kind: hit.kind }

    // Anchor first — the grabbed clip is the one that tracks the cursor and
    // whose travel defines the delta handed to the rest of the group.
    const trackList = tracksRef.current || []
    const tidx = trackIdToIndexRef.current
    const groupClips = isGroup
      ? [
          hit.clip,
          ...(clipsRef.current || []).filter((c) => (
            c.id !== hit.clip.id &&
            selectedIds.has(c.id) &&
            trackList[tidx[c.trackId]]?.type !== 'Pattern'
          )),
        ]
      : [hit.clip]

    const valueOf = (clip) => {
      if (hit.kind === 'volume') return Number(clip.velocity ?? 1)
      const fades = normalizeClipFades(clip)
      return hit.kind === 'fadeIn' ? fades.fadeInPercent : fades.fadeOutPercent
    }
    const oppositeOf = (clip) => {
      const fades = normalizeClipFades(clip)
      return hit.kind === 'fadeIn' ? fades.fadeOutPercent : fades.fadeInPercent
    }
    const groupEntries = groupClips.map((clip) => ({
      id: clip.id,
      velocity: Number(clip.velocity ?? 1),
      start: valueOf(clip),
      opposite: oppositeOf(clip),
    }))

    const startValue = valueOf(hit.clip)
    const startClientX = startEvent.clientX
    const startClientY = startEvent.clientY
    let previewRaf = null
    let pendingPreviewValues = null
    let pendingTooltip = null
    let pendingRepaint = false
    let ended = false

    // One edit session per clip. They are independent, so a failure on one
    // resolves to null and that clip simply falls back to the direct setter.
    const sessionsPromise = onBeginClipControlEdit
      ? Promise.all(groupClips.map((clip) => (
          Promise.resolve(onBeginClipControlEdit(clip.id))
            .then((session) => [clip.id, session?.sessionId ?? null])
            .catch((err) => {
              console.warn('[TimelineCanvas] begin clip control edit failed', err)
              return [clip.id, null]
            })
        ))).then((pairs) => new Map(pairs))
      : Promise.resolve(new Map())

    const patchForValue = (value) => {
      if (hit.kind === 'volume') return { velocity: Number(value.toFixed(6)) }
      if (hit.kind === 'fadeIn') return { fadeInPercent: Number(value.toFixed(4)) }
      return { fadeOutPercent: Number(value.toFixed(4)) }
    }

    // One rAF per frame drives BOTH the (expensive) canvas repaint/tooltip and
    // the IPC preview — coalescing several mousemove events into a single
    // paint + a single round trip, instead of a redrawContent() and a preview
    // call on every pointer event.
    const flushPreview = () => {
      previewRaf = null
      const values = pendingPreviewValues
      pendingPreviewValues = null
      const tooltip = pendingTooltip
      pendingTooltip = null
      const repaint = pendingRepaint
      pendingRepaint = false
      if (ended) return
      if (tooltip) setClipControlTooltip(tooltip)
      if (repaint) redrawContent('clip-control-drag')
      if (!values || !onPreviewClipControlEdit) return
      sessionsPromise.then((sessions) => {
        if (ended) return
        return Promise.all([...values].map(([clipId, value]) => {
          const sessionId = sessions.get(clipId)
          if (!sessionId) return null
          return onPreviewClipControlEdit(sessionId, patchForValue(value))
        }))
      }).catch((err) => console.warn('[TimelineCanvas] clip control preview failed', err))
    }

    const schedulePreview = (values) => {
      pendingPreviewValues = values
      if (previewRaf == null) previewRaf = requestAnimationFrame(flushPreview)
    }

    const setDraftFromEvent = (event, preview = true) => {
      const dx = event.clientX - startClientX
      const dy = event.clientY - startClientY
      const spec = clipControlSpecRef.current
      const { values, blocked } = hit.kind === 'volume'
        ? applyGroupGainDrag(groupEntries, dy, event, spec)
        : applyGroupFadeDrag(hit.kind, groupEntries, dx, hit.rect.w, event, spec)
      const value = values.get(hit.clip.id) ?? startValue
      clipControlDraftRef.current = {
        clipId: hit.clip.id,
        kind: hit.kind,
        value,
        values,
        blocked: new Set(blocked),
      }
      const p = getLocalXY(event)
      const tooltip = p ? {
        x: p.localX,
        y: p.localY,
        text: formatClipControlValue(hit.kind, value, spec)
          + (groupEntries.length > 1 ? ` · ${groupEntries.length} clips` : '')
          + (blocked.length > 0 ? ' · at limit' : ''),
      } : null

      if (preview) {
        // Live drag move: coalesce the tooltip + repaint onto the same rAF
        // as the IPC preview instead of painting synchronously per event.
        pendingTooltip = tooltip
        pendingRepaint = true
        schedulePreview(values)
      } else {
        // Seed (mousedown) / final (mouseup) call — must land immediately,
        // and supersedes anything already queued for this frame.
        if (previewRaf != null) { cancelAnimationFrame(previewRaf); previewRaf = null }
        pendingPreviewValues = null
        pendingTooltip = null
        pendingRepaint = false
        if (tooltip) setClipControlTooltip(tooltip)
        redrawContent('clip-control-drag')
      }
      return values
    }

    clipControlDraftRef.current = { clipId: hit.clip.id, kind: hit.kind, value: startValue }
    setDraftFromEvent(startEvent, false)

    const onWindowMove = (event) => {
      setDraftFromEvent(event)
    }

    const removeListeners = () => {
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
      window.removeEventListener('keydown', onWindowKeyDown)
      window.removeEventListener('blur', onWindowBlur)
    }

    const clearInteraction = () => {
      clipControlDraftRef.current = null
      clipControlCancelRef.current = null
      isDraggingRef.current = false
      setIsDraggingState(false)
      setClipControlTooltip(null)
      const hovered = hoveredClipControlRef.current
      setClipControlCursorState(clipControlCursor(hovered?.kind))
      redrawContent('clip-control-commit')
    }

    const cancelDrag = (reason = 'cancel') => {
      if (ended) return
      ended = true
      removeListeners()
      if (previewRaf != null) cancelAnimationFrame(previewRaf)
      previewRaf = null
      pendingPreviewValues = null
      pendingTooltip = null
      pendingRepaint = false
      sessionsPromise.then((sessions) => Promise.all(
        [...sessions.values()]
          .filter(Boolean)
          .map((sessionId) => onCancelClipControlEdit?.(sessionId)),
      )).catch((err) => console.warn(`[TimelineCanvas] clip control ${reason} restore failed`, err))
      clearInteraction()
    }

    const onWindowUp = async (event) => {
      if (ended) return
      const values = setDraftFromEvent(event, false)
      ended = true
      removeListeners()
      if (previewRaf != null) cancelAnimationFrame(previewRaf)
      previewRaf = null
      pendingPreviewValues = null
      pendingTooltip = null
      pendingRepaint = false
      const sessions = await sessionsPromise
      // Commit each clip on its own. One clip failing must not abandon the rest,
      // so only the clips that actually threw get rolled back.
      const commitOne = async (clipId, value) => {
        const sessionId = sessions.get(clipId)
        try {
          if (sessionId && onCommitClipControlEdit) {
            await onCommitClipControlEdit(sessionId, patchForValue(value))
          } else if (hit.kind === 'volume') {
            await onSetClipVelocity?.(clipId, Number(value.toFixed(6)))
          } else if (hit.kind === 'fadeIn') {
            await onSetClipFade?.(clipId, { fadeInPercent: Number(value.toFixed(4)) })
          } else {
            await onSetClipFade?.(clipId, { fadeOutPercent: Number(value.toFixed(4)) })
          }
        } catch (err) {
          console.warn('[TimelineCanvas] clip control commit failed', err)
          if (sessionId && onCancelClipControlEdit) {
            try { await onCancelClipControlEdit(sessionId) } catch { /* already stale */ }
          }
        }
      }
      try {
        for (const [clipId, value] of values) await commitOne(clipId, value)
      } finally {
        clearInteraction()
      }
    }

    const onWindowKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelDrag('escape')
      }
    }
    const onWindowBlur = () => cancelDrag('blur')

    clipControlCancelRef.current = cancelDrag
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
    window.addEventListener('keydown', onWindowKeyDown)
    window.addEventListener('blur', onWindowBlur)
    return true
  }, [
    getLocalXY,
    onBeginClipControlEdit,
    onCancelClipControlEdit,
    onCommitClipControlEdit,
    onFocusTrack,
    onPreviewClipControlEdit,
    onSetClipFade,
    onSetClipVelocity,
    setSelectedClipIds,
  ])

  clipControlHandlersRef.current.hitTest = hitTestClipControl
  clipControlHandlersRef.current.beginDrag = beginClipControlDrag

  // ── Canvas content height tracks the number of tracks ──────────────────────

  const contentH = Math.max(trackLayout?.totalHeight ?? trackCount * TRACK_HEIGHT, 200)

  return (
    <div
      ref={containerRef}
      className="timeline-canvas-container"
      data-tool={activeTool}
      style={{ minHeight: contentH, cursor: isMiddlePanningState ? 'grabbing' : (clipControlCursorState || undefined) }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={onCanvasDragLeave}
    >
      <canvas ref={bgRef} className="timeline-canvas-layer" />
      <canvas ref={ctRef} className="timeline-canvas-layer" />
      <canvas ref={ovRef} className="timeline-canvas-layer" />
      {!isDraggingState && fxBadges.length > 0 && (
        <div
          className="timeline-fx-badge-layer"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 12,
          }}
        >
          {fxBadges.map((b) => (
            <button
              key={b.id}
              ref={(el) => {
                if (el) badgeElsRef.current.set(b.id, el)
                else badgeElsRef.current.delete(b.id)
              }}
              type="button"
              title="Quick FX"
              className="timeline-fx-badge"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                // transform is re-written per animator frame — see
                // repositionFxBadges; this is the settled placement. A
                // compositor-only property (unlike left/top) so per-frame
                // scroll/zoom updates skip layout+paint.
                transform: `translate(${Math.round(b.rect.x + b.rect.w - 28)}px, ${Math.round(b.rect.y + 3)}px)`,
                width: 24,
                height: 14,
                padding: '1px 4px',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                lineHeight: 1,
                textTransform: 'uppercase',
                border: '1px solid var(--theme-border-subtle, #444)',
                borderRadius: 999,
                background: 'var(--theme-surface-overlay, rgba(0,0,0,0.55))',
                color: 'var(--theme-semantic-info-text, var(--theme-text-secondary, #ddd))',
                cursor: 'pointer',
                pointerEvents: 'auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                onOpenClipFxQuickMenu(b.id, { x: r.left, y: r.bottom + 4 })
              }}
            >
              FX
            </button>
          ))}
        </div>
      )}
      <div
        ref={playheadLineRef}
        className="timeline-playhead-line"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${PLAYHEAD_LINE_WIDTH}px`,
          height: '100%',
          backgroundColor: 'var(--theme-timeline-playhead-line)',
          pointerEvents: 'none',
          zIndex: 10,
          willChange: 'transform',
          transform: 'translateX(-10px)',
        }}
      />
      {copiedTooltip && (
        <div
          className="timeline-copied-tooltip"
          style={{
            position: 'absolute',
            left: copiedTooltip.x - 25,
            top: copiedTooltip.y - 28,
            pointerEvents: 'none',
            zIndex: 20,
          }}
        >
          Copied!
        </div>
      )}
      {clipControlTooltip && (
        <div
          className="timeline-clip-control-tooltip"
          style={{
            position: 'absolute',
            left: clipControlTooltip.x + clipControlSpecRef.current.tooltip.offsetX,
            top: clipControlTooltip.y + clipControlSpecRef.current.tooltip.offsetY,
            pointerEvents: 'none',
            zIndex: 24,
          }}
        >
          {clipControlTooltip.text}
        </div>
      )}
      {renamingBlock && (
        <input
          autoFocus
          className="timeline-pattern-rename-input"
          defaultValue={renamingBlock.initial}
          style={{
            position: 'absolute',
            left: renamingBlock.x,
            top: renamingBlock.y,
            width: renamingBlock.w,
            height: renamingBlock.h,
            zIndex: 25,
          }}
          onBlur={(e) => commitPatternRename(renamingBlock.patternId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitPatternRename(renamingBlock.patternId, e.currentTarget.value)
            else if (e.key === 'Escape') setRenamingBlock(null)
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  )
})

export default TimelineCanvas

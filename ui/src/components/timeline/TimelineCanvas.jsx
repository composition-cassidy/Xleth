import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback, useMemo } from 'react'
import { drawGrid, drawClips, drawDropPreview, drawPatternBlocks, drawWorldSpinners, resolveTimelinePalette } from './timelineDrawing.js'
import { buildResolvedTrackColorMap } from './trackColorResolver.js'
import useWorldProcessingStore from '../../stores/worldProcessingStore.js'
import { TRACK_HEIGHT, PPQ, pixelToBeat, beatToPixel } from '../../constants/timeline.js'
import { getClipRect, clipHasFxIntent } from './clipGeometry.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { timelineEvents } from '../../timelineEvents.js'
import { createSelectTool } from './tools/selectTool.js'
import { createPencilTool } from './tools/pencilTool.js'
import { createSplitTool } from './tools/splitTool.js'
import { createDeleteTool } from './tools/deleteTool.js'

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
    onCreatePatternBlock, onMovePatternBlock, onResizePatternBlock, onResizePatternBlockLeft, onDeletePatternBlock, onSplitPatternBlock,
    onOpenPianoRoll,
    // Tool system props
    activeTool, stickyNoteLength, setStickyNoteLength, activeSampleId, snapGranularity,
    onCreateClip, onDeleteClip, onMoveClip, onResizeClip, onResizeClipLeft,
    onStretchClip, onStretchClipLeft,
    onSplitClip,
    onRequestClipContextMenu,
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
  },
  ref
) {
  const containerRef = useRef(null)
  const bgRef = useRef(null)   // background (grid)
  const ctRef = useRef(null)   // content (clips)
  const ovRef = useRef(null)   // overlay (drop preview + tool overlay)
  const playheadLineRef = useRef(null) // DOM playhead element
  const sizeRef = useRef({ w: 0, h: 0 })

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

  // FXG.4-h-r1: hold the derived row layout in a ref so the canvas hot draw
  // path + tools read the current track/lane geometry without re-creating tools.
  const trackLayoutRef = useRef(trackLayout)
  trackLayoutRef.current = trackLayout

  clipsRef.current = clips
  regionsRef.current = regions
  tracksRef.current = tracks
  selectedRef.current = selectedClipIds

  // ── WORLD spinner state ───────────────────────────────────────────────────
  const worldProcessingClips    = useWorldProcessingStore(s => s.worldProcessingClips)
  const worldProcessingClipsRef = useRef(worldProcessingClips)
  worldProcessingClipsRef.current = worldProcessingClips
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

  // ── Tool instance ref ────────────────────────────────────────────────────
  const toolRef = useRef(null)
  const isDraggingRef = useRef(false)
  // Mirror of isDraggingRef into React state — drives FX badge layer hide
  // during drag/resize without touching the canvas hot path.
  const [isDraggingState, setIsDraggingState] = useState(false)

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

  // ── Track ID → index map ──────────────────────────────────────────────────
  // buildTrackIdToIndex() is kept for use outside the spinner hot path.
  // trackIdToIndexRef is rebuilt via useEffect on tracks changes so the 60fps
  // rAF spinner loop never allocates a new object per tick.

  function buildTrackIdToIndex() {
    const map = {}
    const t = tracksRef.current
    if (t) for (let i = 0; i < t.length; i++) map[t[i].id] = i
    return map
  }

  // ── Drawing wrappers ───────────────────────────────────────────────────────

  function redrawGrid(reason) {
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const t0 = performance.now()
    const ctx = bgRef.current?.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const palette = resolveTimelinePalette()
    drawGrid(ctx, w, h, scrollOffsetRef.current, pixelsPerBeatRef.current, trackCount, tracksRef.current, palette, trackLayoutRef.current)
    const dt = performance.now() - t0
    if (dt > 16) console.warn(`[Timeline] WARNING grid redraw took ${dt.toFixed(1)}ms (reason: ${reason})`)
  }

  function redrawContent(reason) {
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const ctx = ctRef.current?.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const mutedTrackIds = new Set(
      (tracksRef.current || []).filter((t) => t.muted).map((t) => t.id)
    )
    const tidx = trackIdToIndexRef.current
    const palette = resolveTimelinePalette()
    const trackColorById = buildResolvedTrackColorMap(tracksRef.current, palette.trackPalette)
    drawClips(
      ctx, w, h,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      clipsRef.current, tidx, regionsRef.current,
      selectedRef.current, waveformCacheRef?.current, hiResCacheRef?.current, clipPeakCacheRef?.current, bpmRef?.current,
      mutedTrackIds, palette,
      timelineDisplaySettingsRef.current, trackColorById, trackLayoutRef.current
    )
    drawPatternBlocks(
      ctx, w, h,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      patternBlocksRef.current, tidx,
      patternsRef.current, regionsRef.current,
      selectedBlockIdsRef.current, mutedTrackIds, palette,
      timelineDisplaySettingsRef.current, trackColorById, trackLayoutRef.current
    )
    const wpc = worldProcessingClipsRef.current
    if (wpc?.size) {
      // Use palette-resolved accent rather than per-frame getComputedStyle.
      const accentColor = palette.accent || '#5b8aff'
      drawWorldSpinners(
        ctx, clipsRef.current, tidx, wpc,
        scrollOffsetRef.current, pixelsPerBeatRef.current,
        spinAngleRef.current, accentColor, trackLayoutRef.current
      )
    }
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
  }

  // ── Position the DOM playhead element ─────────────────────────────────────

  function positionPlayhead(beat) {
    const el = playheadLineRef.current
    if (!el) return
    const px = (beat - scrollOffsetRef.current) * pixelsPerBeatRef.current
    const w = sizeRef.current.w || 9999
    if (px >= -2 && px <= w) {
      el.style.transform = `translateX(${px}px)`
      el.style.opacity = '1'
    } else {
      el.style.opacity = '0'
    }
  }

  // Expose to parent
  useImperativeHandle(ref, () => ({ redrawGrid, redrawContent, redrawOverlay, positionPlayhead }), [trackCount])

  // ── Tool creation ─────────────────────────────────────────────────────────

  useEffect(() => {
    const toolDeps = {
      clipsRef, tracksRef, regionsRef, selectedRef,
      pixelsPerBeatRef, scrollOffsetRef, bpmRef,
      activeSampleIdRef, stickyNoteLengthRef, pencilTemplateRef,
      snapGranularityRef, trackLayoutRef,
      onCreateClip, onDeleteClip, onMoveClip, onResizeClip, onResizeClipLeft,
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
      onCreatePatternBlock, onMovePatternBlock, onResizePatternBlock, onResizePatternBlockLeft,
      onDeletePatternBlock, onSplitPatternBlock,
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
    if (rw === sizeRef.current.w && rh === sizeRef.current.h) return
    sizeRef.current = { w: rw, h: rh }
    const dpr = window.devicePixelRatio || 1

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

    const observer = new ResizeObserver(() => sizeAndDraw(container, 'resize'))
    observer.observe(container)
    return () => { clearTimeout(timerId); observer.disconnect() }
  }, [trackCount])

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
    const map = {}
    const t = tracksRef.current
    if (t) for (let i = 0; i < t.length; i++) map[t[i].id] = i
    trackIdToIndexRef.current = map
  }, [tracks])

  // ── Redraw when the row layout changes (macro lane add/remove/visibility) ──
  // The container's minHeight tracks totalHeight, but a visibility toggle that
  // leaves height unchanged still shifts track tops, so force a grid+content
  // repaint on any layout identity change.
  useEffect(() => {
    redrawGrid('track-layout')
    redrawContent('track-layout')
  }, [trackLayout])

  // ── WORLD spinner rAF loop ────────────────────────────────────────────────
  // Runs at ~60fps only while at least one clip is being WORLD-processed.

  useEffect(() => {
    if (worldProcessingClips.size === 0) {
      if (spinRafRef.current) {
        cancelAnimationFrame(spinRafRef.current)
        spinRafRef.current = null
        redrawContent('spinner-stop')
      }
      return
    }
    function tick() {
      spinAngleRef.current = (spinAngleRef.current + 0.08) % (Math.PI * 2)
      redrawContent('spinner-tick')
      spinRafRef.current = requestAnimationFrame(tick)
    }
    if (!spinRafRef.current) spinRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (spinRafRef.current) { cancelAnimationFrame(spinRafRef.current); spinRafRef.current = null }
    }
  }, [worldProcessingClips])

  // ── PlayheadClock 60fps playhead animation (DOM element, GPU-composited) ──

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs, bpm) => {
      const beat = posMs * bpm / 60000
      playheadBeatRef.current = beat
      positionPlayhead(beat)
    })
    return unsub
  }, [])

  // ── Event helpers: compute local coordinates ──────────────────────────────

  const getLocalXY = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  // FXG.4-h-r1: resolve a local Y to a track index through the row layout so
  // macro automation lane bands map to their parent track (clips never land on a
  // lane). Falls back to contiguous geometry when no layout is present.
  const trackIndexAtLocalY = useCallback((localY) => {
    const layout = trackLayoutRef.current
    if (layout && typeof layout.trackIndexAtY === 'function') return layout.trackIndexAtY(localY)
    return Math.floor(localY / TRACK_HEIGHT)
  }, [])
  const trackTopOf = useCallback((trackIndex) => {
    const layout = trackLayoutRef.current
    if (layout && typeof layout.trackTop === 'function') return layout.trackTop(trackIndex)
    return trackIndex * TRACK_HEIGHT
  }, [])

  // ── Mouse event handlers (dispatched to active tool) ──────────────────────

  const handleMouseDown = useCallback((e) => {
    const pos = getLocalXY(e)
    if (!pos) return

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

    // ── Middle-click: quick copy clip as pencil template ──────────────────
    if (e.button === 1) {
      e.preventDefault() // prevent browser auto-scroll
      const beat = pixelToBeat(pos.localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = trackIndexAtLocalY(pos.localY)
      const clips = clipsRef.current
      const tks = tracksRef.current
      if (!clips || !tks || trackIndex < 0 || trackIndex >= tks.length) return

      // Hit-test (same pattern as tools)
      let hitClip = null
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i]
        const clipBeat = clip.positionTicks / PPQ
        const clipEnd = clipBeat + clip.durationTicks / PPQ
        const clipTrackIdx = tks.findIndex(t => t.id === clip.trackId)
        if (beat >= clipBeat && beat < clipEnd && trackIndex === clipTrackIdx) {
          hitClip = clip
          break
        }
      }

      if (hitClip && onSetPencilTemplate) {
        const region = regionsRef.current?.[hitClip.regionId]
        onSetPencilTemplate({
          regionId: hitClip.regionId,
          regionOffsetTicks: hitClip.regionOffsetTicks ?? 0,
          durationTicks: hitClip.durationTicks,
          velocity: hitClip.velocity ?? 1.0,
          pitchOffset: hitClip.pitchOffset ?? 0,
          syllableIndex: hitClip.syllableIndex ?? -1,
          displayName: region?.name || '?',
          label: region?.label,
        })
        showCopiedTooltip(pos.localX, pos.localY)
      }
      return // don't pass to active tool
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
      // Redraw overlay after drag ends (cursor is CSS-owned via data-tool attribute)
      redrawOverlay()
    }
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
  }, [getLocalXY, onSetPencilTemplate, onFocusTrack])

  const handleMouseMove = useCallback((e) => {
    // Only handle hover (non-dragging) moves here; dragging is captured on window
    if (isDraggingRef.current) return
    const pos = getLocalXY(e)
    if (!pos) return
    toolRef.current?.onMouseMove(pos.localX, pos.localY, e)
  }, [getLocalXY])

  const handleDoubleClick = useCallback((e) => {
    const pos = getLocalXY(e)
    if (!pos) return
    const beat = pixelToBeat(pos.localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const trackIndex = trackIndexAtLocalY(pos.localY)
    const tks = tracksRef.current
    const blocks = patternBlocksRef.current
    if (!tks || !blocks || trackIndex < 0 || trackIndex >= tks.length) return
    const trackId = tks[trackIndex].id
    // Hit-test PatternBlocks on this track
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (b.trackId !== trackId) continue
      const bBeat = b.positionTicks / PPQ
      const bEnd = bBeat + b.durationTicks / PPQ
      if (beat >= bBeat && beat < bEnd) {
        // If the double-click lands in the name-label strip at the top of the
        // block, start an inline rename instead of opening the Piano Roll.
        const bStartPx = beatToPixel(bBeat, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const bEndPx   = beatToPixel(bEnd,  scrollOffsetRef.current, pixelsPerBeatRef.current)
        const blockY   = trackTopOf(trackIndex)
        const labelX1  = bStartPx + 6
        const labelX2  = bEndPx - 6
        const labelY1  = blockY + 3
        const labelY2  = blockY + 18
        const inLabel  = pos.localX >= labelX1 && pos.localX <= labelX2
                      && pos.localY >= labelY1 && pos.localY <= labelY2
        if (inLabel && labelX2 > labelX1 + 20) {
          setRenamingBlock({
            patternId: b.patternId,
            x: labelX1,
            y: blockY + 2,
            w: Math.max(60, labelX2 - labelX1),
            h: 18,
            initial: patternsRef.current?.[b.patternId]?.name ?? `Pattern ${b.patternId}`,
          })
          return
        }
        onOpenPianoRoll?.(b.patternId, b.id)
        return
      }
    }
  }, [getLocalXY, onOpenPianoRoll])

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
    const trackIdToIndex = {}
    for (let i = 0; i < tracks.length; i++) trackIdToIndex[tracks[i].id] = i
    const out = []
    for (const clip of clips) {
      if (!clipHasFxIntent(clip)) continue
      const rect = getClipRect(clip, trackIdToIndex, scrollOffset, pixelsPerBeat, trackLayout)
      if (!rect) continue
      if (rect.w < 56) continue
      out.push({ id: clip.id, rect })
    }
    return out
  }, [clips, tracks, scrollOffset, pixelsPerBeat, onOpenClipFxQuickMenu, trackLayout])

  // ── Canvas content height tracks the number of tracks ──────────────────────

  const contentH = Math.max(trackLayout?.totalHeight ?? trackCount * TRACK_HEIGHT, 200)

  return (
    <div
      ref={containerRef}
      className="timeline-canvas-container"
      data-tool={activeTool}
      style={{ minHeight: contentH }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
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
              type="button"
              title="Quick FX"
              className="timeline-fx-badge"
              style={{
                position: 'absolute',
                left: Math.round(b.rect.x + b.rect.w - 28),
                top:  Math.round(b.rect.y + 3),
                width: 24,
                height: 14,
                padding: '1px 6px',
                fontSize: 9,
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
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '2px',
          height: '100%',
          backgroundColor: 'var(--theme-border-focus)',
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

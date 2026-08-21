import {
  TRACK_HEIGHT, PPQ, pixelToBeat, beatToPixel, snapBeatToGrid, beatsToTicks,
  MIN_DURATION_TICKS_FREE,
} from '../../../constants/timeline.js'
import { labelHexColor } from '../../../constants/labels.js'
import { tokenValue } from '../../../theming/tokenValue.ts'
import { uiCanvasFont } from '../../../styles/typography.js'
import { drawRubberBand, drawMovePreview } from '../timelineDrawing.js'
import { getRegionPlaybackDurationSec } from '../regionDuration.js'
import {
  sourceTicksForTimelineTicks,
  timelineTicksForSourceTicks,
} from '../clipSourceDomain.js'
import {
  AUTOMATION_MIN_DURATION_TICKS,
  AUTOMATION_RESIZE_HIT_WIDTH_PX,
  isOnAutomationClipLeftEdge,
  isOnAutomationClipRightEdge,
} from '../automationLaneGeometry.js'

const HANDLE_W = 6   // Resize handle hit-test width (slightly wider than visual 4px)
const MIN_DURATION_TICKS = 120  // 1/32 note
const DRAG_THRESHOLD = 3  // px before drag starts

/**
 * Select tool — click to select, drag to move/resize, rubber-band select.
 * Handles both Clips and PatternBlocks (pattern blocks on Pattern tracks).
 */
export function createSelectTool(deps) {
  const {
    clipsRef, tracksRef, regionsRef, selectedRef,
    pixelsPerBeatRef, scrollOffsetRef, bpmRef,
    onMoveClips, onDuplicateClips, onResizeClip, onResizeClipLeft,
    onStretchClip, onStretchClipLeft,
    setSelectedClipIds, setStickyNoteLength,
    onRequestClipContextMenu,
    redrawOverlay,
    containerRef,
    snapGranularityRef,
    // Pattern block deps
    patternBlocksRef, patternsRef, selectedBlockIdsRef,
    setSelectedBlockIds,
    onMovePatternBlocks, onDuplicatePatternBlocks, onResizePatternBlock, onResizePatternBlockLeft,
    onRequestPatternBlockContextMenu,
    // FXG.4-h-r1: derived row layout so macro automation child lanes shift the
    // track-index↔Y mapping. Optional — falls back to contiguous geometry.
    trackLayoutRef,
    allowUnselectedEdgeResize = false,
    // Automation clip deps (Phase B) — clips live on lane rows resolved via
    // trackLayoutRef.automationLaneRowAtY, not on a track index.
    automationClipsRef, selectedAutomationClipIdsRef, setSelectedAutomationClipIds,
    onMoveAutomationClip, onResizeAutomationClip, onResizeAutomationClipLeft,
    onRequestAutomationClipContextMenu,
  } = deps

  // Resolve a Y coordinate to a track index (lane bands map to their parent
  // track) and a track index back to its Y top, via the row layout when present.
  function idxAtY(y) {
    const layout = trackLayoutRef?.current
    if (layout && typeof layout.trackIndexAtY === 'function') return layout.trackIndexAtY(y)
    return Math.floor(y / TRACK_HEIGHT)
  }
  function topOf(trackIndex) {
    const layout = trackLayoutRef?.current
    if (layout && typeof layout.trackTop === 'function') return layout.trackTop(trackIndex)
    return trackIndex * TRACK_HEIGHT
  }

  // Helper: toggle cursor-state classes on the container (CSS does the rest)
  function setDragClass(name) {
    const el = containerRef?.current
    if (!el) return
    el.classList.remove('dragging', 'duplicating', 'rubber-banding', 'resizing-right', 'resizing-left', 'stretching-right', 'stretching-left')
    if (name) el.classList.add(name)
  }
  function setHoverEdge(edge) {
    const el = containerRef?.current
    if (!el) return
    el.classList.remove('resizing-right', 'resizing-left', 'stretching-right', 'stretching-left')
    if (edge === 'right') el.classList.add(lastModifiers.shift ? 'stretching-right' : 'resizing-right')
    else if (edge === 'left') el.classList.add(lastModifiers.shift ? 'stretching-left' : 'resizing-left')
  }

  // Drag state
  let dragKind = null  // null | 'clip' | 'block'
  let dragMode = null  // null | 'pending' | 'move' | 'duplicate' | 'resize' | 'resize-left' | 'rubberband'
  let dragCancelled = false
  let lastModifiers = {}
  let dragOriginX = 0, dragOriginY = 0
  let dragCurrentX = 0, dragCurrentY = 0
  // Clip drag state
  let dragClip = null
  let dragClipOrigBeat = 0
  let dragClipOrigTrackIdx = 0
  let dragClipOrigDuration = 0
  let dragClipOrigOffset = 0
  let dragClipOrigMaxDuration = Number.MAX_SAFE_INTEGER
  let dragClipOrigStretchRatio = 1.0
  // Block drag state
  let dragBlock = null
  let dragBlockOrigBeat = 0
  let dragBlockOrigTrackIdx = 0
  let dragBlockOrigDuration = 0
  let dragBlockOrigOffset = 0
  // Automation clip drag state — lane-addressed, not track-addressed.
  let dragAutomationClip = null
  let dragAutomationClipOrigPosition = 0
  let dragAutomationClipOrigDuration = 0
  let dragAutomationClipOrigOffset = 0
  let dragAutomationClipOrigLaneId = null
  let dragAutomationClipOwnerTrackId = null
  let dragSelectedAutomationClips = [] // [{ clip, origPosition, origLaneId }]
  let pendingHit = null  // { clip?, block?, automationClip?, empty?, isRightEdge, isLeftEdge, e }
  // Multi-select drag state
  let dragSelectedClips = []   // [{ clip, origBeat, origTrackIdx }]
  let dragSelectedBlocks = []  // [{ block, origBeat, origTrackIdx }]
  // Shift-click range-select anchor — the last plain/ctrl-clicked item's
  // track+time extent, so a later shift-click can select everything between
  // it and the new target (horizontally on one track, or across a block of
  // tracks above/below/diagonally). Mirrors trackSelectionAnchorRef's role
  // for track-header range selection (see updateTrackSelection).
  let selectionAnchor = null  // { trackIndex, startTicks, endTicks }

  function resetDragState({ cancelled = false } = {}) {
    dragCancelled = cancelled
    dragMode = null
    dragKind = null
    pendingHit = null
    dragClip = null
    dragBlock = null
    dragAutomationClip = null
    dragSelectedClips = []
    dragSelectedBlocks = []
    dragSelectedAutomationClips = []
    setDragClass(null)
    redrawOverlay()
  }

  function getDragDelta() {
    const tracks = tracksRef.current || []
    const beatDelta = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      - pixelToBeat(dragOriginX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const newTrackIndex = idxAtY(dragCurrentY)
    const validTarget = newTrackIndex >= 0 && newTrackIndex < tracks.length
    const clampedTrackIdx = Math.max(0, Math.min(newTrackIndex, tracks.length - 1))
    const anchorTrackIdx = dragKind === 'block' ? dragBlockOrigTrackIdx : dragClipOrigTrackIdx
    const requestedTrackDelta = clampedTrackIdx - anchorTrackIdx
    const clipItems = dragSelectedClips.length > 0
      ? dragSelectedClips
      : dragClip
        ? [{ origTrackIdx: dragClipOrigTrackIdx }]
        : []
    const blockItems = dragSelectedBlocks.length > 0
      ? dragSelectedBlocks
      : dragBlock
        ? [{ origTrackIdx: dragBlockOrigTrackIdx }]
        : []
    const destinationTypesMatch = clipItems.every(({ origTrackIdx }) => {
      const target = tracks[origTrackIdx + requestedTrackDelta]
      return target && target.type !== 'Pattern'
    }) && blockItems.every(({ origTrackIdx }) => {
      const target = tracks[origTrackIdx + requestedTrackDelta]
      return target?.type === 'Pattern'
    })
    return {
      tracks,
      beatDelta,
      trackDelta: destinationTypesMatch ? requestedTrackDelta : 0,
      validTarget,
    }
  }

  function getClipDragPlacements(modifiers) {
    const items = dragSelectedClips.length > 0
      ? dragSelectedClips
      : dragClip
        ? [{ clip: dragClip, origBeat: dragClipOrigBeat, origTrackIdx: dragClipOrigTrackIdx }]
        : []
    if (items.length === 0) return []
    const { tracks, beatDelta, trackDelta, validTarget } = getDragDelta()
    if (!validTarget) return []

    return items.map(({ clip, origBeat, origTrackIdx }) => {
      const positionTicks = beatsToTicks(snapBeatToGrid(
        Math.max(0, origBeat + beatDelta),
        modifiers,
        snapGranularityRef?.current,
      ))
      const proposedTrackIdx = Math.max(0, Math.min(origTrackIdx + trackDelta, tracks.length - 1))
      const proposedTrack = tracks[proposedTrackIdx]
      const trackIndex = proposedTrack?.type === 'Pattern' ? origTrackIdx : proposedTrackIdx
      return {
        clip,
        positionTicks,
        trackId: tracks[trackIndex]?.id ?? clip.trackId,
        trackIndex,
      }
    })
  }

  function getBlockDragPlacements(modifiers) {
    const items = dragSelectedBlocks.length > 0
      ? dragSelectedBlocks
      : dragBlock
        ? [{ block: dragBlock, origBeat: dragBlockOrigBeat, origTrackIdx: dragBlockOrigTrackIdx }]
        : []
    if (items.length === 0) return []
    const { tracks, beatDelta, trackDelta, validTarget } = getDragDelta()
    if (!validTarget) return []

    return items.map(({ block, origBeat, origTrackIdx }) => {
      const positionTicks = beatsToTicks(snapBeatToGrid(
        Math.max(0, origBeat + beatDelta),
        modifiers,
        snapGranularityRef?.current,
      ))
      const proposedTrackIdx = Math.max(0, Math.min(origTrackIdx + trackDelta, tracks.length - 1))
      const proposedTrack = tracks[proposedTrackIdx]
      const trackIndex = proposedTrack?.type === 'Pattern' ? proposedTrackIdx : origTrackIdx
      return {
        block,
        positionTicks,
        trackId: tracks[trackIndex]?.id ?? block.trackId,
        trackIndex,
      }
    })
  }

  // Compute the max duration the clip can have given its region + current offset.
  function computeRegionDurTicks(clip) {
    const region = regionsRef.current?.[clip.regionId]
    const bpm = bpmRef?.current
    if (!region || !bpm) return Number.MAX_SAFE_INTEGER
    // Swap-aware: extends past video range when swapped audio is longer.
    const durSec = getRegionPlaybackDurationSec(region)
    if (durSec <= 0) return Number.MAX_SAFE_INTEGER
    return Math.round(durSec * (bpm / 60) * PPQ)
  }

  function hitTestClip(beat, trackIndex) {
    const clips = clipsRef.current
    const tracks = tracksRef.current
    if (!clips || !tracks) return null
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      const clipBeat = clip.positionTicks / PPQ
      const clipEnd = clipBeat + clip.durationTicks / PPQ
      const clipTrackIdx = tracks.findIndex((t) => t.id === clip.trackId)
      if (beat >= clipBeat && beat < clipEnd && trackIndex === clipTrackIdx) return clip
    }
    return null
  }

  function hitTestPatternBlock(beat, trackIndex) {
    const blocks = patternBlocksRef?.current
    const tracks = tracksRef.current
    if (!blocks || !tracks) return null
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const bBeat = b.positionTicks / PPQ
      const bEnd = bBeat + b.durationTicks / PPQ
      const bTrackIdx = tracks.findIndex((t) => t.id === b.trackId)
      if (beat >= bBeat && beat < bEnd && trackIndex === bTrackIdx) return b
    }
    return null
  }

  function hitTestAutomationClip(tick, laneId) {
    const clips = automationClipsRef?.current
    if (!clips || laneId == null) return null
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      if (clip.laneId !== laneId) continue
      if (tick >= clip.positionTicks && tick < clip.positionTicks + clip.durationTicks) return clip
    }
    return null
  }

  function isOnRightEdgeOf(localX, startTicks, durTicks) {
    const ppb = pixelsPerBeatRef.current
    const scrollOffset = scrollOffsetRef.current
    const endBeat = (startTicks + durTicks) / PPQ
    const rightEdgePx = beatToPixel(endBeat, scrollOffset, ppb)
    return Math.abs(localX - rightEdgePx) <= HANDLE_W
  }
  function isOnLeftEdgeOf(localX, startTicks) {
    const ppb = pixelsPerBeatRef.current
    const scrollOffset = scrollOffsetRef.current
    const startBeat = startTicks / PPQ
    const leftEdgePx = beatToPixel(startBeat, scrollOffset, ppb)
    return Math.abs(localX - leftEdgePx) <= HANDLE_W
  }

  function updateEdgeHover(localX, localY) {
    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const trackIndex = idxAtY(localY)
    const tracks = tracksRef.current
    const track = tracks?.[trackIndex]
    if (track?.type === 'Pattern') {
      const hitBlock = hitTestPatternBlock(beat, trackIndex)
      if (hitBlock && (allowUnselectedEdgeResize || selectedBlockIdsRef?.current?.has(hitBlock.id))) {
        if (isOnRightEdgeOf(localX, hitBlock.positionTicks, hitBlock.durationTicks)) {
          setHoverEdge('right'); return
        }
        if (isOnLeftEdgeOf(localX, hitBlock.positionTicks)) {
          setHoverEdge('left'); return
        }
      }
      setHoverEdge(null)
      return
    }
    const hitClip = hitTestClip(beat, trackIndex)
    if (hitClip && (allowUnselectedEdgeResize || selectedRef.current.has(hitClip.id))) {
      if (isOnRightEdgeOf(localX, hitClip.positionTicks, hitClip.durationTicks)) { setHoverEdge('right'); return }
      if (isOnLeftEdgeOf(localX, hitClip.positionTicks))  { setHoverEdge('left');  return }
    }
    setHoverEdge(null)
  }

  // Track+time extent of a clicked clip/block, or of a bare click point when
  // nothing was hit — the unit selectionAnchor and range-select deal in.
  function clipExtent(clip) {
    return {
      trackIndex: tracksRef.current.findIndex((t) => t.id === clip.trackId),
      startTicks: clip.positionTicks,
      endTicks: clip.positionTicks + clip.durationTicks,
    }
  }
  function blockExtent(block) {
    return {
      trackIndex: tracksRef.current.findIndex((t) => t.id === block.trackId),
      startTicks: block.positionTicks,
      endTicks: block.positionTicks + block.durationTicks,
    }
  }

  // Selects every clip and pattern block whose track falls between the
  // anchor's and target's track rows (inclusive, any order — so above,
  // below, or diagonal all work) and whose time range overlaps the span
  // between the two extents' ticks.
  function selectRange(anchor, target) {
    const trackLo = Math.min(anchor.trackIndex, target.trackIndex)
    const trackHi = Math.max(anchor.trackIndex, target.trackIndex)
    const startTicks = Math.min(anchor.startTicks, target.startTicks)
    const endTicks = Math.max(anchor.endTicks, target.endTicks)
    const tracks = tracksRef.current

    // Clips/blocks are half-open [position, position+duration) spans, and
    // packed patterns commonly butt one clip's end exactly against the next
    // one's start — an inclusive <=/>= test would count that merely-touching
    // neighbor as overlapping and grab one extra item past the target.
    const clipIds = new Set()
    for (const clip of clipsRef.current || []) {
      const idx = tracks.findIndex((t) => t.id === clip.trackId)
      if (idx < trackLo || idx > trackHi) continue
      const clipEnd = clip.positionTicks + clip.durationTicks
      if (clipEnd > startTicks && clip.positionTicks < endTicks) clipIds.add(clip.id)
    }
    const blockIds = new Set()
    for (const block of patternBlocksRef?.current || []) {
      const idx = tracks.findIndex((t) => t.id === block.trackId)
      if (idx < trackLo || idx > trackHi) continue
      const blockEnd = block.positionTicks + block.durationTicks
      if (blockEnd > startTicks && block.positionTicks < endTicks) blockIds.add(block.id)
    }
    return { clipIds, blockIds }
  }

  return {
    onMouseDown(localX, localY, e) {
      if (e.button !== 0) return
      dragCancelled = false
      lastModifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }

      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]

      dragOriginX = localX
      dragOriginY = localY
      dragCurrentX = localX
      dragCurrentY = localY

      // Automation lane branch — resolved independently of track index, since
      // a lane row lives in its own band (possibly several per track, or under
      // the pinned Master group where there is no real track at all).
      const automationLaneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(localY)
      if (automationLaneRow) {
        const tick = beatsToTicks(beat)
        const hitAutoClip = hitTestAutomationClip(tick, automationLaneRow.laneId)
        if (hitAutoClip) {
          const canResizeEdge = allowUnselectedEdgeResize || selectedAutomationClipIdsRef?.current?.has(hitAutoClip.id)
          const isRightEdge = canResizeEdge
            && isOnAutomationClipRightEdge(localX, hitAutoClip.positionTicks, hitAutoClip.durationTicks, pixelsPerBeatRef.current, scrollOffsetRef.current)
          const isLeftEdge = !isRightEdge && canResizeEdge
            && isOnAutomationClipLeftEdge(localX, hitAutoClip.positionTicks, pixelsPerBeatRef.current, scrollOffsetRef.current)
          pendingHit = { automationClip: hitAutoClip, laneRow: automationLaneRow, isRightEdge, isLeftEdge, e }
          dragKind = 'automation'
          dragAutomationClip = hitAutoClip
          dragAutomationClipOrigPosition = hitAutoClip.positionTicks
          dragAutomationClipOrigDuration = hitAutoClip.durationTicks
          dragAutomationClipOrigOffset = hitAutoClip.offsetTicks ?? 0
          dragAutomationClipOrigLaneId = hitAutoClip.laneId
          dragAutomationClipOwnerTrackId = automationLaneRow.ownerTrackId
          if (selectedAutomationClipIdsRef?.current?.has(hitAutoClip.id) && selectedAutomationClipIdsRef.current.size > 1) {
            dragSelectedAutomationClips = (automationClipsRef.current || [])
              .filter((c) => selectedAutomationClipIdsRef.current.has(c.id))
              .map((c) => ({ clip: c, origPosition: c.positionTicks, origLaneId: c.laneId }))
          } else {
            dragSelectedAutomationClips = []
          }
          dragMode = 'pending'
          return
        }
        dragKind = null
        dragMode = 'pending'
        pendingHit = { emptyAutomation: true, laneRow: automationLaneRow, e }
        return
      }

      // Pattern-track branch: hit-test pattern blocks first
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(beat, trackIndex)
        if (hitBlock) {
          const canResizeEdge = allowUnselectedEdgeResize || selectedBlockIdsRef?.current?.has(hitBlock.id)
          const isRightEdge = canResizeEdge
            && isOnRightEdgeOf(localX, hitBlock.positionTicks, hitBlock.durationTicks)
          const isLeftEdge = !isRightEdge && canResizeEdge
            && isOnLeftEdgeOf(localX, hitBlock.positionTicks)
          pendingHit = { block: hitBlock, isRightEdge, isLeftEdge, e }
          dragKind = 'block'
          dragBlock = hitBlock
          dragBlockOrigBeat = hitBlock.positionTicks / PPQ
          dragBlockOrigTrackIdx = trackIndex
          dragBlockOrigDuration = hitBlock.durationTicks
          dragBlockOrigOffset = hitBlock.offsetTicks ?? 0
          // Capture multi-selection if this block is already selected
          if (selectedBlockIdsRef?.current?.has(hitBlock.id) && selectedBlockIdsRef.current.size > 1) {
            const trks = tracksRef.current
            dragSelectedBlocks = (patternBlocksRef.current || [])
              .filter((b) => selectedBlockIdsRef.current.has(b.id))
              .map((b) => ({
                block: b,
                origBeat: b.positionTicks / PPQ,
                origTrackIdx: trks.findIndex((t) => t.id === b.trackId),
              }))
          } else {
            dragSelectedBlocks = []
          }
          if (selectedBlockIdsRef?.current?.has(hitBlock.id) && selectedRef.current.size > 0) {
            const trks = tracksRef.current
            dragSelectedClips = clipsRef.current
              .filter((c) => selectedRef.current.has(c.id))
              .map((c) => ({
                clip: c,
                origBeat: c.positionTicks / PPQ,
                origTrackIdx: trks.findIndex((t) => t.id === c.trackId),
              }))
          } else {
            dragSelectedClips = []
          }
          dragMode = 'pending'
          return
        }
        // Empty pattern-track space → rubber-band (or shift range-select target)
        dragKind = null
        dragMode = 'pending'
        pendingHit = { empty: true, trackIndex, positionTicks: beatsToTicks(beat), e }
        return
      }

      const hitClip = hitTestClip(beat, trackIndex)

      if (hitClip) {
        const canResizeEdge = allowUnselectedEdgeResize || selectedRef.current.has(hitClip.id)
        const isRightEdge = canResizeEdge
          && isOnRightEdgeOf(localX, hitClip.positionTicks, hitClip.durationTicks)
        const isLeftEdge = !isRightEdge && canResizeEdge
          && isOnLeftEdgeOf(localX, hitClip.positionTicks)
        pendingHit = { clip: hitClip, isRightEdge, isLeftEdge, e }
        dragKind = 'clip'
        dragClip = hitClip
        dragClipOrigBeat = hitClip.positionTicks / PPQ
        dragClipOrigTrackIdx = tracksRef.current.findIndex((t) => t.id === hitClip.trackId)
        dragClipOrigDuration = hitClip.durationTicks
        dragClipOrigOffset = hitClip.regionOffsetTicks ?? 0
        dragClipOrigStretchRatio = hitClip.stretchRatio ?? 1.0
        {
          // regionDurTicks and regionOffset are SOURCE ticks; the resize clamp is
          // a TIMELINE duration, so convert the remaining source budget through
          // the clip's stretchRatio (see clipSourceDomain.js). A 4× clip with
          // 1 bar of source left may legitimately stretch to 4 bars of timeline.
          const regionDurTicks = computeRegionDurTicks(hitClip)
          const sourceLeft = Math.max(0, regionDurTicks - dragClipOrigOffset)
          dragClipOrigMaxDuration = (regionDurTicks === Number.MAX_SAFE_INTEGER)
            ? Number.MAX_SAFE_INTEGER
            : timelineTicksForSourceTicks(sourceLeft, dragClipOrigStretchRatio)
        }
        // Capture multi-selection if this clip is already selected
        if (selectedRef.current.has(hitClip.id) && selectedRef.current.size > 1) {
          const trks = tracksRef.current
          dragSelectedClips = clipsRef.current
            .filter((c) => selectedRef.current.has(c.id))
            .map((c) => ({
              clip: c,
              origBeat: c.positionTicks / PPQ,
              origTrackIdx: trks.findIndex((t) => t.id === c.trackId),
            }))
        } else {
          dragSelectedClips = []
        }
        if (selectedRef.current.has(hitClip.id) && selectedBlockIdsRef?.current?.size > 0) {
          const trks = tracksRef.current
          dragSelectedBlocks = (patternBlocksRef.current || [])
            .filter((b) => selectedBlockIdsRef.current.has(b.id))
            .map((b) => ({
              block: b,
              origBeat: b.positionTicks / PPQ,
              origTrackIdx: trks.findIndex((t) => t.id === b.trackId),
            }))
        } else {
          dragSelectedBlocks = []
        }
        dragMode = 'pending'
      } else {
        dragKind = null
        dragMode = 'pending'
        pendingHit = { empty: true, trackIndex, positionTicks: beatsToTicks(beat), e }
        dragClip = null
      }
    },

    onMouseMove(localX, localY, e) {
      lastModifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }

      if (!dragMode) {
        updateEdgeHover(localX, localY)
        return
      }

      dragCurrentX = localX
      dragCurrentY = localY

      if (dragMode === 'pending') {
        const dx = Math.abs(localX - dragOriginX)
        const dy = Math.abs(localY - dragOriginY)
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return

        if (pendingHit?.automationClip) {
          const clip = pendingHit.automationClip
          if (pendingHit.isRightEdge) {
            dragMode = 'resize'
            setDragClass('resizing-right')
            if (!selectedAutomationClipIdsRef?.current?.has(clip.id)) {
              setSelectedAutomationClipIds?.(new Set([clip.id]))
            }
          } else if (pendingHit.isLeftEdge) {
            dragMode = 'resize-left'
            setDragClass('resizing-left')
            if (!selectedAutomationClipIdsRef?.current?.has(clip.id)) {
              setSelectedAutomationClipIds?.(new Set([clip.id]))
            }
          } else {
            dragMode = 'move'
            setDragClass('dragging')
            if (!selectedAutomationClipIdsRef?.current?.has(clip.id)) {
              if (pendingHit.e.ctrlKey || pendingHit.e.metaKey || pendingHit.e.shiftKey) {
                setSelectedAutomationClipIds?.((prev) => new Set([...prev, clip.id]))
              } else {
                setSelectedAutomationClipIds?.(new Set([clip.id]))
              }
            }
          }
        } else if (pendingHit?.block) {
          // Pattern-block drag
          if (pendingHit.isRightEdge) {
            dragMode = 'resize'
            setDragClass('resizing-right')
            if (!selectedBlockIdsRef?.current?.has(pendingHit.block.id)) {
              setSelectedBlockIds?.(new Set([pendingHit.block.id]))
            }
            console.log(`[SelectTool] Resize drag started on block ${pendingHit.block.id}`)
          } else if (pendingHit.isLeftEdge) {
            dragMode = 'resize-left'
            setDragClass('resizing-left')
            if (!selectedBlockIdsRef?.current?.has(pendingHit.block.id)) {
              setSelectedBlockIds?.(new Set([pendingHit.block.id]))
            }
            console.log(`[SelectTool] Left-resize drag started on block ${pendingHit.block.id}`)
          } else {
            dragMode = pendingHit.e.shiftKey ? 'duplicate' : 'move'
            setDragClass(dragMode === 'duplicate' ? 'duplicating' : 'dragging')
            if (!selectedBlockIdsRef?.current?.has(pendingHit.block.id)) {
              if (pendingHit.e.ctrlKey || pendingHit.e.metaKey || pendingHit.e.shiftKey) {
                setSelectedBlockIds?.((prev) => new Set([...prev, pendingHit.block.id]))
              } else {
                setSelectedBlockIds?.(new Set([pendingHit.block.id]))
              }
            }
            console.log(`[SelectTool] ${dragMode === 'duplicate' ? 'Duplicate' : 'Move'} drag started on block ${pendingHit.block.id}`)
          }
        } else if (pendingHit?.clip) {
          if (pendingHit.isRightEdge) {
            dragMode = 'resize'
            setDragClass('resizing-right')
            if (!selectedRef.current.has(pendingHit.clip.id)) {
              setSelectedClipIds(new Set([pendingHit.clip.id]))
            }
            console.log(`[SelectTool] Resize drag started on clip ${pendingHit.clip.id}`)
          } else if (pendingHit.isLeftEdge) {
            dragMode = 'resize-left'
            setDragClass('resizing-left')
            if (!selectedRef.current.has(pendingHit.clip.id)) {
              setSelectedClipIds(new Set([pendingHit.clip.id]))
            }
            console.log(`[SelectTool] Left-resize drag started on clip ${pendingHit.clip.id}`)
          } else {
            dragMode = pendingHit.e.shiftKey ? 'duplicate' : 'move'
            setDragClass(dragMode === 'duplicate' ? 'duplicating' : 'dragging')
            if (!selectedRef.current.has(pendingHit.clip.id)) {
              if (pendingHit.e.ctrlKey || pendingHit.e.metaKey || pendingHit.e.shiftKey) {
                setSelectedClipIds((prev) => new Set([...prev, pendingHit.clip.id]))
              } else {
                setSelectedClipIds(new Set([pendingHit.clip.id]))
              }
            }
            console.log(`[SelectTool] ${dragMode === 'duplicate' ? 'Duplicate' : 'Move'} drag started on clip ${pendingHit.clip.id}`)
          }
        } else {
          dragMode = 'rubberband'
          setDragClass('rubber-banding')
          console.log(`[SelectTool] Rubberband started`)
        }
      }

      if (dragMode === 'duplicate' && !e.shiftKey) {
        resetDragState({ cancelled: true })
        console.log('[SelectTool] Duplicate drag cancelled because Shift was released')
        return
      }

      // ── Clip resize live updates (trim) and stretch cursor ─────────────────
      if (dragMode === 'resize' && dragClip) {
        setDragClass(lastModifiers.shift ? 'stretching-right' : 'resizing-right')
        if (!lastModifiers.shift) {
          const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
          const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
          const clipStartBeat = dragClip.positionTicks / PPQ
          let newDurationTicks = beatsToTicks(Math.max(snappedEnd - clipStartBeat, 0))
          const minDur = lastModifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS
          if (newDurationTicks < minDur) newDurationTicks = minDur
          if (newDurationTicks > dragClipOrigMaxDuration) {
            newDurationTicks = Math.max(minDur, dragClipOrigMaxDuration)
          }
          if (newDurationTicks !== dragClipOrigDuration) {
            onResizeClip(dragClip.id, newDurationTicks)
            if (!lastModifiers.alt) setStickyNoteLength(newDurationTicks)
          }
        }
      }

      if (dragMode === 'resize-left' && dragClip) {
        setDragClass(lastModifiers.shift ? 'stretching-left' : 'resizing-left')
        if (!lastModifiers.shift) {
          const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
          const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
          const clipEndBeat = (dragClip.positionTicks + dragClip.durationTicks) / PPQ
          const minDur = lastModifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS
          // The existing offset is SOURCE ticks; how far left the edge may travel
          // is a TIMELINE distance, so scale it up by the ratio.
          const minStartTicks = dragClip.positionTicks
            - timelineTicksForSourceTicks(dragClipOrigOffset, dragClipOrigStretchRatio)
          const minStartBeat = Math.max(0, minStartTicks / PPQ)
          let newStartBeat = Math.min(snappedStart, clipEndBeat - minDur / PPQ)
          newStartBeat = Math.max(minStartBeat, newStartBeat)
          const newPositionTicks = beatsToTicks(newStartBeat)
          const newDurationTicks = (dragClip.positionTicks + dragClip.durationTicks) - newPositionTicks
          const positionDelta = newPositionTicks - dragClip.positionTicks
          // …and the timeline distance the edge moved becomes a SOURCE-domain
          // offset delta, so scale it back down. Trimming 1 bar off a 4× clip's
          // head skips only a quarter bar of source.
          const newRegionOffset = Math.max(0, dragClipOrigOffset
            + sourceTicksForTimelineTicks(positionDelta, dragClipOrigStretchRatio))
          if (newPositionTicks !== dragClip.positionTicks) {
            onResizeClipLeft(dragClip.id, newPositionTicks, newDurationTicks, newRegionOffset)
            if (!lastModifiers.alt) setStickyNoteLength(newDurationTicks)
          }
        }
      }

      redrawOverlay()
    },

    onMouseUp(localX, localY, e) {
      if (dragCancelled) {
        dragCancelled = false
        return
      }
      if (dragMode === 'pending' || !dragMode) {
        if (pendingHit?.automationClip) {
          const clip = pendingHit.automationClip
          const origE = pendingHit.e
          if (origE.ctrlKey || origE.metaKey) {
            setSelectedAutomationClipIds?.((prev) => {
              const next = new Set(prev)
              if (next.has(clip.id)) next.delete(clip.id); else next.add(clip.id)
              return next
            })
          } else {
            setSelectedAutomationClipIds?.(new Set([clip.id]))
          }
          console.log(`[SelectTool] Selected automation clip ${clip.id}`)
        } else if (pendingHit?.emptyAutomation) {
          if (selectedAutomationClipIdsRef?.current?.size > 0) {
            setSelectedAutomationClipIds?.(new Set())
          }
        } else if (pendingHit?.block) {
          const hitBlock = pendingHit.block
          const origE = pendingHit.e
          if (origE.ctrlKey || origE.metaKey) {
            setSelectedBlockIds?.((prev) => {
              const next = new Set(prev)
              if (next.has(hitBlock.id)) { next.delete(hitBlock.id) } else { next.add(hitBlock.id) }
              return next
            })
            selectionAnchor = blockExtent(hitBlock)
          } else if (origE.shiftKey && selectionAnchor) {
            const { clipIds, blockIds } = selectRange(selectionAnchor, blockExtent(hitBlock))
            setSelectedClipIds(clipIds)
            setSelectedBlockIds?.(blockIds)
            console.log(`[SelectTool] Range-selected ${clipIds.size} clip(s), ${blockIds.size} block(s) to block ${hitBlock.id}`)
          } else {
            setSelectedBlockIds?.(new Set([hitBlock.id]))
            setSelectedClipIds(new Set())
            selectionAnchor = blockExtent(hitBlock)
          }
          console.log(`[SelectTool] Selected block ${hitBlock.id}`)
        } else if (pendingHit?.clip) {
          const hitClip = pendingHit.clip
          const origE = pendingHit.e
          if (origE.ctrlKey || origE.metaKey) {
            setSelectedClipIds((prev) => {
              const next = new Set(prev)
              if (next.has(hitClip.id)) { next.delete(hitClip.id) } else { next.add(hitClip.id) }
              return next
            })
            selectionAnchor = clipExtent(hitClip)
          } else if (origE.shiftKey && selectionAnchor) {
            const { clipIds, blockIds } = selectRange(selectionAnchor, clipExtent(hitClip))
            setSelectedClipIds(clipIds)
            setSelectedBlockIds?.(blockIds)
            console.log(`[SelectTool] Range-selected ${clipIds.size} clip(s), ${blockIds.size} block(s) to clip ${hitClip.id}`)
          } else {
            setSelectedClipIds(new Set([hitClip.id]))
            setSelectedBlockIds?.(new Set())
            selectionAnchor = clipExtent(hitClip)
          }
          console.log(`[SelectTool] Selected clip ${hitClip.id}`)
        } else {
          const origE = pendingHit?.e
          if (origE?.shiftKey && pendingHit?.empty && selectionAnchor) {
            const target = {
              trackIndex: pendingHit.trackIndex,
              startTicks: pendingHit.positionTicks,
              endTicks: pendingHit.positionTicks,
            }
            const { clipIds, blockIds } = selectRange(selectionAnchor, target)
            setSelectedClipIds(clipIds)
            setSelectedBlockIds?.(blockIds)
            console.log(`[SelectTool] Range-selected ${clipIds.size} clip(s), ${blockIds.size} block(s) to empty point`)
          } else {
            if (selectedRef.current.size > 0) {
              setSelectedClipIds(new Set())
            }
            if (selectedBlockIdsRef?.current?.size > 0) {
              setSelectedBlockIds?.(new Set())
            }
            selectionAnchor = null
            console.log('[SelectTool] Deselected all')
          }
        }
        dragMode = null
        dragKind = null
        pendingHit = null
        dragClip = null
        dragBlock = null
        dragAutomationClip = null
        dragSelectedClips = []
        dragSelectedBlocks = []
        dragSelectedAutomationClips = []
        setDragClass(null)
        redrawOverlay()
        return
      }

      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }

      if (dragMode === 'duplicate') {
        if (modifiers.shift) {
          const clipPlacements = getClipDragPlacements(modifiers)
          const blockPlacements = getBlockDragPlacements(modifiers)
          if (clipPlacements.length > 0) onDuplicateClips?.(clipPlacements)
          if (blockPlacements.length > 0) onDuplicatePatternBlocks?.(blockPlacements)
          if (clipPlacements.length + blockPlacements.length > 0) {
            console.log(`[SelectTool] Duplicated ${clipPlacements.length} clip(s) and ${blockPlacements.length} pattern block(s) by drag`)
          }
        }
        resetDragState()
        return
      }

      // ── Automation clip move/resize commit (single commit here — no IPC
      // during drag, per the locked spec). ─────────────────────────────────
      if (dragMode === 'move' && dragAutomationClip) {
        const beatDelta = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
          - pixelToBeat(dragOriginX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const targetLaneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(dragCurrentY)
        const items = dragSelectedAutomationClips.length > 1
          ? dragSelectedAutomationClips
          : [{ clip: dragAutomationClip, origPosition: dragAutomationClipOrigPosition, origLaneId: dragAutomationClipOrigLaneId }]
        // Lane switching only applies to a single-clip drag, and only within
        // the origin clip's own group (same ownerTrackId) — cross-group moves
        // are refused by staying on the original lane.
        const allowLaneSwitch = items.length === 1
          && targetLaneRow && targetLaneRow.ownerTrackId === dragAutomationClipOwnerTrackId

        const moves = []
        for (const { clip, origPosition, origLaneId } of items) {
          const origBeat = origPosition / PPQ
          const newBeat = snapBeatToGrid(Math.max(0, origBeat + beatDelta), modifiers, snapGranularityRef?.current)
          const newPositionTicks = beatsToTicks(newBeat)
          const laneId = allowLaneSwitch ? targetLaneRow.laneId : origLaneId
          if (newPositionTicks !== clip.positionTicks || laneId !== clip.laneId) {
            moves.push({ clipId: clip.id, laneId, positionTicks: newPositionTicks })
          }
        }
        if (moves.length > 0) {
          onMoveAutomationClip?.(moves)
          console.log(`[SelectTool] Moved ${moves.length} automation clip(s)`)
        }
      }

      if (dragMode === 'resize' && dragAutomationClip) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), modifiers, snapGranularityRef?.current)
        const clipStartBeat = dragAutomationClipOrigPosition / PPQ
        let newDurationTicks = beatsToTicks(Math.max(snappedEnd - clipStartBeat, 0))
        if (newDurationTicks < AUTOMATION_MIN_DURATION_TICKS) newDurationTicks = AUTOMATION_MIN_DURATION_TICKS
        if (newDurationTicks !== dragAutomationClipOrigDuration) {
          onResizeAutomationClip?.(dragAutomationClip.id, newDurationTicks)
          console.log(`[SelectTool] Resized automation clip ${dragAutomationClip.id} to ${newDurationTicks}t`)
        }
      }

      if (dragMode === 'resize-left' && dragAutomationClip) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), modifiers, snapGranularityRef?.current)
        const clipEndBeat = (dragAutomationClipOrigPosition + dragAutomationClipOrigDuration) / PPQ
        const minStartBeat = Math.max(0, (dragAutomationClipOrigPosition - dragAutomationClipOrigOffset) / PPQ)
        let newStartBeat = Math.min(snappedStart, clipEndBeat - AUTOMATION_MIN_DURATION_TICKS / PPQ)
        newStartBeat = Math.max(minStartBeat, newStartBeat)
        const newPositionTicks = beatsToTicks(newStartBeat)
        const newDurationTicks = (dragAutomationClipOrigPosition + dragAutomationClipOrigDuration) - newPositionTicks
        const positionDelta = newPositionTicks - dragAutomationClipOrigPosition
        const newOffsetTicks = Math.max(0, dragAutomationClipOrigOffset + positionDelta)
        if (newPositionTicks !== dragAutomationClipOrigPosition) {
          onResizeAutomationClipLeft?.(dragAutomationClip.id, newPositionTicks, newDurationTicks, newOffsetTicks)
          console.log(`[SelectTool] Left-resized automation clip ${dragAutomationClip.id}: pos=${newPositionTicks}t, dur=${newDurationTicks}t, offset=${newOffsetTicks}t`)
        }
      }

      // ── Block move/resize commit ────────────────────────────────────────
      if (dragMode === 'move' && dragBlock) {
        const beatDelta = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
          - pixelToBeat(dragOriginX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const newTrackIndex = idxAtY(dragCurrentY)
        if (newTrackIndex < 0) {
          resetDragState({ cancelled: true })
          return
        }
        const tracks = tracksRef.current
        const clampedTrackIdx = Math.max(0, Math.min(newTrackIndex, tracks.length - 1))
        const trackDelta = clampedTrackIdx - dragBlockOrigTrackIdx

        const blocksToMove = dragSelectedBlocks.length > 1
          ? dragSelectedBlocks
          : [{ block: dragBlock, origBeat: dragBlockOrigBeat, origTrackIdx: dragBlockOrigTrackIdx }]

        // Collect every displaced block and commit ONCE. Committing per block
        // cost a full engine round trip and a full pattern-block refetch each,
        // which is what made dragging a large selection crawl.
        const blockMoves = []
        for (const { block, origBeat, origTrackIdx } of blocksToMove) {
          const newBeat = snapBeatToGrid(Math.max(0, origBeat + beatDelta), modifiers, snapGranularityRef?.current)
          const newTrkIdx = Math.max(0, Math.min(origTrackIdx + trackDelta, tracks.length - 1))
          const tgtTrack = tracks[newTrkIdx]
          const finalTrackId = tgtTrack?.type === 'Pattern' ? tgtTrack.id : block.trackId
          const newPositionTicks = beatsToTicks(newBeat)
          if (newPositionTicks !== block.positionTicks || finalTrackId !== block.trackId) {
            blockMoves.push({ blockId: block.id, trackId: finalTrackId, positionTicks: newPositionTicks })
          }
        }
        if (blockMoves.length > 0) {
          onMovePatternBlocks?.(blockMoves)
          console.log(`[SelectTool] Moved ${blockMoves.length} pattern block(s)`)
        }
      }

      if (dragMode === 'resize' && dragBlock) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), modifiers, snapGranularityRef?.current)
        const blockStartBeat = dragBlock.positionTicks / PPQ
        let newDurationTicks = beatsToTicks(Math.max(snappedEnd - blockStartBeat, 0))
        const minDur = modifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS
        if (newDurationTicks < minDur) newDurationTicks = minDur
        if (newDurationTicks !== dragBlockOrigDuration) {
          onResizePatternBlock?.(dragBlock.id, newDurationTicks)
          console.log(`[SelectTool] Resized block ${dragBlock.id} to ${newDurationTicks}t`)
        }
      }

      if (dragMode === 'resize-left' && dragBlock) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), modifiers, snapGranularityRef?.current)
        const blockEndBeat = (dragBlock.positionTicks + dragBlock.durationTicks) / PPQ
        const minDur = modifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS
        // Can't drag left further than the original block start minus its current offset
        const minStartBeat = Math.max(0, (dragBlock.positionTicks - dragBlockOrigOffset) / PPQ)
        let newStartBeat = Math.min(snappedStart, blockEndBeat - minDur / PPQ)
        newStartBeat = Math.max(minStartBeat, newStartBeat)
        const newPositionTicks = beatsToTicks(newStartBeat)
        const newDurationTicks = (dragBlock.positionTicks + dragBlock.durationTicks) - newPositionTicks
        const positionDelta = newPositionTicks - dragBlock.positionTicks
        const newOffsetTicks = Math.max(0, dragBlockOrigOffset + positionDelta)
        if (newPositionTicks !== dragBlock.positionTicks) {
          onResizePatternBlockLeft?.(dragBlock.id, newPositionTicks, newDurationTicks, newOffsetTicks)
          console.log(`[SelectTool] Left-resized block ${dragBlock.id}: pos=${newPositionTicks}t, dur=${newDurationTicks}t, offset=${newOffsetTicks}t`)
        }
      }

      // ── Clip move/resize commit ─────────────────────────────────────────
      if (dragMode === 'move' && dragClip) {
        const beatDelta = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
          - pixelToBeat(dragOriginX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const newTrackIndex = idxAtY(dragCurrentY)
        if (newTrackIndex < 0) {
          resetDragState({ cancelled: true })
          return
        }
        const tracks = tracksRef.current
        const clampedTrackIdx = Math.max(0, Math.min(newTrackIndex, tracks.length - 1))
        const trackDelta = clampedTrackIdx - dragClipOrigTrackIdx

        const clipsToMove = dragSelectedClips.length > 1
          ? dragSelectedClips
          : [{ clip: dragClip, origBeat: dragClipOrigBeat, origTrackIdx: dragClipOrigTrackIdx }]

        // Same as the block path: one batched commit for the whole selection.
        const clipMoves = []
        for (const { clip, origBeat, origTrackIdx } of clipsToMove) {
          const newBeat = snapBeatToGrid(Math.max(0, origBeat + beatDelta), modifiers, snapGranularityRef?.current)
          const newTrkIdx = Math.max(0, Math.min(origTrackIdx + trackDelta, tracks.length - 1))
          const tgtTrack = tracks[newTrkIdx]
          // Refuse cross-move onto a Pattern track
          const newTrackId = (tgtTrack?.type === 'Pattern') ? clip.trackId : tgtTrack.id
          const newPositionTicks = beatsToTicks(newBeat)
          if (newPositionTicks !== clip.positionTicks || newTrackId !== clip.trackId) {
            clipMoves.push({ clipId: clip.id, trackId: newTrackId, positionTicks: newPositionTicks })
          }
        }
        if (clipMoves.length > 0) {
          onMoveClips?.(clipMoves)
          console.log(`[SelectTool] Moved ${clipMoves.length} clip(s)`)
        }
      }

      // ── Clip stretch commit (Shift+drag mouseup only) ──────────────────────
      if (dragMode === 'resize' && dragClip && modifiers.shift) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), modifiers, snapGranularityRef?.current)
        const clipStartBeat = dragClip.positionTicks / PPQ
        const minDur = modifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS
        let newDurationTicks = beatsToTicks(Math.max(snappedEnd - clipStartBeat, 0))
        if (newDurationTicks < minDur) newDurationTicks = minDur
        if (newDurationTicks !== dragClipOrigDuration) {
          onStretchClip?.(dragClip.id, newDurationTicks)
          console.log(`[SelectTool] Stretched clip ${dragClip.id} to ${newDurationTicks}t`)
        }
      }

      if (dragMode === 'resize-left' && dragClip && modifiers.shift) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
        const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), modifiers, snapGranularityRef?.current)
        const clipEndBeat = (dragClip.positionTicks + dragClip.durationTicks) / PPQ
        const minDur = modifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS
        let newStartBeat = Math.min(snappedStart, clipEndBeat - minDur / PPQ)
        newStartBeat = Math.max(0, newStartBeat)
        const newPositionTicks = beatsToTicks(newStartBeat)
        const newDurationTicks = (dragClip.positionTicks + dragClip.durationTicks) - newPositionTicks
        if (newPositionTicks !== dragClip.positionTicks) {
          onStretchClipLeft?.(dragClip.id, newPositionTicks, newDurationTicks)
          console.log(`[SelectTool] Stretch-left clip ${dragClip.id}: pos=${newPositionTicks}t, dur=${newDurationTicks}t`)
        }
      }

      if (dragMode === 'rubberband') {
        const x1 = Math.min(dragOriginX, dragCurrentX)
        const x2 = Math.max(dragOriginX, dragCurrentX)
        const y1 = Math.min(dragOriginY, dragCurrentY)
        const y2 = Math.max(dragOriginY, dragCurrentY)
        const ppb = pixelsPerBeatRef.current
        const scrollOffset = scrollOffsetRef.current
        const clips = clipsRef.current
        const tracks = tracksRef.current
        const clipIds = new Set()
        const blockIds = new Set()

        for (const clip of clips) {
          const clipBeat = clip.positionTicks / PPQ
          const clipEnd = clipBeat + clip.durationTicks / PPQ
          const clipX1 = beatToPixel(clipBeat, scrollOffset, ppb)
          const clipX2 = beatToPixel(clipEnd, scrollOffset, ppb)
          const trackIdx = tracks.findIndex((t) => t.id === clip.trackId)
          const clipY1 = topOf(trackIdx)
          const clipY2 = clipY1 + TRACK_HEIGHT
          if (clipX2 >= x1 && clipX1 <= x2 && clipY2 >= y1 && clipY1 <= y2) {
            clipIds.add(clip.id)
          }
        }
        const blocks = patternBlocksRef?.current || []
        for (const b of blocks) {
          const bBeat = b.positionTicks / PPQ
          const bEnd = bBeat + b.durationTicks / PPQ
          const bX1 = beatToPixel(bBeat, scrollOffset, ppb)
          const bX2 = beatToPixel(bEnd, scrollOffset, ppb)
          const trackIdx = tracks.findIndex((t) => t.id === b.trackId)
          const bY1 = topOf(trackIdx)
          const bY2 = bY1 + TRACK_HEIGHT
          if (bX2 >= x1 && bX1 <= x2 && bY2 >= y1 && bY1 <= y2) {
            blockIds.add(b.id)
          }
        }
        setSelectedClipIds(clipIds)
        setSelectedBlockIds?.(blockIds)
        console.log(`[SelectTool] Rubberband selected ${clipIds.size} clip(s), ${blockIds.size} block(s)`)
      }

      dragMode = null
      dragKind = null
      pendingHit = null
      dragClip = null
      dragBlock = null
      dragAutomationClip = null
      dragSelectedClips = []
      dragSelectedBlocks = []
      dragSelectedAutomationClips = []
      setDragClass(null)
      redrawOverlay()
    },

    onContextMenu(localX, localY, e) {
      e.preventDefault()
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const automationLaneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(localY)
      if (automationLaneRow) {
        const hitAutoClip = hitTestAutomationClip(beatsToTicks(beat), automationLaneRow.laneId)
        if (hitAutoClip && onRequestAutomationClipContextMenu) {
          if (!selectedAutomationClipIdsRef?.current?.has(hitAutoClip.id)) {
            setSelectedAutomationClipIds?.(new Set([hitAutoClip.id]))
          }
          onRequestAutomationClipContextMenu(hitAutoClip, e.clientX, e.clientY)
        }
        return
      }
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(beat, trackIndex)
        if (hitBlock && onRequestPatternBlockContextMenu) {
          if (!selectedBlockIdsRef?.current?.has(hitBlock.id)) {
            setSelectedBlockIds(new Set([hitBlock.id]))
          }
          onRequestPatternBlockContextMenu(hitBlock, e.clientX, e.clientY)
        }
        return
      }
      const hitClip = hitTestClip(beat, trackIndex)
      if (hitClip && onRequestClipContextMenu) {
        if (!selectedRef.current.has(hitClip.id)) {
          setSelectedClipIds(new Set([hitClip.id]))
        }
        onRequestClipContextMenu(hitClip.id, e.clientX, e.clientY)
        console.log(`[SelectTool] Right-click context menu for clip ${hitClip.id}`)
      }
    },

    onKeyUp(e) {
      const pendingDuplicate = dragMode === 'pending'
        && (pendingHit?.clip || pendingHit?.block)
        && !pendingHit.isLeftEdge
        && !pendingHit.isRightEdge
        && pendingHit.e.shiftKey
      if (e.key === 'Shift' && (dragMode === 'duplicate' || pendingDuplicate)) {
        resetDragState({ cancelled: true })
        console.log('[SelectTool] Duplicate drag cancelled because Shift was released')
      }
    },

    drawOverlay(ctx, w, h, viewState) {
      const { scrollOffset, pixelsPerBeat: ppb } = viewState

      if (dragMode === 'rubberband') {
        drawRubberBand(ctx, dragOriginX, dragOriginY, dragCurrentX, dragCurrentY)
      }

      // ── Automation clip drag previews (local-only, per the no-IPC-during-
      // drag constraint) ──────────────────────────────────────────────────
      if ((dragMode === 'move' || dragMode === 'resize' || dragMode === 'resize-left') && dragAutomationClip) {
        const accent = tokenValue('--theme-border-focus')
        ctx.save()
        ctx.fillStyle = accent
        ctx.globalAlpha = 0.22
        ctx.strokeStyle = accent
        ctx.globalAlpha = 1
        ctx.lineWidth = 1.5

        if (dragMode === 'move') {
          const beatDelta = pixelToBeat(dragCurrentX, scrollOffset, ppb)
            - pixelToBeat(dragOriginX, scrollOffset, ppb)
          const targetLaneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(dragCurrentY)
          const items = dragSelectedAutomationClips.length > 1
            ? dragSelectedAutomationClips
            : [{ clip: dragAutomationClip, origPosition: dragAutomationClipOrigPosition, origLaneId: dragAutomationClipOrigLaneId }]
          const allowLaneSwitch = items.length === 1
            && targetLaneRow && targetLaneRow.ownerTrackId === dragAutomationClipOwnerTrackId
          for (const { clip, origPosition, origLaneId } of items) {
            const origBeat = origPosition / PPQ
            const newBeat = snapBeatToGrid(Math.max(0, origBeat + beatDelta), lastModifiers, snapGranularityRef?.current)
            const laneRow = allowLaneSwitch
              ? targetLaneRow
              : (trackLayoutRef?.current?.getAutomationLaneRows?.() ?? []).find((r) => r.laneId === origLaneId)
            if (!laneRow) continue
            const x = beatToPixel(newBeat, scrollOffset, ppb)
            const width = Math.max(24, (clip.durationTicks / PPQ) * ppb)
            ctx.globalAlpha = 0.22
            ctx.fillRect(x, laneRow.y + 2, width, laneRow.height - 4)
            ctx.globalAlpha = 1
            ctx.strokeRect(x + 0.5, laneRow.y + 2.5, width - 1, laneRow.height - 5)
          }
        } else if (dragMode === 'resize') {
          const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
          const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
          const startBeat = dragAutomationClipOrigPosition / PPQ
          const width = Math.max(24, (snappedEnd - startBeat) * ppb)
          const laneRow = pendingHit?.laneRow
            ?? (trackLayoutRef?.current?.getAutomationLaneRows?.() ?? []).find((r) => r.laneId === dragAutomationClipOrigLaneId)
          if (laneRow) {
            const x = beatToPixel(startBeat, scrollOffset, ppb)
            ctx.globalAlpha = 0.22
            ctx.fillRect(x, laneRow.y + 2, width, laneRow.height - 4)
            ctx.globalAlpha = 1
            ctx.strokeRect(x + 0.5, laneRow.y + 2.5, width - 1, laneRow.height - 5)
          }
        } else if (dragMode === 'resize-left') {
          const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
          const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
          const endBeat = (dragAutomationClipOrigPosition + dragAutomationClipOrigDuration) / PPQ
          const minStartBeat = Math.max(0, (dragAutomationClipOrigPosition - dragAutomationClipOrigOffset) / PPQ)
          const startBeat = Math.max(minStartBeat, Math.min(snappedStart, endBeat - AUTOMATION_MIN_DURATION_TICKS / PPQ))
          const width = Math.max(24, (endBeat - startBeat) * ppb)
          const laneRow = pendingHit?.laneRow
            ?? (trackLayoutRef?.current?.getAutomationLaneRows?.() ?? []).find((r) => r.laneId === dragAutomationClipOrigLaneId)
          if (laneRow) {
            const x = beatToPixel(startBeat, scrollOffset, ppb)
            ctx.globalAlpha = 0.22
            ctx.fillRect(x, laneRow.y + 2, width, laneRow.height - 4)
            ctx.globalAlpha = 1
            ctx.strokeRect(x + 0.5, laneRow.y + 2.5, width - 1, laneRow.height - 5)
          }
        }
        ctx.restore()
      }

      // ── Block drag previews ──────────────────────────────────────────
      // Block color follows the block's pattern's region (sample-agnostic tracks).
      if ((dragMode === 'move' || dragMode === 'duplicate') && (dragBlock || dragSelectedBlocks.length > 0)) {
        if (dragMode === 'duplicate') {
          for (const { block, positionTicks, trackIndex } of getBlockDragPlacements(lastModifiers)) {
            const blockPattern = patternsRef.current?.[block.patternId]
            const region = regionsRef.current?.[blockPattern?.regionId]
            drawMovePreview(ctx, w, h, scrollOffset, ppb, {
              beat: positionTicks / PPQ,
              trackIndex,
              durationBeats: block.durationTicks / PPQ,
              color: labelHexColor(region?.label),
            }, trackLayoutRef?.current)
          }
        } else {
        const beatDelta = pixelToBeat(dragCurrentX, scrollOffset, ppb)
          - pixelToBeat(dragOriginX, scrollOffset, ppb)
        const newTrackIndex = idxAtY(dragCurrentY)
        if (newTrackIndex < 0) return
        const tracks = tracksRef.current
        const clampedTrackIdx = Math.max(0, Math.min(newTrackIndex, (tracks?.length || 1) - 1))
        const trackDelta = clampedTrackIdx - dragBlockOrigTrackIdx

        const items = dragSelectedBlocks.length > 1
          ? dragSelectedBlocks
          : [{ block: dragBlock, origBeat: dragBlockOrigBeat, origTrackIdx: dragBlockOrigTrackIdx }]

        for (const { block, origBeat, origTrackIdx } of items) {
          const newBeat = snapBeatToGrid(Math.max(0, origBeat + beatDelta), lastModifiers, snapGranularityRef?.current)
          const newTrkIdx = Math.max(0, Math.min(origTrackIdx + trackDelta, (tracks?.length || 1) - 1))
          const tgtTrack = tracks?.[newTrkIdx]
          const previewTrackIdx = tgtTrack?.type === 'Pattern' ? newTrkIdx : origTrackIdx
          const blockPattern = patternsRef.current?.[block.patternId]
          const region = regionsRef.current?.[blockPattern?.regionId]
          drawMovePreview(ctx, w, h, scrollOffset, ppb, {
            beat: newBeat,
            trackIndex: previewTrackIdx,
            durationBeats: block.durationTicks / PPQ,
            color: labelHexColor(region?.label),
          }, trackLayoutRef?.current)
        }
        }
      }

      if (dragMode === 'resize' && dragBlock) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const blockStartBeat = dragBlock.positionTicks / PPQ
        let newDurationBeats = Math.max(snappedEnd - blockStartBeat, MIN_DURATION_TICKS / PPQ)
        const tracks = tracksRef.current
        const trackIdx = tracks?.findIndex((t) => t.id === dragBlock.trackId) ?? 0
        const blockPattern = patternsRef.current?.[dragBlock.patternId]
        const region = regionsRef.current?.[blockPattern?.regionId]
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: blockStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          color: labelHexColor(region?.label),
        }, trackLayoutRef?.current)
      }

      if (dragMode === 'resize-left' && dragBlock) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const blockEndBeat = (dragBlock.positionTicks + dragBlock.durationTicks) / PPQ
        const minDur = (lastModifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS) / PPQ
        const minStartBeat = Math.max(0, (dragBlock.positionTicks - dragBlockOrigOffset) / PPQ)
        const newStartBeat = Math.max(minStartBeat, Math.min(snappedStart, blockEndBeat - minDur))
        const newDurationBeats = blockEndBeat - newStartBeat
        const tracks = tracksRef.current
        const trackIdx = tracks?.findIndex((t) => t.id === dragBlock.trackId) ?? 0
        const blockPattern = patternsRef.current?.[dragBlock.patternId]
        const region = regionsRef.current?.[blockPattern?.regionId]
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: newStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          color: labelHexColor(region?.label),
        }, trackLayoutRef?.current)
      }

      // ── Clip drag previews ───────────────────────────────────────────
      if ((dragMode === 'move' || dragMode === 'duplicate') && (dragClip || dragSelectedClips.length > 0)) {
        for (const { clip, positionTicks, trackIndex } of getClipDragPlacements(lastModifiers)) {
          const region = regionsRef.current?.[clip.regionId]
          drawMovePreview(ctx, w, h, scrollOffset, ppb, {
            beat: positionTicks / PPQ,
            trackIndex,
            durationBeats: clip.durationTicks / PPQ,
            color: labelHexColor(region?.label),
          }, trackLayoutRef?.current)
        }
      }

      if (dragMode === 'resize' && dragClip) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const clipStartBeat = dragClip.positionTicks / PPQ
        const minDurBeats = MIN_DURATION_TICKS / PPQ
        const region = regionsRef.current?.[dragClip.regionId]
        const trackIdx = tracksRef.current?.findIndex((t) => t.id === dragClip.trackId) ?? 0
        let newDurationBeats = Math.max(snappedEnd - clipStartBeat, minDurBeats)
        if (!lastModifiers.shift) {
          const maxDurBeats = dragClipOrigMaxDuration / PPQ
          if (newDurationBeats > maxDurBeats) newDurationBeats = Math.max(minDurBeats, maxDurBeats)
        }
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: clipStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          color: labelHexColor(region?.label),
        }, trackLayoutRef?.current)
        if (lastModifiers.shift) {
          const ratio = (newDurationBeats * PPQ / dragClipOrigDuration) * dragClipOrigStretchRatio
          const ratioText = ratio.toFixed(2) + '×'
          const edgePx = beatToPixel(clipStartBeat + newDurationBeats, scrollOffset, ppb)
          ctx.save()
          ctx.font = uiCanvasFont('11px')
          ctx.fillStyle = tokenValue('--theme-fg-inverse')
          ctx.textAlign = 'right'
          ctx.fillText(ratioText, edgePx - 4, topOf(trackIdx) + TRACK_HEIGHT * 0.5 - 2)
          ctx.restore()
        }
      }

      if (dragMode === 'resize-left' && dragClip) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const clipEndBeat = (dragClip.positionTicks + dragClip.durationTicks) / PPQ
        const minDur = (lastModifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS) / PPQ
        const region = regionsRef.current?.[dragClip.regionId]
        const trackIdx = tracksRef.current?.findIndex((t) => t.id === dragClip.trackId) ?? 0
        let newStartBeat
        if (lastModifiers.shift) {
          newStartBeat = Math.max(0, Math.min(snappedStart, clipEndBeat - minDur))
        } else {
          // Same source→timeline scaling as the commit path in onMouseMove, so
          // the preview edge and the applied edge agree on a stretched clip.
          const minStartBeat = Math.max(0, (dragClip.positionTicks
            - timelineTicksForSourceTicks(dragClipOrigOffset, dragClipOrigStretchRatio)) / PPQ)
          newStartBeat = Math.max(minStartBeat, Math.min(snappedStart, clipEndBeat - minDur))
        }
        const newDurationBeats = clipEndBeat - newStartBeat
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: newStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          color: labelHexColor(region?.label),
        }, trackLayoutRef?.current)
        if (lastModifiers.shift) {
          const newDurTicks = newDurationBeats * PPQ
          const ratio = (newDurTicks / dragClipOrigDuration) * dragClipOrigStretchRatio
          const ratioText = ratio.toFixed(2) + '×'
          const edgePx = beatToPixel(newStartBeat, scrollOffset, ppb)
          ctx.save()
          ctx.font = uiCanvasFont('11px')
          ctx.fillStyle = tokenValue('--theme-fg-inverse')
          ctx.textAlign = 'left'
          ctx.fillText(ratioText, edgePx + 4, topOf(trackIdx) + TRACK_HEIGHT * 0.5 - 2)
          ctx.restore()
        }
      }
    },

    cleanup() {
      dragCancelled = false
      dragMode = null
      dragKind = null
      pendingHit = null
      dragClip = null
      dragBlock = null
      dragAutomationClip = null
      dragSelectedClips = []
      dragSelectedBlocks = []
      dragSelectedAutomationClips = []
      dragClipOrigOffset = 0
      dragClipOrigMaxDuration = Number.MAX_SAFE_INTEGER
      dragClipOrigStretchRatio = 1.0
      dragBlockOrigOffset = 0
      selectionAnchor = null
      setDragClass(null)
    },
  }
}

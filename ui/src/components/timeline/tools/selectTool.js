import {
  TRACK_HEIGHT, PPQ, pixelToBeat, beatToPixel, snapBeatToGrid, snapTickToGrid, beatsToTicks, ticksToBeats,
  MIN_DURATION_TICKS_FREE,
} from '../../../constants/timeline.js'
import { labelHexColor } from '../../../constants/labels.js'
import { uiCanvasFont } from '../../../styles/typography.js'
import { drawRubberBand, drawMovePreview, hexToRgba, resolveTimelinePalette } from '../timelineDrawing.js'
import {
  blockRect, blockEdgeAt, blocksInPixelRect, hitTestBlockAt, trackIndexAtY, trackTopOf,
} from '../blockGeometry.js'
import { resolveGroupTranslation, splitPlacementsByKind } from '../groupTransform.js'
import { getRegionPlaybackDurationSec } from '../regionDuration.js'
import { resolveLeftTrim, resolveRightTrim } from '../clipTrim.js'
import {
  AUTOMATION_MIN_DURATION_TICKS,
  automationClipBodyRect,
  automationClipIdsInPixelRect,
  canvasPosToEnvelopePoint,
  hitTestAutomationPoint,
  isOnAutomationClipLeftEdge,
  isOnAutomationClipRightEdge,
  sortedEnvelopePoints,
} from '../automationLaneGeometry.js'

const MIN_DURATION_TICKS = 120  // 1/32 note
const DRAG_THRESHOLD = 3  // px before drag starts

// Resolves a ghost-preview fill/stroke pair from a region's label color once
// (at mousedown, or once per selected item into the drag snapshot) instead of
// re-parsing the hex string via hexToRgba on every drag-overlay frame.
function ghostColors(hex) {
  return { fillColor: hexToRgba(hex, 0.3), strokeColor: hexToRgba(hex, 0.7) }
}

/**
 * Select tool — click to select, drag to move/resize, rubber-band select.
 * Handles both Clips and PatternBlocks (pattern blocks on Pattern tracks).
 */
export function createSelectTool(deps) {
  const {
    clipsRef, tracksRef, regionsRef, selectedRef,
    pixelsPerBeatRef, scrollOffsetRef, bpmRef,
    // Track id → index lookup (rebuilt only when the tracks array changes) —
    // avoids an O(tracks) tracks.findIndex() scan inside per-clip/per-block
    // loops during mousedown, rubber-band selection, and drag-preview redraw.
    trackIdToIndexRef,
    // (trackId) => the colour that track's blocks are painted in, so a drag
    // preview is the colour of the thing being dragged. Optional.
    trackColorOf,
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
    onDuplicateAutomationClips,
    onRequestAutomationClipContextMenu,
    // Automation POINT editing deps (Phase C). The envelope map is read-only
    // here; every mutation leaves through one of the three callbacks, and
    // `automationPointDragRef` is the local drag preview the canvas draws —
    // no IPC runs between mousedown and mouseup.
    automationEnvelopesByIdRef, setSelectedAutomationPoint,
    onAddAutomationPoint, onRemoveAutomationPoint, onMoveAutomationPoint,
    automationPointDragRef,
    redrawContent,
  } = deps

  // Resolve a Y coordinate to a track index (lane bands map to their parent
  // track) and a track index back to its Y top, via the row layout when present.
  function idxAtY(y) {
    return trackIndexAtY(y, trackLayoutRef?.current)
  }
  function topOf(trackIndex) {
    return trackTopOf(trackIndex, trackLayoutRef?.current)
  }

  // Pointer geometry for the current viewport (see blockGeometry.js).
  function currentView() {
    return {
      scrollOffset: scrollOffsetRef.current,
      ppb: pixelsPerBeatRef.current,
      trackIdToIndex: trackIdToIndexRef.current,
      trackLayout: trackLayoutRef?.current ?? null,
    }
  }

  // Drag-preview colours for a clip / pattern block: the colour it is painted
  // in (its track's), falling back to its region's label colour.
  function clipGhostColors(clip) {
    return ghostColors(
      trackColorOf?.(clip.trackId) || labelHexColor(regionsRef.current?.[clip.regionId]?.label),
    )
  }
  function blockGhostColors(block) {
    return ghostColors(
      trackColorOf?.(block.trackId) || labelHexColor(
        regionsRef.current?.[patternsRef?.current?.[block.patternId]?.regionId]?.label,
      ),
    )
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
  // INTEGER ticks, not float beats. A gesture's position math never leaves the
  // tick domain (groupTransform.js law 6) — holding beats here is what let a
  // free (Alt) drag accumulate a tick of rounding drift per item per frame.
  let dragClipOrigTicks = 0
  let dragClipOrigTrackIdx = 0
  let dragClipOrigDuration = 0
  let dragClipOrigOffset = 0
  // Length of the dragged clip's region audio in SOURCE ticks: the budget its
  // source window can grow into when an edge is dragged outward (clipTrim.js).
  let dragClipRegionSourceTicks = Number.MAX_SAFE_INTEGER
  let dragClipOrigStretchRatio = 1.0
  let dragClipOrigColors = null  // { fillColor, strokeColor } — resolved once at mousedown
  // Block drag state
  let dragBlock = null
  let dragBlockOrigTicks = 0
  let dragBlockOrigTrackIdx = 0
  let dragBlockOrigDuration = 0
  let dragBlockOrigOffset = 0
  let dragBlockOrigColors = null  // { fillColor, strokeColor } — resolved once at mousedown
  // Automation clip drag state — lane-addressed, not track-addressed.
  let dragAutomationClip = null
  let dragAutomationClipOrigPosition = 0
  let dragAutomationClipOrigDuration = 0
  let dragAutomationClipOrigOffset = 0
  let dragAutomationClipOrigLaneId = null
  let dragAutomationClipOwnerTrackId = null
  let dragSelectedAutomationClips = [] // [{ clip, origPosition, origLaneId }]
  // Automation point drag state (Phase C). `previewTick/previewValue` are the
  // LOCAL values the canvas paints each frame; they reach the engine exactly
  // once, on mouseup, as a single undo step.
  let dragAutomationPoint = null // { envelopeId, pointIndex, clip, laneRow, origTick, origValue }
  let dragAutomationPointPreviewTick = 0
  let dragAutomationPointPreviewValue = 0
  let pendingHit = null  // { clip?, block?, automationClip?, empty?, isRightEdge, isLeftEdge, e }
  // Multi-select drag state
  let dragSelectedClips = []   // [{ clip, origTicks, origTrackIdx }]
  let dragSelectedBlocks = []  // [{ block, origTicks, origTrackIdx }]
  // Shift-click range-select anchor — the last plain/ctrl-clicked item's
  // track+time extent, so a later shift-click can select everything between
  // it and the new target (horizontally on one track, or across a block of
  // tracks above/below/diagonally). Mirrors trackSelectionAnchorRef's role
  // for track-header range selection (see updateTrackSelection).
  let selectionAnchor = null  // { trackIndex, startTicks, endTicks }

  // rAF-coalesced overlay repaint for the hot per-mousemove path. Several
  // mousemove events can land in the same animation frame; without this a
  // clip trim redraws the full overlay canvas once per event instead of once
  // per frame. Mouseup/reset paths still call redrawOverlay() directly so
  // the final state paints immediately with no extra frame of latency.
  let overlayRedrawRaf = null
  function scheduleOverlayRedraw() {
    if (overlayRedrawRaf != null) return
    overlayRedrawRaf = requestAnimationFrame(() => {
      overlayRedrawRaf = null
      redrawOverlay()
    })
  }
  function cancelScheduledOverlayRedraw() {
    if (overlayRedrawRaf != null) {
      cancelAnimationFrame(overlayRedrawRaf)
      overlayRedrawRaf = null
    }
  }

  // Drops the automation point drag preview and repaints the content layer so
  // the curve snaps back to whatever the engine actually holds. Called on
  // commit, on cancel, and on tool teardown — the preview must never outlive
  // the gesture that created it.
  function clearAutomationPointPreview({ repaint = true } = {}) {
    if (automationPointDragRef) automationPointDragRef.current = null
    dragAutomationPoint = null
    if (repaint) redrawContent?.('automation-point-drag-end')
  }

  // Recomputes the dragged point's { tick, value } from the pointer and
  // publishes it to the shared preview ref, then repaints the content layer.
  // Vertical travel is never snapped (a value is continuous); horizontal
  // travel follows the same grid snap and Alt-to-free modifier as every other
  // timeline drag, so a point lands on the beat the ruler shows.
  function updateAutomationPointPreview(localX, localY) {
    const d = dragAutomationPoint
    if (!d) return
    const next = canvasPosToEnvelopePoint(
      localX, localY, d.clip, d.laneRow,
      pixelsPerBeatRef.current, scrollOffsetRef.current,
      (timelineTick) => snapTickToGrid(timelineTick, lastModifiers, snapGranularityRef?.current),
    )
    if (!next) return
    dragAutomationPointPreviewTick = next.tick
    dragAutomationPointPreviewValue = next.value
    if (automationPointDragRef) {
      automationPointDragRef.current = {
        envelopeId: d.envelopeId,
        pointIndex: d.pointIndex,
        tick: next.tick,
        value: next.value,
      }
    }
    redrawContent?.('automation-point-drag')
  }

  function resetDragState({ cancelled = false } = {}) {
    dragCancelled = cancelled
    dragMode = null
    dragKind = null
    pendingHit = null
    dragClip = null
    dragBlock = null
    dragAutomationClip = null
    clearAutomationPointPreview()
    dragSelectedClips = []
    dragSelectedBlocks = []
    dragSelectedAutomationClips = []
    setDragClass(null)
    cancelScheduledOverlayRedraw()
    redrawOverlay()
  }

  // ── Group translation ──────────────────────────────────────────────────
  // A move/duplicate gesture is a RIGID TRANSLATION of the whole selection.
  // Its geometry lives in groupTransform.js; the functions below only turn drag
  // state into that module's inputs. There is exactly one resolver — drawOverlay
  // renders `placements`, onMouseUp commits that same array — so the preview and
  // the commit cannot disagree.

  // The clip/block/automation halves of the gesture, as groupTransform items.
  // Each carries its ORIGINAL integer tick position; nothing is snapped or
  // clamped here.
  function clipGroupItems() {
    if (dragSelectedClips.length > 0) {
      return dragSelectedClips.map(({ clip, origTicks, origTrackIdx, colors }) => ({
        kind: 'clip', clip, colors, origTicks, origTrackIndex: origTrackIdx, trackId: clip.trackId,
      }))
    }
    if (dragKind === 'clip' && dragClip) {
      return [{
        kind: 'clip', clip: dragClip, colors: dragClipOrigColors,
        origTicks: dragClipOrigTicks, origTrackIndex: dragClipOrigTrackIdx, trackId: dragClip.trackId,
      }]
    }
    return []
  }

  function blockGroupItems() {
    if (dragSelectedBlocks.length > 0) {
      return dragSelectedBlocks.map(({ block, origTicks, origTrackIdx, colors }) => ({
        kind: 'block', block, colors, origTicks, origTrackIndex: origTrackIdx, trackId: block.trackId,
      }))
    }
    if (dragKind === 'block' && dragBlock) {
      return [{
        kind: 'block', block: dragBlock, colors: dragBlockOrigColors,
        origTicks: dragBlockOrigTicks, origTrackIndex: dragBlockOrigTrackIdx, trackId: dragBlock.trackId,
      }]
    }
    return []
  }

  // Automation clips are LANE-addressed, so they take no part in the vertical
  // axis (origTrackIndex null). Which lane a moved clip lands on is a policy
  // decision made here — a single-clip MOVE, within the grabbed clip's own
  // group — not geometry groupTransform knows about. A duplicate never switches
  // lane: it stays on its source clip's lane, as it always has.
  function automationGroupItems() {
    if (dragKind !== 'automation') return []
    const src = dragSelectedAutomationClips.length > 0
      ? dragSelectedAutomationClips
      : dragAutomationClip
        ? [{ clip: dragAutomationClip, origPosition: dragAutomationClipOrigPosition, origLaneId: dragAutomationClipOrigLaneId }]
        : []
    if (src.length === 0) return []
    const targetLaneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(dragCurrentY)
    const allowLaneSwitch = dragMode === 'move' && src.length === 1
      && targetLaneRow && targetLaneRow.ownerTrackId === dragAutomationClipOwnerTrackId
    return src.map(({ clip, origPosition, origLaneId }) => ({
      kind: 'automation', clip,
      origTicks: origPosition, origTrackIndex: null,
      laneId: allowLaneSwitch ? targetLaneRow.laneId : origLaneId,
    }))
  }

  /**
   * The single resolver for a move/duplicate gesture: pointer state in, one
   * rigid (tickDelta, trackDelta) and the resulting placements out, sliced per
   * kind. `refused` means the gesture resolved to nothing at all (no track row
   * under the pointer, or a type-mismatched destination anywhere in the
   * selection) — then every slice is empty and nothing is drawn or committed.
   */
  function resolveDragTranslation(modifiers) {
    const tracks = tracksRef.current || []
    const items = [...clipGroupItems(), ...blockGroupItems(), ...automationGroupItems()]
    if (items.length === 0) {
      return { tickDelta: 0, trackDelta: 0, placements: [], refused: true, clip: [], block: [], automation: [] }
    }

    // The ANCHOR is the item grabbed at mousedown — the only item whose
    // destination snap resolves.
    const anchor =
      dragKind === 'block' ? items.find((it) => it.kind === 'block' && it.block === dragBlock)
      : dragKind === 'automation' ? items.find((it) => it.kind === 'automation' && it.clip === dragAutomationClip)
      : items.find((it) => it.kind === 'clip' && it.clip === dragClip)

    const pointerBeatDelta = pixelToBeat(dragCurrentX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      - pixelToBeat(dragOriginX, scrollOffsetRef.current, pixelsPerBeatRef.current)

    // Vertical pointer travel, measured from the ANCHOR's row. A Y that resolves
    // to no track at all (a folder header, an automation group band) refuses the
    // gesture rather than silently picking a neighbouring row.
    let pointerTrackDelta = 0
    if (items.some((it) => it.origTrackIndex != null)) {
      const row = idxAtY(dragCurrentY)
      const anchorRow = anchor?.origTrackIndex
      if (row < 0 || tracks.length === 0 || anchorRow == null) pointerTrackDelta = NaN
      else pointerTrackDelta = Math.max(0, Math.min(row, tracks.length - 1)) - anchorRow
    }

    const result = resolveGroupTranslation({
      items,
      anchor,
      pointerBeatDelta,
      pointerTrackDelta,
      tracks,
      modifiers,
      snapGranularity: snapGranularityRef?.current,
    })
    return { ...result, ...splitPlacementsByKind(result.placements) }
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

  // The trim the pointer is currently asking for on the dragged clip's edge.
  // Used by the drag preview AND by the commit, so the edge that is drawn is
  // the edge that is applied. Which end of the source window a trim takes from,
  // and how far an edge can be dragged outward, depends on whether the clip is
  // reversed: see clipTrim.js.
  function clipTrimFromPointer(modifiers, scrollOffset, ppb) {
    const beat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
    const pointerTicks = beatsToTicks(
      snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularityRef?.current))
    const limits = {
      regionSourceTicks: dragClipRegionSourceTicks,
      minDurationTicks: modifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS,
    }
    if (dragMode === 'resize') {
      return {
        positionTicks: dragClip.positionTicks,
        ...resolveRightTrim(dragClip, pointerTicks - dragClip.positionTicks, limits),
      }
    }
    return resolveLeftTrim(dragClip, pointerTicks, limits)
  }

  // The block under the pointer: the one PAINTED there (same rectangle, same
  // stacking order as the draw path), so what you click is what you get.
  function hitTestClip(localX, trackIndex) {
    if (!tracksRef.current) return null
    return hitTestBlockAt(clipsRef.current, localX, trackIndex, currentView())
  }

  function hitTestPatternBlock(localX, trackIndex) {
    if (!tracksRef.current) return null
    return hitTestBlockAt(patternBlocksRef?.current, localX, trackIndex, currentView())
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

  // Points of the envelope a clip references, sorted — the exact list the
  // engine's point commands index into.
  function envelopePointsForClip(clip) {
    const env = automationEnvelopesByIdRef?.current?.get(clip.envelopeId)
    return { envelope: env ?? null, points: sortedEnvelopePoints(env?.points) }
  }

  // Hit-test a rendered envelope point under the cursor, across every clip on
  // the lane (a lane can hold several clips; only the one under the pointer can
  // match, but the loop keeps the caller from having to resolve it first).
  function hitTestPointOnLane(laneRow, localX, localY) {
    const clips = automationClipsRef?.current
    if (!clips || !laneRow) return null
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      if (clip.laneId !== laneRow.laneId) continue
      const body = automationClipBodyRect(clip, laneRow, pixelsPerBeatRef.current, scrollOffsetRef.current)
      if (!body || localX < body.x - 8 || localX > body.x + body.w + 8) continue
      const { envelope, points } = envelopePointsForClip(clip)
      if (!envelope) continue
      const hit = hitTestAutomationPoint(points, clip, laneRow, localX, localY,
                                         pixelsPerBeatRef.current, scrollOffsetRef.current)
      if (hit) return { ...hit, clip, laneRow, envelope, points }
    }
    return null
  }

  // Which resize edge of a hit block the pointer is on: 'left', 'right' or
  // null (the body, which moves it). The zones shrink on narrow blocks so the
  // body never disappears.
  function edgeOf(item, trackIndex, localX) {
    const rect = blockRect(item, trackIndex, scrollOffsetRef.current, pixelsPerBeatRef.current)
    return blockEdgeAt(rect, localX)
  }

  function updateEdgeHover(localX, localY) {
    const trackIndex = idxAtY(localY)
    const tracks = tracksRef.current
    const track = tracks?.[trackIndex]
    if (track?.type === 'Pattern') {
      const hitBlock = hitTestPatternBlock(localX, trackIndex)
      const canResize = hitBlock && (allowUnselectedEdgeResize || selectedBlockIdsRef?.current?.has(hitBlock.id))
      setHoverEdge(canResize ? edgeOf(hitBlock, trackIndex, localX) : null)
      return
    }
    const hitClip = hitTestClip(localX, trackIndex)
    const canResize = hitClip && (allowUnselectedEdgeResize || selectedRef.current.has(hitClip.id))
    setHoverEdge(canResize ? edgeOf(hitClip, trackIndex, localX) : null)
  }

  // Track+time extent of a clicked clip/block, or of a bare click point when
  // nothing was hit — the unit selectionAnchor and range-select deal in.
  function clipExtent(clip) {
    return {
      trackIndex: trackIdToIndexRef.current[clip.trackId] ?? -1,
      startTicks: clip.positionTicks,
      endTicks: clip.positionTicks + clip.durationTicks,
    }
  }
  function blockExtent(block) {
    return {
      trackIndex: trackIdToIndexRef.current[block.trackId] ?? -1,
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
    const tidx = trackIdToIndexRef.current

    // Clips/blocks are half-open [position, position+duration) spans, and
    // packed patterns commonly butt one clip's end exactly against the next
    // one's start — an inclusive <=/>= test would count that merely-touching
    // neighbor as overlapping and grab one extra item past the target.
    const clipIds = new Set()
    for (const clip of clipsRef.current || []) {
      const idx = tidx[clip.trackId] ?? -1
      if (idx < trackLo || idx > trackHi) continue
      const clipEnd = clip.positionTicks + clip.durationTicks
      if (clipEnd > startTicks && clip.positionTicks < endTicks) clipIds.add(clip.id)
    }
    const blockIds = new Set()
    for (const block of patternBlocksRef?.current || []) {
      const idx = tidx[block.trackId] ?? -1
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
        // Points win over the clip body: grabbing a point must never start a
        // clip move. The hit radius is in screen pixels, so this stays usable
        // at every zoom level without the clip drag becoming unreachable —
        // anywhere more than a few pixels from a point still moves the clip.
        const hitPoint = hitTestPointOnLane(automationLaneRow, localX, localY)
        if (hitPoint) {
          pendingHit = { automationPoint: hitPoint, laneRow: automationLaneRow, e }
          dragKind = 'automationPoint'
          dragAutomationPoint = {
            envelopeId: hitPoint.envelope.id,
            pointIndex: hitPoint.index,
            clip: hitPoint.clip,
            laneRow: automationLaneRow,
            origTick: hitPoint.point.tick,
            origValue: hitPoint.point.value,
          }
          dragAutomationPointPreviewTick = hitPoint.point.tick
          dragAutomationPointPreviewValue = hitPoint.point.value
          setSelectedAutomationPoint?.({ envelopeId: hitPoint.envelope.id, pointIndex: hitPoint.index })
          dragMode = 'pending'
          return
        }
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
        setSelectedAutomationPoint?.(null)
        return
      }

      // Pattern-track branch: hit-test pattern blocks first
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(localX, trackIndex)
        if (hitBlock) {
          const canResizeEdge = allowUnselectedEdgeResize || selectedBlockIdsRef?.current?.has(hitBlock.id)
          const edge = canResizeEdge ? edgeOf(hitBlock, trackIndex, localX) : null
          const isRightEdge = edge === 'right'
          const isLeftEdge = edge === 'left'
          pendingHit = { block: hitBlock, isRightEdge, isLeftEdge, e }
          dragKind = 'block'
          dragBlock = hitBlock
          dragBlockOrigTicks = hitBlock.positionTicks
          dragBlockOrigTrackIdx = trackIndex
          dragBlockOrigDuration = hitBlock.durationTicks
          dragBlockOrigOffset = hitBlock.offsetTicks ?? 0
          dragBlockOrigColors = blockGhostColors(hitBlock)
          // Capture multi-selection if this block is already selected
          if (selectedBlockIdsRef?.current?.has(hitBlock.id) && selectedBlockIdsRef.current.size > 1) {
            const tidx = trackIdToIndexRef.current
            dragSelectedBlocks = (patternBlocksRef.current || [])
              .filter((b) => selectedBlockIdsRef.current.has(b.id))
              .map((b) => ({
                block: b,
                origTicks: b.positionTicks,
                origTrackIdx: tidx[b.trackId] ?? -1,
                colors: blockGhostColors(b),
              }))
          } else {
            dragSelectedBlocks = []
          }
          if (selectedBlockIdsRef?.current?.has(hitBlock.id) && selectedRef.current.size > 0) {
            const tidx = trackIdToIndexRef.current
            dragSelectedClips = clipsRef.current
              .filter((c) => selectedRef.current.has(c.id))
              .map((c) => ({
                clip: c,
                origTicks: c.positionTicks,
                origTrackIdx: tidx[c.trackId] ?? -1,
                colors: clipGhostColors(c),
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

      const hitClip = hitTestClip(localX, trackIndex)

      if (hitClip) {
        const canResizeEdge = allowUnselectedEdgeResize || selectedRef.current.has(hitClip.id)
        const edge = canResizeEdge ? edgeOf(hitClip, trackIndex, localX) : null
        const isRightEdge = edge === 'right'
        const isLeftEdge = edge === 'left'
        pendingHit = { clip: hitClip, isRightEdge, isLeftEdge, e }
        dragKind = 'clip'
        dragClip = hitClip
        dragClipOrigTicks = hitClip.positionTicks
        dragClipOrigTrackIdx = trackIdToIndexRef.current[hitClip.trackId] ?? -1
        dragClipOrigDuration = hitClip.durationTicks
        dragClipOrigOffset = hitClip.regionOffsetTicks ?? 0
        dragClipOrigStretchRatio = hitClip.stretchRatio ?? 1.0
        dragClipOrigColors = clipGhostColors(hitClip)
        dragClipRegionSourceTicks = computeRegionDurTicks(hitClip)
        // Capture multi-selection if this clip is already selected
        if (selectedRef.current.has(hitClip.id) && selectedRef.current.size > 1) {
          const tidx = trackIdToIndexRef.current
          dragSelectedClips = clipsRef.current
            .filter((c) => selectedRef.current.has(c.id))
            .map((c) => ({
              clip: c,
              origTicks: c.positionTicks,
              origTrackIdx: tidx[c.trackId] ?? -1,
              colors: clipGhostColors(c),
            }))
        } else {
          dragSelectedClips = []
        }
        if (selectedRef.current.has(hitClip.id) && selectedBlockIdsRef?.current?.size > 0) {
          const tidx = trackIdToIndexRef.current
          dragSelectedBlocks = (patternBlocksRef.current || [])
            .filter((b) => selectedBlockIdsRef.current.has(b.id))
            .map((b) => ({
              block: b,
              origTicks: b.positionTicks,
              origTrackIdx: tidx[b.trackId] ?? -1,
              colors: blockGhostColors(b),
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

      // ── Automation point drag ────────────────────────────────────────────
      // Local preview only. The engine hears about this exactly once, on
      // mouseup, as a single AutomationPointEditCommand — the locked spec
      // forbids IPC between mousedown and mouseup.
      if (dragMode === 'automation-point' && dragAutomationPoint) {
        updateAutomationPointPreview(localX, localY)
        return
      }

      if (dragMode === 'pending') {
        const dx = Math.abs(localX - dragOriginX)
        const dy = Math.abs(localY - dragOriginY)
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return

        if (pendingHit?.automationPoint) {
          dragMode = 'automation-point'
          setDragClass('dragging')
          updateAutomationPointPreview(localX, localY)
          return
        }

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
            dragMode = pendingHit.e.shiftKey ? 'duplicate' : 'move'
            setDragClass(dragMode === 'duplicate' ? 'duplicating' : 'dragging')
            if (!selectedAutomationClipIdsRef?.current?.has(clip.id)) {
              if (pendingHit.e.ctrlKey || pendingHit.e.metaKey || pendingHit.e.shiftKey) {
                setSelectedAutomationClipIds?.((prev) => new Set([...prev, clip.id]))
              } else {
                setSelectedAutomationClipIds?.(new Set([clip.id]))
              }
            }
            console.log(`[SelectTool] ${dragMode === 'duplicate' ? 'Duplicate' : 'Move'} drag started on automation clip ${clip.id}`)
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

      // ── Clip resize/stretch cursor ──────────────────────────────────────
      // No IPC here — the edge is painted from drag state by drawOverlay
      // below (same as block/automation-clip resize), and onResizeClip /
      // onResizeClipLeft commit exactly once, from onMouseUp.
      if (dragMode === 'resize' && dragClip) {
        setDragClass(lastModifiers.shift ? 'stretching-right' : 'resizing-right')
      }

      if (dragMode === 'resize-left' && dragClip) {
        setDragClass(lastModifiers.shift ? 'stretching-left' : 'resizing-left')
      }

      scheduleOverlayRedraw()
    },

    onMouseUp(localX, localY, e) {
      cancelScheduledOverlayRedraw()
      if (dragCancelled) {
        dragCancelled = false
        return
      }
      // ── Automation point: single commit on mouseup ───────────────────────
      if (dragMode === 'automation-point' && dragAutomationPoint) {
        const d = dragAutomationPoint
        const moved = dragAutomationPointPreviewTick !== d.origTick
                   || dragAutomationPointPreviewValue !== d.origValue
        const tick = dragAutomationPointPreviewTick
        const value = dragAutomationPointPreviewValue
        // Drop the preview BEFORE the commit so the repaint that follows the
        // engine round trip reads real state, never a stale ghost.
        clearAutomationPointPreview({ repaint: false })
        if (moved) {
          onMoveAutomationPoint?.(d.envelopeId, d.pointIndex, tick, value)
          console.log(`[SelectTool] Moved automation point ${d.pointIndex} of envelope ${d.envelopeId} → tick=${tick} value=${value.toFixed(4)}`)
        } else {
          redrawContent?.('automation-point-drag-end')
        }
        dragMode = null
        dragKind = null
        pendingHit = null
        setDragClass(null)
        redrawOverlay()
        return
      }

      if (dragMode === 'pending' || !dragMode) {
        if (pendingHit?.automationPoint) {
          // A click without travel: the point is already selected (mousedown
          // did it) — nothing to commit.
          clearAutomationPointPreview({ repaint: false })
        } else if (pendingHit?.automationClip) {
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
          // Selecting a clip publishes its length as the global draw length.
          setStickyNoteLength(hitClip.durationTicks)
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
      // The overlay resolved its last frame from lastModifiers; adopting the
      // mouseup's modifiers here keeps the committed array the one the user was
      // actually looking at.
      lastModifiers = modifiers

      if (dragMode === 'duplicate') {
        if (modifiers.shift) {
          // Same resolver, same array the preview drew.
          const { clip: clipPlacements, block: blockPlacements, automation: automationPlacements } =
            resolveDragTranslation(modifiers)
          if (clipPlacements.length > 0) onDuplicateClips?.(clipPlacements)
          if (blockPlacements.length > 0) onDuplicatePatternBlocks?.(blockPlacements)
          if (automationPlacements.length > 0) onDuplicateAutomationClips?.(automationPlacements)
          if (clipPlacements.length + blockPlacements.length + automationPlacements.length > 0) {
            console.log(`[SelectTool] Duplicated ${clipPlacements.length} clip(s), ${blockPlacements.length} pattern block(s) and ${automationPlacements.length} automation clip(s) by drag`)
          }
        }
        resetDragState()
        return
      }

      // ── Move commit — ONE rigid translation for the whole gesture ───────
      // Clips, pattern blocks and automation clips resolve together: a mixed
      // selection has to move or refuse as a unit (groupTransform law 5). Each
      // kind still leaves through its own batch RPC.
      if (dragMode === 'move' && (dragClip || dragBlock || dragAutomationClip)) {
        const { clip: clipPlacements, block: blockPlacements, automation: automationPlacements } =
          resolveDragTranslation(modifiers)

        const clipMoves = []
        for (const p of clipPlacements) {
          if (p.positionTicks !== p.clip.positionTicks || p.trackId !== p.clip.trackId) {
            clipMoves.push({ clipId: p.clip.id, trackId: p.trackId, positionTicks: p.positionTicks })
          }
        }
        if (clipMoves.length > 0) {
          // Merely moving a clip publishes its length as the global draw length.
          if (dragClip) setStickyNoteLength(dragClip.durationTicks)
          onMoveClips?.(clipMoves)
          console.log(`[SelectTool] Moved ${clipMoves.length} clip(s)`)
        }

        const blockMoves = []
        for (const p of blockPlacements) {
          if (p.positionTicks !== p.block.positionTicks || p.trackId !== p.block.trackId) {
            blockMoves.push({ blockId: p.block.id, trackId: p.trackId, positionTicks: p.positionTicks })
          }
        }
        if (blockMoves.length > 0) {
          onMovePatternBlocks?.(blockMoves)
          console.log(`[SelectTool] Moved ${blockMoves.length} pattern block(s)`)
        }

        const automationMoves = []
        for (const p of automationPlacements) {
          if (p.positionTicks !== p.clip.positionTicks || p.laneId !== p.clip.laneId) {
            automationMoves.push({ clipId: p.clip.id, laneId: p.laneId, positionTicks: p.positionTicks })
          }
        }
        if (automationMoves.length > 0) {
          onMoveAutomationClip?.(automationMoves)
          console.log(`[SelectTool] Moved ${automationMoves.length} automation clip(s)`)
        }
      }

      // ── Automation clip resize commit (single commit here — no IPC during
      // drag, per the locked spec). The MOVE half of this gesture is part of the
      // unified group translation above. ──────────────────────────────────
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

      // ── Block resize commit (its move half is in the group translation) ─
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

      // ── Clip resize commit (trim) — single commit here, no IPC during drag
      // (matches the block/automation-clip resize pattern above). ─────────
      if (dragMode === 'resize' && dragClip && !modifiers.shift) {
        const trim = clipTrimFromPointer(modifiers, scrollOffsetRef.current, pixelsPerBeatRef.current)
        if (trim.durationTicks !== dragClipOrigDuration) {
          // Only a reversed clip's right-edge trim moves its source window; a
          // forward clip keeps the two-argument call it always made.
          if (trim.regionOffsetTicks !== dragClipOrigOffset) {
            onResizeClip(dragClip.id, trim.durationTicks, trim.regionOffsetTicks)
          } else {
            onResizeClip(dragClip.id, trim.durationTicks)
          }
          setStickyNoteLength(trim.durationTicks)
        }
      }

      if (dragMode === 'resize-left' && dragClip && !modifiers.shift) {
        const trim = clipTrimFromPointer(modifiers, scrollOffsetRef.current, pixelsPerBeatRef.current)
        if (trim.positionTicks !== dragClip.positionTicks) {
          onResizeClipLeft(dragClip.id, trim.positionTicks, trim.durationTicks, trim.regionOffsetTicks)
          setStickyNoteLength(trim.durationTicks)
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
          setStickyNoteLength(newDurationTicks)
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
          setStickyNoteLength(newDurationTicks)
          console.log(`[SelectTool] Stretch-left clip ${dragClip.id}: pos=${newPositionTicks}t, dur=${newDurationTicks}t`)
        }
      }

      if (dragMode === 'rubberband') {
        const x1 = Math.min(dragOriginX, dragCurrentX)
        const x2 = Math.max(dragOriginX, dragCurrentX)
        const y1 = Math.min(dragOriginY, dragCurrentY)
        const y2 = Math.max(dragOriginY, dragCurrentY)
        // Everything whose painted rectangle the band touches.
        const view = currentView()
        const clipIds = new Set(
          blocksInPixelRect(clipsRef.current, x1, y1, x2, y2, view).map((c) => c.id),
        )
        const blockIds = new Set(
          blocksInPixelRect(patternBlocksRef?.current, x1, y1, x2, y2, view).map((b) => b.id),
        )
        // Automation clips live on lane rows, not tracks, so blocksInPixelRect
        // can't see them — test their painted rects against the band directly.
        // Without this a band dragged over automation lanes selected nothing,
        // and Ctrl+C had no way to copy more than one automation clip.
        const automationIds = automationClipIdsInPixelRect(
          automationClipsRef?.current,
          trackLayoutRef?.current?.getAutomationLaneRows?.(),
          x1, y1, x2, y2, pixelsPerBeatRef.current, scrollOffsetRef.current,
        )
        setSelectedClipIds(clipIds)
        setSelectedBlockIds?.(blockIds)
        if (setSelectedAutomationClipIds && (automationIds.size > 0 || selectedAutomationClipIdsRef?.current?.size > 0)) {
          setSelectedAutomationClipIds(automationIds)
        }
        console.log(`[SelectTool] Rubberband selected ${clipIds.size} clip(s), ${blockIds.size} block(s), ${automationIds.size} automation clip(s)`)
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

    // Double-click inside an automation clip body adds a point at the clicked
    // position. Returns true when it handled the event so TimelineCanvas can
    // stop before its clip/pattern-block double-click behaviour runs.
    onDoubleClick(localX, localY, e) {
      const laneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(localY)
      if (!laneRow) return false
      // Double-clicking an existing point is not an add — it would stack a
      // second point on the same tick and the engine would replace the first.
      if (hitTestPointOnLane(laneRow, localX, localY)) return true

      const clips = automationClipsRef?.current ?? []
      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i]
        if (clip.laneId !== laneRow.laneId) continue
        const body = automationClipBodyRect(clip, laneRow, pixelsPerBeatRef.current, scrollOffsetRef.current)
        if (!body) continue
        if (localX < body.x || localX > body.x + body.w) continue
        if (localY < body.y || localY > body.y + body.h) continue
        const { envelope } = envelopePointsForClip(clip)
        if (!envelope) return true
        const next = canvasPosToEnvelopePoint(
          localX, localY, clip, laneRow,
          pixelsPerBeatRef.current, scrollOffsetRef.current,
          (timelineTick) => snapTickToGrid(timelineTick, modifiers, snapGranularityRef?.current),
        )
        if (!next) return true
        onAddAutomationPoint?.(envelope.id, next.tick, next.value)
        console.log(`[SelectTool] Added automation point to envelope ${envelope.id} → tick=${next.tick} value=${next.value.toFixed(4)}`)
        return true
      }
      // Inside the lane but outside every clip — swallow it anyway so the
      // track-index-based double-click paths below never fire on a lane row.
      return true
    },

    onContextMenu(localX, localY, e) {
      e.preventDefault()
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const automationLaneRow = trackLayoutRef?.current?.automationLaneRowAtY?.(localY)
      if (automationLaneRow) {
        // Right-click ON a point deletes it (FL parity) — the clip's own menu
        // only opens when the click misses every point.
        const hitPoint = hitTestPointOnLane(automationLaneRow, localX, localY)
        if (hitPoint) {
          setSelectedAutomationPoint?.(null)
          onRemoveAutomationPoint?.(hitPoint.envelope.id, hitPoint.index)
          console.log(`[SelectTool] Removed automation point ${hitPoint.index} of envelope ${hitPoint.envelope.id}`)
          return
        }
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
        const hitBlock = hitTestPatternBlock(localX, trackIndex)
        if (hitBlock && onRequestPatternBlockContextMenu) {
          if (!selectedBlockIdsRef?.current?.has(hitBlock.id)) {
            setSelectedBlockIds(new Set([hitBlock.id]))
          }
          onRequestPatternBlockContextMenu(hitBlock, e.clientX, e.clientY)
        }
        return
      }
      const hitClip = hitTestClip(localX, trackIndex)
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
        && (pendingHit?.clip || pendingHit?.block || pendingHit?.automationClip)
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
      if ((dragMode === 'move' || dragMode === 'duplicate' || dragMode === 'resize' || dragMode === 'resize-left') && dragAutomationClip) {
        const accent = resolveTimelinePalette().selectionHighlight
        ctx.save()
        ctx.fillStyle = accent
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.5

        if (dragMode === 'move' || dragMode === 'duplicate') {
          // Exactly the array mouseup commits — no second copy of the math.
          const laneRows = trackLayoutRef?.current?.getAutomationLaneRows?.() ?? []
          for (const { clip, positionTicks, laneId } of resolveDragTranslation(lastModifiers).automation) {
            const laneRow = laneRows.find((r) => r.laneId === laneId)
            if (!laneRow) continue
            const x = beatToPixel(positionTicks / PPQ, scrollOffset, ppb)
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

      // ── Group drag preview (clips + pattern blocks) ──────────────────
      // ONE resolve for the whole gesture, drawing the exact list mouseup will
      // commit. Block color follows the block's pattern's region (sample-
      // agnostic tracks); clip color follows the clip's own region.
      if ((dragMode === 'move' || dragMode === 'duplicate')
          && (dragClip || dragBlock || dragSelectedClips.length > 0 || dragSelectedBlocks.length > 0)) {
        const { clip: clipPlacements, block: blockPlacements } = resolveDragTranslation(lastModifiers)
        ctx.setLineDash([3, 3])
        for (const { clip, positionTicks, trackIndex, colors } of clipPlacements) {
          drawMovePreview(ctx, w, h, scrollOffset, ppb, {
            beat: positionTicks / PPQ,
            trackIndex,
            durationBeats: clip.durationTicks / PPQ,
            fillColor: colors.fillColor,
            strokeColor: colors.strokeColor,
          }, trackLayoutRef?.current)
        }
        for (const { block, positionTicks, trackIndex, colors } of blockPlacements) {
          drawMovePreview(ctx, w, h, scrollOffset, ppb, {
            beat: positionTicks / PPQ,
            trackIndex,
            durationBeats: block.durationTicks / PPQ,
            fillColor: colors.fillColor,
            strokeColor: colors.strokeColor,
          }, trackLayoutRef?.current)
        }
        ctx.setLineDash([])
      }

      if (dragMode === 'resize' && dragBlock) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const blockStartBeat = dragBlock.positionTicks / PPQ
        let newDurationBeats = Math.max(snappedEnd - blockStartBeat, MIN_DURATION_TICKS / PPQ)
        const trackIdx = trackIdToIndexRef.current[dragBlock.trackId] ?? 0
        ctx.setLineDash([3, 3])
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: blockStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          fillColor: dragBlockOrigColors.fillColor,
          strokeColor: dragBlockOrigColors.strokeColor,
        }, trackLayoutRef?.current)
        ctx.setLineDash([])
      }

      if (dragMode === 'resize-left' && dragBlock) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedStart = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const blockEndBeat = (dragBlock.positionTicks + dragBlock.durationTicks) / PPQ
        const minDur = (lastModifiers.alt ? MIN_DURATION_TICKS_FREE : MIN_DURATION_TICKS) / PPQ
        const minStartBeat = Math.max(0, (dragBlock.positionTicks - dragBlockOrigOffset) / PPQ)
        const newStartBeat = Math.max(minStartBeat, Math.min(snappedStart, blockEndBeat - minDur))
        const newDurationBeats = blockEndBeat - newStartBeat
        const trackIdx = trackIdToIndexRef.current[dragBlock.trackId] ?? 0
        ctx.setLineDash([3, 3])
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: newStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          fillColor: dragBlockOrigColors.fillColor,
          strokeColor: dragBlockOrigColors.strokeColor,
        }, trackLayoutRef?.current)
        ctx.setLineDash([])
      }

      if (dragMode === 'resize' && dragClip) {
        const currentBeat = pixelToBeat(dragCurrentX, scrollOffset, ppb)
        const snappedEnd = snapBeatToGrid(Math.max(0, currentBeat), lastModifiers, snapGranularityRef?.current)
        const clipStartBeat = dragClip.positionTicks / PPQ
        const minDurBeats = MIN_DURATION_TICKS / PPQ
        const trackIdx = trackIdToIndexRef.current[dragClip.trackId] ?? 0
        // A trim previews exactly what the commit will apply; a stretch
        // (Shift) is bounded only by the minimum length.
        const newDurationBeats = lastModifiers.shift
          ? Math.max(snappedEnd - clipStartBeat, minDurBeats)
          : ticksToBeats(clipTrimFromPointer(lastModifiers, scrollOffset, ppb).durationTicks)
        ctx.setLineDash([3, 3])
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: clipStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          fillColor: dragClipOrigColors.fillColor,
          strokeColor: dragClipOrigColors.strokeColor,
        }, trackLayoutRef?.current)
        ctx.setLineDash([])
        if (lastModifiers.shift) {
          const ratio = (newDurationBeats * PPQ / dragClipOrigDuration) * dragClipOrigStretchRatio
          const ratioText = ratio.toFixed(2) + '×'
          const edgePx = beatToPixel(clipStartBeat + newDurationBeats, scrollOffset, ppb)
          ctx.save()
          ctx.font = uiCanvasFont('11px')
          ctx.fillStyle = resolveTimelinePalette().fgInverse
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
        const trackIdx = trackIdToIndexRef.current[dragClip.trackId] ?? 0
        let newStartBeat
        if (lastModifiers.shift) {
          newStartBeat = Math.max(0, Math.min(snappedStart, clipEndBeat - minDur))
        } else {
          // The same resolver the commit uses, so the preview edge and the
          // applied edge agree on stretched and reversed clips alike.
          newStartBeat = ticksToBeats(clipTrimFromPointer(lastModifiers, scrollOffset, ppb).positionTicks)
        }
        const newDurationBeats = clipEndBeat - newStartBeat
        ctx.setLineDash([3, 3])
        drawMovePreview(ctx, w, h, scrollOffset, ppb, {
          beat: newStartBeat,
          trackIndex: trackIdx,
          durationBeats: newDurationBeats,
          fillColor: dragClipOrigColors.fillColor,
          strokeColor: dragClipOrigColors.strokeColor,
        }, trackLayoutRef?.current)
        ctx.setLineDash([])
        if (lastModifiers.shift) {
          const newDurTicks = newDurationBeats * PPQ
          const ratio = (newDurTicks / dragClipOrigDuration) * dragClipOrigStretchRatio
          const ratioText = ratio.toFixed(2) + '×'
          const edgePx = beatToPixel(newStartBeat, scrollOffset, ppb)
          ctx.save()
          ctx.font = uiCanvasFont('11px')
          ctx.fillStyle = resolveTimelinePalette().fgInverse
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
      clearAutomationPointPreview({ repaint: false })
      dragSelectedClips = []
      dragSelectedBlocks = []
      dragSelectedAutomationClips = []
      dragClipOrigOffset = 0
      dragClipRegionSourceTicks = Number.MAX_SAFE_INTEGER
      dragClipOrigStretchRatio = 1.0
      dragBlockOrigOffset = 0
      selectionAnchor = null
      setDragClass(null)
      cancelScheduledOverlayRedraw()
    },
  }
}

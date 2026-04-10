import { TRACK_HEIGHT, PPQ, pixelToBeat, beatToPixel } from '../../../constants/timeline.js'
import { drawDeleteSweep } from '../timelineDrawing.js'

/**
 * Delete tool — click to delete a single clip/block, drag to sweep-delete all touched items.
 */
export function createDeleteTool(deps) {
  const {
    clipsRef, tracksRef,
    pixelsPerBeatRef, scrollOffsetRef,
    onDeleteClip, setSelectedClipIds,
    redrawOverlay,
    // Pattern block deps
    patternBlocksRef, onDeletePatternBlock,
  } = deps

  let isDragging = false
  let dragOriginX = 0, dragOriginY = 0
  let dragCurrentX = 0, dragCurrentY = 0
  let touchedClipIds = new Set()
  let touchedBlockIds = new Set()

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

  function findClipsInRect(x1, y1, x2, y2) {
    const ppb = pixelsPerBeatRef.current
    const scrollOffset = scrollOffsetRef.current
    const clips = clipsRef.current
    const tracks = tracksRef.current
    const rX1 = Math.min(x1, x2), rX2 = Math.max(x1, x2)
    const rY1 = Math.min(y1, y2), rY2 = Math.max(y1, y2)
    const ids = new Set()

    for (const clip of clips) {
      const clipBeat = clip.positionTicks / PPQ
      const clipEnd = clipBeat + clip.durationTicks / PPQ
      const cX1 = beatToPixel(clipBeat, scrollOffset, ppb)
      const cX2 = beatToPixel(clipEnd, scrollOffset, ppb)
      const trackIdx = tracks.findIndex((t) => t.id === clip.trackId)
      const trackType = tracks[trackIdx]?.type
      if (trackType === 'Pattern') continue // pattern tracks can't hold clips
      const cY1 = trackIdx * TRACK_HEIGHT
      const cY2 = cY1 + TRACK_HEIGHT

      if (cX2 >= rX1 && cX1 <= rX2 && cY2 >= rY1 && cY1 <= rY2) {
        ids.add(clip.id)
      }
    }
    return ids
  }

  function findBlocksInRect(x1, y1, x2, y2) {
    const ppb = pixelsPerBeatRef.current
    const scrollOffset = scrollOffsetRef.current
    const blocks = patternBlocksRef?.current
    const tracks = tracksRef.current
    if (!blocks || !tracks) return new Set()
    const rX1 = Math.min(x1, x2), rX2 = Math.max(x1, x2)
    const rY1 = Math.min(y1, y2), rY2 = Math.max(y1, y2)
    const ids = new Set()
    for (const b of blocks) {
      const bBeat = b.positionTicks / PPQ
      const bEnd = bBeat + b.durationTicks / PPQ
      const bX1 = beatToPixel(bBeat, scrollOffset, ppb)
      const bX2 = beatToPixel(bEnd, scrollOffset, ppb)
      const trackIdx = tracks.findIndex((t) => t.id === b.trackId)
      const bY1 = trackIdx * TRACK_HEIGHT
      const bY2 = bY1 + TRACK_HEIGHT
      if (bX2 >= rX1 && bX1 <= rX2 && bY2 >= rY1 && bY1 <= rY2) {
        ids.add(b.id)
      }
    }
    return ids
  }

  return {
    onMouseDown(localX, localY, e) {
      if (e.button !== 0) return

      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = Math.floor(localY / TRACK_HEIGHT)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]

      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(beat, trackIndex)
        if (hitBlock) {
          console.log(`[DeleteTool] Click-delete block ${hitBlock.id}`)
          onDeletePatternBlock?.(hitBlock.id)
        }
      } else {
        const hitClip = hitTestClip(beat, trackIndex)
        if (hitClip) {
          console.log(`[DeleteTool] Click-delete clip ${hitClip.id}`)
          onDeleteClip(hitClip.id)
        }
      }

      // Start sweep drag regardless
      isDragging = true
      dragOriginX = localX
      dragOriginY = localY
      dragCurrentX = localX
      dragCurrentY = localY
      touchedClipIds = new Set()
      touchedBlockIds = new Set()
    },

    onMouseMove(localX, localY, e) {
      if (!isDragging) return

      dragCurrentX = localX
      dragCurrentY = localY
      touchedClipIds = findClipsInRect(dragOriginX, dragOriginY, dragCurrentX, dragCurrentY)
      touchedBlockIds = findBlocksInRect(dragOriginX, dragOriginY, dragCurrentX, dragCurrentY)
      redrawOverlay()
    },

    async onMouseUp(localX, localY, e) {
      if (!isDragging) return

      // Delete all swept clips + blocks in parallel
      const tasks = []
      if (touchedClipIds.size > 0) {
        console.log(`[DeleteTool] Sweep-deleting ${touchedClipIds.size} clip(s)`)
        for (const id of touchedClipIds) tasks.push(onDeleteClip(id))
      }
      if (touchedBlockIds.size > 0) {
        console.log(`[DeleteTool] Sweep-deleting ${touchedBlockIds.size} block(s)`)
        for (const id of touchedBlockIds) tasks.push(onDeletePatternBlock?.(id))
      }
      if (tasks.length > 0) await Promise.all(tasks)

      isDragging = false
      touchedClipIds = new Set()
      touchedBlockIds = new Set()
      redrawOverlay()
    },

    onContextMenu(localX, localY, e) {
      e.preventDefault()
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = Math.floor(localY / TRACK_HEIGHT)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(beat, trackIndex)
        if (hitBlock) {
          console.log(`[DeleteTool] Right-click delete block ${hitBlock.id}`)
          onDeletePatternBlock?.(hitBlock.id)
        }
        return
      }
      const hitClip = hitTestClip(beat, trackIndex)
      if (hitClip) {
        console.log(`[DeleteTool] Right-click delete clip ${hitClip.id}`)
        onDeleteClip(hitClip.id)
      }
    },

    drawOverlay(ctx, w, h, viewState) {
      if (isDragging) {
        drawDeleteSweep(ctx, dragOriginX, dragOriginY, dragCurrentX, dragCurrentY)
      }
    },

    cleanup() {
      isDragging = false
      touchedClipIds = new Set()
      touchedBlockIds = new Set()
    },
  }
}

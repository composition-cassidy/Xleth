import { drawDeleteSweep } from '../timelineDrawing.js'
import {
  blocksInPixelRect, buildTrackIdToIndex, hitTestBlockAt, trackIndexAtY,
} from '../blockGeometry.js'

/**
 * Delete tool — click to delete a single clip/block, drag to sweep-delete all touched items.
 */
export function createDeleteTool(deps) {
  const {
    clipsRef, tracksRef,
    pixelsPerBeatRef, scrollOffsetRef,
    trackIdToIndexRef,
    onDeleteClip,
    redrawOverlay,
    // Pattern block deps
    patternBlocksRef, onDeletePatternBlock,
    // FXG.4-h-r1: row layout so lane bands resolve to their parent track.
    trackLayoutRef,
  } = deps

  function idxAtY(y) {
    return trackIndexAtY(y, trackLayoutRef?.current)
  }

  // Pointer geometry for the current viewport (see blockGeometry.js). The
  // track id -> index map is the canvas's own, rebuilt only when the track
  // list changes; a sweep used to re-search the track array for every clip on
  // every mouse move.
  function currentView() {
    return {
      scrollOffset: scrollOffsetRef.current,
      ppb: pixelsPerBeatRef.current,
      trackIdToIndex: trackIdToIndexRef?.current ?? buildTrackIdToIndex(tracksRef.current),
      trackLayout: trackLayoutRef?.current ?? null,
    }
  }

  let isDragging = false
  let dragOriginX = 0, dragOriginY = 0
  let dragCurrentX = 0, dragCurrentY = 0
  let touchedClipIds = new Set()
  let touchedBlockIds = new Set()

  function hitTestClip(localX, trackIndex) {
    if (!tracksRef.current) return null
    return hitTestBlockAt(clipsRef.current, localX, trackIndex, currentView())
  }

  function hitTestPatternBlock(localX, trackIndex) {
    if (!tracksRef.current) return null
    return hitTestBlockAt(patternBlocksRef?.current, localX, trackIndex, currentView())
  }

  function findClipsInRect(x1, y1, x2, y2) {
    const tracks = tracksRef.current || []
    // Pattern tracks can't hold clips.
    const onAudioTrack = (_clip, trackIndex) => tracks[trackIndex]?.type !== 'Pattern'
    return new Set(
      blocksInPixelRect(clipsRef.current, x1, y1, x2, y2, currentView(), onAudioTrack).map((c) => c.id),
    )
  }

  function findBlocksInRect(x1, y1, x2, y2) {
    if (!tracksRef.current) return new Set()
    return new Set(
      blocksInPixelRect(patternBlocksRef?.current, x1, y1, x2, y2, currentView()).map((b) => b.id),
    )
  }

  return {
    onMouseDown(localX, localY, e) {
      if (e.button !== 0) return

      const trackIndex = idxAtY(localY)
      const track = tracksRef.current?.[trackIndex]

      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(localX, trackIndex)
        if (hitBlock) {
          console.log(`[DeleteTool] Click-delete block ${hitBlock.id}`)
          onDeletePatternBlock?.(hitBlock.id)
        }
      } else {
        const hitClip = hitTestClip(localX, trackIndex)
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

    onMouseMove(localX, localY) {
      if (!isDragging) return

      dragCurrentX = localX
      dragCurrentY = localY
      touchedClipIds = findClipsInRect(dragOriginX, dragOriginY, dragCurrentX, dragCurrentY)
      touchedBlockIds = findBlocksInRect(dragOriginX, dragOriginY, dragCurrentX, dragCurrentY)
      redrawOverlay()
    },

    async onMouseUp() {
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
      const trackIndex = idxAtY(localY)
      const track = tracksRef.current?.[trackIndex]
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(localX, trackIndex)
        if (hitBlock) {
          console.log(`[DeleteTool] Right-click delete block ${hitBlock.id}`)
          onDeletePatternBlock?.(hitBlock.id)
        }
        return
      }
      const hitClip = hitTestClip(localX, trackIndex)
      if (hitClip) {
        console.log(`[DeleteTool] Right-click delete clip ${hitClip.id}`)
        onDeleteClip(hitClip.id)
      }
    },

    drawOverlay(ctx) {
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

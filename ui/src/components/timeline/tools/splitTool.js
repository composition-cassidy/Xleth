import { TRACK_HEIGHT, PPQ, pixelToBeat, snapBeatToGrid, beatsToTicks } from '../../../constants/timeline.js'
import { drawSplitLine } from '../timelineDrawing.js'

const MIN_DURATION_TICKS = 120  // 1/32 note

/**
 * Split tool — click on a clip or pattern block to split it into two at the click position.
 * A vertical dashed line follows the mouse at the snapped position.
 */
export function createSplitTool(deps) {
  const {
    clipsRef, tracksRef,
    pixelsPerBeatRef, scrollOffsetRef,
    onSplitClip,
    redrawOverlay,
    // Pattern block deps
    patternBlocksRef, onSplitPatternBlock,
  } = deps

  let splitBeat = null

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

  return {
    onMouseDown(localX, localY, e) {
      if (e.button !== 0) return

      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = Math.floor(localY / TRACK_HEIGHT)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]
      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }
      const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers)

      // Pattern-track branch: split pattern block
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(snappedBeat, trackIndex)
        if (!hitBlock) return
        const splitTicks = beatsToTicks(snappedBeat)
        const leftDuration = splitTicks - hitBlock.positionTicks
        const rightDuration = hitBlock.durationTicks - leftDuration
        if (leftDuration < MIN_DURATION_TICKS || rightDuration < MIN_DURATION_TICKS) {
          console.warn(`[SplitTool] Block split rejected: halves too small (left=${leftDuration}t, right=${rightDuration}t)`)
          return
        }
        console.log(`[SplitTool] Splitting block ${hitBlock.id} at beat ${snappedBeat.toFixed(2)}: left=${leftDuration}t, right=${rightDuration}t`)
        onSplitPatternBlock?.(hitBlock.id, splitTicks)
        return
      }

      const hitClip = hitTestClip(snappedBeat, trackIndex)
      if (!hitClip) return

      const splitTicks = beatsToTicks(snappedBeat)
      const leftDuration = splitTicks - hitClip.positionTicks
      const rightDuration = hitClip.durationTicks - leftDuration

      if (leftDuration < MIN_DURATION_TICKS || rightDuration < MIN_DURATION_TICKS) {
        console.warn(`[SplitTool] Split rejected: halves too small (left=${leftDuration}t, right=${rightDuration}t)`)
        return
      }

      console.log(`[SplitTool] Splitting clip ${hitClip.id} at beat ${snappedBeat.toFixed(2)}: left=${leftDuration}t, right=${rightDuration}t`)
      onSplitClip(hitClip.id, leftDuration, rightDuration)
    },

    onMouseMove(localX, localY, e) {
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }
      splitBeat = snapBeatToGrid(Math.max(0, beat), modifiers)
      redrawOverlay()
    },

    onMouseUp() {},

    drawOverlay(ctx, w, h, viewState) {
      drawSplitLine(ctx, w, h, viewState.scrollOffset, viewState.pixelsPerBeat, splitBeat)
    },

    cleanup() {
      splitBeat = null
    },
  }
}

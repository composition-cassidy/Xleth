import { pixelToBeat, snapBeatToGrid, beatsToTicks } from '../../../constants/timeline.js'
import { drawSplitLine } from '../timelineDrawing.js'
import {
  buildTrackIdToIndex, findBlockAtTick, hitTestBlockAt, trackIndexAtY,
} from '../blockGeometry.js'

const MIN_DURATION_TICKS = 120  // 1/32 note

/**
 * Split tool — click on a clip or pattern block to split it into two at the click position.
 * A vertical dashed line follows the mouse at the snapped position.
 */
export function createSplitTool(deps) {
  const {
    clipsRef, tracksRef,
    pixelsPerBeatRef, scrollOffsetRef,
    trackIdToIndexRef,
    snapGranularityRef,
    onSplitClip,
    redrawOverlay,
    // Pattern block deps
    patternBlocksRef, onSplitPatternBlock,
    // FXG.4-h-r1: row layout so lane bands resolve to their parent track.
    trackLayoutRef,
  } = deps

  function idxAtY(y) {
    return trackIndexAtY(y, trackLayoutRef?.current)
  }

  let splitBeat = null

  // The block to cut: the one under the pointer. The cut itself lands on the
  // snapped grid position, which near a block's edge can fall just outside the
  // block that was clicked; testing only the snapped position (as this used
  // to) then picked the NEIGHBOUR and cut that instead. Only when the pointer
  // is over empty lane does the snapped position choose the block.
  function blockToSplit(items, localX, splitTicks, trackIndex) {
    if (!tracksRef.current) return null
    const trackIdToIndex = trackIdToIndexRef?.current ?? buildTrackIdToIndex(tracksRef.current)
    return hitTestBlockAt(items, localX, trackIndex, {
      scrollOffset: scrollOffsetRef.current,
      ppb: pixelsPerBeatRef.current,
      trackIdToIndex,
    }) ?? findBlockAtTick(items, splitTicks, trackIndex, trackIdToIndex)
  }

  return {
    onMouseDown(localX, localY, e) {
      if (e.button !== 0) return

      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]
      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }
      const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularityRef?.current)
      const splitTicks = beatsToTicks(snappedBeat)

      // Pattern-track branch: split pattern block
      if (track?.type === 'Pattern') {
        const hitBlock = blockToSplit(patternBlocksRef?.current, localX, splitTicks, trackIndex)
        if (!hitBlock) return
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

      const hitClip = blockToSplit(clipsRef.current, localX, splitTicks, trackIndex)
      if (!hitClip) return

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
      splitBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularityRef?.current)
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

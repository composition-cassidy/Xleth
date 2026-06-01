import { TRACK_HEIGHT, PPQ, pixelToBeat, snapBeatToGrid, beatsToTicks, findFreePosition } from '../../../constants/timeline.js'
import { labelHexColor } from '../../../constants/labels.js'
import { drawGhostPreview } from '../timelineDrawing.js'

/**
 * Pencil tool — click to draw clips at the active sample's color/label.
 * Ghost preview follows mouse at snapped position with sticky note length.
 */
export function createPencilTool(deps) {
  const {
    clipsRef, tracksRef, regionsRef, selectedRef,
    pixelsPerBeatRef, scrollOffsetRef,
    activeSampleIdRef, stickyNoteLengthRef, pencilTemplateRef,
    snapGranularityRef,
    onCreateClip, onDeleteClip, setSelectedClipIds, setStickyNoteLength,
    redrawOverlay,
    // Pattern block deps
    patternBlocksRef, patternsRef, currentPatternIdByTrackRef,
    onCreatePatternBlock, onDeletePatternBlock,
    // FXG.4-h-r1: row layout so lane bands resolve to their parent track.
    trackLayoutRef,
  } = deps

  // Resolve a Y to a track index via the row layout when present (lane bands map
  // to their parent track — child lanes never accept drawn audio/pattern clips).
  function idxAtY(y) {
    const layout = trackLayoutRef?.current
    if (layout && typeof layout.trackIndexAtY === 'function') return layout.trackIndexAtY(y)
    return Math.floor(y / TRACK_HEIGHT)
  }

  let ghost = null // { beat, trackIndex, durationBeats, color, name }

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

  function getActiveRegion() {
    const id = activeSampleIdRef.current
    if (!id) return null
    return regionsRef.current?.[id] || null
  }

  return {
    onMouseDown(localX, localY, e) {
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current
      if (!tracks || trackIndex < 0 || trackIndex >= tracks.length) return

      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }
      const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularityRef?.current)
      const track = tracks[trackIndex]

      // ── Pattern track branch ────────────────────────────────────────────
      if (track?.type === 'Pattern' && e.button === 0) {
        const hitBlock = hitTestPatternBlock(snappedBeat, trackIndex)
        if (hitBlock) {
          // No-op on click; block selection belongs to select tool
          return
        }
        const patternId = currentPatternIdByTrackRef?.current?.[track.id]
        if (patternId == null || patternId < 0) {
          console.warn('[PencilTool] Track has no current pattern — cannot create block')
          return
        }
        const pattern = patternsRef?.current?.[patternId]
        const blockDur = pattern?.lengthTicks || (PPQ * 4)
        const positionTicks = beatsToTicks(snappedBeat)
        console.log(`[PencilTool] Creating pattern block on track "${track.name}" at beat ${snappedBeat.toFixed(2)}, dur=${blockDur}t`)
        onCreatePatternBlock?.(track.id, patternId, positionTicks, blockDur, 0)
        return
      }

      const hitClip = hitTestClip(snappedBeat, trackIndex)

      if (e.button === 0) {
        // Left click
        if (hitClip) {
          // Click existing clip → select it, update sticky length
          setSelectedClipIds(new Set([hitClip.id]))
          setStickyNoteLength(hitClip.durationTicks)
          console.log(`[PencilTool] Clicked clip ${hitClip.id}, sticky length → ${hitClip.durationTicks}t`)
        } else {
          // Click empty → create clip (slide past any overlap on this track)
          const template = pencilTemplateRef?.current
          const track = tracks[trackIndex]
          const proposedTicks = beatsToTicks(snappedBeat)
          const durationTicks = stickyNoteLengthRef.current
          const positionTicks = findFreePosition(track.id, proposedTicks, durationTicks, clipsRef.current)

          if (template) {
            // Use middle-click template (preserves regionOffset, velocity, pitch, syllable)
            console.log(`[PencilTool] Drawing from template at beat ${(positionTicks / PPQ).toFixed(2)}, track "${track.name}", dur=${durationTicks}t`)
            onCreateClip(track.id, template.regionId, positionTicks, durationTicks, {
              regionOffsetTicks: template.regionOffsetTicks,
              velocity: template.velocity,
              pitchOffset: template.pitchOffset,
              syllableIndex: template.syllableIndex,
            })
          } else {
            // Fall back to active sample from Sample Selector
            const region = getActiveRegion()
            if (!region) {
              console.warn('[PencilTool] No active sample selected')
              return
            }
            console.log(`[PencilTool] Drawing clip at beat ${(positionTicks / PPQ).toFixed(2)}, track "${track.name}", dur=${durationTicks}t`)
            onCreateClip(track.id, region.id, positionTicks, durationTicks)
          }
        }
      }
    },

    onMouseMove(localX, localY, e) {
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current

      if (!tracks || trackIndex < 0 || trackIndex >= tracks.length) {
        ghost = null
        redrawOverlay()
        return
      }

      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }
      const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularityRef?.current)
      const template = pencilTemplateRef?.current
      const region = template
        ? regionsRef.current?.[template.regionId]
        : getActiveRegion()

      ghost = {
        beat: snappedBeat,
        trackIndex,
        durationBeats: stickyNoteLengthRef.current / PPQ,
        color: region ? labelHexColor(region.label) : '#888',
        name: region?.name || '',
      }
      redrawOverlay()
    },

    onMouseUp() {},

    onContextMenu(localX, localY, e) {
      e.preventDefault()
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(beat, trackIndex)
        if (hitBlock) {
          console.log(`[PencilTool] Right-click delete pattern block ${hitBlock.id}`)
          onDeletePatternBlock?.(hitBlock.id)
        }
        return
      }
      const hitClip = hitTestClip(beat, trackIndex)
      if (hitClip) {
        console.log(`[PencilTool] Right-click delete clip ${hitClip.id}`)
        onDeleteClip(hitClip.id)
      }
    },

    drawOverlay(ctx, w, h, viewState) {
      drawGhostPreview(ctx, w, h, viewState.scrollOffset, viewState.pixelsPerBeat, ghost, null, trackLayoutRef?.current)
    },

    cleanup() {
      ghost = null
    },
  }
}

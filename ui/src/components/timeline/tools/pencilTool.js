import { PPQ, pixelToBeat, snapBeatToGrid, beatsToTicks, ticksToBeats, findFreePosition } from '../../../constants/timeline.js'
import { labelHexColor } from '../../../constants/labels.js'
import { drawGhostPreview } from '../timelineDrawing.js'
import { buildTrackIdToIndex, hitTestBlockAt, trackIndexAtY } from '../blockGeometry.js'
import { createSelectTool } from './selectTool.js'

/**
 * Pencil tool — click to draw clips at the active sample's color/label.
 * Ghost preview follows mouse at snapped position with sticky note length.
 */
export function createPencilTool(deps) {
  const {
    clipsRef, tracksRef, regionsRef,
    pixelsPerBeatRef, scrollOffsetRef,
    trackIdToIndexRef, trackColorOf,
    activeSampleIdRef, stickyNoteLengthRef, pencilTemplateRef,
    snapGranularityRef,
    onCreateClip, onDeleteClip, setStickyNoteLength,
    redrawOverlay,
    // Pattern block deps
    patternBlocksRef, patternsRef, currentPatternIdByTrackRef,
    onCreatePatternBlock, onDeletePatternBlock,
    // FXG.4-h-r1: row layout so lane bands resolve to their parent track.
    trackLayoutRef,
  } = deps

  const selectTool = createSelectTool({ ...deps, allowUnselectedEdgeResize: true })

  // Resolve a Y to a track index via the row layout when present (lane bands map
  // to their parent track — child lanes never accept drawn audio/pattern clips).
  function idxAtY(y) {
    return trackIndexAtY(y, trackLayoutRef?.current)
  }

  // Pointer geometry for the current viewport (see blockGeometry.js).
  function currentView() {
    return {
      scrollOffset: scrollOffsetRef.current,
      ppb: pixelsPerBeatRef.current,
      trackIdToIndex: trackIdToIndexRef?.current ?? buildTrackIdToIndex(tracksRef.current),
    }
  }

  let ghost = null // { beat, trackIndex, durationBeats, color, name }
  let delegatedToSelect = false

  function hitTestClip(localX, trackIndex) {
    if (!tracksRef.current) return null
    return hitTestBlockAt(clipsRef.current, localX, trackIndex, currentView())
  }

  function hitTestPatternBlock(localX, trackIndex) {
    if (!tracksRef.current) return null
    return hitTestBlockAt(patternBlocksRef?.current, localX, trackIndex, currentView())
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
        const hitBlock = hitTestPatternBlock(localX, trackIndex)
        if (hitBlock) {
          ghost = null
          delegatedToSelect = true
          selectTool.onMouseDown(localX, localY, e)
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

      const hitClip = hitTestClip(localX, trackIndex)

      if (e.button === 0) {
        // Left click
        if (hitClip) {
          // Existing clips use select-tool behavior: select, move, trim, or
          // Shift+edge stretch. Pencil only draws when the pointer starts empty.
          setStickyNoteLength(hitClip.durationTicks)
          ghost = null
          delegatedToSelect = true
          selectTool.onMouseDown(localX, localY, e)
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
      if (delegatedToSelect) {
        selectTool.onMouseMove(localX, localY, e)
        return
      }

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
      const track = tracks[trackIndex]
      const onPatternTrack = track?.type === 'Pattern'
      const hoveringExisting = onPatternTrack
        ? hitTestPatternBlock(localX, trackIndex)
        : hitTestClip(localX, trackIndex)

      selectTool.onMouseMove(localX, localY, e)

      if (hoveringExisting) {
        ghost = null
        redrawOverlay()
        return
      }

      // The ghost previews exactly what a click here creates, in the colour it
      // will be painted in (the destination track's).
      const proposedTicks = beatsToTicks(snappedBeat)
      if (onPatternTrack) {
        // A pattern block of the track's current pattern, at its full length.
        // No current pattern means a click creates nothing, so no ghost.
        const patternId = currentPatternIdByTrackRef?.current?.[track.id]
        const hasPattern = patternId != null && patternId >= 0
        const pattern = hasPattern ? patternsRef?.current?.[patternId] : null
        ghost = !hasPattern ? null : {
          beat: snappedBeat,
          trackIndex,
          durationBeats: ticksToBeats(pattern?.lengthTicks || beatsToTicks(4)),
          color: trackColorOf?.(track.id) || '#888888',
          name: pattern?.name || '',
        }
      } else {
        const template = pencilTemplateRef?.current
        const region = template
          ? regionsRef.current?.[template.regionId]
          : getActiveRegion()
        // Same placement rule as the click: slide right past whatever the new
        // clip would overlap on this track.
        const durationTicks = stickyNoteLengthRef.current
        const positionTicks = findFreePosition(track.id, proposedTicks, durationTicks, clipsRef.current)
        ghost = {
          beat: ticksToBeats(positionTicks),
          trackIndex,
          durationBeats: ticksToBeats(durationTicks),
          color: trackColorOf?.(track.id) || (region ? labelHexColor(region.label) : '#888888'),
          name: region?.name || '',
        }
      }
      redrawOverlay()
    },

    onMouseUp(localX, localY, e) {
      if (!delegatedToSelect) return
      selectTool.onMouseUp(localX, localY, e)
      delegatedToSelect = false
    },

    onContextMenu(localX, localY, e) {
      e.preventDefault()
      const trackIndex = idxAtY(localY)
      const tracks = tracksRef.current
      const track = tracks?.[trackIndex]
      if (track?.type === 'Pattern') {
        const hitBlock = hitTestPatternBlock(localX, trackIndex)
        if (hitBlock) {
          console.log(`[PencilTool] Right-click delete pattern block ${hitBlock.id}`)
          onDeletePatternBlock?.(hitBlock.id)
        }
        return
      }
      const hitClip = hitTestClip(localX, trackIndex)
      if (hitClip) {
        console.log(`[PencilTool] Right-click delete clip ${hitClip.id}`)
        onDeleteClip(hitClip.id)
      }
    },

    drawOverlay(ctx, w, h, viewState) {
      if (delegatedToSelect) {
        selectTool.drawOverlay(ctx, w, h, viewState)
        return
      }
      drawGhostPreview(ctx, w, h, viewState.scrollOffset, viewState.pixelsPerBeat, ghost, null, trackLayoutRef?.current)
    },

    cleanup() {
      ghost = null
      delegatedToSelect = false
      selectTool.cleanup?.()
    },
  }
}

import { useEffect, useRef, useState, useCallback } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { PPQ, snapBeatToGrid, beatsToTicks, beatToPixel, pixelToBeat } from '../../constants/timeline.js'
import { PITCH_MIN, PITCH_MAX, isBlackKey } from './PianoRollKeyboard.jsx'

const RESIZE_HANDLE_PX = 6

const ACTION = {
  NONE: 'none',
  MOVE_NOTES: 'move-notes',
  RESIZE_NOTE: 'resize-note',
  LASSO: 'lasso',
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// Hit-test a note at local canvas coordinates.
function hitTestNote(notes, localX, localY, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY) {
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]
    const beat = note.positionTicks / PPQ
    const durBeats = note.durationTicks / PPQ
    const x = beat * pixelsPerBeat - scrollX
    const w = Math.max(2, durBeats * pixelsPerBeat)
    const y = (PITCH_MAX - note.pitch) * pixelsPerSemitone - scrollY
    if (localX >= x && localX < x + w && localY >= y && localY < y + pixelsPerSemitone) {
      const nearRight = localX >= x + w - RESIZE_HANDLE_PX
      return { note, index: i, nearRight }
    }
  }
  return null
}

function drawBackground(ctx, w, h, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, patternLenBeats) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = tokenValue('--theme-bg-inset')
  ctx.fillRect(0, 0, w, h)

  // Horizontal row striping: black keys slightly darker
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    const y = (PITCH_MAX - p) * pixelsPerSemitone - scrollY
    if (y + pixelsPerSemitone < 0 || y > h) continue
    if (isBlackKey(p)) {
      ctx.fillStyle = tokenValue('--theme-pianoroll-grid-bg')
      ctx.fillRect(0, y, w, pixelsPerSemitone)
    }
    if ((p % 12) === 0) {
      // Octave boundary line (C)
      ctx.strokeStyle = tokenValue('--theme-pianoroll-bar-line')
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y + pixelsPerSemitone) + 0.5)
      ctx.lineTo(w, Math.round(y + pixelsPerSemitone) + 0.5)
      ctx.stroke()
    }
  }

  // Horizontal grid for each semitone row
  ctx.strokeStyle = tokenValue('--theme-pianoroll-subdivision-line')
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    const y = (PITCH_MAX - p) * pixelsPerSemitone - scrollY
    if (y < 0 || y > h) continue
    ctx.moveTo(0, Math.round(y) + 0.5)
    ctx.lineTo(w, Math.round(y) + 0.5)
  }
  ctx.stroke()

  // Vertical beat grid — 16th note subdivisions + beats
  const startBeat = Math.floor(scrollX / pixelsPerBeat)
  const endBeat = Math.ceil((scrollX + w) / pixelsPerBeat) + 1

  ctx.strokeStyle = tokenValue('--theme-pianoroll-beat-line')
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let b = startBeat; b <= endBeat; b++) {
    for (let sub = 1; sub < 4; sub++) {
      const x = Math.round((b + sub / 4) * pixelsPerBeat - scrollX) + 0.5
      if (x < 0 || x > w) continue
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
    }
  }
  ctx.stroke()

  ctx.strokeStyle = tokenValue('--theme-pianoroll-bar-line')
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let b = startBeat; b <= endBeat; b++) {
    const x = Math.round(b * pixelsPerBeat - scrollX) + 0.5
    if (x < 0 || x > w) continue
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Pattern-length marker (dim region past pattern end)
  if (patternLenBeats > 0) {
    const endX = patternLenBeats * pixelsPerBeat - scrollX
    if (endX < w) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.fillRect(Math.max(0, endX), 0, w - endX, h)
      ctx.strokeStyle = tokenValue('--theme-border-focus')
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(endX + 0.5, 0)
      ctx.lineTo(endX + 0.5, h)
      ctx.stroke()
    }
  }
}

function drawNotes(ctx, w, h, notes, selectedNoteIds, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY) {
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const beat = note.positionTicks / PPQ
    const durBeats = note.durationTicks / PPQ
    const x = beat * pixelsPerBeat - scrollX
    const wid = Math.max(2, durBeats * pixelsPerBeat)
    const y = (PITCH_MAX - note.pitch) * pixelsPerSemitone - scrollY
    if (x + wid < 0 || x > w || y + pixelsPerSemitone < 0 || y > h) continue

    const selected = selectedNoteIds?.has(note.id)
    const alpha = 0.4 + 0.6 * (note.velocity ?? 1.0)
    // Slide notes use a magenta accent so they're visually distinct from
    // regular notes — they don't spawn cells, they trigger a per-track effect.
    const hex = note.isSlide ? '#E64FE6' : tokenValue('--theme-label-pitch')
    ctx.fillStyle = hexToRgba(hex, alpha * (selected ? 1.0 : 0.85))
    ctx.fillRect(x, y + 1, wid, pixelsPerSemitone - 2)
    ctx.strokeStyle = selected ? tokenValue('--theme-fg-inverse') : hexToRgba(hex, 1.0)
    ctx.lineWidth = selected ? 2 : 1
    ctx.strokeRect(x + 0.5, y + 1.5, wid - 1, pixelsPerSemitone - 3)
  }
}

export default function PianoRollCanvas({
  patternId,
  notes, patternLengthTicks,
  activeTool, stickyNoteLength, setStickyNoteLength, stickyVelocity = 1.0, setStickyVelocity,
  selectedNoteIds, setSelectedNoteIds,
  pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY,
  width, height,
  onAddNote, onRemoveNote, onMoveNote, onMoveNotesBatch, onResizeNote, onResizeNotesBatch, onPreviewNote,
}) {
  const bgRef = useRef(null)
  const ctRef = useRef(null)
  const ovRef = useRef(null)
  const containerRef = useRef(null)

  const dragStateRef = useRef(null)
  const [dragTick, setDragTick] = useState(0)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const scrollXRef = useRef(scrollX)
  scrollXRef.current = scrollX
  const scrollYRef = useRef(scrollY)
  scrollYRef.current = scrollY
  const pixelsPerBeatRef = useRef(pixelsPerBeat)
  pixelsPerBeatRef.current = pixelsPerBeat
  const pixelsPerSemitoneRef = useRef(pixelsPerSemitone)
  pixelsPerSemitoneRef.current = pixelsPerSemitone
  const onMoveNoteRef = useRef(onMoveNote)
  onMoveNoteRef.current = onMoveNote
  const onMoveNotesBatchRef = useRef(onMoveNotesBatch)
  onMoveNotesBatchRef.current = onMoveNotesBatch
  const onResizeNoteRef = useRef(onResizeNote)
  onResizeNoteRef.current = onResizeNote
  const onResizeNotesBatchRef = useRef(onResizeNotesBatch)
  onResizeNotesBatchRef.current = onResizeNotesBatch
  const onAddNoteRef = useRef(onAddNote)
  onAddNoteRef.current = onAddNote
  const onRemoveNoteRef = useRef(onRemoveNote)
  onRemoveNoteRef.current = onRemoveNote
  const onPreviewNoteRef = useRef(onPreviewNote)
  onPreviewNoteRef.current = onPreviewNote
  const setSelectedNoteIdsRef = useRef(setSelectedNoteIds)
  setSelectedNoteIdsRef.current = setSelectedNoteIds
  const selectedNoteIdsRef = useRef(selectedNoteIds)
  selectedNoteIdsRef.current = selectedNoteIds
  const setStickyNoteLengthRef = useRef(setStickyNoteLength)
  setStickyNoteLengthRef.current = setStickyNoteLength

  // Apply DPR sizing
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    ;[bgRef, ctRef, ovRef].forEach((r) => {
      const c = r.current
      if (!c) return
      c.width = width * dpr
      c.height = height * dpr
      c.style.width = `${width}px`
      c.style.height = `${height}px`
      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    })
  }, [width, height])

  // Redraw background + content
  useEffect(() => {
    const bg = bgRef.current?.getContext('2d')
    const ct = ctRef.current?.getContext('2d')
    if (!bg || !ct) return
    const dpr = window.devicePixelRatio || 1
    bg.setTransform(dpr, 0, 0, dpr, 0, 0)
    ct.setTransform(dpr, 0, 0, dpr, 0, 0)
    const lenBeats = patternLengthTicks / PPQ
    drawBackground(bg, width, height, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, lenBeats)
    ct.clearRect(0, 0, width, height)
    drawNotes(ct, width, height, notes, selectedNoteIds, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY)
  }, [notes, selectedNoteIds, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, width, height, patternLengthTicks])

  const getLocalXY = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  const pixelToPitch = useCallback((localY) => {
    const pitch = PITCH_MAX - Math.floor((localY + scrollYRef.current) / pixelsPerSemitoneRef.current)
    return Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
  }, [])

  const pixelToTick = useCallback((localX, modifiers = {}) => {
    const beat = (localX + scrollXRef.current) / pixelsPerBeatRef.current
    const snapped = snapBeatToGrid(Math.max(0, beat), modifiers)
    return beatsToTicks(snapped)
  }, [])

  const handleMouseDown = useCallback((e) => {
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current

    // Right-click = delete (FL-style), works with any tool
    if (e.button === 2) {
      e.preventDefault()
      const pos = getLocalXY(e)
      if (!pos) return
      const hit = hitTestNote(notesRef.current, pos.localX, pos.localY, ppb, pps, sX, sY)
      if (hit) onRemoveNoteRef.current?.(hit.note.id)
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    const pos = getLocalXY(e)
    if (!pos) return
    const { localX, localY } = pos
    const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
    const hit = hitTestNote(notesRef.current, localX, localY, ppb, pps, sX, sY)

    // Alt+click on existing note → toggle slide flag (visual animation trigger).
    // Does not start a drag; reuses the same note id (no new cell spawned).
    if (modifiers.alt && hit && patternId != null) {
      const note = hit.note
      const newIsSlide = !note.isSlide
      const cx = note.slideCurveCx ?? 0.5
      const cy = note.slideCurveCy ?? 0.5
      window.xleth?.timeline?.setNoteSlide(patternId, note.id, newIsSlide, cx, cy)
      return
    }

    if (activeTool === 'delete') {
      if (hit) onRemoveNoteRef.current?.(hit.note.id)
      return
    }

    if (activeTool === 'split') {
      if (hit) {
        const clickTick = pixelToTick(localX, { alt: true })
        const splitPoint = clickTick - hit.note.positionTicks
        if (splitPoint > 0 && splitPoint < hit.note.durationTicks) {
          onResizeNoteRef.current?.(hit.note.id, splitPoint)
          onAddNoteRef.current?.({
            positionTicks: hit.note.positionTicks + splitPoint,
            durationTicks: hit.note.durationTicks - splitPoint,
            pitch: hit.note.pitch,
            velocity: hit.note.velocity,
          })
        }
      }
      return
    }

    // Begin drag: capture immutable originals snapshot (once). Multi-note op when
    // the hit note is already in the selection (applies to both move and resize).
    const beginDrag = (hit, isMultiMove) => {
      const originals = new Map()
      if (isMultiMove) {
        for (const n of notesRef.current) {
          if (selectedNoteIdsRef.current.has(n.id)) {
            originals.set(n.id, { positionTicks: n.positionTicks, pitch: n.pitch, durationTicks: n.durationTicks })
          }
        }
        // Ensure anchor is in the map even if selection state was stale.
        if (!originals.has(hit.note.id)) {
          originals.set(hit.note.id, { positionTicks: hit.note.positionTicks, pitch: hit.note.pitch, durationTicks: hit.note.durationTicks })
        }
      } else {
        originals.set(hit.note.id, { positionTicks: hit.note.positionTicks, pitch: hit.note.pitch, durationTicks: hit.note.durationTicks })
      }
      dragStateRef.current = {
        action: hit.nearRight ? ACTION.RESIZE_NOTE : ACTION.MOVE_NOTES,
        startX: localX, startY: localY,
        scrollXAtStart: sX, scrollYAtStart: sY,
        anchorNoteId: hit.note.id,
        originals,
        previewDeltaTicks: 0,
        previewDeltaPitch: 0,
        origDurationTicks: hit.note.durationTicks,
        previewDurationTicks: hit.note.durationTicks,
      }
      setDragTick((t) => t + 1)
    }

    if (activeTool === 'pencil') {
      // Ctrl+drag on empty space (or over notes) = lasso selection
      if (modifiers.ctrl && !hit) {
        dragStateRef.current = {
          action: ACTION.LASSO,
          startWorldX: localX + sX, startWorldY: localY + sY,
          currentWorldX: localX + sX, currentWorldY: localY + sY,
          additive: e.shiftKey,
          baseSelection: new Set(selectedNoteIdsRef.current),
        }
        setDragTick((t) => t + 1)
        return
      }
      if (!hit) {
        const posTicks = pixelToTick(localX, modifiers)
        const pitch = pixelToPitch(localY)
        onPreviewNoteRef.current?.(pitch)
        onAddNoteRef.current?.({
          positionTicks: posTicks,
          durationTicks: stickyNoteLength,
          pitch,
          velocity: stickyVelocity,
        })
      } else {
        // Click existing note → select, begin drag
        const wasSelected = selectedNoteIdsRef.current.has(hit.note.id)
        if (!wasSelected) {
          setSelectedNoteIdsRef.current(new Set([hit.note.id]))
        }
        beginDrag(hit, wasSelected && selectedNoteIdsRef.current.size > 1)
      }
      return
    }

    if (activeTool === 'select') {
      if (hit) {
        if (e.shiftKey) {
          // Shift-click toggles selection; do NOT start a drag.
          const next = new Set(selectedNoteIdsRef.current)
          if (next.has(hit.note.id)) next.delete(hit.note.id)
          else next.add(hit.note.id)
          setSelectedNoteIdsRef.current(next)
          return
        }
        const wasSelected = selectedNoteIdsRef.current.has(hit.note.id)
        if (!wasSelected) {
          setSelectedNoteIdsRef.current(new Set([hit.note.id]))
        }
        onPreviewNoteRef.current?.(hit.note.pitch)
        beginDrag(hit, wasSelected && selectedNoteIdsRef.current.size > 1)
      } else {
        // Start lasso on empty space (no modifier needed in select mode)
        dragStateRef.current = {
          action: ACTION.LASSO,
          startWorldX: localX + sX, startWorldY: localY + sY,
          currentWorldX: localX + sX, currentWorldY: localY + sY,
          additive: e.shiftKey,
          baseSelection: e.shiftKey ? new Set(selectedNoteIdsRef.current) : new Set(),
        }
        setDragTick((t) => t + 1)
      }
    }
  }, [activeTool, stickyNoteLength, stickyVelocity, getLocalXY, pixelToTick, pixelToPitch])

  // Drag move/resize via window listeners — preview-only, commit-on-release.
  // All layout values and callbacks are read from refs to avoid stale closures.
  useEffect(() => {
    // Clamp tick/pitch deltas so no note in the group exits valid range.
    const clampGroupDeltas = (originals, deltaTicks, deltaPitch) => {
      let clampedTicks = deltaTicks
      if (clampedTicks < 0) {
        let minPos = Infinity
        for (const [, orig] of originals) {
          if (orig.positionTicks < minPos) minPos = orig.positionTicks
        }
        clampedTicks = Math.max(clampedTicks, -minPos)
      }
      let clampedPitch = deltaPitch
      if (clampedPitch !== 0) {
        let minP = Infinity, maxP = -Infinity
        for (const [, orig] of originals) {
          if (orig.pitch < minP) minP = orig.pitch
          if (orig.pitch > maxP) maxP = orig.pitch
        }
        if (clampedPitch > 0) clampedPitch = Math.min(clampedPitch, PITCH_MAX - maxP)
        else clampedPitch = Math.max(clampedPitch, PITCH_MIN - minP)
      }
      return { clampedTicks, clampedPitch }
    }

    const onMove = (e) => {
      const ds = dragStateRef.current
      if (!ds) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }

      if (ds.action === ACTION.LASSO) {
        ds.currentWorldX = localX + scrollXRef.current
        ds.currentWorldY = localY + scrollYRef.current
        setDragTick((t) => t + 1)
        return
      }

      if (ds.action === ACTION.MOVE_NOTES) {
        const ppb = pixelsPerBeatRef.current
        const pps = pixelsPerSemitoneRef.current
        // World-space delta: compensates for any scrolling during the drag so
        // the grabbed notes stay anchored to the cursor in pattern coordinates.
        const dx = (localX + scrollXRef.current) - (ds.startX + ds.scrollXAtStart)
        const dy = (localY + scrollYRef.current) - (ds.startY + ds.scrollYAtStart)
        const deltaBeats = dx / ppb
        const deltaPitch = -Math.round(dy / pps)

        // Snap the anchor's destination, then derive a grid-aligned tick delta
        // that is applied identically to every note in `originals`.
        const anchorOrig = ds.originals.get(ds.anchorNoteId)
        if (!anchorOrig) return
        const anchorNewBeat = snapBeatToGrid(
          Math.max(0, anchorOrig.positionTicks / PPQ + deltaBeats),
          modifiers
        )
        const snappedDeltaTicks = beatsToTicks(anchorNewBeat) - anchorOrig.positionTicks

        // Clamp so no note leaves valid range
        const { clampedTicks, clampedPitch } = clampGroupDeltas(ds.originals, snappedDeltaTicks, deltaPitch)

        if (clampedTicks !== ds.previewDeltaTicks || clampedPitch !== ds.previewDeltaPitch) {
          ds.previewDeltaTicks = clampedTicks
          ds.previewDeltaPitch = clampedPitch
          setDragTick((t) => t + 1)
        }
      } else if (ds.action === ACTION.RESIZE_NOTE) {
        const ppb = pixelsPerBeatRef.current
        const beatAtCursor = (localX + scrollXRef.current) / ppb
        const snapped = snapBeatToGrid(Math.max(0, beatAtCursor), modifiers)
        const anchorOrig = ds.originals.get(ds.anchorNoteId)
        if (!anchorOrig) return
        const newDur = Math.max(60, beatsToTicks(snapped) - anchorOrig.positionTicks)
        if (newDur !== ds.previewDurationTicks) {
          ds.previewDurationTicks = newDur
          setDragTick((t) => t + 1)
        }
      }
    }
    const onUp = () => {
      const ds = dragStateRef.current
      if (!ds) return
      if (ds.action === ACTION.MOVE_NOTES) {
        if (ds.previewDeltaTicks !== 0 || ds.previewDeltaPitch !== 0) {
          const moves = []
          for (const [noteId, orig] of ds.originals) {
            moves.push({
              noteId,
              positionTicks: orig.positionTicks + ds.previewDeltaTicks,
              pitch: orig.pitch + ds.previewDeltaPitch,
            })
          }
          // Single undo entry reverses all moves together.
          if (onMoveNotesBatchRef.current && moves.length > 1) {
            onMoveNotesBatchRef.current(moves)
          } else {
            for (const m of moves) onMoveNoteRef.current?.(m.noteId, m.positionTicks, m.pitch)
          }
        }
      } else if (ds.action === ACTION.RESIZE_NOTE) {
        if (ds.previewDurationTicks !== ds.origDurationTicks) {
          const deltaTicks = ds.previewDurationTicks - ds.origDurationTicks
          if (ds.originals.size > 1 && onResizeNotesBatchRef.current) {
            const resizes = []
            for (const [noteId, orig] of ds.originals) {
              resizes.push({
                noteId,
                durationTicks: Math.max(60, orig.durationTicks + deltaTicks),
              })
            }
            onResizeNotesBatchRef.current(resizes)
          } else {
            onResizeNoteRef.current?.(ds.anchorNoteId, ds.previewDurationTicks)
          }
          setStickyNoteLengthRef.current?.(ds.previewDurationTicks)
        }
      } else if (ds.action === ACTION.LASSO) {
        // Compute notes whose bbox intersects the lasso rect (world-space)
        const x0 = Math.min(ds.startWorldX, ds.currentWorldX)
        const x1 = Math.max(ds.startWorldX, ds.currentWorldX)
        const y0 = Math.min(ds.startWorldY, ds.currentWorldY)
        const y1 = Math.max(ds.startWorldY, ds.currentWorldY)
        const ppb = pixelsPerBeatRef.current
        const pps = pixelsPerSemitoneRef.current
        const hitIds = new Set(ds.additive ? ds.baseSelection : [])
        for (const note of notesRef.current) {
          const nx = (note.positionTicks / PPQ) * ppb
          const nw = Math.max(2, (note.durationTicks / PPQ) * ppb)
          const ny = (PITCH_MAX - note.pitch) * pps
          const nh = pps
          // AABB intersection
          if (nx < x1 && nx + nw > x0 && ny < y1 && ny + nh > y0) {
            hitIds.add(note.id)
          }
        }
        setSelectedNoteIdsRef.current(hitIds)
      }
      dragStateRef.current = null
      setDragTick((t) => t + 1)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Overlay canvas: draw drag ghost on top of the content layer.
  useEffect(() => {
    const ov = ovRef.current?.getContext('2d')
    if (!ov) return
    const dpr = window.devicePixelRatio || 1
    ov.setTransform(dpr, 0, 0, dpr, 0, 0)
    ov.clearRect(0, 0, width, height)
    const ds = dragStateRef.current
    if (!ds) return
    const hex = tokenValue('--theme-label-pitch')

    if (ds.action === ACTION.MOVE_NOTES) {
      ov.fillStyle = hexToRgba(hex, 0.55)
      ov.strokeStyle = tokenValue('--theme-fg-inverse')
      ov.lineWidth = 1.5
      ov.setLineDash([4, 3])
      for (const [, orig] of ds.originals) {
        const newPosTicks = orig.positionTicks + ds.previewDeltaTicks
        const newPitch = orig.pitch + ds.previewDeltaPitch
        const beat = newPosTicks / PPQ
        const durBeats = orig.durationTicks / PPQ
        const x = beat * pixelsPerBeat - scrollX
        const wid = Math.max(2, durBeats * pixelsPerBeat)
        const y = (PITCH_MAX - newPitch) * pixelsPerSemitone - scrollY
        if (x + wid < 0 || x > width || y + pixelsPerSemitone < 0 || y > height) continue
        ov.fillRect(x, y + 1, wid, pixelsPerSemitone - 2)
        ov.strokeRect(x + 0.5, y + 1.5, wid - 1, pixelsPerSemitone - 3)
      }
      ov.setLineDash([])
    } else if (ds.action === ACTION.RESIZE_NOTE) {
      const anchorOrig = ds.originals.get(ds.anchorNoteId)
      if (!anchorOrig) return
      const deltaTicks = ds.previewDurationTicks - ds.origDurationTicks
      ov.fillStyle = hexToRgba(hex, 0.55)
      ov.strokeStyle = tokenValue('--theme-fg-inverse')
      ov.lineWidth = 1.5
      ov.setLineDash([4, 3])
      for (const [, orig] of ds.originals) {
        const newDur = Math.max(60, orig.durationTicks + deltaTicks)
        const beat = orig.positionTicks / PPQ
        const durBeats = newDur / PPQ
        const x = beat * pixelsPerBeat - scrollX
        const wid = Math.max(2, durBeats * pixelsPerBeat)
        const y = (PITCH_MAX - orig.pitch) * pixelsPerSemitone - scrollY
        if (x + wid < 0 || x > width || y + pixelsPerSemitone < 0 || y > height) continue
        ov.fillRect(x, y + 1, wid, pixelsPerSemitone - 2)
        ov.strokeRect(x + 0.5, y + 1.5, wid - 1, pixelsPerSemitone - 3)
      }
      ov.setLineDash([])
    } else if (ds.action === ACTION.LASSO) {
      // Convert world-space lasso coords to screen-space for rendering
      const sx0 = ds.startWorldX - scrollX
      const sy0 = ds.startWorldY - scrollY
      const sx1 = ds.currentWorldX - scrollX
      const sy1 = ds.currentWorldY - scrollY
      const x0 = Math.min(sx0, sx1)
      const x1 = Math.max(sx0, sx1)
      const y0 = Math.min(sy0, sy1)
      const y1 = Math.max(sy0, sy1)
      ov.fillStyle = tokenValue('--theme-pianoroll-note-slide-stroke')
      ov.fillRect(x0, y0, x1 - x0, y1 - y0)
      ov.strokeStyle = tokenValue('--theme-border-focus')
      ov.lineWidth = 1
      ov.setLineDash([4, 3])
      ov.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1)
      ov.setLineDash([])
    }
  }, [dragTick, width, height, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY])

  const cursor = activeTool === 'pencil' ? 'crosshair'
               : activeTool === 'delete' ? 'not-allowed'
               : activeTool === 'split'  ? 'col-resize'
               : 'default'

  return (
    <div
      ref={containerRef}
      className="piano-roll-canvas-container"
      style={{
        position: 'relative',
        width,
        height,
        overflow: 'hidden',
        cursor,
      }}
      onMouseDown={handleMouseDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={bgRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={ctRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={ovRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
}

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { PPQ, snapBeatToGrid, beatsToTicks, beatToPixel, pixelToBeat } from '../../constants/timeline.js'
import { PITCH_MIN, PITCH_MAX, isBlackKey, pitchLabel } from './PianoRollKeyboard.jsx'
import { tokenValue } from '../../theming/tokenValue.ts'
import { DEFAULT_SCALE, isPitchInScale, snapPitchToScale } from './scales.js'

const RESIZE_HANDLE_PX = 6

// Canvas colors are resolved at draw time because CSS variables cannot be
// passed directly to CanvasRenderingContext2D.
function resolvePalette() {
  return {
    bg: tokenValue('--theme-pianoroll-grid-bg') || '#111118',
    rowWhite: tokenValue('--theme-pianoroll-key-white-bg') || '#15151C',
    rowBlack: tokenValue('--theme-pianoroll-key-black-bg') || '#0A0A10',
    line16: tokenValue('--theme-pianoroll-subdivision-line') || 'rgba(255,255,255,0.04)',
    lineBeat: tokenValue('--theme-pianoroll-beat-line') || 'rgba(255,255,255,0.06)',
    lineBar: tokenValue('--theme-pianoroll-bar-line') || 'rgba(255,255,255,0.14)',
    octaveLine: tokenValue('--theme-border-subtle') || '#2A2A38',
    accent: tokenValue('--theme-accent') || '#33CED6',
    patternOverlay: tokenValue('--theme-overlay-subtle') || 'rgba(0,0,0,0.25)',
    patternBorder: tokenValue('--theme-snap-ghost-border') || 'rgba(51,206,214,0.4)',
    noteSlide: tokenValue('--theme-pianoroll-note-slide-fill') || '#E64FE6',
    noteLabel: tokenValue('--theme-text-on-accent') || '#0D0D14',
    noteGhost: tokenValue('--theme-success') || '#3FB27A',
    noteSelStroke: tokenValue('--theme-accent') || '#33CED6',
    lassoFill: tokenValue('--theme-pianoroll-selection-rect') || 'rgba(51,206,214,0.18)',
    lassoStroke: tokenValue('--theme-accent') || '#33CED6',
    outOfScale: tokenValue('--theme-overlay-subtle') || 'rgba(0,0,0,0.25)',
  }
}

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

// Find the first dropped FL Studio Score (.fsc) file by name extension.
// Presentational only: returns the File so the owner can resolve/parse it.
export function extractFscFile(dataTransfer) {
  const files = Array.from(dataTransfer?.files || [])
  return files.find((file) => file.name.toLowerCase().endsWith('.fsc')) || null
}

// Drop handler logic, factored out so it can be unit-tested without a DOM.
// Detects an .fsc file and hands the raw File up via onDropFsc — it never
// parses, never touches window.xleth, and never mutates notes.
export function handleFscDropEvent(e, onDropFsc) {
  e.preventDefault()
  const fsc = extractFscFile(e.dataTransfer)
  if (fsc) onDropFsc?.(fsc)
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

function drawBackground(ctx, w, h, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, patternLenBeats, palette, scale) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, w, h)

  // Flat horizontal row striping — every row gets a fill: white-key rows a
  // touch lighter than black-key rows. No per-row hairlines (the stripe
  // contrast carries the rhythm); only the octave (C) boundary draws a line.
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    const y = (PITCH_MAX - p) * pixelsPerSemitone - scrollY
    if (y + pixelsPerSemitone < 0 || y > h) continue
    ctx.fillStyle = isBlackKey(p) ? palette.rowBlack : palette.rowWhite
    ctx.fillRect(0, y, w, pixelsPerSemitone)
  }

  // Scale lock: dim every row outside the active scale so the playable rows
  // read at a glance. Purely a veil over the stripes above — note drawing and
  // grid lines still paint on top.
  if (scale?.enabled) {
    ctx.fillStyle = palette.outOfScale
    for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
      const y = (PITCH_MAX - p) * pixelsPerSemitone - scrollY
      if (y + pixelsPerSemitone < 0 || y > h) continue
      if (isPitchInScale(p, scale.root, scale.mode)) continue
      ctx.fillRect(0, y, w, pixelsPerSemitone)
    }
  }

  ctx.strokeStyle = palette.octaveLine
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let p = PITCH_MAX; p >= PITCH_MIN; p--) {
    if ((p % 12) !== 0) continue
    const y = (PITCH_MAX - p) * pixelsPerSemitone - scrollY
    if (y < -pixelsPerSemitone || y > h) continue
    ctx.moveTo(0, Math.round(y + pixelsPerSemitone) + 0.5)
    ctx.lineTo(w, Math.round(y + pixelsPerSemitone) + 0.5)
  }
  ctx.stroke()

  const startBeat = Math.floor(scrollX / pixelsPerBeat)
  const endBeat = Math.ceil((scrollX + w) / pixelsPerBeat) + 1

  // 1/16 subdivisions (faintest)
  ctx.strokeStyle = palette.line16
  ctx.lineWidth = 1
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

  // Beat lines (every quarter that isn't a bar boundary)
  ctx.strokeStyle = palette.lineBeat
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let b = startBeat; b <= endBeat; b++) {
    if (b % 4 === 0) continue
    const x = Math.round(b * pixelsPerBeat - scrollX) + 0.5
    if (x < 0 || x > w) continue
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Bar lines (brightest)
  ctx.strokeStyle = palette.lineBar
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let b = startBeat; b <= endBeat; b++) {
    if (b % 4 !== 0) continue
    const x = Math.round(b * pixelsPerBeat - scrollX) + 0.5
    if (x < 0 || x > w) continue
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Pattern-length marker (dim region past pattern end) — flat, no top shadow.
  if (patternLenBeats > 0) {
    const endX = patternLenBeats * pixelsPerBeat - scrollX
    if (endX < w) {
      ctx.fillStyle = palette.patternOverlay
      ctx.fillRect(Math.max(0, endX), 0, w - endX, h)
      ctx.strokeStyle = palette.patternBorder
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(endX + 0.5, 0)
      ctx.lineTo(endX + 0.5, h)
      ctx.stroke()
    }
  }
}

function drawNotes(ctx, w, h, notes, selectedNoteIds, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, palette) {
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const beat = note.positionTicks / PPQ
    const durBeats = note.durationTicks / PPQ
    const x = beat * pixelsPerBeat - scrollX
    const wid = Math.max(2, durBeats * pixelsPerBeat)
    const y = (PITCH_MAX - note.pitch) * pixelsPerSemitone - scrollY
    if (x + wid < 0 || x > w || y + pixelsPerSemitone < 0 || y > h) continue

    const selected = selectedNoteIds?.has(note.id)
    const vel = Math.max(0, Math.min(1, note.velocity ?? 1.0))
    const bodyH = pixelsPerSemitone - 2

    // Flat note body: green, with velocity mapped to lightness (louder = brighter).
    // Slide notes keep their magenta identity. No highlight/shadow bands — the
    // 1px stroke alone gives the note its edge.
    if (note.isSlide) {
      ctx.fillStyle = palette.noteSlide
      ctx.strokeStyle = palette.noteSlide
    } else {
      ctx.fillStyle = `hsl(128 33% ${(26 + vel * 30).toFixed(1)}%)`
      ctx.strokeStyle = `hsl(128 38% ${(40 + vel * 28).toFixed(1)}%)`
    }
    ctx.fillRect(x, y + 1, wid, bodyH)
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 1.5, wid - 1, bodyH - 1)

    // Pitch label inside the note when there's room (mockup labels longer notes).
    if (!note.isSlide && wid >= 22 && bodyH >= 9) {
      ctx.fillStyle = palette.noteLabel
      ctx.font = '500 8px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(pitchLabel(note.pitch), x + 3, y + pixelsPerSemitone / 2 + 0.5)
    }

    // Selection: a crisp 1px teal outline, inset so it hugs the note edge.
    if (selected) {
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 1.5, wid - 1, bodyH - 1)
    }
  }
}

// pixelsPerBeatRef/pixelsPerSemitoneRef/scrollXRef/scrollYRef are REF OBJECTS
// owned by PianoRoll.jsx (not value props) — its view animator writes them
// every frame without a re-render, exactly like TimelineCanvas's
// pixelsPerBeatRef/scrollOffsetRef. A value prop would only be as fresh as
// the last (debounced) render, which is stale mid-gesture.
const PianoRollCanvas = forwardRef(function PianoRollCanvas({
  patternId,
  notes, patternLengthTicks,
  activeTool, slideMode = false, stickyNoteLength, setStickyNoteLength, stickyVelocity = 1.0, setStickyVelocity,
  selectedNoteIds, setSelectedNoteIds,
  pixelsPerBeatRef, pixelsPerSemitoneRef, scrollXRef, scrollYRef,
  width, height,
  onAddNote, onRemoveNote, onMoveNote, onMoveNotesBatch, onResizeNote, onResizeNotesBatch, onPreviewNote,
  onDropFsc,
  scale = DEFAULT_SCALE,
}, ref) {
  const bgRef = useRef(null)
  const ctRef = useRef(null)
  const ovRef = useRef(null)
  const containerRef = useRef(null)

  const dragStateRef = useRef(null)
  const [dragTick, setDragTick] = useState(0)
  // Bumped when the active theme changes so the existing draw effects rerun
  // with fresh tokenValue() reads. The canvas would otherwise hold stale
  // colors until the next scroll/zoom/resize/note edit.
  const [themeTick, setThemeTick] = useState(0)
  const notesRef = useRef(notes)
  notesRef.current = notes
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
  const slideModeRef = useRef(slideMode)
  slideModeRef.current = slideMode
  const scaleRef = useRef(scale)
  scaleRef.current = scale

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

  // Imperative redraw: reads pixelsPerBeat/scrollX/scrollY from refs (NOT
  // props) so it draws the CURRENT value regardless of whether it's called
  // from the effect below (notes/selection/size/theme changes) or directly
  // from PianoRoll's view animator onTick (60fps during a zoom/scroll
  // gesture — must never go through React state/props for that path).
  function redraw() {
    const bg = bgRef.current?.getContext('2d')
    const ct = ctRef.current?.getContext('2d')
    if (!bg || !ct) return
    const dpr = window.devicePixelRatio || 1
    bg.setTransform(dpr, 0, 0, dpr, 0, 0)
    ct.setTransform(dpr, 0, 0, dpr, 0, 0)
    const lenBeats = patternLengthTicks / PPQ
    const palette = resolvePalette()
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current
    drawBackground(bg, width, height, ppb, pps, sX, sY, lenBeats, palette, scaleRef.current)
    ct.clearRect(0, 0, width, height)
    drawNotes(ct, width, height, notesRef.current, selectedNoteIdsRef.current, ppb, pps, sX, sY, palette)
  }

  // ON-SETTLE-ish: redraw when anything OTHER than pixelsPerBeat/scrollX/
  // scrollY changes. Those three are driven imperatively (per-frame, via the
  // exposed redraw() below) by PianoRoll's view animator — including them
  // here would mean every animation frame also forces a React render just
  // to reach this effect, the exact thing the animator refactor removes.
  useEffect(() => {
    redraw()
  }, [notes, selectedNoteIds, width, height, patternLengthTicks, themeTick,
      scale.enabled, scale.root, scale.mode])

  // Redraw all canvases when the active theme changes — tokenValue() reads
  // CSS variables at draw time, but the draw effects only rerun on prop/state
  // changes, so without this listener the canvas keeps its old palette until
  // the user interacts. Mirrors the pattern in VideoPreview.jsx.
  useEffect(() => {
    const onThemeChange = () => setThemeTick((t) => t + 1)
    window.addEventListener('xleth-theme-changed', onThemeChange)
    return () => window.removeEventListener('xleth-theme-changed', onThemeChange)
  }, [])

  const getLocalXY = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { localX: e.clientX - rect.left, localY: e.clientY - rect.top }
  }, [])

  // Row under the cursor, clamped to the keyboard range. With Snap to Scale on,
  // the row is pulled to the nearest scale tone so a note can only ever be
  // placed on a degree of the active scale.
  const pixelToPitch = useCallback((localY) => {
    const pitch = PITCH_MAX - Math.floor((localY + scrollYRef.current) / pixelsPerSemitoneRef.current)
    const clamped = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
    const sc = scaleRef.current
    if (!sc?.enabled) return clamped
    return snapPitchToScale(clamped, sc.root, sc.mode, PITCH_MIN, PITCH_MAX)
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
          ...(slideModeRef.current && { isSlide: true, slideCurveCx: 0.5, slideCurveCy: 0.5 }),
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
        let deltaPitch = -Math.round(dy / pps)

        // Snap the anchor's destination, then derive a grid-aligned tick delta
        // that is applied identically to every note in `originals`.
        const anchorOrig = ds.originals.get(ds.anchorNoteId)
        if (!anchorOrig) return

        // Scale lock: snap the ANCHOR's destination row to the nearest scale
        // tone and reuse that pitch delta for the whole group, so a multi-note
        // drag keeps its intervals instead of collapsing onto scale degrees.
        const sc = scaleRef.current
        if (sc?.enabled && deltaPitch !== 0) {
          const dest = Math.max(PITCH_MIN, Math.min(PITCH_MAX, anchorOrig.pitch + deltaPitch))
          deltaPitch = snapPitchToScale(dest, sc.root, sc.mode, PITCH_MIN, PITCH_MAX) - anchorOrig.pitch
        }
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

  // Overlay canvas: draw drag ghost on top of the content layer. Same
  // refs-not-props rule as redraw() above — this must also track the
  // animator's per-frame ppb/scrollX/scrollY without a React render.
  function redrawOverlayLayer() {
    const ov = ovRef.current?.getContext('2d')
    if (!ov) return
    const dpr = window.devicePixelRatio || 1
    ov.setTransform(dpr, 0, 0, dpr, 0, 0)
    ov.clearRect(0, 0, width, height)
    const ds = dragStateRef.current
    if (!ds) return
    const palette = resolvePalette()
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current

    if (ds.action === ACTION.MOVE_NOTES) {
      ov.fillStyle = hexToRgba(palette.noteGhost, 0.55)
      ov.strokeStyle = palette.noteSelStroke
      ov.lineWidth = 1.5
      ov.setLineDash([4, 3])
      for (const [, orig] of ds.originals) {
        const newPosTicks = orig.positionTicks + ds.previewDeltaTicks
        const newPitch = orig.pitch + ds.previewDeltaPitch
        const beat = newPosTicks / PPQ
        const durBeats = orig.durationTicks / PPQ
        const x = beat * ppb - sX
        const wid = Math.max(2, durBeats * ppb)
        const y = (PITCH_MAX - newPitch) * pps - sY
        if (x + wid < 0 || x > width || y + pps < 0 || y > height) continue
        ov.fillRect(x, y + 1, wid, pps - 2)
        ov.strokeRect(x + 0.5, y + 1.5, wid - 1, pps - 3)
      }
      ov.setLineDash([])
    } else if (ds.action === ACTION.RESIZE_NOTE) {
      const anchorOrig = ds.originals.get(ds.anchorNoteId)
      if (!anchorOrig) return
      const deltaTicks = ds.previewDurationTicks - ds.origDurationTicks
      ov.fillStyle = hexToRgba(palette.noteGhost, 0.55)
      ov.strokeStyle = palette.noteSelStroke
      ov.lineWidth = 1.5
      ov.setLineDash([4, 3])
      for (const [, orig] of ds.originals) {
        const newDur = Math.max(60, orig.durationTicks + deltaTicks)
        const beat = orig.positionTicks / PPQ
        const durBeats = newDur / PPQ
        const x = beat * ppb - sX
        const wid = Math.max(2, durBeats * ppb)
        const y = (PITCH_MAX - orig.pitch) * pps - sY
        if (x + wid < 0 || x > width || y + pps < 0 || y > height) continue
        ov.fillRect(x, y + 1, wid, pps - 2)
        ov.strokeRect(x + 0.5, y + 1.5, wid - 1, pps - 3)
      }
      ov.setLineDash([])
    } else if (ds.action === ACTION.LASSO) {
      // Convert world-space lasso coords to screen-space for rendering
      const sx0 = ds.startWorldX - sX
      const sy0 = ds.startWorldY - sY
      const sx1 = ds.currentWorldX - sX
      const sy1 = ds.currentWorldY - sY
      const x0 = Math.min(sx0, sx1)
      const x1 = Math.max(sx0, sx1)
      const y0 = Math.min(sy0, sy1)
      const y1 = Math.max(sy0, sy1)
      ov.fillStyle = palette.lassoFill
      ov.fillRect(x0, y0, x1 - x0, y1 - y0)
      ov.strokeStyle = palette.lassoStroke
      ov.lineWidth = 1
      ov.setLineDash([4, 3])
      ov.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1)
      ov.setLineDash([])
    }
  }

  // ON-SETTLE-ish, same reasoning as the content redraw effect above.
  useEffect(() => {
    redrawOverlayLayer()
  }, [dragTick, themeTick, width, height])

  // Expose to parent (PianoRoll.jsx's view animator calls redraw() directly,
  // once per frame, bypassing React state/props entirely for ppb/scrollX/
  // scrollY — mirrors TimelineCanvas's redrawGrid/redrawContent pattern).
  useImperativeHandle(ref, () => ({
    redraw: () => { redraw(); redrawOverlayLayer() },
  }), [patternLengthTicks, width, height])

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
      onDrop={(e) => handleFscDropEvent(e, onDropFsc)}
      onDragOver={(e) => {
        // Browsers may not expose file names until drop — just confirm a file
        // drag is in progress and advertise a copy so the drop fires.
        if (Array.from(e.dataTransfer.types || []).includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
    >
      <canvas ref={bgRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={ctRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={ovRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
})

export default PianoRollCanvas

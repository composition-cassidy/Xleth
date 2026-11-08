import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { PPQ, snapBeatToGrid, beatsToTicks, ticksToBeats, beatToPixel, pixelToBeat } from '../../constants/timeline.js'
import { PITCH_MIN, PITCH_MAX, pitchLabel, visibleRows, gridTiers } from './pianoRollGeometry.js'
import { readPianoRollPalette } from './pianoRollPalette.js'
import { drawNotes, drawGhosts, noteStyle } from './pianoRollNotes.js'
import { DEFAULT_SCALE, isPitchInScale, snapPitchToScale } from './scales.js'

import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import styles from './PianoRoll.module.css'
const RESIZE_HANDLE_PX = 6       // screen px, each side of an editable edge (acceptable range 4-8)
const MIN_NOTE_HITBOX_PX = 6     // minimum grabbable width regardless of rendered/zoomed size
const MIN_NOTE_DURATION_TICKS = 60

// Debug mode is flag-gated and OFF by default — toggle live from devtools with
// `window.__pianoRollDebug = true`, or load with `?pianoRollDebug=1`. Draws
// hitbox/resize-zone overlays and logs pointerdown->first-redraw latency, so
// the interaction model can be verified against real numbers/pixels instead
// of taken on faith. Not read into a module-level constant: checked live so a
// runtime toggle takes effect on the very next frame.
function isPianoRollDebugEnabled() {
  if (typeof window === 'undefined') return false
  if (window.__pianoRollDebug != null) return !!window.__pianoRollDebug
  try {
    return new URLSearchParams(window.location.search).get('pianoRollDebug') === '1'
  } catch {
    return false
  }
}

// Canvas colours are resolved at draw time (pianoRollPalette.js).
function resolvePalette() {
  const base = readPianoRollPalette()
  return { ...base, lassoFill: base.lasso, lassoStroke: base.select }
}

const ACTION = {
  NONE: 'none',
  MOVE_NOTES: 'move-notes',
  RESIZE_NOTE: 'resize-note',
  LASSO: 'lasso',
  PAN: 'pan',
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

// Hit-test a note at local (screen-space, CSS-pixel) canvas coordinates.
// Screen-space throughout: x/w/y/localX/localY are all CSS px, so the 6px
// resize zone and the 6px minimum hitbox stay constant across zoom instead of
// drifting with pixelsPerBeat/pixelsPerSemitone the way a tick-domain
// tolerance would. The hitbox is widened evenly around the rendered rect's
// center when the note renders thinner than MIN_NOTE_HITBOX_PX, so a
// zoomed-out sliver stays grabbable without changing what gets drawn.
function resolveNoteHit(notes, localX, localY, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY) {
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]
    const beat = ticksToBeats(note.positionTicks)
    const durBeats = ticksToBeats(note.durationTicks)
    const renderX = beat * pixelsPerBeat - scrollX
    const renderW = Math.max(2, durBeats * pixelsPerBeat)
    const y = (PITCH_MAX - note.pitch) * pixelsPerSemitone - scrollY
    const hitW = Math.max(renderW, MIN_NOTE_HITBOX_PX)
    const x = renderX - (hitW - renderW) / 2
    if (localX < x || localX >= x + hitW || localY < y || localY >= y + pixelsPerSemitone) continue
    // Clamp the edge zone so two opposing zones can never exceed the note's
    // own hitbox width (relevant only for the thinnest slivers).
    const edgePx = Math.min(RESIZE_HANDLE_PX, hitW / 2)
    const nearRight = localX >= x + hitW - edgePx
    return { note, index: i, nearRight, x, y, w: hitW, renderX, renderW }
  }
  return null
}

// The single hit-resolution function: pointer (x,y) + tool -> intent + target
// note. Both the mousedown handler and the hover-cursor path call this exact
// function, so a click can never do something the cursor didn't already
// predict. Pure: every input is a plain value/ref-read, nothing is mutated.
export function resolvePointerIntent({
  localX, localY, notes, activeTool, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY,
}) {
  const hit = resolveNoteHit(notes, localX, localY, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY)

  if (activeTool === 'delete') {
    return hit ? { intent: 'delete', note: hit.note, hit } : { intent: 'none', note: null, hit: null }
  }
  if (activeTool === 'split') {
    return hit ? { intent: 'split', note: hit.note, hit } : { intent: 'none', note: null, hit: null }
  }
  if (!hit) {
    // 'draw' only for the pencil tool; select-tool empty space starts a lasso.
    return { intent: activeTool === 'pencil' ? 'draw' : 'lasso', note: null, hit: null }
  }
  // Resize-edge zone takes priority over the note body (checked inside
  // resolveNoteHit itself, since it's evaluated before falling through to
  // 'move' here) — satisfies resize > body > empty-space priority.
  return hit.nearRight
    ? { intent: 'resize-right', note: hit.note, hit }
    : { intent: 'move', note: hit.note, hit }
}

// Cursor for a resolved intent — used for hover prediction. Falls back to the
// tool's baseline cursor for 'none'/'lasso' so per-tool defaults (e.g. delete
// tool always showing not-allowed) are unchanged from before this rebuild.
export function cursorForIntent(intent, activeTool) {
  if (intent === 'resize-right') return 'ew-resize'
  if (intent === 'move') return 'grab'
  if (intent === 'delete') return 'not-allowed'
  if (intent === 'split') return 'col-resize'
  if (intent === 'draw') return 'crosshair'
  if (activeTool === 'delete') return 'not-allowed'
  if (activeTool === 'split') return 'col-resize'
  if (activeTool === 'pencil') return 'crosshair'
  return 'default'
}

// Grid: row stripes (black-key rows are the darker ground), an in-scale lift
// when a scale is set, octave lines, then three line tiers chosen by
// gridTiers() so lines never sit closer than 6px: bars strongest, beats
// lighter, 16th steps faintest. Past the pattern end the grid is flat ground
// with half-strength bar lines and a 1px ink-2 end line.
function strokeVerticals(ctx, xs, h, style) {
  if (!xs.length) return
  ctx.strokeStyle = style
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const x of xs) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()
}

function drawBackground(ctx, w, h, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY, patternLenBeats, palette, scale) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = palette.gridBg
  ctx.fillRect(0, 0, w, h)

  const rows = visibleRows(pixelsPerSemitone, scrollY, h)
  for (const { y, black } of rows) {
    ctx.fillStyle = black ? palette.rowBlack : palette.rowWhite
    ctx.fillRect(0, y, w, pixelsPerSemitone)
  }

  // Scale set: in-scale rows are lifted toward ink (lighter in dark themes,
  // stronger in light ones), so the playable rows read at a glance while the
  // black-key shading stays visible underneath.
  if (scale?.enabled) {
    ctx.save()
    ctx.globalAlpha = 0.07
    ctx.fillStyle = palette.ink
    for (const { pitch, y } of rows) {
      if (isPitchInScale(pitch, scale.root, scale.mode)) ctx.fillRect(0, y, w, pixelsPerSemitone)
    }
    ctx.restore()
  }

  // Octave boundary under every C.
  ctx.fillStyle = palette.g4
  for (const { pitch, y } of rows) {
    if ((pitch % 12) === 0) ctx.fillRect(0, Math.round(y + pixelsPerSemitone) - 1, w, 1)
  }

  const endX = patternLenBeats > 0 ? patternLenBeats * pixelsPerBeat - scrollX : Infinity
  if (endX < w) {
    ctx.fillStyle = palette.gridBg
    ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), h)
  }

  const tiers = gridTiers(pixelsPerBeat)
  const startBeat = Math.max(0, Math.floor(scrollX / pixelsPerBeat))
  const endBeat = Math.ceil((scrollX + w) / pixelsPerBeat) + 1
  const steps = []
  const beats = []
  const bars = []
  const pastBars = []
  for (let b = startBeat; b <= endBeat; b++) {
    const x = Math.round(b * pixelsPerBeat - scrollX) + 0.5
    if (x < 0 || x > w) continue
    const isBar = b % 4 === 0
    if (isBar) {
      if ((b / 4) % tiers.barEvery !== 0) continue
      if (x < endX) bars.push(x)
      else if (x > endX + 0.5) pastBars.push(x)
    } else if (tiers.beats && x < endX) {
      beats.push(x)
    }
    if (tiers.steps) {
      for (let sub = 1; sub < 4; sub++) {
        const sx = Math.round((b + sub / 4) * pixelsPerBeat - scrollX) + 0.5
        if (sx >= 0 && sx <= w && sx < endX) steps.push(sx)
      }
    }
  }
  strokeVerticals(ctx, steps, h, palette.lineStep)
  strokeVerticals(ctx, beats, h, palette.lineBeat)
  strokeVerticals(ctx, bars, h, palette.lineBar)
  if (pastBars.length) {
    ctx.save()
    ctx.globalAlpha = 0.5
    strokeVerticals(ctx, pastBars, h, palette.lineBar)
    ctx.restore()
  }
  if (endX >= 0 && endX < w) {
    ctx.fillStyle = palette.ink2
    ctx.fillRect(Math.round(endX), 0, 1, h)
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
  noteColor = null, labelMode = 'pitch', refSlot = null, ghosts = null,
  snap = '1/16', onPan,
}, ref) {
  const dprEpoch = useThemeEpoch() // Phase 7: re-size and redraw at the new devicePixelRatio when the UI scale changes
  const bgRef = useRef(null)
  const ctRef = useRef(null)
  const ovRef = useRef(null)
  const containerRef = useRef(null)

  // Drag/lasso gesture state. Mutated directly by the pointer handlers and
  // read directly by redrawOverlayLayer() — never routed through React state,
  // so a pointermove's redraw is synchronous with the event, not deferred to
  // React's next commit+effect pass.
  const dragStateRef = useRef(null)
  // Fallback in case a committed drag's bridge round-trip never lands (a
  // failed/offline call, a null patternId) — see the "settling" comment on
  // handlePointerUp below. Without this a stuck settle would hide the note
  // from the content layer forever.
  const settleTimeoutRef = useRef(null)
  useEffect(() => () => clearTimeout(settleTimeoutRef.current), [])
  // Hover-only (no active gesture) intent, kept only for the debug hitbox
  // overlay — cleared whenever debug mode is off.
  const hoverDebugRef = useRef(null)
  // Bumped when the active theme changes so the existing draw effects rerun
  // with fresh tokenValue() reads. The canvas would otherwise hold stale
  // colors until the next scroll/zoom/resize/note edit.
  const [themeTick, setThemeTick] = useState(0)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const activeToolRef = useRef(activeTool)
  activeToolRef.current = activeTool
  // Canvas size mirrored into refs for the same reason every other draw input
  // is: the pointer handlers are stable useCallbacks, so a `width`/`height`
  // PROP read inside them is frozen at the first render — which is PianoRoll's
  // 800x500 placeholder, before its ResizeObserver reports the real panel size.
  // A stale size there under-clears the overlay (drag ghosts smear) and
  // wrongly viewport-culls the live preview (it appears to freeze mid-drag).
  const widthRef = useRef(width)
  widthRef.current = width
  const heightRef = useRef(height)
  heightRef.current = height
  const patternLengthTicksRef = useRef(patternLengthTicks)
  patternLengthTicksRef.current = patternLengthTicks
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
  const snapRef = useRef(snap)
  snapRef.current = snap
  const onPanRef = useRef(onPan)
  onPanRef.current = onPan
  // Note look (step 12.3): read by both draw paths from refs, like every other
  // draw input, so the imperative per-frame redraw never sees stale values.
  const lookRef = useRef(null)
  lookRef.current = { noteColor, labelMode, refSlot, ghosts }
  const noteStyleFor = (palette) => noteStyle({
    color: lookRef.current.noteColor, palette, labelMode: lookRef.current.labelMode, refSlot: lookRef.current.refSlot,
  })

  // Apply DPR sizing
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    ;[bgRef, ctRef, ovRef].forEach((r) => {
      const c = r.current
      if (!c) return
      // Backing store only: the CSS box is the cell (styles.layer), so no
      // inline size is written.
      c.width = Math.max(1, Math.round(width * dpr))
      c.height = Math.max(1, Math.round(height * dpr))
      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    })
  }, [width, height, dprEpoch])

  // Imperative redraw: reads pixelsPerBeat/scrollX/scrollY from refs (NOT
  // props) so it draws the CURRENT value regardless of whether it's called
  // from the effect below (notes/selection/size/theme changes) or directly
  // from PianoRoll's view animator onTick (60fps during a zoom/scroll
  // gesture — must never go through React state/props for that path).
  // The notes a live gesture has lifted off the content layer: they are drawn
  // by the overlay at their preview position for the duration of the drag.
  function draggedNoteIds() {
    const ds = dragStateRef.current
    if (!ds || ds.action === ACTION.LASSO || ds.action === ACTION.PAN) return null
    return new Set(ds.originals.keys())
  }

  function redraw() {
    const bg = bgRef.current?.getContext('2d')
    const ct = ctRef.current?.getContext('2d')
    if (!bg || !ct) return
    const w = widthRef.current
    const h = heightRef.current
    const dpr = window.devicePixelRatio || 1
    bg.setTransform(dpr, 0, 0, dpr, 0, 0)
    ct.setTransform(dpr, 0, 0, dpr, 0, 0)
    const lenBeats = ticksToBeats(patternLengthTicksRef.current)
    const palette = resolvePalette()
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current
    drawBackground(bg, w, h, ppb, pps, sX, sY, lenBeats, palette, scaleRef.current)
    ct.clearRect(0, 0, w, h)
    const style = noteStyleFor(palette)
    drawGhosts(ct, w, h, lookRef.current.ghosts, ppb, pps, sX, sY, style)
    drawNotes(ct, w, h, notesRef.current, selectedNoteIdsRef.current, ppb, pps, sX, sY, style, draggedNoteIds())
  }

  // Clears a "settling" drag (see handlePointerUp) the moment the `notes`
  // prop actually reflects the committed edit. Declared BEFORE the content
  // redraw effect below so both run in the same commit, in this order: this
  // one drops dragStateRef so draggedNoteIds() stops hiding the note, THEN
  // the content effect draws it fresh from the now-authoritative `notes` —
  // no intermediate frame where the note is drawn at its old position.
  useEffect(() => {
    if (!dragStateRef.current?.settling) return
    dragStateRef.current = null
    clearTimeout(settleTimeoutRef.current)
    redrawOverlayLayer()
  }, [notes])

  // ON-SETTLE-ish: redraw when anything OTHER than pixelsPerBeat/scrollX/
  // scrollY changes. Those three are driven imperatively (per-frame, via the
  // exposed redraw() below) by PianoRoll's view animator — including them
  // here would mean every animation frame also forces a React render just
  // to reach this effect, the exact thing the animator refactor removes.
  useEffect(() => {
    redraw()
  }, [notes, selectedNoteIds, width, height, patternLengthTicks, themeTick, dprEpoch,
      scale.enabled, scale.root, scale.mode, noteColor, labelMode, refSlot, ghosts])

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
    const snapped = snapBeatToGrid(Math.max(0, beat), modifiers, snapRef.current)
    return beatsToTicks(snapped)
  }, [])

  // Begins a gesture and gives it its first (synchronous) redraw, so the ghost
  // appears in the same frame as the mousedown — never through a setState+
  // effect round trip. Debug mode times exactly that gap.
  const startGesture = useCallback((e, dragState) => {
    dragStateRef.current = dragState
    if (containerRef.current) {
      try { containerRef.current.setPointerCapture(e.pointerId) } catch { /* already captured/released */ }
      containerRef.current.dataset.cursor = dragState.action === ACTION.RESIZE_NOTE ? 'ew-resize'
        : dragState.action === ACTION.LASSO ? 'crosshair'
        : 'grabbing'
    }
    // Content layer redraws once here to lift the dragged notes off it; the
    // overlay carries them for the rest of the gesture, so every subsequent
    // pointermove only has to repaint the overlay.
    redraw()
    redrawOverlayLayer()
    if (isPianoRollDebugEnabled()) {
      const latencyMs = performance.now() - e.timeStamp
      console.log(`[pianoroll-debug] pointerdown→firstRedraw action=${dragState.action} ${latencyMs.toFixed(3)}ms`)
    }
  }, [])

  const handlePointerDown = useCallback((e) => {
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current

    // Right-click = delete (FL-style), works with any tool, immediately.
    // Middle-drag pans both axes (approved at the step 12 checkpoint). Captured
    // like any gesture; the view moves 1:1 with the pointer, nothing is edited.
    if (e.button === 1) {
      e.preventDefault()
      dragStateRef.current = {
        action: ACTION.PAN,
        startClientX: e.clientX, startClientY: e.clientY,
        scrollXAtStart: sX, scrollYAtStart: sY,
      }
      if (containerRef.current) {
        try { containerRef.current.setPointerCapture(e.pointerId) } catch { /* jsdom */ }
        containerRef.current.dataset.cursor = 'move'
      }
      return
    }
    if (e.button === 2) {
      e.preventDefault()
      const pos = getLocalXY(e)
      if (!pos) return
      const hit = resolveNoteHit(notesRef.current, pos.localX, pos.localY, ppb, pps, sX, sY)
      if (hit) onRemoveNoteRef.current?.(hit.note.id)
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    const pos = getLocalXY(e)
    if (!pos) return
    const { localX, localY } = pos
    const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
    const hit = resolveNoteHit(notesRef.current, localX, localY, ppb, pps, sX, sY)

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
    // Zero drag threshold: this fires straight from mousedown, no pixel dead
    // zone — the very first pointermove already moves the note.
    // Full note copies, not just the three edited fields: the overlay renders
    // the live preview through drawNotes(), which also needs id/velocity/
    // isSlide to draw the note exactly as the content layer would.
    const beginDrag = (hit, isMultiMove) => {
      const originals = new Map()
      if (isMultiMove) {
        for (const n of notesRef.current) {
          if (selectedNoteIdsRef.current.has(n.id)) originals.set(n.id, { ...n })
        }
        // Ensure anchor is in the map even if selection state was stale.
        if (!originals.has(hit.note.id)) originals.set(hit.note.id, { ...hit.note })
      } else {
        originals.set(hit.note.id, { ...hit.note })
      }
      startGesture(e, {
        action: hit.nearRight ? ACTION.RESIZE_NOTE : ACTION.MOVE_NOTES,
        startX: localX, startY: localY,
        scrollXAtStart: sX, scrollYAtStart: sY,
        anchorNoteId: hit.note.id,
        originals,
        previewDeltaTicks: 0,
        previewDeltaPitch: 0,
        origDurationTicks: hit.note.durationTicks,
        previewDurationTicks: hit.note.durationTicks,
        snapBypassed: modifiers.alt,
      })
    }

    if (activeTool === 'pencil') {
      // Ctrl+drag on empty space (or over notes) = lasso selection
      if (modifiers.ctrl && !hit) {
        startGesture(e, {
          action: ACTION.LASSO,
          startWorldX: localX + sX, startWorldY: localY + sY,
          currentWorldX: localX + sX, currentWorldY: localY + sY,
          additive: e.shiftKey,
          baseSelection: new Set(selectedNoteIdsRef.current),
        })
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
        startGesture(e, {
          action: ACTION.LASSO,
          startWorldX: localX + sX, startWorldY: localY + sY,
          currentWorldX: localX + sX, currentWorldY: localY + sY,
          additive: e.shiftKey,
          baseSelection: e.shiftKey ? new Set(selectedNoteIdsRef.current) : new Set(),
        })
      }
    }
  }, [activeTool, stickyNoteLength, stickyVelocity, getLocalXY, pixelToTick, pixelToPitch, startGesture])

  // Clamp tick/pitch deltas so no note in the group exits valid range.
  const clampGroupDeltas = useCallback((originals, deltaTicks, deltaPitch) => {
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
  }, [])

  // pointermove: mutates the transient drag state, then redraws the overlay
  // canvas synchronously in the SAME call — no setState, no effect, no wait
  // for React's next commit. When there is no active gesture this is the
  // hover path instead: the exact same resolvePointerIntent() the mousedown
  // handler uses drives the predictive cursor, so the two can never disagree.
  const handlePointerMove = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    const ds = dragStateRef.current

    if (!ds) {
      const { intent } = resolvePointerIntent({
        localX, localY,
        notes: notesRef.current,
        activeTool: activeToolRef.current,
        pixelsPerBeat: pixelsPerBeatRef.current,
        pixelsPerSemitone: pixelsPerSemitoneRef.current,
        scrollX: scrollXRef.current,
        scrollY: scrollYRef.current,
      })
      if (containerRef.current) {
        containerRef.current.dataset.cursor = cursorForIntent(intent, activeToolRef.current)
      }
      if (isPianoRollDebugEnabled()) {
        hoverDebugRef.current = { localX, localY, intent }
        redrawOverlayLayer()
      } else if (hoverDebugRef.current) {
        hoverDebugRef.current = null
      }
      return
    }

    if (ds.action === ACTION.PAN) {
      onPanRef.current?.(
        ds.scrollXAtStart - (e.clientX - ds.startClientX),
        ds.scrollYAtStart - (e.clientY - ds.startClientY),
      )
      return
    }

    const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }

    if (ds.action === ACTION.LASSO) {
      ds.currentWorldX = localX + scrollXRef.current
      ds.currentWorldY = localY + scrollYRef.current
      redrawOverlayLayer()
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
        Math.max(0, ticksToBeats(anchorOrig.positionTicks) + deltaBeats),
        modifiers,
        snapRef.current,
      )
      const snappedDeltaTicks = beatsToTicks(anchorNewBeat) - anchorOrig.positionTicks

      // Clamp so no note leaves valid range
      const { clampedTicks, clampedPitch } = clampGroupDeltas(ds.originals, snappedDeltaTicks, deltaPitch)

      ds.snapBypassed = modifiers.alt
      if (clampedTicks !== ds.previewDeltaTicks || clampedPitch !== ds.previewDeltaPitch) {
        ds.previewDeltaTicks = clampedTicks
        ds.previewDeltaPitch = clampedPitch
        redrawOverlayLayer()
      }
    } else if (ds.action === ACTION.RESIZE_NOTE) {
      const ppb = pixelsPerBeatRef.current
      const beatAtCursor = (localX + scrollXRef.current) / ppb
      const snapped = snapBeatToGrid(Math.max(0, beatAtCursor), modifiers, snapRef.current)
      const anchorOrig = ds.originals.get(ds.anchorNoteId)
      if (!anchorOrig) return
      const newDur = Math.max(MIN_NOTE_DURATION_TICKS, beatsToTicks(snapped) - anchorOrig.positionTicks)
      ds.snapBypassed = modifiers.alt
      if (newDur !== ds.previewDurationTicks) {
        ds.previewDurationTicks = newDur
        redrawOverlayLayer()
      }
    }
  }, [clampGroupDeltas])

  // pointerup: commits once. Local preview only lived on dragStateRef/canvas —
  // this is the single bridge write (or single batch write) for the whole
  // gesture, so one drag always produces exactly one undo entry.
  const handlePointerUp = useCallback((e) => {
    const ds = dragStateRef.current
    if (containerRef.current) {
      try { containerRef.current.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      containerRef.current.dataset.cursor = cursorForIntent('none', activeToolRef.current)
    }
    if (!ds) return
    let committed = false
    if (ds.action === ACTION.MOVE_NOTES) {
      if (ds.previewDeltaTicks !== 0 || ds.previewDeltaPitch !== 0) {
        committed = true
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
        committed = true
        const deltaTicks = ds.previewDurationTicks - ds.origDurationTicks
        if (ds.originals.size > 1 && onResizeNotesBatchRef.current) {
          const resizes = []
          for (const [noteId, orig] of ds.originals) {
            resizes.push({
              noteId,
              durationTicks: Math.max(MIN_NOTE_DURATION_TICKS, orig.durationTicks + deltaTicks),
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
        const nx = ticksToBeats(note.positionTicks) * ppb
        const nw = Math.max(2, ticksToBeats(note.durationTicks) * ppb)
        const ny = (PITCH_MAX - note.pitch) * pps
        const nh = pps
        // AABB intersection
        if (nx < x1 && nx + nw > x0 && ny < y1 && ny + nh > y0) {
          hitIds.add(note.id)
        }
      }
      setSelectedNoteIdsRef.current(hitIds)
    }
    if (committed) {
      // A move/resize commit is an async bridge round-trip (moveNote/
      // resizeNote -> notifyChanged -> refetch) — `notes` (and notesRef)
      // still hold the PRE-drag values for a beat after this handler
      // returns. Redrawing the content layer now would flash the note back
      // to its old position/size before snapping to the new one a moment
      // later. Instead keep the note hidden from the content layer and let
      // the overlay go on showing the exact final preview (unchanged, so
      // nothing visibly moves) until the `notes` prop effect above proves
      // the commit landed and clears this.
      ds.settling = true
      clearTimeout(settleTimeoutRef.current)
      settleTimeoutRef.current = setTimeout(() => {
        if (dragStateRef.current !== ds) return
        dragStateRef.current = null
        redraw()
        redrawOverlayLayer()
      }, 800)
    } else {
      dragStateRef.current = null
      redraw()
      redrawOverlayLayer()
    }
  }, [])

  // pointercancel (e.g. Alt+Tab, OS gesture interrupt mid-drag): abort without
  // committing anything — safer than the old window-mouseup approach, which
  // could leave a stuck drag state if the real mouseup never arrived.
  const handlePointerCancel = useCallback((e) => {
    if (containerRef.current) {
      try { containerRef.current.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      containerRef.current.dataset.cursor = cursorForIntent('none', activeToolRef.current)
    }
    if (!dragStateRef.current) return
    dragStateRef.current = null
    redraw()
    redrawOverlayLayer()
  }, [])

  // Debug-only: draws the actual hitbox/resize-zone rects the hit-resolver
  // just computed, plus the currently hovered intent — so the calibration in
  // resolveNoteHit (6px zones, 6px minimum hitbox) can be checked by eye
  // against real pixels/zoom instead of taken on faith. Flag-gated, never
  // drawn unless isPianoRollDebugEnabled().
  function drawDebugOverlay(ov) {
    const width = widthRef.current
    const height = heightRef.current
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current
    ov.save()
    ov.lineWidth = 1
    ov.setLineDash([2, 2])
    for (const note of notesRef.current) {
      const beat = ticksToBeats(note.positionTicks)
      const durBeats = ticksToBeats(note.durationTicks)
      const renderX = beat * ppb - sX
      const renderW = Math.max(2, durBeats * ppb)
      const y = (PITCH_MAX - note.pitch) * pps - sY
      if (renderX + renderW < 0 || renderX > width || y + pps < 0 || y > height) continue
      const hitW = Math.max(renderW, MIN_NOTE_HITBOX_PX)
      const x = renderX - (hitW - renderW) / 2
      const edgePx = Math.min(RESIZE_HANDLE_PX, hitW / 2)
      // Full hitbox (yellow) — may extend past the rendered note for slivers.
      ov.strokeStyle = 'rgba(255,220,0,0.9)'
      ov.strokeRect(x + 0.5, y + 0.5, hitW - 1, pps - 1)
      // Resize-edge zone (red), right side only.
      ov.strokeStyle = 'rgba(255,60,60,0.9)'
      ov.strokeRect(x + hitW - edgePx + 0.5, y + 0.5, edgePx - 1, pps - 1)
    }
    ov.setLineDash([])
    const hover = hoverDebugRef.current
    if (hover) {
      ov.strokeStyle = 'rgba(80,200,255,0.95)'
      ov.lineWidth = 1
      ov.beginPath()
      ov.moveTo(hover.localX - 6, hover.localY)
      ov.lineTo(hover.localX + 6, hover.localY)
      ov.moveTo(hover.localX, hover.localY - 6)
      ov.lineTo(hover.localX, hover.localY + 6)
      ov.stroke()
      ov.fillStyle = 'rgba(80,200,255,0.95)'
      ov.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
      ov.fillText(hover.intent, hover.localX + 9, hover.localY - 9)
    }
    ov.restore()
  }

  // Overlay canvas: draw drag ghost on top of the content layer. Same
  // refs-not-props rule as redraw() above — this must also track the
  // animator's per-frame ppb/scrollX/scrollY without a React render.
  function redrawOverlayLayer() {
    const ov = ovRef.current?.getContext('2d')
    if (!ov) return
    const w = widthRef.current
    const h = heightRef.current
    const dpr = window.devicePixelRatio || 1
    ov.setTransform(dpr, 0, 0, dpr, 0, 0)
    ov.clearRect(0, 0, w, h)
    if (isPianoRollDebugEnabled()) drawDebugOverlay(ov)
    const ds = dragStateRef.current
    if (!ds) return
    const palette = resolvePalette()
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current

    if (ds.action === ACTION.MOVE_NOTES || ds.action === ACTION.RESIZE_NOTE) {
      // The dragged notes ARE the preview: redrawn through the same drawNotes()
      // the content layer uses, at their live position/length. drawNotes() has
      // skipped them below, so the note reads as one object glued to the
      // cursor instead of an original plus a detached ghost.
      const deltaTicks = ds.previewDurationTicks - ds.origDurationTicks
      const previewNotes = []
      for (const [, orig] of ds.originals) {
        previewNotes.push(ds.action === ACTION.MOVE_NOTES
          ? {
            ...orig,
            positionTicks: orig.positionTicks + ds.previewDeltaTicks,
            pitch: orig.pitch + ds.previewDeltaPitch,
          }
          : {
            ...orig,
            durationTicks: Math.max(MIN_NOTE_DURATION_TICKS, orig.durationTicks + deltaTicks),
          })
      }
      drawNotes(ov, w, h, previewNotes, selectedNoteIdsRef.current, ppb, pps, sX, sY, noteStyleFor(palette))
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

  // ON-SETTLE-ish, same reasoning as the content redraw effect above. This is
  // NOT how per-frame drag redraws happen anymore (those are synchronous,
  // called directly from the pointer handlers) — this only covers theme/
  // size changes, which are legitimately React-driven.
  useEffect(() => {
    redrawOverlayLayer()
  }, [themeTick, width, height])

  // Expose to parent (PianoRoll.jsx's view animator calls redraw() directly,
  // once per frame, bypassing React state/props entirely for ppb/scrollX/
  // scrollY — mirrors TimelineCanvas's redrawGrid/redrawContent pattern).
  // Empty deps: both draw functions read every input from a ref, so the
  // handle never needs to be rebuilt to stay current.
  useImperativeHandle(ref, () => ({
    redraw: () => { redraw(); redrawOverlayLayer() },
  }), [])

  // Initial/reset cursor for the active tool — overridden live by
  // handlePointerMove's hover prediction the moment the pointer moves.
  const cursor = cursorForIntent('none', activeTool)

  return (
    <div
      ref={containerRef}
      className={`piano-roll-canvas-container ${styles.gridSurface}`}
      data-cursor={cursor}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      // Middle button: no browser autoscroll; the pan gesture owns it.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
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
      <canvas ref={bgRef} className={styles.layer} />
      <canvas ref={ctRef} className={styles.layer} />
      <canvas ref={ovRef} className={styles.layer} />
    </div>
  )
})

export default PianoRollCanvas

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { PPQ, snapBeatToGrid, beatsToTicks, ticksToBeats, beatToPixel, pixelToBeat } from '../../constants/timeline.js'
import { PITCH_MIN, PITCH_MAX, pitchLabel, visibleRows, gridTiers } from './pianoRollGeometry.js'
import { readPianoRollPalette } from './pianoRollPalette.js'
import { drawNotes, drawGhosts, noteStyle } from './pianoRollNotes.js'
import { DEFAULT_SCALE, isPitchInScale, snapPitchToScale } from './scales.js'
import { snapTicksOf, quantizeStarts, sliceAt, sliceAlongLine, legatoResize, paintNotes } from './pianoRollEdits.js'

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
  LEGATO: 'legato',             // Shift + drag a right edge: resize without overlap
  DRAW_STRETCH: 'draw-stretch', // Pencil + Shift: drag sets the new note's length
  PAINT: 'paint',
  SLICE_LINE: 'slice-line',
  RIGHT_PRESS: 'right-press',   // right press on empty grid: click deselects, drag slices
  SCRUB: 'scrub',               // Alt + right-drag
}

// -- Left/right modifier sides ----------------------------------------------
// FL gives Right-Shift and Right-Alt their own meaning, and a pointer event
// only says "Shift is down". The physical side is tracked from key events
// (capture phase, so nothing upstream can swallow them). A side flag only
// counts while the event itself still reports the modifier, so a keyup lost
// to a focus change can never leave it stuck on.
const sideKeys = { shiftRight: false, altRight: false }
let sideKeysInstalled = false
function installSideKeyTracker() {
  if (sideKeysInstalled || typeof window === 'undefined') return
  sideKeysInstalled = true
  const set = (e, down) => {
    if (e.code === 'ShiftRight') sideKeys.shiftRight = down
    if (e.code === 'AltRight' || e.key === 'AltGraph') sideKeys.altRight = down
  }
  window.addEventListener('keydown', (e) => set(e, true), true)
  window.addEventListener('keyup', (e) => set(e, false), true)
  window.addEventListener('blur', () => { sideKeys.shiftRight = false; sideKeys.altRight = false })
}
export function setSideKeysForTest(next) { Object.assign(sideKeys, next) }
function isRightShift(e) { return !!e.shiftKey && sideKeys.shiftRight }
// AltGr layouts deliver Right-Alt as Ctrl+Alt (or as the AltGraph modifier).
function isRightAlt(e) {
  return sideKeys.altRight && (!!e.altKey || !!e.getModifierState?.('AltGraph'))
}

// Ghost note under the pointer (other patterns drawn behind this one).
function resolveGhostHit(ghosts, localX, localY, pixelsPerBeat, pixelsPerSemitone, scrollX, scrollY) {
  if (!ghosts?.length) return null
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i]
    if (!Number.isInteger(g.patternId)) continue
    const x = ticksToBeats(g.positionTicks) * pixelsPerBeat - scrollX
    const w = Math.max(MIN_NOTE_HITBOX_PX, ticksToBeats(g.durationTicks) * pixelsPerBeat)
    const y = (PITCH_MAX - g.pitch) * pixelsPerSemitone - scrollY
    if (localX >= x && localX < x + w && localY >= y && localY < y + pixelsPerSemitone) return g
  }
  return null
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
  if (activeTool === 'paint') return { intent: 'draw', note: hit?.note ?? null, hit }
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
  if (activeTool === 'pencil' || activeTool === 'paint') return 'crosshair'
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
  stickySlideCurve = null, onTouchNote,
  selectedNoteIds, setSelectedNoteIds,
  pixelsPerBeatRef, pixelsPerSemitoneRef, scrollXRef, scrollYRef,
  width, height,
  onAddNote, onRemoveNote, onMoveNote, onMoveNotesBatch, onResizeNote, onResizeNotesBatch, onPreviewNote,
  onDropFsc,
  scale = DEFAULT_SCALE,
  noteColor = null, labelMode = 'pitch', refSlot = null, ghosts = null,
  // Voice clones of the track playing this pattern: a pinned note shows "V1" etc.
  voiceCount = 0,
  snap = '1/16', onPan,
  timeSel = null, onClearTimeSel, onCommitNotes, onScrub, onSwitchToGhost,
}, ref) {
  useEffect(() => { installSideKeyTracker() }, [])
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
  const stickySlideCurveRef = useRef(stickySlideCurve)
  stickySlideCurveRef.current = stickySlideCurve
  // Fired when a pointerdown touches an existing note (pencil or select): the
  // editor then draws new notes with that note's properties.
  const onTouchNoteRef = useRef(onTouchNote)
  onTouchNoteRef.current = onTouchNote
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const snapRef = useRef(snap)
  snapRef.current = snap
  const onPanRef = useRef(onPan)
  onPanRef.current = onPan
  const onCommitNotesRef = useRef(onCommitNotes)
  onCommitNotesRef.current = onCommitNotes
  const onScrubRef = useRef(onScrub)
  onScrubRef.current = onScrub
  const onSwitchToGhostRef = useRef(onSwitchToGhost)
  onSwitchToGhostRef.current = onSwitchToGhost
  const onClearTimeSelRef = useRef(onClearTimeSel)
  onClearTimeSelRef.current = onClearTimeSel
  const timeSelRef = useRef(timeSel)
  timeSelRef.current = timeSel
  // Last right press on empty grid, for the ghost double right-click.
  const lastRightPressRef = useRef(null)
  // Note look (step 12.3): read by both draw paths from refs, like every other
  // draw input, so the imperative per-frame redraw never sees stale values.
  const lookRef = useRef(null)
  lookRef.current = { noteColor, labelMode, refSlot, ghosts, voiceCount }
  const noteStyleFor = (palette) => noteStyle({
    color: lookRef.current.noteColor, palette, labelMode: lookRef.current.labelMode, refSlot: lookRef.current.refSlot,
    voiceCount: lookRef.current.voiceCount,
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
    if (!ds) return null
    if (ds.action === ACTION.LEGATO) return ds.hidden
    // Copies leave their originals in place; the rest edit nothing on screen.
    if (ds.action !== ACTION.MOVE_NOTES && ds.action !== ACTION.RESIZE_NOTE) return null
    if (ds.clone) return null
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
    const ts = timeSelRef.current
    if (ts && ts.end > ts.start) {
      const x0 = ticksToBeats(ts.start) * ppb - sX
      const x1 = ticksToBeats(ts.end) * ppb - sX
      if (x1 > 0 && x0 < w) {
        ct.save()
        ct.globalAlpha = 0.12
        ct.fillStyle = palette.select
        ct.fillRect(x0, 0, x1 - x0, h)
        ct.globalAlpha = 0.6
        ct.fillRect(Math.round(x0), 0, 1, h)
        ct.fillRect(Math.round(x1) - 1, 0, 1, h)
        ct.restore()
      }
    }
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
      scale.enabled, scale.root, scale.mode, noteColor, labelMode, refSlot, ghosts, timeSel, voiceCount])

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
  const pixelToPitch = useCallback((localY, { raw = false } = {}) => {
    const pitch = PITCH_MAX - Math.floor((localY + scrollYRef.current) / pixelsPerSemitoneRef.current)
    const clamped = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch))
    const sc = scaleRef.current
    if (raw || !sc?.enabled) return clamped
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

  // The note list after an edit, committed as one undo entry by the owner.
  const commit = useCallback((next) => onCommitNotesRef.current?.(next), [])

  const handlePointerDown = useCallback((e) => {
    const ppb = pixelsPerBeatRef.current
    const pps = pixelsPerSemitoneRef.current
    const sX = scrollXRef.current
    const sY = scrollYRef.current
    const snapTicks = snapTicksOf(snapRef.current)

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
    const pos = getLocalXY(e)
    if (!pos) return
    const { localX, localY } = pos
    const hit = resolveNoteHit(notesRef.current, localX, localY, ppb, pps, sX, sY)
    const snapMods = { alt: e.altKey }

    // Mouse X1 (back) over a ghost note: edit that pattern.
    if (e.button === 3) {
      e.preventDefault()
      const ghost = resolveGhostHit(lookRef.current.ghosts, localX, localY, ppb, pps, sX, sY)
      if (ghost) onSwitchToGhostRef.current?.(ghost.patternId)
      return
    }

    if (e.button === 2) {
      e.preventDefault()
      // Right-Alt + right-click: quantize the selection (or the note clicked).
      if (isRightAlt(e)) {
        const sel = selectedNoteIdsRef.current
        const ids = sel.size ? new Set(sel) : hit ? new Set([hit.note.id]) : null
        if (ids) commit(quantizeStarts(notesRef.current, ids, snapTicks))
        return
      }
      // Alt + right-drag: scrub — the pointer is the playhead.
      if (e.altKey) {
        const tick = Math.max(0, Math.round(((localX + sX) / ppb) * PPQ))
        startGesture(e, { action: ACTION.SCRUB, tick })
        onScrubRef.current?.(tick)
        return
      }
      // Right-Shift + right-click: slice the note and drop its smaller part.
      if (isRightShift(e)) {
        if (hit) {
          const tick = pixelToTick(localX, snapMods)
          commit(sliceAt(notesRef.current, new Set([hit.note.id]), tick, { deleteSmallest: true }))
        }
        return
      }
      // Right-click a note: delete it (FL-style), with any tool, immediately.
      if (hit) {
        onRemoveNoteRef.current?.(hit.note.id)
        return
      }
      // Double right-click on a ghost note: edit that pattern.
      const now = performance.now()
      const last = lastRightPressRef.current
      const ghost = resolveGhostHit(lookRef.current.ghosts, localX, localY, ppb, pps, sX, sY)
      if (ghost && last && now - last.t < 450 && Math.abs(last.x - localX) < 6 && Math.abs(last.y - localY) < 6) {
        lastRightPressRef.current = null
        onSwitchToGhostRef.current?.(ghost.patternId)
        return
      }
      lastRightPressRef.current = { t: now, x: localX, y: localY }
      // Right press on empty grid: a click deselects all; a drag slices along
      // the drawn line (FL's right-click-and-hold slice).
      startGesture(e, {
        action: ACTION.RIGHT_PRESS,
        startX: localX, startY: localY,
        tick0: pixelToTick(localX, snapMods), pitch0: pixelToPitch(localY, { raw: true }),
      })
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    const ctrl = e.ctrlKey || e.metaKey
    const shift = e.shiftKey

    // Right-Shift + click: slice notes, with any tool (a right edge still
    // takes the Shift edge drag below).
    if (isRightShift(e) && !(hit && hit.nearRight)) {
      const tick = pixelToTick(localX, snapMods)
      startGesture(e, {
        action: ACTION.SLICE_LINE,
        tick0: tick, pitch0: pixelToPitch(localY, { raw: true }),
        tick1: tick, pitch1: pixelToPitch(localY, { raw: true }),
      })
      return
    }

    // Ctrl, in every tool: select. Click a note = that note; Ctrl+Shift adds
    // (or removes an already-selected one); click empty = deselect all; drag =
    // rectangle (added to the selection with Shift).
    if (ctrl) {
      startGesture(e, {
        action: ACTION.LASSO,
        ctrlClick: true,
        startX: localX, startY: localY,
        startHitId: hit ? hit.note.id : null,
        startWorldX: localX + sX, startWorldY: localY + sY,
        currentWorldX: localX + sX, currentWorldY: localY + sY,
        additive: shift,
        baseSelection: new Set(selectedNoteIdsRef.current),
      })
      return
    }

    if (activeTool === 'delete') {
      if (hit) onRemoveNoteRef.current?.(hit.note.id)
      return
    }

    // Slice tool: drag a cut line across notes; Shift cuts at the click
    // without dragging; Alt drops the snap.
    if (activeTool === 'split') {
      const tick = pixelToTick(localX, snapMods)
      if (shift) {
        if (hit) commit(sliceAt(notesRef.current, new Set([hit.note.id]), tick))
        return
      }
      startGesture(e, {
        action: ACTION.SLICE_LINE,
        tick0: tick, pitch0: pixelToPitch(localY, { raw: true }),
        tick1: tick, pitch1: pixelToPitch(localY, { raw: true }),
      })
      return
    }

    // Paint tool: a note in every slot the stroke crosses. Shift = monophonic
    // (one note per slot), Alt = half-snap slots.
    if (activeTool === 'paint') {
      const slotTicks = e.altKey ? Math.max(MIN_NOTE_DURATION_TICKS, Math.round(snapTicks / 2)) : Math.max(MIN_NOTE_DURATION_TICKS, stickyNoteLength)
      const exact = ((localX + sX) / ppb) * PPQ
      const originTicks = Math.max(0, Math.floor(exact / snapTicks) * snapTicks)
      const pitch = pixelToPitch(localY)
      const cell = { slot: Math.floor((exact - originTicks) / slotTicks), pitch }
      const ds = {
        action: ACTION.PAINT,
        mono: shift,
        originTicks, slotTicks,
        cells: [cell],
        lastCell: cell,
        template: {
          velocity: stickyVelocity,
          ...(slideModeRef.current && {
            isSlide: true,
            slideCurveCx: stickySlideCurveRef.current?.cx ?? 0.5,
            slideCurveCy: stickySlideCurveRef.current?.cy ?? 0.5,
          }),
        },
      }
      ds.preview = paintNotes(notesRef.current, ds.cells, { originTicks, slotTicks, template: ds.template, mono: ds.mono })
      onPreviewNoteRef.current?.(pitch)
      startGesture(e, ds)
      return
    }

    // Begin drag: capture immutable originals snapshot (once). Multi-note op when
    // the hit note is already in the selection (applies to both move and resize).
    // Zero drag threshold: this fires straight from mousedown, no pixel dead
    // zone — the very first pointermove already moves the note.
    // Full note copies, not just the three edited fields: the overlay renders
    // the live preview through drawNotes(), which also needs id/velocity/
    // isSlide to draw the note exactly as the content layer would.
    const groupOf = (h) => {
      const sel = selectedNoteIdsRef.current
      return sel.has(h.note.id) && sel.size > 1
    }
    const beginDrag = (h, isMultiMove, { clone = false } = {}) => {
      const originals = new Map()
      if (isMultiMove) {
        for (const n of notesRef.current) {
          if (selectedNoteIdsRef.current.has(n.id)) originals.set(n.id, { ...n })
        }
        // Ensure anchor is in the map even if selection state was stale.
        if (!originals.has(h.note.id)) originals.set(h.note.id, { ...h.note })
      } else {
        originals.set(h.note.id, { ...h.note })
      }
      startGesture(e, {
        action: (h.nearRight && !clone) ? ACTION.RESIZE_NOTE : ACTION.MOVE_NOTES,
        clone,
        startShift: shift,
        startCtrl: ctrl,
        startX: localX, startY: localY,
        scrollXAtStart: sX, scrollYAtStart: sY,
        anchorNoteId: h.note.id,
        originals,
        previewDeltaTicks: 0,
        previewDeltaPitch: 0,
        origDurationTicks: h.note.durationTicks,
        previewDurationTicks: h.note.durationTicks,
        snapBypassed: e.altKey,
      })
    }

    if (hit) {
      // Click existing note → it becomes the template for the next new note.
      onTouchNoteRef.current?.(hit.note)
      // Shift + drag a right edge: resize without overlapping (the boundary
      // between touching notes moves; see legatoResize).
      if (shift && hit.nearRight) {
        const sel = selectedNoteIdsRef.current
        const dragIds = sel.has(hit.note.id) ? new Set(sel) : new Set([hit.note.id])
        const anchorEnd = hit.note.positionTicks + hit.note.durationTicks
        startGesture(e, {
          action: ACTION.LEGATO,
          anchorNoteId: hit.note.id,
          anchorEnd,
          dragIds,
          base: notesRef.current,
          preview: [],
          hidden: new Set([hit.note.id]),
          result: null,
        })
        return
      }
      // Shift + drag a note: drag out copies (the selection, if it's in it).
      if (shift) {
        beginDrag(hit, groupOf(hit), { clone: true })
        return
      }
      const wasSelected = selectedNoteIdsRef.current.has(hit.note.id)
      if (!wasSelected) {
        setSelectedNoteIdsRef.current(new Set([hit.note.id]))
      }
      if (activeTool === 'select') onPreviewNoteRef.current?.(hit.note.pitch)
      beginDrag(hit, wasSelected && selectedNoteIdsRef.current.size > 1)
      return
    }

    if (activeTool === 'pencil') {
      const posTicks = pixelToTick(localX, snapMods)
      const pitch = pixelToPitch(localY)
      const note = {
        positionTicks: posTicks,
        durationTicks: stickyNoteLength,
        pitch,
        velocity: stickyVelocity,
        ...(slideModeRef.current && {
          isSlide: true,
          slideCurveCx: stickySlideCurveRef.current?.cx ?? 0.5,
          slideCurveCy: stickySlideCurveRef.current?.cy ?? 0.5,
        }),
      }
      onPreviewNoteRef.current?.(pitch)
      // Shift: stretch mode — the drag sets the new note's length.
      if (shift) {
        startGesture(e, { action: ACTION.DRAW_STRETCH, note, preview: [{ ...note, id: -1 }] })
        return
      }
      onAddNoteRef.current?.(note)
      return
    }

    if (activeTool === 'select') {
      // Lasso on empty space (no modifier needed in select mode); Shift adds.
      startGesture(e, {
        action: ACTION.LASSO,
        startWorldX: localX + sX, startWorldY: localY + sY,
        currentWorldX: localX + sX, currentWorldY: localY + sY,
        additive: shift,
        baseSelection: shift ? new Set(selectedNoteIdsRef.current) : new Set(),
      })
    }
  }, [activeTool, stickyNoteLength, stickyVelocity, getLocalXY, pixelToTick, pixelToPitch, startGesture, commit])

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

    // Snap is the Snap select, or free with Alt. Ctrl/Shift never change the
    // grid in the piano roll — they mean select / clone / lock axis here.
    const modifiers = { alt: e.altKey }

    if (ds.action === ACTION.LASSO) {
      ds.currentWorldX = localX + scrollXRef.current
      ds.currentWorldY = localY + scrollYRef.current
      redrawOverlayLayer()
      return
    }

    if (ds.action === ACTION.SCRUB) {
      const tick = Math.max(0, Math.round(((localX + scrollXRef.current) / pixelsPerBeatRef.current) * PPQ))
      if (tick !== ds.tick) {
        ds.tick = tick
        onScrubRef.current?.(tick)
        redrawOverlayLayer()
      }
      return
    }

    if (ds.action === ACTION.RIGHT_PRESS) {
      if (Math.hypot(localX - ds.startX, localY - ds.startY) < 4) return
      // Became a drag: slice along the line from the press point.
      dragStateRef.current = {
        action: ACTION.SLICE_LINE,
        tick0: ds.tick0, pitch0: ds.pitch0,
        tick1: pixelToTick(localX, modifiers), pitch1: pixelToPitch(localY, { raw: true }),
      }
      redrawOverlayLayer()
      return
    }

    if (ds.action === ACTION.SLICE_LINE) {
      const tick1 = pixelToTick(localX, modifiers)
      const pitch1 = pixelToPitch(localY, { raw: true })
      if (tick1 !== ds.tick1 || pitch1 !== ds.pitch1) {
        ds.tick1 = tick1
        ds.pitch1 = pitch1
        redrawOverlayLayer()
      }
      return
    }

    if (ds.action === ACTION.PAINT) {
      const exact = ((localX + scrollXRef.current) / pixelsPerBeatRef.current) * PPQ
      const slot = Math.floor((exact - ds.originTicks) / ds.slotTicks)
      const pitch = pixelToPitch(localY)
      const last = ds.lastCell
      if (slot === last.slot && pitch === last.pitch) return
      // Fill every slot between the last cell and this one so a fast stroke
      // leaves no gaps; pitches are interpolated along the way.
      const steps = Math.max(1, Math.abs(slot - last.slot))
      for (let i = 1; i <= steps; i++) {
        const s = slot === last.slot ? slot : last.slot + Math.sign(slot - last.slot) * i
        const p = Math.round(last.pitch + ((pitch - last.pitch) * i) / steps)
        ds.cells.push({ slot: s, pitch: p })
      }
      if (pitch !== last.pitch) onPreviewNoteRef.current?.(pitch)
      ds.lastCell = { slot, pitch }
      ds.preview = paintNotes(notesRef.current, ds.cells, {
        originTicks: ds.originTicks, slotTicks: ds.slotTicks, template: ds.template, mono: ds.mono,
      })
      redrawOverlayLayer()
      return
    }

    if (ds.action === ACTION.DRAW_STRETCH) {
      const beatAtCursor = (localX + scrollXRef.current) / pixelsPerBeatRef.current
      const endTicks = beatsToTicks(snapBeatToGrid(Math.max(0, beatAtCursor), modifiers, snapRef.current))
      const dur = Math.max(MIN_NOTE_DURATION_TICKS, endTicks - ds.note.positionTicks)
      if (dur !== ds.preview[0].durationTicks) {
        ds.preview = [{ ...ds.preview[0], durationTicks: dur }]
        redrawOverlayLayer()
      }
      return
    }

    if (ds.action === ACTION.LEGATO) {
      const beatAtCursor = (localX + scrollXRef.current) / pixelsPerBeatRef.current
      const endTicks = beatsToTicks(snapBeatToGrid(Math.max(0, beatAtCursor), modifiers, snapRef.current))
      const want = endTicks - ds.anchorEnd
      if (ds.result && want === ds.wantDelta) return
      ds.wantDelta = want
      const result = legatoResize(ds.base, ds.dragIds, ds.anchorNoteId, want, MIN_NOTE_DURATION_TICKS)
      ds.result = result
      const hidden = new Set([ds.anchorNoteId, ...result.touched])
      const hiddenChanged = hidden.size !== ds.hidden.size || [...hidden].some((id) => !ds.hidden.has(id))
      ds.hidden = hidden
      ds.preview = result.notes.filter((n) => hidden.has(n.id))
      if (hiddenChanged) redraw()
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
      // FL axis locks: Shift pressed after the click (not held for a clone)
      // keeps the pitch; Ctrl pressed after the click keeps the timing.
      const lockPitch = e.shiftKey && !ds.startShift
      const lockTime = (e.ctrlKey || e.metaKey) && !ds.startCtrl
      const deltaBeats = lockTime ? 0 : dx / ppb
      let deltaPitch = lockPitch ? 0 : -Math.round(dy / pps)

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
      const snappedDeltaTicks = lockTime ? 0 : beatsToTicks(snapBeatToGrid(
        Math.max(0, ticksToBeats(anchorOrig.positionTicks) + deltaBeats),
        modifiers,
        snapRef.current,
      )) - anchorOrig.positionTicks

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
  }, [clampGroupDeltas, pixelToTick, pixelToPitch])

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
    if (ds.action === ACTION.MOVE_NOTES && ds.clone) {
      // Shift-drag copies: originals stay, the copies land where they were
      // dropped and become the selection (even with no movement, like FL).
      if (ds.previewDeltaTicks !== 0 || ds.previewDeltaPitch !== 0) {
      committed = true
      const copies = []
      for (const [, orig] of ds.originals) {
        const { id, ...rest } = orig
        copies.push({
          ...rest,
          positionTicks: orig.positionTicks + ds.previewDeltaTicks,
          pitch: orig.pitch + ds.previewDeltaPitch,
          _select: true,
        })
      }
      commit([...notesRef.current, ...copies])
      }
    } else if (ds.action === ACTION.MOVE_NOTES) {
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
    } else if (ds.action === ACTION.LEGATO) {
      if (ds.result && ds.result.delta !== 0) {
        committed = true
        commit(ds.result.notes)
        const anchor = ds.result.notes.find((n) => n.id === ds.anchorNoteId)
        if (anchor) setStickyNoteLengthRef.current?.(anchor.durationTicks)
      }
    } else if (ds.action === ACTION.DRAW_STRETCH) {
      committed = true
      const dur = ds.preview[0].durationTicks
      onAddNoteRef.current?.({ ...ds.note, durationTicks: dur })
      setStickyNoteLengthRef.current?.(dur)
    } else if (ds.action === ACTION.PAINT) {
      if (ds.preview.length) {
        committed = true
        commit([...notesRef.current, ...ds.preview])
      }
    } else if (ds.action === ACTION.SLICE_LINE) {
      const next = sliceAlongLine(notesRef.current, ds)
      if (next.length !== notesRef.current.length) commit(next)
    } else if (ds.action === ACTION.SCRUB) {
      onScrubRef.current?.(null)
    } else if (ds.action === ACTION.RIGHT_PRESS) {
      // A plain right-click on empty grid deselects everything.
      setSelectedNoteIdsRef.current(new Set())
      onClearTimeSelRef.current?.()
    } else if (ds.action === ACTION.LASSO) {
      const moved = ds.ctrlClick
        && Math.hypot(ds.currentWorldX - ds.startWorldX, ds.currentWorldY - ds.startWorldY) >= 3
      if (ds.ctrlClick && !moved) {
        // Ctrl+click: pick one note (Ctrl+Shift toggles it); on empty grid,
        // deselect all.
        if (ds.startHitId != null) {
          const next = ds.additive ? new Set(ds.baseSelection) : new Set()
          if (ds.additive && next.has(ds.startHitId)) next.delete(ds.startHitId)
          else next.add(ds.startHitId)
          setSelectedNoteIdsRef.current(next)
        } else if (!ds.additive) {
          setSelectedNoteIdsRef.current(new Set())
          onClearTimeSelRef.current?.()
        }
      } else {
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
  }, [commit])

  // pointercancel (e.g. Alt+Tab, OS gesture interrupt mid-drag): abort without
  // committing anything — safer than the old window-mouseup approach, which
  // could leave a stuck drag state if the real mouseup never arrived.
  const handlePointerCancel = useCallback((e) => {
    if (containerRef.current) {
      try { containerRef.current.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      containerRef.current.dataset.cursor = cursorForIntent('none', activeToolRef.current)
    }
    if (!dragStateRef.current) return
    if (dragStateRef.current.action === ACTION.SCRUB) onScrubRef.current?.(null)
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
    } else if (ds.action === ACTION.LEGATO || ds.action === ACTION.DRAW_STRETCH || ds.action === ACTION.PAINT) {
      if (ds.preview?.length) {
        const sel = ds.action === ACTION.LEGATO ? selectedNoteIdsRef.current : new Set()
        drawNotes(ov, w, h, ds.preview, sel, ppb, pps, sX, sY, noteStyleFor(palette))
      }
    } else if (ds.action === ACTION.SLICE_LINE) {
      const xAt = (t) => ticksToBeats(t) * ppb - sX
      const yAt = (p) => (PITCH_MAX - p) * pps - sY + pps / 2
      const flat = ds.pitch0 === ds.pitch1
      ov.save()
      ov.strokeStyle = palette.select
      ov.lineWidth = 1.5
      ov.setLineDash([4, 3])
      ov.beginPath()
      ov.moveTo(xAt(ds.tick0), yAt(ds.pitch0) - (flat ? pps / 2 : 0))
      ov.lineTo(xAt(ds.tick1), yAt(ds.pitch1) + (flat ? pps / 2 : 0))
      ov.stroke()
      ov.restore()
    } else if (ds.action === ACTION.SCRUB) {
      const x = Math.round(ticksToBeats(ds.tick / 1) * ppb - sX)
      ov.fillStyle = palette.select
      ov.fillRect(x, 0, 1, h)
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
    // Note under a client-space point (Alt+wheel note edits), or null.
    noteAt: (clientX, clientY) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return null
      const localX = clientX - rect.left
      const localY = clientY - rect.top
      if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) return null
      return resolveNoteHit(notesRef.current, localX, localY, pixelsPerBeatRef.current,
        pixelsPerSemitoneRef.current, scrollXRef.current, scrollYRef.current)?.note ?? null
    },
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
      onMouseDown={(e) => { if (e.button === 1 || e.button === 3 || e.button === 4) e.preventDefault() }}
      // X1/X2 must not navigate the window back/forward.
      onMouseUp={(e) => { if (e.button === 3 || e.button === 4) e.preventDefault() }}
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

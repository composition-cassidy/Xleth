import { useEffect, useRef, useState, useCallback } from 'react'
import useViewAnimator from '../../hooks/useViewAnimator.js'
import PianoRollToolbar from './PianoRollToolbar.jsx'
import PianoRollKeyboard, { PITCH_MIN, PITCH_MAX } from './PianoRollKeyboard.jsx'
import PianoRollCanvas from './PianoRollCanvas.jsx'
import PianoRollRuler from './PianoRollRuler.jsx'
import VelocityLane from './VelocityLane.jsx'
import PianoRollScrollbarV from './PianoRollScrollbarV.jsx'
import PianoRollScrollbarH from './PianoRollScrollbarH.jsx'
import PianoRollSplitter, { readStoredLaneHeight } from './PianoRollSplitter.jsx'
import styles from './PianoRoll.module.css'
import usePatternContext from './usePatternContext.js'
import { EmptyState } from '../../ui-kit'
import { timelineEvents } from '../../timelineEvents.js'
import { PPQ, snapBeatToGrid, beatsToTicks } from '../../constants/timeline.js'
import { registerEditorCommand } from '../../windowing/managers/EditorCommandRegistry'
import { register as registerKeyboardBinding } from '../../windowing/managers/KeyboardManager'
import { usePanelVisibility } from '../../windowing/contexts/PanelVisibilityContext'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry.ts'
import useQuickNotationStore from '../../stores/quickNotationStore.js'
import { useToast } from '../Toast.jsx'
import { DEFAULT_SCALE, nextScalePitch } from './scales.js'
import * as Edits from './pianoRollEdits.js'
import { useXlethRootContext } from '../../windowing/contexts/XlethRootContext.jsx'

// Map parsed FSC notes (engine 960-PPQ shape) onto Xleth's PatternNote JS shape.
// Only the five fields the Piano Roll understands are carried across — marker
// byte 16 and the diagnostic source fields are intentionally dropped, so a
// marker-16 note stays a normal note unless the engine flagged isSlide.
export function mapFscNotesToPatternNotes(fscNotes) {
  return (fscNotes || []).map((n) => ({
    positionTicks: n.positionTicks,
    durationTicks: n.lengthTicks,
    pitch: n.pitch,
    velocity: n.velocity,
    isSlide: n.isSlide,
  }))
}

// Orchestrate a single .fsc drop: resolve the dropped File to a path, parse it
// off the engine, map the notes, and insert them as ONE batch (one undo entry).
// Extracted from the component so the path/parse/insert flow is unit-testable
// without a DOM. Returns a status object; never throws on expected failures.
export async function importFscScore({ file, patternId, xleth, notify, showToast }) {
  const warn = (msg, level = 'error') => {
    if (showToast) showToast(msg, level)
    else console.warn(`[PianoRoll] ${msg}`)
  }

  if (!patternId) {
    warn('FSC drop ignored: no active pattern')
    return { status: 'no-pattern' }
  }

  const getPath = xleth?.getDroppedFilePath || xleth?.file?.getPathForFile
  const filePath = getPath?.(file)
  if (!filePath) {
    warn('Could not resolve dropped FSC file path')
    return { status: 'no-path' }
  }

  const result = await xleth?.fsc?.parse?.(filePath)
  if (!result?.ok) {
    warn(`FSC parse failed: ${result?.error || 'unknown error'}`)
    return { status: 'parse-failed', error: result?.error }
  }

  const notes = mapFscNotesToPatternNotes(result.notes)
  if (!notes.length) {
    warn('FSC import produced no notes')
    return { status: 'no-notes', droppedCount: result.droppedCount }
  }

  // Single bridge call → single undo entry for the whole imported score.
  await xleth?.timeline?.addNotesBatch?.(patternId, notes)
  if (result.droppedCount > 0) {
    console.warn(`[PianoRoll] FSC import dropped ${result.droppedCount} note(s)`)
  }
  notify?.()
  return { status: 'ok', count: notes.length }
}

// A pattern id the engine can answer for: a non-negative integer that, once the
// pattern list is known, is still in it. The panel mounts with patternId=null
// (nothing opened yet) and keeps a stale id after its pattern is deleted;
// asking getPattern for either is what used to log
// "timeline_getPattern(id: number)" twice per open.
export function isUsablePatternId(id, availablePatterns) {
  if (!Number.isInteger(id) || id < 0) return false
  if (!Array.isArray(availablePatterns) || availablePatterns.length === 0) return true
  return availablePatterns.some((p) => p.id === id)
}

const DEFAULT_PX_PER_BEAT = 80
const DEFAULT_PX_PER_SEMITONE = 14

const MIN_PX_PER_BEAT = 20
const MAX_PX_PER_BEAT = 320
const MIN_PX_PER_SEMITONE = 6
const MAX_PX_PER_SEMITONE = 40
const MIN_CONTENT_BEATS = 16 // minimum scrollable horizontal range

// FL Studio piano roll keys, by command. Combos are KeyboardManager spellings
// (modifiers Meta, Ctrl, Shift, Alt, then the key); a letter also matches by
// physical key, so 'Shift+i' answers Shift+I and Caps Lock alike. Panel scope:
// these only fire while the piano roll has focus, and a handled key stops
// there, so global bindings that share a combo (Ctrl+M, the mixer's M) never
// see it. Not bound, by decision: colour/group/mute keys (notes carry no such
// data), Ctrl+I (no controller lanes; stays Import Source), resize-from-left,
// MIDI export and the MIDI clipboard.
export const PIANO_ROLL_KEYMAP = {
  toolSelect: ['s', 'S'],
  toolPencil: ['p', 'P'],
  toolPaint: ['b', 'B'],
  toolSplit: ['c', 'C'],
  toolDelete: ['d', 'D'],
  undo: ['Ctrl+z', 'Meta+z'],
  redo: ['Ctrl+y', 'Meta+y', 'Ctrl+Shift+z', 'Meta+Shift+z'],
  copy: ['Ctrl+c', 'Meta+c'],
  cut: ['Ctrl+x', 'Meta+x'],
  paste: ['Ctrl+v', 'Meta+v'],
  selectAll: ['Ctrl+a', 'Meta+a'],
  deselect: ['Ctrl+d', 'Meta+d'],
  invertSelection: ['Shift+i'],
  randomSelection: ['Shift+r'],
  offGridSelection: ['Shift+o'],
  timeAround: ['Ctrl+Enter'],
  timeBefore: ['Ctrl+ArrowLeft'],
  timeAfter: ['Ctrl+ArrowRight'],
  duplicate: ['Ctrl+b', 'Meta+b'],
  delete: ['Delete', 'Backspace'],
  insertSpace: ['Ctrl+Insert'],
  sliceInsertSpace: ['Ctrl+Alt+Insert'],
  deleteSpace: ['Ctrl+Delete'],
  moveLeft: ['Shift+ArrowLeft'],
  moveRight: ['Shift+ArrowRight'],
  rotateLeft: ['Ctrl+Shift+ArrowLeft'],
  rotateRight: ['Ctrl+Shift+ArrowRight'],
  nudgeLeft: ['Alt+ArrowLeft'],
  nudgeRight: ['Alt+ArrowRight'],
  stepUp: ['ArrowUp', 'Shift+ArrowUp'],
  stepDown: ['ArrowDown', 'Shift+ArrowDown'],
  octaveUp: ['Ctrl+ArrowUp'],
  octaveDown: ['Ctrl+ArrowDown'],
  discardLengths: ['Shift+d'],
  importMidi: ['Ctrl+m'],
  velocity: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
}

// Editor-local clipboard fallback: note copy/paste must not depend on transient
// Chromium clipboard permission or window-focus state.
let pianoRollClipboard = null

export function resetPianoRollClipboardForTest() {
  pianoRollClipboard = null
}

export default function PianoRoll({
  patternId, onClose,
  onDetach, onDock, floating = false,
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
  // False only when the project is known to hold no pattern at all: the one case the empty
  // state is left to say so. Otherwise the panel that hosts this opens one (PianoRollPanel).
  projectHasPatterns = true,
}) {
  const { isVisible } = usePanelVisibility()
  const { showToast } = useToast()
  const rootContext = useXlethRootContext()
  const setQuickNotationContext = useQuickNotationStore((s) => s.setContext)
  const [pattern, setPattern] = useState(null)
  const [regions, setRegions] = useState([])
  const [activeTool, setActiveTool] = useState('pencil')
  const [slideMode, setSlideMode] = useState(false)
  const [stickyNoteLength, setStickyNoteLength] = useState(240) // 1/16 default
  const [stickyVelocity, setStickyVelocity] = useState(1.0)
  // Slide bezier control point of the last-touched note (the toggle itself is
  // slideMode). Only ever read when a pencil click draws a new note.
  const [stickySlideCurve, setStickySlideCurve] = useState({ cx: 0.5, cy: 0.5 })
  // Snap to Scale is an editor-local view setting: it constrains what the user
  // can draw, but nothing about it is stored on the pattern.
  const [scale, setScale] = useState(DEFAULT_SCALE)
  // View settings (step 12.3), editor-local like the scale: what the note
  // label says, whether other patterns show as ghosts, and which sampler slot
  // the Sample view measures transposition against.
  const [labelMode, setLabelMode] = useState('pitch')
  const [showGhosts, setShowGhosts] = useState(true)
  const [refSlotIndex, setRefSlotIndex] = useState(0)
  // Snap granularity for draw / move / resize (snapBeatToGrid). 1/16 is what
  // the editor always used, so nothing changes until the user picks another.
  const [snap, setSnap] = useState('1/16')
  const snapRef = useRef(snap)
  snapRef.current = snap
  const [selectedNoteIds, setSelectedNoteIds] = useState(new Set())
  // FL time selection: a tick range drawn on the ruler and the grid. Set from
  // the ruler (Ctrl+drag / double-click drag), Ctrl+Enter and Ctrl+Left/Right;
  // it selects the notes that start inside it and drives Ctrl+B / Ins / Del.
  const [timeSel, setTimeSel] = useState(null)
  const timeSelRef = useRef(timeSel)
  timeSelRef.current = timeSel
  useEffect(() => { setTimeSel(null) }, [patternId])
  // pixelsPerBeat/scrollX/scrollY below are the SETTLED view state — synced
  // from the animator on a trailing ~100ms debounce, same pattern as
  // TimelineView. They exist for consumers that only need the resting value
  // (content-size math, initial layout, effect deps). They must NOT be what
  // positions anything on screen: both the canvases AND the DOM followers
  // (keyboard, ruler, scrollbars) read pixelsPerBeatRef/pixelsPerSemitoneRef/
  // scrollXRef/scrollYRef, written every animator frame with no re-render.
  const [pixelsPerBeat, setPixelsPerBeat] = useState(DEFAULT_PX_PER_BEAT)
  const [pixelsPerSemitone, setPixelsPerSemitone] = useState(DEFAULT_PX_PER_SEMITONE)
  const [scrollX, setScrollX] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  // Measured size of the GRID cell itself (not the panel): the keyboard, the
  // ruler and the lane share its width/height through the CSS grid, so nothing
  // is derived by subtracting chrome constants (the old 40px dead band).
  const [size, setSize] = useState({ w: 800, h: 400 })
  const [laneHeight, setLaneHeight] = useState(readStoredLaneHeight)
  const containerRef = useRef(null)
  const gridCellRef = useRef(null)
  const selectedNoteIdsRef = useRef(selectedNoteIds)
  selectedNoteIdsRef.current = selectedNoteIds
  const previewReleasesRef = useRef(new Set())
  // Source of truth for the draw/hit-test path — see the view animator below.
  const scrollXRef = useRef(0)
  const scrollYRef = useRef(0)
  const pixelsPerBeatRef = useRef(DEFAULT_PX_PER_BEAT)
  const pixelsPerSemitoneRef = useRef(DEFAULT_PX_PER_SEMITONE)
  const maxScrollXRef = useRef(0)
  const pianoRollCanvasRef = useRef(null)
  const velocityLaneRef = useRef(null)
  // DOM-positioned view followers — driven imperatively from onTick below,
  // exactly like the two canvases. Anything positioned from the settled state
  // instead freezes for the whole gesture and snaps ~100ms after it stops.
  const keyboardRef = useRef(null)
  const rulerRef = useRef(null)
  const scrollbarVRef = useRef(null)
  const scrollbarHRef = useRef(null)

  // ── View animator: FL Studio-style spring easing ───────────────────────────
  // Same shared hook as TimelineView (see useViewAnimator.js) — a separate
  // instance, own springs, no forked logic. onTick writes the refs above
  // (per-frame, no setState) and calls the two canvases' imperative redraw()
  // directly; the React state (pixelsPerBeat/scrollX/scrollY) is synced on a
  // trailing ~100ms debounce purely for the DOM-positioned consumers.
  const settleTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(settleTimerRef.current), [])

  const viewAnimatorRef = useRef(null)
  const viewAnimator = useViewAnimator({
    springs: {
      ppb: { value: DEFAULT_PX_PER_BEAT, space: 'log' },
      pps: { value: DEFAULT_PX_PER_SEMITONE, space: 'log' },
      scrollX: { value: 0 },
      scrollY: { value: 0 },
    },
    // Writes the refs (per-frame, no setState), then pushes the frame to every
    // view-following child imperatively: the two canvases redraw, the DOM
    // followers reposition. The React state below is a trailing mirror only.
    onTick: (values) => {
      pixelsPerBeatRef.current = values.ppb
      pixelsPerSemitoneRef.current = values.pps
      scrollXRef.current = values.scrollX
      scrollYRef.current = values.scrollY
      pianoRollCanvasRef.current?.redraw()
      velocityLaneRef.current?.redraw()
      keyboardRef.current?.applyView()
      rulerRef.current?.applyView()
      scrollbarVRef.current?.applyView()
      scrollbarHRef.current?.applyView()

      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = setTimeout(() => {
        setPixelsPerBeat(values.ppb)
        setPixelsPerSemitone(values.pps)
        setScrollX(values.scrollX)
        setScrollY(values.scrollY)
      }, 100)
    },
  })
  viewAnimatorRef.current = viewAnimator

  const clearPendingPreviewReleases = useCallback((sendNoteOff = false) => {
    const releases = Array.from(previewReleasesRef.current)
    for (const release of releases) {
      try { release(sendNoteOff) } catch { /* ignore */ }
    }
  }, [])

  const hasPattern = isUsablePatternId(patternId, availablePatterns)
  const fetchPattern = useCallback(async () => {
    if (!hasPattern) {
      setPattern(null)
      return
    }
    try {
      const p = await window.xleth?.timeline?.getPattern(patternId)
      if (p) setPattern(p)
    } catch (e) {
      console.warn('[PianoRoll] getPattern failed:', e.message)
    }
  }, [patternId, hasPattern])

  useEffect(() => {
    fetchPattern()
    const onChanged = () => fetchPattern()
    timelineEvents.addEventListener('timeline-pattern-changed', onChanged)
    timelineEvents.addEventListener('timeline-patterns-changed', onChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-pattern-changed', onChanged)
      timelineEvents.removeEventListener('timeline-patterns-changed', onChanged)
    }
  }, [fetchPattern])

  // ── Pattern audition ─────────────────────────────────────────────────────
  // Plays only this pattern (not the arrangement) through its track's effects.
  // The engine owns the clock; the UI just starts/stops it, flips loop live,
  // and polls so the button falls back to "Play" when a one-shot ends or normal
  // playback takes over.
  const [auditioning, setAuditioning] = useState(false)
  const [auditionLoop, setAuditionLoop] = useState(true)
  const auditionLoopRef = useRef(auditionLoop)
  auditionLoopRef.current = auditionLoop
  const auditionAvailable = hasPattern && pattern?.id === patternId
    && pattern.regionId != null && pattern.regionId >= 0
    && Array.isArray(pattern.notes) && pattern.notes.some((n) => !n.isSlide)

  const stopAudition = useCallback(() => {
    setAuditioning(false)
    try { window.xleth?.timeline?.stopPatternAudition?.() } catch { /* ignore */ }
  }, [])

  const toggleAudition = useCallback(async () => {
    if (auditioning) { stopAudition(); return }
    if (!auditionAvailable) return
    try {
      const ok = await window.xleth?.timeline?.startPatternAudition?.(patternId, auditionLoopRef.current)
      if (ok) setAuditioning(true)
      else showToast('This pattern has no sample to play', 'info')
    } catch (e) {
      console.warn('[PianoRoll] startPatternAudition failed:', e?.message)
    }
  }, [auditioning, auditionAvailable, patternId, showToast, stopAudition])

  const handleAuditionLoopChange = useCallback((next) => {
    setAuditionLoop(next)
    auditionLoopRef.current = next
    try { window.xleth?.timeline?.setPatternAuditionLoop?.(next) } catch { /* ignore */ }
  }, [])

  // Follow the engine while auditioning. The first ~400 ms are a grace period:
  // the audio thread takes the start on its next block, so an immediate poll
  // can still read "inactive".
  useEffect(() => {
    if (!auditioning) return undefined
    const startedAt = performance.now()
    const id = setInterval(async () => {
      try {
        const s = await window.xleth?.timeline?.getPatternAuditionState?.()
        if (s && !s.active && performance.now() - startedAt > 400) setAuditioning(false)
      } catch { /* engine busy: keep the current state */ }
    }, 150)
    return () => clearInterval(id)
  }, [auditioning])

  // The audition belongs to the pattern on screen: stop when the pattern
  // changes, the panel hides, or the roll unmounts.
  useEffect(() => {
    if (!isVisible) stopAudition()
  }, [isVisible, stopAudition])
  useEffect(() => () => {
    try { window.xleth?.timeline?.stopPatternAudition?.() } catch { /* ignore */ }
  }, [patternId])

  const fetchRegions = useCallback(async () => {
    try {
      const regs = await window.xleth?.timeline?.getRegions()
      if (Array.isArray(regs)) setRegions(regs)
    } catch (e) {
      console.warn('[PianoRoll] getRegions failed:', e.message)
    }
  }, [])

  useEffect(() => {
    fetchRegions()
    const onChanged = () => fetchRegions()
    timelineEvents.addEventListener('timeline-regions-changed', onChanged)
    return () => timelineEvents.removeEventListener('timeline-regions-changed', onChanged)
  }, [fetchRegions])

  const handleRegionChange = useCallback(async (newRegionId) => {
    try {
      await window.xleth?.timeline?.setPatternRegion(patternId, newRegionId)
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: { patternId } }))
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    } catch (e) {
      console.warn('[PianoRoll] setPatternRegion failed:', e.message)
    }
  }, [patternId])

  // Track the grid cell's size
  useEffect(() => {
    const el = gridCellRef.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasPattern])

  // Initial scroll: center around C4 (pitch 60) — instant, not eased; this
  // is the panel settling into place, not a user gesture.
  useEffect(() => {
    const canvasH = size.h
    const targetY = (PITCH_MAX - 60) * pixelsPerSemitone - canvasH / 2
    viewAnimatorRef.current?.setTarget('scrollY', Math.max(0, targetY), { immediate: true })
  }, [size.h, pixelsPerSemitone])

  // ── Mutation helpers — dispatch events after each mutation ────────────────
  // Note mutations auto-grow pattern.length in the engine and may cascade
  // to in-sync PatternBlock durations. Dispatch all three plural events so
  // the timeline refetches patterns AND blocks.
  const notifyChanged = useCallback(() => {
    timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: { patternId } }))
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
  }, [patternId])

  // Drop an FL Studio Score (.fsc) onto the grid → import into the active
  // pattern at the parsed tick positions (anchored at tick 0). Insert/undo
  // semantics are owned by addNotesBatch; this fires it exactly once per drop.
  const handleDropFsc = useCallback(async (file) => {
    await importFscScore({
      file,
      patternId,
      xleth: window.xleth,
      notify: notifyChanged,
      showToast,
    })
  }, [patternId, notifyChanged, showToast])

  // Open Quick Notation for this pattern — chord tokens ("Dmin7***") expand
  // to note events inserted via addNotesBatch, one undo entry per progression.
  // Anchored at the viewport's left edge snapped to grid, same as Ctrl+V
  // paste: the piano roll has no persistent edit cursor to read instead.
  const handleOpenQuickNotation = useCallback(() => {
    if (patternId == null) return
    const anchorBeat = snapBeatToGrid(Math.max(0, scrollXRef.current / pixelsPerBeatRef.current), {}, snapRef.current)
    setQuickNotationContext({ mode: 'chord', patternId, cursorTick: beatsToTicks(anchorBeat) })
    usePanelRegistry.getState().openPanel('quickNotation')
  }, [patternId, setQuickNotationContext])

  const handleAddNote = useCallback(async (note) => {
    try {
      await window.xleth?.timeline?.addNote(patternId, note)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] addNote failed:', e.message) }
  }, [patternId, notifyChanged])

  const handleRemoveNote = useCallback(async (noteId) => {
    try {
      await window.xleth?.timeline?.removeNote(patternId, noteId)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] removeNote failed:', e.message) }
  }, [patternId, notifyChanged])

  // ── One commit for every compound edit ─────────────────────────────────────
  // Takes the pattern's COMPLETE note list after an edit (pianoRollEdits.js
  // shapes) and lands it as ONE undo entry via timeline.editPatternNotes. An
  // older native module without that call gets the same result through the
  // per-note RPCs (several undo entries, but nothing lost). Notes flagged
  // `_select` become the selection; otherwise the selection keeps whatever
  // still exists. `before` overrides the baseline when the list on screen is
  // already an optimistic preview (the Alt+wheel burst).
  const notesRef = useRef([])
  const commitNotes = useCallback(async (nextNotes, { before = null, select = null } = {}) => {
    const base = before || notesRef.current
    if (Edits.sameNotes(base, nextNotes)) return null
    const xl = window.xleth?.timeline
    if (!xl) return null
    const marked = []
    nextNotes.forEach((n, i) => { if (n._select) marked.push(i) })
    let ids = null
    try {
      if (xl.editPatternNotes) {
        const result = await xl.editPatternNotes(patternId, nextNotes.map(Edits.toEngineNote))
        if (Array.isArray(result)) ids = result.map((n) => n.id)
      } else {
        const { removes, moves, resizes, velocities, adds } = Edits.diffNotes(base, nextNotes)
        for (const id of removes) await xl.removeNote(patternId, id)
        if (moves.length > 1 && xl.moveNotesBatch) await xl.moveNotesBatch(patternId, moves)
        else for (const m of moves) await xl.moveNote(patternId, m.noteId, m.positionTicks, m.pitch)
        if (resizes.length > 1 && xl.resizeNotesBatch) await xl.resizeNotesBatch(patternId, resizes)
        else for (const r of resizes) await xl.resizeNote(patternId, r.noteId, r.durationTicks)
        for (const v of velocities) await xl.setNoteVelocity(patternId, v.noteId, v.velocity)
        ids = nextNotes.map((n) => n.id)
        if (adds.length > 1 && xl.addNotesBatch) {
          const got = await xl.addNotesBatch(patternId, adds.map((a) => Edits.toEngineNote(a.note)))
          adds.forEach((a, k) => { ids[a.index] = got?.[k] })
        } else {
          for (const a of adds) ids[a.index] = await xl.addNote(patternId, Edits.toEngineNote(a.note))
        }
      }
    } catch (e) {
      console.warn('[PianoRoll] note edit failed:', e?.message || e)
    }
    if (select) setSelectedNoteIds(select)
    else if (marked.length && ids) {
      setSelectedNoteIds(new Set(marked.map((i) => ids[i]).filter((id) => Number.isInteger(id) && id >= 0)))
    } else if (ids) {
      const alive = new Set(ids)
      setSelectedNoteIds((prev) => new Set([...prev].filter((id) => alive.has(id))))
    }
    notifyChanged()
    return ids
  }, [patternId, notifyChanged])

  const deleteSelectedNotes = useCallback(async () => {
    const ids = selectedNoteIdsRef.current
    if (!ids || ids.size === 0) return false
    await commitNotes(Edits.deleteNotes(notesRef.current, ids), { select: new Set() })
    return true
  }, [commitNotes])

  useEffect(() => (
    registerEditorCommand('pianoRoll', 'deleteSelected', deleteSelectedNotes)
  ), [deleteSelectedNotes])

  const handleMoveNote = useCallback(async (noteId, posTicks, pitch) => {
    try {
      await window.xleth?.timeline?.moveNote(patternId, noteId, posTicks, pitch)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] moveNote failed:', e.message) }
  }, [patternId, notifyChanged])

  const handleMoveNotesBatch = useCallback(async (moves) => {
    try {
      await window.xleth?.timeline?.moveNotesBatch(patternId, moves)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] moveNotesBatch failed:', e.message) }
  }, [patternId, notifyChanged])

  const handleResizeNotesBatch = useCallback(async (resizes) => {
    try {
      await window.xleth?.timeline?.resizeNotesBatch(patternId, resizes)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] resizeNotesBatch failed:', e.message) }
  }, [patternId, notifyChanged])

  const handleResizeNote = useCallback(async (noteId, durTicks) => {
    try {
      await window.xleth?.timeline?.resizeNote(patternId, noteId, durTicks)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] resizeNote failed:', e.message) }
  }, [patternId, notifyChanged])

  // "Last touched note wins": the pencil draws new notes with every property of
  // the note the user most recently clicked, dragged, resized or velocity-edited
  // — length, velocity and the slide flag + curve. `overrides` carries a value
  // that is changing in the same gesture (the new velocity, the new length).
  const adoptNoteProps = useCallback((note, overrides) => {
    if (!note) return
    const n = overrides ? { ...note, ...overrides } : note
    if (Number.isFinite(n.durationTicks) && n.durationTicks > 0) setStickyNoteLength(n.durationTicks)
    if (Number.isFinite(n.velocity)) setStickyVelocity(n.velocity)
    setSlideMode(!!n.isSlide)
    setStickySlideCurve({
      cx: Number.isFinite(n.slideCurveCx) ? n.slideCurveCx : 0.5,
      cy: Number.isFinite(n.slideCurveCy) ? n.slideCurveCy : 0.5,
    })
  }, [])

  const handleSetVelocity = useCallback(async (noteId, velocity) => {
    try {
      await window.xleth?.timeline?.setNoteVelocity(patternId, noteId, velocity)
      const note = notesRef.current.find((n) => n.id === noteId)
      if (note) adoptNoteProps(note, { velocity })
      else setStickyVelocity(velocity)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] setNoteVelocity failed:', e.message) }
  }, [patternId, notifyChanged, adoptNoteProps])

  // Multi-note velocity drag: one commit (one undo entry) for the batch.
  // stickyVelocity follows the note the user actually grabbed, which the
  // VelocityLane puts first in the entry list.
  const handleSetVelocities = useCallback(async (entries) => {
    if (!entries?.length) return
    const byId = new Map(entries.map((e) => [e.noteId, e.velocity]))
    await commitNotes(notesRef.current.map((n) => (byId.has(n.id)
      ? { ...n, velocity: Math.max(0, Math.min(1, byId.get(n.id))) }
      : n)))
    const note = notesRef.current.find((n) => n.id === entries[0].noteId)
    if (note) adoptNoteProps(note, { velocity: entries[0].velocity })
    else setStickyVelocity(entries[0].velocity)
  }, [commitNotes, adoptNoteProps])

  // Alt+right-drag scrub: the pointer is the playhead, for this pattern only.
  // The canvas reports the tick under the pointer (null on release); every
  // note sounding at that tick is held, everything else released.
  const scrubHeldRef = useRef(new Set())
  const handleScrub = useCallback((tick) => {
    const regionId = pattern?.regionId
    if (regionId == null || regionId < 0) return
    const tl = window.xleth?.timeline
    const held = scrubHeldRef.current
    const sounding = new Map()
    if (tick != null) {
      for (const n of notesRef.current) {
        if (n.positionTicks <= tick && tick < n.positionTicks + n.durationTicks) sounding.set(n.pitch, n.velocity ?? 1)
      }
    }
    for (const p of Array.from(held)) {
      if (sounding.has(p)) continue
      held.delete(p)
      try { tl?.previewNoteOff?.(regionId, p) } catch { /* ignore */ }
    }
    for (const [p, v] of sounding) {
      if (held.has(p)) continue
      held.add(p)
      try { tl?.previewNote?.(regionId, p, Math.max(0.05, v)) } catch { /* ignore */ }
    }
  }, [pattern?.regionId])

  // Ghost note double right-click / mouse X1: edit that pattern instead.
  const handleSwitchToGhost = useCallback((ghostPatternId) => {
    if (Number.isInteger(ghostPatternId) && ghostPatternId !== patternId) onSwitchPattern?.(ghostPatternId)
  }, [onSwitchPattern, patternId])

  // Time selection from the ruler: the range, and the notes starting in it.
  const selectTimeRange = useCallback((range) => {
    setTimeSel(range)
    if (range) setSelectedNoteIds(Edits.notesStartingIn(notesRef.current, range))
  }, [])

  // Ctrl+click / drag on the preview keyboard: every note of those pitches.
  const handleSelectPitchRange = useCallback((lo, hi, additive) => {
    const hits = Edits.notesOfPitchRange(notesRef.current, lo, hi)
    setSelectedNoteIds((prev) => (additive ? new Set([...prev, ...hits]) : hits))
  }, [])

  // Release stuck preview notes when the piano roll unmounts, the edited
  // pattern changes, or the center tab switches away (mouseup listeners on the
  // keyboard + canvas can otherwise miss their release event if the window
  // loses focus mid-click).
  useEffect(() => {
    const regionId = pattern?.regionId
    const silence = () => {
      if (regionId != null && regionId >= 0) {
        try { window.xleth?.timeline?.previewAllNotesOff?.(regionId) } catch { /* ignore */ }
      }
      clearPendingPreviewReleases(false)
    }
    window.addEventListener('blur', silence)
    document.addEventListener('visibilitychange', silence)
    return () => {
      silence()
      window.removeEventListener('blur', silence)
      document.removeEventListener('visibilitychange', silence)
    }
  }, [clearPendingPreviewReleases, pattern?.regionId])

  // Silence only when the owning panel is hidden. PanelRegistry, not the
  // legacy activeCenterTab flag, owns keyboard focus.
  useEffect(() => {
    if (!isVisible) {
      const regionId = pattern?.regionId
      if (regionId != null && regionId >= 0) {
        try { window.xleth?.timeline?.previewAllNotesOff?.(regionId) } catch { /* ignore */ }
      }
      clearPendingPreviewReleases(false)
    }
  }, [clearPendingPreviewReleases, isVisible, pattern?.regionId])

  const handlePreviewNote = useCallback((pitch) => {
    const regionId = pattern?.regionId
    if (regionId == null || regionId < 0) return
    window.xleth?.timeline?.previewNote?.(regionId, pitch, 0.8)
    let onMouseUp = null
    let onMouseLeave = null
    let onPointerUp = null
    let onPointerCancel = null
    const release = (sendNoteOff = true) => {
      if (!previewReleasesRef.current.delete(release)) return
      if (onMouseUp) window.removeEventListener('mouseup', onMouseUp)
      if (onMouseLeave) window.removeEventListener('mouseleave', onMouseLeave)
      if (onPointerUp) window.removeEventListener('pointerup', onPointerUp)
      if (onPointerCancel) window.removeEventListener('pointercancel', onPointerCancel)
      if (sendNoteOff) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, pitch)
      }
    }
    onMouseUp = () => release(true)
    onMouseLeave = () => release(true)
    // The piano roll canvas drags notes via pointer events and calls
    // preventDefault() on pointerdown to drive its own gesture handling,
    // which suppresses the browser's compatibility mouseup/mouseleave for
    // that interaction — so a note previewed by placing/dragging on the
    // canvas would never see mouseup and would ring forever. pointerup/
    // pointercancel aren't suppressed, so listen for those too; release()
    // is idempotent so this is safe alongside the plain-mouse keyboard path.
    onPointerUp = () => release(true)
    onPointerCancel = () => release(true)
    previewReleasesRef.current.add(release)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mouseleave', onMouseLeave)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }, [pattern?.regionId])

  // ── Keyboard shortcuts (FL Studio layout, see PIANO_ROLL_KEYMAP) ──────────
  // Rebuilt every render so each command reads current state; the bindings
  // registered below look commands up through this ref. A command returns
  // false when it has nothing to act on, which leaves the key unclaimed.
  const keyCommandsRef = useRef(null)
  {
    const snapTicks = Edits.snapTicksOf(snap)
    const cur = () => notesRef.current
    const sel = () => selectedNoteIdsRef.current
    const onSelection = (edit) => {
      const ids = sel()
      if (!ids.size) return false
      return commitNotes(edit(cur(), ids))
    }
    const stepPitch = (p, dir) => (scale.enabled
      ? nextScalePitch(p, dir, scale.root, scale.mode, PITCH_MIN, PITCH_MAX)
      : p + dir)
    const pixelTicks = () => Math.max(1, Math.round(PPQ / Math.max(1, pixelsPerBeatRef.current)))
    const rangeForSpace = () => timeSelRef.current || Edits.spanOf(cur(), sel(), snapTicks)
    const shiftTime = (dir) => {
      const base = timeSelRef.current || Edits.spanOf(cur(), sel(), snapTicks)
      if (!base) return false
      selectTimeRange(Edits.shiftRange(base, dir))
      return true
    }
    const copySelection = () => {
      const byId = new Map(cur().map((n) => [n.id, n]))
      const picked = [...sel()].map((id) => byId.get(id)).filter(Boolean)
      if (!picked.length) return false
      const minPosition = Math.min(...picked.map((n) => n.positionTicks))
      const payload = {
        type: 'xleth-notes',
        notes: picked.map((n) => {
          const out = {
            positionTicks: n.positionTicks - minPosition,
            durationTicks: n.durationTicks,
            pitch: n.pitch,
            velocity: n.velocity,
          }
          if (n.isSlide) Object.assign(out, { isSlide: true, slideCurveCx: n.slideCurveCx, slideCurveCy: n.slideCurveCy })
          return out
        }),
      }
      pianoRollClipboard = payload
      try {
        navigator.clipboard?.writeText?.(JSON.stringify(payload))
          ?.catch?.((err) => console.warn('[PianoRoll] copy failed:', err?.message))
      } catch (err) { console.warn('[PianoRoll] copy failed:', err?.message) }
      return true
    }
    const paste = async () => {
      let payload = pianoRollClipboard
      if (!payload) {
        try {
          const text = await navigator.clipboard?.readText?.()
          payload = text ? JSON.parse(text) : null
        } catch (err) { console.warn('[PianoRoll] paste failed:', err?.message) }
      }
      if (!payload || payload.type !== 'xleth-notes' || !Array.isArray(payload.notes)) return
      // Paste anchor: the time selection's start, else the viewport's left
      // edge snapped to the active grid.
      const anchor = timeSelRef.current?.start
        ?? beatsToTicks(snapBeatToGrid(Math.max(0, scrollXRef.current / pixelsPerBeatRef.current), {}, snapRef.current))
      const added = payload.notes.map((n) => ({ ...n, positionTicks: anchor + (n.positionTicks | 0), _select: true }))
      await commitNotes([...cur(), ...added])
    }
    const setTool = (tool) => () => setActiveTool(tool)
    const undoRedo = (which) => async () => {
      await window.xleth?.undo?.[which]?.()
      notifyChanged()
    }

    keyCommandsRef.current = {
      toolSelect: setTool('select'),
      toolPencil: setTool('pencil'),
      toolPaint: setTool('paint'),
      toolSplit: setTool('split'),
      toolDelete: setTool('delete'),
      undo: undoRedo('undo'),
      redo: undoRedo('redo'),
      copy: () => (sel().size ? copySelection() : false),
      cut: () => {
        if (!sel().size || !copySelection()) return false
        return commitNotes(Edits.deleteNotes(cur(), sel()), { select: new Set() })
      },
      paste,
      selectAll: () => setSelectedNoteIds(new Set(cur().map((n) => n.id))),
      deselect: () => { setSelectedNoteIds(new Set()); setTimeSel(null) },
      invertSelection: () => setSelectedNoteIds(Edits.invertSelection(cur(), sel())),
      randomSelection: () => setSelectedNoteIds(Edits.randomSelection(cur(), sel())),
      offGridSelection: () => setSelectedNoteIds(Edits.offGridSelection(cur(), snapTicks)),
      timeAround: () => {
        const range = Edits.spanOf(cur(), sel(), snapTicks)
        if (!range) return false
        selectTimeRange(range)
        return true
      },
      timeBefore: () => shiftTime(-1),
      timeAfter: () => shiftTime(1),
      duplicate: () => {
        if (!cur().length) return false
        const { notes: next, range } = Edits.duplicateRight(cur(), sel(), timeSelRef.current, snapTicks)
        if (next === cur()) return false
        if (timeSelRef.current && range) setTimeSel(range)
        return commitNotes(next)
      },
      delete: () => (sel().size ? deleteSelectedNotes() : false),
      insertSpace: () => {
        const range = rangeForSpace()
        return range ? commitNotes(Edits.insertSpace(cur(), range)) : false
      },
      sliceInsertSpace: () => {
        const range = rangeForSpace()
        return range ? commitNotes(Edits.insertSpace(cur(), range, { slice: true })) : false
      },
      deleteSpace: () => {
        const range = rangeForSpace()
        if (!range) return false
        setTimeSel(null)
        return commitNotes(Edits.deleteSpace(cur(), range), { select: new Set() })
      },
      moveLeft: () => onSelection((ns, ids) => Edits.moveBy(ns, ids, -snapTicks)),
      moveRight: () => onSelection((ns, ids) => Edits.moveBy(ns, ids, snapTicks)),
      rotateLeft: () => onSelection((ns, ids) => Edits.rotate(ns, ids, -snapTicks)),
      rotateRight: () => onSelection((ns, ids) => Edits.rotate(ns, ids, snapTicks)),
      nudgeLeft: () => onSelection((ns, ids) => Edits.moveBy(ns, ids, -pixelTicks())),
      nudgeRight: () => onSelection((ns, ids) => Edits.moveBy(ns, ids, pixelTicks())),
      // Up/Down and Shift+Up/Down: one semitone (one scale degree under scale
      // lock). Ctrl+Up/Down: one octave.
      stepUp: () => onSelection((ns, ids) => Edits.transpose(ns, ids, { dir: 1, stepPitch })),
      stepDown: () => onSelection((ns, ids) => Edits.transpose(ns, ids, { dir: -1, stepPitch })),
      octaveUp: () => onSelection((ns, ids) => Edits.transpose(ns, ids, { semitones: 12 })),
      octaveDown: () => onSelection((ns, ids) => Edits.transpose(ns, ids, { semitones: -12 })),
      discardLengths: () => {
        if (!cur().length) return false
        return commitNotes(Edits.discardLengths(cur(), Edits.targetIds(cur(), sel()), snapTicks))
      },
      importMidi: () => {
        if (!rootContext?.onOpenMidiImport) return false
        rootContext.onOpenMidiImport()
        return true
      },
      // 1..9 → 0.1..0.9, 0 → 1.0, on the selection.
      velocity: (e) => {
        const digit = /^[0-9]$/.test(e.key) ? e.key : String(e.code || '').replace(/^(Digit|Numpad)/, '')
        const k = parseInt(digit, 10)
        if (!Number.isFinite(k)) return false
        return onSelection((ns, ids) => Edits.setVelocity(ns, ids, k === 0 ? 1.0 : k / 10))
      },
    }
  }
  useEffect(() => {
    const unsubscribers = []
    for (const [command, combos] of Object.entries(PIANO_ROLL_KEYMAP)) {
      for (const combo of combos) {
        unsubscribers.push(registerKeyboardBinding({
          scope: 'panel:pianoRoll',
          combo,
          handler: (e) => {
            const run = keyCommandsRef.current?.[command]
            if (!run) return undefined
            let result
            try { result = run(e) } catch (err) {
              console.warn('[PianoRoll] shortcut failed:', err?.message || err)
              return undefined
            }
            if (result === false) return undefined
            // Claim the key outright: window-level listeners (the transport's
            // M = mixer, the File menu's Ctrl+M/I…) must not also act on it.
            e.preventDefault()
            e.stopPropagation()
            result?.catch?.((err) => console.warn('[PianoRoll] shortcut failed:', err?.message || err))
            return 'handled'
          },
        }))
      }
    }
    return () => { unsubscribers.forEach((unsubscribe) => unsubscribe()) }
  }, [])

  const handleZoomIn = useCallback(() => {
    const animator = viewAnimatorRef.current
    animator.setTarget('ppb', Math.min(MAX_PX_PER_BEAT, animator.getTarget('ppb') * 1.25))
  }, [])
  const handleZoomOut = useCallback(() => {
    const animator = viewAnimatorRef.current
    animator.setTarget('ppb', Math.max(MIN_PX_PER_BEAT, animator.getTarget('ppb') / 1.25))
  }, [])

  const handleOpenSamplerSettings = useCallback(() => {
    const regionId = pattern?.regionId
    if (regionId == null || regionId < 0) return
    timelineEvents.dispatchEvent(new CustomEvent('open-sampler-settings', { detail: { regionId } }))
  }, [pattern?.regionId])

  const samplerSettingsDisabled = pattern?.regionId == null || pattern.regionId < 0

  // Alt+wheel note edits arrive as a burst of notches. Each notch updates the
  // pattern on screen at once (optimistic); the burst commits as ONE undo
  // entry once the wheel has been still for a moment.
  const wheelBurstRef = useRef(null)
  const wheelNoteEditRef = useRef(null)
  wheelNoteEditRef.current = (hitNote, e) => {
    const burst = wheelBurstRef.current || { before: notesRef.current, notes: notesRef.current, timer: null }
    const selection = selectedNoteIdsRef.current
    const ids = selection.has(hitNote.id) ? new Set(selection) : new Set([hitNote.id])
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
    const dir = delta < 0 ? 1 : -1
    let next
    if (e.shiftKey) {
      const px = Math.max(1, Math.round(PPQ / Math.max(1, pixelsPerBeatRef.current)))
      next = Edits.moveBy(burst.notes, ids, dir * px)
    } else {
      const step = (e.ctrlKey || e.metaKey ? 1 : 4) / 127
      next = burst.notes.map((n) => (ids.has(n.id)
        ? { ...n, velocity: Math.max(1 / 127, Math.min(1, (n.velocity ?? 1) + dir * step)) }
        : n))
    }
    burst.notes = next
    clearTimeout(burst.timer)
    burst.timer = setTimeout(() => {
      const done = wheelBurstRef.current
      wheelBurstRef.current = null
      if (done) commitNotes(done.notes, { before: done.before })
    }, 350)
    wheelBurstRef.current = burst
    setPattern((p) => (p ? { ...p, notes: next } : p))
  }

  // Wheel: vertical scroll; ctrl+wheel = zoom horizontal; alt+wheel = zoom
  // vertical (or edit the note under the pointer); shift+wheel = horizontal
  // scroll.
  // Every branch sets a TARGET on the view animator and lets its spring ease
  // toward it — no instant setState jump (see useViewAnimator.js).
  const handleWheel = useCallback((e) => {
    const animator = viewAnimatorRef.current
    // FL: Alt+wheel ON A NOTE edits it (velocity; Ctrl+Alt fine; Shift+Alt
    // nudges it in time). Over empty grid Alt+wheel still zooms pitch.
    if (e.altKey) {
      const hit = pianoRollCanvasRef.current?.noteAt?.(e.clientX, e.clientY)
      if (hit) {
        e.preventDefault()
        wheelNoteEditRef.current?.(hit, e)
        return
      }
    }
    if (e.altKey) {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const next = Math.max(MIN_PX_PER_SEMITONE, Math.min(MAX_PX_PER_SEMITONE, animator.getTarget('pps') * factor))
      animator.setTarget('pps', next)
    } else if (e.ctrlKey) {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const next = Math.max(MIN_PX_PER_BEAT, Math.min(MAX_PX_PER_BEAT, animator.getTarget('ppb') * factor))
      animator.setTarget('ppb', next)
    } else if (e.shiftKey) {
      e.preventDefault()
      const next = Math.max(0, Math.min(maxScrollXRef.current, animator.getTarget('scrollX') + e.deltaY))
      animator.setTarget('scrollX', next)
    } else {
      e.preventDefault()
      const maxScrollY = Math.max(0, (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitone - size.h)
      const next = Math.max(0, Math.min(maxScrollY, animator.getTarget('scrollY') + e.deltaY))
      animator.setTarget('scrollY', next)
    }
  }, [pixelsPerSemitone, size.h])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel, hasPattern])

  const notes = pattern?.notes || []
  notesRef.current = notes
  const { noteColor, ghosts } = usePatternContext(patternId, pattern, { ghostsEnabled: showGhosts })
  const currentRegion = regions.find((r) => r.id === pattern?.regionId) || null
  const regionSlots = Array.isArray(currentRegion?.slots) && currentRegion.slots.length ? currentRegion.slots : []
  const refSlot = regionSlots[Math.min(refSlotIndex, Math.max(0, regionSlots.length - 1))] || null
  const patternLengthTicks = pattern?.lengthTicks || 0
  const highlightedPitches = new Set(notes.map((n) => n.pitch))
  const canvasWidth = Math.max(0, size.w)
  const canvasHeight = Math.max(0, size.h)

  // Content bounds for scrollbar sizing
  const contentHeight = (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitone
  const lastNoteBeatsEnd = notes.length > 0
    ? Math.max(...notes.map((n) => (n.positionTicks + n.durationTicks) / PPQ))
    : 0
  const patternLenBeats = patternLengthTicks / PPQ
  const minContentBeats = Math.max(MIN_CONTENT_BEATS, lastNoteBeatsEnd + 4, patternLenBeats + 4)
  const contentWidth = Math.max(canvasWidth, minContentBeats * pixelsPerBeat)

  // Live content bounds for the scrollbars' per-frame thumb geometry. Same
  // math as contentHeight/contentWidth above, but off the animator's refs
  // instead of the settled state — a zoom changes the content size on every
  // frame, so a thumb sized from the settled value would be wrong for the
  // whole gesture.
  const getContentHeight = useCallback(
    () => (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitoneRef.current,
    [],
  )
  const getContentWidth = useCallback(
    () => Math.max(canvasWidth, minContentBeats * pixelsPerBeatRef.current),
    [canvasWidth, minContentBeats],
  )

  const handleZoomDelta = useCallback((direction) => {
    const animator = viewAnimatorRef.current
    const factor = direction > 0 ? 1.15 : 1 / 1.15
    animator.setTarget('ppb', Math.max(MIN_PX_PER_BEAT, Math.min(MAX_PX_PER_BEAT, animator.getTarget('ppb') * factor)))
  }, [])

  // Direct 1:1 setters for the scrollbars (thumb drag, click-to-page, and
  // wheel-over-the-scrollbar-itself all share these) — not eased, a dragged
  // thumb must track the cursor exactly. `immediate` keeps the animator's
  // own bookkeeping in sync so a wheel gesture over the main canvas starting
  // right after ends here from the real position instead of jumping to a
  // stale spring target. Accepts either a plain value or a React-style
  // updater function, matching how PianoRollScrollbarH/V already call these.
  const setScrollXInstant = useCallback((next) => {
    const animator = viewAnimatorRef.current
    const value = typeof next === 'function' ? next(animator.getCurrent('scrollX')) : next
    animator.setTarget('scrollX', value, { immediate: true })
  }, [])
  const setScrollYInstant = useCallback((next) => {
    const animator = viewAnimatorRef.current
    const value = typeof next === 'function' ? next(animator.getCurrent('scrollY')) : next
    animator.setTarget('scrollY', value, { immediate: true })
  }, [])

  // Middle-drag pan (both axes), 1:1 with the pointer like a scrollbar drag.
  const handlePan = useCallback((nextX, nextY) => {
    const maxX = maxScrollXRef.current
    const maxY = Math.max(0, (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitoneRef.current - size.h)
    setScrollXInstant(Math.max(0, Math.min(maxX, nextX)))
    setScrollYInstant(Math.max(0, Math.min(maxY, nextY)))
  }, [setScrollXInstant, setScrollYInstant, size.h])

  // Keep the scroll clamp bound current, and clamp scrollX if content shrank
  // (instant, not eased — this is a boundary correction, not a gesture).
  useEffect(() => {
    const maxX = Math.max(0, contentWidth - canvasWidth)
    maxScrollXRef.current = maxX
    const animator = viewAnimatorRef.current
    const clamped = Math.min(animator.getTarget('scrollX'), maxX)
    if (clamped !== animator.getTarget('scrollX')) {
      animator.setTarget('scrollX', clamped, { immediate: true })
    }
  }, [contentWidth, canvasWidth])

  // Same boundary correction for scrollY when alt+wheel vertical zoom
  // shrinks contentHeight below the current scroll position.
  useEffect(() => {
    const maxY = Math.max(0, contentHeight - canvasHeight)
    const animator = viewAnimatorRef.current
    const clamped = Math.min(animator.getTarget('scrollY'), maxY)
    if (clamped !== animator.getTarget('scrollY')) {
      animator.setTarget('scrollY', clamped, { immediate: true })
    }
  }, [contentHeight, canvasHeight])

  return (
    <div className={`piano-roll ${styles.root}`}>
      <div className={styles.toolbarWrap}>
      <PianoRollToolbar
        patternName={pattern?.name || 'Pattern'}
        activeTool={activeTool} onToolChange={setActiveTool}
        slideMode={slideMode} onSlideModeChange={setSlideMode}
        stickyNoteLength={stickyNoteLength} onStickyNoteLengthChange={setStickyNoteLength}
        scale={scale} onScaleChange={setScale}
        onZoomIn={handleZoomIn} onZoomOut={handleZoomOut}
        onOpenSamplerSettings={handleOpenSamplerSettings}
        onOpenQuickNotation={handleOpenQuickNotation}
        samplerSettingsDisabled={samplerSettingsDisabled}
        onClose={onClose}
        floating={floating}
        onDetach={onDetach}
        onDock={onDock}
        availablePatterns={availablePatterns}
        currentPatternId={hasPattern ? currentPatternId : null}
        onSwitchPattern={onSwitchPattern}
        onNewPattern={onNewPattern}
        regions={regions}
        currentRegionId={pattern?.regionId ?? -1}
        onRegionChange={handleRegionChange}
        labelMode={labelMode}
        onLabelModeChange={setLabelMode}
        sampleViewAvailable={!!refSlot}
        showGhosts={showGhosts}
        onShowGhostsChange={setShowGhosts}
        auditioning={auditioning}
        auditionLoop={auditionLoop}
        auditionAvailable={auditionAvailable}
        onToggleAudition={toggleAudition}
        onAuditionLoopChange={handleAuditionLoopChange}
        snap={snap}
        onSnapChange={setSnap}
        regionSlots={regionSlots}
        refSlotIndex={refSlotIndex}
        onRefSlotChange={setRefSlotIndex}
      />
      </div>
      {!hasPattern ? (
        <div className={styles.empty}>
          <EmptyState
            message={projectHasPatterns
              ? 'Select a pattern: double-click one in the Patterns list or a pattern block in the arrangement.'
              : 'This project has no patterns yet. A pattern holds the notes a pattern track plays.'}
            actionLabel={onNewPattern ? 'New pattern' : undefined}
            onAction={onNewPattern}
          />
        </div>
      ) : (
      <div
        ref={containerRef}
        className={styles.body}
        style={{ '--pr-lane-h': `${laneHeight}px` }}
      >
        <div className={`${styles.cell} ${styles.rulerCorner}`} />
        <div className={`${styles.cell} ${styles.ruler}`}>
          <PianoRollRuler
            ref={rulerRef}
            pixelsPerBeatRef={pixelsPerBeatRef}
            scrollXRef={scrollXRef}
            width={canvasWidth}
            height={23}
            patternLengthTicks={patternLengthTicks}
            timeSel={timeSel}
            snap={snap}
            onTimeSelect={selectTimeRange}
          />
        </div>
        <div className={`${styles.cell} ${styles.rulerCorner}`} />

        <div className={`${styles.cell} ${styles.keys}`}>
          <PianoRollKeyboard
            ref={keyboardRef}
            pixelsPerSemitoneRef={pixelsPerSemitoneRef}
            scrollYRef={scrollYRef}
            height={canvasHeight}
            onPreviewNote={handlePreviewNote}
            highlightedPitches={highlightedPitches}
            onSelectPitchRange={handleSelectPitchRange}
          />
        </div>
        <div ref={gridCellRef} className={styles.cell}>
          <PianoRollCanvas
            ref={pianoRollCanvasRef}
            patternId={patternId}
            notes={notes}
            patternLengthTicks={patternLengthTicks}
            activeTool={activeTool}
            slideMode={slideMode}
            stickyNoteLength={stickyNoteLength}
            setStickyNoteLength={setStickyNoteLength}
            stickyVelocity={stickyVelocity}
            setStickyVelocity={setStickyVelocity}
            stickySlideCurve={stickySlideCurve}
            onTouchNote={adoptNoteProps}
            selectedNoteIds={selectedNoteIds}
            setSelectedNoteIds={setSelectedNoteIds}
            pixelsPerBeatRef={pixelsPerBeatRef}
            pixelsPerSemitoneRef={pixelsPerSemitoneRef}
            scrollXRef={scrollXRef}
            scrollYRef={scrollYRef}
            width={canvasWidth}
            height={canvasHeight}
            onAddNote={handleAddNote}
            onRemoveNote={handleRemoveNote}
            onMoveNote={handleMoveNote}
            onMoveNotesBatch={handleMoveNotesBatch}
            onResizeNotesBatch={handleResizeNotesBatch}
            onResizeNote={handleResizeNote}
            onPreviewNote={handlePreviewNote}
            onDropFsc={handleDropFsc}
            scale={scale}
            noteColor={noteColor}
            labelMode={labelMode}
            refSlot={refSlot}
            ghosts={ghosts}
            snap={snap}
            onPan={handlePan}
            timeSel={timeSel}
            onClearTimeSel={() => setTimeSel(null)}
            onCommitNotes={commitNotes}
            onScrub={handleScrub}
            onSwitchToGhost={handleSwitchToGhost}
          />
        </div>
        <div className={styles.cell}>
          <PianoRollScrollbarV
            ref={scrollbarVRef}
            contentHeight={contentHeight}
            getContentHeight={getContentHeight}
            viewportHeight={canvasHeight}
            scrollY={scrollY}
            scrollYRef={scrollYRef}
            setScrollY={setScrollYInstant}
          />
        </div>

        <div className={`${styles.cell} ${styles.corner}`} />
        <div className={styles.cell}>
          <PianoRollScrollbarH
            ref={scrollbarHRef}
            contentWidth={contentWidth}
            getContentWidth={getContentWidth}
            viewportWidth={canvasWidth}
            scrollX={scrollX}
            scrollXRef={scrollXRef}
            setScrollX={setScrollXInstant}
            onZoomDelta={handleZoomDelta}
          />
        </div>
        <div className={`${styles.cell} ${styles.corner}`} />

        <PianoRollSplitter laneHeight={laneHeight} onLaneHeightChange={setLaneHeight} />

        <div className={`${styles.cell} ${styles.laneGutter}`}>
          <span className={styles.laneTarget}>Velocity</span>
          <span className={`${styles.laneAxis} ${styles.laneAxisTop}`}>127</span>
          <span className={`${styles.laneAxis} ${styles.laneAxisMid}`}>64</span>
          <span className={`${styles.laneAxis} ${styles.laneAxisBottom}`}>1</span>
        </div>
        <VelocityLane
          ref={velocityLaneRef}
          notes={notes}
          selectedNoteIds={selectedNoteIds}
          pixelsPerBeatRef={pixelsPerBeatRef}
          scrollXRef={scrollXRef}
          width={canvasWidth}
          height={laneHeight}
          onSetVelocity={handleSetVelocity}
          onSetVelocities={handleSetVelocities}
          noteColor={noteColor}
        />
        <div className={`${styles.cell} ${styles.corner}`} />
      </div>
      )}
    </div>
  )
}

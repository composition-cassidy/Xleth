import { useEffect, useRef, useState, useCallback } from 'react'
import useViewAnimator from '../../hooks/useViewAnimator.js'
import PianoRollToolbar from './PianoRollToolbar.jsx'
import PianoRollKeyboard, { PITCH_MIN, PITCH_MAX } from './PianoRollKeyboard.jsx'
import PianoRollCanvas from './PianoRollCanvas.jsx'
import PianoRollRuler from './PianoRollRuler.jsx'
import VelocityLane from './VelocityLane.jsx'
import PianoRollScrollbarV, { SCROLLBAR_V_WIDTH } from './PianoRollScrollbarV.jsx'
import PianoRollScrollbarH, { SCROLLBAR_H_HEIGHT } from './PianoRollScrollbarH.jsx'
import { timelineEvents } from '../../timelineEvents.js'
import { PPQ, snapBeatToGrid, beatsToTicks } from '../../constants/timeline.js'
import { registerEditorCommand } from '../../windowing/managers/EditorCommandRegistry'
import { register as registerKeyboardBinding } from '../../windowing/managers/KeyboardManager'
import { usePanelVisibility } from '../../windowing/contexts/PanelVisibilityContext'
import { useToast } from '../Toast.jsx'
import { DEFAULT_SCALE, nextScalePitch } from './scales.js'

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

const KEYBOARD_WIDTH = 60
const VELOCITY_HEIGHT = 80
const RULER_HEIGHT = 24
const TOOLBAR_HEIGHT = 40
const DEFAULT_PX_PER_BEAT = 80
const DEFAULT_PX_PER_SEMITONE = 14

const MIN_PX_PER_BEAT = 20
const MAX_PX_PER_BEAT = 320
const MIN_PX_PER_SEMITONE = 6
const MAX_PX_PER_SEMITONE = 40
const MIN_CONTENT_BEATS = 16 // minimum scrollable horizontal range

const PIANO_ROLL_KEY_COMBOS = [
  's', 'S', 'p', 'P', 'c', 'C', 'd', 'D',
  'Ctrl+z', 'Ctrl+Z', 'Meta+z', 'Meta+Z',
  'Ctrl+y', 'Ctrl+Y', 'Meta+y', 'Meta+Y',
  'Ctrl+Shift+z', 'Ctrl+Shift+Z', 'Meta+Shift+z', 'Meta+Shift+Z',
  'Ctrl+c', 'Ctrl+C', 'Meta+c', 'Meta+C',
  'Ctrl+v', 'Ctrl+V', 'Meta+v', 'Meta+V',
  'Ctrl+a', 'Ctrl+A', 'Meta+a', 'Meta+A',
  'Delete', 'Backspace',
  'ArrowUp', 'ArrowDown', 'Shift+ArrowUp', 'Shift+ArrowDown',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]

// Editor-local clipboard fallback: note copy/paste must not depend on transient
// Chromium clipboard permission or window-focus state.
let pianoRollClipboard = null

export function resetPianoRollClipboardForTest() {
  pianoRollClipboard = null
}

export default function PianoRoll({
  patternId, onClose,
  onDetach, onDock, floating = false, onTitleMouseDown, onTitleDoubleClick,
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
}) {
  const { isVisible } = usePanelVisibility()
  const { showToast } = useToast()
  const [pattern, setPattern] = useState(null)
  const [regions, setRegions] = useState([])
  const [activeTool, setActiveTool] = useState('pencil')
  const [slideMode, setSlideMode] = useState(false)
  const [stickyNoteLength, setStickyNoteLength] = useState(240) // 1/16 default
  const [stickyVelocity, setStickyVelocity] = useState(1.0)
  // Snap to Scale is an editor-local view setting: it constrains what the user
  // can draw, but nothing about it is stored on the pattern.
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [selectedNoteIds, setSelectedNoteIds] = useState(new Set())
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
  const [size, setSize] = useState({ w: 800, h: 500 })
  const containerRef = useRef(null)
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

  const fetchPattern = useCallback(async () => {
    try {
      const p = await window.xleth?.timeline?.getPattern(patternId)
      if (p) setPattern(p)
    } catch (e) {
      console.warn('[PianoRoll] getPattern failed:', e.message)
    }
  }, [patternId])

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

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Initial scroll: center around C4 (pitch 60) — instant, not eased; this
  // is the panel settling into place, not a user gesture.
  useEffect(() => {
    const canvasH = size.h - VELOCITY_HEIGHT - TOOLBAR_HEIGHT - RULER_HEIGHT
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

  const deleteSelectedNotes = useCallback(async () => {
    const ids = Array.from(selectedNoteIdsRef.current)
    if (ids.length === 0) return false
    const xl = window.xleth
    for (const id of ids) {
      try { await xl.timeline.removeNote(patternId, id) } catch { /* ignore */ }
    }
    setSelectedNoteIds(new Set())
    notifyChanged()
    return true
  }, [patternId, notifyChanged])

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

  const handleSetVelocity = useCallback(async (noteId, velocity) => {
    try {
      await window.xleth?.timeline?.setNoteVelocity(patternId, noteId, velocity)
      setStickyVelocity(velocity)
      notifyChanged()
    } catch (e) { console.warn('[PianoRoll] setNoteVelocity failed:', e.message) }
  }, [patternId, notifyChanged])

  // Multi-note velocity drag: one write per note, one refetch for the batch.
  // stickyVelocity follows the note the user actually grabbed, which the
  // VelocityLane puts first in the entry list.
  const handleSetVelocities = useCallback(async (entries) => {
    if (!entries?.length) return
    for (const { noteId, velocity } of entries) {
      try { await window.xleth?.timeline?.setNoteVelocity(patternId, noteId, velocity) }
      catch (e) { console.warn('[PianoRoll] setNoteVelocity failed:', e.message) }
    }
    setStickyVelocity(entries[0].velocity)
    notifyChanged()
  }, [patternId, notifyChanged])

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
    const release = (sendNoteOff = true) => {
      if (!previewReleasesRef.current.delete(release)) return
      if (onMouseUp) window.removeEventListener('mouseup', onMouseUp)
      if (onMouseLeave) window.removeEventListener('mouseleave', onMouseLeave)
      if (sendNoteOff) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, pitch)
      }
    }
    onMouseUp = () => release(true)
    onMouseLeave = () => release(true)
    previewReleasesRef.current.add(release)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mouseleave', onMouseLeave)
  }, [pattern?.regionId])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const pianoRollKeyHandlerRef = useRef(null)
  pianoRollKeyHandlerRef.current = async (e) => {

      // Tool shortcuts
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); e.stopPropagation(); setActiveTool('select'); return }
        if (e.key === 'p' || e.key === 'P') { e.preventDefault(); e.stopPropagation(); setActiveTool('pencil'); return }
        if (e.key === 'c' || e.key === 'C') { e.preventDefault(); e.stopPropagation(); setActiveTool('split');  return }
        if (e.key === 'd' || e.key === 'D') { e.preventDefault(); e.stopPropagation(); setActiveTool('delete'); return }
      }

      // Undo / Redo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        e.stopPropagation()
        await window.xleth?.undo?.undo()
        notifyChanged()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
        e.preventDefault()
        e.stopPropagation()
        await window.xleth?.undo?.redo()
        notifyChanged()
        return
      }

      // Copy selected notes (Ctrl+C)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !e.shiftKey && !e.altKey) {
        const selIds = selectedNoteIdsRef.current
        if (selIds.size === 0) return
        e.preventDefault()
        e.stopPropagation()
        const byId = Object.fromEntries((pattern?.notes || []).map((n) => [n.id, n]))
        const selected = []
        for (const id of selIds) {
          const n = byId[id]
          if (n) selected.push(n)
        }
        if (selected.length === 0) return
        const minPosition = Math.min(...selected.map((n) => n.positionTicks))
        const payload = {
          type: 'xleth-notes',
          notes: selected.map((n) => ({
            positionTicks: n.positionTicks - minPosition,
            durationTicks: n.durationTicks,
            pitch: n.pitch,
            velocity: n.velocity,
          })),
        }
        pianoRollClipboard = payload
        try {
          await navigator.clipboard?.writeText?.(JSON.stringify(payload))
        } catch (err) { console.warn('[PianoRoll] copy failed:', err.message) }
        return
      }

      // Paste notes (Ctrl+V)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        try {
          let payload = pianoRollClipboard
          if (!payload) {
            const text = await navigator.clipboard?.readText?.()
            payload = text ? JSON.parse(text) : null
          }
          if (!payload || payload.type !== 'xleth-notes' || !Array.isArray(payload.notes)) return
          // Paste anchor: left edge of viewport snapped to the active grid.
          const pasteBeat = snapBeatToGrid(Math.max(0, scrollXRef.current / pixelsPerBeatRef.current), {})
          const pasteTicks = beatsToTicks(pasteBeat)
          const newIds = new Set()
          for (const n of payload.notes) {
            const newId = await window.xleth?.timeline?.addNote(patternId, {
              positionTicks: pasteTicks + (n.positionTicks | 0),
              durationTicks: n.durationTicks,
              pitch: n.pitch,
              velocity: n.velocity,
            })
            if (typeof newId === 'number' && newId >= 0) newIds.add(newId)
          }
          if (newIds.size > 0) setSelectedNoteIds(newIds)
          notifyChanged()
        } catch (err) { console.warn('[PianoRoll] paste failed:', err.message) }
        return
      }

      // Select all
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        e.stopPropagation()
        const ids = new Set((pattern?.notes || []).map((n) => n.id))
        setSelectedNoteIds(ids)
        return
      }

      // Delete selected notes
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = Array.from(selectedNoteIdsRef.current)
        if (ids.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        await deleteSelectedNotes()
        return
      }

      // Transpose selected ±1 or ±12
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const ids = Array.from(selectedNoteIdsRef.current)
        if (ids.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const dir = e.key === 'ArrowUp' ? 1 : -1
        const delta = dir * (e.shiftKey ? 12 : 1)
        const byId = Object.fromEntries((pattern?.notes || []).map((n) => [n.id, n]))
        for (const id of ids) {
          const n = byId[id]
          if (!n) continue
          // Under scale lock a semitone step becomes a scale-degree step. The
          // ±12 octave jump already preserves pitch class, so it needs no snap.
          const newPitch = (scale.enabled && !e.shiftKey)
            ? nextScalePitch(n.pitch, dir, scale.root, scale.mode, PITCH_MIN, PITCH_MAX)
            : Math.max(PITCH_MIN, Math.min(PITCH_MAX, n.pitch + delta))
          try { await window.xleth?.timeline?.moveNote(patternId, id, n.positionTicks, newPitch) } catch { /* ignore */ }
        }
        notifyChanged()
        return
      }

      // Velocity 0..9 → 0.1..1.0
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ids = Array.from(selectedNoteIdsRef.current)
        if (ids.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const k = parseInt(e.key, 10)
        const vel = k === 0 ? 1.0 : k / 10
        for (const id of ids) {
          try { await window.xleth?.timeline?.setNoteVelocity(patternId, id, vel) } catch { /* ignore */ }
        }
        notifyChanged()
      }
    }
  useEffect(() => {
    const dispatch = (e) => {
      const pending = pianoRollKeyHandlerRef.current?.(e)
      pending?.catch?.((err) => console.warn('[PianoRoll] shortcut failed:', err?.message || err))
      return e.defaultPrevented ? 'handled' : undefined
    }
    const unsubscribers = PIANO_ROLL_KEY_COMBOS.map((combo) =>
      registerKeyboardBinding({ scope: 'panel:pianoRoll', combo, handler: dispatch }),
    )
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

  // Wheel: vertical scroll; ctrl+wheel = zoom horizontal; alt+wheel = zoom
  // vertical; shift+wheel = horizontal scroll.
  // Every branch sets a TARGET on the view animator and lets its spring ease
  // toward it — no instant setState jump (see useViewAnimator.js).
  const handleWheel = useCallback((e) => {
    const animator = viewAnimatorRef.current
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
      const maxScrollY = Math.max(0, (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitone - (size.h - VELOCITY_HEIGHT - TOOLBAR_HEIGHT - RULER_HEIGHT - SCROLLBAR_H_HEIGHT))
      const next = Math.max(0, Math.min(maxScrollY, animator.getTarget('scrollY') + e.deltaY))
      animator.setTarget('scrollY', next)
    }
  }, [pixelsPerSemitone, size.h])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const notes = pattern?.notes || []
  const patternLengthTicks = pattern?.lengthTicks || 0
  const highlightedPitches = new Set(notes.map((n) => n.pitch))
  const canvasWidth = Math.max(0, size.w - KEYBOARD_WIDTH - SCROLLBAR_V_WIDTH)
  const canvasHeight = Math.max(0, size.h - VELOCITY_HEIGHT - TOOLBAR_HEIGHT - RULER_HEIGHT - SCROLLBAR_H_HEIGHT)

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
    <div
      className="piano-roll"
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#0d0d0d' }}
    >
      {floating && (
        <div
          className="piano-roll-floating-titlebar"
          onMouseDown={onTitleMouseDown}
          onDoubleClick={onTitleDoubleClick}
        >
          <span className="piano-roll-floating-titlebar-label">
            Piano Roll — {pattern?.name || 'Pattern'}
          </span>
          <div className="piano-roll-floating-titlebar-actions">
            <button
              className="piano-roll-floating-titlebar-btn"
              title="Dock"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onDock}
            >⤓</button>
            <button
              className="piano-roll-floating-titlebar-btn"
              title="Close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onClose}
            >✕</button>
          </div>
        </div>
      )}
      <PianoRollToolbar
        patternName={pattern?.name || 'Pattern'}
        activeTool={activeTool} onToolChange={setActiveTool}
        slideMode={slideMode} onSlideModeChange={setSlideMode}
        stickyNoteLength={stickyNoteLength} onStickyNoteLengthChange={setStickyNoteLength}
        scale={scale} onScaleChange={setScale}
        onZoomIn={handleZoomIn} onZoomOut={handleZoomOut}
        onOpenSamplerSettings={handleOpenSamplerSettings}
        samplerSettingsDisabled={samplerSettingsDisabled}
        onClose={onClose}
        floating={floating}
        onDetach={onDetach}
        onDock={onDock}
        availablePatterns={availablePatterns}
        currentPatternId={currentPatternId}
        onSwitchPattern={onSwitchPattern}
        onNewPattern={onNewPattern}
        regions={regions}
        currentRegionId={pattern?.regionId ?? -1}
        onRegionChange={handleRegionChange}
      />
      <div ref={containerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <PianoRollRuler
          ref={rulerRef}
          pixelsPerBeatRef={pixelsPerBeatRef}
          scrollXRef={scrollXRef}
          width={canvasWidth}
          height={RULER_HEIGHT}
          keyboardWidth={KEYBOARD_WIDTH}
          scrollbarWidth={SCROLLBAR_V_WIDTH}
        />
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <PianoRollKeyboard
            ref={keyboardRef}
            pixelsPerSemitoneRef={pixelsPerSemitoneRef}
            scrollYRef={scrollYRef}
            height={canvasHeight}
            onPreviewNote={handlePreviewNote}
            highlightedPitches={highlightedPitches}
          />
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
          />
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
        <div style={{ display: 'flex' }}>
          <div style={{ width: KEYBOARD_WIDTH, background: '#0d0d0d', borderRight: '1px solid #222', borderTop: '1px solid #222' }} />
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
          <div style={{ width: SCROLLBAR_V_WIDTH, background: '#0d0d0d', borderTop: '1px solid #222' }} />
        </div>
        <div style={{ display: 'flex' }}>
          <div className="piano-roll-velocity-gutter" style={{ width: KEYBOARD_WIDTH, height: VELOCITY_HEIGHT }}>
            <span className="piano-roll-velocity-title">VEL</span>
            <span className="piano-roll-velocity-axis" style={{ top: 4 }}>127</span>
            <span className="piano-roll-velocity-axis" style={{ top: '50%' }}>64</span>
            <span className="piano-roll-velocity-axis" style={{ bottom: 3 }}>1</span>
          </div>
          <VelocityLane
            ref={velocityLaneRef}
            notes={notes}
            selectedNoteIds={selectedNoteIds}
            pixelsPerBeatRef={pixelsPerBeatRef}
            scrollXRef={scrollXRef}
            width={canvasWidth}
            height={VELOCITY_HEIGHT}
            onSetVelocity={handleSetVelocity}
            onSetVelocities={handleSetVelocities}
          />
          <div style={{ width: SCROLLBAR_V_WIDTH, background: '#181818', borderTop: '1px solid #222' }} />
        </div>
      </div>
    </div>
  )
}

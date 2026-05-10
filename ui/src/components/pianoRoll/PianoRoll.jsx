import { useEffect, useRef, useState, useCallback } from 'react'
import PianoRollToolbar from './PianoRollToolbar.jsx'
import PianoRollKeyboard, { PITCH_MIN, PITCH_MAX } from './PianoRollKeyboard.jsx'
import PianoRollCanvas from './PianoRollCanvas.jsx'
import VelocityLane from './VelocityLane.jsx'
import PianoRollScrollbarV, { SCROLLBAR_V_WIDTH } from './PianoRollScrollbarV.jsx'
import PianoRollScrollbarH, { SCROLLBAR_H_HEIGHT } from './PianoRollScrollbarH.jsx'
import { timelineEvents } from '../../timelineEvents.js'
import { PPQ, snapBeatToGrid, beatsToTicks } from '../../constants/timeline.js'
import usePianoRollStore from '../../stores/usePianoRollStore.js'

const KEYBOARD_WIDTH = 60
const VELOCITY_HEIGHT = 80
const DEFAULT_PX_PER_BEAT = 80
const DEFAULT_PX_PER_SEMITONE = 14

const MIN_PX_PER_BEAT = 20
const MAX_PX_PER_BEAT = 320
const MIN_CONTENT_BEATS = 16 // minimum scrollable horizontal range

export default function PianoRoll({
  patternId, onClose,
  onDetach, onDock, floating = false, onTitleMouseDown, onTitleDoubleClick,
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
}) {
  const activeCenterTab = usePianoRollStore((s) => s.activeCenterTab)
  const [pattern, setPattern] = useState(null)
  const [regions, setRegions] = useState([])
  const [activeTool, setActiveTool] = useState('pencil')
  const [slideMode, setSlideMode] = useState(false)
  const [stickyNoteLength, setStickyNoteLength] = useState(240) // 1/16 default
  const [stickyVelocity, setStickyVelocity] = useState(1.0)
  const [selectedNoteIds, setSelectedNoteIds] = useState(new Set())
  const [pixelsPerBeat, setPixelsPerBeat] = useState(DEFAULT_PX_PER_BEAT)
  const [pixelsPerSemitone] = useState(DEFAULT_PX_PER_SEMITONE)
  const [scrollX, setScrollX] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const [size, setSize] = useState({ w: 800, h: 500 })
  const containerRef = useRef(null)
  const selectedNoteIdsRef = useRef(selectedNoteIds)
  selectedNoteIdsRef.current = selectedNoteIds
  const previewReleasesRef = useRef(new Set())
  // Mirror scroll/zoom into refs so the keydown handler (Ctrl+V paste) can
  // read them without re-registering on every scroll tick.
  const scrollXRef = useRef(scrollX)
  scrollXRef.current = scrollX
  const pixelsPerBeatRef = useRef(pixelsPerBeat)
  pixelsPerBeatRef.current = pixelsPerBeat

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

  // Initial scroll: center around C4 (pitch 60)
  useEffect(() => {
    const canvasH = size.h - VELOCITY_HEIGHT - 40
    const targetY = (PITCH_MAX - 60) * pixelsPerSemitone - canvasH / 2
    setScrollY(Math.max(0, targetY))
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

  // Silence when the center tab navigates away from the piano roll.
  useEffect(() => {
    if (floating) return
    if (activeCenterTab !== 'piano-roll') {
      const regionId = pattern?.regionId
      if (regionId != null && regionId >= 0) {
        try { window.xleth?.timeline?.previewAllNotesOff?.(regionId) } catch { /* ignore */ }
      }
      clearPendingPreviewReleases(false)
    }
  }, [activeCenterTab, clearPendingPreviewReleases, floating, pattern?.regionId])

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
  useEffect(() => {
    const onKey = async (e) => {
      const target = e.target
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (activeCenterTab !== 'piano-roll' && !floating) return

      // Tool shortcuts
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 's' || e.key === 'S') { setActiveTool('select'); e.stopPropagation(); return }
        if (e.key === 'p' || e.key === 'P') { setActiveTool('pencil'); e.stopPropagation(); return }
        if (e.key === 'c' || e.key === 'C') { setActiveTool('split');  e.stopPropagation(); return }
        if (e.key === 'd' || e.key === 'D') { setActiveTool('delete'); e.stopPropagation(); return }
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
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload))
        } catch (err) { console.warn('[PianoRoll] copy failed:', err.message) }
        return
      }

      // Paste notes (Ctrl+V)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        try {
          const text = await navigator.clipboard.readText()
          const payload = JSON.parse(text)
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
        for (const id of ids) {
          try { await window.xleth?.timeline?.removeNote(patternId, id) } catch { /* ignore */ }
        }
        setSelectedNoteIds(new Set())
        notifyChanged()
        return
      }

      // Transpose selected ±1 or ±12
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const ids = Array.from(selectedNoteIdsRef.current)
        if (ids.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)
        const byId = Object.fromEntries((pattern?.notes || []).map((n) => [n.id, n]))
        for (const id of ids) {
          const n = byId[id]
          if (!n) continue
          const newPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, n.pitch + delta))
          try { await window.xleth?.timeline?.moveNote(patternId, id, n.positionTicks, newPitch) } catch { /* ignore */ }
        }
        notifyChanged()
        return
      }

      // Velocity 0..9 → 0.1..1.0
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ids = Array.from(selectedNoteIdsRef.current)
        if (ids.length === 0) return
        e.stopPropagation()
        const k = parseInt(e.key, 10)
        const vel = k === 0 ? 1.0 : k / 10
        for (const id of ids) {
          try { await window.xleth?.timeline?.setNoteVelocity(patternId, id, vel) } catch { /* ignore */ }
        }
        notifyChanged()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [patternId, pattern, notifyChanged, activeCenterTab, floating])

  const handleZoomIn = useCallback(() => {
    setPixelsPerBeat((p) => Math.min(MAX_PX_PER_BEAT, p * 1.25))
  }, [])
  const handleZoomOut = useCallback(() => {
    setPixelsPerBeat((p) => Math.max(MIN_PX_PER_BEAT, p / 1.25))
  }, [])

  const handleOpenSamplerSettings = useCallback(() => {
    const regionId = pattern?.regionId
    if (regionId == null || regionId < 0) return
    timelineEvents.dispatchEvent(new CustomEvent('open-sampler-settings', { detail: { regionId } }))
  }, [pattern?.regionId])

  const samplerSettingsDisabled = pattern?.regionId == null || pattern.regionId < 0

  // Wheel: vertical scroll; ctrl+wheel = zoom horizontal; shift+wheel = horizontal scroll
  const handleWheel = useCallback((e) => {
    if (e.ctrlKey) {
      e.preventDefault()
      setPixelsPerBeat((p) => {
        const next = e.deltaY < 0 ? p * 1.15 : p / 1.15
        return Math.max(MIN_PX_PER_BEAT, Math.min(MAX_PX_PER_BEAT, next))
      })
    } else if (e.shiftKey) {
      e.preventDefault()
      setScrollX((x) => Math.max(0, x + e.deltaY))
    } else {
      e.preventDefault()
      const maxScrollY = Math.max(0, (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitone - (size.h - VELOCITY_HEIGHT - 40 - SCROLLBAR_H_HEIGHT))
      setScrollY((y) => Math.max(0, Math.min(maxScrollY, y + e.deltaY)))
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
  const canvasHeight = Math.max(0, size.h - VELOCITY_HEIGHT - 40 - SCROLLBAR_H_HEIGHT) // 40 = toolbar

  // Content bounds for scrollbar sizing
  const contentHeight = (PITCH_MAX - PITCH_MIN + 1) * pixelsPerSemitone
  const lastNoteBeatsEnd = notes.length > 0
    ? Math.max(...notes.map((n) => (n.positionTicks + n.durationTicks) / PPQ))
    : 0
  const patternLenBeats = patternLengthTicks / PPQ
  const minContentBeats = Math.max(MIN_CONTENT_BEATS, lastNoteBeatsEnd + 4, patternLenBeats + 4)
  const contentWidth = Math.max(canvasWidth, minContentBeats * pixelsPerBeat)

  const handleZoomDelta = useCallback((direction) => {
    setPixelsPerBeat((p) => {
      const next = direction > 0 ? p * 1.15 : p / 1.15
      return Math.max(MIN_PX_PER_BEAT, Math.min(MAX_PX_PER_BEAT, next))
    })
  }, [])

  // Clamp scrollX if content shrank
  useEffect(() => {
    const maxX = Math.max(0, contentWidth - canvasWidth)
    setScrollX((x) => Math.min(x, maxX))
  }, [contentWidth, canvasWidth])

  return (
    <div
      className="piano-roll"
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: 'var(--theme-bg-inset)' }}
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
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <PianoRollKeyboard
            pixelsPerSemitone={pixelsPerSemitone}
            scrollY={scrollY}
            height={canvasHeight}
            onPreviewNote={handlePreviewNote}
            highlightedPitches={highlightedPitches}
          />
          <PianoRollCanvas
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
            pixelsPerBeat={pixelsPerBeat}
            pixelsPerSemitone={pixelsPerSemitone}
            scrollX={scrollX}
            scrollY={scrollY}
            width={canvasWidth}
            height={canvasHeight}
            onAddNote={handleAddNote}
            onRemoveNote={handleRemoveNote}
            onMoveNote={handleMoveNote}
            onMoveNotesBatch={handleMoveNotesBatch}
            onResizeNotesBatch={handleResizeNotesBatch}
            onResizeNote={handleResizeNote}
            onPreviewNote={handlePreviewNote}
          />
          <PianoRollScrollbarV
            contentHeight={contentHeight}
            viewportHeight={canvasHeight}
            scrollY={scrollY}
            setScrollY={setScrollY}
          />
        </div>
        <div style={{ display: 'flex' }}>
          <div style={{ width: KEYBOARD_WIDTH, background: 'var(--theme-pianoroll-key-white-bg)', borderRight: '1px solid var(--theme-border-subtle)', borderTop: '1px solid var(--theme-border-subtle)' }} />
          <PianoRollScrollbarH
            contentWidth={contentWidth}
            viewportWidth={canvasWidth}
            scrollX={scrollX}
            setScrollX={setScrollX}
            onZoomDelta={handleZoomDelta}
          />
          <div style={{ width: SCROLLBAR_V_WIDTH, background: 'var(--theme-pianoroll-key-white-bg)', borderTop: '1px solid var(--theme-border-subtle)' }} />
        </div>
        <div style={{ display: 'flex' }}>
          <div style={{ width: KEYBOARD_WIDTH, background: 'var(--theme-pianoroll-key-white-bg)', borderRight: '1px solid var(--theme-border-subtle)', borderTop: '1px solid var(--theme-border-subtle)' }} />
          <VelocityLane
            notes={notes}
            selectedNoteIds={selectedNoteIds}
            pixelsPerBeat={pixelsPerBeat}
            scrollX={scrollX}
            width={canvasWidth}
            height={VELOCITY_HEIGHT}
            onSetVelocity={handleSetVelocity}
          />
          <div style={{ width: SCROLLBAR_V_WIDTH, background: 'var(--theme-pianoroll-key-white-bg)', borderTop: '1px solid var(--theme-border-subtle)' }} />
        </div>
      </div>
    </div>
  )
}

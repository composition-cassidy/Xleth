import {
  useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef,
} from 'react'
import {
  drawGrid, drawClips, drawPatternBlocks, drawHoldZones, resolveTimelinePalette, withAlpha,
} from './timelineDrawing.js'
import { buildResolvedTrackColorMap } from './trackColorResolver.js'
import {
  TRACK_HEIGHT, PPQ, pixelToBeat, beatToPlayheadPixel, snapBeatToGrid,
} from '../../constants/timeline.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import XlethSelect from '../common/XlethSelect.jsx'

const PLAYHEAD_LINE_WIDTH = 1

export const CUE_LANE_HEIGHT = 30

// Cue stems and the shared DOM playhead both call this exact tick-to-x mapping.
// The half-pixel grid alignment is folded into beatToPlayheadPixel for a 1px line.
export function mirrorTickToPixel(tick, scrollOffset, pixelsPerBeat) {
  return beatToPlayheadPixel(tick / PPQ, scrollOffset, pixelsPerBeat, PLAYHEAD_LINE_WIDTH)
}

// ── Snapshot transition editing (Slice 4) ──────────────────────────────────
// The cue MARKER is the fixed pin (the boundary = 50% blend, on the beat) and is
// never moved by the transition editor. The two draggable handles around it —
// Start (left of the pin) and End (right of it) — author the only two values
// that change: startOffsetTicks / endOffsetTicks (>= 0, in TICKS). A hard cut is
// both offsets 0 (the default); transitions are opt-in via the Enable toggle.

// Only the two styles the engine renders distinctly in v1 are exposed. The
// engine silently falls back every other Type to Crossfade, so surfacing
// Zoom / Push / Slide / Dissolve / OutThenIn would misrepresent what actually
// renders. Add each here as the engine gains a real shader for it.
export const TRANSITION_TYPE_OPTIONS = [
  { value: 'crossfade', label: 'Crossfade' },
  { value: 'lineSweep', label: 'Line Sweep' },
]

// Window seeded on both sides of the pin the moment a hard-cut cue is switched
// to a transition, so the Start/End handles appear off the pin and are grabbable.
export const DEFAULT_TRANSITION_WINDOW_TICKS = PPQ  // one beat

// Snap a handle's pointer position to a whole tick. Offsets are authored in
// ticks, so every drag resolves to an integer tick: by default it snaps to the
// musical grid; holding Alt frees the snap but STILL quantizes to a whole tick
// (the engine's progress curve is sample-deterministic either way).
export function transitionHandleTick(localX, scrollOffset, pixelsPerBeat, modifiers, granularity) {
  const beat = pixelToBeat(localX, scrollOffset, pixelsPerBeat)
  const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, granularity)
  return Math.max(0, Math.round(snappedBeat * PPQ))
}

// Offsets are stored >= 0 and never cross the pin: Start sits at or left of the
// pin, End at or right of it.
export function clampStartOffsetTicks(pinTick, handleTick) {
  return Math.max(0, pinTick - handleTick)
}
export function clampEndOffsetTicks(pinTick, handleTick) {
  return Math.max(0, handleTick - pinTick)
}

// Merge a partial edit into the FULL six-field transition object the engine
// expects. setCueTransition replaces the whole transition (any omitted field
// reverts to its engine default), so every write must send all six fields.
export function buildCueTransition(current, patch = {}) {
  const pick = (key, fallback) => (
    patch[key] !== undefined ? patch[key]
      : (current && current[key] !== undefined ? current[key] : fallback)
  )
  const merged = {
    enabled:          !!pick('enabled', false),
    startOffsetTicks: Math.max(0, Math.round(pick('startOffsetTicks', 0))),
    endOffsetTicks:   Math.max(0, Math.round(pick('endOffsetTicks', 0))),
    type:             pick('type', 'crossfade'),
    freezeOutgoing:   !!pick('freezeOutgoing', true),
    geomAngleDeg:     Number(pick('geomAngleDeg', 0)) || 0,
  }
  // Seed a visible window only when THIS edit is the one enabling a collapsed
  // (hard-cut) transition — never when merely changing type/freeze later.
  if (patch.enabled === true && merged.startOffsetTicks === 0 && merged.endOffsetTicks === 0) {
    merged.startOffsetTicks = DEFAULT_TRANSITION_WINDOW_TICKS
    merged.endOffsetTicks   = DEFAULT_TRANSITION_WINDOW_TICKS
  }
  return merged
}

function CueMarker({
  cue, x, laneWidth, snapshots, selected, onSelect, onMoveCue, onRemoveCue, onRepointCue,
  onSetCueTransition, pixelsPerBeatRef, scrollOffsetRef, containerRef,
}) {
  const markerRef = useRef(null)

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startClientX = e.clientX
    const startX = x
    let dragTick = cue.tick
    let dragged = false

    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startClientX
      if (!dragged && Math.abs(delta) < 3) return
      dragged = true
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localX = Math.max(0, Math.min(laneWidth, moveEvent.clientX - rect.left))
      const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
      dragTick = Math.max(0, Math.round(beat * PPQ))
      const dragX = mirrorTickToPixel(dragTick, scrollOffsetRef.current, pixelsPerBeatRef.current)
      if (markerRef.current) markerRef.current.style.transform = 'translateX(' + dragX + 'px)'
    }

    const onUp = async () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!dragged) {
        onSelect(cue.tick)
        return
      }
      const moved = await onMoveCue(cue.tick, dragTick)
      // Collision/IPC failure: restore the original pixel immediately. The
      // parent's mandatory listCues reconciliation supplies the durable position.
      if (!moved && markerRef.current) {
        markerRef.current.style.transform = 'translateX(' + startX + 'px)'
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [containerRef, cue.tick, laneWidth, onMoveCue, onSelect, pixelsPerBeatRef, scrollOffsetRef, x])

  const options = snapshots.map((snapshot) => ({ value: snapshot.id, label: snapshot.name }))

  return (
    <div
      ref={markerRef}
      className={'vmt-cue-marker-wrap' + (selected ? ' is-selected' : '') + (x > laneWidth - 160 ? ' is-editor-left' : '')}
      style={{ transform: 'translateX(' + x + 'px)' }}
      data-tick={cue.tick}
    >
      <button
        type="button"
        className="vmt-cue-marker"
        onPointerDown={handlePointerDown}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={'Snapshot cue at tick ' + cue.tick}
        title="Drag to move; click to choose snapshot"
      />
      {selected && (
        <div className="vmt-cue-editor" onMouseDown={(e) => e.stopPropagation()}>
          <div className="vmt-cue-editor-row">
            <XlethSelect
              className="vmt-cue-select"
              value={cue.snapshotId}
              options={options}
              onChange={(snapshotId) => onRepointCue(cue.tick, snapshotId)}
              ariaLabel={'Snapshot for cue at tick ' + cue.tick}
              disabled={options.length === 0}
            />
            <button
              type="button"
              className="vmt-delete-cue"
              onClick={() => onRemoveCue(cue.tick)}
              aria-label={'Delete cue at tick ' + cue.tick}
              title="Delete cue"
            >
              ×
            </button>
          </div>
          {/* Boundary animation. The pin (this marker) stays put; only the
              Start/End handles on the timeline and these fields change. */}
          <div className="vmt-transition-editor">
            <label className="vmt-transition-row">
              <input
                type="checkbox"
                className="vmt-transition-enable"
                checked={!!cue.transition?.enabled}
                onChange={(e) => onSetCueTransition(
                  cue.tick, buildCueTransition(cue.transition, { enabled: e.target.checked }),
                )}
              />
              <span>Transition</span>
            </label>
            {cue.transition?.enabled && (
              <div className="vmt-transition-fields">
                <XlethSelect
                  className="vmt-transition-type"
                  value={cue.transition?.type || 'crossfade'}
                  options={TRANSITION_TYPE_OPTIONS}
                  onChange={(type) => onSetCueTransition(
                    cue.tick, buildCueTransition(cue.transition, { type }),
                  )}
                  ariaLabel={'Animation type for cue at tick ' + cue.tick}
                />
                <label className="vmt-transition-row">
                  <input
                    type="checkbox"
                    checked={cue.transition?.freezeOutgoing !== false}
                    onChange={(e) => onSetCueTransition(
                      cue.tick, buildCueTransition(cue.transition, { freezeOutgoing: e.target.checked }),
                    )}
                  />
                  <span>Freeze outgoing</span>
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// The transition editor's on-timeline half: a shaded window around a cue's fixed
// pin. The pin never moves here (that stays the CueMarker's drag) — only the two
// offsets change. Rendered for every enabled cue as a visualization; the
// selected cue additionally gets the draggable Start/End handles.
function TransitionBand({
  cue, laneWidth, interactive,
  pixelsPerBeatRef, scrollOffsetRef, snapGranularityRef, containerRef,
  onSetCueTransition,
}) {
  const bandRef = useRef(null)
  const startRef = useRef(null)
  const endRef = useRef(null)

  const tr = cue.transition || {}
  const pinTick = cue.tick
  const startOffset = Math.max(0, tr.startOffsetTicks || 0)
  const endOffset = Math.max(0, tr.endOffsetTicks || 0)
  const scroll = scrollOffsetRef.current
  const ppb = pixelsPerBeatRef.current
  const startX = mirrorTickToPixel(Math.max(0, pinTick - startOffset), scroll, ppb)
  const endX = mirrorTickToPixel(pinTick + endOffset, scroll, ppb)

  const startDrag = useCallback((which) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    // Keep the outgoing offset fixed while dragging one handle; buildCueTransition
    // supplies the full six-field object each write needs.
    let next = buildCueTransition(tr, { enabled: true })
    const paint = () => {
      const s = mirrorTickToPixel(Math.max(0, pinTick - next.startOffsetTicks), scrollOffsetRef.current, pixelsPerBeatRef.current)
      const en = mirrorTickToPixel(pinTick + next.endOffsetTicks, scrollOffsetRef.current, pixelsPerBeatRef.current)
      if (bandRef.current) {
        bandRef.current.style.left = s + 'px'
        bandRef.current.style.width = Math.max(0, en - s) + 'px'
      }
      if (startRef.current) startRef.current.style.transform = 'translateX(' + s + 'px)'
      if (endRef.current) endRef.current.style.transform = 'translateX(' + en + 'px)'
    }
    const onMove = (moveEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const localX = Math.max(0, Math.min(laneWidth, moveEvent.clientX - rect.left))
      const modifiers = { alt: moveEvent.altKey, shift: moveEvent.shiftKey, ctrl: moveEvent.ctrlKey || moveEvent.metaKey }
      const handleTick = transitionHandleTick(localX, scrollOffsetRef.current, pixelsPerBeatRef.current, modifiers, snapGranularityRef.current)
      const patch = which === 'start'
        ? { startOffsetTicks: clampStartOffsetTicks(pinTick, handleTick) }
        : { endOffsetTicks: clampEndOffsetTicks(pinTick, handleTick) }
      next = buildCueTransition(next, patch)
      paint()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      onSetCueTransition(pinTick, next)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [tr, pinTick, laneWidth, containerRef, scrollOffsetRef, pixelsPerBeatRef, snapGranularityRef, onSetCueTransition])

  return (
    <>
      <div
        ref={bandRef}
        className="vmt-transition-band"
        style={{ left: startX, width: Math.max(0, endX - startX) }}
        aria-hidden="true"
      />
      {interactive && (
        <>
          <div
            ref={startRef}
            className="vmt-transition-handle vmt-transition-handle-start"
            style={{ transform: 'translateX(' + startX + 'px)' }}
            onPointerDown={startDrag('start')}
            onMouseDown={(e) => e.stopPropagation()}
            role="slider"
            aria-label={'Transition start for cue at tick ' + pinTick}
            aria-valuenow={startOffset}
            title="Drag to set the transition start (snaps to grid; hold Alt to free)"
          />
          <div
            ref={endRef}
            className="vmt-transition-handle vmt-transition-handle-end"
            style={{ transform: 'translateX(' + endX + 'px)' }}
            onPointerDown={startDrag('end')}
            onMouseDown={(e) => e.stopPropagation()}
            role="slider"
            aria-label={'Transition end for cue at tick ' + pinTick}
            aria-valuenow={endOffset}
            title="Drag to set the transition end (snaps to grid; hold Alt to free)"
          />
        </>
      )}
    </>
  )
}

function CueLane({
  top, width, cues, snapshots, defaultSnapshotId, totalBeats,
  pixelsPerBeatRef, scrollOffsetRef, snapGranularityRef, containerRef,
  onMoveCue, onRemoveCue, onRepointCue, onSetCueTransition,
}) {
  const [selectedTick, setSelectedTick] = useState(null)
  const names = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.name]))
  const sorted = [...cues].sort((a, b) => a.tick - b.tick)
  const lastCueTick = sorted.length > 0 ? sorted[sorted.length - 1].tick : 0
  const endTick = Math.max(Math.round(totalBeats * PPQ), lastCueTick)

  useEffect(() => {
    if (selectedTick !== null && !cues.some((cue) => cue.tick === selectedTick)) {
      setSelectedTick(null)
    }
  }, [cues, selectedTick])

  // Safety audit: with no cues this still creates one default/Base span from
  // tick zero through the visible song extent.
  const spans = []
  let startTick = 0
  let snapshotId = defaultSnapshotId
  for (const cue of sorted) {
    spans.push({ startTick, endTick: cue.tick, snapshotId })
    startTick = cue.tick
    snapshotId = cue.snapshotId
  }
  spans.push({ startTick, endTick, snapshotId })

  return (
    <div
      className="vmt-cue-lane"
      style={{ top, height: CUE_LANE_HEIGHT }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedTick(null)
      }}
    >
      <div className="vmt-cue-spans" aria-hidden="true">
        {spans.map((span, index) => {
          const left = mirrorTickToPixel(span.startTick, scrollOffsetRef.current, pixelsPerBeatRef.current)
          const right = mirrorTickToPixel(span.endTick, scrollOffsetRef.current, pixelsPerBeatRef.current)
          const label = names.get(span.snapshotId) || 'Base'
          return (
            <div
              key={span.startTick + '-' + span.endTick + '-' + index}
              className={'vmt-cue-span vmt-cue-span-' + (index % 2)}
              style={{ left, width: Math.max(0, right - left) }}
            >
              <span>{label}</span>
            </div>
          )
        })}
      </div>
      {/* Transition windows (visualization for every enabled cue; the selected
          cue also gets draggable Start/End handles). Rendered under the markers
          so the fixed pin stays on top. */}
      {sorted.filter((cue) => cue.transition?.enabled).map((cue) => (
        <TransitionBand
          key={'tb-' + cue.tick}
          cue={cue}
          laneWidth={width}
          interactive={selectedTick === cue.tick}
          pixelsPerBeatRef={pixelsPerBeatRef}
          scrollOffsetRef={scrollOffsetRef}
          snapGranularityRef={snapGranularityRef}
          containerRef={containerRef}
          onSetCueTransition={onSetCueTransition}
        />
      ))}
      {sorted.map((cue) => {
        const x = mirrorTickToPixel(cue.tick, scrollOffsetRef.current, pixelsPerBeatRef.current)
        return (
          <CueMarker
            key={cue.tick}
            cue={cue}
            x={x}
            laneWidth={width}
            snapshots={snapshots}
            selected={selectedTick === cue.tick}
            onSelect={setSelectedTick}
            onMoveCue={async (oldTick, newTick) => {
              const moved = await onMoveCue(oldTick, newTick)
              if (moved) setSelectedTick(newTick)
              return moved
            }}
            onRemoveCue={onRemoveCue}
            onRepointCue={onRepointCue}
            onSetCueTransition={onSetCueTransition}
            pixelsPerBeatRef={pixelsPerBeatRef}
            scrollOffsetRef={scrollOffsetRef}
            containerRef={containerRef}
          />
        )
      })}
    </div>
  )
}

// Simplified, read-only clip/pattern rendering: reuse the audio timeline's
// draw primitives with waveforms forced off so each clip/pattern reads as a
// plain locked colour block that matches the editor's geometry + palette.
const MIRROR_DISPLAY_SETTINGS = { timelineShowWaveforms: 'never' }
const EMPTY_SELECTION = new Set()

/**
 * Read-only mirror of the audio timeline's canvas. Draws the shared grid,
 * clips and pattern-blocks as simplified locked blocks (no waveforms, no
 * interaction), plus a reserved cue-lane band and the shared playhead line.
 *
 * Pointer-down / drag anywhere on the strip seeks the shared transport — the
 * same seek the audio ruler performs — via the parent's onScrub callback. It
 * never mutates timeline data.
 *
 * Props:
 *   pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef  — shared scale + playhead
 *   tracks, clips, regions, patternBlocks, patterns, bpmRef  — timeline data
 *   snapGranularity  — for seek snapping (matches the audio ruler)
 *   onScrub(beat, { phase })  — seek/scrub the shared transport
 *   onWheel(e)  — shared zoom/scroll handler
 *
 * Imperative handle: redraw(), positionPlayhead(beat), getWidth()
 */
const VideoMirrorCanvas = forwardRef(function VideoMirrorCanvas(
  {
    pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef,
    tracks, clips, regions, patternBlocks, patterns, bpmRef,
    cues = [], snapshots = [], defaultSnapshotId = '', totalBeats = 0,
    snapGranularity = '1/16', onScrub, onWheel,
    onMoveCue, onRemoveCue, onRepointCue, onSetCueTransition,
  },
  ref,
) {
  const containerRef = useRef(null)
  const bgRef = useRef(null)          // grid + cue-lane band
  const ctRef = useRef(null)          // clips + pattern blocks
  const playheadLineRef = useRef(null)
  const sizeRef = useRef({ w: 0, h: 0 })

  // Stable refs so the draw path never reads stale closures.
  const tracksRef = useRef(tracks)
  const clipsRef = useRef(clips)
  const regionsRef = useRef(regions)
  const patternBlocksRef = useRef(patternBlocks)
  const patternsRef = useRef(patterns)
  const snapGranularityRef = useRef(snapGranularity)
  const trackIdToIndexRef = useRef({})
  tracksRef.current = tracks
  clipsRef.current = clips
  regionsRef.current = regions
  patternBlocksRef.current = patternBlocks
  patternsRef.current = patterns
  snapGranularityRef.current = snapGranularity

  useEffect(() => {
    const map = {}
    for (let i = 0; i < tracks.length; i++) map[tracks[i].id] = i
    trackIdToIndexRef.current = map
  }, [tracks])

  function applySize(canvas, w, h, dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  // ── Draw wrappers ─────────────────────────────────────────────────────────

  function redrawGrid() {
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const ctx = bgRef.current?.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const palette = resolveTimelinePalette()
    ctx.clearRect(0, 0, w, h)
    // Tracks retain their original indexing, shifted below the first snapshot lane.
    ctx.save()
    ctx.translate(0, CUE_LANE_HEIGHT)
    drawGrid(
      ctx, w, h - CUE_LANE_HEIGHT,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      tracksRef.current.length, tracksRef.current, palette, null,
      snapGranularityRef.current,
    )
    ctx.restore()
    // Snapshot cue lane background; editable DOM cues are layered above it.
    ctx.fillStyle = withAlpha(palette.laneSeparator, 0.12)
    ctx.fillRect(0, 0, w, CUE_LANE_HEIGHT)
    ctx.strokeStyle = palette.laneSeparator
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, CUE_LANE_HEIGHT - 0.5)
    ctx.lineTo(w, CUE_LANE_HEIGHT - 0.5)
    ctx.stroke()
  }

  function redrawContent() {
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const ctx = ctRef.current?.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const palette = resolveTimelinePalette()
    const tidx = trackIdToIndexRef.current
    const mutedTrackIds = new Set(
      (tracksRef.current || []).filter((t) => t.muted).map((t) => t.id),
    )
    const trackColorById = buildResolvedTrackColorMap(tracksRef.current, palette.trackPalette)

    ctx.save()
    ctx.translate(0, CUE_LANE_HEIGHT)
    drawClips(
      ctx, w, h - CUE_LANE_HEIGHT,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      clipsRef.current, tidx, regionsRef.current,
      EMPTY_SELECTION, {}, {}, {}, bpmRef?.current,
      mutedTrackIds, palette, MIRROR_DISPLAY_SETTINGS, trackColorById, null,
    )
    // After drawClips — it owns the clearRect for this canvas, so anything
    // drawn before it is wiped. Hold zones only ever occupy the gap between a
    // clip's end and the next clip's start, so they never cover clip pixels.
    drawHoldZones(
      ctx, w, h - CUE_LANE_HEIGHT,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      clipsRef.current, tidx, tracksRef.current,
      palette, null,
    )
    drawPatternBlocks(
      ctx, w, h - CUE_LANE_HEIGHT,
      scrollOffsetRef.current, pixelsPerBeatRef.current,
      patternBlocksRef.current, tidx, patternsRef.current, regionsRef.current,
      EMPTY_SELECTION, mutedTrackIds, palette, MIRROR_DISPLAY_SETTINGS, trackColorById, null,
    )
    ctx.restore()
  }

  function positionPlayhead(beat) {
    const el = playheadLineRef.current
    if (!el) return
    const px = mirrorTickToPixel(Math.round(beat * PPQ), scrollOffsetRef.current, pixelsPerBeatRef.current)
    const rawPx = px
    const w = sizeRef.current.w || 9999
    if (rawPx >= -PLAYHEAD_LINE_WIDTH && rawPx <= w + PLAYHEAD_LINE_WIDTH) {
      el.style.transform = `translateX(${px}px)`
      el.style.opacity = '1'
    } else {
      el.style.opacity = '0'
    }
  }

  function redraw() {
    redrawGrid()
    redrawContent()
    positionPlayhead(playheadBeatRef.current)
  }

  useImperativeHandle(ref, () => ({
    redraw,
    positionPlayhead,
    getWidth: () => sizeRef.current.w,
  }), [])

  // ── Sizing ────────────────────────────────────────────────────────────────

  function sizeAndDraw(container) {
    const rw = Math.floor(container.clientWidth)
    const rh = Math.floor(container.clientHeight)
    if (rw === 0 || rh === 0) return
    if (rw === sizeRef.current.w && rh === sizeRef.current.h) return
    sizeRef.current = { w: rw, h: rh }
    const dpr = window.devicePixelRatio || 1
    ;[bgRef, ctRef].forEach((r) => { if (r.current) applySize(r.current, rw, rh, dpr) })
    redraw()
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    sizeAndDraw(container)
    const timerId = setTimeout(() => sizeAndDraw(container), 50)
    const observer = new ResizeObserver(() => sizeAndDraw(container))
    observer.observe(container)
    return () => { clearTimeout(timerId); observer.disconnect() }
  }, [])

  // ── Shared playhead: reposition on every 60fps frame (no local clock) ──────

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs, bpm, positionBeats) => {
      const beat = Number.isFinite(positionBeats) ? positionBeats : posMs * bpm / 60000
      playheadBeatRef.current = beat
      positionPlayhead(beat)
    })
    return unsub
  }, [])

  // ── Wheel (non-passive so preventDefault works) ───────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el || !onWheel) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // ── Theme repaint ─────────────────────────────────────────────────────────

  useEffect(() => {
    const onTheme = () => redraw()
    window.addEventListener('xleth-theme-changed', onTheme)
    return () => window.removeEventListener('xleth-theme-changed', onTheme)
  }, [])

  // ── Pointer-down / drag → seek the shared transport (read-only scrub) ──────

  const seekFromClientX = useCallback((clientX, phase, e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || !onScrub) return
    const localX = clientX - rect.left
    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
    const snapped = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularityRef.current)
    onScrub(snapped, { phase })
  }, [onScrub, pixelsPerBeatRef, scrollOffsetRef])

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    seekFromClientX(e.clientX, 'move', e)
    const onMove = (me) => seekFromClientX(me.clientX, 'move', me)
    const onUp = (me) => {
      seekFromClientX(me.clientX, 'commit', me)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [seekFromClientX])

  const contentH = Math.max(tracks.length * TRACK_HEIGHT + CUE_LANE_HEIGHT, TRACK_HEIGHT + CUE_LANE_HEIGHT)

  return (
    <div
      ref={containerRef}
      className="vmt-canvas-container"
      style={{ minHeight: contentH, height: contentH }}
      onMouseDown={handleMouseDown}
    >
      <canvas ref={bgRef} className="timeline-canvas-layer" />
      <canvas ref={ctRef} className="timeline-canvas-layer" />
      <CueLane
        top={0}
        width={sizeRef.current.w}
        cues={cues}
        snapshots={snapshots}
        defaultSnapshotId={defaultSnapshotId}
        totalBeats={totalBeats}
        pixelsPerBeatRef={pixelsPerBeatRef}
        scrollOffsetRef={scrollOffsetRef}
        snapGranularityRef={snapGranularityRef}
        containerRef={containerRef}
        onMoveCue={onMoveCue}
        onRemoveCue={onRemoveCue}
        onRepointCue={onRepointCue}
        onSetCueTransition={onSetCueTransition}
      />
      <div
        ref={playheadLineRef}
        className="timeline-playhead-line"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${PLAYHEAD_LINE_WIDTH}px`,
          height: '100%',
          backgroundColor: 'var(--theme-timeline-playhead-line)',
          pointerEvents: 'none',
          zIndex: 10,
          willChange: 'transform',
          transform: 'translateX(-10px)',
        }}
      />
    </div>
  )
})

export default VideoMirrorCanvas

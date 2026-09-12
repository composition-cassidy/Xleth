/**
 * @vitest-environment jsdom
 *
 * Gesture-lifecycle contract for the rebuilt piano-roll pointer layer.
 *
 * Three load-bearing rules, each with its own regression guard:
 *  - Zero drag threshold + single commit: the first pointermove already moves
 *    the note (no dead zone), and exactly ONE onMoveNote/onMoveNotesBatch call
 *    happens, on pointerup — never mid-drag, never twice.
 *  - Synchronous redraw: a pointermove's overlay-canvas draw call must happen
 *    inside the SAME dispatchEvent call, not deferred through a setState+
 *    effect round trip (the actual defect this rebuild fixes).
 *  - Hover-predictive cursor: the cursor for a target must already be correct
 *    from a pointermove BEFORE any pointerdown, using the same resolver.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PianoRollCanvas from '../PianoRollCanvas.jsx'
import { beatsToTicks } from '../../../constants/timeline.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const WIDTH = 800
const HEIGHT = 500
const PPB = 80
const PPS = 14

const ctxByCanvas = new WeakMap()
const CTX_METHODS = [
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo',
  'stroke', 'setLineDash', 'save', 'restore', 'setTransform', 'fillText',
]

function stubCtxFor(canvasEl) {
  if (!ctxByCanvas.has(canvasEl)) {
    const ctx = { canvas: canvasEl, measureText: () => ({ width: 0 }) }
    for (const m of CTX_METHODS) ctx[m] = vi.fn()
    ctxByCanvas.set(canvasEl, ctx)
  }
  return ctxByCanvas.get(canvasEl)
}

let container = null
let root = null

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = function () { return stubCtxFor(this) }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  container = null
  root = null
})

// Default pitch keeps the note's row inside the 500px test viewport (y=434
// at PPS=14) — a pitch near the keyboard's low end renders far below the
// visible canvas and gets viewport-culled by design, which would make the
// synchronous-redraw assertion below fail for a reason unrelated to what
// it's testing.
function noteAt({ id, positionBeats, durationBeats, pitch = 100, velocity = 1 }) {
  return {
    id,
    positionTicks: beatsToTicks(positionBeats),
    durationTicks: beatsToTicks(durationBeats),
    pitch,
    velocity,
  }
}

// PITCH_MAX is 131 (PianoRollKeyboard.jsx) — matches the component's own math.
function noteScreenRect(note, scrollX = 0, scrollY = 0) {
  const beat = note.positionTicks / 960
  const durBeats = note.durationTicks / 960
  const x = beat * PPB - scrollX
  const w = Math.max(2, durBeats * PPB)
  const y = (131 - note.pitch) * PPS - scrollY
  return { x, y, w, h: PPS }
}

function pointer(type, x, y, opts = {}) {
  return new globalThis.PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, pointerId: 1,
    clientX: x, clientY: y, ...opts,
  })
}

function renderCanvas(props = {}) {
  const w = props.width ?? WIDTH
  const h = props.height ?? HEIGHT
  const refs = {
    pixelsPerBeatRef: { current: PPB },
    pixelsPerSemitoneRef: { current: PPS },
    scrollXRef: { current: 0 },
    scrollYRef: { current: 0 },
  }
  const handlers = {
    onAddNote: vi.fn(),
    onRemoveNote: vi.fn(),
    onMoveNote: vi.fn(),
    onMoveNotesBatch: vi.fn(),
    onResizeNote: vi.fn(),
    onResizeNotesBatch: vi.fn(),
    onPreviewNote: vi.fn(),
    onDropFsc: vi.fn(),
    setStickyNoteLength: vi.fn(),
    setStickyVelocity: vi.fn(),
    setSelectedNoteIds: vi.fn(),
  }
  act(() => root.render(
    <PianoRollCanvas
      patternId={1}
      notes={props.notes || []}
      patternLengthTicks={0}
      activeTool={props.activeTool || 'select'}
      stickyNoteLength={240}
      stickyVelocity={1}
      selectedNoteIds={props.selectedNoteIds || new Set()}
      {...refs}
      width={WIDTH}
      height={HEIGHT}
      {...handlers}
      {...props}
    />,
  ))
  const el = container.querySelector('.piano-roll-canvas-container')
  el.getBoundingClientRect = () => (
    { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0 }
  )
  const canvases = container.querySelectorAll('canvas')
  return { el, contentCanvas: canvases[1], overlayCanvas: canvases[2], ...handlers }
}

describe('PianoRollCanvas pointer gesture lifecycle', () => {
  it('moves from the first pointermove (zero drag threshold) and commits exactly once, on pointerup', () => {
    const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(note)
    const { el, onMoveNote, onMoveNotesBatch } = renderCanvas({ notes: [note] })

    act(() => { el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
    expect(onMoveNote).not.toHaveBeenCalled()

    // One pixel of movement, still well under a full grid cell — snap means
    // the tick position won't visibly change yet, but nothing should commit
    // to the bridge regardless of how small the move is.
    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + 1, rect.y + rect.h / 2)) })
    expect(onMoveNote).not.toHaveBeenCalled()
    expect(onMoveNotesBatch).not.toHaveBeenCalled()

    // A real move: one full beat to the right (80px at PPB=80).
    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })
    expect(onMoveNote).not.toHaveBeenCalled()

    act(() => { el.dispatchEvent(pointer('pointerup', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })
    expect(onMoveNote).toHaveBeenCalledTimes(1)
    const [, newPosTicks, newPitch] = onMoveNote.mock.calls[0]
    expect(newPosTicks).toBe(note.positionTicks + beatsToTicks(1))
    expect(newPitch).toBe(note.pitch)
  })

  it('redraws the overlay canvas synchronously inside the pointermove dispatch, not on a later tick', () => {
    const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(note)
    const { el, overlayCanvas } = renderCanvas({ notes: [note] })
    const ctx = overlayCanvas.getContext('2d')

    act(() => { el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
    const callsAfterDown = ctx.strokeRect.mock.calls.length + ctx.fillRect.mock.calls.length
    expect(callsAfterDown).toBeGreaterThan(0) // ghost drawn on the same mousedown, not deferred

    const callsBeforeMove = ctx.clearRect.mock.calls.length
    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })
    // clearRect+redraw happened strictly inside the dispatch above — no
    // intervening setState/effect tick was needed for the overlay to update.
    expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(callsBeforeMove)
  })

  it('predicts the cursor on hover, before any pointerdown, using the same resolver mousedown uses', () => {
    const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(note)
    const { el } = renderCanvas({ notes: [note], activeTool: 'select' })

    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
    expect(el.style.cursor).toBe('grab')

    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w - 2, rect.y + rect.h / 2)) })
    expect(el.style.cursor).toBe('ew-resize')

    act(() => { el.dispatchEvent(pointer('pointermove', 5, 5)) })
    expect(el.style.cursor).toBe('default')
  })

  // Regression: the pointer handlers are stable useCallbacks, so reading the
  // width/height PROPS inside them froze the FIRST render's values — which in
  // the real app is PianoRoll's 800x500 placeholder, replaced a tick later by
  // the ResizeObserver's real panel size. The overlay then cleared only the
  // stale rect (drag ghosts smeared across everything outside it) and
  // viewport-culled any preview past it (the drag appeared to freeze).
  it('clears and draws the overlay at the CURRENT canvas size after a resize, not the size it first mounted at', () => {
    const note = noteAt({ id: 1, positionBeats: 1, durationBeats: 1 })
    const rect = noteScreenRect(note)

    // Mount small, then grow — exactly the placeholder→ResizeObserver sequence.
    renderCanvas({ notes: [note], width: 300, height: 200 })
    const { el, overlayCanvas } = renderCanvas({ notes: [note], width: 900, height: 600 })
    const ctx = overlayCanvas.getContext('2d')

    act(() => { el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
    ctx.clearRect.mockClear()
    ctx.fillRect.mockClear()

    // Drag to a spot that is inside the new canvas but outside the old one.
    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + 400, rect.y + rect.h / 2)) })

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 900, 600)
    // The note's row (y=434 at pitch 100) sits past the stale 200px height, so
    // with the bug the preview was culled and nothing was painted at all.
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(0)
  })

  it('lifts the dragged note off the content layer so it moves instead of leaving a copy behind', () => {
    const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(note)
    const { el, contentCanvas, overlayCanvas } = renderCanvas({ notes: [note] })
    const content = contentCanvas.getContext('2d')
    const overlay = overlayCanvas.getContext('2d')

    // Before the gesture the single note lives on the content layer.
    expect(content.fillRect.mock.calls.length).toBeGreaterThan(0)
    content.fillRect.mockClear()

    act(() => { el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })

    // It is now drawn once, by the overlay, at the live preview position.
    expect(content.fillRect.mock.calls.length).toBe(0)
    expect(overlay.fillRect.mock.calls.length).toBeGreaterThan(0)
  })

  // Regression: on pointerup, moveNote/resizeNote round-trip through the
  // bridge asynchronously (notifyChanged -> refetch), so `notes` still holds
  // PRE-drag values for a beat after the handler returns. Redrawing the
  // content layer from that stale prop right on mouseup used to flash the
  // note back at its old position/size before it jumped to the new one a
  // moment later — the flicker. The fix: keep the note "settled" on the
  // overlay, unchanged, until `notes` actually reflects the commit.
  it('does not flicker on release: the overlay keeps showing the same preview until `notes` catches up, with nothing redrawn from stale data in between', () => {
    const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(note)
    const { el, contentCanvas, overlayCanvas } = renderCanvas({ notes: [note] })
    const content = contentCanvas.getContext('2d')
    const overlay = overlayCanvas.getContext('2d')

    act(() => { el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
    act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })
    overlay.fillRect.mockClear()
    content.fillRect.mockClear()

    act(() => { el.dispatchEvent(pointer('pointerup', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })

    // Nothing new painted anywhere at the instant of release — the screen
    // must look IDENTICAL to the frame right before mouseup. In particular
    // the content layer must NOT have redrawn the note at its old position.
    expect(content.fillRect.mock.calls.length).toBe(0)
    expect(overlay.fillRect.mock.calls.length).toBe(0)

    // The async commit lands and the parent re-renders with the moved note —
    // only THEN does the note reappear on the content layer, at its new spot.
    const movedNote = { ...note, positionTicks: note.positionTicks + beatsToTicks(1) }
    renderCanvas({ notes: [movedNote] })
    expect(content.fillRect.mock.calls.length).toBeGreaterThan(0)
  })

  it('falls back to redrawing from stale data if the commit never round-trips, rather than hiding the note forever', () => {
    vi.useFakeTimers()
    try {
      const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
      const rect = noteScreenRect(note)
      // onMoveNote deliberately does nothing — simulates a bridge call that
      // never resolves/refetches, so `notes` never updates.
      const { el, contentCanvas } = renderCanvas({ notes: [note], onMoveNote: vi.fn() })
      const content = contentCanvas.getContext('2d')

      act(() => { el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2)) })
      act(() => { el.dispatchEvent(pointer('pointermove', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })
      act(() => { el.dispatchEvent(pointer('pointerup', rect.x + rect.w / 2 + PPB, rect.y + rect.h / 2)) })
      content.fillRect.mockClear()

      act(() => { vi.advanceTimersByTime(1000) })
      expect(content.fillRect.mock.calls.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes the note under the cursor on right-click, immediately', () => {
    const note = noteAt({ id: 1, positionBeats: 2, durationBeats: 2 })
    const rect = noteScreenRect(note)
    const { el, onRemoveNote } = renderCanvas({ notes: [note], activeTool: 'select' })

    act(() => {
      el.dispatchEvent(pointer('pointerdown', rect.x + rect.w / 2, rect.y + rect.h / 2, { button: 2 }))
    })
    expect(onRemoveNote).toHaveBeenCalledWith(1)
  })
})

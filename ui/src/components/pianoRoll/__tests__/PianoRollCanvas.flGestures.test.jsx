/**
 * @vitest-environment jsdom
 *
 * FL Studio mouse grammar on the piano roll canvas: Shift edge drag resizes
 * without overlapping, Shift drag clones, Ctrl selects, the axis locks, the
 * slice line, paint, Alt+right-drag scrub, right-click deselect and the ghost
 * swap. Each compound edit reaches the owner as ONE onCommitNotes call.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PianoRollCanvas, { setSideKeysForTest } from '../PianoRollCanvas.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const W = 800
const H = 500
const PPB = 80 // px per beat → 1 beat = 960 ticks = 80 px; 1/16 = 20 px
const PPS = 14
const PITCH_MAX = 131

let container = null
let root = null

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__ctx) {
      const ctx = { canvas: this, measureText: () => ({ width: 0 }) }
      for (const m of ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke',
        'setLineDash', 'save', 'restore', 'setTransform', 'fillText', 'rect', 'clip', 'arc', 'fill',
        'closePath', 'quadraticCurveTo']) ctx[m] = vi.fn()
      this.__ctx = ctx
    }
    return this.__ctx
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setSideKeysForTest({ shiftRight: false, altRight: false })
})

const note = (id, posTicks, durTicks, pitch = 100) => ({ id, positionTicks: posTicks, durationTicks: durTicks, pitch, velocity: 0.8 })
const xOf = (ticks) => (ticks / 960) * PPB
const yOf = (pitch) => (PITCH_MAX - pitch) * PPS + PPS / 2

function pointer(type, x, y, opts = {}) {
  return new globalThis.PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...opts,
  })
}

function render(props = {}) {
  const handlers = {
    onAddNote: vi.fn(), onRemoveNote: vi.fn(), onMoveNote: vi.fn(), onMoveNotesBatch: vi.fn(),
    onResizeNote: vi.fn(), onResizeNotesBatch: vi.fn(), onPreviewNote: vi.fn(), onDropFsc: vi.fn(),
    setStickyNoteLength: vi.fn(), setStickyVelocity: vi.fn(), setSelectedNoteIds: vi.fn(),
    onCommitNotes: vi.fn(), onScrub: vi.fn(), onSwitchToGhost: vi.fn(), onClearTimeSel: vi.fn(),
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
      pixelsPerBeatRef={{ current: PPB }}
      pixelsPerSemitoneRef={{ current: PPS }}
      scrollXRef={{ current: 0 }}
      scrollYRef={{ current: 0 }}
      width={W}
      height={H}
      {...handlers}
      {...props}
    />,
  ))
  const el = container.querySelector('.piano-roll-canvas-container')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 })
  const fire = (type, x, y, opts) => act(() => { el.dispatchEvent(pointer(type, x, y, opts)) })
  return { el, fire, ...handlers }
}

describe('Shift + drag a right edge: resize without overlap', () => {
  it('moves the boundary into the touching note and commits once', () => {
    const notes = [note(1, 0, 960, 100), note(2, 960, 960, 101)]
    const h = render({ notes })
    const edgeX = xOf(960) - 2
    h.fire('pointerdown', edgeX, yOf(100), { shiftKey: true })
    h.fire('pointermove', xOf(1440) - 1, yOf(100), { shiftKey: true })
    h.fire('pointerup', xOf(1440) - 1, yOf(100), { shiftKey: true })
    expect(h.onCommitNotes).toHaveBeenCalledTimes(1)
    const out = h.onCommitNotes.mock.calls[0][0]
    const m = Object.fromEntries(out.map((n) => [n.id, n]))
    expect(m[1].durationTicks).toBe(1440)
    expect(m[2].positionTicks).toBe(1440)
    expect(m[2].positionTicks + m[2].durationTicks).toBe(1920)
    expect(h.onResizeNote).not.toHaveBeenCalled()
  })

  it('a plain edge drag still resizes on its own (and may overlap)', () => {
    const h = render({ notes: [note(1, 0, 960, 100), note(2, 960, 960, 101)] })
    h.fire('pointerdown', xOf(960) - 2, yOf(100))
    h.fire('pointermove', xOf(1440) - 1, yOf(100))
    h.fire('pointerup', xOf(1440) - 1, yOf(100))
    expect(h.onResizeNote).toHaveBeenCalledWith(1, 1440)
    expect(h.onCommitNotes).not.toHaveBeenCalled()
  })
})

describe('Shift + drag a note: copies', () => {
  it('leaves the original and commits a selected copy where it was dropped', () => {
    const h = render({ notes: [note(1, 0, 480, 100)] })
    h.fire('pointerdown', 10, yOf(100), { shiftKey: true })
    h.fire('pointermove', 10 + xOf(960), yOf(100), { shiftKey: true })
    h.fire('pointerup', 10 + xOf(960), yOf(100), { shiftKey: true })
    expect(h.onMoveNote).not.toHaveBeenCalled()
    const out = h.onCommitNotes.mock.calls[0][0]
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(note(1, 0, 480, 100))
    expect(out[1]).toMatchObject({ positionTicks: 960, pitch: 100, _select: true })
    expect(out[1].id).toBeUndefined()
  })

  it('a Shift-click with no movement copies nothing', () => {
    const h = render({ notes: [note(1, 0, 480, 100)] })
    h.fire('pointerdown', 10, yOf(100), { shiftKey: true })
    h.fire('pointerup', 10, yOf(100), { shiftKey: true })
    expect(h.onCommitNotes).not.toHaveBeenCalled()
  })
})

describe('axis locks pressed after the click', () => {
  it('Shift after the click keeps the pitch', () => {
    const h = render({ notes: [note(1, 0, 480, 100)] })
    h.fire('pointerdown', 10, yOf(100))
    h.fire('pointermove', 10 + xOf(960), yOf(95), { shiftKey: true })
    h.fire('pointerup', 10 + xOf(960), yOf(95), { shiftKey: true })
    expect(h.onMoveNote).toHaveBeenCalledWith(1, 960, 100)
  })

  it('Ctrl after the click keeps the timing', () => {
    const h = render({ notes: [note(1, 0, 480, 100)] })
    h.fire('pointerdown', 10, yOf(100))
    h.fire('pointermove', 10 + xOf(960), yOf(95), { ctrlKey: true })
    h.fire('pointerup', 10 + xOf(960), yOf(95), { ctrlKey: true })
    expect(h.onMoveNote).toHaveBeenCalledWith(1, 0, 95)
  })
})

describe('Ctrl selects in every tool', () => {
  it('Ctrl+click a note selects just it, even with the pencil', () => {
    const h = render({ activeTool: 'pencil', notes: [note(1, 0, 480, 100), note(2, 960, 480, 100)], selectedNoteIds: new Set([2]) })
    h.fire('pointerdown', 10, yOf(100), { ctrlKey: true })
    h.fire('pointerup', 10, yOf(100), { ctrlKey: true })
    expect(h.setSelectedNoteIds).toHaveBeenLastCalledWith(new Set([1]))
    expect(h.onAddNote).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+click toggles a note in and out of the selection', () => {
    const h = render({ notes: [note(1, 0, 480, 100), note(2, 960, 480, 100)], selectedNoteIds: new Set([1, 2]) })
    h.fire('pointerdown', 10, yOf(100), { ctrlKey: true, shiftKey: true })
    h.fire('pointerup', 10, yOf(100), { ctrlKey: true, shiftKey: true })
    expect(h.setSelectedNoteIds).toHaveBeenLastCalledWith(new Set([2]))
  })

  it('Ctrl+click on empty grid deselects all and clears the time selection', () => {
    const h = render({ notes: [note(1, 0, 480, 100)], selectedNoteIds: new Set([1]) })
    h.fire('pointerdown', 400, yOf(90), { ctrlKey: true })
    h.fire('pointerup', 400, yOf(90), { ctrlKey: true })
    expect(h.setSelectedNoteIds).toHaveBeenLastCalledWith(new Set())
    expect(h.onClearTimeSel).toHaveBeenCalled()
  })
})

describe('right button', () => {
  it('a right-click on empty grid deselects all', () => {
    const h = render({ notes: [note(1, 0, 480, 100)], selectedNoteIds: new Set([1]) })
    h.fire('pointerdown', 400, yOf(90), { button: 2 })
    h.fire('pointerup', 400, yOf(90), { button: 2 })
    expect(h.setSelectedNoteIds).toHaveBeenLastCalledWith(new Set())
    expect(h.onRemoveNote).not.toHaveBeenCalled()
  })

  it('a right-drag on empty grid slices the notes the line crosses', () => {
    const h = render({ notes: [note(1, 0, 960, 100), note(2, 0, 960, 98)] })
    h.fire('pointerdown', xOf(480), yOf(102), { button: 2 })
    h.fire('pointermove', xOf(480), yOf(96), { button: 2 })
    h.fire('pointerup', xOf(480), yOf(96), { button: 2 })
    const out = h.onCommitNotes.mock.calls[0][0]
    expect(out).toHaveLength(4)
  })

  it('Alt + right-drag scrubs: the pointer tick goes out, then null on release', () => {
    const h = render({ notes: [note(1, 0, 960, 100)] })
    h.fire('pointerdown', xOf(240), yOf(90), { button: 2, altKey: true })
    h.fire('pointermove', xOf(480), yOf(90), { button: 2, altKey: true })
    h.fire('pointerup', xOf(480), yOf(90), { button: 2, altKey: true })
    const ticks = h.onScrub.mock.calls.map((c) => c[0])
    expect(ticks[0]).toBe(240)
    expect(ticks[1]).toBe(480)
    expect(ticks.at(-1)).toBeNull()
  })

  it('Right-Shift + right-click slices the note and drops the smaller part', () => {
    setSideKeysForTest({ shiftRight: true })
    const h = render({ notes: [note(1, 0, 960, 100)] })
    h.fire('pointerdown', xOf(240), yOf(100), { button: 2, shiftKey: true })
    expect(h.onRemoveNote).not.toHaveBeenCalled()
    expect(h.onCommitNotes.mock.calls[0][0]).toEqual([{ ...note(1, 240, 720, 100) }])
  })

  it('Right-Alt + right-click quantizes the selection', () => {
    setSideKeysForTest({ altRight: true })
    const h = render({ notes: [note(1, 250, 240, 100)], selectedNoteIds: new Set([1]) })
    h.fire('pointerdown', 400, yOf(90), { button: 2, altKey: true, ctrlKey: true })
    expect(h.onCommitNotes.mock.calls[0][0][0].positionTicks).toBe(240)
    expect(h.onScrub).not.toHaveBeenCalled()
  })
})

describe('slice tool', () => {
  it('drags a vertical cut through several rows at one snapped tick', () => {
    const h = render({ activeTool: 'split', notes: [note(1, 0, 960, 100), note(2, 0, 960, 99)] })
    h.fire('pointerdown', xOf(480) + 3, yOf(101))
    h.fire('pointermove', xOf(480) + 3, yOf(98))
    h.fire('pointerup', xOf(480) + 3, yOf(98))
    const out = h.onCommitNotes.mock.calls[0][0]
    expect(out.filter((n) => n.pitch === 100).map((n) => n.positionTicks)).toEqual([0, 480])
    expect(out.filter((n) => n.pitch === 99).map((n) => n.positionTicks)).toEqual([0, 480])
  })

  it('Right-Shift + left-click slices with any tool', () => {
    setSideKeysForTest({ shiftRight: true })
    const h = render({ activeTool: 'pencil', notes: [note(1, 0, 960, 100)] })
    h.fire('pointerdown', xOf(480), yOf(100), { shiftKey: true })
    h.fire('pointerup', xOf(480), yOf(100), { shiftKey: true })
    expect(h.onCommitNotes.mock.calls[0][0]).toHaveLength(2)
    expect(h.onAddNote).not.toHaveBeenCalled()
  })
})

describe('paint tool', () => {
  it('lays a note per step along the stroke and commits them together', () => {
    const h = render({ activeTool: 'paint', notes: [] })
    h.fire('pointerdown', 2, yOf(100))
    h.fire('pointermove', xOf(720) + 2, yOf(100))
    h.fire('pointerup', xOf(720) + 2, yOf(100))
    const out = h.onCommitNotes.mock.calls[0][0]
    expect(out.map((n) => n.positionTicks)).toEqual([0, 240, 480, 720])
    expect(out.every((n) => n.pitch === 100 && n._select)).toBe(true)
  })
})

describe('pencil + Shift: stretch-draw', () => {
  it('the drag sets the new note length', () => {
    const h = render({ activeTool: 'pencil', notes: [] })
    h.fire('pointerdown', 2, yOf(100), { shiftKey: true })
    h.fire('pointermove', xOf(960), yOf(100), { shiftKey: true })
    h.fire('pointerup', xOf(960), yOf(100), { shiftKey: true })
    expect(h.onAddNote).toHaveBeenCalledTimes(1)
    expect(h.onAddNote.mock.calls[0][0]).toMatchObject({ positionTicks: 0, durationTicks: 960, pitch: 100 })
  })
})

describe('ghost swap', () => {
  const ghosts = [{ positionTicks: 0, durationTicks: 960, pitch: 100, kind: 'other', patternId: 42 }]
  it('double right-click on a ghost note switches pattern', () => {
    const h = render({ notes: [], ghosts })
    h.fire('pointerdown', 20, yOf(100), { button: 2 })
    h.fire('pointerup', 20, yOf(100), { button: 2 })
    h.fire('pointerdown', 20, yOf(100), { button: 2 })
    expect(h.onSwitchToGhost).toHaveBeenCalledWith(42)
  })
  it('mouse X1 on a ghost note switches pattern', () => {
    const h = render({ notes: [], ghosts })
    h.fire('pointerdown', 20, yOf(100), { button: 3 })
    expect(h.onSwitchToGhost).toHaveBeenCalledWith(42)
  })
})

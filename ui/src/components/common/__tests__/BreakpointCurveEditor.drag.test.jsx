/**
 * @vitest-environment jsdom
 *
 * Drag-gesture contract for the shared breakpoint curve editor.
 *
 * The load-bearing rule is EDIT DISCIPLINE: a point drag is local — every
 * pointermove goes to onPreview and none of them touch the engine — and exactly
 * ONE onCommit fires on release, carrying the shape the drag actually produced.
 *
 * That last clause is a regression guard. The commit used to send the `points`
 * PROP back, which only updates after the preview has round-tripped through a
 * store and a React render. When several pointermoves land in one task (a fast
 * drag, or React batching them), pointerup ran before the prop caught up and the
 * editor silently committed the PRE-DRAG shape — the gesture appeared to work on
 * screen and then snapped back. The drag now carries its own accumulated shape.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BreakpointCurveEditor from '../BreakpointCurveEditor.jsx'
import {
  TIME_VALUE_ADAPTER,
  evaluateLinearBreakpoints,
} from '../breakpointCurveMath.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const W = 400
const H = 200
const PAD = { left: 0, right: 0, top: 0, bottom: 0 }

// Geometry with zero padding: x = t * 400, y = (1 - (v+1)/2) * 200.
const xOf = (t) => t * W
const yOf = (v) => (1 - (v + 1) / 2) * H

const gradient = { addColorStop: () => {} }
function stubCtx() {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return { width: 0, height: 0 }
      if (prop === 'measureText') return () => ({ width: 0 })
      return () => gradient
    },
    set: () => true,
  })
}

let container = null
let root = null

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = stubCtx
  globalThis.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
  })
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

const SHAPE = [
  { time: 0, value: 0 },
  { time: 0.5, value: 1 },
  { time: 1, value: 0 },
]

function renderEditor(props = {}) {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onSelect = vi.fn()
  act(() => root.render(
    <BreakpointCurveEditor
      points={SHAPE}
      adapter={TIME_VALUE_ADAPTER}
      sample={evaluateLinearBreakpoints}
      width={W}
      height={H}
      pad={PAD}
      onPreview={onPreview}
      onCommit={onCommit}
      onSelect={onSelect}
      {...props}
    />,
  ))
  return { canvas: container.querySelector('canvas'), onPreview, onCommit, onSelect }
}

const pointer = (type, t, v, button = 0) => new globalThis.PointerEvent(type, {
  bubbles: true, cancelable: true, button, pointerId: 1,
  clientX: xOf(t), clientY: yOf(v),
})

describe('BreakpointCurveEditor drag gesture', () => {
  it('previews every move, writes nothing to the engine, and commits once on release', () => {
    const { canvas, onPreview, onCommit, onSelect } = renderEditor()

    act(() => { canvas.dispatchEvent(pointer('pointerdown', 0.5, 1)) })
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      for (let i = 1; i <= 10; i++) {
        globalThis.dispatchEvent(pointer('pointermove', 0.5 + 0.02 * i, 1 - 0.15 * i))
      }
    })

    // Local preview only — the whole point of the discipline.
    expect(onPreview).toHaveBeenCalledTimes(10)
    expect(onCommit).not.toHaveBeenCalled()

    act(() => { globalThis.dispatchEvent(pointer('pointerup', 0.7, -0.5)) })

    // One gesture => one commit => one undo step.
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits the shape the DRAG produced, not the stale points prop (regression)', () => {
    // The parent deliberately never re-renders with the previewed points, which
    // is exactly the batched/fast-drag case that used to lose the edit.
    const { canvas, onCommit } = renderEditor()

    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 0.5, 1))
      globalThis.dispatchEvent(pointer('pointermove', 0.6, 0.5))
      globalThis.dispatchEvent(pointer('pointermove', 0.7, -0.5))
      globalThis.dispatchEvent(pointer('pointerup', 0.7, -0.5))
    })

    expect(onCommit).toHaveBeenCalledTimes(1)
    const committed = onCommit.mock.calls[0][0]
    expect(committed[1].time).toBeCloseTo(0.7, 3)
    expect(committed[1].value).toBeCloseTo(-0.5, 3)
    // Untouched neighbours survive, and the list stays ordered.
    expect(committed[0]).toEqual({ time: 0, value: 0 })
    expect(committed[2]).toEqual({ time: 1, value: 0 })
    expect(committed.map(p => p.time)).toEqual([...committed.map(p => p.time)].sort((a, b) => a - b))
  })

  it('does not commit when the pointer goes down and up without moving', () => {
    const { canvas, onCommit } = renderEditor()
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 0.5, 1))
      globalThis.dispatchEvent(pointer('pointerup', 0.5, 1))
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('ignores every gesture while a built-in shape is ghosted (editable=false)', () => {
    const { canvas, onPreview, onCommit, onSelect } = renderEditor({ editable: false })

    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 0.5, 1))
      globalThis.dispatchEvent(pointer('pointermove', 0.7, -0.5))
      globalThis.dispatchEvent(pointer('pointerup', 0.7, -0.5))
      canvas.dispatchEvent(new globalThis.MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX: xOf(0.25), clientY: yOf(0.5),
      }))
    })

    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(canvas.dataset.editable).toBe('false')
  })

  it('double-click on empty canvas adds a point; right-click on one deletes it', () => {
    const { canvas, onCommit } = renderEditor()

    act(() => {
      canvas.dispatchEvent(new globalThis.MouseEvent('dblclick', {
        bubbles: true, cancelable: true, clientX: xOf(0.25), clientY: yOf(0.5),
      }))
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    const added = onCommit.mock.calls[0][0]
    expect(added).toHaveLength(4)
    expect(added[1]).toEqual({ time: 0.25, value: 0.5 })

    onCommit.mockClear()
    act(() => { canvas.dispatchEvent(pointer('pointerdown', 0.5, 1, 2)) })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toEqual([
      { time: 0, value: 0 },
      { time: 1, value: 0 },
    ])
  })

  it('refuses to delete below the two-point floor', () => {
    const { canvas, onCommit } = renderEditor({
      points: [{ time: 0, value: 0 }, { time: 1, value: 0 }],
    })
    act(() => { canvas.dispatchEvent(pointer('pointerdown', 0, 0, 2)) })
    expect(onCommit).not.toHaveBeenCalled()
  })
})

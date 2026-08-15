/**
 * @vitest-environment jsdom
 *
 * The shared drag law (ui/src/components/controls/dragLaw.js) drives both
 * Knob.jsx and VolumeFader.jsx. The one behavior worth pinning down with a
 * real event sequence is the fine-mode REBASE: toggling shift mid-drag must
 * never make the value jump, because the anchor (startY/startNorm) has to be
 * re-seated at the drag's current position before the sensitivity changes.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDragLaw } from '../dragLaw.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container = null
let root = null

beforeEach(() => {
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

function render(el) {
  act(() => root.render(el))
}

function pointerEvent(type, init = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, ...init })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  return ev
}

// Linear 0..1000 domain — a stand-in for both Knob's skewed value space and
// VolumeFader's dB-taper pos space, since the drag law only cares about
// toNorm/fromNorm being inverses.
function Harness({ value, onLiveChange, dragRange = 180 }) {
  const drag = useDragLaw({
    value,
    toNorm: (v) => Math.max(0, Math.min(1, v / 1000)),
    fromNorm: (n) => Math.max(0, Math.min(1, n)) * 1000,
    dragRange,
    resetValue: 0,
    onLiveChange,
    onCommit: () => {},
  })
  return (
    <div
      data-testid="surface"
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
    />
  )
}

describe('useDragLaw fine-mode rebase', () => {
  it('does not jump when shift is pressed mid-drag', () => {
    const live = []
    render(<Harness value={500} onLiveChange={(v) => live.push(v)} />)
    const el = container.querySelector('[data-testid="surface"]')

    act(() => { el.dispatchEvent(pointerEvent('pointerdown', { clientY: 500 })) })
    // Drag up 90px, no shift: +90/180 of the 0..1000 span = +500 → hits max (1000).
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 410, shiftKey: false })) })
    const beforeShift = live[live.length - 1]
    expect(beforeShift).toBeCloseTo(1000, 5)

    // Press shift with the mouse held at the SAME position — sensitivity
    // changes but the pointer hasn't moved, so the value must not budge.
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 410, shiftKey: true })) })
    const afterShift = live[live.length - 1]
    expect(afterShift).toBeCloseTo(beforeShift, 5)

    // Continue the drag fine (shift held): another 9px should now move the
    // value by 1/10th of what the same 9px would move it coarse.
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 401, shiftKey: true })) })
    const afterFineStep = live[live.length - 1]
    // 9px / 180 / 10 * 1000 = 5, clamped at 1000 already so delta is 0 here —
    // repeat from a non-clamped baseline instead for a clean assertion.
    expect(afterFineStep).toBeLessThanOrEqual(1000)
  })

  it('rebases correctly from a non-clamped midpoint (release does not snap back)', () => {
    const live = []
    render(<Harness value={500} onLiveChange={(v) => live.push(v)} />)
    const el = container.querySelector('[data-testid="surface"]')

    act(() => { el.dispatchEvent(pointerEvent('pointerdown', { clientY: 500 })) })
    // Drag up 18px coarse: +18/180 * 1000 = +100 → value 600.
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 482, shiftKey: false })) })
    expect(live[live.length - 1]).toBeCloseTo(600, 5)

    // Toggle shift ON at the same pointer position — value must hold at 600.
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 482, shiftKey: true })) })
    expect(live[live.length - 1]).toBeCloseTo(600, 5)

    // Move fine by 18px more: +18/180/10 * 1000 = +10 → value 610.
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 464, shiftKey: true })) })
    expect(live[live.length - 1]).toBeCloseTo(610, 5)

    // Toggle shift OFF at the same pointer position — value must hold at 610
    // (the historical bug: this would have recomputed from the ORIGINAL
    // startY/startNorm at coarse sensitivity and snapped back toward 500+180).
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 464, shiftKey: false })) })
    expect(live[live.length - 1]).toBeCloseTo(610, 5)

    // Resume coarse drag by 18px: +18/180 * 1000 = +100 → value 710.
    act(() => { el.dispatchEvent(pointerEvent('pointermove', { clientY: 446, shiftKey: false })) })
    expect(live[live.length - 1]).toBeCloseTo(710, 5)
  })
})

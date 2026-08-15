/**
 * @vitest-environment jsdom
 *
 * Smoke test for the rebase fix through the REAL consumers, not just the
 * shared hook in isolation: drive Knob.jsx and VolumeFader.jsx with actual
 * pointer event sequences that toggle shift mid-drag, and confirm the
 * emitted value never jumps. Before the fix, both call sites computed
 * sensitivity from `e.shiftKey || d.fine` while measuring dy from the
 * ORIGINAL pointerdown position — so toggling shift divided/multiplied the
 * whole accumulated delta and snapped the value back toward the drag start.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Knob from '../../sampler/Knob.jsx'
import VolumeFader from '../../mixer/VolumeFader.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no canvas backend; Knob paints on mount — stub it out, the
// drawing is irrelevant to the drag math under test.
const gradient = { addColorStop: () => {} }
const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    return () => gradient
  },
})

let container = null
let root = null

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(noopCtx)
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
})

async function mount(el) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(el) })
  return container
}

function stubCapture(el) {
  el.setPointerCapture = () => {}
  el.releasePointerCapture = () => {}
}

function pointer(type, init) {
  const e = new Event(type, { bubbles: true })
  Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1, shiftKey: false, ctrlKey: false, metaKey: false, button: 0, ...init })
  return e
}

describe('Knob — mid-drag shift toggle does not jump the value', () => {
  it('holds steady when shift is pressed and released at the same pointer position', async () => {
    const seen = []
    const c = await mount(
      <Knob value={50} min={0} max={100} defaultValue={50} dragRange={180}
        onLiveChange={(v) => seen.push(v)} onCommit={() => {}} />
    )
    const canvas = c.querySelector('canvas')
    stubCapture(canvas)

    act(() => { canvas.dispatchEvent(pointer('pointerdown', { clientY: 100 })) })
    // +18px coarse = +10 of the 0..100 span -> 60.
    act(() => { canvas.dispatchEvent(pointer('pointermove', { clientY: 82 })) })
    expect(seen.at(-1)).toBeCloseTo(60, 5)

    // Shift ON, same clientY — must not move.
    act(() => { canvas.dispatchEvent(pointer('pointermove', { clientY: 82, shiftKey: true })) })
    expect(seen.at(-1)).toBeCloseTo(60, 5)

    // +18px fine = +1 -> 61.
    act(() => { canvas.dispatchEvent(pointer('pointermove', { clientY: 64, shiftKey: true })) })
    expect(seen.at(-1)).toBeCloseTo(61, 5)

    // Shift OFF, same clientY — must hold at 61, not snap back toward 50+100=150(clamped 100) or any other stale anchor value.
    act(() => { canvas.dispatchEvent(pointer('pointermove', { clientY: 64, shiftKey: false })) })
    expect(seen.at(-1)).toBeCloseTo(61, 5)

    act(() => { canvas.dispatchEvent(pointer('pointerup', { clientY: 64 })) })
  })
})

// VolumeFader now renders the shared Fader primitive (ui/src/components/
// controls/Fader.jsx), which batches pointermoves into one dragLaw update per
// animation frame — see Fader.test.jsx. Every move here needs a flushed
// frame before its effect on `seen` can be asserted.
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

describe('VolumeFader — mid-drag shift toggle does not jump the value', () => {
  it('holds steady when shift is pressed and released at the same pointer position', async () => {
    const seen = []
    const c = await mount(<VolumeFader value={1.0} onChange={(v) => seen.push(v)} />)
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)
    // jsdom has no ResizeObserver-backed layout, so the groove measures 0px
    // and Fader falls back to its `length` prop (default 160px) for
    // dragRange — fine for exercising the rebase, which only needs the
    // ANCHOR to hold, not a specific pixel-to-value mapping.

    act(() => { el.dispatchEvent(pointer('pointerdown', { clientY: 200 })) })
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 170 })) })
    await flushFrame()
    const beforeShift = seen.at(-1)
    expect(Number.isFinite(beforeShift)).toBe(true)

    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 170, shiftKey: true })) })
    await flushFrame()
    expect(seen.at(-1)).toBeCloseTo(beforeShift, 6)

    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 160, shiftKey: true })) })
    await flushFrame()
    const afterFineStep = seen.at(-1)

    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 160, shiftKey: false })) })
    await flushFrame()
    expect(seen.at(-1)).toBeCloseTo(afterFineStep, 6)

    act(() => { el.dispatchEvent(pointer('pointerup', { clientY: 160 })) })
  })
})

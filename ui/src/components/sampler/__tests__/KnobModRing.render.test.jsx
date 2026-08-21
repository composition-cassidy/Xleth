/**
 * @vitest-environment jsdom
 *
 * The shared Knob is used in roughly fifty places across the app — the mixer,
 * the EQ, every stock-effect panel. Drag-to-route adds a modulation ring to it,
 * and the whole design rests on that ring being OPT-IN via the `mod` prop.
 *
 * The first block is the guard: a Knob rendered WITHOUT `mod` — which is every
 * knob outside the sampler — must be indistinguishable from the pre-change one.
 * No drop attribute, no ring drawing, no ring hit-test stealing a value drag, no
 * context-menu interception. The second block proves the opt-in path actually
 * does something, so the guard cannot pass by the feature being inert.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Knob, { modRingRadius, modHandleCenter } from '../Knob.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SIZE = 42

// Records every canvas call so the guard can assert nothing extra was drawn.
let calls = []
const gradient = { addColorStop: () => {} }
function recordingCtx() {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return { width: 0, height: 0 }
      if (prop === 'measureText') return () => ({ width: 0 })
      return (...args) => { calls.push([String(prop), ...args]); return gradient }
    },
    set: (_t, prop, value) => { calls.push([`set:${String(prop)}`, value]); return true },
  })
}

let container = null
let root = null

beforeEach(() => {
  calls = []
  globalThis.HTMLCanvasElement.prototype.getContext = recordingCtx
  // jsdom reports a zero rect; the ring hit-test needs a real one.
  globalThis.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE, x: 0, y: 0,
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

function render(el) {
  act(() => root.render(el))
}

const canvas = () => container.querySelector('canvas')

function pointer(type, clientX, clientY, init = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, ...init })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  return ev
}

// Centre of the knob — a value drag, never a ring drag.
const CENTRE = [SIZE / 2, SIZE / 2]
// A point ON the modulation ring's radial band.
const onRing = () => [SIZE / 2 + modRingRadius(SIZE, 'rotary-arrow', false), SIZE / 2]
// The depth handle's centre — the primary grab point for the amount.
const onHandle = () => { const c = modHandleCenter(SIZE, 'rotary-arrow', false); return [c.x, c.y] }

describe('Knob WITHOUT a mod prop — the app-wide guard', () => {
  it('renders no drop-target attribute anywhere in its tree', () => {
    render(<Knob value={50} min={0} max={100} label="Gain" />)
    expect(container.querySelector('[data-mod-target]')).toBeNull()
  })

  it('drags by value from the centre exactly as before', () => {
    const onLiveChange = vi.fn()
    const onCommit = vi.fn()
    render(<Knob value={50} min={0} max={100} onLiveChange={onLiveChange} onCommit={onCommit} />)

    act(() => { canvas().dispatchEvent(pointer('pointerdown', CENTRE[0], CENTRE[1])) })
    act(() => { canvas().dispatchEvent(pointer('pointermove', CENTRE[0], CENTRE[1] - 18)) })
    act(() => { canvas().dispatchEvent(pointer('pointerup', CENTRE[0], CENTRE[1] - 18)) })

    expect(onLiveChange).toHaveBeenCalledTimes(1)
    // 18 px of a 180 px sweep = 10 % of a 0..100 range.
    expect(onLiveChange.mock.calls[0][0]).toBeCloseTo(60, 6)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(60, 6)
  })

  it('drags by value even from the radius the ring would occupy', () => {
    const onLiveChange = vi.fn()
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" onLiveChange={onLiveChange} />)
    const [rx, ry] = onRing()

    act(() => { canvas().dispatchEvent(pointer('pointerdown', rx, ry)) })
    act(() => { canvas().dispatchEvent(pointer('pointermove', rx, ry - 18)) })

    expect(onLiveChange).toHaveBeenCalledTimes(1)
    expect(onLiveChange.mock.calls[0][0]).toBeCloseTo(60, 6)
  })

  it('leaves the right-click default alone', () => {
    render(<Knob value={50} min={0} max={100} />)
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { canvas().dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
  })

  it('honours ctrl+click reset and the wheel unchanged', () => {
    const onCommit = vi.fn()
    render(<Knob value={50} min={0} max={100} defaultValue={25} onCommit={onCommit} />)
    act(() => { canvas().dispatchEvent(pointer('pointerdown', CENTRE[0], CENTRE[1], { ctrlKey: true })) })
    expect(onCommit).toHaveBeenCalledWith(25)
  })

  it('draws no dashed track — the only thing the ring adds to the canvas', () => {
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" />)
    expect(calls.some((c) => c[0] === 'setLineDash' && Array.isArray(c[1]) && c[1].length)).toBe(false)
  })
})

describe('Knob WITH a mod prop', () => {
  const makeMod = (over = {}) => ({
    dropProps: { 'data-mod-target': '3:1:0' },
    active: true,
    highlight: false,
    amount: 0.25,
    bipolar: true,
    ringLo: 30,
    ringHi: 70,
    colorVar: '--mod-lfo',
    tooltip: 'LFO 1 → Slot 2 SEM: ±12.0 st',
    onRingPreview: vi.fn(),
    onRingCommit: vi.fn(),
    onToggleBipolar: vi.fn(),
    ...over,
  })

  it('exposes the drop-target attribute the drag hit-tests against', () => {
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={makeMod()} />)
    expect(container.querySelector('[data-mod-target]')).toBeTruthy()
    expect(container.querySelector('[data-mod-target]').getAttribute('data-mod-target')).toBe('3:1:0')
  })

  it('drags the AMOUNT, not the value, when the pointer starts on the ring', () => {
    const mod = makeMod()
    const onLiveChange = vi.fn()
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={mod} onLiveChange={onLiveChange} />)
    const [rx, ry] = onRing()

    act(() => { canvas().dispatchEvent(pointer('pointerdown', rx, ry)) })
    act(() => { canvas().dispatchEvent(pointer('pointermove', rx, ry - 18)) })
    act(() => { canvas().dispatchEvent(pointer('pointerup', rx, ry - 18)) })

    expect(onLiveChange).not.toHaveBeenCalled()
    // 18 px of the 180 px amount travel = +0.1 on top of 0.25.
    expect(mod.onRingPreview).toHaveBeenCalledTimes(1)
    expect(mod.onRingPreview.mock.calls[0][0]).toBeCloseTo(0.35, 6)
    // One commit, on release — never during the drag.
    expect(mod.onRingCommit).toHaveBeenCalledTimes(1)
    expect(mod.onRingCommit.mock.calls[0][0]).toBeCloseTo(0.35, 6)
  })

  it('drags the AMOUNT from the depth handle at the ring’s top-left', () => {
    const mod = makeMod()
    const onLiveChange = vi.fn()
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={mod} onLiveChange={onLiveChange} />)
    const [hx, hy] = onHandle()

    act(() => { canvas().dispatchEvent(pointer('pointerdown', hx, hy)) })
    act(() => { canvas().dispatchEvent(pointer('pointermove', hx, hy - 18)) })
    act(() => { canvas().dispatchEvent(pointer('pointerup', hx, hy - 18)) })

    expect(onLiveChange).not.toHaveBeenCalled()
    // 18 px UP of the 180 px amount travel = +0.1 on top of 0.25.
    expect(mod.onRingPreview.mock.calls[0][0]).toBeCloseTo(0.35, 6)
    expect(mod.onRingCommit.mock.calls[0][0]).toBeCloseTo(0.35, 6)
  })

  it('the handle answers to a horizontal drag too (right = more)', () => {
    const mod = makeMod()
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={mod} />)
    const [hx, hy] = onHandle()

    act(() => { canvas().dispatchEvent(pointer('pointerdown', hx, hy)) })
    act(() => { canvas().dispatchEvent(pointer('pointermove', hx + 18, hy)) })
    act(() => { canvas().dispatchEvent(pointer('pointerup', hx + 18, hy)) })

    // 18 px RIGHT = +0.1, same as 18 px up.
    expect(mod.onRingCommit.mock.calls[0][0]).toBeCloseTo(0.35, 6)
  })

  it('still drags the VALUE from the centre of a routed knob', () => {
    const mod = makeMod()
    const onLiveChange = vi.fn()
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={mod} onLiveChange={onLiveChange} />)

    act(() => { canvas().dispatchEvent(pointer('pointerdown', CENTRE[0], CENTRE[1])) })
    act(() => { canvas().dispatchEvent(pointer('pointermove', CENTRE[0], CENTRE[1] - 18)) })

    expect(mod.onRingPreview).not.toHaveBeenCalled()
    expect(onLiveChange).toHaveBeenCalledTimes(1)
  })

  it('toggles bipolar on right-click and swallows the browser menu', () => {
    const mod = makeMod()
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={mod} />)
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { canvas().dispatchEvent(ev) })
    expect(mod.onToggleBipolar).toHaveBeenCalledTimes(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('does not intercept right-click when nothing is routed', () => {
    const mod = makeMod({ active: false })
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={mod} />)
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { canvas().dispatchEvent(ev) })
    expect(mod.onToggleBipolar).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('puts the route in the tooltip', () => {
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow" mod={makeMod()} />)
    expect(canvas().getAttribute('title')).toContain('LFO 1 → Slot 2 SEM')
  })

  it('dashes the ring track while a card hovers an UNROUTED knob', () => {
    calls = []
    render(<Knob value={50} min={0} max={100} glyph="rotary-arrow"
                 mod={makeMod({ active: false, highlight: true })} />)
    expect(calls.some((c) => c[0] === 'setLineDash' && Array.isArray(c[1]) && c[1].length)).toBe(true)
  })
})

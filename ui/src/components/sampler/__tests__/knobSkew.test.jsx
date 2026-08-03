/**
 * @vitest-environment jsdom
 *
 * Knob `skew` — drives the REAL component with pointer events so the whole
 * chain (prop -> normalised drag -> emitted value) is exercised, not just the
 * mapping algebra.
 *
 * Why this exists: the Delay panel's TIME knob passed min/max straight through
 * while the engine declares time_l as NormalisableRange{1, 5000, 0, 0.4}. On a
 * linear knob 500 ms sat at 10 % of travel and a half-travel drag produced
 * ~2500 ms instead of ~885 ms — long enough that the echo fell outside short
 * material and the delay sounded dead.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Knob from '../Knob.jsx'

// jsdom has no canvas backend; the knob paints on mount. Same stub pattern the
// other canvas-bearing suites here use — the drawing is irrelevant to the
// value mapping under test.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const gradient = { addColorStop: () => {} }
const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    // Every draw call is a no-op; gradient factories must return something
    // with addColorStop, so hand back the same stub for all of them.
    return () => gradient
  },
})

// juce::NormalisableRange, the behaviour the knob must match.
const juceFrom01 = (x, min, max, skew) => min + (max - min) * Math.pow(x, 1 / skew)
const juceTo01 = (v, min, max, skew) => Math.pow((v - min) / (max - min), skew)

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

async function mountKnob(props) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Knob size={72} dragRange={180} {...props} />)
  })
  return container.querySelector('canvas')
}

// jsdom has no pointer capture; the component guards it, but stub anyway.
function stubCapture(el) {
  el.setPointerCapture = () => {}
  el.releasePointerCapture = () => {}
}

function drag(canvas, fromY, toY) {
  const mk = (type, clientY) => {
    const e = new Event(type, { bubbles: true })
    Object.assign(e, { clientY, clientX: 0, pointerId: 1, shiftKey: false, ctrlKey: false, metaKey: false })
    return e
  }
  act(() => { canvas.dispatchEvent(mk('pointerdown', fromY)) })
  act(() => { canvas.dispatchEvent(mk('pointermove', toY)) })
  act(() => { canvas.dispatchEvent(mk('pointerup', toY)) })
}

describe('Knob skew', () => {
  it('defaults to linear, matching the pre-skew behaviour', async () => {
    const seen = []
    const canvas = await mountKnob({
      value: 50, min: 0, max: 100, defaultValue: 50,
      onLiveChange: v => seen.push(v), onCommit: () => {},
    })
    stubCapture(canvas)
    // 180 px of travel == the full sweep, so +90 px == +50 % == 50 -> 100.
    drag(canvas, 100, 10)
    expect(seen.at(-1)).toBeCloseTo(100, 6)
  })

  it('a half-sweep drag from the bottom follows the skew curve', async () => {
    const MIN = 1, MAX = 5000, SKEW = 0.4
    for (const [skew, expected] of [
      [1, juceFrom01(0.5, MIN, MAX, 1)],        // 2500.5 ms  (the old, wrong feel)
      [SKEW, juceFrom01(0.5, MIN, MAX, SKEW)],  //  884.6 ms  (what the engine intends)
    ]) {
      const seen = []
      const canvas = await mountKnob({
        value: MIN, min: MIN, max: MAX, defaultValue: 500, skew,
        onLiveChange: v => seen.push(v), onCommit: () => {},
      })
      stubCapture(canvas)
      drag(canvas, 100, 10) // +90 px = +0.5 of the sweep, starting at the floor
      expect(seen.at(-1)).toBeCloseTo(expected, 3)
      await act(async () => root.unmount())
      container.remove()
      root = null
      container = null
    }
  })

  it('places 500 ms near 40% of travel, not 10%, for the delay TIME range', async () => {
    const MIN = 1, MAX = 5000, SKEW = 0.4
    expect(juceTo01(500, MIN, MAX, SKEW)).toBeCloseTo(0.398, 3)
    expect(juceTo01(500, MIN, MAX, 1)).toBeCloseTo(0.0998, 3)

    // Dragging DOWN a half sweep from 500 ms must not slam into the floor,
    // which is what made short delay times unreachable in practice.
    const seen = []
    const canvas = await mountKnob({
      value: 500, min: MIN, max: MAX, defaultValue: 500, skew: SKEW,
      onLiveChange: v => seen.push(v), onCommit: () => {},
    })
    stubCapture(canvas)
    drag(canvas, 100, 118) // -18 px = -0.1 of the sweep
    const got = seen.at(-1)
    expect(got).toBeCloseTo(juceFrom01(juceTo01(500, MIN, MAX, SKEW) - 0.1, MIN, MAX, SKEW), 3)
    expect(got).toBeGreaterThan(MIN)
    expect(got).toBeLessThan(500)
  })

  it('ignores a non-positive or non-finite skew instead of emitting NaN', async () => {
    for (const bad of [0, -1, NaN, undefined]) {
      const seen = []
      const canvas = await mountKnob({
        value: 50, min: 0, max: 100, defaultValue: 50, skew: bad,
        onLiveChange: v => seen.push(v), onCommit: () => {},
      })
      stubCapture(canvas)
      drag(canvas, 100, 10)
      expect(Number.isFinite(seen.at(-1))).toBe(true)
      expect(seen.at(-1)).toBeCloseTo(100, 6)
      await act(async () => root.unmount())
      container.remove()
      root = null
      container = null
    }
  })
})

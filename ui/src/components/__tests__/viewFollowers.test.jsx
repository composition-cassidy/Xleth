/* @vitest-environment jsdom */
import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, it, expect, vi } from 'vitest'

import LoopRegionBar from '../timeline/LoopRegionBar.jsx'
import PianoRollKeyboard, { PITCH_MAX } from '../pianoRoll/PianoRollKeyboard.jsx'
import PianoRollRuler from '../pianoRoll/PianoRollRuler.jsx'
import { PPQ } from '../../constants/timeline.js'

// Regression: smooth (spring-eased) zoom/scroll drives the canvases through the
// view animator's per-frame refs, but the DOM overlays that live alongside them
// used to be positioned from the SETTLED React state, which only syncs ~100ms
// after a gesture stops. The result was an overlay frozen in place for the
// whole animation that then snapped to its final spot.
//
// Each of these asserts the same contract: push a new value into the animator's
// ref, call the overlay's applyView() as an animator frame would, and the DOM
// must have moved — with NO re-render and no state update in between.

vi.mock('../../stores/loopRegionStore.js', () => {
  // Literals, not PPQ: vi.mock factories are hoisted above the imports.
  const loopRegion = { startTick: 4 * 960, endTick: 8 * 960, loopEnabled: true }
  const useLoopRegionStore = (selector) => selector({
    loopRegion,
    fetchLoopRegion: () => Promise.resolve(loopRegion),
  })
  return {
    default: useLoopRegionStore,
    loopMinLengthTicks: () => 1,
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container = null
let root = null

function render(element) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(element) })
  return container
}

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  root = null
  container = null
})

describe('loop region bar follows the animator', () => {
  it('moves on an animator frame, without a re-render', () => {
    const pixelsPerBeatRef = { current: 40 }
    const scrollOffsetRef = { current: 0 }
    const ref = createRef()

    const container = render(
      <LoopRegionBar
        ref={ref}
        pixelsPerBeatRef={pixelsPerBeatRef}
        scrollOffsetRef={scrollOffsetRef}
        snapGranularity={0.25}
        rulerHeight={24}
      />,
    )
    const bar = container.querySelector('.loop-region-bar')
    // start 4 beats * 40px = 160px, 4 beats wide = 160px
    expect(bar.style.transform).toBe('translateX(160px)')
    expect(bar.style.width).toBe('160px')

    // One eased frame: scrolled 1 beat right.
    scrollOffsetRef.current = 1
    ref.current.applyView()
    expect(bar.style.transform).toBe('translateX(120px)')
    expect(bar.style.width).toBe('160px')

    // One eased ZOOM frame: the bar's width has to track ppb too.
    pixelsPerBeatRef.current = 80
    ref.current.applyView()
    expect(bar.style.transform).toBe('translateX(240px)')
    expect(bar.style.width).toBe('320px')
  })
})

// The keyboard and ruler are canvases (round 2, step 12): the contract is the
// same, applyView() repaints from the animator's refs with no re-render.
function recordingCtx() {
  const calls = []
  const ctx = new Proxy({ calls }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return (...args) => { calls.push([prop, ...args]) }
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
  return ctx
}

function withCanvasStub(fn) {
  const ctx = recordingCtx()
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = () => ctx
  try { return fn(ctx) } finally { HTMLCanvasElement.prototype.getContext = orig }
}

const texts = (ctx) => ctx.calls.filter((c) => c[0] === 'fillText').map((c) => ({ text: c[1], x: c[2], y: c[3] }))

describe('piano roll keyboard follows the animator', () => {
  it('repaints its keys on an animator frame, aligned with the grid rows', () => {
    withCanvasStub((ctx) => {
      const pixelsPerSemitoneRef = { current: 12 }
      const scrollYRef = { current: (PITCH_MAX - 72) * 12 }   // C5 row at the top
      const ref = createRef()
      render(
        <PianoRollKeyboard
          ref={ref}
          pixelsPerSemitoneRef={pixelsPerSemitoneRef}
          scrollYRef={scrollYRef}
          height={300}
          onPreviewNote={() => {}}
          highlightedPitches={new Set()}
        />,
      )
      ctx.calls.length = 0
      ref.current.applyView()
      const c5 = texts(ctx).find((t) => t.text === 'C5')
      // Row of C5 starts at y=0, its label sits on the row's centre.
      expect(c5.y).toBeCloseTo(6.5, 5)

      // Scroll one octave down (toward lower pitches): C4 is now the top row.
      scrollYRef.current += 12 * 12
      ctx.calls.length = 0
      ref.current.applyView()
      const labels = texts(ctx).map((t) => t.text)
      expect(labels[0]).toBe('C4')
      expect(labels).not.toContain('C5')
    })
  })
})

describe('piano roll ruler follows the animator', () => {
  it('repaints its bar labels on an animator frame', () => {
    withCanvasStub((ctx) => {
      const pixelsPerBeatRef = { current: 40 }
      const scrollXRef = { current: 0 }
      const ref = createRef()
      render(
        <PianoRollRuler
          ref={ref}
          pixelsPerBeatRef={pixelsPerBeatRef}
          scrollXRef={scrollXRef}
          width={400}
          height={23}
        />,
      )
      ctx.calls.length = 0
      ref.current.applyView()
      expect(texts(ctx)[0].text).toBe('1')

      // Scroll 4 beats (one bar) right: bar 2 is now at the left edge.
      scrollXRef.current = 160
      ctx.calls.length = 0
      ref.current.applyView()
      const first = texts(ctx)[0]
      expect(first.text).toBe('2')
      expect(first.x).toBeCloseTo(3.5, 5)
    })
  })
})

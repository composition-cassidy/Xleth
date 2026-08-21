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

describe('piano roll keyboard follows the animator', () => {
  it('scrolls and re-lays-out its keys on an animator frame', () => {
    const pixelsPerSemitoneRef = { current: 10 }
    const scrollYRef = { current: 0 }
    const ref = createRef()

    const container = render(
      <PianoRollKeyboard
        ref={ref}
        pixelsPerSemitoneRef={pixelsPerSemitoneRef}
        scrollYRef={scrollYRef}
        height={400}
        onPreviewNote={() => {}}
        highlightedPitches={new Set()}
      />,
    )
    const layer = container.querySelector('.piano-roll-keyboard > div')
    const keys = container.querySelectorAll('.piano-roll-key')
    expect(layer.style.transform).toBe('translateY(0px)')
    // Keys are laid out top-down from the highest pitch.
    expect(keys[0].style.top).toBe('0px')
    expect(keys[0].style.height).toBe('10px')
    expect(keys[12].style.top).toBe('120px')

    scrollYRef.current = 250
    ref.current.applyView()
    expect(layer.style.transform).toBe('translateY(-250px)')

    // Vertical zoom changes each key's height, not just the layer offset.
    pixelsPerSemitoneRef.current = 20
    ref.current.applyView()
    expect(keys[12].style.top).toBe('240px')
    expect(keys[12].style.height).toBe('20px')
  })

  it('keeps the top key aligned with the canvas row for the same pitch', () => {
    const pixelsPerSemitoneRef = { current: 12 }
    const scrollYRef = { current: 96 }
    const ref = createRef()
    const container = render(
      <PianoRollKeyboard
        ref={ref}
        pixelsPerSemitoneRef={pixelsPerSemitoneRef}
        scrollYRef={scrollYRef}
        height={300}
        onPreviewNote={() => {}}
        highlightedPitches={new Set()}
      />,
    )
    ref.current.applyView()
    const layer = container.querySelector('.piano-roll-keyboard > div')
    const keys = container.querySelectorAll('.piano-roll-key')

    // The canvas draws pitch p at y = (PITCH_MAX - p) * pps - scrollY; the
    // keyboard must land on exactly the same y after its layer transform.
    const pitch = PITCH_MAX - 20
    const idx = PITCH_MAX - pitch
    const canvasY = idx * pixelsPerSemitoneRef.current - scrollYRef.current
    const keyboardY = parseFloat(keys[idx].style.top)
      + parseFloat(layer.style.transform.match(/-?[\d.]+/)[0])
    expect(keyboardY).toBeCloseTo(canvasY, 9)
  })
})

describe('piano roll ruler follows the animator', () => {
  it('rebuilds its tick labels on an animator frame', () => {
    const pixelsPerBeatRef = { current: 40 }
    const scrollXRef = { current: 0 }
    const ref = createRef()

    const container = render(
      <PianoRollRuler
        ref={ref}
        pixelsPerBeatRef={pixelsPerBeatRef}
        scrollXRef={scrollXRef}
        width={400}
        height={24}
        keyboardWidth={60}
        scrollbarWidth={20}
      />,
    )
    const visible = () => Array.from(container.querySelectorAll('.piano-roll-ruler-tick'))
      .filter((el) => el.style.display !== 'none')

    expect(visible()[0].textContent).toBe('1')     // bar 1 at beat 0
    expect(visible()[0].style.left).toBe('0px')

    // Scroll 4 beats (one bar) right: bar 2 is now at the left edge.
    scrollXRef.current = 160
    ref.current.applyView()
    expect(visible()[0].textContent).toBe('2')
    expect(visible()[0].style.left).toBe('0px')

    // Sub-beat scroll positions land off-grid, as the canvas grid does.
    // Spans are pooled, not re-allocated, across frames.
    const poolSize = container.querySelectorAll('.piano-roll-ruler-tick').length
    scrollXRef.current = 210
    ref.current.applyView()
    expect(container.querySelectorAll('.piano-roll-ruler-tick').length).toBe(poolSize)
    expect(visible()[0].textContent).toBe('2.2')
    expect(visible()[0].style.left).toBe('-10px')
  })
})

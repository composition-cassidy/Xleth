// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import TailRenderControls, {
  clampTailNumber,
  TAIL_THRESHOLD_MIN,
  TAIL_THRESHOLD_MAX,
  TAIL_MAX_SECONDS_MIN,
  TAIL_MAX_SECONDS_MAX,
} from './TailRenderControls.jsx'
import useLoopRegionStore, { DEFAULT_LOOP_REGION } from '../stores/loopRegionStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
function renderHtml(el) {
  const root = createRoot(container)
  act(() => { root.render(el) })
  const html = container.innerHTML
  act(() => { root.unmount() })
  return html
}

describe('TailRenderControls', () => {
  beforeEach(() => {
    window.xleth = { timeline: {} }
    container = document.createElement('div')
    document.body.appendChild(container)
    useLoopRegionStore.getState().setLoopRegionLocal({ ...DEFAULT_LOOP_REGION })
  })

  afterEach(() => {
    container.remove()
  })

  it('uses user-facing End Behavior copy while preserving tail mode values', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('End Behavior')
    expect(html).not.toContain('Tail mode')
    expect(html).toContain('value="tailClamp"')
    expect(html).toContain('Let audio fade out')
    expect(html).toContain('value="hardCut"')
    expect(html).toContain('Cut exactly at end')
    expect(html).toContain('value="wrap"')
    expect(html).toContain('Loop-safe wrap')
  })

  it('shows the fade-out helper and compact tail limits only for tailClamp', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('After the region ends, existing reverb, delay, and effect tails continue until they fade below the limit.')
    expect(html).toContain('Tail fade settings')
    expect(html).toContain('Tail threshold (dBFS)')
    expect(html).toContain('value="-60"')
    expect(html).toContain('Tail max (seconds)')
    expect(html).toContain('value="10"')
  })

  it('hides tail threshold and max controls for hardCut', () => {
    useLoopRegionStore.getState().setLoopRegionLocal({
      ...DEFAULT_LOOP_REGION,
      tailMode: 'hardCut',
    })
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Export stops at the region end. Effect tails are cut off.')
    expect(html).not.toContain('Tail threshold (dBFS)')
    expect(html).not.toContain('Tail max (seconds)')
  })

  it('hides tail threshold and max controls for wrap', () => {
    useLoopRegionStore.getState().setLoopRegionLocal({
      ...DEFAULT_LOOP_REGION,
      tailMode: 'wrap',
    })
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Effect tails are folded back into the start of the region for seamless loop exports.')
    expect(html).not.toContain('Tail threshold (dBFS)')
    expect(html).not.toContain('Tail max (seconds)')
  })

  it('uses Start Processing From copy and disables the reserved normalized origin value', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Start Processing From')
    expect(html).not.toContain('Render origin')
    expect(html).toContain('value="absolute"')
    expect(html).toContain('Project start')
    expect(html).toMatch(/<option value="normalized"[^>]*disabled/)
    expect(html).toContain('Region start')
  })

  it('clamps and sanitizes threshold/cap values', () => {
    expect(clampTailNumber('5', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(0)
    expect(clampTailNumber('-999', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(-120)
    expect(clampTailNumber('-42', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(-42)
    expect(clampTailNumber('abc', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(-60)

    expect(clampTailNumber('-5', TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(0)
    expect(clampTailNumber('9999', TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(120)
    expect(clampTailNumber('7.5', TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(7.5)
    expect(clampTailNumber(Infinity, TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(10)
  })
})

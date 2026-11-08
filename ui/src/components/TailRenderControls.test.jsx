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

  it('uses user-facing End behavior copy and offers the three tail modes', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<TailRenderControls />) })
    expect(container.innerHTML).toContain('End behavior')
    expect(container.innerHTML).not.toContain('Tail mode')
    // The selected mode is shown; the other two are in the Select's list.
    expect(container.innerHTML).toContain('Let audio fade out')
    const trigger = container.querySelector('[aria-label="End behavior"]')
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const labels = Array.from(document.body.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim())
    expect(labels).toEqual(['Let audio fade out', 'Cut exactly at end', 'Loop-safe wrap'])
    await act(async () => root.unmount())
  })

  it('shows the fade-out helper and compact tail limits only for tailClamp', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('After the region ends, existing reverb, delay, and effect tails continue until they fade below the limit.')
    expect(html).toContain('Tail fade settings')
    expect(html).toContain('Tail threshold')
    expect(html).toContain('aria-valuenow="-60"')
    expect(html).toContain('Tail max')
    expect(html).toContain('aria-valuenow="10"')
  })

  it('hides tail threshold and max controls for hardCut', () => {
    useLoopRegionStore.getState().setLoopRegionLocal({
      ...DEFAULT_LOOP_REGION,
      tailMode: 'hardCut',
    })
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Export stops at the region end. Effect tails are cut off.')
    expect(html).not.toContain('Tail threshold')
    expect(html).not.toContain('Tail max')
  })

  it('hides tail threshold and max controls for wrap', () => {
    useLoopRegionStore.getState().setLoopRegionLocal({
      ...DEFAULT_LOOP_REGION,
      tailMode: 'wrap',
    })
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Effect tails are folded back into the start of the region for seamless loop exports.')
    expect(html).not.toContain('Tail threshold')
    expect(html).not.toContain('Tail max')
  })

  it('uses Start processing from copy and disables the reserved normalized origin value', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<TailRenderControls />) })
    expect(container.innerHTML).toContain('Start processing from')
    expect(container.innerHTML).not.toContain('Render origin')
    expect(container.innerHTML).toContain('Project start')
    const trigger = container.querySelector('[aria-label="Start processing from"]')
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const region = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent.includes('Region start'))
    expect(region).toBeTruthy()
    expect(region.disabled || region.getAttribute('aria-disabled') === 'true').toBe(true)
    await act(async () => root.unmount())
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

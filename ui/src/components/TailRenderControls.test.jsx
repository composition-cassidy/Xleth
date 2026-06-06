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

// Real client render (jsdom) so the zustand store updates are reflected — under
// SSR (renderToStaticMarkup) zustand v5 uses getInitialState, which would always
// show the default region.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
function renderHtml(el) {
  const root = createRoot(container)
  act(() => { root.render(el) })
  const html = container.innerHTML
  act(() => { root.unmount() })
  return html
}

describe('TailRenderControls (Phase 3A)', () => {
  beforeEach(() => {
    // timeline mock: no getLoopRegion so the mount fetch no-ops and the state we
    // set below is what renders.
    window.xleth = { timeline: {} }
    container = document.createElement('div')
    document.body.appendChild(container)
    useLoopRegionStore.getState().setLoopRegionLocal({ ...DEFAULT_LOOP_REGION })
  })
  afterEach(() => { container.remove() })

  it('shows the tail-mode control with hardCut, tailClamp and a disabled wrap option', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Tail mode')
    expect(html).toContain('value="tailClamp"')
    expect(html).toContain('value="hardCut"')
    // wrap is visible but explicitly disabled and marked Phase 3B — never active.
    expect(html).toContain('Phase 3B')
    expect(html).toMatch(/<option value="wrap"[^>]*disabled/)
  })

  it('shows the tailClamp explanation by default (effects ring out, frozen frame)', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('ring out')
    expect(html).toContain('frozen')
  })

  it('shows the hardCut click/pop warning when hardCut is selected', () => {
    useLoopRegionStore.getState().setLoopRegionLocal({
      ...DEFAULT_LOOP_REGION, tailMode: 'hardCut',
    })
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('tail-warning')
    expect(html).toMatch(/click\/pop/)
  })

  it('defaults threshold to -60 dBFS and cap to 10 seconds', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Tail threshold (dBFS)')
    expect(html).toContain('value="-60"')
    expect(html).toContain('Tail max (seconds)')
    expect(html).toContain('value="10"')
  })

  it('defaults render origin to absolute and disables the reserved normalized option', () => {
    const html = renderHtml(<TailRenderControls />)
    expect(html).toContain('Render origin')
    expect(html).toContain('value="absolute"')
    expect(html).toMatch(/<option value="normalized"[^>]*disabled/)
  })

  it('clamps and sanitizes threshold/cap values', () => {
    // Threshold: finite, [-120, 0]; non-finite → fallback.
    expect(clampTailNumber('5', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(0)
    expect(clampTailNumber('-999', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(-120)
    expect(clampTailNumber('-42', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(-42)
    expect(clampTailNumber('abc', TAIL_THRESHOLD_MIN, TAIL_THRESHOLD_MAX, -60)).toBe(-60)

    // Cap: finite, non-negative, capped.
    expect(clampTailNumber('-5', TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(0)
    expect(clampTailNumber('9999', TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(120)
    expect(clampTailNumber('7.5', TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(7.5)
    expect(clampTailNumber(Infinity, TAIL_MAX_SECONDS_MIN, TAIL_MAX_SECONDS_MAX, 10)).toBe(10)
  })
})

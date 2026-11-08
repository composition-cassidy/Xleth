/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoFlipSection from '../VideoFlipSection.jsx'
import { applyFlipStyle, flipStyleOf, parsePitchInput } from '../videoFlipModel.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

const base = (over = {}) => ({
  enabled: true,
  states: [{ id: 's0', orientation: 'none' }, { id: 's1', orientation: 'horizontal' }],
  modifier: { type: 'every-note', config: {} },
  startStateIndex: 1,
  ...over,
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('flip styles are the engine canonical cycles (migrateVideoFlipMode)', () => {
  it('reads Horizontal (every other note), Clockwise, Counter-clockwise, None and Custom', () => {
    expect(flipStyleOf(base())).toBe('horizontal')
    expect(flipStyleOf(applyFlipStyle(base(), 'clockwise')).toString()).toBe('clockwise')
    const cw = applyFlipStyle(base(), 'clockwise')
    expect(cw.states.map((s) => s.orientation)).toEqual(['none', 'vertical', 'rotate-180', 'horizontal'])
    expect(cw.startStateIndex).toBe(0)
    const ccw = applyFlipStyle(base(), 'counterclockwise')
    expect(ccw.states.map((s) => s.orientation)).toEqual(['none', 'horizontal', 'rotate-180', 'vertical'])
    expect(flipStyleOf(base({ startStateIndex: 0 }))).toBe('custom') // the start state is part of the style
    expect(flipStyleOf(base({ states: [{ id: 's0', orientation: 'rotate-90-cw' }] }))).toBe('custom')
  })

  it('a style keeps Enabled and the modifier', () => {
    const c = base({ enabled: false, modifier: { type: 'new-note', config: {} } })
    const next = applyFlipStyle(c, 'clockwise')
    expect(next.enabled).toBe(false)
    expect(next.modifier).toEqual({ type: 'new-note', config: {} })
  })

  it('parses note names and MIDI numbers', () => {
    expect(parsePitchInput('C4')).toBe(60)
    expect(parsePitchInput('D#5')).toBe(75)
    expect(parsePitchInput('60')).toBe(60)
    expect(parsePitchInput('H2')).toBeNull()
  })
})

describe('VideoFlipSection', () => {
  it('a style click is one setVideoFlipConfig with the canonical cycle', async () => {
    const onCommit = vi.fn()
    act(() => root.render(<VideoFlipSection track={{ id: 1, videoFlipConfig: base() }} onCommit={onCommit} />))
    const cw = container.querySelector('[aria-label="Clockwise"]')
    act(() => cw.click())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0].states.map((s) => s.orientation)).toEqual(['none', 'vertical', 'rotate-180', 'horizontal'])
  })

  it('Enabled is a label-free toggle named by its row', () => {
    const onCommit = vi.fn()
    act(() => root.render(<VideoFlipSection track={{ id: 1, videoFlipConfig: base({ enabled: false }) }} onCommit={onCommit} />))
    const t = container.querySelector('button[aria-label="Flip enabled"]')
    expect(t.getAttribute('aria-pressed')).toBe('false')
    expect(t.textContent).toBe('')
    act(() => t.click())
    expect(onCommit.mock.calls[0][0].enabled).toBe(true)
  })

  it('the preview is ONE row of eight cells: note, glyph, state', () => {
    act(() => root.render(<VideoFlipSection track={{ id: 1, videoFlipConfig: base() }} onCommit={() => {}} />))
    const cells = container.querySelectorAll('ol[aria-label="Preview of the next eight notes"] > li')
    expect(cells).toHaveLength(8)
    // Horizontal style, start state 2: notes alternate 2, 1, 2, 1 ...
    expect(Array.from(cells).map((c) => c.lastElementChild.textContent)).toEqual(['2', '1', '2', '1', '2', '1', '2', '1'])
    expect(cells[0].firstElementChild.textContent).toBe('C4')
  })

  it('a state cell opens a menu; picking an orientation is one commit', () => {
    const onCommit = vi.fn()
    act(() => root.render(<VideoFlipSection track={{ id: 1, videoFlipConfig: base() }} onCommit={onCommit} />))
    act(() => container.querySelector('button[aria-label^="State 1"]').click())
    const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((el) => el.textContent.includes('Rotate 180'))
    act(() => item.click())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0].states[0].orientation).toBe('rotate-180')
  })

  it('moving a state keeps the start mark on the same state', () => {
    const onCommit = vi.fn()
    act(() => root.render(<VideoFlipSection track={{ id: 1, videoFlipConfig: base() }} onCommit={onCommit} />))
    act(() => container.querySelector('button[aria-label^="State 2"]').click())
    const earlier = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent === 'Move earlier')
    act(() => earlier.click())
    const next = onCommit.mock.calls[0][0]
    expect(next.states.map((s) => s.id)).toEqual(['s1', 's0'])
    expect(next.startStateIndex).toBe(0)
  })
})

/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ClipInspector from '../ClipInspector.jsx'
import ClipPictureSection from '../../timeline/ClipPictureSection.jsx'

vi.mock('../../timeline/clipFxEditorOpeners.js', () => ({ openClipFxEditor: vi.fn() }))
import { openClipFxEditor } from '../../timeline/clipFxEditorOpeners.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

const clip = (over = {}) => ({
  id: 5, regionId: 2, reversed: false, formantPreserve: true, stretchMethod: 0,
  modulation: { vibrato: { enabled: true, depthCents: 40 }, scratch: { enabled: false }, video: { vibratoSwirlEnabled: true, swirlAmount: 0.3 } },
  ...over,
})
const actions = () => ({
  reverse: vi.fn(), setStretchMethod: vi.fn(), setFormantPreserve: vi.fn(),
  setVibrato: vi.fn(), setScratch: vi.fn(), setVideoFx: vi.fn(), globalStretchMethod: 1,
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.xleth = { timeline: { getRegions: async () => [], getSources: async () => [] } }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
})

describe('ClipInspector', () => {
  it('toggles are named by their row and never echo the label or print Off', () => {
    const a = actions()
    act(() => root.render(<ClipInspector context={{ clip: clip(), region: { name: 'Hey' }, source: { hasVideo: true } }} actions={a} />))
    const toggles = Array.from(container.querySelectorAll('button[aria-pressed]'))
    expect(toggles.map((t) => t.getAttribute('aria-label'))).toEqual(['Reverse', 'Preserve formants', 'Vibrato', 'Scratch', 'Swirl', 'Wave'])
    toggles.forEach((t) => expect(t.textContent).toBe(''))
    expect(container.textContent).not.toMatch(/\bOff\b/)
  })

  it('Reverse and Formant call the arrangement handlers, once', () => {
    const a = actions()
    act(() => root.render(<ClipInspector context={{ clip: clip(), region: {}, source: {} }} actions={a} />))
    act(() => container.querySelector('button[aria-label="Reverse"]').click())
    act(() => container.querySelector('button[aria-label="Preserve formants"]').click())
    expect(a.reverse).toHaveBeenCalledWith(5)
    expect(a.setFormantPreserve).toHaveBeenCalledWith(5, false)
  })

  it('Edit opens the existing clip FX editors', () => {
    act(() => root.render(<ClipInspector context={{ clip: clip(), region: {}, source: {} }} actions={actions()} />))
    const edits = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Edit')
    act(() => edits[0].click())
    act(() => edits[1].click())
    expect(openClipFxEditor).toHaveBeenCalledWith('vibrato', 5)
    expect(openClipFxEditor).toHaveBeenCalledWith('scratch', 5)
  })

  it('no visual-effect amount is left in the Inspector', () => {
    act(() => root.render(<ClipInspector context={{ clip: clip(), region: {}, source: {} }} actions={actions()} />))
    expect(container.querySelector('[role="slider"]')).toBeNull()
  })
})

describe('ClipPictureSection (in the vibrato / scratch editors)', () => {
  it('the swirl amount previews locally and commits once through the editor store', () => {
    const commitVideo = vi.fn()
    act(() => root.render(<ClipPictureSection kind="swirl" clip={clip()} commitVideo={commitVideo} />))
    const amount = container.querySelector('[role="slider"][aria-label="Swirl amount"]')
    act(() => { amount.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(commitVideo).toHaveBeenCalledTimes(1)
    expect(commitVideo.mock.calls[0][0].swirlAmount).toBeCloseTo(0.31, 6)
  })

  it('says where to switch it on when the companion is off', () => {
    act(() => root.render(<ClipPictureSection kind="wave" clip={clip()} commitVideo={() => {}} />))
    expect(container.textContent).toContain('Wave is off')
  })
})

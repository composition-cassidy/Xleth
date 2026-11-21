/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useMixerStore from '../../../stores/mixerStore.js'
import VideoDeviceChain from '../video/VideoDeviceChain.jsx'
import useVideoDeviceStore from '../video/videoDeviceStore.js'
import {
  bounceDisplacement, bounceTotalMs, easeOutBack, fadeBezier, noteFadeGain, sidePercent,
} from '../video/videoMotionMath.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
let timeline
let track

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const devices = () => Array.from(container.querySelectorAll('section[aria-label]')).map((s) => s.getAttribute('aria-label'))
const section = (name) => Array.from(container.querySelectorAll('section[aria-label]')).find((s) => s.getAttribute('aria-label').startsWith(name))
const slider = (name, scope = container) => Array.from(scope.querySelectorAll('[role="slider"]'))
  .find((el) => (el.getAttribute('aria-label') ?? '').startsWith(name))
const nudge = (el) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })

async function pick(scope, ariaLabel, optionLabel) {
  const trigger = scope.querySelector(`[aria-label="${ariaLabel}"]`)
  expect(trigger, `select "${ariaLabel}"`).toBeTruthy()
  act(() => trigger.click())
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent.trim() === optionLabel)
  expect(option, `option "${optionLabel}"`).toBeTruthy()
  act(() => option.click())
  await flush()
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  track = {
    id: 7, name: 'Pitch', type: 'Pattern', visualEffectChain: [],
    bounce: { enabled: true, directionDeg: 270, distance: 0.15, durationMs: 200, repeatCount: 1 },
    pingPong: { enabled: true, regionStartPct: 0.8, regionEndPct: 1, crossfadeFrames: 3, reverseSpeed: 1, maxLoops: 0 },
    noteFade: { enabled: true, fadeIn: { mode: 0, percent: 10, divisionDenominator: 16, ms: 60, curve: 0 }, fadeOut: { mode: 0, percent: 20, divisionDenominator: 16, ms: 60, curve: 1 } },
    slideNoteEffect: { type: 0 },
  }
  timeline = {
    getTracks: vi.fn(async () => [track]),
    getGridLayout: vi.fn(async () => ({ slots: [] })),
    setTrackBounceSettings: vi.fn(async () => true),
    setTrackPingPongSettings: vi.fn(async () => true),
    setTrackNoteFade: vi.fn(async () => true),
    setTrackSlideNoteEffect: vi.fn(async () => true),
    setTrackZoomPanRotSettings: vi.fn(async () => true),
  }
  window.xleth = { timeline }
  useMixerStore.setState({ selectedChainKey: '7', tracks: { 7: { id: 7, name: 'Pitch' } } })
  useVideoDeviceStore.setState({ view: 'video', shown: {}, window: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
})

describe('motion maths (ported from AnimationManager.cpp / NoteFade.h / ClipFade.h)', () => {
  it('ease-out-back starts at 0, ends at 1 and overshoots on the way', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 6)
    expect(easeOutBack(1)).toBeCloseTo(1, 6)
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map((t) => easeOutBack(t)))).toBeGreaterThan(1)
  })

  it('bounce: full distance at the note, halved per repeat, zero when done', () => {
    const b = { distance: 0.2, durationMs: 100, repeatCount: 2, easingType: 0 }
    expect(bounceTotalMs(b)).toBe(200)
    expect(bounceDisplacement(b, 0)).toBeCloseTo(0.2, 6)
    expect(bounceDisplacement(b, 100)).toBeCloseTo(0.1, 6) // second repeat starts at half
    expect(bounceDisplacement(b, 200)).toBe(0)
  })

  it('note fade: the engine curves, sides as a share of the note, overlong sides split evenly', () => {
    expect(fadeBezier(0.5, [0, 0, 1, 1])).toBeCloseTo(0.5, 3) // Linear
    expect(sidePercent({ mode: 1, divisionDenominator: 4 }, 1, 120)).toBe(100) // one beat on a one-beat note
    expect(sidePercent({ mode: 2, ms: 250 }, 1, 120)).toBeCloseTo(50, 6) // 250 ms of a 500 ms note
    const nf = { fadeIn: { mode: 0, percent: 10, curve: 0 }, fadeOut: { mode: 0, percent: 20, curve: 0 } }
    expect(noteFadeGain(nf, 0, 1, 120)).toBe(0)
    expect(noteFadeGain(nf, 0.05, 1, 120)).toBeCloseTo(0.5, 2)
    expect(noteFadeGain(nf, 0.5, 1, 120)).toBe(1)
    expect(noteFadeGain(nf, 0.9, 1, 120)).toBeCloseTo(0.5, 2)
    const both = { fadeIn: { mode: 0, percent: 100 }, fadeOut: { mode: 0, percent: 100 } }
    expect(noteFadeGain(both, 0.25, 1, 120)).toBeCloseTo(0.5, 2) // each side normalised to 50 %
  })
})

describe('per-note devices', () => {
  it('pins the per-note group at the chain start in the fixed order', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    expect(devices()).toEqual(['Ping-pong loop device', 'Bounce device', 'Note fade device'])
    expect(container.querySelector('[data-testid="xleth-video-note-group"]')).toBeTruthy()
  })

  it('the activator writes enabled through the existing setter, and the device stays', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    act(() => container.querySelector('button[aria-label="Bounce on"]').click())
    await flush()
    expect(timeline.setTrackBounceSettings).toHaveBeenCalledWith(7, { ...track.bounce, enabled: false })
    expect(useVideoDeviceStore.getState().shown[7]).toContain('bounce')
  })

  it('bounce direction is one click, one write', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    await pick(section('Bounce'), 'Bounce direction', 'Up')
    expect(timeline.setTrackBounceSettings).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackBounceSettings.mock.calls[0][1].directionDeg).toBe(90)
  })

  it('ping-pong end snaps to 100 % like the old slider', async () => {
    track.pingPong.regionEndPct = 0.97
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    nudge(slider('End', section('Ping-pong')))
    await flush()
    expect(timeline.setTrackPingPongSettings).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackPingPongSettings.mock.calls[0][1].regionEndPct).toBe(1)
  })

  it('note fade: one side edited, the whole object sent, the other side untouched', async () => {
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    await pick(section('Note fade'), 'Fade in length mode', 'Note division')
    expect(timeline.setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true,
      fadeIn: { ...track.noteFade.fadeIn, mode: 1 },
      fadeOut: track.noteFade.fadeOut,
    })
  })

  it('note fade offers 1/64 to one beat and sends the denominator, not an index', async () => {
    track.noteFade.fadeIn.mode = 1
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    await pick(section('Note fade'), 'Fade in note division', '1/4 (1 beat)')
    expect(timeline.setTrackNoteFade.mock.calls[0][1].fadeIn.divisionDenominator).toBe(4)
  })

  it('adding note fade on a track without one sends the engine defaults', async () => {
    delete track.noteFade
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    act(() => container.querySelector('button[data-hint^="Add a video effect"]').click())
    const perNote = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.includes('Per note'))
    act(() => perNote.click())
    const add = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')).find((el) => el.textContent.trim() === 'Note fade')
    act(() => add.click())
    await flush()
    const def = { mode: 0, percent: 10, divisionDenominator: 16, ms: 60, curve: 0 }
    expect(timeline.setTrackNoteFade).toHaveBeenCalledWith(7, { enabled: true, fadeIn: def, fadeOut: def })
  })

  it('the slide note effect has no on/off activator: its type is the switch', async () => {
    track.slideNoteEffect = { type: 2, bounce: { directionDeg: 90, distance: 0.3 } }
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    const activator = container.querySelector('button[aria-label="Slide note effect on"]')
    expect(activator.disabled).toBe(true)
    await pick(section('Slide note effect'), 'Slide note effect', 'TV')
    expect(timeline.setTrackSlideNoteEffect).toHaveBeenCalledWith(7, { ...track.slideNoteEffect, type: 3 })
  })

  it('no native range inputs and no mono number fields', async () => {
    track.slideNoteEffect = { type: 3 }
    act(() => root.render(<VideoDeviceChain />))
    await flush()
    expect(container.querySelector('input[type="range"]')).toBeNull()
    expect(container.querySelector('input[type="number"]')).toBeNull()
  })
})

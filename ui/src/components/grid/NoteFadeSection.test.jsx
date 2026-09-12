// @vitest-environment jsdom
//
// NoteFadeSection — the Pattern-track-only automatic per-note video fade panel.
//
// What is worth locking down here is the CONTRACT with the engine, not the
// layout: the enum values the section sends (NoteFadeSettings::LengthMode and
// ::Curve), the division denominators (engine reads them as 4/D beats, so the
// list and its orientation matter), and the fact that editing one side never
// clobbers the other. All of those are silently swallowed by optional chaining
// in the renderer if they drift, which is exactly what this catches.
//
// Section VISIBILITY (Pattern tracks only) is owned by the two callers —
// TrackCard and TrackVideoProperties — and asserted where they gate it.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import NoteFadeSection from './NoteFadeSection.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Mirrors NoteFadeSettings::Side's field initialisers in the engine.
const DEFAULT_SIDE = {
  mode: 0,
  percent: 10,
  divisionDenominator: 16,
  ms: 60,
  curve: 0,
}

const track = (noteFade) => ({ id: 7, name: 'Pat', type: 'Pattern', noteFade })

let container, root, setTrackNoteFade, fetchTracks

async function flush() { await act(async () => { await Promise.resolve() }) }

async function render(trackObj) {
  await act(async () => {
    root.render(<NoteFadeSection track={trackObj} fetchTracks={fetchTracks} />)
  })
  await flush()
}

const enableCheckbox = () =>
  container.querySelector('.grid-tab-notefade-enable input[type=checkbox]')

// XlethSelect portals its listbox to document.body, so the option buttons are
// never inside `container`.
async function openSelect(ariaLabel) {
  const trigger = Array.from(container.querySelectorAll('button'))
    .find(b => b.getAttribute('aria-label') === ariaLabel)
  expect(trigger, `select "${ariaLabel}" exists`).toBeTruthy()
  await act(async () => { trigger.click() })
  await flush()
  return Array.from(document.body.querySelectorAll('[role=option]'))
}

async function pickOption(ariaLabel, label) {
  const options = await openSelect(ariaLabel)
  const option = options.find(o => o.textContent.trim() === label)
  expect(option, `option "${label}" exists in "${ariaLabel}"`).toBeTruthy()
  await act(async () => { option.click() })
  await flush()
}

const labelTexts = () =>
  Array.from(container.querySelectorAll('.grid-tab-slide-params label'))
    .map(l => l.textContent.trim())

describe('NoteFadeSection', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
    setTrackNoteFade = vi.fn().mockResolvedValue(true)
    fetchTracks = vi.fn()
    window.xleth = { timeline: { setTrackNoteFade } }
  })
  afterEach(() => {
    act(() => root.unmount()); container.remove()
    vi.restoreAllMocks(); delete window.xleth
  })

  it('starts disabled and hides the fade controls until it is switched on', async () => {
    await render(track({ enabled: false, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    expect(enableCheckbox().checked).toBe(false)
    expect(container.querySelectorAll('.grid-tab-slide-params').length).toBe(0)
  })

  it('renders both sides once enabled', async () => {
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    expect(container.querySelectorAll('.grid-tab-slide-params').length).toBe(2)
    const subheads = Array.from(container.querySelectorAll('.grid-tab-notefade-subhead'))
      .map(el => el.textContent.trim())
    expect(subheads).toEqual(['Fade In', 'Fade Out'])
  })

  it('sends the whole object when the enable toggle flips', async () => {
    await render(track({ enabled: false, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    await act(async () => { enableCheckbox().click() })
    await flush()
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE,
    })
    expect(fetchTracks).toHaveBeenCalled()
  })

  // A track that has never been touched comes back from the engine with the
  // defaults, but the section must also survive a payload that predates the
  // field entirely rather than sending undefined into the engine.
  it('falls back to the engine defaults when the track has no noteFade', async () => {
    await render(track(undefined))
    await act(async () => { enableCheckbox().click() })
    await flush()
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE,
    })
  })

  it('offers exactly the three length modes, shortest-name first', async () => {
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    const options = await openSelect('Fade In length mode')
    expect(options.map(o => o.textContent.trim()))
      .toEqual(['Follow Note Length', 'Note Division', 'Milliseconds'])
  })

  it('shows Amount in Follow Note Length mode and sends mode 0', async () => {
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    expect(labelTexts()).toContain('Amount')
    expect(labelTexts()).not.toContain('Note')
    expect(labelTexts()).not.toContain('Time')
  })

  it('switches to the division picker and sends mode 1', async () => {
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    await pickOption('Fade In length mode', 'Note Division')
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 1 },
      fadeOut: DEFAULT_SIDE,
    })
  })

  it('switches to the ms input and sends mode 2', async () => {
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    await pickOption('Fade In length mode', 'Milliseconds')
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 2 },
      fadeOut: DEFAULT_SIDE,
    })
  })

  // The engine reads the denominator as 4/D BEATS, so a bigger number is a
  // SHORTER fade and D=4 is exactly one beat — the cap the feature offers.
  // Both the values and their order are part of that contract.
  it('offers 1/64 through one beat as note divisions', async () => {
    await render(track({
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 1 },
      fadeOut: DEFAULT_SIDE,
    }))
    expect(labelTexts()).toContain('Note')
    const options = await openSelect('Fade In note division')
    expect(options.map(o => o.textContent.trim()))
      .toEqual(['1/64', '1/32', '1/16', '1/8', '1/4 (1 beat)'])
    expect(options.map(o => o.getAttribute('data-value')))
      .toEqual(['64', '32', '16', '8', '4'])
  })

  it('sends the chosen denominator, not its index', async () => {
    await render(track({
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 1 },
      fadeOut: DEFAULT_SIDE,
    }))
    await pickOption('Fade In note division', '1/4 (1 beat)')
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 1, divisionDenominator: 4 },
      fadeOut: DEFAULT_SIDE,
    })
  })

  it('commits the ms field on blur', async () => {
    await render(track({
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 2 },
      fadeOut: DEFAULT_SIDE,
    }))
    const input = container.querySelector('.grid-tab-slide-param-input')
    expect(input).toBeTruthy()
    await act(async () => {
      input.value = '250'
      // React delegates onBlur off the bubbling `focusout`, not `blur`.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, mode: 2, ms: 250 },
      fadeOut: DEFAULT_SIDE,
    })
  })

  // The curve options are named for their shape near SILENCE because the engine
  // feeds the fade-out its bezier reversed; keeping both sides on one list is
  // what makes a single name mean one shape.
  it('offers the four shared curve shapes', async () => {
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: DEFAULT_SIDE }))
    const options = await openSelect('Fade Out curve')
    expect(options.map(o => o.textContent.trim()))
      .toEqual(['Linear', 'Smooth', 'Snappy', 'Gentle'])
  })

  it('editing one side leaves the other side untouched', async () => {
    const dialled = { mode: 2, percent: 55, divisionDenominator: 8, ms: 400, curve: 2 }
    await render(track({ enabled: true, fadeIn: DEFAULT_SIDE, fadeOut: dialled }))
    await pickOption('Fade In curve', 'Smooth')
    expect(setTrackNoteFade).toHaveBeenCalledWith(7, {
      enabled: true,
      fadeIn: { ...DEFAULT_SIDE, curve: 1 },
      fadeOut: dialled,
    })
  })
})

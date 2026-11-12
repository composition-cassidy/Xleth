/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no 2D canvas backend, so getContext('2d') returns null and the
// waveform thumbnail every layer card mounts throws on its first draw. A no-op
// context is enough: nothing here asserts on pixels.
HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (_t, prop) => (prop === 'canvas' ? null : () => undefined),
  set: () => true,
})

// The two new controls, ON SCREEN. A store that behaves perfectly while nothing
// renders satisfies neither of these:
//
//   1. Every layer card carries a Duplicate button wired to duplicateLayer.
//      Ctrl+D covers the keyboard, but a shortcut nobody can discover is not a
//      feature — the card is where it gets found.
//   2. A PITCH op's inline editor offers both modes and writes `mode` into the
//      op's params, and the stack row states the LENGTH change varispeed
//      causes. That length change is the whole difference between the two
//      modes, and the waveform alone does not announce it.

let useSandboxStore
let PITCH_MODE

function layer(overrides = {}) {
  return {
    id: 1, name: 'VOX', sourceBufferId: 5, bufferSampleRate: 48000,
    sourceFilePath: 'C:/audio/vox.wav', sourceStartTime: 0, sourceEndTime: 2,
    sourceRegionId: null, swapTargetName: null,
    ops: [], muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
    renderState: 'ready',
    renderedBuffer: { numChannels: 1, numSamples: 96000, sampleRate: 48000, channels: [] },
    refusedOps: 0, refusalReason: null,
    spectrogramState: 'idle', spectrogram: null,
    pitchTrackState: 'idle', pitchTrack: null,
    bakeState: 'idle', swapInState: 'idle', swapInError: null, lastSwap: null, error: null,
    ...overrides,
  }
}

// The component must be imported AFTER resetModules, in the same module graph
// as the store it will read — importing it earlier leaves it closed over the
// PREVIOUS test's store instance, which silently renders stale state.
async function mount(importComponent, state) {
  vi.resetModules()
  const mod = await import('../../../stores/sandboxStore.js')
  useSandboxStore = mod.default
  PITCH_MODE = mod.PITCH_MODE
  useSandboxStore.setState(state)
  const Component = (await importComponent()).default

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<Component />) })
  return { host, root }
}

function click(el) {
  return act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

afterEach(() => { document.body.innerHTML = '' })

const importLayerList = () => import('../SandboxLayerList.jsx')
const importStackPanel = () => import('../SandboxStackPanel.jsx')

// The layer list is a compact RAIL of one-line rows now, not a stack of cards
// in the sidebar (see SandboxLayerList.jsx) — the buttons moved, what they must do did
// not. Duplicate is asserted by its title rather than a bespoke class: the row
// buttons deliberately share one class, and a selector keyed on the tooltip is
// the one that actually says "the Duplicate button" rather than "the third
// button in the row".
function rowButton(host, pattern, index = 0) {
  return [...host.querySelectorAll('[data-layer-row] button')]
    .filter((b) => pattern.test(b.getAttribute('aria-label') || ''))[index]
}

describe('layer row Duplicate button', () => {
  it('renders on every row and calls duplicateLayer for that row', async () => {
    const duplicateLayer = vi.fn()
    const { host } = await mount(importLayerList, {
      layers: [layer(), layer({ id: 2, name: 'DRUMS' })],
      activeLayerId: null,
      duplicateLayer,
    })

    const buttons = [...host.querySelectorAll('[data-layer-row] button')]
      .filter((b) => /Duplicate this layer/.test(b.getAttribute('aria-label') || ''))
    expect(buttons).toHaveLength(2)
    // The tooltip has to say what "duplicate" actually carries, or the button
    // reads as "make an empty copy".
    expect(buttons[0].getAttribute('data-hint-mods')).toMatch(/Ctrl\+D/)

    await click(buttons[1])
    expect(duplicateLayer).toHaveBeenCalledWith(2)
  })

  it('does not also activate the row it sits on', async () => {
    const duplicateLayer = vi.fn()
    const setActiveLayer = vi.fn()
    const { host } = await mount(importLayerList, {
      layers: [layer()], activeLayerId: null, duplicateLayer, setActiveLayer,
    })

    await click(rowButton(host, /Duplicate this layer/))
    expect(duplicateLayer).toHaveBeenCalled()
    expect(setActiveLayer).not.toHaveBeenCalled()
  })

  // Phase 2: every row auditions its OWN layer without a composite render.
  // The button is disabled until that layer has actually published a render —
  // there is no PCM to play before then.
  it('auditions the row layer through toggleLayerPreview', async () => {
    const toggleLayerPreview = vi.fn()
    const { host } = await mount(importLayerList, {
      layers: [layer(), layer({ id: 2, name: 'DRUMS' })],
      activeLayerId: null,
      toggleLayerPreview,
    })

    await click(rowButton(host, /Audition this layer alone/, 1))
    expect(toggleLayerPreview).toHaveBeenCalledWith(2)
  })
})

describe('layer row mix controls', () => {
  // The mix values (gain, pan, offset) are the ACTIVE row's second line, with
  // visible labels — not five unlabelled boxes on every row.
  it('shows labelled mix boxes on the active layer only', async () => {
    const { host } = await mount(importLayerList, {
      layers: [layer(), layer({ id: 2, name: 'DRUMS' })],
      activeLayerId: 2,
    })

    const groups = [...host.querySelectorAll('[role="group"]')]
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('aria-label')).toBe('DRUMS mix')
    const sliders = [...groups[0].querySelectorAll('[role="slider"]')]
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual(['Layer gain', 'Layer pan', 'Layer offset'])
    expect(groups[0].textContent).toMatch(/Gain.*Pan.*Offset/)
  })

  it('keeps the output pearl on every row, where the state has to be visible at rest', async () => {
    const pearlLayer = vi.fn()
    const { host } = await mount(importLayerList, {
      layers: [layer(), layer({ id: 2, name: 'DRUMS', muted: true })],
      activeLayerId: 1,
      pearlLayer,
    })
    const pearls = [...host.querySelectorAll('[data-layer-row] button[aria-label$=" output"]')]
    // Lit = heard: the muted DRUMS layer's pearl is dark.
    expect(pearls.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    await click(pearls[0])
    expect(pearlLayer).toHaveBeenCalledWith(1, 'toggle')
  })
})

describe('action bar', () => {
  const importActionBar = () => import('../SandboxMenuBar.jsx')
  const action = (host, id) => host.querySelector(`button[data-action="${id}"]`)

  // The edits an audio editor is used for most are one click, on the bar,
  // rather than inside a menu in the far corner from the selection.
  it('offers the common edits as buttons that run the registry entry', async () => {
    const fadeSelection = vi.fn()
    const { host } = await mount(importActionBar, {
      layers: [layer()], activeLayerId: 1,
      selection: { startSample: 12000, endSample: 36000 },
      fadeSelection,
    })
    for (const id of ['trim', 'silence', 'fadeIn', 'fadeOut', 'gain', 'normalize', 'reverse']) {
      expect(action(host, id), id).toBeTruthy()
    }
    await click(action(host, 'fadeOut'))
    expect(fadeSelection).toHaveBeenCalledWith(1, false, 'equalPower')
  })

  it('disables an edit that needs a range, and says why in the hint bar', async () => {
    const { host } = await mount(importActionBar, {
      layers: [layer()], activeLayerId: 1,
      selection: { startSample: 24000, endSample: 24000 }, // a bare cursor
    })
    expect(action(host, 'trim').disabled).toBe(true)
    expect(action(host, 'trim').getAttribute('data-hint-mods')).toBe('Select a range first')
  })

  it('keeps the whole-layer edits live with only a cursor, and says what they will act on', async () => {
    const { host } = await mount(importActionBar, {
      layers: [layer()], activeLayerId: 1,
      selection: { startSample: 24000, endSample: 24000 },
    })
    expect(action(host, 'reverse').disabled).toBe(false)
    expect(action(host, 'reverse').getAttribute('data-hint-mods')).toMatch(/whole layer/)
    expect(action(host, 'fadeOut').disabled).toBe(false)
    expect(action(host, 'fadeOut').getAttribute('data-hint-mods')).toMatch(/from the cursor to the end/)
    expect(action(host, 'fadeIn').getAttribute('data-hint-mods')).toMatch(/from the start of the layer to the cursor/)
  })

  it('says a singleton is already in the stack instead of adding a second one', async () => {
    const { host } = await mount(importActionBar, {
      layers: [layer({ ops: [{ id: 5, type: 'gain', enabled: true, params: { normalize: true } }] })],
      activeLayerId: 1,
    })
    expect(action(host, 'normalize').disabled).toBe(true)
    expect(action(host, 'normalize').getAttribute('data-hint-mods')).toMatch(/Already in the edit stack/)
  })

  // The Effects menu lists what the bar does NOT have a button for. Repeating
  // all ten bar edits made it taller than the panel it opens in.
  it('does not repeat the bar buttons inside the Effects menu', async () => {
    const { host } = await mount(importActionBar, { layers: [layer()], activeLayerId: 1 })
    const effects = [...host.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Effects'))
    await click(effects)
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())
    expect(items).toEqual(expect.arrayContaining(['Splice', 'Crossfade', 'Insert silence', 'Pitch shift', 'Autotune']))
    for (const onBar of ['Trim', 'Cut', 'Fade in', 'Normalize', 'Reverse']) expect(items).not.toContain(onBar)
  })
})

describe('transport selection boxes', () => {
  const importTransport = () => import('../SandboxTransport.jsx')
  const box = (host, name) => host.querySelector(`[role="slider"][aria-label="${name}"]`)

  // The selection is three numbers you can read, drag and type — not a line of
  // read-only text. 96000 samples at 48 kHz: 0.25 s to 0.75 s.
  it('shows the selection start, end and length in seconds', async () => {
    const { host } = await mount(importTransport, {
      layers: [layer()], activeLayerId: 1,
      selection: { startSample: 12000, endSample: 36000 },
    })
    expect(box(host, 'Selection start').getAttribute('aria-valuetext')).toContain('0.250 s')
    expect(box(host, 'Selection end').getAttribute('aria-valuetext')).toContain('0.750 s')
    expect(box(host, 'Selection length').getAttribute('aria-valuetext')).toContain('0.500 s')
  })

  it('shows a bare cursor as a zero-length selection at the cursor, and the clock reads it', async () => {
    const { host } = await mount(importTransport, {
      layers: [layer()], activeLayerId: 1,
      selection: { startSample: 24000, endSample: 24000 },
    })
    expect(box(host, 'Selection start').getAttribute('aria-valuetext')).toContain('0.500 s')
    expect(box(host, 'Selection length').getAttribute('aria-valuetext')).toContain('0.000 s')
    expect(host.textContent).toContain('0:00.500')
  })

  it('disables the boxes until there is rendered audio to place a selection in', async () => {
    const { host } = await mount(importTransport, { layers: [], activeLayerId: null })
    expect(box(host, 'Selection start').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('PITCH op inline editor', () => {
  async function mountWithPitch(params) {
    const setOpParams = vi.fn()
    const ctx = await mount(importStackPanel, {
      layers: [layer({ ops: [{ id: 11, type: 'pitch', params, enabled: true }] })],
      activeLayerId: 1,
      setOpParams,
    })
    // The inline editor only renders under the SELECTED module.
    await click(ctx.host.querySelector('[data-op-row]'))
    return { ...ctx, setOpParams }
  }

  it('offers both modes and writes `mode` into the op params', async () => {
    const params = { cents: 0, formantPreserve: false, mode: 0 }
    const { host, setOpParams } = await mountWithPitch(params)

    // The mode picker is a kit Select: a listbox trigger, and its options open in a portal.
    const trigger = host.querySelector('[aria-label="Pitch mode"]')
    expect(trigger).toBeTruthy()
    await click(trigger)
    const options = [...document.body.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent.trim())).toEqual(['Preserve length', 'Varispeed (resample)'])

    await click(options.find((o) => /Varispeed/i.test(o.textContent)))
    expect(setOpParams).toHaveBeenCalledWith(1, 11, { ...params, mode: PITCH_MODE.resample })
  })

  it('disables Formant Lock in varispeed rather than hiding it', async () => {
    // Retained, not cleared, when the mode flips — so hiding it would make a
    // setting that is still there look erased.
    const { host } = await mountWithPitch({ cents: 700, formantPreserve: true, mode: 1 })

    const box = host.querySelector('input[type="checkbox"]')
    expect(box.disabled).toBe(true)
    expect(box.checked).toBe(true)
    expect(host.textContent).toContain('Formant lock')
  })

  it('states the length change on the stack row in varispeed, not just the cents', async () => {
    const { host } = await mountWithPitch({ cents: 1200, formantPreserve: false, mode: 1 })
    const row = host.querySelector('[data-op-params]').textContent
    expect(row).toMatch(/varispeed/i)
    expect(row).toMatch(/2\.000 speed/)   // +1 octave = twice as fast…
    expect(row).toMatch(/0\.500 length/)  // …and half as long
  })

  it('says nothing about length in preserve mode, because there is none', async () => {
    const { host } = await mountWithPitch({ cents: 1200, formantPreserve: true, mode: 0 })
    const row = host.querySelector('[data-op-params]').textContent
    expect(row).not.toMatch(/varispeed|length/i)
    expect(row).toMatch(/formant lock/)
  })
})

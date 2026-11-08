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

const importWorkspace = () => import('../SandboxLayerWorkspace.jsx')
const importStackPanel = () => import('../SandboxStackPanel.jsx')

// The layer list is a compact RAIL of one-line rows now, not a stack of cards
// (see SandboxLayerWorkspace.jsx) — the buttons moved, what they must do did
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
    const { host } = await mount(importWorkspace, {
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
    const { host } = await mount(importWorkspace, {
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
    const { host } = await mount(importWorkspace, {
      layers: [layer(), layer({ id: 2, name: 'DRUMS' })],
      activeLayerId: null,
      toggleLayerPreview,
    })

    await click(rowButton(host, /Audition this layer alone/, 1))
    expect(toggleLayerPreview).toHaveBeenCalledWith(2)
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

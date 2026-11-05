/**
 * @vitest-environment jsdom
 *
 * The peaks fetch used to poll forever. Two independent faults stacked:
 *
 *   1. waveform_getRegionPeaks answers `ready:false` both for "the mipmap is
 *      still generating" and for "this slot has no audio mapped at all". The
 *      component read every not-ready as the first case and retried at 150ms,
 *      so an empty slot polled for the life of the panel.
 *   2. The `timeline-sampler-changed` handler built its own `{cancelled}`
 *      token that no cleanup path could reach, so every such event left an
 *      immortal chain behind — they stack, and unmount does not stop them.
 *
 * Observed live: six concurrent chains against one region, ~40 RPCs/sec,
 * indefinitely. These tests pin all three guarantees.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../../../timelineEvents.js'
import SamplerWaveform from '../SamplerWaveform.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no 2D canvas backend; the component draws on every state change.
HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (_t, prop) => (prop === 'canvas' ? null : () => undefined),
  set: () => true,
})

let container
let root
let getRegionPeaks

// Drain the microtask queue AND any timers that are due, repeatedly — one
// retry hop is `await rpc` then `setTimeout`, so both have to run to advance.
async function advance(ms) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mount(props = {}) {
  act(() => {
    root.render(
      <SamplerWaveform regionId={19} slotIndex={1} numSamples={0} {...props} />)
  })
}

function stubRpc(impl) {
  getRegionPeaks = vi.fn(impl)
  window.xleth = { waveform: { getRegionPeaks } }
}

describe('SamplerWaveform peaks retry', () => {
  it('stops immediately when the engine says the slot is unmapped', async () => {
    // The exact shape the engine returns for sampleBankId < 0.
    stubRpc(async () => ({
      peaks: [], needsRawSamples: false, ready: false, mapped: false,
      sampleRate: 0, totalSamples: 0,
    }))
    mount()
    await advance(0)
    const afterFirst = getRegionPeaks.mock.calls.length

    await advance(10_000)
    expect(getRegionPeaks.mock.calls.length).toBe(afterFirst)
  })

  it('gives up eventually when `mapped` is absent (addon predating the flag)', async () => {
    stubRpc(async () => ({
      peaks: [], needsRawSamples: false, ready: false,
      sampleRate: 0, totalSamples: 0,
    }))
    mount()
    await advance(0)

    // Long enough to exhaust the budget several times over if it were uncapped.
    for (let i = 0; i < 60; i++) await advance(1000)
    const settled = getRegionPeaks.mock.calls.length

    await advance(30_000)
    expect(getRegionPeaks.mock.calls.length).toBe(settled)
    expect(settled).toBeLessThan(40)
  })

  it('does not stack a new immortal chain per timeline-sampler-changed', async () => {
    stubRpc(async () => ({
      peaks: [], needsRawSamples: false, ready: false,
      sampleRate: 0, totalSamples: 0,
    }))
    mount()
    await advance(0)

    // Six events — the count seen in the live log.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed',
          { detail: { regionId: 19 } }))
        await Promise.resolve()
      })
    }

    getRegionPeaks.mockClear()
    await advance(600)
    // One live chain polls at most a handful of times in 600ms. Six stacked
    // chains at the old 150ms cadence would be ~24.
    expect(getRegionPeaks.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('issues no further calls after unmount', async () => {
    stubRpc(async () => ({
      peaks: [], needsRawSamples: false, ready: false,
      sampleRate: 0, totalSamples: 0,
    }))
    mount()
    await advance(0)
    await act(async () => {
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed',
        { detail: { regionId: 19 } }))
      await Promise.resolve()
    })

    act(() => root.unmount())
    getRegionPeaks.mockClear()
    await advance(10_000)
    expect(getRegionPeaks).not.toHaveBeenCalled()

    root = createRoot(container)  // so afterEach's unmount is a no-op
  })

  it('still retries and recovers while a mipmap is genuinely generating', async () => {
    let calls = 0
    stubRpc(async () => {
      calls++
      if (calls < 3) {
        return { peaks: [], needsRawSamples: false, ready: false,
                 sampleRate: 0, totalSamples: 0 }
      }
      return {
        peaks: new Float32Array([-0.5, 0.5, 0.3]),
        needsRawSamples: false, ready: true, mapped: true,
        sampleRate: 44100, totalSamples: 65023,
      }
    })
    mount()
    await advance(0)
    await advance(200)
    await advance(200)
    expect(calls).toBeGreaterThanOrEqual(3)

    // Once ready, it settles — no further polling.
    const settled = getRegionPeaks.mock.calls.length
    await advance(5000)
    expect(getRegionPeaks.mock.calls.length).toBe(settled)
  })
})

/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENV_HIT_R, envDbToY, envYToDb, envelopeTargetAt, hitEnvelopeHandle,
} from '../sandboxEnvelopeHit.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The Envelope tool: pressing an existing breakpoint must GRAB it.
//
// It did not. The canvas hit-tested handles through a callback that had kept
// the sample→x mapping from its first render — taken before the layer's audio
// had arrived, when the view is zero samples wide — so no handle was ever
// found. Every press on the line added another breakpoint, right-click never
// found one to delete, and the curve could only grow.
//
// Two halves: the geometry on its own (pure), and the canvas component mounted
// the way the app mounts it — BEFORE the render arrives — which is the half
// that actually catches the bug.

const W = 1000
const H = 400
const N = 48000 // one second at 48 kHz
// Fitted view: sample s sits at x = s / N * w.
const s2x = (sample, w) => (sample / N) * w
const x2s = (px, w) => Math.round((px / w) * N)

const POINTS = [
  { samplePos: 0, db: 0 },
  { samplePos: 24000, db: -12 },
  { samplePos: 47999, db: 0 },
]
const at = (samplePos, db, dx = 0, dy = 0) => ({ x: s2x(samplePos, W) + dx, y: envDbToY(db, H) + dy, w: W, h: H })

describe('envelope hit-testing', () => {
  it('maps dB to pixels and back', () => {
    expect(envDbToY(12, H)).toBe(0)
    expect(envDbToY(-60, H)).toBe(H)
    expect(envYToDb(envDbToY(-12, H), H)).toBeCloseTo(-12, 6)
  })

  it('finds the handle under the pointer, within the grab radius', () => {
    expect(hitEnvelopeHandle(POINTS, at(24000, -12), s2x)).toBe(1)
    expect(hitEnvelopeHandle(POINTS, at(24000, -12, ENV_HIT_R - 1, 0), s2x)).toBe(1)
    expect(hitEnvelopeHandle(POINTS, at(24000, -12, ENV_HIT_R + 2, 0), s2x)).toBe(-1)
  })

  it('picks the NEAREST of two overlapping handles, not the first in the list', () => {
    // 6px apart: each sits inside the other's 8px radius.
    const close = [{ samplePos: 24000, db: -12 }, { samplePos: 24288, db: -12 }]
    expect(hitEnvelopeHandle(close, at(24288, -12, 1, 0), s2x)).toBe(1)
    expect(hitEnvelopeHandle(close, at(24000, -12, -1, 0), s2x)).toBe(0)
  })

  it('tells a handle from the bare line from empty space', () => {
    const maps = { s2x, x2s }
    expect(envelopeTargetAt(POINTS, at(24000, -12), maps)).toEqual({ kind: 'handle', index: 1 })

    // Halfway between the first two breakpoints, on the curve (interpolated in dB: -6).
    const onLine = envelopeTargetAt(POINTS, at(12000, -6), maps)
    expect(onLine.kind).toBe('line')
    expect(onLine.sample).toBe(12000)
    expect(onLine.db).toBeCloseTo(-6, 3)

    // Well below the curve: the press belongs to the selection.
    expect(envelopeTargetAt(POINTS, at(12000, -40), maps)).toEqual({ kind: 'none' })
  })

  it('treats an empty curve as a flat unity line that can be pressed', () => {
    const target = envelopeTargetAt([], at(12000, 0), { s2x, x2s })
    expect(target.kind).toBe('line')
    expect(target.db).toBeCloseTo(0, 6)
  })
})

describe('Envelope tool on the canvas', () => {
  let useSandboxStore
  let host
  let root
  let setGainEnvelope

  function layer(overrides = {}) {
    return {
      id: 1, name: 'VOX', sourceBufferId: 5, bufferSampleRate: 48000,
      ops: [{ id: 7, type: 'gainEnvelope', enabled: true, params: { mode: 0, points: POINTS } }],
      muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
      renderState: 'rendering', renderedBuffer: null,
      spectrogramState: 'idle', spectrogram: null, pitchTrackState: 'idle', pitchTrack: null,
      ...overrides,
    }
  }

  const BUFFER = { numChannels: 1, numSamples: N, sampleRate: 48000, channels: [new Float32Array(N)] }

  beforeEach(async () => {
    vi.resetModules()
    // jsdom has no canvas backend, no layout and no ResizeObserver. Give the
    // component a no-op context and a fixed 1000x400 box for every canvas.
    HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
      get: (_t, prop) => (prop === 'canvas' ? null : prop === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    })
    HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
      left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0, toJSON: () => ({}),
    })
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

    useSandboxStore = (await import('../../../stores/sandboxStore.js')).default
    setGainEnvelope = vi.fn()
    // Mounted the way the app mounts it: the layer exists, its audio does not yet.
    useSandboxStore.setState({
      layers: [layer()], activeLayerId: 1, envelopeEditMode: true, selection: null, view: null, setGainEnvelope,
    })
    const Canvas = (await import('../SandboxWaveformCanvas.jsx')).default
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(<Canvas />) })
    // ...and then the render arrives.
    await act(async () => {
      useSandboxStore.setState({ layers: [layer({ renderState: 'ready', renderedBuffer: BUFFER })] })
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const envCanvas = () => host.querySelector('canvas[data-sandbox-canvas="envelope"]')
  const mouse = (target, type, pos, init = {}) => act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: pos.x, clientY: pos.y, button: 0, ...init }))
  })

  it('a press on an existing breakpoint grabs it instead of adding another', async () => {
    await mouse(envCanvas(), 'mousedown', at(24000, -12))
    await mouse(window, 'mouseup', at(24000, -12))

    expect(setGainEnvelope).toHaveBeenCalledTimes(1)
    const committed = setGainEnvelope.mock.calls[0][1]
    expect(committed).toHaveLength(POINTS.length) // not POINTS.length + 1
  })

  it('dragging a breakpoint moves that breakpoint', async () => {
    await mouse(envCanvas(), 'mousedown', at(24000, -12))
    await mouse(window, 'mousemove', at(30000, -24))
    await mouse(window, 'mouseup', at(30000, -24))

    const committed = setGainEnvelope.mock.calls[0][1]
    expect(committed).toHaveLength(3)
    expect(committed[1].samplePos).toBe(30000)
    expect(committed[1].db).toBeCloseTo(-24, 3)
    // Its neighbours did not move.
    expect(committed[0]).toEqual(POINTS[0])
    expect(committed[2]).toEqual(POINTS[2])
  })

  it('a press on the bare line adds exactly one breakpoint there', async () => {
    await mouse(envCanvas(), 'mousedown', at(12000, -6))
    await mouse(window, 'mouseup', at(12000, -6))

    const committed = setGainEnvelope.mock.calls[0][1]
    expect(committed).toHaveLength(4)
    expect(committed[1].samplePos).toBe(12000)
  })

  it('right-click on a breakpoint deletes it', async () => {
    await mouse(envCanvas(), 'contextmenu', at(24000, -12), { button: 2 })
    expect(setGainEnvelope).toHaveBeenCalledWith(1, [POINTS[0], POINTS[2]])
  })

  it('right-click away from any breakpoint deletes nothing', async () => {
    await mouse(envCanvas(), 'contextmenu', at(12000, -6), { button: 2 })
    expect(setGainEnvelope).not.toHaveBeenCalled()
  })

  it('the cursor says what a press will do: grab a breakpoint, add on the line, select elsewhere', async () => {
    await mouse(envCanvas(), 'mousemove', at(24000, -12))
    expect(envCanvas().style.cursor).toBe('grab')
    await mouse(envCanvas(), 'mousemove', at(12000, -6))
    expect(envCanvas().style.cursor).toBe('copy')
    await mouse(envCanvas(), 'mousemove', at(12000, -40))
    expect(envCanvas().style.cursor).toBe('text')
  })

  it('still grabs the right breakpoint after zooming in', async () => {
    // View the middle half: 12000..36000. Sample 24000 is now at the centre, x = 500.
    await act(async () => { useSandboxStore.setState({ view: { startSample: 12000, endSample: 36000 } }) })
    const centre = { x: 500, y: envDbToY(-12, H) }
    await mouse(envCanvas(), 'mousedown', centre)
    await mouse(window, 'mouseup', centre)
    expect(setGainEnvelope.mock.calls[0][1]).toHaveLength(3)
  })
})

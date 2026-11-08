/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useWaveshaperStore from '../../../stores/waveshaperStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import WaveshaperPanel from '../../mixer/WaveshaperPanel.jsx'
import DeviceChain from '../DeviceChain.jsx'
import { deviceBodyFor } from '../deviceRegistry.js'
import {
  applySnap, clampBetweenNeighbours, curveSamples, isEndPoint, splineSamples,
} from '../waveshaperCurve.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN = [{ nodeId: 7, pluginId: 'waveshaper', position: 0, bypassed: false }]
const params = (over = {}) => JSON.stringify(Object.entries({
  pregain: 6, postgain: -3, mix: 80, preset: 0, ...over,
}).map(([id, value]) => ({ id, value })))

let container
let root
let audio
let curve

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const q = (sel) => container.querySelector(sel)
const slider = (label) => q(`[role="slider"][aria-label="${label}"]`)
const aria = (label) => slider(label)?.getAttribute('aria-valuetext')
const titles = () => Array.from(container.querySelectorAll('[role="heading"][aria-level="3"]')).map((h) => h.textContent)
const wsWrites = () => audio.wsSetCurvePoints.mock.calls.map((c) => JSON.parse(c[2]))
const toggle = (label) => Array.from(container.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent === label)

// A 252 x 204 well: the plot is the 174px square at x 47..221, y 10..184.
const px = (a) => 47 + ((a + 1) / 2) * 174
const py = (a) => 10 + (1 - (a + 1) / 2) * 174

function paintable() {
  const noop = () => {}
  const ctx = new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : (p === 'measureText' ? () => ({ width: 0 }) : noop)),
    set: (t, p, v) => { t[p] = v; return true },
  })
  HTMLCanvasElement.prototype.getContext = () => ctx
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 252 })
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 204 })
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 252, height: 204, right: 252, bottom: 204 })
}
const fire = (el, type, x, y, button = 0) => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }))
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  curve = [[-1, -1], [0, 0], [1, 1]]
  audio = {
    getEffectChain: vi.fn(async () => JSON.stringify(CHAIN)),
    getEffectParameters: vi.fn(async () => params()),
    setEffectParameter: vi.fn(),
    getEffectMeter: vi.fn(async () => []),
    setEffectBypass: vi.fn(async () => true),
    wsGetCurvePoints: vi.fn(async () => JSON.stringify(curve)),
    wsSetCurvePoints: vi.fn(async (t, n, json) => { curve = JSON.parse(json) }),
    wsSetPreset: vi.fn(async () => true),
  }
  window.xleth = { audio, timeline: { getTracks: async () => [] } }
  useEffectChainStore.setState({ chains: {}, fxModes: {} })
  useMixerStore.setState({ selectedChainKey: '3', tracks: { 3: { id: 3, name: 'Bus' } } })
  useWaveshaperStore.setState({ target: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
  delete HTMLCanvasElement.prototype.clientWidth
  delete HTMLCanvasElement.prototype.clientHeight
})

async function mountChain() {
  act(() => root.render(<DeviceChain />))
  await flush()
  await flush()
}

describe('Waveshaper curve maths', () => {
  it('the spline passes through every control point', () => {
    const pts = [[-1, -1], [-0.3, 0.4], [0.2, -0.2], [1, 1]]
    const s = splineSamples(pts)
    for (const [x, y] of pts) {
      const near = s.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best))
      expect(Math.abs(near[1] - y)).toBeLessThan(0.02)
    }
    expect(s.every(([, y]) => y >= -1 && y <= 1)).toBe(true)
  })

  it('two points are a straight line, and Smooth off is the points themselves', () => {
    expect(splineSamples([[-1, -1], [1, 1]])).toEqual([[-1, -1], [1, 1]])
    expect(curveSamples([[1, 1], [-1, -1], [0, 0.5]], false)).toEqual([[-1, -1], [0, 0.5], [1, 1]])
  })

  it('snap pulls a coordinate onto zero inside the threshold only', () => {
    expect(applySnap(0.05, -0.04, true)).toEqual([0, 0])
    expect(applySnap(0.07, 0.5, true)).toEqual([0.07, 0.5])
    expect(applySnap(0.05, 0.05, false)).toEqual([0.05, 0.05])
  })

  it('a dragged point stays between its neighbours', () => {
    const pts = [[-1, -1], [0, 0], [0.5, 0.5], [1, 1]]
    expect(clampBetweenNeighbours(pts, 1, 0.9)).toBeLessThan(0.5)
    expect(clampBetweenNeighbours(pts, 1, -0.9)).toBeGreaterThan(-1)
    expect(clampBetweenNeighbours(pts, 0, -5)).toBe(-1)
    expect(isEndPoint(pts, 0)).toBe(true)
    expect(isEndPoint(pts, 1)).toBe(false)
  })
})

describe('Waveshaper device in the chain', () => {
  it('is registered', () => {
    expect(deviceBodyFor('waveshaper')).not.toBeNull()
  })

  it('hydrates from the engine; every value prints through formatValue', async () => {
    await mountChain()
    expect(audio.getEffectParameters).toHaveBeenCalledWith(3, 7)
    expect(audio.wsGetCurvePoints).toHaveBeenCalledWith(3, 7)
    expect(aria('Pre gain')).toBe('Pre gain, 6.0 dB')
    expect(aria('Post gain')).toBe('Post gain, −3.0 dB')
    expect(aria('Mix')).toBe('Mix, 80 %')
    expect(container.textContent).toContain('3 points')
  })

  it('sections: Shape, Point, Input, Output after the curve well; no oversampling, no range switch', async () => {
    await mountChain()
    const t = titles()
    expect(['Shape', 'Point', 'Input', 'Output'].map((n) => t.indexOf(n))).toEqual([0, 1, 2, 3])
    expect(q('[role="group"][aria-label="Waveshaper curve"]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/oversampl|unipolar|bipolar/i)
  })

  it('the preset select lists Custom (not pickable) and the five shapes; picking one writes wsSetPreset', async () => {
    await mountChain()
    const trigger = q('[aria-label="Waveshaper shape"]')
    expect(trigger.textContent).toContain('Custom')
    act(() => trigger.click())
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    expect(options.map((o) => o.textContent)).toEqual(['Custom', 'Soft clip', 'Hard clip', 'Tube', 'Fold', 'Rectify'])
    act(() => options[3].click())
    expect(audio.wsSetPreset).toHaveBeenCalledWith(3, 7, 3)
  })

  it('a gain nudge writes the engine', async () => {
    await mountChain()
    act(() => { slider('Pre gain').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    const calls = audio.setEffectParameter.mock.calls.filter((c) => c[2] === 'pregain')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].slice(0, 2)).toEqual([3, 7])
    expect(calls[calls.length - 1][3]).toBeGreaterThan(6)
  })

  it('the four edit flags are toggles, Show input and Smooth curve on by default', async () => {
    await mountChain()
    expect(toggle('Snap zero').getAttribute('aria-pressed')).toBe('false')
    expect(toggle('Lock ends').getAttribute('aria-pressed')).toBe('false')
    expect(toggle('Show input').getAttribute('aria-pressed')).toBe('true')
    expect(toggle('Smooth curve').getAttribute('aria-pressed')).toBe('true')
  })

  it('pop-out opens the floating window and the docked slot becomes a strip', async () => {
    act(() => root.render(<><DeviceChain /><WaveshaperPanel /></>))
    await flush()
    act(() => q('button[aria-label="Open Waveshaper in a window"]').click())
    await flush()
    expect(useWaveshaperStore.getState().target).toEqual({ trackId: 3, nodeId: 7, storeKey: '3' })
    expect(q('[data-testid="waveshaper-window"] section').getAttribute('data-presentation')).toBe('floating')
    act(() => q('button[aria-label="Close Waveshaper"]').click())
    expect(useWaveshaperStore.getState().target).toBeNull()
  })
})

describe('Waveshaper curve editing', () => {
  it('dragging a point previews locally and writes the curve once, on release', async () => {
    paintable()
    await mountChain()
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(0), py(0)) })
    await act(async () => { fire(canvas, 'pointermove', px(0.2), py(0.3)) })
    await act(async () => { fire(canvas, 'pointermove', px(0.4), py(0.6)) })
    expect(audio.wsSetCurvePoints).not.toHaveBeenCalled()
    await act(async () => { fire(canvas, 'pointerup', px(0.4), py(0.6)) })
    await flush()
    expect(audio.wsSetCurvePoints).toHaveBeenCalledTimes(1)
    const [pts] = wsWrites()
    expect(pts).toHaveLength(3)
    expect(pts[1][0]).toBeCloseTo(0.4, 1)
    expect(pts[1][1]).toBeCloseTo(0.6, 1)
  })

  it('a click on a point only selects it; nothing is written', async () => {
    paintable()
    await mountChain()
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(0), py(0)) })
    await act(async () => { fire(canvas, 'pointerup', px(0), py(0)) })
    expect(audio.wsSetCurvePoints).not.toHaveBeenCalled()
    // ...and its values are now typeable.
    expect(slider('In').getAttribute('aria-valuetext')).toBe('In, 0.000')
  })

  it('a click on empty ground adds a point there', async () => {
    paintable()
    await mountChain()
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(0.5), py(-0.5)) })
    await act(async () => { fire(canvas, 'pointerup', px(0.5), py(-0.5)) })
    await flush()
    const [pts] = wsWrites()
    expect(pts).toHaveLength(4)
    expect(pts.some(([x, y]) => Math.abs(x - 0.5) < 0.02 && Math.abs(y + 0.5) < 0.02)).toBe(true)
  })

  it('right-click removes a point, but never below two', async () => {
    paintable()
    await mountChain()
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(0), py(0), 2) })
    await flush()
    expect(wsWrites()[0]).toHaveLength(2)
    await act(async () => { fire(canvas, 'pointerdown', px(1), py(1), 2) })
    await flush()
    expect(audio.wsSetCurvePoints).toHaveBeenCalledTimes(1)
  })

  it('a typed Out value moves the selected point (the alternative to dragging)', async () => {
    paintable()
    await mountChain()
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(0), py(0)) })
    await act(async () => { fire(canvas, 'pointerup', px(0), py(0)) })
    await act(async () => { slider('Out').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    await flush()
    const [pts] = wsWrites()
    expect(pts[1][0]).toBe(0)
    expect(pts[1][1]).toBeGreaterThan(0)
  })

  it('arrow keys on the canvas nudge the selected point; Delete removes it', async () => {
    paintable()
    await mountChain()
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(0), py(0)) })
    await act(async () => { fire(canvas, 'pointerup', px(0), py(0)) })
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await flush()
    expect(wsWrites()[0][1][0]).toBeCloseTo(0.01, 3)
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    await flush()
    expect(wsWrites()[1]).toHaveLength(2)
  })

  it('Lock ends pins the end points', async () => {
    paintable()
    await mountChain()
    act(() => toggle('Lock ends').click())
    const canvas = q('canvas[role="application"]')
    await act(async () => { fire(canvas, 'pointerdown', px(1), py(1)) })
    await act(async () => { fire(canvas, 'pointermove', px(0.5), py(0.2)) })
    await act(async () => { fire(canvas, 'pointerup', px(0.5), py(0.2)) })
    await flush()
    expect(audio.wsSetCurvePoints).not.toHaveBeenCalled()
  })
})

describe('Waveshaper: the legacy panel is gone', () => {
  it('thin wrapper, no SVG editor, no ws- CSS', () => {
    const src = readFileSync(path.resolve(__dirname, '../../mixer/WaveshaperPanel.jsx'), 'utf8')
    expect(src).not.toMatch(/<svg|splinePath|ShapeDropdown|ws-panel-header/)
    const css = readFileSync(path.resolve(__dirname, '../../../styles/app.css'), 'utf8')
    expect(css).not.toMatch(/\.ws-/)
  })
})

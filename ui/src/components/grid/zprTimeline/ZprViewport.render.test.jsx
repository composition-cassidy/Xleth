/**
 * @vitest-environment jsdom
 *
 * Mounts the REAL ZprTimelineCard (viewport + inspector + keyframe timeline)
 * against a stubbed window.xleth and drives the canvas with pointer events.
 *
 * Covers the three contracts the viewport exists to satisfy:
 *   1. a rect edit at the playhead creates keyframes on the AFFECTED channels
 *      only, and commits exactly once,
 *   2. nothing reaches IPC while the pointer is down,
 *   3. a rotation drag past a full turn stores >360 rather than wrapping.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ZprTimelineCard from './ZprTimelineCard.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const gradient = { addColorStop: () => {} }
const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    return () => gradient
  },
})

// Mirrors ZprViewport's own layout math so the test can aim at real geometry.
// width falls back to the component's 360 default (the ResizeObserver stub in
// test-setup.js never fires), cellAspect to 16/9 (no grid slot in the stub).
const W = 360
const CELL_ASPECT = 16 / 9
const H = Math.round(Math.min(340, Math.max(190, W / CELL_ASPECT * 1.3)))
const STAGE = (() => {
  const availW = W * 0.7, availH = H * 0.7
  let w = availW, h = w / CELL_ASPECT
  if (h > availH) { h = availH; w = h * CELL_ASPECT }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h }
})()
const uvToPx = (u, v) => ({ x: STAGE.x + u * STAGE.w, y: STAGE.y + v * STAGE.h })
const STEM_UV = 26 / Math.min(STAGE.w, STAGE.h)

// MouseEventInit.clientX/Y are WebIDL `long`, so jsdom truncates whatever it is
// handed. Truncate here too and derive the expected values from the SAME
// integers the component will see, instead of from the ideal float position.
const px = (u, v) => {
  const p = uvToPx(u, v)
  return { x: Math.trunc(p.x), y: Math.trunc(p.y) }
}
const uvOf = (p) => ({ u: (p.x - STAGE.x) / STAGE.w, v: (p.y - STAGE.y) / STAGE.h })

const EMPTY_TRACK = () => ({ constantValue: 0, keys: [] })
const emptyTracks = () => ({
  panX: EMPTY_TRACK(), panY: EMPTY_TRACK(),
  zoomLog2: EMPTY_TRACK(), rotationDeg: EMPTY_TRACK(),
})

let container = null
let root = null
let applied = []

function installXleth() {
  globalThis.window.xleth = {
    getTransportState: async () => ({ bpm: 120, isPlaying: false, positionBeats: 0 }),
    timeline: {
      getGridLayout: async () => ({
        columns: 2, rows: 2, canvasWidth: 1920, canvasHeight: 1080, slots: [],
      }),
      getClipsOnTrack: async () => [],
      getRegions: async () => [],
      getSources: async () => [],
    },
    video: { getFrameAtTime: async () => null },
  }
}

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = noopCtx
  globalThis.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 }
  }
  applied = []
  installXleth()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  container = null
  root = null
})

async function mount(tracks = emptyTracks()) {
  await act(async () => {
    root.render(
      <ZprTimelineCard
        trackId={1}
        zpr={{ enabled: true, tracks, lengthMode: 0, durationMs: 500 }}
        onApplyScalar={() => {}}
        onApplyTracks={(t) => { applied.push(JSON.parse(JSON.stringify(t))) }}
      />)
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const viewportCanvas = () => document.querySelector('.zpr-viewport-canvas')

// React reads clientX/clientY/button off the native event; a MouseEvent carries
// all three and jsdom does not implement PointerEvent.
function pointer(el, type, x, y) {
  el.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
  }))
}

describe('ZprViewport direct manipulation', () => {
  it('a drag inside the rect writes pan keyframes at the playhead, once', async () => {
    await mount()
    const cv = viewportCanvas()
    expect(cv).toBeTruthy()

    // Grab inside the rect but clear of the rotation pin, which defaults to the
    // window centre and is hit-tested ahead of the move (it is its own control,
    // as in Vegas).
    const from = px(0.3, 0.6)
    const to = px(0.5, 0.45)

    await act(async () => { pointer(cv, 'pointerdown', from.x, from.y) })
    expect(applied).toHaveLength(0)                      // nothing on mousedown

    await act(async () => { pointer(cv, 'pointermove', (from.x + to.x) / 2, from.y) })
    await act(async () => { pointer(cv, 'pointermove', to.x, to.y) })
    expect(applied).toHaveLength(0)                      // NEVER IPC during drag

    await act(async () => { pointer(cv, 'pointerup', to.x, to.y) })
    expect(applied).toHaveLength(1)                      // one commit -> one undo step

    const a = uvOf(from), b = uvOf(to)
    const t = applied[0]
    expect(t.panX.keys).toHaveLength(1)
    expect(t.panY.keys).toHaveLength(1)
    expect(t.panX.keys[0].t).toBe(0)                     // at the playhead
    // The centre followed the pointer, and pan = 0.5 - centre.
    expect(t.panX.keys[0].v).toBeCloseTo(-(b.u - a.u), 6)
    expect(t.panY.keys[0].v).toBeCloseTo(-(b.v - a.v), 6)
    expect(t.panX.keys[0].v).toBeLessThan(0)             // dragged right
    expect(t.panY.keys[0].v).toBeGreaterThan(0)          // dragged up

    // A pure pan must not litter the untouched channels.
    expect(t.zoomLog2.keys).toHaveLength(0)
    expect(t.rotationDeg.keys).toHaveLength(0)
  })

  it('a corner drag writes zoomLog2 and the inspector zoom readout follows', async () => {
    await mount()
    const cv = viewportCanvas()

    const se = px(1, 1)          // SE handle of the identity rect
    const target = px(0.5, 0.5)  // pull it to the centre => half-size window

    await act(async () => { pointer(cv, 'pointerdown', se.x, se.y) })
    await act(async () => { pointer(cv, 'pointermove', target.x, target.y) })
    await act(async () => { pointer(cv, 'pointerup', target.x, target.y) })

    expect(applied).toHaveLength(1)
    const t = applied[0]
    expect(t.zoomLog2.keys).toHaveLength(1)
    expect(t.zoomLog2.keys[0].v).toBeCloseTo(1, 6)        // log2(2x)
    expect(t.rotationDeg.keys).toHaveLength(0)

    // The derived "x" readout the inspector shows is 2.00 for a half-size window.
    const zoomField = Array.from(document.querySelectorAll('.zpr-drag-field'))
      .find(f => f.querySelector('.zpr-drag-field-label')?.textContent.trim() === 'Zoom')
    expect(zoomField.querySelector('.zpr-drag-field-value').textContent).toContain('2.00')
  })

  it('rotating past a full turn stores more than 360 degrees', async () => {
    await mount()
    const cv = viewportCanvas()

    // Grip sits STEM_UV above the top edge of the identity rect.
    const grip = px(0.5, 0.5 - (0.5 + STEM_UV))
    await act(async () => { pointer(cv, 'pointerdown', grip.x, grip.y) })

    // Sweep a full turn plus a bit, in 10-degree steps, around the rect centre.
    const r = 0.5 + STEM_UV
    const start = -Math.PI / 2
    let last = grip
    for (let deg = 10; deg <= 370; deg += 10) {
      const a = start + (deg * Math.PI) / 180
      const p = px(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a))
      last = p
      await act(async () => { pointer(cv, 'pointermove', p.x, p.y) })
    }
    await act(async () => { pointer(cv, 'pointerup', last.x, last.y) })

    expect(applied).toHaveLength(1)
    const keys = applied[0].rotationDeg.keys
    expect(keys).toHaveLength(1)
    // The point of the assertion: 370-ish, NOT 10. A degree or two of slop is
    // the integer truncation of the synthetic pointer coordinates, not wrapping.
    expect(keys[0].v).toBeGreaterThan(360)
    expect(keys[0].v).toBeGreaterThan(367)
    expect(keys[0].v).toBeLessThan(373)
  })

  it('an existing keyframe at the playhead is edited, not duplicated', async () => {
    const tracks = emptyTracks()
    tracks.panX = { constantValue: 0, keys: [{ t: 0, v: 0.25 }, { t: 1, v: 0.5 }] }
    await mount(tracks)
    const cv = viewportCanvas()

    // scrubT starts at 0, where panX already has a keyframe. Window centre is
    // 0.5 - 0.25 = 0.25; grab off-centre to clear the rotation pin.
    const from = px(0.25, 0.65)
    const to = px(0.35, 0.65)

    await act(async () => { pointer(cv, 'pointerdown', from.x, from.y) })
    await act(async () => { pointer(cv, 'pointermove', to.x, to.y) })
    await act(async () => { pointer(cv, 'pointerup', to.x, to.y) })

    const du = uvOf(to).u - uvOf(from).u
    const t = applied[0]
    expect(t.panX.keys).toHaveLength(2)              // edited in place, not added
    expect(t.panX.keys[0].t).toBe(0)
    expect(t.panX.keys[0].v).toBeCloseTo(0.25 - du, 6)
    expect(t.panX.keys[1].v).toBe(0.5)               // the other key is untouched
  })
})

/**
 * @vitest-environment jsdom
 */
// The viewer overlay with Masks and Parent (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5):
// every mask gesture is ONE setTrackMasks with the exact new list, nothing is sent
// before pointerup or after Escape, the active mask's handles win over the Roam
// handles, the pen draws a Path mask, and a parented cell maps a drag back through
// the inverse chain.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playheadClock } from '../../../services/PlayheadClock.js'
import { useRoamDraftStore } from '../../../lensRoam/useLensRoam.js'
import useRoamKeysStore from '../../../stores/useRoamKeysStore.js'
import useInspectorStore from '../../../stores/useInspectorStore.js'
import { useMotionViewStore } from '../../../motion/motionViewStore.js'
import { makeMask, makeRectangle, toWire } from '../../../motion/maskModel.js'
import { HINT_REFRESH_EVENT } from '../../../ui-kit/hint.ts'
import RoamOverlayCanvas from '../RoamOverlayCanvas.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [
    { trackId: 3, gridX: 0, gridY: 0, spanX: 8, spanY: 8 },
    { trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 },
  ],
  fullscreenLayers: [],
}
const BAR = 3840

let container
let root
let timeline
let store
let parent

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const setPlayheadTick = (tick) => { playheadClock.positionBeatsValue = tick / 960 }
const rect = (id = 1, opts) => toWire(makeMask('Rectangle', id, `Mask ${id}`, opts))
const ellipse = (id = 1) => toWire(makeMask('Ellipse', id, `Mask ${id}`))

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb }
    observe() { this.cb([{ contentRect: { width: 960, height: 540 } }]) }
    disconnect() {}
  }
  // Track 7 (Chorus) is the middle cell: centre (480, 270), 320 x 180 px on the 960 x 540 picture.
  store = {
    tracks: [
      { id: 3, name: 'Bass', gapScaleOverride: -1, parentTrackId: -1 },
      { id: 7, name: 'Chorus', gapScaleOverride: -1, parentTrackId: -1 },
    ],
    roam: { 3: { ...ROAM }, 7: { ...ROAM } },
    keys: { 3: [], 7: [] },
    masks: { 3: [], 7: [] },
  }
  const entry = (id) => ({
    trackId: id, roam: store.roam[id], keys: store.keys[id], masks: store.masks[id],
    parentTrackId: store.tracks.find((t) => t.id === id)?.parentTrackId ?? -1,
  })
  timeline = {
    getLensRoam: vi.fn(async (sel) => ({
      clips: [], sources: [], tracks: (sel?.trackIds ?? []).map(entry), missing: { clipIds: [], sources: [], trackIds: [] },
    })),
    setTrackRoam: vi.fn(async (trackId, p) => { store.roam[trackId] = { ...store.roam[trackId], ...p }; return { trackId, changed: true, roam: store.roam[trackId], keys: store.keys[trackId] } }),
    setTrackRoamKeys: vi.fn(async (trackId, keys) => { store.keys[trackId] = keys; return { trackId, changed: true, roam: store.roam[trackId], keys } }),
    setTrackMasks: vi.fn(async (trackId, masks) => { store.masks[trackId] = masks; return { trackId, changed: true, masks } }),
    getGridLayout: vi.fn(async () => LAYOUT),
    getTracks: vi.fn(async () => store.tracks),
  }
  window.xleth = { timeline }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useRoamDraftStore.getState().clearDraft()
  useRoamKeysStore.setState({ autoKey: false, laneOpen: new Set(), channelByTrack: {}, selected: null, draft: null })
  useInspectorStore.setState({ selection: { kind: 'track', trackId: 7 } })
  useMotionViewStore.getState().reset({ all: true })
  setPlayheadTick(0)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
  delete globalThis.ResizeObserver
  setPlayheadTick(0)
  useMotionViewStore.getState().reset({ all: true })
  vi.restoreAllMocks()
})

const mount = async () => {
  await act(async () => { root.render(<div data-testid="picture"><RoamOverlayCanvas aspect={16 / 9} /></div>) })
  await flush()
  parent = container.querySelector('[data-testid="picture"]')
}
const fire = (type, x, y, extra = {}) => act(async () => {
  parent.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...extra }))
})
const drag = async (from, to, extra = {}) => {
  await fire('pointerdown', from[0], from[1], extra)
  await fire('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra)
  await fire('pointermove', to[0], to[1], extra)
  await fire('pointerup', to[0], to[1], extra)
  await flush()
}
const key = (k) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
const select = (maskId, trackId = 7) => useMotionViewStore.getState().setSelectedMask({ trackId, maskId })
const sentMasks = () => timeline.setTrackMasks.mock.calls[0][1]
const vClose = (got, want) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 9))

describe('mask gestures: one setTrackMasks each, the exact list', () => {
  // Default rectangle +-0.4: points at (352,198) (608,198) (608,342) (352,342).
  it('dragging a Rectangle point moves it and makes it a Path; nothing is sent before pointerup', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await fire('pointerdown', 352, 198)
    await fire('pointermove', 368, 207)
    await fire('pointermove', 384, 216)                       // +32 px, +18 px = +0.1 cell each
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
    await fire('pointerup', 384, 216)
    await flush()
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    const [trackId, masks] = timeline.setTrackMasks.mock.calls[0]
    expect(trackId).toBe(7)
    expect(masks).toHaveLength(1)
    expect(masks[0].kind).toBe('Path')
    vClose(masks[0].base.shape.vertices[0], [-0.3, -0.3, 0, 0, 0, 0])
    expect(masks[0].base.shape.vertices.slice(1)).toEqual(rect(1).base.shape.vertices.slice(1))
    expect(masks[0]).toMatchObject({ id: 1, name: 'Mask 1', keys: [], shapeKeys: [] })
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })

  it('Escape cancels a mask drag: nothing sent', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await fire('pointerdown', 352, 198)
    await fire('pointermove', 384, 216)
    await key('Escape')
    await fire('pointerup', 384, 216)
    await flush()
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
  })

  it('a box corner resizes an Ellipse (opposite corner fixed) and keeps it an Ellipse; Shift keeps the aspect', async () => {
    store.masks[7] = [ellipse(1)]
    select(1)
    await mount()
    // BR box handle: (608 + 9, 342 + 9). +32 px = +0.1 cell wide, +18 px = +0.1 cell high.
    await drag([617, 351], [649, 369])
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    const m = sentMasks()[0]
    expect(m.kind).toBe('Ellipse')
    const vs = m.base.shape.vertices
    expect(vs[1][0]).toBeCloseTo(0.5, 9)                          // the right point: 0.4 -> 0.5
    expect(vs[3][0]).toBeCloseTo(-0.4, 9)                         // the left point stays (the fixed side)
    expect(vs[2][1]).toBeCloseTo(0.5, 9)                          // the bottom point: 0.4 -> 0.5

    timeline.setTrackMasks.mockClear()
    store.masks[7] = [ellipse(1)]
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
    await drag([617, 351], [649, 351], { shiftKey: true })        // only wider, Shift: both axes
    const a = sentMasks()[0].base.shape.vertices
    expect(a[1][0]).toBeCloseTo(0.5, 9)
    expect(a[2][1]).toBeCloseTo(0.5, 9)
  })

  it('dragging inside the mask moves the whole mask (not the cell); its kind is kept', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await drag([420, 300], [452, 300])                            // +0.1 cell to the right
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
    const m = sentMasks()[0]
    expect(m.kind).toBe('Rectangle')
    vClose(m.base.shape.vertices[0], [-0.3, -0.4, 0, 0, 0, 0])
    vClose(m.base.shape.vertices[2], [0.5, 0.4, 0, 0, 0, 0])
  })

  it('Ctrl+click on an edge adds a point there (one call, a Path of 5)', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await fire('pointermove', 480, 199, { ctrlKey: true })
    expect(parent.getAttribute('data-hint')).toMatch(/add a point to Mask 1/)
    await fire('pointerdown', 480, 199, { ctrlKey: true })
    await fire('pointerup', 480, 199, { ctrlKey: true })
    await flush()
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    const m = sentMasks()[0]
    expect(m.kind).toBe('Path')
    expect(m.base.shape.vertices).toHaveLength(5)
    vClose(m.base.shape.vertices[1], [0, -0.4, 0, 0, 0, 0])
  })

  it('Ctrl pressed and let go over a still pointer: the edge becomes an add-point target and back', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await fire('pointermove', 480, 199)
    expect(parent.getAttribute('data-hint')).not.toMatch(/add a point to Mask 1/)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true })) })
    expect(parent.getAttribute('data-hint')).toMatch(/add a point to Mask 1/)
    expect(parent.style.cursor).toBe('crosshair')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' })) })
    expect(parent.getAttribute('data-hint')).not.toMatch(/add a point to Mask 1/)
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
  })

  it('Alt+click a point deletes it; on a 3-point path it is refused and the hint says why', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await fire('pointerdown', 352, 198, { altKey: true })
    await fire('pointerup', 352, 198, { altKey: true })
    await flush()
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    const m = sentMasks()[0]
    expect(m.kind).toBe('Path')
    expect(m.base.shape.vertices).toEqual(rect(1).base.shape.vertices.slice(1))

    // Now a triangle: the point at (608, 198) is the first of three.
    timeline.setTrackMasks.mockClear()
    await fire('pointerdown', 608, 198, { altKey: true })
    await fire('pointerup', 608, 198, { altKey: true })
    await flush()
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    expect(parent.getAttribute('data-hint')).toBe('A mask needs at least 3 points')
  })

  it('Alt+drag a corner point pulls out symmetric curve handles', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    await drag([352, 198], [384, 198], { altKey: true })
    const v = sentMasks()[0].base.shape.vertices[0]
    vClose(v, [-0.4, -0.4, -0.1, 0, 0.1, 0])
    expect(sentMasks()[0].kind).toBe('Path')
  })

  it('an animated shape gets a shape key at the playhead; the base is untouched (R4)', async () => {
    const r = rect(1)
    r.shapeKeys = [
      { pos: 0, interp: 'Linear', vertices: r.base.shape.vertices },
      { pos: BAR, interp: 'Linear', vertices: r.base.shape.vertices },
    ]
    store.masks[7] = [r]
    select(1)
    setPlayheadTick(1920)
    await mount()
    await drag([352, 198], [384, 216])
    const m = sentMasks()[0]
    expect(m.base.shape.vertices).toEqual(r.base.shape.vertices)
    expect(m.shapeKeys.map((k) => k.pos)).toEqual([0, 1920, BAR])
    vClose(m.shapeKeys[1].vertices[0], [-0.3, -0.3, 0, 0, 0, 0])
  })

  it('a Path\'s curve handle: the opposite handle follows a smooth pair; Alt breaks it', async () => {
    const e = ellipse(1)
    e.kind = 'Path'
    store.masks[7] = [e]
    select(1)
    await mount()
    // The top point (480, 198); its out handle KAPPA * 0.4 cell to the right.
    const hx = 480 + 0.5522847498 * 0.4 * 320
    await drag([hx, 198], [hx, 216])
    const v = sentMasks()[0].base.shape.vertices[0]
    expect(v[5]).toBeCloseTo(0.1, 9)                     // out handle now points down-right
    expect(v[3]).toBeLessThan(0)                         // in handle turned to stay opposite
    timeline.setTrackMasks.mockClear()
    store.masks[7] = [e]
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
    await drag([hx, 198], [hx, 216], { altKey: true })
    const b = sentMasks()[0].base.shape.vertices[0]
    expect(b.slice(2, 4)).toEqual(e.base.shape.vertices[0].slice(2, 4))
  })
})

describe('hit priority and when masks show', () => {
  it('the active mask\'s point wins over the Roam corner square under it', async () => {
    store.masks[7] = [rect(1, { shape: makeRectangle({ hw: 0.5 }) })]
    select(1)
    await mount()
    await drag([320, 180], [336, 189])                   // the cell's top-left corner = the mask's point
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })

  it('no mask selected and the group closed: masks are not shown, a drag moves the cell', async () => {
    store.masks[7] = [rect(1)]
    await mount()
    await drag([420, 300], [452, 300])
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    expect(timeline.setTrackRoam).toHaveBeenCalledTimes(1)
  })

  it('the Masks group open in Motion view: an outline click selects that mask, nothing is sent', async () => {
    store.masks[7] = [rect(1)]
    const st = useMotionViewStore.getState()
    st.setView('motion')
    st.expandPath('t:7/roam/masks')
    await mount()
    await fire('pointermove', 480, 198)
    expect(parent.getAttribute('data-hint')).toMatch(/Mask 1: click its outline/)
    await fire('pointerdown', 480, 198)
    await fire('pointerup', 480, 198)
    await flush()
    expect(useMotionViewStore.getState().selectedMask).toEqual({ trackId: 7, maskId: 1 })
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })

  it('every hover state has its hint (point, box, inside), re-read by the hint bar', async () => {
    store.masks[7] = [rect(1)]
    select(1)
    await mount()
    const refresh = vi.fn()
    window.addEventListener(HINT_REFRESH_EVENT, refresh)
    await fire('pointermove', 352, 198)
    expect(parent.getAttribute('data-hint')).toMatch(/Mask 1: drag this point to move it. Moving one point makes the rectangle a path/)
    expect(parent.getAttribute('data-hint-mods')).toMatch(/Alt\+click: delete/)
    await fire('pointermove', 343, 189)
    expect(parent.getAttribute('data-hint')).toMatch(/drag a corner to resize the rectangle/)
    await fire('pointermove', 420, 300)
    expect(parent.getAttribute('data-hint')).toMatch(/drag inside to move the mask/)
    expect(refresh).toHaveBeenCalled()
    window.removeEventListener(HINT_REFRESH_EVENT, refresh)
  })
})

describe('the pen', () => {
  it('click, click-drag, click, click the first point: ONE setTrackMasks adding a Path mask, then it is selected', async () => {
    store.masks[7] = [rect(1)]
    useMotionViewStore.getState().setPenTool({ trackId: 7 })
    await mount()
    expect(parent.getAttribute('data-hint')).toMatch(/^Pen on Chorus/)
    await fire('pointerdown', 400, 220); await fire('pointerup', 400, 220)
    await fire('pointerdown', 560, 220)
    await fire('pointermove', 580, 230)
    await fire('pointermove', 600, 240)
    await fire('pointerup', 600, 240)
    await fire('pointerdown', 480, 330); await fire('pointerup', 480, 330)
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    await fire('pointermove', 401, 221)
    expect(parent.getAttribute('data-hint')).toMatch(/close the path \(3 points\)/)
    await fire('pointerdown', 401, 221); await fire('pointerup', 401, 221)
    await flush()
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    const masks = sentMasks()
    expect(masks).toHaveLength(2)
    expect(masks[0]).toEqual(rect(1))
    const m = masks[1]
    expect(m).toMatchObject({ id: 2, name: 'Mask 2', kind: 'Path', keys: [], shapeKeys: [] })
    const vs = m.base.shape.vertices
    vClose(vs[0], [-0.25, -50 / 180, 0, 0, 0, 0])
    vClose(vs[1], [0.25, -50 / 180, -40 / 320, -20 / 180, 40 / 320, 20 / 180])
    vClose(vs[2], [0, 60 / 180, 0, 0, 0, 0])
    const st = useMotionViewStore.getState()
    expect(st.penTool).toBeNull()
    expect(st.selectedMask).toEqual({ trackId: 7, maskId: 2 })
    expect(st.expanded.has('t:7/roam/masks')).toBe(true)
  })

  it('Enter closes the path; Escape cancels it (nothing sent); the pen never moves the cell', async () => {
    useMotionViewStore.getState().setPenTool({ trackId: 7 })
    await mount()
    for (const [x, y] of [[400, 220], [560, 220], [480, 330]]) { await fire('pointerdown', x, y); await fire('pointerup', x, y) }
    await key('Enter')
    await flush()
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    expect(sentMasks()[0].base.shape.vertices).toHaveLength(3)
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()

    timeline.setTrackMasks.mockClear()
    await act(async () => { useMotionViewStore.getState().setPenTool({ trackId: 7 }) })
    await flush()
    await fire('pointerdown', 400, 220); await fire('pointerup', 400, 220)
    await fire('pointerdown', 560, 220); await fire('pointerup', 560, 220)
    await key('Escape')
    await flush()
    expect(useMotionViewStore.getState().penTool).toBeNull()
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
  })

  it('Backspace takes the last point off; Enter with too few points says why and sends nothing', async () => {
    useMotionViewStore.getState().setPenTool({ trackId: 7 })
    await mount()
    for (const [x, y] of [[400, 220], [560, 220], [480, 330]]) { await fire('pointerdown', x, y); await fire('pointerup', x, y) }
    await key('Backspace')
    await key('Enter')
    await flush()
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    expect(parent.getAttribute('data-hint')).toMatch(/at least 3 points/)
  })

  it('the pen moved straight to another track starts a fresh path there (no points carried over)', async () => {
    useMotionViewStore.getState().setPenTool({ trackId: 7 })
    await mount()
    await fire('pointerdown', 400, 220); await fire('pointerup', 400, 220)
    await fire('pointerdown', 560, 220); await fire('pointerup', 560, 220)
    // Motion view's Add mask > Path on Bass (the top-left cell, centre (160, 90) px), no null in between.
    await act(async () => { useMotionViewStore.getState().setPenTool({ trackId: 3, points: [] }) })
    await flush()
    expect(parent.getAttribute('data-hint')).toMatch(/^Pen on Bass/)
    for (const [x, y] of [[100, 50], [220, 50], [160, 140]]) { await fire('pointerdown', x, y); await fire('pointerup', x, y) }
    await key('Enter')
    await flush()
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    const [trackId, masks] = timeline.setTrackMasks.mock.calls[0]
    expect(trackId).toBe(3)
    const vs = masks[0].base.shape.vertices
    expect(vs).toHaveLength(3)
    vClose(vs[0], [-60 / 320, -40 / 180, 0, 0, 0, 0])
    vClose(vs[1], [60 / 320, -40 / 180, 0, 0, 0, 0])
    vClose(vs[2], [0, 50 / 180, 0, 0, 0, 0])
  })

  it('re-arming the pen on the same track drops the points of the path it was drawing', async () => {
    useMotionViewStore.getState().setPenTool({ trackId: 7 })
    await mount()
    await fire('pointerdown', 400, 220); await fire('pointerup', 400, 220)
    await fire('pointerdown', 560, 220); await fire('pointerup', 560, 220)
    await act(async () => { useMotionViewStore.getState().setPenTool({ trackId: 7, points: [] }) })
    await flush()
    await fire('pointerdown', 480, 330); await fire('pointerup', 480, 330)
    await key('Enter')
    await flush()
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
    expect(parent.getAttribute('data-hint')).toMatch(/at least 3 points/)
  })

  it('a track already holding 8 masks: the pen refuses and says why', async () => {
    store.masks[7] = Array.from({ length: 8 }, (_, i) => rect(i + 1, { shape: makeRectangle({ hw: 0.05 }) }))
    useMotionViewStore.getState().setPenTool({ trackId: 7 })
    await mount()
    expect(parent.getAttribute('data-hint')).toMatch(/at most 8 masks/)
    await fire('pointerdown', 400, 220); await fire('pointerup', 400, 220)
    await key('Enter')
    await flush()
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
  })
})

describe('drawing (a recording 2D context)', () => {
  // jsdom has no canvas: a context that records every call proves each painter runs
  // without throwing and draws what it should, from drawNow alone (no React state per frame).
  const recorder = () => {
    const calls = []
    const props = {}
    const ctx = new Proxy(props, {
      get(t, k) {
        if (k === 'measureText') return (s) => ({ width: String(s).length * 6 })
        if (k in t) return t[k]
        return (...args) => { calls.push([k, ...args]) }
      },
      set(t, k, v) { t[k] = v; calls.push([`=${String(k)}`, v]); return true },
    })
    return { ctx, calls, count: (name) => calls.filter((c) => c[0] === name).length, texts: () => calls.filter((c) => c[0] === 'fillText').map((c) => c[1]) }
  }

  it('the active mask: bezier outline, points, box, label; Roam handles still drawn', async () => {
    const rec = recorder()
    HTMLCanvasElement.prototype.getContext.mockReturnValue(rec.ctx)
    const e = ellipse(1)
    store.masks[7] = [rect(2), e]
    select(1)
    store.keys[7] = [{ channel: 'offsetX', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear' }, { channel: 'offsetX', anchor: 'Origin', pos: BAR, value: 1, interp: 'Linear' }]
    await mount()
    expect(rec.count('bezierCurveTo')).toBeGreaterThanOrEqual(8)      // two masks, four edges each (keyline + line)
    expect(rec.count('strokeRect')).toBeGreaterThanOrEqual(8)         // 4 Roam corners + 4 mask box corners
    expect(rec.texts()).toContain('Mask 1 · Add')
    expect(rec.calls.some((c) => c[0] === 'setLineDash' && c[1].length === 0)).toBe(true)
    // A hover redraws through the same path (Ctrl over an edge marks where the point would go).
    rec.calls.length = 0
    await fire('pointermove', 480, 199, { ctrlKey: true })
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(rec.count('arc')).toBeGreaterThan(0)
  })

  it('a mask commit that resolves draws (and hit-tests) the committed list at once, before React renders', async () => {
    const rec = recorder()
    HTMLCanvasElement.prototype.getContext.mockReturnValue(rec.ctx)
    store.masks[7] = [rect(1)]
    select(1)
    let release = null
    timeline.setTrackMasks.mockImplementation((trackId, masks) => new Promise((resolve) => {
      release = () => { store.masks[trackId] = masks; resolve({ trackId, changed: true, masks }) }
    }))
    await mount()
    const arcAt = (x, y) => rec.calls.some((c) => c[0] === 'arc' && Math.abs(c[1] - x) < 0.01 && Math.abs(c[2] - y) < 0.01)
    await fire('pointerdown', 352, 198)
    await fire('pointermove', 384, 216)
    await fire('pointerup', 384, 216)
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(1)
    // The engine answers; only microtasks run (no React render yet, no act).
    rec.calls.length = 0
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    try {
      release()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      // The draw after the draft cleared shows the moved point, never the pre-edit one.
      expect(rec.count('arc')).toBeGreaterThan(0)
      expect(arcAt(384, 216)).toBe(true)
      expect(arcAt(352, 198)).toBe(false)
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
    }
    await flush()
    // A second edit is built on the committed list (the moved point is grabbed where it now is).
    timeline.setTrackMasks.mockImplementation(async (trackId, masks) => { store.masks[trackId] = masks; return { trackId, changed: true, masks } })
    await drag([384, 216], [416, 234])
    expect(timeline.setTrackMasks).toHaveBeenCalledTimes(2)
    vClose(timeline.setTrackMasks.mock.calls[1][1][0].base.shape.vertices[0], [-0.2, -0.2, 0, 0, 0, 0])
  })

  it('the pen: points, path, rubber band and the badge', async () => {
    const rec = recorder()
    HTMLCanvasElement.prototype.getContext.mockReturnValue(rec.ctx)
    await act(async () => { useMotionViewStore.getState().setPenTool({ trackId: 7 }) })
    await mount()
    await fire('pointerdown', 400, 220); await fire('pointerup', 400, 220)
    await fire('pointerdown', 560, 220); await fire('pointermove', 600, 240); await fire('pointerup', 600, 240)
    await fire('pointermove', 401, 221)
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(rec.texts()).toContain('Pen · 2 points')
    expect(rec.count('bezierCurveTo')).toBeGreaterThan(0)
    expect(timeline.setTrackMasks).not.toHaveBeenCalled()
  })

  it('a parented cell with a keyed parent draws its carried home box and path', async () => {
    const rec = recorder()
    HTMLCanvasElement.prototype.getContext.mockReturnValue(rec.ctx)
    store.tracks[1].parentTrackId = 3
    store.roam[7] = { ...ROAM, offsetX: 0.2 }
    store.keys[3] = [{ channel: 'rotationDeg', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear' }, { channel: 'rotationDeg', anchor: 'Origin', pos: BAR, value: 45, interp: 'Linear' }]
    await mount()
    // Dashed home box [4, 3] and the dotted path [2, 4] were both drawn.
    expect(rec.calls.some((c) => c[0] === 'setLineDash' && c[1][0] === 4 && c[1][1] === 3)).toBe(true)
    expect(rec.calls.some((c) => c[0] === 'setLineDash' && c[1][0] === 2 && c[1][1] === 4)).toBe(true)
  })
})

describe('parented cell', () => {
  it('drawn where its parent carries it; a move maps back through the inverse chain to its own offset', async () => {
    // Chorus follows Bass; Bass (top-left cell, home centre (160, 90) px) is scaled 2x.
    store.tracks[1].parentTrackId = 3
    store.roam[3] = { ...ROAM, scale: 2 }
    await mount()
    expect(parent.getAttribute('data-hint')).toMatch(/its grid box as its parent Bass carries it/)
    // Carried centre: (160 + 2 * 320, 90 + 2 * 180) = (800, 450); size 640 x 360.
    // The old place of the cell (420, 300) is no longer inside it: nothing to grab there.
    await drag([420, 300], [452, 300])
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
    await drag([700, 400], [764, 400])                       // +64 px on screen
    expect(timeline.setTrackRoam).toHaveBeenCalledTimes(1)
    const p = timeline.setTrackRoam.mock.calls[0][1]
    expect(p.offsetX).toBeCloseTo(0.1, 9)                    // 64 / 960 / 2 / (1/3): halved by the parent's scale
    expect(p.offsetY ?? 0).toBeCloseTo(0, 9)
  })

  it('a corner of the carried cell scales the child\'s OWN scale by the drag ratio', async () => {
    store.tracks[1].parentTrackId = 3
    store.roam[3] = { ...ROAM, scale: 2 }
    await mount()
    // Carried BR corner (1120, 630); pull it out to 1.5x the distance from the centre (800, 450).
    await drag([1120, 630], [1280, 720])
    expect(timeline.setTrackRoam).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackRoam.mock.calls[0][1].scale).toBeCloseTo(1.5, 9)
  })
})

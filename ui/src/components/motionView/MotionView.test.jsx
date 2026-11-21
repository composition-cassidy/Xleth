// @vitest-environment jsdom
//
// Motion view shell (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2-5.4, R3, R4, R6, R19, R20, R24):
// the DOM tree in the header column, the canvas key area portaled into the host,
// the key toggle / value / navigation plans, reveal, keys, and the tree window.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MotionView, { keyAreaHint, parentResultNote } from './MotionView.jsx'
import { treeWindow, rowValueKey, navState, WINDOW_BLOCK } from './MotionTree.jsx'
import { setMotionTickForTest } from './motionTick.js'
import { registerMotionKeyAction } from './motionKeyCommands.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { buildMotionRows } from '../../motion/rowRegistry.js'
import { formatValue, propertyById } from '../../motion/schema.js'
import { resetSharedUndoGrouper } from '../timeline/undoGroup.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { fixtureData, fixtureLensRoam, fixtureTracks, LENS_ID } from '../../motion/providers/__tests__/fixtures.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TICK = 1920                    // two beats: half way through Lead's Offset X keys (0 -> 1 over 0..3840)

function canvasStub() {
  const noop = () => {}
  return new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : noop),
    set: (t, k, v) => { t[k] = v; return true },
  })
}

let container
let host
let root
let ref
let tl
let undo
let onSeekTick
let onFocusTrack
let onPearl

const answer = (extra) => async (...args) => ({ changed: true, ...extra(...args) })

function mount(props = {}) {
  ref = { current: null }
  act(() => {
    root.render(
      <MotionView
        ref={ref}
        tracks={props.tracks ?? fixtureTracks()}
        allTracks={props.allTracks ?? fixtureTracks()}
        data={props.data ?? fixtureData()}
        refresh={vi.fn()}
        adopt={vi.fn()}
        keyHost={host}
        ppbRef={{ current: 40 }}
        scrollOffsetRef={{ current: 0 }}
        snapGranularity="1/16"
        onFocusTrack={onFocusTrack}
        onPearl={onPearl}
        onSeekTick={onSeekTick}
        reveal={props.reveal ?? null}
      />,
    )
  })
}

const q = (sel) => container.querySelector(sel)
const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`)
const click = async (el, init = {}) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...init }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => canvasStub()
  container = document.createElement('div')
  host = document.createElement('div')
  document.body.append(container, host)
  root = createRoot(container)
  useMotionViewStore.getState().reset({ all: true })
  resetSharedUndoGrouper()
  playheadClock.positionBeatsValue = 2
  setMotionTickForTest(TICK)
  onSeekTick = vi.fn()
  onFocusTrack = vi.fn()
  onPearl = vi.fn()
  undo = {
    beginGroup: vi.fn(async () => 7),
    endGroup: vi.fn(async () => true),
  }
  tl = {
    setTrackRoam: vi.fn(answer((id, params) => ({ trackId: id, roam: params }))),
    setTrackRoamKeys: vi.fn(answer((id, keys) => ({ trackId: id, roam: {}, keys }))),
    setTrackSweepKeys: vi.fn(answer((id, keys) => ({ trackId: id, keys }))),
    setTrackParent: vi.fn(async (id, parent) => ({ trackId: id, changed: true, parentTrackId: parent, compensated: ['scale'], uncompensated: ['offsetX', 'offsetY'] })),
    setTrackMasks: vi.fn(answer((id, masks) => ({ trackId: id, masks }))),
    setMotionBlur: vi.fn(async (m) => m),
  }
  window.xleth = { timeline: tl, undo }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  host.remove()
  delete window.xleth
  playheadClock.positionBeatsValue = 0
})

describe('Motion view shell', () => {
  it('puts the tree in the header column and the three canvases in the key host (R24)', () => {
    mount()
    expect(byTestId('motion-view')).toBeTruthy()
    for (const id of [1, 2, 3, 4]) expect(byTestId(`motion-row-t:${id}`)).toBeTruthy()
    const lead = byTestId('motion-row-t:1')
    expect(lead.textContent).toContain('Lead')
    expect(lead.textContent).toContain('Pattern')
    expect(lead.querySelector('[data-testid="motion-parent-1"]')).toBeTruthy()
    expect(byTestId('motion-row-t:2').querySelector('[data-testid="motion-parent-2"]').textContent).toContain('Parent: Lead')
    // The key area lives in the host, not in the column.
    expect([...host.querySelectorAll('canvas')].map((c) => c.dataset.layer)).toEqual(['static', 'keys', 'overlay'])
    expect(container.querySelector('canvas')).toBeNull()
    // Every control says what it does.
    for (const el of container.querySelectorAll('button')) {
      expect(el.getAttribute('data-hint') || el.getAttribute('aria-label')).toBeTruthy()
    }
  })

  it('the output pearl uses the Edit header handlers (shared mute / solo)', async () => {
    mount()
    const pearl = byTestId('motion-row-t:3').querySelector('button[aria-pressed]')
    await click(pearl)
    expect(onPearl).toHaveBeenCalledWith(3, 'toggle')
  })

  it('twirls open a track and its Roam group; values are the live value at the playhead', async () => {
    mount()
    await click(byTestId('motion-twirl-t:1'))
    expect(useMotionViewStore.getState().expanded.has('t:1')).toBe(true)
    expect(byTestId('motion-row-t:1/roam')).toBeTruthy()
    await click(byTestId('motion-twirl-t:1/roam'))
    const row = byTestId('motion-row-t:1/roam/roam.offsetX')
    expect(row).toBeTruthy()
    expect(row.getAttribute('data-animated')).toBe('true')
    expect(row.textContent).toContain(formatValue(propertyById('roam.offsetX'), 0.5))
    // Bounds / Layer / Motion blur have no key toggle (R3).
    expect(byTestId('motion-stopwatch-t:1/roam/roam.bounds')).toBeNull()
    expect(byTestId('motion-stopwatch-t:1/roam/roam.motionBlur')).toBeNull()
    expect(byTestId('motion-row-t:1/roam/roam.motionBlur').textContent).toContain('Project')
  })

  it('key toggle OFF: the keys go AND the base takes the value at the playhead, one undo step (R3)', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    await click(byTestId('motion-stopwatch-t:1/roam/roam.offsetX'))
    await flush()
    expect(tl.setTrackRoam).toHaveBeenCalledWith(1, { offsetX: 0.5 })
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [])
    expect(undo.beginGroup).toHaveBeenCalledTimes(1)
    expect(undo.endGroup).toHaveBeenCalledTimes(1)
  })

  it('key toggle ON: one key at the playhead holding the value shown (R3)', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    await click(byTestId('motion-stopwatch-t:1/roam/roam.offsetY'))
    await flush()
    const keys = tl.setTrackRoamKeys.mock.calls[0][1]
    expect(keys.filter((k) => k.channel === 'offsetY')).toEqual([
      expect.objectContaining({ channel: 'offsetY', anchor: 'Origin', pos: TICK, value: 0 }),
    ])
    expect(keys.filter((k) => k.channel === 'offsetX')).toHaveLength(2)
    expect(undo.beginGroup).not.toHaveBeenCalled()       // one write: no group needed
  })

  it('a value edit on an animated row keys the playhead; on a static row it edits the base (R4)', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const api = ref.current.api()
    const L = ref.current.layout()
    await act(async () => { await api.valuePlan(L.byKey.get('t:1/roam/roam.offsetX'), 0.25) })
    expect(tl.setTrackRoamKeys.mock.calls[0][1].filter((k) => k.channel === 'offsetX').map((k) => [k.pos, k.value])
      .sort((a, b) => a[0] - b[0])).toEqual([[0, 0], [TICK, 0.25], [3840, 1]])
    await act(async () => { await api.valuePlan(L.byKey.get('t:1/roam/roam.scale'), 2) })
    expect(tl.setTrackRoam).toHaveBeenCalledWith(1, { scale: 2 })
  })

  it('navigation: previous / next move the playhead to the adjacent key; the diamond adds a key', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    await click(byTestId('motion-next-t:1/roam/roam.offsetX'))
    expect(onSeekTick).toHaveBeenLastCalledWith(3840)
    await click(byTestId('motion-prev-t:1/roam/roam.offsetX'))
    expect(onSeekTick).toHaveBeenLastCalledWith(0)
    const add = byTestId('motion-key-t:1/roam/roam.offsetX')
    expect(add.getAttribute('data-at-key')).toBeNull()
    await click(add)
    await flush()
    expect(tl.setTrackRoamKeys.mock.calls[0][1].some((k) => k.channel === 'offsetX' && k.pos === TICK && k.value === 0.5)).toBe(true)
  })

  it('reveal: expands the path, selects the row and focuses the track (5.2)', () => {
    mount({ reveal: { trackId: 1, path: ['roam'] } })
    const s = useMotionViewStore.getState()
    expect(s.expanded.has('t:1')).toBe(true)
    expect(s.expanded.has('t:1/roam')).toBe(true)
    expect([...s.selectedRows]).toEqual(['t:1/roam'])
    expect(onFocusTrack).toHaveBeenCalledWith(1)
    expect(byTestId('motion-row-t:1/roam').getAttribute('data-selected')).toBe('true')
  })

  it('clicking a row label selects it (Ctrl toggles, Shift adds) and a mask row selects that mask', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam', 't:1/roam/masks'])
    mount()
    const label = (key) => byTestId(`motion-row-${key}`).querySelector('[role="button"]')
    await click(label('t:1/roam/roam.scale'))
    await click(label('t:1/roam/roam.rotationDeg'), { ctrlKey: true })
    expect([...useMotionViewStore.getState().selectedRows]).toEqual(['t:1/roam/roam.scale', 't:1/roam/roam.rotationDeg'])
    await click(label('t:1/mask:1'))
    expect(useMotionViewStore.getState().selectedMask).toEqual({ trackId: 1, maskId: 1 })
  })

  it('Parent: Alt passes keepOnScreen + the playhead tick; the hint names the keyed channels (R6)', async () => {
    mount()
    const res = await act(async () => ref.current.api().chooseParent(2, 3, { keepOnScreen: true }))
    expect(tl.setTrackParent).toHaveBeenCalledWith(2, 3, { keepOnScreen: true, tick: TICK })
    expect(parentResultNote(res.results[0], true)).toBe('Parent set. Offset X, Y are keyed: they keep their keys and may jump')
  })

  it('Add mask: a rectangle is one masks write; the new mask opens and is selected', async () => {
    mount()
    await act(async () => { await ref.current.api().addMask(1, 'Rectangle') })
    const [trackId, masks] = tl.setTrackMasks.mock.calls[0]
    expect(trackId).toBe(1)
    expect(masks.map((m) => [m.id, m.kind])).toEqual([[1, 'Rectangle'], [2, 'Rectangle']])
    const s = useMotionViewStore.getState()
    expect(s.expanded.has('t:1/roam/masks')).toBe(true)
    expect(s.expanded.has('t:1/mask:2')).toBe(true)
    expect(s.selectedMask).toEqual({ trackId: 1, maskId: 2 })
  })

  it('Add mask > Path arms the pen tool for the viewer instead of writing', async () => {
    mount()
    await act(async () => { await ref.current.api().addMask(4, 'Path') })
    expect(tl.setTrackMasks).not.toHaveBeenCalled()
    expect(useMotionViewStore.getState().penTool).toEqual({ trackId: 4, points: [] })
  })

  it('the Motion blur row edits the PROJECT setting (R1)', async () => {
    mount()
    await act(async () => { await ref.current.api().setMotionBlur({ enabled: true, shutterAngle: 270 }) })
    expect(tl.setMotionBlur).toHaveBeenCalledWith({ enabled: true, shutterAngle: 270 })
  })
})

describe('Motion view keys (R20)', () => {
  it('Escape clears the key selection; Ctrl+A selects the keys of open rows; unhandled edits stay unclaimed', () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const h = ref.current
    expect(h.handleKeyCommand({ id: 'selectAll' })).toBe(true)
    const sel = useMotionViewStore.getState().keySel
    expect([...sel.keys()].sort()).toEqual(['r:1:offsetX:0', 'r:1:offsetX:3840'])
    expect(h.handleKeyCommand({ id: 'escape' })).toBe(true)
    expect(useMotionViewStore.getState().keySel.size).toBe(0)
    expect(h.handleKeyCommand({ id: 'escape' })).toBe(false)          // nothing to cancel
    expect(h.handleKeyCommand({ id: 'delete' })).toBe(false)          // until UA2 registers it
  })

  it('a registered action gets the command and the context', () => {
    mount()
    const fn = vi.fn(() => true)
    const off = registerMotionKeyAction('nudge', fn)
    try {
      expect(ref.current.handleKeyCommand({ id: 'nudge', direction: 1, fine: true })).toBe(true)
      const [command, ctx] = fn.mock.calls[0]
      expect(command).toEqual({ id: 'nudge', direction: 1, fine: true })
      expect(ctx.tick).toBe(TICK)
      expect(ctx.layout.rows.length).toBe(4)
      expect(typeof ctx.runPlan).toBe('function')
    } finally { off() }
  })
})

describe('Motion view scroll (R19)', () => {
  // jsdom has no layout: scrollers get a viewport of 500 px, a scrollHeight from
  // their spacer child, and a scrollTop clamped like a browser's.
  const VIEW_H = 500
  const tops = new WeakMap()
  const saved = {}
  const contentHeight = (el) => [...el.children].reduce((m, c) => Math.max(m, parseFloat(c.style?.height) || 0), 0)
  beforeEach(() => {
    for (const k of ['scrollTop', 'scrollHeight', 'clientHeight']) saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return VIEW_H } })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return Math.max(VIEW_H, contentHeight(this)) } })
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() { return tops.get(this) ?? 0 },
      set(v) { tops.set(this, Math.max(0, Math.min(this.scrollHeight - this.clientHeight, v))) },
    })
  })
  afterEach(() => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d)
      else delete HTMLElement.prototype[k]
    }
  })

  const many = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `T${i}`, type: 'Clip' }))
  const keyScroll = () => host.querySelector('[data-testid="motion-key-scroll"]')
  const treeScroll = () => byTestId('motion-tree-scroll')

  it('a project loaded while Motion view is shown takes its saved scroll', () => {
    mount({ tracks: many, allTracks: many, data: fixtureData({ tracks: many }) })
    expect(keyScroll().scrollTop).toBe(0)
    act(() => { useMotionViewStore.getState().loadState({ view: 'motion', motion: { scrollY: 1500 } }) })
    expect(keyScroll().scrollTop).toBe(1500)
    expect(treeScroll().scrollTop).toBe(1500)
  })

  it('a saved scroll waits for rows that can hold it', () => {
    useMotionViewStore.getState().loadState({ view: 'motion', motion: { scrollY: 1500 } })
    mount({ tracks: [], allTracks: [], data: fixtureData({ tracks: [] }) })
    expect(keyScroll().scrollTop).toBe(0)
    // The tracks arrive.
    mount({ tracks: many, allTracks: many, data: fixtureData({ tracks: many }) })
    expect(keyScroll().scrollTop).toBe(1500)
    expect(treeScroll().scrollTop).toBe(1500)
    expect(useMotionViewStore.getState().motion.scrollY).toBe(1500)
  })

  it('the user\'s own scroll cancels a restore still waiting for rows', () => {
    vi.useFakeTimers()
    try {
      const some = many.slice(0, 30)                         // 30 x 28 px: cannot hold 1500
      useMotionViewStore.getState().loadState({ view: 'motion', motion: { scrollY: 1500 } })
      mount({ tracks: some, allTracks: some, data: fixtureData({ tracks: some }) })
      const sc = keyScroll()
      expect(sc.scrollTop).toBe(sc.scrollHeight - VIEW_H)   // clamped, still pending
      // The echo of that apply is not a user scroll and is not saved.
      act(() => { sc.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(1000) })
      expect(useMotionViewStore.getState().motion.scrollY).toBe(1500)
      act(() => { sc.scrollTop = 100; sc.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(1000) })
      expect(useMotionViewStore.getState().motion.scrollY).toBe(100)
      mount({ tracks: many, allTracks: many, data: fixtureData({ tracks: many }) })
      expect(sc.scrollTop).toBe(100)
    } finally { vi.useRealTimers() }
  })
})

describe('tree pieces', () => {
  const data = fixtureData()

  it('mounts only the rows near the viewport, in blocks', () => {
    const tracks = Array.from({ length: 300 }, (_, i) => ({ id: 1000 + i, name: `T${i}`, type: 'Clip' }))
    const L = buildMotionRows({ tracks, data: fixtureData({ tracks }), expanded: new Set(), trackRowHeight: 28 })
    const [a, b] = treeWindow(L, 0, 600)
    expect(a).toBe(0)
    expect(b % WINDOW_BLOCK === 0 || b === L.rows.length).toBe(true)
    expect(b).toBeLessThan(80)
    const [c, d] = treeWindow(L, 28 * 200, 600)
    expect(c).toBeGreaterThan(150)
    expect(d).toBeLessThanOrEqual(L.rows.length)
  })

  it('cells read primitives (zustand selectors) and the navigation state', () => {
    const L = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(['t:1', 't:1/roam', 't:1/roam/masks', 't:1/mask:1']), trackRowHeight: 28 })
    expect(rowValueKey(L.byKey.get('t:1/roam/roam.offsetX'), data, TICK)).toBe(0.5)
    expect(rowValueKey(L.byKey.get('t:1/roam/roam.motionBlur'), data, TICK)).toBe('1:180')
    expect(rowValueKey(L.byKey.get('t:1/mask:1/mask.shape'), data, TICK)).toBe('Rectangle')
    const ox = L.byKey.get('t:1/roam/roam.offsetX')
    expect(navState(ox, data, TICK)).toBe(1 | 2)
    expect(navState(ox, data, 0)).toBe(2 | 4)
    expect(navState(ox, data, 3840)).toBe(1 | 4)
  })

  it('navigation state at a clip boundary: at the next clip\'s key, not the earlier clip\'s key past its end', () => {
    const lr = fixtureLensRoam()
    lr.clips = [
      { clipId: 30, lens: LENS_ID, keys: [{ channel: 'zoom', anchor: 'Origin', pos: 3840, value: 2, interp: 'Linear' }] }, // outside
      { clipId: 31, lens: LENS_ID, keys: [{ channel: 'zoom', anchor: 'Origin', pos: 0, value: 3, interp: 'Linear' }] },
    ]
    const d = fixtureData({ lensRoam: lr })
    const L = buildMotionRows({ tracks: fixtureTracks(), data: d, expanded: new Set(['t:2', 't:2/lens']), trackRowHeight: 28 })
    const zoom = L.byKey.get('t:2/lens/clipLens.zoom')
    expect(navState(zoom, d, 3840)).toBe(4)
    expect(navState(zoom, d, 100)).toBe(2)
  })

  it('navigation state reads only the keys near the playhead (it runs every display tick)', () => {
    const N = 20000
    const list = Array.from({ length: N }, (_, i) => ({ id: `x${i}`, tick: i * 10, outside: false, ref: {} }))
    let reads = 0
    const counted = new Proxy(list, {
      get(t, p) { if (typeof p === 'string' && /^\d+$/.test(p)) reads++; return Reflect.get(t, p) },
    })
    const row = { key: 'nav-probe', prop: propertyById('roam.offsetX'), provider: { keys: () => counted }, trackId: 1 }
    const d = fixtureData()
    expect(navState(row, d, 50000)).toBe(1 | 2 | 4)
    expect(navState(row, d, 50005)).toBe(1 | 2)
    expect(navState(row, d, -5)).toBe(2)
    expect(navState(row, d, N * 10)).toBe(1)
    expect(reads).toBeLessThan(400)
  })

  it('the key area hint names the key, its value and where hollow keys come from', () => {
    const L = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(['t:1', 't:1/roam']), trackRowHeight: 28 })
    const row = L.byKey.get('t:1/roam/roam.offsetX')
    const k = { value: 1, interp: 'EaseOut', hollow: false }
    expect(keyAreaHint({ row, key: k }, data).hint).toBe(`Offset X key, ${formatValue(row.prop, 1)}, Ease out`)
    expect(keyAreaHint({ row: L.byKey.get('t:1') }, data).hint).toContain('notes, for reference')
    expect(keyAreaHint(null, data)).toBeNull()
  })

  it('parent notes: rejected, nothing to keep, kept, a single keyed channel', () => {
    expect(parentResultNote({ changed: false, rejected: 'cycle' }, true)).toMatch(/loop/)
    expect(parentResultNote({ changed: true, uncompensated: [] }, true)).toMatch(/kept its place/)
    expect(parentResultNote({ changed: true, uncompensated: ['rotationDeg'] }, true)).toBe('Parent set. Rotation is keyed: it keeps its keys and may jump')
    expect(parentResultNote({ changed: true, keepOnScreenSkipped: 'not_placed' }, true)).toMatch(/no cell/)
    expect(parentResultNote({ changed: true }, false)).toBeNull()
  })
})

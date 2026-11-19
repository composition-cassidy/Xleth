// @vitest-environment jsdom
//
// Motion view key editing in the mounted view (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4,
// R5, R20, R21, R23): drags send NOTHING until pointerup and then ONE plan (one
// undo step across tracks), Escape cancels, marquee, Ctrl+Alt Nudge, double-click
// add, the key menu, the key commands, the graph (time + value, Bezier handles)
// and the mask row menu.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MotionView from './MotionView.jsx'
import { setMotionTickForTest } from './motionTick.js'
import { resetDoubleClick, setGestureFrameScheduler, singleSelectedTrack } from './motionGesture.js'
import { GRAPH_EMPTY_TEXT, hitTestGraph, resetGraphCache } from './motionGraph.js'
import { keyMenuItems } from './motionKeyMenu.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { fitGraphRange, graphYToValue, plotBand, valueToGraphY } from '../../motion/motionGraphModel.js'
import { propertyById } from '../../motion/schema.js'
import { resetSharedUndoGrouper } from '../timeline/undoGroup.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { fixtureData, fixtureLensRoam, fixturePatterns, fixtureTracks } from '../../motion/providers/__tests__/fixtures.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TICK = 1920
const W = 800
const H = 400
const K = (channel, pos, value, interp = 'Linear', anchor = 'Origin') => ({ channel, anchor, pos, value, interp })

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
let sizeDesc

const answer = (extra) => async (...args) => ({ changed: true, ...extra(...args) })

function mount({ data = fixtureData() } = {}) {
  ref = { current: null }
  act(() => {
    root.render(
      <MotionView
        ref={ref}
        tracks={fixtureTracks()}
        allTracks={fixtureTracks()}
        data={data}
        refresh={vi.fn()}
        adopt={vi.fn()}
        keyHost={host}
        ppbRef={{ current: 40 }}
        scrollOffsetRef={{ current: 0 }}
        snapGranularity="1/16"
        onFocusTrack={vi.fn()}
        onSeekTick={vi.fn()}
      />,
    )
  })
}

const stage = () => host.querySelector('[data-testid="motion-key-stage"]')
const rowOf = (key) => ref.current.layout().byKey.get(key)
const midY = (key) => { const r = rowOf(key); return r.y + r.height / 2 }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const ev = (type, init) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })

async function down(x, y, init = {}) {
  await act(async () => { stage().dispatchEvent(ev('pointerdown', { clientX: x, clientY: y, ...init })) })
}
async function move(x, y, init = {}) {
  await act(async () => { window.dispatchEvent(ev('pointermove', { clientX: x, clientY: y, buttons: 1, ...init })) })
}
async function up(x, y, init = {}) {
  await act(async () => { window.dispatchEvent(ev('pointerup', { clientX: x, clientY: y, ...init })) })
  await flush()
}
const ipcCalls = () => Object.values(tl).reduce((n, f) => n + f.mock.calls.length, 0)

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => canvasStub()
  sizeDesc = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => W })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => H })
  container = document.createElement('div')
  host = document.createElement('div')
  document.body.append(container, host)
  root = createRoot(container)
  useMotionViewStore.getState().reset({ all: true })
  resetSharedUndoGrouper()
  resetDoubleClick()
  resetGraphCache()
  setGestureFrameScheduler((cb) => { cb(); return 0 })
  playheadClock.positionBeatsValue = 2
  setMotionTickForTest(TICK)
  undo = { beginGroup: vi.fn(async () => 7), endGroup: vi.fn(async () => true) }
  tl = {
    setTrackRoam: vi.fn(answer((id, params) => ({ trackId: id, roam: params }))),
    setTrackRoamKeys: vi.fn(answer((id, keys) => ({ trackId: id, roam: {}, keys }))),
    setTrackSweepKeys: vi.fn(answer((id, keys) => ({ trackId: id, keys }))),
    setClipLensKeys: vi.fn(answer((id, keys) => ({ clipId: id, keys }))),
    setClipLens: vi.fn(answer((id, lens) => ({ clipId: id, lens }))),
    setHitCurve: vi.fn(answer((trackId, regionId, curve) => ({ trackId, regionId, hitCurve: curve.keys }))),
    setTrackLens: vi.fn(answer((trackId, regionId, lens) => ({ trackId, regionId, lens }))),
    setNotesLensKeys: vi.fn(async () => ({ changed: true, notes: [] })),
    setTrackMasks: vi.fn(answer((id, masks) => ({ trackId: id, masks }))),
  }
  window.xleth = { timeline: tl, undo }
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  host.remove()
  delete window.xleth
  playheadClock.positionBeatsValue = 0
  setGestureFrameScheduler(null)
  if (sizeDesc.w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sizeDesc.w)
  else delete HTMLElement.prototype.clientWidth
  if (sizeDesc.h) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizeDesc.h)
  else delete HTMLElement.prototype.clientHeight
  vi.restoreAllMocks()
  document.querySelectorAll('[data-xleth-menu]').forEach((m) => m.remove())
})

describe('dragging keys (5.4)', () => {
  it('nothing is sent while the pointer moves; pointerup sends ONE write; the selection follows the key', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await down(0, y)
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:0'])
    await move(10, y)
    await move(20, y)          // +480 ticks (40 px per beat)
    const draft = useMotionViewStore.getState().draft
    expect(draft.kind).toBe('move')
    expect(draft.keyTicks.get('r:1:offsetX:0')).toBe(480)
    expect(ipcCalls()).toBe(0)
    await up(20, y)
    expect(useMotionViewStore.getState().draft).toBeNull()
    expect(tl.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [K('offsetX', 480, 0), K('offsetX', 3840, 1)])
    expect(undo.beginGroup).not.toHaveBeenCalled()       // one write: one undo entry already
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:480'])
  })

  it('the moved key stays where it was dropped until the engine answers (no flash back)', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    let resolve
    tl.setTrackRoamKeys.mockImplementationOnce((id, keys) => new Promise((r) => { resolve = () => r({ changed: true, trackId: id, roam: {}, keys }) }))
    const y = midY('t:1/roam/roam.offsetX')
    await down(0, y)
    await move(20, y)
    await up(20, y)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    expect(useMotionViewStore.getState().draft?.keyTicks.get('r:1:offsetX:0')).toBe(480)
    resolve()
    await flush()
    expect(useMotionViewStore.getState().draft).toBeNull()
  })

  it('snaps to a note-on of the key\'s track within 8 px; Alt moves freely', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await down(160, y)                      // the key at 3840
    await move(119, y)                      // 2856 ticks: the note-off at 2880 is 1 px away
    expect(useMotionViewStore.getState().draft.snapTick).toBe(2880)
    await move(119, y, { altKey: true })
    expect(useMotionViewStore.getState().draft.keyTicks.get('r:1:offsetX:3840')).toBe(2856)
    await up(119, y, { altKey: true })
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [K('offsetX', 0, 0), K('offsetX', 2856, 1)])
  })

  it('a drag across tracks and kinds is ONE runMotionPlan: one undo group, one write per list', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam', 't:2', 't:2/lens'])
    mount()
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:0', { kind: 'roam', trackId: 1, channel: 'offsetX', pos: 0 }], ['c:30:zoom:0', { kind: 'clipLens', trackId: 2, clipId: 30, channel: 'zoom', pos: 0 }]])
    const y = midY('t:1/roam/roam.offsetX')
    await down(0, y)
    await move(20, y)
    expect(ipcCalls()).toBe(0)
    await up(20, y)
    expect(undo.beginGroup).toHaveBeenCalledTimes(1)
    expect(undo.endGroup).toHaveBeenCalledTimes(1)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [K('offsetX', 480, 0), K('offsetX', 3840, 1)])
    expect(tl.setClipLensKeys).toHaveBeenCalledWith(30, [K('zoom', 480, 1), K('zoom', 1920, 2)])
  })

  it('Escape cancels the drag: the draft goes and nothing is sent', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await down(0, y)
    await move(30, y)
    expect(useMotionViewStore.getState().draft).not.toBeNull()
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { window.dispatchEvent(esc) })
    expect(esc.defaultPrevented).toBe(true)
    expect(useMotionViewStore.getState().draft).toBeNull()
    await up(30, y)
    expect(ipcCalls()).toBe(0)
    // The selection survives the cancel (Escape only cancelled the gesture).
    expect(useMotionViewStore.getState().keySel.has('r:1:offsetX:0')).toBe(true)
  })

  it('Escape routed through the key map (store.escape) also cancels', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await down(0, y)
    await move(30, y)
    expect(ref.current.handleKeyCommand({ id: 'escape' })).toBe(true)
    await up(30, y)
    expect(ipcCalls()).toBe(0)
  })

  it('a plain click on one key of a multi-selection narrows to it on release (no move = no write)', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:0', {}], ['r:1:offsetX:3840', {}]])
    const y = midY('t:1/roam/roam.offsetX')
    await down(160, y)
    await up(160, y)
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:3840'])
    expect(ipcCalls()).toBe(0)
  })

  it('Ctrl toggles a key without dragging; Shift adds', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await down(0, y); await up(0, y)
    await down(160, y, { shiftKey: true }); await up(160, y, { shiftKey: true })
    expect(useMotionViewStore.getState().keySel.size).toBe(2)
    await down(0, y, { ctrlKey: true }); await up(0, y, { ctrlKey: true })
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:3840'])
  })
})

describe('marquee, summary keys, double-click', () => {
  it('a marquee across rows selects the keys inside it; Shift adds to the selection', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const oy = midY('t:1/roam/roam.offsetX')
    await down(60, oy)
    await move(170, midY('t:1/roam/roam.offsetY'))
    expect(useMotionViewStore.getState().draft.kind).toBe('marquee')
    await up(170, midY('t:1/roam/roam.offsetY'))
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:3840'])
    await down(-15, oy - 6, { shiftKey: true })   // 15 px left of the key at 0: empty space
    await move(8, oy + 2, { shiftKey: true })
    await up(8, oy + 2, { shiftKey: true })
    expect([...useMotionViewStore.getState().keySel.keys()].sort()).toEqual(['r:1:offsetX:0', 'r:1:offsetX:3840'])
    expect(ipcCalls()).toBe(0)
  })

  it('a click on empty space clears the selection', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:0', {}]])
    const y = midY('t:1/roam/roam.offsetY')
    await down(300, y); await up(300, y)
    expect(useMotionViewStore.getState().keySel.size).toBe(0)
  })

  it('a summary key selects and drags every key behind it', async () => {
    mount()
    const y = rowOf('t:1').y + rowOf('t:1').height - 5
    await down(0, y)
    expect([...useMotionViewStore.getState().keySel.keys()].sort()).toEqual(['h:1:100:zoom:Head:0@0', 'm:1:1:feather:0', 'r:1:offsetX:0'])
    await move(10, y)
    await up(10, y)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    expect(tl.setTrackMasks).toHaveBeenCalledTimes(1)
    expect(tl.setHitCurve).toHaveBeenCalledTimes(1)
    expect(undo.beginGroup).toHaveBeenCalledTimes(1)
  })

  it('double-click on empty space of an animated row adds a key with the curve value; a static row only hints', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await down(80, y); await up(80, y)
    await down(80, y); await up(80, y)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    expect(tl.setTrackRoamKeys.mock.calls[0][1]).toContainEqual(K('offsetX', 1920, 0.5))
    const sy = midY('t:1/roam/roam.offsetY')
    await down(80, sy); await up(80, sy)
    await down(80, sy); await up(80, sy)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledTimes(1)
  })
})

describe('hollow keys (R5)', () => {
  it('a plain drag of a hollow key edits the hit curve (every note follows)', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/lens'])
    mount()
    const y = midY('t:1/lens/sourceLens.zoom')
    await down(0, y)                      // the hit key Head 0 under note 1 (0)
    await move(10, y, { altKey: true })   // past the 3 px slop...
    await move(1.5, y, { altKey: true })  // ...then back to +36 ticks, free
    await up(1.5, y, { altKey: true })
    expect(tl.setHitCurve).toHaveBeenCalledWith(1, 100, { keys: [K('zoom', 36, 1.35, 'EaseOut', 'Head'), K('zoom', 120, 1, 'Linear', 'Head')] })
    expect(tl.setNotesLensKeys).not.toHaveBeenCalled()
  })

  it('Ctrl+Alt at pointer-down writes a Nudge key on that note only', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/lens'])
    mount()
    const y = midY('t:1/lens/sourceLens.zoom')
    await down(0, y, { ctrlKey: true, altKey: true })
    await up(0, y, { ctrlKey: true, altKey: true })
    expect(tl.setNotesLensKeys).toHaveBeenCalledWith([{ patternId: 10, noteId: 1, keys: [K('zoom', 0, 1, 'EaseOut', 'Head')] }])
    expect(tl.setHitCurve).not.toHaveBeenCalled()
  })

  it('Ctrl+Alt drag on a chord note places the Nudge key in THAT note (chord notes share the hit key id)', async () => {
    const lr = fixtureLensRoam()
    lr.sources[0].hitCurve = [K('zoom', 0, 1.35, 'EaseOut', 'Head'), K('zoom', 0, 1, 'Linear', 'Tail')]
    const patterns = fixturePatterns()
    patterns[10].notes.push({ id: 3, positionTicks: 0, durationTicks: 480, pitch: 64 })   // a chord with note 1 (960)
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/lens'])
    mount({ data: fixtureData({ lensRoam: lr, patterns }) })
    const y = midY('t:1/lens/sourceLens.zoom')
    const mods = { ctrlKey: true, altKey: true }
    await down(20, y, mods)          // the Tail key under the 480-tick note (tick 480)
    await move(15, y, mods)          // -120 ticks: snaps one 1/16 step back from the note end
    await up(15, y, mods)
    expect(tl.setNotesLensKeys).toHaveBeenCalledTimes(1)
    const [entry] = tl.setNotesLensKeys.mock.calls[0][0]
    expect(entry.noteId).toBe(3)
    expect(entry.keys.map((k) => [k.anchor, k.pos])).toEqual([['Tail', 240]])
    expect(tl.setHitCurve).not.toHaveBeenCalled()
  })

  it('Left on two selected Head keys at the zone start holds them (no merge, no write) and the hit curve keeps both', async () => {
    mount()
    useMotionViewStore.getState().selectKeys([['h:1:100:zoom:Head:0@0', {}], ['h:1:100:zoom:Head:120@0', {}]])
    expect(ref.current.handleKeyCommand({ id: 'nudge', direction: -1, fine: false })).toBe(true)
    await flush()
    expect(tl.setHitCurve).not.toHaveBeenCalled()
    expect(useMotionViewStore.getState().keySel.size).toBe(2)
  })
})

describe('the key menu', () => {
  it('right-click selects the key and offers interp, Bezier presets, Copy, Paste, Delete', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam'])
    mount()
    const y = midY('t:1/roam/roam.offsetX')
    await act(async () => { stage().dispatchEvent(ev('contextmenu', { clientX: 0, clientY: y, button: 2 })) })
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:0'])
    const menu = document.querySelector('[data-xleth-menu]')
    expect(menu).toBeTruthy()
    const labels = [...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent)
    expect(labels).toEqual(['Hold', 'Linear', 'Ease out', 'Bezier: Smooth', 'Bezier: Ease in', 'Bezier: Ease out', 'Bezier: Overshoot',
      'Copy key', 'Paste keys at the playhead', 'Delete key'])
    expect(labels).not.toContain('Nudge this note')
    const smooth = [...menu.querySelectorAll('[role^="menuitem"]')].find((b) => b.textContent === 'Bezier: Smooth')
    await act(async () => { smooth.click() })
    await flush()
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [{ ...K('offsetX', 0, 0, 'Bezier'), bez: [0.42, 0, 0.58, 1] }, K('offsetX', 3840, 1)])
    expect(document.querySelector('[data-xleth-menu]')).toBeNull()
  })

  it('a hollow key adds "Nudge this note"', () => {
    const on = { interp: vi.fn(), copy: vi.fn(), paste: vi.fn(), remove: vi.fn(), nudgeNote: vi.fn() }
    const hollow = { id: 'h', hollow: true, interp: 'Linear', ref: { kind: 'hit', trackId: 1, regionId: 100, channel: 'zoom', anchor: 'Head', pos: 0 } }
    const items = keyMenuItems({ instances: [hollow], hitKey: hollow, canPaste: false, on })
    const nudge = items.find((i) => i.id === 'nudgeNote')
    expect(nudge.label).toBe('Nudge this note')
    nudge.onSelect()
    expect(on.nudgeNote).toHaveBeenCalledWith(hollow)
    expect(items.find((i) => i.id === 'paste').disabled).toBe(true)
    expect(items.find((i) => i.id === 'interp:Linear').checked).toBe(true)
  })
})

describe('key commands (R20)', () => {
  it('Delete removes the selected keys in one plan; with nothing selected the key is not claimed', async () => {
    mount()
    expect(ref.current.handleKeyCommand({ id: 'delete' })).toBe(false)
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:0', {}], ['r:1:offsetX:3840', {}], ['s:1:zoom:960', {}]])
    expect(ref.current.handleKeyCommand({ id: 'delete' })).toBe(true)
    await flush()
    // The last Offset X keys going: the base takes the value at the playhead (R3).
    expect(tl.setTrackRoam).toHaveBeenCalledWith(1, { offsetX: 0.5 })
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [])
    expect(tl.setTrackSweepKeys).toHaveBeenCalledWith(1, [])
    expect(undo.beginGroup).toHaveBeenCalledTimes(1)
    expect(useMotionViewStore.getState().keySel.size).toBe(0)
  })

  it('Ctrl+C then Ctrl+V pastes at the playhead; the one selected track is the target', async () => {
    mount()
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:0', {}], ['r:1:offsetX:3840', {}]])
    expect(ref.current.handleKeyCommand({ id: 'copy' })).toBe(true)
    expect(useMotionViewStore.getState().clipboard.entries).toHaveLength(2)
    act(() => { useMotionViewStore.getState().selectRow('t:3', 'replace') })
    expect(ref.current.handleKeyCommand({ id: 'paste' })).toBe(true)
    await flush()
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(3, [K('offsetX', 1920, 0), K('offsetX', 5760, 1)])
  })

  it('Ctrl+V with an empty clipboard claims the key, sends nothing and says why', async () => {
    mount()
    const hints = []
    const on = (e) => hints.push(e.detail?.hint)
    window.addEventListener('xleth-hint-refresh', on)
    expect(ref.current.handleKeyCommand({ id: 'paste' })).toBe(true)
    window.removeEventListener('xleth-hint-refresh', on)
    expect(ipcCalls()).toBe(0)
    expect(hints).toContain('Nothing to paste: copy some keys first (Ctrl+C)')
  })

  it('Ctrl+X cuts (copy + delete, one plan)', async () => {
    mount()
    useMotionViewStore.getState().selectKeys([['s:1:zoom:960', {}]])
    expect(ref.current.handleKeyCommand({ id: 'cut' })).toBe(true)
    await flush()
    expect(useMotionViewStore.getState().clipboard.entries[0].propId).toBe('sweep.zoom')
    expect(tl.setTrackSweepKeys).toHaveBeenCalledWith(1, [])
  })

  it('Left / Right nudge one grid step, Shift a quarter step; the selection follows', async () => {
    mount()
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:3840', {}]])
    expect(ref.current.handleKeyCommand({ id: 'nudge', direction: 1, fine: false })).toBe(true)
    await flush()
    expect(tl.setTrackRoamKeys).toHaveBeenLastCalledWith(1, [K('offsetX', 0, 0), K('offsetX', 4080, 1)])
    expect([...useMotionViewStore.getState().keySel.keys()]).toEqual(['r:1:offsetX:4080'])
    useMotionViewStore.getState().selectKeys([['r:1:offsetX:3840', {}]])
    ref.current.handleKeyCommand({ id: 'nudge', direction: -1, fine: true })
    await flush()
    expect(tl.setTrackRoamKeys).toHaveBeenLastCalledWith(1, [K('offsetX', 0, 0), K('offsetX', 3780, 1)])
  })

  it('the paste target: exactly one selected track, else each key\'s own', () => {
    expect(singleSelectedTrack(new Set(['t:3', 't:3/roam']))).toBe(3)
    expect(singleSelectedTrack(new Set(['t:3', 't:1/roam']))).toBeNull()
    expect(singleSelectedTrack(new Set())).toBeNull()
  })
})

describe('graph mode (R21)', () => {
  function graphView() {
    return ref.current.context().canvas.view()
  }

  it('no curves until an animated row is selected (the empty state)', () => {
    mount()
    act(() => { useMotionViewStore.getState().setGraph(true) })
    expect(hitTestGraph(graphView(), 10, 10)).toBeNull()
    expect(GRAPH_EMPTY_TEXT).toMatch(/select animated property rows/)
  })

  it('a key drags in time AND value; one write on pointerup', async () => {
    mount()
    const s = useMotionViewStore.getState()
    act(() => {
      s.selectRow('t:1/roam/roam.offsetX', 'replace')
      s.setGraph(true)
    })
    const range = fitGraphRange(propertyById('roam.offsetX'), [0, 1])
    const band = plotBand(H)
    const y0 = valueToGraphY(range, band, 0)
    expect(hitTestGraph(graphView(), 1, y0).kind).toBe('key')
    await down(1, y0)
    await move(21, y0 - 46)
    expect(ipcCalls()).toBe(0)
    await up(21, y0 - 46)
    const v = graphYToValue(range, band, y0 - 46)
    expect(tl.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    const [id, keys] = tl.setTrackRoamKeys.mock.calls[0]
    expect(id).toBe(1)
    expect(keys[0].pos).toBe(480)
    expect(keys[0].value).toBeCloseTo(v, 9)
    expect(keys[1]).toEqual(K('offsetX', 3840, 1))
  })

  it('a straight vertical drag changes the value only: an off-grid key keeps its tick', async () => {
    const lr = fixtureLensRoam()
    lr.tracks[0].keys = [K('offsetX', 1000, 0), K('offsetX', 3840, 1)]
    mount({ data: fixtureData({ lensRoam: lr }) })
    const s = useMotionViewStore.getState()
    act(() => {
      s.selectRow('t:1/roam/roam.offsetX', 'replace')
      s.setGraph(true)
    })
    const range = fitGraphRange(propertyById('roam.offsetX'), [0, 1])
    const band = plotBand(H)
    const x = 1000 / 24            // 40 px per beat: 24 ticks per px; the note-off at 960 is 1.7 px away
    const y0 = valueToGraphY(range, band, 0)
    expect(hitTestGraph(graphView(), x, y0).kind).toBe('key')
    await down(x, y0)
    await move(x + 1, y0 - 30)     // under the sideways slop
    expect(useMotionViewStore.getState().draft.keyTicks.get('r:1:offsetX:1000')).toBe(1000)
    await up(x + 1, y0 - 30)
    const keys = tl.setTrackRoamKeys.mock.calls[0][1]
    expect(keys[0].pos).toBe(1000)
    expect(keys[0].value).toBeCloseTo(graphYToValue(range, band, y0 - 30), 9)
  })

  it('the handles of a selected Bezier key reshape its segment ([x1, y1, x2, y2] on the leaving key)', async () => {
    const lr = fixtureLensRoam()
    lr.tracks[0].keys = [{ ...K('offsetX', 0, 0, 'Bezier'), bez: [0.42, 0, 0.58, 1] }, K('offsetX', 3840, 1)]
    mount({ data: fixtureData({ lensRoam: lr }) })
    const s = useMotionViewStore.getState()
    act(() => {
      s.selectRow('t:1/roam/roam.offsetX', 'replace')
      s.selectKeys([['r:1:offsetX:0', {}]])
      s.setGraph(true)
    })
    const range = fitGraphRange(propertyById('roam.offsetX'), [0, 1])
    const band = plotBand(H)
    const hy = valueToGraphY(range, band, 0)
    const hit = hitTestGraph(graphView(), 67.2, hy)
    expect(hit.kind).toBe('handle')
    expect(hit.which).toBe(1)
    await down(67.2, hy)
    await move(80, valueToGraphY(range, band, 0.5))
    expect(useMotionViewStore.getState().draft.bez.get('r:1:offsetX:0')).toEqual([0.5, 0.5, 0.58, 1])
    expect(ipcCalls()).toBe(0)
    await up(80, valueToGraphY(range, band, 0.5))
    expect(tl.setTrackRoamKeys).toHaveBeenCalledWith(1, [{ ...K('offsetX', 0, 0, 'Bezier'), bez: [0.5, 0.5, 0.58, 1] }, K('offsetX', 3840, 1)])
  })
})

describe('mask rows', () => {
  const openMaskMenu = async () => {
    const row = container.querySelector('[data-testid="motion-row-t:1/mask:1"]')
    await act(async () => { row.dispatchEvent(ev('contextmenu', { clientX: 10, clientY: 10, button: 2 })) })
    return document.querySelector('[data-xleth-menu]')
  }
  const item = (menu, text) => [...menu.querySelectorAll('[role^="menuitem"]')].find((b) => b.textContent.startsWith(text))

  it('right-click: Rename, Duplicate, Move up / down (disabled at the ends), Delete', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam', 't:1/roam/masks'])
    mount()
    const menu = await openMaskMenu()
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent))
      .toEqual(['Rename', 'Duplicate', 'Move up', 'Move down', 'Delete'])
    expect(item(menu, 'Move up').getAttribute('aria-disabled')).toBe('true')
    expect(item(menu, 'Move down').getAttribute('aria-disabled')).toBe('true')
    await act(async () => { item(menu, 'Duplicate').click() })
    await flush()
    const [trackId, masks] = tl.setTrackMasks.mock.calls[0]
    expect(trackId).toBe(1)
    expect(masks.map((m) => [m.id, m.name])).toEqual([[1, 'Mask 1'], [2, 'Mask 1 copy']])
    expect(masks[1].keys).toEqual(masks[0].keys)
    expect(useMotionViewStore.getState().selectedMask).toEqual({ trackId: 1, maskId: 2 })
  })

  it('Duplicate is disabled at the cap and says why (R15)', async () => {
    const lr = fixtureLensRoam()
    const m = lr.tracks[0].masks[0]
    lr.tracks[0].masks = Array.from({ length: 8 }, (_, i) => ({ ...m, id: i + 1, name: `Mask ${i + 1}` }))
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam', 't:1/roam/masks'])
    mount({ data: fixtureData({ lensRoam: lr }) })
    const menu = await openMaskMenu()
    const dup = item(menu, 'Duplicate')
    expect(dup.getAttribute('aria-disabled')).toBe('true')
    expect(dup.textContent).toBe('Duplicate: A track holds at most 8 masks')
    expect(item(menu, 'Move down').getAttribute('aria-disabled')).toBeNull()
    await act(async () => { item(menu, 'Move down').click() })
    await flush()
    expect(tl.setTrackMasks.mock.calls[0][1].map((x) => x.id)).toEqual([2, 1, 3, 4, 5, 6, 7, 8])
  })

  it('double-click the name to rename; Enter writes it, Escape keeps it', async () => {
    useMotionViewStore.getState().setExpandedRows(['t:1', 't:1/roam', 't:1/roam/masks'])
    mount()
    const label = () => container.querySelector('[data-testid="motion-row-t:1/mask:1"] [role="button"]')
    await act(async () => { label().dispatchEvent(ev('dblclick')) })
    let input = container.querySelector('[data-testid="motion-mask-name-t:1/mask:1"]')
    expect(input).toBeTruthy()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setValue.call(input, '  Window  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await flush()
    expect(tl.setTrackMasks).toHaveBeenCalledTimes(1)
    expect(tl.setTrackMasks.mock.calls[0][1][0].name).toBe('Window')
    // Escape: no write.
    await act(async () => { label().dispatchEvent(ev('dblclick')) })
    input = container.querySelector('[data-testid="motion-mask-name-t:1/mask:1"]')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await flush()
    expect(tl.setTrackMasks).toHaveBeenCalledTimes(1)
  })
})

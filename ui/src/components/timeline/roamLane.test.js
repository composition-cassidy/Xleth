// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTrackLayout } from './timelineRowLayout.js'
import { drawRoamLanes } from './roamLaneDrawing.js'
import { beginRoamLaneGesture, removeKeyAt } from './roamLaneGesture.js'
import {
  ROAM_KEY_HIT_R, hitTestRoamLane, keyPixel, laneRangeFor, roamLaneHeight, roamLaneInner,
} from './roamLaneModel.js'
import { TRACK_HEIGHT, tickToPixel } from '../../constants/timeline.js'
import { TICKS_PER_BAR } from '../../lensRoam/roamKeyModel.js'

const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })
const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern' },
  { id: 2, name: 'Drums', type: 'Pattern' },
]
const SCROLL = 0
const PPB = 40           // px per beat: a bar is 160px, a tick is 40/960 px

describe('Roam lane row', () => {
  it('sits directly under its track (and under its Reel lane) and pushes later tracks down', () => {
    const layout = buildTrackLayout({ tracks, roamLanes: { 1: true } })
    expect(layout.rows.map((r) => r.rowType)).toEqual(['track', 'roam', 'track'])
    const [t1, roam, t2] = layout.rows
    expect(roam.y).toBe(t1.y + TRACK_HEIGHT)
    expect(roam.height).toBe(roamLaneHeight(TRACK_HEIGHT))
    expect(roam.parentTrackId).toBe(1)
    expect(t2.y).toBe(roam.y + roam.height)

    const both = buildTrackLayout({ tracks, reelLanes: { 1: { subRows: 1 } }, roamLanes: { 1: true } })
    expect(both.rows.map((r) => r.rowType)).toEqual(['track', 'reel', 'roam', 'track'])
  })

  it('a track without a lane is unchanged', () => {
    const plain = buildTrackLayout({ tracks })
    const same = buildTrackLayout({ tracks, roamLanes: {} })
    expect(same.rows.map((r) => r.y)).toEqual(plain.rows.map((r) => r.y))
    expect(plain.getRoamRows()).toEqual([])
  })

  it('the lane resolves to no track, so no tool can act on the parent through it', () => {
    const layout = buildTrackLayout({ tracks, roamLanes: { 1: true } })
    const roam = layout.getRoamRows()[0]
    expect(layout.trackIndexAtY(roam.y + 2)).toBe(-1)
    expect(layout.roamRowAtY(roam.y + 2)).toBe(roam)
    expect(layout.roamRowAtY(roam.y - 1)).toBeNull()
    expect(layout.trackIndexAtY(roam.y + roam.height + 1)).toBe(1)
  })

  it('a collapsed track hides its lane with it; height scales with the track height', () => {
    expect(buildTrackLayout({ tracks, collapsed: new Set([1]), roamLanes: { 1: true } }).getRoamRows()).toEqual([])
    expect(roamLaneHeight(72)).toBe(2 * roamLaneHeight(36))
    expect(roamLaneHeight(24)).toBeGreaterThanOrEqual(48)
  })
})

describe('hit test', () => {
  const layout = buildTrackLayout({ tracks, roamLanes: { 1: true } })
  const row = layout.getRoamRows()[0]
  const KEYS = [K('offsetX', 0, 0), K('offsetX', 2 * TICKS_PER_BAR, 1), K('scale', 960, 2)]
  const dataOf = () => ({ base: { offsetX: 0, scale: 1 }, keys: KEYS })
  const hit = (x, y, channel = 'offsetX') =>
    hitTestRoamLane({ trackLayout: layout, dataOf, channelOf: () => channel }, x, y, SCROLL, PPB)

  it('outside every lane: null', () => {
    expect(hit(50, row.y - 5)).toBeNull()
    expect(hit(50, row.y + row.height + 5)).toBeNull()
  })

  it('finds a key of the lane channel within the hit radius, and only that channel', () => {
    const range = laneRangeFor('offsetX', KEYS, dataOf().base)
    const p = keyPixel(KEYS[1], row, range, SCROLL, PPB)
    const h = hit(p.x + 3, p.y - 3)
    expect(h.key).toBe(KEYS[1])
    expect(h.trackId).toBe(1)
    expect(hit(p.x + ROAM_KEY_HIT_R + 4, p.y).key).toBeNull()
    // the scale key at tick 960 is another channel: invisible to the Offset X lane
    const s = keyPixel(KEYS[2], row, laneRangeFor('scale', KEYS, dataOf().base), SCROLL, PPB)
    expect(hit(s.x, s.y, 'offsetX').key).toBeNull()
    expect(hit(s.x, s.y, 'scale').key).toBe(KEYS[2])
  })

  it('empty space reports the tick and value under the pointer', () => {
    const inner = roamLaneInner(row)
    const h = hit(tickToPixel(1920, SCROLL, PPB), inner.top + inner.height / 2)
    expect(h.key).toBeNull()
    expect(h.tick).toBeCloseTo(1920, 3)
    expect(h.value).toBeCloseTo(0, 1)          // the middle of a symmetric lane
  })
})

describe('gesture: local preview, ONE commit', () => {
  const layout = buildTrackLayout({ tracks, roamLanes: { 1: true } })
  const row = layout.getRoamRows()[0]
  let calls
  let rafs
  beforeEach(() => {
    calls = { draft: [], clear: 0, commit: [], select: [] }
    rafs = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { rafs.push(cb); return rafs.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })
  const flushRaf = () => { const q = rafs; rafs = []; q.forEach((cb) => cb(0)) }

  const start = (keys, x, y, { channel = 'offsetX', altKey = false } = {}) => {
    const data = { base: { offsetX: 0 }, keys }
    const hit = hitTestRoamLane(
      { trackLayout: layout, dataOf: () => data, channelOf: () => channel }, x, y, SCROLL, PPB)
    const ev = new MouseEvent('mousedown', { clientX: x, clientY: y, altKey, button: 0 })
    return beginRoamLaneGesture({
      event: ev, hit, data,
      view: () => ({ scrollOffset: SCROLL, ppb: PPB }),
      localOf: (e) => ({ localX: e.clientX, localY: e.clientY }),
      granularity: () => 'Beat',
      setDraft: (k) => calls.draft.push(k),
      clearDraft: () => { calls.clear++ },
      commit: (k) => { calls.commit.push(k); return Promise.resolve({}) },
      select: (s) => calls.select.push(s),
    })
  }
  const move = (x, y, mods = {}) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, ...mods }))
  const up = (x, y, mods = {}) => window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, ...mods }))

  it('a click on empty lane adds ONE key, snapped to the grid, in one commit', () => {
    const inner = roamLaneInner(row)
    const x = tickToPixel(1000, SCROLL, PPB)     // 1000 ticks snaps to the beat grid: 960
    const y = inner.top + inner.height * 0.25    // a quarter of the way down: a positive value
    start([], x, y)
    expect(calls.draft).toHaveLength(1)          // the new key shows at once (local)
    expect(calls.commit).toHaveLength(0)         // ... and nothing is sent yet
    up(x, y)
    expect(calls.commit).toHaveLength(1)
    const keys = calls.commit[0]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ channel: 'offsetX', anchor: 'Origin', pos: 960, interp: 'Linear' })
    expect(keys[0].value).toBeGreaterThan(0)
    expect(calls.select.at(-1)).toMatchObject({ trackId: 1, channel: 'offsetX', pos: 960 })
  })

  it('dragging a key previews locally (one draft per frame) and commits once, on mouseup', () => {
    const KEYS = [K('offsetX', 0, 0), K('offsetX', 1920, 1)]
    const range = laneRangeFor('offsetX', KEYS, { offsetX: 0 })
    const p = keyPixel(KEYS[1], row, range, SCROLL, PPB)
    start(KEYS, p.x, p.y)
    expect(calls.draft).toHaveLength(0)
    for (let i = 1; i <= 10; i++) move(p.x + i * 3, p.y)      // ten moves ...
    flushRaf()
    expect(calls.draft).toHaveLength(1)                       // ... one preview per frame
    expect(calls.commit).toHaveLength(0)                      // never an engine call during the drag
    up(p.x + 30, p.y)
    expect(calls.commit).toHaveLength(1)                      // ONE commit
    const moved = calls.commit[0].find((k) => k.channel === 'offsetX' && k.pos !== 0)
    expect(moved.pos).toBeGreaterThan(1920)                   // moved later in time
    expect(moved.pos % 960).toBe(0)                           // snapped to the beat grid
    expect(calls.commit[0]).toHaveLength(2)
  })

  it('Alt bypasses the snap', () => {
    const KEYS = [K('offsetX', 1920, 1)]
    const range = laneRangeFor('offsetX', KEYS, { offsetX: 0 })
    const p = keyPixel(KEYS[0], row, range, SCROLL, PPB)
    start(KEYS, p.x, p.y)
    move(p.x + 5, p.y, { altKey: true })
    up(p.x + 5, p.y, { altKey: true })
    expect(calls.commit[0][0].pos % 960).not.toBe(0)
  })

  it('Shift moves the value a quarter as far', () => {
    const KEYS = [K('offsetX', 1920, 0.5)]
    const range = laneRangeFor('offsetX', KEYS, { offsetX: 0 })
    const p = keyPixel(KEYS[0], row, range, SCROLL, PPB)
    const run = (shiftKey) => {
      calls.commit = []
      start(KEYS, p.x, p.y)
      move(p.x, p.y - 8, { shiftKey })
      up(p.x, p.y - 8, { shiftKey })
      return calls.commit[0][0].value
    }
    const full = run(false) - 0.5
    const fine = run(true) - 0.5
    expect(full).toBeGreaterThan(0)
    expect(fine).toBeCloseTo(full / 4, 6)
  })

  it('Escape cancels: nothing committed, the draft cleared', () => {
    const KEYS = [K('offsetX', 1920, 1)]
    const range = laneRangeFor('offsetX', KEYS, { offsetX: 0 })
    const p = keyPixel(KEYS[0], row, range, SCROLL, PPB)
    start(KEYS, p.x, p.y)
    move(p.x + 40, p.y + 5)
    flushRaf()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    up(p.x + 40, p.y + 5)
    expect(calls.commit).toHaveLength(0)
    expect(calls.clear).toBeGreaterThanOrEqual(1)
  })

  it('a click on an existing key (no drag) selects it and sends nothing', () => {
    const KEYS = [K('offsetX', 1920, 1)]
    const range = laneRangeFor('offsetX', KEYS, { offsetX: 0 })
    const p = keyPixel(KEYS[0], row, range, SCROLL, PPB)
    start(KEYS, p.x, p.y)
    up(p.x, p.y)
    expect(calls.commit).toHaveLength(0)
    expect(calls.select[0]).toMatchObject({ trackId: 1, channel: 'offsetX', pos: 1920 })
  })

  it('a drag that ends where it began sends nothing', () => {
    const KEYS = [K('offsetX', 1920, 1)]
    const range = laneRangeFor('offsetX', KEYS, { offsetX: 0 })
    const p = keyPixel(KEYS[0], row, range, SCROLL, PPB)
    start(KEYS, p.x, p.y)
    move(p.x + 20, p.y)
    move(p.x, p.y)
    up(p.x, p.y)
    expect(calls.commit).toHaveLength(0)
  })

  it('removeKeyAt drops exactly the key under the pointer (right-click delete)', () => {
    const KEYS = [K('offsetX', 0, 0), K('offsetX', 960, 1), K('scale', 960, 2)]
    expect(removeKeyAt(KEYS, KEYS[1])).toEqual([KEYS[0], KEYS[2]])
    expect(removeKeyAt(KEYS, K('offsetX', 5, 5))).toBeNull()
  })
})

describe('painter', () => {
  const layout = buildTrackLayout({ tracks, roamLanes: { 1: true } })
  const ctxStub = () => {
    const calls = []
    const target = {}
    return new Proxy(target, {
      get(_t, name) {
        if (name === 'calls') return calls
        if (name === 'measureText') return () => ({ width: 30 })
        return (...a) => { calls.push([String(name), ...a]) }
      },
      set(_t, name, value) { calls.push(['set:' + String(name), value]); return true },
    })
  }
  const PALETTE = { ink: '#fff', inkDark: '#000', select: '#0af', roamAxis: '#444', roamLine: '#888', roamLabel: '#999' }
  const run = (data) => {
    const ctx = ctxStub()
    drawRoamLanes({
      ctx, w: 800, h: 400, scrollOffset: 0, ppb: PPB, trackLayout: layout, palette: PALETTE,
      trackColorById: { 1: '#f80' }, mutedTrackIds: new Set(),
    }, data)
    return ctx.calls
  }

  it('an unkeyed lane draws the dashed base line and the one hint it needs', () => {
    const calls = run({ dataOf: () => ({ base: { offsetX: 0 }, keys: [] }), channelOf: () => 'offsetX', selected: null })
    expect(calls.some((c) => c[0] === 'setLineDash' && c[1].length > 0)).toBe(true)
    expect(calls.some((c) => c[0] === 'fillText' && /Click to add/.test(c[1]))).toBe(true)
  })

  it('a keyed lane draws a curve and one shape per key; a Hold key is a square, a Linear key a circle', () => {
    const keys = [K('offsetX', 0, 0, 'Hold'), K('offsetX', 960, 1, 'Linear'), K('offsetX', 1920, 0, 'EaseOut')]
    const calls = run({ dataOf: () => ({ base: { offsetX: 0 }, keys }), channelOf: () => 'offsetX', selected: null })
    expect(calls.filter((c) => c[0] === 'arc').length).toBe(1)        // the Linear key
    expect(calls.filter((c) => c[0] === 'rect').length).toBe(1 + 1)   // the Hold key + the lane's clip rect
    expect(calls.some((c) => c[0] === 'stroke')).toBe(true)
  })

  it('the curve and the keys take the track colour', () => {
    const keys = [K('offsetX', 0, 0), K('offsetX', 960, 1)]
    const calls = run({ dataOf: () => ({ base: { offsetX: 0 }, keys }), channelOf: () => 'offsetX', selected: null })
    expect(calls.filter((c) => c[0] === 'set:strokeStyle' && c[1] === '#f80').length).toBeGreaterThanOrEqual(1)   // the curve
    expect(calls.filter((c) => c[0] === 'set:fillStyle' && c[1] === '#f80').length).toBe(2)                         // one fill per key
  })

  it('the selected key prints its value on a chip', () => {
    const keys = [K('offsetX', 960, 1.25)]
    const calls = run({
      dataOf: () => ({ base: { offsetX: 0 }, keys }), channelOf: () => 'offsetX',
      selected: { trackId: 1, channel: 'offsetX', pos: 960 },
    })
    expect(calls.some((c) => c[0] === 'fillText' && /1\.25/.test(c[1]))).toBe(true)
  })

  it('a lane for a track with no data still draws (it is the unkeyed lane)', () => {
    expect(() => run({ dataOf: () => undefined, channelOf: () => 'scale', selected: null })).not.toThrow()
  })
})

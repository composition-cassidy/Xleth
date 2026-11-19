// @vitest-environment jsdom
// Bezier segments and the multi-selection on the Roam / Sweep key lanes: the JS port
// of KeyCurve.h's Bezier (pinned to the same numbers as engine/test/test_key_curve.cpp
// [10]), the batch op, the selection helpers, the lane's handles and marquee, the
// handle gesture and the right-click menu.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { laneLayout } from './__tests__/fixtures/roamLaneLayout.js'
import { drawRoamLanes } from './roamLaneDrawing.js'
import { beginBezierHandleGesture, beginRoamMarqueeGesture } from './roamLaneGesture.js'
import { hitTestRoamLane, keyPixel, keysInMarquee, laneBezierSegments, laneKeys, laneRangeFor } from './roamLaneModel.js'
import { roamKeyMenuItems } from './roamKeyMenu.js'
import {
  DEFAULT_BEZ, applyKeyOp, bezierEase, interpOp, keyEquals, makeKey, sanitizeBez, segmentEase, valueAtEvent,
} from '../../lensRoam/lensKeyModel.js'
import {
  keysForRefs, removeKeysForRefs, sameKeyRef, setInterpForRefs, toggleKeyRef,
} from '../../lensRoam/roamKeyModel.js'
import { tickToPixel } from '../../constants/timeline.js'

const K = (channel, pos, value, interp = 'Linear', bez) => makeKey({ channel, anchor: 'Origin', pos, value, interp, bez })
const tracks = [{ id: 1, name: 'Lead', type: 'Pattern' }, { id: 2, name: 'Drums', type: 'Pattern' }]
const PPB = 40
const easeOut = (u) => 1 - (1 - u) * (1 - u)

describe('bezierEase: the JS port of KeyCurve.h bezierEase', () => {
  const us = Array.from({ length: 201 }, (_, i) => i / 200)
  it('(1/3,1/3,2/3,2/3) is a line; (1/3,2/3,2/3,1) is exactly EaseOut', () => {
    for (const u of us) {
      expect(bezierEase([1 / 3, 1 / 3, 2 / 3, 2 / 3], u)).toBeCloseTo(u, 6)
      expect(bezierEase([1 / 3, 2 / 3, 2 / 3, 1], u)).toBeCloseTo(easeOut(u), 6)
    }
  })
  it('the default (ease-in-out) is symmetric, monotone, 0.5 at the middle, and ends at 0 / 1', () => {
    let prev = -1
    for (const u of us) {
      const e = bezierEase(DEFAULT_BEZ, u)
      expect(e + bezierEase(DEFAULT_BEZ, 1 - u)).toBeCloseTo(1, 6)
      expect(e).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = e
    }
    expect(bezierEase(DEFAULT_BEZ, 0.5)).toBeCloseTo(0.5, 6)
    for (const b of [DEFAULT_BEZ, [1, 0, 1, 0], [0, 1, 0, 1]]) {
      expect(bezierEase(b, 0)).toBe(0)
      expect(bezierEase(b, 1)).toBe(1)
    }
  })
  it('degenerate handles never give NaN; y above 1 overshoots', () => {
    for (const b of [[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 0, 0], [1, 1, 1, 1]]) {
      for (const u of us) expect(Number.isFinite(bezierEase(b, u))).toBe(true)
    }
    const back = [1 / 3, (1.70158 + 3) / 3, 2 / 3, 1]
    expect(Math.max(...us.map((u) => bezierEase(back, u)))).toBeGreaterThan(1.05)
  })
  it('a curve with a Bezier key: a + (b - a) * ease(u), exact at the keys; the next segment keeps its interp', () => {
    const c = [K('scale', 0, 2, 'Bezier'), K('scale', 100, 10), K('scale', 200, 4)]
    expect(valueAtEvent(c, 0, -1)).toBe(2)
    expect(valueAtEvent(c, 25, -1)).toBeCloseTo(2 + 8 * bezierEase(DEFAULT_BEZ, 0.25), 12)
    expect(valueAtEvent(c, 100, -1)).toBe(10)
    expect(valueAtEvent(c, 150, -1)).toBeCloseTo(7, 12)
    expect(segmentEase({ interp: 'Linear', bez: [1, 0, 1, 0] }, 0.3)).toBe(0.3)   // non-Bezier ignores bez
  })
  it('sanitizeBez clamps x into [0, 1], replaces non-finite with the default, leaves y free', () => {
    expect(sanitizeBez([-0.5, Number.NaN, 2, 3])).toEqual([0, 0, 1, 3])
    expect(sanitizeBez(undefined)).toEqual([...DEFAULT_BEZ])
  })
})

describe('key wire form, equality and the batch op', () => {
  it('a Bezier key always carries handles (default if none); any other key carries none', () => {
    expect(K('offsetX', 0, 1, 'Bezier').bez).toEqual([...DEFAULT_BEZ])
    expect('bez' in K('offsetX', 0, 1, 'Linear', [0, 0, 1, 1])).toBe(false)
  })
  it('keyEquals compares handles on Bezier keys only', () => {
    expect(keyEquals(K('offsetX', 0, 1, 'Bezier', [0.1, 0, 0.9, 1]), K('offsetX', 0, 1, 'Bezier', [0.2, 0, 0.9, 1]))).toBe(false)
    expect(keyEquals({ ...K('offsetX', 0, 1), bez: [1, 1, 1, 1] }, K('offsetX', 0, 1))).toBe(true)
  })
  it('a batch applies its ops in order as ONE result; null when none applied', () => {
    const keys = [K('offsetX', 0, 0), K('offsetX', 960, 1), K('scale', 0, 1)]
    const next = applyKeyOp(keys, interpOp([keys[0], keys[2]], 'Bezier', [0, 0, 0.58, 1]))
    expect(next.map((k) => k.interp)).toEqual(['Bezier', 'Linear', 'Bezier'])
    expect(next[0].bez).toEqual([0, 0, 0.58, 1])
    expect(applyKeyOp(keys, interpOp([K('rotationDeg', 5, 5)], 'Hold'))).toBeNull()
  })
  it('interpOp without a preset keeps a Bezier key\'s own handles and gives others the default', () => {
    const custom = K('offsetX', 0, 0, 'Bezier', [0.1, 0.2, 0.3, 0.4])
    const keys = [custom, K('offsetX', 960, 1)]
    const next = applyKeyOp(keys, interpOp(keys, 'Bezier'))
    expect(next[0]).toBe(custom)          // unchanged: the same object
    expect(next[1].bez).toEqual([...DEFAULT_BEZ])
    const back = applyKeyOp(next, interpOp(next, 'Linear'))
    expect(back.every((k) => k.interp === 'Linear' && !('bez' in k))).toBe(true)
  })
})

describe('multi-selection refs', () => {
  const keys = [K('offsetX', 0, 0), K('offsetX', 960, 1), K('scale', 0, 1)]
  it('toggle adds and removes; refs address keys within half a tick', () => {
    let refs = toggleKeyRef([], { trackId: 1, channel: 'offsetX', pos: 0 })
    refs = toggleKeyRef(refs, { trackId: 1, channel: 'scale', pos: 0.2 })
    expect(refs).toHaveLength(2)
    expect(keysForRefs(keys, refs, 1)).toEqual([keys[0], keys[2]])
    expect(keysForRefs(keys, refs, 2)).toEqual([])
    refs = toggleKeyRef(refs, { trackId: 1, channel: 'offsetX', pos: 0 })
    expect(refs).toHaveLength(1)
    expect(sameKeyRef(refs[0], { trackId: 1, channel: 'scale', pos: 0 })).toBe(true)
  })
  it('setInterpForRefs / removeKeysForRefs act on the addressed keys of ONE track, else return the same list', () => {
    const refs = [{ trackId: 1, channel: 'offsetX', pos: 960 }, { trackId: 2, channel: 'offsetX', pos: 0 }]
    const next = setInterpForRefs(keys, refs, 1, 'Bezier')
    expect(next.map((k) => k.interp)).toEqual(['Linear', 'Bezier', 'Linear'])
    expect(setInterpForRefs(keys, refs, 3, 'Bezier')).toBe(keys)
    expect(removeKeysForRefs(keys, refs, 1)).toEqual([keys[0], keys[2]])
    expect(removeKeysForRefs(keys, refs, 3)).toBe(keys)
  })
})

describe('lane: handles, hit test, marquee, painter', () => {
  const layout = laneLayout({ tracks, roam: [1, 2] })
  const [row1, row2] = layout.getRoamRows()
  const A = K('offsetX', 0, 0, 'Bezier', [0.25, 0, 0.75, 1])
  const KEYS = [A, K('offsetX', 3840, 2), K('scale', 960, 2)]
  const data = { base: { offsetX: 0, scale: 1 }, keys: KEYS }
  const dataOf = () => data
  const channelOf = () => 'offsetX'
  const selA = (ref) => ref.trackId === 1 && ref.channel === 'offsetX' && Math.abs(ref.pos) < 0.5
  const range = laneRangeFor('offsetX', KEYS, data.base)
  const seg = () => laneBezierSegments(laneKeys(KEYS, 'offsetX'), (k) => selA({ trackId: 1, channel: 'offsetX', pos: k.pos }), row1, range, 0, PPB)[0]

  it('only a SELECTED Bezier key has handles, at its x fractions along the segment', () => {
    expect(laneBezierSegments(laneKeys(KEYS, 'offsetX'), () => false, row1, range, 0, PPB)).toEqual([])
    const s = seg()
    const x0 = tickToPixel(0, 0, PPB)
    const x1 = tickToPixel(3840, 0, PPB)
    expect(s.h1.x).toBeCloseTo(x0 + 0.25 * (x1 - x0), 9)
    expect(s.h2.x).toBeCloseTo(x0 + 0.75 * (x1 - x0), 9)
    expect(s.h1.y).toBeCloseTo(keyPixel(A, row1, range, 0, PPB).y, 9)   // y1 = 0: at a's value
  })

  it('the hit test reports a shown handle (and not the key) when the pointer is on it', () => {
    const s = seg()
    const hit = hitTestRoamLane({ trackLayout: layout, dataOf, channelOf, isSelected: selA }, s.h1.x, s.h1.y, 0, PPB)
    expect(hit.handle).toMatchObject({ key: A, which: 1 })
    expect(hit.key).toBeNull()
    const noSel = hitTestRoamLane({ trackLayout: layout, dataOf, channelOf }, s.h1.x, s.h1.y, 0, PPB)
    expect(noSel.handle).toBeNull()
  })

  it('keysInMarquee: the keys of every crossed lane, of each lane\'s own channel', () => {
    const p = keyPixel(KEYS[1], row1, range, 0, PPB)
    const rect = { x0: p.x - 5, y0: row1.y, x1: p.x + 5, y1: row2.y + row2.height }
    const refs = keysInMarquee({ trackLayout: layout, dataOf, channelOf }, rect, 0, PPB)
    expect(refs).toEqual([{ trackId: 1, channel: 'offsetX', pos: 3840 }, { trackId: 2, channel: 'offsetX', pos: 3840 }])
  })

  const ctxStub = () => {
    const calls = []
    return new Proxy({}, {
      get(_t, name) {
        if (name === 'calls') return calls
        if (name === 'measureText') return () => ({ width: 30 })
        return (...a) => { calls.push([String(name), ...a]) }
      },
      set(_t, name, value) { calls.push(['set:' + String(name), value]); return true },
    })
  }
  const PALETTE = { ink: '#fff', inkDark: '#000', select: '#0af', roamAxis: '#444', roamLine: '#888', roamLabel: '#999' }
  const run = (d) => {
    const ctx = ctxStub()
    drawRoamLanes({
      ctx, w: 800, h: 400, scrollOffset: 0, ppb: PPB, trackLayout: layout, palette: PALETTE,
      trackColorById: { 1: '#f80' }, mutedTrackIds: new Set(),
    }, d)
    return ctx.calls
  }

  it('the painter draws a Bezier key as a hexagon, samples its curve, and shows handles only when selected', () => {
    const unselected = run({ dataOf, channelOf, selected: null })
    const hexMoves = unselected.filter((c) => c[0] === 'moveTo')
    expect(hexMoves.length).toBeGreaterThan(0)
    const arcs = (calls) => calls.filter((c) => c[0] === 'arc').length
    // Selected through the multi-selection: two handle dots appear (one arc each).
    const multi = [{ trackId: 1, channel: 'offsetX', pos: 0 }]
    const withHandles = run({ dataOf, channelOf, selected: null, multi })
    expect(arcs(withHandles) - arcs(unselected)).toBe(2)       // track 1's lane only: its key is the one selected
  })

  it('the painter draws the marquee rectangle', () => {
    const calls = run({ dataOf, channelOf, selected: null, marquee: { x0: 10, y0: 10, x1: 100, y1: 60 } })
    expect(calls.some((c) => c[0] === 'strokeRect')).toBe(true)
  })
})

describe('gestures: handle drag and marquee', () => {
  const layout = laneLayout({ tracks, roam: [1] })
  const row = layout.getRoamRows()[0]
  let rafs
  beforeEach(() => {
    rafs = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { rafs.push(cb); return rafs.length })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })
  const move = (x, y) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }))
  const up = (x, y) => window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }))
  const key = (e) => window.dispatchEvent(new KeyboardEvent('keydown', { key: e, bubbles: true }))

  const A = K('offsetX', 0, 0, 'Bezier', [0.25, 0, 0.75, 1])
  const B = K('offsetX', 3840, 2)
  const data = { base: { offsetX: 0 }, keys: [A, B] }
  const start = (calls) => {
    const range = laneRangeFor('offsetX', data.keys, data.base)
    const s = laneBezierSegments([A, B], () => true, row, range, 0, PPB)[0]
    const hit = hitTestRoamLane({
      trackLayout: layout, dataOf: () => data, channelOf: () => 'offsetX', isSelected: () => true,
    }, s.h1.x, s.h1.y, 0, PPB)
    expect(hit.handle).not.toBeNull()
    beginBezierHandleGesture({
      event: new MouseEvent('mousedown', { clientX: s.h1.x, clientY: s.h1.y }), hit, data,
      view: () => ({ scrollOffset: 0, ppb: PPB }),
      localOf: (e) => ({ localX: e.clientX, localY: e.clientY }),
      setDraft: (k) => calls.draft.push(k), clearDraft: () => { calls.clear++ },
      commit: (k) => { calls.commit.push(k); return Promise.resolve() },
    })
    return { s, B: keyPixel(B, row, range, 0, PPB), x0: tickToPixel(0, 0, PPB), x1: tickToPixel(3840, 0, PPB) }
  }

  it('dragging handle 1 previews locally and commits the key\'s new bez ONCE', () => {
    const calls = { draft: [], clear: 0, commit: [] }
    const g = start(calls)
    const tx = g.x0 + 0.5 * (g.x1 - g.x0)
    move(tx, g.B.y)
    move(tx, g.B.y)
    rafs.splice(0).forEach((cb) => cb(0))
    expect(calls.commit).toHaveLength(0)
    expect(calls.draft).toHaveLength(1)                     // one draft per frame
    up(tx, g.B.y)
    expect(calls.commit).toHaveLength(1)
    const bez = calls.commit[0][0].bez
    expect(bez[0]).toBeCloseTo(0.5, 3)
    expect(bez[1]).toBeCloseTo(1, 1)                        // at B's value
    expect(bez.slice(2)).toEqual([0.75, 1])
    expect(calls.commit[0][1]).toBe(B)                      // the other key is untouched
  })

  it('Escape cancels a handle drag: nothing committed, the draft cleared', () => {
    const calls = { draft: [], clear: 0, commit: [] }
    const g = start(calls)
    move(g.x1, g.B.y)
    key('Escape')
    up(g.x1, g.B.y)
    expect(calls.commit).toHaveLength(0)
    expect(calls.clear).toBe(1)
  })

  it('a marquee selects what it covers on release (replacing, or adding when additive)', () => {
    const marquees = []
    const selected = []
    const base = [{ trackId: 9, channel: 'scale', pos: 0 }]
    const inside = [{ trackId: 1, channel: 'offsetX', pos: 3840 }]
    const run = (additive) => beginRoamMarqueeGesture({
      event: new MouseEvent('mousedown', { clientX: 10, clientY: row.y + 2 }),
      localOf: (e) => ({ localX: e.clientX, localY: e.clientY }),
      setMarquee: (r) => marquees.push(r),
      keysIn: () => inside,
      base, additive,
      select: (refs) => selected.push(refs),
    })
    run(false)
    move(300, row.y + 30)
    rafs.splice(0).forEach((cb) => cb(0))
    up(300, row.y + 30)
    expect(marquees.at(-1)).toBeNull()                      // the band is gone
    expect(selected.at(-1)).toEqual(inside)
    run(true)
    up(300, row.y + 30)
    expect(selected.at(-1)).toEqual([...base, ...inside])
  })
})

describe('right-click menu (roamKeyMenuItems)', () => {
  const keys1 = [K('offsetX', 0, 0), K('offsetX', 960, 1)]
  const keys2 = [K('scale', 0, 1, 'Bezier')]
  const keysOf = (t) => (t === 1 ? keys1 : keys2)
  const refs = [{ trackId: 1, channel: 'offsetX', pos: 0 }, { trackId: 2, channel: 'scale', pos: 0 }]

  it('lists Hold / Linear / Ease out, the Bezier presets and Delete N, with checks for a shared interp', () => {
    const { items, count } = roamKeyMenuItems({ refs, keysOf, commit: () => {} })
    expect(count).toBe(2)
    const labels = items.filter((i) => i.label).map((i) => i.label)
    expect(labels).toEqual([
      'Hold', 'Linear', 'Ease out',
      'Bezier: Smooth', 'Bezier: Ease in', 'Bezier: Ease out', 'Bezier: Overshoot',
      'Delete 2 keys',
    ])
    expect(items.find((i) => i.label === 'Linear').checked).toBe(false)   // mixed: one Linear, one Bezier
    const one = roamKeyMenuItems({ refs: [refs[1]], keysOf, commit: () => {} })
    expect(one.items.find((i) => i.label === 'Bezier: Smooth').checked).toBe(true)
    expect(one.items.at(-1).label).toBe('Delete key')
  })

  it('a Bezier preset is ONE commit per touched track, with that preset\'s handles', () => {
    const commit = vi.fn()
    const { items } = roamKeyMenuItems({ refs, keysOf, commit })
    items.find((i) => i.label === 'Bezier: Ease in').onClick()
    expect(commit).toHaveBeenCalledTimes(2)
    const [t1, k1] = commit.mock.calls[0]
    expect(t1).toBe(1)
    expect(k1[0]).toMatchObject({ interp: 'Bezier', bez: [0.42, 0, 1, 1] })
    expect(k1[1]).toBe(keys1[1])                            // unselected key untouched
    expect(commit.mock.calls[1][1][0]).toMatchObject({ interp: 'Bezier', bez: [0.42, 0, 1, 1] })
  })

  it('Delete removes the selected keys and clears the selection; a no-op track is not committed', () => {
    const commit = vi.fn()
    const afterDelete = vi.fn()
    const { items } = roamKeyMenuItems({ refs: [refs[0]], keysOf, commit, afterDelete })
    items.at(-1).onClick()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(1, [keys1[1]])
    expect(afterDelete).toHaveBeenCalled()
    const lin = roamKeyMenuItems({ refs: [refs[0]], keysOf, commit: vi.fn() })
    const c2 = vi.fn()
    roamKeyMenuItems({ refs: [refs[0]], keysOf, commit: c2 }).items.find((i) => i.label === 'Linear').onClick()
    expect(c2).not.toHaveBeenCalled()                       // already Linear: nothing to send
    expect(lin.count).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import {
  KEY_LIMITS, TICKS_PER_BAR, barBeatOf, clampKeyValue, compileRoamKeys, formatBarBeat, formatRoamValue, keyAtPlayhead,
  keyedChannels, keyIndexAt, laneValueToY, laneYToValue, moveKey, offsetForCenter, planRoamEdit, positionKeyTicks,
  resolveRoamAt, roamLaneRange, roamMotionPath, sameKeys, splitRoamPatch, upsertKey,
} from './roamKeyModel.js'
import { cellGeometry } from './lensRoamModel.js'

const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })
const BASE = { offsetX: 0, offsetY: 0.25, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const BAR = TICKS_PER_BAR

// The same keys test_lens_roam.cpp [25] uses (a cell that rests until bar 4, flies out
// over bar 4 and lands in bar 5), so the numbers pin the ENGINE's evaluation.
const FLIGHT = [
  K('offsetX', 3 * BAR, 0, 'EaseOut'),
  K('offsetX', 4 * BAR, 2.5),
  K('scale', 3 * BAR, 1),
  K('scale', 4 * BAR, 0.5, 'Hold'),
  K('scale', 5 * BAR, 1),
]

describe('resolveRoamAt: the engine rule (LensRoamSnapshot::roamAt)', () => {
  it('no keys: exactly the base', () => {
    expect(resolveRoamAt(BASE, [], 12345)).toEqual(BASE)
  })

  it('keyed channels follow their keys, the rest hold the base', () => {
    const r = resolveRoamAt(BASE, FLIGHT, 3.5 * BAR)
    expect(r.offsetX).toBeCloseTo(2.5 * 0.75, 6)      // EaseOut leaving the first key: 1 - (1 - 0.5)^2
    expect(r.offsetY).toBe(0.25)                     // unkeyed: base
    expect(r.rotationDeg).toBe(0)
  })

  it('before the first key and after the last each channel holds that key', () => {
    expect(resolveRoamAt(BASE, FLIGHT, 0).offsetX).toBe(0)
    expect(resolveRoamAt(BASE, FLIGHT, 3 * BAR - 1).offsetX).toBe(0)
    expect(resolveRoamAt(BASE, FLIGHT, 4 * BAR).offsetX).toBe(2.5)
    expect(resolveRoamAt(BASE, FLIGHT, 9 * BAR).offsetX).toBe(2.5)
    expect(resolveRoamAt(BASE, FLIGHT, 9 * BAR).scale).toBe(1)
  })

  it('Hold keeps the key value until the next key, then the next key owns it', () => {
    expect(resolveRoamAt(BASE, FLIGHT, 4.5 * BAR).scale).toBe(0.5)
    expect(resolveRoamAt(BASE, FLIGHT, 5 * BAR).scale).toBe(1)
  })

  it('the last key listed at a tick owns that tick (right-continuous, stable sort)', () => {
    const keys = [K('scale', 100, 2), K('scale', 100, 3), K('scale', 0, 1)]
    expect(resolveRoamAt(BASE, keys, 100).scale).toBe(3)
    expect(resolveRoamAt(BASE, keys, 50).scale).toBeCloseTo(1.5, 6)   // coming in from the left it reaches the EARLIER key at 100 (2), then steps to 3
  })

  it('a pre-compiled key set gives the same answer', () => {
    const c = compileRoamKeys(FLIGHT)
    for (const t of [0, 2 * BAR, 3.25 * BAR, 4 * BAR, 4.9 * BAR, 9 * BAR]) {
      expect(resolveRoamAt(BASE, FLIGHT, t, c)).toEqual(resolveRoamAt(BASE, FLIGHT, t))
    }
  })

  it('keyedChannels lists channels with a key', () => {
    expect([...keyedChannels(FLIGHT)].sort()).toEqual(['offsetX', 'scale'])
    expect(keyedChannels([]).size).toBe(0)
  })
})

describe('key edits', () => {
  it('upsertKey adds, then updates in place (never two keys on one tick)', () => {
    let keys = upsertKey([], { channel: 'offsetX', pos: 480, value: 1 })
    expect(keys).toEqual([K('offsetX', 480, 1)])
    keys = upsertKey(keys, { channel: 'offsetX', pos: 480, value: 2 })
    expect(keys).toHaveLength(1)
    expect(keys[0].value).toBe(2)
    expect(upsertKey(keys, { channel: 'offsetX', pos: 480, value: 2 })).toBe(keys)   // no change: same list
    keys = upsertKey(keys, { channel: 'offsetY', pos: 480, value: 1 })
    expect(keys).toHaveLength(2)
  })

  it('upsertKey rounds the tick and keeps a value the engine accepts', () => {
    const keys = upsertKey([], { channel: 'scale', pos: 100.4, value: -3 })
    expect(keys[0].pos).toBe(100)
    expect(keys[0].value).toBe(KEY_LIMITS.scale[0])           // a scale must stay > 0
    expect(clampKeyValue('offsetX', 99)).toBe(KEY_LIMITS.offsetX[1])
    expect(clampKeyValue('offsetX', NaN)).toBe(0)
  })

  it('moveKey moves one key and refuses to land on another of its channel', () => {
    const keys = [K('offsetX', 100, 0), K('offsetX', 200, 1), K('scale', 150, 1)]
    const moved = moveKey(keys, keys[0], { pos: 120, value: 0.5 })
    expect(moved[0]).toEqual(K('offsetX', 120, 0.5))
    expect(moved[1]).toBe(keys[1])
    // onto the other offsetX key: pushed one tick on, in the direction of travel
    expect(moveKey(keys, keys[0], { pos: 200, value: 0 })[0].pos).toBe(201)
    expect(moveKey(keys, keys[1], { pos: 100, value: 1 })[1].pos).toBe(99)
    // a different channel at the same tick is fine
    expect(moveKey(keys, keys[0], { pos: 150, value: 0 })[0].pos).toBe(150)
    // never before tick 0
    expect(moveKey(keys, keys[0], { pos: -50, value: 0 })[0].pos).toBe(0)
  })

  it('keyIndexAt finds a key within half a tick', () => {
    const keys = [K('offsetX', 100, 0)]
    expect(keyIndexAt(keys, 'offsetX', 100.4)).toBe(0)
    expect(keyIndexAt(keys, 'offsetX', 101)).toBe(-1)
    expect(keyIndexAt(keys, 'offsetY', 100)).toBe(-1)
  })

  it('keyAtPlayhead writes what the cell is doing now', () => {
    const keys = keyAtPlayhead(FLIGHT, BASE, 'offsetX', 3.5 * BAR)
    const k = keys.find((x) => x.channel === 'offsetX' && x.pos === 3.5 * BAR)
    expect(k.value).toBeCloseTo(1.875, 6)
  })
})

describe('planRoamEdit', () => {
  it('unkeyed, Auto-key off: the static edit it always was', () => {
    expect(planRoamEdit({ base: BASE, keys: [], patch: { offsetX: 0.5 }, tick: 100, autoKey: false }))
      .toEqual({ kind: 'base', patch: { offsetX: 0.5 } })
  })

  it('bounds and layer are never keyed', () => {
    expect(planRoamEdit({ base: BASE, keys: FLIGHT, patch: { bounds: 'Float' }, tick: 100, autoKey: true }))
      .toEqual({ kind: 'base', patch: { bounds: 'Float' } })
    expect(splitRoamPatch({ offsetX: 1, layer: 'Top' })).toEqual({ channels: { offsetX: 1 }, other: { layer: 'Top' } })
  })

  it('a KEYED parameter edited with Auto-key off is refused (the base would be ignored)', () => {
    const plan = planRoamEdit({ base: BASE, keys: FLIGHT, patch: { offsetX: 1, offsetY: 0.5 }, tick: 100, autoKey: false })
    expect(plan).toEqual({ kind: 'blocked', channels: ['offsetX'] })
    // an unkeyed parameter of the same track still edits the base
    expect(planRoamEdit({ base: BASE, keys: FLIGHT, patch: { rotationDeg: 10 }, tick: 100, autoKey: false }).kind).toBe('base')
  })

  it('Auto-key: a first key also drops a rest key one bar earlier, so the cell glides in', () => {
    // At bar 5 the cell is dragged out; before the drag it sat at its base (offsetX 0).
    const plan = planRoamEdit({ base: BASE, keys: [], patch: { offsetX: 2 }, tick: 4 * BAR, autoKey: true })
    expect(plan.kind).toBe('keys')
    expect(plan.keys).toEqual([K('offsetX', 3 * BAR, 0), K('offsetX', 4 * BAR, 2)])
    // ... and the engine's rule then gives the flight: home through bar 4's start, out by bar 5.
    expect(resolveRoamAt(BASE, plan.keys, 3 * BAR).offsetX).toBe(0)
    expect(resolveRoamAt(BASE, plan.keys, 3.5 * BAR).offsetX).toBe(1)
    expect(resolveRoamAt(BASE, plan.keys, 4 * BAR).offsetX).toBe(2)
  })

  it('Auto-key near the start clamps the rest key to tick 0; at tick 0 there is only the key', () => {
    const near = planRoamEdit({ base: BASE, keys: [], patch: { scale: 2 }, tick: 960, autoKey: true })
    expect(near.keys).toEqual([K('scale', 0, 1), K('scale', 960, 2)])
    const zero = planRoamEdit({ base: BASE, keys: [], patch: { scale: 2 }, tick: 0, autoKey: true })
    expect(zero.keys).toEqual([K('scale', 0, 2)])
  })

  it('Auto-key on a keyed parameter adds or updates a key at the playhead, no rest key', () => {
    const plan = planRoamEdit({ base: BASE, keys: FLIGHT, patch: { offsetX: 1 }, tick: 3.5 * BAR, autoKey: true })
    expect(plan.kind).toBe('keys')
    expect(plan.keys).toHaveLength(FLIGHT.length + 1)
    expect(plan.keys.filter((k) => k.channel === 'offsetX').map((k) => k.pos)).toEqual([3 * BAR, 4 * BAR, 3.5 * BAR])
    // a key already at the playhead is updated in place
    const again = planRoamEdit({ base: BASE, keys: plan.keys, patch: { offsetX: 1.25 }, tick: 3.5 * BAR, autoKey: true })
    expect(again.keys).toHaveLength(plan.keys.length)
    expect(again.keys.find((k) => k.channel === 'offsetX' && k.pos === 3.5 * BAR).value).toBe(1.25)
  })

  it('Auto-key writes one key per CHANGED parameter and ignores one that did not change', () => {
    const plan = planRoamEdit({ base: BASE, keys: [], patch: { offsetX: 1, offsetY: 0.25 }, tick: 0, autoKey: true })
    expect(plan.keys.map((k) => k.channel)).toEqual(['offsetX'])     // offsetY is already 0.25
  })

  it('Auto-key with nothing changed is a no-op', () => {
    expect(planRoamEdit({ base: BASE, keys: [], patch: { offsetX: 0 }, tick: 500, autoKey: true })).toEqual({ kind: 'none' })
    expect(planRoamEdit({ base: BASE, keys: [], patch: {}, tick: 500, autoKey: true })).toEqual({ kind: 'none' })
  })

  it('sameKeys compares in order', () => {
    expect(sameKeys(FLIGHT, [...FLIGHT])).toBe(true)
    expect(sameKeys(FLIGHT, FLIGHT.slice(1))).toBe(false)
  })
})

describe('lane scale', () => {
  it('offsets: a symmetric range that snaps to a few steps and contains every key', () => {
    expect(roamLaneRange('offsetX', [], BASE)).toEqual({ min: -1, max: 1, log: false })
    expect(roamLaneRange('offsetX', [K('offsetX', 0, 1.2)], BASE)).toEqual({ min: -2, max: 2, log: false })
    expect(roamLaneRange('offsetX', [K('offsetX', 0, -5)], BASE)).toEqual({ min: -6, max: 6, log: false })
  })

  it('rotation: 45 degrees at least, then 90 / 180 / 360 / 720', () => {
    expect(roamLaneRange('rotationDeg', [], BASE).max).toBe(45)
    expect(roamLaneRange('rotationDeg', [K('rotationDeg', 0, 100)], BASE).max).toBe(180)
    expect(roamLaneRange('rotationDeg', [K('rotationDeg', 0, -500)], BASE).max).toBe(720)
    // past the last step the lane keeps doubling, so any key fits
    expect(roamLaneRange('rotationDeg', [K('rotationDeg', 0, 2000)], BASE).max).toBe(2880)
  })

  it('scale: log, in octave steps around 1, always containing 1 and every key', () => {
    expect(roamLaneRange('scale', [], BASE)).toEqual({ min: 0.5, max: 2, log: true })
    const r = roamLaneRange('scale', [K('scale', 0, 0.2), K('scale', 1, 5)], BASE)
    expect(r.log).toBe(true)
    expect(r.min).toBeLessThanOrEqual(0.2)
    expect(r.max).toBeGreaterThanOrEqual(5)
  })

  it('value <-> y round-trips; past the lane edge it extrapolates up to what a key may hold', () => {
    const inner = { top: 10, height: 40 }
    for (const [ch, range, v] of [['offsetX', { min: -2, max: 2, log: false }, 0.75], ['scale', { min: 0.25, max: 4, log: true }, 2]]) {
      const y = laneValueToY(range, inner, v)
      expect(laneYToValue(range, inner, y, ch)).toBeCloseTo(v, 6)
    }
    // offsets keep their eight-cell ceiling
    expect(laneYToValue({ min: -2, max: 2, log: false }, inner, -999, 'offsetX')).toBe(8)
    expect(laneYToValue({ min: -2, max: 2, log: false }, inner, 999, 'offsetX')).toBe(-8)
    // rotation has none: a drag above the lane keeps turning (a 40 px lane over +-45 deg)
    expect(laneYToValue({ min: -45, max: 45, log: false }, inner, 10 - 40, 'rotationDeg')).toBeCloseTo(135, 6)
    // the top of the lane is the maximum
    expect(laneValueToY({ min: -2, max: 2, log: false }, inner, 2)).toBe(10)
  })
})

describe('time and values as printed', () => {
  it('bar.beat.ticks, 1-based, 4/4', () => {
    expect(barBeatOf(0)).toEqual({ bar: 1, beat: 1, ticks: 0 })
    expect(barBeatOf(3 * BAR)).toEqual({ bar: 4, beat: 1, ticks: 0 })
    expect(barBeatOf(4 * BAR + 960 + 120)).toEqual({ bar: 5, beat: 2, ticks: 120 })
    expect(formatBarBeat(3 * BAR + 2 * 960)).toBe('4.3.0')
  })

  it('values: number, thin space, unit, true minus', () => {
    expect(formatRoamValue('offsetX', -1.5)).toBe('−1.50 cells')
    expect(formatRoamValue('scale', 0.5)).toBe('0.50 ×')
    expect(formatRoamValue('rotationDeg', 45)).toBe('45.0 °')
    expect(formatRoamValue('offsetX', 2, { short: true })).toBe('2.0')
    expect(formatRoamValue('scale', 4, { short: true })).toBe('×4.00')
    expect(formatRoamValue('rotationDeg', -45, { short: true })).toBe('−45°')
    expect(formatRoamValue('offsetX', -0.0001)).toBe('0.00 cells')        // never "-0.00"
  })
})

describe('motion path', () => {
  const LAYOUT = {
    columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
    slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }], fullscreenLayers: [],
  }
  const geo = cellGeometry(LAYOUT, { id: 7, gapScaleOverride: -1 })

  it('dots are the ticks that have an Offset X or Offset Y key', () => {
    expect(positionKeyTicks([K('offsetX', 200, 1), K('offsetY', 100, 1), K('offsetX', 100, 0), K('scale', 50, 1)])).toEqual([100, 200])
    expect(positionKeyTicks(FLIGHT)).toEqual([3 * BAR, 4 * BAR])
  })

  it('the path runs through the cell centre at each dot', () => {
    const keys = [K('offsetX', 0, 0), K('offsetX', 960, 3)]
    const p = roamMotionPath(BASE, keys, geo, 8)
    expect(p.dots).toHaveLength(2)
    // home centre is (0.5, 0.5); offsetY = base 0.25 cell = 0.25/3 of the canvas down
    expect(p.dots[0].x).toBeCloseTo(0.5, 6)
    expect(p.dots[0].y).toBeCloseTo(0.5 + 0.25 / 3, 6)
    expect(p.dots[1].x).toBeCloseTo(0.5 + 3 / 3, 6)
    expect(p.line[0].x).toBeCloseTo(p.dots[0].x, 6)
    expect(p.line[p.line.length - 1].x).toBeCloseTo(p.dots[1].x, 6)
    expect(p.line).toHaveLength(9)                              // 8 steps + the start
  })

  it('EaseOut bends the path: halfway in time is past halfway in space', () => {
    const keys = [K('offsetX', 0, 0, 'EaseOut'), K('offsetX', 960, 2)]
    const p = roamMotionPath(BASE, keys, geo, 10)
    const mid = p.line[5]
    expect(mid.x - p.dots[0].x).toBeCloseTo((2 / 3) * 0.75, 6)
  })

  it('no keys, one key, or no cell: nothing to draw or a lone dot', () => {
    expect(roamMotionPath(BASE, [], geo)).toEqual({ dots: [], line: [] })
    expect(roamMotionPath(BASE, [K('offsetX', 0, 1)], geo).line).toEqual([])
    expect(roamMotionPath(BASE, [K('offsetX', 0, 1)], geo).dots).toHaveLength(1)
    expect(roamMotionPath(BASE, FLIGHT, null)).toEqual({ dots: [], line: [] })
    expect(roamMotionPath(BASE, [K('scale', 0, 2), K('scale', 960, 1)], geo).dots).toEqual([])
  })

  it('offsetForCenter inverts the cell centre', () => {
    const { offsetX, offsetY } = offsetForCenter(geo, 0.5 + 2 / 3, 0.5 - 1 / 3)
    expect(offsetX).toBeCloseTo(2, 6)
    expect(offsetY).toBeCloseTo(-1, 6)
  })
})

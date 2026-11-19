// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../timelineEvents.js'
import {
  KEY_LIMITS, SWEEP_CHANNELS, applySweepLayer, clampKeyValue, formatRoamValue, laneValueToY, moveKey,
  roamIdentityOf, roamLaneRange, sortedForDisplay, sweepLayerAt, upsertKey,
} from './roamKeyModel.js'
import { setTrackSweepKeys } from './lensRoamApi.js'

const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })

// The bump test_lens_roam.cpp [26] plays across two notes: zoom 1.0 at tick 4320 ->
// 1.5 at 4800 -> 1.0 at 5280, centreX 0 -> 0.2, rotation 0 -> 12. The numbers below are
// the engine's, so a drift in either evaluator shows up here.
const BUMP = [
  K('zoom', 4320, 1.0), K('zoom', 4800, 1.5), K('zoom', 5280, 1.0),
  K('centerX', 4320, 0), K('centerX', 4800, 0.2),
  K('rotationDeg', 4320, 0), K('rotationDeg', 5280, 12),
]

describe('Sweep layer (LensRoamSnapshot::applySweep)', () => {
  it('no keys: no layer at all (it adds nothing)', () => {
    expect(sweepLayerAt([], 4800)).toBeNull()
    expect(sweepLayerAt(null, 4800)).toBeNull()
    const lens = { zoom: 1.2, centerX: 0.4, centerY: 0.5, rotationDeg: 0 }
    expect(applySweepLayer(lens, null)).toBe(lens)
  })

  it('a keyed channel follows its keys; an unkeyed one is the layer identity', () => {
    const at = sweepLayerAt(BUMP, 4800)
    expect(at).toEqual({ zoom: 1.5, centerX: 0.2, centerY: 0, rotationDeg: 12 * (480 / 960) })
    expect(sweepLayerAt(BUMP, 4560).zoom).toBeCloseTo(1.25, 9)
    // before the first key and after the last each channel holds that key
    expect(sweepLayerAt(BUMP, 0)).toEqual({ zoom: 1, centerX: 0, centerY: 0, rotationDeg: 0 })
    expect(sweepLayerAt(BUMP, 9999)).toEqual({ zoom: 1, centerX: 0.2, centerY: 0, rotationDeg: 12 })
  })

  it('zoom multiplies; centre and rotation add (spec "Blend")', () => {
    const lens = { fit: 'Cover', zoom: 1.2, centerX: 0.4, centerY: 0.5, rotationDeg: 10 }
    const out = applySweepLayer(lens, sweepLayerAt(BUMP, 4800))
    expect(out.zoom).toBeCloseTo(1.8, 9)            // 1.2 x 1.5
    expect(out.centerX).toBeCloseTo(0.6, 9)         // 0.4 + 0.2
    expect(out.centerY).toBe(0.5)                   // unkeyed
    expect(out.rotationDeg).toBeCloseTo(16, 9)      // 10 + 6
    expect(out.fit).toBe('Cover')
  })

  it('the bump spans two notes without a step at their boundary', () => {
    // note 1 ends and note 2 starts at tick 4800: the layer is the same value either side
    const before = sweepLayerAt(BUMP, 4799).zoom
    const after = sweepLayerAt(BUMP, 4800).zoom
    expect(Math.abs(after - before)).toBeLessThan(0.5 / 480 + 1e-9)
  })
})

describe('the lane over the Sweep channels', () => {
  it('knows the four Lens channels, with identities x1 / +0', () => {
    expect(SWEEP_CHANNELS).toEqual(['zoom', 'centerX', 'centerY', 'rotationDeg'])
    expect(roamIdentityOf('zoom')).toBe(1)
    expect(roamIdentityOf('centerX')).toBe(0)
    expect(roamIdentityOf('centerY')).toBe(0)
    expect(roamIdentityOf('rotationDeg')).toBe(0)
  })

  it('values are bounded as the engine accepts them (zoom > 0)', () => {
    const [zlo] = KEY_LIMITS.zoom
    expect(zlo).toBeGreaterThan(0)
    expect(clampKeyValue('zoom', -3)).toBe(zlo)
    // centre and rotation have no ceiling: the lane grows to fit the key
    expect(clampKeyValue('centerX', 9)).toBe(9)
    expect(clampKeyValue('centerY', -40)).toBe(-40)
    expect(clampKeyValue('rotationDeg', 5000)).toBe(5000)
    expect(roamLaneRange('centerX', [K('centerX', 0, 9)], {}).max).toBeGreaterThanOrEqual(9)
    expect(clampKeyValue('centerY', Number.NaN)).toBe(0)
    expect(clampKeyValue('zoom', Number.NaN)).toBe(1)
  })

  it('zoom is a log lane around 1; centre is a symmetric offset lane in small steps', () => {
    const z = roamLaneRange('zoom', BUMP, {})
    expect(z.log).toBe(true)
    expect(z.min).toBeLessThanOrEqual(0.5)
    expect(z.max).toBeGreaterThanOrEqual(2)
    expect(laneValueToY(z, { top: 0, height: 100 }, 1)).toBeCloseTo(50, 6)
    const c = roamLaneRange('centerX', BUMP, {})
    expect(c).toEqual({ min: -0.25, max: 0.25, log: false })
    expect(roamLaneRange('centerY', [K('centerY', 0, 0.6)], {})).toEqual({ min: -1, max: 1, log: false })
  })

  it('values print in their own units', () => {
    expect(formatRoamValue('zoom', 1.5)).toBe('1.50 ×')
    expect(formatRoamValue('zoom', 1.5, { short: true })).toBe('×1.50')
    expect(formatRoamValue('centerX', 0.2)).toBe('+20.0 %')
    expect(formatRoamValue('centerX', -0.125, { short: true })).toBe('−13%')
    expect(formatRoamValue('centerY', 0)).toBe('0.0 %')
  })

  it('the same key edits work on Sweep channels', () => {
    let keys = upsertKey([], { channel: 'zoom', pos: 4800, value: 1.5 })
    keys = upsertKey(keys, { channel: 'zoom', pos: 5280, value: 1 })
    expect(keys.map((k) => [k.channel, k.pos, k.value, k.anchor])).toEqual([
      ['zoom', 4800, 1.5, 'Origin'], ['zoom', 5280, 1, 'Origin'],
    ])
    const moved = moveKey(keys, keys[0], { pos: 5000, value: 9999 })
    expect(moved[0]).toMatchObject({ pos: 5000, value: KEY_LIMITS.zoom[1] })
    expect(sortedForDisplay([K('centerX', 5, 0.1), K('zoom', 9, 2), K('zoom', 1, 1)]).map((k) => `${k.channel}${k.pos}`))
      .toEqual(['zoom1', 'zoom9', 'centerX5'])
  })
})

describe('call: Track Sweep keys', () => {
  let timeline
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    timeline = {}
    window.xleth = { timeline }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete window.xleth
  })

  it('goes to its own bridge method and announces lens-roam-changed with the post-state', async () => {
    timeline.setTrackSweepKeys = vi.fn(async (trackId, keys) => ({ trackId, changed: true, keys }))
    const seen = vi.fn()
    timelineEvents.addEventListener('lens-roam-changed', seen)
    try {
      const res = await setTrackSweepKeys(7, BUMP)
      expect(timeline.setTrackSweepKeys).toHaveBeenCalledTimes(1)
      expect(timeline.setTrackSweepKeys).toHaveBeenCalledWith(7, BUMP)
      expect(res.keys).toEqual(BUMP)
      expect(seen).toHaveBeenCalledTimes(1)
      // the Roam lane only adopts a write that carries `roam`: a Sweep write must not
      expect(seen.mock.calls[0][0].detail.roam).toBeUndefined()
    } finally {
      timelineEvents.removeEventListener('lens-roam-changed', seen)
    }
  })

  it('an unchanged write announces nothing; a failed one resolves null', async () => {
    timeline.setTrackSweepKeys = vi.fn(async (trackId, keys) => ({ trackId, changed: false, keys }))
    const seen = vi.fn()
    timelineEvents.addEventListener('lens-roam-changed', seen)
    try {
      await setTrackSweepKeys(7, [])
      expect(seen).not.toHaveBeenCalled()
      timeline.setTrackSweepKeys = vi.fn(async () => { throw new Error('timeline.setTrackSweepKeys: no track 7') })
      expect(await setTrackSweepKeys(7, BUMP)).toBeNull()
    } finally {
      timelineEvents.removeEventListener('lens-roam-changed', seen)
    }
  })

  it('a missing bridge link sends nothing and says so (the four-layer bridge never fails silently)', async () => {
    expect(await setTrackSweepKeys(7, BUMP)).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('timeline.setTrackSweepKeys is unavailable'))
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ZONES, anchorOffset, anchorReached, applyKeyOp, clampChannelValue, keyEquals, keyPlaceAt,
  laneRange, matchPreset, noteSpan, positionAtNoteTime, reanchorKey, resolveClipLens, resolveNoteLens,
  scalePresetKeys, sortNoteKeys, unitToValue, valueAtEvent, valueAtNote, valueToUnit, zoneAt,
} from './lensKeyModel.js'

// The numbers here are the ones engine/test/test_key_curve.cpp and test_lens_roam.cpp
// pin: this file is a PORT of the engine's curve maths, so it has to agree with it.

const key = (channel, anchor, pos, value, interp = 'Linear') => ({ channel, anchor, pos, value, interp })
const zoomKeys = (keys, zones) => sortNoteKeys(keys.filter((k) => k.channel === 'zoom'), zones)

// The engine's preset data (model/LensHitPresets.h), as getHitPresets returns it.
const PUNCH = [key('zoom', 'Head', 0, 1.35, 'EaseOut'), key('zoom', 'Head', 120, 1.0)]
const PUNCH_DRIFT = [
  key('zoom', 'Head', 0, 1.35, 'EaseOut'), key('zoom', 'Head', 120, 1.08),
  key('zoom', 'Tail', 240, 1.2), key('zoom', 'Tail', 0, 1.0),
]
const PULSE = [key('zoom', 'Head', 0, 1.0), key('zoom', 'Body', 0.5, 1.15), key('zoom', 'Tail', 0, 1.0)]
const PRESETS = [
  { name: 'Still', keys: [] }, { name: 'Punch', keys: PUNCH },
  { name: 'Punch + drift', keys: PUNCH_DRIFT }, { name: 'Zoom pulse', keys: PULSE },
]

describe('noteSpan / anchor mapping (KeyCurve.h)', () => {
  it('a long note: head 120, tail 240, the body between', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    expect(s.headEnd).toBe(120)
    expect(s.tailStart).toBe(720)
    expect(anchorOffset(s, 'Head', 60)).toBe(60)
    expect(anchorOffset(s, 'Body', 0.5)).toBe(420)
    expect(anchorOffset(s, 'Tail', 240)).toBe(720)
    expect(anchorOffset(s, 'Tail', 0)).toBe(960)
  })

  it('Squash scales head and tail by noteLen / (head + tail); the body is 0 long', () => {
    const s = noteSpan(180, DEFAULT_ZONES)         // 180 / 360 = 0.5
    expect(s.scale).toBe(0.5)
    expect(anchorOffset(s, 'Head', 120)).toBe(60)
    expect(anchorOffset(s, 'Tail', 240)).toBe(60)
    expect(anchorOffset(s, 'Body', 0.7)).toBe(60)
    expect(s.headEnd).toBe(s.tailStart)
  })

  it('Cut: the tail keeps its real length and starts at max(0, noteLen - tail)', () => {
    const z = { ...DEFAULT_ZONES, shortNote: 'Cut' }
    const s = noteSpan(300, z)
    expect(s.cut).toBe(true)
    expect(s.tailStart).toBe(60)
    expect(anchorOffset(s, 'Tail', 240)).toBe(60)
    expect(anchorReached(s, 'Head', 100)).toBe(false)   // cut off: 100 >= tailStart
    expect(anchorReached(s, 'Head', 30)).toBe(true)
    const tiny = noteSpan(100, z)                       // shorter than the tail
    expect(tiny.tailStart).toBe(0)
    expect(anchorReached(tiny, 'Tail', 240)).toBe(false) // starts before note-on
  })

  it('positionAtNoteTime inverts anchorOffset in every zone, Squash and Cut included', () => {
    for (const zones of [DEFAULT_ZONES, { ...DEFAULT_ZONES, shortNote: 'Cut' }, { headTicks: 60, tailTicks: 500, shortNote: 'Squash' }]) {
      for (const len of [120, 360, 480, 960, 3840]) {
        const s = noteSpan(len, zones)
        for (const [anchor, positions] of [['Head', [0, 17, 60]], ['Body', [0, 0.25, 1]], ['Tail', [0, 33, 100]]]) {
          for (const pos of positions) {
            const [lo, hi] = [anchorOffset(s, anchor, pos), 0]
            void hi
            if (!anchorReached(s, anchor, pos)) continue
            if (anchor === 'Body' && s.tailStart - s.headEnd <= 0) continue   // no body to place into
            const back = positionAtNoteTime(s, anchor, lo)
            const clamped = anchor === 'Head' ? Math.min(pos, s.headTicks) : anchor === 'Tail' ? Math.min(pos, s.tailTicks) : pos
            expect(back).toBeCloseTo(clamped, 6)
          }
        }
      }
    }
  })

  it('a position is clamped into its zone: a plain drag cannot leave it', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    expect(positionAtNoteTime(s, 'Head', 500)).toBe(120)   // past the head: the head's end
    expect(positionAtNoteTime(s, 'Tail', 100)).toBe(240)   // before the tail starts: the tail's start
    expect(positionAtNoteTime(s, 'Body', 0)).toBe(0)
  })

  it('keyPlaceAt picks the zone under a time (what Alt-drag adopts)', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    expect(keyPlaceAt(s, 50)).toEqual({ anchor: 'Head', pos: 50 })
    expect(keyPlaceAt(s, 420)).toEqual({ anchor: 'Body', pos: 0.5 })
    expect(keyPlaceAt(s, 900)).toEqual({ anchor: 'Tail', pos: 60 })
    expect(zoneAt(s, 120)).toBe('Body')
    expect(zoneAt(s, 720)).toBe('Tail')
  })

  it('reanchorKey keeps the key where it is in time as far as the new zone allows', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    const k = key('zoom', 'Head', 100, 1.2)
    const moved = reanchorKey(k, 'Body', s)
    expect(moved.anchor).toBe('Body')
    expect(moved.pos).toBe(0)                  // 100 ticks is inside the head, so the body's start is the nearest place
    expect(reanchorKey(k, 'Head', s)).toBe(k)
    const t = reanchorKey(key('zoom', 'Body', 1, 1.1), 'Tail', s)
    expect(t).toMatchObject({ anchor: 'Tail', pos: 240 })
  })
})

describe('evaluation (the engine\'s spec presets)', () => {
  it('Punch: 1.35 at note-on, ease-out to 1.0 at head 120', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    const k = zoomKeys(PUNCH, DEFAULT_ZONES)
    expect(valueAtNote(k, s, 0, 1)).toBe(1.35)
    expect(valueAtNote(k, s, 60, 1)).toBeCloseTo(1.35 + (1 - 1.35) * 0.75, 12)   // easeOut(0.5) = 0.75
    expect(valueAtNote(k, s, 120, 1)).toBe(1)
    expect(valueAtNote(k, s, 900, 1)).toBe(1)                                    // after the last key
  })

  it('Zoom pulse peaks mid-body and returns to 1 at the last frame', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    const k = zoomKeys(PULSE, DEFAULT_ZONES)
    expect(valueAtNote(k, s, 420, 1)).toBe(1.15)
    expect(valueAtNote(k, s, 960, 1)).toBe(1)
  })

  it('no keys is the fallback; Hold steps; before the first key holds the first value', () => {
    const s = noteSpan(960, DEFAULT_ZONES)
    expect(valueAtNote([], s, 100, 7)).toBe(7)
    const hold = zoomKeys([key('zoom', 'Head', 30, 2, 'Hold'), key('zoom', 'Head', 90, 3)], DEFAULT_ZONES)
    expect(valueAtNote(hold, s, 10, 1)).toBe(2)
    expect(valueAtNote(hold, s, 60, 1)).toBe(2)
    expect(valueAtNote(hold, s, 90, 1)).toBe(3)
  })

  it('event keys run on ticks from the event start (test_p7_clip_keys)', () => {
    const k = [key('zoom', 'Origin', 0, 1), key('zoom', 'Origin', 960, 2)]
    expect(valueAtEvent(k, 480, 1)).toBe(1.5)
    expect(valueAtEvent(k, 960, 1)).toBe(2)
    const rot = [key('rotationDeg', 'Origin', 480, 10, 'Hold'), key('rotationDeg', 'Origin', 1440, 20)]
    expect(valueAtEvent(rot, 1439, 0)).toBe(10)
    expect(valueAtEvent(rot, 1440, 0)).toBe(20)
  })

  it('canonical order is time order for any note length (Head asc, Body asc, Tail desc)', () => {
    const shuffled = [key('zoom', 'Tail', 0, 1), key('zoom', 'Body', 0.5, 2), key('zoom', 'Tail', 240, 3), key('zoom', 'Head', 90, 4), key('zoom', 'Head', 10, 5)]
    expect(sortNoteKeys(shuffled, DEFAULT_ZONES).map((k) => `${k.anchor}${k.pos}`)).toEqual(['Head10', 'Head90', 'Body0.5', 'Tail240', 'Tail0'])
  })
})

describe('resolveNoteLens: the layer stack (LensRoamSnapshot::lensForEventAt)', () => {
  const base = { zoom: 1.2, centerX: 0.4, centerY: 0.5, rotationDeg: 5 }
  const common = { base, hitKeys: PUNCH, zones: DEFAULT_ZONES, noteLen: 960, t: 0 }

  it('Follow = base x hit curve: zoom multiplies, centre and rotation add', () => {
    const r = resolveNoteLens({ ...common, mode: 'Follow' })
    expect(r.resolved.zoom).toBeCloseTo(1.2 * 1.35, 12)
    expect(r.resolved.centerX).toBe(0.4)
    expect(r.resolved.rotationDeg).toBe(5)
    expect(r.hit.zoom).toBe(1.35)
    expect(r.note).toBeNull()
  })

  it('Nudge = base x hit x note keys; Own = base x note keys only', () => {
    const own = [key('zoom', 'Head', 0, 2), key('centerX', 'Head', 0, 0.1)]
    const nudge = resolveNoteLens({ ...common, mode: 'Nudge', noteKeys: own })
    expect(nudge.resolved.zoom).toBeCloseTo(1.2 * 1.35 * 2, 12)
    expect(nudge.resolved.centerX).toBeCloseTo(0.5, 12)
    const o = resolveNoteLens({ ...common, mode: 'Own', noteKeys: own })
    expect(o.hit).toBeNull()
    expect(o.resolved.zoom).toBeCloseTo(1.2 * 2, 12)
  })

  it('an Own note plays on the DEFAULT zones, whatever the source set (no hit-curve edit reaches it)', () => {
    const wide = { headTicks: 480, tailTicks: 240, shortNote: 'Squash' }
    const own = [key('zoom', 'Head', 120, 3), key('zoom', 'Head', 0, 1)]
    const a = resolveNoteLens({ ...common, zones: wide, mode: 'Own', noteKeys: own, t: 120 })
    const b = resolveNoteLens({ ...common, zones: DEFAULT_ZONES, mode: 'Own', noteKeys: own, t: 120 })
    expect(a.resolved).toEqual(b.resolved)
    // A Nudge plays on the SOURCE's zones: on a short note the zones set how the curve squashes.
    const n = resolveNoteLens({ ...common, zones: wide, mode: 'Nudge', noteKeys: [], noteLen: 200, t: 60 })
    const m = resolveNoteLens({ ...common, zones: DEFAULT_ZONES, mode: 'Nudge', noteKeys: [], noteLen: 200, t: 60 })
    expect(n.resolved.zoom).not.toBe(m.resolved.zoom)
  })

  it('Still (no hit keys) holds the base', () => {
    const r = resolveNoteLens({ ...common, hitKeys: [], mode: 'Follow' })
    expect(r.hit).toBeNull()
    expect(r.resolved).toEqual(base)
  })

  it('resolveClipLens: a keyed channel follows its keys, an unkeyed one holds the base', () => {
    const r = resolveClipLens({ base: { ...base, centerY: 0.3 }, keys: [key('zoom', 'Origin', 0, 1), key('zoom', 'Origin', 960, 2)], t: 480 })
    expect(r.resolved.zoom).toBe(1.5)
    expect(r.resolved.centerY).toBe(0.3)
    expect(r.resolved.centerX).toBe(0.4)
  })
})

describe('applyKeyOp: one edit, applied to each note\'s own keys', () => {
  const a = key('zoom', 'Head', 10, 1.2)
  const b = key('zoom', 'Tail', 0, 1.0)

  it('add / update / remove return new arrays and never mutate', () => {
    const keys = [a, b]
    const added = applyKeyOp(keys, { type: 'add', key: key('centerX', 'Body', 0.5, 0.1) })
    expect(added).toHaveLength(3)
    expect(keys).toHaveLength(2)
    const moved = applyKeyOp(keys, { type: 'update', match: a, patch: { pos: 20, value: 1.5 } })
    expect(moved[0]).toMatchObject({ pos: 20, value: 1.5, channel: 'zoom', anchor: 'Head' })
    expect(applyKeyOp(keys, { type: 'remove', match: b })).toEqual([a])
  })

  it('an edit that does not apply to a list returns null (that note is skipped)', () => {
    expect(applyKeyOp([b], { type: 'update', match: a, patch: { pos: 20 } })).toBeNull()
    expect(applyKeyOp([b], { type: 'remove', match: a })).toBeNull()
    expect(applyKeyOp([a], { type: 'add', key: a })).toBeNull()
    expect(applyKeyOp([a], { type: 'update', match: a, patch: { pos: 10 } })).toBeNull()   // no change
  })

  it('keyEquals treats a missing interp as Linear', () => {
    expect(keyEquals({ ...a, interp: undefined }, a)).toBe(true)
    expect(keyEquals(a, { ...a, interp: 'Hold' })).toBe(false)
  })

  it('values the engine would reject are clamped (zoom must stay > 0)', () => {
    expect(clampChannelValue('zoom', 0)).toBeGreaterThan(0)
    expect(clampChannelValue('zoom', -3)).toBeGreaterThan(0)
    expect(clampChannelValue('centerX', 1.7, true)).toBe(1)
  })
})

describe('presets and Strength', () => {
  it('matches each preset at 100 %, Still as the empty curve, and a hand-edited curve as Custom', () => {
    expect(matchPreset([], PRESETS)).toEqual({ name: 'Still', strength: 1 })
    for (const p of PRESETS.slice(1)) expect(matchPreset(p.keys, PRESETS)).toEqual({ name: p.name, strength: 1 })
    expect(matchPreset([key('zoom', 'Head', 0, 1.5)], PRESETS)).toBeNull()
    expect(matchPreset([...PUNCH, key('zoom', 'Body', 0.5, 1.1)], PRESETS)).toBeNull()
  })

  it('scaling a preset moves every key from its identity; the match recovers the strength', () => {
    const half = scalePresetKeys(PUNCH_DRIFT, 0.5)
    expect(half[0].value).toBeCloseTo(1.175, 12)         // 1 + 0.5 * 0.35
    expect(half[3].value).toBe(1)                         // a key AT the identity stays there
    expect(half.map((k) => k.interp)).toEqual(PUNCH_DRIFT.map((k) => k.interp))
    const m = matchPreset(half, PRESETS)
    expect(m.name).toBe('Punch + drift')
    expect(m.strength).toBeCloseTo(0.5, 9)
    expect(matchPreset(scalePresetKeys(PULSE, 2), PRESETS).strength).toBeCloseTo(2, 9)
  })

  it('an inconsistent scale is Custom (a key edited by hand)', () => {
    const edited = scalePresetKeys(PUNCH_DRIFT, 1).map((k, i) => (i === 2 ? { ...k, value: 1.5 } : k))
    expect(matchPreset(edited, PRESETS)).toBeNull()
  })
})

describe('lane scales', () => {
  it('zoom is logarithmic, contains the identity and every key, with room around them', () => {
    const r = laneRange('zoom', [1.35, 0.8])
    expect(r.log).toBe(true)
    expect(r.min).toBeLessThan(0.8)
    expect(r.max).toBeGreaterThan(1.5)
    expect(valueToUnit(r, 1)).toBeGreaterThan(0)
    expect(valueToUnit(r, 1)).toBeLessThan(1)
    expect(unitToValue(r, valueToUnit(r, 1.35))).toBeCloseTo(1.35, 9)
  })

  it('offset lanes are symmetric about 0; absolute clip centres cover 0..1', () => {
    const r = laneRange('centerX', [0.1, -0.3])
    expect(r.min).toBe(-r.max)
    expect(r.max).toBeGreaterThanOrEqual(0.3)
    const c = laneRange('centerX', [0.2], { absolute: true, base: 0.5 })
    expect(c.min).toBeLessThan(0)
    expect(c.max).toBeGreaterThan(1)
    expect(laneRange('rotationDeg', [90]).max).toBeGreaterThanOrEqual(90)
  })
})

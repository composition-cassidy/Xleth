import { describe, it, expect } from 'vitest'
import {
  applyGroupGainDrag,
  applyGroupFadeDrag,
  applyGainDrag,
  velocityToDb,
  dbToVelocity,
  CLIP_GAIN_MAX_DB,
  CLIP_CONTROL_DEFAULTS,
} from '../clipControlSpec.js'

const FLOOR_DB = CLIP_CONTROL_DEFAULTS.interaction.muteFloorDb
const db = (velocity) => velocityToDb(velocity)

describe('applyGroupGainDrag', () => {
  it('matches the single-clip drag when only one clip is selected', () => {
    const solo = applyGainDrag(1, 40)
    const group = applyGroupGainDrag([{ id: 'a', velocity: 1 }], 40)
    expect(group.values.get('a')).toBeCloseTo(solo, 9)
    expect(group.blocked).toEqual([])
  })

  it('applies the same dB delta to clips that start at different gains', () => {
    // Anchor at unity, second clip already 5 dB down.
    const start = dbToVelocity(-5)
    const { values, blocked } = applyGroupGainDrag(
      [{ id: 'anchor', velocity: 1 }, { id: 'quiet', velocity: start }],
      // gainDbPerPixel is 0.25 and drag is inverted: +20px == -5 dB.
      20,
    )
    expect(db(values.get('anchor'))).toBeCloseTo(-5, 6)
    expect(db(values.get('quiet'))).toBeCloseTo(-10, 6)
    expect(blocked).toEqual([])
  })

  it('preserves the gap when pushed the other way', () => {
    const { values } = applyGroupGainDrag(
      [{ id: 'anchor', velocity: 1 }, { id: 'quiet', velocity: dbToVelocity(-5) }],
      -20, // +5 dB
    )
    expect(db(values.get('anchor'))).toBeCloseTo(5, 6)
    expect(db(values.get('quiet'))).toBeCloseTo(0, 6)
  })

  it('stops the WHOLE group when one clip hits the ceiling, and names it', () => {
    // 'loud' is already at the max, so the group cannot move up at all.
    const { values, blocked } = applyGroupGainDrag(
      [
        { id: 'anchor', velocity: 1 },
        { id: 'loud', velocity: dbToVelocity(CLIP_GAIN_MAX_DB) },
      ],
      -400,
    )
    expect(blocked).toEqual(['loud'])
    // The anchor did NOT keep travelling past the group limit.
    expect(db(values.get('anchor'))).toBeCloseTo(0, 6)
    expect(db(values.get('loud'))).toBeCloseTo(CLIP_GAIN_MAX_DB, 6)
  })

  it('stops the whole group at the mute floor too', () => {
    const { values, blocked } = applyGroupGainDrag(
      [
        { id: 'anchor', velocity: 1 },
        { id: 'silent', velocity: 0 },
      ],
      4000,
    )
    expect(blocked).toEqual(['silent'])
    expect(db(values.get('anchor'))).toBeCloseTo(0, 6)
  })

  it('lets the group travel right up to the limiting clip and no further', () => {
    // 'loud' has 5 dB of headroom; the anchor is asked for far more.
    const { values, blocked } = applyGroupGainDrag(
      [
        { id: 'anchor', velocity: 1 },
        { id: 'loud', velocity: dbToVelocity(CLIP_GAIN_MAX_DB - 5) },
      ],
      -400,
    )
    expect(blocked).toEqual(['loud'])
    expect(db(values.get('anchor'))).toBeCloseTo(5, 6)
    expect(db(values.get('loud'))).toBeCloseTo(CLIP_GAIN_MAX_DB, 6)
  })

  it('reports every clip pinned at the same bound', () => {
    const { blocked } = applyGroupGainDrag(
      [
        { id: 'anchor', velocity: 1 },
        { id: 'loudA', velocity: dbToVelocity(CLIP_GAIN_MAX_DB) },
        { id: 'loudB', velocity: dbToVelocity(CLIP_GAIN_MAX_DB) },
      ],
      -400,
    )
    expect(blocked.sort()).toEqual(['loudA', 'loudB'])
  })

  it('treats a silent clip as sitting on the mute floor, not at -Infinity', () => {
    const { values } = applyGroupGainDrag(
      [{ id: 'anchor', velocity: 1 }, { id: 'silent', velocity: 0 }],
      -20, // +5 dB
    )
    expect(db(values.get('silent'))).toBeCloseTo(FLOOR_DB + 5, 6)
  })

  it('returns an empty result for an empty selection', () => {
    const { values, blocked } = applyGroupGainDrag([], 50)
    expect(values.size).toBe(0)
    expect(blocked).toEqual([])
  })
})

describe('applyGroupFadeDrag', () => {
  it('applies the same percent delta regardless of pre-existing fades', () => {
    const { values, blocked } = applyGroupFadeDrag(
      'fadeIn',
      [
        { id: 'anchor', start: 0, opposite: 0 },
        { id: 'faded', start: 10, opposite: 0 },
      ],
      20, 200, // 20px over a 200px anchor == +10%
    )
    expect(values.get('anchor')).toBeCloseTo(10, 6)
    expect(values.get('faded')).toBeCloseTo(20, 6)
    expect(blocked).toEqual([])
  })

  it('stops the group at 0% and names the clip that bottomed out', () => {
    const { values, blocked } = applyGroupFadeDrag(
      'fadeIn',
      [
        { id: 'anchor', start: 50, opposite: 0 },
        { id: 'shallow', start: 5, opposite: 0 },
      ],
      -200, 200, // -100%
    )
    expect(blocked).toEqual(['shallow'])
    expect(values.get('shallow')).toBeCloseTo(0, 6)
    expect(values.get('anchor')).toBeCloseTo(45, 6)
  })

  it('respects each clip’s own headroom against the opposite fade', () => {
    // 'tight' already spends 80% on its fade-out, so it has only 20% total.
    const { values, blocked } = applyGroupFadeDrag(
      'fadeIn',
      [
        { id: 'anchor', start: 0, opposite: 0 },
        { id: 'tight', start: 10, opposite: 80 },
      ],
      200, 200, // +100%
    )
    expect(blocked).toEqual(['tight'])
    expect(values.get('tight')).toBeCloseTo(20, 6)
    expect(values.get('anchor')).toBeCloseTo(10, 6)
  })

  it('drags fade-out in the mirrored direction', () => {
    const { values } = applyGroupFadeDrag(
      'fadeOut',
      [{ id: 'anchor', start: 0, opposite: 0 }, { id: 'b', start: 10, opposite: 0 }],
      -20, 200,
    )
    expect(values.get('anchor')).toBeCloseTo(10, 6)
    expect(values.get('b')).toBeCloseTo(20, 6)
  })

  it('never produces a fade pair summing past 100%', () => {
    const { values } = applyGroupFadeDrag(
      'fadeIn',
      [{ id: 'a', start: 30, opposite: 60 }],
      1000, 200,
    )
    expect(values.get('a') + 60).toBeLessThanOrEqual(100 + 1e-9)
  })
})

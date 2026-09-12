import { describe, it, expect } from 'vitest'
import { drawLengthForSnap, adoptDrawLength, resetDrawLength } from './drawLength.js'

const SIXTEENTH = 240   // PPQ/4
const THIRTYSECOND = 120
const BEAT = 960

describe('drawLength — snap-following default', () => {
  it('follows every SNAP change while nothing has overridden it', () => {
    let s = { lengthTicks: SIXTEENTH, overridden: false }
    s = drawLengthForSnap(s, BEAT)
    expect(s).toEqual({ lengthTicks: BEAT, overridden: false })
    s = drawLengthForSnap(s, THIRTYSECOND)
    expect(s).toEqual({ lengthTicks: THIRTYSECOND, overridden: false })
  })

  it('is a no-op (identical object) when the snap division is already active', () => {
    const s = { lengthTicks: SIXTEENTH, overridden: false }
    expect(drawLengthForSnap(s, SIXTEENTH)).toBe(s)
  })
})

describe('drawLength — adopting a clip length', () => {
  it('adopts a length that differs from the snap division and arms the override', () => {
    const s = adoptDrawLength({ lengthTicks: BEAT, overridden: false }, THIRTYSECOND, BEAT)
    expect(s).toEqual({ lengthTicks: THIRTYSECOND, overridden: true })
  })

  it('adopts a length that differs by a single tick', () => {
    const s = adoptDrawLength({ lengthTicks: SIXTEENTH, overridden: false }, SIXTEENTH + 1, SIXTEENTH)
    expect(s).toEqual({ lengthTicks: SIXTEENTH + 1, overridden: true })
  })

  it('keeps the overridden length across SNAP changes', () => {
    let s = adoptDrawLength({ lengthTicks: BEAT, overridden: false }, THIRTYSECOND, BEAT)
    s = drawLengthForSnap(s, SIXTEENTH)
    s = drawLengthForSnap(s, BEAT)
    expect(s).toEqual({ lengthTicks: THIRTYSECOND, overridden: true })
  })

  it('disarms the override when the adopted length is exactly one snap division', () => {
    let s = adoptDrawLength({ lengthTicks: SIXTEENTH, overridden: false }, THIRTYSECOND, SIXTEENTH)
    expect(s.overridden).toBe(true)
    s = adoptDrawLength(s, SIXTEENTH, SIXTEENTH)
    expect(s).toEqual({ lengthTicks: SIXTEENTH, overridden: false })
    expect(drawLengthForSnap(s, BEAT)).toEqual({ lengthTicks: BEAT, overridden: false })
  })

  it('rounds fractional lengths and ignores invalid ones', () => {
    const base = { lengthTicks: SIXTEENTH, overridden: false }
    expect(adoptDrawLength(base, 119.6, SIXTEENTH).lengthTicks).toBe(120)
    expect(adoptDrawLength(base, 0, SIXTEENTH)).toBe(base)
    expect(adoptDrawLength(base, -240, SIXTEENTH)).toBe(base)
    expect(adoptDrawLength(base, NaN, SIXTEENTH)).toBe(base)
    expect(adoptDrawLength(base, undefined, SIXTEENTH)).toBe(base)
  })
})

describe('drawLength — project load', () => {
  it('drops the override and returns to the snap division', () => {
    expect(resetDrawLength(SIXTEENTH)).toEqual({ lengthTicks: SIXTEENTH, overridden: false })
  })
})

import { describe, it, expect } from 'vitest'
import { resolveLeftTrim, resolveRightTrim } from './clipTrim.js'

// What a clip plays at each timeline tick, as source ticks. This is the
// reference the trims are judged against: it is how ClipRenderCache reads the
// source (window [offset, offset + duration / ratio), reversed in place for a
// reversed clip), written out directly rather than through the code under test.
function sourceAt(clip, timelineTick) {
  const local = timelineTick - clip.positionTicks
  if (local < 0 || local >= clip.durationTicks) return null
  const ratio = clip.stretchRatio ?? 1
  const consumed = local / ratio
  const window = clip.durationTicks / ratio
  return clip.reversed
    ? clip.regionOffsetTicks + window - consumed
    : clip.regionOffsetTicks + consumed
}

const apply = (clip, patch) => ({ ...clip, ...patch })

// The whole point of a trim: wherever the old and new clip both play, they play
// the same source. Checked at ticks spread over the overlap.
function expectAnchored(before, after, tolerance = 1) {
  const start = Math.max(before.positionTicks, after.positionTicks)
  const end = Math.min(before.positionTicks + before.durationTicks, after.positionTicks + after.durationTicks)
  expect(end).toBeGreaterThan(start)
  for (let i = 0; i <= 8; i++) {
    const tick = start + ((end - start - 1) * i) / 8
    expect(Math.abs(sourceAt(after, tick) - sourceAt(before, tick))).toBeLessThanOrEqual(tolerance)
  }
}

const forward = { positionTicks: 1920, durationTicks: 1920, regionOffsetTicks: 480, stretchRatio: 1, reversed: false }
const reversed = { ...forward, reversed: true }
const REGION = 4800   // source ticks of audio in the region

describe('resolveRightTrim', () => {
  it('forward clip: shortening keeps the offset', () => {
    const t = resolveRightTrim(forward, 960, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t).toEqual({ durationTicks: 960, regionOffsetTicks: 480 })
    expectAnchored(forward, apply(forward, t))
  })

  it('reversed clip: shortening moves the offset so the START of playback stays put', () => {
    const t = resolveRightTrim(reversed, 960, { regionSourceTicks: REGION, minDurationTicks: 120 })
    // The window loses its first 960 source ticks: what played last is gone.
    expect(t).toEqual({ durationTicks: 960, regionOffsetTicks: 1440 })
    expectAnchored(reversed, apply(reversed, t))
  })

  it('reversed clip treated as forward would slide the audio (the bug this replaces)', () => {
    const wrong = apply(reversed, { durationTicks: 960 })   // offset left alone
    const tick = reversed.positionTicks + 100
    expect(Math.abs(sourceAt(wrong, tick) - sourceAt(reversed, tick))).toBe(960)
  })

  it('forward clip: lengthening stops at the end of the region', () => {
    const t = resolveRightTrim(forward, 99999, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t.durationTicks).toBe(REGION - 480)
    expect(t.regionOffsetTicks).toBe(480)
  })

  it('reversed clip: lengthening reveals earlier source and stops at offset 0', () => {
    const t = resolveRightTrim(reversed, 99999, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t).toEqual({ durationTicks: 1920 + 480, regionOffsetTicks: 0 })
    expectAnchored(reversed, apply(reversed, t))
  })

  it('never goes below the minimum duration', () => {
    expect(resolveRightTrim(forward, -500, { minDurationTicks: 120 }).durationTicks).toBe(120)
    expect(resolveRightTrim(reversed, 0, { minDurationTicks: 60 }).durationTicks).toBe(60)
  })

  it('stretched clips move the offset in SOURCE ticks', () => {
    const clip = { ...reversed, stretchRatio: 2 }             // 1920 timeline = 960 source
    const t = resolveRightTrim(clip, 960, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t).toEqual({ durationTicks: 960, regionOffsetTicks: 480 + 480 })
    expectAnchored(clip, apply(clip, t))
  })

  it('an unknown region length does not limit growth at the window end', () => {
    expect(resolveRightTrim(forward, 50000, { minDurationTicks: 120 }).durationTicks).toBe(50000)
    expect(resolveRightTrim(forward, 50000, { regionSourceTicks: Number.MAX_SAFE_INTEGER, minDurationTicks: 120 }).durationTicks).toBe(50000)
  })
})

describe('resolveLeftTrim', () => {
  it('forward clip: trimming in advances the offset', () => {
    const t = resolveLeftTrim(forward, 2400, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t).toEqual({ positionTicks: 2400, durationTicks: 1440, regionOffsetTicks: 960 })
    expectAnchored(forward, apply(forward, t))
  })

  it('reversed clip: trimming in keeps the offset (the window loses its END)', () => {
    const t = resolveLeftTrim(reversed, 2400, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t).toEqual({ positionTicks: 2400, durationTicks: 1440, regionOffsetTicks: 480 })
    expectAnchored(reversed, apply(reversed, t))
  })

  it('forward clip: dragging out stops where the offset reaches 0', () => {
    const t = resolveLeftTrim(forward, 0, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t).toEqual({ positionTicks: 1440, durationTicks: 2400, regionOffsetTicks: 0 })
    expectAnchored(forward, apply(forward, t))
  })

  it('reversed clip: dragging out stops at the end of the region', () => {
    const t = resolveLeftTrim(reversed, 0, { regionSourceTicks: 3000, minDurationTicks: 120 })
    // window may grow from [480, 2400) to [480, 3000): 600 more source ticks
    expect(t).toEqual({ positionTicks: 1920 - 600, durationTicks: 1920 + 600, regionOffsetTicks: 480 })
    expectAnchored(reversed, apply(reversed, t))
  })

  it('the right edge never moves', () => {
    for (const clip of [forward, reversed]) {
      for (const request of [0, 1000, 2000, 3000, 99999]) {
        const t = resolveLeftTrim(clip, request, { regionSourceTicks: REGION, minDurationTicks: 120 })
        expect(t.positionTicks + t.durationTicks).toBe(clip.positionTicks + clip.durationTicks)
        expect(t.durationTicks).toBeGreaterThanOrEqual(120)
        expect(t.positionTicks).toBeGreaterThanOrEqual(0)
        expect(t.regionOffsetTicks).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('stretched forward clip: a timeline distance becomes a smaller source distance', () => {
    const clip = { ...forward, stretchRatio: 4 }
    const t = resolveLeftTrim(clip, 1920 + 960, { regionSourceTicks: REGION, minDurationTicks: 120 })
    expect(t.regionOffsetTicks).toBe(480 + 240)
    expectAnchored(clip, apply(clip, t))
  })

  it('never starts before tick 0', () => {
    const clip = { ...reversed, positionTicks: 100 }
    expect(resolveLeftTrim(clip, -5000, { minDurationTicks: 120 }).positionTicks).toBe(0)
  })
})

describe('trims compose', () => {
  it('trimming in and back out returns the original clip, forward and reversed', () => {
    for (const clip of [forward, reversed, { ...forward, stretchRatio: 2 }, { ...reversed, stretchRatio: 2 }]) {
      const limits = { regionSourceTicks: REGION, minDurationTicks: 120 }
      const shorter = apply(clip, resolveRightTrim(clip, 960, limits))
      const restored = apply(shorter, resolveRightTrim(shorter, clip.durationTicks, limits))
      expect(restored).toEqual(clip)

      const later = apply(clip, resolveLeftTrim(clip, clip.positionTicks + 480, limits))
      const back = apply(later, resolveLeftTrim(later, clip.positionTicks, limits))
      expect(back).toEqual(clip)
    }
  })
})

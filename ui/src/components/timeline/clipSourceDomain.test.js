import { describe, expect, it } from 'vitest'
import {
  effectiveStretchRatio,
  sourceTicksForTimelineTicks,
  timelineTicksForSourceTicks,
} from './clipSourceDomain.js'
import { computeQuantizeForClip } from '../../utils/quantize.js'

const PPQ = 960
const BAR = 4 * PPQ

describe('clipSourceDomain', () => {
  it('is the identity at unity ratio', () => {
    for (const t of [0, 1, 53, PPQ, 123457]) {
      expect(sourceTicksForTimelineTicks(t, 1.0)).toBe(t)
      expect(timelineTicksForSourceTicks(t, 1.0)).toBe(t)
    }
  })

  it('converts a 1.50x half-bar split the way the engine does', () => {
    // The reported bug: the old code added the 1920 TIMELINE ticks straight into
    // the source-domain regionOffset, overshooting by 640 ticks.
    expect(sourceTicksForTimelineTicks(BAR / 2, 1.5)).toBe(1280)
    expect(timelineTicksForSourceTicks(1280, 1.5)).toBe(BAR / 2)
  })

  it('round-trips across the stretch range the engine clamps to', () => {
    for (const r of [0.1, 0.5, 0.75, 1.5, 2.0, 3.0, 8.0, 20.0]) {
      for (const t of [120, PPQ, BAR, 8 * BAR]) {
        const back = timelineTicksForSourceTicks(sourceTicksForTimelineTicks(t, r), r)
        expect(Math.abs(back - t)).toBeLessThanOrEqual(Math.ceil(r))
      }
    }
  })

  it('tiles the source span when a stretched clip is split', () => {
    const r = 1.5
    const clipDur = 2400
    const leftDur = 1000
    const offset = 53
    const rightOffset = offset + sourceTicksForTimelineTicks(leftDur, r)
    const whole = sourceTicksForTimelineTicks(clipDur, r)
    const rightSource = sourceTicksForTimelineTicks(clipDur - leftDur, r)
    expect(Math.abs(rightOffset + rightSource - (offset + whole))).toBeLessThanOrEqual(1)
    expect(rightOffset).toBeGreaterThan(offset)
    expect(rightOffset).toBeLessThan(offset + whole)
  })

  it('degrades a bad ratio to unity instead of dividing by zero', () => {
    expect(effectiveStretchRatio(0)).toBe(1.0)
    expect(effectiveStretchRatio(-2)).toBe(1.0)
    expect(effectiveStretchRatio(NaN)).toBe(1.0)
    expect(effectiveStretchRatio(undefined)).toBe(1.0)
    expect(sourceTicksForTimelineTicks(PPQ, 0)).toBe(PPQ)
    expect(Number.isFinite(sourceTicksForTimelineTicks(PPQ, NaN))).toBe(true)
  })
})

describe('quantize start-trim honours stretchRatio', () => {
  // Start-trim moves the left edge and skips into the source. On a stretched clip
  // it must skip delta/ratio of source, not delta.
  const START = 500          // 0.52 beats → snaps forward to beat 1 (960 ticks)
  const clip = (stretch) => ({
    id: 1,
    isPatternBlock: false,
    oldStart: START,
    oldEnd: START + 2 * BAR,
    oldOffset: 0,
    oldStretch: stretch,
  })

  it('scales the offset delta by the ratio', () => {
    const { spec } = computeQuantizeForClip(clip(2.0), 'trim', 'leave', 'Beat')
    expect(spec).toBeTruthy()
    const delta = spec.newStartTicks - START
    expect(delta).toBe(460)
    expect(spec.newOffsetTicks).toBe(Math.round(delta / 2.0))
    expect(spec.newStretchRatio).toBe(2.0)   // a trim never re-stretches
  })

  it('is unchanged for unstretched clips', () => {
    const { spec } = computeQuantizeForClip(clip(1.0), 'trim', 'leave', 'Beat')
    const delta = spec.newStartTicks - START
    expect(spec.newOffsetTicks).toBe(delta)
  })
})

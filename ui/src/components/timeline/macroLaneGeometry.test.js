import { describe, expect, it } from 'vitest'
import { PPQ } from '../../constants/timeline.js'
import {
  clipPixelRect,
  pxDeltaToTickDelta,
  snapTick,
  moveStartTick,
  xToClipLocalTick,
  yToValue,
  valueToY,
  clipLocalTickToX,
  buildCurvePoints,
} from './macroLaneGeometry.js'

const PPB = 40 // pixels per beat

describe('clipPixelRect', () => {
  it('positions a clip using the same math as canvas audio clips', () => {
    const clip = { startTick: PPQ * 2, lengthTicks: PPQ } // beat 2, one beat long
    const rect = clipPixelRect(clip, PPB, 0)
    expect(rect.left).toBe(2 * PPB)
    expect(rect.width).toBe(PPB)
  })
  it('accounts for horizontal scrollOffset (in beats)', () => {
    const clip = { startTick: PPQ * 4, lengthTicks: PPQ * 2 }
    const rect = clipPixelRect(clip, PPB, 2)
    expect(rect.left).toBe((4 - 2) * PPB)
    expect(rect.width).toBe(2 * PPB)
  })
})

describe('pxDeltaToTickDelta', () => {
  it('converts a pixel delta to ticks', () => {
    expect(pxDeltaToTickDelta(PPB, PPB)).toBe(PPQ)        // one beat
    expect(pxDeltaToTickDelta(-PPB / 2, PPB)).toBe(-PPQ / 2)
  })
  it('guards bad zoom', () => {
    expect(pxDeltaToTickDelta(100, 0)).toBe(0)
  })
})

describe('snapTick / moveStartTick', () => {
  it('snaps to the 1/16 grid by default (rounds to nearest 240 ticks)', () => {
    expect(snapTick(250, {}, '1/16')).toBe(240)
    expect(snapTick(360, {}, '1/16')).toBe(480)
  })
  it('alt = free (no snap), clamped to >= 0', () => {
    expect(snapTick(257, { alt: true })).toBe(257)
    expect(snapTick(-5, { alt: true })).toBe(0)
  })
  it('moveStartTick applies a snapped pixel delta', () => {
    // origin beat 1 (960t), drag right by one beat → beat 2
    expect(moveStartTick(PPQ, PPB, PPB, {}, '1/16')).toBe(PPQ * 2)
    // never negative
    expect(moveStartTick(0, -PPB * 4, PPB, {}, '1/16')).toBe(0)
  })
})

describe('point mapping', () => {
  const clip = { startTick: PPQ * 2, lengthTicks: PPQ * 4 }

  it('xToClipLocalTick clamps to clip bounds', () => {
    // X at the clip start → local tick 0
    expect(xToClipLocalTick(2 * PPB, clip, PPB, 0)).toBe(0)
    // X one beat into the clip → 960 local ticks
    expect(xToClipLocalTick(3 * PPB, clip, PPB, 0)).toBe(PPQ)
    // X far left of the clip → clamped to 0
    expect(xToClipLocalTick(0, clip, PPB, 0)).toBe(0)
    // X far right of the clip → clamped to lengthTicks
    expect(xToClipLocalTick(100 * PPB, clip, PPB, 0)).toBe(clip.lengthTicks)
  })

  it('yToValue / valueToY are inverse within the content band', () => {
    const top = 10, h = 26
    expect(yToValue(top, top, h)).toBe(1)          // top → max
    expect(yToValue(top + h, top, h)).toBe(0)      // bottom → min
    expect(yToValue(top + h / 2, top, h)).toBeCloseTo(0.5, 5)
    expect(valueToY(1, top, h)).toBe(top)
    expect(valueToY(0, top, h)).toBe(top + h)
  })

  it('clipLocalTickToX is the inverse of xToClipLocalTick', () => {
    const x = clipLocalTickToX(PPQ, clip, PPB, 0)
    expect(x).toBe(3 * PPB)
    expect(xToClipLocalTick(x, clip, PPB, 0)).toBe(PPQ)
  })

  it('buildCurvePoints emits lane-local coordinates for each point', () => {
    const points = [
      { tick: 0, value: 1 },
      { tick: PPQ * 2, value: 0 },
    ]
    const top = 5, h = 26
    const str = buildCurvePoints(points, clip, PPB, top, h)
    // first point: x=0, y=top (value 1); second: x=2*PPB, y=top+h (value 0)
    expect(str).toBe(`0.00,${top.toFixed(2)} ${(2 * PPB).toFixed(2)},${(top + h).toFixed(2)}`)
  })
})

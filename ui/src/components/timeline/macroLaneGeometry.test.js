import { describe, expect, it } from 'vitest'
import { PPQ } from '../../constants/timeline.js'
import {
  clipPixelRect,
  pxDeltaToTickDelta,
  snapTick,
  snapTickToTimelineGrid,
  snapClipStartTick,
  snapClipEndTick,
  snapAutomationPointTick,
  moveStartTick,
  xToClipLocalTick,
  yToValue,
  valueToY,
  clipLocalTickToX,
  buildCurvePoints,
  buildLoopGhostCurveSegments,
  buildLoopRepeatDividers,
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
  it('converts the 1/32 grid to 120 ticks at PPQ 960', () => {
    expect(snapTickToTimelineGrid(61, '1/32', PPQ)).toBe(120)
    expect(snapTickToTimelineGrid(181, '1/32', PPQ)).toBe(240)
  })

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

  it('snapClipStartTick snaps clip move/paste start positions', () => {
    expect(snapClipStartTick(121, {}, '1/32')).toBe(120)
    expect(snapClipStartTick(59, { alt: true }, '1/32')).toBe(59)
  })

  it('snapClipEndTick snaps resize end while preserving a positive length', () => {
    expect(snapClipEndTick(PPQ + 121, PPQ, 60, {}, '1/32')).toBe(PPQ + 120)
    expect(snapClipEndTick(PPQ + 10, PPQ, 60, {}, '1/32')).toBe(PPQ + 60)
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
    expect(yToValue(top + h * 0.37, top, h)).toBeCloseTo(0.63, 5)
    expect(valueToY(1, top, h)).toBe(top)
    expect(valueToY(0, top, h)).toBe(top + h)
  })

  it('snapAutomationPointTick snaps against absolute project tick before returning local tick', () => {
    const offGridClip = { startTick: 100, lengthTicks: PPQ * 2 }
    // local 50 -> absolute 150 -> 1/16 grid 240 -> local 140.
    expect(snapAutomationPointTick(50, offGridClip, {}, '1/16')).toBe(140)
  })

  it('snapAutomationPointTick clamps snapped points inside clip bounds', () => {
    expect(snapAutomationPointTick(PPQ * 9, clip, {}, '1/16')).toBe(clip.lengthTicks)
    expect(snapAutomationPointTick(-PPQ, clip, {}, '1/16')).toBe(0)
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

describe('loop ghost geometry', () => {
  it('builds repeated ghost curve segments inside clip bounds', () => {
    const clip = { startTick: 0, lengthTicks: PPQ * 4, loopEnabled: true }
    const points = [
      { tick: 0, value: 1 },
      { tick: PPQ, value: 0 },
    ]
    const segments = buildLoopGhostCurveSegments(points, clip, PPB, 5, 20)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toContain('40.00,5.00')
    expect(segments[2]).toContain('160.00,25.00')
  })

  it('omits ghost segments for non-loop clips', () => {
    const clip = { startTick: 0, lengthTicks: PPQ * 4, loopEnabled: false }
    const points = [{ tick: 0, value: 1 }, { tick: PPQ, value: 0 }]
    expect(buildLoopGhostCurveSegments(points, clip, PPB, 5, 20)).toEqual([])
  })

  it('builds repeat dividers only up to the clip end', () => {
    const clip = { startTick: 0, lengthTicks: PPQ * 3, loopEnabled: true }
    const points = [{ tick: 0, value: 1 }, { tick: PPQ, value: 0 }]
    expect(buildLoopRepeatDividers(points, clip, PPB)).toEqual([40, 80])
  })
})

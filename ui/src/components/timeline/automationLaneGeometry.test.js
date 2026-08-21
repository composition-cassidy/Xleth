import { describe, it, expect } from 'vitest'
import {
  AUTOMATION_POINT_HIT_RADIUS_PX,
  applyPointDragPreview,
  automationClipBodyRect,
  automationEnvelopeOriginTick,
  canvasPosToEnvelopePoint,
  envelopePointToCanvasPos,
  hitTestAutomationPoint,
  isTickInsideClipWindow,
  sampleEnvelopeValueAtTick,
} from './automationLaneGeometry.js'
import { PPQ } from '../../constants/timeline.js'

// Phase C — the canvas point-editing math. These are the numbers the timeline
// both DRAWS and HIT-TESTS with; the whole point of automationClipBodyRect is
// that the two can never disagree, so the round-trip tests below are the real
// contract, not the individual formulas.

const laneRow = { laneId: 4, ownerTrackId: 1, y: 70, height: 32 }
const clip = { id: 6, laneId: 4, envelopeId: 8, positionTicks: 0, durationTicks: PPQ * 16, offsetTicks: 0 }
const PPB = 40          // pixels per beat
const SCROLL = 0        // beats scrolled

describe('automationClipBodyRect', () => {
  it('derives the body and envelope-content bands from the lane row', () => {
    const body = automationClipBodyRect(clip, laneRow, PPB, SCROLL)
    expect(body.x).toBe(0)
    expect(body.w).toBe(16 * PPB)
    expect(body.y).toBe(72)            // laneRow.y + pad
    expect(body.h).toBe(28)            // height - 2*pad
    expect(body.headerH).toBe(12)
    expect(body.contentTop).toBe(85)   // y + headerH + 1
    expect(body.contentHeight).toBe(13)
  })

  it('tracks scroll and zoom', () => {
    const zoomed = automationClipBodyRect(clip, laneRow, 80, 4)
    expect(zoomed.x).toBe(-4 * 80)
    expect(zoomed.w).toBe(16 * 80)
  })

  it('returns null without a clip or lane row', () => {
    expect(automationClipBodyRect(null, laneRow, PPB, SCROLL)).toBeNull()
    expect(automationClipBodyRect(clip, null, PPB, SCROLL)).toBeNull()
  })
})

describe('envelope <-> canvas round trip', () => {
  it('maps a point to a pixel and back to the same point', () => {
    const point = { tick: 4800, value: 0.25 }
    const pos = envelopePointToCanvasPos(point, clip, laneRow, PPB, SCROLL)
    const back = canvasPosToEnvelopePoint(pos.x, pos.y, clip, laneRow, PPB, SCROLL)
    expect(back.tick).toBe(point.tick)
    expect(back.value).toBeCloseTo(point.value, 6)
  })

  it('puts value 1 at the top of the content band and 0 at the bottom', () => {
    const body = automationClipBodyRect(clip, laneRow, PPB, SCROLL)
    expect(canvasPosToEnvelopePoint(100, body.contentTop, clip, laneRow, PPB, SCROLL).value).toBe(1)
    expect(canvasPosToEnvelopePoint(100, body.contentTop + body.contentHeight, clip, laneRow, PPB, SCROLL).value).toBe(0)
  })

  it('clamps the value outside the band instead of extrapolating', () => {
    const body = automationClipBodyRect(clip, laneRow, PPB, SCROLL)
    expect(canvasPosToEnvelopePoint(100, body.contentTop - 50, clip, laneRow, PPB, SCROLL).value).toBe(1)
    expect(canvasPosToEnvelopePoint(100, body.contentTop + body.contentHeight + 50, clip, laneRow, PPB, SCROLL).value).toBe(0)
  })

  it('clamps the tick to the clip window', () => {
    expect(canvasPosToEnvelopePoint(-500, 90, clip, laneRow, PPB, SCROLL).tick).toBe(0)
    expect(canvasPosToEnvelopePoint(99999, 90, clip, laneRow, PPB, SCROLL).tick).toBe(clip.durationTicks)
  })

  it('applies the snap callback in TIMELINE tick space', () => {
    const snapToBar = (t) => Math.round(t / (PPQ * 4)) * (PPQ * 4)
    // x = 130px = 3.25 beats; snapped to the nearest bar (4 beats) = tick 3840.
    expect(canvasPosToEnvelopePoint(130, 90, clip, laneRow, PPB, SCROLL, snapToBar).tick).toBe(PPQ * 4)
  })

  it('accounts for a trimmed left edge (offsetTicks)', () => {
    const trimmed = { ...clip, positionTicks: PPQ * 4, offsetTicks: PPQ * 4 }
    expect(automationEnvelopeOriginTick(trimmed)).toBe(0)
    // The clip starts at beat 4 on the timeline but shows envelope tick 3840.
    expect(canvasPosToEnvelopePoint(4 * PPB, 90, trimmed, laneRow, PPB, SCROLL).tick).toBe(PPQ * 4)
  })
})

describe('hitTestAutomationPoint', () => {
  const points = [
    { tick: 0, value: 0.5 },
    { tick: 4800, value: 0.25 },
    { tick: PPQ * 16, value: 0.5 },
  ]

  it('finds a point under the cursor and reports its SORTED index', () => {
    const pos = envelopePointToCanvasPos(points[1], clip, laneRow, PPB, SCROLL)
    const hit = hitTestAutomationPoint(points, clip, laneRow, pos.x, pos.y, PPB, SCROLL)
    expect(hit).not.toBeNull()
    expect(hit.index).toBe(1)
    expect(hit.point.tick).toBe(4800)
  })

  it('sorts unsorted input before indexing, so the index matches the engine', () => {
    const unsorted = [points[2], points[0], points[1]]
    const pos = envelopePointToCanvasPos(points[1], clip, laneRow, PPB, SCROLL)
    expect(hitTestAutomationPoint(unsorted, clip, laneRow, pos.x, pos.y, PPB, SCROLL).index).toBe(1)
  })

  it('misses beyond the hit radius', () => {
    const pos = envelopePointToCanvasPos(points[1], clip, laneRow, PPB, SCROLL)
    const far = AUTOMATION_POINT_HIT_RADIUS_PX + 3
    expect(hitTestAutomationPoint(points, clip, laneRow, pos.x + far, pos.y, PPB, SCROLL)).toBeNull()
  })

  it('keeps the same SCREEN grab area at every zoom level', () => {
    for (const ppb of [10, 40, 200]) {
      const pos = envelopePointToCanvasPos(points[1], clip, laneRow, ppb, SCROLL)
      const inside = hitTestAutomationPoint(points, clip, laneRow, pos.x + 4, pos.y, ppb, SCROLL)
      const outside = hitTestAutomationPoint(points, clip, laneRow, pos.x + 12, pos.y, ppb, SCROLL)
      expect(inside, `ppb=${ppb} inside`).not.toBeNull()
      expect(outside, `ppb=${ppb} outside`).toBeNull()
    }
  })

  it('picks the NEAREST point when two are within the radius', () => {
    const close = [{ tick: 4800, value: 0.25 }, { tick: 4860, value: 0.25 }]
    const pos = envelopePointToCanvasPos(close[1], clip, laneRow, PPB, SCROLL)
    expect(hitTestAutomationPoint(close, clip, laneRow, pos.x, pos.y, PPB, SCROLL).index).toBe(1)
  })

  it('ignores points outside the clip window (they are clipped when drawn)', () => {
    const trimmed = { ...clip, positionTicks: PPQ * 8, durationTicks: PPQ * 4, offsetTicks: PPQ * 8 }
    const hidden = { tick: 0, value: 0.5 } // before the visible window
    expect(isTickInsideClipWindow(trimmed, hidden.tick)).toBe(false)
    const pos = envelopePointToCanvasPos(hidden, trimmed, laneRow, PPB, SCROLL)
    expect(hitTestAutomationPoint([hidden], trimmed, laneRow, pos.x, pos.y, PPB, SCROLL)).toBeNull()
  })

  it('returns null for an empty envelope', () => {
    expect(hitTestAutomationPoint([], clip, laneRow, 0, 90, PPB, SCROLL)).toBeNull()
  })
})

describe('applyPointDragPreview', () => {
  const points = [
    { tick: 0, value: 0.5 },
    { tick: 4800, value: 0.25 },
    { tick: 9600, value: 0.75 },
  ]

  it('moves one point without mutating the input', () => {
    const next = applyPointDragPreview(points, 1, 5760, 0.9)
    expect(next[1]).toEqual({ tick: 5760, value: 0.9 })
    expect(points[1]).toEqual({ tick: 4800, value: 0.25 })
  })

  it('re-sorts when a point is dragged past a neighbour', () => {
    const next = applyPointDragPreview(points, 1, 12000, 0.1)
    expect(next.map((p) => p.tick)).toEqual([0, 9600, 12000])
    expect(next[2].value).toBe(0.1)
  })

  it('clamps the previewed value to [0, 1]', () => {
    expect(applyPointDragPreview(points, 1, 4800, 5)[1].value).toBe(1)
    expect(applyPointDragPreview(points, 1, 4800, -5)[1].value).toBe(0)
  })

  it('is a no-op for an out-of-range index', () => {
    expect(applyPointDragPreview(points, 9, 100, 0.5).map((p) => p.tick)).toEqual([0, 4800, 9600])
  })

  it('agrees with the engine hold-after-last semantics when sampled', () => {
    const next = applyPointDragPreview(points, 2, 9600, 0.4)
    expect(sampleEnvelopeValueAtTick(next, 20000)).toBe(0.4)
  })
})

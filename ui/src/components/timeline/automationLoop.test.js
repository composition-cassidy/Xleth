import { describe, it, expect } from 'vitest'
import { planAutomationLoop } from './automationLoop.js'
import { automationClipIdsInPixelRect } from './automationLaneGeometry.js'
import { PPQ } from '../../constants/timeline.js'

const clip = (id, laneId, pos, dur, extra = {}) =>
  ({ id, laneId, envelopeId: id, positionTicks: pos, durationTicks: dur, offsetTicks: 0, ...extra })
const BAR = PPQ * 4

describe('planAutomationLoop', () => {
  it('tiles a single clip up to the end tick, trimming the last copy', () => {
    const a = clip(1, 10, 0, BAR)
    const plan = planAutomationLoop([a], BAR * 3 + BAR / 2, [a])
    expect(plan.map((p) => [p.positionTicks, p.durationTicks])).toEqual([
      [BAR, BAR], [BAR * 2, BAR], [BAR * 3, BAR / 2],
    ])
    expect(plan.every((p) => p.laneId === 10 && p.clip === a)).toBe(true)
  })

  it('loops a group as one unit, keeping internal spacing', () => {
    const a = clip(1, 10, 0, BAR), b = clip(2, 11, BAR, BAR)
    const plan = planAutomationLoop([b, a], BAR * 4, [a, b])
    expect(plan.map((p) => [p.laneId, p.positionTicks])).toEqual([[10, BAR * 2], [11, BAR * 3]])
  })

  it('skips copies that would collide with existing clips', () => {
    const a = clip(1, 10, 0, BAR), blocker = clip(9, 10, BAR * 2, BAR)
    const plan = planAutomationLoop([a], BAR * 4, [a, blocker])
    expect(plan.map((p) => p.positionTicks)).toEqual([BAR, BAR * 3])
  })

  it('returns nothing when the end is not past the source, or on junk input', () => {
    const a = clip(1, 10, 0, BAR)
    expect(planAutomationLoop([a], BAR, [a])).toEqual([])
    expect(planAutomationLoop([], BAR * 4)).toEqual([])
    expect(planAutomationLoop([a], NaN)).toEqual([])
  })

  it('drops a trailing sliver shorter than the minimum duration', () => {
    const a = clip(1, 10, 0, BAR)
    expect(planAutomationLoop([a], BAR + 10, [a])).toEqual([])
  })
})

describe('automationClipIdsInPixelRect', () => {
  const rows = [{ laneId: 10, y: 0, height: 40 }, { laneId: 11, y: 40, height: 40 }]
  const clips = [clip(1, 10, 0, BAR), clip(2, 11, 0, BAR), clip(3, 10, BAR * 4, BAR)]
  const ppb = 10
  it('selects every clip the band touches across lanes', () => {
    expect([...automationClipIdsInPixelRect(clips, rows, 5, 5, 20, 60, ppb, 0)].sort()).toEqual([1, 2])
  })
  it('works for a band dragged right-to-left / bottom-to-top', () => {
    expect([...automationClipIdsInPixelRect(clips, rows, 20, 60, 5, 5, ppb, 0)].sort()).toEqual([1, 2])
  })
  it('ignores clips outside the band and unknown lanes', () => {
    expect(automationClipIdsInPixelRect(clips, rows, 100, 5, 120, 20, ppb, 0).size).toBe(0)
    expect(automationClipIdsInPixelRect([clip(4, 99, 0, BAR)], rows, 0, 0, 50, 50, ppb, 0).size).toBe(0)
  })
})

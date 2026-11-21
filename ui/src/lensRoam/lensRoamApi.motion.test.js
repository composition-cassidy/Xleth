// @vitest-environment jsdom
// lensRoamApi: the Motion view writes (docs/XLETH_MOTION_VIEW_DESIGN.md 3.1):
// setTrackParent and setTrackMasks are write calls that announce their post-state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../timelineEvents.js'
import { setTrackMasks, setTrackParent } from './lensRoamApi.js'

let timeline
let events
const on = (e) => events.push([e.type, e.detail ?? null])

beforeEach(() => {
  events = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  timeline = {
    setTrackParent: vi.fn(async (trackId, parentTrackId) => ({
      trackId, changed: true, parentTrackId, roam: { offsetX: 0.5 }, keys: [], compensated: ['offset'], uncompensated: [],
    })),
    setTrackMasks: vi.fn(async (trackId, masks) => ({ trackId, changed: true, masks })),
  }
  window.xleth = { timeline }
  timelineEvents.addEventListener('lens-roam-changed', on)
  timelineEvents.addEventListener('timeline-tracks-changed', on)
})

afterEach(() => {
  timelineEvents.removeEventListener('lens-roam-changed', on)
  timelineEvents.removeEventListener('timeline-tracks-changed', on)
  vi.restoreAllMocks()
  delete window.xleth
})

describe('setTrackParent', () => {
  it('sends only the known, well-typed options (strict RPC), none when there are none', async () => {
    await setTrackParent(3, 7)
    expect(timeline.setTrackParent).toHaveBeenLastCalledWith(3, 7)
    await setTrackParent(3, -1, { keepOnScreen: true, tick: 1920 })
    expect(timeline.setTrackParent).toHaveBeenLastCalledWith(3, -1, { keepOnScreen: true, tick: 1920 })
    await setTrackParent(3, 7, { keepOnScreen: 'yes', tick: NaN, extra: 1 })
    expect(timeline.setTrackParent).toHaveBeenLastCalledWith(3, 7)
    await setTrackParent(3, 7, { keepOnScreen: false })
    expect(timeline.setTrackParent).toHaveBeenLastCalledWith(3, 7, { keepOnScreen: false })
  })

  it('announces the post-state on lens-roam-changed, then timeline-tracks-changed', async () => {
    const res = await setTrackParent(3, 7, { keepOnScreen: true, tick: 0 })
    expect(res).toMatchObject({ trackId: 3, parentTrackId: 7, compensated: ['offset'] })
    expect(events.map(([t]) => t)).toEqual(['lens-roam-changed', 'timeline-tracks-changed'])
    expect(events[0][1]).toBe(res)
  })

  it('a rejected or unchanged attach announces nothing; a missing bridge resolves null', async () => {
    timeline.setTrackParent.mockResolvedValueOnce({ trackId: 3, changed: false, parentTrackId: -1, rejected: 'cycle' })
    const res = await setTrackParent(3, 4)
    expect(res.rejected).toBe('cycle')
    expect(events).toEqual([])
    delete timeline.setTrackParent
    expect(await setTrackParent(3, 4)).toBeNull()
    expect(events).toEqual([])
  })

  it('an engine error resolves null and announces nothing', async () => {
    timeline.setTrackParent.mockRejectedValueOnce(new Error('timeline.setTrackParent: unknown field'))
    expect(await setTrackParent(3, 4, { tick: 5 })).toBeNull()
    expect(events).toEqual([])
  })
})

describe('setTrackMasks', () => {
  it('sends the whole list and announces the post-state', async () => {
    const masks = [{ id: 1, kind: 'Rectangle' }]
    const res = await setTrackMasks(5, masks)
    expect(timeline.setTrackMasks).toHaveBeenCalledWith(5, masks)
    expect(res).toEqual({ trackId: 5, changed: true, masks })
    expect(events).toEqual([['lens-roam-changed', res]])
  })

  it('unchanged: no event', async () => {
    timeline.setTrackMasks.mockResolvedValueOnce({ trackId: 5, changed: false, masks: [] })
    await setTrackMasks(5, [])
    expect(events).toEqual([])
  })
})

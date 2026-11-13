// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../timelineEvents.js'
import {
  beginLensRoamDrag,
  changedFields,
  getLensRoam,
  resetClipLens,
  resetTrackLens,
  resetTrackRoam,
  setClipLens,
  setTrackLens,
  setTrackRoam,
} from './lensRoamApi.js'

const LENS = { fit: 'Cover', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack' }
const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }

let timeline
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  timeline = {
    setClipLens: vi.fn(async (clipId, p) => ({ clipId, changed: true, lens: { ...LENS, ...p } })),
    resetClipLens: vi.fn(async (clipId) => ({ clipId, changed: true, lens: LENS })),
    setTrackLens: vi.fn(async (trackId, regionId, p) => ({ trackId, regionId, changed: true, explicit: true, lens: { ...LENS, ...p } })),
    resetTrackLens: vi.fn(async (trackId, regionId) => ({ trackId, regionId, changed: false, explicit: false, lens: LENS })),
    setTrackRoam: vi.fn(async (trackId, p) => ({ trackId, changed: true, roam: { ...ROAM, ...p } })),
    resetTrackRoam: vi.fn(async (trackId) => ({ trackId, changed: true, roam: ROAM })),
    getLensRoam: vi.fn(async () => ({ clips: [], sources: [], tracks: [], missing: {} })),
  }
  window.xleth = { timeline }
})
afterEach(() => {
  vi.restoreAllMocks()
  delete window.xleth
})

describe('lensRoamApi calls', () => {
  it('sends each command to its own bridge method with the given arguments', async () => {
    await setClipLens(12, { zoom: 1.2 })
    await resetClipLens(12)
    await setTrackLens(3, 7, { fit: 'Contain' })
    await resetTrackLens(3, 7)
    await setTrackRoam(4, { offsetX: 0.5 })
    await resetTrackRoam(4)
    await getLensRoam({ clipIds: [12] })
    expect(timeline.setClipLens).toHaveBeenCalledWith(12, { zoom: 1.2 })
    expect(timeline.resetClipLens).toHaveBeenCalledWith(12)
    expect(timeline.setTrackLens).toHaveBeenCalledWith(3, 7, { fit: 'Contain' })
    expect(timeline.resetTrackLens).toHaveBeenCalledWith(3, 7)
    expect(timeline.setTrackRoam).toHaveBeenCalledWith(4, { offsetX: 0.5 })
    expect(timeline.resetTrackRoam).toHaveBeenCalledWith(4)
    expect(timeline.getLensRoam).toHaveBeenCalledWith({ clipIds: [12] })
  })

  it('logs [LensBridge] on the way out and back', async () => {
    await setClipLens(12, { zoom: 1.2 })
    const lines = console.log.mock.calls.map((c) => c[0])
    expect(lines.some((l) => l.startsWith('[LensBridge] -> setClipLens clip=12'))).toBe(true)
    expect(lines.some((l) => l.startsWith('[LensBridge] <- setClipLens clip=12') && l.endsWith('changed=true'))).toBe(true)
  })

  it('announces real changes on timelineEvents, and only those', async () => {
    const seen = []
    const on = (e) => seen.push(e.detail)
    timelineEvents.addEventListener('lens-roam-changed', on)
    await setTrackRoam(4, { offsetX: 0.5 })
    await resetTrackLens(3, 7) // changed: false
    timelineEvents.removeEventListener('lens-roam-changed', on)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ trackId: 4, changed: true, roam: { offsetX: 0.5 } })
  })

  it('a missing bridge method warns and resolves null instead of looking like a write', async () => {
    delete timeline.setClipLens
    expect(await setClipLens(1, { zoom: 2 })).toBeNull()
    expect(console.warn).toHaveBeenCalledWith('[LensBridge] timeline.setClipLens is unavailable; nothing sent')
  })

  it('an engine rejection logs and resolves null', async () => {
    timeline.setClipLens.mockRejectedValueOnce(new Error("unknown Lens field 'centreX'"))
    expect(await setClipLens(1, { centreX: 0.2 })).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('drag sessions', () => {
  it('previews locally with no IPC and commits ONE call with only the changed fields', async () => {
    const drag = beginLensRoamDrag({ kind: 'clipLens', clipId: 12, start: LENS })
    for (let i = 1; i <= 50; i++) drag.preview({ centerX: 0.5 + i / 1000, zoom: 1 + i / 100 })
    drag.preview({ centerY: 0.5 }) // back to its start value: not sent
    expect(timeline.setClipLens).not.toHaveBeenCalled()
    expect(drag.value).toMatchObject({ centerX: 0.55, zoom: 1.5 })
    await drag.commit()
    await drag.commit() // a session commits at most once
    expect(timeline.setClipLens).toHaveBeenCalledTimes(1)
    expect(timeline.setClipLens).toHaveBeenCalledWith(12, { centerX: 0.55, zoom: 1.5 })
  })

  it('a drag that ends where it began sends nothing', async () => {
    const drag = beginLensRoamDrag({ kind: 'trackRoam', trackId: 4, start: ROAM })
    drag.preview({ offsetX: 0.3 })
    drag.preview({ offsetX: 0 })
    expect(await drag.commit()).toEqual({ changed: false, skipped: true })
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })

  it('routes track-lens drags to setTrackLens, and cancel sends nothing', async () => {
    const drag = beginLensRoamDrag({ kind: 'trackLens', trackId: 3, regionId: 7, start: LENS })
    drag.preview({ rotationDeg: 12 })
    await drag.commit()
    expect(timeline.setTrackLens).toHaveBeenCalledWith(3, 7, { rotationDeg: 12 })

    const other = beginLensRoamDrag({ kind: 'trackRoam', trackId: 4, start: ROAM })
    other.preview({ scale: 2 })
    expect(other.cancel()).toEqual(ROAM)
    expect(await other.commit()).toBeNull()
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })

  it('changedFields ignores fields outside the kind and unset values', () => {
    expect(changedFields(ROAM, { ...ROAM, scale: 2, zoom: 3, offsetX: undefined },
      ['offsetX', 'scale'])).toEqual({ scale: 2 })
    expect(changedFields(ROAM, ROAM, ['offsetX'])).toBeNull()
  })
})

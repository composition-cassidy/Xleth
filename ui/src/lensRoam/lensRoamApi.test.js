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

describe('lensRoamApi P8: per-note overrides and the hit curve', () => {
  const A = { patternId: 9, noteId: 2 }
  const B = { patternId: 12, noteId: 2 }      // same note id, another pattern
  const noteState = (refs, mode) => ({
    changed: true,
    notes: refs.map((r) => ({ ...r, mode, lensOverride: mode === 'Follow' ? null : { mode, keys: [] } })),
  })

  beforeEach(() => {
    timeline.setNoteLensMode = vi.fn(async (notes, mode) => noteState(notes, mode))
    timeline.setNoteLensKeys = vi.fn(async (note, keys) => ({ changed: keys.length > 0, notes: [{ ...note, mode: 'Nudge', lensOverride: { mode: 'Nudge', keys } }] }))
    timeline.revertNotesToFollow = vi.fn(async (notes) => noteState(notes, 'Follow'))
    timeline.setHitCurve = vi.fn(async (trackId, regionId, curve) => ({ trackId, regionId, changed: true, explicit: true, lens: LENS, hitCurve: curve.keys, zones: { headTicks: 120, tailTicks: 240, shortNote: 'Squash' } }))
    timeline.applyHitPreset = vi.fn(async (trackId, regionId, name) => ({ trackId, regionId, changed: true, explicit: true, lens: LENS, hitCurve: [], zones: {}, preset: name }))
  })

  it('each command goes to its own bridge method, notes addressed by {patternId, noteId}', async () => {
    const { setNoteLensMode, setNoteLensKeys, revertNotesToFollow, setHitCurve, applyHitPreset } = await import('./lensRoamApi.js')
    const keys = [{ channel: 'zoom', anchor: 'Head', pos: 0, value: 1.2, interp: 'EaseOut' }]
    await setNoteLensMode([A, B], 'Own')
    await setNoteLensKeys(A, keys)
    await revertNotesToFollow([A, B])
    await setHitCurve(5, 3, { keys, zones: { shortNote: 'Cut' } })
    await applyHitPreset(5, 3, 'Punch + drift')
    expect(timeline.setNoteLensMode).toHaveBeenCalledWith([A, B], 'Own')
    expect(timeline.setNoteLensKeys).toHaveBeenCalledWith(A, keys)
    expect(timeline.revertNotesToFollow).toHaveBeenCalledWith([A, B])
    expect(timeline.setHitCurve).toHaveBeenCalledWith(5, 3, { keys, zones: { shortNote: 'Cut' } })
    expect(timeline.applyHitPreset).toHaveBeenCalledWith(5, 3, 'Punch + drift')
  })

  it('a changed note override refreshes the patterns (piano roll + Reel lane); an unchanged one does not', async () => {
    const { setNoteLensMode, setNoteLensKeys } = await import('./lensRoamApi.js')
    const seen = vi.fn()
    timelineEvents.addEventListener('timeline-patterns-changed', seen)
    try {
      const res = await setNoteLensMode([A], 'Nudge')
      expect(res.notes[0]).toMatchObject({ patternId: 9, noteId: 2, mode: 'Nudge' })
      expect(seen).toHaveBeenCalledTimes(1)
      await setNoteLensKeys(A, [])                         // the mock reports changed: false
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      timelineEvents.removeEventListener('timeline-patterns-changed', seen)
    }
  })

  it('a hit-curve write announces lens-roam-changed with the post-state', async () => {
    const { applyHitPreset } = await import('./lensRoamApi.js')
    const seen = vi.fn()
    timelineEvents.addEventListener('lens-roam-changed', seen)
    try {
      const res = await applyHitPreset(5, 3, 'Punch')
      expect(res.preset).toBe('Punch')
      expect(seen).toHaveBeenCalledTimes(1)
      expect(seen.mock.calls[0][0].detail).toMatchObject({ trackId: 5, regionId: 3, preset: 'Punch' })
    } finally {
      timelineEvents.removeEventListener('lens-roam-changed', seen)
    }
  })

  it('a missing bridge link sends nothing and resolves null (never looks like a write that worked)', async () => {
    const { revertNotesToFollow } = await import('./lensRoamApi.js')
    delete timeline.revertNotesToFollow
    expect(await revertNotesToFollow([A])).toBeNull()
  })

  it('a rejected call (engine strict parse) resolves null', async () => {
    const { setHitCurve } = await import('./lensRoamApi.js')
    timeline.setHitCurve = vi.fn(async () => { throw new TypeError("keys[0]: anchor must be Head | Body | Tail") })
    expect(await setHitCurve(5, 3, { keys: [{ channel: 'zoom', anchor: 'Origin', pos: 0, value: 1 }] })).toBeNull()
  })
})

describe('P9 calls: clip keys, multi-note keys, presets', () => {
  const KEY = { channel: 'zoom', anchor: 'Origin', pos: 480, value: 1.5, interp: 'Linear' }

  it('setClipLensKeys goes to its own bridge method and announces lens-roam-changed with the post-state', async () => {
    const { setClipLensKeys } = await import('./lensRoamApi.js')
    timeline.setClipLensKeys = vi.fn(async (clipId, keys) => ({ clipId, changed: true, lens: LENS, keys }))
    const seen = vi.fn()
    timelineEvents.addEventListener('lens-roam-changed', seen)
    try {
      const res = await setClipLensKeys(12, [KEY])
      expect(timeline.setClipLensKeys).toHaveBeenCalledWith(12, [KEY])
      expect(res.keys).toEqual([KEY])
      expect(seen).toHaveBeenCalledTimes(1)
      expect(seen.mock.calls[0][0].detail).toMatchObject({ clipId: 12, keys: [KEY] })
    } finally {
      timelineEvents.removeEventListener('lens-roam-changed', seen)
    }
  })

  it('setNotesLensKeys is ONE call for many notes and refreshes the patterns like the other note writes', async () => {
    const { setNotesLensKeys } = await import('./lensRoamApi.js')
    const entries = [{ patternId: 9, noteId: 2, keys: [] }, { patternId: 9, noteId: 3, keys: [] }]
    timeline.setNotesLensKeys = vi.fn(async () => ({ changed: true, notes: [] }))
    const seen = vi.fn()
    timelineEvents.addEventListener('timeline-patterns-changed', seen)
    try {
      await setNotesLensKeys(entries)
      expect(timeline.setNotesLensKeys).toHaveBeenCalledTimes(1)
      expect(timeline.setNotesLensKeys).toHaveBeenCalledWith(entries)
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      timelineEvents.removeEventListener('timeline-patterns-changed', seen)
    }
  })

  it('getHitPresets asks the engine once and caches; a failed ask is not cached', async () => {
    const { getHitPresets, resetHitPresetsCache } = await import('./lensRoamApi.js')
    resetHitPresetsCache()
    timeline.getHitPresets = vi.fn(async () => null)
    expect(await getHitPresets()).toBeNull()
    timeline.getHitPresets = vi.fn(async () => [{ name: 'Still', keys: [], zones: {} }])
    expect(await getHitPresets()).toEqual([{ name: 'Still', keys: [], zones: {} }])
    await getHitPresets()
    expect(timeline.getHitPresets).toHaveBeenCalledTimes(1)
    resetHitPresetsCache()
  })

  it('a missing bridge link for a new call sends nothing and resolves null', async () => {
    const { setClipLensKeys, setNotesLensKeys } = await import('./lensRoamApi.js')
    expect(await setClipLensKeys(1, [])).toBeNull()
    expect(await setNotesLensKeys([])).toBeNull()
  })
})

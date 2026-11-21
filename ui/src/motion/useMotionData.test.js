import { describe, expect, it } from 'vitest'
import {
  MOTION_REFRESH_EVENTS, adoptPostState, buildNoteStrip, computeMotionTrackIds, emptyLensRoamState,
  lensRoamStateFrom, noteIndexAt, normalizeMotionBlur,
} from './useMotionData.js'
import { REFRESH_EVENTS } from '../lensRoam/useLensRoam.js'
import {
  ROAM_ID, fixtureBlocks, fixtureData, fixtureLensRoam, fixturePatterns, fixtureTracks,
} from './providers/__tests__/fixtures.js'

describe('MotionData', () => {
  it('refetches on the Lens / Roam events plus the pattern events', () => {
    for (const e of REFRESH_EVENTS) expect(MOTION_REFRESH_EVENTS).toContain(e)
    expect(MOTION_REFRESH_EVENTS).toContain('timeline-patterns-changed')
    expect(MOTION_REFRESH_EVENTS).toContain('timeline-pattern-changed')
  })

  it('reads the getter answer: roam, sweep, parent, masks, sources, clips, placed, blur', () => {
    const d = fixtureData()
    expect(d.roamOf(1).keys).toHaveLength(2)
    expect(d.roamOf(1).sweep).toHaveLength(1)
    expect(d.roamOf(1).masks).toHaveLength(1)
    expect(d.roamOf(1).masks[0].id).toBe(1)
    expect(d.roamOf(2).parentTrackId).toBe(1)
    expect(d.sourceOf(1, 100).hitCurve).toHaveLength(2)
    expect(d.sourceOf(9, 9).hitCurve).toHaveLength(0)            // unknown source: identity, no keys
    expect(d.clipLens.get(30).keys).toHaveLength(2)
    expect([...d.placed].sort()).toEqual([1, 2, 3])
    expect(d.motionBlur).toEqual({ enabled: true, shutterAngleDeg: 180 })
    expect(d.regionsByTrack.get(1)).toEqual([100])
    expect(d.regionsByTrack.get(3)).toEqual([100, 101])
    expect(d.regionName(101)).toBe('Snare')
  })

  it('normalises the motion blur setting', () => {
    expect(normalizeMotionBlur(null)).toEqual({ enabled: false, shutterAngleDeg: 180 })
    expect(normalizeMotionBlur({ enabled: 1, shutterAngle: 270 })).toEqual({ enabled: true, shutterAngleDeg: 270 })
  })

  it('finds the clip under a tick (the latest start wins)', () => {
    const d = fixtureData({ clips: [
      { id: 1, trackId: 2, positionTicks: 0, durationTicks: 4000 },
      { id: 2, trackId: 2, positionTicks: 1000, durationTicks: 500 },
    ] })
    expect(d.clipUnder(2, 500).id).toBe(1)
    expect(d.clipUnder(2, 1200).id).toBe(2)
    expect(d.clipUnder(2, 1600).id).toBe(1)
    expect(d.clipUnder(2, 4000)).toBeNull()
    expect(d.clipUnder(4, 0)).toBeNull()
  })

  it('reads a clip\'s own Lens when the getter did not send it', () => {
    const d = fixtureData({ lensRoam: { ...fixtureLensRoam(), clips: [] } })
    const own = d.clipLensOf({ id: 99, lens: { base: { zoom: 3 }, keys: [{ channel: 'zoom' }] } })
    expect(own.lens.zoom).toBe(3)
    expect(own.keys).toHaveLength(1)
  })
})

describe('note strip', () => {
  it('walks blocks and loops like the Reel lane, for tracks without video too', () => {
    const s = buildNoteStrip(fixtureBlocks().filter((b) => b.trackId === 3), fixturePatterns())
    // Pattern 10 once (2 notes) + pattern 11 once (1 note at 3840).
    expect(s.count).toBe(3)
    expect([...s.starts]).toEqual([0, 1920, 3840])
    expect([...s.ends]).toEqual([960, 2880, 4320])
    expect([...s.regionIds]).toEqual([100, 100, 101])
    expect([...s.modes]).toEqual([0, 1, 0])
    expect(s.minPitch).toBe(50)
    expect(s.maxPitch).toBe(62)
  })

  it('loops a block over its pattern and clamps the note-off to the block end', () => {
    const blocks = [{ id: 1, trackId: 1, patternId: 11, positionTicks: 0, durationTicks: 4000, offsetTicks: 0 }]
    const s = buildNoteStrip(blocks, { 11: { id: 11, regionId: 1, lengthTicks: 1920, notes: [{ id: 1, positionTicks: 0, durationTicks: 480, pitch: 1 }] } })
    expect([...s.starts]).toEqual([0, 1920, 3840])
    expect(s.ends[2]).toBe(4000)
  })

  it('skips slide notes', () => {
    const blocks = [{ id: 1, trackId: 1, patternId: 11, positionTicks: 0, durationTicks: 1920 }]
    const s = buildNoteStrip(blocks, { 11: { id: 11, regionId: 1, lengthTicks: 1920, notes: [{ id: 1, positionTicks: 0, durationTicks: 480, isSlide: true }] } })
    expect(s.count).toBe(0)
  })

  it('picks the note sounding at a tick: the latest start, a tie to the lowest pitch', () => {
    const blocks = [{ id: 1, trackId: 1, patternId: 5, positionTicks: 0, durationTicks: 3840 }]
    const pats = { 5: { id: 5, regionId: 7, lengthTicks: 3840, notes: [
      { id: 1, positionTicks: 0, durationTicks: 2000, pitch: 60 },
      { id: 2, positionTicks: 500, durationTicks: 200, pitch: 64 },
      { id: 3, positionTicks: 1000, durationTicks: 200, pitch: 70 },
      { id: 4, positionTicks: 1000, durationTicks: 200, pitch: 65 },
    ] } }
    const s = buildNoteStrip(blocks, pats)
    const idAt = (t) => { const i = noteIndexAt(s, t); return i < 0 ? null : s.noteIds[i] }
    expect(idAt(100)).toBe(1)
    expect(idAt(600)).toBe(2)
    expect(idAt(800)).toBe(1)          // note 2 ended: the earlier, longer note still sounds
    expect(idAt(1100)).toBe(4)         // tie at 1000: the lowest pitch
    expect(idAt(2500)).toBeNull()
    expect(noteIndexAt(s, 600, 99)).toBe(-1)   // another source
  })
})

describe('motion marker (R18)', () => {
  it('marks keys, a non-identity base, Sweep, clip keys, hit curve, Nudge notes, a Parent, a Mask', () => {
    const ids = computeMotionTrackIds(fixtureData())
    expect(ids.has(1)).toBe(true)    // Roam keys, Sweep, Mask, hit curve
    expect(ids.has(2)).toBe(true)    // Parent (and clip Lens keys)
    expect(ids.has(3)).toBe(true)    // plays a pattern with a Nudge note
    expect(ids.has(4)).toBe(false)   // nothing
  })

  it('a static non-identity Roam alone is motion; a dangling parent is not', () => {
    const lr = fixtureLensRoam()
    lr.tracks[3] = { trackId: 4, roam: { ...ROAM_ID, scale: 2 }, keys: [], sweep: [], parentTrackId: -1, masks: [] }
    expect(computeMotionTrackIds(fixtureData({ lensRoam: lr })).has(4)).toBe(true)
    lr.tracks[3] = { trackId: 4, roam: ROAM_ID, keys: [], sweep: [], parentTrackId: 77, masks: [] }
    expect(computeMotionTrackIds(fixtureData({ lensRoam: lr })).has(4)).toBe(false)
  })

  it('clip Lens keys on any clip of a Clip track count', () => {
    const lr = fixtureLensRoam()
    lr.tracks[1] = { trackId: 2, roam: ROAM_ID, keys: [], sweep: [], parentTrackId: -1, masks: [] }
    expect(computeMotionTrackIds(fixtureData({ lensRoam: lr })).has(2)).toBe(true)
    lr.clips = [{ clipId: 30, lens: {}, keys: [] }, { clipId: 31, lens: {}, keys: [] }]
    expect(computeMotionTrackIds(fixtureData({ lensRoam: lr })).has(2)).toBe(false)
  })

  it('an empty project has no motion', () => {
    expect(computeMotionTrackIds(fixtureData({ tracks: [], lensRoam: { tracks: [], sources: [], clips: [] } })).size).toBe(0)
    expect(computeMotionTrackIds(null).size).toBe(0)
    expect(fixtureTracks()).toHaveLength(4)
  })
})

describe('adopting a write\'s post-state', () => {
  const st = () => lensRoamStateFrom({ lensRoam: fixtureLensRoam(), layout: null, motionBlur: null })

  it('Roam keys and base', () => {
    const next = adoptPostState(st(), { trackId: 1, changed: true, roam: { ...ROAM_ID, scale: 3 }, keys: [] })
    expect(next.roamByTrack.get(1).roam.scale).toBe(3)
    expect(next.roamByTrack.get(1).keys).toEqual([])
    expect(next.roamByTrack.get(1).sweep).toHaveLength(1)   // untouched
  })

  it('Sweep keys (no roam beside them)', () => {
    const next = adoptPostState(st(), { trackId: 1, changed: true, keys: [] })
    expect(next.roamByTrack.get(1).sweep).toEqual([])
    expect(next.roamByTrack.get(1).keys).toHaveLength(2)
  })

  it('masks, parent, a clip, a source', () => {
    let s = adoptPostState(st(), { trackId: 1, changed: true, masks: [] })
    expect(s.roamByTrack.get(1).masks).toEqual([])
    s = adoptPostState(s, { trackId: 3, changed: true, parentTrackId: 1, roam: ROAM_ID, keys: [] })
    expect(s.roamByTrack.get(3).parentTrackId).toBe(1)
    s = adoptPostState(s, { clipId: 30, changed: true, lens: { zoom: 2 }, keys: [] })
    expect(s.clipLens.get(30)).toEqual({ lens: { zoom: 2 }, keys: [] })
    s = adoptPostState(s, { trackId: 1, regionId: 100, changed: true, lens: { zoom: 1.1 }, hitCurve: [] })
    expect(s.sources.get('1:100').hitCurve).toEqual([])
    expect(s.sources.get('1:100').lens.zoom).toBe(1.1)
  })

  it('ignores what it cannot place', () => {
    const s = st()
    expect(adoptPostState(s, null)).toBe(s)
    expect(adoptPostState(s, { changed: true })).toBe(s)
    expect(adoptPostState(s, { trackId: 1, changed: false })).toBe(s)
    expect(adoptPostState(emptyLensRoamState(), { trackId: 5, keys: [], roam: ROAM_ID }).roamByTrack.get(5).roam).toBe(ROAM_ID)
  })
})

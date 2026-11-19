// Clones: the shared UI model. assignVoices must match the engine's
// clones::assignVoices (engine/test/test_clones.cpp [1] uses the same cases;
// bridge/test_clones_contract.js compares the two on a live engine).
import { describe, expect, it } from 'vitest'
import {
  VOICE_PIN_AUTO, assignVoices, canHaveClones, clonesOf, formatDelay, isClone, isTrailClone, isVoiceClone,
  noteFilterFor, parseTint, sourceOf, trailClonesOf, trailOpacityAt, voiceClonesOf, voiceMapFor,
  voiceNumberOf, voicePinOptions,
} from './cloneModel.js'

const n = (s, e, pitch, id, extra = {}) => ({ id, positionTicks: s, durationTicks: e - s, pitch, ...extra })
const voices = (notes, count) => assignVoices(notes, count).map((r) => (r.overflow ? 'o' : r.voice))

describe('assignVoices (port of engine clones::assignVoices)', () => {
  it('no clones: everything on the source', () => {
    expect(voices([n(0, 960, 67, 1), n(0, 960, 64, 2)], 0)).toEqual([0, 0])
  })
  it('a late overlapping note goes to Clone 1', () => {
    expect(voices([n(0, 3840, 67, 1), n(2000, 2100, 64, 2)], 1)).toEqual([0, 1])
  })
  it('same tick: highest pitch on the source (G stays, E -> Clone 1)', () => {
    expect(voices([n(0, 960, 64, 1), n(0, 960, 67, 2)], 1)).toEqual([1, 0])
  })
  it('touching notes share a voice', () => {
    expect(voices([n(0, 960, 60, 1), n(960, 1920, 62, 2)], 1)).toEqual([0, 0])
  })
  it('lowest free voice; a voice frees when its note ends', () => {
    expect(voices([n(0, 3840, 67, 1), n(0, 1920, 64, 2), n(960, 1920, 60, 3), n(2880, 3000, 62, 4)], 2))
      .toEqual([0, 1, 2, 1])
  })
  it('overflow goes to the source, flagged', () => {
    expect(voices([n(0, 960, 67, 1), n(0, 960, 64, 2), n(0, 960, 60, 3)], 1)).toEqual([0, 1, 'o'])
  })
  it('pins are placed first; a pin to a missing voice is Auto', () => {
    expect(voices([n(0, 960, 67, 1, { voicePin: 1 }), n(0, 960, 64, 2)], 1)).toEqual([1, 0])
    expect(voices([n(0, 960, 67, 1, { voicePin: 3 })], 1)).toEqual([0])
    expect(voices([n(0, 960, 67, 1, { voicePin: VOICE_PIN_AUTO })], 1)).toEqual([0])
  })
  it('slide notes occupy nothing', () => {
    expect(voices([n(0, 960, 67, 1, { isSlide: true }), n(0, 960, 64, 2)], 1)).toEqual([0, 0])
  })
  it('does not depend on note list order', () => {
    const a = assignVoices([n(0, 960, 64, 2), n(0, 960, 67, 1), n(480, 600, 60, 3)], 2)
    const b = assignVoices([n(480, 600, 60, 3), n(0, 960, 67, 1), n(0, 960, 64, 2)], 2)
    expect([a[0].voice, a[1].voice, a[2].voice]).toEqual([b[2].voice, b[1].voice, b[0].voice])
  })
})

const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1 },
  { id: 4, name: 'Lead · Trail 1', type: 'Pattern', order: 3, cloneOf: 1, clone: { kind: 'Trail', delayTicks: 480, tint: '#F07A2A', opacity: 0.9, opacityKeys: [] } },
  { id: 3, name: 'Lead · Clone 2', type: 'Pattern', order: 2, cloneOf: 1, clone: { kind: 'Voice', lensMode: 'Own' } },
  { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice', lensMode: 'Linked' } },
  { id: 5, name: 'Bass', type: 'Clip', order: 4, cloneOf: -1 },
]

describe('track topology', () => {
  it('kinds and sources', () => {
    expect(isClone(tracks[0])).toBe(false)
    expect(isVoiceClone(tracks[3])).toBe(true)
    expect(isTrailClone(tracks[1])).toBe(true)
    expect(sourceOf(tracks, tracks[2]).id).toBe(1)
    expect(canHaveClones(tracks[0])).toBe(true)
    expect(canHaveClones(tracks[3])).toBe(false)
    expect(canHaveClones(tracks[4])).toBe(false)
  })
  it('clones in track order; voices numbered in that order', () => {
    expect(clonesOf(tracks, 1).map((t) => t.id)).toEqual([2, 3, 4])
    expect(voiceClonesOf(tracks, 1).map((t) => t.id)).toEqual([2, 3])
    expect(trailClonesOf(tracks, 1).map((t) => t.id)).toEqual([4])
    expect(voiceNumberOf(tracks, tracks[0])).toBe(0)
    expect(voiceNumberOf(tracks, tracks[3])).toBe(1)
    expect(voiceNumberOf(tracks, tracks[2])).toBe(2)
    expect(voiceNumberOf(tracks, tracks[1])).toBe(null)
  })
  it('voice pin options list Auto, the source, then each Voice clone', () => {
    expect(voicePinOptions(tracks, 1).map((o) => o.pin)).toEqual([-1, 0, 1, 2])
  })
})

describe('note filters per cell', () => {
  const pattern = { id: 9, notes: [n(0, 3840, 67, 1), n(0, 1920, 64, 2), n(960, 1920, 60, 3), n(1440, 1680, 62, 4)] }
  it('the source shows voice 0 and its overflow; each clone its own notes; a trail what voice 0 shows', () => {
    const ids = (track) => pattern.notes.filter(noteFilterFor(tracks, track, pattern)).map((x) => x.id)
    expect(ids(tracks[0])).toEqual([1, 4])   // 4 overflows (3 voices busy)
    expect(ids(tracks[3])).toEqual([2])
    expect(ids(tracks[2])).toEqual([3])
    expect(ids(tracks[1])).toEqual([1, 4])
    expect(voiceMapFor(pattern, 2).get(4)).toEqual({ voice: 0, overflow: true })
  })
  it('a track without clones has no filter', () => {
    expect(noteFilterFor([tracks[0]], tracks[0], pattern)).toBe(null)
  })
})

describe('trail helpers', () => {
  it('formats delays musically', () => {
    expect(formatDelay(480)).toBe('1/8')
    expect(formatDelay(1440)).toBe('3/8')
    expect(formatDelay(500)).toBe('500 ticks')
  })
  it('parses tints', () => {
    expect(parseTint('#F07A2A')).toEqual([240, 122, 42])
    expect(parseTint('red')).toBe(null)
  })
  it('evaluates opacity keys like the engine (absolute, hold before/after)', () => {
    const c = { opacity: 0.5, opacityKeys: [{ pos: 0, value: 0, interp: 'Linear' }, { pos: 960, value: 1, interp: 'Linear' }] }
    expect(trailOpacityAt(c, -10)).toBe(0)
    expect(trailOpacityAt(c, 480)).toBeCloseTo(0.5, 9)
    expect(trailOpacityAt(c, 5000)).toBe(1)
    expect(trailOpacityAt({ opacity: 0.75, opacityKeys: [] }, 100)).toBe(0.75)
  })
})

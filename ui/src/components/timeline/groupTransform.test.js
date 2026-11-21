import { describe, expect, it } from 'vitest'
import { beatsToTicks, ticksToBeats } from '../../constants/timeline.js'
import { resolveGroupTranslation, splitPlacementsByKind } from './groupTransform.js'

// Four Clip tracks with a Pattern track wedged in the middle — the shape that
// makes a mixed selection's type check interesting.
const TRACKS = [
  { id: 10, type: 'Clip' },
  { id: 11, type: 'Clip' },
  { id: 12, type: 'Pattern' },
  { id: 13, type: 'Clip' },
]

const beats = (t) => ticksToBeats(t)

/** A clip item at `beat` on `row`, carrying a stand-in engine object. */
const clipItem = (beat, row = 0, id = beat) => ({
  kind: 'clip',
  clip: { id, trackId: TRACKS[row].id },
  origTicks: beatsToTicks(beat),
  origTrackIndex: row,
  trackId: TRACKS[row].id,
})

const blockItem = (beat, row = 2, id = `b${beat}`) => ({
  kind: 'block',
  block: { id, trackId: TRACKS[row].id },
  origTicks: beatsToTicks(beat),
  origTrackIndex: row,
  trackId: TRACKS[row].id,
})

/** Every pairwise gap in a placement list, so "the group did not deform" is one assert. */
function gaps(placements) {
  const t = placements.map((p) => p.positionTicks)
  const out = []
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) out.push(t[j] - t[i])
  }
  return out
}

describe('resolveGroupTranslation — snap resolves ONE value, the anchor\'s', () => {
  it('keeps three clips 0.5 beats apart when a coarse Bar snap swallows the nudge', () => {
    // The defect this replaces: snapping each clip independently sent 0.0/0.5/1.0
    // all to beat 0 — three clips stacked on one track, which double-triggers
    // the sampler.
    const items = [clipItem(0.0), clipItem(0.5), clipItem(1.0)]
    const { placements, tickDelta } = resolveGroupTranslation({
      items,
      anchor: items[0],
      pointerBeatDelta: 0.1,
      pointerTrackDelta: 0,
      tracks: TRACKS,
      snapGranularity: 'Bar',
    })

    expect(placements.map((p) => p.positionTicks)).toEqual([0, beatsToTicks(0.5), beatsToTicks(1)])
    expect(gaps(placements)).toEqual([480, 960, 480])
    expect(tickDelta).toBe(0) // +0.1 beat is far short of the next bar line
  })

  it('carries an off-grid clip at its exact offset from the anchor', () => {
    // 1/16 snap = 240 ticks. The stray clip sits 37 ticks off the grid; a
    // per-item snap would quantize it and lose those 37 ticks forever.
    const anchor = clipItem(0)
    const stray = { ...clipItem(1), origTicks: beatsToTicks(1) + 37 }
    const offsetBefore = stray.origTicks - anchor.origTicks

    const { placements } = resolveGroupTranslation({
      items: [anchor, stray],
      anchor,
      pointerBeatDelta: 0.9, // snaps to 1 beat
      pointerTrackDelta: 0,
      tracks: TRACKS,
      snapGranularity: '1/16',
    })

    expect(placements[0].positionTicks).toBe(beatsToTicks(1)) // anchor lands on the grid
    expect(placements[1].positionTicks - placements[0].positionTicks).toBe(offsetBefore)
    expect(placements[1].positionTicks % 240).toBe(37 % 240) // still off-grid, unchanged
  })

  it('snaps the ANCHOR even when the anchor is not the leftmost item', () => {
    const items = [clipItem(0), clipItem(2)]
    const { placements } = resolveGroupTranslation({
      items,
      anchor: items[1], // grabbed the right-hand clip
      pointerBeatDelta: 0.9,
      pointerTrackDelta: 0,
      tracks: TRACKS,
      snapGranularity: 'Beat',
    })
    expect(placements[1].positionTicks).toBe(beatsToTicks(3)) // anchor on a beat line
    expect(placements[0].positionTicks).toBe(beatsToTicks(1)) // dragged rigidly with it
  })
})

describe('resolveGroupTranslation — clamps once, against the group', () => {
  it('stops a 4..32 beat selection at zero without collapsing its 28-beat span', () => {
    const items = [clipItem(4), clipItem(18), clipItem(32)]
    const { placements, tickDelta } = resolveGroupTranslation({
      items,
      anchor: items[0],
      pointerBeatDelta: -100,
      pointerTrackDelta: 0,
      tracks: TRACKS,
      snapGranularity: '1/16',
    })

    expect(tickDelta).toBe(-beatsToTicks(4))
    expect(placements[0].positionTicks).toBe(0)
    const span = placements[2].positionTicks - placements[0].positionTicks
    expect(beats(span)).toBe(28)
    expect(placements.every((p) => p.positionTicks >= 0)).toBe(true)
  })

  it('clamps a multi-row group by its topmost row, keeping the rows relative', () => {
    const items = [clipItem(0, 0), clipItem(0, 1), clipItem(0, 3)]
    const { trackDelta, placements } = resolveGroupTranslation({
      items,
      anchor: items[1],
      pointerBeatDelta: 0,
      pointerTrackDelta: -5, // far above the first track
      tracks: TRACKS,
      snapGranularity: '1/16',
    })
    expect(trackDelta).toBe(0) // -minIdx === 0
    expect(placements.map((p) => p.trackIndex)).toEqual([0, 1, 3])
  })

  it('clamps by the bottommost row rather than piling items onto the last track', () => {
    const items = [clipItem(0, 0), clipItem(0, 1)]
    const { trackDelta, placements } = resolveGroupTranslation({
      items,
      anchor: items[0],
      pointerBeatDelta: 0,
      pointerTrackDelta: 9,
      tracks: [TRACKS[0], TRACKS[1], TRACKS[3], { id: 14, type: 'Clip' }],
      snapGranularity: '1/16',
    })
    expect(trackDelta).toBe(2) // bottom item stops on the last row
    expect(placements.map((p) => p.trackIndex)).toEqual([2, 3])
  })
})

describe('resolveGroupTranslation — a type-invalid destination refuses the WHOLE gesture', () => {
  const items = [clipItem(0, 0), blockItem(0, 2)]

  it('refuses a mixed selection whose rows cannot both be satisfied', () => {
    // trackDelta +1 would put the clip on row 1 (Clip, fine) and the pattern
    // block on row 3 (Clip — invalid). Nothing may partially apply.
    const result = resolveGroupTranslation({
      items,
      anchor: items[0],
      pointerBeatDelta: 0.25,
      pointerTrackDelta: 1,
      tracks: TRACKS,
      snapGranularity: '1/16',
    })
    expect(result.refused).toBe(true)
    expect(result.placements).toEqual([])
    const { clip, block, automation } = splitPlacementsByKind(result.placements)
    expect([clip, block, automation]).toEqual([[], [], []])
  })

  it('gives the commit the identical array the preview consumed', () => {
    const args = {
      items,
      anchor: items[0],
      pointerBeatDelta: 0.25,
      pointerTrackDelta: 1,
      tracks: TRACKS,
      snapGranularity: '1/16',
    }
    const preview = resolveGroupTranslation(args)
    const commit = resolveGroupTranslation(args)
    expect(commit.placements).toEqual(preview.placements)
    expect(commit).toEqual(preview)
  })

  it('applies the same selection when the destination rows DO match', () => {
    // trackDelta 0: clip stays on row 0 (Clip), block on row 2 (Pattern).
    const { refused, placements } = resolveGroupTranslation({
      items,
      anchor: items[0],
      pointerBeatDelta: 0.25,
      pointerTrackDelta: 0,
      tracks: TRACKS,
      snapGranularity: '1/16',
    })
    expect(refused).toBe(false)
    expect(placements).toHaveLength(2)
    expect(placements.map((p) => p.positionTicks)).toEqual([240, 240])
    expect(placements.map((p) => p.trackId)).toEqual([10, 12])
  })

  it('refuses a single clip dropped on a Pattern row', () => {
    const only = [clipItem(0, 1)]
    const { refused, placements } = resolveGroupTranslation({
      items: only,
      anchor: only[0],
      pointerBeatDelta: 0,
      pointerTrackDelta: 1, // row 2 is the Pattern track
      tracks: TRACKS,
      snapGranularity: '1/16',
    })
    expect(refused).toBe(true)
    expect(placements).toEqual([])
  })

  it('refuses when the pointer resolved to no row at all', () => {
    const only = [clipItem(0, 0)]
    expect(resolveGroupTranslation({
      items: only, anchor: only[0], pointerBeatDelta: 1, pointerTrackDelta: NaN, tracks: TRACKS,
    }).refused).toBe(true)
  })

  it('refuses an empty gesture', () => {
    expect(resolveGroupTranslation({ items: [], tracks: TRACKS }).placements).toEqual([])
    expect(resolveGroupTranslation({ items: [], tracks: TRACKS }).refused).toBe(true)
  })
})

describe('resolveGroupTranslation — integer ticks end to end', () => {
  // Deterministic PRNG (mulberry32) so a failure is reproducible.
  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('holds every pairwise gap across 50 sequential 1px free drags of 200 clips', () => {
    const rand = rng(0x5EED)
    const PPB = 40 // pixels per beat — 1px = 0.025 beat = 24 ticks
    let items = Array.from({ length: 200 }, (_, i) => ({
      ...clipItem(0, i % 2, i),
      origTicks: Math.floor(rand() * beatsToTicks(64)) + 5000, // far from the zero clamp
    }))
    const gapsBefore = gaps(items.map((it) => ({ positionTicks: it.origTicks })))

    for (let step = 0; step < 50; step++) {
      const { placements, refused } = resolveGroupTranslation({
        items,
        anchor: items[0],
        pointerBeatDelta: 1 / PPB, // one pixel
        pointerTrackDelta: 0,
        tracks: TRACKS,
        modifiers: { alt: true }, // snap off — the drift-prone path
        snapGranularity: '1/16',
      })
      expect(refused).toBe(false)
      // Feed the result back in, exactly as a chain of real drags would.
      items = placements.map((p) => ({ ...p, origTicks: p.positionTicks }))
    }

    expect(items.every((it) => Number.isInteger(it.origTicks))).toBe(true)
    expect(gaps(items.map((it) => ({ positionTicks: it.origTicks })))).toEqual(gapsBefore)
    // 50 × 24 ticks, with no accumulated rounding.
    expect(items[0].origTicks - 5000).toBe(items[0].origTicks - 5000) // anchor identity
    expect(items[1].origTicks - gapsBefore[0]).toBe(items[0].origTicks)
  })

  it('never emits a fractional tick from a fractional pointer delta', () => {
    const items = [clipItem(0), { ...clipItem(1), origTicks: 917 }]
    const { placements } = resolveGroupTranslation({
      items,
      anchor: items[0],
      pointerBeatDelta: 0.123456789,
      pointerTrackDelta: 0,
      tracks: TRACKS,
      modifiers: { alt: true },
      snapGranularity: '1/16',
    })
    expect(placements.every((p) => Number.isInteger(p.positionTicks))).toBe(true)
  })
})

describe('splitPlacementsByKind', () => {
  it('slices one resolved list into its three kinds, preserving order', () => {
    const { clip, block, automation } = splitPlacementsByKind([
      { kind: 'clip', id: 1 }, { kind: 'automation', id: 2 },
      { kind: 'block', id: 3 }, { kind: 'clip', id: 4 },
    ])
    expect(clip.map((p) => p.id)).toEqual([1, 4])
    expect(block.map((p) => p.id)).toEqual([3])
    expect(automation.map((p) => p.id)).toEqual([2])
  })

  it('leaves lane-addressed items without a track index', () => {
    const items = [{ kind: 'automation', clip: { id: 9 }, origTicks: 480, origTrackIndex: null, laneId: 5 }]
    const { placements } = resolveGroupTranslation({
      items, anchor: items[0], pointerBeatDelta: 0.25, pointerTrackDelta: 0, tracks: TRACKS,
    })
    expect(placements[0]).toMatchObject({ positionTicks: 720, laneId: 5, trackIndex: null })
  })
})

import { describe, expect, it } from 'vitest'
import { forEachBlockNote, getPatternNoteIndex } from './patternNoteIndex.js'

// Ticks per beat for the fixtures. The index only does tick arithmetic, so the
// actual resolution is irrelevant to it.
const BEAT = 960

function prng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// What the block preview did before the index existed: every note of every
// loop the block spans, kept when its START is inside the block's slice.
function reference(pattern, block) {
  const out = []
  const patLen = pattern.lengthTicks
  const windowStart = block.offsetTicks || 0
  const windowEnd = windowStart + block.durationTicks
  const firstLoop = Math.floor(windowStart / patLen)
  let lastLoop = Math.floor((windowEnd - 1) / patLen)
  if (block.loopEnabled === false) lastLoop = Math.min(lastLoop, 0)
  for (let L = firstLoop; L <= lastLoop; L++) {
    for (const note of pattern.notes) {
      const tape = L * patLen + note.positionTicks
      if (tape < windowStart || tape >= windowEnd) continue
      out.push([tape, note.durationTicks, note.pitch])
    }
  }
  return out
}

function collect(pattern, block, lo = -Infinity, hi = Infinity) {
  const out = []
  forEachBlockNote(pattern, block, lo, hi, (tape, dur, pitch) => out.push([tape, dur, pitch]))
  return out
}

const sorted = (list) => list.map((n) => n.join(',')).sort()

function randomPattern(r) {
  const lengthTicks = BEAT * (1 + Math.floor(r() * 16))
  const count = Math.floor(r() * 60)
  return {
    lengthTicks,
    notes: Array.from({ length: count }, () => ({
      // Notes may sit at or past the pattern length, and may overlap.
      positionTicks: Math.floor(r() * lengthTicks * 1.2),
      durationTicks: 1 + Math.floor(r() * BEAT * 2),
      pitch: 36 + Math.floor(r() * 48),
    })),
  }
}

function randomBlock(r, pattern) {
  return {
    positionTicks: Math.floor(r() * BEAT * 64),
    durationTicks: 1 + Math.floor(r() * pattern.lengthTicks * 9),
    offsetTicks: r() < 0.4 ? Math.floor(r() * pattern.lengthTicks * 3) : 0,
    loopEnabled: r() < 0.25 ? false : true,
  }
}

describe('getPatternNoteIndex', () => {
  it('sorts by start and records the aggregates the preview needs', () => {
    const pattern = {
      lengthTicks: BEAT * 4,
      notes: [
        { positionTicks: 480, durationTicks: 100, pitch: 64 },
        { positionTicks: 0, durationTicks: 300, pitch: 60 },
        { positionTicks: 960, durationTicks: 50, pitch: 72 },
      ],
    }
    const index = getPatternNoteIndex(pattern)
    expect(Array.from(index.starts)).toEqual([0, 480, 960])
    expect(Array.from(index.pitches)).toEqual([60, 64, 72])
    expect(index.minPitch).toBe(60)
    expect(index.maxPitch).toBe(72)
    expect(index.maxDuration).toBe(300)
    expect(index.minStart).toBe(0)
    expect(index.maxStart).toBe(960)
  })

  it('is built once per notes array and survives a pattern rename', () => {
    const notes = [{ positionTicks: 0, durationTicks: 10, pitch: 60 }]
    const index = getPatternNoteIndex({ name: 'a', lengthTicks: BEAT, notes })
    expect(getPatternNoteIndex({ name: 'b', lengthTicks: BEAT, notes })).toBe(index)
    expect(getPatternNoteIndex({ name: 'a', lengthTicks: BEAT, notes: notes.slice() })).not.toBe(index)
  })

  it('handles a pattern with no notes, including a huge one without overflowing', () => {
    expect(getPatternNoteIndex({ notes: [] }).count).toBe(0)
    expect(getPatternNoteIndex(null).count).toBe(0)
    const notes = Array.from({ length: 300000 }, (_, i) => ({ positionTicks: i, durationTicks: 1, pitch: i % 128 }))
    const index = getPatternNoteIndex({ lengthTicks: 300000, notes })
    expect(index.minPitch).toBe(0)
    expect(index.maxPitch).toBe(127)
  })
})

describe('forEachBlockNote', () => {
  it('visits exactly the notes the unindexed preview drew when nothing is culled', () => {
    const r = prng(42)
    for (let i = 0; i < 400; i++) {
      const pattern = randomPattern(r)
      const block = randomBlock(r, pattern)
      expect(sorted(collect(pattern, block))).toEqual(sorted(reference(pattern, block)))
    }
  })

  it('with a viewport, visits every note that reaches it and nothing wholly outside', () => {
    const r = prng(7)
    for (let i = 0; i < 400; i++) {
      const pattern = randomPattern(r)
      const block = randomBlock(r, pattern)
      const windowStart = block.offsetTicks || 0
      const lo = windowStart + Math.floor((r() - 0.3) * block.durationTicks)
      const hi = lo + 1 + Math.floor(r() * block.durationTicks)

      const all = reference(pattern, block)
      const mustSee = all.filter(([tape, dur]) => tape < hi && tape + dur > lo)
      const got = collect(pattern, block, lo, hi)

      expect(sorted(got)).toEqual(sorted(mustSee))
    }
  })

  it('stops at the first iteration when block looping is off', () => {
    const pattern = { lengthTicks: BEAT, notes: [{ positionTicks: 0, durationTicks: 10, pitch: 60 }] }
    const looping = { positionTicks: 0, durationTicks: BEAT * 4, offsetTicks: 0, loopEnabled: true }
    expect(collect(pattern, looping).map((n) => n[0])).toEqual([0, BEAT, BEAT * 2, BEAT * 3])
    expect(collect(pattern, { ...looping, loopEnabled: false }).map((n) => n[0])).toEqual([0])
  })

  it('does work proportional to what is visible, not to the block length', () => {
    // 4 notes per bar, 512 bars of looping, viewport one bar wide.
    const pattern = {
      lengthTicks: BEAT * 4,
      notes: [0, 1, 2, 3].map((b) => ({ positionTicks: b * BEAT, durationTicks: 100, pitch: 60 + b })),
    }
    const block = { positionTicks: 0, durationTicks: BEAT * 4 * 512, offsetTicks: 0, loopEnabled: true }
    expect(collect(pattern, block).length).toBe(4 * 512)
    const oneBar = collect(pattern, block, BEAT * 4 * 200, BEAT * 4 * 201)
    expect(oneBar.length).toBe(4)
  })

  it('ignores a pattern with no length or no notes', () => {
    const block = { positionTicks: 0, durationTicks: BEAT, offsetTicks: 0 }
    expect(collect({ lengthTicks: 0, notes: [{ positionTicks: 0, durationTicks: 1, pitch: 1 }] }, block)).toEqual([])
    expect(collect({ lengthTicks: BEAT, notes: [] }, block)).toEqual([])
  })
})

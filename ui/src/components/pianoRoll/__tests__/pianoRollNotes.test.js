import { describe, expect, it, vi } from 'vitest'
import {
  buildGhostNotes, drawNotes, formatShift, mixHex, noteLabel, noteStyle, sampleShiftSemitones, velocityAlpha,
} from '../pianoRollNotes.js'
import { contrastRatio } from '../../../ui-kit/colorMath.ts'

const PALETTE = {
  g0: '#141414', g1: '#1B1B1B', g4: '#3A3A3A', boundary: '#747474', ink: '#E6E6E6',
  value: '#33CED6', select: '#33CED6', font: 'sans-serif',
}

describe('Sample view label', () => {
  it('is the transposition the sampler applies: (pitch - root) + slot tuning', () => {
    expect(sampleShiftSemitones(67, { rootNote: 60 })).toBe(7)
    expect(sampleShiftSemitones(60, { rootNote: 60, octave: -1 })).toBe(-12)
    expect(sampleShiftSemitones(60, { rootNote: 62, semitone: 2, fine: 50 })).toBe(0.5)
    expect(sampleShiftSemitones(60, null)).toBe(0)   // no slot: root assumed C4
  })

  it('formats with a true minus and says Root at zero', () => {
    expect(formatShift(0)).toBe('Root')
    expect(formatShift(7)).toBe('+7')
    expect(formatShift(-12)).toBe('−12')
    expect(formatShift(0.5)).toBe('+0.5')
  })

  it('switches between pitch and sample labels', () => {
    const note = { pitch: 64 }
    expect(noteLabel(note, 'pitch', { rootNote: 60 })).toBe('E4')
    expect(noteLabel(note, 'sample', { rootNote: 60 })).toBe('+4')
  })
})

describe('note style', () => {
  it('maps velocity to opacity, never below 0.3', () => {
    expect(velocityAlpha(0)).toBeCloseTo(0.3)
    expect(velocityAlpha(1)).toBeCloseTo(1)
    expect(velocityAlpha(undefined)).toBeCloseTo(1)
  })

  it('solves the label ink against the composited fill, at least 4.5:1', () => {
    for (const color of ['#58B2CE', '#8D72E3', '#C7C368', '#DB6E3B', '#D76A8F']) {
      const style = noteStyle({ color, palette: PALETTE })
      for (const a of [0.3, 0.6, 1]) {
        const fill = mixHex(color, PALETTE.g0, Math.round(a * 20) / 20)
        expect(contrastRatio(fill, style.inkFor(a))).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('falls back to the value colour when the pattern is not placed', () => {
    expect(noteStyle({ color: null, palette: PALETTE }).color).toBe('#33CED6')
  })

  it('draws a label only when it fits, and outlines the selection in the select colour', () => {
    const calls = []
    const ctx = new Proxy({}, {
      get: (t, p) => (p in t ? t[p] : p === 'measureText' ? (s) => ({ width: s.length * 6 }) : (...a) => calls.push([p, ...a])),
      set: (t, p, v) => { t[p] = v; calls.push(['set', p, v]); return true },
    })
    const style = noteStyle({ color: '#58B2CE', palette: PALETTE })
    const notes = [
      { id: 1, positionTicks: 0, durationTicks: 960, pitch: 60, velocity: 1 },   // 80px wide
      { id: 2, positionTicks: 960, durationTicks: 60, pitch: 60, velocity: 1 },  // 5px wide
    ]
    drawNotes(ctx, 800, 400, notes, new Set([1]), 80, 14, 0, (131 - 70) * 14, style)
    const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1])
    expect(texts).toEqual(['C4'])
    expect(calls.some((c) => c[0] === 'set' && c[1] === 'strokeStyle' && c[2] === '#33CED6')).toBe(true)
  })
})

describe('ghost notes', () => {
  const pattern = { id: 1, regionId: 5, lengthTicks: 3840, notes: [] }
  const blocks = [
    { id: 10, trackId: 1, patternId: 1, positionTicks: 3840, durationTicks: 3840, offsetTicks: 0, loopEnabled: false },
    { id: 11, trackId: 2, patternId: 2, positionTicks: 1920, durationTicks: 7680, offsetTicks: 0, loopEnabled: true },
    { id: 12, trackId: 3, patternId: 3, positionTicks: 3840, durationTicks: 3840, offsetTicks: 480, loopEnabled: false },
    { id: 13, trackId: 4, patternId: 4, positionTicks: 9000, durationTicks: 960, offsetTicks: 0, loopEnabled: false },
  ]
  const patternsById = {
    2: { id: 2, regionId: 5, lengthTicks: 1920, notes: [{ positionTicks: 0, durationTicks: 240, pitch: 60 }] },
    3: { id: 3, regionId: 9, lengthTicks: 3840, notes: [{ positionTicks: 480, durationTicks: 240, pitch: 72 }, { positionTicks: 0, durationTicks: 240, pitch: 50 }] },
    4: { id: 4, regionId: 5, lengthTicks: 960, notes: [{ positionTicks: 0, durationTicks: 240, pitch: 40 }] },
  }

  it('maps overlapping patterns into this pattern\'s ticks, solid for the same sample, outline for another', () => {
    const ghosts = buildGhostNotes({ patternId: 1, pattern, blocks, patternsById })
    // Pattern 2 loops every 1920 from timeline 1920: hits at 3840 and 5760 -> local 0 and 1920.
    const same = ghosts.filter((g) => g.kind === 'same').map((g) => g.positionTicks)
    expect(same).toEqual([0, 1920])
    // Pattern 3 is trimmed by 480: its note at 480 lands on the block start; the note at 0 is cut.
    const other = ghosts.filter((g) => g.kind === 'other')
    expect(other).toEqual([expect.objectContaining({ positionTicks: 0, durationTicks: 240, pitch: 72, kind: 'other' })])
    // Pattern 4 does not overlap the anchor block.
    expect(ghosts.some((g) => g.pitch === 40)).toBe(false)
  })

  it('is empty when the pattern is not placed', () => {
    expect(buildGhostNotes({ patternId: 7, pattern, blocks, patternsById })).toEqual([])
  })
})

vi.mock('../../../theming/tokenValue.ts', () => ({ tokenValue: () => '' }))

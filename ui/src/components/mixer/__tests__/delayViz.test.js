import { describe, it, expect } from 'vitest'
import {
  clamp,
  mixToAlpha,
  feedbackToDecay,
  lfoPhase,
  timeToNorm,
  computeAxisMax,
  syncDivLabel,
} from '../DelayTapeheadVisualizer.jsx'
import {
  indexToNoteFeel,
  noteFeelToIndex,
  availableFeels,
} from '../DelayPanel.jsx'

// ── DelayTapeheadVisualizer helpers ──────────────────────────────────────────

describe('clamp', () => {
  it('passes through values within range', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
    expect(clamp(500, 1, 5000)).toBe(500)
  })
  it('clamps to lo', () => {
    expect(clamp(-1, 0, 1)).toBe(0)
    expect(clamp(0, 1, 5000)).toBe(1)
  })
  it('clamps to hi', () => {
    expect(clamp(2, 0, 1)).toBe(1)
    expect(clamp(6000, 1, 5000)).toBe(5000)
  })
})

describe('mixToAlpha', () => {
  it('returns 0.12 at mix = 0 (always faintly visible)', () => {
    expect(mixToAlpha(0)).toBeCloseTo(0.12, 9)
  })
  it('returns 1.0 at mix = 100', () => {
    expect(mixToAlpha(100)).toBeCloseTo(1.0, 9)
  })
  it('returns linear midpoint at mix = 50', () => {
    // 0.12 + 0.5 × 0.88 = 0.56
    expect(mixToAlpha(50)).toBeCloseTo(0.56, 9)
  })
  it('clamps below 0', () => {
    expect(mixToAlpha(-50)).toBeCloseTo(0.12, 9)
  })
  it('clamps above 100', () => {
    expect(mixToAlpha(200)).toBeCloseTo(1.0, 9)
  })
})

describe('feedbackToDecay', () => {
  it('returns 0 at feedback = 0', () => {
    expect(feedbackToDecay(0)).toBeCloseTo(0, 9)
  })
  it('returns 1 at feedback = 95 (max)', () => {
    expect(feedbackToDecay(95)).toBeCloseTo(1, 9)
  })
  it('returns 0.5 at half-max (47.5)', () => {
    expect(feedbackToDecay(47.5)).toBeCloseTo(0.5, 9)
  })
  it('clamps above 95', () => {
    expect(feedbackToDecay(200)).toBeCloseTo(1, 9)
  })
  it('clamps below 0', () => {
    expect(feedbackToDecay(-10)).toBeCloseTo(0, 9)
  })
})

describe('lfoPhase', () => {
  it('returns 0 at elapsed = 0', () => {
    expect(lfoPhase(1, 0)).toBeCloseTo(0, 9)
  })
  it('returns 2π after exactly one full cycle (1 Hz, 1000 ms)', () => {
    expect(lfoPhase(1, 1000)).toBeCloseTo(2 * Math.PI, 9)
  })
  it('returns π after half a cycle (1 Hz, 500 ms)', () => {
    expect(lfoPhase(1, 500)).toBeCloseTo(Math.PI, 9)
  })
  it('scales linearly with rate — 2 Hz is double 1 Hz', () => {
    expect(lfoPhase(2, 500)).toBeCloseTo(2 * lfoPhase(1, 500), 9)
  })
})

describe('timeToNorm', () => {
  it('returns 0 at timeMs = 0', () => {
    expect(timeToNorm(0, 2000)).toBeCloseTo(0, 9)
  })
  it('returns 1 at timeMs = axisMax', () => {
    expect(timeToNorm(2000, 2000)).toBeCloseTo(1, 9)
  })
  it('returns 0.5 at half the axis', () => {
    expect(timeToNorm(1000, 2000)).toBeCloseTo(0.5, 9)
  })
  it('clamps above axisMax', () => {
    expect(timeToNorm(3000, 2000)).toBeCloseTo(1, 9)
  })
  it('clamps below 0', () => {
    expect(timeToNorm(-100, 2000)).toBeCloseTo(0, 9)
  })
})

describe('computeAxisMax', () => {
  it('returns minimum 800 ms for very short delay times', () => {
    expect(computeAxisMax(1, 1)).toBe(800)
    expect(computeAxisMax(100, 100)).toBe(800)
  })
  it('puts the first tapehead at ~33 % of the axis (peak × 2.8 rule)', () => {
    const axisMax = computeAxisMax(500, 500)
    expect(axisMax).toBeCloseTo(500 * 2.8, 5)
  })
  it('uses the larger of the two times', () => {
    const axisMax = computeAxisMax(200, 1000)
    expect(axisMax).toBeCloseTo(1000 * 2.8, 5)
  })
  it('clamps at 5000 ms for very long times', () => {
    expect(computeAxisMax(3000, 4000)).toBe(5000)
  })
})

describe('syncDivLabel', () => {
  const cases = [
    [0,  '1/1'],  [1,  '1/2'],  [2,  '1/2D'],
    [3,  '1/4'],  [4,  '1/4D'], [5,  '1/4T'],
    [6,  '1/8'],  [7,  '1/8D'], [8,  '1/8T'],
    [9,  '1/16'], [10, '1/16D'],[11, '1/16T'],
  ]
  it.each(cases)('index %i → %s', (idx, expected) => {
    expect(syncDivLabel(idx)).toBe(expected)
  })
  it('clamps out-of-range indices — below 0 → index 0 label', () => {
    expect(syncDivLabel(-1)).toBe('1/1')
  })
  it('clamps out-of-range indices — above 11 → index 11 label', () => {
    expect(syncDivLabel(99)).toBe('1/16T')
  })
  it('handles null/undefined with a safe default', () => {
    expect(syncDivLabel(null)).toBe('1/4')
    expect(syncDivLabel(undefined)).toBe('1/4')
  })
})

// ── DelayPanel sync adapter ───────────────────────────────────────────────────

describe('indexToNoteFeel', () => {
  const cases = [
    [0,  { note: '1/1',  feel: 'straight' }],
    [1,  { note: '1/2',  feel: 'straight' }],
    [2,  { note: '1/2',  feel: 'dotted'   }],
    [3,  { note: '1/4',  feel: 'straight' }],
    [4,  { note: '1/4',  feel: 'dotted'   }],
    [5,  { note: '1/4',  feel: 'triplet'  }],
    [6,  { note: '1/8',  feel: 'straight' }],
    [7,  { note: '1/8',  feel: 'dotted'   }],
    [8,  { note: '1/8',  feel: 'triplet'  }],
    [9,  { note: '1/16', feel: 'straight' }],
    [10, { note: '1/16', feel: 'dotted'   }],
    [11, { note: '1/16', feel: 'triplet'  }],
  ]
  it.each(cases)('index %i → note=%s feel=%s', (idx, expected) => {
    expect(indexToNoteFeel(idx)).toEqual(expected)
  })
  it('clamps fractional values — 3.7 rounds to 4 (1/4D)', () => {
    expect(indexToNoteFeel(3.7)).toEqual({ note: '1/4', feel: 'dotted' })
  })
  it('clamps below 0 to index 0', () => {
    expect(indexToNoteFeel(-5)).toEqual({ note: '1/1', feel: 'straight' })
  })
  it('clamps above 11 to index 11', () => {
    expect(indexToNoteFeel(99)).toEqual({ note: '1/16', feel: 'triplet' })
  })
})

describe('noteFeelToIndex', () => {
  it('returns correct index for every supported combo', () => {
    expect(noteFeelToIndex('1/1',  'straight')).toBe(0)
    expect(noteFeelToIndex('1/2',  'straight')).toBe(1)
    expect(noteFeelToIndex('1/2',  'dotted'  )).toBe(2)
    expect(noteFeelToIndex('1/4',  'straight')).toBe(3)
    expect(noteFeelToIndex('1/4',  'dotted'  )).toBe(4)
    expect(noteFeelToIndex('1/4',  'triplet' )).toBe(5)
    expect(noteFeelToIndex('1/8',  'straight')).toBe(6)
    expect(noteFeelToIndex('1/8',  'dotted'  )).toBe(7)
    expect(noteFeelToIndex('1/8',  'triplet' )).toBe(8)
    expect(noteFeelToIndex('1/16', 'straight')).toBe(9)
    expect(noteFeelToIndex('1/16', 'dotted'  )).toBe(10)
    expect(noteFeelToIndex('1/16', 'triplet' )).toBe(11)
  })
  it('returns null for unsupported combos', () => {
    expect(noteFeelToIndex('1/1', 'dotted'  )).toBeNull()
    expect(noteFeelToIndex('1/1', 'triplet' )).toBeNull()
    expect(noteFeelToIndex('1/2', 'triplet' )).toBeNull()
  })
  it('returns null for completely unknown note or feel', () => {
    expect(noteFeelToIndex('1/32', 'straight')).toBeNull()
    expect(noteFeelToIndex('1/4',  'swing'   )).toBeNull()
  })
})

describe('availableFeels', () => {
  it('1/1 has only straight', () => {
    expect(availableFeels('1/1')).toEqual(['straight'])
  })
  it('1/2 has straight and dotted (no triplet)', () => {
    expect(availableFeels('1/2')).toEqual(['straight', 'dotted'])
  })
  it('1/4 has all three feels', () => {
    expect(availableFeels('1/4')).toEqual(['straight', 'dotted', 'triplet'])
  })
  it('1/8 has all three feels', () => {
    expect(availableFeels('1/8')).toEqual(['straight', 'dotted', 'triplet'])
  })
  it('1/16 has all three feels', () => {
    expect(availableFeels('1/16')).toEqual(['straight', 'dotted', 'triplet'])
  })
  it('returns empty array for unknown note', () => {
    expect(availableFeels('1/32')).toEqual([])
  })
})

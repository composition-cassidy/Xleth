import { describe, it, expect } from 'vitest'
import {
  clamp,
  mixToAlpha,
  feedbackToDecay,
  lfoPhase,
  timeToNorm,
  computeAxisMax,
  syncDivLabel,
  divisionBeats,
  divisionToMs,
  echoTaps,
  filterMagnitude,
  filterMagnitudeDb,
  freqToNorm,
  normToFreq,
  dbToNorm,
  pickFilterHandle,
  formatHz,
  formatMs,
  stereoWidthLabel,
  crossFeedForMode,
  singleModeSpreadMs,
  singleModeLaneTimes,
  STEREO_MODE_SINGLE,
  STEREO_MODE_DUAL,
  STEREO_MODE_PINGPONG,
} from '../delayVizMath.js'
import { withAlpha } from '../mixerCanvasTheme.js'
import {
  indexToNoteFeel,
  noteFeelToIndex,
  availableFeels,
  encodeTimeMode,
  decodeTimeMode,
  TIME_MODE_FREE,
} from '../DelayPanel.jsx'

// ── delayVizMath: helpers carried over from the tapehead visualizer ──────────

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

// ── Time-mode option codec (dropdown ↔ legacy sync_div index) ────────────────

describe('encodeTimeMode / decodeTimeMode', () => {
  it('round-trips every supported note+feel combo back to its engine index', () => {
    for (let idx = 0; idx <= 11; idx++) {
      const { note, feel } = indexToNoteFeel(idx)
      expect(decodeTimeMode(encodeTimeMode(note, feel))).toBe(idx)
    }
  })
  it('returns null for the free-time sentinel so no sync_div is written', () => {
    expect(decodeTimeMode(TIME_MODE_FREE)).toBeNull()
  })
  it('returns null for combos the engine has no index for', () => {
    expect(decodeTimeMode(encodeTimeMode('1/1', 'triplet'))).toBeNull()
    expect(decodeTimeMode(encodeTimeMode('1/2', 'triplet'))).toBeNull()
  })
  it('returns null for malformed option values', () => {
    expect(decodeTimeMode('garbage')).toBeNull()
    expect(decodeTimeMode('1/4|swing')).toBeNull()
  })
})

// ── Sync division maths ──────────────────────────────────────────────────────

describe('divisionBeats', () => {
  it('matches the engine kDivFractions table', () => {
    const expected = [4, 2, 3, 1, 1.5, 2 / 3, 0.5, 0.75, 1 / 3, 0.25, 0.375, 1 / 6]
    expected.forEach((beats, idx) => expect(divisionBeats(idx)).toBeCloseTo(beats, 9))
  })
  it('a dotted note is 1.5x its straight value', () => {
    expect(divisionBeats(4)).toBeCloseTo(divisionBeats(3) * 1.5, 9)
  })
  it('a triplet note is 2/3 of its straight value', () => {
    expect(divisionBeats(5)).toBeCloseTo(divisionBeats(3) * (2 / 3), 9)
  })
  it('clamps out-of-range and nullish indices', () => {
    expect(divisionBeats(-3)).toBe(4)
    expect(divisionBeats(99)).toBeCloseTo(1 / 6, 9)
    expect(divisionBeats(null)).toBe(1)
  })
})

describe('divisionToMs', () => {
  it('1/4 at 120 BPM is 500 ms', () => {
    expect(divisionToMs(3, 120)).toBeCloseTo(500, 6)
  })
  it('1/8 at 120 BPM is 250 ms', () => {
    expect(divisionToMs(6, 120)).toBeCloseTo(250, 6)
  })
  it('halving the tempo doubles the duration', () => {
    expect(divisionToMs(3, 60)).toBeCloseTo(divisionToMs(3, 120) * 2, 6)
  })
  it('falls back to 120 BPM when tempo is missing', () => {
    expect(divisionToMs(3, 0)).toBeCloseTo(500, 6)
    expect(divisionToMs(3, undefined)).toBeCloseTo(500, 6)
  })
})

// ── Echo tap series ──────────────────────────────────────────────────────────

describe('echoTaps', () => {
  const base = { timeLMs: 400, timeRMs: 400, feedbackPct: 60, axisMaxMs: 5000 }

  it('places tap n at n x the delay time', () => {
    const taps = echoTaps(base)
    taps.forEach(tap => {
      expect(tap.tL).toBeCloseTo(400 * tap.n, 6)
      expect(tap.tR).toBeCloseTo(400 * tap.n, 6)
    })
  })
  it('numbers taps from 1 upward', () => {
    expect(echoTaps(base).map(t => t.n)).toEqual(
      Array.from({ length: echoTaps(base).length }, (_, i) => i + 1)
    )
  })
  it('emits exactly one tap at zero feedback', () => {
    expect(echoTaps({ ...base, feedbackPct: 0 })).toHaveLength(1)
  })
  it('emits more taps as feedback rises', () => {
    const low  = echoTaps({ ...base, feedbackPct: 20 }).length
    const high = echoTaps({ ...base, feedbackPct: 90 }).length
    expect(high).toBeGreaterThan(low)
  })
  it('never exceeds maxTaps', () => {
    expect(echoTaps({ ...base, feedbackPct: 95, maxTaps: 6 })).toHaveLength(6)
  })
  it('decays monotonically with zero cross-feed', () => {
    const taps = echoTaps({ ...base, crossPct: 0 })
    for (let i = 1; i < taps.length; i++) {
      expect(taps[i].gL).toBeLessThan(taps[i - 1].gL)
      expect(taps[i].gR).toBeLessThan(taps[i - 1].gR)
    }
  })
  it('keeps the lanes independent at cross = 0 (seed asymmetry is preserved)', () => {
    const taps = echoTaps({ ...base, crossPct: 0, seedL: 1, seedR: 0.3 })
    // gL/gR ratio stays at the seed ratio for every bounce.
    taps.forEach(tap => expect(tap.gL / tap.gR).toBeCloseTo(1 / 0.3, 6))
  })
  it('swaps the lanes at cross = 100 (full ping-pong)', () => {
    const taps = echoTaps({ ...base, crossPct: 100, seedL: 1, seedR: 0, feedbackPct: 95 })
    expect(taps[0].gL).toBeGreaterThan(0)
    expect(taps[0].gR).toBe(0)
    // Bounce 2 has all the energy in the opposite lane.
    expect(taps[1].gL).toBe(0)
    expect(taps[1].gR).toBeGreaterThan(0)
  })
  it('equalises the lanes at cross = 50', () => {
    const taps = echoTaps({ ...base, crossPct: 50, seedL: 1, seedR: 0, feedbackPct: 95 })
    expect(taps[1].gL).toBeCloseTo(taps[1].gR, 9)
  })
  it('stops once both lanes fall past the visible axis', () => {
    const taps = echoTaps({ ...base, timeLMs: 2000, timeRMs: 2000, axisMaxMs: 5000, feedbackPct: 95 })
    expect(taps.every(t => t.tL <= 5000)).toBe(true)
  })
})

// ── Stereo mode ──────────────────────────────────────────────────────────────

describe('stereoWidthLabel', () => {
  it('is SPREAD in Single mode', () => {
    expect(stereoWidthLabel(STEREO_MODE_SINGLE)).toBe('SPREAD')
  })
  it('is WIDTH in Dual mode', () => {
    expect(stereoWidthLabel(STEREO_MODE_DUAL)).toBe('WIDTH')
  })
  it('is WIDTH in PingPong mode', () => {
    expect(stereoWidthLabel(STEREO_MODE_PINGPONG)).toBe('WIDTH')
  })
})

describe('crossFeedForMode', () => {
  it('forces 0 in Single mode regardless of the knob', () => {
    expect(crossFeedForMode(STEREO_MODE_SINGLE, 0)).toBe(0)
    expect(crossFeedForMode(STEREO_MODE_SINGLE, 50)).toBe(0)
    expect(crossFeedForMode(STEREO_MODE_SINGLE, 100)).toBe(0)
  })
  it('forces 100 in PingPong mode regardless of the knob', () => {
    expect(crossFeedForMode(STEREO_MODE_PINGPONG, 0)).toBe(100)
    expect(crossFeedForMode(STEREO_MODE_PINGPONG, 50)).toBe(100)
    expect(crossFeedForMode(STEREO_MODE_PINGPONG, 100)).toBe(100)
  })
  it('passes stereo_width through unchanged in Dual mode', () => {
    expect(crossFeedForMode(STEREO_MODE_DUAL, 0)).toBe(0)
    expect(crossFeedForMode(STEREO_MODE_DUAL, 37)).toBe(37)
    expect(crossFeedForMode(STEREO_MODE_DUAL, 100)).toBe(100)
  })
  it('clamps Dual mode input to [0, 100]', () => {
    expect(crossFeedForMode(STEREO_MODE_DUAL, -10)).toBe(0)
    expect(crossFeedForMode(STEREO_MODE_DUAL, 150)).toBe(100)
  })
})

describe('singleModeSpreadMs', () => {
  it('is 0 at the centre (50 %)', () => {
    expect(singleModeSpreadMs(50)).toBeCloseTo(0, 9)
  })
  it('is -100 at 0 %', () => {
    expect(singleModeSpreadMs(0)).toBeCloseTo(-100, 9)
  })
  it('is +100 at 100 %', () => {
    expect(singleModeSpreadMs(100)).toBeCloseTo(100, 9)
  })
  it('is linear between the centre and the extremes', () => {
    expect(singleModeSpreadMs(75)).toBeCloseTo(50, 9)
    expect(singleModeSpreadMs(25)).toBeCloseTo(-50, 9)
  })
  it('clamps out-of-range input', () => {
    expect(singleModeSpreadMs(-50)).toBeCloseTo(-100, 9)
    expect(singleModeSpreadMs(200)).toBeCloseTo(100, 9)
  })
})

describe('singleModeLaneTimes', () => {
  it('returns equal L/R at the centre (no spread)', () => {
    const { timeL, timeR } = singleModeLaneTimes(500, 50)
    expect(timeL).toBeCloseTo(500, 6)
    expect(timeR).toBeCloseTo(500, 6)
  })
  it('spreads symmetrically around the base time', () => {
    const { timeL, timeR } = singleModeLaneTimes(500, 100)
    expect(timeL).toBeCloseTo(400, 6)
    expect(timeR).toBeCloseTo(600, 6)
  })
  it('spreads the other direction at the opposite extreme', () => {
    const { timeL, timeR } = singleModeLaneTimes(500, 0)
    expect(timeL).toBeCloseTo(600, 6)
    expect(timeR).toBeCloseTo(400, 6)
  })
  it('clamps to the engine time bounds [1, 5000]', () => {
    const near0 = singleModeLaneTimes(50, 100)
    expect(near0.timeL).toBeGreaterThanOrEqual(1)
    const near5000 = singleModeLaneTimes(4950, 0)
    expect(near5000.timeR).toBeLessThanOrEqual(5000)
  })
})

// ── Feedback-path filter response ────────────────────────────────────────────

describe('filterMagnitude', () => {
  it('is -3 dB at the low corner when the high corner is far away', () => {
    expect(filterMagnitudeDb(100, 100, 20000)).toBeCloseTo(-3.01, 1)
  })
  it('is -3 dB at the high corner when the low corner is far away', () => {
    expect(filterMagnitudeDb(2000, 20, 2000)).toBeCloseTo(-3.01, 1)
  })
  it('passes the band centre at close to unity', () => {
    expect(filterMagnitude(1000, 40, 16000)).toBeGreaterThan(0.99)
  })
  // First-order slopes only reach the 6 dB/oct asymptote well past the corner,
  // so the slope is measured three-to-four octaves out.
  it('rolls off at 6 dB/oct below the low corner', () => {
    const atCorner = filterMagnitudeDb(200, 200, 20000)
    const threeOct = filterMagnitudeDb(25, 200, 20000)
    const fourOct = filterMagnitudeDb(12.5, 200, 20000)
    expect(threeOct - fourOct).toBeCloseTo(6, 0)
    expect(atCorner).toBeGreaterThan(threeOct)
  })
  it('rolls off at 6 dB/oct above the high corner', () => {
    const threeOct = filterMagnitudeDb(16000, 20, 2000)
    const fourOct = filterMagnitudeDb(32000, 20, 2000)
    expect(threeOct - fourOct).toBeCloseTo(6, 0)
  })
  it('narrowing the band lowers the response at the old centre', () => {
    const wide = filterMagnitude(1000, 20, 20000)
    const narrow = filterMagnitude(1000, 900, 1100)
    expect(narrow).toBeLessThan(wide)
  })
  it('floors the dB result at -60 so it stays plottable', () => {
    expect(filterMagnitudeDb(20, 2000, 1000)).toBeGreaterThanOrEqual(-60)
  })
})

// ── Frequency / dB axis mapping ──────────────────────────────────────────────

describe('freqToNorm / normToFreq', () => {
  it('maps the axis endpoints to 0 and 1', () => {
    expect(freqToNorm(20)).toBeCloseTo(0, 9)
    expect(freqToNorm(20000)).toBeCloseTo(1, 9)
  })
  it('is logarithmic — the geometric mean sits at the midpoint', () => {
    expect(freqToNorm(Math.sqrt(20 * 20000))).toBeCloseTo(0.5, 9)
  })
  it('clamps out-of-range frequencies', () => {
    expect(freqToNorm(1)).toBeCloseTo(0, 9)
    expect(freqToNorm(50000)).toBeCloseTo(1, 9)
  })
  it('round-trips through normToFreq', () => {
    for (const f of [20, 80, 440, 1000, 12000, 20000]) {
      expect(normToFreq(freqToNorm(f))).toBeCloseTo(f, 6)
    }
  })
  it('clamps normToFreq input to the axis', () => {
    expect(normToFreq(-1)).toBeCloseTo(20, 6)
    expect(normToFreq(2)).toBeCloseTo(20000, 6)
  })
})

describe('dbToNorm', () => {
  it('returns 0 at the top of the plot', () => {
    expect(dbToNorm(3)).toBeCloseTo(0, 9)
  })
  it('returns 1 at the bottom of the plot', () => {
    expect(dbToNorm(-33)).toBeCloseTo(1, 9)
  })
  it('clamps beyond the plot bounds', () => {
    expect(dbToNorm(20)).toBe(0)
    expect(dbToNorm(-90)).toBe(1)
  })
})

describe('pickFilterHandle', () => {
  it('picks lo when the pointer is on the low corner', () => {
    expect(pickFilterHandle(freqToNorm(80), 80, 12000)).toBe('lo')
  })
  it('picks hi when the pointer is on the high corner', () => {
    expect(pickFilterHandle(freqToNorm(12000), 80, 12000)).toBe('hi')
  })
  it('returns null when the pointer is near neither handle', () => {
    expect(pickFilterHandle(freqToNorm(1000), 30, 18000)).toBeNull()
  })
  it('a full-width tolerance always yields a handle (grab-nearest behaviour)', () => {
    expect(pickFilterHandle(0.5, 30, 18000, 1)).not.toBeNull()
  })
  it('breaks ties toward lo', () => {
    const mid = (freqToNorm(100) + freqToNorm(10000)) / 2
    expect(pickFilterHandle(mid, 100, 10000, 1)).toBe('lo')
  })
})

// ── Readout formatting ───────────────────────────────────────────────────────

describe('formatHz', () => {
  it('uses whole Hz below 1 kHz', () => {
    expect(formatHz(80)).toBe('80 Hz')
    expect(formatHz(999.4)).toBe('999 Hz')
  })
  it('uses 2-decimal kHz from 1 kHz', () => {
    expect(formatHz(1200)).toBe('1.20 kHz')
  })
  it('uses 1-decimal kHz from 10 kHz', () => {
    expect(formatHz(12000)).toBe('12.0 kHz')
    expect(formatHz(20000)).toBe('20.0 kHz')
  })
})

describe('formatMs', () => {
  it('uses whole milliseconds below 1 s', () => {
    expect(formatMs(480)).toBe('480 ms')
    expect(formatMs(1)).toBe('1 ms')
  })
  it('switches to seconds at 1 s', () => {
    expect(formatMs(1000)).toBe('1.00 s')
    expect(formatMs(2500)).toBe('2.50 s')
  })
})

// ── Canvas colour helper ─────────────────────────────────────────────────────

describe('withAlpha', () => {
  it('converts 6-digit hex', () => {
    expect(withAlpha('#00b896', 0.5)).toBe('rgba(0, 184, 150, 0.5)')
  })
  it('converts 3-digit hex', () => {
    expect(withAlpha('#0b0', 1)).toBe('rgba(0, 187, 0, 1)')
  })
  it('re-alphas an existing rgb()/rgba()', () => {
    expect(withAlpha('rgb(10, 20, 30)', 0.25)).toBe('rgba(10, 20, 30, 0.25)')
    expect(withAlpha('rgba(10, 20, 30, 0.9)', 0.25)).toBe('rgba(10, 20, 30, 0.25)')
  })
  it('clamps alpha to [0, 1]', () => {
    expect(withAlpha('#000000', 5)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#000000', -2)).toBe('rgba(0, 0, 0, 0)')
  })
  it('degrades to a visible grey for unparseable input', () => {
    expect(withAlpha('var(--nope)', 0.4)).toBe('rgba(160, 160, 168, 0.4)')
    expect(withAlpha(undefined, 0.4)).toBe('rgba(160, 160, 168, 0.4)')
  })
})

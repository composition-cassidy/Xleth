import { describe, expect, it } from 'vitest'
import {
  SPAN_FIT, envelopeLayout, envStageSecondsAt, formatBeats, formatSeconds, lfoTimeline, lfoValueAt,
  nearestNoteValue, niceStep, resolveSpan, timeTicks,
} from '../modulation/modTime.js'
import { BEHAVIOR_ENVELOPE, BEHAVIOR_RETRIG, SEG_LINE, SEG_STEP } from '../modulation/modConstants.js'

// The point of the rewrite: time has a scale. These pin that a stage is as wide
// as it is long, whatever the rest of the envelope is doing.

const BOX = { x: 30, y: 22, w: 644, h: 100 } // 600px of time + a 44px sustain break
const env = (over = {}) => ({
  delaySec: 0, attackSec: 0.01, holdSec: 0, decaySec: 0.1, releaseSec: 0.2, sustain: 0.5,
  attackTension: 0, decayTension: 0, releaseTension: 0, ...over,
})

describe('envelope layout is to scale', () => {
  it('draws a stage at pixels-per-second times its length', () => {
    const L = envelopeLayout(env(), 1, BOX)
    expect(L.pps).toBeCloseTo(600)
    expect(L.x.attack - L.x.delay).toBeCloseTo(6)     // 10 ms
    expect(L.x.decay - L.x.hold).toBeCloseTo(60)      // 100 ms
    expect(L.x.release - L.x.gapEnd).toBeCloseTo(120) // 200 ms
  })

  it('a longer release is wider, and nothing else moves', () => {
    const a = envelopeLayout(env({ releaseSec: 0.05 }), 1, BOX)
    const b = envelopeLayout(env({ releaseSec: 0.5 }), 1, BOX)
    expect(b.x.release - b.x.gapEnd).toBeCloseTo(10 * (a.x.release - a.x.gapEnd))
    expect(b.x.decay).toBeCloseTo(a.x.decay)
    expect(b.x.gapEnd).toBeCloseTo(a.x.gapEnd)
  })

  it('the same envelope is half as wide at twice the span', () => {
    const a = envelopeLayout(env(), 1, BOX)
    const b = envelopeLayout(env(), 2, BOX)
    expect(b.x.decay - b.x.start).toBeCloseTo((a.x.decay - a.x.start) / 2)
  })

  it('the sustain break is a fixed width that is not time', () => {
    const short = envelopeLayout(env(), 0.25, BOX)
    const long = envelopeLayout(env(), 10, BOX)
    expect(short.x.gapEnd - short.x.decay).toBeCloseTo(44)
    expect(long.x.gapEnd - long.x.decay).toBeCloseTo(44)
  })

  it('reports how much runs past the right edge instead of squeezing it in', () => {
    const L = envelopeLayout(env({ releaseSec: 3 }), 1, BOX)
    expect(L.overflowSec).toBeCloseTo(0.01 + 0.1 + 3 - 1)
    expect(envelopeLayout(env(), 1, BOX).overflowSec).toBe(0)
  })

  it('Fit follows the content; a fixed span never does', () => {
    expect(resolveSpan(SPAN_FIT, 2)).toBeCloseTo(2.2)
    expect(resolveSpan(1, 20)).toBe(1)
    expect(resolveSpan(SPAN_FIT, 0)).toBe(1)
  })

  it('puts the sustain level on the decay point and offers curve handles only where a segment exists', () => {
    const L = envelopeLayout(env(), 1, BOX)
    expect(L.handles.decay.y).toBeCloseTo(L.yOf(0.5))
    expect(L.levelOf(L.yOf(0.25))).toBeCloseTo(0.25)
    expect(L.tensions.attackTension).toBeTruthy()
    const flat = envelopeLayout(env({ attackSec: 0, sustain: 1 }), 1, BOX)
    expect(flat.tensions.attackTension).toBeNull()
    expect(flat.tensions.decayTension).toBeNull()
  })

  it('maps a dragged point back to that stage alone, clamped to the 5 s control range', () => {
    const L = envelopeLayout(env(), 1, BOX)
    expect(envStageSecondsAt(L, 'attack', L.x.delay + 60)).toBeCloseTo(0.1)
    expect(envStageSecondsAt(L, 'release', L.x.gapEnd + 300)).toBeCloseTo(0.5)
    expect(envStageSecondsAt(L, 'release', L.x.gapEnd - 50)).toBe(0)
    expect(envStageSecondsAt(L, 'decay', 1e6)).toBe(5)
  })
})

describe('ruler', () => {
  it('uses 1-2-5 steps that keep labels apart', () => {
    expect(niceStep(1 / 600)).toBeCloseTo(0.1)
    expect(niceStep(10 / 600)).toBeCloseTo(1)
    expect(niceStep(0.1 / 600)).toBeCloseTo(0.01)
  })

  it('labels round times, with a minor tick between', () => {
    const t = timeTicks(1, 600)
    expect(t.filter((x) => x.major).map((x) => x.label)).toEqual(
      ['0', '100 ms', '200 ms', '300 ms', '400 ms', '500 ms', '600 ms', '700 ms', '800 ms', '900 ms', '1 s'])
    expect(t[1]).toMatchObject({ major: false, label: '' })
    expect(t[1].sec).toBeCloseTo(0.05)
  })

  it('falls on beats when the times are note values', () => {
    const t = timeTicks(2, 600, { sync: true, bpm: 120 }).filter((x) => x.major)
    expect(t.map((x) => x.label)).toEqual(['0', '1/2', '1', '1.5', '2', '2.5', '3', '3.5', '4'])
    expect(t[2].sec).toBeCloseTo(0.5) // one beat at 120 BPM
  })

  it('formats times and beats the way the rest of the panel does', () => {
    expect(formatSeconds(0.0635)).toBe('64 ms')
    expect(formatSeconds(2.5)).toBe('2.5 s')
    expect(formatBeats(0.25)).toBe('1/4')
  })

  it('snaps a dragged synced stage to the nearest note value', () => {
    // 120 BPM: 1/4 = 0.5 s (index 8), 1/8 = 0.25 s (index 9).
    expect(nearestNoteValue(0.5, 120)).toBe(8)
    expect(nearestNoteValue(0.27, 120)).toBe(9)
    expect(nearestNoteValue(0, 120)).toBe(0)
  })
})

describe('LFO over time mirrors the engine', () => {
  const saw = { points: [{ t: 0, v: -1, seg: SEG_LINE, tension: 0 }, { t: 0.999, v: 1, seg: SEG_LINE, tension: 0 }], behavior: BEHAVIOR_RETRIG }
  const sq = { points: [{ t: 0, v: 1, seg: SEG_STEP, tension: 0 }, { t: 0.5, v: -1, seg: SEG_STEP, tension: 0 }], behavior: BEHAVIOR_RETRIG }

  it('repeats at the rate: 2 Hz is two cycles a second', () => {
    const t = { rateHz: 2 }
    expect(lfoValueAt(sq, 0.1, t)).toBe(1)
    expect(lfoValueAt(sq, 0.3, t)).toBe(-1)
    expect(lfoValueAt(sq, 0.6, t)).toBe(1)
  })

  it('Delay holds the depth at zero, then jumps', () => {
    const t = { rateHz: 2, delaySec: 0.2 }
    expect(lfoValueAt(sq, 0.1, t)).toBe(0)
    expect(lfoValueAt(sq, 0.6, t)).toBe(1)
  })

  it('Rise ramps the depth linearly from the note start, and multiplies with Delay', () => {
    expect(lfoValueAt(sq, 0.1, { rateHz: 2, riseSec: 0.4 })).toBeCloseTo(0.25)
    expect(lfoValueAt(sq, 0.1, { rateHz: 2, riseSec: 0.4, delaySec: 0.2 })).toBe(0)
    expect(lfoValueAt(sq, 0.6, { rateHz: 2, riseSec: 0.4, delaySec: 0.2 })).toBe(1)
  })

  it('Env mode plays the shape once and holds its last value', () => {
    const once = { ...saw, behavior: BEHAVIOR_ENVELOPE }
    expect(lfoValueAt(once, 3, { rateHz: 2 })).toBeCloseTo(lfoValueAt(once, 0.5, { rateHz: 2 }))
    expect(lfoValueAt(saw, 0.75, { rateHz: 2 })).toBeLessThan(0.1) // Retrig is back in its second cycle
  })

  it('Phase offsets where the cycle starts', () => {
    expect(lfoValueAt({ ...sq, phase: 50 }, 0, { rateHz: 2 })).toBe(-1)
  })

  it('draws a fast LFO as the range each column covers, not an alias', () => {
    const cols = lfoTimeline(sq, 1, 100, { rateHz: 400 })
    expect(cols).toHaveLength(100)
    expect(cols.some((c) => c.lo === -1 && c.hi === 1)).toBe(true)
    const slow = lfoTimeline(sq, 1, 100, { rateHz: 1 })
    expect(slow[10]).toEqual({ lo: 1, hi: 1 })
  })
})

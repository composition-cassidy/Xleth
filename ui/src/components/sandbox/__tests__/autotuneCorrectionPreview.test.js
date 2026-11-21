import { describe, expect, it } from 'vitest'
import {
  allowedPitchClasses, quantizeToNearestNote, computeAutotuneCorrectionCurve,
  evalManualCurve, computeManualCorrectionCurve,
} from '../autotuneCorrectionPreview.js'

// This is a UI-side port of engine/src/dsp/CorrectionCurve.cpp (see that
// file's own header comment for the six-step algorithm) — these tests exist
// to catch a JS transcription bug, not to re-litigate the algorithm design,
// which is already covered end to end by engine/test/test_correction_curve.cpp.

const HOP = 240        // 5 ms at 48 kHz
const SAMPLE_RATE = 48000

function makeFrames(n, f0Hz, startIndex = 0) {
  return Array.from({ length: n }, (_, i) => ({ posSample: (startIndex + i) * HOP, f0Hz, confidence: 0.9 }))
}

describe('allowedPitchClasses', () => {
  it('matches D Phrygian (the AUTOTUNE product default)', () => {
    // scale=2 (Phrygian), key=2 (D) — mirrors AUTOTUNE_SCALE.PHRYGIAN / AUTOTUNE_DEFAULT_KEY.
    expect(allowedPitchClasses(2, 2)).toEqual([0, 2, 3, 5, 7, 9, 10]) // C D Eb F G A Bb
  })

  it('matches C major pentatonic', () => {
    expect(allowedPitchClasses(0, 9)).toEqual([0, 2, 4, 7, 9]) // C D E G A
  })
})

describe('quantizeToNearestNote', () => {
  it('snaps to the nearest pitch class regardless of octave', () => {
    const cMajor = allowedPitchClasses(0, 0)
    // 445 Hz sits between A4 (440) and A#4 (466) — nearer A4, which is in C major.
    expect(quantizeToNearestNote(445, cMajor)).toBeCloseTo(440, 0)
  })

  it('passes non-positive hz and an empty class list through unchanged', () => {
    expect(quantizeToNearestNote(0, [0, 4, 7])).toBe(0)
    expect(quantizeToNearestNote(440, [])).toBe(440)
  })
})

describe('computeAutotuneCorrectionCurve', () => {
  const segments = (n) => [{ startSample: 0, endSample: n * HOP, medianF0Hz: 450, noteName: 'A4' }]

  it('passes unvoiced frames through unchanged', () => {
    const frames = [{ posSample: 0, f0Hz: 0, confidence: 0 }]
    const out = computeAutotuneCorrectionCurve(frames, [], SAMPLE_RATE, 0, 0, [], {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0, jumpiness: 0, preserveVibrato: 100,
    })
    expect(out).toEqual([{ posSample: 0, targetF0Hz: 0, correctionCents: 0 }])
  })

  it('0% correction amount is an exact bypass even for an out-of-tune, in-scale frame', () => {
    const frames = makeFrames(5, 450) // slightly sharp of A4=440
    const out = computeAutotuneCorrectionCurve(frames, segments(5), SAMPLE_RATE, 0, 0, [], {
      correctionAmount: 0, retuneSpeedMs: 20, smoothnessMs: 20, jumpiness: 0, preserveVibrato: 100,
    })
    for (let i = 0; i < out.length; i++) {
      expect(out[i].targetF0Hz).toBeCloseTo(450, 3)
      expect(out[i].correctionCents).toBeCloseTo(0, 3)
    }
  })

  it('retuneSpeedMs=0 / smoothnessMs=0 snaps the target instantly to the quantized note', () => {
    const frames = makeFrames(5, 450)
    const out = computeAutotuneCorrectionCurve(frames, segments(5), SAMPLE_RATE, 0, 0, [], {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0, jumpiness: 0, preserveVibrato: 100,
    })
    // 450 Hz's containing segment has medianF0Hz 450, quantized (C major, the
    // default scale/key here) to the nearest scale note — A4 (440 Hz).
    const cMajor = allowedPitchClasses(0, 0)
    const expected = quantizeToNearestNote(450, cMajor)
    for (const frame of out) expect(frame.targetF0Hz).toBeCloseTo(expected, 3)
  })

  it('a jumpiness hold blocks a note switch until the hold elapses', () => {
    // Two segments: first 10 frames (50ms) target ~A4 (440), then it jumps to
    // ~D5 (587) for the rest. jumpiness=100 -> a 100ms minimum hold, so the
    // first few post-switch frames (well under 100ms) must stay committed to
    // the FIRST segment's note, not the new one. preserveVibrato=0 isolates
    // the hold from the vibrato split (see the preserveVibrato test below for
    // that mechanism) — at 100% preserve, a sudden input jump this large
    // reads mostly as "vibrato" and gets let through regardless of the hold,
    // which is correct engine behaviour but not what THIS test is checking.
    const frames = [...makeFrames(10, 440), ...makeFrames(10, 587, 10)]
    const segs = [
      { startSample: 0, endSample: 10 * HOP, medianF0Hz: 440, noteName: 'A4' },
      { startSample: 10 * HOP, endSample: 20 * HOP, medianF0Hz: 587, noteName: 'D5' },
    ]
    const out = computeAutotuneCorrectionCurve(frames, segs, SAMPLE_RATE, 0, 0, [], {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0, jumpiness: 100, preserveVibrato: 0,
    })
    const cMajor = allowedPitchClasses(0, 0)
    const targetA = quantizeToNearestNote(440, cMajor)
    const targetD = quantizeToNearestNote(587, cMajor)
    // Frame 10 is the first frame of the new segment (t=50ms into the hold,
    // committed at t=0) — 50ms < 100ms hold, so it must still read A4.
    expect(out[10].targetF0Hz).toBeCloseTo(targetA, 1)
    // Frame 19 is at t=95ms — still inside the 100ms hold from the t=0 commit.
    expect(out[19].targetF0Hz).toBeCloseTo(targetA, 1)
    // Sanity: the new note IS reachable (i.e. the hold isn't just eating the
    // whole test) — a much longer hold-free run reaches it.
    const outLong = computeAutotuneCorrectionCurve(
      [...frames, ...makeFrames(20, 587, 20)], segs.concat([
        { startSample: 20 * HOP, endSample: 40 * HOP, medianF0Hz: 587, noteName: 'D5' },
      ]),
      SAMPLE_RATE, 0, 0, [],
      { correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0, jumpiness: 100, preserveVibrato: 0 },
    )
    expect(outLong[outLong.length - 1].targetF0Hz).toBeCloseTo(targetD, 1)
  })

  it('preserveVibrato=0 flattens an oscillating input toward the committed note', () => {
    // A 20 Hz "wobble" around A4 — much faster than the 5 Hz vibrato boundary,
    // so at preserveVibrato=0 it should be corrected away almost entirely
    // once the one-pole retune has had time to settle.
    const n = 40
    const frames = Array.from({ length: n }, (_, i) => ({
      posSample: i * HOP, f0Hz: 440 * Math.pow(2, (i % 2 === 0 ? 20 : -20) / 1200), confidence: 0.9,
    }))
    const out = computeAutotuneCorrectionCurve(frames, segments(n), SAMPLE_RATE, 0, 0, [], {
      correctionAmount: 100, retuneSpeedMs: 5, smoothnessMs: 5, jumpiness: 0, preserveVibrato: 0,
    })
    const last = out[out.length - 1]
    // Not exactly 440 (the LPF never fully settles to DC), but far closer to
    // it than the +/-20 cent input wobble was.
    const cents = 1200 * Math.log2(last.targetF0Hz / 440)
    expect(Math.abs(cents)).toBeLessThan(10)
  })
})

// P5-5 (MANUAL mode). Mirrors engine/test/test_correction_curve.cpp's own
// MANUAL-mode block — same reasoning as the SCALE-mode tests above: catching
// a JS transcription bug, not re-litigating the algorithm.
describe('evalManualCurve', () => {
  it('holds before the first and after the last breakpoint', () => {
    const pts = [{ t: 0.2, hz: 220 }, { t: 0.8, hz: 440 }]
    expect(evalManualCurve(pts, 0)).toBe(220)
    expect(evalManualCurve(pts, 1)).toBe(440)
  })

  it('interpolates in cents, not raw Hz — the geometric midpoint of an octave span', () => {
    const pts = [{ t: 0, hz: 220 }, { t: 1, hz: 440 }]
    expect(evalManualCurve(pts, 0.5)).toBeCloseTo(220 * Math.sqrt(2), 3)
    expect(Math.abs(evalManualCurve(pts, 0.5) - 330)).toBeGreaterThan(1) // not the Hz-linear midpoint
  })

  it('returns 0 for an empty curve', () => {
    expect(evalManualCurve([], 0.5)).toBe(0)
  })
})

describe('computeManualCorrectionCurve', () => {
  it('empty manualPoints is a pass-through, not a snap to 0 Hz', () => {
    const frames = makeFrames(5, 310)
    const out = computeManualCorrectionCurve(frames, SAMPLE_RATE, [], {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0,
    })
    for (const f of out) expect(f.targetF0Hz).toBeCloseTo(310, 2)
  })

  it('jumpiness has no effect: 0% and 100% produce identical output', () => {
    const frames = makeFrames(200, 220)
    const pts = [{ t: 0, hz: 220 }, { t: 0.048, hz: 220 }, { t: 0.05, hz: 440 }, { t: 1, hz: 440 }]
    const base = { correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0 }
    const out0 = computeManualCorrectionCurve(frames, SAMPLE_RATE, pts, { ...base, jumpiness: 0 })
    const out100 = computeManualCorrectionCurve(frames, SAMPLE_RATE, pts, { ...base, jumpiness: 100 })
    for (let i = 0; i < out0.length; i++) expect(out100[i].targetF0Hz).toBeCloseTo(out0[i].targetF0Hz, 3)
    // Concretely: 10ms after the step, well inside what would be a 100ms
    // SCALE-mode hold, jumpiness=100 has already moved.
    expect(out100[12].targetF0Hz).toBeCloseTo(440, 0)
  })

  it('preserveVibrato has no effect: 0% and 100% produce identical output', () => {
    const frames = makeFrames(50, 220)
    const pts = Array.from({ length: 50 }, (_, i) => {
      const t = (i * HOP) / SAMPLE_RATE
      return { t, hz: 220 * Math.pow(2, (20 * Math.sin(2 * Math.PI * 8 * t)) / 1200) }
    })
    const base = { correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0 }
    const out0 = computeManualCorrectionCurve(frames, SAMPLE_RATE, pts, { ...base, preserveVibrato: 0 })
    const out100 = computeManualCorrectionCurve(frames, SAMPLE_RATE, pts, { ...base, preserveVibrato: 100 })
    for (let i = 0; i < out0.length; i++) expect(out100[i].targetF0Hz).toBeCloseTo(out0[i].targetF0Hz, 3)
  })

  it('a hard step ramps over smoothnessMs instead of snapping instantly', () => {
    const frames = makeFrames(200, 220)
    const pts = [{ t: 0, hz: 220 }, { t: 0.498, hz: 220 }, { t: 0.5, hz: 440 }, { t: 1, hz: 440 }]
    const instant = computeManualCorrectionCurve(frames, SAMPLE_RATE, pts, {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0,
    })
    expect(instant[101].targetF0Hz).toBeCloseTo(440, 0)

    const ramped = computeManualCorrectionCurve(frames, SAMPLE_RATE, pts, {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 100,
    })
    expect(ramped[101].targetF0Hz).toBeGreaterThan(220)
    expect(ramped[101].targetF0Hz).toBeLessThan(440)
  })

  it('passes unvoiced frames through unchanged', () => {
    const frames = [{ posSample: 0, f0Hz: 0, confidence: 0 }]
    const out = computeManualCorrectionCurve(frames, SAMPLE_RATE, [{ t: 0, hz: 300 }, { t: 1, hz: 300 }], {
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0,
    })
    expect(out).toEqual([{ posSample: 0, targetF0Hz: 0, correctionCents: 0 }])
  })
})

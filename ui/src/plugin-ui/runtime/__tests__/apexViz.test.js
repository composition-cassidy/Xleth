// apexViz.test.js — pins ui/src/constants/dynamicsViz.js APEX_BUCKET against
// the C++ ApexBucket layout in engine/src/audio/viz/DynamicsVizFrame.h.
//
// Why this file exists: the byte offsets in APEX_BUCKET are hand-transcribed
// from a C++ struct. If one drifts, nothing else notices — the parser happily
// reads a float from the wrong offset and the UI paints plausible garbage. So
// this test builds a buffer field by field from the C++ offsets and asserts the
// parser reads each one back, which fails loudly on any single-field drift.
//
// The engine side is pinned separately by engine/test/test_apex.cpp
// (static_assert sizeof(ApexBucket) == 4176 plus a live payload check), and the
// two are tied together by the shared 4176 constant asserted here.

import { describe, it, expect } from 'vitest'
import { parseDrainResponse, VIZ_TYPE, APEX_BUCKET, DYNAMICS_VIZ_SCHEMA_VERSION }
  from '../../../constants/dynamicsViz.js'

// Offsets restated literally from DynamicsVizFrame.h, NOT read from
// APEX_BUCKET — a test that sourced its offsets from the thing under test
// would pass no matter how wrong that thing was.
const OFF = {
  sampleClock: 0, bucketSamples: 8, flags: 12,
  inputPeakDb: 16, outputPeakDb: 20,
  bandGrDb: 24, bandOutDb: 40,
  lookaheadSamples: 56, latencySamples: 60,
  splitLoHz: 64, splitHiHz: 68,
  sampleRate: 72, spectrumBins: 76,
  spectrum: 80,
}
const SIZE = 4176
const BINS = 1024
const LE = true

function makeBucket(overrides = {}) {
  const v = {
    sampleClock: 123456n, bucketSamples: 1323, flags: 0,
    inputPeakDb: -6.5, outputPeakDb: -3.25,
    bandGrDb: [1.5, 2.5, 3.5, 4.5],
    bandOutDb: [-10, -20, -30, -40],
    lookaheadSamples: 551, latencySamples: 645,
    splitLoHz: 320, splitHiHz: 5500,
    sampleRate: 44100, spectrumBins: BINS,
    ...overrides,
  }
  const ab = new ArrayBuffer(SIZE)
  const dv = new DataView(ab)
  dv.setBigUint64(OFF.sampleClock, v.sampleClock, LE)
  dv.setUint32(OFF.bucketSamples, v.bucketSamples, LE)
  dv.setUint32(OFF.flags, v.flags, LE)
  dv.setFloat32(OFF.inputPeakDb, v.inputPeakDb, LE)
  dv.setFloat32(OFF.outputPeakDb, v.outputPeakDb, LE)
  for (let i = 0; i < 4; i++) {
    dv.setFloat32(OFF.bandGrDb + i * 4, v.bandGrDb[i], LE)
    dv.setFloat32(OFF.bandOutDb + i * 4, v.bandOutDb[i], LE)
  }
  dv.setFloat32(OFF.lookaheadSamples, v.lookaheadSamples, LE)
  dv.setFloat32(OFF.latencySamples, v.latencySamples, LE)
  dv.setFloat32(OFF.splitLoHz, v.splitLoHz, LE)
  dv.setFloat32(OFF.splitHiHz, v.splitHiHz, LE)
  dv.setFloat32(OFF.sampleRate, v.sampleRate, LE)
  dv.setFloat32(OFF.spectrumBins, v.spectrumBins, LE)
  // A ramp, so an off-by-one in the array base is visible as a shifted value.
  for (let i = 0; i < BINS; i++) dv.setFloat32(OFF.spectrum + i * 4, -120 + i * 0.1, LE)
  return { ab, v }
}

function response(ab, count = 1) {
  return {
    type: 'apex',
    schema: DYNAMICS_VIZ_SCHEMA_VERSION,
    bucketSize: SIZE,
    count,
    frames: ab,
  }
}

describe('APEX_BUCKET layout', () => {
  it('matches the C++ struct size and shape constants', () => {
    expect(APEX_BUCKET.sizeBytes).toBe(SIZE)
    expect(APEX_BUCKET.spectrumBins).toBe(BINS)
    expect(APEX_BUCKET.fftSize).toBe(2048)
    expect(APEX_BUCKET.numBands).toBe(4)
    // 16-byte header + 16 metadata floats (64 B) + 1024 spectrum floats.
    expect(16 + 16 * 4 + BINS * 4).toBe(SIZE)
    // ...which is also why the spectrum array starts at byte 80.
    expect(OFF.spectrum).toBe(16 + 16 * 4)
  })

  it('declares every field at its C++ byte offset', () => {
    for (const [name, offset] of Object.entries(OFF)) {
      if (name === 'spectrum' || name === 'bandGrDb' || name === 'bandOutDb') {
        expect(APEX_BUCKET.arrays[name].offset, `array ${name}`).toBe(offset)
      } else {
        expect(APEX_BUCKET.fields[name].offset, `field ${name}`).toBe(offset)
      }
    }
    expect(APEX_BUCKET.arrays.spectrum.count).toBe(BINS)
    expect(APEX_BUCKET.arrays.bandGrDb.count).toBe(4)
    expect(APEX_BUCKET.arrays.bandOutDb.count).toBe(4)
  })

  it('exposes apex on the VIZ_TYPE enum', () => {
    expect(VIZ_TYPE.APEX).toBe('apex')
  })
})

describe('parseDrainResponse (apex)', () => {
  it('decodes every scalar and array field', () => {
    const { ab, v } = makeBucket()
    const p = parseDrainResponse(response(ab), VIZ_TYPE.APEX)
    expect(p.ok).toBe(true)
    expect(p.count).toBe(1)

    const b = p.decode(0)
    expect(b.sampleClock).toBe(v.sampleClock)
    expect(b.bucketSamples).toBe(v.bucketSamples)
    expect(b.inputPeakDb).toBeCloseTo(v.inputPeakDb, 4)
    expect(b.outputPeakDb).toBeCloseTo(v.outputPeakDb, 4)
    expect(b.lookaheadSamples).toBeCloseTo(v.lookaheadSamples, 4)
    expect(b.latencySamples).toBeCloseTo(v.latencySamples, 4)
    expect(b.splitLoHz).toBeCloseTo(v.splitLoHz, 2)
    expect(b.splitHiHz).toBeCloseTo(v.splitHiHz, 2)
    expect(b.sampleRate).toBeCloseTo(v.sampleRate, 2)
    expect(b.spectrumBins).toBe(BINS)

    expect(b.bandGrDb).toHaveLength(4)
    expect(b.bandOutDb).toHaveLength(4)
    v.bandGrDb.forEach((x, i) => expect(b.bandGrDb[i]).toBeCloseTo(x, 4))
    v.bandOutDb.forEach((x, i) => expect(b.bandOutDb[i]).toBeCloseTo(x, 4))

    expect(b.spectrum).toHaveLength(BINS)
    expect(b.spectrum[0]).toBeCloseTo(-120, 3)
    expect(b.spectrum[1]).toBeCloseTo(-119.9, 3)
    expect(b.spectrum[BINS - 1]).toBeCloseTo(-120 + (BINS - 1) * 0.1, 2)
  })

  it('decodes a multi-bucket batch, keeping buckets distinct', () => {
    const a = makeBucket({ inputPeakDb: -1 })
    const c = makeBucket({ inputPeakDb: -50 })
    const merged = new Uint8Array(SIZE * 2)
    merged.set(new Uint8Array(a.ab), 0)
    merged.set(new Uint8Array(c.ab), SIZE)

    const p = parseDrainResponse(response(merged.buffer, 2), VIZ_TYPE.APEX)
    expect(p.ok).toBe(true)
    expect(p.count).toBe(2)
    expect(p.decode(0).inputPeakDb).toBeCloseTo(-1, 4)
    expect(p.decode(1).inputPeakDb).toBeCloseTo(-50, 4)
    expect(p.decode(2)).toBeNull()
  })

  it('clamps a bogus spectrumBins rather than reading past the array', () => {
    const { ab } = makeBucket({ spectrumBins: 999999 })
    const b = parseDrainResponse(response(ab), VIZ_TYPE.APEX).decode(0)
    expect(b.spectrum).toHaveLength(BINS)

    const neg = makeBucket({ spectrumBins: -5 })
    const b2 = parseDrainResponse(response(neg.ab), VIZ_TYPE.APEX).decode(0)
    expect(b2.spectrum).toHaveLength(0)
  })

  it('rejects a mismatched bucket size instead of decoding garbage', () => {
    const { ab } = makeBucket()
    const bad = { ...response(ab), bucketSize: 4160 }
    const p = parseDrainResponse(bad, VIZ_TYPE.APEX)
    expect(p.ok).toBe(false)
    expect(p.reason).toMatch(/bucket-size-mismatch/)
  })

  it('rejects a type mismatch (effect replaced under the subscription)', () => {
    const { ab } = makeBucket()
    const p = parseDrainResponse({ ...response(ab), type: 'compressor' }, VIZ_TYPE.APEX)
    expect(p.ok).toBe(false)
    expect(p.reason).toMatch(/type-mismatch/)
  })

  it('returns an empty-but-ok result for a zero-count drain', () => {
    const p = parseDrainResponse(
      { type: 'apex', schema: DYNAMICS_VIZ_SCHEMA_VERSION, bucketSize: SIZE,
        count: 0, frames: new ArrayBuffer(0) },
      VIZ_TYPE.APEX)
    expect(p.ok).toBe(true)
    expect(p.count).toBe(0)
    expect(p.decode(0)).toBeNull()
  })
})

// Tests for the Overdone (3-band multiband) visualization pipeline:
//   • Bucket parser (parseDrainResponse) accepts Multiband payloads and
//     rejects wrong type / wrong bucket size / wrong schema.
//   • Painter functions render against fake frames without throwing.
//   • Display history transform downsamples and yields finite per-band coords.
//   • Visualizer dispatch routes overdone.* sources through the multiband
//     painter set (and not Compressor / Limiter / Transient).
//   • VisualizerInspector source options include overdone sources for the
//     Overdone manifest, and never leak across plugins.

import { describe, expect, it, vi } from 'vitest'

import {
  DYNAMICS_VIZ_SCHEMA_VERSION,
  MULTIBAND_BUCKET,
  TRANSIENT_BUCKET,
  LIMITER_BUCKET,
  COMPRESSOR_BUCKET,
  VIZ_TYPE,
  parseDrainResponse,
} from '../../../constants/dynamicsViz.js'
import {
  MULTIBAND_DISPLAY,
  MULTIBAND_PRESETS,
  MULTIBAND_VISUALIZER_PRESETS,
  MULTIBAND_SOURCE_DEFAULT_PRESET,
  buildMultibandDisplayHistory,
  computeMultibandMeterValues,
  downsampleMultibandHistory,
  drawOverdoneMultiband,
  drawOverdoneBands,
  drawOverdoneGainReduction,
  multibandLevelToY,
  multibandGrFillHeight,
  smoothMultibandDisplayHistory,
} from '../visualizers/multibandPainter.js'
import {
  getPresetOptionsForSource,
  isPresetAllowedForSource,
  resolveSafePresetForSource,
} from '../../designer/inspectors/inspectorHelpers.js'
import { OVERDONE_MANIFEST } from '../../manifests/overdone.js'
import { TRANSIENT_MANIFEST } from '../../manifests/transient.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { getVizSourceOptions } from '../../designer/BindingPicker.jsx'

// ── Helpers ────────────────────────────────────────────────────────────────

function buildMultibandFrames(buckets) {
  const buf = new ArrayBuffer(buckets.length * MULTIBAND_BUCKET.sizeBytes)
  const view = new DataView(buf)
  buckets.forEach((b, i) => {
    const base = i * MULTIBAND_BUCKET.sizeBytes
    const f = MULTIBAND_BUCKET.fields
    view.setBigUint64(base + f.sampleClock.offset,         BigInt(b.sampleClock ?? 0), true)
    view.setUint32(   base + f.bucketSamples.offset,       b.bucketSamples ?? 64,      true)
    view.setUint32(   base + f.flags.offset,               b.flags ?? 0,               true)
    view.setFloat32(  base + f.inputPeakDb.offset,         b.inputPeakDb         ?? -12, true)
    view.setFloat32(  base + f.outputPeakDb.offset,        b.outputPeakDb        ?? -10, true)
    view.setFloat32(  base + f.depth.offset,               b.depth               ?? 70,  true)
    view.setFloat32(  base + f.time.offset,                b.time                ?? 50,  true)
    view.setFloat32(  base + f.lowCrossoverHz.offset,      b.lowCrossoverHz      ?? 88,  true)
    view.setFloat32(  base + f.highCrossoverHz.offset,     b.highCrossoverHz     ?? 2500,true)
    view.setFloat32(  base + f.lowInputDb.offset,          b.lowInputDb          ?? -16, true)
    view.setFloat32(  base + f.lowOutputDb.offset,         b.lowOutputDb         ?? -18, true)
    view.setFloat32(  base + f.lowGainReductionDb.offset,  b.lowGainReductionDb  ?? 0,   true)
    view.setFloat32(  base + f.midInputDb.offset,          b.midInputDb          ?? -14, true)
    view.setFloat32(  base + f.midOutputDb.offset,         b.midOutputDb         ?? -16, true)
    view.setFloat32(  base + f.midGainReductionDb.offset,  b.midGainReductionDb  ?? 0,   true)
    view.setFloat32(  base + f.highInputDb.offset,         b.highInputDb         ?? -22, true)
    view.setFloat32(  base + f.highOutputDb.offset,        b.highOutputDb        ?? -24, true)
    view.setFloat32(  base + f.highGainReductionDb.offset, b.highGainReductionDb ?? 0,   true)
  })
  return buf
}

function makeRingFromBuckets(buckets) {
  const cap = Math.max(buckets.length, 8)
  return {
    buckets: buckets.slice(),
    capacity: cap,
    head: buckets.length % cap,
    count: buckets.length,
    forEachInOrder(fn) {
      for (let i = 0; i < this.count; i++) fn(this.buckets[i], i)
    },
    last() { return this.count > 0 ? this.buckets[this.count - 1] : null },
  }
}

function makeStubCtx() {
  const calls = []
  const stub = {
    calls,
    setLineDash: vi.fn((...args) => calls.push(['setLineDash', args])),
    fillRect:    vi.fn((...args) => calls.push(['fillRect', args])),
    strokeRect:  vi.fn(),
    beginPath:   vi.fn(() => calls.push(['beginPath'])),
    moveTo:      vi.fn(),
    lineTo:      vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath:   vi.fn(),
    stroke:      vi.fn(() => calls.push(['stroke'])),
    fill:        vi.fn(),
    arc:         vi.fn(),
    save:        vi.fn(() => calls.push(['save'])),
    restore:     vi.fn(() => calls.push(['restore'])),
    translate:   vi.fn(),
    fillText:    vi.fn((...args) => calls.push(['fillText', args])),
    measureText: vi.fn(() => ({ width: 24 })),
    set fillStyle(v)    { calls.push(['fillStyle', v]) },
    set strokeStyle(v)  { calls.push(['strokeStyle', v]) },
    set lineWidth(v)    { calls.push(['lineWidth', v]) },
    set globalAlpha(v)  { calls.push(['globalAlpha', v]) },
    set font(v)         { calls.push(['font', v]) },
    set textAlign(v)    { calls.push(['textAlign', v]) },
    set textBaseline(v) { calls.push(['textBaseline', v]) },
  }
  return stub
}

const THEME = Object.freeze({
  bg:        '#0f0f0f',
  bgInset:   '#0a0a0a',
  surface:   '#181818',
  text:      '#ddd',
  textMuted: '#999',
  grid:      '#333',
  accent:    '#a5f3fc',
  accentDim: '#475569',
})

// ── parseDrainResponse for Multiband ──────────────────────────────────────

describe('Multiband parser (parseDrainResponse)', () => {
  it('accepts a well-formed Multiband drain payload', () => {
    const buckets = [
      { sampleClock: 64,  bucketSamples: 64,
        inputPeakDb: -10, outputPeakDb: -8,
        depth: 70, time: 50, lowCrossoverHz: 88, highCrossoverHz: 2500,
        lowInputDb: -12, lowOutputDb: -14, lowGainReductionDb: 4,
        midInputDb: -10, midOutputDb: -12, midGainReductionDb: 3,
        highInputDb: -22, highOutputDb: -24, highGainReductionDb: 2 },
      { sampleClock: 128, bucketSamples: 64,
        inputPeakDb: -12, outputPeakDb: -10,
        lowGainReductionDb: 6, midGainReductionDb: 5, highGainReductionDb: 3 },
    ]
    const frames = buildMultibandFrames(buckets)
    const resp = {
      type:       'multiband',
      schema:     DYNAMICS_VIZ_SCHEMA_VERSION,
      bucketSize: MULTIBAND_BUCKET.sizeBytes,
      count:      buckets.length,
      frames,
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.MULTIBAND)
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(buckets.length)

    const decoded0 = parsed.decode(0)
    expect(decoded0.inputPeakDb).toBeCloseTo(-10, 5)
    expect(decoded0.lowGainReductionDb).toBeCloseTo(4, 5)
    expect(decoded0.midInputDb).toBeCloseTo(-10, 5)
    expect(decoded0.lowCrossoverHz).toBeCloseTo(88, 5)
    expect(decoded0.highCrossoverHz).toBeCloseTo(2500, 1)
    expect(decoded0.depth).toBeCloseTo(70, 5)

    const decoded1 = parsed.decode(1)
    expect(decoded1.lowGainReductionDb).toBeCloseTo(6, 5)
    expect(decoded1.highGainReductionDb).toBeCloseTo(3, 5)
  })

  it('rejects a Multiband payload whose bucketSize does not match the schema', () => {
    const resp = {
      type: 'multiband', schema: 1,
      bucketSize: 56, // Limiter / Transient size, wrong for Multiband (80)
      count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.MULTIBAND)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/^bucket-size-mismatch:56$/)
  })

  it('rejects when the engine returns a Compressor payload but consumer asked for Multiband', () => {
    const resp = {
      type: 'compressor', schema: 1,
      bucketSize: COMPRESSOR_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.MULTIBAND)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('type-mismatch:compressor')
  })

  it('rejects when the engine returns a Transient payload but consumer asked for Multiband', () => {
    const resp = {
      type: 'transient', schema: 1,
      bucketSize: TRANSIENT_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.MULTIBAND)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('type-mismatch:transient')
  })

  it('rejects when the engine returns a Limiter payload but consumer asked for Multiband', () => {
    const resp = {
      type: 'limiter', schema: 1,
      bucketSize: LIMITER_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.MULTIBAND)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('type-mismatch:limiter')
  })

  it('rejects an unknown / future schema version', () => {
    const resp = {
      type: 'multiband', schema: 999,
      bucketSize: MULTIBAND_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.MULTIBAND)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/^schema-mismatch:/)
  })

  it('still accepts existing dynamics types for their own consumers (no regression)', () => {
    expect(parseDrainResponse({
      type: 'compressor', schema: 1, bucketSize: COMPRESSOR_BUCKET.sizeBytes,
      count: 0, frames: new ArrayBuffer(0),
    }, VIZ_TYPE.COMPRESSOR).ok).toBe(true)
    expect(parseDrainResponse({
      type: 'limiter', schema: 1, bucketSize: LIMITER_BUCKET.sizeBytes,
      count: 0, frames: new ArrayBuffer(0),
    }, VIZ_TYPE.LIMITER).ok).toBe(true)
    expect(parseDrainResponse({
      type: 'transient', schema: 1, bucketSize: TRANSIENT_BUCKET.sizeBytes,
      count: 0, frames: new ArrayBuffer(0),
    }, VIZ_TYPE.TRANSIENT).ok).toBe(true)
  })
})

// ── Painter smoke tests ────────────────────────────────────────────────────

describe('Multiband painters', () => {
  const buckets = Array.from({ length: 32 }, (_, i) => ({
    sampleClock: i * 64,
    bucketSamples: 64,
    inputPeakDb:  -10 - (i % 6),
    outputPeakDb: -10 - (i % 6),
    depth: 70, time: 50, lowCrossoverHz: 88, highCrossoverHz: 2500,
    lowInputDb:  -16 - (i % 4), lowOutputDb:  -18 - (i % 4), lowGainReductionDb:  i % 5 === 0 ? 6 : 0,
    midInputDb:  -14 - (i % 3), midOutputDb:  -16 - (i % 3), midGainReductionDb:  i % 7 === 0 ? 5 : 0,
    highInputDb: -22 - (i % 2), highOutputDb: -24 - (i % 2), highGainReductionDb: i % 9 === 0 ? 3 : 0,
  }))
  const ring = makeRingFromBuckets(buckets)

  it('drawOverdoneMultiband draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawOverdoneMultiband(ctx, 760, 260, ring, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawOverdoneMultiband draws without throwing on a noisy 900-bucket ring with NaN/Inf', () => {
    const noisyBuckets = Array.from({ length: 900 }, (_, i) => ({
      sampleClock: i * 64,
      bucketSamples: 64,
      inputPeakDb:  i % 41 === 0 ? Number.NaN : -16 + Math.sin(i * 0.73) * 22,
      outputPeakDb: i % 37 === 0 ? Number.POSITIVE_INFINITY : -13 + Math.cos(i * 0.51) * 14,
      lowInputDb:   i % 29 === 0 ? Number.NaN : -16 + Math.sin(i * 0.17) * 9,
      lowOutputDb:  i % 31 === 0 ? Number.NEGATIVE_INFINITY : -18 + Math.cos(i * 0.09) * 6,
      lowGainReductionDb:  i % 53 === 0 ? Number.NaN : Math.abs(Math.sin(i * 0.05)) * 18,
      midInputDb:   -14, midOutputDb: -16, midGainReductionDb: 2,
      highInputDb:  -22, highOutputDb: -24, highGainReductionDb: i % 19 === 0 ? Number.POSITIVE_INFINITY : 1,
    }))
    const noisyRing = makeRingFromBuckets(noisyBuckets)
    const ctx = makeStubCtx()
    expect(() => drawOverdoneMultiband(ctx, 640, 260, noisyRing, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawOverdoneBands draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawOverdoneBands(ctx, 600, 240, ring, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawOverdoneGainReduction draws without throwing on an empty ring', () => {
    const ctx = makeStubCtx()
    const emptyRing = makeRingFromBuckets([])
    expect(() => drawOverdoneGainReduction(ctx, 400, 120, emptyRing, THEME)).not.toThrow()
  })

  it('MULTIBAND_PRESETS keys are wired to functions', () => {
    expect(typeof MULTIBAND_PRESETS.overdoneMultiband).toBe('function')
    expect(typeof MULTIBAND_PRESETS.overdoneBands).toBe('function')
    expect(typeof MULTIBAND_PRESETS.overdoneGainReduction).toBe('function')
  })
})

// ── Display history transform ──────────────────────────────────────────────

describe('Multiband display transform', () => {
  it('downsampleMultibandHistory reduces dense history to no more than canvas-width buckets', () => {
    const dense = Array.from({ length: 2048 }, (_, i) => ({
      inputPeakDb: -16 + Math.sin(i * 0.3) * 12,
      outputPeakDb: -16 + Math.cos(i * 0.3) * 12,
      lowInputDb: -14, lowOutputDb: -16, lowGainReductionDb: Math.abs(Math.sin(i * 0.2)) * 18,
      midInputDb: -12, midOutputDb: -14, midGainReductionDb: Math.abs(Math.cos(i * 0.2)) * 10,
      highInputDb: -22, highOutputDb: -24, highGainReductionDb: 2,
    }))
    const columns = downsampleMultibandHistory(dense, 120)
    expect(columns.length).toBeLessThanOrEqual(120)
    expect(columns.length).toBeGreaterThan(0)
  })

  it('every column emitted by downsampleMultibandHistory has finite per-band coordinates', () => {
    const dense = Array.from({ length: 200 }, (_, i) => ({
      inputPeakDb: -10, outputPeakDb: -10,
      lowInputDb:  i % 17 === 0 ? Number.NaN : -16,
      lowOutputDb: i % 19 === 0 ? Number.NEGATIVE_INFINITY : -18,
      lowGainReductionDb: i % 13 === 0 ? Number.NaN : 6,
      midInputDb: -14, midOutputDb: -16, midGainReductionDb: Number.NaN,
      highInputDb: -22, highOutputDb: -24, highGainReductionDb: 2,
    }))
    const columns = downsampleMultibandHistory(dense, 80)
    for (const col of columns) {
      expect(Number.isFinite(col.x)).toBe(true)
      for (const k of ['low', 'mid', 'high']) {
        expect(Number.isFinite(col.bands[k].inDb)).toBe(true)
        expect(Number.isFinite(col.bands[k].outDb)).toBe(true)
        expect(Number.isFinite(col.bands[k].grDb)).toBe(true)
      }
    }
  })

  it('smoothMultibandDisplayHistory keeps finite display values', () => {
    const columns = [
      { x: 0, inputDb: Number.NaN, outputDb: -12,
        bands: { low: { inDb: Number.NaN, outDb: -18, grDb: 0 },
                 mid: { inDb: -14, outDb: -16, grDb: 0 },
                 high: { inDb: -22, outDb: -24, grDb: 0 } } },
      { x: 2, inputDb: 8, outputDb: Number.POSITIVE_INFINITY,
        bands: { low: { inDb: -10, outDb: Number.POSITIVE_INFINITY, grDb: 24 },
                 mid: { inDb: -12, outDb: -14, grDb: Number.NaN },
                 high: { inDb: -22, outDb: -24, grDb: 0 } } },
    ]
    const smoothed = smoothMultibandDisplayHistory(columns)
    for (const col of smoothed) {
      expect(Number.isFinite(col.inputDb)).toBe(true)
      expect(Number.isFinite(col.outputDb)).toBe(true)
      for (const k of ['low', 'mid', 'high']) {
        expect(Number.isFinite(col.bands[k].inDb)).toBe(true)
        expect(Number.isFinite(col.bands[k].outDb)).toBe(true)
        expect(Number.isFinite(col.bands[k].grDb)).toBe(true)
      }
    }
  })

  it('buildMultibandDisplayHistory returns smoothed finite columns from a ring', () => {
    const ring = makeRingFromBuckets(Array.from({ length: 256 }, (_, i) => ({
      inputPeakDb: -10, outputPeakDb: -10,
      lowInputDb: -14 + Math.sin(i * 0.05) * 4,
      lowOutputDb: -16 + Math.sin(i * 0.05) * 4,
      lowGainReductionDb: Math.abs(Math.sin(i * 0.1)) * 12,
      midInputDb: -12, midOutputDb: -14, midGainReductionDb: 2,
      highInputDb: -22, highOutputDb: -24, highGainReductionDb: 1,
    })))
    const columns = buildMultibandDisplayHistory(ring, 160)
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(160)
    expect(columns.every((c) =>
      Number.isFinite(c.x) &&
      Number.isFinite(c.bands.low.inDb)  && Number.isFinite(c.bands.low.outDb)  && Number.isFinite(c.bands.low.grDb)  &&
      Number.isFinite(c.bands.mid.inDb)  && Number.isFinite(c.bands.mid.outDb)  && Number.isFinite(c.bands.mid.grDb)  &&
      Number.isFinite(c.bands.high.inDb) && Number.isFinite(c.bands.high.outDb) && Number.isFinite(c.bands.high.grDb),
    )).toBe(true)
  })

  it('multibandLevelToY clamps 0 dB to top and minDb to bottom', () => {
    expect(multibandLevelToY(0, 100)).toBe(0)
    expect(multibandLevelToY(MULTIBAND_DISPLAY.level.minDb, 100)).toBe(99)
    expect(multibandLevelToY(-200, 100)).toBe(99)
  })

  it('multibandGrFillHeight returns 0 for 0 dB and a positive value for max GR', () => {
    expect(multibandGrFillHeight(0, 100)).toBe(0)
    expect(multibandGrFillHeight(MULTIBAND_DISPLAY.gr.maxGrDb, 100)).toBeGreaterThan(0)
    expect(multibandGrFillHeight(Number.NaN, 100)).toBe(0)
  })
})

describe('Multiband meter values', () => {
  it('computeMultibandMeterValues keeps per-band GR finite and clamped through noisy inputs', () => {
    let meter = null
    const buckets = [
      { lowGainReductionDb: 0,                       midGainReductionDb: 0,                       highGainReductionDb: 0 },
      { lowGainReductionDb: Number.POSITIVE_INFINITY, midGainReductionDb: Number.NaN,            highGainReductionDb: 12 },
      { lowGainReductionDb: 8,                       midGainReductionDb: 24,                      highGainReductionDb: -42 },
      null,
    ]
    for (const bucket of buckets) {
      meter = computeMultibandMeterValues(bucket, meter)
      for (const k of ['low', 'mid', 'high']) {
        expect(Number.isFinite(meter[k])).toBe(true)
        expect(meter[k]).toBeGreaterThanOrEqual(0)
        expect(meter[k]).toBeLessThanOrEqual(MULTIBAND_DISPLAY.gr.maxGrDb)
      }
    }
  })
})

// ── Inspector helpers / preset gating ──────────────────────────────────────

describe('Multiband visualizer inspector helpers', () => {
  it('lists multiband presets for overdone.multiband source', () => {
    const options = getPresetOptionsForSource('overdone.multiband', null)
    const keys = options.map(o => o.value)
    expect(keys).toContain('overdoneMultiband')
    expect(keys.every(k => k.startsWith('overdone'))).toBe(true)
  })

  it('lists transient presets for transient.shaper source (no leak)', () => {
    const options = getPresetOptionsForSource('transient.shaper', null)
    const keys = options.map(o => o.value)
    expect(keys.every(k => !k.startsWith('overdone'))).toBe(true)
  })

  it('isPresetAllowedForSource enforces source-preset matching across plugins', () => {
    expect(isPresetAllowedForSource('overdoneMultiband', 'overdone.multiband')).toBe(true)
    expect(isPresetAllowedForSource('overdoneMultiband', 'transient.shaper')).toBe(false)
    expect(isPresetAllowedForSource('overdoneMultiband', 'compressor.combined')).toBe(false)
    expect(isPresetAllowedForSource('overdoneMultiband', 'limiter.realtime')).toBe(false)
    expect(isPresetAllowedForSource('transientShaper',   'overdone.multiband')).toBe(false)
    expect(isPresetAllowedForSource('levelHistory',      'overdone.multiband')).toBe(false)
    expect(isPresetAllowedForSource('limiterRealtime',   'overdone.multiband')).toBe(false)
  })

  it('resolveSafePresetForSource returns the documented default for overdone.multiband', () => {
    expect(resolveSafePresetForSource('overdone.multiband')).toBe('overdoneMultiband')
    expect(MULTIBAND_SOURCE_DEFAULT_PRESET['overdone.multiband']).toBe('overdoneMultiband')
  })

  it('MULTIBAND_VISUALIZER_PRESETS exports an overdoneMultiband preset bound to overdone.multiband', () => {
    const preset = MULTIBAND_VISUALIZER_PRESETS.overdoneMultiband
    expect(preset).toBeTruthy()
    expect(preset.sources).toContain('overdone.multiband')
  })
})

// ── BindingPicker source listing ───────────────────────────────────────────

describe('BindingPicker viz source options for Overdone', () => {
  it('lists overdone.multiband for the Overdone manifest', () => {
    const opts = getVizSourceOptions(OVERDONE_MANIFEST, null)
    const values = opts.map(o => o.value)
    expect(values).toContain('overdone.multiband')
  })

  it('does not list compressor / limiter / transient sources for the Overdone manifest', () => {
    const opts = getVizSourceOptions(OVERDONE_MANIFEST, null)
    const values = opts.map(o => o.value)
    for (const v of values) {
      expect(v.startsWith('compressor.')).toBe(false)
      expect(v.startsWith('limiter.')).toBe(false)
      expect(v.startsWith('transient.')).toBe(false)
      expect(v.startsWith('overdone.')).toBe(true)
    }
  })

  it('does not list overdone sources for the Compressor / Limiter / Transient manifests', () => {
    for (const m of [COMPRESSOR_MANIFEST, LIMITER_MANIFEST, TRANSIENT_MANIFEST]) {
      const opts = getVizSourceOptions(m, null)
      const values = opts.map(o => o.value)
      for (const v of values) expect(v.startsWith('overdone.')).toBe(false)
    }
  })
})

// ── Source-prefix dispatch ────────────────────────────────────────────────

describe('Multiband source-prefix dispatch', () => {
  it('overdoneMultiband preset is in the Multiband registry, not in others', () => {
    const keys = new Set(Object.keys(MULTIBAND_PRESETS))
    expect(keys.has('overdoneMultiband')).toBe(true)
    expect(keys.has('transientShaper')).toBe(false)
    expect(keys.has('limiterRealtime')).toBe(false)
    expect(keys.has('levelHistory')).toBe(false)
  })
})

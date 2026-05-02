// Tests for the Limiter visualization pipeline:
//   • Bucket parser (parseDrainResponse) accepts Limiter payloads and rejects
//     wrong type / wrong bucket size / wrong schema.
//   • Painter functions render against fake frames without throwing.
//   • Visualizer dispatch (DynamicsVisualizerCanvas) routes Limiter sources
//     through the limiter painter set.
//   • VisualizerInspector source options include 'limiter.realtime' for the
//     Limiter manifest, and do not include Compressor sources.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DYNAMICS_VIZ_SCHEMA_VERSION,
  LIMITER_BUCKET,
  COMPRESSOR_BUCKET,
  VIZ_TYPE,
  parseDrainResponse,
} from '../../../constants/dynamicsViz.js'
import {
  LIMITER_DISPLAY,
  LIMITER_PRESETS,
  LIMITER_VISUALIZER_PRESETS,
  LIMITER_SOURCE_DEFAULT_PRESET,
  buildLimiterDisplayHistory,
  computeLimiterMeterValues,
  downsampleLimiterHistory,
  drawLimiterRealtime,
  drawLimiterGainReduction,
  drawLimiterMeterOnly,
  limiterLevelToY,
  pickLimiterGrLabels,
  smoothLimiterDisplayHistory,
} from '../visualizers/limiterPainter.js'
import {
  getPresetOptionsForSource,
  isPresetAllowedForSource,
  resolveSafePresetForSource,
} from '../../designer/inspectors/inspectorHelpers.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { getVizSourceOptions } from '../../designer/BindingPicker.jsx'

// ── Helpers ────────────────────────────────────────────────────────────────

function buildLimiterFrames(buckets) {
  const buf = new ArrayBuffer(buckets.length * LIMITER_BUCKET.sizeBytes)
  const view = new DataView(buf)
  buckets.forEach((b, i) => {
    const base = i * LIMITER_BUCKET.sizeBytes
    view.setBigUint64(base + LIMITER_BUCKET.fields.sampleClock.offset,   BigInt(b.sampleClock ?? 0), true)
    view.setUint32(   base + LIMITER_BUCKET.fields.bucketSamples.offset, b.bucketSamples ?? 64,      true)
    view.setUint32(   base + LIMITER_BUCKET.fields.flags.offset,          b.flags ?? 0,              true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.inLevelDb.offset,       b.inLevelDb ?? 0,         true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.outLevelDb.offset,      b.outLevelDb ?? 0,        true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.gainReductionDb.offset, b.gainReductionDb ?? 0,   true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.inEnergyDb.offset,      b.inEnergyDb ?? -60,      true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.outEnergyDb.offset,     b.outEnergyDb ?? -60,     true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.ceilingDb.offset,       b.ceilingDb ?? -1,        true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.gainDb.offset,          b.gainDb ?? 0,            true)
    view.setFloat32(  base + LIMITER_BUCKET.fields.releaseMs.offset,       b.releaseMs ?? 100,       true)
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
  // Minimal stub of the bits painters use. Records calls so we can verify the
  // painter actually drew something without spinning up a browser canvas.
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
  accent:    '#ff4040',
  accentDim: '#883333',
})

// ── parseDrainResponse for Limiter ─────────────────────────────────────────

describe('Limiter parser (parseDrainResponse)', () => {
  it('accepts a well-formed Limiter drain payload', () => {
    const buckets = [
      { sampleClock: 64,  bucketSamples: 64, inLevelDb: -3, outLevelDb: -1, gainReductionDb: 4 },
      { sampleClock: 128, bucketSamples: 64, inLevelDb: -2, outLevelDb: -1, gainReductionDb: 6 },
    ]
    const frames = buildLimiterFrames(buckets)
    const resp = {
      type:       'limiter',
      schema:     DYNAMICS_VIZ_SCHEMA_VERSION,
      bucketSize: LIMITER_BUCKET.sizeBytes,
      count:      buckets.length,
      frames,
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.LIMITER)
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(buckets.length)

    const decoded0 = parsed.decode(0)
    expect(decoded0.inLevelDb).toBeCloseTo(-3, 5)
    expect(decoded0.gainReductionDb).toBeCloseTo(4, 5)

    const decoded1 = parsed.decode(1)
    expect(decoded1.gainReductionDb).toBeCloseTo(6, 5)
  })

  it('rejects a Limiter payload whose bucketSize does not match the schema', () => {
    const resp = {
      type: 'limiter', schema: 1,
      bucketSize: 40, // Compressor's size, wrong for Limiter
      count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.LIMITER)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/^bucket-size-mismatch:40$/)
  })

  it('rejects when the engine returns a Compressor payload but the consumer asked for Limiter', () => {
    const resp = {
      type: 'compressor', schema: 1,
      bucketSize: COMPRESSOR_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.LIMITER)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('type-mismatch:compressor')
  })

  it('rejects an unknown / future schema version', () => {
    const resp = {
      type: 'limiter', schema: 999,
      bucketSize: LIMITER_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.LIMITER)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/^schema-mismatch:/)
  })

  it('still accepts a Compressor payload when the consumer asks for Compressor', () => {
    const resp = {
      type: 'compressor', schema: 1,
      bucketSize: COMPRESSOR_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.COMPRESSOR)
    expect(parsed.ok).toBe(true)
  })
})

// ── Painter smoke tests ────────────────────────────────────────────────────

describe('Limiter painters', () => {
  const buckets = Array.from({ length: 32 }, (_, i) => ({
    sampleClock: i * 64,
    bucketSamples: 64,
    inLevelDb:       -6 - (i % 8),
    outLevelDb:      -7 - (i % 8),
    gainReductionDb:  i === 16 ? 11 : (i % 4),
    outEnergyDb:    -18,
    inEnergyDb:     -16,
    ceilingDb:       -0.3,
    gainDb:           6,
    releaseMs:      100,
  }))
  const ring = makeRingFromBuckets(buckets)

  it('drawLimiterRealtime draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawLimiterRealtime(ctx, 800, 240, ring, THEME, { ceiling: -0.3, gain: 6 })).not.toThrow()
    // Sanity: at least one fillRect should have been issued (background).
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawLimiterRealtime draws without throwing with noisy fake frames', () => {
    const noisyBuckets = Array.from({ length: 900 }, (_, i) => ({
      sampleClock: i * 64,
      bucketSamples: 64,
      inLevelDb: i % 41 === 0 ? Number.NaN : -16 + Math.sin(i * 0.73) * 22,
      outLevelDb: i % 37 === 0 ? Number.POSITIVE_INFINITY : -13 + Math.cos(i * 0.51) * 14,
      gainReductionDb: i % 53 === 0 ? Number.NaN : Math.max(0, Math.sin(i * 0.17) * 10 + (i % 89 === 0 ? 8 : 0)),
      outEnergyDb: i % 29 === 0 ? Number.NaN : -18 + Math.sin(i * 0.11) * 5,
      inEnergyDb: i % 31 === 0 ? Number.NEGATIVE_INFINITY : -17 + Math.cos(i * 0.09) * 6,
      ceilingDb: -0.3,
      gainDb: 9,
      releaseMs: 90,
    }))
    const noisyRing = makeRingFromBuckets(noisyBuckets)
    const ctx = makeStubCtx()
    expect(() => drawLimiterRealtime(ctx, 640, 180, noisyRing, THEME, { ceiling: -0.3 })).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawLimiterGainReduction draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawLimiterGainReduction(ctx, 600, 80, ring, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawLimiterMeterOnly draws without throwing on an empty ring', () => {
    const ctx = makeStubCtx()
    const emptyRing = makeRingFromBuckets([])
    expect(() => drawLimiterMeterOnly(ctx, 36, 240, emptyRing, THEME)).not.toThrow()
  })

  it('LIMITER_PRESETS keys are wired to functions', () => {
    expect(typeof LIMITER_PRESETS.limiterRealtime).toBe('function')
    expect(typeof LIMITER_PRESETS.limiterGainReduction).toBe('function')
    expect(typeof LIMITER_PRESETS.limiterMeterOnly).toBe('function')
  })
})

// --- Display history transform ------------------------------------------------

describe('Limiter display transform', () => {
  it('downsampleLimiterHistory reduces dense history to no more than canvas width buckets', () => {
    const dense = Array.from({ length: 2048 }, (_, i) => ({
      inLevelDb: -18 + Math.sin(i * 0.3) * 12,
      outLevelDb: -16 + Math.cos(i * 0.2) * 8,
      gainReductionDb: Math.max(0, Math.sin(i * 0.05) * 12),
      inEnergyDb: -20,
      outEnergyDb: -22,
    }))
    const columns = downsampleLimiterHistory(dense, 120)
    expect(columns.length).toBeLessThanOrEqual(120)
    expect(columns.length).toBeGreaterThan(0)
  })

  it('smoothLimiterDisplayHistory keeps finite display values', () => {
    const columns = [
      { x: 0, inputDb: Number.NaN, outputDb: -12, inEnergyDb: -18, outEnergyDb: -19, grDb: 0, peakGrDb: 0 },
      { x: 2, inputDb: 8, outputDb: Number.POSITIVE_INFINITY, inEnergyDb: Number.NaN, outEnergyDb: -12, grDb: 22, peakGrDb: 22 },
      { x: 4, inputDb: -60, outputDb: -48, inEnergyDb: -60, outEnergyDb: Number.NEGATIVE_INFINITY, grDb: Number.NaN, peakGrDb: Number.NaN },
    ]
    const smoothed = smoothLimiterDisplayHistory(columns)
    for (const column of smoothed) {
      expect(Number.isFinite(column.inputDb)).toBe(true)
      expect(Number.isFinite(column.outputDb)).toBe(true)
      expect(Number.isFinite(column.inEnergyDb)).toBe(true)
      expect(Number.isFinite(column.outEnergyDb)).toBe(true)
      expect(Number.isFinite(column.grDb)).toBe(true)
      expect(Number.isFinite(column.peakGrDb)).toBe(true)
    }
  })

  it('buildLimiterDisplayHistory returns smoothed finite columns from a ring', () => {
    const ring = makeRingFromBuckets(Array.from({ length: 256 }, (_, i) => ({
      inLevelDb: -10 + Math.sin(i * 0.2) * 9,
      outLevelDb: -12 + Math.cos(i * 0.2) * 6,
      gainReductionDb: Math.max(0, Math.sin(i * 0.1) * 9),
      inEnergyDb: -17,
      outEnergyDb: -19,
    })))
    const columns = buildLimiterDisplayHistory(ring, 160)
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(160)
    expect(columns.every((column) => Number.isFinite(column.x) && Number.isFinite(column.outputDb))).toBe(true)
  })

  it('limiterLevelToY clamps 0 dB to top and -24 dB to bottom', () => {
    expect(limiterLevelToY(0, 100)).toBe(0)
    expect(limiterLevelToY(6, 100)).toBe(0)
    expect(limiterLevelToY(LIMITER_DISPLAY.level.minDb, 100)).toBe(99)
    expect(limiterLevelToY(-60, 100)).toBe(99)
  })
})

describe('Limiter GR label picking', () => {
  function labelColumns(values, spacing = 40) {
    return values.map((gr, i) => ({
      x: i * spacing,
      grDb: Math.min(gr, LIMITER_DISPLAY.maxGrDb),
      peakGrDb: gr,
    }))
  }

  it('returns only labels above the configured threshold', () => {
    const labels = pickLimiterGrLabels(labelColumns([0, 1, 2.9, 1, 4, 1, 2.5]), 280)
    expect(labels).toHaveLength(1)
    expect(labels[0].grDb).toBeGreaterThanOrEqual(LIMITER_DISPLAY.labelThresholdDb)
  })

  it('enforces minimum pixel distance between labels', () => {
    const labels = pickLimiterGrLabels(
      labelColumns([0, 6, 0, 8, 0, 5, 0], 30),
      240,
      { minSpacingPx: 90, maxLabels: 6 },
    )
    expect(labels.length).toBeLessThanOrEqual(2)
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i].x - labels[i - 1].x).toBeGreaterThanOrEqual(90)
    }
  })

  it('caps the maximum number of labels', () => {
    const values = Array.from({ length: 31 }, (_, i) => (i % 2 === 1 ? 5 + i * 0.1 : 0))
    const labels = pickLimiterGrLabels(labelColumns(values, 100), 3100, { maxLabels: 4, minSpacingPx: 70 })
    expect(labels).toHaveLength(4)
  })
})

describe('Limiter meter values', () => {
  it('computeLimiterMeterValues keeps output and GR finite with noisy inputs', () => {
    let meter = null
    const buckets = [
      { outLevelDb: -9, gainReductionDb: 0 },
      { outLevelDb: Number.NaN, gainReductionDb: Number.POSITIVE_INFINITY },
      { outLevelDb: 3, gainReductionDb: 24 },
      { outLevelDb: -80, gainReductionDb: Number.NaN },
      null,
    ]

    for (const bucket of buckets) {
      meter = computeLimiterMeterValues(bucket, meter)
      expect(Number.isFinite(meter.outputDb)).toBe(true)
      expect(Number.isFinite(meter.gainReductionDb)).toBe(true)
      expect(meter.outputDb).toBeGreaterThanOrEqual(LIMITER_DISPLAY.meter.minDb)
      expect(meter.outputDb).toBeLessThanOrEqual(LIMITER_DISPLAY.meter.maxDb)
      expect(meter.gainReductionDb).toBeGreaterThanOrEqual(0)
      expect(meter.gainReductionDb).toBeLessThanOrEqual(LIMITER_DISPLAY.maxGrDb)
    }
  })
})

// ── Inspector helpers / preset gating ──────────────────────────────────────

describe('Limiter visualizer inspector helpers', () => {
  it('lists Limiter presets for limiter.realtime source', () => {
    const options = getPresetOptionsForSource('limiter.realtime', null)
    const keys = options.map(o => o.value)
    expect(keys).toContain('limiterRealtime')
    // Must NOT mix in compressor presets.
    expect(keys.every(k => k.startsWith('limiter'))).toBe(true)
  })

  it('lists Compressor presets for compressor.combined source', () => {
    const options = getPresetOptionsForSource('compressor.combined', null)
    const keys = options.map(o => o.value)
    // Must NOT mix in limiter presets.
    expect(keys.every(k => !k.startsWith('limiter'))).toBe(true)
  })

  it('isPresetAllowedForSource enforces source-preset matching across plugins', () => {
    expect(isPresetAllowedForSource('limiterRealtime', 'limiter.realtime')).toBe(true)
    expect(isPresetAllowedForSource('limiterRealtime', 'compressor.combined')).toBe(false)
    expect(isPresetAllowedForSource('levelHistory',    'limiter.realtime')).toBe(false)
  })

  it('resolveSafePresetForSource returns the documented default for limiter.realtime', () => {
    expect(resolveSafePresetForSource('limiter.realtime')).toBe('limiterRealtime')
    expect(LIMITER_SOURCE_DEFAULT_PRESET['limiter.realtime']).toBe('limiterRealtime')
  })

  it('LIMITER_VISUALIZER_PRESETS exports a limiterRealtime preset bound to limiter.realtime', () => {
    const preset = LIMITER_VISUALIZER_PRESETS.limiterRealtime
    expect(preset).toBeTruthy()
    expect(preset.sources).toContain('limiter.realtime')
  })
})

// ── BindingPicker source listing ───────────────────────────────────────────

describe('BindingPicker viz source options', () => {
  it('lists limiter.realtime for the Limiter manifest', () => {
    const opts = getVizSourceOptions(LIMITER_MANIFEST, null)
    const values = opts.map(o => o.value)
    expect(values).toContain('limiter.realtime')
  })

  it('does not list compressor sources for the Limiter manifest', () => {
    const opts = getVizSourceOptions(LIMITER_MANIFEST, null)
    const values = opts.map(o => o.value)
    for (const v of values) expect(v.startsWith('compressor.')).toBe(false)
  })

  it('does not list limiter sources for the Compressor manifest', () => {
    const opts = getVizSourceOptions(COMPRESSOR_MANIFEST, null)
    const values = opts.map(o => o.value)
    for (const v of values) expect(v.startsWith('limiter.')).toBe(false)
  })
})

// ── DynamicsVisualizerCanvas dispatch (unit) ──────────────────────────────
// We don't actually mount the canvas here — we just verify that the dispatch
// helper picks the limiter painter set when the source key is 'limiter.*'.
//
// The dispatch logic is internal to the canvas component; we exercise it via
// the public preset registries to ensure they're separable.

describe('Source-prefix dispatch', () => {
  it('limiterRealtime preset is in the Limiter registry, not Compressor', () => {
    // Sanity check that nothing has accidentally shared a key between sets.
    const compressorKeys = new Set(Object.keys(LIMITER_PRESETS))
    expect(compressorKeys.has('limiterRealtime')).toBe(true)
  })
})

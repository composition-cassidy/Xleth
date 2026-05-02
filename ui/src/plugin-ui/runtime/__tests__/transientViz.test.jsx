// Tests for the Transient Processor visualization pipeline:
//   • Bucket parser (parseDrainResponse) accepts Transient payloads and
//     rejects wrong type / wrong bucket size / wrong schema.
//   • Painter functions render against fake frames without throwing.
//   • Visualizer dispatch routes transient.* sources through the transient
//     painter set (and not Compressor / Limiter).
//   • VisualizerInspector source options include 'transient.shaper' for the
//     Transient manifest, and do not include Compressor / Limiter sources.

import { describe, expect, it, vi } from 'vitest'

import {
  DYNAMICS_VIZ_SCHEMA_VERSION,
  TRANSIENT_BUCKET,
  LIMITER_BUCKET,
  COMPRESSOR_BUCKET,
  VIZ_TYPE,
  parseDrainResponse,
} from '../../../constants/dynamicsViz.js'
import {
  TRANSIENT_DISPLAY,
  TRANSIENT_PRESETS,
  TRANSIENT_VISUALIZER_PRESETS,
  TRANSIENT_SOURCE_DEFAULT_PRESET,
  buildTransientDisplayHistory,
  computeTransientMeterValues,
  downsampleTransientHistory,
  drawTransientShaper,
  drawTransientEnvelope,
  drawTransientGainChange,
  smoothTransientDisplayHistory,
  transientLevelToY,
  transientGainToY,
} from '../visualizers/transientPainter.js'
import {
  getPresetOptionsForSource,
  isPresetAllowedForSource,
  resolveSafePresetForSource,
} from '../../designer/inspectors/inspectorHelpers.js'
import { TRANSIENT_MANIFEST } from '../../manifests/transient.js'
import { LIMITER_MANIFEST } from '../../manifests/limiter.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { getVizSourceOptions } from '../../designer/BindingPicker.jsx'

// ── Helpers ────────────────────────────────────────────────────────────────

function buildTransientFrames(buckets) {
  const buf = new ArrayBuffer(buckets.length * TRANSIENT_BUCKET.sizeBytes)
  const view = new DataView(buf)
  buckets.forEach((b, i) => {
    const base = i * TRANSIENT_BUCKET.sizeBytes
    view.setBigUint64(base + TRANSIENT_BUCKET.fields.sampleClock.offset,   BigInt(b.sampleClock ?? 0), true)
    view.setUint32(   base + TRANSIENT_BUCKET.fields.bucketSamples.offset, b.bucketSamples ?? 64,      true)
    view.setUint32(   base + TRANSIENT_BUCKET.fields.flags.offset,         b.flags ?? 0,               true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.inLevelDb.offset,     b.inLevelDb ?? -12,         true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.outLevelDb.offset,    b.outLevelDb ?? -12,        true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.fastEnvDb.offset,     b.fastEnvDb ?? -14,         true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.slowEnvDb.offset,     b.slowEnvDb ?? -18,         true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.gainDb.offset,        b.gainDb ?? 0,              true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.attackAmount.offset,  b.attackAmount ?? 0,        true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.sustainAmount.offset, b.sustainAmount ?? 0,       true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.speedMs.offset,       b.speedMs ?? 5,             true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.thresholdDb.offset,   b.thresholdDb ?? -60,       true)
    view.setFloat32(  base + TRANSIENT_BUCKET.fields.mix.offset,           b.mix ?? 1,                 true)
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

// ── parseDrainResponse for Transient ───────────────────────────────────────

describe('Transient parser (parseDrainResponse)', () => {
  it('accepts a well-formed Transient drain payload', () => {
    const buckets = [
      { sampleClock: 64,  bucketSamples: 64, inLevelDb: -10, outLevelDb: -8,  gainDb:  4, fastEnvDb: -6,  slowEnvDb: -14 },
      { sampleClock: 128, bucketSamples: 64, inLevelDb: -12, outLevelDb: -14, gainDb: -3, fastEnvDb: -10, slowEnvDb: -12 },
    ]
    const frames = buildTransientFrames(buckets)
    const resp = {
      type:       'transient',
      schema:     DYNAMICS_VIZ_SCHEMA_VERSION,
      bucketSize: TRANSIENT_BUCKET.sizeBytes,
      count:      buckets.length,
      frames,
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.TRANSIENT)
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(buckets.length)

    const decoded0 = parsed.decode(0)
    expect(decoded0.inLevelDb).toBeCloseTo(-10, 5)
    expect(decoded0.gainDb).toBeCloseTo(4, 5)
    expect(decoded0.fastEnvDb).toBeCloseTo(-6, 5)

    const decoded1 = parsed.decode(1)
    expect(decoded1.gainDb).toBeCloseTo(-3, 5)
  })

  it('rejects a Transient payload whose bucketSize does not match the schema', () => {
    const resp = {
      type: 'transient', schema: 1,
      bucketSize: 40, // Compressor's size, wrong for Transient
      count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.TRANSIENT)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/^bucket-size-mismatch:40$/)
  })

  it('rejects when the engine returns a Limiter payload but consumer asked for Transient', () => {
    const resp = {
      type: 'limiter', schema: 1,
      bucketSize: LIMITER_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.TRANSIENT)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('type-mismatch:limiter')
  })

  it('rejects when the engine returns a Compressor payload but consumer asked for Transient', () => {
    const resp = {
      type: 'compressor', schema: 1,
      bucketSize: COMPRESSOR_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.TRANSIENT)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('type-mismatch:compressor')
  })

  it('rejects an unknown / future schema version', () => {
    const resp = {
      type: 'transient', schema: 999,
      bucketSize: TRANSIENT_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.TRANSIENT)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/^schema-mismatch:/)
  })

  it('still accepts a Compressor payload when the consumer asks for Compressor (no regression)', () => {
    const resp = {
      type: 'compressor', schema: 1,
      bucketSize: COMPRESSOR_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.COMPRESSOR)
    expect(parsed.ok).toBe(true)
  })

  it('still accepts a Limiter payload when the consumer asks for Limiter (no regression)', () => {
    const resp = {
      type: 'limiter', schema: 1,
      bucketSize: LIMITER_BUCKET.sizeBytes, count: 0, frames: new ArrayBuffer(0),
    }
    const parsed = parseDrainResponse(resp, VIZ_TYPE.LIMITER)
    expect(parsed.ok).toBe(true)
  })
})

// ── Painter smoke tests ────────────────────────────────────────────────────

describe('Transient painters', () => {
  const buckets = Array.from({ length: 32 }, (_, i) => ({
    sampleClock: i * 64,
    bucketSamples: 64,
    inLevelDb:   -10 - (i % 6),
    outLevelDb:  -10 - (i % 6),
    fastEnvDb:   -8 - (i % 4),
    slowEnvDb:   -16 - (i % 5),
    gainDb:       i % 7 === 0 ?  6 : (i % 11 === 0 ? -4 : 0),
    attackAmount: 0.4,
    sustainAmount: -0.2,
    speedMs:     5,
    thresholdDb: -60,
    mix:         1,
  }))
  const ring = makeRingFromBuckets(buckets)

  it('drawTransientShaper draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawTransientShaper(ctx, 760, 240, ring, THEME, { threshold: -30 })).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawTransientShaper draws without throwing on a noisy 900-bucket ring with NaN/Inf', () => {
    const noisyBuckets = Array.from({ length: 900 }, (_, i) => ({
      sampleClock: i * 64,
      bucketSamples: 64,
      inLevelDb:    i % 41 === 0 ? Number.NaN : -16 + Math.sin(i * 0.73) * 22,
      outLevelDb:   i % 37 === 0 ? Number.POSITIVE_INFINITY : -13 + Math.cos(i * 0.51) * 14,
      fastEnvDb:    i % 29 === 0 ? Number.NaN : -10 + Math.sin(i * 0.17) * 9,
      slowEnvDb:    i % 31 === 0 ? Number.NEGATIVE_INFINITY : -16 + Math.cos(i * 0.09) * 6,
      gainDb:       i % 53 === 0 ? Number.NaN : Math.sin(i * 0.05) * 12,
    }))
    const noisyRing = makeRingFromBuckets(noisyBuckets)
    const ctx = makeStubCtx()
    expect(() => drawTransientShaper(ctx, 640, 180, noisyRing, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawTransientShaper draws without throwing in MIDI mode (envelopes are NaN)', () => {
    // In MIDI mode the engine emits NaN for fastEnvDb / slowEnvDb. The painter
    // must skip the envelope layer rather than crash.
    const midiBuckets = Array.from({ length: 64 }, (_, i) => ({
      sampleClock: i * 64,
      bucketSamples: 64,
      inLevelDb:  -8 - (i % 4),
      outLevelDb: -8 - (i % 4),
      fastEnvDb: Number.NaN,
      slowEnvDb: Number.NaN,
      gainDb: i % 8 === 0 ? 6 : 0,
    }))
    const midiRing = makeRingFromBuckets(midiBuckets)
    const ctx = makeStubCtx()
    expect(() => drawTransientShaper(ctx, 600, 240, midiRing, THEME)).not.toThrow()
  })

  it('drawTransientEnvelope draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawTransientEnvelope(ctx, 600, 120, ring, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawTransientGainChange draws without throwing on an empty ring', () => {
    const ctx = makeStubCtx()
    const emptyRing = makeRingFromBuckets([])
    expect(() => drawTransientGainChange(ctx, 400, 120, emptyRing, THEME)).not.toThrow()
  })

  it('TRANSIENT_PRESETS keys are wired to functions', () => {
    expect(typeof TRANSIENT_PRESETS.transientShaper).toBe('function')
    expect(typeof TRANSIENT_PRESETS.transientEnvelope).toBe('function')
    expect(typeof TRANSIENT_PRESETS.transientGainChange).toBe('function')
  })
})

// ── Display history transform ──────────────────────────────────────────────

describe('Transient display transform', () => {
  it('downsampleTransientHistory reduces dense history to no more than canvas-width buckets', () => {
    const dense = Array.from({ length: 2048 }, (_, i) => ({
      inLevelDb: -16 + Math.sin(i * 0.3) * 12,
      outLevelDb: -16 + Math.cos(i * 0.3) * 12,
      fastEnvDb: -14 + Math.sin(i * 0.2) * 8,
      slowEnvDb: -22 + Math.cos(i * 0.1) * 4,
      gainDb: Math.sin(i * 0.05) * 8,
    }))
    const columns = downsampleTransientHistory(dense, 120)
    expect(columns.length).toBeLessThanOrEqual(120)
    expect(columns.length).toBeGreaterThan(0)
  })

  it('smoothTransientDisplayHistory keeps finite display values', () => {
    const columns = [
      { x: 0, inputDb: Number.NaN, outputDb: -12, fastEnvDb: -16, slowEnvDb: -18, gainDb: 0,                     boostDb: 0,  cutDb: 0 },
      { x: 2, inputDb: 8,           outputDb: Number.POSITIVE_INFINITY, fastEnvDb: Number.NaN, slowEnvDb: -12, gainDb: 22, boostDb: 22, cutDb: 0 },
      { x: 4, inputDb: -60,         outputDb: -48, fastEnvDb: -60,             slowEnvDb: Number.NEGATIVE_INFINITY, gainDb: Number.NaN, boostDb: 0, cutDb: -22 },
    ]
    const smoothed = smoothTransientDisplayHistory(columns)
    for (const column of smoothed) {
      expect(Number.isFinite(column.inputDb)).toBe(true)
      expect(Number.isFinite(column.outputDb)).toBe(true)
      expect(Number.isFinite(column.fastEnvDb)).toBe(true)
      expect(Number.isFinite(column.slowEnvDb)).toBe(true)
      expect(Number.isFinite(column.gainDb)).toBe(true)
    }
  })

  it('buildTransientDisplayHistory returns smoothed finite columns from a ring', () => {
    const ring = makeRingFromBuckets(Array.from({ length: 256 }, (_, i) => ({
      inLevelDb:  -10 + Math.sin(i * 0.2) * 9,
      outLevelDb: -12 + Math.cos(i * 0.2) * 6,
      fastEnvDb:  -8 + Math.sin(i * 0.1) * 5,
      slowEnvDb:  -16 + Math.cos(i * 0.1) * 4,
      gainDb:     Math.sin(i * 0.05) * 8,
    })))
    const columns = buildTransientDisplayHistory(ring, 160)
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(160)
    expect(columns.every((c) => Number.isFinite(c.x) && Number.isFinite(c.outputDb) && Number.isFinite(c.gainDb))).toBe(true)
  })

  it('transientLevelToY clamps 0 dB to top and minDb to bottom', () => {
    expect(transientLevelToY(0, 100)).toBe(0)
    expect(transientLevelToY(6, 100)).toBe(0)
    expect(transientLevelToY(TRANSIENT_DISPLAY.level.minDb, 100)).toBe(99)
    expect(transientLevelToY(-200, 100)).toBe(99)
  })

  it('transientGainToY centers at h/2 for 0 dB, top for +max, bottom for -max', () => {
    const { maxGainDb } = TRANSIENT_DISPLAY.gainChange
    expect(transientGainToY(0, 100)).toBeGreaterThanOrEqual(48)
    expect(transientGainToY(0, 100)).toBeLessThanOrEqual(50)
    expect(transientGainToY(maxGainDb, 100)).toBe(0)
    expect(transientGainToY(-maxGainDb, 100)).toBe(99)
  })
})

describe('Transient meter values', () => {
  it('computeTransientMeterValues keeps gainDb finite and clamped through noisy inputs', () => {
    let meter = null
    const buckets = [
      { outLevelDb: -9,          gainDb: 0 },
      { outLevelDb: Number.NaN,  gainDb: Number.POSITIVE_INFINITY },
      { outLevelDb: 3,           gainDb: 24 },
      { outLevelDb: -80,         gainDb: Number.NaN },
      { outLevelDb: -10,         gainDb: -42 },
      null,
    ]
    const { maxGainDb } = TRANSIENT_DISPLAY.gainChange
    for (const bucket of buckets) {
      meter = computeTransientMeterValues(bucket, meter)
      expect(Number.isFinite(meter.outputDb)).toBe(true)
      expect(Number.isFinite(meter.gainDb)).toBe(true)
      expect(meter.outputDb).toBeGreaterThanOrEqual(TRANSIENT_DISPLAY.level.minDb)
      expect(meter.outputDb).toBeLessThanOrEqual(TRANSIENT_DISPLAY.level.maxDb)
      expect(meter.gainDb).toBeGreaterThanOrEqual(-maxGainDb)
      expect(meter.gainDb).toBeLessThanOrEqual(maxGainDb)
    }
  })
})

// ── Inspector helpers / preset gating ──────────────────────────────────────

describe('Transient visualizer inspector helpers', () => {
  it('lists Transient presets for transient.shaper source', () => {
    const options = getPresetOptionsForSource('transient.shaper', null)
    const keys = options.map(o => o.value)
    expect(keys).toContain('transientShaper')
    // Must NOT mix in compressor or limiter presets.
    expect(keys.every(k => k.startsWith('transient'))).toBe(true)
  })

  it('lists Limiter presets for limiter.realtime source (no leak)', () => {
    const options = getPresetOptionsForSource('limiter.realtime', null)
    const keys = options.map(o => o.value)
    expect(keys.every(k => !k.startsWith('transient'))).toBe(true)
  })

  it('isPresetAllowedForSource enforces source-preset matching across plugins', () => {
    expect(isPresetAllowedForSource('transientShaper', 'transient.shaper')).toBe(true)
    expect(isPresetAllowedForSource('transientShaper', 'limiter.realtime')).toBe(false)
    expect(isPresetAllowedForSource('transientShaper', 'compressor.combined')).toBe(false)
    expect(isPresetAllowedForSource('limiterRealtime', 'transient.shaper')).toBe(false)
    expect(isPresetAllowedForSource('levelHistory',    'transient.shaper')).toBe(false)
  })

  it('resolveSafePresetForSource returns the documented default for transient.shaper', () => {
    expect(resolveSafePresetForSource('transient.shaper')).toBe('transientShaper')
    expect(TRANSIENT_SOURCE_DEFAULT_PRESET['transient.shaper']).toBe('transientShaper')
  })

  it('TRANSIENT_VISUALIZER_PRESETS exports a transientShaper preset bound to transient.shaper', () => {
    const preset = TRANSIENT_VISUALIZER_PRESETS.transientShaper
    expect(preset).toBeTruthy()
    expect(preset.sources).toContain('transient.shaper')
  })
})

// ── BindingPicker source listing ───────────────────────────────────────────

describe('BindingPicker viz source options for Transient', () => {
  it('lists transient.shaper for the Transient manifest', () => {
    const opts = getVizSourceOptions(TRANSIENT_MANIFEST, null)
    const values = opts.map(o => o.value)
    expect(values).toContain('transient.shaper')
  })

  it('does not list compressor / limiter sources for the Transient manifest', () => {
    const opts = getVizSourceOptions(TRANSIENT_MANIFEST, null)
    const values = opts.map(o => o.value)
    for (const v of values) {
      expect(v.startsWith('compressor.')).toBe(false)
      expect(v.startsWith('limiter.')).toBe(false)
    }
  })

  it('does not list transient sources for the Compressor manifest', () => {
    const opts = getVizSourceOptions(COMPRESSOR_MANIFEST, null)
    const values = opts.map(o => o.value)
    for (const v of values) expect(v.startsWith('transient.')).toBe(false)
  })

  it('does not list transient sources for the Limiter manifest', () => {
    const opts = getVizSourceOptions(LIMITER_MANIFEST, null)
    const values = opts.map(o => o.value)
    for (const v of values) expect(v.startsWith('transient.')).toBe(false)
  })
})

// ── Source-prefix dispatch ────────────────────────────────────────────────

describe('Transient source-prefix dispatch', () => {
  it('transientShaper preset is in the Transient registry, not Compressor/Limiter', () => {
    const transientKeys = new Set(Object.keys(TRANSIENT_PRESETS))
    expect(transientKeys.has('transientShaper')).toBe(true)
    expect(transientKeys.has('limiterRealtime')).toBe(false)
    expect(transientKeys.has('levelHistory')).toBe(false)
  })
})

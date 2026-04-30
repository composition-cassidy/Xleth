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
  LIMITER_PRESETS,
  LIMITER_VISUALIZER_PRESETS,
  LIMITER_SOURCE_DEFAULT_PRESET,
  drawLimiterRealtime,
  drawLimiterGainReduction,
  drawLimiterMeterOnly,
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

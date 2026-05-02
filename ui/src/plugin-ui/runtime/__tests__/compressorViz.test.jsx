// Tests for the Compressor visualization pipeline:
//   • Painter functions render against fake frames without throwing.
//   • Display history transform downsamples and smooths predictably.
//   • Transfer-curve geometry / threshold marker / knee region / live dot
//     return finite, in-range coordinates.
//   • Meter values stay finite and clamped.
//   • Preset registries keep the back-compat aliases (compressorCombined →
//     same painter as compressorCombinedV2) so saved layouts still render.
//   • Compressor layout JSON parses and references known presets.

import { describe, expect, it, vi } from 'vitest'

import compressorLayout from '../../layouts/compressor.json'
import {
  COMPRESSOR_DISPLAY,
  COMPRESSOR_PRESETS,
  COMPRESSOR_VISUALIZER_PRESETS,
  COMPRESSOR_SOURCE_DEFAULT_PRESET,
  buildCompressorDisplayHistory,
  computeCompressorMeterValues,
  computeKneeRegion,
  computeLiveDetectorPoint,
  computeThresholdMarker,
  computeTransferCurvePoints,
  compressorGrToY,
  compressorLevelToY,
  compressorTransferXForDb,
  compressorTransferYForDb,
  downsampleCompressorHistory,
  drawCompressorBackground,
  drawCompressorCombinedV2,
  drawCompressorEnvelopeHistory,
  drawCompressorGainReductionActivity,
  drawCompressorLabels,
  drawCompressorMeters,
  drawDetector,
  drawEnvelopeHistory,
  drawGainReductionActivity,
  drawGainReductionStrip,
  drawLevelHistory,
  drawLiveDetectorDot,
  drawTransferCurve,
  drawTransferCurveLive,
  formatCompressorGrReadout,
  smoothCompressorHistory,
} from '../visualizers/compressorPainter.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  accent:    '#7dd3fc',
  accentDim: '#1f6f8e',
})

const PARAMS = Object.freeze({
  threshold: -18,
  ratio: 4,
  knee: 6,
  makeup: 2,
  mix: 100,
  attack: 5,
  release: 100,
})

function buildBuckets(n, opts = {}) {
  const { withGr = true, noisy = false } = opts
  return Array.from({ length: n }, (_, i) => {
    const t = i / Math.max(1, n)
    const inLevelDb = -16 + Math.sin(t * Math.PI * 4) * 14
    const grDb = withGr ? Math.max(0, Math.sin(t * Math.PI * 3) * 9 + (i % 31 === 0 ? 5 : 0)) : 0
    const outLevelDb = inLevelDb - grDb
    return {
      sampleClock: i * 64,
      bucketSamples: 64,
      flags: 0,
      inLevelDb:   noisy && i % 41 === 0 ? Number.NaN : inLevelDb,
      outLevelDb:  noisy && i % 37 === 0 ? Number.POSITIVE_INFINITY : outLevelDb,
      detectorDb:  noisy && i % 29 === 0 ? Number.NEGATIVE_INFINITY : inLevelDb - 1,
      grDb:        noisy && i % 53 === 0 ? Number.NaN : grDb,
      ioInDb:      inLevelDb,
      ioOutDb:     outLevelDb,
    }
  })
}

// ── Painter smoke tests ─────────────────────────────────────────────────────

describe('Compressor painters', () => {
  const ring = makeRingFromBuckets(buildBuckets(64))
  const noisyRing = makeRingFromBuckets(buildBuckets(900, { noisy: true }))
  const emptyRing = makeRingFromBuckets([])

  it('drawLevelHistory draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawLevelHistory(ctx, 480, 90, ring, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawGainReductionStrip draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawGainReductionStrip(ctx, 480, 60, ring, THEME)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawDetector draws without throwing on empty ring', () => {
    const ctx = makeStubCtx()
    expect(() => drawDetector(ctx, 200, 80, emptyRing, THEME)).not.toThrow()
  })

  it('drawTransferCurveLive draws without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawTransferCurveLive(ctx, 220, 220, ring, THEME, PARAMS)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawCompressorCombinedV2 draws in wide mode without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawCompressorCombinedV2(ctx, 520, 180, ring, THEME, PARAMS)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawCompressorCombinedV2 draws in stacked mode without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawCompressorCombinedV2(ctx, 200, 220, ring, THEME, PARAMS)).not.toThrow()
  })

  it('drawCompressorCombinedV2 draws with noisy 900-bucket ring without throwing', () => {
    const ctx = makeStubCtx()
    expect(() => drawCompressorCombinedV2(ctx, 480, 180, noisyRing, THEME, PARAMS)).not.toThrow()
  })

  it('drawCompressorCombinedV2 draws with no params and no ring', () => {
    const ctx = makeStubCtx()
    expect(() => drawCompressorCombinedV2(ctx, 480, 180, emptyRing, THEME, null)).not.toThrow()
  })

  it('section painters draw without throwing', () => {
    const ctx = makeStubCtx()
    const columns = buildCompressorDisplayHistory(ring, 200)
    expect(() => drawCompressorBackground(ctx, 0, 0, 100, 50, THEME)).not.toThrow()
    expect(() => drawTransferCurve(ctx, 0, 0, 160, 160, THEME, PARAMS)).not.toThrow()
    expect(() => drawLiveDetectorDot(ctx, 0, 0, 160, 160, ring, PARAMS)).not.toThrow()
    expect(() => drawEnvelopeHistory(ctx, 0, 0, 220, 80, columns, THEME)).not.toThrow()
    expect(() => drawGainReductionActivity(ctx, 0, 0, 220, 60, columns, THEME)).not.toThrow()
    expect(() => drawCompressorMeters(ctx, 0, 0, 50, 160, ring, THEME)).not.toThrow()
    expect(() => drawCompressorLabels(ctx, 0, 0, 220, 80, ring, THEME, PARAMS)).not.toThrow()
    expect(() => drawCompressorEnvelopeHistory(ctx, 480, 90, ring, THEME)).not.toThrow()
    expect(() => drawCompressorGainReductionActivity(ctx, 480, 60, ring, THEME)).not.toThrow()
  })
})

// ── Display history transform ───────────────────────────────────────────────

describe('Compressor display transform', () => {
  it('downsampleCompressorHistory reduces dense history to <= canvas width buckets', () => {
    const dense = buildBuckets(2048)
    const columns = downsampleCompressorHistory(dense, 120)
    expect(columns.length).toBeLessThanOrEqual(120)
    expect(columns.length).toBeGreaterThan(0)
  })

  it('downsampleCompressorHistory honours columnWidthPx option', () => {
    const dense = buildBuckets(1500)
    const columns = downsampleCompressorHistory(dense, 200, { columnWidthPx: 4 })
    expect(columns.length).toBeLessThanOrEqual(50)
  })

  it('smoothCompressorHistory keeps finite display values for noisy input', () => {
    const columns = [
      { x: 0, inputDb: Number.NaN, outputDb: -12, detectorDb: -16, grDb: 0, peakGrDb: 0 },
      { x: 2, inputDb: 8, outputDb: Number.POSITIVE_INFINITY, detectorDb: Number.NaN, grDb: 22, peakGrDb: 22 },
      { x: 4, inputDb: -60, outputDb: -48, detectorDb: -60, grDb: Number.NaN, peakGrDb: Number.NaN },
    ]
    const smoothed = smoothCompressorHistory(columns)
    for (const c of smoothed) {
      expect(Number.isFinite(c.inputDb)).toBe(true)
      expect(Number.isFinite(c.outputDb)).toBe(true)
      expect(Number.isFinite(c.detectorDb)).toBe(true)
      expect(Number.isFinite(c.grDb)).toBe(true)
      expect(Number.isFinite(c.peakGrDb)).toBe(true)
    }
  })

  it('smoothCompressorHistory clamps GR to 0..maxGrDb', () => {
    const columns = Array.from({ length: 30 }, () => ({
      x: 0, inputDb: -8, outputDb: -10, detectorDb: -12, grDb: 99, peakGrDb: 99,
    }))
    const smoothed = smoothCompressorHistory(columns)
    for (const c of smoothed) {
      expect(c.grDb).toBeGreaterThanOrEqual(0)
      expect(c.grDb).toBeLessThanOrEqual(COMPRESSOR_DISPLAY.gr.maxGrDb)
    }
  })

  it('buildCompressorDisplayHistory returns smoothed finite columns from a ring', () => {
    const ring = makeRingFromBuckets(buildBuckets(256))
    const columns = buildCompressorDisplayHistory(ring, 160)
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(160)
    expect(columns.every((c) => Number.isFinite(c.x) && Number.isFinite(c.outputDb))).toBe(true)
  })
})

// ── Scale helpers ───────────────────────────────────────────────────────────

describe('Compressor scale helpers', () => {
  it('compressorLevelToY clamps top and bottom', () => {
    expect(compressorLevelToY(COMPRESSOR_DISPLAY.level.maxDb, 100)).toBe(0)
    expect(compressorLevelToY(60, 100)).toBe(0)
    expect(compressorLevelToY(COMPRESSOR_DISPLAY.level.minDb, 100)).toBe(99)
    expect(compressorLevelToY(-200, 100)).toBe(99)
  })

  it('compressorTransferXForDb / YForDb produce in-range values', () => {
    const values = [-60, -48, -24, 0, 6, 100, Number.NaN, Number.POSITIVE_INFINITY]
    for (const v of values) {
      const x = compressorTransferXForDb(v, 200)
      const y = compressorTransferYForDb(v, 200)
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(199)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(199)
    }
  })

  it('compressorGrToY 0 -> top, max -> bottom', () => {
    expect(compressorGrToY(0, 100)).toBe(0)
    expect(compressorGrToY(COMPRESSOR_DISPLAY.gr.maxGrDb, 100)).toBe(99)
    expect(compressorGrToY(48, 100)).toBe(99)
  })
})

// ── Transfer-curve geometry ─────────────────────────────────────────────────

describe('Compressor transfer-curve geometry', () => {
  it('computeTransferCurvePoints returns finite (x,y,inDb,outDb) tuples', () => {
    const points = computeTransferCurvePoints(PARAMS, 160, 160)
    expect(points.length).toBeGreaterThan(8)
    for (const p of points) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Number.isFinite(p.inDb)).toBe(true)
      expect(Number.isFinite(p.outDb)).toBe(true)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(159)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(159)
    }
  })

  it('computeTransferCurvePoints returns [] when params are missing', () => {
    expect(computeTransferCurvePoints(null, 100, 100)).toEqual([])
    expect(computeTransferCurvePoints({ threshold: Number.NaN, ratio: 4 }, 100, 100)).toEqual([])
  })

  it('computeThresholdMarker returns a finite point inside the canvas', () => {
    const m = computeThresholdMarker(PARAMS, 200, 200)
    expect(m).toBeTruthy()
    expect(Number.isFinite(m.x)).toBe(true)
    expect(Number.isFinite(m.y)).toBe(true)
    expect(m.x).toBeGreaterThan(0)
    expect(m.x).toBeLessThan(199)
  })

  it('computeThresholdMarker returns null when threshold missing', () => {
    expect(computeThresholdMarker({ ratio: 4 }, 200, 200)).toBeNull()
    expect(computeThresholdMarker(null, 200, 200)).toBeNull()
  })

  it('computeKneeRegion returns null when knee == 0', () => {
    expect(computeKneeRegion({ threshold: -18, knee: 0 }, 200, 200)).toBeNull()
  })

  it('computeKneeRegion returns finite low/high coordinates when knee > 0', () => {
    const region = computeKneeRegion({ threshold: -18, knee: 8 }, 200, 200)
    expect(region).toBeTruthy()
    expect(Number.isFinite(region.xLow)).toBe(true)
    expect(Number.isFinite(region.xHigh)).toBe(true)
    expect(Number.isFinite(region.yLow)).toBe(true)
    expect(Number.isFinite(region.yHigh)).toBe(true)
    expect(region.lowDb).toBeLessThan(region.highDb)
  })

  it('computeLiveDetectorPoint returns finite coordinates', () => {
    const dot = computeLiveDetectorPoint(
      { ioInDb: -10, ioOutDb: -14, inLevelDb: -10, outLevelDb: -14, detectorDb: -10, grDb: 4 },
      PARAMS,
      200,
      200,
    )
    expect(dot).toBeTruthy()
    expect(Number.isFinite(dot.x)).toBe(true)
    expect(Number.isFinite(dot.y)).toBe(true)
  })

  it('computeLiveDetectorPoint clamps NaN/Infinity to canvas edges', () => {
    const dot = computeLiveDetectorPoint(
      { ioInDb: Number.POSITIVE_INFINITY, ioOutDb: Number.NaN, inLevelDb: 99, outLevelDb: -99 },
      PARAMS,
      200,
      200,
    )
    expect(dot).toBeTruthy()
    expect(Number.isFinite(dot.x)).toBe(true)
    expect(Number.isFinite(dot.y)).toBe(true)
  })

  it('computeLiveDetectorPoint returns null when bucket is null', () => {
    expect(computeLiveDetectorPoint(null, PARAMS, 200, 200)).toBeNull()
  })
})

// ── Meter values ────────────────────────────────────────────────────────────

describe('Compressor meter values', () => {
  it('keeps GR finite and clamped through noisy buckets', () => {
    let meter = null
    const buckets = [
      { grDb: 0 },
      { grDb: Number.POSITIVE_INFINITY },
      { grDb: 24 },
      { grDb: Number.NaN },
      { grDb: -3 },
      null,
    ]
    for (const b of buckets) {
      meter = computeCompressorMeterValues(b, meter)
      expect(Number.isFinite(meter.grDb)).toBe(true)
      expect(meter.grDb).toBeGreaterThanOrEqual(0)
      expect(meter.grDb).toBeLessThanOrEqual(COMPRESSOR_DISPLAY.gr.maxGrDb)
      expect(Number.isFinite(meter.peakGrDb)).toBe(true)
      expect(meter.peakGrDb).toBeGreaterThanOrEqual(0)
      expect(meter.peakGrDb).toBeLessThanOrEqual(COMPRESSOR_DISPLAY.gr.maxGrDb)
    }
  })

  it('peak hold age increments and resets on new peak', () => {
    let meter = computeCompressorMeterValues({ grDb: 6 }, null)
    expect(meter.peakAge).toBe(0)
    meter = computeCompressorMeterValues({ grDb: 0 }, meter)
    expect(meter.peakAge).toBe(1)
    meter = computeCompressorMeterValues({ grDb: 12 }, meter)
    expect(meter.peakGrDb).toBeCloseTo(12, 5)
    expect(meter.peakAge).toBe(0)
  })
})

// ── Format ──────────────────────────────────────────────────────────────────

describe('formatCompressorGrReadout', () => {
  it('returns "GR 0 dB" near zero', () => {
    expect(formatCompressorGrReadout(0)).toBe('GR 0 dB')
    expect(formatCompressorGrReadout(0.04)).toBe('GR 0 dB')
  })
  it('formats integer-ish reductions without decimal', () => {
    expect(formatCompressorGrReadout(6)).toBe('GR 6 dB')
    expect(formatCompressorGrReadout(6.05)).toBe('GR 6 dB')
  })
  it('formats fractional reductions with one decimal', () => {
    expect(formatCompressorGrReadout(6.4)).toBe('GR 6.4 dB')
  })
  it('clamps NaN/negative to 0', () => {
    expect(formatCompressorGrReadout(Number.NaN)).toBe('GR 0 dB')
    expect(formatCompressorGrReadout(-3)).toBe('GR 0 dB')
  })
})

// ── Preset registry / back-compat ──────────────────────────────────────────

describe('Compressor preset registry', () => {
  it('exposes both compressorCombined and compressorCombinedV2 keys', () => {
    expect(typeof COMPRESSOR_PRESETS.compressorCombined).toBe('function')
    expect(typeof COMPRESSOR_PRESETS.compressorCombinedV2).toBe('function')
  })

  it('compressorCombined alias dispatches to the v2 painter', () => {
    expect(COMPRESSOR_PRESETS.compressorCombined).toBe(COMPRESSOR_PRESETS.compressorCombinedV2)
  })

  it('keeps default preset for compressor.combined as compressorCombined', () => {
    expect(COMPRESSOR_SOURCE_DEFAULT_PRESET['compressor.combined']).toBe('compressorCombined')
  })

  it('exposes new envelopeHistory and gainReductionActivity presets', () => {
    expect(typeof COMPRESSOR_PRESETS.envelopeHistory).toBe('function')
    expect(typeof COMPRESSOR_PRESETS.gainReductionActivity).toBe('function')
    expect(COMPRESSOR_VISUALIZER_PRESETS.envelopeHistory).toBeTruthy()
    expect(COMPRESSOR_VISUALIZER_PRESETS.gainReductionActivity).toBeTruthy()
  })

  it('legacy presets still resolve', () => {
    for (const key of ['levelHistory', 'gainReductionStrip', 'scrollingStrip', 'transferCurveLive', 'detector']) {
      expect(typeof COMPRESSOR_PRESETS[key]).toBe('function')
    }
  })

  it('does not leak limiter presets into the compressor registry', () => {
    for (const key of Object.keys(COMPRESSOR_PRESETS)) {
      expect(key.startsWith('limiter')).toBe(false)
    }
  })
})

// ── Layout JSON ─────────────────────────────────────────────────────────────

describe('Compressor layout', () => {
  it('parses and references known visualizer preset', () => {
    expect(compressorLayout?.pluginId).toBe('compressor')
    const root = compressorLayout?.root
    expect(root?.type).toBe('panel')
    const queue = [root]
    let viz = null
    while (queue.length) {
      const node = queue.shift()
      if (!node) continue
      if (node.type === 'visualizer') { viz = node; break }
      if (Array.isArray(node.children)) queue.push(...node.children)
    }
    expect(viz).toBeTruthy()
    expect(viz.props?.source).toBe('compressor.combined')
    const preset = viz.props?.preset
    expect(typeof COMPRESSOR_PRESETS[preset]).toBe('function')
  })
})

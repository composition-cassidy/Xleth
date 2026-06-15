// Compressor visualizer painters.
//
// The Compressor telemetry is real and complete; the painter's job is to make
// it readable. Rendering is split into named section helpers so a "combined"
// preset can compose the transfer curve, GR activity, envelope history and
// compact meter into a single legible display without each layer being a
// noisy line over the same axes.
//
// No DSP runs here. We only project bucket data (peaks, GR, detector point)
// onto canvas pixels.

import { uiCanvasFont } from '../../../styles/typography.js'
import { dbToY, grToY, softKneeOutputDb, SCALES } from './scaling.js'

// ── Display constants ───────────────────────────────────────────────────────
//
// Centralised so the painter is configurable from one place. UI controls
// should not be added — these stay tuned in code for now.

export const COMPRESSOR_DISPLAY = Object.freeze({
  level: Object.freeze({
    minDb: -48,
    maxDb: 6,
    gridDb: Object.freeze([0, -12, -24, -36]),
  }),
  transfer: Object.freeze({
    minDb: -48,
    maxDb: 6,
    gridDb: Object.freeze([0, -12, -24, -36]),
  }),
  gr: Object.freeze({
    maxGrDb: 24,
    gridDb: Object.freeze([0, 6, 12, 18, 24]),
  }),
  meter: Object.freeze({
    maxGrDb: 24,
    peakHoldFrames: 90,
  }),
  historyMaxBuckets: 720,
  columnWidthPx: 2,
  detectorDotPx: 4,
  smoothing: Object.freeze({
    levelAttack: 0.55,
    levelRelease: 0.22,
    levelPeakHoldDb: 1.0,
    grAttack: 0.62,
    grRelease: 0.22,
    grPeakHoldDb: 0.7,
    meterAttack: 0.7,
    meterRelease: 0.12,
    detectorAttack: 0.6,
    detectorRelease: 0.18,
  }),
})

const COLORS = Object.freeze({
  curve:        '#7dd3fc',
  curveDim:     '#1f6f8e',
  unity:        '#444',
  threshold:    '#9ca3af',
  knee:         '#7dd3fc',
  detector:     '#fde68a',
  detectorRing: '#fff7d6',
  output:       '#7dd3fc',
  outputDim:    '#1f6f8e',
  input:        '#9ca3af',
  grFill:       '#ff7a35',
  grStroke:     '#ffb067',
  grText:       '#ffd8b0',
})

const meterStateByContext = new WeakMap()

// ── Tiny utilities ──────────────────────────────────────────────────────────

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function sanitizeLevelDb(value) {
  const { minDb, maxDb } = COMPRESSOR_DISPLAY.level
  return clamp(finiteOr(value, minDb), minDb, maxDb)
}

function sanitizeTransferDb(value) {
  const { minDb, maxDb } = COMPRESSOR_DISPLAY.transfer
  return clamp(finiteOr(value, minDb), minDb, maxDb)
}

function sanitizeGrDb(value, maxDb = COMPRESSOR_DISPLAY.gr.maxGrDb) {
  return clamp(finiteOr(value, 0), 0, maxDb)
}

// ── Scale helpers ───────────────────────────────────────────────────────────

export function compressorLevelToY(db, h) {
  const { minDb, maxDb } = COMPRESSOR_DISPLAY.level
  return dbToY(db, minDb, maxDb, Math.max(1, h | 0))
}

export function compressorGrToY(grDb, h) {
  return grToY(grDb, COMPRESSOR_DISPLAY.gr.maxGrDb, Math.max(1, h | 0))
}

export function compressorTransferXForDb(db, w) {
  const { minDb, maxDb } = COMPRESSOR_DISPLAY.transfer
  const width = Math.max(1, w | 0)
  const clamped = sanitizeTransferDb(db)
  const t = (clamped - minDb) / (maxDb - minDb)
  return Math.round(t * (width - 1))
}

export function compressorTransferYForDb(db, h) {
  const { minDb, maxDb } = COMPRESSOR_DISPLAY.transfer
  const height = Math.max(1, h | 0)
  const clamped = sanitizeTransferDb(db)
  const t = (clamped - minDb) / (maxDb - minDb)
  return Math.round((1 - t) * (height - 1))
}

// ── Bucket collection / downsampling / smoothing ────────────────────────────

function collectCompressorBuckets(source) {
  if (!source) return []
  if (Array.isArray(source)) return source.filter(Boolean)
  if (typeof source.forEachInOrder !== 'function' || !source.count) return []

  const buckets = []
  source.forEachInOrder((bucket) => {
    if (bucket) buckets.push(bucket)
  })
  return buckets
}

function maxColumnsForWidth(plotWidth, options = {}) {
  const width = Math.max(1, Math.floor(finiteOr(plotWidth, 1)))
  const columnWidthPx = Math.max(1, finiteOr(options.columnWidthPx, COMPRESSOR_DISPLAY.columnWidthPx))
  return Math.max(1, Math.min(width, Math.ceil(width / columnWidthPx)))
}

function assignColumnX(columns, plotWidth, maxColumns) {
  const width = Math.max(1, Math.floor(finiteOr(plotWidth, 1)))
  if (columns.length === 0) return columns
  if (columns.length === 1) {
    columns[0].x = width - 1
    return columns
  }

  const stepPx = maxColumns <= 1 ? 1 : (width - 1) / Math.max(1, maxColumns - 1)
  const startX = Math.max(0, width - 1 - stepPx * (columns.length - 1))
  for (let i = 0; i < columns.length; i++) {
    columns[i].x = Math.round(startX + i * stepPx)
  }
  return columns
}

function aggregateRange(buckets, start, end) {
  let inputDb = Number.NEGATIVE_INFINITY
  let outputDb = Number.NEGATIVE_INFINITY
  let detectorDb = Number.NEGATIVE_INFINITY
  let grDb = 0

  for (let i = start; i < end; i++) {
    const bucket = buckets[i]
    if (!bucket) continue
    if (Number.isFinite(bucket.inLevelDb)) inputDb = Math.max(inputDb, bucket.inLevelDb)
    if (Number.isFinite(bucket.outLevelDb)) outputDb = Math.max(outputDb, bucket.outLevelDb)
    if (Number.isFinite(bucket.detectorDb)) detectorDb = Math.max(detectorDb, bucket.detectorDb)
    if (Number.isFinite(bucket.grDb)) grDb = Math.max(grDb, bucket.grDb)
  }

  const safeInput  = sanitizeLevelDb(inputDb)
  const safeOutput = sanitizeLevelDb(outputDb)
  const safeDet    = sanitizeLevelDb(detectorDb)
  const safeGr     = sanitizeGrDb(grDb)

  return {
    x: 0,
    inputDb: safeInput,
    outputDb: safeOutput,
    detectorDb: safeDet,
    grDb: safeGr,
    peakGrDb: safeGr,
  }
}

export function downsampleCompressorHistory(source, plotWidth, options = {}) {
  const buckets = collectCompressorBuckets(source)
  if (buckets.length === 0) return []

  const maxColumns = maxColumnsForWidth(plotWidth, options)
  const historyMaxBuckets = Math.max(
    1,
    Math.floor(finiteOr(options.historyMaxBuckets, COMPRESSOR_DISPLAY.historyMaxBuckets)),
  )
  const bucketCount = Math.min(buckets.length, historyMaxBuckets)
  const bucketStart = buckets.length - bucketCount
  const columnCount = Math.min(maxColumns, bucketCount)
  const bucketsPerColumn = bucketCount / columnCount
  const columns = []

  for (let column = 0; column < columnCount; column++) {
    const start = bucketStart + Math.floor(column * bucketsPerColumn)
    const rawEnd = column === columnCount - 1
      ? bucketStart + bucketCount
      : bucketStart + Math.floor((column + 1) * bucketsPerColumn)
    const end = Math.min(bucketStart + bucketCount, Math.max(start + 1, rawEnd))
    columns.push(aggregateRange(buckets, start, end))
  }

  return assignColumnX(columns, plotWidth, maxColumns)
}

function smoothRisingFalling(previous, current, attack, release, peakHold = 0) {
  const safeCurrent = finiteOr(current, finiteOr(previous, 0))
  if (!Number.isFinite(previous)) return safeCurrent
  const rising = safeCurrent > previous
  const alpha = rising ? attack : release
  const smoothed = previous + (safeCurrent - previous) * alpha
  if (rising && peakHold > 0) return Math.max(smoothed, safeCurrent - peakHold)
  return smoothed
}

export function smoothCompressorHistory(columns, options = {}) {
  if (!Array.isArray(columns) || columns.length === 0) return []
  const smoothing = { ...COMPRESSOR_DISPLAY.smoothing, ...(options.smoothing || {}) }

  let previousInput = Number.NaN
  let previousOutput = Number.NaN
  let previousDetector = Number.NaN
  let previousGr = Number.NaN

  return columns.map((column) => {
    const inputDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousInput,
        sanitizeLevelDb(column?.inputDb),
        smoothing.levelAttack,
        smoothing.levelRelease,
        smoothing.levelPeakHoldDb,
      ),
    )
    const outputDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousOutput,
        sanitizeLevelDb(column?.outputDb),
        smoothing.levelAttack,
        smoothing.levelRelease,
        smoothing.levelPeakHoldDb,
      ),
    )
    const detectorDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousDetector,
        sanitizeLevelDb(column?.detectorDb),
        smoothing.detectorAttack,
        smoothing.detectorRelease,
      ),
    )
    const grDb = sanitizeGrDb(
      smoothRisingFalling(
        previousGr,
        sanitizeGrDb(column?.grDb),
        smoothing.grAttack,
        smoothing.grRelease,
        smoothing.grPeakHoldDb,
      ),
    )

    previousInput = inputDb
    previousOutput = outputDb
    previousDetector = detectorDb
    previousGr = grDb

    return {
      ...column,
      inputDb,
      outputDb,
      detectorDb,
      grDb,
      peakGrDb: sanitizeGrDb(column?.peakGrDb ?? column?.grDb),
    }
  })
}

export function buildCompressorDisplayHistory(ring, plotWidth, options = {}) {
  return smoothCompressorHistory(
    downsampleCompressorHistory(ring, plotWidth, options),
    options,
  )
}

// ── Transfer curve geometry ─────────────────────────────────────────────────
//
// computeTransferCurvePoints walks the input dB axis at ~1 px steps and emits
// {inDb, outDb, x, y} for the curve. Sanitised to clamp under-range values to
// the bottom edge so we never draw NaN or off-screen segments.

export function computeTransferCurvePoints(params, w, h, stepPx = 1) {
  const { minDb, maxDb } = COMPRESSOR_DISPLAY.transfer
  const width  = Math.max(2, w | 0)
  const height = Math.max(2, h | 0)
  const points = []
  if (!params || !Number.isFinite(params.threshold) || !Number.isFinite(params.ratio)) {
    return points
  }
  const knee   = Number.isFinite(params.knee)   ? Math.max(0, params.knee) : 0
  const makeup = Number.isFinite(params.makeup) ? params.makeup            : 0

  const step = Math.max(1, Math.floor(stepPx))
  for (let dx = 0; dx <= width - 1; dx += step) {
    const inDb  = minDb + (dx / (width - 1)) * (maxDb - minDb)
    const outDbRaw = softKneeOutputDb(inDb, params.threshold, params.ratio, knee, makeup)
    const outDb = sanitizeTransferDb(outDbRaw)
    points.push({
      inDb,
      outDb,
      x: dx,
      y: compressorTransferYForDb(outDb, height),
    })
  }
  return points
}

export function computeThresholdMarker(params, w, h) {
  if (!params || !Number.isFinite(params.threshold)) return null
  const safe = sanitizeTransferDb(params.threshold)
  return {
    db: safe,
    x: compressorTransferXForDb(safe, w),
    y: compressorTransferYForDb(safe, h),
  }
}

export function computeKneeRegion(params, w, h) {
  if (!params || !Number.isFinite(params.threshold) || !Number.isFinite(params.knee)) return null
  const knee = Math.max(0, params.knee)
  if (knee <= 0) return null
  const lowDb  = sanitizeTransferDb(params.threshold - knee * 0.5)
  const highDb = sanitizeTransferDb(params.threshold + knee * 0.5)
  return {
    lowDb,
    highDb,
    xLow:  compressorTransferXForDb(lowDb, w),
    xHigh: compressorTransferXForDb(highDb, w),
    yLow:  compressorTransferYForDb(lowDb, h),
    yHigh: compressorTransferYForDb(highDb, h),
  }
}

export function computeLiveDetectorPoint(bucket, params, w, h) {
  if (!bucket) return null
  const inDbRaw  = Number.isFinite(bucket.ioInDb)  ? bucket.ioInDb
                  : Number.isFinite(bucket.detectorDb) ? bucket.detectorDb
                  : Number.isFinite(bucket.inLevelDb)  ? bucket.inLevelDb
                  : null
  const outDbRaw = Number.isFinite(bucket.ioOutDb) ? bucket.ioOutDb
                  : Number.isFinite(bucket.outLevelDb) ? bucket.outLevelDb
                  : null
  if (inDbRaw === null || outDbRaw === null) return null

  const inDb  = sanitizeTransferDb(inDbRaw)
  const outDb = sanitizeTransferDb(outDbRaw)
  return {
    inDb,
    outDb,
    x: compressorTransferXForDb(inDb, w),
    y: compressorTransferYForDb(outDb, h),
  }
}

// ── Meter values ────────────────────────────────────────────────────────────

export function computeCompressorMeterValues(bucket, previous, options = {}) {
  const smoothing = { ...COMPRESSOR_DISPLAY.smoothing, ...(options.smoothing || {}) }
  const targetGr = sanitizeGrDb(bucket ? bucket.grDb : 0)

  const previousGr = Number.isFinite(previous?.grDb)
    ? sanitizeGrDb(previous.grDb)
    : targetGr
  const previousPeak = Number.isFinite(previous?.peakGrDb) ? Math.max(0, previous.peakGrDb) : 0
  const previousPeakAge = Number.isFinite(previous?.peakAge) ? previous.peakAge | 0 : 0

  const grDb = sanitizeGrDb(
    smoothRisingFalling(
      previousGr,
      targetGr,
      smoothing.meterAttack,
      smoothing.meterRelease,
    ),
  )

  let peakGrDb = previousPeak
  let peakAge = previousPeakAge + 1
  if (targetGr >= peakGrDb || peakAge >= COMPRESSOR_DISPLAY.meter.peakHoldFrames) {
    peakGrDb = targetGr
    peakAge = 0
  }

  return {
    grDb,
    peakGrDb: sanitizeGrDb(peakGrDb),
    peakAge,
    rawGrDb: targetGr,
  }
}

function meterValuesForContext(ctx, ring) {
  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const previousRecord = meterStateByContext.get(ctx)
  const previous = previousRecord && previousRecord.ring === ring ? previousRecord.values : null
  const next = computeCompressorMeterValues(last, previous)
  meterStateByContext.set(ctx, { ring, values: next })
  return next
}

// ── Format helpers ──────────────────────────────────────────────────────────

export function formatCompressorGrReadout(grDb) {
  const safe = sanitizeGrDb(grDb)
  if (safe < 0.05) return 'GR 0 dB'
  const rounded = Math.round(safe)
  if (Math.abs(safe - rounded) < 0.1) return `GR ${rounded} dB`
  return `GR ${safe.toFixed(1)} dB`
}

// ── Section painters ────────────────────────────────────────────────────────

export function drawCompressorBackground(ctx, x, y, w, h, theme) {
  if (!ctx || w <= 0 || h <= 0) return
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = theme.bgInset || theme.bg || '#090909'
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

function drawTransferGrid(ctx, w, h, theme) {
  const { gridDb } = COMPRESSOR_DISPLAY.transfer
  ctx.save()
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.4
  ctx.beginPath()
  for (const db of gridDb) {
    const yy = compressorTransferYForDb(db, h) + 0.5
    ctx.moveTo(0, yy)
    ctx.lineTo(w, yy)
    const xx = compressorTransferXForDb(db, w) + 0.5
    ctx.moveTo(xx, 0)
    ctx.lineTo(xx, h)
  }
  ctx.stroke()
  ctx.restore()
}

export function drawTransferCurve(ctx, x, y, w, h, theme, params) {
  if (!ctx || w < 8 || h < 8) return
  ctx.save()
  ctx.translate(x, y)

  // Plot frame
  drawTransferGrid(ctx, w, h, theme)

  // Unity diagonal (input == output)
  ctx.save()
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = COLORS.unity
  ctx.lineWidth = 1
  ctx.setLineDash([3, 4])
  ctx.beginPath()
  ctx.moveTo(0, h - 1)
  ctx.lineTo(w - 1, 0)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()

  // Knee region (subtle band)
  const knee = computeKneeRegion(params, w, h)
  if (knee) {
    ctx.save()
    ctx.globalAlpha = 0.12
    ctx.fillStyle = COLORS.knee
    const kx0 = clamp(Math.min(knee.xLow, knee.xHigh), 0, w)
    const kx1 = clamp(Math.max(knee.xLow, knee.xHigh), 0, w)
    ctx.fillRect(kx0, 0, Math.max(1, kx1 - kx0), h)
    ctx.restore()
  }

  // Threshold marker (vertical + horizontal hairlines)
  const threshold = computeThresholdMarker(params, w, h)
  if (threshold) {
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.strokeStyle = COLORS.threshold
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(threshold.x + 0.5, 0)
    ctx.lineTo(threshold.x + 0.5, h)
    ctx.moveTo(0, threshold.y + 0.5)
    ctx.lineTo(w, threshold.y + 0.5)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  // Compression curve
  const points = computeTransferCurvePoints(params, w, h)
  if (points.length >= 2) {
    ctx.save()
    ctx.globalAlpha = 0.96
    ctx.strokeStyle = COLORS.curve
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
    ctx.stroke()
    ctx.restore()
  }

  ctx.restore()
}

export function drawLiveDetectorDot(ctx, x, y, w, h, ring, params) {
  if (!ctx || w < 8 || h < 8) return
  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const dot = computeLiveDetectorPoint(last, params, w, h)
  if (!dot) return

  ctx.save()
  ctx.translate(x, y)

  ctx.globalAlpha = 0.35
  ctx.fillStyle = COLORS.detector
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, COMPRESSOR_DISPLAY.detectorDotPx + 2, 0, Math.PI * 2)
  ctx.fill()

  ctx.globalAlpha = 1
  ctx.fillStyle = COLORS.detectorRing
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, COMPRESSOR_DISPLAY.detectorDotPx, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

function drawActivityGrid(ctx, w, h, theme) {
  const { gridDb } = COMPRESSOR_DISPLAY.gr
  ctx.save()
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.32
  ctx.beginPath()
  for (const db of gridDb) {
    const yy = compressorGrToY(db, h) + 0.5
    ctx.moveTo(0, yy)
    ctx.lineTo(w, yy)
  }
  ctx.stroke()
  if (w >= 90 && h >= 32) {
    ctx.globalAlpha = 0.55
    ctx.fillStyle = theme.textMuted || '#999'
    ctx.font = uiCanvasFont('9px')
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of gridDb) {
      if (db === 0) continue
      const yy = compressorGrToY(db, h)
      ctx.fillText(`${db}`, w - 4, clamp(yy, 7, h - 7))
    }
  }
  ctx.restore()
}

export function drawGainReductionActivity(ctx, x, y, w, h, columns, theme) {
  if (!ctx || w < 4 || h < 4) return
  ctx.save()
  ctx.translate(x, y)

  drawActivityGrid(ctx, w, h, theme)

  if (!columns || columns.length === 0) {
    ctx.restore()
    return
  }
  const hasReduction = columns.some((c) => sanitizeGrDb(c?.grDb) >= 0.18)
  if (!hasReduction) {
    ctx.restore()
    return
  }

  ctx.globalAlpha = 0.28
  ctx.fillStyle = COLORS.grFill
  ctx.beginPath()
  ctx.moveTo(columns[0].x, 0)
  ctx.lineTo(columns[0].x, compressorGrToY(columns[0].grDb, h))
  for (let i = 1; i < columns.length; i++) {
    ctx.lineTo(columns[i].x, compressorGrToY(columns[i].grDb, h))
  }
  ctx.lineTo(columns[columns.length - 1].x, 0)
  ctx.closePath()
  ctx.fill()

  ctx.globalAlpha = 0.9
  ctx.strokeStyle = COLORS.grStroke
  ctx.lineWidth = 1.25
  ctx.beginPath()
  if (typeof ctx.quadraticCurveTo === 'function' && columns.length > 2) {
    ctx.moveTo(columns[0].x, compressorGrToY(columns[0].grDb, h))
    for (let i = 1; i < columns.length - 1; i++) {
      const cur = columns[i]
      const next = columns[i + 1]
      const midX = (cur.x + next.x) * 0.5
      const midY = (compressorGrToY(cur.grDb, h) + compressorGrToY(next.grDb, h)) * 0.5
      ctx.quadraticCurveTo(cur.x, compressorGrToY(cur.grDb, h), midX, midY)
    }
    const last = columns[columns.length - 1]
    ctx.lineTo(last.x, compressorGrToY(last.grDb, h))
  } else {
    ctx.moveTo(columns[0].x, compressorGrToY(columns[0].grDb, h))
    for (let i = 1; i < columns.length; i++) {
      ctx.lineTo(columns[i].x, compressorGrToY(columns[i].grDb, h))
    }
  }
  ctx.stroke()

  ctx.restore()
}

function drawLevelGrid(ctx, w, h, theme) {
  const { gridDb } = COMPRESSOR_DISPLAY.level
  ctx.save()
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.32
  ctx.beginPath()
  for (const db of gridDb) {
    const yy = compressorLevelToY(db, h) + 0.5
    ctx.moveTo(0, yy)
    ctx.lineTo(w, yy)
  }
  ctx.stroke()
  ctx.restore()
}

function strokeLinePath(ctx, columns, yForColumn, color, lineWidth, alpha = 1) {
  if (!columns || columns.length === 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(columns[0].x, yForColumn(columns[0]))
  if (columns.length === 1) {
    ctx.lineTo(columns[0].x + 0.5, yForColumn(columns[0]))
  } else if (typeof ctx.quadraticCurveTo === 'function' && columns.length > 2) {
    for (let i = 1; i < columns.length - 1; i++) {
      const cur = columns[i]
      const next = columns[i + 1]
      const midX = (cur.x + next.x) * 0.5
      const midY = (yForColumn(cur) + yForColumn(next)) * 0.5
      ctx.quadraticCurveTo(cur.x, yForColumn(cur), midX, midY)
    }
    const last = columns[columns.length - 1]
    ctx.lineTo(last.x, yForColumn(last))
  } else {
    for (let i = 1; i < columns.length; i++) {
      ctx.lineTo(columns[i].x, yForColumn(columns[i]))
    }
  }
  ctx.stroke()
  ctx.restore()
}

function fillLevelEnvelope(ctx, columns, h, yForColumn, color, alpha) {
  if (!columns || columns.length === 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(columns[0].x, h)
  ctx.lineTo(columns[0].x, yForColumn(columns[0]))
  for (let i = 1; i < columns.length; i++) {
    ctx.lineTo(columns[i].x, yForColumn(columns[i]))
  }
  ctx.lineTo(columns[columns.length - 1].x, h)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export function drawEnvelopeHistory(ctx, x, y, w, h, columns, theme) {
  if (!ctx || w < 4 || h < 4) return
  ctx.save()
  ctx.translate(x, y)

  drawLevelGrid(ctx, w, h, theme)

  if (!columns || columns.length === 0) {
    ctx.restore()
    return
  }

  // Input — soft fill + faint stroke (low alpha, behind output)
  fillLevelEnvelope(ctx, columns, h, (c) => compressorLevelToY(c.inputDb, h), COLORS.input, 0.10)
  strokeLinePath(ctx, columns, (c) => compressorLevelToY(c.inputDb, h), COLORS.input, 1, 0.28)

  // Output — clearer line + dim envelope fill
  fillLevelEnvelope(ctx, columns, h, (c) => compressorLevelToY(c.outputDb, h), COLORS.outputDim, 0.18)
  strokeLinePath(ctx, columns, (c) => compressorLevelToY(c.outputDb, h), COLORS.output, 1.5, 0.92)

  ctx.restore()
}

export function drawCompressorMeters(ctx, x, y, w, h, ring, theme) {
  if (!ctx || w < 8 || h < 8) return
  const meter = meterValuesForContext(ctx, ring)
  const labelW = w >= 56 ? 22 : 0
  const lane = Math.max(6, w - labelW - 8)
  const laneX = labelW ? labelW + 4 : 4
  const ticks = h >= 80 ? COMPRESSOR_DISPLAY.gr.gridDb : [0, 12, 24]

  ctx.save()
  ctx.translate(x, y)

  ctx.fillStyle = theme.bg || theme.bgInset || '#080808'
  ctx.fillRect(0, 0, w, h)

  ctx.globalAlpha = 0.6
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0.5, 0); ctx.lineTo(0.5, h)
  ctx.stroke()

  // Lane background
  ctx.globalAlpha = 0.16
  ctx.fillStyle = COLORS.grFill
  ctx.fillRect(laneX, 0, lane, h)

  // Ticks
  ctx.globalAlpha = 0.4
  ctx.strokeStyle = theme.grid || '#333'
  ctx.beginPath()
  for (const db of ticks) {
    const yy = compressorGrToY(db, h) + 0.5
    ctx.moveTo(labelW ? labelW : 2, yy)
    ctx.lineTo(w - 2, yy)
  }
  ctx.stroke()

  if (labelW) {
    ctx.globalAlpha = 0.78
    ctx.fillStyle = theme.textMuted || '#999'
    ctx.font = uiCanvasFont('9px')
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of ticks) {
      ctx.fillText(`${db}`, labelW - 2, clamp(compressorGrToY(db, h), 7, h - 7))
    }
  }

  // Current GR fill
  const grY = compressorGrToY(meter.grDb, h)
  if (grY > 0) {
    ctx.globalAlpha = 0.92
    ctx.fillStyle = COLORS.grFill
    ctx.fillRect(laneX, 0, lane, grY)
  }

  // Peak hold marker
  if (meter.peakGrDb >= 0.5) {
    const peakY = compressorGrToY(meter.peakGrDb, h)
    ctx.globalAlpha = 0.85
    ctx.fillStyle = COLORS.grStroke
    ctx.fillRect(laneX, peakY - 1, lane, 2)
  }

  // Outline
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = theme.grid || '#333'
  ctx.strokeRect(laneX + 0.5, 0.5, lane - 1, h - 1)

  ctx.restore()
}

export function drawCompressorLabels(ctx, x, y, w, h, ring, theme, params, options = {}) {
  if (!ctx || w < 40 || h < 16) return
  const meter = meterValuesForContext(ctx, ring)
  const showThreshold = options.showThreshold !== false
  const showRatio     = options.showRatio !== false
  const showGr        = options.showGr !== false

  ctx.save()
  ctx.translate(x, y)
  ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  ctx.textBaseline = 'top'
  ctx.fillStyle = theme.textMuted || '#999'
  ctx.globalAlpha = 0.85

  let cursor = 4
  if (showThreshold && Number.isFinite(params?.threshold)) {
    const text = `THRESH ${params.threshold.toFixed(1)}`
    ctx.textAlign = 'left'
    ctx.fillText(text, 6, cursor)
    cursor += 12
  }
  if (showRatio && Number.isFinite(params?.ratio)) {
    const text = `RATIO ${params.ratio.toFixed(1)}:1`
    ctx.textAlign = 'left'
    ctx.fillText(text, 6, cursor)
  }
  if (showGr) {
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.grText
    ctx.globalAlpha = meter.grDb >= 0.4 ? 0.95 : 0.55
    ctx.fillText(formatCompressorGrReadout(meter.grDb), w - 6, 4)
  }
  ctx.restore()
}

// ── Legacy / single-purpose presets (kept for back-compat with saved
// layouts and the limiter migration tests) ──────────────────────────────────

export function drawLevelHistory(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)
  const columns = buildCompressorDisplayHistory(ring, w)
  drawEnvelopeHistory(ctx, 0, 0, w, h, columns, theme)
}

export function drawGainReductionStrip(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)
  const columns = buildCompressorDisplayHistory(ring, w)
  drawGainReductionActivity(ctx, 0, 0, w, h, columns, theme)
}

export function drawDetector(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)
  drawLevelGrid(ctx, w, h, theme)

  const buckets = collectCompressorBuckets(ring)
  if (buckets.length === 0) return

  const columns = buildCompressorDisplayHistory(ring, w)
  if (columns.length === 0) return
  strokeLinePath(ctx, columns, (c) => compressorLevelToY(c.detectorDb, h), COLORS.curve, 1.25, 0.9)
}

export function drawTransferCurveLive(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)
  drawTransferCurve(ctx, 0, 0, w, h, theme, params)
  drawLiveDetectorDot(ctx, 0, 0, w, h, ring, params)
}

// ── Combined v2 painter ─────────────────────────────────────────────────────
//
// Layout strategy (responsive):
//   • Wide (w >= h * 1.3): transfer curve square on the left, envelope +
//     GR activity strip in the middle, compact GR meter on the right.
//   • Narrow / tall: transfer curve on top, GR activity below.
//
// In both modes the transfer curve is the visual centerpiece; envelope and
// GR activity sit beside or under it as supporting context, and labels stay
// minimal (THRESH / RATIO / GR readout).

function pickCombinedLayout(w, h) {
  const meterW = w >= 200 ? clamp(Math.round(w * 0.10), 36, 56) : 0
  const gap = 6

  if (w >= 320 && w >= h * 1.3) {
    const remaining = Math.max(0, w - meterW - gap * (meterW > 0 ? 2 : 1))
    const curveSize = clamp(Math.min(remaining * 0.42, h), 80, 220)
    const stripX = curveSize + gap
    const stripW = Math.max(40, remaining - curveSize)
    return {
      mode: 'wide',
      curve:    { x: 0,        y: 0, w: curveSize, h },
      envelope: { x: stripX,   y: 0, w: stripW, h: Math.round(h * 0.58) },
      gr:       { x: stripX,   y: Math.round(h * 0.58) + 1, w: stripW, h: h - Math.round(h * 0.58) - 1 },
      meter:    meterW > 0 ? { x: w - meterW, y: 0, w: meterW, h } : null,
    }
  }

  // Stacked: curve on top, GR strip under, no side meter.
  const curveH = clamp(Math.round(h * 0.62), 48, h - 24)
  return {
    mode: 'stacked',
    curve:    { x: 0, y: 0, w, h: curveH },
    envelope: { x: 0, y: curveH + 1, w, h: Math.max(0, h - curveH - 1) },
    gr:       null,
    meter:    null,
  }
}

export function drawCompressorCombinedV2(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)

  const layout = pickCombinedLayout(w, h)
  const columns = layout.envelope
    ? buildCompressorDisplayHistory(ring, layout.envelope.w)
    : []

  // Curve panel
  drawTransferCurve(ctx, layout.curve.x, layout.curve.y, layout.curve.w, layout.curve.h, theme, params)
  drawLiveDetectorDot(ctx, layout.curve.x, layout.curve.y, layout.curve.w, layout.curve.h, ring, params)

  if (layout.mode === 'wide') {
    drawEnvelopeHistory(ctx, layout.envelope.x, layout.envelope.y, layout.envelope.w, layout.envelope.h, columns, theme)
    if (layout.gr) {
      drawGainReductionActivity(ctx, layout.gr.x, layout.gr.y, layout.gr.w, layout.gr.h, columns, theme)
    }
    if (layout.meter) {
      drawCompressorMeters(ctx, layout.meter.x, layout.meter.y, layout.meter.w, layout.meter.h, ring, theme)
    }
    drawCompressorLabels(ctx, layout.envelope.x, layout.envelope.y, layout.envelope.w, layout.envelope.h, ring, theme, params, { showThreshold: false, showRatio: false })
    drawCompressorLabels(ctx, layout.curve.x, layout.curve.y, layout.curve.w, layout.curve.h, ring, theme, params, { showGr: false })
  } else {
    // Stacked: envelope + GR overlaid in lower strip
    if (layout.envelope.h > 8) {
      drawEnvelopeHistory(ctx, layout.envelope.x, layout.envelope.y, layout.envelope.w, layout.envelope.h, columns, theme)
      drawGainReductionActivity(ctx, layout.envelope.x, layout.envelope.y, layout.envelope.w, layout.envelope.h, columns, theme)
    }
    drawCompressorLabels(ctx, layout.curve.x, layout.curve.y, layout.curve.w, layout.curve.h, ring, theme, params)
  }
}

// ── Standalone presets that compose the new sections ────────────────────────

export function drawCompressorEnvelopeHistory(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)
  const columns = buildCompressorDisplayHistory(ring, w)
  drawEnvelopeHistory(ctx, 0, 0, w, h, columns, theme)
}

export function drawCompressorGainReductionActivity(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  drawCompressorBackground(ctx, 0, 0, w, h, theme)
  const columns = buildCompressorDisplayHistory(ring, w)
  drawGainReductionActivity(ctx, 0, 0, w, h, columns, theme)
}

// ── Preset registry ─────────────────────────────────────────────────────────
//
// `compressorCombined` aliases to the v2 painter so previously-saved layouts
// keep rendering. New layouts may pick `compressorCombinedV2` explicitly.

export const COMPRESSOR_PRESETS = Object.freeze({
  levelHistory:               drawLevelHistory,
  gainReductionStrip:         drawGainReductionStrip,
  scrollingStrip:             drawGainReductionStrip,
  transferCurveLive:          drawTransferCurveLive,
  detector:                   drawDetector,
  envelopeHistory:            drawCompressorEnvelopeHistory,
  gainReductionActivity:      drawCompressorGainReductionActivity,
  compressorCombined:         drawCompressorCombinedV2,
  compressorCombinedV2:       drawCompressorCombinedV2,
})

export const COMPRESSOR_VISUALIZER_PRESETS = Object.freeze({
  levelHistory: Object.freeze({
    label: 'Level History',
    sources: ['compressor.levelHistory', 'compressor.combined'],
  }),
  gainReductionStrip: Object.freeze({
    label: 'Gain Reduction Strip',
    sources: ['compressor.gainReductionHistory', 'compressor.combined'],
  }),
  scrollingStrip: Object.freeze({
    label: 'Scrolling Strip',
    sources: ['compressor.gainReductionHistory'],
  }),
  transferCurveLive: Object.freeze({
    label: 'Transfer Curve Live',
    sources: ['compressor.transferCurve', 'compressor.combined'],
  }),
  detector: Object.freeze({
    label: 'Detector',
    sources: ['compressor.detector'],
  }),
  envelopeHistory: Object.freeze({
    label: 'Envelope History',
    sources: ['compressor.levelHistory', 'compressor.combined'],
  }),
  gainReductionActivity: Object.freeze({
    label: 'Gain Reduction Activity',
    sources: ['compressor.gainReductionHistory', 'compressor.combined'],
  }),
  compressorCombined: Object.freeze({
    label: 'Compressor Combined',
    sources: ['compressor.combined'],
  }),
  compressorCombinedV2: Object.freeze({
    label: 'Compressor Combined v2',
    sources: ['compressor.combined'],
  }),
})

export const COMPRESSOR_SOURCE_DEFAULT_PRESET = Object.freeze({
  'compressor.levelHistory':         'levelHistory',
  'compressor.gainReductionHistory': 'gainReductionStrip',
  'compressor.transferCurve':        'transferCurveLive',
  'compressor.detector':             'detector',
  'compressor.combined':             'compressorCombined',
})

// Limiter visualizer painters.
//
// The Limiter telemetry is already real and useful; the painter's job is to
// make it legible. The display pass below collapses dense history into
// per-column peaks, applies light visual smoothing, and then draws the layers
// in a stable dB range. No DSP or telemetry values are invented here.

import { uiCanvasFont } from '../../../styles/typography.js'
import { dbToY, grToY } from './scaling.js'

export const LIMITER_DISPLAY = Object.freeze({
  level: Object.freeze({
    minDb: -24,
    maxDb: 0,
    gridDb: Object.freeze([0, -6, -12, -18, -24]),
  }),
  meter: Object.freeze({
    minDb: -24,
    maxDb: 0,
  }),
  maxGrDb: 18,
  historyMaxBuckets: 720,
  columnWidthPx: 2,
  meterWidthPx: 54,
  meterMinWidthPx: 42,
  meterGapPx: 6,
  labelThresholdDb: 3,
  labelMinSpacingPx: 84,
  labelMaxCount: 5,
  smoothing: Object.freeze({
    levelAttack: 0.58,
    levelRelease: 0.24,
    levelPeakHoldDb: 1.1,
    energyAttack: 0.34,
    energyRelease: 0.16,
    grAttack: 0.64,
    grRelease: 0.28,
    grPeakHoldDb: 0.8,
    meterAttack: 0.72,
    meterRelease: 0.1,
  }),
})

const meterStateByContext = new WeakMap()

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function sanitizeLevelDb(value) {
  const { minDb, maxDb } = LIMITER_DISPLAY.level
  return clamp(finiteOr(value, minDb), minDb, maxDb)
}

function sanitizeMeterDb(value) {
  const { minDb, maxDb } = LIMITER_DISPLAY.meter
  return clamp(finiteOr(value, minDb), minDb, maxDb)
}

function sanitizeGrDb(value, maxDb = Number.POSITIVE_INFINITY) {
  return clamp(finiteOr(value, 0), 0, maxDb)
}

export function limiterLevelToY(db, h) {
  const { minDb, maxDb } = LIMITER_DISPLAY.level
  return dbToY(db, minDb, maxDb, Math.max(1, h | 0))
}

export function limiterMeterToY(db, h) {
  const { minDb, maxDb } = LIMITER_DISPLAY.meter
  return dbToY(db, minDb, maxDb, Math.max(1, h | 0))
}

export function limiterGrToY(grDb, h) {
  return grToY(grDb, LIMITER_DISPLAY.maxGrDb, Math.max(1, h | 0))
}

function collectLimiterBuckets(source) {
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
  const columnWidthPx = Math.max(1, finiteOr(options.columnWidthPx, LIMITER_DISPLAY.columnWidthPx))
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
  let peakGrDb = 0
  let inEnergySum = 0
  let outEnergySum = 0
  let inEnergyCount = 0
  let outEnergyCount = 0

  for (let i = start; i < end; i++) {
    const bucket = buckets[i]
    if (!bucket) continue

    if (Number.isFinite(bucket.inLevelDb)) inputDb = Math.max(inputDb, bucket.inLevelDb)
    if (Number.isFinite(bucket.outLevelDb)) outputDb = Math.max(outputDb, bucket.outLevelDb)
    if (Number.isFinite(bucket.gainReductionDb)) {
      peakGrDb = Math.max(peakGrDb, bucket.gainReductionDb)
    }
    if (Number.isFinite(bucket.inEnergyDb)) {
      inEnergySum += bucket.inEnergyDb
      inEnergyCount++
    }
    if (Number.isFinite(bucket.outEnergyDb)) {
      outEnergySum += bucket.outEnergyDb
      outEnergyCount++
    }
  }

  const safeInputDb = sanitizeLevelDb(inputDb)
  const safeOutputDb = sanitizeLevelDb(outputDb)
  const safePeakGrDb = sanitizeGrDb(peakGrDb)

  return {
    x: 0,
    inputDb: safeInputDb,
    outputDb: safeOutputDb,
    inEnergyDb: sanitizeLevelDb(inEnergyCount ? inEnergySum / inEnergyCount : safeInputDb),
    outEnergyDb: sanitizeLevelDb(outEnergyCount ? outEnergySum / outEnergyCount : safeOutputDb),
    grDb: sanitizeGrDb(safePeakGrDb, LIMITER_DISPLAY.maxGrDb),
    peakGrDb: safePeakGrDb,
  }
}

export function downsampleLimiterHistory(source, plotWidth, options = {}) {
  const buckets = collectLimiterBuckets(source)
  if (buckets.length === 0) return []

  const maxColumns = maxColumnsForWidth(plotWidth, options)
  const historyMaxBuckets = Math.max(
    1,
    Math.floor(finiteOr(options.historyMaxBuckets, LIMITER_DISPLAY.historyMaxBuckets)),
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

export function smoothLimiterDisplayHistory(columns, options = {}) {
  if (!Array.isArray(columns) || columns.length === 0) return []

  const smoothing = { ...LIMITER_DISPLAY.smoothing, ...(options.smoothing || {}) }
  let previousInput = Number.NaN
  let previousOutput = Number.NaN
  let previousInEnergy = Number.NaN
  let previousOutEnergy = Number.NaN
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
    const inEnergyDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousInEnergy,
        sanitizeLevelDb(column?.inEnergyDb),
        smoothing.energyAttack,
        smoothing.energyRelease,
      ),
    )
    const outEnergyDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousOutEnergy,
        sanitizeLevelDb(column?.outEnergyDb),
        smoothing.energyAttack,
        smoothing.energyRelease,
      ),
    )
    const grDb = sanitizeGrDb(
      smoothRisingFalling(
        previousGr,
        sanitizeGrDb(column?.grDb, LIMITER_DISPLAY.maxGrDb),
        smoothing.grAttack,
        smoothing.grRelease,
        smoothing.grPeakHoldDb,
      ),
      LIMITER_DISPLAY.maxGrDb,
    )

    previousInput = inputDb
    previousOutput = outputDb
    previousInEnergy = inEnergyDb
    previousOutEnergy = outEnergyDb
    previousGr = grDb

    return {
      ...column,
      inputDb,
      outputDb,
      inEnergyDb,
      outEnergyDb,
      grDb,
      peakGrDb: sanitizeGrDb(column?.peakGrDb ?? column?.grDb),
    }
  })
}

export function buildLimiterDisplayHistory(ring, plotWidth, options = {}) {
  return smoothLimiterDisplayHistory(
    downsampleLimiterHistory(ring, plotWidth, options),
    options,
  )
}

function labelValueForColumn(column) {
  return sanitizeGrDb(column?.peakGrDb ?? column?.grDb)
}

function columnX(column, index, count, plotWidth) {
  if (Number.isFinite(column?.x)) return column.x
  const width = Math.max(1, Math.floor(finiteOr(plotWidth, 1)))
  if (count <= 1) return width - 1
  return Math.round((index / (count - 1)) * (width - 1))
}

export function formatLimiterGrLabel(grDb) {
  const safe = sanitizeGrDb(grDb)
  const rounded = Math.round(safe)
  if (Math.abs(safe - rounded) < 0.15) return `-${rounded} dB`
  return `-${safe.toFixed(1)} dB`
}

export function pickLimiterGrLabels(columns, plotWidth, options = {}) {
  if (!Array.isArray(columns) || columns.length < 3) return []

  const thresholdDb = finiteOr(options.thresholdDb, LIMITER_DISPLAY.labelThresholdDb)
  const minSpacingPx = finiteOr(options.minSpacingPx, LIMITER_DISPLAY.labelMinSpacingPx)
  const maxLabels = Math.max(0, Math.floor(finiteOr(options.maxLabels, LIMITER_DISPLAY.labelMaxCount)))
  if (maxLabels === 0) return []

  const candidates = []
  for (let i = 1; i < columns.length - 1; i++) {
    const prev = labelValueForColumn(columns[i - 1])
    const current = labelValueForColumn(columns[i])
    const next = labelValueForColumn(columns[i + 1])
    const isLocalPeak = (current >= prev && current > next) || (current > prev && current >= next)
    if (current < thresholdDb || !isLocalPeak) continue

    candidates.push({
      index: i,
      x: columnX(columns[i], i, columns.length, plotWidth),
      grDb: current,
      displayGrDb: sanitizeGrDb(columns[i]?.grDb, LIMITER_DISPLAY.maxGrDb),
      text: formatLimiterGrLabel(current),
    })
  }

  candidates.sort((a, b) => {
    if (b.grDb !== a.grDb) return b.grDb - a.grDb
    return a.x - b.x
  })

  const labels = []
  for (const candidate of candidates) {
    if (labels.some((label) => Math.abs(label.x - candidate.x) < minSpacingPx)) continue
    labels.push(candidate)
    if (labels.length >= maxLabels) break
  }

  return labels.sort((a, b) => a.x - b.x)
}

export function computeLimiterMeterValues(bucket, previous, options = {}) {
  const smoothing = { ...LIMITER_DISPLAY.smoothing, ...(options.smoothing || {}) }
  const targetOutputDb = sanitizeMeterDb(bucket ? bucket.outLevelDb : LIMITER_DISPLAY.meter.minDb)
  const targetGrDb = sanitizeGrDb(bucket ? bucket.gainReductionDb : 0, LIMITER_DISPLAY.maxGrDb)

  const previousOutputDb = Number.isFinite(previous?.outputDb)
    ? sanitizeMeterDb(previous.outputDb)
    : targetOutputDb
  const previousGrDb = Number.isFinite(previous?.gainReductionDb)
    ? sanitizeGrDb(previous.gainReductionDb, LIMITER_DISPLAY.maxGrDb)
    : targetGrDb

  const outputDb = sanitizeMeterDb(
    smoothRisingFalling(
      previousOutputDb,
      targetOutputDb,
      smoothing.meterAttack,
      smoothing.meterRelease,
    ),
  )
  const gainReductionDb = sanitizeGrDb(
    smoothRisingFalling(
      previousGrDb,
      targetGrDb,
      smoothing.meterAttack,
      smoothing.meterRelease,
    ),
    LIMITER_DISPLAY.maxGrDb,
  )

  return {
    outputDb,
    gainReductionDb,
    rawOutputDb: targetOutputDb,
    rawGainReductionDb: targetGrDb,
  }
}

function meterValuesForContext(ctx, ring) {
  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const previousRecord = meterStateByContext.get(ctx)
  const previous = previousRecord && previousRecord.ring === ring ? previousRecord.values : null
  const next = computeLimiterMeterValues(last, previous)
  meterStateByContext.set(ctx, { ring, values: next })
  return next
}

function fillBackground(ctx, w, h, theme) {
  ctx.fillStyle = theme.bgInset || theme.bg || '#090909'
  ctx.fillRect(0, 0, w, h)
}

function limiterColors(theme = {}) {
  const accent = theme.accent || '#F0A3D0'
  return {
    output: accent,
    outputDim: accent,
    grFill: accent,
    grStroke: accent,
    grText: theme.text || accent,
  }
}

function strokeLinePath(ctx, columns, yForColumn, color, lineWidth, alpha = 1) {
  if (!columns || columns.length === 0) return

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()

  const firstY = yForColumn(columns[0])
  ctx.moveTo(columns[0].x, firstY)

  if (columns.length === 1) {
    ctx.lineTo(columns[0].x + 0.5, firstY)
  } else if (typeof ctx.quadraticCurveTo === 'function' && columns.length > 2) {
    for (let i = 1; i < columns.length - 1; i++) {
      const current = columns[i]
      const next = columns[i + 1]
      const midX = (current.x + next.x) * 0.5
      const midY = (yForColumn(current) + yForColumn(next)) * 0.5
      ctx.quadraticCurveTo(current.x, yForColumn(current), midX, midY)
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

function drawPlotGrid(ctx, x, y, w, h, theme) {
  const { gridDb } = LIMITER_DISPLAY.level

  ctx.save()
  ctx.translate(x, y)

  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.46
  ctx.beginPath()
  for (const db of gridDb) {
    const yy = limiterLevelToY(db, h) + 0.5
    ctx.moveTo(0, yy)
    ctx.lineTo(w, yy)
  }
  ctx.stroke()

  if (w >= 180) {
    ctx.globalAlpha = 0.18
    ctx.beginPath()
    for (let i = 1; i < 4; i++) {
      const xx = Math.round((w * i) / 4) + 0.5
      ctx.moveTo(xx, 0)
      ctx.lineTo(xx, h)
    }
    ctx.stroke()
  }

  if (w >= 128 && h >= 68) {
    ctx.globalAlpha = 0.72
    ctx.fillStyle = theme.textMuted || '#999'
    ctx.font = uiCanvasFont('10px')
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of gridDb) {
      const yy = limiterLevelToY(db, h)
      ctx.fillText(`${db}`, w - 7, clamp(yy, 7, h - 7))
    }
  }

  ctx.restore()
}

function drawCeilingLine(ctx, x, y, w, h, theme, ceilingDb) {
  if (!Number.isFinite(ceilingDb)) return

  ctx.save()
  ctx.translate(x, y)
  ctx.globalAlpha = 0.54
  ctx.strokeStyle = theme.textMuted || theme.grid || '#777'
  ctx.lineWidth = 1
  ctx.setLineDash([5, 5])
  const yy = limiterLevelToY(ceilingDb, h) + 0.5
  ctx.beginPath()
  ctx.moveTo(0, yy)
  ctx.lineTo(w, yy)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function drawLevelLayers(ctx, x, y, w, h, columns, theme) {
  if (!columns || columns.length === 0) return

  const colors = limiterColors(theme)
  const inputColor = theme.textMuted || '#9ca3af'
  const outputColor = colors.output
  const outputDimColor = colors.outputDim

  ctx.save()
  ctx.translate(x, y)

  fillLevelEnvelope(ctx, columns, h, (c) => limiterLevelToY(c.inputDb, h), inputColor, 0.13)
  strokeLinePath(ctx, columns, (c) => limiterLevelToY(c.inputDb, h), inputColor, 1, 0.3)

  fillLevelEnvelope(ctx, columns, h, (c) => limiterLevelToY(c.outputDb, h), outputDimColor, 0.18)
  strokeLinePath(ctx, columns, (c) => limiterLevelToY(c.outEnergyDb, h), outputDimColor, 1, 0.38)
  strokeLinePath(ctx, columns, (c) => limiterLevelToY(c.outputDb, h), outputColor, 1.65, 0.96)

  ctx.restore()
}

function drawGainReductionLayer(ctx, x, y, w, h, columns, theme) {
  if (!columns || columns.length === 0) return
  const hasReduction = columns.some((column) => labelValueForColumn(column) >= 0.18)
  if (!hasReduction) return
  const colors = limiterColors(theme)

  ctx.save()
  ctx.translate(x, y)

  ctx.globalAlpha = 0.2
  ctx.fillStyle = colors.grFill
  ctx.beginPath()
  ctx.moveTo(columns[0].x, 0)
  ctx.lineTo(columns[0].x, limiterGrToY(columns[0].grDb, h))
  for (let i = 1; i < columns.length; i++) {
    ctx.lineTo(columns[i].x, limiterGrToY(columns[i].grDb, h))
  }
  ctx.lineTo(columns[columns.length - 1].x, 0)
  ctx.closePath()
  ctx.fill()

  strokeLinePath(ctx, columns, (c) => limiterGrToY(c.grDb, h), colors.grStroke, 1.35, 0.86)

  ctx.restore()
}

function drawPeakReductionLabels(ctx, x, y, w, h, columns, theme) {
  const labels = pickLimiterGrLabels(columns, w)
  if (labels.length === 0) return
  const colors = limiterColors(theme)

  ctx.save()
  ctx.translate(x, y)
  ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  for (const label of labels) {
    const labelY = clamp(limiterGrToY(label.displayGrDb, h) + 7, 5, h - 16)
    const textWidth = ctx.measureText(label.text).width
    const padX = 5
    const boxX = clamp(label.x - textWidth * 0.5 - padX, 2, w - textWidth - padX * 2 - 2)
    const textX = boxX + textWidth * 0.5 + padX

    ctx.globalAlpha = 0.82
    ctx.fillStyle = theme.surface || theme.bg || '#111'
    ctx.fillRect(boxX, labelY - 2, textWidth + padX * 2, 14)
    ctx.globalAlpha = 1
    ctx.fillStyle = colors.grText
    ctx.fillText(label.text, textX, labelY)
  }

  ctx.restore()
}

function meterWidthForCanvas(w) {
  if (w < 80) return w
  const requested = Math.floor(w * 0.11)
  return Math.min(
    LIMITER_DISPLAY.meterWidthPx,
    Math.max(LIMITER_DISPLAY.meterMinWidthPx, requested),
  )
}

function drawOutputMeter(ctx, x, y, w, h, ring, theme) {
  const meter = meterValuesForContext(ctx, ring)
  const colors = limiterColors(theme)
  const outputColor = colors.output

  if (w < 24) {
    ctx.save()
    ctx.translate(x, y)
    ctx.fillStyle = theme.bg || theme.bgInset || '#080808'
    ctx.fillRect(0, 0, w, h)
    const outputTop = limiterMeterToY(meter.outputDb, h)
    ctx.globalAlpha = 0.92
    ctx.fillStyle = outputColor
    ctx.fillRect(0, outputTop, w, h - outputTop)
    const grHeight = limiterGrToY(meter.gainReductionDb, h)
    if (grHeight > 0) {
      ctx.globalAlpha = 0.78
      ctx.fillStyle = colors.grFill
      ctx.fillRect(0, 0, w, grHeight)
    }
    ctx.restore()
    return
  }

  const ticks = h >= 92 ? LIMITER_DISPLAY.level.gridDb : [0, -12, -24]
  const labelW = w >= 50 ? 18 : 0
  const laneGap = 4
  const laneW = Math.max(5, Math.floor((w - labelW - 10 - laneGap) / 2))
  const outputX = Math.max(labelW + 5, 4)
  const grX = Math.min(w - laneW - 4, outputX + laneW + laneGap)

  ctx.save()
  ctx.translate(x, y)

  ctx.fillStyle = theme.bg || theme.bgInset || '#080808'
  ctx.fillRect(0, 0, w, h)

  ctx.globalAlpha = 0.72
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0.5, 0)
  ctx.lineTo(0.5, h)
  ctx.stroke()

  ctx.globalAlpha = 0.16
  ctx.fillStyle = outputColor
  ctx.fillRect(outputX, 0, laneW, h)
  ctx.fillStyle = colors.grFill
  ctx.fillRect(grX, 0, laneW, h)

  ctx.globalAlpha = 0.46
  ctx.strokeStyle = theme.grid || '#333'
  ctx.beginPath()
  for (const db of ticks) {
    const yy = limiterMeterToY(db, h) + 0.5
    ctx.moveTo(labelW ? labelW + 2 : 2, yy)
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
      ctx.fillText(`${db}`, labelW, clamp(limiterMeterToY(db, h), 7, h - 7))
    }
  }

  const outputTop = limiterMeterToY(meter.outputDb, h)
  ctx.globalAlpha = 0.95
  ctx.fillStyle = outputColor
  ctx.fillRect(outputX, outputTop, laneW, h - outputTop)

  const grHeight = limiterGrToY(meter.gainReductionDb, h)
  if (grHeight > 0) {
    ctx.globalAlpha = 0.9
    ctx.fillStyle = colors.grFill
    ctx.fillRect(grX, 0, laneW, grHeight)
  }

  ctx.globalAlpha = 0.6
  ctx.strokeStyle = theme.grid || '#333'
  ctx.strokeRect(outputX + 0.5, 0.5, laneW - 1, h - 1)
  ctx.strokeRect(grX + 0.5, 0.5, laneW - 1, h - 1)

  ctx.restore()
}

export function drawLimiterRealtime(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)

  if (w < 80) {
    drawOutputMeter(ctx, 0, 0, w, h, ring, theme)
    return
  }

  const meterW = meterWidthForCanvas(w)
  const meterGap = LIMITER_DISPLAY.meterGapPx
  const stripW = Math.max(0, w - meterW - meterGap)
  const stripX = 0
  const stripY = 0
  const stripH = h
  const columns = buildLimiterDisplayHistory(ring, stripW)

  drawPlotGrid(ctx, stripX, stripY, stripW, stripH, theme)

  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const ceilingDb = params && Number.isFinite(params.ceiling)
    ? params.ceiling
    : (last && Number.isFinite(last.ceilingDb) ? last.ceilingDb : null)
  if (ceilingDb !== null) drawCeilingLine(ctx, stripX, stripY, stripW, stripH, theme, ceilingDb)

  drawLevelLayers(ctx, stripX, stripY, stripW, stripH, columns, theme)
  drawGainReductionLayer(ctx, stripX, stripY, stripW, stripH, columns, theme)
  drawPeakReductionLabels(ctx, stripX, stripY, stripW, stripH, columns, theme)
  drawOutputMeter(ctx, w - meterW, 0, meterW, h, ring, theme)
}

export function drawLimiterGainReduction(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)
  const columns = buildLimiterDisplayHistory(ring, w)
  drawGainReductionLayer(ctx, 0, 0, w, h, columns, theme)
  drawPeakReductionLabels(ctx, 0, 0, w, h, columns, theme)
}

export function drawLimiterMeterOnly(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  drawOutputMeter(ctx, 0, 0, w, h, ring, theme)
}

export const LIMITER_PRESETS = Object.freeze({
  limiterRealtime: drawLimiterRealtime,
  limiterGainReduction: drawLimiterGainReduction,
  limiterMeterOnly: drawLimiterMeterOnly,
})

export const LIMITER_VISUALIZER_PRESETS = Object.freeze({
  limiterRealtime: Object.freeze({
    label: 'Limiter Realtime',
    sources: ['limiter.realtime'],
  }),
  limiterGainReduction: Object.freeze({
    label: 'Limiter Gain Reduction',
    sources: ['limiter.gainReductionHistory', 'limiter.realtime'],
  }),
  limiterMeterOnly: Object.freeze({
    label: 'Limiter Meter Only',
    sources: ['limiter.meterOnly', 'limiter.realtime'],
  }),
})

export const LIMITER_SOURCE_DEFAULT_PRESET = Object.freeze({
  'limiter.realtime': 'limiterRealtime',
  'limiter.gainReductionHistory': 'limiterGainReduction',
  'limiter.meterOnly': 'limiterMeterOnly',
})

// Transient processor visualizer painters.
//
// Telemetry comes straight from the engine's TransientBucketAccumulator: each
// bucket carries peak input / output, the fast and slow envelope-follower
// outputs (in dB; NaN in MIDI mode), and a SIGNED gain-change in dB
// (positive = boost, negative = cut). The painters surface "where are
// transients being emphasised or softened?" — not a transfer curve, not a
// limiter wall. The visual language is intentionally distinct from the
// Compressor and Limiter painters.
//
// Design notes:
//   • Stable dB scale for input/output (top-down).
//   • Signed gain-change is drawn as a bipolar fill from a centre line:
//     positive area above, negative area below. This is what "transient
//     emphasis" looks like as a curve.
//   • Fast envelope is highlighted to show where the detector "saw" attacks;
//     slow envelope is shown muted so the eye picks out fast > slow regions.
//   • Smoothing/downsampling mirror the Limiter painter so the panel reads at
//     a similar cadence.

import { uiCanvasFont } from '../../../styles/typography.js'
import { dbToY } from './scaling.js'

export const TRANSIENT_DISPLAY = Object.freeze({
  level: Object.freeze({
    minDb: -60,
    maxDb: 0,
    gridDb: Object.freeze([0, -12, -24, -36, -48]),
  }),
  // Signed gain-change axis: ±maxGainDb is full deflection. Centre line = 0 dB.
  gainChange: Object.freeze({
    maxGainDb: 18,
    boostColor: '#a5f3fc',     // boosting / attack-up
    cutColor:   '#fb923c',     // cutting / sustain-down
    centerColor: '#3f3f46',
  }),
  historyMaxBuckets: 720,
  columnWidthPx: 2,
  smoothing: Object.freeze({
    levelAttack:  0.58,
    levelRelease: 0.24,
    levelPeakHoldDb: 1.1,
    envelopeAttack:  0.40,
    envelopeRelease: 0.18,
    gainAttack:  0.55,
    gainRelease: 0.32,
    meterAttack: 0.72,
    meterRelease: 0.10,
  }),
})

const COLORS = Object.freeze({
  input:      '#9ca3af',
  output:     '#e2e8f0',
  fastEnv:    '#a5f3fc',
  slowEnv:    '#475569',
  thresholdLine: '#71717a',
})

const meterStateByContext = new WeakMap()

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function sanitizeLevelDb(value) {
  const { minDb, maxDb } = TRANSIENT_DISPLAY.level
  return clamp(finiteOr(value, minDb), minDb, maxDb)
}

function sanitizeGainDb(value) {
  const { maxGainDb } = TRANSIENT_DISPLAY.gainChange
  return clamp(finiteOr(value, 0), -maxGainDb, maxGainDb)
}

export function transientLevelToY(db, h) {
  const { minDb, maxDb } = TRANSIENT_DISPLAY.level
  return dbToY(db, minDb, maxDb, Math.max(1, h | 0))
}

// Signed gain → pixel Y in the bipolar gain-change strip. 0 dB sits at h/2,
// positive maps upward toward y=0, negative downward toward y=h-1.
export function transientGainToY(db, h) {
  const { maxGainDb } = TRANSIENT_DISPLAY.gainChange
  const safeH = Math.max(2, h | 0)
  const safeDb = clamp(finiteOr(db, 0), -maxGainDb, maxGainDb)
  const t = (safeDb + maxGainDb) / (2 * maxGainDb)
  return Math.round((1 - t) * (safeH - 1))
}

function collectTransientBuckets(source) {
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
  const columnWidthPx = Math.max(1, finiteOr(options.columnWidthPx, TRANSIENT_DISPLAY.columnWidthPx))
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
  let fastEnvSum = 0, fastEnvCount = 0
  let slowEnvSum = 0, slowEnvCount = 0
  // Track BOTH the most-positive and most-negative gain reading inside the
  // bucket range so a downsampled column can still indicate bipolar activity.
  let maxBoostDb = 0
  let maxCutDb   = 0
  let lastGainDb = 0

  for (let i = start; i < end; i++) {
    const bucket = buckets[i]
    if (!bucket) continue

    if (Number.isFinite(bucket.inLevelDb))  inputDb  = Math.max(inputDb,  bucket.inLevelDb)
    if (Number.isFinite(bucket.outLevelDb)) outputDb = Math.max(outputDb, bucket.outLevelDb)
    if (Number.isFinite(bucket.fastEnvDb)) {
      fastEnvSum += bucket.fastEnvDb
      fastEnvCount++
    }
    if (Number.isFinite(bucket.slowEnvDb)) {
      slowEnvSum += bucket.slowEnvDb
      slowEnvCount++
    }
    if (Number.isFinite(bucket.gainDb)) {
      const g = bucket.gainDb
      if (g > maxBoostDb) maxBoostDb = g
      if (g < maxCutDb)   maxCutDb   = g
      lastGainDb = g
    }
  }

  // Pick the dominant deflection (whichever has larger magnitude wins) so the
  // bipolar fill reads cleanly.
  const dominantGainDb = Math.abs(maxBoostDb) >= Math.abs(maxCutDb) ? maxBoostDb : maxCutDb

  return {
    x: 0,
    inputDb:    sanitizeLevelDb(inputDb),
    outputDb:   sanitizeLevelDb(outputDb),
    fastEnvDb:  sanitizeLevelDb(fastEnvCount ? fastEnvSum / fastEnvCount : sanitizeLevelDb(inputDb)),
    slowEnvDb:  sanitizeLevelDb(slowEnvCount ? slowEnvSum / slowEnvCount : sanitizeLevelDb(inputDb)),
    gainDb:     sanitizeGainDb(dominantGainDb),
    lastGainDb: sanitizeGainDb(lastGainDb),
    boostDb:    sanitizeGainDb(maxBoostDb),
    cutDb:      sanitizeGainDb(maxCutDb),
    hasEnvelope: fastEnvCount > 0 || slowEnvCount > 0,
  }
}

export function downsampleTransientHistory(source, plotWidth, options = {}) {
  const buckets = collectTransientBuckets(source)
  if (buckets.length === 0) return []

  const maxColumns = maxColumnsForWidth(plotWidth, options)
  const historyMaxBuckets = Math.max(
    1,
    Math.floor(finiteOr(options.historyMaxBuckets, TRANSIENT_DISPLAY.historyMaxBuckets)),
  )
  const bucketCount  = Math.min(buckets.length, historyMaxBuckets)
  const bucketStart  = buckets.length - bucketCount
  const columnCount  = Math.min(maxColumns, bucketCount)
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

export function smoothTransientDisplayHistory(columns, options = {}) {
  if (!Array.isArray(columns) || columns.length === 0) return []

  const smoothing = { ...TRANSIENT_DISPLAY.smoothing, ...(options.smoothing || {}) }

  let previousInput     = Number.NaN
  let previousOutput    = Number.NaN
  let previousFastEnv   = Number.NaN
  let previousSlowEnv   = Number.NaN
  let previousGain      = Number.NaN

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
    const fastEnvDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousFastEnv,
        sanitizeLevelDb(column?.fastEnvDb),
        smoothing.envelopeAttack,
        smoothing.envelopeRelease,
      ),
    )
    const slowEnvDb = sanitizeLevelDb(
      smoothRisingFalling(
        previousSlowEnv,
        sanitizeLevelDb(column?.slowEnvDb),
        smoothing.envelopeAttack,
        smoothing.envelopeRelease,
      ),
    )
    const gainDb = sanitizeGainDb(
      smoothRisingFalling(
        previousGain,
        sanitizeGainDb(column?.gainDb),
        smoothing.gainAttack,
        smoothing.gainRelease,
      ),
    )

    previousInput   = inputDb
    previousOutput  = outputDb
    previousFastEnv = fastEnvDb
    previousSlowEnv = slowEnvDb
    previousGain    = gainDb

    return {
      ...column,
      inputDb,
      outputDb,
      fastEnvDb,
      slowEnvDb,
      gainDb,
      boostDb: sanitizeGainDb(column?.boostDb),
      cutDb:   sanitizeGainDb(column?.cutDb),
    }
  })
}

export function buildTransientDisplayHistory(ring, plotWidth, options = {}) {
  return smoothTransientDisplayHistory(
    downsampleTransientHistory(ring, plotWidth, options),
    options,
  )
}

export function computeTransientMeterValues(bucket, previous, options = {}) {
  const smoothing = { ...TRANSIENT_DISPLAY.smoothing, ...(options.smoothing || {}) }
  const targetOutputDb = sanitizeLevelDb(bucket ? bucket.outLevelDb : TRANSIENT_DISPLAY.level.minDb)
  const targetGainDb   = sanitizeGainDb(bucket ? bucket.gainDb : 0)

  const previousOutputDb = Number.isFinite(previous?.outputDb)
    ? sanitizeLevelDb(previous.outputDb)
    : targetOutputDb
  const previousGainDb = Number.isFinite(previous?.gainDb)
    ? sanitizeGainDb(previous.gainDb)
    : targetGainDb

  const outputDb = sanitizeLevelDb(
    smoothRisingFalling(previousOutputDb, targetOutputDb, smoothing.meterAttack, smoothing.meterRelease),
  )
  const gainDb = sanitizeGainDb(
    smoothRisingFalling(previousGainDb, targetGainDb, smoothing.meterAttack, smoothing.meterRelease),
  )

  return {
    outputDb,
    gainDb,
    rawOutputDb: targetOutputDb,
    rawGainDb:   targetGainDb,
  }
}

function meterValuesForContext(ctx, ring) {
  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const previousRecord = meterStateByContext.get(ctx)
  const previous = previousRecord && previousRecord.ring === ring ? previousRecord.values : null
  const next = computeTransientMeterValues(last, previous)
  meterStateByContext.set(ctx, { ring, values: next })
  return next
}

function fillBackground(ctx, w, h, theme) {
  ctx.fillStyle = theme.bgInset || theme.bg || '#090909'
  ctx.fillRect(0, 0, w, h)
}

function drawLevelGrid(ctx, x, y, w, h, theme) {
  const { gridDb } = TRANSIENT_DISPLAY.level

  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.42
  ctx.beginPath()
  for (const db of gridDb) {
    const yy = transientLevelToY(db, h) + 0.5
    ctx.moveTo(0, yy)
    ctx.lineTo(w, yy)
  }
  ctx.stroke()

  if (w >= 128 && h >= 60) {
    ctx.globalAlpha = 0.7
    ctx.fillStyle = theme.textMuted || '#999'
    ctx.font = uiCanvasFont('10px')
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of gridDb) {
      const yy = transientLevelToY(db, h)
      ctx.fillText(`${db}`, w - 6, clamp(yy, 7, h - 7))
    }
  }
  ctx.restore()
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

// Bipolar gain-change strip: positive area above center (boost), negative
// area below (cut). Centre line drawn dim. The columns are pre-smoothed so
// a single curve traces the gain trajectory; the fill below it gives the
// "where is shaping happening" hint.
function drawGainChangeStrip(ctx, x, y, w, h, columns, theme) {
  if (!columns || columns.length === 0) return
  if (h < 8) return
  const centerY = Math.round(h / 2)
  const boostColor = (theme && theme.accent) ? theme.accent : TRANSIENT_DISPLAY.gainChange.boostColor
  const cutColor = TRANSIENT_DISPLAY.gainChange.cutColor

  ctx.save()
  ctx.translate(x, y)

  // Centre line
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = TRANSIENT_DISPLAY.gainChange.centerColor
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, centerY + 0.5)
  ctx.lineTo(w, centerY + 0.5)
  ctx.stroke()

  // Boost fill (positive gain): area between centre line and gainY (where
  // gainY < centerY). We split into two sub-paths so we don't fill across the
  // zero crossing as a single closed shape.
  ctx.globalAlpha = 0.32
  ctx.fillStyle = boostColor
  ctx.beginPath()
  ctx.moveTo(columns[0].x, centerY)
  for (let i = 0; i < columns.length; i++) {
    const yy = transientGainToY(columns[i].gainDb, h)
    ctx.lineTo(columns[i].x, Math.min(yy, centerY))
  }
  ctx.lineTo(columns[columns.length - 1].x, centerY)
  ctx.closePath()
  ctx.fill()

  // Cut fill (negative gain): area between centre and gainY where gainY >
  // centerY.
  ctx.fillStyle = cutColor
  ctx.beginPath()
  ctx.moveTo(columns[0].x, centerY)
  for (let i = 0; i < columns.length; i++) {
    const yy = transientGainToY(columns[i].gainDb, h)
    ctx.lineTo(columns[i].x, Math.max(yy, centerY))
  }
  ctx.lineTo(columns[columns.length - 1].x, centerY)
  ctx.closePath()
  ctx.fill()

  // Curve on top — picks up the boost / cut colour by sign of last value to
  // give the line a usable accent.
  const last = columns[columns.length - 1]
  const trailingColor = (last && last.gainDb < 0) ? cutColor : boostColor
  strokeLinePath(ctx, columns, (c) => transientGainToY(c.gainDb, h), trailingColor, 1.5, 0.95)

  ctx.restore()
}

function drawEnvelopeLayer(ctx, x, y, w, h, columns, hasEnvelope, theme) {
  if (!columns || columns.length === 0) return
  if (!hasEnvelope) return  // MIDI mode: envelopes weren't measured, skip

  const fastEnvColor = (theme && theme.accent) ? theme.accent : COLORS.fastEnv

  ctx.save()
  ctx.translate(x, y)

  // Slow envelope as a soft fill — sustain "floor"
  fillLevelEnvelope(ctx, columns, h, (c) => transientLevelToY(c.slowEnvDb, h), COLORS.slowEnv, 0.18)
  strokeLinePath(ctx, columns, (c) => transientLevelToY(c.slowEnvDb, h), COLORS.slowEnv, 1, 0.55)

  // Fast envelope on top — the transient detector
  strokeLinePath(ctx, columns, (c) => transientLevelToY(c.fastEnvDb, h), fastEnvColor, 1.5, 0.92)

  ctx.restore()
}

function drawInputOutputLayer(ctx, x, y, w, h, columns, theme) {
  if (!columns || columns.length === 0) return

  const outputColor = (theme && theme.accent) ? theme.accent : COLORS.output

  ctx.save()
  ctx.translate(x, y)

  fillLevelEnvelope(ctx, columns, h, (c) => transientLevelToY(c.inputDb, h), COLORS.input, 0.10)
  strokeLinePath(ctx, columns, (c) => transientLevelToY(c.inputDb, h), COLORS.input, 1, 0.30)
  strokeLinePath(ctx, columns, (c) => transientLevelToY(c.outputDb, h), outputColor, 1.5, 0.92)

  ctx.restore()
}

function drawThresholdLine(ctx, x, y, w, h, theme, thresholdDb) {
  if (!Number.isFinite(thresholdDb)) return
  const { minDb } = TRANSIENT_DISPLAY.level
  if (thresholdDb <= minDb + 0.5) return  // floor: don't draw if effectively off

  ctx.save()
  ctx.translate(x, y)
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = theme.textMuted || COLORS.thresholdLine
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  const yy = transientLevelToY(thresholdDb, h) + 0.5
  ctx.beginPath()
  ctx.moveTo(0, yy)
  ctx.lineTo(w, yy)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function drawGainBadge(ctx, x, y, w, h, ring, theme) {
  if (w < 100 || h < 32) return
  const meter = meterValuesForContext(ctx, ring)
  const sign = meter.gainDb >= 0 ? '+' : ''
  const text = `${sign}${meter.gainDb.toFixed(1)} dB`
  const color = meter.gainDb >= 0
    ? ((theme && theme.accent) ? theme.accent : TRANSIENT_DISPLAY.gainChange.boostColor)
    : TRANSIENT_DISPLAY.gainChange.cutColor

  ctx.save()
  ctx.translate(x, y)
  ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  const padX = 6
  const padY = 4
  const metrics = ctx.measureText(text)
  const tw = Math.max(48, Math.ceil(metrics.width || 48))
  const boxW = tw + padX * 2
  const boxH = 18
  const boxX = w - boxW - 8
  const boxY = 8

  ctx.globalAlpha = 0.78
  ctx.fillStyle = theme.surface || theme.bg || '#181818'
  ctx.fillRect(boxX, boxY, boxW, boxH)
  ctx.globalAlpha = 1
  ctx.fillStyle = color
  ctx.fillText(text, boxX + boxW - padX, boxY + padY)
  ctx.restore()
}

// ── Top-level painters (preset entry points) ────────────────────────────────

export function drawTransientShaper(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)

  const columns = buildTransientDisplayHistory(ring, w)
  const hasEnvelope = columns.some((c) => c.hasEnvelope !== false)

  // Two-row layout: top = level/envelope strip, bottom = signed gain-change.
  // When the canvas is short, collapse into a single combined band.
  if (h >= 120) {
    const topH    = Math.round(h * 0.62)
    const gainH   = h - topH - 4
    const gainY   = topH + 4

    drawLevelGrid(ctx, 0, 0, w, topH, theme)

    const last = ring && typeof ring.last === 'function' ? ring.last() : null
    const thresholdDb = (params && Number.isFinite(params.threshold))
      ? params.threshold
      : (last && Number.isFinite(last.thresholdDb) ? last.thresholdDb : null)
    if (thresholdDb !== null) {
      drawThresholdLine(ctx, 0, 0, w, topH, theme, thresholdDb)
    }

    drawEnvelopeLayer(ctx, 0, 0, w, topH, columns, hasEnvelope, theme)
    drawInputOutputLayer(ctx, 0, 0, w, topH, columns, theme)
    drawGainChangeStrip(ctx, 0, gainY, w, gainH, columns, theme)
    drawGainBadge(ctx, 0, 0, w, h, ring, theme)
  } else {
    // Compact mode — overlay gain-change on top of envelope strip.
    drawLevelGrid(ctx, 0, 0, w, h, theme)
    drawEnvelopeLayer(ctx, 0, 0, w, h, columns, hasEnvelope, theme)
    drawInputOutputLayer(ctx, 0, 0, w, h, columns, theme)
    drawGainChangeStrip(ctx, 0, 0, w, h, columns, theme)
  }
}

export function drawTransientEnvelope(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)
  const columns = buildTransientDisplayHistory(ring, w)
  const hasEnvelope = columns.some((c) => c.hasEnvelope !== false)
  drawLevelGrid(ctx, 0, 0, w, h, theme)
  drawEnvelopeLayer(ctx, 0, 0, w, h, columns, hasEnvelope, theme)
  drawInputOutputLayer(ctx, 0, 0, w, h, columns, theme)
}

export function drawTransientGainChange(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)
  const columns = buildTransientDisplayHistory(ring, w)
  drawGainChangeStrip(ctx, 0, 0, w, h, columns, theme)
  drawGainBadge(ctx, 0, 0, w, h, ring, theme)
}

// ── Preset registries ───────────────────────────────────────────────────────

export const TRANSIENT_PRESETS = Object.freeze({
  transientShaper:     drawTransientShaper,
  transientEnvelope:   drawTransientEnvelope,
  transientGainChange: drawTransientGainChange,
})

export const TRANSIENT_VISUALIZER_PRESETS = Object.freeze({
  transientShaper: Object.freeze({
    label: 'Transient Shaper',
    sources: ['transient.shaper'],
  }),
  transientEnvelope: Object.freeze({
    label: 'Transient Envelope',
    sources: ['transient.envelope', 'transient.shaper'],
  }),
  transientGainChange: Object.freeze({
    label: 'Transient Gain Change',
    sources: ['transient.gainChange', 'transient.shaper'],
  }),
})

export const TRANSIENT_SOURCE_DEFAULT_PRESET = Object.freeze({
  'transient.shaper':     'transientShaper',
  'transient.envelope':   'transientEnvelope',
  'transient.gainChange': 'transientGainChange',
})

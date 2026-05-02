// Overdone (3-band multiband) visualizer painters.
//
// Telemetry comes straight from the engine's MultibandBucketAccumulator: each
// bucket carries global input/output peak (dB), per-band peak input/output
// (dB), per-band POSITIVE gain reduction (dB), plus the smoothed depth/time
// and crossover params at bucket end. The painter projects this onto three
// stacked band lanes (LOW / MID / HIGH) with band input + output traces and
// a downward GR fill anchored to the band's input line — so the eye reads
// "where the band started → how much the OTT pulled it down".
//
// The visual language is intentionally distinct from Compressor / Limiter /
// Transient:
//   • Three lanes stacked vertically, equal height. LOW at the top.
//   • Each lane has its own dB axis (-60..0 dB) so band activity is legible
//     even when the levels differ wildly between bands.
//   • GR is drawn as a coloured fill descending from the input line — band
//     output line sits on top, band input line drawn faintly behind.
//   • A bottom strip prints the current crossover frequencies (Lo / Hi) and
//     a per-band GR readout.

import { dbToY } from './scaling.js'

export const MULTIBAND_DISPLAY = Object.freeze({
  level: Object.freeze({
    minDb: -60,
    maxDb: 0,
    gridDb: Object.freeze([0, -12, -24, -36, -48]),
  }),
  gr: Object.freeze({
    maxGrDb: 30,
  }),
  bandColors: Object.freeze({
    low:  '#f97316',  // amber/orange — bass weight
    mid:  '#a3e635',  // lime — mid presence
    high: '#38bdf8',  // sky — high air
  }),
  bandLabels: Object.freeze({
    low:  'LOW',
    mid:  'MID',
    high: 'HIGH',
  }),
  bandKeys: Object.freeze(['low', 'mid', 'high']),
  historyMaxBuckets: 720,
  columnWidthPx: 2,
  smoothing: Object.freeze({
    levelAttack:  0.55,
    levelRelease: 0.22,
    levelPeakHoldDb: 1.0,
    grAttack:  0.6,
    grRelease: 0.22,
    grPeakHoldDb: 0.7,
    meterAttack: 0.7,
    meterRelease: 0.12,
  }),
  footerHeightPx: 22,
})

const COLORS = Object.freeze({
  bandInput:   '#94a3b8',
  bandOutput:  '#e2e8f0',
  laneBorder:  '#1f2937',
  textMuted:   '#94a3b8',
  textStrong:  '#e2e8f0',
})

const meterStateByContext = new WeakMap()

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function sanitizeLevelDb(value) {
  const { minDb, maxDb } = MULTIBAND_DISPLAY.level
  return clamp(finiteOr(value, minDb), minDb, maxDb)
}

function sanitizeGrDb(value, maxDb = MULTIBAND_DISPLAY.gr.maxGrDb) {
  return clamp(finiteOr(value, 0), 0, maxDb)
}

export function multibandLevelToY(db, h) {
  const { minDb, maxDb } = MULTIBAND_DISPLAY.level
  return dbToY(db, minDb, maxDb, Math.max(1, h | 0))
}

// Map a positive GR reading (dB) to a downward fill height inside a lane of
// height `h`. 0 dB GR → 0 px, maxGrDb → ~70 % of h.
export function multibandGrFillHeight(grDb, h) {
  const safeH = Math.max(1, h | 0)
  const safeGr = sanitizeGrDb(grDb)
  const t = safeGr / MULTIBAND_DISPLAY.gr.maxGrDb
  return Math.round(t * (safeH * 0.7))
}

function collectBuckets(source) {
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
  const columnWidthPx = Math.max(1, finiteOr(options.columnWidthPx, MULTIBAND_DISPLAY.columnWidthPx))
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
  // Track per-band peaks and per-band peak GR. Whatever is finite, keep.
  const out = {
    x: 0,
    inputDb: Number.NEGATIVE_INFINITY, outputDb: Number.NEGATIVE_INFINITY,
    bands: {
      low:  { inDb: Number.NEGATIVE_INFINITY, outDb: Number.NEGATIVE_INFINITY, grDb: 0 },
      mid:  { inDb: Number.NEGATIVE_INFINITY, outDb: Number.NEGATIVE_INFINITY, grDb: 0 },
      high: { inDb: Number.NEGATIVE_INFINITY, outDb: Number.NEGATIVE_INFINITY, grDb: 0 },
    },
    depth: 0,
    time: 0,
    lowCrossoverHz:  Number.NaN,
    highCrossoverHz: Number.NaN,
  }

  let lastDepth = 0, lastTime = 0
  let lastLowX = Number.NaN, lastHighX = Number.NaN

  for (let i = start; i < end; i++) {
    const b = buckets[i]
    if (!b) continue
    if (Number.isFinite(b.inputPeakDb))  out.inputDb  = Math.max(out.inputDb,  b.inputPeakDb)
    if (Number.isFinite(b.outputPeakDb)) out.outputDb = Math.max(out.outputDb, b.outputPeakDb)

    if (Number.isFinite(b.lowInputDb))         out.bands.low.inDb  = Math.max(out.bands.low.inDb,  b.lowInputDb)
    if (Number.isFinite(b.lowOutputDb))        out.bands.low.outDb = Math.max(out.bands.low.outDb, b.lowOutputDb)
    if (Number.isFinite(b.lowGainReductionDb)) out.bands.low.grDb  = Math.max(out.bands.low.grDb,  b.lowGainReductionDb)

    if (Number.isFinite(b.midInputDb))         out.bands.mid.inDb  = Math.max(out.bands.mid.inDb,  b.midInputDb)
    if (Number.isFinite(b.midOutputDb))        out.bands.mid.outDb = Math.max(out.bands.mid.outDb, b.midOutputDb)
    if (Number.isFinite(b.midGainReductionDb)) out.bands.mid.grDb  = Math.max(out.bands.mid.grDb,  b.midGainReductionDb)

    if (Number.isFinite(b.highInputDb))         out.bands.high.inDb  = Math.max(out.bands.high.inDb,  b.highInputDb)
    if (Number.isFinite(b.highOutputDb))        out.bands.high.outDb = Math.max(out.bands.high.outDb, b.highOutputDb)
    if (Number.isFinite(b.highGainReductionDb)) out.bands.high.grDb  = Math.max(out.bands.high.grDb,  b.highGainReductionDb)

    if (Number.isFinite(b.depth)) lastDepth = b.depth
    if (Number.isFinite(b.time))  lastTime  = b.time
    if (Number.isFinite(b.lowCrossoverHz))  lastLowX  = b.lowCrossoverHz
    if (Number.isFinite(b.highCrossoverHz)) lastHighX = b.highCrossoverHz
  }

  out.inputDb  = sanitizeLevelDb(out.inputDb)
  out.outputDb = sanitizeLevelDb(out.outputDb)
  for (const k of MULTIBAND_DISPLAY.bandKeys) {
    out.bands[k].inDb  = sanitizeLevelDb(out.bands[k].inDb)
    out.bands[k].outDb = sanitizeLevelDb(out.bands[k].outDb)
    out.bands[k].grDb  = sanitizeGrDb(out.bands[k].grDb)
  }
  out.depth = clamp(finiteOr(lastDepth, 0), 0, 100)
  out.time  = clamp(finiteOr(lastTime,  0), 0, 100)
  out.lowCrossoverHz  = lastLowX
  out.highCrossoverHz = lastHighX
  return out
}

export function downsampleMultibandHistory(source, plotWidth, options = {}) {
  const buckets = collectBuckets(source)
  if (buckets.length === 0) return []

  const maxColumns = maxColumnsForWidth(plotWidth, options)
  const historyMaxBuckets = Math.max(
    1,
    Math.floor(finiteOr(options.historyMaxBuckets, MULTIBAND_DISPLAY.historyMaxBuckets)),
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

export function smoothMultibandDisplayHistory(columns, options = {}) {
  if (!Array.isArray(columns) || columns.length === 0) return []
  const smoothing = { ...MULTIBAND_DISPLAY.smoothing, ...(options.smoothing || {}) }

  const prev = {
    inputDb: Number.NaN, outputDb: Number.NaN,
    low:  { inDb: Number.NaN, outDb: Number.NaN, grDb: Number.NaN },
    mid:  { inDb: Number.NaN, outDb: Number.NaN, grDb: Number.NaN },
    high: { inDb: Number.NaN, outDb: Number.NaN, grDb: Number.NaN },
  }

  return columns.map((column) => {
    const inputDb  = sanitizeLevelDb(smoothRisingFalling(prev.inputDb,  sanitizeLevelDb(column?.inputDb),  smoothing.levelAttack, smoothing.levelRelease, smoothing.levelPeakHoldDb))
    const outputDb = sanitizeLevelDb(smoothRisingFalling(prev.outputDb, sanitizeLevelDb(column?.outputDb), smoothing.levelAttack, smoothing.levelRelease, smoothing.levelPeakHoldDb))
    const bands = {}
    for (const k of MULTIBAND_DISPLAY.bandKeys) {
      const src = column?.bands?.[k] || {}
      const inDb  = sanitizeLevelDb(smoothRisingFalling(prev[k].inDb,  sanitizeLevelDb(src.inDb),  smoothing.levelAttack, smoothing.levelRelease, smoothing.levelPeakHoldDb))
      const outDb = sanitizeLevelDb(smoothRisingFalling(prev[k].outDb, sanitizeLevelDb(src.outDb), smoothing.levelAttack, smoothing.levelRelease, smoothing.levelPeakHoldDb))
      const grDb  = sanitizeGrDb(  smoothRisingFalling(prev[k].grDb,  sanitizeGrDb(src.grDb),     smoothing.grAttack,    smoothing.grRelease,    smoothing.grPeakHoldDb))
      bands[k] = { inDb, outDb, grDb }
      prev[k].inDb  = inDb
      prev[k].outDb = outDb
      prev[k].grDb  = grDb
    }
    prev.inputDb  = inputDb
    prev.outputDb = outputDb

    return { ...column, inputDb, outputDb, bands }
  })
}

export function buildMultibandDisplayHistory(ring, plotWidth, options = {}) {
  return smoothMultibandDisplayHistory(
    downsampleMultibandHistory(ring, plotWidth, options),
    options,
  )
}

// Per-band meter values for the GR readout. Smoothed independently so each
// band's number doesn't jitter.
export function computeMultibandMeterValues(bucket, previous, options = {}) {
  const smoothing = { ...MULTIBAND_DISPLAY.smoothing, ...(options.smoothing || {}) }
  const next = { low: 0, mid: 0, high: 0 }
  for (const k of MULTIBAND_DISPLAY.bandKeys) {
    const target = sanitizeGrDb(
      bucket
        ? (k === 'low'  ? bucket.lowGainReductionDb
         : k === 'mid'  ? bucket.midGainReductionDb
         :                bucket.highGainReductionDb)
        : 0,
    )
    const prev = Number.isFinite(previous?.[k]) ? sanitizeGrDb(previous[k]) : target
    next[k] = sanitizeGrDb(
      smoothRisingFalling(prev, target, smoothing.meterAttack, smoothing.meterRelease),
    )
  }
  return next
}

function meterValuesForContext(ctx, ring) {
  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const previousRecord = meterStateByContext.get(ctx)
  const previous = previousRecord && previousRecord.ring === ring ? previousRecord.values : null
  const next = computeMultibandMeterValues(last, previous)
  meterStateByContext.set(ctx, { ring, values: next })
  return next
}

function fillBackground(ctx, w, h, theme) {
  ctx.fillStyle = theme.bgInset || theme.bg || '#090909'
  ctx.fillRect(0, 0, w, h)
}

function drawLaneGrid(ctx, x, y, w, h, theme) {
  const { gridDb } = MULTIBAND_DISPLAY.level
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = theme.grid || '#333'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.30
  ctx.beginPath()
  for (const db of gridDb) {
    const yy = multibandLevelToY(db, h) + 0.5
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

// GR fill: a coloured ribbon descending from the band's input line down by
// `grHeight` pixels. Visually answers "how much did the OTT pull this band
// down right now?" without overloading the lane with extra axes.
function fillGrRibbon(ctx, columns, h, bandKey, color) {
  if (!columns || columns.length === 0) return
  ctx.save()
  ctx.globalAlpha = 0.32
  ctx.fillStyle = color

  ctx.beginPath()
  // Top edge: input line
  ctx.moveTo(columns[0].x, multibandLevelToY(columns[0].bands?.[bandKey]?.inDb ?? -60, h))
  for (let i = 1; i < columns.length; i++) {
    ctx.lineTo(columns[i].x, multibandLevelToY(columns[i].bands?.[bandKey]?.inDb ?? -60, h))
  }
  // Bottom edge: input line + grHeight (going DOWN — increasing y), reversed
  for (let i = columns.length - 1; i >= 0; i--) {
    const col = columns[i]
    const inY = multibandLevelToY(col.bands?.[bandKey]?.inDb ?? -60, h)
    const grPx = multibandGrFillHeight(col.bands?.[bandKey]?.grDb ?? 0, h)
    ctx.lineTo(col.x, Math.min(h - 1, inY + grPx))
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawBandLane(ctx, x, y, w, h, columns, theme, bandKey, label, grReadoutDb) {
  if (h < 12 || w < 8) return
  const color = MULTIBAND_DISPLAY.bandColors[bandKey]

  ctx.save()
  ctx.translate(x, y)

  // Lane background
  ctx.fillStyle = theme.bg || '#0c0c0c'
  ctx.fillRect(0, 0, w, h)

  // Lane top border
  ctx.strokeStyle = COLORS.laneBorder
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  ctx.moveTo(0, 0.5)
  ctx.lineTo(w, 0.5)
  ctx.stroke()
  ctx.globalAlpha = 1

  drawLaneGrid(ctx, 0, 0, w, h, theme)

  if (columns && columns.length > 0) {
    // Band input fill (faint) + line
    fillLevelEnvelope(
      ctx, columns, h,
      (c) => multibandLevelToY(c.bands?.[bandKey]?.inDb ?? -60, h),
      COLORS.bandInput, 0.10,
    )
    strokeLinePath(
      ctx, columns,
      (c) => multibandLevelToY(c.bands?.[bandKey]?.inDb ?? -60, h),
      COLORS.bandInput, 1, 0.35,
    )

    // GR ribbon under the input line, in band colour
    fillGrRibbon(ctx, columns, h, bandKey, color)

    // Band output line on top, in band colour
    strokeLinePath(
      ctx, columns,
      (c) => multibandLevelToY(c.bands?.[bandKey]?.outDb ?? -60, h),
      color, 1.6, 0.95,
    )
  }

  // Label + GR readout (left-aligned label, right-aligned GR number)
  if (w >= 80 && h >= 24) {
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillStyle = color
    ctx.globalAlpha = 0.95
    ctx.textAlign = 'left'
    ctx.fillText(label, 6, 4)

    const grText = grReadoutDb >= 0.1 ? `-${grReadoutDb.toFixed(1)} dB` : '0.0 dB'
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
    ctx.textAlign = 'right'
    ctx.globalAlpha = grReadoutDb >= 0.4 ? 0.95 : 0.55
    ctx.fillText(grText, w - 6, 4)
  }

  ctx.restore()
}

function drawFooter(ctx, x, y, w, h, ring, theme) {
  if (h < 14 || w < 100) return
  const last = ring && typeof ring.last === 'function' ? ring.last() : null
  const lowHz  = last && Number.isFinite(last.lowCrossoverHz)  ? last.lowCrossoverHz  : null
  const highHz = last && Number.isFinite(last.highCrossoverHz) ? last.highCrossoverHz : null
  const depth  = last && Number.isFinite(last.depth) ? last.depth : null
  const time   = last && Number.isFinite(last.time)  ? last.time  : null

  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = theme.bgInset || '#080808'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = COLORS.laneBorder
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  ctx.moveTo(0, 0.5)
  ctx.lineTo(w, 0.5)
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = theme.textMuted || COLORS.textMuted

  const yMid = Math.round(h / 2)
  const left = []
  if (lowHz !== null)  left.push(`Lo ${formatHz(lowHz)}`)
  if (highHz !== null) left.push(`Hi ${formatHz(highHz)}`)
  ctx.textAlign = 'left'
  if (left.length) ctx.fillText(left.join('  '), 6, yMid)

  const right = []
  if (depth !== null) right.push(`Depth ${depth.toFixed(0)}%`)
  if (time  !== null) right.push(`Time ${time.toFixed(0)}%`)
  ctx.textAlign = 'right'
  if (right.length) ctx.fillText(right.join('  '), w - 6, yMid)

  ctx.restore()
}

function formatHz(hz) {
  if (!Number.isFinite(hz)) return ''
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)}k`
  return `${hz.toFixed(0)}`
}

// ── Top-level painters (preset entry points) ────────────────────────────────

export function drawOverdoneMultiband(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)

  const showFooter = h >= 90
  const footerH = showFooter ? MULTIBAND_DISPLAY.footerHeightPx : 0
  const lanesH = h - footerH
  if (lanesH < 6) return

  const columns = buildMultibandDisplayHistory(ring, w)
  const meter = meterValuesForContext(ctx, ring)

  const laneH = Math.floor(lanesH / 3)
  const remainder = lanesH - laneH * 3

  // LOW lane (top) gets remainder
  const lowH  = laneH + remainder
  const midH  = laneH
  const highH = laneH

  drawBandLane(ctx, 0, 0,                     w, lowH,  columns, theme, 'low',  MULTIBAND_DISPLAY.bandLabels.low,  meter.low)
  drawBandLane(ctx, 0, lowH,                  w, midH,  columns, theme, 'mid',  MULTIBAND_DISPLAY.bandLabels.mid,  meter.mid)
  drawBandLane(ctx, 0, lowH + midH,           w, highH, columns, theme, 'high', MULTIBAND_DISPLAY.bandLabels.high, meter.high)

  if (showFooter) {
    drawFooter(ctx, 0, lanesH, w, footerH, ring, theme)
  }
}

// Bands-only: same band lanes, no footer. Useful for compact embeddings.
export function drawOverdoneBands(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)
  const columns = buildMultibandDisplayHistory(ring, w)
  const meter = meterValuesForContext(ctx, ring)
  const laneH = Math.floor(h / 3)
  const remainder = h - laneH * 3
  drawBandLane(ctx, 0, 0,                  w, laneH + remainder, columns, theme, 'low',  MULTIBAND_DISPLAY.bandLabels.low,  meter.low)
  drawBandLane(ctx, 0, laneH + remainder,  w, laneH,             columns, theme, 'mid',  MULTIBAND_DISPLAY.bandLabels.mid,  meter.mid)
  drawBandLane(ctx, 0, 2 * laneH + remainder, w, laneH,          columns, theme, 'high', MULTIBAND_DISPLAY.bandLabels.high, meter.high)
}

// GR-only: stacked GR bars per band — quick at-a-glance amount of work.
export function drawOverdoneGainReduction(ctx, w, h, ring, theme) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)
  const meter = meterValuesForContext(ctx, ring)
  const laneH = Math.floor(h / 3)
  const remainder = h - laneH * 3
  const yByBand = {
    low:  0,
    mid:  laneH + remainder,
    high: 2 * laneH + remainder,
  }
  const heightByBand = {
    low:  laneH + remainder,
    mid:  laneH,
    high: laneH,
  }

  for (const k of MULTIBAND_DISPLAY.bandKeys) {
    const lh = heightByBand[k]
    const ly = yByBand[k]
    const grDb = meter[k]
    const color = MULTIBAND_DISPLAY.bandColors[k]
    const t = clamp(grDb / MULTIBAND_DISPLAY.gr.maxGrDb, 0, 1)
    const fillW = Math.round((w - 12) * t)

    ctx.save()
    ctx.translate(0, ly)

    ctx.fillStyle = theme.bg || '#0c0c0c'
    ctx.fillRect(0, 0, w, lh)
    ctx.strokeStyle = COLORS.laneBorder
    ctx.globalAlpha = 0.7
    ctx.beginPath()
    ctx.moveTo(0, 0.5); ctx.lineTo(w, 0.5)
    ctx.stroke()
    ctx.globalAlpha = 1

    // Track
    ctx.fillStyle = color
    ctx.globalAlpha = 0.18
    ctx.fillRect(6, Math.round(lh / 2 - 4), w - 12, 8)
    // Fill
    ctx.globalAlpha = 0.92
    ctx.fillRect(6, Math.round(lh / 2 - 4), Math.max(2, fillW), 8)

    if (w >= 80 && lh >= 22) {
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = color
      ctx.textAlign = 'left'
      ctx.globalAlpha = 0.95
      ctx.fillText(MULTIBAND_DISPLAY.bandLabels[k], 6, 10)

      ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
      ctx.textAlign = 'right'
      ctx.globalAlpha = grDb >= 0.4 ? 0.95 : 0.55
      ctx.fillText(grDb >= 0.1 ? `-${grDb.toFixed(1)} dB` : '0.0 dB', w - 6, 10)
    }

    ctx.restore()
  }
}

// ── Preset registries ───────────────────────────────────────────────────────

export const MULTIBAND_PRESETS = Object.freeze({
  overdoneMultiband:     drawOverdoneMultiband,
  overdoneBands:         drawOverdoneBands,
  overdoneGainReduction: drawOverdoneGainReduction,
})

export const MULTIBAND_VISUALIZER_PRESETS = Object.freeze({
  overdoneMultiband: Object.freeze({
    label: 'Overdone Multiband',
    sources: ['overdone.multiband'],
  }),
  overdoneBands: Object.freeze({
    label: 'Overdone Bands',
    sources: ['overdone.bands', 'overdone.multiband'],
  }),
  overdoneGainReduction: Object.freeze({
    label: 'Overdone Gain Reduction',
    sources: ['overdone.gainReduction', 'overdone.multiband'],
  }),
})

// Backwards-friendly alias matching the OVERDONE_* naming used elsewhere.
export const OVERDONE_VISUALIZER_PRESETS = MULTIBAND_VISUALIZER_PRESETS

export const MULTIBAND_SOURCE_DEFAULT_PRESET = Object.freeze({
  'overdone.multiband':     'overdoneMultiband',
  'overdone.bands':         'overdoneBands',
  'overdone.gainReduction': 'overdoneGainReduction',
})

export const OVERDONE_SOURCE_DEFAULT_PRESET = MULTIBAND_SOURCE_DEFAULT_PRESET

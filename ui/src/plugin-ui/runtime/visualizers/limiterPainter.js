// ─── limiterPainter.js ──────────────────────────────────────────────────────
// Pure draw functions for the Limiter visualizer presets. Pro-L-inspired in
// concept (scrolling levels + gain-reduction trace + right-side output meter
// + peak GR labels) but built with Xleth tokens and shapes — no FabFilter
// branding, colours, logo or asset clones.
//
// Each painter is invoked once per rAF tick with:
//   ctx       — Canvas2D rendering context
//   width     — pixel width of the canvas
//   height    — pixel height of the canvas
//   ring      — mutable ring buffer of LimiterBucket objects
//   theme     — { bg, bgInset, surface, text, textMuted, grid, accent, accentDim }
//   params    — current Limiter params (gain, ceiling, release, style)
//
// The ring buckets carry these fields (see ui/src/constants/dynamicsViz.js):
//   inLevelDb       — peak abs of post-gain pre-limit signal (dB)
//   outLevelDb      — peak abs of post-limit output (dB)
//   gainReductionDb — positive dB; 6 means -6 dB GR was applied
//   inEnergyDb      — mean-square dB; an energy-like trace, NOT LUFS
//   outEnergyDb     — same, on output
//   ceilingDb       — smoothed ceiling param at bucket end (dB)
//   gainDb          — smoothed gain param at bucket end (dB)
//   releaseMs       — smoothed release param at bucket end (ms)
//
// No allocations beyond a small constant per call. No React state.

import { dbToY, grToY } from './scaling.js'

// ── Scales ─────────────────────────────────────────────────────────────────
//
// Limiter cares about the loud end of the dB scale. Top of the strip is 0 dB
// (or +6 if you want headroom for hot signals). Bottom is -36 dB for a
// reasonable visual contrast around mastering levels.

const LIMITER_SCALES = Object.freeze({
  level:    { minDb: -36, maxDb: 6  },   // input/output scrolling traces
  meter:    { minDb: -48, maxDb: 0  },   // right-side output meter
  maxGrDb:  18,                          // GR fill caps at 18 dB visually
})

// Right-side output meter takes a fixed slice of the canvas. Same value used
// by the realtime preset and the meter-only preset.
const METER_WIDTH_PX = 36

// Threshold (in positive dB GR) above which a bucket is labelled with its
// reduction value. Avoids label spam on small dips.
const PEAK_LABEL_THRESHOLD_DB = 4

// Minimum horizontal pixel spacing between consecutive peak labels so labels
// don't overlap in dense reduction sections.
const PEAK_LABEL_MIN_SPACING_PX = 56

// ── Helpers ────────────────────────────────────────────────────────────────

function fillBackground(ctx, w, h, theme) {
  ctx.fillStyle = theme.bgInset || theme.bg
  ctx.fillRect(0, 0, w, h)
}

function drawHorizontalGridLines(ctx, x, y, w, h, theme, dbValues, minDb, maxDb) {
  ctx.strokeStyle = theme.grid
  ctx.lineWidth   = 1
  ctx.beginPath()
  for (const db of dbValues) {
    const yy = y + dbToY(db, minDb, maxDb, h) + 0.5
    ctx.moveTo(x, yy)
    ctx.lineTo(x + w, yy)
  }
  ctx.stroke()
}

function drawCeilingLine(ctx, x, y, w, h, theme, ceilingDb, minDb, maxDb) {
  if (!Number.isFinite(ceilingDb)) return
  const yy = y + dbToY(ceilingDb, minDb, maxDb, h) + 0.5
  ctx.strokeStyle = theme.textMuted || theme.grid
  ctx.lineWidth   = 1
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.moveTo(x, yy)
  ctx.lineTo(x + w, yy)
  ctx.stroke()
  ctx.setLineDash([])
}

function buildLevelTrace(ring, w, h, minDb, maxDb, x0, fieldName) {
  // Returns an array of [x, y] pairs for the most recent N buckets, mapped to
  // the scrolling region [x0, x0+w]. Newest sample anchors at right edge.
  if (!ring || ring.count === 0) return null
  const N      = ring.count
  const startX = Math.max(0, w - N)
  const stride = N <= w ? 1 : N / w
  const points = []
  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) === Math.floor((i - 1) / stride)) return
    const px = N <= w ? (x0 + startX + i) : (x0 + Math.round(i / stride))
    const py = dbToY(b[fieldName], minDb, maxDb, h)
    points.push([px, py])
  })
  return points
}

function strokePolyline(ctx, points, color, lineWidth) {
  if (!points || points.length === 0) return
  ctx.strokeStyle = color
  ctx.lineWidth   = lineWidth
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1])
  }
  ctx.stroke()
}

function drawScrollingLevels(ctx, x, y, w, h, ring, theme) {
  const { minDb, maxDb } = LIMITER_SCALES.level
  drawHorizontalGridLines(ctx, x, y, w, h, theme, [0, -6, -12, -24], minDb, maxDb)

  const inputPts  = buildLevelTrace(ring, w, h, minDb, maxDb, x, 'inLevelDb')
  const outputPts = buildLevelTrace(ring, w, h, minDb, maxDb, x, 'outLevelDb')

  // Faint input outline behind the limited output.
  strokePolyline(ctx, inputPts,  theme.textMuted || theme.grid, 1)
  // Output trace on top, accent colour.
  strokePolyline(ctx, outputPts, theme.accent,                   1.5)

  // Optional energy line (cheap RMS-like; LABEL ON UI READS "RMS", NEVER "LUFS").
  const energyPts = buildLevelTrace(ring, w, h, minDb, maxDb, x, 'outEnergyDb')
  if (energyPts) {
    ctx.save()
    ctx.globalAlpha = 0.55
    strokePolyline(ctx, energyPts, theme.accentDim || theme.accent, 1)
    ctx.restore()
  }

  // Translate to the local origin so dbToY returns relative pixels.
  ctx.save()
  ctx.translate(x, y)

  // Draw "RMS" caption at top-left of the strip.
  ctx.fillStyle    = theme.textMuted || theme.text
  ctx.font         = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.textAlign    = 'left'
  ctx.fillText('RMS', 6, 4)

  ctx.restore()
}

function drawGainReductionFill(ctx, x, y, w, h, ring, theme) {
  // GR is drawn as a top-down filled region so transients show as red-orange
  // dips hanging from the top edge — visually similar to Pro-L's GR lobes
  // but built from primitive rects + outline, not their raster.
  if (!ring || ring.count === 0) return

  const maxGrDb = LIMITER_SCALES.maxGrDb
  const N       = ring.count
  const startX  = Math.max(0, w - N)
  const stride  = N <= w ? 1 : N / w

  const fillStyle    = theme.accentDim || theme.accent
  const outlineStyle = theme.accent

  // Two passes for cheap "filled lobe with outline":
  // 1. fill rects pixel-by-pixel.
  // 2. stroke the upper envelope as a 1px line.
  ctx.save()
  ctx.translate(x, y)

  ctx.globalAlpha = 0.45
  ctx.fillStyle   = fillStyle
  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) === Math.floor((i - 1) / stride)) return
    const px = N <= w ? (startX + i) : Math.round(i / stride)
    const grPx = grToY(b.gainReductionDb, maxGrDb, h)
    if (grPx > 0) ctx.fillRect(px, 0, 1, grPx)
  })
  ctx.globalAlpha = 1.0

  ctx.beginPath()
  let first = true
  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) === Math.floor((i - 1) / stride)) return
    const px = N <= w ? (startX + i) : Math.round(i / stride)
    const py = grToY(b.gainReductionDb, maxGrDb, h)
    if (first) { ctx.moveTo(px, py); first = false }
    else ctx.lineTo(px, py)
  })
  ctx.strokeStyle = outlineStyle
  ctx.lineWidth   = 1
  ctx.stroke()

  ctx.restore()
}

function drawPeakReductionLabels(ctx, x, y, w, h, ring, theme) {
  // Find local maxima in GR above PEAK_LABEL_THRESHOLD_DB and label them.
  // Throttled by minimum horizontal spacing.
  if (!ring || ring.count < 3) return

  const maxGrDb = LIMITER_SCALES.maxGrDb
  const N       = ring.count
  const startX  = Math.max(0, w - N)
  const stride  = N <= w ? 1 : N / w

  // Collect indices in order with their pixel-X and GR.
  const items = []
  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) === Math.floor((i - 1) / stride)) return
    const px = N <= w ? (startX + i) : Math.round(i / stride)
    items.push({ px, gr: b.gainReductionDb || 0 })
  })
  if (items.length < 3) return

  ctx.save()
  ctx.translate(x, y)
  ctx.font         = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle    = theme.text || '#ddd'

  let lastLabelPx = -Infinity
  for (let i = 1; i < items.length - 1; i++) {
    const prev = items[i - 1].gr
    const cur  = items[i].gr
    const next = items[i + 1].gr
    if (cur < PEAK_LABEL_THRESHOLD_DB) continue
    if (cur < prev || cur < next) continue          // local max only
    if (items[i].px - lastLabelPx < PEAK_LABEL_MIN_SPACING_PX) continue

    const labelText = `-${cur.toFixed(0)} dB`
    const labelY    = grToY(cur, maxGrDb, h) + 4
    // Soft pill behind the label for legibility.
    const pad = 4
    const tw  = ctx.measureText(labelText).width
    ctx.fillStyle = theme.surface || theme.bg
    ctx.globalAlpha = 0.85
    ctx.fillRect(items[i].px - tw / 2 - pad, labelY - 2, tw + pad * 2, 14)
    ctx.globalAlpha = 1.0

    ctx.fillStyle = theme.text || '#ddd'
    ctx.fillText(labelText, items[i].px, labelY)
    lastLabelPx = items[i].px
  }

  ctx.restore()
}

function drawOutputMeter(ctx, x, y, w, h, ring, theme) {
  // Right-side output level meter with a few dB tick marks. Reads the most
  // recent bucket's outLevelDb. Bar fills from bottom up.
  fillBackground(ctx, w, h, theme)
  ctx.save()
  ctx.translate(x, y)

  const { minDb, maxDb } = LIMITER_SCALES.meter

  // Tick marks
  ctx.strokeStyle = theme.grid
  ctx.lineWidth   = 1
  ctx.fillStyle   = theme.textMuted || theme.text
  ctx.font        = '9px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign   = 'left'
  ctx.textBaseline = 'middle'
  for (const db of [0, -6, -12, -24, -48]) {
    const yy = dbToY(db, minDb, maxDb, h) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, yy)
    ctx.lineTo(8, yy)
    ctx.stroke()
    ctx.fillText(`${db}`, 10, yy)
  }

  // Bar
  const last = ring && ring.last ? ring.last() : null
  if (last && Number.isFinite(last.outLevelDb)) {
    const top = dbToY(last.outLevelDb, minDb, maxDb, h)
    const barX = w - 14
    ctx.fillStyle = theme.accent
    ctx.fillRect(barX, top, 10, h - top)
  }

  ctx.restore()
}

// ── Preset: limiterRealtime ────────────────────────────────────────────────
// Big scrolling levels + gain-reduction lobes + peak GR labels + right-side
// output meter. The flagship preset.

export function drawLimiterRealtime(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  fillBackground(ctx, w, h, theme)

  const meterW = Math.min(METER_WIDTH_PX, Math.max(20, Math.floor(w * 0.08)))
  const stripW = Math.max(0, w - meterW - 4)
  const stripX = 0
  const stripY = 0
  const stripH = h

  // Background grid + ceiling line.
  drawScrollingLevels(ctx, stripX, stripY, stripW, stripH, ring, theme)

  // Ceiling overlay — read from params (smoothed value via UI), or fall back
  // to the most recent bucket's ceilingDb.
  const last = ring && ring.last ? ring.last() : null
  const ceilingDb = (params && Number.isFinite(params.ceiling))
    ? params.ceiling
    : (last && Number.isFinite(last.ceilingDb) ? last.ceilingDb : null)
  const { minDb, maxDb } = LIMITER_SCALES.level
  if (ceilingDb !== null) {
    drawCeilingLine(ctx, stripX, stripY, stripW, stripH, theme, ceilingDb, minDb, maxDb)
  }

  // Gain-reduction lobes overlaid on the levels strip.
  drawGainReductionFill(ctx, stripX, stripY, stripW, stripH, ring, theme)
  drawPeakReductionLabels(ctx, stripX, stripY, stripW, stripH, ring, theme)

  // Right-side output meter.
  drawOutputMeter(ctx, w - meterW, 0, meterW, h, ring, theme)
}

// ── Preset: limiterGainReduction ────────────────────────────────────────────
// GR-only top-down strip. Useful when stacked under another visualisation.

export function drawLimiterGainReduction(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)
  drawGainReductionFill(ctx, 0, 0, w, h, ring, theme)
  drawPeakReductionLabels(ctx, 0, 0, w, h, ring, theme)
}

// ── Preset: limiterMeterOnly ────────────────────────────────────────────────
// Right-side-style output meter rendered across the whole canvas — handy for
// thin sidebars on cramped layouts.

export function drawLimiterMeterOnly(ctx, w, h, ring, theme) {
  if (!ctx || w < 2 || h < 2) return
  drawOutputMeter(ctx, 0, 0, w, h, ring, theme)
}

// ── Preset registry ─────────────────────────────────────────────────────────

export const LIMITER_PRESETS = Object.freeze({
  limiterRealtime:       drawLimiterRealtime,
  limiterGainReduction:  drawLimiterGainReduction,
  limiterMeterOnly:      drawLimiterMeterOnly,
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
  'limiter.realtime':                'limiterRealtime',
  'limiter.gainReductionHistory':    'limiterGainReduction',
  'limiter.meterOnly':               'limiterMeterOnly',
})

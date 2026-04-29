// ─── compressorPainter.js ───────────────────────────────────────────────────
// Pure draw functions for the Compressor visualizer presets. Each painter is
// invoked once per rAF tick with:
//   ctx       — Canvas2D rendering context
//   width     — pixel width of the canvas backing store
//   height    — pixel height of the canvas backing store
//   ring      — mutable ring buffer of CompressorBucket objects
//   theme     — { bg, bgInset, surface, text, textMuted, grid, accent, accentDim }
//   params    — current Compressor parameters (threshold, ratio, knee, makeup)
//   preset    — preset string (e.g. 'levelHistory', 'gainReductionStrip', …)
//
// No React state. No allocations beyond a small constant per call.

import { dbToY, grToY, softKneeOutputDb, SCALES } from './scaling.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function fillBackground(ctx, w, h, theme) {
  ctx.fillStyle = theme.bgInset || theme.bg
  ctx.fillRect(0, 0, w, h)
}

function drawHorizontalGridLines(ctx, w, h, theme, dbValues, minDb, maxDb) {
  ctx.strokeStyle = theme.grid
  ctx.lineWidth   = 1
  ctx.beginPath()
  for (const db of dbValues) {
    const y = dbToY(db, minDb, maxDb, h) + 0.5
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()
}

// ── Preset: levelHistory ────────────────────────────────────────────────────
// Scrolling input + output level traces, dB. Newest sample at right edge.

export function drawLevelHistory(ctx, w, h, ring, theme) {
  if (!ctx || !ring || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)

  const { minDb, maxDb } = SCALES.level
  drawHorizontalGridLines(ctx, w, h, theme, [-12, -24, -48], minDb, maxDb)

  if (ring.count === 0) return

  // Map the most recent N buckets to the right edge. One bucket per pixel
  // when count >= w; otherwise stretch left-to-right.
  const N = ring.count
  const startX = Math.max(0, w - N)
  const stride = N <= w ? 1 : N / w

  // Output trace
  ctx.strokeStyle = theme.accent
  ctx.lineWidth   = 1.5
  ctx.beginPath()
  let first = true
  ring.forEachInOrder((b, i) => {
    if (!b) return
    // Subsample if N > w
    if (stride > 1 && Math.floor(i / stride) !== Math.floor((i - 1) / stride)) return
    const x = N <= w ? startX + i : Math.round(i / stride)
    const y = dbToY(b.outLevelDb, minDb, maxDb, h)
    if (first) { ctx.moveTo(x, y); first = false }
    else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // Input trace (drawn last for layering; muted color)
  ctx.strokeStyle = theme.textMuted
  ctx.lineWidth   = 1
  ctx.beginPath()
  first = true
  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) !== Math.floor((i - 1) / stride)) return
    const x = N <= w ? startX + i : Math.round(i / stride)
    const y = dbToY(b.inLevelDb, minDb, maxDb, h)
    if (first) { ctx.moveTo(x, y); first = false }
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}

// ── Preset: gainReductionStrip ──────────────────────────────────────────────
// Top-down GR strip; 0 dB at top, larger reductions push downward.

export function drawGainReductionStrip(ctx, w, h, ring, theme) {
  if (!ctx || !ring || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)

  const { maxGrDb } = SCALES.gainReduction

  if (ring.count === 0) return

  ctx.fillStyle = theme.accentDim || theme.accent
  const N      = ring.count
  const startX = Math.max(0, w - N)
  const stride = N <= w ? 1 : N / w

  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) !== Math.floor((i - 1) / stride)) return
    const x = N <= w ? startX + i : Math.round(i / stride)
    const grPx = grToY(b.grDb, maxGrDb, h)
    if (grPx > 0) ctx.fillRect(x, 0, 1, grPx)
  })
}

// ── Preset: detector ────────────────────────────────────────────────────────
// Detector envelope (envDB) trace.

export function drawDetector(ctx, w, h, ring, theme) {
  if (!ctx || !ring || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)

  const { minDb, maxDb } = SCALES.level
  drawHorizontalGridLines(ctx, w, h, theme, [-12, -24, -48], minDb, maxDb)

  if (ring.count === 0) return

  ctx.strokeStyle = theme.accent
  ctx.lineWidth   = 1.25
  ctx.beginPath()
  const N      = ring.count
  const startX = Math.max(0, w - N)
  const stride = N <= w ? 1 : N / w
  let first = true
  ring.forEachInOrder((b, i) => {
    if (!b) return
    if (stride > 1 && Math.floor(i / stride) !== Math.floor((i - 1) / stride)) return
    const x = N <= w ? startX + i : Math.round(i / stride)
    const y = dbToY(b.detectorDb, minDb, maxDb, h)
    if (first) { ctx.moveTo(x, y); first = false }
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}

// ── Preset: transferCurveLive ───────────────────────────────────────────────
// Static input→output curve from current params, plus a moving dot for the
// live (ioInDb, ioOutDb) pair from the most recent bucket.

export function drawTransferCurveLive(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)

  const { minDb, maxDb } = SCALES.transfer

  // Axes:
  //   x: 0 = minDb, x: w-1 = maxDb  (left → right == quiet → loud)
  //   y: 0 = maxDb (top), y: h-1 = minDb (bottom)
  const xOf = (db) => Math.round(((db - minDb) / (maxDb - minDb)) * (w - 1))
  const yOf = (db) => Math.round((1 - (db - minDb) / (maxDb - minDb)) * (h - 1))

  // Reference 1:1 line (input == output)
  ctx.strokeStyle = theme.grid
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(xOf(minDb), yOf(minDb))
  ctx.lineTo(xOf(maxDb), yOf(maxDb))
  ctx.stroke()

  // Threshold marker (vertical + horizontal dotted lines)
  if (params && Number.isFinite(params.threshold)) {
    const tx = xOf(params.threshold)
    const ty = yOf(params.threshold)
    ctx.strokeStyle = theme.textMuted
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(tx, 0); ctx.lineTo(tx, h)
    ctx.moveTo(0, ty); ctx.lineTo(w, ty)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Compression curve from params
  if (params && Number.isFinite(params.threshold) && Number.isFinite(params.ratio)) {
    const knee   = Number.isFinite(params.knee)   ? params.knee   : 0
    const makeup = Number.isFinite(params.makeup) ? params.makeup : 0
    ctx.strokeStyle = theme.accent
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    let first = true
    for (let dx = 0; dx <= w - 1; dx += 1) {
      const inDb  = minDb + (dx / (w - 1)) * (maxDb - minDb)
      const outDb = softKneeOutputDb(inDb, params.threshold, params.ratio, knee, makeup)
      const y     = yOf(outDb)
      if (first) { ctx.moveTo(dx, y); first = false }
      else ctx.lineTo(dx, y)
    }
    ctx.stroke()
  }

  // Live dot from the most recent bucket
  const last = ring && ring.last ? ring.last() : null
  if (last && Number.isFinite(last.ioInDb) && Number.isFinite(last.ioOutDb)) {
    const dotX = xOf(last.ioInDb)
    const dotY = yOf(last.ioOutDb)
    ctx.fillStyle = theme.accent
    ctx.beginPath()
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ── Preset: compressorCombined ──────────────────────────────────────────────
// Stacked: top 2/3 = level history, bottom 1/3 = GR strip.

export function drawCompressorCombined(ctx, w, h, ring, theme /*, params */) {
  if (!ctx || w < 2 || h < 2) return
  fillBackground(ctx, w, h, theme)

  const splitY = Math.round(h * 0.66)
  // Top region: levels
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, splitY)
  ctx.clip()
  drawLevelHistory(ctx, w, splitY, ring, theme)
  ctx.restore()

  // Separator line
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, splitY + 0.5); ctx.lineTo(w, splitY + 0.5); ctx.stroke()

  // Bottom region: GR strip
  ctx.save()
  ctx.translate(0, splitY + 1)
  ctx.beginPath()
  ctx.rect(0, 0, w, h - splitY - 1)
  ctx.clip()
  drawGainReductionStrip(ctx, w, h - splitY - 1, ring, theme)
  ctx.restore()
}

// ── Preset registry ─────────────────────────────────────────────────────────

export const COMPRESSOR_PRESETS = Object.freeze({
  levelHistory:        drawLevelHistory,
  gainReductionStrip:  drawGainReductionStrip,
  scrollingStrip:      drawGainReductionStrip,   // alias for the existing layout
  transferCurveLive:   drawTransferCurveLive,
  detector:            drawDetector,
  compressorCombined:  drawCompressorCombined,
})

// Source-key → default preset mapping for visualizer nodes that omit
// "preset" or specify only the source.
export const COMPRESSOR_SOURCE_DEFAULT_PRESET = Object.freeze({
  'compressor.levelHistory':          'levelHistory',
  'compressor.gainReductionHistory':  'gainReductionStrip',
  'compressor.transferCurve':         'transferCurveLive',
  'compressor.detector':              'detector',
  'compressor.combined':              'compressorCombined',
})

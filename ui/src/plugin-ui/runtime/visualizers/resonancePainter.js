// Resonance Suppressor visualizer painters.
//
// Buckets are emitted by the engine as fixed-size log-frequency arrays:
//   spectrum[128]   normalized magnitude, range [0, 1]
//   reduction[128]  normalized gain reduction, range [0, 1]
//   weighting[128]  suppression sensitivity scalar, range [0, 2.5]
// Bucket metadata also carries: sampleRate, fftSize, qualityIndex, stereoMode,
// activity, maxReductionDb.
//
// The painter only renders these values; it never analyses audio or edits the
// curve. Draggable curve-node editing is a later phase.

// Static frequency tick set used for labels and grid lines.
const FREQ_TICKS = Object.freeze([
  { hz: 50,    text: '50' },
  { hz: 100,   text: '100' },
  { hz: 200,   text: '200' },
  { hz: 500,   text: '500' },
  { hz: 1000,  text: '1k' },
  { hz: 2000,  text: '2k' },
  { hz: 5000,  text: '5k' },
  { hz: 10000, text: '10k' },
  { hz: 20000, text: '20k' },
])

const FREQ_MIN_HZ = 20
const FREQ_MAX_HZ = 20000

const COLORS = Object.freeze({
  spectrumFill: 'rgba(56, 189, 248, 0.14)',
  spectrumLine: '#7dd3fc',
  reductionFill: 'rgba(45, 212, 191, 0.16)',
  reductionLine: '#2dd4bf',
  weightingLine: '#b9f2ff',
  weightingMid:  'rgba(82, 229, 255, 0.32)',
  boundary:      'rgba(226, 241, 255, 0.34)',
})

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function latestBucket(source) {
  if (!source) return null
  if (Array.isArray(source)) return source.length ? source[source.length - 1] : null
  if (typeof source.last === 'function') return source.last()
  return null
}

function valueArray(bucket, key) {
  const arr = bucket?.[key]
  return Array.isArray(arr) ? arr : []
}

function freqToX(hz, w) {
  const safe = clamp(finiteOr(hz, FREQ_MIN_HZ), FREQ_MIN_HZ, FREQ_MAX_HZ)
  const norm = Math.log(safe / FREQ_MIN_HZ) / Math.log(FREQ_MAX_HZ / FREQ_MIN_HZ)
  return clamp(norm, 0, 1) * Math.max(1, w - 1)
}

function indexToX(i, n, w) {
  if (n <= 1) return 0
  return (i / (n - 1)) * Math.max(1, w - 1)
}

function clearBackground(ctx, w, h, theme) {
  ctx.save()
  ctx.fillStyle = theme?.bgInset || theme?.bg || '#0b0f14'
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

function drawGrid(ctx, w, h, theme) {
  ctx.save()
  ctx.strokeStyle = theme?.grid || '#223042'
  ctx.lineWidth = 1

  // Vertical frequency ticks
  ctx.globalAlpha = 0.55
  ctx.beginPath()
  for (const tick of FREQ_TICKS) {
    const x = Math.round(freqToX(tick.hz, w)) + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Horizontal magnitude reference lines
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  for (const yNorm of [0.25, 0.5, 0.75]) {
    const y = Math.round(yNorm * h) + 0.5
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()

  // Frequency labels (only when there's enough vertical room)
  if (h >= 70 && w >= 240) {
    ctx.globalAlpha = 0.85
    ctx.fillStyle = theme?.textMuted || '#8a98a8'
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const tick of FREQ_TICKS) {
      const x = freqToX(tick.hz, w)
      if (x < 12 || x > w - 12) continue
      ctx.fillText(tick.text, x, h - 2)
    }
  }
  ctx.restore()
}

function drawBoundaryLines(ctx, w, h, theme, params) {
  if (!params) return
  const hp = Number.isFinite(params.wc_hp) ? params.wc_hp : null
  const lp = Number.isFinite(params.wc_lp) ? params.wc_lp : null
  if (hp == null && lp == null) return

  ctx.save()
  ctx.strokeStyle = COLORS.boundary
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  if (hp != null) {
    const x = Math.round(freqToX(hp, w)) + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  if (lp != null) {
    const x = Math.round(freqToX(lp, w)) + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function drawSpectrum(ctx, values, w, h) {
  if (!values.length) return

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let i = 0; i < values.length; i++) {
    const v = clamp(finiteOr(values[i], 0), 0, 1)
    ctx.lineTo(indexToX(i, values.length, w), h - v * h * 0.92)
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = COLORS.spectrumFill
  ctx.fill()

  ctx.beginPath()
  for (let i = 0; i < values.length; i++) {
    const v = clamp(finiteOr(values[i], 0), 0, 1)
    const x = indexToX(i, values.length, w)
    const y = h - v * h * 0.92
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = COLORS.spectrumLine
  ctx.globalAlpha = 0.65
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.restore()
}

function drawReduction(ctx, values, w, h) {
  if (!values.length) return

  ctx.save()
  // Translucent fill from the top
  ctx.beginPath()
  ctx.moveTo(0, 0)
  for (let i = 0; i < values.length; i++) {
    const v = clamp(finiteOr(values[i], 0), 0, 1)
    const x = indexToX(i, values.length, w)
    const y = v * h * 0.55
    ctx.lineTo(x, y)
  }
  ctx.lineTo(w, 0)
  ctx.closePath()
  ctx.fillStyle = COLORS.reductionFill
  ctx.fill()

  // Bright stroke at the bottom edge of the reduction region
  ctx.beginPath()
  for (let i = 0; i < values.length; i++) {
    const v = clamp(finiteOr(values[i], 0), 0, 1)
    const x = indexToX(i, values.length, w)
    const y = v * h * 0.55
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = COLORS.reductionLine
  ctx.lineWidth = 1.6
  ctx.globalAlpha = 0.60
  ctx.stroke()
  ctx.restore()
}

function drawWeighting(ctx, values, w, h) {
  if (!values.length) return

  ctx.save()
  // Centerline at weighting=1 ("neutral sensitivity"), values map [0, 2.5]
  // onto the canvas with 1.0 sitting at vertical mid.
  ctx.strokeStyle = COLORS.weightingMid
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  const midY = Math.round(h - (1 / 2.5) * h) + 0.5
  ctx.beginPath()
  ctx.moveTo(0, midY)
  ctx.lineTo(w, midY)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.beginPath()
  for (let i = 0; i < values.length; i++) {
    const v = clamp(finiteOr(values[i], 0), 0, 2.5) / 2.5
    const x = indexToX(i, values.length, w)
    const y = h - v * h
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = COLORS.weightingLine
  ctx.lineWidth = 1.8
  ctx.globalAlpha = 0.9
  ctx.stroke()
  ctx.restore()
}

function drawNoSignal(ctx, w, h, theme) {
  if (w < 80 || h < 32) return
  ctx.save()
  ctx.fillStyle = theme?.textMuted || '#8a98a8'
  ctx.globalAlpha = 0.65
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('No signal yet', w / 2, h / 2)
  ctx.restore()
}

function drawActivityChip(ctx, w, h, bucket) {
  const activity = clamp(finiteOr(bucket?.activity, 0), 0, 1)
  if (activity <= 0) return
  const r = 4
  ctx.save()
  ctx.globalAlpha = 0.4 + 0.6 * activity
  ctx.fillStyle = COLORS.reductionLine
  ctx.beginPath()
  ctx.arc(w - 10, 10, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export function drawResonanceCombined(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  clearBackground(ctx, w, h, theme)
  drawGrid(ctx, w, h, theme)

  const bucket = latestBucket(ring)
  if (!bucket) {
    drawBoundaryLines(ctx, w, h, theme, params)
    drawNoSignal(ctx, w, h, theme)
    return
  }

  drawSpectrum(ctx, valueArray(bucket, 'spectrum'), w, h)
  drawWeighting(ctx, valueArray(bucket, 'weighting'), w, h)
  drawReduction(ctx, valueArray(bucket, 'reduction'), w, h)
  drawBoundaryLines(ctx, w, h, theme, params)
  drawActivityChip(ctx, w, h, bucket)
}

export function drawResonanceSpectrum(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  clearBackground(ctx, w, h, theme)
  drawGrid(ctx, w, h, theme)
  const bucket = latestBucket(ring)
  drawSpectrum(ctx, valueArray(bucket, 'spectrum'), w, h)
  drawBoundaryLines(ctx, w, h, theme, params)
}

export function drawResonanceReduction(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  clearBackground(ctx, w, h, theme)
  drawGrid(ctx, w, h, theme)
  const bucket = latestBucket(ring)
  drawReduction(ctx, valueArray(bucket, 'reduction'), w, h)
  drawActivityChip(ctx, w, h, bucket)
  drawBoundaryLines(ctx, w, h, theme, params)
}

export function drawResonanceWeighting(ctx, w, h, ring, theme, params) {
  if (!ctx || w < 4 || h < 4) return
  clearBackground(ctx, w, h, theme)
  drawGrid(ctx, w, h, theme)
  const bucket = latestBucket(ring)
  drawWeighting(ctx, valueArray(bucket, 'weighting'), w, h)
  drawBoundaryLines(ctx, w, h, theme, params)
}

export const RESONANCE_PRESETS = Object.freeze({
  resonanceCombined:  drawResonanceCombined,
  resonanceSpectrum:  drawResonanceSpectrum,
  resonanceReduction: drawResonanceReduction,
  resonanceWeighting: drawResonanceWeighting,
})

export const RESONANCE_VISUALIZER_PRESETS = Object.freeze({
  resonanceCombined:  Object.freeze({ label: 'Resonance Combined',  sources: ['resonance.combined'] }),
  resonanceSpectrum:  Object.freeze({ label: 'Resonance Spectrum',  sources: ['resonance.spectrum', 'resonance.combined'] }),
  resonanceReduction: Object.freeze({ label: 'Resonance Reduction', sources: ['resonance.reduction', 'resonance.combined'] }),
  resonanceWeighting: Object.freeze({ label: 'Resonance Weighting', sources: ['resonance.weighting', 'resonance.combined'] }),
})

export const RESONANCE_SOURCE_DEFAULT_PRESET = Object.freeze({
  'resonance.combined':  'resonanceCombined',
  'resonance.spectrum':  'resonanceSpectrum',
  'resonance.reduction': 'resonanceReduction',
  'resonance.weighting': 'resonanceWeighting',
})

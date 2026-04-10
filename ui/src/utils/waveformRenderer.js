/**
 * Shared multi-resolution waveform renderer.
 *
 * Accepts stride-3 peak data [min, max, rms, ...] from WaveformMipmap
 * and draws in one of four zoom regimes:
 *
 *   envelope  (spp > 80)     — filled min/max envelope + semi-transparent RMS body
 *   trace     (8 < spp ≤ 80) — thin filled min/max + 1px midpoint stroke
 *   waveform  (0.5 ≤ spp ≤ 8) — connected line through sample-level peaks
 *   sample    (spp < 0.5)    — individual sample dots with connecting lines
 *
 * All coordinates are in CSS pixels — the caller must have already applied
 * DPR scaling via ctx.setTransform(dpr, 0, 0, dpr, 0, 0).
 */

// ── Regime detection ────────────────────────────────────────────────────────

const SPP_ENVELOPE  = 200  // above this → envelope
const SPP_TRACE     = 8    // above this → trace; at or below → waveform
const SPP_SAMPLE    = 0.5  // below this → sample points
const HYSTERESIS    = 1.3  // 30% band to prevent flicker

/**
 * Determine rendering regime from samples-per-pixel.
 * Pass the previous regime to enable hysteresis at boundaries.
 */
export function getRegime(spp, prev = 'envelope') {
  if (prev === 'envelope') {
    if (spp <= SPP_SAMPLE)  return 'sample'
    if (spp <= SPP_TRACE)   return 'waveform'
    if (spp <= SPP_ENVELOPE) return 'trace'
    return 'envelope'
  }
  if (prev === 'trace') {
    if (spp > SPP_ENVELOPE * HYSTERESIS) return 'envelope'
    if (spp < SPP_TRACE / HYSTERESIS)    return 'waveform'
    return 'trace'
  }
  if (prev === 'waveform') {
    if (spp > SPP_TRACE * HYSTERESIS)  return 'trace'
    if (spp < SPP_SAMPLE / HYSTERESIS) return 'sample'
    return 'waveform'
  }
  if (prev === 'sample') {
    if (spp > SPP_SAMPLE * HYSTERESIS) return 'waveform'
    return 'sample'
  }
  // fallback (no previous state)
  if (spp <= SPP_SAMPLE)  return 'sample'
  if (spp <= SPP_TRACE)   return 'waveform'
  if (spp <= SPP_ENVELOPE) return 'trace'
  return 'envelope'
}

// ── Envelope mode (spp > 4) ─────────────────────────────────────────────────

/**
 * Draw filled min/max envelope with optional RMS body overlay.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} peaks      stride-3 array [min, max, rms, ...]
 * @param {number}   x          left edge (CSS px)
 * @param {number}   y          top edge
 * @param {number}   w          width
 * @param {number}   h          height
 * @param {number}   startCol   first peak column index
 * @param {number}   endCol     past-the-end peak column index
 * @param {string}   fillColor  envelope fill (rgba string)
 * @param {string}   [rmsColor] RMS body fill — omit to skip
 */
export function drawEnvelope(ctx, peaks, x, y, w, h, startCol, endCol, fillColor, rmsColor) {
  const cols = endCol - startCol
  if (cols <= 0) return

  const mid = y + h / 2
  const amp = h * 0.5
  const step = w / cols

  // Filled envelope (min → max)
  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    const maxVal = peaks[idx + 1] || 0
    if (j === 0) ctx.moveTo(px, mid - maxVal * amp)
    else         ctx.lineTo(px, mid - maxVal * amp)
  }
  for (let j = cols - 1; j >= 0; j--) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    const minVal = peaks[idx] || 0
    ctx.lineTo(px, mid - minVal * amp)
  }
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()

  // RMS body overlay (narrower, brighter)
  if (rmsColor) {
    ctx.beginPath()
    for (let j = 0; j < cols; j++) {
      const idx = (startCol + j) * 3
      const px  = x + j * step + step / 2
      const rms = peaks[idx + 2] || 0
      if (j === 0) ctx.moveTo(px, mid - rms * amp)
      else         ctx.lineTo(px, mid - rms * amp)
    }
    for (let j = cols - 1; j >= 0; j--) {
      const idx = (startCol + j) * 3
      const px  = x + j * step + step / 2
      const rms = peaks[idx + 2] || 0
      ctx.lineTo(px, mid + rms * amp)
    }
    ctx.closePath()
    ctx.fillStyle = rmsColor
    ctx.fill()
  }
}

// ── Trace mode (8 < spp ≤ 80) ──────────────────────────────────────────────

/**
 * Draw thin filled min/max region with a 1px midpoint stroke.
 * Provides oscillation detail that envelope mode hides, using the same
 * peak data but rendering as a narrow path instead of thick filled polygons.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} peaks      stride-3 array [min, max, rms, ...]
 * @param {number}   x          left edge (CSS px)
 * @param {number}   y          top edge
 * @param {number}   w          width
 * @param {number}   h          height
 * @param {number}   startCol   first peak column index
 * @param {number}   endCol     past-the-end peak column index
 * @param {string}   fillColor  thin envelope fill (rgba string)
 * @param {string}   strokeColor midpoint line colour
 */
export function drawTrace(ctx, peaks, x, y, w, h, startCol, endCol, fillColor, strokeColor) {
  const cols = endCol - startCol
  if (cols <= 0) return

  const mid  = y + h / 2
  const amp  = h * 0.45
  const step = w / cols

  // Thin filled region between min and max
  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    const maxVal = peaks[idx + 1] || 0
    if (j === 0) ctx.moveTo(px, mid - maxVal * amp)
    else         ctx.lineTo(px, mid - maxVal * amp)
  }
  for (let j = cols - 1; j >= 0; j--) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    const minVal = peaks[idx] || 0
    ctx.lineTo(px, mid - minVal * amp)
  }
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()

  // 1px midpoint stroke through (min+max)/2
  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    const val = ((peaks[idx] || 0) + (peaks[idx + 1] || 0)) / 2
    if (j === 0) ctx.moveTo(px, mid - val * amp)
    else         ctx.lineTo(px, mid - val * amp)
  }
  ctx.strokeStyle = strokeColor
  ctx.lineWidth   = 1
  ctx.stroke()
}

// ── Waveform-line mode (0.5 ≤ spp ≤ 8) ─────────────────────────────────────

/**
 * Draw connected waveform line through peak centres.
 * At ~1 spp the average of min/max closely approximates the true sample value.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} peaks       stride-3 array
 * @param {number}   x           left edge
 * @param {number}   y           top edge
 * @param {number}   w           width
 * @param {number}   h           height
 * @param {number}   startCol    first column
 * @param {number}   endCol      past-the-end column
 * @param {string}   strokeColor line colour
 * @param {number}   [lineWidth=1.5]
 */
export function drawWaveformLine(ctx, peaks, x, y, w, h, startCol, endCol, strokeColor, lineWidth = 1.5) {
  const cols = endCol - startCol
  if (cols <= 0) return

  const mid  = y + h / 2
  const amp  = h * 0.45
  const step = w / cols

  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    // Average of min + max approximates the sample value at ~1 spp
    const val = ((peaks[idx] || 0) + (peaks[idx + 1] || 0)) / 2
    if (j === 0) ctx.moveTo(px, mid - val * amp)
    else         ctx.lineTo(px, mid - val * amp)
  }
  ctx.strokeStyle = strokeColor
  ctx.lineWidth   = lineWidth
  ctx.stroke()
}

// ── Sample-point mode (spp < 0.5) ──────────────────────────────────────────

/**
 * Draw individual sample points with connecting lines.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} samples      flat array of float sample values
 * @param {number}   x, y, w, h   drawing rect
 * @param {number}   startIdx     first sample index in array
 * @param {number}   count        number of samples to draw
 * @param {string}   strokeColor  line + dot colour
 * @param {number}   [dotRadius]  auto-computed from spacing if omitted
 */
export function drawSamplePoints(ctx, samples, x, y, w, h, startIdx, count, strokeColor, dotRadius) {
  if (count <= 0) return

  const mid  = y + h / 2
  const amp  = h * 0.45
  const step = w / count
  const dotR = dotRadius ?? Math.min(3, Math.max(1.5, step * 0.25))

  // Connecting lines
  ctx.beginPath()
  for (let j = 0; j < count; j++) {
    const px  = x + j * step + step / 2
    const val = samples[startIdx + j] || 0
    if (j === 0) ctx.moveTo(px, mid - val * amp)
    else         ctx.lineTo(px, mid - val * amp)
  }
  ctx.strokeStyle = strokeColor
  ctx.lineWidth   = 1
  ctx.stroke()

  // Dots (skip if too small to see)
  if (dotR >= 1) {
    ctx.fillStyle = strokeColor
    for (let j = 0; j < count; j++) {
      const px  = x + j * step + step / 2
      const val = samples[startIdx + j] || 0
      const py  = mid - val * amp
      ctx.beginPath()
      ctx.arc(px, py, dotR, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Zero-crossing line
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth   = 0.5
  ctx.beginPath()
  ctx.moveTo(x, mid + 0.5)
  ctx.lineTo(x + w, mid + 0.5)
  ctx.stroke()
}

// ── Downsample helpers ──────────────────────────────────────────────────────

/**
 * Downsample stride-3 peak data [min,max,rms,...] to a target column count.
 * Returns a new stride-3 array. RMS is aggregated via root-mean-square.
 */
export function downsamplePeaks3(peaks, targetCols) {
  const srcCols = Math.floor(peaks.length / 3)
  if (srcCols <= targetCols) return peaks

  const result = new Array(targetCols * 3)
  const ratio  = srcCols / targetCols

  for (let i = 0; i < targetCols; i++) {
    const s = Math.floor(i * ratio)
    const e = Math.min(srcCols, Math.ceil((i + 1) * ratio))
    let min = 0, max = 0, rmsSum = 0
    for (let j = s; j < e; j++) {
      const idx = j * 3
      if (peaks[idx]     < min) min = peaks[idx]
      if (peaks[idx + 1] > max) max = peaks[idx + 1]
      rmsSum += (peaks[idx + 2] || 0) ** 2
    }
    const idx = i * 3
    result[idx]     = min
    result[idx + 1] = max
    result[idx + 2] = Math.sqrt(rmsSum / Math.max(1, e - s))
  }
  return result
}

/**
 * Downsample interleaved [min, max] pairs (stride-2) to a target column count.
 * Kept for backwards compatibility with components that still use legacy data.
 */
export function downsamplePeaks2(peaks, targetCols) {
  const srcCols = peaks.length / 2
  if (srcCols <= targetCols) return peaks

  const result = new Array(targetCols * 2)
  const ratio  = srcCols / targetCols

  for (let i = 0; i < targetCols; i++) {
    const start = Math.floor(i * ratio) * 2
    const end   = Math.ceil((i + 1) * ratio) * 2
    let min = 0, max = 0
    for (let j = start; j < end; j += 2) {
      if (peaks[j]     < min) min = peaks[j]
      if (peaks[j + 1] > max) max = peaks[j + 1]
    }
    result[i * 2]     = min
    result[i * 2 + 1] = max
  }
  return result
}

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

// ── Column decimation ───────────────────────────────────────────────────────
//
// Peak arrays are sized by SOURCE DURATION, never by how many pixels the clip
// occupies: TimelineView fetches round(durSec * 200) columns with an
// 800-column floor, so a 15 s region carries 3000 columns and a 60 ms syllable
// slice still carries 800. The draw functions below used to walk every one of
// them with step = w / cols, emitting several canvas path points per column —
// so a 30 px-wide clip could issue ~12k path operations, and a timeline with
// 200 such clips visible spent its whole frame budget rasterising detail far
// finer than one pixel.
//
// Decimation collapses the source columns into at most MAX_COLS_PER_PX buckets
// per drawn pixel. Each bucket keeps the MIN of the mins and the MAX of the
// maxes over its source range, so transients survive: this is peak-preserving
// aggregation, not subsampling, and the silhouette is identical to what the
// undecimated path drew — it just stops emitting sub-pixel geometry the
// rasteriser was going to collapse anyway. RMS aggregates by max for the same
// reason (averaging would visibly thin the body at high decimation ratios).
//
// The numeric scan is still O(source columns); only the CANVAS work becomes
// O(pixels). That is the right trade — a min/max loop over a few thousand
// floats is microseconds, while a path with a few thousand nodes is not.

const MAX_COLS_PER_PX = 2

// Scratch buffers, reused across every call. The timeline decimates once per
// visible clip per frame (hundreds of calls), so allocating here would hand
// the GC a few hundred typed arrays every frame.
let _decMin = new Float32Array(0)
let _decMax = new Float32Array(0)
let _decRms = new Float32Array(0)

function ensureDecScratch(n) {
  if (_decMin.length >= n) return
  _decMin = new Float32Array(n)
  _decMax = new Float32Array(n)
  _decRms = new Float32Array(n)
}

/**
 * Bucket [startCol, endCol) down to at most MAX_COLS_PER_PX * w columns.
 *
 * Returns null when the source already fits the pixel budget — callers treat
 * null as "read the raw peaks array directly", which keeps the common
 * already-fine-enough case free of any copying.
 *
 * The returned arrays are shared scratch: read them before the next call.
 *
 * @returns {{min:Float32Array, max:Float32Array, rms:Float32Array, count:number}|null}
 */
export function decimatePeaks(peaks, startCol, endCol, w) {
  const cols = endCol - startCol
  if (cols <= 0) return null
  const budget = Math.max(1, Math.ceil(Math.max(1, w) * MAX_COLS_PER_PX))
  if (cols <= budget) return null

  ensureDecScratch(budget)
  for (let b = 0; b < budget; b++) {
    const c0 = startCol + Math.floor((b * cols) / budget)
    let c1 = startCol + Math.floor(((b + 1) * cols) / budget)
    if (c1 <= c0) c1 = c0 + 1

    let mn = Infinity
    let mx = -Infinity
    let rms = 0
    for (let c = c0; c < c1; c++) {
      const idx = c * 3
      const lo = peaks[idx] || 0
      const hi = peaks[idx + 1] || 0
      const rv = peaks[idx + 2] || 0
      if (lo < mn) mn = lo
      if (hi > mx) mx = hi
      if (rv > rms) rms = rv
    }
    _decMin[b] = mn === Infinity ? 0 : mn
    _decMax[b] = mx === -Infinity ? 0 : mx
    _decRms[b] = rms
  }
  return { min: _decMin, max: _decMax, rms: _decRms, count: budget }
}

/**
 * Narrow a [startCol, endCol) span to just the columns that land inside a
 * visible pixel range, returning the sub-rect they occupy.
 *
 * The timeline's low-res fallback path draws a clip by mapping its whole peak
 * span across its whole width — correct, but wasteful once a clip is wider
 * than the viewport. A 62-beat clip at 229 px/beat is ~14,000 px wide, so at a
 * 1600 px viewport roughly 89% of the columns it walked were emitted purely
 * for the canvas clip rect to throw away. Zoomed in, that waste dominates:
 * decimation cannot help there, because at high zoom the peak data is
 * genuinely coarser than the pixels and there is nothing to collapse.
 *
 * This is exact, not approximate: the retained columns keep the pixel
 * positions they had in the full-width draw (the returned x/w are aligned to
 * column boundaries, not to the requested visL/visR), so the output is
 * identical to the clipped result of drawing everything.
 *
 * @returns {{startCol:number, endCol:number, x:number, w:number}|null}
 *   null when nothing in the span is visible.
 */
export function visibleColumnWindow(x, w, startCol, endCol, visL, visR) {
  const cols = endCol - startCol
  if (cols <= 0 || !(w > 0)) return null

  const f0 = Math.max(0, Math.min(1, (visL - x) / w))
  const f1 = Math.max(0, Math.min(1, (visR - x) / w))
  if (f1 <= f0) return null

  const c0 = startCol + Math.floor(f0 * cols)
  const c1 = Math.min(endCol, startCol + Math.ceil(f1 * cols))
  if (c1 <= c0) return null

  const step = w / cols
  return { startCol: c0, endCol: c1, x: x + (c0 - startCol) * step, w: (c1 - c0) * step }
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
  if (endCol - startCol <= 0) return

  const dec = decimatePeaks(peaks, startCol, endCol, w)
  const dMin = dec ? dec.min : null
  const dMax = dec ? dec.max : null
  const dRms = dec ? dec.rms : null
  const cols = dec ? dec.count : endCol - startCol

  const mid = y + h / 2
  const amp = h * 0.5
  const step = w / cols

  // Filled envelope (min → max)
  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const px  = x + j * step + step / 2
    const maxVal = dec ? dMax[j] : (peaks[(startCol + j) * 3 + 1] || 0)
    if (j === 0) ctx.moveTo(px, mid - maxVal * amp)
    else         ctx.lineTo(px, mid - maxVal * amp)
  }
  for (let j = cols - 1; j >= 0; j--) {
    const px  = x + j * step + step / 2
    const minVal = dec ? dMin[j] : (peaks[(startCol + j) * 3] || 0)
    ctx.lineTo(px, mid - minVal * amp)
  }
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()

  // RMS body overlay (narrower, brighter)
  if (rmsColor) {
    ctx.beginPath()
    for (let j = 0; j < cols; j++) {
      const px  = x + j * step + step / 2
      const rms = dec ? dRms[j] : (peaks[(startCol + j) * 3 + 2] || 0)
      if (j === 0) ctx.moveTo(px, mid - rms * amp)
      else         ctx.lineTo(px, mid - rms * amp)
    }
    for (let j = cols - 1; j >= 0; j--) {
      const px  = x + j * step + step / 2
      const rms = dec ? dRms[j] : (peaks[(startCol + j) * 3 + 2] || 0)
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
  if (endCol - startCol <= 0) return

  const dec = decimatePeaks(peaks, startCol, endCol, w)
  const dMin = dec ? dec.min : null
  const dMax = dec ? dec.max : null
  const cols = dec ? dec.count : endCol - startCol

  const mid  = y + h / 2
  const amp  = h * 0.45
  const step = w / cols

  // Thin filled region between min and max
  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const px  = x + j * step + step / 2
    const maxVal = dec ? dMax[j] : (peaks[(startCol + j) * 3 + 1] || 0)
    if (j === 0) ctx.moveTo(px, mid - maxVal * amp)
    else         ctx.lineTo(px, mid - maxVal * amp)
  }
  for (let j = cols - 1; j >= 0; j--) {
    const px  = x + j * step + step / 2
    const minVal = dec ? dMin[j] : (peaks[(startCol + j) * 3] || 0)
    ctx.lineTo(px, mid - minVal * amp)
  }
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()

  // 1px midpoint stroke through (min+max)/2
  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const px  = x + j * step + step / 2
    const idx = (startCol + j) * 3
    const val = dec
      ? (dMin[j] + dMax[j]) / 2
      : ((peaks[idx] || 0) + (peaks[idx + 1] || 0)) / 2
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
 * @param {string}   [haloColor] optional wider halo stroked underneath, for
 *                    legibility against arbitrary background hues — see
 *                    drawTrace/drawEnvelope's fill+core pairing
 * @param {number}   [haloWidth=0] halo width added on each side of lineWidth
 */
export function drawWaveformLine(ctx, peaks, x, y, w, h, startCol, endCol, strokeColor, lineWidth = 1.5, haloColor = null, haloWidth = 0) {
  if (endCol - startCol <= 0) return

  const dec = decimatePeaks(peaks, startCol, endCol, w)
  const dMin = dec ? dec.min : null
  const dMax = dec ? dec.max : null
  const cols = dec ? dec.count : endCol - startCol

  const mid  = y + h / 2
  const amp  = h * 0.45
  const step = w / cols

  ctx.beginPath()
  for (let j = 0; j < cols; j++) {
    const idx = (startCol + j) * 3
    const px  = x + j * step + step / 2
    // Average of min + max approximates the sample value at ~1 spp
    const val = dec
      ? (dMin[j] + dMax[j]) / 2
      : ((peaks[idx] || 0) + (peaks[idx + 1] || 0)) / 2
    if (j === 0) ctx.moveTo(px, mid - val * amp)
    else         ctx.lineTo(px, mid - val * amp)
  }
  if (haloColor && haloWidth > 0) {
    ctx.strokeStyle = haloColor
    ctx.lineWidth   = lineWidth + haloWidth * 2
    ctx.stroke()
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
 * @param {string}   [haloColor]  optional wider/larger halo drawn underneath
 *                    the line and dots, for legibility against arbitrary
 *                    background hues — see drawTrace/drawEnvelope
 */
export function drawSamplePoints(ctx, samples, x, y, w, h, startIdx, count, strokeColor, dotRadius, haloColor = null) {
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
  if (haloColor) {
    ctx.strokeStyle = haloColor
    ctx.lineWidth   = 3
    ctx.stroke()
  }
  ctx.strokeStyle = strokeColor
  ctx.lineWidth   = 1
  ctx.stroke()

  // Dots (skip if too small to see)
  if (dotR >= 1) {
    if (haloColor) {
      ctx.fillStyle = haloColor
      for (let j = 0; j < count; j++) {
        const px  = x + j * step + step / 2
        const val = samples[startIdx + j] || 0
        const py  = mid - val * amp
        ctx.beginPath()
        ctx.arc(px, py, dotR + 1, 0, Math.PI * 2)
        ctx.fill()
      }
    }
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

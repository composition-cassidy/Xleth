// The preview frame, for the Color Grade scopes and the curves histogram.
//
// The Preview panel owns the shared-memory frame (and knows its live size,
// which changes with the preview resolution scale). It publishes one reader
// here; the scopes call readPreviewFrame() and get the finished picture as the
// engine last drew it: every grade applied, exactly what the user is looking
// at. With no Preview open there is no frame, and the scopes say so rather
// than draw a made-up one.
//
// The frame is BGRA. A WebGL canvas cannot be read instead: the Preview's
// context does not preserve its drawing buffer.

let reader = null
const listeners = new Set()

/** Called by VideoPreview: fn() -> { data: Uint8Array (BGRA), width, height } | null. */
export function setPreviewFrameReader(fn) {
  reader = typeof fn === 'function' ? fn : null
  listeners.forEach((cb) => cb(reader !== null))
}

export function hasPreviewFrameReader() {
  return reader !== null
}

/** Be told when a Preview appears or goes away. Returns the unsubscribe function. */
export function subscribePreviewFrameReader(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function readPreviewFrame() {
  if (!reader) return null
  try {
    const frame = reader()
    if (!frame?.data || !(frame.width > 0) || !(frame.height > 0)) return null
    if (frame.data.length < frame.width * frame.height * 4) return null
    return frame
  } catch {
    return null
  }
}

// ── Statistics ───────────────────────────────────────────────────────────────
// All of them subsample: a scope needs the shape of the picture, not every
// pixel, and they run several times a second beside playback.

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/** Pixel step that visits about `budget` pixels of a w x h frame. */
export function sampleStep(width, height, budget = 24000) {
  return Math.max(1, Math.floor(Math.sqrt((width * height) / budget)))
}

/** { r, g, b, luma } as 256-bin Uint32Arrays, plus `total` samples. */
export function frameHistogram(frame) {
  const { data, width, height } = frame
  const r = new Uint32Array(256)
  const g = new Uint32Array(256)
  const b = new Uint32Array(256)
  const luma = new Uint32Array(256)
  const step = sampleStep(width, height)
  let total = 0
  for (let y = 0; y < height; y += step) {
    let o = y * width * 4
    for (let x = 0; x < width; x += step, o += step * 4) {
      const bb = data[o]
      const gg = data[o + 1]
      const rr = data[o + 2]
      r[rr]++
      g[gg]++
      b[bb]++
      luma[Math.min(255, Math.round(LUMA_R * rr + LUMA_G * gg + LUMA_B * bb))]++
      total++
    }
  }
  return { r, g, b, luma, total }
}

/**
 * Luma waveform: for each of `columns` picture columns, how many samples sit at
 * each of 256 levels. Returns a Uint32Array of columns * 256 (column-major)
 * and the largest count, for scaling.
 */
export function frameWaveform(frame, columns = 256) {
  const { data, width, height } = frame
  const grid = new Uint32Array(columns * 256)
  const stepY = Math.max(1, Math.floor(height / 160))
  const stepX = Math.max(1, Math.floor(width / (columns * 2)))
  let peak = 0
  for (let y = 0; y < height; y += stepY) {
    let o = y * width * 4
    for (let x = 0; x < width; x += stepX, o += stepX * 4) {
      const lum = Math.min(255, Math.round(LUMA_R * data[o + 2] + LUMA_G * data[o + 1] + LUMA_B * data[o]))
      const col = Math.min(columns - 1, Math.floor((x / width) * columns))
      const i = col * 256 + lum
      const v = ++grid[i]
      if (v > peak) peak = v
    }
  }
  return { grid, columns, peak }
}

/**
 * Vectorscope: chroma of every sampled pixel on a size x size grid. x is Cb
 * (blue to the right), y is Cr (red up), Rec.709, the same axes the tonal
 * wheels use. Returns the grid, its size and the largest count.
 */
export function frameVectorscope(frame, size = 128) {
  const { data, width, height } = frame
  const grid = new Uint32Array(size * size)
  const step = sampleStep(width, height, 30000)
  const half = size / 2
  let peak = 0
  for (let y = 0; y < height; y += step) {
    let o = y * width * 4
    for (let x = 0; x < width; x += step, o += step * 4) {
      const r = data[o + 2] / 255
      const g = data[o + 1] / 255
      const b = data[o] / 255
      const lum = LUMA_R * r + LUMA_G * g + LUMA_B * b
      const cb = (b - lum) / 1.8556      // -0.5 .. 0.5
      const cr = (r - lum) / 1.5748
      const gx = Math.min(size - 1, Math.max(0, Math.round(half + cb * size)))
      const gy = Math.min(size - 1, Math.max(0, Math.round(half - cr * size)))
      const v = ++grid[gy * size + gx]
      if (v > peak) peak = v
    }
  }
  return { grid, size, peak }
}

/** Where a pure colour sits on the vectorscope, as fractions of the half-width. */
export function vectorscopeTarget(r, g, b) {
  const lum = LUMA_R * r + LUMA_G * g + LUMA_B * b
  return { x: ((b - lum) / 1.8556) * 2, y: ((r - lum) / 1.5748) * 2 }
}

// Pure mipmap builder for the Split-Syllables waveform.
//
// IMPORTANT: this never decodes audio. In XLETH the C++ engine owns decoding
// and hands the renderer stride-3 peak data ([min, max, rms, …]) over IPC, and
// Web Workers have no AudioContext / decodeAudioData anyway. So we operate on
// engine peaks: given one master stride-3 array spanning the whole region, we
// build six progressively-finer tiers (matching zoom 1×,2×,4×,8×,16×,32×) plus
// the global peak amplitude used for visual-only normalization at draw time.
//
// This module is imported by both splitSyllablesWorker.js (off-main-thread) and
// by SyllableSplitter.jsx as a synchronous fallback when no Worker is available
// (e.g. the test runner). All inputs are treated as read-only — the audio data
// is never mutated here or anywhere downstream.

import { downsamplePeaks3 } from '../../utils/waveformRenderer.js'

// Tier 0 (zoom 1×) holds ~BASE_COLS columns for the whole region; each higher
// tier doubles that, so the visible window keeps ~BASE_COLS columns at every
// zoom level. Tier 5 (32×) is the master resolution we fetch from the engine.
export const MIP_BASE_COLS = 512
export const MIP_LEVELS     = [1, 2, 4, 8, 16, 32]

/**
 * Global visual peak: max(|min|, |max|) across every stride-3 column.
 * Used to derive the 1/peak normalization scale applied at draw time.
 */
export function computePeakAmplitude(peaks, stride = 3) {
  if (!peaks || peaks.length < stride) return 0
  const cols = Math.floor(peaks.length / stride)
  let peak = 0
  for (let i = 0; i < cols; i++) {
    const mn = Math.abs(peaks[i * stride]     || 0)
    const mx = Math.abs(peaks[i * stride + 1] || 0)
    if (mn > peak) peak = mn
    if (mx > peak) peak = mx
  }
  return peak
}

/**
 * Build the 6-level mipmap from a master stride-3 peak array.
 *
 * @param {ArrayLike<number>} peaks   master stride-3 peaks for the whole region
 * @param {number}            stride  always 3 here ([min,max,rms])
 * @param {number}            baseCols columns for the 1× tier
 * @returns {{ tiers: Float32Array[], peakAmplitude: number, baseCols: number }}
 *          tiers are independent Float32Arrays (safe to transfer / mutate-copy).
 */
export function buildMipmap(peaks, stride = 3, baseCols = MIP_BASE_COLS) {
  const srcCols = peaks ? Math.floor(peaks.length / stride) : 0
  const peakAmplitude = computePeakAmplitude(peaks, stride)

  const tiers = MIP_LEVELS.map((mult) => {
    const targetCols = Math.min(srcCols, baseCols * mult)
    // downsamplePeaks3 returns its input untouched when src <= target, so copy
    // into a fresh Float32Array to keep every tier independent + transferable.
    const ds = srcCols > 0 ? downsamplePeaks3(peaks, Math.max(1, targetCols)) : []
    return Float32Array.from(ds)
  })

  return { tiers, peakAmplitude, baseCols }
}

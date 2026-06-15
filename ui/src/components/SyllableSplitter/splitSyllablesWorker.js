// Split-Syllables Web Worker — keeps mipmap construction off the main thread so
// opening / switching a Quote never janks the editor.
//
// NOTE on the message contract: the original spec imagined `{action:'decode',
// arrayBuffer}` → PCM, but a Web Worker physically cannot decode compressed
// audio (no AudioContext / decodeAudioData outside the window), and in XLETH the
// C++ engine already decodes and produces stride-3 [min,max,rms] peaks. So this
// worker instead receives those engine peaks and builds the 6-level zoom mipmap
// + global peak amplitude. No audio sample data is ever produced or modified.
//
//   in : { action: 'mipmap', id, peaks: Float32Array|number[], stride }
//   out: { id, tiers: Float32Array[6], peakAmplitude, baseCols }   (buffers moved)
//        or { id, error } on failure (caller falls back to a main-thread build).

import { buildMipmap } from './splitSyllablesMipmap.js'

self.onmessage = (e) => {
  const msg = e.data || {}
  if (msg.action !== 'mipmap') return
  try {
    const { tiers, peakAmplitude, baseCols } = buildMipmap(msg.peaks, msg.stride || 3)
    // Transfer the tier buffers instead of structured-cloning them.
    const transfer = tiers.map((t) => t.buffer)
    self.postMessage({ id: msg.id, tiers, peakAmplitude, baseCols }, transfer)
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err && err.message) || err) })
  }
}

// Module-level singleton so only one Sample Sandbox preview plays at a time —
// mirrors SampleRow.jsx's own preview-audio singleton pattern. Plays straight
// from the already-decoded PCM in a rendered buffer (the composite mix) via
// Web Audio in the renderer process; no engine/audio-thread involvement.
let audioCtx = null
let sourceNode = null

export function isSandboxPreviewPlaying() {
  return sourceNode != null
}

export function stopSandboxPreview() {
  if (!sourceNode) return
  const node = sourceNode
  sourceNode = null
  node.onended = null
  try { node.stop() } catch { /* already stopped */ }
  node.disconnect()
}

// buf: { numChannels, numSamples, sampleRate, channels: Float32Array[] }
// startSample: playback start offset, clamped into [0, numSamples).
// onEnded: called once, whether playback finished naturally or was stopped.
export function playSandboxPreview(buf, startSample, onEnded) {
  stopSandboxPreview()
  if (!buf || !buf.numSamples) return false
  const start = Math.max(0, Math.min(startSample ?? 0, buf.numSamples - 1))
  const frames = buf.numSamples - start
  if (frames <= 0) return false

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const audioBuffer = audioCtx.createBuffer(buf.numChannels, frames, buf.sampleRate)
  for (let ch = 0; ch < buf.numChannels; ch++) {
    audioBuffer.copyToChannel(buf.channels[ch].subarray(start), ch)
  }
  const node = audioCtx.createBufferSource()
  node.buffer = audioBuffer
  node.connect(audioCtx.destination)
  node.onended = () => {
    if (sourceNode === node) sourceNode = null
    onEnded?.()
  }
  node.start()
  sourceNode = node
  return true
}

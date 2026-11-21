// Module-level singleton so only one Sample Sandbox preview plays at a time —
// mirrors SampleRow.jsx's own preview-audio singleton pattern. Plays straight
// from the already-decoded PCM in a rendered buffer (a layer's own render, or
// the composite mix) via Web Audio in the renderer process; no engine/audio-
// thread involvement.
//
// ── Why this tracks position ────────────────────────────────────────────────
// It used to be strictly fire-and-forget: start a BufferSource over a copied
// subarray, forget about it, and the only observable state was "is something
// playing". That is why the panel had no playhead — there was nothing to draw.
// An AudioContext's own `currentTime` is a high-resolution clock on the audio
// device's timeline, so the playing position is derivable exactly, with no
// polling of the node and no timer drift: sample = start + elapsed * rate.
//
// ── Why the whole buffer goes to Web Audio ──────────────────────────────────
// Playing a RANGE is now an offset+duration on start(), not a copied subarray.
// That is what makes looping possible at all (loopStart/loopEnd are positions
// in the node's own buffer), and it lets the same decoded AudioBuffer be
// reused across repeated plays of an unchanged render — the copy is keyed on
// the source buffer's identity, which the store replaces only when a new
// render actually arrives.
let audioCtx = null
let sourceNode = null
let playState = null // { startSample, endSample, sampleRate, numSamples, loop, ctxStartTime }
const decodedCache = { source: null, audioBuffer: null }

export function isSandboxPreviewPlaying() {
  return sourceNode != null
}

export function stopSandboxPreview() {
  if (!sourceNode) return
  const node = sourceNode
  sourceNode = null
  playState = null
  node.onended = null
  try { node.stop() } catch { /* already stopped */ }
  node.disconnect()
}

// Current playing position as a sample index in the SOURCE buffer's own
// timeline, or null when nothing is playing. Callers draw this; nobody stores
// it — at 60fps a store write per frame would re-render the whole panel.
export function getSandboxPreviewPosition() {
  if (!sourceNode || !playState || !audioCtx) return null
  const { startSample, endSample, sampleRate, loop, ctxStartTime } = playState
  const elapsed = Math.max(0, audioCtx.currentTime - ctxStartTime)
  const span = Math.max(1, endSample - startSample)
  let offset = elapsed * sampleRate
  if (loop) offset %= span
  return Math.min(endSample, startSample + offset)
}

// The range currently playing, for a caller that needs to draw the loop
// bracket or decide whether the playhead belongs on the layer it is drawing.
export function getSandboxPreviewRange() {
  if (!playState) return null
  const { startSample, endSample, loop } = playState
  return { startSample, endSample, loop }
}

// Arm/disarm looping on the pass ALREADY playing. Web Audio honours a `loop`
// change on a running node, so this does not restart playback — see
// toggleLoopPlayback in sandboxStore for why that matters.
export function setSandboxPreviewLoop(loop) {
  if (!sourceNode || !playState) return
  sourceNode.loop = !!loop
  playState.loop = !!loop
  // A node started with an explicit duration stops at that duration REGARDLESS
  // of `loop` (the duration argument wins), so looping can only be armed
  // mid-pass for a play that was started as a loop in the first place. Playing
  // a bounded range non-looped and then arming loop therefore keeps the range
  // but still ends at it; the transport reflects that by re-triggering.
}

function toAudioBuffer(ctx, buf) {
  if (decodedCache.source === buf && decodedCache.audioBuffer) return decodedCache.audioBuffer
  const audioBuffer = ctx.createBuffer(buf.numChannels, buf.numSamples, buf.sampleRate)
  for (let ch = 0; ch < buf.numChannels; ch++) {
    audioBuffer.copyToChannel(buf.channels[ch], ch)
  }
  decodedCache.source = buf
  decodedCache.audioBuffer = audioBuffer
  return audioBuffer
}

// buf: { numChannels, numSamples, sampleRate, channels: Float32Array[] }
// opts: { startSample, endSample, loop, onEnded }
//   endSample null/undefined = play to the end of the buffer.
//   onEnded is called once, whether playback finished naturally or was stopped
//   — but NOT for a loop wrap, which never ends.
export function playSandboxPreview(buf, opts = {}) {
  stopSandboxPreview()
  if (!buf || !buf.numSamples || !buf.channels?.length) return false

  const { onEnded, loop = false } = opts
  const numSamples = buf.numSamples
  const start = Math.max(0, Math.min(Math.round(opts.startSample ?? 0), numSamples - 1))
  const end = Math.max(start + 1, Math.min(Math.round(opts.endSample ?? numSamples), numSamples))

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  // A context created before any user gesture starts suspended; a play IS a
  // user gesture, so resuming here is what makes the first Space after a panel
  // open actually sound.
  if (audioCtx.state === 'suspended') audioCtx.resume?.()

  const audioBuffer = toAudioBuffer(audioCtx, buf)
  const node = audioCtx.createBufferSource()
  node.buffer = audioBuffer

  const startSec = start / buf.sampleRate
  const durationSec = (end - start) / buf.sampleRate

  if (loop) {
    node.loop = true
    node.loopStart = startSec
    node.loopEnd = end / buf.sampleRate
    node.start(0, startSec) // no duration: a looped pass runs until stopped
  } else {
    node.start(0, startSec, durationSec)
  }

  node.connect(audioCtx.destination)
  node.onended = () => {
    if (sourceNode === node) { sourceNode = null; playState = null }
    onEnded?.()
  }
  sourceNode = node
  playState = {
    startSample: start,
    endSample: end,
    sampleRate: buf.sampleRate,
    numSamples,
    loop,
    ctxStartTime: audioCtx.currentTime,
  }
  return true
}

// Synthesises the demo stems for the website renders. No dependencies.
// Output: <MEDIA>/*.wav (44.1 kHz, 16-bit stereo) and <MEDIA>/manifest.json (durations in seconds).
import fs from 'node:fs'
import path from 'node:path'

const MEDIA = process.argv[2]
const SR = 44100
const BPM = 140
const BEAT = 60 / BPM
const BAR = BEAT * 4
const LOOP_BARS = 4
const LOOP_N = Math.round(BAR * LOOP_BARS * SR) // 302400 samples: exact at 140 BPM

let seed = 1234567
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1 }

const newBuf = (n) => new Float32Array(n)
const addHit = (buf, t0, len, fn) => {
  const s0 = Math.round(t0 * SR)
  for (let i = 0; i < len * SR && s0 + i < buf.length; i++) {
    const t = i / SR
    buf[s0 + i] += fn(t, i)
  }
}

function kick() {
  const b = newBuf(LOOP_N)
  for (let bar = 0; bar < LOOP_BARS; bar++) for (let beat = 0; beat < 4; beat++) {
    let ph = 0
    addHit(b, (bar * 4 + beat) * BEAT, 0.42, (t) => {
      const f = 46 + 95 * Math.exp(-t * 34)
      ph += (2 * Math.PI * f) / SR
      return Math.sin(ph) * Math.exp(-t * 8.5) * 0.95 + (t < 0.004 ? rnd() * 0.15 : 0)
    })
  }
  return b
}

function snare() {
  const b = newBuf(LOOP_N)
  for (let bar = 0; bar < LOOP_BARS; bar++) for (const beat of [1, 3]) {
    addHit(b, (bar * 4 + beat) * BEAT, 0.35, (t) =>
      rnd() * Math.exp(-t * 22) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 34) * 0.4)
  }
  return b
}

function hats() {
  const b = newBuf(LOOP_N)
  let prev = 0
  for (let k = 0; k < LOOP_BARS * 8; k++) {
    const accent = k % 2 === 0 ? 1 : 0.6
    addHit(b, k * BEAT / 2, 0.12, (t) => {
      const n = rnd()
      const hp = n - prev; prev = n
      return hp * Math.exp(-t * 58) * 0.24 * accent
    })
  }
  return b
}

// A single plucked note, used as a sampler seed.
function pluck(freq, dur, harmonics = 5) {
  const n = Math.round(dur * SR)
  const b = newBuf(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let v = 0
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * freq * h * t) / h
    const env = Math.min(1, t / 0.004) * Math.exp(-t * 3.2)
    b[i] = v * env * 0.45
  }
  return b
}

function pad(dur) {
  const n = Math.round(dur * SR)
  const b = newBuf(n)
  const freqs = [220, 220 * 1.004, 261.63, 329.63, 329.63 * 1.003]
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let v = 0
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t)
    const env = Math.min(1, t / 0.6) * Math.min(1, (dur - t) / 0.5)
    b[i] = (v / freqs.length) * env * 0.4
  }
  return b
}

// Interleave a mono buffer to stereo, optionally with a small pan-free width offset.
function toStereoWav(mono, file, width = 0) {
  const n = mono.length
  const data = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const l = mono[i] * (1 - width * 0.35)
    const r = mono[(i + Math.round(width * 220)) % n] * (1 + width * 0.35)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), i * 4)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), i * 4 + 2)
  }
  const hdr = Buffer.alloc(44)
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8)
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22)
  hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34)
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40)
  fs.writeFileSync(path.join(MEDIA, file), Buffer.concat([hdr, data]))
  return n / SR
}

fs.mkdirSync(MEDIA, { recursive: true })
const durations = {
  'kick.wav': toStereoWav(kick(), 'kick.wav'),
  'snare.wav': toStereoWav(snare(), 'snare.wav', 0.1),
  'hats.wav': toStereoWav(hats(), 'hats.wav', 0.6),
  'bass.wav': toStereoWav(pluck(55, 1.2, 6), 'bass.wav'),
  'lead.wav': toStereoWav(pluck(440, 0.9, 4), 'lead.wav', 0.3),
  'pad.wav': toStereoWav(pad(4), 'pad.wav', 0.5),
}
fs.writeFileSync(path.join(MEDIA, 'manifest.json'), JSON.stringify({ bpm: BPM, loopBars: LOOP_BARS, durations }, null, 2))
console.log(JSON.stringify(durations))

// Writes a Standard MIDI File with a dense single-track pattern for the stress test in
// ui/tests/MANUAL_TEST_SCRIPT.md. No dependencies.
//
//   node tests/fixture/make-stress-midi.mjs [notes=2000] [out=stress-2000.mid]
//
// 480 PPQ, 120 BPM, 4/4. Notes are a sixteenth long (120 ticks) on a 16th grid, with a few
// simultaneous chord tones so the piano roll shows overlapping notes, and a varied pitch and velocity
// so the velocity lane is not a flat line.
import fs from 'node:fs'

const notes = Number(process.argv[2]) || 2000
const out = process.argv[3] || `stress-${notes}.mid`
const PPQ = 480
const STEP = PPQ / 4

const bytes = []
const push = (...b) => bytes.push(...b)
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16 = (n) => [(n >>> 8) & 255, n & 255]
function varlen(n) {
  const out = [n & 127]
  while ((n >>= 7)) out.unshift((n & 127) | 128)
  return out
}

// Build absolute-time events, then sort and delta-encode.
const events = []
for (let i = 0; i < notes; i++) {
  const slot = Math.floor(i / 1.25) // every fourth slot carries two notes (a dyad)
  const t = slot * STEP
  const base = 48 + ((i * 7) % 36) // C3 .. B5, a walk that is not monotonic
  const vel = 40 + ((i * 29) % 88)
  events.push([t, 0x90, base, vel], [t + STEP - 6, 0x80, base, 0])
}
events.sort((a, b) => a[0] - b[0] || (a[1] === 0x80 ? -1 : 1))

const track = []
const tpush = (...b) => track.push(...b)
// tempo 120 BPM = 500000 us per quarter; time signature 4/4
tpush(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20)
tpush(0, 0xff, 0x58, 0x04, 4, 2, 24, 8)
tpush(0, 0xff, 0x03, 0x06, ...Buffer.from('Stress'))
let last = 0
for (const [t, status, key, vel] of events) {
  tpush(...varlen(t - last), status, key, vel)
  last = t
}
tpush(0, 0xff, 0x2f, 0x00)

push(...Buffer.from('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ))
push(...Buffer.from('MTrk'), ...u32(track.length), ...track)
fs.writeFileSync(out, Buffer.from(bytes))
const bars = Math.ceil((last + STEP) / (PPQ * 4))
console.log(`${out}: ${notes} notes over ${bars} bars (${bytes.length} bytes)`)

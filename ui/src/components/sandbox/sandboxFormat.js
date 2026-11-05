// ── Sample Sandbox time formatting ──────────────────────────────────────────
//
// The panel used to speak three different time languages at once: the ruler
// drew BEATS off the project BPM, the status bar read seconds to 3 dp, and the
// op stack printed raw SAMPLE INDICES ("12000–48000"). Beats are meaningless
// here — a sandbox layer is an offline buffer with no relationship to the
// project's tempo grid — and sample indices are unreadable at a glance.
//
// One vocabulary, defined here: seconds, formatted to the precision the
// context actually has. Everything that shows a time imports from this file.

// Duration → "m:ss.mmm" / "s.mmm" — the readout form, for a specific position
// or length the user may want to type back in somewhere.
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const neg = seconds < 0
  const s = Math.abs(seconds)
  const mins = Math.floor(s / 60)
  const rem = s - mins * 60
  const body = mins > 0
    ? `${mins}:${rem < 10 ? '0' : ''}${rem.toFixed(3)}`
    : rem.toFixed(3)
  return neg ? `-${body}` : body
}

// Sample index → readout time, against a buffer's own rate. A missing rate
// means the buffer has not arrived yet; say nothing rather than divide by a
// guessed 48000 and print a confidently wrong number.
export function formatSamples(samples, sampleRate) {
  if (!sampleRate || samples == null || !Number.isFinite(samples)) return '—'
  return formatTime(samples / sampleRate)
}

// Short form for a LENGTH, where sub-millisecond precision is noise: "1.24s",
// "840ms", "2:03.5". Used in op-row summaries, where the number competes with
// the op name for a narrow rail.
export function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.abs(seconds)
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 60) return `${s.toFixed(2)}s`
  const mins = Math.floor(s / 60)
  return `${mins}:${(s - mins * 60).toFixed(1).padStart(4, '0')}`
}

export function formatSamplesShort(samples, sampleRate) {
  if (!sampleRate || samples == null || !Number.isFinite(samples)) return '—'
  return formatDurationShort(samples / sampleRate)
}

// A sample RANGE as an op row states it: "0.25s → 1.40s (1.15s)". The span in
// brackets is the part that usually matters (how much material this op covers)
// and the endpoints are what lets you find it on the waveform.
export function formatRange(startSample, endSample, sampleRate) {
  if (!sampleRate) return `${startSample}–${endSample}`
  const a = formatSamplesShort(startSample, sampleRate)
  const b = formatSamplesShort(endSample, sampleRate)
  return `${a} → ${b} (${formatSamplesShort(endSample - startSample, sampleRate)})`
}

export function formatHz(hz) {
  if (!Number.isFinite(hz)) return '—'
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)}k` : `${Math.round(hz)}`
}

// Ruler tick spacing: the "nice" step (in seconds) at or above `minStepSec`,
// from a 1-2-5 ladder extended down to sub-millisecond and up to minutes. A
// ruler that can be zoomed from a whole minute to a few dozen samples needs
// the ladder rather than a fixed step, or the labels either collide or vanish.
const TICK_LADDER = [
  0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05,
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
]

export function niceTimeStep(minStepSec) {
  for (const step of TICK_LADDER) if (step >= minStepSec) return step
  return TICK_LADDER[TICK_LADDER.length - 1]
}

// Tick label at a given step size — drops the digits the step cannot resolve,
// so a 0.5s ruler reads "1.5" and not "1.500", while a 2ms ruler still reads
// "0.104".
export function formatTick(seconds, stepSec) {
  const decimals = stepSec >= 1 ? 0 : stepSec >= 0.1 ? 1 : stepSec >= 0.01 ? 2 : stepSec >= 0.001 ? 3 : 4
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60)
    const rem = seconds - mins * 60
    return `${mins}:${rem < 10 ? '0' : ''}${rem.toFixed(decimals)}`
  }
  return seconds.toFixed(decimals)
}

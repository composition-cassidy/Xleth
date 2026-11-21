// Time-true geometry for the modulation displays.
//
// The envelope and LFO pictures used to stretch whatever they showed to the full
// width of the canvas, so a 10 ms release and a 5 s one drew the same line. Here
// time has a SCALE: the display covers a chosen span (1 s by default), a ruler
// prints it, and a stage is as wide as it is long. Pure maths, no React, no
// canvas: the canvases and the tests both read these.

import { create } from 'zustand'
import { shapeTension, evalLfoShape } from './modEval.js'
import { BEHAVIOR_ENVELOPE, NOTE_VALUES, noteValueBeats } from './modConstants.js'

// ── The span the displays cover ───────────────────────────────────────────────
// A view setting, not sampler data: shared by every envelope and LFO display so
// two sources are always drawn at the same scale and can be compared by eye.
// 0 = Fit (the scale follows the content; the ruler still says what it is).
export const SPAN_FIT = 0
export const SPAN_OPTIONS = [
  { value: 0.1, label: '100 ms' },
  { value: 0.25, label: '250 ms' },
  { value: 0.5, label: '500 ms' },
  { value: 1, label: '1 s' },
  { value: 2, label: '2 s' },
  { value: 5, label: '5 s' },
  { value: 10, label: '10 s' },
  { value: 30, label: '30 s' },
  { value: SPAN_FIT, label: 'Fit' },
]
export const DEFAULT_SPAN = 1

export const useModSpanStore = create((set) => ({
  span: DEFAULT_SPAN,
  setSpan: (span) => set({ span: Number(span) }),
}))

// ── Ruler ticks ──────────────────────────────────────────────────────────────
const NICE = [1, 2, 5]

// The smallest 1-2-5 step that keeps labelled ticks at least `minPx` apart.
export function niceStep(unitsPerPx, minPx = 56) {
  const raw = Math.max(1e-9, unitsPerPx * minPx)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const n of NICE) if (n * pow >= raw) return n * pow
  return 10 * pow
}

export function formatSeconds(sec) {
  const ms = sec * 1000
  if (Math.abs(ms) < 1e-6) return '0'
  if (Math.abs(ms) < 1000) return `${Number(ms.toFixed(ms < 10 ? 1 : 0))} ms`
  return `${Number(sec.toFixed(2))} s`
}

// Beats, as the fraction a musician reads: 1/4 beat, 1/2, 1, 2, 4.
export function formatBeats(beats) {
  if (Math.abs(beats) < 1e-9) return '0'
  if (beats >= 1) return `${Number(beats.toFixed(2))}`
  const inv = Math.round(1 / beats)
  return Math.abs(1 / inv - beats) < 1e-6 ? `1/${inv}` : `${Number(beats.toFixed(3))}`
}

const BEAT_STEPS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64]

/**
 * Ticks for `spanSec` drawn over `px` pixels. In note-value mode the ticks fall
 * on beats at the project tempo (labelled in beats); otherwise on round times.
 * Returns [{ sec, label, major }] with one unlabelled minor tick between labels.
 */
export function timeTicks(spanSec, px, { sync = false, bpm = 120, minPx = 56 } = {}) {
  if (!(spanSec > 0) || !(px > 0)) return []
  const out = []
  if (sync) {
    const beatSec = 60 / (bpm > 0 ? bpm : 120)
    const spanBeats = spanSec / beatSec
    const want = (spanBeats / px) * minPx
    const step = BEAT_STEPS.find((s) => s >= want) ?? BEAT_STEPS[BEAT_STEPS.length - 1]
    const half = step / 2
    for (let i = 0; i * half <= spanBeats + 1e-9; i++) {
      const b = i * half
      out.push({ sec: b * beatSec, label: i % 2 === 0 ? formatBeats(b) : '', major: i % 2 === 0 })
    }
    return out
  }
  const step = niceStep(spanSec / px, minPx)
  const half = step / 2
  for (let i = 0; i * half <= spanSec + 1e-9; i++) {
    out.push({ sec: i * half, label: i % 2 === 0 ? formatSeconds(i * half) : '', major: i % 2 === 0 })
  }
  return out
}

// ── Envelope layout ──────────────────────────────────────────────────────────
// A DAHDSR has one part that is not a time: the sustain lasts as long as the key
// is held. It is drawn as a fixed-width BREAK in the time axis (not to scale, and
// marked so), with the release measured from the far side of it. Everything else
// is to scale: `spanSec` covers delay + attack + hold + decay + release.

export const ENV_HANDLES = ['delay', 'attack', 'hold', 'decay', 'release']
export const ENV_TENSIONS = ['attackTension', 'decayTension', 'releaseTension']
export const ENV_MAX_STAGE_SEC = 5

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function envActiveSeconds(env) {
  return ['delaySec', 'attackSec', 'holdSec', 'decaySec', 'releaseSec']
    .reduce((n, k) => n + Math.max(0, env?.[k] || 0), 0)
}

/** The span actually drawn: the chosen one, or (Fit) the envelope plus a margin. */
export function resolveSpan(span, contentSec) {
  if (span > 0) return span
  const c = contentSec > 0 ? contentSec * 1.1 : 1
  return Math.max(0.02, c)
}

/**
 * Pixel layout of an envelope. `box` is the plot area { x, y, w, h } in canvas
 * pixels; `gapPx` the width of the held-sustain break.
 */
export function envelopeLayout(env, spanSec, box, gapPx = 44) {
  const d = Math.max(0, env.delaySec || 0)
  const a = Math.max(0, env.attackSec || 0)
  const h = Math.max(0, env.holdSec || 0)
  const dec = Math.max(0, env.decaySec || 0)
  const r = Math.max(0, env.releaseSec || 0)
  const sus = clamp(env.sustain ?? 1, 0, 1)
  const gap = Math.min(gapPx, box.w * 0.25)
  const pps = (box.w - gap) / Math.max(1e-6, spanSec)   // pixels per second
  const yOf = (level) => box.y + box.h - level * box.h
  const levelOf = (py) => clamp((box.y + box.h - py) / box.h, 0, 1)

  const x0 = box.x
  const xDelay = x0 + d * pps
  const xAttack = xDelay + a * pps
  const xHold = xAttack + h * pps
  const xDecay = xHold + dec * pps
  const xGapEnd = xDecay + gap
  const xRelease = xGapEnd + r * pps

  // The trace, sampled per stage through the engine's own tension curve.
  const pts = [{ x: x0, y: yOf(0) }, { x: xDelay, y: yOf(0) }]
  const seg = (xa, xb, fn) => {
    const steps = Math.max(2, Math.min(96, Math.ceil(Math.abs(xb - xa) / 3)))
    for (let i = 1; i <= steps; i++) {
      const f = i / steps
      pts.push({ x: xa + (xb - xa) * f, y: yOf(fn(f)) })
    }
  }
  if (a > 0) seg(xDelay, xAttack, (f) => shapeTension(f, env.attackTension || 0))
  else pts.push({ x: xAttack, y: yOf(1) })
  pts.push({ x: xHold, y: yOf(1) })
  if (dec > 0) seg(xHold, xDecay, (f) => 1 - (1 - sus) * shapeTension(f, env.decayTension || 0))
  else pts.push({ x: xDecay, y: yOf(sus) })
  const releaseStart = pts.length
  pts.push({ x: xGapEnd, y: yOf(sus) })
  if (r > 0) seg(xGapEnd, xRelease, (f) => sus * (1 - shapeTension(f, env.releaseTension || 0)))
  else pts.push({ x: xRelease, y: yOf(0) })

  const mid = (xa, xb, fn) => ({ x: (xa + xb) / 2, y: yOf(fn(0.5)) })
  return {
    pps, gap, sus, yOf, levelOf,
    x: { start: x0, delay: xDelay, attack: xAttack, hold: xHold, decay: xDecay, gapEnd: xGapEnd, release: xRelease },
    pts,
    releaseStart,
    // Where the release ends past the right edge, the picture says so.
    overflowSec: Math.max(0, (xRelease - (box.x + box.w)) / pps),
    handles: {
      delay: { x: xDelay, y: yOf(0) },
      attack: { x: xAttack, y: yOf(1) },
      hold: { x: xHold, y: yOf(1) },
      decay: { x: xDecay, y: yOf(sus) },
      release: { x: xRelease, y: yOf(0) },
    },
    // Curve handles sit on the middle of their segment; a zero-length stage has none.
    tensions: {
      attackTension: a > 0 ? mid(xDelay, xAttack, (f) => shapeTension(f, env.attackTension || 0)) : null,
      decayTension: dec > 0 && sus < 1 ? mid(xHold, xDecay, (f) => 1 - (1 - sus) * shapeTension(f, env.decayTension || 0)) : null,
      releaseTension: r > 0 && sus > 0 ? mid(xGapEnd, xRelease, (f) => sus * (1 - shapeTension(f, env.releaseTension || 0))) : null,
    },
  }
}

/** Where a stage starts, in pixels: the edge its handle is measured from. */
export function envStageOrigin(layout, key) {
  const { x } = layout
  return { delay: x.start, attack: x.delay, hold: x.attack, decay: x.hold, release: x.gapEnd }[key]
}

/** Seconds for a stage whose handle is dragged to `px`. */
export function envStageSecondsAt(layout, key, px) {
  return clamp((px - envStageOrigin(layout, key)) / layout.pps, 0, ENV_MAX_STAGE_SEC)
}

/** The note value (index) whose length at this tempo is nearest `sec`; flags are kept. */
export function nearestNoteValue(sec, bpm, { triplet = false, dotted = false } = {}) {
  const beatSec = 60 / (bpm > 0 ? bpm : 120)
  let best = 0
  let bestErr = Infinity
  for (const nv of NOTE_VALUES) {
    const s = noteValueBeats(nv.v, triplet, dotted) * beatSec
    // Compared on a log scale past zero, so 1/8 vs 1/4 splits at their geometric middle.
    const err = s <= 0 || sec <= 0 ? Math.abs(s - sec) : Math.abs(Math.log(s / sec))
    if (err < bestErr) { bestErr = err; best = nv.v }
  }
  // "Off" only when the drag is essentially at zero.
  if (sec < beatSec / 512) return 0
  return best === 0 ? NOTE_VALUES[NOTE_VALUES.length - 1].v : best
}

// ── LFO over time ────────────────────────────────────────────────────────────
// What the LFO actually sends from the moment a note starts: the drawn shape
// repeating at its rate, with Phase, Smooth, Delay and Rise applied the way the
// engine applies them (advanceModLfo): Delay holds the depth at zero then jumps,
// Rise ramps it 0 to 1 linearly from the note start, and the two multiply. In Env
// mode the shape plays once and holds its last value.

export function lfoValueAt(lfo, tSec, { rateHz, delaySec = 0, riseSec = 0 }) {
  const rate = clamp(rateHz, 1e-4, 400)
  let depth = tSec >= delaySec ? 1 : 0
  if (riseSec > 1e-9) depth *= Math.min(1, tSec / riseSec)
  const smooth = clamp((lfo.smooth ?? 0) / 100, 0, 1)
  let phase = tSec * rate + (lfo.phase ?? 0) / 100
  if ((lfo.behavior ?? 0) === BEHAVIOR_ENVELOPE) phase = clamp(phase, 0, 1)
  else phase -= Math.floor(phase)
  return evalLfoShape(lfo.points, phase, smooth) * depth
}

/** One value per pixel column across `spanSec`. */
export function lfoTimeline(lfo, spanSec, px, timing) {
  const n = Math.max(2, Math.round(px))
  const out = new Array(n)
  // Several samples per column, min and max kept: a fast LFO draws as a band
  // instead of aliasing into a slow wave that is not there.
  const sub = 4
  for (let i = 0; i < n; i++) {
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < sub; k++) {
      const v = lfoValueAt(lfo, ((i + k / sub) / (n - 1)) * spanSec, timing)
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    out[i] = { lo, hi }
  }
  return out
}

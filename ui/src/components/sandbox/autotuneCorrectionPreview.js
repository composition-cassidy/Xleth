// AUTOTUNE pitch-curve preview (P5-4) — a UI-side port of the engine's
// CorrectionCurve.cpp, used ONLY to draw the "corrected target" line on the
// waveform overlay. The real audio correction still runs entirely in the
// engine (dsp/CorrectionCurve.cpp -> dsp/AutotuneRender.cpp); this exists
// because sandbox_getPitchTrack (P5-1) serves the raw f0 track only, not a
// target curve, and this prompt is explicitly UI-only — no engine RPC to
// fetch a precomputed one. Keeping the algorithm in one place (this file)
// rather than reimplementing per caller mirrors AUTOTUNE_SCALE's own
// "the C++ enum's values are load-bearing" contract in sandboxStore.js.
//
// Ported term-for-term from engine/src/dsp/CorrectionCurve.cpp — see that
// file's own header comment for the six-step algorithm this follows. Any
// drift between the two is a bug in ONE of them, not a deliberate variance.

// scaleIntervals(ScaleType) — semitone offsets from the root, ascending,
// indexed by AUTOTUNE_SCALE's own numbering (sandboxStore.js), which mirrors
// xleth::dsp::ScaleType exactly.
const SCALE_INTERVALS = [
  [0, 2, 4, 5, 7, 9, 11],   // 0 Ionian
  [0, 2, 3, 5, 7, 9, 10],   // 1 Dorian
  [0, 1, 3, 5, 7, 8, 10],   // 2 Phrygian
  [0, 2, 4, 6, 7, 9, 11],   // 3 Lydian
  [0, 2, 4, 5, 7, 9, 10],   // 4 Mixolydian
  [0, 2, 3, 5, 7, 8, 10],   // 5 Aeolian
  [0, 1, 3, 5, 6, 8, 10],   // 6 Locrian
  [0, 2, 3, 5, 7, 8, 11],   // 7 Harmonic Minor
  [0, 2, 3, 5, 7, 9, 11],   // 8 Melodic Minor
  [0, 2, 4, 7, 9],          // 9 Major Pentatonic
  [0, 3, 5, 7, 10],         // 10 Minor Pentatonic
]

// scaleIntervals(scale) transposed by `key` (0=C..11=B) and reduced mod 12,
// sorted + deduplicated — the "preset" allowed-note set before any keyboard
// override.
export function allowedPitchClasses(key, scale) {
  const intervals = SCALE_INTERVALS[scale] ?? SCALE_INTERVALS[0]
  const out = new Set(intervals.map((iv) => ((key + iv) % 12 + 12) % 12))
  return [...out].sort((a, b) => a - b)
}

// Snaps `hz` to the nearest note (any octave) among `pitchClasses` (0-11).
// Returns `hz` unchanged if it is <= 0 or `pitchClasses` is empty.
export function quantizeToNearestNote(hz, pitchClasses) {
  if (!(hz > 0) || pitchClasses.length === 0) return hz
  const midi = 69.0 + 12.0 * Math.log2(hz / 440.0)
  let bestMidi = midi
  let bestDist = Infinity
  for (const pc of pitchClasses) {
    const k = Math.round((midi - pc) / 12.0)
    const candidate = k * 12.0 + pc
    const dist = Math.abs(candidate - midi)
    if (dist < bestDist) { bestDist = dist; bestMidi = candidate }
  }
  return 440.0 * Math.pow(2, (bestMidi - 69.0) / 12.0)
}

const KVIBRATO_BOUNDARY_HZ = 5.0 // matches kVibratoBoundaryHz (CorrectionCurve.cpp)

function centsOf(hz) { return 1200.0 * Math.log2(hz) }
function hzOfCents(cents) { return Math.pow(2, cents / 1200.0) }
function clamp01Pct(pct) { return Math.min(100, Math.max(0, pct)) / 100.0 }

// frames: [{ posSample, f0Hz, confidence }] on the pitch track's own grid
// (voiced == f0Hz > 0, same equivalence CorrectionCurve.cpp's own gate
// reduces to — the RPC does not carry a separate voiced flag).
// segments: [{ startSample, endSample, medianF0Hz, noteName }], sorted,
// non-overlapping (sandbox_getPitchTrack's own contract).
// sampleRate: the rate frames'/segments' sample positions are expressed in.
// scale/key: AUTOTUNE_SCALE / AUTOTUNE_KEY_NAME index. allowedNotes: pitch
// classes (0-11) from the keyboard picker; non-empty OVERRIDES scale/key.
// params: { correctionAmount, retuneSpeedMs, smoothnessMs, jumpiness, preserveVibrato }.
//
// Returns [{ posSample, targetF0Hz, correctionCents }], one per input frame,
// same length/order as `frames`.
export function computeAutotuneCorrectionCurve(frames, segments, sampleRate, scale, key, allowedNotes, params) {
  if (!frames?.length || !(sampleRate > 0)) return []

  let pcs = [...new Set(allowedNotes ?? [])].sort((a, b) => a - b)
  if (pcs.length === 0) pcs = allowedPitchClasses(key, scale)

  const holdMs = Math.min(100, Math.max(0, params?.jumpiness ?? 0)) // 1% == 1ms
  const amount = clamp01Pct(params?.correctionAmount ?? 100)
  const preserveV = clamp01Pct(params?.preserveVibrato ?? 100)
  const retuneMs = Math.max(0, params?.retuneSpeedMs ?? 20)
  const smoothMs = Math.max(0, params?.smoothnessMs ?? 20)
  const vibTauSec = 1.0 / (2.0 * Math.PI * KVIBRATO_BOUNDARY_HZ)

  let haveCommitted = false
  let committedCents = 0
  let lastCommitTimeSec = 0
  let releaseWindowEndS = 0
  let runningCents = 0
  let lastVoicedTimeSec = 0

  let vibLpfInit = false
  let vibLpfState1 = 0
  let vibLpfState2 = 0

  let prevVoiced = false
  let segIdx = 0

  const out = new Array(frames.length)

  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i]
    const voiced = fr.f0Hz > 0

    if (!voiced) {
      out[i] = { posSample: fr.posSample, targetF0Hz: fr.f0Hz, correctionCents: 0 }
      prevVoiced = false
      continue
    }

    const tSec = fr.posSample / sampleRate
    const inputCents = centsOf(fr.f0Hz)

    // ── 1. quantize segment target ──────────────────────────────────────
    while (segIdx + 1 < segments.length && fr.posSample >= segments[segIdx].endSample) segIdx++
    let candidateHz
    if (segIdx < segments.length
        && fr.posSample >= segments[segIdx].startSample
        && fr.posSample < segments[segIdx].endSample) {
      candidateHz = quantizeToNearestNote(segments[segIdx].medianF0Hz, pcs)
    } else {
      candidateHz = quantizeToNearestNote(fr.f0Hz, pcs)
    }
    const candidateCents = centsOf(candidateHz)

    const onset = !prevVoiced || !haveCommitted
    if (onset) {
      committedCents = candidateCents
      lastCommitTimeSec = tSec
      releaseWindowEndS = tSec
      runningCents = inputCents
      lastVoicedTimeSec = tSec
      haveCommitted = true
      vibLpfInit = false
    } else if (Math.abs(candidateCents - committedCents) > 1e-9) {
      // ── 2. jumpiness hold ────────────────────────────────────────────
      const sinceLastCommitMs = (tSec - lastCommitTimeSec) * 1000.0
      if (holdMs <= 0 || sinceLastCommitMs >= holdMs) {
        committedCents = candidateCents
        lastCommitTimeSec = tSec
        releaseWindowEndS = tSec + smoothMs / 1000.0
      }
    }

    // ── 3/4. retune-speed approach, or smoothness ramp in the release window ──
    const dt = Math.max(0, tSec - lastVoicedTimeSec)
    const inRelease = tSec < releaseWindowEndS
    const tauMs = inRelease ? smoothMs : retuneMs
    if (tauMs <= 0) {
      runningCents = committedCents
    } else {
      const alpha = 1.0 - Math.exp(-dt / (tauMs / 1000.0))
      runningCents += (committedCents - runningCents) * alpha
    }
    const correctedRawCents = runningCents

    // ── 5. re-add scaled vibrato ─────────────────────────────────────────
    const correction = correctedRawCents - inputCents
    if (!vibLpfInit) {
      vibLpfState1 = correction
      vibLpfState2 = correction
      vibLpfInit = true
    } else {
      const alphaV = 1.0 - Math.exp(-dt / vibTauSec)
      vibLpfState1 += (correction - vibLpfState1) * alphaV
      vibLpfState2 += (vibLpfState1 - vibLpfState2) * alphaV
    }
    const correctionSlow = vibLpfState2
    const correctionFast = correction - correctionSlow
    const correctionApplied = correctionSlow + (1.0 - preserveV) * correctionFast

    // ── 6. scale total correction by amount ──────────────────────────────
    const finalCents = inputCents + amount * correctionApplied

    out[i] = {
      posSample: fr.posSample,
      targetF0Hz: hzOfCents(finalCents),
      correctionCents: finalCents - inputCents,
    }

    prevVoiced = true
    lastVoicedTimeSec = tSec
  }

  return out
}

// ─── MANUAL mode ────────────────────────────────────────────────────────────
// Ported term-for-term from engine/src/dsp/CorrectionCurve.cpp's
// evalManualCurve/computeManualCorrectionCurve — see that file's own header
// comment for why jumpiness/preserveVibrato drop out and why a candidate
// jump still opens the smoothness release window. Any drift between the two
// is a bug in ONE of them, not a deliberate variance (same file-level
// convention as computeAutotuneCorrectionCurve above).

// points: [{ t, hz, tension }], sorted ascending by t (normalizeAutotune's
// invariant on the engine side; the caller here is expected to already hand
// over a sorted array — op.params.manualPoints round-trips through the
// engine, which enforces it).
export function evalManualCurve(points, tSec) {
  if (!points?.length) return 0
  if (tSec <= points[0].t) return points[0].hz
  const last = points[points.length - 1]
  if (tSec >= last.t) return last.hz

  let i = 0
  while (i + 1 < points.length && points[i + 1].t < tSec) i++
  const a = points[i]
  const b = points[i + 1]
  const span = b.t - a.t
  if (span <= 0) return b.hz
  if (!(a.hz > 0) || !(b.hz > 0)) return b.hz // guard log2(<=0)

  let frac = (tSec - a.t) / span
  const tension = Math.min(1, Math.max(-1, 0.5 * ((a.tension ?? 0) + (b.tension ?? 0))))
  if (tension !== 0) {
    const eased = frac * frac * (3.0 - 2.0 * frac) // smoothstep
    frac += tension * (eased - frac)
  }
  // Interpolated in CENTS (log-frequency), not raw Hz — matches the pitch
  // canvas's linear-in-cents Y axis, so a straight line drawn on screen is
  // the same shape reconstructed between two widely-spaced breakpoints.
  const ca = centsOf(a.hz)
  const cb = centsOf(b.hz)
  return hzOfCents(ca + (cb - ca) * frac)
}

// frames: same shape computeAutotuneCorrectionCurve takes. manualPoints:
// [{ t, hz, tension }]. params: only correctionAmount/retuneSpeedMs/
// smoothnessMs are read — jumpiness/preserveVibrato are ignored, matching
// the greyed-out controls in Manual mode.
export function computeManualCorrectionCurve(frames, sampleRate, manualPoints, params) {
  if (!frames?.length || !(sampleRate > 0)) return []

  const amount = clamp01Pct(params?.correctionAmount ?? 100)
  const retuneMs = Math.max(0, params?.retuneSpeedMs ?? 20)
  const smoothMs = Math.max(0, params?.smoothnessMs ?? 20)

  // A committed-value jump larger than this (in cents) opens a smoothnessMs
  // release window, same trigger a SCALE note-switch uses.
  const STEP_THRESHOLD_CENTS = 1.0

  let haveCommitted = false
  let committedCents = 0
  let releaseWindowEndS = 0
  let runningCents = 0
  let lastVoicedTimeSec = 0
  let prevVoiced = false

  const out = new Array(frames.length)

  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i]
    const voiced = fr.f0Hz > 0

    if (!voiced) {
      out[i] = { posSample: fr.posSample, targetF0Hz: fr.f0Hz, correctionCents: 0 }
      prevVoiced = false
      continue
    }

    const tSec = fr.posSample / sampleRate
    const inputCents = centsOf(fr.f0Hz)

    const candidateHz = evalManualCurve(manualPoints, tSec)
    const candidateCents = candidateHz > 0 ? centsOf(candidateHz) : inputCents

    const onset = !prevVoiced || !haveCommitted
    if (onset) {
      committedCents = candidateCents
      releaseWindowEndS = tSec
      runningCents = inputCents
      lastVoicedTimeSec = tSec
      haveCommitted = true
    } else {
      if (Math.abs(candidateCents - committedCents) > STEP_THRESHOLD_CENTS)
        releaseWindowEndS = tSec + smoothMs / 1000.0
      committedCents = candidateCents // always commits — no hold
    }

    const dt = Math.max(0, tSec - lastVoicedTimeSec)
    const inRelease = tSec < releaseWindowEndS
    const tauMs = inRelease ? smoothMs : retuneMs
    if (tauMs <= 0) {
      runningCents = committedCents
    } else {
      const alpha = 1.0 - Math.exp(-dt / (tauMs / 1000.0))
      runningCents += (committedCents - runningCents) * alpha
    }

    const finalCents = inputCents + amount * (runningCents - inputCents)

    out[i] = {
      posSample: fr.posSample,
      targetF0Hz: hzOfCents(finalCents),
      correctionCents: finalCents - inputCents,
    }

    prevVoiced = true
    lastVoicedTimeSec = tSec
  }

  return out
}

// Dispatcher so callers (SandboxWaveformCanvas.jsx) don't need their own
// mode-`if` — mirrors SandboxRenderer.cpp's applyAutotune dispatch.
// pitchTrack: { frames, notes, sampleRate } from ensurePitchTrack/
// sandbox_getPitchTrack. params: op.params (AutotuneParams' JSON shape —
// mode/scale/key/allowedNotes/correctionAmount/retuneSpeedMs/smoothnessMs/
// jumpiness/preserveVibrato/manualPoints).
export function computeAutotuneTargetCurve(pitchTrack, params) {
  if (!pitchTrack?.frames?.length) return []
  if (params?.mode === 'manual') {
    return computeManualCorrectionCurve(pitchTrack.frames, pitchTrack.sampleRate, params.manualPoints ?? [], params)
  }
  return computeAutotuneCorrectionCurve(
    pitchTrack.frames, pitchTrack.notes ?? [], pitchTrack.sampleRate,
    params?.scale ?? 2, params?.key ?? 2, params?.allowedNotes ?? [], params,
  )
}

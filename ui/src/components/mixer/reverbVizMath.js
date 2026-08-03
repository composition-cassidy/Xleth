// ─── reverbVizMath.js ─────────────────────────────────────────────────────────
// Pure, side-effect-free math for the Reverb panel's decay-field stage and
// filter curve. Nothing here touches the DOM, the canvas, or the theme — every
// export is directly unit-testable. See __tests__/reverbViz.test.js.
//
// ── Why the numbers below are what they are ──────────────────────────────────
//
// Every constant in this file mirrors a real constant in
// engine/src/audio/XlethReverbEffect.h. The visualization's whole claim is that
// it reads parameter state honestly, which is only true if the geometry is
// derived from the DSP that is actually running. The four styles are NOT
// cosmetic variants of one algorithm — processEffect() dispatches each to a
// structurally different backend:
//
//   Generic (0) → processBlockLegacy when smoothness ("RING TAME") == 0,
//                 otherwise processBlockEnhanced. Both are 8-line FDNs, but
//                 they use DIFFERENT delay sets: the legacy path is a frozen
//                 consecutive-prime cluster (809…1499), the enhanced path a
//                 log-spread non-adjacent-prime set (601…1693). Zero input
//                 diffusion either way — Generic is the calibration reference,
//                 so every behaviour scalar is pinned to its identity value.
//
//   Room    (1) → processBlockEnhanced, 8-line FDN on a much SHORTER delay set
//                 (277…797 samples = 5.8…16.6 ms) with 8 early, dense ER taps,
//                 2 stages of input diffusion, and character scalars that make
//                 it tighter and darker: decayScale 0.75, dampingOffset +0.15,
//                 modDepthScale 0.45, erGainScale 1.15, lateGainScale 0.75.
//
//   Plate   (2) → processBlockPlate — NOT an FDN at all. A Dattorro (JAES 1997)
//                 cross-coupled figure-8 tank: a 4-stage input-diffuser cascade
//                 feeding two arms, each [damping LPF → modulated allpass →
//                 delay1 → ×decay → fixed allpass → delay2 → DC block], with
//                 arm A → arm B → arm A. There are NO discrete ER taps and it
//                 never touches the shared ER line, which is exactly why
//                 er_level / er_late change meaning here (bloom / tank level).
//
//   Hall    (3) → processBlockHall — a dedicated SIXTEEN-line FDN (not the
//                 shared 8-line one), delays 1097…2999 samples (22.9…62.5 ms),
//                 Hadamard-16 feedback, 3 input-diffusion stages, per-line
//                 two-stage damping, and stereo by temporal tap interleaving.
//                 decayScale 1.40 — the same DECAY knob buys a 40 % longer
//                 tail here than on Generic.
//
// ── One deliberate omission ──────────────────────────────────────────────────
// FdnTuning::lateGainScale and the per-style wetCalTrim are NOT used to scale
// the drawn tail amplitude. Those trims exist precisely to equalise measured
// pink-noise wet RMS across styles (Phase 2 equal-loudness calibration, locked
// by testReverbEqualLoudnessCalibration), so drawing them would show Hall as
// ~2.7× louder than Generic when the engine has deliberately made them equal.
// What IS trim-independent — and therefore honest to draw — is the ER-to-late
// RATIO, since both buses pass through the same trim; see erLateBalance().

// ── Style identity ───────────────────────────────────────────────────────────
// Indices match the engine's ReverbStyle enum and the "style"
// AudioParameterChoice ordering exactly. Do not reorder.

export const STYLE_GENERIC = 0
export const STYLE_ROOM = 1
export const STYLE_PLATE = 2
export const STYLE_HALL = 3

export const REVERB_STYLE_LABELS = ['GENERIC', 'ROOM', 'PLATE', 'HALL']

/** Engine sample rate the delay tables in this file are expressed at. */
export const TABLE_SAMPLE_RATE = 48000

/** Clamps v to [0, 1]. */
export function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/** Clamps v to [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Coerces a raw style value to a legal index.
 * The bridge surfaces the choice param as a float, so this rounds defensively.
 */
export function styleIndexOf(raw) {
  const n = Math.round(Number(raw) || 0)
  return clamp(n, 0, REVERB_STYLE_LABELS.length - 1)
}

// ── Engine-mirrored per-style tables ─────────────────────────────────────────

// kGenericBaseDelays — the LEGACY-frozen consecutive-prime cluster. Only
// reachable on Generic at smoothness == 0 (processBlockLegacy).
const GENERIC_LEGACY_DELAYS = [809, 877, 937, 1049, 1151, 1249, 1373, 1499]
// kEnhGenericBaseDelays — log-spread, non-adjacent primes.
const GENERIC_ENHANCED_DELAYS = [601, 691, 811, 937, 1093, 1259, 1483, 1693]
const ROOM_DELAYS = [277, 337, 389, 449, 521, 599, 683, 797]
// kHallBaseDelays16 — the 16-line Hall core.
const HALL_DELAYS = [
  1097, 1187, 1277, 1373, 1481, 1583, 1697, 1811,
  1933, 2069, 2207, 2351, 2503, 2657, 2819, 2999,
]
// The Plate's four addressable tank delays (delay1A, delay2A, delay1B,
// delay2B). All four are size-scaled; the two allpass lengths are not.
const PLATE_TANK_DELAYS = [7182, 6000, 6801, 5102]

// ER tap tables. `g` is the mean of the engine's gainL/gainR for that tap —
// the visualization draws one bar per arrival, not a stereo pair.
const GENERIC_ER_TAPS = [
  { ms: 3.1, g: 0.785 }, { ms: 7.3, g: 0.785 },
  { ms: 12.5, g: 0.615 }, { ms: 17.8, g: 0.615 },
  { ms: 23.2, g: 0.465 }, { ms: 29.7, g: 0.465 },
  { ms: 36.1, g: 0.330 }, { ms: 42.8, g: 0.330 },
  { ms: 51.3, g: 0.220 }, { ms: 58.9, g: 0.220 },
  { ms: 67.4, g: 0.135 }, { ms: 76.2, g: 0.090 },
]
const ROOM_ER_TAPS = [
  { ms: 2.3, g: 0.715 }, { ms: 4.7, g: 0.715 },
  { ms: 8.1, g: 0.625 }, { ms: 12.3, g: 0.625 },
  { ms: 16.9, g: 0.515 }, { ms: 21.7, g: 0.515 },
  { ms: 26.3, g: 0.385 }, { ms: 31.9, g: 0.385 },
]
const HALL_ER_TAPS = [
  { ms: 7.1, g: 0.550 }, { ms: 11.7, g: 0.550 },
  { ms: 17.3, g: 0.475 }, { ms: 23.9, g: 0.475 },
  { ms: 31.1, g: 0.385 }, { ms: 39.7, g: 0.385 },
  { ms: 49.3, g: 0.260 }, { ms: 61.7, g: 0.260 },
  { ms: 77.3, g: 0.155 }, { ms: 93.1, g: 0.155 },
]

/**
 * Per-style DSP descriptor. `topology` drives which visual family the stage
 * draws; every scalar is the engine's own value for that style.
 */
export const REVERB_STYLE_DSP = [
  {
    label: 'GENERIC',
    topology: 'fdn8',
    backendTag: '8-LINE FDN',
    modalDelays: GENERIC_ENHANCED_DELAYS,
    erTaps: GENERIC_ER_TAPS,
    diffuserDelays: [],           // kGenericTuning.inputDiffusionStages = 0
    modRates: [0.37, 0.43, 0.53, 0.61, 0.71, 0.83, 0.97, 1.13],
    modDepthScale: 1.0,           // identity — Generic is the reference
    modDepthSamples: 3.0,         // (mod_depth/100) * 3.0 * modDepthScale
    decayScale: 1.0,
    erGainScale: 1.0,
    lateGainScale: 1.0,
    dampingOffset: 0.0,
    dampingFloor: 0.0,
    dampingSpan: 1.0,
    dampingCeiling: 0.95,
  },
  {
    label: 'ROOM',
    topology: 'fdn8',
    backendTag: '8-LINE FDN',
    modalDelays: ROOM_DELAYS,
    erTaps: ROOM_ER_TAPS,
    diffuserDelays: [251, 419],   // kRoomInputDiffusionDelaysAt48k
    modRates: [0.19, 0.22, 0.27, 0.31, 0.36, 0.42, 0.49, 0.57],
    modDepthScale: 0.45,
    modDepthSamples: 3.0 * 0.45,
    decayScale: 0.75,
    erGainScale: 1.15,
    lateGainScale: 0.75,
    dampingOffset: 0.15,
    dampingFloor: 0.0,
    dampingSpan: 1.0,
    dampingCeiling: 0.95,
  },
  {
    label: 'PLATE',
    topology: 'plate',
    backendTag: 'DATTORRO TANK',
    modalDelays: PLATE_TANK_DELAYS,
    erTaps: [],                   // no discrete ER taps — never touches erLine
    diffuserDelays: [149, 263, 421, 587],  // kPlateInputDiffuserDelays
    modRates: [0.70, 1.13],       // kPlateModRateA_Hz / B
    modDepthScale: 1.0,
    modDepthSamples: 24.0,        // kPlateModDepthSamples
    decayScale: 1.0,              // honest RT60 of the round-trip path
    erGainScale: 1.0,             // unused — er_level is the bloom blend here
    lateGainScale: 1.0,
    // dampG = clamp(0.05 + (damping/100)*0.55 + smooth*0.20, 0, 0.9)
    dampingOffset: 0.0,
    dampingFloor: 0.05,
    dampingSpan: 0.55,
    dampingCeiling: 0.9,
  },
  {
    label: 'HALL',
    topology: 'fdn16',
    backendTag: '16-LINE FDN',
    modalDelays: HALL_DELAYS,
    erTaps: HALL_ER_TAPS,
    diffuserDelays: [211, 367, 557],   // kInputDiffusionDelaysAt48k, 3 stages
    modRates: [
      0.27, 0.31, 0.37, 0.43, 0.49, 0.55, 0.59, 0.67,
      0.71, 0.77, 0.83, 0.89, 0.91, 0.97, 1.01, 1.03,
    ],
    modDepthScale: 0.45,          // kHallEnh16ModDepthScale
    modDepthSamples: 3.0 * 0.45,
    decayScale: 1.40,             // kHallEnh16DecayScale
    erGainScale: 0.45,            // kHallEnh16ErGainScale
    lateGainScale: 1.20,          // kHallEnh16LateGainScale
    dampingOffset: 0.0,           // per-line offsets supersede the global one
    dampingFloor: 0.0,
    dampingSpan: 1.0,
    dampingCeiling: 0.95,
  },
]

/** Returns the DSP descriptor for a style index (clamped). */
export function styleDsp(styleIdx) {
  return REVERB_STYLE_DSP[styleIndexOf(styleIdx)]
}

/**
 * True when the engine will run the bit-frozen LegacyFdn backend: Generic with
 * smoothness ("RING TAME") at exactly 0. Any other combination runs an enhanced
 * backend. Worth surfacing — it is a different delay set and no anti-metal
 * processing at all, not a subtle tuning difference.
 */
export function isLegacyBackend(styleIdx, smoothnessPct) {
  return styleIndexOf(styleIdx) === STYLE_GENERIC && (Number(smoothnessPct) || 0) === 0
}

/** Backend tag for the stage header, accounting for the legacy Generic path. */
export function backendTag(styleIdx, smoothnessPct) {
  return isLegacyBackend(styleIdx, smoothnessPct)
    ? 'LEGACY FDN'
    : styleDsp(styleIdx).backendTag
}

// ── Size ─────────────────────────────────────────────────────────────────────

/**
 * The engine's size mapping, identical in every backend:
 *   sizeScale = (size / 100) * 0.5 + 0.75   →  [0.75, 1.25]
 * It scales the FDN line lengths / the Plate's long tank delays.
 */
export function sizeScale(sizePct) {
  return clamp01(sizePct / 100) * 0.5 + 0.75
}

/**
 * The style's recirculating delay lengths in milliseconds, size-scaled.
 * Generic swaps to the frozen legacy delay set when the legacy backend is
 * selected, because that is genuinely what would be ringing.
 */
export function modalDelaysMs(styleIdx, sizePct, smoothnessPct = 100) {
  const idx = styleIndexOf(styleIdx)
  const raw = isLegacyBackend(idx, smoothnessPct)
    ? GENERIC_LEGACY_DELAYS
    : REVERB_STYLE_DSP[idx].modalDelays
  const s = sizeScale(sizePct)
  return raw.map(d => (d * s * 1000) / TABLE_SAMPLE_RATE)
}

/** Input-diffusion stage delays in ms (not size-scaled — the engine fixes them). */
export function diffuserDelaysMs(styleIdx) {
  return styleDsp(styleIdx).diffuserDelays.map(d => (d * 1000) / TABLE_SAMPLE_RATE)
}

// ── Decay ────────────────────────────────────────────────────────────────────

/**
 * The tail's actual RT60 in seconds: the DECAY knob times the style's
 * decayScale. Hall stretches it 1.4×, Room shortens it to 0.75× — the same
 * knob position genuinely does not mean the same tail length across styles.
 */
export function effectiveRt60Sec(decaySec, styleIdx) {
  return Math.max(0.1, Number(decaySec) || 0.1) * styleDsp(styleIdx).decayScale
}

/**
 * Broadband tail amplitude (linear, 0–1) at t milliseconds after onset.
 * RT60 is by definition the time to -60 dB, i.e. a factor of 10^-3.
 */
export function decayAmplitude(tMs, rt60Sec) {
  if (tMs <= 0) return 1
  const t60 = Math.max(1e-6, rt60Sec)
  return Math.pow(10, (-3 * (tMs / 1000)) / t60)
}

/**
 * When the late tail's first energy actually arrives, in ms.
 *
 * FDN styles: pre-delay plus the shortest line length — nothing can emerge from
 * the network before its fastest line has been traversed once.
 *
 * Plate: pre-delay plus the shortest OUTPUT TAP offset, not the shortest tank
 * delay. The 7 accumulator taps read into the middle of the tank lines
 * (kPlateTapsR's last entry sits 195 samples into delay2B), so the plate speaks
 * far earlier than its 106 ms shortest delay would suggest — which is exactly
 * why a plate sounds immediate where a hall sounds distant.
 */
const PLATE_MIN_TAP_OFFSET_SAMPLES = 195

export function lateOnsetMs(styleIdx, sizePct, predelayMs, smoothnessPct = 100) {
  const pre = Math.max(0, Number(predelayMs) || 0)
  if (styleDsp(styleIdx).topology === 'plate') {
    const s = sizeScale(sizePct)
    return pre + (PLATE_MIN_TAP_OFFSET_SAMPLES * s * 1000) / TABLE_SAMPLE_RATE
  }
  const delays = modalDelaysMs(styleIdx, sizePct, smoothnessPct)
  return pre + (delays.length ? Math.min(...delays) : 0)
}

// ── Damping ──────────────────────────────────────────────────────────────────

/**
 * The engine's in-loop damping one-pole coefficient `dampG`, per style.
 *
 *   FDN styles: clamp(damping/100 + dampingOffset + smooth*0.20, 0, 0.95)
 *   Plate:      clamp(0.05 + (damping/100)*0.55 + smooth*0.20, 0, 0.9)
 *
 * RING TAME feeding damping is not incidental — it is how the anti-metal
 * control tames the tail, so the curve moves when you turn it.
 */
export function dampingCoeff(dampingPct, styleIdx, smoothnessPct = 0) {
  const d = styleDsp(styleIdx)
  const smoothFrac = clamp01((Number(smoothnessPct) || 0) / 100)
  const raw = d.dampingFloor
    + clamp01((Number(dampingPct) || 0) / 100) * d.dampingSpan
    + d.dampingOffset
    + smoothFrac * 0.20
  return clamp(raw, 0, d.dampingCeiling)
}

/**
 * HF magnitude retained per pass through the damping filter.
 *
 * The filter is a one-pole y[n] = (1-g)·x[n] + g·y[n-1]; its DC gain is 1 and
 * its Nyquist gain is (1-g)/(1+g). So each recirculation costs the top octave
 * that factor RELATIVE to the broadband decay — which is the whole reason a
 * damped tail goes dull before it goes quiet.
 */
export function hfLossPerPass(dampingPct, styleIdx, smoothnessPct = 0) {
  const g = dampingCoeff(dampingPct, styleIdx, smoothnessPct)
  return (1 - g) / (1 + g)
}

/**
 * Mean time between damping-filter passes, in ms.
 *
 * FDN: each line applies damping once per recirculation, so it is the mean line
 * length. Plate: the damping one-pole sits at each ARM input and the figure-8
 * traverses both arms per round trip, so it is half the round-trip time.
 */
export function meanDampingPassMs(styleIdx, sizePct, smoothnessPct = 100) {
  const delays = modalDelaysMs(styleIdx, sizePct, smoothnessPct)
  if (delays.length === 0) return 1
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length
  if (styleDsp(styleIdx).topology !== 'plate') return mean
  // The four tank delays are only part of an arm; the allpass lengths
  // (modAP + AP2, per arm) ride along too. Round trip = sum of everything.
  const s = sizeScale(sizePct)
  const allpassMs = ((1084 + 2903 + 1465 + 4283) * 1000) / TABLE_SAMPLE_RATE
  const tankMs = delays.reduce((a, b) => a + b, 0)
  return (tankMs + allpassMs * s) / 2
}

/**
 * High-frequency tail amplitude at t ms: the broadband envelope with the
 * accumulated per-pass HF loss applied. Equals the broadband curve exactly when
 * damping produces g = 0, and collapses ahead of it as damping rises.
 */
export function hfAmplitude(tMs, rt60Sec, meanPassMs, hfLoss) {
  const broadband = decayAmplitude(tMs, rt60Sec)
  if (hfLoss >= 1) return broadband
  const passes = Math.max(0, tMs) / Math.max(1e-6, meanPassMs)
  return broadband * Math.pow(Math.max(1e-9, hfLoss), passes)
}

/**
 * The time (ms) at which the HF band has fallen to -60 dB — i.e. where the tail
 * has gone completely dull. Solved in closed form rather than searched:
 *
 *   10^(-3t/T60) · L^(t/P) = 10^-3
 *   ⇒ t · (−3/T60 + log10(L)/P) = −3      (t in seconds, P in seconds)
 */
export function hfRt60Ms(rt60Sec, meanPassMs, hfLoss) {
  const t60 = Math.max(1e-6, rt60Sec)
  if (hfLoss >= 1) return t60 * 1000
  const passSec = Math.max(1e-9, meanPassMs / 1000)
  const slope = -3 / t60 + Math.log10(Math.max(1e-9, hfLoss)) / passSec
  if (slope >= -1e-12) return t60 * 1000
  return (-3 / slope) * 1000
}

// ── ER / late balance ────────────────────────────────────────────────────────

/**
 * The style's early-reflection level relative to its late tail, independent of
 * the equal-loudness wet trim (both buses share that trim, so it cancels):
 *
 *   balance = erGainScale / lateGainScale
 *
 * Generic 1.00 (reference) · Room 1.53 (ER-forward, a small bright space) ·
 * Hall 0.375 (tail-forward, the reflections are a long way off).
 * Returns 1 for Plate, which has no ER bus at all.
 */
export function erLateBalance(styleIdx) {
  const d = styleDsp(styleIdx)
  if (d.topology === 'plate') return 1
  return d.erGainScale / d.lateGainScale
}

/**
 * The drawn ER arrivals: each engine tap, shifted by pre-delay, with its height
 * scaled by er_level and the style's erGainScale.
 *
 * Plate returns [] — it has no discrete ER taps, and inventing some would be
 * the visualization lying about the algorithm.
 */
export function erArrivals(styleIdx, erLevelPct, predelayMs) {
  const d = styleDsp(styleIdx)
  const level = clamp01((Number(erLevelPct) || 0) / 100)
  const pre = Math.max(0, Number(predelayMs) || 0)
  return d.erTaps.map(tap => ({
    ms: pre + tap.ms,
    g: clamp01(tap.g * level * d.erGainScale),
  }))
}

/**
 * Plate's front-end bloom: the 4-stage input-diffuser cascade blended against
 * the raw pre-delay signal.
 *
 *   diffused = preOut·(1 − blend) + diffused·blend,  blend = er_level/100
 *
 * Returns one entry per stage with its cumulative arrival time, so the stage
 * geometry reads as a widening smear rather than a bar chart.
 */
export function plateBloomStages(erLevelPct, predelayMs) {
  const blend = clamp01((Number(erLevelPct) || 0) / 100)
  const pre = Math.max(0, Number(predelayMs) || 0)
  let acc = 0
  return diffuserDelaysMs(STYLE_PLATE).map((ms, i) => {
    acc += ms
    return {
      stage: i + 1,
      spanMs: ms,
      atMs: pre + acc,
      // Later stages only contribute once the earlier ones have; the cascade's
      // contribution to the wet path is the blend, uniformly.
      g: blend,
    }
  })
}

// ── Echo-density comb ────────────────────────────────────────────────────────

/**
 * Recirculation arrival times (ms) for the style's delay lines: every multiple
 * k·delay that lands inside the window.
 *
 * This is the single most honest way to show topology, because it is literally
 * what the delay network does: Hall's 16 long lines produce a dense, late,
 * evenly-smeared comb; Room's 8 short lines produce a very early one that piles
 * up almost immediately; the Plate's 4 cross-coupled tank delays produce a
 * sparse, widely spaced one.
 *
 * `maxPerLine` bounds the work per line, so the returned span scales naturally
 * with the topology instead of being clipped to a fixed window.
 */
export function recirculationTimesMs(delaysMs, windowMs, maxPerLine = 24, maxTotal = 400) {
  const out = []
  for (const d of delaysMs) {
    if (!(d > 0)) continue
    for (let k = 1; k <= maxPerLine; k++) {
      const t = d * k
      if (t > windowMs) break
      out.push(t)
      if (out.length >= maxTotal) return out.sort((a, b) => a - b)
    }
  }
  return out.sort((a, b) => a - b)
}

// ── Modulation ───────────────────────────────────────────────────────────────

/**
 * Mean LFO frequency (Hz) actually running, given the knob.
 * The engine advances each line's phase at `baseRate[i] * (mod_rate/100)`, so
 * mod_rate is a rate SCALER, not a frequency — at 0 the modulation stops dead.
 */
export function modLfoHz(modRatePct, styleIdx) {
  const rates = styleDsp(styleIdx).modRates
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  return mean * clamp01((Number(modRatePct) || 0) / 100)
}

/**
 * Peak modulation excursion in samples at the current depth:
 *   FDN styles: (mod_depth/100) · 3.0 · modDepthScale
 *   Plate:      (mod_depth/100) · 24        (kPlateModDepthSamples)
 * The Plate's excursion is an order of magnitude larger by design — it is what
 * decoheres the tank's regeneration and kills the comb percept at long decay.
 */
export function modExcursionSamples(modDepthPct, styleIdx) {
  return clamp01((Number(modDepthPct) || 0) / 100) * styleDsp(styleIdx).modDepthSamples
}

/**
 * Normalised (0–1) modulation intensity for the visualization's tail ripple —
 * excursion relative to the largest any style can reach, so switching to Plate
 * at the same knob position visibly ripples harder, as it actually does.
 */
export function modIntensity(modRatePct, modDepthPct, styleIdx) {
  const maxSamples = 24.0   // the Plate's ceiling — the largest in the engine
  const depth = modExcursionSamples(modDepthPct, styleIdx) / maxSamples
  const rate = clamp01((Number(modRatePct) || 0) / 100)
  // Rate 0 freezes the LFO, so no rate means no visible movement regardless of
  // depth; a floor keeps a static depth offset legible.
  return clamp01(depth * (0.25 + 0.75 * rate))
}

// ── Time axis ────────────────────────────────────────────────────────────────
//
// The stage plots time logarithmically from 1 ms to 60 s. A linear axis cannot
// show this parameter set: pre-delay and the ER cluster live at 2–100 ms while
// the tail runs to 42 s (decay 30 × Hall's 1.4), so a linear axis wide enough
// for the tail crushes every early event into the first two pixels. Log time
// puts pre-delay, reflections and tail on screen simultaneously and makes the
// RT60 marker sweep visibly across the full width as DECAY turns.

export const AXIS_T_MIN_MS = 1
export const AXIS_T_MAX_MS = 60000

/** Log-maps a time in ms to a normalised x position in [0, 1]. */
export function timeToNorm(tMs, tMin = AXIS_T_MIN_MS, tMax = AXIS_T_MAX_MS) {
  const t = clamp(tMs, tMin, tMax)
  return (Math.log2(t) - Math.log2(tMin)) / (Math.log2(tMax) - Math.log2(tMin))
}

/** Inverse of timeToNorm. */
export function normToTime(norm, tMin = AXIS_T_MIN_MS, tMax = AXIS_T_MAX_MS) {
  const n = clamp01(norm)
  return tMin * Math.pow(2, n * (Math.log2(tMax) - Math.log2(tMin)))
}

/** Maps a linear amplitude (0–1) to a normalised y in [0, 1] (0 = top). */
export function ampToNorm(amp, floorDb = -60) {
  const db = 20 * Math.log10(Math.max(amp, 1e-9))
  return clamp01(-db / -floorDb)
}

// ── Reverb wet-path filter range ─────────────────────────────────────────────
// Engine NormalisableRange bounds for the reverb's own filter params. They are
// NOT the delay's: locut tops out at 500 Hz here, not 2 kHz.

export const REVERB_LOCUT_MIN = 20
export const REVERB_LOCUT_MAX = 500
export const REVERB_HICUT_MIN = 1000
export const REVERB_HICUT_MAX = 20000

// The drawn axis is tightened to the span the two handles can actually reach,
// so both stay comfortably grabbable in a compact strip cell.
export const REVERB_FILTER_F_MIN = 20
export const REVERB_FILTER_F_MAX = 20000

// ── Readout formatting ───────────────────────────────────────────────────────

/** "0.85 s" / "12.4 s" — the tail lengths this panel deals in. */
export function formatSeconds(sec) {
  if (sec >= 10) return `${sec.toFixed(1)} s`
  return `${sec.toFixed(2)} s`
}

/** "8 ms" / "1.20 s" — used for arrival times on the log axis. */
export function formatTimeMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 100) return `${Math.round(ms)} ms`
  return `${ms.toFixed(1)} ms`
}

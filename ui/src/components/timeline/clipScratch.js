// Per-clip Scratch vocabulary, shared by the clip dropdown and the floating
// rate-graph editor.
//
// Everything above the "Tension" divider was RELOCATED VERBATIM from
// TimelineView.jsx (SCRATCH_PRESETS, generateBabyScratchCurve,
// scratchCurvesMatch, inferBabyScratchSettings, ...) so the dropdown and the
// graph editor share one definition of what a preset is. TimelineView imports
// them back; there is no second copy.
//
// ── ENGINE FIDELITY ──────────────────────────────────────────────────────────
// The evaluator these helpers mirror is engine/src/model/ClipModulationEvaluator.cpp
// evaluateScratch(). Two facts about it drive this whole module:
//
//   1. Segments are LINEAR. The current rate comes from lerpRate() and the
//      source-position integral is a trapezoid sum — both exactly a straight
//      ramp between consecutive points:
//
//          currentRate = lerpRate(ta, pts[i].rateMultiplier,
//                                 tb, pts[i + 1].rateMultiplier, tNow);
//          integral   += 0.5 * (ra + rb) * (tb - ta);
//
//   2. ScratchPoint::curve IS NEVER READ. It round-trips through Clip.cpp and
//      XlethEngineService.cpp (and is NaN-sanitized on the way in), but no
//      evaluator, reader or compositor consumes it. There is no engine-side
//      tension semantic to match.
//
// So tension here is authored in the UI and BAKED DOWN into real breakpoints on
// commit (see bakeScratchCurve). What the graph draws is what the audio thread
// plays, because the bend is literally made of the linear segments the engine
// already understands — no engine change, no lying preview.
//
// The author model kept in the editor is `{ time, rateMultiplier, tension }`;
// the engine model is `{ time, rateMultiplier, curve }`. bakeScratchCurve()
// converts author -> engine, unbakeScratchCurve() recovers author from engine.

// ── Edge / time modes ───────────────────────────────────────────────────────

// engine ClipModulation::Scratch::EdgeMode — all four, including the two the
// dropdown used to hide.
export const SCRATCH_EDGE_MODES = [
  ['clamp', 'Clamp'],
  ['silence', 'Silence'],
  ['wrap', 'Wrap'],
  ['pingPong', 'Ping-Pong'],
]

// engine ClipModulation::Scratch::CurveTimeMode.
export const SCRATCH_TIME_MODES = [
  ['clipPercent', '%'],
  ['beats', 'Beats'],
  ['clipSeconds', 'Sec'],
]

export const SCRATCH_TIME_MODE_LABELS = {
  clipPercent: 'Clip %',
  beats: 'Beats',
  clipSeconds: 'Seconds',
}

export const SCRATCH_GAIN_COMP_MIN_DB = -12
export const SCRATCH_GAIN_COMP_MAX_DB = 12

// ── Baby-scratch generator ──────────────────────────────────────────────────

export const SCRATCH_BABY_DEFAULT_COUNT = 2
export const SCRATCH_BABY_DEFAULT_LENGTH_BEATS = 1
export const SCRATCH_BABY_LENGTHS = [
  [0.25, '1/4 beat'],
  [0.5, '1/2 beat'],
  [1, '1 beat'],
  [2, '2 beats'],
]

export function clampScratchCount(value) {
  return Math.max(1, Math.min(8, Math.round(Number(value) || SCRATCH_BABY_DEFAULT_COUNT)))
}

export function scratchNumbersMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.0001
}

export function normalizeScratchLengthBeats(value) {
  const numeric = Number(value)
  return SCRATCH_BABY_LENGTHS.some(([length]) => scratchNumbersMatch(length, numeric))
    ? numeric
    : SCRATCH_BABY_DEFAULT_LENGTH_BEATS
}

export function generateBabyScratchCurve(count, lengthBeats) {
  const scratchCount = clampScratchCount(count)
  const length = normalizeScratchLengthBeats(lengthBeats)
  const curve = []
  const addPoint = (time, rateMultiplier) => {
    const last = curve[curve.length - 1]
    if (last && scratchNumbersMatch(last.time, time)) {
      last.rateMultiplier = rateMultiplier
      last.curve = 0.0
      return
    }
    curve.push({ time, rateMultiplier, curve: 0.0 })
  }

  for (let i = 0; i < scratchCount; i += 1) {
    const segment = length / scratchCount
    const start = i * segment
    const mid = start + segment * 0.5
    const end = start + segment
    addPoint(start, 1.0)
    addPoint(mid, -1.0)
    addPoint(end, 1.0)
  }
  return curve
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const SCRATCH_PRESETS = [
  {
    key: 'normal',
    label: 'Normal',
    timeMode: 'clipPercent',
    curve: [
      { time: 0.0, rateMultiplier: 1.0, curve: 0.0 },
      { time: 1.0, rateMultiplier: 1.0, curve: 0.0 },
    ],
  },
  {
    key: 'stop',
    label: 'Stop',
    timeMode: 'clipSeconds',
    curve: [
      { time: 0.0, rateMultiplier: 1.0, curve: 0.0 },
      { time: 0.10, rateMultiplier: 0.0, curve: 0.0 },
    ],
  },
  {
    key: 'reverse',
    label: 'Reverse',
    timeMode: 'clipPercent',
    curve: [
      { time: 0.0, rateMultiplier: -1.0, curve: 0.0 },
      { time: 1.0, rateMultiplier: -1.0, curve: 0.0 },
    ],
  },
  {
    key: 'babyScratch',
    label: 'Baby Scratch',
    timeMode: 'beats',
    curve: generateBabyScratchCurve(SCRATCH_BABY_DEFAULT_COUNT, SCRATCH_BABY_DEFAULT_LENGTH_BEATS),
  },
  {
    key: 'tapeStop',
    label: 'Tape Stop',
    timeMode: 'clipSeconds',
    curve: [
      { time: 0.0, rateMultiplier: 1.0, curve: 0.0 },
      { time: 0.45, rateMultiplier: 0.0, curve: 0.0 },
    ],
  },
]

// Short chip labels for the graph editor's stamp row (space is tight there).
export const SCRATCH_PRESET_CHIPS = [
  ['normal', 'Normal'],
  ['stop', 'Stop'],
  ['reverse', 'Reverse'],
  ['babyScratch', 'Baby'],
  ['tapeStop', 'Tape Stop'],
]

export const SCRATCH_DEFAULTS = {
  enabled: false,
  timeMode: 'clipPercent',
  smoothingMs: 2,
  gainCompensationDb: 0,
  edgeMode: 'clamp',
  curve: SCRATCH_PRESETS[0].curve,
}

export function cloneScratchCurve(curve) {
  return (curve ?? []).map(point => ({
    time: point.time,
    rateMultiplier: point.rateMultiplier,
    curve: point.curve,
  }))
}

export function scratchCurvesMatch(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((point, i) =>
    scratchNumbersMatch(point.time, b[i].time) &&
    scratchNumbersMatch(point.rateMultiplier, b[i].rateMultiplier) &&
    scratchNumbersMatch(point.curve, b[i].curve)
  )
}

export function scratchTimeModeMatches(a, b) {
  return (a ?? SCRATCH_DEFAULTS.timeMode) === b
}

export function inferBabyScratchSettings(scratch) {
  if (!scratchTimeModeMatches(scratch?.timeMode, 'beats')) return null
  for (const [lengthBeats, lengthLabel] of SCRATCH_BABY_LENGTHS) {
    for (let count = 1; count <= 8; count += 1) {
      if (scratchCurvesMatch(scratch?.curve, generateBabyScratchCurve(count, lengthBeats))) {
        return { count, lengthBeats, lengthLabel }
      }
    }
  }
  return null
}

// 'custom' whenever the stored curve is not byte-for-byte a preset — which is
// exactly what a manual graph edit produces, so the editor's Custom indicator
// needs no separate dirty flag.
export function scratchPresetKeyForScratch(scratch) {
  if (inferBabyScratchSettings(scratch)) return 'babyScratch'
  return SCRATCH_PRESETS
    .filter(preset => preset.key !== 'babyScratch')
    .find(preset => scratchTimeModeMatches(scratch?.timeMode, preset.timeMode) && scratchCurvesMatch(scratch?.curve, preset.curve))
    ?.key ?? 'custom'
}

// A preset "stamp": the points AND the time mode they were authored in, in one
// patch, because a preset's numbers are only meaningful in its own time mode.
export function scratchPresetPatch(presetKey, { scratchCount = SCRATCH_BABY_DEFAULT_COUNT, lengthBeats = SCRATCH_BABY_DEFAULT_LENGTH_BEATS } = {}) {
  const preset = SCRATCH_PRESETS.find(p => p.key === presetKey) ?? SCRATCH_PRESETS[0]
  const curve = preset.key === 'babyScratch'
    ? generateBabyScratchCurve(scratchCount, lengthBeats)
    : preset.curve
  return {
    enabled: true,
    timeMode: preset.timeMode,
    curve: cloneScratchCurve(curve),
  }
}

export function scratchCurveSummary(scratch) {
  const babySettings = inferBabyScratchSettings(scratch)
  if (babySettings) return `Curve: ${babySettings.count} scratches / ${babySettings.lengthLabel}`

  const preset = SCRATCH_PRESETS
    .filter(p => p.key !== 'babyScratch')
    .find(p => scratchTimeModeMatches(scratch?.timeMode, p.timeMode) && scratchCurvesMatch(scratch?.curve, p.curve))
  if (preset?.timeMode === 'clipSeconds') {
    const endTime = preset.curve[preset.curve.length - 1]?.time ?? 0
    return `Curve: fixed ${Number(endTime).toFixed(2)}s`
  }
  if (preset?.timeMode === 'clipPercent') return 'Curve: full clip'
  return 'Curve: Custom'
}

// ═══════════════════════════════════════════════════════════════════════════
// Tension — authored in the UI, BAKED into real breakpoints
// ═══════════════════════════════════════════════════════════════════════════
//
// A bent segment is emitted as its leading anchor plus SCRATCH_BAKE_SEGMENTS-1
// interior points sampled off a quadratic Bézier, so the anchor sits at index i
// and its partner anchor at exactly i + SCRATCH_BAKE_SEGMENTS. That fixed stride
// is what makes the bake reversible: unbakeScratchCurve() can test a candidate
// span against the bake it would have produced and collapse it back to one
// author point when it matches.
//
// The anchor also keeps its tension in the (engine-inert) `curve` field, which
// is what tells the unbaker a bend is worth testing for. Nothing depends on the
// engine honouring it — it is a UI breadcrumb that happens to persist for free.

export const SCRATCH_BAKE_SEGMENTS = 12
export const SCRATCH_TENSION_EPS = 0.005

// A segment whose endpoints share a rate has nothing to ease between: the
// quadratic degenerates to the same flat line, so a handle there would move a
// parameter with no audible or visible effect. Those segments get no handle and
// bake to a plain straight line.
export const SCRATCH_FLAT_RATE_EPS = 1e-3

export const SCRATCH_MIN_POINTS = 2
export const SCRATCH_MAX_POINTS = 24     // AUTHOR points; a fully bent curve
                                         // bakes to at most 24 * 12 = 288.
export const SCRATCH_RATE_MIN = -2
export const SCRATCH_RATE_MAX = 2

const clampNum = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
const round5 = (x) => Number(Number(x).toFixed(5))

export function clampScratchTension(x) {
  const n = Number(x)
  return Number.isFinite(n) ? clampNum(n, -1, 1) : 0
}

// Drop anything the engine would reject, then order by time. The bridge
// stable_sorts on the way in anyway (XlethEngineService.cpp), so an unsorted
// list would silently reorder under the editor's feet — normalize up front.
export function normalizeScratchCurve(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(p => p && Number.isFinite(p.time) && Number.isFinite(p.rateMultiplier))
    .map(p => ({
      time: p.time,
      rateMultiplier: clampNum(p.rateMultiplier, SCRATCH_RATE_MIN, SCRATCH_RATE_MAX),
      curve: Number.isFinite(p.curve) ? p.curve : 0,
    }))
    .sort((a, b) => a.time - b.time)
}

// Quadratic control point for a segment, in DATA space (never pixels — a
// pixel-space control would make the baked audio depend on the window size).
//
// Note what this shape means: the control's time factor is 0.5 + t*0.45 and its
// rate factor 0.5 - t*0.45, so tension EASES the transition (reach the new rate
// early or late) rather than bowing perpendicular to the chord. That is the
// right control for a rate curve — a tape stop wants "hold speed, then dive" —
// and it is also why a flat segment cannot bend.
function controlPoint(a, b, tension) {
  return {
    time: a.time + (b.time - a.time) * (0.5 + tension * 0.45),
    rateMultiplier: a.rateMultiplier
      + (b.rateMultiplier - a.rateMultiplier) * (0.5 - tension * 0.45),
  }
}

function bezierAt(a, b, tension, u) {
  const c = controlPoint(a, b, tension)
  const m = 1 - u
  const w0 = m * m
  const w1 = 2 * u * m
  const w2 = u * u
  return {
    time: w0 * a.time + w1 * c.time + w2 * b.time,
    rateMultiplier: w0 * a.rateMultiplier + w1 * c.rateMultiplier + w2 * b.rateMultiplier,
  }
}

export function scratchSegmentCanBend(a, b) {
  if (!a || !b) return false
  if (!(b.time > a.time)) return false
  return Math.abs(b.rateMultiplier - a.rateMultiplier) >= SCRATCH_FLAT_RATE_EPS
}

// The SCRATCH_BAKE_SEGMENTS points that stand in for one bent segment: the
// anchor (carrying the tension) followed by the interior samples. `b` itself is
// NOT included — the next segment's anchor emits it.
export function bakeScratchSegment(a, b, tension) {
  const out = [{
    time: round5(a.time),
    rateMultiplier: round5(a.rateMultiplier),
    curve: round5(tension),
  }]
  for (let k = 1; k < SCRATCH_BAKE_SEGMENTS; k += 1) {
    const p = bezierAt(a, b, tension, k / SCRATCH_BAKE_SEGMENTS)
    out.push({
      time: round5(p.time),
      rateMultiplier: round5(clampNum(p.rateMultiplier, SCRATCH_RATE_MIN, SCRATCH_RATE_MAX)),
      curve: 0,
    })
  }
  return out
}

// Author points `{ time, rateMultiplier, tension }` -> engine curve
// `{ time, rateMultiplier, curve }`. With no tension anywhere this is the
// identity (modulo rounding), so an untouched preset still matches
// scratchCurvesMatch and keeps its name in the dropdown.
export function bakeScratchCurve(authorPoints) {
  const pts = (Array.isArray(authorPoints) ? authorPoints : [])
    .filter(p => p && Number.isFinite(p.time) && Number.isFinite(p.rateMultiplier))
    .map(p => ({
      time: p.time,
      rateMultiplier: clampNum(p.rateMultiplier, SCRATCH_RATE_MIN, SCRATCH_RATE_MAX),
      tension: clampScratchTension(p.tension),
    }))
    .sort((a, b) => a.time - b.time)

  const out = []
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[i + 1]
    const tension = b ? a.tension : 0
    if (b && Math.abs(tension) >= SCRATCH_TENSION_EPS && scratchSegmentCanBend(a, b)) {
      out.push(...bakeScratchSegment(a, b, tension))
    } else {
      out.push({
        time: round5(a.time),
        rateMultiplier: round5(a.rateMultiplier),
        curve: 0,
      })
    }
  }
  return out
}

// Engine curve -> author points. Collapses any span that is exactly the bake of
// its endpoints back into a single tensioned anchor.
//
// A stored `curve` that does NOT front a matching bake (a hand-edited project,
// or a future preset that sets tension without baking) is reported as tension 0.
// That is deliberate: the engine plays such a curve straight, and the graph is
// only allowed to draw what the engine plays.
export function unbakeScratchCurve(rawCurve) {
  const pts = normalizeScratchCurve(rawCurve)
  const out = []
  let i = 0
  while (i < pts.length) {
    const tension = pts[i].curve
    const j = i + SCRATCH_BAKE_SEGMENTS
    if (Math.abs(tension) >= SCRATCH_TENSION_EPS && j < pts.length) {
      const expected = bakeScratchSegment(pts[i], pts[j], tension)
      let matches = true
      for (let k = 1; k < SCRATCH_BAKE_SEGMENTS && matches; k += 1) {
        matches = scratchNumbersMatch(pts[i + k].time, expected[k].time)
          && scratchNumbersMatch(pts[i + k].rateMultiplier, expected[k].rateMultiplier)
      }
      if (matches) {
        out.push({
          time: pts[i].time,
          rateMultiplier: pts[i].rateMultiplier,
          tension: clampScratchTension(tension),
        })
        i = j
        continue
      }
    }
    out.push({ time: pts[i].time, rateMultiplier: pts[i].rateMultiplier, tension: 0 })
    i += 1
  }
  return out
}

// ── Tension handle geometry ─────────────────────────────────────────────────

// The diamond sits at u = 0.5 on the drawn curve. Expanding the Bézier there
// collapses to a plain lerp of the chord — which is why this is a closed form
// and not a curve search.
export function scratchTensionHandle(a, b, tension) {
  const k = clampScratchTension(tension)
  return {
    t: a.time + (b.time - a.time) * (0.5 + k * 0.225),
    v: a.rateMultiplier + (b.rateMultiplier - a.rateMultiplier) * (0.5 - k * 0.225),
  }
}

// Tension implied by a pointer at (px, py) in canvas pixels. The handle's locus
// is a straight line in tension, so this is a least-squares projection onto it —
// done in PIXELS so the drag feels the same whatever the axis scales are.
export function scratchTensionFromPointer(a, b, geo, px, py) {
  const t0 = a.time + (b.time - a.time) * 0.5
  const v0 = a.rateMultiplier + (b.rateMultiplier - a.rateMultiplier) * 0.5
  const x0 = geo.xOf(t0)
  const y0 = geo.yOf(v0)
  const dx = geo.xOf(t0 + (b.time - a.time) * 0.225) - x0
  const dy = geo.yOf(v0 - (b.rateMultiplier - a.rateMultiplier) * 0.225) - y0
  const dd = dx * dx + dy * dy
  if (dd < 1e-9) return 0
  return clampScratchTension(((px - x0) * dx + (py - y0) * dy) / dd)
}

// ── Graph plumbing ──────────────────────────────────────────────────────────

// BreakpointCurveEditor adapter for AUTHOR points. `tension` rides along
// untouched through write()'s spread, so dragging a point keeps its bend.
export const SCRATCH_POINT_ADAPTER = {
  read: (p) => ({ t: p.time, v: p.rateMultiplier }),
  write: (p, { t, v }) => ({ ...p, time: t, rateMultiplier: v }),
  create: ({ t, v }) => ({ time: t, rateMultiplier: v, tension: 0 }),
}

const BAKED_ADAPTER = {
  read: (p) => ({ t: p.time, v: p.rateMultiplier }),
}

// Port of the engine's evaluateScratch() current-rate lookup, INCLUDING its two
// asymmetric edges:
//
//   if (tNow <= t0) {
//       currentRate = (t0 > 0.0) ? 1.0 : pts.front().rateMultiplier;
//       if (tNow == t0) currentRate = pts.front().rateMultiplier;
//   } else if (tNow >= tN) {
//       currentRate = pts.back().rateMultiplier;
//   }
//
// i.e. a curve whose first point is after zero plays at UNITY before it (which
// is what makes Stop and Tape Stop sound right), while a curve running past its
// last point holds that point's rate. Evaluating in time-mode units rather than
// seconds is safe: scratchPointTimeSeconds() is a positive linear map for all
// three modes, so it preserves both ordering and the `t0 > 0` test.
export function evaluateScratchRate(points, adapter, t) {
  if (!Array.isArray(points) || points.length === 0) return 1
  const first = adapter.read(points[0])
  if (points.length === 1) return first.v
  const last = adapter.read(points[points.length - 1])

  if (t <= first.t) {
    if (t === first.t) return first.v
    return first.t > 0 ? 1 : first.v
  }
  if (t >= last.t) return last.v

  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = adapter.read(points[i])
    const b = adapter.read(points[i + 1])
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      if (span <= 0) return a.v
      return a.v + ((t - a.t) / span) * (b.v - a.v)
    }
  }
  return last.v
}

// The sampler the graph draws through. Bakes ONCE per author-point identity —
// BreakpointCurveEditor calls sample() per pixel column, so baking inside it
// would rebuild the curve ~470 times a frame.
export function makeScratchSampler(authorPoints) {
  const baked = bakeScratchCurve(authorPoints)
  return (_points, _adapter, t) => evaluateScratchRate(baked, BAKED_ADAPTER, t)
}

// ── Axis domain / labels ────────────────────────────────────────────────────

// Point times are stored in the units of the ACTIVE time mode and are never
// rescaled when the mode changes — switching modes reinterprets the same
// numbers, exactly as the engine does. The axis therefore has to change domain,
// and is stretched past its natural end if a point lives beyond it so nothing
// can be dragged off-canvas and lost.
export function scratchTimeDomain(timeMode, { clipSeconds = 0, clipBeats = 0 } = {}, points = []) {
  const natural = timeMode === 'clipPercent'
    ? 1
    : timeMode === 'beats'
      ? (clipBeats > 0 ? clipBeats : 8)
      : (clipSeconds > 0 ? clipSeconds : 4)
  let maxPt = 0
  for (const p of points) {
    const t = Number(p?.time)
    if (Number.isFinite(t) && t > maxPt) maxPt = t
  }
  // Only stretch when something actually lives past the natural end — a point
  // sitting exactly ON it (every full-clip preset) must not push the axis out.
  const stretched = maxPt > natural ? maxPt * 1.05 : 0
  return { tMin: 0, tMax: Math.max(natural, stretched, 1e-3) }
}

export function formatScratchTime(timeMode, t) {
  if (timeMode === 'clipPercent') return `${Math.round(t * 100)}%`
  if (timeMode === 'beats') return Number.isInteger(t) ? `${t}` : t.toFixed(2)
  return `${t.toFixed(2)}s`
}

export function scratchXLabels(timeMode, tMax, divisions = 4) {
  const out = []
  for (let i = 0; i <= divisions; i += 1) {
    const t = (tMax * i) / divisions
    out.push({ t, text: formatScratchTime(timeMode, t) })
  }
  return out
}

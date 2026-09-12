// Per-clip Vibrato shape vocabulary, shared by the clip dropdown and the
// floating graph editor.
//
// The evaluators here are ports of the engine's, NOT independent designs:
//   engine/src/model/ClipModulationEvaluator.cpp
//     evaluateBuiltinShape()  ~L60
//     evaluateCustomShape()   ~L85  (see evaluateLinearBreakpoints in
//                                    components/common/breakpointCurveMath.js)
// The graph must draw exactly what the audio thread plays, so if the engine
// changes shape, this changes with it.
//
// Note the Triangle: the engine's is 0 -> +1 -> 0 -> -1 -> 0 across the cycle
// (peak at t=0.25). Some sketches of this feature used a phase-shifted triangle;
// the engine's definition is the authoritative one.

import { TIME_VALUE_ADAPTER, evaluateLinearBreakpoints } from '../common/breakpointCurveMath.js'

// Engine ClipModulation::Vibrato::Shape, in dropdown order. 'custom' is the
// breakpoint-graph shape and is only meaningfully editable in the graph editor.
export const VIBRATO_SHAPES = [
  ['sine', 'Sine'], ['triangle', 'Triangle'],
  ['sawUp', 'Saw Up'], ['sawDown', 'Saw Down'], ['square', 'Square'],
  ['custom', 'Custom'],
]

// Short labels for the graph editor's chip row (space is tight there).
export const VIBRATO_SHAPE_CHIPS = [
  ['sine', 'Sine'], ['triangle', 'Tri'],
  ['sawUp', 'Saw ↑'], ['sawDown', 'Saw ↓'], ['square', 'Sqr'],
  ['custom', 'Custom'],
]

export const VIBRATO_SYNC_DIVISIONS = [
  ['whole', 'Whole'], ['half', '1/2'], ['quarter', '1/4'], ['eighth', '1/8'],
  ['sixteenth', '1/16'], ['thirtySecond', '1/32'],
  ['quarterTriplet', '1/4T'], ['eighthTriplet', '1/8T'], ['sixteenthTriplet', '1/16T'],
  ['quarterDotted', '1/4D'], ['eighthDotted', '1/8D'], ['sixteenthDotted', '1/16D'],
]

export const VIBRATO_MIN_POINTS = 2
export const VIBRATO_MAX_POINTS = 64

// Seed for a freshly-Custom vibrato whose customShape is still empty: six
// breakpoints approximating one sine cycle, so switching to Custom starts from
// something musical rather than a flat line the user has to build from scratch.
export const DEFAULT_CUSTOM_SHAPE = Object.freeze([
  { time: 0.0,  value: 0 },
  { time: 0.25, value: 1 },
  { time: 0.5,  value: 0 },
  { time: 0.75, value: -1 },
  { time: 1.0,  value: 0 },
])

export function defaultCustomShape() {
  return DEFAULT_CUSTOM_SHAPE.map(p => ({ ...p }))
}

// Port of the engine's evaluateBuiltinShape(). `p` is phase in [0, 1).
export function evaluateBuiltinVibratoShape(shape, p) {
  switch (shape) {
    case 'triangle':
      if (p < 0.25) return 4 * p
      if (p < 0.75) return 2 - 4 * p
      return 4 * p - 4
    case 'sawUp':   return 2 * p - 1
    case 'sawDown': return 1 - 2 * p
    case 'square':  return p < 0.5 ? 1 : -1
    case 'custom':  return 0     // handled by the caller (needs the breakpoints)
    case 'sine':
    default:        return Math.sin(2 * Math.PI * p)
  }
}

// Drop anything the engine would reject, then order by time. The engine treats
// customShape as non-decreasing in time, so an unsorted list from an older
// project would evaluate oddly rather than error — normalize on the way in.
export function normalizeCustomShape(raw) {
  if (!Array.isArray(raw)) return []
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
  return raw
    .filter(p => p && Number.isFinite(p.time) && Number.isFinite(p.value))
    .map(p => ({ time: clamp(p.time, 0, 1), value: clamp(p.value, -1, 1) }))
    .sort((a, b) => a.time - b.time)
}

// The single sampler the graph draws through: Custom reads the breakpoints,
// every built-in reads its closed form. Signature matches
// BreakpointCurveEditor's `sample(points, adapter, phase)`.
export function makeVibratoSampler(shape) {
  if (shape === 'custom') {
    return (points, adapter, p) => evaluateLinearBreakpoints(points, adapter, p)
  }
  return (_points, _adapter, p) => evaluateBuiltinVibratoShape(shape, p)
}

export const VIBRATO_POINT_ADAPTER = TIME_VALUE_ADAPTER

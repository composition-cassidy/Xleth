// Motion view graph editor, the pure half (docs/XLETH_MOTION_VIEW_DESIGN.md R21, 5.4).
//
// The graph replaces the key rows in the same area, against the same time ruler.
// It plots the SELECTED property rows (a selected group or track row stands for
// every property row inside it): scalar rows with at least one key, at most
// MAX_GRAPH_CURVES. Each curve is auto-fitted to its OWN value range across the full
// plot height (multipliers on a log scale), so curves of different units share the
// area; the value axis is labelled for the FOCUSED property (the last clicked).
//
// Curves use the engine evaluator's rule (lensKeyModel.segmentEase: per-key interp,
// the LEAVING key's segment-owned bezier [x1, y1, x2, y2]), never a spline through
// the keys. A row's keys form RUNS that are evaluated separately:
//   timeline keys (Roam, Sweep, Mask)   one run across the whole timeline
//   clip Lens keys                      one run per clip, inside the clip (R22)
//   note keys                           per note: the hit curve (hollow) and the note's
//                                       own keys (filled), inside the note (R5)
// Pure: no canvas, no store. The painter is components/motionView/motionGraph.js.

import {
  noteCurveTime, noteTimeToCurveTime, segmentEase, sortNoteKeys, unitToValue, valueToUnit,
} from '../lensRoam/lensKeyModel.js'
import { isLayer, propertyById, rangeOf } from './schema.js'
import { propNodesUnder, rowKeys } from './rowRegistry.js'
import { spanOfRef, zonesOfRef } from './motionGestureModel.js'

export const MAX_GRAPH_CURVES = 8
/** Space above and below the plot, CSS px (a key at the range edge stays clickable). */
export const GRAPH_PAD_TOP = 16
export const GRAPH_PAD_BOTTOM = 16
/** Log ranges never span less than this factor; linear ones never less than a tenth of the schema range. */
const MIN_LOG_SPAN = 1.25
const FIT_PAD = 0.08

const fin = (v) => typeof v === 'number' && Number.isFinite(v)

/** Is a row a layer row (Sweep, a Pattern source's Lens)? Its keys hold layer values. */
export const isLayerRow = (row) => row?.provider?.id === 'sweep' || (row?.provider?.id === 'lens' && row?.target?.kind === 'source')

function rowOfNode(pn, trackId) {
  return { key: pn.key, kind: 'prop', prop: pn.prop, provider: pn.provider, target: pn.target, trackId, node: pn }
}

/**
 * The property rows the graph plots, in selection order then tree order: the
 * selected rows that are scalar and keyed, a selected group / track standing for
 * every row inside it. At most MAX_GRAPH_CURVES.
 */
export function graphRows(layout, data, selectedRows) {
  const out = []
  const seen = new Set()
  if (!layout || !data) return out
  for (const key of selectedRows ?? []) {
    const n = layout.nodes?.get(key)
    if (!n) continue
    for (const pn of propNodesUnder(n.node)) {
      if (seen.has(pn.key) || pn.prop?.type !== 'scalar') continue
      const row = rowOfNode(pn, n.trackId)
      if (rowKeys(row, data).length === 0) continue
      seen.add(pn.key)
      out.push(row)
      if (out.length >= MAX_GRAPH_CURVES) return out
    }
  }
  return out
}

// ── Runs ─────────────────────────────────────────────────────────────────────

const runCache = new WeakMap()   // instance list -> runs

/**
 * A row's keys split into runs (see the file header): [{ id, keys: inst[], start, end, hollow }].
 * start / end bound where the run plays (-Infinity / Infinity for timeline keys).
 */
export function curveRuns(row, data) {
  const list = rowKeys(row, data)
  const hit = runCache.get(list)
  if (hit) return hit
  const runs = new Map()
  for (const k of list) {
    const ref = k.ref
    let id = 'all'
    let start = -Infinity
    let end = Infinity
    if (ref.kind === 'clipLens') {
      id = `c${ref.clipId}`
      start = k.tick - ref.pos
      const clip = (data.clipsByTrack?.get(ref.trackId) ?? []).find((c) => c.id === ref.clipId)
      end = clip ? clip.positionTicks + clip.durationTicks : Infinity
    } else if (ref.kind === 'hit' || ref.kind === 'note') {
      id = `${k.hollow ? 'h' : 'n'}${ref.noteStart}:${ref.patternId}:${ref.noteId}`
      start = ref.noteStart
      end = ref.noteEnd
    }
    let r = runs.get(id)
    if (!r) {
      r = { id, keys: [], start, end, hollow: !!k.hollow }
      if (ref.kind === 'hit' || ref.kind === 'note') {
        // A note run plays on the note's CURVE time axis (lensKeyModel.valueAtNote).
        r.note = true
        r.zones = zonesOfRef(data, ref)
        r.span = spanOfRef(data, ref)
      }
      runs.set(id, r)
    }
    r.keys.push(k)
  }
  const out = [...runs.values()]
  for (const r of out) if (r.note) r.keys = noteRunOrder(r)
  runCache.set(list, out)
  return out
}

// ── Note runs: the engine's canonical order on CURVE time ─────────────────────
//
// A note run is evaluated like lensKeyModel.valueAtNote: keys in the canonical order
// (Head asc, Body asc, Tail desc; sortNoteKeys), each at its CURVE time, and a tick
// maps to curve time through noteTimeToCurveTime. That differs from drawn note time
// under Cut (a short note skips the middle of the curve), where drawn order can even
// be reversed (a Tail key drawn before a Head key).

const refPos = (k) => k.ref.pos

/** A note run's keys in canonical order; posOf reads a key's pos (a gesture draft's, say). */
export function noteRunOrder(run, keys = run.keys, posOf = refPos) {
  return sortNoteKeys(keys.map((k) => ({ anchor: k.ref.anchor, pos: posOf(k), inst: k })), run.zones).map((e) => e.inst)
}

/** A note run key's curve time. */
export const noteRunTime = (run, k, posOf = refPos) => noteCurveTime(run.span, k.ref.anchor, posOf(k))

/** The curve time a tick plays in a note run. */
export const noteRunTimeAt = (run, tick) => noteTimeToCurveTime(run.span, tick - run.start)

/**
 * Does playback ever pass through the segment between curve times ca and cb (cb >= ca)
 * of a note run? Always, except under Cut, where the curve between the note's
 * tail-start and the Tail zone is skipped.
 */
export function noteSegmentReached(run, ca, cb) {
  const s = run.span
  if (!s?.cut) return true
  const skipLo = s.tailStart                              // curve time the note leaves at tail-start
  const skipHi = s.curveEnd - (s.noteLen - s.tailStart)   // and where it lands
  return ca < skipLo || cb > skipHi
}

/**
 * How a run is evaluated, read through a draft: { keys, times, at(tick) }. Timeline /
 * clip runs: tick order, time = tick. Note runs: canonical order on curve time.
 *   rd = { tickOf, posOf }  (posOf only matters for note runs)
 */
export function runTimeline(run, keys, rd = {}) {
  const tickOf = rd.tickOf ?? ((k) => k.tick)
  if (!run.note) return { keys, times: keys.map(tickOf), at: (tick) => tick }
  const posOf = rd.posOf ?? refPos
  return { keys, times: keys.map((k) => noteRunTime(run, k, posOf)), at: (tick) => noteRunTimeAt(run, tick) }
}

/**
 * The value of a run at `tick`, evaluated like the engine (note runs on curve time).
 * rd = draftReaders-like { tickOf, valueOf, easeOf, posOf } (all optional).
 */
export function runValueAtTick(run, tick, rd = {}) {
  // Own properties only: a plain {} inherits Object.prototype.valueOf.
  const valueOf = Object.hasOwn(rd, 'valueOf') ? rd.valueOf : (k) => k.value
  const easeOf = rd.easeOf ?? ((k) => k)
  const { keys, times, at } = runTimeline(run, run.keys, rd)
  return runValueAt(keys.map((k, i) => ({ i, k })), at(tick), (e) => times[e.i], (e) => valueOf(e.k), (e) => easeOf(e.k))
}

/**
 * The value of a run's curve at `tick` (held before the first key and after the last).
 * tickOf / valueOf / easeOf read a key through a gesture's draft (easeOf: the object
 * whose interp / bez shape the segment leaving it).
 */
export function runValueAt(keys, tick, tickOf = (k) => k.tick, valueOf = (k) => k.value, easeOf = (k) => k) {
  const n = keys.length
  if (n === 0) return null
  if (!(tick >= tickOf(keys[0]))) return valueOf(keys[0])
  let i = 1
  while (i < n && tickOf(keys[i]) <= tick) i++
  if (i >= n) return valueOf(keys[n - 1])
  const a = keys[i - 1]
  const b = keys[i]
  const ta = tickOf(a)
  const tb = tickOf(b)
  const va = valueOf(a)
  if (easeOf(a).interp === 'Hold' || !(tb > ta)) return va
  const u = (tick - ta) / (tb - ta)
  return va + (valueOf(b) - va) * segmentEase(easeOf(a), u)
}

// ── Ranges ───────────────────────────────────────────────────────────────────

/**
 * The value range of one curve: every key's value and the overshoot of its Bezier
 * segments, padded; a log range for multipliers. Returns { min, max, log }.
 */
export function fitGraphRange(prop, values, { layer = false } = {}) {
  const p = typeof prop === 'string' ? propertyById(prop) : prop
  const log = !!p?.log
  const vs = values.filter((v) => fin(v) && (!log || v > 0))
  const identity = layer ? (p?.blend === 'multiply' || log ? 1 : 0) : p?.identity ?? 0
  if (vs.length === 0) vs.push(log ? Math.max(identity, 1e-3) : identity)
  // A loop, not Math.min(...vs): a long Pattern track gives well over 100k values and a
  // spread that size overflows the call stack.
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (log) {
    let a = Math.log(lo)
    let b = Math.log(hi)
    const minSpan = Math.log(MIN_LOG_SPAN)
    if (b - a < minSpan) { const m = (a + b) / 2; a = m - minSpan / 2; b = m + minSpan / 2 }
    const pad = (b - a) * FIT_PAD
    return { min: Math.exp(a - pad), max: Math.exp(b + pad), log: true }
  }
  const sr = rangeOf(p, { layer })
  const floor = sr ? (sr[1] - sr[0]) / 10 : 0.1
  if (hi - lo < floor) { const m = (lo + hi) / 2; lo = m - floor / 2; hi = m + floor / 2 }
  const pad = (hi - lo) * FIT_PAD
  return { min: lo - pad, max: hi + pad, log: false }
}

/**
 * Every value a row's curve reaches: its keys and the extremes of its Bezier segments
 * (note runs in the engine's curve order). Every hollow run holds the same hit-curve
 * keys, so only the first one is read.
 */
export function curveValues(row, data) {
  const out = []
  let hollowDone = false
  for (const run of curveRuns(row, data)) {
    if (run.hollow) {
      if (hollowDone) continue
      hollowDone = true
    }
    const ks = run.keys
    for (let i = 0; i < ks.length; i++) {
      out.push(ks[i].value)
      if (ks[i].interp === 'Bezier' && i + 1 < ks.length) {
        const a = ks[i]
        const b = ks[i + 1]
        for (let s = 1; s < 16; s++) {
          out.push(a.value + (b.value - a.value) * segmentEase(a, s / 16))
        }
      }
    }
  }
  return out
}

// ── Value <-> y ──────────────────────────────────────────────────────────────

/** The plot band of a graph `height` px tall: { top, bottom }. */
export const plotBand = (height) => ({ top: GRAPH_PAD_TOP, bottom: Math.max(GRAPH_PAD_TOP + 1, height - GRAPH_PAD_BOTTOM) })

/** value -> y (CSS px from the top of the graph) in a range, over the plot band. */
export function valueToGraphY(range, band, v) {
  return band.bottom - valueToUnit(range, v) * (band.bottom - band.top)
}

/** y -> value (unclamped) in a range, over the plot band. */
export function graphYToValue(range, band, y) {
  return unitToValue(range, (band.bottom - y) / (band.bottom - band.top))
}

/**
 * The curves of the graph: one per graphRows row, its range fitted to its values.
 *   [{ row, prop, trackId, layer, range, runs }]
 */
export function buildGraphCurves(layout, data, selectedRows) {
  return graphRows(layout, data, selectedRows).map((row) => {
    const layer = isLayerRow(row)
    return {
      row,
      rowKey: row.key,
      prop: row.prop,
      trackId: row.trackId,
      layer,
      range: fitGraphRange(row.prop, curveValues(row, data), { layer }),
      runs: curveRuns(row, data),
    }
  })
}

/** The value-axis labels of a curve: `count` evenly spaced values, top to bottom. */
export function axisValues(range, count = 5) {
  const out = []
  for (let i = 0; i < count; i++) out.push(unitToValue(range, 1 - i / (count - 1)))
  return out
}

/** Is a property rendered as a layer in this row (formatValue's `layer` flag)? */
export const formatAsLayer = (curve) => curve.layer && isLayer(curve.prop)

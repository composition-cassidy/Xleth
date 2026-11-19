// Motion view graph editor, pure half (docs/XLETH_MOTION_VIEW_DESIGN.md R21): which
// rows plot, runs, per-curve fitted ranges (log for multipliers), value <-> y.
import { describe, expect, it } from 'vitest'
import {
  GRAPH_PAD_BOTTOM, GRAPH_PAD_TOP, MAX_GRAPH_CURVES, axisValues, buildGraphCurves, curveRuns, curveValues, fitGraphRange,
  graphRows, graphYToValue, isLayerRow, noteSegmentReached, plotBand, runValueAt, runValueAtTick, valueToGraphY,
} from './motionGraphModel.js'
import { noteSpan, sortNoteKeys, valueAtNote } from '../lensRoam/lensKeyModel.js'
import { buildMotionRows } from './rowRegistry.js'
import { propertyById } from './schema.js'
import { fixtureData, fixtureLensRoam, fixturePatterns, fixtureTracks } from './providers/__tests__/fixtures.js'

const data = fixtureData()
const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(), trackRowHeight: 28 })

describe('which rows plot', () => {
  it('selected scalar rows with keys; a group stands for its rows; unkeyed rows are left out', () => {
    expect(graphRows(layout, data, new Set(['t:1/roam/roam.offsetX', 't:1/roam/roam.scale'])).map((r) => r.key))
      .toEqual(['t:1/roam/roam.offsetX'])
    expect(graphRows(layout, data, new Set(['t:1/roam'])).map((r) => r.key))
      .toEqual(['t:1/roam/roam.offsetX', 't:1/mask:1/mask.feather'])
  })

  it('a whole track: every keyed row, at most 8', () => {
    const keys = graphRows(layout, data, new Set(['t:1'])).map((r) => r.key)
    expect(keys).toEqual(['t:1/lens/sourceLens.zoom', 't:1/roam/roam.offsetX', 't:1/mask:1/mask.feather', 't:1/sweep/sweep.zoom'])
    expect(MAX_GRAPH_CURVES).toBe(8)
    expect(graphRows(layout, data, new Set())).toEqual([])
  })

  it('layer rows: Sweep and a Pattern source\'s Lens', () => {
    const rows = graphRows(layout, data, new Set(['t:1']))
    expect(rows.map(isLayerRow)).toEqual([true, false, false, true])
  })
})

describe('runs', () => {
  it('timeline keys: one run; note keys: per note, hit curve (hollow) apart from own keys', () => {
    const [lens, roam] = graphRows(layout, data, new Set(['t:1']))
    expect(curveRuns(roam, data).map((r) => [r.id, r.keys.length])).toEqual([['all', 2]])
    const runs = curveRuns(lens, data).map((r) => [r.hollow, r.start, r.end, r.keys.length])
    expect(runs).toEqual([
      [true, 0, 960, 2],
      [true, 1920, 2880, 2],
      [false, 1920, 2880, 1],
    ])
  })

  it('clip keys: one run per clip, inside the clip', () => {
    const rows = graphRows(layout, data, new Set(['t:2']))
    const runs = curveRuns(rows[0], data)
    expect(runs.map((r) => [r.id, r.start, r.end])).toEqual([['c30', 0, 3840]])
  })

  it('a run evaluates like the engine: held outside, interp of the leaving key', () => {
    const keys = [
      { tick: 0, value: 0, interp: 'Linear' },
      { tick: 100, value: 10, interp: 'Hold' },
      { tick: 200, value: 20, interp: 'EaseOut' },
      { tick: 300, value: 30, interp: 'Linear' },
    ]
    expect(runValueAt(keys, -50)).toBe(0)
    expect(runValueAt(keys, 50)).toBe(5)
    expect(runValueAt(keys, 150)).toBe(10)
    expect(runValueAt(keys, 250)).toBeCloseTo(20 + 10 * 0.75, 9)
    expect(runValueAt(keys, 400)).toBe(30)
  })
})

describe('ranges and value <-> y', () => {
  it('a log range for multipliers, padded, never narrower than x1.25', () => {
    const scale = propertyById('roam.scale')
    const r = fitGraphRange(scale, [0.5, 2])
    expect(r.log).toBe(true)
    expect(r.min).toBeLessThan(0.5)
    expect(r.max).toBeGreaterThan(2)
    expect(Math.log(r.max) - Math.log(2)).toBeCloseTo(Math.log(0.5) - Math.log(r.min), 9)   // symmetric padding
    const flat = fitGraphRange(scale, [1, 1])
    expect(flat.max / flat.min).toBeGreaterThan(1.25)
    expect(Math.sqrt(flat.max * flat.min)).toBeCloseTo(1, 9)
  })

  it('a linear range never narrower than a tenth of the schema range', () => {
    const r = fitGraphRange(propertyById('roam.offsetX'), [0, 1])
    expect(r.log).toBe(false)
    // [0, 1] is under 1.6 (a tenth of -8..8): widened to 1.6 around 0.5, then 8 % padding.
    expect(r.min).toBeCloseTo(0.5 - 0.8 - 1.6 * 0.08, 9)
    expect(r.max).toBeCloseTo(0.5 + 0.8 + 1.6 * 0.08, 9)
  })

  it('value -> y -> value round trips, linear and log; the band leaves room top and bottom', () => {
    const band = plotBand(400)
    expect(band).toEqual({ top: GRAPH_PAD_TOP, bottom: 400 - GRAPH_PAD_BOTTOM })
    const lin = { min: -1, max: 1, log: false }
    expect(valueToGraphY(lin, band, 1)).toBe(band.top)
    expect(valueToGraphY(lin, band, -1)).toBe(band.bottom)
    expect(valueToGraphY(lin, band, 0)).toBe((band.top + band.bottom) / 2)
    expect(graphYToValue(lin, band, valueToGraphY(lin, band, 0.37))).toBeCloseTo(0.37, 12)
    const log = { min: 0.5, max: 2, log: true }
    // 1 is the geometric middle of 0.5..2: the middle of the band.
    expect(valueToGraphY(log, band, 1)).toBeCloseTo((band.top + band.bottom) / 2, 9)
    expect(graphYToValue(log, band, valueToGraphY(log, band, 1.7))).toBeCloseTo(1.7, 12)
  })

  it('axis labels: evenly spaced in the curve\'s own scale, top to bottom', () => {
    expect(axisValues({ min: 0, max: 1, log: false })).toEqual([1, 0.75, 0.5, 0.25, 0])
    const log = axisValues({ min: 0.5, max: 2, log: true }, 3)
    expect(log[0]).toBeCloseTo(2, 9)
    expect(log[1]).toBeCloseTo(1, 9)
    expect(log[2]).toBeCloseTo(0.5, 9)
  })

  it('every curve is fitted to its own values (a Bezier overshoot included)', () => {
    const curves = buildGraphCurves(layout, data, new Set(['t:1']))
    const roam = curves.find((c) => c.rowKey === 't:1/roam/roam.offsetX')
    expect(roam.range.min).toBeLessThan(0)
    expect(roam.range.max).toBeGreaterThan(1)
    const zoom = curves.find((c) => c.rowKey === 't:1/lens/sourceLens.zoom')
    expect(zoom.range.log).toBe(true)
    expect(zoom.layer).toBe(true)
  })
})

// ── Review fixes: huge Pattern tracks, note runs in the engine's curve order ─────

const KEY = (channel, pos, value, interp = 'Linear', anchor = 'Origin') => ({ channel, anchor, pos, value, interp })
const CUT = { headTicks: 120, tailTicks: 240, shortNote: 'Cut' }

function lensData({ hitCurve, zones = CUT, notes }) {
  const lr = fixtureLensRoam()
  lr.sources[0].hitCurve = hitCurve
  lr.sources[0].zones = zones
  const patterns = fixturePatterns()
  if (notes) patterns[10].notes = notes
  const d = fixtureData({ lensRoam: lr, patterns })
  const l = buildMotionRows({ tracks: fixtureTracks(), data: d, expanded: new Set(), trackRowHeight: 28 })
  const [row] = graphRows(l, d, new Set(['t:1/lens/sourceLens.zoom']))
  return { data: d, layout: l, row }
}

describe('large tracks', () => {
  it('the range fit takes 200k values (no spread into Math.min / Math.max)', () => {
    const vs = Array.from({ length: 200000 }, (_, i) => (i % 1000) / 1000)
    const r = fitGraphRange(propertyById('roam.offsetX'), vs)
    expect(r.min).toBeLessThan(0)
    expect(r.max).toBeGreaterThan(0.999)
  })

  it('a hit curve under thousands of notes: its values are read once, the graph builds', () => {
    const notes = Array.from({ length: 2600 }, (_, i) => ({ id: i + 1, positionTicks: i, durationTicks: 1, pitch: 60 }))
    const bez = [0.42, 0, 0.58, 1]
    const { data: d, layout: l, row } = lensData({
      zones: { headTicks: 120, tailTicks: 240, shortNote: 'Squash' },
      notes,
      hitCurve: [0, 40, 80, 120].map((p, i) => ({ ...KEY('zoom', p, 1 + i * 0.1, 'Bezier', 'Head'), bez })),
    })
    expect(curveRuns(row, d).length).toBe(2600)
    expect(curveValues(row, d).length).toBe(4 + 3 * 15)
    const [curve] = buildGraphCurves(l, d, new Set(['t:1/lens/sourceLens.zoom']))
    expect(curve.range.log).toBe(true)
    expect(Number.isFinite(curve.range.min) && Number.isFinite(curve.range.max)).toBe(true)
  })
})

describe('note runs evaluate on curve time (Cut)', () => {
  it('a 200-tick Cut note starts part-way through Head 0 -> Tail 0, as the engine plays it', () => {
    const hit = [KEY('zoom', 0, 2, 'Linear', 'Head'), KEY('zoom', 0, 1, 'Linear', 'Tail')]
    const { data: d, row } = lensData({ hitCurve: hit, notes: [{ id: 1, positionTicks: 0, durationTicks: 200, pitch: 60 }] })
    const [run] = curveRuns(row, d)
    const span = noteSpan(200, CUT)
    for (const t of [0, 50, 199, 200]) {
      expect(runValueAtTick(run, t)).toBeCloseTo(valueAtNote(sortNoteKeys(hit, CUT), span, t, 1), 9)
    }
    expect(runValueAtTick(run, 0)).toBeLessThan(2)       // not the Head key's value: the note skips curve 0..160
  })

  it('keys in canonical order (Head before Tail) even when a Cut note draws the Tail first', () => {
    const hit = [KEY('zoom', 100, 2, 'Linear', 'Head'), KEY('zoom', 200, 1, 'Linear', 'Tail')]
    const { data: d, row } = lensData({ hitCurve: hit, notes: [{ id: 1, positionTicks: 0, durationTicks: 200, pitch: 60 }] })
    const [run] = curveRuns(row, d)
    expect(run.keys.map((k) => [k.ref.anchor, k.tick])).toEqual([['Head', 100], ['Tail', 0]])
    // Curve 100 -> 160 is skipped by this note (it plays curve 160..360): never reached.
    expect(noteSegmentReached(run, 100, 160)).toBe(false)
    expect(noteSegmentReached(run, 100, 200)).toBe(true)
  })
})

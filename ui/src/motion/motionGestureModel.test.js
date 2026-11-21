// Motion view key editing, pure half (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4, R3, R5,
// R22): marquee hit sets, position domains, the exact writes of moves, deletes,
// interp changes and "Nudge this note".
import { describe, expect, it } from 'vitest'
import {
  addKeyAtPlan, buildKeyIndex, clampMoveDelta, deleteKeysPlan, interpPlan, isNoteRef, keyIdAfter, keysInRect,
  moveSelection, movePlan, nudgeNotePlan, nudgeSelection, planKeyEdits, posAtTick, selectionAfterMove,
  summaryKeysAt, tickOfPos, nudgeNoteMove, nudgeNotePos,
} from './motionGestureModel.js'
import { buildMotionRows } from './rowRegistry.js'
import { snapNotePos } from './motionSnap.js'
import { BEZIER_PRESETS } from '../lensRoam/lensKeyModel.js'
import { fixtureData, fixtureLensRoam, fixturePatterns, fixtureTracks } from './providers/__tests__/fixtures.js'

const PPB = 40   // px per beat: tick 960 = 40 px
const xToTick = (x) => (x / PPB) * 960
const ALL_OPEN = ['t:1', 't:1/lens', 't:1/roam', 't:1/roam/masks', 't:1/mask:1', 't:1/sweep', 't:2', 't:2/lens', 't:2/roam']

function setup(over) {
  const data = fixtureData(over)
  const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(ALL_OPEN), trackRowHeight: 28 })
  const index = buildKeyIndex(layout, data)
  const inst = (id) => {
    const e = index.byId.get(id)
    if (!e) throw new Error(`no key ${id}; have ${[...index.byId.keys()].join(' ')}`)
    return e.inst
  }
  return { data, layout, index, inst }
}

const K = (channel, pos, value, interp = 'Linear', anchor = 'Origin') => ({ channel, anchor, pos, value, interp })

describe('key index', () => {
  it('holds every key of every track (open or not), and one hit key under every note as ONE target', () => {
    const { index } = setup()
    expect(index.byId.has('r:1:offsetX:0')).toBe(true)
    expect(index.byId.has('c:30:zoom:1920')).toBe(true)
    expect(index.byId.has('m:1:1:feather:3840')).toBe(true)
    const hit = index.byTarget.get('hit:1:100:zoom:Head:0')
    expect(hit.map((k) => k.tick)).toEqual([0, 1920])      // under note 1 and note 2
    expect(hit.every((k) => k.hollow)).toBe(true)
  })
})

describe('marquee and summary keys', () => {
  it('selects across rows and tracks: property rows by x range, collapsed rows through their summary', () => {
    const data = fixtureData()
    const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(['t:1', 't:1/roam']), trackRowHeight: 28 })
    const ox = layout.byKey.get('t:1/roam/roam.offsetX')
    const lens = layout.byKey.get('t:1/lens')
    // x -5..10 (ticks -120..240) from the collapsed Lens group down to Offset X.
    const ids = keysInRect(layout, data, { x0: -5, y0: lens.y + 2, x1: 10, y1: ox.y + 10 }, xToTick).map((k) => k.id)
    expect(ids).toContain('r:1:offsetX:0')
    expect(ids).toContain('h:1:100:zoom:Head:0@0')
    expect(ids).toContain('h:1:100:zoom:Head:120@0')
    expect(ids).not.toContain('r:1:offsetX:3840')
    expect(ids).not.toContain('h:1:100:zoom:Head:0@1920')
    // A rectangle below every row selects nothing.
    expect(keysInRect(layout, data, { x0: 0, y0: 99999, x1: 999, y1: 99999 + 5 }, xToTick)).toEqual([])
  })

  it('a summary key stands for every key of its rows at that tick', () => {
    const data = fixtureData()
    const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(), trackRowHeight: 28 })
    const ids = summaryKeysAt(layout.byKey.get('t:1'), data, 0).map((k) => k.id).sort()
    expect(ids).toEqual(['h:1:100:zoom:Head:0@0', 'm:1:1:feather:0', 'r:1:offsetX:0'])
  })
})

describe('position domains', () => {
  const { data, inst } = setup()

  it('timeline keys: pos = tick; clip keys: pos = tick - clip start', () => {
    const r = inst('r:1:offsetX:3840')
    expect(posAtTick(data, r, 4000.4)).toBe(4000)
    expect(posAtTick(data, r, -30)).toBe(0)
    const c = inst('c:30:zoom:1920')
    expect(posAtTick(data, c, 2000)).toBe(2000)
    expect(tickOfPos(data, c, 100)).toBe(100)
  })

  it('note keys keep their anchor; pos is the place inside the zone of THEIR note', () => {
    const h = inst('h:1:100:zoom:Head:0@1920')
    expect(isNoteRef(h.ref)).toBe(true)
    expect(posAtTick(data, h, 1920 + 60)).toBe(60)
    expect(posAtTick(data, h, 1920 + 500)).toBe(120)          // clamped to the Head zone
    expect(tickOfPos(data, h, 60)).toBe(1980)
    const step = (span, anchor, t) => snapNotePos(span, anchor, t, { step: 120 })
    expect(posAtTick(data, h, 1920 + 50, { snapNote: step })).toBe(0)
  })

  it('a group move stops where the first timeline key would go below 0', () => {
    const { inst: i } = setup()
    expect(clampMoveDelta([i('r:1:offsetX:0'), i('r:1:offsetX:3840')], -500)).toBe(0)
    expect(clampMoveDelta([i('c:30:zoom:1920')], -5000)).toBe(-1920)
  })
})

describe('moves: exact writes', () => {
  it('a Roam key moved 480 ticks: ONE roamKeys write with the whole list', () => {
    const { data, index, inst } = setup()
    const k = inst('r:1:offsetX:0')
    const moved = moveSelection(data, index, [k], 480)
    expect(moved.keyTicks.get('r:1:offsetX:0')).toBe(480)
    expect(movePlan(data, moved)).toEqual([
      { kind: 'roamKeys', trackId: 1, keys: [K('offsetX', 480, 0), K('offsetX', 3840, 1)] },
    ])
  })

  it('a moved key replaces a key already at its new place', () => {
    const { data, index, inst } = setup()
    const plan = movePlan(data, moveSelection(data, index, [inst('r:1:offsetX:0')], 3840))
    expect(plan[0].keys).toEqual([K('offsetX', 3840, 0)])
  })

  it('across tracks and kinds: one write per touched list (Roam, clip Lens, Mask, Sweep)', () => {
    const { data, index, inst } = setup()
    const sel = ['r:1:offsetX:0', 'c:30:zoom:0', 'm:1:1:feather:0', 's:1:zoom:960'].map(inst)
    const plan = movePlan(data, moveSelection(data, index, sel, 240))
    expect(plan.map((w) => w.kind)).toEqual(['roamKeys', 'clipLensKeys', 'sweepKeys', 'masks'])
    expect(plan[1]).toEqual({ kind: 'clipLensKeys', clipId: 30, keys: [K('zoom', 240, 1), K('zoom', 1920, 2)] })
    expect(plan[2]).toEqual({ kind: 'sweepKeys', trackId: 1, keys: [K('zoom', 1200, 1.5)] })
    const mask = plan[3].masks[0]
    expect(plan[3].trackId).toBe(1)
    expect(mask.keys.map((k) => [k.pos, k.value])).toEqual([[240, 0], [3840, 0.2]])
  })

  it('a hit key drawn under two notes moves ONCE; the draft moves it under every note', () => {
    const { data, index, inst } = setup()
    const a = inst('h:1:100:zoom:Head:0@0')
    const b = inst('h:1:100:zoom:Head:0@1920')
    const moved = moveSelection(data, index, [a, b], 60, { primary: b })
    expect(moved.edits).toHaveLength(1)
    expect(moved.keyTicks.get(a.id)).toBe(60)
    expect(moved.keyTicks.get(b.id)).toBe(1980)
    const plan = movePlan(data, moved)
    expect(plan).toEqual([{
      kind: 'hitCurve', trackId: 1, regionId: 100,
      curve: { keys: [K('zoom', 60, 1.35, 'EaseOut', 'Head'), K('zoom', 120, 1, 'Linear', 'Head')] },
    }])
  })

  it("a note's own key moves inside its note (setNotesLensKeys entry)", () => {
    const { data, index, inst } = setup()
    const n = inst('n:10:2:zoom:Head:0@1920')
    const plan = movePlan(data, moveSelection(data, index, [n], 100))
    expect(plan).toEqual([{ kind: 'notesLensKeys', entries: [{ patternId: 10, noteId: 2, keys: [K('zoom', 100, 1.2, 'Linear', 'Head')] }] }])
  })

  it('mask shape keys move in time only', () => {
    const lr = fixtureLensRoam()
    const shape = lr.tracks[0].masks[0].base.shape
    lr.tracks[0].masks[0].shapeKeys = [{ pos: 0, interp: 'Linear', vertices: shape.vertices }, { pos: 1920, interp: 'Hold', vertices: shape.vertices }]
    const { data, index, inst } = setup({ lensRoam: lr })
    const plan = movePlan(data, moveSelection(data, index, [inst('ms:1:1:1920')], 960))
    expect(plan).toHaveLength(1)
    expect(plan[0].masks[0].shapeKeys.map((k) => [k.pos, k.interp])).toEqual([[0, 'Linear'], [2880, 'Hold']])
  })

  it('a graph drag also writes values (clamped to the schema)', () => {
    const { data, index, inst } = setup()
    const moved = moveSelection(data, index, [inst('m:1:1:feather:3840')], 0, { newValue: () => 1.7 })
    expect(moved.keyValues.get('m:1:1:feather:3840')).toBe(1)          // feather clamps to [0, 1]
    expect(movePlan(data, moved)[0].masks[0].keys.find((k) => k.pos === 3840).value).toBe(1)
  })

  it('nudge: one step; the selection follows its keys to their new ids', () => {
    const { data, index, inst } = setup()
    const sel = [inst('r:1:offsetX:3840'), inst('c:30:zoom:1920')]
    const r = nudgeSelection(data, index, sel, -240)
    expect(movePlan(data, r).map((w) => w.keys.map((k) => k.pos))).toEqual([[0, 3600], [0, 1680]])
    expect(selectionAfterMove(sel, r.edits).map(([id]) => id)).toEqual(['r:1:offsetX:3600', 'c:30:zoom:1680'])
    expect(keyIdAfter(inst('h:1:100:zoom:Head:0@1920'), 60)[0]).toBe('h:1:100:zoom:Head:60@1920')
  })
})

describe('delete and interp', () => {
  it('deleting the last keys of a Roam channel sets the base to the value at the playhead (R3)', () => {
    const { data, inst } = setup()
    const plan = deleteKeysPlan(data, [inst('r:1:offsetX:0'), inst('r:1:offsetX:3840')], { foldTick: 1920 })
    expect(plan).toEqual([
      { kind: 'roamBase', trackId: 1, params: { offsetX: 0.5 } },
      { kind: 'roamKeys', trackId: 1, keys: [] },
    ])
  })

  it('a layer (Sweep) just loses its key; a partial delete keeps the base', () => {
    const { data, inst } = setup()
    expect(deleteKeysPlan(data, [inst('s:1:zoom:960')], { foldTick: 0 })).toEqual([{ kind: 'sweepKeys', trackId: 1, keys: [] }])
    expect(deleteKeysPlan(data, [inst('c:30:zoom:0')], { foldTick: 0 })).toEqual([{ kind: 'clipLensKeys', clipId: 30, keys: [K('zoom', 1920, 2)] }])
  })

  it('mask keys: the last feather keys going fold their value into the mask base', () => {
    const { data, inst } = setup()
    const plan = deleteKeysPlan(data, [inst('m:1:1:feather:0'), inst('m:1:1:feather:3840')], { foldTick: 1920 })
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe('masks')
    expect(plan[0].masks[0].keys).toEqual([])
    expect(plan[0].masks[0].base.feather).toBeCloseTo(0.1, 9)
  })

  it('interp: every selected key, Bezier with the preset handles', () => {
    const { data, inst } = setup()
    const over = BEZIER_PRESETS.find((p) => p.id === 'overshoot')
    const plan = interpPlan(data, [inst('r:1:offsetX:0'), inst('h:1:100:zoom:Head:120@0')], 'Bezier', over.bez)
    expect(plan[0].keys[0]).toEqual({ ...K('offsetX', 0, 0, 'Bezier'), bez: over.bez })
    expect(plan[1].curve.keys[1]).toEqual({ ...K('zoom', 120, 1, 'Bezier', 'Head'), bez: over.bez })
    const hold = interpPlan(data, [inst('r:1:offsetX:0')], 'Hold')
    expect(hold[0].keys[0]).toEqual(K('offsetX', 0, 0, 'Hold'))
  })

  it('a stale key (not in the list any more) writes nothing', () => {
    const { data } = setup()
    expect(planKeyEdits(data, [{ ref: { kind: 'roam', trackId: 1, channel: 'offsetX', pos: 77 }, key: K('offsetX', 77, 9), remove: true }]))
      .toEqual([{ kind: 'roamKeys', trackId: 1, keys: [K('offsetX', 0, 0), K('offsetX', 3840, 1)] }])
  })
})

describe('Nudge this note (R5)', () => {
  it('at the hollow key itself: an identity layer key on that note only', () => {
    const { data, inst } = setup()
    const plan = nudgeNotePlan(data, inst('h:1:100:zoom:Head:0@0'))
    expect(plan).toEqual([{ kind: 'notesLensKeys', entries: [{ patternId: 10, noteId: 1, keys: [K('zoom', 0, 1, 'EaseOut', 'Head')] }] }])
  })

  it('moved: layer = desired / hit at the new place (zoom multiplies)', () => {
    const { data, inst } = setup()
    // The hit curve at Head 60: 1.35 + (1 - 1.35) * easeOut(0.5) = 1.0875.
    const plan = nudgeNotePlan(data, inst('h:1:100:zoom:Head:0@0'), { tick: 60 })
    const key = plan[0].entries[0].keys[0]
    expect(key.pos).toBe(60)
    expect(key.value).toBeCloseTo(1.35 / 1.0875, 9)
  })

  it('an explicit desired value; a Nudge note keeps its other keys', () => {
    const { data, inst } = setup()
    const plan = nudgeNotePlan(data, inst('h:1:100:zoom:Head:120@1920'), { desired: 2 })
    const keys = plan[0].entries[0].keys
    expect(plan[0].entries[0].noteId).toBe(2)
    expect(keys).toEqual([K('zoom', 0, 1.2, 'Linear', 'Head'), K('zoom', 120, 2, 'Linear', 'Head')])
  })

  it('only hollow hit keys take it', () => {
    const { data, inst } = setup()
    expect(nudgeNotePlan(data, inst('r:1:offsetX:0'))).toEqual([])
  })
})

describe('double-click add', () => {
  it('a key at the tick with the curve value on an animated row; nothing on a static one', () => {
    const { data, layout } = setup()
    const plan = addKeyAtPlan(layout.byKey.get('t:1/roam/roam.offsetX'), data, 1920)
    expect(plan[0].keys.find((k) => k.pos === 1920)).toEqual(K('offsetX', 1920, 0.5))
    expect(addKeyAtPlan(layout.byKey.get('t:1/roam/roam.offsetY'), data, 1920)).toBeNull()
    expect(addKeyAtPlan(layout.byKey.get('t:1/roam/roam.bounds'), data, 1920)).toBeNull()
  })
})

// ── Review fixes: short / Cut notes, group moves that would merge, marquee cost ──

function hitSetup({ hitCurve, zones = { headTicks: 120, tailTicks: 240, shortNote: 'Squash' }, extraNotes = [] }) {
  const lr = fixtureLensRoam()
  lr.sources[0].hitCurve = hitCurve
  lr.sources[0].zones = zones
  const patterns = fixturePatterns()
  patterns[10].notes.push(...extraNotes)
  return setup({ lensRoam: lr, patterns })
}

describe('hit keys moved from under a short note', () => {
  it('Squash: a Body key under a note with no Body is measured in a long note, never collapsed to 0', () => {
    const { data, index, inst } = hitSetup({
      hitCurve: [K('zoom', 0.5, 1.5, 'Linear', 'Body')],
      extraNotes: [{ id: 3, positionTicks: 3000, durationTicks: 240, pitch: 64 }],
    })
    const short = inst('h:1:100:zoom:Body:0.5@3000')
    // Unmoved: the exact pos, not a round trip through the empty zone.
    expect(moveSelection(data, index, [short], 0, { primary: short }).edits[0].pos).toBe(0.5)
    // Right one 1/16 step: in a 960-tick note the Body is 120..720, so +240 ticks = +0.4.
    const r = nudgeSelection(data, index, [short], 240)
    expect(r.edits[0].pos).toBeCloseTo(0.9, 9)
    expect(movePlan(data, r)[0].curve.keys).toEqual([K('zoom', 0.9, 1.5, 'Linear', 'Body')])
    const one = moveSelection(data, index, [short], 1, { primary: short }).edits[0].pos
    expect(one).toBeGreaterThan(0.5)
    expect(one).toBeLessThan(0.51)
  })

  it("Cut: a Head key the short note clips moves in its full zone, not to that note's tail-start", () => {
    const { data, index, inst } = hitSetup({
      hitCurve: [K('zoom', 100, 1.5, 'Linear', 'Head')],
      zones: { headTicks: 120, tailTicks: 240, shortNote: 'Cut' },
      extraNotes: [{ id: 3, positionTicks: 3000, durationTicks: 300, pitch: 64 }],
    })
    const cut = inst('h:1:100:zoom:Head:100@3000')
    expect(cut.outside).toBe(true)                      // tail-start is 60 in a 300-tick Cut note
    const r = moveSelection(data, index, [cut], 1, { primary: cut })
    expect(r.edits[0].pos).toBe(101)
    expect(movePlan(data, r)[0].curve.keys).toEqual([K('zoom', 101, 1.5, 'Linear', 'Head')])
  })

  it('a Nudge key placed from a chord note is measured in THAT note', () => {
    const { data, index } = hitSetup({
      hitCurve: [K('zoom', 0, 1, 'Linear', 'Tail')],
      extraNotes: [{ id: 3, positionTicks: 0, durationTicks: 480, pitch: 64 }],
    })
    const under3 = index.byTarget.get('hit:1:100:zoom:Tail:0').find((k) => k.ref.noteId === 3)
    expect(under3.tick).toBe(480)
    expect(nudgeNotePos(data, under3)).toBe(0)
    expect(nudgeNoteMove(data, under3, -120)).toEqual({ pos: 120, tick: 360 })
  })
})

describe('group moves never merge keys', () => {
  it('a group nudge stops at the zone edge: two Head keys are never squeezed onto one place', () => {
    const { data, index, inst } = setup()
    const sel = [inst('h:1:100:zoom:Head:0@0'), inst('h:1:100:zoom:Head:120@0')]
    const left = nudgeSelection(data, index, sel, -240)
    expect(left.blocked).toBe(false)
    expect(movePlan(data, left)[0].curve.keys.map((k) => k.pos)).toEqual([0, 120])
    expect(nudgeSelection(data, index, sel, 240).edits.map((e) => e.pos)).toEqual([0, 120])
    // A single Head key still moves up to the edge.
    expect(nudgeSelection(data, index, [inst('h:1:100:zoom:Head:0@0')], 240).edits[0].pos).toBe(120)
  })

  it('two moved keys snapping onto one place: the move is refused and nothing is written', () => {
    const { data, index, inst } = hitSetup({ hitCurve: [K('zoom', 0.3, 1.5, 'Linear', 'Body'), K('zoom', 0.35, 2, 'Linear', 'Body')] })
    const a = inst('h:1:100:zoom:Body:0.3@0')
    const b = inst('h:1:100:zoom:Body:0.35@0')
    const snapNote = (span, anchor, t) => snapNotePos(span, anchor, t, { step: 240 })
    const r = moveSelection(data, index, [a, b], 6, { primary: a, snapNote })
    expect(r.blocked).toBe(true)
    expect(r.edits).toEqual([])
    expect(movePlan(data, r)).toEqual([])
  })
})

describe('marquee cost on collapsed rows', () => {
  it('reads every key behind the summary once, not once per summary tick', () => {
    let reads = 0
    const N = 3000
    const list = Array.from({ length: N }, (_, i) => {
      const k = { id: `k${i}`, tick: i * 10, value: 0, ref: { kind: 'roam', trackId: 9, channel: 'offsetX', pos: i * 10 } }
      Object.defineProperty(k, 'outside', { get: () => { reads++; return false } })
      return k
    })
    const pn = { key: 't:9/p', prop: { id: 'roam.offsetX', type: 'scalar' }, provider: { id: 'test', keys: () => list }, target: {} }
    const row = { key: 't:9', kind: 'track', expanded: false, y: 0, height: 28, trackId: 9, node: { key: 't:9', children: [pn] } }
    const out = keysInRect({ rows: [row] }, {}, { x0: 95, y0: 1, x1: N * 10, y1: 2 }, (x) => x)
    expect(out).toHaveLength(N - 10)                    // ticks 100.. (x 95 is past the key at 90)
    expect(out[0].id).toBe('k10')
    expect(reads).toBeLessThan(4 * N)
  })
})

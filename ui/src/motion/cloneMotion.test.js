// Clones in Motion view (docs/XLETH_CLONE_SPEC.md "Timeline and Motion view"):
// the data each cell reads, the rows each Clone kind gets, the Trail provider's
// plans (R3 / R4), key edits on Trail opacity keys, copy / paste, the Parent
// candidates and the plan's wire form. Pure: no React, no IPC.
import { describe, expect, it } from 'vitest'
import { buildMotionData, lensRoamStateFrom, adoptPostState, computeMotionTrackIds } from './useMotionData.js'
import { buildMotionRows, refTarget, rowKeys } from './rowRegistry.js'
import { trailProvider } from './providers/trailProvider.js'
import { lensProvider } from './providers/lensProvider.js'
import { propertyById, formatValue, parseValue } from './schema.js'
import {
  clampDelayTicks, clonePatchToWire, normalizeClone, opacityKeysFromWire, opacityKeysToWire, trailOpacityValueAt,
} from './cloneMotion.js'
import { deleteKeysPlan, interpPlan, keyIdAfter, moveSelection, buildKeyIndex, movePlan, propIdOf } from './motionGestureModel.js'
import { copyKeys, pasteKeysPlan } from './motionClipboard.js'
import { classifyParents } from './parentModel.js'
import { collapsePlan } from './motionPlan.js'
import {
  CLONE_BLOCKS as BLOCKS, CLONE_PATTERNS as PATTERNS, cloneData as dataFor, cloneLensRoam as lensRoamFor,
  cloneTracks as tracksWith, trailClone as trail,
} from './providers/__tests__/cloneFixtures.js'

const stripOf = (data, id) => {
  const s = data.noteStrip(id)
  return Array.from({ length: s.count }, (_, i) => [s.noteIds[i], s.starts[i], s.ends[i]])
}

const rowOf = (layout, key) => layout.byKey.get(key)

describe('the notes each cell plays (reference strips, Lens keys, snapping)', () => {
  it('the source shows voice 0 and the overflow notes; the Voice clone its voice; the Trail voice 0 shifted', () => {
    const data = dataFor()
    expect(stripOf(data, 1)).toEqual([[1, 0, 960], [3, 480, 720], [4, 1920, 2880]])
    expect(stripOf(data, 5)).toEqual([[2, 0, 960]])
    expect(stripOf(data, 6)).toEqual([[1, 480, 1440], [3, 960, 1200], [4, 2400, 3360]])
  })

  it('without Voice clones the source shows every note', () => {
    const tracks = tracksWith().filter((t) => t.id !== 5)
    const data = dataFor({ tracks })
    expect(stripOf(data, 1).map((n) => n[0])).toEqual([2, 1, 3, 4])
  })

  it('an adopted delay moves the Trail strip', () => {
    const data = dataFor()
    const st = adoptPostState(lensRoamStateFrom({ lensRoam: lensRoamFor(tracksWith()), layout: null, motionBlur: null }), {
      trackId: 6, changed: true, clone: { ...trail(6).clone, delayTicks: 960 },
    })
    const next = buildMotionData({ tracks: data.tracks, clips: [], patternBlocks: BLOCKS, patterns: PATTERNS, regions: {}, lensRoam: st })
    expect(next.cloneOf(6).delayTicks).toBe(960)
    expect(stripOf(next, 6)[0]).toEqual([1, 960, 1920])
  })

  it('regions: an Own Voice clone has its source regions (its Lens rows); Linked and Trail none', () => {
    expect(dataFor().regionsByTrack.get(5)).toEqual([])
    expect(dataFor().regionsByTrack.get(6)).toEqual([])
    expect(dataFor({ lensMode: 'Own' }).regionsByTrack.get(5)).toEqual([100])
  })

  it('a Trail with opacity keys has motion (the Edit marker)', () => {
    expect(computeMotionTrackIds(dataFor()).has(6)).toBe(false)
    const keyed = dataFor({ trailExtra: { opacityKeys: [{ pos: 0, value: 1, interp: 'Linear' }] } })
    expect(computeMotionTrackIds(keyed).has(6)).toBe(true)
  })
})

describe('rows per Clone kind', () => {
  const expandAll = (data) => {
    const all = buildMotionRows({ tracks: data.tracks, data, expanded: new Set() })
    return new Set([...all.nodes.keys()])
  }

  it('Clone track rows sit one level in, under their source', () => {
    const data = dataFor()
    const layout = buildMotionRows({ tracks: data.tracks, data, expanded: new Set() })
    expect(layout.rows.map((r) => [r.key, r.depth])).toEqual([['t:1', 0], ['t:5', 1], ['t:6', 1], ['t:2', 0]])
  })

  it('Trail: a Trail group (Delay, Tint, Opacity) and "Roam · added" (Offset X, Y); no Lens, Masks or Sweep', () => {
    const data = dataFor()
    const layout = buildMotionRows({ tracks: data.tracks, data, expanded: expandAll(data) })
    const trailRows = layout.rows.filter((r) => r.trackId === 6).map((r) => [r.key, r.label, r.depth])
    expect(trailRows).toEqual([
      ['t:6', 'Lead · Trail 1', 1],
      ['t:6/trail', 'Trail', 2],
      ['t:6/trail/trail.delay', 'Delay', 3],
      ['t:6/trail/trail.tint', 'Tint', 3],
      ['t:6/trail/trail.opacity', 'Opacity', 3],
      ['t:6/roam', 'Roam · added', 2],
      ['t:6/roam/roam.offsetX', 'Offset X', 3],
      ['t:6/roam/roam.offsetY', 'Offset Y', 3],
    ])
  })

  it('Linked Voice clone: one read-only "Lens · linked to Lead" line, then Roam (with Masks) and Sweep', () => {
    const data = dataFor()
    const layout = buildMotionRows({ tracks: data.tracks, data, expanded: expandAll(data) })
    const lens = rowOf(layout, 't:5/lens')
    expect(lens.label).toBe('Lens · linked to Lead')
    expect(lens.expandable).toBe(false)
    expect(lens.expanded).toBe(false)
    const groups = layout.rows.filter((r) => r.trackId === 5 && r.kind === 'group').map((r) => r.key)
    expect(groups).toEqual(['t:5/lens', 't:5/roam', 't:5/roam/masks', 't:5/sweep'])
  })

  it('Own Voice clone: its own Lens rows on its own trackId, hit keys under the notes it plays', () => {
    const data = dataFor({ lensMode: 'Own' })
    const layout = buildMotionRows({ tracks: data.tracks, data, expanded: expandAll(data) })
    const zoom = rowOf(layout, 't:5/lens/sourceLens.zoom')
    expect(zoom.target).toEqual({ kind: 'source', regionId: 100 })
    // The clone's own Lens base (zoom 1.5), no hit keys of its own.
    expect(lensProvider.valueAt(zoom, data, 100)).toBe(1.5)
    expect(rowKeys(zoom, data)).toEqual([])
    // The source's hit key is drawn under ITS notes only (1, 3, 4), not the clone's note 2.
    const leadZoom = rowOf(layout, 't:1/lens/sourceLens.zoom')
    expect(rowKeys(leadZoom, data).map((k) => k.ref.noteId)).toEqual([1, 3, 4])
  })
})

describe('Trail rows: values and plans (R3, R4)', () => {
  const data = dataFor()
  const layout = buildMotionRows({ tracks: data.tracks, data, expanded: new Set(['t:6', 't:6/trail']) })
  const delay = rowOf(layout, 't:6/trail/trail.delay')
  const tint = rowOf(layout, 't:6/trail/trail.tint')
  const opacity = rowOf(layout, 't:6/trail/trail.opacity')

  it('values: delay, tint, the base opacity when unkeyed', () => {
    expect(trailProvider.valueAt(delay, data, 0)).toBe(480)
    expect(trailProvider.valueAt(tint, data, 0)).toBe('#F07A2A')
    expect(trailProvider.valueAt(opacity, data, 0)).toBe(0.9)
    expect(trailProvider.isAnimated(opacity, data)).toBe(false)
    expect(formatValue(propertyById('trail.opacity'), 0.9)).toBe('90 %')
    expect(formatValue(propertyById('trail.tint'), '#f07a2a')).toBe('#F07A2A')
    expect(parseValue(propertyById('trail.tint'), ' f07a2a ')).toBe('#F07A2A')
    expect(parseValue(propertyById('trail.tint'), '#f07a2')).toBeNull()
  })

  it('static edits: one setCloneSettings patch each (delay clamped to whole ticks, tint normalised)', () => {
    expect(trailProvider.valuePlan(delay, data, 0, 960.4)).toEqual([{ kind: 'cloneSettings', trackId: 6, patch: { delayTicks: 960 } }])
    expect(trailProvider.valuePlan(delay, data, 0, 480)).toEqual([])
    expect(trailProvider.valuePlan(delay, data, 0, 1e9)).toEqual([{ kind: 'cloneSettings', trackId: 6, patch: { delayTicks: 245760 } }])
    expect(trailProvider.valuePlan(tint, data, 0, '#9b7bf0')).toEqual([{ kind: 'cloneSettings', trackId: 6, patch: { tint: '#9B7BF0' } }])
    expect(trailProvider.valuePlan(tint, data, 0, 'nope')).toEqual([])
    expect(trailProvider.valuePlan(opacity, data, 0, 0.5)).toEqual([{ kind: 'cloneSettings', trackId: 6, patch: { opacity: 0.5 } }])
    expect(trailProvider.valuePlan(opacity, data, 0, 3)).toEqual([{ kind: 'cloneSettings', trackId: 6, patch: { opacity: 1 } }])
  })

  it('stopwatch ON writes one key at the playhead holding the value shown', () => {
    const [w] = trailProvider.stopwatchPlan(opacity, data, 1920, true)
    expect(w.kind).toBe('cloneSettings')
    expect(opacityKeysToWire(w.patch.opacityKeys)).toEqual([{ pos: 1920, value: 0.9, interp: 'Linear' }])
  })

  it('keyed: keys and values; an edit keys the playhead; stopwatch OFF folds the value into the base, one patch', () => {
    const keyed = dataFor({ trailExtra: { opacityKeys: [{ pos: 0, value: 1, interp: 'Linear' }, { pos: 3840, value: 0.2, interp: 'Hold' }] } })
    const kl = buildMotionRows({ tracks: keyed.tracks, data: keyed, expanded: new Set(['t:6', 't:6/trail']) })
    const op = rowOf(kl, 't:6/trail/trail.opacity')
    expect(rowKeys(op, keyed).map((k) => [k.id, k.tick, k.value, k.interp])).toEqual([['to:6:0', 0, 1, 'Linear'], ['to:6:3840', 3840, 0.2, 'Hold']])
    expect(trailProvider.isAnimated(op, keyed)).toBe(true)
    expect(trailProvider.valueAt(op, keyed, 1920)).toBeCloseTo(0.6, 10)
    const [edit] = trailProvider.valuePlan(op, keyed, 1920, 0.4)
    expect(opacityKeysToWire(edit.patch.opacityKeys)).toEqual([
      { pos: 0, value: 1, interp: 'Linear' }, { pos: 1920, value: 0.4, interp: 'Linear' }, { pos: 3840, value: 0.2, interp: 'Hold' },
    ])
    const [off] = trailProvider.stopwatchPlan(op, keyed, 1920, false)
    expect(off.patch.opacityKeys).toEqual([])
    expect(off.patch.opacity).toBeCloseTo(0.6, 10)
    // Removing a key leaves the rest; removing the last one folds (R3).
    expect(opacityKeysToWire(trailProvider.removeKeyPlan(op, keyed, 0)[0].patch.opacityKeys)).toEqual([{ pos: 3840, value: 0.2, interp: 'Hold' }])
    const one = dataFor({ trailExtra: { opacityKeys: [{ pos: 960, value: 0.3, interp: 'Linear' }] } })
    const r1 = rowOf(buildMotionRows({ tracks: one.tracks, data: one, expanded: new Set(['t:6', 't:6/trail']) }), 't:6/trail/trail.opacity')
    expect(trailProvider.removeKeyPlan(r1, one, 960)).toEqual([{ kind: 'cloneSettings', trackId: 6, patch: { opacity: 0.3, opacityKeys: [] } }])
  })
})

describe('Trail opacity keys in the key editor', () => {
  const keyed = dataFor({ trailExtra: { opacityKeys: [{ pos: 0, value: 1, interp: 'Linear' }, { pos: 3840, value: 0.2, interp: 'Linear' }] } })
  const layout = buildMotionRows({ tracks: keyed.tracks, data: keyed, expanded: new Set(['t:6', 't:6/trail']) })
  const row = rowOf(layout, 't:6/trail/trail.opacity')
  const [a, b] = rowKeys(row, keyed)

  it('ref helpers know the kind', () => {
    expect(propIdOf(a.ref)).toBe('trail.opacity')
    expect(refTarget(a.ref)).toBe('trailOpacity:6:0')
    expect(keyIdAfter(a, 960)[0]).toBe('to:6:960')
  })

  it('a move is ONE cloneSettings write of the whole list', () => {
    const index = buildKeyIndex(layout, keyed)
    const moved = moveSelection(keyed, index, [a], 960)
    const plan = movePlan(keyed, moved)
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe('cloneSettings')
    expect(opacityKeysToWire(plan[0].patch.opacityKeys).map((k) => k.pos)).toEqual([960, 3840])
  })

  it('deleting every key folds the value at the playhead into the base', () => {
    const plan = deleteKeysPlan(keyed, [a, b], { foldTick: 1920 })
    expect(plan).toHaveLength(1)
    expect(plan[0].patch.opacityKeys).toEqual([])
    expect(plan[0].patch.opacity).toBeCloseTo(0.6, 10)
  })

  it('interp and Bezier reach the wire form', () => {
    const plan = interpPlan(keyed, [a], 'Bezier', [0.1, 0, 0.9, 1])
    expect(opacityKeysToWire(plan[0].patch.opacityKeys)[0]).toEqual({ pos: 0, value: 1, interp: 'Bezier', bez: [0.1, 0, 0.9, 1] })
  })

  it('copy / paste: onto a Trail clone only', () => {
    const clip = copyKeys(keyed, [b])
    expect(clip.entries[0].kind).toBe('trailOpacity')
    const onTrail = pasteKeysPlan(keyed, clip, { tick: 960, targetTrackId: 6 })
    expect(onTrail.count).toBe(1)
    expect(opacityKeysToWire(onTrail.plan[0].patch.opacityKeys).map((k) => [k.pos, k.value])).toEqual([[0, 1], [960, 0.2], [3840, 0.2]])
    const onLead = pasteKeysPlan(keyed, clip, { tick: 960, targetTrackId: 1 })
    expect(onLead.count).toBe(0)
    expect(onLead.note).toMatch(/Trail opacity keys go on Trail clones/)
  })
})

describe('Parent candidates (R8 + Clones)', () => {
  const tracks = tracksWith()
  it('a Trail is never offered; Voice clones are', () => {
    const ids = classifyParents(2, tracks).eligible.map((t) => t.id)
    expect(ids).toEqual([1, 5])
    expect(classifyParents(2, tracks).excluded.find((e) => e.track.id === 6).reason).toBe('trail_clone')
  })
  it('a Trail has no candidates at all', () => {
    expect(classifyParents(6, tracks).eligible).toEqual([])
  })
})

describe('wire form and settings', () => {
  it('opacity keys: Motion view shape <-> the strict engine list (no channel / anchor)', () => {
    const keys = opacityKeysFromWire([{ pos: 960, value: 1.2, interp: 'EaseOut' }, { pos: 0, value: 0.5, interp: 'Bezier', bez: [0.2, 0, 0.8, 1] }, { pos: 'x', value: 1 }])
    expect(keys.map((k) => [k.channel, k.anchor, k.pos, k.value])).toEqual([['opacity', 'Origin', 0, 0.5], ['opacity', 'Origin', 960, 1]])
    expect(opacityKeysToWire(keys)).toEqual([
      { pos: 0, value: 0.5, interp: 'Bezier', bez: [0.2, 0, 0.8, 1] },
      { pos: 960, value: 1, interp: 'EaseOut' },
    ])
    expect(clonePatchToWire({ opacity: 0.5, opacityKeys: keys }).opacityKeys[0]).not.toHaveProperty('channel')
  })

  it('normalizeClone and the value at a tick', () => {
    expect(normalizeClone(null)).toBeNull()
    const c = normalizeClone(trail(6, { tint: '#f07a2a', opacityKeys: [{ pos: 0, value: 0, interp: 'Linear' }, { pos: 100, value: 1, interp: 'Linear' }] }).clone)
    expect(c.tint).toBe('#F07A2A')
    expect(trailOpacityValueAt(c, 50)).toBeCloseTo(0.5, 10)
    expect(clampDelayTicks(0)).toBe(1)
    expect(clampDelayTicks(Number.NaN)).toBeNull()
  })

  it('cloneSettings writes to one Clone merge field by field (last wins)', () => {
    expect(collapsePlan([
      { kind: 'cloneSettings', trackId: 6, patch: { opacity: 0.5 } },
      { kind: 'roamKeys', trackId: 6, keys: [] },
      { kind: 'cloneSettings', trackId: 6, patch: { opacityKeys: [] } },
    ])).toEqual([
      { kind: 'roamKeys', trackId: 6, keys: [] },
      { kind: 'cloneSettings', trackId: 6, patch: { opacity: 0.5, opacityKeys: [] } },
    ])
  })
})

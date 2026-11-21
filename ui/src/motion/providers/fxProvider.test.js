import { describe, expect, it } from 'vitest'
import { fxProvider } from './fxProvider.js'
import { buildMotionRows } from '../rowRegistry.js'
import { fxKeysFromWire, fxKeysToWire, fxPropId } from '../fxModel.js'
import { propertyById, formatValue } from '../schema.js'
import { planKeyEdits } from '../motionGestureModel.js'
import { fixtureData, fixtureTracks } from './__tests__/fixtures.js'

// Chroma key (type 5): params 3 Tolerance, 4 Softness, ...; Outline (6): 3 Thickness ...
const chain = [
  { type: 5, uid: 4, bypassed: false, params: [0, 0.69, 0.25, 0.1, 0.22, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { type: 6, uid: 7, bypassed: false, params: [1, 1, 1, 3, 0, 1, 0.95, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { type: 6, uid: 9, bypassed: true, params: [1, 1, 1, 6, 0, 1, 0.95, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
]

function withChain(fxKeys = []) {
  const tracks = fixtureTracks().map((t) => (t.id === 1 ? { ...t, visualEffectChain: chain } : t))
  const base = fixtureData()
  const entry = { roam: {}, keys: [], sweep: [], parentTrackId: -1, masks: [], fxKeys: fxKeysFromWire(fxKeys) }
  const data = { ...base, tracksById: new Map(tracks.map((t) => [t.id, t])), roamOf: (id) => (id === 1 ? entry : base.roamOf?.(id)) }
  return { tracks, data }
}

const rowFor = (tracks, data, effectUid, param, type) => {
  const L = buildMotionRows({
    tracks, data, trackRowHeight: 28,
    expanded: new Set(['t:1', 't:1/fx', `t:1/fx/${effectUid}`]),
  })
  return L.byKey.get(`t:1/fx/${effectUid}/${fxPropId(type, param)}`)
}

describe('video effect rows', () => {
  it('one group per chain effect, a row per animatable parameter, duplicates numbered', () => {
    const { tracks, data } = withChain()
    const [g] = fxProvider.groups(tracks[0], data)
    expect(g.key).toBe('t:1/fx')
    expect(g.children.map((c) => c.label)).toEqual(['Chroma key', 'Outline 1', 'Outline 2 (bypassed)'])
    expect(g.children[0].children.map((c) => c.prop.label)).toEqual(['Tolerance', 'Softness', 'Spill', 'Choke', 'Edge blur'])
    expect(g.children[1].key).toBe('t:1/fx/7')
    expect(g.children[1].children[0].key).toBe(`t:1/fx/7/${fxPropId(6, 3)}`)
    // A track with no chain has no Video effects group.
    expect(fxProvider.groups(tracks[1], data)).toEqual([])
  })

  it('catalog parameters are registered as schema-shaped properties', () => {
    const p = propertyById(fxPropId(5, 3))
    expect(p).toMatchObject({ label: 'Tolerance', type: 'scalar', animatable: true, identity: 0.1, clamp: [0, 0.6] })
    expect(formatValue(fxPropId(6, 3), 3)).toBe('3.0 px')
    // Echo Taps is a whole number: not animatable, no row.
    expect(propertyById(fxPropId(8, 0))).toBeNull()
  })

  it('wire keys round-trip through the UI key shape', () => {
    const wire = [{ uid: 4, param: 3, pos: 480, value: 0.3, interp: 'Linear' }, { uid: 7, param: 3, pos: 0, value: 2, interp: 'Bezier', bez: [0.2, 0, 0.8, 1] }]
    const ui = fxKeysFromWire(wire)
    expect(ui[0]).toMatchObject({ channel: '4:3', anchor: 'Origin', pos: 480, value: 0.3 })
    expect(fxKeysToWire(ui)).toEqual(wire)
  })

  it('stopwatch on keys the value now; off folds it back into the effect', () => {
    const { tracks, data } = withChain()
    const row = rowFor(tracks, data, 4, 3, 5)
    expect(row.prop.label).toBe('Tolerance')
    expect(fxProvider.valueAt(row, data, 0)).toBe(0.1)
    const on = fxProvider.stopwatchPlan(row, data, 960, true)
    expect(on).toEqual([{ kind: 'fxKeys', trackId: 1, keys: [expect.objectContaining({ channel: '4:3', pos: 960, value: 0.1 })] }])

    const keyed = withChain([{ uid: 4, param: 3, pos: 0, value: 0.0, interp: 'Linear' }, { uid: 4, param: 3, pos: 960, value: 0.4, interp: 'Linear' }])
    const row2 = rowFor(keyed.tracks, keyed.data, 4, 3, 5)
    expect(fxProvider.isAnimated(row2, keyed.data, 0)).toBe(true)
    expect(fxProvider.valueAt(row2, keyed.data, 480)).toBeCloseTo(0.2, 6)
    const off = fxProvider.stopwatchPlan(row2, keyed.data, 480, false)
    expect(off[0]).toMatchObject({ kind: 'fxBase', trackId: 1, index: 0, param: 3 })
    expect(off[0].value).toBeCloseTo(0.2, 6)
    expect(off[1]).toEqual({ kind: 'fxKeys', trackId: 1, keys: [] })
  })

  it('a value edit keys it while animated and sets the effect while static; values are clamped', () => {
    const { tracks, data } = withChain()
    const row = rowFor(tracks, data, 4, 3, 5)
    expect(fxProvider.valuePlan(row, data, 0, 5)).toEqual([{ kind: 'fxBase', trackId: 1, index: 0, param: 3, value: 0.6 }])
    const keyed = withChain([{ uid: 4, param: 3, pos: 0, value: 0.1, interp: 'Linear' }])
    const row2 = rowFor(keyed.tracks, keyed.data, 4, 3, 5)
    const plan = fxProvider.valuePlan(row2, keyed.data, 240, 0.3)
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe('fxKeys')
    expect(plan[0].keys.map((k) => [k.pos, k.value])).toEqual([[0, 0.1], [240, 0.3]])
  })

  it('keys follow the effect when it moves in the chain (addressed by uid)', () => {
    const keyed = withChain([{ uid: 7, param: 3, pos: 0, value: 8, interp: 'Linear' }])
    const reordered = { ...keyed.data, tracksById: new Map([[1, { ...keyed.tracks[0], visualEffectChain: [chain[1], chain[0], chain[2]] }]]) }
    const row = rowFor([{ ...keyed.tracks[0], visualEffectChain: [chain[1], chain[0], chain[2]] }], reordered, 7, 3, 6)
    expect(fxProvider.valueAt(row, reordered, 0)).toBe(8)
    expect(fxProvider.valuePlan(row, reordered, 0, 12)[0].keys[0].channel).toBe('7:3')
  })

  it('deleting the last key of a parameter writes its value back to the effect, then the key list', () => {
    const keyed = withChain([{ uid: 4, param: 3, pos: 100, value: 0.3, interp: 'Linear' }])
    const row = rowFor(keyed.tracks, keyed.data, 4, 3, 5)
    const [inst] = fxProvider.keys(row, keyed.data)
    const plan = planKeyEdits(keyed.data, [{ ref: inst.ref, key: inst.key, remove: true }], { foldTick: 100 })
    expect(plan[0]).toMatchObject({ kind: 'fxBase', trackId: 1, index: 0, param: 3 })
    expect(plan[0].value).toBeCloseTo(0.3, 6)
    expect(plan[1]).toEqual({ kind: 'fxKeys', trackId: 1, keys: [] })
  })
})

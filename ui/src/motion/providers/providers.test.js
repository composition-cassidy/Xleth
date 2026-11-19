import { describe, expect, it } from 'vitest'
import { ROAM_IDENTITY } from '../../lensRoam/lensRoamModel.js'
import { propertyById } from '../schema.js'
import { formatValue } from '../schema.js'
import { lensProvider, NO_CLIP_BLOCKER, NO_NOTE_BLOCKER } from './lensProvider.js'
import { roamProvider } from './roamProvider.js'
import { sweepProvider, SWEEP_STATIC_BLOCKER } from './sweepProvider.js'
import { maskProvider } from './maskProvider.js'
import { combineLayer, layerBetween, upsertNoteKey, upsertOriginKey } from './common.js'
import { fixtureData, fixtureLensRoam, fixtureTracks, LENS_ID } from './__tests__/fixtures.js'

const tracks = fixtureTracks()
const T = (id) => tracks.find((t) => t.id === id)
const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps)

/** A property row the way rowRegistry builds one. */
function rowFor(provider, trackId, propId, target = {}) {
  const prop = propertyById(propId)
  return { key: `t:${trackId}/x/${propId}`, kind: 'prop', trackId, prop, provider, target }
}

describe('row building per provider', () => {
  const data = fixtureData()

  it('Roam: Offset X, Offset Y, Scale, Link scale, Rotation, Crop x4, Bounds, Layer, Motion blur, then Masks', () => {
    const [g] = roamProvider.groups(T(1), data)
    expect(g.key).toBe('t:1/roam')
    const labels = g.children.map((c) => c.prop?.label ?? c.label)
    expect(labels).toEqual(['Offset X', 'Offset Y', 'Scale', 'Link scale', 'Rotation',
      'Crop left', 'Crop right', 'Crop top', 'Crop bottom', 'Bounds', 'Layer', 'Project blur', 'Masks'])
    const masks = g.children[12]
    expect(masks.key).toBe('t:1/roam/masks')
    expect(masks.children.map((m) => m.key)).toEqual(['t:1/mask:1'])
    expect(masks.children[0].children.map((c) => c.prop.label)).toEqual(['Shape', 'Feather', 'Expansion', 'Opacity', 'Mode', 'Invert'])
    expect(masks.children[0].children[1].key).toBe('t:1/mask:1/mask.feather')
  })

  it('Roam: an unlinked scale shows Scale X and Scale Y; linking and unlinking are one plan', () => {
    const roam = { ...ROAM_IDENTITY, scale: 2, scaleLinked: false, scaleY: 0.5 }
    const unlinkedData = { ...data, roamOf: () => ({ roam, keys: [], parentTrackId: -1, masks: [] }) }
    const [g] = roamProvider.groups(T(1), unlinkedData)
    const labels = g.children.map((c) => c.prop?.label ?? c.label)
    expect(labels.slice(2, 5)).toEqual(['Scale X', 'Scale Y', 'Link scale'])

    const linkedData = { ...data, roamOf: () => ({ roam: { ...ROAM_IDENTITY, scale: 2 }, keys: [{ channel: 'scale', anchor: 'Origin', pos: 0, value: 2, interp: 'Linear' }], parentTrackId: -1, masks: [] }) }
    const row = { prop: propertyById('roam.scaleLinked'), trackId: 1, key: 't:1/roam/roam.scaleLinked' }
    // Unlink: Scale Y starts at the scale now, and gets a copy of the Scale keys.
    const unlink = roamProvider.valuePlan(row, linkedData, 0, false)
    expect(unlink[0]).toEqual({ kind: 'roamBase', trackId: 1, params: { scaleLinked: false, scaleY: 2 } })
    expect(unlink[1].keys.map((k) => k.channel).sort()).toEqual(['scale', 'scaleY'])
    // Link again: the flag flips and the Scale Y keys go.
    const keyedData = { ...data, roamOf: () => ({ roam, keys: unlink[1].keys, parentTrackId: -1, masks: [] }) }
    const link = roamProvider.valuePlan(row, keyedData, 0, true)
    expect(link[0]).toEqual({ kind: 'roamBase', trackId: 1, params: { scaleLinked: true } })
    expect(link[1].keys.map((k) => k.channel)).toEqual(['scale'])
  })

  it('Sweep: Pattern tracks only, the real channels plus Motion blur (R2)', () => {
    expect(sweepProvider.groups(T(2), data)).toEqual([])
    const [g] = sweepProvider.groups(T(1), data)
    expect(g.key).toBe('t:1/sweep')
    expect(g.children.map((c) => c.prop.label)).toEqual(['Zoom', 'Center X', 'Center Y', 'Rotation', 'Project blur'])
  })

  it('Lens: one group on a Clip track, one per source on a Pattern track (R22)', () => {
    const [clip] = lensProvider.groups(T(2), data)
    expect(clip.key).toBe('t:2/lens')
    expect(clip.label).toBe('Lens')
    expect(clip.children.map((c) => c.prop.id)).toEqual([
      'clipLens.fit', 'clipLens.zoom', 'clipLens.centerX', 'clipLens.centerY', 'clipLens.rotationDeg', 'clipLens.flip',
    ])
    const one = lensProvider.groups(T(1), data)
    expect(one.map((g) => [g.key, g.label])).toEqual([['t:1/lens', 'Lens']])
    const two = lensProvider.groups(T(3), data)
    expect(two.map((g) => [g.key, g.label])).toEqual([['t:3/lens:100', 'Lens · Hit'], ['t:3/lens:101', 'Lens · Snare']])
    expect(two[1].children[1].key).toBe('t:3/lens:101/sourceLens.zoom')
    expect(two[1].children[1].target).toEqual({ kind: 'source', regionId: 101 })
  })
})

describe('Roam rows', () => {
  const data = fixtureData()
  const ox = rowFor(roamProvider, 1, 'roam.offsetX')
  const sc = rowFor(roamProvider, 1, 'roam.scale')

  it('values: keyed channel follows its keys, unkeyed holds the base', () => {
    close(roamProvider.valueAt(ox, data, 1920), 0.5)
    close(roamProvider.valueAt(ox, data, 960), 0.25)
    expect(roamProvider.valueAt(sc, data, 1920)).toBe(1)
    expect(roamProvider.valueAt(rowFor(roamProvider, 1, 'roam.bounds'), data, 0)).toBe('Clip')
    expect(roamProvider.valueAt(rowFor(roamProvider, 1, 'roam.motionBlur'), data, 0)).toEqual({ enabled: true, shutterAngleDeg: 180 })
    expect(roamProvider.isAnimated(ox, data)).toBe(true)
    expect(roamProvider.isAnimated(sc, data)).toBe(false)
  })

  it('keys: one instance per key, sorted, with the keyId and ref', () => {
    const ks = roamProvider.keys(ox, data)
    expect(ks.map((k) => k.id)).toEqual(['r:1:offsetX:0', 'r:1:offsetX:3840'])
    expect(ks[1]).toMatchObject({ tick: 3840, value: 1, hollow: false, ref: { kind: 'roam', trackId: 1, channel: 'offsetX', pos: 3840 } })
  })

  it('stopwatch OFF: removes the channel\'s keys AND sets the base to the value at the playhead, in ONE plan (R3)', () => {
    const plan = roamProvider.stopwatchPlan(ox, data, 1920, false)
    expect(plan).toEqual([
      { kind: 'roamBase', trackId: 1, params: { offsetX: 0.5 } },
      { kind: 'roamKeys', trackId: 1, keys: [] },
    ])
  })

  it('stopwatch ON: one key at the playhead holding the value shown', () => {
    const plan = roamProvider.stopwatchPlan(sc, data, 1000, true)
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe('roamKeys')
    expect(plan[0].keys).toContainEqual({ channel: 'scale', anchor: 'Origin', pos: 1000, value: 1, interp: 'Linear' })
    expect(plan[0].keys.filter((k) => k.channel === 'offsetX')).toHaveLength(2)
  })

  it('value edit: animated upserts a key at the playhead (no rest key); static edits the base (R4)', () => {
    const a = roamProvider.valuePlan(ox, data, 1000, 2)
    expect(a).toHaveLength(1)
    expect(a[0].keys).toHaveLength(3)
    expect(a[0].keys).toContainEqual({ channel: 'offsetX', anchor: 'Origin', pos: 1000, value: 2, interp: 'Linear' })
    const onKey = roamProvider.valuePlan(ox, data, 3840, 4)
    expect(onKey[0].keys).toHaveLength(2)
    expect(onKey[0].keys.find((k) => k.pos === 3840).value).toBe(4)
    expect(roamProvider.valuePlan(sc, data, 1000, 2)).toEqual([{ kind: 'roamBase', trackId: 1, params: { scale: 2 } }])
    expect(roamProvider.valuePlan(rowFor(roamProvider, 1, 'roam.layer'), data, 0, 'Top')).toEqual([{ kind: 'roamBase', trackId: 1, params: { layer: 'Top' } }])
    expect(roamProvider.valuePlan(rowFor(roamProvider, 1, 'roam.motionBlur'), data, 0, 90)).toEqual([])
  })

  it('remove key at the playhead; the last one folds its value into the base', () => {
    expect(roamProvider.removeKeyPlan(ox, data, 3840)).toEqual([{ kind: 'roamKeys', trackId: 1, keys: [expect.objectContaining({ pos: 0 })] }])
    const one = fixtureData({ lensRoam: {
      tracks: [{ trackId: 1, roam: { offsetX: 0 }, keys: [{ channel: 'offsetX', anchor: 'Origin', pos: 10, value: 3, interp: 'Linear' }], sweep: [], parentTrackId: -1, masks: [] }],
      sources: [],
      clips: [],
    } })
    expect(roamProvider.removeKeyPlan(ox, one, 10)).toEqual([
      { kind: 'roamBase', trackId: 1, params: { offsetX: 3 } },
      { kind: 'roamKeys', trackId: 1, keys: [] },
    ])
    expect(roamProvider.removeKeyPlan(ox, data, 500)).toEqual([])
  })
})

describe('Sweep rows (a layer, R2)', () => {
  const data = fixtureData()
  const zoom = rowFor(sweepProvider, 1, 'sweep.zoom')
  const cx = rowFor(sweepProvider, 1, 'sweep.centerX')

  it('values: the layer; unkeyed = identity', () => {
    expect(sweepProvider.valueAt(zoom, data, 0)).toBe(1.5)
    expect(sweepProvider.valueAt(cx, data, 0)).toBe(0)
  })

  it('stopwatch ON writes the layer identity; OFF removes the keys only', () => {
    expect(sweepProvider.stopwatchPlan(cx, data, 100, true)[0].keys).toContainEqual({ channel: 'centerX', anchor: 'Origin', pos: 100, value: 0, interp: 'Linear' })
    expect(sweepProvider.stopwatchPlan(zoom, data, 100, false)).toEqual([{ kind: 'sweepKeys', trackId: 1, keys: [] }])
  })

  it('a static row has no value to edit', () => {
    expect(sweepProvider.editBlocker(cx, data, 0, 'value')).toBe(SWEEP_STATIC_BLOCKER)
    expect(sweepProvider.valuePlan(cx, data, 0, 0.3)).toEqual([])
    expect(sweepProvider.editBlocker(zoom, data, 0, 'value')).toBeNull()
    expect(sweepProvider.valuePlan(zoom, data, 960, 2)[0].keys).toEqual([{ channel: 'zoom', anchor: 'Origin', pos: 960, value: 2, interp: 'Linear' }])
  })
})

describe('Clip-track Lens rows (R22)', () => {
  const data = fixtureData()
  const target = { kind: 'clip' }
  const zoom = rowFor(lensProvider, 2, 'clipLens.zoom', target)

  it('draws every clip\'s keys at clip.start + pos', () => {
    const ks = lensProvider.keys(zoom, data)
    expect(ks.map((k) => [k.id, k.tick])).toEqual([['c:30:zoom:0', 0], ['c:30:zoom:1920', 1920]])
    expect(ks[0].ref).toMatchObject({ kind: 'clipLens', clipId: 30 })
  })

  it('values and the key toggle act on the clip under the playhead', () => {
    close(lensProvider.valueAt(zoom, data, 960), 1.5)
    expect(lensProvider.valueAt(zoom, data, 5000)).toBe(1.25)
    expect(lensProvider.isAnimated(zoom, data, 960)).toBe(true)
    expect(lensProvider.isAnimated(zoom, data, 5000)).toBe(false)
    expect(lensProvider.valueAt(zoom, data, 9000)).toBeNull()
    expect(lensProvider.editBlocker(zoom, data, 9000, 'value')).toBe(NO_CLIP_BLOCKER)
  })

  it('value edits: keyed clip upserts at pos = playhead - clip start; static clip edits its base', () => {
    const a = lensProvider.valuePlan(zoom, data, 960, 3)
    expect(a).toEqual([{ kind: 'clipLensKeys', clipId: 30, keys: expect.arrayContaining([{ channel: 'zoom', anchor: 'Origin', pos: 960, value: 3, interp: 'Linear' }]) }])
    expect(lensProvider.valuePlan(zoom, data, 4000, 2)).toEqual([{ kind: 'clipLens', clipId: 31, params: { zoom: 2 } }])
  })

  it('stopwatch OFF sets the clip base to the value at the playhead in the same plan', () => {
    expect(lensProvider.stopwatchPlan(zoom, data, 960, false)).toEqual([
      { kind: 'clipLens', clipId: 30, params: { zoom: 1.5 } },
      { kind: 'clipLensKeys', clipId: 30, keys: [] },
    ])
    const on = lensProvider.stopwatchPlan(zoom, data, 4000, true)
    expect(on).toEqual([{ kind: 'clipLensKeys', clipId: 31, keys: [{ channel: 'zoom', anchor: 'Origin', pos: 160, value: 1.25, interp: 'Linear' }] }])
  })
})

describe('Pattern-track Lens rows (R5, R22)', () => {
  const data = fixtureData()
  const target = { kind: 'source', regionId: 100 }
  const zoom = rowFor(lensProvider, 1, 'sourceLens.zoom', target)

  it('draws the hit curve hollow under every Follow / Nudge note and a Nudge note\'s own keys filled', () => {
    const ks = lensProvider.keys(zoom, data)
    expect(ks.map((k) => [k.tick, k.hollow])).toEqual([[0, true], [120, true], [1920, true], [1920, false], [2040, true]])
    expect(ks[0].id).toBe('h:1:100:zoom:Head:0@0')
    expect(ks.find((k) => !k.hollow).id).toBe('n:10:2:zoom:Head:0@1920')
    expect(ks.find((k) => !k.hollow).ref).toMatchObject({ kind: 'note', patternId: 10, noteId: 2, mode: 'Nudge' })
  })

  it('the value is base x hit x note of the note sounding at the playhead, else the base', () => {
    close(lensProvider.valueAt(zoom, data, 0), 1.35)
    // EaseOut half way: 1.35 + (1 - 1.35) * 0.75
    close(lensProvider.valueAt(zoom, data, 60), 1.0875)
    close(lensProvider.valueAt(zoom, data, 1920), 1.35 * 1.2)
    expect(lensProvider.valueAt(zoom, data, 1500)).toBe(1)
    expect(lensProvider.valueAt(rowFor(lensProvider, 1, 'sourceLens.fit', target), data, 0)).toBe('Cover')
  })

  it('an animated row\'s edit writes a hit key so the resolved value becomes what was typed', () => {
    const plan = lensProvider.valuePlan(zoom, data, 1920, 2)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ kind: 'hitCurve', trackId: 1, regionId: 100 })
    const head0 = plan[0].curve.keys.find((k) => k.anchor === 'Head' && k.pos === 0)
    close(head0.value, 2 / 1.2)
    expect(plan[0].curve.keys).toHaveLength(2)
    expect(lensProvider.editBlocker(zoom, data, 1500, 'value')).toBe(NO_NOTE_BLOCKER)
    expect(lensProvider.valuePlan(zoom, data, 1500, 2)).toEqual([])
  })

  it('stopwatch OFF folds the hit value at the playhead into the base, one plan', () => {
    const plan = lensProvider.stopwatchPlan(zoom, data, 60, false)
    expect(plan[0].kind).toBe('trackLens')
    close(plan[0].params.zoom, 1.0875)
    expect(plan[1]).toEqual({ kind: 'hitCurve', trackId: 1, regionId: 100, curve: { keys: [] } })
  })

  it('stopwatch ON writes the layer identity at the playhead\'s place in its note (Head 0 off any note)', () => {
    const cx = rowFor(lensProvider, 1, 'sourceLens.centerX', target)
    const plan = lensProvider.stopwatchPlan(cx, data, 400, true)
    const added = plan[0].curve.keys.find((k) => k.channel === 'centerX')
    expect(added).toMatchObject({ anchor: 'Body', value: 0 })
    close(added.pos, (400 - 120) / (720 - 120))
    const off = lensProvider.stopwatchPlan(cx, data, 1500, true)
    expect(off[0].curve.keys.find((k) => k.channel === 'centerX')).toMatchObject({ anchor: 'Head', pos: 0, value: 0 })
  })

  it('a static source row edits the base so the resolved value lands on what was typed', () => {
    const cx = rowFor(lensProvider, 1, 'sourceLens.centerX', target)
    expect(lensProvider.valuePlan(cx, data, 1500, 0.7)).toEqual([{ kind: 'trackLens', trackId: 1, regionId: 100, params: { centerX: 0.7 } }])
  })
})

describe('Mask rows', () => {
  const data = fixtureData()
  const target = { kind: 'mask', maskId: 1 }
  const feather = rowFor(maskProvider, 1, 'mask.feather', target)
  const shape = rowFor(maskProvider, 1, 'mask.shape', target)

  it('values and keys', () => {
    close(maskProvider.valueAt(feather, data, 1920), 0.1)
    expect(maskProvider.keys(feather, data).map((k) => k.id)).toEqual(['m:1:1:feather:0', 'm:1:1:feather:3840'])
    expect(maskProvider.valueAt(shape, data, 0).kind).toBe('Rectangle')
    expect(maskProvider.isAnimated(shape, data)).toBe(false)
    expect(formatValue('mask.shape', maskProvider.valueAt(shape, data, 0))).toBe('Rectangle')
  })

  it('stopwatch OFF on a scalar: no keys, base = value at the playhead, one masks write', () => {
    const plan = maskProvider.stopwatchPlan(feather, data, 1920, false)
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe('masks')
    expect(plan[0].masks[0].keys).toEqual([])
    close(plan[0].masks[0].base.feather, 0.1)
  })

  it('shape ON keys the whole shape at the playhead; a static kind swap keeps the bounds', () => {
    const on = maskProvider.stopwatchPlan(shape, data, 500, true)
    expect(on[0].masks[0].shapeKeys).toHaveLength(1)
    expect(on[0].masks[0].shapeKeys[0].pos).toBe(500)
    expect(on[0].masks[0].shapeKeys[0].vertices).toHaveLength(4)
    const swap = maskProvider.valuePlan(shape, data, 0, 'Ellipse')
    expect(swap[0].masks[0].kind).toBe('Ellipse')
    expect(swap[0].masks[0].base.shape.vertices[0][1]).toBeCloseTo(-0.4)
  })

  it('add / delete a mask; caps block the add (R15)', () => {
    const add = maskProvider.addMaskPlan(4, data, 'Ellipse')
    expect(add[0]).toMatchObject({ kind: 'masks', trackId: 4 })
    expect(add[0].masks[0]).toMatchObject({ id: 1, name: 'Mask 1', kind: 'Ellipse' })
    expect(maskProvider.addMaskPlan(4, data, 'Path')).toEqual([])
    expect(maskProvider.deleteMaskPlan(1, data, 1)).toEqual([{ kind: 'masks', trackId: 1, masks: [] }])
    expect(maskProvider.addBlocker(1, data, 'Rectangle')).toBeNull()
  })
})

describe('the key the add / remove button acts on, at an event boundary', () => {
  const k = (channel, anchor, pos, value) => ({ channel, anchor, pos, value, interp: 'Linear' })

  it('legato notes: the key of the note that plays (B), not the earlier note\'s tail at the same tick', () => {
    const patterns = {
      10: {
        id: 10, regionId: 100, lengthTicks: 3840,
        notes: [
          { id: 1, positionTicks: 0, durationTicks: 960, pitch: 60 },     // A ends at 960
          { id: 2, positionTicks: 960, durationTicks: 960, pitch: 62 },   // B starts at 960
        ],
      },
    }
    const lensRoam = fixtureLensRoam()
    lensRoam.sources[0] = { ...lensRoam.sources[0], hitCurve: [k('zoom', 'Head', 0, 1.5), k('zoom', 'Tail', 0, 0.8)] }
    const data = fixtureData({ patterns, lensRoam })
    const zoom = rowFor(lensProvider, 1, 'sourceLens.zoom', { kind: 'source', regionId: 100 })
    const at960 = lensProvider.keys(zoom, data).filter((i) => i.tick === 960)
    expect(at960.map((i) => [i.ref.anchor, i.ref.noteStart])).toEqual([['Tail', 0], ['Head', 960]])
    expect(lensProvider.keyAtPlayhead(zoom, data, 960).ref).toMatchObject({ anchor: 'Head', noteStart: 960 })
    const plan = lensProvider.removeKeyPlan(zoom, data, 960)
    expect(plan[0].curve.keys).toEqual([k('zoom', 'Tail', 0, 0.8)])
  })

  it('back-to-back clips: the next clip\'s key, not the earlier clip\'s key past its end', () => {
    const lensRoam = fixtureLensRoam()
    lensRoam.clips = [
      { clipId: 30, lens: LENS_ID, keys: [k('zoom', 'Origin', 0, 1), k('zoom', 'Origin', 3840, 2)] },  // 3840 = its end: outside
      { clipId: 31, lens: LENS_ID, keys: [k('zoom', 'Origin', 0, 3)] },                               // drawn at 3840
    ]
    const data = fixtureData({ lensRoam })
    const zoom = rowFor(lensProvider, 2, 'clipLens.zoom', { kind: 'clip' })
    const at = lensProvider.keyAtPlayhead(zoom, data, 3840)
    expect(at.ref).toMatchObject({ clipId: 31, pos: 0 })
    // Removing at the playhead edits clip 31 (the clip under it).
    expect(lensProvider.removeKeyPlan(zoom, data, 3840)[0]).toMatchObject({ clipId: 31 })
  })
})

describe('key helpers', () => {
  it('upsert an Origin key keeps the interp of the key it replaces', () => {
    const keys = [{ channel: 'zoom', anchor: 'Origin', pos: 10, value: 1, interp: 'Hold' }]
    expect(upsertOriginKey(keys, { channel: 'zoom', pos: 10.2, value: 2 })).toEqual([{ channel: 'zoom', anchor: 'Origin', pos: 10, value: 2, interp: 'Hold' }])
  })

  it('upsert a note key matches anchor and place', () => {
    const keys = [{ channel: 'zoom', anchor: 'Body', pos: 0.5, value: 1, interp: 'Linear' }]
    expect(upsertNoteKey(keys, { channel: 'zoom', anchor: 'Body', pos: 0.50001, value: 3 })).toHaveLength(1)
    expect(upsertNoteKey(keys, { channel: 'zoom', anchor: 'Head', pos: 0.5, value: 3 })).toHaveLength(2)
  })

  it('layer arithmetic follows the blend', () => {
    expect(combineLayer('sourceLens.zoom', 2, 1.5)).toBe(3)
    expect(combineLayer('sourceLens.centerX', 0.5, 0.25)).toBe(0.75)
    expect(layerBetween('sourceLens.zoom', 2, 3)).toBe(1.5)
    expect(layerBetween('sourceLens.rotationDeg', 10, 25)).toBe(15)
  })
})

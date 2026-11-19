import { describe, expect, it } from 'vitest'
import {
  MOTION_INDENT, MOTION_ROW_HEIGHT, PROVIDERS, buildMotionRows, keysInExpandedRows, refTarget, revealTarget,
  rowAtY, rowIndexAtY, rowKeyTicks, rowKeys, summaryTicks, tickRange, visibleRowRange,
} from './rowRegistry.js'
import { fixtureData, fixtureTracks } from './providers/__tests__/fixtures.js'

const data = fixtureData()
const tracks = fixtureTracks()

describe('row registry', () => {
  it('collapsed: one track row per track at the track row height', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set(), trackRowHeight: 28 })
    expect(L.rows.map((r) => r.key)).toEqual(['t:1', 't:2', 't:3', 't:4'])
    expect(L.rows.every((r) => r.kind === 'track' && r.height === 28 && r.depth === 0)).toBe(true)
    expect(L.totalHeight).toBe(4 * 28)
    expect(L.nodes.has('t:1/roam/roam.offsetX')).toBe(true)   // every node is known, visible or not
    expect(PROVIDERS.map((p) => p.id)).toEqual(['lens', 'trail', 'roam', 'sweep', 'fx'])
  })

  it('order per track: Lens, Roam (props, Masks > Mask n), Sweep; depth and 24 px rows', () => {
    const expanded = new Set(['t:1', 't:1/roam', 't:1/roam/masks', 't:1/mask:1'])
    const L = buildMotionRows({ tracks: [tracks[0]], data, expanded, trackRowHeight: 30 })
    expect(L.rows.map((r) => `${r.depth}:${r.label}`)).toEqual([
      '0:Lead', '1:Lens', '1:Roam',
      '2:Offset X', '2:Offset Y', '2:Scale', '2:Link scale', '2:Rotation',
      '2:Crop left', '2:Crop right', '2:Crop top', '2:Crop bottom', '2:Bounds', '2:Layer', '2:Project blur',
      '2:Masks', '3:Mask 1', '4:Shape', '4:Feather', '4:Expansion', '4:Opacity', '4:Mode', '4:Invert',
      '1:Sweep',
    ])
    expect(L.rows[0].height).toBe(30)
    expect(L.rows.slice(1).every((r) => r.height === MOTION_ROW_HEIGHT)).toBe(true)
    expect(L.rows[3].y).toBe(30 + 2 * 24)
    expect(L.totalHeight).toBe(30 + 23 * 24)
    expect(MOTION_INDENT).toBe(14)
    const feather = L.byKey.get('t:1/mask:1/mask.feather')
    expect(feather).toMatchObject({ kind: 'prop', trackId: 1, target: { kind: 'mask', maskId: 1 } })
    expect(feather.parentKey).toBe('t:1/mask:1')
  })

  it('a Clip track has Lens and Roam, no Sweep', () => {
    const L = buildMotionRows({ tracks: [tracks[1]], data, expanded: new Set(['t:2']) })
    expect(L.rows.map((r) => r.label)).toEqual(['Chorus', 'Lens', 'Roam'])
  })

  it('row lookup by y and the visible range', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set(['t:1']), trackRowHeight: 28 })
    // t:1 (0..28), Lens (28..52), Roam (52..76), Sweep (76..100), t:2 (100..128) ...
    expect(rowAtY(L, 0).key).toBe('t:1')
    expect(rowAtY(L, 30).key).toBe('t:1/lens')
    expect(rowAtY(L, 99.9).key).toBe('t:1/sweep')
    expect(rowAtY(L, 100).key).toBe('t:2')
    expect(rowAtY(L, -1)).toBeNull()
    expect(rowAtY(L, L.totalHeight)).toBeNull()
    expect(rowIndexAtY(L, 1e9)).toBe(L.rows.length - 1)
    expect(visibleRowRange(L, 40, 50)).toEqual([1, 4])
  })

  it('keys per row are cached per data object, ticks as a typed array', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set(['t:1', 't:1/roam']) })
    const ox = L.byKey.get('t:1/roam/roam.offsetX')
    const a = rowKeys(ox, data)
    expect(rowKeys(ox, data)).toBe(a)
    expect([...rowKeyTicks(ox, data)]).toEqual([0, 3840])
    expect(rowKeys(ox, fixtureData())).not.toBe(a)
    expect(tickRange(rowKeyTicks(ox, data), 1, 3840)).toEqual([1, 2])
  })

  it('a collapsed track or group summarises every key below it', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set() })
    const t1 = L.byKey.get('t:1')
    // Roam offsetX 0, 3840; Sweep 960; mask feather 0, 3840; hit curve under notes 0, 120, 1920, 2040; Nudge key 1920.
    expect([...summaryTicks(t1, data)]).toEqual([0, 120, 960, 1920, 2040, 3840])
    expect(summaryTicks(t1, data)).toBe(summaryTicks(t1, data))
    expect([...summaryTicks(L.byKey.get('t:4'), data)]).toEqual([])
  })

  it('Ctrl+A collects the keys of expanded property rows only', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set(['t:1', 't:1/roam']) })
    expect(keysInExpandedRows(L, data).map((k) => k.id)).toEqual(['r:1:offsetX:0', 'r:1:offsetX:3840'])
  })

  it('refTarget: one hit key drawn under many notes is one edit target', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set(['t:1', 't:1/lens']) })
    const zoom = L.byKey.get('t:1/lens/sourceLens.zoom')
    const hollow = rowKeys(zoom, data).filter((k) => k.hollow)
    const targets = new Set(hollow.map((k) => refTarget(k.ref)))
    expect(hollow).toHaveLength(4)
    expect(targets.size).toBe(2)
  })

  it('reveal: the row key a path names and every row to open', () => {
    const L = buildMotionRows({ tracks, data, expanded: new Set() })
    expect(revealTarget(L, 1, ['roam'])).toEqual({ rowKey: 't:1/roam', expand: ['t:1', 't:1/roam'] })
    expect(revealTarget(L, 1, ['mask:1'])).toEqual({ rowKey: 't:1/mask:1', expand: ['t:1', 't:1/roam', 't:1/roam/masks', 't:1/mask:1'] })
    expect(revealTarget(L, 3, ['lens'])).toEqual({ rowKey: 't:3/lens:100', expand: ['t:3', 't:3/lens:100'] })
    expect(revealTarget(L, 1, ['roam', 'roam.scale']).rowKey).toBe('t:1/roam/roam.scale')
    expect(revealTarget(L, 1, ['nothing'])).toEqual({ rowKey: 't:1', expand: ['t:1'] })
    expect(revealTarget(L, 99, ['roam'])).toBeNull()
  })
})

// The Edit view's Clone helpers: the layout key (a source and its Clones collapse
// as one group), the track menu items, the delete wording and the drag filter.
import { describe, expect, it, vi } from 'vitest'
import { cloneMenuItems, draggableTrackIds, reelLanesKeyFor, trackRemovalSubject } from './cloneTimeline.js'

const lead = { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1 }
const c1 = { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice' } }
const c2 = { id: 3, name: 'Lead · Clone 2', type: 'Pattern', order: 2, cloneOf: 1, clone: { kind: 'Voice' } }
const t1 = { id: 4, name: 'Lead · Trail 1', type: 'Pattern', order: 3, cloneOf: 1, clone: { kind: 'Trail', delayTicks: 240 } }
const bass = { id: 5, name: 'Bass', type: 'Clip', order: 4, cloneOf: -1 }
const keys = { id: 6, name: 'Keys', type: 'Pattern', order: 5, cloneOf: -1 }
const tracks = [lead, c1, c2, t1, bass, keys]

const labels = (items) => items.filter((i) => i.type !== 'separator').map((i) => i.label)

describe('reelLanesKeyFor', () => {
  const model = { byTrack: new Map([[1, { subRows: 2 }], [2, { subRows: 1 }], [4, { subRows: 2 }], [6, { subRows: 1 }]]) }

  it('a Clone takes its source\'s collapse flag', () => {
    expect(reelLanesKeyFor(model, new Set([1]), tracks)).toBe('1:1:2;2:1:1;4:1:2;6:0:1;')
    expect(reelLanesKeyFor(model, new Set([6]), tracks)).toBe('1:0:2;2:0:1;4:0:2;6:1:1;')
  })

  it('collapsing a Clone id alone does nothing (only the source group collapses)', () => {
    expect(reelLanesKeyFor(model, new Set([2]), tracks)).toBe('1:0:2;2:0:1;4:0:2;6:0:1;')
  })

  it('handles an empty model', () => {
    expect(reelLanesKeyFor({ byTrack: new Map() }, new Set(), tracks)).toBe('')
    expect(reelLanesKeyFor(null, null, null)).toBe('')
  })
})

describe('cloneMenuItems', () => {
  it('a Pattern source offers both kinds of Clone', () => {
    const on = { addClone: vi.fn() }
    const items = cloneMenuItems(keys, tracks, on)
    expect(labels(items)).toEqual(['Add voice clone', 'Add trail clone'])
    items[0].onClick()
    items[1].onClick()
    expect(on.addClone.mock.calls).toEqual([['Voice'], ['Trail']])
  })

  it('a Clip track gets no Clone items', () => {
    expect(cloneMenuItems(bass, tracks, {})).toBeNull()
  })

  it('a Clone: move up / down (disabled at the ends), Inspector, Delete clone; nothing about patterns', () => {
    const first = cloneMenuItems(c1, tracks, {})
    expect(labels(first)).toEqual(['Move clone up', 'Move clone down', 'Show in Inspector', 'Delete clone'])
    expect(first[0].disabled).toBe(true)
    expect(first[1].disabled).toBe(false)
    const last = cloneMenuItems(t1, tracks, {})
    expect(last[0].disabled).toBe(false)
    expect(last[1].disabled).toBe(true)
    const middle = cloneMenuItems(c2, tracks, {})
    expect([middle[0].disabled, middle[1].disabled]).toEqual([false, false])
    expect(first.find((i) => i.label === 'Delete clone').danger).toBe(true)
    for (const word of ['Pattern', 'Convert', 'Hold']) {
      expect(labels(first).some((l) => l.includes(word))).toBe(false)
    }
  })

  it('a Clone\'s items call back with the move direction, the Inspector and delete', () => {
    const on = { moveClone: vi.fn(), showInInspector: vi.fn(), remove: vi.fn() }
    const items = cloneMenuItems(c2, tracks, on).filter((i) => i.type !== 'separator')
    items.forEach((i) => i.onClick())
    expect(on.moveClone.mock.calls).toEqual([[-1], [1]])
    expect(on.showInInspector).toHaveBeenCalledTimes(1)
    expect(on.remove).toHaveBeenCalledTimes(1)
  })
})

describe('trackRemovalSubject', () => {
  it('names the Clones that go with a source', () => {
    expect(trackRemovalSubject(lead, tracks)).toBe('track "Lead" and its 3 clones')
    expect(trackRemovalSubject(lead, [lead, c1])).toBe('track "Lead" and its clone')
    expect(trackRemovalSubject(keys, tracks)).toBe('track "Keys"')
    expect(trackRemovalSubject(c1, tracks)).toBe('track "Lead · Clone 1"')
    expect(trackRemovalSubject(undefined, tracks)).toBe('this track')
  })
})

describe('draggableTrackIds', () => {
  it('drops Clones: they follow their source', () => {
    expect(draggableTrackIds([1, 2, 4, 5], tracks)).toEqual([1, 5])
    expect(draggableTrackIds([2], tracks)).toEqual([])
  })
})

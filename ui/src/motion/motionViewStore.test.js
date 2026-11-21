// motionViewStore: view state saved with the project (toState / loadState, R19)
// and the session state that is never saved.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MOTION_VIEW_STATE_VERSION, ancestorRowKeys, defaultViewState, isDefaultViewState, parseViewState,
  serializeViewState, trackIdOfRowKey, useMotionViewStore,
} from './motionViewStore.js'

const S = () => useMotionViewStore.getState()

beforeEach(() => S().reset({ all: true }))

describe('defaults', () => {
  it('starts in Edit view with the documented heights', () => {
    expect(S().toState()).toEqual({
      v: 1, view: 'edit', graph: false,
      edit: { trackHeight: 36, scrollY: 0 },
      motion: { trackRowHeight: 28, scrollY: 0, headerWidth: 360, expanded: [] },
    })
    expect(isDefaultViewState(S().toState())).toBe(true)
    expect(S().draft).toBeNull()
    expect(S().keySel.size).toBe(0)
    expect(MOTION_VIEW_STATE_VERSION).toBe(1)
  })
})

describe('view, graph, heights, scroll', () => {
  it('view switch (R20) and graph toggle', () => {
    S().toggleView()
    expect(S().view).toBe('motion')
    S().setView('bogus')
    expect(S().view).toBe('motion')
    S().setView('edit')
    expect(S().view).toBe('edit')
    S().toggleGraph()
    expect(S().graph).toBe(true)
    S().setGraph(0)
    expect(S().graph).toBe(false)
  })

  it('per-view heights clamp; scroll is per view', () => {
    S().setEditTrackHeight(500)
    expect(S().edit.trackHeight).toBe(120)
    S().setEditTrackHeight(10)
    expect(S().edit.trackHeight).toBe(24)
    S().setMotionTrackRowHeight(200)
    expect(S().motion.trackRowHeight).toBe(96)
    S().setMotionTrackRowHeight(3)
    expect(S().motion.trackRowHeight).toBe(24)
    S().setHeaderWidth(5000)
    expect(S().motion.headerWidth).toBe(720)
    S().setHeaderWidth(10)
    expect(S().motion.headerWidth).toBe(240)
    S().setScrollY(120.4)
    expect(S().edit.scrollY).toBe(120)
    S().setView('motion')
    S().setScrollY(40)
    expect(S().motion.scrollY).toBe(40)
    expect(S().edit.scrollY).toBe(120)
    S().setMotionScrollY(-5)
    expect(S().motion.scrollY).toBe(0)
  })

  it('a no-op setter does not notify subscribers', () => {
    let n = 0
    const off = useMotionViewStore.subscribe(() => { n++ })
    S().setView('edit')
    S().setGraph(false)
    S().setEditTrackHeight(36)
    S().setExpanded('t:1', false)
    S().clearKeySel()
    S().clearDraft()
    off()
    expect(n).toBe(0)
  })
})

describe('expanded rows', () => {
  it('toggle, expandPath (reveal), collapseTree', () => {
    S().toggleExpanded('t:12')
    expect(S().isExpanded('t:12')).toBe(true)
    S().expandPath('t:12/roam/masks')
    expect([...S().expanded]).toEqual(['t:12', 't:12/roam', 't:12/roam/masks'])
    S().setExpanded('t:12/mask:3', true)
    S().setExpanded('t:13', true)
    S().collapseTree('t:12/roam')
    expect([...S().expanded].sort()).toEqual(['t:12', 't:12/mask:3', 't:13'])
    S().setExpanded('', true)
    expect(S().expanded.has('')).toBe(false)
  })

  it('row key helpers', () => {
    expect(ancestorRowKeys('t:1/roam/masks')).toEqual(['t:1', 't:1/roam'])
    expect(ancestorRowKeys('t:1')).toEqual([])
    expect(trackIdOfRowKey('t:12/roam/roam.offsetX')).toBe(12)
    expect(trackIdOfRowKey('t:7')).toBe(7)
    expect(trackIdOfRowKey('x:7')).toBeNull()
  })
})

describe('row and key selection', () => {
  it('rows: replace, add, toggle; selecting focuses', () => {
    S().selectRow('t:1/roam/roam.scale')
    expect([...S().selectedRows]).toEqual(['t:1/roam/roam.scale'])
    expect(S().focusedRow).toBe('t:1/roam/roam.scale')
    S().selectRow('t:2/roam/roam.scale', 'add')
    expect(S().selectedRows.size).toBe(2)
    S().selectRow('t:1/roam/roam.scale', 'toggle')
    expect([...S().selectedRows]).toEqual(['t:2/roam/roam.scale'])
    S().clearRowSelection()
    expect(S().selectedRows.size).toBe(0)
  })

  it('keys: Map keyId -> ref with replace / add / toggle / remove; prune', () => {
    const a = { trackId: 1, channel: 'scale', pos: 0 }
    const b = { trackId: 1, channel: 'scale', pos: 960 }
    S().selectKeys([['a', a]])
    S().selectKeys([{ id: 'b', ref: b }], 'add')
    expect([...S().keySel.keys()]).toEqual(['a', 'b'])
    expect(S().keySel.get('b')).toBe(b)
    S().selectKeys([['a', a]], 'toggle')
    expect([...S().keySel.keys()]).toEqual(['b'])
    S().selectKeys(new Map([['c', a]]), 'add')
    S().selectKeys([['b', b]], 'remove')
    expect([...S().keySel.keys()]).toEqual(['c'])
    S().pruneKeySel((id) => id !== 'c')
    expect(S().keySel.size).toBe(0)
  })

  it('Escape cancels a draft first, then clears the key selection', () => {
    S().selectKeys([['a', {}]])
    S().setDraft({ trackId: 1, keys: [] })
    expect(S().escape()).toBe('draft')
    expect(S().keySel.size).toBe(1)
    expect(S().escape()).toBe('selection')
    expect(S().keySel.size).toBe(0)
    expect(S().escape()).toBeNull()
  })

  it('selected mask and pen tool', () => {
    S().setSelectedMask({ trackId: 3, maskId: 2, extra: 1 })
    expect(S().selectedMask).toEqual({ trackId: 3, maskId: 2 })
    S().setSelectedMask({ trackId: 3 })
    expect(S().selectedMask).toBeNull()
    S().setPenTool({ trackId: 3, points: [] })
    expect(S().penTool).toEqual({ trackId: 3, points: [] })
  })
})

describe('saved state (toState / loadState)', () => {
  it('round-trips everything it saves', () => {
    S().setView('motion')
    S().setGraph(true)
    S().setEditTrackHeight(48)
    S().setEditScrollY(300)
    S().setMotionTrackRowHeight(40)
    S().setMotionScrollY(80)
    S().setHeaderWidth(400)
    S().expandPath('t:12/mask:3')
    const saved = S().toState()
    expect(saved).toEqual({
      v: 1, view: 'motion', graph: true,
      edit: { trackHeight: 48, scrollY: 300 },
      motion: { trackRowHeight: 40, scrollY: 80, headerWidth: 400, expanded: ['t:12', 't:12/mask:3'] },
    })
    expect(isDefaultViewState(saved)).toBe(false)
    S().reset()
    S().loadState(JSON.parse(JSON.stringify(saved)))
    expect(S().toState()).toEqual(saved)
  })

  it('Motion view never used counts as default even when the Edit view was scrolled / resized (R16 over R19)', () => {
    S().setEditTrackHeight(64)
    S().setEditScrollY(900)
    const editOnly = S().toState()
    expect(editOnly.edit).toEqual({ trackHeight: 64, scrollY: 900 })
    expect(isDefaultViewState(editOnly)).toBe(true)
    // Any Motion view use makes it non-default.
    const d = () => JSON.parse(JSON.stringify(editOnly))
    expect(isDefaultViewState({ ...d(), view: 'motion' })).toBe(false)
    expect(isDefaultViewState({ ...d(), graph: true })).toBe(false)
    expect(isDefaultViewState({ ...d(), motion: { ...d().motion, scrollY: 4 } })).toBe(false)
    expect(isDefaultViewState({ ...d(), motion: { ...d().motion, headerWidth: 400 } })).toBe(false)
    expect(isDefaultViewState({ ...d(), motion: { ...d().motion, trackRowHeight: 40 } })).toBe(false)
    expect(isDefaultViewState({ ...d(), motion: { ...d().motion, expanded: ['t:1'] } })).toBe(false)
  })

  it('is tolerant: garbage, wrong types and out-of-range values take defaults', () => {
    for (const bad of [null, undefined, 42, 'x', [], { v: 'no' }]) {
      S().loadState(bad)
      expect(S().toState()).toEqual(serializeViewState(defaultViewState()))
    }
    S().loadState({
      v: 7, view: 'graph', graph: 'yes', future: { x: 1 },
      edit: { trackHeight: 9999, scrollY: -3 },
      motion: { trackRowHeight: 'big', scrollY: 12.6, headerWidth: 1, expanded: ['t:1', 5, '', null, 'x'.repeat(300), 't:2'] },
    })
    expect(S().toState()).toEqual({
      v: 1, view: 'edit', graph: false,
      edit: { trackHeight: 120, scrollY: 0 },
      motion: { trackRowHeight: 28, scrollY: 13, headerWidth: 240, expanded: ['t:1', 't:2'] },
    })
  })

  it('parseViewState accepts a top-level expanded list too', () => {
    expect([...parseViewState({ expanded: ['t:4'] }).expanded]).toEqual(['t:4'])
  })

  it('loading a project drops the previous session state but keeps the clipboard', () => {
    S().selectKeys([['a', {}]])
    S().selectRow('t:1')
    S().setDraft({ x: 1 })
    S().setSelectedMask({ trackId: 1, maskId: 1 })
    S().setPenTool({ trackId: 1, points: [] })
    S().setClipboard({ keys: [1, 2] })
    S().loadState(null)
    expect(S().keySel.size).toBe(0)
    expect(S().selectedRows.size).toBe(0)
    expect(S().focusedRow).toBeNull()
    expect(S().draft).toBeNull()
    expect(S().selectedMask).toBeNull()
    expect(S().penTool).toBeNull()
    expect(S().clipboard).toEqual({ keys: [1, 2] })
    S().reset({ all: true })
    expect(S().clipboard).toBeNull()
  })

  it('the saved list of expanded rows is capped', () => {
    S().setExpandedRows(Array.from({ length: 5000 }, (_, i) => `t:${i}`))
    expect(S().toState().motion.expanded).toHaveLength(4096)
  })
})

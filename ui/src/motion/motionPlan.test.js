// @vitest-environment jsdom
// motionPlan: a whole gesture's writes collapsed, sent in order inside ONE shared
// undo group, with the right refresh events. window.xleth is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../timelineEvents.js'
import { resetSharedUndoGrouper, withSharedUndoGroup } from '../components/timeline/undoGroup.js'
import { PLAN_KINDS, collapsePlan, planTargetKey, runMotionPlan } from './motionPlan.js'

let log
let events
const onEvent = (e) => events.push([e.type, e.detail ?? null])
const EVENTS = ['lens-roam-changed', 'timeline-patterns-changed', 'timeline-tracks-changed']

function engine({ fail = new Set(), unchanged = new Set() } = {}) {
  let token = 0
  const write = (name, post) => vi.fn(async (...args) => {
    log.push(`${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`)
    if (fail.has(name)) throw new Error(`${name} refused`)
    return { ...post(...args), changed: !unchanged.has(name) }
  })
  return {
    timeline: {
      setTrackRoamKeys: write('setTrackRoamKeys', (trackId, keys) => ({ trackId, roam: { offsetX: 0 }, keys })),
      setTrackRoam: write('setTrackRoam', (trackId, p) => ({ trackId, roam: p })),
      setTrackSweepKeys: write('setTrackSweepKeys', (trackId, keys) => ({ trackId, keys })),
      setClipLensKeys: write('setClipLensKeys', (clipId, keys) => ({ clipId, keys })),
      setClipLens: write('setClipLens', (clipId, p) => ({ clipId, lens: p })),
      setHitCurve: write('setHitCurve', (trackId, regionId, c) => ({ trackId, regionId, hitCurve: c.keys })),
      setTrackLens: write('setTrackLens', (trackId, regionId, p) => ({ trackId, regionId, lens: p })),
      setNotesLensKeys: write('setNotesLensKeys', (entries) => ({ notes: entries })),
      setTrackMasks: write('setTrackMasks', (trackId, masks) => ({ trackId, masks })),
      setTrackParent: write('setTrackParent', (trackId, parentTrackId) => ({ trackId, parentTrackId, roam: {}, keys: [], compensated: [], uncompensated: [] })),
    },
    undo: {
      beginGroup: vi.fn((label) => { token++; log.push(`begin ${label}`); return Promise.resolve(token) }),
      endGroup: vi.fn((t) => { log.push(`end #${t}`); return Promise.resolve(true) }),
    },
  }
}

beforeEach(() => {
  log = []
  events = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resetSharedUndoGrouper()
  window.xleth = engine()
  EVENTS.forEach((t) => timelineEvents.addEventListener(t, onEvent))
})

afterEach(() => {
  EVENTS.forEach((t) => timelineEvents.removeEventListener(t, onEvent))
  vi.restoreAllMocks()
  delete window.xleth
})

const keysA = [{ channel: 'offsetX', anchor: 'Origin', pos: 0, value: 1, interp: 'Linear' }]
const keysB = [{ channel: 'offsetX', anchor: 'Origin', pos: 960, value: 2, interp: 'Linear' }]

describe('collapsePlan', () => {
  it('last write to a target wins and lands where the last one was', () => {
    const plan = [
      { kind: 'roamKeys', trackId: 1, keys: keysA },
      { kind: 'masks', trackId: 1, masks: [] },
      { kind: 'roamKeys', trackId: 2, keys: keysA },
      { kind: 'roamKeys', trackId: 1, keys: keysB },
    ]
    expect(collapsePlan(plan)).toEqual([
      { kind: 'masks', trackId: 1, masks: [] },
      { kind: 'roamKeys', trackId: 2, keys: keysA },
      { kind: 'roamKeys', trackId: 1, keys: keysB },
    ])
  })

  it('patches merge field by field, later fields winning', () => {
    expect(collapsePlan([
      { kind: 'roamBase', trackId: 1, params: { offsetX: 1, scale: 2 } },
      { kind: 'roamBase', trackId: 1, params: { offsetX: 3 } },
      { kind: 'trackLens', trackId: 1, regionId: 4, params: { zoom: 2 } },
      { kind: 'trackLens', trackId: 1, regionId: 5, params: { zoom: 3 } },
      { kind: 'hitCurve', trackId: 1, regionId: 4, curve: { keys: [], zones: { headTicks: 60 } } },
      { kind: 'hitCurve', trackId: 1, regionId: 4, curve: { keys: keysA } },
    ])).toEqual([
      { kind: 'roamBase', trackId: 1, params: { offsetX: 3, scale: 2 } },
      { kind: 'trackLens', trackId: 1, regionId: 4, params: { zoom: 2 } },
      { kind: 'trackLens', trackId: 1, regionId: 5, params: { zoom: 3 } },
      { kind: 'hitCurve', trackId: 1, regionId: 4, curve: { keys: keysA, zones: { headTicks: 60 } } },
    ])
  })

  it('every note write becomes ONE entry list, one entry per note (last wins)', () => {
    expect(collapsePlan([
      { kind: 'notesLensKeys', entries: [{ patternId: 1, noteId: 1, keys: [] }, { patternId: 1, noteId: 2, keys: [] }] },
      { kind: 'roamKeys', trackId: 9, keys: [] },
      { kind: 'notesLensKeys', entries: [{ patternId: 1, noteId: 1, keys: keysA }] },
    ])).toEqual([
      { kind: 'roamKeys', trackId: 9, keys: [] },
      { kind: 'notesLensKeys', entries: [{ patternId: 1, noteId: 2, keys: [] }, { patternId: 1, noteId: 1, keys: keysA }] },
    ])
  })

  it('refuses an unknown kind or a malformed write (before anything is sent)', () => {
    expect(PLAN_KINDS).toEqual(['roamKeys', 'roamBase', 'sweepKeys', 'clipLensKeys', 'clipLens', 'hitCurve', 'trackLens', 'notesLensKeys', 'fxKeys', 'fxBase', 'masks', 'parent', 'cloneSettings'])
    expect(() => planTargetKey({ kind: 'zoomKeys', trackId: 1 })).toThrow(/unknown write kind/)
    expect(() => planTargetKey({ kind: 'roamKeys', keys: [] })).toThrow(/malformed/)
    expect(() => planTargetKey({ kind: 'parent', trackId: 1, parentTrackId: -2 })).toThrow(/malformed/)
    expect(() => planTargetKey({ kind: 'notesLensKeys', entries: [{ patternId: 1, keys: [] }] })).toThrow(/malformed/)
    expect(planTargetKey({ kind: 'parent', trackId: 1, parentTrackId: -1 })).toBe('parent:1')
  })
})

describe('runMotionPlan', () => {
  it('ONE undo group around every write, sent in order, results aligned', async () => {
    const res = await runMotionPlan([
      { kind: 'roamKeys', trackId: 1, keys: keysA },
      { kind: 'sweepKeys', trackId: 2, keys: [] },
      { kind: 'clipLensKeys', clipId: 7, keys: [] },
      { kind: 'masks', trackId: 1, masks: [] },
    ], 'Move keys')
    expect(log).toEqual([
      'begin Move keys',
      `setTrackRoamKeys(1, ${JSON.stringify(keysA)})`,
      'setTrackSweepKeys(2, [])',
      'setClipLensKeys(7, [])',
      'setTrackMasks(1, [])',
      'end #1',
    ])
    expect(res.writes).toHaveLength(4)
    expect(res.results.map((r) => r.trackId ?? r.clipId)).toEqual([1, 2, 7, 1])
    expect(res.changed).toBe(true)
    expect(res.ok).toBe(true)
  })

  it('fires the refresh events of each write', async () => {
    await runMotionPlan([
      { kind: 'roamKeys', trackId: 1, keys: keysA },
      { kind: 'notesLensKeys', entries: [{ patternId: 3, noteId: 4, keys: [] }] },
      { kind: 'parent', trackId: 1, parentTrackId: 2, opts: { keepOnScreen: true, tick: 960 } },
    ])
    const types = events.map(([t]) => t)
    expect(types.filter((t) => t === 'lens-roam-changed')).toHaveLength(2)          // roam keys, parent
    expect(types).toContain('timeline-patterns-changed')
    expect(types).toContain('timeline-tracks-changed')
    expect(events[0][1]).toMatchObject({ trackId: 1, keys: keysA })                  // post-state as detail
    expect(log).toContain('setTrackParent(1, 2, {"keepOnScreen":true,"tick":960})')
  })

  it('a single write goes without a group; an empty plan sends nothing', async () => {
    await runMotionPlan([{ kind: 'roamBase', trackId: 1, params: { scale: 2 } }])
    expect(log).toEqual(['setTrackRoam(1, {"scale":2})'])
    log.length = 0
    const res = await runMotionPlan([])
    expect(log).toEqual([])
    expect(res).toEqual({ writes: [], results: [], rejected: [], changed: false, ok: true })
  })

  it('a refused write: the others still land, the group still closes, ok is false', async () => {
    window.xleth = engine({ fail: new Set(['setTrackMasks']) })
    const res = await runMotionPlan([
      { kind: 'masks', trackId: 1, masks: [] },
      { kind: 'roamKeys', trackId: 1, keys: [] },
    ], 'Paste')
    expect(log[0]).toBe('begin Paste')
    expect(log.at(-1)).toBe('end #1')
    expect(res.results[0]).toBeNull()
    expect(res.results[1]).toMatchObject({ trackId: 1 })
    expect(res.ok).toBe(false)
  })

  it('a semantically rejected write (rejected: cycle) counts as failed; rejected is exposed per write', async () => {
    window.xleth = engine()
    window.xleth.timeline.setTrackParent = vi.fn(async (trackId, parentTrackId) => {
      log.push(`setTrackParent(${trackId}, ${parentTrackId})`)
      return { trackId, parentTrackId: -1, changed: false, roam: {}, keys: [], compensated: [], uncompensated: [], rejected: 'cycle' }
    })
    const res = await runMotionPlan([
      { kind: 'roamKeys', trackId: 1, keys: keysA },
      { kind: 'parent', trackId: 1, parentTrackId: 2 },
    ], 'Attach')
    expect(res.results[1]).toMatchObject({ rejected: 'cycle' })
    expect(res.rejected).toEqual([null, 'cycle'])
    expect(res.ok).toBe(false)
    expect(res.changed).toBe(true)
  })

  it('every write accepted: rejected is all null and ok is true', async () => {
    const res = await runMotionPlan([{ kind: 'parent', trackId: 1, parentTrackId: 2 }])
    expect(res.rejected).toEqual([null])
    expect(res.ok).toBe(true)
  })

  it('nothing changed: no events, changed is false', async () => {
    window.xleth = engine({ unchanged: new Set(['setTrackRoamKeys']) })
    const res = await runMotionPlan([{ kind: 'roamKeys', trackId: 1, keys: [] }, { kind: 'roamKeys', trackId: 2, keys: [] }])
    expect(res.changed).toBe(false)
    expect(events).toEqual([])
  })

  it('a malformed plan throws before any IPC', async () => {
    await expect(runMotionPlan([{ kind: 'roamKeys', trackId: 1, keys: [] }, { kind: 'nope' }])).rejects.toThrow(/unknown write kind/)
    expect(log).toEqual([])
  })

  it('a plan run inside another shared gesture joins its group (one undo entry)', async () => {
    await withSharedUndoGroup('Delete track', async () => {
      await runMotionPlan([{ kind: 'masks', trackId: 1, masks: [] }, { kind: 'parent', trackId: 2, parentTrackId: -1 }], 'Detach')
    })
    expect(log.filter((l) => l.startsWith('begin'))).toEqual(['begin Delete track'])
    expect(log.filter((l) => l.startsWith('end'))).toEqual(['end #1'])
  })
})

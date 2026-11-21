import { describe, expect, it, vi } from 'vitest'
import { LANE_YS, MASTER, cableX, computeCables, masterRail } from '../routingCables.js'
import { drawRouting } from '../RoutingBand.jsx'

const ids = [1, 2, 3, 4, 5]

describe('computeCables', () => {
  it('draws one output cable per track: Master-bound or to another strip', () => {
    const cables = computeCables({ orderedIds: ids, outputRoutes: { 1: -1, 2: 4, 3: -1, 4: -1, 5: -1 } })
    expect(cables.filter((c) => c.to === MASTER).map((c) => c.from)).toEqual([0, 2, 3, 4])
    const bus = cables.find((c) => c.to !== MASTER)
    expect(bus).toMatchObject({ kind: 'output', from: 1, to: 3 })
  })

  it('treats a missing route entry as Master, and never draws to a track that has no strip', () => {
    const cables = computeCables({ orderedIds: [1, 2], outputRoutes: { 1: 99 } })
    expect(cables).toEqual([{ kind: 'output', from: 1, to: MASTER }])
  })

  it('adds sidechain cables only for enabled, healthy routes between visible strips', () => {
    const route = (o) => ({ routeId: 'r', sourceTrackId: 1, targetTrackId: 4, enabled: true, status: 'ok', ...o })
    const cables = computeCables({
      orderedIds: ids,
      outputRoutes: {},
      sidechainRoutes: [
        route({ routeId: 'ok' }),
        route({ routeId: 'off', enabled: false }),
        route({ routeId: 'stale', status: 'stale_target_track' }),
        route({ routeId: 'ghost', targetTrackId: 42 }),
        route({ routeId: 'self', targetTrackId: 1 }),
      ],
    })
    expect(cables.filter((c) => c.kind === 'sidechain').map((c) => c.routeId)).toEqual(['ok'])
  })

  it('puts overlapping track-to-track runs on different lanes and reuses a lane when spans are clear', () => {
    const cables = computeCables({ orderedIds: [1, 2, 3, 4, 5, 6], outputRoutes: { 1: 3, 2: 4, 5: 6 } })
    const lane = (from) => cables.find((c) => c.kind === 'output' && c.from === from).lane
    expect(lane(0)).not.toBe(lane(1)) // 1->3 overlaps 2->4
    expect(lane(4)).toBe(0)           // 5->6 is clear of both
    for (const c of cables.filter((x) => x.to !== MASTER)) expect(LANE_YS[c.lane]).toBeDefined()
  })

  it('runs the Master rail from the leftmost bound strip to the right end', () => {
    const cables = computeCables({ orderedIds: [1, 2, 3], outputRoutes: { 1: 2 } })
    expect(masterRail(cables, 84, 252)).toEqual({ x0: cableX(1, 84), x1: 252, stubs: [cableX(1, 84), cableX(2, 84)] })
    expect(masterRail(computeCables({ orderedIds: [1, 2], outputRoutes: { 1: 2 } }).filter((c) => c.to !== MASTER), 84, 168)).toBeNull()
  })
})

describe('computeCables: multi-wiring', () => {
  it('draws one audio cable per send next to the primary output', () => {
    const cables = computeCables({ orderedIds: [1, 2, 3], outputRoutes: { 1: -1, 2: -1, 3: -1 }, sends: { 1: [{ targetTrackId: 2 }, { targetTrackId: 3 }] } })
    const fromKick = cables.filter((c) => c.from === 0 && c.kind === 'output')
    expect(fromKick.map((c) => c.to)).toEqual([MASTER, 1, 2])
    expect(fromKick.filter((c) => c.send)).toHaveLength(2)
  })

  it('draws one sidechain cable per source/target pair, track-level or effect-level', () => {
    const route = (o) => ({ sourceTrackId: 1, targetTrackId: 2, enabled: true, status: 'ok', ...o })
    const cables = computeCables({
      orderedIds: [1, 2],
      outputRoutes: {},
      sidechainRoutes: [route({ routeId: 'trk', targetEffectInstanceId: '' }), route({ routeId: 'fx', targetEffectInstanceId: 'e1' })],
    })
    expect(cables.filter((c) => c.kind === 'sidechain')).toHaveLength(1)
  })
})

describe('drawRouting', () => {
  const fakeCtx = () => {
    const calls = []
    const ctx = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'calls') return calls
        return (...args) => { calls.push([prop, ...args]) }
      },
      set: (_t, prop, value) => { calls.push(['set:' + prop, value]); return true },
    })
    return ctx
  }

  it('draws audio routes in the audio ink and sidechain keys in the sidechain ink, dims routes away from the selection, and colours the dot by identity', () => {
    const cables = computeCables({
      orderedIds: [1, 2, 3],
      outputRoutes: { 1: -1, 2: -1, 3: -1 },
      sends: { 2: [{ targetTrackId: 3, gain: 1 }] },
      sidechainRoutes: [{ routeId: 'r', sourceTrackId: 1, targetTrackId: 3, enabled: true, status: 'ok' }],
    })
    const ctx = fakeCtx()
    drawRouting(ctx, {
      cables, stripW: 84, width: 252, orderedIds: [1, 2, 3], selectedIndex: 0,
      colors: { audio: 'AUDIO', sidechain: 'KEY', idle: 'IDLE' }, idColors: { 1: 'ID1', 2: 'ID2' },
    })
    const sets = ctx.calls.filter((c) => c[0].startsWith('set:'))
    const strokes = sets.filter((c) => c[0] === 'set:strokeStyle').map((c) => c[1])
    expect(strokes).toContain('AUDIO') // white audio routes (primary + send)
    expect(strokes).toContain('KEY')   // yellow sidechain
    const alphas = sets.filter((c) => c[0] === 'set:globalAlpha').map((c) => c[1])
    expect(alphas).toContain(0.95) // the selected strip's routes
    expect(alphas).toContain(0.4)  // the send 2 -> 3 does not touch the selection
    const fills = sets.filter((c) => c[0] === 'set:fillStyle').map((c) => c[1])
    expect(fills).toEqual(expect.arrayContaining(['ID1', 'ID2', 'IDLE'])) // track 3 has no colour: the idle token
  })

  it('draws nothing but a clear when there are no cables', () => {
    const ctx = fakeCtx()
    drawRouting(ctx, { cables: [], stripW: 84, width: 100, orderedIds: [], colors: { audio: 'A', idle: 'I' }, idColors: {} })
    expect(ctx.calls.some((c) => c[0] === 'stroke' || c[0] === 'fill')).toBe(false)
    expect(ctx.calls[0][0]).toBe('clearRect')
  })
})

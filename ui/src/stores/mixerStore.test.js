import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMixerStoreFixture() {
  return import('./mixerStore.js')
}

function seedTracks(store, tracks, outputRoutes = {}, sidechainRoutes = []) {
  store.setState({
    tracks: Object.fromEntries(tracks.map(track => [track.id, track])),
    trackOrder: tracks.map(track => track.id),
    outputRoutes,
    sidechainRoutes,
    routingError: null,
    sidechainRoutingErrors: {},
  })
}

describe('mixerStore output routing', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.window = {
      xleth: {
        timeline: {
          setTrackOutputRoute: vi.fn(async (_trackId, targetTrackId) => ({ ok: true, targetTrackId })),
          addSidechainRoute: vi.fn(async () => ({ ok: true, routeId: 'route-new' })),
          removeSidechainRoute: vi.fn(async () => ({ ok: true })),
          setSidechainRouteParams: vi.fn(async () => ({ ok: true })),
          getRouting: vi.fn(async () => []),
        },
        audio: {
          setEffectParameter: vi.fn(async () => true),
        },
      },
    }
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('defaults a missing output route to Master', async () => {
    const { default: useMixerStore, MASTER_OUTPUT_TARGET_ID } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [{ id: 1, name: 'Track A' }])

    expect(useMixerStore.getState().getTrackOutputRoute(1)).toEqual({
      targetTrackId: MASTER_OUTPUT_TARGET_ID,
    })
  })

  it('setOutputRoute success updates state', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Track A' },
      { id: 2, name: 'Bus' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setOutputRoute(1, 2)

    expect(result).toMatchObject({ ok: true, targetTrackId: 2 })
    expect(window.xleth.timeline.setTrackOutputRoute).toHaveBeenCalledWith(1, 2)
    expect(useMixerStore.getState().outputRoutes[1]).toBe(2)
  })

  it('setOutputRoute rejection rolls back, refetches routing, and records an error', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    window.xleth.timeline.setTrackOutputRoute.mockResolvedValueOnce({ ok: false, reason: 'cycle' })
    window.xleth.timeline.getRouting.mockResolvedValueOnce([
      { trackId: 1, outputRoute: { targetTrackId: -1 } },
      { trackId: 2, outputRoute: { targetTrackId: -1 } },
    ])
    seedTracks(useMixerStore, [
      { id: 1, name: 'Track A' },
      { id: 2, name: 'Bus' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setOutputRoute(1, 2)

    expect(result).toMatchObject({ ok: false, reason: 'cycle' })
    expect(useMixerStore.getState().outputRoutes[1]).toBe(-1)
    expect(useMixerStore.getState().routingError).toBe('Would create feedback loop')
    expect(window.xleth.timeline.getRouting).toHaveBeenCalledTimes(1)
  })

  it('thrown IPC error rolls back', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    window.xleth.timeline.setTrackOutputRoute.mockRejectedValueOnce(new Error('ipc failed'))
    window.xleth.timeline.getRouting.mockResolvedValueOnce([
      { trackId: 1, outputRoute: { targetTrackId: -1 } },
      { trackId: 2, outputRoute: { targetTrackId: -1 } },
    ])
    seedTracks(useMixerStore, [
      { id: 1, name: 'Track A' },
      { id: 2, name: 'Bus' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setOutputRoute(1, 2)

    expect(result).toMatchObject({ ok: false, reason: 'ipc_error' })
    expect(useMixerStore.getState().outputRoutes[1]).toBe(-1)
    expect(useMixerStore.getState().routingError).toBe('Route rejected')
  })

  it('getBusInputCount counts source tracks targeting a bus and ignores Master/default', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Track A' },
      { id: 2, name: 'Bus' },
      { id: 3, name: 'Track C' },
    ], { 1: 2, 2: -1, 3: -1 })

    expect(useMixerStore.getState().getBusInputCount(2)).toBe(1)
    expect(useMixerStore.getState().getBusInputCount(-1)).toBe(0)
  })

  it('eligible targets exclude self and cycle-causing descendants', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Track A' },
      { id: 2, name: 'Bus A' },
      { id: 3, name: 'Bus B' },
    ], { 1: -1, 2: 3, 3: -1 })

    const targetIds = useMixerStore.getState().getEligibleOutputTargets(3).map(t => t.targetTrackId)

    expect(targetIds).toContain(-1)
    expect(targetIds).toContain(1)
    expect(targetIds).not.toContain(3)
    expect(targetIds).not.toContain(2)
  })

  it('stale or missing route targets do not crash helper lookups', async () => {
    const {
      default: useMixerStore,
      wouldCreateOutputRouteCycle,
    } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [{ id: 1, name: 'Track A' }], { 1: 99 })

    expect(() => useMixerStore.getState().getEligibleOutputTargets(1)).not.toThrow()
    expect(useMixerStore.getState().getTrackOutputRoute(1)).toEqual({ targetTrackId: 99 })
    expect(wouldCreateOutputRouteCycle({ 1: 99 }, 2, 1)).toBe(false)
  })

  it('finds an existing sidechain route for a compressor and preserves stale status', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 }, [{
      routeId: 'route-1',
      sourceTrackId: 1,
      targetTrackId: 2,
      targetEffectInstanceId: 'cmp-1',
      gain: 1,
      preFader: false,
      enabled: true,
      status: 'stale_effect_instance',
    }])

    expect(useMixerStore.getState().getSidechainRouteForEffect(2, 'cmp-1')).toMatchObject({
      routeId: 'route-1',
      sourceTrackId: 1,
      status: 'stale_effect_instance',
    })
  })

  it('adding a source sets sc_external and creates the sidechain route payload', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    let routing = [
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ]
    window.xleth.timeline.getRouting.mockImplementation(async () => routing)
    window.xleth.timeline.addSidechainRoute.mockImplementation(async (sourceTrackId, payload) => {
      routing = routing.map((entry) => entry.trackId === sourceTrackId
        ? {
            ...entry,
            sidechainRoutes: [{
              routeId: 'route-1',
              sourceTrackId,
              ...payload,
              status: 'ok',
            }],
          }
        : entry)
      return { ok: true, routeId: 'route-1' }
    })
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: 1,
    })

    expect(result).toMatchObject({ ok: true, externalEnabled: true, routeId: 'route-1' })
    expect(window.xleth.audio.setEffectParameter).toHaveBeenCalledWith(2, 44, 'sc_external', 1)
    expect(window.xleth.timeline.addSidechainRoute).toHaveBeenCalledWith(1, {
      targetTrackId: 2,
      targetEffectInstanceId: 'cmp-1',
      gain: 1.0,
      preFader: false,
      enabled: true,
    })
    expect(useMixerStore.getState().getSidechainRouteForEffect(2, 'cmp-1')).toMatchObject({
      sourceTrackId: 1,
      routeId: 'route-1',
    })
  })

  it('treats legacy false setEffectParameter result as successful external mode write', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    window.xleth.audio.setEffectParameter.mockResolvedValueOnce(false)
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: null,
    })

    expect(result).toMatchObject({ ok: true, externalEnabled: true, route: null })
    expect(window.xleth.audio.setEffectParameter).toHaveBeenCalledWith(2, 44, 'sc_external', 1)
    expect(window.xleth.timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(useMixerStore.getState().getSidechainErrorForEffect(2, 'cmp-1')).toBeNull()
  })

  it('selecting None removes the existing sidechain route while keeping external mode enabled', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    let routing = [
      {
        trackId: 1,
        outputRoute: { targetTrackId: -1 },
        sidechainRoutes: [{
          routeId: 'route-1',
          sourceTrackId: 1,
          targetTrackId: 2,
          targetEffectInstanceId: 'cmp-1',
          gain: 1,
          preFader: false,
          enabled: true,
          status: 'ok',
        }],
      },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ]
    window.xleth.timeline.getRouting.mockImplementation(async () => routing)
    window.xleth.timeline.removeSidechainRoute.mockImplementation(async (sourceTrackId, routeId) => {
      routing = routing.map((entry) => entry.trackId === sourceTrackId
        ? { ...entry, sidechainRoutes: entry.sidechainRoutes.filter(route => route.routeId !== routeId) }
        : entry)
      return { ok: true }
    })
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 }, routing[0].sidechainRoutes)

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: null,
    })

    expect(result).toMatchObject({ ok: true, externalEnabled: true, route: null })
    expect(window.xleth.audio.setEffectParameter).toHaveBeenCalledWith(2, 44, 'sc_external', 1)
    expect(window.xleth.timeline.removeSidechainRoute).toHaveBeenCalledWith(1, 'route-1')
    expect(window.xleth.timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(useMixerStore.getState().getSidechainRouteForEffect(2, 'cmp-1')).toBeNull()
  })

  it('switching sources removes the old route and adds the new source route', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    let routing = [
      {
        trackId: 1,
        outputRoute: { targetTrackId: -1 },
        sidechainRoutes: [{
          routeId: 'route-1',
          sourceTrackId: 1,
          targetTrackId: 2,
          targetEffectInstanceId: 'cmp-1',
          gain: 1,
          preFader: false,
          enabled: true,
          status: 'ok',
        }],
      },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 3, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ]
    window.xleth.timeline.getRouting.mockImplementation(async () => routing)
    window.xleth.timeline.removeSidechainRoute.mockImplementation(async (sourceTrackId, routeId) => {
      routing = routing.map((entry) => entry.trackId === sourceTrackId
        ? { ...entry, sidechainRoutes: entry.sidechainRoutes.filter(route => route.routeId !== routeId) }
        : entry)
      return { ok: true }
    })
    window.xleth.timeline.addSidechainRoute.mockImplementation(async (sourceTrackId, payload) => {
      routing = routing.map((entry) => entry.trackId === sourceTrackId
        ? {
            ...entry,
            sidechainRoutes: [{
              routeId: 'route-2',
              sourceTrackId,
              ...payload,
              status: 'ok',
            }],
          }
        : entry)
      return { ok: true, routeId: 'route-2' }
    })
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
      { id: 3, name: 'Snare' },
    ], { 1: -1, 2: -1, 3: -1 }, routing[0].sidechainRoutes)

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: 3,
    })

    expect(result).toMatchObject({ ok: true, externalEnabled: true, routeId: 'route-2' })
    expect(window.xleth.timeline.removeSidechainRoute).toHaveBeenCalledWith(1, 'route-1')
    expect(window.xleth.timeline.addSidechainRoute).toHaveBeenCalledWith(3, expect.objectContaining({
      targetTrackId: 2,
      targetEffectInstanceId: 'cmp-1',
    }))
    expect(useMixerStore.getState().getSidechainRouteForEffect(2, 'cmp-1')).toMatchObject({
      routeId: 'route-2',
      sourceTrackId: 3,
    })
  })

  it('rejected add refetches routing and records readable error copy', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    window.xleth.timeline.addSidechainRoute.mockResolvedValueOnce({ ok: false, reason: 'cycle' })
    window.xleth.timeline.getRouting.mockResolvedValueOnce([
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ])
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: 1,
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'cycle',
      error: 'Would create feedback loop',
      externalEnabled: true,
    })
    expect(useMixerStore.getState().getSidechainErrorForEffect(2, 'cmp-1')).toBe('Would create feedback loop')
    expect(window.xleth.timeline.getRouting).toHaveBeenCalledTimes(1)
  })

  it('setEffectParameter rejection reports compressor mode error instead of route rejection', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    window.xleth.audio.setEffectParameter.mockRejectedValueOnce(new Error('ipc failed'))
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: 1,
    }, { warn: vi.fn() })

    expect(result).toMatchObject({
      ok: false,
      reason: 'ipc_error',
      error: 'Could not update compressor sidechain mode',
      externalEnabled: false,
    })
    expect(window.xleth.timeline.addSidechainRoute).not.toHaveBeenCalled()
    expect(useMixerStore.getState().getSidechainErrorForEffect(2, 'cmp-1')).toBe('Could not update compressor sidechain mode')
  })

  it('missing effect instance rejects without touching route or parameter APIs', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 })

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: '',
      enabled: true,
      sourceTrackId: 1,
    })

    expect(result).toMatchObject({ ok: false, reason: 'empty_effect_instance' })
    expect(window.xleth.audio.setEffectParameter).not.toHaveBeenCalled()
    expect(window.xleth.timeline.addSidechainRoute).not.toHaveBeenCalled()
  })

  it('turning external sidechain off sets sc_external to zero and removes the route', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    let routing = [
      {
        trackId: 1,
        outputRoute: { targetTrackId: -1 },
        sidechainRoutes: [{
          routeId: 'route-1',
          sourceTrackId: 1,
          targetTrackId: 2,
          targetEffectInstanceId: 'cmp-1',
          gain: 1,
          preFader: false,
          enabled: true,
          status: 'ok',
        }],
      },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ]
    window.xleth.timeline.getRouting.mockImplementation(async () => routing)
    window.xleth.timeline.removeSidechainRoute.mockImplementation(async (sourceTrackId, routeId) => {
      routing = routing.map((entry) => entry.trackId === sourceTrackId
        ? { ...entry, sidechainRoutes: entry.sidechainRoutes.filter(route => route.routeId !== routeId) }
        : entry)
      return { ok: true }
    })
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 }, routing[0].sidechainRoutes)

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: false,
    })

    expect(result).toMatchObject({ ok: true, externalEnabled: false, route: null })
    expect(window.xleth.audio.setEffectParameter).toHaveBeenCalledWith(2, 44, 'sc_external', 0)
    expect(window.xleth.timeline.removeSidechainRoute).toHaveBeenCalledWith(1, 'route-1')
    expect(useMixerStore.getState().getSidechainRouteForEffect(2, 'cmp-1')).toBeNull()
  })

  it('route remove failure reports route-remove-specific error copy', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    const route = {
      routeId: 'route-1',
      sourceTrackId: 1,
      targetTrackId: 2,
      targetEffectInstanceId: 'cmp-1',
      gain: 1,
      preFader: false,
      enabled: true,
      status: 'ok',
    }
    window.xleth.timeline.removeSidechainRoute.mockResolvedValueOnce({ ok: false, reason: 'unknown_source_track' })
    window.xleth.timeline.getRouting.mockResolvedValueOnce([
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [route] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ])
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 }, [route])

    const result = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: false,
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'unknown_source_track',
      error: 'Could not remove sidechain route',
      externalEnabled: false,
    })
    expect(window.xleth.audio.setEffectParameter).toHaveBeenCalledWith(2, 44, 'sc_external', 0)
    expect(useMixerStore.getState().getSidechainErrorForEffect(2, 'cmp-1')).toBe('Could not remove sidechain route')
  })

  it('handles absent or throwing sidechain route APIs without crashing', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Bass' },
    ], { 1: -1, 2: -1 })
    delete window.xleth.timeline.addSidechainRoute

    const absentResult = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: 1,
    })

    expect(absentResult).toMatchObject({ ok: false, reason: 'engine_unavailable', error: 'Route rejected' })

    window.xleth.timeline.addSidechainRoute = vi.fn(async () => { throw new Error('boom') })
    window.xleth.timeline.getRouting.mockResolvedValueOnce([
      { trackId: 1, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
      { trackId: 2, outputRoute: { targetTrackId: -1 }, sidechainRoutes: [] },
    ])
    const thrownResult = await useMixerStore.getState().setCompressorExternalSidechain({
      targetTrackId: 2,
      targetNodeId: 44,
      effectInstanceId: 'cmp-1',
      enabled: true,
      sourceTrackId: 1,
    }, { warn: vi.fn() })

    expect(thrownResult).toMatchObject({ ok: false, reason: 'ipc_error', error: 'Route rejected' })
  })

  it('eligible sidechain sources exclude self, visual-only tracks, and output-route cycles', async () => {
    const { default: useMixerStore } = await loadMixerStoreFixture()
    seedTracks(useMixerStore, [
      { id: 1, name: 'Kick', visualOnly: false },
      { id: 2, name: 'Bass', visualOnly: false },
      { id: 3, name: 'Visual', visualOnly: true },
      { id: 4, name: 'Bus', visualOnly: false },
    ], { 1: -1, 2: 4, 3: -1, 4: -1 })

    const sources = useMixerStore.getState().getEligibleSidechainSources(2)
      .map(source => source.name)

    expect(sources).toContain('Kick')
    expect(sources).not.toContain('Bass')
    expect(sources).not.toContain('Visual')
    expect(sources).not.toContain('Bus')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMixerStoreFixture() {
  return import('./mixerStore.js')
}

function seedTracks(store, tracks, outputRoutes = {}) {
  store.setState({
    tracks: Object.fromEntries(tracks.map(track => [track.id, track])),
    trackOrder: tracks.map(track => track.id),
    outputRoutes,
    routingError: null,
  })
}

describe('mixerStore output routing', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.window = {
      xleth: {
        timeline: {
          setTrackOutputRoute: vi.fn(async (_trackId, targetTrackId) => ({ ok: true, targetTrackId })),
          getRouting: vi.fn(async () => []),
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
})

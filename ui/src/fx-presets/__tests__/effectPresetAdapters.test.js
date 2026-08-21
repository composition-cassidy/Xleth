import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPresetAdapter, defaultAdapter, apexAdapter, xformAdapter } from '../effectPresetAdapters.js'

const target = { trackId: 3, nodeId: 7, storeKey: '3' }

function installAudio(audio) {
  globalThis.window = { xleth: { audio } }
}

function installTimeline(timeline) {
  globalThis.window = { xleth: { timeline } }
}

afterEach(() => { delete globalThis.window })

describe('getPresetAdapter', () => {
  it('returns the apex adapter for apex, the default otherwise', () => {
    expect(getPresetAdapter('apex')).toBe(apexAdapter)
    expect(getPresetAdapter('compressor')).toBe(defaultAdapter)
    expect(getPresetAdapter('some-future-effect')).toBe(defaultAdapter)
  })

  it('returns the xform adapter for xform', () => {
    expect(getPresetAdapter('xform')).toBe(xformAdapter)
  })
})

describe('default adapter', () => {
  it('captures the full scalar param list into a { params } blob', async () => {
    installAudio({
      getEffectParameters: vi.fn(async () => JSON.stringify([
        { id: 'threshold', value: -18 }, { id: 'ratio', value: 2 }, { id: 'ignored' },
      ])),
    })
    const state = await defaultAdapter.captureState(target)
    expect(state).toEqual({ params: { threshold: -18, ratio: 2 } })
  })

  it('applies each finite param via setEffectParameter', async () => {
    const setEffectParameter = vi.fn()
    installAudio({ setEffectParameter })
    await defaultAdapter.applyState(target, { params: { threshold: -20, ratio: 4, bad: NaN } })
    expect(setEffectParameter).toHaveBeenCalledWith(3, 7, 'threshold', -20)
    expect(setEffectParameter).toHaveBeenCalledWith(3, 7, 'ratio', 4)
    expect(setEffectParameter).not.toHaveBeenCalledWith(3, 7, 'bad', expect.anything())
    expect(setEffectParameter).toHaveBeenCalledTimes(2)
  })
})

describe('apex adapter', () => {
  it('captures params AND per-band curves', async () => {
    installAudio({
      getEffectParameters: vi.fn(async () => [{ id: 'bandmix', value: 90 }]),
      apexGetCurves: vi.fn(async () => JSON.stringify({
        bands: [
          { band: 3, nodes: [{ in: -24, out: -24 }, { in: 12, out: 6 }], tensions: [0.5] },
          { band: 0, nodes: [{ in: -24, out: -24 }], tensions: [] }, // <2 nodes -> dropped
        ],
      })),
    })
    const state = await apexAdapter.captureState(target)
    expect(state.params).toEqual({ bandmix: 90 })
    expect(state.curves).toEqual([
      { band: 3, nodes: [{ in: -24, out: -24 }, { in: 12, out: 6 }], tensions: [0.5] },
    ])
  })

  it('applies params then each band curve as one JSON blob', async () => {
    const setEffectParameter = vi.fn()
    const apexSetBandCurve = vi.fn()
    installAudio({ setEffectParameter, apexSetBandCurve })
    await apexAdapter.applyState(target, {
      params: { bandmix: 77 },
      curves: [
        { band: 3, nodes: [{ in: -24, out: -24 }, { in: 12, out: 6 }], tensions: [0.5] },
        { band: 1, nodes: [{ in: -24, out: -24 }], tensions: [] }, // dropped: <2 nodes
      ],
    })
    expect(setEffectParameter).toHaveBeenCalledWith(3, 7, 'bandmix', 77)
    expect(apexSetBandCurve).toHaveBeenCalledTimes(1)
    expect(apexSetBandCurve).toHaveBeenCalledWith(
      3, 7, 3,
      JSON.stringify({ nodes: [{ in: -24, out: -24 }, { in: 12, out: 6 }], tensions: [0.5] }),
    )
  })
})

describe('xform adapter', () => {
  const zpr = {
    tracks: {
      panX: { constantValue: 0, keys: [{ t: 0, v: 0.1, c: [1 / 3, 1 / 3, 2 / 3, 2 / 3] }] },
      panY: { constantValue: 0, keys: [] },
      zoomLog2: { constantValue: 0, keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
      rotationDeg: { constantValue: 0, keys: [] },
    },
    durationMs: 180,
    lengthMode: 0,
    musicalDivision: 2,
    notePercentage: 100,
    onEndMode: 1,
    retriggerMode: 2,
    retriggerCrossfadeMs: 75,
    enabled: true,
    startZoom: 1, targetZoom: 1,  // legacy scalars — must survive an applyState round-trip untouched
  }
  const target = { trackId: 12, zpr, nodeId: 12, storeKey: 'xform' }

  it('captureState reads target.zpr directly — no engine round-trip', async () => {
    // No window.xleth installed at all: a round-trip adapter would throw or
    // return an empty blob. captureState must still succeed because the data
    // is already in `target`.
    delete globalThis.window
    const state = await xformAdapter.captureState(target)
    expect(state.tracks.panX.keys).toEqual([{ t: 0, v: 0.1, c: [1 / 3, 1 / 3, 2 / 3, 2 / 3] }])
    expect(state.tracks.panY.keys).toEqual([])
    expect(state.durationMs).toBe(180)
    expect(state.onEndMode).toBe(1)
    expect(state.retriggerMode).toBe(2)
    expect(state.retriggerCrossfadeMs).toBe(75)
  })

  it('applyState writes scalars via setTrackZoomPanRotSettings THEN tracks via setTrackZprTracks', async () => {
    const calls = []
    const setTrackZoomPanRotSettings = vi.fn(async (...args) => calls.push(['scalars', ...args]))
    const setTrackZprTracks = vi.fn(async (...args) => calls.push(['tracks', ...args]))
    installTimeline({ setTrackZoomPanRotSettings, setTrackZprTracks })

    const state = await xformAdapter.captureState(target)
    // Different target (current track state) than the preset being applied —
    // legacy scalars (startZoom etc.) from the CURRENT track must be preserved.
    const currentZpr = { ...zpr, startZoom: 3, targetZoom: 5, onEndMode: 0 }
    await xformAdapter.applyState({ trackId: 12, zpr: currentZpr }, state)

    expect(calls[0][0]).toBe('scalars')
    expect(calls[1][0]).toBe('tracks')
    const [, trackId, written] = calls[0]
    expect(trackId).toBe(12)
    expect(written.enabled).toBe(true)
    expect(written.startZoom).toBe(3)     // preserved from current, not overwritten
    expect(written.targetZoom).toBe(5)
    expect(written.durationMs).toBe(180)  // from the preset
    expect(written.onEndMode).toBe(1)     // from the preset, overriding current's 0

    const [, , writtenTracks] = calls[1]
    expect(writtenTracks.panX.keys).toEqual([{ t: 0, v: 0.1, c: [1 / 3, 1 / 3, 2 / 3, 2 / 3] }])
  })

  it('applyState defaults a missing curve to identity rather than leaving it undefined', async () => {
    const setTrackZoomPanRotSettings = vi.fn()
    const setTrackZprTracks = vi.fn()
    installTimeline({ setTrackZoomPanRotSettings, setTrackZprTracks })

    await xformAdapter.applyState(
      { trackId: 1, zpr: {} },
      { tracks: { panX: { constantValue: 0, keys: [{ t: 0, v: 1 }] }, panY: {}, zoomLog2: {}, rotationDeg: {} } },
    )
    const written = setTrackZprTracks.mock.calls[0][1]
    expect(written.panX.keys[0].c).toEqual([1 / 3, 1 / 3, 2 / 3, 2 / 3])
    expect(written.panX.keys[0].c).not.toBeUndefined()
  })
})

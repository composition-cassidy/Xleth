import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPresetAdapter, defaultAdapter, apexAdapter } from '../effectPresetAdapters.js'

const target = { trackId: 3, nodeId: 7, storeKey: '3' }

function installAudio(audio) {
  globalThis.window = { xleth: { audio } }
}

afterEach(() => { delete globalThis.window })

describe('getPresetAdapter', () => {
  it('returns the apex adapter for apex, the default otherwise', () => {
    expect(getPresetAdapter('apex')).toBe(apexAdapter)
    expect(getPresetAdapter('compressor')).toBe(defaultAdapter)
    expect(getPresetAdapter('some-future-effect')).toBe(defaultAdapter)
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

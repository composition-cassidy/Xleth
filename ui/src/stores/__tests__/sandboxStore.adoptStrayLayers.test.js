import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: the engine kept a layer ("BGM 1 [Instrumental]") that the store
// never learned about (renderer reload raced an openTarget, so the panel's
// mount-time resync was skipped). The engine refuses to mix while any layer is
// unrendered, so every composite failed with 'layer "BGM..." not rendered yet'
// and Sandbox preview was dead until restart. The store must adopt the stray,
// render it, and retry.

vi.mock('../../components/sandbox/sandboxPreviewPlayer.js', () => ({
  playSandboxPreview: vi.fn(() => true),
  stopSandboxPreview: vi.fn(),
}))

const FLOAT_BYTES = Buffer.from(new Float32Array([0, 0]).buffer)

function baseLayer(overrides = {}) {
  return {
    id: 1, name: 'Quote 18', sourceBufferId: 5, bufferSampleRate: 48000,
    sourceFilePath: null, sourceStartTime: null, sourceEndTime: null,
    sourceRegionId: null, swapTargetName: null,
    ops: [], muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
    renderState: 'ready', renderedBuffer: null,
    bakeState: 'idle', swapInState: 'idle', swapInError: null, lastSwap: null, error: null,
    ...overrides,
  }
}

const WORKSPACE = {
  layers: [
    { id: 1, name: 'Quote 18', sourceBufferId: 5, bufferSampleRate: 48000, ops: [] },
    { id: 2, name: 'BGM 1 [Instrumental]', sourceBufferId: 6, bufferSampleRate: 48000, ops: [] },
  ],
}

async function loadStore(sandboxBridge) {
  vi.resetModules()
  globalThis.window = { xleth: { sandbox: sandboxBridge } }
  const mod = await import('../sandboxStore.js')
  return mod.default
}

describe('sandboxStore stray engine layers', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('adoptUnknownEngineLayers adds only unseen layers and renders them', async () => {
    const render = vi.fn(async () => ({ success: true, queued: true, pending: false }))
    const store = await loadStore({
      getWorkspace: vi.fn(async () => JSON.stringify(WORKSPACE)),
      render,
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
      })),
    })
    store.setState({ layers: [baseLayer()], activeLayerId: 1 })

    const n = await store.getState().adoptUnknownEngineLayers()

    expect(n).toBe(1)
    expect(store.getState().layers.map((l) => l.id)).toEqual([1, 2])
    expect(store.getState().activeLayerId).toBe(1) // active layer untouched
    expect(render).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith(2, 'adopt')
    // Second call is a no-op.
    expect(await store.getState().adoptUnknownEngineLayers()).toBe(0)
  })

  it('composite failing on an unseen layer adopts it, waits, and retries', async () => {
    let attempt = 0
    const store = await loadStore({
      getWorkspace: vi.fn(async () => JSON.stringify(WORKSPACE)),
      render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
      })),
      renderComposite: vi.fn(async () => {
        attempt += 1
        return attempt === 1
          ? { ready: false, reason: 'layer "BGM 1 [Instrumental]" not rendered yet' }
          : { ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 2, data: FLOAT_BYTES }
      }),
    })
    store.setState({ layers: [baseLayer()], activeLayerId: 1 })

    const res = await store.getState()._fetchCompositeRender()

    expect(attempt).toBe(2)
    expect(res.layersMixed).toBe(2)
    expect(store.getState().layers).toHaveLength(2)
  })

  it('still fails when nothing is adoptable', async () => {
    const store = await loadStore({
      getWorkspace: vi.fn(async () => JSON.stringify({ layers: [WORKSPACE.layers[0]] })),
      renderComposite: vi.fn(async () => ({ ready: false, reason: 'layer "X" not rendered yet' })),
    })
    store.setState({ layers: [baseLayer()], activeLayerId: 1 })
    await expect(store.getState()._fetchCompositeRender()).rejects.toThrow('not rendered yet')
  })
})

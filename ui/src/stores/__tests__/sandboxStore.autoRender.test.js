import { beforeEach, describe, expect, it, vi } from 'vitest'

// Smoke coverage for the composite auto-render pipeline added to fix "Play
// doesn't reflect an edit until RE-RENDER is clicked": every accepted
// op-stack mutation should debounce a composite re-render (~150ms, reset by
// each new edit), a render already in flight when a newer edit lands should
// be discarded rather than published, and Play should wait for the freshest
// render instead of handing the transport a stale buffer.

vi.mock('../../components/sandbox/sandboxPreviewPlayer.js', () => ({
  playSandboxPreview: vi.fn(() => true),
  stopSandboxPreview: vi.fn(),
}))

const FLOAT_BYTES = Buffer.from(new Float32Array([0, 0]).buffer)

function baseLayer(overrides = {}) {
  return {
    id: 1, name: 'L1', sourceBufferId: 5, bufferSampleRate: 48000,
    sourceFilePath: null, sourceStartTime: null, sourceEndTime: null,
    sourceRegionId: null, swapTargetName: null,
    ops: [], muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
    renderState: 'ready', renderedBuffer: null,
    bakeState: 'idle', swapInState: 'idle', swapInError: null, lastSwap: null, error: null,
    ...overrides,
  }
}

async function loadStore(sandboxBridge) {
  vi.resetModules()
  globalThis.window = { xleth: { sandbox: sandboxBridge } }
  const mod = await import('../sandboxStore.js')
  return mod.default
}

function makeGainOp(gainDb) {
  return { type: 'gain', params: { startSample: 0, endSample: -1, gainDb, normalize: false, targetPeakDb: 0 } }
}

describe('sandboxStore composite auto-render', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('collapses a burst of op-stack edits into exactly one composite render', async () => {
    let compositeCalls = 0
    const useSandboxStore = await loadStore({
      stackAdd: vi.fn(async () => ({ success: true, opId: Math.floor(Math.random() * 1e6) })),
      render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
      })),
      renderComposite: vi.fn(async () => {
        compositeCalls += 1
        return { ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES }
      }),
      getHistory: vi.fn(async () => ({})),
    })

    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    // Five edits fired back-to-back, well inside the 150ms debounce window.
    for (let i = 0; i < 5; i++) {
      await useSandboxStore.getState().addOp(1, makeGainOp(i))
    }
    expect(useSandboxStore.getState().compositeAutoRender.scheduledCount).toBe(5)
    expect(compositeCalls).toBe(0) // nothing has fired yet — still debouncing

    await new Promise((resolve) => setTimeout(resolve, 400))

    const state = useSandboxStore.getState()
    expect(compositeCalls).toBe(1) // the burst collapsed into one RPC call
    expect(state.compositeAutoRender.ranCount).toBe(1)
    expect(state.composite.renderState).toBe('ready')
    expect(state.composite.renderedBuffer).toBeTruthy()
  })

  it('discards a composite render superseded by a newer edit while waiting on layers', async () => {
    let compositeCalls = 0
    let unblockLayerRender
    const layerGate = new Promise((resolve) => { unblockLayerRender = resolve })

    const useSandboxStore = await loadStore({
      stackAdd: vi.fn(async () => ({ success: true, opId: Math.floor(Math.random() * 1e6) })),
      render: vi.fn(async () => ({ success: true, queued: true, pending: true })),
      getRenderedBuffer: vi.fn(async () => {
        await layerGate // the layer's own render never completes until the test unblocks it
        return { ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES }
      }),
      renderComposite: vi.fn(async () => {
        compositeCalls += 1
        return { ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: compositeCalls, data: FLOAT_BYTES }
      }),
      getHistory: vi.fn(async () => ({})),
    })

    useSandboxStore.setState({ layers: [baseLayer({ renderState: 'idle' })], activeLayerId: 1 })

    await useSandboxStore.getState().addOp(1, makeGainOp(1)) // edit #1 — layer render blocks on the gate
    await new Promise((resolve) => setTimeout(resolve, 200)) // past the 150ms debounce: gen#1 is now waiting on the layer

    await useSandboxStore.getState().addOp(1, makeGainOp(2)) // edit #2 lands mid-wait — supersedes gen#1
    await new Promise((resolve) => setTimeout(resolve, 100)) // gen#1's poll loop notices staleness

    expect(useSandboxStore.getState().compositeAutoRender.supersededCount).toBeGreaterThanOrEqual(1)
    expect(useSandboxStore.getState().compositeAutoRender.ranCount).toBe(0) // nothing has been published yet
    expect(compositeCalls).toBe(0) // gen#1 never even reached the mix RPC

    unblockLayerRender()
    await new Promise((resolve) => setTimeout(resolve, 300)) // gen#2's debounce + layer-settle + RPC

    const state = useSandboxStore.getState()
    expect(compositeCalls).toBe(1) // only the surviving generation actually rendered
    expect(state.compositeAutoRender.ranCount).toBe(1)
    expect(state.composite.renderedBuffer.layersMixed).toBe(1)
  })

  it('Play waits for a scheduled render instead of playing the stale cached buffer', async () => {
    let compositeCalls = 0
    const { playSandboxPreview } = await import('../../components/sandbox/sandboxPreviewPlayer.js')

    const useSandboxStore = await loadStore({
      stackAdd: vi.fn(async () => ({ success: true, opId: Math.floor(Math.random() * 1e6) })),
      render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
      })),
      renderComposite: vi.fn(async () => {
        compositeCalls += 1
        return { ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: compositeCalls, data: FLOAT_BYTES }
      }),
      getHistory: vi.fn(async () => ({})),
    })

    useSandboxStore.setState({
      layers: [baseLayer()],
      activeLayerId: 1,
      composite: { renderState: 'ready', renderedBuffer: { layersMixed: 'stale' }, error: null },
    })

    await useSandboxStore.getState().addOp(1, makeGainOp(3)) // schedules a debounced render over the stale buffer
    await useSandboxStore.getState().toggleCompositePreview() // Play — must not hand playSandboxPreview the stale buffer

    expect(compositeCalls).toBe(1)
    expect(playSandboxPreview).toHaveBeenCalledTimes(1)
    expect(playSandboxPreview.mock.calls[0][0].layersMixed).toBe(1) // the fresh render, not 'stale'
  })

  // Regression: the manual RENDER COMPOSITE button used to call
  // sandbox_renderComposite immediately, with no wait for a layer whose own
  // render was still in flight — sandbox_renderComposite refuses in that
  // case ('layer "X" not rendered yet'), surfacing as "Render failed —
  // retry" for a layer that finishes rendering a moment later on its own.
  it('manual RENDER COMPOSITE waits for a layer still rendering instead of failing immediately', async () => {
    let compositeCalls = 0
    const useSandboxStore = await loadStore({
      renderComposite: vi.fn(async () => {
        compositeCalls += 1
        return { ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES }
      }),
    })

    useSandboxStore.setState({ layers: [baseLayer({ renderState: 'rendering' })], activeLayerId: 1 })

    const pending = useSandboxStore.getState().renderComposite()
    await new Promise((resolve) => setTimeout(resolve, 80))
    // Still waiting on the layer — must not have failed with "not rendered yet"
    expect(compositeCalls).toBe(0)
    expect(useSandboxStore.getState().composite.renderState).toBe('rendering')
    expect(useSandboxStore.getState().composite.error).toBe(null)

    useSandboxStore.setState((state) => ({
      layers: state.layers.map((l) => ({ ...l, renderState: 'ready' })),
    }))
    await pending

    expect(compositeCalls).toBe(1)
    expect(useSandboxStore.getState().composite.renderState).toBe('ready')
  })

  // Regression: a failed re-render used to null out composite.renderedBuffer
  // unconditionally, discarding a previously good mix that was still valid
  // for preview/bake — "paint garbage / discard last-good state on a
  // transient failure" is exactly what the spectrogram/render-failure
  // contract forbids.
  it('a failed composite re-render keeps the previous renderedBuffer instead of nulling it', async () => {
    const useSandboxStore = await loadStore({
      renderComposite: vi.fn(async () => ({ ready: false, reason: 'layer "X" not rendered yet' })),
    })
    useSandboxStore.setState({
      layers: [baseLayer({ renderState: 'ready' })],
      activeLayerId: 1,
      composite: { renderState: 'ready', renderedBuffer: { layersMixed: 'last-good' }, error: null },
    })

    await useSandboxStore.getState().renderComposite()

    const state = useSandboxStore.getState()
    expect(state.composite.renderState).toBe('error')
    expect(state.composite.renderedBuffer).toEqual({ layersMixed: 'last-good' })
  })
})

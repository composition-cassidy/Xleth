import { describe, expect, it, vi } from 'vitest'

// The Sample Sandbox's "proper audio editor" wiring: layer duplication, and
// PITCH's varispeed mode. Both cross the bridge, and both have a UI-side mirror
// of an engine rule that is free to drift from it — which is what these cover.

vi.mock('../../components/sandbox/sandboxPreviewPlayer.js', () => ({
  playSandboxPreview: vi.fn(() => true),
  stopSandboxPreview: vi.fn(),
}))

const FLOAT_BYTES = Buffer.from(new Float32Array([0, 0]).buffer)

function baseLayer(overrides = {}) {
  return {
    id: 1, name: 'L1', sourceBufferId: 5, bufferSampleRate: 48000,
    sourceFilePath: 'C:/audio/vox.wav', sourceStartTime: 1.5, sourceEndTime: 3.25,
    sourceRegionId: 9, swapTargetName: 'VOX',
    ops: [], muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
    renderState: 'ready', renderedBuffer: null,
    refusedOps: 0, refusalReason: null,
    bakeState: 'idle', swapInState: 'idle', swapInError: null, lastSwap: null, error: null,
    ...overrides,
  }
}

// The render/composite/history calls every mutator fans out to. Stubbed as a
// group because none of them is what any test here is about.
function renderStubs() {
  return {
    render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
    getRenderedBuffer: vi.fn(async () => ({
      ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
      refusedOps: 0, refusalReason: '',
    })),
    renderComposite: vi.fn(async () => ({
      ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES,
    })),
    getHistory: vi.fn(async () => ({})),
  }
}

async function loadModule(sandboxBridge) {
  vi.resetModules()
  globalThis.window = { xleth: { sandbox: sandboxBridge } }
  return import('../sandboxStore.js')
}

describe('sandboxStore.duplicateLayer', () => {
  const dupResult = {
    success: true, layerId: 2, name: 'L1 copy', sourceBufferId: 5, bufferSampleRate: 48000,
    sourceFilePath: 'C:/audio/vox.wav', sourceStartTime: 1.5, sourceEndTime: 3.25, opCount: 2,
  }

  it('copies the op-stack and mix params, and lands directly after its source', async () => {
    const duplicateLayer = vi.fn(async () => dupResult)
    const { default: useSandboxStore } = await loadModule({ duplicateLayer, ...renderStubs() })

    const src = baseLayer({
      ops: [
        { id: 1, type: 'gain', params: { gainDb: -6 }, enabled: true },
        { id: 2, type: 'reverse', params: {}, enabled: false },
      ],
      gainDb: -4.5, pan: 0.5, offsetSamples: 480, muted: true,
    })
    // A third layer below, so "directly after" is a real claim rather than a
    // synonym for "appended".
    useSandboxStore.setState({
      layers: [src, baseLayer({ id: 3, name: 'tail' })], activeLayerId: 1,
    })

    await useSandboxStore.getState().duplicateLayer(1)

    expect(duplicateLayer).toHaveBeenCalledWith(1)
    const { layers, activeLayerId } = useSandboxStore.getState()
    expect(layers.map((l) => l.id)).toEqual([1, 2, 3])
    expect(activeLayerId).toBe(2)

    const copy = layers[1]
    expect(copy.name).toBe('L1 copy')
    expect(copy.ops).toEqual(src.ops)
    expect(copy.ops[1].enabled).toBe(false)   // a bypassed op stays bypassed
    expect(copy.gainDb).toBe(-4.5)
    expect(copy.pan).toBe(0.5)
    expect(copy.offsetSamples).toBe(480)
    expect(copy.muted).toBe(true)
    expect(copy.sourceBufferId).toBe(5)
    expect(copy.sourceFilePath).toBe('C:/audio/vox.wav')
    expect(copy.sourceRegionId).toBe(9)       // renderer-only, carried from the source layer

    // The ops array must be a COPY, not the same reference — editing the
    // duplicate's stack must not mutate the original's.
    expect(copy.ops).not.toBe(src.ops)
    expect(copy.ops[0]).not.toBe(src.ops[0])
  })

  it('does not inherit solo — that is a whole-workspace monitoring state', async () => {
    const { default: useSandboxStore } = await loadModule({
      duplicateLayer: vi.fn(async () => dupResult), ...renderStubs(),
    })
    useSandboxStore.setState({ layers: [baseLayer({ soloed: true })], activeLayerId: 1 })

    await useSandboxStore.getState().duplicateLayer(1)
    expect(useSandboxStore.getState().layers[1].soloed).toBe(false)
  })

  it('inherits an already-rendered buffer so the new card is not blank', async () => {
    const { default: useSandboxStore } = await loadModule({
      duplicateLayer: vi.fn(async () => dupResult), ...renderStubs(),
    })
    const buffer = { numChannels: 1, numSamples: 2, sampleRate: 48000, channels: [] }
    useSandboxStore.setState({
      layers: [baseLayer({ renderState: 'ready', renderedBuffer: buffer })], activeLayerId: 1,
    })

    await useSandboxStore.getState().duplicateLayer(1)
    const copy = useSandboxStore.getState().layers[1]
    // 'rendering' is also acceptable here — renderLayer runs immediately after
    // the insert. What must NOT happen is the buffer being dropped.
    expect(copy.renderedBuffer).toBe(buffer)
  })

  it('adds nothing when the engine refuses', async () => {
    const { default: useSandboxStore } = await loadModule({
      duplicateLayer: vi.fn(async () => ({ success: false, reason: 'layer not found' })),
      ...renderStubs(),
    })
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    const out = await useSandboxStore.getState().duplicateLayer(1)
    expect(out).toBeNull()
    expect(useSandboxStore.getState().layers).toHaveLength(1)
  })
})

describe('sandboxStore PITCH mode', () => {
  it('numbers PITCH_MODE exactly as xleth::sandbox::SandboxPitchMode does', async () => {
    const { PITCH_MODE } = await loadModule({})
    expect(PITCH_MODE).toEqual({ preserve: 0, resample: 1 })
  })

  it('defaults addPitchShift to preserve, and sends resample when asked', async () => {
    const stackAdd = vi.fn(async () => ({ success: true, opId: 7 }))
    const { default: useSandboxStore, PITCH_MODE } = await loadModule({
      stackAdd, ...renderStubs(),
    })
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    await useSandboxStore.getState().addPitchShift(1, -250, true)
    expect(stackAdd.mock.calls[0][1]).toEqual({
      type: 'pitch', params: { cents: -250, formantPreserve: true, mode: PITCH_MODE.preserve },
    })

    await useSandboxStore.getState().addPitchShift(1, 700, false, PITCH_MODE.resample)
    expect(stackAdd.mock.calls[1][1]).toEqual({
      type: 'pitch', params: { cents: 700, formantPreserve: false, mode: PITCH_MODE.resample },
    })
  })

  it('offers both modes from the EFFECT menu registry, as separate entries on one op', async () => {
    const { PITCH_MODE } = await loadModule({})
    const { EFFECT_REGISTRY } = await import('../sandboxEffectRegistry.js')

    const pitch = EFFECT_REGISTRY.find((e) => e.id === 'pitch')
    const vari = EFFECT_REGISTRY.find((e) => e.id === 'varispeed')
    expect(pitch && vari).toBeTruthy()
    expect(vari.category).toBe('PITCH')

    // Both run addPitchShift; only the mode differs. Asserted by running them
    // against a stub store, because the mode is buried in a closure.
    const store = { addPitchShift: vi.fn() }
    pitch.run(store, { layerId: 1 })
    vari.run(store, { layerId: 1 })
    expect(store.addPitchShift.mock.calls[0][3]).toBe(PITCH_MODE.preserve)
    expect(store.addPitchShift.mock.calls[1][3]).toBe(PITCH_MODE.resample)
  })
})

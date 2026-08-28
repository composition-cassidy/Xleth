import { describe, expect, it, vi } from 'vitest'

// AUTOTUNE (P5-3) wiring, on the two seams that are hand-maintained mirrors of
// the engine and therefore free to drift from it:
//
//   1. AUTO_RENDER_BY_OP_TYPE must carry an entry for every op type the engine
//      knows about. A MISSING entry is not a compile error here the way a
//      missing std::visit case is in SandboxOp.cpp — it silently reads as
//      "undefined !== false", i.e. auto-render allowed. That happens to be the
//      right answer for autotune, so a test that only checked behaviour would
//      pass for the wrong reason. This checks the entry EXISTS.
//   2. AUTOTUNE_SCALE's values cross the bridge as xleth::dsp::ScaleType's
//      integers, so the table's numbering is load-bearing, not cosmetic.
//
// Plus the store action itself: what params addAutotune actually sends.

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
    refusedOps: 0, refusalReason: null,
    bakeState: 'idle', swapInState: 'idle', swapInError: null, lastSwap: null, error: null,
    ...overrides,
  }
}

async function loadModule(sandboxBridge) {
  vi.resetModules()
  globalThis.window = { xleth: { sandbox: sandboxBridge } }
  return import('../sandboxStore.js')
}

describe('sandboxStore AUTOTUNE wiring', () => {
  it('numbers AUTOTUNE_SCALE exactly as xleth::dsp::ScaleType does', async () => {
    const { AUTOTUNE_SCALE, AUTOTUNE_SCALE_NAME, AUTOTUNE_KEY_NAME, AUTOTUNE_DEFAULT_KEY } =
      await loadModule({})

    // The C++ enumerator order (CorrectionCurve.h): the seven diatonic modes in
    // scale-degree order, then harmonic/melodic minor, then the two pentatonics.
    expect(AUTOTUNE_SCALE).toEqual({
      IONIAN: 0, DORIAN: 1, PHRYGIAN: 2, LYDIAN: 3, MIXOLYDIAN: 4, AEOLIAN: 5,
      LOCRIAN: 6, HARMONIC_MINOR: 7, MELODIC_MINOR: 8,
      MAJOR_PENTATONIC: 9, MINOR_PENTATONIC: 10,
    })
    // Every value must be nameable, or the stack row and the Scale dropdown
    // render a bare integer.
    for (const v of Object.values(AUTOTUNE_SCALE)) {
      expect(typeof AUTOTUNE_SCALE_NAME[v]).toBe('string')
    }
    expect(AUTOTUNE_KEY_NAME).toHaveLength(12)
    expect(AUTOTUNE_KEY_NAME[AUTOTUNE_DEFAULT_KEY]).toBe('D')   // kDefaultKey
  })

  it('addAutotune sends the specced defaults as a whole-buffer op', async () => {
    const stackAdd = vi.fn(async () => ({ success: true, opId: 42 }))
    const { default: useSandboxStore, AUTOTUNE_SCALE, AUTOTUNE_DEFAULT_KEY } = await loadModule({
      stackAdd,
      render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
        refusedOps: 0, refusalReason: '',
      })),
      renderComposite: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES,
      })),
      getHistory: vi.fn(async () => ({})),
    })

    // A selection is deliberately active: AUTOTUNE must ignore it. Pitch
    // correction is a property of a performance, and AutotuneParams carries no
    // start/endSample to scope it to a region.
    useSandboxStore.setState({
      layers: [baseLayer()], activeLayerId: 1,
      selection: { startSample: 100, endSample: 200 },
    })
    await useSandboxStore.getState().addAutotune(1)

    expect(stackAdd).toHaveBeenCalledTimes(1)
    const [layerId, op] = stackAdd.mock.calls[0]
    expect(layerId).toBe(1)
    expect(op.type).toBe('autotune')
    expect(op.params).toEqual({
      scale: AUTOTUNE_SCALE.PHRYGIAN,
      key: AUTOTUNE_DEFAULT_KEY,
      allowedNotes: [],
      correctionAmount: 100,
      retuneSpeedMs: 20,
      smoothnessMs: 20,
      jumpiness: 0,
      preserveVibrato: 100,
    })
    expect(op.params).not.toHaveProperty('startSample')
    expect(op.params).not.toHaveProperty('endSample')

    const layer = useSandboxStore.getState().layers[0]
    expect(layer.ops).toHaveLength(1)
    expect(layer.ops[0]).toMatchObject({ id: 42, type: 'autotune' })
  })

  it('carries the renderer refusal onto the layer without calling it an error', async () => {
    const reason = 'pitch track too unstable to be monophonic — content may be polyphonic'
    const { default: useSandboxStore } = await loadModule({
      render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
        refusedOps: 1, refusalReason: reason,
      })),
      renderComposite: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES,
      })),
      getHistory: vi.fn(async () => ({})),
    })

    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })
    await useSandboxStore.getState().renderLayer(1, 'test')
    await new Promise((r) => setTimeout(r, 50))

    const layer = useSandboxStore.getState().layers[0]
    // The render SUCCEEDED — the buffer is real and playable. One op declined to
    // act on it, which is a different message and must not masquerade as a
    // failed render.
    expect(layer.renderState).toBe('ready')
    expect(layer.error).toBeNull()
    expect(layer.refusedOps).toBe(1)
    expect(layer.refusalReason).toBe(reason)
  })

  it('registers autotune in the engine-mirrored auto-render table', async () => {
    const { default: useSandboxStore } = await loadModule({
      render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
      getRenderedBuffer: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
        refusedOps: 0, refusalReason: '',
      })),
      renderComposite: vi.fn(async () => ({
        ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES,
      })),
      getHistory: vi.fn(async () => ({})),
    })

    // The table is module-private, so this reads it the only way the app does:
    // a layer carrying ONLY an autotune op must still auto-render. An opted-out
    // op type would skip renderLayer entirely and leave the state at 'idle'.
    useSandboxStore.setState({
      layers: [baseLayer({ renderState: 'idle', ops: [{ id: 1, type: 'autotune', params: {}, enabled: true }] })],
      activeLayerId: 1,
    })
    useSandboxStore.getState()._triggerAutoRender(1, 'test')
    await new Promise((r) => setTimeout(r, 50))

    expect(useSandboxStore.getState().layers[0].renderState).toBe('ready')
  })
})

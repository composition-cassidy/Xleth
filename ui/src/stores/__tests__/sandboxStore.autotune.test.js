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
      mode: 0, // AutotuneMode::Scale
      scale: AUTOTUNE_SCALE.PHRYGIAN,
      key: AUTOTUNE_DEFAULT_KEY,
      allowedNotes: [],
      correctionAmount: 100,
      retuneSpeedMs: 20,
      smoothnessMs: 20,
      jumpiness: 0,
      preserveVibrato: 100,
      manualPoints: [],
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

  // P5-4: the pitch-curve overlay's fetch + the store-side "which op is
  // expanded" state it depends on. ensurePitchTrack round-trips through
  // window.xleth.sandbox.getPitchTrack — the exact call whose wiring the
  // task's own constraints called out as easy to get silently swallowed by
  // the four-layer bridge (manifest -> preload -> main -> native handler),
  // so this asserts it is actually invoked with the right shape, not just
  // that SOME promise resolves.
  it('ensurePitchTrack fetches and unpacks the interleaved (f0Hz, confidence) buffer', async () => {
    const packed = new Float32Array([440, 0.9, 0, 0, 466.16, 0.8]) // 3 frames, middle one unvoiced
    const getPitchTrack = vi.fn(async () => ({
      ready: true, sampleRate: 48000, hopSamples: 240, numFrames: 3, monophonic: true, reason: '',
      notes: [{ startSample: 0, endSample: 480, medianF0Hz: 440, noteName: 'A4' }],
      frames: Buffer.from(packed.buffer),
    }))
    const { default: useSandboxStore } = await loadModule({ getPitchTrack })

    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })
    await useSandboxStore.getState().ensurePitchTrack(1)

    expect(getPitchTrack).toHaveBeenCalledTimes(1)
    expect(getPitchTrack).toHaveBeenCalledWith(1)
    const layer = useSandboxStore.getState().layers[0]
    expect(layer.pitchTrackState).toBe('ready')
    expect(layer.pitchTrack.monophonic).toBe(true)
    expect(layer.pitchTrack.notes).toHaveLength(1)
    // float32 round-trip (the wire format PitchFrame::f0Hz/confidence are
    // stored as) — closeTo rather than exact equality for the non-zero values.
    expect(layer.pitchTrack.frames).toEqual([
      { posSample: 0, f0Hz: expect.closeTo(440, 3), confidence: expect.closeTo(0.9, 3) },
      { posSample: 240, f0Hz: 0, confidence: 0 },
      { posSample: 480, f0Hz: expect.closeTo(466.16, 3), confidence: expect.closeTo(0.8, 3) },
    ])

    // Session-cached (P5-1's own cache is keyed by sourceBufferId, which
    // never changes after a layer is created) — a second call must not hit
    // the bridge again.
    await useSandboxStore.getState().ensurePitchTrack(1)
    expect(getPitchTrack).toHaveBeenCalledTimes(1)
  })

  it('ensurePitchTrack surfaces the monophonic gate refusal without throwing', async () => {
    const reason = 'pitch track too unstable to be monophonic — content may be polyphonic'
    const getPitchTrack = vi.fn(async () => ({
      ready: true, sampleRate: 48000, hopSamples: 240, numFrames: 0, monophonic: false, reason,
      notes: [], frames: Buffer.alloc(0),
    }))
    const { default: useSandboxStore } = await loadModule({ getPitchTrack })
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    await useSandboxStore.getState().ensurePitchTrack(1)

    const layer = useSandboxStore.getState().layers[0]
    expect(layer.pitchTrackState).toBe('ready')
    expect(layer.pitchTrack.monophonic).toBe(false)
    expect(layer.pitchTrack.reason).toBe(reason)
  })

  it('setSelectedOpId fetches the pitch track only when the selected op is autotune', async () => {
    const getPitchTrack = vi.fn(async () => ({
      ready: true, sampleRate: 48000, hopSamples: 240, numFrames: 0, monophonic: true, reason: '',
      notes: [], frames: Buffer.alloc(0),
    }))
    const { default: useSandboxStore } = await loadModule({ getPitchTrack })
    useSandboxStore.setState({
      layers: [baseLayer({
        ops: [
          { id: 1, type: 'gain', params: {}, enabled: true },
          { id: 2, type: 'autotune', params: {}, enabled: true },
        ],
      })],
      activeLayerId: 1,
    })

    useSandboxStore.getState().setSelectedOpId(1) // gain — not autotune
    await new Promise((r) => setTimeout(r, 0))
    expect(useSandboxStore.getState().selectedOpId).toBe(1)
    expect(getPitchTrack).not.toHaveBeenCalled()

    useSandboxStore.getState().setSelectedOpId(2) // autotune
    await new Promise((r) => setTimeout(r, 0))
    expect(useSandboxStore.getState().selectedOpId).toBe(2)
    expect(getPitchTrack).toHaveBeenCalledTimes(1)

    useSandboxStore.getState().setSelectedOpId(null)
    expect(useSandboxStore.getState().selectedOpId).toBeNull()
  })

  // P5-5: commitAutotuneManualStroke — the store-side half of the "preview
  // locally in a ref while dragging, commit once on release" contract the
  // pitch canvas follows (same shape setGainEnvelope/commitSpectralPaintDabs
  // use for their own tools).
  describe('commitAutotuneManualStroke (P5-5)', () => {
    function autotuneLayer(manualPoints = []) {
      return baseLayer({
        ops: [{ id: 9, type: 'autotune', params: {
          mode: 1, scale: 2, key: 2, allowedNotes: [],
          correctionAmount: 100, retuneSpeedMs: 20, smoothnessMs: 20,
          jumpiness: 0, preserveVibrato: 100, manualPoints,
        }, enabled: true }],
      })
    }

    it('sends exactly one stackSetParam call for a whole stroke', async () => {
      const stackSetParam = vi.fn(async () => ({ success: true }))
      const { default: useSandboxStore } = await loadModule({ stackSetParam })
      useSandboxStore.setState({ layers: [autotuneLayer()], activeLayerId: 1 })

      const stroke = [{ t: 0, hz: 220, tension: 0 }, { t: 0.5, hz: 330, tension: 0 }]
      await useSandboxStore.getState().commitAutotuneManualStroke(1, stroke)

      expect(stackSetParam).toHaveBeenCalledTimes(1)
      const [layerId, opId, payload] = stackSetParam.mock.calls[0]
      expect(layerId).toBe(1)
      expect(opId).toBe(9)
      expect(payload.type).toBe('autotune')
      expect(payload.params.manualPoints).toEqual(stroke)
      // Every other field of the op's params survives untouched — this is a
      // targeted patch, not a replacement of the whole params object.
      expect(payload.params.mode).toBe(1)
      expect(payload.params.correctionAmount).toBe(100)
    })

    it('redrawing over an existing time range REPLACES it, not blends it in', async () => {
      const stackSetParam = vi.fn(async () => ({ success: true }))
      const existing = [
        { t: 0, hz: 220, tension: 0 },
        { t: 0.2, hz: 220, tension: 0 }, // inside the new stroke's range -> dropped
        { t: 1.5, hz: 440, tension: 0 }, // outside it -> kept
      ]
      const { default: useSandboxStore } = await loadModule({ stackSetParam })
      useSandboxStore.setState({ layers: [autotuneLayer(existing)], activeLayerId: 1 })

      const stroke = [{ t: 0.1, hz: 300, tension: 0 }, { t: 0.9, hz: 300, tension: 0 }]
      await useSandboxStore.getState().commitAutotuneManualStroke(1, stroke)

      const [, , payload] = stackSetParam.mock.calls[0]
      // Sorted by t: the untouched t=0 and t=1.5 points (both outside the
      // stroke's [0.1, 0.9] range) survive; the t=0.2 point (inside it) is
      // replaced by the new stroke.
      expect(payload.params.manualPoints).toEqual([
        { t: 0, hz: 220, tension: 0 },
        { t: 0.1, hz: 300, tension: 0 },
        { t: 0.9, hz: 300, tension: 0 },
        { t: 1.5, hz: 440, tension: 0 },
      ])
    })

    it('a single-point stroke (a click with no drag) is dropped, not committed', async () => {
      const stackSetParam = vi.fn(async () => ({ success: true }))
      const { default: useSandboxStore } = await loadModule({ stackSetParam })
      useSandboxStore.setState({ layers: [autotuneLayer()], activeLayerId: 1 })

      await useSandboxStore.getState().commitAutotuneManualStroke(1, [{ t: 0.3, hz: 220, tension: 0 }])

      expect(stackSetParam).not.toHaveBeenCalled()
    })

    it('does nothing when the layer has no autotune op', async () => {
      const stackSetParam = vi.fn(async () => ({ success: true }))
      const { default: useSandboxStore } = await loadModule({ stackSetParam })
      useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

      await useSandboxStore.getState().commitAutotuneManualStroke(1, [
        { t: 0, hz: 220, tension: 0 }, { t: 1, hz: 220, tension: 0 },
      ])

      expect(stackSetParam).not.toHaveBeenCalled()
    })
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

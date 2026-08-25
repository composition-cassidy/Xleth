import { beforeEach, describe, expect, it, vi } from 'vitest'

// Coverage for the gain-envelope half of the Audio Dynamics Editor (Mode 1).
//
// The store carries a JS MIRROR of the engine's curve (gainEnvelopeAt /
// sortEnvelopePoints in SandboxOp.cpp) because the canvas has to draw the same
// line the renderer will apply, and the headroom warning has to predict a drag
// that has not been committed. A mirror that drifts is worse than no mirror at
// all — it would draw a duck the render does not perform — so the numbers below
// are the ones test_sandbox.cpp checks on the C++ side, deliberately duplicated
// rather than approximated.

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
  return import('../sandboxStore.js')
}

function quietBridge(extra = {}) {
  return {
    stackAdd: vi.fn(async () => ({ success: true, opId: 77 })),
    stackSetParam: vi.fn(async () => ({ success: true })),
    render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
    getRenderedBuffer: vi.fn(async () => ({
      ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, data: FLOAT_BYTES,
    })),
    renderComposite: vi.fn(async () => ({
      ready: true, numChannels: 1, numSamples: 2, sampleRate: 48000, layersMixed: 1, data: FLOAT_BYTES,
    })),
    getHistory: vi.fn(async () => ({})),
    ...extra,
  }
}

describe('gain envelope curve mirror', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('matches the engine curve: unity when empty, held outside, dB-domain midpoint', async () => {
    const { gainEnvelopeAt } = await loadStore(quietBridge())

    expect(gainEnvelopeAt([], 0)).toBe(1)
    expect(gainEnvelopeAt([], 99999)).toBe(1)

    const one = [{ samplePos: 5000, db: -6 }]
    expect(gainEnvelopeAt(one, 0)).toBeCloseTo(Math.pow(10, -6 / 20), 9)
    expect(gainEnvelopeAt(one, 99999)).toBeCloseTo(Math.pow(10, -6 / 20), 9)

    const ramp = [{ samplePos: 0, db: 0 }, { samplePos: 1000, db: -12 }]
    expect(gainEnvelopeAt(ramp, 0)).toBeCloseTo(1, 9)
    expect(gainEnvelopeAt(ramp, 1000)).toBeCloseTo(Math.pow(10, -12 / 20), 9)
    // Smoothstep(0.5) === 0.5, so the midpoint is the dB midpoint. Interpolating
    // the LINEAR gain instead would land here at -3.5 dB, and the drawn line
    // would stop matching the rendered audio.
    expect(gainEnvelopeAt(ramp, 500)).toBeCloseTo(Math.pow(10, -6 / 20), 9)
    // Held flat outside the authored range, never extrapolated.
    expect(gainEnvelopeAt(ramp, -50)).toBeCloseTo(1, 9)
    expect(gainEnvelopeAt(ramp, 5000)).toBeCloseTo(Math.pow(10, -12 / 20), 9)
  })

  it('has ~zero slope at an interior breakpoint, and exact silence at the floor', async () => {
    const { gainEnvelopeAt, GAIN_ENVELOPE_DB_MIN } = await loadStore(quietBridge())

    const vee = [
      { samplePos: 0, db: 0 }, { samplePos: 1000, db: -24 }, { samplePos: 2000, db: 0 },
    ]
    expect(Math.abs(gainEnvelopeAt(vee, 1000) - gainEnvelopeAt(vee, 999))).toBeLessThan(1e-5)
    expect(Math.abs(gainEnvelopeAt(vee, 1001) - gainEnvelopeAt(vee, 1000))).toBeLessThan(1e-5)

    expect(gainEnvelopeAt([{ samplePos: 0, db: GAIN_ENVELOPE_DB_MIN }], 0)).toBe(0)
  })

  it('sorts, clamps and de-duplicates exactly like normalizeGainEnvelope', async () => {
    const { sortEnvelopePoints, GAIN_ENVELOPE_DB_MAX } = await loadStore(quietBridge())

    const out = sortEnvelopePoints([
      { samplePos: 500, db: -6 },
      { samplePos: 100, db: 0 },
      { samplePos: 500, db: -12 },   // same position, written later — wins
      { samplePos: -7, db: 3 },      // before the buffer — dropped
      { samplePos: 900, db: 999 },   // out of range — clamped, not rejected
    ])

    expect(out.map((p) => p.samplePos)).toEqual([100, 500, 900])
    expect(out[1].db).toBe(-12)
    expect(out[2].db).toBe(GAIN_ENVELOPE_DB_MAX)
  })
})

describe('setGainEnvelope — one command per commit', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('adds the op on the first commit and replaces its params after that', async () => {
    const bridge = quietBridge()
    const { default: useSandboxStore } = await loadStore(bridge)
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    const duck = [
      { samplePos: 0, db: 0 }, { samplePos: 2000, db: -20 }, { samplePos: 4000, db: 0 },
    ]
    await useSandboxStore.getState().setGainEnvelope(1, duck)

    expect(bridge.stackAdd).toHaveBeenCalledTimes(1)
    expect(bridge.stackSetParam).not.toHaveBeenCalled()
    const [, addedOp] = bridge.stackAdd.mock.calls[0]
    expect(addedOp.type).toBe('gainEnvelope')
    expect(addedOp.params.points).toEqual(duck)

    const stored = useSandboxStore.getState().layers[0].ops
    expect(stored).toHaveLength(1)
    expect(stored[0].type).toBe('gainEnvelope')

    // Second commit edits in place — one op on the stack, not two.
    const deeper = [
      { samplePos: 0, db: 0 }, { samplePos: 2000, db: -30 }, { samplePos: 4000, db: 0 },
    ]
    await useSandboxStore.getState().setGainEnvelope(1, deeper)

    expect(bridge.stackAdd).toHaveBeenCalledTimes(1)   // still just the one
    expect(bridge.stackSetParam).toHaveBeenCalledTimes(1)
    expect(useSandboxStore.getState().layers[0].ops).toHaveLength(1)
    expect(useSandboxStore.getState().layers[0].ops[0].params.points).toEqual(deeper)
  })

  it('does nothing at all when the curve came back unchanged', async () => {
    const bridge = quietBridge()
    const { default: useSandboxStore } = await loadStore(bridge)

    const points = [{ samplePos: 0, db: 0 }, { samplePos: 1000, db: -9 }]
    useSandboxStore.setState({
      layers: [baseLayer({
        ops: [{ id: 77, type: 'gainEnvelope', params: { points }, enabled: true }],
      })],
      activeLayerId: 1,
    })

    // A mouseup that moved nothing must cost neither an undo step nor a render.
    // The engine would reject it as "not an edit" anyway; catching it here keeps
    // that rejection off the console.
    await useSandboxStore.getState().setGainEnvelope(1, points.map((p) => ({ ...p })))

    expect(bridge.stackSetParam).not.toHaveBeenCalled()
    expect(bridge.stackAdd).not.toHaveBeenCalled()
  })
})

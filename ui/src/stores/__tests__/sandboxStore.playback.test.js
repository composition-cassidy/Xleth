import { beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 2 transport: what Space actually plays, and the single-layer audition
// that no longer needs a composite render to hear one layer.
//
// The rule under test is not guessable from the code alone, which is why it is
// pinned here: a MEANINGFUL selection plays as a bounded range; a bare cursor
// plays from there to the end. Everything downstream — looping, the transport's
// own "SEL/CUR" readout, the playhead — is built on that one decision.

vi.mock('../../components/sandbox/sandboxPreviewPlayer.js', () => ({
  playSandboxPreview: vi.fn(() => true),
  stopSandboxPreview: vi.fn(),
  setSandboxPreviewLoop: vi.fn(),
}))

const RATE = 48000

function buffer(numSamples = RATE) {
  return {
    numChannels: 1,
    numSamples,
    sampleRate: RATE,
    channels: [new Float32Array(numSamples)],
  }
}

function baseLayer(overrides = {}) {
  return {
    id: 1, name: 'L1', sourceBufferId: 5, bufferSampleRate: RATE,
    sourceFilePath: null, sourceStartTime: null, sourceEndTime: null,
    sourceRegionId: null, swapTargetName: null,
    ops: [], muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
    renderState: 'ready', renderedBuffer: buffer(),
    bakeState: 'idle', swapInState: 'idle', swapInError: null, lastSwap: null, error: null,
    ...overrides,
  }
}

async function loadStore() {
  vi.resetModules()
  globalThis.window = { xleth: { sandbox: {} } }
  const mod = await import('../sandboxStore.js')
  return mod.default
}

async function player() {
  return import('../../components/sandbox/sandboxPreviewPlayer.js')
}

describe('sandboxStore layer audition', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('plays the layer’s own buffer with no composite render', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview } = await player()
    const layer = baseLayer()
    useSandboxStore.setState({ layers: [layer], activeLayerId: 1 })

    useSandboxStore.getState().toggleLayerPreview(1)

    expect(playSandboxPreview).toHaveBeenCalledTimes(1)
    // Arg 0 is the LAYER's buffer, not a mix — that is the whole point of the
    // audition path (soloing + a composite re-render was the old way to hear
    // one layer).
    expect(playSandboxPreview.mock.calls[0][0]).toBe(layer.renderedBuffer)
    expect(useSandboxStore.getState().playback).toMatchObject({
      state: 'playing', kind: 'layer', layerId: 1,
    })
  })

  it('plays a meaningful selection as a bounded range', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview } = await player()
    useSandboxStore.setState({
      layers: [baseLayer()],
      activeLayerId: 1,
      selection: { startSample: 12000, endSample: 36000 },
    })

    useSandboxStore.getState().toggleLayerPreview(1)

    expect(playSandboxPreview.mock.calls[0][1]).toMatchObject({
      startSample: 12000, endSample: 36000,
    })
  })

  it('plays from a bare cursor to the end of the buffer', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview } = await player()
    // Zero-width selection = the cursor (what a click on the waveform stores).
    useSandboxStore.setState({
      layers: [baseLayer()],
      activeLayerId: 1,
      selection: { startSample: 9000, endSample: 9000 },
    })

    useSandboxStore.getState().toggleLayerPreview(1)

    const opts = playSandboxPreview.mock.calls[0][1]
    expect(opts.startSample).toBe(9000)
    expect(opts.endSample).toBeNull() // null = to the end
  })

  it('passes the loop mode through to the player', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview } = await player()
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1, loopPlayback: true })

    useSandboxStore.getState().toggleLayerPreview(1)

    expect(playSandboxPreview.mock.calls[0][1].loop).toBe(true)
  })

  it('a second press on the same layer stops rather than restarting', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview, stopSandboxPreview } = await player()
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    useSandboxStore.getState().toggleLayerPreview(1)
    useSandboxStore.getState().toggleLayerPreview(1)

    expect(stopSandboxPreview).toHaveBeenCalled()
    expect(playSandboxPreview).toHaveBeenCalledTimes(1)
    expect(useSandboxStore.getState().playback.state).toBe('idle')
  })

  it('auditioning a DIFFERENT layer stops the first and starts the second', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview } = await player()
    useSandboxStore.setState({
      layers: [baseLayer(), baseLayer({ id: 2, name: 'L2' })],
      activeLayerId: 1,
    })

    useSandboxStore.getState().toggleLayerPreview(1)
    useSandboxStore.getState().toggleLayerPreview(2)

    expect(playSandboxPreview).toHaveBeenCalledTimes(2)
    expect(useSandboxStore.getState().playback).toMatchObject({ state: 'playing', layerId: 2 })
  })

  it('does nothing for a layer with no decoded audio', async () => {
    const useSandboxStore = await loadStore()
    const { playSandboxPreview } = await player()
    useSandboxStore.setState({
      layers: [baseLayer({ renderedBuffer: null })], activeLayerId: 1,
    })

    useSandboxStore.getState().toggleLayerPreview(1)

    expect(playSandboxPreview).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().playback.state).toBe('idle')
  })

  // A layer sits at offsetSamples inside the MIX, so the same selection means
  // a different absolute position there. Without this shift, looping "the
  // selection" over a delayed layer would loop the wrong audio.
  it('shifts the range by the layer offset for a composite play, but not for an audition', async () => {
    const useSandboxStore = await loadStore()
    const layer = baseLayer({ offsetSamples: 24000 })
    useSandboxStore.setState({
      layers: [layer], activeLayerId: 1,
      selection: { startSample: 1000, endSample: 5000 },
    })

    expect(useSandboxStore.getState()._playbackRange('composite', layer))
      .toEqual({ startSample: 25000, endSample: 29000 })
    expect(useSandboxStore.getState()._playbackRange('layer', layer))
      .toEqual({ startSample: 1000, endSample: 5000 })
  })

  it('arms loop on the pass already playing', async () => {
    const useSandboxStore = await loadStore()
    const { setSandboxPreviewLoop } = await player()
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    useSandboxStore.getState().toggleLoopPlayback()

    expect(useSandboxStore.getState().loopPlayback).toBe(true)
    expect(setSandboxPreviewLoop).toHaveBeenCalledWith(true)
  })
})

describe('sandboxStore viewport actions', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('zooms against the ACTIVE layer’s current length', async () => {
    const useSandboxStore = await loadStore()
    useSandboxStore.setState({ layers: [baseLayer()], activeLayerId: 1 })

    useSandboxStore.getState().zoomBy(0.5, 0.5)
    const view = useSandboxStore.getState().view

    expect(view).not.toBeNull()
    expect(view.endSample - view.startSample).toBeCloseTo(RATE / 2, 0)
  })

  it('zooming all the way out returns to fit', async () => {
    const useSandboxStore = await loadStore()
    useSandboxStore.setState({
      layers: [baseLayer()], activeLayerId: 1, view: { startSample: 0, endSample: 1000 },
    })

    useSandboxStore.getState().zoomBy(1000, 0.5)

    expect(useSandboxStore.getState().view).toBeNull()
  })

  it('resets the view when the active layer changes', async () => {
    const useSandboxStore = await loadStore()
    useSandboxStore.setState({
      layers: [baseLayer(), baseLayer({ id: 2 })],
      activeLayerId: 1,
      view: { startSample: 100, endSample: 200 },
      selection: { startSample: 10, endSample: 20 },
    })

    useSandboxStore.getState().setActiveLayer(2)

    // The old view indexes a different buffer — carrying it across would frame
    // an arbitrary window of the new layer.
    expect(useSandboxStore.getState().view).toBeNull()
    expect(useSandboxStore.getState().selection).toBeNull()
  })

  it('zoomToSelection frames the selection', async () => {
    const useSandboxStore = await loadStore()
    useSandboxStore.setState({
      layers: [baseLayer()], activeLayerId: 1,
      selection: { startSample: 20000, endSample: 24000 },
    })

    useSandboxStore.getState().zoomToSelection()
    const view = useSandboxStore.getState().view

    expect(view.startSample).toBeLessThan(20000)
    expect(view.endSample).toBeGreaterThan(24000)
  })

  it('zoom actions are inert with no rendered layer', async () => {
    const useSandboxStore = await loadStore()
    useSandboxStore.setState({ layers: [], activeLayerId: null })

    useSandboxStore.getState().zoomBy(0.5, 0.5)
    useSandboxStore.getState().zoomToSelection()

    expect(useSandboxStore.getState().view).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'

// What a range edit acts on when there is no real selection.
//
// The cursor a click leaves behind is a ZERO-WIDTH selection, not null. Gain,
// Normalize and Reverse used to read their range straight off it, so with a
// cursor placed — the commonest state in the panel — they added an op over an
// empty range: a new row in the stack and no audible change. And a fade did
// nothing at all without a dragged range. These pin the rule that replaced
// both: a bare cursor means the whole layer, or for a fade the stretch between
// the cursor and the layer's own edge.

vi.mock('../../components/sandbox/sandboxPreviewPlayer.js', () => ({
  playSandboxPreview: vi.fn(() => true),
  stopSandboxPreview: vi.fn(),
  setSandboxPreviewLoop: vi.fn(),
}))

const RATE = 48000
const LENGTH = 96000 // 2 s

function readyLayer(overrides = {}) {
  return {
    id: 1, name: 'VOX', sourceBufferId: 5, bufferSampleRate: RATE,
    ops: [], muted: false, soloed: false, gainDb: 0, pan: 0, offsetSamples: 0,
    renderState: 'ready',
    renderedBuffer: { numChannels: 1, numSamples: LENGTH, sampleRate: RATE, channels: [] },
    ...overrides,
  }
}

async function loadStore(selection) {
  vi.resetModules()
  let nextOpId = 100
  const stackAdd = vi.fn(async () => ({ success: true, opId: nextOpId++ }))
  globalThis.window = {
    xleth: {
      sandbox: {
        stackAdd,
        render: vi.fn(async () => ({ success: true, queued: true, pending: false })),
        getRenderedBuffer: vi.fn(async () => ({ ready: false })),
        getHistory: vi.fn(async () => ({})),
      },
    },
  }
  const { default: useSandboxStore } = await import('../sandboxStore.js')
  useSandboxStore.setState({ layers: [readyLayer()], activeLayerId: 1, selection })
  // The op the store sent to the engine on its n-th stackAdd call.
  const sent = (n = 0) => stackAdd.mock.calls[n][1]
  return { useSandboxStore, stackAdd, sent }
}

const CURSOR = { startSample: 24000, endSample: 24000 }
const RANGE = { startSample: 12000, endSample: 36000 }

describe('sandboxStore range edits with only a cursor', () => {
  it('reverses, gains and normalizes the WHOLE layer, not the empty range under the cursor', async () => {
    const { useSandboxStore, sent } = await loadStore(CURSOR)
    await useSandboxStore.getState().reverseSelection(1)
    expect(sent(0)).toMatchObject({ type: 'reverse', params: { startSample: 0, endSample: -1 } })

    useSandboxStore.setState({ selection: CURSOR }) // addOp clears the selection
    await useSandboxStore.getState().gainSelection(1, 0)
    expect(sent(1).params).toMatchObject({ startSample: 0, endSample: -1, normalize: false })

    useSandboxStore.setState({ selection: CURSOR })
    await useSandboxStore.getState().normalizeSelection(1, -0.1)
    expect(sent(2).params).toMatchObject({ startSample: 0, endSample: -1, normalize: true, targetPeakDb: -0.1 })
  })

  it('still scopes them to a real selection', async () => {
    const { useSandboxStore, sent } = await loadStore(RANGE)
    await useSandboxStore.getState().gainSelection(1, 0)
    expect(sent(0).params).toMatchObject({ startSample: 12000, endSample: 36000 })
  })

  it('treats no selection at all the same as a cursor', async () => {
    const { useSandboxStore, sent } = await loadStore(null)
    await useSandboxStore.getState().reverseSelection(1)
    expect(sent(0).params).toEqual({ startSample: 0, endSample: -1 })
  })
})

describe('sandboxStore.fadeSelection', () => {
  it('fades a real selection exactly', async () => {
    const { useSandboxStore, sent } = await loadStore(RANGE)
    await useSandboxStore.getState().fadeSelection(1, true)
    expect(sent(0).params).toMatchObject({ startSample: 12000, lengthSamples: 24000, fadeIn: true })
  })

  it('fades IN from the start of the layer up to the cursor', async () => {
    const { useSandboxStore, sent } = await loadStore(CURSOR)
    await useSandboxStore.getState().fadeSelection(1, true)
    expect(sent(0).params).toMatchObject({ startSample: 0, lengthSamples: 24000, fadeIn: true })
  })

  it('fades OUT from the cursor to the end of the layer', async () => {
    const { useSandboxStore, sent } = await loadStore(CURSOR)
    await useSandboxStore.getState().fadeSelection(1, false)
    expect(sent(0).params).toMatchObject({ startSample: 24000, lengthSamples: LENGTH - 24000, fadeIn: false })
  })

  it('covers the whole layer when the cursor sits on the edge the fade starts from', async () => {
    // Cursor at 0: nothing lies between the start and the cursor to fade in.
    const a = await loadStore({ startSample: 0, endSample: 0 })
    await a.useSandboxStore.getState().fadeSelection(1, true)
    expect(a.sent(0).params).toMatchObject({ startSample: 0, lengthSamples: LENGTH })

    // Cursor at the end: nothing lies between the cursor and the end to fade out.
    const b = await loadStore({ startSample: LENGTH, endSample: LENGTH })
    await b.useSandboxStore.getState().fadeSelection(1, false)
    expect(b.sent(0).params).toMatchObject({ startSample: 0, lengthSamples: LENGTH })
  })

  it('does nothing before the layer has rendered audio to measure', async () => {
    const { useSandboxStore, stackAdd } = await loadStore(CURSOR)
    useSandboxStore.setState({ layers: [readyLayer({ renderedBuffer: null })] })
    await useSandboxStore.getState().fadeSelection(1, true)
    expect(stackAdd).not.toHaveBeenCalled()
  })
})

describe('sandboxStore.selectAll', () => {
  it('selects the whole active layer', async () => {
    const { useSandboxStore } = await loadStore(CURSOR)
    useSandboxStore.getState().selectAll()
    expect(useSandboxStore.getState().selection).toEqual({ startSample: 0, endSample: LENGTH })
  })

  it('leaves the selection alone with no rendered layer', async () => {
    const { useSandboxStore } = await loadStore(CURSOR)
    useSandboxStore.setState({ layers: [readyLayer({ renderedBuffer: null })] })
    useSandboxStore.getState().selectAll()
    expect(useSandboxStore.getState().selection).toEqual(CURSOR)
  })
})

describe('sandboxStore.addOp opens what it added', () => {
  it('selects a new op that has controls to set', async () => {
    const { useSandboxStore } = await loadStore(RANGE)
    await useSandboxStore.getState().gainSelection(1, 0)
    expect(useSandboxStore.getState().selectedOpId).toBe(100)
  })

  it('leaves the stack selection alone for a structural edit', async () => {
    const { useSandboxStore } = await loadStore(RANGE)
    await useSandboxStore.getState().addOp(1, { type: 'trim', params: { startSample: 12000, endSample: 36000 } })
    expect(useSandboxStore.getState().selectedOpId).toBeNull()
  })

  it('does not steal the stack selection for an op added to a layer that is not showing', async () => {
    const { useSandboxStore } = await loadStore(RANGE)
    useSandboxStore.setState({ layers: [readyLayer(), readyLayer({ id: 2, name: 'DRUMS' })] })
    await useSandboxStore.getState().addOp(2, { type: 'gain', params: { startSample: 0, endSample: -1, gainDb: 0 } })
    expect(useSandboxStore.getState().selectedOpId).toBeNull()
  })
})

describe('sandboxStore.selectTool', () => {
  it('arms one tool at a time, and spectral tools switch to the spectral view', async () => {
    const { useSandboxStore } = await loadStore(CURSOR)
    const s = () => useSandboxStore.getState()

    s().selectTool('envelope')
    expect([s().envelopeEditMode, s().paintEditMode, s().spcSelectMode]).toEqual([true, false, false])
    expect(s().viewMode).toBe('wav') // the envelope draws over either view

    s().selectTool('paint')
    expect([s().envelopeEditMode, s().paintEditMode, s().spcSelectMode]).toEqual([false, true, false])
    expect(s().viewMode).toBe('spc')

    s().selectTool('region')
    expect([s().envelopeEditMode, s().paintEditMode, s().spcSelectMode]).toEqual([false, false, true])

    s().selectTool('select')
    expect([s().envelopeEditMode, s().paintEditMode, s().spcSelectMode]).toEqual([false, false, false])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeEffect(nodeId, pluginId, position, bypassed = false) {
  return { nodeId, pluginId, position, bypassed }
}

async function loadEffectChainStoreFixture() {
  return import('./effectChainStore.js')
}

describe('effectChainStore FX mode safety gate', () => {
  let audio
  let projectLoadedHandler = null

  beforeEach(() => {
    vi.resetModules()
    projectLoadedHandler = null

    audio = {
      getEffectChain: vi.fn(async () => '[]'),
      getMasterEffectChain: vi.fn(async () => '[]'),
      addEffect: vi.fn(async () => true),
      addMasterEffect: vi.fn(async () => true),
      removeEffect: vi.fn(async () => true),
      removeMasterEffect: vi.fn(async () => true),
      moveEffect: vi.fn(async () => true),
      moveMasterEffect: vi.fn(async () => true),
      setEffectBypass: vi.fn(async () => true),
      setMasterEffectBypass: vi.fn(async () => true),
    }

    globalThis.window = {
      xleth: {
        audio,
        onGraphChanged: vi.fn(() => () => {}),
        onProjectLoaded: vi.fn((callback) => {
          projectLoadedHandler = callback
          return () => {}
        }),
      },
    }
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('defaults fxMode and fxPanelView to chain and seeds them on fetch', async () => {
    const {
      default: useEffectChainStore,
      DEFAULT_FX_MODE,
      DEFAULT_FX_PANEL_VIEW,
      resolveFxMode,
      resolveFxPanelView,
    } = await loadEffectChainStoreFixture()

    expect(resolveFxMode(useEffectChainStore.getState().fxModes, '7')).toBe(DEFAULT_FX_MODE)
    expect(resolveFxPanelView(useEffectChainStore.getState().fxPanelViews, '7')).toBe(DEFAULT_FX_PANEL_VIEW)

    await useEffectChainStore.getState().fetchChain('7')

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('chain')
    expect(state.fxPanelViews['7']).toBe('chain')
    expect(audio.getEffectChain).toHaveBeenCalledWith(7)
  })

  it('keeps add, remove, move, and bypass mutations working in chain mode', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1),
    ]
    const chainAfterAdd = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1),
      makeEffect(13, 'reverb', 2),
    ]
    const chainAfterRemove = [
      makeEffect(12, 'delay', 0),
      makeEffect(13, 'reverb', 1),
    ]
    const chainAfterMove = [
      makeEffect(13, 'reverb', 0),
      makeEffect(12, 'delay', 1),
    ]
    const chainAfterBypass = [
      makeEffect(13, 'reverb', 0, true),
      makeEffect(12, 'delay', 1),
    ]

    audio.getEffectChain
      .mockResolvedValueOnce(JSON.stringify(chainAfterAdd))
      .mockResolvedValueOnce(JSON.stringify(chainAfterRemove))
      .mockResolvedValueOnce(JSON.stringify(chainAfterMove))
      .mockResolvedValueOnce(JSON.stringify(chainAfterBypass))

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'chain' },
      fxPanelViews: { '7': 'chain' },
    })

    await useEffectChainStore.getState().addEffect('7', 'reverb')
    expect(audio.addEffect).toHaveBeenCalledWith(7, 'reverb', 2)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterAdd)

    await useEffectChainStore.getState().removeEffect('7', 11)
    expect(audio.removeEffect).toHaveBeenCalledWith(7, 11)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterRemove)

    await useEffectChainStore.getState().moveEffect('7', 12, 1)
    expect(audio.moveEffect).toHaveBeenCalledWith(7, 12, 1)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterMove)

    await useEffectChainStore.getState().setBypass('7', 13, true)
    expect(audio.setEffectBypass).toHaveBeenCalledWith(7, 13, true)
    expect(useEffectChainStore.getState().chains['7']).toEqual(chainAfterBypass)
  })

  it('blocks chain mutations when fxMode is graph', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const baseChain = [
      makeEffect(11, 'compressor', 0),
      makeEffect(12, 'delay', 1),
    ]

    useEffectChainStore.setState({
      chains: { '7': baseChain },
      fxModes: { '7': 'graph' },
      fxPanelViews: { '7': 'graphShell' },
    })

    await expect(useEffectChainStore.getState().addEffect('7', 'reverb')).resolves.toBe(false)
    await expect(useEffectChainStore.getState().removeEffect('7', 11)).resolves.toBe(false)
    await expect(useEffectChainStore.getState().moveEffect('7', 12, 0)).resolves.toBe(false)
    await expect(useEffectChainStore.getState().setBypass('7', 12, true)).resolves.toBe(false)

    expect(audio.addEffect).not.toHaveBeenCalled()
    expect(audio.removeEffect).not.toHaveBeenCalled()
    expect(audio.moveEffect).not.toHaveBeenCalled()
    expect(audio.setEffectBypass).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().chains['7']).toEqual(baseChain)
  })

  it('resets renderer-only mode and panel view state on project load', async () => {
    const { default: useEffectChainStore } = await loadEffectChainStoreFixture()
    const refreshedChain = [makeEffect(11, 'compressor', 0)]

    audio.getEffectChain.mockResolvedValueOnce(JSON.stringify(refreshedChain))

    useEffectChainStore.setState({
      chains: { '7': [makeEffect(11, 'compressor', 0)] },
      fxModes: { '7': 'graph' },
      fxPanelViews: { '7': 'graphShell' },
    })

    expect(projectLoadedHandler).toBeTypeOf('function')

    projectLoadedHandler()
    await Promise.resolve()

    const state = useEffectChainStore.getState()
    expect(state.fxModes['7']).toBe('chain')
    expect(state.fxPanelViews['7']).toBe('chain')
    expect(state.chains['7']).toEqual(refreshedChain)
    expect(audio.getEffectChain).toHaveBeenCalledWith(7)
  })
})

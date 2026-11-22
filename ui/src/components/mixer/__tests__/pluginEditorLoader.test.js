import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const VST = 'VST3-Serum-1a2b3c-58667358'

function makeAudio(statuses) {
  const queue = [...statuses]
  return {
    openPluginEditor: vi.fn(async () => ({ hasEditor: true })),
    getPluginEditorStatus: vi.fn(async () => queue.shift() ?? { status: 'opening' }),
    closePluginEditor: vi.fn(async () => true),
  }
}

async function load() {
  vi.resetModules()
  return import('../pluginEditorLoader.js')
}

const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms) }

describe('pluginEditorLoader', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); delete globalThis.window })

  it('polls until the editor window is open, then clears the screen', async () => {
    const m = await load()
    const audio = makeAudio([{ status: 'opening' }, { status: 'opening' }, { status: 'open' }])

    expect(m.openPluginEditorWithLoading({ trackId: 3, nodeId: 9, pluginId: VST, audio })).toBe(true)
    expect(audio.openPluginEditor).toHaveBeenCalledWith(3, 9)
    expect(m.usePluginLoadStore.getState().job.phase).toBe('opening')

    await flush(1000)
    expect(audio.getPluginEditorStatus).toHaveBeenCalledTimes(3)
    expect(m.usePluginLoadStore.getState().job).toBeNull()
  })

  it('drops a repeat request while one is loading, but replaces a failed one', async () => {
    const m = await load()
    const audio = makeAudio([{ status: 'failed', error: 'plugin returned null editor (no UI)' }])

    expect(m.openPluginEditorWithLoading({ trackId: 3, nodeId: 9, pluginId: VST, audio })).toBe(true)
    expect(m.openPluginEditorWithLoading({ trackId: 3, nodeId: 9, pluginId: VST, audio })).toBe(false)
    expect(audio.openPluginEditor).toHaveBeenCalledTimes(1)

    await flush(0)
    const job = m.usePluginLoadStore.getState().job
    expect(job.phase).toBe('failed')
    expect(job.visible).toBe(true)
    expect(m.describePluginLoadError(job.error)).toBe('This plugin has no editor window of its own.')

    expect(m.openPluginEditorWithLoading({ trackId: 3, nodeId: 9, pluginId: VST, audio })).toBe(true)
    expect(audio.openPluginEditor).toHaveBeenCalledTimes(2)
  })

  it('retry reopens after a failure; cancel while opening closes the editor host', async () => {
    const m = await load()
    const audio = makeAudio([{ status: 'failed', error: 'editor-host-error' }])

    m.openPluginEditorWithLoading({ trackId: 3, nodeId: 9, pluginId: VST, audio })
    await flush(0)
    expect(m.usePluginLoadStore.getState().job.phase).toBe('failed')

    m.retryPluginLoad()
    expect(audio.openPluginEditor).toHaveBeenCalledTimes(2)
    expect(m.usePluginLoadStore.getState().job.phase).toBe('opening')

    m.cancelPluginLoad()
    expect(audio.closePluginEditor).toHaveBeenCalledWith(3, 9)
    expect(m.usePluginLoadStore.getState().job).toBeNull()
    await flush(1000)
    expect(m.usePluginLoadStore.getState().job).toBeNull()
  })

  it('only shows the screen after 250 ms, so an already-open editor never flashes it', async () => {
    const m = await load()
    const audio = makeAudio([{ status: 'opening' }])
    m.openPluginEditorWithLoading({ trackId: 3, nodeId: 9, pluginId: VST, audio })
    expect(m.usePluginLoadStore.getState().job.visible).toBe(false)
    await flush(260)
    expect(m.usePluginLoadStore.getState().job.visible).toBe(true)
  })

  it('treats stock effects and placeholders as not third-party', async () => {
    const m = await load()
    expect(m.isThirdPartyPluginId('reverb')).toBe(false)
    expect(m.isThirdPartyPluginId('placeholder')).toBe(false)
    expect(m.isThirdPartyPluginId(VST)).toBe(true)
  })
})

describe('effectChainStore.addEffect with a third-party plugin', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); delete globalThis.window })

  it('opens the editor once inserted and ignores a repeat click while loading', async () => {
    vi.resetModules()
    const audio = {
      ...makeAudio([{ status: 'open' }]),
      addEffect: vi.fn(async () => ({ nodeId: 42 })),
      getEffectChain: vi.fn(async () => '[]'),
    }
    globalThis.window = { xleth: { audio } }
    const { default: useEffectChainStore } = await import('../../../stores/effectChainStore.js')
    const loader = await import('../pluginEditorLoader.js')
    useEffectChainStore.setState({ chains: { '7': [] }, fxModes: { '7': 'chain' } })

    const first = useEffectChainStore.getState().addEffect('7', VST)
    await expect(useEffectChainStore.getState().addEffect('7', VST)).resolves.toBe(false)
    await first
    await flush(0)

    expect(audio.addEffect).toHaveBeenCalledTimes(1)
    expect(audio.openPluginEditor).toHaveBeenCalledWith(7, 42)
    expect(loader.usePluginLoadStore.getState().job).toBeNull()
  })
})

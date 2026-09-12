import { beforeEach, describe, expect, it, vi } from 'vitest'

// Coverage for the separation session store (P4-1). The contract being
// defended, in order of how badly each one bites when it breaks:
//
//   1. Stems land as NEW LAYERS through the ordinary layer-add path.
//      Separation is a source generator, never an op.
//   2. A job's stems are imported exactly once, however many times the
//      progress feed says 'done'.
//   3. The active layer's RENDERED buffer is what gets separated, not its
//      untrimmed source file.
//   4. The strip's mount path never boots the sidecar.

function baseLayer(overrides = {}) {
  return {
    id: 1,
    name: 'Verse',
    sourceBufferId: 5,
    bufferSampleRate: 44100,
    ops: [],
    renderState: 'ready',
    renderedBuffer: {
      numChannels: 2,
      numSamples: 4,
      sampleRate: 44100,
      channels: [new Float32Array([0, 1, 0, -1]), new Float32Array([0, 1, 0, -1])],
    },
    ...overrides,
  }
}

function doneJob(overrides = {}) {
  return {
    id: 'job-1',
    state: 'done',
    phase: 'writing',
    progress: 1,
    tier: 'fast',
    label: 'Verse',
    device: 'cpu',
    stems: [
      { name: 'Vocals', path: 'C:/stems/Verse [Vocals].wav', sampleRate: 44100, durationSec: 3 },
      { name: 'Instrumental', path: 'C:/stems/Verse [Instrumental].wav', sampleRate: 44100, durationSec: 3 },
    ],
    ...overrides,
  }
}

async function loadStores({ separation = {}, layers = [baseLayer()], activeLayerId = 1 } = {}) {
  vi.resetModules()
  const progressHandlers = []
  globalThis.window = {
    xleth: {
      separation: {
        getStatus: vi.fn(async () => ({ running: false, python: { version: '3.11.0' } })),
        checkEnvironment: vi.fn(async () => ({ ok: true })),
        listModels: vi.fn(async () => ({ models: [], tiers: [] })),
        separateBuffer: vi.fn(async () => ({ id: 'job-1', state: 'queued', progress: 0, tier: 'fast' })),
        cancel: vi.fn(async () => ({ cancelled: true })),
        onProgress: vi.fn((cb) => { progressHandlers.push(cb); return () => {} }),
        ...separation,
      },
      sandbox: {},
    },
  }

  const sandboxMod = await import('../sandboxStore.js')
  const useSandboxStore = sandboxMod.default
  const addSourceFromFile = vi.fn(async (path, name) => ({ id: 90 + progressHandlers.length, name, path }))
  useSandboxStore.setState({ layers, activeLayerId, addSourceFromFile })

  const sepMod = await import('../separationStore.js')
  return { useSeparationStore: sepMod.default, useSandboxStore, addSourceFromFile, progressHandlers }
}

describe('separationStore', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('sends the active layer\'s RENDERED buffer, not its source file', async () => {
    const { useSeparationStore } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')

    const call = window.xleth.separation.separateBuffer.mock.calls[0][0]
    expect(call.sampleRate).toBe(44100)
    expect(call.channels).toHaveLength(2)
    expect(Array.from(call.channels[0])).toEqual([0, 1, 0, -1])
    expect(call.tier).toBe('fast')
    expect(call.name).toBe('Verse')
  })

  it('refuses to start on a layer that has not finished rendering', async () => {
    const { useSeparationStore } = await loadStores({
      layers: [baseLayer({ renderState: 'rendering', renderedBuffer: null })],
    })
    const job = await useSeparationStore.getState().separateActiveLayer('fast')
    expect(job).toBeNull()
    expect(window.xleth.separation.separateBuffer).not.toHaveBeenCalled()
    expect(useSeparationStore.getState().jobError).toMatch(/finished rendering/i)
  })

  it('refuses to start with no layer selected', async () => {
    const { useSeparationStore } = await loadStores({ layers: [], activeLayerId: null })
    expect(await useSeparationStore.getState().separateActiveLayer('fast')).toBeNull()
    expect(useSeparationStore.getState().jobError).toMatch(/select a layer/i)
  })

  it('adds every stem as a new layer through the shared layer-add path', async () => {
    const { useSeparationStore, addSourceFromFile } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')
    await useSeparationStore.getState().importStems(doneJob())

    expect(addSourceFromFile).toHaveBeenCalledTimes(2)
    expect(addSourceFromFile.mock.calls.map((c) => c[1])).toEqual([
      'Verse [Vocals]', 'Verse [Instrumental]',
    ])
    expect(addSourceFromFile.mock.calls.map((c) => c[0])).toEqual([
      'C:/stems/Verse [Vocals].wav', 'C:/stems/Verse [Instrumental].wav',
    ])
    expect(useSeparationStore.getState().importState).toBe('done')
  })

  it('imports a job\'s stems exactly once however often "done" arrives', async () => {
    // The progress poll can deliver a final 'done' tick and a manual getJob
    // back to back; importing twice would silently double every stem layer.
    const { useSeparationStore, addSourceFromFile } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')

    const job = doneJob()
    useSeparationStore.getState().applyJobUpdate(job)
    useSeparationStore.getState().applyJobUpdate(job)
    useSeparationStore.getState().applyJobUpdate({ ...job })
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(addSourceFromFile).toHaveBeenCalledTimes(2)
  })

  it('ignores progress for a job the user has already replaced', async () => {
    const { useSeparationStore, addSourceFromFile } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')
    // A cancelled run's last tick landing after a new run started.
    useSeparationStore.getState().applyJobUpdate(doneJob({ id: 'stale-job' }))
    await new Promise((r) => setTimeout(r, 0))

    expect(addSourceFromFile).not.toHaveBeenCalled()
    expect(useSeparationStore.getState().job.id).toBe('job-1')
  })

  it('surfaces a failed job as an error rather than importing nothing silently', async () => {
    const { useSeparationStore } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')
    useSeparationStore.getState().applyJobUpdate({
      id: 'job-1', state: 'error', phase: 'separating', progress: 0.4,
      error: 'checksum mismatch', stems: [],
    })
    expect(useSeparationStore.getState().jobError).toBe('checksum mismatch')
  })

  it('surfaces a start failure (e.g. the 403 license gate) on the store', async () => {
    const { useSeparationStore } = await loadStores({
      separation: {
        separateBuffer: vi.fn(async () => {
          throw new Error("model 'x' has license status 'PENDING-AUDIT'")
        }),
      },
    })
    expect(await useSeparationStore.getState().separateActiveLayer('fast')).toBeNull()
    expect(useSeparationStore.getState().jobError).toMatch(/PENDING-AUDIT/)
  })

  it('refreshStatus does not boot the sidecar', async () => {
    const { useSeparationStore } = await loadStores()
    await useSeparationStore.getState().refreshStatus()
    expect(window.xleth.separation.getStatus).toHaveBeenCalled()
    expect(window.xleth.separation.listModels).not.toHaveBeenCalled()
    expect(window.xleth.separation.separateBuffer).not.toHaveBeenCalled()
  })

  it('subscribes to the progress feed exactly once', async () => {
    const { useSeparationStore } = await loadStores()
    useSeparationStore.getState().ensureSubscribed()
    useSeparationStore.getState().ensureSubscribed()
    useSeparationStore.getState().ensureSubscribed()
    expect(window.xleth.separation.onProgress).toHaveBeenCalledTimes(1)
  })

  it('cancel is a no-op once the job is terminal', async () => {
    const { useSeparationStore } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')
    useSeparationStore.setState({ job: { id: 'job-1', state: 'done', stems: [] } })
    expect(await useSeparationStore.getState().cancel()).toBe(false)
    expect(window.xleth.separation.cancel).not.toHaveBeenCalled()
  })

  it('cancel reaches the sidecar while the job is live', async () => {
    const { useSeparationStore } = await loadStores()
    await useSeparationStore.getState().separateActiveLayer('fast')
    useSeparationStore.setState({ job: { id: 'job-1', state: 'running', stems: [] } })
    expect(await useSeparationStore.getState().cancel()).toBe(true)
    expect(window.xleth.separation.cancel).toHaveBeenCalledWith('job-1')
  })
})

// ── The licence acknowledgement round-trip (P4-2) ─────────────────────────
//
// The BALANCED model is CC BY-NC 4.0. The sidecar refuses it with a 409 until
// the caller says the condition has been accepted. The contract here:
//
//   1. A 409 is a QUESTION, not an error. It must not land in jobError, and
//      it must not leave a phantom job behind.
//   2. Accepting retries the tier the user originally pressed.
//   3. The answer is remembered against the TEXT the user saw, so an edit to
//      the terms asks again instead of inheriting consent.
//   4. The FAST tier is never gated — if every model asked, the question
//      would stop meaning anything on the one that has to.

const NC_TEXT = 'The BALANCED model is licensed CC BY-NC 4.0: non-commercial use only.'

function licenseRequired(overrides = {}) {
  return {
    licenseRequired: {
      code: 'license-acknowledgement-required',
      modelId: 'mel_roformer_becruily_deux',
      tier: 'balanced',
      spdx: 'CC-BY-NC-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      attribution: 'Mel-Band RoFormer “deux” — model by becruily, CC BY-NC 4.0.',
      message: NC_TEXT,
      ...overrides,
    },
  }
}

function balancedCatalog() {
  return {
    tiers: [
      { id: 'fast', label: 'FAST', modelId: 'mdx_kim_vocal_2', enabled: true, order: 0 },
      { id: 'balanced', label: 'BALANCED', modelId: 'mel_roformer_becruily_deux', enabled: true, order: 1 },
      { id: 'best', label: 'BEST', modelId: null, enabled: false, order: 2 },
    ],
    models: [
      {
        id: 'mdx_kim_vocal_2',
        name: 'MDX-Net Kim Vocal 2',
        device: 'cuda',
        runtimeOk: true,
        secondsPerSecond: 0.05,
        fixedSeconds: 0,
        speedMeasured: true,
        license: { cleared: true, requiresAcknowledgement: false, attribution: 'Kim Vocal 2 — UVR (MIT).' },
      },
      {
        id: 'mel_roformer_becruily_deux',
        name: 'Mel-Band RoFormer “deux”',
        device: 'cpu',
        runtimeOk: true,
        secondsPerSecond: 3.09,
        fixedSeconds: 40,
        speedMeasured: true,
        sizeBytes: 435_007_990,
        license: {
          cleared: true,
          requiresAcknowledgement: true,
          acknowledgement: NC_TEXT,
          commercialUse: false,
          spdx: 'CC-BY-NC-4.0',
          attribution: 'Mel-Band RoFormer “deux” — model by becruily, CC BY-NC 4.0.',
        },
      },
    ],
  }
}

// A minimal localStorage, so the "remembered" half of the contract is real
// rather than asserted against a no-op.
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    _map: map,
  }
}

describe('separationStore — licence acknowledgement', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('turns a 409 into a prompt, not an error, and starts no job', async () => {
    const { useSeparationStore } = await loadStores({
      separation: { separateBuffer: vi.fn(async () => licenseRequired()) },
    })
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    const result = await useSeparationStore.getState().separateActiveLayer('balanced')
    expect(result).toBeNull()

    const state = useSeparationStore.getState()
    expect(state.jobError).toBeNull()
    expect(state.job).toBeNull()
    expect(state.starting).toBe(false)
    expect(state.licensePrompt.spdx).toBe('CC-BY-NC-4.0')
    expect(state.licensePrompt.tier).toBe('balanced')
    expect(state.licensePrompt.message).toBe(NC_TEXT)
  })

  it('accepting retries the tier the user pressed, now acknowledged', async () => {
    let calls = 0
    const separateBuffer = vi.fn(async (payload) => {
      calls += 1
      if (!payload.acknowledgeLicense) return licenseRequired()
      return { id: 'job-9', state: 'queued', progress: 0, tier: payload.tier }
    })
    const { useSeparationStore } = await loadStores({ separation: { separateBuffer } })
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    await useSeparationStore.getState().separateActiveLayer('balanced')
    const job = await useSeparationStore.getState().acceptLicense()

    expect(calls).toBe(2)
    expect(separateBuffer.mock.calls[0][0].acknowledgeLicense).toBe(false)
    expect(separateBuffer.mock.calls[1][0].acknowledgeLicense).toBe(true)
    expect(separateBuffer.mock.calls[1][0].tier).toBe('balanced')
    expect(job.id).toBe('job-9')
    expect(useSeparationStore.getState().licensePrompt).toBeNull()
  })

  it('remembers the answer so the next run is not gated again', async () => {
    const separateBuffer = vi.fn(async (payload) => (
      payload.acknowledgeLicense
        ? { id: 'job-9', state: 'queued', progress: 0, tier: payload.tier }
        : licenseRequired()))
    const { useSeparationStore } = await loadStores({ separation: { separateBuffer } })
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    await useSeparationStore.getState().separateActiveLayer('balanced')
    await useSeparationStore.getState().acceptLicense()
    separateBuffer.mockClear()

    await useSeparationStore.getState().separateActiveLayer('balanced')
    expect(separateBuffer.mock.calls[0][0].acknowledgeLicense).toBe(true)
    expect(useSeparationStore.getState().licensePrompt).toBeNull()
  })

  it('asks again when the licence text itself changes', async () => {
    // Consent to a previous sentence is not consent to a new one.
    const separateBuffer = vi.fn(async (payload) => (
      payload.acknowledgeLicense
        ? { id: 'job-9', state: 'queued', progress: 0, tier: payload.tier }
        : licenseRequired()))
    const { useSeparationStore } = await loadStores({ separation: { separateBuffer } })
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    await useSeparationStore.getState().separateActiveLayer('balanced')
    await useSeparationStore.getState().acceptLicense()

    const revised = balancedCatalog()
    revised.models[1].license.acknowledgement = 'Revised terms: now also forbids resale of the stems.'
    useSeparationStore.setState({ catalog: revised })
    separateBuffer.mockClear()

    await useSeparationStore.getState().separateActiveLayer('balanced')
    expect(separateBuffer.mock.calls[0][0].acknowledgeLicense).toBe(false)
  })

  it('never gates a model whose licence carries no condition', async () => {
    const { useSeparationStore } = await loadStores()
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    await useSeparationStore.getState().separateActiveLayer('fast')
    expect(window.xleth.separation.separateBuffer.mock.calls[0][0].acknowledgeLicense).toBe(false)
    expect(useSeparationStore.getState().licensePrompt).toBeNull()
  })

  it('declining clears the prompt and leaves nothing running', async () => {
    const { useSeparationStore } = await loadStores({
      separation: { separateBuffer: vi.fn(async () => licenseRequired()) },
    })
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    await useSeparationStore.getState().separateActiveLayer('balanced')
    useSeparationStore.getState().declineLicense()

    const state = useSeparationStore.getState()
    expect(state.licensePrompt).toBeNull()
    expect(state.job).toBeNull()
    expect(state.jobError).toBeNull()
  })

  it('survives a browser that refuses storage entirely', async () => {
    // A private window, or site data the browser will not hand over. Failing
    // closed means the user is asked again — the only safe direction.
    const separateBuffer = vi.fn(async (payload) => (
      payload.acknowledgeLicense
        ? { id: 'job-9', state: 'queued', progress: 0, tier: payload.tier }
        : licenseRequired()))
    const { useSeparationStore } = await loadStores({ separation: { separateBuffer } })
    window.localStorage = {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
    }
    useSeparationStore.setState({ catalog: balancedCatalog() })

    await useSeparationStore.getState().separateActiveLayer('balanced')
    expect(useSeparationStore.getState().licensePrompt).not.toBeNull()
    const job = await useSeparationStore.getState().acceptLicense()
    expect(job.id).toBe('job-9')
  })
})

describe('separationStore — tiers come from the manifest', () => {
  it('joins each tier to its model so the strip needs no hardcoded list', async () => {
    const { useSeparationStore } = await loadStores()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    const tiers = useSeparationStore.getState().tiers()
    expect(tiers.map((t) => t.id)).toEqual(['fast', 'balanced', 'best'])
    expect(tiers[1].model.id).toBe('mel_roformer_becruily_deux')
    // Per-model, not per-sidecar: the two tiers run on different runtimes.
    expect(tiers[0].model.device).toBe('cuda')
    expect(tiers[1].model.device).toBe('cpu')
    // An unwired tier has no model rather than a stale one.
    expect(tiers[2].model).toBeNull()
  })

  it('returns an empty list before the catalog is read, so nothing is invented', async () => {
    const { useSeparationStore } = await loadStores()
    expect(useSeparationStore.getState().tiers()).toEqual([])
    expect(useSeparationStore.getState().modelForTier('balanced')).toBeNull()
  })
})

describe('separationStore — ENSEMBLE', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('candidates exclude an unwired or unaudited tier', async () => {
    const { useSeparationStore } = await loadStores()
    const catalog = balancedCatalog()
    // BEST as it really ships: wired, but PENDING-AUDIT.
    catalog.tiers[2] = { id: 'best', label: 'BEST', modelId: 'ft1', enabled: true, order: 2 }
    catalog.models.push({ id: 'ft1', license: { cleared: false } })
    useSeparationStore.setState({ catalog })

    const ids = useSeparationStore.getState().ensembleCandidates().map((t) => t.id)
    expect(ids).toEqual(['fast', 'balanced'])
  })

  it('sends both model ids and drops the single-tier field', async () => {
    const { useSeparationStore } = await loadStores()
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog(), ensemblePair: ['fast', 'balanced'] })

    await useSeparationStore.getState().separateActiveLayerEnsemble()

    const call = window.xleth.separation.separateBuffer.mock.calls[0][0]
    expect(call.ensembleModelIds).toEqual(['mdx_kim_vocal_2', 'mel_roformer_becruily_deux'])
    expect(call.tier).toBeUndefined()
  })

  it('refuses without a pair selected, and starts nothing', async () => {
    const { useSeparationStore } = await loadStores()
    useSeparationStore.setState({ catalog: balancedCatalog() })

    const result = await useSeparationStore.getState().separateActiveLayerEnsemble()
    expect(result).toBeNull()
    expect(window.xleth.separation.separateBuffer).not.toHaveBeenCalled()
    expect(useSeparationStore.getState().jobError).toMatch(/pick two/i)
  })

  it('a 409 from either half of the pair becomes a retryable prompt', async () => {
    const separateBuffer = vi.fn(async (payload) => (
      payload.acknowledgeLicense
        ? { id: 'job-9', state: 'queued', progress: 0, tier: 'ensemble' }
        : licenseRequired()))
    const { useSeparationStore } = await loadStores({ separation: { separateBuffer } })
    window.localStorage = fakeStorage()
    useSeparationStore.setState({ catalog: balancedCatalog(), ensemblePair: ['fast', 'balanced'] })

    await useSeparationStore.getState().separateActiveLayerEnsemble()
    expect(useSeparationStore.getState().licensePrompt.mode).toBe('ensemble')
    expect(useSeparationStore.getState().licensePrompt.pair).toEqual(['fast', 'balanced'])

    const job = await useSeparationStore.getState().acceptLicense()
    expect(separateBuffer.mock.calls[1][0].acknowledgeLicense).toBe(true)
    expect(job.id).toBe('job-9')
  })
})

describe('separationStore — DE-BLEED', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('is off by default and carried through a normal tier run', async () => {
    const { useSeparationStore } = await loadStores()
    expect(useSeparationStore.getState().deBleed).toBe(false)

    await useSeparationStore.getState().separateActiveLayer('fast')
    expect(window.xleth.separation.separateBuffer.mock.calls[0][0].deBleed).toBe(false)
  })

  it('composes with a single tier and with an ensemble run alike', async () => {
    const { useSeparationStore } = await loadStores()
    window.localStorage = fakeStorage()
    useSeparationStore.getState().setDeBleed(true)
    useSeparationStore.setState({ catalog: balancedCatalog(), ensemblePair: ['fast', 'balanced'] })

    await useSeparationStore.getState().separateActiveLayer('fast')
    expect(window.xleth.separation.separateBuffer.mock.calls[0][0].deBleed).toBe(true)

    await useSeparationStore.getState().separateActiveLayerEnsemble()
    expect(window.xleth.separation.separateBuffer.mock.calls[1][0].deBleed).toBe(true)
  })
})

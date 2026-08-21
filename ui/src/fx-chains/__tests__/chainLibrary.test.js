import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyChainEffects,
  applySavedChain,
  buildAvailablePluginIds,
  captureChainEffects,
  isMasterKey,
  listChains,
  openLibraryFolder,
  saveChainFromTrack,
} from '../chainLibrary.js'
import { CHAIN_MAGIC, CHAIN_VERSION } from '../chainDocument.js'

const slots = [
  { nodeId: 1, pluginId: 'xletheq', position: 0, bypassed: false },
  { nodeId: 2, pluginId: 'reverb', position: 1, bypassed: true },
]

const snapshot = JSON.stringify({
  nodes: [
    { nodeId: 2, pluginId: 'reverb', bypassed: true, state: 'UkVW' },
    { nodeId: 1, pluginId: 'xletheq', bypassed: false, state: 'RVE=' },
  ],
})

let audio
let fxChains

beforeEach(() => {
  audio = {
    getEffectChainSnapshot: vi.fn(async () => snapshot),
    getMasterEffectChainSnapshot: vi.fn(async () => snapshot),
    applyEffectChainPreset: vi.fn(async () =>
      JSON.stringify({ ok: true, added: 2, skipped: [], effectCount: 2, undoable: true })),
    applyMasterEffectChainPreset: vi.fn(async () =>
      JSON.stringify({ ok: true, added: 2, skipped: [], effectCount: 2, undoable: true })),
  }
  fxChains = {
    list: vi.fn(async () => ({
      chains: [{ slug: 'cool-bass', folder: null, name: 'cool bass', effectCount: 2, pluginIds: [] }],
      folders: ['Drums'],
      root: 'C:\\fx-chains',
    })),
    load: vi.fn(async () => ({
      [CHAIN_MAGIC]: CHAIN_VERSION,
      name: 'cool bass',
      effects: [{ pluginId: 'xlethfilter', bypassed: false, state: 'Rg==' }],
    })),
    save: vi.fn(async () => ({ slug: 'cool-bass', folder: null, overwritten: false })),
    delete: vi.fn(async () => true),
    openFolder: vi.fn(async () => ({ ok: true, root: 'C:\\fx-chains', error: null })),
  }
  globalThis.window = { xleth: { audio, fxChains } }
})

afterEach(() => { delete globalThis.window })

describe('isMasterKey', () => {
  it('separates the master strip from numbered tracks', () => {
    expect(isMasterKey('master')).toBe(true)
    expect(isMasterKey('0')).toBe(false)
    expect(isMasterKey(3)).toBe(false)
  })
})

describe('captureChainEffects', () => {
  it('joins the ordered chain view with the snapshot state blobs', async () => {
    const result = await captureChainEffects('3', slots)
    expect(result.ok).toBe(true)
    expect(result.effects).toEqual([
      { pluginId: 'xletheq', bypassed: false, state: 'RVE=' },
      { pluginId: 'reverb', bypassed: true, state: 'UkVW' },
    ])
    expect(audio.getEffectChainSnapshot).toHaveBeenCalledWith(3)
  })

  it('routes the master strip to its own snapshot method', async () => {
    await captureChainEffects('master', slots)
    expect(audio.getMasterEffectChainSnapshot).toHaveBeenCalled()
    expect(audio.getEffectChainSnapshot).not.toHaveBeenCalled()
  })

  it('still captures plugin order when the snapshot is unreadable', async () => {
    audio.getEffectChainSnapshot = vi.fn(async () => 'not json')
    const result = await captureChainEffects('3', slots)
    expect(result.ok).toBe(true)
    expect(result.effects.map(e => e.pluginId)).toEqual(['xletheq', 'reverb'])
  })

  it('reports a thrown bridge error instead of rejecting', async () => {
    audio.getEffectChainSnapshot = vi.fn(async () => { throw new Error('engine down') })
    const result = await captureChainEffects('3', slots)
    expect(result).toEqual({ ok: false, error: 'engine down' })
  })

  it('fails cleanly with no audio bridge at all', async () => {
    globalThis.window = {}
    expect((await captureChainEffects('3', slots)).ok).toBe(false)
  })
})

describe('applyChainEffects', () => {
  it('replaces by default and marks the call undoable', async () => {
    const result = await applyChainEffects('2', [{ pluginId: 'reverb' }], { label: 'x' })
    expect(result.ok).toBe(true)
    const [trackId, payload, label, replace, undoable] = audio.applyEffectChainPreset.mock.calls[0]
    expect(trackId).toBe(2)
    expect(JSON.parse(payload)).toEqual([{ pluginId: 'reverb' }])
    expect(label).toBe('x')
    expect(replace).toBe(true)
    expect(undoable).toBe(true)
  })

  it('passes replace=false for append', async () => {
    await applyChainEffects('2', [{ pluginId: 'reverb' }], { mode: 'append' })
    expect(audio.applyEffectChainPreset.mock.calls[0][3]).toBe(false)
  })

  it('routes master through its own method with no trackId', async () => {
    await applyChainEffects('master', [{ pluginId: 'limiter' }], { label: 'm' })
    expect(audio.applyMasterEffectChainPreset).toHaveBeenCalled()
    expect(audio.applyEffectChainPreset).not.toHaveBeenCalled()
    expect(audio.applyMasterEffectChainPreset.mock.calls[0][0]).toBe('[{"pluginId":"limiter"}]')
  })

  it('surfaces the skipped list so uninstalled plugins can be named', async () => {
    audio.applyEffectChainPreset = vi.fn(async () =>
      JSON.stringify({ ok: true, added: 1, skipped: ['ozone11'], effectCount: 1 }))
    const result = await applyChainEffects('2', [{ pluginId: 'ozone11' }, { pluginId: 'reverb' }])
    expect(result.skipped).toEqual(['ozone11'])
  })

  it('reports an engine rejection as a failure, not a success', async () => {
    audio.applyEffectChainPreset = vi.fn(async () =>
      JSON.stringify({ ok: false, reason: 'effects_not_an_array' }))
    const result = await applyChainEffects('2', [])
    expect(result).toEqual({ ok: false, error: 'effects_not_an_array' })
  })

  it('refuses a non-array payload before touching the bridge', async () => {
    const result = await applyChainEffects('2', null)
    expect(result.ok).toBe(false)
    expect(audio.applyEffectChainPreset).not.toHaveBeenCalled()
  })
})

describe('saveChainFromTrack', () => {
  it('captures and writes a document with the ordered effects', async () => {
    const result = await saveChainFromTrack({ fxKey: '3', chainSlots: slots, name: '  cool bass ' })
    expect(result.ok).toBe(true)
    expect(result.effectCount).toBe(2)
    const [doc, folder] = fxChains.save.mock.calls[0]
    expect(doc.name).toBe('cool bass')
    expect(doc.effects.map(e => e.pluginId)).toEqual(['xletheq', 'reverb'])
    expect(folder).toBeNull()
  })

  it('omits strip state unless it is passed in', async () => {
    await saveChainFromTrack({ fxKey: '3', chainSlots: slots, name: 'a' })
    expect('strip' in fxChains.save.mock.calls[0][0]).toBe(false)

    await saveChainFromTrack({
      fxKey: '3', chainSlots: slots, name: 'b', strip: { volume: 0.5, pan: -0.2, spread: 1 },
    })
    expect(fxChains.save.mock.calls[1][0].strip).toEqual({ volume: 0.5, pan: -0.2, spread: 1 })
  })

  it('writes into a chosen folder', async () => {
    await saveChainFromTrack({ fxKey: '3', chainSlots: slots, name: 'for kick', folder: 'Drums' })
    expect(fxChains.save.mock.calls[0][1]).toBe('Drums')
  })

  it('refuses an unnamed chain and an empty one', async () => {
    expect((await saveChainFromTrack({ fxKey: '3', chainSlots: slots, name: '   ' })).ok).toBe(false)
    expect((await saveChainFromTrack({ fxKey: '3', chainSlots: [], name: 'x' })).ok).toBe(false)
    expect(fxChains.save).not.toHaveBeenCalled()
  })

  it('reports an overwrite so the caller can say so', async () => {
    fxChains.save = vi.fn(async () => ({ slug: 'x', folder: null, overwritten: true }))
    expect((await saveChainFromTrack({ fxKey: '3', chainSlots: slots, name: 'x' })).overwritten)
      .toBe(true)
  })
})

describe('applySavedChain', () => {
  it('loads the file then builds it onto the target', async () => {
    const result = await applySavedChain('2', 'Drums', 'for-kick', { mode: 'append' })
    expect(fxChains.load).toHaveBeenCalledWith('Drums', 'for-kick')
    expect(result.ok).toBe(true)
    expect(result.name).toBe('cool bass')
    // The chain's own name becomes the undo step's label.
    expect(audio.applyEffectChainPreset.mock.calls[0][2]).toBe('cool bass')
    expect(audio.applyEffectChainPreset.mock.calls[0][3]).toBe(false)
  })

  it('stops at the load when the file is not a chain', async () => {
    fxChains.load = vi.fn(async () => ({ hello: 1 }))
    const result = await applySavedChain('2', null, 'broken')
    expect(result.ok).toBe(false)
    expect(audio.applyEffectChainPreset).not.toHaveBeenCalled()
  })

  it('hands back strip state only when the file carried it', async () => {
    expect((await applySavedChain('2', null, 'a')).strip).toBeNull()

    fxChains.load = vi.fn(async () => ({
      [CHAIN_MAGIC]: CHAIN_VERSION,
      name: 'with strip',
      effects: [{ pluginId: 'reverb' }],
      strip: { volume: 0.7 },
    }))
    expect((await applySavedChain('2', null, 'b')).strip).toEqual({ volume: 0.7 })
  })
})

describe('listChains / openLibraryFolder', () => {
  it('normalizes the listing', async () => {
    const result = await listChains()
    expect(result.ok).toBe(true)
    expect(result.folders).toEqual(['Drums'])
    expect(result.chains).toHaveLength(1)
  })

  it('returns empty lists rather than throwing when the store is gone', async () => {
    globalThis.window = {}
    const result = await listChains()
    expect(result.ok).toBe(false)
    expect(result.chains).toEqual([])
  })

  it('reports the folder path back so a failure can name it', async () => {
    fxChains.openFolder = vi.fn(async () => ({ ok: false, root: 'C:\\fx-chains', error: 'nope' }))
    const result = await openLibraryFolder()
    expect(result.ok).toBe(false)
    expect(result.root).toBe('C:\\fx-chains')
  })
})

describe('buildAvailablePluginIds', () => {
  it('includes the stock catalog', () => {
    const ids = buildAvailablePluginIds([])
    expect(ids.has('reverb')).toBe(true)
    expect(ids.has('apex')).toBe(true)
  })

  it('includes scanned VST3s', () => {
    const ids = buildAvailablePluginIds([{ id: 'vst:ozone11', name: 'Ozone 11' }])
    expect(ids.has('vst:ozone11')).toBe(true)
  })

  it('does not claim an unscanned plugin is available', () => {
    expect(buildAvailablePluginIds([]).has('vst:ozone11')).toBe(false)
  })
})

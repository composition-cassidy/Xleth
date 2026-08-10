import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizePresetList, listPresets, savePreset, loadPreset, deletePreset, revertState,
} from '../presetManager.js'

const target = { trackId: 1, nodeId: 2, storeKey: '1' }

function installBridge({ fxPresets = {}, audio = {} } = {}) {
  globalThis.window = { xleth: { fxPresets, audio } }
}
afterEach(() => { delete globalThis.window })

describe('normalizePresetList', () => {
  it('groups factory/user, sorts by name, drops malformed rows', () => {
    const out = normalizePresetList({
      factory: [
        { slug: 'b', name: 'Bravo' },
        { slug: 'a', name: 'Alpha', author: 'x', created: 't', effectType: 'apex' },
        { slug: 'bad' },                 // no name -> dropped
        null,                            // dropped
      ],
      user: [{ slug: 'u', name: 'User One' }],
    })
    expect(out.factory.map(p => p.slug)).toEqual(['a', 'b'])
    expect(out.factory[0]).toMatchObject({ source: 'factory', author: 'x' })
    expect(out.factory[1]).toMatchObject({ source: 'factory', author: null })
    expect(out.user).toHaveLength(1)
    expect(out.user[0].source).toBe('user')
  })

  it('tolerates a partial / missing payload', () => {
    expect(normalizePresetList(undefined)).toEqual({ factory: [], user: [] })
    expect(normalizePresetList({ factory: null })).toEqual({ factory: [], user: [] })
  })
})

describe('bridge wiring is loud, never silent', () => {
  it('throws a named error when the preload bridge is missing', async () => {
    globalThis.window = { xleth: {} }   // no fxPresets namespace
    await expect(listPresets('apex')).rejects.toThrow(/window\.xleth\.fxPresets/)
  })

  it('throws when a specific bridge method is not wired', async () => {
    installBridge({ fxPresets: { /* list missing */ } })
    await expect(listPresets('apex')).rejects.toThrow(/method "list" is not wired/)
  })
})

describe('listPresets', () => {
  it('normalizes what the store returns', async () => {
    const list = vi.fn(async () => ({ factory: [{ slug: 'g', name: 'Glue' }], user: [] }))
    installBridge({ fxPresets: { list } })
    const out = await listPresets('compressor')
    expect(list).toHaveBeenCalledWith('compressor')
    expect(out.factory[0]).toMatchObject({ slug: 'g', name: 'Glue', source: 'factory' })
  })
})

describe('savePreset', () => {
  it('captures state and sends a valid preset envelope to the store', async () => {
    const save = vi.fn(async () => ({ slug: 'my-preset', overwritten: false }))
    installBridge({
      fxPresets: { save },
      audio: { getEffectParameters: vi.fn(async () => [{ id: 'ratio', value: 4 }]) },
    })
    const res = await savePreset('compressor', 'My Preset', target)
    expect(res.slug).toBe('my-preset')
    const sent = save.mock.calls[0][0]
    expect(sent).toMatchObject({ xlethFxPreset: 1, effectType: 'compressor', name: 'My Preset' })
    expect(sent.state).toEqual({ params: { ratio: 4 } })
    expect(Number.isNaN(Date.parse(sent.created))).toBe(false)
  })
})

describe('loadPreset', () => {
  it('applies a matching preset and returns { before, after } for one-step undo', async () => {
    const setEffectParameter = vi.fn()
    const load = vi.fn(async () => ({
      xlethFxPreset: 1, effectType: 'compressor', name: 'Punchy',
      created: '2026-01-01T00:00:00Z', state: { params: { ratio: 8 } },
    }))
    installBridge({
      fxPresets: { load },
      audio: {
        getEffectParameters: vi.fn(async () => [{ id: 'ratio', value: 4 }]), // pre-load state
        setEffectParameter,
      },
    })
    const { before, after, name } = await loadPreset('compressor', 'factory', 'punchy', target)
    expect(before).toEqual({ params: { ratio: 4 } })
    expect(after).toEqual({ params: { ratio: 8 } })
    expect(name).toBe('Punchy')
    expect(setEffectParameter).toHaveBeenCalledWith(1, 2, 'ratio', 8)
  })

  it('REFUSES an effectType mismatch and never applies it', async () => {
    const setEffectParameter = vi.fn()
    const load = vi.fn(async () => ({
      xlethFxPreset: 1, effectType: 'apex', name: 'Wrong', state: { params: { bandmix: 50 } },
    }))
    installBridge({ fxPresets: { load }, audio: { setEffectParameter, getEffectParameters: vi.fn() } })
    await expect(loadPreset('compressor', 'user', 'wrong', target))
      .rejects.toThrow(/is for "apex", not "compressor"/)
    expect(setEffectParameter).not.toHaveBeenCalled()
  })
})

describe('revertState / deletePreset', () => {
  it('revertState re-applies a blob through the adapter', async () => {
    const setEffectParameter = vi.fn()
    installBridge({ audio: { setEffectParameter } })
    await revertState('compressor', target, { params: { ratio: 3 } })
    expect(setEffectParameter).toHaveBeenCalledWith(1, 2, 'ratio', 3)
  })

  it('deletePreset forwards to the store', async () => {
    const del = vi.fn(async () => true)
    installBridge({ fxPresets: { delete: del } })
    expect(await deletePreset('apex', 'gone')).toBe(true)
    expect(del).toHaveBeenCalledWith('apex', 'gone')
  })
})

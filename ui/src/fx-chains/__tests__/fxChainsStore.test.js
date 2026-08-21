/**
 * Main-process FX chain file store — the containment and envelope rules that
 * keep a chain name from becoming a path.
 *
 * ui/electron-main/fx-chains.js is CommonJS and requires 'electron' at load, so
 * it is pulled in through createRequire with a stubbed electron module. Only the
 * pure exported helpers are exercised here; the IPC handlers are covered by the
 * renderer suite through their window.xleth.fxChains surface.
 */
import Module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

let store

beforeAll(() => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const require = Module.createRequire(import.meta.url)

  // The store registers ipcMain.handle at require time and resolves its root
  // through runtimePaths, both of which need Electron. Stub just enough.
  const original = Module._load
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain: { handle: () => {} }, shell: { openPath: async () => '' } }
    }
    return original.call(this, request, parent, isMain)
  }
  try {
    store = require(path.resolve(here, '../../../electron-main/fx-chains.js'))
  } finally {
    Module._load = original
  }
})

describe('slugifyChainName', () => {
  it('matches the renderer copy exactly', () => {
    expect(store.slugifyChainName('cool bass')).toBe('cool-bass')
    expect(store.slugifyChainName('  For Kick!! ')).toBe('for-kick')
    expect(store.slugifyChainName('1324gfdhfg')).toBe('1324gfdhfg')
  })

  it('cannot emit a separator or a traversal token', () => {
    expect(store.slugifyChainName('../../etc/passwd')).toBe('etc-passwd')
    expect(store.slugifyChainName('..\\..\\win')).toBe('win')
    expect(store.slugifyChainName('..')).toBe('chain')
  })

  it('escapes Windows reserved device names', () => {
    expect(store.slugifyChainName('CON')).toBe('_con')
    expect(store.slugifyChainName('nul')).toBe('_nul')
  })

  it('always produces something slugSafe accepts', () => {
    for (const name of ['***', '', '..', 'CON', 'a'.repeat(300), '😀😀']) {
      expect(store.slugSafe(store.slugifyChainName(name))).toBe(true)
    }
  })
})

describe('slugSafe', () => {
  it('rejects anything that could escape the library folder', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', 'a.json', '.hidden', '', 'A', 'a'.repeat(81)]) {
      expect(store.slugSafe(bad)).toBe(false)
    }
  })

  it('accepts what slugify produces', () => {
    expect(store.slugSafe('cool-bass')).toBe(true)
    expect(store.slugSafe('_con')).toBe(true)
  })
})

describe('folderSafe', () => {
  it('accepts the library root and an ordinary folder name', () => {
    expect(store.folderSafe(null)).toBe(true)
    expect(store.folderSafe('')).toBe(true)
    expect(store.folderSafe('Drums')).toBe(true)
    expect(store.folderSafe('my_bass')).toBe(true)
    // An interior dot is ordinary; only leading and trailing dots are refused.
    expect(store.folderSafe('bass.chains')).toBe(true)
  })

  it('rejects separators, traversal, and padding', () => {
    for (const bad of ['..', 'a/b', 'a\\b', ' Drums', 'Drums ', '.hidden', 'x.', 'a:b', 'a*b']) {
      expect(store.folderSafe(bad)).toBe(false)
    }
  })

  it('rejects Windows reserved device names as folders too', () => {
    expect(store.folderSafe('con')).toBe(false)
    expect(store.folderSafe('LPT1')).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(store.folderSafe(42)).toBe(false)
  })
})

describe('validateChainEnvelope', () => {
  // Literal magic, not store.CHAIN_MAGIC: a describe body runs at collection
  // time, before beforeAll has required the module. Pinning the literal here
  // also means a silent bump of the on-disk version fails this suite.
  const good = {
    xlethFxChain: 1,
    name: 'cool bass',
    effects: [{ pluginId: 'reverb', bypassed: true, state: 'UkVW' }],
  }

  it('is pinned to the version the renderer writes', () => {
    expect(store.CHAIN_MAGIC).toBe('xlethFxChain')
    expect(store.CHAIN_VERSION).toBe(1)
  })

  it('accepts a well-formed chain and stamps a created date', () => {
    const out = store.validateChainEnvelope(good)
    expect(out.name).toBe('cool bass')
    expect(typeof out.created).toBe('string')
  })

  it('preserves bypass and state per effect', () => {
    const out = store.validateChainEnvelope(good)
    expect(out.effects).toEqual([{ pluginId: 'reverb', bypassed: true, state: 'UkVW' }])
  })

  it('defaults bypass to false rather than dropping the effect', () => {
    const out = store.validateChainEnvelope({ ...good, effects: [{ pluginId: 'reverb' }] })
    expect(out.effects).toEqual([{ pluginId: 'reverb', bypassed: false }])
  })

  it('drops entries with no pluginId', () => {
    const out = store.validateChainEnvelope({
      ...good,
      effects: [{ pluginId: 'reverb' }, { bypassed: true }, null],
    })
    expect(out.effects).toHaveLength(1)
  })

  it('caps a chain at the engine effect limit', () => {
    const many = Array.from({ length: 150 }, () => ({ pluginId: 'reverb' }))
    expect(store.validateChainEnvelope({ ...good, effects: many }).effects).toHaveLength(100)
  })

  it('rejects a file that is not an XLETH chain', () => {
    expect(() => store.validateChainEnvelope({ hello: 1 })).toThrow(/not an XLETH FX chain/)
    expect(() => store.validateChainEnvelope(null)).toThrow(/must be a JSON object/)
    expect(() => store.validateChainEnvelope([])).toThrow(/must be a JSON object/)
  })

  it('rejects a missing or oversized name', () => {
    expect(() => store.validateChainEnvelope({ ...good, name: '  ' })).toThrow(/non-empty name/)
    expect(() => store.validateChainEnvelope({ ...good, name: 'a'.repeat(81) }))
      .toThrow(/exceeds 80/)
  })

  it('rejects a missing effects array', () => {
    expect(() => store.validateChainEnvelope({ ...good, effects: undefined }))
      .toThrow(/effects array/)
  })

  it('keeps strip only when it carries finite numbers', () => {
    expect(store.validateChainEnvelope({ ...good, strip: { volume: 0.5, pan: 0 } }).strip)
      .toEqual({ volume: 0.5, pan: 0 })
    expect('strip' in store.validateChainEnvelope({ ...good, strip: { volume: NaN } }))
      .toBe(false)
    expect('strip' in store.validateChainEnvelope(good)).toBe(false)
  })

  it('never carries an unknown top-level key through to disk', () => {
    const out = store.validateChainEnvelope({ ...good, evil: 'rm -rf', snapshot: {} })
    expect('evil' in out).toBe(false)
    expect('snapshot' in out).toBe(false)
  })
})

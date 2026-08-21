import { describe, expect, it } from 'vitest'

import {
  CHAIN_MAGIC,
  CHAIN_VERSION,
  buildChainDocument,
  buildEffectsFromChain,
  describeChainDocumentProblem,
  filterChains,
  findUnavailablePluginIds,
  groupChainsByFolder,
  isChainDocument,
} from '../chainDocument.js'
import { slugifyChainName } from '../slugify.js'

// The ordered light chain view a mixer strip renders.
const slots = [
  { nodeId: 12, pluginId: 'xletheq', position: 0, bypassed: false },
  { nodeId: 7, pluginId: 'compressor', position: 1, bypassed: true },
  { nodeId: 30, pluginId: 'reverb', position: 2, bypassed: false },
]

// The engine's whole-graph snapshot: same nodes, ARBITRARY order (it is
// serialized out of an unordered_map), each carrying its own state blob.
const snapshot = {
  nodes: [
    { nodeId: 30, pluginId: 'reverb', bypassed: false, state: 'UkVW' },
    { nodeId: 12, pluginId: 'xletheq', bypassed: false, state: 'RVE=' },
    { nodeId: 7, pluginId: 'compressor', bypassed: true, state: 'Q09NUA==' },
  ],
  connections: [],
}

describe('buildEffectsFromChain', () => {
  it('takes its order from the chain view, not the snapshot', () => {
    const effects = buildEffectsFromChain(slots, snapshot)
    expect(effects.map(e => e.pluginId)).toEqual(['xletheq', 'compressor', 'reverb'])
  })

  it('carries each effect state blob across', () => {
    const effects = buildEffectsFromChain(slots, snapshot)
    expect(effects.map(e => e.state)).toEqual(['RVE=', 'Q09NUA==', 'UkVW'])
  })

  it('preserves bypass per effect', () => {
    const effects = buildEffectsFromChain(slots, snapshot)
    expect(effects.map(e => e.bypassed)).toEqual([false, true, false])
  })

  it('prefers the snapshot bypass flag, which is read back from the processor', () => {
    const staleSlots = [{ nodeId: 7, pluginId: 'compressor', bypassed: false }]
    const [effect] = buildEffectsFromChain(staleSlots, snapshot)
    expect(effect.bypassed).toBe(true)
  })

  it('keeps a slot whose snapshot node is missing rather than dropping it', () => {
    const effects = buildEffectsFromChain(slots, { nodes: [] })
    expect(effects.map(e => e.pluginId)).toEqual(['xletheq', 'compressor', 'reverb'])
    expect(effects[0].state).toBeUndefined()
    // Falls back to the light view's own bypass flag.
    expect(effects[1].bypassed).toBe(true)
  })

  it('survives a null snapshot and a null chain', () => {
    expect(buildEffectsFromChain(slots, null)).toHaveLength(3)
    expect(buildEffectsFromChain(null, snapshot)).toEqual([])
  })

  it('skips slots with no pluginId', () => {
    const effects = buildEffectsFromChain([{ nodeId: 1 }, ...slots], snapshot)
    expect(effects).toHaveLength(3)
  })
})

describe('buildChainDocument', () => {
  it('stamps the magic and version', () => {
    const doc = buildChainDocument({ name: 'cool bass', effects: [] })
    expect(doc[CHAIN_MAGIC]).toBe(CHAIN_VERSION)
  })

  it('rejects a document with no name, and accepts an empty chain', () => {
    // An empty effects array is structurally VALID — refusing to save an empty
    // chain is the save path's rule, not the document format's.
    expect(isChainDocument(buildChainDocument({ name: '', effects: [] }))).toBe(false)
    expect(isChainDocument(buildChainDocument({ name: 'empty', effects: [] }))).toBe(true)
  })

  it('is a valid document once it has a name', () => {
    const doc = buildChainDocument({ name: 'cool bass', effects: [{ pluginId: 'reverb' }] })
    expect(isChainDocument(doc)).toBe(true)
    expect(describeChainDocumentProblem(doc)).toBeNull()
  })

  it('omits strip entirely when the user did not opt in', () => {
    const doc = buildChainDocument({ name: 'x', effects: [] })
    expect('strip' in doc).toBe(false)
  })

  it('keeps a saved zero — absent must stay distinguishable from 0', () => {
    const doc = buildChainDocument({ name: 'x', effects: [], strip: { pan: 0, volume: 1 } })
    expect(doc.strip).toEqual({ volume: 1, pan: 0 })
  })

  it('drops non-finite strip values instead of writing NaN', () => {
    const doc = buildChainDocument({ name: 'x', effects: [], strip: { pan: NaN, spread: 1.5 } })
    expect(doc.strip).toEqual({ spread: 1.5 })
  })

  it('trims and caps the name', () => {
    const doc = buildChainDocument({ name: `  ${'a'.repeat(200)}  `, effects: [] })
    expect(doc.name).toHaveLength(80)
  })
})

describe('describeChainDocumentProblem', () => {
  it('names each way a file can be unusable', () => {
    expect(describeChainDocumentProblem(null)).toMatch(/not a chain file/)
    expect(describeChainDocumentProblem({ hello: 1 })).toMatch(/not an XLETH FX chain/)
    expect(describeChainDocumentProblem({ [CHAIN_MAGIC]: CHAIN_VERSION })).toMatch(/no name/)
    expect(describeChainDocumentProblem({ [CHAIN_MAGIC]: CHAIN_VERSION, name: 'a' }))
      .toMatch(/no effect list/)
  })
})

describe('findUnavailablePluginIds', () => {
  const available = new Set(['reverb', 'compressor'])

  it('reports only what this machine cannot instantiate', () => {
    expect(findUnavailablePluginIds(['reverb', 'ozone11'], available)).toEqual(['ozone11'])
  })

  it('does not repeat an id used twice in one chain', () => {
    expect(findUnavailablePluginIds(['ozone11', 'ozone11'], available)).toEqual(['ozone11'])
  })

  it('claims nothing is missing when it has no availability set to check against', () => {
    expect(findUnavailablePluginIds(['ozone11'], null)).toEqual([])
  })
})

describe('groupChainsByFolder', () => {
  const chains = [
    { slug: 'for-snare', name: 'for snare', folder: 'Drums' },
    { slug: 'cool-bass', name: 'cool bass', folder: null },
    { slug: 'for-kick', name: 'for kick', folder: 'Drums' },
    { slug: 'guitar-fx', name: 'guitar fx', folder: null },
  ]

  it('puts the root group first, then folders alphabetically', () => {
    const groups = groupChainsByFolder(chains)
    expect(groups.map(g => g.folder)).toEqual([null, 'Drums'])
  })

  it('sorts entries by name inside each group', () => {
    const [root, drums] = groupChainsByFolder(chains)
    expect(root.chains.map(c => c.name)).toEqual(['cool bass', 'guitar fx'])
    expect(drums.chains.map(c => c.name)).toEqual(['for kick', 'for snare'])
  })

  it('emits no group at all when a folder has no entries left', () => {
    expect(groupChainsByFolder([]).length).toBe(0)
  })
})

describe('filterChains', () => {
  const chains = [
    { slug: 'a', name: 'cool bass', pluginIds: ['xlethfilter', 'distortion'] },
    { slug: 'b', name: 'guitar fx', pluginIds: ['phanjer', 'reverb'] },
  ]

  it('returns everything for an empty query', () => {
    expect(filterChains(chains, '  ')).toHaveLength(2)
  })

  it('matches on the chain name, case-insensitively', () => {
    expect(filterChains(chains, 'GUITAR').map(c => c.slug)).toEqual(['b'])
  })

  it('also matches on a contained plugin, so "reverb" finds an unnamed one', () => {
    expect(filterChains(chains, 'reverb').map(c => c.slug)).toEqual(['b'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterChains(chains, 'zzz')).toEqual([])
  })
})

describe('slugifyChainName', () => {
  it('matches the main-process rules the file store enforces', () => {
    expect(slugifyChainName('cool bass')).toBe('cool-bass')
    expect(slugifyChainName('  For Kick!! ')).toBe('for-kick')
    expect(slugifyChainName('1324gfdhfg')).toBe('1324gfdhfg')
  })

  it('never emits a path separator or a traversal token', () => {
    expect(slugifyChainName('../../etc/passwd')).toBe('etc-passwd')
    expect(slugifyChainName('..')).toBe('chain')
  })

  it('escapes Windows reserved device names', () => {
    expect(slugifyChainName('CON')).toBe('_con')
    expect(slugifyChainName('lpt1')).toBe('_lpt1')
  })

  it('falls back rather than producing an empty filename', () => {
    expect(slugifyChainName('***')).toBe('chain')
    expect(slugifyChainName('')).toBe('chain')
  })
})

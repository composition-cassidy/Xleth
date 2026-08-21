// FX chain document — the shape of one file in the library, and the pure
// helpers that build and read it.
//
// Deliberately free of IPC and of React: chainLibrary.js does the talking to the
// engine and the file store, this module only knows what a chain document IS.
//
//   { xlethFxChain: 1, name, author?, created, strip?,
//     effects: [{ pluginId, bypassed, state?, displayName? }, ...] }
//
// `effects` is ORDERED (index 0 = first in the chain) because the engine's own
// whole-graph serialization is not: its node array comes out of an unordered
// map, with slot order living only in the connection list. Storing the order
// explicitly is also what lets a chain be appended to a different track.

export const CHAIN_MAGIC = 'xlethFxChain'
export const CHAIN_VERSION = 1

export const MAX_CHAIN_NAME_LEN = 80

export function isChainDocument(doc) {
  return Boolean(doc)
    && typeof doc === 'object'
    && !Array.isArray(doc)
    && doc[CHAIN_MAGIC] === CHAIN_VERSION
    && typeof doc.name === 'string'
    && doc.name.trim().length > 0
    && Array.isArray(doc.effects)
}

// Human-readable reason a document cannot be used, or null when it is fine.
// Returned rather than thrown so a corrupt file greys out one menu row instead
// of taking down the whole library.
export function describeChainDocumentProblem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not a chain file'
  if (doc[CHAIN_MAGIC] !== CHAIN_VERSION) return 'not an XLETH FX chain file'
  if (typeof doc.name !== 'string' || !doc.name.trim()) return 'chain has no name'
  if (doc.name.length > MAX_CHAIN_NAME_LEN) return 'chain name is too long'
  if (!Array.isArray(doc.effects)) return 'chain has no effect list'
  return null
}

// Join the ORDERED light chain view (what the mixer strip renders: nodeId,
// pluginId, position, bypassed) with the engine's whole-graph snapshot (which
// carries each node's serialized state but in arbitrary order) into the ordered
// effects array a chain document stores.
//
// The light view is the order authority; the snapshot is looked up by nodeId.
// A slot with no matching snapshot node still travels — it just arrives at its
// default parameters rather than being silently dropped.
export function buildEffectsFromChain(chainSlots, snapshot) {
  const slots = Array.isArray(chainSlots) ? chainSlots : []
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []

  const byNodeId = new Map()
  for (const node of nodes) {
    if (node && Number.isInteger(node.nodeId)) byNodeId.set(node.nodeId, node)
  }

  const effects = []
  for (const slot of slots) {
    const pluginId = typeof slot?.pluginId === 'string' ? slot.pluginId : ''
    if (!pluginId) continue
    const node = byNodeId.get(slot.nodeId) ?? {}

    // The snapshot's bypass flag is read back from the live processor, so it
    // beats the light view's copy when both are present.
    const bypassed = typeof node.bypassed === 'boolean'
      ? node.bypassed
      : slot?.bypassed === true

    const effect = { pluginId, bypassed }
    if (typeof node.state === 'string' && node.state.length > 0) effect.state = node.state
    if (typeof slot?.displayName === 'string' && slot.displayName) {
      effect.displayName = slot.displayName
    }
    effects.push(effect)
  }
  return effects
}

// Assemble a document ready to hand to window.xleth.fxChains.save.
// `strip` is included only when the user opted in — its absence is what means
// "chain only", and that has to stay distinguishable from "saved as zero".
export function buildChainDocument({ name, effects, author, strip, created } = {}) {
  const doc = {
    [CHAIN_MAGIC]: CHAIN_VERSION,
    name: String(name ?? '').trim().slice(0, MAX_CHAIN_NAME_LEN),
    created: typeof created === 'string' ? created : new Date().toISOString(),
    effects: Array.isArray(effects) ? effects : [],
  }
  if (typeof author === 'string' && author) doc.author = author

  if (strip && typeof strip === 'object') {
    const normalized = {}
    for (const key of ['volume', 'pan', 'spread']) {
      const v = strip[key]
      if (typeof v === 'number' && Number.isFinite(v)) normalized[key] = v
    }
    if (Object.keys(normalized).length > 0) doc.strip = normalized
  }

  return doc
}

// The pluginIds in a chain that this machine cannot instantiate. `available` is
// the set of ids the app can currently create (stock effects plus scanned VST3s).
// Used to warn BEFORE a load rather than reporting a short chain after one.
export function findUnavailablePluginIds(pluginIds, available) {
  const ids = Array.isArray(pluginIds) ? pluginIds : []
  if (!available || typeof available.has !== 'function') return []
  const missing = []
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue
    if (!available.has(id) && !missing.includes(id)) missing.push(id)
  }
  return missing
}

// Group flat library metadata into the menu's shape: the root group first, then
// one group per folder, each alphabetical. Folders with no surviving entry after
// a filter are dropped, so searching never shows an empty heading.
export function groupChainsByFolder(chains) {
  const list = Array.isArray(chains) ? chains : []
  const root = []
  const byFolder = new Map()

  for (const chain of list) {
    if (!chain || typeof chain.slug !== 'string') continue
    if (chain.folder) {
      if (!byFolder.has(chain.folder)) byFolder.set(chain.folder, [])
      byFolder.get(chain.folder).push(chain)
    } else {
      root.push(chain)
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name)
  const groups = []
  if (root.length > 0) groups.push({ folder: null, chains: root.sort(byName) })
  for (const folder of [...byFolder.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ folder, chains: byFolder.get(folder).sort(byName) })
  }
  return groups
}

// Case-insensitive filter over chain names AND their plugin ids, so typing
// "reverb" finds every chain containing one even when none is named for it.
export function filterChains(chains, query) {
  const term = String(query ?? '').trim().toLowerCase()
  if (!term) return Array.isArray(chains) ? chains : []
  return (Array.isArray(chains) ? chains : []).filter((chain) => {
    if (typeof chain?.name === 'string' && chain.name.toLowerCase().includes(term)) return true
    const ids = Array.isArray(chain?.pluginIds) ? chain.pluginIds : []
    return ids.some((id) => typeof id === 'string' && id.toLowerCase().includes(term))
  })
}

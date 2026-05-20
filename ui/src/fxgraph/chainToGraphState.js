import { GRAPH_STATE_SCHEMA_VERSION } from './graphState.js'

const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 })
const NODE_SPACING_X = 260
const NODE_Y = 0

export const STOCK_EFFECT_LABELS = Object.freeze({
  testgain: 'Test Gain',
  compressor: 'Compressor',
  limiter: 'Limiter',
  overdone: 'Overdone',
  transientproc: 'Transient Proc',
  xletheq: 'Xleth EQ',
  xlethfilter: 'Xleth Filter',
  distortion: 'Distortion',
  waveshaper: 'Waveshaper',
  uniflange: 'UniFlange',
  chorus: 'Chorus',
  flanger: 'Flanger',
  phaser: 'Phaser',
  phanjer: 'Phanjer',
  delay: 'Delay',
  reverb: 'Reverb',
  smartbalance: 'Smart Balance',
  resonancesuppressor: 'Resonance Suppressor',
})

function fallbackUuid() {
  const bytes = new Uint8Array(16)
  const cryptoSource = globalThis.crypto
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

function createUuid(idFactory) {
  const id = idFactory?.()
  if (typeof id === 'string' && id.length > 0) return id
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid()
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return ''
}

export function resolveChainEffectPluginId(effect) {
  if (typeof effect === 'string') return effect
  if (effect == null || typeof effect !== 'object') return 'unknown-effect'

  return firstNonEmptyString([
    effect.pluginId,
    effect.processorId,
    effect.pluginIdentifier,
    effect.identifier,
    effect.id,
    effect.type,
  ]) || 'unknown-effect'
}

export function resolveChainEffectDisplayName(effect, vstPlugins = []) {
  if (typeof effect === 'string') {
    return STOCK_EFFECT_LABELS[effect] ?? effect
  }
  if (effect == null || typeof effect !== 'object') return 'Effect'

  const explicitName = firstNonEmptyString([
    effect.displayName,
    effect.label,
    effect.name,
    effect.pluginName,
  ])
  if (explicitName) return explicitName

  const pluginId = resolveChainEffectPluginId(effect)
  const stockLabel = STOCK_EFFECT_LABELS[pluginId]
  if (stockLabel) return stockLabel

  const vstMeta = vstPlugins.find((plugin) => plugin?.id === pluginId)
  return vstMeta?.name || pluginId || 'Effect'
}

function statusMatches(effect, status) {
  const rawStatus = String(effect?.status ?? effect?.state ?? '').toLowerCase()
  return rawStatus === status
}

function resolveBypass(effect) {
  return effect?.bypassed === true ||
    effect?.bypass === true ||
    effect?.disabled === true ||
    effect?.enabled === false
}

function resolveMissing(effect) {
  return effect?.missing === true ||
    effect?.pluginMissing === true ||
    effect?.isMissing === true ||
    statusMatches(effect, 'missing')
}

function resolveCrashed(effect) {
  return effect?.crashed === true ||
    effect?.pluginCrashed === true ||
    effect?.isCrashed === true ||
    statusMatches(effect, 'crashed')
}

function nodePosition(index) {
  return {
    x: index * NODE_SPACING_X,
    y: NODE_Y,
  }
}

function makeAudioEdge({ id, sourceNodeId, sourcePort, targetNodeId, targetPort }) {
  return {
    id,
    sourceNodeId,
    sourcePort,
    targetNodeId,
    targetPort,
    type: 'audio',
  }
}

export function createGraphStateFromChain({
  trackId,
  effects = [],
  idFactory,
  vstPlugins = [],
} = {}) {
  const orderedEffects = Array.isArray(effects) ? effects : []
  const inputNode = {
    id: createUuid(idFactory),
    type: 'trackInput',
    position: nodePosition(0),
    data: {},
  }
  const effectNodes = orderedEffects.map((effect, index) => ({
    id: createUuid(idFactory),
    type: 'effect',
    position: nodePosition(index + 1),
    data: {
      effectInstanceId: createUuid(idFactory),
      pluginId: resolveChainEffectPluginId(effect),
      displayName: resolveChainEffectDisplayName(effect, vstPlugins),
      bypass: resolveBypass(effect),
      missing: resolveMissing(effect),
      crashed: resolveCrashed(effect),
      sourceChainSlotIndex: index,
    },
  }))
  const outputNode = {
    id: createUuid(idFactory),
    type: 'trackOutput',
    position: nodePosition(effectNodes.length + 1),
    data: {},
  }

  const nodes = [inputNode, ...effectNodes, outputNode]
  const edges = []
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const sourceNode = nodes[index]
    const targetNode = nodes[index + 1]
    edges.push(makeAudioEdge({
      id: createUuid(idFactory),
      sourceNodeId: sourceNode.id,
      sourcePort: sourceNode.type === 'trackInput' ? 'audio' : 'audioOut',
      targetNodeId: targetNode.id,
      targetPort: targetNode.type === 'trackOutput' ? 'audio' : 'audioIn',
    }))
  }

  return {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId: trackId == null ? '' : String(trackId),
    nodes,
    edges,
    viewport: { ...DEFAULT_VIEWPORT },
  }
}

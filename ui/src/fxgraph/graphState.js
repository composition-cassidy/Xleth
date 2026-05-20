export const GRAPH_STATE_SCHEMA_VERSION = 1

const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 })
const MIN_VIEWPORT_ZOOM = 0.1
const MAX_VIEWPORT_ZOOM = 4

const NODE_TYPES = new Set(['trackInput', 'trackOutput', 'effect'])
const EDGE_TYPES = new Set(['audio'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeTrackId(trackId) {
  return trackId == null ? '' : String(trackId)
}

function makeWarning(code, trackId, message, details = {}) {
  return {
    code,
    trackId: normalizeTrackId(trackId),
    message: `[FXG] track ${normalizeTrackId(trackId)}: ${message}`,
    ...details,
  }
}

function emitWarnings(warnings, options = {}) {
  if (!options.logger || options.logWarnings === false) return
  for (const warning of warnings) {
    options.logger(warning.message, warning)
  }
}

function finish(result, options) {
  emitWarnings(result.warnings ?? [], options)
  return result
}

function invalid(reason, warnings = []) {
  return { status: 'invalid', graphState: null, reason, warnings }
}

function defaultViewportWithWarnings(raw, trackId, warnings) {
  if (raw == null) return { ...DEFAULT_VIEWPORT }
  if (!isPlainObject(raw)) {
    warnings.push(makeWarning('invalidViewport', trackId, 'invalid graphState viewport; using defaults'))
    return { ...DEFAULT_VIEWPORT }
  }

  const x = Number.isFinite(raw.x) ? raw.x : DEFAULT_VIEWPORT.x
  const y = Number.isFinite(raw.y) ? raw.y : DEFAULT_VIEWPORT.y
  let zoom = Number.isFinite(raw.zoom) ? raw.zoom : DEFAULT_VIEWPORT.zoom

  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.zoom)) {
    warnings.push(makeWarning('invalidViewport', trackId, 'invalid graphState viewport fields; using safe defaults'))
  }

  if (zoom <= 0) {
    warnings.push(makeWarning('invalidViewportZoom', trackId, 'invalid graphState viewport zoom; using 1'))
    zoom = DEFAULT_VIEWPORT.zoom
  }

  return {
    x,
    y,
    zoom: Math.min(MAX_VIEWPORT_ZOOM, Math.max(MIN_VIEWPORT_ZOOM, zoom)),
  }
}

function validateEffectNodeData(node, trackId, warnings) {
  if (!isPlainObject(node.data)) {
    return { ok: false, reason: 'invalid_effect_node_data' }
  }

  const data = node.data
  const sourceChainSlotIndexValid =
    data.sourceChainSlotIndex === null || Number.isInteger(data.sourceChainSlotIndex)

  if (
    typeof data.effectInstanceId !== 'string' ||
    typeof data.pluginId !== 'string' ||
    typeof data.displayName !== 'string' ||
    typeof data.bypass !== 'boolean' ||
    typeof data.missing !== 'boolean' ||
    typeof data.crashed !== 'boolean' ||
    !sourceChainSlotIndexValid
  ) {
    warnings.push(makeWarning('invalidEffectNodeData', trackId, 'invalid effect node data', { nodeId: node.id }))
    return { ok: false, reason: 'invalid_effect_node_data' }
  }

  return {
    ok: true,
    data: {
      effectInstanceId: data.effectInstanceId,
      pluginId: data.pluginId,
      displayName: data.displayName,
      bypass: data.bypass,
      missing: data.missing,
      crashed: data.crashed,
      sourceChainSlotIndex: data.sourceChainSlotIndex,
    },
  }
}

function normalizeNode(node, trackId, warnings) {
  if (!isPlainObject(node)) return { ok: false, reason: 'invalid_node' }
  if (typeof node.id !== 'string' || node.id.length === 0) {
    return { ok: false, reason: 'invalid_node_id' }
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    return { ok: false, reason: 'invalid_node_type' }
  }

  if (!NODE_TYPES.has(node.type)) {
    warnings.push(makeWarning('unknownNodeType', trackId, 'unknown graphState node type preserved as unknown', {
      nodeId: node.id,
      preservedType: node.type,
    }))
    return {
      ok: true,
      node: {
        id: node.id,
        type: 'unknown',
        data: {
          _preservedType: node.type,
          _preservedData: isPlainObject(node.data) ? cloneJson(node.data) : {},
        },
      },
    }
  }

  if (node.type === 'effect') {
    const effectData = validateEffectNodeData(node, trackId, warnings)
    if (!effectData.ok) return effectData
    return {
      ok: true,
      node: {
        id: node.id,
        type: 'effect',
        data: effectData.data,
      },
    }
  }

  return {
    ok: true,
    node: {
      id: node.id,
      type: node.type,
      data: isPlainObject(node.data) ? cloneJson(node.data) : {},
    },
  }
}

function normalizeEdge(edge, nodeIds, trackId, warnings) {
  if (!isPlainObject(edge)) return { ok: false, reason: 'invalid_edge' }
  if (typeof edge.id !== 'string' || edge.id.length === 0) {
    return { ok: false, reason: 'invalid_edge_id' }
  }
  if (
    typeof edge.sourceNodeId !== 'string' ||
    typeof edge.sourcePort !== 'string' ||
    typeof edge.targetNodeId !== 'string' ||
    typeof edge.targetPort !== 'string'
  ) {
    return { ok: false, reason: 'invalid_edge_endpoint' }
  }
  if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
    warnings.push(makeWarning('invalidEdgeReference', trackId, 'graphState edge references a missing node', {
      edgeId: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    }))
    return { ok: false, reason: 'invalid_edge_reference' }
  }
  if (typeof edge.type !== 'string' || edge.type.length === 0) {
    return { ok: false, reason: 'invalid_edge_type' }
  }

  if (!EDGE_TYPES.has(edge.type)) {
    warnings.push(makeWarning('unknownEdgeType', trackId, 'unknown graphState edge type preserved as unknown', {
      edgeId: edge.id,
      preservedType: edge.type,
    }))
    return {
      ok: true,
      edge: {
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        sourcePort: edge.sourcePort,
        targetNodeId: edge.targetNodeId,
        targetPort: edge.targetPort,
        type: 'unknown',
        _preservedType: edge.type,
      },
    }
  }

  return {
    ok: true,
    edge: {
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      sourcePort: edge.sourcePort,
      targetNodeId: edge.targetNodeId,
      targetPort: edge.targetPort,
      type: edge.type,
    },
  }
}

function hasAudioCycle(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    if (edge.type !== 'audio') continue
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId)
  }

  const visiting = new Set()
  const visited = new Set()

  function visit(nodeId) {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false

    visiting.add(nodeId)
    for (const nextNodeId of outgoing.get(nodeId) ?? []) {
      if (visit(nextNodeId)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return nodes.some((node) => visit(node.id))
}

function validateVersionOneGraphState(raw, expectedTrackId, options) {
  const trackId = normalizeTrackId(expectedTrackId)
  const warnings = []

  if (typeof raw.trackId !== 'string') {
    warnings.push(makeWarning('invalidTrackId', trackId, 'graphState trackId is missing or invalid'))
    return invalid('invalid_track_id', warnings)
  }
  if (raw.trackId !== trackId) {
    warnings.push(makeWarning('trackIdMismatch', trackId, 'graphState belongs to a different track', {
      graphStateTrackId: raw.trackId,
    }))
    return invalid('track_id_mismatch', warnings)
  }
  if (!Array.isArray(raw.nodes)) {
    warnings.push(makeWarning('invalidNodes', trackId, 'graphState nodes must be an array'))
    return invalid('invalid_nodes', warnings)
  }
  if (!Array.isArray(raw.edges)) {
    warnings.push(makeWarning('invalidEdges', trackId, 'graphState edges must be an array'))
    return invalid('invalid_edges', warnings)
  }

  const nodes = []
  const nodeIds = new Set()
  let trackInputCount = 0
  let trackOutputCount = 0

  for (const node of raw.nodes) {
    const normalized = normalizeNode(node, trackId, warnings)
    if (!normalized.ok) return invalid(normalized.reason, warnings)
    if (nodeIds.has(normalized.node.id)) {
      warnings.push(makeWarning('duplicateNodeId', trackId, 'duplicate graphState node id', { nodeId: normalized.node.id }))
      return invalid('duplicate_node_id', warnings)
    }
    nodeIds.add(normalized.node.id)
    if (normalized.node.type === 'trackInput') trackInputCount += 1
    if (normalized.node.type === 'trackOutput') trackOutputCount += 1
    nodes.push(normalized.node)
  }

  if (nodes.length > 0 && (trackInputCount !== 1 || trackOutputCount !== 1)) {
    warnings.push(makeWarning('invalidTrackIoMultiplicity', trackId, 'graphState must have exactly one trackInput and one trackOutput when nodes exist', {
      trackInputCount,
      trackOutputCount,
    }))
    return invalid('invalid_track_io_multiplicity', warnings)
  }

  const edges = []
  const edgeIds = new Set()
  for (const edge of raw.edges) {
    const normalized = normalizeEdge(edge, nodeIds, trackId, warnings)
    if (!normalized.ok) return invalid(normalized.reason, warnings)
    if (edgeIds.has(normalized.edge.id)) {
      warnings.push(makeWarning('duplicateEdgeId', trackId, 'duplicate graphState edge id', { edgeId: normalized.edge.id }))
      return invalid('duplicate_edge_id', warnings)
    }
    edgeIds.add(normalized.edge.id)
    edges.push(normalized.edge)
  }

  if (hasAudioCycle(nodes, edges)) {
    warnings.push(makeWarning('cycleDetected', trackId, 'graphState contains an audio cycle'))
    return invalid('cycle_detected', warnings)
  }

  const graphState = {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId,
    nodes,
    edges,
    viewport: defaultViewportWithWarnings(raw.viewport, trackId, warnings),
  }

  return { status: 'valid', graphState, warnings }
}

export function createEmptyGraphState(trackId) {
  return {
    schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
    trackId: normalizeTrackId(trackId),
    nodes: [],
    edges: [],
    viewport: { ...DEFAULT_VIEWPORT },
  }
}

export function migrateGraphState(raw, fromVersion) {
  if (fromVersion === GRAPH_STATE_SCHEMA_VERSION) return cloneJson(raw)
  return cloneJson(raw)
}

export function validateGraphState(raw, expectedTrackId) {
  return loadGraphState(raw, expectedTrackId, { logWarnings: false })
}

export function loadGraphState(raw, expectedTrackId, options = {}) {
  const trackId = normalizeTrackId(expectedTrackId)

  if (raw == null) {
    const warnings = []
    if (options.fxMode === 'graph') {
      warnings.push(makeWarning('missingGraphState', trackId, 'graph track has missing graphState'))
    }
    return finish({ status: 'missing', graphState: null, warnings }, options)
  }

  if (!isPlainObject(raw)) {
    const warnings = [
      makeWarning('invalidGraphState', trackId, 'graphState must be an object'),
    ]
    return finish(invalid('non_object_graph_state', warnings), options)
  }

  if (!Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')) {
    const warnings = [
      makeWarning('missingSchemaVersion', trackId, 'graphState schemaVersion is missing'),
    ]
    return finish(invalid('missing_schema_version', warnings), options)
  }

  if (!Number.isInteger(raw.schemaVersion)) {
    const warnings = [
      makeWarning('invalidSchemaVersion', trackId, 'graphState schemaVersion is invalid'),
    ]
    return finish(invalid('invalid_schema_version', warnings), options)
  }

  if (raw.schemaVersion < GRAPH_STATE_SCHEMA_VERSION) {
    const warnings = [
      makeWarning('oldSchemaVersion', trackId, 'graphState schemaVersion is unsupported', {
        schemaVersion: raw.schemaVersion,
      }),
    ]
    return finish(invalid('old_schema_version', warnings), options)
  }

  if (raw.schemaVersion > GRAPH_STATE_SCHEMA_VERSION) {
    const warnings = [
      makeWarning('futureSchemaVersion', trackId, 'future graphState schemaVersion preserved as unsupported', {
        schemaVersion: raw.schemaVersion,
      }),
    ]
    return finish({
      status: 'future',
      graphState: null,
      raw: cloneJson(raw),
      reason: 'future_schema_version',
      warnings,
    }, options)
  }

  return finish(validateVersionOneGraphState(raw, trackId, options), options)
}

export function saveGraphState(graphState) {
  if (graphState == null) return null
  return cloneJson(graphState)
}

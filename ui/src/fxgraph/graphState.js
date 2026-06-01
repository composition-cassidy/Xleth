export const GRAPH_STATE_SCHEMA_VERSION = 1

const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 })
const FALLBACK_NODE_SPACING_X = 260
const FALLBACK_NODE_Y = 0
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

function fallbackNodePosition(index) {
  return {
    x: index * FALLBACK_NODE_SPACING_X,
    y: FALLBACK_NODE_Y,
  }
}

function nodePositionWithWarnings(raw, fallbackPosition, trackId, warnings, nodeId, hasPosition) {
  if (!hasPosition) return fallbackPosition
  if (!isPlainObject(raw)) {
    warnings.push(makeWarning('invalidNodePosition', trackId, 'invalid graphState node position; using defaults', { nodeId }))
    return fallbackPosition
  }

  const hasValidX = Number.isFinite(raw.x)
  const hasValidY = Number.isFinite(raw.y)
  if (!hasValidX || !hasValidY) {
    warnings.push(makeWarning('invalidNodePosition', trackId, 'invalid graphState node position fields; using safe defaults', { nodeId }))
    return fallbackPosition
  }

  return {
    x: raw.x,
    y: raw.y,
  }
}

function withNodePosition(node, position) {
  return { ...node, position }
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
      ...cloneJson(data),
      effectInstanceId: data.effectInstanceId,
      pluginId: data.pluginId,
      displayName: data.displayName,
      bypass: data.bypass,
      missing: data.missing,
      crashed: data.crashed,
      sourceChainSlotIndex: data.sourceChainSlotIndex,
      exposedParameterPorts: normalizeExposedParameterPorts(
        data.exposedParameterPorts,
        trackId,
        warnings,
        node.id,
      ),
    },
  }
}

function normalizeNullableBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

function normalizeExposedParameterPort(raw, trackId, warnings, nodeId) {
  if (!isPlainObject(raw)) {
    warnings.push(makeWarning('invalidExposedParameterPort', trackId, 'invalid exposed parameter port dropped', { nodeId }))
    return null
  }

  const parameterId = typeof raw.parameterId === 'string' ? raw.parameterId.trim() : ''
  if (!parameterId) {
    warnings.push(makeWarning('invalidExposedParameterPort', trackId, 'exposed parameter port missing parameterId', { nodeId }))
    return null
  }

  const parameterIndex = Number.isInteger(raw.parameterIndex) && raw.parameterIndex >= 0
    ? raw.parameterIndex
    : null
  const nameSnapshot = typeof raw.nameSnapshot === 'string' && raw.nameSnapshot.trim().length > 0
    ? raw.nameSnapshot.trim()
    : parameterId
  const labelSnapshot = typeof raw.labelSnapshot === 'string' && raw.labelSnapshot.trim().length > 0
    ? raw.labelSnapshot.trim()
    : null

  return {
    parameterId,
    parameterIndex,
    nameSnapshot,
    labelSnapshot,
    parameterIdIsFallback: raw.parameterIdIsFallback === true,
    automatable: normalizeNullableBoolean(raw.automatable),
    readOnly: normalizeNullableBoolean(raw.readOnly),
  }
}

export function normalizeExposedParameterPorts(rawPorts, trackId = '', warnings = [], nodeId = '') {
  if (rawPorts == null) return []
  if (!Array.isArray(rawPorts)) {
    warnings.push(makeWarning('invalidExposedParameterPorts', trackId, 'exposedParameterPorts must be an array', { nodeId }))
    return []
  }

  const seen = new Set()
  const ports = []
  for (const rawPort of rawPorts) {
    const port = normalizeExposedParameterPort(rawPort, trackId, warnings, nodeId)
    if (!port) continue
    if (seen.has(port.parameterId)) {
      warnings.push(makeWarning('duplicateExposedParameterPort', trackId, 'duplicate exposed parameter port dropped', {
        nodeId,
        parameterId: port.parameterId,
      }))
      continue
    }
    seen.add(port.parameterId)
    ports.push(port)
  }
  return ports
}

export function buildExposedParameterPort(parameterDescriptor) {
  if (!isPlainObject(parameterDescriptor)) return null
  const parameterId = typeof parameterDescriptor.parameterId === 'string'
    ? parameterDescriptor.parameterId.trim()
    : ''
  if (!parameterId) return null

  const name =
    typeof parameterDescriptor.name === 'string' && parameterDescriptor.name.trim().length > 0
      ? parameterDescriptor.name.trim()
      : parameterId
  const label =
    typeof parameterDescriptor.unit === 'string' && parameterDescriptor.unit.trim().length > 0
      ? parameterDescriptor.unit.trim()
      : null

  return {
    parameterId,
    parameterIndex:
      Number.isInteger(parameterDescriptor.parameterIndex) && parameterDescriptor.parameterIndex >= 0
        ? parameterDescriptor.parameterIndex
        : null,
    nameSnapshot: name,
    labelSnapshot: label,
    parameterIdIsFallback: parameterDescriptor.parameterIdIsFallback === true,
    automatable: normalizeNullableBoolean(parameterDescriptor.automatable),
    readOnly: normalizeNullableBoolean(parameterDescriptor.readOnly),
  }
}

export function toggleExposedParameterPort(graphState, nodeId, parameterDescriptor) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  }

  const node = graphState.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (isProtectedGraphNodeType(node.type)) return { ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE }
  if (node.type !== 'effect') return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }

  const port = buildExposedParameterPort(parameterDescriptor)
  if (!port) return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_PARAMETER_PORT }

  const currentPorts = normalizeExposedParameterPorts(node.data?.exposedParameterPorts)
  const alreadyExposed = currentPorts.some((candidate) => candidate.parameterId === port.parameterId)
  const nextPorts = alreadyExposed
    ? currentPorts.filter((candidate) => candidate.parameterId !== port.parameterId)
    : [...currentPorts, port]

  return {
    ok: true,
    exposed: !alreadyExposed,
    parameterPort: port,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.map((candidate) => (
        candidate.id === nodeId
          ? {
              ...candidate,
              data: {
                ...(candidate.data ?? {}),
                exposedParameterPorts: nextPorts,
              },
            }
          : candidate
      )),
    },
  }
}

function normalizeNode(node, trackId, warnings, fallbackPosition) {
  if (!isPlainObject(node)) return { ok: false, reason: 'invalid_node' }
  if (typeof node.id !== 'string' || node.id.length === 0) {
    return { ok: false, reason: 'invalid_node_id' }
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    return { ok: false, reason: 'invalid_node_type' }
  }

  const position = nodePositionWithWarnings(
    node.position,
    fallbackPosition,
    trackId,
    warnings,
    node.id,
    Object.prototype.hasOwnProperty.call(node, 'position'),
  )

  if (!NODE_TYPES.has(node.type)) {
    warnings.push(makeWarning('unknownNodeType', trackId, 'unknown graphState node type preserved as unknown', {
      nodeId: node.id,
      preservedType: node.type,
    }))
    return {
      ok: true,
      node: withNodePosition({
        id: node.id,
        type: 'unknown',
        data: {
          _preservedType: node.type,
          _preservedData: isPlainObject(node.data) ? cloneJson(node.data) : {},
        },
      }, position),
    }
  }

  if (node.type === 'effect') {
    const effectData = validateEffectNodeData(node, trackId, warnings)
    if (!effectData.ok) return effectData
    return {
      ok: true,
      node: withNodePosition({
        id: node.id,
        type: 'effect',
        data: effectData.data,
      }, position),
    }
  }

  return {
    ok: true,
    node: withNodePosition({
      id: node.id,
      type: node.type,
      data: isPlainObject(node.data) ? cloneJson(node.data) : {},
    }, position),
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

  for (let index = 0; index < raw.nodes.length; index += 1) {
    const normalized = normalizeNode(raw.nodes[index], trackId, warnings, fallbackNodePosition(index))
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
    ...cloneJson(raw),
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

// ---------------------------------------------------------------------------
// FXG.2C-d — Graph mutation architecture guards
//
// These helpers are topology guards for renderer-side graphState only.
// They do NOT enforce fxMode ownership. FXG.2C-e store actions must check
// fxMode === 'graph' before calling any mutation helper.
//
// Effect nodes added via mutation helpers exist in renderer-side graphState
// only. No audio engine execution or bridge API involvement until FXG.3.
// ---------------------------------------------------------------------------

function generateMutationId(idFactory) {
  if (typeof idFactory === 'function') {
    const id = idFactory()
    if (typeof id === 'string' && id.length > 0) return id
  }
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// Mirrors chainToGraphState.js port convention (lines 189-191) exactly.
function inferSourcePort(nodeType) {
  if (nodeType === 'trackInput') return 'audio'
  if (nodeType === 'effect') return 'audioOut'
  return 'audio'
}

function inferTargetPort(nodeType) {
  if (nodeType === 'trackOutput') return 'audio'
  if (nodeType === 'effect') return 'audioIn'
  return 'audio'
}

export const PROTECTED_NODE_TYPES = Object.freeze(['trackInput', 'trackOutput'])
const PROTECTED_NODE_TYPES_SET = new Set(PROTECTED_NODE_TYPES)

export const GRAPH_MUTATION_REJECTION = Object.freeze({
  PROTECTED_NODE: 'protected_node',
  MISSING_NODE: 'missing_node',
  MISSING_EDGE: 'missing_edge',
  MISSING_SOURCE_NODE: 'missing_source_node',
  MISSING_TARGET_NODE: 'missing_target_node',
  SELF_CONNECTION: 'self_connection',
  DUPLICATE_EDGE: 'duplicate_edge',
  CYCLE_DETECTED: 'cycle_detected',
  INVALID_SOURCE_TYPE: 'invalid_source_type',
  INVALID_TARGET_TYPE: 'invalid_target_type',
  UNKNOWN_NODE_TYPE: 'unknown_node_type',
  INVALID_GRAPH_STATE: 'invalid_graph_state',
  INVALID_NODE_DRAFT: 'invalid_node_draft',
  INVALID_CONNECTION_DRAFT: 'invalid_connection_draft',
  INVALID_PARAMETER_PORT: 'invalid_parameter_port',
})

export function isProtectedGraphNodeType(type) {
  return PROTECTED_NODE_TYPES_SET.has(type)
}

export function validateGraphStateForEditing(graphState) {
  if (
    graphState == null ||
    !isPlainObject(graphState) ||
    !Array.isArray(graphState.nodes) ||
    !Array.isArray(graphState.edges)
  ) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_GRAPH_STATE }
  }
  return { ok: true }
}

export function hasEquivalentGraphEdge(graphState, sourceNodeId, targetNodeId, edgeType = 'audio') {
  if (!Array.isArray(graphState?.edges)) return false
  return graphState.edges.some(
    (edge) =>
      edge.sourceNodeId === sourceNodeId &&
      edge.targetNodeId === targetNodeId &&
      edge.type === edgeType,
  )
}

export function canRemoveGraphNode(graphState, nodeId) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  const node = graphState.nodes.find((n) => n.id === nodeId)
  if (!node) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_NODE }
  if (isProtectedGraphNodeType(node.type)) return { ok: false, reason: GRAPH_MUTATION_REJECTION.PROTECTED_NODE }

  return { ok: true }
}

export function canConnectGraphNodes(graphState, sourceNodeId, targetNodeId, options = {}) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  const edgeType = options.edgeType ?? 'audio'
  const sourceNode = graphState.nodes.find((n) => n.id === sourceNodeId)
  const targetNode = graphState.nodes.find((n) => n.id === targetNodeId)

  if (!sourceNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_SOURCE_NODE }
  if (!targetNode) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_TARGET_NODE }
  if (sourceNodeId === targetNodeId) return { ok: false, reason: GRAPH_MUTATION_REJECTION.SELF_CONNECTION }
  if (sourceNode.type === 'trackOutput') return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_SOURCE_TYPE }
  if (targetNode.type === 'trackInput') return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_TARGET_TYPE }
  if (sourceNode.type === 'unknown') return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }
  if (targetNode.type === 'unknown') return { ok: false, reason: GRAPH_MUTATION_REJECTION.UNKNOWN_NODE_TYPE }

  if (hasEquivalentGraphEdge(graphState, sourceNodeId, targetNodeId, edgeType)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.DUPLICATE_EDGE }
  }

  const hypotheticalEdge = {
    id: '__hypothetical__',
    sourceNodeId,
    sourcePort: inferSourcePort(sourceNode.type),
    targetNodeId,
    targetPort: inferTargetPort(targetNode.type),
    type: edgeType,
  }
  if (hasAudioCycle(graphState.nodes, [...graphState.edges, hypotheticalEdge])) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.CYCLE_DETECTED }
  }

  return { ok: true }
}

export function addGraphEffectNode(graphState, nodeDraft, options = {}) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (
    !isPlainObject(nodeDraft) ||
    typeof nodeDraft.effectInstanceId !== 'string' ||
    nodeDraft.effectInstanceId.length === 0 ||
    typeof nodeDraft.pluginId !== 'string' ||
    nodeDraft.pluginId.length === 0 ||
    typeof nodeDraft.displayName !== 'string'
  ) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_NODE_DRAFT }
  }

  let position = nodeDraft.position
  if (
    !isPlainObject(position) ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    const outputIndex = graphState.nodes.findIndex((n) => n.type === 'trackOutput')
    const insertIndex = outputIndex >= 0 ? outputIndex : graphState.nodes.length
    position = { x: insertIndex * FALLBACK_NODE_SPACING_X, y: FALLBACK_NODE_Y }
  }

  const newNode = {
    id: generateMutationId(options.idFactory),
    type: 'effect',
    position: { x: position.x, y: position.y },
    data: {
      effectInstanceId: nodeDraft.effectInstanceId,
      pluginId: nodeDraft.pluginId,
      displayName: nodeDraft.displayName,
      bypass: nodeDraft.bypass === true,
      missing: nodeDraft.missing === true,
      crashed: nodeDraft.crashed === true,
      sourceChainSlotIndex: null,
    },
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: [...graphState.nodes, newNode],
    },
  }
}

export function removeGraphNode(graphState, nodeId) {
  const canRemove = canRemoveGraphNode(graphState, nodeId)
  if (!canRemove.ok) return canRemove

  return {
    ok: true,
    graphState: {
      ...graphState,
      nodes: graphState.nodes.filter((n) => n.id !== nodeId),
      edges: graphState.edges.filter(
        (e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId,
      ),
    },
  }
}

export function connectGraphNodes(graphState, connectionDraft, options = {}) {
  if (!isPlainObject(connectionDraft)) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.INVALID_CONNECTION_DRAFT }
  }

  const { sourceNodeId, targetNodeId } = connectionDraft
  const edgeType = connectionDraft.edgeType ?? 'audio'

  const canConnect = canConnectGraphNodes(graphState, sourceNodeId, targetNodeId, { edgeType })
  if (!canConnect.ok) return canConnect

  const sourceNode = graphState.nodes.find((n) => n.id === sourceNodeId)
  const targetNode = graphState.nodes.find((n) => n.id === targetNodeId)

  const sourcePort = connectionDraft.sourcePort ?? inferSourcePort(sourceNode.type)
  const targetPort = connectionDraft.targetPort ?? inferTargetPort(targetNode.type)

  const newEdge = {
    id: generateMutationId(options.idFactory),
    sourceNodeId,
    sourcePort,
    targetNodeId,
    targetPort,
    type: edgeType,
  }

  return {
    ok: true,
    graphState: {
      ...graphState,
      edges: [...graphState.edges, newEdge],
    },
  }
}

export function disconnectGraphEdge(graphState, edgeId) {
  const editCheck = validateGraphStateForEditing(graphState)
  if (!editCheck.ok) return editCheck

  if (typeof edgeId !== 'string' || edgeId.length === 0) {
    return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }
  }

  const edgeExists = graphState.edges.some((e) => e.id === edgeId)
  if (!edgeExists) return { ok: false, reason: GRAPH_MUTATION_REJECTION.MISSING_EDGE }

  return {
    ok: true,
    graphState: {
      ...graphState,
      edges: graphState.edges.filter((e) => e.id !== edgeId),
    },
  }
}

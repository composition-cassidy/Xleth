// FXG.4-c — Parameter Target Binding Contract
//
// Stable identity shape for exposed graph parameter ports.
// Future macro, LFO, envelope, peak-follower, and automation sources connect through this contract.
// This module is data-model only: no modulation execution, smoothing, or min/max depth scaling.

const KIND = 'graph-parameter'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isGraphParameterTarget(value) {
  return isPlainObject(value) && value.kind === KIND
}

// ---------------------------------------------------------------------------
// Target creation
//
// Creates a GraphParameterTarget from runtime context.
//   graphNode   — the graphState node (must have id and type === 'effect')
//   effectInstanceId — the node's effectInstanceId
//   descriptor  — the live parameter descriptor from FXG.4-a
//   trackId     — optional; omit for persisted targets, supply for runtime keys
// ---------------------------------------------------------------------------

export function createGraphParameterTarget({ trackId, graphNode, effectInstanceId, descriptor } = {}) {
  if (!isPlainObject(graphNode)) return null
  if (!isPlainObject(descriptor)) return null

  const graphNodeId = normalizeNonEmptyString(graphNode.id)
  if (!graphNodeId) return null

  const resolvedEffectInstanceId = normalizeNonEmptyString(effectInstanceId)
  if (!resolvedEffectInstanceId) return null

  const parameterId = normalizeNonEmptyString(descriptor.parameterId)
  if (!parameterId) return null

  const parameterIndexFallback =
    Number.isInteger(descriptor.parameterIndex) && descriptor.parameterIndex >= 0
      ? descriptor.parameterIndex
      : null

  const parameterIdIsFallback = descriptor.parameterIdIsFallback === true

  const target = {
    kind: KIND,
    graphNodeId,
    effectInstanceId: resolvedEffectInstanceId,
    parameterId,
    parameterIndexFallback,
    parameterIdIsFallback,
    nameSnapshot: normalizeNonEmptyString(descriptor.name) ?? parameterId,
    labelSnapshot: normalizeNonEmptyString(descriptor.unit) ?? null,
  }

  const pluginId = normalizeNonEmptyString(descriptor.pluginId ?? graphNode.data?.pluginId)
  if (pluginId) target.pluginId = pluginId

  const effectKind = normalizeNonEmptyString(descriptor.effectKind)
  if (effectKind) target.effectKind = effectKind

  const pluginFormat = normalizeNonEmptyString(descriptor.pluginFormat)
  if (pluginFormat) target.pluginFormat = pluginFormat

  if (typeof trackId === 'string' || typeof trackId === 'number') {
    const tid = String(trackId)
    if (tid.length > 0) target.trackId = tid
  }

  return target
}

// ---------------------------------------------------------------------------
// Normalization
//
// Repairs or drops malformed target data arriving from storage or unknown sources.
// Returns null if the target cannot be repaired to a valid shape.
// ---------------------------------------------------------------------------

export function normalizeGraphParameterTarget(raw) {
  if (!isPlainObject(raw)) return null
  if (raw.kind !== KIND) return null

  const graphNodeId = normalizeNonEmptyString(raw.graphNodeId)
  if (!graphNodeId) return null

  const effectInstanceId = normalizeNonEmptyString(raw.effectInstanceId)
  if (!effectInstanceId) return null

  const parameterId = normalizeNonEmptyString(raw.parameterId)
  if (!parameterId) return null

  const parameterIndexFallback =
    Number.isInteger(raw.parameterIndexFallback) && raw.parameterIndexFallback >= 0
      ? raw.parameterIndexFallback
      : null

  const parameterIdIsFallback = raw.parameterIdIsFallback === true

  // Fallback parameterId requires a finite, non-negative integer index.
  if (parameterIdIsFallback && parameterIndexFallback === null) return null

  const target = {
    kind: KIND,
    graphNodeId,
    effectInstanceId,
    parameterId,
    parameterIndexFallback,
    parameterIdIsFallback,
    nameSnapshot: normalizeNonEmptyString(raw.nameSnapshot) ?? parameterId,
    labelSnapshot: normalizeNonEmptyString(raw.labelSnapshot) ?? null,
  }

  const pluginId = normalizeNonEmptyString(raw.pluginId)
  if (pluginId) target.pluginId = pluginId

  const effectKind = normalizeNonEmptyString(raw.effectKind)
  if (effectKind) target.effectKind = effectKind

  const pluginFormat = normalizeNonEmptyString(raw.pluginFormat)
  if (pluginFormat) target.pluginFormat = pluginFormat

  return target
}

// ---------------------------------------------------------------------------
// Target keys
// ---------------------------------------------------------------------------

// Persisted key — track-agnostic so it is stable across sessions.
// Never includes raw engineNodeId or volatile session state.
// Use for undo/redo snapshots, automation binding maps, and persistence.
// Format: graph-param:{graphNodeId}:{effectInstanceId}:{parameterId}
export function getGraphParameterTargetKey(target) {
  if (!isGraphParameterTarget(target)) return null
  return `graph-param:${target.graphNodeId}:${target.effectInstanceId}:${target.parameterId}`
}

// Runtime key — extends the persisted key with trackId for cross-track uniqueness.
// Use in store/runtime paths only; never persist.
// Format: graph-param:{trackId}:{graphNodeId}:{effectInstanceId}:{parameterId}
export function getGraphParameterTargetRuntimeKey(trackId, target) {
  if (!isGraphParameterTarget(target)) return null
  const tid = typeof trackId === 'string' ? trackId : String(trackId ?? '')
  return `graph-param:${tid}:${target.graphNodeId}:${target.effectInstanceId}:${target.parameterId}`
}

// Stable port binding ID scoped to a graph node.
// Use as the value for data-parameter-port-id attributes on exposed port elements.
// Unique within the graph because graphNodeId is globally unique in graphState.
// Format: gpp:{graphNodeId}:{parameterId}
export function buildGraphParameterPortId(graphNodeId, parameterId) {
  const gid = normalizeNonEmptyString(graphNodeId)
  const pid = normalizeNonEmptyString(parameterId)
  if (!gid || !pid) return null
  return `gpp:${gid}:${pid}`
}

// ---------------------------------------------------------------------------
// Port matching
// ---------------------------------------------------------------------------

// Returns true if a GraphParameterTarget matches an exposed port.
// The caller is responsible for confirming target.graphNodeId matches the node
// the exposedPort belongs to.
export function doesTargetMatchExposedPort(target, exposedPort) {
  if (!isGraphParameterTarget(target)) return false
  if (!isPlainObject(exposedPort)) return false
  return target.parameterId === exposedPort.parameterId
}

// ---------------------------------------------------------------------------
// Resolution (graphState-only, no live engine call)
//
// Statuses returned:
//   ok                   — target resolves to an existing exposed port
//   invalid_target       — value is not a valid GraphParameterTarget
//   missing_node         — graphNodeId not found in graphState
//   missing_effect_instance — effectInstanceId does not match the node
//   missing_exposed_port — parameterId not in node.data.exposedParameterPorts
//
// missing_descriptor, plugin_unavailable — require a live engine call; not returned here.
// ---------------------------------------------------------------------------

export function resolveGraphParameterTarget(graphState, target) {
  if (!isGraphParameterTarget(target)) {
    return { status: 'invalid_target', target }
  }

  const nodes = Array.isArray(graphState?.nodes) ? graphState.nodes : []
  const node = nodes.find((n) => n.id === target.graphNodeId)

  if (!node) {
    return { status: 'missing_node', graphNodeId: target.graphNodeId }
  }

  const data = isPlainObject(node.data) ? node.data : {}
  const nodeEffectInstanceId = normalizeNonEmptyString(data.effectInstanceId)
  if (!nodeEffectInstanceId || nodeEffectInstanceId !== target.effectInstanceId) {
    return {
      status: 'missing_effect_instance',
      graphNodeId: target.graphNodeId,
      expectedEffectInstanceId: target.effectInstanceId,
      foundEffectInstanceId: nodeEffectInstanceId,
    }
  }

  const exposedPorts = Array.isArray(data.exposedParameterPorts) ? data.exposedParameterPorts : []
  const matchedPort = exposedPorts.find((port) => port.parameterId === target.parameterId)
  if (!matchedPort) {
    return {
      status: 'missing_exposed_port',
      graphNodeId: target.graphNodeId,
      parameterId: target.parameterId,
    }
  }

  return { status: 'ok', node, exposedPort: matchedPort }
}

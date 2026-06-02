const RUNTIME_NODE_TYPES = new Set(['trackInput', 'trackOutput', 'effect', 'unknown'])
// EVC.2 — envelope nodes are control/voice-controller nodes (like macro) and are
// excluded from the audio topology payload entirely.
const CONTROL_NODE_TYPES = new Set(['macro', 'envelope'])

function readString(value) {
  return typeof value === 'string' && value.length > 0 ? value : ''
}

function normalizeRuntimeNodeType(type) {
  return RUNTIME_NODE_TYPES.has(type) ? type : 'unknown'
}

export function buildLinearGraphTopologyPayload(graphState) {
  const nodes = Array.isArray(graphState?.nodes)
    ? graphState.nodes.filter((node) => !CONTROL_NODE_TYPES.has(node?.type)).map((node) => {
      const data = node?.data ?? {}
      const entry = {
        nodeId: readString(node?.id),
        type: normalizeRuntimeNodeType(node?.type),
      }
      if (entry.type === 'effect') {
        entry.effectInstanceId = readString(data.effectInstanceId)
        entry.pluginId = readString(data.pluginId)
        entry.missing = data.missing === true
        if (typeof data.displayName === 'string' && data.displayName.length > 0) {
          entry.displayName = data.displayName
        }
      }
      return entry
    }).filter((node) => node.nodeId)
    : []

  const nodeIds = new Set(nodes.map((node) => node.nodeId))
  const edges = Array.isArray(graphState?.edges)
    ? graphState.edges.reduce((payload, edge) => {
      if (!edge || edge.type !== 'audio') return payload
      const sourceNodeId = readString(edge.sourceNodeId)
      const targetNodeId = readString(edge.targetNodeId)
      if (!sourceNodeId || !targetNodeId || !nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) {
        return payload
      }
      payload.push({
        edgeId: readString(edge.id),
        sourceNodeId,
        targetNodeId,
        sourcePort: readString(edge.sourcePort),
        targetPort: readString(edge.targetPort),
        type: 'audio',
      })
      return payload
    }, [])
    : []

  return {
    phase: 'FXG.3-c-b',
    trackId: readString(graphState?.trackId),
    nodes,
    edges,
  }
}

export function analyzeLinearGraphTopologyPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'invalid_topology', pathNodeIds: [], effectNodeIds: [] }
  }
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    return { ok: false, reason: 'invalid_topology', pathNodeIds: [], effectNodeIds: [] }
  }

  const nodesById = new Map()
  let trackInputId = ''
  let trackOutputId = ''
  let trackInputCount = 0
  let trackOutputCount = 0

  for (const node of payload.nodes) {
    if (!node?.nodeId || nodesById.has(node.nodeId)) {
      return { ok: false, reason: 'invalid_topology', pathNodeIds: [], effectNodeIds: [] }
    }
    nodesById.set(node.nodeId, node)
    if (node.type === 'trackInput') {
      trackInputId = node.nodeId
      trackInputCount += 1
    } else if (node.type === 'trackOutput') {
      trackOutputId = node.nodeId
      trackOutputCount += 1
    }
  }

  if (trackInputCount !== 1 || trackOutputCount !== 1) {
    return { ok: false, reason: 'invalid_track_io_multiplicity', pathNodeIds: [], effectNodeIds: [] }
  }

  const outgoing = new Map(payload.nodes.map((node) => [node.nodeId, []]))
  const incoming = new Map(payload.nodes.map((node) => [node.nodeId, []]))
  for (const edge of payload.edges) {
    if (edge?.type !== 'audio') continue
    if (!nodesById.has(edge.sourceNodeId) || !nodesById.has(edge.targetNodeId)) {
      return { ok: false, reason: 'invalid_edge_reference', pathNodeIds: [], effectNodeIds: [] }
    }
    outgoing.get(edge.sourceNodeId).push(edge.targetNodeId)
    incoming.get(edge.targetNodeId).push(edge.sourceNodeId)
  }

  const pathNodeIds = [trackInputId]
  const effectNodeIds = []
  const visited = new Set([trackInputId])
  let current = trackInputId

  while (current !== trackOutputId) {
    const nextIds = outgoing.get(current) ?? []
    if (nextIds.length === 0) {
      return { ok: false, reason: 'no_linear_path', pathNodeIds, effectNodeIds }
    }
    if (nextIds.length > 1) {
      return { ok: false, reason: 'nonlinear_deferred', pathNodeIds, effectNodeIds }
    }
    if (current !== trackInputId && (incoming.get(current)?.length ?? 0) > 1) {
      return { ok: false, reason: 'nonlinear_deferred', pathNodeIds, effectNodeIds }
    }

    const next = nextIds[0]
    if (visited.has(next)) {
      return { ok: false, reason: 'cycle_detected', pathNodeIds, effectNodeIds }
    }
    if ((incoming.get(next)?.length ?? 0) > 1) {
      return { ok: false, reason: 'nonlinear_deferred', pathNodeIds, effectNodeIds }
    }

    const node = nodesById.get(next)
    if (!node) {
      return { ok: false, reason: 'invalid_edge_reference', pathNodeIds, effectNodeIds }
    }

    visited.add(next)
    pathNodeIds.push(next)
    if (next !== trackOutputId) {
      if (node.type !== 'effect') {
        return { ok: false, reason: 'unsupported_node_type', pathNodeIds, effectNodeIds }
      }
      effectNodeIds.push(next)
    }
    current = next
  }

  return {
    ok: true,
    reason: 'linear_supported',
    pathNodeIds,
    effectNodeIds,
    pathEffectInstanceIds: effectNodeIds
      .map((nodeId) => readString(nodesById.get(nodeId)?.effectInstanceId))
      .filter(Boolean),
  }
}

export function analyzeLinearGraphTopology(graphState) {
  return analyzeLinearGraphTopologyPayload(buildLinearGraphTopologyPayload(graphState))
}

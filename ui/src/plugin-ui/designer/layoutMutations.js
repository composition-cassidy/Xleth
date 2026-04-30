import { regenerateSubtreeIds, nextId } from './idGenerator.js'

const CONTAINER_TYPES = new Set(['panel', 'group', 'row', 'column', 'tabGroup', 'freeformLayer'])
const WRAPPABLE_CONTAINER_TYPES = new Set(['group', 'row', 'column'])

// Leaf types eligible to live as direct children of a freeformLayer.
const FREEFORM_ELIGIBLE_LEAF_TYPES = new Set([
  'knob', 'toggle', 'button', 'meter', 'visualizer', 'label', 'spacer',
  'decorText', 'decorLine', 'decorShape', 'decal',
])

// Flow containers that can be bulk-converted to a freeformLayer.
const FLOW_CONTAINER_TYPES = new Set(['group', 'row', 'column'])

// Style keys that only make sense in flow layouts; stripped when moving to freeform.
const FLOW_ONLY_STYLE_KEYS = new Set([
  'flexBasis', 'growsToFill', 'align', 'justify', 'gapPx', 'paddingPx',
])

const ALLOWED_STYLE_KEYS = new Set([
  'paddingPx',
  'gapPx',
  'widthPx',
  'heightPx',
  'growsToFill',
  'align',
  'justify',
  'flexBasis',
])

export function findNode(layout, nodeId) {
  if (!nodeId || !layout?.root) return null
  return findNodeInTree(layout.root, nodeId)
}

export function nodeExists(layout, nodeId) {
  if (!nodeId) return false
  return collectNodeIds(layout).has(nodeId)
}

export function collectNodeIds(layout) {
  const ids = new Set()
  collectIdsFromNode(layout?.root, ids)
  return ids
}

export function isContainerNode(node) {
  return !!node && CONTAINER_TYPES.has(node.type)
}

export function getParentInfo(layout, nodeId) {
  assertNodeId(nodeId)
  if (!layout?.root) return null

  if (layout.root.id === nodeId) {
    return {
      node: layout.root,
      parent: null,
      parentId: null,
      siblings: null,
      index: -1,
    }
  }

  return findParentInfo(layout.root, nodeId)
}

export function updateNodeProps(layout, nodeId, propsPatch = {}) {
  assertNodeId(nodeId)
  return updateNode(layout, nodeId, node => {
    const nextProps = applyPatch(node.props, propsPatch)
    const nextNode = {
      ...node,
      props: nextProps,
    }

    if (Object.keys(nextProps).length === 0) {
      delete nextNode.props
    }

    return nextNode
  })
}

export function updateNodeStyle(layout, nodeId, stylePatch = {}) {
  assertNodeId(nodeId)
  const allowedPatch = {}

  for (const [key, value] of Object.entries(stylePatch || {})) {
    if (!ALLOWED_STYLE_KEYS.has(key)) continue
    allowedPatch[key] = value
  }

  return updateNode(layout, nodeId, node => {
    const nextStyle = applyPatch(node.style, allowedPatch)
    const nextNode = {
      ...node,
      style: nextStyle,
    }

    if (Object.keys(nextStyle).length === 0) {
      delete nextNode.style
    }

    return nextNode
  })
}

export function updateNodeId(layout, nodeId, newId) {
  assertNodeId(nodeId)
  const trimmedId = String(newId ?? '').trim()

  if (!trimmedId) {
    throw new Error('Node id cannot be empty')
  }

  if (trimmedId === nodeId) {
    return layout
  }

  if (nodeExists(layout, trimmedId)) {
    throw new Error(`Node id "${trimmedId}" already exists`)
  }

  return updateNode(layout, nodeId, node => ({
    ...node,
    id: trimmedId,
  }))
}

export function addChild(layout, parentId, childTemplate, atIndex) {
  assertNodeId(parentId)
  const parent = findNode(layout, parentId)

  if (!parent) {
    throw new Error(`Parent node "${parentId}" was not found`)
  }

  if (!isContainerNode(parent)) {
    throw new Error(`Node "${parentId}" cannot contain children`)
  }

  const child = regenerateSubtreeIds(layout, childTemplate)
  const children = Array.isArray(parent.children) ? parent.children : []
  const insertIndex = normalizeInsertIndex(atIndex, children.length)

  return replaceNodeChildren(layout, parentId, [
    ...children.slice(0, insertIndex),
    child,
    ...children.slice(insertIndex),
  ])
}

export function removeNode(layout, nodeId) {
  assertNodeId(nodeId)
  if (layout?.root?.id === nodeId) {
    throw new Error('Root node cannot be removed')
  }

  const parentInfo = getParentInfo(layout, nodeId)
  if (!parentInfo?.parent) {
    throw new Error(`Node "${nodeId}" was not found`)
  }

  const nextChildren = parentInfo.siblings.filter(child => child?.id !== nodeId)
  return replaceNodeChildren(layout, parentInfo.parent.id, nextChildren)
}

export function duplicateNode(layout, nodeId) {
  assertNodeId(nodeId)
  if (layout?.root?.id === nodeId) {
    throw new Error('Root node cannot be duplicated')
  }

  const parentInfo = getParentInfo(layout, nodeId)
  if (!parentInfo?.parent) {
    throw new Error(`Node "${nodeId}" was not found`)
  }

  const duplicate = regenerateSubtreeIds(layout, parentInfo.node)
  const insertIndex = parentInfo.index + 1
  const nextChildren = [
    ...parentInfo.siblings.slice(0, insertIndex),
    duplicate,
    ...parentInfo.siblings.slice(insertIndex),
  ]

  return replaceNodeChildren(layout, parentInfo.parent.id, nextChildren)
}

export function moveNode(layout, nodeId, newParentId, newIndex) {
  assertNodeId(nodeId)
  assertNodeId(newParentId)

  if (layout?.root?.id === nodeId) {
    throw new Error('Root node cannot be moved')
  }

  if (nodeId === newParentId) {
    throw new Error('Cannot move a node into itself')
  }

  const node = findNode(layout, nodeId)
  const newParent = findNode(layout, newParentId)
  const currentParentInfo = getParentInfo(layout, nodeId)

  if (!node || !currentParentInfo?.parent) {
    throw new Error(`Node "${nodeId}" was not found`)
  }

  if (!newParent) {
    throw new Error(`Parent node "${newParentId}" was not found`)
  }

  if (!isContainerNode(newParent)) {
    throw new Error(`Node "${newParentId}" cannot contain children`)
  }

  if (containsNodeId(node, newParentId)) {
    throw new Error('Cannot move a node into its own descendant')
  }

  const withoutNode = removeNode(layout, nodeId)
  const parentAfterRemoval = findNode(withoutNode, newParentId)
  const targetChildren = Array.isArray(parentAfterRemoval.children) ? parentAfterRemoval.children : []
  const insertIndex = normalizeInsertIndex(newIndex, targetChildren.length)

  return replaceNodeChildren(withoutNode, newParentId, [
    ...targetChildren.slice(0, insertIndex),
    stripDesignerAnnotationsDeep(node),
    ...targetChildren.slice(insertIndex),
  ])
}

export function reorderSibling(layout, nodeId, directionOrIndex) {
  assertNodeId(nodeId)
  const parentInfo = getParentInfo(layout, nodeId)

  if (!parentInfo?.parent) {
    throw new Error('Root node cannot be reordered')
  }

  const fromIndex = parentInfo.index
  const toIndex = resolveSiblingTargetIndex(directionOrIndex, fromIndex, parentInfo.siblings.length)

  if (toIndex === fromIndex) return layout

  const nextChildren = [...parentInfo.siblings]
  const [node] = nextChildren.splice(fromIndex, 1)
  nextChildren.splice(toIndex, 0, node)

  return replaceNodeChildren(layout, parentInfo.parent.id, nextChildren)
}

export function wrapInContainer(layout, nodeIds, containerType) {
  if (!WRAPPABLE_CONTAINER_TYPES.has(containerType)) {
    throw new Error(`Cannot wrap nodes in "${containerType}"`)
  }

  const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : []
  if (ids.length === 0) {
    throw new Error('Select at least one node to wrap')
  }

  const infos = ids.map(id => getParentInfo(layout, id))
  if (infos.some(info => !info?.parent)) {
    throw new Error('Root node cannot be wrapped')
  }

  const parentId = infos[0].parent.id
  if (infos.some(info => info.parent.id !== parentId)) {
    throw new Error('Only sibling nodes can be wrapped')
  }

  const orderedInfos = [...infos].sort((a, b) => a.index - b.index)
  for (let i = 1; i < orderedInfos.length; i += 1) {
    if (orderedInfos[i].index !== orderedInfos[i - 1].index + 1) {
      throw new Error('Only contiguous sibling nodes can be wrapped')
    }
  }

  const firstIndex = orderedInfos[0].index
  const lastIndex = orderedInfos[orderedInfos.length - 1].index
  const parent = infos[0].parent
  const siblings = infos[0].siblings
  const wrappedChildren = siblings.slice(firstIndex, lastIndex + 1)
  const wrapper = {
    id: nextId(layout, containerType),
    type: containerType,
    children: wrappedChildren,
  }

  const nextChildren = [
    ...siblings.slice(0, firstIndex),
    wrapper,
    ...siblings.slice(lastIndex + 1),
  ]

  return replaceNodeChildren(layout, parent.id, nextChildren)
}

// ── Freeform-C.5 helpers ──────────────────────────────────────────────────────

export function isFreeformLayer(node) {
  return node?.type === 'freeformLayer'
}

export function isFreeformEligibleLeaf(node) {
  return !!node && FREEFORM_ELIGIBLE_LEAF_TYPES.has(node.type)
}

/**
 * Recursively collect all eligible leaf descendants of a container node.
 * Traverses nested group/row/column; throws on nested freeformLayer or tabGroup.
 * Returns a flat array of leaf nodes (intermediate containers are discarded).
 */
export function collectEligibleLeafDescendants(node) {
  const results = []

  function walk(n) {
    if (!n) return
    if (isFreeformEligibleLeaf(n)) {
      results.push(n)
      return
    }
    if (n.type === 'freeformLayer') {
      throw new Error('Cannot convert: contains a nested freeformLayer. Remove it first.')
    }
    if (n.type === 'tabGroup') {
      throw new Error('Cannot convert: contains a tabGroup which cannot be measured for freeform placement.')
    }
    if (FLOW_CONTAINER_TYPES.has(n.type)) {
      const children = Array.isArray(n.children) ? n.children : []
      for (const child of children) {
        if (child) walk(child)
      }
      return
    }
    throw new Error(`Child node "${n.id}" of type "${n.type}" is not eligible for freeform placement.`)
  }

  const children = Array.isArray(node?.children) ? node.children : []
  for (const child of children) {
    if (child) walk(child)
  }
  return results
}

/**
 * Returns a Set of all eligible leaf descendant ids in the container.
 */
export function collectEligibleLeafDescendantIds(layout, containerId) {
  const container = findNode(layout, containerId)
  if (!container) return new Set()
  return new Set(collectEligibleLeafDescendants(container).map(n => n.id))
}

/**
 * Move a single eligible leaf node into a freeformLayer with an explicit frame.
 * Removes the node from its old parent; inserts it into targetLayerId.
 * Flow-only style keys are stripped; all props/bindings/appearance are preserved.
 */
export function moveNodeIntoFreeformLayer(layout, nodeId, targetLayerId, frame, atIndex) {
  assertNodeId(nodeId)
  assertNodeId(targetLayerId)

  if (layout?.root?.id === nodeId) throw new Error('Root node cannot be moved')

  const node = findNode(layout, nodeId)
  if (!node) throw new Error(`Node "${nodeId}" was not found`)
  if (!isFreeformEligibleLeaf(node)) {
    throw new Error(`Node "${nodeId}" of type "${node.type}" cannot be moved into a freeform layer`)
  }

  const targetLayer = findNode(layout, targetLayerId)
  if (!targetLayer) throw new Error(`Target layer "${targetLayerId}" was not found`)
  if (!isFreeformLayer(targetLayer)) throw new Error(`Node "${targetLayerId}" is not a freeform layer`)

  // Build the node with a frame and cleaned style.
  const cleanStyle = stripFlowOnlyStyleKeys(node.style)
  const nodeWithFrame = {
    ...stripDesignerAnnotationsDeep(node),
    props: { ...(node.props || {}), frame: { ...frame } },
  }
  if (Object.keys(cleanStyle).length > 0) {
    nodeWithFrame.style = cleanStyle
  } else {
    delete nodeWithFrame.style
  }

  // Remove from old parent first.
  const withoutNode = removeNode(layout, nodeId)

  // Insert into freeform layer.
  const layerAfterRemoval = findNode(withoutNode, targetLayerId)
  const children = Array.isArray(layerAfterRemoval.children) ? layerAfterRemoval.children : []
  const insertIndex = normalizeInsertIndex(atIndex, children.length)

  return replaceNodeChildren(withoutNode, targetLayerId, [
    ...children.slice(0, insertIndex),
    nodeWithFrame,
    ...children.slice(insertIndex),
  ])
}

/**
 * Move multiple eligible leaf nodes into a freeformLayer in sequence.
 * nodeFrames: Array<{ nodeId: string, frame: object }>
 */
export function moveNodesIntoFreeformLayer(layout, nodeFrames, targetLayerId, atIndex) {
  let current = layout
  let nextIndex = atIndex

  for (const { nodeId, frame } of nodeFrames) {
    current = moveNodeIntoFreeformLayer(current, nodeId, targetLayerId, frame, nextIndex)
    if (typeof nextIndex === 'number') nextIndex += 1
  }

  return current
}

/**
 * Replace a flow container (group/row/column) with a freeformLayer.
 * Direct children must all be eligible leaves — no nested containers allowed.
 *
 * measuredFrames: plain object keyed by child nodeId → frame.
 *   May include the special key `__container__` → { widthPx, heightPx }
 *   for the new layer's style dimensions (defaults to 480×160 if absent).
 *
 * options:
 *   layerId — explicit id for the new freeformLayer (defaults to generated id)
 */
export function convertContainerToFreeformLayer(layout, containerId, measuredFrames = {}, options = {}) {
  assertNodeId(containerId)
  if (layout?.root?.id === containerId) throw new Error('Root node cannot be converted')

  const container = findNode(layout, containerId)
  if (!container) throw new Error(`Container "${containerId}" was not found`)

  if (!FLOW_CONTAINER_TYPES.has(container.type)) {
    throw new Error(
      `Node "${containerId}" of type "${container.type}" cannot be converted (only group/row/column)`,
    )
  }

  // Collect all eligible leaf descendants at any depth (flattens nested flow containers).
  // Throws if a nested freeformLayer or tabGroup is encountered.
  const leafDescendants = collectEligibleLeafDescendants(container)

  const parentInfo = getParentInfo(layout, containerId)
  if (!parentInfo?.parent) throw new Error(`Container "${containerId}" has no parent`)

  const containerDims = measuredFrames.__container__ ?? {}
  const layerWidthPx  = Math.round(containerDims.widthPx)  || 480
  const layerHeightPx = Math.round(containerDims.heightPx) || 160
  const layerId = options.layerId ?? nextId(layout, 'freeform-layer')

  const freeformChildren = leafDescendants.map(child => {
    const frame     = measuredFrames[child.id] ?? { x: 0, y: 0, widthPx: 80, heightPx: 40 }
    const cleanStyle = stripFlowOnlyStyleKeys(child.style)
    const nodeWithFrame = {
      ...stripDesignerAnnotationsDeep(child),
      props: { ...(child.props || {}), frame: { ...frame } },
    }
    if (Object.keys(cleanStyle).length > 0) {
      nodeWithFrame.style = cleanStyle
    } else {
      delete nodeWithFrame.style
    }
    return nodeWithFrame
  })

  const freeformLayer = {
    id: layerId,
    type: 'freeformLayer',
    style: { widthPx: layerWidthPx, heightPx: layerHeightPx },
    props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
    children: freeformChildren,
  }

  const { siblings, index: containerIndex } = parentInfo
  const nextChildren = [
    ...siblings.slice(0, containerIndex),
    freeformLayer,
    ...siblings.slice(containerIndex + 1),
  ]

  return replaceNodeChildren(layout, parentInfo.parent.id, nextChildren)
}

// ── Private: style cleanup ────────────────────────────────────────────────────

function stripFlowOnlyStyleKeys(style) {
  if (!style || typeof style !== 'object') return {}
  const result = {}
  for (const [key, value] of Object.entries(style)) {
    if (!FLOW_ONLY_STYLE_KEYS.has(key)) result[key] = value
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────

function updateNode(layout, nodeId, updater) {
  if (!layout?.root) {
    throw new Error('Layout has no root node')
  }

  let found = false

  function visit(node) {
    if (!node || typeof node !== 'object') return node

    if (node.id === nodeId) {
      found = true
      return updater(node)
    }

    if (!Array.isArray(node.children) || node.children.length === 0) {
      return node
    }

    let childrenChanged = false
    const nextChildren = node.children.map(child => {
      const nextChild = visit(child)
      if (nextChild !== child) childrenChanged = true
      return nextChild
    })

    if (!childrenChanged) return node
    return {
      ...node,
      children: nextChildren,
    }
  }

  const nextRoot = visit(layout.root)
  if (!found) {
    throw new Error(`Node "${nodeId}" was not found`)
  }

  if (nextRoot === layout.root) return layout
  return {
    ...layout,
    root: nextRoot,
  }
}

function replaceNodeChildren(layout, nodeId, children) {
  return updateNode(layout, nodeId, node => ({
    ...node,
    children,
  }))
}

function applyPatch(base, patch) {
  const next = { ...(base || {}) }

  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }

  return next
}

function findNodeInTree(node, nodeId) {
  if (!node || typeof node !== 'object') return null
  if (node.id === nodeId) return node

  for (const child of node.children || []) {
    const found = findNodeInTree(child, nodeId)
    if (found) return found
  }

  return null
}

function findParentInfo(parent, nodeId) {
  if (!parent || typeof parent !== 'object') return null
  const children = Array.isArray(parent.children) ? parent.children : []

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child?.id === nodeId) {
      return {
        node: child,
        parent,
        parentId: parent.id,
        siblings: children,
        index,
      }
    }

    const found = findParentInfo(child, nodeId)
    if (found) return found
  }

  return null
}

function collectIdsFromNode(node, ids) {
  if (!node || typeof node !== 'object') return
  if (node.id) ids.add(node.id)
  for (const child of node.children || []) {
    collectIdsFromNode(child, ids)
  }
}

function assertNodeId(nodeId) {
  if (!nodeId || typeof nodeId !== 'string') {
    throw new Error('A node id is required')
  }
}

function normalizeInsertIndex(index, length) {
  if (!Number.isInteger(index)) return length
  return Math.max(0, Math.min(index, length))
}

function resolveSiblingTargetIndex(directionOrIndex, fromIndex, siblingCount) {
  if (directionOrIndex === 'up') return Math.max(0, fromIndex - 1)
  if (directionOrIndex === 'down') return Math.min(siblingCount - 1, fromIndex + 1)

  if (typeof directionOrIndex === 'number') {
    return Math.max(0, Math.min(directionOrIndex, siblingCount - 1))
  }

  throw new Error(`Unknown sibling reorder target: ${directionOrIndex}`)
}

function containsNodeId(node, nodeId) {
  if (!node || typeof node !== 'object') return false
  if (node.id === nodeId) return true
  return (node.children || []).some(child => containsNodeId(child, nodeId))
}

function stripDesignerAnnotationsDeep(node) {
  if (!node || typeof node !== 'object') return node
  const {
    _invalid,
    _vizUnavailable,
    _invalidIdx,
    ...cleanNode
  } = node

  if (Array.isArray(node.children)) {
    cleanNode.children = node.children.map(stripDesignerAnnotationsDeep)
  }

  return cleanNode
}

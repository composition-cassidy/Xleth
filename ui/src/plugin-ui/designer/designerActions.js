import { validate } from '../schema/validate.js'
import { getPaletteEntry } from './paletteCatalog.js'
import {
  addChild,
  collectEligibleLeafDescendantIds,
  collectNodeIds,
  convertContainerToFreeformLayer,
  duplicateNode,
  findNode,
  getParentInfo,
  isContainerNode,
  isFreeformEligibleLeaf,
  isFreeformLayer,
  moveNode,
  moveNodeIntoFreeformLayer,
  removeNode,
  reorderSibling,
  updateNodeId,
  updateNodeProps,
  updateNodeStyle,
  wrapInContainer,
} from './layoutMutations.js'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import { dragFrame, nudgeFrame, resizeFrame } from './freeformGeometry.js'
import {
  buildFrameFromRects,
  getNodeRectInPreview,
  measureChildrenForFreeform,
} from './freeformMeasure.js'
import { nextId } from './idGenerator.js'
import { resolveSafePresetForSource } from './inspectors/inspectorHelpers.js'

// Module-level mutable reference to the preview host element.
// DesignerPreview.jsx calls setPreviewHostEl(el) when it mounts/unmounts.
// Actions read this instead of putting DOM refs into Zustand state.
let _previewHostEl = null

export function setPreviewHostEl(el) {
  _previewHostEl = el ?? null
}

export function renameSelectedNode(newId) {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => updateNodeId(layout, selectedNodeId, newId),
    nextSelectedNodeId: () => String(newId ?? '').trim(),
    undoReason: 'rename id',
  })
}

export function patchSelectedProps(propsPatch, options = {}) {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => updateNodeProps(layout, selectedNodeId, propsPatch),
    undoReason: 'patch props',
    undoOptions: inferScalarEditOptions('props', propsPatch, options),
  })
}

export function patchSelectedStyle(stylePatch, options = {}) {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => updateNodeStyle(layout, selectedNodeId, stylePatch),
    undoReason: 'patch style',
    undoOptions: inferScalarEditOptions('style', stylePatch, options),
  })
}

const DECOR_TYPES = new Set(['decorText', 'decorLine', 'decorShape', 'decal'])

export function addChildToSelected(type) {
  const entry = getPaletteEntry(type)
  if (!entry) return failFromStore(`Cannot add "${type}"`)

  // Decoration nodes must live inside a freeformLayer — use a narrower target resolver.
  if (DECOR_TYPES.has(type)) {
    return mutateSelectedLayout({
      mutate: (layout, selectedNodeId) => {
        const target = resolveDecorInsertionTarget(layout, selectedNodeId)
        return addChild(layout, target.parentId, entry.template, target.index)
      },
      nextSelectedNodeId: (nextLayout, _sid, previousLayout) => findNewNodeId(previousLayout, nextLayout),
      expandNodeId: (_nextLayout, selectedNodeId, previousLayout) => {
        try { return resolveDecorInsertionTarget(previousLayout, selectedNodeId).parentId } catch { return null }
      },
      requireSelection: false,
      undoReason: `add ${type}`,
    })
  }

  // For visualizer nodes, resolve the source/preset from the active manifest so
  // we never insert a Compressor source into a Limiter layout (or vice-versa).
  let resolvedTemplate = entry.template
  if (type === 'visualizer') {
    const manifest = usePluginUIDesignerStore.getState().manifest
    const sources = Array.isArray(manifest?.vizSources) ? manifest.vizSources : []
    if (sources.length === 0) {
      return failFromStore(
        'This plugin has no visualizer sources. Cannot add a Visualizer.',
      )
    }
    const source = sources[0]
    const preset = resolveSafePresetForSource(source)
    resolvedTemplate = { ...entry.template, props: { ...entry.template.props, source, preset } }
  }

  const template = resolvedTemplate
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => {
      const target = resolveInsertionTarget(layout, selectedNodeId)
      return addChild(layout, target.parentId, template, target.index)
    },
    nextSelectedNodeId: (nextLayout, selectedNodeId, previousLayout) => findNewNodeId(previousLayout, nextLayout),
    expandNodeId: (nextLayout, selectedNodeId, previousLayout) => resolveInsertionTarget(previousLayout, selectedNodeId).parentId,
    requireSelection: false,
    undoReason: `add ${type}`,
  })
}

export function removeSelectedNode() {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => removeNode(layout, selectedNodeId),
    nextSelectedNodeId: (_nextLayout, selectedNodeId, previousLayout) => {
      const parentInfo = getParentInfo(previousLayout, selectedNodeId)
      return parentInfo?.parent?.id ?? previousLayout?.root?.id ?? null
    },
    undoReason: 'remove node',
  })
}

export function duplicateSelectedNode() {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => duplicateNode(layout, selectedNodeId),
    nextSelectedNodeId: (nextLayout, _selectedNodeId, previousLayout) => findNewNodeId(previousLayout, nextLayout),
    undoReason: 'duplicate node',
  })
}

export function moveSelectedNodeUp() {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => reorderSibling(layout, selectedNodeId, 'up'),
    undoReason: 'move node up',
  })
}

export function moveSelectedNodeDown() {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => reorderSibling(layout, selectedNodeId, 'down'),
    undoReason: 'move node down',
  })
}

export function wrapSelectedIn(type) {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => wrapInContainer(layout, [selectedNodeId], type),
    nextSelectedNodeId: (nextLayout, _selectedNodeId, previousLayout) => findNewNodeId(previousLayout, nextLayout),
    expandNodeId: (nextLayout, _selectedNodeId, previousLayout) => findNewNodeId(previousLayout, nextLayout),
    undoReason: `wrap in ${type}`,
  })
}

export function moveSelectedNodeTo(newParentId, newIndex) {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => moveNode(layout, selectedNodeId, newParentId, newIndex),
    undoReason: 'move node',
  })
}

function mutateSelectedLayout({
  mutate,
  nextSelectedNodeId,
  expandNodeId,
  requireSelection = true,
  undoReason = 'layout edit',
  undoOptions = null,
}) {
  const store = usePluginUIDesignerStore.getState()
  const {
    workingLayout,
    selectedNodeId,
    setWorkingLayout,
    setSelectedNodeId,
    setMutationError,
    pushUndoSnapshot,
    toggleNodeExpanded,
  } = store

  if (!workingLayout) {
    return fail(setMutationError, 'No layout is loaded')
  }

  if (!selectedNodeId && requireSelection) {
    return fail(setMutationError, 'Select a node before editing')
  }

  try {
    const nextLayout = mutate(workingLayout, selectedNodeId)
    const result = validate(nextLayout, store.manifest ?? null)

    if (!result.ok) {
      return fail(setMutationError, formatValidationErrors(result.errors))
    }

    if (layoutsEqual(workingLayout, result.doc)) {
      setMutationError(null)
      return { ok: true, layout: result.doc, selectedNodeId }
    }

    pushUndoSnapshot(undoReason, withSelectedNodeId(undoOptions, selectedNodeId))
    setWorkingLayout(result.doc)

    const selectedAfterMutation = nextSelectedNodeId?.(result.doc, selectedNodeId, workingLayout) ?? selectedNodeId
    setSelectedNodeId(selectedAfterMutation)

    const nodeToExpand = expandNodeId?.(result.doc, selectedNodeId, workingLayout)
    if (nodeToExpand) {
      toggleNodeExpanded(nodeToExpand, true)
    }

    setMutationError(null)

    return { ok: true, layout: result.doc, selectedNodeId: selectedAfterMutation }
  } catch (err) {
    return fail(setMutationError, err)
  }
}

function failFromStore(error) {
  return fail(usePluginUIDesignerStore.getState().setMutationError, error)
}

function fail(setMutationError, error) {
  const message = String(error?.message || error || 'Mutation failed')
  setMutationError(message)
  return { ok: false, error: message }
}

function inferScalarEditOptions(scope, patch, options = {}) {
  if (options?.editMeta || options?.coalesce) return options

  const entries = Object.entries(patch || {})
  if (entries.length !== 1) return null

  const [field, value] = entries[0]
  if (!isScalarValue(value)) return null

  return {
    editMeta: {
      kind: 'scalar',
      fieldPath: `${scope}.${field}`,
    },
  }
}

function withSelectedNodeId(options, selectedNodeId) {
  if (!options?.editMeta && !options?.coalesce) return options

  if (options.editMeta) {
    return {
      ...options,
      editMeta: {
        ...options.editMeta,
        nodeId: options.editMeta.nodeId ?? selectedNodeId,
      },
    }
  }

  return {
    ...options,
    coalesce: {
      ...options.coalesce,
      nodeId: options.coalesce.nodeId ?? selectedNodeId,
    },
  }
}

function isScalarValue(value) {
  return value == null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
}

function layoutsEqual(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function formatValidationErrors(errors = []) {
  if (!errors.length) return 'Layout validation failed'
  return errors.map(error => error.message || error.code || 'Layout validation failed').join('; ')
}

function resolveInsertionTarget(layout, selectedNodeId) {
  if (!layout?.root) {
    throw new Error('No layout is loaded')
  }

  if (!selectedNodeId) {
    if (!isContainerNode(layout.root)) {
      throw new Error('Root node cannot contain children')
    }
    return { parentId: layout.root.id, index: undefined }
  }

  const selectedNode = findNode(layout, selectedNodeId)
  if (!selectedNode) {
    throw new Error(`Selected node "${selectedNodeId}" was not found`)
  }

  // freeformLayer is a container, but regular controls cannot be inserted into
  // it as direct children (they would need props.frame). Treat it like a leaf
  // so the new node becomes a sibling of the freeformLayer instead.
  if (isContainerNode(selectedNode) && !isFreeformLayer(selectedNode)) {
    return { parentId: selectedNode.id, index: undefined }
  }

  const parentInfo = getParentInfo(layout, selectedNodeId)
  if (!parentInfo?.parent) {
    throw new Error(`Node "${selectedNodeId}" cannot receive siblings`)
  }

  // If the immediate parent is a freeformLayer, skip it and insert as a sibling
  // of the freeformLayer in its own parent flow container instead.
  if (isFreeformLayer(parentInfo.parent)) {
    const layerParentInfo = getParentInfo(layout, parentInfo.parent.id)
    if (!layerParentInfo?.parent) {
      throw new Error(
        'Cannot add controls directly to a Freeform Layer. Select a row, column, or group instead.',
      )
    }
    return { parentId: layerParentInfo.parent.id, index: layerParentInfo.index + 1 }
  }

  return { parentId: parentInfo.parent.id, index: parentInfo.index + 1 }
}

function findNewNodeId(previousLayout, nextLayout) {
  const beforeIds = collectNodeIds(previousLayout)
  for (const id of collectNodeIds(nextLayout)) {
    if (!beforeIds.has(id)) return id
  }
  return null
}

function resolveDecorInsertionTarget(layout, selectedNodeId) {
  if (!layout?.root) throw new Error('No layout is loaded')

  const selectedNode = selectedNodeId ? findNode(layout, selectedNodeId) : null

  // Selected is a freeformLayer → insert at end of its children
  if (selectedNode?.type === 'freeformLayer') {
    return { parentId: selectedNode.id, index: undefined }
  }

  // Selected is a child whose direct parent is a freeformLayer → insert as next sibling
  if (selectedNode) {
    const parentInfo = getParentInfo(layout, selectedNodeId)
    if (parentInfo?.parent?.type === 'freeformLayer') {
      return { parentId: parentInfo.parent.id, index: parentInfo.index + 1 }
    }
  }

  throw new Error(
    'Decoration nodes must live inside a Freeform Layer. Add or select a Freeform Layer first.',
  )
}

// ── Freeform frame actions ────────────────────────────────────────────────────

// Live frame update during drag/resize gestures.
// Does NOT push to undo and does NOT validate — the overlay calls
// pushUndoSnapshot once at gesture start, then calls setFrameLive on every
// pointer move for smooth rendering. Frame values are pre-clamped by
// dragFrame/resizeFrame, so skipping validation here is safe.
export function setFrameLive(nodeId, newFrame) {
  const store = usePluginUIDesignerStore.getState()
  const { workingLayout, savedOverride, shippedLayout } = store
  if (!workingLayout || !nodeId) return
  try {
    const nextLayout = updateNodeProps(workingLayout, nodeId, { frame: newFrame })
    const base = savedOverride ?? shippedLayout
    let dirty = true
    try { dirty = JSON.stringify(nextLayout) !== JSON.stringify(base) } catch {}
    // Direct state patch — bypass store's setWorkingLayout (which re-validates
    // and uses result.doc, which is absent when manifest is null in tests).
    usePluginUIDesignerStore.setState({ workingLayout: nextLayout, dirty })
  } catch {
    // silently skip invalid live updates
  }
}

// Called once at pointer-up after a drag/resize gesture.
// Runs a full setWorkingLayout pass so validationResult is fresh and dirty is canonical.
export function commitFrameGesture() {
  const { workingLayout, setWorkingLayout } = usePluginUIDesignerStore.getState()
  if (workingLayout) setWorkingLayout(workingLayout)
}

// Discrete nudge — each call is one undo item (coalesced within 400 ms).
export function nudgeSelectedFrame(direction, opts = {}) {
  return mutateSelectedLayout({
    mutate: (layout, selectedNodeId) => {
      const node = findNode(layout, selectedNodeId)
      if (!node?.props?.frame) throw new Error('Selected node has no frame (not in a freeform layer)')
      const parentInfo = getParentInfo(layout, selectedNodeId)
      const snap = parentInfo?.parent?.props?.snap ?? {}
      const newFrame = nudgeFrame(node.props.frame, direction, {
        gridPx: snap.gridPx ?? 8,
        shiftKey: opts.shiftKey,
        altKey:   opts.altKey,
      })
      return updateNodeProps(layout, selectedNodeId, { frame: newFrame })
    },
    undoReason: `nudge ${direction}`,
    undoOptions: {
      editMeta: {
        kind:      'scalar',
        fieldPath: `frame.nudge.${direction}`,
      },
    },
  })
}

// ── Freeform-C.5: layer resolution ───────────────────────────────────────────

/** Return all freeformLayer nodes in the layout as { id, label } options. */
export function getFreeformLayerOptions(layout) {
  const layers = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'freeformLayer') layers.push({ id: node.id, label: `#${node.id}` })
    for (const child of node.children || []) walk(child)
  }
  walk(layout?.root)
  return layers
}

/** Return the id of the first freeformLayer in the layout, or null. */
export function findFirstFreeformLayer(layout) {
  return getFreeformLayerOptions(layout)[0]?.id ?? null
}

/**
 * Find the freeformLayer closest (by siblingship in the same parent) to the
 * given node. Falls back to the first freeformLayer in the whole tree.
 */
export function findNearestFreeformLayer(layout, selectedNodeId) {
  if (!layout?.root) return null
  const parentInfo = selectedNodeId ? getParentInfo(layout, selectedNodeId) : null
  if (parentInfo?.parent) {
    const sibling = (parentInfo.siblings || []).find(
      s => s && s.id !== selectedNodeId && isFreeformLayer(s),
    )
    if (sibling) return sibling.id
  }
  return findFirstFreeformLayer(layout)
}

// ── Freeform-C.5: move/convert actions ───────────────────────────────────────

/**
 * Move the currently selected eligible leaf node into a freeformLayer.
 * Measures the node's current DOM position to derive its frame.
 *
 * targetLayerId — explicit target; if omitted, auto-resolves to nearest layer.
 */
export function moveSelectedNodeToFreeform(targetLayerId) {
  const store = usePluginUIDesignerStore.getState()
  const { workingLayout, selectedNodeId, setMutationError } = store

  if (!selectedNodeId) {
    return fail(setMutationError, 'Select a leaf control before moving into Freeform.')
  }

  const selectedNode = findNode(workingLayout, selectedNodeId)
  if (!selectedNode || !isFreeformEligibleLeaf(selectedNode)) {
    return fail(setMutationError, 'Select a leaf control before moving into Freeform.')
  }

  const resolvedLayerId = targetLayerId ?? findNearestFreeformLayer(workingLayout, selectedNodeId)
  if (!resolvedLayerId) {
    return fail(setMutationError, 'Select a Freeform Layer target first.')
  }

  const targetLayer = findNode(workingLayout, resolvedLayerId)
  if (!targetLayer || !isFreeformLayer(targetLayer)) {
    return fail(setMutationError, 'Select a Freeform Layer target first.')
  }

  if (!_previewHostEl) {
    return fail(setMutationError, 'Could not measure the selected node in the preview.')
  }

  const measureResult = measureChildrenForFreeform(_previewHostEl, [selectedNodeId], resolvedLayerId)
  const frame = measureResult.frames[selectedNodeId]
  if (!frame) {
    return fail(setMutationError, 'Could not measure the selected node in the preview.')
  }

  return mutateSelectedLayout({
    mutate: (layout, sid) => moveNodeIntoFreeformLayer(layout, sid, resolvedLayerId, frame),
    nextSelectedNodeId: () => selectedNodeId,
    undoReason: 'move to freeform',
  })
}

/**
 * Convert the currently selected flow container (group/row/column) into a
 * freeformLayer in place. Measures all direct children for their frames.
 * Fails if any direct child is a nested container.
 */
export function convertSelectedContainerToFreeform() {
  const store = usePluginUIDesignerStore.getState()
  const { workingLayout, selectedNodeId, setMutationError } = store

  if (!selectedNodeId) {
    return fail(setMutationError, 'Select a row, group, or column to convert to Freeform.')
  }

  const selectedNode = findNode(workingLayout, selectedNodeId)
  if (!selectedNode) {
    return fail(setMutationError, 'Select a row, group, or column to convert to Freeform.')
  }

  const FLOW_CONTAINER_TYPES = new Set(['group', 'row', 'column'])
  if (!FLOW_CONTAINER_TYPES.has(selectedNode.type)) {
    return fail(setMutationError, 'Select a row, group, or column to convert to Freeform.')
  }

  // Collect all eligible leaf descendants (flattens nested flow containers).
  let leafIds
  try {
    leafIds = collectEligibleLeafDescendantIds(workingLayout, selectedNodeId)
  } catch (err) {
    return fail(setMutationError, err.message)
  }

  if (leafIds.size === 0) {
    return fail(setMutationError, 'Cannot convert: this container has no eligible controls to place.')
  }

  if (!_previewHostEl) {
    return fail(setMutationError, 'Could not measure the selected node in the preview.')
  }

  // Measure the container rect.
  const containerResult = getNodeRectInPreview(_previewHostEl, selectedNodeId)
  if (!containerResult.ok) {
    return fail(setMutationError, 'Could not measure the selected node in the preview.')
  }

  // Measure each leaf descendant relative to the container.
  const measuredFrames = {
    __container__: {
      widthPx:  Math.round(containerResult.rect.width)  || 480,
      heightPx: Math.round(containerResult.rect.height) || 160,
    },
  }
  for (const leafId of leafIds) {
    const leafResult = getNodeRectInPreview(_previewHostEl, leafId)
    measuredFrames[leafId] = leafResult.ok
      ? buildFrameFromRects(leafResult.rect, containerResult.rect)
      : { x: 0, y: 0, widthPx: 80, heightPx: 40 }
  }

  const newLayerId = nextId(workingLayout, 'freeform-layer')

  return mutateSelectedLayout({
    mutate: (layout, sid) =>
      convertContainerToFreeformLayer(layout, sid, measuredFrames, { layerId: newLayerId }),
    nextSelectedNodeId: () => newLayerId,
    expandNodeId: () => newLayerId,
    undoReason: 'convert to freeform',
  })
}

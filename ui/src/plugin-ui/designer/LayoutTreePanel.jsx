import React from 'react'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import {
  duplicateSelectedNode,
  moveSelectedNodeDown,
  moveSelectedNodeUp,
  removeSelectedNode,
} from './designerActions.js'
import {
  formatValidationError,
  getErrorsForNode,
  getValidationSeverity,
  isSoftBlockingError,
} from './validationStatus.js'

const CONTAINER_TYPES = new Set(['panel', 'group', 'row', 'column', 'tabGroup', 'freeformLayer'])

// Phase C: read-only tree with selection + expand/collapse.
// Mutations (add / remove / reorder / drag-drop) land in Phase E.
//
// LayoutTreeContent is a pure-prop component — useful for testing without
// going through the Zustand hook. The default export wires it to the store.

export function LayoutTreeContent({
  layout,
  selectedNodeId,
  expandedNodeIds,
  validationResult = { ok: true, errors: [] },
  onSelect,
  onToggleExpanded,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
}) {
  if (!layout?.root) {
    return <div className="pluginui-designer-tree-empty">(layout not loaded)</div>
  }
  return (
    <div className="pluginui-designer-tree" role="tree">
      <TreeNode
        node={layout.root}
        depth={0}
        selectedNodeId={selectedNodeId}
        expandedNodeIds={expandedNodeIds}
        validationResult={validationResult}
        onSelect={onSelect}
        onToggleExpanded={onToggleExpanded}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        siblingIndex={-1}
        siblingCount={1}
      />
    </div>
  )
}

export default function LayoutTreePanel() {
  const workingLayout       = usePluginUIDesignerStore(s => s.workingLayout)
  const expandedNodeIds     = usePluginUIDesignerStore(s => s.expandedNodeIds)
  const selectedNodeId      = usePluginUIDesignerStore(s => s.selectedNodeId)
  const validationResult    = usePluginUIDesignerStore(s => s.validationResult)
  const setSelectedNodeId   = usePluginUIDesignerStore(s => s.setSelectedNodeId)
  const toggleNodeExpanded  = usePluginUIDesignerStore(s => s.toggleNodeExpanded)

  return (
    <LayoutTreeContent
      layout={workingLayout}
      selectedNodeId={selectedNodeId}
      expandedNodeIds={expandedNodeIds}
      validationResult={validationResult}
      onSelect={setSelectedNodeId}
      onToggleExpanded={toggleNodeExpanded}
      onDuplicate={duplicateSelectedNode}
      onRemove={removeSelectedNode}
      onMoveUp={moveSelectedNodeUp}
      onMoveDown={moveSelectedNodeDown}
    />
  )
}

function TreeNode({
  node,
  depth,
  selectedNodeId,
  expandedNodeIds,
  validationResult,
  onSelect,
  onToggleExpanded,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
  siblingIndex,
  siblingCount,
}) {
  if (!node) return null

  const isContainer = CONTAINER_TYPES.has(node.type) && Array.isArray(node.children) && node.children.length > 0
  const isExpanded  = expandedNodeIds?.has?.(node.id) ?? false
  const isSelected  = selectedNodeId === node.id
  const badgeInfo   = getNodeBadgeInfo(node, validationResult)
  const isInvalid   = !!badgeInfo
  const isRoot      = depth === 0
  const canMoveUp   = !isRoot && siblingIndex > 0
  const canMoveDown = !isRoot && siblingIndex < siblingCount - 1

  const labelText = pickLabelText(node)

  const rowCls = [
    'pluginui-designer-tree-row',
    isSelected && 'pluginui-designer-tree-row--selected',
    isInvalid  && 'pluginui-designer-tree-row--invalid',
  ].filter(Boolean).join(' ')

  return (
    <div role="treeitem" aria-selected={isSelected} aria-expanded={isContainer ? isExpanded : undefined}>
      <div
        className={rowCls}
        onClick={(e) => {
          e.stopPropagation()
          onSelect?.(node.id)
        }}
        title={badgeInfo?.title || node.id}
      >
        {isContainer ? (
          <button
            type="button"
            className="pluginui-designer-tree-toggle"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpanded?.(node.id)
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="pluginui-designer-tree-toggle pluginui-designer-tree-toggle--placeholder" aria-hidden="true">·</span>
        )}
        <span className="pluginui-designer-tree-type">
          {node.type === 'freeformLayer' && (
            <span className="pluginui-designer-tree-ff-badge" aria-hidden="true">[FF]</span>
          )}{node.type}
        </span>
        <span className="pluginui-designer-tree-id">#{node.id}</span>
        {labelText && (
          <span className="pluginui-designer-tree-label">— {labelText}</span>
        )}
        {pickFrameBadgeText(node) && (
          <span className="pluginui-designer-tree-frame-badge" title="frame x,y">
            {pickFrameBadgeText(node)}
          </span>
        )}
        {badgeInfo && (
          <span
            className={[
              'pluginui-designer-tree-badge',
              `pluginui-designer-tree-badge--${badgeInfo.kind}`,
            ].join(' ')}
            title={badgeInfo.title}
          >
            {badgeInfo.text}
          </span>
        )}
        <span className="pluginui-designer-tree-actions" aria-label={`Actions for ${node.id}`}>
          <TreeActionButton
            label="Duplicate"
            text="Dup"
            disabled={isRoot}
            onClick={() => {
              onSelect?.(node.id)
              onDuplicate?.()
            }}
          />
          <TreeActionButton
            label="Move up"
            text="Up"
            disabled={!canMoveUp}
            onClick={() => {
              onSelect?.(node.id)
              onMoveUp?.()
            }}
          />
          <TreeActionButton
            label="Move down"
            text="Dn"
            disabled={!canMoveDown}
            onClick={() => {
              onSelect?.(node.id)
              onMoveDown?.()
            }}
          />
          <TreeActionButton
            label="Remove"
            text="Del"
            disabled={isRoot}
            danger
            onClick={() => {
              onSelect?.(node.id)
              onRemove?.()
            }}
          />
        </span>
      </div>

      {isContainer && isExpanded && (
        <div className="pluginui-designer-tree-children">
          {node.children.map((child, index) =>
            child && child.id
              ? (
                <TreeNode
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  selectedNodeId={selectedNodeId}
                  expandedNodeIds={expandedNodeIds}
                  validationResult={validationResult}
                  onSelect={onSelect}
                  onToggleExpanded={onToggleExpanded}
                  onDuplicate={onDuplicate}
                  onRemove={onRemove}
                  onMoveUp={onMoveUp}
                  onMoveDown={onMoveDown}
                  siblingIndex={index}
                  siblingCount={node.children.length}
                />
              )
              : null
          )}
        </div>
      )}
    </div>
  )
}

function getNodeBadgeInfo(node, validationResult) {
  const errors = getErrorsForNode(validationResult, node?.id)
  const firstError = errors[0]
  if (firstError) {
    const severity = getValidationSeverity(validationResult, firstError)
    const kind = severity === 'hard'
      ? 'hard'
      : isSoftBlockingError(firstError)
        ? 'soft'
        : 'info'
    return {
      kind,
      text: severity === 'hard' ? 'H' : kind === 'soft' ? '!' : 'i',
      title: `${firstError.code || 'VALIDATION_ERROR'}: ${formatValidationError(firstError)}`,
    }
  }

  if (node?._vizUnavailable) {
    return {
      kind: 'soft',
      text: '!',
      title: 'Visualizer unavailable',
    }
  }

  if (node?._invalid) {
    return {
      kind: 'soft',
      text: '!',
      title: 'Node is marked invalid',
    }
  }

  return null
}

function TreeActionButton({ label, text, disabled, danger, onClick }) {
  return (
    <button
      type="button"
      className={[
        'pluginui-designer-tree-action',
        danger && 'pluginui-designer-tree-action--danger',
      ].filter(Boolean).join(' ')}
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        if (!disabled) onClick?.()
      }}
    >
      {text}
    </button>
  )
}

function pickLabelText(node) {
  const p = node?.props
  if (!p) return null
  if (typeof p.label === 'string' && p.label) return truncate(p.label)
  if (typeof p.text === 'string' && p.text)   return truncate(p.text)
  if (typeof p.title === 'string' && p.title) return truncate(p.title)
  return null
}

function truncate(s, max = 28) {
  if (!s) return s
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function pickFrameBadgeText(node) {
  const frame = node?.props?.frame
  if (!frame || typeof frame !== 'object') return null
  const x = frame.x ?? 0
  const y = frame.y ?? 0
  return `${x},${y}`
}

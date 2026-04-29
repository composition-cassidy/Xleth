import React from 'react'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'

const CONTAINER_TYPES = new Set(['panel', 'group', 'row', 'column', 'tabGroup'])

// Phase C: read-only tree with selection + expand/collapse.
// Mutations (add / remove / reorder / drag-drop) land in Phase E.
//
// LayoutTreeContent is a pure-prop component — useful for testing without
// going through the Zustand hook. The default export wires it to the store.

export function LayoutTreeContent({
  layout,
  selectedNodeId,
  expandedNodeIds,
  onSelect,
  onToggleExpanded,
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
        onSelect={onSelect}
        onToggleExpanded={onToggleExpanded}
      />
    </div>
  )
}

export default function LayoutTreePanel() {
  const workingLayout       = usePluginUIDesignerStore(s => s.workingLayout)
  const expandedNodeIds     = usePluginUIDesignerStore(s => s.expandedNodeIds)
  const selectedNodeId      = usePluginUIDesignerStore(s => s.selectedNodeId)
  const setSelectedNodeId   = usePluginUIDesignerStore(s => s.setSelectedNodeId)
  const toggleNodeExpanded  = usePluginUIDesignerStore(s => s.toggleNodeExpanded)

  return (
    <LayoutTreeContent
      layout={workingLayout}
      selectedNodeId={selectedNodeId}
      expandedNodeIds={expandedNodeIds}
      onSelect={setSelectedNodeId}
      onToggleExpanded={toggleNodeExpanded}
    />
  )
}

function TreeNode({ node, depth, selectedNodeId, expandedNodeIds, onSelect, onToggleExpanded }) {
  if (!node) return null

  const isContainer = CONTAINER_TYPES.has(node.type) && Array.isArray(node.children) && node.children.length > 0
  const isExpanded  = expandedNodeIds?.has?.(node.id) ?? false
  const isSelected  = selectedNodeId === node.id
  const isInvalid   = node._invalid === true || node._vizUnavailable === true

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
        title={node.id}
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
        <span className="pluginui-designer-tree-type">{node.type}</span>
        <span className="pluginui-designer-tree-id">#{node.id}</span>
        {labelText && (
          <span className="pluginui-designer-tree-label">— {labelText}</span>
        )}
        {isInvalid && <span className="pluginui-designer-tree-badge">!</span>}
      </div>

      {isContainer && isExpanded && (
        <div className="pluginui-designer-tree-children">
          {node.children.map(child =>
            child && child.id
              ? (
                <TreeNode
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  selectedNodeId={selectedNodeId}
                  expandedNodeIds={expandedNodeIds}
                  onSelect={onSelect}
                  onToggleExpanded={onToggleExpanded}
                />
              )
              : null
          )}
        </div>
      )}
    </div>
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

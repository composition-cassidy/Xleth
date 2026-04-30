import React from 'react'
import { getParentInfo } from './layoutMutations.js'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import {
  formatValidationError,
  getValidationSeverity,
} from './validationStatus.js'

export default function ValidationPanel() {
  const workingLayout = usePluginUIDesignerStore(s => s.workingLayout)
  const validationResult = usePluginUIDesignerStore(s => s.validationResult)
  const selectedNodeId = usePluginUIDesignerStore(s => s.selectedNodeId)
  const setSelectedNodeId = usePluginUIDesignerStore(s => s.setSelectedNodeId)
  const toggleNodeExpanded = usePluginUIDesignerStore(s => s.toggleNodeExpanded)

  return (
    <ValidationPanelContent
      validationResult={validationResult}
      selectedNodeId={selectedNodeId}
      onSelectNode={nodeId => {
        expandParents(workingLayout, nodeId, toggleNodeExpanded)
        setSelectedNodeId(nodeId)
        // Future Phase G/H nicety: scroll the matching inspector field into view.
      }}
    />
  )
}

export function ValidationPanelContent({
  validationResult = { ok: true, errors: [] },
  selectedNodeId = null,
  onSelectNode,
}) {
  const rows = buildValidationRows(validationResult)

  if (rows.length === 0) {
    return (
      <div className="pluginui-designer-validation-panel">
        <div className="pluginui-designer-validation-empty pluginui-designer-validation-empty--valid">
          Layout valid
        </div>
      </div>
    )
  }

  return (
    <div className="pluginui-designer-validation-panel" role="list" aria-label="Layout validation issues">
      {rows.map(row => (
        <button
          type="button"
          key={row.key}
          role="listitem"
          className={[
            'pluginui-designer-validation-row',
            `pluginui-designer-validation-row--${row.severity}`,
            selectedNodeId && row.nodeId === selectedNodeId && 'pluginui-designer-validation-row--selected',
          ].filter(Boolean).join(' ')}
          disabled={!row.nodeId}
          title={row.title}
          onClick={() => {
            selectValidationRow(row, onSelectNode)
          }}
        >
          <span className="pluginui-designer-validation-severity">{row.severity}</span>
          <span className="pluginui-designer-validation-code">{row.code}</span>
          <span className="pluginui-designer-validation-node">{row.nodeId || 'global'}</span>
          <span className="pluginui-designer-validation-message">{row.message}</span>
        </button>
      ))}
    </div>
  )
}

export function selectValidationRow(row, onSelectNode) {
  if (row?.nodeId) onSelectNode?.(row.nodeId)
}

export function buildValidationRows(validationResult = { ok: true, errors: [] }) {
  return (validationResult?.errors || []).map((error, index) => {
    const severity = getValidationSeverity(validationResult, error)
    const code = error?.code || 'VALIDATION_ERROR'
    const nodeId = error?.nodeId || null
    const message = formatValidationError(error)

    return {
      key: `${code}-${nodeId || 'global'}-${index}`,
      severity,
      code,
      nodeId,
      message,
      title: `${severity.toUpperCase()} ${code}: ${message}`,
      error,
    }
  })
}

function expandParents(layout, nodeId, toggleNodeExpanded) {
  if (!layout?.root || !nodeId || typeof toggleNodeExpanded !== 'function') return

  let currentId = nodeId
  for (let guard = 0; guard < 64; guard += 1) {
    const info = getParentInfo(layout, currentId)
    const parentId = info?.parent?.id
    if (!parentId) return
    toggleNodeExpanded(parentId, true)
    currentId = parentId
  }
}

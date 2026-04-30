import React, { useState } from 'react'
import { findNode, collectNodeIds, isFreeformEligibleLeaf, isFreeformLayer } from './layoutMutations.js'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import {
  renameSelectedNode,
  patchSelectedProps,
  patchSelectedStyle,
  getFreeformLayerOptions,
  moveSelectedNodeToFreeform,
  convertSelectedContainerToFreeform,
} from './designerActions.js'
import CommonFields from './inspectors/CommonFields.jsx'
import StyleFields from './inspectors/StyleFields.jsx'
import KnobInspector from './inspectors/KnobInspector.jsx'
import ToggleInspector from './inspectors/ToggleInspector.jsx'
import MeterInspector from './inspectors/MeterInspector.jsx'
import VisualizerInspector from './inspectors/VisualizerInspector.jsx'
import LabelInspector from './inspectors/LabelInspector.jsx'
import SpacerInspector from './inspectors/SpacerInspector.jsx'
import ContainerInspector from './inspectors/ContainerInspector.jsx'
import FreeformLayerInspector from './inspectors/FreeformLayerInspector.jsx'
import DecorTextInspector from './inspectors/DecorTextInspector.jsx'
import DecorLineInspector from './inspectors/DecorLineInspector.jsx'
import DecorShapeInspector from './inspectors/DecorShapeInspector.jsx'
import DecalInspector from './inspectors/DecalInspector.jsx'
import {
  formatValidationError,
  getErrorsForNode,
  getValidationSeverity,
} from './validationStatus.js'

export default function InspectorPanel() {
  const workingLayout = usePluginUIDesignerStore(s => s.workingLayout)
  const selectedNodeId = usePluginUIDesignerStore(s => s.selectedNodeId)
  const manifest = usePluginUIDesignerStore(s => s.manifest)
  const validationResult = usePluginUIDesignerStore(s => s.validationResult)
  const mutationError = usePluginUIDesignerStore(s => s.mutationError)

  const selectedNode = selectedNodeId ? findNode(workingLayout, selectedNodeId) : null
  const allNodeIds = collectNodeIds(workingLayout)
  const selectedErrors = selectedNode
    ? getErrorsForNode(validationResult, selectedNode.id)
    : []
  const freeformLayerOptions = getFreeformLayerOptions(workingLayout)

  return (
    <InspectorContent
      node={selectedNode}
      allNodeIds={allNodeIds}
      validationErrors={selectedErrors}
      validationResult={validationResult}
      mutationError={mutationError}
      manifest={manifest}
      freeformLayerOptions={freeformLayerOptions}
      onRename={renameSelectedNode}
      onPatchProps={patchSelectedProps}
      onPatchStyle={patchSelectedStyle}
    />
  )
}

export function InspectorContent({
  node,
  allNodeIds = new Set(),
  validationErrors = [],
  validationResult = { ok: true, errors: [] },
  mutationError = null,
  manifest = null,
  freeformLayerOptions = [],
  onRename,
  onPatchProps,
  onPatchStyle,
}) {
  if (!node) {
    return <div className="pluginui-designer-inspector-empty">(no selection)</div>
  }

  const hasNodeWarning = node._invalid === true || node._vizUnavailable === true

  return (
    <div className="pluginui-designer-inspector">
      <CommonFields
        node={node}
        allNodeIds={allNodeIds}
        onRename={onRename}
      />

      <StyleFields
        style={node.style || {}}
        onPatchStyle={onPatchStyle}
      />

      <TypeInspector
        node={node}
        manifest={manifest}
        onPatchProps={onPatchProps}
        onPatchStyle={onPatchStyle}
        validationErrors={validationErrors}
      />

      <FreeformTools node={node} freeformLayerOptions={freeformLayerOptions} />

      {(mutationError || hasNodeWarning || validationErrors.length > 0) && (
        <div className="pluginui-designer-inspector-errors" role="status">
          {mutationError && (
            <div className="pluginui-designer-error-text">{mutationError}</div>
          )}
          {hasNodeWarning && (
            <div className="pluginui-designer-warning-text">
              This node is marked by validation.
            </div>
          )}
          {validationErrors.length > 0 && (
            <div className="pluginui-designer-selected-errors">
              {validationErrors.map((error, index) => {
                const severity = getValidationSeverity(validationResult, error)
                return (
                  <div
                    className={[
                      'pluginui-designer-selected-error-row',
                      `pluginui-designer-selected-error-row--${severity}`,
                    ].join(' ')}
                    key={`${error.code || 'error'}-${index}`}
                  >
                    <span className="pluginui-designer-selected-error-severity">{severity}</span>
                    <span className="pluginui-designer-selected-error-code">{error.code || 'VALIDATION_ERROR'}</span>
                    <span className="pluginui-designer-selected-error-message">{formatValidationError(error)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Freeform-C.5: move/convert tools ─────────────────────────────────────────

const FLOW_CONTAINER_TYPES = new Set(['group', 'row', 'column'])

function FreeformTools({ node, freeformLayerOptions }) {
  const [targetLayerId, setTargetLayerId] = useState('')

  if (!node) return null

  const isEligibleLeaf      = isFreeformEligibleLeaf(node)
  const isFlowContainer     = FLOW_CONTAINER_TYPES.has(node.type)
  const isAlreadyFreeform   = isFreeformLayer(node?.parent) ||
                              node?.props?.frame != null
  const hasNoLayers         = freeformLayerOptions.length === 0
  const hasMultipleLayers   = freeformLayerOptions.length > 1
  const resolvedTarget      = hasMultipleLayers
    ? (targetLayerId || freeformLayerOptions[0]?.id)
    : freeformLayerOptions[0]?.id

  // Only show the section when the node is relevant.
  if (!isEligibleLeaf && !isFlowContainer) return null

  return (
    <div className="pluginui-designer-inspector-group pluginui-designer-freeform-tools">
      <div className="pluginui-designer-inspector-group-title">Freeform</div>

      {isEligibleLeaf && (
        <>
          {node.props?.frame != null ? (
            <div className="pluginui-designer-freeform-tools-hint">Already in freeform layer</div>
          ) : hasNoLayers ? (
            <div className="pluginui-designer-freeform-tools-hint">Add a Freeform Layer first.</div>
          ) : (
            <>
              {hasMultipleLayers && (
                <div className="pluginui-designer-field">
                  <label className="pluginui-designer-field-label">Target layer</label>
                  <select
                    className="pluginui-designer-select"
                    value={targetLayerId || freeformLayerOptions[0]?.id}
                    onChange={e => setTargetLayerId(e.target.value)}
                  >
                    {freeformLayerOptions.map(opt => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <button
                className="pluginui-designer-button pluginui-designer-freeform-tools-btn"
                onClick={() => moveSelectedNodeToFreeform(resolvedTarget)}
                title="Move this control into the freeform layer"
              >
                → Move into Freeform
              </button>
            </>
          )}
        </>
      )}

      {isFlowContainer && (
        <>
          {hasNoLayers ? (
            <button
              className="pluginui-designer-button pluginui-designer-freeform-tools-btn"
              onClick={convertSelectedContainerToFreeform}
              title="Replace this container with a freeformLayer (same position)"
            >
              Convert to Freeform Layer
            </button>
          ) : (
            <button
              className="pluginui-designer-button pluginui-designer-freeform-tools-btn"
              onClick={convertSelectedContainerToFreeform}
              title="Replace this container with a freeformLayer (same position)"
            >
              Convert to Freeform Layer
            </button>
          )}
        </>
      )}
    </div>
  )
}

function TypeInspector({ node, manifest, onPatchProps, onPatchStyle, validationErrors }) {
  if (!node) return null

  switch (node.type) {
    case 'knob':
      return <KnobInspector node={node} manifest={manifest} onPatchProps={onPatchProps} validationErrors={validationErrors} />
    case 'toggle':
      return <ToggleInspector node={node} manifest={manifest} onPatchProps={onPatchProps} />
    case 'meter':
      return <MeterInspector node={node} manifest={manifest} onPatchProps={onPatchProps} />
    case 'visualizer':
      return <VisualizerInspector node={node} manifest={manifest} onPatchProps={onPatchProps} />
    case 'label':
      return <LabelInspector node={node} onPatchProps={onPatchProps} />
    case 'spacer':
      return <SpacerInspector />
    case 'panel':
    case 'group':
    case 'row':
    case 'column':
      return <ContainerInspector node={node} onPatchProps={onPatchProps} />
    case 'freeformLayer':
      return <FreeformLayerInspector node={node} onPatchProps={onPatchProps} onPatchStyle={onPatchStyle} />
    case 'decorText':
      return <DecorTextInspector node={node} onPatchProps={onPatchProps} />
    case 'decorLine':
      return <DecorLineInspector node={node} onPatchProps={onPatchProps} />
    case 'decorShape':
      return <DecorShapeInspector node={node} onPatchProps={onPatchProps} />
    case 'decal':
      return <DecalInspector node={node} onPatchProps={onPatchProps} />
    default:
      return (
        <div className="pluginui-designer-inspector-group">
          <div className="pluginui-designer-inspector-group-title">Type Fields</div>
          <div className="pluginui-designer-inspector-note">
            No type-specific editing is available for {node.type}.
          </div>
        </div>
      )
  }
}

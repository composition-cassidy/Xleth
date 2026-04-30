import React, { useState } from 'react'
import BindingPicker from '../BindingPicker.jsx'
import {
  buildVisualizerPatchForSource,
  getPresetOptionsForSource,
  isPresetAllowedForSource,
} from './inspectorHelpers.js'
import { FieldError, InspectorGroup, NumberField, SelectField } from './FieldControls.jsx'

export default function VisualizerInspector({ node, manifest, onPatchProps }) {
  const props = node.props || {}
  const [error, setError] = useState(null)
  const presetOptions = getPresetOptionsForSource(props.source, props.preset)
  const vizSources = Array.isArray(manifest?.vizSources) ? manifest.vizSources : []
  const hasVisualizerSources = vizSources.length > 0
  const sourceUnknown = hasVisualizerSources && !vizSources.includes(props.source)

  return (
    <InspectorGroup title="Visualizer">
      <label className="pluginui-designer-field pluginui-designer-binding-row">
        <span className="pluginui-designer-field-label">source</span>
        <BindingPicker
          kind="vizSource"
          value={props.source}
          manifest={manifest}
          includeUnset
          onChange={source => {
            const patch = buildVisualizerPatchForSource(props, source, manifest)
            if (!patch) {
              setError('Unknown visualizer source')
              return
            }
            setError(null)
            onPatchProps?.(patch)
          }}
        />
      </label>

      <SelectField
        label="preset"
        value={props.preset}
        options={presetOptions}
        onChange={preset => {
          if (!isPresetAllowedForSource(preset, props.source)) {
            setError('Preset is not valid for this source')
            return
          }
          setError(null)
          onPatchProps?.({ preset })
        }}
      />

      <NumberField
        label="heightPx"
        value={props.heightPx ?? 110}
        min={40}
        max={300}
        onInvalid={setError}
        onChange={heightPx => onPatchProps?.({ heightPx })}
      />

      {!hasVisualizerSources && (
        <FieldError message="This plugin has no visualizer sources. Remove this node or add a source in the manifest." />
      )}
      {sourceUnknown && (
        <FieldError message="Unknown visualizer source. Choose a source from this plugin." />
      )}
      {props.preset && !isPresetAllowedForSource(props.preset, props.source) && (
        <FieldError message="Unknown or incompatible preset. Choose a preset." />
      )}
      <FieldError message={error} />
    </InspectorGroup>
  )
}

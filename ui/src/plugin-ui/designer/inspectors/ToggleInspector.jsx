import React, { useState } from 'react'
import BindingPicker from '../BindingPicker.jsx'
import { buildTogglePatchForParam } from './inspectorHelpers.js'
import { FieldError, InspectorGroup, NumberField, SelectField, TextField } from './FieldControls.jsx'

const MODE_OPTIONS = [
  { value: 'boolParam', label: 'boolParam' },
  { value: 'discreteValue', label: 'discreteValue' },
]

export default function ToggleInspector({ node, manifest, onPatchProps }) {
  const props = node.props || {}
  const [error, setError] = useState(null)
  const mode = props.mode || 'discreteValue'

  return (
    <InspectorGroup title="Toggle">
      <label className="pluginui-designer-field pluginui-designer-binding-row">
        <span className="pluginui-designer-field-label">param</span>
        <BindingPicker
          kind="param"
          value={props.param}
          manifest={manifest}
          includeUnset
          onChange={paramId => {
            const patch = buildTogglePatchForParam(props, paramId, manifest)
            if (!patch) {
              setError('Unknown param')
              return
            }
            setError(null)
            onPatchProps?.(patch)
          }}
        />
      </label>

      <SelectField
        label="mode"
        value={mode}
        options={MODE_OPTIONS}
        onChange={nextMode => {
          if (nextMode === 'boolParam') {
            onPatchProps?.({ mode: nextMode, valueWhenOn: undefined })
          } else {
            onPatchProps?.({ mode: nextMode, valueWhenOn: typeof props.valueWhenOn === 'number' ? props.valueWhenOn : 1 })
          }
        }}
      />

      {mode === 'discreteValue' && (
        <NumberField
          label="valueWhenOn"
          value={props.valueWhenOn ?? 1}
          onInvalid={setError}
          onChange={valueWhenOn => onPatchProps?.({ valueWhenOn })}
        />
      )}

      <TextField label="label" value={props.label ?? ''} onChange={label => onPatchProps?.({ label })} />

      {!manifest?.params?.[props.param] && (
        <FieldError message="Unknown param. Choose a parameter from this plugin." />
      )}
      <FieldError message={error} />
    </InspectorGroup>
  )
}

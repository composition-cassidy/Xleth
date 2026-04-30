import React, { useState } from 'react'
import { FieldError, InspectorGroup, NumberField, SelectField, TextField } from './FieldControls.jsx'

const ROW_VARIANT_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'borderTop', label: 'borderTop' },
  { value: 'borderBottom', label: 'borderBottom' },
]

export default function ContainerInspector({ node, onPatchProps }) {
  const props = node.props || {}
  const [error, setError] = useState(null)

  if (node.type === 'group') {
    return (
      <InspectorGroup title="Group">
        <TextField label="title" value={props.title ?? ''} onChange={title => onPatchProps?.({ title: title || undefined })} />
        <NumberField
          label="columns"
          value={props.columns ?? ''}
          min={1}
          max={6}
          step={1}
          onInvalid={setError}
          onChange={columns => onPatchProps?.({ columns: Math.round(columns) })}
        />
        <FieldError message={error} />
      </InspectorGroup>
    )
  }

  if (node.type === 'row') {
    return (
      <InspectorGroup title="Row">
        <SelectField label="variant" value={props.variant || ''} options={ROW_VARIANT_OPTIONS} onChange={variant => onPatchProps?.({ variant })} />
      </InspectorGroup>
    )
  }

  const title = node.type === 'panel' ? 'Panel' : 'Column'
  return (
    <InspectorGroup title={title}>
      <div className="pluginui-designer-inspector-note">
        No type-specific props are supported for this container.
      </div>
    </InspectorGroup>
  )
}

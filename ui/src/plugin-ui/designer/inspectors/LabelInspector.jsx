import React from 'react'
import { InspectorGroup, SelectField, TextField } from './FieldControls.jsx'

const VARIANT_OPTIONS = [
  { value: '', label: '(default)' },
  { value: 'muted', label: 'muted' },
  { value: 'header', label: 'header' },
]

export default function LabelInspector({ node, onPatchProps }) {
  const props = node.props || {}

  return (
    <InspectorGroup title="Label">
      <TextField label="text" value={props.text ?? ''} maxLength={80} onChange={text => onPatchProps?.({ text: text.slice(0, 80) })} />
      <SelectField label="variant" value={props.variant || ''} options={VARIANT_OPTIONS} onChange={variant => onPatchProps?.({ variant })} />
    </InspectorGroup>
  )
}

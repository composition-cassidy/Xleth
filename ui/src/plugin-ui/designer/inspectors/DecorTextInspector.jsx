import React from 'react'
import { getTokenOptionsForGroup } from '../../appearance/tokenSlots.js'
import { InspectorGroup, SelectField, TextField } from './FieldControls.jsx'
import FrameFields from './FrameFields.jsx'

const VARIANT_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'muted',   label: 'Muted' },
  { value: 'header',  label: 'Header' },
  { value: 'caption', label: 'Caption' },
  { value: 'value',   label: 'Value' },
]

const ALIGN_OPTIONS = [
  { value: 'left',   label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right',  label: 'Right' },
]

const LETTER_SPACING_OPTIONS = [
  { value: 'tight',  label: 'Tight' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide',   label: 'Wide' },
  { value: 'wider',  label: 'Wider' },
]

function buildTextTokenOptions() {
  return getTokenOptionsForGroup('text').map(o => ({ value: o.value, label: o.label }))
}

export default function DecorTextInspector({ node, onPatchProps }) {
  const props = node.props || {}
  const frame = props.frame || {}
  const textTokenOptions = buildTextTokenOptions()

  const patchFrame = (newFrame) => onPatchProps?.({ frame: newFrame })

  return (
    <>
      <FrameFields frame={frame} onPatchFrame={patchFrame} />

      <InspectorGroup title="Text">
        <TextField
          label="text"
          value={props.text ?? ''}
          maxLength={80}
          onChange={text => onPatchProps?.({ text })}
        />

        <SelectField
          label="variant"
          value={props.variant || 'default'}
          options={VARIANT_OPTIONS}
          onChange={variant => onPatchProps?.({ variant })}
        />

        <SelectField
          label="textToken"
          value={props.textToken || ''}
          options={textTokenOptions}
          onChange={textToken => onPatchProps?.({ textToken })}
        />

        <SelectField
          label="align"
          value={props.align || 'left'}
          options={ALIGN_OPTIONS}
          onChange={align => onPatchProps?.({ align })}
        />

        <SelectField
          label="letterSpacing"
          value={props.letterSpacing || 'normal'}
          options={LETTER_SPACING_OPTIONS}
          onChange={letterSpacing => onPatchProps?.({ letterSpacing })}
        />
      </InspectorGroup>
    </>
  )
}

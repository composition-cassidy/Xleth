import React from 'react'
import { getTokenOptionsForGroup } from '../../appearance/tokenSlots.js'
import { InspectorGroup, SelectField } from './FieldControls.jsx'
import FrameFields from './FrameFields.jsx'

const ORIENTATION_OPTIONS = [
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical',   label: 'Vertical' },
]

const THICKNESS_OPTIONS = [
  { value: 'hair',   label: 'Hair (1 px)' },
  { value: 'thin',   label: 'Thin (2 px)' },
  { value: 'medium', label: 'Medium (3 px)' },
  { value: 'thick',  label: 'Thick (4 px)' },
]

const LINE_STYLE_OPTIONS = [
  { value: 'solid',  label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
]

function buildStrokeTokenOptions() {
  return [
    ...getTokenOptionsForGroup('accent').map(o => ({ value: o.value, label: o.label })),
    ...getTokenOptionsForGroup('text').map(o  => ({ value: o.value, label: o.label })),
    ...getTokenOptionsForGroup('meter').map(o => ({ value: o.value, label: o.label })),
  ]
}

export default function DecorLineInspector({ node, onPatchProps }) {
  const props = node.props || {}
  const frame = props.frame || {}
  const strokeTokenOptions = buildStrokeTokenOptions()

  const patchFrame = (newFrame) => onPatchProps?.({ frame: newFrame })

  return (
    <>
      <FrameFields frame={frame} onPatchFrame={patchFrame} />

      <InspectorGroup title="Line">
        <SelectField
          label="orientation"
          value={props.orientation || 'horizontal'}
          options={ORIENTATION_OPTIONS}
          onChange={orientation => onPatchProps?.({ orientation })}
        />

        <SelectField
          label="thickness"
          value={props.thickness || 'hair'}
          options={THICKNESS_OPTIONS}
          onChange={thickness => onPatchProps?.({ thickness })}
        />

        <SelectField
          label="lineStyle"
          value={props.lineStyle || 'solid'}
          options={LINE_STYLE_OPTIONS}
          onChange={lineStyle => onPatchProps?.({ lineStyle })}
        />

        <SelectField
          label="strokeToken"
          value={props.strokeToken || ''}
          options={strokeTokenOptions}
          onChange={strokeToken => onPatchProps?.({ strokeToken })}
        />
      </InspectorGroup>
    </>
  )
}

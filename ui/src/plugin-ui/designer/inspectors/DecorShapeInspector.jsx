import React from 'react'
import { getTokenOptionsForGroup } from '../../appearance/tokenSlots.js'
import { InspectorGroup, SelectField } from './FieldControls.jsx'
import FrameFields from './FrameFields.jsx'

const SHAPE_OPTIONS = [
  { value: 'rect',        label: 'Rectangle' },
  { value: 'roundedRect', label: 'Rounded Rect' },
  { value: 'circle',      label: 'Circle' },
  { value: 'pill',        label: 'Pill' },
]

const CORNER_RADIUS_OPTIONS = [
  { value: '0',  label: '0' },
  { value: '2',  label: '2' },
  { value: '4',  label: '4' },
  { value: '8',  label: '8' },
  { value: '12', label: '12' },
  { value: '16', label: '16' },
]

const STROKE_WIDTH_OPTIONS = [
  { value: '0', label: '0 (none)' },
  { value: '1', label: '1 px' },
  { value: '2', label: '2 px' },
  { value: '3', label: '3 px' },
  { value: '4', label: '4 px' },
]

const OPACITY_OPTIONS = [
  { value: '25',  label: '25%' },
  { value: '50',  label: '50%' },
  { value: '75',  label: '75%' },
  { value: '100', label: '100%' },
]

function buildFillTokenOptions() {
  return [
    ...getTokenOptionsForGroup('surface').map(o => ({ value: o.value, label: o.label })),
    ...getTokenOptionsForGroup('accent').map(o  => ({ value: o.value, label: o.label })),
    { value: 'fill.none', label: 'No Fill' },
  ]
}

function buildStrokeTokenOptions() {
  return [
    ...getTokenOptionsForGroup('accent').map(o => ({ value: o.value, label: o.label })),
    ...getTokenOptionsForGroup('text').map(o  => ({ value: o.value, label: o.label })),
    ...getTokenOptionsForGroup('meter').map(o => ({ value: o.value, label: o.label })),
    { value: 'stroke.none', label: 'No Stroke' },
  ]
}

export default function DecorShapeInspector({ node, onPatchProps }) {
  const props = node.props || {}
  const frame = props.frame || {}
  const fillTokenOptions   = buildFillTokenOptions()
  const strokeTokenOptions = buildStrokeTokenOptions()
  const currentShape = props.shape || 'rect'

  const patchFrame = (newFrame) => onPatchProps?.({ frame: newFrame })

  return (
    <>
      <FrameFields frame={frame} onPatchFrame={patchFrame} />

      <InspectorGroup title="Shape">
        <SelectField
          label="shape"
          value={currentShape}
          options={SHAPE_OPTIONS}
          onChange={shape => onPatchProps?.({ shape })}
        />

        {currentShape === 'roundedRect' && (
          <SelectField
            label="cornerRadius"
            value={String(props.cornerRadius ?? 4)}
            options={CORNER_RADIUS_OPTIONS}
            onChange={v => onPatchProps?.({ cornerRadius: parseInt(v, 10) })}
          />
        )}

        <SelectField
          label="fillToken"
          value={props.fillToken || 'fill.none'}
          options={fillTokenOptions}
          onChange={fillToken => onPatchProps?.({ fillToken })}
        />

        <SelectField
          label="strokeToken"
          value={props.strokeToken || 'stroke.none'}
          options={strokeTokenOptions}
          onChange={strokeToken => onPatchProps?.({ strokeToken })}
        />

        <SelectField
          label="strokeWidth"
          value={String(props.strokeWidth ?? 0)}
          options={STROKE_WIDTH_OPTIONS}
          onChange={v => onPatchProps?.({ strokeWidth: parseInt(v, 10) })}
        />

        <SelectField
          label="opacity"
          value={String(props.opacity ?? 100)}
          options={OPACITY_OPTIONS}
          onChange={v => onPatchProps?.({ opacity: parseInt(v, 10) })}
        />
      </InspectorGroup>
    </>
  )
}

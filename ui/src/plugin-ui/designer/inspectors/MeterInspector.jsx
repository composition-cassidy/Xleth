import React, { useState } from 'react'
import { FORMATS } from '../../runtime/formats.js'
import BindingPicker from '../BindingPicker.jsx'
import { buildMeterPatchForSlot, isMeterRangeValid } from './inspectorHelpers.js'
import { FieldError, InspectorGroup, NumberField, SelectField, TextField } from './FieldControls.jsx'

const SCALE_OPTIONS = [
  { value: 'linear', label: 'linear' },
  { value: 'log', label: 'log' },
]

const ORIENTATION_OPTIONS = [
  { value: 'vertical', label: 'vertical' },
  { value: 'horizontal', label: 'horizontal' },
]

export default function MeterInspector({ node, manifest, onPatchProps }) {
  const props = node.props || {}
  const range = props.range || { min: 0, max: 1, scale: 'linear' }
  const [error, setError] = useState(null)
  const formatOptions = Object.keys(FORMATS).map(key => ({ value: key, label: key }))

  const patchRange = patch => {
    const nextRange = { ...range, ...patch }
    if (!isMeterRangeValid(nextRange)) {
      setError('range.min must be less than range.max')
      return
    }
    setError(null)
    onPatchProps?.({ range: nextRange })
  }

  return (
    <InspectorGroup title="Meter">
      <TextField label="source.kind" value="effectMeter" readOnly />
      <label className="pluginui-designer-field pluginui-designer-binding-row">
        <span className="pluginui-designer-field-label">slot</span>
        <BindingPicker
          kind="meterSlot"
          value={props.source?.slot}
          manifest={manifest}
          includeUnset
          onChange={slot => {
            const patch = buildMeterPatchForSlot(props, slot)
            if (!patch) {
              setError('Unknown meter slot')
              return
            }
            setError(null)
            onPatchProps?.(patch)
          }}
        />
      </label>

      <TextField label="label" value={props.label ?? ''} onChange={label => onPatchProps?.({ label })} />
      <TextField label="unit" value={props.unit ?? ''} onChange={unit => onPatchProps?.({ unit })} />
      <NumberField label="range.min" value={range.min} onInvalid={setError} onChange={min => patchRange({ min })} />
      <NumberField label="range.max" value={range.max} onInvalid={setError} onChange={max => patchRange({ max })} />
      <SelectField label="range.scale" value={range.scale || 'linear'} options={SCALE_OPTIONS} onChange={scale => patchRange({ scale })} />
      <SelectField label="orientation" value={props.orientation || 'vertical'} options={ORIENTATION_OPTIONS} onChange={orientation => onPatchProps?.({ orientation })} />
      <SelectField label="format" value={props.format || 'raw'} options={formatOptions} onChange={format => onPatchProps?.({ format })} />

      {props.source?.kind && props.source.kind !== 'effectMeter' && (
        <FieldError message="Meter source kind must be effectMeter." />
      )}
      {!manifest?.meterSlots?.includes(props.source?.slot) && (
        <FieldError message="Unknown meter slot. Choose a semantic slot." />
      )}
      {range.scale && !SCALE_OPTIONS.some(option => option.value === range.scale) && (
        <FieldError message="range.scale must be linear or log." />
      )}
      {props.orientation && !ORIENTATION_OPTIONS.some(option => option.value === props.orientation) && (
        <FieldError message="orientation must be vertical or horizontal." />
      )}
      <FieldError message={error} />
    </InspectorGroup>
  )
}

import React, { useState } from 'react'
import { FORMATS } from '../../runtime/formats.js'
import BindingPicker from '../BindingPicker.jsx'
import {
  buildKnobPatchForParam,
  buildPresetPatch,
  patchAppearance,
} from './inspectorHelpers.js'
import { FieldError, InspectorGroup, NumberField, SelectField, TextField } from './FieldControls.jsx'
import AppearanceFields from './AppearanceFields.jsx'

export default function KnobInspector({ node, manifest, onPatchProps, validationErrors = [] }) {
  const props = node.props || {}
  const [error, setError] = useState(null)
  const formatOptions = Object.keys(FORMATS).map(key => ({ value: key, label: key }))

  const handlePatchAppearance = (appearancePatch) => {
    const next = patchAppearance(props.appearance, appearancePatch)
    onPatchProps?.({ appearance: next == null ? undefined : next })
  }

  const handleApplyPresetDefaults = (presetId) => {
    const patch = buildPresetPatch(presetId, 'apply-defaults')
    if (!patch) return
    onPatchProps?.({ appearance: patch })
  }

  const handleReplaceAppearance = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return
    onPatchProps?.({ appearance: { ...snapshot } })
  }

  return (
    <>
      <InspectorGroup title="Knob">
        <label className="pluginui-designer-field pluginui-designer-binding-row">
          <span className="pluginui-designer-field-label">param</span>
          <BindingPicker
            kind="param"
            value={props.param}
            manifest={manifest}
            includeUnset
            onChange={paramId => {
              const patch = buildKnobPatchForParam(props, paramId, manifest)
              if (!patch) {
                setError('Unknown param')
                return
              }
              setError(null)
              onPatchProps?.(patch)
            }}
          />
        </label>

        <TextField label="label" value={props.label ?? ''} onChange={label => onPatchProps?.({ label })} />
        <NumberField label="size" value={props.size ?? 52} min={24} max={96} onInvalid={setError} onChange={size => onPatchProps?.({ size })} />
        <SelectField label="format" value={props.format || 'raw'} options={formatOptions} onChange={format => onPatchProps?.({ format })} />
        <NumberField label="dragRange" value={props.dragRange ?? 150} min={50} max={500} onInvalid={setError} onChange={dragRange => onPatchProps?.({ dragRange })} />

        {!manifest?.params?.[props.param] && (
          <FieldError message="Unknown param. Choose a parameter from this plugin." />
        )}
        <FieldError message={error} />
      </InspectorGroup>

      <AppearanceFields
        nodeType="knob"
        appearance={props.appearance}
        onPatchAppearance={handlePatchAppearance}
        onApplyPresetDefaults={handleApplyPresetDefaults}
        onReplaceAppearance={handleReplaceAppearance}
        validationErrors={validationErrors}
      />
    </>
  )
}

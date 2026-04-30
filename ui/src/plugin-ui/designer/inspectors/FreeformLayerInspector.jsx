import React from 'react'
import { InspectorGroup, NumberField, SelectField } from './FieldControls.jsx'

const GRID_PX_OPTIONS = [
  { value: '1',  label: '1 px' },
  { value: '2',  label: '2 px' },
  { value: '4',  label: '4 px' },
  { value: '8',  label: '8 px (default)' },
  { value: '16', label: '16 px' },
]

const BACKGROUND_OPTIONS = [
  { value: 'transparent', label: 'Transparent' },
  { value: 'panel',       label: 'Panel' },
  { value: 'inset',       label: 'Inset' },
]

const CLIP_OPTIONS = [
  { value: 'panel',   label: 'Clip to bounds' },
  { value: 'visible', label: 'Allow overflow' },
]

export default function FreeformLayerInspector({ node, onPatchProps, onPatchStyle }) {
  const props = node.props || {}
  const style = node.style || {}
  const snap  = props.snap  || {}

  const patchSnap = (snapPatch) => {
    onPatchProps?.({ snap: { ...snap, ...snapPatch } })
  }

  return (
    <InspectorGroup title="Freeform Layer">
      <NumberField
        label="widthPx"
        value={style.widthPx ?? ''}
        min={1}
        max={4096}
        step={1}
        onChange={v => onPatchStyle?.({ widthPx: Math.round(v) })}
        onInvalid={() => {}}
      />
      <NumberField
        label="heightPx"
        value={style.heightPx ?? ''}
        min={1}
        max={4096}
        step={1}
        onChange={v => onPatchStyle?.({ heightPx: Math.round(v) })}
        onInvalid={() => {}}
      />

      <SelectField
        label="background"
        value={props.background || 'transparent'}
        options={BACKGROUND_OPTIONS}
        onChange={background => onPatchProps?.({ background })}
      />

      <SelectField
        label="clip"
        value={props.clip || 'panel'}
        options={CLIP_OPTIONS}
        onChange={clip => onPatchProps?.({ clip })}
      />

      <SelectField
        label="snap.gridPx"
        value={String(snap.gridPx ?? 8)}
        options={GRID_PX_OPTIONS}
        onChange={v => patchSnap({ gridPx: parseInt(v, 10) })}
      />

      <label className="pluginui-designer-field pluginui-designer-field--checkbox">
        <span className="pluginui-designer-field-label">snap.enabled</span>
        <input
          type="checkbox"
          checked={snap.enabled !== false}
          onChange={e => patchSnap({ enabled: e.target.checked })}
        />
      </label>
    </InspectorGroup>
  )
}

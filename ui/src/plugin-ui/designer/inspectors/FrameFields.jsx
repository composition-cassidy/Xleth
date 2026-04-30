import React, { useState } from 'react'
import { FieldError, InspectorGroup } from './FieldControls.jsx'

const FRAME_BOUNDS = {
  x:        { min: -2000, max: 4000 },
  y:        { min: -2000, max: 4000 },
  widthPx:  { min: 1,     max: 4096 },
  heightPx: { min: 1,     max: 4096 },
  zIndex:   { min: 0,     max: 999  },
}

const FRAME_LABELS = {
  x:        'x',
  y:        'y',
  widthPx:  'widthPx',
  heightPx: 'heightPx',
  zIndex:   'zIndex',
}

function clampFrameField(field, value) {
  const b = FRAME_BOUNDS[field]
  return Math.max(b.min, Math.min(b.max, Math.round(value)))
}

export default function FrameFields({ frame = {}, onPatchFrame }) {
  const [fieldErrors, setFieldErrors] = useState({})

  const commitField = (field, rawValue) => {
    if (rawValue === '' || rawValue == null) {
      setFieldErrors(prev => ({ ...prev, [field]: 'Required' }))
      return
    }
    const parsed = parseInt(String(rawValue), 10)
    if (!Number.isFinite(parsed)) {
      setFieldErrors(prev => ({ ...prev, [field]: 'Enter a valid integer' }))
      return
    }
    const clamped = clampFrameField(field, parsed)
    setFieldErrors(prev => ({ ...prev, [field]: null }))
    onPatchFrame?.({ ...frame, [field]: clamped })
  }

  return (
    <InspectorGroup title="Frame">
      {Object.keys(FRAME_BOUNDS).map(field => (
        <FrameNumberField
          key={field}
          label={FRAME_LABELS[field]}
          value={frame[field]}
          bounds={FRAME_BOUNDS[field]}
          error={fieldErrors[field]}
          onCommit={raw => commitField(field, raw)}
        />
      ))}
      <label className="pluginui-designer-field pluginui-designer-field--checkbox">
        <span className="pluginui-designer-field-label">locked</span>
        <input
          type="checkbox"
          checked={!!frame.locked}
          onChange={e => {
            const next = { ...frame }
            if (e.target.checked) next.locked = true
            else delete next.locked
            onPatchFrame?.(next)
          }}
        />
      </label>
      {typeof frame.rotationDeg === 'number' && frame.rotationDeg !== 0 && (
        <div className="pluginui-designer-frame-rotation-hint">
          rotation: {frame.rotationDeg}° (read-only)
        </div>
      )}
    </InspectorGroup>
  )
}

function FrameNumberField({ label, value, bounds, error, onCommit }) {
  const [draft, setDraft] = useState(null)

  const displayValue = draft !== null ? draft : (value != null ? String(value) : '')

  const flush = (raw) => {
    const v = raw !== undefined ? raw : draft
    setDraft(null)
    if (v !== null && v !== '') onCommit(v)
  }

  return (
    <label className="pluginui-designer-field">
      <span className="pluginui-designer-field-label">{label}</span>
      <div className="pluginui-designer-frame-number">
        <input
          className="pluginui-designer-input"
          type="number"
          value={displayValue}
          min={bounds.min}
          max={bounds.max}
          step={1}
          onChange={e => setDraft(e.target.value)}
          onBlur={e => flush(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') flush() }}
        />
        {error && <FieldError message={error} />}
      </div>
    </label>
  )
}

export { FRAME_BOUNDS, clampFrameField }

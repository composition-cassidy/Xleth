import React from 'react'

export function InspectorGroup({ title, children }) {
  return (
    <div className="pluginui-designer-inspector-group pluginui-designer-type-section">
      <div className="pluginui-designer-inspector-group-title">{title}</div>
      {children}
    </div>
  )
}

export function TextField({ label, value, onChange, maxLength, readOnly = false }) {
  return (
    <label className="pluginui-designer-field">
      <span className="pluginui-designer-field-label">{label}</span>
      <input
        className={`pluginui-designer-input${readOnly ? ' pluginui-designer-input--readonly' : ''}`}
        type="text"
        value={value ?? ''}
        maxLength={maxLength}
        readOnly={readOnly}
        onChange={event => onChange?.(event.target.value)}
      />
    </label>
  )
}

export function NumberField({ label, value, min, max, step = 'any', onChange, onInvalid }) {
  return (
    <label className="pluginui-designer-field">
      <span className="pluginui-designer-field-label">{label}</span>
      <input
        className="pluginui-designer-input"
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        onChange={event => {
          const raw = event.target.value
          const parsed = Number(raw)
          if (raw === '' || !Number.isFinite(parsed)) {
            onInvalid?.('Enter a valid number')
            return
          }
          if (min != null && parsed < min) {
            onInvalid?.(`Minimum is ${min}`)
            return
          }
          if (max != null && parsed > max) {
            onInvalid?.(`Maximum is ${max}`)
            return
          }
          onInvalid?.(null)
          onChange?.(parsed)
        }}
      />
    </label>
  )
}

export function SelectField({ label, value, options, onChange }) {
  return (
    <label className="pluginui-designer-field">
      <span className="pluginui-designer-field-label">{label}</span>
      <select
        className="pluginui-designer-select"
        value={value ?? ''}
        onChange={event => onChange?.(event.target.value || undefined)}
      >
        {options.map(option => (
          <option
            key={option.value ?? ''}
            value={option.value ?? ''}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function FieldError({ message }) {
  if (!message) return null
  return <div className="pluginui-designer-field-error">{message}</div>
}

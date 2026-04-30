import React from 'react'
import * as METER_SLOTS from '../../constants/meterSlots.js'

export default function BindingPicker({
  kind,
  value,
  onChange,
  manifest,
  disabled = false,
  includeUnset = false,
}) {
  const options = getBindingPickerOptions({ kind, value, manifest, includeUnset })
  const selectedValue = value == null ? '' : String(value)

  return (
    <select
      className="pluginui-designer-select pluginui-designer-binding-picker"
      value={selectedValue}
      disabled={disabled}
      onChange={event => {
        const nextValue = event.target.value
        const selected = options.find(option => option.value === nextValue)
        if (!selected || selected.disabled) return
        onChange?.(nextValue)
      }}
    >
      {options.map(option => (
        <option
          key={`${option.value || 'unset'}-${option.label}`}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function getBindingPickerOptions({ kind, value, manifest, includeUnset = false }) {
  if (kind === 'param') {
    return getParamPickerOptions(manifest, value, includeUnset)
  }
  if (kind === 'meterSlot') {
    return getMeterSlotOptions(manifest, value, includeUnset)
  }
  if (kind === 'vizSource') {
    return getVizSourceOptions(manifest, value, includeUnset)
  }
  return includeUnset ? [unsetOption()] : []
}

export function getParamPickerOptions(manifest, currentValue, includeUnset = false) {
  const options = includeUnset ? [unsetOption()] : []
  const params = manifest?.params || {}

  for (const [paramId, meta] of Object.entries(params)) {
    const label = meta?.label ? `${meta.label} (${paramId})` : paramId
    options.push({ value: paramId, label })
  }

  return withRemovedOption(options, currentValue)
}

export function getMeterSlotOptions(manifest, currentValue, includeUnset = false) {
  const options = includeUnset ? [unsetOption()] : []
  const semanticSlots = new Set(getSemanticMeterSlotKeys())
  const manifestSlots = Array.isArray(manifest?.meterSlots) ? manifest.meterSlots : []

  for (const slot of manifestSlots) {
    if (!semanticSlots.has(slot)) continue
    options.push({ value: slot, label: slot })
  }

  return withRemovedOption(options, currentValue)
}

export function getVizSourceOptions(manifest, currentValue, includeUnset = false) {
  const options = includeUnset ? [unsetOption()] : []
  const sources = Array.isArray(manifest?.vizSources) ? manifest.vizSources : []

  for (const source of sources) {
    options.push({ value: source, label: source })
  }

  return withRemovedOption(options, currentValue)
}

export function getSemanticMeterSlotKeys() {
  return Object.entries(METER_SLOTS)
    .filter(([key, slot]) => key !== 'NUM_METER_SLOTS' && typeof slot === 'number')
    .map(([key]) => key)
}

function unsetOption() {
  return { value: '', label: '(unset)', disabled: true }
}

function withRemovedOption(options, currentValue) {
  const normalized = currentValue == null ? '' : String(currentValue)
  if (!normalized) return options
  if (options.some(option => option.value === normalized)) return options
  return [
    { value: normalized, label: `(removed) ${normalized}`, disabled: true, removed: true },
    ...options,
  ]
}

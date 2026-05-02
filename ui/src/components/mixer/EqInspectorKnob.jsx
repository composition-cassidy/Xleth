import React from 'react'
import Knob from '../sampler/Knob.jsx'
import { clamp } from './eqGeometry.js'

const UNIT_BY_KEY = {
  dyn_thresh: 'dB',
  dyn_attack: 'ms',
  dyn_release: 'ms',
  spec_depth: 'dB',
  spec_attack: 'ms',
  spec_release: 'ms',
}

function decimalsForStep(step) {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot >= 0 ? text.length - dot - 1 : 0
}

export function quantizeInspectorValue(field, value) {
  const stepped = field.step > 0
    ? Math.round(value / field.step) * field.step
    : value
  const decimals = Math.max(field.decimals ?? 0, decimalsForStep(field.step))
  return Number(clamp(stepped, field.min, field.max).toFixed(decimals))
}

export function formatInspectorValue(field, value) {
  const v = quantizeInspectorValue(field, value)
  if (field.key === 'dyn_ratio') return `${v.toFixed(1)}:1`
  if (field.key === 'spec_sens') return v.toFixed(2)
  if (field.key === 'spec_sel') return v.toFixed(1)

  const unit = UNIT_BY_KEY[field.key]
  const decimals = field.decimals ?? 0
  const text = v.toFixed(decimals)
  const signed = field.key === 'spec_depth' && v > 0 ? `+${text}` : text
  return unit ? `${signed} ${unit}` : signed
}

export function buildInspectorKnobProps(field, value, onChange) {
  const safeValue = value != null ? value : field.def
  return {
    value: quantizeInspectorValue(field, safeValue),
    min: field.min,
    max: field.max,
    defaultValue: field.def,
    formatValue: v => formatInspectorValue(field, v),
    onLiveChange: next => onChange(field.key, quantizeInspectorValue(field, next)),
    onCommit: next => onChange(field.key, quantizeInspectorValue(field, next)),
  }
}

export default function EqInspectorKnob({
  field,
  value,
  onChange,
  isBipolar = false,
  accentCssVar = '--xleth-eq-accent',
}) {
  const knobProps = buildInspectorKnobProps(field, value, onChange)
  const display = formatInspectorValue(field, knobProps.value)

  return (
    <div
      className={`eq-inspector-knob${isBipolar ? ' eq-inspector-knob--bipolar' : ''}`}
      data-key={field.key}
      data-control="knob"
    >
      <span className="eq-inspector-knob-label">{field.label}</span>
      <Knob
        {...knobProps}
        label=""
        size={38}
        dragRange={field.key.endsWith('_release') ? 220 : 170}
        appearancePreset="eq-inspector"
        capStyle="soft-disk"
        ringStyle={isBipolar ? 'split-track' : 'metered-arc'}
        pointerStyle="needle"
        tickStyle="sparse"
        tickDensity="sparse"
        valueReadout="hidden"
        labelPlacement="hidden"
        depth="sunken"
        appearanceTokens={{
          accentCssVar,
          surfaceCssVar: '--xleth-eq-bg-row-alt',
          textCssVar: '--xleth-eq-text-secondary',
        }}
      />
      <span className="eq-inspector-knob-value" aria-label={`${field.label} value`}>
        {display}
      </span>
    </div>
  )
}

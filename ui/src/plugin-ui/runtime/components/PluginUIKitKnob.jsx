import React from 'react'
import BaseKnob from '../../../components/sampler/Knob.jsx'
import {
  getAppearanceClassName,
  resolveAppearance,
  resolveAppearanceTokens,
} from '../../appearance/appearanceRegistry.js'

const SIZE_PRESET_MAP = { compact: 40, standard: 52, large: 64 }
const SIZE_PX_MIN = 24
const SIZE_PX_MAX = 128

export function resolveSizePreset(sizePreset, baseSizeProp = 52) {
  if (sizePreset && sizePreset !== 'inherit' && SIZE_PRESET_MAP[sizePreset] != null) {
    return SIZE_PRESET_MAP[sizePreset]
  }
  return baseSizeProp
}

export function resolveEffectiveKnobSize(appearance, baseSizeProp = 52) {
  const sizePx = appearance?.sizePx
  if (typeof sizePx === 'number' && Number.isFinite(sizePx) && sizePx >= SIZE_PX_MIN && sizePx <= SIZE_PX_MAX) {
    return Math.round(sizePx)
  }
  return resolveSizePreset(appearance?.sizePreset, baseSizeProp)
}

export default function PluginUIKitKnob({
  value,
  min,
  max,
  defaultValue,
  label,
  formatValue,
  onLiveChange,
  onCommit,
  size = 52,
  dragRange = 150,
  appearance: rawAppearance,
}) {
  const model = buildPluginKnobRenderModel(rawAppearance, size)
  const { appearance, className, style, knobTokens, effectiveSize } = model
  const appearancePreset = rawAppearance != null ? appearance.preset : undefined

  return (
    <div
      className={className}
      style={style}
      data-appearance-preset={appearance.preset}
    >
      <BaseKnob
        value={value}
        min={min}
        max={max}
        defaultValue={defaultValue}
        label={label}
        formatValue={formatValue}
        onLiveChange={onLiveChange}
        onCommit={onCommit}
        size={effectiveSize}
        dragRange={dragRange}
        appearancePreset={appearancePreset}
        capStyle={appearance.cap}
        ringStyle={appearance.ring}
        pointerStyle={appearance.pointer}
        tickStyle={appearance.ticks}
        tickDensity={appearance.tickDensity}
        valueReadout={appearance.valueReadout}
        labelPlacement={appearance.labelPlacement}
        depth={appearance.depth}
        appearanceTokens={knobTokens}
      />
    </div>
  )
}

export function buildPluginKnobRenderModel(rawAppearance, baseSizeProp = 52) {
  const appearance = resolveAppearance('knob', rawAppearance)
  const tokens = resolveAppearanceTokens('knob', appearance)
  const presetClassName = getAppearanceClassName('knob', appearance)
  const effectiveSize = resolveEffectiveKnobSize(appearance, baseSizeProp)

  const className = [
    'pluginui-knob',
    presetClassName,
    `pluginui-knob--depth-${appearance.depth}`,
    `pluginui-knob--readout-${appearance.valueReadout}`,
    `pluginui-knob--label-${appearance.labelPlacement}`,
  ].filter(Boolean).join(' ')

  const knobTokens = {
    surfaceCssVar: tokens.surfaceToken?.cssVar || null,
    accentCssVar: tokens.accentToken?.cssVar || null,
    textCssVar: tokens.textToken?.cssVar || null,
  }

  return {
    appearance,
    tokens,
    knobTokens,
    className,
    style: buildSafeTokenStyle(knobTokens),
    effectiveSize,
  }
}

function buildSafeTokenStyle(tokens) {
  const style = {}
  if (tokens.surfaceCssVar) style['--pluginui-knob-surface'] = `var(${tokens.surfaceCssVar})`
  if (tokens.accentCssVar) style['--pluginui-knob-accent'] = `var(${tokens.accentCssVar})`
  if (tokens.textCssVar) style['--pluginui-knob-text'] = `var(${tokens.textCssVar})`
  return style
}

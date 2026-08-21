import React from 'react'
import BaseKnob from '../../../components/sampler/Knob.jsx'
import {
  getAppearanceClassName,
  resolveAppearance,
  resolveAppearanceTokens,
} from '../../appearance/appearanceRegistry.js'
import { useKnobAutomation } from '../../../components/mixer/automationKnobBinding.jsx'

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
  skew = 1,
  appearance: rawAppearance,
  accentColor,
  // Automation (Phase C). `paramId` is the effect's stable APVTS parameter id
  // and `automationTarget` is the panel's { trackId, nodeId } (trackId -1 =
  // Master chain). Supplying BOTH opts this knob into right-click "Create
  // automation clip" and the automated read-only state; omitting either (every
  // knob outside a stock effect panel) runs none of that path.
  paramId = null,
  automationTarget = null,
}) {
  const model = buildPluginKnobRenderModel(rawAppearance, size)
  const { appearance, className, style, knobTokens, effectiveSize } = model
  const appearancePreset = rawAppearance != null ? appearance.preset : undefined

  const automation = useKnobAutomation(paramId, automationTarget, { min, max, skew })

  // An explicit accentColor (e.g. a band identity color) wins over the
  // preset's accent token: drop the token so BaseKnob falls back to `color`.
  const effectiveTokens = accentColor
    ? { ...knobTokens, accentCssVar: null }
    : knobTokens

  // While a clip covers the playhead the knob DISPLAYS the automated value and
  // refuses manual edits — the clip owns the parameter there. Outside every
  // clip the knob is a normal knob again and its edits write the base value.
  const displayValue = automation.automated ? automation.automatedValue : value
  const liveChange = automation.automated ? undefined : onLiveChange
  // Outside every clip the knob is a normal knob, and its commit ALSO records
  // the parameter's base value — the value automation falls back to before any
  // clip has played. No-ops for knobs with no envelope bound.
  const commit = automation.automated
    ? undefined
    : (v) => { onCommit?.(v); automation.writeBaseValue?.(v) }

  return (
    <div
      className={`${className}${automation.automated ? ' pluginui-knob--automated' : ''}`}
      style={style}
      data-appearance-preset={appearance.preset}
      data-automated={automation.automated ? 'true' : undefined}
      data-automated-value={automation.automated ? String(automation.automatedValue) : undefined}
      data-automation-param={paramId || undefined}
      title={automation.automated
        ? 'Driven by an automation clip at the playhead - edit the clip on the timeline'
        : undefined}
      onContextMenu={automation.onContextMenu}
    >
      {automation.menuNode}
      <BaseKnob
        value={displayValue}
        min={min}
        max={max}
        defaultValue={defaultValue}
        label={label}
        formatValue={formatValue}
        onLiveChange={liveChange}
        onCommit={commit}
        size={effectiveSize}
        dragRange={dragRange}
        skew={skew}
        appearancePreset={appearancePreset}
        capStyle={appearance.cap}
        ringStyle={appearance.ring}
        pointerStyle={appearance.pointer}
        tickStyle={appearance.ticks}
        tickDensity={appearance.tickDensity}
        valueReadout={appearance.valueReadout}
        labelPlacement={appearance.labelPlacement}
        depth={appearance.depth}
        glyph={appearance.glyph === 'rotary-arrow' ? 'rotary-arrow' : null}
        appearanceTokens={effectiveTokens}
        color={accentColor || undefined}
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

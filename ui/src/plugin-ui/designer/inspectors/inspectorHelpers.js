import { COMPRESSOR_SOURCE_DEFAULT_PRESET, COMPRESSOR_VISUALIZER_PRESETS } from '../../runtime/visualizers/compressorPainter.js'
import { LIMITER_SOURCE_DEFAULT_PRESET, LIMITER_VISUALIZER_PRESETS } from '../../runtime/visualizers/limiterPainter.js'
import { getKnobPreset } from '../../appearance/knobPresets.js'

// Source-key prefix → preset registries. Keeping this prefix-driven means
// adding a new dynamics plugin only needs a new `<plugin>Painter.js` file
// plus an entry here.
function presetsForSource(source) {
  if (typeof source === 'string' && source.startsWith('limiter.')) {
    return {
      visualizers:    LIMITER_VISUALIZER_PRESETS,
      defaultsBySrc:  LIMITER_SOURCE_DEFAULT_PRESET,
      fallbackPreset: 'limiterRealtime',
    }
  }
  return {
    visualizers:    COMPRESSOR_VISUALIZER_PRESETS,
    defaultsBySrc:  COMPRESSOR_SOURCE_DEFAULT_PRESET,
    fallbackPreset: 'levelHistory',
  }
}

const GENERIC_KNOB_LABELS = new Set(['', '<unset>', 'Knob'])
const GENERIC_TOGGLE_LABELS = new Set(['', '<unset>', 'Toggle'])
const GENERIC_METER_LABELS = new Set(['', '<unset>', 'Meter'])

export function clampNumber(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(min, Math.min(max, number))
}

export function buildKnobPatchForParam(props = {}, paramId, manifest) {
  const meta = manifest?.params?.[paramId]
  if (!meta) return null

  const oldMeta = manifest?.params?.[props.param]
  const currentLabel = String(props.label ?? '')
  const shouldDefaultLabel =
    GENERIC_KNOB_LABELS.has(currentLabel) ||
    (oldMeta?.label && currentLabel === oldMeta.label)

  return {
    param: paramId,
    ...(shouldDefaultLabel && meta.label ? { label: meta.label } : {}),
    ...((!props.format || props.format === 'raw') && meta.format ? { format: meta.format } : {}),
    ...(props.size == null ? { size: 52 } : {}),
  }
}

export function buildTogglePatchForParam(props = {}, paramId, manifest) {
  const meta = manifest?.params?.[paramId]
  if (!meta) return null

  const currentLabel = String(props.label ?? '')
  const shouldDefaultLabel = GENERIC_TOGGLE_LABELS.has(currentLabel)

  return {
    param: paramId,
    ...(shouldDefaultLabel && meta.label ? { label: meta.label } : {}),
  }
}

export function buildMeterPatchForSlot(props = {}, slot) {
  if (!slot) return null
  const currentLabel = String(props.label ?? '')
  const shouldDefaultLabel = GENERIC_METER_LABELS.has(currentLabel)

  return {
    source: { kind: 'effectMeter', slot },
    ...(shouldDefaultLabel ? { label: friendlyMeterSlotLabel(slot) } : {}),
  }
}

export function friendlyMeterSlotLabel(slot) {
  if (slot === 'PEAK_L') return 'Peak L'
  if (slot === 'PEAK_R') return 'Peak R'
  if (slot === 'GAIN_REDUCTION') return 'GR'
  return String(slot || '')
    .toLowerCase()
    .split('_')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ')
}

export function isMeterRangeValid(range) {
  return Number.isFinite(range?.min) &&
    Number.isFinite(range?.max) &&
    range.min < range.max
}

export function getPresetOptionsForSource(source, currentPreset) {
  const { visualizers } = presetsForSource(source)
  const options = Object.entries(visualizers)
    .filter(([, preset]) => isPresetAllowedForSource(preset, source))
    .map(([value, preset]) => ({ value, label: preset.label || value }))

  if (currentPreset && !options.some(option => option.value === currentPreset)) {
    return [
      { value: currentPreset, label: `(removed) ${currentPreset}`, disabled: true, removed: true },
      ...options,
    ]
  }

  return options
}

export function isPresetAllowedForSource(presetOrKey, source) {
  const { visualizers } = presetsForSource(source)
  // If the caller passed a preset key (string), look it up in the registry
  // appropriate for this source. If they passed a preset object, use it as-is.
  let preset = typeof presetOrKey === 'string'
    ? visualizers[presetOrKey]
    : presetOrKey
  // Fallback: a plugin-cross preset key (e.g. compressor preset on a limiter
  // source) won't be in the per-source registry — try the other side so we
  // can still report "not allowed" instead of treating it as unknown.
  if (!preset && typeof presetOrKey === 'string') {
    preset = COMPRESSOR_VISUALIZER_PRESETS[presetOrKey] || LIMITER_VISUALIZER_PRESETS[presetOrKey]
  }
  if (!preset) return false
  if (!Array.isArray(preset.sources) || preset.sources.length === 0) return true
  return preset.sources.includes(source)
}

export function resolveSafePresetForSource(source) {
  const { visualizers, defaultsBySrc, fallbackPreset } = presetsForSource(source)
  const defaultPreset = defaultsBySrc[source]
  if (defaultPreset && isPresetAllowedForSource(defaultPreset, source)) {
    return defaultPreset
  }

  const first = Object.entries(visualizers)
    .find(([, preset]) => isPresetAllowedForSource(preset, source))
  return first?.[0] ?? fallbackPreset
}

export const APPEARANCE_REMOVE_SENTINEL = '__appearance_remove__'

export function patchAppearance(currentAppearance, patch) {
  const base = currentAppearance && typeof currentAppearance === 'object' && !Array.isArray(currentAppearance)
    ? { ...currentAppearance }
    : {}

  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === APPEARANCE_REMOVE_SENTINEL) {
      delete base[key]
    } else {
      base[key] = value
    }
  }

  return Object.keys(base).length === 0 ? null : base
}

export function removeAppearanceKey(currentAppearance, key) {
  return patchAppearance(currentAppearance, { [key]: APPEARANCE_REMOVE_SENTINEL })
}

export function buildPresetPatch(presetId, mode = 'preset-only') {
  if (typeof presetId !== 'string' || !presetId) return null
  const preset = getKnobPreset(presetId)
  if (!preset) return null

  if (mode === 'apply-defaults') {
    return { ...preset.defaults, preset: presetId }
  }

  return { preset: presetId }
}

export function buildVisualizerPatchForSource(props = {}, source, manifest) {
  if (!manifest?.vizSources?.includes(source)) return null
  const currentPreset = props.preset
  const nextPreset = isPresetAllowedForSource(currentPreset, source)
    ? currentPreset
    : resolveSafePresetForSource(source)

  return {
    source,
    preset: nextPreset,
  }
}

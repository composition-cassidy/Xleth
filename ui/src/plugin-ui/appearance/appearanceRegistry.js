import {
  getTokenOptionsForGroup,
  getTokenSlot,
  isKnownTokenId,
  isTokenInGroup,
  resolveTokenCssVar,
} from './tokenSlots.js'
import {
  getDefaultKnobAppearance,
  getKnobPreset,
  KNOB_PRESET_IDS,
  KNOB_PRESETS,
} from './knobPresets.js'

export const APPEARANCE_ESCAPE_KEYS = Object.freeze([
  'style',
  'className',
  'class',
  'css',
  'cssText',
  'sx',
  'html',
  'script',
  'src',
  'href',
  'url',
  'webview',
  'iframe',
])

export const RAW_COLOR_NAMES = Object.freeze([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'cyan',
  'magenta',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'transparent',
  'currentColor',
])

export const RAW_COLOR_PATTERNS = Object.freeze([
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(/i,
  /^hsla?\(/i,
  /^var\(/i,
  /^--[a-z0-9-_]+$/i,
  /^[a-z-]+\s*:/i,
])

const RAW_COLOR_NAME_SET = new Set(RAW_COLOR_NAMES.map(name => name.toLowerCase()))
const ESCAPE_KEY_SET = new Set(APPEARANCE_ESCAPE_KEYS)

const KNOB_ALLOWED_KEYS = {
  preset: KNOB_PRESET_IDS,
  sizePreset: ['inherit', 'compact', 'standard', 'large'],
  sizePx: { numericRange: { min: 24, max: 128, integer: true } },
  cap: ['default', 'flat-disk', 'soft-disk', 'hardware-cap', 'encoder-cap'],
  ring: ['default', 'none', 'metered-arc', 'full-track', 'split-track', 'thin-line'],
  pointer: ['default', 'line', 'needle', 'dot', 'notch', 'none'],
  ticks: ['none', 'major', 'minor', 'numbered'],
  tickDensity: ['sparse', 'normal', 'dense'],
  valueReadout: ['below', 'center', 'tooltip', 'hidden'],
  labelPlacement: ['bottom', 'top', 'left', 'hidden'],
  depth: ['flat', 'raised', 'sunken'],
  surfaceToken: { tokenGroup: 'surface' },
  accentToken: { tokenGroup: 'accent' },
  textToken: { tokenGroup: 'text' },
}

export const APPEARANCE_NODE_TYPES = {
  knob: {
    defaultPreset: 'xleth-default',
    allowedKeys: KNOB_ALLOWED_KEYS,
    fallbackAppearance: getDefaultKnobAppearance('xleth-default'),
  },
  toggle: {
    defaultPreset: 'xleth-button',
    allowedKeys: {
      preset: ['xleth-button', 'pill', 'square', 'segmented'],
      depth: ['flat', 'raised'],
      surfaceToken: { tokenGroup: 'surface' },
      accentToken: { tokenGroup: 'accent' },
      textToken: { tokenGroup: 'text' },
    },
    fallbackAppearance: {
      preset: 'xleth-button',
      depth: 'flat',
      surfaceToken: 'surface.control',
      accentToken: 'accent.primary',
      textToken: 'text.primary',
    },
  },
  meter: {
    defaultPreset: 'smooth-bar',
    allowedKeys: {
      preset: ['smooth-bar', 'segmented-bar', 'led-ladder'],
      depth: ['flat', 'inset'],
      surfaceToken: { tokenGroup: 'surface' },
      meterFillToken: { tokenGroups: ['meter', 'accent'] },
      textToken: { tokenGroup: 'text' },
    },
    fallbackAppearance: {
      preset: 'smooth-bar',
      depth: 'flat',
      surfaceToken: 'surface.inset',
      meterFillToken: 'meter.gr',
      textToken: 'text.muted',
    },
  },
  visualizer: {
    defaultPreset: 'panel-flat',
    allowedKeys: {
      preset: ['panel-flat', 'panel-framed', 'scope-inset'],
      visualizerTheme: ['default', 'dark-grid', 'minimal', 'metered'],
      grid: ['auto', 'visible', 'hidden'],
      surfaceToken: { tokenGroup: 'surface' },
      accentToken: { tokenGroup: 'accent' },
      textToken: { tokenGroup: 'text' },
    },
    fallbackAppearance: {
      preset: 'panel-flat',
      visualizerTheme: 'default',
      grid: 'auto',
      surfaceToken: 'surface.panel',
      accentToken: 'accent.primary',
      textToken: 'text.muted',
    },
  },
}

export function isRawColorLike(value) {
  if (typeof value !== 'string') return false

  const trimmed = value.trim()
  if (!trimmed) return false

  if (RAW_COLOR_NAME_SET.has(trimmed.toLowerCase())) return true
  return RAW_COLOR_PATTERNS.some(pattern => pattern.test(trimmed))
}

export function isAppearanceEscapeKey(key) {
  return ESCAPE_KEY_SET.has(key)
}

export function getAppearanceRulesForType(nodeType) {
  return APPEARANCE_NODE_TYPES[nodeType] || null
}

export function normalizeAppearance(nodeType, appearance) {
  const rules = getAppearanceRulesForType(nodeType)
  if (!rules) return null
  if (!isPlainObject(appearance)) return { ...rules.fallbackAppearance }

  const presetOptions = Array.isArray(rules.allowedKeys.preset) ? rules.allowedKeys.preset : []
  const presetId = typeof appearance.preset === 'string' && presetOptions.includes(appearance.preset)
    ? appearance.preset
    : rules.defaultPreset
  const base = nodeType === 'knob'
    ? getDefaultKnobAppearance(presetId)
    : { ...rules.fallbackAppearance }

  const normalized = { ...base }
  for (const [key, value] of Object.entries(appearance)) {
    const result = validateAppearanceValue(nodeType, key, value)
    if (result.ok) normalized[key] = value
  }
  return normalized
}

export function resolveAppearance(nodeType, rawAppearance) {
  return normalizeAppearance(nodeType, rawAppearance)
}

export function resolveAppearanceTokens(nodeType, normalizedAppearance) {
  const rules = getAppearanceRulesForType(nodeType)
  if (!rules) return {}

  const appearance = normalizeAppearance(nodeType, normalizedAppearance)
  const out = {}
  for (const [key, allowed] of Object.entries(rules.allowedKeys)) {
    if (!allowed || (!allowed.tokenGroup && !allowed.tokenGroups)) continue
    const tokenId = appearance?.[key]
    const fallbackTokenId = rules.fallbackAppearance?.[key]
    const cssVar = resolveTokenCssVar(tokenId, fallbackTokenId)
    if (!cssVar) continue
    out[key] = {
      tokenId: resolveKnownTokenId(tokenId, fallbackTokenId),
      cssVar,
    }
  }
  return out
}

export function getAppearanceClassName(nodeType, normalizedAppearance) {
  if (nodeType !== 'knob') return null

  const appearance = normalizeAppearance(nodeType, normalizedAppearance)
  return getKnobPreset(appearance?.preset)?.className || getKnobPreset('xleth-default')?.className || null
}

export function validateAppearanceValue(nodeType, key, value) {
  if (isAppearanceEscapeKey(key)) {
    return { ok: false, code: 'APPEARANCE_ESCAPE_KEY', message: `Appearance key "${key}" is not allowed` }
  }
  if (isRawColorLike(value) || Array.isArray(value) || (value && typeof value === 'object')) {
    return { ok: false, code: 'RAW_APPEARANCE_VALUE', message: `Appearance value for "${key}" must not contain raw CSS or color data` }
  }

  const rules = getAppearanceRulesForType(nodeType)
  if (!rules) {
    return { ok: false, code: 'APPEARANCE_NOT_SUPPORTED', message: `Appearance is not supported on node type "${nodeType}"` }
  }

  const allowed = rules.allowedKeys[key]
  if (!allowed) {
    return { ok: false, code: 'UNKNOWN_APPEARANCE_KEY', message: `Unknown appearance key: "${key}"` }
  }

  if (Array.isArray(allowed)) {
    return allowed.includes(value)
      ? { ok: true }
      : {
          ok: false,
          code: 'UNKNOWN_APPEARANCE_VALUE',
          message: `Unknown appearance value "${value}" for "${key}"`,
          fallback: getFallbackValue(rules, key),
        }
  }

  if (allowed.numericRange) {
    const { min, max, integer } = allowed.numericRange
    const isNumber = typeof value === 'number' && Number.isFinite(value)
    const inRange = isNumber && value >= min && value <= max
    const integerOk = !integer || (isNumber && Number.isInteger(value))
    return (inRange && integerOk)
      ? { ok: true }
      : {
          ok: false,
          code: 'BAD_APPEARANCE_NUMBER',
          message: `Appearance value for "${key}" must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`,
          fallback: getFallbackValue(rules, key),
        }
  }

  const tokenGroups = allowed.tokenGroups || [allowed.tokenGroup]
  const tokenOk = typeof value === 'string'
    && isKnownTokenId(value)
    && tokenGroups.some(groupName => isTokenInGroup(value, groupName))

  return tokenOk
    ? { ok: true }
    : {
        ok: false,
        code: 'UNKNOWN_APPEARANCE_TOKEN',
        message: `Unknown appearance token "${value}" for "${key}"`,
        fallback: getFallbackValue(rules, key),
      }
}

function getFallbackValue(rules, key) {
  return rules?.fallbackAppearance?.[key]
}

function resolveKnownTokenId(tokenId, fallbackTokenId) {
  return isKnownTokenId(tokenId) ? tokenId : (isKnownTokenId(fallbackTokenId) ? fallbackTokenId : null)
}

function isPlainObject(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

const ENUM_LABEL_OVERRIDES = {
  knob: {
    sizePreset: {
      inherit: 'Inherit (size prop)',
      compact: 'Compact',
      standard: 'Standard',
      large: 'Large',
    },
    cap: {
      default: 'Default',
      'flat-disk': 'Flat Disk',
      'soft-disk': 'Soft Disk',
      'hardware-cap': 'Hardware Cap',
      'encoder-cap': 'Encoder Cap',
    },
    ring: {
      default: 'Default',
      none: 'None',
      'metered-arc': 'Metered Arc',
      'full-track': 'Full Track',
      'split-track': 'Split Track',
      'thin-line': 'Thin Line',
    },
    pointer: {
      default: 'Default',
      line: 'Line',
      needle: 'Needle',
      dot: 'Dot',
      notch: 'Notch',
      none: 'None',
    },
    ticks: {
      none: 'None',
      major: 'Major',
      minor: 'Minor',
      numbered: 'Numbered',
    },
    tickDensity: {
      sparse: 'Sparse',
      normal: 'Normal',
      dense: 'Dense',
    },
    valueReadout: {
      below: 'Below',
      center: 'Center',
      tooltip: 'Tooltip',
      hidden: 'Hidden',
    },
    labelPlacement: {
      bottom: 'Bottom',
      top: 'Top',
      left: 'Left',
      hidden: 'Hidden',
    },
    depth: {
      flat: 'Flat',
      raised: 'Raised',
      sunken: 'Sunken',
    },
  },
}

function defaultEnumLabel(value) {
  if (!value) return ''
  const text = String(value).replace(/[-_]+/g, ' ')
  return text.replace(/\b\w/g, character => character.toUpperCase())
}

export function getAppearanceAllowedKey(nodeType, key) {
  const rules = getAppearanceRulesForType(nodeType)
  if (!rules) return null
  return rules.allowedKeys[key] || null
}

export function isAppearanceTokenKey(nodeType, key) {
  const allowed = getAppearanceAllowedKey(nodeType, key)
  return !!(allowed && (allowed.tokenGroup || allowed.tokenGroups))
}

export function isAppearanceEnumKey(nodeType, key) {
  const allowed = getAppearanceAllowedKey(nodeType, key)
  return Array.isArray(allowed)
}

export function isAppearanceNumberKey(nodeType, key) {
  const allowed = getAppearanceAllowedKey(nodeType, key)
  return !!(allowed && allowed.numericRange)
}

export function getAppearanceNumberRange(nodeType, key) {
  const allowed = getAppearanceAllowedKey(nodeType, key)
  return allowed?.numericRange || null
}

export function getAppearanceOptionLabel(nodeType, key, value) {
  if (value == null || value === '') return ''
  const overrides = ENUM_LABEL_OVERRIDES[nodeType]?.[key]
  if (overrides && overrides[value]) return overrides[value]
  if (key === 'preset' && nodeType === 'knob') {
    return KNOB_PRESETS[value]?.label || defaultEnumLabel(value)
  }
  if (isAppearanceTokenKey(nodeType, key)) {
    const slot = getTokenSlot(value)
    if (slot?.label) return slot.label
  }
  return defaultEnumLabel(value)
}

export function getAppearanceOptions(nodeType, key) {
  const allowed = getAppearanceAllowedKey(nodeType, key)
  if (!allowed) return []

  if (Array.isArray(allowed)) {
    return allowed.map(value => ({
      value,
      label: getAppearanceOptionLabel(nodeType, key, value),
    }))
  }

  const tokenGroups = allowed.tokenGroups || (allowed.tokenGroup ? [allowed.tokenGroup] : [])
  const out = []
  const seen = new Set()
  for (const groupName of tokenGroups) {
    for (const option of getTokenOptionsForGroup(groupName)) {
      if (seen.has(option.value)) continue
      seen.add(option.value)
      out.push({ value: option.value, label: option.label, group: groupName })
    }
  }
  return out
}

export function getRepairableTokenOptions(nodeType, key, currentValue) {
  const baseOptions = getAppearanceOptions(nodeType, key)
  if (currentValue == null || currentValue === '') return baseOptions
  if (!isAppearanceTokenKey(nodeType, key)) return baseOptions

  const slot = getTokenSlot(currentValue)
  const allowed = getAppearanceAllowedKey(nodeType, key)
  const tokenGroups = allowed?.tokenGroups || (allowed?.tokenGroup ? [allowed.tokenGroup] : [])
  const inGroup = !!slot && tokenGroups.includes(slot.group)

  if (inGroup) return baseOptions

  const repairValue = typeof currentValue === 'string' ? currentValue : '(unknown)'
  return [
    {
      value: repairValue,
      label: `(removed) ${repairValue}`,
      disabled: true,
      removed: true,
    },
    ...baseOptions,
  ]
}

export function getRepairableEnumOptions(nodeType, key, currentValue) {
  const baseOptions = getAppearanceOptions(nodeType, key)
  if (currentValue == null || currentValue === '') return baseOptions
  if (!isAppearanceEnumKey(nodeType, key)) return baseOptions

  const allowed = getAppearanceAllowedKey(nodeType, key) || []
  if (allowed.includes(currentValue)) return baseOptions

  const repairValue = typeof currentValue === 'string' ? currentValue : '(unknown)'
  return [
    {
      value: repairValue,
      label: `(removed) ${repairValue}`,
      disabled: true,
      removed: true,
    },
    ...baseOptions,
  ]
}

export const STYLE_STRIP_ERROR_CODES = new Set([
  'UNKNOWN_STYLE_KEY',
  'BAD_STYLE_ALIGN',
  'BAD_STYLE_JUSTIFY',
])

const HARD_EQUIVALENT_ERROR_CODES = new Set([
  'DUPLICATE_ID',
  'BAD_APPEARANCE',
  'RAW_APPEARANCE_VALUE',
  'APPEARANCE_ESCAPE_KEY',
  'PLUGIN_KNOB_COLOR_FORBIDDEN',
  // Freeform-A hard codes
  'MISSING_FRAME',
  'FRAME_NOT_ALLOWED',
  'BAD_FRAME_SIZE',
  'FORBIDDEN_PROPS_KEY',
  'FORBIDDEN_PROPS_VALUE',
  'FORBIDDEN_FRAME_KEY',
  'BAD_ASSET_ID_FORMAT',
  'CONTAINER_IN_FREEFORM',
  'DECOR_NOT_IN_FREEFORM',
])

export function isStyleStripError(code) {
  return STYLE_STRIP_ERROR_CODES.has(code)
}

export function isHardValidationResult(validationResult) {
  return validationResult?.ok === false || hasHardEquivalentError(validationResult)
}

export function hasHardEquivalentError(validationResult) {
  return (validationResult?.errors || []).some(error => HARD_EQUIVALENT_ERROR_CODES.has(error?.code))
}

export function isSoftBlockingError(error) {
  if (!error?.code) return true
  if (HARD_EQUIVALENT_ERROR_CODES.has(error.code)) return false
  return !isStyleStripError(error.code)
}

export function isSaveAllowed(validationResult) {
  if (!validationResult) return false
  if (validationResult.ok === false) return false
  if (hasHardEquivalentError(validationResult)) return false
  return !(validationResult.errors || []).some(isSoftBlockingError)
}

export function isExportAllowed(validationResult) {
  return isSaveAllowed(validationResult)
}

export function getValidationSeverity(validationResult, error) {
  if (validationResult?.ok === false) return 'hard'
  if (HARD_EQUIVALENT_ERROR_CODES.has(error?.code)) return 'hard'
  if (isStyleStripError(error?.code)) return 'info'
  return 'soft'
}

export function getErrorsForNode(validationResult, nodeId) {
  if (!nodeId) return []
  return (validationResult?.errors || []).filter(error => error?.nodeId === nodeId)
}

export function getGlobalErrors(validationResult) {
  return (validationResult?.errors || []).filter(error => !error?.nodeId)
}

export function getValidationSummary(validationResult) {
  const errors = validationResult?.errors || []
  if (validationResult?.ok === false) {
    return {
      label: 'Hard validation failure',
      severity: 'hard',
      canSave: false,
      canExport: false,
    }
  }
  if (hasHardEquivalentError(validationResult) || errors.some(isSoftBlockingError)) {
    return {
      label: 'Blocked by validation',
      severity: 'soft',
      canSave: false,
      canExport: false,
    }
  }
  if (errors.some(error => isStyleStripError(error?.code))) {
    return {
      label: 'Valid with stripped style warnings',
      severity: 'info',
      canSave: true,
      canExport: true,
    }
  }
  return {
    label: 'Valid',
    severity: 'valid',
    canSave: true,
    canExport: true,
  }
}

export function formatValidationError(error) {
  if (!error) return 'Validation error'
  const code = error.code || 'VALIDATION_ERROR'

  switch (code) {
    case 'UNKNOWN_PARAM':
      return `Unknown parameter binding: ${pickDetail(error, 'param') || pickQuoted(error.message) || 'unknown'}`
    case 'UNKNOWN_SLOT':
      return `Unknown meter slot: ${pickDetail(error, 'slot') || pickQuoted(error.message) || 'unknown'}`
    case 'UNKNOWN_VIZ_SOURCE':
      return `Unknown visualizer source: ${pickDetail(error, 'source') || pickQuoted(error.message) || 'unknown'}`
    case 'DUPLICATE_ID':
      return `Duplicate node id: ${pickDetail(error, 'nodeId') || pickQuoted(error.message) || 'unknown'}`
    case 'UNKNOWN_STYLE_KEY':
      return `Unsupported style key was stripped: ${pickDetail(error, 'key') || pickQuoted(error.message) || 'unknown'}`
    case 'BAD_STYLE_ALIGN':
      return `Unsupported align value was stripped: ${pickQuoted(error.message) || 'unknown'}`
    case 'BAD_STYLE_JUSTIFY':
      return `Unsupported justify value was stripped: ${pickQuoted(error.message) || 'unknown'}`
    case 'BAD_APPEARANCE':
      return 'Appearance must be a plain object'
    case 'APPEARANCE_NOT_SUPPORTED':
      return `Appearance is not supported here: ${pickDetail(error, 'nodeId') || 'node'}`
    case 'UNKNOWN_APPEARANCE_KEY':
      return `Unknown appearance key: ${pickDetail(error, 'key') || pickQuoted(error.message) || 'unknown'}`
    case 'UNKNOWN_APPEARANCE_VALUE':
      return `Unknown appearance value: ${pickDetail(error, 'key') || pickQuoted(error.message) || 'unknown'}`
    case 'UNKNOWN_APPEARANCE_TOKEN':
      return `Unknown appearance token: ${pickDetail(error, 'value') || pickQuoted(error.message) || 'unknown'}`
    case 'RAW_APPEARANCE_VALUE':
      return `Raw CSS/color is not allowed in appearance: ${pickDetail(error, 'key') || 'value'}`
    case 'APPEARANCE_ESCAPE_KEY':
      return `Appearance escape key is not allowed: ${pickDetail(error, 'key') || pickQuoted(error.message) || 'unknown'}`
    case 'PLUGIN_KNOB_COLOR_FORBIDDEN':
      return 'Plugin UI knob props.color is forbidden; use appearance tokens'
    default:
      return error.message || code
  }
}

function pickDetail(error, key) {
  const value = error?.[key]
  return value == null || value === '' ? null : String(value)
}

function pickQuoted(message) {
  if (!message) return null
  const match = String(message).match(/"([^"]+)"/)
  return match?.[1] || null
}

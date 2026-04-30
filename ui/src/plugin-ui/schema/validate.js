// Pure layout document validator.
// Returns { ok: true, doc, errors } for hard-passable documents (soft node errors included in errors[]).
// Returns { ok: false, errors } when the whole layout must be rejected.
// Soft errors annotate individual nodes with _invalid: true; the renderer shows per-node placeholders.

import * as METER_SLOTS from '../../constants/meterSlots.js'
import {
  getAppearanceRulesForType,
  validateAppearanceValue,
} from '../appearance/appearanceRegistry.js'
import {
  isTokenInSlotGroup,
} from '../appearance/tokenSlots.js'

const SCHEMA_VERSION = 1

const ALLOWED_TYPES = new Set([
  'panel', 'group', 'row', 'column', 'tabGroup',
  'knob', 'toggle', 'button', 'meter', 'visualizer', 'label', 'spacer',
  // Freeform-A additions:
  'freeformLayer',
  'decorText', 'decorLine', 'decorShape', 'decal',
])

const CONTAINER_TYPES = new Set(['panel', 'group', 'row', 'column', 'tabGroup'])

// Decor leaves are only valid as direct children of freeformLayer.
const DECOR_LEAF_TYPES = new Set(['decorText', 'decorLine', 'decorShape', 'decal'])

// Rotation is only meaningful on decor/decal nodes.
const ROTATION_SUPPORTED_TYPES = new Set(['decorText', 'decorLine', 'decorShape', 'decal'])

const ALLOWED_STYLE_KEYS = new Set([
  'paddingPx', 'gapPx', 'widthPx', 'heightPx', 'growsToFill',
  'align', 'justify', 'flexBasis',
])

const ALLOWED_ALIGN   = new Set(['start', 'center', 'end', 'stretch'])
const ALLOWED_JUSTIFY = new Set(['start', 'center', 'end', 'spaceBetween', 'spaceAround'])

// Derive valid meter slot names from the constants file.
// Exclude NUM_METER_SLOTS (not a slot name) and only keep numeric values.
const VALID_METER_SLOT_NAMES = new Set(
  Object.entries(METER_SLOTS)
    .filter(([k, v]) => k !== 'NUM_METER_SLOTS' && typeof v === 'number')
    .map(([k]) => k)
)

const MAX_DOC_BYTES = 256 * 1024  // 256 KB

// ── Frame bounds ──────────────────────────────────────────────────────────────

const FRAME_XY_MIN    = -2000
const FRAME_XY_MAX    =  4000
const FRAME_WH_MIN    =  1
const FRAME_WH_MAX    =  4096
const FRAME_ROT_MIN   = -360
const FRAME_ROT_MAX   =  360
const FRAME_ZIDX_MIN  =  0
const FRAME_ZIDX_MAX  =  999

const KNOWN_FRAME_KEYS = new Set(['x', 'y', 'widthPx', 'heightPx', 'rotationDeg', 'zIndex', 'locked'])

// ── Freeform layer allowed prop values ────────────────────────────────────────

const VALID_SNAP_GRID = new Set([1, 2, 4, 8, 16])
const VALID_FREEFORM_BG   = new Set(['transparent', 'panel', 'inset'])
const VALID_FREEFORM_CLIP = new Set(['panel', 'visible'])

// ── Decor node enum tables ─────────────────────────────────────────────────────

const DECOR_TEXT_VARIANTS   = ['default', 'muted', 'header', 'caption', 'value']
const DECOR_TEXT_ALIGNS     = ['left', 'center', 'right']
const DECOR_TEXT_LS         = ['tight', 'normal', 'wide', 'wider']

const DECOR_LINE_ORIENTATIONS = ['horizontal', 'vertical']
const DECOR_LINE_THICKNESSES  = ['hair', 'thin', 'medium', 'thick']
const DECOR_LINE_STYLES       = ['solid', 'dashed', 'dotted']

const DECOR_SHAPE_SHAPES       = ['rect', 'roundedRect', 'circle', 'pill']
const DECOR_SHAPE_RADII        = [0, 2, 4, 8, 12, 16]
const DECOR_STROKE_WIDTHS      = [0, 1, 2, 3, 4]
const DECOR_OPACITIES          = [25, 50, 75, 100]

const DECAL_FITS               = ['contain', 'cover', 'stretch']

// ── Forbidden key / value scanning ───────────────────────────────────────────

const FORBIDDEN_KEYS_SET = new Set([
  'src', 'href', 'url', 'path', 'filename', 'file', 'data', 'base64',
  'html', 'innerHTML', 'dangerouslySetInnerHTML', 'script',
  'style', 'className', 'class', 'css', 'cssText', 'sx', 'ref', 'key',
])

function isForbiddenKey(key) {
  return FORBIDDEN_KEYS_SET.has(key) || /^on[A-Za-z]/.test(key)
}

// Patterns that are forbidden in any props string value (except display text).
const FORBIDDEN_VALUE_PATTERNS = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,   // hex color
  /^rgba?\(/i,                                            // rgb / rgba
  /^hsla?\(/i,                                            // hsl / hsla
  /^var\(/i,                                              // var(...)
  /^--[a-z0-9-_]+/i,                                     // CSS custom property
  /https?:\/\//i,                                         // http / https URL
  /^file:\/\//i,                                          // file://
  /^data:/i,                                              // data: URI
  /^javascript:/i,                                        // javascript: URI
  /^blob:/i,                                              // blob: URI
  /^[A-Za-z]:[/\\]/,                                     // Windows path: C:\ or C:/
  /^[/\\][^/\\]/,                                         // Unix absolute path: /etc/
  /\.\.[/\\]/,                                            // traversal: ../ or ..\
  /^\.\.$|\/\.\.$|\\\.\.$/,                              // trailing ..
]

// HTML-injection patterns — applied even to display text fields.
const HTML_INJECTION_PATTERNS = [
  /<(script|iframe|img|svg|style)\b/i,
]

function isForbiddenStringValue(str) {
  return FORBIDDEN_VALUE_PATTERNS.some(p => p.test(str))
}

function isHtmlInjection(str) {
  return HTML_INJECTION_PATTERNS.some(p => p.test(str))
}

// ── Asset ID validation ────────────────────────────────────────────────────────

// In Freeform-A only the placeholder resolves; anything else is a soft unknown.
const PLACEHOLDER_DECAL_ID = 'builtin.placeholder.missing'

// Bad chars: path separators, shell-dangerous chars, control chars.
const BAD_ASSET_ID_CHARS = /[/\\<>|"*?\0]/

function validateAssetId(value, nodeId, node, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    node._invalid = true
    errors.push({ nodeId, code: 'BAD_ASSET_ID_FORMAT', message: 'assetId must be a non-empty string' })
    return false
  }
  if (BAD_ASSET_ID_CHARS.test(value) || value.includes('..')) {
    node._invalid = true
    errors.push({ nodeId, code: 'BAD_ASSET_ID_FORMAT', message: `assetId contains invalid characters: "${value}"` })
    return false
  }
  if (!value.startsWith('builtin.') && !value.startsWith('user.imported.')) {
    node._invalid = true
    errors.push({ nodeId, code: 'BAD_ASSET_ID_FORMAT', message: `assetId must start with "builtin." or "user.imported.": "${value}"` })
    return false
  }
  return true
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function validate(layoutDoc, manifest) {
  if (!layoutDoc || typeof layoutDoc !== 'object') {
    return { ok: false, errors: [{ code: 'BAD_INPUT', message: 'Layout document is not an object' }] }
  }

  // Size check (stringify once for both size and deep-clone)
  let raw
  try {
    raw = JSON.stringify(layoutDoc)
  } catch {
    return { ok: false, errors: [{ code: 'NOT_SERIALISABLE', message: 'Layout document cannot be serialised to JSON' }] }
  }
  if (raw.length > MAX_DOC_BYTES) {
    return { ok: false, errors: [{ code: 'DOC_TOO_LARGE', message: `Layout exceeds ${MAX_DOC_BYTES / 1024} KB (${raw.length} bytes)` }] }
  }

  // Hard: schemaVersion
  if (!Number.isInteger(layoutDoc.schemaVersion) || layoutDoc.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [{ code: 'BAD_SCHEMA_VERSION', message: `Unsupported schemaVersion: ${layoutDoc.schemaVersion} (expected ${SCHEMA_VERSION})` }],
    }
  }

  // Hard: pluginId match
  if (!layoutDoc.pluginId || typeof layoutDoc.pluginId !== 'string') {
    return { ok: false, errors: [{ code: 'MISSING_PLUGIN_ID', message: 'pluginId is required' }] }
  }
  if (manifest && layoutDoc.pluginId !== manifest.pluginId) {
    return {
      ok: false,
      errors: [{ code: 'PLUGIN_ID_MISMATCH', message: `pluginId "${layoutDoc.pluginId}" does not match expected "${manifest.pluginId}"` }],
    }
  }

  // Hard: root must exist and be type 'panel'
  if (!layoutDoc.root || typeof layoutDoc.root !== 'object') {
    return { ok: false, errors: [{ code: 'MISSING_ROOT', message: 'root node is required' }] }
  }
  if (layoutDoc.root.type !== 'panel') {
    return { ok: false, errors: [{ code: 'BAD_ROOT_TYPE', message: `root must be type "panel", got "${layoutDoc.root.type}"` }] }
  }

  // Deep clone to allow safe mutation (annotating _invalid, stripping bad style keys)
  const doc = JSON.parse(raw)

  const errors = []
  const seenIds = new Set()

  walkNode(doc.root, seenIds, errors, manifest, null)

  // Duplicate-id check is hard: if any id collision was found, fail the whole doc
  const dupeErrors = errors.filter(e => e.code === 'DUPLICATE_ID')
  if (dupeErrors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, doc, errors }
}

// ── Recursive walker ──────────────────────────────────────────────────────────

function walkNode(node, seenIds, errors, manifest, parentNode) {
  if (!node || typeof node !== 'object') return

  // id
  if (!node.id || typeof node.id !== 'string' || node.id.trim() === '') {
    node._invalid = true
    errors.push({ code: 'MISSING_ID', message: 'Node is missing a valid "id" field' })
    return
  }
  if (seenIds.has(node.id)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'DUPLICATE_ID', message: `Duplicate node id: "${node.id}"` })
    return
  }
  seenIds.add(node.id)

  // type
  if (!node.type || typeof node.type !== 'string') {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'MISSING_TYPE', message: 'Node is missing "type"' })
    return
  }
  if (!ALLOWED_TYPES.has(node.type)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'UNKNOWN_TYPE', message: `Unknown node type: "${node.type}"` })
    return
  }

  const isFreeformChild  = parentNode?.type === 'freeformLayer'
  const isFreeformLayer  = node.type === 'freeformLayer'
  const isDecorLeaf      = DECOR_LEAF_TYPES.has(node.type)
  const isFlowContainer  = CONTAINER_TYPES.has(node.type)

  // Decor leaves are only valid inside freeformLayer.
  if (isDecorLeaf && !isFreeformChild) {
    node._invalid = true
    errors.push({
      nodeId: node.id,
      code: 'DECOR_NOT_IN_FREEFORM',
      message: `"${node.type}" can only be a direct child of freeformLayer`,
    })
    return
  }

  // Containers (and nested freeformLayers) cannot be inside freeformLayer.
  if (isFreeformChild && (isFlowContainer || isFreeformLayer)) {
    node._invalid = true
    errors.push({
      nodeId: node.id,
      code: 'CONTAINER_IN_FREEFORM',
      message: `Container type "${node.type}" is not allowed inside a freeformLayer`,
    })
    return
  }

  // Style: strip unknown keys (soft), validate value shapes (same for all types)
  if (node.style && typeof node.style === 'object') {
    for (const key of Object.keys(node.style)) {
      if (!ALLOWED_STYLE_KEYS.has(key)) {
        errors.push({ nodeId: node.id, code: 'UNKNOWN_STYLE_KEY', message: `Stripped unknown style key: "${key}"` })
        delete node.style[key]
      }
    }
    if (node.style.align !== undefined && !ALLOWED_ALIGN.has(node.style.align)) {
      errors.push({ nodeId: node.id, code: 'BAD_STYLE_ALIGN', message: `Invalid align value: "${node.style.align}"` })
      delete node.style.align
    }
    if (node.style.justify !== undefined && !ALLOWED_JUSTIFY.has(node.style.justify)) {
      errors.push({ nodeId: node.id, code: 'BAD_STYLE_JUSTIFY', message: `Invalid justify value: "${node.style.justify}"` })
      delete node.style.justify
    }
  }

  // Frame: required on freeform children, forbidden elsewhere.
  if (isFreeformChild) {
    validateFrame(node, errors)
    scanForbiddenProps(node, errors)
  } else if (node.props?.frame !== undefined) {
    node._invalid = true
    errors.push({
      nodeId: node.id,
      code: 'FRAME_NOT_ALLOWED',
      message: 'props.frame is only valid for direct children of freeformLayer',
    })
  }

  // Props validation (soft — marks node _invalid but continues)
  validateNodeProps(node, errors, manifest)

  // Recurse into children
  const isContainer = isFlowContainer || isFreeformLayer
  if (isContainer && Array.isArray(node.children)) {
    for (const child of node.children) {
      walkNode(child, seenIds, errors, manifest, node)
    }
  } else if (!isContainer && node.children) {
    errors.push({ nodeId: node.id, code: 'LEAF_HAS_CHILDREN', message: `Leaf node "${node.type}" should not have children` })
    delete node.children
  }
}

// ── Frame validation ──────────────────────────────────────────────────────────

function validateFrame(node, errors) {
  const frame = node.props?.frame

  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'MISSING_FRAME', message: 'Freeform layer children require props.frame' })
    return
  }

  // Check for forbidden keys in frame before anything else.
  for (const key of Object.keys(frame)) {
    if (isForbiddenKey(key)) {
      node._invalid = true
      errors.push({ nodeId: node.id, code: 'FORBIDDEN_FRAME_KEY', key, message: `Forbidden key in frame: "${key}"` })
      return
    }
  }

  // x
  if (!isFiniteInteger(frame.x)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'x', message: 'frame.x must be a finite integer' })
    return
  }
  if (frame.x < FRAME_XY_MIN || frame.x > FRAME_XY_MAX) {
    errors.push({ nodeId: node.id, code: 'FRAME_OUT_OF_BOUNDS', key: 'x', message: `frame.x clamped to [${FRAME_XY_MIN}, ${FRAME_XY_MAX}]` })
    frame.x = Math.max(FRAME_XY_MIN, Math.min(FRAME_XY_MAX, frame.x))
  }

  // y
  if (!isFiniteInteger(frame.y)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'y', message: 'frame.y must be a finite integer' })
    return
  }
  if (frame.y < FRAME_XY_MIN || frame.y > FRAME_XY_MAX) {
    errors.push({ nodeId: node.id, code: 'FRAME_OUT_OF_BOUNDS', key: 'y', message: `frame.y clamped to [${FRAME_XY_MIN}, ${FRAME_XY_MAX}]` })
    frame.y = Math.max(FRAME_XY_MIN, Math.min(FRAME_XY_MAX, frame.y))
  }

  // widthPx — hard reject if ≤ 0
  if (!isFiniteInteger(frame.widthPx)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'widthPx', message: 'frame.widthPx must be a finite integer' })
    return
  }
  if (frame.widthPx <= 0) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_SIZE', key: 'widthPx', message: 'frame.widthPx must be > 0' })
    return
  }
  if (frame.widthPx > FRAME_WH_MAX) {
    errors.push({ nodeId: node.id, code: 'FRAME_OUT_OF_BOUNDS', key: 'widthPx', message: `frame.widthPx clamped to ${FRAME_WH_MAX}` })
    frame.widthPx = FRAME_WH_MAX
  }

  // heightPx — hard reject if ≤ 0
  if (!isFiniteInteger(frame.heightPx)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'heightPx', message: 'frame.heightPx must be a finite integer' })
    return
  }
  if (frame.heightPx <= 0) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_SIZE', key: 'heightPx', message: 'frame.heightPx must be > 0' })
    return
  }
  if (frame.heightPx > FRAME_WH_MAX) {
    errors.push({ nodeId: node.id, code: 'FRAME_OUT_OF_BOUNDS', key: 'heightPx', message: `frame.heightPx clamped to ${FRAME_WH_MAX}` })
    frame.heightPx = FRAME_WH_MAX
  }

  // rotationDeg (optional)
  if (frame.rotationDeg !== undefined) {
    if (!isFiniteInteger(frame.rotationDeg)) {
      errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'rotationDeg', message: 'frame.rotationDeg must be a finite integer' })
      delete frame.rotationDeg
    } else if (!ROTATION_SUPPORTED_TYPES.has(node.type)) {
      errors.push({ nodeId: node.id, code: 'ROTATION_NOT_SUPPORTED', key: 'rotationDeg', message: `rotationDeg not supported on "${node.type}"; clamped to 0` })
      frame.rotationDeg = 0
    } else if (frame.rotationDeg < FRAME_ROT_MIN || frame.rotationDeg > FRAME_ROT_MAX) {
      errors.push({ nodeId: node.id, code: 'FRAME_OUT_OF_BOUNDS', key: 'rotationDeg', message: `frame.rotationDeg clamped to [${FRAME_ROT_MIN}, ${FRAME_ROT_MAX}]` })
      frame.rotationDeg = Math.max(FRAME_ROT_MIN, Math.min(FRAME_ROT_MAX, frame.rotationDeg))
    }
  }

  // zIndex (optional)
  if (frame.zIndex !== undefined) {
    if (!isFiniteInteger(frame.zIndex)) {
      errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'zIndex', message: 'frame.zIndex must be a finite integer' })
      delete frame.zIndex
    } else if (frame.zIndex < FRAME_ZIDX_MIN || frame.zIndex > FRAME_ZIDX_MAX) {
      errors.push({ nodeId: node.id, code: 'FRAME_OUT_OF_BOUNDS', key: 'zIndex', message: `frame.zIndex clamped to [${FRAME_ZIDX_MIN}, ${FRAME_ZIDX_MAX}]` })
      frame.zIndex = Math.max(FRAME_ZIDX_MIN, Math.min(FRAME_ZIDX_MAX, frame.zIndex))
    }
  }

  // locked (optional)
  if (frame.locked !== undefined && typeof frame.locked !== 'boolean') {
    errors.push({ nodeId: node.id, code: 'BAD_FRAME_VALUE', key: 'locked', message: 'frame.locked must be a boolean' })
    delete frame.locked
  }

  // Strip unknown frame keys
  for (const key of Object.keys(frame)) {
    if (!KNOWN_FRAME_KEYS.has(key)) {
      errors.push({ nodeId: node.id, code: 'UNKNOWN_FRAME_KEY', message: `Unknown frame key stripped: "${key}"` })
      delete frame[key]
    }
  }
}

// ── Forbidden props/value scanner ─────────────────────────────────────────────

function scanForbiddenProps(node, errors) {
  const p = node.props || {}

  // Check for forbidden keys (skip 'frame'; handled by validateFrame).
  for (const key of Object.keys(p)) {
    if (key === 'frame') continue
    if (isForbiddenKey(key)) {
      node._invalid = true
      errors.push({ nodeId: node.id, code: 'FORBIDDEN_PROPS_KEY', key, message: `Forbidden props key: "${key}"` })
      return
    }
  }

  // Check string values for forbidden content.
  for (const [key, value] of Object.entries(p)) {
    if (key === 'frame') continue
    if (typeof value !== 'string') continue

    if (key === 'text') {
      // Display text: only check HTML injection.
      if (isHtmlInjection(value)) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'FORBIDDEN_PROPS_VALUE', key, message: 'HTML markup is not allowed in props.text' })
        return
      }
    } else {
      if (isForbiddenStringValue(value)) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'FORBIDDEN_PROPS_VALUE', key, message: `Forbidden string value in props.${key}` })
        return
      }
    }
  }
}

// ── Per-type prop validation ──────────────────────────────────────────────────

function validateNodeProps(node, errors, manifest) {
  const p = node.props || {}

  switch (node.type) {
    case 'knob': {
      if (p.color !== undefined) {
        node._invalid = true
        errors.push({
          nodeId: node.id,
          code: 'PLUGIN_KNOB_COLOR_FORBIDDEN',
          key: 'color',
          message: 'Plugin UI knob props.color is forbidden; use props.appearance.accentToken',
        })
      }
      if (!p.param || typeof p.param !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_PARAM', message: 'knob requires props.param' })
        break
      }
      if (manifest && !manifest.params[p.param]) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'UNKNOWN_PARAM', message: `Unknown param "${p.param}" for plugin "${manifest.pluginId}"` })
      }
      break
    }

    case 'toggle': {
      if (!p.param || typeof p.param !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_PARAM', message: 'toggle requires props.param' })
        break
      }
      if (!p.mode || !['boolParam', 'discreteValue'].includes(p.mode)) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'BAD_TOGGLE_MODE', message: `toggle.mode must be "boolParam" or "discreteValue", got "${p.mode}"` })
        break
      }
      if (p.mode === 'discreteValue' && typeof p.valueWhenOn !== 'number') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_VALUE_WHEN_ON', message: 'discreteValue toggle requires props.valueWhenOn (number)' })
      }
      if (manifest && !manifest.params[p.param]) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'UNKNOWN_PARAM', message: `Unknown param "${p.param}" for plugin "${manifest.pluginId}"` })
      }
      break
    }

    case 'button': {
      if (!p.action || typeof p.action !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_ACTION', message: 'button requires props.action' })
      }
      if (!p.label || typeof p.label !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_LABEL', message: 'button requires props.label' })
      }
      break
    }

    case 'meter': {
      if (!p.source || typeof p.source !== 'object') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_SOURCE', message: 'meter requires props.source object' })
        break
      }
      if (p.source.kind !== 'effectMeter') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'UNKNOWN_SOURCE_KIND', message: `Unknown meter source kind: "${p.source.kind}"` })
        break
      }
      if (!p.source.slot || typeof p.source.slot !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_SLOT', message: 'meter source requires a slot name' })
        break
      }
      if (!VALID_METER_SLOT_NAMES.has(p.source.slot)) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'UNKNOWN_SLOT', message: `Unknown meter slot: "${p.source.slot}". Valid: ${[...VALID_METER_SLOT_NAMES].join(', ')}` })
        break
      }
      if (manifest && !manifest.meterSlots.includes(p.source.slot)) {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'SLOT_NOT_IN_MANIFEST', message: `Slot "${p.source.slot}" is not exposed by plugin "${manifest.pluginId}"` })
      }
      if (!p.range || typeof p.range !== 'object' || typeof p.range.min !== 'number' || typeof p.range.max !== 'number') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'BAD_RANGE', message: 'meter requires props.range with numeric min and max' })
      }
      break
    }

    case 'visualizer': {
      if (!p.source || typeof p.source !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_SOURCE', message: 'visualizer requires props.source (string)' })
        break
      }
      if (manifest && !manifest.vizSources.includes(p.source)) {
        node._vizUnavailable = true
        errors.push({ nodeId: node.id, code: 'UNKNOWN_VIZ_SOURCE', message: `Unknown viz source "${p.source}" for plugin "${manifest.pluginId}"` })
      }
      if (!p.preset || typeof p.preset !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_PRESET', message: 'visualizer requires props.preset' })
      }
      break
    }

    case 'label': {
      if (typeof p.text !== 'string') {
        node._invalid = true
        errors.push({ nodeId: node.id, code: 'MISSING_TEXT', message: 'label requires props.text (string)' })
      }
      break
    }

    // ── Freeform layer ──────────────────────────────────────────────────────
    case 'freeformLayer':
      validateFreeformLayerProps(node, errors)
      break

    // ── Decoration leaves ───────────────────────────────────────────────────
    case 'decorText':
      validateDecorTextProps(node, errors)
      break

    case 'decorLine':
      validateDecorLineProps(node, errors)
      break

    case 'decorShape':
      validateDecorShapeProps(node, errors)
      break

    case 'decal':
      validateDecalProps(node, errors)
      break

    default:
      break
  }

  validateAppearance(node, errors)
}

// ── freeformLayer prop validation ─────────────────────────────────────────────

function validateFreeformLayerProps(node, errors) {
  const p = node.props
  if (!p || typeof p !== 'object') return

  // Check for forbidden keys on the layer itself.
  for (const key of Object.keys(p)) {
    if (key === 'snap' || key === 'background' || key === 'clip') continue
    if (isForbiddenKey(key)) {
      node._invalid = true
      errors.push({ nodeId: node.id, code: 'FORBIDDEN_PROPS_KEY', key, message: `Forbidden key in freeformLayer props: "${key}"` })
      return
    }
    // Unknown but harmless — soft strip.
    errors.push({ nodeId: node.id, code: 'UNKNOWN_FREEFORM_PROP', message: `Unknown freeformLayer prop stripped: "${key}"` })
    delete p[key]
  }

  if (p.snap !== undefined) {
    if (!p.snap || typeof p.snap !== 'object' || Array.isArray(p.snap)) {
      errors.push({ nodeId: node.id, code: 'BAD_FREEFORM_SNAP', message: 'freeformLayer props.snap must be a plain object' })
      delete p.snap
    } else {
      if (p.snap.gridPx !== undefined && !VALID_SNAP_GRID.has(p.snap.gridPx)) {
        errors.push({ nodeId: node.id, code: 'UNKNOWN_SNAP_GRID', message: `Invalid snap.gridPx value: ${p.snap.gridPx}; using default 8` })
        p.snap.gridPx = 8
      }
      if (p.snap.enabled !== undefined && typeof p.snap.enabled !== 'boolean') {
        errors.push({ nodeId: node.id, code: 'BAD_SNAP_ENABLED', message: 'snap.enabled must be a boolean' })
        p.snap.enabled = true
      }
    }
  }

  if (p.background !== undefined && !VALID_FREEFORM_BG.has(p.background)) {
    errors.push({ nodeId: node.id, code: 'UNKNOWN_FREEFORM_BG', message: `Unknown freeformLayer background "${p.background}"; using "transparent"` })
    p.background = 'transparent'
  }

  if (p.clip !== undefined && !VALID_FREEFORM_CLIP.has(p.clip)) {
    errors.push({ nodeId: node.id, code: 'UNKNOWN_FREEFORM_CLIP', message: `Unknown freeformLayer clip "${p.clip}"; using "panel"` })
    p.clip = 'panel'
  }
}

// ── decorText prop validation ─────────────────────────────────────────────────

function validateDecorTextProps(node, errors) {
  if (node._invalid) return  // frame already failed hard
  const p = node.props || {}

  if (typeof p.text !== 'string') {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'MISSING_TEXT', message: 'decorText requires props.text (string)' })
    return
  }
  if (p.text.length > 80) {
    errors.push({ nodeId: node.id, code: 'TEXT_TOO_LONG', message: `decorText props.text exceeds 80 characters; truncated` })
    p.text = p.text.slice(0, 80)
  }

  if (p.variant !== undefined) {
    validateDecorEnum(node, 'variant', p.variant, DECOR_TEXT_VARIANTS, errors, 'default')
  }
  if (p.align !== undefined) {
    validateDecorEnum(node, 'align', p.align, DECOR_TEXT_ALIGNS, errors, 'left')
  }
  if (p.letterSpacing !== undefined) {
    validateDecorEnum(node, 'letterSpacing', p.letterSpacing, DECOR_TEXT_LS, errors, 'normal')
  }
  if (p.textToken !== undefined) {
    validateDecorToken(node, 'textToken', p.textToken, 'text', errors, 'text.primary')
  }
}

// ── decorLine prop validation ─────────────────────────────────────────────────

function validateDecorLineProps(node, errors) {
  if (node._invalid) return
  const p = node.props || {}

  if (!p.orientation || !DECOR_LINE_ORIENTATIONS.includes(p.orientation)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'MISSING_ORIENTATION', message: `decorLine requires props.orientation ("horizontal" or "vertical")` })
    return
  }

  if (p.thickness !== undefined) {
    validateDecorEnum(node, 'thickness', p.thickness, DECOR_LINE_THICKNESSES, errors, 'hair')
  }
  if (p.lineStyle !== undefined) {
    validateDecorEnum(node, 'lineStyle', p.lineStyle, DECOR_LINE_STYLES, errors, 'solid')
  }
  if (p.strokeToken !== undefined) {
    validateDecorToken(node, 'strokeToken', p.strokeToken, 'stroke', errors, 'text.subtle')
  }
}

// ── decorShape prop validation ────────────────────────────────────────────────

function validateDecorShapeProps(node, errors) {
  if (node._invalid) return
  const p = node.props || {}

  if (!p.shape || !DECOR_SHAPE_SHAPES.includes(p.shape)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'MISSING_SHAPE', message: `decorShape requires props.shape ("rect", "roundedRect", "circle", "pill")` })
    return
  }

  if (p.cornerRadius !== undefined) {
    validateDecorIntEnum(node, 'cornerRadius', p.cornerRadius, DECOR_SHAPE_RADII, errors, 4)
  }
  if (p.strokeWidth !== undefined) {
    validateDecorIntEnum(node, 'strokeWidth', p.strokeWidth, DECOR_STROKE_WIDTHS, errors, 0)
  }
  if (p.opacity !== undefined) {
    validateDecorIntEnum(node, 'opacity', p.opacity, DECOR_OPACITIES, errors, 100)
  }
  if (p.fillToken !== undefined) {
    validateDecorToken(node, 'fillToken', p.fillToken, 'fill', errors, 'fill.none')
  }
  if (p.strokeToken !== undefined) {
    validateDecorToken(node, 'strokeToken', p.strokeToken, 'stroke', errors, 'stroke.none')
  }
}

// ── decal prop validation ─────────────────────────────────────────────────────

function validateDecalProps(node, errors) {
  if (node._invalid) return
  const p = node.props || {}

  // assetId is required.
  if (p.assetId === undefined) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'MISSING_ASSET_ID', message: 'decal requires props.assetId' })
    return
  }

  const formatOk = validateAssetId(p.assetId, node.id, node, errors)
  if (!formatOk) return

  // user.imported.* IDs are runtime-resolved via the asset registry — store as-is.
  // Only reset unrecognised builtin.* IDs to the placeholder.
  if (p.assetId.startsWith('builtin.') && p.assetId !== PLACEHOLDER_DECAL_ID) {
    errors.push({ nodeId: node.id, code: 'UNKNOWN_DECAL_ASSET', message: `Unknown builtin decal asset "${p.assetId}"; rendering placeholder` })
    p.assetId = PLACEHOLDER_DECAL_ID
  }

  if (p.fit !== undefined) {
    validateDecorEnum(node, 'fit', p.fit, DECAL_FITS, errors, 'contain')
  }
  if (p.opacity !== undefined) {
    validateDecorIntEnum(node, 'opacity', p.opacity, DECOR_OPACITIES, errors, 100)
  }
  if (p.tintToken !== undefined) {
    validateDecorToken(node, 'tintToken', p.tintToken, 'tint', errors, 'tint.none')
  }
}

// ── Decor validation helpers ──────────────────────────────────────────────────

function validateDecorEnum(node, key, value, allowedValues, errors, fallbackValue) {
  if (!allowedValues.includes(value)) {
    errors.push({
      nodeId: node.id,
      code: 'UNKNOWN_DECOR_ENUM',
      key,
      message: `Unknown value "${value}" for props.${key}; using "${fallbackValue}"`,
    })
    if (fallbackValue !== undefined && node.props) {
      node.props[key] = fallbackValue
    }
  }
}

function validateDecorIntEnum(node, key, value, allowedValues, errors, fallbackValue) {
  if (typeof value !== 'number' || !allowedValues.includes(value)) {
    errors.push({
      nodeId: node.id,
      code: 'UNKNOWN_DECOR_ENUM',
      key,
      message: `Invalid value for props.${key}: ${value}; using ${fallbackValue}`,
    })
    if (fallbackValue !== undefined && node.props) {
      node.props[key] = fallbackValue
    }
  }
}

function validateDecorToken(node, key, value, slotGroupName, errors, fallbackTokenId) {
  if (typeof value !== 'string') {
    errors.push({
      nodeId: node.id,
      code: 'BAD_DECOR_TOKEN',
      key,
      message: `props.${key} must be a string token id`,
    })
    if (fallbackTokenId !== undefined && node.props) node.props[key] = fallbackTokenId
    return
  }

  // Check for escape attempts in the token value.
  if (isForbiddenStringValue(value)) {
    node._invalid = true
    errors.push({ nodeId: node.id, code: 'FORBIDDEN_PROPS_VALUE', key, message: `Forbidden value in props.${key}` })
    return
  }

  if (!isTokenInSlotGroup(value, slotGroupName)) {
    errors.push({
      nodeId: node.id,
      code: 'UNKNOWN_DECOR_TOKEN',
      key,
      message: `Unknown or invalid token "${value}" for props.${key}; using fallback`,
    })
    if (fallbackTokenId !== undefined && node.props) node.props[key] = fallbackTokenId
  }
}

// ── Appearance validation (existing, unchanged) ───────────────────────────────

function validateAppearance(node, errors) {
  const p = node.props || {}
  if (p.appearance === undefined) return

  if (!isPlainObject(p.appearance)) {
    node._invalid = true
    errors.push({
      nodeId: node.id,
      code: 'BAD_APPEARANCE',
      message: 'props.appearance must be a plain object',
    })
    return
  }

  const rules = getAppearanceRulesForType(node.type)
  if (!rules) {
    errors.push({
      nodeId: node.id,
      code: 'APPEARANCE_NOT_SUPPORTED',
      message: `Appearance is not supported on node type "${node.type}"`,
    })
    delete p.appearance
    return
  }

  for (const key of Object.keys(p.appearance)) {
    const value = p.appearance[key]
    const result = validateAppearanceValue(node.type, key, value)
    if (result.ok) continue

    const message = result.message || `Invalid appearance value for "${key}"`
    errors.push({
      nodeId: node.id,
      code: result.code,
      key,
      value,
      message,
    })

    if (result.code === 'RAW_APPEARANCE_VALUE' || result.code === 'APPEARANCE_ESCAPE_KEY') {
      node._invalid = true
      continue
    }

    if (result.fallback !== undefined) {
      p.appearance[key] = result.fallback
    } else {
      delete p.appearance[key]
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isFiniteInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function isPlainObject(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

// Pure layout document validator.
// Returns { ok: true, doc, errors } for hard-passable documents (soft node errors included in errors[]).
// Returns { ok: false, errors } when the whole layout must be rejected.
// Soft errors annotate individual nodes with _invalid: true; the renderer shows per-node placeholders.

import * as METER_SLOTS from '../../constants/meterSlots.js'

const SCHEMA_VERSION = 1

const ALLOWED_TYPES = new Set([
  'panel', 'group', 'row', 'column', 'tabGroup',
  'knob', 'toggle', 'button', 'meter', 'visualizer', 'label', 'spacer',
])

const CONTAINER_TYPES = new Set(['panel', 'group', 'row', 'column', 'tabGroup'])

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

  walkNode(doc.root, seenIds, errors, manifest)

  // Duplicate-id check is hard: if any id collision was found, fail the whole doc
  // (we already annotated nodes, but a collision means layout identity is broken)
  const dupeErrors = errors.filter(e => e.code === 'DUPLICATE_ID')
  if (dupeErrors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, doc, errors }
}

// ── Recursive walker ──────────────────────────────────────────────────────────

function walkNode(node, seenIds, errors, manifest) {
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

  // style: strip unknown keys (soft), validate value shapes
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

  // Props validation (soft — marks node _invalid but continues)
  validateNodeProps(node, errors, manifest)

  // Recurse into children (container types only)
  if (CONTAINER_TYPES.has(node.type) && Array.isArray(node.children)) {
    for (const child of node.children) {
      walkNode(child, seenIds, errors, manifest)
    }
  } else if (!CONTAINER_TYPES.has(node.type) && node.children) {
    errors.push({ nodeId: node.id, code: 'LEAF_HAS_CHILDREN', message: `Leaf node "${node.type}" should not have children` })
    delete node.children
  }
}

// ── Per-type prop validation ──────────────────────────────────────────────────

function validateNodeProps(node, errors, manifest) {
  const p = node.props || {}

  switch (node.type) {
    case 'knob': {
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
        // Soft: unknown viz source → node renders placeholder, rest of layout works
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

    // Container types and spacer have no required props
    default:
      break
  }
}

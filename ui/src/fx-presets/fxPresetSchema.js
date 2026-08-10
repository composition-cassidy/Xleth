// Stock-effect preset validator.
//
// Mirrors the shape and spirit of ui/src/plugin-ui/schema/validate.js:
//   • returns { ok: true, preset, errors:[] } for an acceptable document
//   • returns { ok: false, errors:[{ code, message }] } when it must be rejected
// so callers can render a structured, visible error rather than silently
// applying a bad preset.
//
// The preset envelope is:
//   { xlethFxPreset: 1, effectType, name, author?, created, state }
// `state` is the opaque engine-state blob captured through the bridge — this
// validator checks it is a non-empty object but never interprets its contents
// (that is the effect adapter's job). The one hard, always-checked rule when an
// expected effectType is supplied is the mismatch guard: a preset for effect A
// is refused for effect B, never silently applied to the wrong effect.

export const PRESET_MAGIC = 'xlethFxPreset'
export const PRESET_VERSION = 1

const MAX_NAME_LEN = 80
const MAX_AUTHOR_LEN = 80

function fail(code, message) {
  return { ok: false, errors: [{ code, message }] }
}

// `expectedEffectType` (optional) turns on the mismatch guard. Pass it whenever
// you are validating a preset you intend to apply to a specific open effect.
export function validatePreset(doc, expectedEffectType = null) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return fail('BAD_INPUT', 'Preset is not a JSON object')
  }

  if (doc[PRESET_MAGIC] !== PRESET_VERSION) {
    return fail(
      'BAD_MAGIC',
      `Not an XLETH FX preset (expected ${PRESET_MAGIC}: ${PRESET_VERSION}, got ${doc[PRESET_MAGIC]})`
    )
  }

  if (typeof doc.effectType !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(doc.effectType)) {
    return fail('BAD_EFFECT_TYPE', 'Preset has a missing or invalid effectType')
  }

  // Hard mismatch guard — the whole reason this validator refuses, not warns.
  if (expectedEffectType != null && doc.effectType !== expectedEffectType) {
    return fail(
      'EFFECT_TYPE_MISMATCH',
      `This preset is for "${doc.effectType}", not "${expectedEffectType}".`
    )
  }

  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) {
    return fail('MISSING_NAME', 'Preset requires a non-empty name')
  }
  if (doc.name.length > MAX_NAME_LEN) {
    return fail('NAME_TOO_LONG', `Preset name exceeds ${MAX_NAME_LEN} characters`)
  }

  if (doc.author !== undefined
    && (typeof doc.author !== 'string' || doc.author.length > MAX_AUTHOR_LEN)) {
    return fail('BAD_AUTHOR', 'Preset author must be a short string')
  }

  if (doc.created !== undefined && typeof doc.created !== 'string') {
    return fail('BAD_CREATED', 'Preset created timestamp must be an ISO-8601 string')
  }

  if (!doc.state || typeof doc.state !== 'object' || Array.isArray(doc.state)) {
    return fail('MISSING_STATE', 'Preset requires a state object')
  }
  if (Object.keys(doc.state).length === 0) {
    return fail('EMPTY_STATE', 'Preset state object is empty')
  }

  return { ok: true, preset: doc, errors: [] }
}

// Build a fresh, well-formed preset envelope around a captured state blob.
export function buildPreset(effectType, name, state, author) {
  return {
    [PRESET_MAGIC]: PRESET_VERSION,
    effectType,
    name,
    ...(author ? { author } : {}),
    created: new Date().toISOString(),
    state,
  }
}

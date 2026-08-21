export const CLIP_CONTROL_SPEC_VERSION = 1
export const CLIP_CONTROL_DEFAULTS_REVISION = '2026-07-15.2'
export const CLIP_GAIN_MAX_VELOCITY = 2
export const CLIP_GAIN_MAX_DB = 20 * Math.log10(CLIP_GAIN_MAX_VELOCITY)

const defaults = {
  eligibility: {
    minWidth: 42,
    minHeight: 30,
  },
  visibility: {
    gainLine: 'always',
    handles: 'selected-hover-active',
    fadeOverlay: 'when-set',
  },
  gain: {
    topInset: 18,
    bottomInset: 12,
    minTravel: 8,
    unityPosition: 0.5,
    lineWidth: 2,
    pillWidth: 34,
    pillHeight: 16,
    pillRadius: 7,
    glyphCount: 5,
    glyphStartX: 9,
    glyphSpacing: 4,
    glyphTopInset: 5,
    glyphBottomInset: 5,
    glyphAlternation: 1,
    glyphLineWidth: 2,
    edgeRailWidth: 3,
    edgeRailInsetY: 1,
  },
  fade: {
    wedgeMinWidth: 12,
    wedgeMaxWidth: 24,
    wedgeWidthRatio: 0.45,
    wedgeMaxHeight: 18,
    wedgeHeightRatio: 0.36,
    overlayPixelsPerStep: 2,
    overlayMinSteps: 8,
    overlayMaxSteps: 64,
    overlayAlpha: 1,
  },
  appearance: {
    accentMixToWhite: 0.42,
    darkMixToBlack: 0.70,
    fadeIdleAlpha: 0.88,
    fadeHoverAlpha: 0.94,
    fadeSelectedAlpha: 0.96,
    fadeActiveAlpha: 1,
    fadeStrokeAlpha: 0.34,
    fadeStrokeWidth: 1,
    fadeIdleShadowBlur: 4,
    fadeHoverShadowBlur: 6,
    fadeSelectedShadowBlur: 5,
    fadeActiveShadowBlur: 8,
    railIdleAlpha: 0.80,
    railHoverAlpha: 0.90,
    railSelectedAlpha: 0.95,
    railActiveAlpha: 1,
    railIdleShadowBlur: 3,
    railHoverShadowBlur: 4,
    railSelectedShadowBlur: 5,
    railActiveShadowBlur: 7,
    lineIdleAlpha: 0.34,
    lineHoverAlpha: 0.58,
    lineSelectedAlpha: 0.72,
    lineActiveAlpha: 0.92,
    lineIdleShadowBlur: 1,
    lineHoverShadowBlur: 2,
    lineSelectedShadowBlur: 3,
    lineActiveShadowBlur: 7,
    pillIdleMixToWhite: 0.45,
    pillHoverMixToWhite: 0.50,
    pillSelectedMixToWhite: 0.54,
    pillActiveMixToWhite: 0.58,
    pillStrokeAlpha: 0.45,
    pillStrokeWidth: 1,
    pillIdleShadowBlur: 4,
    pillHoverShadowBlur: 6,
    pillSelectedShadowBlur: 5,
    pillActiveShadowBlur: 9,
    unityShadowAlpha: 0.78,
    glyphAlpha: 0.82,
  },
  interaction: {
    outerSlop: 6,
    gainHitSlopX: 6,
    gainHitSlopY: 7,
    fadeHitHeight: 24,
    fadeHandleHalfWidth: 24,
    fadeExtraSlop: 6,
    gainDbPerPixel: 0.25,
    fineMultiplier: 0.1,
    unitySnapDb: 0.35,
    muteFloorDb: -60,
  },
  tooltip: {
    offsetX: 12,
    offsetY: -28,
    gainDecimals: 1,
    fadeDecimals: 1,
  },
  debug: {
    showPaintBounds: false,
    showHitRegions: false,
    showAnchors: false,
  },
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export const CLIP_CONTROL_DEFAULTS = deepFreeze(defaults)
const NORMALIZED_SPECS = new WeakSet([CLIP_CONTROL_DEFAULTS])

export const CLIP_CONTROL_TUNABLE_FIELDS = deepFreeze([
  { group: 'Eligibility', path: 'eligibility.minWidth', label: 'Minimum width', min: 24, max: 160, step: 1 },
  { group: 'Eligibility', path: 'eligibility.minHeight', label: 'Minimum height', min: 16, max: 100, step: 1 },
  { group: 'Visibility', path: 'visibility.gainLine', label: 'Gain line', type: 'enum', options: ['always', 'selected-hover-active', 'selected-active'] },
  { group: 'Visibility', path: 'visibility.handles', label: 'Handles', type: 'enum', options: ['always', 'selected-hover-active', 'selected-active'] },
  { group: 'Visibility', path: 'visibility.fadeOverlay', label: 'Fade overlay', type: 'enum', options: ['when-set', 'selected-when-set', 'never'] },

  { group: 'Gain geometry', path: 'gain.topInset', label: 'Top inset', min: 0, max: 60, step: 1 },
  { group: 'Gain geometry', path: 'gain.bottomInset', label: 'Bottom inset', min: 0, max: 60, step: 1 },
  { group: 'Gain geometry', path: 'gain.minTravel', label: 'Minimum travel', min: 1, max: 40, step: 1 },
  { group: 'Gain geometry', path: 'gain.unityPosition', label: 'Unity position', min: 0.05, max: 0.95, step: 0.01 },
  { group: 'Gain geometry', path: 'gain.lineWidth', label: 'Line width', min: 0.5, max: 6, step: 0.25 },
  { group: 'Gain geometry', path: 'gain.pillWidth', label: 'Pill width', min: 12, max: 80, step: 1 },
  { group: 'Gain geometry', path: 'gain.pillHeight', label: 'Pill height', min: 8, max: 40, step: 1 },
  { group: 'Gain geometry', path: 'gain.pillRadius', label: 'Pill radius', min: 0, max: 20, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.glyphCount', label: 'Glyph bars', min: 1, max: 9, step: 1, integer: true },
  { group: 'Gain geometry', path: 'gain.glyphStartX', label: 'Glyph start X', min: 0, max: 30, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.glyphSpacing', label: 'Glyph spacing', min: 1, max: 12, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.glyphTopInset', label: 'Glyph top inset', min: 0, max: 16, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.glyphBottomInset', label: 'Glyph bottom inset', min: 0, max: 16, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.glyphAlternation', label: 'Glyph alternation', min: 0, max: 6, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.glyphLineWidth', label: 'Glyph line width', min: 0.5, max: 5, step: 0.25 },
  { group: 'Gain geometry', path: 'gain.edgeRailWidth', label: 'Edge rail width', min: 0, max: 10, step: 0.5 },
  { group: 'Gain geometry', path: 'gain.edgeRailInsetY', label: 'Edge rail inset', min: 0, max: 12, step: 0.5 },

  { group: 'Fade geometry', path: 'fade.wedgeMinWidth', label: 'Wedge minimum width', min: 2, max: 50, step: 1 },
  { group: 'Fade geometry', path: 'fade.wedgeMaxWidth', label: 'Wedge maximum width', min: 4, max: 80, step: 1 },
  { group: 'Fade geometry', path: 'fade.wedgeWidthRatio', label: 'Wedge width ratio', min: 0.05, max: 1, step: 0.01 },
  { group: 'Fade geometry', path: 'fade.wedgeMaxHeight', label: 'Wedge maximum height', min: 2, max: 60, step: 1 },
  { group: 'Fade geometry', path: 'fade.wedgeHeightRatio', label: 'Wedge height ratio', min: 0.05, max: 1, step: 0.01 },
  { group: 'Fade geometry', path: 'fade.overlayPixelsPerStep', label: 'Overlay pixels/step', min: 0.5, max: 8, step: 0.25 },
  { group: 'Fade geometry', path: 'fade.overlayMinSteps', label: 'Overlay minimum steps', min: 2, max: 64, step: 1, integer: true },
  { group: 'Fade geometry', path: 'fade.overlayMaxSteps', label: 'Overlay maximum steps', min: 8, max: 256, step: 1, integer: true },
  { group: 'Fade geometry', path: 'fade.overlayAlpha', label: 'Overlay opacity', min: 0, max: 1, step: 0.01 },

  { group: 'Colour and depth', path: 'appearance.accentMixToWhite', label: 'Accent white mix', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.darkMixToBlack', label: 'Handle black mix', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.fadeIdleAlpha', label: 'Fade idle opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.fadeHoverAlpha', label: 'Fade hover opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.fadeSelectedAlpha', label: 'Fade selected opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.fadeActiveAlpha', label: 'Fade active opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.fadeStrokeAlpha', label: 'Fade stroke opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.fadeStrokeWidth', label: 'Fade stroke width', min: 0, max: 5, step: 0.25 },
  { group: 'Colour and depth', path: 'appearance.fadeIdleShadowBlur', label: 'Fade idle shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.fadeHoverShadowBlur', label: 'Fade hover shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.fadeSelectedShadowBlur', label: 'Fade selected shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.fadeActiveShadowBlur', label: 'Fade active shadow', min: 0, max: 32, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.railIdleAlpha', label: 'Rail idle opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.railHoverAlpha', label: 'Rail hover opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.railSelectedAlpha', label: 'Rail selected opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.railActiveAlpha', label: 'Rail active opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.railIdleShadowBlur', label: 'Rail idle shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.railHoverShadowBlur', label: 'Rail hover shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.railSelectedShadowBlur', label: 'Rail selected shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.railActiveShadowBlur', label: 'Rail active shadow', min: 0, max: 32, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.lineIdleAlpha', label: 'Line idle opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.lineHoverAlpha', label: 'Line hover opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.lineSelectedAlpha', label: 'Line selected opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.lineActiveAlpha', label: 'Line active opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.lineIdleShadowBlur', label: 'Line idle shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.lineHoverShadowBlur', label: 'Line hover shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.lineSelectedShadowBlur', label: 'Line selected shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.lineActiveShadowBlur', label: 'Line active shadow', min: 0, max: 32, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.pillIdleMixToWhite', label: 'Pill idle white mix', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.pillHoverMixToWhite', label: 'Pill hover white mix', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.pillSelectedMixToWhite', label: 'Pill selected white mix', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.pillActiveMixToWhite', label: 'Pill active white mix', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.pillStrokeAlpha', label: 'Pill stroke opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.pillStrokeWidth', label: 'Pill stroke width', min: 0, max: 5, step: 0.25 },
  { group: 'Colour and depth', path: 'appearance.pillIdleShadowBlur', label: 'Pill idle shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.pillHoverShadowBlur', label: 'Pill hover shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.pillSelectedShadowBlur', label: 'Pill selected shadow', min: 0, max: 24, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.pillActiveShadowBlur', label: 'Pill active shadow', min: 0, max: 32, step: 0.5 },
  { group: 'Colour and depth', path: 'appearance.unityShadowAlpha', label: 'Unity glow opacity', min: 0, max: 1, step: 0.01 },
  { group: 'Colour and depth', path: 'appearance.glyphAlpha', label: 'Glyph opacity', min: 0, max: 1, step: 0.01 },

  { group: 'Interaction', path: 'interaction.outerSlop', label: 'Outer hit slop', min: 0, max: 24, step: 1 },
  { group: 'Interaction', path: 'interaction.gainHitSlopX', label: 'Gain horizontal hit slop', min: 0, max: 30, step: 1 },
  { group: 'Interaction', path: 'interaction.gainHitSlopY', label: 'Gain vertical hit slop', min: 0, max: 30, step: 1 },
  { group: 'Interaction', path: 'interaction.fadeHitHeight', label: 'Fade hit height', min: 4, max: 80, step: 1 },
  { group: 'Interaction', path: 'interaction.fadeHandleHalfWidth', label: 'Fade half hit width', min: 2, max: 60, step: 1 },
  { group: 'Interaction', path: 'interaction.fadeExtraSlop', label: 'Fade extra slop', min: 0, max: 30, step: 1 },
  { group: 'Interaction', path: 'interaction.gainDbPerPixel', label: 'Gain dB/pixel', min: 0.01, max: 2, step: 0.01 },
  { group: 'Interaction', path: 'interaction.fineMultiplier', label: 'Shift fine multiplier', min: 0.01, max: 1, step: 0.01 },
  { group: 'Interaction', path: 'interaction.unitySnapDb', label: 'Unity snap width', min: 0, max: 3, step: 0.05 },
  { group: 'Interaction', path: 'interaction.muteFloorDb', label: 'Mute floor dB', min: -120, max: -24, step: 1 },

  { group: 'Tooltip', path: 'tooltip.offsetX', label: 'Tooltip X offset', min: -80, max: 80, step: 1 },
  { group: 'Tooltip', path: 'tooltip.offsetY', label: 'Tooltip Y offset', min: -80, max: 80, step: 1 },
  { group: 'Tooltip', path: 'tooltip.gainDecimals', label: 'Gain decimals', min: 0, max: 3, step: 1, integer: true },
  { group: 'Tooltip', path: 'tooltip.fadeDecimals', label: 'Fade decimals', min: 0, max: 3, step: 1, integer: true },

  { group: 'Debug', path: 'debug.showPaintBounds', label: 'Show paint bounds', type: 'boolean' },
  { group: 'Debug', path: 'debug.showHitRegions', label: 'Show hit regions', type: 'boolean' },
  { group: 'Debug', path: 'debug.showAnchors', label: 'Show anchors', type: 'boolean' },
])

const FIELD_BY_PATH = new Map(CLIP_CONTROL_TUNABLE_FIELDS.map(field => [field.path, field]))

export function cloneClipControlSpec(spec = CLIP_CONTROL_DEFAULTS) {
  return JSON.parse(JSON.stringify(spec))
}

export function getPathValue(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object)
}

export function setPathValue(object, path, nextValue) {
  const keys = path.split('.')
  const copy = cloneClipControlSpec(object)
  let cursor = copy
  for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]]
  cursor[keys[keys.length - 1]] = nextValue
  return copy
}

function assignPathValue(object, path, nextValue) {
  const keys = path.split('.')
  let cursor = object
  for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]]
  cursor[keys[keys.length - 1]] = nextValue
}

function mergeKnown(base, candidate) {
  const out = cloneClipControlSpec(base)
  if (!candidate || typeof candidate !== 'object') return out
  for (const [key, baseValue] of Object.entries(base)) {
    const incoming = candidate[key]
    if (baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)) {
      out[key] = mergeKnown(baseValue, incoming)
    } else if (incoming !== undefined) {
      out[key] = incoming
    }
  }
  return out
}

export function normalizeClipControlSpec(candidate) {
  if (candidate && typeof candidate === 'object' && NORMALIZED_SPECS.has(candidate)) return candidate
  let out = mergeKnown(CLIP_CONTROL_DEFAULTS, candidate)
  for (const field of CLIP_CONTROL_TUNABLE_FIELDS) {
    const current = getPathValue(out, field.path)
    let normalized
    if (field.type === 'boolean') {
      normalized = Boolean(current)
    } else if (field.type === 'enum') {
      normalized = field.options.includes(current)
        ? current
        : getPathValue(CLIP_CONTROL_DEFAULTS, field.path)
    } else {
      const fallback = getPathValue(CLIP_CONTROL_DEFAULTS, field.path)
      const number = Number(current)
      normalized = Number.isFinite(number) ? number : fallback
      normalized = Math.min(field.max, Math.max(field.min, normalized))
      if (field.integer) normalized = Math.round(normalized)
    }
    assignPathValue(out, field.path, normalized)
  }
  if (out.fade.wedgeMinWidth > out.fade.wedgeMaxWidth) {
    out.fade.wedgeMinWidth = out.fade.wedgeMaxWidth
  }
  if (out.fade.overlayMinSteps > out.fade.overlayMaxSteps) {
    out.fade.overlayMinSteps = out.fade.overlayMaxSteps
  }
  NORMALIZED_SPECS.add(out)
  return out
}

export function clampNumber(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}

export function normalizeClipFades(clip) {
  let fadeInPercent = clampNumber(clip?.fadeInPercent ?? 0, 0, 100)
  let fadeOutPercent = clampNumber(clip?.fadeOutPercent ?? 0, 0, 100)
  const total = fadeInPercent + fadeOutPercent
  if (total > 100) {
    const scale = 100 / total
    fadeInPercent *= scale
    fadeOutPercent *= scale
  }
  return { fadeInPercent, fadeOutPercent }
}

export function velocityToDb(value) {
  const velocity = Number(value)
  if (!Number.isFinite(velocity) || velocity <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(velocity)
}

export function dbToVelocity(db, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const number = Number(db)
  if (!Number.isFinite(number) || number <= normalized.interaction.muteFloorDb) return 0
  return clampNumber(10 ** (number / 20), 0, CLIP_GAIN_MAX_VELOCITY)
}

export function gainLineRatio(velocity, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const db = velocityToDb(velocity)
  const unity = normalized.gain.unityPosition
  if (!Number.isFinite(db)) return 1
  if (db >= 0) {
    const positive = CLIP_GAIN_MAX_DB > 0 ? clampNumber(db / CLIP_GAIN_MAX_DB, 0, 1) : 0
    return unity * (1 - positive)
  }
  const negative = clampNumber(db / normalized.interaction.muteFloorDb, 0, 1)
  return unity + (1 - unity) * negative
}

export function applyGainDrag(startVelocity, deltaY, modifiers = {}, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const startDbRaw = velocityToDb(startVelocity)
  const startDb = Number.isFinite(startDbRaw) ? startDbRaw : normalized.interaction.muteFloorDb
  const multiplier = modifiers.shiftKey ? normalized.interaction.fineMultiplier : 1
  let nextDb = startDb - Number(deltaY || 0) * normalized.interaction.gainDbPerPixel * multiplier
  nextDb = clampNumber(nextDb, normalized.interaction.muteFloorDb, CLIP_GAIN_MAX_DB)
  if (!modifiers.altKey && Math.abs(nextDb) <= normalized.interaction.unitySnapDb) nextDb = 0
  return dbToVelocity(nextDb, normalized)
}

// ── Multi-clip (group) drags ─────────────────────────────────────────────────
// Dragging a control while several clips are selected moves the whole selection
// by the SAME delta, so pre-existing differences survive: -5 dB applied to a
// clip already at -5 dB lands on -10 dB, not on -5 dB.
//
// The group is rigid. If any one clip would cross its own limit the delta stops
// there for EVERYBODY, rather than letting the rest keep travelling while that
// clip flattens against the bound — otherwise the selection's relative shape
// would be silently destroyed the moment one member bottomed out. The clips
// pinned at their limit come back in `blocked` so the caller can highlight
// them; the user then adjusts or deselects them to continue.

const GROUP_LIMIT_EPSILON = 1e-6

// Clamp a requested delta to the range every entry can absorb, and report which
// entries are sitting on the bound that stopped it. `bounds` maps each entry to
// its own [min, max] travel.
function clampGroupDelta(requested, bounds) {
  let lower = -Infinity
  let upper = Infinity
  for (const b of bounds) {
    if (b.min > lower) lower = b.min
    if (b.max < upper) upper = b.max
  }
  if (!Number.isFinite(lower)) lower = 0
  if (!Number.isFinite(upper)) upper = 0
  if (upper < lower) upper = lower

  const delta = Math.min(upper, Math.max(lower, requested))
  const blocked = []
  if (requested > upper + GROUP_LIMIT_EPSILON) {
    for (const b of bounds) if (b.max <= delta + GROUP_LIMIT_EPSILON) blocked.push(b.id)
  } else if (requested < lower - GROUP_LIMIT_EPSILON) {
    for (const b of bounds) if (b.min >= delta - GROUP_LIMIT_EPSILON) blocked.push(b.id)
  }
  return { delta, blocked }
}

// dB value a clip's gain drag starts from. Silent clips have no finite dB, so
// they anchor at the mute floor — the same substitution applyGainDrag makes.
function startDbOf(velocity, floorDb) {
  const db = velocityToDb(velocity)
  return Number.isFinite(db) ? db : floorDb
}

// entries: [{ id, velocity }], entries[0] is the grabbed clip (the anchor whose
// dB target the cursor defines). Returns { values: Map(id → velocity), blocked }.
export function applyGroupGainDrag(entries, deltaY, modifiers = {}, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return { values: new Map(), blocked: [] }

  const floorDb = normalized.interaction.muteFloorDb
  const anchor = list[0]
  const anchorStartDb = startDbOf(anchor.velocity, floorDb)
  // Route the anchor through the single-clip path so fine-drag, unity snap and
  // dB-per-pixel stay identical between a one-clip and a many-clip drag.
  const anchorTargetDb = startDbOf(
    applyGainDrag(anchor.velocity, deltaY, modifiers, normalized), floorDb,
  )
  const requested = anchorTargetDb - anchorStartDb

  const starts = list.map((e) => ({ id: e.id, startDb: startDbOf(e.velocity, floorDb) }))
  const { delta, blocked } = clampGroupDelta(
    requested,
    starts.map((s) => ({
      id: s.id,
      min: floorDb - s.startDb,
      max: CLIP_GAIN_MAX_DB - s.startDb,
    })),
  )

  const values = new Map()
  for (const s of starts) values.set(s.id, dbToVelocity(s.startDb + delta, normalized))
  return { values, blocked }
}

// entries: [{ id, start, opposite }] for the dragged fade `kind`, entries[0] the
// anchor. The percent delta is derived from the ANCHOR's width, then applied
// verbatim to every clip — a percentage is the only quantity that means the same
// thing across clips of different lengths.
export function applyGroupFadeDrag(kind, entries, deltaX, anchorWidth, modifiers = {}, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return { values: new Map(), blocked: [] }

  const anchor = list[0]
  const anchorStart = clampNumber(anchor.start ?? 0, 0, 100)
  const requested = applyFadeDrag(
    kind, anchorStart, anchor.opposite ?? 0, deltaX, anchorWidth, modifiers, normalized,
  ) - anchorStart

  const starts = list.map((e) => ({
    id: e.id,
    start: clampNumber(e.start ?? 0, 0, 100),
    opposite: clampNumber(e.opposite ?? 0, 0, 100),
  }))
  const { delta, blocked } = clampGroupDelta(
    requested,
    starts.map((s) => ({
      id: s.id,
      min: -s.start,
      max: Math.max(0, 100 - s.opposite) - s.start,
    })),
  )

  const values = new Map()
  for (const s of starts) {
    values.set(s.id, clampNumber(s.start + delta, 0, Math.max(0, 100 - s.opposite)))
  }
  return { values, blocked }
}

export function applyFadeDrag(kind, startPercent, oppositePercent, deltaX, clipWidth, modifiers = {}, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const width = Math.max(1, Number(clipWidth) || 1)
  const fine = modifiers.shiftKey ? normalized.interaction.fineMultiplier : 1
  const direction = kind === 'fadeOut' ? -1 : 1
  const deltaPercent = direction * (Number(deltaX || 0) / width) * 100 * fine
  return clampNumber(Number(startPercent || 0) + deltaPercent, 0, Math.max(0, 100 - Number(oppositePercent || 0)))
}

function modeVisible(mode, { selected, hovered, active }) {
  if (mode === 'always') return true
  if (mode === 'selected-active') return Boolean(selected || active)
  return Boolean(selected || hovered || active)
}

export function getClipControlVisibility({ selected = false, hoveredKind = null, activeKind = null } = {}, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const state = { selected, hovered: Boolean(hoveredKind), active: Boolean(activeKind) }
  return {
    gainLine: modeVisible(normalized.visibility.gainLine, state),
    handles: modeVisible(normalized.visibility.handles, state),
  }
}

export function shouldDrawFadeOverlay(clip, selected, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  const fades = normalizeClipFades(clip)
  if (fades.fadeInPercent <= 0 && fades.fadeOutPercent <= 0) return false
  if (normalized.visibility.fadeOverlay === 'never') return false
  if (normalized.visibility.fadeOverlay === 'selected-when-set') return Boolean(selected)
  return true
}

export function computeClipControlGeometry({ clip, rect, values = null, spec = CLIP_CONTROL_DEFAULTS }) {
  const normalized = normalizeClipControlSpec(spec)
  const x = Number(rect?.x || 0)
  const y = Number(rect?.y || 0)
  const w = Math.max(0, Number(rect?.w || 0))
  const h = Math.max(0, Number(rect?.h || 0))
  const eligible = w >= normalized.eligibility.minWidth && h >= normalized.eligibility.minHeight
  const fades = values?.fades || normalizeClipFades(clip)
  const velocity = clampNumber(values?.velocity ?? clip?.velocity ?? 1, 0, CLIP_GAIN_MAX_VELOCITY)

  const requiredTravel = Math.min(normalized.gain.minTravel, h)
  const top = Math.max(y, Math.min(y + normalized.gain.topInset, y + h - requiredTravel))
  const requestedBottom = y + h - normalized.gain.bottomInset
  const bottom = Math.min(y + h, Math.max(top + requiredTravel, requestedBottom))
  const travel = Math.max(1, bottom - top)
  const lineY = Math.round(top + gainLineRatio(velocity, normalized) * travel) + 0.5
  const pill = {
    x: Math.round(x + w / 2 - normalized.gain.pillWidth / 2),
    y: Math.round(lineY - normalized.gain.pillHeight / 2),
    w: normalized.gain.pillWidth,
    h: normalized.gain.pillHeight,
  }

  const fadeInX = x + w * clampNumber(fades.fadeInPercent, 0, 100) / 100
  const fadeOutX = x + w - w * clampNumber(fades.fadeOutPercent, 0, 100) / 100
  const wedgeWidth = Math.min(normalized.fade.wedgeMaxWidth, Math.max(normalized.fade.wedgeMinWidth, w * normalized.fade.wedgeWidthRatio))
  const wedgeHeight = Math.min(normalized.fade.wedgeMaxHeight, h * normalized.fade.wedgeHeightRatio)
  const clipBottom = y + h
  const fadeInLeft = fadeInX <= x + wedgeWidth ? x : Math.min(x + w - wedgeWidth, fadeInX - wedgeWidth)
  const fadeOutRight = fadeOutX >= x + w - wedgeWidth ? x + w : Math.max(x + wedgeWidth, fadeOutX + wedgeWidth)

  return {
    eligible,
    rect: { x, y, w, h },
    velocity,
    fades,
    gain: {
      top,
      bottom,
      lineY,
      pill,
      anchor: { x: x + w / 2, y: lineY },
    },
    fadeIn: {
      anchor: { x: fadeInX, y: clipBottom },
      wedge: { left: fadeInLeft, right: fadeInLeft + wedgeWidth, top: Math.max(y, clipBottom - wedgeHeight), bottom: clipBottom },
    },
    fadeOut: {
      anchor: { x: fadeOutX, y: clipBottom },
      wedge: { left: fadeOutRight - wedgeWidth, right: fadeOutRight, top: Math.max(y, clipBottom - wedgeHeight), bottom: clipBottom },
    },
  }
}

export function hitTestClipControl({ localX, localY, clip, rect, spec = CLIP_CONTROL_DEFAULTS, allowGain = true, allowFade = true }) {
  const normalized = normalizeClipControlSpec(spec)
  const geometry = computeClipControlGeometry({ clip, rect, spec: normalized })
  if (!geometry.eligible) return null
  const { x, y, w, h } = geometry.rect
  if (localX < x - normalized.interaction.outerSlop || localX > x + w + normalized.interaction.outerSlop) return null
  if (localY < y || localY > y + h) return null

  if (allowGain) {
    const pill = geometry.gain.pill
    if (localX >= pill.x - normalized.interaction.gainHitSlopX &&
        localX <= pill.x + pill.w + normalized.interaction.gainHitSlopX &&
        localY >= pill.y - normalized.interaction.gainHitSlopY &&
        localY <= pill.y + pill.h + normalized.interaction.gainHitSlopY) {
      return { kind: 'volume', geometry, distance: Math.hypot(localX - geometry.gain.anchor.x, localY - geometry.gain.anchor.y) }
    }
  }

  if (!allowFade || localY < y + h - normalized.interaction.fadeHitHeight) return null
  const radius = normalized.interaction.fadeHandleHalfWidth + normalized.interaction.fadeExtraSlop
  const inDistance = Math.abs(localX - geometry.fadeIn.anchor.x)
  const outDistance = Math.abs(localX - geometry.fadeOut.anchor.x)
  const inHit = inDistance <= radius
  const outHit = outDistance <= radius
  if (!inHit && !outHit) return null
  if (inHit && outHit) {
    if (Math.abs(inDistance - outDistance) < 1e-6) {
      return { kind: localX <= x + w / 2 ? 'fadeIn' : 'fadeOut', geometry, distance: inDistance }
    }
    return { kind: inDistance < outDistance ? 'fadeIn' : 'fadeOut', geometry, distance: Math.min(inDistance, outDistance) }
  }
  return { kind: inHit ? 'fadeIn' : 'fadeOut', geometry, distance: inHit ? inDistance : outDistance }
}

export function formatClipControlValue(kind, value, spec = CLIP_CONTROL_DEFAULTS) {
  const normalized = normalizeClipControlSpec(spec)
  if (kind === 'volume') {
    const db = velocityToDb(value)
    if (!Number.isFinite(db)) return '-∞ dB'
    const sign = db > 0 ? '+' : ''
    return `${sign}${db.toFixed(normalized.tooltip.gainDecimals)} dB`
  }
  const label = kind === 'fadeIn' ? 'Fade in' : 'Fade out'
  return `${label} ${Number(value || 0).toFixed(normalized.tooltip.fadeDecimals)}%`
}

export function clipControlCursor(kind) {
  if (kind === 'volume') return 'ns-resize'
  if (kind === 'fadeIn' || kind === 'fadeOut') return 'ew-resize'
  return null
}

function deepDiff(base, final) {
  const diff = {}
  for (const key of Object.keys(base)) {
    const before = base[key]
    const after = final[key]
    if (before && typeof before === 'object' && !Array.isArray(before)) {
      const child = deepDiff(before, after)
      if (Object.keys(child).length) diff[key] = child
    } else if (before !== after) {
      diff[key] = { from: before, to: after }
    }
  }
  return diff
}

export function diffClipControlSpec(finalSpec, baseSpec = CLIP_CONTROL_DEFAULTS) {
  return deepDiff(normalizeClipControlSpec(baseSpec), normalizeClipControlSpec(finalSpec))
}

export function clipControlDefaultsHash(spec = CLIP_CONTROL_DEFAULTS) {
  const input = JSON.stringify(normalizeClipControlSpec(spec))
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function buildClipControlTuningReport({ finalSpec, changeHistory = [], previewState = {}, context = {}, appVersion = 'unknown', generatedAt = new Date().toISOString() }) {
  const normalizedDefaults = normalizeClipControlSpec(CLIP_CONTROL_DEFAULTS)
  const normalizedFinal = normalizeClipControlSpec(finalSpec)
  return {
    kind: 'xleth.clip-control-tuning',
    schemaVersion: CLIP_CONTROL_SPEC_VERSION,
    defaultsRevision: CLIP_CONTROL_DEFAULTS_REVISION,
    defaultsHash: clipControlDefaultsHash(normalizedDefaults),
    appVersion,
    generatedAt,
    defaults: normalizedDefaults,
    final: normalizedFinal,
    diff: diffClipControlSpec(normalizedFinal, normalizedDefaults),
    changeHistory: Array.isArray(changeHistory) ? changeHistory : [],
    previewState,
    context,
  }
}

export function clipControlField(path) {
  return FIELD_BY_PATH.get(path) || null
}

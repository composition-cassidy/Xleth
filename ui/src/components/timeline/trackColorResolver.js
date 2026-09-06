const HEX6 = /^#[0-9a-fA-F]{6}$/

// Pass 7 (glass+hatch restyle) — desaturated ~30-40% and pulled toward mid
// lightness from the original full-saturation swatches, so full-fill Clip
// tracks don't glow against the dark UI. Custom user-picked colors are
// untouched; only these 16 defaults changed.
export const TRACK_PALETTE_FALLBACK = [
  '#58B2CE', '#77BE87', '#DD925D', '#8A6FE0',
  '#D56DA3', '#DEB963', '#6186CF', '#4AB7A9',
  '#DF6666', '#97BB65', '#A974DE', '#4CA9D3',
  '#D3AA41', '#8496BA', '#6DCAA5', '#DB6A7B',
]

export const TRACK_COLOR_MODE_AUTO = 'auto'
export const TRACK_COLOR_MODE_PALETTE_SLOT = 'paletteSlot'
export const TRACK_COLOR_MODE_CUSTOM = 'custom'
export const TRACK_COLOR_SLOT_MIN = 1
export const TRACK_COLOR_SLOT_MAX = 16

export function isHex6(value) {
  return typeof value === 'string' && HEX6.test(value)
}

// Validate 16-entry raw palette array; replace invalid entries with fallback.
export function normalizeTrackPalette(rawPalette) {
  return Array.from({ length: 16 }, (_, i) => {
    const v = rawPalette?.[i]
    return isHex6(v) ? v : TRACK_PALETTE_FALLBACK[i]
  })
}

// Pass 6F — strict #RRGGBB validation (case-insensitive on input).
export function isValidTrackCustomColor(value) {
  return isHex6(value)
}

// Pass 6F — returns uppercase #RRGGBB for valid input, null for invalid.
// Engine normalizes to uppercase for stable saves; resolver mirrors that.
export function normalizeTrackCustomColor(value) {
  return isHex6(value) ? value.toUpperCase() : null
}

// Coerce an arbitrary value to "auto" | "paletteSlot" | "custom". Anything
// else → "auto".
export function sanitizeTrackColorMode(value) {
  if (value === TRACK_COLOR_MODE_PALETTE_SLOT) return TRACK_COLOR_MODE_PALETTE_SLOT
  if (value === TRACK_COLOR_MODE_CUSTOM)       return TRACK_COLOR_MODE_CUSTOM
  return TRACK_COLOR_MODE_AUTO
}

// Coerce an arbitrary value to an integer 1..16, or null if invalid.
export function sanitizeTrackColorSlot(value) {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  const n = Math.trunc(value)
  if (n < TRACK_COLOR_SLOT_MIN || n > TRACK_COLOR_SLOT_MAX) return null
  return n
}

// Returns a normalized { mode, slot, customColor } shape from an arbitrary
// track-like input.
// - missing/invalid mode → "auto"
// - paletteSlot mode with invalid slot → "auto"
// - custom mode with invalid hex → "auto"
// - auto mode → slot/customColor are dropped (null)
export function normalizeTrackColorAssignment(track) {
  const mode = sanitizeTrackColorMode(track?.trackColorMode)
  if (mode === TRACK_COLOR_MODE_PALETTE_SLOT) {
    const slot = sanitizeTrackColorSlot(track?.trackColorSlot)
    if (slot == null) return { mode: TRACK_COLOR_MODE_AUTO, slot: null, customColor: null }
    return { mode: TRACK_COLOR_MODE_PALETTE_SLOT, slot, customColor: null }
  }
  if (mode === TRACK_COLOR_MODE_CUSTOM) {
    const customColor = normalizeTrackCustomColor(track?.trackColorCustom)
    if (customColor == null) return { mode: TRACK_COLOR_MODE_AUTO, slot: null, customColor: null }
    return { mode: TRACK_COLOR_MODE_CUSTOM, slot: null, customColor }
  }
  return { mode: TRACK_COLOR_MODE_AUTO, slot: null, customColor: null }
}

// Resolve a track's color. Custom hex wins outright; paletteSlot wins over
// auto-by-visible-index; auto falls through. Pure — does NOT read DOM/theme
// tokens; the caller resolves the palette once per redraw.
export function resolveTrackColor(track, visibleIndex, trackPalette, fallbackHex) {
  const palette = trackPalette?.length ? trackPalette : TRACK_PALETTE_FALLBACK
  const { mode, slot, customColor } = normalizeTrackColorAssignment(track)
  if (mode === TRACK_COLOR_MODE_CUSTOM && customColor) return customColor
  if (mode === TRACK_COLOR_MODE_PALETTE_SLOT && slot != null) {
    const explicit = palette[(slot - 1) % palette.length]
    if (explicit) return explicit
  }
  return palette[visibleIndex % palette.length] || fallbackHex || TRACK_PALETTE_FALLBACK[0]
}

// Backward-compatible alias preserved for existing callers (Pass 6C). The
// signature is unchanged — track is accepted, so this now also honors a valid
// paletteSlot assignment without modifying any call site.
export function resolveAutoTrackColor(track, visibleIndex, trackPalette, fallbackHex) {
  return resolveTrackColor(track, visibleIndex, trackPalette, fallbackHex)
}

// Pattern-track "tinted glass" text/glyph color (Pass 7). Text on a pattern
// clip/header sits directly on a mostly-dark backdrop (the fill is only a
// ~10% tint), so the track color itself is used as the text color UNLESS its
// WCAG relative luminance is too low to read against that dark backdrop, in
// which case a near-white fallback takes over.
const PATTERN_TEXT_NEAR_WHITE = '#F2F2F2'
const PATTERN_TEXT_LUMINANCE_MIN = 0.27

function srgbChannelToLinear(c8) {
  const c = c8 / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

// WCAG relative luminance (0..1).
function relativeLuminance(hex) {
  const r = srgbChannelToLinear(parseInt(hex.slice(1, 3), 16))
  const g = srgbChannelToLinear(parseInt(hex.slice(3, 5), 16))
  const b = srgbChannelToLinear(parseInt(hex.slice(5, 7), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function pickPatternAccentText(hex) {
  if (!isHex6(hex)) return PATTERN_TEXT_NEAR_WHITE
  return relativeLuminance(hex) >= PATTERN_TEXT_LUMINANCE_MIN ? hex : PATTERN_TEXT_NEAR_WHITE
}

// Build { [trackId]: resolvedHexColor } for all tracks in visible order.
// Called once per redraw cycle; result is threaded into draw functions.
export function buildResolvedTrackColorMap(tracks, trackPalette) {
  if (!tracks?.length) return {}
  const map = {}
  for (let i = 0; i < tracks.length; i++) {
    map[tracks[i].id] = resolveTrackColor(
      tracks[i], i, trackPalette, TRACK_PALETTE_FALLBACK[i % 16]
    )
  }
  return map
}

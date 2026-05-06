const HEX6 = /^#[0-9a-fA-F]{6}$/

export const TRACK_PALETTE_FALLBACK = [
  '#4CC9F0', '#7BD88F', '#FF9F5A', '#9B7BFF',
  '#F472B6', '#FFD166', '#5B8DEF', '#2DD4BF',
  '#FF6B6B', '#A3D65C', '#C084FC', '#38BDF8',
  '#FBBF24', '#8EA4D2', '#6EE7B7', '#FB7185',
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

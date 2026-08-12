// Hardcoded per-band identity colors for the APEX editor.
//
// These mirror the Overdone (3-band OTT) stock effect's band palette exactly —
// see MULTIBAND_DISPLAY.bandColors in
// ../../plugin-ui/runtime/visualizers/multibandPainter.js — so LOW / MID / HIGH
// read as the same three bands across both plugins:
//   LOW  → red-orange (bass weight)
//   MID  → lime-green (mid presence)
//   HIGH → aqua/sky   (high air)
//
// MASTER has no fixed identity color: it keeps the earned --theme-accent, the
// same "accent is earned" idea the panel already used. bandColor(3) therefore
// returns null so callers fall back to the theme accent (knobs: omit accentColor;
// canvases: use the resolved --theme-accent token).

export const APEX_BAND_COLORS = Object.freeze([
  '#f97316', // LOW  — red-orange
  '#a3e635', // MID  — lime-green
  '#38bdf8', // HIGH — aqua/sky
  null,      // MASTER — earned theme accent
])

// Identity color for a band index, or null for MASTER (use the theme accent).
export function bandColor(band) {
  return APEX_BAND_COLORS[band] ?? null
}

// Same, but resolves MASTER (and any out-of-range index) to a supplied accent
// fallback — for the canvas drawers that always need a concrete color string.
export function bandColorOr(band, accentFallback) {
  return APEX_BAND_COLORS[band] ?? accentFallback
}

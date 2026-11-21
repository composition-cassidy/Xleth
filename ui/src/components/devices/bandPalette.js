// The multiband band palette (ui/DESIGN.md 3.3.1): four fixed hues, low to high,
// shared by every multiband device and reused on that band's own controls.
// A three-band device uses slots 1, 2 and 4, so "High" is always the top hue.
// Tokens only: CSS reads `bandVar(...)`; a canvas resolves `bandToken(...)` from
// the computed style of its own element at draw time (never at module scope).

const THREE_BAND_SLOTS = Object.freeze([1, 2, 4])

/** CSS custom property name for band `index` of a `count`-band device. */
export function bandToken(index, count = 3) {
  const slot = count === 3 ? THREE_BAND_SLOTS[index] : index + 1
  return slot ? `--ui-band-${slot}` : null
}

/** `var(--ui-band-N)` for inline style values (e.g. setting `--ui-value`). */
export function bandVar(index, count = 3) {
  const token = bandToken(index, count)
  return token ? `var(${token})` : null
}

/** Resolve a band colour for a canvas, falling back when the token is absent. */
export function readBandColor(el, index, fallback, count = 3) {
  const token = bandToken(index, count)
  if (!token || !el || typeof getComputedStyle !== 'function') return fallback
  return getComputedStyle(el).getPropertyValue(token).trim() || fallback
}

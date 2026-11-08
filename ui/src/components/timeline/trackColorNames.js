// Plain names for the identity palette, so a swatch can say what it is in the hint bar.
// The 16 colours have no names of their own (DESIGN.md 3.4); a name is read off the colour's
// OKLCH hue, so a theme that changes a slot gets an honest name. The slot number always rides
// along ("Slot 9: Orange"), because three slots are oranges apart by lightness only.
import { hexToOklch } from '../../ui-kit/colorMath'

// Upper bound of each hue band, in OKLCH degrees.
const HUE_BANDS = [
  [20, 'Pink'], [40, 'Coral'], [65, 'Orange'], [90, 'Amber'], [115, 'Olive'], [140, 'Lime'],
  [165, 'Green'], [195, 'Teal'], [225, 'Cyan'], [255, 'Sky'], [285, 'Blue'], [315, 'Violet'],
  [345, 'Magenta'], [360, 'Pink'],
]

export function trackColorName(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return 'Custom'
  const { c, h } = hexToOklch(hex)
  if (c < 0.03) return 'Grey'
  const hue = ((h % 360) + 360) % 360
  return (HUE_BANDS.find(([max]) => hue < max) ?? HUE_BANDS[HUE_BANDS.length - 1])[1]
}

export function trackColorSlotLabel(slot, hex) {
  return `Slot ${slot}: ${trackColorName(hex)}`
}

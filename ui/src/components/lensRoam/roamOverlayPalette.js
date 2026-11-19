// The viewer overlay's canvas colours: the kit tokens it draws with, resolved once
// and cached (docs/XLETH_MOTION_VIEW_DESIGN.md 5.7). tokenValue() reads computed
// style, so it is never called at module scope and never on every draw: the cache
// is dropped on 'xleth-theme-changed' (and by the overlay when the theme epoch
// moves). A palette read before the theme has mounted (a token still empty) is
// not cached, so the next draw asks again.

import { tokenValue } from '../../theming/tokenValue.ts'

let cache = null

export function invalidateOverlayPalette() {
  cache = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('xleth-theme-changed', invalidateOverlayPalette)
  if (typeof document !== 'undefined') document.addEventListener('xleth-theme-changed', invalidateOverlayPalette)
}

/**
 * { g0, ink, ink2, ink3, select, value, rec, recText }:
 *   g0       the dark keyline under every line and the label chips
 *   ink*     neutral inks (hover, the home box, inactive masks)
 *   select   the selection / active-mask accent
 *   value    the value accent (the pen's rubber band)
 *   rec      Auto-key armed
 */
export function overlayPalette() {
  if (cache) return cache
  const p = {
    g0: tokenValue('--ui-g0'),
    ink: tokenValue('--ui-ink'),
    ink2: tokenValue('--ui-ink-2'),
    ink3: tokenValue('--ui-ink-3'),
    select: tokenValue('--ui-select'),
    value: tokenValue('--ui-value'),
    rec: tokenValue('--ui-rec'),
    recText: tokenValue('--ui-rec-text'),
  }
  if (Object.values(p).every((v) => typeof v === 'string' && v.length > 0)) cache = p
  return p
}

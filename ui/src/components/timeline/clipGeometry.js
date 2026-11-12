// Clip-specific helpers. Rectangle geometry lives in blockGeometry.js (shared by
// clips and pattern blocks); getClipRect / CLIP_PAD are re-exported so existing
// importers keep working.

export { getClipRect, BLOCK_PAD as CLIP_PAD } from './blockGeometry.js'

export function clipHasFxIntent(clip) {
  const m = clip?.modulation
  if (!m) return false
  return Boolean(
    (m.enabled && (m.vibrato?.enabled || m.scratch?.enabled)) ||
    m.video?.vibratoSwirlEnabled ||
    m.video?.scratchWaveEnabled
  )
}

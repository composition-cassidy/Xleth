// Clip modulation vocabulary shared by the Inspector and the arrangement.
// Moved verbatim from TimelineView.jsx (Phase 3).

// VIBRATO_SHAPES / VIBRATO_SYNC_DIVISIONS now live in ./timeline/clipVibrato.js
// so the clip dropdown and the floating graph editor share one vocabulary
// (and one 'custom' entry).
export const VIBRATO_DEFAULTS = {
  enabled: true,
  depthCents: 50,
  rateMode: 'freeHz',
  rateHz: 5.0,
  syncDivision: 'eighth',
  shape: 'sine',
  phaseResetOnClipStart: true,
  phaseOffset: 0,
}
// Scratch preset vocabulary lives in timeline/clipScratch.js so the dropdown
// below and the floating rate-graph editor share ONE definition of what a
// preset is. SCRATCH_EDGE_MODES now carries all four engine edge modes; Wrap
// and Ping-Pong were always supported by ClipModulation::Scratch::EdgeMode and
// were simply never offered here.

function hasAudioModulationIntent(modulation) {
  if (!modulation) return false
  return Boolean(modulation.enabled && (modulation.vibrato?.enabled || modulation.scratch?.enabled))
}

function hasVideoCompanionIntent(modulation) {
  return Boolean(modulation?.video?.vibratoSwirlEnabled || modulation?.video?.scratchWaveEnabled)
}

function isClipModulationBypassed(clip) {
  // stretchRatio AND formantPreserve are supported (Phase F.1) — NOT bypass
  // conditions. Modulation composes on top of the post-cache processed buffer.
  // Only reverse still bypasses (unresolved scratch source-time semantics).
  return Boolean(clip?.reversed)
}

export function getClipModulationStatus(clip) {
  const mod = clip?.modulation
  const audioActive = hasAudioModulationIntent(mod)
  const videoSaved = hasVideoCompanionIntent(mod)
  const anyIntent = audioActive || videoSaved

  if (anyIntent && isClipModulationBypassed(clip)) {
    const reasons = []
    if (clip.reversed) reasons.push('Reverse is enabled')
    return { kind: 'bypassed', label: `Bypassed: ${reasons.join(' and ')}` }
  }

  const swirlOrphan = Boolean(mod?.video?.vibratoSwirlEnabled && !mod?.vibrato?.enabled)
  const waveOrphan  = Boolean(mod?.video?.scratchWaveEnabled  && !mod?.scratch?.enabled)
  const orphanSuffix = swirlOrphan && waveOrphan
    ? 'Swirl waits for Vibrato; Wave waits for Scratch'
    : swirlOrphan ? 'Swirl waits for Vibrato'
    : waveOrphan  ? 'Wave waits for Scratch'
    : ''

  if (audioActive) {
    const parts = []
    if (mod.vibrato?.enabled) parts.push('Vibrato')
    if (mod.scratch?.enabled) parts.push('Scratch')
    const base = `Active: ${parts.join(' + ')}`
    return { kind: 'active', label: orphanSuffix ? `${base} · ${orphanSuffix}` : base }
  }

  if (orphanSuffix) {
    return { kind: 'saved', label: `Saved: ${orphanSuffix}` }
  }

  return { kind: 'off', label: 'Off' }
}

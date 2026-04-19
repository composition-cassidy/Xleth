// Pure functions + constants for the YouTube / Discord / Custom export presets.
// No React imports — safe to use from anywhere.

export const CURRENT_PRESET_VERSION = 1

// ── YouTube ──────────────────────────────────────────────────────────────────
// Discrete 4-stop quality selector. Drag always snaps to one of these.
export const YOUTUBE_QUALITY_STOPS = [
  { value: 0.25, label: 'Good' },
  { value: 0.50, label: 'Great' },
  { value: 0.75, label: 'Excellent' },
  { value: 1.00, label: 'Best' },
]

export const YOUTUBE_RESOLUTIONS = [
  { id: '1080p', label: '1080p',  width: 1920, height: 1080 },
  { id: '1440p', label: '1440p',  width: 2560, height: 1440 },
  { id: '2160p', label: '4K',     width: 3840, height: 2160 },
]

const YT_MIN_MBPS_REF = 8
const YT_MAX_MBPS_REF = 50
const YT_PIXEL_REF    = 1920 * 1080 * 60
const YT_MBPS_CAP     = 80

/**
 * Sub-linear pixel scaling:
 *   scale = (pixelRate / refRate) ^ 0.75
 *   mbps  = (minRef + quality * (maxRef - minRef)) * scale
 * Hard cap at 80 Mbps so 4K60 Best doesn't explode past YouTube recs.
 * Anchors: 1080p60 Best = 50 Mbps.
 */
export function computeYoutubeBitrate(width, height, fps, quality) {
  if (!width || !height || !fps) return 0
  const pixelRate = width * height * fps
  const scale     = Math.pow(pixelRate / YT_PIXEL_REF, 0.75)
  const rawMbps   = (YT_MIN_MBPS_REF + quality * (YT_MAX_MBPS_REF - YT_MIN_MBPS_REF)) * scale
  const mbps      = Math.min(rawMbps, YT_MBPS_CAP)
  return Math.round(mbps * 1_000_000)
}

// ── Discord ──────────────────────────────────────────────────────────────────
// Verified 2026-04-17 against Discord's File Attachments FAQ.
// Update if Discord changes tier limits.
export const DISCORD_TIER_BYTES = {
  free:       10_000_000,   // 10 MB decimal
  nitroBasic: 50_000_000,   // 50 MB decimal
  nitro:     500_000_000,   // 500 MB decimal
}

export const DISCORD_TIER_LABELS = {
  free:       'Free (10 MB)',
  nitroBasic: 'Nitro Basic (50 MB)',
  nitro:      'Nitro (500 MB)',
}

// Container + VBR overshoot headroom. 12% buys safety without crushing quality.
export const DISCORD_OVERHEAD_FACTOR   = 0.88
export const DISCORD_AUDIO_BITRATE     = 256_000   // Opus 256 kbps
export const DISCORD_WARN_VIDEO_BITRATE = 500_000  // yellow banner
export const DISCORD_MIN_VIDEO_BITRATE  = 300_000  // red banner, block export

export function computeDiscordVideoBitrate(tier, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return 0
  const limitBytes = DISCORD_TIER_BYTES[tier] ?? DISCORD_TIER_BYTES.free
  const targetBits = limitBytes * 8 * DISCORD_OVERHEAD_FACTOR
  const vb = (targetBits / durationSeconds) - DISCORD_AUDIO_BITRATE
  return Math.max(0, Math.round(vb))
}

export function estimateDiscordFileBytes(videoBitrate, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return 0
  return Math.round((videoBitrate + DISCORD_AUDIO_BITRATE) * durationSeconds / 8)
}

// ── Formatting helpers ───────────────────────────────────────────────────────
export function formatBitrateMbps(bps) {
  return (bps / 1_000_000).toFixed(1) + ' Mbps'
}

export function formatBytesMB(bytes) {
  return (bytes / 1_000_000).toFixed(1) + ' MB'
}

export function formatDuration(secs) {
  if (!secs || !isFinite(secs)) return '—'
  if (secs < 60) return Math.round(secs) + ' sec'
  const m = Math.floor(secs / 60)
  const s = Math.round(secs - m * 60)
  return s === 0 ? `${m} min` : `${m} min ${s} sec`
}

// ── Defaults + migrator ──────────────────────────────────────────────────────
export function defaultExportPresets() {
  return {
    version:  CURRENT_PRESET_VERSION,
    lastTab:  'youtube',
    youtube:  { resolution: '1080p', fps: 60, quality: 0.75, hwEncoder: null },
    discord:  { tier: 'free', fps: 30, hwEncoder: null },
    custom:   [],
  }
}

/**
 * Returns { presets, wasReset } — if the stored blob is missing or from an
 * older schema, returns the default set with wasReset=true so the caller can
 * show a one-time toast. Never throws on malformed data.
 */
export function migrateExportPresets(stored) {
  if (!stored || typeof stored !== 'object') {
    return { presets: defaultExportPresets(), wasReset: true }
  }
  if (typeof stored.version !== 'number' || stored.version < CURRENT_PRESET_VERSION) {
    return { presets: defaultExportPresets(), wasReset: true }
  }
  // Fill in any missing top-level keys with defaults (forward-compat).
  const d = defaultExportPresets()
  return {
    presets: {
      version: CURRENT_PRESET_VERSION,
      lastTab: stored.lastTab ?? d.lastTab,
      youtube: { ...d.youtube, ...(stored.youtube || {}) },
      discord: { ...d.discord, ...(stored.discord || {}) },
      custom:  Array.isArray(stored.custom) ? stored.custom : [],
    },
    wasReset: false,
  }
}

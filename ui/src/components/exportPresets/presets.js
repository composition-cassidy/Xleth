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

// ── Project canvas / aspect-fit helpers ───────────────────────────────────────
// The project canvas (Grid Settings) is the single source of truth for the base
// resolution / aspect / frame rate. The export dialog defaults to it; Custom may
// override. When an export's aspect differs from the project's, a fit mode
// decides how the authored canvas maps into the output (see render/CanvasFit.h).

// Backstop used when no project canvas is supplied (old call sites / tests).
export const DEFAULT_PROJECT_CANVAS = Object.freeze({
  canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9', previewFps: 30,
})

export const FIT_MODES = ['crop', 'stretch', 'bars']

// True when two width×height pairs describe the same aspect ratio (within a
// small tolerance so 1280×720 and 1920×1080 count as equal).
export function aspectsMatch(w1, h1, w2, h2, eps = 0.005) {
  if (!w1 || !h1 || !w2 || !h2) return true
  const a1 = w1 / h1
  const a2 = w2 / h2
  return Math.abs(a1 / a2 - 1) < eps
}

// Resolve the fit mode to send to the renderer.
//   matching aspect          → 'stretch' (identity; encodes exactly like before)
//   preset, mismatched       → 'bars'    (preserve proportions, never distort)
//   Custom, mismatched       → the user's explicit choice (UI requires one)
export function resolveFitMode({ outW, outH, projectCanvas, isCustom = false, customFitMode = '' }) {
  const pc = projectCanvas || DEFAULT_PROJECT_CANVAS
  if (aspectsMatch(outW, outH, pc.canvasWidth, pc.canvasHeight)) return 'stretch'
  if (isCustom) return FIT_MODES.includes(customFitMode) ? customFitMode : 'bars'
  return 'bars'
}

// Whether the Custom output aspect differs from the project aspect (the dialog
// uses this to require an explicit fit-mode choice before allowing export).
export function customAspectMismatch(customSettings, projectCanvas) {
  const pc = projectCanvas || DEFAULT_PROJECT_CANVAS
  const { w, h } = customResolutionPx(customSettings)
  return !aspectsMatch(w, h, pc.canvasWidth, pc.canvasHeight)
}

// One-line, human-readable description of a resolved export config (the object
// returned by buildExportConfig). The dialog shows it so the user sees the exact
// final output — dimensions, fps, codec, rate control, audio, and fit mode.
export function describeExportSummary(cfg) {
  if (!cfg) return ''
  const parts = []
  if (cfg.width && cfg.height) parts.push(`${cfg.width}×${cfg.height}`)
  if (cfg.fpsNum)              parts.push(`${cfg.fpsNum} fps`)
  if (cfg.videoCodec)          parts.push(String(cfg.videoCodec).toUpperCase())
  if (cfg.rateControl === 'crf' && cfg.crf != null) parts.push(`CRF ${cfg.crf}`)
  else if (cfg.videoBitrate)   parts.push(formatBitrateMbps(cfg.videoBitrate))
  if (cfg.audioCodec) {
    let a = String(cfg.audioCodec).toUpperCase()
    if (cfg.sampleRate) a += ` ${cfg.sampleRate / 1000} kHz`
    if (cfg.audioBitrate && (cfg.audioCodec === 'aac' || cfg.audioCodec === 'opus'))
      a += ` ${cfg.audioBitrate} kbps`
    parts.push(a)
  }
  if (cfg.fitMode && cfg.fitMode !== 'stretch')
    parts.push(cfg.fitMode === 'crop' ? 'cropped to fill' : 'letterboxed')
  else if (cfg.fitMode === 'stretch' && cfg.width && cfg.height)
    { /* aspect matches or explicit stretch — no fit annotation needed */ }
  return parts.join(' · ')
}

// ── Backend config assembly ───────────────────────────────────────────────────
// Fixed render dimensions for the Discord preset (720p fits every tier's budget).
export const DISCORD_WIDTH  = 1280
export const DISCORD_HEIGHT = 720

// Parses "1920x1080", or "custom" with customWidth/customHeight, into pixels.
export function customResolutionPx(settings) {
  if (settings.resolution === 'custom') {
    return { w: Number(settings.customWidth) || 1920, h: Number(settings.customHeight) || 1080 }
  }
  const [w, h] = String(settings.resolution).split('x').map(Number)
  return { w: w || 1920, h: h || 1080 }
}

/**
 * Pure resolution of UI tab state → the config object the native bridge
 * (video_exportStart) consumes. Kept side-effect-free so the CRF-vs-bitrate
 * wiring is unit-testable without React.
 *
 * Key invariant: `rateControl` is ALWAYS explicit ('crf' | 'bitrate'). CRF mode
 * sends `crf` and never `videoBitrate`; bitrate mode sends `videoBitrate` (bps)
 * and never `crf`. The two never travel together, so the native default CRF can
 * no longer override a requested bitrate.
 */
export function buildExportConfig({
  activeTab,
  outputPath,
  youtubeSettings,
  discordSettings,
  customSettings,
  videoModeOverride,
  discordDurationSec,
  projectCanvas,
}) {
  if (activeTab === 'youtube') {
    const res = YOUTUBE_RESOLUTIONS.find((r) => r.id === youtubeSettings.resolution)
             || YOUTUBE_RESOLUTIONS[0]
    const bps = computeYoutubeBitrate(res.width, res.height, youtubeSettings.fps, youtubeSettings.quality)
    return {
      outputPath,
      videoCodec:   'h264',
      hwEncoder:    youtubeSettings.hwEncoder || '',
      videoMode:    videoModeOverride || 'auto',
      width:        res.width,
      height:       res.height,
      fpsNum:       Number(youtubeSettings.fps),
      fpsDen:       1,
      fitMode:      resolveFitMode({ outW: res.width, outH: res.height, projectCanvas }),
      rateControl:  'bitrate',
      videoBitrate: bps,
      audioCodec:   'aac',
      sampleRate:   48000,
      audioBitrate: 384,
      // Final-quality export — bypass DNxHR proxy substitution so the encoder
      // sees original-source pixels (otherwise the bitrate operates on already-
      // degraded preview-grade input).
      useSourceMedia: true,
    }
  }

  if (activeTab === 'discord') {
    const bps = computeDiscordVideoBitrate(discordSettings.tier, discordDurationSec)
    return {
      outputPath,
      videoCodec:   'h264',
      hwEncoder:    discordSettings.hwEncoder || '',
      videoMode:    videoModeOverride || 'auto',
      width:        DISCORD_WIDTH,
      height:       DISCORD_HEIGHT,
      fpsNum:       Number(discordSettings.fps),
      fpsDen:       1,
      fitMode:      resolveFitMode({ outW: DISCORD_WIDTH, outH: DISCORD_HEIGHT, projectCanvas }),
      rateControl:  'bitrate',
      videoBitrate: bps,
      audioCodec:   'opus',
      sampleRate:   44100,
      audioBitrate: 256,
      useSourceMedia: true,
    }
  }

  // Custom — the override surface. Dimensions/fps come from the tab (which the
  // dialog seeds from the project canvas); fit mode is the user's explicit
  // choice when the output aspect differs from the project's.
  const { w, h } = customResolutionPx(customSettings)
  const cfg = {
    outputPath,
    videoCodec:   customSettings.videoCodec,
    hwEncoder:    customSettings.hwEncoder || '',
    videoMode:    videoModeOverride || 'auto',
    width:        w,
    height:       h,
    fpsNum:       Number(customSettings.fps),
    fpsDen:       1,
    fitMode:      resolveFitMode({
      outW: w, outH: h, projectCanvas,
      isCustom: true, customFitMode: customSettings.fitMode,
    }),
    rateControl:  customSettings.useCrf ? 'crf' : 'bitrate',
    audioCodec:   customSettings.audioCodec,
    sampleRate:   Number(customSettings.sampleRate),
    audioBitrate: Number(customSettings.audioBitrate),
    useSourceMedia: true,
  }
  if (customSettings.useCrf) {
    cfg.crf = Number(customSettings.crf)
  } else {
    cfg.videoBitrate = Number(customSettings.videoBitrate) * 1_000_000
  }
  return cfg
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

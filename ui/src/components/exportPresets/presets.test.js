import { describe, expect, it } from 'vitest'
import {
  buildExportConfig,
  computeYoutubeBitrate,
  computeDiscordVideoBitrate,
  DISCORD_WIDTH,
  DISCORD_HEIGHT,
  aspectsMatch,
  resolveFitMode,
  customAspectMismatch,
  describeExportSummary,
} from './presets.js'
import { makeCustomDefaults } from './CustomTab.jsx'

// Project canvas fixtures.
const CANVAS_16x9 = { canvasWidth: 1920, canvasHeight: 1080, canvasAspectRatio: '16:9', previewFps: 30 }
const CANVAS_9x16 = { canvasWidth: 1080, canvasHeight: 1920, canvasAspectRatio: '9:16', previewFps: 24 }

// These guard the CRF-vs-bitrate wiring: the historical bug was that a default
// CRF leaked into bitrate-mode exports and silently overrode the bitrate. The
// invariant we enforce is that rateControl is always explicit and CRF/bitrate
// never travel together.

const baseCustom = {
  videoCodec: 'h264',
  hwEncoder: '',
  resolution: '1920x1080',
  customWidth: 1920,
  customHeight: 1080,
  fps: 60,
  useCrf: true,
  crf: 18,
  videoBitrate: 20, // Mbps
  audioCodec: 'aac',
  sampleRate: 48000,
  audioBitrate: 384,
}

describe('buildExportConfig — Custom', () => {
  it('CRF mode sends crf and never videoBitrate', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: 'out.mp4',
      customSettings: { ...baseCustom, useCrf: true, crf: 22 },
      videoModeOverride: 'software',
    })
    expect(cfg.rateControl).toBe('crf')
    expect(cfg.crf).toBe(22)
    expect(cfg.videoBitrate).toBeUndefined()
    expect(cfg.videoMode).toBe('software')
    expect(cfg.useSourceMedia).toBe(true)
  })

  it('Bitrate mode sends videoBitrate in bps and never crf', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: 'out.mp4',
      customSettings: { ...baseCustom, useCrf: false, videoBitrate: 20, crf: 18 },
      videoModeOverride: 'auto',
    })
    expect(cfg.rateControl).toBe('bitrate')
    expect(cfg.videoBitrate).toBe(20_000_000) // Mbps → bps
    expect(cfg.crf).toBeUndefined()
  })

  it('custom resolution falls back to explicit width/height', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: 'out.mp4',
      customSettings: { ...baseCustom, resolution: 'custom', customWidth: 1280, customHeight: 720 },
      videoModeOverride: 'auto',
    })
    expect(cfg.width).toBe(1280)
    expect(cfg.height).toBe(720)
  })
})

describe('buildExportConfig — YouTube / Discord presets', () => {
  it('YouTube is bitrate-controlled, never CRF', () => {
    const youtubeSettings = { resolution: '1080p', fps: 60, quality: 0.75, hwEncoder: null }
    const cfg = buildExportConfig({
      activeTab: 'youtube',
      outputPath: 'out.mp4',
      youtubeSettings,
      videoModeOverride: 'auto',
    })
    expect(cfg.rateControl).toBe('bitrate')
    expect(cfg.crf).toBeUndefined()
    expect(cfg.videoBitrate).toBe(
      computeYoutubeBitrate(1920, 1080, 60, 0.75),
    )
    expect(cfg.videoBitrate).toBeGreaterThan(0)
  })

  it('Discord is bitrate-controlled and uses 720p dimensions', () => {
    const discordSettings = { tier: 'free', fps: 30, hwEncoder: null }
    const cfg = buildExportConfig({
      activeTab: 'discord',
      outputPath: 'out.mp4',
      discordSettings,
      videoModeOverride: 'auto',
      discordDurationSec: 30,
    })
    expect(cfg.rateControl).toBe('bitrate')
    expect(cfg.crf).toBeUndefined()
    expect(cfg.width).toBe(DISCORD_WIDTH)
    expect(cfg.height).toBe(DISCORD_HEIGHT)
    expect(cfg.videoBitrate).toBe(
      computeDiscordVideoBitrate('free', 30),
    )
  })
})

// ── Project canvas / aspect-fit ───────────────────────────────────────────────

describe('aspect helpers', () => {
  it('aspectsMatch treats 1280×720 and 1920×1080 as equal (both 16:9)', () => {
    expect(aspectsMatch(1280, 720, 1920, 1080)).toBe(true)
    expect(aspectsMatch(1080, 1920, 1920, 1080)).toBe(false)
  })

  it('resolveFitMode is stretch when aspect matches, regardless of preset/custom', () => {
    expect(resolveFitMode({ outW: 1280, outH: 720, projectCanvas: CANVAS_16x9 })).toBe('stretch')
    expect(resolveFitMode({ outW: 1280, outH: 720, projectCanvas: CANVAS_16x9, isCustom: true, customFitMode: 'crop' })).toBe('stretch')
  })

  it('resolveFitMode defaults a preset to bars on aspect mismatch (never distort)', () => {
    expect(resolveFitMode({ outW: 1920, outH: 1080, projectCanvas: CANVAS_9x16 })).toBe('bars')
  })

  it('resolveFitMode honors the explicit custom choice on mismatch', () => {
    expect(resolveFitMode({ outW: 1920, outH: 1080, projectCanvas: CANVAS_9x16, isCustom: true, customFitMode: 'crop' })).toBe('crop')
    expect(resolveFitMode({ outW: 1920, outH: 1080, projectCanvas: CANVAS_9x16, isCustom: true, customFitMode: 'stretch' })).toBe('stretch')
  })
})

describe('buildExportConfig — canvas fit', () => {
  const baseCustom2 = { ...baseCustom, fitMode: '' }

  it('YouTube inherits stretch (identity) when its aspect matches the project', () => {
    const cfg = buildExportConfig({
      activeTab: 'youtube',
      outputPath: 'out.mp4',
      youtubeSettings: { resolution: '1080p', fps: 60, quality: 0.75, hwEncoder: null },
      videoModeOverride: 'auto',
      projectCanvas: CANVAS_16x9,
    })
    expect(cfg.fitMode).toBe('stretch')
  })

  it('YouTube gets bars when project is vertical (16:9 preset vs 9:16 project)', () => {
    const cfg = buildExportConfig({
      activeTab: 'youtube',
      outputPath: 'out.mp4',
      youtubeSettings: { resolution: '1080p', fps: 60, quality: 0.75, hwEncoder: null },
      videoModeOverride: 'auto',
      projectCanvas: CANVAS_9x16,
    })
    expect(cfg.fitMode).toBe('bars')
  })

  it('Custom override can differ from the project canvas and carries the fit mode', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: 'out.mp4',
      // Project is 9:16, custom output is 16:9 1920×1080 → mismatch → crop.
      customSettings: { ...baseCustom2, resolution: '1920x1080', fitMode: 'crop' },
      videoModeOverride: 'auto',
      projectCanvas: CANVAS_9x16,
    })
    expect(cfg.width).toBe(1920)
    expect(cfg.height).toBe(1080)
    expect(cfg.fitMode).toBe('crop')
  })

  it('Custom matching the project aspect resolves to stretch even with a stale fitMode', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: 'out.mp4',
      customSettings: { ...baseCustom2, resolution: '1920x1080', fitMode: 'crop' },
      videoModeOverride: 'auto',
      projectCanvas: CANVAS_16x9,
    })
    expect(cfg.fitMode).toBe('stretch')
  })
})

describe('custom aspect-mismatch guard', () => {
  it('detects when the custom output aspect differs from the project', () => {
    const custom16x9 = { ...baseCustom, resolution: '1920x1080' }
    expect(customAspectMismatch(custom16x9, CANVAS_16x9)).toBe(false)
    expect(customAspectMismatch(custom16x9, CANVAS_9x16)).toBe(true)
  })
})

describe('makeCustomDefaults — project canvas seeding', () => {
  it('seeds resolution + fps from the project canvas', () => {
    const d = makeCustomDefaults(CANVAS_9x16)
    expect(d.customWidth).toBe(1080)
    expect(d.customHeight).toBe(1920)
    expect(d.fps).toBe(24)
    expect(d.resolution).toBe('custom') // 1080×1920 is not a 16:9 preset
  })

  it('matches a known 16:9 preset id when the canvas matches', () => {
    const d = makeCustomDefaults(CANVAS_16x9)
    expect(d.resolution).toBe('1920x1080')
    expect(d.fps).toBe(30)
  })

  it('falls back to factory defaults with no project canvas', () => {
    const d = makeCustomDefaults()
    expect(d.customWidth).toBe(1920)
    expect(d.fps).toBe(60)
  })
})

describe('describeExportSummary', () => {
  it('summarizes dims, fps, codec, rate control and audio', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: '',
      customSettings: { ...baseCustom, resolution: '1920x1080', useCrf: true, crf: 18 },
      videoModeOverride: 'auto',
      projectCanvas: CANVAS_16x9,
    })
    const s = describeExportSummary(cfg)
    expect(s).toContain('1920×1080')
    expect(s).toContain('60 fps')
    expect(s).toContain('CRF 18')
    expect(s).toContain('AAC')
  })

  it('annotates a cropped output', () => {
    const cfg = buildExportConfig({
      activeTab: 'custom',
      outputPath: '',
      customSettings: { ...baseCustom, resolution: '1920x1080', fitMode: 'crop' },
      videoModeOverride: 'auto',
      projectCanvas: CANVAS_9x16,
    })
    expect(describeExportSummary(cfg)).toContain('cropped to fill')
  })
})

/**
 * Pure canvas drawing functions for the timeline.
 * All functions expect the canvas context to already be scaled for DPR.
 */

import {
  TRACK_HEIGHT, BEATS_PER_BAR, SUBDIVISIONS, SUB_GRID_THRESHOLD,
  CLIP_MIN_WIDTH_PX, PPQ,
  beatToPixel,
} from '../../constants/timeline.js'
import { labelHexColor } from '../../constants/labels.js'
import { drawEnvelope, drawTrace, drawWaveformLine, drawSamplePoints, getRegime } from '../../utils/waveformRenderer.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { normalizeTrackPalette, TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { getRegionPlaybackDurationSec } from './regionDuration.js'
import { getSyllableDisplayNumber } from '../SyllableSplitter/syllableModel.js'

// Default engine sample rate (used for spp computation when no per-region rate is known)
const DEFAULT_SR = 48000

// ── Theme palette ────────────────────────────────────────────────────────────
// Resolve all CSS custom properties used by the Timeline canvas exactly once
// per draw cycle. Callers (TimelineCanvas.redrawGrid/redrawContent and
// TimelineRuler.redraw) call this and thread the returned object into draw
// functions, avoiding ~17 getComputedStyle reads spread across hot draw paths.
//
// Pattern mirrors PianoRollCanvas.resolvePalette (Pass 4A.0/4A.1).

export function resolveTimelinePalette() {
  return {
    // Surfaces
    bg:                tokenValue('--theme-timeline-lane-bg'),
    laneSeparator:     tokenValue('--theme-border-strong'),
    patternLaneTint:   tokenValue('--theme-timeline-pattern-lane-tint'),
    // Grid (gridMinor is a base color whose alpha is scaled per subdivision level)
    gridMinor:         tokenValue('--theme-timeline-subdivision-line'),
    gridBeat:          tokenValue('--theme-timeline-beat-line'),
    gridBar:           tokenValue('--theme-timeline-bar-line'),
    // Ruler
    rulerBg:           tokenValue('--theme-bg-secondary'),
    rulerText:         tokenValue('--theme-text-placeholder'),
    rulerBorder:       tokenValue('--theme-border-subtle'),
    rulerGridMinor:    tokenValue('--theme-timeline-subdivision-line'),
    // Playhead
    playheadLine:      tokenValue('--theme-timeline-playhead-line'),
    playheadAccent:    tokenValue('--theme-border-focus'),
    // Clip / pattern material
    clipLabel:         tokenValue('--theme-timeline-clip-title-fg'),
    clipFadeOverlay:   tokenValue('--theme-timeline-fade-curve-fill'),
    clipWaveformFg:    tokenValue('--theme-timeline-clip-waveform-fg'),
    clipWaveformBg:    tokenValue('--theme-timeline-clip-waveform-bg'),
    clipPitchBoxBg:    tokenValue('--theme-timeline-fade-curve-fill'),
    clipPitchBoxFg:    tokenValue('--theme-text'),
    patternLabel:      tokenValue('--theme-timeline-clip-title-fg'),
    patternGlyphBg:    tokenValue('--theme-timeline-fade-curve-fill'),
    selectionHighlight:tokenValue('--theme-border-focus'),
    // Tool overlays
    loopBrace:         tokenValue('--theme-timeline-loop-brace'),
    accent:            tokenValue('--theme-accent'),
    danger:            tokenValue('--theme-danger'),
    fgInverse:         tokenValue('--theme-fg-inverse'),
    // Depth
    wellTopShadow:     tokenValue('--theme-timeline-well-top-shadow'),
    // Track palette — resolved once per redraw, threaded into draw functions
    trackPalette: normalizeTrackPalette(
      Array.from({ length: 16 }, (_, i) => tokenValue(`--theme-track-palette-${i + 1}`))
    ),
  }
}

// withAlpha — return a CSS color string with its alpha scaled by `mult`,
// clamped to [0, 1]. Supports rgba(), rgb(), #RRGGBB, #RGB. Any other input
// (hsl, named colors, custom themes) is returned unchanged so canvas drawing
// never breaks. Empty/whitespace input also returns unchanged.
export function withAlpha(color, mult) {
  if (color == null) return color
  const s = typeof color === 'string' ? color.trim() : ''
  if (!s) return color
  const m = Math.max(0, Math.min(1, Number(mult) || 0))

  // rgba(r,g,b,a) or rgb(r,g,b)
  const rgbaMatch = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (rgbaMatch) {
    const r = rgbaMatch[1], g = rgbaMatch[2], b = rgbaMatch[3]
    const a = rgbaMatch[4] != null ? Number(rgbaMatch[4]) : 1
    const scaled = Math.max(0, Math.min(1, a * m))
    return `rgba(${r},${g},${b},${scaled})`
  }

  // #RRGGBB
  const hex6 = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex6) {
    const r = parseInt(hex6[1], 16), g = parseInt(hex6[2], 16), b = parseInt(hex6[3], 16)
    return `rgba(${r},${g},${b},${m})`
  }

  // #RGB
  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (hex3) {
    const r = parseInt(hex3[1] + hex3[1], 16)
    const g = parseInt(hex3[2] + hex3[2], 16)
    const b = parseInt(hex3[3] + hex3[3], 16)
    return `rgba(${r},${g},${b},${m})`
  }

  // Unknown form (hsl, color(), named color) — leave it alone so the draw
  // produces something visible. A future custom theme cannot break grid/ruler.
  return color
}

// Cubic bezier gain helper (CSS convention: P0=(0,0) P3=(1,1)).
// Returns gain [0,1] for a normalized position xNorm [0,1] within the fade region.
function _bezierGain(xNorm, x1, y1, x2, y2) {
  let t = xNorm
  for (let i = 0; i < 5; i++) {
    const omt = 1 - t
    const bx = 3 * omt * omt * t * x1 + 3 * omt * t * t * x2 + t * t * t
    const dbx = 3 * omt * omt * x1 + 6 * omt * t * (x2 - x1) + 3 * t * t * (1 - x2)
    if (Math.abs(dbx) < 1e-6) break
    t -= (bx - xNorm) / dbx
    t = Math.max(0, Math.min(1, t))
  }
  const omt = 1 - t
  return 3 * omt * omt * t * y1 + 3 * omt * t * t * y2 + t * t * t
}

// ── Track row geometry ───────────────────────────────────────────────────────
// FXG.4-h-r1: macro automation child lanes insert vertical space below their
// parent track, so a track's Y top is no longer `index * TRACK_HEIGHT`. When a
// `trackLayout` (see timelineRowLayout.js) is threaded in, draw paths resolve the
// shifted top through it; without one they fall back to the contiguous geometry
// so callers/tests that don't use lanes are unaffected.
function _trackTop(trackIndex, trackLayout) {
  if (trackLayout && typeof trackLayout.trackTop === 'function') {
    return trackLayout.trackTop(trackIndex)
  }
  return trackIndex * TRACK_HEIGHT
}

// ── Grid (background layer) ──────────────────────────────────────────────────

function _clipFadePercent(clip, percentKey, ticksKey) {
  const percent = Number(clip?.[percentKey])
  if (Number.isFinite(percent)) return Math.min(100, Math.max(0, percent))
  const ticks = Number(clip?.[ticksKey])
  const duration = Number(clip?.durationTicks)
  if (!Number.isFinite(ticks) || !Number.isFinite(duration) || ticks <= 0 || duration <= 0) return 0
  return Math.min(100, Math.max(0, (ticks * 100) / duration))
}

function _normalizedClipFadePercents(clip) {
  let fadeInPercent = _clipFadePercent(clip, 'fadeInPercent', 'fadeInTicks')
  let fadeOutPercent = _clipFadePercent(clip, 'fadeOutPercent', 'fadeOutTicks')
  const total = fadeInPercent + fadeOutPercent
  if (total > 100) {
    const scale = 100 / total
    fadeInPercent *= scale
    fadeOutPercent *= scale
  }
  return { fadeInPercent, fadeOutPercent }
}

export function drawGrid(ctx, w, h, scrollOffset, ppb, trackCount, tracks = null, palette = null, trackLayout = null) {
  ctx.clearRect(0, 0, w, h)
  const p = palette ?? resolveTimelinePalette()

  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1

  // Pattern-track row tint (neutral — pattern tracks no longer bind to a region)
  if (tracks) {
    ctx.fillStyle = p.patternLaneTint
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      if (t?.type !== 'Pattern') continue
      const y = _trackTop(i, trackLayout)
      if (y >= h) break
      ctx.fillRect(0, y, w, TRACK_HEIGHT)
    }
  }

  // FXG.4-h-r1: faint band fill behind each macro automation child lane so the
  // lane reads as attached, bounded space even before the DOM lane layer paints.
  if (trackLayout && Array.isArray(trackLayout.rows)) {
    ctx.fillStyle = withAlpha(p.laneSeparator, 0.10)
    for (const r of trackLayout.rows) {
      if (r.rowType !== 'macroAutomation') continue
      if (r.y >= h) break
      ctx.fillRect(0, r.y, w, r.height)
    }
  }

  // Track / lane separator lines (horizontal)
  ctx.strokeStyle = p.laneSeparator
  ctx.lineWidth = 1
  ctx.beginPath()
  if (trackLayout && Array.isArray(trackLayout.rows)) {
    for (const r of trackLayout.rows) {
      const y = Math.round(r.y) + 0.5
      if (y > h) break
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
    }
    const bottom = Math.round(trackLayout.totalHeight) + 0.5
    if (bottom <= h) { ctx.moveTo(0, bottom); ctx.lineTo(w, bottom) }
  } else {
    for (let i = 0; i <= trackCount; i++) {
      const y = Math.round(i * TRACK_HEIGHT) + 0.5
      if (y > h) break
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
    }
  }
  ctx.stroke()

  // Subdivision lines — progressive detail at increasing zoom levels.
  // Multipliers preserve the historical [0.03, 0.025, 0.02, 0.015] alpha
  // ladder relative to the gridMinor token's base alpha.
  // 16th notes (ppb > 80), 32nd (> 400), 64th (> 2000), 128th (> 10000)
  const subLevels = [
    { divPerBeat: 4,   threshold: SUB_GRID_THRESHOLD, mult: 1.0  },  // 16th
    { divPerBeat: 8,   threshold: 400,                mult: 0.83 }, // 32nd
    { divPerBeat: 16,  threshold: 2000,               mult: 0.67 }, // 64th
    { divPerBeat: 32,  threshold: 10000,              mult: 0.5  }, // 128th
  ]
  for (const { divPerBeat, threshold, mult } of subLevels) {
    if (ppb <= threshold) continue
    ctx.strokeStyle = withAlpha(p.gridMinor, mult)
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let beat = startBeat; beat <= endBeat; beat++) {
      for (let sub = 1; sub < divPerBeat; sub++) {
        // Skip subdivisions already drawn by coarser levels
        if (divPerBeat > 4 && sub % (divPerBeat / 4) === 0) continue
        const subBeat = beat + sub / divPerBeat
        const x = Math.round(beatToPixel(subBeat, scrollOffset, ppb)) + 0.5
        if (x < 0) continue
        if (x > w) break
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
      }
    }
    ctx.stroke()
  }

  // Beat lines (vertical, minor)
  ctx.strokeStyle = p.gridBeat
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let beat = startBeat; beat <= endBeat; beat++) {
    if (beat % BEATS_PER_BAR === 0) continue // bars drawn separately
    const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
    if (x < 0) continue
    if (x > w) break
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Bar lines (vertical, major — every BEATS_PER_BAR beats)
  ctx.strokeStyle = p.gridBar
  ctx.lineWidth = 1
  ctx.beginPath()
  const firstBar = Math.floor(startBeat / BEATS_PER_BAR) * BEATS_PER_BAR
  for (let beat = firstBar; beat <= endBeat; beat += BEATS_PER_BAR) {
    const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
    if (x < 0) continue
    if (x > w) break
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Top-edge well shadow — one full-width gradient (~14px) drawn after grid
  // lines so the falloff stays above subdivisions/beats. Skipped if the token
  // is empty/transparent so themes can opt out.
  const wellTop = p.wellTopShadow
  if (wellTop && wellTop.trim() !== '' && wellTop.trim() !== 'transparent') {
    const grad = ctx.createLinearGradient(0, 0, 0, 14)
    grad.addColorStop(0, wellTop)
    grad.addColorStop(1, withAlpha(wellTop, 0))
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, 14)
  }
}

// ── Ruler ────────────────────────────────────────────────────────────────────

export function drawRuler(ctx, w, h, scrollOffset, ppb, palette = null) {
  const p = palette ?? resolveTimelinePalette()

  // Background
  ctx.fillStyle = p.rulerBg
  ctx.fillRect(0, 0, w, h)

  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1

  // Beat tick marks
  ctx.strokeStyle = p.rulerBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let beat = startBeat; beat <= endBeat; beat++) {
    const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
    if (x < 0) continue
    if (x > w) break

    const isBar = beat % BEATS_PER_BAR === 0
    const tickH = isBar ? h * 0.6 : h * 0.3
    ctx.moveTo(x, h)
    ctx.lineTo(x, h - tickH)
  }
  ctx.stroke()

  // Subdivision ticks (progressive detail like grid).
  // Multipliers preserve the historical [0.06, 0.04, 0.03, 0.02] alpha ladder
  // relative to the gridMinor token base — twice the strength of the main grid
  // so ruler subdivisions stay readable.
  {
    const rulerSubLevels = [
      { divPerBeat: 4,  threshold: SUB_GRID_THRESHOLD, mult: 2.0, tickFrac: 0.15 },
      { divPerBeat: 8,  threshold: 400,                mult: 1.33,tickFrac: 0.10 },
      { divPerBeat: 16, threshold: 2000,               mult: 1.0, tickFrac: 0.08 },
      { divPerBeat: 32, threshold: 10000,              mult: 0.67,tickFrac: 0.06 },
    ]
    for (const { divPerBeat, threshold, mult, tickFrac } of rulerSubLevels) {
      if (ppb <= threshold) continue
      ctx.strokeStyle = withAlpha(p.rulerGridMinor, mult)
      ctx.lineWidth = 0.5
      ctx.beginPath()
      for (let beat = startBeat; beat <= endBeat; beat++) {
        for (let sub = 1; sub < divPerBeat; sub++) {
          if (divPerBeat > 4 && sub % (divPerBeat / 4) === 0) continue
          const subBeat = beat + sub / divPerBeat
          const x = Math.round(beatToPixel(subBeat, scrollOffset, ppb)) + 0.5
          if (x < 0) continue
          if (x > w) break
          ctx.moveTo(x, h)
          ctx.lineTo(x, h - h * tickFrac)
        }
      }
      ctx.stroke()
    }
  }

  // Bar numbers
  ctx.fillStyle = p.rulerText
  ctx.font = '600 9px "Hanken Grotesk", system-ui, sans-serif'
  ctx.textBaseline = 'top'
  const firstBar = Math.floor(startBeat / BEATS_PER_BAR) * BEATS_PER_BAR
  for (let beat = firstBar; beat <= endBeat; beat += BEATS_PER_BAR) {
    const x = beatToPixel(beat, scrollOffset, ppb)
    if (x < -30) continue
    if (x > w) break
    const barNum = Math.floor(beat / BEATS_PER_BAR) + 1
    ctx.fillText(String(barNum), x + 4, 4)
  }

  // Bottom border
  ctx.strokeStyle = p.rulerBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h - 0.5)
  ctx.lineTo(w, h - 0.5)
  ctx.stroke()
}

// ── Overlay (playhead + selection) ───────────────────────────────────────────

export function drawOverlay(ctx, w, h, scrollOffset, ppb, playheadBeat, palette = null) {
  ctx.clearRect(0, 0, w, h)

  if (playheadBeat == null) return
  const p = palette ?? resolveTimelinePalette()

  const x = Math.round(beatToPixel(playheadBeat, scrollOffset, ppb)) + 0.5

  // Don't draw if off-screen
  if (x < -1 || x > w + 1) return

  // Playhead line
  ctx.strokeStyle = p.playheadLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()

  // Small triangle at top
  ctx.fillStyle = p.playheadAccent
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x - 4, -0) // flat top edge
  ctx.lineTo(x - 4, 0)
  ctx.moveTo(x, 6)
  ctx.lineTo(x - 5, 0)
  ctx.lineTo(x + 5, 0)
  ctx.closePath()
  ctx.fill()
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ── Timeline display settings (Pass 5C body modes & preview gating) ─────────
// Drawing must remain pure: no Zustand import, no window.xleth read,
// no getComputedStyle in inner loops. The store hands us a settings object
// via TimelineCanvas; we normalize it once per redraw and consume it locally.

const TIMELINE_DISPLAY_DRAW_DEFAULTS = Object.freeze({
  timelineClipBodyMode: 'plain',
  timelinePatternBodyMode: 'plain',
  timelineBodyGradientDirection: 'top',
  timelineClipContrast: 'medium',
  timelineShowWaveforms: 'auto',
  timelineShowPatternPreview: 'auto',
  timelineShowClipNames: 'auto',
  timelineShowPitchShift: 'auto',
  timelinePitchShiftStyle: 'chip',
})

const _BODY_MODES = new Set(['minimal', 'plain', 'gradient', 'solid'])
const _GRADIENT_DIRS = new Set(['top', 'bottom'])
const _CONTRAST_VALS = new Set(['low', 'medium', 'high'])
const _VIS_VALS = new Set(['auto', 'always', 'never'])
const _CHIP_STYLES = new Set(['chip'])

function _pickEnum(v, allowed, fallback) {
  return (typeof v === 'string' && allowed.has(v)) ? v : fallback
}

export function normalizeTimelineDisplaySettings(s) {
  const d = TIMELINE_DISPLAY_DRAW_DEFAULTS
  if (!s || typeof s !== 'object') return d
  return {
    timelineClipBodyMode:          _pickEnum(s.timelineClipBodyMode,          _BODY_MODES,    d.timelineClipBodyMode),
    timelinePatternBodyMode:       _pickEnum(s.timelinePatternBodyMode,       _BODY_MODES,    d.timelinePatternBodyMode),
    timelineBodyGradientDirection: _pickEnum(s.timelineBodyGradientDirection, _GRADIENT_DIRS, d.timelineBodyGradientDirection),
    timelineClipContrast:          _pickEnum(s.timelineClipContrast,          _CONTRAST_VALS, d.timelineClipContrast),
    timelineShowWaveforms:         _pickEnum(s.timelineShowWaveforms,         _VIS_VALS,      d.timelineShowWaveforms),
    timelineShowPatternPreview:    _pickEnum(s.timelineShowPatternPreview,    _VIS_VALS,      d.timelineShowPatternPreview),
    timelineShowClipNames:         _pickEnum(s.timelineShowClipNames,         _VIS_VALS,      d.timelineShowClipNames),
    timelineShowPitchShift:        _pickEnum(s.timelineShowPitchShift,        _VIS_VALS,      d.timelineShowPitchShift),
    timelinePitchShiftStyle:       _pickEnum(s.timelinePitchShiftStyle,       _CHIP_STYLES,   d.timelinePitchShiftStyle),
  }
}

function _clampAlpha(a) {
  if (!Number.isFinite(a)) return 0
  if (a < 0) return 0
  if (a > 1) return 1
  return a
}

const _CONTRAST_MUL = { low: 0.82, medium: 1.0, high: 1.18 }
function _contrastMul(c) { return _CONTRAST_MUL[c] ?? 1.0 }

// Body material helper.
// At plain + medium + unmuted, this MUST produce alpha identical to Pass 4B:
//   audio: 0.6 (unselected) / 0.8 (selected)
//   pattern: 0.55 (unselected) / 0.75 (selected)
// kind: 'audio' | 'pattern'
// Returns: { fillStyle (string|CanvasGradient), borderStyle, borderWidth }
function getTimelineBodyMaterial({
  baseHex, mode, selected, muted, contrast,
  gradientDirection, ctx, x, y, w, h, kind,
}) {
  const cm = _contrastMul(contrast)
  const mm = muted ? 0.3 : 1.0

  let fillAlphaA = 0
  let fillAlphaB = 0
  const borderAlpha = 1.0
  const borderWidth = selected ? 2 : 1

  if (mode === 'minimal') {
    fillAlphaA = selected ? 0.26 : 0.18
  } else if (mode === 'gradient') {
    fillAlphaA = selected ? 0.82 : 0.70   // high stop
    fillAlphaB = selected ? 0.48 : 0.38   // low stop
  } else if (mode === 'solid') {
    fillAlphaA = selected ? 0.86 : 0.74
  } else {
    // 'plain' default — Pass 5E.3 raised against the new dark
    // --theme-timeline-lane-bg arrangement bed so clips/patterns pop.
    // Old (Pass 4B/5C) values: audio 0.60/0.80, pattern 0.55/0.75.
    if (kind === 'audio') {
      fillAlphaA = selected ? 0.90 : 0.80
    } else {
      fillAlphaA = selected ? 0.86 : 0.72
    }
  }

  const aFinal = _clampAlpha(fillAlphaA * cm * mm)
  const bFinal = _clampAlpha(fillAlphaB * cm * mm)

  let fillStyle
  if (mode === 'gradient') {
    const grad = ctx.createLinearGradient(x, y, x, y + h)
    if (gradientDirection === 'bottom') {
      grad.addColorStop(0, hexToRgba(baseHex, bFinal))
      grad.addColorStop(1, hexToRgba(baseHex, aFinal))
    } else {
      grad.addColorStop(0, hexToRgba(baseHex, aFinal))
      grad.addColorStop(1, hexToRgba(baseHex, bFinal))
    }
    fillStyle = grad
  } else {
    fillStyle = hexToRgba(baseHex, aFinal)
  }

  return {
    fillStyle,
    borderStyle: hexToRgba(baseHex, _clampAlpha(borderAlpha)),
    borderWidth,
  }
}

// ── Clips (content layer) ───────────────────────────────────────────────────

const CLIP_PAD = 2         // top/bottom padding within track lane
const CLIP_TEXT_PAD = 6    // horizontal text padding inside clip
const HANDLE_W = 4         // resize handle width (selected only)

// ── Pass 5D internal block layout ───────────────────────────────────────────
// Reserved title-strip + measured truncation + bottom-right metadata chips.
// Drawing-only; never affects outer block geometry, hit-testing, or behavior.
const TITLE_STRIP_H        = 16
const TITLE_STRIP_TOP      = 0
const TITLE_STRIP_MIN_H    = 28   // below this clipH the strip is suppressed
const TITLE_TEXT_PAD_X     = 6
const TITLE_CONTENT_GAP    = 2
const CHIP_H               = 12
const CHIP_GAP             = 3
const CHIP_PAD_X           = 5
const CHIP_RIGHT_INSET     = 6
const CHIP_BOTTOM_INSET    = 4
const NAME_AUTO_MIN_W      = 48
const NAME_ALWAYS_MIN_W    = 18
const META_AUTO_MIN_W      = 72
const META_ALWAYS_MIN_W    = 40
const TINY_CLIP_MAX_W      = 24
const PATTERN_LOOP_GLYPH_RESERVE = 14

function getTimelineBlockInnerLayout({ x, y, w, h, kind, showTitleStrip }) {
  const useStrip = !!showTitleStrip && h >= TITLE_STRIP_MIN_H
  const titleH   = useStrip ? TITLE_STRIP_H : 0
  const titleY   = y + TITLE_STRIP_TOP
  const titleX   = x
  const titleW   = w
  const contentY = useStrip ? (titleY + titleH + TITLE_CONTENT_GAP) : y
  const contentH = useStrip ? Math.max(0, h - titleH - TITLE_CONTENT_GAP) : h
  const contentX = x
  const contentW = w
  const metadataArea = {
    rightX:  x + w - CHIP_RIGHT_INSET,
    bottomY: y + h - CHIP_BOTTOM_INSET,
    height:  CHIP_H,
  }
  return {
    titleX, titleY, titleW, titleH,
    contentX, contentY, contentW, contentH,
    metadataArea, useStrip, kind,
  }
}

function fitText(ctx, text, maxWidth, { allowBareEllipsis = false } = {}) {
  if (!text || maxWidth <= 0) return ''
  const full = String(text)
  if (ctx.measureText(full).width <= maxWidth) return full
  const ELL = '…'
  const ellW = ctx.measureText(ELL).width
  if (ellW > maxWidth) return ''
  let lo = 0, hi = full.length, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const w = ctx.measureText(full.slice(0, mid) + ELL).width
    if (w <= maxWidth) { best = mid; lo = mid + 1 }
    else { hi = mid - 1 }
  }
  if (best > 0) return full.slice(0, best) + ELL
  return allowBareEllipsis ? ELL : ''
}

function getTitleStripStyle(baseHex, mode, selected, muted, contrast) {
  const cm = _contrastMul(contrast)
  const mm = muted ? 0.3 : 1.0
  let stripA
  if (mode === 'minimal')       stripA = selected ? 0.34 : 0.26
  else if (mode === 'gradient') stripA = selected ? 0.88 : 0.78
  else if (mode === 'solid')    stripA = selected ? 0.92 : 0.84
  else                          stripA = selected ? 0.92 : 0.80
  const fill      = hexToRgba(baseHex, _clampAlpha(stripA * cm * mm))
  const separator = hexToRgba(baseHex, _clampAlpha(0.55 * cm * mm))
  return { fill, separator }
}

// Chip data is built from the same fields the existing inline metadata block
// reads (lines that previously rendered the loose pitch/REV/stretch/dB text).
// Do NOT introduce alternate field names here.
function buildClipMetadataChips(clip) {
  const semis = clip.pitchOffset      ?? 0
  const cents = clip.pitchOffsetCents ?? 0
  const ratio = clip.stretchRatio     ?? 1.0
  const rev   = !!clip.reversed
  const vel   = clip.velocity

  const procParts = []
  if (semis !== 0) procParts.push(`${semis > 0 ? '+' : ''}${semis}st`)
  if (cents !== 0) procParts.push(`${cents > 0 ? '+' : ''}${cents}c`)
  if (rev) procParts.push('REV')
  if (Math.abs(ratio - 1.0) > 0.001) procParts.push(`${ratio.toFixed(2)}×`)

  const chips = []
  if (procParts.length) chips.push({ kind: 'proc', text: procParts.join(' ') })
  if (Number.isFinite(vel) && vel > 0) {
    const db = 20 * Math.log10(vel)
    if (Math.abs(db) >= 0.1) {
      chips.push({ kind: 'gain', text: `${db > 0 ? '+' : ''}${db.toFixed(1)}dB` })
    }
  }
  return chips
}

function drawMetadataChips(ctx, chips, area, palette, { handleReserveRight = 0, leftLimit }) {
  if (!chips.length) return
  ctx.font = '500 9px "Hanken Grotesk", system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  const proc = chips.find(c => c.kind === 'proc')
  const gain = chips.find(c => c.kind === 'gain')

  const measure = (chip) => {
    const tw = ctx.measureText(chip.text).width
    return { ...chip, width: Math.ceil(tw + CHIP_PAD_X * 2) }
  }
  const procM = proc ? measure(proc) : null
  const gainM = gain ? measure(gain) : null

  const rightX = area.rightX - handleReserveRight
  const top    = area.bottomY - area.height
  const fits   = (rightEdge, w) => (rightEdge - w) >= leftLimit
  const paint  = (chip, rightEdge) => {
    const left = rightEdge - chip.width
    ctx.fillStyle = palette.clipPitchBoxBg
    ctx.fillRect(left, top, chip.width, area.height)
    ctx.fillStyle = palette.clipPitchBoxFg
    ctx.fillText(chip.text, left + CHIP_PAD_X, top + area.height / 2)
    return left
  }

  // Processing chip wins the rightmost slot. Gain only fits if it has room.
  if (procM && gainM) {
    if (fits(rightX, procM.width)) {
      const procLeft = paint(procM, rightX)
      const gainRight = procLeft - CHIP_GAP
      if (fits(gainRight, gainM.width)) paint(gainM, gainRight)
    }
    return
  }
  if (procM) {
    if (fits(rightX, procM.width)) paint(procM, rightX)
    return
  }
  if (gainM) {
    if (fits(rightX, gainM.width)) paint(gainM, rightX)
  }
}

export function drawClips(ctx, w, h, scrollOffset, ppb, clips, trackIdToIndex, regions, selectedClipIds, waveformCache, hiResCache, clipPeakCache, bpm, mutedTrackIds, palette = null, timelineDisplaySettings = null, trackColorById = null, trackLayout = null) {
  ctx.clearRect(0, 0, w, h)
  if (!clips || clips.length === 0) return
  const p = palette ?? resolveTimelinePalette()
  const ds = normalizeTimelineDisplaySettings(timelineDisplaySettings)
  const wfMode = ds.timelineShowWaveforms
  const wfMinW = wfMode === 'always' ? 16 : 24

  const clipH = TRACK_HEIGHT - CLIP_PAD * 2
  let visibleCount = 0

  // Global regime detection — spp is the same for all clips at a given zoom
  const pixelsPerSecond = bpm ? ppb * (bpm / 60) : 0
  const spp = pixelsPerSecond > 0 ? DEFAULT_SR / pixelsPerSecond : 9999
  const regime = getRegime(spp)

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const beatPos = clip.positionTicks / PPQ
    const beatDur = clip.durationTicks / PPQ

    const x = beatToPixel(beatPos, scrollOffset, ppb)
    let clipW = beatDur * ppb
    if (clipW < CLIP_MIN_WIDTH_PX) clipW = CLIP_MIN_WIDTH_PX

    // Cull off-screen
    if (x + clipW < 0 || x > w) continue
    visibleCount++

    const trackIdx = trackIdToIndex[clip.trackId]
    if (trackIdx == null) continue
    const y = _trackTop(trackIdx, trackLayout) + CLIP_PAD

    const region = regions[clip.regionId]
    const fallbackHex = labelHexColor(region?.label)
    const hex = trackColorById?.[clip.trackId] || fallbackHex
    const selected = selectedClipIds.has(clip.id)
    const isMuted = mutedTrackIds?.has(clip.trackId)
    const mutedMul = isMuted ? 0.3 : 1.0

    // ── Body material (Pass 5C) ──────────────────────────────────────────
    const _mat = getTimelineBodyMaterial({
      baseHex: hex,
      mode: ds.timelineClipBodyMode,
      selected,
      muted: !!isMuted,
      contrast: ds.timelineClipContrast,
      gradientDirection: ds.timelineBodyGradientDirection,
      ctx, x, y, w: clipW, h: clipH,
      kind: 'audio',
    })

    // ── Fill ──────────────────────────────────────────────────────────────
    ctx.fillStyle = _mat.fillStyle
    ctx.fillRect(x, y, clipW, clipH)

    // ── Border ────────────────────────────────────────────────────────────
    ctx.strokeStyle = _mat.borderStyle
    ctx.lineWidth = _mat.borderWidth
    ctx.strokeRect(x, y, clipW, clipH)

    // ── Selected-state inner highlight ring (Pass 4B) ─────────────────────
    // One bounded 1px stroke just inside the colored border. Preserves the
    // per-track semantic hex identity of the clip while making selection
    // visibly clearer in both dark and light themes.
    if (selected && clipW > 4 && clipH > 4) {
      ctx.strokeStyle = p.selectionHighlight
      ctx.lineWidth = 1
      ctx.strokeRect(x + 1.5, y + 1.5, clipW - 3, clipH - 3)
    }

    // ── Pass 5D internal layout (title strip + content region) ───────────
    const showName = ds.timelineShowClipNames
    const showMeta = ds.timelineShowPitchShift
    const _wantTitleStrip = showName !== 'never' && clipW > TINY_CLIP_MAX_W
    const layout = getTimelineBlockInnerLayout({
      x, y, w: clipW, h: clipH, kind: 'audio',
      showTitleStrip: _wantTitleStrip,
    })

    // ── Waveform inside clip ─────────────────────────────────────────────
    // Pass 5C: gated by timelineShowWaveforms.
    //   never  → never draw (caches untouched, cache regime unchanged)
    //   always → draw at clipW >= 16
    //   auto   → draw at clipW >= 24
    if (wfMode !== 'never' && clipW >= wfMinW && bpm && region) {
      // Swap-aware: extend draw span past video range when swapped audio is longer.
      const regionDurSec = getRegionPlaybackDurationSec(region)

      // Visible pixel range (clip ∩ viewport)
      const visL = Math.max(0, x)
      const visR = Math.min(w, x + clipW)

      if (regionDurSec > 0 && visR > visL) {
      const regionDurTicks = regionDurSec * (bpm / 60) * PPQ
      const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
      const regionOffsetSec = ((clip.regionOffsetTicks ?? 0) / PPQ) / (bpm / 60)

      // Map visible pixels to seconds within the region (for unprocessed clips)
      const secPerPx = clipDurSec / clipW
      const visStartSec = regionOffsetSec + (visL - x) * secPerPx
      const visEndSec   = regionOffsetSec + (visR - x) * secPerPx

      // Clip-local time coordinates: 0 = start of processed buffer, clipDurSec = end.
      // Used for processed clips (stretch/pitch/reverse).
      const clipLocalStart = (visL - x) * secPerPx
      const clipLocalEnd   = (visR - x) * secPerPx

      const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                         || (clip.pitchOffsetCents ?? 0) !== 0
                         || clip.reversed
                         || ((clip.stretchRatio ?? 1.0) !== 1.0)

      ctx.save()
      ctx.beginPath()
      ctx.rect(layout.contentX, layout.contentY, layout.contentW, layout.contentH)
      ctx.clip()

      const envAlpha = selected ? 0.45 : 0.25
      const rmsAlpha = selected ? 0.30 : 0.15
      const lineColor = selected ? p.clipWaveformFg : withAlpha(p.clipWaveformFg, 0.7)
      const traceFill = selected ? p.clipWaveformBg : withAlpha(p.clipWaveformBg, 0.55)

      let drawn = false

      // ── Try hi-res cache for trace/waveform/sample regimes ──────────
      if (regime !== 'envelope' && hiResCache) {
        // Processed clips: keyed by "c"+clipId with clip-local time coords.
        // Unprocessed clips: keyed by regionId with region-relative time coords.
        const hiRes = hasProcessing
          ? hiResCache[`c${clip.id}`]
          : hiResCache[clip.regionId]
        const hiResVisStart = hasProcessing ? clipLocalStart : visStartSec
        const hiResVisEnd   = hasProcessing ? clipLocalEnd   : visEndSec

        if (!hasProcessing && regime === 'sample' && hiRes?.samples) {
          // Regime 4: individual sample dots (unprocessed only)
          const sr = hiRes.sampleRate || DEFAULT_SR
          const visStartSample = Math.floor(hiResVisStart * sr)
          const visEndSample   = Math.ceil(hiResVisEnd   * sr)
          const dataOffset = visStartSample - hiRes.startSample
          const dataCount  = visEndSample - visStartSample
          if (dataOffset >= 0 && dataOffset + dataCount <= hiRes.samples.length) {
            drawSamplePoints(ctx, hiRes.samples, visL, layout.contentY, visR - visL, layout.contentH,
              dataOffset, dataCount, lineColor)
            drawn = true
          }
        } else if (hiRes?.peaks && hiRes.stride === 3) {
          // Regime 2 (trace) or 3 (waveform): hi-res peaks
          const totalHiCols = Math.floor(hiRes.peaks.length / 3)
          const hiDur = hiRes.endSec - hiRes.startSec
          if (hiDur > 0 && totalHiCols > 0) {
            const f0 = Math.max(0, (hiResVisStart - hiRes.startSec) / hiDur)
            const f1 = Math.min(1, (hiResVisEnd   - hiRes.startSec) / hiDur)
            const startCol = Math.floor(f0 * totalHiCols)
            const endCol   = Math.min(totalHiCols, Math.ceil(f1 * totalHiCols))
            if (endCol > startCol) {
              if (regime === 'trace') {
                drawTrace(ctx, hiRes.peaks, visL, layout.contentY, visR - visL, layout.contentH,
                  startCol, endCol, traceFill, lineColor)
              } else {
                drawWaveformLine(ctx, hiRes.peaks, visL, layout.contentY, visR - visL, layout.contentH,
                  startCol, endCol, lineColor)
              }
              drawn = true
            }
          }
        }
      }

      // ── Fallback: low-res envelope ───────────────────────────────────
      if (!drawn) {
        if (hasProcessing && clipPeakCache) {
          // Processed clip: use clip-level peaks (full processed buffer, 0..clipDurSec).
          const cpData = clipPeakCache[clip.id]
          if (cpData?.peaks && cpData.stride === 3) {
            const totalCols = Math.floor(cpData.peaks.length / 3)
            // Map visible pixel range to fraction of the processed clip
            const f0 = Math.max(0, clipLocalStart / clipDurSec)
            const f1 = Math.min(1, clipLocalEnd   / clipDurSec)
            const startCol = Math.floor(f0 * totalCols)
            const endCol   = Math.min(totalCols, Math.ceil(f1 * totalCols))
            if (endCol > startCol) {
              if (regime === 'trace') {
                drawTrace(ctx, cpData.peaks, x, layout.contentY, clipW, layout.contentH,
                  startCol, endCol, traceFill, lineColor)
              } else {
                drawEnvelope(ctx, cpData.peaks, x, layout.contentY, clipW, layout.contentH,
                  startCol, endCol,
                  `rgba(255,255,255,${envAlpha})`,
                  `rgba(255,255,255,${rmsAlpha})`)
              }
            }
          }
        } else if (!hasProcessing && waveformCache) {
          // Unprocessed clip: use raw region peaks with regionOffset applied.
          const wfData = waveformCache[clip.regionId]
          if (wfData?.peaks && wfData.stride === 3) {
            const totalPeakCols = Math.floor(wfData.peaks.length / 3)
            const offsetFrac = (clip.regionOffsetTicks ?? 0) / regionDurTicks
            const durFrac = clip.durationTicks / regionDurTicks
            const startCol = Math.floor(offsetFrac * totalPeakCols)
            const endCol = Math.min(totalPeakCols, Math.ceil((offsetFrac + durFrac) * totalPeakCols))

            if (endCol > startCol) {
              if (regime === 'trace') {
                drawTrace(ctx, wfData.peaks, x, layout.contentY, clipW, layout.contentH,
                  startCol, endCol, traceFill, lineColor)
              } else {
                drawEnvelope(ctx, wfData.peaks, x, layout.contentY, clipW, layout.contentH,
                  startCol, endCol,
                  `rgba(255,255,255,${envAlpha})`,
                  `rgba(255,255,255,${rmsAlpha})`)
              }
            }
          }
        }
      }

      ctx.restore()
      } // regionDurSec > 0 && visR > visL
    }

    // ── Fade overlay ──────────────────────────────────────────────────────
    const { fadeInPercent, fadeOutPercent } = _normalizedClipFadePercents(clip)

    if ((fadeInPercent > 0 || fadeOutPercent > 0) && clipW > 4) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, clipW, clipH)
      ctx.clip()

      ctx.fillStyle = p.clipFadeOverlay

      // Fade-in overlay
      if (fadeInPercent > 0) {
        const fadeInPx = clipW * Math.min(100, Math.max(0, fadeInPercent)) / 100
        const steps = Math.min(Math.max(Math.ceil(fadeInPx / 2), 8), 64)
        const x1 = clip.fadeInX1 ?? 0, y1 = clip.fadeInY1 ?? 0
        const x2 = clip.fadeInX2 ?? 1, y2 = clip.fadeInY2 ?? 1
        ctx.beginPath()
        ctx.moveTo(x, y)
        for (let i = 0; i <= steps; i++) {
          const frac = i / steps
          const g = _bezierGain(frac, x1, y1, x2, y2)
          ctx.lineTo(x + frac * fadeInPx, y + clipH * (1 - g))
        }
        ctx.lineTo(x + fadeInPx, y)
        ctx.closePath()
        ctx.fill()
      }

      // Fade-out overlay
      if (fadeOutPercent > 0) {
        const fadeOutPx = clipW * Math.min(100, Math.max(0, fadeOutPercent)) / 100
        const steps = Math.min(Math.max(Math.ceil(fadeOutPx / 2), 8), 64)
        const x1 = clip.fadeOutX1 ?? 0, y1 = clip.fadeOutY1 ?? 0
        const x2 = clip.fadeOutX2 ?? 1, y2 = clip.fadeOutY2 ?? 1
        ctx.beginPath()
        ctx.moveTo(x + clipW, y)
        for (let i = 0; i <= steps; i++) {
          const frac = i / steps
          const g = _bezierGain(frac, x1, y1, x2, y2)
          ctx.lineTo(x + clipW - frac * fadeOutPx, y + clipH * (1 - g))
        }
        ctx.lineTo(x + clipW - fadeOutPx, y)
        ctx.closePath()
        ctx.fill()
      }

      ctx.restore()
    }

    // ── Pass 5D: title strip + name + metadata chips ─────────────────────
    // Tiny clips (<= 24px) show body/border/handles only.
    if (clipW > TINY_CLIP_MAX_W) {
      const handleReserveRight = (selected && clipW > HANDLE_W * 3) ? HANDLE_W : 0
      const handleReserveLeft  = (selected && clipW > HANDLE_W * 3) ? HANDLE_W : 0

      // Title strip background + name
      if (layout.useStrip && showName !== 'never') {
        const ts = getTitleStripStyle(
          hex, ds.timelineClipBodyMode, selected, !!isMuted, ds.timelineClipContrast,
        )
        ctx.fillStyle = ts.fill
        ctx.fillRect(layout.titleX, layout.titleY, layout.titleW, layout.titleH)
        ctx.fillStyle = ts.separator
        ctx.fillRect(layout.titleX, layout.titleY + layout.titleH - 1, layout.titleW, 1)

        const titleAvailW = Math.max(
          0,
          layout.titleW - TITLE_TEXT_PAD_X * 2 - handleReserveRight - handleReserveLeft,
        )

        let drawNameOk = false
        let allowBareEllipsis = false
        if (showName === 'always') {
          drawNameOk = titleAvailW >= NAME_ALWAYS_MIN_W
          allowBareEllipsis = true
        } else { // auto
          drawNameOk = titleAvailW >= NAME_AUTO_MIN_W
        }

        if (drawNameOk) {
          // Syllable clip → show "<n> <text>" (or just "<n>") instead of region name
          let clipLabel = region?.name || '?'
          if (clip.syllableIndex != null && clip.syllableIndex >= 0) {
            const syl = region?.syllables?.[clip.syllableIndex]
            const displayNumber = getSyllableDisplayNumber(region?.syllables, clip.syllableIndex)
            if (syl) {
              clipLabel = syl.text
                ? `${displayNumber} ${syl.text}`
                : `${displayNumber}`
            } else {
              clipLabel = `${displayNumber}`
            }
          }

          ctx.save()
          ctx.beginPath()
          ctx.rect(
            layout.titleX + handleReserveLeft + TITLE_TEXT_PAD_X,
            layout.titleY,
            titleAvailW,
            layout.titleH,
          )
          ctx.clip()
          ctx.fillStyle = p.clipLabel
          ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
          ctx.textBaseline = 'middle'
          const fitted = fitText(ctx, clipLabel, titleAvailW, { allowBareEllipsis })
          if (fitted) {
            ctx.fillText(
              fitted,
              layout.titleX + handleReserveLeft + TITLE_TEXT_PAD_X,
              layout.titleY + layout.titleH / 2,
            )
          }
          ctx.restore()
        }
      }

      // Metadata chips (bottom-right)
      if (showMeta !== 'never') {
        const metaMinW = showMeta === 'always' ? META_ALWAYS_MIN_W : META_AUTO_MIN_W
        if (clipW >= metaMinW) {
          const chips = buildClipMetadataChips(clip)
          if (chips.length) {
            drawMetadataChips(ctx, chips, layout.metadataArea, p, {
              handleReserveRight,
              leftLimit: x + handleReserveLeft + 2,
            })
          }
        }
      }
    }

    // ── Resize handles (selected only) ────────────────────────────────────
    // Drawn last so they always sit on top of strip + chips.
    if (selected && clipW > HANDLE_W * 3) {
      ctx.fillStyle = hexToRgba(hex, 1.0)
      ctx.fillRect(x, y, HANDLE_W, clipH)                       // left
      ctx.fillRect(x + clipW - HANDLE_W, y, HANDLE_W, clipH)    // right
    }
  }

  if (visibleCount > 0) {
    console.log(`[TimelineClips] Rendering ${clips.length} clips (${visibleCount} visible in viewport)`)
  }
}

// ── WORLD processing spinners ────────────────────────────────────────────────
// Draws a 14-px rotating arc at the bottom-right corner of each clip that is
// currently being processed by a WORLD render job.
// `accentColor` must be pre-resolved from the CSS variable by the caller since
// canvas cannot read CSS custom properties directly.

export function drawWorldSpinners(
  ctx, clips, trackIdToIndex, worldProcessingClips,
  scrollOffset, ppb, spinAngle, accentColor, trackLayout = null
) {
  if (!worldProcessingClips?.size || !clips?.length) return
  const SPINNER_R   = 7    // radius → 14 px diameter
  const SPINNER_PAD = 4    // margin from clip right/bottom edge
  const ARC_SPAN    = Math.PI * 1.5  // 270° sweep

  ctx.save()
  ctx.lineWidth   = 2
  ctx.lineCap     = 'round'
  ctx.strokeStyle = accentColor

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (!worldProcessingClips.has(clip.id)) continue
    const trackIdx = trackIdToIndex[clip.trackId]
    if (trackIdx == null) continue

    const x     = beatToPixel(clip.positionTicks / PPQ, scrollOffset, ppb)
    const clipW = (clip.durationTicks / PPQ) * ppb
    if (clipW < 20 || x + clipW < 0) continue

    const cx = x + clipW - SPINNER_PAD - SPINNER_R
    const cy = _trackTop(trackIdx, trackLayout) + TRACK_HEIGHT - CLIP_PAD - SPINNER_PAD - SPINNER_R

    ctx.beginPath()
    ctx.arc(cx, cy, SPINNER_R, spinAngle, spinAngle + ARC_SPAN)
    ctx.stroke()
  }
  ctx.restore()
}

// ── Pattern Blocks (content layer) ──────────────────────────────────────────

export function drawPatternBlocks(ctx, w, h, scrollOffset, ppb, blocks, trackIdToIndex, patterns, regions, selectedBlockIds, mutedTrackIds, palette = null, timelineDisplaySettings = null, trackColorById = null, trackLayout = null) {
  if (!blocks || blocks.length === 0) return
  const p = palette ?? resolveTimelinePalette()
  const ds = normalizeTimelineDisplaySettings(timelineDisplaySettings)
  const ppMode = ds.timelineShowPatternPreview
  const ppMinW = ppMode === 'always' ? 20 : 32

  const clipH = TRACK_HEIGHT - CLIP_PAD * 2

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const beatPos = block.positionTicks / PPQ
    const beatDur = block.durationTicks / PPQ

    const x = beatToPixel(beatPos, scrollOffset, ppb)
    let blockW = beatDur * ppb
    if (blockW < CLIP_MIN_WIDTH_PX) blockW = CLIP_MIN_WIDTH_PX

    // Cull off-screen
    if (x + blockW < 0 || x > w) continue

    const trackIdx = trackIdToIndex[block.trackId]
    if (trackIdx == null) continue
    const y = _trackTop(trackIdx, trackLayout) + CLIP_PAD

    const pattern = patterns?.[block.patternId]
    const region = pattern ? regions?.[pattern.regionId] : null
    const fallbackHex = labelHexColor(region?.label)
    const hex = trackColorById?.[block.trackId] || fallbackHex
    const selected = selectedBlockIds?.has(block.id)
    const isMuted = mutedTrackIds?.has(block.trackId)
    const mutedMul = isMuted ? 0.3 : 1.0

    // ── Body material (Pass 5C) ──────────────────────────────────────────
    const _mat = getTimelineBodyMaterial({
      baseHex: hex,
      mode: ds.timelinePatternBodyMode,
      selected,
      muted: !!isMuted,
      contrast: ds.timelineClipContrast, // contrast applies to both kinds in v1
      gradientDirection: ds.timelineBodyGradientDirection,
      ctx, x, y, w: blockW, h: clipH,
      kind: 'pattern',
    })

    // ── Fill ──────────────────────────────────────────────────────────────
    ctx.fillStyle = _mat.fillStyle
    ctx.fillRect(x, y, blockW, clipH)

    // ── Border ────────────────────────────────────────────────────────────
    ctx.strokeStyle = _mat.borderStyle
    ctx.lineWidth = _mat.borderWidth
    ctx.strokeRect(x, y, blockW, clipH)

    // ── Selected-state inner highlight ring (Pass 4B) ─────────────────────
    if (selected && blockW > 4 && clipH > 4) {
      ctx.strokeStyle = p.selectionHighlight
      ctx.lineWidth = 1
      ctx.strokeRect(x + 1.5, y + 1.5, blockW - 3, clipH - 3)
    }

    // ── Pass 5D internal layout (title strip + content region) ───────────
    const showName = ds.timelineShowClipNames
    const _wantTitleStrip = showName !== 'never' && blockW > TINY_CLIP_MAX_W
    const layout = getTimelineBlockInnerLayout({
      x, y, w: blockW, h: clipH, kind: 'pattern',
      showTitleStrip: _wantTitleStrip,
    })

    // ── Title strip background ───────────────────────────────────────────
    // Drawn first so the dashed top border (re-drawn below) sits on top of it.
    if (layout.useStrip) {
      const ts = getTitleStripStyle(
        hex, ds.timelinePatternBodyMode, selected, !!isMuted, ds.timelineClipContrast,
      )
      ctx.fillStyle = ts.fill
      ctx.fillRect(layout.titleX, layout.titleY, layout.titleW, layout.titleH)
      ctx.fillStyle = ts.separator
      ctx.fillRect(layout.titleX, layout.titleY + layout.titleH - 1, layout.titleW, 1)
    }

    // ── Dashed top border distinguishes PatternBlocks from Clips ──────────
    // Drawn AFTER the title strip so the dashes remain visible.
    ctx.strokeStyle = hexToRgba(hex, 1.0)
    ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(x, y + 1)
    ctx.lineTo(x + blockW, y + 1)
    ctx.stroke()
    ctx.setLineDash([])

    // ── Note markers (if pattern has notes and zoom is sufficient) ────────
    // Pass 5C: gated by timelineShowPatternPreview.
    //   never  → never draw mini-note preview
    //   always → draw at blockW >= 20
    //   auto   → draw at blockW >= 32
    // Pass 5D: notes draw inside the content region below the title strip.
    if (ppMode !== 'never'
        && pattern && pattern.notes && pattern.notes.length > 0
        && pattern.lengthTicks > 0 && blockW >= ppMinW) {
      const patLen = pattern.lengthTicks
      const offsetTicks = block.offsetTicks || 0
      const windowStart = offsetTicks
      const windowEnd = offsetTicks + block.durationTicks

      // Pitch-scaled mini piano roll: Y position proportional to pitch within pattern range
      const pitches = pattern.notes.map((n) => n.pitch)
      const minP = Math.min(...pitches)
      const maxP = Math.max(...pitches)
      const range = Math.max(1, maxP - minP)
      const innerH = layout.contentH - 4 // top/bottom margin within content region
      const noteH = 2                    // 2px dots

      ctx.fillStyle = hexToRgba(hex, 0.95)
      const firstLoop = Math.floor(windowStart / patLen)
      let lastLoop = Math.floor((windowEnd - 1) / patLen)
      // When block loop is disabled, only iteration 0 draws notes — the remainder
      // of the block shows as empty space. Matches the engine clamp so the mini
      // preview visually matches what will actually play (MixEngine + video events).
      const blockLoopEnabled = block.loopEnabled !== false
      if (!blockLoopEnabled) lastLoop = Math.min(lastLoop, 0)
      ctx.save()
      ctx.beginPath()
      ctx.rect(layout.contentX, layout.contentY, layout.contentW, layout.contentH)
      ctx.clip()
      for (let L = firstLoop; L <= lastLoop; L++) {
        for (let n = 0; n < pattern.notes.length; n++) {
          const note = pattern.notes[n]
          const tape = L * patLen + note.positionTicks
          if (tape < windowStart || tape >= windowEnd) continue
          const noteBeat = beatPos + (tape - windowStart) / PPQ
          const nx = beatToPixel(noteBeat, scrollOffset, ppb)
          const nw = Math.max(1, (note.durationTicks / PPQ) * ppb)
          // Invert Y: higher pitch = higher on screen (smaller Y)
          const ny = layout.contentY + 2 + (innerH - noteH) - ((note.pitch - minP) / range) * (innerH - noteH)
          ctx.fillRect(nx, ny, nw, noteH)
        }
      }
      ctx.restore()
    }

    // ── Resize handles ────────────────────────────────────────────────────
    if (selected && blockW > HANDLE_W * 3) {
      ctx.fillStyle = hexToRgba(hex, 1.0)
      ctx.fillRect(x + blockW - HANDLE_W, y, HANDLE_W, clipH)    // right only (left = offset)
    }

    // ── Loop indicator (drawn inside the title-strip area, top-right) ────
    const hasLoopGlyph = !!(pattern && pattern.lengthTicks > 0
                            && block.durationTicks > pattern.lengthTicks)
    if (hasLoopGlyph) {
      ctx.fillStyle = p.patternGlyphBg
      ctx.font = '600 8px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textBaseline = 'top'
      // ↻ when loop active, ∣→ when disabled (extends as empty space)
      const glyph = block.loopEnabled === false ? '∣→' : '↻'
      ctx.fillText(glyph, x + blockW - 14, y + 2)
    }

    // ── Pass 5D pattern title text (centered in title strip) ─────────────
    if (blockW > TINY_CLIP_MAX_W && layout.useStrip && showName !== 'never') {
      const handleReserveRight = (selected && blockW > HANDLE_W * 3) ? HANDLE_W : 0
      const glyphReserve = hasLoopGlyph ? PATTERN_LOOP_GLYPH_RESERVE : 0
      const titleAvailW = Math.max(
        0,
        layout.titleW - TITLE_TEXT_PAD_X * 2 - handleReserveRight - glyphReserve,
      )

      let drawNameOk = false
      let allowBareEllipsis = false
      if (showName === 'always') {
        drawNameOk = titleAvailW >= NAME_ALWAYS_MIN_W
        allowBareEllipsis = true
      } else { // auto
        drawNameOk = titleAvailW >= NAME_AUTO_MIN_W
      }

      if (drawNameOk) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(
          layout.titleX + TITLE_TEXT_PAD_X,
          layout.titleY,
          titleAvailW,
          layout.titleH,
        )
        ctx.clip()
        ctx.fillStyle = p.patternLabel
        ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        const fitted = fitText(ctx, pattern?.name || '?', titleAvailW, { allowBareEllipsis })
        if (fitted) {
          ctx.fillText(
            fitted,
            layout.titleX + TITLE_TEXT_PAD_X,
            layout.titleY + layout.titleH / 2,
          )
        }
        ctx.restore()
      }
    }
  }
}

// ── Drop preview (drawn on overlay layer) ───────────────────────────────────

export function drawDropPreview(ctx, w, h, scrollOffset, ppb, preview, palette = null, trackLayout = null) {
  if (!preview) return
  const p = palette ?? resolveTimelinePalette()

  const { beat, trackIndex, durationBeats, color, name } = preview
  const x = beatToPixel(beat, scrollOffset, ppb)
  const clipW = durationBeats * ppb
  const y = _trackTop(trackIndex, trackLayout) + CLIP_PAD
  const clipH = TRACK_HEIGHT - CLIP_PAD * 2

  // Fill
  ctx.fillStyle = hexToRgba(color, 0.35)
  ctx.fillRect(x, y, clipW, clipH)

  // Dashed border
  ctx.strokeStyle = hexToRgba(color, 0.7)
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x, y, clipW, clipH)
  ctx.setLineDash([])

  // Name at 50% opacity
  if (clipW > CLIP_TEXT_PAD * 2 + 10) {
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.rect(x + CLIP_TEXT_PAD, y, clipW - CLIP_TEXT_PAD * 2, clipH)
    ctx.clip()
    ctx.fillStyle = p.fgInverse
    ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(name || '', x + CLIP_TEXT_PAD, y + clipH / 2)
    ctx.restore()
  }
}

// ── Tool overlays (drawn on overlay canvas during mouse interaction) ─────────

const GHOST_CLIP_PAD = 2

export function drawGhostPreview(ctx, w, h, scrollOffset, ppb, ghost, palette = null, trackLayout = null) {
  if (!ghost) return
  const p = palette ?? resolveTimelinePalette()
  const { beat, trackIndex, durationBeats, color, name } = ghost
  const x = beatToPixel(beat, scrollOffset, ppb)
  const clipW = durationBeats * ppb
  const y = _trackTop(trackIndex, trackLayout) + GHOST_CLIP_PAD
  const clipH = TRACK_HEIGHT - GHOST_CLIP_PAD * 2

  if (x + clipW < 0 || x > w) return

  ctx.fillStyle = hexToRgba(color, 0.25)
  ctx.fillRect(x, y, clipW, clipH)

  ctx.strokeStyle = hexToRgba(color, 0.5)
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x, y, clipW, clipH)
  ctx.setLineDash([])

  if (clipW > CLIP_TEXT_PAD * 2 + 10 && name) {
    ctx.save()
    ctx.globalAlpha = 0.4
    ctx.beginPath()
    ctx.rect(x + CLIP_TEXT_PAD, y, clipW - CLIP_TEXT_PAD * 2, clipH)
    ctx.clip()
    ctx.fillStyle = p.fgInverse
    ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, x + CLIP_TEXT_PAD, y + clipH / 2)
    ctx.restore()
  }
}

export function drawRubberBand(ctx, x1, y1, x2, y2, palette = null) {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  if (w < 1 && h < 1) return
  const p = palette ?? resolveTimelinePalette()

  ctx.fillStyle = withAlpha(p.accent, 0.08)
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = withAlpha(p.accent, 0.4)
  ctx.lineWidth = 1
  ctx.strokeRect(x, y, w, h)
}

export function drawSplitLine(ctx, w, h, scrollOffset, ppb, beat, palette = null) {
  if (beat == null) return
  const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
  if (x < -1 || x > w + 1) return
  const p = palette ?? resolveTimelinePalette()

  ctx.strokeStyle = p.loopBrace
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()
  ctx.setLineDash([])
}

export function drawMovePreview(ctx, w, h, scrollOffset, ppb, preview, trackLayout = null) {
  if (!preview) return
  const { beat, trackIndex, durationBeats, color } = preview
  const x = beatToPixel(beat, scrollOffset, ppb)
  const clipW = durationBeats * ppb
  const y = _trackTop(trackIndex, trackLayout) + GHOST_CLIP_PAD
  const clipH = TRACK_HEIGHT - GHOST_CLIP_PAD * 2

  ctx.fillStyle = hexToRgba(color, 0.3)
  ctx.fillRect(x, y, clipW, clipH)
  ctx.strokeStyle = hexToRgba(color, 0.7)
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 3])
  ctx.strokeRect(x, y, clipW, clipH)
  ctx.setLineDash([])
}

export function drawDeleteSweep(ctx, x1, y1, x2, y2, palette = null) {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  if (w < 1 && h < 1) return
  const p = palette ?? resolveTimelinePalette()

  ctx.fillStyle = withAlpha(p.danger, 0.10)
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = withAlpha(p.danger, 0.4)
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x, y, w, h)
  ctx.setLineDash([])
}

// ── Ruler overlay (playhead indicator on ruler) ──────────────────────────────

export function drawRulerOverlay(ctx, w, h, scrollOffset, ppb, playheadBeat, palette = null) {
  ctx.clearRect(0, 0, w, h)

  if (playheadBeat == null) return
  const p = palette ?? resolveTimelinePalette()

  const x = Math.round(beatToPixel(playheadBeat, scrollOffset, ppb)) + 0.5
  if (x < -1 || x > w + 1) return

  // Playhead line on ruler
  ctx.strokeStyle = p.playheadLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()

  // Downward triangle
  ctx.fillStyle = p.playheadAccent
  ctx.beginPath()
  ctx.moveTo(x, h)
  ctx.lineTo(x - 4, h - 6)
  ctx.lineTo(x + 4, h - 6)
  ctx.closePath()
  ctx.fill()
}

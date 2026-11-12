/**
 * Pure canvas drawing functions for the timeline.
 * All functions expect the canvas context to already be scaled for DPR.
 */

import {
  TRACK_HEIGHT, BEATS_PER_BAR, SUBDIVISIONS, SUB_GRID_THRESHOLD,
  PPQ, CLIP_MIN_WIDTH_PX,
  GRANULARITY_BEATS,
  beatToPixel, ticksToBeats, pixelToTickExact,
} from '../../constants/timeline.js'
import { labelHexColor, pickLabelHexColor, resolveLabelHexColors } from '../../constants/labels.js'
import {
  BLOCK_PAD, BLOCK_HANDLE_W, TITLE_TEXT_PAD_X, TINY_BLOCK_MAX_W,
  blockRect, blockInnerLayout, blockWantsTitleStrip, blockShowsHandles, trackTopOf,
  snapSpanLeft, snapSpanWidth,
} from './blockGeometry.js'
import { getPatternNoteIndex, forEachBlockNote } from './patternNoteIndex.js'
import { fitCanvasText, measureCanvasTextWidth } from './canvasTextFit.js'
import { drawEnvelope, drawTrace, drawWaveformLine, drawSamplePoints, visibleColumnWindow } from '../../utils/waveformRenderer.js'
import { currentRegime } from './waveformRegime.js'
import { hiResCoversWindow } from './hiResCoverage.js'
import { findCoveringEntry } from './hiResRegionCache.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { pickLabelInk } from '../../ui-kit/colorMath'
import { uiCanvasFont } from '../../styles/typography.js'
import { normalizeTrackPalette, TRACK_PALETTE_FALLBACK, pickPatternAccentText } from './trackColorResolver.js'
import { getRegionPlaybackDurationSec } from './regionDuration.js'
import { getSelectableSyllables, getSyllableDisplayNumber } from '../SyllableSplitter/syllableModel.js'
import { getHoldThresholdTicks } from './holdLastFrame.js'
import {
  CLIP_CONTROL_DEFAULTS,
  CLIP_GAIN_MAX_VELOCITY,
  computeClipControlGeometry,
  getClipControlVisibility,
  normalizeClipControlSpec,
  normalizeClipFades,
} from './clipControlSpec.js'
import {
  applyPointDragPreview,
  automationClipBodyRect,
  AUTOMATION_POINT_DRAW_RADIUS_PX,
  buildAutomationCurveCanvasPoints,
  buildAutomationHoldLine,
} from './automationLaneGeometry.js'
import { drawIcon } from '../../ui-kit/icons/canvas.ts'

// Default engine sample rate (used for spp computation when no per-region rate is known)
const DEFAULT_SR = 48000

export function getClipRegionWaveformStartSec(clip, region, bpm) {
  if (!clip || !bpm) return 0
  const offsetTicks = Number(clip.regionOffsetTicks ?? 0)
  const offsetSec = Number.isFinite(offsetTicks)
    ? (offsetTicks / PPQ) / (bpm / 60)
    : 0
  const syllableIndex = Number(clip.syllableIndex)
  if (
    Number.isInteger(syllableIndex) &&
    syllableIndex >= 0 &&
    Array.isArray(region?.syllables) &&
    syllableIndex < region.syllables.length
  ) {
    const sylStart = Number(region.syllables[syllableIndex]?.startTime)
    return Math.max(0, (Number.isFinite(sylStart) ? sylStart : 0) + offsetSec)
  }
  return Math.max(0, offsetSec)
}

// ── Theme palette ────────────────────────────────────────────────────────────
// Resolve all CSS custom properties used by the Timeline canvas. Callers
// (TimelineCanvas.redrawGrid/redrawContent and TimelineRuler.redraw) call this
// and thread the returned object into draw functions, avoiding getComputedStyle
// reads spread across hot draw paths.
//
// Pattern mirrors PianoRollCanvas.resolvePalette (Pass 4A.0/4A.1).
//
// MEMOISED across draws, not just within one. Resolving costs 46
// getComputedStyle(document.documentElement) reads, and the viewport commit
// path calls it four times a frame (grid + content + ruler + ruler overlay) —
// ~180 forced style reads per animated frame. Worse, those reads are
// INTERLEAVED with the same path's DOM writes (playhead transform, FX badges,
// scrollbar thumb, loop bar), so every frame of a zoom/pan gesture paid for a
// synchronous style recalculation: classic read-write-read layout thrash, and
// the direct cause of ctrl+wheel zoom jitter on large projects.
//
// Invalidation is exact, not heuristic: :root theme tokens are only ever
// written by writeThemeToRoot() (theming/runtime/applyTheme.ts), which is
// always followed by an 'xleth-theme-changed' dispatch — the single event this
// cache listens for. Anything that changes tokens without that event must call
// invalidateTimelinePalette() itself.

let _paletteCache = null

export function invalidateTimelinePalette() {
  _paletteCache = null
}

if (typeof window !== 'undefined') {
  // Both targets: the dispatch is on window, but some listeners in this app
  // register on document — mirroring both keeps the cache correct if a future
  // dispatcher picks the other target.
  window.addEventListener('xleth-theme-changed', invalidateTimelinePalette)
  if (typeof document !== 'undefined') {
    document.addEventListener('xleth-theme-changed', invalidateTimelinePalette)
  }
}

export function resolveTimelinePalette() {
  if (_paletteCache !== null) return _paletteCache
  _paletteCache = {
    // Surfaces
    bg:                tokenValue('--theme-timeline-lane-bg'),
    laneSeparator:     tokenValue('--theme-border-strong'),
    patternLaneTint:   tokenValue('--theme-timeline-pattern-lane-tint'),
    // Alternate bar groups on the lane ground (DESIGN.md 22): a tone a step above g0.
    barGroupShade:     tokenValue('--theme-timeline-bar-group-shade'),
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
    // Ring on the clip that pinned a multi-clip volume/fade drag at its limit.
    clipControlAtLimit: tokenValue('--theme-danger'),
    clipWaveformFg:    tokenValue('--theme-timeline-clip-waveform-fg'),
    clipWaveformBg:    tokenValue('--theme-timeline-clip-waveform-bg'),
    clipPitchBoxBg:    tokenValue('--theme-timeline-fade-curve-fill'),
    clipPitchBoxFg:    tokenValue('--theme-text'),
    patternLabel:      tokenValue('--theme-timeline-clip-title-fg'),
    patternGlyphBg:    tokenValue('--theme-timeline-fade-curve-fill'),
    selectionHighlight:tokenValue('--theme-border-focus'),
    // Hold Last Frame chrome (video timeline only)
    holdZoneFill:      tokenValue('--theme-timeline-hold-zone-fill'),
    holdZoneEdge:      tokenValue('--theme-timeline-hold-zone-edge'),
    // Tool overlays
    loopBrace:         tokenValue('--theme-timeline-loop-brace'),
    accent:            tokenValue('--theme-accent'),
    danger:            tokenValue('--theme-danger'),
    warning:           tokenValue('--theme-warning'),
    fgInverse:         tokenValue('--theme-fg-inverse'),
    // Kit inks: snap markers, automatic label ink (whichever of ink / g1
    // contrasts more with a clip's colour), selection outline.
    ink:               tokenValue('--ui-ink'),
    inkDark:           tokenValue('--ui-g1'),
    select:            tokenValue('--ui-select'),
    // Depth
    wellTopShadow:     tokenValue('--theme-timeline-well-top-shadow'),
    // Track palette — resolved once per redraw, threaded into draw functions
    trackPalette: normalizeTrackPalette(
      Array.from({ length: 16 }, (_, i) => tokenValue(`--theme-track-palette-${i + 1}`))
    ),
    // Region-label colours: the fallback colour of a block whose track has
    // none. Resolved here so the draw loop never reads computed style.
    labelColors: resolveLabelHexColors(),
  }
  return _paletteCache
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
const _trackTop = trackTopOf

// ── Grid (background layer) ──────────────────────────────────────────────────

export function getSnapGridIntervalBeats(snapGranularity = '1/16') {
  const interval = GRANULARITY_BEATS[snapGranularity]
  return Number.isFinite(interval) && interval > 0 ? interval : GRANULARITY_BEATS['1/16']
}

// Zoomed far out (the whole-song fit can go well below 8 px/beat), drawing
// every bar number and every beat line turns the ruler into overlapping text
// and the grid into a solid fill. These pick the sparsest power-of-two bar
// stride that keeps marks at least `minPx` apart. At normal zoom both return
// 1 (every bar), which is exactly the old output.
export const BAR_LABEL_MIN_PX = 36
export const BAR_LINE_MIN_PX = 10
export const BEAT_LINE_MIN_PX = 4
export function barStrideFor(ppb, minPx) {
  const barPx = ppb * BEATS_PER_BAR
  if (!(barPx > 0)) return 1
  let stride = 1
  while (stride * barPx < minPx && stride < 1 << 20) stride *= 2
  return stride
}

// Bar groups (DESIGN.md 22). Empty lane space carries the song's structure: every other
// group of bars sits on a tone a step above the ground. A group is 4 bars; once 4 bars are
// wider than BAR_GROUP_MAX_PX it is one bar, and zoomed far out it doubles until a group is
// at least BAR_GROUP_MIN_PX wide, so the bands never turn into a texture.
export const BAR_GROUP_MAX_PX = 600
export const BAR_GROUP_MIN_PX = 48
export function barGroupBars(ppb) {
  const barPx = ppb * BEATS_PER_BAR
  if (!(barPx > 0)) return 4
  if (barPx * 4 > BAR_GROUP_MAX_PX) return 1
  let bars = 4
  while (bars * barPx < BAR_GROUP_MIN_PX && bars < 1 << 20) bars *= 2
  return bars
}

// Dev flag: log what one grid repaint costs. Set `window.__XLETH_TIMELINE_GRID_PERF = true`
// in the console; nothing is read or logged otherwise.
function gridPerfEnabled() {
  return typeof window !== 'undefined' && window.__XLETH_TIMELINE_GRID_PERF === true
}

export function drawGrid(ctx, w, h, scrollOffset, ppb, trackCount, tracks = null, palette = null, trackLayout = null, snapGranularity = '1/16') {
  const perfT0 = gridPerfEnabled() ? performance.now() : 0
  ctx.clearRect(0, 0, w, h)
  const p = palette ?? resolveTimelinePalette()

  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1

  // Bar-group shading: under everything else on this layer, edges on whole pixels so a band
  // ends exactly on the bar line that closes it.
  const shade = p.barGroupShade
  if (shade && shade.trim() !== '' && shade.trim() !== 'transparent') {
    const groupBeats = barGroupBars(ppb) * BEATS_PER_BAR
    ctx.fillStyle = shade
    for (let g = Math.floor(scrollOffset / groupBeats); ; g++) {
      const x0 = Math.round(beatToPixel(g * groupBeats, scrollOffset, ppb))
      if (x0 >= w) break
      if (((g % 2) + 2) % 2 === 1) {
        const x1 = Math.round(beatToPixel((g + 1) * groupBeats, scrollOffset, ppb))
        const left = Math.max(0, x0)
        const right = Math.min(w, x1)
        if (right > left) ctx.fillRect(left, 0, right - left, h)
      }
    }
  }

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
    ctx.fillStyle = withAlpha(p.laneSeparator, 0.22)
    for (const r of trackLayout.rows) {
      if (r.rowType !== 'folder' && r.rowType !== 'automationGroupHeader') continue
      if (r.y >= h) break
      ctx.fillRect(0, r.y, w, r.height)
    }
    ctx.fillStyle = withAlpha(p.laneSeparator, 0.14)
    for (const r of trackLayout.rows) {
      if (r.rowType !== 'automationLane') continue
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
    { divPerBeat: 4,   threshold: SUB_GRID_THRESHOLD, mult: 1.55 }, // 16th
    { divPerBeat: 8,   threshold: 400,                mult: 1.28 }, // 32nd
    { divPerBeat: 16,  threshold: 2000,               mult: 1.04 }, // 64th
    { divPerBeat: 32,  threshold: 10000,              mult: 0.78 }, // 128th
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

  // Beat lines (vertical, minor) — dropped once they'd be < 4px apart.
  ctx.strokeStyle = p.gridBeat
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let beat = startBeat; ppb >= BEAT_LINE_MIN_PX && beat <= endBeat; beat++) {
    if (beat % BEATS_PER_BAR === 0) continue // bars drawn separately
    const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
    if (x < 0) continue
    if (x > w) break
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  ctx.stroke()

  // Active snap markers mirror the toolbar setting, so changing Snap has an
  // immediate visual footprint on the timeline grid.
  const snapInterval = getSnapGridIntervalBeats(snapGranularity)
  const snapSpacingPx = snapInterval * ppb
  if (snapSpacingPx >= 6) {
    const firstSnap = Math.floor(startBeat / snapInterval) * snapInterval
    const snapAlpha = snapInterval >= BEATS_PER_BAR ? 0.30
      : snapInterval >= 1 ? 0.24
        : Math.min(0.22, Math.max(0.12, snapSpacingPx / 80))
    // Ink at low alpha (half the old accent alpha): chrome never colours the
    // content area. Spacing thresholds unchanged.
    ctx.strokeStyle = withAlpha(p.ink || p.gridBeat, snapAlpha * 0.5)
    ctx.lineWidth = snapInterval >= 1 ? 1 : 0.75
    ctx.beginPath()
    for (let beat = firstSnap; beat <= endBeat + snapInterval / 2; beat += snapInterval) {
      if (beat < startBeat - snapInterval / 2) continue
      const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
      if (x < 0) continue
      if (x > w) break
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
    }
    ctx.stroke()
  }

  // Bar lines (vertical, major — every BEATS_PER_BAR beats, thinned by a
  // power-of-two stride when zoomed far out)
  ctx.strokeStyle = p.gridBar
  ctx.lineWidth = 1
  ctx.beginPath()
  const lineStepBeats = barStrideFor(ppb, BAR_LINE_MIN_PX) * BEATS_PER_BAR
  const firstBar = Math.floor(startBeat / lineStepBeats) * lineStepBeats
  for (let beat = firstBar; beat <= endBeat; beat += lineStepBeats) {
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

  if (perfT0) {
    console.log(`[Timeline] grid repaint ${(performance.now() - perfT0).toFixed(2)} ms at ${ppb} px/beat (${Math.round(w)}x${Math.round(h)}, bar groups of ${barGroupBars(ppb)})`)
  }
}

// ── Ruler ────────────────────────────────────────────────────────────────────

/** The bar numbers a ruler labels between two beats, at one label every `labelStepBeats`. Every fourth label is major. */
export function rulerBarLabels(startBeat, endBeat, labelStepBeats) {
  const out = []
  const first = Math.floor(startBeat / labelStepBeats) * labelStepBeats
  const majorEveryBeats = labelStepBeats * 4
  for (let beat = first; beat <= endBeat; beat += labelStepBeats) {
    if (beat < 0) continue
    out.push({ beat, text: String(Math.floor(beat / BEATS_PER_BAR) + 1), major: beat % majorEveryBeats === 0 })
  }
  return out
}

/** Drop the minor labels that would sit within RULER_LABEL_GAP of a major label or of the minor before them. Majors always stay. */
export const RULER_LABEL_GAP = 4
export function keepRulerLabels(boxes) {
  const majors = boxes.filter((b) => b.major)
  const clear = (a, b) => a.right + RULER_LABEL_GAP <= b.x || b.right + RULER_LABEL_GAP <= a.x
  const kept = []
  let lastMinor = null
  for (const b of boxes) {
    if (b.major) { kept.push(b); continue }
    if (!majors.every((m) => clear(b, m))) continue
    if (lastMinor && !clear(lastMinor, b)) continue
    kept.push(b)
    lastMinor = b
  }
  return kept
}

export function drawRuler(ctx, w, h, scrollOffset, ppb, palette = null) {
  const p = palette ?? resolveTimelinePalette()

  // Background
  ctx.fillStyle = p.rulerBg
  ctx.fillRect(0, 0, w, h)

  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1

  // Beat tick marks. Zoomed far out, beat ticks drop out and bar ticks thin
  // to the same stride as the grid's bar lines.
  ctx.strokeStyle = p.rulerBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  const drawBeatTicks = ppb >= BEAT_LINE_MIN_PX
  const tickStepBeats = drawBeatTicks ? 1 : barStrideFor(ppb, BAR_LINE_MIN_PX) * BEATS_PER_BAR
  const labelStepBeats = barStrideFor(ppb, BAR_LABEL_MIN_PX) * BEATS_PER_BAR
  for (let beat = Math.floor(startBeat / tickStepBeats) * tickStepBeats; beat <= endBeat; beat += tickStepBeats) {
    const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
    if (x < 0) continue
    if (x > w) break

    const isBar = beat % BEATS_PER_BAR === 0
    const tickH = beat % labelStepBeats === 0 ? h * 0.6 : isBar ? h * (drawBeatTicks ? 0.6 : 0.3) : h * 0.3
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

  // Bar numbers (DESIGN.md 22). Every fourth one is the landmark: 12px in ink. The others are
  // 10px in ink-3 and are dropped wherever they would touch a neighbour, so at any zoom the
  // ruler reads 1 . . . 5 . . . 9 before it reads anything else. (They were all 9px.)
  ctx.textBaseline = 'top'
  const majorFont = uiCanvasFont('600 12px')
  const minorFont = uiCanvasFont('500 10px')
  const labels = rulerBarLabels(startBeat, endBeat, labelStepBeats)
  const boxes = []
  for (const label of labels) {
    const x = beatToPixel(label.beat, scrollOffset, ppb) + 4
    if (x < -40 || x > w) continue
    ctx.font = label.major ? majorFont : minorFont
    boxes.push({ ...label, x, right: x + ctx.measureText(label.text).width })
  }
  const kept = keepRulerLabels(boxes)
  ctx.font = minorFont
  ctx.fillStyle = p.rulerText
  for (const b of kept) if (!b.major) ctx.fillText(b.text, b.x, 5)
  ctx.font = majorFont
  ctx.fillStyle = p.ink || p.rulerText
  for (const b of kept) if (b.major) ctx.fillText(b.text, b.x, 3)

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

// Waveform overlay strength per clip-contrast setting. Deliberately a
// separate, much gentler table than _CONTRAST_MUL: the waveform's own
// legibility comes from the halo/core pairing below (self-contrast, not
// contrast-against-the-clip-surface), so this only needs to nudge boldness
// in the same direction as the "Contrast" control, never punish it — at
// _CONTRAST_MUL's slope, "high" clip contrast makes the clip body more
// opaque/saturated, which used to wash the (fixed-alpha) waveform out.
const _WAVEFORM_CONTRAST_MUL = { low: 0.82, medium: 0.92, high: 1.0 }
function _waveformContrastMul(c) { return _WAVEFORM_CONTRAST_MUL[c] ?? 0.92 }

// Body material helper for Clip (audio) tracks only — Pattern tracks use the
// fixed, non-configurable tinted-glass treatment in getPatternGlassStyle()
// below instead of this mode system (Pass 7).
// At plain + medium + unmuted, this MUST produce alpha identical to Pass 4B:
//   audio: 0.6 (unselected) / 0.8 (selected)
// Returns: { fillStyle (string|CanvasGradient), borderStyle, borderWidth }
function getTimelineBodyMaterial({
  baseHex, mode, selected, muted, contrast,
  gradientDirection, ctx, x, y, w, h,
}) {
  const cm = _contrastMul(contrast)
  const mm = muted ? MUTE_OPACITY : 1.0

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
    // --theme-timeline-lane-bg arrangement bed so clips pop.
    fillAlphaA = selected ? 0.90 : 0.80
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
    // Muted content dims as a whole (DESIGN.md: mute = content at the mute
    // opacity plus a glyph), the outline included.
    borderStyle: hexToRgba(baseHex, _clampAlpha(borderAlpha * mm)),
    borderWidth,
  }
}

// ── Hold Last Frame zones (arrangement) ─────────────────────────────────────
// Informational chrome showing, per clip on a hold-enabled track, how far past
// the clip's end the held frame stays on screen. Drawn on the same content
// canvas as the clips (never a DOM overlay — the timeline scrolls and zooms by
// redrawing this canvas, so an overlay would drift and corrupt hit-testing).
//
// Deliberately NOT wired into drawClips: the audio timeline shares that
// function and must keep rendering exactly as before. TimelineCanvas calls
// this right after drawClips (the Video tab mirror that used to, is gone).
//
// Cost: pure arithmetic over the clip array already in the store. No engine
// queries, no per-frame IPC. Returns immediately when no track holds.

const HOLD_ZONE_INSET   = 4  // vertical inset from the clip band, keeps it chrome-like
const HOLD_MARKER_W     = 1  // expiry tick width
const HOLD_MIN_ZONE_PX  = 2  // below this the zone is noise; skip the fill

export function drawHoldZones(
  ctx, w, h, scrollOffset, ppb, clips, trackIdToIndex, tracks,
  palette = null, trackLayout = null,
) {
  if (!clips || clips.length === 0 || !tracks || tracks.length === 0) return

  // Index only the hold-enabled tracks; bail before allocating anything else
  // when none of them hold (the overwhelmingly common case).
  let holdTracks = null
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if (!t?.videoHoldLastFrame) continue
    if (!holdTracks) holdTracks = new Map()
    holdTracks.set(t.id, t)
  }
  if (!holdTracks) return

  const p = palette ?? resolveTimelinePalette()

  // Group the hold-enabled tracks' clips and sort each by start tick, so the
  // "next clip" that ends a hold is just the following entry.
  const byTrack = new Map()
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (!holdTracks.has(clip.trackId)) continue
    let list = byTrack.get(clip.trackId)
    if (!list) { list = []; byTrack.set(clip.trackId, list) }
    list.push(clip)
  }
  if (byTrack.size === 0) return

  const zoneH = Math.max(1, TRACK_HEIGHT - CLIP_PAD * 2 - HOLD_ZONE_INSET * 2)

  for (const [trackId, list] of byTrack) {
    const trackIdx = trackIdToIndex[trackId]
    if (trackIdx == null) continue

    list.sort((a, b) => a.positionTicks - b.positionTicks)

    const track = holdTracks.get(trackId)
    const thresholdTicks = getHoldThresholdTicks(track)   // null when unlimited
    const y = _trackTop(trackIdx, trackLayout) + CLIP_PAD + HOLD_ZONE_INSET

    for (let i = 0; i < list.length; i++) {
      const clip = list[i]
      const clipEndTicks = clip.positionTicks + clip.durationTicks

      // A hold ends the instant the next clip on the track starts. Clips can
      // overlap, so clamp to the clip's own end rather than going backwards.
      const next = list[i + 1]
      const nextStartTicks = next
        ? Math.max(clipEndTicks, next.positionTicks)
        : Number.POSITIVE_INFINITY

      // Unlimited holds run to the next clip; with no next clip they run
      // forever, so they're clipped to the viewport's right edge below.
      const expiryTicks = thresholdTicks == null
        ? Number.POSITIVE_INFINITY
        : clipEndTicks + thresholdTicks
      const zoneEndTicks = Math.min(expiryTicks, nextStartTicks)

      const x0 = beatToPixel(clipEndTicks / PPQ, scrollOffset, ppb)
      const x1 = Number.isFinite(zoneEndTicks)
        ? beatToPixel(zoneEndTicks / PPQ, scrollOffset, ppb)
        : w
      if (x1 < 0 || x0 > w) continue          // cull off-screen

      // Clamp to the viewport so an unlimited/very long zone stays a bounded
      // fill, and snap to whole pixels like the clip it hangs off (blockRect
      // rounds the clip's right edge the same way), so the zone starts exactly
      // where the clip ends.
      const drawX0 = Math.round(Math.max(0, x0))
      const drawX1 = Math.round(Math.min(w, x1))
      const zoneW = drawX1 - drawX0

      if (zoneW >= HOLD_MIN_ZONE_PX) {
        ctx.fillStyle = p.holdZoneFill
        ctx.fillRect(drawX0, y, zoneW, zoneH)
      }

      // Expiry tick — drawn only when the hold actually runs out before the
      // next clip. An unlimited hold, or one the next clip cuts short, has no
      // expiry point to mark.
      if (Number.isFinite(expiryTicks) && expiryTicks < nextStartTicks) {
        const mx = beatToPixel(expiryTicks / PPQ, scrollOffset, ppb)
        if (mx >= 0 && mx <= w) {
          ctx.fillStyle = p.holdZoneEdge
          ctx.fillRect(Math.round(mx), y, HOLD_MARKER_W, zoneH)
        }
      }
    }
  }
}

// ── Blocks (content layer) ──────────────────────────────────────────────────
// Clips and pattern blocks are both "blocks": one rectangle, one inner layout
// (blockGeometry.js) and one title / selection / handle treatment (the paint*
// helpers further down). Only what differs between them is written twice.

const CLIP_PAD = BLOCK_PAD // top/bottom padding within the track lane
const CLIP_TEXT_PAD = 6    // horizontal text padding inside drop/ghost previews
const HANDLE_W = BLOCK_HANDLE_W
const CHIP_GAP             = 3
const CHIP_PAD_X           = 5
const NAME_AUTO_MIN_W      = 48
const NAME_ALWAYS_MIN_W    = 18
const META_AUTO_MIN_W      = 72
const META_ALWAYS_MIN_W    = 40
const PATTERN_LOOP_GLYPH_RESERVE = 14
const HEX6 = /^#[0-9a-f]{6}$/i

// Small bounded memo for per-block style objects. Their inputs are a handful
// of enums plus the block's colour, so a few dozen entries cover a project;
// without it every block rebuilt the same rgba() strings every frame.
const STYLE_CACHE_MAX = 512
function cachePut(cache, key, value) {
  if (cache.size >= STYLE_CACHE_MAX) cache.clear()
  cache.set(key, value)
  return value
}

function getTitleStripStyle(baseHex, mode, selected, muted, contrast) {
  const cm = _contrastMul(contrast)
  const mm = muted ? MUTE_OPACITY : 1.0
  let stripA
  if (mode === 'minimal')       stripA = selected ? 0.34 : 0.26
  else if (mode === 'gradient') stripA = selected ? 0.88 : 0.78
  else if (mode === 'solid')    stripA = selected ? 0.92 : 0.84
  else                          stripA = selected ? 0.92 : 0.80
  const alpha     = _clampAlpha(stripA * cm * mm)
  const fill      = hexToRgba(baseHex, alpha)
  const separator = hexToRgba(baseHex, _clampAlpha(0.55 * cm * mm))
  return { fill, separator, alpha }
}

// Muted content dims to the DESIGN.md mute opacity (--ui-mute-opacity) and
// shows a mute glyph; colour is never the only signal.
const MUTE_OPACITY = 0.45

// Clip label ink: whichever of ink / g1 contrasts more with the colour the text
// actually sits on, the title strip composited over the lane (DESIGN.md 3.4,
// pickLabelInk). Never a fixed white or dark. Pattern tracks keep
// pickPatternAccentText(hex): their strip is a dark glass tint.
const _labelInkCache = new Map()
let _labelInkPalette = null
function clipLabelInk(p, baseHex, alpha) {
  if (_labelInkPalette !== p) { _labelInkCache.clear(); _labelInkPalette = p }
  const key = baseHex + '|' + alpha.toFixed(2)
  let ink = _labelInkCache.get(key)
  if (ink) return ink
  const lane = /^#[0-9a-f]{6}$/i.test(p.bg) ? p.bg : '#141414'
  const light = p.ink || '#E6E6E6'
  const dark = p.inkDark || '#1B1B1B'
  ink = pickLabelInk(blendHex(lane, baseHex, alpha), light, dark).ink
  _labelInkCache.set(key, ink)
  return ink
}

function blendHex(bgHex, fgHex, alpha) {
  const b = hexToRgb(bgHex)
  const f = hexToRgb(fgHex)
  const a = clampNumber(alpha, 0, 1)
  const h = (v) => Math.round(v).toString(16).padStart(2, '0')
  return '#' + h(b.r + (f.r - b.r) * a) + h(b.g + (f.g - b.g) * a) + h(b.b + (f.b - b.b) * a)
}

// Muted clips and pattern blocks: Phosphor speaker-simple-x (Fill: it only shows when muted),
// drawn from the same path data as the DOM icon (ui-kit/icons/canvas.ts).
const MUTE_GLYPH_W = 11
function drawMuteGlyph(ctx, x, cy, color) {
  drawIcon(ctx, 'speaker-simple-x', x, cy - 5, 10, color, 'fill')
}

// ── Pattern block material (DESIGN.md 22) ───────────────────────────────────
// Fixed, non-configurable treatment: it deliberately bypasses the Clip body-mode
// system above. A pattern block is the same shell as a clip (the title strip in
// the track's colour, the name in the automatic label ink) over a body at the
// identity colour's low lightness, with the mini piano roll in the full colour.
// The notes are what say "pattern". There is no hatch: a hatch reads as disabled
// or offline media, and the body used to carry one over every block.
// Everything here is derived from the track's own color at the draw call (never
// cached/memoized across a theme change), same rule as resolveTimelinePalette()'s
// tokenValue() reads.
const PATTERN_FILL_ALPHA            = 0.22  // the body: the track colour, low, over the lane ground
const PATTERN_STRIP_FILL_ALPHA      = 0.80  // the title strip, as on a clip
const PATTERN_STRIP_SEPARATOR_ALPHA = 0.55
const PATTERN_STROKE_WIDTH          = 2      // drawn fully inside the bounds

function getPatternGlassStyle(baseHex, selected, muted) {
  const mm = muted ? MUTE_OPACITY : 1.0
  const sel = selected ? 1.15 : 1.0 // selection ring (drawn separately) carries most of the cue
  const stripAlpha = _clampAlpha(PATTERN_STRIP_FILL_ALPHA * sel * mm)
  return {
    fill:            hexToRgba(baseHex, _clampAlpha(PATTERN_FILL_ALPHA * sel * mm)),
    stroke:          hexToRgba(baseHex, _clampAlpha(1.0 * mm)),
    stripFill:       hexToRgba(baseHex, stripAlpha),
    stripAlpha,
    stripSeparator:  hexToRgba(baseHex, _clampAlpha(PATTERN_STRIP_SEPARATOR_ALPHA * mm)),
  }
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

function clampNumber(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function hexToRgb(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

function mixHex(hex, target, amount) {
  const src = hexToRgb(hex)
  const dst = typeof target === 'string' ? hexToRgb(target) : target
  const t = clampNumber(amount, 0, 1)
  const r = Math.round(src.r + (dst.r - src.r) * t)
  const g = Math.round(src.g + (dst.g - src.g) * t)
  const b = Math.round(src.b + (dst.b - src.b) * t)
  return `rgb(${r},${g},${b})`
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

export function drawClipFadeOverlay(
  ctx, clip, x, y, clipW, clipH, selected, overlayColor,
  controlSpec = CLIP_CONTROL_DEFAULTS, fadeValues = null,
) {
  const spec = normalizeClipControlSpec(controlSpec)
  const fades = fadeValues || normalizeClipFades(clip)
  const fadeInPercent = clampNumber(fades.fadeInPercent, 0, 100)
  const fadeOutPercent = clampNumber(fades.fadeOutPercent, 0, 100)
  // Same rule as clipControlSpec.shouldDrawFadeOverlay, on the values already
  // in hand (that helper wants a clip object, which meant copying the whole
  // clip per clip per frame just to ask it).
  if (clipW <= 4 || (fadeInPercent <= 0 && fadeOutPercent <= 0)) return
  const overlayMode = spec.visibility.fadeOverlay
  if (overlayMode === 'never' || (overlayMode === 'selected-when-set' && !selected)) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, clipW, clipH)
  ctx.clip()
  ctx.fillStyle = overlayColor
  ctx.globalAlpha = spec.fade.overlayAlpha

  if (fadeInPercent > 0) {
    const fadeInPx = clipW * fadeInPercent / 100
    const steps = Math.min(
      Math.max(Math.ceil(fadeInPx / spec.fade.overlayPixelsPerStep), spec.fade.overlayMinSteps),
      spec.fade.overlayMaxSteps,
    )
    const x1 = clip.fadeInX1 ?? 0, y1 = clip.fadeInY1 ?? 0
    const x2 = clip.fadeInX2 ?? 1, y2 = clip.fadeInY2 ?? 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps
      const gain = _bezierGain(frac, x1, y1, x2, y2)
      ctx.lineTo(x + frac * fadeInPx, y + clipH * (1 - gain))
    }
    ctx.lineTo(x + fadeInPx, y)
    ctx.closePath()
    ctx.fill()
  }

  if (fadeOutPercent > 0) {
    const fadeOutPx = clipW * fadeOutPercent / 100
    const steps = Math.min(
      Math.max(Math.ceil(fadeOutPx / spec.fade.overlayPixelsPerStep), spec.fade.overlayMinSteps),
      spec.fade.overlayMaxSteps,
    )
    const x1 = clip.fadeOutX1 ?? 0, y1 = clip.fadeOutY1 ?? 0
    const x2 = clip.fadeOutX2 ?? 1, y2 = clip.fadeOutY2 ?? 1
    ctx.beginPath()
    ctx.moveTo(x + clipW, y)
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps
      const gain = _bezierGain(frac, x1, y1, x2, y2)
      ctx.lineTo(x + clipW - frac * fadeOutPx, y + clipH * (1 - gain))
    }
    ctx.lineTo(x + clipW - fadeOutPx, y)
    ctx.closePath()
    ctx.fill()
  }

  ctx.restore()
}

// Draft value a clip should render during an in-flight control drag, or null if
// that clip is not part of the drag. A multi-clip drag carries a per-clip
// `values` map; a single-clip drag carries just `clipId` + `value`.
export function clipControlDraftValue(activeControl, clipId) {
  if (!activeControl) return null
  if (activeControl.values) {
    const value = activeControl.values.get(clipId)
    return value === undefined ? null : value
  }
  return activeControl.clipId === clipId ? activeControl.value : null
}

export function drawClipInlineControls(
  ctx, clip, x, y, clipW, clipH, baseHex, selected,
  activeControl = null, hoveredControl = null, controlSpec = CLIP_CONTROL_DEFAULTS,
) {
  const spec = normalizeClipControlSpec(controlSpec)
  // Too small to carry controls (computeClipControlGeometry's `eligible`):
  // leave before building any geometry. Zoomed out this is every clip on
  // screen, every frame.
  if (clipW < spec.eligibility.minWidth || clipH < spec.eligibility.minHeight) return

  const draftValue = clipControlDraftValue(activeControl, clip.id)
  const hasDraft = draftValue != null
  const committedFades = normalizeClipFades(clip)
  const fadeInPercent = hasDraft && activeControl.kind === 'fadeIn'
    ? clampNumber(draftValue, 0, Math.max(0, 100 - committedFades.fadeOutPercent))
    : committedFades.fadeInPercent
  const fadeOutPercent = hasDraft && activeControl.kind === 'fadeOut'
    ? clampNumber(draftValue, 0, Math.max(0, 100 - committedFades.fadeInPercent))
    : committedFades.fadeOutPercent
  const velocity = hasDraft && activeControl.kind === 'volume'
    ? clampNumber(draftValue, 0, CLIP_GAIN_MAX_VELOCITY)
    : clampNumber(clip.velocity ?? 1, 0, CLIP_GAIN_MAX_VELOCITY)

  const activeKind = hasDraft ? activeControl.kind : null
  const hoveredKind = hoveredControl?.clipId === clip.id ? hoveredControl.kind : null
  const visibility = getClipControlVisibility({ selected, hoveredKind, activeKind }, spec)
  const geometry = computeClipControlGeometry({
    clip,
    rect: { x, y, w: clipW, h: clipH },
    values: { velocity, fades: { fadeInPercent, fadeOutPercent } },
    spec,
  })
  if (!geometry.eligible || (!visibility.gainLine && !visibility.handles)) return

  const accent = mixHex(baseHex, { r: 255, g: 255, b: 255 }, spec.appearance.accentMixToWhite)
  const dark = mixHex(baseHex, { r: 0, g: 0, b: 0 }, spec.appearance.darkMixToBlack)
  const lineY = geometry.gain.lineY
  const { x: pillX, y: pillY, w: pillW, h: pillH } = geometry.gain.pill
  const isActiveFadeIn = activeKind === 'fadeIn'
  const isActiveFadeOut = activeKind === 'fadeOut'
  const isActiveVolume = activeKind === 'volume'
  const isActive = Boolean(activeKind)
  const isHovered = Boolean(hoveredKind)
  const isUnity = Math.abs(velocity - 1) < 0.0005

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, clipW, clipH)
  ctx.clip()

  if (visibility.handles) {
    ctx.fillStyle = dark
    ctx.globalAlpha = isActive
      ? spec.appearance.fadeActiveAlpha
      : (isHovered
          ? spec.appearance.fadeHoverAlpha
          : (selected ? spec.appearance.fadeSelectedAlpha : spec.appearance.fadeIdleAlpha))
    // Selected / active handles: a 1px selection outline. No glow.
    const selectOutline = (selected || isActive) ? (resolveTimelinePalette().select || accent) : null
    ctx.strokeStyle = selectOutline || `rgba(255,255,255,${spec.appearance.fadeStrokeAlpha})`
    ctx.lineWidth = selectOutline ? 1 : spec.appearance.fadeStrokeWidth
    ctx.shadowColor = accent
    ctx.shadowBlur = isActiveFadeIn || isActiveFadeOut
      ? spec.appearance.fadeActiveShadowBlur
      : (isHovered
          ? spec.appearance.fadeHoverShadowBlur
          : (selected ? spec.appearance.fadeSelectedShadowBlur : spec.appearance.fadeIdleShadowBlur))
    const fadeInWedge = geometry.fadeIn.wedge
    ctx.beginPath()
    ctx.moveTo(fadeInWedge.left, fadeInWedge.bottom)
    ctx.lineTo(fadeInWedge.right, fadeInWedge.bottom)
    ctx.lineTo(fadeInWedge.left, fadeInWedge.top)
    ctx.closePath()
    ctx.fill()
    if (selectOutline || spec.appearance.fadeStrokeWidth > 0) ctx.stroke()
    const fadeOutWedge = geometry.fadeOut.wedge
    ctx.beginPath()
    ctx.moveTo(fadeOutWedge.right, fadeOutWedge.bottom)
    ctx.lineTo(fadeOutWedge.left, fadeOutWedge.bottom)
    ctx.lineTo(fadeOutWedge.right, fadeOutWedge.top)
    ctx.closePath()
    ctx.fill()
    if (selectOutline || spec.appearance.fadeStrokeWidth > 0) ctx.stroke()
    ctx.shadowBlur = 0

    if (spec.gain.edgeRailWidth > 0) {
      ctx.globalAlpha = isActive
        ? spec.appearance.railActiveAlpha
        : (isHovered
            ? spec.appearance.railHoverAlpha
            : (selected ? spec.appearance.railSelectedAlpha : spec.appearance.railIdleAlpha))
      ctx.fillStyle = accent
      ctx.shadowColor = accent
      ctx.shadowBlur = isActive
        ? spec.appearance.railActiveShadowBlur
        : (isHovered
            ? spec.appearance.railHoverShadowBlur
            : (selected ? spec.appearance.railSelectedShadowBlur : spec.appearance.railIdleShadowBlur))
      const railY = y + spec.gain.edgeRailInsetY
      const railH = Math.max(0, clipH - spec.gain.edgeRailInsetY * 2)
      ctx.fillRect(x, railY, spec.gain.edgeRailWidth, railH)
      ctx.fillRect(x + clipW - spec.gain.edgeRailWidth, railY, spec.gain.edgeRailWidth, railH)
      ctx.shadowBlur = 0
    }
  }

  if (visibility.gainLine) {
    ctx.globalAlpha = isActiveVolume
      ? spec.appearance.lineActiveAlpha
      : (isHovered
          ? spec.appearance.lineHoverAlpha
          : (selected ? spec.appearance.lineSelectedAlpha : spec.appearance.lineIdleAlpha))
    ctx.strokeStyle = accent
    ctx.lineWidth = spec.gain.lineWidth
    ctx.shadowColor = accent
    ctx.shadowBlur = isActiveVolume
      ? spec.appearance.lineActiveShadowBlur
      : (isHovered
          ? spec.appearance.lineHoverShadowBlur
          : (selected ? spec.appearance.lineSelectedShadowBlur : spec.appearance.lineIdleShadowBlur))
    ctx.beginPath()
    ctx.moveTo(x, lineY)
    ctx.lineTo(x + clipW, lineY)
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  if (visibility.handles) {
    ctx.globalAlpha = 1
    const pillMix = isActiveVolume
      ? spec.appearance.pillActiveMixToWhite
      : (hoveredKind === 'volume'
          ? spec.appearance.pillHoverMixToWhite
          : (selected ? spec.appearance.pillSelectedMixToWhite : spec.appearance.pillIdleMixToWhite))
    ctx.fillStyle = mixHex(baseHex, { r: 255, g: 255, b: 255 }, pillMix)
    const pillOutline = (selected || isActiveVolume) ? (resolveTimelinePalette().select || accent) : null
    ctx.strokeStyle = pillOutline || `rgba(0,0,0,${spec.appearance.pillStrokeAlpha})`
    ctx.lineWidth = pillOutline ? 1 : spec.appearance.pillStrokeWidth
    ctx.shadowColor = isUnity ? `rgba(255,255,255,${spec.appearance.unityShadowAlpha})` : accent
    ctx.shadowBlur = isActiveVolume
      ? spec.appearance.pillActiveShadowBlur
      : (hoveredKind === 'volume'
          ? spec.appearance.pillHoverShadowBlur
          : (selected ? spec.appearance.pillSelectedShadowBlur : spec.appearance.pillIdleShadowBlur))
    roundedRect(ctx, pillX, pillY, pillW, pillH, spec.gain.pillRadius)
    ctx.fill()
    if (pillOutline || spec.appearance.pillStrokeWidth > 0) ctx.stroke()
    ctx.shadowBlur = 0

    ctx.strokeStyle = `rgba(14,15,24,${spec.appearance.glyphAlpha})`
    ctx.lineWidth = spec.gain.glyphLineWidth
    for (let i = 0; i < spec.gain.glyphCount; i++) {
      const gx = pillX + spec.gain.glyphStartX + i * spec.gain.glyphSpacing
      const top = pillY + spec.gain.glyphTopInset + (i % 2) * spec.gain.glyphAlternation
      const bottomLine = pillY + pillH - spec.gain.glyphBottomInset
      ctx.beginPath()
      ctx.moveTo(gx, Math.min(top, bottomLine))
      ctx.lineTo(gx, bottomLine)
      ctx.stroke()
    }
  }

  if (spec.debug.showPaintBounds) {
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = '#FF4FD8'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, clipW - 1), Math.max(0, clipH - 1))
  }
  if (spec.debug.showHitRegions) {
    ctx.globalAlpha = 0.28
    ctx.fillStyle = '#FFD84F'
    const pill = geometry.gain.pill
    ctx.fillRect(
      pill.x - spec.interaction.gainHitSlopX,
      pill.y - spec.interaction.gainHitSlopY,
      pill.w + spec.interaction.gainHitSlopX * 2,
      pill.h + spec.interaction.gainHitSlopY * 2,
    )
    ctx.fillStyle = '#4FFFE1'
    const hitY = y + clipH - spec.interaction.fadeHitHeight
    const hitW = (spec.interaction.fadeHandleHalfWidth + spec.interaction.fadeExtraSlop) * 2
    ctx.fillRect(geometry.fadeIn.anchor.x - hitW / 2, hitY, hitW, spec.interaction.fadeHitHeight)
    ctx.fillRect(geometry.fadeOut.anchor.x - hitW / 2, hitY, hitW, spec.interaction.fadeHitHeight)
  }
  if (spec.debug.showAnchors) {
    ctx.globalAlpha = 1
    ctx.fillStyle = '#FFFFFF'
    for (const anchor of [geometry.gain.anchor, geometry.fadeIn.anchor, geometry.fadeOut.anchor]) {
      ctx.beginPath()
      ctx.arc(anchor.x, anchor.y, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.restore()
}

function drawMetadataChips(ctx, chips, area, palette, { handleReserveRight = 0, leftLimit }) {
  if (!chips.length) return
  const font = uiCanvasFont('500 9px')
  ctx.font = font
  ctx.textBaseline = 'middle'

  const proc = chips.find(c => c.kind === 'proc')
  const gain = chips.find(c => c.kind === 'gain')

  const measure = (chip) => {
    const tw = measureCanvasTextWidth(ctx, font, chip.text)
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

// ── Content draw: per-frame state shared by every block ─────────────────────

/**
 * What a content-layer draw needs to know about the viewport. The caller
 * (TimelineCanvas.redrawContent) builds one per frame and hands the same object
 * to drawClips and drawPatternBlocks.
 *
 * @typedef {object} TimelineDrawView
 * @property {CanvasRenderingContext2D} ctx  already scaled for DPR
 * @property {number} w                viewport width, CSS px
 * @property {number} h                viewport height, CSS px
 * @property {number} scrollOffset     left edge of the viewport, in beats
 * @property {number} ppb              pixels per beat
 * @property {Object<string, number>} trackIdToIndex
 * @property {object} [trackLayout]    row layout (timelineRowLayout.js)
 * @property {object} [palette]        resolveTimelinePalette() result
 * @property {object} [displaySettings] raw Timeline display settings
 * @property {Object<string, string>} [trackColorById]
 * @property {Set} [mutedTrackIds]
 */

function beginFrame(view) {
  return {
    ctx: view.ctx,
    w: view.w,
    h: view.h,
    scrollOffset: view.scrollOffset,
    ppb: view.ppb,
    trackIdToIndex: view.trackIdToIndex || {},
    trackLayout: view.trackLayout ?? null,
    trackColorById: view.trackColorById ?? null,
    mutedTrackIds: view.mutedTrackIds ?? null,
    p: view.palette ?? resolveTimelinePalette(),
    ds: normalizeTimelineDisplaySettings(view.displaySettings),
    titleFont: uiCanvasFont('600 10px'),
  }
}

// A block takes its track's colour. The region-label colour is only a fallback
// for a track with no resolved colour, and is looked up in the per-theme
// palette: it used to be a getComputedStyle read for every block on every
// frame whose result was then almost always thrown away.
function blockColor(frame, trackId, label) {
  const trackColor = frame.trackColorById?.[trackId]
  if (trackColor) return trackColor
  const labelColors = frame.p.labelColors
  return labelColors ? pickLabelHexColor(labelColors, label) : labelHexColor(label)
}

// One scratch rectangle for the draw loops (see blockRect's `out`).
const _blockRect = {}

// ── Block shell: the parts clips and pattern blocks share ──────────────────

// One bounded 1px stroke just inside the coloured border. Keeps the block's
// own colour while making selection read in dark and light themes alike.
// `inset` is how many whole pixels of border sit outside the ring.
function paintSelectionRing(ctx, r, color, inset) {
  const size = inset * 2 + 1
  if (r.w <= size + 1 || r.h <= size + 1) return
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.strokeRect(r.x + inset + 0.5, r.y + inset + 0.5, r.w - size, r.h - size)
}

// A border of `width` whole pixels drawn entirely INSIDE the block. A stroke
// centred on the block's edge straddles the pixel grid (a 1px line becomes two
// half-strength rows) and spills onto whatever sits next to the block.
function paintInsetBorder(ctx, r, color, width) {
  if (r.w <= width || r.h <= width) return
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.strokeRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width)
}

function paintTitleStrip(ctx, layout, fill, separator) {
  ctx.fillStyle = fill
  ctx.fillRect(layout.titleX, layout.titleY, layout.titleW, layout.titleH)
  ctx.fillStyle = separator
  ctx.fillRect(layout.titleX, layout.titleY + layout.titleH - 1, layout.titleW, 1)
}

// Mute glyph + the block's name, truncated to what the strip has room for.
// `reserveLeft` / `reserveRight` keep the text clear of resize handles and of
// anything else parked in the strip (the pattern loop glyph).
function paintBlockTitle(frame, layout, text, ink, showName, muted, reserveLeft, reserveRight) {
  const { ctx } = frame
  const muteReserve = muted ? MUTE_GLYPH_W : 0
  if (muted && layout.titleW > MUTE_GLYPH_W + TITLE_TEXT_PAD_X * 2) {
    drawMuteGlyph(ctx, layout.titleX + reserveLeft + TITLE_TEXT_PAD_X, layout.titleY + layout.titleH / 2, ink)
  }
  const availW = Math.max(
    0,
    layout.titleW - TITLE_TEXT_PAD_X * 2 - reserveRight - reserveLeft - muteReserve,
  )
  // 'always' shows a name in less room, down to a bare ellipsis.
  const always = showName === 'always'
  if (availW < (always ? NAME_ALWAYS_MIN_W : NAME_AUTO_MIN_W)) return

  const textX = layout.titleX + reserveLeft + muteReserve + TITLE_TEXT_PAD_X
  ctx.save()
  ctx.beginPath()
  ctx.rect(textX, layout.titleY, availW, layout.titleH)
  ctx.clip()
  ctx.fillStyle = ink
  ctx.font = frame.titleFont
  ctx.textBaseline = 'middle'
  const fitted = fitCanvasText(ctx, frame.titleFont, text, availW, always)
  if (fitted) ctx.fillText(fitted, textX, layout.titleY + layout.titleH / 2)
  ctx.restore()
}

function paintResizeHandles(ctx, r, color, left, right) {
  ctx.fillStyle = color
  if (left) ctx.fillRect(r.x, r.y, HANDLE_W, r.h)
  if (right) ctx.fillRect(r.x + r.w - HANDLE_W, r.y, HANDLE_W, r.h)
}

// ── Clips ───────────────────────────────────────────────────────────────────

const _clipMaterialCache = new Map()
function clipBodyMaterial(ctx, r, hex, ds, selected, muted) {
  const mode = ds.timelineClipBodyMode
  const contrast = ds.timelineClipContrast
  // A gradient is positioned on the block, so it cannot be shared.
  const shared = mode !== 'gradient'
  const key = shared ? hex + '|' + mode + '|' + contrast + (selected ? '|s' : '|-') + (muted ? 'm' : '-') : null
  const hit = shared ? _clipMaterialCache.get(key) : undefined
  if (hit) return hit
  const material = getTimelineBodyMaterial({
    baseHex: hex, mode, selected, muted, contrast,
    gradientDirection: ds.timelineBodyGradientDirection,
    ctx, x: r.x, y: r.y, w: r.w, h: r.h,
  })
  return shared ? cachePut(_clipMaterialCache, key, material) : material
}

const _titleStripCache = new Map()
function clipTitleStripStyle(hex, ds, selected, muted) {
  const key = hex + '|' + ds.timelineClipBodyMode + '|' + ds.timelineClipContrast + (selected ? '|s' : '|-') + (muted ? 'm' : '-')
  return _titleStripCache.get(key) ?? cachePut(
    _titleStripCache, key,
    getTitleStripStyle(hex, ds.timelineClipBodyMode, selected, muted, ds.timelineClipContrast),
  )
}

// Syllable clip numbering. getSyllableDisplayNumber rebuilds the region's whole
// selectable-syllable list on every call; a syllable-chopped region has dozens
// of clips on screen asking the same question every frame. Region data only
// arrives as fresh objects from the engine, so the array is the revision key.
const _syllableNumbers = new WeakMap()
function syllableDisplayNumber(syllables, sourceIndex) {
  if (!Array.isArray(syllables)) return getSyllableDisplayNumber(syllables, sourceIndex)
  let numbers = _syllableNumbers.get(syllables)
  if (!numbers) {
    numbers = new Map(getSelectableSyllables(syllables).map((e) => [e.sourceIndex, e.number]))
    _syllableNumbers.set(syllables, numbers)
  }
  return numbers.get(sourceIndex) ?? sourceIndex + 1
}

// A syllable clip is labelled "<n> <text>" (or just "<n>"), not by region name.
function clipLabelText(clip, region) {
  if (clip.syllableIndex == null || clip.syllableIndex < 0) return region?.name || '?'
  const displayNumber = syllableDisplayNumber(region?.syllables, clip.syllableIndex)
  const text = region?.syllables?.[clip.syllableIndex]?.text
  return text ? `${displayNumber} ${text}` : `${displayNumber}`
}

// Waveform inside a clip's content region. Picks the best data available for
// the current zoom regime (hi-res samples / peaks, else the low-res envelope)
// and only ever emits the columns that fall inside the viewport.
function paintClipWaveform(frame, pass, clip, region, r, layout, selected, muted) {
  const { ctx, w, p, ds } = frame
  const { bpm, regime } = pass
  // The waveform maps time to pixels exactly; it must not inherit any rounding
  // applied to the block's painted outline.
  const x = r.timeX
  const clipW = r.timeW

  // Swap-aware: extend draw span past video range when swapped audio is longer.
  const regionDurSec = getRegionPlaybackDurationSec(region)

  // Visible pixel range (clip ∩ viewport)
  const visL = Math.max(0, x)
  const visR = Math.min(w, x + clipW)
  if (!(regionDurSec > 0 && visR > visL)) return

  const regionDurTicks = regionDurSec * (bpm / 60) * PPQ
  const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
  const regionOffsetSec = getClipRegionWaveformStartSec(clip, region, bpm)

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

  // Bright "core" over a dark "halo" — the two contrast against EACH
  // OTHER, not against the clip's own (arbitrarily saturated) fill, so
  // the waveform stays legible at any hue and any clip-contrast level.
  // wfCm nudges both up together with the Contrast setting instead of
  // holding them fixed while the clip body underneath gets more opaque.
  //
  // A muted track's waveform dims with the rest of the clip. It used to stay
  // at full strength over a body dimmed to 45%, which made muted audio the
  // most prominent thing on the lane.
  const wfCm = _waveformContrastMul(ds.timelineClipContrast) * (muted ? MUTE_OPACITY : 1)
  const lineColor = withAlpha(p.clipWaveformFg, _clampAlpha((selected ? 1.0 : 0.93) * wfCm))
  const traceFill = withAlpha(p.clipWaveformBg, _clampAlpha((selected ? 1.0 : 0.88) * wfCm))

  let drawn = false

  // ── Try hi-res cache for trace/waveform/sample regimes ──────────────
  if (regime !== 'envelope' && pass.hiResCache) {
    const hiResVisStart = hasProcessing ? clipLocalStart : visStartSec
    const hiResVisEnd   = hasProcessing ? clipLocalEnd   : visEndSec

    // Processed clips: keyed by "c"+clipId with clip-local time coords —
    // one clip, one buffer, no collision possible, so a single entry.
    //
    // Unprocessed clips: keyed by regionId holding an ARRAY of entries,
    // because many clips commonly reference DIFFERENT sub-ranges of the
    // same source region (a syllable-chopped region is the textbook
    // case — see hiResFetchPlanner.js). A single slot there meant clip
    // B's fetch silently discarded clip A's, forever, every settle pass.
    // findCoveringEntry picks whichever entry (if any) actually covers
    // THIS clip's window — see hiResCoverage.js for what "covers" means.
    const hiRes = hasProcessing
      ? pass.hiResCache[`c${clip.id}`]
      : findCoveringEntry(pass.hiResCache[clip.regionId], hiResVisStart, hiResVisEnd)

    if (!hasProcessing && regime === 'sample' && hiRes?.samples) {
      // Regime 4: individual sample dots (unprocessed only)
      const sr = hiRes.sampleRate || DEFAULT_SR
      const visStartSample = Math.floor(hiResVisStart * sr)
      const visEndSample   = Math.ceil(hiResVisEnd   * sr)
      const dataOffset = visStartSample - hiRes.startSample
      const dataCount  = visEndSample - visStartSample
      if (dataOffset >= 0 && dataOffset + dataCount <= hiRes.samples.length) {
        drawSamplePoints(ctx, hiRes.samples, visL, layout.contentY, visR - visL, layout.contentH,
          dataOffset, dataCount, lineColor, undefined, traceFill)
        drawn = true
      }
    } else if (hiRes?.peaks && hiRes.stride === 3) {
      // Regime 2 (trace) or 3 (waveform): hi-res peaks.
      //
      // MUST require the cache to fully cover the requested visible
      // window before using it — this was the source of the "waveform
      // stretches while panning" bug. The old code clamped f0/f1 to
      // [0,1] and then drew whatever fell in that clamped range across
      // the FULL visL..visR width regardless of how much time it
      // actually represented: pan a little past a cached window (e.g.
      // cache covers sec 10-15, view now wants 12-17) and the last 60%
      // of the cache's columns — representing only 3 of the 5 requested
      // seconds — got stretched to fill all 5 seconds of pixel width.
      // That mismatch between "columns available" and "columns
      // requested" is exactly a rubber-band distortion, and it only
      // resolved once the 80ms-debounced refetch replaced the cache.
      //
      // The sample-regime branch above never had this bug — it already
      // requires `dataOffset >= 0 && dataOffset + dataCount <=
      // hiRes.samples.length`, i.e. full coverage, and simply skips
      // (falls through to the low-res fallback) otherwise. The epsilon
      // here matches the ON-SETTLE fetch effect's own "is this cache
      // entry still good enough to skip refetching" check (TimelineView
      // .jsx) — the draw path must agree with the fetch path on what
      // "covers the window" means, or a window the fetcher considers
      // fresh can still get judged too incomplete to draw, or vice versa.
      const totalHiCols = Math.floor(hiRes.peaks.length / 3)
      const hiDur = hiRes.endSec - hiRes.startSec
      if (
        hiDur > 0 && totalHiCols > 0 &&
        hiResCoversWindow(hiRes.startSec, hiRes.endSec, hiResVisStart, hiResVisEnd)
      ) {
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
              startCol, endCol, lineColor, 1.5, traceFill, 1.5)
          }
          drawn = true
        }
      }
    }
  }

  // ── Fallback: low-res envelope ───────────────────────────────────────
  if (!drawn) {
    if (hasProcessing && pass.clipPeakCache) {
      // Processed clip: use clip-level peaks (full processed buffer, 0..clipDurSec).
      const cpData = pass.clipPeakCache[clip.id]
      if (cpData?.peaks && cpData.stride === 3) {
        const totalCols = Math.floor(cpData.peaks.length / 3)
        // Map visible pixel range to fraction of the processed clip
        const f0 = Math.max(0, clipLocalStart / clipDurSec)
        const f1 = Math.min(1, clipLocalEnd   / clipDurSec)
        const startCol = Math.floor(f0 * totalCols)
        const endCol   = Math.min(totalCols, Math.ceil(f1 * totalCols))
        // Emit only the columns the clip rect will actually keep — a clip
        // far wider than the viewport otherwise pays for its whole span.
        const win = visibleColumnWindow(x, clipW, startCol, endCol, visL, visR)
        if (win) {
          if (regime === 'trace') {
            drawTrace(ctx, cpData.peaks, win.x, layout.contentY, win.w, layout.contentH,
              win.startCol, win.endCol, traceFill, lineColor)
          } else {
            drawEnvelope(ctx, cpData.peaks, win.x, layout.contentY, win.w, layout.contentH,
              win.startCol, win.endCol, traceFill, lineColor)
          }
        }
      }
    } else if (!hasProcessing && pass.waveformCache) {
      // Unprocessed clip: use raw region peaks with regionOffset applied.
      const wfData = pass.waveformCache[clip.regionId]
      if (wfData?.peaks && wfData.stride === 3) {
        const totalPeakCols = Math.floor(wfData.peaks.length / 3)
        const offsetFrac = regionDurSec > 0 ? regionOffsetSec / regionDurSec : 0
        const durFrac = clip.durationTicks / regionDurTicks
        const startCol = Math.floor(offsetFrac * totalPeakCols)
        const endCol = Math.min(totalPeakCols, Math.ceil((offsetFrac + durFrac) * totalPeakCols))

        const win = visibleColumnWindow(x, clipW, startCol, endCol, visL, visR)
        if (win) {
          if (regime === 'trace') {
            drawTrace(ctx, wfData.peaks, win.x, layout.contentY, win.w, layout.contentH,
              win.startCol, win.endCol, traceFill, lineColor)
          } else {
            drawEnvelope(ctx, wfData.peaks, win.x, layout.contentY, win.w, layout.contentH,
              win.startCol, win.endCol, traceFill, lineColor)
          }
        }
      }
    }
  }

  ctx.restore()
}

function paintClip(frame, pass, clip, r) {
  const { ctx, p, ds } = frame
  const region = pass.regions[clip.regionId]
  const hex = blockColor(frame, clip.trackId, region?.label)
  const selected = !!pass.selectedClipIds?.has(clip.id)
  const muted = !!frame.mutedTrackIds?.has(clip.trackId)

  // ── Body: fill, border, selection ring ────────────────────────────────
  const material = clipBodyMaterial(ctx, r, hex, ds, selected, muted)
  ctx.fillStyle = material.fillStyle
  ctx.fillRect(r.x, r.y, r.w, r.h)
  paintInsetBorder(ctx, r, material.borderStyle, material.borderWidth)
  if (selected) paintSelectionRing(ctx, r, p.selectionHighlight, material.borderWidth)

  const showName = ds.timelineShowClipNames
  const layout = blockInnerLayout(r, blockWantsTitleStrip(r, showName))

  // ── Waveform ──────────────────────────────────────────────────────────
  // Gated by timelineShowWaveforms: never / always (>= 16px) / auto (>= 24px).
  if (pass.waveformMode !== 'never' && r.w >= pass.waveformMinW && pass.bpm && region) {
    paintClipWaveform(frame, pass, clip, region, r, layout, selected, muted)
  }

  // ── Fade overlay ──────────────────────────────────────────────────────
  // A fade handle being dragged paints its draft value, not the committed one.
  const committedFades = normalizeClipFades(clip)
  const draftValue = clipControlDraftValue(pass.activeControl, clip.id)
  const fadeInPercent = draftValue != null && pass.activeControl.kind === 'fadeIn'
    ? clampNumber(draftValue, 0, Math.max(0, 100 - committedFades.fadeOutPercent))
    : committedFades.fadeInPercent
  const fadeOutPercent = draftValue != null && pass.activeControl.kind === 'fadeOut'
    ? clampNumber(draftValue, 0, Math.max(0, 100 - committedFades.fadeInPercent))
    : committedFades.fadeOutPercent
  if (fadeInPercent > 0 || fadeOutPercent > 0) {
    drawClipFadeOverlay(
      ctx, clip, r.x, r.y, r.w, r.h, selected, p.clipFadeOverlay,
      pass.controlSpec, { fadeInPercent, fadeOutPercent },
    )
  }

  // ── Title strip, name, metadata chips ─────────────────────────────────
  // Tiny blocks show body / border / handles only.
  const showHandles = selected && blockShowsHandles(r)
  if (r.w > TINY_BLOCK_MAX_W) {
    const handleReserve = showHandles ? HANDLE_W : 0

    if (layout.useStrip && showName !== 'never') {
      const strip = clipTitleStripStyle(hex, ds, selected, muted)
      paintTitleStrip(ctx, layout, strip.fill, strip.separator)
      paintBlockTitle(
        frame, layout,
        clipLabelText(clip, region),
        clipLabelInk(p, HEX6.test(hex) ? hex : '#808080', strip.alpha),
        showName, muted, handleReserve, handleReserve,
      )
    }

    const showMeta = ds.timelineShowPitchShift
    if (showMeta !== 'never' && r.w >= (showMeta === 'always' ? META_ALWAYS_MIN_W : META_AUTO_MIN_W)) {
      const chips = buildClipMetadataChips(clip)
      if (chips.length) {
        drawMetadataChips(ctx, chips, layout.metadataArea, p, {
          handleReserveRight: handleReserve,
          leftLimit: r.x + handleReserve + 2,
        })
      }
    }
  }

  // ── Gain / fade controls, then resize handles on top of everything ────
  drawClipInlineControls(
    ctx, clip, r.x, r.y, r.w, r.h, hex, selected,
    pass.activeControl, pass.hoveredControl, pass.controlSpec,
  )
  if (showHandles) paintResizeHandles(ctx, r, hexToRgba(hex, 1.0), true, true)

  // ── At-limit marker (group drag) ──────────────────────────────────────
  // This clip is what stopped the whole selection from travelling further.
  // Ringed so the user can find it and either adjust or deselect it.
  if (pass.activeControl?.blocked?.has(clip.id)) {
    ctx.save()
    ctx.strokeStyle = p.clipControlAtLimit || '#ff5c5c'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    ctx.strokeRect(r.x + 1, r.y + 1, Math.max(0, r.w - 2), Math.max(0, r.h - 2))
    ctx.restore()
  }
}

/**
 * Paint every audio clip in the viewport. Clears the content layer first: this
 * is the first content draw of a frame.
 *
 * @param {TimelineDrawView} view
 * @param {object} data
 * @param {Array}  data.clips
 * @param {object} data.regions            regionId -> region
 * @param {Set}    data.selectedClipIds
 * @param {number} data.bpm
 * @param {object} [data.waveformCache]    regionId -> low-res peaks
 * @param {object} [data.hiResCache]       hi-res peaks / samples (see paintClipWaveform)
 * @param {object} [data.clipPeakCache]    clipId -> peaks of the processed buffer
 * @param {object} [data.activeClipControl]  in-flight gain/fade drag draft
 * @param {object} [data.hoveredClipControl] { clipId, kind } under the pointer
 * @param {object} [data.clipControlSpec]
 */
export function drawClips(view, data) {
  view.ctx.clearRect(0, 0, view.w, view.h)
  const clips = data?.clips
  if (!clips || clips.length === 0) return

  const frame = beginFrame(view)
  const { ds, w, ppb, scrollOffset, trackIdToIndex, trackLayout } = frame

  // Waveform regime is global: samples-per-pixel is the same for every clip at
  // a given zoom. Shared, hysteresis-aware tracker — see waveformRegime.js for
  // why the previous regime is threaded through and shared with the hi-res
  // fetch effect rather than tracked per caller.
  const bpm = data.bpm
  const pixelsPerSecond = bpm ? ppb * (bpm / 60) : 0
  const spp = pixelsPerSecond > 0 ? DEFAULT_SR / pixelsPerSecond : 9999

  const pass = {
    regions: data.regions || {},
    selectedClipIds: data.selectedClipIds,
    bpm,
    regime: currentRegime(spp),
    waveformMode: ds.timelineShowWaveforms,
    waveformMinW: ds.timelineShowWaveforms === 'always' ? 16 : 24,
    waveformCache: data.waveformCache,
    hiResCache: data.hiResCache,
    clipPeakCache: data.clipPeakCache,
    activeControl: data.activeClipControl || null,
    hoveredControl: data.hoveredClipControl || null,
    controlSpec: normalizeClipControlSpec(data.clipControlSpec || CLIP_CONTROL_DEFAULTS),
  }

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const trackIdx = trackIdToIndex[clip.trackId]
    if (trackIdx == null) continue
    const r = blockRect(clip, trackIdx, scrollOffset, ppb, trackLayout, _blockRect)
    if (r.x + r.w < 0 || r.x > w) continue // off-screen
    paintClip(frame, pass, clip, r)
  }
}

// ── WORLD processing spinners ────────────────────────────────────────────────
// Draws a 14-px rotating arc at the bottom-right corner of each clip that is
// currently being processed by a WORLD render job.
// `accentColor` must be pre-resolved from the CSS variable by the caller since
// canvas cannot read CSS custom properties directly.

//
// Drawn on the OVERLAY layer, not with the clips: the spinner animates at 60fps
// for as long as a render job runs, and repainting it must not mean rebuilding
// every clip, waveform and pattern block on the content layer each frame.

export function drawWorldSpinners(
  ctx, clips, trackIdToIndex, worldProcessingClips,
  scrollOffset, ppb, spinAngle, accentColor, trackLayout = null, viewportW = Infinity,
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

    const r = blockRect(clip, trackIdx, scrollOffset, ppb, trackLayout, _blockRect)
    if (r.w < 20 || r.x + r.w < 0 || r.x > viewportW) continue

    const cx = r.x + r.w - SPINNER_PAD - SPINNER_R
    const cy = r.y + r.h - SPINNER_PAD - SPINNER_R

    ctx.beginPath()
    ctx.arc(cx, cy, SPINNER_R, spinAngle, spinAngle + ARC_SPAN)
    ctx.stroke()
  }
  ctx.restore()
}

// ── Pattern Blocks (content layer) ──────────────────────────────────────────

const _patternGlassCache = new Map()
function patternGlassStyle(hex, selected, muted) {
  const key = hex + (selected ? '|s' : '|-') + (muted ? 'm' : '-')
  return _patternGlassCache.get(key)
    ?? cachePut(_patternGlassCache, key, getPatternGlassStyle(hex, selected, muted))
}

// Mini piano roll inside a pattern block's content region: one 2px bar per
// note, Y proportional to pitch within the pattern's own range. Only note
// instances that can reach the viewport are visited (patternNoteIndex.js).
const PATTERN_NOTE_H = 2
function paintPatternNotes(frame, pattern, block, layout, hex, muted) {
  const { ctx, w, ppb, scrollOffset } = frame
  const index = getPatternNoteIndex(pattern)
  const minPitch = index.minPitch
  const pitchRange = Math.max(1, index.maxPitch - minPitch)
  const travel = layout.contentH - 4 - PATTERN_NOTE_H // 2px margin top and bottom
  const baseY = layout.contentY + 2 + travel

  const beatPos = ticksToBeats(block.positionTicks)
  const windowStart = block.offsetTicks || 0
  // The viewport, expressed on the block's note tape, padded by 2px so a note
  // widened to the 1px minimum at the very edge is still visited.
  const tapeOfTick = windowStart - block.positionTicks
  const viewLoTape = tapeOfTick + pixelToTickExact(-2, scrollOffset, ppb)
  const viewHiTape = tapeOfTick + pixelToTickExact(w + 2, scrollOffset, ppb)

  // Notes dim with their block on a muted track, like every other content.
  ctx.fillStyle = hexToRgba(hex, 0.95 * (muted ? MUTE_OPACITY : 1))
  ctx.save()
  ctx.beginPath()
  ctx.rect(layout.contentX, layout.contentY, layout.contentW, layout.contentH)
  ctx.clip()
  forEachBlockNote(pattern, block, viewLoTape, viewHiTape, (tape, durationTicks, pitch) => {
    const nx = beatToPixel(beatPos + ticksToBeats(tape - windowStart), scrollOffset, ppb)
    const nw = Math.max(1, ticksToBeats(durationTicks) * ppb)
    // Higher pitch = higher on screen (smaller Y).
    const ny = baseY - ((pitch - minPitch) / pitchRange) * travel
    ctx.fillRect(nx, ny, nw, PATTERN_NOTE_H)
  })
  ctx.restore()
}

function paintPatternBlock(frame, pass, block, r) {
  const { ctx, p, ds } = frame
  const pattern = pass.patterns?.[block.patternId]
  const region = pattern ? pass.regions?.[pattern.regionId] : null
  const hex = blockColor(frame, block.trackId, region?.label)
  const selected = !!pass.selectedBlockIds?.has(block.id)
  const muted = !!frame.mutedTrackIds?.has(block.trackId)

  // ── Tinted-glass body — fixed, not routed through the Clip body-mode
  // setting; derives entirely from the track's own colour. ────────────────
  const accentText = pickPatternAccentText(hex)
  const glass = patternGlassStyle(hex, selected, muted)

  // Body: the track colour at low lightness over the lane ground. No hatch.
  ctx.fillStyle = glass.fill
  ctx.fillRect(r.x, r.y, r.w, r.h)

  // Stroke: 2px solid track colour, drawn fully inside the bounds so adjacent
  // same-hue pattern blocks never visually merge.
  paintInsetBorder(ctx, r, glass.stroke, PATTERN_STROKE_WIDTH)

  // The ring sits on the inner half of the 2px stroke: colour, then highlight.
  if (selected) paintSelectionRing(ctx, r, p.selectionHighlight, 1)

  const showName = ds.timelineShowClipNames
  const layout = blockInnerLayout(r, blockWantsTitleStrip(r, showName))

  // Title strip: the shared one, in the track's colour, as on a clip. What sits on it (the
  // name, the loop glyph) takes the automatic label ink for that colour; with no strip the
  // glyph is on the dark body and keeps the light accent.
  if (layout.useStrip) paintTitleStrip(ctx, layout, glass.stripFill, glass.stripSeparator)
  const stripInk = layout.useStrip ? clipLabelInk(p, hex, glass.stripAlpha) : accentText

  // ── Note preview ──────────────────────────────────────────────────────
  // Gated by timelineShowPatternPreview: never / always (>= 20px) / auto (>= 32px).
  if (pass.previewMode !== 'never'
      && pattern && pattern.notes && pattern.notes.length > 0
      && pattern.lengthTicks > 0 && r.w >= pass.previewMinW) {
    paintPatternNotes(frame, pattern, block, layout, hex, muted)
  }

  // ── Resize handles ────────────────────────────────────────────────────
  // Both edges: dragging the left edge trims the block's start (it moves the
  // pattern offset), and the right edge its length. The left handle used to be
  // left unpainted although the edge was live.
  const showHandles = selected && blockShowsHandles(r)
  const handleReserve = showHandles ? HANDLE_W : 0
  if (showHandles) paintResizeHandles(ctx, r, hexToRgba(hex, 1.0), true, true)

  // ── Loop indicator (top-right, in the title-strip area) ───────────────
  // Shown when the block is longer than its pattern: repeat while it loops, arrow-to-bar when
  // block looping is off and the remainder plays as silence. Not on tiny
  // blocks (it is wider than they are and would print over their neighbour),
  // and kept clear of the right handle.
  const hasLoopGlyph = !!(pattern && pattern.lengthTicks > 0
                          && block.durationTicks > pattern.lengthTicks)
                       && r.w > TINY_BLOCK_MAX_W
  if (hasLoopGlyph) {
    drawIcon(
      ctx, block.loopEnabled === false ? 'arrow-line-right' : 'repeat',
      r.x + r.w - PATTERN_LOOP_GLYPH_RESERVE - handleReserve, r.y + 1, 10, stripInk,
    )
  }

  // ── Pattern name ──────────────────────────────────────────────────────
  if (r.w > TINY_BLOCK_MAX_W && layout.useStrip && showName !== 'never') {
    paintBlockTitle(
      frame, layout,
      pattern?.name || '?',
      stripInk,
      showName, muted,
      handleReserve,
      handleReserve + (hasLoopGlyph ? PATTERN_LOOP_GLYPH_RESERVE : 0),
    )
  }
}

/**
 * Paint every pattern block in the viewport, on top of whatever the content
 * layer already holds (drawClips runs first and does the clear).
 *
 * @param {TimelineDrawView} view
 * @param {object} data
 * @param {Array}  data.blocks
 * @param {object} data.patterns          patternId -> pattern
 * @param {object} [data.regions]         regionId -> region (label colour fallback)
 * @param {Set}    [data.selectedBlockIds]
 */
export function drawPatternBlocks(view, data) {
  const blocks = data?.blocks
  if (!blocks || blocks.length === 0) return

  const frame = beginFrame(view)
  const { ds, w, ppb, scrollOffset, trackIdToIndex, trackLayout } = frame
  const pass = {
    patterns: data.patterns,
    regions: data.regions,
    selectedBlockIds: data.selectedBlockIds,
    previewMode: ds.timelineShowPatternPreview,
    previewMinW: ds.timelineShowPatternPreview === 'always' ? 20 : 32,
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const trackIdx = trackIdToIndex[block.trackId]
    if (trackIdx == null) continue
    const r = blockRect(block, trackIdx, scrollOffset, ppb, trackLayout, _blockRect)
    if (r.x + r.w < 0 || r.x > w) continue // off-screen
    paintPatternBlock(frame, pass, block, r)
  }
}

// ── Automation clips (Phase B) ───────────────────────────────────────────────
// Canvas-only per the locked spec — no DOM overlay (would drift on scroll/zoom
// and corrupt hit-testing). Envelope points/hold-line come from
// automationLaneGeometry.js; this function only turns that geometry into pixels.

export function drawAutomationClips(
  ctx, w, h, scrollOffset, ppb,
  automationClips, automationLaneRowsByLaneId, automationEnvelopesById,
  selectedAutomationClipIds, palette = null, bindingLabelsByEnvelopeId = null,
  // Phase C — point editing. `selectedPoint` is { envelopeId, pointIndex } and
  // `pointDragPreview` is { envelopeId, pointIndex, tick, value }: the LOCAL
  // preview a point drag paints every frame, never an engine read. No IPC runs
  // during a drag, so the content layer is the only thing that knows about it.
  selectedPoint = null, pointDragPreview = null,
) {
  if (!automationClips || automationClips.length === 0) return
  const p = palette ?? resolveTimelinePalette()
  const accent = p.accent || '#5b8aff'

  for (let i = 0; i < automationClips.length; i++) {
    const clip = automationClips[i]
    const laneRow = automationLaneRowsByLaneId?.get(clip.laneId)
    if (!laneRow) continue // lane hidden (group collapsed) — nothing to draw

    // Single source of truth for the clip body + envelope band, shared with the
    // Phase C hit-tests so the drawn curve and the clickable curve agree.
    const body = automationClipBodyRect(clip, laneRow, ppb, scrollOffset)
    if (!body) continue
    const { x, w: clipW, y, h: clipH, headerH, contentTop, contentHeight: contentH } = body
    if (x + clipW < 0 || x > w) continue
    if (laneRow.y >= h || laneRow.y + laneRow.height < 0) continue

    const selected = selectedAutomationClipIds?.has(clip.id)

    // ── Body — neutral by default; accent is earned only by selection. ────
    ctx.fillStyle = p.clipWaveformBg || 'rgba(255,255,255,0.04)'
    ctx.fillRect(x, y, clipW, clipH)
    ctx.strokeStyle = selected ? accent : (p.laneSeparator || 'rgba(255,255,255,0.2)')
    ctx.lineWidth = selected ? 1.5 : 1
    ctx.strokeRect(x + 0.5, y + 0.5, clipW - 1, clipH - 1)

    const envelope = automationEnvelopesById?.get(clip.envelopeId)
    let points = envelope?.points ?? []
    // The drag preview reshapes the list for drawing only. Applying it here
    // (rather than layering a ghost on the overlay) keeps exactly ONE curve on
    // screen while dragging, which is what makes the edit read as direct.
    const dragging = pointDragPreview != null && envelope != null
      && pointDragPreview.envelopeId === envelope.id
    if (dragging) {
      points = applyPointDragPreview(points, pointDragPreview.pointIndex,
                                     pointDragPreview.tick, pointDragPreview.value)
    }
    const activePointIndex = dragging
      ? indexOfPointAtTick(points, pointDragPreview.tick)
      : (selectedPoint != null && envelope != null && selectedPoint.envelopeId === envelope.id
          ? selectedPoint.pointIndex : -1)

    // ── Envelope curve, clipped to the clip body so points outside the
    // visible [offset, offset+duration) window never bleed past the edges. ──
    if (points.length > 0 && clipW > 2) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, contentTop, clipW, contentH)
      ctx.clip()

      const curvePoints = buildAutomationCurveCanvasPoints(points, clip, ppb, scrollOffset, contentTop, contentH)
      if (curvePoints.length > 0) {
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.5
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        curvePoints.forEach((pt, idx) => (idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)))
        ctx.stroke()

        // Point dots. The active point (selected, or the one under the pointer
        // mid-drag) is the only one that fills with the accent — colour is
        // earned by a real state change, everything else stays neutral.
        for (let idx = 0; idx < curvePoints.length; idx++) {
          const pt = curvePoints[idx]
          const isActive = idx === activePointIndex
          ctx.beginPath()
          ctx.arc(pt.x, pt.y, isActive ? AUTOMATION_POINT_DRAW_RADIUS_PX + 1.4 : AUTOMATION_POINT_DRAW_RADIUS_PX, 0, Math.PI * 2)
          ctx.fillStyle = isActive ? accent : (p.bg || '#000')
          ctx.fill()
          ctx.strokeStyle = accent
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }

      // Dotted hold-line past the last point to the clip's right edge (FL parity).
      const holdLine = buildAutomationHoldLine(points, clip, ppb, scrollOffset, contentTop, contentH)
      if (holdLine) {
        ctx.strokeStyle = withAlpha(accent, 0.6)
        ctx.lineWidth = 1
        ctx.setLineDash([2, 3])
        ctx.beginPath()
        ctx.moveTo(holdLine.x1, holdLine.y)
        ctx.lineTo(holdLine.x2, holdLine.y)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.restore()
    }

    // ── Header: binding label ("<EffectName> - <ParamName>"), when there's
    // room for it. ──────────────────────────────────────────────────────────
    if (headerH >= 8 && clipW > 20) {
      const label = bindingLabelsByEnvelopeId?.get(clip.envelopeId)
      if (label) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x + 2, y, clipW - 4, headerH)
        ctx.clip()
        ctx.fillStyle = p.clipLabel || p.patternLabel
        ctx.font = uiCanvasFont('600 9px')
        ctx.textBaseline = 'top'
        ctx.fillText(label, x + 3, y + 1)
        ctx.restore()
      }
    }

    // ── Resize handles when selected ───────────────────────────────────────
    if (selected && clipW > 18) {
      ctx.fillStyle = accent
      ctx.fillRect(x, y, 3, clipH)
      ctx.fillRect(x + clipW - 3, y, 3, clipH)
    }
  }
}

// The dragged point's index AFTER the preview re-sort — a drag that carries a
// point past its neighbour changes its index, and the highlight has to follow
// the point, not the stale index.
function indexOfPointAtTick(points, tick) {
  for (let i = 0; i < points.length; i++) if (points[i].tick === tick) return i
  return -1
}

// ── Drop preview (drawn on overlay layer) ───────────────────────────────────

export function drawDropPreview(ctx, w, h, scrollOffset, ppb, preview, palette = null, trackLayout = null) {
  if (!preview) return
  const p = palette ?? resolveTimelinePalette()

  const { beat, trackIndex, durationBeats, color, name } = preview
  // Snapped like a real block (blockGeometry.js), so the preview sits exactly
  // where the dropped clip will be painted.
  const timeX = beatToPixel(beat, scrollOffset, ppb)
  const x = snapSpanLeft(timeX)
  const clipW = snapSpanWidth(timeX, durationBeats * ppb)
  const y = Math.round(_trackTop(trackIndex, trackLayout)) + CLIP_PAD
  const clipH = TRACK_HEIGHT - CLIP_PAD * 2

  // Fill
  ctx.fillStyle = hexToRgba(color, 0.35)
  ctx.fillRect(x, y, clipW, clipH)

  // Dashed border
  ctx.strokeStyle = hexToRgba(color, 0.7)
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x + 0.5, y + 0.5, clipW - 1, clipH - 1)
  ctx.setLineDash([])

  // Name at 50% opacity
  if (clipW > CLIP_TEXT_PAD * 2 + 10) {
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.rect(x + CLIP_TEXT_PAD, y, clipW - CLIP_TEXT_PAD * 2, clipH)
    ctx.clip()
    ctx.fillStyle = p.fgInverse
    ctx.font = uiCanvasFont('600 10px')
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
  const timeX = beatToPixel(beat, scrollOffset, ppb)
  const x = snapSpanLeft(timeX)
  const clipW = snapSpanWidth(timeX, durationBeats * ppb)
  const y = Math.round(_trackTop(trackIndex, trackLayout)) + GHOST_CLIP_PAD
  const clipH = TRACK_HEIGHT - GHOST_CLIP_PAD * 2

  if (x + clipW < 0 || x > w) return

  ctx.fillStyle = hexToRgba(color, 0.25)
  ctx.fillRect(x, y, clipW, clipH)

  ctx.strokeStyle = hexToRgba(color, 0.5)
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x + 0.5, y + 0.5, clipW - 1, clipH - 1)
  ctx.setLineDash([])

  if (clipW > CLIP_TEXT_PAD * 2 + 10 && name) {
    ctx.save()
    ctx.globalAlpha = 0.4
    ctx.beginPath()
    ctx.rect(x + CLIP_TEXT_PAD, y, clipW - CLIP_TEXT_PAD * 2, clipH)
    ctx.clip()
    ctx.fillStyle = p.fgInverse
    ctx.font = uiCanvasFont('600 10px')
    ctx.textBaseline = 'middle'
    ctx.fillText(name, x + CLIP_TEXT_PAD, y + clipH / 2)
    ctx.restore()
  }
}

/**
 * Draw notation ghost clips: translucent preview clips derived from a parsed
 * notation string, all on ONE row (the track the clips will be inserted on),
 * each carrying its syllable number in large type so you can read the pattern
 * straight off the timeline. Drawn on the content canvas AFTER real clips,
 * read from a separate ref; never touches clipsRef.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array}    ghostClips     Array of { syllableIndex, startTick, lengthTicks, audioOffsetPercent }
 * @param {Array}    clips          Real clips ON THE TARGET TRACK, for collision detection (read-only)
 * @param {Function} tickToPixelFn  (tick: number) => x pixel
 * @param {number}   rowTop         Top y pixel of the target track row (raw, no padding)
 * @param {object}   theme          Resolved palette from resolveTimelinePalette()
 */
export function drawGhostClips(ctx, ghostClips, clips, tickToPixelFn, rowTop, theme) {
  if (!ghostClips || ghostClips.length === 0) return
  const p = theme ?? resolveTimelinePalette()
  const palette = p.trackPalette || TRACK_PALETTE_FALLBACK

  // Build tick ranges from real clips for collision detection (read-only)
  const clipRanges = clips
    ? clips.map(c => ({ start: c.positionTicks | 0, end: (c.positionTicks | 0) + (c.durationTicks | 0) }))
    : []

  const y = rowTop + GHOST_CLIP_PAD
  const h = TRACK_HEIGHT - GHOST_CLIP_PAD * 2
  const fontPx = Math.max(10, Math.min(22, h - 6))
  const boxes = []

  for (const gc of ghostClips) {
    const { syllableIndex, startTick } = gc
    const lengthTicks = gc.lengthTicks || 240  // fall back to a 16th note
    const color = palette[syllableIndex % palette.length] || p.accent

    const x = tickToPixelFn(startTick)
    const w = tickToPixelFn(startTick + lengthTicks) - x
    if (w < 1) continue

    const hasCollision = clipRanges.some(r => startTick < r.end && startTick + lengthTicks > r.start)

    ctx.fillStyle = withAlpha(color, 0.55)
    ctx.fillRect(x, y, w, h)

    ctx.strokeStyle = hasCollision ? p.warning : p.accent
    ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])
    boxes.push({ x, w, label: String(syllableIndex + 1), color })
  }

  // Big syllable numbers. A label is skipped, not squeezed, when the room to
  // the next ghost is narrower than the digit: zoom in to read a dense roll.
  ctx.save()
  ctx.font = uiCanvasFont(`700 ${fontPx}px`)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  for (let i = 0; i < boxes.length; i++) {
    const { x, w, label, color } = boxes[i]
    const room = (i + 1 < boxes.length ? Math.min(boxes[i + 1].x - x, w) : w)
    if (ctx.measureText(label).width + 2 > room) continue
    const ink = /^#[0-9a-f]{6}$/i.test(color) ? clipLabelInk(p, color, 0.55) : (p.ink || '#E6E6E6')
    ctx.strokeStyle = withAlpha(ink === p.inkDark ? (p.ink || '#E6E6E6') : (p.inkDark || '#1B1B1B'), 0.6)
    ctx.strokeText(label, x + w / 2, y + h / 2 + 1)
    ctx.fillStyle = ink
    ctx.fillText(label, x + w / 2, y + h / 2 + 1)
  }
  ctx.restore()
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

// `fillColor`/`strokeColor` are pre-resolved rgba() strings (see selectTool's
// ghostColors) rather than a hex string to convert here — with up to
// hundreds of these drawn per drag frame, re-parsing the same hex color on
// every call added up. Dash style is shared by every ghost in a drag, so the
// caller sets it once around the whole batch instead of per call.
export function drawMovePreview(ctx, w, h, scrollOffset, ppb, preview, trackLayout = null) {
  if (!preview) return
  const { beat, trackIndex, durationBeats, fillColor, strokeColor } = preview
  // Same snapping and minimum width as the block it previews.
  const timeX = beatToPixel(beat, scrollOffset, ppb)
  const x = snapSpanLeft(timeX)
  const clipW = snapSpanWidth(timeX, durationBeats * ppb, CLIP_MIN_WIDTH_PX)
  // Cull off-screen — mirrors the drawClips cull above.
  if (x + clipW < 0 || x > w) return
  const y = Math.round(_trackTop(trackIndex, trackLayout)) + GHOST_CLIP_PAD
  const clipH = TRACK_HEIGHT - GHOST_CLIP_PAD * 2

  ctx.fillStyle = fillColor
  ctx.fillRect(x, y, clipW, clipH)
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 1.5
  ctx.strokeRect(x + 0.75, y + 0.75, clipW - 1.5, clipH - 1.5)
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

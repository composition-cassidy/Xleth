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
import { getRegionPlaybackDurationSec } from './regionDuration.js'

// Default engine sample rate (used for spp computation when no per-region rate is known)
const DEFAULT_SR = 48000

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

export function drawGrid(ctx, w, h, scrollOffset, ppb, trackCount, tracks = null) {
  ctx.clearRect(0, 0, w, h)

  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1

  // Pattern-track row tint (neutral — pattern tracks no longer bind to a region)
  if (tracks) {
    ctx.fillStyle = tokenValue('--theme-timeline-pattern-lane-tint')
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      if (t?.type !== 'Pattern') continue
      const y = i * TRACK_HEIGHT
      if (y >= h) break
      ctx.fillRect(0, y, w, TRACK_HEIGHT)
    }
  }

  // Track separator lines (horizontal)
  ctx.strokeStyle = tokenValue('--theme-border-subtle')
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i <= trackCount; i++) {
    const y = Math.round(i * TRACK_HEIGHT) + 0.5
    if (y > h) break
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()

  // Subdivision lines — progressive detail at increasing zoom levels
  // 16th notes (ppb > 80), 32nd (> 400), 64th (> 2000), 128th (> 10000)
  const subLevels = [
    { divPerBeat: 4,   threshold: SUB_GRID_THRESHOLD, alpha: 0.03 },   // 16th
    { divPerBeat: 8,   threshold: 400,                alpha: 0.025 },  // 32nd
    { divPerBeat: 16,  threshold: 2000,               alpha: 0.02 },   // 64th
    { divPerBeat: 32,  threshold: 10000,              alpha: 0.015 },  // 128th
  ]
  for (const { divPerBeat, threshold, alpha } of subLevels) {
    if (ppb <= threshold) continue
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`
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
  ctx.strokeStyle = tokenValue('--theme-timeline-beat-line')
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
  ctx.strokeStyle = tokenValue('--theme-fx-surface-tint-medium')
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
}

// ── Ruler ────────────────────────────────────────────────────────────────────

export function drawRuler(ctx, w, h, scrollOffset, ppb) {
  // Background
  ctx.fillStyle = tokenValue('--theme-bg-secondary')
  ctx.fillRect(0, 0, w, h)

  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1

  // Beat tick marks
  ctx.strokeStyle = tokenValue('--theme-border-subtle')
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

  // Subdivision ticks (progressive detail like grid)
  {
    const rulerSubLevels = [
      { divPerBeat: 4,  threshold: SUB_GRID_THRESHOLD, alpha: 0.06, tickFrac: 0.15 },
      { divPerBeat: 8,  threshold: 400,                alpha: 0.04, tickFrac: 0.10 },
      { divPerBeat: 16, threshold: 2000,               alpha: 0.03, tickFrac: 0.08 },
      { divPerBeat: 32, threshold: 10000,              alpha: 0.02, tickFrac: 0.06 },
    ]
    for (const { divPerBeat, threshold, alpha, tickFrac } of rulerSubLevels) {
      if (ppb <= threshold) continue
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`
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
  ctx.fillStyle = tokenValue('--theme-text-placeholder')
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
  ctx.strokeStyle = tokenValue('--theme-border-subtle')
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h - 0.5)
  ctx.lineTo(w, h - 0.5)
  ctx.stroke()
}

// ── Overlay (playhead + selection) ───────────────────────────────────────────

export function drawOverlay(ctx, w, h, scrollOffset, ppb, playheadBeat) {
  ctx.clearRect(0, 0, w, h)

  if (playheadBeat == null) return

  const x = Math.round(beatToPixel(playheadBeat, scrollOffset, ppb)) + 0.5

  // Don't draw if off-screen
  if (x < -1 || x > w + 1) return

  // Playhead line
  ctx.strokeStyle = tokenValue('--theme-timeline-playhead-line')
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()

  // Small triangle at top
  ctx.fillStyle = tokenValue('--theme-border-focus')
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

// ── Clips (content layer) ───────────────────────────────────────────────────

const CLIP_PAD = 2         // top/bottom padding within track lane
const CLIP_TEXT_PAD = 6    // horizontal text padding inside clip
const HANDLE_W = 4         // resize handle width (selected only)

export function drawClips(ctx, w, h, scrollOffset, ppb, clips, trackIdToIndex, regions, selectedClipIds, waveformCache, hiResCache, clipPeakCache, bpm, mutedTrackIds) {
  ctx.clearRect(0, 0, w, h)
  if (!clips || clips.length === 0) return

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
    const y = trackIdx * TRACK_HEIGHT + CLIP_PAD

    const region = regions[clip.regionId]
    const hex = labelHexColor(region?.label)
    const selected = selectedClipIds.has(clip.id)
    const isMuted = mutedTrackIds?.has(clip.trackId)
    const mutedMul = isMuted ? 0.3 : 1.0

    // ── Fill ──────────────────────────────────────────────────────────────
    ctx.fillStyle = hexToRgba(hex, (selected ? 0.8 : 0.6) * mutedMul)
    ctx.fillRect(x, y, clipW, clipH)

    // ── Border ────────────────────────────────────────────────────────────
    ctx.strokeStyle = hexToRgba(hex, 1.0)
    ctx.lineWidth = selected ? 2 : 1
    ctx.strokeRect(x, y, clipW, clipH)

    // ── Waveform inside clip ─────────────────────────────────────────────
    if (clipW > 20 && bpm && region) {
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
      ctx.rect(x, y, clipW, clipH)
      ctx.clip()

      const envAlpha = selected ? 0.45 : 0.25
      const rmsAlpha = selected ? 0.30 : 0.15
      const lineColor = selected ? tokenValue('--theme-timeline-clip-waveform-fg') : 'rgba(255,255,255,0.45)'
      const traceFill = selected ? tokenValue('--theme-timeline-clip-waveform-bg') : 'rgba(255,255,255,0.10)'

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
            drawSamplePoints(ctx, hiRes.samples, visL, y, visR - visL, clipH,
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
                drawTrace(ctx, hiRes.peaks, visL, y, visR - visL, clipH,
                  startCol, endCol, traceFill, lineColor)
              } else {
                drawWaveformLine(ctx, hiRes.peaks, visL, y, visR - visL, clipH,
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
                drawTrace(ctx, cpData.peaks, x, y, clipW, clipH,
                  startCol, endCol, traceFill, lineColor)
              } else {
                drawEnvelope(ctx, cpData.peaks, x, y, clipW, clipH,
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
                drawTrace(ctx, wfData.peaks, x, y, clipW, clipH,
                  startCol, endCol, traceFill, lineColor)
              } else {
                drawEnvelope(ctx, wfData.peaks, x, y, clipW, clipH,
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

      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'

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

    // ── Resize handles (selected only) ────────────────────────────────────
    if (selected && clipW > HANDLE_W * 3) {
      ctx.fillStyle = hexToRgba(hex, 1.0)
      ctx.fillRect(x, y, HANDLE_W, clipH)                       // left
      ctx.fillRect(x + clipW - HANDLE_W, y, HANDLE_W, clipH)    // right
    }

    // ── Name text ─────────────────────────────────────────────────────────
    if (clipW > CLIP_TEXT_PAD * 2 + 10) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x + CLIP_TEXT_PAD, y, clipW - CLIP_TEXT_PAD * 2, clipH)
      ctx.clip()

      ctx.fillStyle = '#000'
      ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textBaseline = 'middle'

      // Syllable clip → show "<n> <text>" (or just "<n>") instead of region name
      let clipLabel = region?.name || '?'
      if (clip.syllableIndex != null && clip.syllableIndex >= 0) {
        const syl = region?.syllables?.[clip.syllableIndex]
        if (syl) {
          clipLabel = syl.text
            ? `${clip.syllableIndex + 1} ${syl.text}`
            : `${clip.syllableIndex + 1}`
        } else {
          clipLabel = `${clip.syllableIndex + 1}`
        }
      }
      ctx.fillText(clipLabel, x + CLIP_TEXT_PAD, y + clipH / 2)

      // ── Pitch / Reverse / Stretch overlay (bottom-right) ──────────────
      const parts = []
      const semis  = clip.pitchOffset      ?? 0
      const cents  = clip.pitchOffsetCents ?? 0
      const ratio  = clip.stretchRatio     ?? 1.0
      const rev    = clip.reversed         ?? false

      if (semis !== 0 || cents !== 0) {
        let label = semis !== 0 ? `${semis > 0 ? '+' : ''}${semis}st` : ''
        if (cents !== 0) {
          const centStr = `${cents > 0 ? '+' : ''}${cents}c`
          label = label ? `${label} ${centStr}` : centStr
        }
        parts.push(label)
      }
      if (rev) parts.push('REV')
      if (Math.abs(ratio - 1.0) > 0.001) parts.push(`${ratio.toFixed(2)}×`)
      if (Math.abs((clip.velocity ?? 1.0) - 1.0) > 0.001) {
        const db = 20 * Math.log10(clip.velocity)
        parts.push(`${db > 0 ? '+' : ''}${db.toFixed(1)}dB`)
      }

      if (parts.length > 0 && clipW > 30) {
        const overlayText = parts.join(' ')
        ctx.font = '500 9px "Hanken Grotesk", system-ui, sans-serif'
        ctx.textBaseline = 'alphabetic'
        const tw = ctx.measureText(overlayText).width
        const ox = x + clipW - CLIP_TEXT_PAD
        const oy = y + clipH - 3
        ctx.fillStyle = tokenValue('--theme-timeline-fade-curve-fill')
        ctx.fillRect(ox - tw - 3, oy - 9, tw + 5, 11)
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fillText(overlayText, ox - tw, oy)
      }

      ctx.restore()
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
  scrollOffset, ppb, spinAngle, accentColor
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
    const cy = (trackIdx + 1) * TRACK_HEIGHT - CLIP_PAD - SPINNER_PAD - SPINNER_R

    ctx.beginPath()
    ctx.arc(cx, cy, SPINNER_R, spinAngle, spinAngle + ARC_SPAN)
    ctx.stroke()
  }
  ctx.restore()
}

// ── Pattern Blocks (content layer) ──────────────────────────────────────────

export function drawPatternBlocks(ctx, w, h, scrollOffset, ppb, blocks, trackIdToIndex, patterns, regions, selectedBlockIds, mutedTrackIds) {
  if (!blocks || blocks.length === 0) return

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
    const y = trackIdx * TRACK_HEIGHT + CLIP_PAD

    const pattern = patterns?.[block.patternId]
    const region = pattern ? regions?.[pattern.regionId] : null
    const hex = labelHexColor(region?.label)
    const selected = selectedBlockIds?.has(block.id)
    const isMuted = mutedTrackIds?.has(block.trackId)
    const mutedMul = isMuted ? 0.3 : 1.0

    // ── Fill ──────────────────────────────────────────────────────────────
    ctx.fillStyle = hexToRgba(hex, (selected ? 0.75 : 0.55) * mutedMul)
    ctx.fillRect(x, y, blockW, clipH)

    // ── Border ────────────────────────────────────────────────────────────
    ctx.strokeStyle = hexToRgba(hex, 1.0)
    ctx.lineWidth = selected ? 2 : 1
    ctx.strokeRect(x, y, blockW, clipH)

    // ── Dashed top border distinguishes PatternBlocks from Clips ──────────
    ctx.strokeStyle = hexToRgba(hex, 1.0)
    ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(x, y + 1)
    ctx.lineTo(x + blockW, y + 1)
    ctx.stroke()
    ctx.setLineDash([])

    // ── Note markers (if pattern has notes and zoom is sufficient) ────────
    if (pattern && pattern.notes && pattern.notes.length > 0 && pattern.lengthTicks > 0 && blockW > 30) {
      const patLen = pattern.lengthTicks
      const offsetTicks = block.offsetTicks || 0
      const windowStart = offsetTicks
      const windowEnd = offsetTicks + block.durationTicks

      // Pitch-scaled mini piano roll: Y position proportional to pitch within pattern range
      const pitches = pattern.notes.map((n) => n.pitch)
      const minP = Math.min(...pitches)
      const maxP = Math.max(...pitches)
      const range = Math.max(1, maxP - minP)
      const innerH = clipH - 4 // top/bottom margin
      const noteH = 2          // 2px dots

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
      ctx.rect(x, y, blockW, clipH)
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
          const ny = y + 2 + (innerH - noteH) - ((note.pitch - minP) / range) * (innerH - noteH)
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

    // ── Loop indicator ────────────────────────────────────────────────────
    if (pattern && pattern.lengthTicks > 0 && block.durationTicks > pattern.lengthTicks) {
      ctx.fillStyle = 'rgba(0,0,0,0.8)'
      ctx.font = '600 8px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textBaseline = 'top'
      // ↻ when loop active, ∣→ when disabled (extends as empty space)
      const glyph = block.loopEnabled === false ? '∣→' : '↻'
      ctx.fillText(glyph, x + blockW - 14, y + 2)
    }

    // ── Name text ─────────────────────────────────────────────────────────
    if (blockW > CLIP_TEXT_PAD * 2 + 10) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x + CLIP_TEXT_PAD, y, blockW - CLIP_TEXT_PAD * 2, clipH)
      ctx.clip()

      ctx.fillStyle = '#000'
      ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textBaseline = 'top'
      ctx.fillText(pattern?.name || '?', x + CLIP_TEXT_PAD, y + 3)

      ctx.restore()
    }
  }
}

// ── Drop preview (drawn on overlay layer) ───────────────────────────────────

export function drawDropPreview(ctx, w, h, scrollOffset, ppb, preview) {
  if (!preview) return

  const { beat, trackIndex, durationBeats, color, name } = preview
  const x = beatToPixel(beat, scrollOffset, ppb)
  const clipW = durationBeats * ppb
  const y = trackIndex * TRACK_HEIGHT + CLIP_PAD
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
    ctx.fillStyle = tokenValue('--theme-fg-inverse')
    ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(name || '', x + CLIP_TEXT_PAD, y + clipH / 2)
    ctx.restore()
  }
}

// ── Tool overlays (drawn on overlay canvas during mouse interaction) ─────────

const GHOST_CLIP_PAD = 2

export function drawGhostPreview(ctx, w, h, scrollOffset, ppb, ghost) {
  if (!ghost) return
  const { beat, trackIndex, durationBeats, color, name } = ghost
  const x = beatToPixel(beat, scrollOffset, ppb)
  const clipW = durationBeats * ppb
  const y = trackIndex * TRACK_HEIGHT + GHOST_CLIP_PAD
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
    ctx.fillStyle = tokenValue('--theme-fg-inverse')
    ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, x + CLIP_TEXT_PAD, y + clipH / 2)
    ctx.restore()
  }
}

export function drawRubberBand(ctx, x1, y1, x2, y2) {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  if (w < 1 && h < 1) return

  ctx.fillStyle = 'rgba(51,206,214,0.08)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(51,206,214,0.4)'
  ctx.lineWidth = 1
  ctx.strokeRect(x, y, w, h)
}

export function drawSplitLine(ctx, w, h, scrollOffset, ppb, beat) {
  if (beat == null) return
  const x = Math.round(beatToPixel(beat, scrollOffset, ppb)) + 0.5
  if (x < -1 || x > w + 1) return

  ctx.strokeStyle = tokenValue('--theme-timeline-loop-brace')
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()
  ctx.setLineDash([])
}

export function drawMovePreview(ctx, w, h, scrollOffset, ppb, preview) {
  if (!preview) return
  const { beat, trackIndex, durationBeats, color } = preview
  const x = beatToPixel(beat, scrollOffset, ppb)
  const clipW = durationBeats * ppb
  const y = trackIndex * TRACK_HEIGHT + GHOST_CLIP_PAD
  const clipH = TRACK_HEIGHT - GHOST_CLIP_PAD * 2

  ctx.fillStyle = hexToRgba(color, 0.3)
  ctx.fillRect(x, y, clipW, clipH)
  ctx.strokeStyle = hexToRgba(color, 0.7)
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 3])
  ctx.strokeRect(x, y, clipW, clipH)
  ctx.setLineDash([])
}

export function drawDeleteSweep(ctx, x1, y1, x2, y2) {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  if (w < 1 && h < 1) return

  ctx.fillStyle = 'rgba(255,107,107,0.10)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(255,107,107,0.4)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x, y, w, h)
  ctx.setLineDash([])
}

// ── Ruler overlay (playhead indicator on ruler) ──────────────────────────────

export function drawRulerOverlay(ctx, w, h, scrollOffset, ppb, playheadBeat) {
  ctx.clearRect(0, 0, w, h)

  if (playheadBeat == null) return

  const x = Math.round(beatToPixel(playheadBeat, scrollOffset, ppb)) + 0.5
  if (x < -1 || x > w + 1) return

  // Playhead line on ruler
  ctx.strokeStyle = tokenValue('--theme-timeline-playhead-line')
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, h)
  ctx.stroke()

  // Downward triangle
  ctx.fillStyle = tokenValue('--theme-border-focus')
  ctx.beginPath()
  ctx.moveTo(x, h)
  ctx.lineTo(x - 4, h - 6)
  ctx.lineTo(x + 4, h - 6)
  ctx.closePath()
  ctx.fill()
}

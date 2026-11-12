// Note painting for the Piano Roll grid (round 2, step 12.3). Pure functions
// over a 2D context: no React, no tokens (the caller passes the palette).
//
//   Colour   = the owning track's identity colour (the same colour as its
//              arrangement lane, mixer strip and viewer layer). Every note in a
//              pattern plays every sounding sampler slot at once, so there is no
//              per-note slot to colour by; the track is the honest identity.
//   Velocity = fill opacity (never a new colour).
//   Selection= 1px --ui-select outline plus a brighter fill.
//   Label    = Pitch view: the note name. Sample view: the transposition the
//              sampler applies to the reference slot's sample, in semitones
//              ("Root", "+7", "−12"), which is what pitch-sample work reads.
//   Slide    = a ramp glyph at the right end; the note keeps its colour.
//   Ghosts   = notes of OTHER patterns placed over this pattern's first block:
//              solid grey when they play the same sample region, outlined when
//              they play another sample.

import { ticksToBeats } from '../../constants/timeline.js'
import { pickLabelInk } from '../../ui-kit/colorMath.ts'
import { PITCH_MAX, pitchLabel } from './pianoRollGeometry.js'
import { drawIcon } from '../../ui-kit/icons/canvas.ts'

const MINUS = '−'
const HEX6 = /^#[0-9a-f]{6}$/i

/** Semitones the sampler shifts `slot`'s sample by to sound `pitch` (Sampler.h: (midi - root) + tuning). */
export function sampleShiftSemitones(pitch, slot) {
  const root = Number.isFinite(slot?.rootNote) ? slot.rootNote : 60
  const tuning = (slot?.octave || 0) * 12 + (slot?.semitone || 0) + (slot?.coarse || 0) + (slot?.fine || 0) / 100
  return (pitch - root) + tuning
}

export function formatShift(semitones) {
  const r = Math.round(semitones * 100) / 100
  if (r === 0) return 'Root'
  const abs = Math.abs(r)
  const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
  return `${r > 0 ? '+' : MINUS}${text}`
}

export function noteLabel(note, labelMode, refSlot) {
  if (labelMode === 'sample') return formatShift(sampleShiftSemitones(note.pitch, refSlot))
  return pitchLabel(note.pitch)
}

/** 0..1 velocity -> fill alpha. Quiet notes stay visible; full velocity is opaque. */
export function velocityAlpha(velocity) {
  const v = Math.max(0, Math.min(1, velocity ?? 1))
  return 0.3 + 0.7 * v
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `fg` at `alpha` over `bg`, both #RRGGBB. */
export function mixHex(fg, bg, alpha) {
  if (!HEX6.test(fg) || !HEX6.test(bg)) return HEX6.test(fg) ? fg : '#808080'
  const a = hexToRgb(fg)
  const b = hexToRgb(bg)
  const c = a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function rgba(hex, alpha) {
  if (!HEX6.test(hex)) return hex
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

/**
 * Build the note style for a redraw: identity colour, label inks per velocity
 * bucket (the label is solved against the composited fill, not the raw hue).
 */
export function noteStyle({ color, palette, labelMode = 'pitch', refSlot = null }) {
  const base = HEX6.test(color) ? color : (HEX6.test(palette.value) ? palette.value : '#33CED6')
  const ground = HEX6.test(palette.g0) ? palette.g0 : '#141414'
  const light = HEX6.test(palette.ink) ? palette.ink : '#E6E6E6'
  const dark = HEX6.test(palette.g1) ? palette.g1 : '#1B1B1B'
  const inkCache = new Map()
  return {
    color: base,
    labelMode,
    refSlot,
    select: palette.select,
    font: palette.font,
    ghostFill: palette.g4,
    ghostStroke: palette.boundary,
    inkFor(alpha) {
      const key = Math.round(alpha * 20)
      let ink = inkCache.get(key)
      if (!ink) {
        const fill = mixHex(base, ground, key / 20)
        const best = pickLabelInk(fill, light, dark)
        // Near mid lightness neither ramp ink reaches 4.5:1; the absolute ends
        // always do (worst case about 4.58:1), so they are the last resort.
        ink = best.ratio >= 4.5 ? best.ink : pickLabelInk(fill, '#FFFFFF', '#000000').ink
        inkCache.set(key, ink)
      }
      return ink
    },
  }
}

function drawSlideGlyph(ctx, x, y, h, ink) {
  // XLETH's slide glyph (a rising ramp with a cap), from the shared icon table.
  const s = Math.max(6, Math.min(10, h - 2))
  drawIcon(ctx, 'xleth-slide', x, y + (h - s) / 2, s, ink)
}

/**
 * Draw notes. `hiddenIds` are lifted off this layer while being dragged (the
 * overlay draws them at their preview position through this same function).
 */
export function drawNotes(ctx, w, h, notes, selectedNoteIds, ppb, pps, scrollX, scrollY, style, hiddenIds) {
  const bodyH = Math.max(1, pps - 2)
  const labelPx = bodyH >= 13 ? 11 : 10
  const showLabels = bodyH >= 10
  if (showLabels) {
    ctx.font = `500 ${labelPx}px ${style.font}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
  }
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    if (hiddenIds?.has(note.id)) continue
    const x = ticksToBeats(note.positionTicks) * ppb - scrollX
    const wid = Math.max(2, ticksToBeats(note.durationTicks) * ppb)
    const y = (PITCH_MAX - note.pitch) * pps - scrollY
    if (x + wid < 0 || x > w || y + pps < 0 || y > h) continue

    const selected = selectedNoteIds?.has(note.id)
    const alpha = Math.min(1, velocityAlpha(note.velocity) + (selected ? 0.25 : 0))
    ctx.fillStyle = rgba(style.color, alpha)
    ctx.fillRect(x, y + 1, wid, bodyH)
    ctx.lineWidth = 1
    ctx.strokeStyle = selected ? style.select : style.color
    ctx.strokeRect(x + 0.5, y + 1.5, wid - 1, bodyH - 1)

    if (!showLabels) continue
    const ink = style.inkFor(alpha)
    const glyphW = note.isSlide && wid >= 14 ? 10 : 0
    if (glyphW) drawSlideGlyph(ctx, x + wid - glyphW, y + 1, bodyH, ink)
    const text = noteLabel(note, style.labelMode, style.refSlot)
    const room = wid - 6 - glyphW
    if (room <= 0) continue
    const tw = ctx.measureText?.(text)?.width ?? 0
    if (tw > room) continue
    ctx.fillStyle = ink
    ctx.fillText(text, x + 3, y + pps / 2 + 0.5)
  }
}

/** Ghost blocks: solid grey (same sample region) or outlined (another sample). Never hit-tested. */
export function drawGhosts(ctx, w, h, ghosts, ppb, pps, scrollX, scrollY, style) {
  if (!ghosts?.length) return
  const bodyH = Math.max(1, pps - 2)
  ctx.lineWidth = 1
  for (const g of ghosts) {
    const x = ticksToBeats(g.positionTicks) * ppb - scrollX
    const wid = Math.max(2, ticksToBeats(g.durationTicks) * ppb)
    const y = (PITCH_MAX - g.pitch) * pps - scrollY
    if (x + wid < 0 || x > w || y + pps < 0 || y > h) continue
    if (g.kind === 'same') {
      ctx.fillStyle = style.ghostFill
      ctx.fillRect(x, y + 1, wid, bodyH)
    } else {
      ctx.strokeStyle = style.ghostStroke
      ctx.strokeRect(x + 0.5, y + 1.5, wid - 1, bodyH - 1)
    }
  }
}

/**
 * Notes of other patterns that sound while this pattern's FIRST block plays,
 * mapped into this pattern's tick space. Blocks loop when loopEnabled and
 * longer than their pattern; a block's offset trims its left edge.
 *   blocks: getPatternBlocks() rows; patternsById: { [id]: getPattern() }.
 */
export function buildGhostNotes({ patternId, pattern, blocks, patternsById, maxNotes = 4000 }) {
  const out = []
  if (patternId == null || !Array.isArray(blocks) || !pattern) return out
  const anchor = blocks
    .filter((b) => b.patternId === patternId)
    .sort((a, b) => a.positionTicks - b.positionTicks)[0]
  if (!anchor) return out
  const winStart = anchor.positionTicks
  const winEnd = anchor.positionTicks + anchor.durationTicks
  const toLocal = (T) => T - anchor.positionTicks + (anchor.offsetTicks || 0)
  const region = pattern.regionId
  for (const b of blocks) {
    if (b.patternId === patternId) continue
    const bStart = b.positionTicks
    const bEnd = b.positionTicks + b.durationTicks
    if (bEnd <= winStart || bStart >= winEnd) continue
    const other = patternsById?.[b.patternId]
    if (!other?.notes?.length) continue
    const kind = region != null && region >= 0 && other.regionId === region ? 'same' : 'other'
    const len = other.lengthTicks > 0 ? other.lengthTicks : 0
    const offset = b.offsetTicks || 0
    // Timeline T of pattern tick u in loop k: bStart + (u + k*len) - offset.
    const loops = b.loopEnabled && len > 0 ? Math.ceil((b.durationTicks + offset) / len) : 1
    for (let k = 0; k < loops; k++) {
      for (const n of other.notes) {
        const u = n.positionTicks + k * len
        if (u < offset || u >= offset + b.durationTicks) continue
        const T = bStart + (u - offset)
        if (T >= winEnd || T + n.durationTicks <= winStart) continue
        const end = Math.min(T + n.durationTicks, bEnd)
        out.push({ positionTicks: toLocal(T), durationTicks: Math.max(1, end - T), pitch: n.pitch, kind, patternId: b.patternId })
        if (out.length >= maxNotes) return out
      }
    }
  }
  return out
}

// ── Pattern hover-preview rasterizer ─────────────────────────────────────────
// Pure canvas drawing + cache for the pattern-list hover tooltip. No React,
// no engine/bridge calls — everything here operates on the Pattern object
// shape already resident in TimelineView's `patterns` state
// ({ id, name, regionId, lengthTicks, notes: [{ id, positionTicks,
// durationTicks, pitch, velocity }] }).
//
// FIXED VIEWPORT: the canvas is always PREVIEW_WIDTH x PREVIEW_HEIGHT CSS px
// regardless of pattern length — x = positionTicks / durationTicks * width.
// Duration is communicated by the bar grid + header/footer text, never by
// canvas size.
import { BEATS_PER_BAR, ticksToBeats, beatsToTicks } from '../../../constants/timeline.js'

export const PREVIEW_WIDTH = 240
export const PREVIEW_HEIGHT = 88
export const PREVIEW_DPR = 2

const oneBarInTicks = () => beatsToTicks(BEATS_PER_BAR)
const ticksToBars = (ticks) => ticksToBeats(ticks) / BEATS_PER_BAR

const MIN_BAR_PX_FOR_GRID = 18
const MIN_NOTE_WIDTH_PX = 1.5
const MAX_NOTE_WIDTH_PX = 14
const MIN_NOTE_HEIGHT_PX = 3
const MAX_NOTE_HEIGHT_PX = 7

// ── Pattern "kind" inference ──────────────────────────────────────────────
// The Pattern/PatternNote model has no melodic/percussion discriminator, so
// this follows the definition implied by the spec itself: a pattern with no
// pitch variation (or no notes) reads as percussion/onset content; anything
// with more than one distinct pitch gets the mini piano-roll treatment.
export function inferPatternKind(pattern) {
  const notes = pattern?.notes || []
  const pitches = new Set(notes.map((n) => n.pitch))
  return pitches.size <= 1 ? 'PERC' : 'MELO'
}

export function patternBarCount(pattern) {
  const durationTicks = effectiveDurationTicks(pattern)
  return Math.max(1, Math.ceil(ticksToBars(durationTicks)))
}

function effectiveDurationTicks(pattern) {
  const notes = pattern?.notes || []
  if (pattern?.lengthTicks > 0) return pattern.lengthTicks
  let maxEnd = 0
  for (const note of notes) {
    const end = (note.positionTicks || 0) + (note.durationTicks || 0)
    if (end > maxEnd) maxEnd = end
  }
  return maxEnd || oneBarInTicks()
}

// ── Revision fingerprint ───────────────────────────────────────────────────
// There's no engine-provided revision counter for a pattern's note content,
// so this fingerprint stands in for one: it changes iff the note data
// actually changed, which lets the cache below invalidate exactly the edited
// pattern's entry (and only that one) without any extra plumbing.
function computeRevisionKey(pattern) {
  const notes = pattern?.notes || []
  let fingerprint = `${pattern?.lengthTicks || 0}|${notes.length}`
  for (const note of notes) {
    fingerprint += `|${note.id},${note.positionTicks},${note.durationTicks},${note.pitch},${note.velocity}`
  }
  return fingerprint
}

// ── Offscreen bitmap cache ─────────────────────────────────────────────────
const CACHE_LIMIT = 64
const previewCache = new Map() // `${patternId}::${revisionKey}` -> HTMLCanvasElement

function readCache(patternId, revisionKey) {
  return previewCache.get(`${patternId}::${revisionKey}`) || null
}

function writeCache(patternId, revisionKey, canvas) {
  for (const key of previewCache.keys()) {
    if (key.startsWith(`${patternId}::`)) previewCache.delete(key)
  }
  previewCache.set(`${patternId}::${revisionKey}`, canvas)
  if (previewCache.size > CACHE_LIMIT) {
    const oldestKey = previewCache.keys().next().value
    previewCache.delete(oldestKey)
  }
}

/**
 * Returns a cached (or freshly rasterized) offscreen canvas for this
 * pattern's preview, or null when the pattern has no notes — callers should
 * render an "empty pattern" DOM state instead of blitting in that case.
 *
 * @param {object} pattern
 * @param {{wellBg:string, gridColor:string, gridStrongColor:string, noteColor:string}} tokens
 *   Resolved CSS custom-property values — read by the caller (a React
 *   component) via useTokenValue(), never here at module scope.
 */
export function getOrRenderPatternPreview(pattern, tokens) {
  if (!pattern || !pattern.notes || pattern.notes.length === 0) return null
  const revisionKey = computeRevisionKey(pattern)
  const cached = readCache(pattern.id, revisionKey)
  if (cached) return cached
  const canvas = rasterizePattern(pattern, tokens)
  writeCache(pattern.id, revisionKey, canvas)
  return canvas
}

function rasterizePattern(pattern, tokens) {
  const canvas = document.createElement('canvas')
  canvas.width = PREVIEW_WIDTH * PREVIEW_DPR
  canvas.height = PREVIEW_HEIGHT * PREVIEW_DPR
  const ctx = canvas.getContext('2d')
  ctx.scale(PREVIEW_DPR, PREVIEW_DPR)

  ctx.fillStyle = tokens.wellBg
  ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT)

  const durationTicks = effectiveDurationTicks(pattern)
  drawBarGrid(ctx, durationTicks, tokens)

  const kind = inferPatternKind(pattern)
  if (kind === 'PERC') drawOnsetTicks(ctx, pattern.notes, durationTicks, tokens)
  else drawMiniPianoRoll(ctx, pattern.notes, durationTicks, tokens)

  return canvas
}

// ── Density-adaptive bar grid ──────────────────────────────────────────────
// Dense patterns degrade from "every bar" -> "every 2nd bar" -> "start marker
// only" so the grid never turns into grey mush on a long/busy pattern.
function drawBarGrid(ctx, durationTicks, tokens) {
  const totalBars = Math.max(1, ticksToBars(durationTicks))
  const barWidthPx = PREVIEW_WIDTH / totalBars

  ctx.lineWidth = 1
  ctx.strokeStyle = tokens.gridColor

  if (barWidthPx >= MIN_BAR_PX_FOR_GRID) {
    for (let bar = 1; bar < totalBars; bar++) drawGridLine(ctx, bar * barWidthPx)
  } else if (barWidthPx * 2 >= MIN_BAR_PX_FOR_GRID) {
    for (let bar = 2; bar < totalBars; bar += 2) drawGridLine(ctx, bar * barWidthPx)
  }

  ctx.strokeStyle = tokens.gridStrongColor
  drawGridLine(ctx, 0)
}

function drawGridLine(ctx, xRaw) {
  const x = Math.round(xRaw) + 0.5 // crisp 1px line
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, PREVIEW_HEIGHT)
  ctx.stroke()
}

// ── Percussion / sample mode: thin onset lines, height = velocity ─────────
function drawOnsetTicks(ctx, notes, durationTicks, tokens) {
  const lineWidth = 2
  const maxHeight = PREVIEW_HEIGHT - 4
  ctx.fillStyle = tokens.noteColor
  for (const note of notes) {
    const xRaw = (note.positionTicks / durationTicks) * PREVIEW_WIDTH
    const x = Math.min(PREVIEW_WIDTH - lineWidth, Math.max(0, xRaw))
    const velocity = clamp(note.velocity ?? 1, 0, 1)
    const barHeight = Math.max(2, velocity * maxHeight)
    ctx.fillRect(x, PREVIEW_HEIGHT - 2 - barHeight, lineWidth, barHeight)
  }
}

// ── Melodic mode: mini piano roll, normalized to the pattern's own range ──
function drawMiniPianoRoll(ctx, notes, durationTicks, tokens) {
  let pitchMin = Infinity
  let pitchMax = -Infinity
  for (const note of notes) {
    if (note.pitch < pitchMin) pitchMin = note.pitch
    if (note.pitch > pitchMax) pitchMax = note.pitch
  }
  const paddedMin = pitchMin - 1
  const paddedMax = pitchMax + 1
  const pitchSpan = Math.max(1, paddedMax - paddedMin)
  const rowHeight = PREVIEW_HEIGHT / pitchSpan
  const noteHeight = clamp(rowHeight * 0.75, MIN_NOTE_HEIGHT_PX, MAX_NOTE_HEIGHT_PX)

  ctx.fillStyle = tokens.noteColor
  for (const note of notes) {
    const xRaw = (note.positionTicks / durationTicks) * PREVIEW_WIDTH
    const wRaw = ((note.durationTicks || 0) / durationTicks) * PREVIEW_WIDTH
    const w = clamp(wRaw, MIN_NOTE_WIDTH_PX, MAX_NOTE_WIDTH_PX)
    const x = Math.min(PREVIEW_WIDTH - w, Math.max(0, xRaw))
    const yCenter = PREVIEW_HEIGHT - (note.pitch - paddedMin) * rowHeight
    ctx.fillRect(x, yCenter - noteHeight / 2, w, noteHeight)
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

// Motion view key area: canvas painters and geometry (docs/XLETH_MOTION_VIEW_DESIGN.md
// 5.4, 5.7, R5, R24). Pure drawing over a 2D context; no React, no store.
//
// The key canvas is sized to the VISIBLE viewport, not the content: every painter
// takes the visible row slice and draws rows at (row.y - scrollTop). Three layers:
//   static   ground, bar groups, row bands, grid, separators, the reference strip
//            (clips / notes, dimmed, in the track row) and note-on guides through
//            the track's child rows
//   keys     the keys of every visible property row (glyph by interp: Hold square,
//            Linear circle, Ease out diamond, Bezier hexagon; hollow = inherited,
//            filled = own; selected in --ui-select), and the summary of collapsed
//            track / group rows
//   overlay  the playhead (never eased), a gesture's marquee and snap line
// Keys are culled by binary search on each row's precomputed tick array, and a key
// landing on the same pixel as the previous one is skipped: nothing here allocates
// per key per redraw.
//
// Colours come from a cached palette (tokens read at first draw, never at module
// scope) dropped on 'xleth-theme-changed'.

import { tokenValue } from '../../theming/tokenValue.ts'
import {
  BAR_LINE_MIN_PX, BEAT_LINE_MIN_PX, barGroupBars, barStrideFor, getSnapGridIntervalBeats, resolveTimelinePalette,
  withAlpha, MUTE_OPACITY,
} from '../timeline/timelineDrawing.js'
import { ROAM_KEY_HIT_R, ROAM_KEY_R } from '../timeline/roamLaneModel.js'
import { BEATS_PER_BAR, SUB_GRID_THRESHOLD, pixelToTickExact, tickToPixel } from '../../constants/timeline.js'
import { lowerBound } from '../../motion/useMotionData.js'
import { rowIndexAtY, rowKeyTicks, rowKeys, summaryTicks, tickRange, visibleRowRange } from '../../motion/rowRegistry.js'

export const KEY_R = ROAM_KEY_R
export const KEY_HIT_R = ROAM_KEY_HIT_R
const SUMMARY_R = 2.5

// ── Palette ──────────────────────────────────────────────────────────────────

let paletteCache = null

export function invalidateMotionPalette() {
  paletteCache = null
}

if (typeof window !== 'undefined') window.addEventListener('xleth-theme-changed', invalidateMotionPalette)

/** Token colours of the key area (cached; resolved at first use). */
export function resolveMotionPalette() {
  if (paletteCache) return paletteCache
  const t = resolveTimelinePalette()
  paletteCache = {
    ...t,
    ground: t.bg || tokenValue('--ui-g0'),
    trackBand: tokenValue('--ui-g2'),
    groupBand: tokenValue('--ui-g1'),
    keyFill: tokenValue('--ui-ink-2'),
    keyStroke: tokenValue('--ui-g1'),
    hollowFill: tokenValue('--ui-g0'),
    summary: tokenValue('--ui-ink-3'),
    value: tokenValue('--ui-value'),
    guide: tokenValue('--ui-ink'),
    ink3: tokenValue('--ui-ink-3'),
    bands: [1, 2, 3, 4].map((i) => tokenValue(`--ui-band-${i}`)),
  }
  return paletteCache
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Timeline tick -> x in the key area (CSS px). */
export const tickToX = (tick, scrollOffsetBeats, ppb) => tickToPixel(tick, scrollOffsetBeats, ppb)
/** x in the key area -> timeline tick (unrounded). */
export const xToTick = (x, scrollOffsetBeats, ppb) => pixelToTickExact(x, scrollOffsetBeats, ppb)

/**
 * The key under the pointer on the row at content-y `y`: the nearest key within
 * KEY_HIT_R px (or, on a collapsed track / group row, the nearest summary tick).
 *   view = { layout, data, scrollOffset (beats), ppb, keyTick?(instance) -> tick }
 * Returns { row, key?, summaryTick?, index? } (key / summaryTick absent on empty space)
 * or null off the rows.
 */
export function hitTestKey(view, x, y) {
  const { layout, data, scrollOffset, ppb } = view
  if (!layout || !(y >= 0) || y >= layout.totalHeight) return null
  const row = layout.rows[rowIndexAtY(layout, y)]
  if (!row) return null
  const t0 = xToTick(x - KEY_HIT_R, scrollOffset, ppb)
  const t1 = xToTick(x + KEY_HIT_R, scrollOffset, ppb)
  if (row.kind === 'prop') {
    const ticks = rowKeyTicks(row, data)
    const keys = rowKeys(row, data)
    const [i0, i1] = tickRange(ticks, t0, t1)
    let best = -1
    let bestD = Infinity
    for (let i = i0; i < i1; i++) {
      const d = Math.abs(tickToX(view.keyTick ? view.keyTick(keys[i]) : ticks[i], scrollOffset, ppb) - x)
      // Filled keys win a tie over hollow ones drawn on the same tick.
      if (d < bestD || (d === bestD && best >= 0 && keys[best].hollow && !keys[i].hollow)) { best = i; bestD = d }
    }
    return best >= 0 && bestD <= KEY_HIT_R ? { row, key: keys[best], index: best } : { row }
  }
  if (!row.expanded) {
    const ticks = summaryTicks(row, data)
    const [i0, i1] = tickRange(ticks, t0, t1)
    let best = null
    for (let i = i0; i < i1; i++) {
      if (best === null || Math.abs(ticks[i] - xToTick(x, scrollOffset, ppb)) < Math.abs(best - xToTick(x, scrollOffset, ppb))) best = ticks[i]
    }
    return best !== null ? { row, summaryTick: best } : { row }
  }
  return { row }
}

// ── Glyphs ───────────────────────────────────────────────────────────────────

/** The key glyph path by interp (the roamLaneDrawing shapes: Hold square, Linear circle, Ease out diamond, Bezier hexagon). */
export function keyGlyph(ctx, interp, x, y, r) {
  ctx.beginPath()
  if (interp === 'Hold') {
    ctx.rect(x - r + 0.5, y - r + 0.5, 2 * r - 1, 2 * r - 1)
  } else if (interp === 'EaseOut') {
    const d = r * 1.25
    ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath()
  } else if (interp === 'Bezier') {
    const d = r * 1.15
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i
      const px = x + d * Math.cos(a)
      const py = y + d * Math.sin(a)
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.closePath()
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2)
  }
}

function diamond(ctx, x, y, r) {
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath()
}

// ── Static layer ─────────────────────────────────────────────────────────────

function drawGridLines(ctx, w, h, scrollOffset, ppb, p, snapGranularity) {
  const startBeat = Math.floor(scrollOffset)
  const endBeat = Math.ceil(scrollOffset + w / ppb) + 1
  const xOfBeat = (b) => Math.round((b - scrollOffset) * ppb) + 0.5
  if (ppb > SUB_GRID_THRESHOLD) {
    ctx.strokeStyle = withAlpha(p.gridMinor, 1.55)
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let beat = startBeat; beat <= endBeat; beat++) {
      for (let sub = 1; sub < 4; sub++) {
        const x = xOfBeat(beat + sub / 4)
        if (x < 0 || x > w) continue
        ctx.moveTo(x, 0); ctx.lineTo(x, h)
      }
    }
    ctx.stroke()
  }
  if (ppb >= BEAT_LINE_MIN_PX) {
    ctx.strokeStyle = p.gridBeat
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let beat = startBeat; beat <= endBeat; beat++) {
      if (beat % BEATS_PER_BAR === 0) continue
      const x = xOfBeat(beat)
      if (x < 0) continue
      if (x > w) break
      ctx.moveTo(x, 0); ctx.lineTo(x, h)
    }
    ctx.stroke()
  }
  const snap = getSnapGridIntervalBeats(snapGranularity)
  if (snap * ppb >= 6) {
    ctx.strokeStyle = withAlpha(p.ink || p.gridBeat, 0.1)
    ctx.lineWidth = snap >= 1 ? 1 : 0.75
    ctx.beginPath()
    for (let beat = Math.floor(startBeat / snap) * snap; beat <= endBeat; beat += snap) {
      const x = xOfBeat(beat)
      if (x < 0) continue
      if (x > w) break
      ctx.moveTo(x, 0); ctx.lineTo(x, h)
    }
    ctx.stroke()
  }
  ctx.strokeStyle = p.gridBar
  ctx.lineWidth = 1
  ctx.beginPath()
  const step = barStrideFor(ppb, BAR_LINE_MIN_PX) * BEATS_PER_BAR
  for (let beat = Math.floor(startBeat / step) * step; beat <= endBeat; beat += step) {
    const x = xOfBeat(beat)
    if (x < 0) continue
    if (x > w) break
    ctx.moveTo(x, 0); ctx.lineTo(x, h)
  }
  ctx.stroke()
}

/** The reference strip of one track row: its clips (Clip track) or its notes (Pattern track), dimmed. */
function drawReferenceStrip(ctx, row, top, view, p, color) {
  const { data, scrollOffset, ppb, w } = view
  const tLo = xToTick(-2, scrollOffset, ppb)
  const tHi = xToTick(w + 2, scrollOffset, ppb)
  const pad = 4
  const h = row.height
  if (row.track.type === 'Pattern') {
    const s = data.noteStrip(row.trackId)
    if (s.count === 0) return
    const first = Math.max(0, lowerBound(s.starts, tLo - s.maxLen, s.count))
    const span = Math.max(1, s.maxPitch - s.minPitch)
    const usable = Math.max(2, h - pad * 2 - 3)
    ctx.fillStyle = withAlpha(color, 0.55)
    let lastX = -Infinity
    let lastY = -Infinity
    for (let i = first; i < s.count; i++) {
      const st = s.starts[i]
      if (st > tHi) break
      if (s.ends[i] < tLo) continue
      const x0 = tickToX(st, scrollOffset, ppb)
      const x1 = tickToX(s.ends[i], scrollOffset, ppb)
      const y = top + pad + (1 - (s.pitches[i] - s.minPitch) / span) * usable
      if (Math.abs(x0 - lastX) < 0.5 && Math.abs(y - lastY) < 0.5) continue
      lastX = x0
      lastY = y
      ctx.fillRect(x0, y, Math.max(2, x1 - x0 - 1), 2.5)
    }
    return
  }
  const clips = data.clipsByTrack.get(row.trackId)
  if (!clips || clips.length === 0) return
  for (const c of clips) {
    const st = c.positionTicks
    const en = st + c.durationTicks
    if (en < tLo) continue
    if (st > tHi) break
    const x0 = tickToX(st, scrollOffset, ppb)
    const x1 = tickToX(en, scrollOffset, ppb)
    ctx.fillStyle = withAlpha(color, 0.28)
    ctx.fillRect(x0, top + pad, Math.max(1, x1 - x0 - 1), h - pad * 2)
    ctx.fillStyle = withAlpha(color, 0.6)
    ctx.fillRect(x0, top + pad, Math.max(1, x1 - x0 - 1), 2)
  }
}

/** Faint guides at the track's note-ons (or clip starts) through its child rows. */
function drawGuides(ctx, trackId, track, y0, y1, view, p) {
  if (y1 <= y0) return
  const { data, scrollOffset, ppb, w } = view
  const tLo = xToTick(-1, scrollOffset, ppb)
  const tHi = xToTick(w + 1, scrollOffset, ppb)
  ctx.fillStyle = withAlpha(p.guide, 0.07)
  let lastX = -Infinity
  if (track.type === 'Pattern') {
    const s = data.noteStrip(trackId)
    for (let i = lowerBound(s.starts, tLo, s.count); i < s.count; i++) {
      if (s.starts[i] > tHi) break
      const x = Math.round(tickToX(s.starts[i], scrollOffset, ppb))
      if (x === lastX) continue
      lastX = x
      ctx.fillRect(x, y0, 1, y1 - y0)
    }
    return
  }
  for (const c of data.clipsByTrack.get(trackId) ?? []) {
    if (c.positionTicks < tLo) continue
    if (c.positionTicks > tHi) break
    const x = Math.round(tickToX(c.positionTicks, scrollOffset, ppb))
    if (x === lastX) continue
    lastX = x
    ctx.fillRect(x, y0, 1, y1 - y0)
  }
}

/**
 * The static layer for the visible rows.
 *   view = { layout, data, w, h, scrollTop, scrollOffset (beats), ppb, snapGranularity,
 *            selectedRows: Set<rowKey>, colorOf(trackId) -> hex, mutedOf(trackId) -> bool }
 */
export function drawStaticLayer(ctx, view) {
  const p = resolveMotionPalette()
  const { layout, w, h, scrollTop, scrollOffset, ppb } = view
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = p.ground
  ctx.fillRect(0, 0, w, h)
  if (!(ppb > 0)) return

  // Bar groups: every other group of bars a tone above the ground.
  const shade = p.barGroupShade
  if (shade && shade.trim() !== '' && shade.trim() !== 'transparent') {
    const groupBeats = barGroupBars(ppb) * BEATS_PER_BAR
    ctx.fillStyle = shade
    for (let g = Math.floor(scrollOffset / groupBeats); ; g++) {
      const x0 = Math.round((g * groupBeats - scrollOffset) * ppb)
      if (x0 >= w) break
      if (((g % 2) + 2) % 2 === 1) {
        const x1 = Math.round(((g + 1) * groupBeats - scrollOffset) * ppb)
        const left = Math.max(0, x0)
        const right = Math.min(w, x1)
        if (right > left) ctx.fillRect(left, 0, right - left, h)
      }
    }
  }

  // Graph mode (R21): the graph replaces the rows; only the time grid stays under it.
  if (view.graph) {
    drawGridLines(ctx, w, h, scrollOffset, ppb, p, view.snapGranularity)
    return
  }

  const [r0, r1] = visibleRowRange(layout, scrollTop, h)
  // Row bands.
  for (let i = r0; i < r1; i++) {
    const row = layout.rows[i]
    const top = row.y - scrollTop
    if (view.selectedRows?.has(row.key)) {
      ctx.fillStyle = withAlpha(p.select, 0.14)
      ctx.fillRect(0, top, w, row.height)
    } else if (row.kind === 'track') {
      ctx.fillStyle = withAlpha(p.trackBand, 0.55)
      ctx.fillRect(0, top, w, row.height)
    } else if (row.kind === 'group') {
      ctx.fillStyle = withAlpha(p.groupBand, 0.45)
      ctx.fillRect(0, top, w, row.height)
    }
  }

  drawGridLines(ctx, w, h, scrollOffset, ppb, p, view.snapGranularity)

  // Separators.
  ctx.strokeStyle = p.laneSeparator
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = r0; i < r1; i++) {
    const row = layout.rows[i]
    const y = Math.round(row.y + row.height - scrollTop) - 0.5
    if (row.kind === 'track' || (i + 1 < layout.rows.length && layout.rows[i + 1].kind === 'track')) {
      ctx.moveTo(0, y); ctx.lineTo(w, y)
    }
  }
  ctx.stroke()
  ctx.strokeStyle = withAlpha(p.laneSeparator, 0.35)
  ctx.beginPath()
  for (let i = r0; i < r1; i++) {
    const row = layout.rows[i]
    if (row.kind === 'track') continue
    const y = Math.round(row.y + row.height - scrollTop) - 0.5
    ctx.moveTo(0, y); ctx.lineTo(w, y)
  }
  ctx.stroke()

  // Reference strip in each track row, guides through its child rows.
  for (let i = r0; i < r1; i++) {
    const row = layout.rows[i]
    if (row.kind !== 'track') continue
    const top = row.y - scrollTop
    const muted = view.mutedOf?.(row.trackId)
    if (muted) ctx.globalAlpha = MUTE_OPACITY
    drawReferenceStrip(ctx, row, top, view, p, view.colorOf?.(row.trackId) ?? p.keyFill)
    ctx.globalAlpha = 1
  }
  // Guides: from each visible track's first child row to the next track row.
  let i = r0
  // A slice may start inside a track's children: find its track row above.
  while (i < r1) {
    const row = layout.rows[i]
    let j = i
    if (row.kind === 'track') j = i + 1
    let end = j
    while (end < layout.rows.length && layout.rows[end].kind !== 'track' && layout.rows[end].y - scrollTop < h) end++
    if (end > j) {
      const y0 = layout.rows[j].y - scrollTop
      const last = layout.rows[end - 1]
      drawGuides(ctx, row.trackId, row.track, Math.max(0, y0), Math.min(h, last.y + last.height - scrollTop), view, p)
    }
    i = Math.max(end, i + 1)
  }
}

// ── Keys layer ───────────────────────────────────────────────────────────────

/**
 * Keys of every visible property row and the summaries of collapsed rows.
 *   view = drawStaticLayer's view + { keySel: Map<keyId, ref>, keyTick?(instance) -> tick (a drag draft) }
 */
export function drawKeysLayer(ctx, view) {
  const p = resolveMotionPalette()
  const { layout, data, w, h, scrollTop, scrollOffset, ppb } = view
  ctx.clearRect(0, 0, w, h)
  if (!(ppb > 0) || !layout) return
  const [r0, r1] = visibleRowRange(layout, scrollTop, h)
  const tLo = xToTick(-KEY_R * 2, scrollOffset, ppb)
  const tHi = xToTick(w + KEY_R * 2, scrollOffset, ppb)
  const sel = view.keySel
  const keyTick = view.keyTick
  for (let r = r0; r < r1; r++) {
    const row = layout.rows[r]
    const top = row.y - scrollTop
    const mid = Math.round(top + row.height / 2) + 0.5
    const muted = view.mutedOf?.(row.trackId)
    if (row.kind === 'prop') {
      const ticks = rowKeyTicks(row, data)
      if (ticks.length === 0) continue
      const keys = rowKeys(row, data)
      // A drag draft may move keys outside the culled range: draw every key then.
      const [i0, i1] = keyTick ? [0, keys.length] : tickRange(ticks, tLo, tHi)
      let lastX = -Infinity
      let lastHollow = null
      ctx.globalAlpha = muted ? MUTE_OPACITY : 1
      for (let i = i0; i < i1; i++) {
        const k = keys[i]
        const x = Math.round(tickToX(keyTick ? keyTick(k) : ticks[i], scrollOffset, ppb)) + 0.5
        if (x < -KEY_R * 2 || x > w + KEY_R * 2) continue
        const selected = sel?.has(k.id)
        if (!selected && Math.abs(x - lastX) < 1 && lastHollow === k.hollow) continue
        lastX = x
        lastHollow = k.hollow
        const r = selected ? KEY_R + 1 : KEY_R
        ctx.globalAlpha = (muted ? MUTE_OPACITY : 1) * (k.outside ? 0.45 : 1)
        keyGlyph(ctx, k.interp, x, mid, r)
        if (k.hollow) {
          ctx.fillStyle = p.hollowFill
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = selected ? p.select : p.keyFill
          ctx.stroke()
        } else {
          ctx.fillStyle = selected ? p.select : p.keyFill
          ctx.fill()
          ctx.lineWidth = 1
          ctx.strokeStyle = p.keyStroke
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      continue
    }
    if (row.expanded) continue
    const ticks = summaryTicks(row, data)
    if (ticks.length === 0) continue
    const [i0, i1] = tickRange(ticks, tLo, tHi)
    ctx.fillStyle = p.summary
    ctx.globalAlpha = muted ? MUTE_OPACITY : 1
    ctx.beginPath()
    let lastX = -Infinity
    for (let i = i0; i < i1; i++) {
      const x = Math.round(tickToX(ticks[i], scrollOffset, ppb))
      if (x - lastX < 3) continue
      lastX = x
      if (row.kind === 'track') diamond(ctx, x + 0.5, top + row.height - 5, SUMMARY_R)
      else ctx.rect(x - 1, mid - 2, 3, 3)
    }
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

// ── Overlay layer ────────────────────────────────────────────────────────────

/**
 * Playhead, marquee and snap line.
 *   view = { w, h, scrollTop, scrollOffset, ppb, playheadBeat, marquee?: {x0,y0,x1,y1} (content coords),
 *            snapTick?: number }
 */
export function drawOverlayLayer(ctx, view) {
  const p = resolveMotionPalette()
  const { w, h, scrollTop, scrollOffset, ppb } = view
  ctx.clearRect(0, 0, w, h)
  if (!(ppb > 0)) return
  if (Number.isFinite(view.snapTick)) {
    const x = Math.round(tickToX(view.snapTick, scrollOffset, ppb)) + 0.5
    ctx.strokeStyle = withAlpha(p.select, 0.8)
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
  }
  const m = view.marquee
  if (m) {
    const x0 = Math.min(m.x0, m.x1)
    const x1 = Math.max(m.x0, m.x1)
    const y0 = Math.min(m.y0, m.y1) - scrollTop
    const y1 = Math.max(m.y0, m.y1) - scrollTop
    ctx.fillStyle = withAlpha(p.select, 0.12)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.strokeStyle = p.select
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0))
  }
  if (Number.isFinite(view.playheadBeat)) {
    const x = Math.round((view.playheadBeat - scrollOffset) * ppb)
    if (x >= -2 && x <= w + 2) {
      ctx.fillStyle = p.playheadLine || p.ink
      ctx.fillRect(x, 0, 1, h)
    }
  }
}

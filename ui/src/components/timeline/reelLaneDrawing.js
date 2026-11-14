// Reel lane: canvas painter and hit-test.
//
// Drawn on the arrangement's content canvas (never DOM: a node per clip would
// drift on scroll and zoom, and a 2,000-note pattern would mean 2,000 nodes). The
// painter is allocation-free per frame apart from one small closure per visible
// lane, visits only the clips that can touch the viewport (binary search over the
// sorted starts), and animates nothing: a clip is where its note is, this frame.
//
// A clip is a flat neutral block (Follow = uncoloured). Selected = one ramp step
// lighter AND a 2px outline, so selection is never colour alone. A muted track's
// lane dims with its track. Above REEL_THUMB_MIN_W px a clip shows a still of its
// region's first frame at its head; below it, a plain block. The right edge of a
// clip wide enough to spare it holds the badge slot: a note with a Lens override
// draws a small neutral chip there, Nudge "+" and Own "O" (P8). A Follow clip draws
// nothing and stays uncoloured. The glyph, not a colour, carries the state; chip and
// glyph are theme tokens (palette.reelBadgeFill / reelBadgeInk).

import { pixelToTickExact, tickToPixel } from '../../constants/timeline.js'
import { MUTE_OPACITY } from './timelineDrawing.js'
import {
  REEL_THUMB_MIN_W, REEL_BADGE_W, REEL_BADGE_MIN_CLIP_W, REEL_MODE_FOLLOW, REEL_MODE_NUDGE,
  forEachReelClipInRange, reelClipAt, reelClipMode, reelSubRowSpan, reelLanePad,
} from './reelLaneModel.js'
import { getReelStill } from './reelStills.js'

/** A sub-row shorter than this is too thin for a legible thumbnail. */
const THUMB_MIN_H = 12
const THUMB_ASPECT = 16 / 9

/** Slot at a clip's right edge for the per-note state badge. */
export function reelBadgeRect(x, y, w, h) {
  if (w < REEL_BADGE_MIN_CLIP_W) return null
  return { x: x + w - REEL_BADGE_W, y, w: REEL_BADGE_W, h }
}

/** The glyph a clip's Lens state draws in its badge slot; null for Follow. */
export function reelBadgeGlyph(mode) {
  if (mode === REEL_MODE_FOLLOW) return null
  return mode === REEL_MODE_NUDGE ? '+' : 'O'
}

/** A sub-row shorter than this has no room for a legible glyph. */
const BADGE_MIN_H = 8

// Nudge "+" and Own "O" on a neutral chip. The glyph, not colour, carries the
// state. Leaves ctx.fillStyle as `bodyFill`: the caller's pass sets the body
// colour ONCE and keeps filling clips with it.
function paintBadge(ctx, mode, slot, palette, bodyFill) {
  const glyph = reelBadgeGlyph(mode)
  if (!glyph || !slot || slot.h < BADGE_MIN_H) return
  const inset = slot.h >= 12 ? 2 : 1
  ctx.fillStyle = palette.reelBadgeFill
  ctx.fillRect(slot.x + 1, slot.y + inset, slot.w - 2, slot.h - inset * 2)
  ctx.fillStyle = palette.reelBadgeInk
  ctx.fillText(glyph, slot.x + slot.w / 2, slot.y + slot.h / 2 + 0.5)
  ctx.fillStyle = bodyFill
}

function paintThumb(ctx, img, x, y, w, h, reserveRight) {
  const th = h - 2
  const tw = Math.min(Math.round(th * THUMB_ASPECT), w - 2 - reserveRight)
  if (tw < 8 || th < 8) return
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!(iw > 0 && ih > 0)) return
  // Cover-fit: crop the still to the thumbnail's aspect instead of squashing it.
  const target = tw / th
  const source = iw / ih
  let sx = 0, sy = 0, sw = iw, sh = ih
  if (source > target) { sw = ih * target; sx = (iw - sw) / 2 }
  else { sh = iw / target; sy = (ih - sh) / 2 }
  ctx.drawImage(img, sx, sy, sw, sh, x + 1, y + 1, tw, th)
}

/**
 * Paint every visible Reel lane.
 *
 * @param {object} view   { ctx, w, h, scrollOffset, ppb, trackLayout, palette, mutedTrackIds }
 * @param {object} data   { reel: { byTrack, stillByRegion }, selection: { [patternId]: Set<noteId> } }
 */
export function drawReelLanes(view, data) {
  const { ctx, w, h, scrollOffset, ppb, trackLayout, palette, mutedTrackIds } = view
  const rows = trackLayout?.getReelRows?.()
  const reel = data?.reel
  if (!rows || rows.length === 0 || !reel) return
  const selection = data.selection ?? {}

  // The viewport in ticks, padded so a clip widened to its 1px minimum at the very
  // edge is still visited.
  const loTick = pixelToTickExact(-2, scrollOffset, ppb)
  const hiTick = pixelToTickExact(w + 2, scrollOffset, ppb)

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    if (row.collapsed) continue
    if (row.y >= h) break
    if (row.y + row.height <= 0) continue
    const track = reel.byTrack.get(row.parentTrackId)
    if (!track || track.count === 0) continue

    const muted = !!mutedTrackIds?.has(row.parentTrackId)
    ctx.save()
    // The lane keeps its clips off the neighbouring rows even at 1px minimum widths.
    ctx.beginPath()
    ctx.rect(0, row.y, w, row.height)
    ctx.clip()
    if (muted) ctx.globalAlpha = MUTE_OPACITY
    // Badge text state, set once per lane (restored with the lane).
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const stillByRegion = reel.stillByRegion
    const subRows = row.subRows
    const trackHeight = row.trackHeight

    // Two passes so each fillStyle is set once: unselected bodies, then selected.
    for (let pass = 0; pass < 2; pass++) {
      const wantSelected = pass === 1
      const bodyFill = wantSelected ? palette.reelBodySelected : palette.reelBody
      ctx.fillStyle = bodyFill
      forEachReelClipInRange(track, loTick, hiTick, (i) => {
        const set = selection[track.patternIds[i]]
        const selected = set !== undefined && set.has(track.noteIds[i])
        if (selected !== wantSelected) return

        const { y0, y1 } = reelSubRowSpan(row.y, row.height, subRows, track.rows[i], trackHeight)
        const x0 = Math.round(tickToPixel(track.starts[i], scrollOffset, ppb))
        const x1 = Math.round(tickToPixel(track.ends[i], scrollOffset, ppb))
        if (x1 < 0 || x0 > w) return
        let cw = x1 - x0
        if (cw > 3) cw -= 1                      // a 1px gap between butted clips
        if (cw < 1) cw = 1
        let ch = y1 - y0
        if (ch > 5) ch -= 1                      // and between sub-rows
        if (ch < 1) ch = 1

        ctx.fillRect(x0, y0, cw, ch)

        if (cw >= REEL_THUMB_MIN_W && ch >= THUMB_MIN_H) {
          const img = getReelStill(stillByRegion.get(track.regionIds[i]))
          if (img) {
            const slot = reelBadgeRect(x0, y0, cw, ch)
            paintThumb(ctx, img, x0, y0, cw, ch, slot ? REEL_BADGE_W : 0)
          }
        }
        if (cw >= REEL_BADGE_MIN_CLIP_W) {
          paintBadge(ctx, reelClipMode(track, i), reelBadgeRect(x0, y0, cw, ch), palette, bodyFill)
        }

        if (wantSelected) {
          if (cw >= 4 && ch >= 4) {
            ctx.strokeStyle = palette.select
            ctx.lineWidth = 2
            ctx.strokeRect(x0 + 1, y0 + 1, cw - 2, ch - 2)
          } else {
            // Too small for an outline: the whole sliver takes the selection colour.
            ctx.fillStyle = palette.select
            ctx.fillRect(x0, y0, cw, ch)
            ctx.fillStyle = bodyFill
          }
        }
      })
    }
    ctx.restore()
  }
}

/**
 * What is under (localX, localY) in a Reel lane?
 *
 * @returns {null | { row: object, patternId: number|null, noteId: number|null }}
 *   null when the point is not in a Reel lane at all. `noteId` is null for empty
 *   lane space (or a collapsed strip) inside one.
 */
export function hitTestReel(reel, trackLayout, localX, localY, scrollOffset, ppb) {
  const row = trackLayout?.reelRowAtY?.(localY)
  if (!row) return null
  const miss = { row, patternId: null, noteId: null }
  if (row.collapsed) return miss
  const track = reel?.byTrack?.get(row.parentTrackId)
  if (!track || track.count === 0) return miss

  const pad = reelLanePad(row.trackHeight)
  const innerH = row.height - pad * 2
  const rel = localY - (row.y + pad)
  if (rel < 0 || rel >= innerH) return miss
  const subRow = Math.min(row.subRows - 1, Math.floor(rel / (innerH / row.subRows)))

  const tick = pixelToTickExact(localX, scrollOffset, ppb)
  // Hit zone 1.5px either side: a clip drawn at its 1px minimum must stay clickable.
  const slack = pixelToTickExact(1.5, 0, ppb) - pixelToTickExact(0, 0, ppb)
  const i = reelClipAt(track, tick, subRow, slack)
  if (i < 0) return miss
  return { row, patternId: track.patternIds[i], noteId: track.noteIds[i] }
}

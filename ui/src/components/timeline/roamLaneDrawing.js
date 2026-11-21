// Roam key lane: canvas painter. The Sweep lane (P11) is this same painter over the
// Lens channels (data.kind === 'sweep'): same axes, curve and keys, its own rows.
//
// Drawn on the arrangement's content canvas (never DOM: a node per key would drift
// on scroll and zoom). One lane graphs ONE Roam parameter against the timeline's own
// ticks. The curve is the engine's own rule: a keyed channel holds its first key's
// value before it and its last key's value after it, and between two keys the
// LEAVING key's interp shapes the segment (Hold steps, Linear is a line, EaseOut
// decelerates, Bezier follows the key's own handles). Keys are shaped by their interp
// (Hold square, Linear circle, EaseOut diamond, Bezier hexagon) so the shape, not
// colour alone, carries it. The selected key is larger, outlined and prints its value;
// keys in the multi-selection are outlined too. A selected Bezier key shows its
// segment's two handles. A muted track's lane dims with its track.
//
// Nothing animates: a key is where its tick is, this frame. The painter touches no
// store and no DOM; the gesture (roamLaneGesture.js) feeds it the draft.

import { uiCanvasFont } from '../../styles/typography.js'
import { tickToPixel } from '../../constants/timeline.js'
import { MUTE_OPACITY } from './timelineDrawing.js'
import { formatRoamValue, laneValueToY, roamIdentityOf, segmentEase } from '../../lensRoam/roamKeyModel.js'
import {
  ROAM_HANDLE_R, ROAM_KEY_R, keyPixel, laneBezierSegments, laneKeys, laneRangeFor, refIsSelected, roamLaneInner,
} from './roamLaneModel.js'

function keyShape(ctx, interp, x, y, r) {
  ctx.beginPath()
  if (interp === 'Hold') {
    ctx.rect(x - r + 0.5, y - r + 0.5, 2 * r - 1, 2 * r - 1)
  } else if (interp === 'EaseOut') {
    const d = r * 1.25
    ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath()
  } else if (interp === 'Bezier') {
    const d = r * 1.15
    for (let i = 0; i < 6; i++) {
      const t = (Math.PI / 3) * i
      const px = x + d * Math.cos(t)
      const py = y + d * Math.sin(t)
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.closePath()
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2)
  }
}

/** Trace one segment a -> b (key objects) into the current path, from (x0, y0) already there. */
function traceSegment(ctx, a, b, range, inner, scrollOffset, ppb, log) {
  const x1 = tickToPixel(b.pos, scrollOffset, ppb)
  const y1 = laneValueToY(range, inner, b.value)
  const x0 = tickToPixel(a.pos, scrollOffset, ppb)
  const y0 = laneValueToY(range, inner, a.value)
  if (a.interp === 'Hold') {
    ctx.lineTo(x1, y0)
    ctx.lineTo(x1, y1)
  } else if (a.interp === 'EaseOut' || a.interp === 'Bezier' || log) {
    // A curve, or a line in value space on a log lane (a curve there too); sample it.
    const n = Math.max(6, Math.min(64, Math.ceil(Math.abs(x1 - x0) / 3)))
    for (let i = 1; i <= n; i++) {
      const u = i / n
      ctx.lineTo(x0 + (x1 - x0) * u, laneValueToY(range, inner, a.value + (b.value - a.value) * segmentEase(a, u)))
    }
  } else {
    ctx.lineTo(x1, y1)
  }
}

/** A Bezier segment's two handles: a thin arm from each end key, a small dot at its tip. */
function drawHandles(ctx, seg, palette) {
  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = palette.select
  ctx.globalAlpha = 0.85
  ctx.beginPath()
  ctx.moveTo(seg.from.x, seg.from.y); ctx.lineTo(seg.h1.x, seg.h1.y)
  ctx.moveTo(seg.to.x, seg.to.y); ctx.lineTo(seg.h2.x, seg.h2.y)
  ctx.stroke()
  ctx.globalAlpha = 1
  for (const h of [seg.h1, seg.h2]) {
    ctx.beginPath()
    ctx.arc(h.x, h.y, ROAM_HANDLE_R, 0, Math.PI * 2)
    ctx.fillStyle = palette.inkDark
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = palette.select
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Paint every visible Roam key lane.
 *
 * @param {object} view   { ctx, w, h, scrollOffset, ppb, trackLayout, palette, trackColorById, mutedTrackIds }
 * @param {object} data   { dataOf(trackId) -> {base, keys}|undefined (a gesture's draft applied),
 *                          channelOf(trackId) -> channel, selected: {trackId, channel, pos}|null,
 *                          multi?: [{trackId, channel, pos}] (the multi-selection),
 *                          marquee?: {x0, y0, x1, y1}|null (a selection drag, local px),
 *                          kind?: 'roam' | 'sweep' }
 */
export function drawRoamLanes(view, data) {
  const { ctx, w, h, scrollOffset, ppb, trackLayout, palette, trackColorById, mutedTrackIds } = view
  const sweep = data?.kind === 'sweep'
  const rows = sweep ? trackLayout?.getSweepRows?.() : trackLayout?.getRoamRows?.()
  if (!rows || rows.length === 0 || !data) return
  const { dataOf, channelOf, selected, multi = [], marquee = null } = data

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    if (row.y >= h) break
    if (row.y + row.height <= 0) continue
    const trackId = row.parentTrackId
    const channel = channelOf(trackId)
    const d = dataOf(trackId) ?? { base: {}, keys: [] }
    const range = laneRangeFor(channel, d.keys, d.base)
    const inner = roamLaneInner(row)
    const keys = laneKeys(d.keys, channel)
    const color = trackColorById?.[trackId] ?? palette.ink
    const muted = !!mutedTrackIds?.has(trackId)

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, row.y, w, row.height)
    ctx.clip()
    if (muted) ctx.globalAlpha = MUTE_OPACITY

    // The identity line (no offset / no scale / no rotation): where the cell sits at rest.
    const idY = Math.round(laneValueToY(range, inner, roamIdentityOf(channel))) + 0.5
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.roamAxis
    ctx.beginPath()
    ctx.moveTo(0, idY)
    ctx.lineTo(w, idY)
    ctx.stroke()

    // The lane's extremes, printed at its left edge so a height is never a guess.
    ctx.font = uiCanvasFont('10px')
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = palette.roamLabel
    ctx.fillText(formatRoamValue(channel, range.max, { short: true }), 4, inner.top + 6)
    ctx.fillText(formatRoamValue(channel, range.min, { short: true }), 4, inner.top + inner.height - 6)

    if (keys.length === 0) {
      // Unkeyed: the cell holds the track's base. Drawn dashed, with the one hint the lane needs.
      const b = d.base?.[channel]
      const by = laneValueToY(range, inner, Number.isFinite(b) ? b : roamIdentityOf(channel))
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = palette.roamLine
      ctx.beginPath()
      ctx.moveTo(0, Math.round(by) + 0.5)
      ctx.lineTo(w, Math.round(by) + 0.5)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = palette.roamLabel
      ctx.textAlign = 'left'
      ctx.fillText(
        sweep ? 'No keys. Click to add one. Sweep changes nothing until it has keys.'
          : 'No keys. Click to add one. The cell holds its base value.',
        56, inner.top + inner.height / 2,
      )
      ctx.restore()
      continue
    }

    // The curve.
    const log = !!range.log
    const first = keys[0]
    const last = keys[keys.length - 1]
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(0, laneValueToY(range, inner, first.value))
    ctx.lineTo(tickToPixel(first.pos, scrollOffset, ppb), laneValueToY(range, inner, first.value))
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i]
      const b = keys[i + 1]
      const xb = tickToPixel(b.pos, scrollOffset, ppb)
      if (xb < -2 || tickToPixel(a.pos, scrollOffset, ppb) > w + 2) {
        // Off screen: keep the path continuous without sampling it.
        ctx.moveTo(xb, laneValueToY(range, inner, b.value))
        continue
      }
      traceSegment(ctx, a, b, range, inner, scrollOffset, ppb, log)
    }
    ctx.lineTo(w, laneValueToY(range, inner, last.value))
    ctx.stroke()

    // A selected Bezier key's handles, under the keys so a key stays on top.
    const isSelectedKey = (k) => refIsSelected({ trackId, channel, pos: k.pos }, selected, multi)
    for (const seg of laneBezierSegments(keys, isSelectedKey, row, range, scrollOffset, ppb)) {
      if (Math.max(seg.to.x, seg.h2.x) < -8 || Math.min(seg.from.x, seg.h1.x) > w + 8) continue
      drawHandles(ctx, seg, palette)
    }

    // The keys.
    let selectedAt = null
    for (const k of keys) {
      const p = keyPixel(k, row, range, scrollOffset, ppb)
      if (p.x < -ROAM_KEY_R * 2 || p.x > w + ROAM_KEY_R * 2) continue
      const isPrimary = !!selected && selected.trackId === trackId && selected.channel === channel
        && Math.abs(selected.pos - k.pos) < 0.5
      const isSel = isPrimary || isSelectedKey(k)
      keyShape(ctx, k.interp, p.x, p.y, isSel ? ROAM_KEY_R + 1 : ROAM_KEY_R)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = isSel ? 2 : 1
      ctx.strokeStyle = isSel ? palette.select : palette.inkDark
      ctx.stroke()
      if (isPrimary) selectedAt = { k, p }
    }

    // The selected key prints its value, on a chip, so a drag reads out its number.
    if (selectedAt) {
      const text = formatRoamValue(channel, selectedAt.k.value)
      ctx.font = uiCanvasFont('10px')
      const tw = ctx.measureText(text).width
      const bw = Math.ceil(tw) + 8
      const bh = 14
      let bx = selectedAt.p.x + 9
      if (bx + bw > w - 2) bx = selectedAt.p.x - 9 - bw
      let by = selectedAt.p.y - bh - 4
      if (by < inner.top) by = selectedAt.p.y + 6
      ctx.fillStyle = palette.inkDark
      ctx.fillRect(bx, by, bw, bh)
      ctx.fillStyle = palette.ink
      ctx.textAlign = 'left'
      ctx.fillText(text, bx + 4, by + bh / 2 + 0.5)
    }
    ctx.restore()
  }

  // A selection drag in progress: the rubber band, over every lane it crosses.
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1)
    const y = Math.min(marquee.y0, marquee.y1)
    const mw = Math.abs(marquee.x1 - marquee.x0)
    const mh = Math.abs(marquee.y1 - marquee.y0)
    ctx.save()
    ctx.globalAlpha = 0.12
    ctx.fillStyle = palette.select
    ctx.fillRect(x, y, mw, mh)
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = palette.select
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(mw), Math.round(mh))
    ctx.setLineDash([])
    ctx.restore()
  }
}

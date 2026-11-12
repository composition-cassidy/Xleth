// Timeline block geometry: the ONE place that turns a clip / pattern block into
// pixels and a pointer position back into a block.
//
// "Block" means anything that sits on a track row and has positionTicks +
// durationTicks: audio clips and pattern blocks. (Automation clips live on lane
// rows and have their own module, automationLaneGeometry.js.)
//
// Everything that needs to agree about where a block is goes through here:
//   - the canvas draw path           (timelineDrawing.js)
//   - pointer hit-testing            (tools/*.js, TimelineCanvas.jsx)
//   - DOM overlays on top of blocks  (FX badges, the pattern rename input)
// Before this module existed the same arithmetic was written out in each of
// those places and had drifted: drawing widened tiny blocks to a minimum width
// while hit-testing did not, drawing painted the last block in the array on top
// while hit-testing returned the first one, and so on.

import {
  TRACK_HEIGHT,
  CLIP_MIN_WIDTH_PX,
  tickToPixel,
  ticksToBeats,
} from '../../constants/timeline.js'

/** Vertical inset of a block inside its track row. */
export const BLOCK_PAD = 2

/** Width of the resize handle painted on a selected block's edge. */
export const BLOCK_HANDLE_W = 4

/** A block narrower than this shows no handles: they would cover the body. */
export const BLOCK_HANDLE_MIN_BLOCK_W = BLOCK_HANDLE_W * 3

/** Widest an edge (resize) hit zone gets. Wider than the painted handle. */
export const BLOCK_EDGE_HIT_W = 6

// ── Rows ────────────────────────────────────────────────────────────────────
// Macro / automation child lanes insert vertical space below their parent
// track, so a track's top is not `index * TRACK_HEIGHT` once a layout exists
// (see timelineRowLayout.js). Without one, rows are contiguous.

export function trackTopOf(trackIndex, trackLayout = null) {
  if (trackLayout && typeof trackLayout.trackTop === 'function') {
    return trackLayout.trackTop(trackIndex)
  }
  return trackIndex * TRACK_HEIGHT
}

export function trackIndexAtY(y, trackLayout = null) {
  if (trackLayout && typeof trackLayout.trackIndexAtY === 'function') {
    return trackLayout.trackIndexAtY(y)
  }
  return Math.floor(y / TRACK_HEIGHT)
}

// ── Block rectangle ─────────────────────────────────────────────────────────

/**
 * Snap a horizontal span to whole pixels by rounding its two EDGES (not its
 * origin and width). Two blocks that share a tick boundary therefore share a
 * pixel boundary at every scroll offset and zoom: no hairline gap or overlap
 * between butted clips, and no edge that shimmers between one and two soft
 * pixels as the view pans. The grid snaps its lines the same way.
 */
export function snapSpanLeft(x) {
  return Math.round(x)
}
export function snapSpanWidth(x, w, minW = 0) {
  return Math.max(Math.round(x + w) - Math.round(x), minW)
}

/**
 * The on-screen rectangle of a block, in CSS pixels of the timeline canvas.
 *
 * `x`/`w` are pixel-snapped: they are what gets painted and hit-tested.
 * `timeX`/`timeW` are the exact (unrounded) time-to-pixel mapping, for content
 * that has to stay time-accurate inside the block (the waveform, pattern
 * notes), which is then clipped to the painted rectangle.
 *
 * Pass `out` to reuse one object across a draw loop instead of allocating a
 * rect per block per frame.
 */
export function blockRect(item, trackIndex, scrollOffset, ppb, trackLayout = null, out = null) {
  const timeX = tickToPixel(item.positionTicks, scrollOffset, ppb)
  let timeW = ticksToBeats(item.durationTicks) * ppb
  if (timeW < CLIP_MIN_WIDTH_PX) timeW = CLIP_MIN_WIDTH_PX

  const r = out || {}
  r.x = snapSpanLeft(timeX)
  r.w = snapSpanWidth(timeX, timeW, CLIP_MIN_WIDTH_PX)
  r.y = Math.round(trackTopOf(trackIndex, trackLayout)) + BLOCK_PAD
  r.h = TRACK_HEIGHT - BLOCK_PAD * 2
  r.timeX = timeX
  r.timeW = timeW
  return r
}

/** `blockRect` for callers that hold a trackId map. Null for an unknown track. */
export function getClipRect(clip, trackIdToIndex, scrollOffset, ppb, trackLayout = null) {
  if (!clip || !trackIdToIndex) return null
  const trackIdx = trackIdToIndex[clip.trackId]
  if (trackIdx == null) return null
  return blockRect(clip, trackIdx, scrollOffset, ppb, trackLayout)
}

// ── Inner layout (title strip + content region + chip slot) ────────────────
// Drawing-only: none of this changes a block's outer rectangle.

export const TITLE_STRIP_H = 16
export const TITLE_STRIP_MIN_BLOCK_H = 28 // below this the strip is suppressed
export const TITLE_TEXT_PAD_X = 6
export const TITLE_CONTENT_GAP = 2
export const CHIP_H = 12
export const CHIP_RIGHT_INSET = 6
export const CHIP_BOTTOM_INSET = 4
/** At or below this width a block shows body, border and handles only. */
export const TINY_BLOCK_MAX_W = 24

export function blockInnerLayout(rect, showTitleStrip) {
  const { x, y, w, h } = rect
  const useStrip = !!showTitleStrip && h >= TITLE_STRIP_MIN_BLOCK_H
  const titleH = useStrip ? TITLE_STRIP_H : 0
  return {
    useStrip,
    titleX: x,
    titleY: y,
    titleW: w,
    titleH,
    contentX: x,
    contentY: useStrip ? (y + titleH + TITLE_CONTENT_GAP) : y,
    contentW: w,
    contentH: useStrip ? Math.max(0, h - titleH - TITLE_CONTENT_GAP) : h,
    metadataArea: {
      rightX: x + w - CHIP_RIGHT_INSET,
      bottomY: y + h - CHIP_BOTTOM_INSET,
      height: CHIP_H,
    },
  }
}

/** Does this block get a title strip at all, given the "show names" setting? */
export function blockWantsTitleStrip(rect, showNames) {
  return showNames !== 'never' && rect.w > TINY_BLOCK_MAX_W
}

// ── Resize edges ────────────────────────────────────────────────────────────

/** Are the painted resize handles shown on a selected block of this width? */
export function blockShowsHandles(rect) {
  return rect.w > BLOCK_HANDLE_MIN_BLOCK_W
}

/**
 * Width of one edge hit zone. Capped at a third of the block so a narrow block
 * always keeps a middle third that MOVES it: with a flat 6px zone on each side,
 * any block under 12px wide was resize-only and could not be dragged at all.
 */
export function blockEdgeHitWidth(w) {
  return Math.max(1, Math.min(BLOCK_EDGE_HIT_W, Math.floor(w / 3)))
}

/** Which resize edge of `rect` is under `localX`: 'left', 'right' or null. */
export function blockEdgeAt(rect, localX) {
  const zone = blockEdgeHitWidth(rect.w)
  if (localX >= rect.x + rect.w - zone) return 'right'
  if (localX < rect.x + zone) return 'left'
  return null
}

// ── Hit-testing ─────────────────────────────────────────────────────────────
// `view` is { scrollOffset, ppb, trackIdToIndex, trackLayout? }.
//
// Blocks are painted in array order, so the LAST matching block is the one the
// user sees on top. Every search below walks the array backwards for that
// reason: the block you click is the block you get.

const _hitRect = {}

/** Topmost block on `trackIndex` whose painted rectangle contains `localX`. */
export function hitTestBlockAt(items, localX, trackIndex, view) {
  if (!items || trackIndex == null || trackIndex < 0) return null
  const { scrollOffset, ppb, trackIdToIndex } = view
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (trackIdToIndex[item.trackId] !== trackIndex) continue
    const r = blockRect(item, trackIndex, scrollOffset, ppb, null, _hitRect)
    if (localX >= r.x && localX < r.x + r.w) return item
  }
  return null
}

/**
 * Topmost block on `trackIndex` whose TIME span contains `tick`. Tick domain on
 * purpose (no minimum-width widening): this answers "which block is playing at
 * this instant", which is what a split at a snapped grid position needs.
 */
export function findBlockAtTick(items, tick, trackIndex, trackIdToIndex) {
  if (!items || trackIndex == null || trackIndex < 0) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (trackIdToIndex[item.trackId] !== trackIndex) continue
    if (tick >= item.positionTicks && tick < item.positionTicks + item.durationTicks) return item
  }
  return null
}

/**
 * Every block whose painted rectangle touches the pixel rectangle
 * (x1,y1)-(x2,y2), in any corner order. `accept(item, trackIndex)` can veto.
 */
export function blocksInPixelRect(items, x1, y1, x2, y2, view, accept = null) {
  const out = []
  if (!items) return out
  const { scrollOffset, ppb, trackIdToIndex, trackLayout = null } = view
  const left = Math.min(x1, x2), right = Math.max(x1, x2)
  const top = Math.min(y1, y2), bottom = Math.max(y1, y2)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const trackIndex = trackIdToIndex[item.trackId]
    if (trackIndex == null) continue
    const r = blockRect(item, trackIndex, scrollOffset, ppb, trackLayout, _hitRect)
    if (r.x + r.w < left || r.x > right || r.y + r.h < top || r.y > bottom) continue
    if (accept && !accept(item, trackIndex)) continue
    out.push(item)
  }
  return out
}

/** id -> index map for a tracks array (the `trackIdToIndex` every query takes). */
export function buildTrackIdToIndex(tracks) {
  const map = {}
  if (tracks) for (let i = 0; i < tracks.length; i++) map[tracks[i].id] = i
  return map
}

/**
 * Group translation geometry — the drag/duplicate counterpart to
 * timelineClipboard.js.
 *
 * A move/duplicate gesture on a multi-item selection is a RIGID TRANSLATION.
 * The clipboard module already states that law for copy/paste (a copied
 * selection keeps every item's offset from the group anchor); this module
 * states it for the pointer.
 *
 * The law, in the order it is applied:
 *
 *   1. A gesture has an ANCHOR — the item grabbed at mousedown.
 *   2. Snap resolves exactly ONE value: the anchor's destination. Never per
 *      item. (Snapping each item independently collapses the group — three
 *      clips at 0.0/0.5/1.0 beats nudged +0.1 with snap=Bar all land on beat 0,
 *      stacked, which double-triggers the sampler.)
 *   3. The result is an integer (tickDelta, trackDelta) pair.
 *   4. tickDelta is clamped ONCE against the group's leftmost item; trackDelta
 *      ONCE against its topmost and bottommost rows. (Clamping per item shears
 *      a group dragged past an edge instead of stopping it.)
 *   5. If ANY destination is type-invalid, the whole gesture is refused. It
 *      never partially applies.
 *   6. Every item's new position is origTicks + tickDelta. Integer ticks end to
 *      end — beats never enter position math, so a free (Alt) drag cannot
 *      accumulate ±1 tick of per-item rounding drift.
 *   7. There is one resolver, so the preview and the commit cannot disagree:
 *      the overlay draws `placements` and mouseup sends that same array.
 *
 * Pure — no DOM, no refs, no engine. Everything the caller knows about the
 * pointer arrives as arguments.
 */

import { beatsToTicks, snapBeatToGrid, ticksToBeats } from '../../constants/timeline.js'

/**
 * One item of a gesture. Anything beyond these fields (the clip/block object,
 * ghost colors, laneId, …) is carried through onto the placement untouched.
 *
 * @typedef  {object}  GroupItem
 * @property {'clip'|'block'|'automation'} kind
 * @property {number}  origTicks       Position at mousedown, in TICKS (integer).
 * @property {?number} origTrackIndex  Row at mousedown, or null/-1 when the item
 *                                     is lane-addressed (automation clips) and
 *                                     therefore has no vertical axis.
 */

/** A gesture that resolves to nothing. Shared shape so callers can `if (refused)`. */
const REFUSED = Object.freeze({ tickDelta: 0, trackDelta: 0, placements: [], refused: true })

/** Normalises -0 (which a clamp against a zero-index group produces) to 0. */
function zero(n) {
  return n === 0 ? 0 : n
}

/** Items that live on a track row (clips, pattern blocks) — automation does not. */
function isTrackAddressed(item) {
  return Number.isInteger(item?.origTrackIndex) && item.origTrackIndex >= 0
}

/**
 * A destination row accepts an item only when their kinds agree. Pattern blocks
 * require a Pattern track; every other item requires a non-Pattern track (Clip,
 * Video, …) — the same rule the drag code has always used, stated once.
 */
function destinationAccepts(kind, track) {
  if (!track) return false
  return kind === 'block' ? track.type === 'Pattern' : track.type !== 'Pattern'
}

/**
 * resolveGroupTranslation — pointer state → one rigid (tickDelta, trackDelta).
 *
 * Call it with EVERY item of the gesture at once (clips, pattern blocks and
 * automation clips together): a mixed selection has to refuse or apply as a
 * unit, which is impossible if each kind resolves its own delta.
 *
 * @param {object}      args
 * @param {GroupItem[]} args.items              Every item being translated.
 * @param {?GroupItem}  args.anchor             The grabbed item. Defaults to the
 *                                              earliest item when omitted.
 * @param {number}      args.pointerBeatDelta   Pointer travel since mousedown, in beats.
 * @param {number}      args.pointerTrackDelta  Rows travelled by the pointer relative
 *                                              to the anchor's row. Pass a non-finite
 *                                              value (the caller could not resolve a
 *                                              row — a folder header, say) to refuse.
 * @param {Array}       args.tracks             Tracks in display order.
 * @param {object}      args.modifiers          { alt, ctrl, shift } — alt frees the snap.
 * @param {string}      args.snapGranularity    Snap key ('1/16', 'Bar', …).
 * @returns {{tickDelta: number, trackDelta: number, placements: Array, refused: boolean}}
 *          `placements` carries each input item plus { positionTicks, trackIndex,
 *          trackId }; it is `[]` exactly when `refused` is true.
 */
export function resolveGroupTranslation({
  items = [],
  anchor = null,
  pointerBeatDelta = 0,
  pointerTrackDelta = 0,
  tracks = [],
  modifiers = {},
  snapGranularity = '1/16',
} = {}) {
  if (!Array.isArray(items) || items.length === 0) return REFUSED
  if (!Number.isFinite(pointerBeatDelta) || !Number.isFinite(pointerTrackDelta)) return REFUSED

  // ── 1. Anchor ────────────────────────────────────────────────────────────
  const anchorItem = anchor ?? items.reduce((lo, it) => (it.origTicks < lo.origTicks ? it : lo), items[0])
  const anchorTicks = Math.round(anchorItem.origTicks)

  // ── 2/3. Snap resolves ONE destination — the anchor's — as integer ticks ──
  const anchorDestTicks = beatsToTicks(
    snapBeatToGrid(ticksToBeats(anchorTicks) + pointerBeatDelta, modifiers, snapGranularity),
  )
  let tickDelta = anchorDestTicks - anchorTicks

  // ── 4a. One horizontal clamp, against the group's leftmost item ──────────
  let minOrigTicks = Infinity
  for (const it of items) {
    const t = Math.round(it.origTicks)
    if (t < minOrigTicks) minOrigTicks = t
  }
  if (tickDelta < -minOrigTicks) tickDelta = zero(-minOrigTicks)

  // ── 4b. One vertical clamp, against the group's topmost/bottommost rows ──
  const trackItems = items.filter(isTrackAddressed)
  let trackDelta = 0
  if (trackItems.length > 0) {
    if (tracks.length === 0) return REFUSED
    let minIdx = Infinity
    let maxIdx = -Infinity
    for (const it of trackItems) {
      if (it.origTrackIndex < minIdx) minIdx = it.origTrackIndex
      if (it.origTrackIndex > maxIdx) maxIdx = it.origTrackIndex
    }
    const lo = -minIdx
    const hi = tracks.length - 1 - maxIdx
    // The group is taller than the track list — no offset can hold it.
    if (hi < lo) return REFUSED
    trackDelta = zero(Math.min(Math.max(Math.trunc(pointerTrackDelta), lo), hi))
  }

  // ── 5. All-or-nothing type check ─────────────────────────────────────────
  for (const it of trackItems) {
    if (!destinationAccepts(it.kind, tracks[it.origTrackIndex + trackDelta])) return REFUSED
  }

  // ── 6. Every item moves by the same integer pair ─────────────────────────
  const placements = items.map((it) => {
    const positionTicks = Math.round(it.origTicks) + tickDelta
    if (!isTrackAddressed(it)) {
      return { ...it, positionTicks, trackIndex: null }
    }
    const trackIndex = it.origTrackIndex + trackDelta
    return { ...it, positionTicks, trackIndex, trackId: tracks[trackIndex]?.id ?? it.trackId }
  })

  return { tickDelta, trackDelta, placements, refused: false }
}

/**
 * Split one resolved placement list by item kind. Both the preview and the
 * commit split the SAME array this way, so the two can never drift apart.
 */
export function splitPlacementsByKind(placements = []) {
  const clip = []
  const block = []
  const automation = []
  for (const p of placements) {
    if (p.kind === 'block') block.push(p)
    else if (p.kind === 'automation') automation.push(p)
    else clip.push(p)
  }
  return { clip, block, automation }
}

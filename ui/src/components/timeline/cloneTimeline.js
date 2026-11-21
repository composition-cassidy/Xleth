// Clones in the Edit view (docs/XLETH_CLONE_SPEC.md, "Timeline and Motion view"):
// the pure helpers TimelineView and the track header list share. No React, no
// engine calls: every write goes through clones/cloneApi.js.

import { canHaveClones, clonesOf, isClone } from '../../clones/cloneModel.js'

/**
 * The string key the row layout is rebuilt from: "trackId:collapsed:subRows;" per
 * lane. A Clone's lane is collapsed exactly when its SOURCE's Reel lane is (a
 * source and its Clones collapse as one group), so the source's flag is used.
 * A string, so a note moving (new model, same depths) does not rebuild the layout.
 */
export function reelLanesKeyFor(reelModel, collapsed, tracks) {
  const sourceOfClone = new Map()
  for (const t of tracks ?? []) if (isClone(t)) sourceOfClone.set(t.id, t.cloneOf)
  let key = ''
  for (const [trackId, lane] of reelModel?.byTrack ?? []) {
    const groupId = sourceOfClone.get(trackId) ?? trackId
    key += `${trackId}:${collapsed?.has(groupId) ? 1 : 0}:${lane.subRows};`
  }
  return key
}

/**
 * The Clone-specific items of a track's context menu.
 *   source (a Pattern track that is not a Clone): "Add voice clone", "Add trail clone".
 *   Clone: "Move clone up" / "Move clone down" (disabled at the ends of its
 *   source's Clones), "Show in Inspector", then "Delete clone". A Clone has no
 *   pattern, conversion or hold items: the engine refuses blocks on it.
 * Returns null for a track that is neither (no Clone items at all).
 *
 * @param {object} track
 * @param {Array}  tracks  every track (timeline.getTracks)
 * @param {object} on      { addClone(kind), moveClone(delta), showInInspector(), remove() }
 */
export function cloneMenuItems(track, tracks, on = {}) {
  if (!track) return null
  if (isClone(track)) {
    const siblings = clonesOf(tracks, track.cloneOf)
    const i = siblings.findIndex((t) => t.id === track.id)
    return [
      { label: 'Move clone up', disabled: i <= 0, onClick: () => on.moveClone?.(-1) },
      { label: 'Move clone down', disabled: i < 0 || i >= siblings.length - 1, onClick: () => on.moveClone?.(1) },
      { type: 'separator' },
      { label: 'Show in Inspector', onClick: () => on.showInInspector?.() },
      { type: 'separator' },
      { label: 'Delete clone', danger: true, onClick: () => on.remove?.() },
    ]
  }
  if (!canHaveClones(track)) return null
  return [
    { label: 'Add voice clone', onClick: () => on.addClone?.('Voice') },
    { label: 'Add trail clone', onClick: () => on.addClone?.('Trail') },
  ]
}

/** How the delete confirmation names a track: `track "Lead"`, plus its Clones when it has any. */
export function trackRemovalSubject(track, tracks) {
  const name = track?.name ? `track "${track.name}"` : 'this track'
  if (!track || isClone(track)) return name
  const n = clonesOf(tracks, track.id).length
  if (n === 0) return name
  return `${name} and its ${n === 1 ? 'clone' : `${n} clones`}`
}

/** Track ids a header drag may move: Clones never move on their own (they follow their source). */
export function draggableTrackIds(ids, tracks) {
  const byId = new Map((tracks ?? []).map((t) => [t.id, t]))
  return (ids ?? []).filter((id) => !isClone(byId.get(id)))
}

/**
 * Pencil draw length ("sticky note length") rules.
 *
 * State: { lengthTicks, overridden }.
 *
 *  - snap-following (overridden === false): the pencil draws exactly one snap
 *    division, and the length re-follows every SNAP change.
 *  - overridden (true): the user touched an existing clip whose length differs
 *    from the snap division, so that clip's exact length is now the global draw
 *    length and SNAP changes no longer move it. It survives until the project is
 *    closed/loaded, or until a clip exactly one snap division long is touched.
 *
 * Pure — no React, no engine. TimelineView owns the state; the timeline tools
 * feed it clip lengths through adoptDrawLength().
 */

/** SNAP changed: only a snap-following state re-follows it. */
export function drawLengthForSnap(state, snapDefaultTicks) {
  if (state.overridden) return state
  if (state.lengthTicks === snapDefaultTicks) return state
  return { lengthTicks: snapDefaultTicks, overridden: false }
}

/**
 * The user touched a clip of `ticks` length (select, move, trim, stretch, or a
 * middle-click template). Adopting a length that is not exactly one snap
 * division arms the override; adopting one that is disarms it.
 * Invalid lengths are ignored.
 */
export function adoptDrawLength(state, ticks, snapDefaultTicks) {
  const rounded = Math.round(Number(ticks))
  if (!Number.isFinite(rounded) || rounded <= 0) return state
  const overridden = rounded !== snapDefaultTicks
  if (state.lengthTicks === rounded && state.overridden === overridden) return state
  return { lengthTicks: rounded, overridden }
}

/** Project load/close — back to following SNAP. */
export function resetDrawLength(snapDefaultTicks) {
  return { lengthTicks: snapDefaultTicks, overridden: false }
}

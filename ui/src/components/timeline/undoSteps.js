/**
 * How many engine undo entries a bulk timeline gesture pushes.
 *
 * Ctrl+Z pops exactly one engine entry. A gesture that pushed N therefore has
 * to tell the keyboard handler its N (compoundUndoCountRef) or Ctrl+Z peels off
 * one step and leaves the timeline half-reverted — a bulk delete of 40 pattern
 * blocks used to put back one block.
 *
 * The counts below are a pure function of the gesture's input because every RPC
 * on these paths is fired with `.catch(log)` — a failure is swallowed, not
 * retried, so the number of entries pushed does not depend on which calls
 * succeeded. Gestures whose count DOES depend on that (paste and Ctrl+D both
 * skip an add that returned a negative id) accumulate inline at the call site
 * instead; there is no input-only answer for them.
 *
 * Each line names the RPC it counts.
 *
 * The ADD side of that swap has landed: paste, Ctrl+D and the drag duplicates go
 * through timeline.add/pastePatternBlocksBatch and automation.addClipsBatch, one
 * entry each, and those call sites now set compoundUndoCountRef to 1 directly
 * rather than accumulating. What is left here counts the paths still firing N×:
 * removePatternBlock, automation.removeClip and pitchShiftClip. When those grow
 * batch RPCs the count for that kind becomes `? 1 : 0` and the edit is this one
 * line plus its call site.
 */

/**
 * deleteSelectedTimelineItems — one Delete (or Ctrl+X, which delegates to it).
 *
 * @param {object} plan
 * @param {Array}  plan.clipIds            Clips removed via ONE removeClipsBatch.
 * @param {Array}  plan.blockIds           Blocks removed via N× removePatternBlock.
 * @param {Array}  plan.automationClipIds  Automation clips via N× automation.removeClip.
 * @returns {number} Engine undo entries the gesture pushes.
 */
export function deleteUndoSteps({ clipIds = [], blockIds = [], automationClipIds = [] } = {}) {
  return (clipIds.length > 0 ? 1 : 0)   // timeline.removeClipsBatch — ONE entry for all clips
       + blockIds.length                // N× timeline.removePatternBlock
       + automationClipIds.length       // N× automation.removeClip
}

/**
 * Bulk pitch shift (+/- keys) over a clip selection.
 *
 * @param {Array} clipIds Clips shifted via N× pitchShiftClip.
 * @returns {number}
 */
export function pitchShiftUndoSteps(clipIds = []) {
  return clipIds.length                 // N× timeline.pitchShiftClip
}

/**
 * Move committed by a drag, after the overwrite plan is resolved.
 *
 * @param {object} plan
 * @param {number} plan.doomedCount Items the move overwrites.
 * @param {number} plan.moveCount   Items actually moved.
 * @param {boolean} plan.batchedRemove True when the removes go through ONE batch
 *                                     RPC (clips), false when N× (pattern blocks).
 * @param {boolean} plan.batchedMove   Same, for the moves.
 * @returns {number}
 */
export function moveUndoSteps({ doomedCount = 0, moveCount = 0, batchedRemove = false, batchedMove = false } = {}) {
  const removes = doomedCount === 0 ? 0 : (batchedRemove ? 1 : doomedCount)
  const moves = moveCount === 0 ? 0 : (batchedMove ? 1 : moveCount)
  return removes + moves
}

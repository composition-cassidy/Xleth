// Pure math for per-edge quantize of arranger clips and pattern blocks.
//
// A clip has: oldStart, oldEnd (ticks), oldOffset (regionOffset / pattern offset,
// ticks), oldStretch (audio only; pattern blocks ignore this).
//
// Actions per edge: 'leave' | 'move' | 'trim' | 'stretch'
// - leave:   edge unchanged
// - move:    edge snaps, the whole clip translates (offset/stretch unchanged)
// - trim:    edge snaps, the opposite edge stays. Changes duration.
//            For start-trim: offset shifts by the same delta (max 0 floor).
//            For end-trim: only duration changes.
// - stretch: edge snaps, the opposite edge stays. Changes duration AND the
//            stretchRatio is scaled by newDur/oldDur. Audio clips only.
//
// Start action is applied first, producing an intermediate (start, end, offset,
// stretch). End action is then applied on top of those intermediate values.
//
// Disallowed combos:
//   - start=move & end=move  (would be two global translates; ambiguous)
//   - any stretch action on pattern blocks or mixed selections
//
// Skip entries with duration < MIN_DURATION_TICKS (120, a 1/32 note).

import { snapTickToGrid, PPQ } from '../constants/timeline.js'

export const MIN_DURATION_TICKS   = 120
const STRETCH_MIN = 0.1
const STRETCH_MAX = 20.0

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function validateActionCombo(startAction, endAction, hasPatternBlock) {
  if (startAction === 'move' && endAction === 'move') {
    return { ok: false, reason: 'Move + Move is not allowed (use Leave on one edge).' }
  }
  if (hasPatternBlock && (startAction === 'stretch' || endAction === 'stretch')) {
    return { ok: false, reason: 'Stretch is not supported on pattern blocks.' }
  }
  return { ok: true }
}

function applyStartAction(c, action, granularity) {
  let { start, end, offset, stretch, isPatternBlock } = c
  const origStart = start
  const origEnd   = end
  const origDur   = end - start

  if (action === 'leave') {
    return { start, end, offset, stretch }
  }

  const snapped = snapTickToGrid(origStart, {}, granularity)
  const delta   = snapped - origStart
  if (delta === 0) return { start, end, offset, stretch }

  if (action === 'move') {
    start = snapped
    end   = origEnd + delta
    return { start, end, offset, stretch }
  }
  if (action === 'trim') {
    // Respect minimum duration and forbid trimming past end.
    const maxStart = origEnd - MIN_DURATION_TICKS
    start  = Math.min(snapped, maxStart)
    end    = origEnd
    offset = Math.max(0, offset + (start - origStart))
    return { start, end, offset, stretch }
  }
  if (action === 'stretch') {
    if (isPatternBlock) return { start, end, offset, stretch } // caller should have blocked
    const maxStart = origEnd - MIN_DURATION_TICKS
    start = Math.min(snapped, maxStart)
    end   = origEnd
    const newDur = end - start
    if (newDur > 0 && origDur > 0) {
      const factor = newDur / origDur
      stretch = clamp(stretch * factor, STRETCH_MIN, STRETCH_MAX)
    }
    return { start, end, offset, stretch }
  }
  return { start, end, offset, stretch }
}

function applyEndAction(c, action, granularity) {
  let { start, end, offset, stretch, isPatternBlock } = c
  const origStart = start
  const origEnd   = end
  const origDur   = end - start

  if (action === 'leave') {
    return { start, end, offset, stretch }
  }

  const snapped = snapTickToGrid(origEnd, {}, granularity)
  const delta   = snapped - origEnd
  if (delta === 0) return { start, end, offset, stretch }

  if (action === 'move') {
    start = origStart + delta
    end   = snapped
    if (start < 0) {
      end  -= start
      start = 0
    }
    return { start, end, offset, stretch }
  }
  if (action === 'trim') {
    const minEnd = origStart + MIN_DURATION_TICKS
    end = Math.max(snapped, minEnd)
    return { start, end, offset, stretch }
  }
  if (action === 'stretch') {
    if (isPatternBlock) return { start, end, offset, stretch }
    const minEnd = origStart + MIN_DURATION_TICKS
    end = Math.max(snapped, minEnd)
    const newDur = end - start
    if (newDur > 0 && origDur > 0) {
      const factor = newDur / origDur
      stretch = clamp(stretch * factor, STRETCH_MIN, STRETCH_MAX)
    }
    return { start, end, offset, stretch }
  }
  return { start, end, offset, stretch }
}

/**
 * computeQuantizeForClip
 * @param {object} clip  { id, isPatternBlock, oldStart, oldEnd, oldOffset, oldStretch }
 * @param {string} startAction
 * @param {string} endAction
 * @param {string} granularity snap granularity key
 * @returns { spec, skipped, reason } — spec is the IPC-shaped object, or null if skipped.
 */
export function computeQuantizeForClip(clip, startAction, endAction, granularity) {
  const {
    id, isPatternBlock,
    oldStart, oldEnd, oldOffset, oldStretch = 1.0,
  } = clip

  const oldDur = oldEnd - oldStart
  if (oldDur < MIN_DURATION_TICKS) {
    return { spec: null, skipped: true, reason: `duration ${oldDur} < ${MIN_DURATION_TICKS} ticks` }
  }

  const working = {
    start: oldStart, end: oldEnd, offset: oldOffset,
    stretch: isPatternBlock ? 1.0 : oldStretch,
    isPatternBlock,
  }

  const afterStart = applyStartAction(working, startAction, granularity)
  const afterEnd   = applyEndAction(
    { ...afterStart, isPatternBlock },
    endAction, granularity
  )

  // No-op detection
  if (
    afterEnd.start   === oldStart &&
    afterEnd.end     === oldEnd &&
    afterEnd.offset  === oldOffset &&
    (isPatternBlock || Math.abs(afterEnd.stretch - oldStretch) < 1e-9)
  ) {
    return { spec: null, skipped: true, reason: 'no change' }
  }

  // Final clamps / sanity.
  const finalOffset = Math.max(0, Math.round(afterEnd.offset))
  const finalStart  = Math.max(0, Math.round(afterEnd.start))
  const finalEnd    = Math.max(finalStart + MIN_DURATION_TICKS, Math.round(afterEnd.end))
  const finalStretch = isPatternBlock
    ? 1.0
    : clamp(afterEnd.stretch, STRETCH_MIN, STRETCH_MAX)

  return {
    spec: {
      id,
      isPatternBlock: !!isPatternBlock,
      newStartTicks:   finalStart,
      newEndTicks:     finalEnd,
      newOffsetTicks:  finalOffset,
      newStretchRatio: finalStretch,
    },
    skipped: false,
  }
}

// Convenience for TimelineView: turn a selection + actions into an array of
// IPC specs, plus a skip-list for logging.
export function buildQuantizeSpecs(selectedClips, selectedBlocks, startAction, endAction, granularity) {
  const specs = []
  const skipped = []

  for (const c of selectedClips) {
    const r = computeQuantizeForClip({
      id: c.id,
      isPatternBlock: false,
      oldStart:   c.positionTicks,
      oldEnd:     c.positionTicks + c.durationTicks,
      oldOffset:  c.regionOffsetTicks ?? 0,
      oldStretch: c.stretchRatio ?? 1.0,
    }, startAction, endAction, granularity)
    if (r.skipped) skipped.push({ kind: 'clip', id: c.id, reason: r.reason })
    else if (r.spec) specs.push(r.spec)
  }

  for (const b of selectedBlocks) {
    const r = computeQuantizeForClip({
      id: b.id,
      isPatternBlock: true,
      oldStart:  b.positionTicks,
      oldEnd:    b.positionTicks + b.durationTicks,
      oldOffset: b.offsetTicks ?? 0,
      oldStretch: 1.0,
    }, startAction, endAction, granularity)
    if (r.skipped) skipped.push({ kind: 'block', id: b.id, reason: r.reason })
    else if (r.spec) specs.push(r.spec)
  }

  return { specs, skipped }
}

export { PPQ }

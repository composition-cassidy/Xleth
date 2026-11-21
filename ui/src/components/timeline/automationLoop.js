// "Loop to …" for automation clips — pure placement math, no DOM / IPC.
//
// The engine has no loop flag on an automation clip (a clip shows
// [offsetTicks, offsetTicks + duration) of its envelope and that is all), so
// looping is realised as repeated copies that share the source envelope — the
// same FL semantics as a drag-duplicate. The selection repeats as ONE group:
// the period is the group's full span (first start → last end), so a pair of
// clips loops as a pair and keeps its internal spacing.
//
// Copies that would start at/after `endTick` are dropped and the one that
// straddles it is trimmed to end exactly on `endTick`. Copies that would
// overlap something already on the lane are dropped too — the engine rejects
// same-lane overlap by pushing the placement forward, which would scatter a
// loop instead of tiling it.

export const MAX_LOOP_COPIES = 512

/**
 * @param {Array}  clips        Source automation clips ({ id, laneId, envelopeId, positionTicks, durationTicks, offsetTicks }).
 * @param {number} endTick      Loop until this tick.
 * @param {Array}  existing     Every automation clip currently in the project (for overlap rejection).
 * @param {number} [minDuration] Shortest clip a trimmed final copy may be.
 * @returns {Array<{clip, laneId, positionTicks, durationTicks}>}
 */
export function planAutomationLoop(clips, endTick, existing = [], minDuration = 120) {
  if (!Array.isArray(clips) || clips.length === 0 || !Number.isFinite(endTick)) return []
  const groupStart = Math.min(...clips.map((c) => c.positionTicks))
  const groupEnd = Math.max(...clips.map((c) => c.positionTicks + c.durationTicks))
  const period = groupEnd - groupStart
  if (period <= 0 || groupEnd >= endTick) return []

  // Occupancy per lane: existing clips plus whatever this plan already placed.
  const occupied = new Map()
  const occupy = (laneId, start, end) => {
    if (!occupied.has(laneId)) occupied.set(laneId, [])
    occupied.get(laneId).push([start, end])
  }
  for (const c of existing) occupy(c.laneId, c.positionTicks, c.positionTicks + c.durationTicks)
  const isFree = (laneId, start, end) =>
    !(occupied.get(laneId) ?? []).some(([s, e]) => start < e && end > s)

  const ordered = clips.slice().sort((a, b) => a.positionTicks - b.positionTicks)
  const out = []
  for (let k = 1; k <= MAX_LOOP_COPIES; k++) {
    const shift = k * period
    if (groupStart + shift >= endTick) break
    for (const clip of ordered) {
      const start = clip.positionTicks + shift
      if (start >= endTick) continue
      const durationTicks = Math.min(clip.durationTicks, endTick - start)
      if (durationTicks < minDuration) continue
      if (!isFree(clip.laneId, start, start + durationTicks)) continue
      occupy(clip.laneId, start, start + durationTicks)
      out.push({ clip, laneId: clip.laneId, positionTicks: start, durationTicks })
    }
  }
  return out
}

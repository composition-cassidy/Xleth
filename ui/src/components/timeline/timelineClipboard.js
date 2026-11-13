/**
 * Timeline clipboard geometry.
 *
 * A copied selection is stored as a RIGID GROUP: every item keeps its offset
 * from the group's anchor in both axes — ticks from the earliest item, and
 * track *index* from the topmost track. Paste then re-anchors the whole group
 * at (edit cursor, focused track) without deforming it.
 *
 * The previous implementation stored only a tick offset, forced every clip
 * back onto its original track, and slid individual clips rightward to dodge
 * occupied space — which silently broke the group's internal timing. Overlaps
 * are now resolved by OVERWRITING what the group lands on, the way Ableton /
 * Reaper / FL do it, which also avoids stacking two clips on one track (a
 * stack double-triggers the sampler).
 *
 * These helpers are pure so the geometry is testable without an engine.
 */

/** Fields carried through a clip copy. Anything omitted resets to its engine default. */
const CLIP_SNAPSHOT_FIELDS = [
  'regionId', 'durationTicks', 'regionOffsetTicks', 'syllableIndex',
  'velocity', 'pitchOffset', 'pitchOffsetCents',
  'reversed', 'stretchRatio', 'stretchMethod', 'formantPreserve',
  'fadeInPercent', 'fadeOutPercent',
  'fadeInX1', 'fadeInY1', 'fadeInX2', 'fadeInY2',
  'fadeOutX1', 'fadeOutY1', 'fadeOutX2', 'fadeOutY2',
]

const CLIP_DEFAULTS = {
  regionOffsetTicks: 0, syllableIndex: -1, velocity: 1.0,
  pitchOffset: 0, pitchOffsetCents: 0,
  reversed: false, stretchRatio: 1.0, stretchMethod: 0 /* StretchMethod::Global */,
  formantPreserve: false,
  fadeInPercent: 0, fadeOutPercent: 0,
  fadeInX1: 0, fadeInY1: 0, fadeInX2: 1, fadeInY2: 1,
  fadeOutX1: 0, fadeOutY1: 0, fadeOutX2: 1, fadeOutY2: 1,
}

/**
 * Normalize one Ctrl+C snapshot before it replaces the timeline clipboard.
 * Clips and pattern blocks may coexist in a mixed timeline selection.
 */
export function normalizeTimelineClipboardPayloads(clips, patternBlocks) {
  return {
    clips: Array.isArray(clips) && clips.length > 0 ? clips : null,
    patternBlocks: Array.isArray(patternBlocks) && patternBlocks.length > 0
      ? patternBlocks
      : null,
  }
}

/**
 * buildTimelineClipboard — snapshot a selection as a rigid group.
 *
 * @param {object}   args
 * @param {Array}    args.clips           Selected clip objects (engine shape).
 * @param {Array}    args.patternBlocks   Selected pattern-block objects.
 * @param {Array}    args.automationClips Selected automation-clip objects.
 * @param {Array}    args.tracks          Visible tracks, in display order.
 * @returns {{clips: Array|null, patternBlocks: Array|null, automationClips: Array|null, anchorTrackIndex: number}}
 *          `null` payloads mean "nothing of that kind was selected".
 */
export function buildTimelineClipboard({ clips = [], patternBlocks = [], automationClips = [], tracks = [] }) {
  const trackIndexById = new Map(tracks.map((t, i) => [t.id, i]))
  const indexOf = (trackId) => {
    const i = trackIndexById.get(trackId)
    return i === undefined ? -1 : i
  }

  // Items on tracks that no longer exist can't be anchored, so drop them here
  // rather than producing a group with a meaningless offset. Automation clips
  // are lane-addressed, not track-addressed, so they carry no such check.
  const srcClips = clips.filter(c => indexOf(c.trackId) >= 0)
  const srcBlocks = patternBlocks.filter(b => indexOf(b.trackId) >= 0)
  const srcAutomation = automationClips.slice()
  if (srcClips.length === 0 && srcBlocks.length === 0 && srcAutomation.length === 0) {
    return { clips: null, patternBlocks: null, automationClips: null, anchorTrackIndex: 0 }
  }

  // ONE anchor shared by every kind. Anchoring each kind to its own earliest
  // item bakes the gap between the groups into the payload, so on paste the
  // pattern blocks (or automation clips) reappear bars away from the clips
  // they were copied with.
  const allPositions = [
    ...srcClips.map(c => c.positionTicks),
    ...srcBlocks.map(b => b.positionTicks),
    ...srcAutomation.map(c => c.positionTicks),
  ]
  const baseTicks = Math.min(...allPositions)
  const trackAnchorCandidates = [
    ...srcClips.map(c => indexOf(c.trackId)),
    ...srcBlocks.map(b => indexOf(b.trackId)),
  ]
  const anchorTrackIndex = trackAnchorCandidates.length > 0 ? Math.min(...trackAnchorCandidates) : 0

  const copiedClips = srcClips
    .slice()
    .sort((a, b) => a.positionTicks - b.positionTicks)
    .map(clip => {
      const snap = {
        sourceTrackType: 'Clip',
        relativePosition: clip.positionTicks - baseTicks,
        trackOffset: indexOf(clip.trackId) - anchorTrackIndex,
      }
      for (const f of CLIP_SNAPSHOT_FIELDS) {
        snap[f] = clip[f] ?? CLIP_DEFAULTS[f]
      }
      // Vibrato / Scratch / Video Swirl+Scratch — copied whole so paste keeps it.
      snap.modulation = clip.modulation ?? null
      // Lens {base, keys} — copied whole, or paste/split/duplicate rebuild the
      // clip at the new-clip default (fit = Cover) and lose its framing.
      snap.lens = clip.lens ?? null
      return snap
    })

  const copiedBlocks = srcBlocks
    .slice()
    .sort((a, b) => a.positionTicks - b.positionTicks)
    .map(block => ({
      sourceTrackType: 'Pattern',
      relativePosition: block.positionTicks - baseTicks,
      trackOffset: indexOf(block.trackId) - anchorTrackIndex,
      patternId: block.patternId,
      durationTicks: block.durationTicks,
      offsetTicks: block.offsetTicks ?? 0,
      loopEnabled: block.loopEnabled ?? false,
    }))

  // No trackOffset: an automation clip stays on its exact source lane on
  // paste/duplicate (no cross-lane retargeting), so the absolute laneId is
  // carried straight through. envelopeId is carried too — copies SHARE the
  // envelope until make-unique, the same FL semantics as the drag duplicate.
  const copiedAutomation = srcAutomation
    .slice()
    .sort((a, b) => a.positionTicks - b.positionTicks)
    .map(clip => ({
      relativePosition: clip.positionTicks - baseTicks,
      laneId: clip.laneId,
      durationTicks: clip.durationTicks,
      offsetTicks: clip.offsetTicks ?? 0,
      envelopeId: clip.envelopeId,
    }))

  return {
    ...normalizeTimelineClipboardPayloads(copiedClips, copiedBlocks),
    automationClips: copiedAutomation.length > 0 ? copiedAutomation : null,
    anchorTrackIndex,
  }
}

/**
 * resolveTimelinePaste — place a rigid group at (baseTicks, targetTrackIndex).
 *
 * Track offsets are applied against the paste target, then clamped to the
 * track list. A destination whose type doesn't match the item's origin is
 * skipped and counted rather than silently retargeted. Automation clips have
 * no track offset (they stay on their source lane) and no type-mismatch
 * check — see buildTimelineClipboard.
 *
 * @returns {{clipPlacements: Array, blockPlacements: Array, automationPlacements: Array,
 *            skipped: {typeMismatchClip: number, typeMismatchBlock: number}}}
 */
export function resolveTimelinePaste({
  clipboard, baseTicks, targetTrackIndex, tracks = [],
}) {
  const skipped = { typeMismatchClip: 0, typeMismatchBlock: 0 }
  const clipPlacements = []
  const blockPlacements = []
  const automationPlacements = []
  if (!clipboard || tracks.length === 0) return { clipPlacements, blockPlacements, automationPlacements, skipped }

  const anchor = Number.isInteger(targetTrackIndex) && targetTrackIndex >= 0
    ? targetTrackIndex
    : 0

  const destFor = (offset) => tracks[
    Math.max(0, Math.min(anchor + offset, tracks.length - 1))
  ]

  for (const item of clipboard.clips ?? []) {
    const track = destFor(item.trackOffset ?? 0)
    if (track?.type !== 'Clip') { skipped.typeMismatchClip++; continue }
    clipPlacements.push({
      item,
      trackId: track.id,
      positionTicks: baseTicks + item.relativePosition,
      durationTicks: item.durationTicks,
    })
  }

  for (const item of clipboard.patternBlocks ?? []) {
    const track = destFor(item.trackOffset ?? 0)
    if (track?.type !== 'Pattern') { skipped.typeMismatchBlock++; continue }
    blockPlacements.push({
      item,
      trackId: track.id,
      positionTicks: baseTicks + item.relativePosition,
      durationTicks: item.durationTicks,
    })
  }

  for (const item of clipboard.automationClips ?? []) {
    automationPlacements.push({
      item,
      laneId: item.laneId,
      positionTicks: baseTicks + item.relativePosition,
      durationTicks: item.durationTicks,
    })
  }

  return { clipPlacements, blockPlacements, automationPlacements, skipped }
}

/**
 * itemsCoveredByPlacements — existing items the incoming group will overwrite.
 *
 * Half-open interval test: an item that merely touches a placement's edge
 * (end === start) does not overlap it. Returns IDs, in the order given.
 *
 * `excludeIds` holds the gesture's OWN items (a Set, or null). A move must not
 * delete the thing it is moving, and it must not delete a sibling that is
 * vacating its slot in the same rigid translation — both are decided by the
 * gesture's FINAL state, not the one it started from.
 */
export function itemsCoveredByPlacements(existing, placements, excludeIds = null) {
  if (!Array.isArray(existing) || existing.length === 0) return []
  if (!Array.isArray(placements) || placements.length === 0) return []

  // Bucket placements by track so the scan is O(items + placements) per track
  // rather than the full cross product — a paste into a busy project used to
  // re-filter and re-sort the entire clip list once per pasted item.
  const byTrack = new Map()
  for (const p of placements) {
    if (!byTrack.has(p.trackId)) byTrack.set(p.trackId, [])
    byTrack.get(p.trackId).push(p)
  }

  const covered = []
  for (const item of existing) {
    if (excludeIds?.has(item.id)) continue
    const spans = byTrack.get(item.trackId)
    if (!spans) continue
    const start = item.positionTicks
    const end = start + item.durationTicks
    for (const p of spans) {
      if (start < p.positionTicks + p.durationTicks && end > p.positionTicks) {
        covered.push(item.id)
        break
      }
    }
  }
  return covered
}

/**
 * resolveOverwritePlan — the ONE overlap policy for track-addressed items.
 *
 * Clips and pattern blocks are OVERWRITTEN by whatever lands on them, the way
 * Ableton / Reaper / FL do it. Every gesture that addresses a track resolves
 * here — Ctrl+V paste, drag-move, Shift+drag duplicate and Ctrl+D — so the four
 * can no longer disagree about what happens to occupied space.
 *
 * Before this, only paste overwrote. Move, Ctrl+D and Shift+drag STACKED: the
 * engine validates ids and track type but never occupancy (Timeline::moveClip,
 * Timeline::addClip), so two clips really did end up on the same ticks of the
 * same track — which double-triggers the sampler.
 *
 * Automation clips are deliberately absent. The engine rejects same-lane
 * overlap outright, so those callers slide right into a free slot instead
 * (findFreeAutomationLanePosition); there is nothing to overwrite.
 *
 * `movingClipIds` / `movingBlockIds` are the gesture's OWN items — see
 * itemsCoveredByPlacements.
 *
 * @returns {{doomedClipIds: Array, doomedBlockIds: Array}}
 */
export function resolveOverwritePlan({
  existingClips = [], existingBlocks = [],
  clipPlacements = [], blockPlacements = [],
  movingClipIds = null, movingBlockIds = null,
} = {}) {
  return {
    doomedClipIds: itemsCoveredByPlacements(existingClips, clipPlacements, movingClipIds),
    doomedBlockIds: itemsCoveredByPlacements(existingBlocks, blockPlacements, movingBlockIds),
  }
}

/**
 * clipPayloadFromSnapshot — clipboard entry + destination → addClip(sBatch) payload.
 */
export function clipPayloadFromSnapshot(item, trackId, positionTicks) {
  const payload = { trackId, positionTicks }
  for (const f of CLIP_SNAPSHOT_FIELDS) payload[f] = item[f] ?? CLIP_DEFAULTS[f]
  if (item.modulation) payload.modulation = item.modulation
  if (item.lens) payload.lens = item.lens
  return payload
}

/** Longest end tick of a placed group — where the edit cursor lands after paste. */
export function placementsEndTick(baseTicks, ...placementLists) {
  let end = baseTicks
  for (const list of placementLists) {
    for (const p of list ?? []) {
      const e = p.positionTicks + p.durationTicks
      if (e > end) end = e
    }
  }
  return end
}

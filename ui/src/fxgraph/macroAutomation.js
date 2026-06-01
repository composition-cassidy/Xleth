// FXG.4-h — Parent-Attached Macro Automation Lanes
//
// A macro automation lane is a timeline-domain control region that drives a graph
// Macro node's `normalizedValue` over time. Lanes are parent-attached: they live
// inside the owning track's `graphState` (so `parentTrackId === graphState.trackId`)
// and bind to exactly one `macroNodeId`. The macro node itself stays a clean 0..1
// control source — automation data is a SIBLING field, never stored on the node.
//
// Correct runtime flow (see docs/dev/fxgraph-architecture.md → FXG.4-h):
//   playback tick
//     -> evaluate active automation clip on the parent track's macro lane
//     -> produce Macro normalizedValue 0.0..1.0
//     -> existing Macro-to-Parameter edges apply per-link mapping (FXG.4-e/f/g)
//     -> setGraphEffectParameterNormalized writes the stock/VST parameter (FXG.4-a)
//
// This module is PURE. It never touches effectChains, audio topology, engine node
// ids, or plugin parameters directly. It only reads/writes the renderer-side
// graphState `macroAutomationLanes` field.

// Only call-time function reuse is imported from graphState (FXG.4-g curve utils).
// No graphState consts are read at module top-level here — that would create a
// top-level circular-import dependency (graphState.loadGraphState imports this
// module's normalizer). These string literals intentionally match
// GRAPH_PARAMETER_CURVE_LINEAR / GRAPH_PARAMETER_CURVE_BEZIER by value.
import {
  createDefaultBezierCurve,
  evaluateBezierCurve,
} from './graphState.js'

export const MACRO_AUTOMATION_TARGET = 'normalizedValue'

// Per-point segment curve. A point's `curve` describes the segment LEAVING that
// point toward the next one. `linear` is a straight lerp; `bezier` reuses the
// FXG.4-g ease curve to shape the segment's progress.
export const MACRO_AUTOMATION_SEGMENT_LINEAR = 'linear'
export const MACRO_AUTOMATION_SEGMENT_BEZIER = 'bezier'

export const MACRO_AUTOMATION_REJECTION = Object.freeze({
  INVALID_GRAPH_STATE: 'invalid_graph_state',
  MISSING_MACRO_NODE: 'missing_macro_node',
  NOT_MACRO_NODE: 'not_macro_node',
  MISSING_LANE: 'missing_lane',
  MISSING_CLIP: 'missing_clip',
  MISSING_POINT: 'missing_point',
  CLIP_OVERLAP: 'clip_overlap',
  INVALID_CLIP: 'invalid_clip',
  INVALID_POINT: 'invalid_point',
  MIN_POINTS: 'min_points',
  INCOMPATIBLE_LANE: 'incompatible_lane',
})

const DEFAULT_CLIP_LENGTH_TICKS = 960 // one beat at PPQ 960

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clamp01(value, fallback = 0) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function toNonNegativeInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const int = Math.round(value)
  return int < 0 ? 0 : int
}

function toPositiveInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const int = Math.round(value)
  return int < 1 ? 1 : int
}

function generateId(idFactory, prefix) {
  if (typeof idFactory === 'function') {
    const id = idFactory()
    if (typeof id === 'string' && id.length > 0) return id
  }
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${prefix}-${uuid}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ---------------------------------------------------------------------------
// Normalization (called from graphState.loadGraphState so persistence round-trips
// and old projects without the field load as []).
// ---------------------------------------------------------------------------

function normalizeSegmentCurve(rawCurve) {
  return rawCurve === MACRO_AUTOMATION_SEGMENT_BEZIER
    ? MACRO_AUTOMATION_SEGMENT_BEZIER
    : MACRO_AUTOMATION_SEGMENT_LINEAR
}

function normalizePoint(raw) {
  if (!isPlainObject(raw)) return null
  if (!Number.isFinite(raw.tick) || !Number.isFinite(raw.value)) return null
  return {
    tick: toNonNegativeInt(raw.tick, 0),
    value: clamp01(raw.value, 0),
    curve: normalizeSegmentCurve(raw.curve),
  }
}

// Points are sorted by tick and deduped by tick (last write wins). A clip always
// has at least two points; degenerate input is repaired to a flat 2-point clip.
function normalizePoints(rawPoints, lengthTicks, fallbackValue) {
  const points = []
  if (Array.isArray(rawPoints)) {
    for (const raw of rawPoints) {
      const point = normalizePoint(raw)
      if (point) points.push(point)
    }
  }
  points.sort((a, b) => a.tick - b.tick)

  const deduped = []
  for (const point of points) {
    const last = deduped[deduped.length - 1]
    if (last && last.tick === point.tick) {
      deduped[deduped.length - 1] = point
    } else {
      deduped.push(point)
    }
  }

  if (deduped.length === 0) {
    const value = clamp01(fallbackValue, 0)
    return [
      { tick: 0, value, curve: MACRO_AUTOMATION_SEGMENT_LINEAR },
      { tick: lengthTicks, value, curve: MACRO_AUTOMATION_SEGMENT_LINEAR },
    ]
  }
  if (deduped.length === 1) {
    const only = deduped[0]
    const endTick = only.tick === lengthTicks ? lengthTicks + 1 : lengthTicks
    return [
      { tick: 0, value: only.value, curve: only.curve },
      { tick: Math.max(endTick, only.tick + 1), value: only.value, curve: MACRO_AUTOMATION_SEGMENT_LINEAR },
    ]
  }
  return deduped
}

function normalizeClip(raw, idFactory) {
  if (!isPlainObject(raw)) return null
  const lengthTicks = toPositiveInt(raw.lengthTicks, DEFAULT_CLIP_LENGTH_TICKS)
  const clip = {
    clipId: typeof raw.clipId === 'string' && raw.clipId.length > 0
      ? raw.clipId
      : generateId(idFactory, 'maclip'),
    startTick: toNonNegativeInt(raw.startTick, 0),
    lengthTicks,
    loopEnabled: raw.loopEnabled === true,
    points: normalizePoints(raw.points, lengthTicks, raw.fallbackValue),
  }
  if (typeof raw.name === 'string' && raw.name.trim().length > 0) clip.name = raw.name.trim()
  if (typeof raw.colorToken === 'string' && raw.colorToken.trim().length > 0) {
    clip.colorToken = raw.colorToken.trim()
  }
  return clip
}

export function clipsOverlap(a, b) {
  if (!a || !b) return false
  const aEnd = a.startTick + a.lengthTicks
  const bEnd = b.startTick + b.lengthTicks
  return a.startTick < bEnd && b.startTick < aEnd
}

// Drops later clips that overlap an already-accepted clip in the same lane
// (same-lane overlap is rejected in v1). Sorted by startTick first so the
// earliest clip wins deterministically.
function resolveLaneClipOverlaps(clips) {
  const sorted = [...clips].sort((a, b) => a.startTick - b.startTick)
  const accepted = []
  for (const clip of sorted) {
    if (accepted.some((existing) => clipsOverlap(existing, clip))) continue
    accepted.push(clip)
  }
  return accepted
}

// `validMacroNodeIds` is a Set of macro node ids that currently exist in the
// graph. Lanes whose macro is missing are PRESERVED but flagged
// `targetUnavailable: true` (orphaned) per FXG.4-h missing-target handling — user
// data is never auto-deleted, and evaluation skips orphaned lanes.
export function normalizeMacroAutomationLanes(rawLanes, validMacroNodeIds = null, idFactory = null) {
  if (!Array.isArray(rawLanes)) return []

  const macroIds = validMacroNodeIds instanceof Set
    ? validMacroNodeIds
    : Array.isArray(validMacroNodeIds)
      ? new Set(validMacroNodeIds)
      : null

  const lanes = []
  const seenMacroIds = new Set()
  for (const raw of rawLanes) {
    if (!isPlainObject(raw)) continue
    const macroNodeId = typeof raw.macroNodeId === 'string' ? raw.macroNodeId.trim() : ''
    if (!macroNodeId) continue
    // One lane per macro: drop duplicates (first wins).
    if (seenMacroIds.has(macroNodeId)) continue
    seenMacroIds.add(macroNodeId)

    const clips = []
    if (Array.isArray(raw.clips)) {
      for (const rawClip of raw.clips) {
        const clip = normalizeClip(rawClip, idFactory)
        if (clip) clips.push(clip)
      }
    }

    const lane = {
      laneId: typeof raw.laneId === 'string' && raw.laneId.length > 0
        ? raw.laneId
        : generateId(idFactory, 'malane'),
      macroNodeId,
      target: MACRO_AUTOMATION_TARGET,
      visible: raw.visible !== false,
      clips: resolveLaneClipOverlaps(clips),
    }
    if (macroIds && !macroIds.has(macroNodeId)) {
      lane.targetUnavailable = true
    }
    lanes.push(lane)
  }
  return lanes
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function readLanes(graphState) {
  return Array.isArray(graphState?.macroAutomationLanes) ? graphState.macroAutomationLanes : []
}

export function findMacroAutomationLane(graphState, macroNodeId) {
  return readLanes(graphState).find((lane) => lane.macroNodeId === macroNodeId) ?? null
}

export function findMacroAutomationClip(graphState, clipId) {
  for (const lane of readLanes(graphState)) {
    const clip = lane.clips.find((candidate) => candidate.clipId === clipId)
    if (clip) return { lane, clip }
  }
  return null
}

// Stable binding view for a clip: parentTrackId comes from the owning graphState,
// never stored redundantly on the clip (single source of truth = graphState.trackId).
export function getMacroAutomationClipBinding(graphState, clipId) {
  const found = findMacroAutomationClip(graphState, clipId)
  if (!found) return null
  return {
    parentTrackId: graphState?.trackId == null ? '' : String(graphState.trackId),
    macroNodeId: found.lane.macroNodeId,
    laneId: found.lane.laneId,
    clipId: found.clip.clipId,
    target: MACRO_AUTOMATION_TARGET,
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// Samples a clip's point curve at a clip-local tick. Before the first point holds
// the first value; after the last point holds the last value. Linear by default;
// a point with curve === 'bezier' shapes its outgoing segment via FXG.4-g easing.
export function sampleMacroClipCurveAtLocalTick(points, localTick) {
  if (!Array.isArray(points) || points.length === 0) return 0
  if (points.length === 1) return clamp01(points[0].value, 0)

  const first = points[0]
  const last = points[points.length - 1]
  if (localTick <= first.tick) return clamp01(first.value, 0)
  if (localTick >= last.tick) return clamp01(last.value, 0)

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i]
    const p1 = points[i + 1]
    if (localTick >= p0.tick && localTick < p1.tick) {
      const span = p1.tick - p0.tick
      const t = span <= 0 ? 0 : (localTick - p0.tick) / span
      const shapedT = p0.curve === MACRO_AUTOMATION_SEGMENT_BEZIER
        ? evaluateBezierCurve(createDefaultBezierCurve(), t)
        : t
      return clamp01(p0.value + shapedT * (p1.value - p0.value), 0)
    }
  }
  return clamp01(last.value, 0)
}

// The value a clip "leaves behind" when playback passes its end — used by the
// hold-last-value rule. Equal to the curve value at the clip's final local tick
// (loop is intentionally NOT applied; loop only acts inside the clip's bounds).
export function macroClipEndValue(clip) {
  if (!clip) return 0
  return sampleMacroClipCurveAtLocalTick(clip.points, clip.lengthTicks)
}

// Evaluates a single clip at a global tick.
//   { active: boolean, value: number|null }
// Loop rule: loopEnabled only acts while playback is inside [startTick, end). The
// looped material is the range between the first and last automation point.
export function evaluateMacroAutomationClip(clip, globalTick) {
  if (!clip) return { active: false, value: null }
  const end = clip.startTick + clip.lengthTicks
  if (globalTick < clip.startTick || globalTick >= end) {
    return { active: false, value: null }
  }
  const localTick = globalTick - clip.startTick
  const points = clip.points
  const first = points[0]?.tick ?? 0
  const last = points[points.length - 1]?.tick ?? 0
  const loopLen = last - first

  if (clip.loopEnabled && loopLen > 0) {
    const sampleTick = localTick < first
      ? first
      : first + ((localTick - first) % loopLen)
    return { active: true, value: sampleMacroClipCurveAtLocalTick(points, sampleTick) }
  }
  return { active: true, value: sampleMacroClipCurveAtLocalTick(points, localTick) }
}

// Evaluates a whole lane at a global tick, applying the hold-last-value rule:
//   - active clip wins
//   - else the most-recently-ended clip's end value is held
//   - else (no earlier clip) the macro's saved/manual fallback value is used
export function evaluateMacroAutomationLaneValue(lane, globalTick, fallbackValue = 0) {
  const fallback = clamp01(fallbackValue, 0)
  if (!lane || lane.targetUnavailable || !Array.isArray(lane.clips) || lane.clips.length === 0) {
    return fallback
  }

  let active = null
  let lastEnded = null
  for (const clip of lane.clips) {
    const end = clip.startTick + clip.lengthTicks
    if (globalTick >= clip.startTick && globalTick < end) {
      active = clip
      break
    }
    if (end <= globalTick) {
      if (!lastEnded || (clip.startTick + clip.lengthTicks) > (lastEnded.startTick + lastEnded.lengthTicks)) {
        lastEnded = clip
      }
    }
  }

  if (active) return evaluateMacroAutomationClip(active, globalTick).value
  if (lastEnded) return macroClipEndValue(lastEnded)
  return fallback
}

// Top-level evaluation for one macro.
//   { hasAutomation: boolean, value: number }
// hasAutomation is true only when a non-orphaned lane with at least one clip exists,
// so callers can avoid overwriting purely manual macros.
export function evaluateMacroAutomationForMacro(graphState, macroNodeId, globalTick, fallbackValue = 0) {
  const lane = findMacroAutomationLane(graphState, macroNodeId)
  if (!lane || lane.targetUnavailable || lane.clips.length === 0) {
    return { hasAutomation: false, value: clamp01(fallbackValue, 0) }
  }
  return {
    hasAutomation: true,
    value: evaluateMacroAutomationLaneValue(lane, globalTick, fallbackValue),
  }
}

// ---------------------------------------------------------------------------
// Mutation helpers (pure; return { ok, graphState, ... } or { ok: false, reason })
// ---------------------------------------------------------------------------

function validateGraphStateForAutomation(graphState) {
  if (!isPlainObject(graphState) || !Array.isArray(graphState.nodes)) {
    return { ok: false, reason: MACRO_AUTOMATION_REJECTION.INVALID_GRAPH_STATE }
  }
  return { ok: true }
}

function findMacroNode(graphState, macroNodeId) {
  return graphState.nodes.find((node) => node.id === macroNodeId) ?? null
}

function withLanes(graphState, lanes) {
  return { ...graphState, macroAutomationLanes: lanes }
}

function replaceLane(lanes, laneId, nextLane) {
  return lanes.map((lane) => (lane.laneId === laneId ? nextLane : lane))
}

// Ensures a (visible) lane exists for the macro. Returns the lane and the next
// lanes array. Does not mutate when already present.
function ensureLane(graphState, macroNodeId, idFactory) {
  const lanes = readLanes(graphState)
  const existing = lanes.find((lane) => lane.macroNodeId === macroNodeId)
  if (existing) return { lanes, lane: existing }
  const lane = {
    laneId: generateId(idFactory, 'malane'),
    macroNodeId,
    target: MACRO_AUTOMATION_TARGET,
    visible: true,
    clips: [],
  }
  return { lanes: [...lanes, lane], lane }
}

export function showMacroAutomationLane(graphState, macroNodeId, options = {}) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const macroNode = findMacroNode(graphState, macroNodeId)
  if (!macroNode) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_MACRO_NODE }
  if (macroNode.type !== 'macro') return { ok: false, reason: MACRO_AUTOMATION_REJECTION.NOT_MACRO_NODE }

  const { lanes, lane } = ensureLane(graphState, macroNodeId, options.idFactory)
  const nextLane = { ...lane, visible: true }
  const nextLanes = lanes.some((l) => l.laneId === lane.laneId)
    ? replaceLane(lanes, lane.laneId, nextLane)
    : lanes
  return { ok: true, laneId: lane.laneId, graphState: withLanes(graphState, nextLanes) }
}

export function hideMacroAutomationLane(graphState, macroNodeId) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const lane = findMacroAutomationLane(graphState, macroNodeId)
  if (!lane) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_LANE }
  const lanes = readLanes(graphState)
  // Hiding never deletes clips.
  return {
    ok: true,
    laneId: lane.laneId,
    graphState: withLanes(graphState, replaceLane(lanes, lane.laneId, { ...lane, visible: false })),
  }
}

// Explicit lane removal (deletes clips). Used only on explicit user request /
// orphan cleanup — never automatically.
export function removeMacroAutomationLane(graphState, macroNodeId) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const lane = findMacroAutomationLane(graphState, macroNodeId)
  if (!lane) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_LANE }
  const lanes = readLanes(graphState).filter((l) => l.laneId !== lane.laneId)
  return { ok: true, graphState: withLanes(graphState, lanes) }
}

function laneAcceptsClip(lane, candidate, ignoreClipId = null) {
  return !lane.clips.some(
    (clip) => clip.clipId !== ignoreClipId && clipsOverlap(clip, candidate),
  )
}

export function createMacroAutomationClip(graphState, macroNodeId, clipDraft = {}, options = {}) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const macroNode = findMacroNode(graphState, macroNodeId)
  if (!macroNode) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_MACRO_NODE }
  if (macroNode.type !== 'macro') return { ok: false, reason: MACRO_AUTOMATION_REJECTION.NOT_MACRO_NODE }

  const draft = isPlainObject(clipDraft) ? clipDraft : {}
  const startTick = toNonNegativeInt(draft.startTick, 0)
  const lengthTicks = toPositiveInt(draft.lengthTicks, DEFAULT_CLIP_LENGTH_TICKS)
  // Default to a flat clip at the macro's current value so creation never jumps it.
  const seedValue = clamp01(
    Number.isFinite(draft.value) ? draft.value : macroNode.data?.normalizedValue,
    0,
  )
  const clip = normalizeClip(
    {
      clipId: typeof draft.clipId === 'string' ? draft.clipId : undefined,
      startTick,
      lengthTicks,
      loopEnabled: draft.loopEnabled === true,
      points: Array.isArray(draft.points) ? draft.points : undefined,
      fallbackValue: seedValue,
      name: draft.name,
      colorToken: draft.colorToken,
    },
    options.idFactory,
  )

  const { lanes, lane } = ensureLane(graphState, macroNodeId, options.idFactory)
  if (!laneAcceptsClip(lane, clip)) {
    return { ok: false, reason: MACRO_AUTOMATION_REJECTION.CLIP_OVERLAP }
  }
  const nextLane = { ...lane, visible: true, clips: [...lane.clips, clip] }
  const nextLanes = lanes.some((l) => l.laneId === lane.laneId)
    ? replaceLane(lanes, lane.laneId, nextLane)
    : [...lanes, nextLane]
  return {
    ok: true,
    laneId: lane.laneId,
    clipId: clip.clipId,
    graphState: withLanes(graphState, nextLanes),
  }
}

function updateClip(graphState, clipId, updater) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const found = findMacroAutomationClip(graphState, clipId)
  if (!found) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_CLIP }
  const { lane, clip } = found
  const result = updater(clip, lane)
  if (!result.ok) return result
  const nextLane = {
    ...lane,
    clips: lane.clips.map((c) => (c.clipId === clipId ? result.clip : c)),
  }
  return {
    ok: true,
    laneId: lane.laneId,
    clipId,
    graphState: withLanes(graphState, replaceLane(readLanes(graphState), lane.laneId, nextLane)),
  }
}

export function moveMacroAutomationClip(graphState, clipId, newStartTick) {
  return updateClip(graphState, clipId, (clip, lane) => {
    const startTick = toNonNegativeInt(newStartTick, clip.startTick)
    const candidate = { ...clip, startTick }
    if (!laneAcceptsClip(lane, candidate, clipId)) {
      return { ok: false, reason: MACRO_AUTOMATION_REJECTION.CLIP_OVERLAP }
    }
    return { ok: true, clip: candidate }
  })
}

export function resizeMacroAutomationClip(graphState, clipId, patch = {}) {
  return updateClip(graphState, clipId, (clip, lane) => {
    const startTick = patch.startTick == null
      ? clip.startTick
      : toNonNegativeInt(patch.startTick, clip.startTick)
    const lengthTicks = patch.lengthTicks == null
      ? clip.lengthTicks
      : toPositiveInt(patch.lengthTicks, clip.lengthTicks)
    const candidate = { ...clip, startTick, lengthTicks }
    if (!laneAcceptsClip(lane, candidate, clipId)) {
      return { ok: false, reason: MACRO_AUTOMATION_REJECTION.CLIP_OVERLAP }
    }
    return { ok: true, clip: candidate }
  })
}

export function toggleMacroAutomationClipLoop(graphState, clipId, loopEnabled) {
  return updateClip(graphState, clipId, (clip) => ({
    ok: true,
    clip: {
      ...clip,
      loopEnabled: typeof loopEnabled === 'boolean' ? loopEnabled : !clip.loopEnabled,
    },
  }))
}

export function deleteMacroAutomationClip(graphState, clipId) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const found = findMacroAutomationClip(graphState, clipId)
  if (!found) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_CLIP }
  const { lane } = found
  const nextLane = { ...lane, clips: lane.clips.filter((c) => c.clipId !== clipId) }
  return {
    ok: true,
    laneId: lane.laneId,
    graphState: withLanes(graphState, replaceLane(readLanes(graphState), lane.laneId, nextLane)),
  }
}

// Pastes a clip payload into a compatible lane only. The destination macroNodeId
// MUST match the source clip's lane macro (FXG.4-h copy/paste rule). Cross-macro,
// cross-track, and macro<->normal-lane pastes are rejected by the caller before
// reaching this helper; here we enforce same-macro and overlap.
export function pasteMacroAutomationClip(graphState, macroNodeId, clipPayload, options = {}) {
  const check = validateGraphStateForAutomation(graphState)
  if (!check.ok) return check
  const macroNode = findMacroNode(graphState, macroNodeId)
  if (!macroNode) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_MACRO_NODE }
  if (macroNode.type !== 'macro') return { ok: false, reason: MACRO_AUTOMATION_REJECTION.NOT_MACRO_NODE }
  if (!isPlainObject(clipPayload)) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.INVALID_CLIP }
  // A paste payload that names a different source macro is incompatible.
  if (
    typeof clipPayload.sourceMacroNodeId === 'string' &&
    clipPayload.sourceMacroNodeId !== macroNodeId
  ) {
    return { ok: false, reason: MACRO_AUTOMATION_REJECTION.INCOMPATIBLE_LANE }
  }

  const startTick = toNonNegativeInt(
    options.startTick == null ? clipPayload.startTick : options.startTick,
    0,
  )
  const clip = normalizeClip(
    {
      clipId: undefined, // a paste is always a fresh clip id
      startTick,
      lengthTicks: clipPayload.lengthTicks,
      loopEnabled: clipPayload.loopEnabled === true,
      points: clipPayload.points,
      name: clipPayload.name,
      colorToken: clipPayload.colorToken,
    },
    options.idFactory,
  )

  const { lanes, lane } = ensureLane(graphState, macroNodeId, options.idFactory)
  if (!laneAcceptsClip(lane, clip)) {
    return { ok: false, reason: MACRO_AUTOMATION_REJECTION.CLIP_OVERLAP }
  }
  const nextLane = { ...lane, visible: true, clips: [...lane.clips, clip] }
  const nextLanes = lanes.some((l) => l.laneId === lane.laneId)
    ? replaceLane(lanes, lane.laneId, nextLane)
    : [...lanes, nextLane]
  return {
    ok: true,
    laneId: lane.laneId,
    clipId: clip.clipId,
    graphState: withLanes(graphState, nextLanes),
  }
}

// Builds a copy payload from an existing clip, tagged with its source macro so a
// paste into a different macro/lane is rejected.
export function buildMacroAutomationClipCopyPayload(graphState, clipId) {
  const found = findMacroAutomationClip(graphState, clipId)
  if (!found) return null
  const { lane, clip } = found
  return {
    sourceMacroNodeId: lane.macroNodeId,
    sourceParentTrackId: graphState?.trackId == null ? '' : String(graphState.trackId),
    startTick: clip.startTick,
    lengthTicks: clip.lengthTicks,
    loopEnabled: clip.loopEnabled,
    points: clip.points.map((p) => ({ ...p })),
    name: clip.name,
    colorToken: clip.colorToken,
  }
}

// ---- point editing ----

export function addMacroAutomationPoint(graphState, clipId, pointDraft = {}) {
  return updateClip(graphState, clipId, (clip) => {
    const point = normalizePoint({
      tick: pointDraft.tick,
      value: pointDraft.value,
      curve: pointDraft.curve,
    })
    if (!point) return { ok: false, reason: MACRO_AUTOMATION_REJECTION.INVALID_POINT }
    const points = normalizePoints([...clip.points, point], clip.lengthTicks, point.value)
    return { ok: true, clip: { ...clip, points } }
  })
}

export function moveMacroAutomationPoint(graphState, clipId, pointIndex, patch = {}) {
  return updateClip(graphState, clipId, (clip) => {
    if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.points.length) {
      return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_POINT }
    }
    const current = clip.points[pointIndex]
    const next = {
      tick: patch.tick == null ? current.tick : toNonNegativeInt(patch.tick, current.tick),
      value: patch.value == null ? current.value : clamp01(patch.value, current.value),
      curve: patch.curve == null ? current.curve : normalizeSegmentCurve(patch.curve),
    }
    const others = clip.points.filter((_, i) => i !== pointIndex)
    const points = normalizePoints([...others, next], clip.lengthTicks, next.value)
    return { ok: true, clip: { ...clip, points } }
  })
}

export function deleteMacroAutomationPoint(graphState, clipId, pointIndex) {
  return updateClip(graphState, clipId, (clip) => {
    if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.points.length) {
      return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_POINT }
    }
    if (clip.points.length <= 2) {
      return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MIN_POINTS }
    }
    const points = clip.points.filter((_, i) => i !== pointIndex)
    return { ok: true, clip: { ...clip, points } }
  })
}

export function setMacroAutomationPointCurve(graphState, clipId, pointIndex, curve) {
  return updateClip(graphState, clipId, (clip) => {
    if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.points.length) {
      return { ok: false, reason: MACRO_AUTOMATION_REJECTION.MISSING_POINT }
    }
    const points = clip.points.map((p, i) =>
      i === pointIndex ? { ...p, curve: normalizeSegmentCurve(curve) } : p,
    )
    return { ok: true, clip: { ...clip, points } }
  })
}

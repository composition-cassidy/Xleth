// The viewer overlay's cell pose with the Parent chain applied
// (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5, R7, R9).
//
// Pure arithmetic, no React, no IPC. The overlay draws and hit-tests the selected
// track's cell where it is ON SCREEN: its own Roam, then every ancestor's Roam as
// a similarity about that ancestor's home centre (parentModel.composePose). A drag
// on screen maps back through the inverse chain to the child's OWN offset, scale
// and rotation, which is all the engine stores for it.
//
// An unparented track (or one whose ancestors all sit still at their homes) takes
// exactly today's arithmetic: composePose returns roamQuad bit for bit, and the
// drag maps below fall back to roamMoveOffset / roamMotionPath unchanged.

import {
  applyChain, composePose, indexTracks, lookupTrack, ownOffsetForScreenCenter, parentChain,
} from '../../motion/parentModel.js'
import { ROAM_IDENTITY, cellGeometry, roamMoveOffset } from '../../lensRoam/lensRoamModel.js'
import {
  compileRoamKeys, positionKeyTicks, resolveRoamAt, roamMotionPath,
} from '../../lensRoam/roamKeyModel.js'

/** Most points a parented motion path's line samples in total (it is recomputed while a dot drags). */
export const MAX_PATH_SAMPLES = 480

/**
 * The track index composePose reads parentTrackId from: getTracks' list, with the
 * child's own parent overridden by `childParentId` when given (getLensRoam's value,
 * the freshest after a write).
 */
export function trackIndexFor(tracks, trackId, childParentId) {
  const byId = indexTracks(tracks)
  if (Number.isInteger(childParentId) && byId.has(trackId)) {
    byId.set(trackId, { ...byId.get(trackId), parentTrackId: childParentId })
  }
  return byId
}

/** The ancestor ids of a track, nearest first (empty when it has no usable parent). */
export const chainIdsOf = (trackId, tracksById) => (trackId == null ? [] : parentChain(trackId, tracksById))

/**
 * geoOf for composePose: the cell geometry of any track in ONE layout (the overlay's
 * getGridLayout), memoized per id. A track with no cell is null (identity in a chain).
 */
export function makeGeoOf(layout, tracksById) {
  const cache = new Map()
  return (id) => {
    if (cache.has(id)) return cache.get(id)
    const g = cellGeometry(layout, lookupTrack(tracksById, id))
    cache.set(id, g)
    return g
  }
}

// An ancestor's keys compiled once per key list (React state: stable between refetches).
const compiledByKeys = new WeakMap()
function compiledOf(keys) {
  let c = compiledByKeys.get(keys)
  if (!c) { c = compileRoamKeys(keys); compiledByKeys.set(keys, c) }
  return c
}

/**
 * poseAt(tick, ownRoam) for the selected track: composePose with the ancestors'
 * { base, keys } (a Map) and the child's own resolved Roam (the overlay passes its
 * draft-aware resolveAt(tick)). null when the track has no cell.
 *
 * Each ancestor's keys are compiled ONCE here, and every call hands composePose the
 * ancestors already resolved at the tick ({ base: roam at tick, keys: [] }): the
 * motion path samples this hundreds of times per recompute (every frame of a dot
 * drag), and composePose would otherwise compile every ancestor's whole key list
 * again at every sample. The pose is the same number for number.
 */
export function makePoseResolver({ trackId, layout, tracksById, ancestors }) {
  const geoOf = makeGeoOf(layout, tracksById)
  const entries = []
  for (const [id, e] of ancestors ?? []) {
    const base = { ...ROAM_IDENTITY, ...(e?.base ?? e?.roam ?? {}) }
    const keys = e?.keys ?? []
    entries.push({ id, base, keys, compiled: keys.length ? compiledOf(keys) : null, parentTrackId: e?.parentTrackId })
  }
  const NONE = []
  const byTrackAt = (tick) => {
    const m = new Map()
    for (const a of entries) {
      m.set(a.id, {
        base: a.compiled ? resolveRoamAt(a.base, a.keys, tick, a.compiled) : a.base,
        keys: NONE,
        parentTrackId: a.parentTrackId,
      })
    }
    return m
  }
  return (tick, ownRoam) => composePose({
    trackId, tick, byTrack: byTrackAt(tick), geoOf: (id) => geoOf(id), tracksById, roam: ownRoam,
  })
}

/** Does any link of the pose's chain move the child (a non-identity ancestor)? */
export const chainMoves = (pose) => !!pose && (pose.chain ?? []).some((l) => !l.identity)

/** Does any ancestor have keys (so the carried path changes over time)? */
export function ancestorsKeyed(ancestors) {
  for (const a of ancestors?.values?.() ?? []) if ((a?.keys?.length ?? 0) > 0) return true
  return false
}

/**
 * The child's own offset after its ON-SCREEN centre moved by (du, dv) canvas-UV
 * from where `pose` puts it. A still chain is today's roamMoveOffset exactly.
 *   start  the child's own Roam at the gesture's start ({ offsetX, offsetY, ... })
 */
export function moveOffsetOnScreen(pose, geo, start, du, dv) {
  if (!chainMoves(pose)) return roamMoveOffset(start, geo, du, dv)
  return ownOffsetForScreenCenter(pose, geo, { x: pose.center.x + du, y: pose.center.y + dv })
}

/**
 * The cell's centre path, canvas-UV, ON SCREEN (5.5):
 *   dots  one per tick with an own Offset X / Y key: { tick, x, y }, carried by the
 *         chain at that tick
 *   line  the centre sampled between the breakpoints
 * Unparented (or a chain that never moves): exactly roamMotionPath, dots and line
 * mapped through the still chain. When any ancestor is keyed, the line spans every
 * tick where something moves (the child's position keys and every ancestor key):
 * before the first and after the last of them nothing moves, so this is the whole
 * path; it is drawn even when the child has no position keys of its own.
 *
 *   poseAt(tick, ownRoam)  makePoseResolver's function
 */
export function chainMotionPath({ base, keys, geo, ancestors, poseAt, parented, steps = 24, maxSamples = MAX_PATH_SAMPLES }) {
  const own = keys ?? []
  if (!geo) return { dots: [], line: [] }
  if (!parented) return roamMotionPath(base, own, geo, steps)
  const compiled = compileRoamKeys(own)
  const ownAt = (t) => resolveRoamAt(base, own, t, compiled)
  const centreAt = (t) => {
    const pose = poseAt(t, ownAt(t))
    return pose ? pose.center : null
  }
  const dots = []
  for (const t of positionKeyTicks(own)) {
    const c = centreAt(t)
    if (c) dots.push({ tick: t, x: c.x, y: c.y })
  }
  const moving = ancestorsKeyed(ancestors)
  if (!moving) {
    // A still chain: today's path, carried as a whole.
    const flat = roamMotionPath(base, own, geo, steps)
    const pose = poseAt(0, ownAt(0))
    const map = (p) => (chainMoves(pose) ? applyChain(pose, p) : p)
    return { dots: flat.dots.map((d) => ({ tick: d.tick, ...map(d) })), line: flat.line.map(map) }
  }
  const set = new Set(positionKeyTicks(own))
  for (const a of ancestors.values()) for (const k of a?.keys ?? []) if (Number.isFinite(k.pos)) set.add(Math.round(k.pos))
  const ticks = [...set].sort((a, b) => a - b)
  const line = []
  const cap = Math.max(2, Math.floor(maxSamples))
  if (ticks.length > 1 && 2 * (ticks.length - 1) + 1 > cap) {
    // More breakpoints than the cap allows two samples each: sample the whole span
    // evenly instead (`cap` points, first and last tick included).
    const t0 = ticks[0]
    const t1 = ticks[ticks.length - 1]
    for (let i = 0; i < cap; i++) {
      const c = centreAt(i === cap - 1 ? t1 : t0 + ((t1 - t0) * i) / (cap - 1))
      if (c) line.push(c)
    }
  } else if (ticks.length > 1) {
    const segs = ticks.length - 1
    // segs * n + 1 samples in all, never more than the cap.
    const n = Math.max(2, Math.min(steps, Math.floor((cap - 1) / segs)))
    for (let i = 0; i < segs; i++) {
      const a = ticks[i]
      const b = ticks[i + 1]
      for (let s = i === 0 ? 0 : 1; s <= n; s++) {
        const c = centreAt(s === n ? b : a + ((b - a) * s) / n)
        if (c) line.push(c)
      }
    }
  }
  return { dots, line }
}

/**
 * The child's own offset that puts a key dot (its centre at `tick`) at a new
 * on-screen place: the dot's start position plus (du, dv) canvas-UV, back through
 * the chain at that tick. A still chain is today's roamMoveOffset exactly.
 */
export function dotOffsetOnScreen(poseAtTick, geo, start, du, dv) {
  return moveOffsetOnScreen(poseAtTick, geo, start, du, dv)
}

/** The corners of the home box to draw dashed: the grid box, or as the parent chain carries it (R9). */
export function homeBoxOf(pose, geo) {
  if (pose && chainMoves(pose)) return pose.home
  const { x, y, w, h } = geo.home
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
}

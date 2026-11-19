// Parent: one track's cell following another track's Roam
// (docs/XLETH_MOTION_VIEW_DESIGN.md R6-R8, 2.1).
//
// Pure arithmetic, no React, no IPC: a JS port of the engine's parent
// composition (R7), used ONLY to draw and hit-test the viewer handles, to map a
// drag on a parented cell back to the child's own Roam, and to keep the Parent
// picker from offering a loop or a chain deeper than the cap. The engine stays
// the one evaluator of what renders.
//
// R7. A parent passes on ROAM only (offset, scale, rotation), as a similarity in
// output pixels about the parent's HOME centre:
//   S_A(p) = c'_A + s_A * Rot(r_A) * (p - c_A)
// c_A = centre of the parent's home rect (post-gap, without bounce), c'_A = the
// centre of its Roamed rect (roamQuad), s_A its scale, r_A its rotation
// (clockwise, y down). Nearest parent first: final = S_root o ... o S_parent o T_child.
// The child's pose: centre = S(child's Roamed centre), size = child's Roamed size
// x product of s, rotation = child's rotation + sum of r. A parent that is not
// placed at the tick contributes identity (the chain continues above it).
//
// Conventions as lensRoamModel: positions in canvas-UV (0..1 of the authoring
// canvas); rotation and scale act in canvas PIXELS so a rotated cell is never
// sheared. A dangling parent id (the track is gone) is "no parent".

import { LIMITS } from './schema.js'
import { isTrailClone } from '../clones/cloneModel.js'
import { ROAM_IDENTITY, roamQuad } from '../lensRoam/lensRoamModel.js'
import { resolveRoamAt } from '../lensRoam/roamKeyModel.js'

export const MAX_PARENT_DEPTH = LIMITS.maxParentDepth

const DEG = Math.PI / 180
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** A track (or byTrack entry) out of a Map, an array of tracks, or a plain { [id]: track } object. */
export function lookupTrack(coll, id) {
  if (!coll || id === undefined || id === null) return null
  if (coll instanceof Map) return coll.get(id) ?? null
  if (Array.isArray(coll)) return coll.find((t) => t?.id === id || t?.trackId === id) ?? null
  return coll[id] ?? null
}

/** A track's parent id, -1 for none (missing, malformed or < 0). */
export function parentIdOf(track) {
  const p = track?.parentTrackId
  return Number.isInteger(p) && p >= 0 ? p : -1
}

/** Map<id, track> from an array of tracks ({ id } or { trackId }). */
export function indexTracks(tracks) {
  const m = new Map()
  for (const t of tracks ?? []) {
    const id = t?.id ?? t?.trackId
    if (id !== undefined && id !== null) m.set(id, t)
  }
  return m
}

/**
 * The ancestors of a track, nearest first: [parentId, grandparentId, ...]. Stops
 * at no parent, a dangling id (the parent track is gone), a loop (an id already
 * in the chain, the track itself included) or after `maxDepth` ancestors.
 */
export function parentChain(trackId, tracksById, maxDepth = MAX_PARENT_DEPTH) {
  const out = []
  const seen = new Set([trackId])
  let cur = lookupTrack(tracksById, trackId)
  while (cur && out.length < maxDepth) {
    const pid = parentIdOf(cur)
    if (pid < 0 || seen.has(pid)) break
    const p = lookupTrack(tracksById, pid)
    if (!p) break
    out.push(pid)
    seen.add(pid)
    cur = p
  }
  return out
}

/** How many ancestors a track has (uncapped, loop-safe). */
export function chainDepth(trackId, tracksById) {
  return parentChain(trackId, tracksById, Infinity).length
}

/** Would making `parentId` the parent of `childId` close a loop? (itself, or a track that already follows it) */
export function wouldCycle(childId, parentId, tracksById) {
  if (!Number.isInteger(parentId) || parentId < 0) return false
  if (parentId === childId) return true
  return parentChain(parentId, tracksById, Infinity).includes(childId)
}

/** The tracks whose parent is `trackId`, in `tracks` order. */
export function childrenOf(trackId, tracks) {
  return (tracks ?? []).filter((t) => parentIdOf(t) === trackId)
}

/** How many generations follow a track (0 = no children), loop-safe. */
export function subtreeHeight(trackId, tracks) {
  const kids = new Map()
  for (const t of tracks ?? []) {
    const p = parentIdOf(t)
    if (p < 0) continue
    if (!kids.has(p)) kids.set(p, [])
    kids.get(p).push(t.id ?? t.trackId)
  }
  const walk = (id, seen) => {
    let h = 0
    for (const c of kids.get(id) ?? []) {
      if (seen.has(c)) continue
      seen.add(c)
      h = Math.max(h, 1 + walk(c, seen))
      seen.delete(c)
    }
    return h
  }
  return walk(trackId, new Set([trackId]))
}

/**
 * Every other track as a Parent candidate for `trackId` (R8):
 *   { eligible: [track], tooDeep: [track], excluded: [{ track, reason: 'self' | 'cycle' | 'trail_clone' }] }
 * in `tracks` order. A choice is too deep when the deepest track of the child's
 * subtree would have more than `maxDepth` ancestors: subtreeHeight(child) + 1 +
 * chainDepth(parent) > maxDepth. A Trail clone (docs/XLETH_CLONE_SPEC.md) has no
 * cell of its own: it is never offered as a parent, and a Trail itself has no
 * candidates (the engine rejects both with 'trail_clone'). Voice clones are
 * ordinary candidates and children.
 */
export function classifyParents(trackId, tracks, tracksById = null, { maxDepth = MAX_PARENT_DEPTH } = {}) {
  const byId = tracksById ?? indexTracks(tracks)
  const below = subtreeHeight(trackId, tracks)
  const out = { eligible: [], tooDeep: [], excluded: [] }
  const selfTrail = isTrailClone(lookupTrack(byId, trackId))
  for (const t of tracks ?? []) {
    const id = t?.id ?? t?.trackId
    if (id === trackId) { out.excluded.push({ track: t, reason: 'self' }); continue }
    if (selfTrail || isTrailClone(t)) { out.excluded.push({ track: t, reason: 'trail_clone' }); continue }
    if (wouldCycle(trackId, id, byId)) { out.excluded.push({ track: t, reason: 'cycle' }); continue }
    if (below + 1 + chainDepth(id, byId) > maxDepth) { out.tooDeep.push(t); continue }
    out.eligible.push(t)
  }
  return out
}

/** The tracks the Parent picker offers for `trackId` (R8): not itself, no loop, within the depth cap. */
export function eligibleParents(trackId, tracks, tracksById = null, opts = {}) {
  return classifyParents(trackId, tracks, tracksById, opts).eligible
}

// ── Pose composition (R7) ────────────────────────────────────────────────────

function roamOf(byTrack, id, tick) {
  const e = lookupTrack(byTrack, id)
  if (!e) return { ...ROAM_IDENTITY }
  const base = { ...ROAM_IDENTITY, ...(e.base ?? e.roam ?? {}) }
  return resolveRoamAt(base, e.keys ?? [], tick)
}

/**
 * One ancestor's similarity at a tick:
 *   { trackId, placed, identity, c, cp, s, rotRad, roam, canvasW, canvasH }
 * c / cp in canvas-UV. An ancestor that is not placed (geo null) is identity.
 */
export function parentLink(id, geo, roam) {
  if (!geo) return { trackId: id, placed: false, identity: true }
  const r = { ...ROAM_IDENTITY, ...roam }
  const q = roamQuad(r, geo)
  const { home } = geo
  // The same arithmetic roamQuad uses, with no offset: a still parent's c' == c bit for bit.
  const c = { x: home.x + home.w * 0.5, y: home.y + home.h * 0.5 }
  const s = clamp(Number.isFinite(r.scale) ? r.scale : 1, 1e-3, 1e3)
  const rotRad = q.rotRad
  const identity = s === 1 && rotRad === 0 && q.center.x === c.x && q.center.y === c.y
  return { trackId: id, placed: true, identity, c, cp: q.center, s, rotRad, roam: r, canvasW: geo.canvasW, canvasH: geo.canvasH }
}

/** A canvas-UV point through one similarity S_A. */
function applyLink(l, p) {
  const W = l.canvasW
  const H = l.canvasH
  const dx = (p.x - l.c.x) * W
  const dy = (p.y - l.c.y) * H
  const cs = Math.cos(l.rotRad)
  const sn = Math.sin(l.rotRad)
  return {
    x: l.cp.x + (l.s * (cs * dx - sn * dy)) / W,
    y: l.cp.y + (l.s * (sn * dx + cs * dy)) / H,
  }
}

/** A canvas-UV point back through one similarity: S_A^-1(q) = c + Rot(-r)(q - c') / s. */
function invertLink(l, q) {
  const W = l.canvasW
  const H = l.canvasH
  const dx = (q.x - l.cp.x) * W
  const dy = (q.y - l.cp.y) * H
  const cs = Math.cos(-l.rotRad)
  const sn = Math.sin(-l.rotRad)
  return {
    x: l.c.x + (cs * dx - sn * dy) / l.s / W,
    y: l.c.y + (sn * dx + cs * dy) / l.s / H,
  }
}

const chainOf = (poseOrChain) => (Array.isArray(poseOrChain) ? poseOrChain : poseOrChain?.chain ?? [])

/** A point in the child's own (pre-parent) canvas-UV through the chain to the screen. */
export function applyChain(poseOrChain, point) {
  let p = { x: point.x, y: point.y }
  for (const l of chainOf(poseOrChain)) if (!l.identity) p = applyLink(l, p)
  return p
}

/**
 * An on-screen canvas-UV point back to the child's own (pre-parent) canvas-UV:
 * the inverse similarities root first. A drag on a parented cell maps its pointer
 * through this before the child's own Roam maths (offsetForCenter etc.).
 */
export function inversePoint(poseOrChain, point) {
  const chain = chainOf(poseOrChain)
  let p = { x: point.x, y: point.y }
  for (let i = chain.length - 1; i >= 0; i--) if (!chain[i].identity) p = invertLink(chain[i], p)
  return p
}

/** The product of the chain's scales (1 with no parent). */
export function chainScale(poseOrChain) {
  let s = 1
  for (const l of chainOf(poseOrChain)) if (!l.identity) s *= l.s
  return s
}

/** The sum of the chain's rotations in radians, clockwise (0 with no parent). */
export function chainRotation(poseOrChain) {
  let r = 0
  for (const l of chainOf(poseOrChain)) if (!l.identity) r += l.rotRad
  return r
}

/**
 * The child's own Roam offset that puts its centre at an on-screen canvas-UV point
 * (a move drag on a parented cell): { offsetX, offsetY } in the child's unit cells.
 */
export function ownOffsetForScreenCenter(poseOrChain, geo, point) {
  const p = inversePoint(poseOrChain, point)
  return {
    offsetX: (p.x - (geo.home.x + geo.home.w * 0.5)) / geo.unit.w,
    offsetY: (p.y - (geo.home.y + geo.home.h * 0.5)) / geo.unit.h,
  }
}

/** The child's own scale for an on-screen scale (relative to its home size). */
export const ownScaleForScreenScale = (poseOrChain, screenScale) => screenScale / chainScale(poseOrChain)

/** The child's own rotation (degrees) for an on-screen rotation (degrees). */
export const ownRotationForScreenRotation = (poseOrChain, deg) => deg - chainRotation(poseOrChain) / DEG

function quadCorners(cx, cy, w, h, rotRad, W, H) {
  const c = Math.cos(rotRad)
  const s = Math.sin(rotRad)
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const px = sx * (w / 2) * W
    const py = sy * (h / 2) * H
    return { x: cx + (c * px - s * py) / W, y: cy + (s * px + c * py) / H }
  })
}

/**
 * The pose of a track's cell at a tick with its parent chain applied (R7):
 *   { rect, corners, center, rotRad,        as roamQuad, after the chain
 *     scale,                                own scale x chain scale (1 = home size)
 *     ownScale, parentScale, parentRotRad,
 *     own,                                  roamQuad of the child's own Roam (no parent)
 *     home,                                 the child's home rect corners carried by the chain
 *     chain }                               the ancestor links, nearest first (parentLink)
 * or null when the track has no cell (geoOf returns null).
 *
 *   byTrack  Map | object | array: trackId -> { base (or roam), keys, parentTrackId? }
 *   geoOf    (trackId, tick) -> cellGeometry(...) | null; the parent's home from the
 *            FULL layout at the tick (never a Landing carry / transition override)
 *   tracksById  where parentTrackId is read (defaults to byTrack)
 *   roam     the child's own resolved Roam, when the caller has one (a drag draft)
 * With no parent, or only still parents, the result equals roamQuad bit for bit.
 */
export function composePose({ trackId, tick = 0, byTrack, geoOf, tracksById = null, roam = null, maxDepth = MAX_PARENT_DEPTH }) {
  const geo = geoOf?.(trackId, tick)
  if (!geo) return null
  const ownRoam = roam ? { ...ROAM_IDENTITY, ...roam } : roamOf(byTrack, trackId, tick)
  const own = roamQuad(ownRoam, geo)
  const ownScale = clamp(Number.isFinite(ownRoam.scale) ? ownRoam.scale : 1, 1e-3, 1e3)
  const ids = parentChain(trackId, tracksById ?? byTrack, maxDepth)
  const chain = ids.map((id) => parentLink(id, geoOf(id, tick), roamOf(byTrack, id, tick)))
  const homeRect = [
    { x: geo.home.x, y: geo.home.y }, { x: geo.home.x + geo.home.w, y: geo.home.y },
    { x: geo.home.x + geo.home.w, y: geo.home.y + geo.home.h }, { x: geo.home.x, y: geo.home.y + geo.home.h },
  ]
  const moved = chain.some((l) => !l.identity)
  if (!moved) {
    return {
      rect: own.rect, corners: own.corners, center: own.center, rotRad: own.rotRad,
      scale: ownScale, ownScale, parentScale: 1, parentRotRad: 0, own, home: homeRect, chain,
    }
  }
  const W = geo.canvasW
  const H = geo.canvasH
  const parentScale = chainScale(chain)
  const parentRotRad = chainRotation(chain)
  const center = applyChain(chain, own.center)
  const w = own.rect.w * parentScale
  const h = own.rect.h * parentScale
  const rotRad = own.rotRad + parentRotRad
  return {
    rect: { x: center.x - w / 2, y: center.y - h / 2, w, h },
    corners: quadCorners(center.x, center.y, w, h, rotRad, W, H),
    center,
    rotRad,
    scale: ownScale * parentScale,
    ownScale,
    parentScale,
    parentRotRad,
    own,
    home: homeRect.map((p) => applyChain(chain, p)),
    chain,
  }
}

/** Is a canvas-UV point inside a composed pose's (possibly rotated) cell? */
export function poseContains(pose, geo, u, v) {
  if (!pose) return false
  const dx = (u - pose.center.x) * geo.canvasW
  const dy = (v - pose.center.y) * geo.canvasH
  const c = Math.cos(-pose.rotRad)
  const s = Math.sin(-pose.rotRad)
  const lx = c * dx - s * dy
  const ly = s * dx + c * dy
  return Math.abs(lx) <= (pose.rect.w * geo.canvasW) / 2 && Math.abs(ly) <= (pose.rect.h * geo.canvasH) / 2
}

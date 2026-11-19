// Motion view row registry (docs/XLETH_MOTION_VIEW_DESIGN.md 5.1, 5.3, R24).
//
// Each property group registers a PROVIDER; the view owns layout, scroll, zoom,
// selection, snapping and the graph toggle, and never names a property itself.
// Adding a group = one provider in PROVIDERS. Pure: no React, no IPC.
//
// ── Provider interface ────────────────────────────────────────────────────────
//   id                              'lens' | 'trail' | 'roam' | 'mask' | 'sweep'
//   groups(track, data) -> GroupNode[]   the groups it adds under a track, in order
//   keys(row, data) -> KeyInstance[]     a property row's keys, sorted by tick
//   valueAt(row, data, tick) -> value    the live value (null = nothing to show)
//   isAnimated(row, data, tick) -> bool  the key toggle's state (R3)
//   editBlocker(row, data, tick, intent) -> string | null
//                                        why 'value' | 'stopwatch' | 'key' cannot act now
//   stopwatchPlan(row, data, tick, on)   R3 (OFF also sets the base in the same plan)
//   valuePlan(row, data, tick, value)    R4 (animated: key at the playhead; else the base)
//   addKeyPlan(row, data, tick)          a key at the playhead holding the curve's value
//   removeKeyPlan(row, data, tick)       the key at the playhead removed
//   hint(row) -> { hint, mods }
// A plan is a list of motionPlan.js writes, run by runMotionPlan as ONE undo step.
//
//   GroupNode = { key, groupId, label, hint, provider, target, count?, children: (GroupNode | PropNode)[] }
//   PropNode  = { key, prop (schema property), provider, target }
//
// ── Key instances and keyId formats (providers/common.js) ─────────────────────
//   { id, rowKey, tick, value, interp, bez?, hollow, outside?, ref, key }
//   r:<trackId>:<channel>:<pos>                         Roam key        ref { kind:'roam', trackId, channel, pos }
//   s:<trackId>:<channel>:<pos>                         Sweep key       ref { kind:'sweep', trackId, channel, pos }
//   c:<clipId>:<channel>:<pos>                          clip Lens key   ref { kind:'clipLens', trackId, clipId, channel, pos }
//   h:<trackId>:<regionId>:<channel>:<anchor>:<pos>@<noteStart>   hit-curve key drawn under one note (hollow)
//                                                       ref { kind:'hit', trackId, regionId, channel, anchor, pos, patternId, noteId, noteStart, noteEnd }
//   n:<patternId>:<noteId>:<channel>:<anchor>:<pos>@<noteStart>   a note's own key (filled)
//                                                       ref { kind:'note', ..., patternId, noteId, mode }
//   m:<trackId>:<maskId>:<channel>:<pos>                Mask scalar key ref { kind:'mask', trackId, maskId, channel, pos }
//   ms:<trackId>:<maskId>:<pos>                         Mask shape key  ref { kind:'maskShape', trackId, maskId, pos }
//   to:<trackId>:<pos>                                  Trail opacity key ref { kind:'trailOpacity', trackId, channel:'opacity', pos }
//   f:<trackId>:<uid>:<param>:<pos>                     Video effect param key ref { kind:'fx', trackId, channel:'<uid>:<param>', uid, param, type, pos }
// refTarget(ref) gives the EDIT identity (one hit key drawn under many notes is one target).
//
// ── Rows ──────────────────────────────────────────────────────────────────────
//   { key, kind: 'track' | 'group' | 'prop', trackId, track, trackIndex, depth, y, height,
//     label, hint, provider?, target?, prop?, groupId?, expandable, expanded, node, parentKey }
// Track rows are `trackRowHeight` tall (28 default, per view); group and property
// rows are 24 px (the interactive floor). Indent 14 px per depth. A Clone's track
// row sits one level in (depth 1) under its source, its rows one level deeper.
// A group with no rows (a Linked Voice clone's "Lens · linked to ...") is a
// read-only line: not expandable.

import { lensProvider } from './providers/lensProvider.js'
import { roamProvider } from './providers/roamProvider.js'
import { sweepProvider } from './providers/sweepProvider.js'
import { maskProvider } from './providers/maskProvider.js'
import { trailProvider } from './providers/trailProvider.js'
import { fxProvider } from './providers/fxProvider.js'
import { SAME_TICK } from './providers/common.js'
import { isClone } from '../clones/cloneModel.js'

export const MOTION_ROW_HEIGHT = 24
export const MOTION_INDENT = 14
/** Order per track: Lens, Trail (Trail clones), Roam (Masks inside it), Sweep. */
export const PROVIDERS = Object.freeze([lensProvider, trailProvider, roamProvider, sweepProvider, fxProvider])
export const PROVIDER_BY_ID = Object.freeze({
  lens: lensProvider, trail: trailProvider, roam: roamProvider, mask: maskProvider, sweep: sweepProvider, fx: fxProvider,
})

export const trackRowKey = (trackId) => `t:${trackId}`

/** The tree of one track: { key, kind: 'track', trackId, track, children }. */
export function trackTree(track, data, providers = PROVIDERS) {
  const children = []
  for (const p of providers) children.push(...p.groups(track, data))
  return { key: trackRowKey(track.id), kind: 'track', trackId: track.id, track, label: track.name ?? `Track ${track.id}`, children }
}

const isGroup = (n) => Array.isArray(n.children)

/**
 * The visible rows of Motion view: every track row, and under an expanded node
 * its children. `tracks` in display order.
 * @returns {{ rows, totalHeight, byKey: Map, nodes: Map, tops: Float64Array, trees: Map }}
 */
export function buildMotionRows({ tracks, data, expanded, trackRowHeight = 28, providers = PROVIDERS } = {}) {
  const rows = []
  const byKey = new Map()
  const nodes = new Map()
  const trees = new Map()
  const exp = expanded ?? new Set()
  let y = 0
  const index = new Map((data?.tracks ?? []).map((t, i) => [t.id, i]))

  const visit = (node, depth, track, parentKey, visible) => {
    nodes.set(node.key, { node, depth, trackId: track.id, parentKey })
    const group = isGroup(node)
    const expandable = group && (node.kind === 'track' || node.children.length > 0)
    const open = expandable && exp.has(node.key)
    if (visible) {
      const isTrack = node.kind === 'track'
      const row = {
        key: node.key,
        kind: isTrack ? 'track' : group ? 'group' : 'prop',
        trackId: track.id,
        track,
        trackIndex: index.get(track.id) ?? 0,
        depth,
        y,
        height: isTrack ? trackRowHeight : MOTION_ROW_HEIGHT,
        label: isTrack ? node.label : group ? node.label : node.prop.label,
        hint: node.hint ?? null,
        provider: node.provider ?? null,
        target: node.target ?? null,
        prop: node.prop ?? null,
        groupId: node.groupId ?? null,
        count: node.count,
        expandable,
        expanded: open,
        node,
        parentKey,
      }
      rows.push(row)
      byKey.set(row.key, row)
      y += row.height
    }
    if (group) for (const c of node.children) visit(c, depth + 1, track, node.key, visible && open)
  }

  for (const track of tracks ?? []) {
    const tree = trackTree(track, data, providers)
    trees.set(track.id, tree)
    visit(tree, isClone(track) ? 1 : 0, track, null, true)
  }
  const tops = new Float64Array(rows.length)
  for (let i = 0; i < rows.length; i++) tops[i] = rows[i].y
  return { rows, totalHeight: y, byKey, nodes, tops, trees }
}

/** Index of the row containing content-y `y` (clamped to the rows), or -1 when there are none. */
export function rowIndexAtY(layout, y) {
  const n = layout?.rows?.length ?? 0
  if (n === 0) return -1
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (layout.tops[mid] <= y) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, Math.min(n - 1, lo - 1))
}

/** The row under content-y `y`, or null past the last row. */
export function rowAtY(layout, y) {
  if (!(y >= 0) || y >= (layout?.totalHeight ?? 0)) return null
  const i = rowIndexAtY(layout, y)
  return i >= 0 ? layout.rows[i] : null
}

/** [first, end) indices of the rows that intersect content-y [top, top + height). */
export function visibleRowRange(layout, top, height) {
  const n = layout?.rows?.length ?? 0
  if (n === 0) return [0, 0]
  const first = rowIndexAtY(layout, Math.max(0, top))
  let end = first
  const bottom = top + height
  while (end < n && layout.tops[end] < bottom) end++
  return [first, Math.max(first, end)]
}

// ── Keys per row (cached per data object) ─────────────────────────────────────

const keyCache = new WeakMap()     // data -> Map<rowKey, KeyInstance[]>
const tickCache = new WeakMap()    // data -> Map<rowKey, Float64Array>
const summaryCache = new WeakMap() // data -> Map<nodeKey, Float64Array>

function cacheOf(store, data) {
  let m = store.get(data)
  if (!m) { m = new Map(); store.set(data, m) }
  return m
}

const NONE = Object.freeze([])
const NO_TICKS = new Float64Array(0)

/** A property row's (or prop node's) key instances, sorted by tick; built once per data object. */
export function rowKeys(row, data) {
  if (!row?.prop || !row.provider || !data) return NONE
  const cache = cacheOf(keyCache, data)
  let list = cache.get(row.key)
  if (!list) {
    list = row.provider.keys({ ...row, trackId: row.trackId ?? row.node?.trackId }, data) ?? NONE
    cache.set(row.key, list)
  }
  return list
}

/** The ticks of rowKeys(row) as a Float64Array (binary search when culling). */
export function rowKeyTicks(row, data) {
  if (!row?.prop || !data) return NO_TICKS
  const cache = cacheOf(tickCache, data)
  let ticks = cache.get(row.key)
  if (!ticks) {
    const list = rowKeys(row, data)
    ticks = new Float64Array(list.length)
    for (let i = 0; i < list.length; i++) ticks[i] = list[i].tick
    cache.set(row.key, ticks)
  }
  return ticks
}

/** Every property node under a node (itself when it is one). */
export function propNodesUnder(node, out = []) {
  if (!node) return out
  if (Array.isArray(node.children)) for (const c of node.children) propNodesUnder(c, out)
  else if (node.prop) out.push(node)
  return out
}

/**
 * The summary a collapsed track or group row draws (5.3): the ticks of every key
 * below it, ascending, one per half tick. Built once per data object.
 */
export function summaryTicks(row, data, trackId = row?.trackId) {
  if (!row?.node || !data) return NO_TICKS
  const cache = cacheOf(summaryCache, data)
  let out = cache.get(row.key)
  if (out) return out
  const all = []
  for (const pn of propNodesUnder(row.node)) {
    const pr = { key: pn.key, prop: pn.prop, provider: pn.provider, target: pn.target, trackId, node: pn }
    for (const k of rowKeys(pr, data)) if (!k.outside) all.push(k.tick)
  }
  all.sort((a, b) => a - b)
  const uniq = []
  for (const t of all) if (uniq.length === 0 || t - uniq[uniq.length - 1] >= SAME_TICK) uniq.push(t)
  out = Float64Array.from(uniq)
  cache.set(row.key, out)
  return out
}

/** [first, end) of sorted ticks inside [t0, t1]. */
export function tickRange(ticks, t0, t1) {
  const n = ticks.length
  let lo = 0
  let hi = n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ticks[mid] < t0) lo = mid + 1; else hi = mid }
  const first = lo
  hi = n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ticks[mid] <= t1) lo = mid + 1; else hi = mid }
  return [first, lo]
}

/** The edit identity of a key ref: one hit-curve key drawn under many notes is ONE target. */
export function refTarget(ref) {
  if (!ref) return ''
  switch (ref.kind) {
    case 'roam': return `roam:${ref.trackId}:${ref.channel}:${ref.pos}`
    case 'sweep': return `sweep:${ref.trackId}:${ref.channel}:${ref.pos}`
    case 'clipLens': return `clip:${ref.clipId}:${ref.channel}:${ref.pos}`
    case 'hit': return `hit:${ref.trackId}:${ref.regionId}:${ref.channel}:${ref.anchor}:${ref.pos}`
    case 'note': return `note:${ref.patternId}:${ref.noteId}:${ref.channel}:${ref.anchor}:${ref.pos}`
    case 'mask': return `mask:${ref.trackId}:${ref.maskId}:${ref.channel}:${ref.pos}`
    case 'maskShape': return `shape:${ref.trackId}:${ref.maskId}:${ref.pos}`
    case 'trailOpacity': return `trailOpacity:${ref.trackId}:${ref.pos}`
    case 'fx': return `fx:${ref.trackId}:${ref.channel}:${ref.pos}`
    default: return JSON.stringify(ref)
  }
}

/** Every key instance of every EXPANDED property row (Ctrl+A, R20). */
export function keysInExpandedRows(layout, data) {
  const out = []
  for (const row of layout?.rows ?? []) {
    if (row.kind !== 'prop') continue
    for (const k of rowKeys(row, data)) out.push(k)
  }
  return out
}

// ── Reveal ('xleth-motion-reveal', 5.2) ───────────────────────────────────────

/**
 * The row key a reveal path names, and every row to expand so it shows.
 *   path ['roam'], ['lens'], ['sweep'], ['roam', 'masks'], ['mask:3'], ['roam', 'roam.scale'], ...
 * A Lens path on a track with several sources opens the first one.
 * @returns {{ rowKey, expand: string[] } | null}
 */
export function revealTarget(layout, trackId, path = []) {
  const t = trackRowKey(trackId)
  const tree = layout?.trees?.get(trackId)
  if (!tree) return null
  const segs = (Array.isArray(path) ? path : [path]).filter((s) => typeof s === 'string' && s.length > 0)
  if (segs.length === 0) return { rowKey: t, expand: [] }
  let key = `${t}/${segs.join('/')}`
  if (!layout.nodes.has(key) && segs[0] === 'lens') {
    const lens = tree.children.find((g) => g.groupId === 'lens')
    if (lens) key = [lens.key, ...segs.slice(1)].join('/')
  }
  if (!layout.nodes.has(key) && segs[0] === 'masks') key = `${t}/roam/masks${segs.length > 1 ? `/${segs.slice(1).join('/')}` : ''}`
  if (!layout.nodes.has(key)) {
    // The nearest existing ancestor.
    const parts = key.split('/')
    while (parts.length > 1 && !layout.nodes.has(parts.join('/'))) parts.pop()
    key = parts.join('/')
  }
  const expand = []
  let cur = layout.nodes.get(key)
  let parentKey = cur?.parentKey ?? null
  while (parentKey) {
    expand.unshift(parentKey)
    parentKey = layout.nodes.get(parentKey)?.parentKey ?? null
  }
  // A group itself opens too (revealing 'roam' shows its rows).
  if (cur && Array.isArray(cur.node.children)) expand.push(key)
  return { rowKey: key, expand }
}

export default buildMotionRows

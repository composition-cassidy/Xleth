// Pure geometry for the routing band: which cables exist and where they run.
// No DOM, no canvas, no store: RoutingBand feeds this the store's own routing
// data and draws the result. Nothing here is invented; every cable is one entry
// of outputRoutes or sidechainRoutes.

import { MASTER_OUTPUT_TARGET_ID, normalizeOutputTargetId } from '../../stores/mixerStore.js'

export const CABLE_H = 20           // height of the band, px
export const DOT_Y = 3              // where a strip's output dot sits
export const MASTER_RAIL_Y = 17     // the shared run to the Master dock
export const LANE_YS = [7, 10, 13]  // track-to-track runs, nearest first
export const SIDECHAIN_DX = 4       // sidechain cables leave and enter beside the output stub
export const MASTER = 'master'

/**
 * Cables for the strips in `orderedIds` (left to right).
 * - output: one per routed track; `to` is a strip index or MASTER.
 * - sidechain: one per enabled, healthy route whose two tracks both have a strip.
 * Routes pointing at a missing track are skipped, never drawn to nowhere.
 */
export function computeCables({ orderedIds, outputRoutes = {}, sidechainRoutes = [] }) {
  const indexOf = new Map(orderedIds.map((id, i) => [Number(id), i]))
  const cables = []

  orderedIds.forEach((id, from) => {
    const target = normalizeOutputTargetId(outputRoutes[id])
    if (target === MASTER_OUTPUT_TARGET_ID) {
      cables.push({ kind: 'output', from, to: MASTER })
    } else if (indexOf.has(target) && indexOf.get(target) !== from) {
      cables.push({ kind: 'output', from, to: indexOf.get(target) })
    }
  })

  for (const route of sidechainRoutes) {
    if (!route || route.enabled === false || (route.status && route.status !== 'ok')) continue
    const from = indexOf.get(Number(route.sourceTrackId))
    const to = indexOf.get(Number(route.targetTrackId))
    if (from == null || to == null || from === to) continue
    cables.push({ kind: 'sidechain', from, to, routeId: route.routeId })
  }

  assignLanes(cables)
  return cables
}

/** Track-to-track cables on the nearest lane where their span overlaps no other cable's. */
export function assignLanes(cables) {
  const laneSpans = LANE_YS.map(() => [])
  const spanOf = (c) => [Math.min(c.from, c.to) - 0.4, Math.max(c.from, c.to) + 0.4]
  const trackCables = cables
    .filter((c) => c.to !== MASTER)
    .sort((a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to))
  for (const cable of trackCables) {
    const [lo, hi] = spanOf(cable)
    let lane = laneSpans.findIndex((spans) => spans.every(([a, b]) => hi < a || lo > b))
    if (lane === -1) lane = LANE_YS.length - 1
    laneSpans[lane].push([lo, hi])
    cable.lane = lane
  }
  return cables
}

/** x of a strip's centre; sidechain cables sit SIDECHAIN_DX to the right of it. */
export function cableX(index, stripW, kind = 'output') {
  return index * stripW + stripW / 2 + (kind === 'sidechain' ? SIDECHAIN_DX : 0)
}

/** The run to Master: from the leftmost master-bound strip to the lane's right end. */
export function masterRail(cables, stripW, width) {
  const bound = cables.filter((c) => c.kind === 'output' && c.to === MASTER)
  if (bound.length === 0) return null
  const x0 = Math.min(...bound.map((c) => cableX(c.from, stripW)))
  return { x0, x1: width, stubs: bound.map((c) => cableX(c.from, stripW)) }
}

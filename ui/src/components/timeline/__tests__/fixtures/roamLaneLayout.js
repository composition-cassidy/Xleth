// Test fixture: the row layout the Roam / Sweep key-lane modules read
// (roamLaneModel.hitTestRoamLane / keysInMarquee, roamLaneDrawing.drawRoamLanes).
//
// The Edit view no longer builds Roam or Sweep rows (docs/XLETH_MOTION_VIEW_DESIGN.md
// R17): buildTrackLayout ignores the old lane inputs. The pure lane modules stay, for
// Motion view, which hands them its own rows. This fixture builds such rows with the
// geometry the lanes always had, so the modules' numbers stay pinned: per track, the
// track row, then an optional Reel row, the Sweep row, the Roam row.

import { TRACK_HEIGHT } from '../../../../constants/timeline.js'
import { reelLaneHeight } from '../../reelLaneModel.js'
import { roamLaneHeight } from '../../roamLaneModel.js'

/**
 * @param {object} args
 * @param {{id:number}[]} args.tracks
 * @param {number} [args.trackHeight]
 * @param {Record<number, {subRows?:number, collapsed?:boolean}>} [args.reel]  Reel rows per track id
 * @param {number[]} [args.roam]   track ids with a Roam row
 * @param {number[]} [args.sweep]  track ids with a Sweep row
 */
export function laneLayout({ tracks, trackHeight = TRACK_HEIGHT, reel = {}, roam = [], sweep = [] }) {
  const rows = []
  let y = 0
  tracks.forEach((track, trackIndex) => {
    rows.push({
      id: `track:${track.id}`, rowType: 'track', laneKind: 'track',
      trackId: track.id, trackIndex, parentTrackId: null, y, height: trackHeight, visible: true,
    })
    y += trackHeight
    const r = reel[track.id]
    if (r) {
      const subRows = Math.max(1, r.subRows | 0)
      const height = reelLaneHeight({ subRows, collapsed: r.collapsed === true, trackHeight })
      rows.push({
        id: `reel:${track.id}`, rowType: 'reel', laneKind: 'reel', trackId: null, trackIndex: null,
        parentTrackId: track.id, parentTrackIndex: trackIndex, y, height, trackHeight, visible: true,
        collapsed: r.collapsed === true, subRows,
      })
      y += height
    }
    for (const [kind, ids, label] of [['sweep', sweep, 'Sweep'], ['roam', roam, 'Roam']]) {
      if (!ids.includes(track.id)) continue
      const height = roamLaneHeight(trackHeight)
      rows.push({
        id: `${kind}:${track.id}`, rowType: kind, laneKind: kind, trackId: null, trackIndex: null,
        parentTrackId: track.id, parentTrackIndex: trackIndex, y, height, trackHeight, visible: true, label,
      })
      y += height
    }
  })
  const of = (type) => rows.filter((r) => r.rowType === type)
  const rowAtY = (list) => (py) => list.find((r) => py >= r.y && py < r.y + r.height) ?? null
  const roamRows = of('roam')
  const sweepRows = of('sweep')
  const reelRows = of('reel')
  return {
    rows,
    totalHeight: y,
    getRoamRows: () => roamRows,
    roamRowAtY: rowAtY(roamRows),
    getSweepRows: () => sweepRows,
    sweepRowAtY: rowAtY(sweepRows),
    getReelRows: () => reelRows,
    reelRowAtY: rowAtY(reelRows),
  }
}

// FXG.4-h-r1 — Derived flattened timeline row model.
//
// The timeline historically assumed a contiguous stack of equal-height track
// rows addressed by `trackIndex * TRACK_HEIGHT`. Real macro automation child
// lanes break that assumption: a track may own one or more macro automation
// lanes that must render in their OWN vertical space directly below the parent
// track, pushing every later track down.
//
// This module derives, from `tracks` + per-track `graphStates`, a flattened row
// list:
//   [
//     { rowType: 'track',           trackId, trackIndex, y, height, ... },
//     { rowType: 'macroAutomation', parentTrackId, parentTrackIndex,
//                                    macroNodeId, laneId, y, height, ... },
//     ...
//   ]
//
// and a `trackLayout` view that the canvas draw path, hit-testing, drag/resize
// math, and the left header all consult so geometry stays in one place. The
// helper is PURE: no React, no store, no DOM. Parent-track rows keep the exact
// TRACK_HEIGHT they always had — child rows only INSERT extra space, so the
// arrangement of audio/pattern clips is unchanged when a track has no lanes.

import { DEFAULT_TRACK_HEIGHT, TRACK_HEIGHT } from '../../constants/timeline.js'

// Child macro automation lanes are shorter than full tracks — enough vertical
// room for a clip body + a small curve preview, but visibly subordinate to the
// parent track row.
export const MACRO_LANE_HEIGHT = 36

function readLanes(graphState) {
  return Array.isArray(graphState?.macroAutomationLanes) ? graphState.macroAutomationLanes : []
}

// Compose the compact child-lane label, e.g. "Macro 1 Automation". The macro
// node's own label ("Macro 1") is the source of truth; we never invent numbers.
export function macroLaneLabel(macroNode) {
  const raw = (macroNode?.label ?? macroNode?.data?.label ?? '').toString().trim()
  const base = raw.length > 0 ? raw : 'Macro'
  return `${base} Automation`
}

// Builds the flattened row model. `collapsed` is an optional Set of trackIds
// whose child lanes are hidden as a group (collapse affordance). A lane is also
// hidden when its own `visible` flag is false. Orphaned lanes (targetUnavailable)
// still render so the user can see/repair them — they are never silently dropped.
export function buildTimelineRows({
  tracks,
  graphStates = {},
  collapsed = null,
  trackHeight = TRACK_HEIGHT,
  macroLaneHeight = Math.round(MACRO_LANE_HEIGHT * trackHeight / DEFAULT_TRACK_HEIGHT),
} = {}) {
  const rows = []
  if (!Array.isArray(tracks)) return rows
  const collapsedSet = collapsed instanceof Set ? collapsed : null

  let y = 0
  tracks.forEach((track, trackIndex) => {
    const trackId = track?.id
    rows.push({
      id: `track:${trackId}`,
      rowType: 'track',
      laneKind: 'track',
      trackId,
      trackIndex,
      parentTrackId: null,
      macroNodeId: null,
      laneId: null,
      y,
      height: trackHeight,
      visible: true,
      label: track?.name ?? '',
    })
    y += trackHeight

    const trackCollapsed = collapsedSet?.has(trackId)
    if (trackCollapsed) return

    const graphState = graphStates?.[String(trackId)]
    const lanes = readLanes(graphState)
    for (const lane of lanes) {
      if (!lane || lane.visible === false) continue
      const macroNode = graphState?.nodes?.find((n) => n.id === lane.macroNodeId) ?? null
      rows.push({
        id: `macro:${trackId}:${lane.laneId}`,
        rowType: 'macroAutomation',
        laneKind: 'macroAutomation',
        trackId: null,
        trackIndex: null,
        parentTrackId: trackId,
        parentTrackIndex: trackIndex,
        macroNodeId: lane.macroNodeId,
        laneId: lane.laneId,
        y,
        height: macroLaneHeight,
        visible: true,
        targetUnavailable: lane.targetUnavailable === true,
        label: macroLaneLabel(macroNode),
      })
      y += macroLaneHeight
    }
  })

  return rows
}

// Derives a layout "view" over the rows that the canvas + tools consult. Keeps
// the `trackIndex → y` and `y → trackIndex` conversions in one place so the
// shifted geometry is identical everywhere.
export function buildTrackLayout({ tracks, graphStates = {}, collapsed = null, trackHeight = TRACK_HEIGHT } = {}) {
  const rows = buildTimelineRows({ tracks, graphStates, collapsed, trackHeight })
  const trackRows = rows.filter((r) => r.rowType === 'track')
  const macroRows = rows.filter((r) => r.rowType === 'macroAutomation')
  const trackCount = trackRows.length

  // y top per track index.
  const trackTops = new Array(trackCount)
  for (const r of trackRows) trackTops[r.trackIndex] = r.y

  const totalHeight = rows.length > 0
    ? rows[rows.length - 1].y + rows[rows.length - 1].height
    : 0

  function trackTop(trackIndex) {
    if (trackIndex == null || trackIndex < 0) return 0
    const t = trackTops[trackIndex]
    return Number.isFinite(t) ? t : trackIndex * trackHeight
  }

  // Maps a canvas-space Y to the owning track index. A Y inside a macro lane
  // band resolves to that lane's PARENT track (so e.g. dropping an audio clip
  // while hovering a lane lands on the parent track — child lanes never host
  // normal clips). Out-of-range Y clamps to the first/last track.
  function trackIndexAtY(y) {
    if (trackCount === 0) return -1
    if (y < 0) return 0
    for (const r of rows) {
      if (y >= r.y && y < r.y + r.height) {
        return r.rowType === 'track' ? r.trackIndex : r.parentTrackIndex
      }
    }
    return trackCount - 1
  }

  // Returns the macro automation row whose band contains Y, else null.
  function macroRowAtY(y) {
    for (const r of macroRows) {
      if (y >= r.y && y < r.y + r.height) return r
    }
    return null
  }

  return {
    rows,
    trackRows,
    macroRows,
    trackCount,
    totalHeight,
    trackTops,
    trackTop,
    trackIndexAtY,
    macroRowAtY,
    getMacroRows: () => macroRows,
  }
}

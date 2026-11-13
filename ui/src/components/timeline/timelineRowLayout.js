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
import { reelLaneHeight } from './reelLaneModel.js'

// Child macro automation lanes are shorter than full tracks — enough vertical
// room for a clip body + a small curve preview, but visibly subordinate to the
// parent track row.
// Heights at DEFAULT_TRACK_HEIGHT (36); child lanes scale with the track height.
// Rescaled with the 50 -> 36 default (Phase 3): 36 -> 26 and 32 -> 24 keep the
// same proportion to the track row. The folder row is fixed at the 28px panel-
// header height.
export const MACRO_LANE_HEIGHT = 26
export const FOLDER_ROW_HEIGHT = 28

// Automation clips (Phase B) — lanes grouped under their owning track (or the
// pinned Master group, ownerTrackId -1), collapsible as a whole group. Shorter
// than a full track row like macro lanes, but with their own header row so the
// group can collapse independent of the lanes inside it.
export const AUTOMATION_LANE_HEIGHT = 24
export const AUTOMATION_GROUP_HEADER_HEIGHT = 24

function readLanes(graphState) {
  return Array.isArray(graphState?.macroAutomationLanes) ? graphState.macroAutomationLanes : []
}

// `automationGroups` is a plain object keyed by String(ownerTrackId) — "-1" for
// the pinned Master group — each value `{ collapsed?: bool, lanes: [{ id,
// index, label? }] }`. Lanes render in ascending `index` order (topmost =
// lowest index, per the AutomationLane model). Absent/empty entries render
// nothing — a group only appears once at least one lane exists for its owner.
function readAutomationGroup(automationGroups, ownerKey) {
  const group = automationGroups?.[ownerKey]
  const lanes = Array.isArray(group?.lanes) ? group.lanes : []
  if (lanes.length === 0) return null
  return { collapsed: group.collapsed === true, lanes: [...lanes].sort((a, b) => a.index - b.index) }
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
// Pushes an automation group header row (and, unless collapsed, its lane rows)
// for one owner. Returns the advanced `y`. Shared by the pinned Master group
// (pushed once, before any track) and each track's own group (pushed inside
// appendTrack). No-ops (returns `y` unchanged) when the owner has no lanes.
function pushAutomationGroupRows(rows, { ownerTrackId, ownerLabel, y, automationGroups, laneHeight, headerHeight }) {
  const group = readAutomationGroup(automationGroups, String(ownerTrackId))
  if (!group) return y
  rows.push({
    id: `automationGroup:${ownerTrackId}`,
    rowType: 'automationGroupHeader',
    laneKind: 'automationGroupHeader',
    ownerTrackId,
    y,
    height: headerHeight,
    visible: true,
    collapsed: group.collapsed,
    laneCount: group.lanes.length,
    label: ownerLabel,
  })
  y += headerHeight
  if (group.collapsed) return y
  for (const lane of group.lanes) {
    rows.push({
      id: `automationLane:${ownerTrackId}:${lane.id}`,
      rowType: 'automationLane',
      laneKind: 'automationLane',
      ownerTrackId,
      laneId: lane.id,
      index: lane.index,
      y,
      height: laneHeight,
      visible: true,
      label: lane.label ?? null,
    })
    y += laneHeight
  }
  return y
}

export function buildTimelineRows({
  tracks,
  graphStates = {},
  collapsed = null,
  folderLayout = null,
  trackHeight = TRACK_HEIGHT,
  macroLaneHeight = Math.round(MACRO_LANE_HEIGHT * trackHeight / DEFAULT_TRACK_HEIGHT),
  folderRowHeight = FOLDER_ROW_HEIGHT,
  automationGroups = null,
  automationLaneHeight = Math.round(AUTOMATION_LANE_HEIGHT * trackHeight / DEFAULT_TRACK_HEIGHT),
  automationGroupHeaderHeight = AUTOMATION_GROUP_HEADER_HEIGHT,
  reelLanes = null,
} = {}) {
  const rows = []
  if (!Array.isArray(tracks)) return rows
  const collapsedSet = collapsed instanceof Set ? collapsed : null

  let y = 0
  let visibleTrackIndex = 0
  const trackById = new Map(tracks.map(track => [track.id, track]))
  const folderById = new Map((folderLayout?.folders ?? []).map(folder => [folder.id, folder]))

  // Pinned Master automation group — always the very first row(s), above every
  // track, when at least one Master-owned lane exists.
  y = pushAutomationGroupRows(rows, {
    ownerTrackId: -1, ownerLabel: 'Master', y, automationGroups,
    laneHeight: automationLaneHeight, headerHeight: automationGroupHeaderHeight,
  })

  const appendTrack = (track) => {
    const trackIndex = visibleTrackIndex++
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

    // Reel lane (Pattern tracks that have video): the first child row, directly
    // under the track. Its height follows the track's deepest note overlap, up to
    // three sub-rows, then compresses; collapsed it is a thin strip.
    const reel = reelLanes?.[String(trackId)]
    if (reel) {
      const reelCollapsed = reel.collapsed === true
      const subRows = Math.max(1, reel.subRows | 0)
      const reelHeight = reelLaneHeight({ subRows, collapsed: reelCollapsed, trackHeight })
      rows.push({
        id: `reel:${trackId}`,
        rowType: 'reel',
        laneKind: 'reel',
        trackId: null,
        trackIndex: null,
        parentTrackId: trackId,
        parentTrackIndex: trackIndex,
        y,
        height: reelHeight,
        trackHeight,
        visible: true,
        collapsed: reelCollapsed,
        subRows,
        label: 'Reel',
      })
      y += reelHeight
    }

    // Automation lanes group directly under their owning track row.
    y = pushAutomationGroupRows(rows, {
      ownerTrackId: trackId, ownerLabel: track?.name ?? '', y, automationGroups,
      laneHeight: automationLaneHeight, headerHeight: automationGroupHeaderHeight,
    })

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
  }

  const rootOrder = Array.isArray(folderLayout?.rootOrder)
    ? folderLayout.rootOrder
    : tracks.map(track => ({ kind: 'track', id: track.id }))
  for (const item of rootOrder) {
    if (item.kind === 'track') {
      const track = trackById.get(item.id)
      if (track) appendTrack(track)
      continue
    }
    const folder = folderById.get(item.id)
    if (!folder) continue
    rows.push({
      id: `folder:${folder.id}`,
      rowType: 'folder',
      laneKind: 'folder',
      folderId: folder.id,
      label: folder.name,
      collapsed: folder.collapsed === true,
      memberCount: folder.trackIds.length,
      y,
      height: folderRowHeight,
      visible: true,
    })
    y += folderRowHeight
    if (folder.collapsed) continue
    for (const trackId of folder.trackIds) {
      const track = trackById.get(trackId)
      if (track) appendTrack(track)
    }
  }

  return rows
}

// Derives a layout "view" over the rows that the canvas + tools consult. Keeps
// the `trackIndex → y` and `y → trackIndex` conversions in one place so the
// shifted geometry is identical everywhere.
export function buildTrackLayout({
  tracks, graphStates = {}, collapsed = null, folderLayout = null, trackHeight = TRACK_HEIGHT,
  automationGroups = null, reelLanes = null,
} = {}) {
  const rows = buildTimelineRows({ tracks, graphStates, collapsed, folderLayout, trackHeight, automationGroups, reelLanes })
  const trackRows = rows.filter((r) => r.rowType === 'track')
  const macroRows = rows.filter((r) => r.rowType === 'macroAutomation')
  const reelRows = rows.filter((r) => r.rowType === 'reel')
  const folderRows = rows.filter((r) => r.rowType === 'folder')
  const automationGroupRows = rows.filter((r) => r.rowType === 'automationGroupHeader')
  const automationLaneRows = rows.filter((r) => r.rowType === 'automationLane')
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
  //
  // The Reel lane resolves to -1, like the automation lanes: it is read-only, so
  // no tool may act on the parent track's blocks through it (a click that fell
  // through to the parent would select or drag a block the pointer is not over).
  function trackIndexAtY(y) {
    if (trackCount === 0) return -1
    if (y < 0) return 0
    for (const r of rows) {
      if (y >= r.y && y < r.y + r.height) {
        if (r.rowType === 'folder' || r.rowType === 'automationGroupHeader' || r.rowType === 'automationLane' || r.rowType === 'reel') return -1
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

  // Returns the Reel lane row whose band contains Y, else null.
  function reelRowAtY(y) {
    for (const r of reelRows) {
      if (y >= r.y && y < r.y + r.height) return r
    }
    return null
  }

  // Returns the automation lane row whose band contains Y, else null. Used by
  // automation clip hit-testing/drag — clips live on a specific lane, not a
  // parent track, so this is looked up independently of trackIndexAtY.
  function automationLaneRowAtY(y) {
    for (const r of automationLaneRows) {
      if (y >= r.y && y < r.y + r.height) return r
    }
    return null
  }

  return {
    rows,
    trackRows,
    macroRows,
    reelRows,
    folderRows,
    automationGroupRows,
    automationLaneRows,
    trackCount,
    totalHeight,
    trackTops,
    trackTop,
    trackIndexAtY,
    macroRowAtY,
    reelRowAtY,
    getReelRows: () => reelRows,
    automationLaneRowAtY,
    folderRowAtY: (y) => folderRows.find(r => y >= r.y && y < r.y + r.height) ?? null,
    automationGroupRowAtY: (y) => automationGroupRows.find(r => y >= r.y && y < r.y + r.height) ?? null,
    getMacroRows: () => macroRows,
    getFolderRows: () => folderRows,
    getAutomationGroupRows: () => automationGroupRows,
    getAutomationLaneRows: () => automationLaneRows,
  }
}

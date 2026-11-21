import { describe, expect, it } from 'vitest'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import {
  MACRO_LANE_HEIGHT,
  FOLDER_ROW_HEIGHT,
  AUTOMATION_GROUP_HEADER_HEIGHT,
  AUTOMATION_LANE_HEIGHT,
  macroLaneLabel,
  buildTimelineRows,
  buildTrackLayout,
} from './timelineRowLayout.js'
import { reelLaneHeight } from './reelLaneModel.js'

// Build a graphState for a track with the given macro lanes. `lanes` is an array
// of { macroNodeId, label, visible?, targetUnavailable?, clips? }.
function graphStateWithLanes(trackId, lanes) {
  return {
    trackId,
    nodes: lanes.map((l) => ({ id: l.macroNodeId, type: 'macro', label: l.label })),
    macroAutomationLanes: lanes.map((l) => ({
      laneId: `lane-${l.macroNodeId}`,
      macroNodeId: l.macroNodeId,
      target: 'normalizedValue',
      visible: l.visible !== false,
      targetUnavailable: l.targetUnavailable === true,
      clips: l.clips ?? [],
    })),
  }
}

const tracks = [
  { id: 't1', name: 'Track 1' },
  { id: 't2', name: 'Track 2' },
  { id: 't3', name: 'Track 3' },
]

describe('macroLaneLabel', () => {
  it('appends " Automation" to the macro node label', () => {
    expect(macroLaneLabel({ label: 'Macro 1' })).toBe('Macro 1 Automation')
  })
  it('falls back to "Macro" when no label exists', () => {
    expect(macroLaneLabel(null)).toBe('Macro Automation')
    expect(macroLaneLabel({})).toBe('Macro Automation')
  })
})

describe('buildTimelineRows', () => {
  it('scales track and macro-lane rows with a custom vertical zoom height', () => {
    const tracks = [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }]
    const graphStates = {
      t1: {
        nodes: [{ id: 'm1', label: 'Macro 1' }],
        macroAutomationLanes: [{ laneId: 'l1', macroNodeId: 'm1' }],
      },
    }
    const layout = buildTrackLayout({ tracks, graphStates, trackHeight: 100 })

    expect(layout.trackRows.map(row => row.height)).toEqual([100, 100])
    expect(layout.macroRows[0].height).toBe(72)
    expect(layout.trackTop(1)).toBe(172)
    expect(layout.totalHeight).toBe(272)
  })

  it('produces exactly one row for a track with no macro lanes', () => {
    const rows = buildTimelineRows({ tracks: [tracks[0]], graphStates: {} })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rowType: 'track', trackId: 't1', trackIndex: 0, y: 0, height: TRACK_HEIGHT })
  })

  it('produces one track row plus two child rows for a track with two visible lanes', () => {
    const graphStates = {
      t1: graphStateWithLanes('t1', [
        { macroNodeId: 'm1', label: 'Macro 1' },
        { macroNodeId: 'm2', label: 'Macro 2' },
      ]),
    }
    const rows = buildTimelineRows({ tracks: [tracks[0]], graphStates })
    expect(rows.map((r) => r.rowType)).toEqual(['track', 'macroAutomation', 'macroAutomation'])
    expect(rows[1]).toMatchObject({
      rowType: 'macroAutomation', parentTrackId: 't1', parentTrackIndex: 0,
      macroNodeId: 'm1', laneId: 'lane-m1', label: 'Macro 1 Automation',
    })
    expect(rows[2]).toMatchObject({ macroNodeId: 'm2', label: 'Macro 2 Automation' })
  })

  it('does not render a hidden (visible:false) macro lane', () => {
    const graphStates = {
      t1: graphStateWithLanes('t1', [
        { macroNodeId: 'm1', label: 'Macro 1', visible: false },
        { macroNodeId: 'm2', label: 'Macro 2' },
      ]),
    }
    const rows = buildTimelineRows({ tracks: [tracks[0]], graphStates })
    expect(rows.map((r) => r.macroNodeId)).toEqual([null, 'm2'])
  })

  it('keeps child rows immediately under their parent track row', () => {
    const graphStates = {
      t1: graphStateWithLanes('t1', [{ macroNodeId: 'm1', label: 'Macro 1' }]),
      t2: graphStateWithLanes('t2', [{ macroNodeId: 'm2', label: 'Macro 2' }]),
    }
    const rows = buildTimelineRows({ tracks, graphStates })
    // track1, macro(t1), track2, macro(t2), track3
    expect(rows.map((r) => r.id)).toEqual([
      'track:t1', 'macro:t1:lane-m1', 'track:t2', 'macro:t2:lane-m2', 'track:t3',
    ])
  })

  it('produces deterministic, gap-free y/height', () => {
    const graphStates = {
      t1: graphStateWithLanes('t1', [
        { macroNodeId: 'm1', label: 'Macro 1' },
        { macroNodeId: 'm2', label: 'Macro 2' },
      ]),
    }
    const rows = buildTimelineRows({ tracks, graphStates })
    expect(rows.map((r) => r.y)).toEqual([
      0,                                            // track1
      TRACK_HEIGHT,                                 // macro m1
      TRACK_HEIGHT + MACRO_LANE_HEIGHT,             // macro m2
      TRACK_HEIGHT + 2 * MACRO_LANE_HEIGHT,         // track2
      2 * TRACK_HEIGHT + 2 * MACRO_LANE_HEIGHT,     // track3
    ])
  })

  it('treats old projects without macroAutomationLanes as normal track rows', () => {
    const graphStates = { t1: { trackId: 't1', nodes: [] } } // no macroAutomationLanes field
    const rows = buildTimelineRows({ tracks, graphStates })
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.rowType === 'track')).toBe(true)
  })

  it('still renders an orphaned (targetUnavailable) lane, flagged', () => {
    const graphStates = {
      t1: graphStateWithLanes('t1', [{ macroNodeId: 'm1', label: 'Macro 1', targetUnavailable: true }]),
    }
    const rows = buildTimelineRows({ tracks: [tracks[0]], graphStates })
    expect(rows[1]).toMatchObject({ rowType: 'macroAutomation', targetUnavailable: true })
  })

  it('hides all child lanes for a collapsed track', () => {
    const graphStates = {
      t1: graphStateWithLanes('t1', [{ macroNodeId: 'm1', label: 'Macro 1' }]),
    }
    const rows = buildTimelineRows({ tracks: [tracks[0]], graphStates, collapsed: new Set(['t1']) })
    expect(rows).toHaveLength(1)
    expect(rows[0].rowType).toBe('track')
  })
})

describe('buildTrackLayout', () => {
  const graphStates = {
    t1: graphStateWithLanes('t1', [
      { macroNodeId: 'm1', label: 'Macro 1' },
      { macroNodeId: 'm2', label: 'Macro 2' },
    ]),
  }

  it('total height includes child rows', () => {
    const layout = buildTrackLayout({ tracks, graphStates })
    // 3 tracks + 2 lanes
    expect(layout.totalHeight).toBe(3 * TRACK_HEIGHT + 2 * MACRO_LANE_HEIGHT)
  })

  it('reports shifted track tops', () => {
    const layout = buildTrackLayout({ tracks, graphStates })
    expect(layout.trackTop(0)).toBe(0)
    expect(layout.trackTop(1)).toBe(TRACK_HEIGHT + 2 * MACRO_LANE_HEIGHT)
    expect(layout.trackTop(2)).toBe(2 * TRACK_HEIGHT + 2 * MACRO_LANE_HEIGHT)
  })

  it('maps a Y inside a macro lane band to the parent track index', () => {
    const layout = buildTrackLayout({ tracks, graphStates })
    // The first lane band sits at [TRACK_HEIGHT, TRACK_HEIGHT+MACRO_LANE_HEIGHT)
    const yInLane = TRACK_HEIGHT + 2
    expect(layout.trackIndexAtY(yInLane)).toBe(0)
    expect(layout.macroRowAtY(yInLane)).toMatchObject({ macroNodeId: 'm1' })
  })

  it('maps a Y inside a track band to that track index and clamps out-of-range', () => {
    const layout = buildTrackLayout({ tracks, graphStates })
    expect(layout.trackIndexAtY(2)).toBe(0)
    expect(layout.trackIndexAtY(layout.trackTop(1) + 5)).toBe(1)
    expect(layout.trackIndexAtY(-50)).toBe(0)
    expect(layout.trackIndexAtY(99999)).toBe(2)
  })

  it('falls back to contiguous geometry when no lanes exist', () => {
    const layout = buildTrackLayout({ tracks, graphStates: {} })
    expect(layout.totalHeight).toBe(3 * TRACK_HEIGHT)
    expect(layout.trackTop(2)).toBe(2 * TRACK_HEIGHT)
    expect(layout.getMacroRows()).toHaveLength(0)
  })

  it('inserts folder rows, rejects folder hit-testing, and hides collapsed members and lanes', () => {
    const expandedFolderLayout = {
      rootOrder: [
        { kind: 'folder', id: 'f1' },
        { kind: 'track', id: 't3' },
      ],
      folders: [{ id: 'f1', name: 'Folder 1', collapsed: false, trackIds: ['t1', 't2'] }],
    }
    const expanded = buildTrackLayout({ tracks, graphStates, folderLayout: expandedFolderLayout })
    expect(expanded.rows[0]).toMatchObject({ rowType: 'folder', folderId: 'f1', height: FOLDER_ROW_HEIGHT })
    expect(expanded.trackTop(0)).toBe(FOLDER_ROW_HEIGHT)
    expect(expanded.trackIndexAtY(4)).toBe(-1)
    expect(expanded.folderRowAtY(4)).toMatchObject({ folderId: 'f1' })

    const collapsed = buildTrackLayout({
      tracks,
      graphStates,
      folderLayout: {
        ...expandedFolderLayout,
        folders: [{ ...expandedFolderLayout.folders[0], collapsed: true }],
      },
    })
    expect(collapsed.rows.map(row => row.rowType)).toEqual(['folder', 'track'])
    expect(collapsed.trackRows[0].trackId).toBe('t3')
    expect(collapsed.getMacroRows()).toHaveLength(0)
  })
})

// docs/XLETH_MOTION_VIEW_DESIGN.md R17: motion keys are edited in Motion view, so the Edit
// view has no Roam or Sweep key lane. A caller that still passes the old lane inputs gets
// exactly the rows of one that does not, and every remaining row keeps its place and height.
describe('R17: the Edit view has no Roam or Sweep lanes', () => {
  const numTracks = [
    { id: 1, name: 'Lead', type: 'Pattern' },
    { id: 2, name: 'Drums', type: 'Clip' },
    { id: 3, name: 'Bass', type: 'Pattern' },
  ]
  const OLD_LANES = { roamLanes: { 1: true, 2: true, 3: true }, sweepLanes: { 1: true, 3: true } }

  it('ignores the old roamLanes / sweepLanes inputs: the same rows and total height', () => {
    const plain = buildTrackLayout({ tracks: numTracks })
    const old = buildTrackLayout({ tracks: numTracks, ...OLD_LANES })
    expect(old.rows).toEqual(plain.rows)
    expect(old.totalHeight).toBe(3 * TRACK_HEIGHT)
    expect(old.rows.some((r) => r.rowType === 'roam' || r.rowType === 'sweep')).toBe(false)
    expect(buildTimelineRows({ tracks: numTracks, ...OLD_LANES })).toEqual(buildTimelineRows({ tracks: numTracks }))
  })

  it('exposes no Roam / Sweep rows or accessors', () => {
    const layout = buildTrackLayout({ tracks: numTracks, ...OLD_LANES })
    for (const name of ['roamRows', 'sweepRows', 'getRoamRows', 'getSweepRows', 'roamRowAtY', 'sweepRowAtY']) {
      expect(layout[name]).toBeUndefined()
    }
    // What stays: the track, Reel, macro, folder and automation accessors.
    for (const name of ['trackIndexAtY', 'trackTop', 'reelRowAtY', 'getReelRows', 'macroRowAtY', 'folderRowAtY',
      'automationLaneRowAtY', 'automationGroupRowAtY', 'getAutomationLaneRows']) {
      expect(typeof layout[name]).toBe('function')
    }
  })

  it('the band under a track where a lane used to sit belongs to the next track again', () => {
    const layout = buildTrackLayout({ tracks: numTracks, ...OLD_LANES })
    expect(layout.trackTop(1)).toBe(TRACK_HEIGHT)
    expect(layout.trackTop(2)).toBe(2 * TRACK_HEIGHT)
    expect(layout.trackIndexAtY(TRACK_HEIGHT - 1)).toBe(0)
    expect(layout.trackIndexAtY(TRACK_HEIGHT + 2)).toBe(1)
    expect(layout.trackIndexAtY(2 * TRACK_HEIGHT + 2)).toBe(2)
  })

  it('every remaining child row keeps its order, height and hit-testing; the stack is gap-free', () => {
    const graphStates = { 1: graphStateWithLanes(1, [{ macroNodeId: 'm1', label: 'Macro 1' }]) }
    const automationGroups = { 1: { collapsed: false, lanes: [{ id: 5, index: 0, label: 'Drive' }] } }
    const args = { tracks: numTracks, graphStates, automationGroups, reelLanes: { 1: { subRows: 2 } } }
    const plain = buildTrackLayout(args)
    const layout = buildTrackLayout({ ...args, ...OLD_LANES })
    expect(layout.rows).toEqual(plain.rows)
    expect(layout.rows.map((r) => r.rowType)).toEqual([
      'track', 'reel', 'automationGroupHeader', 'automationLane', 'macroAutomation', 'track', 'track',
    ])
    const [t1, reel, group, autoLane, macro, t2] = layout.rows
    expect(reel.y).toBe(t1.y + TRACK_HEIGHT)
    expect(reel.height).toBe(reelLaneHeight({ subRows: 2 }))
    expect(group.y).toBe(reel.y + reel.height)
    expect(group.height).toBe(AUTOMATION_GROUP_HEADER_HEIGHT)
    expect(autoLane.height).toBe(AUTOMATION_LANE_HEIGHT)
    expect(macro.height).toBe(MACRO_LANE_HEIGHT)
    expect(t2.y).toBe(macro.y + macro.height)
    for (let i = 1; i < layout.rows.length; i++) {
      expect(layout.rows[i].y).toBe(layout.rows[i - 1].y + layout.rows[i - 1].height)
    }
    expect(layout.totalHeight).toBe(t2.y + 2 * TRACK_HEIGHT)
    // Read-only child rows resolve to no track; a macro lane to its parent track.
    expect(layout.trackIndexAtY(reel.y + 2)).toBe(-1)
    expect(layout.trackIndexAtY(group.y + 2)).toBe(-1)
    expect(layout.trackIndexAtY(autoLane.y + 2)).toBe(-1)
    expect(layout.trackIndexAtY(macro.y + 2)).toBe(0)
    expect(layout.trackIndexAtY(t2.y + 2)).toBe(1)
    expect(layout.reelRowAtY(reel.y + 2)).toBe(reel)
  })

  it('holds at every track height and with folders', () => {
    const folderLayout = {
      rootOrder: [{ kind: 'folder', id: 'f1' }, { kind: 'track', id: 3 }],
      folders: [{ id: 'f1', name: 'Drums', collapsed: false, trackIds: [1, 2] }],
    }
    for (const trackHeight of [24, 36, 60, 120]) {
      const plain = buildTrackLayout({ tracks: numTracks, trackHeight, folderLayout, reelLanes: { 3: { subRows: 1 } } })
      const old = buildTrackLayout({ tracks: numTracks, trackHeight, folderLayout, reelLanes: { 3: { subRows: 1 } }, ...OLD_LANES })
      expect(old.rows).toEqual(plain.rows)
      expect(old.totalHeight).toBe(FOLDER_ROW_HEIGHT + 3 * trackHeight + reelLaneHeight({ subRows: 1, trackHeight }))
    }
  })
})

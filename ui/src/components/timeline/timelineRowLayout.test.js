import { describe, expect, it } from 'vitest'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import {
  MACRO_LANE_HEIGHT,
  macroLaneLabel,
  buildTimelineRows,
  buildTrackLayout,
} from './timelineRowLayout.js'

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
})

// @vitest-environment jsdom
// The Sweep lane is the Roam lane's modules over the Lens channels. The Edit view no
// longer has a Sweep lane (docs/XLETH_MOTION_VIEW_DESIGN.md R17; see
// timelineRowLayout.test.js); the modules stay for Motion view. Rows from a fixture with
// the lanes' geometry.
import { describe, expect, it, vi } from 'vitest'
import { laneLayout } from './__tests__/fixtures/roamLaneLayout.js'
import { drawRoamLanes } from './roamLaneDrawing.js'
import { beginRoamLaneGesture } from './roamLaneGesture.js'
import { hitTestRoamLane, keyPixel, laneRangeFor, roamLaneHeight } from './roamLaneModel.js'
import { TRACK_HEIGHT } from '../../constants/timeline.js'

const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })
const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern' },
  { id: 2, name: 'Drums', type: 'Pattern' },
]
const SCROLL = 0
const PPB = 40

describe('Sweep lane row geometry (P11)', () => {
  it('a Sweep row (fixture) sits under the Reel row, ahead of the Roam row, roamLaneHeight tall', () => {
    const layout = laneLayout({ tracks, reel: { 1: { subRows: 1 } }, roam: [1], sweep: [1] })
    expect(layout.rows.map((r) => r.rowType)).toEqual(['track', 'reel', 'sweep', 'roam', 'track'])
    const sweep = layout.getSweepRows()[0]
    const reel = layout.getReelRows()[0]
    expect(sweep.y).toBe(reel.y + reel.height)
    expect(sweep.height).toBe(roamLaneHeight(TRACK_HEIGHT))
    expect(sweep.parentTrackId).toBe(1)
    expect(layout.getRoamRows()[0].y).toBe(sweep.y + sweep.height)
  })

  it('each kind owns its own band: a Sweep point is not a Roam row', () => {
    const layout = laneLayout({ tracks, sweep: [1] })
    const sweep = layout.getSweepRows()[0]
    expect(layout.sweepRowAtY(sweep.y + 2)).toBe(sweep)
    expect(layout.roamRowAtY(sweep.y + 2)).toBeNull()
    expect(layout.sweepRowAtY(sweep.y - 1)).toBeNull()
    expect(layout.sweepRowAtY(sweep.y + sweep.height)).toBeNull()
  })
})

describe('hit test over the Sweep rows', () => {
  const layout = laneLayout({ tracks, roam: [1], sweep: [1] })
  const row = layout.getSweepRows()[0]
  const roamRow = layout.getRoamRows()[0]
  const KEYS = [K('zoom', 0, 1), K('zoom', 1920, 1.5), K('centerX', 960, 0.1)]
  const dataOf = () => ({ base: {}, keys: KEYS })
  const hit = (x, y, channel = 'zoom', kind = 'sweep') =>
    hitTestRoamLane({ trackLayout: layout, dataOf, channelOf: () => channel, kind }, x, y, SCROLL, PPB)

  it('answers only for its own rows: a Sweep point is not a Roam point, and the other way round', () => {
    expect(hit(50, row.y + 5)).not.toBeNull()
    expect(hit(50, roamRow.y + 5, 'zoom', 'sweep')).toBeNull()
    expect(hit(50, row.y + 5, 'offsetX', 'roam')).toBeNull()
    expect(hit(50, roamRow.y + 5, 'offsetX', 'roam')).not.toBeNull()
  })

  it('finds a key of the lane channel under the pointer, and a blank point reads a tick and a value', () => {
    const range = laneRangeFor('zoom', KEYS, {})
    const p = keyPixel(KEYS[1], row, range, SCROLL, PPB)
    expect(hit(p.x, p.y).key).toBe(KEYS[1])
    expect(hit(p.x, p.y, 'centerX').key).toBeNull()       // not this lane's channel
    const empty = hit(p.x + 60, row.y + 6)
    expect(empty.key).toBeNull()
    expect(empty.channel).toBe('zoom')
    expect(empty.value).toBeGreaterThan(1)               // near the top of a log lane around 1
  })
})

describe('the shared gesture drives a Sweep lane: local preview, ONE commit', () => {
  it('a click on an empty lane adds one zoom key and commits the whole list once', () => {
    const layout = laneLayout({ tracks, sweep: [1] })
    const row = layout.getSweepRows()[0]
    const hit = hitTestRoamLane(
      { trackLayout: layout, dataOf: () => ({ base: {}, keys: [] }), channelOf: () => 'zoom', kind: 'sweep' },
      200, row.y + 8, SCROLL, PPB,
    )
    const setDraft = vi.fn()
    const commit = vi.fn(async () => ({ changed: true }))
    const select = vi.fn()
    const down = new MouseEvent('mousedown', { clientX: 200, clientY: row.y + 8 })
    beginRoamLaneGesture({
      event: down, hit, data: { base: {}, keys: [] },
      view: () => ({ scrollOffset: SCROLL, ppb: PPB }),
      localOf: (e) => ({ localX: e.clientX, localY: e.clientY }),
      granularity: () => 'off',
      setDraft, clearDraft: vi.fn(), commit, select,
    })
    expect(commit).not.toHaveBeenCalled()                 // nothing leaves while the pointer is down
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 200, clientY: row.y + 8 }))
    expect(commit).toHaveBeenCalledTimes(1)
    const sent = commit.mock.calls[0][0]
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ channel: 'zoom', anchor: 'Origin' })
    expect(sent[0].value).toBeGreaterThan(1)              // the top of the lane is a zoom above 1
  })
})

describe('painter', () => {
  const makeView = (layout) => {
    const calls = { fillText: [], stroke: 0 }
    const ctx = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'measureText') return () => ({ width: 10 })
        if (prop === 'fillText') return (t) => { calls.fillText.push(t) }
        if (prop === 'stroke') return () => { calls.stroke += 1 }
        return () => {}
      },
      set() { return true },
    })
    return {
      calls,
      view: {
        ctx, w: 800, h: 600, scrollOffset: SCROLL, ppb: PPB, trackLayout: layout,
        palette: { ink: '#fff', inkDark: '#000', select: '#0af', roamAxis: '#444', roamLine: '#888', roamLabel: '#999' },
        trackColorById: { 1: '#f80' }, mutedTrackIds: new Set(),
      },
    }
  }

  it('paints the Sweep rows only when asked for them, and says what an empty Sweep does', () => {
    const layout = laneLayout({ tracks, sweep: [1] })
    const roamOnly = makeView(layout)
    drawRoamLanes(roamOnly.view, { dataOf: () => ({ base: {}, keys: [] }), channelOf: () => 'offsetX', selected: null })
    expect(roamOnly.calls.fillText).toEqual([])           // no Roam rows: nothing painted

    const sweep = makeView(layout)
    drawRoamLanes(sweep.view, { kind: 'sweep', dataOf: () => ({ base: {}, keys: [] }), channelOf: () => 'zoom', selected: null })
    expect(sweep.calls.fillText.some((t) => /Sweep changes nothing until it has keys/.test(t))).toBe(true)
  })

  it('draws a keyed Sweep lane: the axis labels in the lane\'s own units and the curve stroked', () => {
    const layout = laneLayout({ tracks, sweep: [1] })
    const v = makeView(layout)
    drawRoamLanes(v.view, {
      kind: 'sweep',
      dataOf: () => ({ base: {}, keys: [K('zoom', 0, 1), K('zoom', 1920, 1.5)] }),
      channelOf: () => 'zoom',
      selected: { trackId: 1, channel: 'zoom', pos: 1920 },
    })
    expect(v.calls.fillText.some((t) => t.startsWith('×'))).toBe(true)      // "x2.00" axis labels
    expect(v.calls.fillText).toContain('1.50 ×')                          // the selected key's chip
    expect(v.calls.stroke).toBeGreaterThan(2)
  })
})

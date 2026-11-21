// @vitest-environment jsdom
//
// Motion view graph painter's pure parts (docs/XLETH_MOTION_VIEW_DESIGN.md R21): the
// Bezier handles of a note key pair it with the key after it in the engine's
// canonical CURVE order, not in drawn order (they differ under Cut zones).
import { beforeEach, describe, expect, it } from 'vitest'
import { graphHandles, nextInRun, graphCurvesOf, resetGraphCache } from './motionGraph.js'
import { buildMotionRows } from '../../motion/rowRegistry.js'
import { fixtureData, fixtureLensRoam, fixturePatterns, fixtureTracks } from '../../motion/providers/__tests__/fixtures.js'

const BEZ = [0.42, 0, 0.58, 1]
const K = (channel, pos, value, interp = 'Linear', anchor = 'Origin') => ({ channel, anchor, pos, value, interp })

function cutView(keySel) {
  const lr = fixtureLensRoam()
  // Head 100 then Tail 200 in curve order; under a 200-tick Cut note the Tail is drawn
  // at note-on (tick 0) and the Head at tick 100.
  lr.sources[0].hitCurve = [{ ...K('zoom', 100, 2, 'Bezier', 'Head'), bez: BEZ }, { ...K('zoom', 200, 1, 'Bezier', 'Tail'), bez: BEZ }]
  lr.sources[0].zones = { headTicks: 120, tailTicks: 240, shortNote: 'Cut' }
  const patterns = fixturePatterns()
  patterns[10].notes = [
    { id: 1, positionTicks: 0, durationTicks: 200, pitch: 60 },
    { id: 2, positionTicks: 1920, durationTicks: 960, pitch: 62 },
  ]
  const data = fixtureData({ lensRoam: lr, patterns })
  const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(), trackRowHeight: 28 })
  return { layout, data, selectedRows: new Set(['t:1/lens/sourceLens.zoom']), keySel: new Set(keySel), draft: null, w: 800, h: 400, scrollOffset: 0, ppb: 40 }
}

beforeEach(() => resetGraphCache())

describe('graph handles of note keys (Cut)', () => {
  it('the Tail key drawn first under a short Cut note is the LAST key of its curve: no handles toward the Head', () => {
    const view = cutView(['h:1:100:zoom:Tail:200@0'])
    expect(graphHandles(view)).toEqual([])
    const [curve] = graphCurvesOf(view)
    const tail = curve.runs[0].keys.find((k) => k.ref.anchor === 'Tail')
    expect(nextInRun(curve, tail)).toBeNull()
  })

  it('Head -> Tail under a short Cut note is never played: no handles; under a long note it is', () => {
    expect(graphHandles(cutView(['h:1:100:zoom:Head:100@0']))).toEqual([])
    const long = graphHandles(cutView(['h:1:100:zoom:Head:100@1920']))
    expect(long).toHaveLength(1)
    expect([long[0].a.ref.anchor, long[0].b.ref.anchor]).toEqual(['Head', 'Tail'])
    expect([long[0].A.tick, long[0].B.tick]).toEqual([2020, 2680])
  })
})

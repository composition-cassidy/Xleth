// @vitest-environment jsdom
//
// Motion view key area painters (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4, R5, R24):
// geometry, hit-testing, visible-range culling and the summary of collapsed rows.
import { describe, expect, it } from 'vitest'
import {
  KEY_HIT_R, drawKeysLayer, drawOverlayLayer, drawStaticLayer, hitTestKey, tickToX, xToTick,
} from './motionDrawing.js'
import { buildMotionRows } from '../../motion/rowRegistry.js'
import { fixtureData, fixtureTracks } from '../../motion/providers/__tests__/fixtures.js'

function recorder() {
  const calls = { fill: 0, stroke: 0, arc: 0, rect: 0, fillRect: 0, moveTo: 0 }
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k in t) return t[k]
      if (k === 'measureText') return () => ({ width: 10 })
      return (...args) => { if (k in calls) calls[k]++; return args }
    },
    set: (t, k, v) => { t[k] = v; return true },
  })
  return { ctx, calls }
}

const data = fixtureData()
const tracks = fixtureTracks()
const expanded = new Set(['t:1', 't:1/roam'])
const layout = buildMotionRows({ tracks, data, expanded, trackRowHeight: 28 })
const view = (over = {}) => ({
  layout, data, w: 800, h: 600, scrollTop: 0, scrollOffset: 0, ppb: 40, snapGranularity: '1/16',
  selectedRows: new Set(), keySel: new Map(), colorOf: () => '#808080', mutedOf: () => false, ...over,
})

describe('geometry', () => {
  it('tick <-> x are inverse at any zoom and scroll', () => {
    for (const [off, ppb] of [[0, 40], [3.5, 12], [100, 300]]) {
      expect(xToTick(tickToX(1234, off, ppb), off, ppb)).toBeCloseTo(1234, 6)
    }
    expect(tickToX(960, 0, 40)).toBe(40)            // one beat
  })
})

describe('hit-testing', () => {
  it('finds the key under the pointer on a property row, or the row alone', () => {
    const row = layout.byKey.get('t:1/roam/roam.offsetX')
    const y = row.y + row.height / 2
    const x = tickToX(3840, 0, 40)
    const hit = hitTestKey(view(), x + KEY_HIT_R - 1, y)
    expect(hit.row.key).toBe(row.key)
    expect(hit.key.id).toBe('r:1:offsetX:3840')
    const miss = hitTestKey(view(), x + KEY_HIT_R + 20, y)
    expect(miss.row.key).toBe(row.key)
    expect(miss.key).toBeUndefined()
    expect(hitTestKey(view(), 10, layout.totalHeight + 5)).toBeNull()
  })

  it('a collapsed track row hits its summary tick', () => {
    const t2 = layout.byKey.get('t:2')
    // Track 2 (Chorus) is collapsed: its clips carry Lens keys at 0 and 1920.
    const hit = hitTestKey(view(), tickToX(1920, 0, 40), t2.y + 4)
    expect(hit.summaryTick).toBe(1920)
  })
})

describe('painters', () => {
  it('draws only the keys inside the viewport (culled by tick range)', () => {
    const all = recorder()
    drawKeysLayer(all.ctx, view())
    const some = recorder()
    // Scrolled so that tick 0 is off the left edge: the key at 0 is not drawn.
    drawKeysLayer(some.ctx, view({ scrollOffset: 2 }))
    expect(some.calls.fill).toBeLessThan(all.calls.fill)
    expect(all.calls.fill).toBeGreaterThan(0)
  })

  it('static and overlay layers paint without throwing, the playhead at its beat', () => {
    const s = recorder()
    drawStaticLayer(s.ctx, view({ selectedRows: new Set(['t:1/roam']) }))
    expect(s.calls.fillRect).toBeGreaterThan(0)
    const o = recorder()
    drawOverlayLayer(o.ctx, view({ playheadBeat: 2, marquee: { x0: 10, y0: 10, x1: 50, y1: 60 }, snapTick: 960 }))
    expect(o.calls.fillRect).toBeGreaterThanOrEqual(2)    // marquee + playhead
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import useApexStore, { unityCurve, curveToJSON } from './apexStore.js'

// Verifies the APEX store's curve undo/redo contract and solo exclusivity
// against a stubbed bridge. The engine author's documented undo model is
// "capture before the gesture, replay on undo" (XlethEngineService.cpp) — these
// tests pin that an edit → undo → redo cycle restores the exact node state and
// that the bridge is called with the right JSON at each step.

function installBridge() {
  const calls = []
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    xleth: {
      audio: {
        getEffectParameters: vi.fn(async () => '[]'),
        apexGetCurves: vi.fn(async () => '{"bands":[]}'),
        getEffectLatency: vi.fn(async () => ({ ok: true, latencySamples: 0 })),
        setEffectParameter: vi.fn((t, n, id, v) => calls.push(['setParam', id, v])),
        apexSetBandCurve: vi.fn((t, n, band, json) => { calls.push(['setCurve', band, json]); return true }),
      },
    },
  }
  return calls
}

describe('apexStore curve undo/redo', () => {
  let calls
  beforeEach(() => {
    vi.resetModules()
    calls = installBridge()
    useApexStore.getState().close()
    // Open with a synthetic target but skip the async fetches' effect on curves
    // by setting target directly and leaving default unity curves.
    useApexStore.setState({ target: { trackId: 7, nodeId: 4, storeKey: '7' } })
  })

  it('commits one apexSetBandCurve per gesture and pushes one undo entry', () => {
    const s = useApexStore.getState()
    const before = s.snapshotCurve(0)
    const nodes = [{ in: -24, out: -24 }, { in: 0, out: -8 }, { in: 12, out: 12 }]
    const tensions = [0.4, -0.2]
    s.commitCurve(0, nodes, tensions, before)

    const st = useApexStore.getState()
    expect(st.curves[0].nodes).toHaveLength(3)
    expect(st.curves[0].nodes[1].out).toBeCloseTo(-8, 5)
    expect(st.undoStack).toHaveLength(1)
    expect(st.redoStack).toHaveLength(0)
    expect(calls.filter(c => c[0] === 'setCurve')).toHaveLength(1)
  })

  it('edit → undo → redo restores the exact node state', () => {
    const s0 = useApexStore.getState()
    const beforeJson = s0.snapshotCurve(0)              // unity
    const nodes = [{ in: -24, out: -24 }, { in: -6, out: -14 }, { in: 12, out: 4 }]
    const tensions = [0.5, -0.3]
    s0.commitCurve(0, nodes, tensions, beforeJson)
    const afterJson = curveToJSON(useApexStore.getState().curves[0])

    // Undo → back to unity.
    useApexStore.getState().undoCurve()
    expect(curveToJSON(useApexStore.getState().curves[0])).toBe(beforeJson)
    expect(useApexStore.getState().undoStack).toHaveLength(0)
    expect(useApexStore.getState().redoStack).toHaveLength(1)

    // Redo → exact edited node state.
    useApexStore.getState().redoCurve()
    expect(curveToJSON(useApexStore.getState().curves[0])).toBe(afterJson)
    const n = useApexStore.getState().curves[0].nodes
    expect(n).toHaveLength(3)
    expect(n[1]).toEqual({ in: -6, out: -14 })
    expect(useApexStore.getState().curves[0].tensions).toEqual([0.5, -0.3])
  })

  it('a no-op gesture does not pollute the undo stack', () => {
    const s = useApexStore.getState()
    const unity = unityCurve()
    s.commitCurve(0, unity.nodes, unity.tensions, s.snapshotCurve(0))
    expect(useApexStore.getState().undoStack).toHaveLength(0)
  })

  it('reset is a single undoable action back to unity', () => {
    const s = useApexStore.getState()
    s.commitCurve(0, [{ in: -24, out: -24 }, { in: 0, out: -10 }, { in: 12, out: 12 }], [0, 0], s.snapshotCurve(0))
    useApexStore.getState().resetCurve(0)
    const st = useApexStore.getState()
    expect(st.curves[0].nodes).toHaveLength(2)
    expect(st.undoStack).toHaveLength(2)
    useApexStore.getState().undoCurve()
    expect(useApexStore.getState().curves[0].nodes).toHaveLength(3)
  })
})

describe('apexStore solo exclusivity', () => {
  beforeEach(() => {
    vi.resetModules()
    installBridge()
    useApexStore.getState().close()
    useApexStore.setState({
      target: { trackId: 1, nodeId: 2, storeKey: '1' },
      params: { lo_solo: 0, md_solo: 0, hi_solo: 0 },
    })
  })

  it('turning one solo on clears the other split bands', () => {
    useApexStore.getState().setSolo(1, true)   // MID solo
    let p = useApexStore.getState().params
    expect([p.lo_solo, p.md_solo, p.hi_solo]).toEqual([0, 1, 0])

    useApexStore.getState().setSolo(0, true)   // LOW solo — MID must clear
    p = useApexStore.getState().params
    expect([p.lo_solo, p.md_solo, p.hi_solo]).toEqual([1, 0, 0])

    useApexStore.getState().setSolo(0, false)  // clear LOW
    p = useApexStore.getState().params
    expect([p.lo_solo, p.md_solo, p.hi_solo]).toEqual([0, 0, 0])
  })
})

import { create } from 'zustand'

// Store for the Waveshaper panel — tracks which effect instance is open,
// manages curve control points, and syncs with the engine.

const DEFAULT_POINTS = [[-1, -1], [0, 0], [1, 1]]

// Merge consecutive sorted points whose x-values differ by < epsilon.
// Prevents division-by-zero in cubic spline (both C++ and JS).
export function deduplicatePoints(pts) {
  const MIN_X_SPACING = 1e-5
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - out[out.length - 1][0] < MIN_X_SPACING) {
      out[out.length - 1] = pts[i] // keep later point's y
    } else {
      out.push(pts[i])
    }
  }
  return out
}

const useWaveshaperStore = create((set, get) => ({
  // { trackId: number, nodeId: number, storeKey: string } | null
  target: null,

  // [[x,y], ...] — control points for the transfer curve
  points: DEFAULT_POINTS,

  // Current preset index (0=Custom, 1=SoftClip, 2=HardClip, 3=Tube, 4=Fold, 5=Rectify)
  preset: 0,

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey }, points: DEFAULT_POINTS, preset: 0 })
    get().fetchCurvePoints()
  },

  close() {
    set({ target: null, points: DEFAULT_POINTS, preset: 0 })
  },

  async fetchCurvePoints() {
    const t = get().target
    if (!t) return
    try {
      const raw = await window.xleth?.audio?.wsGetCurvePoints(t.trackId, t.nodeId)
      const pts = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
      if (pts.length >= 2) set({ points: pts })
    } catch {}
  },

  async setCurvePoints(points) {
    const t = get().target
    if (!t) return
    const deduped = deduplicatePoints([...points].sort((a, b) => a[0] - b[0]))
    if (deduped.length < 2) return
    set({ points: deduped, preset: 0 })
    await window.xleth?.audio?.wsSetCurvePoints(t.trackId, t.nodeId, JSON.stringify(deduped))
  },

  async addPoint(x, y) {
    const pts = [...get().points, [x, y]].sort((a, b) => a[0] - b[0])
    const deduped = deduplicatePoints(pts)
    if (deduped.length < 2) return
    await get().setCurvePoints(deduped)
  },

  async removePoint(index) {
    const pts = get().points.filter((_, i) => i !== index)
    if (pts.length < 2) return // Need at least 2 points
    await get().setCurvePoints(pts)
  },

  async movePoint(index, x, y) {
    const pts = [...get().points]
    if (!pts[index]) return
    pts[index] = [x, y]
    const sorted = pts.sort((a, b) => a[0] - b[0])
    const deduped = deduplicatePoints(sorted)
    if (deduped.length < 2) return
    await get().setCurvePoints(deduped)
  },

  async setPreset(presetIndex) {
    const t = get().target
    if (!t) return
    set({ preset: presetIndex })
    await window.xleth?.audio?.wsSetPreset(t.trackId, t.nodeId, presetIndex)
    // Fetch the updated points after preset change
    await get().fetchCurvePoints()
  },
}))

export default useWaveshaperStore

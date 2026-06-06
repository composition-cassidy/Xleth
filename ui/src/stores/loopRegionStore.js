import { create } from 'zustand'
import { PPQ, GRANULARITY_BEATS } from '../constants/timeline.js'

// ── Pure helpers (shared with LoopRegionBar; unit tested) ───────────────────

// Minimum loop length in ticks: 1 snap unit when snapping, 1 tick when free
// (Alt held). Mirrors the engine mutation-layer floor so the optimistic UI and
// the committed model agree.
export function loopMinLengthTicks(snapGranularity, alt) {
  if (alt) return 1
  const beats = GRANULARITY_BEATS[snapGranularity] ?? GRANULARITY_BEATS['1/16']
  return Math.max(1, Math.round(beats * PPQ))
}

// Enforce the loop-length invariants (startTick >= 0, endTick >= startTick +
// minLengthTicks). Pure — the engine re-asserts these too, this just keeps the
// live preview honest. Returns a new { startTick, endTick }.
export function clampLoopRegionTicks(startTick, endTick, minLengthTicks) {
  const minLen = Math.max(1, minLengthTicks | 0)
  let s = Math.max(0, Math.round(startTick))
  let e = Math.round(endTick)
  if (e - s < minLen) e = s + minLen
  return { startTick: s, endTick: e }
}

// External store (zustand → useSyncExternalStore under the hood) holding the
// COMMITTED project loop region. The engine is the single source of truth; this
// mirror is refreshed via IPC on mount, on timeline change events, and after
// every commit. Live drag previews are kept locally in LoopRegionBar and never
// written here — only the committed result lands in this store.

// Mirrors engine LoopRegion defaults (TimelineTypes.h). endTick = 4 bars.
export const DEFAULT_LOOP_REGION = {
  startTick: 0,
  endTick: 4 * 4 * 960, // 16 beats @ 960 PPQ
  loopEnabled: false,
  renderOrigin: 'absolute',
  tailMode: 'tailClamp',
  tailThresholdDb: -60,
  tailMaxSeconds: 10,
  renderScoped: false, // derived (== loopEnabled); read-only, never persisted
}

const useLoopRegionStore = create((set) => ({
  loopRegion: DEFAULT_LOOP_REGION,

  // Replace the committed mirror (used after a refetch).
  setLoopRegionLocal: (region) => set({ loopRegion: region }),

  // Pull the committed region from the engine.
  fetchLoopRegion: async () => {
    try {
      const r = await window.xleth?.timeline?.getLoopRegion()
      if (r) set({ loopRegion: r })
    } catch { /* engine not ready */ }
  },
}))

export default useLoopRegionStore

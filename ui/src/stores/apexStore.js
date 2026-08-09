import { create } from 'zustand'

// ─── apexStore ────────────────────────────────────────────────────────────────
// State for the APEX multiband-maximizer editor window. Follows the minimal
// stock-effect store contract (target open/close, generic N-API param reads /
// writes) but also owns the structured curve state and a self-contained
// curve undo/redo stack.
//
// Why a local undo stack: scalar effect parameters in this app are NOT part of
// the engine's Timeline-command UndoManager (no stock effect panel pushes undo
// entries — Audio_SetEffectParameter just writes the APVTS and refreshes
// latency). APEX curves are structured subclass state set through
// apexSetBandCurve, and the engine author documents the intended undo model
// verbatim (XlethEngineService.cpp ~16786): "capture via apexGetBandCurve
// before the gesture, replay via apexSetBandCurve on undo". This store does
// exactly that — one entry per gesture, before/after captured as the same JSON
// the engine round-trips, so edit → undo → redo restores the exact node state.

export const BAND_NAMES   = ['LOW', 'MID', 'HIGH', 'MASTER']
export const BAND_PREFIX  = ['lo_', 'md_', 'hi_', 'ms_']
export const SPLIT_BANDS  = 3   // LOW / MID / HIGH have SOLO; MASTER does not
export const MASTER_BAND  = 3

// Curve authoring box (spec 4.3 / engine ApexDsp.h kCurveMinDb..kCurveMaxDb).
export const CURVE_MIN_DB = -24
export const CURVE_MAX_DB = 12
export const MAX_NODES    = 32

const audio = () => window?.xleth?.audio

// The unity (flat) curve — two pinned end nodes, one linear segment. Matches
// engine makeUnityCurve so a fresh instance and a reset agree bit-for-bit.
export function unityCurve() {
  return {
    nodes: [{ in: CURVE_MIN_DB, out: CURVE_MIN_DB }, { in: CURVE_MAX_DB, out: CURVE_MAX_DB }],
    tensions: [0],
  }
}

// Normalise a raw curve (from the bridge or a drag) into the shape the store
// and canvas expect: {in,out} nodes sorted by in, one tension per segment.
function normaliseCurve(raw) {
  const nodes = Array.isArray(raw?.nodes)
    ? raw.nodes
        .map(n => ({ in: Number(n.in), out: Number(n.out) }))
        .filter(n => Number.isFinite(n.in) && Number.isFinite(n.out))
    : []
  if (nodes.length < 2) return unityCurve()
  nodes.sort((a, b) => a.in - b.in)
  const tensions = Array.from({ length: nodes.length - 1 }, (_, i) => {
    const t = Number(raw?.tensions?.[i])
    return Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0
  })
  return { nodes, tensions }
}

// Serialise a curve to the exact JSON shape apexSetBandCurve accepts. Kept
// separate so the undo snapshots and the live commit produce identical bytes.
export function curveToJSON(curve) {
  return JSON.stringify({
    nodes: curve.nodes.map(n => ({ in: n.in, out: n.out })),
    tensions: curve.tensions,
  })
}

const useApexStore = create((set, get) => ({
  // { trackId, nodeId, storeKey } | null
  target: null,

  // Selected band tab (0=LOW, 1=MID, 2=HIGH, 3=MASTER).
  selectedBand: 0,

  // Scalar params keyed by full engine id ("lo_pre", "lowcut", …).
  params: {},

  // Per-band curve state [LOW, MID, HIGH, MASTER].
  curves: [unityCurve(), unityCurve(), unityCurve(), unityCurve()],

  // { latencyMs, latencySamples, lookaheadSamples, saturationLatencySamples } | null
  latency: null,

  // Curve undo/redo — entries are { band, before, after } JSON strings.
  undoStack: [],
  redoStack: [],

  open(trackId, nodeId, storeKey) {
    set({
      target: { trackId, nodeId, storeKey },
      selectedBand: 0,
      params: {},
      curves: [unityCurve(), unityCurve(), unityCurve(), unityCurve()],
      latency: null,
      undoStack: [],
      redoStack: [],
    })
    get().fetchAll()
  },

  close() {
    set({
      target: null,
      params: {},
      curves: [unityCurve(), unityCurve(), unityCurve(), unityCurve()],
      latency: null,
      undoStack: [],
      redoStack: [],
    })
  },

  setSelectedBand(band) {
    set({ selectedBand: Math.max(0, Math.min(3, band | 0)) })
  },

  // ── Hydration ─────────────────────────────────────────────────────────────

  async fetchAll() {
    await Promise.all([get().fetchParams(), get().fetchCurves(), get().fetchLatency()])
  },

  async fetchParams() {
    const t = get().target
    if (!t) return
    try {
      const raw = await audio()?.getEffectParameters(t.trackId, t.nodeId)
      const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
      const params = {}
      for (const p of list) if (p && typeof p.id === 'string') params[p.id] = p.value
      set({ params })
    } catch { /* node may be gone — leave params empty */ }
  },

  async fetchCurves() {
    const t = get().target
    if (!t) return
    try {
      const raw = await audio()?.apexGetCurves(t.trackId, t.nodeId)
      const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || {})
      const curves = [unityCurve(), unityCurve(), unityCurve(), unityCurve()]
      if (Array.isArray(obj.bands)) {
        for (const b of obj.bands) {
          const idx = b?.band | 0
          if (idx >= 0 && idx < 4) curves[idx] = normaliseCurve(b)
        }
      }
      set({ curves })
    } catch { /* leave unity curves */ }
  },

  async fetchLatency() {
    const t = get().target
    if (!t) return
    try {
      const raw = await audio()?.getEffectLatency(t.trackId, t.nodeId)
      const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || null)
      if (obj && obj.ok) set({ latency: obj })
    } catch { /* optional — editor works without it */ }
  },

  // ── Scalar params ───────────────────────────────────────────────────────────
  //
  // Drag discipline: a knob previews locally through setParamLocal (no IPC) for
  // every pointermove, then commits exactly once on release through commitParam.
  // Discrete controls (tabs, switches, toggles) are single-click commits.

  setParamLocal(id, value) {
    set(s => ({ params: { ...s.params, [id]: value } }))
  },

  commitParam(id, value) {
    const t = get().target
    if (!t) return
    set(s => ({ params: { ...s.params, [id]: value } }))
    audio()?.setEffectParameter(t.trackId, t.nodeId, id, value)
    // LOOKAHEAD and the four SAT THRESH knobs move the reported latency.
    if (id === 'lookahead' || id.endsWith('satth')) {
      // Re-read after the engine re-plans; a microtask is enough for the
      // synchronous APVTS write above to have landed.
      Promise.resolve().then(() => get().fetchLatency())
    }
  },

  // Band-param convenience: resolve the selected band's full param id.
  bandParamId(band, suffix) {
    return BAND_PREFIX[band] + suffix
  },

  // SOLO is mutually exclusive across LOW/MID/HIGH (spec 4.2). Turning one on
  // clears the other two; turning it off just clears itself.
  setSolo(band, on) {
    const t = get().target
    if (!t || band >= SPLIT_BANDS) return
    const next = { ...get().params }
    for (let b = 0; b < SPLIT_BANDS; b++) {
      const id = BAND_PREFIX[b] + 'solo'
      const val = on && b === band ? 1 : 0
      if (next[id] !== val) {
        next[id] = val
        audio()?.setEffectParameter(t.trackId, t.nodeId, id, val)
      }
    }
    set({ params: next })
  },

  // ── Curves ─────────────────────────────────────────────────────────────────

  // Capture the current band curve as a JSON snapshot for a new gesture.
  snapshotCurve(band) {
    return curveToJSON(get().curves[band] ?? unityCurve())
  },

  // Live, IPC-free preview while a node / tension handle is being dragged.
  previewCurve(band, nodes, tensions) {
    set(s => {
      const curves = [...s.curves]
      curves[band] = { nodes, tensions }
      return { curves }
    })
  },

  // Commit a finished gesture: set final curve, push one undo entry, IPC once.
  // `before` is the snapshot captured at gesture start (snapshotCurve).
  commitCurve(band, nodes, tensions, before) {
    const t = get().target
    if (!t) return
    const curve = normaliseCurve({ nodes, tensions })
    const after = curveToJSON(curve)
    if (after === before) {
      // No net change (e.g. a click that didn't move) — keep the local shape
      // but do not pollute the undo stack or the engine.
      set(s => { const curves = [...s.curves]; curves[band] = curve; return { curves } })
      return
    }
    set(s => {
      const curves = [...s.curves]
      curves[band] = curve
      return {
        curves,
        undoStack: [...s.undoStack, { band, before, after }],
        redoStack: [],
      }
    })
    audio()?.apexSetBandCurve(t.trackId, t.nodeId, band, after)
  },

  // Reset the selected band's curve to unity as a single undoable action.
  resetCurve(band) {
    const t = get().target
    if (!t) return
    const before = get().snapshotCurve(band)
    const curve = unityCurve()
    const after = curveToJSON(curve)
    if (after === before) return
    set(s => {
      const curves = [...s.curves]
      curves[band] = curve
      return { curves, undoStack: [...s.undoStack, { band, before, after }], redoStack: [] }
    })
    audio()?.apexSetBandCurve(t.trackId, t.nodeId, band, after)
  },

  applyCurveJSON(band, json) {
    const t = get().target
    if (!t) return
    const curve = normaliseCurve(JSON.parse(json))
    set(s => { const curves = [...s.curves]; curves[band] = curve; return { curves } })
    audio()?.apexSetBandCurve(t.trackId, t.nodeId, band, curveToJSON(curve))
  },

  undoCurve() {
    const { undoStack } = get()
    if (undoStack.length === 0) return
    const entry = undoStack[undoStack.length - 1]
    set(s => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, entry],
      selectedBand: entry.band,
    }))
    get().applyCurveJSON(entry.band, entry.before)
  },

  redoCurve() {
    const { redoStack } = get()
    if (redoStack.length === 0) return
    const entry = redoStack[redoStack.length - 1]
    set(s => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, entry],
      selectedBand: entry.band,
    }))
    get().applyCurveJSON(entry.band, entry.after)
  },
}))

export default useApexStore

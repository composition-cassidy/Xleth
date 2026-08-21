// Effect preset state adapters.
//
// The preset framework is effect-agnostic: it never hard-codes what "the state
// of an effect" is. Instead each effectType has an adapter with two methods —
//   captureState(target)        -> Promise<stateBlob>   (read the engine)
//   applyState(target, blob)    -> Promise<void>        (write the engine, once)
// — and everything not in the registry falls back to a DEFAULT adapter that
// round-trips the full scalar parameter list through the generic bridge calls
// every stock effect already exposes (audio.getEffectParameters /
// audio.setEffectParameter). That default is why a brand-new stock effect
// inherits working presets with zero extra code.
//
// Four effects have state beyond scalar params and register their own adapter:
// APEX (per-band transfer curves via audio.apexGetCurves / apexSetBandCurve),
// Waveshaper (curve control points via audio.wsGetCurvePoints / wsSetCurvePoints,
// layered on top of the default adapter's scalar params), and EQ / Filter
// (dynamic band/slot lists with no fixed count, reconciled via their own
// add/remove RPCs before per-band/per-slot fields are written). Any future
// effect with extra structured state registers its own adapter the same way.
//
// applyState is the "single setState" the preset load performs: it issues the
// engine writes and resolves. The caller wraps capture→apply→record so the whole
// load is one undoable step (see presetManager.js).

const audio = () => (typeof window !== 'undefined' ? window?.xleth?.audio : undefined)

// Parse the mixed string|array shape getEffectParameters can return into a
// plain { id: value } map. Matches how apexStore / the runtime renderer read it.
function paramsListToMap(raw) {
  const list = typeof raw === 'string' ? safeParse(raw, []) : (Array.isArray(raw) ? raw : [])
  const map = {}
  for (const p of list) {
    if (p && typeof p.id === 'string' && Number.isFinite(p.value)) map[p.id] = p.value
  }
  return map
}

function safeParse(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

// ── Default adapter — scalar params only ──────────────────────────────────────

const defaultAdapter = {
  async captureState(target) {
    const a = audio()
    if (!a || !target) return { params: {} }
    const raw = await a.getEffectParameters?.(target.trackId, target.nodeId)
    return { params: paramsListToMap(raw) }
  },

  async applyState(target, state) {
    const a = audio()
    if (!a || !target || !state || typeof state.params !== 'object') return
    for (const [id, value] of Object.entries(state.params)) {
      if (Number.isFinite(value)) a.setEffectParameter?.(target.trackId, target.nodeId, id, value)
    }
  },
}

// ── APEX adapter — scalar params + per-band curves ────────────────────────────

function normaliseCurveForPreset(band) {
  const nodes = Array.isArray(band?.nodes)
    ? band.nodes
        .map(n => ({ in: Number(n.in), out: Number(n.out) }))
        .filter(n => Number.isFinite(n.in) && Number.isFinite(n.out))
    : []
  const tensions = Array.isArray(band?.tensions)
    ? band.tensions.map(t => (Number.isFinite(Number(t)) ? Number(t) : 0))
    : []
  return { nodes, tensions }
}

const apexAdapter = {
  async captureState(target) {
    const a = audio()
    if (!a || !target) return { params: {}, curves: [] }
    const [rawParams, rawCurves] = await Promise.all([
      a.getEffectParameters?.(target.trackId, target.nodeId),
      a.apexGetCurves?.(target.trackId, target.nodeId),
    ])
    const params = paramsListToMap(rawParams)
    const obj = typeof rawCurves === 'string' ? safeParse(rawCurves, {}) : (rawCurves || {})
    const curves = []
    if (Array.isArray(obj.bands)) {
      for (const b of obj.bands) {
        const idx = b?.band | 0
        const { nodes, tensions } = normaliseCurveForPreset(b)
        if (nodes.length >= 2) curves.push({ band: idx, nodes, tensions })
      }
    }
    return { params, curves }
  },

  async applyState(target, state) {
    const a = audio()
    if (!a || !target || !state) return
    if (state.params && typeof state.params === 'object') {
      for (const [id, value] of Object.entries(state.params)) {
        if (Number.isFinite(value)) a.setEffectParameter?.(target.trackId, target.nodeId, id, value)
      }
    }
    if (Array.isArray(state.curves)) {
      for (const c of state.curves) {
        const band = c?.band | 0
        const { nodes, tensions } = normaliseCurveForPreset(c)
        if (nodes.length < 2) continue
        a.apexSetBandCurve?.(target.trackId, target.nodeId, band, JSON.stringify({ nodes, tensions }))
      }
    }
  },
}

// ── Waveshaper adapter — scalar params (incl. `preset`) + curve points ───────

function normalisePoints(points) {
  if (!Array.isArray(points)) return null
  const pts = points
    .map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
    .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  return pts.length >= 2 ? pts : null
}

const waveshaperAdapter = {
  async captureState(target) {
    const base = await defaultAdapter.captureState(target)
    const a = audio()
    if (!a || !target) return { ...base, points: null }
    const raw = await a.wsGetCurvePoints?.(target.trackId, target.nodeId)
    const pts = typeof raw === 'string' ? safeParse(raw, null) : (Array.isArray(raw) ? raw : null)
    return { ...base, points: normalisePoints(pts) }
  },

  async applyState(target, state) {
    await defaultAdapter.applyState(target, state)
    const a = audio()
    if (!a || !target || !state) return
    const pts = normalisePoints(state.points)
    if (pts) a.wsSetCurvePoints?.(target.trackId, target.nodeId, JSON.stringify(pts))
  },
}

// ── EQ adapter — dynamic band list + global (linphase/oversample) params ─────
// Bands have no fixed count (addBand/removeBand), so applyState reconciles the
// engine's current band count to the preset's before writing per-band fields.

function pickNumericOrBool(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
  }
  return out
}

function normaliseEqBand(band) {
  const { index, ...rest } = band || {}
  return pickNumericOrBool(rest)
}

async function fetchEqBandCount(a, target) {
  const raw = await a.eqGetBands?.(target.trackId, target.nodeId)
  const list = typeof raw === 'string' ? safeParse(raw, []) : (Array.isArray(raw) ? raw : [])
  return list.length
}

const eqAdapter = {
  async captureState(target) {
    const a = audio()
    if (!a || !target) return { bands: [], global: {} }
    const [rawBands, rawGlobal] = await Promise.all([
      a.eqGetBands?.(target.trackId, target.nodeId),
      a.eqGetGlobalParams?.(target.trackId, target.nodeId),
    ])
    const bandsList = typeof rawBands === 'string' ? safeParse(rawBands, []) : (Array.isArray(rawBands) ? rawBands : [])
    const globalObj = typeof rawGlobal === 'string' ? safeParse(rawGlobal, {}) : (rawGlobal || {})
    return { bands: bandsList.map(normaliseEqBand), global: pickNumericOrBool(globalObj) }
  },

  async applyState(target, state) {
    const a = audio()
    if (!a || !target || !state) return
    const bands = Array.isArray(state.bands) ? state.bands : []

    let count = await fetchEqBandCount(a, target)
    while (count < bands.length) { await a.eqAddBand?.(target.trackId, target.nodeId); count++ }
    while (count > bands.length) { await a.eqRemoveBand?.(target.trackId, target.nodeId, count - 1); count-- }

    for (let i = 0; i < bands.length; i++) {
      for (const [name, value] of Object.entries(bands[i])) {
        a.eqSetBandParam?.(target.trackId, target.nodeId, i, name, value)
      }
    }
    if (state.global && typeof state.global === 'object') {
      for (const [name, value] of Object.entries(state.global)) {
        a.eqSetGlobalParam?.(target.trackId, target.nodeId, name, typeof value === 'boolean' ? (value ? 1 : 0) : value)
      }
    }
  },
}

// ── Filter adapter — dynamic slot list, each with a fixed-size mod-lane array ─
// Slots have no fixed count either (addSlot/removeSlot up to MAX_SLOTS). Each
// slot's read-only telemetry fields (head/eff_cutoff/eff_q/dyn_env/dyn_accent)
// are dropped on capture — they are computed by the engine, not settable params.

const FILTER_SLOT_READONLY = new Set(['index', 'mods', 'head', 'eff_cutoff', 'eff_q', 'dyn_env', 'dyn_accent'])

function normaliseFilterSlot(slot) {
  const params = {}
  for (const [k, v] of Object.entries(slot || {})) {
    if (FILTER_SLOT_READONLY.has(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) params[k] = v
    else if (typeof v === 'boolean') params[k] = v
  }
  const mods = Array.isArray(slot?.mods)
    ? slot.mods.map(m => { const { index, ...rest } = m || {}; return pickNumericOrBool(rest) })
    : []
  return { params, mods }
}

async function fetchFilterSlotCount(a, target) {
  const raw = await a.filterGetSlots?.(target.trackId, target.nodeId)
  const list = typeof raw === 'string' ? safeParse(raw, []) : (Array.isArray(raw) ? raw : [])
  return list.length
}

const filterAdapter = {
  async captureState(target) {
    const a = audio()
    if (!a || !target) return { slots: [] }
    const raw = await a.filterGetSlots?.(target.trackId, target.nodeId)
    const list = typeof raw === 'string' ? safeParse(raw, []) : (Array.isArray(raw) ? raw : [])
    return { slots: list.map(normaliseFilterSlot) }
  },

  async applyState(target, state) {
    const a = audio()
    if (!a || !target || !state) return
    const slots = Array.isArray(state.slots) ? state.slots : []

    let count = await fetchFilterSlotCount(a, target)
    while (count < slots.length) { await a.filterAddSlot?.(target.trackId, target.nodeId); count++ }
    while (count > slots.length) { await a.filterRemoveSlot?.(target.trackId, target.nodeId, count - 1); count-- }

    for (let i = 0; i < slots.length; i++) {
      const { params, mods } = slots[i] || {}
      for (const [name, value] of Object.entries(params || {})) {
        a.filterSetSlotParam?.(target.trackId, target.nodeId, i, name, value)
      }
      for (let lane = 0; lane < (mods || []).length; lane++) {
        for (const [name, value] of Object.entries(mods[lane] || {})) {
          a.filterSetSlotParam?.(target.trackId, target.nodeId, i, `m${lane}_${name}`, value)
        }
      }
    }
  },
}

// ── Xform (Zoom/Pan/Rot) adapter — per-track, not per-audio-effect ───────────
// zoomPanRot lives on TrackInfo, not in an audio-effect APVTS, so unlike every
// other adapter here there is no getEffectParameters round-trip: the current
// settings are already in the caller's hands (target.zpr, the same object
// ZprTimelineCard already renders from), so capture just reshapes it. Apply
// needs TWO engine calls, not one — timeline_setTrackZoomPanRotSettings never
// accepts a caller-supplied `tracks` block (Timeline::setTrackZoomPanRotSettings
// either preserves the track's existing authored curves or rebuilds them from
// scalars; it ignores what's passed in either way), so the keyframe curves
// have to go through timeline_setTrackZprTracks separately — the same second
// call ZprTimelineCard's own keyframe edits already use. Undo is still one
// step from the caller's side: presetManager captures `before` and re-applies
// it through this same two-call applyState.

const timelineBridge = () => (typeof window !== 'undefined' ? window?.xleth?.timeline : undefined)

const XFORM_IDENTITY_CURVE = [1 / 3, 1 / 3, 2 / 3, 2 / 3]

// Always emits a concrete `c` array (never omitted/undefined) — matches the
// convention ZprTimelineCard's own cloneTracks() uses when sending keyframes
// over the bridge, so a missing curve in preset JSON can't cross the IPC
// boundary as an `undefined` property.
function cloneParamTrackForPreset(track) {
  const keys = Array.isArray(track?.keys) ? track.keys : []
  return {
    constantValue: Number.isFinite(track?.constantValue) ? track.constantValue : 0,
    keys: keys
      .map(k => ({
        t: Number(k?.t),
        v: Number(k?.v),
        c: Array.isArray(k?.c) && k.c.length === 4 ? k.c.map(Number) : XFORM_IDENTITY_CURVE.slice(),
      }))
      .filter(k => Number.isFinite(k.t) && Number.isFinite(k.v)),
  }
}

const XFORM_TRACK_CHANNELS = ['panX', 'panY', 'zoomLog2', 'rotationDeg']

const xformAdapter = {
  async captureState(target) {
    const z = target?.zpr || {}
    const tracks = {}
    for (const ch of XFORM_TRACK_CHANNELS) tracks[ch] = cloneParamTrackForPreset(z.tracks?.[ch])
    return {
      tracks,
      durationMs: z.durationMs ?? 300,   // Fixed mode's authoritative value
      lengthMode: z.lengthMode ?? 1,
      musicalDivision: z.musicalDivision ?? 2,
      notePercentage: z.notePercentage ?? 100,
      onEndMode: z.onEndMode ?? 0,
      retriggerMode: z.retriggerMode ?? 0,
      retriggerCrossfadeMs: z.retriggerCrossfadeMs ?? 50,
    }
  },

  async applyState(target, state) {
    const t = timelineBridge()
    if (!t || !target || !state) return
    const current = target.zpr || {}
    await t.setTrackZoomPanRotSettings?.(target.trackId, {
      ...current,
      enabled: true,
      durationMs: state.durationMs ?? 300,
      lengthMode: state.lengthMode ?? 1,
      musicalDivision: state.musicalDivision ?? 2,
      notePercentage: state.notePercentage ?? 100,
      onEndMode: state.onEndMode ?? 0,
      retriggerMode: state.retriggerMode ?? 0,
      retriggerCrossfadeMs: state.retriggerCrossfadeMs ?? 50,
    })
    if (state.tracks) {
      const tracks = {}
      for (const ch of XFORM_TRACK_CHANNELS) tracks[ch] = cloneParamTrackForPreset(state.tracks[ch])
      await t.setTrackZprTracks?.(target.trackId, tracks)
    }
  },
}

// ── Registry ──────────────────────────────────────────────────────────────────

const ADAPTERS = {
  apex: apexAdapter,
  waveshaper: waveshaperAdapter,
  xletheq: eqAdapter,
  xlethfilter: filterAdapter,
  xform: xformAdapter,
}

export function getPresetAdapter(effectType) {
  return ADAPTERS[effectType] || defaultAdapter
}

export { defaultAdapter, apexAdapter, xformAdapter }

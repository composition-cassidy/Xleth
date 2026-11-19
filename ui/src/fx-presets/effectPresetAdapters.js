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

const WS_CUSTOM_SETTLE_MS = 60

const waveshaperAdapter = {
  async captureState(target) {
    const base = await defaultAdapter.captureState(target)
    const a = audio()
    if (!a || !target) return { ...base, points: null }
    const raw = await a.wsGetCurvePoints?.(target.trackId, target.nodeId)
    const pts = typeof raw === 'string' ? safeParse(raw, null) : (Array.isArray(raw) ? raw : null)
    return { ...base, points: normalisePoints(pts) }
  },

  // The shape never goes through the generic parameter write. A named shape is set with
  // wsSetPreset, which also moves the control points to match it (setEffectParameter would
  // change the audio and leave the drawn curve stale). A custom curve is set with
  // wsSetCurvePoints, which flips the shape to Custom itself; if the instance was on a
  // named shape the audio thread answers that flip by swapping in a straight-line table,
  // and only wsSetPreset(0) rebuilds the spline, so that call follows a few blocks later.
  async applyState(target, state) {
    const a = audio()
    if (!a || !target || !state) return
    const { preset, ...scalars } = (state.params && typeof state.params === 'object') ? state.params : {}
    await defaultAdapter.applyState(target, { params: scalars })
    const pts = normalisePoints(state.points)
    if (pts) {
      await a.wsSetCurvePoints?.(target.trackId, target.nodeId, JSON.stringify(pts))
      await new Promise(resolve => setTimeout(resolve, WS_CUSTOM_SETTLE_MS))
      await a.wsSetPreset?.(target.trackId, target.nodeId, 0)
    } else if (Number.isFinite(preset)) {
      await a.wsSetPreset?.(target.trackId, target.nodeId, Math.round(preset))
    }
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

// The band / slot setters take numbers only: a JS boolean is rejected by the engine and
// the field is never written. Captured state carries `enabled` / `slides` as booleans
// (that is how the getters report them), so every write goes through this.
function asEngineNumber(value) {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value
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
        a.eqSetBandParam?.(target.trackId, target.nodeId, i, name, asEngineNumber(value))
      }
    }
    if (state.global && typeof state.global === 'object') {
      for (const [name, value] of Object.entries(state.global)) {
        a.eqSetGlobalParam?.(target.trackId, target.nodeId, name, asEngineNumber(value))
      }
    }
  },
}

// ── Filter adapter — dynamic slot list, each with a fixed-size mod-lane array ─
// Slots have no fixed count either (addSlot/removeSlot up to MAX_SLOTS). Each
// slot's read-only telemetry fields (the eff_* effective values and dyn_env /
// dyn_accent) are dropped on capture — they are computed by the engine, not
// settable params. `head` (formant head size) is a real parameter and is kept.

const FILTER_SLOT_READONLY = new Set([
  'index', 'mods', 'eff_cutoff', 'eff_q', 'eff_gain', 'eff_morph', 'eff_drive', 'eff_mix', 'eff_valid',
  'dyn_env', 'dyn_accent',
])

// Lane telemetry the getter reports alongside the settable fields.
const FILTER_LANE_READONLY = new Set(['index', 'env', 'accent', 'src'])

function normaliseFilterLane(lane) {
  const out = {}
  for (const [k, v] of Object.entries(lane || {})) {
    if (FILTER_LANE_READONLY.has(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
  }
  return out
}

// `kind` goes first: taking a lane out of Off makes the engine reset that lane's other
// fields to the new kind's defaults, so anything written before it would be wiped.
// (Captured state has its keys sorted by the engine's JSON writer, which puts `kind`
// in the middle.)
function laneWritesInOrder(lane) {
  const entries = Object.entries(lane || {})
  return [...entries.filter(([name]) => name === 'kind'), ...entries.filter(([name]) => name !== 'kind')]
}

function normaliseFilterSlot(slot) {
  const params = {}
  for (const [k, v] of Object.entries(slot || {})) {
    if (FILTER_SLOT_READONLY.has(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) params[k] = v
    else if (typeof v === 'boolean') params[k] = v
  }
  const mods = Array.isArray(slot?.mods) ? slot.mods.map(normaliseFilterLane) : []
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
        a.filterSetSlotParam?.(target.trackId, target.nodeId, i, name, asEngineNumber(value))
      }
      for (let lane = 0; lane < (mods || []).length; lane++) {
        for (const [name, value] of laneWritesInOrder(mods[lane])) {
          a.filterSetSlotParam?.(target.trackId, target.nodeId, i, `m${lane}_${name}`, asEngineNumber(value))
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

// ── Fedda adapter — scalar params minus per-instance and monitor state ───────
//
// `variation` is the instance's decorrelation seed: two Fedda instances loaded from one preset
// with the same seed would stamp the same comb pattern on the mix bus (the thing the seed exists to
// prevent), so a preset never carries it and never sets it. `mono_check` / `compare` are audition
// switches that the engine never saves or renders; a preset must not switch them on either.

const FEDDA_INSTANCE_PARAMS = new Set(['variation', 'mono_check', 'compare'])

function withoutFeddaInstanceParams(params) {
  const out = {}
  for (const [id, value] of Object.entries(params || {})) {
    if (!FEDDA_INSTANCE_PARAMS.has(id)) out[id] = value
  }
  return out
}

const feddaAdapter = {
  async captureState(target) {
    const state = await defaultAdapter.captureState(target)
    return { params: withoutFeddaInstanceParams(state.params) }
  },

  async applyState(target, state) {
    if (!state || typeof state.params !== 'object') return
    await defaultAdapter.applyState(target, { ...state, params: withoutFeddaInstanceParams(state.params) })
  },
}

// ── Szkrezh adapter — scalar params minus the Keys source track ─────────────
//
// `midi_track` is a track id in THIS project: carried into another project by a preset it would
// point at an unrelated track (or none). A preset never carries it and never sets it, so loading
// one keeps the Keys source the user picked.

const SZKREZH_INSTANCE_PARAMS = new Set(['midi_track'])

function withoutSzkrezhInstanceParams(params) {
  const out = {}
  for (const [id, value] of Object.entries(params || {})) {
    if (!SZKREZH_INSTANCE_PARAMS.has(id)) out[id] = value
  }
  return out
}

const szkrezhAdapter = {
  async captureState(target) {
    const state = await defaultAdapter.captureState(target)
    return { params: withoutSzkrezhInstanceParams(state.params) }
  },

  async applyState(target, state) {
    if (!state || typeof state.params !== 'object') return
    await defaultAdapter.applyState(target, { ...state, params: withoutSzkrezhInstanceParams(state.params) })
  },
}

// ── Registry ──────────────────────────────────────────────────────────────────

const ADAPTERS = {
  fedda: feddaAdapter,
  szkrezh: szkrezhAdapter,
  apex: apexAdapter,
  waveshaper: waveshaperAdapter,
  xletheq: eqAdapter,
  xlethfilter: filterAdapter,
  xform: xformAdapter,
}

export function getPresetAdapter(effectType) {
  return ADAPTERS[effectType] || defaultAdapter
}

export {
  defaultAdapter, apexAdapter, xformAdapter, feddaAdapter, szkrezhAdapter,
  waveshaperAdapter, eqAdapter, filterAdapter,
}

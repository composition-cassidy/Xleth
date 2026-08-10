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
// APEX is the one effect today whose state is more than scalar params: its
// per-band transfer curves (node list + per-segment tensions) travel through
// their own door (audio.apexGetCurves / audio.apexSetBandCurve). Its adapter
// therefore captures/applies params AND curves. Any future effect with extra
// structured state registers its own adapter the same way.
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

// ── Registry ──────────────────────────────────────────────────────────────────

const ADAPTERS = {
  apex: apexAdapter,
}

export function getPresetAdapter(effectType) {
  return ADAPTERS[effectType] || defaultAdapter
}

export { defaultAdapter, apexAdapter }

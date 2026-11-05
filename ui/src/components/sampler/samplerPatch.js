// ── Sampler patches ─────────────────────────────────────────────────────────
// Named save/load of a whole sampler setup.
//
// Deliberately NOT a new file store. ui/electron-main/fx-presets.js is already
// generic over an `effectType` directory and treats `state` as an opaque object
// it never interprets — so a sampler patch is just an fx preset with
// effectType 'sampler'. That buys the slug safety, the size caps, the
// factory/user split and the overwrite semantics for free, and means there is
// one preset store in the app rather than two that drift.
//
// WHAT A PATCH IS: settings, not samples. Loading one applies tuning, trim,
// loop, fades, prep, mangle, voicing, arp and the modulation config onto
// WHATEVER AUDIO IS CURRENTLY LOADED. It never carries or repoints audio files —
// a patch that silently swapped your layers' samples would be a different and
// much more surprising feature, and `audioFilePath` is excluded everywhere
// below to keep that guarantee structural rather than a matter of care.

export const SAMPLER_PRESET_EFFECT_TYPE = 'sampler'
export const SAMPLER_PATCH_VERSION = 1

// Region-level (whole-sampler) settings.
const REGION_FIELDS = [
  'crossfadeEnabled',
  'monoEnabled', 'voiceCount', 'legatoEnabled',
  'portamentoEnabled', 'portamentoTimeMs', 'portamentoMode', 'portamentoCurve',
  'arpEnabled', 'arpTempoSync', 'arpDivision', 'arpFreeTimeMs',
  'arpGate', 'arpRange', 'arpDirection',
]

// Per-slot settings that mean the same thing against any sample.
const SLOT_SCALE_FREE = [
  'rootNote', 'octave', 'semitone', 'fine', 'coarse',
  'volume', 'pan',
  'declickMs', 'fadeInMs', 'fadeOutMs',
  'loopEnabled', 'loopMode', 'exitLoopOnRelease',
  'prepAlgorithm', 'prepStretch', 'prepShiftCents',
  'dcOffsetRemoved', 'normalized', 'polarityReversed', 'reversed',
]

// Per-slot settings that are absolute indices into a specific buffer. Stored
// alongside the length they were measured against so a load can RESCALE them
// onto a sample of a different length instead of pointing past its end.
const SLOT_SAMPLE_INDEX = ['smpStart', 'smpLength', 'loopStart', 'loopEnd', 'crossfadeSamples']

const presets = () => (typeof window !== 'undefined' ? window?.xleth?.fxPresets : undefined)

function failure(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

// ── Capture ─────────────────────────────────────────────────────────────────

export function buildPatchState({ settings, slots, numSamplesBySlot, modulation }) {
  const region = {}
  for (const f of REGION_FIELDS) if (settings?.[f] !== undefined) region[f] = settings[f]

  const slotStates = (Array.isArray(slots) ? slots : []).map((sl, i) => {
    const out = { sourceNumSamples: Number(numSamplesBySlot?.[i]) || 0 }
    for (const f of SLOT_SCALE_FREE) if (sl?.[f] !== undefined) out[f] = sl[f]
    for (const f of SLOT_SAMPLE_INDEX) if (sl?.[f] !== undefined) out[f] = sl[f]
    out.mangleChain = Array.isArray(sl?.mangleChain)
      ? sl.mangleChain.map((mi) => ({
          mode: mi.mode ?? 0, amount: mi.amount ?? 0, mix: mi.mix ?? 1, bypass: !!mi.bypass,
        }))
      : []
    return out
  })

  return {
    version: SAMPLER_PATCH_VERSION,
    region,
    slots: slotStates,
    // The modulation config is already a plain serializable object from
    // getSamplerModulation; store it verbatim so a future engine field is
    // carried through without this module needing to know about it.
    modulation: modulation ?? null,
  }
}

export async function saveSamplerPatch({ name, state }) {
  const p = presets()
  if (!p) return failure('preset store unavailable')
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return failure('a patch needs a name')
  try {
    const res = await p.save({
      xlethFxPreset: 1,
      effectType: SAMPLER_PRESET_EFFECT_TYPE,
      name: trimmed,
      created: new Date().toISOString(),
      state,
    })
    return { ok: true, slug: res?.slug, overwritten: !!res?.overwritten }
  } catch (e) {
    return failure(e)
  }
}

export async function listSamplerPatches() {
  const p = presets()
  if (!p) return { factory: [], user: [] }
  try {
    const res = await p.list(SAMPLER_PRESET_EFFECT_TYPE)
    return { factory: res?.factory ?? [], user: res?.user ?? [] }
  } catch {
    return { factory: [], user: [] }
  }
}

export async function deleteSamplerPatch(slug) {
  const p = presets()
  if (!p) return false
  try { return !!(await p.delete(SAMPLER_PRESET_EFFECT_TYPE, slug)) } catch { return false }
}

// ── Apply ───────────────────────────────────────────────────────────────────

// Rescale one slot's sample-index fields from the length they were captured at
// onto the length of the layer they are landing on.
//
// PROPORTIONAL, not clamped: a patch is "this shape of trim and loop", and a
// loop two thirds of the way through a two-second sample should still be two
// thirds of the way through a four-second one. Clamping instead would silently
// collapse every position onto the end of a shorter sample, which reads as the
// patch having done nothing.
export function rescaleSlotIndices(slotState, targetNumSamples) {
  const out = {}
  const src = Number(slotState?.sourceNumSamples) || 0
  const dst = Number(targetNumSamples) || 0
  // No usable length at either end: pass through and let the engine clamp.
  const ratio = (src > 0 && dst > 0) ? (dst / src) : 1

  const scale = (v) => Math.max(0, Math.round((Number(v) || 0) * ratio))
  const cap = (v) => dst > 0 ? Math.min(v, dst) : v

  // 0 is the "to the end" sentinel on smpLength and loopEnd and must stay 0.
  out.smpStart = dst > 0 ? Math.min(scale(slotState?.smpStart), Math.max(0, dst - 1)) : scale(slotState?.smpStart)
  out.smpLength = !slotState?.smpLength ? 0 : (cap(scale(slotState.smpLength)) >= dst && dst > 0 ? 0 : cap(scale(slotState.smpLength)))
  out.loopStart = dst > 0 ? Math.min(scale(slotState?.loopStart), Math.max(0, dst - 1)) : scale(slotState?.loopStart)
  out.loopEnd = !slotState?.loopEnd ? 0 : (cap(scale(slotState.loopEnd)) >= dst && dst > 0 ? 0 : cap(scale(slotState.loopEnd)))

  const resolvedEnd = out.loopEnd === 0 ? (dst || 0) : out.loopEnd
  const loopLen = Math.max(0, resolvedEnd - out.loopStart)
  out.crossfadeSamples = Math.max(0, Math.min(loopLen, scale(slotState?.crossfadeSamples)))
  return out
}

// Merge a patch's slot states onto the CURRENT slots, preserving everything a
// patch must not touch: the audio each layer points at, its display name, and
// its mute/solo performance state.
export function mergePatchSlots(patchSlots, currentSlots, numSamplesBySlot) {
  const patch = Array.isArray(patchSlots) ? patchSlots : []
  return (Array.isArray(currentSlots) ? currentSlots : []).map((cur, i) => {
    const ps = patch[i]
    // More layers loaded than the patch describes: leave the extras alone
    // rather than resetting them to defaults.
    if (!ps) return cur
    const next = { ...cur }
    for (const f of SLOT_SCALE_FREE) if (ps[f] !== undefined) next[f] = ps[f]
    Object.assign(next, rescaleSlotIndices(ps, numSamplesBySlot?.[i]))
    next.mangleChain = Array.isArray(ps.mangleChain)
      ? ps.mangleChain.map((mi) => ({ ...mi }))
      : []
    return next
  })
}

export function patchRegionSettings(state) {
  const region = state?.region
  if (!region || typeof region !== 'object') return {}
  const out = {}
  for (const f of REGION_FIELDS) if (region[f] !== undefined) out[f] = region[f]
  return out
}

export async function loadSamplerPatch(source, slug) {
  const p = presets()
  if (!p) return failure('preset store unavailable')
  try {
    const doc = await p.load(SAMPLER_PRESET_EFFECT_TYPE, source, slug)
    const state = doc?.state
    if (!state || typeof state !== 'object') return failure('patch has no state')
    if (state.version !== SAMPLER_PATCH_VERSION) {
      return failure(`patch was written by a different version (${state.version ?? 'unknown'})`)
    }
    return { ok: true, name: doc.name, state }
  } catch (e) {
    return failure(e)
  }
}

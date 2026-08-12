import { create } from 'zustand'

// Xleth Filter editor store — mirrors eqStore.js exactly in structure.
// A target is { trackId, nodeId, storeKey }; everything else is fetched from the
// engine over the audio_filter* custom RPCs. Per-slot scalar params round-trip
// through audio_filterSetSlotParam (raw values, the engine normalises), the exact
// analogue of the EQ's eqSetBandParam.

// Slot type enum — must stay in lockstep with XlethFilterEffect::SlotType.
export const SLOT_TYPES = [
  { value: 0, id: 'lp12',      label: 'Low Pass' },
  { value: 1, id: 'hp12',      label: 'High Pass' },
  { value: 2, id: 'bp',        label: 'Band Pass' },
  { value: 3, id: 'notch',     label: 'Notch' },
  { value: 4, id: 'allpass',   label: 'All Pass' },
  { value: 5, id: 'peak',      label: 'Peak / Bell' },
  { value: 6, id: 'lowshelf',  label: 'Low Shelf' },
  { value: 7, id: 'highshelf', label: 'High Shelf' },
  { value: 8, id: 'morph',     label: 'Morph' },
  // Analog-modelled + character types. APPEND ONLY — the value IS what gets
  // serialized into the project, so reordering rewrites saved filters.
  { value: 9,  id: 'moog24',    label: 'Moog Ladder' },
  { value: 10, id: 'acid303',   label: 'TB-303 Diode' },
  { value: 11, id: 'sk12',      label: 'Sallen-Key 12' },
  { value: 12, id: 'sk24',      label: 'Sallen-Key 24' },
  { value: 13, id: 'steinerLP', label: 'Steiner LP' },
  { value: 14, id: 'steinerBP', label: 'Steiner BP' },
  { value: 15, id: 'steinerHP', label: 'Steiner HP' },
  { value: 16, id: 'combFF',    label: 'Comb (FF)' },
  { value: 17, id: 'combFB',    label: 'Comb (Res)' },
  { value: 18, id: 'formant',   label: 'Formant' },
  { value: 19, id: 'tilt',      label: 'Tilt EQ' },
]

// Vowels for the formant bank — lockstep with xleth_filter::Vowel.
export const VOWELS = [
  { value: 0, label: 'ee' },
  { value: 1, label: 'ah' },
  { value: 2, label: 'oh' },
  { value: 3, label: 'oo' },
]

// slope param: 0 = 6 dB, 1 = 12 dB, 2 = 24 dB, 3 = 48 dB.
export const SLOPES = [
  { value: 0, label: '6' },
  { value: 1, label: '12' },
  { value: 2, label: '24' },
  { value: 3, label: '48' },
]

export const MAX_SLOTS = 8

// How many modulator lanes a slot can hold — lockstep with
// xleth_filter::kMaxModsPerSlot. A slot can hold ANY mix of kinds across these:
// six LFOs, or two LFOs + three envelopes + a follower, etc.
export const MAX_MODS_PER_SLOT = 6

// Modulator kinds — lockstep with xleth_filter::ModKind. `off` is what an empty
// lane reads as; the panel renders only the lanes that are not off, and adding a
// modulator is a single write of that lane's `kind`.
export const MOD_KIND_OFF = 0
export const MOD_KIND_LFO = 1
export const MOD_KIND_ENV = 2
export const MOD_KIND_DYN = 3

export const MOD_KINDS = [
  { value: MOD_KIND_LFO, id: 'lfo', label: 'LFO',
    blurb: 'Free-running or tempo-synced cycle' },
  { value: MOD_KIND_ENV, id: 'env', label: 'Envelope',
    blurb: 'AHDSR triggered by notes and clips' },
  { value: MOD_KIND_DYN, id: 'dyn', label: 'Dynamics',
    blurb: 'Follows the level going into this slot' },
]

export function modKindLabel(kind) {
  return MOD_KINDS.find(k => k.value === kind)?.label ?? 'Off'
}

// Slot-relative name of a lane parameter — the exact string
// audio_filterSetSlotParam takes ("m2_depth" → APVTS "s{slot}_m2_depth").
export function laneParam(laneIndex, name) {
  return `m${laneIndex}_${name}`
}

// The lanes of a slot that actually hold a modulator, in lane order. Removed
// lanes leave holes (removal only writes kind = off), and this hides them.
export function activeMods(slot) {
  const mods = Array.isArray(slot?.mods) ? slot.mods : []
  return mods.filter(m => Number(m?.kind ?? MOD_KIND_OFF) !== MOD_KIND_OFF)
}

// Per-slot modulator destinations — must stay in lockstep with
// XlethFilterEffect::ModDest (cutoff, q, gain, morph, drive, mix).
export const MOD_DESTS = [
  { value: 0, label: 'Cutoff' },
  { value: 1, label: 'Q' },
  { value: 2, label: 'Gain' },
  { value: 3, label: 'Morph' },
  { value: 4, label: 'Drive' },
  { value: 5, label: 'Mix' },
]

// LFO waveforms — lockstep with XlethFilterEffect::LfoWave.
export const LFO_SHAPES = [
  { value: 0, label: 'Sine' },
  { value: 1, label: 'Triangle' },
  { value: 2, label: 'Saw ↑' },
  { value: 3, label: 'Saw ↓' },
  { value: 4, label: 'Square' },
  { value: 5, label: 'S&H' },
]

// Tempo-sync note divisions (denominator; period = 4/division beats). Mirrors the
// FX-graph LFO's LFO_SYNC_DIVISIONS. Larger value = faster.
export const LFO_SYNC_DIVISIONS = [
  { value: 0.125, label: '8/1' },
  { value: 0.25, label: '4/1' },
  { value: 0.5, label: '2/1' },
  { value: 1, label: '1/1' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1/4' },
  { value: 8, label: '1/8' },
  { value: 16, label: '1/16' },
  { value: 32, label: '1/32' },
  { value: 64, label: '1/64' },
]

// Which conditional controls a given slot type actually uses. Mirrors the
// engine's slopeApplies() / gain / morph gating so the panel never shows a knob
// that has no effect on the selected type.
// Tilt reuses `gain` as its single tilt amount; the comb reuses `morph` as loop
// damping and the formant bank reuses it as the vowel morph.
export function typeUsesGain(type)  {
  return type === 5 || type === 6 || type === 7 || type === 19
}
export function typeUsesMorph(type) {
  return type === 8 || type === 16 || type === 17 || type === 18
}
// The character types all have a topology-fixed section count, so the slope
// control has nothing to say about them.
export function typeUsesSlope(type) {
  return type === 0 || type === 1 || type === 2 || type === 3 || type === 8
}

// ...which means those two knobs need type-dependent captions and ranges, or the
// panel would show a knob labelled GAIN that is really a tilt, in dB it cannot
// reach. Data only — the panel still renders the same two knobs it always did.
export function typeGainLabel(type)  { return type === 19 ? 'TILT' : 'GAIN' }
export function typeGainRange(type)  {
  return type === 19 ? { min: -12, max: 12 } : { min: -24, max: 24 }
}
export function typeMorphLabel(type) {
  if (type === 16 || type === 17) return 'DAMP'
  if (type === 18) return 'VOWEL'
  return 'MORPH'
}

const useFilterStore = create((set, get) => ({
  // { trackId, nodeId, storeKey } or null
  target: null,

  // [{ index, enabled, type, cutoff, q, gain, morph, slope, drive, mix,
  //    vowel_a, vowel_b, head, eff_cutoff, eff_q, dyn_env, dyn_accent,
  //    mods: [{ index, kind, dest, depth,
  //             shape, rate_mode, rate_ms, sync, phase,          // kind = lfo
  //             attack, hold, decay, sustain, release, slides,   // kind = env
  //             dyn_attack, dyn_release, cut_min, cut_max,       // kind = dyn
  //             env, accent }, ...] }, ...]
  // `mods` always has MAX_MODS_PER_SLOT entries; the empty ones read kind = 0.
  slots: [],

  // UI-local
  selectedSlotIndex: -1,

  // Polling data (mutated in-place, not reactive)
  responseCurve: null,   // Float32Array(512), dB

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey }, slots: [], responseCurve: null, selectedSlotIndex: -1 })
    get().fetchSlots()
  },

  close() {
    set({ target: null, slots: [], responseCurve: null, selectedSlotIndex: -1 })
  },

  async fetchSlots() {
    const t = get().target
    if (!t) return
    try {
      const raw = await window.xleth?.audio?.filterGetSlots(t.trackId, t.nodeId)
      const slots = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
      // Keep the selection valid if the count shrank underneath us.
      set(s => ({
        slots,
        selectedSlotIndex: s.selectedSlotIndex >= slots.length ? slots.length - 1 : s.selectedSlotIndex,
      }))
    } catch {}
  },

  async addSlot() {
    const t = get().target
    if (!t) return
    if (get().slots.length >= MAX_SLOTS) return
    const idx = await window.xleth?.audio?.filterAddSlot(t.trackId, t.nodeId)
    await get().fetchSlots()
    // Select the freshly added slot (engine returns its index, else last).
    const slots = get().slots
    const sel = (typeof idx === 'number' && idx >= 0 && idx < slots.length) ? idx : slots.length - 1
    set({ selectedSlotIndex: sel })
  },

  async removeSlot(slotIndex) {
    const t = get().target
    if (!t) return
    // Optimistic remove so the strip reacts instantly.
    set(s => ({ slots: s.slots.filter((_, i) => i !== slotIndex) }))
    await window.xleth?.audio?.filterRemoveSlot(t.trackId, t.nodeId, slotIndex)
    await get().fetchSlots()
  },

  async setSlotParam(slotIndex, paramName, value) {
    const t = get().target
    if (!t) return
    // Optimistic — so knobs/sliders never lag their own drag.
    set(s => {
      const slots = [...s.slots]
      if (slots[slotIndex]) slots[slotIndex] = { ...slots[slotIndex], [paramName]: value }
      return { slots }
    })
    await window.xleth?.audio?.filterSetSlotParam(t.trackId, t.nodeId, slotIndex, paramName, value)
  },

  // ── Modulator lanes ────────────────────────────────────────────────────────
  // A lane's `kind` IS its existence, so add and remove are each a single param
  // write and need no dedicated RPC. Removed lanes are never compacted: the
  // panel renders only the non-off ones, so a hole is invisible, and leaving it
  // in place means removing lane 1 cannot renumber lane 2 underneath the user.

  // Writes one lane parameter, mirroring it into the local `mods` array so the
  // control does not lag its own drag (same optimism as setSlotParam).
  async setModParam(slotIndex, laneIndex, paramName, value) {
    const t = get().target
    if (!t) return
    set(s => {
      const slots = [...s.slots]
      const slot = slots[slotIndex]
      if (slot && Array.isArray(slot.mods)) {
        const mods = [...slot.mods]
        if (mods[laneIndex]) mods[laneIndex] = { ...mods[laneIndex], [paramName]: value }
        slots[slotIndex] = { ...slot, mods }
      }
      return { slots }
    })
    await window.xleth?.audio?.filterSetSlotParam(
      t.trackId, t.nodeId, slotIndex, laneParam(laneIndex, paramName), value)
  },

  // Add a modulator of `kind` to the first free lane. The engine resets that
  // lane to the kind's defaults as part of the same write, so there is nothing
  // to seed here — just refetch to pick them up.
  //
  // The free lane is found by scanning lane numbers rather than by walking the
  // `mods` array, so a payload that is missing or short — an engine that has not
  // been rebuilt yet, say — still lands on lane 0 instead of silently doing
  // nothing. A lane with no entry is by definition unoccupied.
  async addModulator(slotIndex, kind) {
    const slot = get().slots[slotIndex]
    if (!slot) return -1
    const mods = Array.isArray(slot.mods) ? slot.mods : []
    let lane = -1
    for (let j = 0; j < MAX_MODS_PER_SLOT; j++) {
      if (Number(mods[j]?.kind ?? MOD_KIND_OFF) === MOD_KIND_OFF) { lane = j; break }
    }
    if (lane < 0) return -1
    await get().setModParam(slotIndex, lane, 'kind', kind)
    await get().fetchSlots()
    return lane
  },

  async removeModulator(slotIndex, laneIndex) {
    await get().setModParam(slotIndex, laneIndex, 'kind', MOD_KIND_OFF)
  },

  // cut_min / cut_max are a pair on a dynamics lane; the engine already forces
  // min < max, but the UI enforces it too so the two knobs can never visually
  // cross. Writing one clamps it against the other's current value.
  async setCutMin(slotIndex, laneIndex, value) {
    const mod = get().slots[slotIndex]?.mods?.[laneIndex]
    const hi = mod ? Number(mod.cut_max) : 20000
    await get().setModParam(slotIndex, laneIndex, 'cut_min', Math.min(value, hi / 1.01))
  },

  async setCutMax(slotIndex, laneIndex, value) {
    const mod = get().slots[slotIndex]?.mods?.[laneIndex]
    const lo = mod ? Number(mod.cut_min) : 20
    await get().setModParam(slotIndex, laneIndex, 'cut_max', Math.max(value, lo * 1.01))
  },

  async fetchResponseCurve() {
    const t = get().target
    if (!t) return null
    try {
      return await window.xleth?.audio?.filterGetResponseCurve(t.trackId, t.nodeId)
    } catch { return null }
  },

  setSelectedSlot(index) {
    set({ selectedSlotIndex: index })
  },
}))

export default useFilterStore

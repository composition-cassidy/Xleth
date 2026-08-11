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
]

// slope param: 0 = 6 dB, 1 = 12 dB, 2 = 24 dB, 3 = 48 dB.
export const SLOPES = [
  { value: 0, label: '6' },
  { value: 1, label: '12' },
  { value: 2, label: '24' },
  { value: 3, label: '48' },
]

export const MAX_SLOTS = 8

// Which conditional controls a given slot type actually uses. Mirrors the
// engine's slopeApplies() / gain / morph gating so the panel never shows a knob
// that has no effect on the selected type.
export function typeUsesGain(type)  { return type === 5 || type === 6 || type === 7 }
export function typeUsesMorph(type) { return type === 8 }
export function typeUsesSlope(type) {
  return type === 0 || type === 1 || type === 2 || type === 3 || type === 8
}

const useFilterStore = create((set, get) => ({
  // { trackId, nodeId, storeKey } or null
  target: null,

  // [{ index, enabled, type, cutoff, q, gain, morph, slope, drive, mix,
  //    cut_min, cut_max, dyn_depth, dyn_attack, dyn_release,
  //    eff_cutoff, eff_q, dyn_env, dyn_accent }, ...]
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

  // cut_min / cut_max are a pair; the engine already forces min < max, but the
  // UI enforces it too so the two knobs can never visually cross. Writing one
  // clamps it against the other's current value.
  async setCutMin(slotIndex, value) {
    const slot = get().slots[slotIndex]
    const hi = slot ? Number(slot.cut_max) : 20000
    const clamped = Math.min(value, hi / 1.01)
    await get().setSlotParam(slotIndex, 'cut_min', clamped)
  },

  async setCutMax(slotIndex, value) {
    const slot = get().slots[slotIndex]
    const lo = slot ? Number(slot.cut_min) : 20
    const clamped = Math.max(value, lo * 1.01)
    await get().setSlotParam(slotIndex, 'cut_max', clamped)
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

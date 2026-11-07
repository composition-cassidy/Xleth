import { create } from 'zustand'
import { RESPONSE_SIZE } from '../components/mixer/eqGeometry.js'

export const BAND_TYPES = ['Bell', 'Low Shelf', 'High Shelf', 'Low Pass', 'High Pass', 'Notch', 'Tilt']
export const BAND_MODES = ['Static', 'Dynamic', 'Spectral']

// Per-band channel routing. 'stereo' is the default: the band processes the
// full stereo signal exactly as it always has. Array order IS the engine's
// b{i}_channel value (0=Stereo, 1=Left, 2=Right, 3=Mid, 4=Side) — it must stay
// in sync with XlethParametricEQ::ChannelMode.
export const CHANNEL_MODES = ['stereo', 'left', 'right', 'mid', 'side']
export const CHANNEL_META = {
  stereo: { label: 'Stereo', short: 'ST' },
  left:   { label: 'Left',   short: 'L' },
  right:  { label: 'Right',  short: 'R' },
  mid:    { label: 'Mid',    short: 'M' },
  side:   { label: 'Side',   short: 'S' },
}

// The engine's response-curve call returns one RESPONSE_SIZE-long dB trace per
// routing group, back to back in CHANNEL_MODES order. Split them into
// { stereo, left, right, mid, side }. A shorter buffer (an older engine build
// that only sends the single Stereo trace) yields just the traces it has.
export function splitResponseCurves(raw) {
  if (!raw || raw.length < RESPONSE_SIZE) return null
  const curves = {}
  CHANNEL_MODES.forEach((ch, k) => {
    const end = (k + 1) * RESPONSE_SIZE
    if (end <= raw.length) curves[ch] = raw.slice(k * RESPONSE_SIZE, end)
  })
  return curves
}

export const BAND_COLORS = [
  'var(--theme-eq-band-1)',  'var(--theme-eq-band-2)',  'var(--theme-eq-band-3)',  'var(--theme-eq-band-4)',
  'var(--theme-eq-band-5)',  'var(--theme-eq-band-6)',  'var(--theme-eq-band-7)',  'var(--theme-eq-band-8)',
  'var(--theme-eq-band-9)',  'var(--theme-eq-band-10)', 'var(--theme-eq-band-11)', 'var(--theme-eq-band-12)',
  'var(--theme-eq-band-13)', 'var(--theme-eq-band-14)', 'var(--theme-eq-band-15)', 'var(--theme-eq-band-16)',
]

// The store body is exported so a device can own a PRIVATE instance (the Devices
// tab hosts several EQs at once; the default store below tracks only the one
// open in a window). Same actions, same engine calls.
export const eqStoreInitializer = (set, get) => ({
  // { trackId, nodeId, storeKey } or null
  target: null,

  // [{ index, freq, gain, q, type, enabled, mode, dyn_thresh, dyn_ratio, dyn_attack, dyn_release, dyn_range, spec_sens, spec_sel }, ...]
  // Spectral bands have no spec_depth: `gain` is their signed depth.
  bands: [],

  // Global mode state
  linPhase: false,
  oversample: 0,      // 0=off, 1=2x, 2=4x
  preSpectrum: false,  // Pre-EQ spectrum display toggle
  dbZoom: 24,          // Response curve dB half-range: 6, 12, 24, or 48
  bandGR: null,        // Float32Array[16] polled at 30fps
  sampleRate: 44100,   // Engine sample rate for spectrum mapping

  // UI-local state (not synced to engine)
  selectedBandIndex: -1,
  themeFont: (() => { try { const s = localStorage.getItem('xleth.eq.theme'); return s ? (JSON.parse(s).font || '') : '' } catch { return '' } })(),
  themeFontScale: (() => { try { const s = localStorage.getItem('xleth.eq.theme'); return s ? (JSON.parse(s).fontScale ?? 1) : 1 } catch { return 1 } })(),

  // Polling data (mutated in-place by rAF, not reactive)
  responseCurve: null,   // { stereo, left, right, mid, side } of Float32Array(512)
  spectrumData: null,    // { post: Float32Array, pre: Float32Array | null }

  setDbZoom(value) {
    const allowed = [6, 12, 24, 48]
    if (allowed.includes(value)) set({ dbZoom: value })
  },

  open(trackId, nodeId, storeKey) {
    set({ target: { trackId, nodeId, storeKey }, bands: [], responseCurve: null, spectrumData: null, bandGR: null, linPhase: false, oversample: 0, preSpectrum: false, dbZoom: 24, sampleRate: 44100, selectedBandIndex: -1 })
    get().fetchBands()
    get().fetchGlobalParams()
    get().fetchSampleRate()
  },

  close() {
    set({ target: null, bands: [], responseCurve: null, spectrumData: null, bandGR: null, linPhase: false, oversample: 0, preSpectrum: false, dbZoom: 24, sampleRate: 44100, selectedBandIndex: -1 })
  },

  async fetchBands() {
    const t = get().target
    if (!t) return
    try {
      const raw = await window.xleth?.audio?.eqGetBands(t.trackId, t.nodeId)
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
      // The engine reports channel as the numeric ChannelMode; map it back to
      // the name the UI works in. Pre-routing saves omit it → 'stereo'.
      const bands = parsed.map(b => ({
        ...b,
        channel: CHANNEL_MODES[b?.channel] ?? 'stereo',
      }))
      set({ bands })
    } catch {}
  },

  async addBand() {
    const t = get().target
    if (!t) return
    await window.xleth?.audio?.eqAddBand(t.trackId, t.nodeId)
    await get().fetchBands()
  },

  async addBandAt(freq, gain, type = 0) {
    const t = get().target
    if (!t) return
    await window.xleth?.audio?.eqAddBand(t.trackId, t.nodeId)
    await get().fetchBands()
    const bands = get().bands
    const idx = bands.length - 1
    if (idx >= 0) {
      await get().setBandParam(idx, 'freq', freq)
      await get().setBandParam(idx, 'gain', gain)
      if (type !== 0) await get().setBandParam(idx, 'type', type)
    }
  },

  async removeBand(bandIndex) {
    const t = get().target
    if (!t) return
    // Optimistic remove
    set(s => ({ bands: s.bands.filter((_, i) => i !== bandIndex) }))
    await window.xleth?.audio?.eqRemoveBand(t.trackId, t.nodeId, bandIndex)
    await get().fetchBands()
  },

  async setBandParam(bandIndex, paramName, value) {
    const t = get().target
    if (!t) return
    // Optimistic
    set(s => {
      const bands = [...s.bands]
      if (bands[bandIndex]) bands[bandIndex] = { ...bands[bandIndex], [paramName]: value }
      return { bands }
    })
    await window.xleth?.audio?.eqSetBandParam(t.trackId, t.nodeId, bandIndex, paramName, value)
  },

  async setLinPhase(enabled) {
    const t = get().target
    if (!t) return
    set({ linPhase: enabled })
    await window.xleth?.audio?.eqSetGlobalParam(t.trackId, t.nodeId, 'linphase', enabled ? 1 : 0)
  },

  async setOversample(factor) {
    const t = get().target
    if (!t) return
    set({ oversample: factor })
    await window.xleth?.audio?.eqSetGlobalParam(t.trackId, t.nodeId, 'oversample', factor)
  },

  async setPreSpectrum(enabled) {
    const t = get().target
    if (!t) return
    set({ preSpectrum: enabled })
    await window.xleth?.audio?.eqSetPreSpectrum(t.trackId, t.nodeId, enabled ? 1 : 0)
  },

  async fetchGlobalParams() {
    const t = get().target
    if (!t) return
    try {
      const raw = await window.xleth?.audio?.eqGetGlobalParams(t.trackId, t.nodeId)
      const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || {})
      set({ linPhase: !!obj.linphase, oversample: obj.oversample || 0 })
    } catch {}
  },

  async fetchSampleRate() {
    const t = get().target
    if (!t) return
    try {
      const rate = await window.xleth?.audio?.eqGetSampleRate(t.trackId, t.nodeId)
      if (rate && rate > 0) set({ sampleRate: rate })
    } catch {}
  },

  // Returns { stereo, left, right, mid, side } of dB traces, or null.
  async fetchResponseCurve() {
    const t = get().target
    if (!t) return null
    try {
      return splitResponseCurves(await window.xleth?.audio?.eqGetResponseCurve(t.trackId, t.nodeId))
    } catch { return null }
  },

  // Returns { post: Float32Array, pre: Float32Array | null }
  async fetchSpectrumData() {
    const t = get().target
    if (!t) return null
    try {
      return await window.xleth?.audio?.eqGetSpectrumData(t.trackId, t.nodeId)
    } catch { return null }
  },

  async fetchBandGR() {
    const t = get().target
    if (!t) return null
    try {
      return await window.xleth?.audio?.eqGetBandGR(t.trackId, t.nodeId)
    } catch { return null }
  },

  // Per-band channel routing. Kept as a name in the store, sent to the engine
  // as the numeric ChannelMode (CHANNEL_MODES index).
  async setBandChannel(bandIndex, channel) {
    const t = get().target
    if (!t) return
    const value = CHANNEL_MODES.indexOf(channel)
    if (value < 0) return
    // Optimistic
    set(s => {
      const bands = [...s.bands]
      if (bands[bandIndex]) bands[bandIndex] = { ...bands[bandIndex], channel }
      return { bands }
    })
    await window.xleth?.audio?.eqSetBandParam(t.trackId, t.nodeId, bandIndex, 'channel', value)
  },

  setSelectedBand(index) {
    set({ selectedBandIndex: index })
    if (window.XLETH_DEBUG) console.log('[EQ-UI] band selected:', index)
  },

  setThemeFont(font) {
    set({ themeFont: font })
    try {
      const prev = JSON.parse(localStorage.getItem('xleth.eq.theme') || '{}')
      localStorage.setItem('xleth.eq.theme', JSON.stringify({ ...prev, font }))
    } catch {}
    if (window.XLETH_DEBUG) console.log('[EQ-UI] font applied:', font)
  },

  setThemeFontScale(fontScale) {
    set({ themeFontScale: fontScale })
    try {
      const prev = JSON.parse(localStorage.getItem('xleth.eq.theme') || '{}')
      localStorage.setItem('xleth.eq.theme', JSON.stringify({ ...prev, fontScale }))
    } catch {}
  },

  async duplicateBand(bandIndex) {
    const t = get().target
    if (!t) return
    const band = get().bands[bandIndex]
    if (!band) return
    await get().addBandAt(band.freq, band.gain, band.type)
    const newIdx = get().bands.length - 1
    if (newIdx < 0) return
    await get().setBandChannel(newIdx, band.channel || 'stereo')
    await get().setBandParam(newIdx, 'q', band.q)
    await get().setBandParam(newIdx, 'mode', band.mode)
    await get().setBandParam(newIdx, 'enabled', band.enabled)
    if (band.mode === 1) {
      for (const [p, v] of [
        ['dyn_thresh', band.dyn_thresh ?? -20],
        ['dyn_ratio', band.dyn_ratio ?? 4],
        ['dyn_attack', band.dyn_attack ?? 10],
        ['dyn_release', band.dyn_release ?? 100],
        ['dyn_range', band.dyn_range ?? 12],
      ]) await get().setBandParam(newIdx, p, v)
    } else if (band.mode === 2) {
      const specParams = [
        ['spec_sens', band.spec_sens ?? 0.5],
        ['spec_sel', band.spec_sel ?? 5],
      ]
      if (band.spec_attack != null) specParams.push(['spec_attack', band.spec_attack])
      if (band.spec_release != null) specParams.push(['spec_release', band.spec_release])
      for (const [p, v] of specParams) await get().setBandParam(newIdx, p, v)
    }
  },
})

const useEqStore = create(eqStoreInitializer)

export default useEqStore

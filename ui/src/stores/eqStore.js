import { create } from 'zustand'

export const BAND_TYPES = ['Bell', 'Low Shelf', 'High Shelf', 'Low Pass', 'High Pass', 'Notch', 'Tilt']
export const BAND_MODES = ['Static', 'Dynamic', 'Spectral']

export const BAND_COLORS = [
  '#33CED6', '#FF6B6B', '#69DB7C', '#FFA94D',
  '#748FFC', '#B197FC', '#FFD93D', '#FF6B9D',
  '#4ECDC4', '#FC5C65', '#45AAF2', '#FED330',
  '#A55EEA', '#26DE81', '#FD9644', '#2BCBBA',
]

const useEqStore = create((set, get) => ({
  // { trackId, nodeId, storeKey } or null
  target: null,

  // [{ index, freq, gain, q, type, enabled, mode, dyn_thresh, dyn_ratio, dyn_attack, dyn_release, spec_sens, spec_depth, spec_sel }, ...]
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
  responseCurve: null,   // Float32Array(512)
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
      const bands = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
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

  async fetchResponseCurve() {
    const t = get().target
    if (!t) return null
    try {
      return await window.xleth?.audio?.eqGetResponseCurve(t.trackId, t.nodeId)
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
    await get().setBandParam(newIdx, 'q', band.q)
    await get().setBandParam(newIdx, 'mode', band.mode)
    await get().setBandParam(newIdx, 'enabled', band.enabled)
    if (band.mode === 1) {
      for (const [p, v] of [
        ['dyn_thresh', band.dyn_thresh ?? -20],
        ['dyn_ratio', band.dyn_ratio ?? 4],
        ['dyn_attack', band.dyn_attack ?? 10],
        ['dyn_release', band.dyn_release ?? 100],
      ]) await get().setBandParam(newIdx, p, v)
    } else if (band.mode === 2) {
      const specParams = [
        ['spec_sens', band.spec_sens ?? 0.5],
        ['spec_depth', band.spec_depth ?? 0],
        ['spec_sel', band.spec_sel ?? 5],
      ]
      if (band.spec_attack != null) specParams.push(['spec_attack', band.spec_attack])
      if (band.spec_release != null) specParams.push(['spec_release', band.spec_release])
      for (const [p, v] of specParams) await get().setBandParam(newIdx, p, v)
    }
  },
}))

export default useEqStore

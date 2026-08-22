import { create } from 'zustand'

// ─── Sample Sandbox session store ──────────────────────────────────────────
//
// The SB-2 bridge (window.xleth.sandbox.*) is command-only — open/stackAdd/
// stackRemove/stackReorder/stackSetParam/stackSetBypassed all return just an
// id or {success}, never the resulting stack. There is no sandbox_getLayer.
// So this store IS the UI's copy of layer/stack state: every mutation below
// calls the bridge first and only applies the equivalent edit locally once
// the bridge confirms it, mirroring the shape SandboxOp::opToJson writes
// ({id, type, params, enabled}). If the bridge call fails or is rejected, the
// local copy is left untouched — it can never drift into a state the engine
// didn't also accept.
//
// One SandboxCore can hold N layers; this store holds the same N as a flat
// array plus an `activeLayerId` the panel UI points its canvas/stack views at.

const pollTimers = new Map() // layerId -> timeout handle, not store state (not serializable)

function stopPolling(layerId) {
  const t = pollTimers.get(layerId)
  if (t != null) {
    clearTimeout(t)
    pollTimers.delete(layerId)
  }
}

// Interleaved float32 Buffer -> per-channel Float32Array, for canvas draw.
function deinterleave(data, numChannels, numSamples) {
  const channels = []
  for (let ch = 0; ch < numChannels; ch++) channels.push(new Float32Array(numSamples))
  // `data` arrives as a Node Buffer over IPC; Float32Array needs a 4-byte-
  // aligned ArrayBuffer view, so read through a DataView instead of assuming
  // the Buffer's own .buffer is aligned/sized to just this payload.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 0
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      channels[ch][i] = view.getFloat32(o, true)
      o += 4
    }
  }
  return channels
}

const POLL_MS = 150
const POLL_MAX_ATTEMPTS = 200 // ~30s ceiling — a stuck render surfaces as an error, not a silent hang

function makeLayer({ layerId, name, sourceBufferId, bufferSampleRate, region }) {
  return {
    id: layerId,
    name,
    sourceBufferId,
    bufferSampleRate,
    // Region metadata purely for the mini-waveform thumbnail + display — the
    // engine doesn't need it, it already has sourceBufferId.
    sourceFilePath: region?.audioFilePath ?? null,
    sourceStartTime: region?.startTime ?? null,
    sourceEndTime: region?.endTime ?? null,
    ops: [],
    muted: false,
    soloed: false,
    renderState: 'idle', // 'idle' | 'rendering' | 'ready' | 'error'
    renderedBuffer: null, // { numChannels, numSamples, sampleRate, channels: Float32Array[] }
    bakeState: 'idle', // 'idle' | 'baking' | 'baked' | 'error'
    swapInState: 'idle', // 'idle' | 'unavailable'
    undoDepth: 0,
    error: null,
  }
}

const useSandboxStore = create((set, get) => ({
  layers: [],
  activeLayerId: null,
  activeTool: 'select', // 'select' | 'chop' | 'trim' | 'fade' — SB-3 shell: display only
  selection: null, // { startSample, endSample } in the active layer's rendered buffer

  // ── Layer lifecycle ────────────────────────────────────────────────────

  // `region` is a Sample Selector marked-region: { id, sourceId, name,
  // startTime, endTime, audioFilePath? }. Resolves a SampleBank sourceRef via
  // audio.loadSourceRegion, then opens a sandbox layer against it.
  async addSourceFromRegion(region) {
    if (!region) return
    try {
      let filePath = region.audioFilePath ?? null
      if (!filePath && region.sourceId != null) {
        const sources = (await window.xleth?.timeline?.getSources?.()) ?? []
        const src = sources.find((s) => s.id === region.sourceId)
        filePath = src?.filePath ?? null
      }
      if (!filePath) throw new Error('No source file for this region')

      const sourceRef = await window.xleth?.audio?.loadSourceRegion(
        filePath, region.startTime, region.endTime,
      )
      if (sourceRef == null || sourceRef < 0) throw new Error('Could not load source audio')

      const res = await window.xleth?.sandbox?.open(sourceRef, region.name)
      if (!res?.success) throw new Error(res?.reason || 'sandbox.open failed')

      const layer = makeLayer({
        layerId: res.layerId,
        name: res.name,
        sourceBufferId: res.sourceBufferId,
        bufferSampleRate: res.bufferSampleRate,
        region: { ...region, audioFilePath: filePath },
      })
      set((state) => ({ layers: [...state.layers, layer], activeLayerId: layer.id, selection: null }))
      get().renderLayer(layer.id, 'open')
    } catch (e) {
      console.warn('[SampleSandbox] addSourceFromRegion failed:', e?.message || e)
    }
  },

  async closeLayer(layerId) {
    stopPolling(layerId)
    try {
      await window.xleth?.sandbox?.close(layerId)
    } catch (e) {
      console.warn('[SampleSandbox] close failed:', e?.message || e)
    }
    set((state) => {
      const layers = state.layers.filter((l) => l.id !== layerId)
      const activeLayerId = state.activeLayerId === layerId
        ? (layers[0]?.id ?? null)
        : state.activeLayerId
      return { layers, activeLayerId, selection: activeLayerId === state.activeLayerId ? state.selection : null }
    })
  },

  setActiveLayer(layerId) {
    if (get().activeLayerId === layerId) return
    set({ activeLayerId: layerId, selection: null })
  },

  // Local-only for now — SandboxCore has setLayerMuted/setLayerSoloed but SB-2
  // does not expose them as RPC yet (only stack + open/close/render/bake are
  // wired). Toggling here previews the intent in the UI without pretending
  // the engine already knows about it.
  toggleMute(layerId) {
    set((state) => ({
      layers: state.layers.map((l) => (l.id === layerId ? { ...l, muted: !l.muted } : l)),
    }))
  },
  toggleSolo(layerId) {
    set((state) => ({
      layers: state.layers.map((l) => (l.id === layerId ? { ...l, soloed: !l.soloed } : l)),
    }))
  },

  // ── Selection / tool (canvas UI state) ─────────────────────────────────

  setActiveTool(tool) { set({ activeTool: tool }) },
  setSelection(selection) { set({ selection }) },
  clearSelection() { set({ selection: null }) },

  // ── Render / poll ───────────────────────────────────────────────────────

  patchLayer(layerId, patch) {
    set((state) => ({
      layers: state.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
    }))
  },

  async renderLayer(layerId, trigger = 'manual') {
    stopPolling(layerId)
    get().patchLayer(layerId, { renderState: 'rendering', error: null })
    try {
      const res = await window.xleth?.sandbox?.render(layerId, trigger)
      if (!res?.success) throw new Error(res?.reason || 'render rejected')
    } catch (e) {
      get().patchLayer(layerId, { renderState: 'error', error: e?.message || String(e) })
      return
    }
    get()._pollRenderedBuffer(layerId, 0)
  },

  async _pollRenderedBuffer(layerId, attempt) {
    if (!get().layers.some((l) => l.id === layerId)) return // closed mid-poll
    try {
      const res = await window.xleth?.sandbox?.getRenderedBuffer(layerId)
      if (res?.ready) {
        const channels = deinterleave(res.data, res.numChannels, res.numSamples)
        get().patchLayer(layerId, {
          renderState: 'ready',
          renderedBuffer: {
            numChannels: res.numChannels,
            numSamples: res.numSamples,
            sampleRate: res.sampleRate,
            channels,
          },
          error: null,
        })
        return
      }
    } catch (e) {
      get().patchLayer(layerId, { renderState: 'error', error: e?.message || String(e) })
      return
    }
    if (attempt >= POLL_MAX_ATTEMPTS) {
      get().patchLayer(layerId, { renderState: 'error', error: 'Render timed out' })
      return
    }
    const timer = setTimeout(() => get()._pollRenderedBuffer(layerId, attempt + 1), POLL_MS)
    pollTimers.set(layerId, timer)
  },

  // ── Op stack ─────────────────────────────────────────────────────────────
  // Every mutator below is optimistic-after-confirm: the bridge call happens
  // first, and the local `ops` array is only touched once it succeeds — see
  // the file header. A render is kicked off after each accepted edit so the
  // canvas + status bar track the stack.

  async addOp(layerId, op, index = -1) {
    try {
      const res = await window.xleth?.sandbox?.stackAdd(layerId, op, index)
      if (!res?.success) throw new Error(res?.reason || 'stackAdd rejected')
      set((state) => ({
        layers: state.layers.map((l) => {
          if (l.id !== layerId) return l
          const ops = l.ops.slice()
          const entry = { id: res.opId, type: op.type, params: op.params, enabled: op.enabled ?? true }
          if (index < 0 || index >= ops.length) ops.push(entry)
          else ops.splice(index, 0, entry)
          return { ...l, ops, undoDepth: l.undoDepth + 1 }
        }),
      }))
      get().renderLayer(layerId, 'stackAdd')
    } catch (e) {
      console.warn('[SampleSandbox] addOp failed:', e?.message || e)
    }
  },

  async removeOp(layerId, opId) {
    try {
      const res = await window.xleth?.sandbox?.stackRemove(layerId, opId)
      if (!res?.success) throw new Error(res?.reason || 'stackRemove rejected')
      set((state) => ({
        layers: state.layers.map((l) => (l.id !== layerId ? l : {
          ...l,
          ops: l.ops.filter((o) => o.id !== opId),
          undoDepth: l.undoDepth + 1,
        })),
      }))
      get().renderLayer(layerId, 'stackRemove')
    } catch (e) {
      console.warn('[SampleSandbox] removeOp failed:', e?.message || e)
    }
  },

  async reorderOp(layerId, fromIndex, toIndex) {
    try {
      const res = await window.xleth?.sandbox?.stackReorder(layerId, fromIndex, toIndex)
      if (!res?.success) throw new Error(res?.reason || 'stackReorder rejected')
      set((state) => ({
        layers: state.layers.map((l) => {
          if (l.id !== layerId) return l
          const ops = l.ops.slice()
          const [moved] = ops.splice(fromIndex, 1)
          ops.splice(toIndex, 0, moved)
          return { ...l, ops, undoDepth: l.undoDepth + 1 }
        }),
      }))
      get().renderLayer(layerId, 'stackReorder')
    } catch (e) {
      console.warn('[SampleSandbox] reorderOp failed:', e?.message || e)
    }
  },

  async setOpParams(layerId, opId, params) {
    const layer = get().layers.find((l) => l.id === layerId)
    const existing = layer?.ops.find((o) => o.id === opId)
    if (!existing) return
    try {
      const res = await window.xleth?.sandbox?.stackSetParam(layerId, opId, { type: existing.type, params })
      if (!res?.success) throw new Error(res?.reason || 'stackSetParam rejected')
      set((state) => ({
        layers: state.layers.map((l) => (l.id !== layerId ? l : {
          ...l,
          ops: l.ops.map((o) => (o.id === opId ? { ...o, params } : o)),
          undoDepth: l.undoDepth + 1,
        })),
      }))
      get().renderLayer(layerId, 'stackSetParam')
    } catch (e) {
      console.warn('[SampleSandbox] setOpParams failed:', e?.message || e)
    }
  },

  async setOpBypassed(layerId, opId, bypassed) {
    try {
      const res = await window.xleth?.sandbox?.stackSetBypassed(layerId, opId, bypassed)
      if (!res?.success) throw new Error(res?.reason || 'stackSetBypassed rejected')
      set((state) => ({
        layers: state.layers.map((l) => (l.id !== layerId ? l : {
          ...l,
          ops: l.ops.map((o) => (o.id === opId ? { ...o, enabled: !bypassed } : o)),
          undoDepth: l.undoDepth + 1,
        })),
      }))
      get().renderLayer(layerId, 'stackSetBypassed')
    } catch (e) {
      console.warn('[SampleSandbox] setOpBypassed failed:', e?.message || e)
    }
  },

  // ── Bake / swap-in ──────────────────────────────────────────────────────

  async bakeLayer(layerId) {
    get().patchLayer(layerId, { bakeState: 'baking' })
    try {
      const res = await window.xleth?.sandbox?.bake(layerId)
      if (!res?.success) throw new Error(res?.reason || 'bake rejected')
      get().patchLayer(layerId, { bakeState: 'baked' })
    } catch (e) {
      console.warn('[SampleSandbox] bake failed:', e?.message || e)
      get().patchLayer(layerId, { bakeState: 'error', error: e?.message || String(e) })
    }
  },

  // SB-6 (swap-in + persistence) hasn't landed — there is no bridge method to
  // call yet. Wired as a stub so the button and its state machine are already
  // in place; flip this to a real bridge.sandbox.swapIn(layerId) call once it
  // exists.
  swapInLayer(layerId) {
    if (!window.xleth?.sandbox?.swapIn) {
      get().patchLayer(layerId, { swapInState: 'unavailable' })
      console.info('[SampleSandbox] Swap In is a stub — SB-6 has not landed yet.')
      return
    }
    window.xleth.sandbox.swapIn(layerId)
  },
}))

export default useSandboxStore

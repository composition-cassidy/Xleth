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

// Mirrors xleth::sandbox::SandboxRippleMode / SandboxFadeShape (SandboxOp.h).
// JSON writes/reads the int, never a name, for these two enums — unlike op
// TYPE, which is a registry name (see opTypeName in SandboxOp.cpp).
export const RIPPLE_MODE = { ripple: 0, gap: 1 }
export const FADE_SHAPE = {
  linear: 0, equalPower: 1, exponential: 2, logarithmic: 3, sCurve: 4, hann: 5,
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
    // Mix params (SB-5) — live OUTSIDE the op-stack, applied at composite time.
    // Mirrors SandboxLayer's own defaults (SandboxCore.h).
    gainDb: 0,
    pan: 0,
    offsetSamples: 0,
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
  activeTool: 'select',
  selection: null, // { startSample, endSample } in the active layer's rendered buffer
  clipboard: null, // { clipboardId, numSamples } — session-local, from copySelection/cutSelection

  // ── Composite (SB-5) — mix of every layer's own render by its mix params ──
  composite: {
    renderState: 'idle', // 'idle' | 'rendering' | 'ready' | 'error'
    renderedBuffer: null, // { numChannels, numSamples, sampleRate, channels: Float32Array[], layersMixed }
    error: null,
  },
  bakeCompositeState: 'idle', // 'idle' | 'baking' | 'baked' | 'error'
  bakeCompositeError: null,
  bakedAssets: [], // [{ sampleId, name }] — this session's composite bakes, addable back as a source

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

  // Bridge-backed mute/solo (SB-5) — same optimistic-after-confirm contract as
  // every other mutator in this file: the bridge call happens first, and the
  // local flag only flips once the engine accepts it.
  async setLayerMuted(layerId, muted) {
    try {
      const res = await window.xleth?.sandbox?.setLayerMuted(layerId, muted)
      if (!res?.success) throw new Error(res?.reason || 'setLayerMuted rejected')
      set((state) => ({
        layers: state.layers.map((l) => (l.id === layerId ? { ...l, muted } : l)),
      }))
    } catch (e) {
      console.warn('[SampleSandbox] setLayerMuted failed:', e?.message || e)
    }
  },
  toggleMute(layerId) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (layer) get().setLayerMuted(layerId, !layer.muted)
  },

  async setLayerSoloed(layerId, soloed) {
    try {
      const res = await window.xleth?.sandbox?.setLayerSoloed(layerId, soloed)
      if (!res?.success) throw new Error(res?.reason || 'setLayerSoloed rejected')
      set((state) => ({
        layers: state.layers.map((l) => (l.id === layerId ? { ...l, soloed } : l)),
      }))
    } catch (e) {
      console.warn('[SampleSandbox] setLayerSoloed failed:', e?.message || e)
    }
  },
  toggleSolo(layerId) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (layer) get().setLayerSoloed(layerId, !layer.soloed)
  },

  // Gain (dB) / pan (-1..1) / offset (ms, converted to samples at the layer's
  // own bufferSampleRate) — mix params live OUTSIDE the op-stack, so this
  // never triggers a re-render of the layer itself. `patch` may set any
  // subset of { gainDb, pan, offsetMs }; omitted fields keep their current
  // value.
  async setLayerMix(layerId, patch) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer) return
    const gainDb = patch.gainDb ?? layer.gainDb ?? 0
    const pan = patch.pan ?? layer.pan ?? 0
    const offsetSamples = patch.offsetMs != null
      ? Math.round((patch.offsetMs / 1000) * (layer.bufferSampleRate || 0))
      : (layer.offsetSamples ?? 0)
    try {
      const res = await window.xleth?.sandbox?.setLayerMix(layerId, gainDb, pan, offsetSamples)
      if (!res?.success) throw new Error(res?.reason || 'setLayerMix rejected')
      set((state) => ({
        layers: state.layers.map((l) => (l.id === layerId ? { ...l, gainDb, pan, offsetSamples } : l)),
      }))
    } catch (e) {
      console.warn('[SampleSandbox] setLayerMix failed:', e?.message || e)
    }
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
      // Any accepted stack mutation is about to change the rendered buffer
      // out from under the current selection's sample indices, so it no
      // longer means anything concrete — clear it rather than let the
      // waveform show a stale overlay. COPY does not go through this path
      // (it doesn't mutate the stack), so copying deliberately preserves the
      // selection for a follow-up Cut/Trim on the same range.
      get().clearSelection()
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

  // ── Core edit ops (SB-4) ─────────────────────────────────────────────────
  // Every tool below composes the SAME two primitives everything else in this
  // file already uses — addOp (generic sandbox_stackAdd) and, for
  // clipboard-aware tools, the new sandbox_copySelection bridge call. There is
  // no dedicated engine op or command per tool: CUT is a copy followed by a
  // Cut op over the same range, PASTE and INSERT SILENCE are both a Paste op
  // (clipboardId: -1 means "no material" — the renderer fills it with
  // silence), and TRIM/REVERSE/FADE/GAIN/NORMALIZE/SPLICE/CROSSFADE are one
  // addOp each with the params the op type expects (see SandboxOp.h).

  // The engine reads straight from the layer's CURRENT published render, so
  // the clipboard is always cut from what the user actually sees selected,
  // not from the raw, unedited source.
  async copySelection(layerId) {
    const sel = get().selection
    if (!sel) return null
    try {
      const res = await window.xleth?.sandbox?.copySelection(layerId, sel.startSample, sel.endSample)
      if (!res?.success) throw new Error(res?.reason || 'copySelection rejected')
      const clipboard = { clipboardId: res.clipboardId, numSamples: res.numSamples }
      set({ clipboard })
      return clipboard
    } catch (e) {
      console.warn('[SampleSandbox] copySelection failed:', e?.message || e)
      return null
    }
  },

  // CUT = copy the selection to the clipboard, then remove it with a Cut op.
  // The copy happens first so a paste right after a cut always has material,
  // matching what every other sample editor's Cut does.
  async cutSelection(layerId, mode = 'ripple') {
    const sel = get().selection
    if (!sel) return
    const clipboard = await get().copySelection(layerId)
    if (!clipboard) return
    // addOp() clears the selection itself once accepted — no need to repeat
    // it here.
    await get().addOp(layerId, {
      type: 'cut',
      params: { startSample: sel.startSample, endSample: sel.endSample, mode: RIPPLE_MODE[mode] ?? RIPPLE_MODE.ripple },
    })
  },

  // PASTE — inserts (or overwrites with) whatever is currently on the
  // clipboard. `atSample` defaults to the selection's start, i.e. "paste at
  // the point I have selected/scrubbed to."
  async pasteClipboard(layerId, atSample, insert = true) {
    const clipboard = get().clipboard
    if (!clipboard) return
    const at = atSample ?? get().selection?.startSample ?? 0
    await get().addOp(layerId, {
      type: 'paste',
      params: { atSample: at, clipboardId: clipboard.clipboardId, clipboardLengthSamples: clipboard.numSamples, insert },
    })
  },

  // INSERT SILENCE / SILENCE — a Paste op with clipboardId: -1, so the
  // renderer has nothing to resolve and fills the range with silence. `insert`
  // decides which of the two the toolbar's two buttons means: true grows the
  // buffer (INSERT SILENCE), false mutes the range in place (SILENCE).
  async insertSilence(layerId, atSample, lengthSamples, insert = true) {
    if (!(lengthSamples > 0)) return
    await get().addOp(layerId, {
      type: 'paste',
      params: { atSample, clipboardId: -1, clipboardLengthSamples: lengthSamples, insert },
    })
  },

  // SPLICE — split at `atSample` and swap the two halves. `gapSamples` is
  // only consulted in 'gap' mode.
  async spliceAtCursor(layerId, atSample, mode = 'ripple', gapSamples = 0) {
    await get().addOp(layerId, {
      type: 'splice',
      params: { atSample, mode: RIPPLE_MODE[mode] ?? RIPPLE_MODE.ripple, gapSamples },
    })
  },

  // REVERSE over the current selection (or the whole buffer if none).
  async reverseSelection(layerId) {
    const sel = get().selection
    await get().addOp(layerId, {
      type: 'reverse',
      params: { startSample: sel?.startSample ?? 0, endSample: sel?.endSample ?? -1 },
    })
  },

  // FADE IN/OUT across the current selection. `shape` is one of FADE_SHAPE's
  // keys — the toolbar exposes this as a <select>, satisfying "adjustable
  // curve shapes."
  async fadeSelection(layerId, fadeIn, shape = 'equalPower') {
    const sel = get().selection
    if (!sel) return
    await get().addOp(layerId, {
      type: 'fade',
      params: {
        startSample: sel.startSample,
        lengthSamples: sel.endSample - sel.startSample,
        shape: FADE_SHAPE[shape] ?? FADE_SHAPE.equalPower,
        fadeIn,
      },
    })
  },

  // GAIN over the current selection (or the whole buffer if none).
  async gainSelection(layerId, gainDb) {
    const sel = get().selection
    await get().addOp(layerId, {
      type: 'gain',
      params: { startSample: sel?.startSample ?? 0, endSample: sel?.endSample ?? -1, gainDb, normalize: false, targetPeakDb: 0 },
    })
  },

  // NORMALIZE the current selection (or the whole buffer) so its peak lands
  // on targetPeakDb.
  async normalizeSelection(layerId, targetPeakDb) {
    const sel = get().selection
    await get().addOp(layerId, {
      type: 'gain',
      params: { startSample: sel?.startSample ?? 0, endSample: sel?.endSample ?? -1, gainDb: 0, normalize: true, targetPeakDb },
    })
  },

  // CROSSFADE — declicks a seam at the selection's start (or the whole
  // buffer's start, absent one) across `lengthSamples`.
  async crossfadeAtCursor(layerId, atSample, lengthSamples, shape = 'hann') {
    if (!(lengthSamples > 0)) return
    await get().addOp(layerId, {
      type: 'crossfade',
      params: { atSample, lengthSamples, shape: FADE_SHAPE[shape] ?? FADE_SHAPE.hann },
    })
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

  // ── Composite (SB-5) ────────────────────────────────────────────────────
  // renderComposite mixes every CURRENT layer's own published render by its
  // mix params — requires each layer to already be rendered (renderLayer /
  // the auto-render every stack edit already triggers). bakeComposite renders
  // fresh and registers a brand-new SampleBank asset in one undoable engine
  // step; it does not read composite.renderedBuffer, so a bake is always the
  // CURRENT state even if the preview hasn't been re-rendered since the last
  // mix tweak.

  async renderComposite() {
    set((state) => ({ composite: { ...state.composite, renderState: 'rendering', error: null } }))
    try {
      const res = await window.xleth?.sandbox?.renderComposite()
      if (!res?.ready) throw new Error(res?.reason || 'composite render rejected')
      const channels = deinterleave(res.data, res.numChannels, res.numSamples)
      set({
        composite: {
          renderState: 'ready',
          renderedBuffer: {
            numChannels: res.numChannels,
            numSamples: res.numSamples,
            sampleRate: res.sampleRate,
            layersMixed: res.layersMixed,
            channels,
          },
          error: null,
        },
      })
    } catch (e) {
      set({ composite: { renderState: 'error', renderedBuffer: null, error: e?.message || String(e) } })
    }
  },

  async bakeComposite(name) {
    set({ bakeCompositeState: 'baking', bakeCompositeError: null })
    try {
      const res = await window.xleth?.sandbox?.bakeComposite(name)
      if (!res?.success) throw new Error(res?.reason || 'bakeComposite rejected')
      set((state) => ({
        bakeCompositeState: 'baked',
        bakedAssets: [...state.bakedAssets, { sampleId: res.sampleId, name: res.name }],
      }))
      return res
    } catch (e) {
      console.warn('[SampleSandbox] bakeComposite failed:', e?.message || e)
      set({ bakeCompositeState: 'error', bakeCompositeError: e?.message || String(e) })
      return null
    }
  },

  // Adds a baked asset back into the workspace as an ordinary new layer — the
  // "(3) ... baked asset can be added back as a source" requirement. `sampleId`
  // is already a SampleBank id (bakeComposite just registered it), so this
  // skips addSourceFromRegion's loadSourceRegion step and calls sandbox.open
  // directly, same as that function's own back half.
  async addBakedAssetAsSource(sampleId, name) {
    try {
      const res = await window.xleth?.sandbox?.open(sampleId, name)
      if (!res?.success) throw new Error(res?.reason || 'sandbox.open failed')
      const layer = makeLayer({
        layerId: res.layerId,
        name: res.name,
        sourceBufferId: res.sourceBufferId,
        bufferSampleRate: res.bufferSampleRate,
        region: null,
      })
      set((state) => ({ layers: [...state.layers, layer], activeLayerId: layer.id, selection: null }))
      get().renderLayer(layer.id, 'open')
    } catch (e) {
      console.warn('[SampleSandbox] addBakedAssetAsSource failed:', e?.message || e)
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

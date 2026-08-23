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
    // Region metadata. sourceFilePath/Start/End double as the layer's DURABLE
    // source reference (SB-6): they are what sandbox_open passes to the engine
    // so a saved workspace can re-resolve its audio, since a SampleBank id is
    // minted fresh on every project load. sourceRegionId is the swap TARGET —
    // the timeline region this layer's audio came from, and so the binding
    // "Swap In" replaces by default.
    sourceFilePath: region?.audioFilePath ?? null,
    sourceStartTime: region?.startTime ?? null,
    sourceEndTime: region?.endTime ?? null,
    sourceRegionId: region?.id ?? null,
    // Display name of the SWAP IN target — the layer's own name usually
    // matches it (sandbox.open is called with the region's name), but a
    // layer bound later via the target picker (cold-open case) points at a
    // region that has nothing to do with this layer's own name.
    swapTargetName: region?.name ?? null,
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
    swapInState: 'idle', // 'idle' | 'swapping' | 'swapped' | 'error'
    swapInError: null,
    // Last accepted swap, for the status readout: { sampleId, previousSampleId,
    // swappedPath, samplers, clips }.
    lastSwap: null,
    error: null,
  }
}

// SandboxCore::toJson() layer → this store's layer shape. Used wherever the
// engine hands back a whole workspace instead of confirming one mutation:
// project load and sandbox undo/redo. Render-side fields (renderedBuffer,
// renderState, …) are NOT in the engine's JSON — they are per-session and are
// re-established by the render that follows.
function layerFromWorkspace(wl, previous) {
  const base = makeLayer({
    layerId: wl.id,
    name: wl.name,
    sourceBufferId: wl.sourceBufferId,
    bufferSampleRate: wl.bufferSampleRate,
    region: null,
  })
  return {
    ...base,
    // Keep whatever the previous local copy knew that the engine does not
    // track (rendered buffer, region id) so a re-seed is not a downgrade.
    ...(previous
      ? {
          renderState: previous.renderState,
          renderedBuffer: previous.renderedBuffer,
          sourceRegionId: previous.sourceRegionId,
          swapTargetName: previous.swapTargetName,
          lastSwap: previous.lastSwap,
        }
      : {}),
    sourceFilePath: wl.sourceFilePath || null,
    sourceStartTime: wl.sourceStartTime ?? null,
    sourceEndTime: wl.sourceEndTime ?? null,
    ops: (wl.ops ?? []).map((o) => ({
      id: o.id, type: o.type, params: o.params, enabled: o.enabled !== false,
    })),
    gainDb: wl.gainDb ?? 0,
    pan: wl.pan ?? 0,
    offsetSamples: wl.offsetSamples ?? 0,
    muted: !!wl.muted,
    soloed: !!wl.soloed,
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

  // ── Shared-undo-stack mirror (SB-6) ──────────────────────────────────────
  // The engine has ONE UndoManager for the whole app. `undoDomain` says whose
  // edit is next in line, which is what lets the panel disable its own Undo
  // (or explain itself) instead of undoing a timeline edit.
  history: {
    canUndo: false,
    canRedo: false,
    undoDomain: '',
    redoDomain: '',
    undoDescription: '',
    redoDescription: '',
    sandboxUndoCount: 0,
  },
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

      // Third argument is the DURABLE source reference — without it a saved
      // workspace reopens unbound, because the SampleBank id above is minted
      // fresh on every project load.
      const res = await window.xleth?.sandbox?.open(sourceRef, region.name, {
        filePath, startTime: region.startTime, endTime: region.endTime,
      })
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
      get().refreshHistory()
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
    get().refreshHistory()
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
      get().refreshHistory()
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
      get().refreshHistory()
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
      get().refreshHistory()
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
          return { ...l, ops }
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
      get().refreshHistory()
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
        })),
      }))
      get().renderLayer(layerId, 'stackRemove')
      get().refreshHistory()
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
          return { ...l, ops }
        }),
      }))
      get().renderLayer(layerId, 'stackReorder')
      get().refreshHistory()
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
        })),
      }))
      get().renderLayer(layerId, 'stackSetParam')
      get().refreshHistory()
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
        })),
      }))
      get().renderLayer(layerId, 'stackSetBypassed')
      get().refreshHistory()
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
      get().refreshHistory()
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
      get().refreshHistory()
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
      get().refreshHistory()
    } catch (e) {
      console.warn('[SampleSandbox] addBakedAssetAsSource failed:', e?.message || e)
    }
  },

  // ── Swap In (SB-6) ───────────────────────────────────────────────────────
  // Replaces the sample bound to {trackId, regionId} with this layer's current
  // render. `target` defaults to the layer's OWN source region and no track
  // (-1), which is the case the panel's SWAP IN button means: "put this back
  // where it came from".
  //
  // The engine's binding is region-scoped, so one swap updates every placed
  // instance — every pattern-track sampler and every clip on that region. That
  // is the point of the feature, not a side effect; `lastSwap` records how many
  // so the panel can state it rather than imply it. See sandbox_swapIn's own
  // header comment in XlethEngineService.cpp for why trackId cannot narrow it.
  async swapInLayer(layerId, target = {}) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer) return null
    const regionId = target.regionId ?? layer.sourceRegionId
    if (regionId == null) {
      get().patchLayer(layerId, {
        swapInState: 'error',
        swapInError: 'This layer has no source region to swap back into.',
      })
      return null
    }
    const trackId = target.trackId ?? -1
    // A target passed explicitly (the picker's pick) wins; otherwise keep
    // whatever this layer is already bound to, so a re-swap to the same
    // target keeps its display name too.
    const targetName = target.name ?? layer.swapTargetName ?? null

    get().patchLayer(layerId, { swapInState: 'swapping', swapInError: null })
    try {
      const opts = targetName ? { name: targetName } : undefined
      const res = await window.xleth?.sandbox?.swapIn(layerId, trackId, regionId, opts)
      if (!res?.success) throw new Error(res?.reason || 'swapIn rejected')
      get().patchLayer(layerId, {
        swapInState: 'swapped',
        swapInError: null,
        // A picker-driven swap BINDS the session to this target — the next
        // plain "SWAP IN" click (no explicit target) goes to the same place.
        sourceRegionId: regionId,
        swapTargetName: targetName,
        lastSwap: {
          sampleId: res.sampleId,
          previousSampleId: res.previousSampleId,
          swappedPath: res.swappedPath,
          samplers: res.instancesUpdated?.samplers ?? 0,
          clips: res.instancesUpdated?.clips ?? 0,
        },
      })
      await get().refreshHistory()
      return res
    } catch (e) {
      console.warn('[SampleSandbox] swapIn failed:', e?.message || e)
      get().patchLayer(layerId, { swapInState: 'error', swapInError: e?.message || String(e) })
      return null
    }
  },

  // ── Session undo / redo (SB-6) ───────────────────────────────────────────
  // There is ONE undo stack in the engine, shared with the Timeline. These call
  // the sandbox-scoped wrappers, which refuse when the entry on top is a
  // timeline edit — so the panel's Undo button can never quietly move a clip.
  // `applied:false` with a `reason` is the normal, expected answer in that
  // case, not an error.
  //
  // Both re-seed the whole layer list from the workspace the engine returns.
  // Patching locally is not an option: this store's copy was built by echoing
  // its own mutations, and an undo is precisely the event it did not issue.
  async _applyUndoRedo(which) {
    try {
      const res = await window.xleth?.sandbox?.[which]?.()
      if (!res) return null
      if (res.workspace) get().hydrateFromWorkspace(res.workspace)
      if (res.applied) {
        // Every layer's render is now stale — the stack it was made from moved.
        for (const l of get().layers) {
          if (l.sourceBufferId >= 0) get().renderLayer(l.id, which)
        }
      }
      await get().refreshHistory()
      return res
    } catch (e) {
      console.warn('[SampleSandbox] ' + which + ' failed:', e?.message || e)
      return null
    }
  },
  undo() { return get()._applyUndoRedo('undo') },
  redo() { return get()._applyUndoRedo('redo') },

  async refreshHistory() {
    try {
      const h = await window.xleth?.sandbox?.getHistory?.()
      if (!h) return
      set({
        history: {
          canUndo: !!h.canUndo,
          canRedo: !!h.canRedo,
          undoDomain: h.undoDomain || '',
          redoDomain: h.redoDomain || '',
          undoDescription: h.undoDescription || '',
          redoDescription: h.redoDescription || '',
          sandboxUndoCount: h.sandboxUndoCount ?? 0,
        },
      })
    } catch (e) {
      console.warn('[SampleSandbox] getHistory failed:', e?.message || e)
    }
  },

  // Re-seed the whole layer list from a SandboxCore::toJson() payload. Called
  // after a project load (the store never saw those mutations) and after every
  // sandbox undo/redo (same reason). `workspace` may be the JSON string the
  // bridge returns or an already-parsed object.
  hydrateFromWorkspace(workspace) {
    let ws = workspace
    if (typeof ws === 'string') {
      try { ws = JSON.parse(ws) } catch { return }
    }
    if (!ws || !Array.isArray(ws.layers)) return
    set((state) => {
      const prev = new Map(state.layers.map((l) => [l.id, l]))
      const layers = ws.layers.map((wl) => layerFromWorkspace(wl, prev.get(wl.id)))
      const activeLayerId = layers.some((l) => l.id === state.activeLayerId)
        ? state.activeLayerId
        : (layers[0]?.id ?? null)
      return { layers, activeLayerId, selection: null }
    })
  },

  // Pull the engine's workspace and adopt it wholesale. The project-load entry
  // point: nothing the store currently holds belongs to the newly opened
  // project.
  async reloadFromEngine() {
    try {
      const raw = await window.xleth?.sandbox?.getWorkspace?.()
      if (raw == null) return
      for (const l of get().layers) stopPolling(l.id)
      set({
        layers: [],
        activeLayerId: null,
        selection: null,
        composite: { renderState: 'idle', renderedBuffer: null, error: null },
        bakedAssets: [],
      })
      get().hydrateFromWorkspace(raw)
      // A reloaded layer has its stack back but no published render — the audio
      // was never part of the file. A layer whose durable source could not be
      // re-resolved stays unbound and is deliberately NOT rendered.
      for (const l of get().layers) {
        if (l.sourceBufferId >= 0) get().renderLayer(l.id, 'projectLoad')
      }
      await get().refreshHistory()
    } catch (e) {
      console.warn('[SampleSandbox] reloadFromEngine failed:', e?.message || e)
    }
  },
}))

// A project load replaces the engine's whole sandbox workspace (SB-6 persists
// it in project.json). This store's layer list was built by echoing its OWN
// mutations, so it has no idea that happened — re-seed it from the engine
// rather than let it keep showing the previous project's layers.
globalThis.window?.xleth?.onProjectLoaded?.(() => {
  useSandboxStore.getState().reloadFromEngine()
})

export default useSandboxStore

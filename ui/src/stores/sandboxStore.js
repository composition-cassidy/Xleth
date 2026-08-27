import { create } from 'zustand'
import { playSandboxPreview, stopSandboxPreview } from '../components/sandbox/sandboxPreviewPlayer.js'

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

// ─── Gain envelope (Audio Dynamics Editor, Mode 1) ──────────────────────────
// Mirrors xleth::sandbox::GainEnvelopeParams and its evaluator in SandboxOp.cpp.
// The engine owns the audio; this mirror exists so the canvas can DRAW the same
// curve the renderer will apply, and so the headroom warning can predict a drag
// that has not been committed yet. Any change to the C++ curve has to land here
// too — the same standing obligation FADE_SHAPE and AUTO_RENDER_BY_OP_TYPE
// already carry in this file.

// The engine's hard clamp (kGainEnvelopeMinDb/MaxDb). Anything outside is
// clamped on ingest by normalizeGainEnvelope, so sending a wilder value is not
// an error — it just does not round-trip.
export const GAIN_ENVELOPE_DB_MIN = -96
export const GAIN_ENVELOPE_DB_MAX = 24

// Mirrors xleth::sandbox::SandboxGainEnvelopeMode. JSON writes the int, same
// as RIPPLE_MODE/FADE_SHAPE above.
export const GAIN_ENVELOPE_MODE = { absolute: 0, relative: 1 }

// Mirrors kGainEnvelopeMin/MaxAttackMs, kGainEnvelopeMin/MaxReleaseMs and the
// stock defaults (SandboxOp.h). Only meaningful in Relative mode, but carried
// unconditionally — see GainEnvelopeParams's own comment on why.
export const GAIN_ENVELOPE_ATTACK_MS_MIN = 0.1
export const GAIN_ENVELOPE_ATTACK_MS_MAX = 500
export const GAIN_ENVELOPE_ATTACK_MS_DEFAULT = 5
export const GAIN_ENVELOPE_RELEASE_MS_MIN = 1
export const GAIN_ENVELOPE_RELEASE_MS_MAX = 2000
export const GAIN_ENVELOPE_RELEASE_MS_DEFAULT = 150

// Raw dB the curve evaluates to at `samplePos` — smoothstep-interpolated, held
// flat outside the authored range, WITHOUT the exact-silence floor snap.
// Mirrors gainEnvelopeDbAt() (SandboxOp.cpp). gainEnvelopeAt() below builds on
// this the same way the engine's does, so there is exactly one interpolation
// to keep in sync rather than two.
export function gainEnvelopeDbAt(points, samplePos) {
  if (!points || points.length === 0) return 0
  if (points.length === 1) return points[0].db

  const first = points[0]
  const last = points[points.length - 1]
  if (samplePos <= first.samplePos) return first.db
  if (samplePos >= last.samplePos) return last.db

  // Linear scan: an envelope is a handful of breakpoints, and the callers here
  // walk sample positions in ascending order anyway.
  let i = 0
  while (i < points.length - 2 && points[i + 1].samplePos <= samplePos) i++
  const a = points[i]
  const b = points[i + 1]
  const span = b.samplePos - a.samplePos
  if (span <= 0) return b.db
  let t = (samplePos - a.samplePos) / span
  t = t * t * (3 - 2 * t) // smoothstep — zero slope at both handles
  return a.db + (b.db - a.db) * t
}

// Gain (LINEAR) the curve produces at `samplePos` in ABSOLUTE mode. Mirrors
// gainEnvelopeAt(): held flat outside the authored range, smoothstep IN dB
// between breakpoints, exact silence at the floor. `points` must be sorted by
// samplePos — every path in this file keeps them that way via
// sortEnvelopePoints. Relative mode's actual applied gain is NOT this
// function — see the faint-envelope approximation in
// SandboxWaveformCanvas.jsx and applyGainEnvelope() in SandboxRenderer.cpp for
// what the engine actually renders.
export function gainEnvelopeAt(points, samplePos) {
  const db = gainEnvelopeDbAt(points, samplePos)
  return db <= GAIN_ENVELOPE_DB_MIN ? 0 : Math.pow(10, db / 20)
}

// Sort + clamp + de-duplicate, mirroring normalizeGainEnvelope(). Applied
// before every commit so the local copy matches what the engine will store,
// and the "is this actually an edit?" comparison below stays honest.
export function sortEnvelopePoints(points) {
  const keep = (points || [])
    .filter((p) => Number.isFinite(p.samplePos) && Number.isFinite(p.db) && p.samplePos >= 0)
    .map((p) => ({
      samplePos: Math.round(p.samplePos),
      db: Math.min(GAIN_ENVELOPE_DB_MAX, Math.max(GAIN_ENVELOPE_DB_MIN, p.db)),
    }))
  keep.sort((a, b) => a.samplePos - b.samplePos)
  const out = []
  for (const p of keep) {
    if (out.length && out[out.length - 1].samplePos === p.samplePos) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

// Clamp mode/attack/release into their engine-side bounds, mirroring the tail
// of normalizeGainEnvelope() (the points half is sortEnvelopePoints above).
// Takes a raw params-shaped object (or undefined) and always returns a
// complete, valid triple — the seam every follower-touching call in this file
// routes through so a partial `{ mode }` update never has to know the other
// two fields' current values itself.
export function clampGainEnvelopeFollower(params) {
  const mode = params?.mode === GAIN_ENVELOPE_MODE.relative
    ? GAIN_ENVELOPE_MODE.relative : GAIN_ENVELOPE_MODE.absolute
  const attack = Number.isFinite(params?.followerAttackMs) ? params.followerAttackMs : GAIN_ENVELOPE_ATTACK_MS_DEFAULT
  const release = Number.isFinite(params?.followerReleaseMs) ? params.followerReleaseMs : GAIN_ENVELOPE_RELEASE_MS_DEFAULT
  return {
    mode,
    followerAttackMs: Math.min(GAIN_ENVELOPE_ATTACK_MS_MAX, Math.max(GAIN_ENVELOPE_ATTACK_MS_MIN, attack)),
    followerReleaseMs: Math.min(GAIN_ENVELOPE_RELEASE_MS_MAX, Math.max(GAIN_ENVELOPE_RELEASE_MS_MIN, release)),
  }
}

// The layer's gain-envelope op, or null. The overlay owns exactly ONE op per
// layer — the FIRST gainEnvelope on the stack — rather than trying to draw a
// stack of curves on one canvas. A second envelope op added by other means
// still renders; it just is not the one the overlay edits.
export function findEnvelopeOp(layer) {
  return layer?.ops?.find((o) => o.type === 'gainEnvelope') ?? null
}

// ── Spectral paint (P3-2) ────────────────────────────────────────────────────
// The layer's spectral-paint op, or null — same "the overlay owns exactly ONE
// op per layer" contract findEnvelopeOp uses, for the same reason: one canvas,
// one editable mask.
export function findSpectralPaintOp(layer) {
  return layer?.ops?.find((o) => o.type === 'spectralPaint') ?? null
}

// Mirrors kSpectralPaintMinAmountDb/kSpectralPaintMaxAmountDb (SandboxOp.h) —
// the engine's own per-dab clamp, bipolar since a dab can ATTENUATE (negative)
// or BOOST (positive, added for the SPC selection tool's BOOST action). A
// brush/selection amount outside this range is not an error, it just does not
// round-trip past the renderer's clamp.
export const SPECTRAL_PAINT_AMOUNT_DB_MIN = -60
export const SPECTRAL_PAINT_AMOUNT_DB_MAX = 24

// Default brush footprint — a few STFT bins/frames wide at the engine's own
// 2048/512 analysis resolution (SandboxRenderer.cpp's `spectralpaint`
// namespace), small enough to paint a single hum/whine line rather than a
// whole octave.
export const SPECTRAL_PAINT_BRUSH_DEFAULT = {
  halfWidthSec: 0.05,
  halfHeightHz: 150,
  amountDb: -24,
  featherTimeMs: 20,
  featherFreqHz: 80,
}

// ── SPC selection tool (rect/freehand t×f regions) ──────────────────────────
// Half-extent laid down per point along a FREEHAND selection drag — same role
// SPECTRAL_PAINT_BRUSH_DEFAULT's halfWidthSec/halfHeightHz play for a paint
// stroke, just named separately since the selection tool has no amount/
// feather of its own (those come from whichever action fires).
export const SPC_SELECT_FREEHAND_DEFAULT = {
  halfWidthSec: 0.05,
  halfHeightHz: 150,
}

// Feather applied when a selection's shapes are turned into dabs by an
// action — the selection itself is a hard-edged region on screen (drawing a
// feathered rectangle would misrepresent exactly what will be affected), but
// every dab-consuming op (ATTENUATE/BOOST/MUTE) sounds better with a soft
// edge, same reasoning SPECTRAL_PAINT_BRUSH_DEFAULT's own feather fields have.
export const SPC_SELECTION_ACTION_FEATHER_TIME_MS = 20
export const SPC_SELECTION_ACTION_FEATHER_FREQ_HZ = 80

// A selection's committed shapes (no amountDb/feather) → SpectralPaintDab-
// shaped objects at `amountDb`, feathered by the constants above. Shared by
// every SPC selection action so ATTENUATE/BOOST/MUTE/COPY TO NEW LAYER all
// build dabs identically, differing only in the amountDb they pass.
export function spcSelectionToDabs(spcSelection, amountDb) {
  if (!spcSelection?.shapes?.length) return []
  return spcSelection.shapes.map((s) => ({
    centerSample: s.centerSample,
    halfWidthSamples: s.halfWidthSamples,
    centerFreqHz: s.centerFreqHz,
    halfHeightHz: s.halfHeightHz,
    amountDb,
    featherTimeMs: SPC_SELECTION_ACTION_FEATHER_TIME_MS,
    featherFreqHz: SPC_SELECTION_ACTION_FEATHER_FREQ_HZ,
  }))
}

// A drag under MIN_SELECTION_PX (SandboxWaveformCanvas.jsx) already collapses
// to "no selection" — but that guard is in PIXELS, so at a high enough
// zoom-per-sample ratio a few pixels can still span a near-zero DURATION.
// Trim/Cut/Fade/etc. (EFFECT ▾'s selection-scoped entries — see
// sandboxEffectRegistry.js) are none of them meaningful on a sub-millisecond
// span, so it gates on TIME here as a second, resolution-independent check.
export const MIN_SELECTION_SEC = 0.001

// True only for a selection with real duration on a rendered buffer — the
// shared gate for both "is there a selection to act on" checks (SandboxMenuBar's
// EFFECT ▾ disabled-state, SandboxPanelContent's SPC-selection-bar mount).
// `sampleRate` is the rendered buffer's own rate, since `selection` is always
// in that buffer's sample space.
export function hasMeaningfulSelection(selection, sampleRate) {
  if (!selection || !sampleRate) return false
  const spanSamples = selection.endSample - selection.startSample
  return spanSamples > 0 && spanSamples / sampleRate > MIN_SELECTION_SEC
}

const POLL_MS = 150
const POLL_MAX_ATTEMPTS = 200 // ~30s ceiling — a stuck render surfaces as an error, not a silent hang

// ── Composite auto-render ───────────────────────────────────────────────────
// Every op-stack mutation (add/remove/reorder/param/bypass) — and undo/redo of
// one — schedules a debounced composite re-render so Play always reflects the
// latest edit without a manual RE-RENDER click. See _scheduleCompositeAutoRender
// / _runCompositeAutoRender below.
const COMPOSITE_AUTORENDER_DEBOUNCE_MS = 150

// Mirrors xleth::sandbox::SandboxOp::autoRender() (SandboxOp.cpp) — per-op-type
// policy for whether a stack mutation involving this op type may auto-trigger
// a render. Default true for every op type that exists today; a future heavy
// op (e.g. model separation) sets its entry false so a layer carrying it never
// auto-renders and must use the explicit RE-RENDER fallback instead. Keep in
// sync with the engine table.
const AUTO_RENDER_BY_OP_TYPE = {
  trim: true, cut: true, paste: true, splice: true, reverse: true,
  fade: true, gain: true, crossfade: true, pitch: true, stretch: true,
  // One multiply per sample over one buffer, offline — the same order of cost
  // as fade. See SandboxOp::autoRender().
  gainEnvelope: true,
  // Restoration/pitch trio — RubberBand offline moves and the declip/denoise
  // scans are all single-pass over one buffer, still cheap enough not to opt
  // out. See SandboxOp::autoRender()'s own comment on the same table.
  formantShift: true, declip: true, denoise: true,
  // Per-frame dab evaluation over an offline STFT pass — same order of cost
  // as DENOISE. See SandboxOp::autoRender()'s SpectralPaint case.
  spectralPaint: true,
}

// True when every op currently on `layer`'s stack permits automatic
// rendering. One heavy (autoRender:false) op anywhere in the stack is enough
// to require the manual fallback for that layer — see AUTO_RENDER_BY_OP_TYPE.
function layerAllowsAutoRender(layer) {
  return layer.ops.every((o) => AUTO_RENDER_BY_OP_TYPE[o.type] !== false)
}

// Debounce timer + generation counter for the composite auto-render pipeline.
// Not store state (like pollTimers) — a setTimeout handle isn't serializable,
// and the generation only needs to be compared synchronously against itself.
let compositeDebounceTimer = null
let compositeGeneration = 0

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
    // SPC view (P3-1). Fetched lazily — see ensureSpectrogram — and dropped
    // whenever a fresh renderedBuffer lands, so a stale image can never be
    // mistaken for the current render even for the one frame before the new
    // fetch resolves.
    spectrogramState: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
    spectrogram: null, // { numFrames, numBins, hopSize, sampleRate, minDb, maxDb, tokens: Uint8Array }
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
  // Envelope edit mode — see setEnvelopeEditMode. Session state, never
  // persisted: it is a pointer mode, not part of the edit.
  envelopeEditMode: false,

  // Spectral paint edit mode (P3-2) — same "a mode, not a modifier" contract
  // as envelopeEditMode (SandboxWaveformCanvas.jsx's header comment explains
  // why), and mutually exclusive with it: the canvas has one pointer, so only
  // one drag gesture can own it at a time. Session state, never persisted.
  paintEditMode: false,
  // Brush settings the SPC canvas reads on every dab it lays down during a
  // paint drag. Session state (not per-op — it is "what will the NEXT stroke
  // do", not a property of any painted mask already committed).
  paintBrush: { ...SPECTRAL_PAINT_BRUSH_DEFAULT },

  // ── SPC selection tool (rect/freehand t×f regions) ──────────────────────
  // A FOURTH mode, mutually exclusive with select/envelope/paint for the same
  // one-pointer reason paintEditMode's own comment gives. Only meaningful over
  // the SPC view — armed alongside a forced switch to 'spc', same as Spectral.
  spcSelectMode: false,
  // 'rect': one drag = one rectangular shape. 'freehand': the drag path is
  // approximated as a series of small overlapping rectangles (SPC_SELECT_
  // BRUSH-sized), the exact technique paintDragRef already uses for a paint
  // stroke — a freehand SELECTION is not a new engine concept, just several
  // shapes committed together instead of one.
  spcSelectShape: 'rect',
  // The committed selection: { shapes: [{centerSample, halfWidthSamples,
  // centerFreqHz, halfHeightHz}, ...] } or null. Shapes carry NO amountDb/
  // feather of their own — those are supplied by whichever action (ATTENUATE/
  // BOOST/MUTE/COPY TO NEW LAYER) the user fires, the same "brush settings are
  // session state, not per-shape" split paintBrush already keeps for the
  // paint tool.
  spcSelection: null,
  // Live (time, Hz) under the pointer while hovering/dragging the SPC canvas —
  // purely a readout source for the status bar, never consulted by any
  // action. null when the pointer is not over the SPC canvas.
  spcHoverReadout: null,

  // WAV/SPC view toggle (P3-1) — session state, never persisted, same as
  // envelopeEditMode. Which of the two the waveform canvas paints for the
  // active layer; selection/zoom/scroll stay driven by the same `selection`
  // and canvas sizing either mode already shares.
  viewMode: 'wav', // 'wav' | 'spc'

  // ── Composite (SB-5) — mix of every layer's own render by its mix params ──
  composite: {
    renderState: 'idle', // 'idle' | 'rendering' | 'ready' | 'error'
    renderedBuffer: null, // { numChannels, numSamples, sampleRate, channels: Float32Array[], layersMixed }
    error: null,
  },
  bakeCompositeState: 'idle', // 'idle' | 'baking' | 'baked' | 'error'
  bakeCompositeError: null,
  compositePreviewState: 'idle', // 'idle' | 'rendering' | 'playing'

  // ── Composite auto-render bookkeeping ──────────────────────────────────
  // debouncePending: an edit landed, the 150ms coalescing timer is running.
  // pending: the timer fired — waiting on layers and/or the mix RPC.
  // The three counters exist so a smoke test can watch rapid edits collapse
  // into one render (scheduledCount keeps climbing, ranCount barely moves,
  // supersededCount absorbs the difference).
  compositeAutoRender: {
    debouncePending: false,
    pending: false,
    scheduledCount: 0,
    ranCount: 0,
    supersededCount: 0,
  },

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
  // startTime, endTime, audioFilePath?, hasSwappedAudio?, swappedAudioPath?,
  // swappedAudioDurationSec? }. Resolves a SampleBank sourceRef via
  // audio.loadSourceRegion, then opens a sandbox layer against it.
  //
  // Swap-aware (mirrors Audio_LoadRegionAudio in XlethEngineService.cpp): a
  // region whose sample has been SWAP-IN'd (from this same panel, or restored
  // via the Sample Selector's Swap/Restore Audio entry) plays from
  // swappedAudioPath, not the region's original audioFilePath — dragging or
  // re-opening it here must follow the same binding, or the sandbox would
  // silently edit audio the project no longer plays.
  async addSourceFromRegion(region) {
    if (!region) return
    try {
      let filePath, startTime, endTime
      if (region.hasSwappedAudio && region.swappedAudioPath) {
        filePath = region.swappedAudioPath
        startTime = 0
        endTime = region.swappedAudioDurationSec > 0
          ? region.swappedAudioDurationSec
          : await window.xleth?.audio?.probeAudioDuration(filePath)
      } else {
        filePath = region.audioFilePath ?? null
        if (!filePath && region.sourceId != null) {
          const sources = (await window.xleth?.timeline?.getSources?.()) ?? []
          const src = sources.find((s) => s.id === region.sourceId)
          filePath = src?.filePath ?? null
        }
        startTime = region.startTime
        endTime = region.endTime
      }
      if (!filePath) throw new Error('No source file for this region')

      const sourceRef = await window.xleth?.audio?.loadSourceRegion(
        filePath, startTime, endTime,
      )
      if (sourceRef == null || sourceRef < 0) throw new Error('Could not load source audio')

      // Third argument is the DURABLE source reference — without it a saved
      // workspace reopens unbound, because the SampleBank id above is minted
      // fresh on every project load.
      const res = await window.xleth?.sandbox?.open(sourceRef, region.name, {
        filePath, startTime, endTime,
      })
      if (!res?.success) throw new Error(res?.reason || 'sandbox.open failed')

      const layer = makeLayer({
        layerId: res.layerId,
        name: res.name,
        sourceBufferId: res.sourceBufferId,
        bufferSampleRate: res.bufferSampleRate,
        region: { ...region, audioFilePath: filePath, startTime, endTime },
      })
      set((state) => ({ layers: [...state.layers, layer], activeLayerId: layer.id, selection: null }))
      get().renderLayer(layer.id, 'open')
      get().refreshHistory()
      return layer
    } catch (e) {
      console.warn('[SampleSandbox] addSourceFromRegion failed:', e?.message || e)
      return null
    }
  },

  // Open a raw audio file as a new layer — no timeline region behind it.
  //
  // Lives here rather than in SandboxLayerWorkspace (where the Explorer-drop
  // handler used to own a private copy) because it is the shared "a file
  // became a layer" path: the drop zone uses it, and so does separation,
  // whose stems arrive as WAVs on disk and must land as ORDINARY layers.
  // That is the whole "separation is a source generator, never an op" rule —
  // a stem enters the workspace through the same door a dragged file does,
  // with its own op-stack, its own undo, and no special-casing downstream.
  //
  // With no `id` on the synthetic region the resulting layer's sourceRegionId
  // is null, which the cold-layer SwapTargetPicker (SandboxTransport.jsx)
  // already handles.
  async addSourceFromFile(filePath, name) {
    if (!filePath) return null
    const duration = await window.xleth?.audio?.probeAudioDuration(filePath)
    if (!(duration > 0)) {
      console.warn('[SampleSandbox] Could not read duration, skipping:', filePath)
      return null
    }
    return get().addSourceFromRegion({
      audioFilePath: filePath, name, startTime: 0, endTime: duration,
    })
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
    if (get().viewMode === 'spc') get().ensureSpectrogram(layerId)
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
          // A new render is a new set of samples — the previous spectrogram
          // (if any) describes audio that no longer exists. Dropped here
          // rather than left to be silently overwritten by ensureSpectrogram,
          // so a slow SPC fetch can never leave a stale image on screen.
          spectrogramState: 'idle',
          spectrogram: null,
        })
        if (get().viewMode === 'spc') get().ensureSpectrogram(layerId)
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

  // Called after every accepted op-stack mutation (and undo/redo of one).
  // Kicks the layer's own async render exactly like before, then schedules
  // the composite auto-render — UNLESS the layer's stack currently carries an
  // op whose type opts out of auto-render (AUTO_RENDER_BY_OP_TYPE), in which
  // case both are skipped and the layer/composite fall back to their manual
  // triggers (per-layer RE-RENDER / the Composite section's RE-RENDER button).
  _triggerAutoRender(layerId, trigger) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer || !layerAllowsAutoRender(layer)) return
    get().renderLayer(layerId, trigger)
    get()._scheduleCompositeAutoRender(trigger)
  },

  // Debounces ~150ms: a new call resets the timer, so a burst of edits (a
  // rapid param drag, or undo/redo touching several layers) collapses into
  // exactly one composite render instead of one per edit. Bumping
  // `compositeGeneration` is what lets _runCompositeAutoRender recognize that
  // a cycle already under way (waiting on layers, or mid-RPC) has been
  // superseded by a newer edit — it keeps running to avoid wasting the
  // in-flight work, but its result is discarded instead of published, which
  // is the externally-visible "cancelled and restarted" behaviour.
  _scheduleCompositeAutoRender(trigger) {
    if (compositeDebounceTimer != null) clearTimeout(compositeDebounceTimer)
    const gen = ++compositeGeneration
    set((state) => ({
      compositeAutoRender: {
        ...state.compositeAutoRender,
        debouncePending: true,
        scheduledCount: state.compositeAutoRender.scheduledCount + 1,
      },
    }))
    compositeDebounceTimer = setTimeout(() => {
      compositeDebounceTimer = null
      get()._runCompositeAutoRender(gen, trigger)
    }, COMPOSITE_AUTORENDER_DEBOUNCE_MS)
  },

  // Fetches the composite mix without touching any store state — shared by
  // the manual renderComposite() action and the auto-render pipeline, which
  // need different rules for when to apply (or discard) the result.
  async _fetchCompositeRender() {
    const res = await window.xleth?.sandbox?.renderComposite()
    if (!res?.ready) throw new Error(res?.reason || 'composite render rejected')
    return {
      numChannels: res.numChannels,
      numSamples: res.numSamples,
      sampleRate: res.sampleRate,
      layersMixed: res.layersMixed,
      channels: deinterleave(res.data, res.numChannels, res.numSamples),
    }
  },

  // Waits until every bound layer reaches its own render's terminal state
  // (sandbox_renderComposite's precondition — "every layer already
  // rendered"). Shared by the manual RENDER COMPOSITE button and the
  // auto-render pipeline: without this wait, a layer whose own render is
  // still in flight (just added, or mid auto-render from an edit) makes
  // sandbox_renderComposite fail with 'layer "X" not rendered yet' even
  // though it finishes a moment later. Returns 'settled', 'stale' (per
  // `isStale`, when given), or 'timeout'.
  async _waitForLayersSettled(isStale = () => false) {
    const layersSettled = () => get().layers
      .filter((l) => l.sourceBufferId >= 0)
      .every((l) => l.renderState === 'ready' || l.renderState === 'error')
    const deadline = Date.now() + 30000
    while (!layersSettled()) {
      if (isStale()) return 'stale'
      if (Date.now() > deadline) return 'timeout'
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    return isStale() ? 'stale' : 'settled'
  },

  // Waits for every bound layer to settle, then mixes. Bails out at any point
  // `gen` stops being the newest scheduled generation, discarding whatever
  // this cycle produced rather than letting stale audio overwrite a fresher
  // edit's result. On failure the PREVIOUS composite.renderedBuffer (if any)
  // is left in place — a transient re-render failure should never erase a
  // last-good mix the user can still preview/bake, only a render that has
  // never once succeeded leaves renderedBuffer null (the honest empty state).
  async _runCompositeAutoRender(gen, trigger) {
    const isStale = () => gen !== compositeGeneration
    const supersede = () => set((state) => ({
      compositeAutoRender: {
        ...state.compositeAutoRender,
        pending: false,
        supersededCount: state.compositeAutoRender.supersededCount + 1,
      },
    }))

    if (isStale()) { supersede(); return }
    set((state) => ({
      compositeAutoRender: { ...state.compositeAutoRender, debouncePending: false, pending: true },
    }))

    const waitResult = await get()._waitForLayersSettled(isStale)
    if (waitResult === 'stale') { supersede(); return }
    if (waitResult === 'timeout') {
      set((state) => ({ compositeAutoRender: { ...state.compositeAutoRender, pending: false } }))
      return
    }

    set((state) => ({ composite: { ...state.composite, renderState: 'rendering', error: null } }))
    let renderedBuffer
    try {
      renderedBuffer = await get()._fetchCompositeRender()
    } catch (e) {
      if (!isStale()) {
        set((state) => ({ composite: { ...state.composite, renderState: 'error', error: e?.message || String(e) } }))
      }
      supersede()
      console.warn(`[SampleSandbox] composite auto-render (${trigger}) failed:`, e?.message || e)
      return
    }
    if (isStale()) { supersede(); return } // a newer edit landed mid-RPC — this result is already outdated

    set((state) => ({
      composite: { renderState: 'ready', renderedBuffer, error: null },
      compositeAutoRender: { ...state.compositeAutoRender, pending: false, ranCount: state.compositeAutoRender.ranCount + 1 },
    }))
  },

  // Resolves once `composite.renderedBuffer` reflects every currently-
  // scheduled edit: fires a still-debouncing auto-render immediately instead
  // of waiting out the remaining delay, waits out one already in flight
  // (auto or manual), and renders fresh if nothing has ever run. This is what
  // makes Play "always plays the newest COMPLETED render" instead of handing
  // the transport whatever stale buffer happened to be cached.
  async _awaitFreshComposite() {
    if (compositeDebounceTimer != null) {
      clearTimeout(compositeDebounceTimer)
      compositeDebounceTimer = null
      get()._runCompositeAutoRender(compositeGeneration, 'play')
    }
    const deadline = Date.now() + 30000
    while (get().composite.renderState === 'rendering' || get().compositeAutoRender.pending) {
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    let buf = get().composite.renderedBuffer
    if (!buf) {
      await get().renderComposite()
      buf = get().composite.renderedBuffer
    }
    return buf
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
      get()._triggerAutoRender(layerId, 'stackAdd')
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
      get()._triggerAutoRender(layerId, 'stackRemove')
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
      get()._triggerAutoRender(layerId, 'stackReorder')
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
      get()._triggerAutoRender(layerId, 'stackSetParam')
      get().refreshHistory()
    } catch (e) {
      console.warn('[SampleSandbox] setOpParams failed:', e?.message || e)
    }
  },

  // ── Gain envelope (Audio Dynamics Editor) ─────────────────────────────────
  //
  // Add-or-update, in ONE undo step either way: the first committed curve adds
  // the op, every later one replaces its params. That is what lets the canvas
  // treat "there is no envelope yet" and "there is one" as the same gesture —
  // the user draws on a flat unity line and does not need to know which case
  // they were in.
  //
  // Called ONCE, on mouseup. The drag itself is previewed locally in the canvas
  // component and never reaches this store: a call per mousemove would push a
  // command per frame onto the undo stack and re-render the layer at pointer
  // rate. Both paths below already schedule the debounced auto-render, so the
  // commit is also what makes playback reflect the new curve.
  //
  // `follower` is `{ mode, followerAttackMs, followerReleaseMs }`, or any
  // subset of it — omitted fields fall back to the existing op's (or the
  // stock defaults, for a brand-new one) via clampGainEnvelopeFollower. A
  // curve drag that never touches Mode/Advanced controls therefore leaves
  // them exactly as they were.
  async setGainEnvelope(layerId, points, follower = {}) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer) return
    const normalized = sortEnvelopePoints(points)
    const existing = findEnvelopeOp(layer)
    const mergedFollower = clampGainEnvelopeFollower({ ...(existing?.params || {}), ...follower })

    if (!existing) {
      // Appended, not inserted: the envelope is a final gain stage, so its
      // breakpoint positions refer to the buffer the canvas is actually
      // showing. An op added AFTER it later (a trim, say) changes the sample
      // space underneath it — the curve still renders, it just no longer lines
      // up with what is drawn, the same way every other range-carrying op's
      // indices behave when something upstream of them moves.
      await get().addOp(layerId, { type: 'gainEnvelope', params: { points: normalized, ...mergedFollower } })
      return
    }

    // The engine rejects a no-op edit with "not an edit" (see
    // Sandbox_StackSetParam). Catch it here instead of letting setOpParams log
    // a warning for a mouseup/toggle that did not actually change anything —
    // curve AND mode/follower both have to be unchanged for that to hold.
    const before = sortEnvelopePoints(existing.params?.points)
    const beforeFollower = clampGainEnvelopeFollower(existing.params || {})
    const samePoints = before.length === normalized.length
        && before.every((pt, i) => pt.samplePos === normalized[i].samplePos && pt.db === normalized[i].db)
    const sameFollower = beforeFollower.mode === mergedFollower.mode
        && beforeFollower.followerAttackMs === mergedFollower.followerAttackMs
        && beforeFollower.followerReleaseMs === mergedFollower.followerReleaseMs
    if (samePoints && sameFollower) return

    await get().setOpParams(layerId, existing.id, { points: normalized, ...mergedFollower })
  },

  // Mode/Advanced-drawer-only mutation: flips Mode 1↔2 or retunes
  // attack/release WITHOUT the user having touched the curve. Seeds a flat
  // (empty-points, i.e. 0 dB everywhere) op on a layer with no envelope yet —
  // the same "there is no envelope yet" seam setGainEnvelope's own callers
  // already rely on — so the Mode toggle works before the first breakpoint is
  // ever drawn.
  async setGainEnvelopeFollower(layerId, follower) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer) return
    const existing = findEnvelopeOp(layer)
    await get().setGainEnvelope(layerId, existing?.params?.points || [], follower)
  },

  // Envelope EDIT mode. The waveform canvas has exactly one pointer, and a
  // click on it already means "start a selection" — so breakpoint editing is a
  // mode rather than a chord or a modifier. Off, the curve is still drawn (a
  // dimmed read-only line): an envelope you cannot see is an envelope you
  // cannot debug when playback sounds wrong.
  setEnvelopeEditMode(on) {
    set({
      envelopeEditMode: !!on,
      paintEditMode: on ? false : get().paintEditMode,
      spcSelectMode: on ? false : get().spcSelectMode,
    })
  },
  toggleEnvelopeEditMode() {
    set((state) => ({ envelopeEditMode: !state.envelopeEditMode, paintEditMode: false, spcSelectMode: false }))
  },

  // Spectral paint edit mode — mutually exclusive with envelope/select edit
  // mode, same reasoning as setEnvelopeEditMode above.
  setPaintEditMode(on) {
    set({
      paintEditMode: !!on,
      envelopeEditMode: on ? false : get().envelopeEditMode,
      spcSelectMode: on ? false : get().spcSelectMode,
    })
  },
  togglePaintEditMode() {
    set((state) => ({ paintEditMode: !state.paintEditMode, envelopeEditMode: false, spcSelectMode: false }))
  },

  // SPC selection edit mode — mutually exclusive with envelope/paint, same
  // one-pointer reasoning. `shape` optionally sets spcSelectShape in the same
  // call, so a toolstrip click on "Freehand" while the tool is already armed
  // (or arming it for the first time) is one store update, not two.
  setSpcSelectMode(on, shape) {
    set((state) => ({
      spcSelectMode: !!on,
      envelopeEditMode: on ? false : state.envelopeEditMode,
      paintEditMode: on ? false : state.paintEditMode,
      spcSelectShape: shape === 'rect' || shape === 'freehand' ? shape : state.spcSelectShape,
    }))
  },
  setSpcSelectShape(shape) {
    if (shape !== 'rect' && shape !== 'freehand') return
    set({ spcSelectShape: shape })
  },

  // Committed selection shapes — replaces any previous selection wholesale
  // (a new drag always starts a fresh selection, it never appends to the old
  // one the way a paint stroke appends dabs to an op). Falsy/empty clears it.
  setSpcSelection(shapes) {
    set({ spcSelection: shapes && shapes.length ? { shapes } : null })
  },
  clearSpcSelection() { set({ spcSelection: null }) },
  setSpcHoverReadout(readout) { set({ spcHoverReadout: readout }) },

  setPaintBrush(patch) {
    set((state) => ({
      paintBrush: {
        ...state.paintBrush,
        ...patch,
        amountDb: Math.min(SPECTRAL_PAINT_AMOUNT_DB_MAX,
          Math.max(SPECTRAL_PAINT_AMOUNT_DB_MIN, patch.amountDb ?? state.paintBrush.amountDb)),
      },
    }))
  },

  // WAV/SPC view toggle (P3-1). Switching to 'spc' kicks a fetch immediately
  // if the active layer has a render but no spectrogram yet — otherwise the
  // canvas would sit on "Analyzing…" until the next unrelated store update.
  setViewMode(mode) {
    if (mode !== 'wav' && mode !== 'spc') return
    set({ viewMode: mode })
    if (mode === 'spc' && get().activeLayerId != null) get().ensureSpectrogram(get().activeLayerId)
  },

  // Fetches the STFT analysis of `layerId`'s CURRENT renderedBuffer, unless
  // one is already in flight or already sitting in spectrogramState==='ready'
  // (fresh, because a new render clears it — see _pollRenderedBuffer). The
  // engine's own cache (SandboxSpectrogramAnalyzer, keyed by the buffer's
  // content hash) is what makes repeated calls here cheap; this guard just
  // avoids firing a redundant bridge round-trip for the same render.
  async ensureSpectrogram(layerId) {
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer?.renderedBuffer || layer.spectrogramState === 'loading' || layer.spectrogramState === 'ready') return
    get().patchLayer(layerId, { spectrogramState: 'loading' })
    try {
      const res = await window.xleth?.sandbox?.getSpectrogram(layerId)
      if (!res?.ready) throw new Error(res?.reason || 'spectrogram not ready')
      // `data` arrives as a Node Buffer over IPC — a Uint8Array view over it
      // needs no alignment care (unlike deinterleave's Float32Array reads),
      // one byte per token.
      const tokens = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength)
      // The layer may have re-rendered (and cleared spectrogramState) while
      // this call was in flight — stamping a result onto a layer that has
      // since moved on to a different renderedBuffer would show a stale
      // image, so only apply it if still the fetch nothing has superseded.
      if (get().layers.find((l) => l.id === layerId)?.renderedBuffer !== layer.renderedBuffer) return
      get().patchLayer(layerId, {
        spectrogramState: 'ready',
        spectrogram: {
          numFrames: res.numFrames,
          numBins: res.numBins,
          hopSize: res.hopSize,
          sampleRate: res.sampleRate,
          minDb: res.minDb,
          maxDb: res.maxDb,
          tokens,
        },
      })
    } catch (e) {
      get().patchLayer(layerId, { spectrogramState: 'error' })
      console.warn('[SampleSandbox] ensureSpectrogram failed:', e?.message || e)
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
      get()._triggerAutoRender(layerId, 'stackSetBypassed')
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

  // ── Restoration / pitch trio ────────────────────────────────────────────
  // PITCH and FORMANT SHIFT apply to the WHOLE buffer the op receives — there
  // is no selection range on either (mirrors xleth::sandbox::PitchParams /
  // FormantShiftParams, which carry no startSample/endSample). Each of these
  // three always APPENDS a new op — the engine iterates the op stack
  // generically, so nothing stops a layer carrying more than one; the EFFECT
  // menu's registry (sandboxEffectRegistry.js) is what markes these ×N
  // instead of the ×1 an earlier add-or-update version of this file used.
  // Later params on any one instance are still edited in place afterward via
  // setOpParams (see the inline param editors in SandboxStackPanel), same as
  // every other op type — only ADDING one more never collapses into an
  // update.

  // PITCH — cents (fractional semitones × 100) and the formant-lock toggle.
  async addPitchShift(layerId, cents = 0, formantPreserve = false) {
    await get().addOp(layerId, { type: 'pitch', params: { cents, formantPreserve } })
  },

  // FORMANT SHIFT — moves the spectral envelope by `cents`, independent of
  // PITCH. A separate op rather than a second field on PITCH: see
  // FormantShiftParams's own comment (SandboxOp.h) for why formantPreserve
  // cannot express "move the formants on their own".
  async addFormantShiftOp(layerId, cents = 0) {
    await get().addOp(layerId, { type: 'formantShift', params: { cents } })
  },

  // DECLIP over the current selection (or the whole buffer if none).
  async addDeclip(layerId, threshold = 0.98, maxRunSamples = 64) {
    const sel = get().selection
    await get().addOp(layerId, {
      type: 'declip',
      params: { startSample: sel?.startSample ?? 0, endSample: sel?.endSample ?? -1, threshold, maxRunSamples },
    })
  },

  // DENOISE — add the op with no learned profile yet (a pass-through until
  // "Learn Noise Profile" commits a region). Reduction/sensitivity default to
  // the engine's own stock values (SandboxOp.h) so a freshly-added op previews
  // exactly like DenoiseParams{} does before any param is ever touched.
  async addDenoise(layerId) {
    await get().addOp(layerId, {
      type: 'denoise',
      params: { noiseStartSample: 0, noiseEndSample: 0, reductionDb: 12, sensitivity: 1.5 },
    })
  },

  // "select region → Learn Noise Profile": commits the CURRENT selection as
  // this op's noise region via the same generic setOpParams every other param
  // edit in this file uses — undoable for free, and the actual spectral
  // profile is re-derived from those two indices at render time (see
  // DenoiseParams's comment) rather than computed here and shipped over the
  // bridge as a second, driftable copy of the data.
  async learnNoiseProfile(layerId, opId) {
    const sel = get().selection
    if (!sel || !(sel.endSample > sel.startSample)) return
    const layer = get().layers.find((l) => l.id === layerId)
    const existing = layer?.ops.find((o) => o.id === opId)
    if (!existing) return
    await get().setOpParams(layerId, opId, {
      ...existing.params, noiseStartSample: sel.startSample, noiseEndSample: sel.endSample,
    })
  },

  // ── Spectral paint (P3-2) ────────────────────────────────────────────────
  //
  // Called ONCE per stroke, on mouseup — the SPC canvas previews the drag
  // locally (accumulating dabs in a ref, never touching this store) and hands
  // the whole stroke's dabs here in one call, exactly like setGainEnvelope's
  // "one command per drag, not per mousemove" contract above. Add-or-append:
  // the first stroke on a layer adds the op, every later one appends to the
  // SAME op's `dabs` — a spectral-paint mask is additive across strokes, never
  // a replacement of the last one.
  async commitSpectralPaintDabs(layerId, newDabs) {
    if (!newDabs || newDabs.length === 0) return
    const layer = get().layers.find((l) => l.id === layerId)
    if (!layer) return
    const existing = findSpectralPaintOp(layer)
    if (!existing) {
      await get().addOp(layerId, { type: 'spectralPaint', params: { dabs: newDabs } })
      return
    }
    await get().setOpParams(layerId, existing.id, { dabs: [...(existing.params?.dabs ?? []), ...newDabs] })
  },

  // "Clear" on the op module — drops every painted dab in one undo step,
  // leaving the op in place as an explicit (empty-mask) pass-through rather
  // than removing it, same as a flat gain-envelope curve stays on the stack
  // at 0 dB instead of vanishing.
  async clearSpectralPaint(layerId) {
    const layer = get().layers.find((l) => l.id === layerId)
    const existing = findSpectralPaintOp(layer)
    if (!existing || (existing.params?.dabs ?? []).length === 0) return
    await get().setOpParams(layerId, existing.id, { dabs: [] })
  },

  // ── SPC selection actions (rect/freehand t×f selection tool) ─────────────
  // ATTENUATE/BOOST/MUTE all go through commitSpectralPaintDabs — the exact
  // same op the paint brush commits to, so a selection-driven edit and a
  // brush stroke are indistinguishable to the engine and to the op-stack
  // panel. They differ only in the amountDb baked into the dabs (see
  // spcSelectionToDabs above). The selection clears itself after every
  // action fires — same "an accepted edit invalidates the selection" rule
  // addOp already applies to the plain time-only `selection`.

  async attenuateSpcSelection(layerId, amountDb) {
    const dabs = spcSelectionToDabs(get().spcSelection, -Math.abs(amountDb))
    if (!dabs.length) return
    await get().commitSpectralPaintDabs(layerId, dabs)
    get().clearSpcSelection()
  },

  async boostSpcSelection(layerId, amountDb) {
    const dabs = spcSelectionToDabs(get().spcSelection, Math.abs(amountDb))
    if (!dabs.length) return
    await get().commitSpectralPaintDabs(layerId, dabs)
    get().clearSpcSelection()
  },

  // MUTE pins amountDb at the engine's own per-dab attenuation floor
  // (kSpectralPaintMinAmountDb, mirrored here as SPECTRAL_PAINT_AMOUNT_DB_MIN)
  // rather than trying to reach kSpectralPaintFloorDb — that floor bounds the
  // SUM of overlapping dabs, not what one dab is allowed to author.
  async muteSpcSelection(layerId) {
    const dabs = spcSelectionToDabs(get().spcSelection, SPECTRAL_PAINT_AMOUNT_DB_MIN)
    if (!dabs.length) return
    await get().commitSpectralPaintDabs(layerId, dabs)
    get().clearSpcSelection()
  },

  // COPY TO NEW LAYER — the complement of the three above: instead of editing
  // this layer, it renders a NEW buffer keeping ONLY the selected region
  // (sandbox_extractSelection, engine-side SandboxRenderer::extractSelection)
  // and registers it as a new SampleBank asset, then opens it as an ordinary
  // layer via the EXACT SAME addBakedAssetAsSource path bakeComposite's own
  // "add the bake back as a source" button already uses — there is no second
  // layer-add mechanism for this to invent. amountDb on the dabs is not
  // consulted by extraction (keep/silence has no "how much"), so it is left
  // at the SpectralPaintDab default rather than threading a meaningless value
  // through.
  async copySpcSelectionToNewLayer(layerId, name) {
    const sel = get().spcSelection
    if (!sel?.shapes?.length) return null
    const dabs = spcSelectionToDabs(sel, 0)
    try {
      const res = await window.xleth?.sandbox?.extractSelection(layerId, dabs, name)
      if (!res?.success) throw new Error(res?.reason || 'extractSelection rejected')
      await get().addBakedAssetAsSource(res.sampleId, res.name)
      get().clearSpcSelection()
      return res
    } catch (e) {
      console.warn('[SampleSandbox] copySpcSelectionToNewLayer failed:', e?.message || e)
      return null
    }
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

  // Manual path — the RE-RENDER button, and _awaitFreshComposite's
  // never-rendered-yet fallback. Always applies its result and is
  // authoritative over the auto-render pipeline: bumping compositeGeneration
  // (and dropping any pending debounce timer) supersedes an auto-render cycle
  // already in flight, so its eventual result is discarded rather than
  // clobbering this one when it lands.
  //
  // Must wait for every layer to settle first, same as the auto-render path
  // (_waitForLayersSettled) — sandbox_renderComposite refuses outright if any
  // bound layer hasn't published its own render yet. Without this wait,
  // clicking RENDER COMPOSITE right after adding a layer (or right after an
  // edit that just kicked that layer's own auto-render) failed immediately
  // with "layer \"X\" not rendered yet", surfaced to the button as
  // "Render failed — retry" even though the layer finishes rendering a
  // moment later on its own.
  async renderComposite() {
    if (compositeDebounceTimer != null) { clearTimeout(compositeDebounceTimer); compositeDebounceTimer = null }
    compositeGeneration++
    const gen = compositeGeneration
    const isStale = () => gen !== compositeGeneration
    set((state) => ({
      composite: { ...state.composite, renderState: 'rendering', error: null },
      compositeAutoRender: { ...state.compositeAutoRender, debouncePending: false },
    }))

    const waitResult = await get()._waitForLayersSettled(isStale)
    if (waitResult === 'stale') return // a newer render call took over meanwhile
    if (waitResult === 'timeout') {
      set((state) => ({
        composite: { ...state.composite, renderState: 'error', error: 'Timed out waiting for layers to render' },
      }))
      return
    }

    try {
      const renderedBuffer = await get()._fetchCompositeRender()
      if (isStale()) return
      set({ composite: { renderState: 'ready', renderedBuffer, error: null } })
    } catch (e) {
      if (isStale()) return
      // Keep the previous renderedBuffer (if any) rather than nulling it out —
      // a failed re-render should never erase a last-good mix still valid for
      // preview/bake. See the auto-render path's identical rule.
      set((state) => ({ composite: { ...state.composite, renderState: 'error', error: e?.message || String(e) } }))
    }
  },

  // Preview playback (Space, or the composite section's own Play button) —
  // the single toggle both surfaces share, so their state never drifts apart.
  // Always plays the newest COMPLETED render: _awaitFreshComposite waits out
  // any render already in flight (or still debouncing) instead of handing the
  // transport a buffer an edit has already invalidated, and renders fresh on
  // demand if nothing has ever run.
  async toggleCompositePreview() {
    if (get().compositePreviewState === 'playing') {
      stopSandboxPreview()
      set({ compositePreviewState: 'idle' })
      return
    }
    set({ compositePreviewState: 'rendering' })
    const buf = await get()._awaitFreshComposite()
    if (!buf) {
      set({ compositePreviewState: 'idle' }) // render failed — composite.error already set
      return
    }
    const started = playSandboxPreview(
      buf,
      get().selection?.startSample ?? 0,
      () => set({ compositePreviewState: 'idle' }),
    )
    set({ compositePreviewState: started ? 'playing' : 'idle' })
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
        // Every layer's render is now stale — the stack it was made from
        // moved. Schedules renders identically to a forward edit (same
        // per-layer autoRender gate, same debounced composite render).
        for (const l of get().layers) {
          if (l.sourceBufferId >= 0) get()._triggerAutoRender(l.id, which)
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
      stopSandboxPreview()
      // A project switch invalidates any auto-render cycle still in flight
      // for the OLD layer set — bump the generation so its result (were it to
      // land after this point) is recognized as stale and discarded.
      if (compositeDebounceTimer != null) { clearTimeout(compositeDebounceTimer); compositeDebounceTimer = null }
      compositeGeneration++
      set({
        layers: [],
        activeLayerId: null,
        selection: null,
        composite: { renderState: 'idle', renderedBuffer: null, error: null },
        compositePreviewState: 'idle',
        compositeAutoRender: {
          debouncePending: false, pending: false, scheduledCount: 0, ranCount: 0, supersededCount: 0,
        },
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

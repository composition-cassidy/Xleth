import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { resolveTimelinePalette } from '../timeline/timelineDrawing.js'
import { RULER_HEIGHT } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  resolveView, viewSpan, sampleToX, xToSample, samplesPerPixel, scrollViewToInclude,
} from './sandboxView.js'
import { niceTimeStep, formatTick } from './sandboxFormat.js'
import { getSandboxPreviewPosition } from './sandboxPreviewPlayer.js'
import { nearestCrossingIndex, radiusForView } from '../sampler/zeroCrossing.js'
import { opSampleRange, resolveOpRange } from './sandboxOpRange.js'
import SandboxOverviewStrip from './SandboxOverviewStrip.jsx'
import SandboxSelectionContextMenu from './SandboxSelectionContextMenu.jsx'
import useSandboxStore, {
  gainEnvelopeAt, gainEnvelopeDbAt, sortEnvelopePoints, findEnvelopeOp,
  clampGainEnvelopeFollower, GAIN_ENVELOPE_MODE, GAIN_ENVELOPE_DB_MIN,
  findSpectralPaintOp, SPC_SELECT_FREEHAND_DEFAULT,
} from '../../stores/sandboxStore.js'
import { computeAutotuneCorrectionCurve, allowedPitchClasses, quantizeToNearestNote } from './autotuneCorrectionPreview.js'

import { subscribeDpr } from '../../ui-kit/dpr'
import styles from './SandboxCanvas.module.css'
// Fallback used only before the first layout measurement, and as a floor so
// a squeezed panel never hands the canvas a degenerate (near-zero) height.
const MIN_WAVE_HEIGHT = 160
const MIN_SELECTION_PX = 3 // drags shorter than this collapse to "no selection", same gesture as a plain click

// ── Selection edge handles (Phase 3) ────────────────────────────────────────
// How close to an edge a press counts as "grab this edge" rather than "start a
// new selection". A pixel radius, not a sample one, so it stays the same
// physical target at every zoom — which is the whole reason the edges became
// draggable: once you can zoom in far enough to place an edge precisely,
// re-dragging the whole selection to nudge one side by 5ms is absurd.
const EDGE_GRAB_PX = 6

// AUTOTUNE pitch curve (P5-4) — padding added above/below the auto-fit cents
// range so a curve hugging the top/bottom of its own span doesn't touch the
// canvas edge. ~1.5 semitones; a musical unit, not a pixel one, since the
// axis itself is linear in cents.
const PITCH_AXIS_PAD_CENTS = 150

// ─── Gain envelope overlay (Audio Dynamics Editor, Mode 1) ──────────────────
//
// A dB line over the waveform, drawn on its OWN canvas above the selection
// overlay. Deliberately a third canvas rather than more drawing inside
// drawOverlay(): the envelope repaints at pointer rate during a handle drag,
// and the selection overlay has no reason to be cleared and rebuilt alongside
// it 60 times a second.
//
// ── Why a mode, not a modifier ───────────────────────────────────────────────
// The waveform already spends its left button on selection dragging. A "click
// near the line" heuristic would have to guess, and the unity line sits right
// where the loudest material is — every attempt to select a peak would grab a
// breakpoint instead. So the toolbar's ENVELOPE button arms editing, and while
// it is armed this canvas takes the pointer outright. Disarmed, it is
// pointer-events:none and the curve is still drawn, dimmed: an envelope you
// cannot see is an envelope you cannot debug when playback sounds wrong.
//
// ── The dB axis ──────────────────────────────────────────────────────────────
// Linear in dB from ENV_TOP_DB down to ENV_BOTTOM_DB, so equal vertical
// distances are equal dB — the whole point of "Y axis is dB, not linear".
// Unity sits near the TOP rather than at the middle, because this axis is used
// for ducking far more than for boosting, and because a unity line through the
// vertical centre would land exactly on the waveform's own zero-crossing line.
// The engine clamps wider than this (±96/24 dB); a curve loaded from a project
// that exceeds the drawable range is displayed clamped to the edge, and moving
// that handle rewrites it to what is on screen.
const ENV_TOP_DB = 12
const ENV_BOTTOM_DB = -60
const ENV_HANDLE_R = 4       // drawn radius
const ENV_HIT_R = 8          // grab radius — a pointer target, larger than the dot
const ENV_LINE_HIT_PX = 7    // how close to the curve a click counts as "on the line"
const ENV_GRID_DB = [0, -12, -24, -36, -48]

function dbToY(db, h) {
  const t = (ENV_TOP_DB - db) / (ENV_TOP_DB - ENV_BOTTOM_DB)
  return Math.max(0, Math.min(1, t)) * h
}

function yToDb(y, h) {
  const t = Math.max(0, Math.min(1, y / Math.max(1, h)))
  return ENV_TOP_DB - t * (ENV_TOP_DB - ENV_BOTTOM_DB)
}

// Absolute peak per pixel column, across every channel — the input to the
// headroom check. `colPeaks` is the same {lanes:[{min,max}]} the waveform draw
// already computed, so this is one pass over a few hundred floats, not over
// the audio.
function columnAbsPeaks(colPeaks, numCols) {
  const out = new Float32Array(Math.max(0, numCols))
  if (!colPeaks?.lanes?.length) return out
  for (const lane of colPeaks.lanes) {
    const n = Math.min(numCols, lane.max.length)
    for (let x = 0; x < n; x++) {
      const a = Math.max(Math.abs(lane.max[x]), Math.abs(lane.min[x]))
      if (a > out[x]) out[x] = a
    }
  }
  return out
}

// ── Mode 2 faint envelope guide (approximation, not the engine's follower) ──
//
// The engine's detected envelope runs sample-accurately over the buffer
// BEFORE this op (SandboxRenderer::gainEnvelopeFollowerDb). The canvas only
// has per-COLUMN peaks of the buffer AFTER every op including this one, so it
// cannot reproduce that number — it can only approximate it, the same way the
// headroom check already approximates "what this column looked like before
// the curve" by dividing the committed curve's implied gain back out. This is
// a visual guide for "roughly what am I modulating", not a value anything
// else in this file depends on being exact.
//
// `committedPoints`/`sampleAt` follow the same recovery trick the headroom
// check uses: divide the column's peak by what the DRAWN curve says it did to
// get back to something close to the pre-curve level. In Relative mode this
// under-corrects (the real applied gain is always closer to 0 dB than the
// drawn curve implies), so the recovered line runs slightly duller than the
// true natural signal in heavily-modulated stretches — acceptable for a faint
// guide line, not for anything load-bearing.
function approxNaturalDbPerColumn(absPeaks, committedPoints, cols, sampleForCol) {
  const out = new Float32Array(cols)
  for (let x = 0; x < cols; x++) {
    // The caller's own px→sample mapping, so column x here means the same
    // sample position it means everywhere else in this file — including once
    // the view is zoomed, where "x/cols of the buffer" stopped being true.
    const sample = sampleForCol(x)
    const drawnGain = gainEnvelopeAt(committedPoints, sample)
    const basePeak = drawnGain > 1e-6 ? absPeaks[x] / drawnGain : absPeaks[x]
    out[x] = 20 * Math.log10(Math.max(1e-9, basePeak))
  }
  return out
}

// Asymmetric one-pole across COLUMNS rather than samples: each column already
// aggregates many samples, so the attack/release times are converted to a
// per-column coefficient using how many samples one column actually spans.
// Same rise-fast/fall-slow shape as the engine's follower, at coarser
// granularity — again, a guide line, not a measurement.
function smoothFollowerDbPerColumn(rawDb, samplesPerCol, sampleRate, attackMs, releaseMs) {
  const cols = rawDb.length
  const out = new Float32Array(cols)
  if (cols === 0 || !sampleRate) return out
  const msPerCol = (samplesPerCol / sampleRate) * 1000
  const aCoeff = Math.exp(-msPerCol / Math.max(0.001, attackMs))
  const rCoeff = Math.exp(-msPerCol / Math.max(0.001, releaseMs))
  let env = rawDb[0]
  for (let x = 0; x < cols; x++) {
    const coeff = rawDb[x] > env ? aCoeff : rCoeff
    env = x === 0 ? rawDb[0] : coeff * env + (1 - coeff) * rawDb[x]
    out[x] = env
  }
  return out
}

// Min/max per pixel column, one pass over the raw samples. Cheap enough to
// redo on every data/resize change — it is NOT redone on every drag frame,
// the selection overlay is a separate canvas for that.
// Peaks are taken over the VISIBLE sample range, not the whole buffer — that
// is what zooming in actually buys: fewer samples folded into each column, so
// the drawn envelope resolves individual cycles instead of a solid block. Once
// the view is narrow enough that a column spans less than one sample, the
// per-column min/max degenerates to that one sample's value, which is exactly
// the point-per-sample picture a sample-level zoom should show.
function computeColumnPeaks(channelData, numCols, startSample, endSample) {
  const n = channelData.length
  const out = { min: new Float32Array(numCols), max: new Float32Array(numCols) }
  if (n === 0 || numCols <= 0) return out
  const from = Math.max(0, Math.min(n, Math.floor(startSample)))
  const to = Math.max(from + 1, Math.min(n, Math.ceil(endSample)))
  const span = to - from
  for (let col = 0; col < numCols; col++) {
    const s0 = from + Math.floor((col * span) / numCols)
    const s1 = Math.max(s0 + 1, from + Math.floor(((col + 1) * span) / numCols))
    let mn = Infinity, mx = -Infinity
    for (let i = s0; i < s1 && i < n; i++) {
      const v = channelData[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    out.min[col] = mn === Infinity ? 0 : mn
    out.max[col] = mx === -Infinity ? 0 : mx
  }
  return out
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '')
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 }
}

// ── Log-frequency axis (P3-1 fix) ───────────────────────────────────────────
//
// The engine hands back LINEAR fft bins (bin i == i * sampleRate/fftSize):
// correct for the DSP, useless as a picture — almost every octave of musical
// content (and every harmonic/formant line) lives below ~5 kHz, which on a
// linear axis is a thin band at the very bottom while the rest of the image
// is near-silent, near-solid-color "streaks". A real spectrogram plots
// frequency log-scaled, so this canvas resamples the linear bins onto
// log-spaced rows before ever drawing a pixel.
const SPC_FREQ_MIN_HZ = 20
const SPC_FREQ_MAX_HZ = 20000
// Labeled gridlines. Was just [100, 1000, 10000] when the card was ~96px
// tall — too little room for more without labels colliding. Now that the
// active card gets real height (see the editor pane in Sandbox.module.css
// for its height), fill in the octave-ish landmarks
// between them.
const SPC_GRID_HZ = [100, 200, 500, 1000, 2000, 5000, 10000]

// Fraction (0..1) of the log axis between minHz and maxHz that `freq` falls
// at. Shared by the image builder (which bin to sample per row) and the
// gridline overlay (which y each labeled Hz lands at) so the two can never
// drift apart pixel-for-pixel.
function freqLogT(freq, minHz, maxHz) {
  const f = Math.max(minHz, Math.min(maxHz, freq))
  return Math.log(f / minHz) / Math.log(maxHz / minHz)
}

function formatHzLabel(hz) {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`
}

// Inverse of freqLogT, for turning a pointer Y back into Hz — the paint
// brush's whole reason to exist. Row 0 (lowest frequency) is drawn at the
// BOTTOM (see buildSpectrogramImage's own comment), so y=h (bottom) is t=0.
function pxToFreq(y, h, minHz, maxHz) {
  const t = 1 - Math.max(0, Math.min(1, y / Math.max(1, h)))
  return minHz * Math.pow(maxHz / minHz, t)
}

function freqToPx(freq, h, minHz, maxHz) {
  return h * (1 - freqLogT(freq, minHz, maxHz))
}

// Builds a (numFrames x numFreqRows) pixel grid for a spectrogram result —
// ONE pixel per (frame, log-frequency row) — the visible canvas scales this
// up with drawImage, the same "compute small, let the browser stretch it"
// approach the rest of this app's mipmap-style canvas views use. Built once
// per spectrogram object and cached by the caller (see spcImageRef);
// token→color is a single-hue ramp from the page background to the accent —
// the "token-based monochromatic magnitude ramp" the spec calls for.
//
// Row r's frequency is log-spaced between SPC_FREQ_MIN_HZ and
// min(SPC_FREQ_MAX_HZ, Nyquist) — never above Nyquist, so the image never
// carries a dead band of frequencies the source buffer can't contain. The
// engine's linear bin for that frequency is `freq * fftSize / sampleRate`;
// `fftSize` itself isn't in the RPC payload, but numBins IS fftSize/2+1 (see
// SandboxSpectrogram.h), so it's recovered as (numBins-1)*2. Sampled with
// linear interpolation between the two nearest source bins — the log axis
// stretches the low end across many more rows than source bins exist for,
// and nearest-neighbour there would look staircase-blocky.
function buildSpectrogramImage(spectrogram, bgHex, accentHex) {
  const { numFrames, numBins, tokens, sampleRate } = spectrogram
  const fftSize = (numBins - 1) * 2
  const minHz = SPC_FREQ_MIN_HZ
  const maxHz = Math.min(SPC_FREQ_MAX_HZ, sampleRate / 2)
  const numFreqRows = numBins // resolution only — drawImage stretches this to the canvas's real height regardless

  const off = document.createElement('canvas')
  off.width = Math.max(1, numFrames)
  off.height = Math.max(1, numFreqRows)
  const octx = off.getContext('2d')
  const img = octx.createImageData(off.width, off.height)
  const bg = hexToRgb(bgHex)
  const accent = hexToRgb(accentHex)
  const data = img.data

  // Per-row source bin (fractional), precomputed once — every frame reuses it.
  const srcBin = new Float32Array(numFreqRows)
  for (let r = 0; r < numFreqRows; r++) {
    const t = numFreqRows > 1 ? r / (numFreqRows - 1) : 0
    const freq = minHz * Math.pow(maxHz / minHz, t)
    srcBin[r] = (freq * fftSize) / sampleRate
  }

  for (let f = 0; f < numFrames; f++) {
    const rowOffset = f * numBins
    for (let r = 0; r < numFreqRows; r++) {
      const bf = srcBin[r]
      const b0 = Math.max(0, Math.min(numBins - 1, Math.floor(bf)))
      const b1 = Math.min(numBins - 1, b0 + 1)
      const frac = bf - Math.floor(bf)
      const tok0 = tokens[rowOffset + b0]
      const tok1 = tokens[rowOffset + b1]
      const t = (tok0 + (tok1 - tok0) * frac) / 255
      // Row 0 (lowest frequency) at the BOTTOM — the same frequency-axis
      // convention as the EQ panel and the APEX curve editor.
      const y = numFreqRows - 1 - r
      const idx = (y * numFrames + f) * 4
      data[idx]     = bg.r + (accent.r - bg.r) * t
      data[idx + 1] = bg.g + (accent.g - bg.g) * t
      data[idx + 2] = bg.b + (accent.b - bg.b) * t
      data[idx + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  return { canvas: off, minHz, maxHz }
}

export default function SandboxWaveformCanvas() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const setSelection = useSandboxStore((s) => s.setSelection)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const setGainEnvelope = useSandboxStore((s) => s.setGainEnvelope)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const paintEditMode = useSandboxStore((s) => s.paintEditMode)
  const paintBrush = useSandboxStore((s) => s.paintBrush)
  const commitSpectralPaintDabs = useSandboxStore((s) => s.commitSpectralPaintDabs)
  const spcSelectMode = useSandboxStore((s) => s.spcSelectMode)
  const spcSelectShape = useSandboxStore((s) => s.spcSelectShape)
  const spcSelection = useSandboxStore((s) => s.spcSelection)
  const setSpcSelection = useSandboxStore((s) => s.setSpcSelection)
  const setSpcHoverReadout = useSandboxStore((s) => s.setSpcHoverReadout)
  const selectedOpId = useSandboxStore((s) => s.selectedOpId)
  const ensurePitchTrack = useSandboxStore((s) => s.ensurePitchTrack)
  const commitAutotuneManualStroke = useSandboxStore((s) => s.commitAutotuneManualStroke)
  const view = useSandboxStore((s) => s.view)
  const zoomByWheel = useSandboxStore((s) => s.zoomByWheel)
  const panByFraction = useSandboxStore((s) => s.panByFraction)
  const playback = useSandboxStore((s) => s.playback)
  const followPlayhead = useSandboxStore((s) => s.followPlayhead)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  // ── The one viewport ────────────────────────────────────────────────────
  // Resolved once per render against the CURRENT buffer length (see
  // sandboxView.js on why the stored view may be null or stale), then closed
  // over by every draw and every pointer handler below. Nothing in this file
  // converts px↔sample any other way.
  const numSamplesNow = layer?.renderedBuffer?.numSamples ?? 0
  const vw = useMemo(() => resolveView(view, numSamplesNow), [view, numSamplesNow])
  const s2x = useCallback((sample, w) => sampleToX(sample, vw, w), [vw])
  const x2s = useCallback((px, w) => xToSample(px, vw, w, numSamplesNow), [vw, numSamplesNow])

  const containerRef = useRef(null)
  const stackRef = useRef(null)
  const rulerCanvasRef = useRef(null)
  const bgCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const envCanvasRef = useRef(null)
  const paintCanvasRef = useRef(null)
  const spcSelectCanvasRef = useRef(null)
  const pitchCanvasRef = useRef(null)
  const playheadCanvasRef = useRef(null)
  const sizeRef = useRef({ w: 0, h: MIN_WAVE_HEIGHT })
  const colPeaksRef = useRef(null) // { numChannels, cols: [{min,max}, ...] }
  // Offscreen spectrogram bitmap, rebuilt only when the spectrogram OBJECT
  // changes (a new render/analysis) — not on every resize/theme redraw.
  const spcImageRef = useRef({ spectrogram: null, canvas: null })
  const dragRef = useRef(null) // { startPx, endPx } while dragging
  // Live envelope drag: { points, index }. This is the ENTIRE local-preview
  // mechanism — while it is non-null the canvas draws from it instead of from
  // the store, and nothing has been committed. Cleared on mouseup, at which
  // point exactly one UndoManager command goes out.
  const envDragRef = useRef(null)
  // Live paint-stroke drag: an array of dabs accumulated so far this stroke,
  // or null between strokes — the same "entire local-preview mechanism, one
  // commit on release" contract envDragRef uses (see commitSpectralPaintDabs).
  const paintDragRef = useRef(null)
  // Live AUTOTUNE Manual-mode stroke: { axis, previewPoints } while dragging,
  // or null between strokes — same "entire local-preview mechanism, one
  // commit on release" contract envDragRef/paintDragRef use. `axis` (the
  // cents/time range the canvas is currently fit to) is frozen at pointerdown
  // rather than recomputed every move, so the drawn line doesn't wobble as
  // the in-progress stroke temporarily extends past the committed range.
  const pitchDragRef = useRef(null)
  // Live SPC selection drag: an array of shapes accumulated so far, or null
  // between drags — same "entire local-preview mechanism, one commit on
  // release" contract paintDragRef uses. Committing here means
  // setSpcSelection (a store write of the final shape list), not an engine
  // call — the engine is only ever reached once an action (ATTENUATE/BOOST/
  // MUTE/COPY TO NEW LAYER) fires on the committed selection.
  const spcSelectDragRef = useRef(null)

  const spectralPaintOp = findSpectralPaintOp(layer)
  const paintDabs = spectralPaintOp?.params?.dabs ?? []

  const envOp = findEnvelopeOp(layer)
  const envBypassed = !!envOp && envOp.enabled === false
  // The committed curve. An absent op is an empty list, which draws (and
  // renders) as flat unity — so "no envelope yet" and "an envelope sitting at
  // 0 dB" are the same picture, and the first click on either behaves the same.
  // Memoized on the op's own params object, which the store replaces only on
  // an accepted mutation. Without this the array identity would change on
  // every render, taking drawEnvelope → redrawAll → the draw effect with it,
  // and drawBackground would recompute the whole column-peak table each time.
  const envParamPoints = envOp?.params?.points
  const committedPoints = useMemo(() => sortEnvelopePoints(envParamPoints), [envParamPoints])
  const envFollower = useMemo(() => clampGainEnvelopeFollower(envOp?.params), [envOp?.params])
  const envIsRelative = envFollower.mode === GAIN_ENVELOPE_MODE.relative

  // ── AUTOTUNE pitch curve (P5-4) ──────────────────────────────────────────
  // Only the SELECTED op counts (unlike the envelope/paint overlays, which
  // own the layer's one instance of their op type outright) — AUTOTUNE is a
  // read-only preview of an op that already carries its own inline editor,
  // so it only earns waveform space while the user is actually looking at
  // its row. `ensurePitchTrack` itself is idempotent and fetches at most
  // once per layer (session-cached, see sandboxStore.js), so re-arming this
  // on every render is free.
  const autotuneOp = layer?.ops.find((o) => o.id === selectedOpId && o.type === 'autotune') ?? null
  useEffect(() => {
    if (autotuneOp && layer) ensurePitchTrack(layer.id)
  }, [autotuneOp, layer, ensurePitchTrack])
  // The "corrected target" line has no engine RPC of its own (P5-1 serves
  // only the raw f0 track) — computeAutotuneCorrectionCurve re-derives it
  // client-side from the same six controls the inline editor edits, purely
  // for this preview. Memoized on the op's own params object and the fetched
  // track, so dragging an unrelated control (e.g. Amount on a DIFFERENT op)
  // never re-runs the per-frame loop.
  const pitchTrack = layer?.pitchTrack ?? null
  const autotuneParams = autotuneOp?.params
  // MANUAL mode (P5-5) has no scale/key target to compute here — the drawn
  // curve is rendered directly from autotuneParams.manualPoints inside
  // drawPitchCurve, with no dependency on a successful analysis (see the
  // "always drawable" note on that function).
  const correctionCurve = useMemo(() => {
    if (autotuneParams?.mode === 1) return null
    if (!pitchTrack || !pitchTrack.monophonic || !autotuneParams) return null
    return computeAutotuneCorrectionCurve(
      pitchTrack.frames, pitchTrack.notes, pitchTrack.sampleRate,
      autotuneParams.scale, autotuneParams.key, autotuneParams.allowedNotes || [], autotuneParams,
    )
  }, [pitchTrack, autotuneParams])

  function applyCanvasSize(canvas, w, h, dpr) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  const drawBackground = useCallback(() => {
    const canvas = bgCanvasRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    const palette = resolveTimelinePalette()

    ctx.fillStyle = tokenValue('--theme-bg-primary') || '#101010'
    ctx.fillRect(0, 0, w, h)

    if (!layer) {
      ctx.fillStyle = palette.rulerText
      ctx.font = uiCanvasFont('11px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Drag a sample into Sources & Layers to begin', w / 2, h / 2)
      ctx.textAlign = 'left'
      return
    }

    const buf = layer.renderedBuffer
    if (!buf) {
      ctx.fillStyle = palette.rulerText
      ctx.font = uiCanvasFont('11px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const msg = layer.renderState === 'error' ? `Render failed: ${layer.error || ''}` : 'Rendering…'
      ctx.fillText(msg, w / 2, h / 2)
      ctx.textAlign = 'left'
      return
    }

    // Column peaks are computed regardless of view mode: the envelope
    // overlay's headroom check reads colPeaksRef in BOTH views — an editable
    // gain envelope is still something you draw while looking at SPC.
    const numChannels = buf.numChannels || 1
    colPeaksRef.current = {
      numSamples: buf.numSamples,
      lanes: buf.channels.map((chan) => computeColumnPeaks(
        chan, Math.max(1, Math.round(w)), vw.startSample, vw.endSample,
      )),
    }

    if (viewMode === 'spc') {
      if (layer.spectrogram) {
        let cache = spcImageRef.current
        if (cache.spectrogram !== layer.spectrogram) {
          const built = buildSpectrogramImage(
            layer.spectrogram,
            tokenValue('--theme-bg-primary') || '#101010',
            tokenValue('--theme-accent') || '#fe589a',
          )
          cache = { spectrogram: layer.spectrogram, ...built }
          spcImageRef.current = cache
        }
        // No smoothing: a token grid is discrete data, and a blurred STFT
        // frame boundary would misrepresent where a paint-out stroke's
        // feather (P3-2) actually falls.
        ctx.imageSmoothingEnabled = false
        // Source-rect crop, so the spectrogram zooms with everything else. The
        // cached bitmap is one column per STFT frame across the whole buffer,
        // so the visible sample range maps to a frame range by simple
        // proportion — the frames are evenly spaced by construction (hop size
        // is constant), which is what makes this legitimate rather than an
        // approximation.
        const frames = cache.canvas.width
        const sx = (vw.startSample / Math.max(1, buf.numSamples)) * frames
        const sw = Math.max(1e-6, (viewSpan(vw) / Math.max(1, buf.numSamples)) * frames)
        ctx.drawImage(cache.canvas, sx, 0, sw, cache.canvas.height, 0, 0, w, h)

        // Log-frequency axis — gridlines + Hz labels at the landmarks the
        // spec calls for. Recomputed every draw (cheap text/line work)
        // rather than baked into the cached bitmap, which stays pure pixel
        // data keyed only on the spectrogram object.
        ctx.save()
        ctx.font = uiCanvasFont('9px')
        ctx.textBaseline = 'alphabetic'
        for (const hz of SPC_GRID_HZ) {
          if (hz < cache.minHz || hz > cache.maxHz) continue
          const y = Math.round(h * (1 - freqLogT(hz, cache.minHz, cache.maxHz))) + 0.5
          ctx.strokeStyle = palette.rulerGridMinor || palette.laneSeparator
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
          ctx.fillStyle = palette.rulerText
          ctx.fillText(formatHzLabel(hz), 3, y - 2)
        }
        ctx.restore()
      } else {
        ctx.fillStyle = palette.rulerText
        ctx.font = uiCanvasFont('11px')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(layer.spectrogramState === 'error' ? 'Spectrogram analysis failed' : 'Analyzing…', w / 2, h / 2)
        ctx.textAlign = 'left'
      }
      return
    }

    const laneH = h / numChannels
    for (let ch = 0; ch < numChannels; ch++) {
      const top = ch * laneH
      const mid = top + laneH / 2
      const amp = laneH * 0.48
      const cols = colPeaksRef.current.lanes[ch]

      // dB center line — the zero-amplitude reference for this lane.
      ctx.strokeStyle = palette.rulerGridMinor || palette.laneSeparator
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, Math.round(mid) + 0.5)
      ctx.lineTo(w, Math.round(mid) + 0.5)
      ctx.stroke()

      // Envelope fill
      ctx.beginPath()
      for (let x = 0; x < cols.max.length; x++) {
        const y = mid - cols.max[x] * amp
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      for (let x = cols.min.length - 1; x >= 0; x--) {
        ctx.lineTo(x, mid - cols.min[x] * amp)
      }
      ctx.closePath()
      ctx.fillStyle = palette.clipWaveformBg || 'rgba(0,184,150,0.25)'
      ctx.fill()
      ctx.strokeStyle = palette.clipWaveformFg || palette.accent
      ctx.lineWidth = 1
      ctx.stroke()

      if (ch > 0) {
        ctx.strokeStyle = palette.laneSeparator
        ctx.beginPath()
        ctx.moveTo(0, Math.round(top) + 0.5)
        ctx.lineTo(w, Math.round(top) + 0.5)
        ctx.stroke()
      }
    }
  }, [layer, viewMode, vw])

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)

    const drag = dragRef.current
    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    let startPx = null, endPx = null
    if (drag) {
      startPx = Math.min(drag.startPx, drag.endPx)
      endPx = Math.max(drag.startPx, drag.endPx)
    } else if (selection && numSamples) {
      startPx = s2x(selection.startSample, w)
      endPx = s2x(selection.endSample, w)
    }
    const palette = resolveTimelinePalette()

    // ── The selected op's own range (Phase 3) ─────────────────────────────
    // Drawn UNDER the selection, in a neutral hatch rather than the accent:
    // it is context ("this entry acts here"), not a thing the pointer is
    // currently holding. Ops with no locatable range draw nothing — see
    // sandboxOpRange.js on why that is better than highlighting everything.
    const selectedOp = layer?.ops?.find((o) => o.id === selectedOpId) ?? null
    const opRange = resolveOpRange(opSampleRange(selectedOp), numSamples)
    if (opRange) {
      const ox0 = s2x(opRange.startSample, w)
      const ox1 = s2x(opRange.endSample, w)
      ctx.save()
      ctx.fillStyle = tokenValue('--theme-text-muted') || '#888'
      ctx.globalAlpha = 0.12
      ctx.fillRect(ox0, 0, Math.max(1, ox1 - ox0), h)
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = tokenValue('--theme-text-muted') || '#888'
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(ox0) + 0.5, 0.5, Math.max(1, ox1 - ox0), h - 1)
      ctx.restore()
    }

    if (startPx == null) return

    // A zero-width selection is the CURSOR — where Play starts and Paste
    // lands. Drawn as a single line with a small cap, so it reads as a
    // position rather than a collapsed region.
    if (endPx - startPx < 1) {
      const x = Math.round(startPx) + 0.5
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.fillStyle = palette.accent
      ctx.fillRect(x - 2.5, 0, 5, 3)
      return
    }
    ctx.fillStyle = tokenValue('--theme-accent-bg-subtle') || 'rgba(0,184,150,0.14)'
    ctx.fillRect(startPx, 0, endPx - startPx, h)
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(startPx + 0.5, 0)
    ctx.lineTo(startPx + 0.5, h)
    ctx.moveTo(endPx - 0.5, 0)
    ctx.lineTo(endPx - 0.5, h)
    ctx.stroke()

    // Grips — the visible half of the draggable edges (the cursor change is
    // the other half). Small filled caps top and bottom rather than a full
    // handle bar: they have to be findable without covering the material at
    // the very boundary the user is trying to see.
    ctx.fillStyle = palette.accent
    for (const ex of [startPx + 0.5, endPx - 0.5]) {
      ctx.fillRect(ex - 2.5, 0, 5, 6)
      ctx.fillRect(ex - 2.5, h - 6, 5, 6)
    }
  }, [layer, selection, s2x, selectedOpId])

  // ── Envelope draw ────────────────────────────────────────────────────────
  //
  // The headroom warning is EXACT in Absolute mode, because both halves of
  // the arithmetic are known: the rendered buffer on screen already has the
  // COMMITTED curve baked into it, so dividing a column's peak back out by the
  // committed gain recovers what that column looked like before this op — and
  // multiplying that by the curve currently being dragged predicts what the
  // next render will produce. Standing still (no drag) the two curves are the
  // same and it degenerates to "this column is already over 0 dBFS", which is
  // not a prediction at all but a report.
  //
  // It is exact only while the envelope is the LAST op that changes level; an
  // op added after it can move the peaks again. That is the same caveat every
  // range-carrying op in this panel already lives with.
  //
  // In Relative mode the prediction is additionally only APPROXIMATE even
  // under that caveat: the real applied gain is the drawn dB scaled by the
  // engine's own sample-accurate follower, which this canvas cannot
  // reproduce — see approxNaturalDbPerColumn / smoothFollowerDbPerColumn above
  // for the column-granularity stand-in it uses instead.
  const drawEnvelope = useCallback(() => {
    const canvas = envCanvasRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)

    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    if (!layer || !numSamples) return

    const drag = envDragRef.current
    const display = drag ? drag.points : committedPoints
    const cols = Math.max(1, Math.round(w))

    const accent = tokenValue('--theme-accent') || '#fe589a'
    const danger = tokenValue('--theme-danger') || '#e05260'
    const muted = tokenValue('--theme-text-muted') || '#888'
    const subtle = tokenValue('--theme-border-subtle') || '#333'
    const strong = tokenValue('--theme-border-strong') || '#555'
    const active = envelopeEditMode && !envBypassed
    const lineColor = active ? accent : muted

    // dB grid + unity reference. Unity is always drawn — it is the line the
    // user is deviating FROM, and without it a shallow duck reads as a flat
    // line in the wrong place. The rest of the ladder only appears while
    // editing, where the numbers are actually being aimed at.
    ctx.save()
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1
    ctx.font = uiCanvasFont('9px')
    ctx.textBaseline = 'middle'
    for (const db of ENV_GRID_DB) {
      if (db !== 0 && !active) continue
      const y = Math.round(dbToY(db, h)) + 0.5
      ctx.strokeStyle = db === 0 ? strong : subtle
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      if (active) {
        ctx.fillStyle = muted
        ctx.fillText(db === 0 ? '0 dB' : `${db}`, 3, y - 6)
      }
    }
    ctx.restore()

    // The curve, one segment per pixel column, recoloured where the predicted
    // output would clip. Drawn as individual segments rather than one path so
    // the over-0-dBFS stretch can carry its own colour without a second pass.
    const absPeaks = columnAbsPeaks(colPeaksRef.current, cols)

    // Mode 2's faint "what am I modulating" guide, drawn UNDER the editable
    // curve. Only worth computing when it will actually be visible.
    let naturalDb = null
    let naturalMinDb = 0
    let naturalRangeDb = 0
    if (envIsRelative && !envBypassed) {
      const rawDb = approxNaturalDbPerColumn(absPeaks, committedPoints, cols, (x) => x2s(x, cols))
      const samplesPerCol = samplesPerPixel(vw, cols)
      const sampleRate = layer?.renderedBuffer?.sampleRate || 48000
      naturalDb = smoothFollowerDbPerColumn(rawDb, samplesPerCol, sampleRate,
        envFollower.followerAttackMs, envFollower.followerReleaseMs)
      let mn = naturalDb[0] ?? 0, mx = mn
      for (const v of naturalDb) { if (v < mn) mn = v; if (v > mx) mx = v }
      naturalMinDb = mn
      naturalRangeDb = mx - mn
    }

    if (naturalDb) {
      ctx.save()
      ctx.globalAlpha = 0.4
      ctx.strokeStyle = muted
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x < cols; x++) {
        const y = dbToY(naturalDb[x], h)
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()
    }

    const ys = new Float32Array(cols)
    const over = new Uint8Array(cols)
    for (let x = 0; x < cols; x++) {
      // Same px→sample mapping the pointer handlers use, so a handle drawn at
      // s2x(p) lands on the column that evaluates to p's own dB.
      const sample = Math.min(numSamples - 1, x2s(x, cols))
      const displayGain = gainEnvelopeAt(display, sample)
      // An empty curve evaluates to 1.0, i.e. 0 dB — no special case needed.
      // The editable line's SHAPE never changes with mode — only its EFFECT
      // does — so this stays the drawn curve's own gain in both modes.
      ys[x] = dbToY(20 * Math.log10(Math.max(1e-9, displayGain)), h)

      if (envBypassed) continue
      const committedGain = gainEnvelopeAt(committedPoints, sample)
      // A column the committed curve has already muted carries no recoverable
      // information about its own peak — 0 / 0. Say nothing rather than guess.
      if (committedGain <= 1e-6) continue
      const basePeak = absPeaks[x] / committedGain

      let predictedGain = displayGain
      if (naturalDb && naturalRangeDb > 1e-9) {
        const normalized = Math.max(0, Math.min(1, (naturalDb[x] - naturalMinDb) / naturalRangeDb))
        const drawnDb = gainEnvelopeDbAt(display, sample)
        const appliedDb = drawnDb * normalized
        predictedGain = appliedDb <= GAIN_ENVELOPE_DB_MIN ? 0 : Math.pow(10, appliedDb / 20)
      }
      if (basePeak * predictedGain > 1.0) over[x] = 1
    }

    ctx.lineWidth = active ? 2 : 1.25
    ctx.globalAlpha = envBypassed ? 0.35 : 1
    for (let x = 1; x < cols; x++) {
      ctx.strokeStyle = (over[x] || over[x - 1]) ? danger : lineColor
      ctx.beginPath()
      ctx.moveTo(x - 1, ys[x - 1])
      ctx.lineTo(x, ys[x])
      ctx.stroke()
    }

    // Handles — only while armed. Read-only, they would just be clutter over
    // the waveform.
    if (active) {
      for (const pt of display) {
        const x = s2x(pt.samplePos, w)
        const y = dbToY(pt.db, h)
        ctx.beginPath()
        ctx.arc(x, y, ENV_HANDLE_R, 0, Math.PI * 2)
        ctx.fillStyle = accent
        ctx.fill()
        // Ring in the page background so a handle stays readable when it lands
        // on top of the accent-coloured waveform.
        ctx.strokeStyle = tokenValue('--theme-bg-primary') || '#101010'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }, [layer, committedPoints, envelopeEditMode, envBypassed, envIsRelative, envFollower, vw, s2x, x2s])

  // ── Spectral paint draw (P3-2) ──────────────────────────────────────────
  //
  // Draws every committed dab (from the op's own params — accent) plus, while
  // a stroke is in flight, the dabs accumulated so far in paintDragRef (a
  // second colour) — the "local preview during paint" the spec calls for.
  // Only meaningful over the SPC view: a dab's whole footprint is time ×
  // frequency, and the WAV view has no frequency axis to place it on.
  const drawPaint = useCallback(() => {
    const canvas = paintCanvasRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    if (viewMode !== 'spc') return

    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    const sampleRate = layer?.renderedBuffer?.sampleRate || 48000
    if (!numSamples) return

    const minHz = SPC_FREQ_MIN_HZ
    const maxHz = Math.min(SPC_FREQ_MAX_HZ, sampleRate / 2)
    const accent = tokenValue('--theme-accent') || '#fe589a'
    const danger = tokenValue('--theme-danger') || '#e05260'

    const drawDab = (d, color) => {
      const featherSamples = (Math.max(0, d.featherTimeMs) / 1000) * sampleRate
      const x0 = s2x(d.centerSample - d.halfWidthSamples - featherSamples, w)
      const x1 = s2x(d.centerSample + d.halfWidthSamples + featherSamples, w)
      const yTop = freqToPx(d.centerFreqHz + d.halfHeightHz + Math.max(0, d.featherFreqHz), h, minHz, maxHz)
      const yBot = freqToPx(d.centerFreqHz - d.halfHeightHz - Math.max(0, d.featherFreqHz), h, minHz, maxHz)
      ctx.fillStyle = color
      ctx.globalAlpha = 0.18
      ctx.fillRect(x0, yTop, Math.max(1, x1 - x0), Math.max(1, yBot - yTop))

      // The core (pre-feather) footprint, drawn a bit stronger so the brush's
      // actual centre reads clearly under the softer feathered fringe.
      const cx0 = s2x(d.centerSample - d.halfWidthSamples, w)
      const cx1 = s2x(d.centerSample + d.halfWidthSamples, w)
      const cyTop = freqToPx(d.centerFreqHz + d.halfHeightHz, h, minHz, maxHz)
      const cyBot = freqToPx(d.centerFreqHz - d.halfHeightHz, h, minHz, maxHz)
      ctx.globalAlpha = 0.4
      ctx.fillRect(cx0, cyTop, Math.max(1, cx1 - cx0), Math.max(1, cyBot - cyTop))
    }

    ctx.globalAlpha = 1
    for (const d of paintDabs) drawDab(d, accent)
    for (const d of (paintDragRef.current || [])) drawDab(d, danger)
    ctx.globalAlpha = 1
  }, [layer, viewMode, paintDabs, s2x])

  // ── SPC selection draw (rect/freehand t×f selection tool) ────────────────
  //
  // Draws the COMMITTED selection (from the store — accent, dashed outline)
  // plus, while a drag is in flight, the shapes accumulated so far in
  // spcSelectDragRef (a second colour) — same "local preview during the drag"
  // contract drawPaint uses. Unlike drawPaint's filled dabs, a selection is
  // drawn as an OUTLINE only: it has no amountDb yet, so filling it the way a
  // dab's attenuation strength is filled would imply a strength that has not
  // been chosen.
  const drawSpcSelect = useCallback(() => {
    const canvas = spcSelectCanvasRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    if (viewMode !== 'spc') return

    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    const sampleRate = layer?.renderedBuffer?.sampleRate || 48000
    if (!numSamples) return

    const minHz = SPC_FREQ_MIN_HZ
    const maxHz = Math.min(SPC_FREQ_MAX_HZ, sampleRate / 2)
    const accent = tokenValue('--theme-accent') || '#fe589a'
    const danger = tokenValue('--theme-danger') || '#e05260'

    const drawShape = (s, color) => {
      const x0 = s2x(s.centerSample - s.halfWidthSamples, w)
      const x1 = s2x(s.centerSample + s.halfWidthSamples, w)
      const yTop = freqToPx(s.centerFreqHz + s.halfHeightHz, h, minHz, maxHz)
      const yBot = freqToPx(s.centerFreqHz - s.halfHeightHz, h, minHz, maxHz)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.strokeRect(x0, yTop, Math.max(1, x1 - x0), Math.max(1, yBot - yTop))
      ctx.setLineDash([])
    }

    for (const s of (spcSelection?.shapes || [])) drawShape(s, accent)
    for (const s of (spcSelectDragRef.current || [])) drawShape(s, danger)
  }, [layer, viewMode, spcSelection, s2x])

  // ── AUTOTUNE pitch curve draw (P5-4/P5-5) ───────────────────────────────
  //
  // Read-only preview in SCALE mode (per-note editing is out of scope there,
  // the six controls are the whole surface). In MANUAL mode this same canvas
  // IS the target-pitch editor — see handlePitchDown below. Only meaningful
  // over the WAV view, mirroring why drawPaint gates on 'spc' the other way
  // — a pitch curve has no reading over a spectrogram image.
  //
  // Time is the shared axis with the rest of the stack: the pitch track's
  // own sample grid is the SOURCE buffer's (sandbox_getPitchTrack reads it
  // directly, see sandboxStore.js's ensurePitchTrack), which is only the
  // same timeline as the displayed renderedBuffer when nothing upstream of
  // AUTOTUNE trims/stretches it — true in the common case (AUTOTUNE is a
  // singleton, usually the only or first shaping op), a known approximation
  // otherwise. Converting through TIME (not sample index) at least keeps the
  // two rates honest when they differ.

  // Auto-fits the cents axis to whatever pitch actually appears (detected f0
  // + whichever target is active), so a low speaking voice and a high vocal
  // run both use the full height. Shared by drawPitchCurve (recomputed each
  // non-dragging render) and handlePitchDown (frozen for the duration of one
  // stroke — see pitchDragRef's comment on why).
  const getPitchAxis = useCallback(() => {
    let minCents = Infinity
    let maxCents = -Infinity
    for (const fr of (pitchTrack?.frames || [])) {
      if (fr.f0Hz > 0) {
        const c = 1200 * Math.log2(fr.f0Hz)
        if (c < minCents) minCents = c
        if (c > maxCents) maxCents = c
      }
    }
    for (const fr of (correctionCurve || [])) {
      if (fr.targetF0Hz > 0) {
        const c = 1200 * Math.log2(fr.targetF0Hz)
        if (c < minCents) minCents = c
        if (c > maxCents) maxCents = c
      }
    }
    for (const pt of (autotuneOp?.params?.manualPoints || [])) {
      if (pt.hz > 0) {
        const c = 1200 * Math.log2(pt.hz)
        if (c < minCents) minCents = c
        if (c > maxCents) maxCents = c
      }
    }
    if (!Number.isFinite(minCents)) {
      // Nothing to fit yet — no analysis, no drawn points. A fixed 2-octave
      // window centered on the op's current key, so Manual mode has
      // somewhere sensible to draw before the first stroke.
      const key = autotuneOp?.params?.key ?? 2
      const rootHz = 440 * Math.pow(2, (60 + key - 69) / 12)
      const rootCents = 1200 * Math.log2(rootHz)
      return { minCents: rootCents - 1200, maxCents: rootCents + 1200 }
    }
    return { minCents: minCents - PITCH_AXIS_PAD_CENTS, maxCents: maxCents + PITCH_AXIS_PAD_CENTS }
  }, [pitchTrack, correctionCurve, autotuneOp])

  const drawPitchCurve = useCallback(() => {
    const canvas = pitchCanvasRef.current
    const w = sizeRef.current.w
    const h = sizeRef.current.h
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    if (!autotuneOp || viewMode !== 'wav' || !layer?.renderedBuffer) return

    const isManual = autotuneOp.params?.mode === 1
    const accent = tokenValue('--theme-accent') || '#fe589a'
    const warning = tokenValue('--theme-warning') || '#FFAA33'
    const muted = tokenValue('--theme-text-muted') || '#888'
    const danger = tokenValue('--theme-danger') || '#e05260'
    const placeholder = tokenValue('--theme-text-placeholder') || '#666'

    // Time → x THROUGH the viewport: the pitch track is sampled in the source
    // buffer's own rate, so a time is converted to a sample index first and
    // then mapped by the same s2x every other overlay uses. Before the
    // viewport existed this was a direct duration-proportional map, which is
    // the same thing only while the view happens to be fitted.
    const rateForPitch = layer.renderedBuffer.sampleRate || 48000
    const xForTime = (tSec) => s2x(tSec * rateForPitch, w)

    // While a stroke is in flight, use the axis frozen at pointerdown rather
    // than refitting to the in-progress stroke every move — refitting live
    // would make the curve visibly rescale under the pointer as it draws.
    const drag = pitchDragRef.current
    const { minCents, maxCents } = drag ? drag.axis : getPitchAxis()
    const rangeCents = Math.max(1, maxCents - minCents)
    const yForCents = (c) => h - ((c - minCents) / rangeCents) * h
    const hzY = (hz) => yForCents(1200 * Math.log2(hz))

    // SCALE mode keeps the original refusal-blocks-canvas behaviour: there is
    // no meaningful quantized target to show without a successful monophonic
    // analysis. MANUAL draws its grid and its own curve regardless — only the
    // detected-f0 REFERENCE overlay below depends on analysis succeeding.
    if (!isManual) {
      if (!pitchTrack) {
        ctx.fillStyle = placeholder
        ctx.font = uiCanvasFont('9px')
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText('Analyzing pitch…', 4, 4)
        return
      }
      // The monophonic refusal (P5-4's other deliverable) — rendered directly
      // on the curve's own canvas rather than a separate DOM banner, so it
      // sits exactly where a garbled curve would otherwise have been drawn.
      // Uses the analysis's own wording (same string the op row's refusal
      // banner shows once a render has actually run and refused).
      if (!pitchTrack.monophonic) {
        ctx.fillStyle = danger
        ctx.font = uiCanvasFont('11px')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(
          pitchTrack.reason || 'polyphonic content — Autotune is monophonic-only', w / 2, h / 2,
        )
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        return
      }
    }

    const frames = pitchTrack?.frames || []
    const haveAnalysis = !!(pitchTrack && pitchTrack.monophonic && frames.length)

    if (haveAnalysis) {
      // Note-segment boundaries first, so both curves paint over them.
      ctx.save()
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = placeholder
      ctx.fillStyle = placeholder
      ctx.font = uiCanvasFont('9px')
      ctx.textBaseline = 'top'
      for (const seg of pitchTrack.notes) {
        const x = xForTime(seg.startSample / pitchTrack.sampleRate)
        ctx.beginPath()
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, h)
        ctx.stroke()
        ctx.fillText(seg.noteName, x + 3, 2)
      }
      ctx.restore()

      // Both curves break across unvoiced gaps rather than interpolating
      // through them — a straight line across a consonant would claim a
      // pitch that was never actually detected there.
      const strokeCurve = (getHz, color, width) => {
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.beginPath()
        let open = false
        for (let i = 0; i < frames.length; i++) {
          const hz = getHz(i)
          if (!(hz > 0)) { open = false; continue }
          const x = xForTime(frames[i].posSample / pitchTrack.sampleRate)
          const y = hzY(hz)
          if (open) ctx.lineTo(x, y); else ctx.moveTo(x, y)
          open = true
        }
        ctx.stroke()
      }
      // Raw detected f0 (muted, the "before") drawn under whichever target is
      // active — SCALE's quantized target (accent) or, in Manual, the drawn
      // curve below (warning) — the one control-affecting line gets the one
      // accent-family colour, per the design system's "single teal accent on
      // meaningful state" rule; the detected curve is context, not state.
      strokeCurve((i) => frames[i].f0Hz, muted, 1)
      if (!isManual && correctionCurve) {
        strokeCurve((i) => correctionCurve[i].targetF0Hz, accent, 1.5)
      }
    }

    if (isManual) {
      const points = drag ? drag.previewPoints : (autotuneOp.params?.manualPoints || [])
      if (points.length > 0) {
        ctx.strokeStyle = warning
        ctx.lineWidth = 1.5
        ctx.beginPath()
        let open = false
        for (const pt of points) {
          if (!(pt.hz > 0)) { open = false; continue }
          const x = xForTime(pt.t)
          const y = hzY(pt.hz)
          if (open) ctx.lineTo(x, y); else ctx.moveTo(x, y)
          open = true
        }
        ctx.stroke()
        // Breakpoint markers, so a lone drawn point (before it has anything
        // to connect to) is still visible rather than invisible.
        ctx.fillStyle = warning
        for (const pt of points) {
          if (!(pt.hz > 0)) continue
          ctx.beginPath()
          ctx.arc(xForTime(pt.t), hzY(pt.hz), 1.5, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (!drag) {
        ctx.fillStyle = placeholder
        ctx.font = uiCanvasFont('9px')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('Draw a target pitch curve — hold ALT to free-draw', w / 2, h / 2)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
    }
  }, [autotuneOp, viewMode, layer, pitchTrack, correctionCurve, getPitchAxis, s2x])

  // ── Ruler: SECONDS, over the visible range ──────────────────────────────
  //
  // This used to call the timeline's own drawRuler with a pixels-per-BEAT
  // derived from the project BPM. A sandbox layer is an offline buffer with no
  // relationship to the project's tempo grid, so those beat numbers described
  // nothing — and they disagreed with the status bar (seconds) and the op
  // stack (sample indices) sitting either side of them. One vocabulary now:
  // seconds, with the tick step chosen from a 1-2-5 ladder so the labels stay
  // ~80px apart from a whole minute down to a few dozen samples.
  const drawRulerCanvas = useCallback(() => {
    const canvas = rulerCanvasRef.current
    const w = sizeRef.current.w
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    const palette = resolveTimelinePalette()
    ctx.clearRect(0, 0, w, RULER_HEIGHT)
    ctx.fillStyle = tokenValue('--theme-bg-secondary') || '#181818'
    ctx.fillRect(0, 0, w, RULER_HEIGHT)

    const sampleRate = layer?.renderedBuffer?.sampleRate
    if (!sampleRate || !numSamplesNow) return

    const MIN_LABEL_PX = 78
    const stepSec = niceTimeStep((samplesPerPixel(vw, w) / sampleRate) * MIN_LABEL_PX)
    const startSec = vw.startSample / sampleRate
    const endSec = vw.endSample / sampleRate

    ctx.font = uiCanvasFont('9px')
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    // A minor tick every fifth of a labelled step — enough to read position
    // between labels without turning the strip into a picket fence.
    const minorStep = stepSec / 5
    ctx.strokeStyle = palette.rulerGridMinor || palette.laneSeparator
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let t = Math.ceil(startSec / minorStep) * minorStep; t <= endSec; t += minorStep) {
      const x = Math.round(s2x(t * sampleRate, w)) + 0.5
      ctx.moveTo(x, RULER_HEIGHT - 4)
      ctx.lineTo(x, RULER_HEIGHT)
    }
    ctx.stroke()

    ctx.strokeStyle = palette.rulerText
    ctx.fillStyle = palette.rulerText
    ctx.beginPath()
    for (let t = Math.ceil(startSec / stepSec) * stepSec; t <= endSec; t += stepSec) {
      const x = Math.round(s2x(t * sampleRate, w)) + 0.5
      ctx.moveTo(x, RULER_HEIGHT - 8)
      ctx.lineTo(x, RULER_HEIGHT)
      ctx.fillText(formatTick(t, stepSec), x + 3, RULER_HEIGHT - 10)
    }
    ctx.stroke()
  }, [layer, vw, numSamplesNow, s2x])

  const redrawAll = useCallback(() => {
    drawBackground()
    drawOverlay()
    drawEnvelope()
    drawPaint()
    drawSpcSelect()
    drawPitchCurve()
    drawRulerCanvas()
  }, [drawBackground, drawOverlay, drawEnvelope, drawPaint, drawSpcSelect, drawPitchCurve, drawRulerCanvas])

  // The ResizeObserver below is set up once (mount) and lives for the
  // component's lifetime, so it must never call redrawAll directly — that
  // would close over whatever `layer` was AT MOUNT (usually null, since a
  // freshly added source hasn't rendered yet). Route it through a ref kept
  // current every render instead, so a size correction that lands after a
  // render arrives repaints with the CURRENT data, not the mount-time one.
  const redrawAllRef = useRef(redrawAll)
  useEffect(() => { redrawAllRef.current = redrawAll }, [redrawAll])

  // ── Sizing (ResizeObserver) ─────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const sizeAndDraw = () => {
      const w = Math.floor(container.clientWidth)
      // The stack fills whatever the flex column leaves it (area height minus
      // the ruler), so its own clientHeight — not a fixed constant — is the
      // canvas's true available headroom.
      const h = Math.max(MIN_WAVE_HEIGHT, Math.floor(stackRef.current?.clientHeight || 0))
      const dpr = window.devicePixelRatio || 1
      // Window zoom changes the DPR without changing the CSS box: re-size for it too.
      if (w === 0 || (w === sizeRef.current.w && h === sizeRef.current.h && dpr === sizeRef.current.dpr)) return
      sizeRef.current = { w, h, dpr }
      if (rulerCanvasRef.current) applyCanvasSize(rulerCanvasRef.current, w, RULER_HEIGHT, dpr)
      if (bgCanvasRef.current) applyCanvasSize(bgCanvasRef.current, w, h, dpr)
      if (overlayCanvasRef.current) applyCanvasSize(overlayCanvasRef.current, w, h, dpr)
      if (envCanvasRef.current) applyCanvasSize(envCanvasRef.current, w, h, dpr)
      if (paintCanvasRef.current) applyCanvasSize(paintCanvasRef.current, w, h, dpr)
      if (spcSelectCanvasRef.current) applyCanvasSize(spcSelectCanvasRef.current, w, h, dpr)
      if (pitchCanvasRef.current) applyCanvasSize(pitchCanvasRef.current, w, h, dpr)
      if (playheadCanvasRef.current) applyCanvasSize(playheadCanvasRef.current, w, h, dpr)
      redrawAllRef.current()
    }

    sizeAndDraw()
    const timerId = setTimeout(sizeAndDraw, 50)
    const observer = new ResizeObserver(sizeAndDraw)
    observer.observe(container)
    const offDpr = subscribeDpr(sizeAndDraw)
    return () => { clearTimeout(timerId); observer.disconnect(); offDpr() }
  }, [])

  // drawEnvelope reads colPeaksRef, which drawBackground fills — so the
  // envelope must repaint after it, not merely alongside it, or the first
  // frame after a render arrives would run its headroom check against the
  // PREVIOUS buffer's peaks.
  useEffect(() => { drawBackground(); drawOverlay(); drawEnvelope(); drawPaint(); drawSpcSelect(); drawPitchCurve() },
    [drawBackground, drawOverlay, drawEnvelope, drawPaint, drawSpcSelect, drawPitchCurve])
  useEffect(() => { drawRulerCanvas() }, [drawRulerCanvas])

  // ── Selection drag ───────────────────────────────────────────────────────

  const getLocalX = useCallback((e) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, Math.min(rect.width, e.clientX - rect.left))
  }, [])

  // ── Zero-crossing snap (Phase 3) ────────────────────────────────────────
  //
  // Reuses the sampler's own pure nearestCrossingIndex rather than a second
  // copy of the search — but NOT its snapToZeroCrossing wrapper, which fetches
  // raw samples over the bridge by regionId. A sandbox layer's PCM is already
  // decoded in this process (layer.renderedBuffer.channels), so the snap is a
  // local array scan with no RPC and no await: it can run inside a drag.
  //
  // Suppressed while ALT is held, and skipped entirely when the search window
  // never crosses zero — a snap is a convenience, and must never move an edge
  // somewhere the user did not put it.
  const snapSample = useCallback((sample, w, disabled) => {
    if (disabled) return sample
    const chan = layer?.renderedBuffer?.channels?.[0]
    const n = layer?.renderedBuffer?.numSamples ?? 0
    if (!chan?.length || !n) return sample
    // radiusForView is the sampler's own zoom-proportional rule (~2px worth of
    // samples, clamped) — imported rather than re-derived so a trim point
    // dropped here and one dropped in the sampler snap by the same amount.
    // It shrinks as you zoom in, which is deliberate: at sample-level zoom you
    // are placing the edge exactly, and a snap that could still move it by a
    // visible distance would be fighting you.
    const radius = radiusForView(viewSpan(vw), w)
    const from = Math.max(0, sample - radius)
    const to = Math.min(n, sample + radius)
    if (to - from < 2) return sample
    const idx = nearestCrossingIndex(chan.subarray(from, to), sample - from)
    return idx < 0 ? sample : from + idx
  }, [layer, vw])

  // Which part of an existing selection a press at `x` is grabbing: 'start',
  // 'end', or null for "start a new selection". Only offered when a selection
  // is actually visible — an invisible edge is not a target.
  const hitSelectionEdge = useCallback((x, w) => {
    if (!selection || selection.endSample <= selection.startSample) return null
    const sx = s2x(selection.startSample, w)
    const ex = s2x(selection.endSample, w)
    if (ex - sx < MIN_SELECTION_PX) return null
    if (Math.abs(x - sx) <= EDGE_GRAB_PX) return 'start'
    if (Math.abs(x - ex) <= EDGE_GRAB_PX) return 'end'
    return null
  }, [selection, s2x])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0 || !layer?.renderedBuffer) return
    const w = sizeRef.current.w
    const x = getLocalX(e)

    // Grabbing an edge keeps the OPPOSITE edge anchored, so an adjustment is
    // an adjustment rather than a fresh selection that happens to start where
    // the old one ended.
    const edge = hitSelectionEdge(x, w)
    if (edge === 'start') dragRef.current = { startPx: s2x(selection.endSample, w), endPx: x, adjusting: true }
    else if (edge === 'end') dragRef.current = { startPx: s2x(selection.startSample, w), endPx: x, adjusting: true }
    else dragRef.current = { startPx: x, endPx: x, adjusting: false }
    drawOverlay()

    const onMove = (me) => {
      const rect = overlayCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const nx = Math.max(0, Math.min(rect.width, me.clientX - rect.left))
      if (dragRef.current) {
        dragRef.current.endPx = nx
        drawOverlay()
      }
    }
    const onUp = (ue) => {
      const drag = dragRef.current
      dragRef.current = null
      if (drag && layer?.renderedBuffer) {
        const noSnap = ue?.altKey
        if (!drag.adjusting && Math.abs(drag.endPx - drag.startPx) < MIN_SELECTION_PX) {
          // A plain click is a CURSOR, not "no selection": it is where Play
          // starts from and where Paste lands. Storing it as a zero-width
          // range keeps one representation of "where am I" instead of a
          // second cursor field that could disagree with the selection.
          const at = snapSample(x2s(drag.endPx, w), w, noSnap)
          setSelection({ startSample: at, endSample: at })
        } else {
          const a = snapSample(x2s(Math.min(drag.startPx, drag.endPx), w), w, noSnap)
          const b = snapSample(x2s(Math.max(drag.startPx, drag.endPx), w), w, noSnap)
          setSelection({ startSample: a, endSample: Math.max(a + 1, b) })
        }
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [layer, getLocalX, drawOverlay, setSelection, x2s, s2x, selection, hitSelectionEdge, snapSample])

  // Edge affordance: the cursor becomes a horizontal resize arrow over a
  // grabbable selection edge. Without it the edges are a hidden feature —
  // nothing about a 1px accent line says "you can pull this".
  const handleOverlayHover = useCallback((e) => {
    const canvas = overlayCanvasRef.current
    if (!canvas || dragRef.current) return
    const w = sizeRef.current.w
    canvas.style.cursor = hitSelectionEdge(getLocalX(e), w) ? 'ew-resize' : 'text'
  }, [getLocalX, hitSelectionEdge])

  // ── Envelope editing ─────────────────────────────────────────────────────

  const envLocal = useCallback((e) => {
    const rect = envCanvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
      w: rect.width,
      h: rect.height,
    }
  }, [])

  // Index of the handle under the pointer, or -1.
  const hitHandle = useCallback((points, pos, numSamples) => {
    for (let i = 0; i < points.length; i++) {
      const hx = s2x(points[i].samplePos, pos.w)
      const hy = dbToY(points[i].db, pos.h)
      if (Math.hypot(hx - pos.x, hy - pos.y) <= ENV_HIT_R) return i
    }
    return -1
  }, [])

  const handleEnvDown = useCallback((e) => {
    if (e.button !== 0 || !envelopeEditMode) return
    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    if (!numSamples) return
    const pos = envLocal(e)
    if (!pos) return

    let points = committedPoints.map((p) => ({ ...p }))
    let index = hitHandle(points, pos, numSamples)
    const sample = x2s(pos.x, pos.w)
    const curveDb = 20 * Math.log10(Math.max(1e-9, gainEnvelopeAt(points, sample)))

    // Armed mode captures the pointer, so a press that is NOT on the curve or
    // a handle has to be handed back — otherwise turning the envelope on would
    // silently disable selection, and the user would have to toggle the mode
    // off and on again to trim anything.
    if (index < 0 && Math.abs(dbToY(curveDb, pos.h) - pos.y) > ENV_LINE_HIT_PX) {
      handlePointerDown(e)
      return
    }

    e.preventDefault()
    e.stopPropagation()

    if (index < 0) {
      // On the curve but not on a handle: insert a breakpoint here and start
      // dragging it, so the whole gesture — press, pull down, release — is one
      // motion.
      if (points.length === 0) {
        // First breakpoint on a layer with no envelope yet. Seeded with unity
        // anchors at both ends so the very first drag produces a DIP in a flat
        // line — a lone point would instead be a constant gain over the whole
        // buffer, which is not what dragging a line down looks like.
        points = sortEnvelopePoints([
          { samplePos: 0, db: 0 },
          { samplePos: sample, db: curveDb },
          { samplePos: Math.max(0, numSamples - 1), db: 0 },
        ])
      } else {
        points = sortEnvelopePoints([...points, { samplePos: sample, db: curveDb }])
      }
      index = points.findIndex((p) => p.samplePos === sample)
      if (index < 0) return
    }


    envDragRef.current = { points, index }
    drawEnvelope()

    const onMove = (me) => {
      const state = envDragRef.current
      const p = envLocal(me)
      if (!state || !p) return
      const pts = state.points
      const i = state.index
      // Clamped between its neighbours rather than allowed to cross them: a
      // handle that swapped places mid-drag would change its own index, and
      // the pointer would come away holding a different breakpoint than the
      // one it grabbed.
      const lo = i > 0 ? pts[i - 1].samplePos + 1 : 0
      const hi = i < pts.length - 1 ? pts[i + 1].samplePos - 1 : numSamples - 1
      const wanted = x2s(p.x, p.w)
      pts[i] = {
        samplePos: Math.max(lo, Math.min(Math.max(lo, hi), wanted)),
        db: yToDb(p.y, p.h),
      }
      drawEnvelope()
    }

    const onUp = () => {
      const state = envDragRef.current
      envDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // ONE command, here, on release — never per mousemove. setGainEnvelope
      // no-ops when the curve came back unchanged, so a click that did not
      // move anything costs neither an undo step nor a render.
      if (state) setGainEnvelope(layer.id, state.points)
      drawEnvelope()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [envelopeEditMode, layer, committedPoints, envLocal, hitHandle, drawEnvelope,
      setGainEnvelope, handlePointerDown])

  // Right-click a handle to delete it. Deleting down to one point leaves a
  // constant gain, and deleting the last one leaves an empty curve — which
  // renders as unity, i.e. the op becomes a visible no-op on the stack rather
  // than vanishing behind the user's back.
  const handleEnvContextMenu = useCallback((e) => {
    if (!envelopeEditMode) return
    e.preventDefault()
    e.stopPropagation()
    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    const pos = envLocal(e)
    if (!numSamples || !pos || committedPoints.length === 0) return
    const index = hitHandle(committedPoints, pos, numSamples)
    if (index < 0) return
    setGainEnvelope(layer.id, committedPoints.filter((_, i) => i !== index))
  }, [envelopeEditMode, layer, committedPoints, envLocal, hitHandle, setGainEnvelope])

  // ── Spectral paint editing ───────────────────────────────────────────────
  //
  // Minimum pointer travel between dabs so a slow drag doesn't lay down
  // hundreds of near-identical dabs — each one is a real entry appended to
  // the op's params on commit, not a free-form path the engine resamples.
  const MIN_PAINT_STEP_PX = 4

  const paintLocal = useCallback((e) => {
    const rect = paintCanvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
      w: rect.width,
      h: rect.height,
    }
  }, [])

  const handlePaintDown = useCallback((e) => {
    if (e.button !== 0 || !paintEditMode || viewMode !== 'spc') return
    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    const sampleRate = layer?.renderedBuffer?.sampleRate || 48000
    if (!numSamples) return
    const pos = paintLocal(e)
    if (!pos) return
    e.preventDefault()
    e.stopPropagation()

    const minHz = SPC_FREQ_MIN_HZ
    const maxHz = Math.min(SPC_FREQ_MAX_HZ, sampleRate / 2)

    // One dab per pointer sample, in engine-buffer samples/Hz — the exact
    // shape SpectralPaintDab expects (SandboxOp.h), so commitSpectralPaintDabs
    // hands the store's params straight through with no translation.
    const makeDabAt = (p) => ({
      centerSample: x2s(p.x, p.w),
      halfWidthSamples: Math.max(1, Math.round(paintBrush.halfWidthSec * sampleRate)),
      centerFreqHz: pxToFreq(p.y, p.h, minHz, maxHz),
      halfHeightHz: paintBrush.halfHeightHz,
      amountDb: paintBrush.amountDb,
      featherTimeMs: paintBrush.featherTimeMs,
      featherFreqHz: paintBrush.featherFreqHz,
    })

    paintDragRef.current = [makeDabAt(pos)]
    let lastPos = pos
    drawPaint()

    const onMove = (me) => {
      const p = paintLocal(me)
      if (!p) return
      if (Math.hypot(p.x - lastPos.x, p.y - lastPos.y) < MIN_PAINT_STEP_PX) return
      lastPos = p
      paintDragRef.current = [...(paintDragRef.current || []), makeDabAt(p)]
      drawPaint()
    }
    const onUp = () => {
      const dabs = paintDragRef.current
      paintDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // ONE command for the whole stroke, here, on release — never per
      // mousemove, same "preview locally, commit once" contract the envelope
      // handler above follows.
      if (dabs && dabs.length > 0 && layer) commitSpectralPaintDabs(layer.id, dabs)
      drawPaint()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [paintEditMode, viewMode, layer, paintBrush, paintLocal, drawPaint, commitSpectralPaintDabs])

  // ── AUTOTUNE Manual-mode drawing (P5-5) ──────────────────────────────────
  //
  // Unlike the envelope/paint/SPC-select tools above, this canvas has no
  // store-level "armed" flag — it is dedicated to AUTOTUNE alone (nothing
  // else ever shares it), so being in Manual mode IS the arm condition.
  const MIN_PITCH_STEP_PX = 3
  // Gap used for the "hold-then-jump" pair at a snapped block boundary —
  // small enough to read as instantaneous, large enough that the two points
  // never land at the same timeSec (which would collapse the segment).
  const PITCH_STEP_EPSILON_SEC = 0.002

  const pitchLocal = useCallback((e) => {
    const rect = pitchCanvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
      w: rect.width,
      h: rect.height,
    }
  }, [])

  const handlePitchDown = useCallback((e) => {
    if (e.button !== 0 || !autotuneOp || viewMode !== 'wav') return
    const p = autotuneOp.params || {}
    if (p.mode !== 1) return // Manual only — Scale mode's graph stays read-only
    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    const sampleRate = layer?.renderedBuffer?.sampleRate || 48000
    const durationSec = numSamples > 0 ? numSamples / sampleRate : 0
    if (!(durationSec > 0)) return
    const pos = pitchLocal(e)
    if (!pos) return
    e.preventDefault()
    e.stopPropagation()

    // Frozen for the whole gesture — see pitchDragRef's comment.
    const axis = getPitchAxis()
    const rangeCents = Math.max(1, axis.maxCents - axis.minCents)
    const tFor = (x) => Math.max(0, Math.min(durationSec, (x / pos.w) * durationSec))
    const hzFor = (y) => Math.pow(2, (axis.minCents + ((pos.h - y) / pos.h) * rangeCents) / 1200)

    const notes = p.allowedNotes || []
    const pcs = notes.length > 0 ? notes : allowedPitchClasses(p.key ?? 2, p.scale ?? 2)
    const snapHz = (hz) => quantizeToNearestNote(hz, pcs)

    const committed = p.manualPoints || []
    const previewFor = (strokePts, minT, maxT) => {
      const kept = committed.filter((pt) => pt.t < minT || pt.t > maxT)
      return [...kept, ...strokePts].sort((a, b) => a.t - b.t)
    }

    const startT = tFor(pos.x)
    const startFree = e.altKey
    const startHz = startFree ? hzFor(pos.y) : snapHz(hzFor(pos.y))

    const stroke = [{ t: startT, hz: startHz, tension: 0 }]
    let strokeMinT = startT
    let strokeMaxT = startT
    let lastMode = startFree ? 'free' : 'snap'
    let lastHz = startHz
    let lastPxX = pos.x
    let lastPxY = pos.y

    pitchDragRef.current = { axis, previewPoints: previewFor(stroke, strokeMinT, strokeMaxT) }
    drawPitchCurve()

    const onMove = (me) => {
      const cur = pitchLocal(me)
      if (!cur) return
      if (Math.hypot(cur.x - lastPxX, cur.y - lastPxY) < MIN_PITCH_STEP_PX) return
      lastPxX = cur.x
      lastPxY = cur.y

      const tNow = tFor(cur.x)
      const hzRaw = hzFor(cur.y)

      // Re-checked every event (not just at pointerdown), so holding/
      // releasing ALT mid-stroke switches behaviour live — draw a snapped
      // run, hold ALT partway through for a glide, release it to snap again.
      if (me.altKey) {
        stroke.push({ t: tNow, hz: hzRaw, tension: 0 })
        lastMode = 'free'
        lastHz = hzRaw
      } else {
        const snapped = snapHz(hzRaw)
        if (lastMode === 'free' || snapped !== lastHz) {
          // A hard step: hold the previous value right up to tNow, then jump
          // — this is what makes a snapped run read as classic quantized
          // autotune blocks instead of a ramp between notes. Also the seam
          // when switching from free draw into snap mode mid-stroke, which
          // closes the glide out at its own last value first.
          const holdT = Math.max(stroke[stroke.length - 1].t, tNow - PITCH_STEP_EPSILON_SEC)
          stroke.push({ t: holdT, hz: lastHz, tension: 0 })
          stroke.push({ t: tNow, hz: snapped, tension: 0 })
          lastHz = snapped
        }
        lastMode = 'snap'
      }
      strokeMinT = Math.min(strokeMinT, tNow)
      strokeMaxT = Math.max(strokeMaxT, tNow)
      pitchDragRef.current = { axis, previewPoints: previewFor(stroke, strokeMinT, strokeMaxT) }
      drawPitchCurve()
    }

    const onUp = (ue) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const cur = pitchLocal(ue) || pos
      const tEnd = Math.max(stroke[stroke.length - 1].t, tFor(cur.x))
      // Close the final block/glide explicitly at the release point, rather
      // than relying on evalManualCurve's hold-past-last-key behaviour, so
      // the stroke visually ends exactly where the pointer let go.
      const finalHz = lastMode === 'snap' ? lastHz : hzFor(cur.y)
      if (tEnd !== stroke[stroke.length - 1].t || stroke.length === 1) {
        stroke.push({ t: tEnd, hz: finalHz, tension: 0 })
      }
      pitchDragRef.current = null
      if (stroke.length >= 2 && layer) commitAutotuneManualStroke(layer.id, stroke)
      drawPitchCurve()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [autotuneOp, viewMode, layer, pitchLocal, getPitchAxis, drawPitchCurve, commitAutotuneManualStroke])

  // ── SPC selection editing (rect/freehand t×f selection tool) ─────────────
  const spcSelectLocal = useCallback((e) => {
    const rect = spcSelectCanvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
      w: rect.width,
      h: rect.height,
    }
  }, [])

  // Minimum pointer travel between freehand shapes — same role
  // MIN_PAINT_STEP_PX plays for a paint stroke.
  const MIN_SPC_SELECT_STEP_PX = 4

  const handleSpcSelectDown = useCallback((e) => {
    if (e.button !== 0 || !spcSelectMode || viewMode !== 'spc') return
    const numSamples = layer?.renderedBuffer?.numSamples ?? 0
    const sampleRate = layer?.renderedBuffer?.sampleRate || 48000
    if (!numSamples) return
    const pos = spcSelectLocal(e)
    if (!pos) return
    e.preventDefault()
    e.stopPropagation()

    const minHz = SPC_FREQ_MIN_HZ
    const maxHz = Math.min(SPC_FREQ_MAX_HZ, sampleRate / 2)

    if (spcSelectShape === 'rect') {
      // One drag = one rectangular shape spanning the drag's bounding box —
      // committed on release, same as the plain time-only selection tool's
      // own drag (handlePointerDown above), just with a frequency extent too.
      let start = pos
      spcSelectDragRef.current = null
      drawSpcSelect()

      const onMove = (me) => {
        const p = spcSelectLocal(me)
        if (!p) return
        const x0 = Math.min(start.x, p.x), x1 = Math.max(start.x, p.x)
        const y0 = Math.min(start.y, p.y), y1 = Math.max(start.y, p.y)
        const s0 = x2s(x0, pos.w)
        const s1 = x2s(x1, pos.w)
        const hzTop = pxToFreq(y0, pos.h, minHz, maxHz)
        const hzBot = pxToFreq(y1, pos.h, minHz, maxHz)
        spcSelectDragRef.current = [{
          centerSample: Math.round((s0 + s1) / 2),
          halfWidthSamples: Math.max(1, Math.round((s1 - s0) / 2)),
          centerFreqHz: (hzTop + hzBot) / 2,
          halfHeightHz: Math.max(1, (hzTop - hzBot) / 2),
        }]
        drawSpcSelect()
      }
      const onUp = () => {
        const shapes = spcSelectDragRef.current
        spcSelectDragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setSpcSelection(shapes || [])
        drawSpcSelect()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    } else {
      // Freehand: the drag path is approximated as a series of small
      // overlapping rectangles — the exact technique paintDragRef already
      // uses for a paint stroke (see handlePaintDown above), just committed
      // to the selection instead of straight to an op.
      const makeShapeAt = (p) => ({
        centerSample: x2s(p.x, p.w),
        halfWidthSamples: Math.max(1, Math.round(SPC_SELECT_FREEHAND_DEFAULT.halfWidthSec * sampleRate)),
        centerFreqHz: pxToFreq(p.y, p.h, minHz, maxHz),
        halfHeightHz: SPC_SELECT_FREEHAND_DEFAULT.halfHeightHz,
      })

      spcSelectDragRef.current = [makeShapeAt(pos)]
      let lastPos = pos
      drawSpcSelect()

      const onMove = (me) => {
        const p = spcSelectLocal(me)
        if (!p) return
        if (Math.hypot(p.x - lastPos.x, p.y - lastPos.y) < MIN_SPC_SELECT_STEP_PX) return
        lastPos = p
        spcSelectDragRef.current = [...(spcSelectDragRef.current || []), makeShapeAt(p)]
        drawSpcSelect()
      }
      const onUp = () => {
        const shapes = spcSelectDragRef.current
        spcSelectDragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setSpcSelection(shapes || [])
        drawSpcSelect()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }, [spcSelectMode, spcSelectShape, viewMode, layer, spcSelectLocal, drawSpcSelect, setSpcSelection])

  // Click the ruler to place the cursor — the standard "start playback here"
  // gesture, and the one place it can be done without also risking a stray
  // selection drag over the material itself. Stored as a zero-width selection,
  // the same representation the waveform's own click produces.
  const handleRulerSeek = useCallback((e) => {
    if (e.button !== 0 || !layer?.renderedBuffer) return
    const rect = rulerCanvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const at = x2s(x, rect.width)
    setSelection({ startSample: at, endSample: at })
  }, [layer, x2s, setSelection])

  // ── Right-click menu on the waveform (Phase 5) ──────────────────────────
  // Only on the SELECTION layer: the envelope canvas already spends its right
  // button deleting breakpoints, and the paint/region tools are mid-gesture
  // surfaces. So the menu appears exactly where a plain selection was made,
  // which is the one place it is unambiguous.
  const [contextAt, setContextAt] = useState(null)
  const handleOverlayContextMenu = useCallback((e) => {
    if (!layer?.renderedBuffer) return
    e.preventDefault()
    e.stopPropagation()
    setContextAt({ x: e.clientX, y: e.clientY })
  }, [layer])

  // ── Playhead (Phase 2) ───────────────────────────────────────────────────
  //
  // Its own canvas, and its own rAF loop that reads the position straight from
  // the preview player's AudioContext clock — NOT from the store. A store
  // write per frame would re-render the menu bar, the op rail, the status bar
  // and every layer card sixty times a second to move one line.
  //
  // The composite mix places each layer at its own offsetSamples, so a
  // composite position has to have this layer's offset subtracted before it
  // means anything on this layer's waveform. A layer audition is already in
  // this layer's timeline and needs no correction.
  const playheadOffset = playback.kind === 'composite' ? (layer?.offsetSamples ?? 0) : 0
  const playheadActive = playback.state === 'playing'
    && (playback.kind === 'composite' || playback.layerId === layer?.id)

  useEffect(() => {
    const canvas = playheadCanvasRef.current
    if (!canvas) return undefined
    const clear = () => {
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h)
    }
    if (!playheadActive) { clear(); return undefined }

    let raf = 0
    const accent = tokenValue('--theme-accent') || '#fe589a'
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const w = sizeRef.current.w
      const h = sizeRef.current.h
      ctx.clearRect(0, 0, w, h)
      const pos = getSandboxPreviewPosition()
      if (pos == null) return
      const sample = pos - playheadOffset
      // Keep a zoomed-in view following the playhead, but only when asked —
      // see followPlayhead's comment in the store. scrollViewToInclude leaves
      // the view untouched while the playhead is comfortably on screen, so
      // this is not a store write per frame.
      if (followPlayhead) {
        const cur = useSandboxStore.getState().view
        const next = scrollViewToInclude(cur, numSamplesNow, sample)
        if (next !== cur) useSandboxStore.getState().setView(next)
      }
      const x = Math.round(s2x(sample, w)) + 0.5
      if (x < -1 || x > w + 1) return
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.moveTo(x - 4, 0)
      ctx.lineTo(x + 4, 0)
      ctx.lineTo(x, 6)
      ctx.closePath()
      ctx.fill()
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); clear() }
  }, [playheadActive, playheadOffset, s2x, followPlayhead, numSamplesNow])

  // ── Wheel: Ctrl/Meta = pointer-centred zoom, Shift = pan ─────────────────
  //
  // Same split the timeline uses (see TimelineView's handleWheel), and
  // for the same reason: a PLAIN wheel must keep reaching the layer
  // workspace's vertical scroller, or the panel becomes a place where the
  // mouse wheel silently stops working as soon as the pointer crosses a
  // waveform. Registered natively rather than through React's onWheel because
  // it has to preventDefault, which a passive listener cannot.
  useEffect(() => {
    const el = stackRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      const w = sizeRef.current.w
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        zoomByWheel(e.deltaY, Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, w))))
      } else if (e.shiftKey || e.deltaX !== 0) {
        e.preventDefault()
        const delta = e.shiftKey ? e.deltaY : e.deltaX
        panByFraction((delta / Math.max(1, w)) * 0.9)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomByWheel, panByFraction])

  // ── SPC hover readout (time × Hz, for the status bar) ─────────────────────
  // Attached to the whole canvas STACK, not any one layer: canvases stacked
  // above the pointer's actual target have pointer-events:none while inert
  // (see sandbox.css), so the mouse event bubbles from whichever one is
  // actually armed (or the stack itself, none armed) up to this handler
  // either way — one listener covers every tool/mode combination.
  const handleStackHover = useCallback((e) => {
    if (viewMode !== 'spc' || !layer?.renderedBuffer) return
    const rect = stackRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    const numSamples = layer.renderedBuffer.numSamples
    const sampleRate = layer.renderedBuffer.sampleRate || 48000
    const minHz = SPC_FREQ_MIN_HZ
    const maxHz = Math.min(SPC_FREQ_MAX_HZ, sampleRate / 2)
    const sample = x2s(x, rect.width)
    setSpcHoverReadout({ sec: sample / sampleRate, hz: pxToFreq(y, rect.height, minHz, maxHz) })
  }, [viewMode, layer, setSpcHoverReadout])

  const handleStackLeave = useCallback(() => setSpcHoverReadout(null), [setSpcHoverReadout])

  // Reading order is overview → ruler → waveform. The ruler used to sit BELOW
  // the waveform, which put the time axis furthest from the overview strip
  // that indexes into it and left the two describing the same axis from
  // opposite ends of the panel.
  return (
    <div className={styles.area} ref={containerRef}>
      <SandboxOverviewStrip />
      <canvas ref={rulerCanvasRef} className={styles.ruler} onMouseDown={handleRulerSeek} />
      <div
        className={styles.stack}
        ref={stackRef}
        onMouseMove={handleStackHover}
        onMouseLeave={handleStackLeave}
      >
        <canvas ref={bgCanvasRef} className={styles.layer} />
        <canvas
          ref={overlayCanvasRef}
          className={`${styles.layer} ${styles.overlay}`}
          onMouseDown={handlePointerDown}
          onMouseMove={handleOverlayHover}
          onContextMenu={handleOverlayContextMenu}
        />
        <canvas
          ref={envCanvasRef}
          className={`${styles.layer} ${styles.inert}`} data-editing={envelopeEditMode || undefined}
          onMouseDown={handleEnvDown}
          onContextMenu={handleEnvContextMenu}
        />
        <canvas
          ref={paintCanvasRef}
          className={`${styles.layer} ${styles.inert}`} data-editing={paintEditMode || undefined}
          onMouseDown={handlePaintDown}
        />
        <canvas
          ref={spcSelectCanvasRef}
          className={`${styles.layer} ${styles.inert}`} data-editing={spcSelectMode || undefined}
          onMouseDown={handleSpcSelectDown}
        />
        <canvas
          ref={pitchCanvasRef}
          className={`${styles.layer} ${styles.inert}`} data-editing={autotuneOp?.params?.mode === 1 || undefined}
          onMouseDown={handlePitchDown}
        />
        <canvas ref={playheadCanvasRef} className={`${styles.layer} ${styles.playhead}`} />
      </div>
      {contextAt && (
        <SandboxSelectionContextMenu at={contextAt} onClose={() => setContextAt(null)} />
      )}
    </div>
  )
}

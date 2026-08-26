import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { drawRuler, resolveTimelinePalette } from '../timeline/timelineDrawing.js'
import { RULER_HEIGHT } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { uiCanvasFont } from '../../styles/typography.js'
import { getTransportState, subscribe as subscribeTransport } from '../../transportStore.js'
import useSandboxStore, {
  gainEnvelopeAt, gainEnvelopeDbAt, sortEnvelopePoints, findEnvelopeOp,
  clampGainEnvelopeFollower, GAIN_ENVELOPE_MODE, GAIN_ENVELOPE_DB_MIN,
} from '../../stores/sandboxStore.js'

// Fallback used only before the first layout measurement, and as a floor so
// a squeezed panel never hands the canvas a degenerate (near-zero) height.
const MIN_WAVE_HEIGHT = 160
const MIN_SELECTION_PX = 3 // drags shorter than this collapse to "no selection", same gesture as a plain click

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
function approxNaturalDbPerColumn(absPeaks, committedPoints, cols, numSamples) {
  const out = new Float32Array(cols)
  for (let x = 0; x < cols; x++) {
    // Same px→sample mapping the main curve loop uses, so column x here means
    // the same sample position it means everywhere else in this file.
    const sample = Math.min(Math.max(0, numSamples - 1), Math.round((x / cols) * numSamples))
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
function computeColumnPeaks(channelData, numCols) {
  const n = channelData.length
  const out = { min: new Float32Array(numCols), max: new Float32Array(numCols) }
  if (n === 0 || numCols <= 0) return out
  for (let col = 0; col < numCols; col++) {
    const s0 = Math.floor((col * n) / numCols)
    const s1 = Math.max(s0 + 1, Math.floor(((col + 1) * n) / numCols))
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
const SPC_GRID_HZ = [100, 1000, 10000] // labeled gridlines: "100", "1k", "10k"

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

function pxToSample(px, w, numSamples) {
  return Math.max(0, Math.min(numSamples, Math.round((px / Math.max(1, w)) * numSamples)))
}

function sampleToPx(sample, w, numSamples) {
  if (!numSamples) return 0
  return (sample / numSamples) * w
}

export default function SandboxWaveformCanvas() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const setSelection = useSandboxStore((s) => s.setSelection)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const setGainEnvelope = useSandboxStore((s) => s.setGainEnvelope)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  const containerRef = useRef(null)
  const stackRef = useRef(null)
  const rulerCanvasRef = useRef(null)
  const bgCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const envCanvasRef = useRef(null)
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

  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 120)
  useEffect(() => subscribeTransport((s) => { if (s?.bpm) setBpm(s.bpm) }), [])

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
      lanes: buf.channels.map((chan) => computeColumnPeaks(chan, Math.max(1, Math.round(w)))),
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
        ctx.drawImage(cache.canvas, 0, 0, cache.canvas.width, cache.canvas.height, 0, 0, w, h)

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
  }, [layer, viewMode])

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
      startPx = sampleToPx(selection.startSample, w, numSamples)
      endPx = sampleToPx(selection.endSample, w, numSamples)
    }
    if (startPx == null || endPx - startPx < 1) return

    const palette = resolveTimelinePalette()
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
  }, [layer, selection])

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
      const rawDb = approxNaturalDbPerColumn(absPeaks, committedPoints, cols, numSamples)
      const samplesPerCol = numSamples / cols
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
      // Same px→sample mapping pxToSample uses, so a handle drawn at
      // sampleToPx(p) lands on the column that evaluates to p's own dB.
      const sample = Math.min(numSamples - 1, Math.round((x / cols) * numSamples))
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
        const x = sampleToPx(pt.samplePos, w, numSamples)
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
  }, [layer, committedPoints, envelopeEditMode, envBypassed, envIsRelative, envFollower])

  const drawRulerCanvas = useCallback(() => {
    const canvas = rulerCanvasRef.current
    const w = sizeRef.current.w
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    const palette = resolveTimelinePalette()
    const numSamples = layer?.renderedBuffer?.numSamples
    const sampleRate = layer?.renderedBuffer?.sampleRate
    const durationSec = numSamples && sampleRate ? numSamples / sampleRate : 4 * (60 / bpm)
    const totalBeats = Math.max(0.25, durationSec * (bpm / 60))
    const ppb = w / totalBeats
    drawRuler(ctx, w, RULER_HEIGHT, 0, ppb, palette)
  }, [layer, bpm])

  const redrawAll = useCallback(() => {
    drawBackground()
    drawOverlay()
    drawEnvelope()
    drawRulerCanvas()
  }, [drawBackground, drawOverlay, drawEnvelope, drawRulerCanvas])

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
      if (w === 0 || (w === sizeRef.current.w && h === sizeRef.current.h)) return
      sizeRef.current = { w, h }
      const dpr = window.devicePixelRatio || 1
      if (rulerCanvasRef.current) applyCanvasSize(rulerCanvasRef.current, w, RULER_HEIGHT, dpr)
      if (bgCanvasRef.current) applyCanvasSize(bgCanvasRef.current, w, h, dpr)
      if (overlayCanvasRef.current) applyCanvasSize(overlayCanvasRef.current, w, h, dpr)
      if (envCanvasRef.current) applyCanvasSize(envCanvasRef.current, w, h, dpr)
      redrawAllRef.current()
    }

    sizeAndDraw()
    const timerId = setTimeout(sizeAndDraw, 50)
    const observer = new ResizeObserver(sizeAndDraw)
    observer.observe(container)
    return () => { clearTimeout(timerId); observer.disconnect() }
  }, [])

  // drawEnvelope reads colPeaksRef, which drawBackground fills — so the
  // envelope must repaint after it, not merely alongside it, or the first
  // frame after a render arrives would run its headroom check against the
  // PREVIOUS buffer's peaks.
  useEffect(() => { drawBackground(); drawOverlay(); drawEnvelope() },
    [drawBackground, drawOverlay, drawEnvelope])
  useEffect(() => { drawRulerCanvas() }, [drawRulerCanvas])

  // ── Selection drag ───────────────────────────────────────────────────────

  const getLocalX = useCallback((e) => {
    const rect = overlayCanvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, Math.min(rect.width, e.clientX - rect.left))
  }, [])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0 || !layer?.renderedBuffer) return
    const x = getLocalX(e)
    dragRef.current = { startPx: x, endPx: x }
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
    const onUp = () => {
      const drag = dragRef.current
      dragRef.current = null
      if (drag && layer?.renderedBuffer) {
        const w = sizeRef.current.w
        const numSamples = layer.renderedBuffer.numSamples
        if (Math.abs(drag.endPx - drag.startPx) < MIN_SELECTION_PX) {
          setSelection(null)
        } else {
          const a = pxToSample(Math.min(drag.startPx, drag.endPx), w, numSamples)
          const b = pxToSample(Math.max(drag.startPx, drag.endPx), w, numSamples)
          setSelection({ startSample: a, endSample: b })
        }
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [layer, getLocalX, drawOverlay, setSelection])

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
      const hx = sampleToPx(points[i].samplePos, pos.w, numSamples)
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
    const sample = pxToSample(pos.x, pos.w, numSamples)
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
      const wanted = pxToSample(p.x, p.w, numSamples)
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

  return (
    <div className="sandbox-waveform-area" ref={containerRef}>
      <div className="sandbox-waveform-stack" ref={stackRef}>
        <canvas ref={bgCanvasRef} className="sandbox-waveform-bg" />
        <canvas
          ref={overlayCanvasRef}
          className="sandbox-waveform-overlay"
          onMouseDown={handlePointerDown}
        />
        <canvas
          ref={envCanvasRef}
          className={`sandbox-waveform-env${envelopeEditMode ? ' editing' : ''}`}
          onMouseDown={handleEnvDown}
          onContextMenu={handleEnvContextMenu}
        />
      </div>
      <canvas ref={rulerCanvasRef} className="sandbox-ruler-canvas" />
    </div>
  )
}

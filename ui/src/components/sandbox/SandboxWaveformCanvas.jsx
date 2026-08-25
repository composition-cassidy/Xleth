import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { drawRuler, resolveTimelinePalette } from '../timeline/timelineDrawing.js'
import { RULER_HEIGHT } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { uiCanvasFont } from '../../styles/typography.js'
import { getTransportState, subscribe as subscribeTransport } from '../../transportStore.js'
import useSandboxStore, {
  gainEnvelopeAt, sortEnvelopePoints, findEnvelopeOp,
} from '../../stores/sandboxStore.js'

const WAVE_HEIGHT = 240
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
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  const containerRef = useRef(null)
  const rulerCanvasRef = useRef(null)
  const bgCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const envCanvasRef = useRef(null)
  const sizeRef = useRef({ w: 0 })
  const colPeaksRef = useRef(null) // { numChannels, cols: [{min,max}, ...] }
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
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    const palette = resolveTimelinePalette()

    ctx.fillStyle = tokenValue('--theme-bg-primary') || '#101010'
    ctx.fillRect(0, 0, w, WAVE_HEIGHT)

    if (!layer) {
      ctx.fillStyle = palette.rulerText
      ctx.font = uiCanvasFont('11px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Drag a sample into Sources & Layers to begin', w / 2, WAVE_HEIGHT / 2)
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
      ctx.fillText(msg, w / 2, WAVE_HEIGHT / 2)
      ctx.textAlign = 'left'
      return
    }

    const numChannels = buf.numChannels || 1
    const laneH = WAVE_HEIGHT / numChannels
    colPeaksRef.current = {
      numSamples: buf.numSamples,
      lanes: buf.channels.map((chan) => computeColumnPeaks(chan, Math.max(1, Math.round(w)))),
    }

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
  }, [layer])

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current
    const w = sizeRef.current.w
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, WAVE_HEIGHT)

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
    ctx.fillRect(startPx, 0, endPx - startPx, WAVE_HEIGHT)
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(startPx + 0.5, 0)
    ctx.lineTo(startPx + 0.5, WAVE_HEIGHT)
    ctx.moveTo(endPx - 0.5, 0)
    ctx.lineTo(endPx - 0.5, WAVE_HEIGHT)
    ctx.stroke()
  }, [layer, selection])

  // ── Envelope draw ────────────────────────────────────────────────────────
  //
  // The headroom warning is EXACT rather than a guess, because both halves of
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
  const drawEnvelope = useCallback(() => {
    const canvas = envCanvasRef.current
    const w = sizeRef.current.w
    if (!canvas || w === 0) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, WAVE_HEIGHT)

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
      const y = Math.round(dbToY(db, WAVE_HEIGHT)) + 0.5
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
    const ys = new Float32Array(cols)
    const over = new Uint8Array(cols)
    for (let x = 0; x < cols; x++) {
      // Same px→sample mapping pxToSample uses, so a handle drawn at
      // sampleToPx(p) lands on the column that evaluates to p's own dB.
      const sample = Math.min(numSamples - 1, Math.round((x / cols) * numSamples))
      const displayGain = gainEnvelopeAt(display, sample)
      // An empty curve evaluates to 1.0, i.e. 0 dB — no special case needed.
      ys[x] = dbToY(20 * Math.log10(Math.max(1e-9, displayGain)), WAVE_HEIGHT)

      if (envBypassed) continue
      const committedGain = gainEnvelopeAt(committedPoints, sample)
      // A column the committed curve has already muted carries no recoverable
      // information about its own peak — 0 / 0. Say nothing rather than guess.
      if (committedGain <= 1e-6) continue
      const basePeak = absPeaks[x] / committedGain
      if (basePeak * displayGain > 1.0) over[x] = 1
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
        const y = dbToY(pt.db, WAVE_HEIGHT)
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
  }, [layer, committedPoints, envelopeEditMode, envBypassed])

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
      if (w === 0 || w === sizeRef.current.w) return
      sizeRef.current = { w }
      const dpr = window.devicePixelRatio || 1
      if (rulerCanvasRef.current) applyCanvasSize(rulerCanvasRef.current, w, RULER_HEIGHT, dpr)
      if (bgCanvasRef.current) applyCanvasSize(bgCanvasRef.current, w, WAVE_HEIGHT, dpr)
      if (overlayCanvasRef.current) applyCanvasSize(overlayCanvasRef.current, w, WAVE_HEIGHT, dpr)
      if (envCanvasRef.current) applyCanvasSize(envCanvasRef.current, w, WAVE_HEIGHT, dpr)
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
      <canvas ref={rulerCanvasRef} className="sandbox-ruler-canvas" />
      <div className="sandbox-waveform-stack" style={{ height: WAVE_HEIGHT }}>
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
    </div>
  )
}

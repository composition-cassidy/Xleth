import { useEffect, useRef, useState, useCallback } from 'react'
import { drawRuler, resolveTimelinePalette } from '../timeline/timelineDrawing.js'
import { RULER_HEIGHT } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { uiCanvasFont } from '../../styles/typography.js'
import { getTransportState, subscribe as subscribeTransport } from '../../transportStore.js'
import useSandboxStore from '../../stores/sandboxStore.js'

const WAVE_HEIGHT = 240
const MIN_SELECTION_PX = 3 // drags shorter than this collapse to "no selection", same gesture as a plain click

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
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  const containerRef = useRef(null)
  const rulerCanvasRef = useRef(null)
  const bgCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const sizeRef = useRef({ w: 0 })
  const colPeaksRef = useRef(null) // { numChannels, cols: [{min,max}, ...] }
  const dragRef = useRef(null) // { startPx, endPx } while dragging

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
    drawRulerCanvas()
  }, [drawBackground, drawOverlay, drawRulerCanvas])

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
      redrawAll()
    }

    sizeAndDraw()
    const timerId = setTimeout(sizeAndDraw, 50)
    const observer = new ResizeObserver(sizeAndDraw)
    observer.observe(container)
    return () => { clearTimeout(timerId); observer.disconnect() }
  }, [])

  useEffect(() => { drawBackground(); drawOverlay() }, [drawBackground, drawOverlay])
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
      </div>
    </div>
  )
}

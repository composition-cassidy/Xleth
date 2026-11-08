import { useCallback, useEffect, useRef } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import { resolveView, viewSpan, isFitted } from './sandboxView.js'
import { tokenValue } from '../../theming/tokenValue.ts'

import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import styles from './SandboxCanvas.module.css'
// ── Overview strip ──────────────────────────────────────────────────────────
//
// The whole buffer at a glance, with the visible window drawn over it. Once
// the main canvas can zoom, this is not decoration: a zoomed-in view has no
// way of saying where in the sample it is, and scrolling by wheel through a
// 30-second layer at sample zoom is a way to get lost, not a way to navigate.
//
// Three gestures, all on the same surface: click to centre the window there,
// drag the window to scroll, drag its edges to resize (which IS zooming).
// Hidden entirely while the view is fitted — with nothing to navigate, a
// full-width bracket around the full-width waveform is noise.
const STRIP_H = 30
const EDGE_PX = 5

// Peaks for the strip are computed once per buffer and cached on the buffer's
// own identity — the store replaces the object wholesale on every render, so
// identity is exactly "has the audio changed".
const peakCache = { buffer: null, cols: 0, min: null, max: null }

function overviewPeaks(buf, cols) {
  if (peakCache.buffer === buf && peakCache.cols === cols) return peakCache
  const min = new Float32Array(cols)
  const max = new Float32Array(cols)
  const n = buf.numSamples
  for (const chan of buf.channels) {
    for (let c = 0; c < cols; c++) {
      const s0 = Math.floor((c * n) / cols)
      const s1 = Math.max(s0 + 1, Math.floor(((c + 1) * n) / cols))
      let mn = 0, mx = 0
      for (let i = s0; i < s1 && i < chan.length; i++) {
        const v = chan[i]
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (mn < min[c]) min[c] = mn
      if (mx > max[c]) max[c] = mx
    }
  }
  peakCache.buffer = buf
  peakCache.cols = cols
  peakCache.min = min
  peakCache.max = max
  return peakCache
}

export default function SandboxOverviewStrip() {
  const dprEpoch = useThemeEpoch() // Phase 7: re-size and redraw at the new devicePixelRatio when the UI scale changes
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const view = useSandboxStore((s) => s.view)
  const setView = useSandboxStore((s) => s.setView)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const buf = layer?.renderedBuffer ?? null
  const numSamples = buf?.numSamples ?? 0
  const hidden = !buf || isFitted(view, numSamples)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !buf) return
    const w = Math.floor(canvas.clientWidth)
    if (w <= 0) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(STRIP_H * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, STRIP_H)

    const peaks = overviewPeaks(buf, w)
    const mid = STRIP_H / 2
    const amp = STRIP_H * 0.45
    ctx.fillStyle = tokenValue('--theme-text-placeholder') || '#666'
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    for (let x = 0; x < w; x++) ctx.lineTo(x, mid - peaks.max[x] * amp)
    for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, mid - peaks.min[x] * amp)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1

    // The visible window. Everything OUTSIDE it is dimmed rather than the
    // window being highlighted — the shape being navigated is the whole
    // buffer, and a bright rectangle over a dim one reads as a selection.
    const v = resolveView(view, numSamples)
    const x0 = (v.startSample / numSamples) * w
    const x1 = (v.endSample / numSamples) * w
    ctx.fillStyle = tokenValue('--theme-bg-primary') || '#101010'
    ctx.globalAlpha = 0.62
    ctx.fillRect(0, 0, x0, STRIP_H)
    ctx.fillRect(x1, 0, w - x1, STRIP_H)
    ctx.globalAlpha = 1
    ctx.strokeStyle = tokenValue('--theme-accent') || '#fe589a'
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(1, x1 - x0), STRIP_H - 1)
  }, [buf, view, numSamples, dprEpoch])

  useEffect(() => {
    draw()
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [draw])

  const localX = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, w: 1 }
    return { x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)), w: rect.width }
  }

  const handleDown = useCallback((e) => {
    if (e.button !== 0 || !numSamples) return
    const { x, w } = localX(e)
    const v = resolveView(view, numSamples)
    const span = viewSpan(v)
    const x0 = (v.startSample / numSamples) * w
    const x1 = (v.endSample / numSamples) * w

    let mode
    if (Math.abs(x - x0) <= EDGE_PX) mode = 'start'
    else if (Math.abs(x - x1) <= EDGE_PX) mode = 'end'
    else if (x > x0 && x < x1) mode = 'move'
    else {
      // Outside the window: jump there, centred, keeping the zoom level — the
      // "I know roughly where in the file I want to be" gesture.
      const centre = (x / w) * numSamples
      const start = Math.max(0, Math.min(numSamples - span, Math.round(centre - span / 2)))
      setView({ startSample: start, endSample: start + span })
      mode = 'move'
    }

    const v0 = resolveView(useSandboxStore.getState().view, numSamples)
    dragRef.current = { mode, grabX: x, startAtDown: v0.startSample, endAtDown: v0.endSample }

    const onMove = (me) => {
      const state = dragRef.current
      if (!state) return
      const { x: mx, w: mw } = localX(me)
      const deltaSamples = ((mx - state.grabX) / mw) * numSamples
      if (state.mode === 'move') {
        const width = state.endAtDown - state.startAtDown
        const start = Math.max(0, Math.min(numSamples - width, Math.round(state.startAtDown + deltaSamples)))
        setView({ startSample: start, endSample: start + width })
      } else if (state.mode === 'start') {
        setView(resolveView({
          startSample: Math.round(state.startAtDown + deltaSamples), endSample: state.endAtDown,
        }, numSamples))
      } else {
        setView(resolveView({
          startSample: state.startAtDown, endSample: Math.round(state.endAtDown + deltaSamples),
        }, numSamples))
      }
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [view, numSamples, setView])

  const handleHover = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas || !numSamples || dragRef.current) return
    const { x, w } = localX(e)
    const v = resolveView(view, numSamples)
    const x0 = (v.startSample / numSamples) * w
    const x1 = (v.endSample / numSamples) * w
    canvas.style.cursor = (Math.abs(x - x0) <= EDGE_PX || Math.abs(x - x1) <= EDGE_PX)
      ? 'ew-resize'
      : (x > x0 && x < x1) ? 'grab' : 'pointer'
  }, [view, numSamples])

  if (hidden) return null
  return (
    <canvas
      ref={canvasRef}
      className={styles.overview}
      style={{ height: STRIP_H }}
      onMouseDown={handleDown}
      onMouseMove={handleHover}
      title="Overview — drag to scroll, drag an edge to zoom, click to jump"
    />
  )
}

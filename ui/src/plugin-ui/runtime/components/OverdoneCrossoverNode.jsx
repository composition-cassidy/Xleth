import { useEffect, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { styleToCSS } from '../styleToCSS.js'
import { readDynamicsTheme } from '../visualizers/theme.js'
import { MULTIBAND_DISPLAY } from '../visualizers/multibandPainter.js'
import { uiCanvasFont } from '../../../styles/typography.js'

// Overdone bottom section: frequency display with the three crossover filter
// curves (low-pass in the Low band color, band-pass in Mid, high-pass in
// High) over a log-frequency grid. The Lo/Hi crossovers are adjusted by
// dragging horizontally on the regions where the curves intersect — no
// separate sliders. Hit regions are generous and show an ew-resize cursor.
//
// The curves are 4th-order Linkwitz-Riley magnitude responses computed
// client-side from the xover params — the same filters the engine runs, so
// the display matches the DSP without any new telemetry.
//
// Layout props:
//   heightPx            — canvas height (width is fluid)
//   lowParam/highParam  — optional param bindings (default xover_low/xover_high)

const FREQ_MIN = 20
const FREQ_MAX = 20000
const LOG_RANGE = Math.log(FREQ_MAX / FREQ_MIN)

const DB_TOP = 6
const DB_BOTTOM = -36

// Minimum musical gap between the two crossovers: one octave.
const MIN_GAP_RATIO = 2

// Generous horizontal hit region around each crossover line (px, each side).
const HIT_PX = 18

const GRID_FREQS = Object.freeze([50, 100, 200, 500, 1000, 2000, 5000, 10000])
const LABEL_FREQS = Object.freeze([100, 1000, 10000])
const GRID_DB = Object.freeze([0, -12, -24])

const BAND_COLORS = MULTIBAND_DISPLAY.bandColors

function freqToX(freq, w) {
  const t = Math.log(Math.max(FREQ_MIN, freq) / FREQ_MIN) / LOG_RANGE
  return t * w
}

function xToFreq(x, w) {
  const t = Math.min(1, Math.max(0, x / Math.max(1, w)))
  return FREQ_MIN * Math.exp(t * LOG_RANGE)
}

function dbToY(db, h) {
  const t = (DB_TOP - db) / (DB_TOP - DB_BOTTOM)
  return t * h
}

// 4th-order Linkwitz-Riley magnitude responses (squared 2nd-order Butterworth).
function lpMag(f, fc) {
  const x = (f / fc) ** 4
  return 1 / (1 + x)
}
function hpMag(f, fc) {
  const x = (f / fc) ** 4
  return x / (1 + x)
}

function magToY(mag, h) {
  const db = 20 * Math.log10(Math.max(mag, 1e-4))
  return dbToY(Math.max(DB_BOTTOM, Math.min(DB_TOP, db)), h)
}

function formatHz(hz) {
  if (!Number.isFinite(hz)) return ''
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)} kHz`
  return `${hz.toFixed(0)} Hz`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export default function OverdoneCrossoverNode({ node }) {
  const { props = {}, style = {} } = node
  const ctx = usePluginUI()

  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const dragRef = useRef(null)   // 'low' | 'high' | null
  const hoverRef = useRef(null)  // 'low' | 'high' | null
  const paramsRef = useRef({})

  const heightPx = Number.isFinite(props.heightPx) ? props.heightPx : 132
  const inlineStyle = styleToCSS(style)

  const lowParam = props.lowParam || 'xover_low'
  const highParam = props.highParam || 'xover_high'
  const lowMeta = ctx?.manifest?.params?.[lowParam]
  const highMeta = ctx?.manifest?.params?.[highParam]

  const params = ctx?.params || {}
  const setParam = ctx?.setParam
  const loHz = Number.isFinite(params[lowParam]) ? params[lowParam] : (lowMeta?.defaultValue ?? 88)
  const hiHz = Number.isFinite(params[highParam]) ? params[highParam] : (highMeta?.defaultValue ?? 2500)

  // Keep per-frame values in refs so the rAF loop never restarts.
  paramsRef.current = { loHz, hiHz, lowMeta, highMeta }

  // ── Painting ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false

    const draw = () => {
      if (cancelled) return

      const cssW = canvas.clientWidth || 0
      const cssH = canvas.clientHeight || heightPx
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const targetW = Math.round(cssW * dpr)
      const targetH = Math.round(cssH * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      const g = canvas.getContext('2d', { alpha: false })
      if (!g || cssW < 8 || cssH < 8) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)

      const theme = readDynamicsTheme(canvas)
      const { loHz: lo, hiHz: hi } = paramsRef.current
      const active = dragRef.current || hoverRef.current

      // Background
      g.fillStyle = theme.bgInset || theme.bg
      g.fillRect(0, 0, cssW, cssH)

      // Grid — vertical (log frequency) + horizontal (dB)
      g.strokeStyle = theme.grid
      g.lineWidth = 1
      g.globalAlpha = 0.22
      g.beginPath()
      for (const f of GRID_FREQS) {
        const x = Math.round(freqToX(f, cssW)) + 0.5
        g.moveTo(x, 0)
        g.lineTo(x, cssH)
      }
      for (const db of GRID_DB) {
        const y = Math.round(dbToY(db, cssH)) + 0.5
        g.moveTo(0, y)
        g.lineTo(cssW, y)
      }
      g.stroke()
      g.globalAlpha = 1

      // Frequency labels along the bottom
      g.font = uiCanvasFont('9px')
      g.textBaseline = 'bottom'
      g.textAlign = 'center'
      g.fillStyle = theme.textMuted
      g.globalAlpha = 0.8
      for (const f of LABEL_FREQS) {
        g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, freqToX(f, cssW), cssH - 3)
      }
      g.globalAlpha = 1

      // Filter curves — sampled on the same log scale as the axis.
      const curves = [
        { key: 'low',  color: BAND_COLORS.low,  mag: (f) => lpMag(f, lo) },
        { key: 'mid',  color: BAND_COLORS.mid,  mag: (f) => hpMag(f, lo) * lpMag(f, hi) },
        { key: 'high', color: BAND_COLORS.high, mag: (f) => hpMag(f, hi) },
      ]
      const steps = Math.max(64, Math.floor(cssW / 2))
      for (const curve of curves) {
        g.beginPath()
        for (let i = 0; i <= steps; i++) {
          const f = FREQ_MIN * Math.exp((i / steps) * LOG_RANGE)
          const x = freqToX(f, cssW)
          const y = magToY(curve.mag(f), cssH)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        // Translucent fill under the curve, then the stroke on top.
        g.save()
        g.lineTo(cssW, cssH)
        g.lineTo(0, cssH)
        g.closePath()
        g.fillStyle = curve.color
        g.globalAlpha = 0.08
        g.fill()
        g.restore()
        g.strokeStyle = curve.color
        g.lineWidth = 1.8
        g.globalAlpha = 0.95
        g.stroke()
        g.globalAlpha = 1
      }

      // Crossover drag lines + readouts
      const handles = [
        { key: 'low',  hz: lo, color: BAND_COLORS.low },
        { key: 'high', hz: hi, color: BAND_COLORS.high },
      ]
      for (const handle of handles) {
        const x = Math.round(freqToX(handle.hz, cssW)) + 0.5
        const isActive = active === handle.key
        g.strokeStyle = handle.color
        g.lineWidth = isActive ? 2 : 1
        g.globalAlpha = isActive ? 0.95 : 0.45
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, cssH)
        g.stroke()

        g.font = uiCanvasFont('9px')
        g.textBaseline = 'top'
        g.fillStyle = handle.color
        g.globalAlpha = isActive ? 1 : 0.75
        const label = formatHz(handle.hz)
        const anchorLeft = x < cssW / 2
        g.textAlign = anchorLeft ? 'left' : 'right'
        g.fillText(label, anchorLeft ? x + 4 : x - 4, 3)
        g.globalAlpha = 1
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [heightPx])

  // ── Crossover dragging ──────────────────────────────────────────────────

  const hitTest = (x, w) => {
    const { loHz: lo, hiHz: hi } = paramsRef.current
    const dLo = Math.abs(x - freqToX(lo, w))
    const dHi = Math.abs(x - freqToX(hi, w))
    if (dLo <= HIT_PX && dLo <= dHi) return 'low'
    if (dHi <= HIT_PX) return 'high'
    return null
  }

  const applyDrag = (x, w) => {
    const band = dragRef.current
    if (!band || typeof setParam !== 'function') return
    const { loHz: lo, hiHz: hi, lowMeta: loMeta, highMeta: hiMeta } = paramsRef.current
    const freq = xToFreq(x, w)
    if (band === 'low') {
      const min = loMeta?.min ?? 40
      const max = Math.min(loMeta?.max ?? 400, hi / MIN_GAP_RATIO)
      setParam(lowParam, clamp(freq, min, max))
    } else {
      const min = Math.max(hiMeta?.min ?? 1000, lo * MIN_GAP_RATIO)
      const max = hiMeta?.max ?? 8000
      setParam(highParam, clamp(freq, min, max))
    }
  }

  const handlePointerDown = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const hit = hitTest(event.clientX - rect.left, rect.width)
    if (!hit) return
    dragRef.current = hit
    hoverRef.current = hit
    canvas.setPointerCapture(event.pointerId)
    canvas.style.cursor = 'ew-resize'
    event.preventDefault()
  }

  const handlePointerMove = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (dragRef.current) {
      applyDrag(x, rect.width)
      return
    }
    const hit = hitTest(x, rect.width)
    hoverRef.current = hit
    canvas.style.cursor = hit ? 'ew-resize' : 'default'
  }

  const endDrag = (event) => {
    const canvas = canvasRef.current
    dragRef.current = null
    if (canvas && event?.pointerId != null && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    if (canvas) {
      const rect = canvas.getBoundingClientRect()
      const hit = event ? hitTest(event.clientX - rect.left, rect.width) : null
      hoverRef.current = hit
      canvas.style.cursor = hit ? 'ew-resize' : 'default'
    }
  }

  return (
    <div className="pluginui-overdone-xover" style={inlineStyle} data-pluginui-id={node.id}>
      <canvas
        ref={canvasRef}
        className="pluginui-overdone-xover-canvas"
        style={{ height: `${heightPx}px` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}

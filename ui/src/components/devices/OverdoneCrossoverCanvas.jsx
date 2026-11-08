import React, { useEffect, useRef } from 'react'
import { useDynamicsVizSubscription } from '../../plugin-ui/runtime/useDynamicsVizSubscription.js'
import { VIZ_TYPE } from '../../constants/dynamicsViz.js'
import { uiCanvasFont } from '../../styles/typography.js'
import { formatValue } from '../../ui-kit'
import { readBandColor } from './bandPalette.js'

// Overdone's hero: the three crossover filter curves (low-pass Low, band-pass
// Mid, high-pass High; 4th-order Linkwitz-Riley magnitudes computed from the
// crossover params, the same filters the engine runs) over a log-frequency
// grid, with each band's live upward and downward gain drawn in its region.
//
// Moved from plugin-ui's OverdoneCrossoverNode: same curves, same grid, same
// drag-the-crossover-line interaction (one octave minimum gap). The device
// passes values and writes as props, and a drag now previews (one engine write
// per frame through the device's params hook) and commits once on release.
//
// Up / down: the engine publishes, per band and per ~33 Hz MultibandBucket, the
// band's input peak (post-crossover, pre-gain), output peak (post-gain) and
// downward gain reduction. Downward = that reduction. Upward is not published,
// so it is read off the same bucket: up = out - in - band gain + down, floored
// at 0. Both ride peak ballistics (instant rise, smooth fall) and fade out when
// the stream stops, so a stopped transport never freezes a stale bar.

const FREQ_MIN = 20
const FREQ_MAX = 20000
const LOG_RANGE = Math.log(FREQ_MAX / FREQ_MIN)
const DB_TOP = 6
const DB_BOTTOM = -36
const MIN_GAP_RATIO = 2
const HIT_PX = 18
const GRID_FREQS = Object.freeze([50, 100, 200, 500, 1000, 2000, 5000, 10000])
const LABEL_FREQS = Object.freeze([[100, '100'], [1000, '1k'], [10000, '10k']])
const GRID_DB = Object.freeze([0, -12, -24])

// Up / down lane: the lower part of the plot, its zero line at LANE_ZERO of the
// height, LANE_DB of change filling LANE_SPAN of the height either way.
const LANE_ZERO = 0.72
const LANE_SPAN = 0.2
const LANE_DB = 24
const SILENT_DB = -90
const FALL = 0.2
const STALE_MS = 400

const BANDS = Object.freeze([
  { key: 'low', gainId: 'gain_low' },
  { key: 'mid', gainId: 'gain_mid' },
  { key: 'high', gainId: 'gain_high' },
])

const freqToX = (freq, w) => (Math.log(Math.max(FREQ_MIN, freq) / FREQ_MIN) / LOG_RANGE) * w
const xToFreq = (x, w) => FREQ_MIN * Math.exp(Math.min(1, Math.max(0, x / Math.max(1, w))) * LOG_RANGE)
const dbToY = (db, h) => ((DB_TOP - db) / (DB_TOP - DB_BOTTOM)) * h
const lpMag = (f, fc) => 1 / (1 + (f / fc) ** 4)
const hpMag = (f, fc) => { const x = (f / fc) ** 4; return x / (1 + x) }
const magToY = (mag, h) => dbToY(Math.max(DB_BOTTOM, Math.min(DB_TOP, 20 * Math.log10(Math.max(mag, 1e-4)))), h)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function readColors(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    bg: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    text: get('--ui-ink-3', '#929292'),
    bands: [0, 1, 2].map((i) => readBandColor(el, i, '#929292')),
  }
}

/** Live up / down per band from the newest bucket: { up, down } in dB, >= 0. */
export function bandMotion(bucket, gains) {
  const read = (prefix, gain) => {
    const inDb = Number(bucket[`${prefix}InputDb`])
    const outDb = Number(bucket[`${prefix}OutputDb`])
    const down = Math.max(0, Number(bucket[`${prefix}GainReductionDb`]) || 0)
    if (!Number.isFinite(inDb) || !Number.isFinite(outDb) || inDb <= SILENT_DB) return { up: 0, down }
    return { up: Math.max(0, outDb - inDb - gain + down), down }
  }
  return [read('low', gains[0]), read('mid', gains[1]), read('high', gains[2])]
}

export default function OverdoneCrossoverCanvas({
  trackId, nodeId, loHz, hiHz, gains, lowRange, highRange, onPreview, onCommit, className,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null)   // 'low' | 'high' | null
  const hoverRef = useRef(null)
  const valuesRef = useRef(null)
  valuesRef.current = { loHz, hiHz, gains, lowRange, highRange }
  const callbacksRef = useRef(null)
  callbacksRef.current = { onPreview, onCommit }
  const motionRef = useRef({ bands: [{ up: 0, down: 0 }, { up: 0, down: 0 }, { up: 0, down: 0 }], clock: -1, stampMs: 0 })

  const sub = useDynamicsVizSubscription(trackId, nodeId, VIZ_TYPE.MULTIBAND)
  const subRef = useRef(sub)
  subRef.current = sub

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    let cancelled = false
    let raf = 0

    const draw = () => {
      if (cancelled) return
      raf = requestAnimationFrame(draw)
      const cssW = canvas.clientWidth || 0
      const cssH = canvas.clientHeight || 0
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const tw = Math.round(cssW * dpr)
      const th = Math.round(cssH * dpr)
      if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
      const g = canvas.getContext('2d', { alpha: false })
      if (!g || cssW < 8 || cssH < 8) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)

      const c = readColors(canvas)
      const { loHz: lo, hiHz: hi, gains: bandGains } = valuesRef.current
      const active = dragRef.current || hoverRef.current

      g.fillStyle = c.bg
      g.fillRect(0, 0, cssW, cssH)

      // Grid: log frequency + dB.
      g.strokeStyle = c.grid
      g.lineWidth = 1
      g.beginPath()
      for (const f of GRID_FREQS) {
        const x = Math.round(freqToX(f, cssW)) + 0.5
        g.moveTo(x, 0); g.lineTo(x, cssH)
      }
      for (const db of GRID_DB) {
        const y = Math.round(dbToY(db, cssH)) + 0.5
        g.moveTo(0, y); g.lineTo(cssW, y)
      }
      g.stroke()

      g.font = uiCanvasFont('10px')
      g.textBaseline = 'bottom'
      g.textAlign = 'center'
      g.fillStyle = c.text
      for (const [f, label] of LABEL_FREQS) g.fillText(label, freqToX(f, cssW), cssH - 3)

      // Crossover filter curves, sampled on the axis's log scale.
      const curves = [
        (f) => lpMag(f, lo),
        (f) => hpMag(f, lo) * lpMag(f, hi),
        (f) => hpMag(f, hi),
      ]
      const steps = Math.max(64, Math.floor(cssW / 2))
      curves.forEach((mag, i) => {
        g.beginPath()
        for (let s = 0; s <= steps; s++) {
          const f = FREQ_MIN * Math.exp((s / steps) * LOG_RANGE)
          const x = freqToX(f, cssW)
          const y = magToY(mag(f), cssH)
          if (s === 0) g.moveTo(x, y); else g.lineTo(x, y)
        }
        g.save()
        g.lineTo(cssW, cssH); g.lineTo(0, cssH); g.closePath()
        g.fillStyle = c.bands[i]
        g.globalAlpha = 0.08
        g.fill()
        g.restore()
        g.strokeStyle = c.bands[i]
        g.lineWidth = 1.8
        g.stroke()
      })

      // Live up / down per band, in the lower lane of each band's region.
      const motion = motionRef.current
      const bucket = subRef.current?.ringRef?.current?.last?.() || null
      const now = performance.now()
      let targets = null
      if (bucket) {
        if (bucket.sampleClock !== motion.clock) { motion.clock = bucket.sampleClock; motion.stampMs = now }
        if (now - motion.stampMs < STALE_MS) targets = bandMotion(bucket, bandGains)
      }
      for (let i = 0; i < 3; i++) {
        const m = motion.bands[i]
        const t = targets ? targets[i] : { up: 0, down: 0 }
        m.up = t.up > m.up ? t.up : m.up + (t.up - m.up) * FALL
        m.down = t.down > m.down ? t.down : m.down + (t.down - m.down) * FALL
      }
      const xLo = freqToX(lo, cssW)
      const xHi = freqToX(hi, cssW)
      const regions = [[0, xLo], [xLo, xHi], [xHi, cssW]]
      const zeroY = Math.round(cssH * LANE_ZERO) + 0.5
      const span = cssH * LANE_SPAN
      g.strokeStyle = c.grid
      g.beginPath(); g.moveTo(0, zeroY); g.lineTo(cssW, zeroY); g.stroke()
      g.textBaseline = 'top'
      regions.forEach(([x0, x1], i) => {
        const w = x1 - x0
        if (w < 6) return
        const barW = Math.min(14, Math.max(4, w * 0.18))
        const cx = x0 + w / 2
        const { up, down } = motion.bands[i]
        const upH = (clamp(up, 0, LANE_DB) / LANE_DB) * span
        const downH = (clamp(down, 0, LANE_DB) / LANE_DB) * span
        g.fillStyle = c.bands[i]
        g.globalAlpha = 0.85
        if (upH >= 0.5) g.fillRect(cx - barW - 1, zeroY - upH, barW, upH)
        if (downH >= 0.5) g.fillRect(cx + 1, zeroY, barW, downH)
        g.globalAlpha = 1
        if (w >= 64 && (up >= 0.1 || down >= 0.1)) {
          g.fillStyle = c.text
          g.textAlign = 'center'
          g.fillText(`+${up.toFixed(1)} / −${down.toFixed(1)}`, cx, zeroY + span + 4)
        }
      })

      // Crossover lines and readouts.
      const handles = [{ key: 'low', hz: lo, color: c.bands[0] }, { key: 'high', hz: hi, color: c.bands[2] }]
      for (const h of handles) {
        const x = Math.round(freqToX(h.hz, cssW)) + 0.5
        const isActive = active === h.key
        g.strokeStyle = h.color
        g.lineWidth = isActive ? 2 : 1
        g.globalAlpha = isActive ? 1 : 0.6
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cssH); g.stroke()
        g.globalAlpha = 1
        g.fillStyle = h.color
        g.textBaseline = 'top'
        const left = x < cssW / 2
        g.textAlign = left ? 'left' : 'right'
        // Below the well's view switch (top right), so a high crossover stays readable.
        g.fillText(formatValue(h.hz, 'Hz'), left ? x + 4 : x - 4, 34)
      }
    }

    raf = requestAnimationFrame(draw)
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [])

  const hitTest = (x, w) => {
    const { loHz: lo, hiHz: hi } = valuesRef.current
    const dLo = Math.abs(x - freqToX(lo, w))
    const dHi = Math.abs(x - freqToX(hi, w))
    if (dLo <= HIT_PX && dLo <= dHi) return 'low'
    if (dHi <= HIT_PX) return 'high'
    return null
  }

  const valueAt = (x, w) => {
    const { loHz: lo, hiHz: hi, lowRange, highRange } = valuesRef.current
    const freq = xToFreq(x, w)
    return dragRef.current === 'low'
      ? ['xover_low', clamp(freq, lowRange[0], Math.min(lowRange[1], hi / MIN_GAP_RATIO))]
      : ['xover_high', clamp(freq, Math.max(highRange[0], lo * MIN_GAP_RATIO), highRange[1])]
  }

  const onPointerDown = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const hit = hitTest(e.clientX - rect.left, rect.width)
    if (!hit) return
    dragRef.current = hit
    hoverRef.current = hit
    canvas.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (dragRef.current) {
      const [id, v] = valueAt(x, rect.width)
      callbacksRef.current.onPreview?.(id, v)
      return
    }
    hoverRef.current = hitTest(x, rect.width)
    canvas.style.cursor = hoverRef.current ? 'ew-resize' : 'default'
  }

  const endDrag = (e) => {
    const canvas = canvasRef.current
    if (dragRef.current && e?.type === 'pointerup') {
      const rect = canvas.getBoundingClientRect()
      const [id, v] = valueAt(e.clientX - rect.left, rect.width)
      callbacksRef.current.onCommit?.(id, v)
    }
    dragRef.current = null
    if (e?.pointerId != null && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label="Crossover display. Drag a crossover line to move it."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  )
}

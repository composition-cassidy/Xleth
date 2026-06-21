import { useRef, useEffect } from 'react'
import { peaksSnapshot } from '../../stores/mixerStore.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'

function linearToDB(gain) {
  if (gain <= 0) return -96
  const db = 20 * Math.log10(gain)
  return Math.max(-96, Math.min(12, db))
}

// Piecewise scale that expands the top of the meter — the range musicians
// actually read — so 0 dB and -6 dB sit far enough apart to be legible, while
// the quiet tail (-12 → -96 dB) compresses toward the floor.  Continuous at
// every breakpoint:  -96→0, -12→0.30, 0→0.62, +12→1.0  (so -6 lands at 0.46,
// a clear 16% gap below 0 dB).
function dbToPos(db) {
  if (db <= -96) return 0
  if (db >= 12) return 1
  if (db >= 0)   return 0.62 + (db / 12) * 0.38   // 0 … +12 dB  → 0.62 … 1.0
  if (db >= -12) return 0.62 + (db / 12) * 0.32   // 0 … -12 dB  → 0.62 … 0.30
  return 0.30 * (db + 96) / 84                     // -12 … -96 dB → 0.30 … 0
}

function peakToPos(peak) {
  return dbToPos(linearToDB(peak))
}

const BAR_W = 8
const GAP = 3
const TOTAL_W = BAR_W * 2 + GAP  // 19px
const RADIUS = 0  // square bars — matches the flat mockup meter

// Only the two reference marks the design calls for.
const SCALE_TICKS = [
  { db: 0,  label: '0'  },
  { db: -6, label: '-6' },
]

function roundedBarPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

export default function PeakMeter({ trackId, master }) {
  const themeEpoch = useThemeEpoch()
  const canvasRef = useRef(null)
  const wrapRef   = useRef(null)
  const rafRef    = useRef(null)
  const smoothRef = useRef({ l: 0, r: 0 })
  const gradientRef = useRef(null)

  // Drop the cached rail gradient when the theme changes so the RAF loop
  // rebuilds it with the new success/warning/danger token colors.
  useEffect(() => { gradientRef.current = null }, [themeEpoch])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w   = TOTAL_W
      const h   = wrapRef.current
        ? Math.floor(wrapRef.current.getBoundingClientRect().height)
        : 180

      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width  = w * dpr
        c.height = h * dpr
        c.style.width  = `${w}px`
        c.style.height = `${h}px`
        gradientRef.current = null
      }

      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Smooth green→yellow→red rail.  No duplicate stops → soft blends.
      if (!gradientRef.current) {
        // Stops track dbToPos: green up to ~-6 dB (0.46), amber approaching
        // 0 dB (0.62), red above unity.
        const g = ctx.createLinearGradient(0, h, 0, 0)
        g.addColorStop(0.00, tokenValue('--theme-success'))
        g.addColorStop(0.46, tokenValue('--theme-success'))
        g.addColorStop(0.62, tokenValue('--theme-warning'))
        g.addColorStop(0.82, tokenValue('--theme-danger'))
        g.addColorStop(1.00, tokenValue('--theme-danger'))
        gradientRef.current = g
      }

      const snap         = master ? peaksSnapshot.master : peaksSnapshot.tracks[trackId]
      const hasTelemetry = Boolean(snap?.hasTelemetry)
      const rawL  = snap ? snap.peakL  : 0
      const rawR  = snap ? snap.peakR  : 0
      const holdL = snap ? snap.holdL  : 0
      const holdR = snap ? snap.holdR  : 0

      const sm = smoothRef.current
      if (!hasTelemetry) {
        sm.l = 0
        sm.r = 0
      } else {
        const decay = 0.85
        sm.l = rawL >= sm.l ? rawL : sm.l * decay
        sm.r = rawR >= sm.r ? rawR : sm.r * decay
      }

      const bars = [
        { x: 0,           lit: peakToPos(sm.l) * h, hold: peakToPos(holdL) },
        { x: BAR_W + GAP, lit: peakToPos(sm.r) * h, hold: peakToPos(holdR) },
      ]

      for (const bar of bars) {
        // Clip to a rounded pill so rail + fill share rounded ends.
        ctx.save()
        roundedBarPath(ctx, bar.x, 0, BAR_W, h, RADIUS)
        ctx.clip()

        // Dim full-height rail — always visible, reads as a meter at idle.
        ctx.globalAlpha = 0.18
        ctx.fillStyle = gradientRef.current
        ctx.fillRect(bar.x, 0, BAR_W, h)

        // Live fill at full opacity on top of the dim rail.
        ctx.globalAlpha = 1
        if (bar.lit > 0) ctx.fillRect(bar.x, h - bar.lit, BAR_W, bar.lit)

        // Peak-hold line.
        if (hasTelemetry && bar.hold > 0.01) {
          ctx.fillStyle = tokenValue('--theme-mixer-meter-peak-hold')
          ctx.fillRect(bar.x, h - bar.hold * h, BAR_W, 2)
        }
        ctx.restore()
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [trackId, master])

  return (
    <div className="peak-meter-module">
      <div className="peak-meter-scale">
        {SCALE_TICKS.map(({ db, label }) => (
          <span
            key={db}
            className="peak-meter-scale-label"
            style={{ bottom: `${dbToPos(db) * 100}%` }}
          >
            {label}<span className="peak-meter-scale-unit">db</span>
          </span>
        ))}
      </div>
      <div ref={wrapRef} className="peak-meter-canvas-wrap">
        <canvas ref={canvasRef} className="peak-meter-canvas" />
      </div>
    </div>
  )
}

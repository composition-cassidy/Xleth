import { useRef, useEffect } from 'react'
import { peaksSnapshot } from '../../stores/mixerStore.js'

// dB conversion for meter height mapping
function linearToDB(gain) {
  if (gain <= 0) return -96
  const db = 20 * Math.log10(gain)
  return Math.max(-96, Math.min(12, db))
}

// Map dB to normalized 0..1 position (same curve as VolumeFader)
function dbToPos(db) {
  if (db <= -96) return 0
  if (db >= 12) return 1
  if (db <= 0) {
    const t = Math.sqrt(1 - db / -96)
    return t * 0.75
  }
  return 0.75 + (db / 12) * 0.25
}

function peakToPos(peak) {
  return dbToPos(linearToDB(peak))
}

const BAR_W = 6
const GAP = 1
const TOTAL_W = BAR_W * 2 + GAP

export default function PeakMeter({ trackId, master }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(null)
  const smoothRef = useRef({ l: 0, r: 0 })
  const gradientRef = useRef(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = c.parentElement?.getBoundingClientRect()
      const w = TOTAL_W
      const h = rect ? Math.floor(rect.height) : 180

      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr
        c.height = h * dpr
        c.style.width = `${w}px`
        c.style.height = `${h}px`
        gradientRef.current = null
      }

      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Create gradient (cached)
      if (!gradientRef.current) {
        const g = ctx.createLinearGradient(0, h, 0, 0)
        // Bottom (low) to top (high)
        const redStart = dbToPos(-3)
        const yellowStart = dbToPos(-12)
        g.addColorStop(0, '#22C55E')
        g.addColorStop(yellowStart, '#22C55E')
        g.addColorStop(yellowStart, '#FFAA33')
        g.addColorStop(redStart, '#FFAA33')
        g.addColorStop(redStart, '#FF4757')
        g.addColorStop(1, '#FF4757')
        gradientRef.current = g
      }

      // Read peaks from snapshot
      const snap = master ? peaksSnapshot.master : peaksSnapshot.tracks[trackId]
      const rawL = snap ? snap.peakL : 0
      const rawR = snap ? snap.peakR : 0
      const holdL = snap ? snap.holdL : 0
      const holdR = snap ? snap.holdR : 0

      // Smooth: fast attack, ~26dB/sec release
      const sm = smoothRef.current
      const decay = 0.85 // per-frame decay at 60fps ≈ 26dB/sec
      sm.l = rawL >= sm.l ? rawL : sm.l * decay
      sm.r = rawR >= sm.r ? rawR : sm.r * decay

      // Draw bars
      const posL = peakToPos(sm.l)
      const posR = peakToPos(sm.r)
      const hL = posL * h
      const hR = posR * h

      ctx.fillStyle = gradientRef.current
      if (hL > 0) ctx.fillRect(0, h - hL, BAR_W, hL)
      if (hR > 0) ctx.fillRect(BAR_W + GAP, h - hR, BAR_W, hR)

      // Peak hold lines
      const holdPosL = peakToPos(holdL)
      const holdPosR = peakToPos(holdR)
      ctx.fillStyle = '#E8E8ED'
      if (holdPosL > 0.01) {
        const hy = h - holdPosL * h
        ctx.fillRect(0, hy, BAR_W, 2)
      }
      if (holdPosR > 0.01) {
        const hy = h - holdPosR * h
        ctx.fillRect(BAR_W + GAP, hy, BAR_W, 2)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [trackId, master])

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: TOTAL_W,
        flexShrink: 0,
      }}
    />
  )
}

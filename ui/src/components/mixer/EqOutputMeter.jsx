import React, { useRef, useEffect } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'

const BAR_W   = 6
const GAP     = 1
const PAD     = 2
const METER_W = PAD * 2 + BAR_W * 2 + GAP

function linearToDB(g) {
  if (g <= 0) return -96
  return Math.max(-96, Math.min(12, 20 * Math.log10(g)))
}

function dbToPos(db) {
  if (db <= -96) return 0
  if (db >= 12)  return 1
  if (db <= 0)   return Math.sqrt(1 - db / -96) * 0.75
  return 0.75 + (db / 12) * 0.25
}

const HOLD_MS = 1500
const DECAY   = 0.94  // per-frame release at ~60fps

// peaksRef.current = { l: <amplitude 0..n>, r: <amplitude 0..n> }
// Updated at 30 Hz by EqPanel's existing polling loop.
// active = false → canvas cleared, no draws (fallback when no target).
export default function EqOutputMeter({ peaksRef, active }) {
  const canvasRef = useRef(null)
  const smRef     = useRef({ l: 0, r: 0 })
  const holdRef   = useRef({ l: 0, r: 0, tL: 0, tR: 0 })
  const gradRef   = useRef(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    let rafId

    const draw = () => {
      const dpr  = window.devicePixelRatio || 1
      // Read from the canvas's own rendered rect — NOT the parent.
      // Reading parent height and writing c.style.height causes a layout
      // feedback loop (each frame grows the parent by label+padding height).
      const rect = c.getBoundingClientRect()
      const h    = Math.max(20, Math.floor(rect.height))
      const w    = METER_W

      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width  = w * dpr
        c.height = h * dpr
        c.style.width = `${w}px`
        // c.style.height intentionally omitted — flex layout controls canvas height.
        gradRef.current = null
      }

      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      if (active) {
        const now  = performance.now()
        const raw  = peaksRef?.current ?? { l: 0, r: 0 }
        const sm   = smRef.current
        const hold = holdRef.current

        // Attack: instant; release: smooth decay
        if (raw.l >= sm.l) { sm.l = raw.l; if (raw.l >= hold.l) { hold.l = raw.l; hold.tL = now } }
        else sm.l *= DECAY
        if (raw.r >= sm.r) { sm.r = raw.r; if (raw.r >= hold.r) { hold.r = raw.r; hold.tR = now } }
        else sm.r *= DECAY

        // Hold peak decay after HOLD_MS
        if (now - hold.tL > HOLD_MS) hold.l *= DECAY
        if (now - hold.tR > HOLD_MS) hold.r *= DECAY

        // Gradient (invalidated on canvas resize)
        if (!gradRef.current) {
          const g   = ctx.createLinearGradient(0, h, 0, 0)
          const yel = dbToPos(-12)
          const red = dbToPos(-3)
          g.addColorStop(0,   tokenValue('--theme-success'))
          g.addColorStop(yel, tokenValue('--theme-success'))
          g.addColorStop(yel, tokenValue('--theme-warning'))
          g.addColorStop(red, tokenValue('--theme-warning'))
          g.addColorStop(red, tokenValue('--theme-danger'))
          g.addColorStop(1,   tokenValue('--theme-danger'))
          gradRef.current = g
        }

        const posL = dbToPos(linearToDB(sm.l))
        const posR = dbToPos(linearToDB(sm.r))
        const hL   = posL * h
        const hR   = posR * h

        ctx.fillStyle = gradRef.current
        if (hL > 0) ctx.fillRect(PAD,               h - hL, BAR_W, hL)
        if (hR > 0) ctx.fillRect(PAD + BAR_W + GAP, h - hR, BAR_W, hR)

        // Peak hold lines
        ctx.fillStyle = tokenValue('--theme-mixer-meter-peak-hold')
        const hPosL = dbToPos(linearToDB(hold.l))
        const hPosR = dbToPos(linearToDB(hold.r))
        if (hPosL > 0.01) ctx.fillRect(PAD,               h - hPosL * h, BAR_W, 2)
        if (hPosR > 0.01) ctx.fillRect(PAD + BAR_W + GAP, h - hPosR * h, BAR_W, 2)
      }

      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [active, peaksRef])

  return (
    <div className="eq-output-meter">
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <div className="eq-output-meter-label">OUT</div>
    </div>
  )
}

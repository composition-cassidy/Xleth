import { useRef, useEffect, useCallback } from 'react'
import { tokenValue } from '../../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import { buildEnvelopePath } from './modEval.js'

// ── Read-only DAHDSR envelope preview ────────────────────────────────────────
// Draws the shape the ENV knobs describe, updating live as they move. No
// interaction — the knobs are the editor; this is the picture of what they do.
// `env` carries resolved SECONDS (delaySec/attackSec/holdSec/decaySec/
// releaseSec), sustain (0..1) and the three tensions.

export default function ModEnvPreview({ env, color, width = 460, height = 120 }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const bg = tokenValue('--theme-sampler-envelope-bg') || tokenValue('--theme-bg-primary')
    const gridCol = tokenValue('--theme-border-subtle')
    const resolvedColor = color?.startsWith('var(')
      ? tokenValue(color.slice(4, -1)) || tokenValue('--theme-accent')
      : (color || tokenValue('--theme-accent'))

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    // Baseline.
    ctx.strokeStyle = gridCol
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, height - 8 + 0.5); ctx.lineTo(width, height - 8 + 0.5); ctx.stroke()

    const path = buildEnvelopePath(env || {})
    const px = (x) => x * width
    const py = (y) => (height - 8) - y * (height - 16)
    const rgb = hexToRgb(resolvedColor)

    ctx.beginPath()
    ctx.moveTo(px(path[0].x), py(path[0].y))
    for (const p of path) ctx.lineTo(px(p.x), py(p.y))
    ctx.lineTo(px(path[path.length - 1].x), py(0))
    ctx.lineTo(px(path[0].x), py(0))
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, 0, 0, height)
    grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.18)`)
    grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0.02)`)
    ctx.fillStyle = grad
    ctx.fill()

    ctx.beginPath()
    ctx.strokeStyle = resolvedColor
    ctx.lineWidth = 1.5
    for (let i = 0; i < path.length; i++) {
      if (i === 0) ctx.moveTo(px(path[i].x), py(path[i].y))
      else ctx.lineTo(px(path[i].x), py(path[i].y))
    }
    ctx.stroke()
  }, [env, color, width, height, themeEpoch])

  useEffect(() => { draw() }, [draw])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 120, g: 200, b: 210 }
  let h = hex.trim()
  if (h.startsWith('#')) h = h.slice(1)
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return { r: 120, g: 200, b: 210 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

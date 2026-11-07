import { useEffect, useMemo, useRef } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  CABLE_H, DOT_Y, LANE_YS, MASTER, MASTER_RAIL_Y, cableX, computeCables, masterRail,
} from './routingCables.js'
import styles from './RoutingBand.module.css'

/** Draws one frame of the band. Pure with respect to its arguments (testable with a fake ctx). */
export function drawRouting(ctx, { cables, stripW, width, colors, idColors, orderedIds }) {
  ctx.clearRect(0, 0, width, CABLE_H)
  const audio = colors.audio
  const stroke = (cable) => {
    ctx.setLineDash(cable.kind === 'sidechain' ? [3, 2] : [])
    ctx.lineWidth = cable.kind === 'sidechain' ? 1 : 1.5
    ctx.globalAlpha = cable.kind === 'sidechain' ? 0.5 : 0.95
    ctx.strokeStyle = audio
  }

  // Master rail first, so the track-to-track runs and dots paint over it.
  const rail = masterRail(cables, stripW, width)
  if (rail) {
    stroke({ kind: 'output' })
    ctx.beginPath()
    for (const x of rail.stubs) { ctx.moveTo(x, DOT_Y); ctx.lineTo(x, MASTER_RAIL_Y) }
    ctx.moveTo(rail.x0, MASTER_RAIL_Y)
    ctx.lineTo(rail.x1 - 3, MASTER_RAIL_Y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 0.95
    ctx.fillStyle = audio
    ctx.beginPath()
    ctx.moveTo(rail.x1, MASTER_RAIL_Y)
    ctx.lineTo(rail.x1 - 5, MASTER_RAIL_Y - 3)
    ctx.lineTo(rail.x1 - 5, MASTER_RAIL_Y + 3)
    ctx.closePath()
    ctx.fill()
  }

  for (const cable of cables) {
    if (cable.to === MASTER) continue
    const xs = cableX(cable.from, stripW, cable.kind)
    const xt = cableX(cable.to, stripW, cable.kind)
    const y = LANE_YS[cable.lane ?? 0]
    stroke(cable)
    ctx.beginPath()
    ctx.moveTo(xs, DOT_Y)
    ctx.lineTo(xs, y)
    ctx.lineTo(xt, y)
    ctx.lineTo(xt, DOT_Y + 3)
    ctx.stroke()
    // arrowhead into the target strip
    ctx.setLineDash([])
    ctx.fillStyle = audio
    ctx.beginPath()
    ctx.moveTo(xt, DOT_Y)
    ctx.lineTo(xt - 3, DOT_Y + 4)
    ctx.lineTo(xt + 3, DOT_Y + 4)
    ctx.closePath()
    ctx.fill()
  }

  // Source dots in each track's identity colour: the colour thread reaches the cable.
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  const drawn = new Set()
  for (const cable of cables) {
    if (cable.kind !== 'output' || drawn.has(cable.from)) continue
    drawn.add(cable.from)
    ctx.fillStyle = idColors[orderedIds[cable.from]] || colors.idle
    ctx.beginPath()
    ctx.arc(cableX(cable.from, stripW), DOT_Y, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/**
 * The routing cables, on one canvas under the strips (FL's pattern, drawn from
 * this store's own outputRoutes and sidechainRoutes). It redraws when routing,
 * the strip set, the strip width, the theme or the canvas size changes; there
 * is no animation loop and no timer. The canvas never takes pointer events: the
 * Output selects on the strips are how a route is changed.
 */
export default function RoutingBand({ orderedIds, stripW, idColors }) {
  const outputRoutes = useMixerStore(s => s.outputRoutes)
  const sidechainRoutes = useMixerStore(s => s.sidechainRoutes)
  const epoch = useThemeEpoch()
  const canvasRef = useRef(null)

  const cables = useMemo(
    () => computeCables({ orderedIds, outputRoutes, sidechainRoutes }),
    [orderedIds, outputRoutes, sidechainRoutes],
  )
  const drawRef = useRef(null)

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext?.('2d')
      if (!canvas || !ctx) return
      const width = canvas.clientWidth
      if (width <= 0) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(CABLE_H * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(CABLE_H * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Read at draw time: tokenValue() is empty before the ThemeProvider mounts.
      const colors = { audio: tokenValue('--ui-signal-audio'), idle: tokenValue('--ui-ink-3') }
      drawRouting(ctx, { cables, stripW, width, colors, idColors, orderedIds })
    }
    drawRef.current()
  }, [cables, stripW, idColors, orderedIds, epoch])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => drawRef.current?.())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  return <canvas ref={canvasRef} className={styles.band} data-testid="routing-band" aria-hidden="true" />
}

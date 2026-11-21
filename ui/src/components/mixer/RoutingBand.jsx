import { useEffect, useMemo, useRef } from 'react'
import useMixerStore from '../../stores/mixerStore.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  CABLE_H, DOT_Y, LANE_YS, MASTER, MASTER_RAIL_Y, cableX, computeCables, masterRail,
} from './routingCables.js'
import styles from './RoutingBand.module.css'

/** Opacity of a cable: the selected strip's own routes read at full strength, the rest recede. */
export const CABLE_ALPHA_SELECTED = 0.95
export const CABLE_ALPHA_OTHER = 0.4

/**
 * Draws one frame of the band. Pure with respect to its arguments (testable with a fake ctx).
 * Audio routes (primary outputs and sends) are drawn in `colors.audio` (white), sidechain
 * keys in `colors.sidechain` (yellow), as on the route arrows below. A cable runs from its
 * source's dot down into the target's route arrow; Master-bound outputs share the rail.
 */
export function drawRouting(ctx, { cables, stripW, width, colors, idColors, orderedIds, selectedIndex = -1 }) {
  ctx.clearRect(0, 0, width, CABLE_H)
  const audio = colors.audio
  const keyInk = colors.sidechain ?? audio
  const touchesSelected = (c) => selectedIndex >= 0 && (c.from === selectedIndex || c.to === selectedIndex)
  const stroke = (cable) => {
    ctx.setLineDash([])
    ctx.lineWidth = cable.kind === 'sidechain' ? 1 : 1.5
    ctx.globalAlpha = selectedIndex < 0 || touchesSelected(cable) ? CABLE_ALPHA_SELECTED : CABLE_ALPHA_OTHER
    ctx.strokeStyle = cable.kind === 'sidechain' ? keyInk : audio
  }

  // Master rail first, so the track-to-track runs and dots paint over it.
  const rail = masterRail(cables, stripW, width)
  if (rail) {
    const bound = cables.filter((c) => c.kind === 'output' && c.to === MASTER)
    for (const c of bound) {
      stroke(c)
      ctx.beginPath()
      const x = cableX(c.from, stripW)
      ctx.moveTo(x, DOT_Y)
      ctx.lineTo(x, MASTER_RAIL_Y)
      ctx.stroke()
    }
    stroke({ kind: 'output', from: -2, to: bound.some((c) => c.from === selectedIndex) ? selectedIndex : -2 })
    ctx.beginPath()
    ctx.moveTo(rail.x0, MASTER_RAIL_Y)
    ctx.lineTo(rail.x1 - 3, MASTER_RAIL_Y)
    ctx.stroke()
    ctx.fillStyle = audio
    ctx.beginPath()
    ctx.moveTo(rail.x1, MASTER_RAIL_Y)
    ctx.lineTo(rail.x1 - 5, MASTER_RAIL_Y - 3)
    ctx.lineTo(rail.x1 - 5, MASTER_RAIL_Y + 3)
    ctx.closePath()
    ctx.fill()
  }

  // Track-to-track: the faint ones first, so the selected strip's routes paint on top.
  const runs = cables
    .filter((c) => c.to !== MASTER)
    .sort((a, b) => Number(touchesSelected(a)) - Number(touchesSelected(b)))
  for (const cable of runs) {
    const xs = cableX(cable.from, stripW, cable.kind)
    const xt = cableX(cable.to, stripW, cable.kind)
    const y = LANE_YS[cable.lane ?? 0]
    stroke(cable)
    ctx.beginPath()
    ctx.moveTo(xs, DOT_Y)
    ctx.lineTo(xs, y)
    ctx.lineTo(xt, y)
    ctx.lineTo(xt, CABLE_H)
    ctx.stroke()
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
 * this store's own outputRoutes, sends and sidechainRoutes). It redraws when
 * routing, the selection, the strip set, the strip width, the theme or the
 * canvas size changes; there is no animation loop and no timer. The canvas never
 * takes pointer events: the route arrows under it are how a route is changed.
 */
export default function RoutingBand({ orderedIds, stripW, idColors }) {
  const outputRoutes = useMixerStore(s => s.outputRoutes)
  const sends = useMixerStore(s => s.sends)
  const sidechainRoutes = useMixerStore(s => s.sidechainRoutes)
  const selectedChainKey = useMixerStore(s => s.selectedChainKey)
  const epoch = useThemeEpoch()
  const canvasRef = useRef(null)

  const cables = useMemo(
    () => computeCables({ orderedIds, outputRoutes, sends, sidechainRoutes }),
    [orderedIds, outputRoutes, sends, sidechainRoutes],
  )
  const selectedIndex = useMemo(
    () => (selectedChainKey == null || selectedChainKey === 'master' ? -1 : orderedIds.indexOf(Number(selectedChainKey))),
    [selectedChainKey, orderedIds],
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
      // White audio routes, yellow sidechain keys: the same inks as the route arrows.
      const colors = { audio: tokenValue('--ui-ink'), sidechain: tokenValue('--ui-solo'), idle: tokenValue('--ui-ink-3') }
      drawRouting(ctx, { cables, stripW, width, colors, idColors, orderedIds, selectedIndex })
    }
    drawRef.current()
  }, [cables, stripW, idColors, orderedIds, selectedIndex, epoch])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => drawRef.current?.())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  return <canvas ref={canvasRef} className={styles.band} data-testid="routing-band" aria-hidden="true" />
}

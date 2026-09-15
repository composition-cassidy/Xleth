import { useEffect, useRef } from 'react'
import { usePluginUI } from '../PluginUIContext.js'
import { styleToCSS } from '../styleToCSS.js'
import { readDynamicsTheme } from '../visualizers/theme.js'
import { drawDistortionCurve, normalizeDistortionParams } from '../visualizers/distortionPainter.js'

// distortionCurve — draws the active mode's analytic transfer function live
// from param values. Pure math, no engine/viz feed (see distortionPainter.js).
// Modeled on CompressorCurveNode's canvas lifecycle, minus the drag handles:
// this curve has nothing to grab, it's a picture of the shaper, not a control.
export default function DistortionCurveNode({ node }) {
  const { params } = usePluginUI()
  const { props = {}, style = {} } = node
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const bindingsRef = useRef(null)

  paramsRef.current = params
  bindingsRef.current = {
    modeParam:     props.modeParam || 'mode',
    driveParam:    props.driveParam || 'drive',
    symmetryParam: props.symmetryParam || 'symmetry',
    bitsParam:     props.bitsParam || 'bits',
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let rafId = 0

    const draw = () => {
      if (cancelled) return
      const cssW = canvas.clientWidth || 1
      const cssH = canvas.clientHeight || 1
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const targetW = Math.round(cssW * dpr)
      const targetH = Math.round(cssH * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const theme = readDynamicsTheme(canvas)
        const distortionParams = normalizeDistortionParams(paramsRef.current, bindingsRef.current)
        drawDistortionCurve(ctx, cssW, cssH, distortionParams, theme)
      }
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div
      className="pluginui-distortion-curve"
      style={styleToCSS(style)}
      data-pluginui-id={node.id}
    >
      <canvas ref={canvasRef} className="pluginui-distortion-curve-canvas" />
    </div>
  )
}

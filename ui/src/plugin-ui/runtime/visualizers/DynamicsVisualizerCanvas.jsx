// ─── DynamicsVisualizerCanvas.jsx ───────────────────────────────────────────
// Canvas wrapper that drives a per-frame painter for a Compressor visualizer
// node. Owns the rAF loop for drawing only (drain is owned by
// useDynamicsVizSubscription); never touches React state per frame.
//
// Props:
//   trackId, nodeId   — engine effect coordinates
//   sourceKey         — viz source (e.g. 'compressor.gainReductionHistory')
//   preset            — painter key, e.g. 'levelHistory' | 'transferCurveLive'
//   heightPx          — preferred canvas height (width is fluid)
//   params            — compressor parameter snapshot (for transfer curve)
//   onUnavailable     — optional callback when schema/type mismatch is detected
//                       (used by VisualizerNode to swap to a placeholder)
//
// Notes:
//   • DPR-aware: backing-store size is bumped on resize so canvas stays sharp
//     on hi-DPI displays.
//   • Theme tokens are read once per rAF (cached for that frame) — see theme.js.
//   • The rAF loop's useEffect deps include ONLY identity-stable inputs
//     (trackId, nodeId, sourceKey, preset). Per-frame data (params,
//     onUnavailable) is read from refs that are kept fresh by a separate
//     non-restarting effect, so knob movement does NOT thrash rAF.

import { useEffect, useRef } from 'react'
import { useDynamicsVizSubscription } from '../useDynamicsVizSubscription.js'
import { COMPRESSOR_PRESETS, COMPRESSOR_SOURCE_DEFAULT_PRESET } from './compressorPainter.js'
import { LIMITER_PRESETS, LIMITER_SOURCE_DEFAULT_PRESET } from './limiterPainter.js'
import { TRANSIENT_PRESETS, TRANSIENT_SOURCE_DEFAULT_PRESET } from './transientPainter.js'
import { MULTIBAND_PRESETS, MULTIBAND_SOURCE_DEFAULT_PRESET } from './multibandPainter.js'
import { RESONANCE_PRESETS, RESONANCE_SOURCE_DEFAULT_PRESET } from './resonancePainter.js'
import { VIZ_TYPE } from '../../../constants/dynamicsViz.js'
import { readDynamicsTheme } from './theme.js'

// Source-key prefix → bucket schema / painter set. Prefix dispatch keeps the
// canvas oblivious to which exact preset is in play; the painter registry
// looks the painter function up by key.
function resolveDispatch(sourceKey) {
  if (typeof sourceKey === 'string' && sourceKey.startsWith('limiter.')) {
    return {
      vizType:        VIZ_TYPE.LIMITER,
      presets:        LIMITER_PRESETS,
      defaultsBySrc:  LIMITER_SOURCE_DEFAULT_PRESET,
      fallbackPreset: 'limiterRealtime',
    }
  }
  if (typeof sourceKey === 'string' && sourceKey.startsWith('transient.')) {
    return {
      vizType:        VIZ_TYPE.TRANSIENT,
      presets:        TRANSIENT_PRESETS,
      defaultsBySrc:  TRANSIENT_SOURCE_DEFAULT_PRESET,
      fallbackPreset: 'transientShaper',
    }
  }
  if (typeof sourceKey === 'string' && sourceKey.startsWith('overdone.')) {
    return {
      vizType:        VIZ_TYPE.MULTIBAND,
      presets:        MULTIBAND_PRESETS,
      defaultsBySrc:  MULTIBAND_SOURCE_DEFAULT_PRESET,
      fallbackPreset: 'overdoneMultiband',
    }
  }
  if (typeof sourceKey === 'string' && sourceKey.startsWith('resonance.')) {
    return {
      vizType:        VIZ_TYPE.RESONANCE,
      presets:        RESONANCE_PRESETS,
      defaultsBySrc:  RESONANCE_SOURCE_DEFAULT_PRESET,
      fallbackPreset: 'resonanceCombined',
    }
  }
  return {
    vizType:        VIZ_TYPE.COMPRESSOR,
    presets:        COMPRESSOR_PRESETS,
    defaultsBySrc:  COMPRESSOR_SOURCE_DEFAULT_PRESET,
    fallbackPreset: 'levelHistory',
  }
}

export default function DynamicsVisualizerCanvas({
  trackId,
  nodeId,
  sourceKey,
  preset,
  heightPx = 110,
  params,
  onUnavailable,
}) {
  const canvasRef       = useRef(null)
  const rafRef          = useRef(0)
  const paramsRef       = useRef(params)
  const onUnavailableRef = useRef(onUnavailable)
  const heightPxRef     = useRef(heightPx)
  const lastUnavailableReasonRef = useRef(null)

  // Keep refs fresh without restarting the rAF loop.
  paramsRef.current        = params
  onUnavailableRef.current = onUnavailable
  heightPxRef.current      = heightPx

  const dispatch = resolveDispatch(sourceKey)
  const sub = useDynamicsVizSubscription(trackId, nodeId, dispatch.vizType)

  // Resolve painter once we know the preset / source.
  const effectivePreset = preset || dispatch.defaultsBySrc[sourceKey] || dispatch.fallbackPreset
  const painter         = dispatch.presets[effectivePreset] || dispatch.presets[dispatch.fallbackPreset]

  // ── Drawing rAF loop ──────────────────────────────────────────────────────
  // Restart only on identity-stable inputs; per-frame values live in refs.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false

    const draw = () => {
      if (cancelled) return
      const ring   = sub.ringRef?.current
      const schema = sub.schemaRef?.current

      // Schema/availability gate. Notify upstream once per distinct reason
      // so we don't churn React with repeat setStates of the same value.
      if (schema && !schema.ok && schema.reason && schema.reason !== 'pending') {
        if (lastUnavailableReasonRef.current !== schema.reason) {
          lastUnavailableReasonRef.current = schema.reason
          onUnavailableRef.current?.(schema.reason)
        }
      } else if (schema && schema.ok && lastUnavailableReasonRef.current !== null) {
        // Engine recovered (rare but possible after reload).
        lastUnavailableReasonRef.current = null
      }

      // DPR-aware resize
      const cssW = canvas.clientWidth || 0
      const cssH = canvas.clientHeight || heightPxRef.current
      const dpr  = Math.max(1, window.devicePixelRatio || 1)
      const targetW = Math.round(cssW * dpr)
      const targetH = Math.round(cssH * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width  = targetW
        canvas.height = targetH
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const theme = readDynamicsTheme(canvas)

      // Repaint regardless of epoch so the live transfer-curve dot follows
      // params even between drains. The cost is small: one canvas clear +
      // ≤ a few hundred line-tos per preset.
      painter(ctx, cssW, cssH, ring, theme, paramsRef.current)

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [sub, painter])

  return (
    <canvas
      ref={canvasRef}
      className="pluginui-visualizer-canvas"
      style={{
        display: 'block',
        width:   '100%',
        height:  `${heightPx}px`,
        // Fallback bg in case theme reads fail before first paint.
        background: 'var(--theme-bg-inset, #0f0f0f)',
      }}
    />
  )
}

import { useEffect, useRef } from 'react'
import { drawEnvelope } from '../../utils/waveformRenderer.js'
import { tokenValue } from '../../theming/tokenValue.ts'

const W = 220
const H = 32

// Small per-layer thumbnail in the sources list. Fetches its own peaks straight
// from the source file (cheap, cached engine-side mipmap) rather than the
// sandbox's rendered buffer — the thumbnail is meant to identify the layer at
// a glance, not preview the current op-stack result.
export default function SandboxLayerWaveform({ filePath, startTime, endTime }) {
  const canvasRef = useRef(null)
  const peaksRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    peaksRef.current = null
    draw() // clear immediately while the fetch is in flight

    if (filePath == null || startTime == null || endTime == null) return undefined

    window.xleth?.waveform?.getFilePeaks?.(filePath, startTime, endTime, W, -1)
      .then((res) => {
        if (cancelled || !res?.ready || !res.peaks?.length) return
        peaksRef.current = res.peaks
        draw()
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [filePath, startTime, endTime])

  function draw() {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== W * dpr || c.height !== H * dpr) {
      c.width = W * dpr
      c.height = H * dpr
      c.style.width = `${W}px`
      c.style.height = `${H}px`
    }
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const peaks = peaksRef.current
    if (!peaks || !peaks.length) return
    const cols = Math.floor(peaks.length / 3)
    drawEnvelope(
      ctx, peaks, 0, 0, W, H, 0, cols,
      tokenValue('--theme-accent-bg-medium') || 'rgba(0,184,150,0.35)',
      tokenValue('--theme-accent') || '#00b896',
    )
  }

  return <canvas ref={canvasRef} className="sandbox-layer-waveform" />
}

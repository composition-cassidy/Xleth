import { useRef, useEffect, useState, useCallback } from 'react'
import { drawEnvelope } from '../../utils/waveformRenderer.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'

// Loop Lab waveform: canvas-only render of an engine-mapped region, with
// draggable loop-start/loop-end handles, an FL-style crossfade zone overlay, and
// wheel-zoom / drag-pan. All positions are ENGINE-BUFFER samples (0..numSamples),
// the domain the sampler preview uses (see docs/loop-lab-codepath-report.md §6).
// Nothing here re-implements the crossfade math — this is purely visual; the
// audible loop is produced by the engine sampler via updateSamplerSettings.

const HANDLE_HIT = 7
const MIN_VIEW_SAMPLES = 64

export default function LoopLabWaveform({
  regionId, numSamples, sampleRate,
  loopStart, loopEnd, crossfadeSamples,
  view, onView,
  onCommitLoop,
  width = 760, height = 150,
}) {
  const canvasRef = useRef(null)
  const [peaks, setPeaks] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const themeEpoch = useThemeEpoch()

  const viewStart = view?.start ?? 0
  const viewEnd = view?.end ?? Math.max(1, numSamples)
  const viewLen = Math.max(1, viewEnd - viewStart)

  // Live drag state (samples), applied over props while dragging.
  const dragRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const panRef = useRef(null)

  const liveStart = drag?.start ?? loopStart
  const liveEnd = drag?.end ?? loopEnd

  // ── Peaks fetch for the current view window (seconds domain) ────────────────
  useEffect(() => {
    if (!regionId || !sampleRate) { setLoadError(true); return undefined }
    let cancelled = false
    setPeaks(null)
    setLoadError(false)
    const startSec = viewStart / sampleRate
    const endSec = viewEnd / sampleRate
    async function fetchPeaks() {
      try {
        const data = await window.xleth?.waveform?.getRegionPeaks?.(regionId, startSec, endSec, width, -1)
        if (cancelled) return
        if (data && data.ready && data.peaks?.length > 0) setPeaks(data.peaks)
        else if (data && !data.ready) setTimeout(() => { if (!cancelled) fetchPeaks() }, 150)
        else setLoadError(true)
      } catch { if (!cancelled) setLoadError(true) }
    }
    fetchPeaks()
    return () => { cancelled = true }
  }, [regionId, sampleRate, viewStart, viewEnd, width])

  const sampleToX = useCallback((s) => ((s - viewStart) / viewLen) * width, [viewStart, viewLen, width])
  const xToSample = useCallback((x) => Math.round(viewStart + (Math.max(0, Math.min(width, x)) / width) * viewLen),
    [viewStart, viewLen, width])

  // ── Render ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = tokenValue('--theme-bg-surface') || '#0a0a10'
    ctx.fillRect(0, 0, width, height)

    if (!peaks) {
      ctx.fillStyle = tokenValue('--theme-text-placeholder')
      ctx.font = uiCanvasFont('11px')
      ctx.textAlign = 'center'
      ctx.fillText(loadError ? 'Waveform unavailable' : 'Loading…', width / 2, height / 2)
      return
    }

    const cols = Math.floor(peaks.length / 3)
    drawEnvelope(ctx, peaks, 0, 0, width, height, 0, cols,
      tokenValue('--theme-text-muted'), tokenValue('--theme-text'))

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath(); ctx.moveTo(0, height / 2 + 0.5); ctx.lineTo(width, height / 2 + 0.5); ctx.stroke()

    const accent = tokenValue('--theme-accent') || '#33ced6'
    const xs = sampleToX(liveStart)
    const xe = sampleToX(liveEnd)

    // Loop band
    ctx.fillStyle = 'rgba(51,206,214,0.10)'
    ctx.fillRect(xs, 0, Math.max(0, xe - xs), height)

    // ── Crossfade zone (matches Sampler::processVoice clamps) ─────────────────
    if (crossfadeSamples > 0 && numSamples > 0) {
      const loopLen = Math.max(0, liveEnd - liveStart)
      let xf = Math.min(crossfadeSamples, Math.floor(loopLen / 2))
      xf = Math.min(xf, Math.max(0, liveEnd), Math.max(0, numSamples - liveStart))
      if (xf > 0) {
        const xfPx = (xf / viewLen) * width
        const foStartX = xe - xfPx           // fade-out zone [loopEnd-N, loopEnd]
        const effStartX = xs + xfPx           // effective wrap point (loopStart + N)
        ctx.save()
        ctx.fillStyle = 'rgba(255,160,60,0.16)'
        ctx.fillRect(foStartX, 0, xfPx, height)
        ctx.strokeStyle = 'rgba(255,160,60,0.55)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(foStartX, 0); ctx.lineTo(foStartX + xfPx, height)
        ctx.moveTo(foStartX, height); ctx.lineTo(foStartX + xfPx, 0)
        ctx.stroke()
        ctx.strokeStyle = accent
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(Math.round(effStartX) + 0.5, 0); ctx.lineTo(Math.round(effStartX) + 0.5, height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
      }
    }

    // Loop markers
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(Math.round(xs) + 0.5, 0); ctx.lineTo(Math.round(xs) + 0.5, height); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(Math.round(xe) + 0.5, 0); ctx.lineTo(Math.round(xe) + 0.5, height); ctx.stroke()
    ctx.fillStyle = accent
    ctx.fillRect(Math.round(xs) - 3, 0, 7, 6)
    ctx.fillRect(Math.round(xe) - 3, 0, 7, 6)
  }, [peaks, loadError, width, height, liveStart, liveEnd, crossfadeSamples,
      numSamples, viewStart, viewLen, sampleToX, themeEpoch])

  // ── Pointer interaction ──────────────────────────────────────────────────────
  const getLocalX = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return rect ? e.clientX - rect.left : 0
  }, [])

  const [cursor, setCursor] = useState('default')

  const handleMouseDown = useCallback((e) => {
    if (numSamples <= 0) return
    const x = getLocalX(e)
    const dStart = Math.abs(x - sampleToX(loopStart))
    const dEnd = Math.abs(x - sampleToX(loopEnd))
    if (dStart <= HANDLE_HIT || dEnd <= HANDLE_HIT) {
      e.preventDefault()
      dragRef.current = { handle: dStart <= dEnd ? 'start' : 'end' }
      setDrag({ start: loopStart, end: loopEnd })
      return
    }
    // Empty space → pan
    panRef.current = { x0: e.clientX, viewStart0: viewStart }
    e.preventDefault()
  }, [numSamples, getLocalX, sampleToX, loopStart, loopEnd, viewStart])

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (d) {
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return
        const val = xToSample(e.clientX - rect.left)
        setDrag((prev) => {
          if (!prev) return prev
          if (d.handle === 'start') return { start: Math.max(0, Math.min(val, prev.end - 1)), end: prev.end }
          return { start: prev.start, end: Math.min(numSamples, Math.max(val, prev.start + 1)) }
        })
        return
      }
      const p = panRef.current
      if (p) {
        const dxSamples = ((e.clientX - p.x0) / width) * viewLen
        let ns = Math.round(p.viewStart0 - dxSamples)
        ns = Math.max(0, Math.min(ns, numSamples - viewLen))
        onView?.({ start: ns, end: ns + viewLen })
      }
    }
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null
        setDrag((final) => {
          if (final) onCommitLoop?.({ loopStart: final.start, loopEnd: final.end })
          return null
        })
      }
      panRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [xToSample, onCommitLoop, numSamples, width, viewLen, onView])

  const handleMouseMove = useCallback((e) => {
    if (dragRef.current || panRef.current) return
    const x = getLocalX(e)
    if (Math.abs(x - sampleToX(loopStart)) <= HANDLE_HIT || Math.abs(x - sampleToX(loopEnd)) <= HANDLE_HIT) {
      setCursor('ew-resize')
    } else setCursor('grab')
  }, [getLocalX, sampleToX, loopStart, loopEnd])

  // Wheel-zoom around the cursor sample; clamped to [MIN_VIEW_SAMPLES, numSamples].
  const handleWheel = useCallback((e) => {
    if (numSamples <= 0) return
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const cursorSample = xToSample(e.clientX - rect.left)
    const factor = e.deltaY < 0 ? 0.8 : 1.25
    let nextLen = Math.round(viewLen * factor)
    nextLen = Math.max(MIN_VIEW_SAMPLES, Math.min(nextLen, numSamples))
    const frac = (cursorSample - viewStart) / viewLen
    let ns = Math.round(cursorSample - frac * nextLen)
    ns = Math.max(0, Math.min(ns, numSamples - nextLen))
    onView?.({ start: ns, end: ns + nextLen })
  }, [numSamples, xToSample, viewLen, viewStart, onView])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return undefined
    c.addEventListener('wheel', handleWheel, { passive: false })
    return () => c.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  return (
    <canvas
      ref={canvasRef}
      className="ll-waveform"
      style={{ cursor, display: 'block' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    />
  )
}

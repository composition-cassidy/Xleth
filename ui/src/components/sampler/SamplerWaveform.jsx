import { useRef, useEffect, useState, useCallback } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import { drawEnvelope, downsamplePeaks3 } from '../../utils/waveformRenderer.js'

const WAVE_COLOR = '#33CED6'
const LOOP_COLOR = '#69DB7C'
const HANDLE_HIT = 8

export default function SamplerWaveform({
  regionId, numSamples,
  loopEnabled, loopStart, loopEnd,
  onCommitLoopPoints,
  smpStart = 0, smpLength = 0, declickSamples = 64,
  fadeInMs = 0, fadeOutMs = 0, sampleRate = 48000,
  crossfadeSamples = 0,
  onCommitSmpPoints,
  width = 520, height = 100,
}) {
  const canvasRef = useRef(null)
  const [peaks, setPeaks] = useState(null)
  const [loadError, setLoadError] = useState(false)

  // Loop marker drag state
  const loopDragRef = useRef(null)
  const [loopDrag, setLoopDrag] = useState(null)

  // Trim marker drag state
  const smpDragRef = useRef(null)
  const [smpDrag, setSmpDrag] = useState(null)

  // Fetch peaks via mipmap binding (replaces Pipeline B getRegionWaveformPeaks)
  useEffect(() => {
    if (!regionId) {
      setLoadError(true)
      return
    }
    let cancelled = false
    setPeaks(null)
    setLoadError(false)

    async function fetchPeaks() {
      try {
        const data = await window.xleth?.waveform?.getRegionPeaks?.(regionId, 0, -1, width, -1)
        if (cancelled) return
        if (data && data.ready && data.peaks?.length > 0) {
          setPeaks(data.peaks)  // stride-3 [min,max,rms,...]
        } else if (data && !data.ready) {
          // Mipmap still generating — retry
          setTimeout(() => { if (!cancelled) fetchPeaks() }, 150)
        } else {
          setLoadError(true)
        }
      } catch { if (!cancelled) setLoadError(true) }
    }
    fetchPeaks()
    return () => { cancelled = true }
  }, [regionId, width])

  // Re-fetch when audio data changes (e.g. swap / future normalize / reverse)
  useEffect(() => {
    if (!regionId) return
    const onChanged = (e) => {
      if (e.detail?.regionId && e.detail.regionId !== regionId) return
      setPeaks(null)
      setLoadError(false)
      window.xleth?.waveform?.getRegionPeaks?.(regionId, 0, -1, width, -1)
        .then((data) => {
          if (data?.ready && data.peaks?.length > 0) setPeaks(data.peaks)
          else setLoadError(true)
        })
        .catch(() => setLoadError(true))
    }
    timelineEvents.addEventListener('timeline-sampler-changed', onChanged)
    return () => timelineEvents.removeEventListener('timeline-sampler-changed', onChanged)
  }, [regionId, width])

  // Render waveform + all markers
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width  = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = '#0a0a10'
    ctx.fillRect(0, 0, width, height)

    if (!peaks) {
      ctx.fillStyle = '#555566'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(loadError ? 'Waveform unavailable' : 'Loading…', width / 2, height / 2)
      return
    }

    // Waveform (envelope + RMS body via shared renderer)
    const ds   = downsamplePeaks3(peaks, width)
    const cols = Math.floor(ds.length / 3)
    const mid  = height / 2

    drawEnvelope(
      ctx, ds,
      0, 0, width, height,
      0, cols,
      'rgba(51, 206, 214, 0.35)',  // envelope fill
      'rgba(51, 206, 214, 0.55)',  // RMS body (brighter)
    )

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.moveTo(0, mid + 0.5)
    ctx.lineTo(width, mid + 0.5)
    ctx.stroke()

    // ── Trim markers (SMP START / LENGTH) ────────────────────────────────────
    if (numSamples > 0) {
      const liveSmpStart  = smpDrag?.start ?? smpStart
      const liveSmpLength = smpDrag != null ? (smpDrag.end - smpDrag.start) : smpLength
      const effectiveEnd  = liveSmpStart + (liveSmpLength > 0 ? liveSmpLength : numSamples - liveSmpStart)
      const xTrimStart    = (liveSmpStart / numSamples) * width
      const xTrimEnd      = (effectiveEnd  / numSamples) * width

      // Dim outside-trim zones
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
      if (xTrimStart > 0)     ctx.fillRect(0,        0, xTrimStart,       height)
      if (xTrimEnd   < width) ctx.fillRect(xTrimEnd, 0, width - xTrimEnd, height)

      // Active trim region highlight
      ctx.fillStyle = 'rgba(51, 206, 214, 0.07)'
      ctx.fillRect(xTrimStart, 0, Math.max(0, xTrimEnd - xTrimStart), height)

      // Declick fade overlays
      const fadeWidth = (declickSamples / numSamples) * width
      if (fadeWidth > 0.5) {
        const fadeInGrad = ctx.createLinearGradient(xTrimStart, 0, xTrimStart + fadeWidth, 0)
        fadeInGrad.addColorStop(0, 'rgba(0,0,0,0.35)')
        fadeInGrad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = fadeInGrad
        ctx.fillRect(xTrimStart, 0, fadeWidth, height)

        const fadeOutGrad = ctx.createLinearGradient(xTrimEnd - fadeWidth, 0, xTrimEnd, 0)
        fadeOutGrad.addColorStop(0, 'rgba(0,0,0,0)')
        fadeOutGrad.addColorStop(1, 'rgba(0,0,0,0.35)')
        ctx.fillStyle = fadeOutGrad
        ctx.fillRect(xTrimEnd - fadeWidth, 0, fadeWidth, height)
      }

      // User fade-in overlay (teal gradient)
      if (fadeInMs > 0 && sampleRate > 0) {
        const fiSamples = (fadeInMs / 1000) * sampleRate
        const fiPx = Math.min((fiSamples / numSamples) * width, xTrimEnd - xTrimStart)
        if (fiPx > 0.5) {
          const g = ctx.createLinearGradient(xTrimStart, 0, xTrimStart + fiPx, 0)
          g.addColorStop(0, 'rgba(51,206,214,0.30)')
          g.addColorStop(1, 'rgba(51,206,214,0)')
          ctx.fillStyle = g
          ctx.fillRect(xTrimStart, 0, fiPx, height)
        }
      }

      // User fade-out overlay (teal gradient)
      if (fadeOutMs > 0 && sampleRate > 0) {
        const foSamples = (fadeOutMs / 1000) * sampleRate
        const foPx = Math.min((foSamples / numSamples) * width, xTrimEnd - xTrimStart)
        if (foPx > 0.5) {
          const g = ctx.createLinearGradient(xTrimEnd - foPx, 0, xTrimEnd, 0)
          g.addColorStop(0, 'rgba(51,206,214,0)')
          g.addColorStop(1, 'rgba(51,206,214,0.30)')
          ctx.fillStyle = g
          ctx.fillRect(xTrimEnd - foPx, 0, foPx, height)
        }
      }

      // Trim START line
      ctx.strokeStyle = WAVE_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(Math.round(xTrimStart) + 0.5, 0)
      ctx.lineTo(Math.round(xTrimStart) + 0.5, height)
      ctx.stroke()

      // Trim END line
      ctx.beginPath()
      ctx.moveTo(Math.round(xTrimEnd) + 0.5, 0)
      ctx.lineTo(Math.round(xTrimEnd) + 0.5, height)
      ctx.stroke()

      // Small top-caps to identify start vs end
      ctx.fillStyle = WAVE_COLOR
      ctx.fillRect(Math.round(xTrimStart) - 3, 0, 7, 5)
      ctx.fillRect(Math.round(xTrimEnd)   - 3, 0, 7, 5)
    }

    // ── Loop markers ─────────────────────────────────────────────────────────
    if (loopEnabled && numSamples > 0) {
      const lsSamples = loopDrag?.start ?? loopStart
      const leSamples = loopDrag?.end   ?? loopEnd
      const xStart = (lsSamples / numSamples) * width
      const xEnd   = (leSamples / numSamples) * width

      // Translucent band
      ctx.fillStyle = 'rgba(105, 219, 124, 0.12)'
      ctx.fillRect(xStart, 0, Math.max(0, xEnd - xStart), height)

      // Start marker
      ctx.strokeStyle = LOOP_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(Math.round(xStart) + 0.5, 0)
      ctx.lineTo(Math.round(xStart) + 0.5, height)
      ctx.stroke()
      // End marker
      ctx.beginPath()
      ctx.moveTo(Math.round(xEnd) + 0.5, 0)
      ctx.lineTo(Math.round(xEnd) + 0.5, height)
      ctx.stroke()

      // ── Crossfade zone (FL-style) ─────────────────────────────────────────
      // Wrap is to (loopStart + N), so the first N samples of the loop are
      // "fade-in source" only. Show the effective-loop-start at loopStart+N
      // and an X-pattern over the fade-out region [loopEnd-N .. loopEnd].
      if (crossfadeSamples > 0) {
        const trimStart = smpDrag?.start ?? smpStart
        const trimEnd = (smpDrag != null ? smpDrag.end
          : (smpLength > 0 ? smpStart + smpLength : numSamples))
        const loopLen = Math.max(0, leSamples - lsSamples)
        let xfSrc = Math.min(crossfadeSamples, Math.floor(loopLen / 2))
        xfSrc = Math.min(xfSrc, Math.max(0, leSamples - trimStart))
        xfSrc = Math.min(xfSrc, Math.max(0, trimEnd - lsSamples))
        if (xfSrc > 0) {
          const xfPx = (xfSrc / numSamples) * width
          const aStartX = xEnd - xfPx                     // fade-out zone start
          const effStartX = xStart + xfPx                 // effective loop wrap point
          ctx.save()
          // Fade-out zone band + X pattern
          ctx.fillStyle = 'rgba(255,160,60,0.14)'
          ctx.fillRect(aStartX, 0, xfPx, height)
          ctx.strokeStyle = 'rgba(255,160,60,0.55)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(aStartX, 0);       ctx.lineTo(aStartX + xfPx, height)
          ctx.moveTo(aStartX, height);  ctx.lineTo(aStartX + xfPx, 0)
          ctx.stroke()
          // Effective wrap-point marker (dashed line at loopStart + N)
          ctx.strokeStyle = 'rgba(255,160,60,0.85)'
          ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.moveTo(Math.round(effStartX) + 0.5, 0)
          ctx.lineTo(Math.round(effStartX) + 0.5, height)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
        }
      }
    }
  }, [peaks, loadError, width, height,
      loopEnabled, loopStart, loopEnd, loopDrag,
      smpStart, smpLength, declickSamples, smpDrag,
      fadeInMs, fadeOutMs, sampleRate,
      crossfadeSamples,
      numSamples])

  // ── Shared helpers ──────────────────────────────────────────────────────────
  const getLocalX = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return e.clientX - rect.left
  }, [])

  const xToSample = useCallback((x) => {
    const clamped = Math.max(0, Math.min(width, x))
    return Math.round((clamped / width) * numSamples)
  }, [width, numSamples])

  // ── mouseDown: hit-test trim handles first, then loop handles ───────────────
  const handleMouseDown = useCallback((e) => {
    if (numSamples <= 0) return
    const x = getLocalX(e)

    // Trim handle hit-test
    const effectiveEnd  = smpStart + (smpLength > 0 ? smpLength : numSamples - smpStart)
    const xTrimStart    = (smpStart    / numSamples) * width
    const xTrimEnd      = (effectiveEnd / numSamples) * width

    if (Math.abs(x - xTrimStart) <= HANDLE_HIT) {
      e.preventDefault()
      smpDragRef.current = { handle: 'smpStart' }
      setSmpDrag({ start: smpStart, end: effectiveEnd })
      return
    }
    if (Math.abs(x - xTrimEnd) <= HANDLE_HIT) {
      e.preventDefault()
      smpDragRef.current = { handle: 'smpEnd' }
      setSmpDrag({ start: smpStart, end: effectiveEnd })
      return
    }

    // Loop handle hit-test
    if (!loopEnabled) return
    const xs = (loopStart / numSamples) * width
    const xe = (loopEnd   / numSamples) * width
    let handle = null
    if (Math.abs(x - xs) <= HANDLE_HIT) handle = 'start'
    else if (Math.abs(x - xe) <= HANDLE_HIT) handle = 'end'
    if (!handle) return
    e.preventDefault()
    loopDragRef.current = { handle }
    setLoopDrag({ start: loopStart, end: loopEnd })
  }, [numSamples, getLocalX, smpStart, smpLength, loopEnabled, loopStart, loopEnd, width])

  // ── Global mousemove / mouseup ───────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const x   = e.clientX - rect.left
      const val = Math.round(Math.max(0, Math.min(width, x)) / width * numSamples)

      // Trim drag
      const sd = smpDragRef.current
      if (sd) {
        setSmpDrag((prev) => {
          if (!prev) return prev
          if (sd.handle === 'smpStart') return { start: Math.min(val, prev.end - 1), end: prev.end }
          return { start: prev.start, end: Math.max(val, prev.start + 1) }
        })
        return
      }

      // Loop drag
      const ld = loopDragRef.current
      if (!ld) return
      setLoopDrag((prev) => {
        if (!prev) return prev
        if (ld.handle === 'start') return { ...prev, start: Math.min(val, prev.end - 1) }
        return { ...prev, end: Math.max(val, prev.start + 1) }
      })
    }

    const onUp = () => {
      if (smpDragRef.current) {
        smpDragRef.current = null
        setSmpDrag((final) => {
          if (final) onCommitSmpPoints?.({ smpStart: final.start, smpLength: final.end - final.start })
          return null
        })
        return
      }
      if (loopDragRef.current) {
        loopDragRef.current = null
        setLoopDrag((final) => {
          if (final) onCommitLoopPoints?.({ loopStart: final.start, loopEnd: final.end })
          return null
        })
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [xToSample, onCommitLoopPoints, onCommitSmpPoints, numSamples, width])

  // ── Cursor feedback ─────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState('default')
  const handleMouseMove = useCallback((e) => {
    if (numSamples <= 0) { setCursor('default'); return }
    const x = getLocalX(e)

    const effectiveEnd = smpStart + (smpLength > 0 ? smpLength : numSamples - smpStart)
    const xTrimStart   = (smpStart    / numSamples) * width
    const xTrimEnd     = (effectiveEnd / numSamples) * width
    if (Math.abs(x - xTrimStart) <= HANDLE_HIT || Math.abs(x - xTrimEnd) <= HANDLE_HIT) {
      setCursor('ew-resize'); return
    }

    if (loopEnabled) {
      const xs = (loopStart / numSamples) * width
      const xe = (loopEnd   / numSamples) * width
      if (Math.abs(x - xs) <= HANDLE_HIT || Math.abs(x - xe) <= HANDLE_HIT) {
        setCursor('ew-resize'); return
      }
    }
    setCursor('default')
  }, [numSamples, getLocalX, smpStart, smpLength, loopEnabled, loopStart, loopEnd, width])

  return (
    <canvas
      ref={canvasRef}
      style={{ cursor, display: 'block', borderRadius: 4, border: '1px solid #2A2A38' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    />
  )
}

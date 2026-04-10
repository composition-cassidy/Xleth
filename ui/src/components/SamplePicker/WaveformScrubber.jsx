import { useRef, useEffect, useState, useCallback } from 'react'
import { drawEnvelope, downsamplePeaks3 } from '../../utils/waveformRenderer.js'

// ── CSS variables mirrored as JS constants (must match app.css) ───────────────
const COLOR = {
  selection:  'rgba(51, 206, 214, 0.15)',
  selEdge:    '#33CED6',
  handle:     '#33CED6',
  playhead:   '#33CED6',
  playheadBg: 'rgba(51, 206, 214, 0.08)',
  text:       '#555566',
  error:      '#555566',
}

const HANDLE_W   = 2    // handle line width (px)
const HANDLE_HIT = 8    // hit-test radius (px)
const CANVAS_H   = 120
const MIN_VIEW_DUR = 0.5  // maximum zoom-in: 0.5 s visible
const SCROLL_H     = 5    // height of position-indicator strip (px)

function formatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00.00'
  const m   = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(Math.floor(sec)).padStart(2, '0')}.${String(Math.floor((sec % 1) * 100)).padStart(2, '0')}`
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Props:
 *   waveformData  – { peaks: number[], duration: number, pixelWidth: number } | null
 *   waveformError – boolean
 *   duration      – number (seconds, used when waveformData is pending)
 *   currentTime   – number
 *   inPoint       – number | null
 *   outPoint      – number | null
 *   onSeek        – (time: number) => void
 *   onInChange    – (time: number) => void
 *   onOutChange   – (time: number) => void
 *
 * Zoom/pan:
 *   Scroll wheel          → zoom in/out (centered on cursor)
 *   Shift + scroll wheel  → pan horizontally
 *   Horizontal trackpad   → pan horizontally
 *   Double-click          → reset zoom to full view
 */
export default function WaveformScrubber({
  filePath,
  waveformData,
  waveformError,
  duration,
  currentTime,
  inPoint,
  outPoint,
  onSeek,
  onInChange,
  onOutChange,
}) {
  const canvasRef    = useRef(null)
  const containerRef = useRef(null)
  const drag         = useRef(null)

  // ── View state (seconds) ──────────────────────────────────────────────────
  // viewEnd = null means "show full file" (resolved to `duration` at render time).
  // Both state (for reactive redraws) and refs (for fresh reads in wheel handler)
  // are kept in sync via applyView().
  const [viewStart, setViewStartState] = useState(0)
  const [viewEnd,   setViewEndState]   = useState(null)  // null = full duration

  const viewStartRef = useRef(0)
  const viewEndRef   = useRef(null)
  const durationRef  = useRef(duration)

  // Keep durationRef current whenever the prop changes
  useEffect(() => { durationRef.current = duration }, [duration])

  // Sync helper — mutates refs then schedules React state update
  function applyView(start, end) {
    viewStartRef.current = start
    viewEndRef.current   = end
    setViewStartState(start)
    setViewEndState(end)
  }

  // Resolve concrete view bounds from refs (safe to call in event handlers)
  function resolveView() {
    const d  = durationRef.current || duration
    const vS = Math.max(0, viewStartRef.current)
    const rawE = viewEndRef.current
    const vE = (rawE !== null && rawE <= d) ? rawE : d
    const vD = Math.max(0.001, vE - vS)
    return { vS, vE, vD }
  }

  // ── High-resolution region data for zoomed view ───────────────────────────
  const [regionData, setRegionData] = useState(null)
  const regionRequestId = useRef(0)
  const regionDebounceRef = useRef(null)

  useEffect(() => {
    if (regionDebounceRef.current) {
      clearTimeout(regionDebounceRef.current)
      regionDebounceRef.current = null
    }
    const d = duration
    if (!filePath || d <= 0) return

    const vS = Math.max(0, viewStart)
    const rawE = viewEnd
    const vE = (rawE !== null && rawE <= d) ? rawE : d
    const vD = vE - vS
    const isFullView = vD >= d - 0.01

    if (isFullView) {
      setRegionData(null)
      return
    }

    const requestId = ++regionRequestId.current
    regionDebounceRef.current = setTimeout(async () => {
      const canvas = canvasRef.current
      const pixelWidth = canvas ? canvas.width : 1400
      try {
        const raw = await window.xleth?.waveform?.getFilePeaks(filePath, vS, vE, pixelWidth, -1)
        if (regionRequestId.current === requestId && raw && raw.peaks?.length > 0) {
          const cols = Math.floor(raw.peaks.length / 3)
          setRegionData({ peaks: raw.peaks, startTime: vS, endTime: vE, pixelWidth: cols, stride: 3 })
        }
      } catch (e) {
        console.warn('[WaveformScrubber] Region fetch failed:', e)
      }
    }, 50)

    return () => {
      if (regionDebounceRef.current) {
        clearTimeout(regionDebounceRef.current)
        regionDebounceRef.current = null
      }
    }
  }, [filePath, duration, viewStart, viewEnd])

  // ── draw ───────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const W = canvas.width
    const H = canvas.height
    const ctx = canvas.getContext('2d')

    ctx.clearRect(0, 0, W, H)

    if (!waveformData || duration <= 0) {
      ctx.fillStyle    = COLOR.error
      ctx.font         = '500 12px "Hanken Grotesk", system-ui'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(waveformError ? 'Waveform unavailable' : 'Loading waveform…', W / 2, H / 2)
      return
    }

    // Resolve visible window (using state values captured in callback)
    const vS   = Math.max(0, viewStart)
    const rawE = viewEnd
    const vE   = (rawE !== null && rawE <= duration) ? rawE : duration
    const vD   = Math.max(0.001, vE - vS)
    const zoomed = vD < duration - 0.01

    // Reserve bottom strip for the scrollbar when zoomed
    const drawH = zoomed ? H - SCROLL_H - 1 : H
    const mid   = drawH / 2

    // Time → canvas-X mapping for the visible window
    const timeToX = (t) => ((t - vS) / vD) * W

    // ── Visible peaks (stride-3) — prefer high-res region data when available
    const stride = waveformData.stride || 3
    let peaks
    if (regionData && zoomed
        && Math.abs(regionData.startTime - vS) < 0.01
        && Math.abs(regionData.endTime - vE) < 0.01) {
      peaks = downsamplePeaks3(regionData.peaks, W)
    } else {
      const totalCols = Math.floor(waveformData.peaks.length / stride)
      const peakS     = Math.max(0,         Math.floor((vS / duration) * totalCols))
      const peakE     = Math.min(totalCols, Math.ceil( (vE / duration) * totalCols))
      const slice     = waveformData.peaks.slice(peakS * stride, peakE * stride)
      peaks = downsamplePeaks3(slice, W)
    }

    // ── Selection highlight ───────────────────────────────────────────────
    if (inPoint !== null && outPoint !== null) {
      const x1 = Math.max(0, timeToX(Math.min(inPoint, outPoint)))
      const x2 = Math.min(W, timeToX(Math.max(inPoint, outPoint)))
      if (x2 > x1) {
        ctx.fillStyle = COLOR.selection
        ctx.fillRect(x1, 0, x2 - x1, drawH)
      }
      // Edge lines (skip if fully off-screen)
      const ip = timeToX(Math.min(inPoint, outPoint))
      const op = timeToX(Math.max(inPoint, outPoint))
      ctx.strokeStyle = COLOR.selEdge
      ctx.lineWidth   = 1
      if (ip >= -1 && ip <= W + 1) {
        ctx.beginPath(); ctx.moveTo(ip, 0); ctx.lineTo(ip, drawH); ctx.stroke()
      }
      if (op >= -1 && op <= W + 1) {
        ctx.beginPath(); ctx.moveTo(op, 0); ctx.lineTo(op, drawH); ctx.stroke()
      }
    } else if (inPoint !== null) {
      const x = timeToX(inPoint)
      if (x >= -1 && x <= W + 1) {
        ctx.strokeStyle = COLOR.selEdge; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, drawH); ctx.stroke()
      }
    } else if (outPoint !== null) {
      const x = timeToX(outPoint)
      if (x >= -1 && x <= W + 1) {
        ctx.strokeStyle = COLOR.selEdge; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, drawH); ctx.stroke()
      }
    }

    // ── Waveform (envelope + RMS body via shared renderer) ─────────────────
    const cols = Math.floor(peaks.length / 3)
    if (cols > 0) {
      drawEnvelope(
        ctx, peaks,
        0, 0, W, drawH,
        0, cols,
        'rgba(51, 206, 214, 0.35)',   // envelope fill
        'rgba(51, 206, 214, 0.55)',   // RMS body (brighter)
      )

      // Thin center line
      ctx.strokeStyle = 'rgba(51, 206, 214, 0.15)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(W, mid)
      ctx.stroke()
    }

    // ── Playhead ──────────────────────────────────────────────────────────
    const px = timeToX(currentTime)
    if (px >= 0 && px <= W) {
      ctx.fillStyle = COLOR.playheadBg
      ctx.fillRect(px - 1, 0, 3, drawH)
      ctx.strokeStyle = COLOR.playhead
      ctx.lineWidth   = 2
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, drawH); ctx.stroke()
    }

    // ── Handle tabs ───────────────────────────────────────────────────────
    function drawHandle(time, color) {
      const x = timeToX(time)
      if (x < -20 || x > W + 20) return  // fully off-screen, skip
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = HANDLE_W
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, drawH); ctx.stroke()
      // Top triangle
      ctx.beginPath()
      ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x, 10)
      ctx.closePath(); ctx.fill()
      // Bottom triangle
      ctx.beginPath()
      ctx.moveTo(x - 6, drawH); ctx.lineTo(x + 6, drawH); ctx.lineTo(x, drawH - 10)
      ctx.closePath(); ctx.fill()
    }
    if (inPoint  !== null) drawHandle(inPoint,  '#33CED6')
    if (outPoint !== null) drawHandle(outPoint, '#33CED6')

    // ── Time labels ───────────────────────────────────────────────────────
    ctx.font         = '500 10px "Hanken Grotesk", system-ui'
    ctx.fillStyle    = COLOR.text
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign    = 'left'

    function timeLabel(time, hAlign) {
      const x = timeToX(time)
      if (x < -60 || x > W + 60) return
      const txt      = formatTime(time)
      const measured = ctx.measureText(txt).width
      let lx = hAlign === 'left'  ? x + 4
             : hAlign === 'right' ? x - measured - 4
             :                      x - measured / 2
      lx = Math.max(2, Math.min(lx, W - measured - 2))
      ctx.fillText(txt, lx, drawH - 4)
    }

    if (inPoint  !== null) timeLabel(inPoint,  'right')
    if (outPoint !== null) timeLabel(outPoint, 'left')
    timeLabel(currentTime, 'center')

    // ── Zoom indicator (top-right corner) ─────────────────────────────────
    if (zoomed) {
      const factor = duration / vD
      ctx.font         = '500 10px "Hanken Grotesk", system-ui'
      ctx.fillStyle    = COLOR.handle
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'top'
      ctx.fillText(`${factor.toFixed(1)}×`, W - 4, 4)
    }

    // ── Position indicator / scrollbar ────────────────────────────────────
    if (zoomed) {
      const barY  = H - SCROLL_H
      ctx.fillStyle = 'rgba(255,255,255,0.07)'
      ctx.fillRect(0, barY, W, SCROLL_H)
      const thumbX = (vS / duration) * W
      const thumbW = Math.max(8, (vD / duration) * W)
      ctx.fillStyle = 'rgba(51,206,214,0.45)'
      ctx.fillRect(thumbX, barY, thumbW, SCROLL_H)
    }
  }, [waveformData, waveformError, duration, currentTime, inPoint, outPoint, viewStart, viewEnd, regionData])

  // Redraw whenever any dep changes
  useEffect(() => { draw() }, [draw])

  // ── ResizeObserver — update canvas pixel width and redraw ─────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0 && canvasRef.current) {
        canvasRef.current.width  = w
        canvasRef.current.height = CANVAS_H
        draw()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw])

  // ── Wheel handler ─────────────────────────────────────────────────────────
  // Must be registered as non-passive to call e.preventDefault() (blocks page scroll).
  // Reads exclusively from refs so the empty-dep effect is always fresh.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function handleWheel(e) {
      e.preventDefault()
      const d = durationRef.current
      if (d <= 0) return

      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()

      const { vS, vD } = resolveView()

      // ── Shift + vertical scroll → horizontal pan ───────────────────────
      if (e.shiftKey && e.deltaY !== 0) {
        const panSec = (e.deltaY / rect.width) * vD * 3
        const newS   = Math.max(0, Math.min(d - vD, vS + panSec))
        applyView(newS, Math.min(d, newS + vD))
        return
      }

      // ── Horizontal scroll (trackpad) → pan ────────────────────────────
      if (e.deltaX !== 0) {
        const panSec = (e.deltaX / rect.width) * vD * 1.5
        const newS   = Math.max(0, Math.min(d - vD, vS + panSec))
        applyView(newS, Math.min(d, newS + vD))
        return
      }

      // ── Vertical scroll → zoom centered on cursor ──────────────────────
      if (e.deltaY !== 0) {
        const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const mouseTime  = vS + mouseRatio * vD

        // deltaY > 0 = scroll down = zoom out; < 0 = scroll up = zoom in
        const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25
        const newVD  = Math.max(MIN_VIEW_DUR, Math.min(d, vD * factor))

        // Keep the time under the cursor fixed
        let newS = mouseTime - mouseRatio * newVD
        let newE = newS + newVD

        // Clamp to file bounds
        if (newS < 0)  { newS = 0;      newE = newVD }
        if (newE > d)  { newE = d;      newS = Math.max(0, d - newVD) }

        // When back at full view, use null (canonical "no zoom" state)
        const isFullView = newS <= 0.001 && newE >= d - 0.001
        applyView(newS, isFullView ? null : newE)
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])  // Empty deps — all reads go through refs; setters are stable

  // ── Double-click → reset to full view ─────────────────────────────────────
  const onDoubleClick = useCallback(() => {
    applyView(0, null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Mouse helpers (use refs so they're always current) ────────────────────
  function pxToTime(clientX) {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const d = durationRef.current || duration
    if (d <= 0) return 0
    const rect       = canvas.getBoundingClientRect()
    const { vS, vD } = resolveView()
    return Math.max(0, Math.min(vS + ((clientX - rect.left) / rect.width) * vD, d))
  }

  function hitHandle(clientX, time) {
    if (time === null) return false
    const canvas = canvasRef.current
    if (!canvas) return false
    const d = durationRef.current
    if (d <= 0) return false
    const rect       = canvas.getBoundingClientRect()
    const { vS, vD } = resolveView()
    const hPx = ((time - vS) / vD) * rect.width + rect.left
    return Math.abs(clientX - hPx) <= HANDLE_HIT
  }

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    if (hitHandle(e.clientX, inPoint))  { drag.current = 'in';  return }
    if (hitHandle(e.clientX, outPoint)) { drag.current = 'out'; return }
    drag.current = 'seek'
    onSeek(pxToTime(e.clientX))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPoint, outPoint, onSeek])

  const onMouseMove = useCallback((e) => {
    if (!drag.current) return
    const t = pxToTime(e.clientX)
    if (drag.current === 'seek') onSeek(t)
    if (drag.current === 'in')   onInChange(t)
    if (drag.current === 'out')  onOutChange(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSeek, onInChange, onOutChange])

  const onMouseUp = useCallback(() => { drag.current = null }, [])

  // ── Scrollbar drag (horizontal pan) ────────────────────────────────────────
  const scrollbarRef      = useRef(null)
  const scrollDragging    = useRef(false)
  const scrollDragStartX  = useRef(0)
  const scrollDragStartVS = useRef(0)

  const onScrollbarDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    scrollDragging.current    = true
    scrollDragStartX.current  = e.clientX
    scrollDragStartVS.current = viewStartRef.current
    document.body.style.cursor     = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    function onMove(e) {
      if (!scrollDragging.current) return
      const track = scrollbarRef.current
      if (!track) return
      const d  = durationRef.current || duration
      const { vD } = resolveView()
      const dx = e.clientX - scrollDragStartX.current
      const secDelta = (dx / track.clientWidth) * d
      const newS = Math.max(0, Math.min(d - vD, scrollDragStartVS.current + secDelta))
      applyView(newS, Math.min(d, newS + vD))
    }
    function onUp() {
      if (!scrollDragging.current) return
      scrollDragging.current = false
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration])

  // Click on scrollbar track (not thumb) → jump to that position
  const onScrollbarTrackClick = useCallback((e) => {
    if (e.target.classList.contains('waveform-scrollbar-thumb')) return
    const track = scrollbarRef.current
    if (!track) return
    const d  = durationRef.current || duration
    const { vD } = resolveView()
    const rect = track.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const newS = Math.max(0, Math.min(d - vD, fraction * d - vD / 2))
    applyView(newS, Math.min(d, newS + vD))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration])

  // Scrollbar visibility and thumb metrics
  const d = durationRef.current || duration
  const { vS: scrollVS, vD: scrollVD } = resolveView()
  const isZoomed = d > 0 && scrollVD < d - 0.01
  const thumbLeft  = d > 0 ? (scrollVS / d) * 100 : 0
  const thumbWidth = d > 0 ? Math.max(3, (scrollVD / d) * 100) : 100

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="waveform-scrubber"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={onDoubleClick}
      title="Scroll to zoom · Drag scrollbar to pan · Double-click to reset"
    >
      <canvas
        ref={canvasRef}
        className="waveform-canvas"
        height={CANVAS_H}
      />
      {isZoomed && (
        <div
          ref={scrollbarRef}
          className="waveform-scrollbar"
          onClick={onScrollbarTrackClick}
        >
          <div
            className="waveform-scrollbar-thumb"
            style={{ left: `${thumbLeft}%`, width: `${thumbWidth}%` }}
            onMouseDown={onScrollbarDown}
          />
        </div>
      )}
    </div>
  )
}

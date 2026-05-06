import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { drawRuler, resolveTimelinePalette } from './timelineDrawing.js'
import { RULER_HEIGHT, pixelToBeat } from '../../constants/timeline.js'
import { playheadClock } from '../../services/PlayheadClock.js'

/**
 * Canvas-based ruler showing bar/beat numbers. Click to seek.
 *
 * Props:
 *   pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef, onSeek(beat), onWheel(e)
 *
 * Imperative: redraw()
 */
const TimelineRuler = forwardRef(function TimelineRuler(
  { pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef, onSeek, onWheel },
  ref
) {
  const containerRef = useRef(null)
  const bgCanvasRef = useRef(null)   // ruler background (ticks, numbers)
  const playheadRef = useRef(null)   // DOM playhead indicator
  const sizeRef = useRef({ w: 0 })

  function applySize(canvas, w, h, dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${RULER_HEIGHT}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function redraw() {
    const w = sizeRef.current.w
    if (w === 0) return
    const dpr = window.devicePixelRatio || 1

    const bgCtx = bgCanvasRef.current?.getContext('2d')
    if (bgCtx) {
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const palette = resolveTimelinePalette()
      drawRuler(bgCtx, w, RULER_HEIGHT, scrollOffsetRef.current, pixelsPerBeatRef.current, palette)
    }
  }

  function positionPlayhead(beat) {
    const el = playheadRef.current
    if (!el) return
    const px = (beat - scrollOffsetRef.current) * pixelsPerBeatRef.current
    const w = sizeRef.current.w || 9999
    if (px >= -2 && px <= w) {
      el.style.transform = `translateX(${px}px)`
      el.style.opacity = '1'
    } else {
      el.style.opacity = '0'
    }
  }

  function redrawOverlay() {
    positionPlayhead(playheadBeatRef.current)
  }

  useImperativeHandle(ref, () => ({ redraw, redrawOverlay }), [])

  // ── ResizeObserver ─────────────────────────────────────────────────────────

  function sizeAndDraw(container) {
    const w = Math.floor(container.clientWidth)
    if (w === 0 || w === sizeRef.current.w) return
    sizeRef.current = { w }
    const dpr = window.devicePixelRatio || 1
    if (bgCanvasRef.current) applySize(bgCanvasRef.current, w, RULER_HEIGHT, dpr)
    redraw()
    positionPlayhead(playheadBeatRef.current)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    sizeAndDraw(container)
    const timerId = setTimeout(() => sizeAndDraw(container), 50)
    const observer = new ResizeObserver(() => sizeAndDraw(container))
    observer.observe(container)
    return () => { clearTimeout(timerId); observer.disconnect() }
  }, [])

  // ── Click to seek ──────────────────────────────────────────────────────────

  function handleMouseDown(e) {
    if (e.button !== 0) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const beat = pixelToBeat(x, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const snapped = Math.max(0, Math.round(beat * 4) / 4) // snap to 16th
    console.log(`[Timeline] Seek to beat ${snapped.toFixed(2)} via ruler`)
    if (onSeek) onSeek(snapped)
  }

  // ── Wheel handler (non-passive) ────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el || !onWheel) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // ── PlayheadClock 60fps playhead animation (DOM element) ──────────────────

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs, bpm) => {
      const beat = posMs * bpm / 60000
      positionPlayhead(beat)
    })
    return unsub
  }, [])

  return (
    <div
      ref={containerRef}
      className="timeline-ruler-container"
      onMouseDown={handleMouseDown}
    >
      <canvas ref={bgCanvasRef} className="timeline-ruler-canvas" />
      <div
        ref={playheadRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '2px',
          height: '100%',
          backgroundColor: 'var(--theme-border-focus)',
          pointerEvents: 'none',
          zIndex: 10,
          willChange: 'transform',
          transform: 'translateX(-10px)',
        }}
      />
    </div>
  )
})

export default TimelineRuler

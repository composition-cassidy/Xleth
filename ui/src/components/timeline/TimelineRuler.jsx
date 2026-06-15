import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { drawRuler, resolveTimelinePalette } from './timelineDrawing.js'
import { RULER_HEIGHT, pixelToBeat, snapBeatToGrid, beatToPlayheadPixel, beatToPixel } from '../../constants/timeline.js'
import { playheadClock } from '../../services/PlayheadClock.js'

const PLAYHEAD_LINE_WIDTH = 1

/**
 * Canvas-based ruler showing bar/beat numbers. Click to seek.
 *
 * Props: pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef, onSeek(beat),
 * snapGranularity, onWheel(e)
 *
 * Imperative: redraw()
 */
const TimelineRuler = forwardRef(function TimelineRuler(
  { pixelsPerBeatRef, scrollOffsetRef, playheadBeatRef, onSeek, snapGranularity = '1/16', onWheel },
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
    const rawPx = beatToPixel(beat, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const px = beatToPlayheadPixel(beat, scrollOffsetRef.current, pixelsPerBeatRef.current, PLAYHEAD_LINE_WIDTH)
    const w = sizeRef.current.w || 9999
    if (rawPx >= -PLAYHEAD_LINE_WIDTH && rawPx <= w + PLAYHEAD_LINE_WIDTH) {
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

  function seekFromEvent(e, phase) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const beat = pixelToBeat(x, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const modifiers = { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
    const snapped = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)
    if (phase === 'commit') {
      console.log(`[Timeline] Seek to beat ${snapped.toFixed(2)} via ruler (snap=${snapGranularity})`)
    }
    if (onSeek) onSeek(snapped, { phase })
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    seekFromEvent(e, 'move')

    const onWindowMove = (me) => {
      seekFromEvent(me, 'move')
    }
    const onWindowUp = (me) => {
      seekFromEvent(me, 'commit')
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
    }
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
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
    const unsub = playheadClock.onFrame((posMs, bpm, positionBeats) => {
      const beat = Number.isFinite(positionBeats) ? positionBeats : posMs * bpm / 60000
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
          width: `${PLAYHEAD_LINE_WIDTH}px`,
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

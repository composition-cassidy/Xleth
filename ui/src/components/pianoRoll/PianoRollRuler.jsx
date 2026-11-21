import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { ticksToBeats, PPQ } from '../../constants/timeline.js'
import { snapTicksOf } from './pianoRollEdits.js'
import { rulerMarks } from './pianoRollGeometry.js'
import { readPianoRollPalette, uiFont } from './pianoRollPalette.js'
import styles from './PianoRoll.module.css'

// Bar ruler, one canvas. Marks come from rulerMarks() with the same
// (pixelsPerBeat, scrollX) the grid uses, read from the animator's per-frame
// refs, so labels move with the grid during an eased zoom or scroll instead of
// snapping ~100ms after it. Bars are labelled 1, 2, 3 (thinned when they would
// collide); beats "1.2" only when there is room. Past the pattern end the ruler
// is ground-coloured with the same ink-2 end line as the grid.

export function drawRuler(ctx, { width, height, pixelsPerBeat, scrollX, patternLenBeats, palette, timeSel = null }) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = palette.g2
  ctx.fillRect(0, 0, width, height)
  const endX = patternLenBeats > 0 ? patternLenBeats * pixelsPerBeat - scrollX : Infinity
  if (endX < width) {
    ctx.fillStyle = palette.g0
    ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height)
  }
  if (timeSel && timeSel.end > timeSel.start) {
    const x0 = ticksToBeats(timeSel.start) * pixelsPerBeat - scrollX
    const x1 = ticksToBeats(timeSel.end) * pixelsPerBeat - scrollX
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.fillStyle = palette.select
    ctx.fillRect(x0, 0, x1 - x0, height)
    ctx.restore()
  }
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  for (const m of rulerMarks(pixelsPerBeat, scrollX, width)) {
    const x = Math.round(m.x) + 0.5
    const bar = m.kind === 'bar'
    ctx.fillStyle = bar ? palette.boundary : palette.g4
    const tickH = bar ? 8 : 4
    ctx.fillRect(Math.round(m.x), height - tickH, 1, tickH)
    if (m.label) {
      ctx.font = uiFont(palette, bar ? 11 : 10, bar ? 600 : 500)
      ctx.fillStyle = bar ? palette.ink2 : palette.ink3
      ctx.fillText(m.label, x + 3, bar ? 14 : 13)
    }
  }
  if (endX >= 0 && endX < width) {
    ctx.fillStyle = palette.ink2
    ctx.fillRect(Math.round(endX), 0, 1, height)
  }
}

const PianoRollRuler = forwardRef(function PianoRollRuler({
  pixelsPerBeatRef, scrollXRef, width, height, patternLengthTicks = 0,
  timeSel = null, snap = '1/16', onTimeSelect,
}, ref) {
  const epoch = useThemeEpoch()
  const canvasRef = useRef(null)
  const propsRef = useRef({ width, height, patternLengthTicks, timeSel, snap, onTimeSelect })
  propsRef.current = { width, height, patternLengthTicks, timeSel, snap, onTimeSelect }

  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext?.('2d')
    if (!ctx) return
    const { width: w, height: h, patternLengthTicks: len, timeSel: ts } = propsRef.current
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawRuler(ctx, {
      width: w,
      height: h,
      pixelsPerBeat: pixelsPerBeatRef?.current || 0,
      scrollX: scrollXRef?.current || 0,
      patternLenBeats: ticksToBeats(len || 0),
      palette: readPianoRollPalette(),
      timeSel: ts,
    })
  }, [pixelsPerBeatRef, scrollXRef])

  useLayoutEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(width * dpr))
    c.height = Math.max(1, Math.round(height * dpr))
    draw()
  }, [width, height, epoch, patternLengthTicks, timeSel, draw])

  useImperativeHandle(ref, () => ({ applyView: draw }), [draw])

  // FL time selection: Ctrl+click or double-click the ruler, then drag.
  // Snapped to the Snap select (Alt: free). A click without a drag selects
  // one snap step.
  const tickAt = (clientX, alt) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const exact = ((clientX - rect.left + (scrollXRef?.current || 0)) / Math.max(1e-6, pixelsPerBeatRef?.current || 1)) * PPQ
    if (alt) return Math.max(0, Math.round(exact))
    const step = snapTicksOf(propsRef.current.snap)
    return Math.max(0, Math.round(exact / step) * step)
  }
  const onMouseDown = (e) => {
    if (e.button !== 0) return
    if (!(e.ctrlKey || e.metaKey) && e.detail < 2) return
    const select = propsRef.current.onTimeSelect
    if (!select) return
    e.preventDefault()
    const step = snapTicksOf(propsRef.current.snap)
    const anchor = e.altKey ? tickAt(e.clientX, true) : Math.floor(tickAt(e.clientX, true) / step) * step
    const apply = (clientX, alt) => {
      const t = tickAt(clientX, alt)
      const start = Math.min(anchor, t)
      let end = Math.max(anchor, t)
      if (end <= start) end = start + (alt ? 1 : step)
      select({ start, end })
    }
    apply(e.clientX, e.altKey)
    const move = (ev) => apply(ev.clientX, ev.altKey)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <canvas
      ref={canvasRef}
      className={`piano-roll-ruler ${styles.layer}`}
      role="img"
      aria-label="Bar ruler"
      onMouseDown={onMouseDown}
      data-hint="Ruler"
      data-hint-mods="Ctrl+drag or double-click and drag: select time"
    />
  )
})

export default PianoRollRuler

import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { ticksToBeats } from '../../constants/timeline.js'
import { rulerMarks } from './pianoRollGeometry.js'
import { readPianoRollPalette, uiFont } from './pianoRollPalette.js'
import styles from './PianoRoll.module.css'

// Bar ruler, one canvas. Marks come from rulerMarks() with the same
// (pixelsPerBeat, scrollX) the grid uses, read from the animator's per-frame
// refs, so labels move with the grid during an eased zoom or scroll instead of
// snapping ~100ms after it. Bars are labelled 1, 2, 3 (thinned when they would
// collide); beats "1.2" only when there is room. Past the pattern end the ruler
// is ground-coloured with the same ink-2 end line as the grid.

export function drawRuler(ctx, { width, height, pixelsPerBeat, scrollX, patternLenBeats, palette }) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = palette.g2
  ctx.fillRect(0, 0, width, height)
  const endX = patternLenBeats > 0 ? patternLenBeats * pixelsPerBeat - scrollX : Infinity
  if (endX < width) {
    ctx.fillStyle = palette.g0
    ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height)
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
}, ref) {
  const epoch = useThemeEpoch()
  const canvasRef = useRef(null)
  const propsRef = useRef({ width, height, patternLengthTicks })
  propsRef.current = { width, height, patternLengthTicks }

  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext?.('2d')
    if (!ctx) return
    const { width: w, height: h, patternLengthTicks: len } = propsRef.current
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawRuler(ctx, {
      width: w,
      height: h,
      pixelsPerBeat: pixelsPerBeatRef?.current || 0,
      scrollX: scrollXRef?.current || 0,
      patternLenBeats: ticksToBeats(len || 0),
      palette: readPianoRollPalette(),
    })
  }, [pixelsPerBeatRef, scrollXRef])

  useLayoutEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(width * dpr))
    c.height = Math.max(1, Math.round(height * dpr))
    draw()
  }, [width, height, epoch, patternLengthTicks, draw])

  useImperativeHandle(ref, () => ({ applyView: draw }), [draw])

  return (
    <canvas
      ref={canvasRef}
      className={`piano-roll-ruler ${styles.layer}`}
      role="img"
      aria-label="Bar ruler"
    />
  )
})

export default PianoRollRuler

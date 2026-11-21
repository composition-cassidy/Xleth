import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  PITCH_MIN, PITCH_MAX, NUM_PITCHES, isBlackKey, pitchLabel, pitchAtY, visibleRows,
} from './pianoRollGeometry.js'
import { readPianoRollPalette, uiFont } from './pianoRollPalette.js'
import styles from './PianoRoll.module.css'

// The keyboard is ONE canvas (it used to be 120 inline-styled divs). Its rows
// come from the same rowY() the grid uses, so a key always sits on its pitch's
// row. Vertical placement is a pure function of the per-frame
// (pixelsPerSemitone, scrollY) the view animator eases, so it redraws from
// applyView() on every animator frame, never from settled React state.
//
// Keys are neutral: white keys in secondary ink, black keys in the panel grey
// at 62 % width. Every C is labelled; the hovered key is labelled too. A pitch
// that has notes in the pattern gets a value-colour tick in the 3px gutter at
// the key's right edge (information, not a tint over the whole key).

const BLACK_KEY_FRACTION = 0.62
const GUTTER_PX = 3

export function drawKeyboard(ctx, {
  width, height, pixelsPerSemitone: pps, scrollY, palette, hoverPitch = null, pressedPitch = null, usedPitches = null,
}) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = palette.g0
  ctx.fillRect(0, 0, width, height)
  const keyW = Math.max(0, width - GUTTER_PX)
  const blackW = Math.round(keyW * BLACK_KEY_FRACTION)
  const rows = visibleRows(pps, scrollY, height)
  const labelPx = pps >= 14 ? 11 : 10
  const showLabels = pps >= 10

  for (const { pitch, y, black } of rows) {
    const isPressed = pressedPitch === pitch
    const isHover = hoverPitch === pitch
    // The white-key surface runs under every row; a black key is a shorter bar on top.
    ctx.fillStyle = (!black && (isPressed || isHover)) ? palette.ink : palette.ink2
    ctx.fillRect(0, y, keyW, pps)
    if (black) {
      ctx.fillStyle = isPressed ? palette.g4 : (isHover ? palette.g3 : palette.g1)
      ctx.fillRect(0, y, blackW, pps)
    } else if (!isBlackKey(pitch - 1) && pitch > PITCH_MIN) {
      // E|F and B|C: two white keys meet directly.
      ctx.fillStyle = palette.g4
      ctx.fillRect(0, Math.round(y + pps) - 1, keyW, 1)
    }
    if (usedPitches?.has(pitch)) {
      ctx.fillStyle = palette.value
      ctx.fillRect(keyW + 1, y + 1, GUTTER_PX - 1, Math.max(1, pps - 2))
    }
    const isC = (((pitch % 12) + 12) % 12) === 0
    if (showLabels && (isC || isHover || isPressed)) {
      ctx.font = uiFont(palette, labelPx, isC ? 600 : 500)
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'right'
      // Labels sit in the white area at the right; on ink-2 the g1 text is 8.3:1.
      ctx.fillStyle = palette.g1
      ctx.fillText(pitchLabel(pitch), keyW - 4, y + pps / 2 + 0.5)
      ctx.textAlign = 'left'
    }
  }
}

const PianoRollKeyboard = forwardRef(function PianoRollKeyboard({
  pixelsPerSemitoneRef, scrollYRef, height,
  onPreviewNote, highlightedPitches, onSelectPitchRange,
}, ref) {
  const epoch = useThemeEpoch()
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [width, setWidth] = useState(53)
  const sizeRef = useRef({ w: 53, h: height })
  sizeRef.current = { w: width, h: height }
  const usedRef = useRef(highlightedPitches)
  usedRef.current = highlightedPitches
  const hoverRef = useRef(null)
  const pressedRef = useRef(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 53))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const draw = useCallback(() => {
    const c = canvasRef.current
    const ctx = c?.getContext?.('2d')
    if (!ctx) return
    const { w, h } = sizeRef.current
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawKeyboard(ctx, {
      width: w,
      height: h,
      pixelsPerSemitone: pixelsPerSemitoneRef?.current || 14,
      scrollY: scrollYRef?.current || 0,
      palette: readPianoRollPalette(),
      hoverPitch: hoverRef.current,
      pressedPitch: pressedRef.current,
      usedPitches: usedRef.current,
    })
  }, [pixelsPerSemitoneRef, scrollYRef])

  useLayoutEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(width * dpr))
    c.height = Math.max(1, Math.round(height * dpr))
    draw()
  }, [width, height, epoch, draw])

  // A render can change the used-pitch set; redraw after every one.
  useLayoutEffect(() => { draw() })

  useImperativeHandle(ref, () => ({ applyView: draw }), [draw])

  const pitchFromEvent = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return pitchAtY(e.clientY - rect.top, pixelsPerSemitoneRef?.current || 14, scrollYRef?.current || 0)
  }

  const onPointerMove = (e) => {
    const p = pitchFromEvent(e)
    if (p !== hoverRef.current) { hoverRef.current = p; draw() }
  }
  const onPointerLeave = () => {
    if (hoverRef.current != null) { hoverRef.current = null; draw() }
  }
  const onMouseDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const p = pitchFromEvent(e)
    if (p == null) return
    // Ctrl+click: select every note of this pitch; drag for a pitch range;
    // Ctrl+Shift adds to the selection. No audition on a select gesture.
    if ((e.ctrlKey || e.metaKey) && onSelectPitchRange) {
      const additive = e.shiftKey
      let last = p
      onSelectPitchRange(p, p, additive)
      const move = (ev) => {
        const q = pitchFromEvent(ev)
        if (q == null || q === last) return
        last = q
        onSelectPitchRange(p, q, additive)
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }
    pressedRef.current = p
    draw()
    const release = () => {
      window.removeEventListener('mouseup', release)
      pressedRef.current = null
      draw()
    }
    window.addEventListener('mouseup', release)
    onPreviewNote?.(p)
  }

  return (
    <div
      ref={wrapRef}
      className={`piano-roll-keyboard ${styles.keyboard}`}
      data-hint="Keyboard"
      data-hint-mods="Press a key: hear the note · Ctrl+click: select that pitch · Ctrl+drag: a pitch range"
    >
      <canvas
        ref={canvasRef}
        className={styles.layer}
        role="img"
        aria-label="Piano keyboard"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onMouseDown={onMouseDown}
      />
    </div>
  )
})

export default PianoRollKeyboard

export { PITCH_MIN, PITCH_MAX, NUM_PITCHES, isBlackKey, pitchLabel }

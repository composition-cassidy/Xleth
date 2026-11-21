import { useCallback, useEffect, useRef } from 'react'
import { NumberBox } from '../../ui-kit'
import { backingSize, getDpr, useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import styles from './colorGrade.module.css'

// One tonal range of a Color Grade: a colour wheel that tints the range, and a
// luminance control that makes it brighter or darker.
//
// The wheel is a chroma pad with the same axes as the engine (and as the
// vectorscope beside it): right is blue, left is yellow, up is red, down is
// cyan. The centre is "no tint". Dragging tints without changing brightness;
// the luminance box changes brightness without tinting.
//
// Gestures follow the kit's value grammar, on two axes:
//   drag            move the puck (relative, so a click never jumps it)
//   Shift+drag      fine
//   Ctrl+click      back to the centre
//   arrow keys      nudge (Shift x10)
//   Escape          cancel the drag
// The whole gesture is one preview stream and one commit.

const DRAG_GAIN = 1 / 110      // wheel units per CSS pixel
const FINE = 0.1
const NUDGE = 0.01

// What a direction on the wheel is called, for the readout under it.
const HUES = [
  { name: 'Blue', a: 0 },
  { name: 'Magenta', a: 60 },
  { name: 'Red', a: 105 },
  { name: 'Yellow', a: 180 },
  { name: 'Green', a: 240 },
  { name: 'Cyan', a: 285 },
]

/** "Blue 12 %" for a wheel position, or "No tint" at the centre. */
export function describeWheel(x, y) {
  const r = Math.hypot(x, y)
  if (r < 0.005) return 'No tint'
  let deg = (Math.atan2(y, x) * 180) / Math.PI
  if (deg < 0) deg += 360
  let best = HUES[0]
  let bestD = 999
  for (const h of HUES) {
    const d = Math.min(Math.abs(deg - h.a), 360 - Math.abs(deg - h.a))
    if (d < bestD) { bestD = d; best = h }
  }
  return `${best.name} ${Math.round(Math.min(1, r) * 100)} %`
}

// The colour a direction tints towards: a unit chroma offset on mid grey,
// through the same Rec.709 matrix the engine uses.
function directionColour(cos, sin, strength = 0.42) {
  const r = 0.5 + strength * 1.5748 * sin
  const g = 0.5 + strength * (-0.1873 * cos - 0.4681 * sin)
  const b = 0.5 + strength * 1.8556 * cos
  const c = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  return `rgb(${c(r)},${c(g)},${c(b)})`
}

function readColours(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    panel: get('--ui-g1', '#1E1E1E'),
    grid: get('--ui-g4', '#3A3A3A'),
    boundary: get('--ui-boundary', '#747474'),
    ink: get('--ui-ink', '#E6E6E6'),
  }
}

function clampDisc(x, y) {
  const r = Math.hypot(x, y)
  return r > 1 ? [x / r, y / r] : [x, y]
}

const round3 = (v) => Math.round(v * 1000) / 1000
const lumFormat = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}`
const lumParse = (text) => {
  const n = Number(String(text).replace('−', '-').replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(n) ? n / 100 : null
}

/**
 * @param {object} props
 * @param {string} props.name       the technical name ("Lift")
 * @param {string} props.plain      what it means ("Shadows")
 * @param {{x:number,y:number,lum:number}} props.value
 * @param {(w:object)=>void} props.onPreview  live, during a gesture
 * @param {(w:object)=>void} props.onCommit   once per gesture (the undo step)
 * @param {()=>void} props.onCancel
 * @param {string} props.hint
 * @param {boolean} [props.disabled]
 */
export default function ColorWheel({ name, plain, value, onPreview, onCommit, onCancel, hint, disabled = false }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()
  const drag = useRef(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const css = canvas.clientWidth
    if (css < 24) return
    const dpr = getDpr()
    const px = backingSize(css, dpr)
    if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = readColours(canvas)
    const mid = css / 2
    const ring = 5
    const radius = mid - ring - 2

    ctx.clearRect(0, 0, css, css)

    // The hue ring: which way tints towards what.
    const SEG = 72
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * Math.PI * 2
      const a1 = ((i + 1) / SEG) * Math.PI * 2 + 0.01
      const am = (a0 + a1) / 2
      ctx.beginPath()
      // Canvas y runs down; the wheel's y (red) runs up.
      ctx.arc(mid, mid, mid - ring / 2 - 1, -a1, -a0)
      ctx.strokeStyle = directionColour(Math.cos(am), Math.sin(am))
      ctx.lineWidth = ring
      ctx.stroke()
    }

    // The pad.
    ctx.beginPath()
    ctx.arc(mid, mid, radius, 0, Math.PI * 2)
    ctx.fillStyle = c.ground
    ctx.fill()
    ctx.strokeStyle = c.grid
    ctx.lineWidth = 1
    ctx.stroke()
    // Half-way ring and crosshair: where "a little" and "the centre" are.
    ctx.beginPath()
    ctx.arc(mid, mid, radius / 2, 0, Math.PI * 2)
    ctx.moveTo(mid - radius, Math.round(mid) + 0.5)
    ctx.lineTo(mid + radius, Math.round(mid) + 0.5)
    ctx.moveTo(Math.round(mid) + 0.5, mid - radius)
    ctx.lineTo(Math.round(mid) + 0.5, mid + radius)
    ctx.strokeStyle = c.grid
    ctx.stroke()

    const v = valueRef.current ?? { x: 0, y: 0 }
    const [vx, vy] = clampDisc(v.x, v.y)
    const pxX = mid + vx * radius
    const pxY = mid - vy * radius
    const r = Math.hypot(vx, vy)
    if (r > 0.005) {
      // A spoke from the centre, so a small tint still reads as a direction.
      ctx.beginPath()
      ctx.moveTo(mid, mid)
      ctx.lineTo(pxX, pxY)
      ctx.strokeStyle = c.boundary
      ctx.stroke()
    }
    // The puck: filled with the colour it tints towards, ringed in ink so it
    // is found by shape, not by colour.
    ctx.beginPath()
    ctx.arc(pxX, pxY, 5, 0, Math.PI * 2)
    ctx.fillStyle = r > 0.005 ? directionColour(vx / r, vy / r, 0.42 * Math.min(1, 0.35 + r)) : c.panel
    ctx.fill()
    ctx.strokeStyle = c.ink
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [])

  useEffect(() => { paint() }, [paint, value?.x, value?.y, themeEpoch, dprEpoch])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  const send = useCallback((x, y, commit) => {
    const [cx, cy] = clampDisc(x, y)
    const next = { ...valueRef.current, x: round3(cx), y: round3(cy) }
    if (commit) onCommit?.(next)
    else onPreview?.(next)
  }, [onPreview, onCommit])

  const onPointerDown = (e) => {
    if (disabled || e.button !== 0) return
    e.currentTarget.focus()
    if (e.ctrlKey || e.metaKey) {
      send(0, 0, true)      // reset this wheel's tint
      return
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = {
      id: e.pointerId, lastX: e.clientX, lastY: e.clientY,
      x: valueRef.current.x, y: valueRef.current.y, moved: false,
    }
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const gain = DRAG_GAIN * (e.shiftKey ? FINE : 1)
    d.x += (e.clientX - d.lastX) * gain
    d.y -= (e.clientY - d.lastY) * gain
    ;[d.x, d.y] = clampDisc(d.x, d.y)
    d.lastX = e.clientX
    d.lastY = e.clientY
    d.moved = true
    send(d.x, d.y, false)
  }
  const endDrag = (e, commit) => {
    const d = drag.current
    if (!d || (e && d.id !== e.pointerId)) return
    drag.current = null
    if (!d.moved) return
    if (commit) send(d.x, d.y, true)
    else onCancel?.()
  }
  const onKeyDown = (e) => {
    if (disabled) return
    if (e.key === 'Escape' && drag.current) {
      e.preventDefault()
      endDrag(null, false)
      return
    }
    const step = NUDGE * (e.shiftKey ? 10 : 1)
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = step
    else if (e.key === 'ArrowDown') dy = -step
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      send(0, 0, true)
      return
    } else return
    e.preventDefault()
    send(valueRef.current.x + dx, valueRef.current.y + dy, true)
  }

  const tint = describeWheel(value?.x ?? 0, value?.y ?? 0)
  return (
    <div className={styles.wheel}>
      <span className={styles.wheelName}>{name}</span>
      <span className={styles.wheelPlain}>{plain}</span>
      <canvas
        ref={canvasRef}
        className={styles.wheelCanvas}
        tabIndex={disabled ? -1 : 0}
        role="slider"
        aria-label={`${name} tint (${plain.toLowerCase()})`}
        aria-valuetext={tint}
        aria-disabled={disabled || undefined}
        data-hint={hint}
        data-hint-mods="Drag: tint · Shift: fine · Ctrl+click: centre · Arrows: nudge"
        data-testid={`xleth-grade-wheel-${name.toLowerCase()}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onKeyDown={onKeyDown}
      />
      <span className={styles.wheelReadout}>{tint}</span>
      <NumberBox
        label={`${name} brightness`} hideLabel width={84} min={-1} max={1} defaultValue={0}
        bipolar centre={0} step={0.01} disabled={disabled}
        value={value?.lum ?? 0} format={lumFormat} parse={lumParse}
        onChange={(lum) => onPreview?.({ ...valueRef.current, lum })}
        onCommit={(lum) => onCommit?.({ ...valueRef.current, lum })}
        onCancel={onCancel}
        hint={`${plain}: darker or brighter, without changing their colour.`}
      />
    </div>
  )
}

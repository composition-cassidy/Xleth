import React, { useCallback, useEffect, useRef } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { useDragLaw } from '../controls/dragLaw.js'

// PanWidthKnob — the mixer strip's PAN/WIDTH control. Visually a full
// bipolar ring (hollow centre, no cap/pointer): dark and unlit at center,
// filling from 12 o'clock toward the side the value has moved to. The
// accent-colored half fills for values below `defaultValue` (pan-left /
// narrower-than-unity width); the opposite half fills in the accent's
// complementary hue for values above it. At |value - defaultValue| ===
// half the control's span, that half is fully lit (a semicircle).
//
// Drag mechanics are unchanged from the generic sampler Knob (same
// useDragLaw hook: grab-relative vertical drag, Shift = fine, Ctrl/Cmd+click
// = reset, wheel) — this component only owns the paint and one addition: a
// magnetic center detent (see CENTER_SNAP_NORM below) so it's easy to land
// exactly on dead-center pan / unity width, suppressed in fine (Shift) mode
// same as the shared Fader's detents.

const clamp01 = (x) => Math.max(0, Math.min(1, x))

// Fraction of the FULL min..max span (not the half-span) within which a
// live drag value snaps to `defaultValue` — i.e. roughly a 1-1.5% pan/width
// deflection collapses back to dead center. Held Shift (fine mode) disables
// this the same way it disables the Fader's detents.
const CENTER_SNAP_NORM = 0.015

function readToken(cssVar, element, hardFallback) {
  const inherited = element && typeof getComputedStyle === 'function'
    ? getComputedStyle(element).getPropertyValue(cssVar).trim()
    : ''
  return inherited || tokenValue(cssVar) || hardFallback
}

// ── Minimal local color math (hex/rgb string -> HSL -> hue+180 -> rgb) ──────
// Small and duplicated-by-design: every canvas-paint file in this codebase
// (Knob.jsx, mixerCanvasTheme.js) carries its own tiny color helpers rather
// than importing the build-time theming/derivation module into a runtime
// render path.
function parseToRgb(input) {
  const str = String(input || '').trim()
  const hex6 = str.match(/^#([0-9a-f]{6})$/i)
  if (hex6) {
    const n = Number.parseInt(hex6[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const hex3 = str.match(/^#([0-9a-f]{3})$/i)
  if (hex3) {
    const [r, g, b] = hex3[1].split('').map((ch) => Number.parseInt(ch + ch, 16))
    return { r, g, b }
  }
  const rgb = str.match(/^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  return { r: 160, g: 160, b: 168 }
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === rn) h = 60 * (((gn - bn) / d) % 6)
    else if (max === gn) h = 60 * (((bn - rn) / d) + 2)
    else h = 60 * (((rn - gn) / d) + 4)
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

function hslToRgb({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360
  const sn = Math.max(0, Math.min(100, s)) / 100
  const ln = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1))
  const m = ln - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hn < 60) { r = c; g = x; b = 0 }
  else if (hn < 120) { r = x; g = c; b = 0 }
  else if (hn < 180) { r = 0; g = c; b = x }
  else if (hn < 240) { r = 0; g = x; b = c }
  else if (hn < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

// The "inverted" accent — a 180° hue rotation, same saturation/lightness,
// so it stays as vivid as the accent it's derived from (matches blue↔orange
// in the reference design for the shipped default accent).
function complementaryColor(colorStr) {
  const hsl = rgbToHsl(parseToRgb(colorStr))
  const rgb = hslToRgb({ ...hsl, h: hsl.h + 180 })
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
}

export default function PanWidthKnob({
  value,
  min,
  max,
  defaultValue,
  label,
  onLiveChange,
  onCommit,
  size = 28,
  dragRange = 120,
  trackCssVar,
  fillCssVar,
}) {
  const canvasRef = useRef(null)
  const dragApiRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  const span = max - min
  const clampVal = useCallback((v) => Math.max(min, Math.min(max, v)), [min, max])
  const toNorm = useCallback((v) => (span > 0 ? clamp01((clampVal(v) - min) / span) : 0), [clampVal, min, span])
  const fromNormBase = useCallback((n) => min + span * clamp01(n), [min, span])

  // Magnetic center detent — same "only while actively dragging, suppressed
  // in fine mode" contract as the shared Fader's detents (see Fader.jsx).
  const fromNormWithSnap = useCallback((n) => {
    const norm = clamp01(n)
    if (dragApiRef.current?.isDragging?.() && !dragApiRef.current?.isFine?.()) {
      if (Math.abs(norm - 0.5) <= CENTER_SNAP_NORM) return defaultValue
    }
    return fromNormBase(norm)
  }, [fromNormBase, defaultValue])

  const drag = useDragLaw({
    value,
    toNorm,
    fromNorm: fromNormWithSnap,
    dragRange,
    resetValue: defaultValue,
    onLiveChange,
    onCommit,
  })
  dragApiRef.current = drag

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const numericSize = Number(size)
    if (!Number.isFinite(numericSize) || numericSize <= 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = size * dpr
    c.height = size * dpr
    c.style.width = `${size}px`
    c.style.height = `${size}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const cx = size / 2
    const cy = size / 2
    const ringWidth = Math.max(4, size * 0.22)
    const radius = size / 2 - ringWidth / 2 - 1

    const track = readToken(trackCssVar, c, '#3a3f47')
    const leftColor = readToken(fillCssVar, c, '#33CED6')

    // Full unlit ring — the "centered, no effect" base state.
    ctx.lineCap = 'butt'
    ctx.strokeStyle = track
    ctx.lineWidth = ringWidth
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()

    const halfSpan = span / 2
    const offset = value - defaultValue
    const deflection = halfSpan > 0 ? clamp01(Math.abs(offset) / halfSpan) : 0

    if (deflection > 0.0005) {
      const sweep = deflection * Math.PI
      const topAngle = -Math.PI / 2
      const isRight = offset > 0
      ctx.strokeStyle = isRight ? complementaryColor(leftColor) : leftColor
      ctx.beginPath()
      if (isRight) {
        ctx.arc(cx, cy, radius, topAngle, topAngle + sweep)
      } else {
        ctx.arc(cx, cy, radius, topAngle - sweep, topAngle)
      }
      ctx.stroke()
    }
  }, [size, value, defaultValue, span, trackCssVar, fillCssVar, themeEpoch])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, userSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
        onWheel={drag.onWheel}
        style={{ cursor: 'ns-resize', display: 'block', touchAction: 'none' }}
        title="Drag vertical · Shift = fine · Ctrl+click = reset"
      />
      {label && (
        <div style={{
          fontSize: 9, color: 'var(--theme-fx-axis-label)', textTransform: 'uppercase',
          letterSpacing: 0.5, fontWeight: 500,
        }}>
          {label}
        </div>
      )}
    </div>
  )
}

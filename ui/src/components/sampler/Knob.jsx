import React, { useRef, useEffect, useState, useCallback } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'

// Circular knob — FL-style vertical drag.
// Drag up = increase, drag down = decrease. Shift = fine adjust (10x slower).
// Ctrl/Cmd+click = reset to defaultValue. Double-click value label to type.
//
// Props:
//   value            current value (required)
//   min, max         numeric bounds (required)
//   defaultValue     ctrl+click reset target (default: min)
//   label            text below the knob (e.g. "SMP Start")
//   formatValue      optional (v) => string for center readout
//   onLiveChange     (v) => void  — called continuously during drag
//   onCommit         (v) => void  — called on drag-end / blur of text input
//   size             pixel diameter (default 52)
//   dragRange        pixels of vertical travel = full min→max sweep (default 180)
//   color            optional CSS color for value-arc + pointer line; default is --theme-border-focus
//   appearance*      optional closed plugin-UI drawing props; omitted for legacy sampler use

export default function Knob({
  value,
  min,
  max,
  defaultValue,
  label,
  formatValue,
  onLiveChange,
  onCommit,
  size = 52,
  dragRange = 180,
  color,
  appearancePreset,
  capStyle = 'default',
  ringStyle = 'default',
  pointerStyle = 'default',
  tickStyle = 'none',
  tickDensity = 'normal',
  valueReadout = 'below',
  labelPlacement = 'bottom',
  depth = 'flat',
  appearanceTokens = null,
}) {
  const canvasRef = useRef(null)
  const dragRef = useRef(null) // { startY, startValue, fine }
  const liveValueRef = useRef(value)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const clamp = useCallback((v) => Math.max(min, Math.min(max, v)), [min, max])

  const fraction = (max - min) > 0 ? (clamp(value) - min) / (max - min) : 0

  // Draw the knob
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
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
    const outerR = size / 2 - 2
    const trackR = outerR - 3
    const knobR  = outerR - 7

    // FL-style arc sweeps from bottom-left to bottom-right.
    const startAngle = Math.PI * 0.75   // 135° (bottom-left)
    const endAngle   = Math.PI * 2.25   // 405° / 45° (bottom-right), going clockwise
    const totalSweep = endAngle - startAngle

    const valueAngle = startAngle + totalSweep * fraction

    if (!appearancePreset) {
      drawLegacyKnob(ctx, {
        cx,
        cy,
        outerR,
        trackR,
        knobR,
        startAngle,
        endAngle,
        valueAngle,
        accent: readToken(appearanceTokens?.accentCssVar, color || tokenValue('--theme-border-focus')),
      })
      return
    }

    drawAppearanceKnob(ctx, {
      cx,
      cy,
      outerR,
      trackR,
      knobR,
      startAngle,
      endAngle,
      valueAngle,
      capStyle,
      ringStyle,
      pointerStyle,
      tickStyle,
      tickDensity,
      depth,
      surface: readToken(appearanceTokens?.surfaceCssVar, tokenValue('--theme-fx-knob-lg-bg')),
      accent: readToken(appearanceTokens?.accentCssVar, tokenValue('--theme-border-focus')),
      text: readToken(appearanceTokens?.textCssVar, tokenValue('--theme-text-muted')),
      track: tokenValue('--theme-fx-knob-lg-track'),
      border: tokenValue('--theme-fx-knob-lg-border'),
    })
  }, [
    size,
    fraction,
    color,
    appearancePreset,
    capStyle,
    ringStyle,
    pointerStyle,
    tickStyle,
    tickDensity,
    depth,
    appearanceTokens,
  ])

  // Pointer-captured drag — replaces global window mouse listeners.
  // setPointerCapture ensures pointerup fires even when the pointer leaves the
  // window, eliminating zombie-drag on missed mouseup.
  // touch-action: none on the canvas prevents the browser from consuming
  // touch-pan gestures before pointermove fires.
  const handlePointerDown = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const resetTo = defaultValue != null ? defaultValue : min
      onLiveChange?.(resetTo)
      onCommit?.(resetTo)
      return
    }
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch (_) {}
    dragRef.current = { startY: e.clientY, startValue: clamp(value), fine: e.shiftKey }
    document.body.style.cursor = 'ns-resize'
  }, [value, clamp, defaultValue, min, onLiveChange, onCommit])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const dy = d.startY - e.clientY
    const range = max - min
    const sensitivity = (e.shiftKey || d.fine) ? 10 : 1
    const delta = (dy / dragRange) * range / sensitivity
    const next = clamp(d.startValue + delta)
    liveValueRef.current = next
    onLiveChange?.(next)
  }, [max, min, dragRange, clamp, onLiveChange])

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.style.cursor = ''
    onCommit?.(liveValueRef.current)
  }, [onCommit])

  // Keep liveValueRef in sync when value changes externally (e.g. after fetchAll)
  useEffect(() => { liveValueRef.current = value }, [value])

  // Scroll wheel
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const range = max - min
    const sensitivity = e.shiftKey ? 500 : 100
    const delta = -(e.deltaY / sensitivity) * range / 20
    const next = clamp(value + delta)
    onLiveChange?.(next)
    onCommit?.(next)
  }, [value, clamp, max, min, onLiveChange, onCommit])

  // Edit mode — entered only via value label double-click, never the canvas.
  // Guard against accidental entry during an active drag.
  const handleDoubleClick = useCallback(() => {
    if (dragRef.current) return
    setEditing(true)
    setEditText(String(Math.round(value)))
  }, [value])

  const commitEdit = useCallback(() => {
    const n = Number(editText)
    if (!Number.isNaN(n)) {
      const c = clamp(n)
      onLiveChange?.(c)
      onCommit?.(c)
    }
    setEditing(false)
  }, [editText, clamp, onLiveChange, onCommit])

  const display = formatValue ? formatValue(value) : String(Math.round(value))
  const isPluginAppearance = !!appearancePreset
  const readoutMode = valueReadout || 'below'
  const labelMode = labelPlacement || 'bottom'
  const showValueReadout = readoutMode !== 'hidden' && readoutMode !== 'tooltip'
  const centerReadout = showValueReadout && readoutMode === 'center'
  const showBelowReadout = showValueReadout && !centerReadout
  const showLabel = !!label && labelMode !== 'hidden'
  const pluginTextColor = isPluginAppearance && appearanceTokens?.textCssVar
    ? `var(${appearanceTokens.textCssVar})`
    : null
  const valueColor = pluginTextColor || '#BBBBCC'
  const labelColor = pluginTextColor || 'var(--theme-fx-axis-label)'
  const rootDirection = isPluginAppearance && labelMode === 'left' ? 'row' : 'column'
  const canvasTitle = readoutMode === 'tooltip'
    ? `${display} · Drag vertical · Shift = fine · Ctrl+click = reset`
    : 'Drag vertical · Shift = fine · Ctrl+click = reset'

  const labelNode = showLabel ? (
    <div style={{
      fontSize: 9, color: labelColor, textTransform: 'uppercase',
      letterSpacing: 0.5, fontWeight: 500,
    }}>
      {label}
    </div>
  ) : null

  const canvasNode = (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        style={{ cursor: 'ns-resize', display: 'block', touchAction: 'none' }}
        title={canvasTitle}
      />
      {centerReadout && !editing && (
        <div style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          fontSize: 9,
          color: valueColor,
          textAlign: 'center',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {display}
        </div>
      )}
    </div>
  )

  return (
    <div style={{
      display: 'flex', flexDirection: rootDirection, alignItems: 'center',
      gap: 2, userSelect: 'none',
    }}>
      {isPluginAppearance && labelMode === 'top' && labelNode}
      {isPluginAppearance && labelMode === 'left' && labelNode}
      {canvasNode}
      {showBelowReadout && editing ? (
        <>
          <input
            autoFocus
            type="number"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              else if (e.key === 'Escape') setEditing(false)
            }}
            style={{
              width: size, fontSize: 10, textAlign: 'center',
              background: '#0a0a10', color: 'var(--theme-fx-knob-lg-indicator)',
              border: '1px solid var(--theme-border-focus)', borderRadius: 3,
              padding: '1px 2px',
            }}
          />
          <div style={{
            fontSize: 8, color: 'var(--theme-text-muted)',
            textAlign: 'center', lineHeight: 1.2, whiteSpace: 'nowrap',
          }}>
            ↵ apply · esc cancel
          </div>
        </>
      ) : showBelowReadout ? (
        <div
          onDoubleClick={handleDoubleClick}
          title="Double-click to edit"
          style={{
            fontSize: 10, color: valueColor, minHeight: 12,
            fontVariantNumeric: 'tabular-nums', cursor: 'text',
          }}
        >
          {display}
        </div>
      ) : null}
      {(!isPluginAppearance || labelMode === 'bottom') && labelNode}
    </div>
  )
}

function drawLegacyKnob(ctx, {
  cx,
  cy,
  outerR,
  trackR,
  knobR,
  startAngle,
  endAngle,
  valueAngle,
  accent,
}) {
  ctx.fillStyle = tokenValue('--theme-fx-knob-lg-bg')
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = tokenValue('--theme-fx-knob-lg-border')
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.strokeStyle = tokenValue('--theme-fx-knob-lg-track')
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, trackR, startAngle, endAngle)
  ctx.stroke()

  ctx.strokeStyle = accent
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, trackR, startAngle, valueAngle)
  ctx.stroke()

  const px = cx + Math.cos(valueAngle) * knobR
  const py = cy + Math.sin(valueAngle) * knobR
  ctx.strokeStyle = accent
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(px, py)
  ctx.stroke()
  ctx.lineCap = 'butt'
}

function drawAppearanceKnob(ctx, opts) {
  const {
    cx,
    cy,
    outerR,
    trackR,
    knobR,
    startAngle,
    endAngle,
    valueAngle,
    capStyle,
    ringStyle,
    pointerStyle,
    tickStyle,
    tickDensity,
    depth,
    surface,
    accent,
    text,
    track,
    border,
  } = opts

  drawTicks(ctx, {
    cx,
    cy,
    radius: trackR + 4,
    startAngle,
    endAngle,
    tickStyle,
    tickDensity,
    color: text,
  })

  drawCap(ctx, {
    cx,
    cy,
    outerR,
    knobR,
    capStyle,
    depth,
    surface,
    text,
    border,
  })

  if (ringStyle !== 'none') {
    const trackWidth = getTrackWidth(ringStyle)
    ctx.lineCap = 'round'

    if (ringStyle === 'split-track') {
      // Dim full track
      ctx.strokeStyle = withAlpha(track || text, 0.25)
      ctx.lineWidth = trackWidth
      ctx.beginPath()
      ctx.arc(cx, cy, trackR, startAngle, endAngle)
      ctx.stroke()
      // Accent arc from midpoint to current value (bipolar split at center)
      const midAngle = startAngle + (endAngle - startAngle) * 0.5
      const arcFrom = Math.min(midAngle, valueAngle)
      const arcTo = Math.max(midAngle, valueAngle)
      ctx.strokeStyle = accent
      ctx.lineWidth = trackWidth + 0.5
      ctx.beginPath()
      ctx.arc(cx, cy, trackR, arcFrom, arcTo)
      ctx.stroke()
    } else {
      ctx.strokeStyle = withAlpha(track || text, ringStyle === 'thin-line' ? 0.45 : 0.62)
      ctx.lineWidth = trackWidth
      ctx.beginPath()
      ctx.arc(cx, cy, trackR, startAngle, endAngle)
      ctx.stroke()

      ctx.strokeStyle = accent
      ctx.lineWidth = ringStyle === 'metered-arc' ? trackWidth + 1 : trackWidth
      ctx.beginPath()
      ctx.arc(cx, cy, trackR, startAngle, valueAngle)
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
  }

  drawPointer(ctx, {
    cx,
    cy,
    knobR,
    angle: valueAngle,
    pointerStyle,
    accent,
    text,
  })
}

function drawCap(ctx, { cx, cy, outerR, knobR, capStyle, depth, surface, text, border }) {
  ctx.save()
  if (depth === 'raised') {
    ctx.shadowColor = withAlpha(text, 0.22)
    ctx.shadowBlur = 5
    ctx.shadowOffsetY = 1
  }

  const fill = capStyle === 'soft-disk' || capStyle === 'hardware-cap'
    ? makeRadialFill(ctx, cx, cy, outerR, surface, text)
    : surface

  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = border || withAlpha(text, 0.35)
  ctx.lineWidth = capStyle === 'hardware-cap' ? 1.5 : 1
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
  ctx.stroke()

  if (capStyle === 'hardware-cap') {
    ctx.strokeStyle = withAlpha(text, 0.25)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, knobR - 2, 0, Math.PI * 2)
    ctx.stroke()
  } else if (capStyle === 'encoder-cap') {
    ctx.strokeStyle = withAlpha(text, 0.28)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, knobR - 5, 0, Math.PI * 2)
    ctx.stroke()
  } else if (depth === 'sunken') {
    ctx.strokeStyle = withAlpha(text, 0.2)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, outerR - 4, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawPointer(ctx, { cx, cy, knobR, angle, pointerStyle, accent, text }) {
  if (pointerStyle === 'none') return

  const px = cx + Math.cos(angle) * knobR
  const py = cy + Math.sin(angle) * knobR
  ctx.strokeStyle = accent
  ctx.fillStyle = accent
  ctx.lineCap = 'round'

  if (pointerStyle === 'dot') {
    ctx.beginPath()
    ctx.arc(px, py, 2.5, 0, Math.PI * 2)
    ctx.fill()
  } else if (pointerStyle === 'notch') {
    const inner = knobR - 7
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
    ctx.lineTo(px, py)
    ctx.stroke()
  } else if (pointerStyle === 'needle') {
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle + Math.PI) * 3, cy + Math.sin(angle + Math.PI) * 3)
    ctx.lineTo(px, py)
    ctx.stroke()
    ctx.fillStyle = withAlpha(text, 0.55)
    ctx.beginPath()
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(px, py)
    ctx.stroke()
  }
  ctx.lineCap = 'butt'
}

function drawTicks(ctx, { cx, cy, radius, startAngle, endAngle, tickStyle, tickDensity, color }) {
  if (tickStyle === 'none') return

  const numbered = tickStyle === 'numbered'
  const count = tickDensity === 'dense' ? 19 : tickDensity === 'sparse' ? 7 : 11
  const majorEvery = tickStyle === 'minor' ? 3 : 1
  // numbered: slightly more prominent than major — text labels are a future pass
  ctx.strokeStyle = withAlpha(color, numbered ? 0.55 : 0.44)
  ctx.lineCap = 'round'

  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1)
    const angle = startAngle + (endAngle - startAngle) * t
    const major = i % majorEvery === 0
    const tickLen = major ? (numbered ? 6 : 4) : 2
    const inner = radius - tickLen
    ctx.lineWidth = major ? (numbered ? 1.6 : 1.2) : 0.8
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
    ctx.stroke()
  }
}

function getTrackWidth(ringStyle) {
  if (ringStyle === 'thin-line') return 1.5
  if (ringStyle === 'metered-arc') return 3
  if (ringStyle === 'split-track') return 2
  return 2.5
}

function makeRadialFill(ctx, cx, cy, radius, surface, text) {
  const gradient = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, 1, cx, cy, radius)
  gradient.addColorStop(0, withAlpha(text, 0.18))
  gradient.addColorStop(0.32, surface)
  gradient.addColorStop(1, withAlpha(text, 0.08))
  return gradient
}

function readToken(cssVar, fallback) {
  if (!cssVar) return fallback
  return tokenValue(cssVar) || fallback
}

function withAlpha(color, alpha) {
  const value = String(color || '').trim()
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const b = n & 255
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const rgb = value.match(/^rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/i)
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  return value
}

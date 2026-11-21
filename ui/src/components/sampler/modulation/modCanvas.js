// Shared drawing for the modulation displays: one recessed g0 well, one ruler
// grammar, one handle grammar. Colours are read from the kit tokens at draw time.

import { tokenValue } from '../../../theming/tokenValue.ts'
import { getDpr } from '../../../ui-kit/dpr.ts'

export const RULER_H = 16
export const HANDLE_R = 4
export const HANDLE_HIT = 12

export function prepCanvas(canvas, width, height) {
  // Every caller redraws on useThemeEpoch, which a pixel-ratio change bumps.
  const dpr = getDpr()
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

export function palette(color) {
  const signal = color?.startsWith?.('var(')
    ? tokenValue(color.slice(4, -1)) || tokenValue('--ui-signal-parameter')
    : (color || tokenValue('--ui-signal-parameter'))
  return {
    bg: tokenValue('--ui-g0') || '#0F0F0F',
    header: tokenValue('--ui-g1') || '#1A1A1A',
    line: tokenValue('--ui-g4') || '#444444',
    faint: tokenValue('--ui-g3') || '#323232',
    ink: tokenValue('--ui-ink') || '#E6E6E6',
    ink2: tokenValue('--ui-ink-2') || '#B4B4B4',
    signal: signal || '#AA95E8',
    font: `10px ${tokenValue('--ui-font') || 'sans-serif'}`,
  }
}

export function rgba(hex, alpha) {
  let h = String(hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n) || h.length !== 6) return `rgba(170,149,232,${alpha})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

const crisp = (v) => Math.round(v) + 0.5

export function vLine(ctx, x, y0, y1) {
  ctx.beginPath(); ctx.moveTo(crisp(x), y0); ctx.lineTo(crisp(x), y1); ctx.stroke()
}

export function hLine(ctx, y, x0, x1) {
  ctx.beginPath(); ctx.moveTo(x0, crisp(y)); ctx.lineTo(x1, crisp(y)); ctx.stroke()
}

/**
 * A ruler strip and its grid lines through the plot. `ticks` are
 * [{ x, label, major }] in canvas pixels; lines are clipped to [clipX0, clipX1].
 */
export function drawTicks(ctx, pal, ticks, { rulerY, plotY0, plotY1, clipX0, clipX1 }) {
  ctx.font = pal.font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  let lastLabelEnd = -Infinity
  for (const t of ticks) {
    if (t.x < clipX0 - 0.5 || t.x > clipX1 + 0.5) continue
    ctx.strokeStyle = t.major ? pal.line : pal.faint
    ctx.lineWidth = 1
    vLine(ctx, t.x, plotY0, plotY1)
    ctx.strokeStyle = pal.line
    vLine(ctx, t.x, rulerY + (t.major ? RULER_H - 6 : RULER_H - 3), rulerY + RULER_H)
    if (!t.label) continue
    const w = ctx.measureText(t.label).width
    const lx = t.x + 3
    if (lx < lastLabelEnd + 6 || lx + w > clipX1) continue
    ctx.fillStyle = pal.ink2
    ctx.fillText(t.label, lx, rulerY + RULER_H / 2 - 1)
    lastLabelEnd = lx + w
  }
}

/** A point handle: hollow at rest, filled while hovered or dragged (shape, not colour alone). */
export function drawHandle(ctx, pal, x, y, { active = false, kind = 'point' } = {}) {
  ctx.lineWidth = 1.5
  ctx.strokeStyle = pal.ink
  ctx.fillStyle = active ? pal.ink : pal.bg
  ctx.beginPath()
  if (kind === 'curve') {
    const r = active ? 4.5 : 3.5
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y)
    ctx.closePath()
  } else {
    ctx.arc(x, y, active ? HANDLE_R + 1 : HANDLE_R, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.stroke()
}

/** A value tag beside a handle, kept inside the plot. */
export function drawTag(ctx, pal, text, x, y, box) {
  ctx.font = pal.font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const w = ctx.measureText(text).width + 8
  const h = 14
  let tx = x + 8
  let ty = y - 16
  if (tx + w > box.x + box.w) tx = x - 8 - w
  if (tx < box.x) tx = box.x
  if (ty < box.y) ty = y + 6
  ctx.fillStyle = pal.header
  ctx.strokeStyle = pal.line
  ctx.lineWidth = 1
  ctx.fillRect(tx, ty, w, h)
  ctx.strokeRect(Math.round(tx) + 0.5, Math.round(ty) + 0.5, Math.round(w) - 1, h - 1)
  ctx.fillStyle = pal.ink
  ctx.fillText(text, tx + 4, ty + h / 2)
}

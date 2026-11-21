import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThemeEpoch } from '../../../theming/useThemeEpoch.js'
import {
  ENV_HANDLES, ENV_TENSIONS, envActiveSeconds, envStageSecondsAt, envelopeLayout,
  formatSeconds, resolveSpan, timeTicks,
} from './modTime.js'
import {
  HANDLE_HIT, RULER_H, drawHandle, drawTag, drawTicks, hLine, palette, prepCanvas, rgba, vLine,
} from './modCanvas.js'
import { drawIcon } from '../../../ui-kit/icons/canvas.ts'

// ── Envelope display ─────────────────────────────────────────────────────────
// The DAHDSR drawn TO SCALE on a time ruler: the display covers a fixed span, so
// a short stage is narrow and a long one is wide, and an envelope longer than the
// span runs off the right edge and says by how much. The sustain is not a time
// (it lasts while the key is held), so it is a marked break in the axis and the
// release is measured from its far side.
//
// The display is the editor. Drag a point sideways for its stage time (the decay
// point also moves up and down for the sustain level); drag a diamond up or down
// to bend that segment. One preview per pointer move, one commit on release. The
// knobs and value boxes under it are the typed and keyboard alternative.

const PAD_L = 30
const PAD_R = 10
const PAD_B = 6
const PAD_T = 6
const STAGE_NAME = { delay: 'Delay', attack: 'Attack', hold: 'Hold', decay: 'Decay', release: 'Release' }
const TENSION_NAME = { attackTension: 'Attack curve', decayTension: 'Decay curve', releaseTension: 'Release curve' }
// Which way a segment bulges when its diamond is dragged up.
const TENSION_SIGN = { attackTension: 1, decayTension: -1, releaseTension: -1 }
const TENSION_PX = 90

const signed2 = (v) => `${v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toFixed(2)}`

export default function EnvCanvas({
  env, color, width = 460, height = 160, span = 1, sync = false, bpm = 120,
  stageText, onDrag, onDragEnd, label = 'Envelope',
}) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const [hover, setHover] = useState(null)
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)

  const box = useMemo(() => ({
    x: PAD_L, y: RULER_H + PAD_T,
    w: Math.max(20, width - PAD_L - PAD_R),
    h: Math.max(20, height - RULER_H - PAD_T - PAD_B),
  }), [width, height])

  // The scale is frozen for the length of a drag: in Fit it would otherwise
  // rescale under the pointer and the point would run away from the hand.
  const liveSpan = resolveSpan(span, envActiveSeconds(env))
  const spanSec = drag ? drag.spanSec : liveSpan
  const layout = useMemo(() => envelopeLayout(env, spanSec, box), [env, spanSec, box])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const active = drag?.key ?? hover

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = prepCanvas(c, width, height)
    const pal = palette(color)
    const L = layout
    const plotY0 = box.y
    const plotY1 = box.y + box.h
    const right = box.x + box.w

    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = pal.header
    ctx.fillRect(0, 0, width, RULER_H)

    // Level grid: 0, 50, 100 %.
    ctx.font = pal.font
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    for (const lv of [0, 0.5, 1]) {
      ctx.strokeStyle = lv === 0 ? pal.line : pal.faint
      ctx.lineWidth = 1
      hLine(ctx, L.yOf(lv), box.x, right)
      ctx.fillStyle = pal.ink2
      ctx.fillText(`${lv * 100}`, box.x - 5, L.yOf(lv))
    }
    ctx.textAlign = 'left'
    ctx.fillText('%', 3, RULER_H / 2 - 1)

    // Time ruler: from the note start up to the sustain break, then from the
    // key release on its far side.
    const gapX0 = Math.min(L.x.decay, right)
    const gapX1 = Math.min(L.x.gapEnd, right)
    const opt = { sync, bpm }
    const pre = timeTicks((gapX0 - box.x) / L.pps + 1e-9, Math.max(1, gapX0 - box.x), opt)
      .map((t) => ({ ...t, x: box.x + t.sec * L.pps }))
    drawTicks(ctx, pal, pre, { rulerY: 0, plotY0, plotY1, clipX0: box.x, clipX1: gapX0 })
    if (gapX1 < right) {
      const post = timeTicks((right - gapX1) / L.pps, right - gapX1, opt)
        .map((t) => ({ ...t, x: gapX1 + t.sec * L.pps, label: t.label && t.sec > 0 ? `+${t.label}` : '' }))
      drawTicks(ctx, pal, post, { rulerY: 0, plotY0, plotY1, clipX0: gapX1, clipX1: right })
    }

    // The sustain break: hatched, labelled, not to scale.
    if (gapX1 > gapX0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(gapX0, 0, gapX1 - gapX0, plotY1)
      ctx.clip()
      ctx.strokeStyle = pal.faint
      ctx.lineWidth = 1
      for (let x = gapX0 - plotY1; x < gapX1; x += 6) {
        ctx.beginPath(); ctx.moveTo(x, plotY1); ctx.lineTo(x + plotY1, 0); ctx.stroke()
      }
      ctx.restore()
      ctx.strokeStyle = pal.line
      vLine(ctx, gapX0, 0, plotY1)
      vLine(ctx, gapX1, 0, plotY1)
      if (gapX1 - gapX0 >= 30) {
        ctx.fillStyle = pal.ink2
        ctx.textAlign = 'center'
        ctx.fillText('held', (gapX0 + gapX1) / 2, RULER_H / 2 - 1)
        ctx.textAlign = 'left'
      }
    }

    // The envelope: flat fill, 1.5px line. The held part is dashed.
    ctx.save()
    ctx.beginPath()
    ctx.rect(box.x, plotY0 - 2, box.w, box.h + 4)
    ctx.clip()
    ctx.beginPath()
    ctx.moveTo(L.pts[0].x, L.yOf(0))
    for (const p of L.pts) ctx.lineTo(p.x, p.y)
    ctx.lineTo(L.pts[L.pts.length - 1].x, L.yOf(0))
    ctx.closePath()
    ctx.fillStyle = rgba(pal.signal, 0.14)
    ctx.fill()
    ctx.strokeStyle = pal.signal
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.beginPath()
    L.pts.slice(0, L.releaseStart).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.stroke()
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(L.x.decay, L.yOf(L.sus)); ctx.lineTo(L.x.gapEnd, L.yOf(L.sus))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    L.pts.slice(L.releaseStart).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.stroke()
    ctx.restore()

    // Handles: curve diamonds under the stage points.
    for (const f of ENV_TENSIONS) {
      const h = L.tensions[f]
      if (h && h.x <= right) drawHandle(ctx, pal, h.x, h.y, { kind: 'curve', active: active === f })
    }
    for (const k of ENV_HANDLES) {
      const h = L.handles[k]
      if (h.x <= right + 0.5) drawHandle(ctx, pal, h.x, h.y, { active: active === k })
    }

    // Past the right edge: say how much is not shown.
    if (L.overflowSec > 1e-4) {
      const text = `${formatSeconds(L.overflowSec)} more`
      ctx.font = pal.font
      const w = ctx.measureText(text).width
      ctx.fillStyle = pal.ink
      ctx.textAlign = 'left'
      ctx.fillText(text, right - w - 4, plotY1 - 8)
      drawIcon(ctx, 'caret-right', right - w - 4 - 11, plotY1 - 8 - 5, 10, pal.ink)
    }

    // The value of the point under the pointer, printed on the display.
    if (active) {
      if (L.handles[active]) {
        const h = L.handles[active]
        const t = `${STAGE_NAME[active]} ${stageText?.(active) ?? ''}`.trim()
        const tag = active === 'decay' ? `${t} · Sustain ${Math.round(L.sus * 100)} %` : t
        if (h.x <= right) drawTag(ctx, pal, tag, h.x, h.y, box)
      } else if (L.tensions[active]) {
        const h = L.tensions[active]
        drawTag(ctx, pal, `${TENSION_NAME[active]} ${signed2(env[active] || 0)}`, h.x, h.y, box)
      }
    }
  }, [layout, box, width, height, color, sync, bpm, active, env, stageText, themeEpoch])

  const local = useCallback((e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return [(e.clientX - r.left) * (width / (r.width || width)), (e.clientY - r.top) * (height / (r.height || height))]
  }, [width, height])

  const hit = useCallback((mx, my) => {
    const L = layoutRef.current
    const near = (h) => h && Math.hypot(mx - h.x, my - h.y) <= HANDLE_HIT
    // Later stages win where points stack (a zero-length stage sits on its neighbour),
    // so a collapsed envelope can always be pulled open from the right.
    for (const k of [...ENV_HANDLES].reverse()) if (near(L.handles[k])) return k
    for (const f of ENV_TENSIONS) if (near(L.tensions[f])) return f
    return null
  }, [])

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    const [mx, my] = local(e)
    const key = hit(mx, my)
    if (!key) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const L = layoutRef.current
    const state = {
      key, spanSec: L.pps > 0 ? (box.w - L.gap) / L.pps : 1,
      layout: L, startY: my, startTension: env[key] || 0,
      // The pointer keeps its offset from the point it grabbed.
      dx: L.handles[key] ? mx - L.handles[key].x : 0,
      dy: L.handles[key] ? my - L.handles[key].y : 0,
      moved: false,
    }
    dragRef.current = state
    setDrag({ key, spanSec: state.spanSec })
  }, [box, env, hit, local])

  const onPointerMove = useCallback((e) => {
    const [mx, my] = local(e)
    const d = dragRef.current
    if (!d) {
      const k = hit(mx, my)
      setHover((cur) => (cur === k ? cur : k))
      return
    }
    d.moved = true
    if (d.layout.handles[d.key]) {
      const change = { stage: d.key, sec: envStageSecondsAt(d.layout, d.key, mx - d.dx) }
      if (d.key === 'decay') change.sustain = d.layout.levelOf(my - d.dy)
      onDrag?.(change)
    } else {
      const t = d.startTension + TENSION_SIGN[d.key] * ((d.startY - my) / TENSION_PX)
      onDrag?.({ field: d.key, tension: Math.max(-1, Math.min(1, Number(t.toFixed(3)))) })
    }
  }, [hit, local, onDrag])

  const endDrag = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDrag(null)
    if (d.moved) onDragEnd?.()
  }, [onDragEnd])

  const cursor = !active ? 'default'
    : (active === 'decay' ? 'move' : (ENV_TENSIONS.includes(active) ? 'ns-resize' : 'ew-resize'))

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${label} shape, drawn to scale`}
      data-env-canvas=""
      data-active={active || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => { if (!dragRef.current) setHover(null) }}
      style={{ display: 'block', width, height, cursor, touchAction: 'none' }}
    />
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  containRect, lensBoxContains, lensBoxCorners, lensMoveCenter, lensZoomFromDrag,
} from '../../lensRoam/lensRoamModel.js'
import styles from './lensRoam.module.css'

// The source-frame well of the Lens panel: the whole source picture with the
// framing box over it, all on ONE canvas (no DOM overlay on a canvas).
//
//   drag inside the box   moves the centre (the box follows the pointer)
//   drag a corner         zooms about the box centre (out = zoom out)
//   Shift while moving    fine: a quarter of the pointer travel
//   Escape                cancels the gesture, nothing is sent
//
// Gestures are LOCAL: every pointermove calls onPreview, only pointerup calls
// onCommit, once. This component never talks to the engine.

const HIT_PX = 10
const HANDLE_PX = 4
const MARGIN = 0.2        // fraction of each axis kept free around the source, so a box that overshoots it (Contain, zoomed out) stays reachable
const FINE = 0.25
const MIN_H = 130
const MAX_H = 230

const ink = (name) => tokenValue(name)

export default function LensFrameCanvas({
  lens,
  cellAspect,
  srcAspect,
  frameUrl,
  disabled = false,
  onPreview,
  onCommit,
  onCancel,
}) {
  const epoch = useThemeEpoch()
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const [width, setWidth] = useState(300)
  const [image, setImage] = useState(null)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 40) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Decode off the draw path; a frame that never arrives leaves the well empty.
  useEffect(() => {
    if (!frameUrl) { setImage(null); return undefined }
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) setImage(img) }
    img.onerror = () => { if (alive) setImage(null) }
    img.src = frameUrl
    return () => { alive = false }
  }, [frameUrl])

  const sa = srcAspect > 0 ? srcAspect : 16 / 9
  const ca = cellAspect > 0 ? cellAspect : 16 / 9

  const height = Math.round(Math.min(MAX_H, Math.max(MIN_H, width / sa)))
  // Where the whole source lands in the well.
  const stage = useMemo(() => {
    const r = containRect(width * (1 - MARGIN), height * (1 - MARGIN), sa)
    return { x: (width - r.w) / 2, y: (height - r.h) / 2, w: r.w, h: r.h }
  }, [width, height, sa])

  const toPx = useCallback((p) => ({ x: stage.x + p.x * stage.w, y: stage.y + p.y * stage.h }), [stage])
  const toUv = useCallback((px, py) => ({ x: (px - stage.x) / stage.w, y: (py - stage.y) / stage.h }), [stage])

  const corners = useMemo(() => lensBoxCorners(lens, ca, sa).map(toPx), [lens, ca, sa, toPx])
  const centerPx = useMemo(
    () => toPx({ x: lens.centerX, y: lens.centerY }),
    [lens.centerX, lens.centerY, toPx],
  )

  // ── draw ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.fillStyle = ink('--ui-g0')
    ctx.fillRect(0, 0, width, height)

    const trace = () => {
      ctx.beginPath()
      ctx.moveTo(corners[0].x, corners[0].y)
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y)
      ctx.closePath()
    }

    // The source, dimmed; at full strength only inside the box.
    ctx.fillStyle = ink('--ui-g2')
    ctx.fillRect(stage.x, stage.y, stage.w, stage.h)
    if (image) {
      ctx.save()
      ctx.globalAlpha = 0.35
      ctx.drawImage(image, stage.x, stage.y, stage.w, stage.h)
      ctx.restore()
      ctx.save()
      trace()
      ctx.clip()
      ctx.beginPath()
      ctx.rect(stage.x, stage.y, stage.w, stage.h)
      ctx.clip()
      ctx.drawImage(image, stage.x, stage.y, stage.w, stage.h)
      ctx.restore()
    } else {
      ctx.fillStyle = ink('--ui-ink-3')
      ctx.font = `11px ${ink('--ui-font') || 'sans-serif'}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('No source frame', stage.x + stage.w / 2, stage.y + stage.h / 2)
    }

    ctx.strokeStyle = ink('--ui-g4')
    ctx.lineWidth = 1
    ctx.strokeRect(stage.x + 0.5, stage.y + 0.5, stage.w - 1, stage.h - 1)

    // The framing box.
    const accent = ink('--ui-value')
    trace()
    ctx.strokeStyle = ink('--ui-ink')
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Centre cross.
    ctx.strokeStyle = accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(centerPx.x - 4, centerPx.y); ctx.lineTo(centerPx.x + 4, centerPx.y)
    ctx.moveTo(centerPx.x, centerPx.y - 4); ctx.lineTo(centerPx.x, centerPx.y + 4)
    ctx.stroke()

    // Corner handles (zoom): filled squares, accent while hovered or dragged.
    corners.forEach((c, i) => {
      const on = hover === `corner${i}` || dragRef.current?.kind === `corner${i}`
      ctx.fillStyle = on ? accent : ink('--ui-ink')
      ctx.fillRect(c.x - HANDLE_PX, c.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
      ctx.strokeStyle = ink('--ui-g0')
      ctx.lineWidth = 1
      ctx.strokeRect(c.x - HANDLE_PX, c.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
    })
  }, [corners, centerPx, stage, image, width, height, hover, epoch])

  // ── hit testing ───────────────────────────────────────────────────────────
  const hitTest = useCallback((px, py) => {
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(px - corners[i].x, py - corners[i].y) <= HIT_PX) return `corner${i}`
    }
    const uv = toUv(px, py)
    return lensBoxContains(lens, ca, sa, uv.x, uv.y) ? 'move' : null
  }, [corners, toUv, lens, ca, sa])

  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  const onPointerDown = (e) => {
    if (disabled || e.button !== 0) return
    const { px, py } = local(e)
    const kind = hitTest(px, py)
    if (!kind) return
    dragRef.current = {
      kind,
      start: { ...lens },
      last: { px, py },
      acc: { dx: 0, dy: 0 },
      startDist: Math.hypot(px - centerPx.x, py - centerPx.y),
      moved: false,
    }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom */ }
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    const { px, py } = local(e)
    const d = dragRef.current
    if (!d) {
      const h = disabled ? null : hitTest(px, py)
      if (h !== hover) setHover(h)
      return
    }
    d.moved = true
    if (d.kind === 'move') {
      const k = e.shiftKey ? FINE : 1
      d.acc.dx += (px - d.last.px) * k
      d.acc.dy += (py - d.last.py) * k
      d.last = { px, py }
      onPreview?.(lensMoveCenter(d.start, d.acc.dx / stage.w, d.acc.dy / stage.h))
    } else {
      // Zoom about the start centre: the ratio of pointer distances.
      const c = toPx({ x: d.start.centerX, y: d.start.centerY })
      onPreview?.({ zoom: lensZoomFromDrag(d.start.zoom, d.startDist, Math.hypot(px - c.x, py - c.y)) })
    }
  }

  const end = (e, commit) => {
    const d = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
    if (!d) return
    if (commit && d.moved) onCommit?.()
    else onCancel?.()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && dragRef.current) {
      dragRef.current = null
      onCancel?.()
      e.stopPropagation()
    }
  }

  const cursor = hover === 'move' ? 'move' : hover ? 'nwse-resize' : 'default'

  return (
    <div ref={wrapRef} className={styles.well}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ width, height, cursor }}
        tabIndex={disabled ? -1 : 0}
        data-testid="lens-frame-canvas"
        aria-label="Lens framing box over the source frame. Drag inside to move, a corner to zoom. The Zoom, Center X and Center Y fields type the same values."
        data-hint="Lens framing box: the part of the source this cell shows. Drag inside to move it, a corner to zoom."
        data-hint-mods="Drag: move / zoom · Shift: fine move · Esc: cancel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onPointerLeave={() => { if (!dragRef.current) setHover(null) }}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

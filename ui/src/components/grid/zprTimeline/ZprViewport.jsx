import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tokenValue } from '../../../theming/tokenValue.ts'
import {
  HANDLES, handlePoint, rectCorners, rotationHandlePoint,
  moveRect, resizeFromCorner, resizeFromEdge, rotateRectAboutPivot,
  createAngleAccumulator, pointerAngle,
} from './zprRectMath.js'

// ZprViewport — Vegas Pan/Crop-style spatial editor for the ZPR transform.
//
// Everything inside the frame is drawn on ONE canvas: the backdrop, the camera
// rect, all 8 handles, the rotation grip, the rotation-centre pin and the
// motion path. No DOM overlays for any of it — same rule PianoRollCanvas
// documents, and the reason is the same: a rotated, non-uniformly scaled rect
// hit-tested against absolutely-positioned divs drifts the moment the stage
// resizes.
//
// The stage is the CELL's [0,1]^2. The compositor stretches the decoded source
// across that square with no letterbox, so the square is drawn at the cell's
// aspect and the rect is transformed CORNER BY CORNER in UV before being mapped
// to pixels. That reproduces the shader's rotation exactly, including the shear
// a non-square cell gives it — using ctx.rotate() on a pixel-space rect would
// silently draw a different transform than the one being rendered.
//
// Drags are local-only: every pointermove calls onRectLive, and only pointerup
// calls onRectCommit. Nothing here does IPC while the pointer is down.

const HANDLE_PX = 4.5
const HIT_PX = 10
const ROT_STEM_PX = 26
const ROT_KNOB_PX = 5
const PIVOT_PX = 6
const STAGE_INSET = 0.30   // fraction of the smaller axis kept free around the stage
const MIN_H = 190
const MAX_H = 340

function resolvePalette() {
  return {
    bg:       tokenValue('--xleth-flat-panel') || '#15151C',
    checkerA: tokenValue('--xleth-flat-panel-alt') || '#1B1B24',
    checkerB: tokenValue('--xleth-flat-border') || '#23232F',
    border:   tokenValue('--xleth-flat-border') || '#2A2A38',
    text:     tokenValue('--xleth-flat-text-subtle') || '#5A5F6B',
    accent:   tokenValue('--theme-accent') || '#33CED6',
    path:     tokenValue('--theme-warning') || '#E6A23C',
    pivot:    tokenValue('--theme-danger') || '#E6607C',
    rect:     '#FFFFFF',
  }
}

export default function ZprViewport({
  rect,
  onRectLive,
  onRectCommit,
  onContextMenu,
  cellAspect = 16 / 9,
  frameUrl = null,
  aspectLocked = true,
  pivot,
  onPivotChange,
  motionPath = [],
  motionKeys = [],
  scrubT = 0,
}) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const [width, setWidth] = useState(360)
  const [image, setImage] = useState(null)
  const [hoverId, setHoverId] = useState(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 40) setWidth(Math.round(r.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Decode the backdrop off the render path. A frame that never arrives simply
  // leaves `image` null and the checkerboard shows through.
  useEffect(() => {
    if (!frameUrl) { setImage(null); return }
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) setImage(img) }
    img.onerror = () => { if (alive) setImage(null) }
    img.src = frameUrl
    return () => { alive = false }
  }, [frameUrl])

  const height = Math.round(
    Math.min(MAX_H, Math.max(MIN_H, width / Math.max(0.2, cellAspect) * (1 + STAGE_INSET)))
  )

  // Where the cell's unit square lands, letterboxed inside the canvas with a
  // margin so a zoomed-out or panned-off rect (and the rotation grip) stay
  // reachable instead of being clipped at the canvas edge.
  const stage = useMemo(() => {
    const availW = width * (1 - STAGE_INSET)
    const availH = height * (1 - STAGE_INSET)
    let w = availW
    let h = w / Math.max(0.2, cellAspect)
    if (h > availH) { h = availH; w = h * Math.max(0.2, cellAspect) }
    return { x: (width - w) / 2, y: (height - h) / 2, w, h }
  }, [width, height, cellAspect])

  const uvToPx = useCallback(
    (u, v) => ({ x: stage.x + u * stage.w, y: stage.y + v * stage.h }),
    [stage])
  const pxToUv = useCallback(
    (px, py) => ({ u: (px - stage.x) / stage.w, v: (py - stage.y) / stage.h }),
    [stage])

  const stemUv = ROT_STEM_PX / Math.max(1, Math.min(stage.w, stage.h))
  const livePivot = pivot || { x: rect.cx, y: rect.cy }

  // ── draw ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const pal = resolvePalette()

    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, width, height)

    // checkerboard — always drawn, so a missing frame degrades to a placeholder
    const cs = 10
    for (let y = 0; y < stage.h; y += cs) {
      for (let x = 0; x < stage.w; x += cs) {
        ctx.fillStyle = ((x / cs | 0) + (y / cs | 0)) % 2 ? pal.checkerA : pal.checkerB
        ctx.fillRect(stage.x + x, stage.y + y,
                     Math.min(cs, stage.w - x), Math.min(cs, stage.h - y))
      }
    }

    const corners = rectCorners(rect).map(p => uvToPx(p.x, p.y))

    const tracePath = () => {
      ctx.beginPath()
      ctx.moveTo(corners[0].x, corners[0].y)
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y)
      ctx.closePath()
    }

    // Backdrop: stretched across the stage, exactly as the compositor stretches
    // the source across the cell. Dimmed outside the camera window.
    if (image) {
      ctx.save()
      ctx.globalAlpha = 0.30
      ctx.drawImage(image, stage.x, stage.y, stage.w, stage.h)
      ctx.restore()
      ctx.save()
      tracePath()
      ctx.clip()
      ctx.drawImage(image, stage.x, stage.y, stage.w, stage.h)
      ctx.restore()
    } else {
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(stage.x, stage.y, stage.w, stage.h)
      ctx.restore()
      ctx.save()
      tracePath()
      ctx.clip()
      ctx.fillStyle = 'rgba(255,255,255,0.04)'
      ctx.fillRect(stage.x, stage.y, stage.w, stage.h)
      ctx.restore()
    }

    // stage frame — the cell boundary
    ctx.strokeStyle = pal.border
    ctx.lineWidth = 1
    ctx.strokeRect(stage.x + 0.5, stage.y + 0.5, stage.w - 1, stage.h - 1)

    // ── motion path ───────────────────────────────────────────────────────
    if (motionPath.length > 1) {
      ctx.strokeStyle = pal.path
      ctx.globalAlpha = 0.85
      ctx.lineWidth = 1.25
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      motionPath.forEach((p, i) => {
        const q = uvToPx(p.x, p.y)
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y)
      })
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1

      for (const k of motionKeys) {
        const q = uvToPx(k.x, k.y)
        ctx.fillStyle = pal.path
        ctx.beginPath()
        ctx.arc(q.x, q.y, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = pal.bg
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // where the card's own playhead sits on that path
      const at = motionPath.reduce(
        (best, p) => (Math.abs(p.t - scrubT) < Math.abs(best.t - scrubT) ? p : best),
        motionPath[0])
      const q = uvToPx(at.x, at.y)
      ctx.strokeStyle = pal.accent
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    // ── camera rect ───────────────────────────────────────────────────────
    ctx.strokeStyle = pal.rect
    ctx.lineWidth = 1.5
    tracePath()
    ctx.stroke()

    // rotation grip
    const rp = rotationHandlePoint(rect, stemUv)
    const rpx = uvToPx(rp.x, rp.y)
    const uvCorners = rectCorners(rect)
    const topMid = uvToPx(
      (uvCorners[0].x + uvCorners[1].x) / 2,
      (uvCorners[0].y + uvCorners[1].y) / 2)
    ctx.strokeStyle = pal.accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(topMid.x, topMid.y)
    ctx.lineTo(rpx.x, rpx.y)
    ctx.stroke()
    ctx.fillStyle = hoverId === 'rotate' ? pal.accent : pal.bg
    ctx.beginPath()
    ctx.arc(rpx.x, rpx.y, ROT_KNOB_PX, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = pal.accent
    ctx.lineWidth = 1.5
    ctx.stroke()

    // resize handles — edge handles greyed out while aspect lock is on
    for (const h of HANDLES) {
      const disabled = aspectLocked && h.kind === 'edge'
      const p = handlePoint(rect, h)
      const q = uvToPx(p.x, p.y)
      ctx.fillStyle = disabled ? pal.text : (hoverId === h.id ? pal.accent : pal.rect)
      ctx.globalAlpha = disabled ? 0.45 : 1
      ctx.fillRect(q.x - HANDLE_PX, q.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
      ctx.globalAlpha = 1
      ctx.strokeStyle = pal.bg
      ctx.lineWidth = 1
      ctx.strokeRect(q.x - HANDLE_PX, q.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
    }

    // rotation-centre pin
    const pv = uvToPx(livePivot.x, livePivot.y)
    ctx.strokeStyle = pal.pivot
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(pv.x, pv.y, PIVOT_PX, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(pv.x - PIVOT_PX - 3, pv.y); ctx.lineTo(pv.x + PIVOT_PX + 3, pv.y)
    ctx.moveTo(pv.x, pv.y - PIVOT_PX - 3); ctx.lineTo(pv.x, pv.y + PIVOT_PX + 3)
    ctx.stroke()
  }, [rect, width, height, stage, uvToPx, image, aspectLocked, hoverId,
      motionPath, motionKeys, scrubT, stemUv, livePivot.x, livePivot.y])

  // ── hit testing ─────────────────────────────────────────────────────────
  const hitTest = useCallback((px, py) => {
    const rp = rotationHandlePoint(rect, stemUv)
    const rpx = uvToPx(rp.x, rp.y)
    if (Math.hypot(px - rpx.x, py - rpx.y) <= HIT_PX) return { kind: 'rotate' }

    const pv = uvToPx(livePivot.x, livePivot.y)
    if (Math.hypot(px - pv.x, py - pv.y) <= HIT_PX) return { kind: 'pivot' }

    for (const h of HANDLES) {
      if (aspectLocked && h.kind === 'edge') continue
      const p = handlePoint(rect, h)
      const q = uvToPx(p.x, p.y)
      if (Math.hypot(px - q.x, py - q.y) <= HIT_PX) return { kind: 'resize', handle: h }
    }

    // inside the rotated quad -> move
    const { u, v } = pxToUv(px, py)
    const rad = rect.rotDeg * (Math.PI / 180)
    const c = Math.cos(-rad), s = Math.sin(-rad)
    const dx = u - rect.cx, dy = v - rect.cy
    const lx = dx * c - dy * s
    const ly = dx * s + dy * c
    if (Math.abs(lx) <= rect.w / 2 && Math.abs(ly) <= rect.h / 2) return { kind: 'move' }

    return null
  }, [rect, stemUv, uvToPx, pxToUv, aspectLocked, livePivot.x, livePivot.y])

  const localPoint = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return
    const { px, py } = localPoint(e)
    const hit = hitTest(px, py)
    if (!hit) return

    const { u, v } = pxToUv(px, py)
    const base = {
      ...hit,
      startRect: rect,
      startU: u,
      startV: v,
      moved: false,
      lastRect: rect,
    }

    if (hit.kind === 'rotate') {
      // Unwrapped from here on: the accumulator sums short-arc deltas, so
      // sweeping past the seam continues 359 -> 361 -> 362 instead of wrapping.
      base.acc = createAngleAccumulator(
        pointerAngle(u - livePivot.x, v - livePivot.y), rect.rotDeg)
      base.pivot = { ...livePivot }
    }

    dragRef.current = base
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) { /* jsdom */ }
    e.preventDefault()
  }, [hitTest, pxToUv, rect, livePivot])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    const { px, py } = localPoint(e)

    if (!d) {
      const hit = hitTest(px, py)
      const id = hit?.kind === 'resize' ? hit.handle.id : (hit?.kind ?? null)
      if (id !== hoverId) setHoverId(id)
      return
    }

    const { u, v } = pxToUv(px, py)
    d.moved = true
    let next

    if (d.kind === 'move') {
      next = moveRect(d.startRect, u - d.startU, v - d.startV)
    } else if (d.kind === 'resize') {
      next = d.handle.kind === 'corner'
        ? resizeFromCorner(d.startRect, d.handle, u, v)
        : resizeFromEdge(d.startRect, d.handle, u, v)
    } else if (d.kind === 'rotate') {
      const abs = d.acc.update(pointerAngle(u - d.pivot.x, v - d.pivot.y))
      next = rotateRectAboutPivot(d.startRect, d.pivot, abs - d.startRect.rotDeg)
    } else if (d.kind === 'pivot') {
      onPivotChange?.({ x: u, y: v })
      return
    }

    if (!next) return
    d.lastRect = next
    onRectLive?.(next)
  }, [hitTest, hoverId, pxToUv, onRectLive, onPivotChange])

  const handlePointerUp = useCallback((e) => {
    const d = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) { /* jsdom */ }
    if (!d || !d.moved || d.kind === 'pivot') return

    if (d.kind === 'rotate') {
      console.log('[XformView] rotation gesture committed:',
        `${d.startRect.rotDeg.toFixed(1)}deg -> ${d.lastRect.rotDeg.toFixed(1)}deg`,
        `(sweep ${d.acc.sweepDeg.toFixed(1)}deg, unwrapped)`)
    }
    onRectCommit?.(d.lastRect)
  }, [onRectCommit])

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    onContextMenu?.(e.clientX, e.clientY)
  }, [onContextMenu])

  const cursor = hoverId === 'rotate' ? 'grab'
    : hoverId === 'pivot' ? 'move'
    : hoverId === 'move' ? 'move'
    : hoverId ? 'crosshair'
    : 'default'

  return (
    <div ref={wrapRef} className="zpr-viewport-wrap">
      <canvas
        ref={canvasRef}
        className="zpr-viewport-canvas"
        style={{ width, height, cursor }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => { if (!dragRef.current) setHoverId(null) }}
        onContextMenu={handleContextMenu}
      />
    </div>
  )
}

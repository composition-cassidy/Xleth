import { useEffect, useMemo, useRef, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import useInspectorStore, { selectedTrackIdOf } from '../../stores/useInspectorStore.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import { isPicking } from '../grid/chromaKeyEyedropper.js'
import { useRoamValue, useTrackGeometry } from '../../lensRoam/useLensRoam.js'
import {
  cellGeometry, containRect, createAngleAccumulator, homeCorners, roamContains, roamIsIdentity, roamMoveOffset,
  roamQuad, roamScaleFromDrag,
} from '../../lensRoam/lensRoamModel.js'
import styles from './lensRoam.module.css'

// The viewer overlay: the selected track's cell outline over the preview picture,
// with Roam's move, scale and rotate handles, and its home cell dashed once it
// has moved. A canvas of its own over the picture (the grid editor's overlay is
// DOM and is left as it is; it replaces this one while Edit Grid is on).
//
//   drag inside the cell      move        (Shift: fine, a quarter of the travel)
//   drag a corner square      scale       about the cell centre
//   drag the round grip       rotate      about the cell centre (Shift: 15 degree steps)
//   Escape                    cancel the gesture; nothing is sent
//
// Local preview, one commit: pointermove only updates the shared Roam draft
// (so the inspector's boxes follow), pointerup sends ONE command. The canvas
// never takes pointer events itself; the parent is hit-tested, so the picture's
// other clicks (the chroma-key eyedropper) are untouched.

const HIT_PX = 10
const HANDLE_PX = 4.5
const GRIP_PX = 5
const STEM_PX = 24
const FINE = 0.25
const SNAP_DEG = 15

const tok = (name) => tokenValue(name)

export default function RoamOverlayCanvas({ aspect }) {
  const epoch = useThemeEpoch()
  const trackId = useInspectorStore((s) => selectedTrackIdOf(s.selection))
  const { layout, track, tracks } = useTrackGeometry(trackId)
  const { roam, ready, preview, commitDraft, cancel } = useRoamValue(trackId)
  const colors = useTrackIdentityColors(tracks)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])

  const canvasRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Where the picture sits in the canvas (the preview draws it object-fit: contain).
  const pic = useMemo(() => containRect(size.w, size.h, aspect > 0 ? aspect : 16 / 9), [size, aspect])

  const quad = useMemo(() => (geo && roam ? roamQuad(roam, geo) : null), [geo, roam])
  const toPx = (p) => ({ x: pic.x + p.x * pic.w, y: pic.y + p.y * pic.h })

  // The grip: STEM_PX out from the middle of the top edge, along the cell's own "up".
  const gripOf = (q) => {
    const tl = toPx(q.corners[0])
    const tr = toPx(q.corners[1])
    const mid = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 }
    const c = toPx(q.center)
    const dx = mid.x - c.x
    const dy = mid.y - c.y
    const len = Math.hypot(dx, dy) || 1
    return { mid, grip: { x: mid.x + (dx / len) * STEM_PX, y: mid.y + (dy / len) * STEM_PX } }
  }

  // ── draw ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.w * dpr))
    canvas.height = Math.max(1, Math.round(size.h * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    if (!geo || !quad) return

    const identity = roamIsIdentity(roam)
    const own = colors[trackId] ?? tok('--ui-select')
    const trace = (pts) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
    }

    // Home cell, dashed, only once the cell has left it.
    if (!identity) {
      trace(homeCorners(geo).map(toPx))
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = tok('--ui-ink-2')
      ctx.stroke()
      ctx.setLineDash([])
    }

    const px = quad.corners.map(toPx)
    // A dark keyline under the outline keeps it legible over any picture.
    trace(px)
    ctx.lineWidth = 3
    ctx.strokeStyle = tok('--ui-g0')
    ctx.stroke()
    trace(px)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = own
    ctx.stroke()

    // Move: a centre cross.
    const c = toPx(quad.center)
    const moveOn = hover === 'move'
    ctx.strokeStyle = moveOn ? tok('--ui-ink') : own
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(c.x - 5, c.y); ctx.lineTo(c.x + 5, c.y)
    ctx.moveTo(c.x, c.y - 5); ctx.lineTo(c.x, c.y + 5)
    ctx.stroke()

    // Scale: corner squares.
    px.forEach((p, i) => {
      ctx.fillStyle = hover === `corner${i}` ? tok('--ui-ink') : own
      ctx.fillRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
      ctx.strokeStyle = tok('--ui-g0')
      ctx.lineWidth = 1
      ctx.strokeRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
    })

    // Rotate: a stem and a round grip.
    const { mid, grip } = gripOf(quad)
    ctx.strokeStyle = own
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(mid.x, mid.y); ctx.lineTo(grip.x, grip.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(grip.x, grip.y, GRIP_PX, 0, Math.PI * 2)
    ctx.fillStyle = hover === 'rotate' ? tok('--ui-ink') : tok('--ui-g0')
    ctx.fill()
    ctx.strokeStyle = own
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [quad, geo, roam, size, pic, hover, colors, trackId, epoch])

  // ── interaction, on the parent ────────────────────────────────────────────
  // Read the latest values from a ref so the listeners attach once, not on every
  // preview (re-attaching mid-drag would drop the gesture).
  const live = useRef(null)
  live.current = { quad, geo, roam, pic, ready, preview, commitDraft, cancel, gripOf, toPx }

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return undefined

    let drag = null
    let pending = null       // the one patch waiting for the next animation frame
    let raf = 0
    let savedCursor = null

    const local = (e) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const uvOf = (p) => ({ u: (p.x - live.current.pic.x) / live.current.pic.w, v: (p.y - live.current.pic.y) / live.current.pic.h })

    const flush = () => {
      raf = 0
      if (pending) { live.current.preview(pending); pending = null }
    }
    const queue = (patch) => {
      pending = { ...(pending ?? {}), ...patch }
      if (!raf) raf = requestAnimationFrame(flush)
    }

    const hitTest = (p) => {
      const L = live.current
      if (!L.ready || !L.quad || !L.geo || L.pic.w <= 0) return null
      const { grip } = L.gripOf(L.quad)
      if (Math.hypot(p.x - grip.x, p.y - grip.y) <= HIT_PX) return 'rotate'
      for (let i = 0; i < 4; i++) {
        const c = L.toPx(L.quad.corners[i])
        if (Math.hypot(p.x - c.x, p.y - c.y) <= HIT_PX) return `corner${i}`
      }
      const { u, v } = uvOf(p)
      return roamContains(L.roam, L.geo, u, v) ? 'move' : null
    }

    const setCursor = (kind) => {
      if (kind) {
        if (savedCursor === null) savedCursor = parent.style.cursor
        parent.style.cursor = kind === 'move' ? 'move' : kind === 'rotate' ? 'grab' : 'nwse-resize'
      } else if (savedCursor !== null) {
        parent.style.cursor = savedCursor
        savedCursor = null
      }
    }

    const onDown = (e) => {
      if (e.button !== 0 || isPicking()) return
      const p = local(e)
      const kind = hitTest(p)
      if (!kind) return
      const L = live.current
      const c = L.toPx(L.quad.center)
      drag = {
        kind,
        start: { ...L.roam },
        last: p,
        acc: { x: 0, y: 0 },
        startDist: Math.hypot(p.x - c.x, p.y - c.y),
        angle: kind === 'rotate' ? createAngleAccumulator(Math.atan2(p.y - c.y, p.x - c.x), L.roam.rotationDeg) : null,
        moved: false,
      }
      e.stopPropagation()
      e.preventDefault()
      try { parent.setPointerCapture(e.pointerId) } catch { /* jsdom */ }
      window.addEventListener('keydown', onKey, true)
    }

    const onMove = (e) => {
      const p = local(e)
      if (!drag) {
        if (isPicking()) { setCursor(null); return }
        const h = hitTest(p)
        setCursor(h)
        setHover((prev) => (prev === h ? prev : h))
        return
      }
      const L = live.current
      drag.moved = true
      const c = L.toPx(L.quad.center)
      if (drag.kind === 'move') {
        const k = e.shiftKey ? FINE : 1
        drag.acc.x += (p.x - drag.last.x) * k
        drag.acc.y += (p.y - drag.last.y) * k
        drag.last = p
        queue(roamMoveOffset(drag.start, L.geo, drag.acc.x / L.pic.w, drag.acc.y / L.pic.h))
      } else if (drag.kind === 'rotate') {
        let deg = drag.angle.update(Math.atan2(p.y - c.y, p.x - c.x))
        if (e.shiftKey) deg = Math.round(deg / SNAP_DEG) * SNAP_DEG
        queue({ rotationDeg: deg })
      } else {
        queue({ scale: roamScaleFromDrag(drag.start.scale, drag.startDist, Math.hypot(p.x - c.x, p.y - c.y)) })
      }
    }

    const finish = (e, commit) => {
      if (!drag) return
      const d = drag
      drag = null
      window.removeEventListener('keydown', onKey, true)
      try { parent.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      if (pending) { live.current.preview(pending); pending = null }
      if (commit && d.moved) live.current.commitDraft()
      else live.current.cancel()
      e.stopPropagation?.()
    }
    const onUp = (e) => finish(e, true)
    const onCancelEvt = (e) => finish(e, false)
    const onKey = (e) => {
      if (e.key !== 'Escape' || !drag) return
      drag = null
      window.removeEventListener('keydown', onKey, true)
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      pending = null
      live.current.cancel()
      e.stopPropagation()
    }
    const onLeave = () => { if (!drag) { setCursor(null); setHover(null) } }

    parent.addEventListener('pointerdown', onDown, true)
    parent.addEventListener('pointermove', onMove, true)
    parent.addEventListener('pointerup', onUp, true)
    parent.addEventListener('pointercancel', onCancelEvt, true)
    parent.addEventListener('pointerleave', onLeave)
    return () => {
      parent.removeEventListener('pointerdown', onDown, true)
      parent.removeEventListener('pointermove', onMove, true)
      parent.removeEventListener('pointerup', onUp, true)
      parent.removeEventListener('pointercancel', onCancelEvt, true)
      parent.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey, true)
      if (raf) cancelAnimationFrame(raf)
      setCursor(null)
    }
  }, [])

  // The canvas takes no pointer events, so the hint bar (which reads the element
  // under the pointer) would never see it: document the handles on the picture
  // area itself while a placed track is selected.
  const placed = !!geo
  const trackName = track?.name ?? ''
  useEffect(() => {
    const parent = canvasRef.current?.parentElement
    if (!parent || !placed) return undefined
    const prevHint = parent.getAttribute('data-hint')
    const prevMods = parent.getAttribute('data-hint-mods')
    parent.setAttribute('data-hint', `Roam handles for ${trackName}: drag the cell to move it, a corner square to scale, the round grip to rotate. The dashed box is its grid box.`)
    parent.setAttribute('data-hint-mods', 'Drag: move / scale / rotate · Shift: fine move, 15° steps · Esc: cancel')
    return () => {
      if (prevHint === null) parent.removeAttribute('data-hint'); else parent.setAttribute('data-hint', prevHint)
      if (prevMods === null) parent.removeAttribute('data-hint-mods'); else parent.setAttribute('data-hint-mods', prevMods)
    }
  }, [placed, trackName])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-testid="roam-overlay-canvas"
      aria-hidden="true"
    />
  )
}

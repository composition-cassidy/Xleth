import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import useInspectorStore, { selectedTrackIdOf } from '../../stores/useInspectorStore.js'
import useRoamKeysStore, { DEFAULT_ROAM_CHANNEL } from '../../stores/useRoamKeysStore.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import { isPicking } from '../grid/chromaKeyEyedropper.js'
import { playheadTick, useRoamValue, useTrackGeometry } from '../../lensRoam/useLensRoam.js'
import {
  cellGeometry, containRect, createAngleAccumulator, homeCorners, roamContains, roamIsIdentity, roamMoveOffset,
  roamQuad, roamScaleFromDrag,
} from '../../lensRoam/lensRoamModel.js'
import {
  formatBarBeat, keyIndexAt, roamMotionPath, sameKeys, upsertKey,
} from '../../lensRoam/roamKeyModel.js'
import { uiCanvasFont } from '../../styles/typography.js'
import styles from './lensRoam.module.css'

// The viewer overlay: the selected track's cell outline over the preview picture,
// with Roam's move, scale and rotate handles, its home cell dashed once it has
// moved, and (P10) its motion path. A canvas of its own over the picture (the grid
// editor's overlay is DOM and is left as it is; it replaces this one while Edit
// Grid is on).
//
//   drag inside the cell      move        (Shift: fine, a quarter of the travel)
//   drag a corner square      scale       about the cell centre
//   drag the round grip       rotate      about the cell centre (Shift: 15 degree steps)
//   drag a dot on the path    move that key's position (Shift: fine)
//   Escape                    cancel the gesture; nothing is sent
//
// The handles sit where the cell is AT THE PLAYHEAD: a keyed track's outline moves
// with the playhead (drawn from the frame clock, never through React state). The
// dotted line is the cell's centre between its position keys; each dot is one tick
// that has an Offset X or Offset Y key.
//
// Keyed parameters: a move / scale / rotate of a parameter that has keys needs
// Auto-key (it then writes a key at the playhead); with Auto-key off the gesture is
// refused (cursor: not-allowed, the hint bar says why), because the base value it
// would change is ignored by a keyed parameter.
//
// Local preview, one commit: pointermove only updates a draft (the shared Roam draft
// for the cell, the shared key draft for a dot), pointerup sends ONE command. The
// canvas never takes pointer events itself; the parent is hit-tested, so the picture's
// other clicks (the chroma-key eyedropper) are untouched.

const HIT_PX = 10
const HANDLE_PX = 4.5
const GRIP_PX = 5
const STEM_PX = 24
const DOT_PX = 4
const FINE = 0.25
const SNAP_DEG = 15

const tok = (name) => tokenValue(name)

// The channels each handle gesture changes.
const CHANNELS_OF = {
  move: ['offsetX', 'offsetY'],
  rotate: ['rotationDeg'],
}
const channelsOf = (kind) => CHANNELS_OF[kind] ?? (kind.startsWith('corner') ? ['scale'] : [])

const HINT_BASE = (name) => `Roam handles for ${name}: drag the cell to move it, a corner square to scale, the round grip to rotate. The dashed box is its grid box. Dots on the dotted line are position keys: drag one to move it.`
const HINT_BLOCKED = 'This parameter is keyed, so it follows its keys. Turn on Auto-key to write a key at the playhead, edit its keys in the lane, or drag a dot on the path.'

export default function RoamOverlayCanvas({ aspect }) {
  const epoch = useThemeEpoch()
  const trackId = useInspectorStore((s) => selectedTrackIdOf(s.selection))
  const { layout, track, tracks } = useTrackGeometry(trackId)
  const R = useRoamValue(trackId)
  const { ready, keys, base, autoKey } = R
  const colors = useTrackIdentityColors(tracks)
  const geo = useMemo(() => cellGeometry(layout, track), [layout, track])
  const selectedKey = useRoamKeysStore((s) => s.selected)
  const lanePick = useRoamKeysStore((s) => s.channelByTrack[trackId]) ?? DEFAULT_ROAM_CHANNEL

  const canvasRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState(null)       // 'move' | 'rotate' | 'cornerN' | 'dotN' | null
  const [blockedHover, setBlockedHover] = useState(false)

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
  const path = useMemo(() => (geo && base ? roamMotionPath(base, keys, geo) : { dots: [], line: [] }), [geo, base, keys])

  // Everything the draw and the pointer handlers read, current as of the last render.
  const dragTick = useRef(null)                  // the tick a cell gesture began at (while one is in flight)
  const live = useRef(null)
  live.current = {
    geo, ready, pic, path, size, hover, trackId, autoKey, keys,
    own: colors[trackId], selectedKey, lanePick,
    resolveAt: R.resolveAt, preview: R.preview, commitDraft: R.commitDraft, cancel: R.cancel,
    commitKeys: R.commitKeys, keyed: R.keyed,
  }

  const roamNow = () => {
    const L = live.current
    return L.resolveAt(dragTick.current ?? playheadTick())
  }
  const toPx = (p) => {
    const { pic: pc } = live.current
    return { x: pc.x + p.x * pc.w, y: pc.y + p.y * pc.h }
  }
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
  // Imperative: React calls it when something changed, and the frame clock calls it
  // while the track has keys, so the outline follows the playhead with no render.
  const lastSize = useRef({ w: 0, h: 0, dpr: 0 })
  const drawNow = useCallback(() => {
    const canvas = canvasRef.current
    const L = live.current
    if (!canvas || !L || L.size.w <= 0 || L.size.h <= 0) return
    const dpr = window.devicePixelRatio || 1
    const ls = lastSize.current
    if (ls.w !== L.size.w || ls.h !== L.size.h || ls.dpr !== dpr) {
      canvas.width = Math.max(1, Math.round(L.size.w * dpr))
      canvas.height = Math.max(1, Math.round(L.size.h * dpr))
      lastSize.current = { w: L.size.w, h: L.size.h, dpr }
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, L.size.w, L.size.h)
    if (!L.geo || !L.ready) return

    const roam = roamNow()
    const quad = roamQuad(roam, L.geo)
    const identity = roamIsIdentity(roam) && L.keys.length === 0
    const base = L.own ?? tok('--ui-select')
    // Auto-key armed: the handles take the record colour (and say so in words below).
    const own = L.autoKey ? tok('--ui-rec') : base
    const trace = (pts) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
    }

    // Home cell, dashed, only once the cell has left it.
    if (!identity) {
      trace(homeCorners(L.geo).map(toPx))
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = tok('--ui-ink-2')
      ctx.stroke()
      ctx.setLineDash([])
    }

    // The motion path: the cell's centre between its position keys, dotted, with a
    // dark keyline so it reads over any picture; one dot per position key.
    const { dots, line } = L.path
    if (line.length > 1) {
      const pts = line.map(toPx)
      const stroke = (width, color) => {
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.setLineDash([2, 4])
        ctx.lineCap = 'round'
        ctx.lineWidth = width
        ctx.strokeStyle = color
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineCap = 'butt'
      }
      stroke(3.5, tok('--ui-g0'))
      stroke(1.5, own)
    }
    let labelled = null
    dots.forEach((d, i) => {
      const p = toPx(d)
      const sel = !!L.selectedKey && L.selectedKey.trackId === L.trackId
        && (L.selectedKey.channel === 'offsetX' || L.selectedKey.channel === 'offsetY')
        && Math.abs(L.selectedKey.pos - d.tick) < 0.5
      const on = L.hover === `dot${i}`
      ctx.beginPath()
      ctx.arc(p.x, p.y, sel || on ? DOT_PX + 1.5 : DOT_PX, 0, Math.PI * 2)
      ctx.fillStyle = on ? tok('--ui-ink') : own
      ctx.fill()
      ctx.lineWidth = sel ? 2 : 1
      ctx.strokeStyle = sel ? tok('--ui-select') : tok('--ui-g0')
      ctx.stroke()
      if (sel || on) labelled = { p, tick: d.tick }
    })
    if (labelled) {
      const text = formatBarBeat(labelled.tick)
      ctx.font = uiCanvasFont('10px')
      ctx.textBaseline = 'middle'
      const bw = Math.ceil(ctx.measureText(text).width) + 8
      ctx.fillStyle = tok('--ui-g0')
      ctx.fillRect(labelled.p.x + 8, labelled.p.y - 16, bw, 14)
      ctx.fillStyle = tok('--ui-ink')
      ctx.textAlign = 'left'
      ctx.fillText(text, labelled.p.x + 12, labelled.p.y - 9)
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
    const moveOn = L.hover === 'move'
    ctx.strokeStyle = moveOn ? tok('--ui-ink') : own
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(c.x - 5, c.y); ctx.lineTo(c.x + 5, c.y)
    ctx.moveTo(c.x, c.y - 5); ctx.lineTo(c.x, c.y + 5)
    ctx.stroke()

    // Scale: corner squares.
    px.forEach((p, i) => {
      ctx.fillStyle = L.hover === `corner${i}` ? tok('--ui-ink') : own
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
    ctx.fillStyle = L.hover === 'rotate' ? tok('--ui-ink') : tok('--ui-g0')
    ctx.fill()
    ctx.strokeStyle = own
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Auto-key says so in words, not only in the colour of the handles.
    if (L.autoKey) {
      ctx.font = uiCanvasFont('11px')
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const label = 'Auto-key'
      const lx = L.pic.x + 8
      const ly = L.pic.y + 8
      const lw = Math.ceil(ctx.measureText(label).width) + 22
      ctx.fillStyle = tok('--ui-g0')
      ctx.fillRect(lx, ly, lw, 18)
      ctx.fillStyle = tok('--ui-rec')
      ctx.beginPath()
      ctx.arc(lx + 9, ly + 9, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = tok('--ui-rec-text')
      ctx.fillText(label, lx + 17, ly + 3)
    }
  }, [])

  // React-driven changes (a draft, a new key list, the theme, the size, the hover).
  useEffect(() => { drawNow() }, [drawNow, geo, ready, size, pic, hover, keys, base, autoKey, path, selectedKey, colors, trackId, epoch, R.resolveAt])
  // Class A: a keyed track's cell follows the playhead, drawn from the frame clock.
  const animated = keys.length > 0
  useEffect(() => (animated ? playheadClock.onFrame(() => drawNow()) : undefined), [animated, drawNow])

  // ── interaction, on the parent ────────────────────────────────────────────
  // The listeners attach once and read `live`, so re-attaching mid-drag cannot drop a gesture.
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return undefined

    let drag = null
    let pending = null       // the one patch / key list waiting for the next animation frame
    let raf = 0
    let savedCursor = null

    const local = (e) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const uvOf = (p) => ({ u: (p.x - live.current.pic.x) / live.current.pic.w, v: (p.y - live.current.pic.y) / live.current.pic.h })

    const flush = () => {
      raf = 0
      if (!pending) return
      const job = pending
      pending = null
      job()
    }
    const queue = (job) => {
      pending = job
      if (!raf) raf = requestAnimationFrame(flush)
    }

    const isBlocked = (kind) => {
      const L = live.current
      return !L.autoKey && channelsOf(kind).some((c) => L.keyed.has(c))
    }

    const hitTest = (p) => {
      const L = live.current
      if (!L.ready || !L.geo || L.pic.w <= 0) return null
      const roam = roamNow()
      const quad = roamQuad(roam, L.geo)
      const { grip } = gripOf(quad)
      if (Math.hypot(p.x - grip.x, p.y - grip.y) <= HIT_PX) return 'rotate'
      for (let i = 0; i < 4; i++) {
        const c = toPx(quad.corners[i])
        if (Math.hypot(p.x - c.x, p.y - c.y) <= HIT_PX) return `corner${i}`
      }
      const dots = L.path.dots
      for (let i = 0; i < dots.length; i++) {
        const c = toPx(dots[i])
        if (Math.hypot(p.x - c.x, p.y - c.y) <= HIT_PX) return `dot${i}`
      }
      const { u, v } = uvOf(p)
      return roamContains(roam, L.geo, u, v) ? 'move' : null
    }

    const setCursor = (kind, blocked) => {
      if (kind) {
        if (savedCursor === null) savedCursor = parent.style.cursor
        parent.style.cursor = blocked ? 'not-allowed'
          : kind === 'move' ? 'move' : kind === 'rotate' ? 'grab' : kind.startsWith('dot') ? 'pointer' : 'nwse-resize'
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
      if (isBlocked(kind)) {
        // Refused, and said so (cursor + hint bar). Eat the click: a drag that does
        // nothing must not also start something under it.
        e.stopPropagation()
        e.preventDefault()
        return
      }
      const tick = Math.round(playheadTick())
      const roam = L.resolveAt(tick)
      const c = toPx(roamQuad(roam, L.geo).center)

      if (kind.startsWith('dot')) {
        const dot = L.path.dots[Number(kind.slice(3))]
        const at = Math.round(dot.tick)
        const startKeys = L.keys
        const startRoam = L.resolveAt(at)
        // Select the key the lane is showing if there is one at this tick, else the X key, else Y.
        const has = (ch) => keyIndexAt(startKeys, ch, at) >= 0
        const channel = has(L.lanePick) && (L.lanePick === 'offsetX' || L.lanePick === 'offsetY') ? L.lanePick
          : has('offsetX') ? 'offsetX' : 'offsetY'
        useRoamKeysStore.getState().select({ trackId: L.trackId, channel, pos: at })
        drag = {
          kind: 'dot', tick: at, startKeys, last: p, acc: { x: 0, y: 0 }, moved: false,
          start: { offsetX: startRoam.offsetX, offsetY: startRoam.offsetY }, nextKeys: startKeys,
        }
      } else {
        dragTick.current = tick
        drag = {
          kind,
          start: { ...roam },
          last: p,
          acc: { x: 0, y: 0 },
          startDist: Math.hypot(p.x - c.x, p.y - c.y),
          angle: kind === 'rotate' ? createAngleAccumulator(Math.atan2(p.y - c.y, p.x - c.x), roam.rotationDeg) : null,
          moved: false,
          tick,
        }
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
        const blocked = !!h && isBlocked(h)
        setCursor(h, blocked)
        setHover((prev) => (prev === h ? prev : h))
        setBlockedHover((prev) => (prev === blocked ? prev : blocked))
        return
      }
      const L = live.current
      drag.moved = true
      const c = toPx(roamQuad(L.resolveAt(drag.tick), L.geo).center)
      if (drag.kind === 'dot') {
        const k = e.shiftKey ? FINE : 1
        drag.acc.x += (p.x - drag.last.x) * k
        drag.acc.y += (p.y - drag.last.y) * k
        drag.last = p
        const off = roamMoveOffset(drag.start, L.geo, drag.acc.x / L.pic.w, drag.acc.y / L.pic.h)
        let next = upsertKey(drag.startKeys, { channel: 'offsetX', pos: drag.tick, value: off.offsetX })
        next = upsertKey(next, { channel: 'offsetY', pos: drag.tick, value: off.offsetY })
        drag.nextKeys = next
        queue(() => useRoamKeysStore.getState().setDraft(L.trackId, next))
      } else if (drag.kind === 'move') {
        const k = e.shiftKey ? FINE : 1
        drag.acc.x += (p.x - drag.last.x) * k
        drag.acc.y += (p.y - drag.last.y) * k
        drag.last = p
        const patch = roamMoveOffset(drag.start, L.geo, drag.acc.x / L.pic.w, drag.acc.y / L.pic.h)
        queue(() => L.preview(patch, drag?.tick))
      } else if (drag.kind === 'rotate') {
        let deg = drag.angle.update(Math.atan2(p.y - c.y, p.x - c.x))
        if (e.shiftKey) deg = Math.round(deg / SNAP_DEG) * SNAP_DEG
        queue(() => L.preview({ rotationDeg: deg }, drag?.tick))
      } else {
        const scale = roamScaleFromDrag(drag.start.scale, drag.startDist, Math.hypot(p.x - c.x, p.y - c.y))
        queue(() => L.preview({ scale }, drag?.tick))
      }
    }

    const endGesture = () => {
      window.removeEventListener('keydown', onKey, true)
      dragTick.current = null
    }

    const finish = (e, commit) => {
      if (!drag) return
      const d = drag
      drag = null
      endGesture()
      try { parent.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      if (pending) { const job = pending; pending = null; job() }
      const L = live.current
      if (d.kind === 'dot') {
        if (commit && d.moved && !sameKeys(d.nextKeys, d.startKeys)) L.commitKeys(d.nextKeys)
        else useRoamKeysStore.getState().clearDraft()
      } else if (commit && d.moved) {
        L.commitDraft()
      } else {
        L.cancel()
      }
      e.stopPropagation?.()
    }
    const onUp = (e) => finish(e, true)
    const onCancelEvt = (e) => finish(e, false)
    const onKey = (e) => {
      if (e.key !== 'Escape' || !drag) return
      const d = drag
      drag = null
      endGesture()
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      pending = null
      if (d.kind === 'dot') useRoamKeysStore.getState().clearDraft()
      else live.current.cancel()
      e.stopPropagation()
    }
    const onLeave = () => { if (!drag) { setCursor(null); setHover(null); setBlockedHover(false) } }

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
  // area itself while a placed track is selected, and say why when one is refused.
  const placed = !!geo
  const trackName = track?.name ?? ''
  useEffect(() => {
    const parent = canvasRef.current?.parentElement
    if (!parent || !placed) return undefined
    const prevHint = parent.getAttribute('data-hint')
    const prevMods = parent.getAttribute('data-hint-mods')
    parent.setAttribute('data-hint', blockedHover ? HINT_BLOCKED : HINT_BASE(trackName))
    parent.setAttribute('data-hint-mods', 'Drag: move / scale / rotate · Shift: fine move, 15° steps · Esc: cancel')
    return () => {
      if (prevHint === null) parent.removeAttribute('data-hint'); else parent.setAttribute('data-hint', prevHint)
      if (prevMods === null) parent.removeAttribute('data-hint-mods'); else parent.setAttribute('data-hint-mods', prevMods)
    }
  }, [placed, trackName, blockedHover])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-testid="roam-overlay-canvas"
      aria-hidden="true"
    />
  )
}

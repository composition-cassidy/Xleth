import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import useInspectorStore, { selectedTrackIdOf } from '../../stores/useInspectorStore.js'
import useRoamKeysStore, { DEFAULT_ROAM_CHANNEL } from '../../stores/useRoamKeysStore.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import { isPicking } from '../grid/chromaKeyEyedropper.js'
import { requestHintRefresh } from '../../ui-kit/hint.ts'
import { playheadTick, useRoamPose } from '../../lensRoam/useLensRoam.js'
import {
  containRect, createAngleAccumulator, roamIsIdentity, roamScaleFromDrag,
} from '../../lensRoam/lensRoamModel.js'
import {
  formatBarBeat, keyIndexAt, sameKeys, upsertKey,
} from '../../lensRoam/roamKeyModel.js'
import { poseContains } from '../../motion/parentModel.js'
import { insertVertexBlocker, shapeBounds, toWireList, validateMasks } from '../../motion/maskModel.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  ancestorsKeyed, chainMotionPath, dotOffsetOnScreen, homeBoxOf, moveOffsetOnScreen,
} from './roamOverlayPose.js'
import {
  ALT_DRAG_PX, MASK_HIT_PX, PEN_DRAG_PX, committedMasks, deletePoint, edgePointPx, hitActiveMask, hitMaskBodies, insertPoint,
  isSmoothPair, maskFramesAt, maskView, moveVertex, penAddPoint, penBlocker, penCanClose, penCreateMask,
  penDragPoint, penPointCap, penRelease, penStart, penUndoPoint, pullHandles, resizeByBox, sameMasks, setTangent,
  translateVertices, writeShape,
} from './maskOverlay.js'
import { drawMasks, drawPen, drawPenBadge } from './maskOverlayDrawing.js'
import { overlayHint } from './roamOverlayHints.js'
import { invalidateOverlayPalette, overlayPalette } from './roamOverlayPalette.js'
import styles from './lensRoam.module.css'

// The viewer overlay: the selected track's cell outline over the preview picture,
// with Roam's move, scale and rotate handles, its home cell dashed once it has
// moved, its motion path, and (Motion view) its Masks and the pen. A canvas of its
// own over the picture (the grid editor's overlay is DOM and is left as it is; it
// replaces this one while Edit Grid is on).
//
//   drag inside the cell      move        (Shift: fine, a quarter of the travel)
//   drag a corner square      scale       about the cell centre
//   drag the round grip       rotate      about the cell centre (Shift: 15 degree steps)
//   drag a dot on the path    move that key's position (Shift: fine)
//   Escape                    cancel the gesture; nothing is sent
//
// Parent (docs/XLETH_MOTION_VIEW_DESIGN.md 5.5, R7, R9): a parented cell is drawn
// where the chain puts it (parentModel.composePose): outline, handles, the home box
// as the parent carries it, and the motion path (sampled across every key that
// moves it when an ancestor is keyed). A drag maps back through the inverse chain
// to the child's OWN offset (roamOverlayPose); scale and rotate are ratios and
// angle sweeps, which the chain does not change. An unparented cell takes exactly
// the arithmetic it always did.
//
// Masks (5.5, R4, R11, R14): drawn while Motion view shows the track's Masks group
// or has a mask selected; the selected mask has handles (maskOverlay.js), and its
// handles are hit before the Roam handles. Every mask gesture is ONE setTrackMasks
// (runMotionPlan) on pointerup; an animated shape gets a shape key at the playhead.
// The pen (motionViewStore.penTool) owns the picture while it is on: click = corner
// point, click-drag = smooth point, the first point or Enter closes, Escape cancels.
//
// The handles sit where the cell is AT THE PLAYHEAD: a keyed track's outline moves
// with the playhead (drawn from the frame clock, never through React state).
//
// Keyed parameters: a move / scale / rotate of a parameter that has keys needs
// Auto-key (it then writes a key at the playhead); with Auto-key off the gesture is
// refused (cursor: not-allowed, the hint bar says why), because the base value it
// would change is ignored by a keyed parameter.
//
// Local preview, one commit: pointermove only updates a draft (the shared Roam draft
// for the cell, the shared key draft for a dot, a local mask list for a mask), and
// pointerup sends ONE command. The canvas never takes pointer events itself; the
// parent is hit-tested, so the picture's other clicks (the chroma-key eyedropper)
// are untouched.

const HIT_PX = 10
const HANDLE_PX = 4.5
const GRIP_PX = 5
const STEM_PX = 24
const DOT_PX = 4
const FINE = 0.25
const SNAP_DEG = 15

// The channels each handle gesture changes.
const CHANNELS_OF = {
  move: ['offsetX', 'offsetY'],
  rotate: ['rotationDeg'],
}
const channelsOf = (kind) => (typeof kind !== 'string' ? [] : CHANNELS_OF[kind] ?? (kind.startsWith('corner') ? ['scale'] : []))

const isMaskHit = (h) => !!h && typeof h === 'object'
/** A hover's identity for React state: a mask hit without its moving parts (t, at). */
const hitKey = (h) => (!h ? null : typeof h === 'string' ? h
  : `${h.kind}:${h.index ?? ''}:${h.i ?? h.corner ?? h.edgeIndex ?? ''}:${h.side ?? ''}`)
const stripHit = (h) => (isMaskHit(h) ? { kind: h.kind, index: h.index, i: h.i, side: h.side, corner: h.corner } : h)

/** Is a row and every row above it open in the Motion view tree? */
const rowOpen = (expanded, trackId) => [`t:${trackId}`, `t:${trackId}/roam`, `t:${trackId}/roam/masks`].every((k) => expanded.has(k))

const MASK_LABELS = {
  maskPoint: 'Move mask point', maskPointAlt: 'Mask point handles', maskTangent: 'Bend mask', maskBox: 'Resize mask',
  maskInside: 'Move mask', maskEdge: 'Add mask point',
}

export default function RoamOverlayCanvas({ aspect }) {
  const epoch = useThemeEpoch()
  const selectedTrack = useInspectorStore((s) => selectedTrackIdOf(s.selection))
  const pen = useMotionViewStore((s) => s.penTool)
  // The pen draws on its own track (Motion view's Add mask > Path); otherwise the
  // Inspector's track, as always.
  const trackId = pen && Number.isFinite(pen.trackId) ? pen.trackId : selectedTrack
  const P = useRoamPose(trackId)
  const { R, geo, track, tracks, tracksById, parented, ancestors, poseAt, poseWith, chainIds } = P
  const { ready, keys, base, autoKey, masks } = R
  const colors = useTrackIdentityColors(tracks)
  const selectedKey = useRoamKeysStore((s) => s.selected)
  const lanePick = useRoamKeysStore((s) => s.channelByTrack[trackId]) ?? DEFAULT_ROAM_CHANNEL
  const selectedMask = useMotionViewStore((s) => s.selectedMask)
  const masksOpen = useMotionViewStore((s) => trackId != null && s.view === 'motion' && rowOpen(s.expanded, trackId))

  const penActive = !!pen && pen.trackId === trackId && trackId != null
  const activeMaskId = selectedMask && selectedMask.trackId === trackId ? selectedMask.maskId : null
  const showMasks = penActive || (masks.length > 0 && (masksOpen || activeMaskId !== null))

  const canvasRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState(null)       // 'move' | 'rotate' | 'cornerN' | 'dotN' | a mask / pen hit | null
  const [blockedHover, setBlockedHover] = useState(false)
  const [note, setNote] = useState(null)         // a refused edit, said in the hint bar until the hover moves on
  const [penCount, setPenCount] = useState(0)    // pen points placed (the hint counts them; changes per click only)

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
  const path = useMemo(
    () => (geo && base ? chainMotionPath({ base, keys, geo, ancestors, poseAt: poseWith, parented }) : { dots: [], line: [] }),
    [geo, base, keys, ancestors, poseWith, parented],
  )
  const parentName = parented ? (tracksById.get(chainIds[0])?.name ?? `Track ${chainIds[0]}`) : null

  // Everything the draw and the pointer handlers read, current as of the last render.
  const dragTick = useRef(null)                  // the tick a gesture began at (while one is in flight)
  const hoverRef = useRef(null)                  // the full hit under the pointer (with an edge's moving point)
  const maskDraft = useRef(null)                 // { masks } while a mask gesture previews or its commit is in flight
  const penRef = useRef(null)                    // the pen's points while it draws
  const penPointer = useRef(null)                // the pointer in px, for the pen's rubber band
  const live = useRef(null)
  const activeIndex = activeMaskId === null ? -1 : masks.findIndex((m) => m.id === activeMaskId)
  live.current = {
    geo, ready, pic, path, size, trackId, autoKey, keys,
    own: colors[trackId], selectedKey, lanePick,
    resolveAt: R.resolveAt, preview: R.preview, commitDraft: R.commitDraft, cancel: R.cancel,
    commitKeys: R.commitKeys, keyed: R.keyed, commitMasks: R.commitMasks,
    poseAt, masks, showMasks, activeIndex, penActive, activeMaskId, masksOpen,
  }

  const tickNow = () => dragTick.current ?? playheadTick()
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
  const masksNow = () => maskDraft.current?.masks ?? live.current.masks
  const activeIndexOf = (list) => {
    const L = live.current
    if (L.activeIndex < 0) return -1
    const id = L.masks[L.activeIndex]?.id
    return list.findIndex((m) => m.id === id)
  }

  // ── draw ──────────────────────────────────────────────────────────────────
  // Imperative: React calls it when something changed, and the frame clock calls it
  // while something on the picture is animated, so the outline follows the playhead
  // with no render.
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

    const pal = overlayPalette()
    const t = tickNow()
    const roam = L.resolveAt(t)
    const pose = L.poseAt(t, roam)
    if (!pose) return
    const hv = hoverRef.current
    const identity = roamIsIdentity(roam) && L.keys.length === 0
    const trackColour = L.own ?? pal.select
    // Auto-key armed: the handles take the record colour (and say so in words below).
    const own = L.autoKey ? pal.rec : trackColour
    const trace = (pts) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
    }
    const px = pose.corners.map(toPx)
    const outline = () => {
      // A dark keyline under the outline keeps it legible over any picture.
      trace(px)
      ctx.lineWidth = 3
      ctx.strokeStyle = pal.g0
      ctx.stroke()
      trace(px)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = own
      ctx.stroke()
    }

    if (L.penActive) {
      // The pen owns the picture: the cell's outline for reference, its masks, the path being drawn.
      outline()
      const view = maskView(pose, L.geo, L.pic)
      const list = masksNow()
      drawMasks(ctx, view, maskFramesAt(list, t), -1, null, pal)
      const pts = penRef.current?.points ?? []
      drawPen(ctx, view, pts, penPointer.current, hitKey(hv) === hitKey({ kind: 'penClose' }), pal)
      drawPenBadge(ctx, pal, L.pic, pts.length ? `Pen · ${pts.length} point${pts.length === 1 ? '' : 's'}` : 'Pen')
      return
    }

    // Home cell, dashed, only once the cell has left it (carried by a parent: R9).
    if (!identity) {
      trace(homeBoxOf(pose, L.geo).map(toPx))
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = pal.ink2
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
      stroke(3.5, pal.g0)
      stroke(1.5, own)
    }
    let labelled = null
    dots.forEach((d, i) => {
      const p = toPx(d)
      const sel = !!L.selectedKey && L.selectedKey.trackId === L.trackId
        && (L.selectedKey.channel === 'offsetX' || L.selectedKey.channel === 'offsetY')
        && Math.abs(L.selectedKey.pos - d.tick) < 0.5
      const on = hv === `dot${i}`
      ctx.beginPath()
      ctx.arc(p.x, p.y, sel || on ? DOT_PX + 1.5 : DOT_PX, 0, Math.PI * 2)
      ctx.fillStyle = on ? pal.ink : own
      ctx.fill()
      ctx.lineWidth = sel ? 2 : 1
      ctx.strokeStyle = sel ? pal.select : pal.g0
      ctx.stroke()
      if (sel || on) labelled = { p, tick: d.tick }
    })
    if (labelled) {
      const text = formatBarBeat(labelled.tick)
      ctx.font = uiCanvasFont('10px')
      ctx.textBaseline = 'middle'
      const bw = Math.ceil(ctx.measureText(text).width) + 8
      ctx.fillStyle = pal.g0
      ctx.fillRect(labelled.p.x + 8, labelled.p.y - 16, bw, 14)
      ctx.fillStyle = pal.ink
      ctx.textAlign = 'left'
      ctx.fillText(text, labelled.p.x + 12, labelled.p.y - 9)
    }

    outline()

    // Move: a centre cross.
    const c = toPx(pose.center)
    const moveOn = hv === 'move'
    ctx.strokeStyle = moveOn ? pal.ink : own
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(c.x - 5, c.y); ctx.lineTo(c.x + 5, c.y)
    ctx.moveTo(c.x, c.y - 5); ctx.lineTo(c.x, c.y + 5)
    ctx.stroke()

    // Scale: corner squares.
    px.forEach((p, i) => {
      ctx.fillStyle = hv === `corner${i}` ? pal.ink : own
      ctx.fillRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
      ctx.strokeStyle = pal.g0
      ctx.lineWidth = 1
      ctx.strokeRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
    })

    // Rotate: a stem and a round grip.
    const { mid, grip } = gripOf(pose)
    ctx.strokeStyle = own
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(mid.x, mid.y); ctx.lineTo(grip.x, grip.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(grip.x, grip.y, GRIP_PX, 0, Math.PI * 2)
    ctx.fillStyle = hv === 'rotate' ? pal.ink : pal.g0
    ctx.fill()
    ctx.strokeStyle = own
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Masks on top: their handles win the pointer, so they are drawn where they can be seen.
    if (L.showMasks) {
      const list = masksNow()
      drawMasks(ctx, maskView(pose, L.geo, L.pic), maskFramesAt(list, t), activeIndexOf(list), isMaskHit(hv) ? hv : null, pal)
    }

    // Auto-key says so in words, not only in the colour of the handles.
    if (L.autoKey) {
      ctx.font = uiCanvasFont('11px')
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const label = 'Auto-key'
      const lx = L.pic.x + 8
      const ly = L.pic.y + 8
      const lw = Math.ceil(ctx.measureText(label).width) + 22
      ctx.fillStyle = pal.g0
      ctx.fillRect(lx, ly, lw, 18)
      ctx.fillStyle = pal.rec
      ctx.beginPath()
      ctx.arc(lx + 9, ly + 9, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = pal.recText
      ctx.fillText(label, lx + 17, ly + 3)
    }
  }, [])

  // A theme change (or a DPR change) resolves the palette again.
  useEffect(() => { invalidateOverlayPalette() }, [epoch])
  // React-driven changes (a draft, a new key list, the theme, the size, the hover).
  useEffect(() => { drawNow() }, [
    drawNow, geo, ready, size, pic, hover, keys, base, autoKey, path, selectedKey, colors, trackId, epoch, R.resolveAt,
    poseAt, masks, showMasks, activeIndex, penActive, penCount,
  ])
  // Class A: a cell that follows the playhead is drawn from the frame clock: its own
  // keys, a keyed ancestor, or a shown mask with keys.
  const masksAnimated = showMasks && masks.some((m) => (m.keys?.length ?? 0) > 0 || (m.shapeKeys?.length ?? 0) > 0)
  const animated = keys.length > 0 || (parented && ancestorsKeyed(ancestors)) || masksAnimated
  useEffect(() => (animated ? playheadClock.onFrame(() => drawNow()) : undefined), [animated, drawNow])

  // The pen goes away, is armed again, or moves straight to another track (Motion
  // view's Add mask > Path stores a NEW penTool each time): drop its points, so a
  // path never mixes points placed in two cells. The epoch retires a pen press still
  // in flight, so it cannot write into the new path.
  const penEpoch = useRef(0)
  useEffect(() => {
    penEpoch.current++
    penRef.current = null
    penPointer.current = null
    setPenCount(0)
  }, [pen, penActive])

  // ── interaction, on the parent ────────────────────────────────────────────
  // The listeners attach once and read `live`, so re-attaching mid-drag cannot drop a gesture.
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return undefined

    let drag = null
    let pending = null       // the one patch / key list waiting for the next animation frame
    let raf = 0
    let drawRaf = 0
    let savedCursor = null
    let lastPointer = null   // the pointer over the picture (px), for a hover re-read when Ctrl goes down or up

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
    // A redraw with no React state (a mask draft, the pen's rubber band, an edge marker).
    const scheduleDraw = () => {
      if (!drawRaf) drawRaf = requestAnimationFrame(() => { drawRaf = 0; drawNow() })
    }
    const setHoverHit = (h) => {
      hoverRef.current = h
      const key = hitKey(h)
      setHover((prev) => (hitKey(prev) === key ? prev : stripHit(h)))
    }

    const isBlocked = (kind) => {
      const L = live.current
      return !L.autoKey && channelsOf(kind).some((c) => L.keyed.has(c))
    }

    const poseNow = () => {
      const L = live.current
      const t = tickNow()
      return { t, pose: L.poseAt(t) }
    }

    const hitTest = (p, e) => {
      const L = live.current
      if (!L.ready || !L.geo || L.pic.w <= 0) return null
      const { t, pose } = poseNow()
      if (!pose) return null
      let view = null
      let frames = null
      // What is on screen: a commit still in flight shows (and is hit as) its draft.
      const list = masksNow()
      const ai = activeIndexOf(list)
      if (L.showMasks && list.length) {
        view = maskView(pose, L.geo, L.pic)
        frames = maskFramesAt(list, t)
        // The active mask's handles first (5.5): they sit inside the cell, over the Roam handles.
        if (ai >= 0 && frames[ai]) {
          const h = hitActiveMask(view, frames[ai].mask, ai, frames[ai].vertices, p, { ctrl: !!(e?.ctrlKey || e?.metaKey) })
          if (h) return h.kind === 'maskEdge' ? { ...h, at: edgePointPx(view, frames[ai].vertices, h.edgeIndex, h.t) } : h
        }
      }
      const { grip } = gripOf(pose)
      if (Math.hypot(p.x - grip.x, p.y - grip.y) <= HIT_PX) return 'rotate'
      for (let i = 0; i < 4; i++) {
        const c = toPx(pose.corners[i])
        if (Math.hypot(p.x - c.x, p.y - c.y) <= HIT_PX) return `corner${i}`
      }
      const dots = L.path.dots
      for (let i = 0; i < dots.length; i++) {
        const c = toPx(dots[i])
        if (Math.hypot(p.x - c.x, p.y - c.y) <= HIT_PX) return `dot${i}`
      }
      if (frames) {
        const b = hitMaskBodies(view, frames, ai, p)
        if (b) return b
      }
      const { u, v } = uvOf(p)
      return poseContains(pose, L.geo, u, v) ? 'move' : null
    }

    const CURSOR_OF = {
      maskPoint: 'move', maskTangent: 'pointer', maskEdge: 'crosshair', maskInside: 'move', maskSelect: 'pointer',
      pen: 'crosshair', penClose: 'pointer',
    }
    const setCursor = (kind, blocked) => {
      if (kind) {
        if (savedCursor === null) savedCursor = parent.style.cursor
        let cur
        if (blocked) cur = 'not-allowed'
        else if (isMaskHit(kind)) {
          cur = kind.kind === 'maskBox' ? (kind.corner % 2 === 0 ? 'nwse-resize' : 'nesw-resize') : CURSOR_OF[kind.kind] ?? 'default'
        } else cur = kind === 'move' ? 'move' : kind === 'rotate' ? 'grab' : kind.startsWith('dot') ? 'pointer' : 'nwse-resize'
        parent.style.cursor = cur
      } else if (savedCursor !== null) {
        parent.style.cursor = savedCursor
        savedCursor = null
      }
    }

    const eat = (e) => {
      e.stopPropagation()
      e.preventDefault()
    }
    const capture = (e) => {
      try { parent.setPointerCapture(e.pointerId) } catch { /* jsdom */ }
    }

    // ── masks ──────────────────────────────────────────────────────────────
    const maskDown = (e, p, hit) => {
      const L = live.current
      const tick = Math.round(playheadTick())
      const pose = L.poseAt(tick)
      if (!pose) return
      // Built on what is on screen: an edit whose commit is still in flight is not lost.
      const masks0 = masksNow()
      if (hit.kind === 'maskSelect') {
        useMotionViewStore.getState().setSelectedMask({ trackId: L.trackId, maskId: masks0[hit.index].id })
        eat(e)
        return
      }
      const view = maskView(pose, L.geo, L.pic)
      let list = masks0
      let kind = hit.kind
      let i = hit.i
      if (kind === 'maskEdge') {
        const r = insertPoint(masks0, hit.index, hit.edgeIndex, hit.t)
        if (r.error) { setNote(r.error); eat(e); return }
        list = r.masks
        i = r.i
        kind = 'maskPoint'
      } else if (kind === 'maskPoint' && e.altKey) {
        kind = 'maskPointAlt'
      }
      const verts0 = maskFramesAt(list, tick)[hit.index].vertices
      drag = {
        kind,
        label: MASK_LABELS[hit.kind === 'maskEdge' ? 'maskEdge' : kind],
        index: hit.index,
        i,
        side: hit.side,
        corner: hit.corner,
        tick,
        view,
        masks0,
        list,
        verts0,
        box0: kind === 'maskBox' ? shapeBounds({ vertices: verts0 }) : null,
        smooth: kind === 'maskTangent' ? isSmoothPair(verts0[i]) : false,
        down: p,
        last: p,
        acc: { x: 0, y: 0 },
        moved: false,
        pulled: false,
        next: list,
      }
      dragTick.current = tick
      maskDraft.current = { masks: list }
      setNote(null)
      eat(e)
      capture(e)
      window.addEventListener('keydown', onKey, true)
      drawNow()
    }

    const maskMove = (e, p) => {
      const d = drag
      const fine = e.shiftKey && (d.kind === 'maskPoint' || d.kind === 'maskInside') ? FINE : 1
      d.acc.x += (p.x - d.last.x) * fine
      d.acc.y += (p.y - d.last.y) * fine
      d.last = p
      d.moved = true
      const at = { x: d.down.x + d.acc.x, y: d.down.y + d.acc.y }
      const c0 = d.view.toCell(d.down)
      const c1 = d.view.toCell(at)
      const dx = c1[0] - c0[0]
      const dy = c1[1] - c0[1]
      const v0 = d.verts0[d.i ?? 0]
      let verts = null
      let toPath = false
      if (d.kind === 'maskPoint') {
        verts = moveVertex(d.verts0, d.i, dx, dy)
        toPath = true
      } else if (d.kind === 'maskPointAlt') {
        if (!d.pulled && Math.hypot(p.x - d.down.x, p.y - d.down.y) < ALT_DRAG_PX) return
        d.pulled = true
        verts = pullHandles(d.verts0, d.i, [c1[0] - v0[0], c1[1] - v0[1]])
        toPath = true
      } else if (d.kind === 'maskTangent') {
        const hx = v0[0] + (d.side === 'in' ? v0[2] : v0[4])
        const hy = v0[1] + (d.side === 'in' ? v0[3] : v0[5])
        const rel = [hx + dx - v0[0], hy + dy - v0[1]]
        verts = setTangent(d.verts0, d.i, d.side, rel, { start: v0, smooth: d.smooth, breakPair: e.altKey })
        toPath = true
      } else if (d.kind === 'maskBox') {
        verts = resizeByBox(d.verts0, d.box0, d.corner, dx, dy, { keepAspect: e.shiftKey })
      } else if (d.kind === 'maskInside') {
        verts = translateVertices(d.verts0, dx, dy)
      }
      if (!verts) return
      d.next = writeShape(d.list, d.index, d.tick, verts, { toPath })
      maskDraft.current = { masks: d.next }
      scheduleDraw()
    }

    // A mask commit answered: the engine's list is what the canvas draws and hit-tests
    // from now on. The hook only SCHEDULES its render (an async context), and the
    // draft is cleared right after this, so without it the pre-edit list would show
    // (and take clicks) until React renders. The next render brings the same list.
    const adoptCommitted = (res, trackId) => {
      const L = live.current
      if (!L || L.trackId !== trackId) return
      const list = committedMasks(res, trackId)
      if (!list) return
      L.masks = list
      L.activeIndex = L.activeMaskId === null ? -1 : list.findIndex((m) => m.id === L.activeMaskId)
      L.showMasks = L.penActive || (list.length > 0 && (L.masksOpen || L.activeMaskId !== null))
    }

    const maskFinish = (d, commit) => {
      let next = d.next
      if (commit && d.kind === 'maskPointAlt' && !d.pulled) {
        const r = deletePoint(d.masks0, d.index, d.i)
        if (r.error) { setNote(r.error); next = d.masks0 } else { next = r.masks; d.label = 'Delete mask point' }
      }
      if (!commit || sameMasks(next, d.masks0)) {
        maskDraft.current = null
        drawNow()
        return
      }
      const check = validateMasks(toWireList(next))
      if (!check.ok) {
        console.warn('[LensBridge] mask edit not sent:', check.error)
        setNote(check.error)
        maskDraft.current = null
        drawNow()
        return
      }
      // The draft stays on screen until the engine's post-state replaces it (no flicker).
      const mark = { masks: next }
      maskDraft.current = mark
      drawNow()
      const trackId = live.current.trackId
      Promise.resolve(live.current.commitMasks(next, d.label ?? 'Edit mask')).then((res) => adoptCommitted(res, trackId)).finally(() => {
        if (maskDraft.current === mark) maskDraft.current = null
        drawNow()
      })
    }

    // ── the pen ────────────────────────────────────────────────────────────
    const penView = () => {
      const L = live.current
      if (!L.ready || !L.geo || L.pic.w <= 0) return null
      const { pose } = poseNow()
      return pose ? maskView(pose, L.geo, L.pic) : null
    }
    const penClosesAt = (view, p) => {
      const pts = penRef.current?.points ?? []
      if (pts.length < 3) return false
      const f = view.toPx([pts[0][0], pts[0][1]])
      return Math.hypot(p.x - f.x, p.y - f.y) <= MASK_HIT_PX
    }
    const setPen = (next) => {
      penRef.current = next
      setPenCount(next?.points?.length ?? 0)
    }
    const closePen = () => {
      const L = live.current
      const pn = penRef.current
      if (!pn || !penCanClose(pn)) { setNote('A mask needs at least 3 points: place more, or press Esc to cancel'); return }
      const r = penCreateMask(masksNow(), pn)
      if (r.error) { setNote(r.error); return }
      const check = validateMasks(toWireList(r.masks))
      if (!check.ok) { setNote(check.error); return }
      const trackId = L.trackId
      const mark = { masks: r.masks }
      maskDraft.current = mark
      setPen(null)
      penPointer.current = null
      const st = useMotionViewStore.getState()
      Promise.resolve(L.commitMasks(r.masks, 'Add mask')).then((res) => adoptCommitted(res, trackId)).finally(() => {
        if (maskDraft.current === mark) maskDraft.current = null
        drawNow()
      })
      st.setSelectedMask({ trackId, maskId: r.mask.id })
      st.expandPath(`t:${trackId}/roam/masks`)
      st.setPenTool(null)
    }
    const cancelPen = () => {
      setPen(null)
      penPointer.current = null
      useMotionViewStore.getState().setPenTool(null)
    }

    const penDown = (e, p) => {
      eat(e)
      const L = live.current
      const view = penView()
      if (!view) { setNote('This track has no cell on the picture at the playhead, so there is nothing to draw a mask on'); return }
      const pn = penRef.current ?? penStart()
      if (pn.points.length === 0) {
        const blocker = penBlocker(L.masks)
        if (blocker) { setNote(`${blocker}. Delete a mask or some of its points to draw another`); return }
      }
      if (penClosesAt(view, p)) { closePen(); return }
      if (pn.points.length >= penPointCap(L.masks)) {
        setNote(`This path has as many points as it can take (${penPointCap(L.masks)}): click the first point or press Enter to close it`)
        return
      }
      setNote(null)
      setPen(penAddPoint(pn, view.toCell(p)))
      drag = { kind: 'pen', down: p, view, moved: false, epoch: penEpoch.current }
      capture(e)
      drawNow()
    }

    // ── the cell (Roam) ────────────────────────────────────────────────────
    const roamDown = (e, p, kind) => {
      const L = live.current
      if (isBlocked(kind)) {
        // Refused, and said so (cursor + hint bar). Eat the click: a drag that does
        // nothing must not also start something under it.
        eat(e)
        return
      }
      const tick = Math.round(playheadTick())
      const roam = L.resolveAt(tick)
      const pose = L.poseAt(tick, roam)
      const c = toPx(pose.center)

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
          pose: L.poseAt(at, startRoam),
        }
      } else {
        dragTick.current = tick
        drag = {
          kind,
          start: { ...roam },
          pose,
          last: p,
          acc: { x: 0, y: 0 },
          startDist: Math.hypot(p.x - c.x, p.y - c.y),
          angle: kind === 'rotate' ? createAngleAccumulator(Math.atan2(p.y - c.y, p.x - c.x), roam.rotationDeg) : null,
          moved: false,
          tick,
        }
      }
      eat(e)
      capture(e)
      window.addEventListener('keydown', onKey, true)
    }

    const onDown = (e) => {
      if (e.button !== 0 || isPicking()) return
      const p = local(e)
      if (live.current.penActive) { penDown(e, p); return }
      const hit = hitTest(p, e)
      if (!hit) return
      if (isMaskHit(hit)) maskDown(e, p, hit)
      else roamDown(e, p, hit)
    }

    const onMove = (e) => {
      const p = local(e)
      const L = live.current
      lastPointer = p
      if (!drag) {
        if (isPicking()) { setCursor(null); return }
        if (L.penActive) {
          penPointer.current = p
          const view = penView()
          const h = view && penClosesAt(view, p) ? { kind: 'penClose' } : { kind: 'pen' }
          setCursor(h, false)
          setHoverHit(h)
          setBlockedHover(false)
          scheduleDraw()
          return
        }
        const h = hitTest(p, e)
        const blocked = !!h && isBlocked(h)
        setCursor(h, blocked)
        const was = hitKey(hoverRef.current)
        setHoverHit(h)
        if (hitKey(h) !== was) setNote(null)
        if (isMaskHit(h) && h.kind === 'maskEdge') scheduleDraw()
        setBlockedHover((prev) => (prev === blocked ? prev : blocked))
        return
      }
      if (drag.kind === 'pen') {
        // The path this press belongs to was dropped (the pen moved on): the press is over.
        if (drag.epoch !== penEpoch.current || !penRef.current) { drag = null; return }
        if (!drag.moved && Math.hypot(p.x - drag.down.x, p.y - drag.down.y) < PEN_DRAG_PX) return
        drag.moved = true
        penRef.current = penDragPoint(penRef.current, drag.view.toCell(p))
        penPointer.current = null
        scheduleDraw()
        return
      }
      if (drag.kind.startsWith('mask')) { maskMove(e, p); return }
      drag.moved = true
      const c = toPx(L.poseAt(drag.tick).center)
      if (drag.kind === 'dot') {
        const k = e.shiftKey ? FINE : 1
        drag.acc.x += (p.x - drag.last.x) * k
        drag.acc.y += (p.y - drag.last.y) * k
        drag.last = p
        const off = dotOffsetOnScreen(drag.pose, L.geo, drag.start, drag.acc.x / L.pic.w, drag.acc.y / L.pic.h)
        let next = upsertKey(drag.startKeys, { channel: 'offsetX', pos: drag.tick, value: off.offsetX })
        next = upsertKey(next, { channel: 'offsetY', pos: drag.tick, value: off.offsetY })
        drag.nextKeys = next
        queue(() => useRoamKeysStore.getState().setDraft(L.trackId, next))
      } else if (drag.kind === 'move') {
        const k = e.shiftKey ? FINE : 1
        drag.acc.x += (p.x - drag.last.x) * k
        drag.acc.y += (p.y - drag.last.y) * k
        drag.last = p
        const patch = moveOffsetOnScreen(drag.pose, L.geo, drag.start, drag.acc.x / L.pic.w, drag.acc.y / L.pic.h)
        queue(() => L.preview(patch, drag?.tick))
      } else if (drag.kind === 'rotate') {
        let deg = drag.angle.update(Math.atan2(p.y - c.y, p.x - c.x))
        if (e.shiftKey) deg = Math.round(deg / SNAP_DEG) * SNAP_DEG
        queue(() => L.preview({ rotationDeg: deg }, drag?.tick))
      } else {
        const scale = roamScaleFromDrag(drag.start.scale, drag.startDist, Math.hypot(p.x - c.x, p.y - c.y))
        // Free (unlinked) axes keep their ratio: both scale by the same factor.
        const patch = drag.start.scaleLinked === false
          ? { scale, scaleY: roamScaleFromDrag(drag.start.scaleY ?? 1, drag.startDist, Math.hypot(p.x - c.x, p.y - c.y)) }
          : { scale }
        queue(() => L.preview(patch, drag?.tick))
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
      if (d.kind === 'pen') {
        if (penRef.current && d.epoch === penEpoch.current) penRef.current = penRelease(penRef.current)
        drawNow()
      } else if (d.kind.startsWith('mask')) {
        maskFinish(d, commit)
      } else if (d.kind === 'dot') {
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
    function onKey(e) {
      if (e.key !== 'Escape' || !drag || drag.kind === 'pen') return
      const d = drag
      drag = null
      endGesture()
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      pending = null
      if (d.kind.startsWith('mask')) { maskDraft.current = null; drawNow() }
      else if (d.kind === 'dot') useRoamKeysStore.getState().clearDraft()
      else live.current.cancel()
      e.stopPropagation()
    }
    // The pen's keys, whenever the pen is on: Enter closes, Escape cancels, Backspace
    // takes the last point off. They are the pen's alone while it is on.
    const onPenKey = (e) => {
      if (!live.current.penActive) return
      // Typing in a field (a mask's name, a value) is not a pen key.
      const tgt = e.target
      if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName ?? ''))) return
      if (e.key === 'Escape') {
        if (drag?.kind === 'pen') { drag = null; dragTick.current = null }
        cancelPen()
      } else if (e.key === 'Enter') {
        if (drag?.kind === 'pen') return
        closePen()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        // Eaten even with no point to take off: while the pen is on, Delete must not reach Motion view's keys.
        if (drag?.kind !== 'pen' && penRef.current?.points.length) {
          setPen(penUndoPoint(penRef.current))
          drawNow()
        }
      } else {
        return
      }
      e.stopPropagation()
      e.preventDefault()
    }
    // Ctrl pressed or let go over a still pointer: the active mask's edge becomes (or
    // stops being) an add-point target, so the hover, marker, cursor and hint follow.
    const onCtrl = (e) => {
      if (e.key !== 'Control' && e.key !== 'Meta') return
      const L = live.current
      if (drag || !lastPointer || L.penActive || !L.showMasks || L.activeIndex < 0 || isPicking()) return
      const ctrl = e.type === 'keydown'
      const h = hitTest(lastPointer, { ctrlKey: ctrl, metaKey: false })
      if (hitKey(h) === hitKey(hoverRef.current)) return
      const blocked = !!h && isBlocked(h)
      setCursor(h, blocked)
      setHoverHit(h)
      setNote(null)
      setBlockedHover(blocked)
      scheduleDraw()
    }
    const onLeave = () => {
      lastPointer = null
      if (drag) return
      setCursor(null)
      setHoverHit(null)
      setBlockedHover(false)
      if (penPointer.current) { penPointer.current = null; scheduleDraw() }
    }

    parent.addEventListener('pointerdown', onDown, true)
    parent.addEventListener('pointermove', onMove, true)
    parent.addEventListener('pointerup', onUp, true)
    parent.addEventListener('pointercancel', onCancelEvt, true)
    parent.addEventListener('pointerleave', onLeave)
    window.addEventListener('keydown', onPenKey, true)
    window.addEventListener('keydown', onCtrl)
    window.addEventListener('keyup', onCtrl)
    return () => {
      window.removeEventListener('keydown', onCtrl)
      window.removeEventListener('keyup', onCtrl)
      parent.removeEventListener('pointerdown', onDown, true)
      parent.removeEventListener('pointermove', onMove, true)
      parent.removeEventListener('pointerup', onUp, true)
      parent.removeEventListener('pointercancel', onCancelEvt, true)
      parent.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onPenKey, true)
      if (raf) cancelAnimationFrame(raf)
      if (drawRaf) cancelAnimationFrame(drawRaf)
      setCursor(null)
    }
  }, [])

  // The canvas takes no pointer events, so the hint bar (which reads the element
  // under the pointer) would never see it: document the handles on the picture
  // area itself while a placed track is selected, say why when one is refused, and
  // ask the hint bar to read it again when it changes under a still pointer.
  const placed = !!geo
  const trackName = track?.name ?? ''
  const hoverMask = isMaskHit(hover) && Number.isInteger(hover.index) ? masks[hover.index] : null
  const insertBlocker = isMaskHit(hover) && hover.kind === 'maskEdge' && hoverMask ? insertVertexBlocker(masks, hover.index) : null
  const { hint, mods } = overlayHint({
    hover,
    blocked: blockedHover,
    trackName,
    parentName,
    masks,
    masksShown: showMasks,
    pen: penActive ? { points: penCount, cap: penPointCap(masks), blocker: penCount === 0 ? penBlocker(masks) : null } : null,
    note,
    insertBlocker,
  })
  useEffect(() => {
    const parent = canvasRef.current?.parentElement
    if (!parent || !placed) return undefined
    const prevHint = parent.getAttribute('data-hint')
    const prevMods = parent.getAttribute('data-hint-mods')
    parent.setAttribute('data-hint', hint)
    parent.setAttribute('data-hint-mods', mods)
    requestHintRefresh(null)
    return () => {
      if (prevHint === null) parent.removeAttribute('data-hint'); else parent.setAttribute('data-hint', prevHint)
      if (prevMods === null) parent.removeAttribute('data-hint-mods'); else parent.setAttribute('data-hint-mods', prevMods)
    }
  }, [placed, hint, mods])

  return (
    <canvas
      ref={canvasRef}
      className={styles.overlay}
      data-testid="roam-overlay-canvas"
      data-pen={penActive || undefined}
      aria-hidden="true"
    />
  )
}

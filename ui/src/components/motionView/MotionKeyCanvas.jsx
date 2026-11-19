import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { backingSize, getDpr, subscribeDpr } from '../../ui-kit/dpr'
import { requestHintRefresh } from '../../ui-kit/hint'
import { playheadClock } from '../../services/PlayheadClock.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import {
  drawKeysLayer, drawOverlayLayer, drawStaticLayer, hitTestKey, invalidateMotionPalette,
} from './motionDrawing.js'
import { motionGraphPainter } from './motionInteraction.js'
import styles from './MotionView.module.css'

// The key area of Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 5.4, R24): a native
// vertical scroller (the view's own; Edit view keeps its own) holding a spacer as
// tall as the rows and a STICKY stage the size of the visible viewport. The stage
// stacks three canvases: static (rows, grid, reference strip, guides), keys, and the
// overlay (playhead, marquee, snap line). Every paint draws only the visible rows
// at (row.y - scrollTop); vertical scroll, zoom and horizontal scroll repaint the
// viewport, never a content-tall backing store.
//
// No React render per frame: the playhead follows playheadClock.onFrame into the
// overlay; key selection, row selection and a gesture's draft reach the canvas
// through store subscriptions; the parent pushes viewport changes through the
// imperative handle. Hints follow the row under the pointer ('xleth-hint-refresh').
//
// Props: layout, data, ppbRef, scrollOffsetRef, snapGranularity, colorOf(trackId),
// mutedOf(trackId), onWheel(e), onScroll(scrollTop), onPointerDown(e, ctx),
// hintFor(hit) -> { hint, mods }, bottomPad.
// Handle: redraw(), drawOverlay(), scroller(), stage(), viewport(), setScrollTop(y), view().

const LAYERS = ['static', 'keys', 'overlay']

export const KEY_AREA_HINT = "Motion keys: each row's keys on the timeline"
export const KEY_AREA_MODS = 'Click a key: select · Shift: add · Ctrl: toggle · Drag: move or box-select · Alt: no snap · Ctrl+wheel: zoom · Alt+wheel: row height'

function draftKeyTick(draft) {
  const m = draft?.keyTicks
  if (!(m instanceof Map) || m.size === 0) return null
  return (k) => { const t = m.get(k.id); return t === undefined ? k.tick : t }
}

const MotionKeyCanvas = forwardRef(function MotionKeyCanvas(props, ref) {
  const { layout, bottomPad = 24 } = props
  const scrollerRef = useRef(null)
  const stageRef = useRef(null)
  const canvases = useRef({ static: null, keys: null, overlay: null })
  const size = useRef({ w: 0, h: 0, dpr: 1 })
  const live = useRef(props)
  live.current = props
  const lastHint = useRef('')

  const view = useCallback(() => {
    const p = live.current
    const s = useMotionViewStore.getState()
    return {
      layout: p.layout,
      data: p.data,
      w: size.current.w,
      h: size.current.h,
      scrollTop: scrollerRef.current?.scrollTop ?? 0,
      scrollOffset: p.scrollOffsetRef?.current ?? 0,
      ppb: p.ppbRef?.current ?? 0,
      snapGranularity: p.snapGranularity,
      selectedRows: s.selectedRows,
      keySel: s.keySel,
      keyTick: draftKeyTick(s.draft),
      marquee: s.draft?.marquee ?? null,
      snapTick: s.draft?.snapTick,
      playheadBeat: playheadClock.positionBeats,
      colorOf: p.colorOf,
      mutedOf: p.mutedOf,
      graph: s.graph,
      focusedRow: s.focusedRow,
      draft: s.draft,
    }
  }, [])

  const ctxOf = (layer) => {
    const c = canvases.current[layer]
    if (!c) return null
    const ctx = c.getContext?.('2d')
    if (!ctx) return null
    const dpr = size.current.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  const paint = useCallback((which) => {
    if (!live.current.layout || size.current.w <= 0 || size.current.h <= 0) return
    const v = view()
    if (which.includes('static')) { const c = ctxOf('static'); if (c) drawStaticLayer(c, v) }
    if (which.includes('keys')) {
      const c = ctxOf('keys')
      const graph = v.graph ? motionGraphPainter() : null
      if (c) { if (graph) graph(c, v); else drawKeysLayer(c, v) }
    }
    if (which.includes('overlay')) { const c = ctxOf('overlay'); if (c) drawOverlayLayer(c, v) }
  }, [view])

  const resize = useCallback(() => {
    const sc = scrollerRef.current
    if (!sc) return
    const w = Math.max(0, Math.floor(sc.clientWidth))
    const h = Math.max(0, Math.floor(sc.clientHeight))
    const dpr = getDpr()
    size.current = { w, h, dpr }
    if (stageRef.current) stageRef.current.style.height = `${h}px`
    for (const layer of LAYERS) {
      const c = canvases.current[layer]
      if (!c) continue
      c.width = backingSize(w, dpr)
      c.height = backingSize(h, dpr)
      c.style.width = `${w}px`
      c.style.height = `${h}px`
    }
    paint(LAYERS)
  }, [paint])

  useImperativeHandle(ref, () => ({
    redraw: () => paint(LAYERS),
    redrawKeys: () => paint(['keys', 'overlay']),
    drawOverlay: () => paint(['overlay']),
    resize,
    scroller: () => scrollerRef.current,
    stage: () => stageRef.current,
    viewport: () => ({ ...size.current, scrollTop: scrollerRef.current?.scrollTop ?? 0 }),
    setScrollTop: (y) => {
      const sc = scrollerRef.current
      if (sc && Math.abs(sc.scrollTop - y) >= 0.5) sc.scrollTop = y
    },
    view,
  }), [paint, resize, view])

  // Size to the visible viewport, and follow it.
  useEffect(() => {
    resize()
    const sc = scrollerRef.current
    if (!sc || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => resize())
    ro.observe(sc)
    const offDpr = subscribeDpr(() => resize())
    return () => { ro.disconnect(); offDpr() }
  }, [resize])

  // New rows / data: repaint everything.
  useEffect(() => { paint(LAYERS) }, [layout, props.data, props.snapGranularity, paint])

  // Theme: the palette is cached; drop it and repaint.
  useEffect(() => {
    const on = () => { invalidateMotionPalette(); paint(LAYERS) }
    window.addEventListener('xleth-theme-changed', on)
    return () => window.removeEventListener('xleth-theme-changed', on)
  }, [paint])

  // Selection and drafts from the store: imperative repaint, no React render.
  useEffect(() => useMotionViewStore.subscribe((s, prev) => {
    if (s.selectedRows !== prev.selectedRows || s.graph !== prev.graph) paint(LAYERS)
    else if (s.keySel !== prev.keySel || s.draft !== prev.draft || s.focusedRow !== prev.focusedRow) paint(['keys', 'overlay'])
  }), [paint])

  // The playhead: every frame into the overlay, never eased.
  useEffect(() => playheadClock.onFrame(() => paint(['overlay'])), [paint])

  // Wheel: the parent decides (zoom, horizontal scroll, row height, vertical scroll).
  useEffect(() => {
    const sc = scrollerRef.current
    if (!sc) return undefined
    const on = (e) => live.current.onWheel?.(e)
    sc.addEventListener('wheel', on, { passive: false })
    return () => sc.removeEventListener('wheel', on)
  }, [])

  const onScroll = (e) => {
    paint(LAYERS)
    live.current.onScroll?.(e.currentTarget.scrollTop)
  }

  const pointerAt = (e) => {
    const stage = stageRef.current
    const r = stage?.getBoundingClientRect?.() ?? { left: 0, top: 0 }
    const scrollTop = scrollerRef.current?.scrollTop ?? 0
    const x = e.clientX - r.left
    const y = e.clientY - r.top + scrollTop
    const v = view()
    return { x, y, view: v, hit: hitTestKey(v, x, y) }
  }

  const onPointerDown = (e) => {
    const at = pointerAt(e)
    if (live.current.onPointerDown?.(e, at)) e.preventDefault?.()
  }

  const onPointerMove = (e) => {
    if (e.buttons) return
    const at = pointerAt(e)
    const h = live.current.hintFor?.(at.hit, at) ?? null
    const text = h?.hint ?? ''
    const id = `${text}\u0000${h?.mods ?? ''}`
    if (id === lastHint.current) return
    lastHint.current = id
    const stage = stageRef.current
    if (stage) {
      if (text) stage.setAttribute('data-hint', text); else stage.removeAttribute('data-hint')
      if (h?.mods) stage.setAttribute('data-hint-mods', h.mods); else stage.removeAttribute('data-hint-mods')
    }
    requestHintRefresh(text ? { hint: text, mods: h?.mods ?? '' } : null)
  }

  const onPointerLeave = () => { lastHint.current = '' }

  const total = (layout?.totalHeight ?? 0) + bottomPad
  return (
    <div className={styles.keyScroll} ref={scrollerRef} onScroll={onScroll} data-testid="motion-key-scroll">
      <div className={styles.keySpacer} style={{ height: total, minHeight: '100%' }}>
        <div
          className={styles.stage}
          ref={stageRef}
          data-testid="motion-key-stage"
          data-hint={KEY_AREA_HINT}
          data-hint-mods={KEY_AREA_MODS}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onContextMenu={(e) => { const at = pointerAt(e); live.current.onContextMenu?.(e, at) }}
        >
          <canvas className={styles.canvas} data-layer="static" ref={(el) => { canvases.current.static = el }} aria-hidden="true" />
          <canvas className={styles.canvas} data-layer="keys" ref={(el) => { canvases.current.keys = el }} aria-hidden="true" />
          <canvas className={styles.canvas} data-layer="overlay" ref={(el) => { canvases.current.overlay = el }} aria-hidden="true" />
        </div>
      </div>
    </div>
  )
})

export default MotionKeyCanvas

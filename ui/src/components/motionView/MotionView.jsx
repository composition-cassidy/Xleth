import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isHeard, Menu, MenuItem, MenuSeparator } from '../../ui-kit'
import { requestHintRefresh } from '../../ui-kit/hint'
import MotionTree from './MotionTree.jsx'
import MotionKeyCanvas from './MotionKeyCanvas.jsx'
import { VALUE_CELL_WIDTH } from './MotionValueCell.jsx'
import { motionContextMenu, motionPointerDown, selectionMode } from './motionInteraction.js'
import { runMotionKeyCommand } from './motionKeyCommands.js'
import { installMotionEditing } from './motionGesture.js'
import { hitTestGraph, GRAPH_EMPTY_TEXT } from './motionGraph.js'
import { motionTickNow, startMotionTick } from './motionTick.js'
import { useMotionViewStore, clampMotionTrackRowHeight } from '../../motion/motionViewStore.js'
import {
  buildMotionRows, propNodesUnder, revealTarget, rowAtY, rowKeys,
} from '../../motion/rowRegistry.js'
import { maskProvider, masksOf } from '../../motion/providers/maskProvider.js'
import { adjacentTick, uniqueTicks } from '../../motion/providers/common.js'
import { nextMaskId } from '../../motion/maskModel.js'
import { formatValue } from '../../motion/schema.js'
import { runMotionPlan } from '../../motion/motionPlan.js'
import { formatDelay, isClone, isTrailClone } from '../../clones/cloneModel.js'
import { resolveAutoTrackColor, normalizeTrackPalette, TRACK_PALETTE_FALLBACK } from '../timeline/trackColorResolver.js'
import { RULER_HEIGHT, TIMELINE_HSCROLL_HEIGHT } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import styles from './MotionView.module.css'

// Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 5.1-5.4, R19-R24): mounted by
// TimelineView in place of TrackHeaderList + TimelineCanvas. The toolbar, ruler,
// loop bar, cue lane and horizontal scrollbar stay TimelineView's (shared zoom,
// scroll, playhead, loop, track order, track selection, mute / solo).
//
// Two halves, one component:
//   * the property tree (DOM, MotionTree) in the header column, where this renders;
//   * the key area (canvas, MotionKeyCanvas) PORTALED into `keyHost`, the element
//     TimelineView puts where the Edit view's canvas scroller is.
// The two scrollers keep the same scrollTop (each view keeps its own: R19). The
// view state (expanded rows, row height, scroll, header width) lives in
// motionViewStore; engine data comes from useMotionData (TimelineView owns it so
// the Edit view's motion marker reads the same fetch).
//
// Edits: every control builds a provider plan and runs it with runMotionPlan
// (ONE undo step, the shared undo grouper). No IPC during a drag.
//
// Imperative handle (TimelineView, UA2):
//   redraw(), redrawKeys(), drawOverlay()     repaint the key area
//   scroller()                                the key area's vertical scroller
//   zoomRowHeight(wheelEvent)                 Alt+wheel: track row height, anchored
//   handleKeyCommand(command) -> bool         R20 keys (motionKeyCommands); true = claimed
//   reveal(trackId, path)                     expand, select and scroll to a row
//   context()                                 the ctx gestures and key commands get
//   layout(), data()

export const motionKeyHostClassName = styles.keyHost
export const MOTION_BOTTOM_PAD = 24
const SCROLL_SAVE_MS = 200

const CHANNEL_LABELS = { offsetX: 'Offset X', offsetY: 'Offset Y', scale: 'Scale', rotationDeg: 'Rotation' }
const REJECTED = {
  self: 'A track cannot follow itself',
  cycle: 'That track already follows this one: a parent loop is not allowed',
  too_deep: 'That would make a chain deeper than 4 parents',
  unknown_track: 'That track is gone',
  trail_clone: 'A Trail clone has no cell of its own: it cannot have a Parent or be one',
}

/**
 * The hint-bar note a Parent change leaves (R6): what could not be kept on screen.
 * res = timeline_setTrackParent's answer; keepOnScreen = Alt was held.
 */
export function parentResultNote(res, keepOnScreen) {
  if (!res) return 'Parent: the change did not reach the engine'
  if (res.rejected) return `Parent not changed: ${REJECTED[res.rejected] ?? res.rejected}`
  if (!res.changed) return null
  if (!keepOnScreen) return null
  if (res.keepOnScreenSkipped === 'not_placed') return 'Parent set. The track has no cell at the playhead, so nothing was kept on screen'
  const un = Array.isArray(res.uncompensated) ? res.uncompensated : []
  if (un.length === 0) return 'Parent set: the cell kept its place on screen'
  const names = []
  if (un.includes('offsetX') || un.includes('offsetY')) names.push('Offset X, Y')
  for (const ch of ['scale', 'rotationDeg']) if (un.includes(ch)) names.push(CHANNEL_LABELS[ch])
  const plural = un.length > 1
  return `Parent set. ${names.join(' and ')} ${plural ? 'are' : 'is'} keyed: ${plural ? 'they keep their keys' : 'it keeps its keys'} and may jump`
}

/** The hint for whatever is under the pointer in the key area. */
export function keyAreaHint(hit, data) {
  if (!hit?.row) return null
  const row = hit.row
  if (row.kind === 'prop') {
    const p = row.prop
    if (hit.key) {
      const k = hit.key
      const v = k.value === null || k.value === undefined ? '' : `, ${formatValue(p, k.value)}`
      const interp = k.interp === 'EaseOut' ? 'Ease out' : k.interp
      const whose = k.hollow ? ' (hit curve: every Follow / Nudge note plays it)' : ''
      return {
        hint: `${p.label} key${v}, ${interp}${whose}${k.outside ? '. It does not play here' : ''}`,
        mods: k.hollow ? HOLLOW_KEY_MODS : KEY_MODS,
      }
    }
    const h = row.provider.hint(row)
    return { hint: h.hint, mods: EMPTY_ROW_MODS }
  }
  if (hit.summaryTick !== undefined) {
    return { hint: `${row.label}: the keys of every row inside it at this tick`, mods: 'Click: select them all · Drag: move them · Twirl the row open to see each' }
  }
  if (row.kind === 'track') {
    const t = row.track
    const c = isClone(t) ? data?.cloneOf?.(t.id) : null
    const src = isClone(t) ? (data?.cloneSourceOf?.(t.id)?.name ?? 'its source') : null
    const what = !isClone(t)
      ? `its ${t.type === 'Pattern' ? 'notes' : 'clips'}`
      : isTrailClone(t)
        ? `${src}'s notes ${c ? `${formatDelay(c.delayTicks)} later` : 'later'} (where this Trail shows them)`
        : 'the notes this Voice clone plays'
    return { hint: `${t.name}: ${what}, for reference`, mods: 'Twirl the row open for its properties' }
  }
  return { hint: row.hint ?? row.label, mods: '' }
}

const KEY_MODS = 'Click: select · Shift: add · Ctrl: toggle · Drag: move (Alt: no snap) · Right-click: interpolation, copy, delete'
const HOLLOW_KEY_MODS = 'Drag: edits the hit curve (every note) · Ctrl+Alt+drag: a Nudge key on this note only · Right-click: Nudge this note'
const EMPTY_ROW_MODS = 'Drag: box-select (Shift adds, Ctrl toggles) · Double-click: add a key on an animated row · Click: clear the selection'

/** The hint over the graph (R21): a key, a handle, empty plot, or the empty state. */
export function graphAreaHint(g, data) {
  if (!g) return { hint: GRAPH_EMPTY_TEXT, mods: 'Click a property row in the tree (Ctrl / Shift: several) · G: back to the key rows' }
  if (g.kind === 'handle') return { hint: `${g.curve.prop.label}: Bezier handle of the segment leaving this key`, mods: 'Drag: reshape the curve' }
  if (g.kind === 'key') {
    const k = g.inst
    const interp = k.interp === 'EaseOut' ? 'Ease out' : k.interp
    return {
      hint: `${g.curve.prop.label} key, ${formatValue(g.curve.prop, k.value, { layer: g.curve.layer })}, ${interp}`,
      mods: 'Drag: time and value (Shift: fine value, Alt: no snap) · Right-click: interpolation, copy, delete',
    }
  }
  return { hint: 'Graph: each selected property on its own value range; the axis shows the focused one', mods: 'Drag: box-select keys · G: back to the key rows' }
}

/** Every group key inside a node (Alt+click on a twirl opens them all). */
function groupKeysUnder(node, out = []) {
  for (const c of node?.children ?? []) {
    if (Array.isArray(c.children)) { out.push(c.key); groupKeysUnder(c, out) }
  }
  return out
}

const NO_TRACKS = Object.freeze([])

const MotionView = forwardRef(function MotionView({
  tracks = NO_TRACKS,
  allTracks = tracks,
  data,
  refresh,
  adopt,
  keyHost = null,
  width = 360,
  pinnedHeader = null,
  ppbRef,
  scrollOffsetRef,
  snapGranularity = '1/16',
  focusedTrackId = null,
  onFocusTrack,
  onPearl,
  onViewportWheel,
  onSeekTick,
  reveal = null,
}, ref) {
  const expanded = useMotionViewStore((s) => s.expanded)
  const trackRowHeight = useMotionViewStore((s) => s.motion.trackRowHeight)
  const selectedRows = useMotionViewStore((s) => s.selectedRows)

  const layout = useMemo(
    () => buildMotionRows({ tracks, data, expanded, trackRowHeight }),
    [tracks, data, expanded, trackRowHeight],
  )

  const treeScrollRef = useRef(null)
  const keyCanvasRef = useRef(null)
  const live = useRef(null)
  live.current = { layout, data, refresh, adopt, onFocusTrack, onPearl, onViewportWheel, onSeekTick, snapGranularity, allTracks }

  // The playhead tick the value cells read (display rate).
  useEffect(() => startMotionTick(), [])

  // Key gestures, the key menu, the graph painter and the key commands (motionGesture.js).
  useEffect(() => installMotionEditing(), [])

  // The key menu (right-click on the key area): plain items from motionKeyMenu.js.
  const [menu, setMenu] = useState(null)
  const openMenu = useCallback((m) => setMenu(m && Array.isArray(m.items) ? m : null), [])

  // ── Colours and output state per track ─────────────────────────────────────
  const [themeRev, setThemeRev] = useState(0)
  useEffect(() => {
    const on = () => setThemeRev((r) => r + 1)
    window.addEventListener('xleth-theme-changed', on)
    document.addEventListener('xleth-theme-changed', on)
    return () => {
      window.removeEventListener('xleth-theme-changed', on)
      document.removeEventListener('xleth-theme-changed', on)
    }
  }, [])
  const colors = useMemo(() => {
    const palette = normalizeTrackPalette(Array.from({ length: 16 }, (_, i) => tokenValue(`--theme-track-palette-${i + 1}`)))
    const map = new Map()
    allTracks.forEach((t, i) => map.set(t.id, resolveAutoTrackColor(t, i, palette, TRACK_PALETTE_FALLBACK[i % 16])))
    return map
    // themeRev is a dependency only: the palette tokens change with the theme.
  }, [allTracks, themeRev])
  const heard = useMemo(() => {
    const items = allTracks.map((t) => ({ id: t.id, muted: !!t.muted, soloed: !!t.solo }))
    const map = new Map()
    for (const it of items) map.set(it.id, isHeard(it, items))
    return map
  }, [allTracks])
  // A Trail clone wears its tint (its chip and reference strip), like the mockup.
  const colorOf = useCallback((id) => {
    const c = data?.cloneOf?.(id)
    if (c?.kind === 'Trail' && c.tint) return c.tint
    return colors.get(id) ?? TRACK_PALETTE_FALLBACK[0]
  }, [colors, data])
  const heardOf = useCallback((id) => heard.get(id) ?? true, [heard])
  const mutedOf = useCallback((id) => !(heard.get(id) ?? true), [heard])
  const parentOf = useCallback((id) => data?.roamOf?.(id)?.parentTrackId ?? -1, [data])

  // ── Running plans ──────────────────────────────────────────────────────────
  const hint = useCallback((text) => { if (text) requestHintRefresh({ hint: text, mods: '' }) }, [])

  const runPlan = useCallback(async (plan, label) => {
    if (!Array.isArray(plan) || plan.length === 0) return { writes: [], results: [], changed: false, ok: true }
    try {
      const res = await runMotionPlan(plan, label)
      if (!res.ok) hint(`${label}: the engine did not take every change`)
      return res
    } catch (err) {
      console.error(`[MotionView] ${label} failed:`, err?.message ?? err)
      hint(`${label} failed: ${err?.message ?? err}`)
      return { writes: [], results: [], changed: false, ok: false }
    }
  }, [hint])

  const context = useCallback(() => {
    const l = live.current
    return {
      store: useMotionViewStore,
      layout: l.layout,
      data: l.data,
      tick: motionTickNow(),
      snapGranularity: l.snapGranularity,
      runPlan,
      adopt: (r) => l.adopt?.(r),
      hint,
      openMenu,
      onFocusTrack: (id) => l.onFocusTrack?.(id),
      canvas: {
        view: () => keyCanvasRef.current?.view?.() ?? null,
        redraw: () => keyCanvasRef.current?.redraw(),
        redrawKeys: () => keyCanvasRef.current?.redrawKeys(),
        drawOverlay: () => keyCanvasRef.current?.drawOverlay(),
        host: keyCanvasRef.current?.stage?.() ?? null,
        scroller: keyCanvasRef.current?.scroller?.() ?? null,
      },
    }
  }, [runPlan, hint, openMenu])

  // The actions of the tree's controls. Stable: they read the latest state from refs.
  const api = useMemo(() => {
    const st = () => useMotionViewStore.getState()
    const rowLabel = (row) => row.prop?.label ?? row.label
    return {
      toggle(row, e) {
        if (e?.altKey) {
          if (row.expanded) st().collapseTree(row.key)
          else st().setExpandedRows([...st().expanded, row.key, ...groupKeysUnder(row.node)])
          return
        }
        st().toggleExpanded(row.key)
      },
      selectRow(row, e) {
        if (e?.button !== undefined && e.button !== 0) return
        const mode = selectionMode(e ?? {})
        st().selectRow(row.key, mode)
        live.current.onFocusTrack?.(row.trackId)
        const maskId = row.target?.kind === 'mask' ? row.target.maskId : null
        if (maskId !== null) st().setSelectedMask({ trackId: row.trackId, maskId })
        else if (mode === 'replace') st().setSelectedMask(null)
      },
      pearl(trackId, action) {
        live.current.onPearl?.(trackId, action)
      },
      async chooseParent(trackId, parentTrackId, opts) {
        const keepOnScreen = !!opts?.keepOnScreen
        const res = await runPlan([{
          kind: 'parent', trackId, parentTrackId, opts: { keepOnScreen, tick: motionTickNow() },
        }], 'Set parent')
        const note = parentResultNote(res.results?.[0] ?? null, keepOnScreen)
        if (note) hint(note)
        return res
      },
      maskBlockers(trackId) {
        const d = live.current.data
        return {
          Rectangle: maskProvider.addBlocker(trackId, d, 'Rectangle'),
          Ellipse: maskProvider.addBlocker(trackId, d, 'Ellipse'),
          Path: maskProvider.addBlocker(trackId, d, 'Path'),
        }
      },
      async addMask(trackId, kind) {
        const d = live.current.data
        const blocker = maskProvider.addBlocker(trackId, d, kind)
        if (blocker) { hint(blocker); return null }
        const t = `t:${trackId}`
        st().setExpandedRows([...st().expanded, t, `${t}/roam`, `${t}/roam/masks`])
        if (kind === 'Path') {
          st().setSelectedMask(null)
          st().setPenTool({ trackId, points: [] })
          hint('Path mask: click on the viewer to place points, drag for a curve; click the first point or press Enter to close, Escape cancels')
          return null
        }
        const id = nextMaskId(masksOf(d, trackId))
        const res = await runPlan(maskProvider.addMaskPlan(trackId, d, kind), `Add ${kind.toLowerCase()} mask`)
        if (res.changed) {
          const key = `${t}/mask:${id}`
          st().setExpanded(key, true)
          st().selectRow(key, 'replace')
          st().setSelectedMask({ trackId, maskId: id })
        }
        return res
      },
      maskMenuState(trackId, maskId) {
        const d = live.current.data
        const masks = masksOf(d, trackId)
        const i = masks.findIndex((m) => m.id === maskId)
        return { index: i, count: masks.length, duplicateBlocker: maskProvider.duplicateBlocker(trackId, d, maskId) }
      },
      renameMask(trackId, maskId, name) {
        return runPlan(maskProvider.renameMaskPlan(trackId, live.current.data, maskId, name), 'Rename mask')
      },
      async duplicateMask(trackId, maskId) {
        const d = live.current.data
        const blocker = maskProvider.duplicateBlocker(trackId, d, maskId)
        if (blocker) { hint(blocker); return null }
        const id = nextMaskId(masksOf(d, trackId))
        const res = await runPlan(maskProvider.duplicateMaskPlan(trackId, d, maskId), 'Duplicate mask')
        if (res.changed) {
          const key = `t:${trackId}/mask:${id}`
          st().setExpanded(key, true)
          st().selectRow(key, 'replace')
          st().setSelectedMask({ trackId, maskId: id })
        }
        return res
      },
      moveMask(trackId, maskId, dir) {
        return runPlan(maskProvider.moveMaskPlan(trackId, live.current.data, maskId, dir), dir < 0 ? 'Move mask up' : 'Move mask down')
      },
      async deleteMask(trackId, maskId) {
        const res = await runPlan(maskProvider.deleteMaskPlan(trackId, live.current.data, maskId), 'Delete mask')
        const sel = st().selectedMask
        if (res.changed && sel && sel.trackId === trackId && sel.maskId === maskId) st().setSelectedMask(null)
        return res
      },
      stopwatch(row, on) {
        const tick = motionTickNow()
        const d = live.current.data
        const blocker = row.provider.editBlocker?.(row, d, tick, 'stopwatch')
        if (blocker) { hint(blocker); return Promise.resolve(null) }
        return runPlan(row.provider.stopwatchPlan(row, d, tick, on), `${on ? 'Animate' : 'Stop animating'} ${rowLabel(row)}`)
      },
      valuePlan(row, value) {
        const tick = motionTickNow()
        const d = live.current.data
        const blocker = row.provider.editBlocker?.(row, d, tick, 'value')
        if (blocker) { hint(blocker); return Promise.resolve({ changed: false }) }
        return runPlan(row.provider.valuePlan(row, d, tick, value), `Set ${rowLabel(row)}`)
      },
      async setMotionBlur(patch) {
        const fn = window.xleth?.timeline?.setMotionBlur
        if (typeof fn !== 'function') return null
        try {
          const res = await fn(patch)
          live.current.refresh?.()
          return res
        } catch (err) {
          console.error('[MotionView] setMotionBlur failed:', err?.message ?? err)
          return null
        }
      },
      jump(row, dir) {
        const ticks = uniqueTicks(rowKeys(row, live.current.data))
        const t = adjacentTick(ticks, motionTickNow(), dir)
        if (t !== null) live.current.onSeekTick?.(t)
      },
      toggleKey(row, atKey) {
        const tick = motionTickNow()
        const d = live.current.data
        const blocker = row.provider.editBlocker?.(row, d, tick, 'key')
        if (blocker) { hint(blocker); return Promise.resolve(null) }
        const plan = atKey ? row.provider.removeKeyPlan(row, d, tick) : row.provider.addKeyPlan(row, d, tick)
        return runPlan(plan, `${atKey ? 'Remove' : 'Add'} ${rowLabel(row)} key`)
      },
    }
  }, [runPlan, hint])

  // ── Scroll: the tree and the key area share one scrollTop ──────────────────
  // This view's own scroll (R19) lives in motion.scrollY. A saved value to apply
  // (on mount, or when a project load changes it while Motion view is shown)
  // stays PENDING until the rows are tall enough to hold it: rows that are still
  // loading would clamp it, and the clamped value must not overwrite the saved one.
  const saveTimer = useRef(null)
  const writtenScroll = useRef(null)          // the last value this view saved
  const pendingScroll = useRef(undefined)     // a saved scroll not yet applied (null = none)
  if (pendingScroll.current === undefined) pendingScroll.current = useMotionViewStore.getState().motion.scrollY
  const appliedScroll = useRef({ key: null, tree: null }) // where the last apply left each scroller

  const saveScroll = useCallback((y) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      writtenScroll.current = Math.round(Math.max(0, y))
      useMotionViewStore.getState().setMotionScrollY(y)
    }, SCROLL_SAVE_MS)
  }, [])
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      const sc = keyCanvasRef.current?.scroller?.()
      if (sc) {
        writtenScroll.current = Math.round(Math.max(0, sc.scrollTop))
        useMotionViewStore.getState().setMotionScrollY(sc.scrollTop)
      }
    }
  }, [])

  // A scroll event: the user's own scroll drops a pending restore; the echo of
  // our own apply (the same position) is neither a user scroll nor saved.
  const userScrolled = useCallback((y, which) => {
    if (pendingScroll.current === null) return true
    const at = appliedScroll.current[which]
    if (at !== null && Math.abs(y - at) < 1) return false
    pendingScroll.current = null
    return true
  }, [])
  const onKeyScroll = useCallback((y) => {
    const tree = treeScrollRef.current
    if (tree && Math.abs(tree.scrollTop - y) >= 0.5) tree.scrollTop = y
    if (userScrolled(y, 'key')) saveScroll(y)
  }, [saveScroll, userScrolled])
  const onTreeScroll = useCallback((y) => {
    keyCanvasRef.current?.setScrollTop(y)
    if (userScrolled(y, 'tree')) saveScroll(y)
  }, [saveScroll, userScrolled])

  const setScrollTop = useCallback((y) => {
    const v = Math.max(0, y)
    keyCanvasRef.current?.setScrollTop(v)
    const tree = treeScrollRef.current
    if (tree && Math.abs(tree.scrollTop - v) >= 0.5) tree.scrollTop = v
  }, [])

  // Apply the pending saved scroll; it is done once the key area can hold it.
  const applyPendingScroll = useCallback(() => {
    const y = pendingScroll.current
    const sc = keyCanvasRef.current?.scroller?.()
    if (y === null || !sc) return
    setScrollTop(y)
    appliedScroll.current = { key: sc.scrollTop, tree: treeScrollRef.current?.scrollTop ?? null }
    if (Math.max(0, sc.scrollHeight - sc.clientHeight) >= y) pendingScroll.current = null
  }, [setScrollTop])

  // Every commit while a restore is pending (rows arriving, the key host mounting).
  useLayoutEffect(() => {
    if (pendingScroll.current !== null) applyPendingScroll()
  })

  // A change from outside (a project load while Motion view is shown): restore it.
  // Our own debounced saves come back here too and are ignored.
  useEffect(() => useMotionViewStore.subscribe((s, prev) => {
    const y = s.motion.scrollY
    if (y === prev.motion.scrollY || y === writtenScroll.current) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    writtenScroll.current = y
    pendingScroll.current = y
    applyPendingScroll()
  }), [applyPendingScroll])

  // Alt+wheel: the track row height, the row under the pointer kept in place.
  const anchorRef = useRef(null)
  const zoomRowHeight = useCallback((e) => {
    const s = useMotionViewStore.getState()
    const h = s.motion.trackRowHeight
    if (!e.deltaY) return
    let next = clampMotionTrackRowHeight(Math.round(e.deltaY < 0 ? h * 1.15 : h / 1.15))
    if (next === h) next = clampMotionTrackRowHeight(h + (e.deltaY < 0 ? 1 : -1))
    if (next === h) return
    pendingScroll.current = null              // the user's own scroll from here on
    const sc = keyCanvasRef.current?.scroller?.()
    if (sc) {
      const rect = sc.getBoundingClientRect()
      const localY = Math.max(0, Math.min(sc.clientHeight, e.clientY - rect.top))
      const row = rowAtY(live.current.layout, sc.scrollTop + localY)
      if (row) anchorRef.current = { key: row.key, frac: (sc.scrollTop + localY - row.y) / row.height, localY }
    }
    s.setMotionTrackRowHeight(next)
  }, [])

  // Reveal ('xleth-motion-reveal', 5.2): expand, select, then scroll once the rows exist.
  const scrollToRef = useRef(null)
  const doReveal = useCallback((trackId, path) => {
    const target = revealTarget(live.current.layout, trackId, path)
    if (!target) return false
    const s = useMotionViewStore.getState()
    if (target.expand.length) s.setExpandedRows([...s.expanded, ...target.expand])
    s.selectRow(target.rowKey, 'replace')
    live.current.onFocusTrack?.(trackId)
    pendingScroll.current = null              // the reveal's scroll wins over a saved one
    scrollToRef.current = target.rowKey
    return true
  }, [])

  const handledReveal = useRef(null)
  useEffect(() => {
    if (!reveal || handledReveal.current === reveal) return
    handledReveal.current = reveal
    doReveal(reveal.trackId, reveal.path ?? [])
  }, [reveal, doReveal])

  // After the rows change: the reveal's scroll, the Alt+wheel anchor.
  useLayoutEffect(() => {
    const a = anchorRef.current
    if (a) {
      anchorRef.current = null
      const r = layout.byKey.get(a.key)
      if (r) setScrollTop(r.y + a.frac * r.height - a.localY)
    }
    const key = scrollToRef.current
    if (key && layout.byKey.has(key)) {
      scrollToRef.current = null
      const r = layout.byKey.get(key)
      const sc = keyCanvasRef.current?.scroller?.()
      const h = sc?.clientHeight ?? 0
      const top = sc?.scrollTop ?? 0
      if (r.y < top || r.y + r.height > top + h) setScrollTop(Math.max(0, r.y - Math.max(0, (h - r.height) / 3)))
    }
  }, [layout, setScrollTop])

  // Keys that no longer exist leave the selection.
  useEffect(() => {
    const s = useMotionViewStore.getState()
    if (s.keySel.size === 0 || !data) return
    const alive = new Set()
    for (const tree of layout.trees.values()) {
      for (const pn of propNodesUnder(tree)) {
        const row = { key: pn.key, prop: pn.prop, provider: pn.provider, target: pn.target, trackId: tree.trackId, node: pn }
        for (const k of rowKeys(row, data)) alive.add(k.id)
      }
    }
    s.pruneKeySel((id) => alive.has(id))
  }, [layout, data])

  // ── Key area events ────────────────────────────────────────────────────────
  const onKeyWheel = useCallback((e) => {
    if (e.altKey) { e.preventDefault(); zoomRowHeight(e); return }
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.deltaX !== 0) { live.current.onViewportWheel?.(e); return }
    // A plain wheel scrolls the key area natively; the tree follows.
  }, [zoomRowHeight])

  // The tree: Alt+wheel = row height, Ctrl+wheel = zoom, like the key area.
  useEffect(() => {
    const tree = treeScrollRef.current
    if (!tree) return undefined
    const on = (e) => {
      if (e.altKey) { e.preventDefault(); zoomRowHeight(e) } else if (e.ctrlKey || e.metaKey) live.current.onViewportWheel?.(e)
    }
    tree.addEventListener('wheel', on, { passive: false })
    return () => tree.removeEventListener('wheel', on)
  }, [zoomRowHeight])

  const onPointerDown = useCallback((e, at) => {
    const ctx = { ...context(), hit: at.hit, x: at.x, y: at.y, view: at.view }
    return motionPointerDown(e, ctx)
  }, [context])
  const onContextMenu = useCallback((e, at) => {
    const ctx = { ...context(), hit: at.hit, x: at.x, y: at.y, view: at.view }
    return motionContextMenu(e, ctx)
  }, [context])
  const hintFor = useCallback((hit, at) => {
    const v = at?.view
    if (v?.graph) return graphAreaHint(hitTestGraph(v, at.x, at.y - (v.scrollTop ?? 0)), live.current.data)
    return keyAreaHint(hit, live.current.data)
  }, [])

  useImperativeHandle(ref, () => ({
    redraw: () => keyCanvasRef.current?.redraw(),
    redrawKeys: () => keyCanvasRef.current?.redrawKeys(),
    drawOverlay: () => keyCanvasRef.current?.drawOverlay(),
    scroller: () => keyCanvasRef.current?.scroller?.() ?? null,
    zoomRowHeight,
    handleKeyCommand: (command) => runMotionKeyCommand(command, context()),
    reveal: doReveal,
    context,
    layout: () => live.current.layout,
    data: () => live.current.data,
    api: () => api,
    menu: () => menu,
  }), [zoomRowHeight, context, doReveal, api, menu])

  const keyArea = keyHost ? createPortal(
    <MotionKeyCanvas
      ref={keyCanvasRef}
      layout={layout}
      data={data}
      ppbRef={ppbRef}
      scrollOffsetRef={scrollOffsetRef}
      snapGranularity={snapGranularity}
      colorOf={colorOf}
      mutedOf={mutedOf}
      onWheel={onKeyWheel}
      onScroll={onKeyScroll}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      hintFor={hintFor}
      bottomPad={MOTION_BOTTOM_PAD}
    />,
    keyHost,
  ) : null

  return (
    <div className={`timeline-motion-column ${styles.column}`} style={{ width }} data-testid="motion-view">
      <div
        className={styles.spacer}
        style={{ height: RULER_HEIGHT }}
        data-hint="Motion view: every track's Lens, Roam, Masks and Sweep. Twirl a row open to see its keys"
        data-hint-mods="`: back to the Edit view · G: graph editor"
      >
        <span className={styles.spacerLabel}>Property</span>
        <span className={styles.spacerValue} style={{ width: VALUE_CELL_WIDTH }}>At playhead</span>
        <span className={styles.spacerNav} aria-hidden="true" />
      </div>
      {pinnedHeader}
      <MotionTree
        layout={layout}
        data={data}
        api={api}
        allTracks={allTracks}
        selectedRows={selectedRows}
        focusedTrackId={focusedTrackId}
        colorOf={colorOf}
        heardOf={heardOf}
        parentOf={parentOf}
        scrollRef={treeScrollRef}
        onScroll={onTreeScroll}
        bottomPad={MOTION_BOTTOM_PAD}
        valueWidth={VALUE_CELL_WIDTH}
      />
      <div className={styles.footer} style={{ height: TIMELINE_HSCROLL_HEIGHT }} aria-hidden="true" />
      {keyArea}
      {menu ? (
        <Menu x={menu.x} y={menu.y} kind="context" label={menu.label ?? 'Keys'} onClose={() => setMenu(null)}>
          {menu.items.map((it, i) => (it.separator
            ? <MenuSeparator key={`sep${i}`} />
            : (
              <MenuItem key={it.id ?? i} checked={it.checked} disabled={it.disabled} danger={it.danger} onSelect={() => it.onSelect?.()}>
                {it.label}
              </MenuItem>
            )))}
        </Menu>
      ) : null}
    </div>
  )
})

export default MotionView

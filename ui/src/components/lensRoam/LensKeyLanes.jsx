import { useCallback, useEffect, useRef, useState } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  LENS_CHANNELS, anchorOffset, anchorReached, applyKeyOp, bezierHandlePoints, clampChannelValue, clampKeyPos,
  describeKeyPlace, dragBezierHandle, interpOp, keyEquals, keyPlaceAt, laneRange, makeKey, noteSpan,
  positionAtNoteTime, sanitizeBez, sortEventKeys, sortNoteKeys, unitToValue, valueAtEvent, valueAtNote,
  valueToUnit, zoneSpan, layerIdentity,
} from '../../lensRoam/lensKeyModel.js'
import ContextMenu from '../ContextMenu.jsx'
import { lensKeyMenuItems } from './lensKeyMenu.js'
import styles from './lensRoam.module.css'

// The keyframe lanes of the Advanced Lens editor: Zoom, Center X, Center Y and
// Rotate over ONE note (Head / Body / Tail bands) or ONE Clip Track event (ticks,
// no zones). Everything is drawn on canvas; the playhead lives on a second canvas
// so it never repaints the lanes.
//
//   click empty lane       add a key there (own key, filled)
//   drag a filled key      move it: time along x, value along y
//   Alt-drag across a zone edge   changes the key's anchor to the zone under the pointer
//   Shift while dragging   fine: a quarter of the value travel
//   Ctrl/Shift-click a key add it to / take it out of the multi-selection
//   Ctrl/Shift-drag        marquee: select every own key inside the rectangle
//   drag a Bezier handle   reshape the segment of a selected Bezier key
//   right-click            key menu: Hold / Linear / Ease out / Bezier / Delete, for the
//                          whole selection (ONE batch op: one commit, one undo step)
//   Delete / arrows        delete the selection / nudge the selected key (the drag alternative)
//   Esc                    cancels a drag, nothing is sent
//
// Hollow keys are INHERITED (the hit curve a Follow / Nudge note plays) and are
// not editable here; filled keys are the thing being edited. Gestures are LOCAL:
// pointermove redraws from a ref, only pointerup calls onOp, once. Nothing here
// talks to the engine, and no pointermove sets React state.

const GUTTER = 52
const RULER_H = 16
const LANE_H = 50
const LANE_PAD = 6
const INSET = 7          // plot inset so a key on the first / last tick is not clipped
const KEY_R = 4
const HIT_PX = 12        // hit radius: a 24 px target
const HANDLE_R = 3.5
const HANDLE_HIT_PX = 9  // a handle wins only when nearer than any key
const FINE = 0.25
const CURVE_STEP = 2

const LANE_LABELS = { zoom: 'Zoom', centerX: 'Center X', centerY: 'Center Y', rotationDeg: 'Rotate' }

const ink = (name) => tokenValue(name)

function fmtValue(channel, v, absolute) {
  if (channel === 'zoom') return `${v.toFixed(2)} ×`
  if (channel === 'rotationDeg') return `${v > 0 && !absolute ? '+' : ''}${v.toFixed(1)} °`
  const pct = v * 100
  return `${pct > 0 && !absolute ? '+' : ''}${pct.toFixed(1)} %`
}

const roundTo = (v, step) => Math.round(v / step) * step
const roundValue = (channel, v) => (channel === 'rotationDeg' ? roundTo(v, 0.1) : roundTo(v, 0.001))

// A key's place, ignoring value and interp: how the multi-selection remembers a key
// across edits that change its value, interp or handles.
const spotOf = (k) => ({ channel: k.channel, anchor: k.anchor, pos: k.pos })
const sameSpot = (k, m) => !!k && !!m && k.channel === m.channel && k.anchor === m.anchor && Math.abs(k.pos - m.pos) < 1e-9

// The key's interp as its shape (the Roam lane's code): Hold square, Linear circle,
// EaseOut diamond, Bezier hexagon.
function keyPath(ctx, interp, x, y, r) {
  ctx.beginPath()
  if (interp === 'Hold') {
    ctx.rect(x - r + 0.5, y - r + 0.5, 2 * r - 1, 2 * r - 1)
  } else if (interp === 'EaseOut') {
    const d = r * 1.25
    ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath()
  } else if (interp === 'Bezier') {
    const d = r * 1.15
    for (let i = 0; i < 6; i++) {
      const t = (Math.PI / 3) * i
      if (i === 0) ctx.moveTo(x + d, y); else ctx.lineTo(x + d * Math.cos(t), y + d * Math.sin(t))
    }
    ctx.closePath()
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2)
  }
}

export const LANES_HEIGHT = RULER_H + LENS_CHANNELS.length * LANE_H

/**
 * @param {object} props
 * @param {'note'|'event'} props.kind
 * @param {object} [props.zones]          normalized zones (note)
 * @param {number} props.lengthTicks      the note's length, or the event's
 * @param {object[]} props.ownKeys        editable keys (filled)
 * @param {object[]} [props.inheritedKeys] read-only hit-curve keys (hollow), note kind
 * @param {object} [props.base]           event kind: the static lens (the line a keyed channel replaces)
 * @param {object|null} props.selected    the selected own key (matched by value)
 * @param {(key: object|null) => void} props.onSelect
 * @param {(op: object) => void} props.onOp   one edit: {type:'add'|'update'|'remove', ...} (lensKeyModel.applyKeyOp)
 * @param {boolean} [props.readOnly]
 * @param {() => ({t:number, inside:boolean}|null)} [props.getPlayhead]
 * @param {(cb: () => void) => (() => void)} [props.subscribePlayhead]
 * @param {string} props.label            accessible name
 */
export default function LensKeyLanes({
  kind,
  zones,
  lengthTicks,
  ownKeys,
  inheritedKeys = [],
  base = null,
  selected,
  onSelect,
  onOp,
  readOnly = false,
  getPlayhead,
  subscribePlayhead,
  label,
}) {
  const epoch = useThemeEpoch()
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const overlayRef = useRef(null)
  const dragRef = useRef(null)
  const hoverRef = useRef(null)
  // The multi-selection: own keys' places ([{channel, anchor, pos}]). Local view state.
  const multiRef = useRef([])
  // A Bezier handle being dragged: { key, next, which, laneIndex, range, bez, moved }.
  const handleDragRef = useRef(null)
  // A marquee being dragged: { x0, y0, x1, y1, additive, base }.
  const marqueeRef = useRef(null)
  const [menu, setMenu] = useState(null)
  const [width, setWidth] = useState(300)
  const absolute = kind === 'event'

  // The latest props for the imperative draw / pointer code.
  const live = useRef({})
  live.current = { kind, zones, lengthTicks, ownKeys, inheritedKeys, base, selected, readOnly, width, absolute }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 80) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── geometry ───────────────────────────────────────────────────────────────

  const plot = () => {
    const w = live.current.width
    return { x0: GUTTER + INSET, x1: w - INSET, w: Math.max(1, w - INSET - GUTTER - INSET) }
  }
  const spanOf = () => noteSpan(live.current.lengthTicks, live.current.zones)
  const laneTop = (i) => RULER_H + i * LANE_H

  const timeToX = (t) => {
    const p = plot()
    const len = live.current.lengthTicks
    return len > 0 ? p.x0 + (Math.min(Math.max(t, 0), len) / len) * p.w : p.x0
  }
  const xToTime = (x) => {
    const p = plot()
    const len = live.current.lengthTicks
    return Math.min(Math.max((x - p.x0) / p.w, 0), 1) * len
  }

  /** A key's time along the lane (ticks from the note / event start), or null if it lies off it. */
  const keyTime = (k) => {
    if (live.current.kind === 'event') return Math.min(Math.max(k.pos, 0), live.current.lengthTicks)
    return anchorOffset(spanOf(), k.anchor, k.pos)
  }

  const rangeFor = (ch, keys) => {
    const L = live.current
    return laneRange(ch, keys.map((k) => k.value), { absolute: L.absolute, base: L.absolute ? L.base?.[ch] : null })
  }

  const valueToY = (range, i, v) => {
    const u = Math.min(Math.max(valueToUnit(range, v), 0), 1)
    return laneTop(i) + LANE_PAD + (1 - u) * (LANE_H - 2 * LANE_PAD)
  }
  const yToUnit = (i, y) => 1 - (y - laneTop(i) - LANE_PAD) / (LANE_H - 2 * LANE_PAD)

  const inMulti = (k) => multiRef.current.some((m) => sameSpot(k, m))
  /** Is this own key selected: the primary selection or one of the multi-selection? */
  const isSelectedKey = (k) => {
    const L = live.current
    return (!!L.selected && keyEquals(k, L.selected))
      || inMulti(k) || (!!handleDragRef.current && sameSpot(k, handleDragRef.current.key))
  }
  /** The multi-selection's own keys as they are now. */
  const multiKeys = () => live.current.ownKeys.filter(inMulti)

  /** The own keys as drawn: the dragged key swapped for its draft (or its dragged handles). */
  const drawnOwn = () => {
    const L = live.current
    const hd = handleDragRef.current
    if (hd) return L.ownKeys.map((k) => (keyEquals(k, hd.key) ? { ...k, bez: hd.bez } : k))
    const d = dragRef.current
    if (!d) return L.ownKeys
    if (d.idx < 0) return [...L.ownKeys, d.draft]
    return L.ownKeys.map((k, i) => (i === d.idx ? d.draft : k))
  }

  // ── draw ───────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const L = live.current
    const W = L.width
    const H = LANES_HEIGHT
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const font = ink('--ui-font') || 'sans-serif'
    const g0 = ink('--ui-g0'); const g1 = ink('--ui-g1'); const g3 = ink('--ui-g3'); const g4 = ink('--ui-g4')
    const inkC = ink('--ui-ink'); const ink2 = ink('--ui-ink-2'); const ink3 = ink('--ui-ink-3')
    const accent = ink('--ui-value'); const select = ink('--ui-select')
    const p = plot()
    const len = L.lengthTicks
    const note = L.kind === 'note'
    const span = note ? spanOf() : null
    const own = drawnOwn()
    const d = dragRef.current

    ctx.fillStyle = g0
    ctx.fillRect(0, 0, W, H)

    // Ruler: the three bands (note) or tick marks (event).
    ctx.font = `10px ${font}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    if (note) {
      ;['Head', 'Body', 'Tail'].forEach((z) => {
        const [lo, hi] = zoneSpan(span, z)
        const xa = timeToX(lo)
        const xb = timeToX(hi)
        if (xb - xa < 1) return
        ctx.fillStyle = z === 'Body' ? g0 : g1
        ctx.fillRect(xa, 0, xb - xa, RULER_H)
        if (xb - xa >= 26) {
          ctx.fillStyle = ink2
          ctx.fillText(z, (xa + xb) / 2, RULER_H / 2 + 0.5)
        }
      })
    } else {
      const steps = [15, 30, 60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 30720]
      const step = steps.find((s) => (s / Math.max(len, 1)) * p.w >= 44) ?? steps[steps.length - 1]
      ctx.fillStyle = ink3
      for (let t = 0; t <= len + 1e-6; t += step) {
        const x = timeToX(t)
        ctx.fillRect(Math.round(x), RULER_H - 4, 1, 4)
        ctx.textAlign = t === 0 ? 'left' : 'center'
        ctx.fillText(String(Math.round(t)), t === 0 ? x : x, RULER_H / 2 - 1)
      }
    }
    ctx.fillStyle = g4
    ctx.fillRect(0, RULER_H - 1, W, 1)

    LENS_CHANNELS.forEach((ch, i) => {
      const top = laneTop(i)
      // Band shading under the lane (note): the same cells as the ruler.
      if (note) {
        ;['Head', 'Body', 'Tail'].forEach((z) => {
          const [lo, hi] = zoneSpan(span, z)
          const xa = timeToX(lo)
          const xb = timeToX(hi)
          if (xb - xa < 1) return
          ctx.fillStyle = z === 'Body' ? g0 : g1
          ctx.fillRect(xa, top, xb - xa, LANE_H)
        })
      } else {
        ctx.fillStyle = g1
        ctx.fillRect(p.x0 - INSET, top, p.w + 2 * INSET, LANE_H)
      }
      // Lane separator.
      ctx.fillStyle = g4
      ctx.fillRect(0, top + LANE_H - 1, W, 1)

      const chOwn = own.filter((k) => k.channel === ch)
      const chInh = note ? L.inheritedKeys.filter((k) => k.channel === ch) : []
      const range = d?.ranges?.[ch] ?? rangeFor(ch, [...chOwn, ...chInh])

      // Identity / base reference.
      const refValue = L.absolute ? (L.base?.[ch] ?? layerIdentity(ch)) : layerIdentity(ch)
      const refY = valueToY(range, i, refValue)
      ctx.fillStyle = g3
      ctx.fillRect(p.x0 - INSET, Math.round(refY), p.w + 2 * INSET, 1)

      // Gutter: the lane's name and its reference value.
      ctx.textAlign = 'left'
      ctx.fillStyle = inkC
      ctx.font = `11px ${font}`
      ctx.fillText(LANE_LABELS[ch], 6, top + 12)
      ctx.fillStyle = ink3
      ctx.font = `10px ${font}`
      ctx.fillText(fmtValue(ch, refValue, true), 6, top + 25)

      const curve = (keys, color, width, dash) => {
        if (!note && keys.length === 0 && !L.absolute) return
        let sorted
        if (note) sorted = sortNoteKeys(keys, L.zones)
        else sorted = sortEventKeys(keys)
        ctx.beginPath()
        for (let x = p.x0; x <= p.x1 + 0.01; x += CURVE_STEP) {
          const t = ((x - p.x0) / p.w) * len
          const v = note
            ? valueAtNote(sorted, span, t, refValue)
            : valueAtEvent(sorted, t, refValue)
          const y = valueToY(range, i, v)
          if (x === p.x0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.setLineDash(dash)
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (chInh.length) curve(chInh, ink3, 1, [3, 3])
      if (chOwn.length || L.absolute) curve(chOwn, ink2, 1.5, [])

      // A selected own Bezier key's two handles, under the keys.
      const sortedOwn = note ? sortNoteKeys(chOwn, L.zones) : sortEventKeys(chOwn)
      for (let j = 0; j + 1 < sortedOwn.length; j++) {
        const a = sortedOwn[j]
        if (a.interp !== 'Bezier' || !isSelectedKey(a)) continue
        const pts = bezierHandlePoints(a, sortedOwn[j + 1], (k) => timeToX(keyTime(k)), (v) => valueToY(range, i, v))
        ctx.strokeStyle = select
        ctx.lineWidth = 1
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        ctx.moveTo(pts.from.x, pts.from.y); ctx.lineTo(pts.h1.x, pts.h1.y)
        ctx.moveTo(pts.to.x, pts.to.y); ctx.lineTo(pts.h2.x, pts.h2.y)
        ctx.stroke()
        ctx.globalAlpha = 1
        for (const hp of [pts.h1, pts.h2]) {
          ctx.beginPath()
          ctx.arc(hp.x, hp.y, HANDLE_R, 0, Math.PI * 2)
          ctx.fillStyle = g0
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = select
          ctx.stroke()
        }
      }

      // Keys. Inherited: hollow. Own: filled. Selected: ringed. Shaped by interp.
      const drawKey = (k, filled, dim) => {
        const t = keyTime(k)
        const x = timeToX(t)
        const y = valueToY(range, i, k.value)
        const reached = !note || anchorReached(span, k.anchor, k.pos)
        ctx.globalAlpha = dim || !reached ? 0.45 : 1
        keyPath(ctx, k.interp, x, y, KEY_R)
        if (filled) {
          ctx.fillStyle = inkC
          ctx.fill()
        } else {
          ctx.fillStyle = g0
          ctx.fill()
          ctx.strokeStyle = ink2
          ctx.lineWidth = 1.25
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        return { x, y }
      }
      chInh.forEach((k) => drawKey(k, false, false))
      let selPos = null
      chOwn.forEach((k) => {
        const isSel = L.selected && keyEquals(k, L.selected) && !d
        const pos = drawKey(k, true, false)
        if (isSel) selPos = pos
        if (d && d.draft === k) selPos = pos
        if (!d && inMulti(k) && !isSel) {
          // A multi-selected key: ringed like the selection, thinner.
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, KEY_R + 3, 0, Math.PI * 2)
          ctx.strokeStyle = select
          ctx.lineWidth = 1
          ctx.stroke()
        }
      })
      if (selPos) {
        ctx.beginPath()
        ctx.arc(selPos.x, selPos.y, KEY_R + 3, 0, Math.PI * 2)
        ctx.strokeStyle = d ? accent : select
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    })

    // The drag read-out: where the key is and what it is worth, at the key.
    if (d) {
      const k = d.draft
      const i = LENS_CHANNELS.indexOf(k.channel)
      const range = d.ranges[k.channel]
      const x = timeToX(keyTime(k))
      const y = valueToY(range, i, k.value)
      const text = `${describeKeyPlace(k)} · ${fmtValue(k.channel, k.value, L.absolute)}`
      ctx.font = `10px ${font}`
      const tw = ctx.measureText(text).width + 8
      const bx = Math.min(Math.max(x - tw / 2, 2), W - tw - 2)
      const by = y - KEY_R - 18 < laneTop(i) ? y + KEY_R + 4 : y - KEY_R - 18
      ctx.fillStyle = g0
      ctx.fillRect(bx, by, tw, 14)
      ctx.strokeStyle = g4
      ctx.lineWidth = 1
      ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 13)
      ctx.fillStyle = inkC
      ctx.textAlign = 'left'
      ctx.fillText(text, bx + 4, by + 7.5)
    }

    // A marquee in progress.
    const mq = marqueeRef.current
    if (mq) {
      const x = Math.min(mq.x0, mq.x1)
      const y = Math.min(mq.y0, mq.y1)
      const mw = Math.abs(mq.x1 - mq.x0)
      const mh = Math.abs(mq.y1 - mq.y0)
      ctx.globalAlpha = 0.12
      ctx.fillStyle = select
      ctx.fillRect(x, y, mw, mh)
      ctx.globalAlpha = 1
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = select
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(mw), Math.round(mh))
      ctx.setLineDash([])
    }
  }, [])

  const drawPlayhead = useCallback(() => {
    const canvas = overlayRef.current
    if (!canvas) return
    const L = live.current
    const W = L.width
    const H = LANES_HEIGHT
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const ph = getPlayhead?.()
    if (!ph) return
    const x = Math.round(timeToX(ph.t)) + 0.5
    ctx.strokeStyle = ink('--ui-ink')
    ctx.globalAlpha = ph.inside ? 0.95 : 0.45
    ctx.lineWidth = 1
    ctx.setLineDash(ph.inside ? [] : [2, 3])
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, H)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }, [getPlayhead])

  useEffect(() => { draw(); drawPlayhead() })   // every prop / theme / size change; never per frame
  // The playhead is information (class A): driven by the clock, drawn on its own canvas.
  useEffect(() => (subscribePlayhead ? subscribePlayhead(drawPlayhead) : undefined), [subscribePlayhead, drawPlayhead])

  // ── pointer ────────────────────────────────────────────────────────────────

  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  const laneOf = (py) => {
    const i = Math.floor((py - RULER_H) / LANE_H)
    return i >= 0 && i < LENS_CHANNELS.length ? i : -1
  }

  /** The nearest key under the pointer: an own one (preferred) or an inherited one. */
  const hitKey = (px, py) => {
    const L = live.current
    let best = null
    const consider = (k, idx, own) => {
      const i = LENS_CHANNELS.indexOf(k.channel)
      const chKeys = [...L.ownKeys, ...L.inheritedKeys].filter((x) => x.channel === k.channel)
      const range = rangeFor(k.channel, chKeys)
      const x = timeToX(keyTime(k))
      const y = valueToY(range, i, k.value)
      const dist = Math.hypot(px - x, py - y)
      if (dist <= HIT_PX && (!best || dist < best.dist - (own ? 2 : 0))) best = { idx, own, dist, key: k }
    }
    L.inheritedKeys.forEach((k, idx) => { if (L.kind === 'note') consider(k, idx, false) })
    L.ownKeys.forEach((k, idx) => consider(k, idx, true))
    return best
  }

  /** The nearest shown Bezier handle (of a selected own Bezier key) under the pointer, or null. */
  const hitHandle = (px, py) => {
    const L = live.current
    if (L.readOnly) return null
    let best = null
    LENS_CHANNELS.forEach((ch, i) => {
      const chOwn = L.ownKeys.filter((k) => k.channel === ch)
      const chInh = L.kind === 'note' ? L.inheritedKeys.filter((k) => k.channel === ch) : []
      const range = rangeFor(ch, [...chOwn, ...chInh])
      const sorted = L.kind === 'note' ? sortNoteKeys(chOwn, L.zones) : sortEventKeys(chOwn)
      for (let j = 0; j + 1 < sorted.length; j++) {
        const a = sorted[j]
        if (a.interp !== 'Bezier' || !isSelectedKey(a)) continue
        const pts = bezierHandlePoints(a, sorted[j + 1], (k) => timeToX(keyTime(k)), (v) => valueToY(range, i, v))
        for (const which of [1, 2]) {
          const h = which === 1 ? pts.h1 : pts.h2
          const dist = Math.hypot(px - h.x, py - h.y)
          if (dist <= HANDLE_HIT_PX && (!best || dist < best.dist)) {
            best = { key: a, next: sorted[j + 1], which, laneIndex: i, range, dist }
          }
        }
      }
    })
    return best
  }

  /** The own keys whose drawn centre lies inside the rect {x0, y0, x1, y1}. */
  const ownKeysIn = (r) => {
    const L = live.current
    const x0 = Math.min(r.x0, r.x1); const x1 = Math.max(r.x0, r.x1)
    const y0 = Math.min(r.y0, r.y1); const y1 = Math.max(r.y0, r.y1)
    return L.ownKeys.filter((k) => {
      const i = LENS_CHANNELS.indexOf(k.channel)
      const chKeys = [...L.ownKeys, ...(L.kind === 'note' ? L.inheritedKeys : [])].filter((x) => x.channel === k.channel)
      const x = timeToX(keyTime(k))
      const y = valueToY(rangeFor(k.channel, chKeys), i, k.value)
      return x >= x0 && x <= x1 && y >= y0 && y <= y1
    })
  }

  /** The key for pointer position (px, py) in lane `i`, given the drag's anchor rule. */
  const keyAt = (d, px, py, alt, shift) => {
    const L = live.current
    const ch = LENS_CHANNELS[d.laneIndex]
    const range = d.ranges[ch]
    const t = xToTime(px)
    let anchor = d.start?.anchor ?? d.draft.anchor
    let pos
    if (L.kind === 'event') {
      anchor = 'Origin'
      pos = Math.round(t)
    } else {
      const span = spanOf()
      if (alt) {
        const placed = keyPlaceAt(span, t)
        anchor = placed.anchor
        pos = placed.pos
      } else {
        pos = positionAtNoteTime(span, anchor, t)
      }
      pos = anchor === 'Body' ? roundTo(pos, 0.001) : Math.round(pos)
    }
    let unit = yToUnit(d.laneIndex, py)
    if (shift) unit = d.startUnit + (unit - d.startUnitRaw) * FINE
    unit = Math.min(Math.max(unit, 0), 1)
    const value = clampChannelValue(ch, roundValue(ch, unitToValue(range, unit)), L.absolute)
    return clampKeyPos({ ...d.draft, anchor, pos, value }, L.zones)
  }

  const beginDrag = (idx, start, draft, laneIndex, py) => {
    const L = live.current
    const ch = LENS_CHANNELS[laneIndex]
    const ranges = {}
    LENS_CHANNELS.forEach((c) => {
      ranges[c] = rangeFor(c, [...L.ownKeys, ...(L.kind === 'note' ? L.inheritedKeys : []), draft]
        .filter((k) => k.channel === c))
    })
    const startUnit = valueToUnit(ranges[ch], draft.value)
    dragRef.current = {
      idx, start, draft, laneIndex, ranges, startUnit, startUnitRaw: yToUnit(laneIndex, py), moved: idx < 0,
    }
  }

  const capture = (e) => { try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom */ } }

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    const { px, py } = local(e)
    canvasRef.current.focus({ preventScroll: true })
    const L0 = live.current
    // A selected Bezier key's handle, when it is nearer than any key.
    const handle = hitHandle(px, py)
    if (handle) {
      const k = hitKey(px, py)
      if (!k || handle.dist < k.dist) {
        handleDragRef.current = { ...handle, bez: sanitizeBez(handle.key.bez), moved: false }
        capture(e)
        e.preventDefault()
        draw()
        return
      }
    }
    // Ctrl / Shift: build a multi-selection (toggle a key, or drag a marquee).
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const current = multiRef.current.length ? multiRef.current : (L0.selected ? [spotOf(L0.selected)] : [])
      const hit0 = hitKey(px, py)
      if (hit0?.own) {
        const had = current.some((m) => sameSpot(hit0.key, m))
        multiRef.current = had ? current.filter((m) => !sameSpot(hit0.key, m)) : [...current, spotOf(hit0.key)]
        onSelect?.(had ? (multiKeys()[0] ?? null) : hit0.key)
        e.preventDefault()
        draw()
        return
      }
      marqueeRef.current = {
        x0: px, y0: py, x1: px, y1: py, base: current, additive: (e.ctrlKey || e.metaKey) && e.shiftKey,
      }
      capture(e)
      e.preventDefault()
      draw()
      return
    }
    multiRef.current = []
    const hit = hitKey(px, py)
    if (hit && !hit.own) { onSelect?.(null); return }
    if (hit && hit.own) {
      if (live.current.readOnly) { onSelect?.(hit.key); return }
      const laneIndex = LENS_CHANNELS.indexOf(hit.key.channel)
      beginDrag(hit.idx, hit.key, hit.key, laneIndex, py)
      onSelect?.(hit.key)
    } else {
      const laneIndex = laneOf(py)
      if (laneIndex < 0 || live.current.readOnly) { onSelect?.(null); return }
      const L = live.current
      const ch = LENS_CHANNELS[laneIndex]
      const range = rangeFor(ch, [...L.ownKeys, ...(L.kind === 'note' ? L.inheritedKeys : [])].filter((k) => k.channel === ch))
      const t = xToTime(px)
      const placed = L.kind === 'event' ? { anchor: 'Origin', pos: Math.round(t) } : keyPlaceAt(spanOf(), t)
      const seed = clampKeyPos({
        channel: ch, anchor: placed.anchor, interp: 'Linear',
        pos: placed.anchor === 'Body' ? roundTo(placed.pos, 0.001) : Math.round(placed.pos),
        value: clampChannelValue(ch, roundValue(ch, unitToValue(range, Math.min(Math.max(yToUnit(laneIndex, py), 0), 1))), L.absolute),
      }, L.zones)
      beginDrag(-1, null, seed, laneIndex, py)
    }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* jsdom */ }
    e.preventDefault()
    draw()
  }

  const onPointerMove = (e) => {
    const { px, py } = local(e)
    const hd = handleDragRef.current
    if (hd) {
      const fromY = (y) => unitToValue(hd.range, yToUnit(hd.laneIndex, y))
      hd.bez = dragBezierHandle(hd.key, hd.next, hd.which, px, py, (k) => timeToX(keyTime(k)), fromY)
      hd.moved = true
      draw()
      return
    }
    const mq = marqueeRef.current
    if (mq) {
      mq.x1 = px
      mq.y1 = py
      draw()
      return
    }
    const d = dragRef.current
    if (!d) {
      const hit = hitKey(px, py)
      const h = hitHandle(px, py)
      const next = h && (!hit || h.dist < hit.dist) ? 'handle'
        : hit ? (hit.own ? 'own' : 'inherited') : laneOf(py) >= 0 && !live.current.readOnly ? 'add' : null
      if (hoverRef.current !== next) {
        hoverRef.current = next
        e.currentTarget.style.cursor = next === 'handle' ? 'move' : next === 'own' ? 'grab'
          : next === 'inherited' ? 'not-allowed' : next === 'add' ? 'crosshair' : 'default'
      }
      return
    }
    const next = keyAt(d, px, py, e.altKey, e.shiftKey)
    if (!keyEquals(next, d.draft)) {
      d.draft = next
      d.moved = true
      draw()
    }
  }

  const end = (e, commit) => {
    const hd = handleDragRef.current
    if (hd) {
      handleDragRef.current = null
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
      const start = sanitizeBez(hd.key.bez)
      if (commit && hd.moved && hd.bez.some((v, i) => v !== start[i])) {
        onOp?.({ type: 'update', match: hd.key, patch: { bez: hd.bez } })
        onSelect?.(makeKey({ ...hd.key, bez: hd.bez }))
      }
      draw()
      return
    }
    const mq = marqueeRef.current
    if (mq) {
      marqueeRef.current = null
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
      if (commit) {
        const inside = ownKeysIn(mq).map(spotOf)
        const merged = mq.additive ? [...mq.base] : []
        for (const s of inside) if (!merged.some((m) => sameSpot(s, m))) merged.push(s)
        multiRef.current = merged
        onSelect?.(multiKeys()[0] ?? null)
      }
      draw()
      return
    }
    const d = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* jsdom */ }
    if (!d) return
    if (commit && d.moved && (d.idx < 0 || !keyEquals(d.draft, d.start))) {
      onOp?.(d.idx < 0
        ? { type: 'add', key: d.draft }
        : { type: 'update', match: d.start, patch: { anchor: d.draft.anchor, pos: d.draft.pos, value: d.draft.value } })
      onSelect?.(d.draft)
    }
    draw()   // a cancelled / no-op drag snaps back to the committed keys
  }

  // Right-click: the key menu, for the whole multi-selection when the key is in it,
  // else for that key alone (which becomes the selection). On empty lane it acts on
  // the multi-selection, if there is one.
  const onContextMenu = (e) => {
    e.preventDefault()
    const L = live.current
    if (L.readOnly) return
    const { px, py } = local(e)
    const hit = hitKey(px, py)
    const handle = hit ? null : hitHandle(px, py)
    const k = hit?.own ? hit.key : handle?.key ?? null
    let targets
    if (k) {
      if (multiRef.current.length && inMulti(k)) {
        targets = multiKeys()
      } else {
        multiRef.current = []
        targets = [k]
        onSelect?.(k)
      }
    } else if (multiRef.current.length) {
      targets = multiKeys()
    } else {
      return
    }
    if (!targets.length) return
    const { items, count } = lensKeyMenuItems({
      targets,
      onOp: (op) => onOp?.(op),
      afterInterp: (interp, bez) => {
        // Keep the primary selection pointing at its key after the edit changed it.
        const sel = live.current.selected
        if (sel && targets.some((t) => keyEquals(t, sel))) {
          const next = applyKeyOp([sel], interpOp([sel], interp, bez))
          if (next) onSelect?.(next[0])
        }
      },
      afterDelete: () => { multiRef.current = []; onSelect?.(null) },
    })
    setMenu({ x: e.clientX, y: e.clientY, items, label: count === 1 ? 'Key' : `${count} keys` })
    draw()
  }

  // The keyboard alternative to every drag.
  const onKeyDown = (e) => {
    const L = live.current
    if (e.key === 'Escape' && (dragRef.current || handleDragRef.current || marqueeRef.current)) {
      dragRef.current = null
      handleDragRef.current = null
      marqueeRef.current = null
      draw()
      e.stopPropagation()
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && multiRef.current.length && !L.readOnly) {
      const targets = multiKeys()
      if (targets.length) {
        onOp?.({ type: 'batch', ops: targets.map((match) => ({ type: 'remove', match })) })
        multiRef.current = []
        onSelect?.(null)
        e.preventDefault()
        return
      }
    }
    const ordered = [...L.ownKeys].sort((a, b) => LENS_CHANNELS.indexOf(a.channel) - LENS_CHANNELS.indexOf(b.channel) || keyTime(a) - keyTime(b))
    if (e.key === '[' || e.key === ']') {
      if (!ordered.length) return
      const cur = L.selected ? ordered.findIndex((k) => keyEquals(k, L.selected)) : -1
      const n = ordered.length
      const next = e.key === ']' ? (cur + 1) % n : (cur - 1 + n) % n
      onSelect?.(ordered[next])
      e.preventDefault()
      return
    }
    const k = L.selected && L.ownKeys.find((x) => keyEquals(x, L.selected))
    if (!k || L.readOnly) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      onOp?.({ type: 'remove', match: k })
      onSelect?.(null)
      e.preventDefault()
      return
    }
    const big = e.shiftKey ? 10 : 1
    let patch = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowRight' ? 1 : -1
      if (k.anchor === 'Body') patch = { pos: Math.min(Math.max(k.pos + dir * 0.01 * big, 0), 1) }
      else if (k.anchor === 'Tail') patch = { pos: Math.max(0, k.pos - dir * big) }   // the Tail runs backwards from the note end
      else patch = { pos: Math.max(0, k.pos + dir * big) }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowUp' ? 1 : -1
      const step = k.channel === 'rotationDeg' ? 1 : k.channel === 'zoom' ? 0.01 : 0.005
      const v = k.channel === 'zoom' ? k.value * (1 + dir * step * big) : k.value + dir * step * big
      patch = { value: clampChannelValue(k.channel, roundValue(k.channel, v), L.absolute) }
    }
    if (!patch) return
    const next = clampKeyPos({ ...k, ...patch }, L.zones)
    if (!keyEquals(next, k)) {
      onOp?.({ type: 'update', match: k, patch })
      onSelect?.(next)
    }
    e.preventDefault()
  }

  const keyCount = ownKeys.length
  const aria = `${label}. ${keyCount} ${keyCount === 1 ? 'key' : 'keys'}${inheritedKeys.length ? `, ${inheritedKeys.length} inherited from the hit curve` : ''}. `
    + 'Click a lane to add a key, drag a key to move it. Ctrl or Shift click or drag to select several keys; '
    + 'right-click for interpolation, Bezier and delete. Bracket keys select a key, arrows nudge it, Delete removes the selection.'

  return (
    <div ref={wrapRef} className={styles.lanes} style={{ height: LANES_HEIGHT }} data-theme-epoch={epoch}>
      <canvas
        ref={canvasRef}
        className={styles.lanesCanvas}
        style={{ width, height: LANES_HEIGHT }}
        data-testid="lens-key-lanes"
        tabIndex={0}
        role="application"
        aria-label={aria}
        data-hint={kind === 'note'
          ? 'Lens keys over one note. Filled keys are this curve\'s own; hollow keys are inherited from the hit curve. Click a lane to add a key.'
          : 'Lens keys over one event, in ticks from its start. A keyed channel follows its keys; an unkeyed one holds the static value.'}
        data-hint-mods={kind === 'note'
          ? 'Drag: move · Alt-drag across a band edge: change anchor · Shift: fine · Ctrl/Shift-click or drag: select several · Right-click: interp, Bezier, delete · Esc: cancel'
          : 'Drag: move · Shift: fine · Ctrl/Shift-click or drag: select several · Right-click: interp, Bezier, delete · Esc: cancel'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onPointerLeave={() => { hoverRef.current = null }}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />
      <canvas
        ref={overlayRef}
        className={styles.lanesOverlay}
        style={{ width, height: LANES_HEIGHT }}
        aria-hidden="true"
      />
      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y} items={menu.items} label={menu.label}
          onClose={() => { setMenu(null); draw() }}
        />
      )}
    </div>
  )
}


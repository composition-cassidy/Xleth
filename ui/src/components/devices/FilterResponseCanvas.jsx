import React, { useCallback, useEffect, useRef } from 'react'
import { formatValue } from '../../ui-kit'
import { useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  slotResponseDb, responseFrequencies, RESPONSE_SIZE, FREQ_MIN, FREQ_MAX,
} from '../mixer/filterResponse.js'
import {
  slotWithLiveValues, typeUsesGain, typeGainRange, SLOT_TYPES,
} from '../../stores/filterStore.js'
import { useLiveFrame } from './filterLive.js'

// The Xleth Filter's hero: the response on a log-frequency axis, drawn from the
// engine's own aggregate curve (authoritative, parked at the knobs) with a faint
// per-slot guide curve under it, and one draggable node per slot.
//
// A node sits where its slot's corner is. Drag it sideways for the cutoff. Up and
// down is resonance (Q) for the types that have no gain, scaled so the full height of
// the plot is the whole 0.5 to 30 range and relative to where the drag began; for the
// peak, shelf and tilt types it is the gain, absolute, because that is where the
// curve itself goes. The wheel sets Q for every type, arrows nudge, [ and ] step
// through the slots. A drag previews at most once per frame and commits once on
// release, and Escape puts it back.
//
// While a modulator is moving the filter, the bold line is the engine's LIVE curve,
// the parked one drops back to a dashed ghost, and a rule marks the selected slot's
// live corner. tokenValue() is never called here; colours are read from the canvas's
// own computed style at draw time.

const DB_RANGE = 24
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const LABEL_FREQS = [[100, '100'], [1000, '1k'], [10000, '10k']]
const DB_LINES = [-24, -12, 0, 12, 24]
const LIVE_GUIDE_SIZE = 256
const HIT_PX = 14
const Q_MIN = 0.5
const Q_MAX = 30
const LN_Q_RANGE = Math.log(Q_MAX / Q_MIN)
const PAD = { l: 30, r: 8, t: 8, b: 16 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const LOG_MIN = Math.log(FREQ_MIN)
const LOG_MAX = Math.log(FREQ_MAX)

function readColors(el) {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  const get = (name, fb) => cs?.getPropertyValue(name)?.trim() || fb
  return {
    ground: get('--ui-g0', '#141414'),
    grid: get('--ui-g4', '#3A3A3A'),
    zero: get('--ui-boundary', '#747474'),
    text: get('--ui-ink-3', '#929292'),
    ink: get('--ui-ink', '#E6E6E6'),
    ink2: get('--ui-ink-2', '#B4B4B4'),
    value: get('--ui-value', '#33CED6'),
  }
}

function plotGeometry(w, h) {
  const plotW = Math.max(10, w - PAD.l - PAD.r)
  const plotH = Math.max(10, h - PAD.t - PAD.b)
  return {
    plotW,
    plotH,
    xOf: (f) => PAD.l + ((Math.log(f) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * plotW,
    yOf: (db) => PAD.t + ((DB_RANGE - clamp(db, -DB_RANGE, DB_RANGE)) / (2 * DB_RANGE)) * plotH,
    freqAt: (x) => Math.exp(LOG_MIN + clamp((x - PAD.l) / plotW, 0, 1) * (LOG_MAX - LOG_MIN)),
    dbAt: (y) => DB_RANGE - clamp((y - PAD.t) / plotH, 0, 1) * 2 * DB_RANGE,
  }
}

const slotLabel = (slot, i) => `Slot ${i + 1}, ${SLOT_TYPES[clamp(Math.round(slot?.type ?? 0), 0, SLOT_TYPES.length - 1)].label}`

export default function FilterResponseCanvas({
  slots, selectedSlotIndex, aggregateRef, version, liveBus, liveRef, onSelect, onPreview, onCommit,
}) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()
  // One cached guide curve per slot, keyed by the exact values it was drawn from, so a
  // slot nothing modulates is never recomputed.
  const guideCacheRef = useRef([])
  const nodesRef = useRef([])
  const dragRef = useRef(null)
  const frameRef = useRef(0)
  const pendingRef = useRef(null)
  const propsRef = useRef(null)
  propsRef.current = { slots, selectedSlotIndex, onSelect, onPreview, onCommit }

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW < 24 || cssH < 24) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const tw = Math.round(cssW * dpr)
    const th = Math.round(cssH * dpr)
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const c = readColors(canvas)
    const { xOf, yOf } = plotGeometry(cssW, cssH)
    const padR = cssW - PAD.r
    const padB = cssH - PAD.b

    ctx.fillStyle = c.ground
    ctx.fillRect(0, 0, cssW, cssH)

    // Frequency grid, three labels.
    ctx.lineWidth = 1
    ctx.strokeStyle = c.grid
    ctx.beginPath()
    for (const f of GRID_FREQS) {
      const gx = Math.round(xOf(f)) + 0.5
      ctx.moveTo(gx, PAD.t)
      ctx.lineTo(gx, padB)
    }
    ctx.stroke()
    ctx.font = uiCanvasFont('10px')
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    ctx.fillStyle = c.text
    for (const [f, label] of LABEL_FREQS) ctx.fillText(label, xOf(f), padB + 3)

    // dB grid, the 0 dB rule stronger.
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of DB_LINES) {
      const gy = Math.round(yOf(db)) + 0.5
      ctx.strokeStyle = db === 0 ? c.zero : c.grid
      ctx.beginPath()
      ctx.moveTo(PAD.l, gy)
      ctx.lineTo(padR, gy)
      ctx.stroke()
      ctx.fillStyle = c.text
      ctx.fillText(formatValue(db, 'dB', { unitless: true, decimals: 0, signed: true }), PAD.l - 4, gy)
    }

    // The engine's live frame, when the filter is animating. `animating` means the
    // engine has composed at least one slot, not merely that a poll came back.
    const live = liveRef ? liveRef.current : null
    const animating = !!(live && live.slots && live.slots.some((s) => s.valid))

    const { slots: list, selectedSlotIndex: sel } = propsRef.current
    const guideN = animating ? LIVE_GUIDE_SIZE : RESPONSE_SIZE
    const freqs = responseFrequencies(guideN)
    const cache = guideCacheRef.current
    const nodes = []
    list.forEach((slot, si) => {
      const drawn = animating ? slotWithLiveValues(slot, live.slots[si]) : slot
      const key = `${guideN}|${drawn.enabled ? 1 : 0}|${drawn.type}|${drawn.slope}`
        + `|${drawn.cutoff}|${drawn.q}|${drawn.gain}|${drawn.morph}|${drawn.mix}`
      let entry = cache[si]
      if (!entry || entry.key !== key) {
        entry = { key, curve: slotResponseDb(drawn, live?.sampleRate || 44100, guideN) }
        cache[si] = entry
      }
      const curve = entry.curve
      const isSel = si === sel
      if (curve) {
        ctx.beginPath()
        for (let i = 0; i < guideN; i++) {
          const x = xOf(freqs[i])
          const y = yOf(curve[i])
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = c.value
        ctx.globalAlpha = isSel ? 0.5 : 0.2
        ctx.lineWidth = isSel ? 1.5 : 1
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      // The node rides its own slot's curve at the parked cutoff.
      const cutoff = clamp(Number(slot.cutoff) || 1000, FREQ_MIN, FREQ_MAX)
      const parked = entry.curve
      let db = 0
      if (parked) {
        const t = (Math.log(cutoff) - LOG_MIN) / (LOG_MAX - LOG_MIN)
        // Guide curves are sampled on the same log axis the display uses.
        db = parked[clamp(Math.round(t * (guideN - 1)), 0, guideN - 1)]
      }
      nodes.push({ i: si, x: xOf(cutoff), y: yOf(db), enabled: !!slot.enabled, selected: isSel })
    })
    cache.length = list.length

    const strokeCurve = (arr, alpha, width, dashed, color) => {
      const n = Math.min(arr.length, RESPONSE_SIZE)
      if (n < 2) return
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const f = Math.exp(LOG_MIN + (i / (n - 1)) * (LOG_MAX - LOG_MIN))
        const x = xOf(f)
        const y = yOf(arr[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      if (dashed) ctx.setLineDash([3, 3])
      ctx.strokeStyle = color
      ctx.globalAlpha = alpha
      ctx.lineWidth = width
      ctx.stroke()
      ctx.globalAlpha = 1
      if (dashed) ctx.setLineDash([])
    }

    const agg = aggregateRef.current
    const hasAgg = agg && agg.length > 1
    if (animating && live.curve && live.curve.length > 1) {
      if (hasAgg) strokeCurve(agg, 0.6, 1, true, c.ink2)
      strokeCurve(live.curve, 1, 2, false, c.value)
      // Where the selected slot's corner is this instant: a vertical rule reads as
      // movement on a flat low-pass curve, whose shape barely changes as it sweeps.
      const ls = live.slots[sel]
      if (ls && ls.valid && ls.cutoff >= FREQ_MIN && ls.cutoff <= FREQ_MAX) {
        const mx = Math.round(xOf(ls.cutoff)) + 0.5
        ctx.strokeStyle = c.value
        ctx.globalAlpha = 0.5
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(mx, PAD.t)
        ctx.lineTo(mx, padB)
        ctx.stroke()
        ctx.globalAlpha = 1
        const t = (Math.log(ls.cutoff) - LOG_MIN) / (LOG_MAX - LOG_MIN)
        const idx = clamp(Math.round(t * (live.curve.length - 1)), 0, live.curve.length - 1)
        ctx.fillStyle = c.value
        ctx.beginPath()
        ctx.arc(mx, yOf(live.curve[idx]), 3, 0, 2 * Math.PI)
        ctx.fill()
      }
    } else if (hasAgg) {
      strokeCurve(agg, 1, 2, false, c.value)
    } else if (list.length === 0) {
      ctx.font = uiCanvasFont('11px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = c.text
      ctx.fillText('No slots. Add one to start filtering.', (PAD.l + padR) / 2, (PAD.t + padB) / 2)
    }

    // Nodes last, on top. Selected = filled, enabled = ringed, silenced = dashed ring.
    nodesRef.current = nodes
    for (const n of nodes) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.selected ? 6 : 4.5, 0, 2 * Math.PI)
      if (n.selected) {
        ctx.fillStyle = c.value
        ctx.fill()
      } else {
        ctx.fillStyle = c.ground
        ctx.fill()
      }
      ctx.lineWidth = 2
      ctx.strokeStyle = n.selected ? c.ink : c.value
      if (!n.enabled) ctx.setLineDash([2, 2])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.font = uiCanvasFont('10px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = c.ink
      ctx.fillText(String(n.i + 1), n.x, n.y - 8)
    }

    // The dragged node's readout.
    const drag = dragRef.current
    if (drag) {
      const slot = list[drag.i]
      const node = nodes.find((n) => n.i === drag.i)
      if (slot && node) {
        const q = formatValue(Number(slot.q), 'dB', { unitless: true, decimals: 2 })
        const text = typeUsesGain(slot.type)
          ? `${formatValue(Number(slot.cutoff), 'Hz')} · ${formatValue(Number(slot.gain), 'dB', { signed: true })}`
          : `${formatValue(Number(slot.cutoff), 'Hz')} · Q ${q}`
        ctx.font = uiCanvasFont('11px')
        const left = node.x > cssW / 2
        ctx.textAlign = left ? 'right' : 'left'
        ctx.textBaseline = 'top'
        ctx.fillStyle = c.ink
        ctx.fillText(text, left ? node.x - 12 : node.x + 12, Math.max(PAD.t, Math.min(node.y + 8, padB - 14)))
      }
    }
  }, [aggregateRef, liveRef])

  // Repaint on every input that changes the picture, and on every live frame.
  useEffect(() => { paint() }, [paint, slots, selectedSlotIndex, version, themeEpoch, dprEpoch])
  useLiveFrame(liveBus, () => { paint() })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  // ── Interaction ──────────────────────────────────────────────────────────
  const local = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
  }

  const hit = (x, y) => {
    let best = null
    let bestD = HIT_PX
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - x, n.y - y)
      if (d <= bestD) { best = n; bestD = d }
    }
    return best
  }

  const flush = () => {
    frameRef.current = 0
    const p = pendingRef.current
    pendingRef.current = null
    if (p) propsRef.current.onPreview?.(p.i, p.patch)
  }

  const patchFor = (drag, x, y, w, h) => {
    const g = plotGeometry(w, h)
    const slot = propsRef.current.slots[drag.i]
    const patch = { cutoff: clamp(g.freqAt(x), FREQ_MIN, FREQ_MAX) }
    if (typeUsesGain(slot?.type)) {
      const r = typeGainRange(slot.type)
      patch.gain = clamp(g.dbAt(y), r.min, r.max)
    } else {
      patch.q = clamp(drag.start.q * Math.exp(-((y - drag.startY) / g.plotH) * LN_Q_RANGE), Q_MIN, Q_MAX)
    }
    return patch
  }

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    const { x, y } = local(e)
    const n = hit(x, y)
    canvasRef.current.focus({ preventScroll: true })
    if (!n) return
    const slot = propsRef.current.slots[n.i]
    propsRef.current.onSelect?.(n.i)
    dragRef.current = {
      i: n.i,
      startY: y,
      start: { cutoff: slot.cutoff, q: slot.q, gain: slot.gain },
      last: null,
    }
    canvasRef.current.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    const canvas = canvasRef.current
    const { x, y, w, h } = local(e)
    const drag = dragRef.current
    if (!drag) {
      canvas.style.cursor = hit(x, y) ? 'grab' : 'default'
      return
    }
    drag.last = patchFor(drag, x, y, w, h)
    pendingRef.current = { i: drag.i, patch: drag.last }
    if (!frameRef.current) frameRef.current = requestAnimationFrame(flush)
  }

  const endDrag = (e) => {
    const canvas = canvasRef.current
    const drag = dragRef.current
    dragRef.current = null
    if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = 0 }
    pendingRef.current = null
    if (e?.pointerId != null && canvas?.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    if (!drag) return
    if (e?.type === 'pointerup') {
      const { x, y, w, h } = local(e)
      propsRef.current.onCommit?.(drag.i, patchFor(drag, x, y, w, h))
    } else {
      propsRef.current.onPreview?.(drag.i, drag.start)
    }
    paint()
  }

  const nudge = (patch) => {
    const i = propsRef.current.selectedSlotIndex
    if (i < 0) return
    propsRef.current.onCommit?.(i, patch)
  }

  const onKeyDown = (e) => {
    const { slots: list, selectedSlotIndex: i } = propsRef.current
    if (e.key === 'Escape' && dragRef.current) {
      const drag = dragRef.current
      dragRef.current = null
      pendingRef.current = null
      propsRef.current.onPreview?.(drag.i, drag.start)
      e.preventDefault()
      return
    }
    if (e.key === '[' || e.key === ']') {
      if (list.length === 0) return
      const next = (Math.max(0, i) + (e.key === ']' ? 1 : -1) + list.length) % list.length
      propsRef.current.onSelect?.(next)
      e.preventDefault()
      return
    }
    const slot = list[i]
    if (!slot || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return
    const fine = e.shiftKey ? 6 : 1
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      nudge({ cutoff: clamp(slot.cutoff * 2 ** ((dir * fine) / 24), FREQ_MIN, FREQ_MAX) })
    } else if (typeUsesGain(slot.type)) {
      const r = typeGainRange(slot.type)
      nudge({ gain: clamp(slot.gain + dir * 0.5 * fine, r.min, r.max) })
    } else {
      nudge({ q: clamp(slot.q * 1.05 ** (dir * fine), Q_MIN, Q_MAX) })
    }
    e.preventDefault()
  }

  // Wheel = resonance. Native, non-passive, so the dock does not scroll under it.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (e) => {
      const { slots: list, selectedSlotIndex: i } = propsRef.current
      const slot = list[i]
      if (!slot) return
      e.preventDefault()
      const dir = e.deltaY < 0 ? 1 : -1
      propsRef.current.onCommit?.(i, { q: clamp(slot.q * 1.1 ** dir, Q_MIN, Q_MAX) })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])

  const sel = slots[selectedSlotIndex]
  const label = sel
    ? `Filter response. ${slotLabel(sel, selectedSlotIndex)} selected, cutoff ${formatValue(Number(sel.cutoff), 'Hz')}. `
      + 'Drag a node: sideways is cutoff, up and down is resonance or gain. Arrow keys nudge, the wheel sets Q, [ and ] change slot.'
    : 'Filter response. No slot selected.'

  return (
    <canvas
      ref={canvasRef}
      role="application"
      aria-label={label}
      tabIndex={0}
      data-hint="Drag a node: sideways is cutoff, up and down is resonance (gain for peak and shelves). Wheel sets Q. Arrow keys nudge."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  )
}

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { drawEnvelope } from '../../utils/waveformRenderer.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import { labelHexColor } from '../../constants/labels.js'
import { backingSize, getDpr } from '../../ui-kit/dpr'
import { formatSpan, formatTimecode } from './pickerFormat.js'
import {
  centreView, followView, moveView, panView, resolveView, rulerLabel, rulerStep,
  timeToX, viewForRange, xToTime, zoomView,
} from './pickerView.js'
import { makeTile, pickTile, rememberTile, tileRequest, tileSlice } from './pickerPeaks.js'
import styles from './SamplePicker.module.css'

// Rows of the canvas, top to bottom. The waveform takes whatever height is left.
export const OVERVIEW_H = 16   // the whole source, with the visible window drawn on it
export const RULER_H = 18      // time across the visible window
export const LANE_H = 14       // marked samples as named bars (only while "show marks" is on)

const HANDLE_HIT = 6           // px either side of an In / Out line
const FLAG = 14                // the lettered tab at the foot of an In / Out line
const MIN_REGION_DRAG = 0.01   // shortest sweep that counts as a region (s)
const FETCH_DEBOUNCE_MS = 40
const EDGE_SCROLL_MS = 30

const HINT_WAVE = 'Waveform. Drag to scrub the playhead; drag an In or Out line to move it'
const HINT_WAVE_MODS = 'Shift+drag or middle-drag: mark In to Out · Wheel: zoom · Shift+wheel: pan · Z: zoom to selection · F: fit'
const HINT_RULER = 'Time ruler. Drag to scrub the playhead'
const HINT_OVERVIEW = 'Overview of the whole source. Drag the window to pan, click to jump'
const HINT_OVERVIEW_MODS = 'Double-click: fit the whole source'
const HINT_LANE = 'Marked samples. Click one to load its In and Out'

// A CSS colour (#rgb, #rrggbb or rgb()/rgba()) as [r, g, b], or null.
function parseColor(color) {
  const c = String(color || '').trim()
  if (c.startsWith('#')) {
    let h = c.slice(1)
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('')
    const n = parseInt(h.slice(0, 6), 16)
    return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = /rgba?\(([^)]+)\)/.exec(c)
  if (!m) return null
  const [r, g, b] = m[1].split(/[\s,/]+/).map(Number)
  return [r, g, b].every(Number.isFinite) ? [r, g, b] : null
}

// The same colour with a new alpha, for canvas fills.
function withAlpha(color, a) {
  const rgb = parseColor(color)
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})` : String(color || '')
}

// WCAG relative luminance and contrast, on [r, g, b].
function luminance(rgb) {
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * A label's identity colour, made legible on the waveform's ground. The label
 * hues are fixed per label and are pastel: on a dark ground they read as they
 * are, on a light one (the light theme) some all but vanish, so the colour is
 * walked toward the ink until it reaches 3:1 (the non-text floor). The hue is
 * kept; only as much ink as is needed is mixed in.
 */
export function legibleOn(color, ground, ink, min = 3) {
  const c = parseColor(color)
  const g = parseColor(ground)
  const i = parseColor(ink)
  if (!c || !g || !i) return String(color || '')
  for (let k = 0; k <= 1.0001; k += 0.1) {
    const mixed = [0, 1, 2].map((n) => Math.round(c[n] + (i[n] - c[n]) * k))
    if (contrast(mixed, g) >= min) return `rgb(${mixed[0]},${mixed[1]},${mixed[2]})`
  }
  return String(ink)
}

/** Whichever of two inks reads better over `fill`. */
function inkOver(fill, a, b) {
  const f = parseColor(fill)
  const ra = parseColor(a)
  const rb = parseColor(b)
  if (!f || !ra || !rb) return a
  return contrast(ra, f) >= contrast(rb, f) ? a : b
}

const crisp = (x) => Math.round(x) + 0.5

/**
 * The editor's waveform: overview strip, time ruler, optional lane of marked
 * samples, and the waveform itself with the In / Out selection.
 *
 * Mouse (unchanged from the old scrubber unless marked NEW):
 *   Left drag               scrub the playhead; on an In / Out line, move that edge
 *   Middle drag             sweep a new In / Out region in one gesture
 *   Shift + left drag       NEW: the same sweep, for mice and trackpads without a middle button
 *   Wheel                   zoom, centred on the cursor
 *   Shift + wheel, h-wheel  pan
 *   Overview                NEW: drag the window to pan, click to jump, double-click to fit
 *                           (replaces the thin scrollbar that only existed while zoomed)
 *   Marked lane             NEW: click a bar to load that sample's In / Out
 *
 * Props:
 *   filePath, waveformData ({ peaks, duration, stride }), waveformError, duration
 *   currentTime, playing     the playhead; while playing it is interpolated from
 *   clockRef                 { pos, wall, stopAt } between engine position polls
 *   inPoint, outPoint, onInChange, onOutChange, onSeek
 *   onRegionDragEnd({ start, end })   a sweep committed a region
 *   samples, showMarks, selectedId, onSelectSample
 *   pendingLabel, pendingName         what the selection will be added as
 *   onViewChange({ start, end, dur, zoomed, width })
 *
 * Ref: { fit(), zoomToSelection(), zoomBy(factor), focus() }
 */
const PickerWaveform = forwardRef(function PickerWaveform({
  filePath,
  waveformData,
  waveformError,
  duration,
  currentTime,
  playing = false,
  clockRef,
  inPoint,
  outPoint,
  onSeek,
  onInChange,
  onOutChange,
  onRegionDragEnd,
  samples,
  showMarks = false,
  selectedId = null,
  onSelectSample,
  pendingLabel,
  pendingName,
  onViewChange,
}, ref) {
  const rootRef = useRef(null)
  const canvasRef = useRef(null)
  const overlayRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  // ── Size ──────────────────────────────────────────────────────────────────
  const [size, setSize] = useState({ w: 0, h: 0 })
  const measure = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect?.()
    return { w: Math.max(0, Math.floor(rect?.width || 0)), h: Math.max(0, Math.floor(rect?.height || 0)) }
  }, [])
  useEffect(() => {
    const apply = () => setSize((cur) => {
      const next = measure()
      return next.w === cur.w && next.h === cur.h ? cur : next
    })
    apply()
    if (typeof ResizeObserver === 'undefined' || !rootRef.current) return undefined
    const observer = new ResizeObserver(apply)
    observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [measure])

  // ── View (seconds; null = fit) ────────────────────────────────────────────
  const [view, setViewState] = useState(null)
  const viewRef = useRef(null)
  const durationRef = useRef(duration)
  durationRef.current = duration
  const setView = useCallback((next) => {
    if (next === viewRef.current) return
    viewRef.current = next
    setViewState(next)
  }, [])
  const resolved = useMemo(() => resolveView(view, duration), [view, duration])

  useEffect(() => {
    onViewChange?.({ ...resolved, width: size.w })
  }, [resolved, size.w, onViewChange])

  // Latest props for handlers that are registered once.
  const live = useRef({})
  live.current = { inPoint, outPoint, onSeek, onInChange, onOutChange, onRegionDragEnd, onSelectSample, samples, showMarks }

  const laneOn = showMarks && Array.isArray(samples) && samples.length > 0
  const bodyTop = OVERVIEW_H + RULER_H + (laneOn ? LANE_H : 0)

  // ── Peaks: the whole-file base plus a small cache of zoomed tiles ─────────
  const base = useMemo(() => {
    if (!waveformData?.peaks) return null
    return makeTile(waveformData.peaks, 0, waveformData.duration || duration)
  }, [waveformData, duration])
  const tilesRef = useRef([])
  const [tilesEpoch, setTilesEpoch] = useState(0)
  useEffect(() => { tilesRef.current = []; setTilesEpoch((n) => n + 1) }, [filePath])

  useEffect(() => {
    if (!filePath || !base || !(duration > 0) || size.w <= 0) return undefined
    const best = pickTile(tilesRef.current, base, resolved.start, resolved.end)
    const request = tileRequest(best, resolved.start, resolved.end, duration, backingSize(size.w))
    if (!request) return undefined
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const raw = await window.xleth?.waveform?.getFilePeaks(filePath, request.start, request.end, request.cols, -1)
        if (cancelled || !raw?.peaks?.length) return
        const tile = makeTile(Float32Array.from(raw.peaks), request.start, request.end, request.cols)
        if (!tile) return
        tilesRef.current = rememberTile(tilesRef.current, tile)
        setTilesEpoch((n) => n + 1)
      } catch (e) {
        console.warn('[SamplePicker] Waveform detail fetch failed:', e?.message ?? e)
      }
    }, FETCH_DEBOUNCE_MS)
    // A superseded request is dropped before it is sent; one already in flight
    // is still a valid tile for its window, but this effect no longer owns it.
    return () => { cancelled = true; clearTimeout(timer) }
  }, [filePath, base, duration, resolved.start, resolved.end, size.w, themeEpoch])

  // ── Base canvas ───────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const { w: W, h: H } = size
    if (!canvas || W <= 0 || H <= 0) return
    const dpr = getDpr()
    const bw = backingSize(W, dpr)
    const bh = backingSize(H, dpr)
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const g0 = tokenValue('--ui-g0')
    const g1 = tokenValue('--ui-g1')
    const g2 = tokenValue('--ui-g2')
    const g4 = tokenValue('--ui-g4')
    const ink = tokenValue('--ui-ink')
    const ink2 = tokenValue('--ui-ink-2')
    const ink3 = tokenValue('--ui-ink-3')
    const select = tokenValue('--ui-select')

    const v = resolved
    const tx = (t) => timeToX(t, v, W)
    const bodyH = Math.max(1, H - bodyTop)
    const bodyBottom = bodyTop + bodyH
    const marks = Array.isArray(samples) ? samples : []
    const hasSel = inPoint !== null && outPoint !== null
    const selStart = hasSel ? Math.min(inPoint, outPoint) : null
    const selEnd = hasSel ? Math.max(inPoint, outPoint) : null
    const tones = new Map()
    const tone = (label) => {
      if (!tones.has(label)) tones.set(label, legibleOn(labelHexColor(label) || select, g0, ink))
      return tones.get(label)
    }
    const pendingColor = tone(pendingLabel)

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = g0
    ctx.fillRect(0, 0, W, H)

    // ── Overview: the whole source ─────────────────────────────────────────
    ctx.fillStyle = g1
    ctx.fillRect(0, 0, W, OVERVIEW_H)
    if (base && duration > 0) {
      drawEnvelope(ctx, base.peaks, 0, 1, W, OVERVIEW_H - 2, 0, base.cols, withAlpha(ink3, 0.9))
    }
    if (duration > 0) {
      const ox = (t) => (t / duration) * W
      for (const s of marks) {
        const a = ox(Math.min(s.startTime, s.endTime))
        const b = ox(Math.max(s.startTime, s.endTime))
        ctx.fillStyle = tone(s.label)
        ctx.fillRect(a, OVERVIEW_H - 3, Math.max(1, b - a), 3)
      }
      if (hasSel && selEnd > selStart) {
        ctx.fillStyle = withAlpha(pendingColor, 0.35)
        ctx.fillRect(ox(selStart), 0, Math.max(1, ox(selEnd) - ox(selStart)), OVERVIEW_H - 3)
      }
      if (v.zoomed) {
        const a = ox(v.start)
        const b = ox(v.end)
        ctx.fillStyle = withAlpha(g0, 0.62)
        ctx.fillRect(0, 0, a, OVERVIEW_H)
        ctx.fillRect(b, 0, W - b, OVERVIEW_H)
        ctx.strokeStyle = ink
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(3, Math.round(b - a) - 1), OVERVIEW_H - 1)
      }
    }

    // ── Ruler ──────────────────────────────────────────────────────────────
    const rulerTop = OVERVIEW_H
    ctx.fillStyle = g2
    ctx.fillRect(0, rulerTop, W, RULER_H)
    ctx.strokeStyle = g4
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, rulerTop + 0.5); ctx.lineTo(W, rulerTop + 0.5)
    ctx.moveTo(0, rulerTop + RULER_H - 0.5); ctx.lineTo(W, rulerTop + RULER_H - 0.5)
    ctx.stroke()
    if (duration > 0) {
      const pxPerSec = W / v.dur
      const { major, minor } = rulerStep(pxPerSec)
      if (minor < major) {
        ctx.strokeStyle = g4
        ctx.beginPath()
        for (let i = Math.ceil(v.start / minor - 1e-9); i * minor <= v.end; i += 1) {
          const x = crisp(tx(i * minor))
          ctx.moveTo(x, rulerTop + RULER_H - 4); ctx.lineTo(x, rulerTop + RULER_H)
        }
        ctx.stroke()
      }
      ctx.strokeStyle = ink3
      ctx.fillStyle = ink2
      ctx.font = uiCanvasFont('500 10px')
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.beginPath()
      for (let i = Math.ceil(v.start / major - 1e-9); i * major <= v.end; i += 1) {
        const t = i * major
        const x = crisp(tx(t))
        ctx.moveTo(x, rulerTop + 3); ctx.lineTo(x, rulerTop + RULER_H)
        if (x < W - 30) ctx.fillText(rulerLabel(t, major), x + 4, rulerTop + RULER_H / 2)
      }
      ctx.stroke()
    }

    // ── Marked lane: named bars, one per marked sample ─────────────────────
    if (laneOn) {
      const laneTop = OVERVIEW_H + RULER_H
      ctx.font = uiCanvasFont('600 10px')
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      for (const s of marks) {
        const a = tx(Math.min(s.startTime, s.endTime))
        const b = tx(Math.max(s.startTime, s.endTime))
        if (b < 0 || a > W) continue
        const x = Math.max(-1, a)
        const w = Math.max(2, Math.min(W + 1, b) - x)
        const color = tone(s.label)
        ctx.fillStyle = color
        ctx.fillRect(x, laneTop + 1, w, LANE_H - 2)
        ctx.strokeStyle = g0
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x) + 0.5, laneTop + 1.5, Math.max(1, Math.round(w) - 1), LANE_H - 3)
        if (s.id === selectedId) {
          ctx.strokeStyle = ink
          ctx.strokeRect(Math.round(x) + 0.5, laneTop + 1.5, Math.max(1, Math.round(w) - 1), LANE_H - 3)
        }
        if (w > 26 && s.name) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(x, laneTop, w - 2, LANE_H)
          ctx.clip()
          ctx.fillStyle = inkOver(color, g0, ink)
          ctx.fillText(String(s.name), Math.max(x, 0) + 4, laneTop + LANE_H / 2 + 0.5)
          ctx.restore()
        }
      }
      ctx.strokeStyle = g4
      ctx.beginPath()
      ctx.moveTo(0, laneTop + LANE_H - 0.5); ctx.lineTo(W, laneTop + LANE_H - 0.5)
      ctx.stroke()
    }

    // ── Waveform ───────────────────────────────────────────────────────────
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, bodyTop, W, bodyH)
    ctx.clip()

    if (showMarks) {
      for (const s of marks) {
        const a = tx(Math.min(s.startTime, s.endTime))
        const b = tx(Math.max(s.startTime, s.endTime))
        if (b < 0 || a > W || b <= a) continue
        ctx.fillStyle = withAlpha(tone(s.label), 0.1)
        ctx.fillRect(a, bodyTop, b - a, bodyH)
      }
    }
    if (hasSel && selEnd > selStart) {
      ctx.fillStyle = withAlpha(select, 0.1)
      ctx.fillRect(tx(selStart), bodyTop, tx(selEnd) - tx(selStart), bodyH)
    }

    ctx.strokeStyle = g4
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, crisp(bodyTop + bodyH / 2)); ctx.lineTo(W, crisp(bodyTop + bodyH / 2))
    ctx.stroke()

    const tile = base && duration > 0 ? pickTile(tilesRef.current, base, v.start, v.end) : null
    if (tile) {
      const { c0, c1, t0, t1 } = tileSlice(tile, v.start, v.end)
      const x0 = tx(t0)
      const w = tx(t1) - x0
      const wave = (fill, rms) => {
        if (c1 > c0 && w > 0) drawEnvelope(ctx, tile.peaks, x0, bodyTop + 2, w, bodyH - 4, c0, c1, fill, rms)
      }
      // Neutral ink for the source; a span the user has claimed wears its label's colour.
      wave(withAlpha(ink3, 0.6), withAlpha(ink2, 0.9))
      const tint = (start, end, color) => {
        const a = Math.max(0, tx(start))
        const b = Math.min(W, tx(end))
        if (b <= a) return
        ctx.save()
        ctx.beginPath()
        ctx.rect(a, bodyTop, b - a, bodyH)
        ctx.clip()
        wave(withAlpha(color, 0.5), color)
        ctx.restore()
      }
      if (showMarks) {
        for (const s of marks) tint(Math.min(s.startTime, s.endTime), Math.max(s.startTime, s.endTime), tone(s.label))
      }
      if (hasSel && selEnd > selStart) tint(selStart, selEnd, pendingColor)
    } else {
      ctx.fillStyle = ink3
      ctx.font = uiCanvasFont('500 12px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(waveformError ? 'Waveform unavailable' : 'Loading waveform…', W / 2, bodyTop + bodyH / 2)
    }

    // The selection says what it will become: a stripe in the label's colour, its name and length.
    if (hasSel && selEnd > selStart) {
      const a = tx(selStart)
      const b = tx(selEnd)
      ctx.fillStyle = pendingColor
      ctx.fillRect(a, bodyTop, b - a, 2)
      const name = pendingName ? String(pendingName) : ''
      const length = formatSpan(selEnd - selStart)
      ctx.font = uiCanvasFont('600 11px')
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const left = Math.max(a, 0) + 5
      const room = Math.min(b, W) - left - 5
      const nameW = name ? ctx.measureText(name).width : 0
      const lengthW = ctx.measureText(length).width
      if (name && nameW + lengthW + 8 <= room) {
        ctx.fillStyle = ink
        ctx.fillText(name, left, bodyTop + 6)
        ctx.fillStyle = ink2
        ctx.fillText(length, left + nameW + 8, bodyTop + 6)
      } else if (lengthW <= room) {
        ctx.fillStyle = ink2
        ctx.fillText(length, left, bodyTop + 6)
      }
    }
    ctx.restore()

    // In / Out lines. The lettered tab hangs outward, so it never covers the selected audio.
    const handle = (time, letter, outward) => {
      if (time === null) return
      const x = tx(time)
      if (x < -FLAG || x > W + FLAG) return
      ctx.strokeStyle = ink
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(crisp(x), bodyTop); ctx.lineTo(crisp(x), bodyBottom)
      ctx.stroke()
      const fx = outward < 0 ? Math.round(x) - FLAG + 1 : Math.round(x)
      ctx.fillStyle = ink
      ctx.fillRect(fx, bodyBottom - FLAG, FLAG, FLAG)
      ctx.fillStyle = g0
      ctx.font = uiCanvasFont('700 10px')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(letter, fx + FLAG / 2, bodyBottom - FLAG / 2 + 0.5)
    }
    const inIsLeft = !hasSel || inPoint <= outPoint
    handle(inPoint, 'I', inIsLeft ? -1 : 1)
    handle(outPoint, 'O', inIsLeft ? 1 : -1)
  // tilesEpoch and themeEpoch are redraw triggers: the tiles live in a ref and the colours on :root.
  }, [size, resolved, base, duration, samples, showMarks, laneOn, bodyTop, selectedId, inPoint, outPoint,
    pendingLabel, pendingName, waveformError, tilesEpoch, themeEpoch])

  useEffect(() => { draw() }, [draw])

  // ── Overlay canvas: playhead and hover line (redrawn every frame while playing) ──
  const hoverRef = useRef(null)   // { x } while the pointer is over the ruler, lane or waveform
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime

  const drawOverlay = useCallback((time) => {
    const canvas = overlayRef.current
    const { w: W, h: H } = size
    if (!canvas || W <= 0 || H <= 0) return
    const dpr = getDpr()
    const bw = backingSize(W, dpr)
    const bh = backingSize(H, dpr)
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!(duration > 0)) return

    const v = resolveView(viewRef.current, duration)
    const g2 = tokenValue('--ui-g2')
    const ink = tokenValue('--ui-ink')
    const boundary = tokenValue('--ui-boundary')
    const value = tokenValue('--ui-value')

    const hover = hoverRef.current
    if (hover) {
      const x = crisp(hover.x)
      ctx.strokeStyle = withAlpha(ink, 0.4)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, OVERVIEW_H); ctx.lineTo(x, H)
      ctx.stroke()
      const text = formatTimecode(xToTime(hover.x, v, W, duration))
      ctx.font = uiCanvasFont('500 10px')
      const tw = ctx.measureText(text).width + 8
      const left = Math.max(0, Math.min(W - tw, hover.x + 4))
      ctx.fillStyle = g2
      ctx.fillRect(left, OVERVIEW_H + 1, tw, RULER_H - 2)
      ctx.strokeStyle = boundary
      ctx.strokeRect(Math.round(left) + 0.5, OVERVIEW_H + 1.5, Math.round(tw) - 1, RULER_H - 3)
      ctx.fillStyle = ink
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, left + 4, OVERVIEW_H + RULER_H / 2)
    }

    // Playhead: on the overview, and through the ruler and the waveform.
    ctx.fillStyle = value
    ctx.fillRect(Math.round((time / duration) * W), 0, 1, OVERVIEW_H)
    const px = timeToX(time, v, W)
    if (px >= -1 && px <= W + 1) {
      const x = Math.round(px)
      ctx.fillRect(x, OVERVIEW_H, 1, H - OVERVIEW_H)
      ctx.beginPath()
      ctx.moveTo(x - 5, OVERVIEW_H); ctx.lineTo(x + 6, OVERVIEW_H); ctx.lineTo(x + 0.5, OVERVIEW_H + 7)
      ctx.closePath()
      ctx.fill()
    }
  }, [size, duration, themeEpoch])

  const clockNow = useCallback(() => {
    const clock = clockRef?.current
    if (!clock || typeof performance === 'undefined') return currentTimeRef.current
    const limit = clock.stopAt ?? durationRef.current ?? Infinity
    return Math.max(0, Math.min(clock.pos + (performance.now() - clock.wall) / 1000, limit))
  }, [clockRef])

  useEffect(() => { drawOverlay(playing ? clockNow() : currentTime) }, [drawOverlay, currentTime, playing, view, clockNow])

  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== 'function') return undefined
    let raf = 0
    const tick = () => { drawOverlay(clockNow()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, drawOverlay, clockNow])

  // ── Geometry helpers (refs only, so once-registered handlers stay correct) ─
  const geometry = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect?.()
    const d = durationRef.current || 0
    return { rect, d, v: resolveView(viewRef.current, d), W: rect?.width || 0 }
  }, [])

  const timeAt = useCallback((clientX) => {
    const { rect, d, v, W } = geometry()
    if (!rect || d <= 0 || W <= 0) return 0
    return xToTime(clientX - rect.left, v, W, d)
  }, [geometry])

  const zoneAt = useCallback((clientY) => {
    const { rect } = geometry()
    const y = clientY - (rect?.top || 0)
    const lane = live.current.showMarks && (live.current.samples?.length || 0) > 0
    if (y < OVERVIEW_H) return 'overview'
    if (y < OVERVIEW_H + RULER_H) return 'ruler'
    if (lane && y < OVERVIEW_H + RULER_H + LANE_H) return 'lane'
    return 'body'
  }, [geometry])

  const handleAt = useCallback((clientX, clientY) => {
    const { rect, d, v, W } = geometry()
    if (!rect || d <= 0 || W <= 0) return null
    const { inPoint: tin, outPoint: tout } = live.current
    const x = clientX - rect.left
    const inFlagRow = clientY >= rect.bottom - FLAG
    const hasBoth = tin !== null && tout !== null
    const inIsLeft = !hasBoth || tin <= tout
    const distance = (time, outward) => {
      if (time === null) return Infinity
      const hx = timeToX(time, v, W)
      const dx = x - hx
      if (Math.abs(dx) <= HANDLE_HIT) return Math.abs(dx)
      // The lettered tab is part of the handle.
      if (inFlagRow && dx * outward > 0 && Math.abs(dx) <= FLAG) return HANDLE_HIT + 1
      return Infinity
    }
    const dIn = distance(tin, inIsLeft ? -1 : 1)
    const dOut = distance(tout, inIsLeft ? 1 : -1)
    if (dIn === Infinity && dOut === Infinity) return null
    if (dIn === dOut) return (x < timeToX(tin, v, W)) === inIsLeft ? 'in' : 'out'
    return dIn < dOut ? 'in' : 'out'
  }, [geometry])

  const sampleAt = useCallback((clientX) => {
    const t = timeAt(clientX)
    let hit = null
    for (const s of live.current.samples || []) {
      const a = Math.min(s.startTime, s.endTime)
      const b = Math.max(s.startTime, s.endTime)
      if (t < a || t > b) continue
      if (!hit || b - a < Math.abs(hit.endTime - hit.startTime)) hit = s
    }
    return hit
  }, [timeAt])

  // ── Drags ─────────────────────────────────────────────────────────────────
  // One drag at a time, tracked in a ref and finished by document-level
  // listeners, so it survives the pointer leaving the canvas and still commits
  // if the button is released outside it.
  const dragRef = useRef(null)
  const lastXRef = useRef(0)
  const edgeTimerRef = useRef(null)

  const applyDrag = useCallback((clientX) => {
    const drag = dragRef.current
    if (!drag) return
    const p = live.current
    if (drag.kind === 'pan') {
      const { rect, d } = geometry()
      if (!rect || d <= 0) return
      const t = ((clientX - rect.left) / rect.width) * d
      setView(moveView(viewRef.current, d, t - drag.grab))
      return
    }
    const t = timeAt(clientX)
    if (drag.kind === 'seek') p.onSeek?.(t)
    else if (drag.kind === 'in') p.onInChange?.(t)
    else if (drag.kind === 'out') p.onOutChange?.(t)
    else if (drag.kind === 'sweep') {
      p.onInChange?.(Math.min(drag.anchor, t))
      p.onOutChange?.(Math.max(drag.anchor, t))
    }
  }, [geometry, setView, timeAt])

  const stopEdgeScroll = useCallback(() => {
    if (edgeTimerRef.current) clearInterval(edgeTimerRef.current)
    edgeTimerRef.current = null
  }, [])

  // While an edge or a sweep is dragged past the canvas, the view follows it.
  const startEdgeScroll = useCallback(() => {
    stopEdgeScroll()
    edgeTimerRef.current = setInterval(() => {
      const drag = dragRef.current
      if (!drag || drag.kind === 'pan' || drag.kind === 'seek' || !viewRef.current) return
      const { rect, d, v } = geometry()
      if (!rect || d <= 0) return
      const x = lastXRef.current
      const over = x < rect.left ? x - rect.left : x > rect.right ? x - rect.right : 0
      if (!over) return
      const next = panView(viewRef.current, d, (Math.max(-80, Math.min(80, over)) / rect.width) * v.dur * 0.25)
      if (next !== viewRef.current) { setView(next); applyDrag(x) }
    }, EDGE_SCROLL_MS)
  }, [applyDrag, geometry, setView, stopEdgeScroll])

  const beginDrag = useCallback((drag, clientX) => {
    dragRef.current = drag
    lastXRef.current = clientX
    if (drag.kind !== 'pan' && drag.kind !== 'seek') startEdgeScroll()
  }, [startEdgeScroll])

  useEffect(() => {
    function onMove(e) {
      if (!dragRef.current) return
      lastXRef.current = e.clientX
      applyDrag(e.clientX)
    }
    function onUp(e) {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      stopEdgeScroll()
      if (drag.kind !== 'sweep') return
      const p = live.current
      const t = timeAt(e.clientX)
      const start = Math.min(drag.anchor, t)
      const end = Math.max(drag.anchor, t)
      if (end - start >= MIN_REGION_DRAG) {
        p.onInChange?.(start)
        p.onOutChange?.(end)
        p.onRegionDragEnd?.({ start, end })
      } else {
        // A stray click with no drag: put back whatever was set before it.
        p.onInChange?.(drag.prevIn)
        p.onOutChange?.(drag.prevOut)
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      stopEdgeScroll()
    }
  }, [applyDrag, stopEdgeScroll, timeAt])

  const startSweep = useCallback((e) => {
    const p = live.current
    const t = timeAt(e.clientX)
    // Remember the current points so a click with no drag can be rolled back
    // instead of wiping a selection the user already set.
    beginDrag({ kind: 'sweep', anchor: t, prevIn: p.inPoint, prevOut: p.outPoint }, e.clientX)
    p.onInChange?.(t)
    p.onOutChange?.(t)
  }, [beginDrag, timeAt])

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0 && e.button !== 1) return
    const zone = zoneAt(e.clientY)
    const p = live.current
    // The waveform takes focus on any press, so the keys that follow are the editor's.
    rootRef.current?.focus?.({ preventScroll: true })

    if (e.button === 1) {
      e.preventDefault()   // also suppresses Chrome's autoscroll cursor
      if (zone !== 'overview') startSweep(e)
      return
    }
    e.preventDefault()

    if (zone === 'overview') {
      const { rect, d, v } = geometry()
      if (!rect || d <= 0) return
      // Fitted, the overview shows exactly what the waveform shows, so it scrubs
      // like the ruler (falls through). Zoomed, it moves the window.
      if (v.zoomed) {
        const t = ((e.clientX - rect.left) / rect.width) * d
        const inside = t >= v.start && t <= v.end
        if (!inside) setView(centreView(viewRef.current, d, t))
        const now = resolveView(viewRef.current, d)
        beginDrag({ kind: 'pan', grab: t - now.start }, e.clientX)
        return
      }
    }

    if (zone === 'lane') {
      const hit = sampleAt(e.clientX)
      if (hit) { p.onSelectSample?.(hit); return }
    }

    if (zone === 'body') {
      const edge = handleAt(e.clientX, e.clientY)
      if (edge) { beginDrag({ kind: edge }, e.clientX); return }
      if (e.shiftKey) { startSweep(e); return }
    }

    beginDrag({ kind: 'seek' }, e.clientX)
    p.onSeek?.(timeAt(e.clientX))
  }, [beginDrag, geometry, handleAt, sampleAt, setView, startSweep, timeAt, zoneAt])

  // ── Hover: cursor + hover line ────────────────────────────────────────────
  const onMouseMove = useCallback((e) => {
    const root = rootRef.current
    if (!root) return
    const { rect, d, v } = geometry()
    if (!rect) return
    const zone = zoneAt(e.clientY)
    let cursor = 'crosshair'
    if (dragRef.current) {
      const kind = dragRef.current.kind
      cursor = kind === 'pan' ? 'grabbing' : kind === 'seek' ? 'crosshair' : 'ew-resize'
    } else if (zone === 'overview') {
      const t = d > 0 ? ((e.clientX - rect.left) / rect.width) * d : 0
      cursor = v.zoomed && t >= v.start && t <= v.end ? 'grab' : 'pointer'
    } else if (zone === 'lane') {
      cursor = sampleAt(e.clientX) ? 'pointer' : 'crosshair'
    } else if (zone === 'body') {
      cursor = handleAt(e.clientX, e.clientY) ? 'ew-resize' : 'crosshair'
    }
    if (root.style.cursor !== cursor) root.style.cursor = cursor
    hoverRef.current = zone === 'overview' ? null : { x: e.clientX - rect.left }
    if (!playing) drawOverlay(currentTimeRef.current)
  }, [drawOverlay, geometry, handleAt, playing, sampleAt, zoneAt])

  const onMouseLeave = useCallback(() => {
    hoverRef.current = null
    if (!playing) drawOverlay(currentTimeRef.current)
  }, [drawOverlay, playing])

  const onDoubleClick = useCallback((e) => {
    // Only the overview resets the zoom. Double-clicking the waveform while
    // placing points is routine, and throwing the zoom away each time is hostile.
    if (zoneAt(e.clientY) === 'overview') setView(null)
  }, [setView, zoneAt])

  // ── Wheel: zoom at the cursor, Shift or a horizontal wheel pans ───────────
  // Registered non-passive so it can preventDefault; reads only refs.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    function onWheel(e) {
      e.preventDefault()
      const { rect, d, v } = geometry()
      if (!rect || d <= 0 || rect.width <= 0) return
      if (e.shiftKey && e.deltaY !== 0) {
        setView(panView(viewRef.current, d, (e.deltaY / rect.width) * v.dur * 3))
        return
      }
      if (e.deltaX !== 0) {
        setView(panView(viewRef.current, d, (e.deltaX / rect.width) * v.dur * 1.5))
        return
      }
      if (e.deltaY !== 0) {
        // A wheel notch is one 1.25x step, as before; a trackpad's small deltas scale smoothly.
        const notch = Math.abs(e.deltaY) >= 50
        const factor = notch ? (e.deltaY > 0 ? 1.25 : 1 / 1.25) : Math.exp(e.deltaY * 0.0045)
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        setView(zoomView(viewRef.current, d, factor, v.start + ratio * v.dur))
      }
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [geometry, setView])

  // ── Follow the playhead while playing (pages; never while the user is dragging) ──
  useEffect(() => {
    if (!playing || dragRef.current || !viewRef.current) return
    const next = followView(viewRef.current, duration, currentTime)
    if (next !== viewRef.current) setView(next)
  }, [playing, currentTime, duration, setView])

  useImperativeHandle(ref, () => ({
    fit: () => setView(null),
    zoomToSelection: () => {
      const { inPoint: a, outPoint: b } = live.current
      if (a === null || b === null || !(Math.abs(b - a) > 0)) return false
      // null from viewForRange means the selection spans the whole source: fit.
      setView(viewForRange(Math.min(a, b), Math.max(a, b), durationRef.current || 0))
      return true
    },
    zoomBy: (factor) => {
      const d = durationRef.current || 0
      setView(zoomView(viewRef.current, d, factor, currentTimeRef.current))
    },
    focus: () => rootRef.current?.focus?.({ preventScroll: true }),
  }), [setView])

  const zone = (top, height, hint, mods, testId) => (
    <div
      className={styles.zone}
      style={{ top, height }}
      data-hint={hint}
      data-hint-mods={mods}
      data-testid={testId}
      aria-hidden="true"
    />
  )

  return (
    <div
      ref={rootRef}
      className={styles.wave}
      tabIndex={0}
      role="group"
      aria-label="Waveform"
      data-testid="picker-waveform"
      data-zoomed={resolved.zoomed ? 'true' : 'false'}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onDoubleClick={onDoubleClick}
      onAuxClick={(e) => { if (e.button === 1) e.preventDefault() }}
    >
      <canvas ref={canvasRef} className={styles.waveCanvas} data-testid="picker-waveform-canvas" />
      <canvas ref={overlayRef} className={styles.waveCanvas} aria-hidden="true" />
      {zone(0, OVERVIEW_H, HINT_OVERVIEW, HINT_OVERVIEW_MODS, 'picker-overview')}
      {zone(OVERVIEW_H, RULER_H, HINT_RULER, HINT_WAVE_MODS, 'picker-ruler')}
      {laneOn ? zone(OVERVIEW_H + RULER_H, LANE_H, HINT_LANE, undefined, 'picker-lane') : null}
      <div
        className={styles.zone}
        style={{ top: bodyTop, bottom: 0 }}
        data-hint={HINT_WAVE}
        data-hint-mods={HINT_WAVE_MODS}
        data-testid="picker-wave-body"
        aria-hidden="true"
      />
    </div>
  )
})

export default PickerWaveform

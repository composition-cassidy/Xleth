import React, { useCallback, useEffect, useRef } from 'react'
import { formatValue, hintAttrs } from '../../ui-kit'
import { uiCanvasFont } from '../../styles/typography.js'
import { readMixerCanvasTheme, syncCanvasSize, withAlpha } from '../mixer/mixerCanvasTheme.js'
import { readBandColor } from './bandPalette.js'
import { startVisibleLoop } from './visibleLoop.js'
import {
  BANDS, DB_MAX, bandAtX, bandColumns, bandIds, dbToY, hasLevel,
  targetParamFromVisual, targetVisualDb, yToDb,
} from './smartBalanceGeometry.js'

// The Smart Balance display: four band columns on a log-frequency axis against
// level in dB, drawn from the engine's own numbers.
//
//   live RMS      getEffectMeter slots 0..3, the stereo-linked RMS of each band
//   gain          getEffectMeter slots 4..7, the correction being applied now
//   overall RMS   smartBalanceGetDebug().overallRms, the broadband level that
//                 Relative targets are measured from
//   transient     smartBalanceGetDebug().transient, a band's fast envelope more
//                 than twice its slow one
//   target, floor the band's own parameters, from `params`
//
// The target line is the control: drag it, sideways picks the band, up and down is
// the level. It previews at most once per frame (`onPreview`) and commits once on
// release (`onCommit`); Escape puts it back. The keyboard and typed alternative is
// the Target / Offset knob in the Band section.
//
// The engine poll is the editor's, unchanged: about 30 Hz, both calls, run while the
// canvas is on screen. Colours come from the canvas's own computed style at draw
// time; nothing reads a token at module scope.

const POLL_MS = 33
const PAD_L = 30
const HEADER_H = 30
const PAD_B = 4
const GRID_DBS = [6, 0, -12, -24, -36, -48, -60]
const HIT_PX = 12
const FONT = '500 10px'
const FONT_READOUT = '600 11px'

const dbText = (v, decimals = 1, signed = true) => formatValue(v, 'dB', { unitless: true, decimals, signed })

export default function SmartBalanceCanvas({
  target, params, view = 'levels', selectedBand = 0, onSelectBand, onPreview, onCommit,
}) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const viewRef = useRef(view)
  const selectedRef = useRef(selectedBand)
  const targetRef = useRef(target)
  paramsRef.current = params
  viewRef.current = view
  selectedRef.current = selectedBand
  targetRef.current = target

  // Mutated by the poll and read by the draw loop; no React render per frame.
  const vizRef = useRef({
    rmsDb: [-100, -100, -100, -100],
    gainDb: [0, 0, 0, 0],
    dryRms: [-100, -100, -100, -100],
    dynDelta: [0, 0, 0, 0],
    pulse: [0, 0, 0, 0],
    overallRms: -100,
  })
  const dragRef = useRef(null) // { band, id, startValue, lastValue }
  const geometryRef = useRef({ w: 0, h: 0, plotTop: 0, plotH: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    let lastPoll = 0
    let lastFrame = performance.now()
    let polling = false

    async function poll() {
      const t = targetRef.current
      const audio = window.xleth?.audio
      if (!t || !audio) return
      const vd = vizRef.current
      try {
        const raw = await audio.getEffectMeter(t.trackId, t.nodeId)
        const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (Array.isArray(meters)) {
          for (let b = 0; b < 4; b += 1) {
            vd.rmsDb[b] = meters[b] ?? -100
            vd.gainDb[b] = meters[b + 4] ?? 0
          }
        }
        // The debug atomics are cheap; they feed the overall-RMS anchor and the
        // transient pulses in the normal view too.
        try {
          const dbg = await audio.smartBalanceGetDebug(t.trackId, t.nodeId)
          if (dbg) {
            for (let b = 0; b < 4; b += 1) {
              vd.dryRms[b] = dbg.dryRms?.[b] ?? -100
              vd.dynDelta[b] = dbg.dynDelta?.[b] ?? 0
              if (dbg.transient?.[b]) vd.pulse[b] = 1
            }
            vd.overallRms = dbg.overallRms ?? -100
          }
        } catch { /* the debug call is optional */ }
      } catch { /* the meter call can fail while the engine is busy */ }
    }

    function draw(now) {
      if (now - lastPoll >= POLL_MS && !polling) {
        lastPoll = now
        polling = true
        poll().finally(() => { polling = false })
      }
      const dt = Math.max(0, Math.min(0.1, (now - lastFrame) / 1000))
      lastFrame = now
      const vd = vizRef.current
      const decay = Math.exp(-dt / 0.18)
      for (let b = 0; b < 4; b += 1) vd.pulse[b] *= decay

      const { cssW: w, cssH: h, dpr } = syncCanvasSize(canvas, 560, 200)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const th = readMixerCanvasTheme(canvas)

      const plotLeft = PAD_L
      const plotW = Math.max(10, w - plotLeft)
      const plotTop = HEADER_H
      const plotH = Math.max(10, h - HEADER_H - PAD_B)
      geometryRef.current = { w, h, plotLeft, plotW, plotTop, plotH }
      const cols = bandColumns(plotW).map((c) => ({ x1: c.x1 + plotLeft, x2: c.x2 + plotLeft }))
      const colors = BANDS.map((_, i) => readBandColor(canvas, i, th.accent, 4))
      const p = paramsRef.current
      const mode = Math.round(p.mode)
      const isRelative = mode === 0
      const selected = selectedRef.current
      const details = viewRef.current === 'details'
      const yOf = (db) => dbToY(db, plotTop, plotH)
      const signal = vd.rmsDb.some(hasLevel)
      const dragging = dragRef.current

      // Ground and the band columns; the selected band's is a little stronger.
      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, w, h)
      for (let i = 0; i < 4; i += 1) {
        ctx.fillStyle = withAlpha(colors[i], i === selected ? 0.12 : 0.05)
        ctx.fillRect(cols[i].x1, 0, cols[i].x2 - cols[i].x1, h)
        if (vd.pulse[i] > 0.01) {
          ctx.fillStyle = withAlpha(colors[i], Math.min(0.18, vd.pulse[i] * 0.18))
          ctx.fillRect(cols[i].x1, plotTop, cols[i].x2 - cols[i].x1, plotH)
        }
        if (i < 3) {
          ctx.fillStyle = th.border
          ctx.fillRect(Math.round(cols[i].x2) - 1, 0, 1, h)
        }
      }

      // Level grid and its labels.
      ctx.font = uiCanvasFont(FONT)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (const db of GRID_DBS) {
        const y = Math.round(yOf(db)) + 0.5
        ctx.strokeStyle = db === 0 ? th.borderStrong : th.border
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(plotLeft, y)
        ctx.lineTo(w, y)
        ctx.stroke()
        ctx.fillStyle = db === 0 ? th.textMuted : th.textSubtle
        ctx.fillText(dbText(db, 0, db > 0), plotLeft - 4, y)
      }

      // Relative mode measures every target from the overall level.
      if (isRelative && hasLevel(vd.overallRms)) {
        const y = Math.round(yOf(vd.overallRms)) + 0.5
        ctx.strokeStyle = withAlpha(th.text, 0.5)
        ctx.setLineDash([1, 3])
        ctx.beginPath()
        ctx.moveTo(plotLeft, y)
        ctx.lineTo(w, y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = th.textMuted
        ctx.textAlign = 'right'
        ctx.textBaseline = 'bottom'
        ctx.fillText(`Overall ${formatValue(vd.overallRms, 'dB')}`, w - 4, y - 2)
      }

      // Gate floors.
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      for (let i = 0; i < 4; i += 1) {
        const floor = p[bandIds(i).floor]
        if (!hasLevel(floor)) continue
        const y = Math.round(yOf(floor)) + 0.5
        ctx.strokeStyle = withAlpha(colors[i], 0.6)
        ctx.beginPath()
        ctx.moveTo(cols[i].x1 + 2, y)
        ctx.lineTo(cols[i].x2 - 2, y)
        ctx.stroke()
      }
      ctx.setLineDash([])

      // Live RMS: a flat fill from the bottom with a sharp top edge, and the
      // estimated landing (RMS plus the gain being applied) as a short tick.
      for (let i = 0; i < 4; i += 1) {
        const rms = vd.rmsDb[i]
        if (!hasLevel(rms)) continue
        const y = yOf(Math.min(rms, DB_MAX))
        ctx.fillStyle = withAlpha(colors[i], 0.34)
        ctx.fillRect(cols[i].x1 + 2, y, cols[i].x2 - cols[i].x1 - 4, plotTop + plotH - y)
        ctx.strokeStyle = colors[i]
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(cols[i].x1 + 2, Math.round(y) + 0.5)
        ctx.lineTo(cols[i].x2 - 2, Math.round(y) + 0.5)
        ctx.stroke()

        const gain = vd.gainDb[i]
        const landing = rms + gain
        if (Math.abs(gain) > 0.05 && hasLevel(landing) && landing < DB_MAX + 1) {
          const cx = (cols[i].x1 + cols[i].x2) / 2
          const ly = Math.round(yOf(landing)) + 0.5
          ctx.strokeStyle = withAlpha(th.text, 0.4)
          ctx.setLineDash([1, 2])
          ctx.beginPath()
          ctx.moveTo(cx, y)
          ctx.lineTo(cx, ly)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.strokeStyle = th.text
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(cx - 10, ly)
          ctx.lineTo(cx + 10, ly)
          ctx.stroke()
        }
      }

      // Target lines: the draggable control.
      for (let i = 0; i < 4; i += 1) {
        const visual = targetVisualDb(mode, vd.overallRms, p[bandIds(i).target])
        if (visual === null) continue
        const y = Math.max(plotTop, Math.min(plotTop + plotH, yOf(visual)))
        const isDrag = dragging?.band === i
        ctx.strokeStyle = isDrag ? th.text : colors[i]
        ctx.setLineDash(isDrag ? [] : [5, 3])
        ctx.lineWidth = isDrag ? 2 : 1.5
        ctx.beginPath()
        ctx.moveTo(cols[i].x1 + 2, Math.round(y) + 0.5)
        ctx.lineTo(cols[i].x2 - 2, Math.round(y) + 0.5)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = isDrag ? th.text : colors[i]
        ctx.fillRect(cols[i].x1 + 1, Math.round(y) - 2, 4, 5)
        ctx.fillRect(cols[i].x2 - 5, Math.round(y) - 2, 4, 5)
      }

      // Band names across the top.
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (let i = 0; i < 4; i += 1) {
        const cx = (cols[i].x1 + cols[i].x2) / 2
        ctx.font = uiCanvasFont(FONT)
        ctx.fillStyle = colors[i]
        ctx.fillText(BANDS[i].label, cx, 3)
        ctx.fillStyle = th.textSubtle
        ctx.fillText(BANDS[i].range, cx, 16)
        if (i === selected) {
          ctx.fillStyle = colors[i]
          ctx.fillRect(cols[i].x1, 0, cols[i].x2 - cols[i].x1, 2)
        }
      }

      // The correction each band is applying now.
      ctx.font = uiCanvasFont(FONT_READOUT)
      ctx.textBaseline = 'middle'
      for (let i = 0; i < 4; i += 1) {
        const cx = (cols[i].x1 + cols[i].x2) / 2
        const gain = vd.gainDb[i]
        const yPill = plotTop + plotH - 14
        ctx.fillStyle = withAlpha(th.well, 0.85)
        ctx.fillRect(cx - 26, yPill - 9, 52, 18)
        ctx.strokeStyle = th.border
        ctx.lineWidth = 1
        ctx.strokeRect(cx - 25.5, yPill - 8.5, 51, 17)
        ctx.fillStyle = Math.abs(gain) < 0.1 ? th.textMuted : (gain > 0 ? colors[i] : th.text)
        ctx.fillText(dbText(gain, 1, true), cx, yPill)
      }

      // Details: the dry level and the dynamics restore per band.
      if (details) {
        ctx.font = uiCanvasFont(FONT)
        ctx.fillStyle = th.textMuted
        ctx.textBaseline = 'bottom'
        for (let i = 0; i < 4; i += 1) {
          const cx = (cols[i].x1 + cols[i].x2) / 2
          ctx.fillText(`Dry ${formatValue(vd.dryRms[i], 'dB')}`, cx, plotTop + plotH - 44)
          ctx.fillText(`Restore ${formatValue(vd.dynDelta[i], 'dB', { signed: true })}`, cx, plotTop + plotH - 32)
        }
      }

      if (!signal) {
        ctx.font = uiCanvasFont(FONT)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = th.textMuted
        ctx.fillText('Play to see band levels', plotLeft + plotW / 2, plotTop + plotH * 0.38)
      }
    }

    return startVisibleLoop(canvas, draw)
  }, [])

  const rectOf = () => canvasRef.current?.getBoundingClientRect()

  // Which band's target line is under the pointer, if any.
  const hitTarget = useCallback((mx, my) => {
    const g = geometryRef.current
    if (!g.w) return -1
    const band = bandAtX(mx - g.plotLeft, g.plotW)
    if (band < 0) return -1
    const p = paramsRef.current
    const visual = targetVisualDb(p.mode, vizRef.current.overallRms, p[bandIds(band).target])
    if (visual === null) return -1
    const y = Math.max(g.plotTop, Math.min(g.plotTop + g.plotH, dbToY(visual, g.plotTop, g.plotH)))
    return Math.abs(my - y) <= HIT_PX ? band : -1
  }, [])

  const onPointerDown = (e) => {
    const rect = rectOf()
    const g = geometryRef.current
    if (!rect || !g.w || e.button !== 0) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const clicked = bandAtX(mx - g.plotLeft, g.plotW)
    if (clicked >= 0) onSelectBand?.(clicked)
    const band = hitTarget(mx, my)
    if (band < 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
    const id = bandIds(band).target
    const startValue = paramsRef.current[id]
    dragRef.current = { band, id, startValue, lastValue: startValue }
    onSelectBand?.(band)
    canvasRef.current.style.cursor = 'ns-resize'
    canvasRef.current.focus({ preventScroll: true }) // so Escape reaches the drag
  }

  const onPointerMove = (e) => {
    const rect = rectOf()
    const g = geometryRef.current
    if (!rect || !g.w) return
    const my = e.clientY - rect.top
    const drag = dragRef.current
    if (!drag) {
      canvasRef.current.style.cursor = hitTarget(e.clientX - rect.left, my) >= 0 ? 'ns-resize' : ''
      return
    }
    const next = targetParamFromVisual(paramsRef.current.mode, vizRef.current.overallRms, yToDb(my, g.plotTop, g.plotH))
    if (next === null) return
    drag.lastValue = next
    onPreview?.(drag.id, next)
  }

  const finish = (commitValue) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = ''
    onCommit?.(drag.id, commitValue(drag))
  }

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Smart Balance: live level, target, gate floor and correction for each of the four bands. Drag a target line to set it."
      {...hintAttrs({ hint: 'Drag a band’s target line to set its target', hintMods: 'Drag: move the line · Esc: cancel' })}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish((d) => d.lastValue)}
      onPointerCancel={() => finish((d) => d.startValue)}
      onKeyDown={(e) => { if (e.key === 'Escape') finish((d) => d.startValue) }}
      style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
    />
  )
}

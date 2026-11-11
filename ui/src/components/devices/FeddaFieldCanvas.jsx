import React, { useEffect, useRef } from 'react'
import { formatValue } from '../../ui-kit'
import { uiCanvasFont } from '../../styles/typography.js'
import { readMixerCanvasTheme, syncCanvasSize, withAlpha } from '../mixer/mixerCanvasTheme.js'
import { startVisibleLoop } from './visibleLoop.js'
import { FEDDA_METER, fieldEllipse, targetCorrelationForWidth, targetEllipse } from './feddaGeometry.js'

// The Fedda display, drawn from the engine's own meters (XlethFeddaEffect meter slots, about 30 Hz):
//
//   stereo field   the shape a goniometer's dot cloud fills, from the measured second moments of the
//                  processed output: mid (up) and side (across) RMS and their correlation (tilt).
//                  Mono is a vertical line, decorrelated stereo a circle, past the speakers a
//                  horizontal ellipse. The dashed outline is the shape the current width aims for.
//   correlation    L/R correlation of the processed output, -1 .. +1, with the target for the
//                  current width as a hollow marker. 100 % width aims at 0.
//
// "Processed output" is what a render contains: after loudness match, before the monitor switches.
// With no signal nothing measured is drawn (the target outline stays: it comes from the width).
// Colours come from the canvas's computed style at draw time.

const POLL_MS = 33
const BAR_H = 44
const SILENT_DB = -90
// While a chain processes, the engine's 300 ms averages move every block. Unchanged for this long
// means the transport stopped (chains do not run then) or the input fell silent: not live.
const STALE_MS = 400
const FONT = '500 10px'
const FONT_READOUT = '500 11px'

const signed2 = (v) => formatValue(v, 'dB', { unitless: true, decimals: 2, signed: true })

export default function FeddaFieldCanvas({ target, params }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const targetRef = useRef(target)
  paramsRef.current = params
  targetRef.current = target

  // Mutated by the poll, read by the draw loop: no React render per frame.
  const vizRef = useRef({ meters: null, changedAt: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    let lastPoll = 0
    let polling = false

    async function poll() {
      const t = targetRef.current
      const audio = window.xleth?.audio
      if (!t || typeof audio?.getEffectMeter !== 'function') return
      try {
        const raw = await audio.getEffectMeter(t.trackId, t.nodeId)
        const m = typeof raw === 'string' ? JSON.parse(raw) : raw
        // An engine slot array that was never written is all zeros (0 dB mid and side, correlation
        // 0): not a measurement. Current engines publish idle values instead; this guards older ones.
        const written = Array.isArray(m) && m.length >= 8 && m.some((v) => v !== 0)
        const viz = vizRef.current
        const prev = viz.meters
        if (written && (!prev || prev[0] !== m[0] || prev[1] !== m[1] || prev[2] !== m[2])) viz.changedAt = performance.now()
        viz.meters = written ? m : null
      } catch { /* the meter call can fail while the engine is busy */ }
    }

    function draw(now) {
      if (now - lastPoll >= POLL_MS && !polling) {
        lastPoll = now
        polling = true
        poll().finally(() => { polling = false })
      }
      const { cssW: w, cssH: h, dpr } = syncCanvasSize(canvas, 236, 200)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const th = readMixerCanvasTheme(canvas)
      const p = paramsRef.current
      const m = vizRef.current.meters
      const midDb = m ? m[FEDDA_METER.midDb] : -120
      const sideDb = m ? m[FEDDA_METER.sideDb] : -120
      const fresh = now - vizRef.current.changedAt < STALE_MS
      const live = Boolean(m) && fresh && Math.max(midDb, sideDb) > SILENT_DB
      const targetRho = m ? m[FEDDA_METER.targetCorrelation] : targetCorrelationForWidth(p.width)

      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, w, h)

      // ── Stereo field ──
      const fieldH = h - BAR_H
      const cx = w / 2
      const cy = fieldH / 2 + 6
      const R = Math.max(10, Math.min(w / 2 - 22, fieldH / 2 - 14))

      ctx.lineWidth = 1
      ctx.strokeStyle = th.border
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.stroke()
      // M (vertical), S (horizontal), L and R (diagonals).
      ctx.beginPath()
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R)
      ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy)
      const d = R * Math.SQRT1_2
      ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d)
      ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d)
      ctx.stroke()

      ctx.font = uiCanvasFont(FONT)
      ctx.fillStyle = th.textSubtle
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText('M', cx, cy - R - 2)
      ctx.textAlign = 'right'
      ctx.fillText('L', cx - d - 3, cy - d - 1)
      ctx.textAlign = 'left'
      ctx.fillText('R', cx + d + 3, cy - d - 1)
      ctx.textBaseline = 'middle'
      ctx.fillText('S', cx + R + 4, cy)

      // Target: the upright shape the current width aims for.
      const tgt = targetEllipse(targetRho, R)
      ctx.strokeStyle = th.textMuted
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.ellipse(cx, cy, Math.max(0.5, tgt.rx), Math.max(0.5, tgt.ry), 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])

      if (live) {
        const e = fieldEllipse(midDb, sideDb, m[FEDDA_METER.msCorrelation], R)
        ctx.fillStyle = withAlpha(th.accent, 0.18)
        ctx.strokeStyle = th.accent
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.ellipse(cx, cy, Math.max(0.75, e.rx), Math.max(0.75, e.ry), e.rotation, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.lineWidth = 1

        ctx.font = uiCanvasFont(FONT_READOUT)
        ctx.fillStyle = th.textMuted
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(`S/M ${formatValue(sideDb - midDb, 'dB', { signed: true })}`, 6, 6)
        const guard = m[FEDDA_METER.guardDepth]
        if (p.guard > 0 && guard > 0.02) {
          ctx.textAlign = 'right'
          ctx.fillText(`Guard ${formatValue(guard * 100, '%')}`, w - 6, 6)
        }
      } else {
        ctx.font = uiCanvasFont(FONT_READOUT)
        ctx.fillStyle = th.textSubtle
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText('No signal', 6, 6)
      }

      // Monitors: printed in the inverted chip so a left-on switch cannot be missed. The switch
      // state is the device's own (the engine slot would go stale while the transport is stopped);
      // only the level-match gain is measured.
      const compareOn = Number(p.compare) >= 0.5
      const monoOn = Number(p.mono_check) >= 0.5
      if (compareOn || monoOn) {
        const gain = m && fresh ? `, ${formatValue(m[FEDDA_METER.dryMatchDb], 'dB', { signed: true })}` : ''
        const text = compareOn ? `Dry${gain}, not rendered` : 'Mono check, not rendered'
        ctx.font = uiCanvasFont(FONT_READOUT)
        const tw = ctx.measureText(text).width + 12
        ctx.fillStyle = th.text
        ctx.fillRect(Math.round(cx - tw / 2), fieldH - 22, Math.round(tw), 18)
        ctx.fillStyle = th.well
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, cx, fieldH - 13)
      }

      // ── Correlation bar ──
      const x0 = 14
      const x1 = w - 14
      const by = fieldH + 14
      const bh = 8
      const xOf = (rho) => x0 + ((Math.max(-1, Math.min(1, rho)) + 1) / 2) * (x1 - x0)
      ctx.fillStyle = th.surface
      ctx.fillRect(x0, by, x1 - x0, bh)
      ctx.strokeStyle = th.border
      ctx.strokeRect(x0 + 0.5, by + 0.5, x1 - x0 - 1, bh - 1)
      ctx.fillStyle = th.borderStrong
      ctx.fillRect(Math.round(xOf(0)), by - 2, 1, bh + 4)

      if (live) {
        const rho = m[FEDDA_METER.correlation]
        const a = xOf(0)
        const b = xOf(rho)
        ctx.fillStyle = th.accent
        ctx.fillRect(Math.min(a, b), by + 1, Math.max(1.5, Math.abs(b - a)), bh - 2)
      }
      // Target: a hollow marker above the bar.
      const tx = xOf(targetRho)
      ctx.strokeStyle = th.text
      ctx.beginPath()
      ctx.moveTo(tx, by - 1)
      ctx.lineTo(tx - 4, by - 7)
      ctx.lineTo(tx + 4, by - 7)
      ctx.closePath()
      ctx.stroke()

      ctx.font = uiCanvasFont(FONT)
      ctx.fillStyle = th.textSubtle
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText('−1', x0, by + bh + 3)
      ctx.textAlign = 'center'
      ctx.fillText('0', xOf(0), by + bh + 3)
      ctx.textAlign = 'right'
      ctx.fillText('+1', x1, by + bh + 3)

      ctx.font = uiCanvasFont(FONT_READOUT)
      ctx.fillStyle = th.textMuted
      ctx.textBaseline = 'bottom'
      ctx.textAlign = 'left'
      ctx.fillText(live ? `Correlation ${signed2(m[FEDDA_METER.correlation])}` : 'Correlation', x0, by - 3)
      ctx.textAlign = 'right'
      ctx.fillText(`target ${signed2(targetRho)}`, x1, by - 3)
    }

    return startVisibleLoop(canvas, draw)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fedda-field-canvas"
      role="img"
      aria-label="Stereo field and L/R correlation of the processed output, with the target for the current width"
    />
  )
}

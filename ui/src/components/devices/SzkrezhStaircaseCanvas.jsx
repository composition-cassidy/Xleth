import React, { useEffect, useRef } from 'react'
import { formatValue } from '../../ui-kit'
import { uiCanvasFont } from '../../styles/typography.js'
import { readMixerCanvasTheme, syncCanvasSize, withAlpha } from '../mixer/mixerCanvasTheme.js'
import { pitchLabel } from '../pianoRoll/pianoRollGeometry.js'
import { startVisibleLoop } from './visibleLoop.js'
import { SCALES, KEYS, divisionLabel, divisionMs, intervalLabel, staircase, clampInt } from './szkrezhModel.js'

// The Szkrezh display. The staircase is what Recycle does: every pass through the loop shifts the
// echo by the pitch again, so repeat k sits k x Pitch above the source and fades by the recycle
// amount each pass (the bar's height is its level). With a MIDI pitch source the step is the
// shift the engine latched for the newest splice (XlethSzkrezhEffect meter slots 3 and 4), so the
// stairs move as the notes change. The bottom bar is the splice clock: how far the left channel
// is through its current splice, which the transport positions exactly.
//
// Meters (about 30 Hz): 0/1 wet peak L/R, 2 gate/duck gain, 3/4 latched cents L/R, 5 splice
// phase, 6 last host note, 7 last Keys note. They only move while the transport plays (chains do
// not run when stopped), so an unchanged phase for STALE_MS means "not live".

const POLL_MS = 33
const STALE_MS = 400
const FONT = '500 10px'
const FONT_READOUT = '500 11px'
const PHASE_H = 30

const st2 = (cents) => `${formatValue(cents / 100, 'dB', { unitless: true, decimals: 2, signed: true })} st`

export default function SzkrezhStaircaseCanvas({ target, params, bpm }) {
  const canvasRef = useRef(null)
  const paramsRef = useRef(params)
  const targetRef = useRef(target)
  const bpmRef = useRef(bpm)
  paramsRef.current = params
  targetRef.current = target
  bpmRef.current = bpm

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
        const viz = vizRef.current
        if (!Array.isArray(m) || m.length < 8) { viz.meters = null; return }
        const prev = viz.meters
        if (!prev || prev[5] !== m[5] || prev[0] !== m[0]) viz.changedAt = performance.now()
        viz.meters = m
      } catch { /* the meter call can fail while the engine is busy */ }
    }

    function draw(now) {
      if (now - lastPoll >= POLL_MS && !polling) {
        lastPoll = now
        polling = true
        poll().finally(() => { polling = false })
      }
      const { cssW: w, cssH: h, dpr } = syncCanvasSize(canvas, 220, 200)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const th = readMixerCanvasTheme(canvas)
      const p = paramsRef.current
      const m = vizRef.current.meters
      const live = Boolean(m) && now - vizRef.current.changedAt < STALE_MS
      const source = clampInt(p.pitch_src, 0, 2)

      // Shift per pass: the latched one while live, otherwise what the controls say.
      const offset = Number(p.pitch_offset) || 0
      let centsL
      let centsR
      if (live) { centsL = m[3]; centsR = m[4] }
      else if (source === 0) { centsL = Number(p.pitch) - offset / 2; centsR = Number(p.pitch) + offset / 2 }
      else { centsL = -offset / 2; centsR = offset / 2 }
      const centre = (centsL + centsR) / 200

      ctx.fillStyle = th.well
      ctx.fillRect(0, 0, w, h)

      // ── Staircase ──
      const top = 22
      const bottom = h - PHASE_H - 8
      const left = 30
      const right = w - 8
      const steps = staircase(centre, p.recycle, 6)
      const lo = Math.min(0, ...steps.map((s) => s.semitones))
      const hi = Math.max(0, ...steps.map((s) => s.semitones))
      const span = Math.max(12, hi - lo)
      const yOf = (stv) => bottom - ((stv - lo) / span) * (bottom - top)
      const cols = 7
      const colW = (right - left) / cols
      const xOf = (k) => left + k * colW

      // Octave lines.
      ctx.font = uiCanvasFont(FONT)
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'right'
      ctx.lineWidth = 1
      const firstOct = Math.ceil(lo / 12) * 12
      for (let o = firstOct; o <= hi + 1e-9; o += 12) {
        const y = Math.round(yOf(o)) + 0.5
        ctx.strokeStyle = o === 0 ? th.borderStrong : th.border
        ctx.beginPath()
        ctx.moveTo(left, y)
        ctx.lineTo(right, y)
        ctx.stroke()
        ctx.fillStyle = th.textSubtle
        ctx.fillText(o === 0 ? '0' : `${o > 0 ? '+' : '−'}${Math.abs(o)}`, left - 4, y)
      }

      // Source (k = 0) and the repeats.
      const barH = 6
      ctx.fillStyle = th.textMuted
      ctx.fillRect(xOf(0) + 3, yOf(0) - barH / 2, colW - 6, barH)
      for (const s of steps) {
        const y = yOf(s.semitones)
        ctx.fillStyle = withAlpha(th.accent, 0.25 + 0.75 * s.level)
        const hh = Math.max(2, barH * (0.4 + 0.6 * s.level))
        ctx.fillRect(xOf(s.k) + 3, y - hh / 2, colW - 6, hh)
      }
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = th.textSubtle
      ctx.fillText('in', xOf(0) + colW / 2, bottom + 2)
      for (const s of steps) ctx.fillText(String(s.k), xOf(s.k) + colW / 2, bottom + 2)

      // ── Readouts ──
      ctx.font = uiCanvasFont(FONT_READOUT)
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillStyle = th.text
      const same = Math.abs(centsL - centsR) < 0.5
      ctx.fillText(same ? st2(centsL) : `L ${st2(centsL)}  R ${st2(centsR)}`, 6, 5)
      ctx.textAlign = 'right'
      ctx.fillStyle = th.textMuted
      let tag = ''
      if (source === 1) {
        const note = live && m[6] >= 0 ? `${pitchLabel(m[6])}, ` : ''
        tag = `${note}${KEYS[clampInt(p.key, 0, 11)]} ${SCALES[clampInt(p.scale, 0, 8)].toLowerCase()} ${intervalLabel(p.harmony, p.scale)}`
      } else if (source === 2) {
        tag = live && m[7] >= 0 ? `Keys ${pitchLabel(m[7])}` : 'Keys: waiting for a note'
      }
      if (Number(p.freeze) >= 0.5) tag = 'Frozen'
      if (tag) ctx.fillText(tag, w - 6, 5)

      // ── Splice clock ──
      const py = h - PHASE_H + 6
      const px0 = 8
      const px1 = w - 8
      ctx.fillStyle = th.surface
      ctx.fillRect(px0, py, px1 - px0, 6)
      ctx.strokeStyle = th.border
      ctx.strokeRect(px0 + 0.5, py + 0.5, px1 - px0 - 1, 5)
      if (live) {
        const ph = Math.max(0, Math.min(1, m[5]))
        const reverse = Number(p.reverse) >= 0.5
        ctx.fillStyle = th.accent
        // Reverse reads backwards: the bar empties toward the start.
        if (reverse) ctx.fillRect(px0 + (px1 - px0) * ph, py + 1, (px1 - px0) * (1 - ph), 4)
        else ctx.fillRect(px0, py + 1, (px1 - px0) * ph, 4)
      }
      ctx.font = uiCanvasFont(FONT)
      ctx.fillStyle = th.textSubtle
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const synced = Number(p.sync) >= 0.5
      const spliceText = synced
        ? `${divisionLabel(p.splice_div)} ≈ ${formatValue(divisionMs(p.splice_div, bpmRef.current), 'ms')}`
        : formatValue(Number(p.splice), 'ms')
      ctx.fillText(`Splice ${spliceText}`, px0, py + 9)
      ctx.textAlign = 'right'
      ctx.fillText(Number(p.reverse) >= 0.5 ? 'Reverse' : 'Forward', px1, py + 9)
    }

    return startVisibleLoop(canvas, draw)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="szkrezh-staircase-canvas"
      role="img"
      aria-label="Recycle staircase: each repeat's pitch and level, the latched pitch, and the splice clock"
    />
  )
}

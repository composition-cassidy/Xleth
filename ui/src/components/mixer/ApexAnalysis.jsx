import React, { useEffect, useRef } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import useApexStore from '../../stores/apexStore.js'
import { MASTER_BAND } from '../../stores/apexStore.js'
import { useDynamicsVizSubscription } from '../../plugin-ui/runtime/useDynamicsVizSubscription.js'
import { VIZ_TYPE } from '../../constants/dynamicsViz.js'
import {
  clamp, freqToX, analysisDbToY, binToFreq,
  ANALYSIS_FREQ_MIN, ANALYSIS_DB_MIN, ANALYSIS_DB_MAX,
} from './apexGeometry.js'

// APEX analysis display — canvas-drawn input spectrum with the LOW / MID / HIGH
// regions tinted per the current crossover split, plus a per-band gain-reduction
// indication driven by the ~30 Hz metering payload.
//
// Data path: the shared dynamics-viz pipeline. useDynamicsVizSubscription enables
// the engine ring, drains it at 30 Hz and hands us a decoded ApexBucket ring; we
// read only the latest bucket per frame (spectrum + bandGrDb). Split frequencies
// come from the live store params (not the bucket) so the tinted regions stay
// correct even while transport is stopped and no buckets are flowing.
//
// Canvas discipline: single <canvas>, no DOM overlays, no React state per frame.

const PAD_L = 30
const PAD_R = 12
const PAD_T = 12
const PAD_B = 16
const FREQ_LABELS = [[100, '100'], [1000, '1k'], [10000, '10k']]
const DB_LINES = [0, -24, -48, -72]

function readColors(el) {
  const get = (name, fb) => {
    const inherited = el && typeof getComputedStyle === 'function'
      ? getComputedStyle(el).getPropertyValue(name).trim()
      : ''
    return inherited || tokenValue(name) || fb
  }
  return {
    bg:      get('--theme-bg-inset', '#111318'),
    grid:    get('--xleth-flat-border', 'rgba(255,255,255,0.10)'),
    text:    get('--xleth-flat-text-muted', 'rgba(255,255,255,0.5)'),
    spectrum: get('--xleth-flat-text', 'rgba(255,255,255,0.75)'),
    accent:  get('--theme-accent', '#fe589a'),
    region:  get('--xleth-flat-text-muted', 'rgba(255,255,255,0.5)'),
  }
}

function withAlpha(color, alpha) {
  const v = String(color || '').trim()
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const rgb = v.match(/^rgba?\(([^)]+)\)/i)
  if (rgb) {
    const p = rgb[1].split(',').map(s => s.trim())
    return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${alpha})`
  }
  return v
}

export default function ApexAnalysis() {
  const trackId = useApexStore(s => s.target?.trackId ?? null)
  const nodeId = useApexStore(s => s.target?.nodeId ?? null)
  const sub = useDynamicsVizSubscription(trackId, nodeId, VIZ_TYPE.APEX)

  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const subRef = useRef(sub)
  subRef.current = sub

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false

    const draw = () => {
      if (cancelled) return
      const cssW = canvas.clientWidth || 0
      const cssH = canvas.clientHeight || 0
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const tw = Math.round(cssW * dpr), th = Math.round(cssH * dpr)
      if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx || cssW <= 0 || cssH <= 0) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const c = readColors(canvas)
      const plot = { x: PAD_L, y: PAD_T, w: Math.max(1, cssW - PAD_L - PAD_R), h: Math.max(1, cssH - PAD_T - PAD_B) }

      const state = useApexStore.getState()
      const params = state.params
      const selBand = state.selectedBand
      const bucket = subRef.current?.ringRef?.current?.last?.() || null

      const sampleRate = (bucket && bucket.sampleRate > 0) ? bucket.sampleRate : 44100
      const nyquist = sampleRate / 2
      const splitLo = clamp(Number(params.split_lo) || 200, 40, 1000)
      const splitHi = clamp(Number(params.split_hi) || 2000, 1000, 18000)

      // Background
      ctx.fillStyle = c.bg
      ctx.fillRect(0, 0, cssW, cssH)

      // Band region tints — LOW | MID | HIGH split by the crossover freqs. The
      // selected band's region gets a faint accent wash (color is earned).
      const xLo = freqToX(splitLo, plot, nyquist)
      const xHi = freqToX(splitHi, plot, nyquist)
      const regions = [
        { x0: plot.x, x1: xLo, band: 0 },
        { x0: xLo, x1: xHi, band: 1 },
        { x0: xHi, x1: plot.x + plot.w, band: 2 },
      ]
      for (const r of regions) {
        const selected = r.band === selBand
        ctx.fillStyle = selected ? withAlpha(c.accent, 0.10) : withAlpha(c.region, 0.035)
        ctx.fillRect(r.x0, plot.y, Math.max(0, r.x1 - r.x0), plot.h)
      }

      // Grid — dB lines + labels
      ctx.lineWidth = 1
      ctx.font = '9px system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      for (const db of DB_LINES) {
        const y = analysisDbToY(db, plot)
        ctx.strokeStyle = c.grid
        ctx.beginPath(); ctx.moveTo(plot.x, y + 0.5); ctx.lineTo(plot.x + plot.w, y + 0.5); ctx.stroke()
        ctx.fillStyle = c.text; ctx.textAlign = 'right'
        ctx.fillText(`${db}`, plot.x - 4, y)
      }
      // Freq gridlines + labels
      ctx.textBaseline = 'bottom'; ctx.textAlign = 'center'
      for (const [f, label] of FREQ_LABELS) {
        if (f >= nyquist) continue
        const x = freqToX(f, plot, nyquist)
        ctx.strokeStyle = c.grid
        ctx.beginPath(); ctx.moveTo(x + 0.5, plot.y); ctx.lineTo(x + 0.5, plot.y + plot.h); ctx.stroke()
        ctx.fillStyle = c.text
        ctx.fillText(label, x, plot.y + plot.h + 12)
      }

      // Crossover split lines
      ctx.strokeStyle = withAlpha(c.text, 0.55)
      ctx.setLineDash([2, 3])
      for (const x of [xLo, xHi]) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, plot.y); ctx.lineTo(x + 0.5, plot.y + plot.h); ctx.stroke()
      }
      ctx.setLineDash([])

      // Spectrum (input, post LOW CUT) as a filled area.
      if (bucket && bucket.spectrum && bucket.spectrum.length > 1) {
        const spec = bucket.spectrum
        const bins = spec.length
        ctx.beginPath()
        ctx.moveTo(plot.x, plot.y + plot.h)
        let started = false
        for (let i = 1; i < bins; i++) {
          const f = binToFreq(i, sampleRate)
          if (f < ANALYSIS_FREQ_MIN) continue
          if (f > nyquist) break
          const x = freqToX(f, plot, nyquist)
          const y = analysisDbToY(spec[i], plot)
          if (!started) { ctx.lineTo(x, plot.y + plot.h); started = true }
          ctx.lineTo(x, y)
        }
        ctx.lineTo(plot.x + plot.w, plot.y + plot.h)
        ctx.closePath()
        ctx.fillStyle = withAlpha(c.spectrum, 0.22)
        ctx.fill()
        ctx.strokeStyle = withAlpha(c.spectrum, 0.85)
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // Per-band gain-reduction indication — a top-anchored bar in each region
      // whose height + accent intensity scale with that band's GR (0..12 dB).
      const bandGr = bucket && Array.isArray(bucket.bandGrDb) ? bucket.bandGrDb : [0, 0, 0, 0]
      const GR_FULL = 12
      const barMaxH = plot.h * 0.5
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      for (const r of regions) {
        const gr = Math.max(0, bandGr[r.band] || 0)
        const frac = clamp(gr / GR_FULL, 0, 1)
        const w = Math.max(0, r.x1 - r.x0)
        if (frac > 0.001) {
          ctx.fillStyle = withAlpha(c.accent, 0.18 + 0.5 * frac)
          ctx.fillRect(r.x0, plot.y, w, barMaxH * frac)
        }
        if (gr >= 0.1 && w > 24) {
          ctx.fillStyle = withAlpha(c.accent, 0.95)
          ctx.font = '9px system-ui, sans-serif'
          ctx.fillText(`-${gr.toFixed(1)}`, r.x0 + w / 2, plot.y + 2)
        }
      }

      // MASTER GR — wideband, drawn as a thin accent strip along the very top.
      const masterGr = Math.max(0, bandGr[MASTER_BAND] || 0)
      if (masterGr > 0.05) {
        const frac = clamp(masterGr / GR_FULL, 0, 1)
        ctx.fillStyle = withAlpha(c.accent, 0.25 + 0.55 * frac)
        ctx.fillRect(plot.x, plot.y, plot.w, 3)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => { cancelled = true; cancelAnimationFrame(rafRef.current) }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="apex-analysis-canvas"
      style={{ display: 'block', width: '100%', height: '100%', background: 'var(--theme-bg-inset, #111318)' }}
    />
  )
}

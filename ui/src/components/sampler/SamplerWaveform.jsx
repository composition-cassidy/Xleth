import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import { drawEnvelope, downsamplePeaks3 } from '../../utils/waveformRenderer.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import { snapToZeroCrossing } from './zeroCrossing.js'

const HANDLE_HIT = 8

// ── View window ─────────────────────────────────────────────────────────────
// The editor used to map the WHOLE sample onto the canvas, permanently. At a
// typical 660px that is ~360 samples per pixel for a five-second sample, so a
// loop point — which is sample-accurate — could not be placed by dragging at
// all. Everything below is now expressed against a [start, len] window in
// sample units, and the peaks request follows it, so zooming in buys real
// resolution from the mipmap rather than just scaling a blurry picture.

// Never zoom past the point where one sample spans a quarter of the canvas;
// past that the envelope is just steps and the handles have nothing to sit on.
const MIN_SAMPLES_PER_PX = 1 / 4

// Height of the overview strip along the top: the whole file, with the current
// view window drawn on it. Without this, being zoomed in is disorienting —
// there is no other cue for where in the sample you are.
const OVERVIEW_H = 14

// -- Peaks retry budget ------------------------------------------------------
// Mipmap generation runs on a background thread, so a not-ready answer is
// normally worth re-asking. It is NOT worth re-asking forever: the engine
// returns the same not-ready shape for a slot that has no audio mapped at all,
// and an un-rebuilt addon predates the `mapped` flag that tells those apart.
// A ceiling means the worst case is a stale "unavailable" label, not a
// permanent 150ms RPC storm against a single-threaded worker.
const PEAKS_RETRY_FAST_MS = 150
const PEAKS_RETRY_SLOW_MS = 600
const PEAKS_RETRY_FAST_ATTEMPTS = 10   // ~1.5s of eager polling, then back off
const PEAKS_MAX_ATTEMPTS = 25          // ~10.5s total before giving up

export default function SamplerWaveform({
  regionId,
  slotIndex = 0, numSamples,
  loopEnabled, loopStart, loopEnd,
  onCommitLoopPoints,
  smpStart = 0, smpLength = 0, declickMs = 1.5,
  fadeInMs = 0, fadeOutMs = 0, sampleRate = 48000,
  crossfadeSamples = 0,
  onCommitSmpPoints,
  width: requestedWidth = 520, height: requestedHeight = 100,
  responsive = false,
  snapZero = true,
  onViewChange,
  playPosition = null,
}) {
  const canvasRef = useRef(null)
  const [responsiveWidth, setResponsiveWidth] = useState(0)
  const [responsiveHeight, setResponsiveHeight] = useState(0)
  const [peaks, setPeaks] = useState(null)
  const [loadError, setLoadError] = useState(false)
  // Distinct from loadError: the slot is fine, it just has nothing in it.
  const [slotEmpty, setSlotEmpty] = useState(false)
  // The mipmap's OWN rate/length. The peaks RPC takes seconds, so the view
  // window (samples) has to be converted with the rate of the buffer actually
  // being drawn — which is the baked buffer when PREP has run, not necessarily
  // the source file's rate.
  const [mipmapRate, setMipmapRate] = useState(0)
  const themeEpoch = useThemeEpoch()
  const width = responsive && responsiveWidth > 0 ? responsiveWidth : requestedWidth
  // Height follows the well too, not just width: the well now stretches to the
  // height of the column beside it, and a fixed-height canvas left a band of
  // dead space under the waveform for no reason.
  const height = responsive && responsiveHeight > 0 ? responsiveHeight : requestedHeight
  const waveH = Math.max(1, height - OVERVIEW_H)

  const [view, setView] = useState({ start: 0, len: 0 })
  const viewRef = useRef(view)
  viewRef.current = view

  // A view of len 0 means "not initialised yet" — resolve it to the whole
  // sample as soon as one is known, and re-fit whenever the sample changes
  // underneath us (slot switch, swap, PREP bake landing).
  useEffect(() => {
    setView({ start: 0, len: numSamples })
  }, [numSamples, slotIndex, regionId])

  const effRate = mipmapRate > 0 ? mipmapRate : (sampleRate > 0 ? sampleRate : 48000)
  const viewLen = view.len > 0 ? view.len : numSamples
  const viewStart = Math.max(0, Math.min(view.start, Math.max(0, numSamples - 1)))
  const zoomed = numSamples > 0 && viewLen < numSamples

  useEffect(() => {
    if (!responsive || typeof ResizeObserver === 'undefined') return undefined
    const container = canvasRef.current?.parentElement
    if (!container) return undefined

    const update = (nextWidth, nextHeight) => {
      const w = Math.max(1, Math.round(nextWidth))
      const h = Math.max(1, Math.round(nextHeight))
      setResponsiveWidth((current) => current === w ? current : w)
      setResponsiveHeight((current) => current === h ? current : h)
    }
    update(container.clientWidth, container.clientHeight)

    const observer = new ResizeObserver((entries) => {
      if (entries[0]) update(entries[0].contentRect.width, entries[0].contentRect.height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [responsive])

  // Loop marker drag state
  const loopDragRef = useRef(null)
  const [loopDrag, setLoopDrag] = useState(null)

  // Trim marker drag state
  const smpDragRef = useRef(null)
  const [smpDrag, setSmpDrag] = useState(null)

  // Pan drag state (a drag on empty canvas scrolls the view).
  const panRef = useRef(null)

  // ── Peaks fetch, scoped to the view window ─────────────────────────────────
  // One cancellation token for EVERY chain, not one per call site. Handing the
  // change-listener its own `{cancelled}` object meant no cleanup path could
  // ever reach it, so each `timeline-sampler-changed` event left behind a
  // retry loop that outlived the component — they stack, and they never stop.
  const fetchSignalRef = useRef({ cancelled: false })

  // Supersede every chain started so far and hand out a fresh token.
  const restartFetch = useCallback(() => {
    fetchSignalRef.current.cancelled = true
    const signal = { cancelled: false }
    fetchSignalRef.current = signal
    return signal
  }, [])

  useEffect(() => () => { fetchSignalRef.current.cancelled = true }, [])

  const fetchPeaks = useCallback(async (signal, attempt = 0) => {
    if (!regionId) { setLoadError(true); return }
    const v = viewRef.current
    const len = v.len > 0 ? v.len : numSamples
    // Until a length is known, ask for the whole sample (endTime < 0).
    const haveWindow = len > 0 && numSamples > 0
    const rate = mipmapRate > 0 ? mipmapRate : (sampleRate > 0 ? sampleRate : 48000)
    const startTime = haveWindow ? (v.start / rate) : 0
    const endTime = haveWindow ? ((v.start + len) / rate) : -1
    try {
      const data = await window.xleth?.waveform?.getRegionPeaks?.(
        regionId, startTime, endTime, width, -1, slotIndex)
      if (signal?.cancelled) return
      if (data && data.ready && data.peaks?.length > 0) {
        setPeaks(data.peaks)  // stride-3 [min,max,rms,...]
        if (data.sampleRate > 0) setMipmapRate(data.sampleRate)
        setSlotEmpty(false)
        setLoadError(false)
      } else if (data && data.mapped === false) {
        // Nothing is mapped into this region/slot. No amount of waiting fixes
        // that, so say so instead of polling. Strict `=== false` on purpose:
        // an addon built before the flag existed reports undefined and falls
        // through to the retry path below, which now terminates on its own.
        setSlotEmpty(true)
        setLoadError(true)
      } else if (data && !data.ready) {
        // Mipmap still generating — retry on a budget.
        if (attempt >= PEAKS_MAX_ATTEMPTS) { setLoadError(true); return }
        const delay = attempt < PEAKS_RETRY_FAST_ATTEMPTS
          ? PEAKS_RETRY_FAST_MS
          : PEAKS_RETRY_SLOW_MS
        setTimeout(() => {
          if (!signal?.cancelled) fetchPeaks(signal, attempt + 1)
        }, delay)
      } else {
        setLoadError(true)
      }
    } catch { if (!signal?.cancelled) setLoadError(true) }
  }, [regionId, width, slotIndex, numSamples, mipmapRate, sampleRate])

  useEffect(() => {
    const signal = restartFetch()
    fetchPeaks(signal)
    return () => { signal.cancelled = true }
  }, [fetchPeaks, restartFetch, viewStart, viewLen])

  // Re-fetch when audio data changes (swap / normalize / reverse / bake landing)
  useEffect(() => {
    if (!regionId) return
    const onChanged = (e) => {
      if (e.detail?.regionId && e.detail.regionId !== regionId) return
      // restartFetch, not a fresh local token: the audio changed, so whatever
      // the previous chain is still polling for is stale anyway.
      fetchPeaks(restartFetch())
    }
    timelineEvents.addEventListener('timeline-sampler-changed', onChanged)
    return () => timelineEvents.removeEventListener('timeline-sampler-changed', onChanged)
  }, [regionId, fetchPeaks, restartFetch])

  // ── Sample <-> pixel, through the view window ──────────────────────────────
  const sampleToX = useCallback((s) => {
    if (viewLen <= 0) return 0
    return ((s - viewStart) / viewLen) * width
  }, [viewStart, viewLen, width])

  const xToSample = useCallback((x) => {
    if (viewLen <= 0) return 0
    const clamped = Math.max(0, Math.min(width, x))
    return Math.round(viewStart + (clamped / width) * viewLen)
  }, [viewStart, viewLen, width])

  const clampView = useCallback((start, len) => {
    if (numSamples <= 0) return { start: 0, len: 0 }
    const maxLen = numSamples
    const minLen = Math.max(1, Math.ceil(width * MIN_SAMPLES_PER_PX))
    const l = Math.max(Math.min(minLen, maxLen), Math.min(Math.round(len), maxLen))
    const s = Math.max(0, Math.min(Math.round(start), maxLen - l))
    return { start: s, len: l }
  }, [numSamples, width])

  // ── Render ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width  = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = '#0a0a10'
    ctx.fillRect(0, 0, width, height)

    if (!peaks) {
      ctx.fillStyle = tokenValue('--theme-text-placeholder')
      ctx.font = uiCanvasFont('11px')
      ctx.textAlign = 'center'
      ctx.fillText(
        slotEmpty ? 'No sample in this slot'
          : loadError ? 'Waveform unavailable'
            : 'Loading…',
        width / 2, height / 2)
      return
    }

    // Everything below the overview strip is the editable waveform; shift the
    // origin down once rather than adding OVERVIEW_H at every call site.
    ctx.save()
    ctx.translate(0, OVERVIEW_H)

    // Waveform (envelope + RMS body via shared renderer)
    const ds   = downsamplePeaks3(peaks, width)
    const cols = Math.floor(ds.length / 3)
    const mid  = waveH / 2

    drawEnvelope(
      ctx, ds,
      0, 0, width, waveH,
      0, cols,
      tokenValue('--theme-sampler-envelope-fill'),  // envelope fill
      tokenValue('--theme-waveform-rms-body'),      // RMS body (brighter)
    )

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.moveTo(0, mid + 0.5)
    ctx.lineTo(width, mid + 0.5)
    ctx.stroke()

    // ── Trim markers (SMP START / LENGTH) ────────────────────────────────────
    if (numSamples > 0) {
      const liveSmpStart  = smpDrag?.start ?? smpStart
      const liveSmpLength = smpDrag != null ? (smpDrag.end - smpDrag.start) : smpLength
      const effectiveEnd  = liveSmpStart + (liveSmpLength > 0 ? liveSmpLength : numSamples - liveSmpStart)
      const xTrimStart    = sampleToX(liveSmpStart)
      const xTrimEnd      = sampleToX(effectiveEnd)

      // Dim outside-trim zones
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
      if (xTrimStart > 0)     ctx.fillRect(0,        0, Math.min(xTrimStart, width), waveH)
      if (xTrimEnd   < width) ctx.fillRect(Math.max(0, xTrimEnd), 0, width - Math.max(0, xTrimEnd), waveH)

      // Active trim region highlight
      ctx.fillStyle = 'rgba(51, 206, 214, 0.07)'
      ctx.fillRect(xTrimStart, 0, Math.max(0, xTrimEnd - xTrimStart), waveH)

      // Declick fade overlays — widths are in samples, so they scale with zoom
      // like everything else rather than staying a fixed pixel smear.
      const pxPerSample = viewLen > 0 ? width / viewLen : 0
      // declickMs -> samples. The panel has always sent `declickMs`, but this
      // component took a `declickSamples` prop nobody passed, so the overlay
      // was frozen at its 64-sample default and never reflected the control.
      const declickSamples = Math.max(0, (declickMs / 1000) * effRate)
      const fadeWidth = declickSamples * pxPerSample
      if (fadeWidth > 0.5) {
        const fadeInGrad = ctx.createLinearGradient(xTrimStart, 0, xTrimStart + fadeWidth, 0)
        fadeInGrad.addColorStop(0, 'rgba(0,0,0,0.35)')
        fadeInGrad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = fadeInGrad
        ctx.fillRect(xTrimStart, 0, fadeWidth, waveH)

        const fadeOutGrad = ctx.createLinearGradient(xTrimEnd - fadeWidth, 0, xTrimEnd, 0)
        fadeOutGrad.addColorStop(0, 'rgba(0,0,0,0)')
        fadeOutGrad.addColorStop(1, 'rgba(0,0,0,0.35)')
        ctx.fillStyle = fadeOutGrad
        ctx.fillRect(xTrimEnd - fadeWidth, 0, fadeWidth, waveH)
      }

      // User fade-in overlay (teal gradient)
      if (fadeInMs > 0 && effRate > 0) {
        const fiSamples = (fadeInMs / 1000) * effRate
        const fiPx = Math.min(fiSamples * pxPerSample, xTrimEnd - xTrimStart)
        if (fiPx > 0.5) {
          const g = ctx.createLinearGradient(xTrimStart, 0, xTrimStart + fiPx, 0)
          g.addColorStop(0, 'rgba(51,206,214,0.30)')
          g.addColorStop(1, 'rgba(51,206,214,0)')
          ctx.fillStyle = g
          ctx.fillRect(xTrimStart, 0, fiPx, waveH)
        }
      }

      // User fade-out overlay (teal gradient)
      if (fadeOutMs > 0 && effRate > 0) {
        const foSamples = (fadeOutMs / 1000) * effRate
        const foPx = Math.min(foSamples * pxPerSample, xTrimEnd - xTrimStart)
        if (foPx > 0.5) {
          const g = ctx.createLinearGradient(xTrimEnd - foPx, 0, xTrimEnd, 0)
          g.addColorStop(0, 'rgba(51,206,214,0)')
          g.addColorStop(1, 'rgba(51,206,214,0.30)')
          ctx.fillStyle = g
          ctx.fillRect(xTrimEnd - foPx, 0, foPx, waveH)
        }
      }

      // Trim START / END lines
      ctx.strokeStyle = tokenValue('--theme-sampler-trim-handle')
      ctx.lineWidth = 2
      for (const x of [xTrimStart, xTrimEnd]) {
        if (x < -2 || x > width + 2) continue
        ctx.beginPath()
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, waveH)
        ctx.stroke()
      }

      // Small top-caps to identify start vs end
      ctx.fillStyle = tokenValue('--theme-sampler-trim-handle')
      for (const x of [xTrimStart, xTrimEnd]) {
        if (x < -4 || x > width + 4) continue
        ctx.fillRect(Math.round(x) - 3, 0, 7, 5)
      }
    }

    // ── Loop markers ─────────────────────────────────────────────────────────
    if (loopEnabled && numSamples > 0) {
      const lsSamples = loopDrag?.start ?? loopStart
      const leSamples = loopDrag?.end   ?? (loopEnd || numSamples)
      const xStart = sampleToX(lsSamples)
      const xEnd   = sampleToX(leSamples)

      // Translucent band
      ctx.fillStyle = tokenValue('--theme-sampler-loop-crossfade-fill')
      ctx.fillRect(xStart, 0, Math.max(0, xEnd - xStart), waveH)

      ctx.strokeStyle = tokenValue('--theme-label-pitch')
      ctx.lineWidth = 2
      for (const x of [xStart, xEnd]) {
        if (x < -2 || x > width + 2) continue
        ctx.beginPath()
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, waveH)
        ctx.stroke()
      }

      // ── Crossfade zone (FL-style) ─────────────────────────────────────────
      // Wrap is to (loopStart + N), so the first N samples of the loop are
      // "fade-in source" only. Show the effective-loop-start at loopStart+N
      // and an X-pattern over the fade-out region [loopEnd-N .. loopEnd].
      if (crossfadeSamples > 0) {
        const trimStart = smpDrag?.start ?? smpStart
        const trimEnd = (smpDrag != null ? smpDrag.end
          : (smpLength > 0 ? smpStart + smpLength : numSamples))
        const loopLen = Math.max(0, leSamples - lsSamples)
        let xfSrc = Math.min(crossfadeSamples, Math.floor(loopLen / 2))
        xfSrc = Math.min(xfSrc, Math.max(0, leSamples - trimStart))
        xfSrc = Math.min(xfSrc, Math.max(0, trimEnd - lsSamples))
        if (xfSrc > 0) {
          const xfPx = xfSrc * (viewLen > 0 ? width / viewLen : 0)
          const aStartX = xEnd - xfPx                     // fade-out zone start
          const effStartX = xStart + xfPx                 // effective loop wrap point
          ctx.save()
          // Fade-out zone band + X pattern
          ctx.fillStyle = 'rgba(255,160,60,0.14)'
          ctx.fillRect(aStartX, 0, xfPx, waveH)
          ctx.strokeStyle = 'rgba(255,160,60,0.55)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(aStartX, 0);       ctx.lineTo(aStartX + xfPx, waveH)
          ctx.moveTo(aStartX, waveH);   ctx.lineTo(aStartX + xfPx, 0)
          ctx.stroke()
          // Effective wrap-point marker (dashed line at loopStart + N)
          ctx.strokeStyle = tokenValue('--theme-sampler-trim-handle')
          ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.moveTo(Math.round(effStartX) + 0.5, 0)
          ctx.lineTo(Math.round(effStartX) + 0.5, waveH)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
        }
      }
    }

    // ── Playhead ─────────────────────────────────────────────────────────────
    // Only drawn when the engine actually reports a sounding voice for this
    // slot. Nothing is interpolated or simulated here: a playhead that guessed
    // would drift against the audio and be worse than none at all.
    if (playPosition != null && playPosition >= 0 && numSamples > 0) {
      const px = sampleToX(playPosition)
      if (px >= -1 && px <= width + 1) {
        ctx.strokeStyle = tokenValue('--theme-sampler-waveform-playhead')
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(Math.round(px) + 0.5, 0)
        ctx.lineTo(Math.round(px) + 0.5, waveH)
        ctx.stroke()
      }
    }

    ctx.restore()

    // ── Overview strip ───────────────────────────────────────────────────────
    // The whole file as a flat bar, with the view window as a bright box.
    if (numSamples > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(0, 0, width, OVERVIEW_H - 1)

      // Trim region on the overview, so the selection is findable when zoomed
      // somewhere else entirely.
      const tStart = (smpDrag?.start ?? smpStart) / numSamples * width
      const tLen = smpLength > 0 ? smpLength : numSamples - smpStart
      const tEnd = ((smpDrag != null ? smpDrag.end : smpStart + tLen) / numSamples) * width
      ctx.fillStyle = 'rgba(51,206,214,0.18)'
      ctx.fillRect(tStart, 0, Math.max(1, tEnd - tStart), OVERVIEW_H - 1)

      const vx = (viewStart / numSamples) * width
      const vw = Math.max(2, (viewLen / numSamples) * width)
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      ctx.fillRect(vx, 0, vw, OVERVIEW_H - 1)
      ctx.strokeStyle = tokenValue('--theme-sampler-trim-handle')
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(vx) + 0.5, 0.5, Math.max(2, Math.round(vw) - 1), OVERVIEW_H - 2)

      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.beginPath()
      ctx.moveTo(0, OVERVIEW_H - 0.5)
      ctx.lineTo(width, OVERVIEW_H - 0.5)
      ctx.stroke()
    }
  }, [peaks, loadError, slotEmpty, width, height, waveH,
      loopEnabled, loopStart, loopEnd, loopDrag,
      smpStart, smpLength, declickMs, smpDrag,
      fadeInMs, fadeOutMs, effRate,
      crossfadeSamples, sampleToX, viewStart, viewLen,
      playPosition,
      numSamples, themeEpoch])

  // ── Shared helpers ──────────────────────────────────────────────────────────
  const getLocalX = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return e.clientX - rect.left
  }, [])

  const isOverOverview = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return false
    return (e.clientY - rect.top) < OVERVIEW_H
  }, [])

  // ── Zoom ────────────────────────────────────────────────────────────────────
  // Wheel zooms about the pointer, so the sample under the cursor stays put —
  // the only zoom that lets you keep a loop point in sight while you tighten
  // around it. Shift+wheel pans instead.
  const handleWheel = useCallback((e) => {
    if (numSamples <= 0) return
    e.preventDefault()
    const v = clampView(viewStart, viewLen)

    if (e.shiftKey) {
      const delta = (e.deltaY || e.deltaX) > 0 ? 1 : -1
      setView(clampView(v.start + delta * v.len * 0.15, v.len))
      return
    }

    const x = Math.max(0, Math.min(width, getLocalX(e)))
    const anchor = v.start + (x / width) * v.len
    const factor = (e.deltaY > 0) ? 1.25 : 0.8
    const nextLen = v.len * factor
    // Keep `anchor` under the cursor after the resize.
    const nextStart = anchor - (x / width) * nextLen
    setView(clampView(nextStart, nextLen))
  }, [numSamples, clampView, viewStart, viewLen, width, getLocalX])

  // Wheel must be a NON-PASSIVE native listener: React's synthetic onWheel is
  // registered passively, so preventDefault() there is ignored and the panel
  // scrolls behind the zoom.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return undefined
    c.addEventListener('wheel', handleWheel, { passive: false })
    return () => c.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const zoomToFit = useCallback(() => {
    setView(clampView(0, numSamples))
  }, [clampView, numSamples])

  // Zoom to the trim selection — the single most common thing to want a close
  // look at, and otherwise a lot of wheel work to reach.
  const zoomToSelection = useCallback(() => {
    if (numSamples <= 0) return
    const len = smpLength > 0 ? smpLength : numSamples - smpStart
    if (len <= 0) return
    const pad = Math.round(len * 0.05)
    setView(clampView(smpStart - pad, len + pad * 2))
  }, [clampView, numSamples, smpStart, smpLength])

  // ── mouseDown: handles first, then overview scrub, then pan ─────────────────
  const handleMouseDown = useCallback((e) => {
    if (numSamples <= 0) return

    // Overview strip: click/drag to move the view window there.
    if (isOverOverview(e)) {
      e.preventDefault()
      const jump = (ev) => {
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return
        const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / width))
        const v = viewRef.current
        const len = v.len > 0 ? v.len : numSamples
        setView(clampView(frac * numSamples - len / 2, len))
      }
      jump(e)
      const onMove = (ev) => jump(ev)
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }

    const x = getLocalX(e)

    // Trim handle hit-test
    const effectiveEnd  = smpStart + (smpLength > 0 ? smpLength : numSamples - smpStart)
    const xTrimStart    = sampleToX(smpStart)
    const xTrimEnd      = sampleToX(effectiveEnd)

    if (Math.abs(x - xTrimStart) <= HANDLE_HIT) {
      e.preventDefault()
      smpDragRef.current = { handle: 'smpStart', alt: e.altKey }
      setSmpDrag({ start: smpStart, end: effectiveEnd })
      return
    }
    if (Math.abs(x - xTrimEnd) <= HANDLE_HIT) {
      e.preventDefault()
      smpDragRef.current = { handle: 'smpEnd', alt: e.altKey }
      setSmpDrag({ start: smpStart, end: effectiveEnd })
      return
    }

    // Loop handle hit-test
    if (loopEnabled) {
      const resolvedEnd = loopEnd || numSamples
      const xs = sampleToX(loopStart)
      const xe = sampleToX(resolvedEnd)
      let handle = null
      if (Math.abs(x - xs) <= HANDLE_HIT) handle = 'start'
      else if (Math.abs(x - xe) <= HANDLE_HIT) handle = 'end'
      if (handle) {
        e.preventDefault()
        loopDragRef.current = { handle, alt: e.altKey }
        setLoopDrag({ start: loopStart, end: resolvedEnd })
        return
      }
    }

    // Nothing under the pointer — drag the view.
    e.preventDefault()
    panRef.current = { startX: e.clientX, startView: clampView(viewStart, viewLen) }
  }, [numSamples, getLocalX, isOverOverview, smpStart, smpLength,
      loopEnabled, loopStart, loopEnd, sampleToX, clampView, viewStart, viewLen, width])

  // ── Global mousemove / mouseup ───────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return

      // Pan
      const pan = panRef.current
      if (pan) {
        const dx = e.clientX - pan.startX
        const perPx = pan.startView.len / width
        setView(clampView(pan.startView.start - dx * perPx, pan.startView.len))
        return
      }

      const x   = e.clientX - rect.left
      const val = xToSample(x)

      // Trim drag
      const sd = smpDragRef.current
      if (sd) {
        setSmpDrag((prev) => {
          if (!prev) return prev
          if (sd.handle === 'smpStart') return { start: Math.min(val, prev.end - 1), end: prev.end }
          return { start: prev.start, end: Math.max(val, prev.start + 1) }
        })
        return
      }

      // Loop drag
      const ld = loopDragRef.current
      if (!ld) return
      setLoopDrag((prev) => {
        if (!prev) return prev
        if (ld.handle === 'start') return { ...prev, start: Math.min(val, prev.end - 1) }
        return { ...prev, end: Math.max(val, prev.start + 1) }
      })
    }

    // Snap a just-released handle to the nearest zero crossing. Async, so the
    // commit happens after the snap resolves — a click-and-release with no
    // movement still round-trips, which is the cheapest way to snap an existing
    // point that was set before snapping existed.
    const finishSmp = async (final, alt) => {
      let { start, end } = final
      if (snapZero && !alt) {
        const [s, e2] = await Promise.all([
          snapToZeroCrossing(regionId, slotIndex, start, viewLen, width, numSamples),
          snapToZeroCrossing(regionId, slotIndex, end, viewLen, width, numSamples),
        ])
        start = s
        end = Math.max(s + 1, e2)
      }
      onCommitSmpPoints?.({ smpStart: start, smpLength: end - start })
    }

    const finishLoop = async (final, alt) => {
      let { start, end } = final
      if (snapZero && !alt) {
        const [s, e2] = await Promise.all([
          snapToZeroCrossing(regionId, slotIndex, start, viewLen, width, numSamples),
          snapToZeroCrossing(regionId, slotIndex, end, viewLen, width, numSamples),
        ])
        start = s
        end = Math.max(s + 1, e2)
      }
      onCommitLoopPoints?.({ loopStart: start, loopEnd: end })
    }

    const onUp = () => {
      if (panRef.current) { panRef.current = null; return }
      if (smpDragRef.current) {
        const { alt } = smpDragRef.current
        smpDragRef.current = null
        setSmpDrag((final) => {
          if (final) finishSmp(final, alt)
          return null
        })
        return
      }
      if (loopDragRef.current) {
        const { alt } = loopDragRef.current
        loopDragRef.current = null
        setLoopDrag((final) => {
          if (final) finishLoop(final, alt)
          return null
        })
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [xToSample, onCommitLoopPoints, onCommitSmpPoints, numSamples, width,
      clampView, snapZero, regionId, slotIndex, viewLen])

  // ── Cursor feedback ─────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState('default')
  const handleMouseMove = useCallback((e) => {
    if (numSamples <= 0) { setCursor('default'); return }
    if (isOverOverview(e)) { setCursor('pointer'); return }
    const x = getLocalX(e)

    const effectiveEnd = smpStart + (smpLength > 0 ? smpLength : numSamples - smpStart)
    if (Math.abs(x - sampleToX(smpStart)) <= HANDLE_HIT
      || Math.abs(x - sampleToX(effectiveEnd)) <= HANDLE_HIT) {
      setCursor('ew-resize'); return
    }

    if (loopEnabled) {
      if (Math.abs(x - sampleToX(loopStart)) <= HANDLE_HIT
        || Math.abs(x - sampleToX(loopEnd || numSamples)) <= HANDLE_HIT) {
        setCursor('ew-resize'); return
      }
    }
    setCursor(zoomed ? 'grab' : 'default')
  }, [numSamples, getLocalX, isOverOverview, smpStart, smpLength,
      loopEnabled, loopStart, loopEnd, sampleToX, zoomed])

  // Expose the zoom actions to the panel's waveform header without making it
  // reach into this component's state.
  const api = useMemo(() => ({ zoomToFit, zoomToSelection, zoomed, viewStart, viewLen }),
    [zoomToFit, zoomToSelection, zoomed, viewStart, viewLen])
  useEffect(() => { onViewChange?.({ start: viewStart, len: viewLen, api }) }, [api, onViewChange, viewStart, viewLen])

  return (
    <canvas
      ref={canvasRef}
      style={{ cursor, display: 'block', borderRadius: 4, border: '1px solid var(--theme-sampler-key-border)' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onDoubleClick={(e) => { e.preventDefault(); zoomToFit() }}
      title="Wheel = zoom · Shift+wheel = scroll · drag = pan · double-click = fit · Alt while dragging a handle = no zero-crossing snap"
    />
  )
}

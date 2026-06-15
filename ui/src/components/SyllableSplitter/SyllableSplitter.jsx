import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { Play, Square, Trash2 } from 'lucide-react'
import { downsamplePeaks3, drawEnvelope } from '../../utils/waveformRenderer.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  buildSplitterSections,
  createInitialSplitterState,
  serializeSplitterSyllables,
} from './syllableModel.js'
import {
  buildMipmap,
  computePeakAmplitude,
  MIP_BASE_COLS,
  MIP_LEVELS,
} from './splitSyllablesMipmap.js'

// ── Constants ────────────────────────────────────────────────────────────────
const CANVAS_H   = 90    // waveform canvas height
const HANDLE_HIT = 8     // hit-test radius around marker (px)
const DELETE_EDGE = 6    // drag this close to left/right edge → delete marker
const MIN_ZOOM   = 1
const MAX_ZOOM   = 32
// Master peak resolution fetched from the engine (tier 5 / 32×). The mipmap
// derives the coarser tiers from this single fetch, which is then cached.
const MASTER_COLS = MIP_BASE_COLS * MIP_LEVELS[MIP_LEVELS.length - 1]
// Visual-normalization guards (drawing only — never touches audio).
const MIN_PEAK_AMP = 1e-3   // below this the region is treated as silence (no boost)
const MAX_NORM     = 50     // cap so near-silence isn't amplified into noise

// ── Module-level peak cache ────────────────────────────────────────────────
// Keyed by file path + region time range so re-opening the same Quote (or
// flipping between samples) reuses the computed mipmap instantly — no engine
// IPC round-trip, no Worker call. Lives for the life of the renderer process.
const peakCache = new Map()   // key → { tiers: Float32Array[], peakAmplitude, baseCols }

// ── Mipmap Web Worker (lazy, shared, with main-thread fallback) ─────────────
let _worker = null            // Worker | false (false = unavailable, use fallback)
let _reqId  = 0
const _pending = new Map()    // id → { resolve, fallback }

function getWorker() {
  if (_worker !== null) return _worker
  if (typeof Worker === 'undefined') { _worker = false; return false }
  try {
    _worker = new Worker(new URL('./splitSyllablesWorker.js', import.meta.url), { type: 'module' })
    _worker.onmessage = (e) => {
      const { id, error, tiers, peakAmplitude, baseCols } = e.data || {}
      const p = _pending.get(id)
      if (!p) return
      _pending.delete(id)
      if (error || !tiers) p.resolve(p.fallback())
      else                 p.resolve({ tiers, peakAmplitude, baseCols })
    }
    _worker.onerror = () => {
      // Spawn/runtime failure — resolve everything via the main-thread fallback.
      for (const [, p] of _pending) p.resolve(p.fallback())
      _pending.clear()
    }
  } catch {
    _worker = false
  }
  return _worker
}

// Build the mipmap off-thread; resolve on the main thread when no Worker exists
// (test runner) or if the worker errors. Always copies into a transferable
// Float32Array so the caller's peaks array is never neutered.
function computeMipmap(peaks, stride = 3) {
  const fallback = () => buildMipmap(peaks, stride)
  const w = getWorker()
  if (!w) return Promise.resolve(fallback())
  return new Promise((resolve) => {
    const id = ++_reqId
    _pending.set(id, { resolve, fallback })
    try {
      const buf = Float32Array.from(peaks)
      w.postMessage({ action: 'mipmap', id, peaks: buf, stride }, [buf.buffer])
    } catch {
      _pending.delete(id)
      resolve(fallback())
    }
  })
}

// Slice the source-wide stride-3 peaks array down to the region's time range
function sliceRegionPeaks(peaks, stride, sourceDuration, regionStart, regionEnd) {
  if (!peaks || !sourceDuration || sourceDuration <= 0) return null
  const srcCols = Math.floor(peaks.length / stride)
  const startFrac = Math.max(0, regionStart / sourceDuration)
  const endFrac   = Math.min(1, regionEnd   / sourceDuration)
  const a = Math.floor(startFrac * srcCols) * stride
  const b = Math.ceil (endFrac   * srcCols) * stride
  if (b <= a) return null
  return peaks.slice(a, b)
}

// ── Component ────────────────────────────────────────────────────────────────
/**
 * Props:
 *   region              – { id, startTime, endTime, syllables, audioFilePath, sourceId, ... }
 *   sourceFilePath      – string (the source media path, for preview playback)
 *   sourceWaveform      – { peaks, duration } for the whole source; we slice to region
 *   regionWaveform      – optional: already-sliced peaks for just this region
 *   onSave              – (syllables) => void
 *   compact             – boolean; reduce height when shown inline in SamplePicker
 */
export default function SyllableSplitter({
  region,
  sourceFilePath,
  sourceWaveform,
  regionWaveform,
  onSave,
  compact = false,
}) {
  const canvasRef          = useRef(null)
  const containerRef       = useRef(null)
  const waveformWrapRef    = useRef(null)
  const scrollTrackRef     = useRef(null)
  const previewTimerRef    = useRef(null)
  const previewTokenRef    = useRef(0)
  const sourceLoadTokenRef = useRef(0)

  const regionDur = Math.max(0.001, (region?.endTime ?? 0) - (region?.startTime ?? 0))

  // Stable cache key: identifies the region's audio content across re-opens.
  const cacheKey = useMemo(() => {
    const fp = sourceFilePath || region?.audioFilePath ||
               (region?.sourceId != null ? `src:${region.sourceId}` : null)
    if (!fp) return null
    return `${fp}|${(region?.startTime ?? 0).toFixed(4)}|${(region?.endTime ?? 0).toFixed(4)}`
  }, [sourceFilePath, region?.audioFilePath, region?.sourceId, region?.startTime, region?.endTime])

  // ── Internal state: markers = region-relative seconds, sorted ───────────────
  const initial = useMemo(() => {
    return createInitialSplitterState(region?.syllables ?? [], regionDur)
  }, [region?.id, region?.syllables, regionDur])

  const [markers, setMarkers] = useState(initial.markers)
  const [texts,   setTexts]   = useState(initial.texts)
  const [hasLeadingPlaceholder, setHasLeadingPlaceholder] = useState(initial.hasLeadingPlaceholder)
  const [dirty,        setDirty]        = useState(false)
  const [drag,         setDrag]         = useState(null)  // { idx, pendingDelete }
  const [playingIdx,   setPlayingIdx]   = useState(null)
  const [sourceReady,  setSourceReady]  = useState(false)
  // Spacebar preview state
  const [selectedMarkerIndex, setSelectedMarkerIndex] = useState(0)  // section index

  // ── Zoom / scroll state ─────────────────────────────────────────────────────
  const [zoomLevel,     setZoomLevel]     = useState(MIN_ZOOM)        // 1 … 32
  const [scrollOffsetMs, setScrollOffsetMs] = useState(0)             // left edge, ms
  const [mip, setMip] = useState(() => (cacheKey ? peakCache.get(cacheKey) || null : null))

  // Refs mirror the live view + region so the (once-bound) wheel/marker handlers
  // always read fresh values without re-binding listeners on every change.
  const zoomRef      = useRef(zoomLevel)
  const scrollRef    = useRef(scrollOffsetMs)
  const regionDurRef = useRef(regionDur)
  zoomRef.current      = zoomLevel
  scrollRef.current    = scrollOffsetMs
  regionDurRef.current = regionDur

  // Reset when region changes
  useEffect(() => {
    setMarkers(initial.markers)
    setTexts(initial.texts)
    setHasLeadingPlaceholder(initial.hasLeadingPlaceholder)
    setDirty(false)
    setSelectedMarkerIndex(0)
  }, [initial])

  // ── Derived: section count = markers.length + 1 ─────────────────────────────
  const sections = useMemo(() => {
    return buildSplitterSections(markers, texts, regionDur, hasLeadingPlaceholder)
  }, [markers, texts, regionDur, hasLeadingPlaceholder])

  // Keep `texts` aligned to `sections` count: pad/trim without erasing data
  useEffect(() => {
    setTexts(prev => {
      const n = markers.length + 1
      if (prev.length === n) return prev
      const next = prev.slice(0, n)
      while (next.length < n) next.push('')
      return next
    })
  }, [markers.length])

  // ── Prop-derived fallback peaks (immediate, lower-res) ──────────────────────
  const regionPeaks = useMemo(() => {
    if (regionWaveform?.peaks) return regionWaveform.peaks
    if (sourceWaveform?.peaks) {
      return sliceRegionPeaks(
        sourceWaveform.peaks,
        sourceWaveform.stride || 3,
        sourceWaveform.duration,
        region?.startTime ?? 0,
        region?.endTime ?? 0,
      )
    }
    return null
  }, [regionWaveform, sourceWaveform, region?.startTime, region?.endTime])

  // ── Load / build the cached mipmap for this region ──────────────────────────
  useEffect(() => {
    // Every region switch resets the view to the full overview.
    setZoomLevel(MIN_ZOOM)
    setScrollOffsetMs(0)

    if (!cacheKey) { setMip(null); return }
    const cached = peakCache.get(cacheKey)
    if (cached) { setMip(cached); return }   // hit → instant, no fetch/worker

    setMip(null)
    let cancelled = false
    ;(async () => {
      // Pull high-resolution master peaks from the engine (region-aware first,
      // then file-based which works for any FFmpeg-decodable format).
      let raw = null
      try {
        if (region?.id != null) {
          raw = await window.xleth?.waveform?.getRegionPeaks?.(
            region.id, region.startTime, region.endTime, MASTER_COLS, -1)
        }
        const fp = sourceFilePath || region?.audioFilePath
        if ((!raw || !raw.peaks?.length) && fp) {
          raw = await window.xleth?.waveform?.getFilePeaks?.(
            fp, region.startTime, region.endTime, MASTER_COLS, -1)
        }
      } catch { /* fall back to whatever the parent already provided */ }

      // Prefer engine peaks; otherwise build from the prop peaks so zoom still
      // works (just at lower resolution).
      const peaksArr = (raw && raw.peaks?.length) ? raw.peaks : regionPeaks
      if (!peaksArr || !peaksArr.length) return

      const result = await computeMipmap(peaksArr, 3)
      if (cancelled) return
      peakCache.set(cacheKey, result)
      setMip(result)
    })()
    return () => { cancelled = true }
    // regionPeaks is a stable per-region fallback snapshot; key drives reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey])

  // ── View math (derived from zoom + scroll) ──────────────────────────────────
  const visibleDur   = regionDur / Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel))
  const maxScrollSec = Math.max(0, regionDur - visibleDur)
  const startSec     = Math.min(Math.max(scrollOffsetMs / 1000, 0), maxScrollSec)
  const isZoomed     = zoomLevel > MIN_ZOOM + 1e-3

  // ── Canvas drawing ──────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w   = canvas.clientWidth
    const h   = canvas.clientHeight
    if (w === 0) return
    canvas.width  = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const computedStyle = getComputedStyle(canvas)
    const themeColor = (tokenName, fallbackToken = '--theme-text') => {
      const value = computedStyle.getPropertyValue(tokenName).trim()
      if (value && !value.includes('gradient(')) return value
      const fallbackValue = fallbackToken ? computedStyle.getPropertyValue(fallbackToken).trim() : ''
      if (fallbackValue && !fallbackValue.includes('gradient(')) return fallbackValue
      return computedStyle.color
    }

    const z          = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel))
    const visDur     = regionDur / z
    const maxScroll  = Math.max(0, regionDur - visDur)
    const start      = Math.min(Math.max(scrollOffsetMs / 1000, 0), maxScroll)
    const end        = start + visDur
    const timeToX    = (t) => ((t - start) / visDur) * w

    // Background
    ctx.fillStyle = themeColor('--theme-syllable-splitter-bg', '--theme-bg-inset')
    ctx.fillRect(0, 0, w, h)

    // Section tints (alternate) — visual aid for where each syllable lives
    const edges = [0, ...markers, regionDur]
    for (let i = 0; i < edges.length - 1; i++) {
      if (i % 2 === 0) continue
      const x0 = Math.max(0, timeToX(edges[i]))
      const x1 = Math.min(w, timeToX(edges[i + 1]))
      if (x1 <= x0) continue
      ctx.fillStyle = themeColor('--theme-syllable-section-alt', '--theme-accent-bg-subtle')
      ctx.fillRect(x0, 0, x1 - x0, h)
    }

    // Centerline
    const mid = h / 2
    ctx.strokeStyle = themeColor('--theme-syllable-splitter-wave-dim', '--theme-border-subtle')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(w, mid)
    ctx.stroke()

    // ── Waveform (stride-3) — pick the mipmap tier for the current zoom, slice
    //    the visible window, downsample to pixel width, and apply VISUAL-ONLY
    //    1/peak normalization (the audio data itself is never altered).
    let srcPeaks = null, srcCols = 0
    if (mip?.tiers?.length) {
      const ti = Math.min(MIP_LEVELS.length - 1, Math.max(0, Math.ceil(Math.log2(z))))
      srcPeaks = mip.tiers[ti]
      srcCols  = Math.floor(srcPeaks.length / 3)
    } else if (regionPeaks && regionPeaks.length >= 3) {
      srcPeaks = regionPeaks
      srcCols  = Math.floor(regionPeaks.length / 3)
    }

    if (srcPeaks && srcCols > 0) {
      const startFrac = start / regionDur
      const endFrac   = end   / regionDur
      const cs = Math.max(0, Math.min(srcCols, Math.floor(startFrac * srcCols)))
      const ce = Math.max(cs + 1, Math.min(srcCols, Math.ceil(endFrac * srcCols)))
      // .slice() always returns a fresh copy → safe to normalize in place below.
      const slice = srcPeaks.slice(cs * 3, ce * 3)
      const ds    = downsamplePeaks3(slice, Math.max(1, Math.floor(w)))
      const cols  = Math.floor(ds.length / 3)

      const peakAmp   = mip?.peakAmplitude ?? computePeakAmplitude(srcPeaks)
      const normScale = peakAmp > MIN_PEAK_AMP ? Math.min(MAX_NORM, 1 / peakAmp) : 1
      if (normScale !== 1) {
        for (let k = 0; k < ds.length; k++) ds[k] *= normScale
      }

      if (cols > 0) {
        drawEnvelope(
          ctx, ds,
          0, h * 0.06, w, h * 0.88,
          0, cols,
          themeColor('--theme-waveform-envelope-fill', '--theme-accent-bg-medium'),
          themeColor('--theme-waveform-rms-body', '--theme-accent'),
        )
      }
    } else {
      ctx.fillStyle = themeColor('--theme-syllable-splitter-label-fg', '--theme-text-muted')
      ctx.font = uiCanvasFont('11px')
      ctx.textBaseline = 'middle'
      ctx.fillText('No waveform', 8, mid)
    }

    // Section number labels (top-left of each visible section)
    ctx.fillStyle = themeColor('--theme-accent')
    ctx.font = uiCanvasFont('600 11px')
    ctx.textBaseline = 'top'
    for (const section of sections) {
      const x0 = timeToX(section.start)
      if (x0 < -20 || x0 > w) continue
      ctx.fillText(section.label, Math.max(2, x0) + 4, 3)
    }

    // Marker lines (only those within the visible window)
    ctx.strokeStyle = themeColor('--theme-accent')
    ctx.lineWidth = 2
    for (let i = 0; i < markers.length; i++) {
      const x = timeToX(markers[i])
      if (x < -2 || x > w + 2) continue
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      // Handle knobs at top and bottom
      ctx.fillStyle = themeColor('--theme-accent')
      ctx.fillRect(x - 4, 0, 8, 4)
      ctx.fillRect(x - 4, h - 4, 8, 4)
    }

    // Zoom indicator (top-right) when zoomed in
    if (z > MIN_ZOOM + 1e-3) {
      ctx.fillStyle = themeColor('--theme-accent')
      ctx.font = uiCanvasFont('500 10px')
      ctx.textAlign = 'right'
      ctx.textBaseline = 'top'
      ctx.fillText(`${z.toFixed(1)}×`, w - 4, 4)
      ctx.textAlign = 'left'
    }
  }, [markers, regionDur, mip, regionPeaks, sections, zoomLevel, scrollOffsetMs])

  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  // ── Interaction helpers (read view from refs → always fresh) ────────────────
  function viewBounds() {
    const rd = regionDurRef.current
    const z  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current))
    const visDur = rd / z
    const maxScroll = Math.max(0, rd - visDur)
    const start = Math.min(Math.max(scrollRef.current / 1000, 0), maxScroll)
    return { rd, visDur, start }
  }

  function pxToTime(clientX) {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const { rd, visDur, start } = viewBounds()
    const x = clientX - rect.left
    return Math.max(0, Math.min(rd, start + (x / rect.width) * visDur))
  }

  function hitTestMarker(clientX) {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const { visDur, start } = viewBounds()
    const x = clientX - rect.left
    for (let i = 0; i < markers.length; i++) {
      const mx = ((markers[i] - start) / visDur) * rect.width
      if (Math.abs(mx - x) <= HANDLE_HIT) return i
    }
    return -1
  }

  // ── Mouse handlers on canvas ────────────────────────────────────────────────
  const onCanvasMouseDown = useCallback((e) => {
    if (e.button === 2) {
      // Right-click → delete marker if over one
      const idx = hitTestMarker(e.clientX)
      if (idx >= 0) {
        e.preventDefault()
        setMarkers(prev => prev.filter((_, i) => i !== idx))
        setTexts(prev => {
          // When deleting marker idx, sections idx and idx+1 merge — keep idx's text
          const next = [...prev]
          next.splice(idx + 1, 1)
          return next
        })
        setDirty(true)
      }
      return
    }
    if (e.button !== 0) return

    const idx = hitTestMarker(e.clientX)
    if (idx >= 0) {
      setDrag({ idx, pendingDelete: false })
      setSelectedMarkerIndex(Math.min(idx + 1, sections.length - 1))
    } else {
      // Place a new marker
      const t = pxToTime(e.clientX)
      if (t <= 0 || t >= regionDur) return
      setMarkers(prev => {
        const next = [...prev, t].sort((a, b) => a - b)
        return next
      })
      setHasLeadingPlaceholder(true)
      setTexts(prev => {
        // A new marker splits one section into two — insert an empty text at
        // the new section's position. Find where t fits among existing markers.
        const sortedBefore = [...markers].sort((a, b) => a - b)
        let insertAt = sortedBefore.findIndex(m => m > t)
        if (insertAt < 0) insertAt = sortedBefore.length
        const next = [...prev]
        next.splice(insertAt + 1, 0, '')
        return next
      })
      setDirty(true)
    }
  }, [markers, regionDur])

  // Global drag handlers
  useEffect(() => {
    if (!drag) return
    const onMove = (e) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const nearDelete = (x < DELETE_EDGE) || (x > rect.width - DELETE_EDGE)
      if (nearDelete !== drag.pendingDelete) {
        setDrag(d => d && { ...d, pendingDelete: nearDelete })
      }
      const t = pxToTime(e.clientX)
      setMarkers(prev => {
        const next = [...prev]
        // Clamp between neighbors (but allow movement past them → we re-sort on drop)
        next[drag.idx] = t
        return next
      })
    }
    const onUp = () => {
      if (drag.pendingDelete) {
        setMarkers(prev => prev.filter((_, i) => i !== drag.idx))
        setTexts(prev => {
          const next = [...prev]
          next.splice(drag.idx + 1, 1)
          return next
        })
      } else {
        // Re-sort and clamp to avoid marker reordering confusion
        setMarkers(prev => {
          const eps = 0.002
          const sorted = [...prev].sort((a, b) => a - b)
          // Enforce a tiny gap so sections don't collapse to zero width
          for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] < sorted[i - 1] + eps) sorted[i] = sorted[i - 1] + eps
          }
          return sorted.filter(t => t > eps && t < regionDur - eps)
        })
      }
      setDirty(true)
      setDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, regionDur])

  // ── Wheel zoom (cursor-centered) + pan ──────────────────────────────────────
  // Registered non-passive so preventDefault() blocks the page from scrolling.
  // Reads exclusively through refs so the empty-dep effect stays fresh.
  useEffect(() => {
    const el = waveformWrapRef.current
    if (!el) return
    const handleWheel = (e) => {
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const { rd, visDur, start } = viewBounds()
      if (rd <= 0) return

      // Shift+wheel or horizontal scroll → pan
      if ((e.shiftKey && e.deltaY !== 0) || e.deltaX !== 0) {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
        const panSec = (delta / rect.width) * visDur * 1.5
        const maxScroll = Math.max(0, rd - visDur)
        const ns = Math.min(Math.max(start + panSec, 0), maxScroll)
        setScrollOffsetMs(ns * 1000)
        return
      }

      if (e.deltaY === 0) return
      const ratio     = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const mouseTime = start + ratio * visDur
      const factor    = e.deltaY < 0 ? 1.25 : 1 / 1.25   // up = zoom in
      const newZoom   = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * factor))
      const newVis    = rd / newZoom
      const newMax    = Math.max(0, rd - newVis)
      const newStart  = Math.min(Math.max(mouseTime - ratio * newVis, 0), newMax)
      setZoomLevel(newZoom)
      setScrollOffsetMs(newStart * 1000)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // ── Scrollbar (drag thumb / click track to pan) ─────────────────────────────
  const scrollDrag = useRef(null)   // { startX, startScrollSec }

  const onThumbDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    scrollDrag.current = { startX: e.clientX, startScrollSec: startSec }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [startSec])

  useEffect(() => {
    const onMove = (e) => {
      const d = scrollDrag.current
      if (!d) return
      const track = scrollTrackRef.current
      if (!track) return
      const rd = regionDurRef.current
      const visDur = rd / Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current))
      const maxScroll = Math.max(0, rd - visDur)
      const dx = e.clientX - d.startX
      const ns = Math.min(Math.max(d.startScrollSec + (dx / track.clientWidth) * rd, 0), maxScroll)
      setScrollOffsetMs(ns * 1000)
    }
    const onUp = () => {
      if (!scrollDrag.current) return
      scrollDrag.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onTrackDown = useCallback((e) => {
    if (e.button !== 0) return
    const track = scrollTrackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    const visDur = regionDur / Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel))
    const maxScroll = Math.max(0, regionDur - visDur)
    const ns = Math.min(Math.max(frac * regionDur - visDur / 2, 0), maxScroll)
    setScrollOffsetMs(ns * 1000)
  }, [regionDur, zoomLevel])

  const thumbLeft  = regionDur > 0 ? (startSec / regionDur) * 100 : 0
  const thumbWidth = regionDur > 0 ? Math.max(4, (visibleDur / regionDur) * 100) : 100

  // ── Preview playback (native engine — unchanged) ────────────────────────────
  const stopPreview = useCallback(() => {
    previewTokenRef.current += 1
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    window.xleth?.audio?.pauseSource().catch(() => {})
    setPlayingIdx(null)
  }, [])

  useEffect(() => {
    stopPreview()
    const token = ++sourceLoadTokenRef.current
    setSourceReady(false)

    if (!sourceFilePath) return

    ;(async () => {
      try {
        const result = await window.xleth?.audio?.loadSource(sourceFilePath)
        if (sourceLoadTokenRef.current !== token) return
        setSourceReady(result?.success === true)
      } catch (e) {
        if (sourceLoadTokenRef.current !== token) return
        console.warn('[SyllableSplitter] source preload failed:', e?.message)
        setSourceReady(false)
      }
    })()

    return () => {
      if (sourceLoadTokenRef.current === token) {
        sourceLoadTokenRef.current += 1
      }
    }
  }, [sourceFilePath, stopPreview])

  const playSection = useCallback(async (idx) => {
    if (playingIdx === idx) { stopPreview(); return }
    const sec = sections[idx]
    if (!sec) return
    const dur = Math.max(0, sec.end - sec.start)
    if (dur <= 0.01 || !sourceReady) return
    // Source startTime (absolute seconds) = region.startTime + syllable-relative start
    const absStart = (region.startTime ?? 0) + sec.start
    const absEnd = absStart + dur
    const token = ++previewTokenRef.current
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    setPlayingIdx(null)
    try {
      await window.xleth?.audio?.pauseSource()
      if (previewTokenRef.current !== token) return

      if (typeof window.xleth?.audio?.playRegionPreview === 'function') {
        const result = await window.xleth.audio.playRegionPreview(absStart, absEnd)
        if (previewTokenRef.current !== token) return
        if (result?.started === false) return
      } else {
        await window.xleth?.audio?.playSource(absStart)
      }
      if (previewTokenRef.current !== token) return
      setPlayingIdx(idx)
      previewTimerRef.current = setTimeout(() => {
        if (previewTokenRef.current !== token) return
        previewTimerRef.current = null
        if (typeof window.xleth?.audio?.playRegionPreview !== 'function') {
          window.xleth?.audio?.pauseSource().catch(() => {})
        }
        setPlayingIdx(cur => (cur === idx ? null : cur))
      }, Math.round(dur * 1000))
    } catch (e) {
      console.warn('[SyllableSplitter] play preview failed:', e?.message)
      if (previewTokenRef.current === token) setPlayingIdx(null)
    }
  }, [sections, region.startTime, playingIdx, sourceReady, stopPreview])

  // Stop any preview when component unmounts
  useEffect(() => () => stopPreview(), [stopPreview])

  const onPanelKeyDown = useCallback((e) => {
    if (e.code !== 'Space') return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    e.stopPropagation()
    e.preventDefault()
    playSection(selectedMarkerIndex)
  }, [selectedMarkerIndex, playSection])

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleClearAll = useCallback(() => {
    if (markers.length === 0 && texts.every(t => !t)) return
    setMarkers([])
    setTexts([''])
    setHasLeadingPlaceholder(false)
    setDirty(true)
  }, [markers.length, texts])

  const handleSave = useCallback(() => {
    const syllables = serializeSplitterSyllables(
      markers,
      texts,
      regionDur,
      hasLeadingPlaceholder,
    )
    onSave?.(syllables)
    setDirty(false)
  }, [markers, texts, regionDur, hasLeadingPlaceholder, onSave])

  // ── Render ──────────────────────────────────────────────────────────────────
  const canvasStyleH = compact ? Math.max(56, CANVAS_H - 20) : CANVAS_H

  return (
    <div
      className="syllable-splitter"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onPanelKeyDown}
    >
      <div className="syllable-splitter-waveform" ref={waveformWrapRef}>
        <canvas
          ref={canvasRef}
          className="syllable-splitter-canvas"
          style={{ width: '100%', height: canvasStyleH, display: 'block', cursor: drag ? 'grabbing' : 'crosshair' }}
          onMouseDown={onCanvasMouseDown}
          onContextMenu={(e) => e.preventDefault()}
        />
        {isZoomed && (
          <div
            ref={scrollTrackRef}
            className="syllable-splitter-scrollbar"
            onMouseDown={onTrackDown}
            title="Drag to scroll"
          >
            <div
              className="syllable-splitter-scrollbar-thumb"
              style={{ left: `${thumbLeft}%`, width: `${thumbWidth}%` }}
              onMouseDown={onThumbDown}
            />
          </div>
        )}
      </div>

      <div className="syllable-splitter-sections">
        {sections.map((s, i) => (
          <div
            key={i}
            className={`syllable-section-card${playingIdx === i ? ' playing' : ''}${selectedMarkerIndex === i ? ' selected' : ''}`}
            onClick={() => setSelectedMarkerIndex(i)}
          >
            <span className="syllable-section-num">{s.label}</span>
            <button
              className="syllable-section-play"
              onClick={() => playSection(i)}
              disabled={!sourceReady || Math.max(0, s.end - s.start) <= 0.01}
              title={!sourceReady ? 'Loading preview audio...' : (playingIdx === i ? 'Stop' : 'Play syllable')}
            >
              {playingIdx === i ? <Square size={10} /> : <Play size={10} />}
            </button>
            <input
              type="text"
              className="syllable-section-text"
              value={s.text}
              placeholder="(text)"
              onChange={(e) => {
                const v = e.target.value
                setTexts(prev => {
                  const next = [...prev]
                  next[i] = v
                  return next
                })
                setDirty(true)
              }}
            />
          </div>
        ))}
      </div>

      <div className="syllable-splitter-footer">
        <button className="syllable-splitter-btn syllable-splitter-btn--clear" onClick={handleClearAll} disabled={markers.length === 0 && texts.every(t => !t)}>
          <Trash2 size={12} /> Clear All
        </button>
        <span className="syllable-splitter-hint">
          Click to place marker · Drag to move · Right-click or drag to edge to delete · Scroll to zoom · Space to preview selected
        </span>
        <button className="syllable-splitter-btn syllable-splitter-btn--save primary" onClick={handleSave} disabled={!dirty}>
          Save
        </button>
      </div>
    </div>
  )
}

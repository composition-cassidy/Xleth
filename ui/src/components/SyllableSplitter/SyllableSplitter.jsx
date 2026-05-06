import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { Play, Square, Trash2 } from 'lucide-react'
import { downsamplePeaks3 } from '../../utils/waveformRenderer.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import {
  buildSplitterSections,
  createInitialSplitterState,
  serializeSplitterSyllables,
} from './syllableModel.js'

// ── Constants ────────────────────────────────────────────────────────────────
const CANVAS_H   = 90    // waveform canvas height
const HANDLE_HIT = 8     // hit-test radius around marker (px)
const DELETE_EDGE = 6    // drag this close to left/right edge → delete marker

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
  const canvasRef    = useRef(null)
  const containerRef = useRef(null)
  const previewTimerRef = useRef(null)

  const regionDur = Math.max(0.001, (region?.endTime ?? 0) - (region?.startTime ?? 0))

  // ── Internal state: markers = region-relative seconds, sorted ───────────────
  const initial = useMemo(() => {
    return createInitialSplitterState(region?.syllables ?? [], regionDur)
  }, [region?.id, region?.syllables, regionDur])

  const [markers, setMarkers] = useState(initial.markers)
  const [texts,   setTexts]   = useState(initial.texts)
  const [hasLeadingPlaceholder, setHasLeadingPlaceholder] = useState(initial.hasLeadingPlaceholder)
  const [dirty,   setDirty]   = useState(false)
  const [drag,    setDrag]    = useState(null)  // { idx, pendingDelete }
  const [playingIdx, setPlayingIdx] = useState(null)

  // Reset when region changes
  useEffect(() => {
    setMarkers(initial.markers)
    setTexts(initial.texts)
    setHasLeadingPlaceholder(initial.hasLeadingPlaceholder)
    setDirty(false)
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

  // ── Canvas drawing ──────────────────────────────────────────────────────────
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = tokenValue('--theme-syllable-splitter-bg')
    ctx.fillRect(0, 0, w, h)

    // Section tints (alternate) — visual aid for where each syllable lives
    const edges = [0, ...markers, regionDur]
    for (let i = 0; i < edges.length - 1; i++) {
      if (i % 2 === 0) continue
      const x0 = (edges[i]     / regionDur) * w
      const x1 = (edges[i + 1] / regionDur) * w
      ctx.fillStyle = tokenValue('--theme-syllable-section-alt')
      ctx.fillRect(x0, 0, x1 - x0, h)
    }

    // Centerline
    const mid = h / 2
    ctx.strokeStyle = tokenValue('--theme-syllable-splitter-wave-dim')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(w, mid)
    ctx.stroke()

    // Waveform bars (stride-3: [min,max,rms,...])
    if (regionPeaks && regionPeaks.length >= 3) {
      const peaks = downsamplePeaks3(regionPeaks, w)
      const cols = Math.floor(peaks.length / 3)
      ctx.fillStyle = tokenValue('--theme-text-placeholder')
      for (let i = 0; i < cols; i++) {
        const min = peaks[i * 3]
        const max = peaks[i * 3 + 1]
        const y0  = mid - max * (h * 0.45)
        const y1  = mid - min * (h * 0.45)
        ctx.fillRect(i, y0, 1, Math.max(1, y1 - y0))
      }
    } else {
      ctx.fillStyle = tokenValue('--theme-syllable-splitter-label-fg')
      ctx.font = '11px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText('No waveform', 8, mid)
    }

    // Section number labels (top-left of each section)
    ctx.fillStyle = tokenValue('--theme-syllable-accent-light')
    ctx.font = '600 11px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textBaseline = 'top'
    for (const section of sections) {
      const x0 = (section.start / regionDur) * w
      ctx.fillText(section.label, x0 + 4, 3)
    }

    // Marker lines
    ctx.strokeStyle = tokenValue('--theme-syllable-marker')
    ctx.lineWidth = 2
    for (let i = 0; i < markers.length; i++) {
      const x = (markers[i] / regionDur) * w
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      // Handle knobs at top and bottom
      ctx.fillStyle = tokenValue('--theme-syllable-marker')
      ctx.fillRect(x - 4, 0, 8, 4)
      ctx.fillRect(x - 4, h - 4, 8, 4)
    }
  }, [markers, regionDur, regionPeaks, sections])

  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  // ── Interaction helpers ─────────────────────────────────────────────────────
  function pxToTime(clientX) {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    return Math.max(0, Math.min(regionDur, (x / rect.width) * regionDur))
  }

  function hitTestMarker(clientX) {
    const canvas = canvasRef.current
    if (!canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    for (let i = 0; i < markers.length; i++) {
      const mx = (markers[i] / regionDur) * rect.width
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

  // ── Preview playback ────────────────────────────────────────────────────────
  const stopPreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    window.xleth?.audio?.pauseSource().catch(() => {})
    setPlayingIdx(null)
  }, [])

  const playSection = useCallback(async (idx) => {
    if (playingIdx === idx) { stopPreview(); return }
    stopPreview()
    const sec = sections[idx]
    if (!sec) return
    const dur = Math.max(0, sec.end - sec.start)
    if (dur <= 0.01) return
    // Source startTime (absolute seconds) = region.startTime + syllable-relative start
    const absStart = (region.startTime ?? 0) + sec.start
    try {
      // If caller provided a sourceFilePath, load it (no-op when same path already loaded).
      if (sourceFilePath) {
        await window.xleth?.audio?.loadSource(sourceFilePath)
      }
      await window.xleth?.audio?.playSource(absStart)
      setPlayingIdx(idx)
      previewTimerRef.current = setTimeout(() => {
        window.xleth?.audio?.pauseSource().catch(() => {})
        previewTimerRef.current = null
        setPlayingIdx(cur => (cur === idx ? null : cur))
      }, Math.round(dur * 1000))
    } catch (e) {
      console.warn('[SyllableSplitter] play preview failed:', e?.message)
      setPlayingIdx(null)
    }
  }, [sections, region.startTime, sourceFilePath, playingIdx, stopPreview])

  // Stop any preview when component unmounts
  useEffect(() => () => stopPreview(), [stopPreview])

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
    <div className="syllable-splitter" ref={containerRef}>
      <div className="syllable-splitter-waveform">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: canvasStyleH, display: 'block', cursor: drag ? 'grabbing' : 'crosshair' }}
          onMouseDown={onCanvasMouseDown}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>

      <div className="syllable-splitter-sections">
        {sections.map((s, i) => (
          <div key={i} className={`syllable-section-card${playingIdx === i ? ' playing' : ''}`}>
            <span className="syllable-section-num">{s.label}</span>
            <button
              className="syllable-section-play"
              onClick={() => playSection(i)}
              title={playingIdx === i ? 'Stop' : 'Play syllable'}
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
        <button className="syllable-splitter-btn" onClick={handleClearAll} disabled={markers.length === 0 && texts.every(t => !t)}>
          <Trash2 size={12} /> Clear All
        </button>
        <span className="syllable-splitter-hint">
          Click to place marker · Drag to move · Right-click or drag to edge to delete
        </span>
        <button className="syllable-splitter-btn primary" onClick={handleSave} disabled={!dirty}>
          Save
        </button>
      </div>
    </div>
  )
}

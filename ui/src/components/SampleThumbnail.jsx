import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Play, Music, ArrowLeftRight } from 'lucide-react'
import { labelColor, labelHexColor, buildAudioUrl, formatDuration, midiToNoteName } from '../constants/labels.js'
import { tokenValue } from '../theming/tokenValue.ts'

const HOVER_PREVIEW_DELAY_MS = 200
const STILL_FRAME_OFFSET_S = 0.04

let stopActivePreview = null
function registerActivePreview(stopFn) {
  if (stopActivePreview && stopActivePreview !== stopFn) {
    try { stopActivePreview() } catch { /* ignore */ }
  }
  stopActivePreview = stopFn
}
function clearActivePreview(stopFn) {
  if (stopActivePreview === stopFn) stopActivePreview = null
}

/**
 * Props mirror SampleRow except the visual layout is a tile.
 *   region, isActive, onSelect, onContextMenu
 *   sourceName, sourceFilePath, sourceHasVideo, rootNote
 *   onDoubleClick — () => void  (opens Sample Picker)
 */
export default function SampleThumbnail({
  region,
  isActive,
  onSelect,
  onContextMenu,
  sourceName,
  sourceFilePath,
  sourceHasVideo,
  rootNote,
  onDoubleClick,
}) {
  const tileRef       = useRef(null)
  const videoRef      = useRef(null)
  const audioRef      = useRef(null)
  const hoverTimerRef = useRef(null)
  const audioStopRef  = useRef(null)

  const [inView,    setInView]    = useState(false)
  const [mediaPort, setMediaPort] = useState(null)
  const [stillReady, setStillReady] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)

  const isVideo = sourceHasVideo !== false
  const dur = Math.abs(region.endTime - region.startTime)
  const accentHex = useMemo(() => labelHexColor(region.label), [region.label])

  useEffect(() => {
    if (!isVideo) return
    window.xleth?.getMediaPort?.().then(port => setMediaPort(port))
  }, [isVideo])

  const videoUrl = useMemo(() => {
    if (!isVideo || !sourceFilePath || !mediaPort) return null
    return `http://127.0.0.1:${mediaPort}/media?path=${encodeURIComponent(sourceFilePath)}`
  }, [isVideo, sourceFilePath, mediaPort])

  useEffect(() => {
    const el = tileRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setInView(true)
      },
      { rootMargin: '200px 0px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const seekToStill = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    try { v.currentTime = Math.max(0, region.startTime + STILL_FRAME_OFFSET_S) }
    catch { /* video not seekable yet */ }
  }, [region.startTime])

  // ── Stop any currently-playing preview on this tile ────────────────────────
  const stopThisPreview = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    const v = videoRef.current
    if (v) {
      try { v.pause() } catch { /* ignore */ }
      v.muted = true
      v.volume = 0.5
      seekToStill()
    }
    if (audioRef.current) {
      try { audioRef.current.pause() } catch { /* ignore */ }
      audioRef.current.src = ''
      audioRef.current = null
    }
    if (audioStopRef.current) {
      clearTimeout(audioStopRef.current)
      audioStopRef.current = null
    }
    setIsPreviewing(false)
    clearActivePreview(stopThisPreview)
  }, [seekToStill])

  useEffect(() => () => stopThisPreview(), [stopThisPreview])

  const startPreview = useCallback(() => {
    registerActivePreview(stopThisPreview)
    setIsPreviewing(true)

    if (isVideo) {
      const v = videoRef.current
      if (!v) return
      v.muted = false
      v.volume = 0.5
      try { v.currentTime = region.startTime } catch { /* ignore */ }
      v.play().catch(err => {
        console.warn('[SampleThumbnail] Video preview failed:', err?.message || err)
        stopThisPreview()
      })
    } else {
      if (!sourceFilePath) { stopThisPreview(); return }
      const a = new Audio(buildAudioUrl(sourceFilePath))
      a.volume = 0.5
      audioRef.current = a
      a.addEventListener('loadedmetadata', () => {
        try { a.currentTime = region.startTime } catch { /* ignore */ }
        a.play().catch(err => {
          console.warn('[SampleThumbnail] Audio preview failed:', err?.message || err)
          stopThisPreview()
        })
      })
      const durationMs = Math.max(0, (region.endTime - region.startTime) * 1000)
      audioStopRef.current = setTimeout(() => stopThisPreview(), durationMs)
      a.addEventListener('ended', () => stopThisPreview())
    }
    console.log(`[SampleThumbnail] Preview: "${region.name}" ${region.startTime.toFixed(2)}–${region.endTime.toFixed(2)}s`)
  }, [isVideo, region, sourceFilePath, stopThisPreview])

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v || !isPreviewing) return
    if (v.currentTime >= region.endTime) {
      try { v.pause() } catch { /* ignore */ }
      v.muted = true
      setIsPreviewing(false)
      clearActivePreview(stopThisPreview)
      // leave the still on the end frame so user sees the cut clearly
    }
  }, [isPreviewing, region.endTime, stopThisPreview])

  const handleMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      startPreview()
    }, HOVER_PREVIEW_DELAY_MS)
  }, [startPreview])

  const handleMouseLeave = useCallback(() => {
    stopThisPreview()
  }, [stopThisPreview])

  // ── Drag handlers (mirror SampleRow) ───────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    const payload = {
      regionId:  region.id,
      sourceId:  region.sourceId,
      label:     region.label,
      name:      region.name,
      startTime: region.startTime,
      endTime:   region.endTime,
    }
    e.dataTransfer.setData('application/xleth-sample', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    window.__xlethDragSample = payload

    const el = document.createElement('div')
    el.textContent = region.name
    el.style.cssText = `
      position: absolute; top: -1000px; left: -1000px;
      padding: 4px 10px; border-radius: 4px; font-size: 12px;
      font-family: var(--xleth-global-font-family); font-weight: 600;
      background: ${accentHex}; color: #000; white-space: nowrap;
    `
    document.body.appendChild(el)
    e.dataTransfer.setDragImage(el, 0, 0)
    setTimeout(() => document.body.removeChild(el), 0)
    // also stop any preview that's playing
    stopThisPreview()
  }, [region, accentHex, stopThisPreview])

  const handleDragEnd = useCallback(() => {
    window.__xlethDragSample = null
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={tileRef}
      className={`sample-thumbnail ${isActive ? 'active' : ''}`}
      style={isActive ? { boxShadow: `inset 0 0 0 2px ${accentHex}` } : undefined}
      onClick={() => onSelect(region.id)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, region) }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      title={region.name}
    >
      <div className="sample-thumbnail-media">
        {/* Static placeholder until either the video frame is seeked or the waveform is drawn */}
        {!stillReady && (
          <div
            className="sample-thumbnail-placeholder"
            style={{ background: tokenValue('--theme-bg-inset') }}
          >
            {!isVideo && <Music size={20} strokeWidth={1.5} color={accentHex} />}
          </div>
        )}

        {isVideo && inView && videoUrl && (
          <video
            ref={videoRef}
            className="sample-thumbnail-video"
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            draggable={false}
            onLoadedMetadata={seekToStill}
            onSeeked={() => setStillReady(true)}
            onTimeUpdate={handleTimeUpdate}
            onError={() => console.warn('[SampleThumbnail] Video error:',
              videoRef.current?.error?.code, videoRef.current?.error?.message)}
          />
        )}

        {!isVideo && inView && (
          <WaveformThumb
            filePath={sourceFilePath}
            startTime={region.startTime}
            endTime={region.endTime}
            colorHex={accentHex}
            onReady={() => setStillReady(true)}
          />
        )}

        {/* Hover-affordance play icon (hidden during active preview) */}
        {!isPreviewing && stillReady && (
          <span className="sample-thumbnail-overlay-play">
            <Play size={14} fill="currentColor" />
          </span>
        )}

        {/* Top-right swap badge */}
        {region.hasSwappedAudio && (
          <span
            className="sample-thumbnail-swap-icon"
            title={`Audio swapped: ${region.swappedAudioPath?.split(/[\\/]/).pop() ?? ''} — preview plays original, swap is audible only on timeline`}
          >
            <ArrowLeftRight size={10} />
          </span>
        )}

        {/* Bottom-right duration pill */}
        <span className="sample-thumbnail-duration">{formatDuration(dur)}</span>

        {/* Bottom-left label dot */}
        <span
          className="sample-thumbnail-label-dot"
          style={{ background: labelColor(region.label) }}
        />
      </div>

      <div className="sample-thumbnail-caption">
        <span className="sample-thumbnail-name">{region.name}</span>
        {region.label === 'Pitch' && (
          <span className="sample-thumbnail-note">
            {rootNote != null && rootNote >= 0 ? midiToNoteName(rootNote) : '--'}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Internal: small canvas that fetches & draws a region's waveform ──────────
function WaveformThumb({ filePath, startTime, endTime, colorHex, onReady }) {
  const canvasRef = useRef(null)
  const reqIdRef  = useRef(0)

  useEffect(() => {
    if (!filePath) return
    const canvas = canvasRef.current
    if (!canvas) return
    const reqId = ++reqIdRef.current

    const W = canvas.width  = 240   // backing store; CSS scales it
    const H = canvas.height = 135
    const targetCols = 120

    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.xleth?.waveform?.getFilePeaks(filePath, startTime, endTime, targetCols, -1)
        if (cancelled || reqId !== reqIdRef.current) return
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, W, H)
        if (!raw || !raw.peaks || raw.peaks.length === 0) {
          if (typeof onReady === 'function') onReady()
          return
        }
        const peaks  = raw.peaks
        const stride = 3
        const cols   = Math.floor(peaks.length / stride)
        const colW   = W / cols
        const mid    = H / 2
        ctx.fillStyle = colorHex
        for (let i = 0; i < cols; i++) {
          const minV = peaks[i * stride + 0]
          const maxV = peaks[i * stride + 1]
          const yTop = mid - Math.max(0, maxV) * (mid - 2)
          const yBot = mid - Math.min(0, minV) * (mid - 2)
          const x = Math.floor(i * colW)
          const w = Math.max(1, Math.floor(colW))
          ctx.fillRect(x, yTop, w, Math.max(1, yBot - yTop))
        }
        if (typeof onReady === 'function') onReady()
      } catch (e) {
        if (typeof onReady === 'function') onReady()
        console.warn('[SampleThumbnail] Waveform fetch failed:', e?.message || e)
      }
    })()

    return () => { cancelled = true }
  }, [filePath, startTime, endTime, colorHex, onReady])

  return <canvas ref={canvasRef} className="sample-thumbnail-waveform" />
}

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

// ── Module-scope LRU cache of captured still frames ─────────────────────────
// Keyed by `${region.id}:${region.startTime}` so trimming a region's start
// (which changes what the still should show) naturally invalidates the entry
// instead of painting a stale frame. Capped so browsing large projects can't
// grow this unbounded — oldest entry is evicted once the cap is exceeded.
const STILL_FRAME_CACHE_LIMIT = 200
const stillFrameCache = new Map() // key -> dataURL, Map iteration order = LRU order (oldest first)

function getCachedStillFrame(key) {
  if (!key || !stillFrameCache.has(key)) return null
  const value = stillFrameCache.get(key)
  stillFrameCache.delete(key)
  stillFrameCache.set(key, value) // touch: move to most-recently-used position
  return value
}

function setCachedStillFrame(key, dataUrl) {
  if (!key) return
  stillFrameCache.delete(key)
  stillFrameCache.set(key, dataUrl)
  if (stillFrameCache.size > STILL_FRAME_CACHE_LIMIT) {
    const oldestKey = stillFrameCache.keys().next().value
    stillFrameCache.delete(oldestKey)
  }
}

// ── Module-scope shared mediaPort lookup ─────────────────────────────────────
// The port is a single constant for the app's lifetime, so every thumbnail
// instance shares one IPC round trip instead of firing its own.
let mediaPortPromise = null
function getMediaPort() {
  if (mediaPortPromise === null) {
    mediaPortPromise = Promise.resolve(window.xleth?.getMediaPort?.())
  }
  return mediaPortPromise
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

  // ── Still-frame cache lookup ────────────────────────────────────────────
  const stillCacheKey = isVideo ? `${region.id}:${region.startTime}` : null
  const [cachedStillUrl, setCachedStillUrl] = useState(
    () => getCachedStillFrame(stillCacheKey)
  )
  // On a cache hit, defer mounting the real <video> (and its metadata load +
  // seek) until the user actually hovers. On a cache miss, load eagerly as
  // before so the still can be captured.
  const [videoActivated, setVideoActivated] = useState(() => cachedStillUrl == null)
  useEffect(() => {
    const cached = getCachedStillFrame(stillCacheKey)
    setCachedStillUrl(cached)
    if (cached) setStillReady(true)
  }, [stillCacheKey])

  useEffect(() => {
    if (!isVideo) return
    let cancelled = false
    getMediaPort().then(port => { if (!cancelled) setMediaPort(port) })
    return () => { cancelled = true }
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

  // ── Handle the initial still-frame seek: paint, then cache the frame ───────
  // so the next mount of this same region+startTime can skip the seek entirely.
  const handleStillSeeked = useCallback(() => {
    setStillReady(true)
    if (!stillCacheKey || stillFrameCache.has(stillCacheKey)) return
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72)
      setCachedStillFrame(stillCacheKey, dataUrl)
      setCachedStillUrl(dataUrl)
    } catch (e) {
      // Cross-origin canvas taint or other capture failure — non-fatal, just skip caching.
      console.warn('[SampleThumbnail] Still-frame capture failed:', e?.message || e)
    }
  }, [stillCacheKey])

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
    // Activate the real <video> immediately (ahead of the preview delay) so
    // a cache-hit tile has time to load metadata before startPreview() needs it.
    if (isVideo) setVideoActivated(true)
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      startPreview()
    }, HOVER_PREVIEW_DELAY_MS)
  }, [isVideo, startPreview])

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

        {isVideo && inView && videoUrl && videoActivated && (
          <video
            ref={videoRef}
            className="sample-thumbnail-video"
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            draggable={false}
            onLoadedMetadata={seekToStill}
            onSeeked={handleStillSeeked}
            onTimeUpdate={handleTimeUpdate}
            onError={() => console.warn('[SampleThumbnail] Video error:',
              videoRef.current?.error?.code, videoRef.current?.error?.message)}
          />
        )}

        {/* Cached still frame — painted on top of the <video> so a cache hit
            shows instantly without waiting for a fresh decode/seek. Hidden
            during hover preview so the live video is visible instead. */}
        {isVideo && cachedStillUrl && !isPreviewing && (
          <img
            className="sample-thumbnail-video sample-thumbnail-still-cache"
            src={cachedStillUrl}
            draggable={false}
            alt=""
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

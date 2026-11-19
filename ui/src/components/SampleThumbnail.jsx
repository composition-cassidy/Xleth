import { memo, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { labelColor, labelHexColor, buildAudioUrl, buildMediaServerUrl, formatDuration, midiToNoteName } from '../constants/labels.js'
import { peekStill, requestStill, stillKeyFor } from './sampleStills.js'
import { iconComponent } from '../ui-kit/icons'

const IcArrowsLeftRightFill = iconComponent('arrows-left-right', 'fill')
const IcPlayFill = iconComponent('play', 'fill')
const IcWaveform = iconComponent('waveform')

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

// ── Module-scope shared mediaPort lookup ─────────────────────────────────────
// The port is a single constant for the app's lifetime, so every thumbnail
// instance shares one IPC round trip instead of firing its own — and once it
// has resolved, later tiles read it synchronously and skip a render.
let mediaPortPromise = null
let mediaPortValue = null
function getMediaPort() {
  if (mediaPortPromise === null) {
    mediaPortPromise = Promise.resolve(window.xleth?.getMediaPort?.())
      .then(port => { mediaPortValue = port ?? null; return mediaPortValue })
  }
  return mediaPortPromise
}

// ── Module-scope waveform peak cache (audio-only tiles) ──────────────────────
const PEAKS_CACHE_LIMIT = 300
const peaksCache = new Map() // key -> peaks array (or null when the file has none)

function rememberPeaks(key, peaks) {
  peaksCache.delete(key)
  peaksCache.set(key, peaks)
  if (peaksCache.size > PEAKS_CACHE_LIMIT) peaksCache.delete(peaksCache.keys().next().value)
}

// Free the decoder now rather than whenever the detached element is collected.
function releaseVideo(v) {
  if (!v) return
  try {
    v.pause()
    v.removeAttribute('src')
    v.load()
  } catch { /* ignore */ }
}

/**
 * One tile of the Samples grid.
 *
 * The picture is a small still fetched once through sampleStills.js (memory →
 * disk → engine). A real <video> exists only while the pointer is over the
 * tile, for the hover preview — never to produce the still.
 *
 * Props:
 *   region, isActive, onSelect, onContextMenu
 *   sourceFilePath, sourceHasVideo, sourceDuration, rootNote
 *   onOpen — (region) => void  (opens Sample Picker)
 */
function SampleThumbnail({
  region,
  isActive,
  onSelect,
  onContextMenu,
  sourceFilePath,
  sourceHasVideo,
  sourceDuration,
  rootNote,
  onOpen,
}) {
  const tileRef       = useRef(null)
  const videoRef      = useRef(null)
  const audioRef      = useRef(null)
  const hoverTimerRef = useRef(null)
  const audioStopRef  = useRef(null)

  const [inView,    setInView]    = useState(false)
  const [mediaPort, setMediaPort] = useState(() => mediaPortValue)
  const [hovering,  setHovering]  = useState(false)  // mounts the preview <video>
  const [videoLive, setVideoLive] = useState(false)  // the <video> is presenting frames
  const [waveReady, setWaveReady] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)

  const isVideo = sourceHasVideo !== false
  const dur = Math.abs(region.endTime - region.startTime)
  const accentHex = useMemo(() => labelHexColor(region.label), [region.label])

  // ── Still frame ─────────────────────────────────────────────────────────
  // Keyed by media + time, so trimming a region's start (which changes what the
  // still should show) asks for a different frame instead of reusing a stale one.
  const stillTime = Math.max(0, region.startTime + STILL_FRAME_OFFSET_S)
  const stillKey = isVideo
    ? stillKeyFor({ filePath: sourceFilePath, duration: sourceDuration, timeSeconds: stillTime })
    : null
  const [still, setStill] = useState(() => ({ key: stillKey, url: peekStill(stillKey) }))
  // A still fetched for a previous key is never shown under the new one.
  const stillUrl = still.key === stillKey ? still.url : peekStill(stillKey)

  useEffect(() => {
    if (!stillKey) return undefined
    const cached = peekStill(stillKey)
    if (cached) {
      setStill(prev => (prev.key === stillKey && prev.url === cached ? prev : { key: stillKey, url: cached }))
      return undefined
    }
    if (!inView) return undefined
    let cancelled = false
    const req = requestStill({
      sourceId: region.sourceId,
      filePath: sourceFilePath,
      duration: sourceDuration,
      timeSeconds: stillTime,
    })
    req.promise.then(url => {
      if (!cancelled && url) setStill({ key: stillKey, url })
    })
    return () => { cancelled = true; req.cancel() }
  }, [stillKey, inView, region.sourceId, sourceFilePath, sourceDuration, stillTime])

  useEffect(() => {
    if (!isVideo || mediaPort != null) return undefined
    let cancelled = false
    getMediaPort().then(port => { if (!cancelled) setMediaPort(port) })
    return () => { cancelled = true }
  }, [isVideo, mediaPort])

  const videoUrl = useMemo(() => {
    if (!isVideo || !sourceFilePath || !mediaPort) return null
    return buildMediaServerUrl(mediaPort, sourceFilePath)
  }, [isVideo, sourceFilePath, mediaPort])

  useEffect(() => {
    const el = tileRef.current
    if (!el) return undefined
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) { setInView(true); obs.disconnect(); break }
        }
      },
      { rootMargin: '200px 0px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

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
    setVideoLive(false)
    clearActivePreview(stopThisPreview)
  }, [])

  useEffect(() => () => stopThisPreview(), [stopThisPreview])

  // Layout cleanup runs while the ref is still attached (a passive cleanup
  // would find it already null), so the decoder is released on unmount.
  useLayoutEffect(() => () => releaseVideo(videoRef.current), [])

  const startPreview = useCallback(() => {
    registerActivePreview(stopThisPreview)
    setIsPreviewing(true)

    if (isVideo) {
      const v = videoRef.current
      if (!v) { stopThisPreview(); return }
      v.muted = false
      v.volume = 0.5
      // Before metadata arrives this sets the default playback start position.
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
  }, [isVideo, region.startTime, region.endTime, sourceFilePath, stopThisPreview])

  // Belt and braces for the start position: if the element ignored the pre-load
  // currentTime, seek once the duration is known.
  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (Math.abs(v.currentTime - region.startTime) > 0.05) {
      try { v.currentTime = region.startTime } catch { /* video not seekable yet */ }
    }
  }, [region.startTime])

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v || !isPreviewing) return
    if (v.currentTime >= region.endTime) {
      try { v.pause() } catch { /* ignore */ }
      v.muted = true
      setIsPreviewing(false)
      clearActivePreview(stopThisPreview)
      // videoLive stays set: the end frame holds until the pointer leaves, so
      // the user sees the cut clearly.
    }
  }, [isPreviewing, region.endTime, stopThisPreview])

  const handleMouseEnter = useCallback(() => {
    // Mount the <video> immediately (ahead of the preview delay) so it has
    // time to load metadata before startPreview() needs it.
    if (isVideo) setHovering(true)
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      startPreview()
    }, HOVER_PREVIEW_DELAY_MS)
  }, [isVideo, startPreview])

  const handleMouseLeave = useCallback(() => {
    stopThisPreview()
    releaseVideo(videoRef.current)
    setHovering(false)
  }, [stopThisPreview])

  // ── Drag handlers (mirror SampleRow) ───────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    const payload = {
      regionId:         region.id,
      sourceId:         region.sourceId,
      label:            region.label,
      name:             region.name,
      startTime:        region.startTime,
      endTime:          region.endTime,
      audioFilePath:    region.audioFilePath,
      hasSwappedAudio:  region.hasSwappedAudio,
      swappedAudioPath: region.swappedAudioPath,
      swappedAudioDurationSec: region.swappedAudioDurationSec,
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

  const handleWaveReady = useCallback(() => setWaveReady(true), [])

  const pictureReady = isVideo ? (!!stillUrl || videoLive) : waveReady

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={tileRef}
      className={`sample-thumbnail ${isActive ? 'active' : ''}`}
      style={isActive ? { boxShadow: `inset 0 0 0 2px ${accentHex}` } : undefined}
      onClick={() => onSelect(region.id)}
      onDoubleClick={() => onOpen?.(region)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, region) }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      title={region.name}
    >
      <div className="sample-thumbnail-media">
        {/* Static placeholder until the still arrives or the waveform is drawn.
            The inset background comes from .sample-thumbnail-media itself. */}
        {!pictureReady && (
          <div className="sample-thumbnail-placeholder">
            {!isVideo && <IcWaveform size={20} style={{ color: accentHex }} />}
          </div>
        )}

        {/* Hover preview only — mounted on pointer enter, released on leave. */}
        {isVideo && hovering && videoUrl && (
          <video
            ref={videoRef}
            className="sample-thumbnail-video"
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            draggable={false}
            onLoadedMetadata={handleLoadedMetadata}
            onPlaying={() => setVideoLive(true)}
            onTimeUpdate={handleTimeUpdate}
            onError={() => console.warn('[SampleThumbnail] Video error:',
              videoRef.current?.error?.code, videoRef.current?.error?.message)}
          />
        )}

        {/* The still — painted over the <video> until the preview is actually
            presenting frames, so starting a preview never flashes empty. */}
        {isVideo && stillUrl && !videoLive && (
          <img
            className="sample-thumbnail-video sample-thumbnail-still-cache"
            src={stillUrl}
            decoding="async"
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
            onReady={handleWaveReady}
          />
        )}

        {/* Hover-affordance play icon (hidden during active preview) */}
        {!isPreviewing && pictureReady && (
          <span className="sample-thumbnail-overlay-play">
            <IcPlayFill size={14} />
          </span>
        )}

        {/* Top-right swap badge */}
        {region.hasSwappedAudio && (
          <span
            className="sample-thumbnail-swap-icon"
            title={`Audio swapped: ${region.swappedAudioPath?.split(/[\\/]/).pop() ?? ''} — preview plays original, swap is audible only on timeline`}
          >
            <IcArrowsLeftRightFill size={14} />
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

export default memo(SampleThumbnail)

// ── Internal: small canvas that fetches & draws a region's waveform ──────────
// Peaks are cached per file+range, and `onReady` must be a stable callback:
// with an inline one this effect re-ran — a fresh RPC and a full redraw — on
// every parent render.
const WAVE_W = 240   // backing store; CSS scales it
const WAVE_H = 135
const WAVE_COLS = 120

function drawPeaks(canvas, peaks, colorHex) {
  canvas.width = WAVE_W
  canvas.height = WAVE_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, WAVE_W, WAVE_H)
  if (!peaks || peaks.length === 0) return
  const stride = 3
  const cols   = Math.floor(peaks.length / stride)
  const colW   = WAVE_W / cols
  const mid    = WAVE_H / 2
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
}

function WaveformThumb({ filePath, startTime, endTime, colorHex, onReady }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!filePath) return undefined
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const key = `${filePath}|${startTime}|${endTime}`
    if (peaksCache.has(key)) {
      drawPeaks(canvas, peaksCache.get(key), colorHex)
      onReady?.()
      return undefined
    }

    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.xleth?.waveform?.getFilePeaks(filePath, startTime, endTime, WAVE_COLS, -1)
        if (cancelled) return
        const peaks = raw?.peaks && raw.peaks.length > 0 ? raw.peaks : null
        // `ready: false` means the mipmap is still building — don't pin an
        // empty waveform for the rest of the session.
        if (peaks || raw?.ready !== false) rememberPeaks(key, peaks)
        drawPeaks(canvas, peaks, colorHex)
        onReady?.()
      } catch (e) {
        if (cancelled) return
        onReady?.()
        console.warn('[SampleThumbnail] Waveform fetch failed:', e?.message || e)
      }
    })()

    return () => { cancelled = true }
  }, [filePath, startTime, endTime, colorHex, onReady])

  return <canvas ref={canvasRef} className="sample-thumbnail-waveform" />
}

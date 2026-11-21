import { buildAudioUrl, buildMediaServerUrl } from '../constants/labels.js'

// The Browser's one audio preview: a singleton <audio> element, so only one
// sample sounds at a time. It is the SAME path the sample row's play button has
// always used (media-server URL, seek on loadedmetadata, cut at the region end);
// it lives here so "preview on select" and the play button share it instead of
// each owning a copy. Nothing here talks to the engine.

let previewAudio = null
let previewStopTimer = null
let activeId = null
const listeners = new Set()

function emit() {
  for (const listener of listeners) listener(activeId)
}

/** Subscribe to "which region is previewing" changes. Returns the unsubscribe. */
export function subscribePreview(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getActivePreviewId() {
  return activeId
}

export function stopPreview() {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio.src = ''
    previewAudio = null
  }
  if (previewStopTimer) {
    clearTimeout(previewStopTimer)
    previewStopTimer = null
  }
  const had = activeId !== null
  activeId = null
  if (had) emit()
}

/**
 * Start previewing a region, replacing whatever was playing.
 * Returns false when there is nothing to play (no source file).
 */
export function startPreview({ region, sourceFilePath, mediaPort }) {
  stopPreview()
  if (!sourceFilePath) return false

  const audioUrl = mediaPort
    ? buildMediaServerUrl(mediaPort, sourceFilePath)
    : buildAudioUrl(sourceFilePath)
  const audio = new Audio(audioUrl)
  previewAudio = audio
  activeId = region.id

  const finishPreview = () => {
    // A newer preview may have replaced this audio element while it was loading.
    if (previewAudio !== audio) return
    stopPreview()
  }

  audio.addEventListener('loadedmetadata', () => {
    if (previewAudio !== audio) return

    try { audio.currentTime = region.startTime } catch (err) {
      console.error('[Browser] Preview seek error:', err)
      finishPreview()
      return
    }

    audio.play().then(() => {
      if (previewAudio !== audio) return
      // Start the cut timer only once media playback has genuinely begun.
      const durationMs = Math.max(0, (region.endTime - region.startTime) * 1000)
      previewStopTimer = setTimeout(finishPreview, durationMs)
    }).catch(err => {
      console.error('[Browser] Preview error:', err?.name, err?.message || err)
      finishPreview()
    })
  }, { once: true })

  audio.addEventListener('ended', finishPreview, { once: true })

  emit()
  return true
}

/** Play/stop toggle for one region (the row's play button). */
export function togglePreview(args) {
  if (activeId === args.region.id) {
    stopPreview()
    return false
  }
  return startPreview(args)
}

// ── Media-server port ────────────────────────────────────────────────────────
// One lookup shared by every row (each used to ask on mount). Only a real port is
// cached, so a server that was not up yet is asked again on the next preview.
let cachedPort = null

export async function getMediaPort() {
  if (cachedPort) return cachedPort
  try {
    const port = await window.xleth?.getMediaPort?.()
    if (port) cachedPort = port
    return port || null
  } catch (err) {
    console.warn('[Browser] Media server unavailable:', err?.message || err)
    return null
  }
}

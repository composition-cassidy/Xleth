import { useRef, useState, useEffect, useMemo } from 'react'
import { formatTimecode, frameAt } from './pickerFormat.js'
import styles from './SamplePicker.module.css'

/**
 * PickerVideoPreview — muted <video> element synced to SourcePlayer audio, with
 * the playhead's timecode and frame number under it.
 *
 * Uses a local HTTP media server (127.0.0.1) for video delivery so that
 * Chromium's hardware video decoder works with proper Range request support.
 * Audio comes from SourcePlayer (ASIO), not from the <video> element.
 *
 * Props:
 *   filePath    – absolute path to the video file
 *   currentTime – seconds (from SourcePlayer position polling)
 *   isPlaying   – whether SourcePlayer is currently playing
 *   sourceWidth  – source video width
 *   sourceHeight – source video height
 *   fps          – source frame rate (for the frame readout)
 */
export default function PickerVideoPreview({
  filePath,
  currentTime,
  isPlaying,
  sourceWidth,
  sourceHeight,
  fps,
}) {
  const videoRef = useRef(null)
  const [mediaPort, setMediaPort] = useState(null)

  // Fetch the media server port once on mount
  useEffect(() => {
    window.xleth?.getMediaPort?.()?.then?.(port => setMediaPort(port))
  }, [])

  // Build HTTP URL for the local media server
  const videoUrl = useMemo(() => {
    if (!filePath || !mediaPort) return null
    return `http://127.0.0.1:${mediaPort}/media?path=${encodeURIComponent(filePath)}`
  }, [filePath, mediaPort])

  // Track currentTime in a ref so the sync interval isn't rebuilt on every update
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime

  // Sync video position to SourcePlayer position during playback
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isPlaying) return

    const syncInterval = setInterval(() => {
      // Only seek if drift exceeds 150ms (avoid constant micro-seeks)
      const drift = Math.abs(video.currentTime - currentTimeRef.current)
      if (drift > 0.15) {
        video.currentTime = currentTimeRef.current
      }
    }, 200)  // Check sync 5x/sec

    return () => clearInterval(syncInterval)
  }, [isPlaying])

  // When user manually seeks (not playing), snap video to position
  useEffect(() => {
    const video = videoRef.current
    if (!video || isPlaying) return
    video.currentTime = currentTime
  }, [currentTime, isPlaying])

  // Play/pause the video element in sync with SourcePlayer
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (isPlaying) {
      // A loop pass or a new selection starts somewhere else: land there first.
      if (Math.abs(video.currentTime - currentTimeRef.current) > 0.15) video.currentTime = currentTimeRef.current
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [isPlaying])

  const aspectRatio = sourceWidth > 0 && sourceHeight > 0
    ? `${sourceWidth} / ${sourceHeight}`
    : '16 / 9'
  const frame = frameAt(currentTime, fps)

  return (
    <div className={styles.videoStack}>
      <div
        className={styles.videoPreview}
        style={{ '--picker-video-aspect': aspectRatio }}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            className={styles.videoFrame}
            draggable={false}
            onError={() => console.error('[Browser] Video error:',
              videoRef.current?.error?.code, videoRef.current?.error?.message)}
          />
        ) : (
          <div className={styles.videoPlaceholder}>Loading video…</div>
        )}
      </div>
      <div className={styles.videoReadout} data-hint="Playhead position in the source picture">
        <span className={styles.timecode} data-testid="picker-timecode">{formatTimecode(currentTime)}</span>
        {frame !== null ? (
          <span className={styles.frame}>
            <span className={styles.readoutLabel}>Frame</span>
            <span className={styles.timecode}>{frame}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

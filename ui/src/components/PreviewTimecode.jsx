import { useEffect, useRef, useState } from 'react'
import { playheadClock } from '../services/PlayheadClock.js'
import { timelineEvents } from '../timelineEvents.js'
import styles from './PreviewTimecode.module.css'

/** HH:MM:SS:FF at `fps`, plus the absolute frame number. Pure, for tests. */
export function formatPreviewTime(positionMs, fps) {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30
  const ms = Math.max(0, Number(positionMs) || 0)
  const frame = Math.floor((ms / 1000) * rate)
  const totalSeconds = Math.floor(frame / rate)
  const ff = frame % rate
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  return { timecode: `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`, frame }
}

/**
 * The Preview's timecode and frame number, at the project's preview frame
 * rate. Driven by the shared playhead clock; text is written straight to the
 * DOM per frame (no React state at 60 fps). Tabular numerals.
 */
export default function PreviewTimecode() {
  const [fps, setFps] = useState(30)
  const tcRef = useRef(null)
  const frameRef = useRef(null)
  const fpsRef = useRef(30)

  useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const layout = await window.xleth?.timeline?.getGridLayout?.()
        const next = Number(layout?.previewFps)
        if (!cancelled && Number.isFinite(next) && next > 0) setFps(next)
      } catch (e) {
        console.warn('[Arrange] preview fps read failed', e)
      }
    }
    read()
    timelineEvents.addEventListener('timeline-grid-changed', read)
    return () => {
      cancelled = true
      timelineEvents.removeEventListener('timeline-grid-changed', read)
    }
  }, [])

  useEffect(() => {
    fpsRef.current = fps
    const paint = (positionMs) => {
      const { timecode, frame } = formatPreviewTime(positionMs, fpsRef.current)
      if (tcRef.current && tcRef.current.textContent !== timecode) tcRef.current.textContent = timecode
      const f = String(frame)
      if (frameRef.current && frameRef.current.textContent !== f) frameRef.current.textContent = f
    }
    paint(playheadClock.positionMs)
    return playheadClock.onFrame(paint)
  }, [fps])

  const initial = formatPreviewTime(playheadClock.positionMs, fps)
  return (
    <span className={styles.readout} aria-label="Preview position" data-testid="preview-timecode">
      <span ref={tcRef} className={styles.timecode}>{initial.timecode}</span>
      <span className={styles.frameLabel}>Frame</span>
      <span ref={frameRef} className={styles.frame}>{initial.frame}</span>
    </span>
  )
}

import { useEffect, useRef } from 'react'
import ProgressBar from '../ProgressBar.jsx'

// Phase labels for the four OfflineRenderer states.
const PHASE_LABELS = {
  0: 'Initialising…',
  1: 'Pre-rolling…',
  2: 'Rendering…',
  3: 'Finalising…',
}

// Rolling-window ETA smoothing — 20 samples at 10 Hz ≈ 2 s.
const ETA_WINDOW = 20
const ETA_WARMUP = 5

function formatEta(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `~${Math.round(seconds)} sec`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds - m * 60)
  return s === 0 ? `~${m} min` : `~${m} min ${s} sec`
}

export default function ProgressPanel({
  phase,           // 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  renderPhase,     // 0 / 1 / 2 / 3
  progress,        // 0..1
  currentFrame,
  totalFrames,
  speed,
  eta,             // raw eta from backend; smoothed here
  errorMsg,
  outputPath,
  fps,
  onCancel,
  onOpenFile,
  onOpenFolder,
  onClose,
}) {
  // Ring buffer of recent speed samples for ETA smoothing.
  const speedSamples = useRef([])
  useEffect(() => {
    if (phase !== 'running') {
      speedSamples.current = []
      return
    }
    if (typeof speed === 'number' && speed > 0) {
      const buf = speedSamples.current
      buf.push(speed)
      if (buf.length > ETA_WINDOW) buf.shift()
    }
  }, [speed, phase])

  // Compute smoothed ETA. During warm-up, fall back to backend's raw value.
  let displayEta = eta
  const buf = speedSamples.current
  if (buf.length >= ETA_WARMUP && totalFrames > 0 && fps > 0) {
    const avgSpeed = buf.reduce((a, b) => a + b, 0) / buf.length
    const framesRemaining = Math.max(0, totalFrames - currentFrame)
    if (avgSpeed > 0) {
      displayEta = framesRemaining / (avgSpeed * fps)
    }
  }

  const running  = phase === 'running'
  const finished = phase === 'done' || phase === 'error' || phase === 'cancelled'

  let headline = 'Preparing export…'
  if (phase === 'running')   headline = PHASE_LABELS[renderPhase] || 'Rendering…'
  if (phase === 'done')      headline = 'Export complete.'
  if (phase === 'cancelled') headline = 'Export cancelled. Partial file saved.'
  if (phase === 'error')     headline = errorMsg || 'Export failed.'

  return (
    <div className="export-progress-panel">
      <ProgressBar progress={progress} />
      <div className={`export-progress-headline${phase === 'error' ? ' error' : ''}`}>
        {headline}
        {running && <span className="export-progress-pct">{Math.floor(progress * 100)}%</span>}
      </div>

      {running && (
        <div className="export-progress-stats">
          <div>Frame {currentFrame.toLocaleString()} of {totalFrames.toLocaleString()}</div>
          <div>{speed > 0 ? `${speed.toFixed(1)}× realtime` : ''}</div>
          <div>ETA: {formatEta(displayEta)}</div>
        </div>
      )}

      {finished && outputPath && (
        <div className="export-progress-path">{outputPath}</div>
      )}

      <div className="export-progress-actions">
        {running && (
          <button className="export-btn-danger" onClick={onCancel}>Cancel</button>
        )}
        {phase === 'done' && (
          <>
            <button onClick={onOpenFile}>Open File</button>
            <button onClick={onOpenFolder}>Open Folder</button>
            <button className="export-btn-primary" onClick={onClose}>Close</button>
          </>
        )}
        {phase === 'cancelled' && (
          <>
            <button onClick={onOpenFile}>Open File</button>
            <button onClick={onOpenFolder}>Open Folder</button>
            <button className="export-btn-primary" onClick={onClose}>Close</button>
          </>
        )}
        {phase === 'error' && (
          <button className="export-btn-primary" onClick={onClose}>Close</button>
        )}
      </div>
    </div>
  )
}
